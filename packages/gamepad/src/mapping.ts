/**
 * State in, actions out.
 *
 * A pad is not a keyboard with fewer keys: it reports its whole state ~250 times
 * a second, it has axes where the keyboard has none, and the same button means
 * different things held, tapped and double-tapped. This layer turns that stream
 * into the handful of discrete events the UI already knows how to handle, and it
 * is the only place the pad's *feel* lives: the deadzone, the repeat, and how
 * long a hold has to be before it is a decision rather than a twitch.
 *
 * There is no press id in `PadAction` and none is needed: a release is only ever
 * produced for a press this mapper recorded, so a release always carries its own
 * press's `heldMs` — and `now - heldMs` is therefore when that press began, which
 * is what tells a dialog whether the press it just saw predates it.
 */

import type { PadActionKind, PadBindingMap, PadDirection } from "./bindings.ts";
import type { Ds4ButtonId, Ds4State } from "./ds4.ts";

export type PadPhase = "press" | "release" | "hold";

export interface PadAction {
	/**
	 * What to do. Components switch on this, never on `button`. `none` is not
	 * here: a button a user unbound produces nothing at all, so an action that
	 * means "do nothing" is not a thing anyone downstream has to handle.
	 */
	kind: Exclude<PadActionKind, "none"> | "command";
	/** Where it came from. `"stick"` is anything the sticks produced. */
	button: Ds4ButtonId | "stick";
	/** A repeat is a `press`: holding up keeps walking the list. */
	phase: PadPhase;
	/** How long the button had been down when this came out. 0 for `scroll`. */
	heldMs: number;
	/** `scroll` only: how far, positive toward the end of the list. */
	value?: number;
	/** `command` bindings only: the line to run. */
	command?: string;
}

/** How long `confirm` must be held before it means more than a tap. */
export const PAD_HOLD_MS = 600;

/** Deflection that counts as a direction. */
export const PAD_DEADZONE = 0.25;

/** How far back inside the deadzone a direction must fall to be let go. */
export const PAD_STICK_HYSTERESIS = 0.7;

/** The advantage the axis already in play keeps, so a straight push stays put. */
export const PAD_STICK_BIAS = 1.25;

/** A trigger this far in counts as held for the repeat modifier. */
export const PAD_MODIFIER_PRESS = 0.5;

export interface PadRepeat {
	/** How long a button is held before it starts repeating. */
	delayMs: number;
	/** Between repeats. */
	intervalMs: number;
	/** While R2 is held. */
	fastIntervalMs: number;
	/** While L2 is held. */
	slowIntervalMs: number;
}

export const DEFAULT_PAD_REPEAT: PadRepeat = {
	delayMs: 400,
	intervalMs: 80,
	fastIntervalMs: 30,
	slowIntervalMs: 160,
};

/** Kinds that keep firing while held. Everything else fires once per press. */
const REPEATING_KINDS: readonly string[] = ["up", "down", "left", "right"] satisfies readonly PadActionKind[];

/**
 * Where the left stick points, one direction at a time.
 *
 * A stick is analog where a d-pad is discrete, so this has two jobs a button
 * does not: a *deadzone*, so a thumb at rest is not a direction, and hysteresis
 * around it, so a direction does not flicker at the edge. `prev` is what tells
 * the two thresholds apart — it is the direction held a moment ago.
 *
 * Diagonals are deliberately not directions here. One axis wins: the one already
 * in play unless the other is pushed more than a quarter further. "Up-right" as
 * a navigation action means two things at once in every list this drives, and
 * the d-pad still has real diagonals for anyone who wants them.
 */
export function stickDirection(
	x: number,
	y: number,
	prev: PadDirection | null,
	deadzone = PAD_DEADZONE,
): PadDirection | null {
	const magnitude = Math.hypot(x, y);
	const threshold = prev === null ? deadzone : deadzone * PAD_STICK_HYSTERESIS;
	if (magnitude < threshold) return null;

	const weights = (axis: "x" | "y") => (axisOf(prev) === axis ? PAD_STICK_BIAS : 1);
	const horizontal = Math.abs(x) * weights("x");
	const vertical = Math.abs(y) * weights("y");
	if (horizontal >= vertical && horizontal > 0) return x < 0 ? "left" : "right";
	return y < 0 ? "down" : "up";
}

function axisOf(direction: PadDirection | null): "x" | "y" | undefined {
	if (direction === null) return undefined;
	return direction === "left" || direction === "right" ? "x" : "y";
}

export interface PadMapperConfig {
	bindings: PadBindingMap;
	/** A user's setting, or `PAD_DEADZONE`. */
	deadzone?: number;
	/** Timings, for tests. Unlike the deadzone these have no hardware truth. */
	repeat?: Partial<PadRepeat>;
}

export interface PadMapper {
	/**
	 * Read one decoded state, return the actions its *edges* produced. Called for
	 * every report — a quarter of a millisecond's worth of work at 250 Hz — so
	 * repeats are settled here too: a held button needs no timer when the reports
	 * themselves are the timer.
	 */
	update(state: Ds4State, now: number): PadAction[];
	/** The pad went away: forget every press and say nothing. */
	reset(): void;
	/** Stop repeating, keep the presses. A button held across a change of owner
	 * must not start walking the new owner's list the moment it takes over. */
	suspendRepeat(): void;
}

