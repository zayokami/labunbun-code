import { basename, relative } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import { walkProjectFiles } from "./glob.ts";
import type { Operations } from "./operations.ts";

const DEFAULT_HEAD_LIMIT = 250;
/**
 * Matches collected before the search stops. It bounds the work a single call
 * can do, and it is not a paging limit: reaching it means the header can no
 * longer state an exact total, and says so.
 */
const SAFETY_MATCH_CAP = 10_000;
const DEFAULT_MAX_COLUMNS = 500;
const REGEX_TIMEOUT_MS = 2000;

/** One match, before display slicing. `text` is the line with any CR removed. */
export interface GrepMatch {
	/** Path as shown to the caller: relative to the search root. */
	path: string;
	lineNumber: number;
	text: string;
}

/** How the collected matches become the result text. */
export interface GrepDisplay {
	offset: number;
	headLimit: number;
	maxColumns: number;
	/** The search stopped at {@link SAFETY_MATCH_CAP} with matches still unseen. */
	safetyCapped: boolean;
}

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
			"depth) and files under node_modules, .git, .svn, .hg, .bzr, .jj, .sl, dist, build, .next or " +
			"coverage are skipped.",
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
			head_limit: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"Maximum matches to show (default 250). 0 shows every match collected under the 10000-match safety cap.",
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("Number of matches to skip before showing results (default 0)"),
			max_columns: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"Maximum characters of a matching line to show before the line is cut with a count of " +
						"the omitted characters (default 500; 0 leaves the line whole)",
				),
		}),
		prompt:
			"- Prefer Grep over running `grep`/`rg` via Bash.\n" +
			"- `include` is a Glob over the path relative to the searched directory: '**/*.ts' spans " +
			"directories, '*.ts' does not. Narrow with it before searching broad trees.\n" +
			"- Results show `head_limit` matches (default 250; 0 removes the display limit) after " +
			"skipping `offset` (default 0). When the header says more exist, call again with `offset` " +
			"set to its next offset.\n" +
			"- A matching line longer than `max_columns` characters (default 500; 0 leaves it whole) is " +
			"cut with a count of the omitted characters; the match and the count are unaffected.",
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

			const matches: GrepMatch[] = [];
			let safetyCapped = false;
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
				const shownPath = displayPath(root, file);
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
					if (matches.length >= SAFETY_MATCH_CAP) {
						safetyCapped = true;
						break outer;
					}
					matches.push({ path: shownPath, lineNumber: i + 1, text: line });
				}
			}

			// One slice, after the whole search: the count in the header is the
			// count of matches, not of shown lines, and paging never re-runs the
			// search against a tree that may have moved.
			const text = renderGrepResult(matches, {
				offset: input.offset ?? 0,
				headLimit: input.head_limit ?? DEFAULT_HEAD_LIMIT,
				maxColumns: input.max_columns ?? DEFAULT_MAX_COLUMNS,
				safetyCapped,
			});
			return { content: [{ type: "text", text }] };
		},
	});
}

/**
 * Render collected matches as the result text: a single header line, then one
 * `path:line: text` row per shown match.
 *
 * Exported because the safety-cap header cannot be reached through a
 * reasonable fixture — it takes 10000 matches — and a branch that only exists
 * in production is a branch no test ever reads.
 */
export function renderGrepResult(matches: readonly GrepMatch[], display: GrepDisplay): string {
	if (matches.length === 0) return "No matches found.";
	const start = Math.min(display.offset, matches.length);
	const available = matches.length - start;
	const shownCount = display.headLimit === 0 ? available : Math.min(display.headLimit, available);
	const shown = matches.slice(start, start + shownCount);
	const end = start + shownCount;
	const hasMore = end < matches.length;

	// The first line is the header, and every line after it is a result. The
	// header ends in `:` and holds no newline, so `path:N:` consumers can drop
	// line one and read the rest as paths.
	let header = `${shownCount} of ${display.safetyCapped ? `at least ${matches.length}` : matches.length} match(es) shown`;
	if (display.safetyCapped) {
		header += `; search stopped at the ${SAFETY_MATCH_CAP}-match safety cap, so the total is not exact`;
	}
	if (hasMore) header += `; next offset ${end}`;
	header += ":";

	if (shown.length === 0) return header;
	const rows = shown.map((match) => `${match.path}:${match.lineNumber}: ${cutLine(match.text, display.maxColumns)}`);
	return `${header}\n${rows.join("\n")}`;
}

/**
 * Cut a displayed line at `maxColumns` characters with a count of what was
 * left out. Matching and counting read the whole line; only this rendering is
 * narrowed. `0` disables the cut.
 */
function cutLine(text: string, maxColumns: number): string {
	if (maxColumns === 0 || text.length <= maxColumns) return text;
	// Count characters, not UTF-16 units, and never split a surrogate pair.
	const chars = Array.from(text);
	if (chars.length <= maxColumns) return text;
	const omitted = chars.length - maxColumns;
	return `${chars.slice(0, maxColumns).join("")}… (line truncated, ${omitted} more chars)`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The path a result line shows: relative to the search root, or the name alone for a single-file search. */
function displayPath(root: string, file: string): string {
	const rel = relative(root, file);
	return (rel === "" ? basename(file) : rel).split("\\").join("/");
}
