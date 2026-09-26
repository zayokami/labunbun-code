import { describe, expect, test } from "bun:test";
import { EmacsEngine, type EmacsKey, emacsPrefixMinus } from "../src/emacs.ts";

/**
 * Unit tests for the Emacs engine.
 *
 * Two things about how these are written:
 *
 *   - **No source line numbers.** They rot, and a test that cites a line ends up asserting a
 *     comment. Every `file:line` citation lives in the implementation, next to the code it
 *     justifies.
 *   - **Nothing reads the Emacs tree.** These run in a bare checkout. The reference tree is
 *     `G:\Bunttta\emacs-master\`, and a test that only passes with it present fails on CI for a
 *     reason that has nothing to do with the engine.
 *
 * The `editor` fixture is the shape used by `vim-engine.test.ts`, reduced to the four operations
 * {@link EmacsEngine} asks of a host. `type` is the one thing that makes this modeless: it inserts
 * the character the engine declined, exactly as a real host would, so the engine's read-back of
 * "what did the host do with the key I returned `false` for" is exercised by every test that types.
 */
function editor(text: string, cursor = 0) {
	const state = { text, cursor };
	const writes: Array<{ text: string; cursor: number }> = [];
	const engine = new EmacsEngine({
		getText: () => state.text,
		getCursor: () => state.cursor,
		setCursor: (p) => {
			state.cursor = Math.max(0, Math.min(p, state.text.length));
		},
		setAll: (t, c) => {
			writes.push({ text: state.text, cursor: state.cursor });
			state.text = t;
			state.cursor = Math.max(0, Math.min(c, t.length));
		},
	});
	/** Feed one key and report whether the engine claimed it. */
	const press = (input: string, overrides: Partial<EmacsKey> = {}) => engine.handleKey(input, { ...overrides });
	/** Press the same key `n` times. */
	const repeat = (n: number, input: string, overrides: Partial<EmacsKey> = {}) => {
		for (let i = 0; i < n; i++) press(input, overrides);
	};
	/** Type text: every character must be declined by the engine and inserted by the host. */
	const type = (s: string) => {
		for (const ch of s) {
			expect(engine.handleKey(ch, {})).toBe(false);
			state.text = state.text.slice(0, state.cursor) + ch + state.text.slice(state.cursor);
			state.cursor += 1;
		}
	};
	return { engine, state, writes, press, repeat, type };
}

const C = { ctrl: true } as const;
const M = { meta: true } as const;
const CM = { ctrl: true, meta: true } as const;

