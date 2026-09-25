/**
 * VimEngine tests — pure state machine, no React/ink involved.
 * Each editor is an in-memory string+cursor pair driven through handleKey.
 */
import { describe, expect, test } from "bun:test";
import { expandPasteTokens, makePasteToken } from "../src/paste.ts";
import {
	lineCount,
	lineOf,
	lineStart,
	motionBackWord,
	motionForwardWord,
	motionWordEnd,
	motionWordEndHere,
	splitsPasteToken,
	VimEngine,
	type VimKey,
} from "../src/vim.ts";

/** What a large paste folds itself into, and what every case below is about. */
const PASTE_TOKEN = makePasteToken(1, 800);

function editor(text: string, cursor = 0) {
	const recalled: Array<"up" | "down"> = [];
	const undoBuf: Array<{ text: string; cursor: number }> = [];
	let redoBuf: Array<{ text: string; cursor: number }> = [];
	const state = { text, cursor };
	/** Every `setAll` is one write, and the engine's write is the caller's undo step. */
	let writes = 0;

	const engine = new VimEngine({
		getText: () => state.text,
		getCursor: () => state.cursor,
		setCursor: (p) => {
			state.cursor = Math.max(0, Math.min(p, state.text.length));
		},
		setAll: (t, c) => {
			writes += 1;
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

	return { engine, state, recalled, key, type, writes: () => writes };
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

	test("motionWordEndHere is the end of the run the caret is in", () => {
		const text = "one.two three";
		expect(motionWordEndHere(text, 0)).toBe(2); // the "one" run
		expect(motionWordEndHere(text, 2)).toBe(2); // already on it: `e` would walk on
		expect(motionWordEndHere(text, 3)).toBe(3); // the "." run
		expect(motionWordEndHere(text, 4)).toBe(6); // inside "two"
		expect(motionWordEndHere(text, 4, true)).toBe(6); // WORDs agree here
		expect(motionWordEndHere("ab\ncd", 1)).toBe(1); // a break ends no run
		expect(motionWordEndHere("ab\ncd", 3)).toBe(4); // the "cd" run
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
		// Bare G is the last line's first non-blank (vim), and a NORMAL cursor sits
		// on a character — so `Gx` deletes one instead of doing nothing.
		expect(e.state.cursor).toBe(6);
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

	test("a count pastes the whole line block again", () => {
		// `[count]p` pastes the register that many times (vim's op_paste loop), the
		// whole block each time rather than just its first line. vim 9.1: `yy2p` on
		// "a\nb\n" is "a\na\na\nb", `yy3P` is "a\na\na\na\nb", and `2yy2p` on three
		// lines repeats both lines of the register.
		const below = editor("a\nb\n", 0);
		for (const k of ["y", "y", "2", "p"]) below.engine.handleKey(k, below.key());
		expect(below.state.text).toBe("a\na\na\nb\n");

		const above = editor("a\nb\n", 0);
		for (const k of ["y", "y", "3", "P"]) above.engine.handleKey(k, above.key());
		expect(above.state.text).toBe("a\na\na\na\nb\n");

		const block = editor("a\nb\nc\n", 0);
		for (const k of ["2", "y", "y", "2", "p"]) block.engine.handleKey(k, block.key());
		expect(block.state.text).toBe("a\na\nb\na\nb\nb\nc\n");

		// The last line has no break to paste after, so the copies bring their own
		// and the caret lands on the first of them (vim: 3:1).
		const last = editor("a\nb", 2);
		for (const k of ["y", "y", "2", "p"]) last.engine.handleKey(k, last.key());
		expect(last.state.text).toBe("a\nb\nb\nb");
		expect(last.state.cursor).toBe(4);
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

	test("a count the line cannot supply is refused, not clamped onto it", () => {
		// vim aborts the whole command (normal.c:4900-4906) where clamping replaces
		// the characters that are there — measured: `3r+` on the last character of
		// "abc" changes nothing. The count is in characters, not units, which is what
		// makes the two wide ones below answer like the narrow ones.
		const typed = (text: string, cursor: number, ...keys: string[]) => {
			const e = editor(text, cursor);
			for (const k of keys) e.engine.handleKey(k, e.key());
			return { text: e.state.text, writes: e.writes() };
		};
		expect(typed("abc\ndef", 2, "3", "r", "+")).toEqual({ text: "abc\ndef", writes: 0 });
		expect(typed("abc\ndef", 2, "9", "r", "+")).toEqual({ text: "abc\ndef", writes: 0 });
		expect(typed("abcd", 2, "2", "r", "+")).toEqual({ text: "ab++", writes: 1 });
		expect(typed("abcdef", 3, "3", "r", "+")).toEqual({ text: "abc+++", writes: 1 });
		expect(typed("你好", 0, "2", "r", "+")).toEqual({ text: "++", writes: 1 });
		expect(typed("你好", 0, "3", "r", "+")).toEqual({ text: "你好", writes: 0 });
		expect(typed("👍👍", 0, "3", "r", "+")).toEqual({ text: "👍👍", writes: 0 });
		// The count still goes to the end of the line, not onto the next one.
		expect(typed("abc\ndef", 2, "9", "r", "X")).toEqual({ text: "abc\ndef", writes: 0 });
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

	test("d{n}f{c} carries the operator across the pending find char; counts on both sides multiply", () => {
		const e = editor("0x1x2x3x4x5", 0);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("f", e.key());
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("4x5"); // 2 (operator) x 2 (find) = deletes through the 4th 'x'
		expect(e.state.cursor).toBe(0);

		const single = editor("1x2x3x4", 0);
		single.engine.handleKey("d", single.key());
		single.engine.handleKey("2", single.key());
		single.engine.handleKey("f", single.key());
		single.engine.handleKey("x", single.key());
		expect(single.state.text).toBe("3x4"); // deletes through the 2nd 'x'
	});

	test("{n}f{c} without a pending operator only moves the cursor", () => {
		const e = editor("1x2x3x4", 0);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("f", e.key());
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("1x2x3x4");
		expect(e.state.cursor).toBe(3);
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

/**
 * Cases a differential run against real vim (9.1, `-u NONE -N`) turned up. Each
 * one is a place where the engine used to answer differently from vim.
 */
describe("differential fixes", () => {
	test("d0 and c0 finish the operator instead of eating the 0 as a count", () => {
		const d = editor("foo bar", 4);
		d.engine.handleKey("d", d.key());
		d.engine.handleKey("0", d.key());
		expect(d.state.text).toBe("bar");
		expect(d.state.cursor).toBe(0);

		const c = editor("foo bar", 4);
		c.engine.handleKey("c", c.key());
		c.engine.handleKey("0", c.key());
		expect(c.state.text).toBe("bar");
		expect(c.engine.mode).toBe("insert");

		// A count already under way still takes the digit: d2l, not d0.
		const counted = editor("abcdef", 0);
		counted.engine.handleKey("d", counted.key());
		counted.engine.handleKey("2", counted.key());
		counted.engine.handleKey("l", counted.key());
		expect(counted.state.text).toBe("cdef");
	});

	test("dj and dk at the buffer edges do nothing instead of taking a line", () => {
		const last = editor("one\ntwo\nthree", 8);
		last.engine.handleKey("d", last.key());
		last.engine.handleKey("j", last.key());
		expect(last.state.text).toBe("one\ntwo\nthree");
		expect(last.writes()).toBe(0);

		const first = editor("one\ntwo\nthree", 0);
		first.engine.handleKey("d", first.key());
		first.engine.handleKey("k", first.key());
		expect(first.state.text).toBe("one\ntwo\nthree");

		// Mid-buffer is still a real delete.
		const mid = editor("one\ntwo\nthree", 0);
		mid.engine.handleKey("d", mid.key());
		mid.engine.handleKey("j", mid.key());
		expect(mid.state.text).toBe("three");
	});

	test("dl and dh are x and X with an operator in front", () => {
		const l = editor("abcdef", 0);
		l.engine.handleKey("d", l.key());
		l.engine.handleKey("2", l.key());
		l.engine.handleKey("l", l.key());
		expect(l.state.text).toBe("cdef");

		const h = editor("abcdef", 4);
		h.engine.handleKey("d", h.key());
		h.engine.handleKey("h", h.key());
		expect(h.state.text).toBe("abcef");

		// At a line's last character dl takes that character, never the break.
		const edge = editor("ab\ncd", 1);
		edge.engine.handleKey("d", edge.key());
		edge.engine.handleKey("l", edge.key());
		expect(edge.state.text).toBe("a\ncd");

		const start = editor("ab\ncd", 3);
		start.engine.handleKey("d", start.key());
		start.engine.handleKey("h", start.key());
		expect(start.state.text).toBe("ab\ncd");
		expect(start.writes()).toBe(0);
	});

	test("w and e never leave the caret past the last character", () => {
		const w = editor("one two", 4);
		w.engine.handleKey("w", w.key());
		expect(w.state.cursor).toBe(6); // the last character, as in vim
		w.engine.handleKey("x", w.key());
		expect(w.state.text).toBe("one tw");

		const lone = editor("a", 0);
		lone.engine.handleKey("w", lone.key());
		expect(lone.state.cursor).toBe(0);
		lone.engine.handleKey("x", lone.key());
		expect(lone.state.text).toBe("");
	});

	test("G lands on the last line's first non-blank", () => {
		const indented = editor("aa\n  bb", 0);
		indented.engine.handleKey("G", indented.key());
		expect(indented.state.cursor).toBe(5);
	});

	test("a visual selection covers whole characters", () => {
		const emoji = editor("😀abc", 0);
		emoji.engine.handleKey("v", emoji.key());
		emoji.engine.handleKey("x", emoji.key());
		expect(emoji.state.text).toBe("abc"); // not a lone low surrogate

		const mid = editor("a😀b", 0);
		mid.engine.handleKey("v", mid.key());
		mid.engine.handleKey("l", mid.key());
		mid.engine.handleKey("d", mid.key());
		expect(mid.state.text).toBe("b");

		const yank = editor("a😀b", 0);
		yank.engine.handleKey("v", yank.key());
		yank.engine.handleKey("l", yank.key());
		yank.engine.handleKey("y", yank.key());
		yank.engine.handleKey("$", yank.key());
		yank.engine.handleKey("p", yank.key());
		expect(yank.state.text).toBe("a😀ba😀"); // pasted whole, not half
	});

	test("a combining mark rides with the character it belongs to", () => {
		const mark = "é"; // "é" written as a base letter plus U+0301
		const e = editor(`${mark}abc`, 0);
		e.engine.handleKey("l", e.key());
		expect(e.state.cursor).toBe(2); // over the whole cluster
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe(`${mark}bc`);
		e.engine.handleKey("h", e.key());
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("bc"); // base and mark go together

		const word = editor(`${mark} abc`, 0);
		word.engine.handleKey("d", word.key());
		word.engine.handleKey("w", word.key());
		expect(word.state.text).toBe("abc");

		const tilde = editor(mark, 0);
		tilde.engine.handleKey("~", tilde.key());
		expect(tilde.state.text).toBe("É"); // case swapped, mark kept
	});

	test("linewise paste lands on the pasted line's first non-blank", () => {
		const below = editor("aa\nbb", 3);
		below.engine.handleKey("y", below.key());
		below.engine.handleKey("y", below.key());
		below.engine.handleKey("p", below.key());
		expect(below.state.text).toBe("aa\nbb\nbb");
		expect(below.state.cursor).toBe(6);

		const above = editor("aa\nbb", 0);
		above.engine.handleKey("d", above.key());
		above.engine.handleKey("d", above.key());
		above.engine.handleKey("p", above.key());
		expect(above.state.text).toBe("bb\naa");
		expect(above.state.cursor).toBe(3);
	});
});

describe("the NORMAL cursor stays on a character", () => {
	test("Esc out of insert steps back onto the character just typed", () => {
		const e = editor("", 0);
		e.engine.handleKey("i", e.key());
		e.type("abc");
		expect(e.state.cursor).toBe(3); // insert mode lives one past the text
		expect(e.engine.handleKey("", e.key({ escape: true }))).toBe(true);
		expect(e.state.cursor).toBe(2);
		// The first key after Esc lands on the text, not on empty air.
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("ab");
		expect(e.state.cursor).toBe(1);
	});

	test("h and l never step onto a line break", () => {
		const e = editor("ab\ncd", 1);
		e.engine.handleKey("l", e.key());
		expect(e.state.cursor).toBe(1); // already at the end of the line
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("a\ncd"); // "b" is gone; the newline is not

		const back = editor("ab\ncd", 3);
		back.engine.handleKey("h", back.key());
		expect(back.state.cursor).toBe(3); // already at the start of the line
		back.engine.handleKey("X", back.key());
		expect(back.state.text).toBe("ab\ncd");
		expect(back.writes()).toBe(0); // nothing to delete is not an edit
	});

	test("a count stops at the line end instead of leaking", () => {
		const e = editor("ab\ncd", 0);
		e.engine.handleKey("3", e.key());
		e.engine.handleKey("l", e.key());
		expect(e.state.cursor).toBe(1);
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("a\ncd"); // the 3 was spent by `l`, not by `x`
	});

	test("$ and G land on the last character, so the next edit has a target", () => {
		const dollar = editor("abc", 0);
		dollar.engine.handleKey("$", dollar.key());
		expect(dollar.state.cursor).toBe(2);
		dollar.engine.handleKey("x", dollar.key());
		expect(dollar.state.text).toBe("ab");

		const last = editor("aa\nbb\ncc", 3);
		last.engine.handleKey("G", last.key());
		last.engine.handleKey("x", last.key());
		expect(last.state.text).toBe("aa\nbb\nc");
	});

	test("Home/End and arrows work in NORMAL mode; Tab is the host's", () => {
		const e = editor("  hi\nthere", 3);
		expect(e.engine.handleKey("", e.key({ home: true }))).toBe(true);
		expect(e.state.cursor).toBe(0);
		e.engine.handleKey("", e.key({ end: true }));
		expect(e.state.cursor).toBe(3);
		expect(e.engine.handleKey("", e.key({ tab: true }))).toBe(false); // completion

		const arrows = editor("ab\ncd", 1);
		arrows.engine.handleKey("", arrows.key({ downArrow: true }));
		expect(arrows.state.cursor).toBe(4);
		arrows.engine.handleKey("", arrows.key({ leftArrow: true }));
		expect(arrows.state.cursor).toBe(3);
		arrows.engine.handleKey("", arrows.key({ upArrow: true }));
		expect(arrows.state.cursor).toBe(0);
	});
});

describe("counts are spent by the command that took them", () => {
	test("2j moves two lines and leaves nothing behind", () => {
		const e = editor("ab\ncd\nef", 1);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("j", e.key());
		expect(e.state.cursor).toBe(7); // 'f' on line 3
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("ab\ncd\ne"); // one char, not two
	});

	test("counts reach x, r, f and G", () => {
		const x = editor("abcdef", 0);
		x.engine.handleKey("3", x.key());
		x.engine.handleKey("x", x.key());
		expect(x.state.text).toBe("def");

		const r = editor("abcdef", 0);
		r.engine.handleKey("3", r.key());
		r.engine.handleKey("r", r.key());
		r.engine.handleKey("X", r.key());
		expect(r.state.text).toBe("XXXdef");
		expect(r.state.cursor).toBe(2);

		const f = editor("axbxcxd", 0);
		f.engine.handleKey("3", f.key());
		f.engine.handleKey("f", f.key());
		f.engine.handleKey("x", f.key());
		expect(f.state.cursor).toBe(5); // the third x, not the first

		const g = editor("a\nb\nc\nd", 0);
		g.engine.handleKey("3", g.key());
		g.engine.handleKey("G", g.key());
		expect(g.state.cursor).toBe(4); // line 3, on 'c'
	});

	test("3D, 3S and 3u do three of the thing", () => {
		const d = editor("aaa\nbbb\nccc\nddd", 1);
		d.engine.handleKey("3", d.key());
		d.engine.handleKey("D", d.key());
		expect(d.state.text).toBe("a\nddd"); // through the end of line 3
		expect(d.writes()).toBe(1);

		const s = editor("aa\nbb\ncc\ndd", 0);
		s.engine.handleKey("3", s.key());
		s.engine.handleKey("S", s.key());
		expect(s.state.text).toBe("\ndd"); // three lines become one empty one
		expect(s.engine.mode).toBe("insert");
		expect(s.writes()).toBe(1);

		const u = editor("a\nb\nc\nd", 0);
		for (let i = 0; i < 3; i++) {
			u.engine.handleKey("d", u.key());
			u.engine.handleKey("d", u.key());
		}
		expect(u.state.text).toBe("d");
		u.engine.handleKey("3", u.key());
		u.engine.handleKey("u", u.key());
		expect(u.state.text).toBe("a\nb\nc\nd");
	});

	test("a count nobody could mean is capped instead of freezing the loop", () => {
		const e = editor("abc", 0);
		for (const ch of "999999999999") e.engine.handleKey(ch, e.key());
		e.engine.handleKey("l", e.key());
		expect(e.state.cursor).toBe(2); // 10^12 is a hang; the cap is 10000
		expect(e.engine.mode).toBe("normal");
	});
});

describe("a half-typed command never stands in the way", () => {
	test("Enter is the host's even mid-command, and the command is dropped", () => {
		const find = editor("abc", 0);
		find.engine.handleKey("f", find.key());
		expect(find.engine.handleKey("", find.key({ return: true }))).toBe(false);

		const op = editor("one two", 0);
		op.engine.handleKey("d", op.key());
		expect(op.engine.handleKey("", op.key({ return: true }))).toBe(false);
		op.engine.handleKey("w", op.key());
		expect(op.state.text).toBe("one two"); // the `d` is gone; `w` only moved
		expect(op.state.cursor).toBe(4);

		const g = editor("aa\nbb", 3);
		g.engine.handleKey("g", g.key());
		expect(g.engine.handleKey("", g.key({ return: true }))).toBe(false);
		g.engine.handleKey("g", g.key()); // a stray second g is its own command
		expect(g.state.cursor).toBe(3);

		const count = editor("abcd", 0);
		count.engine.handleKey("3", count.key());
		expect(count.engine.handleKey("", count.key({ return: true }))).toBe(false);
		count.engine.handleKey("l", count.key());
		expect(count.state.cursor).toBe(1);
	});

	test("Esc cancels a half-typed command but is not taken from the host", () => {
		const e = editor("abc", 0);
		e.engine.handleKey("d", e.key());
		expect(e.engine.handleKey("", e.key({ escape: true }))).toBe(true); // cancelled
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("abc");
		// Nothing left to cancel: the host's interrupt needs this one.
		expect(e.engine.handleKey("", e.key({ escape: true }))).toBe(false);

		const g = editor("aa\nbb", 3);
		g.engine.handleKey("g", g.key());
		expect(g.engine.handleKey("", e.key({ escape: true }))).toBe(true);
		g.engine.handleKey("g", g.key());
		expect(g.state.cursor).toBe(3); // no jump: the pending g was dropped
	});
});

describe("the prefixes whose argument the engine reads and drops", () => {
	// Marks, named registers, searches and ex-commands are out of scope, but the
	// keys that open them are still taken. A dropped prefix used to leave the keys
	// after it to be read as commands of their own: `ma` meant "swallow `m`, then
	// append", and `"ayy` typed "ayy" into the prompt it was meant to yank from.
	test("m, \" and ' read one name and leave the mode alone", () => {
		const named = (prefix: string, name: string) => {
			const e = editor("abc def", 0);
			expect(e.engine.handleKey(prefix, e.key())).toBe(true);
			expect(e.engine.handleKey(name, e.key())).toBe(true); // the name, not append
			expect(e.engine.mode).toBe("normal");
			expect(e.state.text).toBe("abc def");
			// The name was the prefix's, not a command: the next key is its own again.
			e.engine.handleKey("w", e.key());
			expect(e.state.cursor).toBe(4);
		};
		named("m", "a");
		named('"', "a");
		named("'", "a");
		named("`", "a");

		// Escape is a name too: `m` then <Esc> sets no mark and leaves nothing behind.
		const esc = editor("abc def", 0);
		esc.engine.handleKey("m", esc.key());
		expect(esc.engine.handleKey("", esc.key({ escape: true }))).toBe(true);
		esc.engine.handleKey("w", esc.key());
		expect(esc.state.cursor).toBe(4);
	});

	test("z, Z, q and @ read one key and leave the mode alone", () => {
		// The same rule for the commands this engine does not implement: `zz`, `ZZ`,
		// `qa` and `@a` are not here, but the keys that open them are taken. Without
		// that, `zx` deleted a character and `qa` appended.
		for (const prefix of ["z", "Z", "q", "@"]) {
			const e = editor("abc def", 0);
			expect(e.engine.handleKey(prefix, e.key())).toBe(true);
			expect(e.engine.handleKey("x", e.key())).toBe(true); // an argument, not a command
			expect(e.state.text).toBe("abc def");
			expect(e.engine.mode).toBe("normal");
			e.engine.handleKey("w", e.key());
			expect(e.state.cursor).toBe(4); // the next key is its own again
		}

		// And with an operator in front, the operator goes with it: `2dzx` changes
		// nothing (vim: `dz` waits for a motion, and this engine has none for it).
		const op = editor("abc def", 0);
		op.engine.handleKey("2", op.key());
		op.engine.handleKey("d", op.key());
		op.engine.handleKey("z", op.key());
		expect(op.engine.handleKey("x", op.key())).toBe(true);
		expect(op.state.text).toBe("abc def");
		expect(op.writes()).toBe(0);
		op.engine.handleKey("w", op.key());
		expect(op.state.cursor).toBe(4);
	});

	test("a named yank is still a yank", () => {
		const e = editor("one\ntwo", 4);
		for (const k of ['"', "a", "y", "y"]) e.engine.handleKey(k, e.key());
		expect(e.state.text).toBe("one\ntwo");
		e.engine.handleKey("p", e.key());
		expect(e.state.text).toBe("one\ntwo\ntwo"); // "a" was read, the yank happened
	});

	test("/ and : hold their input line until Escape drops it", () => {
		// `/foo` used to arm a find with its `f`, take the first `o` as the target and
		// open a line with the second.
		const slash = editor("foo bar\n", 0);
		for (const k of ["/", "f", "o", "o"]) expect(slash.engine.handleKey(k, slash.key())).toBe(true);
		expect(slash.state.text).toBe("foo bar\n");
		expect(slash.engine.mode).toBe("normal");
		// The line is still open, so the next key belongs to it instead of moving:
		expect(slash.engine.handleKey("w", slash.key())).toBe(true);
		expect(slash.state.cursor).toBe(0);
		// Escape drops it — vim's typed <Esc> abandons the command line, where a macro
		// <Esc> would run it (c_<Esc>) — and then `w` is a motion again.
		expect(slash.engine.handleKey("", slash.key({ escape: true }))).toBe(true);
		slash.engine.handleKey("w", slash.key());
		expect(slash.state.cursor).toBe(4);

		// `?` is the same line backwards (the `f` must not become a find).
		const back = editor("foo bar\n", 0);
		for (const k of ["?", "f", "o", "o"]) expect(back.engine.handleKey(k, back.key())).toBe(true);
		expect(back.state.text).toBe("foo bar\n");
		expect(back.engine.handleKey("w", back.key())).toBe(true); // still the line's
		expect(back.state.cursor).toBe(0);
		expect(back.engine.handleKey("", back.key({ escape: true }))).toBe(true);
		back.engine.handleKey("w", back.key());
		expect(back.state.cursor).toBe(4);

		// `:s/x/` used to delete a character (`:`, then `s`) and type the rest.
		const colon = editor("abc def\n", 0);
		for (const k of [":", "s", "/", "x", "/"]) expect(colon.engine.handleKey(k, colon.key())).toBe(true);
		expect(colon.state.text).toBe("abc def\n");
		expect(colon.engine.mode).toBe("normal");
		expect(colon.engine.handleKey("", colon.key({ escape: true }))).toBe(true);
		colon.engine.handleKey("w", colon.key());
		expect(colon.state.cursor).toBe(4); // the ex line is gone with it
	});

	test("an operator in front of one is dropped with it", () => {
		// `d/foo` deletes up to the next match; with no search the motion cannot land.
		const e = editor("foo bar bar\n", 0);
		e.engine.handleKey("d", e.key());
		for (const k of ["/", "b", "a", "r"]) expect(e.engine.handleKey(k, e.key())).toBe(true);
		expect(e.state.text).toBe("foo bar bar\n"); // nothing was deleted
		expect(e.engine.handleKey("", e.key({ escape: true }))).toBe(true); // the line is dropped
		e.engine.handleKey("w", e.key());
		expect(e.state.cursor).toBe(4); // and neither the line nor the operator was left

		// `d"ayy` names the register to delete into; the name is read, and `a` does
		// not fall through to append (which typed "yy" into the buffer).
		const named = editor("abc\ndef\n", 0);
		named.engine.handleKey("d", named.key());
		for (const k of ['"', "a", "y", "y"]) named.engine.handleKey(k, named.key());
		expect(named.engine.mode).toBe("normal");
		expect(named.state.text).toBe("abc\ndef\n");
	});

	test("Enter submits from a : or m line and runs the search from a / line", () => {
		// The `/` half of this used to assert that Enter submitted and dropped the
		// half-typed search — which is what it did when a search line was read and
		// thrown away. It is not what it does now, and it is not what vim does: Enter
		// is the key that runs a search, and the host never sees it. So the `false`
		// here is a `true`, and the line is a pattern rather than a discard.
		const search = editor("abc def\n", 0);
		search.engine.handleKey("/", search.key());
		search.engine.handleKey("f", search.key());
		expect(search.engine.handleKey("", search.key({ return: true }))).toBe(true);
		expect(search.state.text).toBe("abc def\n");
		expect(search.state.cursor).toBe(6); // it searched, and the `f` was the pattern

		const name = editor("abc def\n", 0);
		name.engine.handleKey("m", name.key());
		expect(name.engine.handleKey("", name.key({ return: true }))).toBe(false);
		name.engine.handleKey("a", name.key()); // the `m` is gone: this is append again
		expect(name.engine.mode).toBe("insert");

		const cancel = editor("abc def\n", 0);
		cancel.engine.handleKey(":", cancel.key());
		expect(cancel.engine.handleKey("", cancel.key({ escape: true }))).toBe(true); // cancelled
		expect(cancel.engine.handleKey("", cancel.key({ escape: true }))).toBe(false); // host's again
		cancel.engine.handleKey("w", cancel.key());
		expect(cancel.state.cursor).toBe(4);
	});

	test("a ctrl combo abandons a half-typed line", () => {
		// ctrl+c is the host's interrupt and hands the prompt back: the line must not
		// stay armed, or the keys typed into the prompt the host just took over would
		// be eaten by it.
		const line = editor("abc def\n", 0);
		line.engine.handleKey("/", line.key());
		line.engine.handleKey("f", line.key());
		expect(line.engine.handleKey("c", line.key({ ctrl: true }))).toBe(false);
		line.engine.handleKey("w", line.key());
		expect(line.state.cursor).toBe(4);

		const name = editor("abc def\n", 0);
		name.engine.handleKey("m", name.key());
		expect(name.engine.handleKey("c", name.key({ ctrl: true }))).toBe(false);
		name.engine.handleKey("w", name.key());
		expect(name.state.cursor).toBe(4);
	});
});

/**
 * `/`, `?`, `n`, `N`, `*` and `#`.
 *
 * Every number below is a real vim's answer, taken through
 * `test/vim-differential/harness.mjs` on the machine that wrote this — which is why
 * a case here can be a sentence about vim rather than about this engine. The
 * differential list holds the same cases as comparisons that re-measure; these
 * hold them as values, so a regression is a failing test rather than a diff at the
 * bottom of a log.
 */
describe("search", () => {
	/** Type a `/` or `?` line and press Enter, the way the terminal sends it. */
	const search = (e: ReturnType<typeof editor>, keys: string) => {
		expect(e.engine.handleKey(keys.slice(0, 1), e.key())).toBe(true);
		for (const ch of keys.slice(1)) expect(e.engine.handleKey(ch, e.key())).toBe(true);
		return e.engine.handleKey("", e.key({ return: true }));
	};
	const press = (e: ReturnType<typeof editor>, keys: string) => {
		for (const ch of keys) e.engine.handleKey(ch, e.key());
	};

	test("a pattern searches from strictly past the caret", () => {
		// A match under the caret is not a match ahead of it, which is the difference
		// between landing on the second `abc` and standing still.
		const here = editor("abcabc", 0);
		expect(search(here, "/abc")).toBe(true); // Enter is the search's, not the host's
		expect(here.state.cursor).toBe(3);
		const next = editor("a a a", 0);
		search(next, "/a");
		expect(next.state.cursor).toBe(2);
		// And it does not stop at the end of a line: the `b` of the second line is a
		// match like any other.
		const down = editor("a\nb", 0);
		search(down, "/b");
		expect(down.state.cursor).toBe(2);
	});

	test("a count steps over matches and wraps round them", () => {
		// Three matches and a count of 3 or 4 is the whole of the modulo: 2, 0, 2 for
		// counts 2, 3, 4. A list of the matches ahead plus the ones behind, indexed
		// once, answers 0 and 4 instead.
		const three = editor("a a a", 0);
		search(three, "3/a");
		expect(three.state.cursor).toBe(0);
		const four = editor("a a a", 0);
		search(four, "4/a");
		expect(four.state.cursor).toBe(2);
		// The same arithmetic on a repeat, where the count is on the `n`.
		const six = editor("a a a a a a", 0);
		search(six, "/a");
		press(six, "n");
		expect(six.state.cursor).toBe(4);
		press(six, "2n");
		expect(six.state.cursor).toBe(8);
		press(six, "2N");
		expect(six.state.cursor).toBe(4); // backward two from 8 is 4, not a wrap to 0
	});

	test("n follows the last search and N reverses without changing it", () => {
		// Two `N` in a row go the same way, because neither of them rewrites which
		// direction the last search ran in.
		const back = editor("a a a a", 0);
		search(back, "?a");
		expect(back.state.cursor).toBe(6);
		press(back, "N");
		expect(back.state.cursor).toBe(0);
		press(back, "N");
		expect(back.state.cursor).toBe(2);
		// A word search is a last search too, and `*` runs forward.
		const word = editor("foo foo foo", 0);
		press(word, "*");
		expect(word.state.cursor).toBe(4);
		press(word, "n");
		expect(word.state.cursor).toBe(8);
		press(word, "N");
		expect(word.state.cursor).toBe(4);
		press(word, "N");
		expect(word.state.cursor).toBe(0);
		// And a following `n` goes forward again, which is the only case that can tell
		// "N reverses the next match" from "N rewrites which way the last search ran".
		const again = editor("foo foo foo", 0);
		press(again, "*Nn");
		expect(again.state.cursor).toBe(4);
	});

	test("a search that found nothing is still the last search", () => {
		// So `n` goes on failing rather than falling back on the pattern that used to
		// work — and a pattern that does not compile replaces it the same way, which is
		// what makes keeping the text the right shape for the field.
		const none = editor("a b a", 0);
		search(none, "/a");
		expect(none.state.cursor).toBe(4);
		search(none, "/zzz");
		press(none, "n");
		expect(none.state.cursor).toBe(4);
		const broken = editor("a b a", 0);
		search(broken, "/a");
		search(broken, "/(");
		press(broken, "n");
		expect(broken.state.cursor).toBe(4);
	});

	test("Escape keeps the last search, and an empty line repeats it", () => {
		const kept = editor("a b a b", 0);
		search(kept, "/a");
		expect(kept.engine.handleKey("/", kept.key())).toBe(true);
		press(kept, "b");
		expect(kept.engine.handleKey("", kept.key({ escape: true }))).toBe(true);
		press(kept, "n");
		expect(kept.state.cursor).toBe(0); // back round, which is where `a` goes from 4
		// An empty pattern, a doubled separator and a trailing one are all the repeat.
		for (const line of ["", "/", "a/"]) {
			const e = editor("a b a b", 0);
			search(e, "/a");
			search(e, `/${line}`);
			expect(e.state.cursor).toBe(0);
		}
	});

	test("with no last search to repeat, nothing moves", () => {
		const e = editor("a b a", 0);
		search(e, "/");
		expect(e.state.cursor).toBe(0);
		// Consumed, not handed back: vim says E35 and a host that took the key as its
		// own would type the user's next prompt character instead.
		expect(e.engine.handleKey("n", e.key())).toBe(true);
		expect(e.state.cursor).toBe(0);
		expect(e.engine.handleKey("N", e.key())).toBe(true);
		expect(e.state.cursor).toBe(0);
	});

	test("^ and $ are line anchors, and the search crosses lines", () => {
		const start = editor("a b\na b", 2);
		search(start, "/^a");
		expect(start.state.cursor).toBe(4); // the `a` that begins the second line
		const end = editor("a b\na b", 0);
		search(end, "/b$");
		expect(end.state.cursor).toBe(2); // the `b` that ends the first line
	});

	test("the offset is a letter after a separator, and nothing else", () => {
		const toEnd = editor("a a a", 0);
		search(toEnd, "/a/e");
		expect(toEnd.state.cursor).toBe(2);
		press(toEnd, "n");
		expect(toEnd.state.cursor).toBe(4); // the last character of the next match
		const here = editor("a a a", 0);
		search(here, "/a/c");
		expect(here.state.cursor).toBe(2);
		const literal = editor("a a a", 0);
		search(literal, "/ae"); // no separator, so the `e` is part of the pattern
		expect(literal.state.cursor).toBe(0);
	});

	test("an offset searches for the position it lands on", () => {
		// Every offset case above is a one-character match, where the position it
		// lands on and the position it starts at are the same offset. These are not,
		// and they are the whole of what the rule is: the search is about where the
		// caret ends up, so `/ab/e` on `ab ab` at 0 answers the 1 — the match the
		// caret is inside, reached because that match *ends* past it — where a search
		// that compared the starts would skip to the 3.
		const under = editor("ab ab", 0);
		search(under, "/ab/e");
		expect(under.state.cursor).toBe(1);
		// One character on, the first landing past the caret is the 4.
		const oneOn = editor("ab ab", 1);
		search(oneOn, "/ab/e");
		expect(oneOn.state.cursor).toBe(4);
		// And the count is counted from there: two landings on from 1 is the 7.
		const counted = editor("ab ab ab", 1);
		search(counted, "2/ab/e");
		expect(counted.state.cursor).toBe(7);
		// `n` re-applies the stored offset, so it lands on the other match's end
		// rather than on its start.
		const repeated = editor("ab ab ab", 0);
		search(repeated, "/ab/e");
		press(repeated, "n");
		expect(repeated.state.cursor).toBe(4);
		// Backward is the same comparison rather than a case of its own: from 3 the
		// last landing before the caret is the 1, and from 1 there is none at all, so
		// it wraps to the far end.
		const back = editor("abcabc", 3);
		search(back, "?ab?e");
		expect(back.state.cursor).toBe(1);
		const wrapped = editor("abcabc", 1);
		search(wrapped, "?ab?e");
		expect(wrapped.state.cursor).toBe(4);
		const backAgain = editor("ab ab ab", 5);
		search(backAgain, "?ab?e");
		press(backAgain, "n");
		expect(backAgain.state.cursor).toBe(1);
	});

	test("only \\< and \\> are translated, and a bare angle bracket is a bracket", () => {
		// The translation is the two word boundaries and nothing else, so each of
		// them has to be pinned where an untranslated one gives a different answer:
		// a JavaScript `\<` is an identity escape, which is a literal `<`, and a
		// pattern that is a literal `<f` finds nothing in `foo foo` at all.
		const start = editor("foo foo", 0);
		search(start, "/\\<f");
		expect(start.state.cursor).toBe(4);
		// The same for `\>`: as a literal `>` it matches nothing here, where the
		// boundary version skips the `foo` under the caret and finds the next one.
		const both = editor("foo foo", 0);
		search(both, "/\\<foo\\>");
		expect(both.state.cursor).toBe(4);
		// And a `<` with no backslash in front of it is itself, so a buffer full of
		// them is searchable — measured, and the reason the translation cannot be a
		// blanket removal of the character.
		const literal = editor("<foo <foo", 0);
		search(literal, "/<f");
		expect(literal.state.cursor).toBe(5);
	});

	test("a bare separator line takes the direction it was typed with", () => {
		// Not the direction the last search ran in, and it is remembered: `#` lands on
		// the middle `foo`, `/<CR>` then goes forward to the one it came from, and an
		// `n` after that carries on forward.
		const fwd = editor("foo a foo b foo", 12);
		press(fwd, "#");
		expect(fwd.state.cursor).toBe(6);
		search(fwd, "/");
		expect(fwd.state.cursor).toBe(12);
		press(fwd, "n");
		expect(fwd.state.cursor).toBe(0);
		// The other way round, from a backward `?` search.
		const back = editor("foo a foo b foo", 0);
		search(back, "/foo");
		expect(back.state.cursor).toBe(6);
		search(back, "?");
		expect(back.state.cursor).toBe(0);
		press(back, "n");
		expect(back.state.cursor).toBe(12);
	});

	test("a word run reaches left of the caret", () => {
		// A caret in the middle of a word searches for that word and starts from its
		// first character. An engine that took the scan position as the start would
		// skip its own match, and would visit every second run when counting them.
		const mid = editor("foo foo foo", 1);
		press(mid, "*");
		expect(mid.state.cursor).toBe(4);
		const alsoMid = editor("foo foo foo", 5);
		press(alsoMid, "*");
		expect(alsoMid.state.cursor).toBe(8);
		const backMid = editor("foo foo foo", 6);
		press(backMid, "#");
		expect(backMid.state.cursor).toBe(0);
		// The same rule from a space in front of a run: the search starts at the run's
		// own first character, which is the match it wraps back onto, and not at the
		// caret — from which it would step forward onto the very next run.
		const ahead = editor("foo foo foo", 7);
		press(ahead, "*");
		expect(ahead.state.cursor).toBe(0);
	});

	test("a word is a run of one character class, and is matched whole", () => {
		// Chinese is one run, so a JavaScript `\b` — which knows nothing of it — is
		// not what a word search is.
		const cjk = editor("中文 中文", 1);
		press(cjk, "*");
		expect(cjk.state.cursor).toBe(3);
		// A currency sign is punctuation and is stepped over; the `x` after it is the
		// first thing on the line that is a word at all.
		const euro = editor("€€ €€ x", 0);
		press(euro, "*");
		expect(euro.state.cursor).toBe(6);
		// Matched whole, so a longer run of the same class beside it is not a match
		// and the search wraps back onto the one it started from.
		const longer = editor("👍👍👍 👍👍 x", 0);
		press(longer, "*");
		expect(longer.state.cursor).toBe(0);
		// And from the short run beside it, which is where a search that only compared
		// as far as the word's own length would find the long one.
		const shorter = editor("👍👍👍 👍👍 x", 7);
		press(shorter, "*");
		expect(shorter.state.cursor).toBe(7);
		// One class, so a script change breaks the run even though nothing about the
		// characters is blank or punctuation: from `字` the run is `漢字` and from `ナ`
		// it is `カナ`. A run that reached over everything non-blank would search for
		// the whole word instead and wrap onto itself.
		const kana = editor("かなカナ漢字", 5);
		press(kana, "*");
		expect(kana.state.cursor).toBe(4);
		const katakana = editor("かなカナ漢字", 3);
		press(katakana, "#");
		expect(katakana.state.cursor).toBe(2);
		// The same between two Latin letters, where the boundary is a class change
		// rather than a script change.
		const mixed = editor("ab漢cd", 2);
		press(mixed, "*");
		expect(mixed.state.cursor).toBe(2);
	});

	test("a pattern that can match nothing still searches", () => {
		// `x*` matches empty beside every character, so the matches are one per
		// character and the answer is the first one *after* the caret. A scan that
		// advanced a UTF-16 unit would report the position between the halves of the
		// first emoji, which is not a position a caret can stand at.
		const e = editor("👍👍👍 👍👍 x", 0);
		search(e, "/x*");
		expect(e.state.cursor).toBe(2);
	});

	test("the word lookup stops at the end of the caret's line", () => {
		// The word on the next line is not looked at, so `*` moves nothing at all
		// rather than finding it.
		const blank = editor("  \nfoo", 1);
		press(blank, "*");
		expect(blank.state.cursor).toBe(1);
		const tail = editor("foo  \nbar", 4);
		press(tail, "*");
		expect(tail.state.cursor).toBe(4);
		// A pattern search has no such limit.
		const pat = editor("  \nfoo", 1);
		search(pat, "/foo");
		expect(pat.state.cursor).toBe(3);
	});

	test("with no identifier left on the line, the run is searched as a pattern", () => {
		// Punctuation is the run, and the search becomes a literal one for it: from
		// either dot the run is both of them, so the caret lands on the first.
		const dots = editor("a..", 2);
		press(dots, "*");
		expect(dots.state.cursor).toBe(1);
		const back = editor("a..", 1);
		press(back, "#");
		expect(back.state.cursor).toBe(1);
		// And with nothing but dots on the line the run under the caret is skipped like
		// any other match, so the second pair is where `*` goes and `n` wraps from.
		const pairs = editor(".. ..", 0);
		press(pairs, "*");
		expect(pairs.state.cursor).toBe(3);
		press(pairs, "n");
		expect(pairs.state.cursor).toBe(0);
		const fours = editor(".... ....", 1);
		press(fours, "*");
		expect(fours.state.cursor).toBe(5);
		press(fours, "n");
		expect(fours.state.cursor).toBe(0);
	});

	test("on punctuation both commands look forward for the word", () => {
		// The part that looks wrong and is measured: `#` on a comma lands on the word
		// after it, and it can only do that by having found it forward. The two
		// commands differ in the direction the search runs afterwards.
		const comma = editor("foo, bar, baz", 3);
		press(comma, "#");
		expect(comma.state.cursor).toBe(5);
		const none = editor("foo,", 3);
		press(none, "*"); // no keyword at or after the caret
		expect(none.state.cursor).toBe(3);
	});

	test("the runs a word search walks are collected one line at a time", () => {
		// A run does not reach over a line break — there is nothing on the far side of
		// one to be the same word as — so the two `foo`s here are two matches, and the
		// search crosses to the one below rather than answering the one it started
		// from. That is the line structure showing up in a search at all, which a
		// buffer of one line cannot say.
		const twoLines = editor("foo\nfoo", 0);
		press(twoLines, "*");
		expect(twoLines.state.cursor).toBe(4);
		// And from the second one, where nothing is ahead of it, it wraps to the first.
		const fromSecond = editor("foo\nfoo", 4);
		press(fromSecond, "*");
		expect(fromSecond.state.cursor).toBe(0);
		const repeat = editor("foo\nfoo", 0);
		press(repeat, "*n");
		expect(repeat.state.cursor).toBe(0);
		// A count of two over two runs lands back on the one it started from, which a
		// collection that had read the buffer as one word would not do.
		const counted = editor("foo\nfoo", 0);
		press(counted, "2*");
		expect(counted.state.cursor).toBe(0);
	});

	test("a count steps a word search too", () => {
		// The same cyclic arithmetic as a pattern, over the runs rather than the
		// matches: three `foo`s, and counts of 2 and 3 answer 12 and 0.
		const two = editor("foo a foo b foo", 0);
		press(two, "2*");
		expect(two.state.cursor).toBe(12);
		const three = editor("foo a foo b foo", 0);
		press(three, "3*");
		expect(three.state.cursor).toBe(0);
		const mid = editor("foo a foo b foo", 6);
		press(mid, "2*");
		expect(mid.state.cursor).toBe(0);
		const back = editor("foo a foo b foo", 12);
		press(back, "2#");
		expect(back.state.cursor).toBe(0);
	});

	test("a search arms the wanted column where it lands", () => {
		// The `j` comes back to the column the search stopped in, not to the one the
		// caret started from.
		const e = editor("a a\na a", 0);
		search(e, "/a");
		expect(e.state.cursor).toBe(2);
		press(e, "j");
		expect(e.state.cursor).toBe(6);
	});

	test("an operator takes the range between the caret and the word search's landing", () => {
		// `nv_ident` hands the same pattern to `normal_search` whether or not an
		// operator is waiting, so `d*` searches exactly what `*` searches and the
		// operator's range is the landing and the caret, open at the far end. Three
		// copies of the word, because with two the two directions coincide mod
		// wrapping and the test would pass either way round.
		const before = (cursor: number, keys: string) => {
			const e = editor("aa bb aa bb aa", cursor);
			press(e, keys);
			return e.state;
		};
		expect(before(0, "d*")).toMatchObject({ text: "aa bb aa", cursor: 0 });
		expect(before(0, "d#")).toMatchObject({ text: "aa", cursor: 0 });
		expect(before(6, "d*")).toMatchObject({ text: "aa bb aa", cursor: 6 });
		expect(before(6, "d#")).toMatchObject({ text: "aa bb aa", cursor: 0 });
		expect(before(12, "d*")).toMatchObject({ text: "aa", cursor: 0 });
		expect(before(12, "d#")).toMatchObject({ text: "aa bb aa", cursor: 6 });
		// `add_to_history(HIST_SEARCH, …)` is above the point where the search runs,
		// with no test of `op_pending` in between: the operator's search is remembered
		// like any other, and `n` after it searches the same word.
		const e = editor("foo bar foo", 0);
		press(e, "y*");
		press(e, "n");
		expect(e.state.cursor).toBe(8);
	});

	test("g* and g# are the same search, and dg* the same range", () => {
		// `nv_ident` reads `cap->cmdchar == 'g'` only to decide on the anchor
		// (`if (!g_cmd && vim_iswordp(ptr))`), and that anchor is redundant: the
		// pattern is already the whole maximal run, and a run that does not begin
		// with a word character — the punctuation `*` searches for as itself — gets
		// no anchor under `*` either. The glued runs are the two positions the two
		// spellings are documented to separate; they agree.
		const land = (cursor: number, keys: string) => {
			const e = editor("aa bb aa bb aa", cursor);
			press(e, keys);
			return e.state.cursor;
		};
		expect(land(0, "g*")).toBe(6);
		expect(land(0, "g#")).toBe(12);
		expect(land(6, "g*")).toBe(12);
		expect(land(6, "g#")).toBe(0);
		expect(land(0, "2g*")).toBe(12);
		const glued = editor("foofoo foo", 3);
		press(glued, "g*");
		expect(glued.state.cursor).toBe(0);
		const inside = editor("foobar foo", 1);
		press(inside, "g#");
		expect(inside.state.cursor).toBe(0);
		// And the range, not just the landing: `dg*` deletes what `d*` deletes.
		const e = editor("aa bb aa bb aa", 0);
		press(e, "dg*");
		expect(e.state).toMatchObject({ text: "aa bb aa", cursor: 0 });
	});

	test("a caret one past the last character is not a place a command can use", () => {
		// vim's `check_cursor_col_win` (`misc2.c:560`): the caret is on a character,
		// and a column at the end of the line steps back onto the last one. The host
		// is free to hand us that column — it is where a paste at the end leaves it —
		// and without the step `x`, `r` and `*` all read nothing at the caret and do
		// nothing at all.
		const x = editor("aa bb", 5);
		x.engine.handleKey("x", x.key());
		expect(x.state).toMatchObject({ text: "aa b", cursor: 3 });
		const h = editor("aa bb", 5);
		h.engine.handleKey("h", h.key());
		expect(h.state.cursor).toBe(3); // one step back from the last character, not from past it
		const r = editor("aa bb", 5);
		press(r, "rz");
		expect(r.state.text).toBe("aa bz");
		// Only a trailing line break keeps the position: it opens an empty last line,
		// and the offset just past it already is a character position of its own — a
		// `h` there has nowhere to go, which is the whole of "keeps". The engine's
		// side of that modelling difference is pinned by the line-edge tests.
		const brk = editor("ab\n", 3);
		brk.engine.handleKey("h", brk.key());
		expect(brk.state.cursor).toBe(3);
	});
});

describe("+ and - are a line move with beginline after it", () => {
	// `nv_cmds.h:155` binds `+` to `nv_down` and `-` to `nv_up`, each with
	// `beginline(BL_WHITE | BL_FIX)` run after it. So the two halves are separate:
	// `nv_down` refuses when there is no line that way and leaves the caret alone
	// (measured: `+` on the last line does not even move to that line's first
	// non-blank), while a count that merely overshoots clamps, as `j`'s does.
	const B = "  aa\n\n  bb\ncc";
	const press = (e: ReturnType<typeof editor>, keys: string) => {
		for (const ch of keys) e.engine.handleKey(ch, e.key());
	};
	const land = (cursor: number, keys: string) => {
		const e = editor(B, cursor);
		press(e, keys);
		return e.state.cursor;
	};

	test("+ goes down a line and lands on its first non-blank", () => {
		// Line 2 of the buffer is empty, so its "first non-blank" is its own start.
		expect(land(0, "+")).toBe(5);
		expect(land(2, "+")).toBe(5);
		expect(land(3, "+")).toBe(5);
		// And from there, the next `+` is a plain line move.
		expect(land(5, "+")).toBe(8);
		expect(land(7, "+")).toBe(11);
		// A tab counts as blank, and the answer is the tab that opens the line.
		const tab = editor("\taa\n\tbb", 0);
		press(tab, "+");
		expect(tab.state.cursor).toBe(5);
	});

	test("- goes up a line and lands the same way", () => {
		expect(land(5, "-")).toBe(2);
		expect(land(7, "-")).toBe(5);
		expect(land(9, "-")).toBe(5);
		expect(land(12, "-")).toBe(8);
	});

	test("no line that way is not a move, and does not take the line's own spot", () => {
		// The refusal is `nv_down`'s own, before `beginline` runs: a `+` that stepped
		// back onto the last character instead would have answered 10 here.
		expect(land(11, "+")).toBe(11);
		expect(land(12, "+")).toBe(12);
		expect(land(0, "-")).toBe(0);
		// A count that overshoots is a different thing and clamps.
		expect(land(8, "2+")).toBe(11);
		expect(land(12, "2-")).toBe(5);
		// A one-line buffer has no line to move to either way.
		const one = editor("abc", 1);
		press(one, "+");
		expect(one.state.cursor).toBe(1);
		press(one, "-");
		expect(one.state.cursor).toBe(1);
	});

	test("d+ and d- are linewise, and take the span they crossed", () => {
		const down = editor(B, 0);
		press(down, "d+");
		expect(down.state).toMatchObject({ text: "  bb\ncc", cursor: 2 });
		const up = editor(B, 12);
		press(up, "d-");
		expect(up.state).toMatchObject({ text: "  aa\n", cursor: 5 });
		// From the empty line, where the span is two blank lines and nothing else.
		const fromBlank = editor(B, 5);
		press(fromBlank, "d-");
		expect(fromBlank.state).toMatchObject({ text: "  bb\ncc", cursor: 2 });
		// The refusal is the operator's too: `d+` on the last line deletes nothing.
		const stuck = editor(B, 11);
		press(stuck, "d+");
		expect(stuck.state).toMatchObject({ text: B, cursor: 11 });
		// A count of lines, and a change that ends in insert mode.
		const two = editor(B, 0);
		press(two, "2d+");
		expect(two.state.text).toBe("cc");
		const change = editor(B, 5);
		press(change, "c+");
		expect(change.state).toMatchObject({ text: "  aa\n\ncc", cursor: 5 });
	});

	test("a yank's caret follows the landing only when the motion went backwards", () => {
		// `do_pending_operator` pulls the cursor back only when the motion left it
		// before the operator's own start, so `y+` keeps the caret where it was and
		// `y-` takes it to the `beginline` of the line it reached — the last
		// non-blank step, not the column `k` would have wanted (which is column 0,
		// and a blank).
		const down = editor(B, 0);
		press(down, "y+");
		expect(down.state).toMatchObject({ text: B, cursor: 0 });
		const up = editor(B, 12);
		press(up, "y-");
		expect(up.state).toMatchObject({ text: B, cursor: 8 });
		// The shift operators take the same span.
		const shift = editor(B, 0);
		press(shift, ">+");
		expect(shift.state.text).toBe("\t  aa\n\n  bb\ncc");
	});

	test("on a line of nothing but blanks, the caret is a character and not the break", () => {
		// `BL_FIX` is the flag that makes `beginline` stop at the end of a blank line,
		// and `check_cursor_col_win` then steps the column back onto the last
		// character it has. The engine's own end-of-line offset is one past that, and
		// a caret there is a position no command can use.
		const blank = editor("  \nfoo", 3);
		press(blank, "-");
		expect(blank.state.cursor).toBe(1);
		const gg = editor("  \nfoo", 3);
		press(gg, "gg");
		expect(gg.state.cursor).toBe(1);
		const go = editor("foo\n  ", 0);
		press(go, "G");
		expect(go.state.cursor).toBe(5);
		// `I` is the other half of the same question and gets the other answer: it
		// types at the end of the blanks, where a line break is a real position.
		const insert = editor("  \nfoo", 0);
		press(insert, "I");
		insert.type("x");
		expect(insert.state.text).toBe("  x\nfoo");
		// And a linewise paste lands on the last character of a blank line it just
		// wrote, for the same reason the gotos do.
		const paste = editor("  \nfoo", 0);
		press(paste, "yyGp");
		expect(paste.state.cursor).toBe(8);
		// An empty line has no character at all, so it stands on its own break —
		// the one position the engine allows and vim does not.
		const empty = editor("\nfoo", 1);
		press(empty, "-");
		expect(empty.state.cursor).toBe(0);
	});

	test("^ discards the wanted column, as 0, gg and G do", () => {
		// The wanted column is what a `j` returns to, and `^` moves the caret to
		// column 0 — so it has to move the wanted column with it, or `^j` lands on
		// the column the caret was in before the `^`. Measured: vim 9.1 answers 4
		// where a `j` that kept column 1 answers 5, and answers 4 from column 2 as
		// well, where the stale column would say 6.
		const down = editor("abc\ndef", 1);
		press(down, "^j");
		expect(down.state.cursor).toBe(4);
		const fromTwo = editor("abc\ndef", 2);
		press(fromTwo, "^j");
		expect(fromTwo.state.cursor).toBe(4);
		// Upwards is the same rule: the wanted column is not "the column below".
		const up = editor("def\nabc", 5);
		press(up, "^k");
		expect(up.state.cursor).toBe(0);
		// And from the other end — a `$` arms a wanted column past the end of the
		// line, which `^` throws away and `j` then never returns to.
		const armed = editor("abc\ndef", 0);
		press(armed, "$^j");
		expect(armed.state.cursor).toBe(4);
		// `^$` still ends on the last character: `$` arms after the `^`, not before.
		const both = editor("abc\ndef", 1);
		press(both, "^$");
		expect(both.state.cursor).toBe(2);
	});
});

describe("line edges", () => {
	test("dw stops at the line end; a newline is not a word", () => {
		const e = editor("one two\nthree", 4);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("one \nthree"); // no join behind the user's back
	});

	test("cW behaves like cE: the space after the WORD stays", () => {
		const e = editor("foo bar", 0);
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("W", e.key());
		expect(e.state.text).toBe(" bar");
		expect(e.engine.mode).toBe("insert");
	});

	test("d$ on an empty line deletes nothing, but v$d there takes the break", () => {
		const text = "aa\n\nbb";
		const e = editor(text, 3); // the empty line
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.text).toBe(text);
		expect(e.writes()).toBe(0);

		// Visual mode differs, and the probe on vim 9.1 says so: what an empty line
		// has to select is its break, so `v$d` there joins the two lines
		// (`2Gv$d` on "aa\n\nbb" leaves "aa\nbb", while `2Gd$` is still a no-op).
		const v = editor(text, 3);
		v.engine.handleKey("v", v.key());
		v.engine.handleKey("$", v.key());
		expect(v.engine.selection).toEqual({ start: 3, end: 4 }); // the break itself
		v.engine.handleKey("d", v.key());
		expect(v.state.text).toBe("aa\nbb");
		expect(v.engine.mode).toBe("normal");
	});

	test("dd on the last line leaves the cursor on the landing line's first non-blank", () => {
		const e = editor("one\ntwo", 4);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("one"); // not "one\n": the last line is gone
		// vim puts the caret on the first non-blank of the line that takes the
		// deleted block's place — "one" here, not the character it was nearest to.
		expect(e.state.cursor).toBe(0);
	});

	test("cc on the last line inserts on the empty line it leaves", () => {
		const e = editor("one\ntwo", 4);
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("c", e.key());
		expect(e.state.text).toBe("one\n");
		expect(e.state.cursor).toBe(4); // the empty line's own position
		e.type("X");
		expect(e.state.text).toBe("one\nX"); // typed on that line, not over it
	});
});

describe("an empty line is a line of its own", () => {
	// `nextChar` steps over a line break like any other character, which is what a
	// motion wants and what an insertion point must not do: on an empty line the
	// caret sits *on* the break, and vim keeps the text on that line rather than
	// dropping it onto the one below (`jaX<Esc>` on "x\n\ny\n" gives "x\nX\ny\n",
	// and `yl2Gp` gives "x\nx\ny\n" — vim 9.1, differential probe).
	test("a types on the empty line it is on, not on the one below", () => {
		const e = editor("x\n\ny\n", 0);
		e.engine.handleKey("j", e.key());
		expect(e.state.cursor).toBe(2); // the empty line's own break
		e.engine.handleKey("a", e.key());
		expect(e.state.cursor).toBe(2); // `a` on an empty line is `i`
		e.type("X");
		e.engine.handleKey("", e.key({ escape: true }));
		expect(e.state.text).toBe("x\nX\ny\n");
	});

	test("a charwise p pastes onto that line too, and P always did", () => {
		const e = editor("x\n\ny\n", 0);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("l", e.key()); // yank "x"
		e.engine.handleKey("j", e.key()); // onto the empty line
		e.engine.handleKey("p", e.key());
		expect(e.state.text).toBe("x\nx\ny\n");
		expect(e.state.cursor).toBe(2); // on the character it pasted

		// `P` inserts before the caret and never had to step over the break.
		const before = editor("x\n\ny\n", 0);
		before.engine.handleKey("y", before.key());
		before.engine.handleKey("l", before.key());
		before.engine.handleKey("j", before.key());
		before.engine.handleKey("P", before.key());
		expect(before.state.text).toBe("x\nx\ny\n");
		expect(before.state.cursor).toBe(2);
	});
});

describe("a code point is one character", () => {
	const emoji = "😀"; // one code point, two UTF-16 units

	test("x and X take the whole pair", () => {
		const forward = editor(`a${emoji}b`, 1);
		forward.engine.handleKey("x", forward.key());
		expect(forward.state.text).toBe("ab");

		const back = editor(`a${emoji}b`, 3);
		back.engine.handleKey("X", back.key());
		expect(back.state.text).toBe("ab");
	});

	test("motions never stop inside a pair", () => {
		const e = editor(`a${emoji}b`, 0);
		e.engine.handleKey("l", e.key());
		expect(e.state.cursor).toBe(1);
		e.engine.handleKey("l", e.key());
		expect(e.state.cursor).toBe(3); // over the pair, in one step
		e.engine.handleKey("h", e.key());
		expect(e.state.cursor).toBe(1);

		const word = editor("x😀 y", 0);
		word.engine.handleKey("e", word.key());
		expect(word.state.cursor).toBe(1); // the pair's lead unit, never its tail
	});

	test("e from the pair the caret stands on walks on past it", () => {
		// The step off the caret is a character too, not a unit: `pos + 1` lands on
		// the tail, which the landing snap puts back on the pair's lead — so `e`
		// would stay on the emoji instead of moving on. vim 9.1, `e` at the start of
		// "😀 b", leaves the caret in column 6 — the `b`.
		const e = editor("😀 b", 0);
		e.engine.handleKey("e", e.key());
		expect(e.state.cursor).toBe(3);
	});

	test("r replaces the whole pair; ~ leaves an uncased one alone", () => {
		const r = editor(`${emoji}x`, 0);
		r.engine.handleKey("r", r.key());
		r.engine.handleKey("z", r.key());
		expect(r.state.text).toBe("zx");

		const tilde = editor(`${emoji}x`, 0);
		tilde.engine.handleKey("~", tilde.key());
		expect(tilde.state.text).toBe(`${emoji}x`);
		expect(tilde.state.cursor).toBe(2); // the caret moved, the text did not
		expect(tilde.writes()).toBe(0);
	});

	test("a lands after the pair, not inside it", () => {
		const e = editor(`a${emoji}b`, 1);
		e.engine.handleKey("a", e.key());
		expect(e.engine.mode).toBe("insert");
		expect(e.state.cursor).toBe(3);
		e.type("Z");
		expect(e.state.text).toBe(`a${emoji}Zb`);
	});
});

/**
 * What a word motion is a word *of*.
 *
 * Every expectation here is one real vim, measured in
 * `test/vim-differential/regress.mjs` — which also holds the class table itself
 * against vim's own `charclass()` over all 1,114,112 code points
 * (`vim-differential/class.mjs`), so these are the motions over that table
 * rather than a second opinion about the table.
 */
describe("a word is a word outside ASCII too", () => {
	test("Latin-1 letters are letters: iskeyword's 192-255 range", () => {
		// `dw` used to stop after three characters of `café` — `é` was punctuation
		// to a `/\w/` test — and leave `é Ünïcödé` behind.
		const e = editor("café naïve wörd", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("naïve wörd");

		const mid = editor("café naïve wörd", 2);
		mid.engine.handleKey("e", mid.key());
		expect(mid.state.cursor).toBe(3); // on the accented letter, not before it
	});

	test("the @ filter adds µ below 192 and nothing else there", () => {
		// `µ` has a case mapping in Greek, so `MB_ISLOWER` accepts it. `ª` and `º`
		// have none in either direction and are punctuation — which is why this
		// pair has to be adjacent: with a space between them every one of them is
		// its own word whichever class it gets.
		const e = editor("µª x", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("ª x");

		const back = editor("ªµ x", 0);
		back.engine.handleKey("d", back.key());
		back.engine.handleKey("w", back.key());
		expect(back.state.text).toBe("µ x");
	});

	test("a script is a class: hiragana, katakana and hanzi are three words", () => {
		const e = editor("かなカナ漢字", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("カナ漢字");

		// …and a run of hanzi has no transition in it, which is why Chinese was
		// never wrong here and Japanese was.
		const zh = editor("你好世界 abc", 0);
		zh.engine.handleKey("d", zh.key());
		zh.engine.handleKey("w", zh.key());
		expect(zh.state.text).toBe("abc");
	});

	test("W folds all three scripts into one WORD", () => {
		const e = editor("かなカナ漢字", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("W", e.key());
		expect(e.state.text).toBe("");
	});

	test("an emoji is a class of its own, ahead of the class table", () => {
		// `€` at U+20AC and `\u{1f44d}` at U+1F44D both sit inside the same
		// punctuation interval, so without the table that is asked first they would
		// be one run and `dw` would take both.
		const e = editor("€\u{1f44d} x", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("\u{1f44d} x");
	});

	test("a code point no interval lists is a word character", () => {
		// The last line of `utf_class_buf`: "most other characters are 'word'
		// characters". `ß`, `ж` and `λ` are all in it, and each is one word with
		// the ASCII letters beside it.
		const e = editor("жabc x", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("x");
	});

	test("a combining mark rides on the letter before it", () => {
		// The same word as the precomposed `école` above, written `e` + U+0301.
		// Vim counts the mark as its own character, so a motion that called it
		// punctuation would stop between the letter and its accent.
		const e = editor("école x", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("x");
	});

	test("a no-break space is white space to w and to W alike", () => {
		const w = editor("a b c", 0);
		w.engine.handleKey("d", w.key());
		w.engine.handleKey("w", w.key());
		expect(w.state.text).toBe("b c");

		const W = editor("a b c", 0);
		W.engine.handleKey("d", W.key());
		W.engine.handleKey("W", W.key());
		expect(W.state.text).toBe("b c");
	});

	test("a line break is white space, though vim has no character to ask about", () => {
		// The one code point this table parts company with `charclass()` on, and
		// for a reason that is about this engine rather than about the table: a
		// vim buffer has no line-break character, while this one's buffer is a
		// single string with `\n` in it. Called punctuation, `w` would stop on the
		// last character of a line instead of crossing to the next one.
		const e = editor("ab\ncd", 1);
		e.engine.handleKey("w", e.key());
		expect(e.state.cursor).toBe(3); // the `c`, having crossed the break

		const d = editor("ab\ncd", 0);
		d.engine.handleKey("d", d.key());
		d.engine.handleKey("w", d.key());
		expect(d.state.text).toBe("\ncd");
	});

	test("a carriage return and a form feed are punctuation, like vim's", () => {
		// `VIM_ISWHITE` is spelled space or tab and nothing else, so unlike a
		// line break these two do not get the exemption above.
		const e = editor("a\rb c", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("\rb c");
	});
});

describe("one command is one undo step", () => {
	test("cc and 3J write once, not once per line", () => {
		const cc = editor("aa\nbb\ncc", 4);
		cc.engine.handleKey("c", cc.key());
		cc.engine.handleKey("c", cc.key());
		expect(cc.state.text).toBe("aa\n\ncc");
		expect(cc.writes()).toBe(1);

		const j = editor("one\ntwo\nthree", 0);
		j.engine.handleKey("3", j.key());
		j.engine.handleKey("J", j.key());
		expect(j.state.text).toBe("one two three");
		expect(j.writes()).toBe(1);
	});

	test("an edit that changes nothing records nothing", () => {
		// A snapshot that changed nothing would clear the host's redo stack.
		const digit = editor("1x", 0);
		digit.engine.handleKey("~", digit.key());
		expect(digit.state.cursor).toBe(1);
		expect(digit.writes()).toBe(0);

		const end = editor("ab\n\ncd", 3); // the empty line
		end.engine.handleKey("x", end.key());
		expect(end.writes()).toBe(0);
	});
});

describe("visual mode polish", () => {
	test("v and V share one anchor", () => {
		const e = editor("one\ntwo\nthree", 0);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("j", e.key());
		e.engine.handleKey("V", e.key());
		expect(e.engine.selection).toEqual({ start: 0, end: 8 }); // both lines
	});

	test("u, U and ~ recase the selection and exit", () => {
		const lower = editor("one\nTWO", 0);
		lower.engine.handleKey("V", lower.key());
		lower.engine.handleKey("j", lower.key());
		lower.engine.handleKey("u", lower.key());
		expect(lower.state.text).toBe("one\ntwo");
		expect(lower.engine.mode).toBe("normal");

		const toggle = editor("aB\ncd", 0);
		toggle.engine.handleKey("V", toggle.key());
		toggle.engine.handleKey("j", toggle.key());
		toggle.engine.handleKey("~", toggle.key());
		expect(toggle.state.text).toBe("Ab\nCD");

		const none = editor("12\n34", 0);
		none.engine.handleKey("V", none.key());
		none.engine.handleKey("j", none.key());
		none.engine.handleKey("U", none.key());
		expect(none.writes()).toBe(0); // no cased characters, no edit
		expect(none.engine.mode).toBe("normal");
	});

	test("charwise paste leaves the caret on the last pasted character", () => {
		const e = editor("abcd efgh", 0);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("e", e.key()); // yank "abcd"
		e.engine.handleKey("$", e.key());
		e.engine.handleKey("p", e.key());
		expect(e.state.text).toBe("abcd efghabcd");
		expect(e.state.cursor).toBe(12); // 'd' of the pasted run
	});
});

/**
 * A visual selection can end *past* the line's last character, and then it takes
 * the line break: `vld` at a line end joins the two lines, while a `vl` that
 * merely arrived on that character does not. What arms that reach — `$`, a `|`
 * whose column is past the line, and an `l` that had nowhere left to go — and
 * what clears it, is vim's own behaviour, read off `'<`/`'>` after Esc on vim
 * 9.1 (see the differential cases in the batch's notes).
 */
describe("a selection's reach past a line's end", () => {
	test("a blocked l takes the break; arriving on the character does not", () => {
		const blocked = editor("aa\nbb", 0);
		blocked.engine.handleKey("v", blocked.key());
		blocked.engine.handleKey("l", blocked.key());
		blocked.engine.handleKey("l", blocked.key()); // nowhere left to go
		blocked.engine.handleKey("d", blocked.key());
		expect(blocked.state.text).toBe("bb"); // "aa\n" — the lines joined

		const arrived = editor("aa\nbb", 0);
		arrived.engine.handleKey("v", arrived.key());
		arrived.engine.handleKey("l", arrived.key()); // onto the last character
		arrived.engine.handleKey("d", arrived.key());
		expect(arrived.state.text).toBe("\nbb"); // the same characters, but not the break
	});

	test("$ reaches past the line it aims at", () => {
		const e = editor("aa\nbb", 0);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.engine.selection).toEqual({ start: 0, end: 3 }); // "aa" and the break
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("bb");
	});

	test("| past the line's length reaches, up to it does not", () => {
		const past = editor("ab\ncd", 1);
		past.engine.handleKey("v", past.key());
		past.engine.handleKey("9", past.key());
		past.engine.handleKey("|", past.key());
		past.engine.handleKey("d", past.key());
		expect(past.state.text).toBe("acd"); // "b\n" — the reach took the break

		const within = editor("ab\ncd", 1);
		within.engine.handleKey("v", within.key());
		within.engine.handleKey("2", within.key());
		within.engine.handleKey("|", within.key()); // column 2 is the last character
		within.engine.handleKey("d", within.key());
		expect(within.state.text).toBe("a\ncd");
	});

	test("h spends the reach before it moves the caret", () => {
		const e = editor("aa\nbb", 0);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.engine.selection).toEqual({ start: 0, end: 3 });

		// The first `h` puts the end back on the line's last character; the caret
		// does not move (vim: `'>` goes from column len+1 to column len).
		e.engine.handleKey("h", e.key());
		expect(e.engine.selection).toEqual({ start: 0, end: 2 });
		e.engine.handleKey("h", e.key());
		expect(e.engine.selection).toEqual({ start: 0, end: 1 });

		const counted = editor("aa\nbb", 0);
		counted.engine.handleKey("v", counted.key());
		counted.engine.handleKey("$", counted.key());
		counted.engine.handleKey("2", counted.key());
		counted.engine.handleKey("h", counted.key()); // one step spent, one taken
		expect(counted.engine.selection).toEqual({ start: 0, end: 1 });
	});

	test("h and l move inside a selection", () => {
		// `h` is a motion like `l`: a short-circuit in the reach bookkeeping used to
		// leave the caret where it was, so `vehd` deleted one character too many.
		const e = editor("ab\ncd", 1);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("e", e.key());
		expect(e.engine.selection).toEqual({ start: 1, end: 5 }); // "b\ncd"
		e.engine.handleKey("h", e.key());
		expect(e.engine.selection).toEqual({ start: 1, end: 4 }); // "b\nc"
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("ad");
	});

	test("j and k carry the reach onto the line they land on", () => {
		const e = editor("aa\nbb", 3);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("$", e.key());
		e.engine.handleKey("k", e.key());
		expect(e.engine.selection).toEqual({ start: 2, end: 4 }); // up onto "aa", reach and all

		// `h` spends the reach of the line it moved up onto.
		e.engine.handleKey("h", e.key());
		expect(e.engine.selection).toEqual({ start: 1, end: 4 });
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("ab");
	});
});

/**
 * `cw` is not `dw` with a `c`: on a non-blank it stops at the end of the word
 * the caret is on, keeping the whitespace after it — and at that word's last
 * character it changes just that character, where `ce` walks on to the next
 * word. A count is a plain `Ne` again, so `c2w` takes the next word too. All of
 * it probed on vim 9.1.
 */
describe("cw stops at the end of the word the caret is on", () => {
	test("cw at a word's last character changes one character", () => {
		const e = editor("one two three", 6); // the 'o' of "two"
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("one tw three");
		expect(e.engine.mode).toBe("insert");
		expect(e.state.cursor).toBe(6); // the cut point is where the insert opens
	});

	test("ce keeps the plain e motion and walks on", () => {
		const e = editor("one two three", 6);
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("e", e.key());
		expect(e.state.text).toBe("one tw");
	});

	test("a count is a plain Ne", () => {
		const e = editor("one two three", 6);
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("one tw");
	});

	test("cW stops at the end of the WORD", () => {
		const e = editor("one.two", 2); // the "one" of the single WORD "one.two"
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("W", e.key());
		expect(e.state.text).toBe("on");
	});

	test("cw never takes the break after the word", () => {
		const e = editor("ab\ncd", 1); // the last character of the line
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("w", e.key());
		expect(e.state.text).toBe("a\ncd"); // not "a" — the lines stay apart
		expect(e.state.cursor).toBe(1);
	});
});

/**
 * The two editing keys vim also binds. They used to reach the host from NORMAL
 * mode, where Backspace erased the character behind the caret — an edit no modal
 * editor makes from a movement key. Expected values here come from vim 9.1
 * (`-u NONE -N -s keys.bin`), the same way as the other differential cases.
 */
describe("Backspace and Delete in NORMAL mode", () => {
	test("Backspace is a motion: it moves and edits nothing", () => {
		const e = editor("abcdef", 3);
		expect(e.engine.handleKey("", e.key({ backspace: true }))).toBe(true);
		expect(e.state.text).toBe("abcdef");
		expect(e.state.cursor).toBe(2);
		expect(e.writes()).toBe(0);
	});

	test("Delete is x: it removes the character under the caret", () => {
		const e = editor("abcdef", 3);
		expect(e.engine.handleKey("", e.key({ delete: true }))).toBe(true);
		expect(e.state.text).toBe("abcef");
		expect(e.state.cursor).toBe(3);
	});

	test("a count reaches Backspace, and <Del> takes a digit of it", () => {
		const back = editor("abcdef", 4);
		back.engine.handleKey("2", back.key());
		back.engine.handleKey("", back.key({ backspace: true }));
		expect(back.state.cursor).toBe(2);

		// `<Del>` is not `x` while a count is being typed: it divides the count by
		// ten and waits for the command (normal.c:239).
		const del = editor("abcdef", 1);
		del.engine.handleKey("2", del.key());
		del.engine.handleKey("", del.key({ delete: true }));
		expect(del.state.text).toBe("abcdef");
		expect(del.state.cursor).toBe(1);
		expect(del.writes()).toBe(0);
	});

	test("insert mode leaves both keys to the host", () => {
		// The host's own editing already does the right thing there; consuming the
		// key would leave backspace dead while typing.
		const e = editor("abcdef", 3);
		e.engine.handleKey("i", e.key());
		expect(e.engine.handleKey("", e.key({ backspace: true }))).toBe(false);
		expect(e.engine.handleKey("", e.key({ delete: true }))).toBe(false);
	});

	test("Backspace wraps onto the previous line, h does not", () => {
		const e = editor("ab\ncdef\ngh", 3); // first character of line 2
		e.engine.handleKey("h", e.key());
		expect(e.state.cursor).toBe(3); // h stops at the line start
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.state.cursor).toBe(1); // vim's default whichwrap: line 1's last character
	});

	test("an empty line above is a stop of its own", () => {
		const e = editor("ab\n\ncd", 4); // first character of line 3
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.state.cursor).toBe(3); // the empty line, standing on its own break
	});

	test("d<BS> is dh, and at a line start it joins the two lines", () => {
		const mid = editor("ab\ncdef\ngh", 4);
		mid.engine.handleKey("d", mid.key());
		mid.engine.handleKey("", mid.key({ backspace: true }));
		expect(mid.state.text).toBe("ab\ndef\ngh"); // the character before the caret

		const edge = editor("ab\ncdef\ngh", 3);
		edge.engine.handleKey("d", edge.key());
		edge.engine.handleKey("", edge.key({ backspace: true }));
		expect(edge.state.text).toBe("abcdef\ngh"); // the line break, and only it
		expect(edge.state.cursor).toBe(2);
	});

	test("2d<BS> takes the operator's count", () => {
		const e = editor("abcdefgh", 5);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.state.text).toBe("abcfgh");
		expect(e.state.cursor).toBe(3);
	});

	test("d<Del> drops the operator without touching the text", () => {
		// Delete is not a motion: vim abandons the pending operator entirely.
		const e = editor("abcdef", 3);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("", e.key({ delete: true }));
		expect(e.state.text).toBe("abcdef");
		expect(e.state.cursor).toBe(3);
		expect(e.writes()).toBe(0);
	});

	test("both keys cancel a half-typed r or f", () => {
		// Not characters to search for or replace with — vim drops the command.
		const replace = editor("abc", 1);
		replace.engine.handleKey("r", replace.key());
		replace.engine.handleKey("", replace.key({ delete: true }));
		replace.engine.handleKey("x", replace.key());
		expect(replace.state.text).toBe("ac"); // `x`, not `r` with a weird target

		const find = editor("abcdef", 3);
		find.engine.handleKey("f", find.key());
		find.engine.handleKey("", find.key({ backspace: true }));
		find.engine.handleKey("x", find.key());
		expect(find.state.text).toBe("abcef");
	});
});

describe("Backspace and Delete in visual mode", () => {
	test("Backspace steps the head one character along the line", () => {
		const e = editor("ab\ncdef\ngh", 4);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.engine.selection).toEqual({ start: 3, end: 5 });
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("ab\nef\ngh");
	});

	test("visual Backspace at a line start wraps and takes the break", () => {
		// Not a plain `h` there: vim's default whichwrap carries the end onto the
		// line above, one column past its last character, so the delete takes the
		// break with it — `v<BS>d` at a line start joins the two lines.
		const e = editor("ab\ncdef\ngh", 3);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.engine.selection).toEqual({ start: 2, end: 4 });
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("abdef\ngh");
	});

	test("Delete cuts the selection outright", () => {
		const e = editor("ab\ncdef\ngh", 4);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("", e.key({ delete: true }));
		expect(e.state.text).toBe("ab\ncef\ngh");
		expect(e.engine.mode).toBe("normal");
	});
});

/**
 * The wrapping pair inside a selection, read off vim 9.1 key by key (the same
 * differential harness that feeds the other cases: one `feedkeys(..., 'x')` call
 * per command, `-u NONE -N`, `whichwrap` at its default `b,s`).
 *
 * `<BS>` is vim's own binding, not `h`: it wraps off the front of the line, and
 * the end it lands on stands one column past the line above's last character —
 * the reach `$` arms — so `v<BS>d` at a line start takes the break with it. A
 * step of an already-armed end is spent on that reach instead: the end comes back
 * onto the character without the caret moving, which is why `v<BS><BS>d` deletes
 * one character more than `v<BS>d` and not two.
 *
 * `<Space>` is the forward twin. It moves like `l`; it does *not* type a space
 * into the buffer, and it is *not* a no-op: at the line's last character it stops
 * there and arms the reach (the break then goes with the delete), and from an
 * armed end — or from an empty line's break — it wraps onto the next line.
 */
describe("visual <BS> and <Space> wrap like vim's whichwrap", () => {
	/** "one two\nthird" with the caret on line 2, column 1 (buffer index 8). */
	const second = () => editor("one two\nthird", 8);

	test("v<BS>d takes the break above: one character and the line join", () => {
		const e = second();
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.engine.selection).toEqual({ start: 7, end: 9 });
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("one twohird"); // "\nt", not just "t"
		expect(e.state.cursor).toBe(7);
	});

	test("a second <BS> spends the reach before it steps: v<BS><BS>d", () => {
		const e = second();
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		e.engine.handleKey("", e.key({ backspace: true }));
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("one twhird"); // "o\nt": one character more
		expect(e.state.cursor).toBe(6);
	});

	test("the count form is the same command: v2<BS>d", () => {
		const e = second();
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("one twhird");
		expect(e.state.cursor).toBe(6);
	});

	test("h spends the reach the <BS> left armed, and does not move", () => {
		const e = second();
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		e.engine.handleKey("h", e.key());
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("one twhird");
	});

	test("l at the armed end is blocked, so the break stays: v<BS>l d", () => {
		// The end stands past the last character; `l` has nowhere to go, and a
		// blocked `l` leaves the reach armed and the caret where it was.
		const e = second();
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		e.engine.handleKey("l", e.key());
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("one twohird");
		expect(e.state.cursor).toBe(7);
	});

	test("<Space> moves like l inside a line, and wraps from the armed end", () => {
		const moved = second();
		moved.engine.handleKey("v", moved.key());
		moved.engine.handleKey(" ", moved.key());
		expect(moved.engine.selection).toEqual({ start: 8, end: 10 });
		moved.engine.handleKey("d", moved.key());
		expect(moved.state.text).toBe("one two\nird"); // "th", not "t"

		const twice = second();
		twice.engine.handleKey("v", twice.key());
		twice.engine.handleKey(" ", twice.key());
		twice.engine.handleKey(" ", twice.key());
		twice.engine.handleKey("d", twice.key());
		expect(twice.state.text).toBe("one two\nrd");

		// After the wrapping <BS> the end is armed, so the next <Space> wraps back
		// down onto line 2 — the caret does not stay put on the line above.
		const wrapped = second();
		wrapped.engine.handleKey("v", wrapped.key());
		wrapped.engine.handleKey("", wrapped.key({ backspace: true }));
		wrapped.engine.handleKey(" ", wrapped.key());
		wrapped.engine.handleKey("d", wrapped.key());
		expect(wrapped.state.text).toBe("one two\nhird");
	});

	test("<Space> at a line end arms the reach rather than wrapping", () => {
		const e = editor("aa\nbb", 1);
		e.engine.handleKey("v", e.key());
		e.engine.handleKey(" ", e.key());
		expect(e.engine.selection).toEqual({ start: 1, end: 3 });
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("abb");
	});

	test("V<BS>d takes the line above with the current one", () => {
		const e = second();
		e.engine.handleKey("V", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("");
	});

	test("at the buffer start the <BS> is blocked and takes one character", () => {
		// There is no character behind the caret and no line above it, so the step
		// is blocked — and a step that took the caret nowhere does not arm the
		// reach the way a blocked `l` does: the selection stays on the character
		// under the caret, and the break after it is left alone.
		const e = editor("o\nthird", 2);
		e.engine.handleKey("g", e.key());
		e.engine.handleKey("g", e.key());
		e.engine.handleKey("v", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.engine.selection).toEqual({ start: 0, end: 1 });
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("\nthird");
	});

	test("three lines: each <BS> spends, steps, or wraps in turn", () => {
		// "aa\nbb\ncc" with the caret on line 3: the first <BS> wraps (deleting
		// "c" and the break), the second spends (deleting "b" as well), the third
		// steps off "b" (deleting the whole second line), the fourth wraps once
		// more — which is why 4<BS> reaches one character further than 3<BS>.
		const three = (backspaces: number) => {
			const e = editor("aa\nbb\ncc", 6);
			e.engine.handleKey("v", e.key());
			for (let i = 0; i < backspaces; i++) e.engine.handleKey("", e.key({ backspace: true }));
			e.engine.handleKey("d", e.key());
			return e.state.text;
		};
		expect(three(1)).toBe("aa\nbbc");
		expect(three(2)).toBe("aa\nbc");
		expect(three(3)).toBe("aa\nc");
		expect(three(4)).toBe("aac");

		const counted = editor("aa\nbb\ncc", 6);
		counted.engine.handleKey("v", counted.key());
		counted.engine.handleKey("4", counted.key());
		counted.engine.handleKey("", counted.key({ backspace: true }));
		counted.engine.handleKey("d", counted.key());
		expect(counted.state.text).toBe("aac");

		const linewise = editor("aa\nbb\ncc", 3); // line 2, linewise
		linewise.engine.handleKey("V", linewise.key());
		linewise.engine.handleKey("", linewise.key({ backspace: true }));
		linewise.engine.handleKey("d", linewise.key());
		expect(linewise.state.text).toBe("cc");
	});

	test("an empty line's break is stepped over, not spent", () => {
		// The break *is* the empty line, so there is no character standing past it
		// to give back: <BS> wraps onto the line above like anywhere else (and a
		// `<BS>` after a `$` there still wraps — the armed column has no character
		// under it to spend).
		const wrapped = editor("aa\n\nbb", 3);
		wrapped.engine.handleKey("v", wrapped.key());
		wrapped.engine.handleKey("", wrapped.key({ backspace: true }));
		wrapped.engine.handleKey("d", wrapped.key());
		expect(wrapped.state.text).toBe("aabb");

		const twice = editor("aa\n\nbb", 3);
		twice.engine.handleKey("v", twice.key());
		twice.engine.handleKey("", twice.key({ backspace: true }));
		twice.engine.handleKey("", twice.key({ backspace: true }));
		twice.engine.handleKey("d", twice.key());
		expect(twice.state.text).toBe("abb");

		const thenL = editor("aa\n\nbb", 3);
		thenL.engine.handleKey("v", thenL.key());
		thenL.engine.handleKey("", thenL.key({ backspace: true }));
		thenL.engine.handleKey("l", thenL.key());
		thenL.engine.handleKey("d", thenL.key());
		expect(thenL.state.text).toBe("aabb");

		const armed = editor("aa\n\nbb", 3);
		armed.engine.handleKey("v", armed.key());
		armed.engine.handleKey("$", armed.key());
		armed.engine.handleKey("", armed.key({ backspace: true }));
		armed.engine.handleKey("d", armed.key());
		expect(armed.state.text).toBe("aabb");

		// <Space> from the same break wraps onto the line below instead.
		const down = editor("aa\n\nbb", 3);
		down.engine.handleKey("v", down.key());
		down.engine.handleKey(" ", down.key());
		expect(down.engine.selection).toEqual({ start: 3, end: 5 });
		down.engine.handleKey("d", down.key());
		expect(down.state.text).toBe("aa\nb");
	});

	test("the last line has no break to give up, but still spends the reach", () => {
		// `v$h` on the last line puts the end back on the last character without
		// moving the caret: the whole line stays selected (`v$hd` takes it), where
		// on a line with a break below it the same `h` is what keeps the break out.
		const last = editor("aa\nbb", 3);
		last.engine.handleKey("v", last.key());
		last.engine.handleKey("$", last.key());
		last.engine.handleKey("h", last.key());
		last.engine.handleKey("d", last.key());
		expect(last.state.text).toBe("aa\n");

		const only = editor("aa", 0);
		only.engine.handleKey("v", only.key());
		only.engine.handleKey("$", only.key());
		only.engine.handleKey("h", only.key());
		only.engine.handleKey("d", only.key());
		expect(only.state.text).toBe("");
	});

	test("a j carries the wanted column, and arms the reach when it cannot fill it", () => {
		// The wrapping <BS> leaves the wanted column one past the line it landed
		// on, so a following `j` arms the reach again on a shorter line (the break
		// goes with the delete) and lands one column further right on a wider one.
		const arming = editor("one two\nthird\na long line here", 8);
		arming.engine.handleKey("v", arming.key());
		arming.engine.handleKey("", arming.key({ backspace: true }));
		arming.engine.handleKey("", arming.key({ backspace: true }));
		arming.engine.handleKey("j", arming.key());
		arming.engine.handleKey("d", arming.key());
		expect(arming.state.text).toBe("one two\na long line here");

		const wide = editor("one two\nthird\na long line here", 8);
		wide.engine.handleKey("v", wide.key());
		wide.engine.handleKey("", wide.key({ backspace: true }));
		wide.engine.handleKey("j", wide.key());
		wide.engine.handleKey("j", wide.key());
		wide.engine.handleKey("d", wide.key());
		expect(wide.state.text).toBe("one two\nine here");

		// A `j` of its own onto a line whose last character is left of the caret
		// arms it too: `vjd` from column 6 of the line above takes both the `f` and
		// the whole short line, not just the `f`.
		const plain = editor("abcdef\naa", 5);
		plain.engine.handleKey("v", plain.key());
		plain.engine.handleKey("j", plain.key());
		plain.engine.handleKey("d", plain.key());
		expect(plain.state.text).toBe("abcde");
	});
});

/**
 * Every expectation in this block was read off real vim 9.1
 * (`vim -u NONE -N -i NONE -n --not-a-term`), not derived from the engine.
 */
describe("linewise deletes: landing line and counts past the buffer", () => {
	test("dd lands on the first non-blank of the line that takes the block's place", () => {
		const e = editor("ab\n  cd\nef", 8);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("ab\n  cd");
		expect(e.state.cursor).toBe(5); // 'c', not the line start at 3
	});

	test("the line above can be indented too", () => {
		const e = editor("  ab\n  cd\n  ef", 5);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("d", e.key());
		expect(e.state.text).toBe("  ab\n  ef");
		expect(e.state.cursor).toBe(7);
	});

	test("a range covering every line empties the buffer", () => {
		// The whole-buffer case has no line break in front of it to remove, and
		// removing from the buffer end instead was a delete that did nothing.
		const whole: Array<[number, string[]]> = [
			[0, ["d", "G"]], // from the first line
			[3, ["d", "g", "g"]], // from the last one
		];
		for (const [cursor, keys] of whole) {
			const e = editor("ab\ncd", cursor);
			for (const k of keys) e.engine.handleKey(k, e.key());
			expect(e.state.text).toBe("");
			expect(e.state.cursor).toBe(0);
		}
		const single = editor("abc", 1);
		single.engine.handleKey("d", single.key());
		single.engine.handleKey("G", single.key());
		expect(single.state.text).toBe("");
	});

	test("a forward count past the end clamps instead of doing nothing", () => {
		const e = editor("ab\n\ncd", 0);
		e.engine.handleKey("5", e.key());
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("j", e.key());
		expect(e.state.text).toBe("");
	});

	test("a backward count past the top clamps too", () => {
		const e = editor("ab\n\ncd", 5);
		e.engine.handleKey("5", e.key());
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("k", e.key());
		expect(e.state.text).toBe("");
		const inner = editor("ab\ncd\nef\ngh", 3);
		inner.engine.handleKey("5", inner.key());
		inner.engine.handleKey("d", inner.key());
		inner.engine.handleKey("k", inner.key());
		expect(inner.state.text).toBe("ef\ngh");
		expect(inner.state.cursor).toBe(0);
	});

	test("a motion that cannot move is still not a delete", () => {
		// `dj` on the last line has nowhere to go, and vim does not fall back to
		// deleting the line the caret is already on.
		const last = editor("ab\n\ncd", 4);
		last.engine.handleKey("d", last.key());
		last.engine.handleKey("j", last.key());
		expect(last.state.text).toBe("ab\n\ncd");
		expect(last.writes()).toBe(0);
		const over = editor("ab\n\ncd", 4);
		over.engine.handleKey("5", over.key());
		over.engine.handleKey("d", over.key());
		over.engine.handleKey("j", over.key());
		expect(over.state.text).toBe("ab\n\ncd");
		expect(over.writes()).toBe(0);
	});

	test("2dd with only the caret's own line left takes nothing", () => {
		// vim refuses the count rather than falling back to the one line it could
		// have taken; `2dj` from the same place does clamp (see the test above).
		const only = editor("abc", 1);
		only.engine.handleKey("2", only.key());
		only.engine.handleKey("d", only.key());
		only.engine.handleKey("d", only.key());
		expect(only.state.text).toBe("abc");
		expect(only.writes()).toBe(0);
		const atEnd = editor("ab\n\ncd", 4);
		atEnd.engine.handleKey("2", atEnd.key());
		atEnd.engine.handleKey("d", atEnd.key());
		atEnd.engine.handleKey("d", atEnd.key());
		expect(atEnd.state.text).toBe("ab\n\ncd");
		// One line further up there is something to take, and it clamps to it.
		const mid = editor("ab\n\ncd", 3);
		mid.engine.handleKey("2", mid.key());
		mid.engine.handleKey("d", mid.key());
		mid.engine.handleKey("d", mid.key());
		expect(mid.state.text).toBe("ab");
	});
});

describe("linewise yanks leave the caret where vim's motion left it", () => {
	test("yy does not move the caret at all", () => {
		const e = editor("  ab\ncd", 3);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("y", e.key());
		expect(e.state.text).toBe("  ab\ncd");
		expect(e.state.cursor).toBe(3); // not the line start at 0
	});

	test("yk carries the column onto the line above", () => {
		const e = editor("  ab\n  cd", 8);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("k", e.key());
		expect(e.state.cursor).toBe(3); // line 1, same column as before
	});

	test("ygg lands on the first non-blank of the line it reaches", () => {
		const e = editor("  ab\ncd", 5);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("g", e.key());
		e.engine.handleKey("g", e.key());
		expect(e.state.cursor).toBe(2);
	});

	test("y<BS> at a line start settles off the line break it reaches", () => {
		// The yank range starts on the newline; a NORMAL cursor stands on a
		// character, so it lands on the last one of the line above.
		const e = editor("a\nbc\ndef", 5);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.state.text).toBe("a\nbc\ndef");
		expect(e.state.cursor).toBe(3);
	});

	test("y<BS> inside a line stays on the character it reached", () => {
		const e = editor("a\nbc\ndef", 6);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.state.cursor).toBe(5);
	});

	test("a motion that went forward pulls the caret back to the yank's start", () => {
		// do_pending_operator's pull-back only applies when the motion ended past
		// where it began, so `yG` and `y2j` leave the caret under the `y` — and it
		// is that column the next `j` comes back to (probed on vim 9.1).
		const forward = ["y", "G"];
		const wide = editor("abcdef\ngh\nijkl", 4);
		for (const k of forward) wide.engine.handleKey(k, wide.key());
		expect(wide.state.cursor).toBe(4);

		const counted = editor("abcdef\ngh\nijkl", 4);
		counted.engine.handleKey("y", counted.key());
		counted.engine.handleKey("2", counted.key());
		counted.engine.handleKey("j", counted.key());
		expect(counted.state.cursor).toBe(4);
		counted.engine.handleKey("j", counted.key());
		expect(counted.state.cursor).toBe(8); // column 4 of line 2, clamped to its end
	});

	test("a backward motion keeps its landing", () => {
		const e = editor("abcdef\ngh\nijkl", 8);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("g", e.key());
		e.engine.handleKey("g", e.key());
		expect(e.state.cursor).toBe(0); // the first line's first non-blank
		e.engine.handleKey("j", e.key());
		expect(e.state.cursor).toBe(7);
	});
});

describe("counted Backspace steps off the character it wrapped onto", () => {
	test("2<BS> and 3<BS> across a line break", () => {
		// vim's wrap lands on the last character of the line above, so the second
		// <BS> steps off that character — not off the line break.
		const e = editor("abc\ndef", 4);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.state.cursor).toBe(1);
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.state.cursor).toBe(0);
	});

	test("a count past the front clamps at the buffer start", () => {
		const e = editor("abc\ndef", 4);
		e.engine.handleKey("4", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.state.cursor).toBe(0);
		expect(e.state.text).toBe("abc\ndef");
	});

	test("the operator form is unchanged: d2<BS> deletes up to the break", () => {
		const e = editor("abc\ndef", 4);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("", e.key({ backspace: true }));
		expect(e.state.text).toBe("abdef");
		expect(e.state.cursor).toBe(2);
	});
});

/**
 * `$` means two different things: alone it is the last character of the line,
 * and under an operator the range also takes the line break after it. A counted
 * `$` walks down, so the range spans the lines in between. These were all read
 * off vim 9.1 with the same key sequences.
 */
describe("$ with a count, and lines ending in an emoji", () => {
	test("a bare $ lands on the last character of the line", () => {
		const e = editor("abc\ndef\nghi", 1);
		e.engine.handleKey("$", e.key());
		expect(e.state.cursor).toBe(2);
	});

	test("2$ reaches the last character of the line below", () => {
		const e = editor("abc\ndef\nghi", 0);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.cursor).toBe(6); // "def", not "abc"
	});

	test("a count past the last line clamps, and on a one-line buffer it does nothing", () => {
		const e = editor("ab\ncd", 0);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.cursor).toBe(4); // clamped onto "cd"

		const one = editor("abcdef", 0);
		one.engine.handleKey("2", one.key());
		one.engine.handleKey("$", one.key());
		expect(one.state.cursor).toBe(0); // no line to step to: vim stays put
	});

	test("a counted $ lands on an empty line rather than skipping it", () => {
		const e = editor("a\n\nb", 0);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.cursor).toBe(2); // the empty line's own position
	});

	test("d$ deletes to the end of the line, and only that line", () => {
		const e = editor("abc\ndef\nghi", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.text).toBe("\ndef\nghi");
		expect(e.state.cursor).toBe(0);
	});

	test("d2$ takes the line break as well, so one line survives", () => {
		const e = editor("abc\ndef\nghi", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.text).toBe("ghi");
		expect(e.state.cursor).toBe(0);
	});

	test("d2$ on the last line leaves an empty buffer, as dG would", () => {
		const e = editor("abc\ndef\nghi", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("3", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.text).toBe("");
		expect(e.state.cursor).toBe(0);
	});

	test("d2$ on a one-line buffer is a no-op, not a whole-buffer delete", () => {
		const e = editor("abcdef", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.text).toBe("abcdef");
		expect(e.state.cursor).toBe(0);
	});

	// The four tests below are the one-line-buffer case above generalized. `2$` on
	// "abcdef" is a no-op because the caret is on the last line, not because the
	// buffer is short, and until this was fixed the engine read it as a count with
	// nowhere to go and clamped instead — which is a different answer, not a
	// different spelling of the same one. Measured in `regress.mjs`; the reason is
	// `cursor_down` in `edit.c:3087`.

	test("a count on $ from the last line is refused, not clamped onto it", () => {
		const e = editor("ab\ncdef", 4);
		e.engine.handleKey("3", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.cursor).toBe(4); // on "d", where it started

		// The wanted column the refusal armed is still armed, so a move that *can*
		// land somewhere comes back to a line end rather than to this column.
		e.engine.handleKey("k", e.key());
		expect(e.state.cursor).toBe(1); // "ab", at its end

		// …and the other end of the same rule, measured on the same buffer: a count
		// asked for from above the end is not a refusal, it clamps.
		const up = editor("ab\ncdef", 0);
		up.engine.handleKey("3", up.key());
		up.engine.handleKey("$", up.key());
		expect(up.state.cursor).toBe(6); // "cdef", at its end
	});

	test("d2$ from the last line changes nothing; from the first it takes two lines", () => {
		const last = editor("ab\ncdef", 4);
		last.engine.handleKey("d", last.key());
		last.engine.handleKey("2", last.key());
		last.engine.handleKey("$", last.key());
		expect(last.state.text).toBe("ab\ncdef");
		expect(last.state.cursor).toBe(4);

		const first = editor("ab\ncdef\nghi", 0);
		first.engine.handleKey("d", first.key());
		first.engine.handleKey("2", first.key());
		first.engine.handleKey("$", first.key());
		expect(first.state.text).toBe("ghi");
		expect(first.state.cursor).toBe(0);
	});

	test("a j that cannot move leaves the wanted column unapplied too", () => {
		// `cursor_down` returns FAIL before it touches the line *or* the column, so a
		// `j` on the last line changes nothing at all. The engine used to clamp the
		// line and then apply the column, which after the `$` fix above meant a
		// refused `2$` followed by `j` jumped the caret to the end of the line it had
		// just refused to move within.
		const e = editor("ab\ncdef", 4);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("$", e.key());
		e.engine.handleKey("j", e.key());
		expect(e.state.cursor).toBe(4);

		// `k` on the first line is the same refusal (`cursor_up`, `edit.c`), and is
		// written for the same reason even though the wanted column it would skip is
		// not reachable there today: MAXCOL is the only one that can disagree with
		// the caret, and only a refused count arms it off the end of a line.
		const up = editor("ab\ncdef", 1);
		up.engine.handleKey("k", up.key());
		expect(up.state.cursor).toBe(1);
	});

	test("a trailing line break is a line here, though a file's would not be", () => {
		// The one buffer shape the differential cannot judge, and it is a modelling
		// difference rather than a motion: read as a file, `"ab\n"` is a single line,
		// because the trailing break terminates that line and opens none after it —
		// so real vim has no second line for `G` to go to. This engine's buffer is
		// one string, and the offset just past the break is a position the caret can
		// stand on, which is also where a textarea leaves it. `regress.mjs` says so
		// where someone looking for the missing case will find it.
		const e = editor("ab\n", 0);
		e.engine.handleKey("G", e.key());
		expect(e.state.cursor).toBe(3); // the empty line after the break
	});

	test("End is $ with its count: 2<End> reaches the line below", () => {
		// vim binds K_END to nv_dollar itself, so the count is part of it. This ran
		// `$`'s movement without `$`'s count: `2<End>` stopped at the end of the
		// current line, and on the last line it did the one thing vim refuses to do.
		const e = editor("ab\ncdef\nghi", 0);
		e.engine.handleKey("2", e.key());
		expect(e.engine.handleKey("", e.key({ end: true }))).toBe(true);
		expect(e.state.cursor).toBe(6); // "cdef", not "ab"

		const last = editor("ab\ncdef", 4);
		last.engine.handleKey("2", last.key());
		last.engine.handleKey("", last.key({ end: true }));
		expect(last.state.cursor).toBe(4);
	});

	test("after an operator the arrow keys are the motions vim binds them to", () => {
		// vim binds the terminal movement keys to the same normal-mode commands, so
		// after an operator they are motions: `d<Right>` is `dl` and `d<Left>` is
		// `dh`. The engine read them as movements instead, and an empty `input` is no
		// motion at all to the character path an operator reads — so the operator was
		// dropped and `d<Right>` left the buffer untouched.
		const right = editor("abcdef", 2);
		right.engine.handleKey("d", right.key());
		expect(right.engine.handleKey("", right.key({ rightArrow: true }))).toBe(true);
		expect(right.state.text).toBe("abdef");
		expect(right.state.cursor).toBe(2);

		const left = editor("abcdef", 2);
		left.engine.handleKey("d", left.key());
		left.engine.handleKey("", left.key({ leftArrow: true }));
		expect(left.state.text).toBe("acdef");
		expect(left.state.cursor).toBe(1);

		// Linewise where the letter is linewise (`dj`), and refused where there is
		// no line to step to rather than falling back to the caret's own line.
		const down = editor("ab\ncd", 0);
		down.engine.handleKey("d", down.key());
		down.engine.handleKey("", down.key({ downArrow: true }));
		expect(down.state.text).toBe("");

		const nowhere = editor("abcdef", 0);
		nowhere.engine.handleKey("d", nowhere.key());
		nowhere.engine.handleKey("", nowhere.key({ upArrow: true }));
		expect(nowhere.state.text).toBe("abcdef");
		expect(nowhere.state.cursor).toBe(0);

		// The count lands where vim's does, on either side of the operator.
		const counted = editor("ab\ncdef\nghi", 0);
		counted.engine.handleKey("d", counted.key());
		counted.engine.handleKey("2", counted.key());
		counted.engine.handleKey("", counted.key({ end: true }));
		expect(counted.state.text).toBe("ghi");

		const before = editor("ab\ncdef", 0);
		before.engine.handleKey("2", before.key());
		before.engine.handleKey("d", before.key());
		before.engine.handleKey("", before.key({ rightArrow: true }));
		expect(before.state.text).toBe("\ncdef");

		// `c<End>` is `c$`: the same cut, and then insert mode where the typing
		// goes. (What is typed is the host's business, not this test's — the
		// differential list covers the whole `c<End>Z<Esc>` run.)
		const change = editor("abcdef", 2);
		change.engine.handleKey("c", change.key());
		change.engine.handleKey("", change.key({ end: true }));
		expect(change.state.text).toBe("ab");
		expect(change.state.cursor).toBe(2);
		expect(change.engine.mode).toBe("insert");
	});

	test("d$ at a line ending in an emoji deletes the whole emoji", () => {
		// The inclusive fold used to step one UTF-16 unit, which sliced the pair in
		// half and left a lone surrogate behind.
		const e = editor("ab😀", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("$", e.key());
		expect(e.state.text).toBe("");
	});

	test("de steps over the emoji as one character", () => {
		const e = editor("ab😀", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("e", e.key());
		expect(e.state.text).toBe("😀");
	});

	test("y$p duplicates the emoji whole", () => {
		const e = editor("😀", 0);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("$", e.key());
		e.engine.handleKey("p", e.key());
		expect(e.state.text).toBe("😀😀");
		expect(e.state.cursor).toBe(2);
	});

	test("charwise p pastes after the whole emoji, not into its pair", () => {
		const e = editor("a😀b", 1);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("$", e.key());
		e.engine.handleKey("p", e.key());
		// Yanked "😀b" and pasted it past the emoji: vim leaves the caret on "b".
		expect(e.state.text).toBe("a😀😀bb");
		expect(e.state.cursor).toBe(5);
	});

	test("charwise P pastes before the emoji", () => {
		const e = editor("ab😀", 1);
		e.engine.handleKey("y", e.key());
		e.engine.handleKey("$", e.key());
		e.engine.handleKey("P", e.key());
		expect(e.state.text).toBe("ab😀b😀");
		expect(e.state.cursor).toBe(2);
	});

	test("x and <Del> take the whole emoji under the caret", () => {
		const del = editor("a😀b", 1);
		del.engine.handleKey("", del.key({ delete: true }));
		expect(del.state.text).toBe("ab");

		const x = editor("a😀b", 1);
		x.engine.handleKey("x", x.key());
		x.engine.handleKey("x", x.key());
		expect(x.state.text).toBe("a");
		expect(x.state.cursor).toBe(0);
	});
});

describe("cc and S on a one-line buffer", () => {
	test("cc leaves an empty buffer, not an empty first line", () => {
		const e = editor("one two three", 0);
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("c", e.key());
		expect(e.state.text).toBe("");
		expect(e.state.cursor).toBe(0);
		expect(e.engine.mode).toBe("insert");
	});

	test("S behaves the same wherever the caret is", () => {
		const e = editor("abc", 1);
		e.engine.handleKey("S", e.key());
		expect(e.state.text).toBe("");
		expect(e.state.cursor).toBe(0);
	});

	test("on a buffer with a second line the empty line is left behind", () => {
		const e = editor("abc\ndef", 0);
		e.engine.handleKey("c", e.key());
		e.engine.handleKey("c", e.key());
		expect(e.state.text).toBe("\ndef");
		expect(e.state.cursor).toBe(0);
		expect(e.engine.mode).toBe("insert");
	});
});

/**
 * `<Space>` is vim's `l` with `whichwrap`'s `s`: right within the line, and off
 * the end of it onto the next. It must never type a space into the buffer from
 * NORMAL mode.
 */
describe("Space moves instead of typing", () => {
	test("one step goes right", () => {
		const e = editor("abc\ndef", 1);
		e.engine.handleKey(" ", e.key());
		expect(e.state.cursor).toBe(2);
	});

	test("from the line's last character it wraps onto the next line", () => {
		const e = editor("abc\ndef", 2);
		e.engine.handleKey(" ", e.key());
		expect(e.state.cursor).toBe(4);
	});

	test("a counted Space walks on across the break", () => {
		const e = editor("abc\ndef", 2);
		e.engine.handleKey("3", e.key());
		e.engine.handleKey(" ", e.key());
		expect(e.state.cursor).toBe(6); // vim: 2 → 4 → 5 → 6
	});

	test("an empty line is a stop, and the wrap steps off it", () => {
		const e = editor("ab\n\ncd", 1);
		e.engine.handleKey(" ", e.key());
		expect(e.state.cursor).toBe(3); // the empty line's own position
		e.engine.handleKey("2", e.key());
		e.engine.handleKey(" ", e.key());
		expect(e.state.cursor).toBe(5);
	});

	test("at the buffer end there is nowhere to wrap", () => {
		const e = editor("abc\ndef", 2);
		e.engine.handleKey("9", e.key());
		e.engine.handleKey(" ", e.key());
		expect(e.state.cursor).toBe(6);
		expect(e.state.text).toBe("abc\ndef");
	});

	test("it steps over an emoji as one character", () => {
		const e = editor("😀b", 0);
		e.engine.handleKey(" ", e.key());
		expect(e.state.cursor).toBe(2);
	});
});

/**
 * `J` and `gJ`, from vim's `do_join` (ops.c). Every expectation below was read
 * off vim 9.1 with the same keys. The one thing not reproduced is vim's file
 * model: a buffer ending in a line break is one line longer here than the same
 * file is in vim, so `J` on such a buffer has an extra empty line to join onto.
 */
describe("J joins lines the way vim does", () => {
	/** Type the keys and hand back the buffer and the caret. */
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) e.engine.handleKey(k, e.key());
		return { text: e.state.text, cursor: e.state.cursor };
	};

	test("the break and the next line's indent become one space", () => {
		expect(run("one two\nthree four", 0, "J")).toEqual({ text: "one two three four", cursor: 7 });
		expect(run("a\n  b  c", 0, "J")).toEqual({ text: "a b  c", cursor: 1 });
	});

	test("the caret lands on the join, not after it", () => {
		// Whatever column the caret started in, vim leaves it at the join point.
		expect(run("one two\nthree four", 3, "J")).toEqual({ text: "one two three four", cursor: 7 });
	});

	test("there is nothing below the last line", () => {
		expect(run("a\nb", 2, "J")).toEqual({ text: "a\nb", cursor: 2 });
	});

	test("a count joins that many lines and leaves the caret at the last join", () => {
		expect(run("a\nb\nc", 0, "2", "J")).toEqual({ text: "a b\nc", cursor: 1 });
		expect(run("aa\nbb\ncc", 0, "3", "J")).toEqual({ text: "aa bb cc", cursor: 5 });
	});

	test("a count past the buffer clamps instead of failing", () => {
		expect(run("aa\nbb\ncc", 0, "4", "J")).toEqual({ text: "aa bb cc", cursor: 5 });
	});

	test("joining onto an empty line takes the break with it", () => {
		// No space is inserted, so the empty line is gone rather than left padded —
		// and the caret is clamped back onto "a", which is what vim does when the
		// join point is past the end of the new line.
		expect(run("a\n\nb", 0, "J")).toEqual({ text: "a\nb", cursor: 0 });
		expect(run("a\n\nb\nc", 0, "3", "J")).toEqual({ text: "a b\nc", cursor: 1 });
	});

	test("an empty line being joined onto takes no space", () => {
		expect(run("\na", 0, "J")).toEqual({ text: "a", cursor: 0 });
	});

	test("a line already ending in a space does not gain another", () => {
		expect(run("a \nb", 0, "J")).toEqual({ text: "a b", cursor: 2 });
	});

	test("no space is inserted before a closing bracket", () => {
		expect(run("a\n)b", 0, "J")).toEqual({ text: "a)b", cursor: 1 });
	});

	test("a tab at the end of the line replaces the space", () => {
		expect(run("a\t\nb", 0, "J")).toEqual({ text: "a\tb", cursor: 2 });
	});

	test("a tab indent is skipped like spaces", () => {
		expect(run("a\n\tb", 0, "J")).toEqual({ text: "a b", cursor: 1 });
	});

	test("the first line's own indent is left alone", () => {
		expect(run("  a\n  b", 0, "J")).toEqual({ text: "  a b", cursor: 3 });
	});

	test("'joinspaces' adds a second space after a sentence", () => {
		expect(run("a.\nb", 0, "J")).toEqual({ text: "a.  b", cursor: 2 });
		expect(run("a!\nb", 0, "J")).toEqual({ text: "a!  b", cursor: 2 });
		expect(run("a?\nb", 0, "J")).toEqual({ text: "a?  b", cursor: 2 });
	});

	test("a trailing space plus 'joinspaces' still yields two", () => {
		// endcurr1 is the space, so no space is added — but the joinspaces test then
		// looks at the character before it (the "."), and adds one anyway.
		expect(run("a. \nb", 0, "J")).toEqual({ text: "a.  b", cursor: 3 });
		expect(run("a.  \nb", 0, "J")).toEqual({ text: "a.  b", cursor: 4 });
	});

	test("an emoji at the end of the line keeps its space and its pair", () => {
		expect(run("a😀\nb", 0, "J")).toEqual({ text: "a😀 b", cursor: 3 });
	});

	test("gJ joins with no space and keeps the indent", () => {
		expect(run("a\nb", 0, "g", "J")).toEqual({ text: "ab", cursor: 1 });
		expect(run("a\n  b", 0, "g", "J")).toEqual({ text: "a  b", cursor: 1 });
		expect(run("a\nb\nc", 0, "3", "g", "J")).toEqual({ text: "abc", cursor: 2 });
	});

	test("visual J joins the selected lines, gJ joins them tight", () => {
		expect(run("a\nb\nc", 0, "V", "j", "J")).toEqual({ text: "a b\nc", cursor: 1 });
		expect(run("a\nb\nc", 0, "V", "j", "g", "J")).toEqual({ text: "ab\nc", cursor: 1 });
	});

	test("J after an operator is not a motion: nothing happens", () => {
		expect(run("a\nb\nc", 0, "d", "J")).toEqual({ text: "a\nb\nc", cursor: 0 });
	});
});

describe("~ toggles case", () => {
	test("one character, and the caret steps past it", () => {
		const e = editor("abc", 0);
		e.engine.handleKey("~", e.key());
		expect(e.state.text).toBe("Abc");
		expect(e.state.cursor).toBe(1);
	});

	test("at the last character the caret cannot step past it", () => {
		const e = editor("abc", 2);
		e.engine.handleKey("~", e.key());
		expect(e.state.text).toBe("abC");
		expect(e.state.cursor).toBe(2);
	});

	test("a count toggles that many", () => {
		const e = editor("abcdef", 0);
		e.engine.handleKey("3", e.key());
		e.engine.handleKey("~", e.key());
		expect(e.state.text).toBe("ABCdef");
		expect(e.state.cursor).toBe(3);
	});

	test("a character with no case is stepped over, not corrupted", () => {
		const e = editor("a😀b", 1);
		e.engine.handleKey("~", e.key());
		expect(e.state.text).toBe("a😀b");
		expect(e.state.cursor).toBe(3);
	});

	test("a paste token is the same kind of character: stepped over, spelling kept", () => {
		// The letters in `[Pasted 800 chars #1]` are the token's format, so
		// swapping any of them makes the payload behind it unreachable at submit.
		const e = editor(`b ${PASTE_TOKEN} c`, 0);
		e.engine.handleKey("3", e.key());
		e.engine.handleKey("~", e.key());
		expect(e.state.text).toBe(`B ${PASTE_TOKEN} c`);
		expect(e.state.cursor).toBe(PASTE_TOKEN.length + 2);
		expect(e.writes()).toBe(1);
	});

	test("an empty line has nothing to toggle", () => {
		const e = editor("\nab", 0);
		e.engine.handleKey("~", e.key());
		expect(e.state.text).toBe("\nab");
		expect(e.state.cursor).toBe(0);
	});
});

describe(">> and << shift whole lines", () => {
	/** Type the keys and hand back the buffer and the caret. */
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) e.engine.handleKey(k, e.key());
		return { text: e.state.text, cursor: e.state.cursor };
	};

	// No options exist here, so the unit is vim's default 'shiftwidth' 8 ==
	// 'tabstop' 8 with 'noexpandtab': a full shift is a TAB, the remainder of a
	// partial indent is spaces, and the whole indent is rewritten rather than
	// adjusted (indent.c:set_indent).
	test("a full shift is a tab", () => {
		expect(run("abc", 0, ">", ">")).toEqual({ text: "\tabc", cursor: 1 });
		expect(run("        abc", 0, ">", ">")).toEqual({ text: "\t\tabc", cursor: 2 });
	});

	test("an indent that is not a multiple of eight keeps its remainder", () => {
		expect(run("  abc", 0, ">", ">")).toEqual({ text: "\t  abc", cursor: 3 });
	});

	test("the caret lands on the first non-blank, not on the tab", () => {
		expect(run("abc", 1, ">", ">")).toEqual({ text: "\tabc", cursor: 1 });
		expect(run("   ", 0, "<", "<")).toEqual({ text: "", cursor: 0 });
	});

	test("an empty line has no indent to shift", () => {
		// vim's op_shift skips it rather than giving it one — but a line of blanks
		// is not empty, and does get the canonical indent for its columns.
		expect(run("a\n\nb", 2, ">", ">")).toEqual({ text: "a\n\nb", cursor: 2 });
		expect(run("2", 0, ">", ">")).toEqual({ text: "\t2", cursor: 1 });
	});

	test("<< takes a whole shift off, and less than a shift takes all of it", () => {
		expect(run("\tabc", 0, "<", "<")).toEqual({ text: "abc", cursor: 0 });
		expect(run("        abc", 0, "<", "<")).toEqual({ text: "abc", cursor: 0 });
		expect(run("    abc", 1, "<", "<")).toEqual({ text: "abc", cursor: 0 });
		expect(run("  \tabc", 0, "<", "<")).toEqual({ text: "abc", cursor: 0 });
		expect(run("            abc", 0, "<", "<")).toEqual({ text: "    abc", cursor: 4 });
	});

	test("a line with no indent has nothing to unindent", () => {
		// The text is unchanged, so this is a caret move and not an undo step.
		const e = editor("abc", 2);
		e.engine.handleKey("<", e.key());
		e.engine.handleKey("<", e.key());
		expect(e.state).toEqual({ text: "abc", cursor: 0 });
		expect(e.writes()).toBe(0);
	});

	test("a count shifts that many lines", () => {
		expect(run("a\nb\nc", 0, "2", ">", ">")).toEqual({ text: "\ta\n\tb\nc", cursor: 1 });
		expect(run("a\nb", 0, "3", ">", ">")).toEqual({ text: "\ta\n\tb", cursor: 1 });
		expect(run("\ta\n\tb\n\tc", 0, "2", "<", "<")).toEqual({ text: "a\nb\n\tc", cursor: 0 });
	});

	test("the motion form shifts the lines the motion covers", () => {
		expect(run("a\nb\nc", 0, ">", "j")).toEqual({ text: "\ta\n\tb\nc", cursor: 1 });
		expect(run("a\nb\nc", 0, ">", "G")).toEqual({ text: "\ta\n\tb\n\tc", cursor: 1 });
		expect(run("a\nb\nc\nd", 0, "2", ">", "j")).toEqual({ text: "\ta\n\tb\n\tc\nd", cursor: 1 });
		expect(run("\ta\n\tb", 0, "<", "j")).toEqual({ text: "a\nb", cursor: 0 });
	});

	test("a motion that stays on the line shifts one line", () => {
		// `w` with an operator stops at the line break (vim's fwd_word stop_at_break),
		// so it names one line even when the buffer continues below.
		expect(run("abc\ndef", 0, ">", "w")).toEqual({ text: "\tabc\ndef", cursor: 1 });
		expect(run("abc", 2, ">", "0")).toEqual({ text: "\tabc", cursor: 1 });
	});

	test("a linewise motion that cannot move shifts nothing", () => {
		expect(run("a\nb\nc", 0, ">", "k")).toEqual({ text: "a\nb\nc", cursor: 0 });
		expect(run("a\nb", 2, ">", "j")).toEqual({ text: "a\nb", cursor: 2 });
	});

	test("visual > shifts every selected line and lands on the first", () => {
		expect(run("a\nb\nc", 0, "V", ">")).toEqual({ text: "\ta\nb\nc", cursor: 1 });
		expect(run("a\nb\nc", 0, "V", "j", ">")).toEqual({ text: "\ta\n\tb\nc", cursor: 1 });
		expect(run("a\nb\nc", 4, "V", "j", ">")).toEqual({ text: "a\nb\n\tc", cursor: 5 });
	});

	test("a charwise selection still shifts whole lines", () => {
		expect(run("abc", 0, "v", "l", ">")).toEqual({ text: "\tabc", cursor: 1 });
	});

	test("a count before visual > is the number of shifts", () => {
		expect(run("a\nb", 0, "V", "j", "2", ">")).toEqual({ text: "\t\ta\n\t\tb", cursor: 2 });
	});

	test("one shift is one undo step, however many lines it moves", () => {
		const e = editor("a\nb\nc", 0);
		e.engine.handleKey(">", e.key());
		e.engine.handleKey("G", e.key());
		expect(e.state.text).toBe("\ta\n\tb\n\tc");
		expect(e.writes()).toBe(1);
	});
});

describe("Delete in the middle of a count", () => {
	// vim reads a count in a loop that folds <Del> into the digit it is reading
	// (normal.c:236 `cap->count0 /= 10`), so the key edits the number rather than
	// running as a command of its own.
	test("it drops the last digit of the count", () => {
		const e = editor("abcdefghijkl", 0);
		for (const k of ["1", "2"]) e.engine.handleKey(k, e.key());
		e.engine.handleKey("", e.key({ delete: true }));
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("bcdefghijkl"); // 12 became 1
	});

	test("the digits before it are kept", () => {
		const e = editor("abcdefghijkl", 0);
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("3", e.key());
		e.engine.handleKey("", e.key({ delete: true }));
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("cdefghijkl"); // 23 became 2
	});

	test("eating the only digit ends the count, and the next key starts a new one", () => {
		const one = editor("abcdefghijkl", 0);
		one.engine.handleKey("1", one.key());
		one.engine.handleKey("", one.key({ delete: true }));
		one.engine.handleKey("2", one.key());
		one.engine.handleKey("x", one.key());
		expect(one.state.text).toBe("cdefghijkl"); // not 12: the 1 was eaten

		const none = editor("abcdefghijkl", 0);
		none.engine.handleKey("2", none.key());
		none.engine.handleKey("", none.key({ delete: true }));
		none.engine.handleKey("", none.key({ delete: true })); // no count now: this one is `x`
		none.engine.handleKey("x", none.key());
		expect(none.state.text).toBe("cdefghijkl");
		expect(none.writes()).toBe(2);
	});

	test("under an operator it eats a digit and leaves the operator armed", () => {
		// d 2 <Del> x : the motion never arrives, so `x` drops the operator.
		const dropped = editor("a\nb\nc", 0);
		dropped.engine.handleKey("d", dropped.key());
		dropped.engine.handleKey("2", dropped.key());
		dropped.engine.handleKey("", dropped.key({ delete: true }));
		dropped.engine.handleKey("x", dropped.key());
		expect(dropped.state.text).toBe("a\nb\nc");
		expect(dropped.writes()).toBe(0);

		// d 2 <Del> j : one line down, not two.
		const motion = editor("a\nb\nc", 0);
		motion.engine.handleKey("d", motion.key());
		motion.engine.handleKey("2", motion.key());
		motion.engine.handleKey("", motion.key({ delete: true }));
		motion.engine.handleKey("j", motion.key());
		expect(motion.state.text).toBe("c");

		// d 12 <Del> j : twelve became one.
		const digits = editor("a\nb\nc\nd", 0);
		digits.engine.handleKey("d", digits.key());
		for (const k of ["1", "2"]) digits.engine.handleKey(k, digits.key());
		digits.engine.handleKey("", digits.key({ delete: true }));
		digits.engine.handleKey("j", digits.key());
		expect(digits.state.text).toBe("c\nd");
	});

	test("in visual mode it edits the count instead of cutting", () => {
		const e = editor("a\nb\nc", 0);
		e.engine.handleKey("V", e.key());
		e.engine.handleKey("2", e.key());
		e.engine.handleKey("", e.key({ delete: true }));
		e.engine.handleKey("d", e.key()); // V with a count of one: `Vjd` never happened
		expect(e.state.text).toBe("b\nc");
	});
});

describe("a count on G and gg names a line", () => {
	const LINES = "one\ntwo\nthree\nfour";
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) e.engine.handleKey(k, e.key());
		return { text: e.state.text, cursor: e.state.cursor };
	};

	// `nv_goto` reads the count as the number of the line to go to, so `2G` is
	// line 2 — and with an operator that is the far end of the range, not a
	// repetition of the motion.
	test("d2G deletes from the caret to line 2", () => {
		expect(run(LINES, 0, "d", "2", "G")).toEqual({ text: "three\nfour", cursor: 0 });
		expect(run(LINES, 4, "d", "2", "G")).toEqual({ text: "one\nthree\nfour", cursor: 4 });
	});

	test("the count before the operator counts the same way", () => {
		expect(run(LINES, 0, "2", "d", "G")).toEqual({ text: "three\nfour", cursor: 0 });
		expect(run(LINES, 4, "2", "d", "G")).toEqual({ text: "one\nthree\nfour", cursor: 4 });
		expect(run(LINES, 0, "3", "d", "G")).toEqual({ text: "four", cursor: 0 });
	});

	test("a line above the caret flips the range", () => {
		expect(run(LINES, 8, "1", "d", "G")).toEqual({ text: "four", cursor: 0 });
		expect(run(LINES, 8, "d", "1", "G")).toEqual({ text: "four", cursor: 0 });
	});

	test("d2gg deletes back to line 2", () => {
		expect(run(LINES, 8, "d", "2", "g", "g")).toEqual({ text: "one\nfour", cursor: 4 });
		expect(run(LINES, 13, "2", "d", "g", "g")).toEqual({ text: "one\nfour", cursor: 4 });
	});

	test("a line past the end clamps to the last one", () => {
		expect(run(LINES, 4, "9", "d", "G")).toEqual({ text: "one", cursor: 0 });
		expect(run("only", 0, "d", "2", "G")).toEqual({ text: "", cursor: 0 });
	});

	test("no count still means the end of the buffer", () => {
		expect(run(LINES, 4, "d", "G")).toEqual({ text: "one", cursor: 0 });
		expect(run(LINES, 8, "d", "g", "g")).toEqual({ text: "four", cursor: 0 });
	});

	test("the shift operator reads it the same way", () => {
		expect(run(LINES, 0, "2", ">", "G")).toEqual({ text: "\tone\n\ttwo\nthree\nfour", cursor: 1 });
		expect(run(LINES, 8, "2", ">", "g", "g")).toEqual({ text: "one\n\ttwo\n\tthree\nfour", cursor: 5 });
	});
});

describe("Space is a motion under an operator", () => {
	test("d<Space> is dl", () => {
		const middle = editor("abc\ndef", 1);
		middle.engine.handleKey("d", middle.key());
		middle.engine.handleKey(" ", middle.key());
		expect(middle.state.text).toBe("ac\ndef");

		const last = editor("abc\ndef", 2);
		last.engine.handleKey("d", last.key());
		last.engine.handleKey(" ", last.key());
		expect(last.state.text).toBe("ab\ndef"); // the character, not the line break
		expect(last.state.cursor).toBe(1);
	});

	test("on the last line there is nothing to wrap onto", () => {
		expect(editor("abc", 2).state.text).toBe("abc"); // sanity: the buffer is what we think
		const e = editor("abc", 2);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey(" ", e.key());
		expect(e.state.text).toBe("ab");
		expect(e.state.cursor).toBe(1);
	});

	test("a count reaches it", () => {
		const e = editor("abcdef", 0);
		e.engine.handleKey("d", e.key());
		e.engine.handleKey("2", e.key());
		e.engine.handleKey(" ", e.key());
		expect(e.state.text).toBe("cdef");
	});
});

describe("the wanted column a j or k comes back to", () => {
	// Vertical motions aim at a remembered column, not at the caret: a `$` on a
	// long line followed by `j` lands on the end of the short line it reaches,
	// and the `j` after that is still aiming at the long line's end. Only a
	// command that really moves the caret replaces the column. Every number
	// below is vim 9.1's own answer to the same keys (differential probe).
	const LINES = "abcdef\ngh\nijkl"; // the lines start at 0, 7 and 10
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) e.engine.handleKey(k, e.key());
		return { text: e.state.text, cursor: e.state.cursor };
	};

	test("$ arms the end of the line and j spends it on the way down", () => {
		expect(run(LINES, 0, "$", "j")).toEqual({ text: LINES, cursor: 8 }); // clamped to "gh"
		expect(run(LINES, 0, "$", "j", "j")).toEqual({ text: LINES, cursor: 13 });
		expect(run(LINES, 0, "$", "j", "k")).toEqual({ text: LINES, cursor: 5 }); // back at the `$` column
	});

	test("Home is 0 and End is $: both move the wanted column", () => {
		// vim's <Home> runs nv_beginline's bookkeeping, so it discards a pending `$`
		// (`$` <Home> `j` lands on line 2's first character, 2:1); <End> is
		// nv_dollar, which arms MAXCOL (`l` <End> `j` on "gh\nabcdef" lands on the
		// last character of "abcdef", 2:6, not on the second one). Both vim 9.1.
		const home = editor(LINES, 0);
		home.engine.handleKey("$", home.key());
		home.engine.handleKey("", home.key({ home: true }));
		home.engine.handleKey("j", home.key());
		expect(home.state.cursor).toBe(7); // 2:1

		const end = editor("gh\nabcdef\n", 0);
		end.engine.handleKey("l", end.key());
		end.engine.handleKey("", end.key({ end: true }));
		end.engine.handleKey("j", end.key());
		expect(end.state.cursor).toBe(8); // 2:6
	});

	test("a column taken on a long line outlives the short one it crossed", () => {
		expect(run(LINES, 0, "4", "l", "j")).toEqual({ text: LINES, cursor: 8 });
		expect(run(LINES, 0, "4", "l", "j", "j")).toEqual({ text: LINES, cursor: 13 });
		expect(run(LINES, 0, "4", "l", "j", "j", "k")).toEqual({ text: LINES, cursor: 8 });
		// From the short line there was no column 4 to keep, so the failed `4l`
		// left the caret's own column behind rather than arming one.
		expect(run(LINES, 8, "4", "l", "k")).toEqual({ text: LINES, cursor: 1 });
	});

	test("a motion that could not move leaves it, a real one replaces it", () => {
		expect(run(LINES, 0, "$", "j", "l", "j")).toEqual({ text: LINES, cursor: 13 }); // l at the line end
		expect(run(LINES, 0, "$", "j", "h", "j")).toEqual({ text: LINES, cursor: 10 }); // h did move: 6
		expect(run(LINES, 0, "$", "j", "x", "j")).toEqual({ text: "abcdef\ng\nijkl", cursor: 9 });
		expect(run(LINES, 0, "$", "j", "0", "j")).toEqual({ text: LINES, cursor: 10 }); // 0 is a move too
	});

	test("a find that missed leaves it, a find that landed replaces it", () => {
		const text = "abcdef\nghz\nmnopqr"; // line 2 is "ghz": fq misses, fz hits
		expect(run(text, 0, "$", "j", "0", "f", "z", "j")).toEqual({ text, cursor: 13 });
		expect(run(text, 0, "$", "j", "0", "f", "q", "j")).toEqual({ text, cursor: 11 });
		expect(run(text, 0, "f", "c", "j")).toEqual({ text, cursor: 9 });
		expect(run(text, 0, "t", "c", "j")).toEqual({ text, cursor: 8 }); // t stops short by one
	});

	test("an operator hands on the column its own caret ended on", () => {
		expect(run(LINES, 0, "$", "y", "G", "j")).toEqual({ text: LINES, cursor: 8 });
		expect(run(LINES, 0, "y", "G", "j")).toEqual({ text: LINES, cursor: 7 });
		expect(run(LINES, 8, "y", "g", "g", "j")).toEqual({ text: LINES, cursor: 7 });
		expect(run(LINES, 10, "y", "G", "j")).toEqual({ text: LINES, cursor: 10 }); // j on the last line
		expect(run(LINES, 0, "y", "$", "j")).toEqual({ text: LINES, cursor: 7 });
		expect(run(LINES, 0, "d", "$", "j")).toEqual({ text: "\ngh\nijkl", cursor: 1 });
		expect(run(LINES, 0, "$", "J", "j")).toEqual({ text: "abcdef gh\nijkl", cursor: 13 });
		expect(run(LINES, 0, "$", "x", "j")).toEqual({ text: "abcde\ngh\nijkl", cursor: 7 });
	});

	test("G snaps the caret to the first non-blank and passes that column on", () => {
		expect(run(LINES, 0, "G", "k")).toEqual({ text: LINES, cursor: 7 });
		expect(run(LINES, 0, "$", "G", "k")).toEqual({ text: LINES, cursor: 7 });
		expect(run(LINES, 0, "G", "j")).toEqual({ text: LINES, cursor: 10 }); // the last line: no move
	});

	test("undo throws it away: the caret it restores is the new column", () => {
		const text = "abcdef\nghijkl";
		expect(run(text, 0, "x", "$", "u", "j")).toEqual({ text, cursor: 7 });
		expect(run(text, 0, "x", "u", "j")).toEqual({ text, cursor: 7 });
		expect(run(text, 0, "2", "|", "x", "u", "j")).toEqual({ text, cursor: 8 });
		expect(run(text, 0, "$", "u", "j")).toEqual({ text, cursor: 12 }); // nothing to undo
	});
});

