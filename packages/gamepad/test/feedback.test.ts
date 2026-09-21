/**
 * The lightbar and the motors.
 *
 * Two properties do most of the work here, and both are about *not* doing
 * things: the lightbar is a pure function of the state and the clock — so an
 * idle pad produces the same colour every tick and the service can leave the
 * device alone — and every buzz carries a duration, because a pattern with no
 * stop is a pad that buzzes until the process is killed.
 */

import { describe, expect, test } from "bun:test";
import {
	ANSI_RGB,
	createPadFeedback,
	PAD_BLINK_ATTENTION,
	PAD_LOW_RGB,
	PAD_PULSE_MS,
	PAD_RUMBLE,
	PAD_RUMBLE_MIN_GAP_MS,
	PAD_WHITE,
	type PadRgb,
	type PadSignal,
	padBatteryLow,
	padBlinkFor,
	padLightbarFor,
	padPalette,
	padRgb,
	padSignalEqual,
} from "../src/index.ts";

const PALETTE = padPalette({ accent: "cyan", alert: "magenta" });
const CYAN: PadRgb = { r: 58, g: 150, b: 221 };
const MAGENTA: PadRgb = { r: 136, g: 23, b: 152 };

const IDLE: PadSignal = { phase: "idle", awaiting: false };
const BUSY: PadSignal = { phase: "busy", awaiting: false };
const ASKING: PadSignal = { phase: "busy", awaiting: true };

function lightbar(signal: PadSignal, now = 0): PadRgb {
	return padLightbarFor(signal, now, PALETTE);
}

describe("padRgb", () => {
	test("knows the ANSI names a theme uses, in any spelling", () => {
		expect(padRgb("cyan")).toEqual(CYAN);
		expect(padRgb("CYAN")).toEqual(CYAN);
		expect(padRgb("  magenta ")).toEqual(MAGENTA);
		expect(padRgb("redBright")).toEqual(ANSI_RGB.redbright);
		expect(padRgb("whiteBright")).toEqual({ r: 242, g: 242, b: 242 });
	});

	test("takes a hex colour too", () => {
		expect(padRgb("#ff0080")).toEqual({ r: 255, g: 0, b: 128 });
		expect(padRgb("#FF0080")).toEqual({ r: 255, g: 0, b: 128 });
		expect(padRgb("#3a96dd")).toEqual(CYAN);
	});

	test("gives back something visible rather than nothing for a name it cannot read", () => {
		// White, not black: a theme that names a colour we do not know should look
		// wrong, not look broken.
		expect(padRgb("chartreuse")).toEqual(PAD_WHITE);
		expect(padRgb("")).toEqual(PAD_WHITE);
		expect(padRgb("#f00")).toEqual(PAD_WHITE);
		expect(padRgb("#ff0080z")).toEqual(PAD_WHITE);
	});

	test("the palette a theme hands over keeps its permission colour for the ask", () => {
		expect(PALETTE.accent).toEqual(CYAN);
		expect(PALETTE.alert).toEqual(MAGENTA);
		expect(PALETTE.low).toEqual(PAD_LOW_RGB);
	});
});