describe("emacs: motion", () => {
	test("C-f and C-b step one code point, not one grapheme cluster", () => {
		// "a", "e", U+0301 COMBINING ACUTE, U+1F600 (two UTF-16 units), "b"
		const e = editor("aé\u{1F600}b");
		expect(e.press("f", C)).toBe(true);
		expect(e.state.cursor).toBe(1);
		e.repeat(2, "f", C);
		// past 'e' and the combining acute, which are one grapheme cluster and two characters
		expect(e.state.cursor).toBe(3);
		e.press("f", C);
		// and the emoji is one character in two units
		expect(e.state.cursor).toBe(5);
		e.press("f", C);
		expect(e.state.cursor).toBe(6);
		// At a buffer edge `move_point` sets the point and *then* signals, so the point is where
		// a clamp would have put it but `last-command` is not updated. The cursor alone cannot
		// tell the two apart — the fixture's `setCursor` clamps identically — so `last-command` is
		// what pins it, and a motion with an unrelated name is what gives it a value to stand at.
		e.press("e", C);
		expect(e.state.cursor).toBe(6);
		expect(e.engine.lastCommand).toBe("move-end-of-line");
		e.press("f", C);
		expect(e.state.cursor).toBe(6);
		expect(e.engine.lastCommand).toBe("move-end-of-line");
		e.press("a", C);
		expect(e.state.cursor).toBe(0);
		expect(e.engine.lastCommand).toBe("move-beginning-of-line");
		e.press("b", C);
		expect(e.state.cursor).toBe(0);
		expect(e.engine.lastCommand).toBe("move-beginning-of-line");
		e.repeat(5, "b", C);
		expect(e.state.cursor).toBe(0);
	});

	test("C-a and C-e address the logical line, not the buffer", () => {
		const e = editor("ab\ncdef\ngh", 4);
		expect(e.press("e", C)).toBe(true);
		expect(e.state.cursor).toBe(7);
		expect(e.press("a", C)).toBe(true);
		expect(e.state.cursor).toBe(3);
		// it is the start of *this* line, so pressing it again changes nothing…
		e.press("a", C);
		expect(e.state.cursor).toBe(3);
		// …and it is not the start of the buffer either
		expect(e.press("<", M)).toBe(true);
		expect(e.state.cursor).toBe(0);
	});

	test("M-< and M-> jump to the buffer edges", () => {
		const e = editor("hello", 3);
		expect(e.press("<", M)).toBe(true);
		expect(e.state.cursor).toBe(0);
		expect(e.press(">", M)).toBe(true);
		expect(e.state.cursor).toBe(5);
	});

	test("M-f stops where the character script changes", () => {
		const e = editor("foo中文bar", 0);
		e.press("f", M);
		expect(e.state.cursor).toBe(3);
		e.press("f", M);
		expect(e.state.cursor).toBe(5);
		e.press("f", M);
		expect(e.state.cursor).toBe(8);
		// `forward-word` clamps at the buffer edge *without* signalling, which is the opposite of
		// `forward-char` and is what `last-command` is here to tell apart
		e.press("e", C);
		expect(e.state.cursor).toBe(8);
		expect(e.engine.lastCommand).toBe("move-end-of-line");
		e.press("f", M);
		expect(e.state.cursor).toBe(8);
		expect(e.engine.lastCommand).toBe("forward-word");
	});

	test("M-b lands on a word's first character, not on the space before it", () => {
		const e = editor("foo中文bar", 8);
		e.press("b", M);
		expect(e.state.cursor).toBe(5);
		e.press("b", M);
		expect(e.state.cursor).toBe(3);
		e.press("b", M);
		expect(e.state.cursor).toBe(0);
		// and the buffer edge is a clamp that does *not* signal, unlike `backward-char`
		e.press("a", C);
		expect(e.engine.lastCommand).toBe("move-beginning-of-line");
		e.press("b", M);
		expect(e.state.cursor).toBe(0);
		expect(e.engine.lastCommand).toBe("backward-word");
	});

	test("Hiragana and Katakana share one script, so M-f does not stop between them", () => {
		const e = editor("あア", 0);
		e.press("f", M);
		expect(e.state.cursor).toBe(2);
	});

	test("word syntax puts $ and % inside a word and _ and - outside it", () => {
		const joined = editor("foo$bar", 0);
		joined.press("f", M);
		expect(joined.state.cursor).toBe(7);
		const split = editor("foo_bar", 0);
		split.press("f", M);
		expect(split.state.cursor).toBe(3);
	});

	test("an unhandled printable character is declined so the host types it", () => {
		const e = editor("", 0);
		expect(e.press("q")).toBe(false);
		e.type("hello");
		expect(e.state.text).toBe("hello");
	});

	test("Enter and Escape stay with the host and run no command", () => {
		// The return value alone does not pin this: an unbound printable also returns false, so
		// what has to be checked is the *state*. Both keys are declined before any command is
		// looked up, so `last-command` stands and the pending maps pop.
		const enter = editor("ab\ncd", 0);
		enter.press("k", C);
		expect(enter.engine.killRing).toEqual(["ab"]);
		expect(enter.press("r", { return: true })).toBe(false);
		// Enter is not charged a command. Had the tail of `handleKey` committed, last-command
		// would be nil here, the kill chain would break, and the next C-k would open a second
		// entry instead of appending.
		expect(enter.engine.lastCommand).toBe("kill-region");
		enter.press("k", C);
		expect(enter.engine.killRing).toEqual(["ab\n"]);

		// Escape pops the transient maps, which is observable only if the key that follows
		// behaves differently from the key that follows an *unpopped* one. C-x opens the ctl-x
		// map, whose only member is C-x; every other key there is read and dropped. C-f is
		// `forward-char` in the global map and nothing in the ctl-x map, so it moves iff the
		// map is gone.
		const escaped = editor("ab\ncd", 0);
		escaped.press("x", C);
		expect(escaped.press("x", { escape: true })).toBe(false);
		expect(escaped.press("f", C)).toBe(true);
		expect(escaped.state.cursor).toBe(1);
		expect(escaped.engine.lastCommand).toBe("forward-char");

		const stuck = editor("ab\ncd", 0);
		stuck.press("x", C);
		expect(stuck.press("f", C)).toBe(true);
		// consumed so the user is not typing into the prompt, but no command ran
		expect(stuck.state.cursor).toBe(0);
		expect(stuck.state.text).toBe("ab\ncd");
		expect(stuck.engine.lastCommand).toBeNull();
	});

	test("a key Emacs binds but this batch does not is consumed, not typed", () => {
		const e = editor("", 0);
		expect(e.press("t", C)).toBe(true);
		expect(e.press("t", M)).toBe(true);
		expect(e.press("t", CM)).toBe(true);
		expect(e.press("q", C)).toBe(true);
		expect(e.press("s", C)).toBe(true);
		expect(e.press("s", M)).toBe(true);
		// an unbound key is still the host's
		expect(e.press("v", C)).toBe(false);
		expect(e.state.text).toBe("");
	});
});

