import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React, { act } from "react";
import { miniDiff } from "../../tools/src/edit.ts";
import { useTextInput } from "../src/hooks/useTextInput.ts";

// React 19 requires this flag for act() outside react-dom/test-utils.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("miniDiff", () => {
	test("produces a unified-style hunk with context", () => {
		const content = "line 1\nline 2\nold value\nline 4\nline 5\nline 6";
		const diff = miniDiff(content, "old value", "new value");
		const lines = diff.split("\n");
		expect(lines[0]).toMatch(/^@@ -3,1 \+3,1 @@$/);
		expect(lines).toContain("- old value");
		expect(lines).toContain("+ new value");
		expect(lines.filter((l) => l.startsWith("  "))).toHaveLength(4); // 2 before + 2 after
	});

	test("multi-line replacement spans several removed/added lines", () => {
		const content = "a\nb\nc1\nc2\nd";
		const diff = miniDiff(content, "c1\nc2", "C1\nC2\nC3");
		expect(diff).toContain("- c1");
		expect(diff).toContain("- c2");
		expect(diff).toContain("+ C1");
		expect(diff).toContain("+ C3");
	});

	test("returns empty string when target missing", () => {
		expect(miniDiff("abc", "nope", "x")).toBe("");
	});
});

type Hook = ReturnType<typeof useTextInput>;

function setup(vim: boolean) {
	const hook = {} as Hook;
	function Harness() {
		Object.assign(hook, useTextInput([], vim));
		return null;
	}
	render(React.createElement(Harness));
	/** Run a vim key press inside act() so state updates flush to the hook. */
	function press(input: string, key: Partial<Parameters<Hook["handleVimKey"]>[1]> = {}) {
		const fullKey = {
			upArrow: false,
			downArrow: false,
			leftArrow: false,
			rightArrow: false,
			pageDown: false,
			pageUp: false,
			return: false,
			escape: false,
			ctrl: false,
			shift: false,
			tab: false,
			backspace: false,
			delete: false,
			meta: false,
			...key,
		};
		act(() => {
			hook.handleVimKey(input, fullKey as Parameters<Hook["handleVimKey"]>[1]);
		});
	}
	function run(fn: () => void) {
		act(fn);
	}
	return { hook, press, run };
}

describe("vim layer in useTextInput", () => {
	test("starts in normal mode when vim is on; i/a switch to insert", () => {
		const { hook, press } = setup(true);
		expect(hook.vimMode).toBe("normal");
		press("i");
		expect(hook.vimMode).toBe("insert");
		press("\x1b", { escape: true });
		expect(hook.vimMode).toBe("normal");
	});

	test("normal-mode motions and edits", () => {
		const { hook, press, run } = setup(true);
		run(() => hook.actions.setText("hello"));
		run(() => hook.actions.moveToLineStart());

		press("l"); // cursor → 1
		press("x"); // delete 'e' → "hllo"
		expect(hook.state.text).toBe("hllo");
		expect(hook.state.cursor).toBe(1);

		press("D"); // kill to end from cursor 1 → drops "llo"
		expect(hook.state.text).toBe("h");
	});

	test("a enters insert after the cursor; typed keys fall through", () => {
		const { hook, press, run } = setup(true);
		run(() => hook.actions.setText("ab"));
		run(() => hook.actions.moveToLineStart());
		press("a");
		expect(hook.vimMode).toBe("insert");
		expect(hook.state.cursor).toBe(1);
		// insert mode passes non-escape keys through (returns false)
		const fullKey = {
			upArrow: false,
			downArrow: false,
			leftArrow: false,
			rightArrow: false,
			pageDown: false,
			pageUp: false,
			return: false,
			escape: false,
			ctrl: false,
			shift: false,
			tab: false,
			backspace: false,
			delete: false,
			meta: false,
		};
		expect(hook.handleVimKey("z", fullKey as Parameters<Hook["handleVimKey"]>[1])).toBe(false);
	});

	test("without vim everything falls through", () => {
		const { hook } = setup(false);
		expect(hook.vimMode).toBe("insert");
		const fullKey = {
			upArrow: false,
			downArrow: false,
			leftArrow: false,
			rightArrow: false,
			pageDown: false,
			pageUp: false,
			return: false,
			escape: false,
			ctrl: false,
			shift: false,
			tab: false,
			backspace: false,
			delete: false,
			meta: false,
		};
		expect(hook.handleVimKey("h", fullKey as Parameters<Hook["handleVimKey"]>[1])).toBe(false);
	});
});
