/**
 * The cell grid's promises, pinned without a terminal: cells hold what was
 * written, wide glyphs stay two cells wide, and the diff says only what
 * changed.
 */
import { describe, expect, test } from "bun:test";
import { CellBuffer, CellGrid } from "../src/render/cell-grid.ts";
import { StyleTable } from "../src/render/cell-style.ts";
import { chunkFrame, diffBuffers, encodeFrame } from "../src/render/frame.ts";
import { codePointWidth, displayWidth, graphemeWidth } from "../src/render/width.ts";

describe("width", () => {
	test("plain text, CJK and combining marks measure as a terminal draws them", () => {
		expect(displayWidth("")).toBe(0);
		expect(displayWidth("abc")).toBe(3);
		expect(displayWidth("漢字")).toBe(4);
		// One cluster, one cell: the mark composes onto the base.
		expect(displayWidth("é")).toBe(1);
		expect(displayWidth("👨‍👩‍👧")).toBe(2);
		expect(codePointWidth(0x7f)).toBe(0);
		expect(graphemeWidth("️")).toBe(0);
	});

	test("the emoji presentation selector promotes a one-cell base to two", () => {
		// U+2764 is text presentation by default; VS16 asks for the emoji glyph,
		// which terminals give two cells.
		expect(graphemeWidth("❤")).toBe(1);
		expect(graphemeWidth("❤️")).toBe(2);
	});

	test("emoji blocks outside the emoticon range are still two cells", () => {
		// A rocket (transport) and a melting face (symbols extended-A) sit in
		// blocks the original split-pane table did not list.
		expect(displayWidth("🚀")).toBe(2);
		expect(displayWidth("🫠")).toBe(2);
		expect(graphemeWidth("🇯🇵")).toBe(2);
	});
});

describe("CellBuffer", () => {
	test("writes text one cell per column and reports the columns it filled", () => {
		const buffer = new CellBuffer(4, 1);
		expect(buffer.writeText(0, 0, "AB")).toBe(2);
		expect(buffer.textAt(0, 0)).toBe("A");
		expect(buffer.textAt(1, 0)).toBe("B");
		expect(buffer.textAt(2, 0)).toBe(" ");
	});

	test("a wide glyph owns two cells, and the second draws nothing", () => {
		const buffer = new CellBuffer(4, 1);
		expect(buffer.writeText(0, 0, "漢")).toBe(2);
		expect(buffer.textAt(0, 0)).toBe("漢");
		expect(buffer.isContinuation(1, 0)).toBe(true);
		expect(buffer.textAt(1, 0)).toBe("");
		expect(buffer.writeText(2, 0, "X")).toBe(1);
		expect(buffer.textAt(2, 0)).toBe("X");
	});

	test("overwriting either half of a wide glyph clears the other half", () => {
		const buffer = new CellBuffer(4, 1);
		buffer.writeText(0, 0, "漢");
		buffer.writeText(0, 0, "a");
		expect(buffer.textAt(0, 0)).toBe("a");
		expect(buffer.textAt(1, 0)).toBe(" ");
		expect(buffer.isContinuation(1, 0)).toBe(false);

		buffer.writeText(0, 0, "漢");
		buffer.writeText(1, 0, "b");
		expect(buffer.textAt(0, 0)).toBe(" ");
		expect(buffer.textAt(1, 0)).toBe("b");
	});

	test("a wide glyph at the last column is written as a space instead of wrapping", () => {
		const buffer = new CellBuffer(3, 1);
		expect(buffer.writeText(2, 0, "漢")).toBe(1);
		expect(buffer.textAt(2, 0)).toBe(" ");
		// Nothing was written past the edge.
		expect(buffer.width).toBe(3);
	});

	test("clips at the column limit instead of running into the next line", () => {
		const buffer = new CellBuffer(6, 1);
		expect(buffer.writeText(0, 0, "abcdef", 0, 3)).toBe(3);
		expect(buffer.textAt(2, 0)).toBe("c");
		expect(buffer.textAt(3, 0)).toBe(" ");
	});

	test("a combining mark stays in its base's cell, not a cell of its own", () => {
		const buffer = new CellBuffer(3, 1);
		expect(buffer.writeText(0, 0, "é")).toBe(1);
		expect(buffer.textAt(0, 0)).toBe("é");
		expect(buffer.textAt(1, 0)).toBe(" ");
	});

	test("a ZWJ emoji sequence is one two-cell cluster, not one cell per member", () => {
		const buffer = new CellBuffer(4, 1);
		expect(buffer.writeText(0, 0, "👨‍👩‍👧")).toBe(2);
		expect(buffer.textAt(0, 0)).toBe("👨‍👩‍👧");
		expect(buffer.isContinuation(1, 0)).toBe(true);
	});

	test("control bytes never reach the cell as themselves", () => {
		const buffer = new CellBuffer(4, 1);
		expect(buffer.writeText(0, 0, "a\x1bb")).toBe(3);
		expect(buffer.textAt(0, 0)).toBe("a");
		expect(buffer.textAt(1, 0)).toBe(" ");
		expect(buffer.textAt(2, 0)).toBe("b");

		const single = new CellBuffer(2, 1);
		expect(single.setCell(0, 0, "\n")).toBe(1);
		expect(single.textAt(0, 0)).toBe(" ");
	});

	test("a space with the default style is a blank, and a styled one is not", () => {
		const buffer = new CellBuffer(2, 1);
		buffer.writeText(0, 0, " ");
		expect(buffer.glyphs[0]).toBe(0);
		buffer.writeText(0, 0, " ", 7);
		expect(buffer.glyphs[0]).toBe(0x20);
		expect(buffer.styleAt(0, 0)).toBe(7);
	});

	test("clear forgets glyphs, styles, flags and clusters", () => {
		const buffer = new CellBuffer(2, 1);
		buffer.writeText(0, 0, "😀", 3);
		buffer.clear();
		expect(buffer.textAt(0, 0)).toBe(" ");
		expect(buffer.styleAt(0, 0)).toBe(0);
		expect(buffer.isContinuation(1, 0)).toBe(false);
		buffer.writeText(0, 0, "a");
		expect(buffer.textAt(0, 0)).toBe("a");
	});

	test("refuses a size that is not a non-negative integer", () => {
		expect(() => new CellBuffer(-1, 1)).toThrow(RangeError);
		expect(() => new CellBuffer(1, 1.5)).toThrow(RangeError);
	});
});

