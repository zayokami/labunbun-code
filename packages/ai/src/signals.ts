// Long-form design notes: docs/dev/ai-layer.md
/** Compose the two aborts one request answers to. */

// Long-form design notes: docs/dev/ai-layer.md
/** An AbortSignal that aborts when either the SDK's or the caller's does. */
export function composeSignals(sdkSignal: AbortSignal | null | undefined, callerSignal: AbortSignal): AbortSignal {
	if (!sdkSignal || typeof AbortSignal.any !== "function") return callerSignal;
	return AbortSignal.any([sdkSignal, callerSignal]);
}
