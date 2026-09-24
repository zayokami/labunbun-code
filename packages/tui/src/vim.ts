/**
 * Vim modal
 *
 * Modes: NORMAL, INSERT, VISUAL (charwise), V-LINE (linewise).
 *
 * NORMAL supports:
 *   motions   h l 0 ^ $ w W b B e E f{c} F{c} t{c} T{c} ; , gg G j k
 *             (<Home> is `0` and <End> is `$`, wanted column and count alike —
 *             vim binds `K_END` to `nv_dollar` itself, so `2<End>` is `2$`)
 *   operators d c y — doubled (dd/cc/yy) is linewise; cw stops at the end of the
 *             word the caret is on (the classic cw/ce quirk: the whitespace after
 *             it stays, and on that word's last character only that character is
 *             changed, where ce walks on to the next word; a count is a plain Ne
 *             again); dgg/dG/dj/dk are linewise, and a delete leaves the caret on
 *             the first non-blank of the line it collapses onto, a change the
 *             insert at the point it cut from
 *   counts    [n] prefixes multiply (2w, d3j, 2dd, 2p); operator+motion counts
 *             multiply too (2d3w deletes 6 words)
 *   shifts    >> << and their motion (>{motion}) and visual (V> / V<) forms
 *   edits     x X D C S Y s r{c} ~ J p P i I a A o O u ctrl+r v V
 *             Backspace (a motion, `h` plus vim's default line wrap) and Delete
 *             (`x`, or a plain `h` in visual mode) — vim's own bindings for the
 *             two keys, claimed here so they cannot fall through to the host and
 *             edit the buffer from NORMAL mode.
 *
 * VISUAL is vim's charwise selection, reach and all: an end that reaches past the
 * last character of its line takes that line's break (`v$d` and `vld` at a line
 * end join the lines, a `vl` that merely arrived on the last character does not,
 * and a motion-less `vd` on an empty line takes the break it stands on, which is
 * what makes it join them). `$`, a `|` past the end of the line and an `l` that
 * had nowhere left to go are what reach; `j`/`k`/arrows carry the reach onto the
 * line they land on, and arm one there whenever the wanted column is past that
 * line's last character (so `v$j` onto a shorter line reaches, and so does a `j`
 * after a wrapping `<BS>`, which leaves its virtual column behind); `0`/`^`/`G`
 * and a word motion clear it, and a backward `h` spends it first — the caret does
 * not move, the end comes back onto the line's last character, and only the next
 * `h` steps (`'>` goes from column len+1 to column len, as read off `'<`/`'>` on
 * vim 9.1). The last line spends it the same way, break or no break; a caret
 * standing on a line break cannot spend at all — on an empty line the break *is*
 * the line, so `<BS>` and `<Space>` there wrap like anywhere else.
 *
 * `v<BS>` and `v<Space>` are those wrapping motions too, `whichwrap`'s `b` and `s`
 * halves: `<BS>` moves left and off the front of the line (its end lands one
 * column past the line above's last character, so the break goes with the delete
 * — `v<BS>d` at a line start joins the two lines), and `<Space>` moves like `l`
 * and wraps off the end of it (a blocked one arms the reach, exactly as a blocked
 * `l` does, and from an armed end or an empty line's break it wraps onto the next
 * line's first character). A step of an already-armed end is spent on the reach
 * before it moves, and only a step that crossed the break arms a new one: that is
 * why `v<BS><BS>d` takes one character more than `v<BS>d`, and not two.
 *
 * A paste token — the `[Pasted 800 chars #1]` a large paste is folded into (see
 * paste.ts) — is **one character** here, and that is the one rule in this engine
 * that vim has no opinion on, because vim has no such token. It has to be one:
 * the token is literal ASCII in a buffer the user can edit, so any command that
 * took one of its characters would leave a string `expandPasteTokens` no longer
 * matches, and the payload would go to the model as the remains of a placeholder
 * — a prompt that looks entirely normal and says something else. So motions step
 * over it (`l` from its `[` lands past its `]`, `b` from after it comes back to
 * the `[`), `x`/`X`/`d{motion}` and a selection take all of it, a word motion
 * treats it as the one punctuation-class word it is, `a` inserts after it and `i`
 * before it, and the two commands that rewrite a character without choosing where
 * to cut — `r` and the case commands — leave it alone rather than spell it wrong.
 * See {@link pasteTokenAt}, {@link splitsPasteToken}.
 *
 * Deliberate simplifications: f/t/F/T are line-scoped (as in vim); marks,
 * registers beyond the unnamed one, and `:` ex-commands are out of scope — but
 * the keys that would open them are still taken, so the keys after them cannot
 * be read as commands instead: `m`/`"`/`'`/`` ` `` read the name that follows,
 * `z`/`Z`/`q`/`@` read the command or the register that follows, and `/`/`?`/`:`
 * take their input line up to Enter or Escape and drop it.
 * j/k delegate to prompt-history recall when the buffer has no newline (the
 * common single-line REPL case).
 *
 * Contracts the host relies on:
 *   - Enter is never consumed: it submits the prompt, abandoning any half-typed
 *     command rather than swallowing the send — a dropped `/` line or an
 *     unfinished `m`/`"` name included.
 *   - Escape is consumed only when it has something to cancel. An idle Escape
 *     in NORMAL mode returns false, because ink hands the same keypress to every
 *     `useInput` listener with no stop-propagation: the REPL's own Escape
 *     (interrupt) is a separate listener, so "consumed" cannot silence it and
 *     the decision has to be made on the value.
 *   - In NORMAL mode the cursor sits on a character: `h`/`l` and the edits stay
 *     on their line (a newline is structure — `x` at a line end is a no-op, not
 *     a line join) and no motion stops past the last character. Indexes are
 *     UTF-16 code units, so motion and edits step by code point and by combining
 *     mark — a surrogate pair is never split, and an accent never leaves its
 *     letter.
 *   - One command is one undo step: compound edits (cc, 3J) write their final
 *     text once, and an edit that changes nothing writes nothing at all.
 *
 * All structural mutations go through `ops.setAll` — the host wires that to an
 * undo-recording setState. Cursor-only moves use `ops.setCursor` and are not
 * undoable (vim separates cursor motion from the undo tree the same way).
 */

import { pasteTokenAt } from "./paste.ts";

export type VimMode = "normal" | "insert" | "visual" | "visual-line";

export interface VimOps {
	getText(): string;
	getCursor(): number;
	setCursor(pos: number): void;
	setAll(text: string, cursor: number): void;
	enterInsert(): void;
	toNormal(): void;
	/** j/k on a single-line buffer delegates to prompt history. */
	recallHistory(direction: "up" | "down"): void;
	undo(): void;
	redo(): void;
}

export interface VimKey {
	escape?: boolean;
	return?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	tab?: boolean;
	home?: boolean;
	end?: boolean;
	/** The Backspace key: a motion (`h` with wrap) in NORMAL, a delete in INSERT. */
	backspace?: boolean;
	/** The Delete key: `x` in NORMAL, a forward delete in INSERT. */
	delete?: boolean;
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
}

// ---------------------------------------------------------------------------
// Pure text helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const BLANK = 0;
const PUNCT = 1;
const WORD = 2;
const EMOJI = 3;
const SUPERSCRIPT = 4;
const SUBSCRIPT = 5;
const BRAILLE = 6;
const HIRAGANA = 7;
const KATAKANA = 8;
const CJK = 9;
const HANGUL = 10;

type CharClass = number;

/**
 * Vim's character classes, the way `mb_get_class` computes them.
 *
 * Three classes — blank, punctuation, word — are what a word motion needs in
 * ASCII, and they are all it used to get everywhere, which is the whole of the
 * bug. `utf_class_buf` in vim's `mbyte.c` does two different things above
 * U+00FF. Inside Latin-1 it defers to `iskeyword`, whose default is
 * `@,48-57,_,192-255` — so `é` and `Ü` are letters (JavaScript's `\w` is
 * `[A-Za-z0-9_]`, and `dw` in `café` stopped after three characters) and so is
 * `×`, while `¡` at U+00A1 stays punctuation because it is below 192.
 *
 * Above that it stops asking about words and asks about *scripts*, with each one
 * its own class: kanji, hiragana, katakana and hangul are four, so `dw` in a
 * Japanese sentence stops at every transition between them. In Chinese there is
 * no transition to stop at, which is why a run of hanzi is a single word to both
 * this and vim — and why a fix aimed at "CJK" that only widened the word class
 * would have changed nothing a Chinese user could see while breaking Japanese.
 *
 * The intervals below are transcribed from that function's `classes[]`, searched
 * the same way. Vim stores a script's first character as its class value and
 * only ever compares classes for equality, so they are renumbered to 4..10.
 * Anything the table does not list is a word character, which is the last line of
 * vim's function and the most surprising thing in it: `→` and `€` are punctuation
 * only because they fall inside a listed interval, and `ß`, `ж` and `λ` are words
 * because nothing lists them.
 *
 * {@link EMOJI} is checked *before* that search, not inside it, which is why it
 * is a table of its own: an emoji in a punctuation block would be punctuation
 * without it, and `dw` on `€👍` would take the pair as one word instead of
 * stopping between them. It is the one class that is not named after a script.
 */
const CLASS_INTERVALS: ReadonlyArray<readonly [number, number, CharClass]> = [
	[0x037e, 0x037e, PUNCT],
	[0x0387, 0x0387, PUNCT],
	[0x055a, 0x055f, PUNCT],
	[0x0589, 0x0589, PUNCT],
	[0x05be, 0x05be, PUNCT],
	[0x05c0, 0x05c0, PUNCT],
	[0x05c3, 0x05c3, PUNCT],
	[0x05f3, 0x05f4, PUNCT],
	[0x060c, 0x060c, PUNCT],
	[0x061b, 0x061b, PUNCT],
	[0x061f, 0x061f, PUNCT],
	[0x066a, 0x066d, PUNCT],
	[0x06d4, 0x06d4, PUNCT],
	[0x0700, 0x070d, PUNCT],
	[0x0964, 0x0965, PUNCT],
	[0x0970, 0x0970, PUNCT],
	[0x0df4, 0x0df4, PUNCT],
	[0x0e4f, 0x0e4f, PUNCT],
	[0x0e5a, 0x0e5b, PUNCT],
	[0x0f04, 0x0f12, PUNCT],
	[0x0f3a, 0x0f3d, PUNCT],
	[0x0f85, 0x0f85, PUNCT],
	[0x104a, 0x104f, PUNCT],
	[0x10fb, 0x10fb, PUNCT],
	[0x1361, 0x1368, PUNCT],
	[0x166d, 0x166e, PUNCT],
	[0x1680, 0x1680, BLANK],
	[0x169b, 0x169c, PUNCT],
	[0x16eb, 0x16ed, PUNCT],
	[0x1735, 0x1736, PUNCT],
	[0x17d4, 0x17dc, PUNCT],
	[0x1800, 0x180a, PUNCT],
	[0x2000, 0x200b, BLANK],
	[0x200c, 0x2027, PUNCT],
	[0x2028, 0x2029, BLANK],
	[0x202a, 0x202e, PUNCT],
	[0x202f, 0x202f, BLANK],
	[0x2030, 0x205e, PUNCT],
	[0x205f, 0x205f, BLANK],
	[0x2060, 0x206f, PUNCT],
	[0x2070, 0x207f, SUPERSCRIPT],
	[0x2080, 0x2094, SUBSCRIPT],
	[0x20a0, 0x27ff, PUNCT],
	[0x2800, 0x28ff, BRAILLE],
	[0x2900, 0x2998, PUNCT],
	[0x29d8, 0x29db, PUNCT],
	[0x29fc, 0x29fd, PUNCT],
	[0x2e00, 0x2e7f, PUNCT],
	[0x3000, 0x3000, BLANK],
	[0x3001, 0x3020, PUNCT],
	[0x3030, 0x3030, PUNCT],
	[0x303d, 0x303d, PUNCT],
	[0x3040, 0x309f, HIRAGANA],
	[0x30a0, 0x30ff, KATAKANA],
	[0x3300, 0x9fff, CJK],
	[0xac00, 0xd7a3, HANGUL],
	[0xf900, 0xfaff, CJK],
	[0xfd3e, 0xfd3f, PUNCT],
	[0xfe30, 0xfe6b, PUNCT],
	[0xff00, 0xff0f, PUNCT],
	[0xff1a, 0xff20, PUNCT],
	[0xff3b, 0xff40, PUNCT],
	[0xff5b, 0xff65, PUNCT],
	[0x1d000, 0x1d24f, PUNCT],
	[0x1d400, 0x1d7ff, PUNCT],
	[0x1f000, 0x1f2ff, PUNCT],
	[0x1f300, 0x1f9ff, PUNCT],
	[0x20000, 0x2a6df, CJK],
	[0x2a700, 0x2b73f, CJK],
	[0x2b740, 0x2b81f, CJK],
	[0x2f800, 0x2fa1f, CJK],
];

