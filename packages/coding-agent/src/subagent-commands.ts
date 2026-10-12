/**
 * `/subagents`, as pure functions: ordering, aging and formatting for the
 * listing, argument resolution, picker rows, and the log renderer. The
 * command in `interactive.ts` is then a thin read of the registry through
 * these, which is where the display questions live — what goes first, how old
 * is old, what one row says, and what the transcript of a run reads like.
 */
import type { ToolResult } from "@labunbun/agent";
import { formatElapsed } from "@labunbun/tui";
import { type SubagentHandle, type SubagentStatus, subagentStatus } from "./subagent-registry.ts";

/**
 * Newest news first: running subagents on top (oldest first, so the order is
 * stable as others end), then the retained finished ones most recently ended
 * first. A listing is read for "what is happening now", and now decays from
 * the top.
 */
export function orderSubagents(handles: SubagentHandle[]): SubagentHandle[] {
	const running = handles.filter((handle) => handle.state === "live").sort((a, b) => a.startedAt - b.startedAt);
	const ended = handles.filter((handle) => handle.state !== "live").sort((a, b) => b.endedAt - a.endedAt);
	return [...running, ...ended];
}

/**
 * How long this subagent has been (or was) alive, for `formatElapsed`.
 *
 * Clamped at zero because a clock can go backwards, and "-3s ago" reads as a
 * bug in the listing rather than in the clock.
 */
export function subagentAgeMs(handle: SubagentHandle, now: number): number {
	return Math.max(0, (handle.finishedAt ?? now) - handle.startedAt);
}

/**
 * The dialog's "who is asking" label for an ask forwarded from a subagent.
 * Built beside the listing so both name the same run the same way: the title
 * the person recognizes, and the full id — the one string SendMessage and
 * TaskStop take — so a stuck ask can be answered and its asker stopped from
 * the same reading.
 */
export function subagentSourceLabel(handle: SubagentHandle): string {
	return `subagent "${handle.title}" (${handle.sidechainId})`;
}

/** The order statuses are grouped and counted in; the lifecycle's own order. */
const STATUS_ORDER: SubagentStatus[] = ["running", "waiting", "completed", "failed", "cancelled"];

