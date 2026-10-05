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

/**
 * `readOnlyRoots` are directories outside the workspace that this tool may
 * still read: the app's tool-output spill directory, where results too large
 * for the context are kept in full. Read gets this and nothing else does —
 * Write and Edit go through `guardWritablePath`, which has no such escape —
 * because the file a spilled Bash result points at is a dead end otherwise.
 *
 * `readState` is where the read is recorded, for the edit gate: an edit is only
 * allowed on a file the model has actually read, and that fact is code here
 * rather than a line in Edit's prompt. It is a parameter and not a singleton
 * because two sessions can be alive in one process — see `read-file-state.ts`.
 */
export function createReadTool(
	cwd: string,
	ops: Operations,
	readOnlyRoots: string[] = [],
	readState: ReadFileState = new ReadFileState(),
): AnyTool {
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

			// What the model is about to have seen, recorded. Every error path above
			// returned instead, so an entry here means the read worked: a missing
			// file, an unreadable one and an offset past the end all leave the
			// previous record alone, because none of them showed the model anything.
			//
			// `content` is `shownLines` joined rather than `rendered`: a gate asks
			// whether an `old_string` is in what the model saw, and Read's six-column
			// gutter would put a tab between every pair of lines and answer that
			// question about a file the model has not seen. For an unpaged read with
			// nothing cut this string is the file byte for byte.
			//
			// Three things make it something other than the whole file, and all three
			// are things the caller did not ask for by paging:
			//   1. a line over the per-line cap, cut and marked `…` above;
			//   2. a file longer than the default window, cut at `MAX_LINES` with no
			//      offset and no limit — the model gets a page it never requested, and
			//      `fullRead` alone would call that a whole-file read;
			//   3. a result longer than `maxResultSizeChars`, which the pipeline cuts
			//      through the *middle* before the model sees it (`output-limits.ts:108`
			//      keeps a head and a tail). This one leaves the recorded string
			//      longer than what arrived, which no comparison can repair from here
			//      — `partialView` is what has to carry it.
			const cutUnasked = input.offset === undefined && input.limit === undefined && end < allLines.length;
			const cutLine = shownLines.some((shown, i) => shown !== allLines[start + i]);
			const cutByResultLimit = rendered.length > MAX_RESULT_CHARS;
			readState.record(path, {
				content: shownLines.join("\n"),
				offset: input.offset,
				limit: input.limit,
				partialView: cutUnasked || cutLine || cutByResultLimit,
			});

			return { content: [{ type: "text", text: rendered }] };
		},
	});
}

/**
 * Which failure a Read hit, said in the terms the model can act on.
 *
 * The message this replaced — "File does not exist or cannot be read" — was
 * three answers under one name: a typo'd path, a directory, and a permission
 * problem all read identically, so the model's next move (fix the path? use LS?
 * give up?) was a guess. The codes below are Node's, carried through both
 * `Operations` implementations untouched, and `EISDIR` is measured on Windows
 * as well as POSIX — a directory read is not a POSIX-only nicety.
 */
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
