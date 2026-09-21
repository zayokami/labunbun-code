/**
 * The touch surface's gestures, as pure logic over one report at a time.
 *
 * The output is "which gestures are being held *during this report*", and that
 * shape is the whole design: a tap is held for the one report that follows the
 * finger lifting, a drag step is held for the one report it was crossed on, and a
 * report with no finger on the surface holds nothing. That is exactly the edge
 * model the mapper already reads — a press on the report an id appears, a release
 * on the report it is gone — so a gesture needs no new machinery above this file:
 * the same bindings, the same repeat rules, the same `/doctor` validation and the
 * same action stream as a button.
 *
 * Every threshold is in the surface's own units, and every one of them is a
 * guess until the hardware says otherwise: they are named here so that tuning the
 * feel is editing one number and not hunting for it.
 */

import { type Ds4Touch, TOUCH_HEIGHT } from "./ds4.ts";

export type PadTouchId =
	| "touch-tap"
	| "touch-up"
	| "touch-down"
	| "touch-left"
	| "touch-right"
	| "touch-two-left"
	| "touch-two-right";

/**
 * Every gesture, in the order they are checked. A report holds at most one of
 * them — they cannot overlap, so this order only ever settles a tie that the
 * state machine has already made impossible.
 */
export const PAD_TOUCH_IDS: readonly PadTouchId[] = [
	"touch-tap",
	"touch-up",
	"touch-down",
	"touch-left",
	"touch-right",
	"touch-two-left",
	"touch-two-right",
];

/**
 * A gesture id or a button id — the two families of thing a binding can name.
 *
 * A string rather than a `PadTouchId` because its callers hold one of those
 * unions already and narrowing is the point of asking.
 */
export function isPadTouchId(id: string): id is PadTouchId {
	return (PAD_TOUCH_IDS as readonly string[]).includes(id);
}

/** A finger down and up within this long is a tap; anything longer is a press. */
export const TOUCH_TAP_MS = 250;

/** How far a finger may wander and still be a tap, in surface units — about a millimetre. */
export const TOUCH_TAP_SLOP = 48;

/**
 * How far a finger must travel for one step, in surface units: an eighth of the
 * surface's height. One number serves both axes because the surface is about
 * twice as wide as it is tall, which makes a count of units about the same
 * distance whichever way the finger goes. An eighth is a step a thumb can aim
 * for — a comfortable drag across the middle of the pad is three or four of them.
 */
export const TOUCH_STEP = Math.round(TOUCH_HEIGHT / 8);

/**
 * The advantage the axis already in play keeps, so a drag that is a few units
 * off straight does not alternate between two directions.
 *
 * The same number and the same idea as `PAD_STICK_BIAS`, defined here rather
 * than imported because `touch.ts` sits *below* `mapping.ts`: the mapper reads
 * this module's ids, so this module cannot read the mapper's constants back.
 */
export const TOUCH_AXIS_BIAS = 1.25;

export interface PadTouchConfig {
	/** See `TOUCH_TAP_MS`. */
	tapMs?: number;
	/** See `TOUCH_TAP_SLOP`. */
	tapSlop?: number;
	/** See `TOUCH_STEP`, which is also the distance a two-finger slide must cover. */
	step?: number;
	/** See `TOUCH_AXIS_BIAS`. */
	bias?: number;
}

export interface PadTouchReader {
	/**
	 * The gestures held during this report — usually none. Called once per report,
	 * with the report's own timestamp; a caller that skips reports is skipping the
	 * frames a lift is judged on.
	 */
	push(touch: Ds4Touch, now: number): readonly PadTouchId[];
	/** The pad went away. Forget every finger, and say nothing about it. */
	reset(): void;
}

/** One finger, as this layer remembers it. */
interface Finger {
	/** When it landed: what a tap is measured from. */
	at: number;
	startX: number;
	startY: number;
	/** The last position seen, so a lift can still be judged once the point is gone. */
	x: number;
	y: number;
	/**
	 * Where the last step ended. A step is measured from here and not from
	 * `start`, which is what makes a long drag a series of steps rather than one
	 * ever-growing distance.
	 */
	anchorX: number;
	anchorY: number;
	/** Set once this finger has taken part in a two-finger gesture. See `push`. */
	tainted: boolean;
}

/** Two fingers, for as long as both are down. */
interface Swipe {
	/** The midpoint's x when the second finger landed. */
	from: number;
	/**
	 * Set once the swipe has sent its one page. A page is one page however far the
	 * fingers travel, so this fires once rather than per step — a slide across the
	 * whole surface is a gesture, not eight of them.
	 */
	fired: boolean;
}

const NO_GESTURE: readonly PadTouchId[] = [];

/**
 * Where a step points. The surface's y grows *downwards*, which is the opposite
 * of the sticks': index 0 is the negative direction on the axis, index 1 the
 * positive one, and "down" is the positive y.
 */
const STEP_IDS: Readonly<Record<"x" | "y", readonly [PadTouchId, PadTouchId]>> = {
	x: ["touch-left", "touch-right"],
	y: ["touch-up", "touch-down"],
};

