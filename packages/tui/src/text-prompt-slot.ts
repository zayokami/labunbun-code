import type { TextPromptRequest, TextPromptState } from "./ui-state.ts";

export interface TextPromptSlotOptions {
	/** Render this dialog as current, or clear it with null. */
	show: (textPrompt: TextPromptState | null) => void;
}

export interface TextPromptSlot {
	/** Show the request; resolves with the typed value, or null when canceled. */
	prompt: (request: TextPromptRequest) => Promise<string | null>;
	/** Cancel whatever is on screen — for a run being aborted or a session swap. */
	clear: () => void;
}

/**
 * The single-line text prompt's slot, shaped like the question and phrase
 * slots beside it.
 *
 * The two endings are the same pair every modal here has — an answer and a
 * cancellation — and so is the reason for the second: a caller is awaiting
 * this promise, and a dialog left up by an abort or a replaced request would
 * leave it waiting forever. What is different is the answer: an arbitrary
 * string the dialog only checks for emptiness and for whatever validator the
 * caller supplied, so the validation rule stays beside the thing being asked
 * for rather than inside the surface.
 */
export function createTextPromptSlot(options: TextPromptSlotOptions): TextPromptSlot {
	let pending: { token: object; resolve: (value: string | null) => void } | null = null;

	/** End the dialog on screen, if that dialog is still `token`'s. */
	const end = (token: object, value: string | null): void => {
		if (pending?.token !== token) return;
		const { resolve } = pending;
		pending = null;
		options.show(null);
		resolve(value);
	};

	return {
		prompt: (request) => {
			const previous = pending;
			const token = {};
			const asking = new Promise<string | null>((resolve) => {
				pending = { token, resolve };
				options.show({ ...request, resolve: (value) => end(token, value) });
			});
			// A replaced prompt resolves as canceled: the request on screen is the
			// one the next answer belongs to.
			previous?.resolve(null);
			return asking;
		},
		clear: () => {
			if (pending) end(pending.token, null);
		},
	};
}
