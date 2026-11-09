/**
 * A full-screen consumer of the cell grid.
 *
 * The screen owns the double buffer, the terminal's cursor and the bytes.
 * A caller paints a frame into a plain grid of characters and styles; the
 * screen works out what changed since the last frame and writes only that.
 * Nothing about the caller's tree is retained: if it draws the same screen
 * twice, the second call writes nothing at all.
 *
 * This is deliberately not wired into Ink. Ink owns layout and draws the
 * transcript; this is the substrate for a view that wants a fixed screen of
 * cells and a frame diff, and it can be adopted one view at a time without
 * changing how the rest of the app renders.
 */

import type { CellBuffer } from "./cell-grid.ts";
import { CellGrid } from "./cell-grid.ts";
import type { StyleTable } from "./cell-style.ts";
import { chunkFrame, encodeFrame, hideCursor, resetStyle, showCursor } from "./frame.ts";

/** The part of a writable stream a screen needs. */
export interface ScreenStream {
	write(data: string): unknown;
}

export interface TerminalScreenOptions {
	stream: ScreenStream;
	/** Width in cells. The caller owns the terminal-size source. */
	columns: number;
	/** Height in cells. */
	rows: number;
	/**
	 * Wrap each frame in DEC mode 2026. On by default: a frame is drawn in one
	 * terminal update instead of showing the half-erased screen between cursor
	 * moves. A terminal that does not know the mode ignores the markers.
	 */
	synchronizedOutput?: boolean;
	/**
	 * Hide the cursor while the screen is up. On by default, because a blinking
	 * cursor parked in the middle of a redrawn frame reads as a render bug.
	 */
	hideCursor?: boolean;
}

/** Where the cursor is left after a frame, in zero-based cells. */
export interface CursorPosition {
	readonly row: number;
	readonly column: number;
}

/**
 * A double-buffered screen writing to a terminal.
 *
 * `paint` is the only draw call and it always draws a whole frame: the back
 * buffer is cleared first, so a caller never has to know what it drew last time.
 * The diff lives in `CellGrid.present`, and the bytes in `encodeFrame`; this
 * class is the lifecycle between them — the cursor, the screen erase that opens
 * the first frame and each frame after a resize, and the promise that disposal
 * leaves the terminal as it was found.
 *
 * The screen owns the display, so the first paint erases whatever was there.
 * A caller that wants its view drawn below existing output should not adopt a
 * full-screen view for it.
 */
export class TerminalScreen {
	readonly grid: CellGrid;
	private readonly stream: ScreenStream;
	private readonly synchronized: boolean;
	private readonly hidesCursor: boolean;
	private pendingClear = true;
	private closed = false;

	constructor(options: TerminalScreenOptions) {
		this.stream = options.stream;
		this.synchronized = options.synchronizedOutput ?? true;
		this.hidesCursor = options.hideCursor ?? true;
		this.grid = new CellGrid(options.columns, options.rows);
		if (this.hidesCursor) this.stream.write(hideCursor());
	}

	/** The screen's width in cells. */
	get columns(): number {
		return this.grid.width;
	}

	/** The screen's height in cells. */
	get rows(): number {
		return this.grid.height;
	}

	/**
	 * Paint one frame. Returns whether anything was written.
	 *
	 * `draw` receives the back buffer and the style table; the buffer is already
	 * empty. The cursor is moved only after a frame that drew something, so an
	 * unchanged poll leaves the terminal exactly alone — including the cursor
	 * where the previous frame parked it.
	 */
	paint(draw: (back: CellBuffer, styles: StyleTable) => void, cursor?: CursorPosition): boolean {
		if (this.closed) return false;
		this.grid.beginFrame();
		draw(this.grid.back, this.grid.styles);
		const ops = this.grid.present();
		const clear = this.pendingClear;
		this.pendingClear = false;
		if (ops.length === 0 && !clear) return false;
		const frame = encodeFrame(ops, this.grid.styles, { synchronized: this.synchronized, clear, cursor });
		// A frame has no newlines, so the ConPTY budget has to be respected here,
		// at the sequence boundaries.
		for (const chunk of chunkFrame(frame)) this.stream.write(chunk);
		return true;
	}

	/**
	 * Adopt a new terminal size. The next frame erases the screen before drawing,
	 * because the cells the old buffer described are no longer where they were.
	 */
	resize(columns: number, rows: number): boolean {
		if (this.closed) return false;
		if (columns === this.grid.width && rows === this.grid.height) return false;
		this.grid.resize(columns, rows);
		this.pendingClear = true;
		return true;
	}

	/** Restore the cursor and the default style. Safe to call twice. */
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.stream.write(resetStyle());
		if (this.hidesCursor) this.stream.write(showCursor());
	}
}
