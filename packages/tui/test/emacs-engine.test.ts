import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	CTL_X_RESERVED,
	EmacsEngine,
	type EmacsKey,
	emacsCasify,
	emacsIsWordChar,
	emacsKeyToken,
	emacsPrefixCar,
	emacsPrefixForwardChars,
	emacsPrefixMinus,
	emacsPrefixValue,
	emacsScriptOf,
	emacsWordBackward,
	emacsWordForward,
	RESERVED_KEYS,
} from "../src/emacs.ts";

/**
 * Unit tests for the Emacs engine.
 *
 * Two things about how these are written, and both of them needed qualifying as the batches went
 * on:
 *
 *   - **No source line numbers in an assertion.** They rot, and a test that cites a line ends up
 *     asserting a comment. Every `file:line` citation lives in the implementation, next to the code
 *     it justifies. The one test that *does* read a citation ({@link EmacsEngine}'s) is the
 *     exception that proves the rule is about assertions and not about numbers: it checks the
 *     implementation's citations against the reference tree, so a citation that has drifted is
 *     caught where it is written instead of being copied into a test that would go on passing.
 *   - **Nothing here requires the reference trees.** These run in a bare checkout. The Emacs tree
 *     is `G:\Bunttta\emacs-master\` and the uemacs tree is `G:\Bunttta\uemacs-master\`, and a
 *     test that only passes with them present fails on CI for a reason that has nothing to do with
 *     the engine. The citation guard is `existsSync`-gated for the same reason: present, it
 *     checks; absent, it skips and says so.
 *
 * The `editor` fixture is the shape used by `vim-engine.test.ts`, reduced to the operations
 * {@link EmacsEngine} asks of a host. `type` is the one thing that makes this modeless: it inserts
 * the character the engine declined, exactly as a real host would, so the engine's read-back of
 * "what did the host do with the key I returned `false` for" is exercised by every test that types.
 *
 * The fixture keeps a **real undo stack** rather than a counter. `EmacsEngine` has no stack of its
 * own — every change is one `setAll`, and undo is the host's — so a fixture that faked `undo` with
 * a toggle would let an engine that did nothing at all pass the undo tests.
 */
