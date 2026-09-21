/**
 * The feel of the pad, with the clock in the caller's hand.
 *
 * Every test here feeds states and time by hand, because that is the whole
 * design: the mapper has no timer, so a test can hold a button for four hundred
 * milliseconds in a microsecond and there is nothing to wait for. The states are
 * synthetic rather than parsed from bytes on purpose — `ds4.test.ts` is what
 * pins the wire format, and this file should fail when the *feel* changes, not
 * when a report layout does.
 */

import { describe, expect, test } from "bun:test";
import {
	createMapper,
	DEFAULT_BINDINGS,
	type Ds4State,
	PAD_DEADZONE,
	PAD_HOLD_MS,
	PAD_STICK_HYSTERESIS,
	type PadAction,
	type PadBindingMap,
	type PadDirection,
	type PadMapper,
	resolveBindings,
	stickDirection,
} from "../src/index.ts";

function state(overrides: Partial<Ds4State> = {}): Ds4State {
	return {
		leftStick: { x: 0, y: 0 },
		rightStick: { x: 0, y: 0 },
		leftTrigger: 0,
		rightTrigger: 0,
		dpad: null,
		buttons: [],
		battery: { level: 10, cable: false },
		...overrides,
	};
}

/** The state a pad in this test is in: some buttons down, sticks where asked. */
function pad(buttons: Ds4State["buttons"] = [], sticks: Partial<Pick<Ds4State, "leftStick" | "rightStick">> = {}) {
	return state({ buttons, ...sticks });
}

function mapperWith(bindings: PadBindingMap = DEFAULT_BINDINGS): PadMapper {
	return createMapper({ bindings });
}

/** A short way to say what came out, for the many expectations that are one action. */
function only(actions: PadAction[]): PadAction | undefined {
	return actions.length === 1 ? actions[0] : undefined;
}

describe("edges", () => {
	test("a press comes out once, and holding the button says nothing more", () => {
		const mapper = mapperWith();
		expect(only(mapper.update(pad(["cross"]), 0))).toEqual({
			kind: "confirm",
			button: "cross",
			phase: "press",
			heldMs: 0,
		});
		// The pad reports its state 250 times a second; a press is an edge in that
		// stream, not a sample of it.
		expect(mapper.update(pad(["cross"]), 4)).toEqual([]);
		expect(mapper.update(pad(["cross"]), 250)).toEqual([]);
	});

	test("a release carries how long its own press lasted", () => {
		const mapper = mapperWith();
		mapper.update(pad(["circle"]), 1_000);
		expect(only(mapper.update(pad(), 1_120))).toEqual({
			kind: "cancel",
			button: "circle",
			phase: "release",
			heldMs: 120,
		});
		expect(mapper.update(pad(), 1_200)).toEqual([]);
	});

	test("two buttons at once come out in the order the report lists them", () => {
		const mapper = mapperWith();
		const actions = mapper.update(pad(["cross", "circle"]), 0);
		expect(actions.map((action) => action.button)).toEqual(["cross", "circle"]);
		expect(actions.map((action) => action.phase)).toEqual(["press", "press"]);
	});

	test("a corner of the d-pad is two directions, because that is what it is", () => {
		const mapper = mapperWith();
		const actions = mapper.update(pad(["up", "right"]), 0);
		expect(actions.map((action) => action.kind)).toEqual(["up", "right"]);
	});

	test("a button bound to nothing says nothing at all", () => {
		const mapper = mapperWith();
		expect(mapper.update(pad(["ps"]), 0)).toEqual([]);
		expect(mapper.update(pad(), 10)).toEqual([]);
	});

	test("a command binding carries its line", () => {
		const { bindings } = resolveBindings({ triangle: "command:/theme dark" });
		const mapper = mapperWith(bindings);
		expect(only(mapper.update(pad(["triangle"]), 0))).toEqual({
			kind: "command",
			command: "/theme dark",
			button: "triangle",
			phase: "press",
			heldMs: 0,
		});
	});
});

