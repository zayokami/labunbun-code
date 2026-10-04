/**
 * The writable set a confined command gets, other than the workspace.
 *
 * `workspace-write` used to mean "the workspace is the only writable path", and
 * every ordinary command broke there: `mktemp` could not create its directory,
 * `npm install` could not write its cache. Nothing was leaking — the policy was
 * exactly as narrow as it was built, because `bash.ts` never passed
 * `writableRoots` even though every layer below it accepted one.
 *
 * So the property under test is not "the temp directory is writable", which one
 * assertion would cover. It is the pair that a fix could plausibly get half
 * right:
 *
 *   - every named root reaches **both** native backends as a writable mount,
 *     and
 *   - the workspace's `.git` is **still** protected afterwards.
 *
 * Those pull in opposite directions and a test that only asserts the first
 * passes on a policy whose `.git` protection was dropped on the way — which is
 * the specific regression the `.git` derivation in `buildSandboxPolicy` exists
 * to prevent. Every argv assertion below therefore checks both halves.
 *
 * **Expectations are literals in the `/` spelling**, never `join(home, ...)`.
 * A value re-derived with the same call the code uses agrees with a regression
 * in that call; these files have been bitten by exactly that (`sandbox-policy.ts`
 * and the fail-open it let through Windows).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxMode, SandboxPolicy, ToolCallContext } from "@labunbun/agent";
import { createBashTool } from "../src/bash.ts";
import { defaultOperations, type ExecResult, type Operations } from "../src/operations.ts";
import { buildBwrapArgs } from "../src/sandbox/bwrap.ts";
import { describeWritableRoots, resolveWritableRoots } from "../src/sandbox/default-writable-roots.ts";
import { resolveSandboxExecution } from "../src/sandbox/index.ts";
import { buildSeatbeltArgs } from "../src/sandbox/seatbelt.ts";
import { decideWrite } from "../src/sandbox/simulated.ts";

/** The workspace under test. A POSIX-shaped literal, as every policy path is. */
const WORKSPACE = "/w/repo";
/** A home that is not this machine's. Nothing here reads a real one. */
const HOME = "/h/user";
const TEMP = "/tmp/lbb-tmp";

const ctx = (sandbox: SandboxMode): ToolCallContext => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd: WORKSPACE,
	sandbox,
	network: { access: "enabled", domains: [] },
	onUpdate: () => {},
});

/** The policy the Bash tool builds for this home, through its real call site. */
async function bashPolicy(options: { home?: string; configured?: readonly string[] }): Promise<SandboxPolicy> {
	const sink: { policy?: SandboxPolicy } = {};
	const ops: Operations = {
		...defaultOperations(),
		exec: (opts): Promise<ExecResult> => {
			sink.policy = opts.sandbox;
			return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, killed: false });
		},
	};
	const tool = createBashTool(WORKSPACE, ops, undefined, {
		home: options.home,
		writableRoots: options.configured,
		tempDir: TEMP,
	});
	await tool.call({ command: "mktemp -d" }, ctx("workspace-write"));
	if (sink.policy === undefined) throw new Error("the Bash tool built no policy");
	return sink.policy;
}

/** The path after each `--bind <src> <dst>`, which is where the writable set is. */
function bindTargets(argv: string[]): string[] {
	const targets: string[] = [];
	for (const [index, flag] of argv.entries()) if (flag === "--bind") targets.push(argv[index + 2]);
	return targets;
}

/** The path after each `-D<prefix>_<n>=<value>`, by exact key. */
function seatbeltParams(argv: string[], prefix: string): string[] {
	const pattern = new RegExp(`^-D${prefix}_\\d+=(.*)$`);
	return argv.map((arg) => pattern.exec(arg)?.[1]).filter((value): value is string => value !== undefined);
}

