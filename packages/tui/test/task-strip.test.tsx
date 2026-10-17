/**
 * The task strip: the header's count, the status glyphs, the active callout,
 * the four-row window, and the owner tag.
 *
 * Ink draws no colour when stdout is not a TTY, which is every test run, so the
 * colours stay out of these assertions — what a reader sees is the text.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { ICONS, TaskStrip } from "../src/components/TaskStrip.tsx";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import type { UiTask } from "../src/ui-state.ts";

const task = (over: Partial<UiTask> & { id: string }): UiTask => ({
	subject: `subject ${over.id}`,
	status: "pending",
	...over,
});

/** Render a strip under the dark theme and expose its frame as one line. */
function strip(tasks: UiTask[]) {
	const view = render(
		(
			<ThemeContext.Provider value={DARK_THEME}>
				<TaskStrip tasks={tasks} />
			</ThemeContext.Provider>
		) as React.ReactElement,
	);
	return {
		/** The frame with runs of layout whitespace folded into one space. */
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " ").trim(),
		unmount: view.unmount,
	};
}

describe("the task strip", () => {
	test("an empty list draws nothing at all", () => {
		const s = strip([]);
		expect(s.frame()).toBe("");
		s.unmount();
	});

	test("the three statuses wear the box, the half box and the check", () => {
		expect(ICONS).toEqual({ pending: "☐", in_progress: "◐", completed: "☑" });
	});

	test("the header counts every task and the rows draw the unfinished ones", () => {
		const s = strip([
			task({ id: "1", status: "completed", subject: "Wire the board" }),
			task({ id: "2", status: "in_progress", subject: "Fix parser" }),
			task({ id: "3", status: "pending", subject: "Write tests" }),
		]);
		const frame = s.frame();
		expect(frame).toContain("Tasks 1/3");
		expect(frame).toContain("◐ #2 Fix parser");
		expect(frame).toContain("☐ #3 Write tests");
		// Completed rows leave the strip; the header is where their count lives.
		expect(frame).not.toContain("☑");
		expect(frame).not.toContain("Wire the board");
		s.unmount();
	});

	test("the active task speaks its active form", () => {
		const s = strip([task({ id: "2", status: "in_progress", subject: "Fix parser", activeForm: "Fixing the parser" })]);
		expect(s.frame()).toContain("▸ Fixing the parser");
		s.unmount();
	});

	test("an owner rides the visible row, and a task without one gains no separator", () => {
		const owned = strip([task({ id: "3", status: "in_progress", subject: "Fix parser", owner: "alice" })]);
		expect(owned.frame()).toContain("#3 Fix parser · alice");
		owned.unmount();

		const bare = strip([task({ id: "3", subject: "Fix parser" })]);
		expect(bare.frame()).toContain("#3 Fix parser");
		expect(bare.frame()).not.toContain("·");
		bare.unmount();

		// An empty owner is no owner: it must not leave a dangling separator.
		const empty = strip([task({ id: "3", subject: "Fix parser", owner: "" })]);
		expect(empty.frame()).toContain("#3 Fix parser");
		expect(empty.frame()).not.toContain("·");
		empty.unmount();
	});

	test("five unfinished tasks show the first four and no more", () => {
		const s = strip(Array.from({ length: 5 }, (_, i) => task({ id: String(i + 1), subject: `subject ${i + 1}` })));
		const frame = s.frame();
		for (const n of [1, 2, 3, 4]) expect(frame).toContain(`☐ #${n} subject ${n}`);
		expect(frame).not.toContain("#5");
		expect(frame).toContain("Tasks 0/5");
		s.unmount();
	});

	test("an all-done list says so in the header", () => {
		const one = strip([task({ id: "1", status: "completed", subject: "Ship it" })]);
		expect(one.frame()).toContain("Tasks 1/1");
		expect(one.frame()).not.toContain("Ship it");
		one.unmount();

		const all = strip([task({ id: "1", status: "completed" }), task({ id: "2", status: "completed" })]);
		expect(all.frame()).toContain("Tasks 2/2");
		all.unmount();
	});
});
