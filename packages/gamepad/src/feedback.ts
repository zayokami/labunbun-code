/**
 * What the pad shows: the lightbar's colour, and when it buzzes.
 *
 * Two different clocks live here. The lightbar is a *level*, so it is a function
 * of the current time — the caller asks for the colour now and gets one, and the
 * fact that it pulses is this file's business, not the caller's. A buzz is an
 * *event*, so it is a function of what changed, and every one of them carries the
 * duration after which the motors must be stopped: a pad left rumbling because
 * the process died mid-pattern is worse than no feedback at all.
 *
 * The palette comes from the terminal theme, because the lightbar sits in the
 * user's hands next to a screen painted in it. The one exception is "battery
 * almost gone", which stays red whatever the theme says.
 */

import type { Ds4Battery } from "./ds4.ts";

export interface PadRgb {
	r: number;
	g: number;
	b: number;
}

/**
 * The ANSI names a theme can use, as RGB. The values are the usual terminal
 * palette (Windows Terminal's, which is close enough to xterm's to not matter):
 * a lightbar is a mood, not a colorimeter, and matching the terminal exactly is
 * impossible from inside it anyway.
 *
 * Keys are lower case and the lookup lower cases, so `redBright` and `redbright`
 * and `REDBRIGHT` are the same colour — a settings file is written by hand.
 */
export const ANSI_RGB: Readonly<Record<string, PadRgb>> = {
	black: { r: 0x00, g: 0x00, b: 0x00 },
	red: { r: 0xc5, g: 0x0f, b: 0x1f },
	green: { r: 0x13, g: 0xa1, b: 0x0e },
	yellow: { r: 0xc1, g: 0x9c, b: 0x00 },
	blue: { r: 0x00, g: 0x37, b: 0xda },
	magenta: { r: 0x88, g: 0x17, b: 0x98 },
	cyan: { r: 0x3a, g: 0x96, b: 0xdd },
	white: { r: 0xcc, g: 0xcc, b: 0xcc },
	gray: { r: 0x76, g: 0x76, b: 0x76 },
	grey: { r: 0x76, g: 0x76, b: 0x76 },
	blackbright: { r: 0x76, g: 0x76, b: 0x76 },
	redbright: { r: 0xe7, g: 0x48, b: 0x56 },
	greenbright: { r: 0x16, g: 0xc6, b: 0x0c },
	yellowbright: { r: 0xf9, g: 0xf1, b: 0xa5 },
	bluebright: { r: 0x3b, g: 0x78, b: 0xff },
	magentabright: { r: 0xb4, g: 0x00, b: 0x9e },
	cyanbright: { r: 0x61, g: 0xd6, b: 0xd6 },
	whitebright: { r: 0xf2, g: 0xf2, b: 0xf2 },
};

/** Neutral white: what a name we cannot read becomes. */
export const PAD_WHITE: PadRgb = { r: 0xff, g: 0xff, b: 0xff };

/** The one colour the theme does not get a say in — ANSI `redBright`. */
export const PAD_LOW_RGB: PadRgb = { r: 0xe7, g: 0x48, b: 0x56 };

/**
 * A theme colour as a lightbar colour: an ANSI name, or `#rrggbb`. Anything else
 * — a name from a theme that used one we do not know, a typo — is white, which
 * is visible enough to be recognised as "something is wrong here" rather than
 * silently invisible.
 */
export function padRgb(name: string): PadRgb {
	const trimmed = name.trim();
	const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
	if (hex?.[1]) {
		const value = Number.parseInt(hex[1], 16);
		return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
	}
	return ANSI_RGB[trimmed.toLowerCase()] ?? PAD_WHITE;
}

export interface PadPalette {
	/** Running, nothing wrong: the theme's accent. */
	accent: PadRgb;
	/** Something wants an answer. */
	alert: PadRgb;
	/** Battery almost gone. */
	low: PadRgb;
}

