/**
 * When a pad's report counts as someone using it.
 *
 * This predicate is the only evidence the app has when two controllers are
 * attached and it has to choose one. A report arriving is not evidence — a pad
 * on a cushion, a bag, and a table all keep reporting — so the thresholds are
 * the whole decision, and each of them is pinned here rather than inferred from
 * a service test that happens to press the right button.
 *
 * The touch surface is deliberately outside the predicate. It is a resting
 * place for a thumb, not a control someone presses; including it would let a
 * pad lying under a hand take the app from the pad being played.
 */

import { describe, expect, test } from "bun:test";
import { PAD_SWITCH_STICK, PAD_SWITCH_TRIGGER, type PadState, padIsActive } from "../src/index.ts";

function state(patch: Partial<PadState> = {}): PadState {
	return {
		leftStick: { x: 0, y: 0 },
		rightStick: { x: 0, y: 0 },
		leftTrigger: 0,
		rightTrigger: 0,
		dpad: null,
		buttons: [],
		battery: { level: 3, cable: false },
		...patch,
	};
}

describe("padIsActive", () => {
	test("rest is not use", () => {
		expect(padIsActive(state())).toBe(false);
	});

	test("any button is a press", () => {
		expect(padIsActive(state({ buttons: ["cross"] }))).toBe(true);
	});

	test("a d-pad direction counts, whichever it is", () => {
		expect(padIsActive(state({ dpad: "up" }))).toBe(true);
		expect(padIsActive(state({ dpad: "down-left" }))).toBe(true);
	});

	test("a trigger counts at the threshold and not below it", () => {
		expect(padIsActive(state({ leftTrigger: PAD_SWITCH_TRIGGER }))).toBe(true);
		expect(padIsActive(state({ rightTrigger: PAD_SWITCH_TRIGGER }))).toBe(true);
		expect(padIsActive(state({ leftTrigger: PAD_SWITCH_TRIGGER - 0.01 }))).toBe(false);
		expect(padIsActive(state({ rightTrigger: PAD_SWITCH_TRIGGER - 0.01 }))).toBe(false);
	});

	test("a stick counts past the threshold on either axis, in either direction", () => {
		expect(padIsActive(state({ leftStick: { x: PAD_SWITCH_STICK, y: 0 } }))).toBe(true);
		expect(padIsActive(state({ rightStick: { x: 0, y: -PAD_SWITCH_STICK } }))).toBe(true);
		expect(padIsActive(state({ leftStick: { x: 0, y: PAD_SWITCH_STICK - 0.01 } }))).toBe(false);
		expect(padIsActive(state({ rightStick: { x: -0.2, y: 0.2 } }))).toBe(false);
	});

	test("a finger on the surface is not a use of the pad", () => {
		// `touch-tap` defaults to confirm, so a thumb resting here would be one
		// lift away from driving the app if this predicate counted it.
		const resting = state({ touch: [{ id: 1, x: 500, y: 300 }, undefined] });
		expect(padIsActive(resting)).toBe(false);
	});
});
