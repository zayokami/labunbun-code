/**
 * `withStallTimeout` — the idle watchdog between the consumer and the wire.
 *
 * The failure it exists for is the request that never ends and never fails: a
 * provider or a proxy that accepted the connection and then went silent.
 * Timeouts inside the SDK cover a slow response, not a dead one — and the
 * retry layer only sees failures, so silence climbs no retry ladder and ends
 * no turn. This wrapper turns "no event for N ms" into a thrown
 * `StreamStallError`.
 *
 * Composition: it sits *under* retry (`withRetry(withStallTimeout(dispatch))`).
 * A stall before any event has flowed is a failed connection and earns the
 * ladder's second attempt; a stall after events have flowed is terminal, and
 * the session loop seals the partial as an errored turn.
 */

import { composeSignals } from "./signals.ts";
import type { AssistantMessageEvent, Context, Model, StreamFn, StreamOptions } from "./types.ts";

/**
 * The error a stream that went quiet raises.
 *
 * Deliberately not an AbortError: every layer above reads an aborted signal
 * as the user's interrupt, and a stalled connection is a provider fault.
 */
export class StreamStallError extends Error {
	constructor(idleTimeoutMs: number) {
		super(`Provider stream stalled: no event arrived for ${idleTimeoutMs}ms`);
		this.name = "StreamStallError";
	}
}

export interface StallTimeoutOptions {
	/** How long the stream may go without an event before it counts as stalled. */
	idleTimeoutMs: number;
}

export function withStallTimeout(streamFn: StreamFn, options: StallTimeoutOptions): StreamFn {
	const { idleTimeoutMs } = options;
	return async function* guardedStream(
		model: Model,
		context: Context,
		streamOptions?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		// The stall must reach the wire — the request under it has to stop — but
		// without aborting the caller's signal: every layer above reads an
		// aborted caller signal as the user's interrupt. So the abort is this
		// wrapper's own controller, composed with the caller's so Esc still
		// cancels.
		const cascade = new AbortController();
		const signal = streamOptions?.signal ? composeSignals(cascade.signal, streamOptions.signal) : cascade.signal;
		// The explicit iterator, not the iterable: the watchdog paces `next()`
		// itself rather than handing the whole stream to a for-await.
		const inner = streamFn(model, context, { ...streamOptions, signal })[Symbol.asyncIterator]();
		try {
			while (true) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const stalled = new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						// Abort first, then reject: the connection stops in the turn
						// the watchdog gives up, rather than lingering while the
						// error travels up through the wrappers.
						cascade.abort();
						reject(new StreamStallError(idleTimeoutMs));
					}, idleTimeoutMs);
				});
				const next = inner.next();
				// Both promises settle; the race consumes one. The loser's
				// rejection still needs a handler, or it surfaces as an
				// unhandled rejection.
				next.catch(() => {});
				let result: IteratorResult<AssistantMessageEvent>;
				try {
					result = await Promise.race([next, stalled]);
				} finally {
					clearTimeout(timer);
				}
				if (result.done) return;
				yield result.value;
			}
		} finally {
			// The consumer may have walked away mid-stream (an interrupt, an
			// early break); the inner generator still holds the connection.
			// Not awaited: an inner suspended on a promise that never settles
			// would hang this cleanup, and the cascade abort above is what
			// actually stops a real request.
			void Promise.resolve(inner.return?.(undefined)).catch(() => {});
		}
	};
}
