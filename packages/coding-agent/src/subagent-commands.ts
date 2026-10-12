/**
 * `/subagents`, as pure functions: ordering, aging and formatting for the
 * listing. The command in `interactive.ts` is then a thin read of the
 * registry through these, which is where the display questions live — what
 * goes first, how old is old, and what one row says.
 */
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