describe("emacs: prefix argument", () => {
	test("C-u C-u multiplies to sixteen", () => {
		const e = editor("abcdefghijklmnopqrstuvwxyz", 0);
		e.press("u", C);
		e.press("u", C);
		// still a cons: only `C-u 4` turns the argument into a plain number
		expect(e.engine.prefixArg).toEqual({ car: 16, cdr: [] });
		e.press("f", C);
		expect(e.state.cursor).toBe(16);
	});

	test("a single C-u is four, for a command that reads a number", () => {
		const e = editor("abcdefghij", 0);
		e.press("u", C);
		expect(e.engine.prefixArg).toEqual({ car: 4, cdr: [] });
		e.press("f", C);
		expect(e.state.cursor).toBe(4);
	});

	test("a prefix argument is not a command: C-u C-k still joins the last kill", () => {
		const prefixed = editor("ab\ncd", 0);
		prefixed.press("k", C);
		expect(prefixed.engine.killRing).toEqual(["ab"]);
		prefixed.press("u", C);
		prefixed.press("k", C);
		// arg 4 takes `kill-line`'s argument branch and kills through the newline, and the
		// chain was still open, so it joined the first entry rather than starting one
		expect(prefixed.engine.killRing).toEqual(["ab\n"]);
		expect(prefixed.engine.killRing.length).toBe(1);
		expect(prefixed.state.text).toBe("cd");
		expect(prefixed.engine.lastCommand).toBe("kill-region");

		// the control: `C-n` *is* a command, so the very next C-k starts a new entry
		const commanded = editor("ab\ncd", 0);
		commanded.press("k", C);
		commanded.press("n", C);
		commanded.press("k", C);
		expect(commanded.engine.killRing).toEqual(["cd", "ab"]);
		expect(commanded.engine.killRing.length).toBe(2);
	});

	test("M-- is the symbol '-', and a digit after it counts downward", () => {
		const e = editor("abc", 0);
		expect(e.press("-", M)).toBe(true);
		expect(e.engine.prefixArg).toBe("-");
		e.press("5");
		expect(e.engine.prefixArg).toBe(-5);
	});

	test("M-- twice cancels back to no argument", () => {
		const e = editor("abc", 0);
		e.press("-", M);
		expect(e.engine.prefixArg).toBe("-");
		e.press("-", M);
		expect(e.engine.prefixArg).toBeNull();
	});

	test("C-u M-b hands backward-word a number, and four M-b land in the same place", () => {
		const counted = editor("aa bb cc dd ee", 14);
		counted.press("u", C);
		counted.press("b", M);
		expect(counted.state.cursor).toBe(3);
		const repeated = editor("aa bb cc dd ee", 14);
		repeated.repeat(4, "b", M);
		expect(repeated.state.cursor).toBe(3);
	});

	test("negating a cons keeps the cons and negates only its car", () => {
		expect(emacsPrefixMinus({ car: 4, cdr: [] })).toEqual({ car: -4, cdr: [] });
		expect(emacsPrefixMinus(4)).toBe(-4);
		expect(emacsPrefixMinus("-")).toBe(-1);
		expect(emacsPrefixMinus(null)).toBeNull();
	});
});