describe("padLightbarFor", () => {
	test("idle is the accent, dimmed, and does not change with the clock", () => {
		// The service leans on this: an unchanged colour is a write it can skip.
		expect(lightbar(IDLE)).toEqual({ r: 15, g: 38, b: 55 });
		expect(lightbar(IDLE, 12_345)).toEqual(lightbar(IDLE));
	});

	test("busy breathes, from the floor to full and back every 1.6s", () => {
		expect(lightbar(BUSY, 0)).toEqual({ r: 9, g: 23, b: 33 });
		expect(lightbar(BUSY, 800)).toEqual(CYAN);
		expect(lightbar(BUSY, 1_600)).toEqual(lightbar(BUSY, 0));
	});

	test("a question pulses in the alert colour at 2 Hz", () => {
		expect(lightbar(ASKING, 0)).toEqual(MAGENTA);
		expect(lightbar(ASKING, PAD_PULSE_MS / 2)).toEqual({ r: 34, g: 6, b: 38 });
		expect(lightbar(ASKING, PAD_PULSE_MS)).toEqual(MAGENTA);
		expect(lightbar(ASKING, PAD_PULSE_MS - 1)).toEqual({ r: 34, g: 6, b: 38 });
	});

	test("an empty battery blinks the one colour the theme does not own", () => {
		const dying: PadSignal = { ...IDLE, battery: { level: 2, cable: false } };
		expect(lightbar(dying, 0)).toEqual(PAD_LOW_RGB);
		expect(lightbar(dying, 500)).toEqual({ r: 0, g: 0, b: 0 });
		expect(lightbar(dying, 1_000)).toEqual(PAD_LOW_RGB);
	});

	test("being plugged in is not the same as dying", () => {
		const charging: PadSignal = { ...IDLE, battery: { level: 2, cable: true } };
		expect(lightbar(charging)).toEqual(lightbar(IDLE));
		const healthy: PadSignal = { ...IDLE, battery: { level: 3, cable: false } };
		expect(lightbar(healthy)).toEqual(lightbar(IDLE));
	});

	test("what is urgent wins: a question outranks work, work outranks the battery", () => {
		const dying: PadSignal = { ...IDLE, battery: { level: 1, cable: false } };
		expect(lightbar({ ...dying, awaiting: true })).toEqual(MAGENTA);
		expect(lightbar({ ...dying, phase: "busy" })).toEqual(lightbar(BUSY));
	});
});

describe("padBlinkFor", () => {
	test("a question asks the hardware to blink, in the pad's own units", () => {
		expect(padBlinkFor(ASKING)).toEqual(PAD_BLINK_ATTENTION);
		// Hundredths of a second, and both halves: the pad ignores a pair with a zero
		// in it, so a "blink" that set only one would be no blink at all.
		expect(PAD_BLINK_ATTENTION.on).toBeGreaterThan(0);
		expect(PAD_BLINK_ATTENTION.off).toBeGreaterThan(0);
		expect((PAD_BLINK_ATTENTION.on + PAD_BLINK_ATTENTION.off) * 10).toBe(PAD_PULSE_MS);
	});

	test("nothing else does: work, an empty battery and an idle pad keep the light steady", () => {
		// The battery warning pulses to black in software already, and two blinks over
		// one light is a flicker rather than an alarm.
		expect(padBlinkFor(BUSY)).toBeUndefined();
		expect(padBlinkFor({ ...IDLE, battery: { level: 1, cable: false } })).toBeUndefined();
		expect(padBlinkFor(IDLE)).toBeUndefined();
	});

	test("the same priority as the colour: a question blinks while the battery goes", () => {
		expect(padBlinkFor({ ...ASKING, battery: { level: 0, cable: false } })).toEqual(PAD_BLINK_ATTENTION);
	});
});

describe("padBatteryLow", () => {
	test("low means low, on battery", () => {
		expect(padBatteryLow({ level: 0, cable: false })).toBe(true);
		expect(padBatteryLow({ level: 2, cable: false })).toBe(true);
		expect(padBatteryLow({ level: 3, cable: false })).toBe(false);
		expect(padBatteryLow({ level: 2, cable: true })).toBe(false);
		expect(padBatteryLow(undefined)).toBe(false);
	});
});

describe("padSignalEqual", () => {
	test("two signals that say the same thing need no work", () => {
		expect(padSignalEqual(IDLE, { ...IDLE })).toBe(true);
		expect(padSignalEqual(IDLE, BUSY)).toBe(false);
		expect(padSignalEqual(IDLE, { ...IDLE, awaiting: true })).toBe(false);
	});

	test("the battery is compared, and an unread one is not the same as a read one", () => {
		const full: PadSignal = { ...IDLE, battery: { level: 10, cable: false } };
		expect(padSignalEqual(full, { ...IDLE, battery: { level: 10, cable: false } })).toBe(true);
		expect(padSignalEqual(full, { ...IDLE, battery: { level: 9, cable: false } })).toBe(false);
		expect(padSignalEqual(full, { ...IDLE, battery: { level: 10, cable: true } })).toBe(false);
		expect(padSignalEqual(full, IDLE)).toBe(false);
		expect(padSignalEqual(IDLE, IDLE)).toBe(true);
	});
});