describe("the writable set under workspace-write", () => {
	test("`mktemp`, the npm cache and the bun cache are writable; nothing else is", async () => {
		const policy = await bashPolicy({ home: HOME });

		for (const path of [
			`${TEMP}/scratch`,
			`${HOME}/.npm/_cacache/index-v5`,
			`${HOME}/.bun/install/cache/x.tgz`,
			`${WORKSPACE}/src/index.ts`,
		]) {
			expect({ path, allowed: decideWrite(policy, path, WORKSPACE).allowed }).toEqual({ path, allowed: true });
		}

		// The whole point of the change is a *wider* set, and a set that widened
		// without a boundary is not a fix. These are the two a reader would worry
		// about: a cache this build does not grant by default, and the user's
		// documents.
		for (const path of [`${HOME}/.cache/pip/wheels`, `${HOME}/Documents/notes.md`]) {
			expect({ path, allowed: decideWrite(policy, path, WORKSPACE).allowed }).toEqual({ path, allowed: false });
		}
	});

	test("bwrap emits a `--bind` for every root, and still protects the workspace `.git`", async () => {
		const policy = await bashPolicy({ home: HOME });

		const argv = buildBwrapArgs(policy, ["/bin/sh", "-c", "echo hi"], () => true);

		expect(bindTargets(argv)).toEqual([WORKSPACE, TEMP, `${HOME}/.npm`, `${HOME}/.bun`]);
		// The half a "did the new binds show up?" assertion would miss. Ordering is
		// the protection — the read-only bind has to land after the writable one that
		// covers it — so this is an index comparison and not a `toContain`.
		const writable = argv.indexOf("--bind");
		const protectedBind = argv.indexOf("--ro-bind", writable);
		expect(protectedBind).toBeGreaterThan(writable);
		expect(argv.slice(protectedBind, protectedBind + 3)).toEqual([
			"--ro-bind",
			`${WORKSPACE}/.git`,
			`${WORKSPACE}/.git`,
		]);
	});

	test("the seatbelt profile allows each root, and denies the workspace `.git` after them", async () => {
		const policy = await bashPolicy({ home: HOME });

		const argv = buildSeatbeltArgs(policy, ["/bin/sh", "-c", "echo hi"]);

		expect(seatbeltParams(argv, "WRITABLE_ROOT")).toEqual([WORKSPACE, TEMP, `${HOME}/.npm`, `${HOME}/.bun`]);
		expect(seatbeltParams(argv, "PROTECTED")).toEqual([`${WORKSPACE}/.git`]);
		// Same reason as the bwrap ordering check: seatbelt resolves last-rule-wins,
		// so a `(deny …)` emitted before the `(allow file-write* (subpath …))` that
		// covers it is dead text that reads like a protection and is not one.
		const allow = argv[1].lastIndexOf('(param "WRITABLE_ROOT_0")');
		const deny = argv[1].lastIndexOf('(param "PROTECTED_0")');
		expect(deny).toBeGreaterThan(allow);
	});

	test("a cache directory is not treated as a repository", async () => {
		// The `.git` derivation is for every writable root, and adding three roots
		// that are caches would have put `~/.npm/.git` and `<tmpdir>/.git` in the
		// protected list. On Linux that is worse than odd: `readOnlyPathArgs` mounts
		// an *empty read-only directory* at a protected path that does not exist, so
		// each one would create a directory inside the user's temp dir and cache.
		const policy = await bashPolicy({ home: HOME });

		expect(policy.protected).toEqual([`${WORKSPACE}/.git`]);
		// And the cache is genuinely writable, `.git` and all — nothing derives a
		// protection for it from a path that is not a repository.
		expect(decideWrite(policy, `${HOME}/.npm/.git`, WORKSPACE).allowed).toBe(true);
	});

	test("a root the user named by hand still gets its `.git` protected", async () => {
		// `additionalDirectories` is a list of places the agent works, so the entry
		// that is a sibling checkout must be protected exactly as the workspace is.
		// The app does not know which of them that is, and guessing from the path
		// string is the thing this avoids — so it takes the conservative label for
		// all of them and lets an unused protected path cost nothing.
		const policy = await bashPolicy({ home: HOME, configured: [`${HOME}/work/api`, `/srv/build`] });

		expect(policy.protected).toEqual([`${WORKSPACE}/.git`, `${HOME}/work/api/.git`, "/srv/build/.git"]);
		expect(bindTargets(buildBwrapArgs(policy, ["sh"], () => true))).toEqual([
			WORKSPACE,
			`${HOME}/work/api`,
			"/srv/build",
		]);
	});
});