describe("emacs: kill ring", () => {
	test("a bare C-d deletes without touching the ring; C-u C-d kills into it", () => {
		const plain = editor("hello", 0);
		plain.press("d", C);
		expect(plain.state.text).toBe("ello");
		expect(plain.engine.killRing).toEqual([]);

		const counted = editor("hello", 0);
		counted.press("u", C);
		counted.press("d", C);
		expect(counted.state.text).toBe("o");
		expect(counted.engine.killRing).toEqual(["hell"]);
	});

	test("C-u C-d then C-y puts back exactly what the count deleted", () => {
		const e = editor("hello", 0);
		e.press("u", C);
		e.press("d", C);
		expect(e.state.text).toBe("o");
		e.press("y", C);
		expect(e.state.text).toBe("hello");
		expect(e.state.cursor).toBe(4);
		// push-mark puts the mark at the old point, and the paste does not activate it
		expect(e.engine.mark).toBe(0);
		expect(e.engine.markActive).toBe(false);
	});

	test("C-k with nothing left on the line kills the line break too", () => {
		// point is at end of line: the range to end of line is empty, which is vacuously all
		// blanks, so the branch that moves to the next line's start is the one that runs
		const atEol = editor("ab\ncd", 2);
		atEol.press("k", C);
		expect(atEol.engine.killRing).toEqual(["\n"]);
		expect(atEol.state.text).toBe("abcd");
		expect(atEol.state.cursor).toBe(2);

		// a line whose tail is only spaces counts the same way, because
		// `show-trailing-whitespace` is nil
		const blanks = editor("ab   \ncd", 2);
		blanks.press("k", C);
		expect(blanks.engine.killRing).toEqual(["   \n"]);
		expect(blanks.state.text).toBe("abcd");
		expect(blanks.state.cursor).toBe(2);

		// the control: a nonblank stops the kill before the line break
		const real = editor("ab cd\nef", 0);
		real.press("k", C);
		expect(real.engine.killRing).toEqual(["ab cd"]);
		expect(real.state.text).toBe("\nef");
	});

	test("two C-k in a row join, and the ring does not grow", () => {
		const e = editor("abcd\nefgh", 2);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["cd"]);
		expect(e.state.text).toBe("ab\nefgh");
		e.press("k", C);
		// the second kill is the newline, appended to the first
		expect(e.engine.killRing).toEqual(["cd\n"]);
		expect(e.engine.killRing.length).toBe(1);
		expect(e.state.text).toBe("abefgh");
		expect(e.state.cursor).toBe(2);
	});

	test("a long run of C-k keeps the ring at one entry", () => {
		const e = editor("a b c\nd e f\ng h i", 2);
		e.repeat(5, "k", C);
		expect(e.engine.killRing).toEqual(["b c\nd e f\ng h i"]);
		expect(e.engine.killRing.length).toBe(1);
		expect(e.state.text).toBe("a ");
		expect(e.state.cursor).toBe(2);
	});

	test("a C-k after a cursor move starts a new ring entry", () => {
		const e = editor("ab\ncd", 0);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["ab"]);
		e.press("f", C);
		expect(e.state.cursor).toBe(1);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["cd", "ab"]);
		expect(e.state.text).toBe("\n");
		expect(e.state.cursor).toBe(1);
	});

	test("C-0 C-k kills backward and therefore prepends, which a bare C-k never can", () => {
		const arm = () => {
			const e = editor("abcdefghij", 3);
			e.press(" ", C); // C-SPC sets the mark at 3
			e.repeat(3, "f", C); // point at 6
			e.press("w", C); // kills [3,6) forwards
			expect(e.engine.killRing).toEqual(["def"]);
			expect(e.state.text).toBe("abcghij");
			expect(e.state.cursor).toBe(3);
			return e;
		};

		const prepended = arm();
		prepended.press("0", C); // digit-argument 0 — the transient map is open
		prepended.press("k", C);
		// 0 is not nil, so `kill-line` takes the argument branch and kills backward, to the
		// start of the line — which leaves "ghij" on the line and puts "abc" in *front* of
		// the existing entry
		expect(prepended.engine.killRing).toEqual(["abcdef"]);
		expect(prepended.state.text).toBe("ghij");
		expect(prepended.state.cursor).toBe(0);

		// the control: a bare C-k at the very same spot appends instead
		const appended = arm();
		appended.press("k", C);
		expect(appended.engine.killRing).toEqual(["defghij"]);
		expect(appended.state.text).toBe("abc");
		expect(appended.state.cursor).toBe(3);
	});

	test("M-w copies the region without killing it, and a following C-w is a second copy", () => {
		const e = editor("abcdefghij", 3);
		e.press(" ", C); // C-SPC sets the mark at 3
		e.repeat(7, "f", C);
		e.press("w", M);
		expect(e.state.text).toBe("abcdefghij");
		expect(e.state.cursor).toBe(10);
		expect(e.engine.killRing).toEqual(["defghij"]);
		e.press("w", C);
		// two entries, not one appended copy: M-w left last-command alone
		expect(e.engine.killRing).toEqual(["defghij", "defghij"]);
		expect(e.state.text).toBe("abc");
	});

	test("M-C-w bridges kills that were not consecutive commands", () => {
		const e = editor("abcdef\nxy", 0);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["abcdef"]);
		e.press("f", C); // a motion: enough to break a chain on its own
		e.press("w", CM);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["abcdefxy"]);
		expect(e.engine.killRing.length).toBe(1);
		expect(e.state.text).toBe("\n");
	});

	test("M-C-w on its own is consumed and arms the next kill to append", () => {
		const e = editor("abcdef", 0);
		expect(e.press("w", CM)).toBe(true);
		expect(e.state.text).toBe("abcdef");
		expect(e.state.cursor).toBe(0);
		expect(e.engine.killRing).toEqual([]);
		// the whole point of the key: last-command now names the command the *next* kill
		// should join, and the key itself touched no text
		expect(e.engine.lastCommand).toBe("kill-region");
	});

	test("M-d kills a word forward and C-backspace kills one backward", () => {
		const forward = editor("aa bb cc", 0);
		forward.press("d", M);
		expect(forward.state.text).toBe(" bb cc");
		expect(forward.engine.killRing).toEqual(["aa"]);

		const backward = editor("aa bb cc", 8);
		backward.press("x", { ctrlBackspace: true });
		expect(backward.state.text).toBe("aa bb ");
		expect(backward.engine.killRing).toEqual(["cc"]);
	});

	test("a counted C-h kills into the ring; a bare C-h does not", () => {
		const counted = editor("hello", 5);
		counted.press("1", C);
		counted.press("h", C);
		expect(counted.engine.killRing).toEqual(["o"]);
		expect(counted.state.text).toBe("hell");

		const plain = editor("hello", 5);
		plain.press("h", C);
		expect(plain.engine.killRing).toEqual([]);
		expect(plain.state.text).toBe("hell");
	});

	test("a counted C-h ignores the region that a bare C-h would swallow", () => {
		const region = editor("hello world", 0);
		region.press(" ", C); // C-SPC at 0
		region.repeat(5, "f", C);
		expect(region.engine.markActive).toBe(true);
		region.press("h", C);
		// the count is 1, so the region applies and the whole span goes
		expect(region.state.text).toBe(" world");
		expect(region.state.cursor).toBe(0);
		expect(region.engine.killRing).toEqual([]);

		const counted = editor("hello world", 0);
		counted.press(" ", C);
		counted.repeat(5, "f", C);
		expect(counted.engine.markActive).toBe(true);
		counted.press("2", M);
		counted.press("h", C);
		// the count is 2, so the region is not consulted, and a count also means kill
		expect(counted.state.text).toBe("hel world");
		expect(counted.state.cursor).toBe(3);
		expect(counted.engine.killRing).toEqual(["lo"]);
	});

	test("<deletechar> counts as a kill, and a bare one is not", () => {
		// The same killflag rule as `C-d`, and it is a separate implementation of it:
		// `C-d` is `delete-char` (the C primitive) while <deletechar> is
		// `delete-forward-char` (the lisp function), and the engine routes them to different
		// call sites. A rule that only one of the two honours is a bug waiting for the key.
		const plain = editor("hello", 0);
		expect(plain.press("", { delete: true })).toBe(true);
		expect(plain.state.text).toBe("ello");
		expect(plain.engine.killRing).toEqual([]);

		const counted = editor("hello", 0);
		counted.press("u", C);
		expect(counted.press("", { delete: true })).toBe(true);
		expect(counted.state.text).toBe("o");
		expect(counted.engine.killRing).toEqual(["hell"]);
	});

	test("a counted <deletechar> ignores the region that a bare one would swallow", () => {
		const region = editor("hello world", 0);
		region.press(" ", C); // C-SPC at 0
		region.repeat(5, "f", C);
		expect(region.engine.markActive).toBe(true);
		expect(region.press("", { delete: true })).toBe(true);
		// no count, so the region applies and the whole span goes
		expect(region.state.text).toBe(" world");
		expect(region.state.cursor).toBe(0);

		const counted = editor("hello world", 5);
		counted.press(" ", C); // C-SPC at 5
		counted.repeat(2, "b", C); // point back to 3, so the region is 3..5
		expect(counted.engine.markActive).toBe(true);
		counted.press("4", M);
		expect(counted.press("", { delete: true })).toBe(true);
		// The count is 4, so the region is not consulted: this deletes 3..7 ("lo w") and leaves
		// "hel" + "orld". The region alone would have stopped at 5 and left "helo world". The
		// two spans are made different on purpose — a count that happened to cover exactly the
		// region could not tell the guard from its absence, and the point must not be parked on
		// the mark either, because a collapsed region is not a region (`use-region-p`).
		expect(counted.state.text).toBe("helorld");
		expect(counted.state.cursor).toBe(3);
		expect(counted.engine.killRing).toEqual(["lo w"]);
	});

	test("C-S-backspace kills from the point, not from the beginning of the line", () => {
		// The first `kill-region` of `kill-whole-line` is empty for a positive count, because
		// `region1-end` is `(save-excursion (forward-visible-line 0) (point-marker))` — the point
		// itself, since `forward-visible-line 0` does not move. So the "a" before the point stays
		// on the line, and only "aa\n" goes to the ring. An implementation that computed
		// `region1-end` as the beginning of the line would give ["aaa\n"] and leave "bbb\nccc".
		const e = editor("aaa\nbbb\nccc", 1);
		expect(e.press("x", { ctrlShiftBackspace: true })).toBe(true);
		expect(e.engine.killRing).toEqual(["aa\n"]);
		expect(e.engine.killRing.length).toBe(1);
		expect(e.state.text).toBe("abbb\nccc");
		expect(e.state.cursor).toBe(1);
	});

	test("C-S-backspace with a negative count is the one that reaches back before the point", () => {
		// `(< arg 0)` takes the only branch whose first region is not empty: point to end of line
		// is appended, and then the far end — the start of the line above minus one character —
		// is *prepended*, which is why the entry reads back-to-front and not in buffer order.
		const e = editor("aaa\nbbb\nccc", 5);
		e.press("-", M);
		expect(e.press("x", { ctrlShiftBackspace: true })).toBe(true);
		expect(e.engine.killRing).toEqual(["\nbbb"]);
		expect(e.engine.killRing.length).toBe(1);
		expect(e.state.text).toBe("aaa\nccc");
		expect(e.state.cursor).toBe(3);
	});

	test("C-S-backspace onto an open chain seeds nothing and joins the last kill", () => {
		// This is the half that makes the `(kill-new "")` seed load-bearing. On its own it changes
		// nothing observable, because the first `kill-region` would have pushed the entry anyway;
		// with the chain already open the seed is skipped, both kills append, and the ring keeps
		// exactly one entry. An implementation that always seeded would have two.
		const e = editor("aaa\nbbb\nccc", 1);
		e.press("d", M); // one word forward, which is a kill and so opens the chain
		expect(e.engine.killRing).toEqual(["aa"]);
		expect(e.state.text).toBe("a\nbbb\nccc");
		expect(e.state.cursor).toBe(1);
		expect(e.engine.lastCommand).toBe("kill-region");
		e.press("x", { ctrlShiftBackspace: true });
		// the empty first region appended nothing and the second one appended the line break
		expect(e.engine.killRing).toEqual(["aa\n"]);
		expect(e.engine.killRing.length).toBe(1);
		expect(e.state.text).toBe("abbb\nccc");
		expect(e.state.cursor).toBe(1);
	});
});

