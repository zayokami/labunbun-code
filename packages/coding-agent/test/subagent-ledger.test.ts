/**
 * The subagent ledger: the runs a dead process left unfinished.
 *
 * A subagent lives in memory and dies with its process, so the session file's
 * start/end pair is the only trace of it either side of that death. The reader
 * exists to find the starts without ends — the runs nobody saw finish — and
 * say so on resume. These tests feed it session entries directly: paired runs
 * stay quiet, unpaired starts surface once per run, and records the write side
 * never makes cost only themselves.
 */
import { describe, expect, test } from "bun:test";
import {
	formatSubagentRecovery,
	readSubagentLedger,
	SUBAGENT_END_KIND,
	SUBAGENT_START_KIND,
} from "../src/subagent-ledger.ts";

/** One `custom` session entry, the shape the ledger writes and reads. */
function custom(kind: string, data: unknown): { type: string; kind: string; data: unknown } {
	return { type: "custom", kind, data };
}

/** A session file stand-in holding exactly these entries. */
function store(entries: Array<{ type: string; kind?: string; data?: unknown }>) {
	return { linearEntries: () => entries };
}

/** A start record with everything filled, as the write side emits it. */
function start(sidechainId: string, agentType = "general-purpose"): Record<string, unknown> {
	return { sidechainId, agentType, prompt: "research the thing" };
}

describe("readSubagentLedger", () => {
	test("a run with its end on file is not an orphan", () => {
		const recovery = readSubagentLedger(
			store([
				custom(SUBAGENT_START_KIND, start("sidechain-a")),
				custom(SUBAGENT_END_KIND, { sidechainId: "sidechain-a", reason: "completed" }),
			]),
		);
		expect(recovery.orphans).toEqual([]);
	});

	test("a start with no end is the trace of a process that died", () => {
		const recovery = readSubagentLedger(store([custom(SUBAGENT_START_KIND, start("sidechain-a"))]));
		expect(recovery.orphans).toEqual([{ sidechainId: "sidechain-a", agentType: "general-purpose" }]);
	});

	test("a continuation's end pairs with the spawn's start — extra ends cost nothing", () => {
		// SendMessage writes an end with no start of its own: the sidechain was
		// already closed out by the spawn run's end, and a second end is just
		// another finished run on the same id, not an orphan.
		const recovery = readSubagentLedger(
			store([
				custom(SUBAGENT_END_KIND, { sidechainId: "sidechain-a", reason: "completed" }),
				custom(SUBAGENT_START_KIND, start("sidechain-a")),
				custom(SUBAGENT_END_KIND, { sidechainId: "sidechain-a", reason: "error" }),
			]),
		);
		expect(recovery.orphans).toEqual([]);
	});

	test("pairing is per sidechain id: one id's end does not close another's start", () => {
		const recovery = readSubagentLedger(
			store([
				custom(SUBAGENT_START_KIND, start("sidechain-a")),
				custom(SUBAGENT_START_KIND, start("sidechain-b", "explore")),
				custom(SUBAGENT_END_KIND, { sidechainId: "sidechain-b", reason: "completed" }),
			]),
		);
		expect(recovery.orphans).toEqual([{ sidechainId: "sidechain-a", agentType: "general-purpose" }]);
	});

	test("an end with no start anywhere pairs with nothing and invents no run", () => {
		const recovery = readSubagentLedger(store([custom(SUBAGENT_END_KIND, { sidechainId: "sidechain-ghost" })]));
		expect(recovery.orphans).toEqual([]);
	});

	test("two starts wearing one id are one run, reported once", () => {
		const recovery = readSubagentLedger(
			store([custom(SUBAGENT_START_KIND, start("sidechain-a")), custom(SUBAGENT_START_KIND, start("sidechain-a"))]),
		);
		expect(recovery.orphans).toHaveLength(1);
	});

	test("entries that are not the ledger's, and records without an id, cost only themselves", () => {
		const recovery = readSubagentLedger(
			store([
				{ type: "message" },
				custom(SUBAGENT_START_KIND, null),
				custom(SUBAGENT_START_KIND, {}),
				custom(SUBAGENT_START_KIND, { sidechainId: 7 }),
				custom(SUBAGENT_START_KIND, { sidechainId: "" }),
				custom(SUBAGENT_END_KIND, null),
				custom(SUBAGENT_START_KIND, start("sidechain-ok")),
			]),
		);
		expect(recovery.orphans).toEqual([{ sidechainId: "sidechain-ok", agentType: "general-purpose" }]);
	});
});

describe("formatSubagentRecovery", () => {
	test("nothing to say is nothing, not an empty line", () => {
		expect(formatSubagentRecovery({ orphans: [] })).toBeUndefined();
	});

	test("one run is named with its type, and says it cannot be resumed", () => {
		const line = formatSubagentRecovery({ orphans: [{ sidechainId: "sidechain-a", agentType: "general-purpose" }] });
		expect(line).toContain("sidechain-a (general-purpose)");
		expect(line).toContain("never finished");
		expect(line).toContain("cannot be resumed");
		expect(line).toContain("start a new Task");
	});

	test("a start that recorded no type is still named, without an empty parenthesis", () => {
		const line = formatSubagentRecovery({ orphans: [{ sidechainId: "sidechain-a" }] });
		expect(line).toContain("sidechain-a");
		expect(line).not.toContain("()");
	});

	test("several runs are counted, plural, and listed", () => {
		const line = formatSubagentRecovery({
			orphans: [
				{ sidechainId: "sidechain-a", agentType: "general-purpose" },
				{ sidechainId: "sidechain-b", agentType: "explore" },
			],
		});
		expect(line).toContain("2 subagent runs");
		expect(line).toContain("sidechain-a (general-purpose)");
		expect(line).toContain("sidechain-b (explore)");
	});
});