/** `emoji_all`, verbatim: 146 intervals. */
const EMOJI_ALL: ReadonlyArray<readonly [number, number]> = [
	[0x203c, 0x203c],
	[0x2049, 0x2049],
	[0x2122, 0x2122],
	[0x2139, 0x2139],
	[0x2194, 0x2199],
	[0x21a9, 0x21aa],
	[0x231a, 0x231b],
	[0x2328, 0x2328],
	[0x23cf, 0x23cf],
	[0x23e9, 0x23f3],
	[0x23f8, 0x23fa],
	[0x24c2, 0x24c2],
	[0x25aa, 0x25ab],
	[0x25b6, 0x25b6],
	[0x25c0, 0x25c0],
	[0x25fb, 0x25fe],
	[0x2600, 0x2604],
	[0x260e, 0x260e],
	[0x2611, 0x2611],
	[0x2614, 0x2615],
	[0x2618, 0x2618],
	[0x261d, 0x261d],
	[0x2620, 0x2620],
	[0x2622, 0x2623],
	[0x2626, 0x2626],
	[0x262a, 0x262a],
	[0x262e, 0x262f],
	[0x2638, 0x263a],
	[0x2640, 0x2640],
	[0x2642, 0x2642],
	[0x2648, 0x2653],
	[0x265f, 0x2660],
	[0x2663, 0x2663],
	[0x2665, 0x2666],
	[0x2668, 0x2668],
	[0x267b, 0x267b],
	[0x267e, 0x267f],
	[0x2692, 0x2697],
	[0x2699, 0x2699],
	[0x269b, 0x269c],
	[0x26a0, 0x26a1],
	[0x26a7, 0x26a7],
	[0x26aa, 0x26ab],
	[0x26b0, 0x26b1],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26c8, 0x26c8],
	[0x26ce, 0x26cf],
	[0x26d1, 0x26d1],
	[0x26d3, 0x26d4],
	[0x26e9, 0x26ea],
	[0x26f0, 0x26f5],
	[0x26f7, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2702, 0x2702],
	[0x2705, 0x2705],
	[0x2708, 0x270d],
	[0x270f, 0x270f],
	[0x2712, 0x2712],
	[0x2714, 0x2714],
	[0x2716, 0x2716],
	[0x271d, 0x271d],
	[0x2721, 0x2721],
	[0x2728, 0x2728],
	[0x2733, 0x2734],
	[0x2744, 0x2744],
	[0x2747, 0x2747],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2763, 0x2764],
	[0x2795, 0x2797],
	[0x27a1, 0x27a1],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2934, 0x2935],
	[0x2b05, 0x2b07],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
	[0x3030, 0x3030],
	[0x303d, 0x303d],
	[0x3297, 0x3297],
	[0x3299, 0x3299],
	[0x1f004, 0x1f004],
	[0x1f0cf, 0x1f0cf],
	[0x1f170, 0x1f171],
	[0x1f17e, 0x1f17f],
	[0x1f18e, 0x1f18e],
	[0x1f191, 0x1f19a],
	[0x1f1e6, 0x1f1ff],
	[0x1f201, 0x1f202],
	[0x1f21a, 0x1f21a],
	[0x1f22f, 0x1f22f],
	[0x1f232, 0x1f23a],
	[0x1f250, 0x1f251],
	[0x1f300, 0x1f321],
	[0x1f324, 0x1f393],
	[0x1f396, 0x1f397],
	[0x1f399, 0x1f39b],
	[0x1f39e, 0x1f3f0],
	[0x1f3f3, 0x1f3f5],
	[0x1f3f7, 0x1f4fd],
	[0x1f4ff, 0x1f53d],
	[0x1f549, 0x1f54e],
	[0x1f550, 0x1f567],
	[0x1f56f, 0x1f570],
	[0x1f573, 0x1f57a],
	[0x1f587, 0x1f587],
	[0x1f58a, 0x1f58d],
	[0x1f590, 0x1f590],
	[0x1f595, 0x1f596],
	[0x1f5a4, 0x1f5a5],
	[0x1f5a8, 0x1f5a8],
	[0x1f5b1, 0x1f5b2],
	[0x1f5bc, 0x1f5bc],
	[0x1f5c2, 0x1f5c4],
	[0x1f5d1, 0x1f5d3],
	[0x1f5dc, 0x1f5de],
	[0x1f5e1, 0x1f5e1],
	[0x1f5e3, 0x1f5e3],
	[0x1f5e8, 0x1f5e8],
	[0x1f5ef, 0x1f5ef],
	[0x1f5f3, 0x1f5f3],
	[0x1f5fa, 0x1f64f],
	[0x1f680, 0x1f6c5],
	[0x1f6cb, 0x1f6d2],
	[0x1f6d5, 0x1f6d7],
	[0x1f6dc, 0x1f6e5],
	[0x1f6e9, 0x1f6e9],
	[0x1f6eb, 0x1f6ec],
	[0x1f6f0, 0x1f6f0],
	[0x1f6f3, 0x1f6fc],
	[0x1f7e0, 0x1f7eb],
	[0x1f7f0, 0x1f7f0],
	[0x1f90c, 0x1f93a],
	[0x1f93c, 0x1f945],
	[0x1f947, 0x1f9ff],
	[0x1fa70, 0x1fa7c],
	[0x1fa80, 0x1fa88],
	[0x1fa90, 0x1fabd],
	[0x1fabf, 0x1fac5],
	[0x1face, 0x1fadb],
	[0x1fae0, 0x1fae8],
	[0x1faf0, 0x1faf8],
];

const COMBINING_MARK = /\p{M}/u;

/**
 * The class of the code point `code`, with no notion of a buffer or of `big`.
 *
 * Exported so `../vim-differential/class.mjs` can hold it against real vim's own
 * `charclass()` over the whole code space — a table of 200-odd transcribed
 * intervals is not something a handful of word motions can vouch for.
 */
export function codePointClass(code: number): CharClass {
	if (code < 0x100) {
		// `iskeyword` decides this range, and its default `@,48-57,_,192-255`
		// leaves `¡` (U+00A1) and `¿` (U+00BF) out: they are punctuation in
		// Latin-1, and 192 is where the letters start.
		//
		// What comes first is `VIM_ISWHITE`, which is narrower than it sounds:
		// `macros.h` spells it as space or tab and nothing else, so a carriage
		// return, a form feed and U+0085 are all punctuation to vim. U+0000 is
		// blank for a separate reason — `mb_get_class_buf` answers it before the
		// keyword table is consulted.
		//
		// The one addition is U+000A, and it is not a transcription of anything.
		// A vim buffer has no line-break character to classify — `fwd_word` steps
		// over the break with `inc()` and asks the class of the *next* line's
		// first character instead — whereas this engine's buffer is one string
		// with `\n` in it, and a word motion that called `\n` punctuation would
		// stop on the last character of a line instead of crossing to the first
		// character of the next one. So `\n` is white space here because this
		// engine spells a line break that way, and it is the single place the
		// class table knowingly parts company with `charclass()`.
		if (code === 0x00 || code === 0x09 || code === 0x0a || code === 0x20 || code === 0xa0) return BLANK;
		if ((code >= 0x30 && code <= 0x39) || code === 0x5f) return WORD;
		if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return WORD;
		if (code >= 0xc0 && code <= 0xff) return WORD;
		// `@` is the one entry of `iskeyword` that is a filter rather than a
		// range: `parse_isopt` expands it to 1-255 and sets the flag only where
		// `MB_ISLOWER` or `MB_ISUPPER` says letter. Both go through vim's own
		// `toUpper`/`toLower` interval tables rather than the C library, because
		// `'casemap'` defaults to `internal` — so this is a fixed answer and not
		// one that changes with the machine's locale. Below 192 it adds exactly
		// one character: `µ`, which has an upper case form in Greek and so is
		// lower case. `ª` and `º` have no case mapping in either table and are
		// punctuation, which is the kind of thing only asking vim could tell you.
		if (code === 0xb5) return WORD;
		return PUNCT;
	}
	// The emoji table is asked before the class table, and outranks it: `✿` at
	// U+273F is inside a punctuation interval and is an emoji here all the same.
	if (inIntervals(EMOJI_ALL, code)) return EMOJI;
	let bot = 0;
	let top = CLASS_INTERVALS.length - 1;
	while (top >= bot) {
		const mid = (bot + top) >> 1;
		const [first, last, cls] = CLASS_INTERVALS[mid] as readonly [number, number, CharClass];
		if (last < code) bot = mid + 1;
		else if (first > code) top = mid - 1;
		else return cls;
	}
	// "most other characters are 'word' characters" — the last line of
	// `utf_class_buf`, and the one that makes `ß` and `λ` words.
	return WORD;
}

/** Whether `code` falls inside any of the sorted, non-overlapping `table`. */
function inIntervals(table: ReadonlyArray<readonly [number, number]>, code: number): boolean {
	let bot = 0;
	let top = table.length - 1;
	while (top >= bot) {
		const mid = (bot + top) >> 1;
		const [first, last] = table[mid] as readonly [number, number];
		if (last < code) bot = mid + 1;
		else if (first > code) top = mid - 1;
		else return true;
	}
	return false;
}

/**
 * The class of the character at `pos` — the whole character, so a surrogate pair
 * is one character and not two halves of one. Every word motion asks this of
 * every position it walks, which is why the class is a number looked up in a
 * table rather than a regular expression run per character.
 */
function charClass(text: string, pos: number, big = false): CharClass {
	const code = text.codePointAt(pos);
	if (code === undefined) return BLANK;
	// A combining mark rides on the character before it, so a word motion walks
	// through it rather than stopping between the base letter and its accent.
	// Above U+00FF this falls out of the table anyway — a mark is unlisted and so
	// is a word — but the Latin-1 ones are inside the `192-255` range as their own
	// code points, and those have to be asked about.
	if (code < 0x300 && COMBINING_MARK.test(text[pos] as string)) return WORD;
	const cls = codePointClass(code);
	// `W` and `B` report every non-blank as one class, so the only question left
	// is whether vim calls it white space — which is the whole of `cls()`'s
	// bigword branch, and the same answer this table already has.
	return big && cls !== BLANK ? WORD : cls;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * How many units the combining mark at `pos` takes, or 0 for anything else. The
 * fast reject matters: word motions call this for every character of the buffer.
 */
function markWidthAt(text: string, pos: number): number {
	if (pos < 0 || pos >= text.length) return 0;
	const code = text.codePointAt(pos);
	if (code === undefined || code < 0x300) return 0; // below the first mark block
	if (!COMBINING_MARK.test(String.fromCodePoint(code))) return 0;
	return code > 0xffff ? 2 : 1;
}

/**
 * The next character boundary after `pos`. A surrogate pair (an emoji, a rare
 * CJK ideograph) is one character spread over two UTF-16 units, so stepping by
 * `pos + 1` would land inside it and every slice from there would corrupt it.
 * Combining marks are not characters either: `é` written as `e` + U+0301 is one
 * position in vim, base and mark together.
 *
 * A paste token is one character too, for the reason its own module gives: it is
 * literal ASCII, so anything that stepped through it one unit at a time could
 * stop between its brackets and leave a string `expandPasteTokens` no longer
 * matches. Every position this engine reaches runs through here, which is why one
 * check here is the whole of it.
 */
export function nextChar(text: string, pos: number): number {
	const token = pasteTokenAt(text, pos);
	if (token) return token.end;
	const pair = isHighSurrogate(text.charCodeAt(pos)) && isLowSurrogate(text.charCodeAt(pos + 1)) ? 2 : 1;
	let end = pos + pair;
	for (let width = markWidthAt(text, end); width > 0; width = markWidthAt(text, end)) end += width;
	return end;
}

/** The character boundary before `pos`, stepping over a whole pair or cluster. */
export function prevChar(text: string, pos: number): number {
	if (pos <= 0) return 0;
	// The mirror of `nextChar`: from just past a token, or from inside one, the
	// character before is the token's `[`. `pos - 1` rather than `pos` because a
	// position that is itself a token's start has a character in front of it.
	const token = pasteTokenAt(text, pos - 1);
	if (token) return token.start;
	let end = pos;
	for (;;) {
		if (markWidthAt(text, end - 2) === 2) {
			end -= 2;
			continue;
		}
		if (markWidthAt(text, end - 1) === 1) {
			end -= 1;
			continue;
		}
		break;
	}
	const before = end - 1;
	return isLowSurrogate(text.charCodeAt(before)) && isHighSurrogate(text.charCodeAt(before - 1)) ? before - 1 : before;
}

/**
 * One Backspace step: left within the line, and off the front of it onto the
 * line break before it. That crossing is vim's default `whichwrap` (`b`), and it
 * is the whole difference between <BS> and `h`, which stops at the line start.
 *
 * The step lands on the break itself, not on the last character of the line
 * above: the motion settles the caret onto that character after every step (so
 * the caret sits where vim's does), while an operator deletes up to the break —
 * which is why `d<BS>` at a line start joins the two lines.
 */
function backspaceBoundary(text: string, pos: number): number {
	const start = lineStart(text, pos);
	return pos > start ? prevChar(text, pos) : Math.max(0, start - 1);
}

/**
 * One Space step: right within the line, and off the end of it onto the next
 * line. That wrap is the other half of vim's default `whichwrap` (`s`), so
 * `d<BS>`'s forward twin is a caret move rather than a character typed into the
 * buffer from NORMAL mode. At the buffer end there is nowhere to go.
 */
function spaceBoundary(text: string, pos: number): number {
	const end = lineEndExclusive(text, pos);
	const next = nextChar(text, pos);
	if (next < end) return next;
	// On the last character of the line there is no character left to step to, and
	// that is exactly when the wrap happens. On the last line of the buffer there
	// is nothing to wrap onto either, so the caret stays where it is.
	return end < text.length ? nextChar(text, end) : pos;
}

/** The whole character ending at `end` (exclusive), or "" when the line has none. */
function charEndingAt(text: string, end: number, lineBegin: number): string {
	return end <= lineBegin ? "" : text.slice(prevChar(text, end), end);
}

/**
 * Snap an index that landed inside a character back onto the character it is part
 * of — the low half of a surrogate pair, or the interior of a paste token.
 *
 * The token case is not hypothetical: a `j` aims at a *column*, and a column
 * inside a token is a real column of the line. Without the snap the caret stands
 * between the token's `P` and `a`, and the very next `x` cuts the payload in half.
 */
export function snapToChar(text: string, pos: number): number {
	if (pos > 0 && pos < text.length) {
		const token = pasteTokenAt(text, pos);
		if (token !== null && pos > token.start) return token.start;
		if (isLowSurrogate(text.charCodeAt(pos)) && isHighSurrogate(text.charCodeAt(pos - 1))) {
			return pos - 1;
		}
	}
	return pos;
}

/**
 * The start of the last character on the line containing `pos` — where `$`,
 * `G` and a count-limited `l` land. An empty line has no character of its own,
 * so it stands on its newline.
 */
function lineLastChar(text: string, pos: number): number {
	const start = lineStart(text, pos);
	const end = lineEndExclusive(text, pos);
	return end > start ? prevChar(text, end) : start;
}

/**
 * Where the cursor lands after text at `pos` was removed: on a real character,
 * never past the buffer, and never on the newline of a line that still has text
 * before it — vim steps back onto the last character it left behind.
 */
function settleCursor(text: string, pos: number): number {
	if (text.length === 0) return 0;
	// A trailing line break opens an empty last line, and the caret belongs on it;
	// stepping back would leave it at the end of the line above.
	if (pos >= text.length) return text.endsWith("\n") ? text.length : prevChar(text, text.length);
	if (text[pos] === "\n" && pos > lineStart(text, pos)) return prevChar(text, pos);
	return pos;
}

/**
 * The buffer range covering lines [firstLine, lastLine], plus the offset a delete
 * starts removing from. A range that runs to the end of the buffer takes the line
 * break before it: leaving that newline behind would turn "delete the last line"
 * into "the last line becomes empty".
 */
function lineRange(
	text: string,
	firstLine: number,
	lastLine: number,
): { start: number; end: number; removeFrom: number } {
	const start = nthLineStart(text, firstLine);
	const lastEnd = lineEndExclusive(text, nthLineStart(text, lastLine));
	if (lastEnd < text.length) return { start, end: lastEnd + 1, removeFrom: start };
	// Every line is in the range: there is no line break before it to take, and
	// removing from the front is what empties the buffer (`dG` on the last line,
	// `5dj` from the top). Leaving the offset at the buffer end would slice the
	// range out and then put it straight back — a delete that silently does
	// nothing.
	return { start, end: lastEnd, removeFrom: start > 0 ? start - 1 : 0 };
}

/**
 * Where a linewise delete leaves the caret: the first non-blank of the line the
 * deletion collapsed onto — the line that now stands where the removed block
 * began, which is the buffer end when the block ran to the end of it.
 */
function linewiseLanding(text: string, removeFrom: number): number {
	return settleCursor(text, motionFirstNonBlank(text, lineStart(text, Math.min(removeFrom, text.length))));
}

/** `~` over a range: swap the case of every cased character, leave the rest. */
function swapCase(segment: string): string {
	return segment
		.split("")
		.map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
		.join("");
}

export function lineStart(text: string, pos: number): number {
	let i = pos - 1;
	while (i >= 0 && text[i] !== "\n") i--;
	return i + 1;
}

export function lineEndExclusive(text: string, pos: number): number {
	let i = pos;
	while (i < text.length && text[i] !== "\n") i++;
	return i;
}

export function lineOf(text: string, pos: number): number {
	let count = 0;
	for (let i = 0; i < pos && i < text.length; i++) {
		if (text[i] === "\n") count++;
	}
	return count;
}

export function nthLineStart(text: string, line: number): number {
	let pos = 0;
	for (let i = 0; i < line; i++) {
		const next = text.indexOf("\n", pos);
		if (next === -1) return pos;
		pos = next + 1;
	}
	return pos;
}

export function lineCount(text: string): number {
	if (text.length === 0) return 1;
	let count = 1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") count++;
	}
	return count;
}

