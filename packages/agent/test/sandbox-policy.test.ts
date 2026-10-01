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
 * The paths are derived rather than left to the scan, and that is the model here.
 *
 * Every expectation is a **literal** in the canonical `/` spelling, and that is the
 * invariant rather than a workaround: the derivation normalises what it emits, so
 * the value is the same string on every platform and a test can say what the
 * policy must contain instead of re-deriving it with whatever `join` happens to
 * produce on the machine running it. An expectation written through `join` was
 * the previous convention here, and it is what let a Windows-only fail-open
 * through `isWritePermitted` sit in the suite green — the expectation agreed
 * with the bug because both used the same non-canonical spelling.
 */
import { describe, expect, test } from "bun:test";
import { buildSandboxPolicy, isWritePermitted } from "../src/sandbox-policy.ts";

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

		expect(policy.protected).toEqual([`${WORKSPACE}/.git`]);
	});

	test("each writable root gets its own, so a cache nobody scans is covered too", () => {
		const policy = buildSandboxPolicy({ sandbox: "workspace-write", workspace: WORKSPACE, writableRoots: [CACHE] });

		expect(policy.protected).toEqual([`${WORKSPACE}/.git`, `${CACHE}/.git`]);
	});

	test("a path the scan did find is not listed twice", () => {
		// A git repository lists its own `.git` in the scan result, so the common case
		// is a duplicate. It is cosmetic — the translators would emit the same mount
		// twice — except that every "how many protected paths" assertion in the suite
		// would then be wrong for a reason that is not a behaviour change, which is
		// how a duplicate turns into a test that stops meaning anything.
		const git = `${WORKSPACE}/.git`;
		const policy = buildSandboxPolicy({
			sandbox: "workspace-write",
			workspace: WORKSPACE,
			protectedPaths: [git, `${WORKSPACE}/.git/config`],
		});

		// Order is the scan's, then anything the scan did not find — the derivation
		// adds and does not reorder, so a scan result is never moved by it.
		expect(policy.protected).toEqual([git, `${WORKSPACE}/.git/config`]);
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
		// mount bwrap has to make. The derivation iterates the writable set, for
		// exactly that reason.
		const policy = buildSandboxPolicy({
			sandbox: "workspace-write",
			workspace: WORKSPACE,
			readOnlyRoots: ["/tmp/labunbun-spill"],
		});

		expect(policy.protected).toEqual([`${WORKSPACE}/.git`]);
	});

	test("the derived path is spelled canonically, so it matches what the backends compare", () => {
		// The property is not "not mixed" — it is "the same string everywhere, and
		// it is the spelling the comparisons use".
		//
		// This test previously asserted the opposite. It required the derived `.git`
		// to carry `\` on Windows, on the reasoning that `join` is what produces the
		// separator and a hand-built `` `${root}/.git` `` would mix them into
		// `\w\repo/.git`. The mixed shape is real and was worth avoiding, but the
		// cure was wrong: every consumer compares against a path resolved by
		// `resolveCanonical`, which normalises every separator to `/`, so a
		// pure-backslash root does not match either. Measured on Windows before the
		// fix, with the workspace spelled both ways: `isWritePermitted` returned
		// `true` for `<ws>/.git/config`, because the protected entry missed and the
		// writable entry matched — the protection failing open, which is the one
		// direction this whole file exists to rule out. The expectation agreed with
		// the bug because it was written through the same `join`.
		//
		// So the invariant is now unconditional and platform-independent: whatever
		// the caller passes, the policy emits `/`. A backslash input is the case
		// that proves it, because on POSIX it is the identity and the assertion
		// would pass by coincidence — which is how the previous version stayed green
		// on ubuntu and macos while Windows failed to enforce anything.
		const policy = buildSandboxPolicy({ sandbox: "workspace-write", workspace: WORKSPACE });

		expect(policy.protected).toEqual([`${WORKSPACE}/.git`]);

		const windowsShaped = buildSandboxPolicy({ sandbox: "workspace-write", workspace: "C:\\w\\repo" });
		expect(windowsShaped.protected).toEqual(["C:/w/repo/.git"]);
		expect(windowsShaped.fileSystem.entries.map((entry) => entry.path)).toEqual(["C:/w/repo"]);

		// And the comparison the whole thing exists for, on a Windows-shaped policy
		// with a canonical candidate — the exact pair that used to fail open.
		expect(isWritePermitted(windowsShaped, "C:/w/repo/.git/config")).toBe(false);
		expect(isWritePermitted(windowsShaped, "C:/w/repo/src/index.ts")).toBe(true);
	});
});
