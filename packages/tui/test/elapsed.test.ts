/**
 * The turn clock.
 *
 * Two rules are load-bearing and both are easy to get subtly wrong: the number
 * shown is the turn's, not the current phase's (it used to reset on every
 * thinking → responding → tools switch), and an approval the user is deciding on
 * does not tick — the run is not doing anything, so charging that wait to the
 * turn misreports what the turn cost.
 *
 * The hook that drives this from an interval is covered where it is wired, in
 * the REPL tests; everything decidable without a clock lives here.
 */
import { describe, expect, test } from "bun:test";
import { advanceTimer, formatElapsed, IDLE_TIMER, type TimerState } from "../src/elapsed.ts";

const running = (since: number): TimerState => advanceTimer(IDLE_TIMER, since, { busy: true, frozen: false });
const tick = (state: TimerState, now: number, frozen = false): TimerState =>
	advanceTimer(state, now, { busy: true, frozen });

describe("formatElapsed", () => {
	test("spells durations the way the status row wants them", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(999)).toBe("0s");
		expect(formatElapsed(1000)).toBe("1s");
		expect(formatElapsed(59_000)).toBe("59s");
		expect(formatElapsed(60_000)).toBe("1m 00s");
		expect(formatElapsed(65_000)).toBe("1m 05s");
		expect(formatElapsed(3_599_000)).toBe("59m 59s");
		expect(formatElapsed(3_600_000)).toBe("1h 00m 00s");
		expect(formatElapsed(3_661_000)).toBe("1h 01m 01s");
	});

	test("negative input is clamped rather than spelled with a minus", () => {
		expect(formatElapsed(-5000)).toBe("0s");
	});
});

describe("advanceTimer", () => {
	test("counts wall-clock time while the turn runs", () => {
		const state = tick(running(1000), 4000);
		expect(state.elapsedMs).toBe(3000);
		expect(state.busy).toBe(true);
	});

	test("a new turn starts from zero, not from the last turn's total", () => {
		const first = tick(running(0), 5000);
		expect(first.elapsedMs).toBe(5000);
		const idle = advanceTimer(first, 6000, { busy: false, frozen: false });
		expect(idle).toBe(IDLE_TIMER);
		expect(tick(advanceTimer(idle, 7000, { busy: true, frozen: false }), 7500).elapsedMs).toBe(500);
	});

	test("a freeze banks the segment and holds the display", () => {
		const before = tick(running(0), 4000);
		const frozen = tick(before, 5000, true);
		expect(frozen.elapsedMs).toBe(5000);
		// Still frozen: nothing accrues, however long the dialog stays up.
		expect(tick(frozen, 60_000, true).elapsedMs).toBe(5000);
	});

	test("unfreezing resumes from where it stopped and keeps counting", () => {
		const frozen = tick(tick(running(0), 4000), 5000, true);
		const resumed = tick(tick(frozen, 90_000, true), 90_500, false);
		expect(resumed.elapsedMs).toBe(5000);
		expect(tick(resumed, 91_000).elapsedMs).toBe(5500);
	});

	test("the clock survives a phase change without restarting", () => {
		// What a thinking → responding → tools sequence does: same busy/frozen
		// booleans, later timestamps, one continuous count.
		let state = running(0);
		for (const now of [1000, 2000, 3000]) state = tick(state, now);
		expect(state.elapsedMs).toBe(3000);
	});

	test("an idle timer is returned unchanged so callers can skip the render", () => {
		expect(advanceTimer(IDLE_TIMER, 1234, { busy: false, frozen: false })).toBe(IDLE_TIMER);
	});
});
