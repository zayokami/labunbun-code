/**
 * The subagent runs a previous process did not finish, read back on resume.
 *
 * A subagent lives in memory — its session, its handle, its whole conversation
 * — and dies with the process that spawned it. The session file remembers only
 * what the ledger wrote: a `subagent_start` when a run begins, a
 * `subagent_end` when it ends, however it ends. A start with no end after it is
 * therefore the one honest trace a dead process leaves: a run that began and
 * was never seen to finish, because the thing that would have finished it is
 * gone. There is nothing to revive — a handle lives in memory and a report
 * that was never written cannot be continued — so this module only answers
 * what was left, and the resume notice says it out loud.
 *
 * The pairing key is the sidechain id: created fresh per spawn, written on
 * both kinds of entry, and stable across runs by construction. Continuations
 * (SendMessage) write an end with no start of their own; an end pairs with its
 * sidechain's start wherever the start is, and an end with no start anywhere
 * costs nothing — it invents no run.
 *
 * The read side is defensive the way the shell ledger's is: the file is
 * append-only and written line by line, so a line that does not parse costs
 * only itself, and a record without a usable sidechain id is skipped rather
 * than guessed at.
 */

/** The session-file kind of a run's start; see the module header for why. */
export const SUBAGENT_START_KIND = "subagent_start";
/** The session-file kind of a run's end — a completion, a stop and a failure alike. */
export const SUBAGENT_END_KIND = "subagent_end";

/** One run that began and never was seen to end, as the start entry names it. */
export interface SubagentOrphan {
	sidechainId: string;
	agentType?: string;
}

/** What a resume finds in the ledger. */
export interface SubagentRecovery {
	/** Started, no end on file: the run died with the process that was writing it. */
	orphans: SubagentOrphan[];
}

/** The one shape this module reads out of the session file: a `custom` entry and its payload. */
interface LedgerEntry {
	type: string;
	kind?: string;
	data?: unknown;
}

/**
 * Read the ledger and pair it: what a resume starts from.
 *
 * Two passes over the same list — collects first, then the orphans — so an
 * end is seen no matter where it sits relative to its start's line. Deduped by
 * sidechain id because the id, not the line count, is what names a run: two
 * starts wearing one id are one run, and one end is enough to close it.
 */
export function readSubagentLedger(session: { linearEntries(): readonly LedgerEntry[] }): SubagentRecovery {
	const started = new Map<string, SubagentOrphan>();
	const ended = new Set<string>();
	for (const entry of session.linearEntries()) {
		if (entry.type !== "custom") continue;
		if (entry.kind === SUBAGENT_START_KIND) {
			const start = orphanRecord(entry.data);
			if (start && !started.has(start.sidechainId)) started.set(start.sidechainId, start);
		} else if (entry.kind === SUBAGENT_END_KIND) {
			const end = orphanRecord(entry.data);
			if (end) ended.add(end.sidechainId);
		}
	}
	const orphans: SubagentOrphan[] = [];
	for (const [sidechainId, start] of started) {
		if (!ended.has(sidechainId)) orphans.push(start);
	}
	return { orphans };
}

/**
 * The line a resume prints when the ledger has something to say, or nothing.
 *
 * One line, the same stance as the shell recovery notice: a warning about
 * state the user cannot see yet, not a screen they asked for. Unlike a
 * recovered shell there is no handle in it to type — the ids are there to
 * identify the run in the file, and the sentence that matters is the one
 * saying a subagent cannot be resumed, so nobody waits for a report that
 * cannot arrive.
 */
export function formatSubagentRecovery(recovery: SubagentRecovery): string | undefined {
	if (recovery.orphans.length === 0) return undefined;
	const labels = recovery.orphans.map((orphan) =>
		orphan.agentType ? `${orphan.sidechainId} (${orphan.agentType})` : orphan.sidechainId,
	);
	return recovery.orphans.length === 1
		? `1 subagent run from a previous run never finished: ${labels[0]} — the process it lived in is gone, and a subagent cannot be resumed; start a new Task.`
		: `${recovery.orphans.length} subagent runs from previous runs never finished: ${labels.join(", ")} — the process that ran them is gone, and a subagent cannot be resumed; start a new Task.`;
}

/** A record out of unchecked file data, or null when the sidechain id — the one field pairing needs — is not there. */
function orphanRecord(data: unknown): SubagentOrphan | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.sidechainId !== "string" || d.sidechainId === "") return null;
	return {
		sidechainId: d.sidechainId,
		agentType: typeof d.agentType === "string" && d.agentType !== "" ? d.agentType : undefined,
	};
}