describe("holding confirm", () => {
	test("the hold lands exactly on the threshold, once", () => {
		const mapper = mapperWith();
		mapper.update(pad(["cross"]), 0);
		expect(mapper.update(pad(["cross"]), PAD_HOLD_MS - 1)).toEqual([]);
		expect(only(mapper.update(pad(["cross"]), PAD_HOLD_MS))).toEqual({
			kind: "confirm",
			button: "cross",
			phase: "hold",
			heldMs: PAD_HOLD_MS,
		});
		expect(mapper.update(pad(["cross"]), PAD_HOLD_MS + 500)).toEqual([]);
	});

	test("the hold outranks a release that arrives on the same report", () => {
		// Two milliseconds of report jitter must not turn "held for a decision"
		// into "a press that ended". The hold comes out first, and the release
		// after it carries the same duration — so a dialog reading either one
		// knows what happened.
		const mapper = mapperWith();
		mapper.update(pad(["cross"]), 0);
		const actions = mapper.update(pad(), 700);
		expect(actions.map((action) => action.phase)).toEqual(["hold", "release"]);
		expect(actions.map((action) => action.heldMs)).toEqual([700, 700]);
	});

	test("it is the action that holds, not the ✕ button", () => {
		const { bindings } = resolveBindings({ l1: "confirm", cross: "cancel" });
		const mapper = mapperWith(bindings);
		mapper.update(pad(["l1"]), 0);
		expect(only(mapper.update(pad(["l1"]), PAD_HOLD_MS))?.phase).toBe("hold");
		mapper.update(pad(), 800);
		mapper.update(pad(["cross"]), 900);
		expect(mapper.update(pad(["cross"]), 900 + PAD_HOLD_MS)).toEqual([]);
	});
});

describe("repeating", () => {
	test("a held direction waits, then walks at the interval", () => {
		const mapper = mapperWith();
		expect(only(mapper.update(pad(["up"]), 0))?.phase).toBe("press");
		expect(mapper.update(pad(["up"]), 399)).toEqual([]);
		expect(only(mapper.update(pad(["up"]), 400))?.heldMs).toBe(400);
		expect(mapper.update(pad(["up"]), 479)).toEqual([]);
		expect(only(mapper.update(pad(["up"]), 480))?.heldMs).toBe(480);
		expect(mapper.update(pad(["up"]), 500)).toEqual([]);
		expect(only(mapper.update(pad(["up"]), 560))?.heldMs).toBe(560);
	});

	test("R2 speeds it up and L2 slows it down, and precision wins when both are held", () => {
		const times = (trigger: Partial<Ds4State>) => {
			const mapper = mapperWith();
			mapper.update(state({ buttons: ["up"], ...trigger }), 0);
			const repeats: number[] = [];
			for (let now = 400; now <= 700; now += 10) {
				const actions = mapper.update(state({ buttons: ["up"], ...trigger }), now);
				if (actions.length > 0) repeats.push(now);
			}
			return repeats;
		};
		expect(times({ rightTrigger: 1 })).toEqual([400, 430, 460, 490, 520, 550, 580, 610, 640, 670, 700]);
		expect(times({ rightTrigger: 0.2 })).toEqual(times({}));
		expect(times({ leftTrigger: 1 })).toEqual([400, 560]);
		expect(times({ leftTrigger: 1, rightTrigger: 1 })).toEqual([400, 560]);
	});

	test("a button that is not a direction fires once, however long you lean on it", () => {
		const mapper = mapperWith();
		mapper.update(pad(["square"]), 0);
		for (let now = 40; now <= 1_000; now += 40) expect(mapper.update(pad(["square"]), now)).toEqual([]);
	});

	test("letting go says one thing, even on a tick when a repeat was due", () => {
		const mapper = mapperWith();
		mapper.update(pad(["up"]), 0);
		// 480 is a repeat tick — 400, then every 80. Letting go there must not add
		// one last step to the walk before the release that ends it.
		const actions = mapper.update(pad(), 480);
		expect(actions.map((action) => action.phase)).toEqual(["release"]);
	});
});

