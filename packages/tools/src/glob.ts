import { join, relative } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import { type IgnoreSet, isIgnored, parseGitignore } from "./ignore.ts";
import type { Operations } from "./operations.ts";
import { nextSpillPath } from "./output-capture.ts";
import { isMissingPathError, probePath } from "./path-errors.ts";

const MAX_RESULTS = 200;

export const GLOB_SKIP_DIRS = [
	"node_modules",
	".git",
	".svn",
	".hg",
	".bzr",
	".jj",
	".sl",
	"dist",
	"build",
	".next",
	"coverage",
] as const;
const MAX_DEPTH = 15;
/** How many matches a walk collects before it stops, unless the caller raises it. */
export const WALK_MAX_FILES = 5_000;

/**
 * What the walker needs from the filesystem. Deliberately narrower than
 * Operations: callers that only list files (the @-mention completer) should
 * not have to build shell execution to get them.
 */
export interface FileWalkerOps {
	readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
	stat(path: string): Promise<{ mtimeMs: number }>;
	/**
	 * Read a text file — needed only when walking with `respectGitignore`, and
	 * optional so the completer keeps its narrow dependency: the ignore files
	 * are part of the tree being walked, and a walker asked to honour a
	 * `.gitignore` it cannot read would ignore it silently, which is the one
	 * failure mode this feature exists to prevent.
	 */
	readTextFile?(path: string): Promise<string>;
}

