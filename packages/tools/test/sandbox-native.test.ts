/**
 * The two native sandbox translators: `sandbox-exec` profiles and `bwrap` argv.
 *
 * Both functions are pure, so both are tested on every machine — there is no
 * platform skip anywhere in this file. `buildSeatbeltArgs` is exercised on Linux
 * and `buildBwrapArgs` on macOS exactly as often, because which backend runs is
 * a property of the host and what each one *says* is a property of the policy.
 * A test that skipped itself on the wrong OS would report green having checked
 * nothing.
 *
 * The negative assertions carry more weight than the positive ones here. A
 * translator that emits a slightly wrong allow list still produces an argv that
 * looks right; the things that must never appear are the things worth pinning.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileSystemSandboxEntry, SandboxPolicy } from "@labunbun/agent";
import { buildBwrapArgs } from "../src/sandbox/bwrap.ts";
import { policyFor } from "../src/sandbox/index.ts";
import { buildSeatbeltArgs } from "../src/sandbox/seatbelt.ts";

const WORKSPACE = "/w/repo";
const BUILD_CACHE = "/w/.cache/labunbun";
const SPILL = "/tmp/labunbun-spill";
const GIT = "/w/repo/.git";
const COMMAND = ["bash", "-lc", "npm test"];

/**
 * The shape `buildSandboxPolicy` produces for `workspace-write`: the workspace
 * writable, an optional writable root, an optional read-only root, and `.git`
 * protected. Written out literally rather than built by the builder so a change
 * in `sandbox-policy.ts` cannot quietly redefine what these translators claim to
 * handle.
 */
const POLICY: SandboxPolicy = {
	fileSystem: {
		kind: "restricted",
		entries: [
			{ path: WORKSPACE, access: "write" },
			{ path: BUILD_CACHE, access: "write", missingPathBehavior: "skip" },
			{ path: SPILL, access: "read", missingPathBehavior: "skip" },
		],
	},
	network: "enabled",
	networkRules: [],
	protected: [GIT],
};

/** `danger-full-access`: no entries, no protected paths, network left alone. */
const UNRESTRICTED: SandboxPolicy = {
	fileSystem: { kind: "unrestricted", entries: [] },
	network: "enabled",
	networkRules: [],
	protected: [],
};

/** Every profile shape this file can ask for, restricted and not. */
const PROFILES: readonly SandboxPolicy[] = [POLICY, { ...POLICY, network: "restricted" }, UNRESTRICTED];

/**
 * The profile text out of each argv, for the cases that produce one.
 *
 * `argv[1]` is the `-p` value, and a policy that confines nothing with the
 * network on returns the command unwrapped — that case has no profile, so the
 * slice is empty and contributes nothing to check.
 */
function profilesUnderTest(): string[] {
	return PROFILES.map((policy) => buildSeatbeltArgs(policy, COMMAND)[1] ?? "");
}

interface Backend {
	readonly platform: "darwin" | "linux";
	readonly name: string;
	build: (policy: SandboxPolicy, command: string[]) => string[];
}

/**
 * Both backends, both platforms, on every host. `test.each` is not used: it
 * rejects `readonly` tables of objects (TS2769) and `as const` tuples, and the
 * `for ... of` form below keeps the type of each row exact.
 */
const BACKENDS: readonly Backend[] = [
	{ platform: "darwin", name: "seatbelt", build: buildSeatbeltArgs },
	{ platform: "linux", name: "bwrap", build: buildBwrapArgs },
];

/** The policy string from a seatbelt argv, or a loud failure if it is not one. */
function profileOf(argv: string[]): string {
	if (argv[0] !== "-p") throw new Error(`not a seatbelt argv: ${argv[0]}`);
	return argv[1];
}

/** The `-DKEY=value` arguments from a seatbelt argv, as a map of key to value. */
function definitionsOf(argv: string[]): Map<string, string> {
	const definitions = new Map<string, string>();
	for (const arg of argv.slice(2)) {
		if (arg === "--") break;
		if (!arg.startsWith("-D")) throw new Error(`not a -D definition: ${arg}`);
		const separator = arg.indexOf("=");
		definitions.set(arg.slice(2, separator), arg.slice(separator + 1));
	}
	return definitions;
}

/** Every argv element that is not part of the wrapped command. */
function wrapperOf(argv: string[], command: string[]): string[] {
	const separator = argv.indexOf("--");
	if (separator < 0) return argv;
	expect(argv.slice(separator + 1)).toEqual(command);
	return argv.slice(0, separator);
}

interface Mount {
	readonly flag: string;
	readonly source: string;
	readonly target: string;
	/** Index of the flag in the argv, so ordering assertions can use it. */
	readonly index: number;
}

/** Parse a bwrap argv into its mount triples. */
function mountsOf(argv: string[]): Mount[] {
	const mounts: Mount[] = [];
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag !== "--bind" && flag !== "--ro-bind" && flag !== "--ro-bind-data") continue;
		mounts.push({ flag, source: argv[index + 1], target: argv[index + 2], index });
	}
	return mounts;
}

/**
 * How `path` was made read-only, or `null` if it was not made read-only at all.
 *
 * Both recipes a protected path can receive are recognised, deliberately: the
 * properties the tests above assert about `.git` — that it is never in a writable
 * position, that its protection lands after the bind that could cover it — are
 * properties of the *outcome*, and a reader that only understood `--ro-bind`
 * would stop checking them the moment the second recipe existed. `--perms` is
 * skipped rather than parsed because it takes a mode, not a path; `--remount-ro`
 * is an attribute of the mount just made, not a mount of its own.
 */