/** The palette a theme suggests. `alert` should be the theme's permission colour. */
export function padPalette(theme: { accent: string; alert: string }): PadPalette {
	return { accent: padRgb(theme.accent), alert: padRgb(theme.alert), low: PAD_LOW_RGB };
}

/** The app's state, as the pad needs it. `phase` is what the status line shows. */
export type PadUiPhase = "idle" | "busy";

export interface PadSignal {
	phase: PadUiPhase;
	/** A dialog is on screen waiting for an answer. */
	awaiting: boolean;
	/** Unread, or `undefined` until a report has carried one. */
	battery?: Ds4Battery;
}

/** A full on/off cycle of the attention pulse. */
export const PAD_PULSE_MS = 500;

/** A full in-and-out breath while working. */
export const PAD_BREATHE_MS = 1600;

/** A full on/off cycle of the low battery blink. */
export const PAD_LOW_PULSE_MS = 1000;

/** The pad counts a blink in units of this long. See `Ds4OutputState.blink`. */
const BLINK_UNIT_MS = 10;

export interface PadBlink {
	/** Hundredths of a second lit. */
	on: number;
	/** Hundredths of a second dark. The pad needs both halves or neither takes. */
	off: number;
}

/**
 * The blink a question asks the hardware for: half a second on, half a second
 * off — `PAD_PULSE_MS`'s own period, so the bar does not change rhythm when the
 * hardware takes over turning it off.
 *
 * It is a separate thing from the software pulse on purpose. That one only dims,
 * to `PULSE_FLOOR`, and a bar that dims is a bar you can miss from the sofa —
 * which is the one thing a question must not be. This is the only state that asks
 * for it: the battery warning already goes to black on its own (its pulse floor is
 * zero), and two blinks over one light is a flicker.
 */
export const PAD_BLINK_ATTENTION: PadBlink = {
	on: PAD_PULSE_MS / 2 / BLINK_UNIT_MS,
	off: PAD_PULSE_MS / 2 / BLINK_UNIT_MS,
};

/** At or below this, on battery: tell the user before the pad dies mid-sentence. */
export const PAD_LOW_BATTERY_LEVEL = 2;

const IDLE_SCALE = 0.25;
const PULSE_FLOOR = 0.25;
const BREATHE_FLOOR = 0.15;

/**
 * What the bar is being asked to say, in priority order. One function because the
 * order is one decision, and two answers from one light — a colour saying "answer
 * me" and a blink saying "the battery is going" — is a light that says neither.
 */
function barState(signal: PadSignal): "awaiting" | "busy" | "low" | "idle" {
	if (signal.awaiting) return "awaiting";
	if (signal.phase === "busy") return "busy";
	if (padBatteryLow(signal.battery)) return "low";
	return "idle";
}

/**
 * The colour the lightbar should be *now*. Called on a tick, so it is pure and
 * cheap; the answer changes with `now` because that is what pulsing is.
 *
 * Priority is deliberate: an answer wanted outranks work in progress, which
 * outranks a battery warning — and the battery warning only gets the bar to
 * itself when nothing else is happening, because a red blink on top of a
 * breathing accent is just noise in the user's hands.
 */
export function padLightbarFor(signal: PadSignal, now: number, palette: PadPalette): PadRgb {
	const state = barState(signal);
	if (state === "awaiting") return scale(palette.alert, pulse(now, PAD_PULSE_MS, PULSE_FLOOR));
	if (state === "busy") return scale(palette.accent, breathe(now));
	if (state === "low") return scale(palette.low, pulse(now, PAD_LOW_PULSE_MS, 0));
	return scale(palette.accent, IDLE_SCALE);
}

/**
 * The hardware blink this state asks for, if any — the other half of the same
 * answer, asked once so the two cannot disagree about which state the bar is in.
 *
 * A level like the colour, not an event: it says what the pad should be doing from
 * now on, and the way to stop it is to send a packet that does not ask for it. The
 * whole packet describes the pad, so leaving the state turns the blinking off
 * without anything having to unwind a timer.
 */
