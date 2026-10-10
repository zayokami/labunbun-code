import { join, relative } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import { type IgnoreSet, isIgnored, parseGitignore } from "./ignore.ts";
import type { Operations } from "./operations.ts";
import { nextSpillPath } from "./output-capture.ts";

const MAX_RESULTS = 200;

export const GLOB_SKIP_DIRS = ["node_modules", ".git", "dist", "build", ".next", "coverage"] as const;
const MAX_DEPTH = 15;

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
	opts: { pattern?: Bun.Glob; skipDirs?: ReadonlySet<string>; respectGitignore?: boolean } = {},
): Promise<string[]> {
	const glob = opts.pattern ?? null;
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
		if (depth > MAX_DEPTH || matches.length > 5_000) return;
		const entries = await ops.readdir(dir).catch(() => null);
		if (!entries) return;
		// This directory's own `.gitignore` joins the chain before any entry is
		// judged: its rules apply at and below it and are evaluated after the
		// sets above, so a deeper file overrides a shallower one — git's
		// precedence, and the order `isIgnored` folds in.
		let here = chain;
		if (readGitignore && entries.some((entry) => !entry.isDirectory && entry.name === ".gitignore")) {
			const text = await readGitignore(join(dir, ".gitignore")).catch(() => null);
			if (text !== null) {
				here = [...chain, { base: dir.split("\\").join("/"), rules: parseGitignore(text) }];
			}
		}
		for (const entry of entries) {
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
	matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
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
			if (!(await ops.exists(root))) {
				return { content: [{ type: "text", text: `Path not found: ${root}` }], isError: true };
			}

			const matches = await walkProjectFiles(root, ops, {
				pattern: new Bun.Glob(input.pattern),
				respectGitignore: true,
			});

			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No files matched." }] };
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
				content: [{ type: "text", text: `${shown.join("\n")}${suffix}` }],
			};
		},
	});
}
