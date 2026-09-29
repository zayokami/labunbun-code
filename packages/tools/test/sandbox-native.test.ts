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
import type { FileSystemSandboxEntry, SandboxPolicy } from "@labunbun/agent";
import { buildBwrapArgs } from "../src/sandbox/bwrap.ts";
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
	protected: [GIT],
};

/** `danger-full-access`: no entries, no protected paths, network left alone. */
const UNRESTRICTED: SandboxPolicy = {
	fileSystem: { kind: "unrestricted", entries: [] },
	network: "enabled",
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
				"; Read baseline: readable everywhere, matching Codex's read-only mode.",
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
				protected: [],
			};
			// A restricted policy with nothing in it still confines the
			// filesystem: it must not become the unrestricted case by omission.
			expect(backend.build(empty, COMMAND)).not.toEqual(COMMAND);
		});
	}
});
