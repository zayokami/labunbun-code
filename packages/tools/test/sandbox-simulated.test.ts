/**
 * The Windows half of the filesystem sandbox — which is a decision this process
 * makes, not an OS mechanism, and these are the tests that hold it to that.
 *
 * Every case that depends on filesystem behaviour uses a real temporary tree
 * built with `mkdtemp`, because a fictional path cannot demonstrate what a
 * symlink or a junction does. Every case that depends on *case* rules passes an
 * explicit `platform`, so the Windows answer and the POSIX answer are both
 * checkable from either machine — a test that skips itself on the machine it
 * runs on reports green without having checked anything, and the whole point of
 * a `platform` parameter is that the answer is the same on both.
 *
 * The fixtures are `/work/project` and `C:/work/project` by platform for the
 * same reason `containment.test.ts` uses them: `resolveCanonical` resolves
 * against the real filesystem, and a path that cannot be enumerated here is
 * still a valid string to it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxPolicy, isWritePermitted, type SandboxPolicy } from "@labunbun/agent";
import { caseInsensitivePaths, isContainedIn, normalizePathSeparators, resolveCanonical } from "../src/containment.ts";
import { DEFAULT_PROTECTED_SCAN_DEPTH, findProtectedPaths } from "../src/sandbox/protected-paths.ts";
import {
	caseInsensitiveSandboxPaths,
	decideRead,
	decideWrite,
	describeSimulatedSandbox,
	SIMULATED_SANDBOX_DISCLAIMER,
} from "../src/sandbox/simulated.ts";

const WORKSPACE = process.platform === "win32" ? "C:/work/project" : "/work/project";
const OUTSIDE = process.platform === "win32" ? "C:/work/other" : "/work/other";
const READ_ONLY_ROOT = process.platform === "win32" ? "C:/work/spill" : "/work/spill";
const WRITABLE_ROOT = process.platform === "win32" ? "C:/work/cache" : "/work/cache";

interface PolicyOverrides {
	protectedPaths?: string[];
	readOnlyRoots?: string[];
	writableRoots?: string[];
	sandbox?: "workspace-write" | "danger-full-access";
}

/** The policy `workspace-write` produces, with the roots spelled out per test. */
function policyFor(overrides: PolicyOverrides = {}): SandboxPolicy {
	return buildSandboxPolicy({
		sandbox: overrides.sandbox ?? "workspace-write",
		workspace: WORKSPACE,
		protectedPaths: overrides.protectedPaths,
		readOnlyRoots: overrides.readOnlyRoots,
		writableRoots: overrides.writableRoots,
	});
}

describe("decideWrite: danger-full-access", () => {
	// The mode means "no policy", and the code has to say so rather than run a
	// check that happens to pass. If this branch were removed and the rules
	// below consulted anyway, the path outside every root would be denied and
	// this test would go red — which is the point of asserting that it is allowed.
	test("allows a path no root covers, because no rule is consulted at all", () => {
		const decision = decideWrite(policyFor({ sandbox: "danger-full-access" }), `${OUTSIDE}/anything.txt`, WORKSPACE);
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toBeUndefined();
	});

	test("allows .git, and the policy that allowed it is the one that dropped the protected list", () => {
		// Passing `protectedPaths` and having them ignored is the contract:
		// `danger-full-access` is the absence of a policy, not a policy that
		// happens to permit everything. Asserted on the policy so this cannot pass
		// by accident if the decision code ever stops consulting it.
		const policy = policyFor({ sandbox: "danger-full-access", protectedPaths: [`${WORKSPACE}/.git`] });
		expect(policy.protected).toEqual([]);
		expect(decideWrite(policy, ".git/config", WORKSPACE).allowed).toBe(true);
	});

	test("still canonicalises, so the caller is told where the path really landed", () => {
		const decision = decideWrite(policyFor({ sandbox: "danger-full-access" }), "src/../src/../README.md", WORKSPACE);
		expect(decision.allowed).toBe(true);
		expect(decision.canonicalPath).toBe(`${WORKSPACE}/README.md`);
	});
});