describe("the column command |", () => {
	// nv_pipe: the count is a 1-based column, clamped to the last character of
	// the line, and it is a motion like any other — so under an operator it ends
	// the range, and a count that would not move makes the operator a no-op.
	const LINES = "abcdef\ngh\nijkl";
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) e.engine.handleKey(k, e.key());
		return { text: e.state.text, cursor: e.state.cursor };
	};

	test("it moves the caret to that column, clamped to the line's last character", () => {
		expect(run(LINES, 0, "4", "|")).toEqual({ text: LINES, cursor: 3 });
		expect(run(LINES, 0, "8", "|")).toEqual({ text: LINES, cursor: 5 }); // past "abcdef": its last char
		expect(run(LINES, 0, "2", "|", "j")).toEqual({ text: LINES, cursor: 8 });
		expect(run(LINES, 0, "2", "|", "j", "j")).toEqual({ text: LINES, cursor: 11 });
		expect(run(LINES, 0, "6", "|", "j")).toEqual({ text: LINES, cursor: 8 }); // line 2 is only 2 long
		expect(run(LINES, 0, "6", "|", "j", "j")).toEqual({ text: LINES, cursor: 13 });
		expect(run(LINES, 0, "8", "|", "j")).toEqual({ text: LINES, cursor: 8 });
		expect(run(LINES, 0, "4", "|", "g", "g", "j")).toEqual({ text: LINES, cursor: 7 });
	});

	test("under an operator it ends the range at that column", () => {
		expect(run(LINES, 0, "d", "4", "|")).toEqual({ text: "def\ngh\nijkl", cursor: 0 });
		expect(run(LINES, 0, "d", "8", "|")).toEqual({ text: "f\ngh\nijkl", cursor: 0 });
		expect(run(LINES, 3, "d", "|")).toEqual({ text: "def\ngh\nijkl", cursor: 0 }); // back to column 1
		expect(run(LINES, 5, "d", "2", "|")).toEqual({ text: "af\ngh\nijkl", cursor: 1 });
		expect(run(LINES, 0, "2", "|", "d", "4", "|")).toEqual({ text: "adef\ngh\nijkl", cursor: 1 });
		expect(run(LINES, 0, "4", "|", "d", "j")).toEqual({ text: "ijkl", cursor: 0 });
		expect(run(LINES, 3, "d", "4", "|")).toEqual({ text: LINES, cursor: 3 }); // it did not move
	});
});