function editor(text: string, cursor = 0) {
	const state = { text, cursor };
	const writes: Array<{ text: string; cursor: number }> = [];
	const undoStack: Array<{ text: string; cursor: number }> = [];
	const engine = new EmacsEngine({
		getText: () => state.text,
		getCursor: () => state.cursor,
		setCursor: (p) => {
			state.cursor = Math.max(0, Math.min(p, state.text.length));
		},
		setAll: (t, c) => {
			writes.push({ text: state.text, cursor: state.cursor });
			undoStack.push({ text: state.text, cursor: state.cursor });
			state.text = t;
			state.cursor = Math.max(0, Math.min(c, t.length));
		},
		undo: () => {
			const prev = undoStack.pop();
			if (!prev) return;
			state.text = prev.text;
			state.cursor = Math.max(0, Math.min(prev.cursor, state.text.length));
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
	/** How deep the host's undo stack is, which is what a `C-u 4 C-x u` reads. */
	const undoDepth = () => undoStack.length;
	return { engine, state, writes, press, repeat, type, undoDepth };
}

const C = { ctrl: true } as const;
const M = { meta: true } as const;
const CM = { ctrl: true, meta: true } as const;

/**
 * The keypress a token in either reserved table is.
 *
 * The split on `-` is the whole of it, with one exception: `emacsKeyToken` spells ctrl+space as
 * `C-SPC`, so pressing the literal string `"SPC"` would test a key no terminal sends.
 */
function pressToken(e: ReturnType<typeof editor>, token: string): boolean {
	const parts = token.split("-");
	const last = parts.pop() ?? "";
	const key: EmacsKey = {};
	if (parts.includes("C")) key.ctrl = true;
	if (parts.includes("M")) key.meta = true;
	return e.press(last === "SPC" ? " " : last, key);
}

/**
 * `C-x` then a member of `ctl-x-map`, which is how every `C-x` command is reached.
 *
 * The member is spelled the way {@link CTL_X_RESERVED} spells it — a *raw* key spelling, because
 * that is what the dispatch compares — so the reserved members (`t`, `C-@`, ` `) and the
 * implemented ones (`C-x`, `u`, `C-u`, `C-l`, `C-o`) come out of two vocabularies on purpose. The
 * two reserved tables
 * do not agree on spelling either: `RESERVED_KEYS` is keyed by `emacsKeyToken`, so a ctrl+meta key
 * there is `C-M-t`, while `CTL_X_RESERVED` holds `t` and `C-@` as themselves.
 *
 * This doc used to assert the opposite for one member, and it is worth recording why it was wrong
 * rather than quietly restating it. It said `C-x u` is `pressCtlX(e, "C-u")` "and not `\"u\"`",
 * on the grounds that a bare `u` "would type a literal `u` into the prompt". It would have — the
 * dispatch compared `key.ctrl && input === "u"`, so the modifier *was* the member and the binding
 * string in `bindings.el:1246` was being overridden by a test helper's spelling of it. A fixture
 * that names a key the way the code compares it cannot notice when the comparison is the thing
 * that is wrong. `C-x u` is `pressCtlX(e, "u")`, and there is a test below that presses the raw
 * `C-x C-u` and reads the region it upcased — the same helper with `C-u` for the member.
 */
function pressCtlX(e: ReturnType<typeof editor>, member: string): boolean {
	e.press("x", C);
	return pressToken(e, member);
}

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

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

describe("emacs: undo", () => {
	test("C-x u puts the text and the cursor back, and the cursor is the half that matters", () => {
		// The manual's own words, and the reason the ops interface takes one call rather than
		// two: "This undoes the most recent change in the buffer, and moves point back to where
		// it was before that change" (`doc/emacs/fixit.texi:61-62`). An undo that restored the
		// text and left the cursor where it was would be a rewind the user then has to find
		// their way out of.
		// `C-k` kills to the end of the *line*, so the cursor is on line one and what goes is
		// the second one — the join is the point, so the restored buffer is not the buffer a
		// `C-k` from the end would have produced.
		const e = editor("abc\ndefgh", 3);
		e.press("k", C);
		expect(e.state.text).toBe("abcdefgh");
		e.press("x", C);
		expect(e.press("u")).toBe(true);
		expect(e.state.text).toBe("abc\ndefgh");
		expect(e.state.cursor).toBe(3);
		// One entry gone from the host's stack, which is the only stack there is.
		expect(e.undoDepth()).toBe(0);
	});

	test("C-x u is a command, so it breaks the kill chain the way any non-kill does", () => {
		// `this-command` is `undo` afterwards, and an undo is not a kill — so the next `C-k`
		// must open a new ring entry rather than appending to the killed text the undo just put
		// back. The second kill is made a *different* one, so the two readings cannot both
		// produce the same ring: a broken chain gives two entries, an unbroken one gives
		// `"cdab"`.
		const e = editor("ab\ncd", 0);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["ab"]);
		e.press("x", C);
		e.press("u");
		expect(e.engine.lastCommand).toBe("undo");
		// Onto the second line, whose text the first kill left alone.
		e.repeat(3, "f", C);
		e.press("k", C);
		expect(e.state.text).toBe("ab\n");
		expect(e.engine.killRing).toEqual(["cd", "ab"]);
	});

	test("undoing a kill leaves it on the ring, so C-y still yields the killed text", () => {
		// "When you use C-/ (undo) to undo a kill command, that brings the killed text back into
		// the buffer, but does not remove it from the kill ring" (`doc/emacs/killing.texi:44-46`)
		// — which is the behaviour a user relies on to look at what they cut without having
		// committed to it.
		const e = editor("ab\ncd", 0);
		e.press("k", C);
		e.press("x", C);
		e.press("u");
		expect(e.state.text).toBe("ab\ncd");
		e.press("y", C);
		expect(e.state.text).toBe("abab\ncd");
		expect(e.state.cursor).toBe(2);
	});

	test("the region goes away and the mark keeps its number, because undo modifies the buffer", () => {
		// The modification layer deactivates the mark for *any* change (`src/insdel.c:2189`), and
		// undo is a change. The mark's value is a marker into text that has since moved, and
		// Emacs keeps such a mark rather than dropping it, so the same offset stays — clearing
		// it would be a rule with no citation behind it.
		//
		// The undo here has an **empty** stack on purpose, and that is not a convenience. Every
		// edit deactivates the region on its way through, so by the time a *popping* undo runs
		// the region is already gone and the assertion below would hold whatever `#undo` did.
		// An undo that undoes nothing is the one shape where the line in `#undo` is the only
		// thing that can turn the region off, and the falsification driver is what said so: it
		// deleted that line and nothing went red.
		const e = editor("abcdef", 0);
		e.press(" ", C);
		expect(e.press("f", C)).toBe(true);
		expect(e.engine.mark).toBe(0);
		expect(e.engine.markActive).toBe(true);
		expect(e.undoDepth()).toBe(0);
		e.press("x", C);
		e.press("u");
		expect(e.state.text).toBe("abcdef");
		// The mark's *number* survives; the region does not come back with it.
		expect(e.engine.mark).toBe(0);
		expect(e.engine.markActive).toBe(false);
	});

	test("a typed character before the undo is not charged to the undo", () => {
		// A character the engine declined is not a command yet: `lastCommand` stays null and the
		// engine holds a marker instead, to be read back on the next key. An undo in between has
		// to beat that read-back, because it cannot tell the undo from the typing — the text
		// moved either way. What beats it is the *order*: `handleKey` reconciles before it
		// dispatches, and `#undo` names its command after that, so the self-insert is recorded
		// as the command before rather than as the one running. There is no marker reset in
		// `#undo` to do it, because `#reconcileTyped` already cleared the marker before
		// `#undo` was reached.
		const e = editor("ab\ncd", 0);
		e.type("z");
		expect(e.state.text).toBe("zab\ncd");
		expect(e.engine.lastCommand).toBeNull();
		e.press("x", C);
		e.press("u");
		expect(e.engine.lastCommand).toBe("undo");
		// And the key after is read on its own evidence: the next real edit is recorded as
		// itself rather than continuing a self-insert the undo already closed.
		e.repeat(2, "f", C);
		e.press("k", C);
		expect(e.state.text).toBe("zabcd");
		expect(e.engine.lastCommand).toBe("kill-region");
	});

	test("C-u C-x u undoes four, and C-u C-u C-x u undoes sixteen", () => {
		// `(4 C-x u)` undoes four entries in Emacs, so the raw prefix is read here. The count is
		// the prefix argument's own multiplication: one `C-u` is four and two are sixteen. Five
		// edits is less than both, so the *stack* is what bounds the walk — the count does not
		// have to divide into it.
		//
		// The prefix has to survive the `C-x`, which is a prefix key and runs no command. It did
		// not: `handleKey` spends the prefix's liveness once per key, so `C-x` was spending it
		// and the member arrived with nothing. The driver found that by asking for four and
		// being given one, and `emacs.ts` says so where the re-arm is.
		const e = editor("abcdefghij", 0);
		for (let i = 0; i < 5; i++) e.press("d", C);
		expect(e.state.text).toBe("fghij");
		expect(e.undoDepth()).toBe(5);
		e.press("u", C);
		expect(e.engine.prefixArg).toEqual({ car: 4, cdr: [] });
		e.press("x", C);
		e.press("u");
		expect(e.state.text).toBe("bcdefghij");
		expect(e.undoDepth()).toBe(1);
		// Sixteen, with one entry left to undo: the count is honoured and the stack stops it.
		e.press("u", C);
		e.press("u", C);
		expect(e.engine.prefixArg).toEqual({ car: 16, cdr: [] });
		e.press("x", C);
		e.press("u");
		expect(e.state.text).toBe("abcdefghij");
		expect(e.undoDepth()).toBe(0);
	});

	test("an empty stack is a consumed key and a command, not a crash and not a fall-through", () => {
		// Emacs "signals an error" (`doc/emacs/fixit.texi:64-65`) and `EmacsOps.undo` returns
		// nothing to say whether it undid anything, so this cannot reproduce that without
		// widening the interface for one message. What it must still do is consume the key — a
		// `C-x u` that fell through would type a `u` into the prompt.
		const e = editor("abc", 0);
		expect(e.press("x", C)).toBe(true);
		expect(e.press("u")).toBe(true);
		expect(e.state.text).toBe("abc");
		expect(e.engine.lastCommand).toBe("undo");
	});

	test("a cursor move is not an undo step, so moving and then undoing still reaches the text", () => {
		// The host's snapshot is pushed by `setAll` only, which is what "cursor-only moves are
		// not undoable" means in practice — and it is also why the divergence the header names,
		// that a move does not break the undo sequence, is the host's and not this engine's.
		const e = editor("abc", 0);
		e.press("d", C);
		expect(e.state.text).toBe("bc");
		expect(e.undoDepth()).toBe(1);
		// Three motions, and the stack is still one deep: none of them pushed a snapshot. The
		// third is the one past the end, which signals and stands — two is where it ends up.
		e.repeat(3, "f", C);
		expect(e.state.cursor).toBe(2);
		expect(e.undoDepth()).toBe(1);
		e.press("x", C);
		e.press("u");
		expect(e.state.text).toBe("abc");
		expect(e.state.cursor).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// The reserved tables, run as tables
// ---------------------------------------------------------------------------

/**
 * Every row of {@link RESERVED_KEYS} and {@link CTL_X_RESERVED}, parametrised.
 *
 * Before this, six of the twenty-seven were pinned by hand and the other twenty-one were not
 * pinned at all — so a key could be deleted from a table, or a table could gain a key the
 * dispatch no longer claims, and nothing would have said so. Parametrising over the tables
 * rather than over a hand-copied list is the part that matters: a *new* reserved key now has to
 * come with a test or the run goes red, which is the only way the "next batch is a list edit"
 * promise in `emacs.ts` stays true.
 */
describe("emacs: the reserved tables", () => {
	test.each(RESERVED_KEYS.map(([token]) => token))("%s is consumed, changes nothing, and runs no command", (token) => {
		const e = editor("abc", 1);
		expect(pressToken(e, token)).toBe(true);
		expect(e.state.text).toBe("abc");
		// A reserved key runs no command, so it is not a motion either: point does not move.
		expect(e.state.cursor).toBe(1);
		// `this-command` is nil for a sequence that ran no command
		// (`src/keyboard.c:1416-1417`), so the tail of the loop leaves `last-command` nil —
		// which is what breaks a kill chain, and the reason a reserved key costs nothing.
		expect(e.engine.lastCommand).toBeNull();
	});

	test.each(CTL_X_RESERVED.map(([member]) => member))(
		"C-x %s is consumed, changes nothing, and runs no command",
		(member) => {
			const e = editor("abc", 1);
			// A `C-x` on its own runs no command either, so the sequence is two keys and one of
			// them is the map.
			expect(e.press("x", C)).toBe(true);
			expect(e.engine.lastCommand).toBeNull();
			expect(pressToken(e, member)).toBe(true);
			expect(e.state.text).toBe("abc");
			expect(e.state.cursor).toBe(1);
			expect(e.engine.lastCommand).toBeNull();
		},
	);

	test("both tables are the ones the header names, key for key", () => {
		// The one test in this file that is a **copy**, and it has to be. `test.each` over a
		// table proves every row *present* is claimed; it says nothing about a row that was
		// *removed*, because removing a row removes its test too. A reserved key can therefore
		// disappear from `emacs.ts` and take its coverage with it, in silence — which is the
		// opposite of the promise `emacs.ts` makes about the next batch being a list edit.
		//
		// So the key lists are written out here. The cost is the obvious one: adding a key means
		// touching two places, and this test is where the second place gets remembered. That is
		// cheaper than a table that can lose rows unnoticed, and unlike a line number this copy
		// is a *claim* — it says what the reserved surface is, which is worth pinning.
		//
		// Note the two tables' spellings differ, and the difference is load-bearing rather than
		// cosmetic: `RESERVED_KEYS` is matched by `emacsKeyToken`, which names meta before ctrl,
		// so a ctrl+meta key is `C-M-` there. `C-M-s` and `C-M-r` were spelled `M-C-`, matched
		// nothing, and let the key fall through to type its own letter into the prompt. This test
		// is the second thing that would have caught it; the parametrised rows above were the
		// first.
		expect(RESERVED_KEYS.map(([token]) => token)).toEqual([
			"C-M-t",
			"C-q",
			"C-g",
			"M-z",
			"M-h",
			"M-@",
			"M-x",
			"M-X",
			"M-\\",
			"M-{",
			"M-}",
			"M-q",
			"M-a",
			"M-e",
			"C-s",
			"C-r",
			"C-M-s",
			"C-M-r",
			"M-s",
			"M-=",
		]);
		expect(CTL_X_RESERVED.map(([member]) => member)).toEqual(["t", "C-@", "C-SPC", " ", "n", "h", "=", "r"]);
	});

	test("C-t and C-o are declined, so the watch panel and the transcript keep their keys", () => {
		// The host owns both keys. A declined key is the engine's "this is yours" answer: it
		// runs no command, so the buffer, point and `last-command` are untouched.
		const e = editor("abc", 1);
		expect(e.press("t", C)).toBe(false);
		expect(e.press("o", C)).toBe(false);
		expect(e.state.text).toBe("abc");
		expect(e.state.cursor).toBe(1);
		expect(e.engine.lastCommand).toBeNull();
	});

	test("a reserved key is claimed by the table, and leaves no prefix argument behind", () => {
		// The control for the row above: `M-z` is in the reserved table *and* a spelling the
		// meta dispatch could plausibly have claimed — it is `zap-to-char`, one argument away
		// from running. `M-u` stood here until the case commands arrived; it had the same shape
		// then, and its move out of the table is what the rows above now pin. Nothing is the
		// assertion — and it is the shape a table that had quietly stopped claiming a key would
		// fail, because a command that *does* run leaves its own trace.
		const e = editor("abc", 0);
		expect(pressToken(e, "M-z")).toBe(true);
		expect(e.engine.prefixArg).toBeNull();
	});

	test("an implemented command is in neither reserved table, so the tables cannot drift into lying", () => {
		// `C-x C-x`, `C-x u` and — since the uemacs batch — `C-u`, `C-l` and `C-o` are the
		// implemented members of `ctl-x-map`, and none is listed. The tables' own docstring says
		// an implemented member must be deleted from them rather than left behind, so this is
		// the assertion that keeps the promise checkable.
		expect(CTL_X_RESERVED.map(([member]) => member)).not.toContain("u");
		expect(CTL_X_RESERVED.map(([member]) => member)).not.toContain("x");
		expect(CTL_X_RESERVED.map(([member]) => member)).not.toContain("C-u");
		expect(CTL_X_RESERVED.map(([member]) => member)).not.toContain("C-l");
		// Batch 2a removed `M-t` and `M-o` when their commands landed. `M-o`'s old row also
		// cited `bindings.el:1229` for `split-line`, which is `esc-map "\C-o"` — `C-M-o` — so
		// the row was mis-keyed as well as unimplemented; the new command explains the move.
		expect(RESERVED_KEYS.map(([token]) => token)).not.toContain("M-t");
		expect(RESERVED_KEYS.map(([token]) => token)).not.toContain("M-o");
		// `C-t` and `C-o` are the host's keys — the watch panel and the transcript — so the
		// engine neither declares nor consumes them. Before the cleanup the table claimed both
		// and the frame measurement showed the REPL still received them
		// (`watch-panel.test.tsx`); removing the declarations makes the tables say what was
		// already true of the key.
		expect(RESERVED_KEYS.map(([token]) => token)).not.toContain("C-t");
		expect(RESERVED_KEYS.map(([token]) => token)).not.toContain("C-o");
		expect(CTL_X_RESERVED.map(([member]) => member)).not.toContain("C-o");
		// The control for all of it: the two keys that *are* implemented still work through the
		// same `C-x` prefix, so "not in the table" is not "not claimed". A table that had quietly
		// stopped claiming `C-x` would leave every assertion above looking fine. The member of
		// `C-x C-x` is spelled `C-x` because it *is* a second ctrl key, and a fixture that
		// pressed a bare `x` here would be testing a key the engine does not implement.
		const e = editor("abc", 0);
		e.press("d", C);
		expect(e.state.text).toBe("bc");
		expect(pressCtlX(e, "C-x")).toBe(true);
		expect(e.state.cursor).toBe(0);
		expect(e.state.text).toBe("bc");
		// And `C-x u` is the *bare* `u`: `bindings.el:1246` binds the literal character, so a
		// fixture that spelled the member `C-u` would be testing the modifier the binding does
		// not have. That is not a hypothetical — this line was `pressCtlX(e, "C-u")` and passed
		// for the whole life of a dispatch that compared `key.ctrl && input === "u"`.
		expect(pressCtlX(e, "u")).toBe(true);
		expect(e.state.text).toBe("abc");
	});

	/**
	 * The other half of the distinction above, and the reason the fix was not "accept both".
	 *
	 * `C-x C-u` is `upcase-region` (`subr.el:1748`), not undo. It is a different command one
	 * modifier away, one that `subr.el:1749` marks `disabled` so Emacs asks before running it,
	 * and one uemacs also binds (`region.c:121`, `ebind.h:62`). The engine runs it now, so this
	 * test reads the region it upcased and the command it left as `last-command`. The fixture is
	 * deliberately the same one the `C-x u` test above uses, one modifier apart, so the two
	 * cannot both be right: that one undoes the kill and reads a joined ring, this one upcases
	 * the region and *then* opens a new ring entry, because `upcase-region` broke the chain the
	 * same way a motion would.
	 */
	test("C-x C-u runs upcase-region over the region, one modifier away from undo", () => {
		const e = editor("ab\ncd", 0);
		e.press("k", C);
		expect(e.engine.killRing).toEqual(["ab"]);
		expect(e.state.text).toBe("\ncd");
		e.press(" ", C); // C-SPC: mark at 0
		e.repeat(2, "f", C); // point at 2, so the region is 0..2 — the newline and the "c"
		expect(pressCtlX(e, "C-u")).toBe(true);
		expect(e.engine.lastCommand).toBe("upcase-region");
		expect(e.state.text).toBe("\nCd");
		expect(e.state.cursor).toBe(2);
		// The chain broke, so the next kill opens a new ring entry — the same `["d", "ab"]`
		// shape the `C-x u` test ends on, reached without an undo having run.
		e.press("k", C);
		expect(e.state.text).toBe("\nC");
		expect(e.state.cursor).toBe(2);
		expect(e.engine.killRing).toEqual(["d", "ab"]);
	});
});

// ---------------------------------------------------------------------------
// The uemacs batch: case words and regions, the mark aliases, blank lines
// ---------------------------------------------------------------------------

describe("emacs: case words", () => {
	// `M-u`, `M-l` and `M-c` are `upcase-word`, `downcase-word` and `capitalize-word`
	// (`subr.el:1718-1720`), and uemacs binds the same three commands on the same three keys
	// (`ebind.h:133` / `:126` / `:120`). The case engine is GNU's, character by character; the
	// word span is this engine's word rule, whose divergences are named on `#caseWord`. These
	// tests pin both ends — the general behavior, and the two places the trees disagree.

	test("M-u upcases over the next word and leaves point at its end", () => {
		const e = editor("hello world", 0);
		expect(e.press("u", M)).toBe(true);
		expect(e.state.text).toBe("HELLO world");
		expect(e.state.cursor).toBe(5);
		expect(e.engine.lastCommand).toBe("upcase-word");
	});

	test("M-l lowers the next word", () => {
		const e = editor("HELLO WORLD", 0);
		expect(e.press("l", M)).toBe(true);
		expect(e.state.text).toBe("hello WORLD");
		expect(e.state.cursor).toBe(5);
		expect(e.engine.lastCommand).toBe("downcase-word");
	});

	test("M-c capitalizes, and a second press carries on to the next word", () => {
		const e = editor("hELLO wORLD", 0);
		expect(e.press("c", M)).toBe(true);
		expect(e.state.text).toBe("Hello wORLD");
		expect(e.state.cursor).toBe(5);
		expect(e.engine.lastCommand).toBe("capitalize-word");
		expect(e.press("c", M)).toBe(true);
		expect(e.state.text).toBe("Hello World");
		expect(e.state.cursor).toBe(11);
	});

	test("from inside a word, only what point can still reach is converted", () => {
		// Capitalize upcases the first word character whose predecessor was not one
		// (`casefiddle.c:122-129`, the `was_inword` term), and the span starts at point with the
		// word state reset — so mid-word it is not the word's first character but the next one
		// point stands on: `he|llo` becomes `heLlo`, not `Hello`.
		const e = editor("hello", 2);
		expect(e.press("c", M)).toBe(true);
		expect(e.state.text).toBe("heLlo");
		expect(e.state.cursor).toBe(5);
	});

	test("$ is a word character here, so M-c takes foo$bar in one press", () => {
		// The recorded divergence (`#caseWord`, word.c:356): uemacs's `inword` is letters and
		// digits, so there `foo$bar` is two words and `M-c` writes `Foo$Bar`; here `$` has word
		// syntax and the span is the whole thing.
		const e = editor("foo$bar", 0);
		expect(e.press("c", M)).toBe(true);
		expect(e.state.text).toBe("Foo$bar");
		expect(e.state.cursor).toBe(7);
		// The other side of the same rule, where both trees agree: `_` is a symbol and splits,
		// so the first press touches only `foo`.
		const underscore = editor("foo_bar", 0);
		expect(underscore.press("c", M)).toBe(true);
		expect(underscore.state.text).toBe("Foo_bar");
		expect(underscore.state.cursor).toBe(3);
	});

	test("a negative count converts backwards and leaves point where it was", () => {
		// The other recorded disagreement, resolved toward GNU (`casefiddle.c:677`): uemacs
		// refuses a negative argument (`word.c:124-125`), the `"p"` spec here converts the
		// previous word, and the movement lands back on where point already was.
		const e = editor("foo bar", 4);
		e.press("-", M); // M--
		expect(e.press("u", M)).toBe(true);
		expect(e.state.text).toBe("FOO bar");
		expect(e.state.cursor).toBe(4);
		expect(e.engine.lastCommand).toBe("upcase-word");
	});

	test("a count converts that many words in one pass", () => {
		const e = editor("foo bar baz", 0);
		e.press("3", M); // M-3
		expect(e.press("u", M)).toBe(true);
		expect(e.state.text).toBe("FOO BAR BAZ");
		expect(e.state.cursor).toBe(11);
	});

	test("an empty span writes nothing, but the command still ran", () => {
		// `casify_region` returns before modifying for an empty region (`casefiddle.c:537-539`),
		// and `casify_word` still runs — so there is a command to name and no edit to undo.
		const e = editor("foo", 3);
		expect(e.press("u", M)).toBe(true);
		expect(e.state.text).toBe("foo");
		expect(e.state.cursor).toBe(3);
		expect(e.engine.lastCommand).toBe("upcase-word");
		expect(e.undoDepth()).toBe(0);
		// A zero count is the same empty span, and not an absence: `C-0 M-u` ran too.
		const zero = editor("foo", 0);
		zero.press("0", C);
		expect(zero.press("u", M)).toBe(true);
		expect(zero.state.text).toBe("foo");
		expect(zero.engine.lastCommand).toBe("upcase-word");
		expect(zero.undoDepth()).toBe(0);
	});
});

describe("emacs: case regions (C-x C-u / C-x C-l)", () => {
	// `upcase-region` and `downcase-region`, bound on `ctl-x-map` in `subr.el:1748-1749` and
	// both marked `disabled` there so Emacs asks before running them — and both bound the same
	// way by uemacs (`region.c:121`, `:84`; `ebind.h:62`, `:54`), with no ask. The region is
	// point and mark in *either* order (the geometric region), and the mark does not have to be
	// active for it to exist.

	test("C-x C-l downcases between point and mark", () => {
		const e = editor("AB\nCD", 0);
		e.press(" ", C); // C-SPC: mark at 0
		e.repeat(2, "f", C); // point at 2
		expect(pressCtlX(e, "C-l")).toBe(true);
		expect(e.engine.lastCommand).toBe("downcase-region");
		expect(e.state.text).toBe("ab\nCD");
		expect(e.state.cursor).toBe(2);
	});

	test("the mark does not have to be active for the region to exist", () => {
		// `(interactive "r")` consults the mark, not the *active* mark — the same
		// deactivated-mark fixture the `C-w` test uses, run through the case command.
		const e = editor("abcdef", 0);
		e.press(" ", C); // mark at 0
		e.press(" ", C); // again at the same spot: the toggle deactivates it
		e.repeat(3, "f", C);
		expect(e.engine.markActive).toBe(false);
		expect(pressCtlX(e, "C-u")).toBe(true);
		expect(e.engine.lastCommand).toBe("upcase-region");
		expect(e.state.text).toBe("ABCdef");
		expect(e.state.cursor).toBe(3);
	});

	test("with no mark at all it is a user-error: consumed, nothing run, last-command stands", () => {
		// With no mark, `(interactive "r")` signals (`editfns.c:243`, `the-mark-is-not-set`) —
		// a signal, not a no-op — so the engine consumes the keys and leaves `last-command`
		// alone. The distinction from the empty region below is the point of both tests.
		const e = editor("hello", 2);
		e.press("f", C);
		expect(e.engine.lastCommand).toBe("forward-char");
		expect(pressCtlX(e, "C-u")).toBe(true);
		expect(e.state.text).toBe("hello");
		expect(e.state.cursor).toBe(3);
		expect(e.engine.lastCommand).toBe("forward-char");
	});

	test("an empty region runs the command and writes nothing", () => {
		// `casify_region` returns early for `start == end` (`casefiddle.c:537-539`) — but the
		// command was entered and ran, so unlike the no-mark case this one *does* take over
		// `last-command`, and still leaves no edit to undo.
		const e = editor("hello", 2);
		e.press(" ", C); // mark at point
		expect(pressCtlX(e, "C-u")).toBe(true);
		expect(e.engine.lastCommand).toBe("upcase-region");
		expect(e.state.text).toBe("hello");
		expect(e.undoDepth()).toBe(0);
	});

	test("when casing changes the region's length, point at the end moves with it", () => {
		// `casify_region` returns `orig_end + added` (`casefiddle.c:581`) and `casify_word` sets
		// point to that, so `ß` gaining a character pushes a point sitting at the region's end.
		const e = editor("ße", 0);
		e.press(" ", C);
		e.press("f", C); // point at 1, region 0..1
		expect(pressCtlX(e, "C-u")).toBe(true);
		expect(e.state.text).toBe("SSe");
		expect(e.state.cursor).toBe(2);
	});
});

describe("emacs: the mark aliases (M-SPC / M-.)", () => {
	// uemacs sets the mark on `M-SPC` (`basic.c:431`, key `ebind.h:111`) and on `M-.` (`:113`).
	// GNU gives those keys to `cycle-spacing` (`bindings.el:1235`) and to
	// `xref-find-definitions` (`progmodes/xref.el:2011`) — this batch follows uemacs, and the
	// divergence is recorded in the engine. Both are the *same command* as `C-SPC`
	// (`set-mark-command`), not a second implementation of it: the toggle and the
	// `last-command` naming are shared, and these tests exist to say so.

	test("M-SPC sets the mark, and a second press at the same spot toggles it off", () => {
		const e = editor("hello", 2);
		expect(e.press(" ", M)).toBe(true);
		expect(e.engine.mark).toBe(2);
		expect(e.engine.markActive).toBe(true);
		expect(e.engine.lastCommand).toBe("set-mark-command");
		expect(e.press(" ", M)).toBe(true);
		expect(e.engine.markActive).toBe(false);
	});

	test("M-. sets the mark, and the region it sets is a working region", () => {
		const e = editor("hello world", 0);
		expect(e.press(".", M)).toBe(true);
		expect(e.engine.mark).toBe(0);
		expect(e.engine.markActive).toBe(true);
		expect(e.engine.lastCommand).toBe("set-mark-command");
		e.repeat(5, "f", C);
		e.press("w", M); // M-w: copy the region
		expect(e.engine.killRing).toEqual(["hello"]);
		expect(e.state.text).toBe("hello world");
	});

	test("the alias is the meta spelling only — a bare . still types itself", () => {
		const e = editor("ab", 0);
		expect(e.press(".", M)).toBe(true);
		const plain = editor("ab", 0);
		expect(plain.press(".", {})).toBe(false);
	});
});

describe("emacs: delete blank lines (C-x C-o)", () => {
	// uemacs's `cmd_delete_blank_lines` (`random.c:637`, key `ebind.h:57`): walk up to the
	// first non-blank line, count the run of empty lines after it, delete it, leave point on
	// the line that terminated the walk. "Blank" is *empty* there — a line of spaces is not
	// blank — and the line after the final newline is a phantom the walk steps through like
	// any other blank line. The engine is a port of that walk, not of GNU's
	// `delete-blank-lines` (`simple.el:826`), which uses `[ \t]*$` and does not move point
	// the same way.

	test("a run of blank lines in the middle collapses to one break", () => {
		const e = editor("a\n\n\nb", 1);
		expect(pressCtlX(e, "C-o")).toBe(true);
		expect(e.engine.lastCommand).toBe("delete-blank-lines");
		expect(e.state.text).toBe("a\nb");
		expect(e.state.cursor).toBe(2);
	});

	test("standing on a blank line takes the run above it and below it", () => {
		const e = editor("a\n\n\nb", 3);
		expect(pressCtlX(e, "C-o")).toBe(true);
		expect(e.state.text).toBe("a\nb");
		expect(e.state.cursor).toBe(2);
	});

	test("the blank run at the top of the buffer stays, because the walk stops at line 0", () => {
		// The first line is never deleted: uemacs's walk stops when it cannot step up
		// (`line_prev != b_linep`), which is line 0 even when line 0 is itself blank.
		const e = editor("\n\na", 0);
		expect(pressCtlX(e, "C-o")).toBe(true);
		expect(e.state.text).toBe("\na");
		expect(e.state.cursor).toBe(1);
	});

	test("at the end of the buffer the phantom line is walked through, not counted", () => {
		// After the final newline there is no line — uemacs's line list ends at `b_linep` —
		// but the walk needs no special case for it: the phantom is blank, so starting there
		// converges to the same line from below, and the count is capped at the last real
		// line, so the phantom itself never deletes anything. Its falsification run is what
		// settled that: deleting the clamp that used to map it down changed no test.
		const e = editor("b\n\n", 3);
		expect(pressCtlX(e, "C-o")).toBe(true);
		expect(e.state.text).toBe("b\n");
		expect(e.state.cursor).toBe(2);
	});

	test("a line of spaces is not blank here — uemacs checks for an empty line", () => {
		// The recorded divergence from GNU, which would delete the `" "` line (`simple.el:826`,
		// `[ \t]*$`). uemacs's `line_length (lp) == 0` is the whole test.
		const e = editor("a\n \nb", 1);
		expect(pressCtlX(e, "C-o")).toBe(true);
		expect(e.state.text).toBe("a\n \nb");
		expect(e.state.cursor).toBe(1);
	});

	test("nothing to delete is still a command: no write, no undo entry", () => {
		const e = editor("a\nb", 2);
		expect(e.undoDepth()).toBe(0);
		expect(pressCtlX(e, "C-o")).toBe(true);
		expect(e.state.text).toBe("a\nb");
		expect(e.state.cursor).toBe(2);
		expect(e.engine.lastCommand).toBe("delete-blank-lines");
		expect(e.undoDepth()).toBe(0);
	});
});

describe("emacs: M-C-H kills the previous word", () => {
	// uemacs's `cmd_delete_previous_word` (`word.c:315`, key `ebind.h:100`), which uemacs also
	// binds on `M-DEL` (`ebind.h:138`) — and the command `[C-backspace]` runs here
	// (`bindings.el:1634`). GNU gives `M-C-H` to `mark-defun` (`bindings.el:1666`); the compat
	// batch takes the key, and the engine records the divergence. The twin assertion below is
	// the other half: same fixture, same result as the `ctrlBackspace` flag.

	test("M-C-H is the same command as C-backspace, on the same fixture", () => {
		const compat = editor("aa bb cc", 8);
		expect(compat.press("h", CM)).toBe(true);
		const twin = editor("aa bb cc", 8);
		twin.press("x", { ctrlBackspace: true });
		expect(compat.state.text).toBe(twin.state.text);
		expect(compat.engine.killRing).toEqual(twin.engine.killRing);
		expect(compat.state.text).toBe("aa bb ");
		expect(compat.state.cursor).toBe(6);
		expect(compat.engine.killRing).toEqual(["cc"]);
		expect(compat.engine.lastCommand).toBe("kill-region");
	});

	test("with a count it takes that many words", () => {
		const e = editor("aa bb cc", 8);
		e.press("2", M);
		expect(e.press("h", CM)).toBe(true);
		expect(e.state.text).toBe("aa ");
		expect(e.state.cursor).toBe(3);
		expect(e.engine.killRing).toEqual(["bb cc"]);
	});
});

// ---------------------------------------------------------------------------
// uemacs batch 2a: the fence jump and the two transposes
// ---------------------------------------------------------------------------

describe("emacs: M-C-F jumps to the matching fence", () => {
	// uemacs's `cmd_goto_matching_fence` (`random.c:921`, key `META | CONTROL | 'F'`,
	// `ebind.h:99`). GNU binds `C-M-f` to `forward-sexp` instead (`bindings.el:1651`), which is
	// a different command on the same key; this is a compat port, so uemacs's command runs and
	// the divergence is named here. The host side is the reason the engine has to take the key:
	// `PromptInput.tsx:696` tests `key.meta` alone, so `C-M-f` would otherwise reach the host's
	// meta-f branch, which is `moveWordRight` (`:697`) — a different motion, one modifier short.

	test("forward from an opener, backward from a closer", () => {
		const forward = editor("a (foo) b", 2);
		expect(forward.press("f", CM)).toBe(true);
		expect(forward.state.text).toBe("a (foo) b");
		expect(forward.state.cursor).toBe(6);
		expect(forward.engine.lastCommand).toBe("goto-matching-fence");

		const backward = editor("a (foo) b", 6);
		expect(backward.press("f", CM)).toBe(true);
		expect(backward.state.cursor).toBe(2);
	});

	test("all three fence pairs, both directions", () => {
		for (const [text, from, to] of [
			["(x)", 0, 2],
			["(x)", 2, 0],
			["[x]", 0, 2],
			["[x]", 2, 0],
			["{x}", 0, 2],
			["{x}", 2, 0],
		] as const) {
			const e = editor(text, from);
			expect(e.press("f", CM)).toBe(true);
			expect(e.state.cursor).toBe(to);
		}
	});

	test("nesting of the same kind is counted; the other kinds are stepped over", () => {
		// `count` rises on the character under point and falls on its opposite
		// (`random.c:985-988`); nothing there compares the *other* fence families, so `([)]`
		// matches the `)` under point with the `(` two characters back. That is uemacs's answer,
		// not a parser's, and it is pinned rather than corrected.
		const nested = editor("((a))", 0);
		expect(nested.press("f", CM)).toBe(true);
		expect(nested.state.cursor).toBe(4);

		const mixed = editor("([{}])", 0);
		expect(mixed.press("f", CM)).toBe(true);
		expect(mixed.state.cursor).toBe(5);

		const interleaved = editor("([)]", 0);
		expect(interleaved.press("f", CM)).toBe(true);
		expect(interleaved.state.cursor).toBe(2);

		const reverse = editor("([)]", 3);
		expect(reverse.press("f", CM)).toBe(true);
		expect(reverse.state.cursor).toBe(1);
	});

	test("a fence inside a string is still a fence", () => {
		// uemacs scans characters, not syntax (`random.c:979-995`); there is no string state to
		// consult in a prompt either, so the `)` inside the quotes closes the form.
		const e = editor('(")")', 0);
		expect(e.press("f", CM)).toBe(true);
		expect(e.state.cursor).toBe(2);
	});

	test("an unmatched fence changes nothing and runs no command", () => {
		// Failure restores the saved line and offset (`random.c:1007-1010`) and returns before the
		// command loop's tail, so `last-command` keeps the previous command. The fixture plays a
		// motion first so the assertion can tell "left unchanged" from "reset to nil".
		const forward = editor("(abc", 0);
		forward.press("f", C);
		expect(forward.engine.lastCommand).toBe("forward-char");
		forward.state.cursor = 0;
		expect(forward.press("f", CM)).toBe(true);
		expect(forward.state.text).toBe("(abc");
		expect(forward.state.cursor).toBe(0);
		expect(forward.engine.lastCommand).toBe("forward-char");
		expect(forward.undoDepth()).toBe(0);

		const backward = editor("abc)", 3);
		expect(backward.press("f", CM)).toBe(true);
		expect(backward.state.cursor).toBe(3);
		expect(backward.engine.lastCommand).toBeNull();
	});

	test("point off a fence, or on a newline, is not a fence", () => {
		const off = editor("abc", 1);
		expect(off.press("f", CM)).toBe(true);
		expect(off.state.cursor).toBe(1);
		expect(off.engine.lastCommand).toBeNull();

		// At the end of a line uemacs reads `'\n'` (`random.c:936-939`), and `'\n'` has no arm
		// in the fence switch (`:942-969`), so the key rings the bell rather than scanning.
		const eol = editor("(\n)", 1);
		expect(eol.press("f", CM)).toBe(true);
		expect(eol.state.cursor).toBe(1);
		expect(eol.engine.lastCommand).toBeNull();
	});

	test("the opener at the first position of the buffer is matched", () => {
		// A deliberate divergence, and the only one in this command. uemacs steps before it
		// reads and breaks *after* the step when `at_buffer_end` says the scan has run out
		// (`random.c:989-994`, `search.c:988-998`), so a reverse scan never reads offset 0:
		// `(foo)` with point on the `)` fails there. This port reads position 0 before deciding
		// the scan is over, because the alternative is a visible no-op on the commonest
		// two-character form. Everything else about the scan is the reference's.
		const e = editor("(foo)", 4);
		expect(e.press("f", CM)).toBe(true);
		expect(e.state.cursor).toBe(0);
		expect(e.engine.lastCommand).toBe("goto-matching-fence");
	});
});

describe("emacs: M-t transposes words", () => {
	// GNU's `transpose-words` (`bindings.el:1597`, `simple.el:8798`), which is the command the
	// key owns in the reference tree; uemacs binds no `M-t` at all — its only transpose command
	// is `transpose-chars` on `C-t` (`random.c:191`, `ebind.h:39`), a key the host's watch panel
	// also claims. The algorithm is `transpose-subr` / `transpose-subr-1`
	// (`simple.el:8885-8945`), and the word mover is this engine's `forward-word`, so the word
	// rule is the one documented on `#caseWord`: `_` splits, a script change splits.

	test("M-t moves the word at point past the next one and leaves point at the end", () => {
		const e = editor("foo bar", 3);
		expect(e.press("t", M)).toBe(true);
		expect(e.state.text).toBe("bar foo");
		expect(e.state.cursor).toBe(7);
		expect(e.engine.lastCommand).toBe("transpose-words");
		expect(e.undoDepth()).toBe(1);
	});

	test("unequal word lengths keep the run's end as point", () => {
		// `(goto-char (car pos2))` (`simple.el:8913`) is the *forward* endpoint collected before
		// the edit (`:8898`), which remains the end of the transposed run because the two spans
		// and the middle between them cover the same length in both orders.
		const e = editor("foo barbaz", 3);
		expect(e.press("t", M)).toBe(true);
		expect(e.state.text).toBe("barbaz foo");
		expect(e.state.cursor).toBe(10);
	});

	test("a positive count drags the word past that many", () => {
		const e = editor("foo bar baz", 3);
		e.press("2", M);
		expect(e.press("t", M)).toBe(true);
		expect(e.state.text).toBe("bar baz foo");
		expect(e.state.cursor).toBe(11);
	});

	test("a negative count drags the previous word forward and lands on its end", () => {
		// The `t` branch: `(goto-char (+ (car pos2) (- (cdr pos1) (car pos1))))`
		// (`simple.el:8914-8919`), whose second term is the current word's length.
		const e = editor("foo bar", 7);
		e.press("-", M);
		expect(e.press("t", M)).toBe(true);
		expect(e.state.text).toBe("bar foo");
		expect(e.state.cursor).toBe(3);
	});

	test("the span is this engine's word rule, as M-f measures it", () => {
		// `_` is a symbol here, not a word character, so `foo_bar` is two units; uemacs's
		// `inword` (`word.c:356`) is letters and digits only and would split it the same way,
		// while the script-boundary half of the rule is this engine's (see `#caseWord`).
		const e = editor("foo_bar baz", 3);
		expect(e.press("t", M)).toBe(true);
		expect(e.state.text).toBe("bar_foo baz");
		expect(e.state.cursor).toBe(7);
	});

	test("with a zero argument the words at point and mark are exchanged", () => {
		// `(= arg 0)`: `save-excursion` collects the word at point, `goto-char (mark)` collects
		// the one at mark, transposes, and exchanges point and mark (`simple.el:8902-8908`).
		// The positions are marker positions rather than integers — `transpose-subr-1` is a
		// four-step insert/delete sequence chosen to move markers with their text
		// (`simple.el:8930-8945`) — so the fixture puts point *inside* the second word, where a
		// plain replaced-span adjustment of the mark would give a different answer.
		const e = editor("foo bar baz", 0);
		e.press(" ", C); // mark at 0
		e.state.cursor = 5; // inside "bar"; mark stays at 0
		e.press("0", M);
		expect(e.press("t", M)).toBe(true);
		expect(e.state.text).toBe("bar foo baz");
		expect(e.state.cursor).toBe(0); // the old mark
		expect(e.engine.mark).toBe(7); // the old point, moved with the insert/delete sequence
		expect(e.engine.markActive).toBe(true);
		expect(e.engine.lastCommand).toBe("transpose-words");
	});

	test("zero with no mark, and two spans that cannot be separated, run nothing", () => {
		// `(or (mark) (error "No mark set in this buffer"))` (`simple.el:8905`) and
		// `(error "Don't have two things to transpose")` (`simple.el:8929`) both leave the buffer
		// and `last-command` alone; a signed command that signals does not reach the loop tail.
		const noMark = editor("foo bar", 0);
		noMark.press("0", M);
		expect(noMark.press("t", M)).toBe(true);
		expect(noMark.state.text).toBe("foo bar");
		expect(noMark.state.cursor).toBe(0);
		expect(noMark.engine.lastCommand).toBeNull();
		expect(noMark.undoDepth()).toBe(0);

		const overlap = editor("foo", 0);
		expect(overlap.press("t", M)).toBe(true);
		expect(overlap.state.text).toBe("foo");
		expect(overlap.state.cursor).toBe(0);
		expect(overlap.engine.lastCommand).toBeNull();
		expect(overlap.undoDepth()).toBe(0);
	});
});

describe("emacs: M-o transposes characters, uemacs's command", () => {
	// uemacs's `cmd_transpose_characters` (`random.c:191`), the command it binds to
	// `CONTROL | 'T'` (`ebind.h:39`). `C-t` is not usable here: the REPL's watch panel also owns
	// it (`shortcuts.ts` says so, and `watch-panel.test.tsx` measures it), and a bound key that
	// the engine claims while another hook receives it is exactly the double dispatch the survey
	// called out. `M-o` is globally free in this GNU tree — the reserved row that used to say
	// `split-line (bindings.el:1229)` was reading the `esc-map "\C-o"` binding, which is `C-M-o`,
	// not `M-o` — so the uemacs command moves to the free key and the divergence is recorded.
	//
	// The behaviour is the reference's, not GNU's: the swap is bounded by the line
	// (`random.c:202-209`), the count is ignored (the function's `f`/`n` are unread), and point
	// does not move. GNU's `transpose-chars` honors the count, crosses lines at end of line and
	// moves point forward one character (`simple.el:8787-8796`); none of that is done here.

	test("M-o swaps the characters around point and leaves point where it was", () => {
		const e = editor("abc", 1);
		expect(e.press("o", M)).toBe(true);
		expect(e.state.text).toBe("bac");
		expect(e.state.cursor).toBe(1);
		expect(e.engine.lastCommand).toBe("transpose-chars");
		expect(e.undoDepth()).toBe(1);
	});

	test("at end of line the last two characters are swapped", () => {
		const e = editor("abc", 3);
		expect(e.press("o", M)).toBe(true);
		expect(e.state.text).toBe("acb");
		expect(e.state.cursor).toBe(3);
	});

	test("at beginning of line, or on a one-character line, it signals", () => {
		// `if (--doto < 0) return FALSE` (`random.c:205-206`): there is no character before point
		// to swap with. The key is still consumed, and the signal leaves `last-command` as it was.
		const bol = editor("abc", 0);
		bol.press("f", C);
		bol.state.cursor = 0;
		expect(bol.press("o", M)).toBe(true);
		expect(bol.state.text).toBe("abc");
		expect(bol.state.cursor).toBe(0);
		expect(bol.engine.lastCommand).toBe("forward-char");
		expect(bol.undoDepth()).toBe(0);

		const one = editor("a\nb", 1);
		expect(one.press("o", M)).toBe(true);
		expect(one.state.text).toBe("a\nb");
		expect(one.engine.lastCommand).toBeNull();
	});

	test("the swap never crosses a line break", () => {
		const middle = editor("ab\ncd", 4);
		expect(middle.press("o", M)).toBe(true);
		expect(middle.state.text).toBe("ab\ndc");
		expect(middle.state.cursor).toBe(4);

		const bol = editor("ab\ncd", 3);
		expect(bol.press("o", M)).toBe(true);
		expect(bol.state.text).toBe("ab\ncd");
		expect(bol.state.cursor).toBe(3);
	});

	test("a prefix count is ignored", () => {
		const e = editor("abcd", 2);
		e.press("3", M);
		expect(e.press("o", M)).toBe(true);
		expect(e.state.text).toBe("acbd");
		expect(e.state.cursor).toBe(2);
	});

	test("a surrogate pair is one character to swap", () => {
		const atEnd = editor("a\u{1F600}", 3);
		expect(atEnd.press("o", M)).toBe(true);
		expect(atEnd.state.text).toBe("\u{1F600}a");
		expect(atEnd.state.cursor).toBe(3);

		const middle = editor("\u{1F600}ab", 2);
		expect(middle.press("o", M)).toBe(true);
		expect(middle.state.text).toBe("a\u{1F600}b");
		expect(middle.state.cursor).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// The exports nothing else names
// ---------------------------------------------------------------------------

/**
 * Every function `emacs.ts` exports that no other module and no other test named.
 *
 * They are all live inside the engine, which is the point: an export with no caller and no test
 * is a function whose only proof of working is that the engine happens to call it. These are the
 * pure ones, so a direct test is the whole of their contract.
 */
describe("emacs: the exported helpers, directly", () => {
	test("emacsPrefixValue is prefix-numeric-value over all four states", () => {
		// `p` is `Fprefix_numeric_value` (`callint.c:651-655`): the raw cons is *converted*, not
		// handed over. So the number a `"p"` command sees is the same whether the user typed
		// `C-u 4` or `M-4`.
		expect(emacsPrefixValue(null)).toBe(1);
		expect(emacsPrefixValue(7)).toBe(7);
		expect(emacsPrefixValue("-")).toBe(-1);
		expect(emacsPrefixValue({ car: 16, cdr: [] })).toBe(16);
	});

	test("emacsPrefixMinus negates a cons without growing it", () => {
		// `(- '(4))` is a **one-element cons holding -4**, not a two-element list — and from the
		// keyboard nothing ever builds it, because `backward-word`'s `"^p"` hands its body a
		// plain number. Both facts are asserted, because the second is what makes the first a
		// guard rather than a shape.
		expect(emacsPrefixMinus(null)).toBeNull();
		expect(emacsPrefixMinus(4)).toBe(-4);
		expect(emacsPrefixMinus("-")).toBe(-1);
		expect(emacsPrefixMinus({ car: 4, cdr: [] })).toEqual({ car: -4, cdr: [] });
	});

	test("emacsPrefixCar is the car of a cons and null for everything else", () => {
		// `kill-forward-chars`' first line (`simple.el:6665`), and the reading of `"p\nP"` that
		// makes a prefix raw on the second channel: a *number* has no car, and that is the whole
		// difference between the two channels.
		expect(emacsPrefixCar({ car: 4, cdr: [] })).toBe(4);
		expect(emacsPrefixCar(null)).toBeNull();
		expect(emacsPrefixCar(4)).toBeNull();
		expect(emacsPrefixCar("-")).toBeNull();
	});

	test("emacsPrefixForwardChars collapses a cons and turns the symbol into -1", () => {
		// `kill-forward-chars` (`simple.el:6663-6667`) in full. `delete-char`'s kill path hands
		// it a number (`src/cmds.c:258`), so for `C-d` this is the identity — but the prefix a
		// user typed arrives raw, so both clauses still matter.
		expect(emacsPrefixForwardChars({ car: 4, cdr: [] })).toBe(4);
		expect(emacsPrefixForwardChars("-")).toBe(-1);
		expect(emacsPrefixForwardChars(3)).toBe(3);
		expect(emacsPrefixForwardChars(null)).toBe(1);
	});

	test("emacsIsWordChar is the standard syntax table, where $ and % are words", () => {
		// Transcribed from `init_syntax_once` (`src/syntax.c:3664-3744`). The two that surprise:
		// `$` and `%` are `Sword` (`syntax.c:3699-3708`) and `_` is `Ssymbol`
		// (`syntax.c:3727-3732`), so `foo_bar` is two words and `foo$bar` is one.
		expect(emacsIsWordChar(0x61)).toBe(true);
		expect(emacsIsWordChar(0x30)).toBe(true);
		expect(emacsIsWordChar(0x24)).toBe(true);
		expect(emacsIsWordChar(0x25)).toBe(true);
		expect(emacsIsWordChar(0x5f)).toBe(false);
		expect(emacsIsWordChar(0x2e)).toBe(false);
		expect(emacsIsWordChar(0x20)).toBe(false);
		// "All multibyte characters have syntax `word' by default" (`syntax.c:3741-3743`).
		expect(emacsIsWordChar(0x4e2d)).toBe(true);
	});

	test("emacsScriptOf is generated from Unicode blocks, and four of its rows are load-bearing", () => {
		// `char-script-table`, which is what `word_boundary_p` compares (`src/category.c:383-384`).
		// Not built from `Scripts.txt` — `admin/unidata/blocks.awk` writes it at build time.
		// The C1 controls are unassigned because of the generator's own fix (`blocks.awk:77`),
		// and everything from Latin-1 Supplement on is Latin.
		expect(emacsScriptOf(0x0080)).toBe(0);
		expect(emacsScriptOf(0x009f)).toBe(0);
		expect(emacsScriptOf(0x00a0)).toBe(1);
		expect(emacsScriptOf(0x61)).toBe(1);
		// Hiragana and Katakana are one script here, not two: `name2alias` sends both to `kana`
		// (`blocks.awk:111`) and the adjacent blocks are merged (`blocks.awk:187-192`), which
		// `word-separating-categories` says in as many words (`src/category.c:481-482`). So `M-f`
		// in `あア` does not stop between them.
		expect(emacsScriptOf(0x3042)).toBe(emacsScriptOf(0x30a2));
		// The `0370` split (`blocks.awk:195-206`): Greek and Coptic interleaved in one block.
		expect(emacsScriptOf(0x03e1)).not.toBe(emacsScriptOf(0x03e2));
		// A fullwidth Latin letter is a different script from an ASCII one, so `M-f` stops
		// between `a` and `ａ` (`blocks.awk:219-234`).
		expect(emacsScriptOf(0xff41)).not.toBe(emacsScriptOf(0x61));
	});

	test("emacsWordForward and emacsWordBackward are inverses at the two word boundaries", () => {
		// There are two boundaries and they come from different places, so both have to appear
		// here or the test only covers one. The syntax one: `_` is a symbol and therefore a
		// boundary, `$` is a word and therefore not.
		expect(emacsWordForward("foo_bar", 0)).toBe(3);
		expect(emacsWordBackward("foo_bar", 7)).toBe(4);
		expect(emacsWordForward("foo$bar", 0)).toBe(7);
		expect(emacsWordBackward("foo$bar", 7)).toBe(0);
		// The script one, which is a *different function* (`emacsWordBoundary`) and the reason a
		// test written only in ASCII would still pass with the script rule deleted. `あ` is Han
		// and `a` is Latin, so they are two words.
		expect(emacsWordForward("あa", 0)).toBe(1);
		expect(emacsWordBackward("aあ", 2)).toBe(1);
		// And the case that is neither: `あ` and `ア` are the *same* script in the generated
		// table (`blocks.awk:111`), so they are one word. Deleting the script comparison would
		// leave both of the two rows above red and this one unchanged, which is the whole reason
		// it is here.
		expect(emacsWordForward("あア", 0)).toBe(2);
		// Digits are words, so `a1b` is one.
		expect(emacsWordForward("a1b", 0)).toBe(3);
		// And at the ends of the buffer they stop rather than run off it.
		expect(emacsWordForward("foo", 3)).toBe(3);
		expect(emacsWordBackward("foo", 0)).toBe(0);
	});

	test("emacsKeyToken names meta before ctrl, so C-M-t keeps its own name", () => {
		// Testing `ctrl` first would collapse `C-M-t` onto `C-t`, and the two are different
		// commands in the reserved table — `transpose-sexps` and `transpose-chars`.
		expect(emacsKeyToken("t", C)).toBe("C-t");
		expect(emacsKeyToken("t", M)).toBe("M-t");
		expect(emacsKeyToken("t", CM)).toBe("C-M-t");
		// The two space spellings, which are the ones a naive `C-${input}` gets wrong.
		expect(emacsKeyToken(" ", C)).toBe("C-SPC");
		expect(emacsKeyToken("@", C)).toBe("C-@");
		expect(emacsKeyToken("x", {})).toBe("x");
	});

	test("emacsCasify applies the per-character pass GNU runs, inword included", () => {
		// The loop behind every case command (`casefiddle.c:475-521`): each character is cased on
		// its own, and `case_character` tracks `inword` from word syntax alone (`:122-129`),
		// which capitalize consults — a word character whose predecessor was also one downcases,
		// and an entry into a word upcases.
		expect(emacsCasify("hello", "up")).toBe("HELLO");
		expect(emacsCasify("HELLO", "down")).toBe("hello");
		expect(emacsCasify("hELLO wORLD", "capitalize")).toBe("Hello World");
		// `_` is a symbol and therefore a boundary in both trees; `$` is a word here, so this is
		// where the transcription of the syntax table is what decides the output.
		expect(emacsCasify("foo_bar", "capitalize")).toBe("Foo_Bar");
		expect(emacsCasify("foo$bar", "capitalize")).toBe("Foo$bar");
		// The full SpecialCasing mapping, where one character becomes two (`:140-160`): `ß`
		// upcases to `SS`, which is the length change `#caseWord` and `#caseRegion` move point
		// past.
		expect(emacsCasify("ß", "up")).toBe("SS");
		expect(emacsCasify("SS", "down")).toBe("ss");
	});
});

// ---------------------------------------------------------------------------
// The citations, where the tree is
// ---------------------------------------------------------------------------

/**
 * The reference trees, and the reason nothing above depends on them.
 *
 * `G:\Bunttta\emacs-master\` and `G:\Bunttta\uemacs-master\` are this checkout's read-only
 * copies of the Emacs and uEmacs/PK sources. They are *not* test fixtures: the guard below is
 * `existsSync`-gated so that a clone without them skips rather than fails, because a test that
 * only passes on a machine with second source-tree checkouts fails CI for a reason that has
 * nothing to do with the engine. The two trees gate the two tests below *separately*, and
 * deliberately: the first test reads every citation in `emacs.ts` — uemacs `file:line`s
 * included — so it needs both trees; the second reads only the reserved-table rows, whose
 * citations are all GNU files, so its gate is the Emacs tree alone and its failure surface on a
 * machine that has that tree is exactly what it was before the uemacs batch. If a table row
 * ever cites a uemacs file, that gate widens with it.
 *
 * The same gate is the reason these assertions are allowed to carry line numbers at all — they
 * are the one place in this file that does, because a *copy* of a citation in a test would be
 * the rot the header is about. The citations are read out of `emacs.ts` itself, so there is
 * exactly one copy and this test is what checks it.
 */
const EMACS_TREE = "G:/Bunttta/emacs-master";
const UEMACS_TREE = "G:/Bunttta/uemacs-master";
const treePresent = existsSync(EMACS_TREE);
const uemacsPresent = existsSync(UEMACS_TREE);

/** Read one file of either tree, given the spelling `emacs.ts` uses in its citations. */
function readCited(spelling: string): string[] | null {
	// `emacs.ts` cites `bindings.el` for a file that is at `lisp/bindings.el`, and `cmds.c` for one
	// at `src/cmds.c` — the citations are named as the source names them, not as paths. The
	// prefixes are the four directories those names live in, tried in order; `""` is for the
	// citations that already spell the directory. The uemacs tree is flat (`.c` and `.h` beside
	// the README), so its fallback needs no prefix list.
	//
	// **The Emacs tree is tried first, and that is the collision rule**: `fileio.c`, `window.c`
	// and `buffer.c` exist in both trees with different contents, so a uemacs citation must name
	// a file the Emacs tree does not have. The uemacs batch cites `word.c`, `region.c`,
	// `random.c`, `basic.c` and `ebind.h` — none of which exists under `G:\Bunttta\emacs-master\`
	// — and deliberately does *not* cite uemacs's `fileio.c` for the line model, because that
	// spelling would be read from the GNU tree.
	for (const prefix of ["", "lisp/", "src/", "lisp/progmodes/", "admin/unidata/"]) {
		const path = `${EMACS_TREE}/${prefix}${spelling}`;
		if (existsSync(path)) return readFileSync(path, "utf8").split(/\r?\n/);
	}
	const uemacsPath = `${UEMACS_TREE}/${spelling}`;
	if (existsSync(uemacsPath)) return readFileSync(uemacsPath, "utf8").split(/\r?\n/);
	return null;
}

/** The `file:line` and optional `file:line-line` a `file:line-NNN` match stands for. */
function citedSpan(first: string, last: string | undefined): { start: number; end: number } {
	return { start: Number(first), end: last ? Number(last) : Number(first) };
}

describe("emacs: the citations, where the tree is", () => {
	test.skipIf(!treePresent || !uemacsPresent)("every file:line in emacs.ts names a line in the tree", () => {
		// The mechanical half, over *every* citation — the ~300 of them, not just the tables —
		// which is why this one needs both trees: the corpus includes the uemacs citations the
		// compat batch added, and one unresolved spelling there is indistinguishable from a GNU
		// one without both trees to try.
		// What it catches is the cheap class of rot: a path that does not exist, a line past the
		// end, a blank where there was text. What it cannot catch is a citation that now points at
		// the *wrong* line, because nothing in the citation says what the line should contain —
		// which is what the test below is for.
		const source = readFileSync(new URL("../src/emacs.ts", import.meta.url), "utf8");
		const cite = /([A-Za-z0-9_./-]+\.(?:el|c|texi|h|awk)):(\d+)(?:-(\d+))?/g;
		const unresolved: string[] = [];
		const outOfRange: string[] = [];
		const blank: string[] = [];
		let count = 0;
		for (const m of source.matchAll(cite)) {
			count++;
			const lines = readCited(m[1]);
			if (!lines) {
				unresolved.push(m[0]);
				continue;
			}
			const { start, end } = citedSpan(m[2], m[3]);
			if (start < 1 || end > lines.length) outOfRange.push(`${m[0]} in a file of ${lines.length} lines`);
			else if (lines.slice(start - 1, end).every((line) => line.trim() === "")) blank.push(m[0]);
		}
		expect(unresolved).toEqual([]);
		expect(outOfRange).toEqual([]);
		expect(blank).toEqual([]);
		// The non-vacuity floor. This is a count of the file's own text, so a parser change that
		// quietly stopped matching would show up here rather than as a green run over nothing.
		expect(count).toBeGreaterThan(250);
	});

	test.skipIf(!treePresent)("every row of both reserved tables cites the line that defines its command", () => {
		// The load-bearing half. Both tables are written as `["key", "command (file:line)"]`, and
		// every row carries that shape — so this covers the tables completely, with nothing
		// skipped for being in an awkward format. The check is that the cited line actually
		// *mentions* the command the row names, which is what an off-by-one fails: a citation one
		// line high lands on the `defvar` above the bindings, and one line low lands on the
		// `(define-key global-map "\C-n" 'next-line)` that follows them.
		//
		// It is a *name* check, not an equality check, because the source's own line carries a
		// key description (`"\C-t"`) the table spells differently. A renamed command or a moved
		// line both make it red, and both are the failure this guard exists for.
		//
		// The gate here is the Emacs tree alone, unlike the test above: every row's citation is
		// a GNU file today. A row that ever cites a uemacs file widens this gate with it —
		// `readCited` reads uemacs spellings from the GNU tree first, and the two flat `.c`
		// namespaces overlap (`fileio.c` is in both).
		const source = readFileSync(new URL("../src/emacs.ts", import.meta.url), "utf8");
		const row =
			/\["([^"]+)",\s*"([a-z][a-z0-9+*-]*(?:-[a-z0-9+*]+)+) \(([A-Za-z0-9_./-]+\.[a-z]+):(\d+)(?:-(\d+))?\)"\]/g;
		const checked: string[] = [];
		const wrong: string[] = [];
		for (const m of source.matchAll(row)) {
			const [, key, command, file, first, last] = m;
			checked.push(key);
			const lines = readCited(file);
			if (!lines) {
				wrong.push(`${key}: no ${file} in the tree`);
				continue;
			}
			const { start, end } = citedSpan(first, last);
			if (!lines.slice(start - 1, end).some((line) => line.includes(command))) {
				wrong.push(`${key} -> ${command}, cited ${file}:${first}${last ? `-${last}` : ""}`);
			}
		}
		expect(wrong).toEqual([]);
		// Every row of both tables, not "the ones that happened to parse": if a row lost its
		// citation this would drop below the sum of the two tables and go red.
		expect(checked).toHaveLength(RESERVED_KEYS.length + CTL_X_RESERVED.length);
	});
});
