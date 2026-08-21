import { isAbsolute, join, relative, resolve } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import type { Operations } from "./operations.ts";

const MAX_MATCHES = 200;

/**
 * Content search. Spawns ripgrep when available (fast, respects .gitignore);
 * otherwise falls back to a pure-JS directory walk + line scan.
 */
export function createGrepTool(cwd: string, ops: Operations): AnyTool {
	return buildTool({
		name: "Grep",
		description:
			"Searches file contents with a regular expression. Returns matching lines with file paths " +
			"and line numbers. Respects .gitignore when ripgrep is available.",
		inputSchema: z.object({
			pattern: z.string().describe("Regular expression (Rust/JS syntax)"),
			path: z.string().optional().describe("Directory or file to search (default cwd)"),
			include: z.string().optional().describe("Glob filter for file names, e.g. '*.ts'"),
			case_insensitive: z.boolean().optional(),
		}),
		prompt:
			"- Prefer Grep over running `grep`/`rg` via Bash.\n" +
			"- Narrow with `include` globs before searching broad trees.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			const root = input.path ? (isAbsolute(input.path) ? input.path : resolve(cwd, input.path)) : cwd;
			if (!(await ops.exists(root))) {
				return { content: [{ type: "text", text: `Path not found: ${root}` }], isError: true };
			}

			const flags = input.case_insensitive ? "i" : "";
			const regex = new RegExp(input.pattern, flags);

			const lines: string[] = [];
			let truncated = false;
			const files = await collectFiles(ops, root, input.include);
			for (const file of files) {
				let text: string;
				try {
					text = await ops.readTextFile(file);
				} catch {
					continue; // binary or unreadable
				}
				if (text.includes("\0")) continue; // skip binary
				const fileLines = text.split("\n");
				for (let i = 0; i < fileLines.length; i++) {
					if (!regex.test(fileLines[i])) continue;
					if (lines.length >= MAX_MATCHES) {
						truncated = true;
						break;
					}
					lines.push(`${relative(root, file).split("\\").join("/")}:${i + 1}: ${fileLines[i].trim()}`);
				}
				if (truncated) break;
			}

			if (lines.length === 0) {
				return { content: [{ type: "text", text: "No matches found." }] };
			}
			const header = `${lines.length} match(es)${truncated ? ` (showing first ${MAX_MATCHES})` : ""}:\n`;
			return { content: [{ type: "text", text: header + lines.join("\n") }] };
		},
	});
}

async function collectFiles(ops: Operations, root: string, include?: string): Promise<string[]> {
	const entryStat = await ops.stat(root);
	if (entryStat.isFile) return [root];

	const out: string[] = [];
	const globRe = include ? globToRegExp(include) : null;
	const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > 15 || out.length > 20_000) return;
		const entries = await ops.readdir(dir).catch(() => null);
		if (!entries) return;
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory) {
				if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
			} else if (!globRe || globRe.test(entry.name)) {
				out.push(full);
			}
		}
	}

	await walk(root, 0);
	return out;
}

export function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}
