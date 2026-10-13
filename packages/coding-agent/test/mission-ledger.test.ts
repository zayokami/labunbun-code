/**
 * The mission close-out: what teardown writes, what the next run reads, and
 * the one line it says about it.
 *
 * The record's whole job is the gap between two runs, so the tests are split
 * the same way the other ledgers' are: the write side is fed fake sessions and
 * asserted on what reached the file, and the read side is fed entries and
 * asserted on what comes back — including the defensive answers, because the
 * file is unchecked input by the time it is read: a note without its counts
 * costs only itself, the newest note wins in a session that ended more than
 * once, and a malformed newest does not hide a good older one.
 */
import { describe, expect, test } from "bun:test";
import { formatMissionSummary, MISSION_KIND, readMissionRecord, writeMissionRecord } from "../src/mission-ledger.ts";

/** A session-file entry as the ledger reads it. */
interface Entry {
	type: string;
	kind?: string;
	data?: unknown;
}

/** One `custom` mission entry. */
function mission(data: unknown): Entry {
	return { type: "custom", kind: MISSION_KIND, data };
}

/** A session-file stand-in holding exactly these entries. */
function store(entries: Entry[]): { linearEntries(): readonly Entry[] } {
	return { linearEntries: () => entries };
}

/** A session stand-in that records what is written to it, in file-entry shape. */
function writingStore(): {
	entries: Entry[];
	session: { appendCustom(kind: string, data: unknown): void };
} {
	const entries: Entry[] = [];
	return {
		entries,
		session: {
			appendCustom(kind, data) {
				entries.push({ type: "custom", kind, data });
			},
		},
	};
}

describe("writeMissionRecord", () => {
	test("one mission entry, with the closeout's counts and the writer's clock", () => {
		const { entries, session } = writingStore();
		const before = Date.now();
		const record = writeMissionRecord(session, {
			reason: "exit",
			shellsRunning: 2,
			subagentsLive: 1,
			shellsRecovered: 3,
		});
		const after = Date.now();

		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe(MISSION_KIND);
		// The caller gets back exactly what reached the file, not a copy.
		expect(entries[0]?.data).toBe(record);
		expect(record.reason).toBe("exit");
		expect(record.shellsRunning).toBe(2);
		expect(record.subagentsLive).toBe(1);
		expect(record.shellsRecovered).toBe(3);
		expect(record.at).toBeGreaterThanOrEqual(before);
		expect(record.at).toBeLessThanOrEqual(after);
	});

	test("a zero recovered count is left out — a field that only says none is noise", () => {
		const { entries, session } = writingStore();
		const record = writeMissionRecord(session, {
			reason: "exit",
			shellsRunning: 0,
			subagentsLive: 0,
			shellsRecovered: 0,
		});

		expect(record).not.toHaveProperty("shellsRecovered");
		expect(entries[0]?.data).not.toHaveProperty("shellsRecovered");
	});

	test("the written shape is the read shape — round trip through a store", () => {
		// The two sides are separate functions with the file between them, so a
		// writer that stamps an unreadable shape would pass every test above.
		const { entries, session } = writingStore();
		writeMissionRecord(session, { reason: "exit", shellsRunning: 1, subagentsLive: 0, shellsRecovered: 2 });

		const read = readMissionRecord(store(entries));

		expect(read?.reason).toBe("exit");
		expect(read?.shellsRunning).toBe(1);
		expect(read?.subagentsLive).toBe(0);
		expect(read?.shellsRecovered).toBe(2);
	});
});

describe("readMissionRecord", () => {
	test("the newest close-out wins — a session that ended twice inherits the later ending", () => {
		const record = readMissionRecord(
			store([
				mission({ at: 1, reason: "exit", shellsRunning: 1, subagentsLive: 0 }),
				mission({ at: 2, reason: "exit", shellsRunning: 4, subagentsLive: 2, shellsRecovered: 1 }),
			]),
		);

		expect(record?.at).toBe(2);
		expect(record?.shellsRunning).toBe(4);
		expect(record?.subagentsLive).toBe(2);
		expect(record?.shellsRecovered).toBe(1);
	});

	test("a session with no note is undefined — and other kinds are not notes", () => {
		expect(readMissionRecord(store([]))).toBeUndefined();
		expect(readMissionRecord(store([{ type: "message" }]))).toBeUndefined();
		expect(
			readMissionRecord(store([{ type: "custom", kind: "shell_start", data: { at: 1, reason: "exit" } }])),
		).toBeUndefined();
	});

	test("a note without its counts costs only itself — the scan keeps looking and never throws", () => {
		expect(readMissionRecord(store([mission(null)]))).toBeUndefined();
		expect(readMissionRecord(store([mission("exit")]))).toBeUndefined();
		expect(readMissionRecord(store([mission({ at: 1 })]))).toBeUndefined();
		expect(
			readMissionRecord(store([mission({ at: 1, reason: "exit", shellsRunning: "2", subagentsLive: 0 })])),
		).toBeUndefined();
		expect(
			readMissionRecord(store([mission({ at: 1, reason: "exit", shellsRunning: -1, subagentsLive: 0 })])),
		).toBeUndefined();
		expect(
			readMissionRecord(store([mission({ at: 1, reason: "exit", shellsRunning: 1.5, subagentsLive: 0 })])),
		).toBeUndefined();
	});

	test("a malformed newest does not hide a good older one behind it", () => {
		const older = { at: 1, reason: "exit", shellsRunning: 1, subagentsLive: 0 };
		const record = readMissionRecord(store([mission(older), mission({ at: 2 })]));

		expect(record?.at).toBe(1);
		expect(record?.shellsRunning).toBe(1);
	});

	test("a shellsRecovered that is not a count is dropped, and the note still reads", () => {
		const record = readMissionRecord(
			store([mission({ at: 1, reason: "exit", shellsRunning: 0, subagentsLive: 0, shellsRecovered: "many" })]),
		);

		expect(record?.at).toBe(1);
		expect(record).not.toHaveProperty("shellsRecovered");
	});
});

describe("formatMissionSummary", () => {
	test("shells left are named, plural or not, with the command that shows them", () => {
		expect(formatMissionSummary({ at: 1, reason: "exit", shellsRunning: 1, subagentsLive: 0 })).toBe(
			"previous session left 1 background shell, see /ps",
		);
		expect(formatMissionSummary({ at: 1, reason: "exit", shellsRunning: 2, subagentsLive: 0 })).toBe(
			"previous session left 2 background shells, see /ps",
		);
	});

	test("recovered shells still unended count as left too", () => {
		expect(
			formatMissionSummary({ at: 1, reason: "exit", shellsRunning: 0, subagentsLive: 0, shellsRecovered: 2 }),
		).toBe("previous session left 2 background shells, see /ps");
		expect(
			formatMissionSummary({ at: 1, reason: "exit", shellsRunning: 1, subagentsLive: 0, shellsRecovered: 1 }),
		).toBe("previous session left 2 background shells, see /ps");
	});

	test("nothing left is nothing to say", () => {
		expect(formatMissionSummary({ at: 1, reason: "exit", shellsRunning: 0, subagentsLive: 0 })).toBeUndefined();
		// And no note at all says the same nothing — the call site passes the
		// read's answer straight through, `undefined` included.
		expect(formatMissionSummary(readMissionRecord(store([])))).toBeUndefined();
	});

	test("live subagents alone say nothing here — the orphan notice names them one by one", () => {
		expect(formatMissionSummary({ at: 1, reason: "exit", shellsRunning: 0, subagentsLive: 3 })).toBeUndefined();
	});
});
