/**
 * `composeSignals` — the two aborts one request answers to.
 *
 * Each provider adapter hands the SDK a custom fetch. The SDK calls it with
 * its *own* signal on the init — its per-request timeout timer aborts through
 * that one — and the caller's signal (Esc) travels beside it. Passing only
 * the caller's, which is what the adapters used to do, silently replaced the
 * SDK's: a request whose timeout can never fire is a hang with no ceiling.
 */
import { describe, expect, test } from "bun:test";
import { composeSignals } from "../src/signals.ts";

describe("composeSignals", () => {
	test("aborting either side aborts the composite", () => {
		const sdk = new AbortController();
		const caller = new AbortController();
		const composed = composeSignals(sdk.signal, caller.signal);
		expect(composed.aborted).toBe(false);

		caller.abort();
		expect(composed.aborted).toBe(true);

		const sdk2 = new AbortController();
		const caller2 = new AbortController();
		const composed2 = composeSignals(sdk2.signal, caller2.signal);
		sdk2.abort();
		expect(composed2.aborted).toBe(true);
	});

	test("a side that is already aborted makes the composite aborted", () => {
		const aborted = new AbortController();
		aborted.abort();
		const live = new AbortController();

		expect(composeSignals(aborted.signal, live.signal).aborted).toBe(true);
		expect(composeSignals(live.signal, aborted.signal).aborted).toBe(true);
		expect(composeSignals(undefined, aborted.signal).aborted).toBe(true);
	});

	test("no sdk signal hands the caller's through untouched", () => {
		// The identity, not merely the state: with nothing to combine there is
		// no reason to manufacture a signal — and one that outlives the call
		// would be a listener holding the request's body alive.
		const caller = new AbortController();
		expect(composeSignals(undefined, caller.signal)).toBe(caller.signal);
	});
});
