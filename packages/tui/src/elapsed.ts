/**
 * Turn timing for the status row.
 *
 * Two separate concerns live here, both pure so the rules can be tested without
 * rendering anything: how a duration is spelled, and how the clock behaves
 * across a run that pauses to ask a question.
 */

/**
 * Spell a duration the way the status row wants it: seconds under a minute, then
 * `1m 05s`, then `1h 00m 00s`. Every field after the first is zero-padded so the
 * row does not twitch sideways each time a digit is gained.
 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	if (total < 3600) return `${minutes}m ${pad(seconds)}s`;
	return `${Math.floor(total / 3600)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export interface TimerState {
	/** Milliseconds banked by counting segments that already closed. */
	accumulatedMs: number;
	/** When the open counting segment began; null while frozen. */
	segmentStartedAt: number | null;
	/** Last value handed to the UI. */
	elapsedMs: number;
	/** Whether a run is in flight. */
	busy: boolean;
}

export const IDLE_TIMER: TimerState = Object.freeze({
	accumulatedMs: 0,
	segmentStartedAt: null,
	elapsedMs: 0,
	busy: false,
});

/**
 * Move the clock to `now`.
 *
 * A freeze closes the open segment instead of discarding it, so the time spent
 * waiting on an approval is not charged to the turn — the number stops where it
 * was and picks up there afterwards. Not busy means the turn is over: the next
 * one starts from zero.
 *
 * Returns the same object when nothing changed, so a caller can skip a render by
 * identity.
 */
export function advanceTimer(
	state: TimerState,
	now: number,
	{ busy, frozen }: { busy: boolean; frozen: boolean },
): TimerState {
	if (!busy) return state.busy ? IDLE_TIMER : state;
	const accumulatedMs = frozen
		? state.accumulatedMs + (state.segmentStartedAt === null ? 0 : now - state.segmentStartedAt)
		: state.accumulatedMs;
	const segmentStartedAt = frozen ? null : (state.segmentStartedAt ?? now);
	return {
		accumulatedMs,
		segmentStartedAt,
		elapsedMs: accumulatedMs + (segmentStartedAt === null ? 0 : now - segmentStartedAt),
		busy: true,
	};
}
