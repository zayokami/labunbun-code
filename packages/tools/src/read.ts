import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import type { Operations } from "./operations.ts";
import { ReadFileState } from "./read-file-state.ts";
import { decideRead } from "./sandbox/simulated.ts";
import { readableRootsPolicy } from "./sandbox/workspace-policy.ts";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
/**
 * Ceiling on one Read result. 2000 lines of ordinary prose is well under it;
 * 2000 lines of generated JSON, one enormous line, is not — and either way the
 * answer to a cut read is a smaller range, not a bigger result.
 */
const MAX_RESULT_CHARS = 200_000;

// Long-form design notes: docs/dev/tools.md
/** The Read tool: paging with line numbers, the read-only roots, and the read record for the edit gate. */
export function createReadTool(
	cwd: string,
	ops: Operations,
	readOnlyRoots: string[] = [],
	readState: ReadFileState = new ReadFileState(),
): AnyTool {
	// Containment decides the boundary, and the caller's roots are the only way
	// past it. `ctx.sandbox` is not consulted here.
	// Long-form design notes: docs/dev/tools.md
	const resolveReadable = (inputPath: string): string => {
		try {
			return guardPathContainment(inputPath, cwd, "Read");
		} catch (error) {
			const decision = decideRead(readableRootsPolicy(cwd, readOnlyRoots), inputPath, cwd);
			if (!decision.allowed) throw error;
			return decision.canonicalPath;
		}
	};

	return buildTool({
		name: "Read",
		description:
			"Reads a file from the local filesystem. Returns content with line numbers (cat -n style). " +
			"Reads up to 2000 lines by default; use offset/limit for long files. " +
			"Results longer than 2000 characters per line are truncated.",
		inputSchema: z.object({
			file_path: z.string().describe("Absolute path to the file"),
			offset: z.number().int().min(1).optional().describe("1-based line number to start from"),
			limit: z.number().int().min(1).optional().describe("Number of lines to read"),
		}),
		prompt:
			"- Read files before editing them; never guess content.\n" +
			"- Use absolute paths.\n" +
			"- For long files use offset/limit paging instead of re-reading everything.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		maxResultSizeChars: MAX_RESULT_CHARS,
		call: async (input) => {
			let path: string;
			try {
				path = resolveReadable(input.file_path);
			} catch (error) {
				return {
					content: [{ type: "text", text: String(error) }],
					isError: true,
				};
			}
			// The rejection is the failure, and it is kept rather than folded into a
			// boolean: the errno on it is the difference between a wrong path, a
			// directory, and a permission problem — three different next moves the
			// old single message ("does not exist or cannot be read") named as one.
			// `typeof` rather than `instanceof Error` because a rejection value is
			// whatever the executor treats as one, and this branch has to hold for a
			// string rejection too.
			const text = await ops.readTextFile(path).catch((error: unknown) => error);
			if (typeof text !== "string") {
				return {
					content: [{ type: "text", text: describeReadFailure(path, text) }],
					isError: true,
				};
			}

			const allLines = text.split("\n");
			const start = (input.offset ?? 1) - 1;
			const end = Math.min(start + (input.limit ?? MAX_LINES), allLines.length);

			if (start >= allLines.length && allLines.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Offset ${input.offset} is beyond the end of the file (${allLines.length} lines total).`,
						},
					],
					isError: true,
				};
			}

			const shownLines = allLines
				.slice(start, end)
				.map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
			const numbered = shownLines.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join("\n");

			const notice =
				end < allLines.length
					? `\n[Showing lines ${start + 1}-${end} of ${allLines.length}. Use offset=${end + 1} for the next page.]`
					: "";
			const rendered = `${numbered}${notice}`;

			// The record: only a read the model received is recorded, and `content`
			// is the shown lines — not the whole file when a cut was not asked for.
			// Long-form design notes: docs/dev/tools.md
			const cutUnasked = input.offset === undefined && input.limit === undefined && end < allLines.length;
			const cutLine = shownLines.some((shown, i) => shown !== allLines[start + i]);
			const cutByResultLimit = rendered.length > MAX_RESULT_CHARS;
			// The file's own mtime, the baseline the staleness check compares for a
			// view it cannot compare by content (see `ReadFileStateEntry.mtime`). A
			// stat losing a race with a deletion costs only the baseline — the
			// content the model saw is still what gets recorded.
			let mtime: number | undefined;
			try {
				mtime = (await ops.stat(path)).mtimeMs;
			} catch {}
			readState.record(path, {
				content: shownLines.join("\n"),
				offset: input.offset,
				limit: input.limit,
				partialView: cutUnasked || cutLine || cutByResultLimit,
				mtime,
			});

			return { content: [{ type: "text", text: rendered }] };
		},
	});
}

// Long-form design notes: docs/dev/tools.md
/** Which failure a Read hit, said in the terms the model can act on. */
function describeReadFailure(path: string, error: unknown): string {
	const raw = (error as { code?: unknown } | null | undefined)?.code;
	const code = typeof raw === "string" ? raw : undefined;
	switch (code) {
		case "ENOENT":
		case "ENOTDIR":
			return `File does not exist: ${path}`;
		case "EISDIR":
			return `Path is a directory, not a file: ${path}. Use LS to list its contents.`;
		case "EACCES":
		case "EPERM":
			return `File exists but cannot be read (permission denied): ${path}`;
		default:
			// EMFILE, EBUSY and the like say nothing about whether the file exists
			// — so this branch claims nothing beyond not being readable right now.
			return `Could not read ${path}${code ? ` (${code})` : ""}`;
	}
}
