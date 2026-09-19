/**
 * REPL-level logic is asserted through its pure helpers: the component itself
 * has no render tests, because a frame carries no ANSI when stdout is not a
 * TTY and the interesting behavior here is timing, not layout.
 */

import { describe, expect, test } from "bun:test";
import { sameShells } from "../src/app.tsx";
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

/**
 * The shell list is republished every couple of seconds forever, so "did
 * anything change" is the difference between a no-op and a full tree render.
 * Getting it wrong is invisible in tests that only ever look at one frame.
 */
describe("sameShells", () => {
	const shell = (id: string, status: "running" | "completed", command = "npm run dev") => ({ id, command, status });

	test("the same list, freshly built, counts as unchanged", () => {
		expect(sameShells([shell("shell_1", "running")], [shell("shell_1", "running")])).toBe(true);
		expect(sameShells([], [])).toBe(true);
	});

	test("nothing to say is not the same as something to say", () => {
		expect(sameShells([], [shell("shell_1", "running")])).toBe(false);
		expect(sameShells([shell("shell_1", "running")], [])).toBe(false);
	});

	test("a shell ending, or being restarted with another command, is a change", () => {
		expect(sameShells([shell("shell_1", "running")], [shell("shell_1", "completed")])).toBe(false);
		expect(sameShells([shell("shell_1", "running", "npm run dev")], [shell("shell_1", "running", "vite")])).toBe(false);
	});

	// Order matters: the row counts, but the picker behind it lists in this
	// order, so a reshuffle is a real difference and not just an alias.
	test("two shells listed the other way round are not the same list", () => {
		expect(
			sameShells(
				[shell("shell_1", "running"), shell("shell_2", "running")],
				[shell("shell_2", "running"), shell("shell_1", "running")],
			),
		).toBe(false);
	});
});