// Long-form design notes: docs/dev/tools.md
/** Walk a project tree and return matching files as absolute forward-slash paths, newest first. */
export async function walkProjectFiles(
	root: string,
	ops: FileWalkerOps,
	opts: {
		pattern?: Bun.Glob;
		skipDirs?: ReadonlySet<string>;
		respectGitignore?: boolean;
		/**
		 * Called once for a directory the walk could not list. The walk goes on,
		 * but everything below that directory is absent from the result — the
		 * caller is the one that can say so. A directory that vanished mid-walk
		 * is not reported: it is gone, which is the same fact as never having
		 * been there, not a failure to look.
		 */
		onUnreadableDirectory?: (path: string) => void;
		/**
		 * Stop collecting once this many files have matched. Default
		 * `WALK_MAX_FILES`. The walk is depth-first, so the files it did collect
		 * are a prefix of the tree rather than the newest ones; a caller that must
		 * be honest about completeness passes `onTruncated` too.
		 */
		maxFiles?: number;
		/**
		 * Called once when the walk stops at `maxFiles`. Without it the cap is
		 * silent, which is fine for a tool that shows 200 results anyway and wrong
		 * for a map that claims to describe the repository.
		 */
		onTruncated?: (maxFiles: number) => void;
		/**
		 * Sort matches by modification time, newest first. Default true, which is
		 * what Glob's result order promises. A caller that re-sorts anyway — the
		 * repository map sorts by path — passes false and saves one `stat` per
		 * matched file, which on a twenty-thousand-file tree is the largest single
		 * cost of a hot scan.
		 */
		sortByMtime?: boolean;
		/**
		 * Cancels the walk. The check is per directory and per entry, so a stopped
		 * `/map` stops reading the tree rather than finishing an index nobody is
		 * waiting for.
		 */
		signal?: AbortSignal;
	} = {},
): Promise<string[]> {
	const glob = opts.pattern ?? null;
	const maxFiles = opts.maxFiles ?? WALK_MAX_FILES;
	const sortByMtime = opts.sortByMtime ?? true;
	let truncated = false;

	// The walk collects one match past the ceiling before it stops: a tree with
	// exactly `maxFiles` matching files is complete, and only a sighting of the
	// next match tells the difference between "that was all" and "that was cut".
	function atLimit(): boolean {
		if (matches.length <= maxFiles) return false;
		if (!truncated) {
			truncated = true;
			opts.onTruncated?.(maxFiles);
		}
		return true;
	}

	const SKIP_DIRS = opts.skipDirs ?? new Set<string>(GLOB_SKIP_DIRS);
	// Reading the `.gitignore` files is not optional when the walk must honour
	// them: a walker asked to respect an ignore file it cannot read would
	// silently ignore it, which is the failure mode this feature exists to
	// prevent. Hence the throw — and `readGitignore` doubles as the flag: it is
	// non-null exactly when the walk honours ignore files.
	const readGitignore = (() => {
		if (!opts.respectGitignore) return null;
		const read = ops.readTextFile;
		if (!read) throw new Error("walkProjectFiles: respectGitignore needs ops.readTextFile");
		return read.bind(ops);
	})();
	const matches: Array<{ path: string; mtimeMs: number }> = [];

	async function walk(dir: string, depth: number, chain: readonly IgnoreSet[]): Promise<void> {
		opts.signal?.throwIfAborted();
		if (depth > MAX_DEPTH || atLimit()) return;
		const entries = await ops.readdir(dir).catch((error: unknown) => {
			if (!isMissingPathError(error)) opts.onUnreadableDirectory?.(dir);
			return null;
		});
		if (!entries) return;
		// This directory's own `.gitignore` joins the chain before any entry is
		// judged: its rules apply at and below it and are evaluated after the
		// sets above, so a deeper file overrides a shallower one — git's
		// precedence, and the order `isIgnored` folds in.
		let here = chain;
		if (readGitignore && entries.some((entry) => !entry.isDirectory && entry.name === ".gitignore")) {
			const gitignorePath = join(dir, ".gitignore");
			const text = await readGitignore(gitignorePath).catch((error: unknown) => {
				// Deleted between the `readdir` above and this read: that race means
				// the file is not there, which is the same fact as never having been —
				// not a failure to honour it. Any other error (permissions, a share
				// that is down) is exactly the case the comment above the reader
				// describes: a walk asked to respect an ignore file it cannot read
				// throws rather than quietly walking past it.
				if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
				throw new Error(
					`walkProjectFiles: could not read ${gitignorePath}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			});
			if (text !== null) {
				here = [...chain, { base: dir.split("\\").join("/"), rules: parseGitignore(text) }];
			}
		}
		for (const entry of entries) {
			opts.signal?.throwIfAborted();
			if (atLimit()) return;
			const full = join(dir, entry.name);
			const ignored = here.length > 0 && isIgnored(here, full, entry.isDirectory);
			if (entry.isDirectory) {
				// Pruning an ignored directory is git's own semantics: a file
				// inside an excluded directory cannot be re-included, so there is
				// nothing below it worth descending for.
				if (SKIP_DIRS.has(entry.name) || ignored) continue;
				await walk(full, depth + 1, here);
			} else {
				if (ignored) continue;
				if (!glob || (await glob.match(relative(root, full).split("\\").join("/")))) {
					if (!sortByMtime) {
						matches.push({ path: full, mtimeMs: 0 });
						continue;
					}
					try {
						const s = await ops.stat(full);
						matches.push({ path: full, mtimeMs: s.mtimeMs });
					} catch {
						matches.push({ path: full, mtimeMs: 0 });
					}
				}
			}
		}
	}

	await walk(root, 0, []);
	if (matches.length > maxFiles) {
		matches.length = maxFiles;
		if (!truncated) {
			truncated = true;
			opts.onTruncated?.(maxFiles);
		}
	}
	if (sortByMtime) matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return matches.map((m) => m.path.split("\\").join("/"));
}

/** Filename pattern search (Bun.Glob over a directory walk). */
export function createGlobTool(
	cwd: string,
	ops: Operations,
	/** `spillDir`: where the whole match list goes when the shown list is cut. */
	options?: { spillDir?: string },
): AnyTool {
	return buildTool({
		name: "Glob",
		description:
			"Finds files by glob pattern (e.g. '**/*.test.ts', 'src/**/*.json'). Returns absolute paths " +
			"sorted by modification time, newest first. Files excluded by .gitignore are left out. " +
			"A long list is cut with a count of what is missing; the full list is written to a file " +
			"and the last line names its path.",
		inputSchema: z.object({
			pattern: z.string().describe("Glob pattern relative to `path`"),
			path: z.string().optional().describe("Directory to search (default cwd)"),
		}),
		prompt: "- Prefer Glob over `find` via Bash. Use ** for recursive matching.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			let root: string;
			try {
				root = input.path ? guardPathContainment(input.path, cwd, "Glob") : cwd;
			} catch (error) {
				return { content: [{ type: "text", text: String(error) }], isError: true };
			}
			const probe = await probePath(ops, root, "search");
			if (!probe.ok) {
				return { content: [{ type: "text", text: probe.message }], isError: true };
			}

			let unreadableDirectories = 0;
			let walkCappedAt: number | undefined;
			const matches = await walkProjectFiles(root, ops, {
				pattern: new Bun.Glob(input.pattern),
				respectGitignore: true,
				onUnreadableDirectory: () => {
					unreadableDirectories++;
				},
				// The walk's cap is separate from the display cut below and must not
				// be silent: past it the tool has not seen the whole tree.
				onTruncated: (limit) => {
					walkCappedAt = limit;
				},
			});
			const skipped =
				unreadableDirectories > 0
					? `\n[skipped ${unreadableDirectories} unreadable director${unreadableDirectories === 1 ? "y" : "ies"}]`
					: "";
			const truncated =
				walkCappedAt !== undefined
					? `\n[walk stopped at the ${walkCappedAt}-file cap; matches past that point are not listed]`
					: "";

			if (matches.length === 0) {
				// "No files matched." reads as a fact about the tree. The tree was
				// filtered before it was searched, and an empty answer from a filtered
				// tree is a different claim: the file may be excluded, or the pattern
				// may be anchored where the caller did not expect. Naming the pattern,
				// the root and both filters is what lets the model correct itself
				// instead of repeating the same call.
				return {
					content: [
						{
							type: "text",
							text:
								`No files matched "${input.pattern}" under ${root}.${skipped}` +
								"\n.gitignore rules and the built-in skip list (node_modules, .git, dist, build, .next, …) " +
								"were applied, so an excluded file will not appear. Patterns match paths relative to that " +
								'directory — use "**/" to reach subdirectories. Read or LS can confirm a path you already know.',
						},
					],
				};
			}
			const shown = matches.slice(0, MAX_RESULTS);
			let suffix = "";
			if (matches.length > MAX_RESULTS) {
				const more = matches.length - MAX_RESULTS;
				// A count alone says the list was cut and nothing about what went;
				// the list is already in hand, so it goes to a file the Read tool
				// can open (the caller points the spill directory inside Read's
				// roots). A failed write falls back to the count — the result
				// still says the list is incomplete, which is the important half.
				let path: string | null = null;
				if (options?.spillDir) {
					try {
						await ops.mkdir(options.spillDir);
						path = nextSpillPath(options.spillDir, "glob");
						await ops.writeTextFile(path, matches.join("\n"));
					} catch {
						path = null;
					}
				}
				suffix = path ? `\n[+${more} more → ${path}]` : `\n[+${more} more]`;
			}
			return {
				content: [{ type: "text", text: `${shown.join("\n")}${suffix}${truncated}${skipped}` }],
			};
		},
	});
}
