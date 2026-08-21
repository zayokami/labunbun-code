import { isAbsolute, join, resolve as pathResolve, relative } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import type { Operations } from "./operations.ts";

const MAX_RESULTS = 200;

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
			const root = input.path ? (isAbsolute(input.path) ? input.path : resolve(cwd, input.path)) : cwd;
			if (!(await ops.exists(root))) {
				return { content: [{ type: "text", text: `Path not found: ${root}` }], isError: true };
			}

			const glob = new Bun.Glob(input.pattern);
			const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
			const matches: Array<{ path: string; mtimeMs: number }> = [];

			async function walk(dir: string, depth: number): Promise<void> {
				if (depth > 15 || matches.length > 5_000) return;
				const entries = await ops.readdir(dir).catch(() => null);
				if (!entries) return;
				for (const entry of entries) {
					const full = join(dir, entry.name);
					if (entry.isDirectory) {
						if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
					} else if (await glob.match(relative(root, full).split("\\").join("/"))) {
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

			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No files matched." }] };
			}
			const shown = matches.slice(0, MAX_RESULTS);
			const suffix = matches.length > MAX_RESULTS ? `\n[+${matches.length - MAX_RESULTS} more]` : "";
			return {
				content: [{ type: "text", text: `${shown.map((m) => m.path.split("\\").join("/")).join("\n")}${suffix}` }],
			};
		},
	});
}

function resolve(p: string, base: string): string {
	return isAbsolute(p) ? p : pathResolve(base, p);
}
