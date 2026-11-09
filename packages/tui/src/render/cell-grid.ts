/**
 * The cell grid: two TypedArray buffers, compared and swapped one frame at a
 * time.
 *
 * Every cell is three array slots — the code point, the interned style id, and
 * a flag byte — so a 200×60 screen is a handful of contiguous allocations that
 * are reused for the life of the screen. Nothing in a frame allocates a cell
 * object; the only per-frame allocation is the diff itself, which is as long as
 * what changed.
 *
 * The `front` buffer is what the terminal currently shows. The `back` buffer is
 * what the next frame wants it to show. `present()` compares them, hands the
 * changed runs to the encoder, and swaps — so the old front becomes next
 * frame's scratch space, already the right size.
 *
 * Wide glyphs occupy two cells: the head carries the code point (or the
 * cluster) and the `WIDE` flag, and the cell to its right is a `CONTINUATION`
 * that draws nothing. Writing over either half clears both, because a half
 * glyph is what turns a screen into garbage after a resize or a redraw.
 */

import { StyleTable } from "./cell-style.ts";
import { diffBuffers, type FrameOp } from "./frame.ts";
import { graphemeWidth } from "./width.ts";

/** The cell is a multi-code-point grapheme; its text is in the cluster map. */
const CLUSTER = 1;
/** The right half of a wide glyph. It occupies a cell and draws nothing. */
const CONTINUATION = 2;
/** The left half of a wide glyph, which draws over this cell and the next. */
const WIDE = 4;

const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** The code point of a single-code-point cluster, or 0 when it needs the map. */
function singleCodePoint(cluster: string): number {
	const code = cluster.codePointAt(0) ?? 0;
	const length = code > 0xffff ? 2 : 1;
	return cluster.length === length ? code : 0;
}