/**
 * Whether `pos` sits on the last line of the buffer — there is no line break after it.
 *
 * Worth its own name because `cursor_down` has two ways to say no and only this is
 * one of them: the other (`edit.c:3087`) also needs `CPO_MINUS` in `'cpoptions'`,
 * which the default `aABceFs` does not contain. A motion that fails this way leaves
 * the caret exactly where it was, where one that runs out of lines short of its
 * target clamps onto the last one instead — so a counted `$` has to tell the two
 * apart rather than treat "no line there" as one answer.
 */
export function onLastLine(text: string, pos: number): boolean {
	return text.indexOf("\n", Math.max(0, pos)) === -1;
}

/**
 * Whether cutting `[start, end)` out of `text` would leave part of a paste token
 * behind — the one way an edit can lose a payload while looking like it worked.
 *
 * Exported and tested on its own because it is an invariant rather than a
 * behaviour. Every motion here lands on a position the engine can step to, and
 * `nextChar` steps over a whole token, so no command reaches the guard that asks
 * it; an invariant nothing can falsify is worth nothing unless it is stated as a
 * function and held against examples, which `vim-engine.test.ts` does. Refusing
 * the range is the smaller harm anyway: a `d` that changed nothing is a nuisance,
 * a silently lost paste is the bug this whole arrangement exists to prevent.
 */
export function splitsPasteToken(text: string, start: number, end: number): boolean {
	// Cut into a token at the front of the range.
	const atStart = pasteTokenAt(text, start);
	if (atStart !== null && start > atStart.start) return true;
	// Or leave the tail of one that begins inside it. Every `[` in the range is
	// asked about, because a stray bracket before a real token is not one.
	for (let i = text.indexOf("[", start); i >= 0 && i < end; i = text.indexOf("[", i + 1)) {
		const token = pasteTokenAt(text, i);
		if (token !== null) return token.end > end;
	}
	return false;
}

/**
 * `fn` applied to every run of `[from, to)` that is not inside a paste token, the
 * tokens themselves copied across untouched.
 *
 * For the case commands, which are the only edits here that rewrite a character
 * without choosing where to cut. A token has to keep its exact spelling to be
 * recognized at submit time, and `~` on `[Pasted 800 chars #1]` would give
 * `[pASTED 800 CHARS #1]` — a buffer that looks the same and submits as a
 * twenty-character gibberish in place of what the user pasted.
 */
function mapOutsidePasteTokens(text: string, from: number, to: number, fn: (run: string) => string): string {
	let out = "";
	let i = from;
	while (i < to) {
		const token = pasteTokenAt(text, i);
		if (token !== null) {
			out += text.slice(i, Math.min(to, token.end));
			i = Math.min(to, token.end);
			continue;
		}
		// A plain run ends at the next bracket, which may be a stray one — then the
		// next turn of this loop takes it as the head of another plain run.
		const bracket = text.indexOf("[", i);
		const stop = bracket < 0 || bracket >= to ? to : bracket;
		out += fn(text.slice(i, stop));
		i = stop;
	}
	return out;
}

export function motionForwardWord(text: string, pos: number, big = false): number {
	const n = text.length;
	if (pos >= n) return n;
	let i = pos;
	const startCls = charClass(text, i, big);
	if (startCls !== 0) {
		while (i < n && charClass(text, i, big) === startCls) i = nextChar(text, i);
	}
	while (i < n && charClass(text, i, big) === 0) i = nextChar(text, i);
	return i;
}

export function motionBackWord(text: string, pos: number, big = false): number {
	if (pos <= 0) return 0;
	let i = prevChar(text, pos);
	while (i > 0 && charClass(text, i, big) === 0) i = prevChar(text, i);
	const c = charClass(text, i, big);
	while (i > 0 && charClass(text, prevChar(text, i), big) === c) i = prevChar(text, i);
	return i;
}

export function motionWordEnd(text: string, pos: number, big = false): number {
	const n = text.length;
	// `e` needs a character after the caret to move onto, so on the buffer's last
	// character it stays where it is — on that character, not on the second half of
	// a surrogate pair.
	if (pos >= n || nextChar(text, pos) >= n) return Math.max(0, lineLastChar(text, pos));
	let i = nextChar(text, pos);
	while (i < n && charClass(text, i, big) === 0) i = nextChar(text, i);
	while (i < n) {
		const next = nextChar(text, i);
		if (next >= n || charClass(text, next, big) === 0 || charClass(text, next, big) !== charClass(text, i, big)) break;
		i = next;
	}
	return i;
}

/**
 * The last character of the run of same-class characters the caret stands in —
 * the run's end, not the next word's. `e` steps on to the following word when
 * the caret already stands on a word's last character; `cw` does not, and this
 * is the motion that tells the two apart (`ce` keeps the plain `e`).
 */
export function motionWordEndHere(text: string, pos: number, big = false): number {
	const n = text.length;
	if (pos >= n) return Math.max(0, lineLastChar(text, pos));
	const cls = charClass(text, pos, big);
	let i = pos;
	for (;;) {
		const next = nextChar(text, i);
		// A line break belongs to no run: `cw` at the end of a word changes the word,
		// never the break after it.
		if (next >= n || text[next] === "\n" || charClass(text, next, big) !== cls) break;
		i = next;
	}
	return i;
}

export function motionFirstNonBlank(text: string, pos: number): number {
	const start = lineStart(text, pos);
	const end = lineEndExclusive(text, pos);
	let i = start;
	while (i < end && (text[i] === " " || text[i] === "\t")) i++;
	return i;
}

/**
 * How far one `>>` moves a line, in columns. There are no options in this
 * engine, so this is vim's default 'shiftwidth', which is also its 'tabstop':
 * a full shift is one TAB and the remainder of a partial indent is spaces.
 */
const SHIFT_WIDTH = 8;
const TABSTOP = 8;

/** Leading whitespace of `line`, measured in screen columns (tabs to a tabstop). */
function indentColumns(line: string): number {
	let cols = 0;
	for (const c of line) {
		if (c === "\t") cols += TABSTOP - (cols % TABSTOP);
		else if (c === " ") cols += 1;
		else break;
	}
	return cols;
}

/** The line with `cols` columns of indent in front of its text — vim's set_indent. */
function withIndent(line: string, cols: number): string {
	return "\t".repeat(Math.floor(cols / TABSTOP)) + " ".repeat(cols % TABSTOP) + line.replace(/^[ \t]+/, "");
}

/**
 * vim's MAXCOL, the wanted column `$` arms: not a column at all but the promise
 * "the end of whatever line the next motion lands on". A caret at the end of a
 * long line, a `j` onto a short one and a `j` back is a round trip through it.
 */
const MAXCOL = Number.MAX_SAFE_INTEGER;

const WORD_MOTIONS = new Set(["w", "W", "b", "B", "e", "E"]);
const FIND_MOTIONS = new Set(["f", "F", "t", "T"]);
const LINEWISE_MOTIONS = new Set(["gg", "G", "j", "k"]);

/** `d`, `c`, `y` — and `>`/`<`, whose doubled form shifts instead of editing. */
type Operator = "d" | "c" | "y" | ">" | "<";

/**
 * A cap on `[count]`. Vim's own limit is 2^31, which on a 60fps terminal means
 * a count long enough to freeze the event loop before the next frame — and a
 * frozen single-threaded REPL cannot even process the Ctrl+C that would stop
 * it. Nobody types four digits on purpose.
 */
