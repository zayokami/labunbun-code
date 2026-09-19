/**
 * The `?` overlay's contents and the folding hint line.
 *
 * A shortcut list is a promise about what the program does, so the rows are
 * checked for the thing that makes them useful — that every one names a key and
 * says what it does, and that the list grows to describe vim mode when vim mode
 * is on. The hint is checked for the property that matters at a narrow width:
 * fewer columns, strictly less text, never a wrapped second line.
 */
import { describe, expect, test } from "bun:test";
import {
	escapeHint,
	HINT_SHORT_MIN_COLUMNS,
	hintLine,
	SHORTCUT_TWO_COLUMN_MIN_COLUMNS,
	shortcutGroups,
	splitShortcutGroups,
} from "../src/shortcuts.ts";

describe("hintLine", () => {
	test("drops clauses as the terminal narrows, never wrapping", () => {
		const wide = hintLine(120, { vim: false, vimMode: "insert" });
		const medium = hintLine(70, { vim: false, vimMode: "insert" });
		const narrow = hintLine(HINT_SHORT_MIN_COLUMNS - 20, { vim: false, vimMode: "insert" });
		expect(wide.length).toBeGreaterThan(medium.length);
		expect(medium.length).toBeGreaterThan(narrow.length);
		expect(narrow).toContain("Enter send");
		expect(narrow).toContain("/help");
	});

	test("always says what Escape is about to do", () => {
		expect(hintLine(120, { vim: true, vimMode: "normal" })).toContain("Esc interrupt");
		expect(hintLine(120, { vim: true, vimMode: "insert" })).toContain("Esc normal");
		expect(hintLine(120, { vim: true, vimMode: "visual" })).toContain("Esc cancel");
	});
});

describe("escapeHint", () => {
	test("follows the vim mode, and ignores it when vim is off", () => {
		expect(escapeHint(false, "normal")).toBe("Esc interrupt");
		expect(escapeHint(true, "insert")).toBe("Esc normal");
		expect(escapeHint(true, "visual")).toBe("Esc cancel");
		expect(escapeHint(true, "visual-line")).toBe("Esc cancel");
		expect(escapeHint(true, "normal")).toBe("Esc interrupt");
	});
});

describe("shortcutGroups", () => {
	test("every row names a key and what it does", () => {
		for (const vim of [false, true]) {
			for (const group of shortcutGroups({ vim, vimMode: "normal" })) {
				expect(group.title.length).toBeGreaterThan(0);
				expect(group.rows.length).toBeGreaterThan(0);
				for (const [keys, what] of group.rows) {
					expect(keys.trim().length).toBeGreaterThan(0);
					expect(what.trim().length).toBeGreaterThan(0);
				}
			}
		}
	});

	test("vim mode adds a group that admits Ctrl+R is redo there", () => {
		const plain = shortcutGroups({ vim: false });
		expect(plain.some((g) => g.title === "Vim")).toBe(false);
		const withVim = shortcutGroups({ vim: true, vimMode: "normal" });
		const vim = withVim.find((g) => g.title === "Vim");
		expect(vim?.rows.some(([keys]) => keys === "Ctrl+R")).toBe(true);
		const prompt = withVim.find((g) => g.title === "Prompt");
		expect(prompt?.rows.find(([keys]) => keys === "Ctrl+R")?.[1]).toContain("redo");
	});

	test("the command table is carried through verbatim", () => {
		const commands: Array<[string, string]> = [["/status", "Show status"]];
		const groups = shortcutGroups({ vim: false, commands });
		expect(groups.find((g) => g.title === "Commands")?.rows).toEqual(commands);
		expect(shortcutGroups({ vim: false, commands: [] }).some((g) => g.title === "Commands")).toBe(false);
	});

	// A key may legitimately appear twice in one group (with vim, Esc leaves
	// insert *and* cancels a selection), which is why the overlay keys a row by
	// the whole row rather than by the key name. That only works while the rows
	// themselves are distinct — a row repeated verbatim is invisible: React keeps
	// one and the reader is told a key does the same thing twice.
	test("no group repeats a row, so keying by the row stays unique", () => {
		const groups = shortcutGroups({
			vim: true,
			vimMode: "normal",
			commands: [
				["/help", "Show this help"],
				["/exit", "Exit"],
			],
		});
		for (const group of groups) {
			const rows = group.rows.map(([keys, what]) => `${keys} ${what}`);
			expect(new Set(rows).size).toBe(rows.length);
		}
	});
});

describe("splitShortcutGroups", () => {
	test("keeps every group whole and none of them loses a row", () => {
		const groups = shortcutGroups({
			vim: true,
			vimMode: "normal",
			commands: [
				["/help", "Show this help"],
				["/exit", "Exit"],
			],
		});
		const [left, right] = splitShortcutGroups(groups);
		expect([...left, ...right].map((g) => g.title)).toEqual(groups.map((g) => g.title));
		expect(left.length).toBeGreaterThan(0);
		expect(right.length).toBeGreaterThan(0);
		// Balanced by rows: a column twice the height of the other wastes the
		// width the two-column layout was for.
		const height = (column: typeof left) => column.reduce((sum, g) => sum + g.rows.length + 1, 0);
		expect(Math.abs(height(left) - height(right))).toBeLessThanOrEqual(2);
	});

	test("a single group lands in the first column, not spread across both", () => {
		const [left, right] = splitShortcutGroups(shortcutGroups({ vim: false }));
		expect(left).toHaveLength(1);
		expect(right).toHaveLength(0);
	});

	test("nothing to show splits into nothing, not into an empty pair", () => {
		const [left, right] = splitShortcutGroups([]);
		expect(left).toHaveLength(0);
		expect(right).toHaveLength(0);
	});

	test("the two-column threshold is where the narrower layout stops fitting", () => {
		// A guard on the constant rather than the layout: it has to leave room for
		// two key columns and their descriptions side by side.
		expect(SHORTCUT_TWO_COLUMN_MIN_COLUMNS).toBeGreaterThan(HINT_SHORT_MIN_COLUMNS);
	});
});
