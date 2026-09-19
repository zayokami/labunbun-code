import { useEffect, useRef, useState } from "react";
import { advanceTimer, IDLE_TIMER, type TimerState } from "../elapsed.ts";

/** How often the displayed duration is recomputed. */
export const TURN_TIMER_TICK_MS = 500;

/**
 * Wall-clock duration of the current turn.
 *
 * The interval is keyed on the two booleans and nothing else. Keying it on the
 * status phase — which is what the REPL used to do — restarted the clock at
 * every thinking → responding → tools switch, so the row counted the current
 * phase rather than the turn, and reset to 0s in the middle of a long run.
 */
export function useTurnTimer({ busy, frozen }: { busy: boolean; frozen: boolean }): number {
	const stateRef = useRef<TimerState>(IDLE_TIMER);
	const [elapsedMs, setElapsedMs] = useState(0);

	useEffect(() => {
		let stopped = false;
		const step = (): void => {
			if (stopped) return;
			const next = advanceTimer(stateRef.current, Date.now(), { busy, frozen });
			if (next === stateRef.current) return;
			stateRef.current = next;
			setElapsedMs(next.elapsedMs);
		};
		step();
		if (!busy) return;
		const timer = setInterval(step, TURN_TIMER_TICK_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [busy, frozen]);

	return elapsedMs;
}
