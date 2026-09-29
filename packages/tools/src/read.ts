import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import type { Operations } from "./operations.ts";
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

/**
 * `readOnlyRoots` are directories outside the workspace that this tool may
 * still read: the app's tool-output spill directory, where results too large
 * for the context are kept in full. Read gets this and nothing else does —
 * Write and Edit go through `guardWritablePath`, which has no such escape —
 * because the file a spilled Bash result points at is a dead end otherwise.
 */
export function createReadTool(cwd: string, ops: Operations, readOnlyRoots: string[] = []): AnyTool {
	// Containment decides the workspace boundary, so `outside workspace` reads the
	// same here as it does for Glob, Grep, LS, Write and Edit. The only way past
	// it is a root the caller named, and that question is asked of a `read` entry
	// rather than of a list this file keeps — so a root is sayable in one place
	// and the same entry is what stops Write from writing there.
	//
	// `ctx.sandbox` is deliberately not consulted. The boundary is the
	// application's, not the mode's: the same file is readable in Agent and in
	// Agent 无沙箱, just as the write tools' `.git` rule holds in every mode. What
	// the sandbox axis governs is the shell, which the kernel confines on macOS
	// and Linux and nothing confines on Windows. See `readableRootsPolicy` for
	// the widening that threading the mode through here was measured to cause.
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
