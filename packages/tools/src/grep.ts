import { basename, relative } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import { walkProjectFiles } from "./glob.ts";
import type { Operations } from "./operations.ts";

const MAX_MATCHES = 200;
const REGEX_TIMEOUT_MS = 2000;

// Long-form design notes: docs/dev/tools.md
/** Content search over the same walk the Glob tool uses, `.gitignore` included. */
export function createGrepTool(cwd: string, ops: Operations): AnyTool {
	return buildTool({
		name: "Grep",
		description:
			"Searches file contents with a JavaScript regular expression. Returns matching lines with file paths " +
			"and line numbers, indentation intact. Files excluded by .gitignore (every .gitignore from the " +
			"searched directory down: comments, blank lines, `!` re-includes, a trailing `/` for directories, " +
			"a slash anchoring the pattern to its .gitignore's directory, no slash matching by name at any " +
			"depth) and files under node_modules, .git, dist, build, .next or coverage are skipped.",
		inputSchema: z.object({
			pattern: z.string().describe("Regular expression (JavaScript syntax)"),
			path: z.string().optional().describe("Directory or file to search (default cwd)"),
			include: z
				.string()
				.optional()
				.describe(
					"Glob for the files to search, matched against each file's path relative to the searched " +
						"directory, with the same semantics as the Glob tool's pattern (use '**/*.ts' to reach " +
						"subdirectories; '*.ts' matches at the top level only)",
				),
			case_insensitive: z.boolean().optional(),
		}),
		prompt:
			"- Prefer Grep over running `grep`/`rg` via Bash.\n" +
			"- `include` is a Glob over the path relative to the searched directory: '**/*.ts' spans " +
			"directories, '*.ts' does not.\n" +
			"- Narrow with `include` before searching broad trees.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		// A search that matched a lot is a search that has to be narrowed, and the
		// hits it did find are not reproducible by asking again — the tree moves on.
		overflow: "spill",
		call: async (input) => {
			let root: string;
			try {
				root = input.path ? guardPathContainment(input.path, cwd, "Grep") : cwd;
			} catch (error) {
				return { content: [{ type: "text", text: String(error) }], isError: true };
			}
			if (!(await ops.exists(root))) {
				return { content: [{ type: "text", text: `Path not found: ${root}` }], isError: true };
			}

			const flags = input.case_insensitive ? "i" : "";
			let regex: RegExp;
			try {
				regex = new RegExp(input.pattern, flags);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Invalid regular expression: ${message(error)}` }],
					isError: true,
				};
			}

			// A named file is searched as named. The walk's rules — skip list,
			// `.gitignore` — are statements about trees, and pointing Grep at one
			// file is a statement about that file.
			let files: string[];
			if ((await ops.stat(root)).isFile) {
				files = [root];
			} else {
				files = await walkProjectFiles(root, ops, {
					pattern: input.include ? new Bun.Glob(input.include) : undefined,
					respectGitignore: true,
				});
			}

			const lines: string[] = [];
			let truncated = false;
			const deadline = Date.now() + REGEX_TIMEOUT_MS;
			outer: for (const file of files) {
				try {
					const stat = await ops.stat(file);
					if (stat.size > 1_000_000) continue; // skip huge files
				} catch {
					continue;
				}
				let text: string;
				try {
					text = await ops.readTextFile(file);
				} catch {
					continue; // binary or unreadable
				}
				if (text.includes("\0")) continue; // skip binary
				const fileLines = text.split("\n");
				for (let i = 0; i < fileLines.length; i++) {
					if (Date.now() > deadline) {
						return {
							content: [
								{
									type: "text",
									text: `Search aborted: pattern took too long to match (possible catastrophic backtracking).`,
								},
							],
							isError: true,
						};
					}
					// The `\r` of a CRLF line is not part of the line: left in, a
					// `$`-anchored pattern misses and every quoted line ends in an
					// invisible control character. The line's *indentation*, by
					// contrast, is part of what the file says — the old code
					// `.trim()`ed it away, and a model copying a result back out
					// got a string the file does not contain.
					const line = fileLines[i].replace(/\r$/, "");
					if (!regex.test(line)) continue;
					if (lines.length >= MAX_MATCHES) {
						truncated = true;
						break outer;
					}
					lines.push(`${displayPath(root, file)}:${i + 1}: ${line}`);
				}
			}

			if (lines.length === 0) {
				return { content: [{ type: "text", text: "No matches found." }] };
			}
			const header = `${lines.length} match(es)${truncated ? ` (showing first ${MAX_MATCHES})` : ""}:\n`;
			return { content: [{ type: "text", text: header + lines.join("\n") }] };
		},
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The path a result line shows: relative to the search root, or the name alone for a single-file search. */
function displayPath(root: string, file: string): string {
	const rel = relative(root, file);
	return (rel === "" ? basename(file) : rel).split("\\").join("/");
}
