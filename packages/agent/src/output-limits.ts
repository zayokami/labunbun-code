// Bounds on the text that tool output may add to the conversation: one result
// meets its tool's own limit, and one whole round meets the round budget.
// Long-form design notes: docs/dev/output-limits.md
import type { ToolResultContent, ToolResultMessage } from "@labunbun/ai";

/** Total characters of tool-result text one round may add to the conversation. */
export const MAX_ROUND_RESULT_CHARS = 200_000;

/**
 * What every result in an over-budget round keeps, however many there are and
 * however the budget divides: a result the model cannot see at all is a result
 * it has to re-run the tool for.
 */
export const MIN_ROUND_RESULT_CHARS = 2_000;

/** A result that did not fit, on its way to wherever it is kept in full. */
export interface SpillRequest {
	callId: string;
	/** Named so the file it lands in is attributable to the tool that made it. */
	toolName: string;
	text: string;
}

/**
 * Write a result that does not fit somewhere the model can read it back.
 * Returns the path to show, or null when it could not be written at all: a
 * failed spill is a missing convenience, and it must never be a failed tool.
 */
export type SpillWriter = (request: SpillRequest) => string | null;

/** First line of a result whose full text was written to a file. {@link formatSpillHeader}. */
const SPILL_HEADER = /^\[full output: \d+ chars → ([^\]]+)\]\n/;

// Long-form design notes: docs/dev/output-limits.md
/** Write the first line of a result whose full text was written to a file. */
export function formatSpillHeader(path: string, chars: number): string {
	return `[full output: ${chars} chars → ${path}]\n`;
}

// Long-form design notes: docs/dev/output-limits.md
/** The notice a cut leaves at the point where it cut, carrying how many characters are not shown. */
const CUT_MARKER = /\n\.\.\. \[truncated (\d+) chars of output\](?:\n|$)/;

// Long-form design notes: docs/dev/output-limits.md
/** Write that notice — one line, no newlines of its own. */
export function formatCutMarker(missing: number): string {
	return `... [truncated ${missing} chars of output]`;
}

interface Cuttable {
	/** The text as it stands, without a spill header or an earlier cut marker. */
	body: string;
	/** The path of the spilled full text, if this result already has one. */
	header: string;
	/** Characters already missing from `body`, from an earlier cut. */
	omitted: number;
}

// Long-form design notes: docs/dev/output-limits.md
/** Take a possibly-already-cut result back apart. */
function takeApart(text: string): Cuttable {
	const headerMatch = SPILL_HEADER.exec(text);
	const header = headerMatch?.[0] ?? "";
	const rest = header ? text.slice(header.length) : text;
	const markerMatch = CUT_MARKER.exec(rest);
	if (!markerMatch) return { body: rest, header, omitted: 0 };
	return {
		body: rest.slice(0, markerMatch.index) + rest.slice(markerMatch.index + markerMatch[0].length),
		header,
		omitted: Number(markerMatch[1]),
	};
}

// Long-form design notes: docs/dev/output-limits.md
/** Cut `text` down to `limit` characters, saying what is missing. */
export function cutText(text: string, limit: number, spill?: SpillWriter, request?: SpillRequest): string {
	// Also the caller's question, and answered here anyway: a function named for
	// cutting is the wrong place to discover that it can lengthen a short string
	// by announcing a cut that never happened.
	if (text.length <= limit) return text;
	const { body, header, omitted } = takeApart(text);
	let pointer = header;
	if (!pointer && spill && request) {
		// The guarantee is made here rather than asked of every writer: whatever
		// goes wrong on the way to disk, the call it belongs to returns its result.
		let path: string | null = null;
		try {
			path = spill({ ...request, text: body });
		} catch {
			path = null;
		}
		if (path) pointer = formatSpillHeader(path, body.length);
	}
	// What the result may keep of the output it was given. The pointer line and
	// the notice are both charged on top of this, not out of it, as they always
	// were: a notice that spent part of the text budget would be reporting a
	// missing count that depends on how the notice itself renders, and the same
	// output would then be reported as differently truncated at two budgets.
	const keep = Math.max(0, limit - pointer.length);
	// Split evenly, with the odd character going to the head and the tail taking
	// the floor. That is the whole of the deviation from a plain half each, and
	// it buys the smallest cases for free: at one character of budget — or none
	// — there is nothing to divide, the tail gets nothing, and the cut is exactly
	// the head-only one it used to be. A cut result with an empty head has thrown
	// away the part that was not already at the end.
	const tailChars = body.length > keep ? Math.floor(keep / 2) : 0;
	const head = body.slice(0, keep - tailChars);
	const tail = body.slice(body.length - tailChars);
	// Counted from what survived rather than from `keep`, because `keep` can be
	// larger than the body — a second cut can be asked for more than is left —
	// and because that is the only way the number stays put when the shape of the
	// cut changes. Head and tail together keep exactly `keep` characters, so this
	// is the same total the head-only cut reported for the same input, and a
	// result cut twice by two different limits is still short by one number.
	const missing = omitted + Math.max(0, body.length - head.length - tail.length);
	const marker = formatCutMarker(missing);
	// The notice is its own line rather than glued onto the line the cut lands in.
	// The head is often half a source file and the tail a stack trace, and a
	// notice appended to either would run into it mid-token.
	if (!head) return `${pointer}${marker}`;
	if (!tail) return `${pointer}${head}\n${marker}`;
	return `${pointer}${head}\n${marker}\n${tail}`;
}

/** Bounded by `limit`, spread across the text blocks of one result. */
export function cutContent(
	content: ToolResultContent[],
	limit: number,
	spill?: SpillWriter,
	request?: SpillRequest,
): ToolResultContent[] {
	let used = 0;
	return content.map((block) => {
		if (block.type !== "text") return block;
		const remaining = limit - used;
		if (block.text.length <= remaining) {
			used += block.text.length;
			return block;
		}
		used = limit;
		return { ...block, text: cutText(block.text, Math.max(0, remaining), spill, request) };
	});
}

function resultChars(message: ToolResultMessage): number {
	return message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}

// Long-form design notes: docs/dev/output-limits.md
/** Bound what one round's tool results add to the conversation. */
export function capRoundResults(
	results: ToolResultMessage[],
	spill?: SpillWriter,
	budget: number = MAX_ROUND_RESULT_CHARS,
): ToolResultMessage[] {
	const sizes = results.map(resultChars);
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total <= budget || results.length === 0) return results;

	const floor = Math.min(MIN_ROUND_RESULT_CHARS, Math.floor(budget / results.length));
	const spare = budget - floor * results.length;

	return results.map((result, index) => {
		const size = sizes[index] ?? 0;
		const limit = floor + Math.floor((spare * size) / total);
		if (size <= limit) return result;
		const request: SpillRequest = { callId: result.toolCallId, toolName: result.toolName, text: "" };
		return { ...result, content: cutContent(result.content, limit, spill, request) };
	});
}