describe("v and V inside visual mode", () => {
	// nv_visual: pressing the key you are already in ends visual mode; the other
	// one only switches the flavour, keeping the anchor where it was. Leaving
	// that way is not Esc — it does not arm a new wanted column.
	const LINES = "abcdef\ngh\nijkl";
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) {
			if (k === "\u001b") e.engine.handleKey("", e.key({ escape: true }));
			else e.engine.handleKey(k, e.key());
		}
		return { text: e.state.text, cursor: e.state.cursor, mode: e.engine.mode };
	};

	test("the same key twice leaves visual mode", () => {
		expect(run(LINES, 0, "v", "j", "v")).toEqual({ text: LINES, cursor: 7, mode: "normal" });
		expect(run(LINES, 0, "V", "j", "V")).toEqual({ text: LINES, cursor: 7, mode: "normal" });
		expect(run(LINES, 0, "v", "v", "\u001b", "j")).toEqual({ text: LINES, cursor: 7, mode: "normal" });
		expect(run(LINES, 0, "V", "V", "j")).toEqual({ text: LINES, cursor: 7, mode: "normal" });
	});

	test("leaving that way really leaves it: the next d finds nothing pending", () => {
		expect(run(LINES, 0, "v", "v", "d")).toEqual({ text: LINES, cursor: 0, mode: "normal" });
		expect(run(LINES, 4, "v", "2", "|", "v", "d")).toEqual({ text: LINES, cursor: 1, mode: "normal" });
	});

	test("the other key switches flavour and keeps the anchor", () => {
		expect(run(LINES, 0, "v", "V")).toEqual({ text: LINES, cursor: 0, mode: "visual-line" });
		expect(run(LINES, 0, "V", "v")).toEqual({ text: LINES, cursor: 0, mode: "visual" });
		expect(run(LINES, 0, "v", "V", "d")).toEqual({ text: "gh\nijkl", cursor: 0, mode: "normal" });
		expect(run(LINES, 0, "v", "j", "V", "d")).toEqual({ text: "ijkl", cursor: 0, mode: "normal" });
		expect(run(LINES, 0, "V", "j", "v", "j", "d")).toEqual({ text: "jkl", cursor: 0, mode: "normal" });
		expect(run(LINES, 0, "v", "j", "V", "j", "y", "p")).toEqual({
			text: "abcdef\nabcdef\ngh\nijkl\ngh\nijkl",
			cursor: 7,
			mode: "normal",
		});
	});

	test("a toggle exit does not arm a column, an Esc exit does", () => {
		const B = "abcdef\nghijklmno";
		expect(run(B, 0, "$", "v", "v", "j")).toEqual({ text: B, cursor: 15, mode: "normal" });
		expect(run(B, 0, "$", "V", "V", "j")).toEqual({ text: B, cursor: 15, mode: "normal" });
		expect(run(B, 0, "2", "|", "v", "v", "j")).toEqual({ text: B, cursor: 8, mode: "normal" });
		expect(run(B, 0, "$", "v", "\u001b", "j")).toEqual({ text: B, cursor: 12, mode: "normal" }); // column 6
		expect(run(B, 0, "2", "|", "v", "\u001b", "j")).toEqual({ text: B, cursor: 8, mode: "normal" });
	});
});

