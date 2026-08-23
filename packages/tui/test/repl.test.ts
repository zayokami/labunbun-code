/**
 * REPL-level logic is asserted through its pure helpers: the component itself
 * has no render tests, because a frame carries no ANSI when stdout is not a
 * TTY and the interesting behavior here is timing, not layout.
 */

import { describe, expect, test } from "bun:test";
import { CTRL_C_EXIT_WINDOW_MS, ctrlCShouldExit } from "../src/components/REPL.tsx";

describe("idle Ctrl+C double-press", () => {
	test("a single press never exits", () => {
		expect(ctrlCShouldExit(0, 1000)).toBe(false);
	});

	test("a second press inside the window exits", () => {
		expect(ctrlCShouldExit(1000, 1000 + CTRL_C_EXIT_WINDOW_MS - 1)).toBe(true);
		expect(ctrlCShouldExit(1000, 1000 + CTRL_C_EXIT_WINDOW_MS)).toBe(true);
	});

	test("once the window lapses a press starts counting again instead", () => {
		expect(ctrlCShouldExit(1000, 1000 + CTRL_C_EXIT_WINDOW_MS + 1)).toBe(false);
	});
});
