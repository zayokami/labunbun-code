/**
 * Finding the `.git` directories inside a workspace, so they can go into
 * `SandboxPolicy.protected`.
 *
 * **The gap this closes is measured, not theoretical.** Before the simulated
 * layer existed, with no sandbox rules configured, `agent` mode let all three of
 * these through Bash:
 *
 *   allow   rm .git/config
 *   allow   mv .git /tmp/x
 *   allow   echo x > .git/hooks/pre-commit
 *
 * The `.git` guard in `packages/tools/src/containment.ts` stops Edit and Write
 * and nothing else — Bash walks straight past it. (`rm -rf .git` *is* refused,
 * but by the dangerous-command classifier catching the `-rf`, not by any `.git`
 * rule.) So the discovery here is for the *shell* policy, which is the one the
 * tool layer's own guard cannot produce. On macOS and Linux that policy becomes
 * a real kernel confinement. On Windows it does not: `resolveSandboxExecution`
 * reports `simulated`, and `exec` wraps the shell only for a `native`
 * resolution, so the protected list is built, handed to `exec`, and dropped there
 * unread. The gap above therefore stands on this platform exactly as measured —
 * `echo x > .git/hooks/pre-commit` through Bash still lands — so this scan
 * neither narrows nor closes it here. The sentence in `describeSandboxBackend`
 * is the one that tells the user so.
 *
 * Two shapes of `.git` are both real and both must be found:
 *
 *   a **directory** in an ordinary checkout, and
 *   a **file** in a worktree or a submodule, where the file is a `gitdir: …`
 *   pointer. A scan that only looked for the directory would protect every
 *   repository in the tree and miss every linked one — and a linked worktree is
 *   exactly where a `rm` does the most damage per keystroke.
 *
 * A nested repository (submodule, vendored checkout) has its own `.git` and is
 * just as unrecoverable as the top-level one, so the walk does not stop at the
 * first hit.
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isContainedIn, resolveCanonical } from "../containment.ts";

/**
 * The deepest directory whose entries this scan examines.
 *
 * A bound, not a tuning knob: the work is proportional to the tree rather than to
 * the number of repositories in it, and a monorepo has tens of thousands of
 * directories. The cost it actually saves is measured on this repository — depth
 * 4 with the `node_modules` skip is **76 ms**, and the same walk with the skip
 * removed is **1762 ms** for the same single hit.
 *
 * Counted from the workspace as depth 0, so the default examines
 * `<workspace>/a/b/c/d` and finds a `.git` inside it — five path segments down
 * from the root. A repository nested deeper than that is not found, and the
 * consequence is stated here rather than left for someone to discover: a
 * `.git` the scan misses is a write the policy does not protect. Callers that
 * need deeper coverage pass a larger `maxDepth` and pay the walk time for it.
 */
export const DEFAULT_PROTECTED_SCAN_DEPTH = 4;

/**
 * Directories not descended into by default.
 *
 * Exactly one, and the reason is **cost, measured** — it is the 76 ms / 1762 ms
 * difference above. It is deliberately *not* justified by reachability:
 * `node_modules` is inside the checkout and `npm install` writes into it, so a
 * vendored repository there is a real, if unusual, thing to protect. This is a
 * genuine narrowing, it is a parameter so a caller who disagrees can pass its own
 * set, and that caller can scan everything once per workspace for 1.8 s. What is
 * *not* on this list is anything a user plausibly keeps a repository in: `dist`
 * and `build` are frequently where a clone lands in a scratch workspace, and
 * skipping them would buy very little and hide a `.git`.
 */
export const PROTECTED_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

export interface FindProtectedPathsOptions {
	/** Overrides {@link PROTECTED_SCAN_SKIP_DIRS}. An empty set scans everything. */
	skipDirs?: ReadonlySet<string>;
}

