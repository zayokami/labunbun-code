import { join, relative } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import type { Operations } from "./operations.ts";

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
}

/**
 * Walk a project tree and return matching files as absolute forward-slash
 * paths, newest first. Shared by the Glob tool (which filters through a glob
 * pattern) and the prompt's @-mention completer (which relativizes against the
 * session cwd itself). The walker caps depth and result count so a runaway
 * tree cannot stall either caller.
 */
export async function walkProjectFiles(
	root: string,
	ops: FileWalkerOps,
	opts: { pattern?: Bun.Glob; skipDirs?: ReadonlySet<string> } = {},
): Promise<string[]> {
	const glob = opts.pattern ?? null;
	const SKIP_DIRS = opts.skipDirs ?? new Set<string>(GLOB_SKIP_DIRS);
	const matches: Array<{ path: string; mtimeMs: number }> = [];

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > MAX_DEPTH || matches.length > 5_000) return;
		const entries = await ops.readdir(dir).catch(() => null);
		if (!entries) return;
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory) {
				if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
			} else if (!glob || (await glob.match(relative(root, full).split("\\").join("/")))) {
				try {
					const s = await ops.stat(full);
					matches.push({ path: full, mtimeMs: s.mtimeMs });
				} catch {
					matches.push({ path: full, mtimeMs: 0 });
				}
			}
		}
	}

	await walk(root, 0);
	matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return matches.map((m) => m.path.split("\\").join("/"));
}

/** Filename pattern search (Bun.Glob over a directory walk). */
export function createGlobTool(cwd: string, ops: Operations): AnyTool {
	return buildTool({
		name: "Glob",
		description:
			"Finds files by glob pattern (e.g. '**/*.test.ts', 'src/**/*.json'). Returns absolute paths " +
			"sorted by modification time, newest first.",
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

			const matches = await walkProjectFiles(root, ops, { pattern: new Bun.Glob(input.pattern) });

			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No files matched." }] };
			}
			const shown = matches.slice(0, MAX_RESULTS);
			const suffix = matches.length > MAX_RESULTS ? `\n[+${matches.length - MAX_RESULTS} more]` : "";
			return {
				content: [{ type: "text", text: `${shown.join("\n")}${suffix}` }],
			};
		},
	});
}
