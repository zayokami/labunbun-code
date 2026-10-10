// Finding the `.git` directories inside a workspace, so they can go into
// `SandboxPolicy.protected`. A directory and a worktree's gitdir file both count.
// Long-form design notes: docs/dev/sandbox.md
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isContainedIn, resolveCanonical } from "../containment.ts";

// Long-form design notes: docs/dev/sandbox.md
/** The deepest directory whose entries this scan examines. A bound, not a tuning knob. */
export const DEFAULT_PROTECTED_SCAN_DEPTH = 4;

// Long-form design notes: docs/dev/sandbox.md
/** Directories not descended into by default. Exactly one, and the reason is cost, measured. */
export const PROTECTED_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

export interface FindProtectedPathsOptions {
	/** Overrides {@link PROTECTED_SCAN_SKIP_DIRS}. An empty set scans everything. */
	skipDirs?: ReadonlySet<string>;
}

// Long-form design notes: docs/dev/sandbox.md
/** Every `.git` in the workspace, as canonical absolute forward-slash paths. */
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
