/**
 * What a running tool has printed so far, shaped for a small fixed window under
 * the tool's own row.
 *
 * The window shows the *tail*: for a command still running, the interesting
 * lines are the ones arriving now. A head/tail split (which is what the
 * transcript does once the output is complete) would spend half the window on a
 * banner nobody needs to see twice.
 */
import type { PendingTool } from "./ui-state.ts";

/** Drawn lines per preview, the `… N lines omitted` marker included. */
export const LIVE_OUTPUT_LINES = 6;

/**
 * How many pending tools may show a preview at once. Concurrent Bash calls each
 * stream their own output; without a cap a batch of ten would push the prompt
 * off the screen. The others are still listed by name in the detail row.
 */
export const LIVE_PREVIEW_MAX = 2;

/** Longest line kept intact; beyond this the middle is elided. */
export const LIVE_LINE_CHARS = 200;

export interface LivePreviewTarget {
	callId: string;
	text: string;
}

/**
 * The last `maxLines` lines of a partial stream, newest last.
 *
 * Carriage returns become line breaks: a progress bar redraws on one line with
 * `\r`, and without this the whole run would collapse into a single
 * ever-growing line that the width clamp then eats from both ends.
 */
export function liveOutputLines(text: string, maxLines: number): string[] {
	if (maxLines <= 0) return [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	// "a\n" is a stream mid-line, not a stream sitting on an empty last line —
	// drawing that blank would push a real line out of a six-line window.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	if (lines.length <= maxLines) return lines.map(clampLine);
	if (maxLines === 1) return [clampLine(lines[lines.length - 1])];
	const kept = maxLines - 1;
	return [`… ${lines.length - kept} lines omitted`, ...lines.slice(-kept).map(clampLine)];
}

/**
 * The pending tools worth previewing, oldest first: those that have produced
 * output, capped at `max` from the most recently started. A tool that has not
 * printed anything yet has nothing to show.
 */
export function livePreviewTargets(
	pending: PendingTool[],
	outputs: Record<string, string>,
	max: number = LIVE_PREVIEW_MAX,
): LivePreviewTarget[] {
	const targets: LivePreviewTarget[] = [];
	for (let i = pending.length - 1; i >= 0 && targets.length < max; i--) {
		const text = outputs[pending[i].callId];
		if (text) targets.push({ callId: pending[i].callId, text });
	}
	return targets.reverse();
}

/** Keep both ends of an overlong line; the middle is where the noise is. */
function clampLine(line: string): string {
	if (line.length <= LIVE_LINE_CHARS) return line;
	const half = Math.floor((LIVE_LINE_CHARS - 1) / 2);
	return `${line.slice(0, half)}…${line.slice(-half)}`;
}