function protectionOf(argv: string[], path: string): "ro-bind" | "empty-dir" | null {
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--ro-bind" && argv[index + 1] === path && argv[index + 2] === path) return "ro-bind";
		if (flag === "--tmpfs" && argv[index + 1] === path) return "empty-dir";
	}
	return null;
}

/** The flags and the path of the empty-directory recipe, sliced straight out. */
function emptyDirRecipe(argv: string[], path: string): string[] {
	const at = argv.indexOf("--perms");
	if (at < 0 || argv[at + 2] !== "--tmpfs" || argv[at + 3] !== path) return [];
	return argv.slice(at, at + 6);
}

/** Whether `candidate` is `root` or sits inside it, on canonical absolute paths. */
function isAtOrBelow(candidate: string, root: string): boolean {
	const normalized = root.replace(/\/+$/, "");
	return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

/**
 * Policies that exercise every kind of path deny, with the number of path-deny
 * lines each one must end on. The counting is deliberate: it is what stops a
 * translator from quietly dropping one while still satisfying an ordering
 * assertion on the others.
 */
const DENY_ORDERING_CASES: { policy: SandboxPolicy; expectedPathDenies: number }[] = [
	// one protected path, whose ancestor is the writable root itself
	{ policy: POLICY, expectedPathDenies: 2 },
	// a protected path nested two levels down contributes two ancestors
	{
		policy: { ...POLICY, protected: ["/w/repo/sub/deeper/.git"] },
		expectedPathDenies: 4,
	},
	// a denied path and a protected path under the same root
	{
		policy: {
			...POLICY,
			fileSystem: {
				kind: "restricted",
				entries: [
					{ path: WORKSPACE, access: "write" },
					{ path: "/w/repo/.env", access: "deny" },
					{ path: SPILL, access: "read", missingPathBehavior: "skip" },
				],
			},
			protected: [GIT],
		},
		expectedPathDenies: 3,
	},
	// a protected path outside every writable root has no ancestors to protect
	{
		policy: { ...POLICY, protected: ["/elsewhere/.git"] },
		expectedPathDenies: 1,
	},
	// no protected paths at all still ends on nothing rather than a stray deny
	{ policy: { ...POLICY, protected: [] }, expectedPathDenies: 0 },
];

/**
 * A path crafted to break a translator that pastes paths into a template: it
 * closes the string it is in, closes the rule it is in, and opens two of its own
 * that grant everything.
 */
const HOSTILE_PATH = '/w/repo") (allow file-write*) (subpath "/';

describe("buildSeatbeltArgs", () => {
	// `sandbox-exec` reads SBPL, and the one thing SBPL will not do is accept a
	// wildcard where a *literal* operation name goes. `(allow ipc-posix-sysv*)`
	// compiles nowhere: the profile is rejected, the process exits 65, and every
	// confined command on the machine fails to start carrying a parser backtrace.
	// Nothing outside macOS parses SBPL, so nothing outside the macOS CI job
	// could have found it.
	//
	// The rule being checked is narrower than "no wildcards", because some of
	// them are real: SBPL defines operation *families* for the filesystem
	// operations — `file-read*` is `file-read-metadata` plus `file-read-data` plus
	// the rest — and `process-info*` is one too. The IPC, Mach, signal and sysctl
	// names are literals, and appending `*` to one of those produces a variable
	// rather than a family. So: a `*` is legal after `file-` and on
	// `process-info`, and nowhere else. Finding a new legal family means editing
	// this line, which is the friction that is wanted.
	const WILDCARD_FAMILIES = /^(file-.*|process-info)\*$/;
	test("every operation name is one SBPL would accept", () => {
		const offenders: string[] = [];
		for (const profile of profilesUnderTest()) {
			for (const line of profile.split("\n")) {
				if (line.trimStart().startsWith(";")) continue;
				// Paths only ever reach a profile through `(param …)`, so every token
				// outside a nested form is an operation name.
				for (const raw of line
					.trim()
					.replace(/^\((?:allow|deny)\s+/, "")
					.split(/\s+/)) {
					if (raw.startsWith("(")) break;
					const token = raw.replace(/\)+$/, "");
					if (!token.includes("*") || WILDCARD_FAMILIES.test(token)) continue;
					offenders.push(line.trim());
					break;
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	// The base profile opens `(deny default)`, so an operation with no rule is
	// refused rather than merely discouraged. sysctl is the one omission that
	// was load-bearing: measured on macOS, with no sysctl rule a JavaScript
	// runtime died during startup — `bun -e '…'` exited 133 (SIGTRAP) with both
	// streams empty, and the Bash tool faithfully reported "[exit code: 0]".
	// `/bin/echo` under the same profile was fine, because it queries nothing,
	// which is what made the fault look like a lost pipe instead of a dead
	// process. Seven CI runs passed with the block absent because nothing
	// asserted it was there; this asserts it.
	//
	// The enumeration is checked rather than a bare `(allow sysctl-read)`: a
	// confined command should get the named keys, not every key the kernel has.
	// So a profile that widens to the bare form fails, which is the direction
	// this file's negative assertions are for.
	test("reads sysctl through an enumerated list, not a blanket allow", () => {
		// Only the profiles that are profiles: `danger-full-access` with the
		// network on returns the command unwrapped, so its `argv[1]` is `-lc`
		// and asserting SBPL against it would fail for the wrong reason.
		const profiles = profilesUnderTest().filter((profile) => profile.startsWith("(version 1)"));
		expect(profiles.length).toBeGreaterThan(0);
		for (const profile of profiles) {
			// Rules only. The block's own comment names the blanket form it is
			// avoiding, and a check that reads prose is a check that can be
			// satisfied or broken by a sentence.
			const rules = profile
				.split("\n")
				.filter((line) => !line.trimStart().startsWith(";"))
				.join("\n");
			expect(rules).toContain("(allow sysctl-read");
			expect(rules).toContain('(sysctl-name "hw.ncpu")');
			expect(rules).not.toMatch(/\(allow sysctl-read\s*\)/);
		}
	});

	test("produces the argv verbatim for a workspace-write policy", () => {
		expect(buildSeatbeltArgs(POLICY, COMMAND)).toEqual([
			"-p",
			[
				"(version 1)",
				"(deny default)",
				"",
				"; Process control, scoped to this sandbox so a child cannot signal out of it.",
				"(allow process-fork)",
				"(allow process-exec)",
				"(allow signal (target same-sandbox))",
				"(allow process-info*)",
				"",
				"; Sysctls permitted. This list is not decoration and the omission of it was a",
				"; real defect, measured on macOS rather than reasoned about: with no sysctl rule",
				"; at all under the (deny default) below, a JavaScript runtime dies during",
				"; startup and takes the whole command with it. A one-liner under this profile",
				"; exited 133 -- SIGTRAP -- with both streams empty, so the Bash tool reported",
				'; "[exit code: 0]" and a test asserting that a command\'s output arrives saw',
				"; nothing. /bin/echo under the identical profile was fine, because it queries",
				"; nothing, which is what pinned the fault on the runtime's startup rather than",
				"; on exec.",
				";",
				"; These rules were carried over from a working base policy rather than written",
				"; from scratch here. They are enumerated rather than a bare (allow sysctl-read)",
				"; because the enumeration hands a confined command those specific keys rather",
				"; than every key the kernel has. The trade is that a runtime querying a key",
				"; outside this list still fails to start, so adding to it is the price of not",
				"; widening it.",
				"(allow sysctl-read",
				'  (sysctl-name "hw.activecpu")',
				'  (sysctl-name "hw.busfrequency_compat")',
				'  (sysctl-name "hw.byteorder")',
				'  (sysctl-name "hw.cacheconfig")',
				'  (sysctl-name "hw.cachelinesize_compat")',
				'  (sysctl-name "hw.cpufamily")',
				'  (sysctl-name "hw.cpufrequency_compat")',
				'  (sysctl-name "hw.cputype")',
				'  (sysctl-name "hw.l1dcachesize_compat")',
				'  (sysctl-name "hw.l1icachesize_compat")',
				'  (sysctl-name "hw.l2cachesize_compat")',
				'  (sysctl-name "hw.l3cachesize_compat")',
				'  (sysctl-name "hw.logicalcpu_max")',
				'  (sysctl-name "hw.machine")',
				'  (sysctl-name "hw.model")',
				'  (sysctl-name "hw.memsize")',
				'  (sysctl-name "hw.ncpu")',
				'  (sysctl-name "hw.nperflevels")',
				'  (sysctl-name "hw.packages")',
				'  (sysctl-name "hw.pagesize_compat")',
				'  (sysctl-name "hw.pagesize")',
				'  (sysctl-name "hw.physicalcpu")',
				'  (sysctl-name "hw.physicalcpu_max")',
				'  (sysctl-name "hw.logicalcpu")',
				'  (sysctl-name "hw.cpufrequency")',
				'  (sysctl-name "hw.tbfrequency_compat")',
				'  (sysctl-name "hw.vectorunit")',
				'  (sysctl-name "machdep.cpu.brand_string")',
				'  (sysctl-name "kern.argmax")',
				'  (sysctl-name "kern.hostname")',
				'  (sysctl-name "kern.maxfilesperproc")',
				'  (sysctl-name "kern.maxproc")',
				'  (sysctl-name "kern.osproductversion")',
				'  (sysctl-name "kern.osrelease")',
				'  (sysctl-name "kern.ostype")',
				'  (sysctl-name "kern.osvariant_status")',
				'  (sysctl-name "kern.osversion")',
				'  (sysctl-name "kern.secure_kernel")',
				'  (sysctl-name "kern.sysv.semmns")',
				'  (sysctl-name "kern.usrstack64")',
				'  (sysctl-name "kern.version")',
				'  (sysctl-name "sysctl.proc_cputype")',
				'  (sysctl-name "vm.loadavg")',
				'  (sysctl-name-prefix "hw.optional.arm.")',
				'  (sysctl-name-prefix "hw.optional.armv8_")',
				'  (sysctl-name-prefix "hw.perflevel")',
				'  (sysctl-name-prefix "kern.proc.pgrp.")',
				'  (sysctl-name-prefix "kern.proc.pid.")',
				'  (sysctl-name-prefix "net.routetable."))',
				"; Misclassified as a write because the caller passes a buffer to read into.",
				'(allow sysctl-write (sysctl-name "kern.grade_cputype"))',
				"",
				"; The terminal. Without these an interactive shell cannot detect a TTY and",
				"; coreutils refuses to run at all.",
				"(allow pseudo-tty)",
				'(allow file-read* file-write* file-ioctl (literal "/dev/null"))',
				'(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
				'(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))',
				"",
				'(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
				"",
				"; Local IPC, plus the two Mach services a process cannot start without:",
				"; opendirectoryd resolves the user's home directory, PowerManagement handles",
				"; sleep. Everything else is withheld.",
				"(allow ipc-posix-shm-read-data)",
				"(allow ipc-posix-shm-write-create)",
				"(allow ipc-posix-shm-write-unlink)",
				"(allow ipc-posix-sem)",
				"(allow mach-lookup",
				'  (global-name "com.apple.system.opendirectoryd.libinfo")',
				'  (global-name "com.apple.PowerManagement.control"))',
				"; Read baseline: readable everywhere, matching this build's read-only mode.",
				'; "read" entries are additions to this and so emit no rule of their own.',
				"(allow file-read*)",
				'(allow file-write* (subpath (param "WRITABLE_ROOT_0")))',
				'(allow file-write* (subpath (param "WRITABLE_ROOT_1")))',
				"; Network: enabled.",
				"(allow network-outbound)",
				"(allow network-inbound)",
				"(allow system-socket",
				"  (require-all",
				"    (socket-domain AF_SYSTEM)",
				"    (socket-protocol 2)))",
				"(allow mach-lookup",
				'  (global-name "com.apple.bsd.dirhelper")',
				'  (global-name "com.apple.system.opendirectoryd.membership")',
				'  (global-name "com.apple.SecurityServer")',
				'  (global-name "com.apple.networkd")',
				'  (global-name "com.apple.ocspd")',
				'  (global-name "com.apple.trustd.agent")',
				'  (global-name "com.apple.SystemConfiguration.DNSConfiguration")',
				'  (global-name "com.apple.SystemConfiguration.configd"))',
				'(deny file-write* (subpath (param "PROTECTED_0")))',
				'(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal (param "PROTECTED_ANCESTOR_0"))))',
			].join("\n"),
			"-DWRITABLE_ROOT_0=/w/repo",
			"-DWRITABLE_ROOT_1=/w/.cache/labunbun",
			"-DPROTECTED_0=/w/repo/.git",
			"-DPROTECTED_ANCESTOR_0=/w/repo",
			"--",
			"bash",
			"-lc",
			"npm test",
		]);
	});

	test("puts every path in a -D definition and none in the profile text", () => {
		const profile = profileOf(buildSeatbeltArgs(POLICY, COMMAND));
		const definitions = definitionsOf(buildSeatbeltArgs(POLICY, COMMAND));

		for (const [key, value] of definitions) {
			expect(profile).toContain(`(param "${key}")`);
			// The path travels only as the value of a definition.
			expect(profile).not.toContain(value);
		}
		expect(definitions.get("WRITABLE_ROOT_0")).toBe(WORKSPACE);
		expect(definitions.get("PROTECTED_0")).toBe(GIT);
	});

	test("a path carrying profile syntax cannot append a rule", () => {
		const hostile: SandboxPolicy = {
			...POLICY,
			fileSystem: {
				kind: "restricted",
				entries: [{ path: HOSTILE_PATH, access: "write" }],
			},
			protected: [],
		};
		const argv = buildSeatbeltArgs(hostile, COMMAND);
		const profile = profileOf(argv);

		// The injected text appears once, as the value of one -D argument.
		expect(profile).not.toContain(HOSTILE_PATH);
		expect(profile).not.toContain("(allow file-write*) (subpath");
		expect(profile.match(/\(allow /g)?.length).toBeGreaterThan(0);
		expect(argv.filter((arg) => arg.includes(HOSTILE_PATH))).toEqual([
			'-DWRITABLE_ROOT_0=/w/repo") (allow file-write*) (subpath "/',
		]);
	});

	test("a deny emitted before a broad allow would be dead text, so nothing is", () => {
		for (const row of DENY_ORDERING_CASES) {
			const lines = profileOf(buildSeatbeltArgs(row.policy, COMMAND)).split("\n");
			// `(deny default)` opens the base policy and covers everything; the
			// ordering that matters is where the *path* denies land.
			const firstPathDeny = lines.findIndex((line) => line.startsWith("(deny ") && line !== "(deny default)");
			const pathDenies = lines.filter((line) => line.startsWith("(deny ") && line !== "(deny default)");

			expect(pathDenies).toHaveLength(row.expectedPathDenies);
			if (row.expectedPathDenies === 0) {
				expect(firstPathDeny).toBe(-1);
				continue;
			}
			expect(firstPathDeny).toBeGreaterThan(lines.findIndex((line) => line.startsWith("(allow file-read*)")));
			// Seatbelt resolves last-rule-wins. An allow emitted after a path deny
			// re-opens it, which is the whole bug this ordering exists to prevent.
			expect(lines.slice(firstPathDeny).filter((line) => line.startsWith("(allow "))).toEqual([]);
			// Every path deny is in the tail, contiguously, with no rule after it.
			const tail = lines.slice(firstPathDeny);
			expect(tail.every((line) => line.startsWith("(deny "))).toBe(true);
			expect(tail).toHaveLength(row.expectedPathDenies);
		}
	});

	test("the protected path is denied last and is never writable", () => {
		const argv = buildSeatbeltArgs(POLICY, COMMAND);
		const lines = profileOf(argv).split("\n");
		const writeAllows = lines.filter((line) => line.startsWith("(allow file-write* (subpath"));

		expect(writeAllows).toEqual([
			'(allow file-write* (subpath (param "WRITABLE_ROOT_0")))',
			'(allow file-write* (subpath (param "WRITABLE_ROOT_1")))',
		]);
		expect(lines.indexOf('(deny file-write* (subpath (param "PROTECTED_0")))')).toBe(lines.length - 2);
		expect(lines[lines.length - 1]).toContain("PROTECTED_ANCESTOR_0");
	});

	test("denies unlinking the directories that would rename a protected path away", () => {
		// seatbelt matches pathnames, so `mv /w/repo/sub /w/repo/x` would move a
		// protected /w/repo/sub/.git out of the subpath the deny matches.
		const nested = buildSeatbeltArgs({ ...POLICY, protected: ["/w/repo/sub/.git"] }, COMMAND);

		expect(definitionsOf(nested).get("PROTECTED_ANCESTOR_0")).toBe("/w/repo");
		expect(definitionsOf(nested).get("PROTECTED_ANCESTOR_1")).toBe("/w/repo/sub");
		expect(profileOf(nested)).toContain(
			'(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal (param "PROTECTED_ANCESTOR_1"))))',
		);
	});

	test("a writable root of `/` terminates the ancestor walk instead of hanging", () => {
		// The guard, not the ordinary exit. `isAtOrBelow` strips trailing slashes,
		// so a root of `/` becomes `""` and matches every absolute path; and
		// `parentOf("/")` is `""` while `parentOf("")` is also `""`, so the climb
		// oscillates between `""` and `""` and never leaves the loop. Measured
		// before the guard: a chain of `[…, "/", "", "", "", …]`, still going after
		// twelve steps.
		//
		// Nothing in this build produces such a root — `danger-full-access` is how a
		// caller means "the whole disk" — so this is a policy no builder emits. It
		// is here because `buildSeatbeltArgs` accepts a policy by value, and a
		// profile generator that can be made to spin is worth refusing even on an
		// input the current builder cannot produce. The assertion is that the call
		// returns; without the guard this test hangs rather than fails, so it is
		// paired with the ordinary exit below, which pins the answer rather than
		// just the absence of a hang.
		const wholeDisk: SandboxPolicy = {
			...POLICY,
			fileSystem: { kind: "restricted", entries: [{ path: "/", access: "write" }] },
			protected: ["/.git"],
		};

		const argv = buildSeatbeltArgs(wholeDisk, COMMAND);
		expect(definitionsOf(argv).get("PROTECTED_ANCESTOR_0")).toBe("/");

		// The control: the same walk with an ordinary root still yields the full
		// ancestor chain, so the guard above is not what makes the walk produce
		// anything at all.
		expect(
			definitionsOf(buildSeatbeltArgs({ ...POLICY, protected: ["/w/repo/sub/.git"] }, COMMAND)).get(
				"PROTECTED_ANCESTOR_1",
			),
		).toBe("/w/repo/sub");
	});

	test("a path nothing may read is denied read as well as write", () => {
		const entries: FileSystemSandboxEntry[] = [
			{ path: WORKSPACE, access: "write" },
			{ path: "/w/repo/.env", access: "deny" },
		];
		const argv = buildSeatbeltArgs({ ...POLICY, fileSystem: { kind: "restricted", entries }, protected: [] }, COMMAND);
		const profile = profileOf(argv);

		expect(profile).toContain('(deny file-read* file-write* (subpath (param "DENIED_1")))');
		expect(definitionsOf(argv).get("DENIED_1")).toBe("/w/repo/.env");
		// The read baseline comes first, so the deny has to override it.
		expect(profile.indexOf("(allow file-read*)")).toBeLessThan(profile.indexOf("DENIED_1"));
	});

	test("a read-only entry produces no rule, because the baseline is already readable", () => {
		const argv = buildSeatbeltArgs(POLICY, COMMAND);
		expect(profileOf(argv)).toContain("(allow file-read*)");
		expect([...definitionsOf(argv).keys()].filter((key) => key.includes(SPILL) || key === "READABLE_ROOT_2")).toEqual(
			[],
		);
		expect(wrapperOf(argv, COMMAND).join(" ")).not.toContain(SPILL);
	});

	test("the network axis decides the profile, not the filesystem axis", () => {
		const restricted = profileOf(buildSeatbeltArgs({ ...POLICY, network: "restricted" }, COMMAND));
		expect(restricted).not.toContain("(allow network-outbound)");
		expect(restricted).not.toContain("(allow network-inbound)");
		// ...and the Mach services that only exist to serve it go with it.
		expect(restricted).not.toContain("com.apple.SecurityServer");
		expect(restricted).toContain("(deny default)");

		expect(profileOf(buildSeatbeltArgs({ ...POLICY, network: "enabled" }, COMMAND))).toContain(
			"(allow network-outbound)",
		);
	});

	test("an unrestricted policy wraps nothing at all", () => {
		expect(buildSeatbeltArgs(UNRESTRICTED, COMMAND)).toEqual(COMMAND);
	});

	test("an unrestricted filesystem with the network restricted still wraps", () => {
		const argv = buildSeatbeltArgs({ ...UNRESTRICTED, network: "restricted" }, COMMAND);
		const profile = profileOf(argv);

		expect(argv[0]).toBe("-p");
		expect(profile).toContain("(allow file-read*)");
		expect(profile).toContain("(allow file-write*)");
		expect(profile).toContain("(deny default)");
		expect(profile).not.toContain("(allow network-outbound)");
		expect(wrapperOf(argv, COMMAND)).toEqual(["-p", profile]);
	});

	test("never mentions a path the policy did not name", () => {
		const entries: FileSystemSandboxEntry[] = [{ path: WORKSPACE, access: "write" }];
		const wrapper = wrapperOf(
			buildSeatbeltArgs({ ...POLICY, fileSystem: { kind: "restricted", entries }, protected: [] }, COMMAND),
			COMMAND,
		);

		for (const outsider of ["/etc", "/w/secrets", "/Users/someone/.ssh", "C:/Windows"]) {
			expect(wrapper.join(" ")).not.toContain(outsider);
		}
	});

	test("is pure: the same policy produces the same argv every time", () => {
		const once = buildSeatbeltArgs(POLICY, COMMAND);
		const twice = buildSeatbeltArgs(POLICY, COMMAND);
		expect(twice).toEqual(once);
		expect(twice).not.toBe(once);
		// The caller's array is not captured or mutated.
		expect(COMMAND).toEqual(["bash", "-lc", "npm test"]);
	});
});

describe("buildBwrapArgs", () => {
	test("produces the argv verbatim for a workspace-write policy", () => {
		expect(buildBwrapArgs(POLICY, COMMAND)).toEqual([
			"--new-session",
			"--die-with-parent",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--bind",
			"/w/repo",
			"/w/repo",
			"--bind",
			"/w/.cache/labunbun",
			"/w/.cache/labunbun",
			"--ro-bind",
			"/w/repo/.git",
			"/w/repo/.git",
			"--unshare-user",
			"--unshare-pid",
			"--unshare-ipc",
			"--proc",
			"/proc",
			"--cap-drop",
			"ALL",
			"--",
			"bash",
			"-lc",
			"npm test",
		]);
	});

	test("a .git path is never in a writable position", () => {
		const mounts = mountsOf(buildBwrapArgs(POLICY, COMMAND)).filter(
			(mount) => mount.source === GIT || mount.target === GIT,
		);

		expect(mounts).toHaveLength(1);
		expect(mounts[0].flag).toBe("--ro-bind");
	});

	test("every read-only protection comes after the writable bind that could cover it", () => {
		const mounts = mountsOf(buildBwrapArgs(POLICY, COMMAND));
		// A later mount shadows an earlier one, so a protection that lands before
		// the `--bind` covering it is not protecting anything at all. The
		// read-everything `--ro-bind / /` baseline is deliberately excluded: it is
		// meant to be shadowed, and that is how the writable roots are carved out
		// of it in the first place.
		const protections = mounts.filter((mount) => mount.flag === "--ro-bind" && mount.source !== "/");
		const defeated = protections.filter((protection) =>
			mounts.some(
				(rw) => rw.flag === "--bind" && rw.index > protection.index && isAtOrBelow(protection.source, rw.source),
			),
		);

		expect(protections.map((mount) => mount.source)).toEqual([GIT]);
		expect(defeated).toEqual([]);
	});

	test("a path nothing may read is bound read-only, after the root that allows it", () => {
		const entries: FileSystemSandboxEntry[] = [
			{ path: WORKSPACE, access: "write" },
			{ path: "/w/repo/.env", access: "deny" },
		];
		const mounts = mountsOf(
			buildBwrapArgs({ ...POLICY, fileSystem: { kind: "restricted", entries }, protected: [] }, COMMAND),
		);
		const env = mounts.filter((mount) => mount.source === "/w/repo/.env");
		const repo = mounts.find((mount) => mount.flag === "--bind" && mount.source === WORKSPACE);

		expect(env.map((mount) => mount.flag)).toEqual(["--ro-bind"]);
		expect(env[0].index).toBeGreaterThan(repo?.index ?? -1);
	});

	test("a read-only entry produces no mount, because the baseline is already readable", () => {
		const argv = buildBwrapArgs(POLICY, COMMAND);
		expect(argv.slice(0, argv.indexOf("--"))).toContain("/");
		expect(wrapperOf(argv, COMMAND).join(" ")).not.toContain(SPILL);
		expect(mountsOf(argv).some((mount) => mount.source === SPILL)).toBe(false);
	});

	test("drops every capability and enters fresh namespaces", () => {
		const argv = buildBwrapArgs(POLICY, COMMAND);
		expect(argv.slice(argv.indexOf("--cap-drop"), argv.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
		for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--new-session", "--die-with-parent"]) {
			expect(argv).toContain(flag);
		}
	});

	test("--unshare-net appears exactly when the network is restricted", () => {
		const cases: { network: SandboxPolicy["network"]; expected: number }[] = [
			{ network: "restricted", expected: 1 },
			{ network: "enabled", expected: 0 },
		];

		for (const row of cases) {
			const argv = buildBwrapArgs({ ...POLICY, network: row.network }, COMMAND);
			expect(argv.filter((arg) => arg === "--unshare-net")).toHaveLength(row.expected);
		}
	});

	test("an unrestricted policy wraps nothing at all", () => {
		expect(buildBwrapArgs(UNRESTRICTED, COMMAND)).toEqual(COMMAND);
	});

	test("an unrestricted filesystem with the network restricted still wraps", () => {
		const argv = buildBwrapArgs({ ...UNRESTRICTED, network: "restricted" }, COMMAND);

		expect(wrapperOf(argv, COMMAND)).toEqual([
			"--new-session",
			"--die-with-parent",
			"--bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--unshare-user",
			"--unshare-pid",
			"--unshare-ipc",
			"--unshare-net",
			"--proc",
			"/proc",
			"--cap-drop",
			"ALL",
		]);
	});

	test("never mentions a path the policy did not name", () => {
		const entries: FileSystemSandboxEntry[] = [{ path: WORKSPACE, access: "write" }];
		const wrapper = wrapperOf(
			buildBwrapArgs({ ...POLICY, fileSystem: { kind: "restricted", entries }, protected: [] }, COMMAND),
			COMMAND,
		);

		for (const outsider of ["/etc", "/w/secrets", "/root/.ssh", "C:/Windows"]) {
			expect(wrapper.join(" ")).not.toContain(outsider);
		}
	});

	test("a path that spells a flag is still one operand", () => {
		// Not an absolute path, so no producer emits one — but the property under
		// test is that an argv array cannot be confused by its contents at all,
		// which is the property seatbelt has to work for with `-D` parameters.
		const argv = buildBwrapArgs(
			{
				...POLICY,
				fileSystem: { kind: "restricted", entries: [{ path: "--bind", access: "write" }] },
				protected: [],
			},
			COMMAND,
		);

		expect(wrapperOf(argv, COMMAND)).toEqual([
			"--new-session",
			"--die-with-parent",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--bind",
			"--bind",
			"--bind",
			"--unshare-user",
			"--unshare-pid",
			"--unshare-ipc",
			"--proc",
			"/proc",
			"--cap-drop",
			"ALL",
		]);
	});

	test("is pure: the same policy produces the same argv every time", () => {
		const once = buildBwrapArgs(POLICY, COMMAND);
		const twice = buildBwrapArgs(POLICY, COMMAND);
		expect(twice).toEqual(once);
		expect(twice).not.toBe(once);
		expect(COMMAND).toEqual(["bash", "-lc", "npm test"]);
	});
});

describe("buildBwrapArgs on a protected path that is not there", () => {
	// `buildSandboxPolicy` derives `<root>/.git` for every writable root whether or
	// not it exists, which is what makes the protection independent of a scan. The
	// cost of that is a policy naming a path that is not on the disk, and
	// `--ro-bind` of an absent source makes bubblewrap refuse to start — so a
	// narrower sandbox would turn into a shell that does not run, on exactly the
	// machines (a fresh directory, a container that was never `git init`) where the
	// protection has nothing to do anyway. The recipe below is the only third answer:
	// neither binding a path that cannot be bound nor dropping a path that must not
	// be writable.

	test("a path that is there is bound read-only, as before", () => {
		const argv = buildBwrapArgs(POLICY, COMMAND, () => true);

		expect(protectionOf(argv, GIT)).toBe("ro-bind");
		expect(emptyDirRecipe(argv, GIT)).toEqual([]);
	});

	test("a path that is not there gets an empty read-only mount instead of a bind that cannot work", () => {
		const argv = buildBwrapArgs(POLICY, COMMAND, (path) => path !== GIT);

		expect(emptyDirRecipe(argv, GIT)).toEqual(["--perms", "555", "--tmpfs", GIT, "--remount-ro", GIT]);
		expect(protectionOf(argv, GIT)).toBe("empty-dir");
		// The negative that carries the finding, stated against the *path* rather than
		// the flag. `--ro-bind / /` is the read baseline and is in every argv this
		// function ever produces, so a bare "no `--ro-bind`" would be asserting the
		// baseline is gone — and would go red the first time the recipe was correct.
		expect(mountsOf(argv).some((mount) => mount.source === GIT)).toBe(false);
	});

	test("the absent path is never in a writable position, under either recipe", () => {
		// The property the tests above the seam assert for a present `.git`, stated
		// again for the case that has no test of its own anywhere else. Without it,
		// the second recipe would be the one path in this file that could ship a
		// writable `.git` with every existing assertion still green — the protections
		// they read are the `--ro-bind` ones, and a `--tmpfs` is not one.
		for (const present of [true, false]) {
			const argv = buildBwrapArgs(POLICY, COMMAND, () => present);

			// Neither recipe binds `.git` read-write, so there is no position from
			// which it could be written — which is the property, rather than a flag
			// name that one recipe uses and the other does not.
			expect(
				mountsOf(argv).some((mount) => mount.flag === "--bind" && (mount.source === GIT || mount.target === GIT)),
			).toBe(false);
			// And the path is named at all, so the loop above is not passing because
			// the protection was dropped rather than given a different recipe. This is
			// the assertion an earlier version of this test got wrong: it asserted a
			// count that was 2 under both recipes, which is to say it asserted nothing.
			expect(argv.filter((arg) => arg === GIT).length).toBeGreaterThan(0);
			expect(protectionOf(argv, GIT)).not.toBeNull();
		}
	});

	test("the empty mount lands after the bind that could cover it", () => {
		// Ordering is the protection on this backend, and the second recipe has to
		// obey it too. `mountsOf` does not read `--tmpfs`, so this asserts the index
		// directly rather than borrowing a helper that would have to grow a case.
		const argv = buildBwrapArgs(POLICY, COMMAND, (path) => path !== GIT);
		const tmpfs = argv.indexOf("--tmpfs");

		expect(argv.lastIndexOf("--bind")).toBeLessThan(tmpfs);
		expect(argv.lastIndexOf("--ro-bind")).toBeLessThan(tmpfs);
	});

	test("one absent path does not change the recipe the others get", () => {
		const policy = { ...POLICY, protected: [GIT, "/w/repo/sub/.git"] };
		const neither = buildBwrapArgs(policy, COMMAND, () => false);
		const one = buildBwrapArgs(policy, COMMAND, (path) => path === GIT);

		expect(protectionOf(neither, GIT)).toBe("empty-dir");
		expect(protectionOf(neither, "/w/repo/sub/.git")).toBe("empty-dir");
		// Two tmpfs mounts and no stray ro-bind for either path, so neither fell
		// through to the recipe that would have failed.
		expect(neither.filter((arg) => arg === "--tmpfs")).toHaveLength(2);
		expect(mountsOf(neither).some((mount) => mount.source === GIT)).toBe(false);
		// And the split case: one present, one absent, each getting its own recipe. A
		// single boolean for "does this policy have an absent path" would give both
		// the same answer and one of them would be wrong.
		expect(protectionOf(one, GIT)).toBe("ro-bind");
		expect(protectionOf(one, "/w/repo/sub/.git")).toBe("empty-dir");
	});

	test("a caller that says nothing gets the argv it got before", () => {
		// The default is `() => true`, which is a fact about this function's contract
		// rather than a hedge: a translator that stat-ed the filesystem would make
		// every test in this file a test of the machine it ran on, and a CI runner
		// with no `/w/repo/.git` would then expect the tmpfs recipe for a path the
		// policy says is protected. Production passes the real predicate
		// (`resolveSandboxExecution`); this pins that adding the parameter did not
		// quietly move the default under every existing caller.
		expect(buildBwrapArgs(POLICY, COMMAND)).toEqual(buildBwrapArgs(POLICY, COMMAND, () => true));
	});

	test("and it never reaches for the filesystem itself", () => {
		// The guard on the guard. A stat call reaching this file would compile, pass
		// every test above on a machine where `/w/repo/.git` happens not to exist,
		// and make the verbatim argv test at the top of the describe fail on a
		// developer who ran `git init`. The same mistake `web-network-axis.test.ts`
		// made with live DNS, so it is checked here the same way: against the source.
		//
		// The assertion is on the **import**, not on the identifier. An earlier
		// version of this test scanned for the function's name and failed on the
		// doc comment two hundred lines above, which quotes it to explain why it is
		// not the default — the file scanning its own prose is the failure mode this
		// test was written to prevent, so the check is narrowed to the one thing that
		// would actually let a stat call in.
		const source = readFileSync(join(import.meta.dir, "..", "src", "sandbox", "bwrap.ts"), "utf8");

		expect(source).not.toMatch(/^\s*import\s+.*\bfrom\s+"node:fs"/m);
		expect(source).not.toMatch(/\bglobalThis\.existsSync\b/);
	});
});

describe("both backends", () => {
	for (const backend of BACKENDS) {
		test(`${backend.name} (${backend.platform}) returns the command unwrapped for an unrestricted policy`, () => {
			expect(backend.build(UNRESTRICTED, COMMAND)).toEqual(COMMAND);
			expect(backend.build({ ...UNRESTRICTED, network: "enabled" }, COMMAND)).not.toContain("--");
		});

		test(`${backend.name} (${backend.platform}) carries the command after a -- separator`, () => {
			const argv = backend.build(POLICY, COMMAND);
			expect(argv.indexOf("--")).toBeGreaterThan(-1);
			expect(argv.slice(argv.indexOf("--") + 1)).toEqual(COMMAND);
			// Nothing after the separator is wrapper syntax.
			expect(argv.slice(argv.indexOf("--") + 1)).not.toContain("--ro-bind");
		});

		test(`${backend.name} (${backend.platform}) names the protected path only where it is denied`, () => {
			const wrapper = wrapperOf(backend.build(POLICY, COMMAND), COMMAND).join(" ");
			// Present, because the policy named it.
			expect(wrapper).toContain(GIT);
			// But every mention is a deny, never an allow, and never a bare path
			// sitting in a writable position the reader has to interpret.
			expect(wrapper.replace(/-D[A-Z_0-9]+=/g, "").match(/allow file-write\* \/w/g)).toBeNull();
		});

		test(`${backend.name} (${backend.platform}) puts protected paths last`, () => {
			const argv = backend.build(POLICY, COMMAND);
			const gitPositions = argv.map((arg, index) => (arg.includes(GIT) ? index : -1)).filter((index) => index >= 0);
			const wrapper = wrapperOf(argv, COMMAND);

			expect(gitPositions.length).toBeGreaterThan(0);
			// Every mention of `.git` is after the workspace has been made writable,
			// which is what makes the later mention the one that counts.
			const workspacePosition = argv.findIndex((arg) => arg.includes(WORKSPACE));
			expect(Math.min(...gitPositions)).toBeGreaterThan(workspacePosition);
			expect(wrapper.length).toBeGreaterThan(0);
		});

		test(`${backend.name} (${backend.platform}) never widens a policy with no entries`, () => {
			const empty: SandboxPolicy = {
				fileSystem: { kind: "restricted", entries: [] },
				network: "enabled",
				networkRules: [],
				protected: [],
			};
			// A restricted policy with nothing in it still confines the
			// filesystem: it must not become the unrestricted case by omission.
			expect(backend.build(empty, COMMAND)).not.toEqual(COMMAND);
		});
	}
});

/**
 * `policyFor` builds the policy; these are the two things it has to carry into
 * it. Both were found while wiring the network axis through this function, and
 * both failed in the same direction — an option that was accepted, named by a
 * caller, and then dropped, so the policy was narrower than what was asked for
 * and nothing anywhere said so.
 */
describe("policyFor carries what it is given", () => {
	test("a writable root reaches the policy", () => {
		// It did not. The parameter was in the options type and never passed to
		// `buildSandboxPolicy`, so every caller naming one — `workspacePolicy`
		// included — got a policy without it. The type kept accepting the argument
		// throughout, which is exactly why no error ever pointed at it: the
		// signature was a promise the body did not keep.
		const policy = policyFor({
			sandbox: "workspace-write",
			workspace: WORKSPACE,
			writableRoots: ["/tmp/scratch"],
		});
		expect(policy.fileSystem.entries.some((entry) => entry.path === "/tmp/scratch")).toBe(true);
	});

	test("the network axis reaches the policy as both halves", () => {
		const policy = policyFor({
			sandbox: "workspace-write",
			workspace: WORKSPACE,
			network: { access: "restricted", domains: [{ pattern: "x.test", permission: "allow" }] },
		});
		// Asserted as a pair because either alone is a configuration nobody can
		// write: the mode with no table reaches nothing at all, and the table with
		// no mode is consulted by nothing. Passing one without the other is the
		// failure this single `NetworkAxis` field exists to make impossible.
		expect(policy.network).toBe("restricted");
		expect(policy.networkRules).toEqual([{ pattern: "x.test", permission: "allow" }]);
	});
});