describe("a linewise change keeps the line it empties", () => {
	// `Vc` is `cc` over the selected lines, not a delete: the block gives way to
	// one empty line and the insert starts on it. The same keys with `d` or with
	// <Del> take the block and the line break with it.
	const D = "a\nbc\ndef";
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) {
			if (k === "\u001b") e.engine.handleKey("", e.key({ escape: true }));
			else if (e.engine.mode === "insert") e.type(k);
			else e.engine.handleKey(k, e.key());
		}
		return { text: e.state.text, cursor: e.state.cursor, mode: e.engine.mode };
	};

	test("on a middle line it leaves the empty line and starts the insert on it", () => {
		expect(run(D, 2, "V", "c", "x", "\u001b")).toEqual({ text: "a\nx\ndef", cursor: 2, mode: "normal" });
		expect(run(D, 2, "V", "c", "x", "\u001b", "j")).toEqual({ text: "a\nx\ndef", cursor: 4, mode: "normal" });
		expect(run(D, 2, "c", "c", "x", "\u001b")).toEqual({ text: "a\nx\ndef", cursor: 2, mode: "normal" });
	});

	test("with nothing typed the empty line is still there", () => {
		expect(run(D, 2, "V", "c", "\u001b")).toEqual({ text: "a\n\ndef", cursor: 2, mode: "normal" });
		expect(run(D, 2, "V", "c", "\u001b", "j")).toEqual({ text: "a\n\ndef", cursor: 3, mode: "normal" });
	});

	test("at the edges of the buffer, and on a buffer of one line", () => {
		expect(run(D, 0, "V", "c", "x", "\u001b")).toEqual({ text: "x\nbc\ndef", cursor: 0, mode: "normal" });
		expect(run(D, 5, "V", "c", "x", "\u001b")).toEqual({ text: "a\nbc\nx", cursor: 5, mode: "normal" });
		expect(run("a\nbc", 2, "V", "c", "x", "\u001b")).toEqual({ text: "a\nx", cursor: 2, mode: "normal" });
		expect(run("abc", 0, "V", "c", "x", "\u001b")).toEqual({ text: "x", cursor: 0, mode: "normal" });
	});

	test("a count of lines goes the same way", () => {
		expect(run("a\nbc\ndef\ngh", 2, "V", "2", "j", "c", "x", "\u001b")).toEqual({
			text: "a\nx",
			cursor: 2,
			mode: "normal",
		});
	});

	test("a charwise c stays charwise: it joins what is left", () => {
		expect(run(D, 2, "v", "j", "c", "x", "\u001b")).toEqual({ text: "a\nxef", cursor: 2, mode: "normal" });
	});
});

