/**
 * The surface's feel, fed one report at a time.
 *
 * Every test here hands the reader a touch state and a timestamp, because that is
 * the whole design: like the mapper, this layer has no clock of its own, so a
 * swipe takes a microsecond to perform and a tap can be held for exactly 250
 * milliseconds. The states are hand-made rather than parsed from bytes —
 * `ds4.test.ts` is what pins the wire format, and this file should fail when the
 * *gestures* change, not when a report layout does.
 */

import { describe, expect, test } from "bun:test";
import {
	createTouchReader,
	type Ds4Touch,
	type Ds4TouchPoint,
	PAD_TOUCH_IDS,
	type PadTouchId,
	type PadTouchReader,
	TOUCH_STEP,
	TOUCH_TAP_MS,
	TOUCH_TAP_SLOP,
} from "../src/index.ts";

/** Nobody is touching the surface. */
const NONE: Ds4Touch = [undefined, undefined];

function point(x: number, y: number, id = 0): Ds4TouchPoint {
	return { id, x, y };
}

/** One finger, on whichever point the test wants it. The second is the default. */
function one(x: number, y: number, second = false): Ds4Touch {
	return second ? [undefined, point(x, y)] : [point(x, y), undefined];
}

function two(x1: number, y1: number, x2: number, y2: number): Ds4Touch {
	return [point(x1, y1, 0), point(x2, y2, 1)];
}

function reader(): PadTouchReader {
	return createTouchReader();
}

describe("a tap", () => {
	test("arrives on the report where the finger is already gone, and once", () => {
		// Not on the press: the mapper reads presence, so a gesture has to be *held*
		// for a report to become one, and the report that says "the finger was here
		// and now is not" is the lift's.
		const touch = reader();
		expect(touch.push(one(500, 400), 0)).toEqual([]);
		expect(touch.push(one(495, 402), 60)).toEqual([]);
		expect(touch.push(NONE, 100)).toEqual(["touch-tap"]);
		expect(touch.push(NONE, 104)).toEqual([]);
	});

	test("is measured in time: the 250 ms a thumb takes, and not much longer", () => {
		const quick = reader();
		quick.push(one(500, 400), 0);
		expect(quick.push(NONE, TOUCH_TAP_MS)).toEqual(["touch-tap"]);

		const slow = reader();
		slow.push(one(500, 400), 0);
		expect(slow.push(NONE, TOUCH_TAP_MS + 1)).toEqual([]);
	});

	test("allows the few units a thumb moves while tapping", () => {
		const touch = reader();
		touch.push(one(500, 400), 0);
		expect(touch.push(one(520, 405), 50)).toEqual([]);
		expect(touch.push(NONE, 90)).toEqual(["touch-tap"]);
	});

	test("is refused once the finger has travelled for real", () => {
		// A drag that never reached a step is still not a tap: the slop is what
		// separates "rested" from "moved", and it is smaller than a step.
		const touch = reader();
		touch.push(one(500, 400), 0);
		expect(touch.push(one(500 + TOUCH_TAP_SLOP + 1, 400), 40)).toEqual([]);
		expect(touch.push(NONE, 80)).toEqual([]);
	});

	test("is refused after a step, however still the finger then held", () => {
		const touch = reader();
		touch.push(one(500, 400), 0);
		expect(touch.push(one(500 + TOUCH_STEP, 400), 20)).toEqual(["touch-right"]);
		expect(touch.push(NONE, 40)).toEqual([]);
	});

	test("comes off the second point exactly as it does the first", () => {
		// Which of the two a finger landed on is the pad's business, and the pad
		// renumbers them; the reader only ever asks whether *a* finger is there.
		const touch = reader();
		expect(touch.push(one(700, 300, true), 0)).toEqual([]);
		expect(touch.push(one(705, 300, true), 60)).toEqual([]);
		expect(touch.push(NONE, 80)).toEqual(["touch-tap"]);
	});
});