const MAX_COUNT = 10000;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class VimEngine {
	mode: VimMode;
	/** Selection range while in a visual mode (start < end). */
	selection: { start: number; end: number } | null = null;

	#ops: VimOps;
	#anchor = 0;
	#pending: { operator: Operator; count: number; explicit: boolean } | null = null;
	#pendingChar: "f" | "F" | "t" | "T" | "r" | null = null;
	#pendingCharWithOp = false;
	/** The count that arrived with f/F/t/T/r, spent when the second key lands. */
	#pendingCharCount = 1;
	#pendingG: { operator: Operator | null; count: number; explicit: boolean } | null = null;
	/** Visual mode has one `g` command (`gJ`), so it needs its own latch. */
	#visualPendingG = false;
	/**
	 * `m`, `"`, `'` and `` ` `` take one more key. Marks and named registers are out
	 * of scope (see the header), so that key is read and dropped — read, because a
	 * dropped prefix leaves the keys after it to be read as commands again: `ma`
	 * meant "swallow `m`, then append", and `"ayy` typed "ayy" into the prompt.
	 */
	#prefixPending = false;
	/**
	 * `/`, `?` and `:` open vim's own input line, which this engine does not have
	 * (no search, no ex-commands). The keys go there and are dropped, until Enter
	 * (which still submits) or Escape (which cancels the line): `/foo` used to arm a
	 * find with its first `o` and open a line with its second.
	 */
	#inputPending = false;
	#countBuffer = "";
	/** Whether the count `#takeCount` last returned was typed or the implicit 1. */
	#countExplicit = false;
	/**
	 * The column a `j`/`k` comes back to — vim's `w_curswant` — as a character
	 * offset inside the line, or MAXCOL for "the end of the line". `null` is vim's
	 * `w_set_curswant`: the caret has moved without the engine watching (typing,
	 * undo, history recall), so the column has to be read off the caret again at
	 * the top of the next command, where vim's `update_curswant` reads it too.
	 */
	#curswant: number | null = null;
	#lastFind: { char: string; forward: boolean; till: boolean } | null = null;
	#register: { text: string; linewise: boolean } = { text: "", linewise: false };
	/**
	 * Whether the caret's end of the visual selection reaches past the last
	 * character of its line, so the line break is part of the selection. Only a
	 * command that ran inside the selection arms it — `$`, a `|` past the line end,
	 * or an `l` that ran out of characters: `$vd` deletes one character where `v$d`
	 * takes the line break with it (probed on vim 9.1), and `ved` keeps the break
	 * where `v2ld` at the end of a two-character line takes it.
	 */
	#visualPastEnd = false;

	constructor(ops: VimOps) {
		this.#ops = ops;
		this.mode = "normal";
	}

	// -- main entry -----------------------------------------------------------

	/**
	 * Handle one key event. Returns true when consumed. In insert mode only
	 * Esc is consumed; everything else falls through to normal typing. Global
	 * shortcuts (ctrl/meta combos except ctrl+r) stay unconsumed so the host
	 * keeps its own keybindings, as does Enter (the REPL submits) and an Escape
	 * with nothing left to cancel.
	 */
	handleKey(input: string, key: VimKey): boolean {
		if (this.mode === "insert") {
			if (key.escape) {
				// Leaving insert steps back onto the character just typed (vim), which
				// is also what keeps the NORMAL cursor on a character instead of one
				// past the end, where the next `x` would silently do nothing.
				const text = this.#ops.getText();
				const pos = this.#ops.getCursor();
				if (pos > 0 && text[pos - 1] !== "\n") this.#ops.setCursor(prevChar(text, pos));
				this.mode = "normal";
				this.#ops.toNormal();
				this.#wantHere();
				return true;
			}
			return false;
		}

		if (key.meta) return false;
		if (key.ctrl) {
			// A ctrl combo belongs to the host, and it abandons a half-typed command
			// the way Ctrl+C leaves vim's own command line.
			this.#prefixPending = false;
			this.#inputPending = false;
			if (input === "r") {
				this.#ops.redo();
				this.#forgetCurswant(); // the restored caret is the new wanted column
				return true;
			}
			return false; // host shortcuts (ctrl+c, ctrl+o, …)
		}

		// The one key `m`/`"`/`'` asked for: read it and drop it.
		if (this.#prefixPending) {
			this.#prefixPending = false;
			if (key.return) return false; // the host still submits
			return true; // the name, or the Escape that cancels it, is consumed
		}

		// vim's `/`, `?` and `:` input line: it holds every key up to Enter or Escape.
		if (this.#inputPending) {
			if (key.escape) {
				this.#inputPending = false;
				return true;
			}
			if (key.return) {
				this.#inputPending = false;
				return false; // Enter is the host's: the line is dropped, the send is not
			}
			return true; // the key belongs to the input line, and is dropped with it
		}

		if (this.mode === "visual" || this.mode === "visual-line") {
			return this.#handleVisual(input, key);
		}
		return this.#handleNormal(input, key);
	}

	// -- shared ---------------------------------------------------------------

	#takeCount(): number {
		this.#countExplicit = this.#countBuffer !== "";
		const n = this.#countExplicit ? Number(this.#countBuffer) : 1;
		this.#countBuffer = "";
		if (!Number.isFinite(n)) return 1;
		return Math.max(1, Math.min(Math.floor(n), MAX_COUNT));
	}

	#resetPending(): void {
		this.#pending = null;
		this.#pendingChar = null;
		this.#pendingCharWithOp = false;
		this.#pendingCharCount = 1;
		this.#pendingG = null;
		this.#visualPendingG = false;
		this.#prefixPending = false;
		this.#inputPending = false;
		this.#countBuffer = "";
	}

	#clamp(pos: number): number {
		return Math.max(0, Math.min(pos, this.#ops.getText().length));
	}

	/**
	 * Materialize the wanted column from the caret: what every deliberate motion
	 * ends up doing (vim's `w_set_curswant` read back at the top of the next
	 * command), and what a `j`/`k` comes back to after it.
	 */
	#wantHere(): void {
		const text = this.#ops.getText();
		this.#curswant = this.#ops.getCursor() - lineStart(text, this.#ops.getCursor());
	}

	/** The same, for a motion that leaves the wanted column alone when it fails. */
	#wantHereIfMoved(from: number): void {
		if (this.#ops.getCursor() !== from) this.#wantHere();
	}

	/**
	 * The wanted column as a number, read off the caret when the engine has been
	 * out of the loop — vim's `update_curswant`, which runs before every command
	 * reads `w_curswant`.
	 */
	#wantColumn(): number {
		if (this.#curswant === null) this.#wantHere();
		return this.#curswant ?? 0;
	}

	/**
	 * The caret position `want` columns into `line`, clamped to that line's last
	 * character: what every "aim at a column" motion ends up doing (vim's
	 * `coladvance`). An empty line takes the caret to its own start, and a column
	 * past the end of a short line to the character that is there.
	 */
	#columnOn(line: number, want: number): number {
		const text = this.#ops.getText();
		const targetStart = nthLineStart(text, line);
		const targetEnd = lineEndExclusive(text, targetStart);
		const col = want === MAXCOL ? Number.POSITIVE_INFINITY : want;
		return snapToChar(text, Math.min(targetStart + col, Math.max(targetStart, targetEnd - 1)));
	}

	/**
	 * The caret has moved without the engine watching — typing, undo, a recalled
	 * history line — so the wanted column is stale until the next command reads it
	 * off the caret, as `update_curswant` does on vim's main loop.
	 */
	#forgetCurswant(): void {
		this.#curswant = null;
	}

	// -- normal mode ----------------------------------------------------------

	#handleNormal(input: string, key: VimKey): boolean {
		// Where vim's `update_curswant` runs: the wanted column is settled from the
		// caret before the command decides anything, so a stale one (after typing or
		// an undo) cannot leak a column from some earlier line.
		if (this.#curswant === null) this.#wantHere();
		// Enter is the host's: it submits the prompt. A half-typed command is
		// abandoned rather than allowed to swallow the send — `f` then Enter must
		// submit, not go silent because one more key was expected.
		if (key.return) {
			this.#resetPending();
			return false;
		}
		// Escape cancels whatever is half-typed. With nothing pending it comes back
		// unconsumed, because the host's Escape (interrupt) is a separate listener
		// that "consumed" cannot stop.
		if (key.escape) {
			if (this.#pending || this.#pendingChar || this.#pendingG || this.#countBuffer) {
				this.#resetPending();
				return true;
			}
			return false;
		}

		// 1. Complete a pending second keypress (r / f / F / t / T).
		if (this.#pendingChar) {
			const kind = this.#pendingChar;
			this.#pendingChar = null;
			// Backspace and Delete are not characters to find or replace with: vim
			// drops the half-typed command rather than acting on the key.
			if (key.backspace || key.delete) {
				this.#resetPending();
				return true;
			}
			const char = input;
			if (kind === "r") {
				this.#replaceChar(char, this.#pendingCharCount);
				this.#resetPending();
				return true;
			}
			this.#lastFind = { char, forward: kind === "f" || kind === "t", till: kind === "t" || kind === "T" };
			if (this.#pendingCharWithOp && this.#pending) {
				const op = this.#pending.operator;
				const preCount = this.#pending.count;
				this.#pending = null;
				this.#applyOperator(op, kind, Math.max(1, preCount) * this.#takeCount(), char);
			} else {
				this.#applyFind(kind, char, this.#pendingCharCount);
			}
			return true;
		}

		// 2. Complete a pending operator.
		if (this.#pending) {
			// `d0` deletes to the start of the line: `0` is a motion here, not a
			// digit of a count, unless a count is already under way (`d20l`).
			if (/^[1-9]$/.test(input) || (input === "0" && this.#countBuffer !== "")) {
				this.#countBuffer += input;
				return true;
			}
			const { operator, count } = this.#pending;
			const preCountExplicit = this.#pending.explicit;
			// `d<BS>` is `dh` — and unlike a bare <BS> the motion it names is the
			// wrapping one, so at a line start it reaches the line above. Delete is
			// not a motion at all: vim drops the operator and leaves the text alone.
			if (key.backspace) {
				this.#pending = null;
				this.#applyOperator(operator, "BS", count * this.#takeCount());
				return true;
			}
			if (key.delete) {
				// A count still being typed loses its last digit to the key instead
				// (vim reads counts in a loop that treats <Del> as backspace over the
				// digits), and the operator stays armed for the motion that follows.
				if (this.#countBuffer !== "") {
					this.#countBuffer = this.#countBuffer.slice(0, -1);
					return true;
				}
				this.#resetPending();
				return true;
			}
			// The terminal movement keys are vim's own motions, so after an operator
			// they are the ones their letters name: `d<Left>` is `dh`, `d<Down>` is the
			// linewise `dj`, `d<End>` is `d$` — each with the count, as `2d<Right>` and
			// `d2<Right>` both show. They have to be named here rather than left to
			// fall through to the character path below, where an empty `input` is no
			// motion at all and the operator is silently dropped.
			const terminalMotion = key.leftArrow
				? "h"
				: key.rightArrow
					? "l"
					: key.upArrow
						? "k"
						: key.downArrow
							? "j"
							: key.end
								? "$"
								: null;
			if (terminalMotion !== null) {
				this.#pending = null;
				this.#applyOperator(operator, terminalMotion, count * this.#takeCount());
				return true;
			}
			if (input === operator) {
				this.#pending = null;
				const effective = count * this.#takeCount();
				// `>>` shifts that many lines; `dd` deletes them.
				if (operator === ">" || operator === "<") this.#shiftLines(effective, operator === ">");
				else this.#applyLinewise(operator, effective);
				return true;
			}
			if (WORD_MOTIONS.has(input) || ["0", "^", "$", "|", "G", "j", "k", "h", "l", " "].includes(input)) {
				this.#pending = null;
				const effective = count * this.#takeCount();
				// `d<Space>` is `dl` — Space is `l` with 'whichwrap' letting it wrap,
				// and the character it wraps onto is in the range. (vim joins the line
				// instead when the caret's line is empty; this engine leaves that one as
				// the no-op a failed `l` is.)
				this.#applyOperator(
					operator,
					input === " " ? "l" : input,
					effective,
					undefined,
					preCountExplicit || this.#countExplicit,
				);
				return true;
			}
			if (input === "g") {
				// d g g — the operator moves to `#pendingG` and waits for the second g.
				// Leaving it armed here would make `dgg` do nothing but keep the `d`
				// waiting, so the next unrelated motion would finish the operator.
				this.#pending = null;
				this.#pendingG = {
					operator,
					count: count * this.#takeCount(),
					explicit: preCountExplicit || this.#countExplicit,
				};
				return true;
			}
			if (FIND_MOTIONS.has(input)) {
				// df{c} / dt{c}: keep the operator alive until the char arrives.
				this.#pendingChar = input as "f" | "F" | "t" | "T";
				this.#pendingCharWithOp = true;
				return true;
			}
			if (input === '"' || input === "m" || input === "'" || input === "`") {
				// `d"a…` names the register to delete into — vim takes one after an
				// operator as well as before it — and `dm…` names a mark. Neither exists
				// here; the name is read and dropped with the operator, so what follows
				// is still read as commands of its own (`d"ayy` used to leave `a` to
				// enter insert and type the rest).
				this.#resetPending();
				this.#prefixPending = true;
				return true;
			}
			if (input === "z" || input === "Z" || input === "q" || input === "@") {
				// `dz…` cancels the operator like any other key that is no motion, but
				// the `z` command that is left still waits for its own key: `2dzx`
				// changes nothing, it does not delete a character with the `x`.
				this.#resetPending();
				this.#prefixPending = true;
				return true;
			}
			if (input === "/" || input === "?" || input === ":") {
				// `d/foo` deletes up to the next match. There is no search here, so the
				// motion cannot land and the operator goes with it — and the input that
				// follows goes where vim's command line is, not into the buffer
				// (`d/foo` used to end in an `o`, opening a line).
				this.#resetPending();
				this.#inputPending = true;
				return true;
			}
			// Unknown key under an operator: cancel and swallow (vim behavior).
			this.#resetPending();
			return true;
		}

		// 3. Complete pending g (gg, with or without an operator).
		if (this.#pendingG) {
			const { operator, count, explicit } = this.#pendingG;
			this.#pendingG = null;
			if (input === "g") {
				if (operator) {
					this.#applyOperator(operator, "gg", count, undefined, explicit);
				} else {
					// `2gg` is line 2, on its first non-blank — the count is a line
					// number, not a repetition.
					const text = this.#ops.getText();
					this.#ops.setCursor(motionFirstNonBlank(text, nthLineStart(text, Math.min(count, lineCount(text)) - 1)));
					this.#wantHere(); // beginline is a move: it discards a pending `$`
				}
			} else if (input === "J" && !operator) {
				// `gJ`: join without the space, and keep the next line's indent.
				this.#joinLines(count, true);
			}
			return true; // any non-g key after g is swallowed
		}

		// 4. Count prefix (0 alone is a motion).
		if (/^[1-9]$/.test(input) || (input === "0" && this.#countBuffer !== "")) {
			this.#countBuffer += input;
			return true;
		}

		// 5. Start an operator.
		if (input === "d" || input === "c" || input === "y" || input === ">" || input === "<") {
			this.#pending = { operator: input, count: this.#takeCount(), explicit: this.#countExplicit };
			this.#countBuffer = "";
			return true;
		}

		// 6. Start a find that may carry an operator.
		if (FIND_MOTIONS.has(input)) {
			this.#pendingChar = input as "f" | "F" | "t" | "T";
			this.#pendingCharWithOp = false;
			this.#pendingCharCount = this.#takeCount();
			return true;
		}

		// 7. Start gg.
		if (input === "g") {
			this.#pendingG = { operator: null, count: this.#takeCount(), explicit: this.#countExplicit };
			return true;
		}

		// 8. Single-key commands. The count is taken once here, so a command that
		// has no use for one still consumes it: `2j` has to move two lines, and it
		// must not leave a stray 2 behind for the next `x` to spend.
		// A `<Del>` typed while digits are pending is part of the count, not a
		// command: it divides the count by ten, so `12<Del>x` deletes one character
		// and `2<Del><Del>x` deletes one more. (vim's count loop in normal.c folds
		// K_DEL into the digit it is reading; K_BS is not part of it and stays a
		// plain movement.)
		if (key.delete && this.#countBuffer !== "") {
			this.#countBuffer = this.#countBuffer.slice(0, -1);
			return true;
		}
		const explicitCount = this.#countBuffer !== "";
		const count = this.#takeCount();

		// The Backspace and Delete keys are vim's too. Left undone they fall through
		// to the host, which would edit the buffer from NORMAL mode — Backspace
		// erasing the character behind the caret, which is not what a modal editor
		// does with a movement key.
		if (key.backspace) {
			this.#moveBackspace(count);
			return true;
		}
		if (key.delete) {
			this.#deleteChars(count);
			return true;
		}

		// Arrow keys and Home/End stay reachable in NORMAL mode: they move the
		// caret, never insert, and vim itself binds them. Tab is handed back
		// unconsumed so the host's completion keeps working in both modes.
		if (key.leftArrow) {
			this.#moveHorizontal(-count);
			return true;
		}
		if (key.rightArrow) {
			this.#moveHorizontal(count);
			return true;
		}
		if (key.upArrow) {
			this.#vertical(-count);
			return true;
		}
		if (key.downArrow) {
			this.#vertical(count);
			return true;
		}
		if (key.home) {
			// vim's <Home> is `0`: a move, so it discards a pending `$` (nv_beginline
			// runs the same curswant bookkeeping).
			this.#ops.setCursor(lineStart(this.#ops.getText(), this.#ops.getCursor()));
			this.#wantHere();
			return true;
		}
		if (key.end) {
			// vim binds `K_END` to `nv_dollar` itself, so `<End>` is `$` with the
			// count intact: `2<End>` reaches the end of the line below.
			this.#dollar(count);
			return true;
		}
		if (key.tab) return false;

		switch (input) {
			case "h":
				this.#moveHorizontal(-count);
				return true;
			case "l":
				this.#moveHorizontal(count);
				return true;
			case " ":
				// `l` with vim's default whichwrap: at the end of a line the caret
				// steps onto the next one instead of stopping (and never types a space
				// into the buffer from NORMAL mode).
				this.#moveSpace(count);
				return true;
			case "w":
				this.#moveByWord("w", false, count);
				return true;
			case "W":
				this.#moveByWord("w", true, count);
				return true;
			case "b":
				this.#moveByWord("b", false, count);
				return true;
			case "B":
				this.#moveByWord("b", true, count);
				return true;
			case "e":
				this.#moveByWord("e", false, count);
				return true;
			case "E":
				this.#moveByWord("e", true, count);
				return true;
			case ";":
				if (this.#lastFind) {
					const { char, forward, till } = this.#lastFind;
					this.#applyFind(forward ? "f" : "F", char, count, till);
				}
				return true;
			case ",":
				if (this.#lastFind) {
					const { char, forward, till } = this.#lastFind;
					this.#applyFind(forward ? "F" : "f", char, count, till);
				}
				return true;
			case "0":
				this.#ops.setCursor(lineStart(this.#ops.getText(), this.#ops.getCursor()));
				this.#wantHere(); // beginline is a move: it discards a pending `$`
				return true;
			case "^":
				this.#ops.setCursor(motionFirstNonBlank(this.#ops.getText(), this.#ops.getCursor()));
				return true;
			case "$":
				this.#dollar(count);
				return true;
			case "|": {
				// nv_pipe: column [count], and a bare `|` is column 0. The caret is
				// clamped to the last character of the line but the request keeps its
				// own value, so a `j` onto a longer line comes back to the column that
				// was asked for rather than to where this one happened to end.
				this.#curswant = count - 1;
				this.#ops.setCursor(this.#columnOn(lineOf(this.#ops.getText(), this.#ops.getCursor()), count - 1));
				return true;
			}
			case "G": {
				const text = this.#ops.getText();
				// Bare G is the last line, on its first non-blank (vim) — and {n}G is
				// that same spot on line n. Either way the cursor lands on a
				// character, so `Gx` deletes one instead of doing nothing.
				const line = explicitCount ? Math.min(count, lineCount(text)) - 1 : lineCount(text) - 1;
				this.#ops.setCursor(motionFirstNonBlank(text, nthLineStart(text, line)));
				// `beginline` is a move of its own: it discards a pending MAXCOL.
				this.#wantHere();
				return true;
			}
			case "j":
				this.#vertical(count);
				return true;
			case "k":
				this.#vertical(-count);
				return true;
			case "x":
				this.#deleteChars(count);
				return true;
			case "X":
				this.#deleteChars(-count);
				return true;
			case "D":
				this.#applyToLineEnd("d", count);
				return true;
			case "C":
				this.#applyToLineEnd("c", count);
				return true;
			case "Y":
				this.#applyLinewise("y", count);
				return true;
			case "s":
				this.#deleteChars(count);
				this.#enterInsertAt(this.#ops.getCursor());
				return true;
			case "S":
				this.#applyLinewise("c", count);
				return true;
			case "r":
				this.#pendingChar = "r";
				this.#pendingCharCount = count;
				return true;
			case "~":
				this.#toggleCase(count);
				return true;
			case "J":
				this.#joinLines(count);
				return true;
			case "p":
				this.#paste(count, false);
				return true;
			case "P":
				this.#paste(count, true);
				return true;
			case "i":
				this.#enterInsertAt(this.#ops.getCursor());
				return true;
			case "I":
				this.#enterInsertAt(motionFirstNonBlank(this.#ops.getText(), this.#ops.getCursor()));
				return true;
			case "a":
				// After the character, pair and all — `pos + 1` would land inside an
				// emoji and the text typed next would split it.
				this.#enterInsertAt(this.#afterCaret(this.#ops.getText(), this.#ops.getCursor()));
				return true;
			case "A":
				this.#enterInsertAt(lineEndExclusive(this.#ops.getText(), this.#ops.getCursor()));
				return true;
			case "o":
				this.#openLine(false);
				return true;
			case "O":
				this.#openLine(true);
				return true;
			case "v":
				this.#startVisual("visual");
				return true;
			case "V":
				this.#startVisual("visual-line");
				return true;
			case "m":
			case '"':
			case "'":
			case "`":
			case "z":
			case "Z":
			case "q":
			case "@":
				// A mark, a named register, a `z`/`Z` screen command or a macro: out of
				// scope, but its argument is still taken (see #prefixPending), and a
				// half-typed `g` or count does not survive into the keys that follow it.
				this.#resetPending();
				this.#prefixPending = true;
				return true;
			case "/":
			case "?":
			case ":":
				// vim's command line opens here. This engine has none, so the input is
				// taken and dropped (see #inputPending).
				this.#resetPending();
				this.#inputPending = true;
				return true;
			case "u":
				// `3u` is three undos, as in vim — and an undo discards a pending
				// `$`: the restored caret is where the wanted column starts over.
				for (let i = 0; i < count; i++) this.#ops.undo();
				this.#forgetCurswant();
				return true;
			default:
				this.#resetPending();
				return true; // normal mode swallows unmapped keys (vim behavior)
		}
	}

	// -- movement -------------------------------------------------------------

	#moveHorizontal(delta: number): boolean {
		const text = this.#ops.getText();
		const from = this.#ops.getCursor();
		// The cursor stays on a character of its own line: `l` at a line end stays
		// put and `h` never steps onto the newline — which is what keeps the next
		// `x` from silently joining two lines.
		const last = lineLastChar(text, from);
		let pos = from;
		let blocked = false;
		for (let i = 0; i < Math.abs(delta); i++) {
			if (delta > 0) {
				if (pos >= last) {
					blocked = true;
					break;
				}
				pos = nextChar(text, pos);
			} else {
				if (pos <= lineStart(text, pos)) break;
				pos = prevChar(text, pos);
			}
		}
		this.#ops.setCursor(pos);
		this.#wantHereIfMoved(from);
		return blocked;
	}

	/**
	 * `<BS>`: left within the line, then off the front of it onto the previous
	 * line's last character. This wrap is vim's default `whichwrap`, and it is the
	 * only thing `<BS>` does that `h` does not.
	 */
	#moveBackspace(count: number): void {
		const text = this.#ops.getText();
		const from = this.#ops.getCursor();
		let pos = from;
		// Settle between steps, not just at the end: vim's wrap lands the caret on
		// the last character of the line above, so a second <BS> steps off that
		// character. Stepping through the line break itself would spend a step on
		// nothing (`3<BS>` from a line start would fall one character short).
		for (let i = 0; i < count; i++) pos = settleCursor(text, snapToChar(text, backspaceBoundary(text, pos)));
		this.#ops.setCursor(settleCursor(text, snapToChar(text, pos)));
		this.#wantHereIfMoved(from);
	}

	/**
	 * `<Space>`: the forward twin of `<BS>` — right within the line, then onto the
	 * first character of the next one (vim's default `whichwrap` again).
	 */
	#moveSpace(count: number): void {
		const text = this.#ops.getText();
		const from = this.#ops.getCursor();
		let pos = from;
		for (let i = 0; i < count; i++) pos = snapToChar(text, spaceBoundary(text, pos));
		this.#ops.setCursor(snapToChar(text, pos));
		this.#wantHereIfMoved(from);
	}

	#moveByWord(kind: "w" | "b" | "e", big: boolean, count = 1): void {
		const text = this.#ops.getText();
		const from = this.#ops.getCursor();
		let pos = from;
		for (let i = 0; i < count; i++) {
			if (kind === "w") pos = motionForwardWord(text, pos, big);
			else if (kind === "b") pos = motionBackWord(text, pos, big);
			else pos = motionWordEnd(text, pos, big);
		}
		// A motion never stops inside a character, and never one past the end of the
		// text either: `w` on the last word stays on its last character rather than
		// leaving the caret where `x` and `r` would silently do nothing.
		this.#ops.setCursor(settleCursor(text, snapToChar(text, pos)));
		this.#wantHereIfMoved(from);
	}

	/**
	 * `$`, and the `<End>` key with it — vim binds `K_END` to `nv_dollar` itself,
	 * count and all, so `2<End>` is `2$` and reaches the end of the line below.
	 *
	 * The count is `cursor_down(count1 - 1)`, and that has two ways to say no where
	 * only one of them is reached: the caret already on the last line is a refusal
	 * and leaves the caret alone, while a count that merely runs past the end is not
	 * one — `cursor_down_inner` clamps the line and `coladvance` still runs. That is
	 * the whole difference between `3$` on the last line and `3$` on the one above
	 * it, so the two answers cannot be one. See {@link onLastLine}.
	 */
	#dollar(count: number): void {
		const text = this.#ops.getText();
		// nv_dollar arms MAXCOL before the move, failing or not: the next `j` comes
		// back to the end of whatever line it lands on, however short.
		this.#curswant = MAXCOL;
		if (count > 1 && onLastLine(text, this.#ops.getCursor())) return;
		const line = Math.min(lineOf(text, this.#ops.getCursor()) + count - 1, lineCount(text) - 1);
		this.#ops.setCursor(lineLastChar(text, nthLineStart(text, line)));
	}

	#vertical(deltaLines: number): boolean {
		const text = this.#ops.getText();
		if (!text.includes("\n")) {
			// History recall is a NORMAL-mode convenience: a selection anchored over
			// recalled text would span a buffer that is no longer on screen.
			if (this.mode === "normal") {
				this.#ops.recallHistory(deltaLines < 0 ? "up" : "down");
				this.#forgetCurswant(); // the recalled line brings its own caret
			}
			return true;
		}
		const pos = this.#ops.getCursor();
		const from = lineOf(text, pos);
		// `j` on the last line and `k` on the first are refused outright: `cursor_down`
		// and `cursor_up` both return FAIL before they touch the line *or* the column,
		// so a wanted column armed by an earlier `$` is not applied either. A count
		// that merely overshoots is a different thing — `cursor_down_inner` clamps the
		// line and `coladvance` still runs, which is the case below.
		if ((deltaLines > 0 && from === lineCount(text) - 1) || (deltaLines < 0 && from === 0)) return true;
		// The *wanted* column, not the caret's own: `$` arms it for the end of
		// whatever line the move lands on, an unreachable column is only clamped
		// for now and comes back on a longer line, and an empty line takes the
		// caret to its own start (`j`/`k` themselves never write it back).
		const line = Math.max(0, Math.min(from + deltaLines, lineCount(text) - 1));
		this.#ops.setCursor(this.#columnOn(line, this.#wantColumn()));
		return true;
	}

	/** Raw position of the [count]'th occurrence of `char` on the current line, or null. */
	#findOnLine(char: string, forward: boolean, count: number): number | null {
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		const start = lineStart(text, pos);
		const end = lineEndExclusive(text, pos);
		let found: number | null = null;

		if (forward) {
			let i = pos + 1;
			let remaining = count;
			while (i < end) {
				if (text[i] === char) {
					// A match inside a paste token is not a position: the token is one
					// character whose `[` is the only part a caret can stand on, so
					// `f[` finds it and `t]` cannot find the bracket that ends it.
					const token = pasteTokenAt(text, i);
					if ((token === null || i === token.start) && --remaining === 0) {
						found = i;
						break;
					}
				}
				i++;
			}
		} else {
			let i = pos - 1;
			let remaining = count;
			while (i >= start) {
				if (text[i] === char && --remaining === 0) {
					found = i;
					break;
				}
				i--;
			}
		}
		return found;
	}

	#applyFind(kind: string, char: string, count: number, tillOverride?: boolean): void {
		const text = this.#ops.getText();
		const forward = kind === "f" || kind === "t";
		const till = tillOverride ?? (kind === "t" || kind === "T");
		const found = this.#findOnLine(char, forward, count);
		// A find that found nothing is a failed motion: it leaves the wanted column
		// where it was, so a `$jfz j` still comes back to the end of the line.
		if (found === null) return;
		// t/T land one short of the match; f/F land on it.
		this.#ops.setCursor(snapToChar(text, till ? found + (forward ? -1 : 1) : found));
		this.#wantHere();
	}

	// -- edits ----------------------------------------------------------------

	#deleteChars(count: number): void {
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		if (count >= 0) {
			// `x` walks to the end of the line and stops: a newline is line structure,
			// and eating one would join two lines behind the user's back.
			const lineEnd = lineEndExclusive(text, pos);
			let end = pos;
			for (let i = 0; i < count && end < lineEnd; i++) end = nextChar(text, end);
			if (end <= pos) return;
			this.#register = { text: text.slice(pos, end), linewise: false };
			const out = text.slice(0, pos) + text.slice(end);
			this.#ops.setAll(out, settleCursor(out, pos));
			this.#wantHere();
		} else {
			const lineBegin = lineStart(text, pos);
			let start = pos;
			for (let i = 0; i < -count && start > lineBegin; i++) start = prevChar(text, start);
			if (start >= pos) return;
			this.#register = { text: text.slice(start, pos), linewise: false };
			const out = text.slice(0, start) + text.slice(pos);
			this.#ops.setAll(out, settleCursor(out, start));
			this.#wantHere();
		}
	}

	#replaceChar(char: string, count: number): void {
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		if (char.length === 0 || pos >= text.length || text[pos] === "\n") return;
		// `r` refuses on a paste token instead of writing over its first
		// character. The replacement is one character wide and the token is
		// twenty-odd, so what would be left matches nothing in the paste map and
		// the payload goes with it — for a key whose whole point is that the
		// character under the caret is what changes. `x` is how a token is removed,
		// and that one the user can see happen.
		if (pasteTokenAt(text, pos) !== null) return;
		// `3rX` replaces three characters, and each of them may be two units wide.
		const lineEnd = lineEndExclusive(text, pos);
		let end = pos;
		for (let i = 0; i < count && end < lineEnd; i++) end = nextChar(text, end);
		let replacement = "";
		for (let p = pos; p < end; p = nextChar(text, p)) replacement += char;
		const out = text.slice(0, pos) + replacement + text.slice(end);
		this.#ops.setAll(out, snapToChar(out, pos + replacement.length - 1));
		this.#wantHere();
	}

	#toggleCase(count: number): void {
		const text = this.#ops.getText();
		const from = this.#ops.getCursor();
		let pos = from;
		let out = text;
		let changed = false;
		for (let i = 0; i < count && pos < out.length; i++) {
			if (out[pos] === "\n") break;
			// A paste token is one character with no case of its own: the letters in
			// it spell its own format, and swapping any of them stops it matching
			// (see mapOutsidePasteTokens). `~` steps over it as a unit, exactly as it
			// steps over a digit — the caret still advances, and an edit that changed
			// nothing does not record an undo step.
			const token = pasteTokenAt(out, pos);
			if (token !== null) {
				pos = token.end;
				continue;
			}
			const end = nextChar(out, pos);
			const c = out.slice(pos, end);
			const swapped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
			if (swapped !== c) {
				out = out.slice(0, pos) + swapped + out.slice(end);
				changed = true;
			}
			pos = end;
		}
		if (!changed) {
			// Nothing to swap (a digit, an emoji, the end of the line): the caret
			// still advances, but an edit that changed nothing must not record one —
			// an empty snapshot would clear the redo stack the host keeps.
			this.#ops.setCursor(settleCursor(text, pos));
			this.#wantHere();
			return;
		}
		this.#ops.setAll(out, settleCursor(out, pos));
		this.#wantHere();
	}

	/**
	 * `J` and `gJ`, following vim's `do_join` (ops.c): the break and the next
	 * line's indent collapse into join spaces, and the caret lands on the last
	 * join point (clamped onto a character, which is what makes joining onto an
	 * empty line leave the caret at the end of the line above).
	 *
	 * A space is dropped before `)`, when the next line has nothing but
	 * whitespace, when the line being joined onto is empty, and when it already
	 * ends in a space or a tab; 'joinspaces' (vim's default) adds a second space
	 * after `.`, `?` or `!`. `gJ` has none of that: no space, and the indent stays.
	 *
	 * (vim's 'formatoptions' `m` rule — no space before a multi-byte character —
	 * is off in vim's own defaults, so it is not reproduced here.)
	 */
	#joinLines(count: number, noSpace = false, from = this.#ops.getCursor()): void {
		const text = this.#ops.getText();
		let out = text;
		const line = lineOf(text, from);
		let joinAt = -1;
		let joins = Math.max(1, count - 1);
		while (joins-- > 0) {
			const lineBegin = nthLineStart(out, line);
			const breakAt = lineEndExclusive(out, lineBegin);
			if (breakAt >= out.length) break; // nothing below to join onto
			let contentStart = breakAt + 1;
			if (!noSpace) {
				while (contentStart < out.length && (out[contentStart] === " " || out[contentStart] === "\t")) {
					contentStart += 1;
				}
			}
			const nextLine = out.slice(contentStart, lineEndExclusive(out, contentStart));
			let spaces = 0;
			if (!noSpace && nextLine !== "" && nextLine[0] !== ")" && breakAt > lineBegin) {
				const last = charEndingAt(out, breakAt, lineBegin);
				if (last !== "\t") {
					// A line already ending in a space keeps it instead of gaining one.
					const effective = last === " " ? charEndingAt(out, prevChar(out, breakAt), lineBegin) : last;
					if (last !== " ") spaces = 1;
					if (effective === "." || effective === "?" || effective === "!") spaces += 1;
				}
			}
			out = out.slice(0, breakAt) + " ".repeat(spaces) + out.slice(contentStart);
			joinAt = breakAt;
		}
		// One command, one snapshot: writing per join would cost one `u` each.
		if (out === text) return;
		this.#ops.setAll(out, settleCursor(out, joinAt));
		this.#wantHere();
	}

	#paste(count: number, before: boolean): void {
		if (!this.#register.text) return;
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		// `p` materializes the wanted column only when it changed the text: an empty
		// register pastes nothing and leaves a pending `$` alone (ops.c:3276).
		const finish = () => {
			if (this.#ops.getText() !== text) this.#wantHere();
		};

		if (this.#register.linewise) {
			const line = lineOf(text, pos);
			const targetLine = before ? line : line + 1;
			let insertAt: number;
			// Where the pasted line itself begins once the block is in — the break
			// added in front of a trailing paste comes before it.
			let anchor: number;
			// `[count]p` pastes the register count times, the whole block each time
			// rather than just its first line (vim's op_paste loops). A register that
			// already ends in a break repeats as it stands; one that does not gets its
			// copies joined by the breaks its lines are missing.
			const raw = this.#register.text;
			let block = raw.endsWith("\n") ? raw.repeat(count) : Array.from({ length: count }, () => raw).join("\n");
			if (targetLine < lineCount(text)) {
				insertAt = nthLineStart(text, targetLine);
				anchor = insertAt;
				// A linewise paste is whole lines: a register whose last line had no
				// break (the end of a buffer that has none) gets one back here.
				if (!block.endsWith("\n")) block += "\n";
			} else {
				insertAt = text.length;
				anchor = insertAt;
				if (text.length > 0 && !text.endsWith("\n")) {
					// The paste brings its own break in front, and does not invent one
					// after the last line it holds.
					block = `\n${block.replace(/\n$/, "")}`;
					anchor = insertAt + 1;
				} else if (text.length > 0 && !block.endsWith("\n")) {
					block += "\n";
				}
				// An empty buffer takes the block exactly as it stands: there is no line
				// edge for an extra break to belong to.
			}
			const out = text.slice(0, insertAt) + block + text.slice(insertAt);
			// On the first non-blank of the line just pasted (vim), not on the break.
			this.#ops.setAll(out, motionFirstNonBlank(out, anchor));
			finish();
			return;
		}

		// Charwise `p` goes after the character under the caret — the whole of it, or
		// the paste lands between the halves of an emoji's surrogate pair.
		const insertAt = before ? pos : this.#afterCaret(text, pos);
		let out = text.slice(0, insertAt);
		for (let i = 0; i < count; i++) out += this.#register.text;
		out += text.slice(insertAt);
		// Charwise paste leaves the caret on the last character it pasted (vim), so
		// `.`-style follow-ups and a second `p` land where the eye expects.
		const pastedEnd = insertAt + this.#register.text.length * count;
		this.#ops.setAll(out, snapToChar(out, Math.max(insertAt, pastedEnd - 1)));
		finish();
	}

	#openLine(above: boolean): void {
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		const at = above ? lineStart(text, pos) : lineEndExclusive(text, pos);
		// Below: the new empty line starts AFTER the inserted newline.
		this.#ops.setAll(`${text.slice(0, at)}\n${text.slice(at)}`, above ? at : at + 1);
		this.#enterInsertAt(above ? at : at + 1);
	}

	#enterInsertAt(pos: number): void {
		this.#ops.setCursor(this.#clamp(pos));
		this.#enterInsert();
	}

	/**
	 * The insertion point just past the character under the caret — where `a` and a
	 * charwise `p` put their text. It stops at the line break rather than stepping
	 * over it: on an empty line the caret sits *on* the break, and `nextChar` walks
	 * that like any other character, which would land the text on the line below
	 * (vim stays put — `a` on an empty line is `i`, and a paste goes to the start of
	 * the empty line it is on).
	 */
	#afterCaret(text: string, pos: number): number {
		return Math.min(lineEndExclusive(text, pos), nextChar(text, pos));
	}

	#enterInsert(): void {
		this.#resetPending();
		this.mode = "insert";
		// Typing moves the caret behind the engine's back; the wanted column is read
		// back off it when insert mode ends.
		this.#forgetCurswant();
		this.#ops.enterInsert();
	}

	// -- operators ------------------------------------------------------------

	#applyOperator(operator: Operator, motion: string, count: number, findChar?: string, countExplicit = false): void {
		const text = this.#ops.getText();

		if (operator === ">" || operator === "<") {
			this.#shiftByMotion(operator === ">", motion, count, findChar, countExplicit);
			return;
		}

		const span = this.#lineSpan(motion, count, countExplicit);
		if (span === false) return;
		if (span) {
			const { start, end, removeFrom } = lineRange(text, span.firstLine, span.lastLine);
			this.#runLinewise(operator, start, end, removeFrom, span.landing);
			return;
		}

		let range = this.#motionRange(motion, count, findChar);
		if (!range) return;
		// cw quirk: on a non-blank char, cw stops at the end of the word the caret is
		// on (keeps the trailing whitespace, and does not step on to the next word
		// when the caret already stands on a word's last character). A count is a
		// plain `Ne` instead — `c2w` on the only word of a line takes the next one
		// too, as `2e` would. Plain `dw` still eats the trailing spaces, and `cW` is
		// the same command on WORDs.
		const at = this.#ops.getCursor();
		if (operator === "c" && (motion === "w" || motion === "W") && !/\s/.test(text[at] ?? " ")) {
			if (count === 1) {
				const stop = motionWordEndHere(text, at, motion === "W");
				range = { start: at, end: nextChar(text, stop), inclusive: true };
			} else {
				const endRange = this.#motionRange(motion === "W" ? "E" : "e", count);
				if (endRange) range = endRange;
			}
		}
		this.#runOperator(operator, range.start, range.end, range.inclusive);
	}

	/**
	 * The lines a linewise motion covers, or `false` when the motion cannot move
	 * and the operator is therefore a no-op (`dj` on the last line, `dk` on the
	 * first). Motions that are not linewise report no span, and the caller falls
	 * back to `#motionRange`.
	 *
	 * `landing` is where the bare motion would have left the caret: an operator's
	 * region can start behind the caret, and vim remembers which end the motion
	 * came from (see `#runLinewise`).
	 */
	#lineSpan(
		motion: string,
		count: number,
		countExplicit = false,
	): { firstLine: number; lastLine: number; landing: number } | false | null {
		if (!LINEWISE_MOTIONS.has(motion)) return null;
		const text = this.#ops.getText();
		const cursorLine = lineOf(text, this.#ops.getCursor());
		let firstLine = cursorLine;
		let lastLine = cursorLine;
		let landing = this.#ops.getCursor();
		// A count in front of `G` or `gg` is a line number, not a line count: `d2G`
		// and `d2gg` both name line 2 (`nv_goto` reads it as the target line). With
		// no count typed they are the ends of the buffer.
		const targetLine = countExplicit ? Math.min(Math.max(1, count), lineCount(text)) - 1 : -1;
		if (motion === "gg") {
			firstLine = targetLine === -1 ? 0 : targetLine;
			// `gg` and `G` are nv_goto: both land on the first non-blank of the line
			// they name, whether that is above or below the caret.
			landing = motionFirstNonBlank(text, nthLineStart(text, firstLine));
		} else if (motion === "G") {
			lastLine = targetLine === -1 ? lineCount(text) - 1 : targetLine;
			landing = motionFirstNonBlank(text, nthLineStart(text, lastLine));
		} else {
			const delta = motion === "j" ? count : -count;
			// A count past the end of the buffer clamps, as a bare `j`/`k` does:
			// `5dj` from the top line takes every line under it. A motion that
			// cannot move at all (`dj` on the last line, `dk` on the first) is
			// still not a delete: vim does not fall back to the caret's own line.
			const target = Math.max(0, Math.min(lineCount(text) - 1, cursorLine + delta));
			if (target === cursorLine) return false;
			lastLine = target;
			if (delta < 0) {
				firstLine = lastLine;
				lastLine = cursorLine;
			}
			// `j`/`k` land on the line they reach, at the column the caret wants.
			landing = this.#columnOn(target, this.#wantColumn());
		}
		// A counted `G`/`gg` can name a line on either side of the caret.
		return { firstLine: Math.min(firstLine, lastLine), lastLine: Math.max(firstLine, lastLine), landing };
	}

	/**
	 * `>{motion}` / `<{motion}`: vim's shift operators take whole lines, so a
	 * motion names a line span rather than a character range — `>w` on a line
	 * ending before the next word shifts one line, `>j` shifts two. Where the
	 * motion lands is what decides, and a motion that fails shifts nothing.
	 */
	#shiftByMotion(right: boolean, motion: string, count: number, findChar?: string, countExplicit = false): void {
		const text = this.#ops.getText();
		const from = this.#ops.getCursor();
		const span = this.#lineSpan(motion, count, countExplicit);
		if (span === false) return;
		if (span) {
			this.#shiftLines(span.lastLine - span.firstLine + 1, right, 1, nthLineStart(text, span.firstLine));
			return;
		}
		const range = this.#motionRange(motion, count, findChar);
		if (!range) return;
		// The motion's landing end — for a backward motion that is where the range
		// starts, since `#motionRange` orders its two ends.
		const landingLine = lineOf(text, range.start === from ? range.end : range.start);
		const cursorLine = lineOf(text, from);
		const firstLine = Math.min(cursorLine, landingLine);
		const lastLine = Math.max(cursorLine, landingLine);
		this.#shiftLines(lastLine - firstLine + 1, right, 1, nthLineStart(text, firstLine));
	}

	/**
	 * `>>`/`<<`, and the visual and motion forms of both: shift whole lines.
	 *
	 * With no options in this engine the unit is vim's default one — 'shiftwidth'
	 * 8 and 'tabstop' 8 with 'noexpandtab', so the new indent is TABS for whole
	 * shiftwidths and spaces for the remainder (shift_line → set_indent). The
	 * indent is rewritten, not adjusted: a `>>` on a hand-made "  \t" indent
	 * produces the canonical form for two more shiftwidths, and `<<` on a line
	 * indented by less than a full shift takes all of it.
	 *
	 * An empty line has no indent to shift and is left alone (vim skips it), and
	 * the caret ends on the first non-blank of the first line of the range.
	 */
	#shiftLines(count: number, right: boolean, amount = 1, from = this.#ops.getCursor()): void {
		const text = this.#ops.getText();
		const firstLine = lineOf(text, from);
		const lastLine = Math.min(firstLine + Math.max(1, count) - 1, lineCount(text) - 1);
		const shift = SHIFT_WIDTH * Math.max(1, amount);
		let out = text;
		for (let line = firstLine; line <= lastLine; line++) {
			const lineBegin = nthLineStart(out, line);
			const lineEnd = lineEndExclusive(out, lineBegin);
			const body = out.slice(lineBegin, lineEnd);
			if (body === "") continue;
			const indent = indentColumns(body);
			const target = right ? indent + shift : Math.max(0, indent - shift);
			if (target === indent) continue;
			const next = withIndent(body, target);
			out = out.slice(0, lineBegin) + next + out.slice(lineEnd);
		}
		const landing = settleCursor(out, motionFirstNonBlank(out, nthLineStart(out, firstLine)));
		// One command, one snapshot — and a shift that changed nothing (an
		// unindented line under `<<`) is still a caret move, not an undo step.
		if (out !== text) this.#ops.setAll(out, landing);
		else this.#ops.setCursor(landing);
		// op_shift ends with beginline(BL_SOL|BL_FIX): a move, so MAXCOL is gone.
		this.#wantHere();
	}

	#motionRange(
		motion: string,
		count: number,
		findChar?: string,
	): { start: number; end: number; inclusive: boolean } | null {
		const text = this.#ops.getText();
		const from = this.#ops.getCursor();

		if (FIND_MOTIONS.has(motion)) {
			if (!findChar) return null;
			const forward = motion === "f" || motion === "t";
			const till = motion === "t" || motion === "T";
			const found = this.#findOnLine(findChar, forward, count);
			if (found === null) return null;
			// f/t are vim-inclusive (the landing char is part of the range);
			// F/T are exclusive. Use the same landing position a bare motion
			// would use, then fold inclusivity into `end` like other motions.
			const target = till ? found + (forward ? -1 : 1) : found;
			const start = Math.min(from, target);
			let end = Math.max(from, target);
			// Inclusive means "the landing character is in the range": step over the
			// whole of it, not one UTF-16 unit, or `df😀` leaves half a surrogate.
			if (forward && target >= from) end = nextChar(text, target);
			return { start, end: Math.min(end, text.length), inclusive: forward };
		}

		// `dl`/`dh` are `x`/`X` with an operator in front: the range is the
		// character under the cursor, not the caret move, so they still work at a
		// line end. Neither can reach the newline. `BS` is `dh` with the wrapping
		// Backspace motion, so at a line start it does reach the newline — and
		// deleting that is what joins the two lines.
		if (motion === "l" || motion === "h" || motion === "BS") {
			if (motion === "l") {
				let end = from;
				for (let i = 0; i < count; i++) end = nextChar(text, end);
				return { start: from, end: Math.min(end, lineEndExclusive(text, from)), inclusive: false };
			}
			let start = from;
			if (motion === "BS") {
				for (let i = 0; i < count; i++) start = backspaceBoundary(text, start);
				return { start, end: from, inclusive: false };
			}
			for (let i = 0; i < count; i++) start = prevChar(text, start);
			return { start: Math.max(start, lineStart(text, from)), end: from, inclusive: false };
		}

		// `d|`/`y|`: the same column as a character motion. nv_pipe is MCHAR and not
		// inclusive, so the range stops at the column that was asked for — which is
		// the last character of the line when the column is past its end.
		if (motion === "|") {
			const target = this.#columnOn(lineOf(text, from), count - 1);
			return { start: Math.min(from, target), end: Math.max(from, target), inclusive: false };
		}

		let target = from;
		let inclusive = false;
		switch (motion) {
			case "w":
			case "W":
				for (let i = 0; i < count; i++) target = motionForwardWord(text, target, motion === "W");
				// `dw` stops at the end of the line: it deletes words, and a newline
				// is line structure. `de`/`d$` keep their own rules; the plain `w`
				// motion still crosses lines, as vim's does.
				target = Math.min(target, lineEndExclusive(text, from));
				break;
			case "b":
			case "B":
				for (let i = 0; i < count; i++) target = motionBackWord(text, target, motion === "B");
				break;
			case "e":
			case "E":
				for (let i = 0; i < count; i++) target = motionWordEnd(text, target, motion === "E");
				inclusive = true;
				break;
			case "0":
				target = lineStart(text, from);
				break;
			case "^":
				target = motionFirstNonBlank(text, from);
				break;
			case "$": {
				// `[count]$` aims at the end of the line count-1 further down. The steps
				// in between clamp the way `j` does, but a count asked for from the last
				// line fails the motion, and a failed motion makes the whole operator a
				// no-op (`d2$` on the last of three lines changes nothing, while `d2$` on
				// the first of them takes two lines). See {@link onLastLine}.
				if (count > 1 && onLastLine(text, from)) return null;
				const line = Math.min(lineOf(text, from) + count - 1, lineCount(text) - 1);
				const lineBegin = nthLineStart(text, line);
				const lineEnd = lineEndExclusive(text, lineBegin);
				if (count === 1) {
					// An empty line has no character to reach, so `d$` there is a no-op
					// rather than a deletion of the line break in front of it.
					if (lineEnd <= lineBegin) return null;
					target = lineLastChar(text, from);
					inclusive = true;
					break;
				}
				// A counted `$` is the one operator range that reaches past the line it
				// ends on: vim takes the line break after it too (`d2$` on three lines
				// leaves "ghi", not "\nghi").
				return { start: from, end: Math.min(text.length, lineEnd + 1), inclusive: false };
			}
			default:
				return null;
		}

		const start = Math.min(from, target);
		let end = Math.max(from, target);
		// Inclusive means the landing character is part of the range: step over the
		// whole of it, not one UTF-16 unit, or `d$` at the end of a line ending in an
		// emoji leaves half a surrogate pair behind.
		if (inclusive && target >= from) end = nextChar(text, target);
		return { start, end: Math.min(end, text.length), inclusive };
	}

	#runOperator(operator: "d" | "c" | "y", start: number, end: number, _inclusive: boolean): void {
		// NOTE: #motionRange already folds `inclusive` into `end`; do not add again.
		const text = this.#ops.getText();
		const cutEnd = Math.min(text.length, Math.max(start, end));
		// The range cannot split a paste token, because no motion returns one that
		// does — see splitsPasteToken, which is asked here rather than assumed, and
		// which `vim-engine.test.ts` holds against examples of its own.
		if (splitsPasteToken(text, Math.min(start, cutEnd), cutEnd)) return;
		this.#register = { text: text.slice(start, cutEnd), linewise: false };
		if (operator === "y") {
			// The caret goes to the start of the yanked text — which is a line break
			// for a range that crossed one (`y<BS>` at a line start), and vim settles
			// that on the last character of the line above rather than on the break,
			// where NORMAL mode has nothing to stand on.
			this.#ops.setCursor(settleCursor(text, start));
			this.#wantHere();
			return;
		}
		const out = text.slice(0, start) + text.slice(cutEnd);
		// A change leaves the insert standing where the text was cut out — the cut
		// point itself, which is one past the end when the cut ran to the buffer end
		// (`cw` on "foo bar" leaves "foo " with the caret after the space, column 5).
		// A delete settles onto a real character instead, where NORMAL mode can hold
		// the caret.
		if (out !== text) this.#ops.setAll(out, operator === "c" ? start : settleCursor(out, start));
		if (operator === "c") this.#enterInsert();
		else this.#wantHere();
	}

	#runLinewise(operator: "d" | "c" | "y", start: number, end: number, removeFrom = start, landing?: number): void {
		const text = this.#ops.getText();
		this.#register = { text: text.slice(start, end), linewise: true };
		if (operator === "y") {
			// vim only undoes a motion that went forwards: the caret lands wherever a
			// backwards motion put it, and comes back to the operator's own start
			// otherwise (do_pending_operator pulls the cursor back only when the
			// motion left it past the start). `yy` has no motion of its own, so the
			// caret does not move at all.
			const cur = this.#ops.getCursor();
			if (landing !== undefined) this.#ops.setCursor(landing < cur ? landing : cur);
			this.#wantHere();
			return;
		}
		let out = text.slice(0, removeFrom) + text.slice(end);
		// cc/S leaves an empty line behind and inserts on it — assembled before the
		// write so the whole command is one undo step, not two. A buffer that was
		// nothing but this line has no line left to break: `cc` on "abc" leaves an
		// empty buffer, not an empty first line.
		if (operator === "c" && out !== "") out = `${out.slice(0, removeFrom)}\n${out.slice(removeFrom)}`;
		// The insert caret stands on that empty line: its newline, or the buffer end
		// when nothing follows it.
		const insertCaret = Math.min(out.length, out.length > removeFrom + 1 ? removeFrom : removeFrom + 1);
		if (out !== text) this.#ops.setAll(out, operator === "c" ? insertCaret : linewiseLanding(out, removeFrom));
		if (operator === "c") this.#enterInsert();
		else this.#wantHere();
	}

	/**
	 * `cc` over a span of lines, wherever the span came from: a count (`2cc`) or a
	 * visual-line selection (`Vc`). The block gives way to one empty line and the
	 * insert starts on it.
	 */
	#changeLines(firstLine: number, lastLine: number): void {
		const text = this.#ops.getText();
		const { start, end, removeFrom } = lineRange(text, firstLine, Math.min(lineCount(text) - 1, lastLine));
		this.#runLinewise("c", start, end, removeFrom);
	}

	#applyLinewise(operator: "d" | "c" | "y", count: number): void {
		const text = this.#ops.getText();
		const startLine = lineOf(text, this.#ops.getCursor());
		// `2dd` with nothing under the caret but its own line takes nothing at all:
		// vim refuses the count rather than falling back to the one line it could
		// have taken. `2dj` from the same place is a different command, and that one
		// does clamp — see #applyOperator.
		if (count > 1 && startLine === lineCount(text) - 1) return;
		const endLine = Math.min(lineCount(text) - 1, startLine + count - 1);
		const { start, end, removeFrom } = lineRange(text, startLine, endLine);
		this.#runLinewise(operator, start, end, removeFrom);
	}

	#applyToLineEnd(operator: "d" | "c", count: number): void {
		const text = this.#ops.getText();
		const start = this.#ops.getCursor();
		// `D` is `d$`, so a count reaches the end of that many lines down — the
		// count has to mean something here, or it leaks into the next command.
		const targetLine = Math.min(lineOf(text, start) + count - 1, lineCount(text) - 1);
		const end = lineEndExclusive(text, nthLineStart(text, targetLine));
		this.#register = { text: text.slice(start, end), linewise: false };
		if (end > start) {
			const out = text.slice(0, start) + text.slice(end);
			// The insert stands at the cut point, as it does for every other change
			// (see #runOperator).
			this.#ops.setAll(out, operator === "c" ? start : settleCursor(out, start));
		}
		if (operator === "c") this.#enterInsert();
	}

	// -- visual mode ----------------------------------------------------------

	#startVisual(mode: "visual" | "visual-line"): void {
		// The same command again stops visual mode: nv_visual ends it when the
		// command equals `VIsual_mode`. Unlike Esc it leaves the wanted column
		// alone, so a MAXCOL armed by `$` survives the toggle (`$vvj` still lands
		// on the end of line 2 — probed on vim 9.1).
		if (this.mode === mode) {
			this.#exitVisual(this.#ops.getCursor(), false);
			return;
		}
		// The other one only switches flavour (v ↔ V) and keeps the anchor: vim
		// turns the same selection charwise or linewise instead of starting a new
		// one at the cursor.
		if (this.mode !== "visual" && this.mode !== "visual-line") {
			this.#anchor = this.#ops.getCursor();
			// Starting a selection settles the wanted column on the caret again: a `$`
			// armed in NORMAL mode is not read as "past the line end" by the selection
			// it begins (`$vd` deletes one character, `v$d` takes the line break).
			this.#visualPastEnd = false;
		}
		this.mode = mode;
		this.#syncSelection();
	}

	#syncSelection(): void {
		const text = this.#ops.getText();
		const a = this.#anchor;
		const c = this.#ops.getCursor();
		if (this.mode === "visual-line") {
			const start = lineStart(text, Math.min(a, c));
			const end = lineEndExclusive(text, Math.max(a, c));
			this.selection = { start, end: Math.min(text.length, end + 1) };
		} else {
			// A charwise selection covers whole characters, so `v` over an emoji
			// cannot leave half of it behind for `d` to write into the buffer. Each
			// end contributes the character it stands on — or, when it stands past
			// the line's last character, the line break after it. The two ranges are
			// unioned, which is what makes `vl` at a line end (`[last, break)`, the
			// anchor still contributing its own character) join two lines.
			const from = this.#endpoint(a, false);
			const to = this.#endpoint(c, true);
			this.selection = {
				start: Math.min(from.lo, to.lo),
				end: Math.min(text.length, Math.max(from.hi, to.hi)),
			};
		}
	}

	/**
	 * The half-open range one end of a charwise selection covers: the character it
	 * stands on, or the line break after it when it stands past the line's last
	 * character. `moving` marks the end a motion drove — the wanted column, and with
	 * it the reach past the line, belongs to that end alone. The anchor is a plain
	 * position, which is why `vld` on a line's last character takes the break (the
	 * caret's range is `[break, break + 1)` and the anchor still contributes the
	 * character it stands on) while a motion-less `vd` there does not.
	 */
	#endpoint(pos: number, moving: boolean): { lo: number; hi: number } {
		const text = this.#ops.getText();
		if (this.#pastLineEnd(pos, moving)) {
			const lo = lineEndExclusive(text, pos);
			return { lo, hi: lo + 1 };
		}
		return { lo: pos, hi: nextChar(text, pos) };
	}

	/**
	 * Whether the caret at `pos` is past the end of the characters on its line — the
	 * position vim's `w_virtcol` reports when a motion asks for a column the line
	 * cannot fill. The caret itself stays on a character (NORMAL mode has nowhere to
	 * stand on a line break), which is why this has to be a question about the
	 * wanted column rather than about the caret alone.
	 */
	#pastLineEnd(pos: number, moving: boolean): boolean {
		const text = this.#ops.getText();
		// A caret standing on a line break has no character of its own there. That is
		// geometry, not a wanted column: an empty line, where the break is the line.
		if (text[pos] === "\n") return true;
		if (!moving || !this.#visualPastEnd) return false;
		// Only the line's last character can have a column past it, and only a line
		// with a break after it can give that break up.
		return pos === lineLastChar(text, pos) && lineEndExclusive(text, pos) < text.length;
	}

	/**
	 * Whether the selection's end stands one column past its line's last character
	 * — the state `$`, a `|` past the line and a blocked `l` leave behind, and the
	 * one thing a backward step spends before it moves (`v$h` puts the end back on
	 * that character without moving the caret).
	 *
	 * The last line is included: there is no break to give up, but the wanted
	 * column is still one past the last character, so `v$h` there spends the reach
	 * exactly as it does on any other line (the selection keeps covering the whole
	 * line). A caret standing on a line break is not this state — on an empty line
	 * the break *is* the line, and `<BS>` there wraps like anywhere else.
	 */
	#reachArmed(pos: number): boolean {
		const text = this.#ops.getText();
		// A caret standing on a line break is not this state: an empty line's break
		// *is* the line, and `<BS>` there wraps like anywhere else (`v$<BS>` on an
		// empty line takes the break above it, it does not spend one).
		return this.#visualPastEnd && text[pos] !== "\n" && pos === lineLastChar(text, pos);
	}

	#handleVisual(input: string, key: VimKey): boolean {
		// Same top-of-command materialization as NORMAL: `V` then `j` uses the
		// wanted column the same way, and a stale one is read off the caret here.
		if (this.#curswant === null) this.#wantHere();
		if (key.escape) {
			// Esc keeps the caret where the last motion left it; the anchor is only
			// remembered as the `'<` mark (end_visual_mode moves nothing).
			this.#exitVisual(this.#ops.getCursor());
			return true;
		}
		if (key.return) return false; // host submits

		// `g` in visual mode waits for the one command it has here, `gJ`.
		if (this.#visualPendingG) {
			this.#visualPendingG = false;
			if (input === "J") this.#joinSelection(true);
			return true;
		}

		if (/^[1-9]$/.test(input) || (input === "0" && this.#countBuffer !== "")) {
			this.#countBuffer += input;
			return true;
		}
		// Same count loop as in NORMAL: a `<Del>` in the middle of a count edits the
		// count instead of cutting the selection.
		if (key.delete && this.#countBuffer !== "") {
			this.#countBuffer = this.#countBuffer.slice(0, -1);
			return true;
		}
		const count = this.#takeCount();
		const text = this.#ops.getText();

		if (key.upArrow || key.downArrow) {
			this.#moveVisualVertical(key.upArrow ? -1 : 1, count);
			return true;
		}
		if (key.leftArrow || key.rightArrow) {
			this.#moveVisualHorizontal(key.rightArrow ? count : -count);
			return true;
		}
		if (key.backspace) {
			this.#moveVisualBackspace(count);
			return true;
		}
		if (key.delete) {
			// The Delete key is `x` in visual mode: it cuts the selection outright.
			this.#deleteSelection();
			return true;
		}

		switch (input) {
			case "h":
				this.#moveVisualHorizontal(-count);
				return true;
			case "l":
				this.#moveVisualHorizontal(count);
				return true;
			case " ":
				this.#moveVisualSpace(count);
				return true;
			case "j":
			case "k":
				this.#moveVisualVertical(input === "j" ? 1 : -1, count);
				return true;
			case "w":
				this.#moveVisualByWord("w", false, count);
				return true;
			case "W":
				this.#moveVisualByWord("w", true, count);
				return true;
			case "b":
				this.#moveVisualByWord("b", false, count);
				return true;
			case "B":
				this.#moveVisualByWord("b", true, count);
				return true;
			case "e":
				this.#moveVisualByWord("e", false, count);
				return true;
			case "E":
				this.#moveVisualByWord("e", true, count);
				return true;
			case "0":
				this.#visualPastEnd = false;
				this.#ops.setCursor(lineStart(text, this.#ops.getCursor()));
				this.#syncSelection();
				this.#wantHere();
				return true;
			case "^":
				this.#visualPastEnd = false;
				this.#ops.setCursor(motionFirstNonBlank(text, this.#ops.getCursor()));
				this.#syncSelection();
				this.#wantHere();
				return true;
			case "|": {
				// The same column command as in NORMAL: the caret lands on it (or on
				// the line's last character) and the wanted column keeps the request.
				// A column the line cannot fill is a column past its end — `v9|d` takes
				// the line break, `v2|d` on a two-character line does not.
				const start = lineStart(text, this.#ops.getCursor());
				this.#curswant = count - 1;
				this.#visualPastEnd = count - 1 >= lineEndExclusive(text, start) - start;
				this.#ops.setCursor(this.#columnOn(lineOf(text, this.#ops.getCursor()), count - 1));
				this.#syncSelection();
				return true;
			}
			case "$":
				this.#curswant = MAXCOL; // `v$j` comes back to the end of line 2
				this.#visualPastEnd = true;
				this.#ops.setCursor(lineLastChar(text, this.#ops.getCursor()));
				this.#syncSelection();
				return true;
			case "G":
				this.#visualPastEnd = false;
				this.#ops.setCursor(motionFirstNonBlank(text, nthLineStart(text, lineCount(text) - 1)));
				this.#syncSelection();
				this.#wantHere();
				return true;
			case "o": {
				const swap = this.#anchor;
				this.#anchor = this.#ops.getCursor();
				this.#ops.setCursor(swap);
				this.#syncSelection();
				return true;
			}
			case "J":
				// vim's visual `J` is the operator form of the join: every selected
				// line becomes one, with the same spaces a `NJ` would insert.
				this.#joinSelection(false);
				return true;
			case ">":
			case "<":
				this.#shiftSelection(input === ">", count);
				return true;
			case "g":
				this.#visualPendingG = true;
				return true;
			case "d":
			case "x":
				this.#deleteSelection();
				return true;
			case "y":
				this.#yankSelection();
				return true;
			case "c":
			case "s":
				this.#changeSelection();
				return true;
			// v_visop: an uppercase form is the same command over the *lines* the
			// selection touches — "Uppercase means linewise" — so `v2lD` removes the
			// whole first line where `v2ld` removes three characters.
			case "C":
			case "S":
			case "D":
			case "X":
			case "Y":
				this.#forceLinewise();
				if (input === "Y") this.#yankSelection();
				else if (input === "C" || input === "S") this.#changeSelection();
				else this.#deleteSelection();
				return true;
			case "u":
				this.#caseSelection("lower");
				return true;
			case "U":
				this.#caseSelection("upper");
				return true;
			case "~":
				this.#caseSelection("toggle");
				return true;
			case "v":
				this.#startVisual("visual");
				return true;
			case "V":
				this.#startVisual("visual-line");
				return true;
			default:
				return true;
		}
	}

	/**
	 * `J` in visual mode: the same join, run from the first selected line so the
	 * caret still lands on the join point (`#joinLines` leaves it there), then the
	 * selection is dropped.
	 */
	#joinSelection(noSpace: boolean): void {
		const text = this.#ops.getText();
		const anchorLine = lineOf(text, this.#anchor);
		const cursorLine = lineOf(text, this.#ops.getCursor());
		const lines = Math.abs(anchorLine - cursorLine) + 1;
		this.#joinLines(lines, noSpace, nthLineStart(text, Math.min(anchorLine, cursorLine)));
		this.#exitVisual(this.#ops.getCursor());
	}

	/**
	 * Visual `>`/`<`: shift every selected line, whichever way the selection was
	 * drawn. A count typed before the operator is the number of shifts, as in vim
	 * (`V2>` shifts the block twice), and the caret lands on the first line of the
	 * range — the top one, whether or not the selection grew upward.
	 */
	#shiftSelection(right: boolean, amount: number): void {
		if (!this.selection) return;
		const text = this.#ops.getText();
		const anchorLine = lineOf(text, this.#anchor);
		const cursorLine = lineOf(text, this.#ops.getCursor());
		const first = Math.min(anchorLine, cursorLine);
		this.#shiftLines(Math.abs(anchorLine - cursorLine) + 1, right, amount, nthLineStart(text, first));
		this.#exitVisual(this.#ops.getCursor());
	}

	/**
	 * A horizontal move inside a selection, and the one thing it decides for it: an
	 * `l` that ran out of characters reaches a column past the line's last one, so
	 * the selection takes the line break (`vld` at a line end joins the two lines,
	 * while a `vl` that merely arrived on that character does not). A backward step
	 * spends that reach first — `v$h` puts the selection's end back on the line's
	 * last character without moving the caret, so a second `h` is the one that steps
	 * (`'>` moves from column len+1 to column len, the caret stays; probed on 9.1).
	 */
	/**
	 * A `j`/`k` (or an arrow) inside a selection: the wanted column decides the
	 * reach as well as the landing. A column the landed line can fill is a plain
	 * position, so it clears whatever reach an earlier motion armed; a column past
	 * that line's last character leaves the end one column past it (`v$j` onto a
	 * shorter line takes its break), and it carries — `v<BS>` wraps with the wanted
	 * column one past the line above, so the `j` after it arms the reach again even
	 * though the `<BS>` before it had spent one.
	 */
	#moveVisualVertical(deltaLines: number, count: number): void {
		for (let i = 0; i < count; i++) this.#vertical(deltaLines);
		const text = this.#ops.getText();
		const start = lineStart(text, this.#ops.getCursor());
		this.#visualPastEnd = this.#wantColumn() >= lineEndExclusive(text, start) - start;
		this.#syncSelection();
	}

	#moveVisualHorizontal(delta: number): void {
		const from = this.#ops.getCursor();
		let steps = delta;
		if (delta < 0 && this.#reachArmed(from)) {
			steps = delta + 1; // the first step back is spent on the reach
			this.#visualPastEnd = false;
		}
		// The move runs first: `delta > 0 && …` would short-circuit a backward step
		// away entirely, and `h` inside a selection has to move like any other `h`.
		const blocked = steps === 0 ? false : this.#moveHorizontal(steps);
		if (delta > 0) this.#visualPastEnd = blocked;
		this.#syncSelection();
	}

	/**
	 * A `<BS>` inside a selection: vim's own binding, `whichwrap`'s `b` half — a
	 * plain Backspace is `h` with the wrap, and visual mode is no exception (batch A
	 * read it as `h` here and left a comment claiming vim cancels the wrap; vim 9.1
	 * takes it, and the end that lands on the line above takes that line's break).
	 *
	 * Count steps, one at a time, because the reach sits between them: a step of an
	 * armed end is spent on the reach (`v<BS><BS>` on the second line of `"one
	 * two\nthird"` deletes `o\nt`, not `wo\nt` — the first step wraps, the second
	 * spends, and only the third would step off the last character), a step that
	 * has a character to step onto takes it and clears the reach, and a step that
	 * crosses a line break arms it — the wrap lands on the line above's last
	 * character with its column one past the end, exactly what `$` arms.
	 */
	#moveVisualBackspace(count: number): void {
		const text = this.#ops.getText();
		let want: number | null = null;
		for (let i = 0; i < count; i++) {
			const from = this.#ops.getCursor();
			if (this.#reachArmed(from)) {
				this.#visualPastEnd = false; // spent: the caret does not move, and the
				continue; // wanted column it was standing at is kept
			}
			const next = settleCursor(text, snapToChar(text, backspaceBoundary(text, from)));
			const wrapped = lineOf(text, next) < lineOf(text, from);
			this.#visualPastEnd = wrapped;
			this.#ops.setCursor(next);
			// A step that crossed the break leaves the end one column past the line's
			// last character, and that virtual column is what a following `j` aims at:
			// `v<BS>jj` on "one two"/"third"/"a long line here" lands on column 8 of
			// the third line, one past where the caret's own column would put it.
			want = wrapped ? lineEndExclusive(text, next) - lineStart(text, next) : next - lineStart(text, next);
		}
		if (want !== null) this.#curswant = want;
		this.#syncSelection();
	}

	/**
	 * A `<Space>` inside a selection: the forward twin, `whichwrap`'s `s` half. It
	 * moves like `l` while there is a character to step onto; once the end stands
	 * past the line's last character it wraps onto the next line's first character
	 * instead of staying put (`v$<Space>` — the wanted column has nowhere left to go
	 * on this line); and a step that ran out of characters without wrapping arms the
	 * reach, exactly as a blocked `l` does (`v<Space>d` at a line end joins the
	 * lines). On the last line there is nothing to wrap onto, so the caret stays.
	 *
	 * A caret standing on a line break — an empty line, where the break is the
	 * line — has no character to step onto either, so it wraps straight away
	 * (`v<Space>` on an empty line joins it onto the line below).
	 */
	#moveVisualSpace(count: number): void {
		const text = this.#ops.getText();
		const started = this.#ops.getCursor();
		for (let i = 0; i < count; i++) {
			const from = this.#ops.getCursor();
			if (this.#reachArmed(from) || text[from] === "\n") {
				this.#visualPastEnd = false;
				this.#ops.setCursor(snapToChar(text, spaceBoundary(text, from)));
				continue;
			}
			this.#visualPastEnd = this.#moveHorizontal(1);
		}
		this.#wantHereIfMoved(started);
		this.#syncSelection();
	}

	/**
	 * A word motion inside a selection. `w`/`b`/`e` stop on a character rather than
	 * aiming at a column, so they never reach past the line: `vw` onto the last
	 * character of a line keeps the selection inside that line (probed on vim 9.1).
	 */
	#moveVisualByWord(kind: "w" | "b" | "e", big: boolean, count: number): void {
		this.#visualPastEnd = false;
		this.#moveByWord(kind, big, count);
		this.#syncSelection();
	}

	#exitVisual(cursorTo: number, wantHere = true): void {
		this.mode = "normal";
		this.selection = null;
		this.#resetPending();
		this.#ops.setCursor(this.#clamp(cursorTo));
		this.#ops.toNormal();
		// Esc and every visual operator leave a wanted column behind (nv_esc and
		// ops.c:4273 both count as deliberate moves). The `v`-in-visual toggle is
		// the exception — see #startVisual — so it passes false.
		if (wantHere) this.#wantHere();
	}

	#deleteSelection(): void {
		if (!this.selection) return;
		const text = this.#ops.getText();
		const { start, end } = this.selection;
		if (end <= start) {
			// An empty selection: the last line of the buffer when it is empty has no
			// break after it to give up, so there is nothing to cut. An edit that
			// changes nothing must not cost the host an undo step.
			this.#exitVisual(start);
			return;
		}
		this.#register = { text: text.slice(start, end), linewise: this.mode === "visual-line" };
		const cut = this.#selectionCut(start, end, text);
		const out = text.slice(0, cut.start) + text.slice(cut.end);
		// A linewise cut lands like the operator forms do: on the first non-blank of
		// the line the removed block collapsed onto (`V<Del>` on the last line of
		// "a\nbc\ndef" ends on the 'b', with no line left below it).
		const caret = this.mode === "visual-line" ? linewiseLanding(out, cut.start) : settleCursor(out, cut.start);
		this.#ops.setAll(out, caret);
		this.#exitVisual(caret);
	}

	/**
	 * The range a visual-line selection removes: its whole lines, and — when they
	 * run to the end of the buffer — the line break in front of them as well.
	 * Deleting the last line leaves a buffer without a trailing newline rather
	 * than an empty line where it stood (the operator forms get this from
	 * `lineRange`). A charwise selection is removed exactly as it stands.
	 */
	#selectionCut(start: number, end: number, text: string): { start: number; end: number } {
		if (this.mode !== "visual-line" || end < text.length) return { start, end };
		return { start: start > 0 ? start - 1 : 0, end };
	}

	#yankSelection(): void {
		if (!this.selection) return;
		const text = this.#ops.getText();
		this.#register = {
			text: text.slice(this.selection.start, this.selection.end),
			linewise: this.mode === "visual-line",
		};
		this.#exitVisual(this.selection.start);
	}

	/**
	 * v_visop's uppercase rule: the same selection ends, taken linewise. Used by
	 * the visual `C`/`S`/`D`/`X`/`Y` forms, which vim turns into their lowercase
	 * operator over whole lines.
	 */
	#forceLinewise(): void {
		if (this.mode === "visual-line") return;
		this.mode = "visual-line";
		this.#syncSelection();
	}

	#changeSelection(): void {
		if (!this.selection) return;
		const { start, end } = this.selection;
		const text = this.#ops.getText();
		if (this.mode === "visual-line") {
			// `Vc` is `cc` over the selected lines, not a delete: the block gives way
			// to one empty line the insert starts on, exactly as #runLinewise does it
			// (probed on vim 9.1 — a middle-line `Vc` leaves "a\n\ndef", a `V<Del>`
			// leaves "a\ndef").
			const firstLine = lineOf(text, start);
			this.#exitVisual(start, false);
			this.#changeLines(firstLine, lineOf(text, Math.max(start, end - 1)));
			return;
		}
		this.#register = { text: text.slice(start, end), linewise: false };
		if (end > start) {
			const out = text.slice(0, start) + text.slice(end);
			// The insert stands at the cut point, exactly as it does for the operator
			// forms (see #runOperator) — even when that point is the buffer end.
			this.#ops.setAll(out, start);
			this.#exitVisual(start);
		} else {
			this.#exitVisual(start);
		}
		this.#enterInsert();
	}

	/** Visual `u`/`U`/`~`: lowercase, uppercase, or swap the case of the selection. */
	#caseSelection(kind: "upper" | "lower" | "toggle"): void {
		if (!this.selection) return;
		const text = this.#ops.getText();
		const { start, end } = this.selection;
		const segment = text.slice(start, end);
		// A paste token inside the selection keeps its spelling: a token's own
		// letters are its format, and uppercasing any of them makes the payload
		// behind it unreachable at submit.
		const swapped = mapOutsidePasteTokens(text, start, end, (run) =>
			kind === "upper" ? run.toUpperCase() : kind === "lower" ? run.toLowerCase() : swapCase(run),
		);
		// A selection with no cased characters changes nothing: exit visual without
		// recording an edit that did not happen.
		if (swapped !== segment) this.#ops.setAll(text.slice(0, start) + swapped + text.slice(end), start);
		this.#exitVisual(start);
	}
}
