import { prevChar } from "./vim.ts";

/**
 * `text` without its last character, as Backspace means it. `slice(0, -1)` cuts
 * one UTF-16 unit, so it leaves half of an emoji behind, which prints as garbage;
 * this steps over a whole pair or cluster, and over a paste token.
 */
export function dropLastChar(text: string): string {
	return text.slice(0, prevChar(text, text.length));
}

/** The part of a TTY input stream this module touches. */
export interface RawModeStream {
	isTTY?: boolean;
	setRawMode?: (mode: boolean) => unknown;
}

/**
 * Put a terminal's input into raw mode before Ink is created.
 *
 * Ink asks the terminal whether it speaks the kitty keyboard protocol
 * (`CSI ? u`) from its constructor, but asks for raw mode only when the first
 * input component mounts, a render later. A terminal that answers at once —
 * iTerm2 does, with `CSI ? 0 u` — is then talking to a line discipline that
 * still echoes, and the answer is painted on the screen as `^[[?0u`. In raw mode
 * the answer is only read. Ink restores the mode when it unmounts.
 *
 * Returns whether raw mode was entered. A stream that is not a TTY, or that
 * cannot switch modes, is left alone; so is one that refuses.
 */
export function enterRawModeEarly(stdin: RawModeStream): boolean {
	if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return false;
	try {
		stdin.setRawMode(true);
		return true;
	} catch {
		return false;
	}
}
