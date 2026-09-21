/**
 * The on-screen keyboard: a keyboard for a device that does not have one.
 *
 * The layout is data, the cursor math is pure, and the component draws what
 * these return. That split is the point — the part that can be wrong is the part
 * with no pixels in it, and the part with pixels is a map over two arrays.
 *
 * Three pages, because a keyboard wants around thirty keys and a d-pad is a
 * slow way to walk them: letters, where the language is; digits, where the
 * numbers are; symbols, where everything else is. Choosing between them is one
 * press of a shoulder button rather than a trek across a hundred cells.
 *
 * The bottom row is fixed and does the work: shift on the letters page (there is
 * nothing to capitalise elsewhere, so it is not offered elsewhere), a space, a
 * backspace and a return. ✕ presses the key under the cursor and nothing else —
 * a prompt is sent by standing on the ⏎ and pressing, which is a thing nobody
 * does by accident.
 */

import type { PadDirection } from "@labunbun/gamepad";

export type OskCommand = "shift" | "backspace" | "submit";

/** One cell of the keyboard: a character, or one of the three commands. */
export interface OskKey {
	/** What the cell shows. */
	label: string;
	/** The character this key types, before shift. `undefined` for commands. */
	insert?: string;
	/** What this key does instead of typing. */
	command?: OskCommand;
}

export interface OskPage {
	/** Shown in the keyboard's own hint row. */
	name: string;
	rows: OskKey[][];
}

export interface OskCursor {
	row: number;
	col: number;
}

const shiftKey: OskKey = { label: "⇧", command: "shift" };
const backspaceKey: OskKey = { label: "⌫", command: "backspace" };
const submitKey: OskKey = { label: "⏎", command: "submit" };
const spaceKey: OskKey = { label: "space", insert: " " };

/** A row written as a string of characters — the only kind of row with no actions. */
function chars(row: string): OskKey[] {
	return [...row].map((character) => ({ label: character, insert: character }));
}

const BOTTOM = [shiftKey, spaceKey, backspaceKey, submitKey];
const BOTTOM_NO_SHIFT = [spaceKey, backspaceKey, submitKey];

export const OSK_PAGES: readonly OskPage[] = [
	{
		name: "letters",
		rows: [...["qwertyuiop", "asdfghjkl", "zxcvbnm"].map(chars), BOTTOM],
	},
	{
		name: "digits",
		rows: [...["1234567890", "-=/:;()$&@", ".,?!'\"+_*#"].map(chars), BOTTOM_NO_SHIFT],
	},
	{
		name: "symbols",
		rows: [...["!@#$%^&*()", "-_=+[]{}<>", "/\\|~`'\".;:"].map(chars), BOTTOM_NO_SHIFT],
	},
];

/** The page at an index, wrapping — the index is a position on a ring, not a range. */
export function oskPage(index: number): OskPage {
	const pages = OSK_PAGES.length;
	return OSK_PAGES[((index % pages) + pages) % pages];
}

/** The next page in a direction, wrapping at both ends. */
export function oskTurn(index: number, direction: 1 | -1): number {
	return (((index + direction) % OSK_PAGES.length) + OSK_PAGES.length) % OSK_PAGES.length;
}

/**
 * The cursor as something the page can actually hold.
 *
 * Rows are ragged on purpose — the letters page narrows toward the bottom the
 * way a keyboard does — so a cursor that moved *down* from a long row can land
 * past the end of a short one. Clamping the column is what keeps the highlight
 * on a key: a cursor at a cell that does not exist is a keyboard with no visible
 * selection, and the next press would type nothing.
 */
export function oskClamp(page: OskPage, cursor: OskCursor): OskCursor {
	const row = Math.min(Math.max(Math.trunc(cursor.row), 0), page.rows.length - 1);
	const width = page.rows[row].length;
	return { row, col: Math.min(Math.max(Math.trunc(cursor.col), 0), width - 1) };
}

/**
 * One step. No wrapping inside a row: the keyboard is a picture of where the
 * keys are, and a left push that jumps to the far end of the row contradicts
 * what the highlighted cell did.
 */
export function oskMove(page: OskPage, cursor: OskCursor, direction: PadDirection): OskCursor {
	const at = oskClamp(page, cursor);
	if (direction === "left") return oskClamp(page, { row: at.row, col: at.col - 1 });
	if (direction === "right") return oskClamp(page, { row: at.row, col: at.col + 1 });
	if (direction === "up") return oskClamp(page, { row: at.row - 1, col: at.col });
	return oskClamp(page, { row: at.row + 1, col: at.col });
}

/** The key under the cursor. Total: a clamped cursor is always on a key. */
export function oskKeyAt(page: OskPage, cursor: OskCursor): OskKey {
	const at = oskClamp(page, cursor);
	return page.rows[at.row][at.col];
}

/** Whether shift changes what this key says — i.e. it is a letter. */
function shiftable(key: OskKey): boolean {
	return key.insert !== undefined && /^[a-z]$/i.test(key.insert);
}

/** A key's caption, in the case it would type. */
export function oskLabel(key: OskKey, shift: boolean): string {
	return shift && shiftable(key) ? key.label.toUpperCase() : key.label;
}

/**
 * What pressing this key puts in the buffer, or `undefined` when the key is a
 * command. Shift is a property of the key it lands on rather than a state the
 * buffer knows about: the letters page types upper case while it is on, and the
 * other two pages never ask.
 */
export function oskType(key: OskKey, shift: boolean): string | undefined {
	if (key.insert === undefined) return undefined;
	return shift && shiftable(key) ? key.insert.toUpperCase() : key.insert;
}
