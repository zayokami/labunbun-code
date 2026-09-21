/**
 * The command wheel: the whole command table and the user's own phrases, one
 * press away, without a keyboard to type any of them.
 *
 * A list, not a picture — the opposite of the on-screen keyboard, and for the
 * opposite reason. Commands have no spatial arrangement to be faithful to, so
 * the highlight wraps the way a list of choices does everywhere else in this
 * app: down from the last row lands on the first.
 *
 * Two kinds share the ring because they share the gesture. A command *runs*; a
 * phrase *fills the prompt*, which is the difference between "do this now" and
 * "this is what I want to say" — and the only one the user has to know.
 */

export interface WheelEntry {
	/** What the ring shows. */
	label: string;
	/** What pressing it produces: a command line, or text for the prompt. */
	text: string;
	kind: "command" | "phrase";
	/** The command table's one-liner, when there is one. */
	description?: string;
}

/** How many rows of the ring are on screen at once. */
export const WHEEL_ROWS = 5;

/** Longest a phrase is allowed to be before it is cut, in characters. */
const PHRASE_WIDTH = 56;

export function wheelEntries(commands: Array<[string, string]>, phrases: readonly string[]): WheelEntry[] {
	return [
		...commands.map(([name, description]) => ({ label: name, text: name, kind: "command" as const, description })),
		...phrases.map((phrase) => ({ label: phraseLabel(phrase), text: phrase, kind: "phrase" as const })),
	];
}

/**
 * The selection after a move, wrapping at both ends. Also the answer for a move
 * that lands nowhere: an empty ring has one position, which is also the one the
 * component draws nothing for.
 */
export function wheelMove(count: number, index: number, step: number): number {
	if (count <= 0) return 0;
	return (((index + step) % count) + count) % count;
}

/** The first row of the window, kept so the selection stays inside it. */
export function wheelStart(count: number, index: number, rows = WHEEL_ROWS): number {
	return Math.max(0, Math.min(index - (rows - 1), count - rows));
}

/**
 * A phrase as one line of the ring.
 *
 * Whitespace folds because the ring is one row per entry, and a phrase written
 * across four lines of a settings file would otherwise push the box off the
 * screen. It stays recognisable — this is a finger's-eye view of text the user
 * wrote and will see in full in the prompt.
 */
export function phraseLabel(phrase: string, width = PHRASE_WIDTH): string {
	const line = phrase.replace(/\s+/g, " ").trim();
	return line.length <= width ? line : `${line.slice(0, width - 1)}…`;
}
