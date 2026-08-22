/**
 * VimEngine tests — pure state machine, no React/ink involved.
 * Each editor is an in-memory string+cursor pair driven through handleKey.
 */
import { describe, expect, test } from "bun:test";
import {
	lineCount,
	lineOf,
	lineStart,
	motionBackWord,
	motionForwardWord,
	motionWordEnd,
	VimEngine,
	type VimKey,
} from "../src/vim.ts";

function editor(text: string, cursor = 0) {
	const recalled: Array<"up" | "down"> = [];
	const undoBuf: Array<{ text: string; cursor: number }> = [];
	let redoBuf: Array<{ text: string; cursor: number }> = [];
	const state = { text, cursor };

	const engine = new VimEngine({
		getText: () => state.text,
		getCursor: () => state.cursor,
		setCursor: (p) => {
			state.cursor = Math.max(0, Math.min(p, state.text.length));
		},
		setAll: (t, c) => {
			undoBuf.push({ text: state.text, cursor: state.cursor });
			redoBuf = [];
			state.text = t;
			state.cursor = Math.max(0, Math.min(c, t.length));
		},
		enterInsert: () => {},
		toNormal: () => {},
		recallHistory: (d) => recalled.push(d),
		undo: () => {
			const prev = undoBuf.pop();
			if (prev) {
				redoBuf.push({ text: state.text, cursor: state.cursor });
				state.text = prev.text;
				state.cursor = prev.cursor;
			}
		},
		redo: () => {
			const next = redoBuf.pop();
			if (next) {
				undoBuf.push({ text: state.text, cursor: state.cursor });
				state.text = next.text;
				state.cursor = next.cursor;
			}
		},
	});

	const key = (overrides: Partial<VimKey> = {}): VimKey => ({ ...overrides });
	/**
	 * Type a sequence of plain characters as insert-mode host typing: each
	 * keystroke is applied AND undo-recorded, mirroring the real host's
	 * per-keystroke `commitWithUndo` (see useTextInput.ts `insert`).
	 */
	const type = (s: string) => {
		for (const ch of s) {
			expect(engine.handleKey(ch, key())).toBe(false);
			undoBuf.push({ text: state.text, cursor: state.cursor });
			redoBuf = [];
			state.text = state.text.slice(0, state.cursor) + ch + state.text.slice(state.cursor);
			state.cursor += 1;
		}
	};

	return { engine, state, recalled, key, type };
}

describe("pure motion helpers", () => {
	test("word motions over words/punctuation/blanks", () => {
		const text = "foo bar-baz  qux\nnext";
		expect(motionForwardWord(text, 0)).toBe(4); // foo → bar
		expect(motionForwardWord(text, 4)).toBe(7); // bar → '-' (punct is its own word)
		expect(motionForwardWord(text, 5)).toBe(7); // from mid-word
		expect(motionBackWord(text, 8)).toBe(7); // baz → '-'
		expect(motionWordEnd(text, 0)).toBe(2); // fo|o
		expect(motionBackWord(text, 0)).toBe(0); // clamp
	});
});