describe("emacs: yank rotation", () => {
	test("a bare C-y never rotates, and M-y walks backwards through the ring", () => {
		const e = editor("aaaa\nbb", 0);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["aaaa"]);
		e.press("f", C);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["bb", "aaaa"]);
		expect(e.engine.yankPointer).toBe(0);

		e.press("y", C);
		expect(e.state.text).toBe("\nbb");
		expect(e.state.cursor).toBe(3);
		expect(e.engine.mark).toBe(1);
		// a bare `C-y` rotates zero however long the ring is
		expect(e.engine.yankPointer).toBe(0);

		e.press("y", M);
		expect(e.state.text).toBe("\naaaa");
		expect(e.state.cursor).toBe(5);
		expect(e.engine.mark).toBe(1);
		expect(e.engine.yankPointer).toBe(1);

		// and it wraps, because the pointer is a tail of the list
		e.press("y", M);
		expect(e.state.text).toBe("\nbb");
		expect(e.state.cursor).toBe(3);
		expect(e.engine.yankPointer).toBe(0);
	});

	test("C-u C-y pastes the same kill with point and mark the other way round", () => {
		const plain = editor("hello", 0);
		plain.press("k", C);
		plain.press("y", C);
		expect(plain.state.text).toBe("hello");
		expect(plain.state.cursor).toBe(5);
		expect(plain.engine.mark).toBe(0);
		expect(plain.engine.yankPointer).toBe(0);

		const reversed = editor("hello", 0);
		reversed.press("k", C);
		reversed.press("u", C);
		reversed.press("y", C);
		// the same text and the same ring position; only the geometry differs
		expect(reversed.state.text).toBe("hello");
		expect(reversed.engine.yankPointer).toBe(0);
		expect(reversed.state.cursor).toBe(0);
		expect(reversed.engine.mark).toBe(5);
	});

	test("C-0 M-y rotates nothing, because 0 is a count and not an absence", () => {
		// Two entries in the ring, so a rotation of one and a rotation of zero differ. The
		// recipe is the one the bare-`C-y` test above uses, so a change to either shows up
		// in both rather than in one of them.
		const build = () => {
			const e = editor("aaaa\nbb", 0);
			e.press("k", C);
			e.press("f", C);
			e.press("k", C);
			expect(e.engine.killRing).toEqual(["bb", "aaaa"]);
			e.press("y", C);
			return e;
		};

		// The control: a plain M-y does move.
		const control = build();
		expect(control.engine.yankPointer).toBe(0);
		expect(control.press("y", M)).toBe(true);
		expect(control.engine.yankPointer).toBe(1);

		// And C-0 M-y does not. `(unless arg (setq arg 1))` is on `nil`, and `C-0` supplies
		// a *number* — in Lisp 0 is truthy, so the guard does not fire and the rotation is
		// zero. Ported as `n || 1`, JavaScript's falsy `0` would move the pointer instead,
		// which is exactly what this test exists to hold shut.
		const zero = build();
		expect(zero.press("0", C)).toBe(true);
		expect(zero.press("y", M)).toBe(true);
		expect(zero.engine.yankPointer).toBe(0);
		expect(zero.state.text).toBe("\nbb");
	});

	test("M-y after anything but a yank is taken and does nothing", () => {
		const e = editor("abc", 0);
		e.press("k", C);
		expect(e.press("y", M)).toBe(true);
		expect(e.state.text).toBe("");
		expect(e.state.cursor).toBe(0);
		// nothing was inserted, so last-command must not claim a yank happened
		expect(e.engine.lastCommand).toBe("kill-region");
	});
});