/** True for C0, DEL and C1 — bytes that must never reach the terminal raw. */
function isControl(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/**
 * One buffer of cells.
 *
 * A blank cell is code point 0 with style 0. A space typed with the default
 * style is normalized to a blank, so re-painting the same text does not make
 * the diff think a row changed when only the space glyph did. A space with a
 * background colour is not blank — the coloured cell is the point.
 */
export class CellBuffer {
	readonly width: number;
	readonly height: number;
	/** Code points, one per cell. 0 is blank or a cluster; see `flags`. */
	readonly glyphs: Uint32Array;
	/** Interned style ids, one per cell. */
	readonly styles: Uint32Array;
	/** `CLUSTER`, `CONTINUATION`, `WIDE`, or none of them. */
	readonly flags: Uint8Array;
	private readonly clusters = new Map<number, string>();

	constructor(width: number, height: number) {
		if (!Number.isInteger(width) || width < 0)
			throw new RangeError(`cell buffer width must be a non-negative integer, got ${width}`);
		if (!Number.isInteger(height) || height < 0) {
			throw new RangeError(`cell buffer height must be a non-negative integer, got ${height}`);
		}
		this.width = width;
		this.height = height;
		this.glyphs = new Uint32Array(width * height);
		this.styles = new Uint32Array(width * height);
		this.flags = new Uint8Array(width * height);
	}

	/** Empty the buffer, leaving every cell blank in `styleId` (usually 0). */
	clear(styleId = 0): void {
		this.glyphs.fill(0);
		this.styles.fill(styleId);
		this.flags.fill(0);
		this.clusters.clear();
	}

	/**
	 * Place one grapheme at `(x, y)` in `styleId`, returning how many columns it
	 * took (0 when it could not be placed).
	 *
	 * A wide glyph at the last column has nowhere to go, so a space is written
	 * there instead: the terminal would wrap a two-cell glyph, which would move
	 * everything after it one row down.
	 */
	setCell(x: number, y: number, text: string, styleId = 0): number {
		const index = this.indexAt(x, y);
		if (index < 0 || text === "") return 0;
		const first = SEGMENTER.segment(text)[Symbol.iterator]().next().value?.segment;
		if (first === undefined) return 0;
		if (isControl(first.codePointAt(0) ?? 0)) {
			// Same contract as `writeText`: a control byte is drawn as a space,
			// never handed to the terminal.
			this.writeAscii(x, y, 0x20, styleId);
			return 1;
		}
		const width = graphemeWidth(first);
		if (width === 0) return 0;
		if (x + width > this.width) {
			this.writeAscii(x, y, 0x20, styleId);
			return 1;
		}
		this.place(x, y, first, width, styleId);
		return width;
	}

	/**
	 * Lay `text` out from `(x, y)`, one grapheme per cell run, stopping at
	 * `limit` columns (exclusive). Returns the number of columns written.
	 *
	 * The grid is a screen, not a document: a newline is a control byte and is
	 * written as a space. Layout is the caller's business. Every other control
	 * byte is treated the same way, which is also what keeps an escape sequence
	 * inside user text from driving the terminal.
	 */
	writeText(x: number, y: number, text: string, styleId = 0, limit = this.width): number {
		const start = x;
		if (y < 0 || y >= this.height || x < 0 || x >= this.width || text === "") return 0;
		const end = Math.min(limit, this.width);
		if (PRINTABLE_ASCII.test(text)) {
			for (let i = 0; i < text.length && x < end; i++) {
				this.writeAscii(x, y, text.charCodeAt(i), styleId);
				x++;
			}
			return x - start;
		}
		for (const { segment } of SEGMENTER.segment(text)) {
			const code = segment.codePointAt(0) ?? 0;
			const width = isControl(code) ? 1 : graphemeWidth(segment);
			// A mark with no base in this call has nothing to attach to.
			if (width === 0) continue;
			if (x + width > end) {
				// A wide glyph at the edge cannot be drawn. Fill the last cell and
				// stop; skipping it and drawing what follows would shift the text.
				if (x < end) {
					this.writeAscii(x, y, 0x20, styleId);
					x++;
				}
				break;
			}
			if (isControl(code)) this.writeAscii(x, y, 0x20, styleId);
			else this.place(x, y, segment, width, styleId);
			x += width;
		}
		return x - start;
	}

	/** The text in one cell. A continuation cell and an out-of-range cell are empty. */
	textAt(x: number, y: number): string {
		const index = this.indexAt(x, y);
		if (index < 0 || this.flags[index] & CONTINUATION) return "";
		return this.textAtIndex(index);
	}

	/** The style id in one cell, or 0 out of range. */
	styleAt(x: number, y: number): number {
		const index = this.indexAt(x, y);
		return index < 0 ? 0 : this.styles[index];
	}

	/** Whether this cell is the right half of a wide glyph. */
	isContinuation(x: number, y: number): boolean {
		const index = this.indexAt(x, y);
		return index >= 0 && (this.flags[index] & CONTINUATION) !== 0;
	}

	/** The text in a cell by index, as the diff sees it. Blank cells read as a space. */
	textAtIndex(index: number): string {
		const cluster = this.clusters.get(index);
		if (cluster !== undefined) return cluster;
		const code = this.glyphs[index];
		return code === 0 ? " " : String.fromCodePoint(code);
	}

	/** How many columns the cell at `index` occupies. Only heads and blanks are asked. */
	advanceAt(index: number): number {
		return this.flags[index] & WIDE ? 2 : 1;
	}

	/** Whether two buffers agree about the cell at `index`. */
	equalAt(other: CellBuffer, index: number): boolean {
		if (this.glyphs[index] !== other.glyphs[index]) return false;
		if (this.styles[index] !== other.styles[index]) return false;
		if (this.flags[index] !== other.flags[index]) return false;
		const mine = this.clusters.get(index);
		const theirs = other.clusters.get(index);
		return mine === undefined ? theirs === undefined : mine === theirs;
	}

	private indexAt(x: number, y: number): number {
		if (!Number.isInteger(x) || !Number.isInteger(y)) return -1;
		if (x < 0 || x >= this.width || y < 0 || y >= this.height) return -1;
		return y * this.width + x;
	}

	private place(x: number, y: number, cluster: string, width: number, styleId: number): void {
		const index = y * this.width + x;
		this.clearWideAt(x, y);
		if (width === 2) this.clearWideAt(x + 1, y);
		const code = singleCodePoint(cluster);
		this.glyphs[index] = code;
		this.styles[index] = styleId;
		let flags = width === 2 ? WIDE : 0;
		if (code === 0) {
			flags |= CLUSTER;
			this.clusters.set(index, cluster);
		} else {
			this.clusters.delete(index);
		}
		this.flags[index] = flags;
		if (width === 2) {
			const next = index + 1;
			this.glyphs[next] = 0;
			this.styles[next] = styleId;
			this.flags[next] = CONTINUATION;
			this.clusters.delete(next);
		}
	}

	private writeAscii(x: number, y: number, code: number, styleId: number): void {
		const index = y * this.width + x;
		this.clearWideAt(x, y);
		// A plain space is the blank cell; keeping the glyph would make two
		// visually identical buffers compare as different forever.
		if (code === 0x20 && styleId === 0) {
			this.resetCell(index);
			return;
		}
		this.glyphs[index] = code;
		this.styles[index] = styleId;
		this.flags[index] = 0;
		this.clusters.delete(index);
	}

	/** Make `x`'s cell independent again, clearing the other half of its glyph. */
	private clearWideAt(x: number, y: number): void {
		const index = this.indexAt(x, y);
		if (index < 0) return;
		const flags = this.flags[index];
		if (flags & CONTINUATION) {
			this.resetCell(index);
			if (x > 0) this.resetCell(index - 1);
		} else if (flags & WIDE) {
			this.resetCell(index);
			if (x + 1 < this.width) this.resetCell(index + 1);
		}
	}

	private resetCell(index: number): void {
		this.glyphs[index] = 0;
		this.styles[index] = 0;
		this.flags[index] = 0;
		this.clusters.delete(index);
	}
}

/**
 * The double buffer a screen paints into.
 *
 * `beginFrame()` empties the back buffer; the caller paints; `present()` returns
 * what changed since the front buffer was shown and swaps the two. After a
 * `resize()` the screen underneath is no longer what the front buffer describes,
 * so the caller must erase it before painting the frame the grid returns (see
 * `TerminalScreen.resize`, which does exactly that).
 */
export class CellGrid {
	readonly styles: StyleTable;
	private frontBuffer: CellBuffer;
	private backBuffer: CellBuffer;

	constructor(width: number, height: number, styles = new StyleTable()) {
		this.styles = styles;
		this.frontBuffer = new CellBuffer(width, height);
		this.backBuffer = new CellBuffer(width, height);
	}

	get width(): number {
		return this.backBuffer.width;
	}

	get height(): number {
		return this.backBuffer.height;
	}

	/** What the terminal is showing. */
	get front(): CellBuffer {
		return this.frontBuffer;
	}

	/** What the next frame is being painted into. */
	get back(): CellBuffer {
		return this.backBuffer;
	}

	/** Clear the back buffer so a full frame can be painted from scratch. */
	beginFrame(): void {
		this.backBuffer.clear();
	}

	/** The changed runs between the two buffers, after which the buffers swap. */
	present(): FrameOp[] {
		const ops = diffBuffers(this.frontBuffer, this.backBuffer);
		const previousFront = this.frontBuffer;
		this.frontBuffer = this.backBuffer;
		this.backBuffer = previousFront;
		return ops;
	}

	/** Reallocate at a new size, discarding both buffers' contents. */
	resize(width: number, height: number): void {
		if (width === this.width && height === this.height) return;
		this.frontBuffer = new CellBuffer(width, height);
		this.backBuffer = new CellBuffer(width, height);
	}

	/** Make the next `present()` a full repaint by pretending the screen is blank. */
	invalidate(): void {
		this.frontBuffer.clear();
	}
}
