/**
 * `/context`: what the next request carries, and how much of it is left.
 *
 * The status row answers "how full is this" in one number; the question that
 * number raises — full of *what*, and is there anything to do about it — is
 * this card. One row is actionable by a command that exists: tool results
 * (`/trim` previews the old ones without a model call). Memory gets a row of
 * its own not because a command acts on it but because it is the part of the
 * prompt the user wrote, and a size is only useful next to what it is made of.
 *
 * The rows are formatted here and the drawing is the TUI's, the same split as
 * `/status`: this layer knows what the numbers mean, the card knows how rows
 * look.
 */
import type { ContextBreakdown } from "@labunbun/agent";

const LOW_CONTEXT_WARN_FRACTION = 0.8;

/** The numbers a session reports about its own headroom. */
export interface ContextLimits {
	contextWindow: number;
	threshold: number;
	hardLimit: number;
}

/** Tokens, shortened the way the rest of the app shortens them (1234 → 1.2k). */
function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

/**
 * The card's rows, in reading order: what the context is made of, then what is
 * left, then what is held back.
 *
 * `free` is measured to the threshold — the point where the session acts — and
 * the reserve is what sits between there and the model's own refusal. Showing
 * only one of the two would answer half the question: "how much can I still
 * write" and "what happens if I do".
 */
export function contextRows(
	breakdown: ContextBreakdown,
	limits: ContextLimits,
	options: { memoryChars?: number } = {},
): Array<[string, string]> {
	const rows: Array<[string, string]> = [
		["System prompt", formatTokens(breakdown.systemPromptTokens)],
		["Tool schemas", formatTokens(breakdown.toolSchemaTokens)],
		[
			"Messages",
			`${formatTokens(breakdown.messageTokens)}${
				breakdown.toolResultCount > 0
					? ` (of which ${formatTokens(breakdown.toolResultTokens)} in ${breakdown.toolResultCount} tool result${
							breakdown.toolResultCount === 1 ? "" : "s"
						})`
					: ""
			}`,
		],
	];
	if (options.memoryChars && options.memoryChars > 0) {
		// A section of the system prompt, so it is already inside the row above —
		// saying so is the point: the row is not a second helping of the same
		// tokens, it is the part of that prompt the user owns and can edit.
		rows.push(["Memory", `${formatTokens(Math.ceil(options.memoryChars / 4))} (part of the system prompt)`]);
	}
	rows.push(
		["Free before auto-compact", formatTokens(Math.max(0, limits.threshold - breakdown.usedTokens))],
		["Reserved beyond that", formatTokens(Math.max(0, limits.hardLimit - limits.threshold))],
	);
	return rows;
}

/** The one line `/context` leaves in the transcript, where the card cannot scroll. */
export function contextSummaryLine(breakdown: ContextBreakdown, limits: ContextLimits): string {
	const percentOf = limits.threshold > 0 ? Math.round((breakdown.usedTokens / limits.threshold) * 100) : 0;
	return (
		`Context: ${percentOf}% of the auto-compact point ` +
		`(${formatTokens(breakdown.usedTokens)} of ${formatTokens(limits.threshold)}; ${formatTokens(
			Math.max(0, limits.threshold - breakdown.usedTokens),
		)} free).`
	);
}

/**
 * Whether the session is close enough to the auto-compact point to say so.
 *
 * Close to, not over: crossing it is not a failure, it is the mechanism
 * working, and the user's options — trim, or compact now — are worth the same
 * whether the crossing is a turn away or has just happened. Nothing warns after
 * the fact: the compaction notice is the after.
 */
export function isContextLow(usedTokens: number, threshold: number): boolean {
	if (threshold <= 0) return false;
	return usedTokens >= threshold * LOW_CONTEXT_WARN_FRACTION;
}

/**
 * The warning itself, naming what a user can do about it.
 *
 * Both named commands exist and are checked against the command table: advice
 * is only worth printing if following it works. Cheapest first — `/trim` spends
 * no tokens at all, `/compact` spends one summarization call.
 */
export function lowContextWarning(usedTokens: number, threshold: number): string {
	const percent = threshold > 0 ? Math.min(100, Math.round((usedTokens / threshold) * 100)) : 0;
	return (
		`Context is ${percent}% of the auto-compact point (${formatTokens(usedTokens)} of ${formatTokens(threshold)}). ` +
		"/trim replaces old tool results with previews for free; /compact summarizes the conversation now."
	);
}
