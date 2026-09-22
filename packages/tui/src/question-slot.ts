import type { QuestionDialogState, UiQuestion } from "./ui-state.ts";

export interface QuestionSlotOptions {
	/** Render this dialog as current, or clear it with null. */
	show: (question: QuestionDialogState | null) => void;
}

export interface QuestionSlot {
	/** Show the questions; resolves with one answer per question, or null when canceled. */
	ask: (questions: UiQuestion[]) => Promise<string[] | null>;
	/** Cancel whatever is on screen — for a run being aborted. */
	clear: () => void;
}

/**
 * The question dialog's slot, and the two ways it ends.
 *
 * One dialog is on screen at a time, and until now it ended in exactly one way:
 * the user answering it (Esc included). That made the abort path a hang — the
 * tool call is awaiting this promise, the turn is awaiting the tool call, and
 * Ctrl+C while a question was up left the dialog asking about a run that had
 * already been cancelled, with nothing left to press. `clear` is the second
 * ending, and it lands as canceled rather than as an answer nobody gave.
 *
 * A second ask replaces the one on screen and settles the first as canceled.
 * That cannot happen through the tool — AskUserQuestion is not concurrency-safe,
 * so a turn asks one question at a time — but leaving a promise unresolved
 * because *this* file assumed a caller's discipline is the same hang wearing a
 * different hat.
 */
export function createQuestionSlot(options: QuestionSlotOptions): QuestionSlot {
	let pending: { token: object; resolve: (answers: string[] | null) => void } | null = null;

	/** End the dialog on screen, if that dialog is still `token`'s. */
	const end = (token: object, answers: string[] | null): void => {
		// A replaced dialog's own resolve can still be called — its handler is
		// dropped with its component, not synchronously with the replacement — and
		// an answer to a question nobody is looking at must not close the new one.
		if (pending?.token !== token) return;
		const { resolve } = pending;
		pending = null;
		options.show(null);
		resolve(answers);
	};

	return {
		ask: (questions) => {
			const previous = pending;
			const token = {};
			const asking = new Promise<string[] | null>((resolve) => {
				pending = { token, resolve };
				options.show({ questions, resolve: (answers) => end(token, answers) });
			});
			previous?.resolve(null);
			return asking;
		},
		clear: () => {
			// Nothing on screen: not worth a call, since the store write would
			// repaint the tree to say what it already says.
			if (pending) end(pending.token, null);
		},
	};
}