describe("CellGrid", () => {
	test("a frame is the changed runs, and an identical frame is empty", () => {
		const grid = new CellGrid(4, 1);
		grid.beginFrame();
		grid.back.writeText(0, 0, "hi");
		expect(grid.present()).toEqual([{ row: 0, column: 0, text: "hi", styleId: 0 }]);

		grid.beginFrame();
		grid.back.writeText(0, 0, "hi");
		expect(grid.present()).toEqual([]);
	});

	test("only the changed cell is reported on the second frame", () => {
		const grid = new CellGrid(4, 1);
		grid.beginFrame();
		grid.back.writeText(0, 0, "abc");
		grid.present();

		grid.beginFrame();
		grid.back.writeText(0, 0, "aXc");
		expect(grid.present()).toEqual([{ row: 0, column: 1, text: "X", styleId: 0 }]);
	});

	test("a style change splits the run, because each run carries one style", () => {
		const grid = new CellGrid(4, 1);
		const bold = grid.styles.intern({ bold: true });
		grid.beginFrame();
		grid.back.writeText(0, 0, "A");
		grid.back.writeText(1, 0, "B", bold);
		const ops = grid.present();
		expect(ops).toHaveLength(2);
		expect(ops[0]).toMatchObject({ column: 0, text: "A", styleId: 0 });
		expect(ops[1]).toMatchObject({ column: 1, text: "B", styleId: bold });
	});

	test("a wide glyph is one run of two columns, not two runs", () => {
		const grid = new CellGrid(4, 1);
		grid.beginFrame();
		grid.back.writeText(0, 0, "漢");
		expect(grid.present()).toEqual([{ row: 0, column: 0, text: "漢", styleId: 0 }]);
	});

	test("a styled blank is repainted even though it holds no glyph", () => {
		const grid = new CellGrid(2, 1);
		const background = grid.styles.intern({ bg: [1, 2, 3] });
		grid.beginFrame();
		grid.back.writeText(0, 0, " ", background);
		expect(grid.present()).toEqual([{ row: 0, column: 0, text: " ", styleId: background }]);
	});

	test("the two buffers are reused, not reallocated, frame after frame", () => {
		const grid = new CellGrid(2, 1);
		const first = grid.back.glyphs;
		grid.beginFrame();
		grid.present();
		const second = grid.back.glyphs;
		expect(second).not.toBe(first);
		grid.beginFrame();
		grid.present();
		// The old back is next frame's scratch space: exactly two arrays, forever.
		expect(grid.back.glyphs).toBe(first);
	});

	test("resize reallocates and makes the next frame a full repaint", () => {
		const grid = new CellGrid(2, 1);
		grid.beginFrame();
		grid.back.writeText(0, 0, "A");
		grid.present();

		grid.resize(4, 2);
		expect(grid.width).toBe(4);
		expect(grid.height).toBe(2);
		grid.beginFrame();
		grid.back.writeText(0, 0, "A");
		expect(grid.present()).toEqual([{ row: 0, column: 0, text: "A", styleId: 0 }]);
	});

	test("invalidate forces a repaint of an unchanged frame", () => {
		const grid = new CellGrid(2, 1);
		grid.beginFrame();
		grid.back.writeText(0, 0, "A");
		grid.present();

		grid.invalidate();
		grid.beginFrame();
		grid.back.writeText(0, 0, "A");
		expect(grid.present()).toHaveLength(1);
	});

	test("diff of differently sized buffers writes nothing rather than guessing", () => {
		const front = new CellBuffer(2, 1);
		const back = new CellBuffer(3, 1);
		back.writeText(0, 0, "abc");
		expect(diffBuffers(front, back)).toEqual([]);
	});
});