interface Press {
	/** When it began; every `heldMs` is measured from here. */
	at: number;
	kind: PadActionKind | "command";
	command?: string;
	/** The button to report — the d-pad id, or `"stick"` when the stick made it. */
	button: Ds4ButtonId | "stick";
	/** `confirm` only: whether the hold has already been reported. */
	reportedHold: boolean;
	/** Cleared by `suspendRepeat`. */
	repeats: boolean;
	/** The last repeat, or `undefined` when the first one is still pending. */
	repeatedAt?: number;
}

interface Scroll {
	at: number;
	repeatedAt: number;
	repeats: boolean;
}

export function createMapper(config: PadMapperConfig): PadMapper {
	const repeat: PadRepeat = { ...DEFAULT_PAD_REPEAT, ...config.repeat };
	const deadzone = config.deadzone ?? PAD_DEADZONE;
	const { bindings } = config;
	const presses = new Map<Ds4ButtonId, Press>();
	let stick: PadDirection | null = null;
	let scroll: Scroll | undefined;

	return {
		update(state, now) {
			const actions: PadAction[] = [];
			const emit = (next: PadAction | undefined) => {
				if (next) actions.push(next);
			};
			stick = stickDirection(state.leftStick.x, state.leftStick.y, stick, deadzone);
			const held = new Set<Ds4ButtonId>(state.buttons);
			if (stick) held.add(stick);
			const intervalMs = intervalFor(repeat, state);

			// Presses first: the order of this array is the order it happened.
			for (const slot of held) {
				if (presses.has(slot)) continue;
				const binding = bindings[slot];
				const press: Press = {
					at: now,
					kind: binding.kind,
					button: stick === slot && !state.buttons.includes(slot) ? "stick" : slot,
					reportedHold: false,
					repeats: true,
				};
				if (binding.command !== undefined) press.command = binding.command;
				presses.set(slot, press);
				emit(action(press, "press", now));
			}

			// The right stick scrolls, and how far it is pushed is how fast: the
			// same repeat table as the d-pad, but with an analog value along for
			// the ride. Sign flips here so every consumer can read "positive means
			// toward the end" without knowing which way the pad calls up.
			const deflection = state.rightStick.y;
			const scrolling = Math.abs(deflection) >= (scroll ? deadzone * PAD_STICK_HYSTERESIS : deadzone);
			if (!scrolling) {
				scroll = undefined;
			} else if (scroll === undefined) {
				scroll = { at: now, repeatedAt: now, repeats: true };
				emit(scrollAction(-deflection, 0));
			} else if (scroll.repeats && now - scroll.repeatedAt >= intervalMs) {
				scroll.repeatedAt = now;
				emit(scrollAction(-deflection, now - scroll.at));
			}

			// Holds next. This runs before releases on purpose: a press that reaches
			// the threshold owns the report it lands on, even if that same report
			// also brings the release.
			for (const press of presses.values()) {
				if (press.reportedHold || press.kind !== "confirm" || now - press.at < PAD_HOLD_MS) continue;
				press.reportedHold = true;
				emit(action(press, "hold", now));
			}

			// Then the repeats, for presses that are still down.
			for (const [slot, press] of presses) {
				if (!held.has(slot) || !press.repeats || !REPEATING_KINDS.includes(press.kind)) continue;
				const due =
					press.repeatedAt === undefined ? now - press.at >= repeat.delayMs : now - press.repeatedAt >= intervalMs;
				if (!due) continue;
				press.repeatedAt = now;
				emit(action(press, "press", now));
			}

			// Finally the releases, one per press we recorded.
			for (const [slot, press] of presses) {
				if (held.has(slot)) continue;
				emit(action(press, "release", now));
				presses.delete(slot);
			}

			return actions;
		},

		reset() {
			presses.clear();
			stick = null;
			scroll = undefined;
		},

		suspendRepeat() {
			for (const press of presses.values()) press.repeats = false;
			if (scroll) scroll.repeats = false;
		},
	};
}

/** `undefined` for a button the user unbound: nothing happened, so nothing is said. */
function action(press: Press, phase: PadPhase, now: number): PadAction | undefined {
	if (press.kind === "none") return undefined;
	return {
		kind: press.kind,
		button: press.button,
		phase,
		heldMs: now - press.at,
		...(press.command === undefined ? {} : { command: press.command }),
	};
}

function scrollAction(value: number, heldMs: number): PadAction {
	return { kind: "scroll", button: "stick", phase: "press", heldMs, value };
}

/**
 * How long between repeats right now. L2 asks for fine steps and wins over R2's
 * fast ones: whoever is asking for more care should not be overridden by a slip
 * on the other hand.
 */
function intervalFor(repeat: PadRepeat, state: Ds4State): number {
	if (state.leftTrigger >= PAD_MODIFIER_PRESS) return repeat.slowIntervalMs;
	if (state.rightTrigger >= PAD_MODIFIER_PRESS) return repeat.fastIntervalMs;
	return repeat.intervalMs;
}