describe("the left stick as a direction", () => {
	test("a stick no one is touching is not a direction", () => {
		const mapper = mapperWith();
		expect(mapper.update(pad([], { leftStick: { x: 0, y: 0 } }), 0)).toEqual([]);
		expect(mapper.update(pad([], { leftStick: { x: 0.15, y: -0.15 } }), 10)).toEqual([]);
		// The deadzone is the distance from the centre, not a box: twenty percent
		// of the way out is a quarter of the travel when it is diagonal, and a
		// quarter is past the threshold. The stick's gate is round, so this is.
		expect(only(mapper.update(pad([], { leftStick: { x: 0.2, y: -0.2 } }), 20))?.kind).toBe("right");
	});

	test("pushing past the deadzone is a press, and it comes from the stick", () => {
		const mapper = mapperWith();
		expect(only(mapper.update(pad([], { leftStick: { x: 0, y: 0.9 } }), 0))).toEqual({
			kind: "up",
			button: "stick",
			phase: "press",
			heldMs: 0,
		});
		expect(only(mapper.update(pad([], { leftStick: { x: 0, y: 0 } }), 50))?.phase).toBe("release");
	});

	test("the d-pad and the stick share one direction, so holding both is still one press", () => {
		const mapper = mapperWith();
		expect(only(mapper.update(pad(["up"], { leftStick: { x: 0, y: 0.9 } }), 0))?.button).toBe("up");
		// Letting go of the stick while the d-pad is still down is not a release.
		expect(mapper.update(pad(["up"]), 100)).toEqual([]);
		expect(only(mapper.update(pad(), 200))?.phase).toBe("release");
	});

	test("inside the deadzone it keeps its direction, below the band it lets go", () => {
		const mapper = mapperWith();
		expect(only(mapper.update(pad([], { leftStick: { x: 0, y: 0.3 } }), 0))?.phase).toBe("press");
		// 0.2 is inside the deadzone but inside the hysteresis band too: still held.
		expect(mapper.update(pad([], { leftStick: { x: 0, y: 0.2 } }), 10)).toEqual([]);
		expect(only(mapper.update(pad([], { leftStick: { x: 0, y: 0.3 * PAD_STICK_HYSTERESIS - 0.05 } }), 20))?.phase).toBe(
			"release",
		);
		// And a fresh press has to clear the deadzone again, not just the band.
		expect(mapper.update(pad([], { leftStick: { x: 0, y: 0.22 } }), 30)).toEqual([]);
		expect(only(mapper.update(pad([], { leftStick: { x: 0, y: 0.3 } }), 40))?.phase).toBe("press");
	});

	test("a stick rolled off its diagonal keeps the axis it was on", () => {
		const mapper = mapperWith();
		// From rest, a perfect diagonal is a coin toss and the tie falls to x.
		expect(only(mapper.update(pad([], { leftStick: { x: 0.5, y: 0.5 } }), 0))?.kind).toBe("right");
		// Pushing clearly up takes it, because a quarter more is not a slip.
		const swapped = mapper.update(pad([], { leftStick: { x: 0.5, y: 0.9 } }), 100);
		expect(swapped.map((action) => `${action.phase} ${action.kind}`)).toEqual(["press up", "release right"]);
		// Back on the diagonal it stays up: that is what the bias is for.
		expect(mapper.update(pad([], { leftStick: { x: 0.5, y: 0.5 } }), 200)).toEqual([]);
	});

	test("the direction it decides on is one, never two", () => {
		const cases: Array<[number, number, PadDirection]> = [
			[0.9, 0.95, "up"],
			[-0.9, 0.95, "up"],
			[-0.9, -0.95, "down"],
			[0.95, 0.9, "right"],
			[-0.95, 0.9, "left"],
			[0.9, 0.1, "right"],
			[-0.9, 0.1, "left"],
		];
		for (const [x, y, expected] of cases) {
			expect(stickDirection(x, y, null, PAD_DEADZONE)).toBe(expected);
		}
		// A perfect diagonal has no winner, so the tie goes to x — and a `prev`
		// direction is what keeps that from mattering once something is held.
		expect(stickDirection(0.9, 0.9, null, PAD_DEADZONE)).toBe("right");
	});
});