describe("a drag", () => {
	test("sends one step per eighth of the surface, and nothing in between", () => {
		const touch = reader();
		expect(touch.push(one(100, 500), 0)).toEqual([]);
		expect(touch.push(one(100 + TOUCH_STEP - 1, 500), 4)).toEqual([]);
		expect(touch.push(one(100 + TOUCH_STEP, 500), 8)).toEqual(["touch-right"]);
		expect(touch.push(one(100 + TOUCH_STEP + 5, 500), 12)).toEqual([]);
		expect(touch.push(one(100 + 2 * TOUCH_STEP, 500), 16)).toEqual(["touch-right"]);
	});

	test("sends one step a report however fast the finger goes", () => {
		// A flick crosses several steps at once. They are not queued: at 250 Hz a
		// queue would arrive as a burst of moves a frame after the finger stopped,
		// which reads as the app running on after the user let go. The distance is
		// not lost either — the anchor carries it.
		const touch = reader();
		touch.push(one(0, 500), 0);
		expect(touch.push(one(1000, 500), 4)).toEqual(["touch-right"]);
		// 1000 units is eight steps; seven of them are still owed to the next move.
		expect(touch.push(one(1000 + TOUCH_STEP, 500), 8)).toEqual(["touch-right"]);
	});

	test("turning around sends the other way as soon as it has come back a step", () => {
		const touch = reader();
		touch.push(one(500, 500), 0);
		expect(touch.push(one(500 + 2 * TOUCH_STEP, 500), 4)).toEqual(["touch-right"]);
		expect(touch.push(one(500 + TOUCH_STEP, 500), 8)).toEqual(["touch-left"]);
	});

	test("keeps one direction when the drag is diagonal", () => {
		// The axis already in play keeps an advantage, and the other axis starts over
		// each time a step lands: a thumb going down-and-right at forty-five degrees
		// is going one way, not two.
		const touch = reader();
		touch.push(one(100, 100), 0);
		expect(touch.push(one(100 + 158, 100 + 158), 4)).toEqual(["touch-right"]);
		expect(touch.push(one(100 + 316, 100 + 316), 8)).toEqual(["touch-right"]);
		expect(touch.push(one(100 + 474, 100 + 474), 12)).toEqual(["touch-right"]);
	});

	test("reports the surface's own y, which grows downwards", () => {
		// The opposite of the sticks, and the one place in this package where a
		// positive number means down.
		const touch = reader();
		touch.push(one(500, 100), 0);
		expect(touch.push(one(500, 100 + TOUCH_STEP), 4)).toEqual(["touch-down"]);
		expect(touch.push(one(500, 100), 8)).toEqual(["touch-up"]);
	});

	test("says nothing while the finger rests on the pad", () => {
		const touch = reader();
		expect(touch.push(one(500, 400), 0)).toEqual([]);
		for (let at = 4; at < 1000; at += 4) expect(touch.push(one(500, 400), at)).toEqual([]);
	});

	test("does not end when the pad renumbers which point the finger is on", () => {
		// A finger is new when it was not there a report ago. The counter is carried
		// for the readback, not for tracking: a pad that incremented it per report
		// would end every drag on its second frame.
		const touch = reader();
		touch.push(one(1000, 500), 0);
		expect(touch.push([undefined, point(1000 + TOUCH_STEP, 500, 7)], 4)).toEqual(["touch-right"]);
	});
});