describe("decideWrite: inside the workspace", () => {
	test("allows an ordinary file and the workspace root itself", () => {
		expect(decideWrite(policyFor(), "src/index.ts", WORKSPACE)).toEqual({
			allowed: true,
			reason: undefined,
			canonicalPath: `${WORKSPACE}/src/index.ts`,
		});
		expect(decideWrite(policyFor(), ".", WORKSPACE).canonicalPath).toBe(WORKSPACE);
	});

	test("allows a second writable root outside the workspace", () => {
		const policy = policyFor({ writableRoots: [WRITABLE_ROOT] });
		expect(decideWrite(policy, `${WRITABLE_ROOT}/build/out.js`, WORKSPACE).allowed).toBe(true);
	});
});

describe("decideWrite: the denials name a rule and a resolved path", () => {
	test("refuses a path outside every root, and the reason says which roots exist", () => {
		const decision = decideWrite(policyFor(), `${OUTSIDE}/x.ts`, WORKSPACE);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("not inside any root this policy allows writing");
		expect(decision.reason).toContain(`${OUTSIDE}/x.ts`);
		expect(decision.reason).toContain(WORKSPACE);
	});

	// A read-only root and an unknown path are different failures with different
	// fixes. Collapsing them into one "not allowed" is what sends a user looking
	// at their allow rules instead of at the directory they made read-only.
	test("names a read-only root differently from an unknown path", () => {
		const policy = policyFor({ readOnlyRoots: [READ_ONLY_ROOT] });
		const readOnly = decideWrite(policy, `${READ_ONLY_ROOT}/turns.json`, WORKSPACE);
		expect(readOnly.allowed).toBe(false);
		expect(readOnly.reason).toContain("readable but not writable");
		expect(readOnly.reason).toContain(READ_ONLY_ROOT);

		const unknown = decideWrite(policy, `${OUTSIDE}/x.ts`, WORKSPACE);
		expect(unknown.reason).toContain("not inside any root");
		expect(unknown.reason).not.toContain(READ_ONLY_ROOT);
	});

	test("refuses a protected .git and names the protected directory", () => {
		const policy = policyFor({ protectedPaths: [`${WORKSPACE}/.git`] });
		const decision = decideWrite(policy, ".git/config", WORKSPACE);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("version-control metadata");
		expect(decision.reason).toContain(`${WORKSPACE}/.git`);
		expect(decision.canonicalPath).toBe(`${WORKSPACE}/.git/config`);
	});

	test("refuses a nested repository's .git, not only the top-level one", () => {
		const policy = policyFor({ protectedPaths: [`${WORKSPACE}/vendor/lib/.git`] });
		expect(decideWrite(policy, "vendor/lib/.git/HEAD", WORKSPACE).allowed).toBe(false);
		// The surrounding source is still writable. A protected path that swallowed
		// its whole parent would be a different, much larger refusal.
		expect(decideWrite(policy, "vendor/lib/index.ts", WORKSPACE).allowed).toBe(true);
	});

	// The protected list is consulted before the writable roots, so an allow
	// covering the same path cannot win. Removing that ordering turns this red.
	test("a protected path beats a writable root that covers it", () => {
		const policy = buildSandboxPolicy({
			sandbox: "workspace-write",
			workspace: WORKSPACE,
			protectedPaths: [`${WORKSPACE}/.git`],
			writableRoots: [WORKSPACE],
		});
		expect(decideWrite(policy, ".git/HEAD", WORKSPACE).allowed).toBe(false);
	});
});

