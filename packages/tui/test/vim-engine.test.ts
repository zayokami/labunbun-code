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
	motionWordEndHere,
	VimEngine,
	type VimKey,
} from "../src/vim.ts";

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

	test("/ and : hold their input line and drop it", () => {
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

	test("Enter still submits from one, and Escape still cancels it", () => {
		const submit = editor("abc def\n", 0);
		submit.engine.handleKey("/", submit.key());
		submit.engine.handleKey("f", submit.key());
		expect(submit.engine.handleKey("", submit.key({ return: true }))).toBe(false);
		expect(submit.state.text).toBe("abc def\n"); // the half-typed search went with it
		submit.engine.handleKey("w", submit.key());
		expect(submit.state.cursor).toBe(4);

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