describe("a root that does not exist yet", () => {
	test("the policy still names it, marked so a backend can drop it", async () => {
		// `mkdtemp` directories come and go and `$TMPDIR` can point somewhere that
		// has not been created, so a policy builder that dropped a missing root
		// would break the very command this change exists for. Building the policy
		// does no I/O; the `skip` marker is what tells `resolveSandboxExecution` the
		// path may legitimately be absent.
		const absent = "/tmp/lbb-never-created";
		expect(existsSync(absent)).toBe(false);

		const policy = await bashPolicy({ home: HOME, configured: [absent] });

		const entry = policy.fileSystem.entries.find((candidate) => candidate.path === absent);
		expect(entry).toEqual({ path: absent, access: "write", missingPathBehavior: "skip" });
	});

	test("bwrap drops it rather than binding a source that is not there", async () => {
		// The load-bearing half. `--bind` of an absent source makes bubblewrap
		// refuse to start, so "the policy named it" is not enough — the argv the
		// backend is handed has to be the one it can run.
		const absent = "/tmp/lbb-never-created";
		const policy = await bashPolicy({ home: HOME, configured: [absent] });

		const argv = buildBwrapArgs(policy, ["sh"], () => true);
		expect(bindTargets(argv)).toContain(absent);

		const resolution = resolveSandboxExecution({
			policy,
			command: ["sh"],
			platform: "linux",
			hasNativeBackend: true,
			exists: () => false,
		});
		expect(resolution.kind).toBe("native");
		if (resolution.kind !== "native") return;
		expect(bindTargets(resolution.execution.argv)).not.toContain(absent);
		// The workspace is not marked `skip` and must survive the same filter.
		expect(bindTargets(resolution.execution.argv)).toContain(WORKSPACE);
	});
});

describe("resolveWritableRoots", () => {
	test("the temp directory alone when no home was handed in", () => {
		// There is deliberately no `os.homedir()` fallback here. Omitting `home`
		// means the caller has not said which home it is serving, and answering with
		// the process's own is how CI ended up reading a developer's real config.
		expect(resolveWritableRoots({ tempDir: TEMP })).toEqual([{ path: TEMP, kind: "data" }]);
	});

	test("the temp directory and this user's two package caches", () => {
		// `join` rather than a literal, and deliberately: `resolveWritableRoots`
		// returns the path it will hand to a policy builder, which canonicalises it,
		// so the raw spelling here is the platform's. **The spelling is pinned one
		// level up** — the `describe` blocks above assert canonical `/` literals
		// against the policy itself, which is where a separator regression would
		// actually show.
		expect(resolveWritableRoots({ home: HOME, tempDir: TEMP })).toEqual([
			{ path: TEMP, kind: "data" },
			{ path: join(HOME, ".npm"), kind: "data" },
			{ path: join(HOME, ".bun"), kind: "data" },
		]);
	});

	test("a non-empty configured list replaces the defaults", () => {
		expect(resolveWritableRoots({ home: HOME, tempDir: TEMP, configured: ["/srv/x"] })).toEqual([
			{ path: "/srv/x", kind: "project" },
		]);
	});

	test("an empty one does not — and cannot, because the schema fills it with `[]`", async () => {
		// The one that would have shipped a no-op. `additionalDirectories` is declared
		// with `.default([])`, so this array is what every user who has never touched
		// the key hands us, and `migrate.ts` writes it into the file it produces.
		// Treating it as "nothing may be written outside the workspace" leaves every
		// default install exactly where this change found it.
		//
		// The schema half of that claim is asserted in the coding-agent package,
		// where the schema lives; this side asserts only what the roots come out as.
		const defaults = resolveWritableRoots({ home: HOME, tempDir: TEMP });
		expect(resolveWritableRoots({ home: HOME, tempDir: TEMP, configured: [] })).toEqual(defaults);

		const policy = await bashPolicy({ home: HOME, configured: [] });
		expect(bindTargets(buildBwrapArgs(policy, ["sh"], () => true))).toEqual([
			WORKSPACE,
			TEMP,
			`${HOME}/.npm`,
			`${HOME}/.bun`,
		]);
	});

	test("a configured list of only blanks counts as empty, not as a list of nothing", () => {
		// The rule is "a list that names a *usable* directory replaces the
		// defaults", checked after cleaning rather than before — so no input can leave
		// a session with no writable root outside the workspace at all.
		expect(resolveWritableRoots({ home: HOME, tempDir: TEMP, configured: [""] })).toEqual(
			resolveWritableRoots({ home: HOME, tempDir: TEMP }),
		);
		expect(resolveWritableRoots({ home: HOME, tempDir: TEMP, configured: ["", "/srv/x", ""] })).toEqual([
			{ path: "/srv/x", kind: "project" },
		]);
	});

	test("an empty entry is dropped, and a repeated one is not emitted twice", () => {
		// `""` matters more than it looks: `isWithin` strips trailing slashes and
		// compares with `startsWith`, so a writable entry at `""` would match every
		// absolute path on the machine.
		expect(resolveWritableRoots({ configured: ["", "/srv/x", "/srv/x", "/srv/x/"] })).toEqual([
			{ path: "/srv/x", kind: "project" },
			{ path: "/srv/x/", kind: "project" },
		]);
	});

	test("no entry it returns is ever the empty path, whatever it was handed", () => {
		const roots = resolveWritableRoots({ home: HOME, tempDir: TEMP, configured: ["", "  "] });
		expect(roots.map((root) => (typeof root === "string" ? root : root.path))).not.toContain("");
	});
});

