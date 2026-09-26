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
		const wide = hintLine(120, { editor: "none", vimMode: "insert" });
		const medium = hintLine(70, { editor: "none", vimMode: "insert" });
		const narrow = hintLine(HINT_SHORT_MIN_COLUMNS - 20, { editor: "none", vimMode: "insert" });
		expect(wide.length).toBeGreaterThan(medium.length);
		expect(medium.length).toBeGreaterThan(narrow.length);
		expect(narrow).toContain("Enter send");
		expect(narrow).toContain("/help");
	});

	test("always says what Escape is about to do", () => {
		expect(hintLine(120, { editor: "vim", vimMode: "normal" })).toContain("Esc interrupt");
		expect(hintLine(120, { editor: "vim", vimMode: "insert" })).toContain("Esc normal");
		expect(hintLine(120, { editor: "vim", vimMode: "visual" })).toContain("Esc cancel");
	});
});

describe("escapeHint", () => {
	test("follows the vim mode, and ignores it when vim is off", () => {
		expect(escapeHint("none", "normal")).toBe("Esc interrupt");
		expect(escapeHint("vim", "insert")).toBe("Esc normal");
		expect(escapeHint("vim", "visual")).toBe("Esc cancel");
		expect(escapeHint("vim", "visual-line")).toBe("Esc cancel");
		expect(escapeHint("vim", "normal")).toBe("Esc interrupt");
	});

	// The case that looks like it needs its own answer and does not. `EmacsEngine`
	// declines a lone Escape — there is no mode to leave — so the key reaches the
	// REPL's interrupt exactly as it does with no editor at all. Pinned across
	// every mode value so a future "the vim mode is stale under emacs" shortcut
	// cannot leak in through this branch.
	test("is the interrupt under emacs, whatever the stale vim mode says", () => {
		for (const mode of ["normal", "insert", "visual", "visual-line"] as const) {
			expect(escapeHint("emacs", mode)).toBe("Esc interrupt");
		}
	});
});

describe("shortcutGroups", () => {
	test("every row names a key and what it does", () => {
		// All three kinds, not the two that existed when this was written: an editor
		// whose group nobody checked is exactly the group that ships a blank cell.
		for (const editor of ["none", "vim", "emacs"] as const) {
			for (const group of shortcutGroups({ editor, vimMode: "normal" })) {
				expect(group.title.length).toBeGreaterThan(0);
				expect(group.rows.length).toBeGreaterThan(0);
				for (const [keys, what] of group.rows) {
					expect(keys.trim().length).toBeGreaterThan(0);
					expect(what.trim().length).toBeGreaterThan(0);
				}
			}
		}
	});

	// Each editor's group describes that editor. A vim group shown to an emacs
	// user would not be a formatting slip: `i a insert` and `Esc leave insert`
	// are instructions for a mode they are not in, and the file's own header says
	// a list that lies is worse than no list.
	//
	// Emacs gained its own group with the engine, so the third row changed: it used to
	// assert that emacs had **no** editor group, which was true only while there was an
	// engine with no host-visible key list. The assertion it makes now is the stronger
	// one — emacs has a group, and it is not vim's.
	test("shows the group for the editor that is up, and no other", () => {
		const titles = (editor: "none" | "vim" | "emacs") =>
			shortcutGroups({ editor, vimMode: "normal" }).map((group) => group.title);
		expect(titles("none")).toEqual(["Prompt"]);
		expect(titles("vim")).toEqual(["Prompt", "Vim"]);
		expect(titles("emacs")).toEqual(["Prompt", "Emacs"]);
	});

	test("the emacs group names keys the engine runs, and the Prompt row admits C-r is eaten", () => {
		const groups = shortcutGroups({ editor: "emacs", vimMode: "normal" });
		const emacs = groups.find((g) => g.title === "Emacs");
		const keys = emacs?.rows.map(([k]) => k) ?? [];
		// The engine's implemented surface, spot-checked at both ends.
		expect(keys).toContain("C-k");
		expect(keys).toContain("C-y / M-y");
		expect(keys).toContain("C-S-BS");
		// Bound-but-unimplemented keys are claimed and consumed, so advertising them as
		// working would be a lie in a new place. They must not appear.
		expect(keys).not.toContain("C-t");
		expect(keys).not.toContain("M-u");
		expect(keys).not.toContain("M-z");
		expect(keys).not.toContain("C-s");
		// And the Prompt row cannot still promise history search: `EmacsEngine` claims
		// `C-r` as reserved isearch, so the host never sees it. The other two editors keep
		// the wording they had.
		const ctrlR = (editor: "none" | "vim" | "emacs") =>
			shortcutGroups({ editor, vimMode: "normal" })
				.find((g) => g.title === "Prompt")
				?.rows.find(([k]) => k === "Ctrl+R")?.[1];
		expect(ctrlR("emacs")).toContain("taken");
		expect(ctrlR("vim")).toContain("redo");
		expect(ctrlR("none")).toBe("search history");
	});

	test("vim mode adds a group that admits Ctrl+R is redo there", () => {
		const plain = shortcutGroups({ editor: "none" });
		expect(plain.some((g) => g.title === "Vim")).toBe(false);
		const withVim = shortcutGroups({ editor: "vim", vimMode: "normal" });
		const vim = withVim.find((g) => g.title === "Vim");
		expect(vim?.rows.some(([keys]) => keys === "Ctrl+R")).toBe(true);
		const prompt = withVim.find((g) => g.title === "Prompt");
		expect(prompt?.rows.find(([keys]) => keys === "Ctrl+R")?.[1]).toContain("redo");
	});

	test("the command table is carried through verbatim", () => {
		const commands: Array<[string, string]> = [["/status", "Show status"]];
		const groups = shortcutGroups({ editor: "none", commands });
		expect(groups.find((g) => g.title === "Commands")?.rows).toEqual(commands);
		expect(shortcutGroups({ editor: "none", commands: [] }).some((g) => g.title === "Commands")).toBe(false);
	});

	// A key may legitimately appear twice in one group (with vim, Esc leaves
	// insert *and* cancels a selection), which is why the overlay keys a row by
	// the whole row rather than by the key name. That only works while the rows
	// themselves are distinct — a row repeated verbatim is invisible: React keeps
	// one and the reader is told a key does the same thing twice.
	test("no group repeats a row, so keying by the row stays unique", () => {
		const groups = shortcutGroups({
			editor: "vim",
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
			editor: "vim",
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
		const [left, right] = splitShortcutGroups(shortcutGroups({ editor: "none" }));
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