describe("decideWrite: the candidate is canonicalised, not string-matched", () => {
	const TRAVERSAL: Array<[given: string, label: string, expected: string]> = [
		["sub/../.git/config", "a .. that lands in .git", `${WORKSPACE}/.git/config`],
		["./././.git/hooks/pre-commit", "repeated ./ segments", `${WORKSPACE}/.git/hooks/pre-commit`],
		["a/b/../../.git", "a buried .. that climbs into .git", `${WORKSPACE}/.git`],
		["sub/../../other/x.ts", "a .. that leaves the workspace", `${OUTSIDE}/x.ts`],
	];

	for (const [given, label, expected] of TRAVERSAL) {
		test(`refuses ${label}`, () => {
			const policy = policyFor({ protectedPaths: [`${WORKSPACE}/.git`] });
			const decision = decideWrite(policy, given, WORKSPACE);
			expect(decision.allowed).toBe(false);
			expect(decision.canonicalPath).toBe(expected);
			// A deny with no reason is indistinguishable from a bug, so the reason
			// is asserted on every denial rather than only on the interesting ones.
			expect(decision.reason).toBeTruthy();
		});
	}

	test("a backslash path resolves the same as the forward-slash spelling", () => {
		const policy = policyFor({ protectedPaths: [`${WORKSPACE}/.git`] });
		const decision = decideWrite(policy, "sub\\..\\.git\\config", WORKSPACE);
		expect(decision.allowed).toBe(false);
		expect(decision.canonicalPath).toBe(`${WORKSPACE}/.git/config`);
	});

	// A root that arrives with Windows separators must still match the
	// forward-slash path this layer resolved. Without separator normalisation
	// every write in the workspace would be denied, which is the safe direction
	// to fail and still a failure.
	test("a writable root spelled with backslashes still matches", () => {
		const backslashed = process.platform === "win32" ? `${WORKSPACE}\\` : WORKSPACE;
		expect(decideWrite(policyFor({ writableRoots: [backslashed] }), "src/x.ts", WORKSPACE).allowed).toBe(true);
	});
});

describe("decideWrite: case, decided by the platform and not by the machine", () => {
	// Both answers below are reachable from either machine. On a case-sensitive
	// filesystem `Repo` and `repo` are different directories and folding would
	// accept a path that only *spells* like one inside the root; on a
	// case-insensitive one, not folding would let `.GIT/config` past a `.git`
	// rule, which is the direction this layer is not allowed to fail in.
	test("on a case-insensitive filesystem, a differently-spelled protected path is refused", () => {
		const policy = policyFor({ protectedPaths: [`${WORKSPACE}/.git`] });
		const decision = decideWrite(policy, `${WORKSPACE}/.GIT/config`, WORKSPACE, { platform: "win32" });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("version-control metadata");
	});

	test("on a case-insensitive filesystem, a differently-spelled writable root is allowed", () => {
		expect(
			decideWrite(policyFor(), `${WORKSPACE.toUpperCase()}/src/x.ts`, WORKSPACE, { platform: "win32" }).allowed,
		).toBe(true);
	});

	test("on a case-sensitive filesystem, the same spelling is not inside the root", () => {
		// The policy root is lowercase; the candidate differs only in case. There
		// is no such directory on that filesystem, so there is no write to permit.
		const decision = decideWrite(policyFor(), `${WORKSPACE.toUpperCase()}/src/x.ts`, WORKSPACE, { platform: "linux" });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("not inside any root");
	});

	test("the case rule names macOS, and an unknown platform is case-sensitive", () => {
		// macOS is the easy one to get wrong: APFS is case-insensitive by default,
		// and a build that treated a Mac as case-sensitive would let `.GIT/config`
		// past a `.git` rule on the platform where that costs a user their history.
		expect(caseInsensitiveSandboxPaths("win32")).toBe(true);
		expect(caseInsensitiveSandboxPaths("darwin")).toBe(true);
		expect(caseInsensitiveSandboxPaths("linux")).toBe(false);
		// Unnamed platforms take the rule that refuses more.
		expect(caseInsensitiveSandboxPaths("freebsd")).toBe(false);
		expect(caseInsensitiveSandboxPaths("win32")).toBe(caseInsensitivePaths || process.platform !== "win32");
	});
});

