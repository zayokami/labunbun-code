/**
 * The protected-path list a confined policy carries.
 *
 * This is the narrowest question the sandbox layer asks — one pure function, no
 * filesystem, no backend — and it is where the protection of `.git` is decided.
 * The list it produces is consumed by three translators that cannot question it:
 * seatbelt turns each path into a trailing `(deny file-write*)`, bwrap into a
 * read-only bind, and the Windows simulated layer into a refusal. A path missing
 * from this list is missing from all three, and nothing downstream will notice.
 *
 * So the property under test is not "a `.git` is protected" — one assertion would
 * do that. It is that the list does not **depend on a scan having found
 * something**. `findProtectedPaths` is a bounded, cached, failure-swallowing walk:
 * depth 4, skips `node_modules`, resolved once per workspace for the life of the
 * process, `[]` on any error. Every one of those is a reasonable limit for
 * *discovering* directories nobody named, and each of them is a way for a
 * workspace that genuinely has a `.git` to end up with none protected.
 *
 * Codex derives the same paths rather than scanning for them
 * (`permissions.rs:2392-2415` builds `.git` / `.agents` / `.codex` per writable
 * root, unconditionally), and that is the model here.
 *
 * Every expectation goes through `join`. The derivation does, so an expectation
 * written with a literal `/` would be asserting a value this function never
 * produces on Windows — green nowhere useful and red everywhere on one platform,
 * which is the same shape as the bug it is meant to catch.
 */
import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import { buildSandboxPolicy } from "../src/sandbox-policy.ts";

const WORKSPACE = "/w/repo";
const CACHE = "/w/.cache/labunbun";

describe("buildSandboxPolicy derives .git rather than waiting to find it", () => {
	test("a workspace with no scan result still has its `.git` protected", () => {
		// The whole point, in the shape that used to be broken. `protectedPaths` is
		// what a scan would have contributed, and it is empty — which is exactly what
		// the scan returns on a machine where it is too deep, runs after the cache was
		// filled, or failed outright. Every one of those produced no protection at
		// all before, because the only source of the list was the thing that failed.
		const policy = buildSandboxPolicy({ sandbox: "workspace-write", workspace: WORKSPACE });

		expect(policy.protected).toEqual([join(WORKSPACE, ".git")]);
	});

	test("each writable root gets its own, so a cache nobody scans is covered too", () => {
		const policy = buildSandboxPolicy({ sandbox: "workspace-write", workspace: WORKSPACE, writableRoots: [CACHE] });

		expect(policy.protected).toEqual([join(WORKSPACE, ".git"), join(CACHE, ".git")]);
	});

	test("a path the scan did find is not listed twice", () => {
		// A git repository lists its own `.git` in the scan result, so the common case
		// is a duplicate. It is cosmetic — the translators would emit the same mount
		// twice — except that every "how many protected paths" assertion in the suite
		// would then be wrong for a reason that is not a behaviour change, which is
		// how a duplicate turns into a test that stops meaning anything.
		const git = join(WORKSPACE, ".git");
		const policy = buildSandboxPolicy({
			sandbox: "workspace-write",
			workspace: WORKSPACE,
			protectedPaths: [git, join(WORKSPACE, ".git", "config")],
		});

		// Order is the scan's, then anything the scan did not find — the derivation
		// adds and does not reorder, so a scan result is never moved by it.
		expect(policy.protected).toEqual([git, join(WORKSPACE, ".git", "config")]);
		expect(policy.protected.filter((path) => path === git)).toHaveLength(1);
	});

	test("an empty root is skipped rather than joined into a bare `.git`", () => {
		// `join("", ".git")` is `.git` — a *relative* path, which every backend
		// matches as a literal and none can resolve. A caller whose workspace failed
		// to canonicalise would otherwise put a relative path in front of a real one
		// and get a mount at the wrong place, and the skip means the list is empty
		// rather than carrying something that cannot be honoured.
		const policy = buildSandboxPolicy({ sandbox: "workspace-write", workspace: "", writableRoots: [""] });

		expect(policy.protected).toEqual([]);
	});

	test("`danger-full-access` derives nothing, because the list would be inert", () => {
		// Not an oversight to be rediscovered: `resolveSandboxExecution`
		// short-circuits on an unrestricted policy and wraps nothing, so a protected
		// path here would be read by nobody. The tool layer is still in force in this
		// mode and refuses `.git` by matching the path rather than by consulting a
		// list, so the protection exists — just not here, and putting it here would
		// mean moving it somewhere that stops being read.
		const policy = buildSandboxPolicy({ sandbox: "danger-full-access", workspace: WORKSPACE });

		expect(policy.protected).toEqual([]);
		expect(policy.fileSystem.kind).toBe("unrestricted");
	});

	test("read-only roots are not given a `.git`, because nothing can write one", () => {
		// A `read` entry never produces a writable mount, so a protected path inside
		// it defends nothing that is not already defended — and every extra path is a
		// mount bwrap has to make. Codex derives per *writable* root for the same
		// reason (`permissions.rs:2392-2415` iterates the writable set).
		const policy = buildSandboxPolicy({
			sandbox: "workspace-write",
			workspace: WORKSPACE,
			readOnlyRoots: ["/tmp/labunbun-spill"],
		});

		expect(policy.protected).toEqual([join(WORKSPACE, ".git")]);
	});

	test("the derived path is joined, not concatenated, so it matches what the backends compare", () => {
		// `join` is what produces the separator. A hand-built `` `${root}/.git` ``
		// would be right on POSIX and produce a mixed-separator path on Windows —
		// `\w\repo/.git` — which the seatbelt translator and the simulated layer
		// would then compare against a root that came from `resolveCanonical` and
		// spell differently. A `protected` entry that does not match its own root is
		// a protection that never fires, and the mismatch is invisible in the argv
		// because both sides still name the same directory.
		const policy = buildSandboxPolicy({ sandbox: "workspace-write", workspace: WORKSPACE });

		expect(policy.protected).toEqual([join(WORKSPACE, ".git")]);

		// The mixed-separator shape only *exists* where the separator differs from the
		// template's `/`. On POSIX a templated `.git` and a joined one are the same
		// string, so the defect is unrepresentable there and asserting it anyway would
		// be a test that passes on one platform by coincidence and fails on another by
		// accident — which is what the first version of this test did, and what CI's
		// ubuntu and macos jobs caught on 7c87a06 while Windows stayed green. So the
		// Windows-only half is stated conditionally, and the unconditional assertion
		// above is the one that has to hold everywhere.
		if (sep !== "/") {
			expect(policy.protected[0]).not.toContain("/");
			expect(policy.protected[0]).not.toBe(`${WORKSPACE}/.git`);
		}
	});
});