export function padBlinkFor(signal: PadSignal): PadBlink | undefined {
	return barState(signal) === "awaiting" ? PAD_BLINK_ATTENTION : undefined;
}

/** On battery, and nearly out of it. On the cable it is charging, not dying. */
export function padBatteryLow(battery: Ds4Battery | undefined): boolean {
	if (!battery) return false;
	return !battery.cable && battery.level <= PAD_LOW_BATTERY_LEVEL;
}

export interface PadRumble {
	/** The right motor: the sharp, high-frequency one. */
	small: number;
	/** The left motor: the deep one you feel through the shell. */
	large: number;
}

export interface PadRumbleCommand {
	rumble: PadRumble;
	/** How long to leave it on. The service schedules the stop. */
	durationMs: number;
	/**
	 * A second buzz of the same shape, after the first has stopped and this long
	 * has passed: `afterMs` is the silence *between* the two, not from the start.
	 * The one pattern a hand hears as two, and the service that already owns the
	 * stop owns the restart.
	 */
	again?: { afterMs: number; durationMs: number };
	/**
	 * Felt even if something else just buzzed. For the news that arrives once: a
	 * question, and the battery crossing. Both are summonses rather than bulletins,
	 * and neither comes round again — being dropped is being lost.
	 */
	urgent?: boolean;
}

/**
 * The buzzes. Each is one write and one scheduled stop — plus, for the one pattern
 * that is heard as two, a second write on the same timer machinery. Nothing here is
 * a queue: a command says what the hand should feel now, and the stop belongs to the
 * service either way.
 */
export const PAD_RUMBLE = {
	/** The pad just answered: proof the feature is alive without looking. */
	connected: { durationMs: 60, rumble: { large: 0, small: 0x40 } },
	/** Someone wants a decision. Felt across the room, deliberately. */
	alert: { durationMs: 180, rumble: { large: 0x80, small: 0x80 }, urgent: true },
	/** Work started. */
	working: { durationMs: 80, rumble: { large: 0, small: 0x50 } },
	/** Work finished. Softer and longer than `working`, so the two are told apart. */
	done: { durationMs: 200, rumble: { large: 0x40, small: 0 } },
	/**
	 * The user stopped a turn that was running. Two short buzzes of one shape, which
	 * is the only way a hand can tell "stopped" from "finished" when all the motors
	 * offer is a level: `done` is one longer, deeper note, and this is a double tap.
	 */
	stopped: { durationMs: 60, rumble: { large: 0, small: 0x60 }, again: { afterMs: 70, durationMs: 60 } },
	/**
	 * A no from the pad: ○ on a permission dialog, or ✕ on one the user has not let
	 * the pad answer. Deliberately the faintest thing the motors can say: it is
	 * information, not a complaint, and the screen has already said which no it was.
	 */
	refused: { durationMs: 60, rumble: { large: 0, small: 0x20 } },
	/**
	 * The battery crossed into the low band while in use. Both motors, gently: the
	 * warning is about later rather than about now, and the bar has gone red as well.
	 */
	low: { durationMs: 160, rumble: { large: 0x28, small: 0x10 }, urgent: true },
} as const satisfies Record<string, PadRumbleCommand>;

export type PadRumbleEvent = keyof typeof PAD_RUMBLE;

/** Two events closer together than this share one buzz; the second is dropped. */
export const PAD_RUMBLE_MIN_GAP_MS = 1000;

export interface PadFeedback {
	/** The colour for right now. */
	lightbar(signal: PadSignal, now: number): PadRgb;
	/** The blink for right now, if the state asks for one. */
	blink(signal: PadSignal): PadBlink | undefined;
	/** The buzz a change deserves, or `undefined` for "leave the motors alone". */
	rumble(prev: PadSignal | undefined, next: PadSignal | undefined, now: number): PadRumbleCommand | undefined;
	/**
	 * Record a buzz the app asked for directly — one that did not come from a state
	 * change, so this file did not hand it out. The next event measures its gap
	 * against it: without this, a buzz the user asked for and the state's own news
	 * a moment later land as the one stutter the gap exists to prevent.
	 */
	buzzed(now: number): void;
}

