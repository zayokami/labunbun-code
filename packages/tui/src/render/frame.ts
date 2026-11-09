/**
 * Turning a changed grid into bytes.
 *
 * The diff walks both buffers row by row and groups adjacent changed cells of
 * the same style into one run. The encoder then writes each run with as few
 * cursor moves as possible: a run that begins where the previous one ended
 * needs none, and only a style change costs an SGR sequence. A frame that
 * changed nothing encodes to the empty string, which is what lets a screen
 * repaint itself on a poll without touching the terminal.
 */

import { MAX_CONPTY_WRITE } from "../conpty.ts";
import type { CellBuffer } from "./cell-grid.ts";
import type { StyleTable } from "./cell-style.ts";
import { displayWidth } from "./width.ts";

/** One run of changed cells on one row, already grouped by style. */
export interface FrameOp {
	readonly row: number;
	readonly column: number;
	readonly text: string;
	readonly styleId: number;
}

/**
 * The runs that differ between what the screen shows (`front`) and what the
 * next frame wants (`back`).
 *
 * Continuation cells are skipped: the wide glyph's head already emits both
 * columns, and emitting the right half would print the glyph twice or print a
 * blank over its second cell. A blank cell that changed emits a space — erasing
 * is a write like any other, and a styled blank (a background colour) has to be
 * repainted even though it holds no glyph.
 */
export function diffBuffers(front: CellBuffer, back: CellBuffer): FrameOp[] {
	const ops: FrameOp[] = [];
	if (front.width !== back.width || front.height !== back.height) return ops;
	for (let row = 0; row < back.height; row++) {
		let start = -1;
		let end = 0;
		let styleId = -1;
		let text = "";
		const flush = () => {
			if (start < 0) return;
			ops.push({ row, column: start, text, styleId });
			start = -1;
			text = "";
		};
		for (let column = 0; column < back.width; ) {
			const index = row * back.width + column;
			if ((back.flags[index] & 2) !== 0) {
				// A continuation is always immediately after the head that emits it.
				flush();
				column++;
				continue;
			}
			if (back.equalAt(front, index)) {
				flush();
				column++;
				continue;
			}
			const cellStyle = back.styles[index];
			if (start >= 0 && (cellStyle !== styleId || column !== end)) flush();
			if (start < 0) {
				start = column;
				styleId = cellStyle;
			}
			text += back.textAtIndex(index);
			const advance = back.advanceAt(index);
			end = column + advance;
			column = end;
		}
		flush();
	}
	return ops;
}

/** How the encoder should frame the bytes it emits. */
export interface FrameOptions {
	/** Wrap the frame in DEC mode 2026, so the terminal shows it atomically. */
	readonly synchronized?: boolean;
	/** Erase the screen before drawing, for a resize or a deliberate repaint. */
	readonly clear?: boolean;
	/** Park the cursor at this cell after the frame. */
	readonly cursor?: { readonly row: number; readonly column: number };
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const CLEAR_SCREEN = "\x1b[H\x1b[2J";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/** The bytes that hide the terminal's cursor. */
export function hideCursor(): string {
	return HIDE_CURSOR;
}

/** The bytes that make the terminal's cursor visible again. */
export function showCursor(): string {
	return SHOW_CURSOR;
}

/** The bytes that restore the terminal's default appearance. */
export function resetStyle(): string {
	return RESET;
}

/**
 * Encode `ops` as ANSI.
 *
 * Rows and columns are zero-based in the grid and one-based in the escape
 * grammar; the conversion happens here and nowhere else. The frame ends in the
 * default style so a run cannot bleed into the prompt below it, and is wrapped
 * in synchronized-output markers unless the caller turned them off for a
 * terminal that does not know the mode.
 */
export function encodeFrame(ops: readonly FrameOp[], styles: StyleTable, options: FrameOptions = {}): string {
	if (ops.length === 0 && options.clear !== true) return "";
	const parts: string[] = [];
	let pending = "";
	let currentStyle = -1;
	let currentRow = -1;
	let currentColumn = -1;
	const flush = () => {
		if (pending === "") return;
		parts.push(pending);
		pending = "";
	};
	if (options.clear) {
		parts.push(CLEAR_SCREEN);
		currentRow = 0;
		currentColumn = 0;
	}
	for (const op of ops) {
		if (op.styleId !== currentStyle) {
			flush();
			parts.push(styles.sgr(op.styleId));
			currentStyle = op.styleId;
		}
		if (op.row !== currentRow || op.column !== currentColumn) {
			flush();
			parts.push(`\x1b[${op.row + 1};${op.column + 1}H`);
			currentRow = op.row;
			currentColumn = op.column;
		}
		pending += op.text;
		currentColumn += displayWidth(op.text);
	}
	flush();
	if (currentStyle > 0) parts.push(RESET);
	if (options.cursor) parts.push(`\x1b[${options.cursor.row + 1};${options.cursor.column + 1}H`);
	const body = parts.join("");
	if (body === "") return "";
	return options.synchronized === false ? body : `${SYNC_START}${body}${SYNC_END}`;
}

/** One escape sequence or one code point — the units a write may not split. */
function* frameTokens(frame: string): Generator<string> {
	let i = 0;
	while (i < frame.length) {
		if (frame.charCodeAt(i) !== 0x1b) {
			const code = frame.codePointAt(i) ?? 0;
			const length = code > 0xffff ? 2 : 1;
			yield frame.slice(i, i + length);
			i += length;
			continue;
		}
		const start = i;
		const kind = frame.charCodeAt(i + 1);
		if (kind === 0x5b) {
			// CSI: parameters and intermediates, then one final byte in 0x40–0x7e.
			i += 2;
			while (i < frame.length && !(frame.charCodeAt(i) >= 0x40 && frame.charCodeAt(i) <= 0x7e)) i++;
			if (i < frame.length) i++;
		} else if (kind === 0x5d) {
			// OSC: terminated by BEL or ST. The encoder emits none today, but a
			// caller may introduce one and a split inside it would be visible.
			i += 2;
			while (i < frame.length) {
				if (frame.charCodeAt(i) === 0x07) {
					i++;
					break;
				}
				if (frame.charCodeAt(i) === 0x1b && frame.charCodeAt(i + 1) === 0x5c) {
					i += 2;
					break;
				}
				i++;
			}
		} else {
			i = Math.min(i + 2, frame.length);
		}
		yield frame.slice(start, i);
	}
}

/**
 * Split an encoded frame into writes under the ConPTY budget, cutting only
 * between escape sequences and code points.
 *
 * A frame contains no newlines for `chunkForConPTY` to cut at, so the chunking
 * has to happen here, where the sequence boundaries are known. A single
 * sequence longer than `max` rides in a chunk of its own rather than being
 * split; in practice sequences are a dozen bytes and the budget is 8 KB.
 */
export function chunkFrame(frame: string, max = MAX_CONPTY_WRITE): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const token of frameTokens(frame)) {
		if (current !== "" && current.length + token.length > max) {
			chunks.push(current);
			current = "";
		}
		current += token;
	}
	if (current !== "") chunks.push(current);
	return chunks;
}