describe("two fingers", () => {
	test("slide right for one page, once, however far they go", () => {
		const touch = reader();
		expect(touch.push(two(400, 300, 600, 300), 0)).toEqual([]);
		expect(touch.push(two(450, 300, 650, 300), 4)).toEqual([]);
		expect(touch.push(two(520, 300, 720, 300), 8)).toEqual(["touch-two-right"]);
		expect(touch.push(two(900, 300, 1100, 300), 12)).toEqual([]);
		expect(touch.push(NONE, 16)).toEqual([]);
	});

	test("slide left the same way", () => {
		const touch = reader();
		touch.push(two(1000, 300, 1200, 300), 0);
		expect(touch.push(two(880, 300, 1080, 300), 4)).toEqual(["touch-two-left"]);
		expect(touch.push(NONE, 8)).toEqual([]);
	});

	test("down and up in place is nothing at all — a slide is not a tap", () => {
		const touch = reader();
		expect(touch.push(two(500, 300, 700, 300), 0)).toEqual([]);
		expect(touch.push(two(500, 300, 700, 300), 100)).toEqual([]);
		expect(touch.push(NONE, 120)).toEqual([]);
	});

	test("cancel whatever one finger was doing", () => {
		// The first finger of a slide has usually already travelled; reporting that
		// travel as a step would send a move the user never made.
		const touch = reader();
		touch.push(one(400, 300), 0);
		expect(touch.push(one(400 + TOUCH_STEP, 300), 4)).toEqual(["touch-right"]);
		expect(touch.push(two(400 + TOUCH_STEP, 300, 800, 300), 8)).toEqual([]);
		expect(touch.push(two(400 + 2 * TOUCH_STEP, 300, 800 + TOUCH_STEP, 300), 12)).toEqual(["touch-two-right"]);
	});

	test("leave the finger behind them inert until it lifts", () => {
		const touch = reader();
		touch.push(two(400, 300, 600, 300), 0);
		expect(touch.push(two(520, 300, 720, 300), 4)).toEqual(["touch-two-right"]);
		// One lifts. The one still down has been travelling with its partner: it is
		// not a fresh touch, and it is not a tap when it goes either.
		expect(touch.push(one(520, 300), 8)).toEqual([]);
		expect(touch.push(one(520 + 3 * TOUCH_STEP, 300), 12)).toEqual([]);
		expect(touch.push(NONE, 16)).toEqual([]);
	});

	test("never come from one finger, however far it drags", () => {
		const touch = reader();
		touch.push(one(0, 500), 0);
		const out = [touch.push(one(900, 500), 4), touch.push(one(1800, 500), 8), touch.push(NONE, 12)];
		for (const report of out) expect(report.filter((id) => id.startsWith("touch-two"))).toEqual([]);
	});
});

describe("a pad that goes away", () => {
	test("is forgotten: the tap it was holding back never arrives", () => {
		const touch = reader();
		touch.push(one(500, 500), 0);
		touch.push(one(510, 505), 100);
		touch.reset();
		// Without the reset this would be the lift of a 100 ms touch — a confirm
		// invented by a pad that was asleep when the finger came off it.
		expect(touch.push(NONE, 900)).toEqual([]);
	});

	test("starts over: the next finger is a new one", () => {
		const touch = reader();
		touch.push(one(500, 500), 0);
		touch.reset();
		expect(touch.push(one(500, 500), 900)).toEqual([]);
		expect(touch.push(NONE, 950)).toEqual(["touch-tap"]);
	});
});

describe("the thresholds", () => {
	test("are the caller's to set, so a test or a tuning pass can move them", () => {
		const touch = createTouchReader({ step: 4, tapSlop: 0, tapMs: 10 });
		touch.push(one(500, 500), 0);
		expect(touch.push(one(504, 500), 1)).toEqual(["touch-right"]);
		expect(touch.push(NONE, 5)).toEqual([]);
	});
});

describe("the id family", () => {
	test("is the list the bindings are checked against, in a fixed order", () => {
		expect(new Set(PAD_TOUCH_IDS).size).toBe(PAD_TOUCH_IDS.length);
		expect([...PAD_TOUCH_IDS]).toEqual([
			"touch-tap",
			"touch-up",
			"touch-down",
			"touch-left",
			"touch-right",
			"touch-two-left",
			"touch-two-right",
		] satisfies PadTouchId[]);
	});
});