describe("the uppercase visual forms take whole lines", () => {
	// v_visop: an uppercase form ends a charwise selection linewise first — vim's
	// own translation table — and then runs the lowercase operator over every
	// line the selection touched.
	const B = "abcdef\nghijklmno";
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) {
			if (k === "\u001b") e.engine.handleKey("", e.key({ escape: true }));
			else if (e.engine.mode === "insert") e.type(k);
			else e.engine.handleKey(k, e.key());
		}
		return { text: e.state.text, cursor: e.state.cursor, mode: e.engine.mode };
	};

	test("v2lD and v2lX take the line where v2ld takes three characters", () => {
		expect(run(B, 0, "v", "2", "l", "d")).toEqual({ text: "def\nghijklmno", cursor: 0, mode: "normal" });
		expect(run(B, 0, "v", "2", "l", "x")).toEqual({ text: "def\nghijklmno", cursor: 0, mode: "normal" });
		expect(run(B, 0, "v", "2", "l", "D")).toEqual({ text: "ghijklmno", cursor: 0, mode: "normal" });
		expect(run(B, 0, "v", "2", "l", "X")).toEqual({ text: "ghijklmno", cursor: 0, mode: "normal" });
	});

	test("v2lY yanks the line itself where v2ly yanks the characters", () => {
		expect(run(B, 0, "v", "2", "l", "Y", "p")).toEqual({
			text: "abcdef\nabcdef\nghijklmno",
			cursor: 7,
			mode: "normal",
		});
		expect(run(B, 0, "v", "2", "l", "y", "$", "p")).toEqual({
			text: "abcdefabc\nghijklmno",
			cursor: 8,
			mode: "normal",
		});
	});

	test("v2lC and v2lS change the line instead of the characters", () => {
		expect(run(B, 0, "v", "2", "l", "C", "x", "\u001b")).toEqual({ text: "x\nghijklmno", cursor: 0, mode: "normal" });
		expect(run(B, 0, "v", "2", "l", "S", "x", "\u001b")).toEqual({ text: "x\nghijklmno", cursor: 0, mode: "normal" });
	});
});

