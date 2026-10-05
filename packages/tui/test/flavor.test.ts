/**
 * The status row's flavor: the done-verb table, the thinking word ladder, and
 * the footer's spelling.
 *
 * All pure — the rng and the durations are arguments, so the boundaries are
 * hand-fed milliseconds rather than a test that waits forty-five seconds. The
 * clocks that drive these live in the REPL tests.
 */
import { describe, expect, test } from "bun:test";
import { DONE_VERBS, formatDoneLine, pickDoneVerb, thinkingWord } from "../src/flavor.ts";

describe("the done-verb table", () => {
	test("is a table of distinct verbs", () => {
		expect(DONE_VERBS.length).toBeGreaterThan(1);
		expect(new Set(DONE_VERBS).size).toBe(DONE_VERBS.length);
		for (const verb of DONE_VERBS) expect(verb).toMatch(/^[A-Z][a-z]+$/);
	});

	test("the pick walks the table and stays inside it for any legitimate roll", () => {
		expect(pickDoneVerb(() => 0)).toBe(DONE_VERBS[0]);
		expect(pickDoneVerb(() => 0.999_999)).toBe(DONE_VERBS[DONE_VERBS.length - 1]);
		for (let i = 0; i < DONE_VERBS.length; i++) {
			const insideCell = (i + 0.5) / DONE_VERBS.length;
			expect(pickDoneVerb(() => insideCell)).toBe(DONE_VERBS[i]);
		}
	});

	test("a random source that breaks its contract still yields a plausible word", () => {
		// [0, 1) is the contract; 1 itself would index one past the table.
		expect(pickDoneVerb(() => 1)).toBe("Played");
	});
});

describe("the thinking word ladder", () => {
	test("climbs at ten and forty-five seconds", () => {
		expect(thinkingWord(0)).toBe("Thinking…");
		expect(thinkingWord(9_999)).toBe("Thinking…");
		expect(thinkingWord(10_000)).toBe("Still composing");
		expect(thinkingWord(44_999)).toBe("Still composing");
		expect(thinkingWord(45_000)).toBe("Deep in the groove");
		expect(thinkingWord(600_000)).toBe("Deep in the groove");
	});

	test("the base word is what the row has always said", () => {
		// The status row shows this until the ladder takes over; a rename here
		// without one there would flip the label at the ten-second mark only.
		expect(thinkingWord(0)).toBe("Thinking…");
	});
});

describe("the finished-run footer", () => {
	test("spells the verb and the duration the way the status row spells time", () => {
		expect(formatDoneLine("Composed", 0)).toBe("♪ Composed for 0s");
		expect(formatDoneLine("Grooved", 65_000)).toBe("♪ Grooved for 1m 05s");
		expect(formatDoneLine("Mastered", 3_661_000)).toBe("♪ Mastered for 1h 01m 01s");
	});
});
