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

/** At or below this, on battery: tell the user before the pad dies mid-sentence. */
export const PAD_LOW_BATTERY_LEVEL = 2;

const IDLE_SCALE = 0.25;
const PULSE_FLOOR = 0.25;
const BREATHE_FLOOR = 0.15;

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
	if (signal.awaiting) return scale(palette.alert, pulse(now, PAD_PULSE_MS, PULSE_FLOOR));
	if (signal.phase === "busy") return scale(palette.accent, breathe(now));
	if (padBatteryLow(signal.battery)) return scale(palette.low, pulse(now, PAD_LOW_PULSE_MS, 0));
	return scale(palette.accent, IDLE_SCALE);
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
}

/**
 * The buzzes. Each is one write and one scheduled stop — no patterns that take a
 * sequence, because a sequence is a timer this file would have to own.
 */
export const PAD_RUMBLE = {
	/** The pad just answered: proof the feature is alive without looking. */
	connected: { durationMs: 60, rumble: { large: 0, small: 0x40 } },
	/** Someone wants a decision. Felt across the room, deliberately. */
	alert: { durationMs: 180, rumble: { large: 0x80, small: 0x80 } },
	/** Work started. */
	working: { durationMs: 80, rumble: { large: 0, small: 0x50 } },
	/** Work finished. Softer and longer than `working`, so the two are told apart. */
	done: { durationMs: 200, rumble: { large: 0x40, small: 0 } },
	/**
	 * A key that does nothing here — the pad answered a dialog the user has not
	 * let it answer. Deliberately the faintest thing the motors can say: it is
	 * information, not a complaint.
	 */
	refused: { durationMs: 60, rumble: { large: 0, small: 0x20 } },
} as const satisfies Record<string, PadRumbleCommand>;

export type PadRumbleEvent = keyof typeof PAD_RUMBLE;

/** Two events closer together than this share one buzz; the second is dropped. */
export const PAD_RUMBLE_MIN_GAP_MS = 1000;

export interface PadFeedback {
	/** The colour for right now. */
	lightbar(signal: PadSignal, now: number): PadRgb;
	/** The buzz a change deserves, or `undefined` for "leave the motors alone". */
	rumble(prev: PadSignal | undefined, next: PadSignal | undefined, now: number): PadRumbleCommand | undefined;
}

export function createPadFeedback(palette: PadPalette): PadFeedback {
	let rumbledAt: number | undefined;
	return {
		lightbar(signal, now) {
			return padLightbarFor(signal, now, palette);
		},
		rumble(prev, next, now) {
			if (next === undefined) return undefined;
			const event = rumbleEvent(prev, next);
			if (event === undefined) return undefined;
			// A gap, not a queue: dropping the second event is the point. Two buzzes
			// a moment apart read as one stutter, not as two pieces of news — except
			// for the question, which is a summons rather than news. A turn that
			// starts and is stopped by a permission a moment later is the one case
			// where being felt is the whole job: swallowing that buzz would make the
			// pad go quiet at the exact moment it is needed.
			if (event !== "alert" && rumbledAt !== undefined && now - rumbledAt < PAD_RUMBLE_MIN_GAP_MS) return undefined;
			rumbledAt = now;
			return PAD_RUMBLE[event];
		},
	};
}

/** What changed, if it is anything worth interrupting a thumb for. */
function rumbleEvent(prev: PadSignal | undefined, next: PadSignal): PadRumbleEvent | undefined {
	if (prev === undefined) return "connected";
	if (!prev.awaiting && next.awaiting) return "alert";
	if (prev.awaiting !== next.awaiting) return undefined; // answered: the screen is the feedback
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