describe("decideWrite: agrees with the lexical fallback beside it", () => {
	// `isWritePermitted` in @labunbun/agent is the same rule judged without
	// touching the filesystem, and it deliberately does not fold case. On inputs
	// where the two case rules agree, the two must return the same verdict; if
	// either were changed to answer a different question, this goes red.
	const hostPlatform = caseInsensitivePaths ? "win32" : "linux";
	// A root in the spelling this machine can resolve. `/w/p` is a valid string
	// to `isContainedIn` but not to `resolveCanonical`, which resolves against
	// the real filesystem and a leading slash means the drive's current
	// directory on Windows.
	const BASE = process.platform === "win32" ? "C:/w" : "/w";
	const P = `${BASE}/p`;
	const TABLE: Array<[candidate: string, root: string, expected: boolean]> = [
		["p/src/index.ts", P, true],
		[P, P, true],
		[`${P}/src/index.ts`, P, true],
		[`${P}2/src/index.ts`, P, false],
		[`${P}-evil/src/index.ts`, P, false],
		[`${BASE}/q/src/index.ts`, P, false],
		[`${P}/src`, `${P}/`, true],
	];

	for (const [candidate, root, expected] of TABLE) {
		test(`'${candidate}' in '${root}' is ${expected}, as both implementations say`, () => {
			const policy = buildSandboxPolicy({ sandbox: "workspace-write", workspace: root });
			const resolved = resolveCanonical(candidate, BASE);
			expect(isContainedIn(resolved, root)).toBe(expected);
			expect(decideWrite(policy, candidate, BASE, { platform: hostPlatform }).allowed).toBe(expected);
			expect(isWritePermitted(policy, resolved)).toBe(expected);
		});
	}
});

describe("decideRead", () => {
	const policy = policyFor({ readOnlyRoots: [READ_ONLY_ROOT], protectedPaths: [`${WORKSPACE}/.git`] });

	test("allows the workspace and a read-only root", () => {
		expect(decideRead(policy, "src/index.ts", WORKSPACE).allowed).toBe(true);
		expect(decideRead(policy, `${READ_ONLY_ROOT}/turns.json`, WORKSPACE).allowed).toBe(true);
	});

	// Reading history is ordinary work, which is why `guardWritablePath` refuses
	// it for writes and leaves reads alone. Applying the protected list to reads
	// would make `.git/log` unreadable and would be a different rule from the one
	// the tool layer enforces.
	test("does not apply the .git protection, because that rule is about writes", () => {
		expect(decideRead(policy, ".git/log/HEAD", WORKSPACE).allowed).toBe(true);
	});

	test("refuses a path outside every root, naming the roots that do exist", () => {
		const decision = decideRead(policy, `${OUTSIDE}/x.ts`, WORKSPACE);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("not inside any root this policy allows reading");
		expect(decision.reason).toContain(WORKSPACE);
	});

	test("is unrestricted under danger-full-access, like the write decision", () => {
		expect(decideRead(policyFor({ sandbox: "danger-full-access" }), `${OUTSIDE}/x.ts`, WORKSPACE).allowed).toBe(true);
	});
});

describe("describeSimulatedSandbox", () => {
	test("says plainly that danger-full-access runs no check", () => {
		const line = describeSimulatedSandbox(policyFor({ sandbox: "danger-full-access" }));
		expect(line).toContain("danger-full-access");
		expect(line).toContain("no path check runs");
	});

	// The line is what a user forms their model of the sandbox from, and a
	// softened version — "sandboxed", "confined", with nothing after it — is how a
	// tool-layer check ends up reading as a kernel one. Asserted on the exact
	// sentence rather than on a summary of it.
	test("carries the disclaimer verbatim, whatever the counts are", () => {
		for (const policy of [
			policyFor(),
			policyFor({ writableRoots: [WRITABLE_ROOT], readOnlyRoots: [READ_ONLY_ROOT], protectedPaths: ["x"] }),
		]) {
			const line = describeSimulatedSandbox(policy);
			expect(line).toContain(SIMULATED_SANDBOX_DISCLAIMER);
			expect(line).toContain("no OS mechanism is enforcing this");
			expect(line).toContain("not subject to it");
		}
	});

	test("counts the roots and the protected paths, and pluralises them", () => {
		const one = describeSimulatedSandbox(policyFor({ protectedPaths: [`${WORKSPACE}/.git`] }));
		expect(one).toContain("1 writable root");
		expect(one).toContain("1 protected path");

		const two = describeSimulatedSandbox(
			policyFor({ writableRoots: [WRITABLE_ROOT], readOnlyRoots: [READ_ONLY_ROOT] }),
		);
		expect(two).toContain("2 writable roots");
		expect(two).toContain("1 read-only root");
	});
});

