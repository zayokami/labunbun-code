import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import type { Operations } from "./operations.ts";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

export function createReadTool(cwd: string, ops: Operations): AnyTool {
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
		maxResultSizeChars: Number.POSITIVE_INFINITY,
		call: async (input) => {
			let path: string;
			try {
				path = guardPathContainment(input.file_path, cwd, "Read");
			} catch (error) {
				return {
					content: [{ type: "text", text: String(error) }],
					isError: true,
				};
			}
			const text = await ops.readTextFile(path).catch(() => null);
			if (text === null) {
				return {
					content: [{ type: "text", text: `File does not exist or cannot be read: ${path}` }],
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

			const numbered = allLines
				.slice(start, end)
				.map((line, i) => {
					const display = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
					return `${String(start + i + 1).padStart(6)}\t${display}`;
				})
				.join("\n");

			const notice =
				end < allLines.length
					? `\n[Showing lines ${start + 1}-${end} of ${allLines.length}. Use offset=${end + 1} for the next page.]`
					: "";
			return { content: [{ type: "text", text: `${numbered}${notice}` }] };
		},
	});
}