/**
 * Read gestures off the surface.
 *
 * The finger is tracked by its presence and not by the pad's touch counter: a
 * counter that incremented per report would end a drag on every report, and no
 * failure mode is worse than a drag that cannot be made. A finger is new when it
 * was not there a report ago, which is also the only definition the pad cannot
 * violate — the data bytes under an absent point are left over from the last
 * touch rather than zeroed, so *this* is where "no finger" has to be decided.
 */
export function createTouchReader(config: PadTouchConfig = {}): PadTouchReader {
	const tapMs = config.tapMs ?? TOUCH_TAP_MS;
	const tapSlop = config.tapSlop ?? TOUCH_TAP_SLOP;
	const step = config.step ?? TOUCH_STEP;
	const bias = config.bias ?? TOUCH_AXIS_BIAS;

	let finger: Finger | undefined;
	let swipe: Swipe | undefined;
	/** The axis the last step went along: the one that keeps `bias` next report. */
	let axis: "x" | "y" | undefined;

	return {
		push(touch, now) {
			const [first, second] = touch;
			// Which of the two points a lone finger is on is the pad's business: it
			// puts the first touch on the first point and the next on the second, so a
			// finger that lands while another is down is reported there — and stays
			// there when the first one lifts. Asking only about `first` would lose it.
			const only = first ?? second;

			if (first !== undefined && second !== undefined) {
				// Two fingers at once is a gesture of its own, and it supersedes whatever
				// one finger was doing: the first finger of a slide has usually already
				// travelled, and reporting that travel as a step would send a move the
				// user never made.
				//
				// Nothing is cleared here for it, and that is not an oversight. While a
				// swipe is running the drag state is never read, and the slide lays the
				// finger it keeps back down on its own — tainted, so it neither steps nor
				// taps — the moment one of the two leaves. A line clearing it here is one
				// no input can act on, which is how it was found.
				if (swipe === undefined) {
					swipe = { from: (first.x + second.x) / 2, fired: false };
					return NO_GESTURE;
				}
				if (swipe.fired) return NO_GESTURE;
				const moved = (first.x + second.x) / 2 - swipe.from;
				if (Math.abs(moved) < step) return NO_GESTURE;
				swipe.fired = true;
				return [moved < 0 ? "touch-two-left" : "touch-two-right"];
			}

			if (only !== undefined) {
				if (swipe !== undefined) {
					// One of the two lifted. The finger still down is not a fresh touch —
					// it has been travelling with its partner — so it gets a new anchor
					// and no tap when it leaves.
					swipe = undefined;
					finger = { ...landed(only, now), tainted: true };
					return NO_GESTURE;
				}
				if (finger === undefined) {
					finger = landed(only, now);
					return NO_GESTURE;
				}
				finger.x = only.x;
				finger.y = only.y;
				if (finger.tainted) return NO_GESTURE;

				const dx = only.x - finger.anchorX;
				const dy = only.y - finger.anchorY;
				const horizontal = Math.abs(dx) * (axis === "x" ? bias : 1);
				const vertical = Math.abs(dy) * (axis === "y" ? bias : 1);
				const along: "x" | "y" = horizontal >= vertical && horizontal > 0 ? "x" : "y";
				const travelled = along === "x" ? dx : dy;
				const steps = Math.floor(Math.abs(travelled) / step);
				if (steps === 0) return NO_GESTURE;

				axis = along;
				const back = travelled < 0;
				const carried = (back ? -1 : 1) * steps * step;
				if (along === "x") {
					finger.anchorX += carried;
					// The other axis starts over from here: travel across a drag's
					// direction is the thumb rolling, not an intent of its own.
					finger.anchorY = only.y;
				} else {
					finger.anchorY += carried;
					finger.anchorX = only.x;
				}
				// One step per report even when the finger crossed several, which keeps a
				// fast flick from arriving as a burst of moves nobody asked for. The
				// distance is not lost: the anchor carries it to the next report.
				return [STEP_IDS[along][back ? 0 : 1]];
			}

			// Nothing is touching the surface.
			if (swipe !== undefined) {
				// Both fingers left in the same report. A slide is never a tap: paging
				// and confirming are far enough apart that one gesture should not be able
				// to mean both.
				swipe = undefined;
				finger = undefined;
				axis = undefined;
				return NO_GESTURE;
			}
			if (finger === undefined) return NO_GESTURE;

			const done = finger;
			finger = undefined;
			axis = undefined;
			if (done.tainted) return NO_GESTURE;
			if (now - done.at > tapMs) return NO_GESTURE;
			if (Math.hypot(done.x - done.startX, done.y - done.startY) > tapSlop) return NO_GESTURE;
			return ["touch-tap"];
		},

		reset() {
			finger = undefined;
			swipe = undefined;
			axis = undefined;
		},
	};
}

/** A finger that has just landed: no travel yet, so nothing to judge. */
function landed(point: { x: number; y: number }, now: number): Finger {
	return {
		at: now,
		startX: point.x,
		startY: point.y,
		x: point.x,
		y: point.y,
		anchorX: point.x,
		anchorY: point.y,
		tainted: false,
	};
}