describe("emacs: mark and region", () => {
	test("C-SPC sets and activates the mark, and twice deactivates it", () => {
		const e = editor("hello", 2);
		expect(e.press(" ", C)).toBe(true);
		expect(e.engine.mark).toBe(2);
		expect(e.engine.markActive).toBe(true);
		e.press(" ", C);
		expect(e.engine.mark).toBe(2);
		expect(e.engine.markActive).toBe(false);
		e.press(" ", C);
		expect(e.engine.markActive).toBe(true);
	});

	test("C-w on a collapsed selection kills nothing and leaves the buffer alone", () => {
		const e = editor("hello", 2);
		e.press(" ", C);
		e.press(" ", C); // deactivate
		expect(e.engine.markActive).toBe(false);
		expect(e.press("w", C)).toBe(true);
		expect(e.state.text).toBe("hello");
		expect(e.state.cursor).toBe(2);
		// the empty kill is still an entry: killing nothing is not the same as not killing
		expect(e.engine.killRing).toEqual([""]);
		expect(e.engine.lastCommand).toBe("kill-region");
	});

	test("C-w with no mark at all is refused, and records no command", () => {
		const e = editor("hello", 2);
		expect(e.press("f", C)).toBe(true);
		expect(e.engine.lastCommand).toBe("forward-char");
		expect(e.press("w", C)).toBe(true);
		expect(e.state.text).toBe("hello");
		expect(e.engine.killRing).toEqual([]);
		// the user-error leaves last-command standing
		expect(e.engine.lastCommand).toBe("forward-char");
	});

	test("one typed character ends the region, and the mark rides along", () => {
		const e = editor("hello", 0);
		e.press(" ", C);
		e.repeat(3, "f", C);
		expect(e.engine.markActive).toBe(true);
		e.type("X");
		expect(e.state.text).toBe("helXlo");
		// the read-back happens on the next key, which is where the state catches up
		e.press("f", C);
		expect(e.engine.markActive).toBe(false);
		// the mark was *before* the insertion, so it did not move
		expect(e.engine.mark).toBe(0);
		// and the consequence is visible: a bare C-h now takes one character, not the region
		e.press("h", C);
		expect(e.state.text).toBe("helXo");
		expect(e.state.cursor).toBe(4);
	});

	test("C-x C-x exchanges point and mark and activates the region", () => {
		const e = editor("hello world", 4);
		e.press(" ", C);
		e.repeat(2, "f", C);
		expect(e.engine.mark).toBe(4);
		expect(e.state.cursor).toBe(6);
		expect(e.press("x", C)).toBe(true); // C-x, the prefix key
		expect(e.press("x", C)).toBe(true);
		expect(e.state.cursor).toBe(4);
		expect(e.engine.mark).toBe(6);
		expect(e.engine.markActive).toBe(true);
	});

	test("C-u C-SPC jumps to the mark, and C-u C-u C-SPC sets it again", () => {
		const e = editor("hello world", 2);
		e.press(" ", C); // mark at 2
		e.repeat(8, "f", C); // point at 10
		e.press("u", C);
		e.press(" ", C); // C-u C-SPC jumps to the mark
		expect(e.state.cursor).toBe(2);
		// the jump popped the ring and deactivated the mark
		expect(e.engine.markActive).toBe(false);
		expect(e.engine.mark).toBe(2);

		e.press("u", C);
		e.press("u", C);
		e.press(" ", C); // C-u C-u C-SPC sets the mark unconditionally
		expect(e.engine.mark).toBe(2);
		expect(e.engine.markActive).toBe(true);
	});

	test("C-x followed by a reserved member is consumed and runs nothing", () => {
		const e = editor("abc", 0);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["abc"]);
		e.press("x", C);
		expect(e.press("h", C)).toBe(true); // C-x C-h, mark-whole-buffer, not implemented
		expect(e.engine.killRing).toEqual(["abc"]);
		// last-command became nil, so the chain is broken
		expect(e.engine.lastCommand).toBeNull();
	});
});