describe("a visual-line delete on the last line", () => {
	// dd/Vd take the line break *before* the block, so a delete on the last line
	// of the buffer — which has no break after it — cuts the buffer clean.
	const D = "a\nbc\ndef";
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) e.engine.handleKey(k, e.key());
		return { text: e.state.text, cursor: e.state.cursor, mode: e.engine.mode };
	};

	test("Vd anywhere on the last line cuts the buffer clean", () => {
		expect(run(D, 5, "V", "d")).toEqual({ text: "a\nbc", cursor: 2, mode: "normal" });
		expect(run(D, 6, "V", "d")).toEqual({ text: "a\nbc", cursor: 2, mode: "normal" });
		expect(run(D, 7, "V", "d")).toEqual({ text: "a\nbc", cursor: 2, mode: "normal" });
		expect(run(D, 5, "V", "d", "j")).toEqual({ text: "a\nbc", cursor: 2, mode: "normal" });
		expect(run("abc\nde", 4, "V", "x")).toEqual({ text: "abc", cursor: 0, mode: "normal" });
	});

	test("a middle line keeps the break in front of it", () => {
		expect(run(D, 2, "V", "d")).toEqual({ text: "a\ndef", cursor: 2, mode: "normal" });
	});
});

describe("a paste token is one character", () => {
	// Every case here is about the same failure: the token is literal ASCII in a
	// buffer the user can edit, and a string that no longer matches
	// `PASTE_TOKEN_RE` submits as the remains of a placeholder in place of the
	// payload — a prompt that looks normal and says something else. The token is
	// 21 units long in every one of these buffers: `[` + `Pasted 800 chars #1]`.
	const TEXT = `a ${PASTE_TOKEN} b`;
	/** Where the token starts in TEXT, and where the space after it is. */
	const AT = 2;
	const PAST = AT + PASTE_TOKEN.length;
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) e.engine.handleKey(k, e.key());
		return e;
	};

	test("x takes the whole token, and nothing else", () => {
		const e = run(TEXT, AT, "x");
		expect(e.state.text).toBe("a  b");
		expect(e.state.cursor).toBe(AT);
		expect(e.writes()).toBe(1);
	});

	test("l and h step over the token as one character", () => {
		expect(run(TEXT, AT, "l").state.cursor).toBe(PAST);
		expect(run(TEXT, PAST, "h").state.cursor).toBe(AT);
	});

	test("X after the token takes the whole of it", () => {
		expect(run(TEXT, PAST, "X").state.text).toBe("a  b");
	});

	test("b from after the token comes back to its `[`, never inside it", () => {
		// The interior is not a position: without the token-aware step, `b` lands
		// on the `1` before the `]` and the next `x` cuts the payload in half.
		expect(run(TEXT, PAST, "b").state.cursor).toBe(AT);
		expect(run(TEXT, PAST + 1, "b").state.cursor).toBe(AT);
	});

	test("a word motion takes the token as the one punctuation word it is", () => {
		// `dw` on `a . b` at the dot takes the dot and the blanks after it, and
		// this is the same case with twenty-one characters of placeholder instead
		// of one.
		expect(run(TEXT, AT, "d", "w").state.text).toBe("a b");
	});

	test("cw on a token cuts all of it and opens insert", () => {
		const e = run(TEXT, AT, "c", "w");
		expect(e.state.text).toBe("a  b");
		expect(e.state.cursor).toBe(AT);
		expect(e.engine.mode).toBe("insert");
	});

	test("a selection over a token takes all of it", () => {
		const e = run(TEXT, AT, "v", "d");
		expect(e.state.text).toBe("a  b");
		expect(e.state.cursor).toBe(AT);
		expect(e.engine.mode).toBe("normal");
	});

	test("r refuses on a token rather than respelling it", () => {
		const e = run(TEXT, AT, "r", "Z");
		expect(e.state.text).toBe(TEXT);
		expect(e.state.cursor).toBe(AT);
		expect(e.writes()).toBe(0);
	});

	test("a inserts after the token, i before it", () => {
		const after = run(TEXT, AT, "a");
		expect(after.state.cursor).toBe(PAST);
		after.type("Q");
		expect(after.state.text).toBe(`a ${PASTE_TOKEN}Q b`);
		const before = run(TEXT, AT, "i");
		before.type("Q");
		expect(before.state.text).toBe(`a Q${PASTE_TOKEN} b`);
	});

	test("a wanted column inside a token lands on the token's `[`", () => {
		// `j` aims at a *column*, and a column inside a token is a real column of
		// the line. Line 2 puts the token at 9, so a `5|` from line 1 aims at 11,
		// which is between the token's `P` and `a`.
		const e = run("abcdef\nx [Pasted 800 chars #1] y", 0, "5", "|", "j");
		expect(e.state.cursor).toBe(9);
		// Which is the difference between `x` removing the payload and cutting it.
		e.engine.handleKey("x", e.key());
		expect(e.state.text).toBe("abcdef\nx  y");
	});

	test("a token pastes back byte for byte, so it still expands at submit", () => {
		const payload = "a long pasted payload\nwith a line break";
		const map = new Map([[PASTE_TOKEN, payload]]);
		const e = run(TEXT, AT, "y", "l", "x", "P");
		expect(e.state.text).toBe(TEXT);
		expect(expandPasteTokens(e.state.text, map)).toBe(`a ${payload} b`);
	});

	test("a paste leaves the caret on the pasted token's `[`, not its `]`", () => {
		const e = run(TEXT, AT, "y", "l", "p");
		expect(e.state.text).toBe(`a ${PASTE_TOKEN}${PASTE_TOKEN} b`);
		// The caret comes back to the character vim's `p` leaves it on — the last
		// character it pasted, which is the token's `[` and not its `]`.
		expect(e.state.cursor).toBe(PAST);
	});

	test("a find cannot stop inside a token, but can stop on its `[`", () => {
		// The token is one character whose one addressable position is its `[`, so
		// `f[` finds it and `t]` cannot find the bracket that ends it.
		expect(run(TEXT, 0, "f", "]").state.cursor).toBe(0);
		expect(run(TEXT, 0, "f", "[").state.cursor).toBe(AT);
	});

	test("the visual case commands leave a token's spelling alone", () => {
		expect(run(`AB ${PASTE_TOKEN} cd`, 0, "V", "u").state.text).toBe(`ab ${PASTE_TOKEN} cd`);
		expect(run(`AB ${PASTE_TOKEN} cd`, 0, "V", "~").state.text).toBe(`ab ${PASTE_TOKEN} CD`);
	});

	test("splitsPasteToken is the invariant, held against examples", () => {
		// No motion reaches the guard that asks this — every range is cut between
		// characters — so the invariant is stated as a function and pinned here
		// rather than trusted to hold on its own.
		expect(splitsPasteToken(TEXT, AT, PAST)).toBe(false); // exactly the token
		expect(splitsPasteToken(TEXT, 0, PAST)).toBe(false); // the line up to its end
		expect(splitsPasteToken(TEXT, 0, TEXT.length)).toBe(false);
		expect(splitsPasteToken(TEXT, 0, AT)).toBe(false); // stops before it
		expect(splitsPasteToken(TEXT, PAST, TEXT.length)).toBe(false); // starts after it
		expect(splitsPasteToken(TEXT, AT + 1, PAST)).toBe(true); // cuts into its front
		expect(splitsPasteToken(TEXT, 0, AT + 4)).toBe(true); // cuts into its tail
		expect(splitsPasteToken(TEXT, AT + 1, AT + 4)).toBe(true); // both ends inside
		expect(splitsPasteToken("no token at all", 1, 4)).toBe(false);
		// A stray bracket in front of a real token is not one, and must not hide it.
		expect(splitsPasteToken(`[a ${PASTE_TOKEN} b`, 0, 5)).toBe(true);
	});
});