describe("normal mode basics", () => {
	test("starts in normal mode; i/a/A/I/o/O enter insert; Esc returns", () => {
		const e = editor("hello");
		expect(e.engine.mode).toBe("normal");
		e.engine.handleKey("i", e.key());
		expect(e.engine.mode).toBe("insert");
		e.engine.handleKey("", e.key({ escape: true }));
		expect(e.engine.mode).toBe("normal");

		e.engine.handleKey("a", e.key());
		expect(e.engine.mode).toBe("insert");
		expect(e.state.cursor).toBe(1);
		e.engine.handleKey("", e.key({ escape: true }));

		e.engine.handleKey("A", e.key());
		expect(e.state.cursor).toBe(5);
		e.engine.handleKey("", e.key({ escape: true }));

		e.engine.handleKey("I", e.key());
		expect(e.state.cursor).toBe(0);
	});

	test("h/l/0/^/$ move within bounds", () => {
		const e = editor("abc def", 4);
		e.engine.handleKey("h", e.key());
		expect(e.state.cursor).toBe(3);
		e.engine.handleKey("l", e.key());
		e.engine.handleKey("l", e.key());
		expect(e.state.cursor).toBe(5);
		e.engine.handleKey("0", e.key());
		expect(e.state.cursor).toBe(0);
		e.engine.handleKey("$", e.key());
		expect(e.state.cursor).toBe(6);
	});

	test("w/b/e with counts; clamps at buffer edges", () => {
		const e = editor("one two three four", 0);
		e.engine.handleKey("w", e.key());
		expect(e.state.cursor).toBe(4);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.cursor).toBe(14); // two → three → four

		const tail = editor("end", 0);
		tail.engine.handleKey("5", tail.key());
		tail.engine.handleKey("w", tail.key());
		expect(tail.state.cursor).toBeLessThanOrEqual(3);
	});

	test("j/k on single-line buffer recall history; multiline moves lines", () => {
		const single = editor("plain");
		single.engine.handleKey("k", single.key());
		expect(single.recalled).toEqual(["up"]);

		const multi = editor("alpha\nbeta\ngamma", 1);
		multi.engine.handleKey("j", multi.key());
		expect(multi.state.cursor).toBe(7); // same column on "beta" (b=6, col 1 → e=7)
		multi.engine.handleKey("k", multi.key());
		expect(multi.state.cursor).toBe(1);
	});

	test("f/F/t/T are line-scoped; ; repeats , flips", () => {
		const e = editor("a:b:c\nd:e", 0);
		e.engine.handleKey("f", e.key());
		e.engine.handleKey(":", e.key());
		expect(e.state.cursor).toBe(1);
		e.engine.handleKey(";", e.key());
		expect(e.state.cursor).toBe(3);
		e.engine.handleKey(",", e.key());
		expect(e.state.cursor).toBe(1);

		// t stops one short.
		const t = editor("xyz:q", 0);
		t.engine.handleKey("t", t.key());
		t.engine.handleKey(":", t.key());
		expect(t.state.cursor).toBe(2);

		// F searches backwards on the current line only.
		const back = editor("a:b:c\nd:e", 8); // 'e' on line 2
		back.engine.handleKey("F", back.key());
		back.engine.handleKey(":", back.key());
		expect(back.state.cursor).toBe(7);
	});

	test("gg and G jump to start/end; {n}G targets a line", () => {
		const e = editor("aa\nbb\ncc", 3);
		e.engine.handleKey("G", e.key());
		expect(e.state.cursor).toBe(8);
		e.engine.handleKey("g", e.key());
		e.engine.handleKey("g", e.key());
		expect(e.state.cursor).toBe(0);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("G", e.key());
		expect(e.state.cursor).toBe(3);
	});
});