describe("decideWrite: on a real filesystem with real links", () => {
	// The whole reason the candidate is canonicalised before it is compared.
	// Every path here *spells* like it is inside the workspace and none of them
	// is; if the decision string-matched the input, all three would be allowed.
	test("a link to .git does not launder a write into version-control metadata", async () => {
		await withWorkspace(({ workspace }) => {
			mkdirSync(join(workspace, ".git"), { recursive: true });
			linkDir(join(workspace, ".git"), join(workspace, "innocent-looking"));
			const policy = buildSandboxPolicy({
				sandbox: "workspace-write",
				workspace,
				protectedPaths: [`${workspace}/.git`],
			});
			const decision = decideWrite(policy, "innocent-looking/config", workspace);
			expect(decision.allowed).toBe(false);
			expect(decision.canonicalPath).toBe(`${workspace}/.git/config`);
			expect(decision.reason).toContain("version-control metadata");
		});
	});

	test("a link out of the workspace does not launder a write either", async () => {
		await withWorkspace(({ workspace, outer }) => {
			mkdirSync(join(outer, "outside"), { recursive: true });
			writeFileSync(join(outer, "outside", "secret.txt"), "not yours\n");
			linkDir(join(outer, "outside"), join(workspace, "escape"));
			const decision = decideWrite(
				buildSandboxPolicy({ sandbox: "workspace-write", workspace }),
				"escape/secret.txt",
				workspace,
			);
			expect(decision.allowed).toBe(false);
			expect(decision.reason).toContain("not inside any root");
		});
	});

	// The control for the two above: a link is not a reason to refuse everything,
	// and a test suite that only ever ran the refusing cases would not notice if
	// the canonicalisation were replaced with a blanket deny.
	test("a link to a directory inside the workspace still resolves and is allowed", async () => {
		await withWorkspace(({ workspace }) => {
			mkdirSync(join(workspace, "real"), { recursive: true });
			linkDir(join(workspace, "real"), join(workspace, "alias"));
			const decision = decideWrite(
				buildSandboxPolicy({ sandbox: "workspace-write", workspace }),
				"alias/index.ts",
				workspace,
			);
			expect(decision.allowed).toBe(true);
			expect(decision.canonicalPath).toBe(`${workspace}/real/index.ts`);
		});
	});

	// `.git` is protected as a *directory*, and a nested repository's link to its
	// own metadata is the case `guardWritablePath` covers by segment name. Both
	// are worth pinning on the same fixture: the policy names the canonical
	// target, and a write spelled through a link has to land on it.
	test("a nested repository's .git is refused through a link that points at it", async () => {
		await withWorkspace(({ workspace }) => {
			mkdirSync(join(workspace, "vendor", "lib", ".git"), { recursive: true });
			linkDir(join(workspace, "vendor", "lib", ".git"), join(workspace, "vendor", "lib", "hookdir"));
			const policy = buildSandboxPolicy({
				sandbox: "workspace-write",
				workspace,
				protectedPaths: [`${workspace}/vendor/lib/.git`],
			});
			expect(decideWrite(policy, "vendor/lib/hookdir/hooks/pre-commit", workspace).allowed).toBe(false);
		});
	});
});