describe("`.` repeats the last change", () => {
	// The Escape is spelled as an override rather than as the byte, because that
	// is how the host sends it: `handleKey("", { escape: true })`. Every case that
	// enters insert mode has to leave it again, or it measures the insert caret.
	// A key the engine does not consume while it is in insert mode is the user's
	// next character — that is the REPL's contract (see `useTextInput.ts`), and a
	// `.` that repeats a change has to be able to repeat typed text, so `run` has
	// to be a host and not just a key pusher.
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) {
			if (k === "\x1b") {
				e.engine.handleKey("", e.key({ escape: true }));
				continue;
			}
			if (e.engine.handleKey(k, e.key())) continue;
			if (e.engine.mode === "insert" && k.length === 1 && k >= " ") {
				e.state.text = e.state.text.slice(0, e.state.cursor) + k + e.state.text.slice(e.state.cursor);
				e.state.cursor += 1;
			}
		}
		return { text: e.state.text, cursor: e.state.cursor, writes: e.writes(), mode: e.engine.mode };
	};
	const W = "one two three four";
	const S16 = "abcdefghijklmnop";
	/** The four short lines a Visual selection's shape is readable against. */
	const SHORT = "ab\ncd\nef\ngh";

	test("it repeats the last change, once", () => {
		// `j` is in the sequence and changes nothing: `W` is one line, so there is
		// nowhere to go. The redo is the `x`, wherever the caret is.
		expect(run(W, 0, "x", "j", ".")).toEqual({
			text: "e two three four",
			cursor: 0,
			writes: 2,
			mode: "normal",
		});
	});

	test("the replay becomes the change it repeated, so `.` is a fixed point", () => {
		expect(run(W, 0, "x", "j", ".", "j", ".")).toMatchObject({ text: " two three four", cursor: 0 });
		// Three characters gone in three presses, and each one its own undo step —
		// the host records undo on `setAll`, so a redo that cost nothing would be a
		// change the user cannot take back.
		expect(run(W, 0, "x", "j", ".", "j", ".").writes).toBe(3);
	});

	test("a count on a redo replaces the count the change was made with", () => {
		expect(run(S16, 0, "3", "x", "2", ".")).toMatchObject({ text: "fghijklmnop", cursor: 0 });
		expect(run(S16, 0, "2", "x", "j", "4", ".")).toMatchObject({ text: "ghijklmnop", cursor: 0 });
		// And the count it used is what the *next* redo carries, which is why
		// `x 3. .` removes three and not one.
		expect(run(S16, 0, "x", "j", "3", ".", "j", ".")).toMatchObject({ text: "hijklmnop", cursor: 0 });
		expect(run(S16, 0, "x", "0", ".", "j", ".")).toMatchObject({ text: "defghijklmnop", cursor: 0 });
	});

	test("with nothing changed yet there is nothing to repeat", () => {
		expect(run(W, 0, ".")).toMatchObject({ text: W, cursor: 0, writes: 0 });
		// A change that changed nothing — the last character of the only line —
		// is not recorded, and the buffer being empty leaves no redo either.
		expect(run("a", 0, "x", ".")).toMatchObject({ text: "", cursor: 0, writes: 1 });
		expect(run("", 0, ".")).toMatchObject({ text: "", cursor: 0, writes: 0 });
	});

	test("a motion, a yank or a search is not a change", () => {
		expect(run(W, 0, "x", "w", "j", ".")).toMatchObject({ text: "ne wo three four", cursor: 3 });
		// The yank is between the change and the redo, and the redo is still the
		// `x`: the buffer after `x` `yy` is what `.` acts on, and `p` pastes the
		// line the yank took, which is the line *before* the redo.
		expect(run(W, 0, "x", "y", "y", "j", ".", "p")).toMatchObject({ text: "en two three four", cursor: 1 });
		expect(run("aa bb aa", 0, "x", "n", ".")).toMatchObject({ text: " bb aa", cursor: 0 });
	});

	test("an undo is not a change, and does not become the redo", () => {
		expect(run(W, 0, "x", "u", ".")).toMatchObject({ text: "ne two three four", cursor: 0 });
	});

	test("an operator that was abandoned is not a change", () => {
		expect(run(W, 0, "d", "\x1b", "x", "j", ".")).toMatchObject({ text: "e two three four", cursor: 0 });
	});

	test("the last change is the redo, whichever it was", () => {
		// `x` then `dd`: the second is newer, and a redo that remembered the
		// *first* key it ever saw would leave a character behind.
		expect(run("ab\ncd", 0, "x", "d", "d", "j", ".")).toMatchObject({ text: "", cursor: 0 });
	});

	test("a change made in insert mode repeats its text too", () => {
		expect(run(W, 0, "c", "w", "Z", "\x1b", "w", ".", "\x1b")).toMatchObject({
			text: "Z Z three four",
			cursor: 2,
			mode: "normal",
		});
		// Two writes for the replay: the operator's delete and the insertion the
		// replay typed. The original cost one more, and the text the user typed was
		// the host's to insert, not a `setAll`.
		expect(run(W, 0, "c", "w", "Z", "\x1b", "w", ".", "\x1b").writes).toBe(3);
	});

	test("each of the insert-mode forms repeats, and the replay leaves insert again", () => {
		for (const [label, seq, want] of [
			["s", ["s", "\x1b", "j", ".", "\x1b"], { text: "e two three four", cursor: 0 }],
			["S", ["S", "\x1b", "\x1b", "j", ".", "\x1b"], { text: "a\n\n", cursor: 3 }],
			["i", ["i", "X", "\x1b", "l", ".", "\x1b"], { text: "one XXtwo three four", cursor: 5 }],
			["o", ["o", "X", "\x1b", "\x1b", "j", ".", "\x1b"], { text: "a\nX\nb\nX", cursor: 6 }],
		] as const) {
			const start = label === "S" ? 2 : label === "i" ? 4 : 0;
			const text = label === "S" ? "a\nb\nc" : label === "o" ? "a\nb" : W;
			const got = run(text, start, ...seq);
			expect(`${label}: ${got.text}@${got.cursor} ${got.mode}`).toBe(`${label}: ${want.text}@${want.cursor} normal`);
		}
	});

	test("a Visual delete repeats its size, not the keys that made it", () => {
		// `vjd` took "ab\ncd"; a redo that re-typed the motions would take the same
		// two lines again and one `x` would not — this is `redo_VIsual` (ops.c:3890).
		expect(run(SHORT, 0, "v", "j", "d", "j", ".")).toMatchObject({ text: "d\nh", cursor: 2 });
		expect(run("abcdef", 0, "v", "l", "d", "l", ".")).toMatchObject({ text: "cf", cursor: 1 });
	});

	test("a selection on one line is re-taken by its width", () => {
		// `v$` took six characters; redoing it on a two-character line takes two,
		// which is the width (`ops.c:4136`) and not the end column it was made at.
		expect(run("abcdef\nxyz\npq", 0, "v", "$", "d", "0", ".")).toMatchObject({ text: "pq", cursor: 0 });
		// From column 0 all three forms name the same place, so the width and the
		// end column are only told apart by a selection that started elsewhere —
		// `llv3ld` took three columns from column 2, and four are redone at the top.
		expect(run("abcdef\nuvwxyz", 0, "l", "l", "v", "3", "l", "d", "j", "0", ".")).toMatchObject({
			text: "ab\nyz",
			cursor: 3,
		});
	});

	test("a selection that ended on $ is re-taken to the end of the line", () => {
		// `w_curswant == MAXCOL` is checked before the two forms above, so a
		// selection ending on `$` goes to the end of whatever line the caret is on
		// now — and takes the break with it, which is the NUL rule at ops.c:4218.
		expect(run("abcdef\nuvwxyz", 0, "l", "l", "v", "$", "d", "j", "0", ".")).toMatchObject({
			text: "",
			cursor: 0,
		});
		expect(run("ab\ncd\nefgh", 0, "v", "j", "$", "d", "G", ".")).toMatchObject({ text: "", cursor: 0 });
	});

	test("an h after $ spends the reach, and with it the to-the-end-of-the-line form", () => {
		// The same buffer and the same four keys as the case above, with one `h`:
		// the backward step is spent on the reach rather than moving the caret, so
		// the selection is still four wide and the redo takes the width. vim reads
		// `w_curswant` alone here, but its `oneleft` clears the MAXCOL even when the
		// reach absorbs the step — which is what the reach flag stands in for.
		expect(run("abcdef\nuvwxyz", 0, "l", "l", "v", "$", "h", "d", "j", "0", ".")).toMatchObject({
			text: "ab\nyz",
			cursor: 3,
		});
	});

	test("a selection over several lines is re-taken by the end's own column", () => {
		expect(run(SHORT, 0, "v", "j", "d", "0", ".")).toMatchObject({ text: "f\ngh", cursor: 0 });
		expect(run(SHORT, 0, "v", "j", "2", "l", "d", "0", ".")).toMatchObject({ text: "", cursor: 0 });
		// Three lines wide, the last of them an `h` short of its end, redone from
		// the top: the end is column 5 of the third line, wherever that lands.
		expect(run("ab\ncd\nefghij", 0, "v", "j", "h", "d", "0", ".")).toMatchObject({
			text: "fghij",
			cursor: 0,
		});
	});

	test("the replay comes back out of insert mode on its own", () => {
		// No Escape after the `.`: the original command's Escape is part of what the
		// redo repeats, and a replay left in insert mode would stop with the caret
		// on the insertion point — a position no NORMAL motion can be read against,
		// and one the user has to notice to get out of.
		const got = run(W, 0, "c", "w", "Z", "\x1b", "w", ".");
		expect(got).toMatchObject({ text: "Z Z three four", cursor: 2, mode: "normal" });
		expect(run(W, 4, "i", "X", "\x1b", "l", ".")).toMatchObject({
			text: "one XXtwo three four",
			cursor: 5,
			mode: "normal",
		});
		expect(run("a\nb", 0, "o", "X", "\x1b", "\x1b", "j", ".")).toMatchObject({
			text: "a\nX\nb\nX",
			cursor: 6,
			mode: "normal",
		});
	});

	test("a linewise Visual delete repeats the same number of lines", () => {
		expect(run(SHORT, 0, "V", "j", "d", "0", ".")).toMatchObject({ text: "", cursor: 0 });
	});

	test("the other Visual operators repeat as well", () => {
		expect(run("ab\ncd", 0, "v", ">", "j", ".")).toMatchObject({ text: "\tab\n\tcd", cursor: 5 });
		expect(run("ab\ncd", 0, "v", "<", "j", ".")).toMatchObject({ text: "ab\ncd", cursor: 3 });
		expect(run(SHORT, 0, "v", "c", "X", "\x1b", "j", ".", "\x1b")).toMatchObject({
			text: "Xb\nXd\nef\ngh",
			cursor: 3,
		});
		expect(run(SHORT, 0, "V", "c", "X", "\x1b", "\x1b", "j", ".", "\x1b")).toMatchObject({
			text: "X\nX\nef\ngh",
			cursor: 2,
		});
	});

	test("a charwise register across a line break lands the caret on its last character", () => {
		// `vjy` holds "b\nc" — the only register in this engine that can hold a
		// line break — and the two pastes differ from there: `p` before it, `P`
		// before the first character of the line above.
		expect(run("ab\ncd", 0, "v", "j", "y", "j", "p")).toMatchObject({ text: "ab\ncab\ncd", cursor: 4 });
		expect(run("ab\ncd", 0, "v", "j", "y", "j", "P")).toMatchObject({ text: "ab\nab\nccd", cursor: 3 });
	});
});

