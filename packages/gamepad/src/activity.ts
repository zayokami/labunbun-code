/**
 * What counts as someone deliberately using a pad.
 *
 * Two controllers can be attached at once, and the app reads exactly one of
 * them. Moving the app to the other one is a decision, and the only evidence
 * available is the reports themselves: a rest state, a hand, and a bag all look
 * like "bytes arrived". These thresholds are where that line is drawn.
 *
 * The thresholds are deliberately well past the mapper's deadzone and modifier
 * thresholds. A stick leaning because the pad is on a cushion, or a trigger
 * resting against something, must not take the app from the pad in someone's
 * hands — so the bar is a press worth calling a press, not a deflection that
 * happens to be readable.
 */

import type { PadState } from "./ds4.ts";

/** A stick component this far from centre, on either axis, is a deliberate push. */
export const PAD_SWITCH_STICK = 0.6;

/** A trigger pulled this far is deliberate. XInput has no digital bit to read. */
export const PAD_SWITCH_TRIGGER = 0.5;

/**
 * Consecutive reports before the app moves to a pad.
 *
 * One report is what a jolt in a bag produces; two at a real pad's rate are a
 * few milliseconds, far shorter than the shortest press a person makes. The
 * cost of asking for two is that a tap shorter than two reports can be missed,
 * which is the cheap direction to be wrong in.
 */
export const PAD_SWITCH_REPORTS = 2;

/**
 * Whether this report shows a person using the pad rather than it lying around.
 *
 * The touch surface is deliberately absent: a thumb resting on it produces
 * points on every report, and that is where a thumb lives while the pad is
 * being held — not an intent that should steal the app from the other pad.
 * A touch that means something is a gesture, and gestures are the mapper's
 * business once this pad is already the one being read.
 */
export function padIsActive(state: PadState): boolean {
	if (state.buttons.length > 0) return true;
	if (state.dpad !== null) return true;
	if (state.leftTrigger >= PAD_SWITCH_TRIGGER || state.rightTrigger >= PAD_SWITCH_TRIGGER) return true;
	return [state.leftStick, state.rightStick].some(
		(stick) => Math.abs(stick.x) >= PAD_SWITCH_STICK || Math.abs(stick.y) >= PAD_SWITCH_STICK,
	);
}
