/**
 * The close-out note a run leaves for the next one.
 *
 * A mission is the session and everything it is running: the conversation, the
 * background shells, the subagents. Each of those leaves traces of its own in
 * the session file — messages, `shell_start`/`shell_end`, `subagent_start`/
 * `subagent_end` — and each death is diagnosed after the fact from what did
 * not get written. What had no record at all was the ending itself: a run
 * stops, and nothing on file says what it was still holding when it did. The
 * next run could only read the wreckage, with no way to tell "the last run
 * ended with shells still running" from "the last run died with nothing on the
 * books" — and no way at all to tell a normal exit from a crash.
 *
 * So every host writes one `mission` entry when its run ends under its own
 * control: when it ended, why, and the counts it ended with. On resume the next
 * run reads the newest one back and says one line about it — the shells a
 * previous session left, and that `/ps` shows them. The write is best effort
 * and stays best effort: a note that cost the teardown would be worse than a
 * session that closes out in silence. And a run with no controlled ending — a
 * process killed mid-flight — leaves no note at all, which is how a crash is
 * told from an exit.
 *
 * The read side is defensive the way the other ledgers' are: the file is
 * append-only and written line by line, so a note that does not parse costs
 * only itself, and a note without the counts is skipped rather than guessed
 * at. The last valid note wins, because a session can end more than once —
 * quit, resume, quit again — and only the latest ending describes the state
 * the next run is actually inheriting.
 */

/** The session-file kind of a run's close-out. */
export const MISSION_KIND = "mission";

/** What a close-out records: when the run ended, why, and the state it ended with. */
export interface MissionRecord {
	/** The wall clock at teardown. */
	at: number;
	/**
	 * Why the run ended. A controlled end — a normal quit, a `-p` run that
	 * reached its own end, an ACP session whose connection closed — is `"exit"`,
	 * the one value every host writes. A crash writes no note at all, so absence
	 * is the other half of this vocabulary.
	 */
	reason: string;
	/** Background shells this run was still tracking as running at teardown. */
	shellsRunning: number;
	/** Subagents still live at teardown — and gone with the process, like every subagent. */
	subagentsLive: number;
	/**
	 * Recovered shells from earlier runs still unended at teardown, when there
	 * were any. Omitted when zero: the field exists for the case that needs it,
	 * and a zero in every record would be noise on a line read once.
	 */
	shellsRecovered?: number;
}

/** What teardown hands the writer; the writer stamps `at` itself. */
export type MissionCloseout = Omit<MissionRecord, "at">;

/** Where the writer writes — a `SessionStore` satisfies this; so does a stub. */
export interface MissionLedgerSession {
	appendCustom(kind: string, data: unknown): unknown;
}

/** The one shape this module reads out of the session file: a `custom` entry and its payload. */
interface LedgerEntry {
	type: string;
	kind?: string;
	data?: unknown;
}

/**
 * Write the close-out note. Returns the record as written — the same object,
 * `at` stamped — so the caller (and a test) can see exactly what reached the
 * file without reading it back.
 */
export function writeMissionRecord(session: MissionLedgerSession, closeout: MissionCloseout): MissionRecord {
	const record: MissionRecord = { at: Date.now(), ...closeout };
	// See `MissionRecord.shellsRecovered` for why a zero is dropped rather than
	// written.
	if (record.shellsRecovered === 0) delete record.shellsRecovered;
	session.appendCustom(MISSION_KIND, record);
	return record;
}

/**
 * The most recent close-out note, or undefined when the session has none.
 *
 * Scans backwards for the first valid note and stops there: a session that
 * ended twice has two, and the one the next run is inheriting from is the
 * later — the earlier one describes a state that no longer exists. A note
 * that fails validation is passed over, not fatal: it costs its own line and
 * the scan goes on to the next older one.
 */
export function readMissionRecord(session: { linearEntries(): readonly LedgerEntry[] }): MissionRecord | undefined {
	const entries = session.linearEntries();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.kind !== MISSION_KIND) continue;
		const record = missionRecord(entry.data);
		if (record) return record;
	}
	return undefined;
}

/**
 * The one line a resume prints for a close-out, or nothing.
 *
 * Takes the read's own answer, `undefined` included: a session with no note
 * and a note with nothing left to say print the same thing — nothing.
 *
 * Shells only: a run that ended with subagents live is already spoken for by
 * the orphan notice, which names each run — the summary would say the same
 * news in a smaller voice. And nothing at all when nothing was left: a line
 * whose whole content is "the last run ended" is not worth the scroll back.
 *
 * The REPL's line, and only its: the sentence sends the reader to `/ps`, so the
 * two hosts without that command — a `-p` run and an ACP session — read the
 * note but never print this summary. They still write notes of their own,
 * because the next REPL to open the session is the reader this line is for.
 */
export function formatMissionSummary(record: MissionRecord | undefined): string | undefined {
	if (!record) return undefined;
	const shells = record.shellsRunning + (record.shellsRecovered ?? 0);
	if (shells === 0) return undefined;
	return shells === 1
		? "previous session left 1 background shell, see /ps"
		: `previous session left ${shells} background shells, see /ps`;
}

/** A record out of unchecked file data, or null when the counts — the whole point of the note — are not there. */
function missionRecord(data: unknown): MissionRecord | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.at !== "number" || typeof d.reason !== "string") return null;
	if (!count(d.shellsRunning) || !count(d.subagentsLive)) return null;
	const record: MissionRecord = {
		at: d.at,
		reason: d.reason,
		shellsRunning: d.shellsRunning,
		subagentsLive: d.subagentsLive,
	};
	if (count(d.shellsRecovered)) record.shellsRecovered = d.shellsRecovered;
	return record;
}

/** Whether a value is a count a close-out could honestly hold. */
function count(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