describe("what /permissions says", () => {
	test("the sentence names the roots and where they came from", () => {
		const defaults = describeWritableRoots({ home: HOME, tempDir: TEMP });
		expect(defaults).toContain(TEMP);
		expect(defaults).toContain(join(HOME, ".npm"));
		expect(defaults).toContain("default");

		// A path is not self-describing: `/srv/deploy` means something different
		// depending on whether a user wrote it down or this build chose it.
		const configured = describeWritableRoots({ home: HOME, tempDir: TEMP, configured: ["/srv/deploy"] });
		expect(configured).toContain("/srv/deploy");
		expect(configured).toContain("permissions.additionalDirectories");
		expect(configured).not.toContain(TEMP);
	});

	test("an empty list is not reported as one the user configured", () => {
		// The schema hands every unconfigured user `[]`, so a line that said
		// "from permissions.additionalDirectories" on a machine where the key was
		// never written would read as "here is what you configured", for a list the
		// user has never seen.
		expect(describeWritableRoots({ tempDir: TEMP, configured: [] })).toContain("default");
		expect(describeWritableRoots({ tempDir: TEMP, configured: [] })).not.toContain("permissions");
		expect(describeWritableRoots({ tempDir: TEMP })).toContain("default");
	});

	test("every path it prints is one the policy has", async () => {
		// The line and the policy come from the same function on purpose; this is
		// what fails if someone builds the display from its own list.
		const policy = await bashPolicy({ home: HOME });
		const writable = policy.fileSystem.entries.filter((entry) => entry.access === "write").map((entry) => entry.path);

		for (const path of ["", TEMP, `${HOME}/.npm`, `${HOME}/.bun`]) {
			if (path === "") continue;
			const printed = describeWritableRoots({ home: HOME, tempDir: TEMP }).includes(path);
			expect({ path, printed, writable: writable.includes(path) }).toEqual({ path, printed, writable: true });
		}
	});
});

describe("the temp directory really is the one the process reports", () => {
	test("with no `tempDir` given, the answer is `os.tmpdir()`", () => {
		// The seam has to default to the real thing, or the default-on behaviour
		// this whole change is about would only exist in tests.
		expect(resolveWritableRoots({ home: HOME })[0]).toEqual({ path: tmpdir(), kind: "data" });
	});
});
