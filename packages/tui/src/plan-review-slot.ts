import type { PlanReviewDialogState, PlanReviewResult } from "./ui-state.ts";

export interface PlanReviewSlotOptions {
	/** Render this dialog as current, or clear it with null. */
	show: (dialog: PlanReviewDialogState | null) => void;
}

export interface PlanReviewSlot {
	/**
	 * Show a plan for review; resolves with the answer, or null when canceled —
	 * by the user, by a replacing request, by `clear`, or by `signal`.
	 */
	request: (plan: string, signal?: AbortSignal) => Promise<PlanReviewResult | null>;
	/** Cancel whatever is on screen — for a run being aborted. */
	clear: () => void;
}

/**
 * The plan review dialog's slot, and the ways it can end.
 *
 * It mirrors the question slot next door: one dialog is on screen at a time, a
 * second request replaces the first and settles it as canceled, and `clear`
 * settles the current one as canceled. The difference is that this dialog
 * belongs to a tool call that already carries the run's abort signal, so the
 * slot takes the signal itself: an abort that lands while the plan is up takes
 * the dialog down in the same statement that settles the promise. Without that
 * second ending the turn would wait on a reviewer for a run nobody wants
 * reviewed any more.
 *
 * A replacement and an abort both end in null, which the caller reads as
 * "canceled" rather than as a rejection with no note — an answer nobody gave
 * must not be reported to the model as one.
 */
export function createPlanReviewSlot(options: PlanReviewSlotOptions): PlanReviewSlot {
	let pending: {
		token: object;
		resolve: (result: PlanReviewResult | null) => void;
		/** Remove this request's abort listener; set once the signal is attached. */
		detach: () => void;
	} | null = null;

	/** End the dialog on screen, if that dialog is still `token`'s. */
	const end = (token: object, result: PlanReviewResult | null): void => {
		// A replaced dialog's own resolve can still be called — its handler is
		// dropped with its component, not synchronously with the replacement — and
		// an answer to a plan nobody is looking at must not close the new one.
		if (pending?.token !== token) return;
		const { resolve, detach } = pending;
		pending = null;
		detach();
		options.show(null);
		resolve(result);
	};

	return {
		request: (plan, signal) => {
			// A run that aborted before the dialog was asked for gets its answer
			// without a screen: nothing on it would be reviewable. The dialog that
			// may already be up is left alone — it belongs to a request that is
			// still live.
			if (signal?.aborted) return Promise.resolve(null);
			const previous = pending;
			const token = {};
			const reviewing = new Promise<PlanReviewResult | null>((resolve) => {
				let onAbort: (() => void) | undefined;
				const detach = (): void => {
					if (onAbort && signal) signal.removeEventListener("abort", onAbort);
				};
				if (signal) {
					onAbort = () => end(token, null);
					signal.addEventListener("abort", onAbort, { once: true });
				}
				pending = { token, resolve, detach };
				options.show({ plan, resolve: (result) => end(token, result) });
			});
			// The new dialog is already on screen in the executor above, so the old
			// one is settled directly rather than through `end` — `end` would see the
			// new token and refuse. Its abort listener goes with it.
			if (previous) {
				previous.detach();
				previous.resolve(null);
			}
			return reviewing;
		},
		clear: () => {
			// Nothing on screen: not worth a call, since the store write would
			// repaint the tree to say what it already says.
			if (pending) end(pending.token, null);
		},
	};
}