// ── the walk, and the decision on a real filesystem ─────────────────────────
// These build a real tree, because the point of the scan is what the filesystem
// does with a link, a gitfile, and a directory nobody can enumerate.
function linkDir(target: string, linkPath: string): void {
	symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

/** The spelling `mkdtemp` hands back is not always the spelling on disk. */
function canon(path: string): string {
	return normalizePathSeparators(realpathSync(path).replace(/^\\\\\?\\/, ""));
}

interface Scanned {
	/** The workspace, in the spelling the filesystem actually uses. */
	workspace: string;
	/** The parent's own directory, for fixtures that must sit outside the tree. */
	outer: string;
	found: string[];
}

/**
 * Build a throwaway tree, hand it to `build`, and remove it whatever happens.
 *
 * `build` may be async and is awaited before the cleanup, because a cleanup
 * that runs first turns every assertion below into a check of a directory that
 * is already gone — which fails in a way that looks like a walk bug.
 *
 * The workspace is created in the spelling the filesystem actually uses, which
 * is not always the spelling `mkdtemp` hands back — macOS's `tmpdir()` is
 * `/var/folders/…` while its real path is `/private/var/folders/…`, and Windows
 * can hand back a `\\?\` prefix. Both this layer and these tests resolve before
 * they compare, so a mismatch here is a real mismatch and not a fixture that
 * quietly agrees with the code it is meant to check.
 */
async function withWorkspace<T>(build: (paths: Omit<Scanned, "found">) => T | Promise<T>): Promise<T> {
	const outer = mkdtempSync(join(tmpdir(), "lbb-sandbox-"));
	try {
		const created = join(outer, "workspace");
		mkdirSync(created, { recursive: true });
		return await build({ workspace: canon(created), outer });
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
}

/** Build a throwaway tree, scan it, and remove it whatever the test does. */
async function scan(build: (scanned: Omit<Scanned, "found">) => void | Promise<void>): Promise<Scanned> {
	return withWorkspace(async ({ workspace, outer }) => {
		await build({ workspace, outer });
		return { workspace, outer, found: await findProtectedPaths(workspace) };
	});
}

/** `workspace/a/b/c/…/.git` — the directory, created, returned canonical. */
function nestedGit(workspace: string, segments: string[]): string {
	const dir = segments.reduce((at, segment) => join(at, segment), workspace);
	mkdirSync(join(dir, ".git"), { recursive: true });
	return `${workspace}/${segments.join("/")}/.git`;
}

describe("findProtectedPaths", () => {
	test("finds the workspace's own .git and returns it canonical", async () => {
		const { workspace, found } = await scan(({ workspace: ws }) => {
			mkdirSync(join(ws, ".git"));
		});
		expect(found).toEqual([`${workspace}/.git`]);
		// Canonical means forward slashes with no `\\?\` prefix, because the
		// decision layer compares against paths it canonicalised the same way and
		// an entry that does not compare equal protects nothing.
		expect(found[0]).not.toContain("\\");
	});

	test("finds a nested repository's .git, which is as unrecoverable as the top-level one", async () => {
		const { workspace, found } = await scan(({ workspace: ws }) => {
			mkdirSync(join(ws, "vendor", "lib", ".git"), { recursive: true });
			mkdirSync(join(ws, "apps", "web", ".git"), { recursive: true });
		});
		expect(found).toEqual([`${workspace}/apps/web/.git`, `${workspace}/vendor/lib/.git`]);
	});

	// A worktree or a submodule stores `gitdir: …` in a *file* named `.git`. A
	// scan that only looked for the directory would protect every repository in
	// the tree and miss every linked one — and a linked worktree is where a `rm`
	// does the most damage per keystroke.
	test("finds a .git that is a file, the shape a worktree or submodule uses", async () => {
		const { workspace, found } = await scan(({ workspace: ws }) => {
			mkdirSync(join(ws, "wt"), { recursive: true });
			writeFileSync(join(ws, "wt", ".git"), "gitdir: /somewhere/else/.git/worktrees/wt\n");
		});
		expect(found).toEqual([`${workspace}/wt/.git`]);
	});

	test("records a .git directory once and does not walk into it", async () => {
		const { workspace, found } = await scan(({ workspace: ws }) => {
			mkdirSync(join(ws, ".git", "modules", "nested", ".git"), { recursive: true });
		});
		expect(found).toEqual([`${workspace}/.git`]);
	});

	test("stops at the depth bound, and the bound is the documented one", async () => {
		const { workspace, found } = await scan(({ workspace: ws }) => {
			nestedGit(ws, ["a", "b", "c", "d"]);
			nestedGit(ws, ["a", "b", "c", "d", "e"]);
		});
		// Four directory levels is the default: `a/b/c/d/.git` is found and
		// `a/b/c/d/e/.git` is not. A repository below the bound is a write the
		// policy does not protect, which is why the bound is stated in the
		// module's own doc comment rather than left to be discovered.
		expect(DEFAULT_PROTECTED_SCAN_DEPTH).toBe(4);
		expect(found).toEqual([`${workspace}/a/b/c/d/.git`]);
	});

	test("a deeper bound finds the deeper repository", async () => {
		const outer = mkdtempSync(join(tmpdir(), "lbb-protected-"));
		try {
			const created = join(outer, "workspace");
			mkdirSync(created, { recursive: true });
			const workspace = canon(created);
			const deep = nestedGit(workspace, ["a", "b", "c", "d", "e"]);
			expect(await findProtectedPaths(workspace)).toEqual([]);
			expect(await findProtectedPaths(workspace, 6)).toEqual([deep]);
		} finally {
			rmSync(outer, { recursive: true, force: true });
		}
	});

	// The link-escape check is the reason the walk resolves before it compares. A
	// lexical walk steps through a link out of the workspace and keeps going, and
	// a `.git` on the far side of that link is not the user's.
	test("does not follow a link out of the workspace", async () => {
		const { workspace, found } = await scan(({ workspace: ws, outer }) => {
			mkdirSync(join(outer, "outside", ".git"), { recursive: true });
			linkDir(join(outer, "outside"), join(ws, "escape"));
			mkdirSync(join(ws, "real", ".git"), { recursive: true });
		});
		expect(found).toEqual([`${workspace}/real/.git`]);
	});

	test("follows a link that stays inside the workspace, visiting it once", async () => {
		const { workspace, found } = await scan(({ workspace: ws }) => {
			mkdirSync(join(ws, "real", ".git"), { recursive: true });
			linkDir(join(ws, "real"), join(ws, "alias"));
			linkDir(join(ws, "real"), join(ws, "alias2"));
		});
		expect(found).toEqual([`${workspace}/real/.git`]);
	});

	test("a link that loops does not hang the scan", async () => {
		const { workspace, found } = await scan(({ workspace: ws }) => {
			mkdirSync(join(ws, "real", ".git"), { recursive: true });
			linkDir(join(ws, "real"), join(ws, "real", "loop"));
		});
		expect(found).toEqual([`${workspace}/real/.git`]);
	});

	// A symlink to a file reports `isSymbolicLink`, not `isDirectory`. Treating
	// it as a directory would mean readdir on it, and a scan whose results depend
	// on which errno it hit is not one that can be reasoned about.
	test("a link to a file is not walked into", async () => {
		const { workspace, found } = await scan(({ workspace: ws }) => {
			mkdirSync(join(ws, "real", ".git"), { recursive: true });
			writeFileSync(join(ws, "notes.txt"), "x\n");
			symlinkSync(join(ws, "notes.txt"), join(ws, "link-to-file"));
		});
		expect(found).toEqual([`${workspace}/real/.git`]);
	});

	test("skips node_modules by default and scans it when asked", async () => {
		const { found } = await scan(({ workspace: ws }) => {
			nestedGit(ws, ["node_modules", "vendored"]);
		});
		expect(found).toEqual([]);

		const outer = mkdtempSync(join(tmpdir(), "lbb-protected-"));
		try {
			const created = join(outer, "workspace");
			mkdirSync(created, { recursive: true });
			const workspace = canon(created);
			const vendored = nestedGit(workspace, ["node_modules", "vendored"]);
			expect(await findProtectedPaths(workspace, 4, { skipDirs: new Set() })).toEqual([vendored]);
		} finally {
			rmSync(outer, { recursive: true, force: true });
		}
	});

	// The scan is the input to a policy, so failing to build one confines
	// nothing. readdir on something that is not a directory is the
	// cross-platform way to reach the catch — it throws on every machine, unlike
	// an ACL, which `chmod` cannot produce on Windows at all.
	test("returns nothing rather than throwing when the root cannot be enumerated", async () => {
		const outer = mkdtempSync(join(tmpdir(), "lbb-protected-"));
		try {
			const file = join(outer, "a-regular-file.txt");
			writeFileSync(file, "not a directory\n");
			expect(await findProtectedPaths(canon(file))).toEqual([]);
			expect(await findProtectedPaths(join(outer, "does-not-exist"))).toEqual([]);
		} finally {
			rmSync(outer, { recursive: true, force: true });
		}
	});

	// A junction to a target inside the workspace that is not there. It is
	// skipped rather than followed, and the repositories beside it are still
	// reported — the observable half of "skip it, do not throw".
	test("a broken part of the tree does not cost the rest of the scan", async () => {
		const { workspace, found } = await scan(({ workspace: ws }) => {
			nestedGit(ws, ["good"]);
			linkDir(join(ws, "target-that-does-not-exist"), join(ws, "broken"));
		});
		expect(found).toEqual([`${workspace}/good/.git`]);
	});
});