describe("rumble", () => {
	test("every pattern stops on its own", () => {
		for (const [name, command] of Object.entries(PAD_RUMBLE)) {
			expect(command.durationMs, name).toBeGreaterThan(0);
			for (const motor of [command.rumble.small, command.rumble.large]) {
				expect(motor).toBeGreaterThanOrEqual(0);
				expect(motor).toBeLessThanOrEqual(255);
			}
			// A second half is a buzz of its own, and it answers to the same rules:
			// long enough to be felt, and a real silence before it, or the two halves
			// run together into one longer buzz and the pattern says nothing.
			if (!("again" in command)) continue;
			expect(command.again.durationMs, name).toBeGreaterThan(0);
			expect(command.again.afterMs, name).toBeGreaterThan(0);
		}
		// The one you are meant to feel from across the room is the loudest.
		expect(PAD_RUMBLE.alert.rumble.small).toBeGreaterThan(PAD_RUMBLE.connected.rumble.small);
	});

	test("a stop is two quick taps, and the only pattern that is two of anything", () => {
		// The table's own consistency is checked above; this is the one property the
		// pattern exists for, and nothing about it is derivable from the numbers. The
		// motors have no channel but rhythm: a single buzz is `done` or `working` at
		// some volume, and "you stopped it" has to be a different *shape* or a hand
		// cannot tell a stop from a finish without looking at the screen.
		const stop = PAD_RUMBLE.stopped;
		expect(stop.again).toBeDefined();
		expect(stop.durationMs).toBeLessThan(PAD_RUMBLE.done.durationMs);
		expect(stop.again?.durationMs ?? 0).toBeLessThan(PAD_RUMBLE.done.durationMs);
		// And it is the only one: two patterns a hand is meant to tell apart must not
		// both be a double tap.
		const doubled = Object.entries(PAD_RUMBLE)
			.filter(([, command]) => "again" in command)
			.map(([name]) => name);
		expect(doubled).toEqual(["stopped"]);
	});

	test("connecting is announced, because otherwise the feature is invisible", () => {
		const feedback = createPadFeedback(PALETTE);
		expect(feedback.rumble(undefined, IDLE, 0)).toEqual(PAD_RUMBLE.connected);
	});

	test("work starting and work ending feel different", () => {
		const feedback = createPadFeedback(PALETTE);
		expect(feedback.rumble(IDLE, BUSY, 0)).toEqual(PAD_RUMBLE.working);
		expect(feedback.rumble(BUSY, IDLE, PAD_RUMBLE_MIN_GAP_MS)).toEqual(PAD_RUMBLE.done);
		expect(PAD_RUMBLE.done.rumble.large).toBeGreaterThan(PAD_RUMBLE.working.rumble.large);
	});

	test("a question is felt even when the phase did not change", () => {
		// The real case: a tool call asks permission in the middle of a run.
		const feedback = createPadFeedback(PALETTE);
		expect(feedback.rumble(BUSY, ASKING, 0)).toEqual(PAD_RUMBLE.alert);
	});

	test("answering a question is not worth a buzz, and neither is nothing happening", () => {
		const feedback = createPadFeedback(PALETTE);
		expect(feedback.rumble(ASKING, BUSY, 0)).toBeUndefined();
		expect(feedback.rumble(IDLE, IDLE, 0)).toBeUndefined();
	});

	test("an unplugged pad has nothing to say", () => {
		const feedback = createPadFeedback(PALETTE);
		expect(feedback.rumble(ASKING, undefined, 0)).toBeUndefined();
	});

	test("two pieces of news a moment apart share one buzz", () => {
		const feedback = createPadFeedback(PALETTE);
		expect(feedback.rumble(IDLE, BUSY, 0)).toEqual(PAD_RUMBLE.working);
		expect(feedback.rumble(BUSY, IDLE, PAD_RUMBLE_MIN_GAP_MS - 1)).toBeUndefined();
		expect(feedback.rumble(BUSY, IDLE, PAD_RUMBLE_MIN_GAP_MS)).toEqual(PAD_RUMBLE.done);
	});

	test("but a question cuts through it, because being asked is the point", () => {
		// A turn that starts and is stopped by a permission a moment later is the one
		// case where the second buzz is the one that matters: the gap exists to keep
		// news from stuttering, and a summons is not news.
		const feedback = createPadFeedback(PALETTE);
		expect(feedback.rumble(IDLE, BUSY, 0)).toEqual(PAD_RUMBLE.working);
		expect(feedback.rumble(BUSY, ASKING, PAD_RUMBLE_MIN_GAP_MS - 1)).toEqual(PAD_RUMBLE.alert);
	});

	test("the battery crossing into the low band is felt, once, at the crossing", () => {
		const feedback = createPadFeedback(PALETTE);
		const healthy: PadSignal = { ...IDLE, battery: { level: 3, cable: false } };
		const dying: PadSignal = { ...IDLE, battery: { level: 2, cable: false } };
		expect(feedback.rumble(healthy, dying, 0)).toEqual(PAD_RUMBLE.low);

		// The level is not the news. Staying where it is, or dropping further inside
		// the band, is the bar's job — a warning that repeats is one that gets ignored.
		const emptier: PadSignal = { ...IDLE, battery: { level: 0, cable: false } };
		expect(feedback.rumble(dying, emptier, PAD_RUMBLE_MIN_GAP_MS)).toBeUndefined();
	});

	test("a pad that connects nearly empty has not crossed anything", () => {
		// Every pad's first reading comes out of nowhere, and the buzz that announced
		// the connection is the one the hand is still feeling. The red bar is what
		// tells this pad from a full one.
		const feedback = createPadFeedback(PALETTE);
		expect(feedback.rumble(IDLE, { ...IDLE, battery: { level: 1, cable: false } }, 0)).toBeUndefined();
	});

	test("a crossing is felt even a moment after other news", () => {
		// The one thing the gap must not swallow: the crossing happens once, and a
		// pad that stays quiet is a pad that dies mid-sentence. Both signals carry a
		// battery because on a pad that has been talking for a moment they always do.
		const feedback = createPadFeedback(PALETTE);
		const healthy: PadSignal = { ...BUSY, battery: { level: 3, cable: false } };
		expect(feedback.rumble(IDLE, healthy, 0)).toEqual(PAD_RUMBLE.working);
		const crossed: PadSignal = { ...BUSY, battery: { level: 1, cable: false } };
		expect(feedback.rumble(healthy, crossed, PAD_RUMBLE_MIN_GAP_MS - 1)).toEqual(PAD_RUMBLE.low);
	});

	test("a buzz the app asked for counts as a buzz, and cannot silence a summons", () => {
		// `/gamepad rumble`, and ○ stopping a turn: both are heard by the hand even
		// though no state change asked for them, so the state's own news a moment
		// later has to be measured against them like anything else.
		const feedback = createPadFeedback(PALETTE);
		feedback.buzzed(0);
		expect(feedback.rumble(IDLE, BUSY, PAD_RUMBLE_MIN_GAP_MS - 1)).toBeUndefined();
		expect(feedback.rumble(IDLE, BUSY, PAD_RUMBLE_MIN_GAP_MS)).toEqual(PAD_RUMBLE.working);

		// The question is exempt from the gap at every moment, this one included.
		feedback.buzzed(PAD_RUMBLE_MIN_GAP_MS);
		expect(feedback.rumble(BUSY, ASKING, PAD_RUMBLE_MIN_GAP_MS + 1)).toEqual(PAD_RUMBLE.alert);
	});
});
