/**
 * Time, in the caller's hand.
 *
 * The service takes its clock and its timers as one dependency so that a test
 * can run a minute of controller in a microsecond. What the real `setInterval`
 * would do at 33 ms is not interesting; that the service asked for the right
 * thing at the right moment is, and only a fake can answer that.
 *
 * Firing is strictly by due time — a timer set during a callback as `now + 5`
 * lands after the ones already due, not before them — because a fake that
 * reorders them would hide exactly the races it exists to remove.
 */

import type { PadClock, PadTimer } from "../src/index.ts";

interface Scheduled {
	at: number;
	every: number | undefined;
	handler: () => void;
	timer: PadTimer;
}

export interface FauxClock extends PadClock {
	/** Move time forward, firing everything due, in order. Callbacks run synchronously. */
	advance(ms: number): void;
	/** How many timers are still scheduled. */
	pending(): number;
	/** Jump the clock without firing anything — for "the machine was asleep". */
	skip(ms: number): void;
}

export function createFauxClock(start = 0): FauxClock {
	let now = start;
	const timers = new Map<PadTimer, Scheduled>();

	function schedule(handler: () => void, ms: number, every: number | undefined): PadTimer {
		const timer: PadTimer = {};
		timers.set(timer, { at: now + ms, every, handler, timer });
		return timer;
	}

	function due(until: number): Scheduled | undefined {
		let soonest: Scheduled | undefined;
		for (const scheduled of timers.values()) {
			if (scheduled.at > until) continue;
			if (soonest === undefined || scheduled.at < soonest.at) soonest = scheduled;
		}
		return soonest;
	}

	return {
		now: () => now,
		setInterval: (handler, ms) => schedule(handler, ms, ms),
		clearInterval: (timer) => void timers.delete(timer),
		setTimeout: (handler, ms) => schedule(handler, ms, undefined),
		clearTimeout: (timer) => void timers.delete(timer),
		pending: () => timers.size,
		skip(ms) {
			now += ms;
		},
		advance(ms) {
			const until = now + ms;
			for (let next = due(until); next !== undefined; next = due(until)) {
				// Time moves to the timer, not the other way round: a callback that
				// asks what time it is gets the time it was scheduled for.
				now = next.at;
				if (next.every === undefined) timers.delete(next.timer);
				else next.at = now + next.every;
				next.handler();
			}
			now = until;
		},
	};
}