describe("operators and edits", () => {
	test("dw deletes to word start; cw keeps trailing space (ce quirk)", () => {
		const a = editor("foo bar", 0);
		a.engine.handleKey("d", a.key());
		a.engine.handleKey("w", a.key());
		expect(a.state.text).toBe("bar");

		const b = editor("foo bar", 0);
		b.engine.handleKey("c", b.key());
		b.engine.handleKey("w", b.key());
		expect(b.engine.mode).toBe("insert");
		expect(b.state.text).toBe(" bar"); // "foo" removed, space kept
	});

	test("dd deletes the whole line; u undoes it", () => {
		const e = editor("one\ntwo\nthree", 4);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("one\nthree");
		e.engine.handleKey("u", e.key());
		expect(e.state.text).toBe("one\ntwo\nthree");
	});

	test("yy + p pastes linewise below; P above", () => {
		const e = editor("one\ntwo", 4); // cursor on "two"
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("p", e.key());
		expect(e.state.text).toBe("one\ntwo\ntwo");

		const up = editor("one\ntwo", 4);
		up.engine.handleKey("y", up.key());
		up.engine.handleKey("y", up.key());
		up.engine.handleKey("P", up.key());
		expect(up.state.text).toBe("one\ntwo\ntwo");
	});

	test("charwise yank + p inserts after the cursor", () => {
		const e = editor("abcd efgh", 0);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("e", e.key()); // yank "abcd"
		expect(e.state.cursor).toBe(0);
		e.engine.handleKey("$", e.key());
		e.engine.handleKey("p", e.key());
		expect(e.state.text).toBe("abcd efghabcd");
	});

	test("D / C operate from the cursor to end of line", () => {
		const d = editor("keep cut-me", 4);
		d.engine.handleKey("D", d.key());
		expect(d.state.text).toBe("keep");

		const c = editor("keep cut-me", 4);
		c.engine.handleKey("C", c.key());
		expect(c.state.text).toBe("keep");
		expect(c.engine.mode).toBe("insert");
	});

	test("cc clears the line keeping a blank line; S same", () => {
		const e = editor("aa\nbb\ncc", 4);
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("c", e.key());
		expect(e.state.text).toBe("aa\n\ncc");
		expect(e.engine.mode).toBe("insert");
	});

	test("x deletes chars forward; X backward", () => {
		const e = editor("abc", 1);
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("ac");
		e.engine.handleKey("X", e.key());
		expect(e.state.text).toBe("c");
	});

	test("r replaces exactly one char", () => {
		const e = editor("abc", 0);
		e.engine.handleKey("r", e.key());
		e.engine.handleKey("X", e.key());
		expect(e.state.text).toBe("Xbc");
	});

	test("~ toggles case and advances (a→A, B→b)", () => {
		const e = editor("aBc", 0);
		e.engine.handleKey("~", e.key());
		e.engine.handleKey("~", e.key());
		expect(e.state.text).toBe("Abc");
	});

	test("J joins lines at the join point", () => {
		const e = editor("foo\n  bar\nbaz", 1);
		e.engine.handleKey("J", e.key());
		expect(e.state.text).toBe("foo bar\nbaz");
	});

	test("counts multiply across operator and motion (2d3w = 6 words)", () => {
		const e = editor("a b c d e f g h tail", 0);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("3", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("g h tail");
	});

	test("df{c} includes the target; dt{c} does not", () => {
		const incl = editor("a=b=c", 0);
		incl.engine.handleKey("d", incl.key());
		incl.engine.handleKey("f", incl.key());
		incl.engine.handleKey("=", incl.key());
		expect(incl.state.text).toBe("b=c"); // deletes "a="

		const till = editor("a=b=c", 0);
		till.engine.handleKey("d", till.key());
		till.engine.handleKey("t", till.key());
		till.engine.handleKey("=", till.key());
		expect(till.state.text).toBe("=b=c"); // deletes "a" only
	});

	test("dj deletes two whole lines linewise", () => {
		const e = editor("l1\nl2\nl3\nl4", 2);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("j", e.key());
		expect(e.state.text).toBe("l3\nl4");
	});

	test("o opens below; O opens above; both enter insert", () => {
		const e = editor("ab\ncd", 0);
		e.engine.handleKey("o", e.key());
		expect(e.state.text).toBe("ab\n\ncd");
		expect(e.engine.mode).toBe("insert");
		expect(e.state.cursor).toBe(3);
		e.engine.handleKey("", e.key({ escape: true }));
		e.engine.handleKey("O", e.key());
		// Cursor sits on the blank line "o" just opened, so "O" opens another
		// blank line above THAT one — not above the buffer start.
		expect(e.state.text).toBe("ab\n\n\ncd");
		expect(e.state.cursor).toBe(3);
	});

	test("undo/redo round-trip via ctrl+r", () => {
		const e = editor("abc", 3);
		e.engine.handleKey("a", e.key()); // append → insert mode
		e.type("def");
		expect(e.state.text).toBe("abcdef");
		e.engine.handleKey("", e.key({ escape: true }));
		// The host records one undo step per keystroke (commitWithUndo fires
		// per insert), so undoing a 3-char insert takes 3 separate `u` presses.
		e.engine.handleKey("u", e.key());
		e.engine.handleKey("u", e.key());
		e.engine.handleKey("u", e.key());
		expect(e.state.text).toBe("abc");
		e.engine.handleKey("r", e.key({ ctrl: true }));
		e.engine.handleKey("r", e.key({ ctrl: true }));
		e.engine.handleKey("r", e.key({ ctrl: true }));
		expect(e.state.text).toBe("abcdef");
	});
});

describe("visual mode", () => {
	test("v extends charwise selection; x deletes it", () => {
		const e = editor("hello world", 0);
		e.engine.handleKey("v", e.key());
		expect(e.engine.mode).toBe("visual");
		expect(e.engine.selection).toEqual({ start: 0, end: 1 });
		for (const _ of [1, 2, 3, 4]) e.engine.handleKey("l", e.key());
		expect(e.engine.selection).toEqual({ start: 0, end: 5 });
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe(" world");
		expect(e.engine.mode).toBe("normal");
	});

	test("V selects whole lines; y yanks them linewise; p pastes below", () => {
		const e = editor("aaa\nbbb\nccc", 4); // cursor on "bbb"
		e.engine.handleKey("V", e.key());
		expect(e.engine.mode).toBe("visual-line");
		expect(e.engine.selection).toEqual({ start: 4, end: 8 }); // "bbb\n"
		e.engine.handleKey("j", e.key());
		expect(e.engine.selection).toEqual({ start: 4, end: 11 }); // bbb\nccc (no trailing \n to include)
		e.engine.handleKey("y", e.key());
		expect(e.engine.mode).toBe("normal");
		e.engine.handleKey("p", e.key());
		expect(e.state.text).toBe("aaa\nbbb\nbbb\nccc\nccc");
	});

	test("c changes the selection to insert mode; o swaps ends", () => {
		const e = editor("hello world", 6);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("e", e.key());
		e.engine.handleKey("o", e.key());
		expect(e.state.cursor).toBe(6);
		e.engine.handleKey("o", e.key());
		expect(e.state.cursor).toBe(10);
		e.engine.handleKey("c", e.key());
		expect(e.engine.mode).toBe("insert");
		expect(e.state.text).toBe("hello ");
	});

	test("Esc collapses visual without changes", () => {
		const e = editor("data", 0);
		e.engine.handleKey("V", e.key());
		e.engine.handleKey("", e.key({ escape: true }));
		expect(e.engine.mode).toBe("normal");
		expect(e.engine.selection).toBeNull();
		expect(e.state.text).toBe("data");
	});
});

describe("host integration contract", () => {
	test("Enter and ctrl/meta combos pass through unconsumed", () => {
		const e = editor("hi");
		expect(e.engine.handleKey("", e.key({ return: true }))).toBe(false);
		expect(e.engine.handleKey("c", e.key({ ctrl: true }))).toBe(false);
		expect(e.engine.handleKey("x", e.key({ meta: true }))).toBe(false);
	});

	test("ctrl+r triggers redo only; other ctrl keys pass through in normal mode", () => {
		const e = editor("abc", 3);
		e.engine.handleKey("a", e.key()); // append → insert
		e.type("d");
		expect(e.state.text).toBe("abcd");
		e.engine.handleKey("", e.key({ escape: true }));
		e.engine.handleKey("u", e.key());
		expect(e.state.text).toBe("abc");
		e.engine.handleKey("r", e.key({ ctrl: true }));
		expect(e.state.text).toBe("abcd");
		expect(e.engine.handleKey("c", e.key({ ctrl: true }))).toBe(false);
	});

	test("line helpers agree with the engine's line math", () => {
		const text = "ab\ncdef\ngh";
		expect(lineOf(text, 5)).toBe(1);
		expect(lineStart(text, 5)).toBe(3);
		expect(lineCount(text)).toBe(3);
		expect(motionWordEnd(text, 3)).toBe(6);
	});
});