describe("Visual `r` writes over the selection", () => {
	// Every answer here was measured against vim 9.1 through the differential
	// harness; the same sequences are in `regress.mjs` so the two stay together.
	const run = (text: string, cursor: number, ...keys: string[]) => {
		const e = editor(text, cursor);
		for (const k of keys) {
			if (k === "\x1b") {
				e.engine.handleKey("", e.key({ escape: true }));
				continue;
			}
			e.engine.handleKey(k, e.key());
		}
		return { text: e.state.text, cursor: e.state.cursor, writes: e.writes(), mode: e.engine.mode };
	};
	const SHORT = "ab\ncd\nef\ngh";
	/** One character per line: a step inside a selection runs off the end. */
	const SOLO = "1\n2\n3\n4";

	test("it writes one character over the selection and leaves normal mode", () => {
		expect(run("abcdef", 0, "v", "r", "X")).toEqual({ text: "Xbcdef", cursor: 0, writes: 1, mode: "normal" });
		expect(run("abcdef", 0, "v", "l", "l", "r", "X")).toMatchObject({ text: "XXXdef", cursor: 0 });
		expect(run("abcdef", 0, "v", "$", "r", "X")).toMatchObject({ text: "XXXXXX", cursor: 0 });
	});

	test("a line break inside the selection stays a line break", () => {
		// The width is not a run of characters: `VrX` on "ab" is "XX", and the flat
		// answer "XXXXXX" is what a linewise selection read as text would give.
		expect(run(SHORT, 0, "V", "r", "X")).toMatchObject({ text: "XX\ncd\nef\ngh", cursor: 0 });
		expect(run(SHORT, 0, "V", "j", "r", "X")).toMatchObject({ text: "XX\nXX\nef\ngh", cursor: 0 });
		// Charwise, the break the selection took with it is kept the same way.
		expect(run(SHORT, 0, "v", "j", "r", "X")).toMatchObject({ text: "XX\nXd\nef\ngh", cursor: 0 });
		expect(run(SHORT, 0, "v", "2", "j", "r", "X")).toMatchObject({ text: "XX\nXX\nXf\ngh", cursor: 0 });
	});

	test("a count in front of the `r` is not its own, and a digit is a character", () => {
		expect(run("abcdef", 0, "v", "l", "3", "r", "X")).toMatchObject({ text: "XXcdef", cursor: 0 });
		expect(run("abcdef", 0, "v", "r", "2")).toMatchObject({ text: "2bcdef", cursor: 0 });
		expect(run("abcdef", 0, "v", "l", "r", "2")).toMatchObject({ text: "22cdef", cursor: 0 });
	});

	test("Escape cancels the half-typed character and keeps the selection", () => {
		expect(run("abcdef", 0, "v", "l", "r", "\x1b")).toEqual({ text: "abcdef", cursor: 1, writes: 0, mode: "visual" });
	});

	test("a key that is not a character cancels it too", () => {
		// Taken as the character to write, an empty one would write nothing over
		// every character of the selection and delete it. vim beeps and changes
		// nothing (measured on 9.1), which is what a cancel does here.
		for (const over of [
			{ rightArrow: true },
			{ downArrow: true },
			{ end: true },
			{ backspace: true },
			{ delete: true },
		]) {
			const e = editor("abcdef", 0);
			for (const k of ["v", "l", "r"]) e.engine.handleKey(k, e.key());
			e.engine.handleKey("", e.key(over));
			expect({ text: e.state.text, writes: e.writes(), mode: e.engine.mode }).toEqual({
				text: "abcdef",
				writes: 0,
				mode: "visual",
			});
		}
	});

	test("`<CR>` cancels it as well, where vim would write a carriage return", () => {
		// Not a line break: a Visual `r` goes to the operator, which writes the
		// character over each selected one, and a CR is a character there — measured
		// on 9.1, `vlr<CR>` on `"abcdef"` reads back as `"\r\rcdef"`, two literal CRs
		// in one line. (The NORMAL form is the one that breaks the line, and by only
		// one break however many characters the count covered; it is a second named
		// gap and `vim.ts` says so where the guard is.) Both are in the differential
		// README's Known gaps with the two measurements: this is a feature that is
		// not implemented, not a difference the instrument cannot see.
		const e = editor("abcdef", 0);
		for (const k of ["v", "l", "r"]) e.engine.handleKey(k, e.key());
		e.engine.handleKey("", e.key({ return: true }));
		expect({ text: e.state.text, writes: e.writes(), mode: e.engine.mode }).toEqual({
			text: "abcdef",
			writes: 0,
			mode: "visual",
		});
	});

	test("a pasted token inside the selection keeps its spelling", () => {
		// The rule every other command that rewrites a selection follows: a token's
		// own letters are its format, and overwriting one of them leaves a string
		// `PASTE_TOKEN_RE` no longer matches, so the payload is unreachable at submit.
		const text = `a ${PASTE_TOKEN} b`;
		const e = editor(text, 2);
		for (const k of ["v", "l", "r", "X"]) e.engine.handleKey(k, e.key());
		expect(e.state.text).toBe(`a ${PASTE_TOKEN}Xb`);
		expect(e.state.cursor).toBe(2);
		// A selection that is the token and nothing else writes the token back
		// unchanged — and is a change all the same, which is what the write count
		// says. Vim has no token, so this half is the engine's own rule; the other
		// half of it (a change that wrote nothing is still the redo) is measured.
		const only = editor(text, 2);
		for (const k of ["v", "r", "X"]) only.engine.handleKey(k, only.key());
		expect({ text: only.state.text, cursor: only.state.cursor, writes: only.writes() }).toEqual({
			text,
			cursor: 2,
			writes: 1,
		});
	});

	test("`.` reaches it, and what it repeats is the `r` and not the change before it", () => {
		// Every `.` here is on another line: a `.` over the character the `r` just
		// wrote looks the same whether it ran or not, which is how a redo that
		// refuses a Visual `r` passes a case meant to catch it.
		expect(run("abcdefgh\nij", 0, "v", "r", "X", "j", ".")).toMatchObject({ text: "Xbcdefgh\nXj", cursor: 9 });
		// The `x` is gone as the redo: a `.` that still held it would delete a
		// character rather than write one.
		expect(run("abcdefgh\nij", 0, "x", "v", "r", "X", "j", ".")).toMatchObject({ text: "Xcdefgh\nXj", cursor: 8 });
		expect(run("abcdefgh\nij", 0, "d", "w", "v", "r", "X", "j", ".")).toMatchObject({ text: "\nXj", cursor: 1 });
		// Linewise it is the whole line, twice over.
		expect(run("abcdefgh\nij\nkl", 0, "V", "r", "X", "j", ".")).toMatchObject({ text: "XXXXXXXX\nXX\nkl", cursor: 9 });
	});

	test("a replace that wrote the character already there is still the redo", () => {
		// The buffer reads the same before and after, so `writes` is what says a
		// change happened at all — and the `.` off the spot is what says it counts.
		expect(run("xx\nyy", 0, "v", "r", "x")).toEqual({ text: "xx\nyy", cursor: 0, writes: 1, mode: "normal" });
		expect(run("xx\nyy", 0, "v", "r", "x", "j", ".")).toMatchObject({ text: "xx\nxy", cursor: 3 });
		expect(run("xx\nyy", 0, "v", "l", "r", "x", "j", ".")).toMatchObject({ text: "xx\nxx", cursor: 3 });
	});

	test("a `.` pressed with a selection open is not a redo at all", () => {
		// Were the redo to run, the `Gvl` selection would take an `X`; it does not,
		// and the change the `r` made is still the redo afterwards.
		expect(run("ab\ncd\nef", 0, "V", "r", "X", "G", "v", "l", ".")).toMatchObject({ text: "XX\ncd\nef", cursor: 7 });
		expect(run("ab\ncd\nef", 0, "x", "V", "r", "X", "G", "v", "l", ".")).toMatchObject({
			text: "X\ncd\nef",
			cursor: 6,
		});
	});

	test("an undo leaves the redo where it was", () => {
		expect(run("abcdefgh", 0, "v", "r", "X", "u", ".")).toMatchObject({ text: "Xbcdefgh", cursor: 0 });
	});

	test("a count in front of `v`/`V` is spent on the command itself", () => {
		// nv_visual decrements the count once and runs nv_right / nv_down with what
		// is left (normal.c:5609-5615), so `2v` is two characters wide and a count
		// typed inside adds to it: `2v3l` is five, `v3l` is four.
		expect(run("abcdefghij", 0, "2", "v", "l", "d")).toMatchObject({ text: "defghij", cursor: 0 });
		expect(run("abcdefghij", 0, "3", "v", "l", "d")).toMatchObject({ text: "efghij", cursor: 0 });
		expect(run("abcdefghij", 0, "2", "v", "3", "l", "d")).toMatchObject({ text: "fghij", cursor: 0 });
		expect(run("abcdefghij", 0, "3", "v", "2", "l", "d")).toMatchObject({ text: "fghij", cursor: 0 });
		expect(run("abcdefghij", 0, "v", "3", "l", "d")).toMatchObject({ text: "efghij", cursor: 0 });
		expect(run("ab\ncd", 0, "2", "v", "d")).toMatchObject({ text: "\ncd", cursor: 0 });
		expect(run("abcdefghij", 0, "4", "v", "h", "d")).toMatchObject({ text: "defghij", cursor: 0 });
		// Linewise the same count is that many lines.
		expect(run("aa\nbb\ncc\ndd", 0, "2", "V", "j", "d")).toMatchObject({ text: "dd", cursor: 0 });
		expect(run("aa\nbb\ncc\ndd", 0, "2", "V", "j", "j", "d")).toMatchObject({ text: "", cursor: 0 });
	});

	test("a step past the end of the line carries the wanted column", () => {
		// Inside a selection `nv_right` counts the line break and stops with the
		// caret one character past the last one (normal.c:5822-5828). The engine
		// cannot stand there, so the wanted column is what carries the step: without
		// it the `j` after `vl` lands a line short and takes one line instead of two.
		expect(run(SOLO, 0, "v", "l", "j", "d")).toMatchObject({ text: "3\n4", cursor: 0 });
		expect(run(SOLO, 0, "v", "l", "j", "j", "d")).toMatchObject({ text: "4", cursor: 0 });
		// One step is all vim ever records past the end, however large the count.
		expect(run(SOLO, 0, "v", "4", "l", "j", "d")).toMatchObject({ text: "3\n4", cursor: 0 });
		expect(run(SOLO, 0, "2", "v", "j", "d")).toMatchObject({ text: "3\n4", cursor: 0 });
		expect(run(SOLO, 0, "2", "v", "j", "j", "d")).toMatchObject({ text: "4", cursor: 0 });
		// The same step onto a line that can fill the column is an ordinary move.
		expect(run("ab\nc\ndef", 0, "v", "l", "j", "d")).toMatchObject({ text: "def", cursor: 0 });
		expect(run("abcdef\ngh", 1, "v", "l", "j", "d")).toMatchObject({ text: "a", cursor: 0 });
	});
});