export function createPadFeedback(palette: PadPalette): PadFeedback {
	let rumbledAt: number | undefined;
	return {
		lightbar(signal, now) {
			return padLightbarFor(signal, now, palette);
		},
		blink(signal) {
			return padBlinkFor(signal);
		},
		rumble(prev, next, now) {
			if (next === undefined) return undefined;
			const event = rumbleEvent(prev, next);
			if (event === undefined) return undefined;
			// A gap, not a queue: dropping the second event is the point. Two buzzes
			// a moment apart read as one stutter, not as two pieces of news. The
			// exception is the pair that is a summons rather than a bulletin — a
			// turn that starts and is stopped by a permission a moment later, a
			// battery that crosses into the low band as a turn begins. Both are felt
			// once or not at all, so the gap that keeps news from stuttering must not
			// swallow them: the pad would go quiet at the exact moment it is needed.
			// Annotated because the table is `as const`: without it the union of entry
			// types has `urgent` on some members and not others, and the question
			// being asked is the one on the interface.
			const command: PadRumbleCommand = PAD_RUMBLE[event];
			if (!command.urgent && rumbledAt !== undefined && now - rumbledAt < PAD_RUMBLE_MIN_GAP_MS) return undefined;
			rumbledAt = now;
			return command;
		},
		buzzed(now) {
			rumbledAt = now;
		},
	};
}

/** What changed, if it is anything worth interrupting a thumb for. */
function rumbleEvent(prev: PadSignal | undefined, next: PadSignal): PadRumbleEvent | undefined {
	if (prev === undefined) return "connected";
	if (!prev.awaiting && next.awaiting) return "alert";
	if (prev.awaiting !== next.awaiting) return undefined; // answered: the screen is the feedback
	// The crossing, not the level: a pad that is low and drops further says nothing
	// here — the bar has been red the whole time, and a warning that repeats is a
	// warning that gets ignored. A battery nobody has read yet is not a crossing out
	// of anywhere either, which is the case that matters: every pad's first report
	// is a reading from nowhere, and the one arriving with an empty cell has just
	// buzzed to say it is here. The red bar is what tells it apart from a full one.
	//
	// Asked before the phase change, because a battery that is about to die outranks
	// a turn that is about to start: the crossing cannot happen again, the turn can.
	if (prev.battery !== undefined && padBatteryLow(next.battery) && !padBatteryLow(prev.battery)) return "low";
	if (prev.phase === next.phase) return undefined;
	return next.phase === "busy" ? "working" : "done";
}

/** Whether two signals say the same thing — i.e. whether anything needs doing. */
export function padSignalEqual(a: PadSignal, b: PadSignal): boolean {
	if (a.phase !== b.phase || a.awaiting !== b.awaiting) return false;
	if (a.battery === undefined || b.battery === undefined) return a.battery === b.battery;
	return a.battery.level === b.battery.level && a.battery.cable === b.battery.cable;
}

/** A square wave: full, then `floor`, for half a period each. */
function pulse(now: number, period: number, floor: number): number {
	return now % period < period / 2 ? 1 : floor;
}

/** A triangle: full at the middle of the period, `BREATHE_FLOOR` at the edges. */
function breathe(now: number): number {
	const phase = (now % PAD_BREATHE_MS) / PAD_BREATHE_MS;
	return BREATHE_FLOOR + (1 - BREATHE_FLOOR) * (1 - Math.abs(2 * phase - 1));
}

function scale(color: PadRgb, factor: number): PadRgb {
	const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value * factor)));
	return { r: channel(color.r), g: channel(color.g), b: channel(color.b) };
}