describe("StyleTable", () => {
	test("one appearance is one id, and normalized colours share it", () => {
		const styles = new StyleTable();
		const bold = styles.intern({ bold: true });
		expect(styles.intern({ bold: true })).toBe(bold);
		expect(styles.intern({ fg: 300 })).toBe(styles.intern({ fg: 255 }));
		expect(styles.intern({ bg: [1.7, -5, 999] })).toBe(styles.intern({ bg: [1, 0, 255] }));
		expect(styles.size).toBe(4); // default, bold, fg, bg
	});

	test("attributes and colours are part of the identity", () => {
		const styles = new StyleTable();
		expect(styles.intern({ bold: true })).not.toBe(styles.intern({ dim: true }));
		expect(styles.intern({ fg: 1 })).not.toBe(styles.intern({ bg: 1 }));
	});

	test("an unknown id reads as the default style", () => {
		const styles = new StyleTable();
		expect(styles.style(999)).toEqual({});
		expect(styles.sgr(999)).toBe("\x1b[0m");
	});
});

describe("encodeFrame", () => {
	const styles = new StyleTable();

	test("an empty frame is no bytes at all", () => {
		expect(encodeFrame([], styles)).toBe("");
	});

	test("positions are zero-based in the grid and one-based in the escape", () => {
		const frame = encodeFrame([{ row: 1, column: 2, text: "A", styleId: 0 }], styles, { synchronized: false });
		expect(frame).toContain("\x1b[2;3H");
	});

	test("adjacent runs of one style share a cursor move and a string", () => {
		const frame = encodeFrame(
			[
				{ row: 0, column: 0, text: "A", styleId: 0 },
				{ row: 0, column: 1, text: "B", styleId: 0 },
			],
			styles,
			{ synchronized: false },
		);
		expect(frame).toContain("AB");
		expect(frame).not.toContain("\x1b[1;2H");
	});

	test("a style change emits its SGR and the frame ends back at the default", () => {
		const bold = styles.intern({ bold: true });
		const frame = encodeFrame(
			[
				{ row: 0, column: 0, text: "A", styleId: 0 },
				{ row: 0, column: 1, text: "B", styleId: bold },
			],
			styles,
			{ synchronized: false },
		);
		expect(frame).toContain("\x1b[0;1m");
		expect(frame.endsWith("\x1b[0m")).toBe(true);
	});

	test("colours encode as palette and truecolor parameters, clamped", () => {
		const indexed = styles.intern({ fg: 196 });
		const rgb = styles.intern({ bg: [1, 2, 3] });
		const clamped = styles.intern({ fg: 300, bg: [-5, 999, 1.7] });
		expect(styles.sgr(indexed)).toContain("38;5;196");
		expect(styles.sgr(rgb)).toContain("48;2;1;2;3");
		expect(styles.sgr(clamped)).toContain("38;5;255;48;2;0;255;1");
	});

	test("synchronized output wraps the frame unless it is turned off", () => {
		const op = [{ row: 0, column: 0, text: "A", styleId: 0 }];
		expect(encodeFrame(op, styles)).toStartWith("\x1b[?2026h");
		expect(encodeFrame(op, styles)).toEndWith("\x1b[?2026l");
		expect(encodeFrame(op, styles, { synchronized: false })).not.toContain("2026");
	});

	test("a clear frame erases the screen even with nothing to draw", () => {
		expect(encodeFrame([], styles, { clear: true, synchronized: false })).toBe("\x1b[H\x1b[2J");
	});

	test("the cursor is parked after a frame that drew something", () => {
		const frame = encodeFrame([{ row: 0, column: 0, text: "A", styleId: 0 }], styles, {
			synchronized: false,
			cursor: { row: 1, column: 2 },
		});
		expect(frame.endsWith("\x1b[2;3H")).toBe(true);
		// A cursor with no frame is not a reason to touch the terminal.
		expect(encodeFrame([], styles, { cursor: { row: 1, column: 2 } })).toBe("");
	});
});

describe("chunkFrame", () => {
	const styles = new StyleTable();

	test("a frame under the budget is one write and an empty one is none", () => {
		expect(chunkFrame("")).toEqual([]);
		expect(chunkFrame("\x1b[1;1Hhi")).toEqual(["\x1b[1;1Hhi"]);
	});

	test("splits between sequences and never inside one", () => {
		const frame = "\x1b[1;1HA\x1b[2;1HB";
		expect(chunkFrame(frame, 8)).toEqual(["\x1b[1;1HA", "\x1b[2;1HB"]);
	});

	test("a sequence longer than the budget rides alone rather than being cut", () => {
		expect(chunkFrame("\x1b[1;1H", 3)).toEqual(["\x1b[1;1H"]);
	});

	test("never separates a surrogate pair", () => {
		expect(chunkFrame("😀😀", 2)).toEqual(["😀", "😀"]);
	});

	test("every chunk stays under the budget and the pieces reassemble the frame", () => {
		const frame = encodeFrame(
			[
				{ row: 0, column: 0, text: "AB", styleId: 0 },
				{ row: 1, column: 3, text: "漢", styleId: 0 },
			],
			styles,
			{ synchronized: false },
		);
		const chunks = chunkFrame(frame, 7);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join("")).toBe(frame);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(7);
	});
});
