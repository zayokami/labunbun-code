/**
 * The screen's lifecycle: one frame per paint, nothing when nothing changed,
 * a full erase on resize, and the terminal handed back exactly as it was found.
 */
import { describe, expect, test } from "bun:test";
import type { CellBuffer } from "../src/render/cell-grid.ts";
import { TerminalScreen } from "../src/render/terminal-screen.ts";

function fakeStream() {
	const writes: string[] = [];
	return {
		writes,
		write(data: string) {
			writes.push(data);
			return true;
		},
	};
}

const drawText = (text: string) => (back: CellBuffer) => back.writeText(0, 0, text);

describe("TerminalScreen", () => {
	test("hides the cursor, then writes a frame per changed paint", () => {
		const stream = fakeStream();
		const screen = new TerminalScreen({ stream, columns: 10, rows: 2 });
		expect(stream.writes).toEqual(["\x1b[?25l"]);

		expect(screen.paint(drawText("hi"))).toBe(true);
		expect(stream.writes).toHaveLength(2);
		expect(stream.writes[1]).toContain("hi");
		// The first frame owns the display: whatever was there is erased.
		expect(stream.writes[1]).toContain("\x1b[H\x1b[2J");
		screen.dispose();
	});

	test("the first paint erases the screen even when it draws nothing", () => {
		const stream = fakeStream();
		const screen = new TerminalScreen({ stream, columns: 4, rows: 1, synchronizedOutput: false });
		expect(screen.paint(() => {})).toBe(true);
		expect(stream.writes.at(-1)).toBe("\x1b[H\x1b[2J");
		screen.dispose();
	});

	test("an identical paint writes nothing at all", () => {
		const stream = fakeStream();
		const screen = new TerminalScreen({ stream, columns: 10, rows: 2 });
		screen.paint(drawText("hi"));
		const written = stream.writes.length;

		expect(screen.paint(drawText("hi"))).toBe(false);
		expect(stream.writes).toHaveLength(written);
		screen.dispose();
	});

	test("a changed cell costs a change-sized frame, not a full repaint", () => {
		const stream = fakeStream();
		const screen = new TerminalScreen({ stream, columns: 10, rows: 2, synchronizedOutput: false });
		screen.paint(drawText("abc"));
		screen.paint(drawText("aXc"));
		const last = stream.writes.at(-1) ?? "";
		expect(last).toContain("X");
		expect(last).not.toContain("abc");
		screen.dispose();
	});

	test("resize erases the screen before the next frame, even an empty one", () => {
		const stream = fakeStream();
		const screen = new TerminalScreen({ stream, columns: 4, rows: 1, synchronizedOutput: false });
		screen.paint(drawText("A"));

		expect(screen.resize(8, 3)).toBe(true);
		expect(screen.resize(8, 3)).toBe(false); // the same size is not a resize
		expect(stream.writes.at(-1)).toContain("A"); // nothing written until the next paint

		expect(screen.paint(() => {})).toBe(true);
		const last = stream.writes.at(-1) ?? "";
		expect(last).toStartWith("\x1b[H\x1b[2J");
		// The grid itself is blank at the new size, so the whole old picture is gone.
		expect(last).not.toContain("A");
		screen.dispose();
	});

	test("the cursor is parked where the caller asked after a drawn frame", () => {
		const stream = fakeStream();
		const screen = new TerminalScreen({ stream, columns: 10, rows: 3, synchronizedOutput: false });
		screen.paint(drawText("A"), { row: 2, column: 4 });
		expect(stream.writes.at(-1)?.endsWith("\x1b[3;5H")).toBe(true);
		screen.dispose();
	});

	test("dispose restores the default style and the cursor exactly once", () => {
		const stream = fakeStream();
		const screen = new TerminalScreen({ stream, columns: 10, rows: 2 });
		screen.dispose();
		expect(stream.writes.slice(1)).toEqual(["\x1b[0m", "\x1b[?25h"]);

		const written = stream.writes.length;
		screen.dispose();
		expect(stream.writes).toHaveLength(written);
		expect(screen.paint(drawText("A"))).toBe(false);
	});

	test("a screen that does not hide the cursor leaves it alone", () => {
		const stream = fakeStream();
		const screen = new TerminalScreen({ stream, columns: 10, rows: 2, hideCursor: false });
		expect(stream.writes).toEqual([]);
		screen.dispose();
		expect(stream.writes).toEqual(["\x1b[0m"]);
	});

	test("synchronized output can be turned off for a terminal that lacks it", () => {
		const stream = fakeStream();
		const screen = new TerminalScreen({ stream, columns: 10, rows: 2, synchronizedOutput: false });
		screen.paint(drawText("A"));
		expect(stream.writes.at(-1)).not.toContain("2026");
		screen.dispose();
	});
});