describe("the right stick as a scroll", () => {
	test("pushing it down scrolls toward the end, immediately and then per interval", () => {
		const mapper = mapperWith();
		expect(only(mapper.update(pad([], { rightStick: { x: 0, y: -0.5 } }), 0))).toEqual({
			kind: "scroll",
			button: "stick",
			phase: "press",
			heldMs: 0,
			value: 0.5,
		});
		expect(mapper.update(pad([], { rightStick: { x: 0, y: -0.5 } }), 40)).toEqual([]);
		expect(only(mapper.update(pad([], { rightStick: { x: 0, y: -0.5 } }), 80))?.value).toBe(0.5);
		// How far it is pushed is how fast, and it is reported as it is, not smoothed.
		expect(only(mapper.update(pad([], { rightStick: { x: 0, y: -1 } }), 160))?.value).toBe(1);
	});

	test("the left stick is navigation and never scrolls", () => {
		const mapper = mapperWith();
		const actions = mapper.update(pad([], { leftStick: { x: 0, y: 0.9 } }), 0);
		expect(actions.map((action) => action.kind)).toEqual(["up"]);
	});

	test("R2 makes it faster too", () => {
		const mapper = mapperWith();
		mapper.update(state({ rightStick: { x: 0, y: -0.5 }, rightTrigger: 1 }), 0);
		expect(only(mapper.update(state({ rightStick: { x: 0, y: -0.5 }, rightTrigger: 1 }), 30))?.kind).toBe("scroll");
		expect(mapper.update(state({ rightStick: { x: 0, y: -0.5 }, rightTrigger: 1 }), 50)).toEqual([]);
	});
});

describe("handing the pad to someone else", () => {
	test("suspendRepeat stops the repeats without inventing a release", () => {
		const mapper = mapperWith();
		mapper.update(pad(["up"]), 0);
		mapper.suspendRepeat();
		expect(mapper.update(pad(["up"]), 400)).toEqual([]);
		expect(mapper.update(pad(["up"]), 900)).toEqual([]);
		expect(only(mapper.update(pad(), 1_000))?.phase).toBe("release");
		// A new press is not muted: only the one that was already down.
		expect(only(mapper.update(pad(["up"]), 1_100))?.phase).toBe("press");
		expect(only(mapper.update(pad(["up"]), 1_500))?.heldMs).toBe(400);
	});

	test("suspendRepeat mutes a held scroll as well", () => {
		const mapper = mapperWith();
		mapper.update(pad([], { rightStick: { x: 0, y: -0.5 } }), 0);
		mapper.suspendRepeat();
		expect(mapper.update(pad([], { rightStick: { x: 0, y: -0.5 } }), 200)).toEqual([]);
	});

	test("reset forgets the presses: a button still down is pressed again", () => {
		const mapper = mapperWith();
		mapper.update(pad(["cross"]), 0);
		mapper.reset();
		expect(only(mapper.update(pad(["cross"]), 10))?.phase).toBe("press");
		// And the press it just made is the one that releases: the one from before
		// the reset is gone, not half-remembered.
		expect(only(mapper.update(pad(), 20))).toEqual(
			expect.objectContaining({ phase: "release", heldMs: 10, button: "cross" }),
		);
	});

	test("reset forgets where the stick was, not just which buttons were down", () => {
		// A stick that was pointing somewhere must clear, or a reconnect would look
		// like a direction held since before the cable was pulled.
		const mapper = mapperWith();
		mapper.update(pad([], { leftStick: { x: 0, y: 0.9 } }), 0);
		mapper.reset();
		expect(only(mapper.update(pad([], { leftStick: { x: 0, y: 0.9 } }), 10))?.phase).toBe("press");

		// The case the reset is really for. 0.2 is inside the deadzone, so a stick
		// nobody is touching; it only reads as UP because of the hysteresis earned
		// before the reset. That memory has to go with the presses.
		const other = mapperWith();
		other.update(pad([], { leftStick: { x: 0, y: 0.9 } }), 0);
		other.reset();
		expect(other.update(pad([], { leftStick: { x: 0, y: 0.2 } }), 10)).toEqual([]);
	});
});