describe("emacs: vertical motion", () => {
	test("the goal column survives a run of C-n and is re-seeded by anything else", () => {
		//     0123 456789 01 2345678
		const e = editor("abc\ndefgh\nij\nklmnop", 0);
		e.press("n", C);
		expect(e.state.cursor).toBe(4);
		e.press("n", C);
		expect(e.state.cursor).toBe(10);
		e.press("e", C);
		expect(e.state.cursor).toBe(12);
		e.press("n", C);
		// C-e re-seeded the goal column to 2, so the next line keeps column 2
		expect(e.state.cursor).toBe(15);

		// the control: four C-ns with nothing in between hold column 0 all the way, and the
		// last line is reached through its *start* rather than at the end of the buffer
		const straight = editor("abc\ndefgh\nij\nklmnop", 0);
		straight.repeat(4, "n", C);
		expect(straight.state.cursor).toBe(13);
	});

	test("C-e re-seeds the goal column, so the next C-n uses the new one", () => {
		const e = editor("abcdef\nabcdef\ngh", 5);
		e.press("n", C);
		// the seeded goal was column 5, so the second line is used from there
		expect(e.state.cursor).toBe(12);
		e.press("e", C);
		expect(e.state.cursor).toBe(13);
		e.press("n", C);
		// C-e re-seeded to column 6, not the run's 5, and the two-character last line clamps
		// to its *end*. Column 5 would have given 15; clamping to the start would give 14.
		expect(e.state.cursor).toBe(16);
	});

	test("moving down onto a short line clamps to its end and does not re-seed the goal", () => {
		const e = editor("abcdef\nxy\nab", 4);
		e.press("n", C);
		// column 4 does not exist on "xy", so the landing is its end
		expect(e.state.cursor).toBe(9);
		expect(e.engine.temporaryGoalColumn).toBe(4);
		e.press("n", C);
		expect(e.state.cursor).toBe(12);
	});

	test("moving up onto a short line clamps to its end too, not to its beginning", () => {
		const e = editor("ab\nxy\nabcdef", 10);
		e.press("p", C);
		expect(e.state.cursor).toBe(5);
	});

	test("a C-n that overshoots lands on the goal column of the last line", () => {
		const e = editor("abcdef\nxy\ncdefgh", 4);
		e.press("n", C);
		// the goal column is 4 and "xy" is two wide, so this clamps to its end
		expect(e.state.cursor).toBe(9);
		e.press("u", C);
		e.press("n", C);
		// there is no fourth line, but "cdefgh" is not empty, so it counts as one line moved
		// and the goal column applies to *it*: 14. Signalling would have left 9, clamping to
		// the end of the buffer would have given 16, and landing at the end of the line it
		// left would have given 9 again.
		expect(e.state.cursor).toBe(14);
		expect(e.engine.lastCommand).toBe("next-line");
	});

	test("C-n off a buffer that ends in an empty line signals instead of landing", () => {
		const e = editor("ab\ncdefgh\n", 1);
		e.press("n", C);
		expect(e.state.cursor).toBe(4);
		// the trailing line break makes a third line, and an empty line is still a line: it is
		// reached, and `forward-line` counts it
		e.press("n", C);
		expect(e.state.cursor).toBe(10);
		expect(e.engine.lastCommand).toBe("next-line");
		// `C-a` is a no-op here, but it re-seeds the goal column to 0 and, more to the point,
		// leaves a standing `last-command` that is *not* a line motion. Without that the
		// assertion below could not tell a signal from a successful move, because both would
		// leave `next-line` behind.
		e.press("a", C);
		expect(e.engine.lastCommand).toBe("move-beginning-of-line");
		e.press("n", C);
		// there is no line to move to, and the one point is on is empty, so there is nothing for
		// `forward-line` to count as a line moved and the signal is raised
		expect(e.state.cursor).toBe(10);
		expect(e.engine.lastCommand).toBe("move-beginning-of-line");
	});

	test("C-p off the top signals, so the point does not move and the command is not recorded", () => {
		const e = editor("ab\ncd", 3);
		// a last-command that is *not* the line motion, so that "the command was recorded" and
		// "the command ran" are different observations
		expect(e.press("f", C)).toBe(true);
		expect(e.press("p", C)).toBe(true);
		// the move happened, so last-command moved with it. Column 1, not 0: last-command is
		// `forward-char` rather than a line motion, so the goal column is re-seeded to 1.
		expect(e.state.cursor).toBe(1);
		expect(e.engine.lastCommand).toBe("previous-line");
		// back to column 0 of the top line, again with a non-line-motion last-command
		expect(e.press("a", C)).toBe(true);
		expect(e.state.cursor).toBe(0);
		expect(e.engine.lastCommand).toBe("move-beginning-of-line");
		// this one overshoots. The key is still taken — the signal happens inside the command —
		// but the point stands and the tail of the command loop is never reached, so last-command
		// stands where the *previous* command left it.
		expect(e.press("p", C)).toBe(true);
		expect(e.state.cursor).toBe(0);
		expect(e.engine.lastCommand).toBe("move-beginning-of-line");
	});
});
