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
import type { CompactionTrigger, ContextBreakdown } from "@labunbun/agent";

const LOW_CONTEXT_WARN_FRACTION = 0.8;

/** The numbers a session reports about its own headroom. */
export interface ContextLimits {
	contextWindow: number;
	threshold: number;
	hardLimit: number;
}

/** One compaction, as much of it as a row needs. Store entries fit as they are. */
export interface CompactionHistoryEntry {
	trigger: CompactionTrigger;
	preTokens: number;
	postTokens: number;
}

/**
 * What a session's compactions add up to: how many, and the one in view.
 *
 * Two fields rather than a list, because they come from two different questions
 * — `SessionStore.compactionCount()` counts the file, `compactions()` reads the
 * active chain — and the second can be empty while the first is not.
 */
export interface CompactionHistory {
	/** Summaries this session has paid for, including ones on abandoned branches. */
	count: number;
	/** The most recent one the conversation in hand was shaped by. */
	last?: CompactionHistoryEntry;
}

/** Tokens, shortened the way the rest of the app shortens them (1234 → 1.2k). */
export function formatTokens(tokens: number): string {
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
	options: { memoryChars?: number; compactions?: CompactionHistory } = {},
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
	rows.push(...compactionRows(options.compactions));
	rows.push(
		["Free before auto-compact", formatTokens(Math.max(0, limits.threshold - breakdown.usedTokens))],
		["Reserved beyond that", formatTokens(Math.max(0, limits.hardLimit - limits.threshold))],
	);
	return rows;
}

/**
 * What this session has already spent on compaction, and what it bought.
 *
 * A count with no history is a number a user cannot act on, so the last one
 * carries the two things that decide whether it was worth it: why it ran (the
 * threshold, the provider refusing for size, or the user asking) and the size
 * it moved the context between. Absent when the caller has no store to read,
 * the same way the memory row is absent when there are no memory files — a row
 * about a session file that does not exist would be invented.
 *
 * Zero is shown as something other than zero in one place, and it is an import:
 * a migrated compaction carries no measured `postTokens`, so it says so rather
 * than reporting a size of nothing, which would read as the best pass ever.
 */
function compactionRows(compactions: CompactionHistory | undefined): Array<[string, string]> {
	if (!compactions) return [];
	if (compactions.count === 0) return [["Compactions", "none yet"]];
	const rows: Array<[string, string]> = [["Compactions", `${compactions.count} this session`]];
	const last = compactions.last;
	if (last) {
		const sizes =
			last.postTokens > 0 ? `${formatTokens(last.preTokens)} → ${formatTokens(last.postTokens)}` : "size not recorded";
		rows.push(["Last compaction", `${last.trigger} · ${sizes}`]);
	}
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
 * It leads with what the session will do on its own — the cheap rung runs first,
 * and a summary is only paid for if previews were not enough — because the
 * useful thing to know at 80% is what happens at 100%, not what could be typed.
 * The named commands exist and are checked against the command table: advice is
 * only worth printing if following it works. Cheapest first — `/trim` spends no
 * tokens at all, `/compact` spends one summarization call.
 */
export function lowContextWarning(usedTokens: number, threshold: number): string {
	const percent = threshold > 0 ? Math.min(100, Math.round((usedTokens / threshold) * 100)) : 0;
	return (
		`Context is ${percent}% of the auto-compact point (${formatTokens(usedTokens)} of ${formatTokens(threshold)}). ` +
		"Old tool results become previews before any summary is paid for; /trim does it now, /compact summarizes the conversation."
	);
}

/**
 * How many compactions a session may run before the accuracy warning is worth
 * saying. Low on purpose: the third summary is where a session has stopped
 * being a conversation and started being a summary of one.
 */
export const ACCURACY_NOTICE_AFTER_COMPACTIONS = 3;

/**
 * Said once, when a session has compacted enough times to be worth warning
 * about — and only where there is a real command to name.
 *
 * Compaction is lossy in a way that compounds: each summary is written from the
 * summary before it, so the tenth one is the model's account of its own account
 * of the work. The advice is therefore not "compaction is broken" but "keep
 * sessions short while they are still about one thing" — which is what the
 * reference implementation's warning says, minus its suggestion to start a new
 * thread (this app has no `/new`, and advice that ends in "unknown command" is
 * worse than no advice). `/export` is what exists: the transcript of this
 * session, written out before the user walks away from it.
 */
export const COMPACTION_ACCURACY_NOTICE =
	"Heads up: long conversations and repeated compactions make a model less accurate — it is working from summaries of the work rather than the work itself. " +
	"Start a new session when this task is done, and /export this one first if you want to keep it.";