/**
 * Every `.git` in the workspace, as canonical absolute forward-slash paths.
 *
 * "Canonical" is load-bearing rather than cosmetic: the decision layer
 * canonicalises the candidate path before comparing it, so a scan that returned
 * `/var/folders/…` (a symlink) or a `C:\ws\.git` (backslashes, or a `\\?\`
 * prefix) would produce entries that match nothing, and the policy would
 * silently protect nothing. The comparison in `simulated.ts` folds case for a
 * case-insensitive filesystem, so the spelling of a segment does not have to
 * agree — but its *identity* does.
 *
 * The walk is breadth-first and tracks the canonical paths it has already
 * entered, so a symlink pointing at a directory the walk also reaches by its
 * real name is visited once. The depth bound is what makes that belt-and-
 * braces: even a cycle among links stays inside the bound.
 *
 * A directory that cannot be enumerated — permissions, a share that is down, a
 * path that turns out not to be a directory — is skipped and the walk
 * continues. Failing the whole policy because one subtree is unreadable would be
 * worse than the gap it causes: a policy that does not load confines nothing at
 * all. A link that dangles is filtered earlier and by a different check, at the
 * containment and `isDirectory` steps below, so it never reaches here.
 */
export async function findProtectedPaths(
	workspace: string,
	maxDepth: number = DEFAULT_PROTECTED_SCAN_DEPTH,
	options: FindProtectedPathsOptions = {},
): Promise<string[]> {
	const skipDirs = options.skipDirs ?? PROTECTED_SCAN_SKIP_DIRS;
	// A negative or fractional bound would be a scan with no floor; clamp rather
	// than trust the caller, since this is a cost control and the only safe
	// failure direction for a cost control is "scan less".
	const depthLimit = Number.isFinite(maxDepth) ? Math.max(0, Math.floor(maxDepth)) : 0;

	const root = resolveCanonical(workspace, workspace);
	const protectedPaths = new Set<string>();
	const visited = new Set<string>([root]);
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

	while (queue.length > 0) {
		// Breadth-first, so the repositories nearest the root are found before the
		// walk spends its time on the deep branches — and those are the ones a
		// policy is most often wrong about, being the ones a user recognises.
		const current = queue.shift();
		if (current === undefined) break;

		let entries: Dirent[];
		try {
			entries = await readdir(current.dir, { withFileTypes: true });
		} catch {
			// Permissions, a share that is down, a path that is not a directory
			// after all. The scan is the input to a policy, and a policy that does
			// not load confines nothing, so one unreadable subtree costs the coverage
			// it has rather than the coverage every other subtree has.
			continue;
		}

		for (const entry of entries) {
			const full = join(current.dir, entry.name);

			if (entry.name === GIT_DIR_NAME) {
				// Recorded whatever it is. A `.git` symlink resolves to its target,
				// which is the right thing to protect: a write through the link
				// canonicalises to the target, so protecting the link's own spelling
				// would match nothing.
				protectedPaths.add(resolveCanonical(full, current.dir));
				// Never descended into. Nothing inside `.git` is a repository, and on
				// a large repository that is thousands of directories of dead weight.
				continue;
			}

			if (skipDirs.has(entry.name)) continue;
			// A symlink to a directory reports `isSymbolicLink`, not `isDirectory`,
			// so a check on `isDirectory` alone would skip every link — which is how
			// a link that escapes the workspace gets to launder a path in the first
			// place. Both go through the canonical + containment check below.
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (current.depth + 1 > depthLimit) continue;

			const canonical = resolveCanonical(full, current.dir);
			// The link-escape check. Resolving first and comparing after is what
			// makes this meaningful: a lexical walk of a tree with a link in it
			// would step straight out of the workspace and keep going.
			if (!isContainedIn(canonical, root)) continue;
			if (visited.has(canonical)) continue;

			// A symlink to a file is still a symlink to something, and readdir on it
			// would fail with ENOTDIR. Checking costs one stat and only for links.
			if (!entry.isDirectory() && !(await isDirectory(canonical))) continue;

			visited.add(canonical);
			queue.push({ dir: canonical, depth: current.depth + 1 });
		}
	}

	return [...protectedPaths].sort();
}

/**
 * The directory name a repository keeps its metadata in. A constant rather than
 * a literal repeated at the one place that uses it, so a future format that
 * changes the spelling has one definition to change.
 */
const GIT_DIR_NAME = ".git";

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
