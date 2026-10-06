/**
 * Compose the two aborts one request answers to.
 *
 * Each provider adapter hands the SDK a custom fetch. The SDK calls it with
 * its *own* signal on the init — its per-request timeout timer aborts through
 * that one — and the caller's signal (the user's Esc) travels beside it. A
 * request has to answer to both; passing one where two exist means whichever
 * is dropped can no longer cancel anything.
 */

/**
 * An AbortSignal that aborts when either the SDK's or the caller's does.
 *
 * With no SDK signal there is nothing to combine and the caller's signal is
 * handed back as-is: a manufactured wrapper would only add a listener that
 * outlives the call. On runtimes without `AbortSignal.any` the caller's signal
 * is passed through alone — the pre-composition behavior, kept rather than
 * emulated.
 */
export function composeSignals(sdkSignal: AbortSignal | null | undefined, callerSignal: AbortSignal): AbortSignal {
	if (!sdkSignal || typeof AbortSignal.any !== "function") return callerSignal;
	return AbortSignal.any([sdkSignal, callerSignal]);
}