/** `2 running, 1 failed` — only the buckets that have anything in them. */
export function subagentCountsLine(handles: SubagentHandle[]): string {
	if (handles.length === 0) return "No subagents have run in this session.";
	const counts = new Map<SubagentStatus, number>();
	for (const handle of handles) {
		const status = subagentStatus(handle);
		counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	const noun = handles.length === 1 ? "subagent" : "subagents";
	const parts = STATUS_ORDER.filter((status) => (counts.get(status) ?? 0) > 0).map(
		(status) => `${counts.get(status)} ${status}`,
	);
	return `${handles.length} ${noun}: ${parts.join(", ")}`;
}

/**
 * The listing: a counts line, then one row per subagent — status, type, age,
 * title, and the full id, because the id is what SendMessage and TaskStop
 * take and this screen is where a person reads one off.
 */
export function formatSubagentList(handles: SubagentHandle[], now: number): string {
	const counts = subagentCountsLine(handles);
	if (handles.length === 0) return counts;
	const rows = orderSubagents(handles).map((handle) => {
		const status = subagentStatus(handle).padEnd(9);
		const type = handle.agentType.padEnd(16);
		const age = formatElapsed(subagentAgeMs(handle, now)).padEnd(8);
		return `  ${status} ${type} ${age} ${handle.title}  (${handle.sidechainId})`;
	});
	return [counts, ...rows].join("\n");
}

/**
 * Fold text to one line and cap its length: pickers and log entries are rows,
 * and a raw newline or a whole file would push everything after it away.
 */
function elideText(text: string, max: number, empty = "(empty)"): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (!oneLine) return empty;
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * The subagent named by an argument: the full `sidechain-…` id, or just its
 * tail, which is the segment a person keeps after reading the listing. The
 * `/stop` shape, for the same reason — the picker shows the full id, people
 * type whatever they remember.
 */
export function resolveSubagentId(arg: string, handles: SubagentHandle[]): SubagentHandle | undefined {
	const wanted = arg.trim().toLowerCase();
	if (!wanted) return undefined;
	return handles.find(
		(handle) => handle.sidechainId.toLowerCase() === wanted || handle.sidechainId.toLowerCase().endsWith(`-${wanted}`),
	);
}

/**
 * One row per subagent for the stop/retry/log pickers, in the listing's own
 * order: the picker is where a person picks what `/subagents` would have
 * shown, so the two screens cannot disagree about the fleet.
 */
export function subagentPickerItems(
	handles: SubagentHandle[],
	now = Date.now(),
): Array<{ label: string; description: string }> {
	return orderSubagents(handles).map((handle) => ({
		label: `${handle.sidechainId}  ${handle.title}`,
		description: [subagentStatus(handle), handle.agentType, formatElapsed(subagentAgeMs(handle, now))].join(" · "),
	}));
}

/** How many messages the log shows before the head is dropped. */
export const LOG_MESSAGE_WINDOW = 40;

/** Longest single log entry rendered before it is elided. */
const LOG_CHARS = 200;

/**
 * What `/subagents log <id>` prints: the retained conversation, oldest first,
 * one entry per message, windowed from the end like a shell's tail — the end
 * of a transcript is where a run's outcome lives.
 *
 * Text is folded to a line and elided; tool calls show their name and
 * arguments, tool results their words and whether they failed. Thinking is
 * left out: the log is what the run said and did, and a reasoning dump would
 * bury both.
 */
export function formatSubagentLog(handle: SubagentHandle, now: number): string {
	const status = subagentStatus(handle);
	const lines = [`${subagentSourceLabel(handle)}: ${status}, ${formatElapsed(subagentAgeMs(handle, now))}`];
	const messages = handle.session.messages;
	const shown = messages.slice(-LOG_MESSAGE_WINDOW);
	if (shown.length < messages.length) {
		lines.push(`  … ${messages.length - shown.length} earlier messages omitted`);
	}
	for (const message of shown) {
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join(" ");
			lines.push(`  user: ${elideText(text, LOG_CHARS)}`);
			continue;
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text.trim()) lines.push(`  assistant: ${elideText(block.text, LOG_CHARS)}`);
				} else if (block.type === "toolCall") {
					lines.push(`  → ${block.name} ${elideText(block.arguments, LOG_CHARS)}`);
				}
			}
			if (message.errorMessage) lines.push(`  (request failed: ${elideText(message.errorMessage, LOG_CHARS)})`);
			continue;
		}
		const text = message.content.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join(" ");
		lines.push(`  ← ${message.toolName}${message.isError ? " (error)" : ""}: ${elideText(text, LOG_CHARS)}`);
	}
	if (lines.length === 1) lines.push("  (no messages)");
	if (handle.notes.length > 0) {
		lines.push("  notes:");
		for (const note of handle.notes) lines.push(`    ${elideText(note, LOG_CHARS)}`);
	}
	return lines.join("\n");
}

/**
 * The transcript note for a retried run that just ended: its ending, or the
 * failure it came back with. One line — this lands in the conversation, not
 * in a panel, and the full story is one `/subagents log` away.
 */
export function formatRetryEnding(sidechainId: string, result: ToolResult): string {
	if (!result.isError) {
		const reason = (result.details as { reason?: string } | undefined)?.reason ?? "error";
		return `Retry of ${sidechainId} ended: ${reason}.`;
	}
	const first = result.content.find((block) => block.type === "text");
	const text = first?.type === "text" ? first.text : "";
	return `Retry of ${sidechainId} failed: ${elideText(text, LOG_CHARS, "(no detail)")}`;
}
