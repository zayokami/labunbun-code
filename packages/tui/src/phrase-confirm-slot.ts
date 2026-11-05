import type { PhraseConfirmRequest, PhraseConfirmState } from "./ui-state.ts";

export interface PhraseConfirmSlotOptions {
	/** Render this dialog as current, or clear it with null. */
	show: (phraseConfirm: PhraseConfirmState | null) => void;
}

export interface PhraseConfirmSlot {
	/** Show the request; resolves true only when the exact phrase was typed. */
	confirm: (request: PhraseConfirmRequest) => Promise<boolean>;
	/** Cancel whatever is on screen — for a run being aborted or a session swap. */
	clear: () => void;
}

/**
 * The phrase confirmation's slot, shaped like the question slot beside it.
 *
 * It has the same two endings — an answer and a cancellation — and the same
 * reason for the second: a caller is awaiting this promise, and a dialog left
 * up by an abort or a replaced request would leave it waiting forever. What is
 * different is the answer: the dialog itself decides whether the typed phrase
 * matches, so `confirm` only ever resolves true for an exact match.
 */
export function createPhraseConfirmSlot(options: PhraseConfirmSlotOptions): PhraseConfirmSlot {
	let pending: { token: object; resolve: (confirmed: boolean) => void } | null = null;

	/** End the dialog on screen, if that dialog is still `token`'s. */
	const end = (token: object, confirmed: boolean): void => {
		if (pending?.token !== token) return;
		const { resolve } = pending;
		pending = null;
		options.show(null);
		resolve(confirmed);
	};

	return {
		confirm: (request) => {
			const previous = pending;
			const token = {};
			const asking = new Promise<boolean>((resolve) => {
				pending = { token, resolve };
				options.show({ ...request, resolve: (confirmed) => end(token, confirmed) });
			});
			// A replaced confirmation resolves as not confirmed: the request on
			// screen is the one the next answer belongs to.
			previous?.resolve(false);
			return asking;
		},
		clear: () => {
			if (pending) end(pending.token, false);
		},
	};
}
