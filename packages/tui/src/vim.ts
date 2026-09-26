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
 * Search is `/` and `?` forward and backward, `n`/`N` to repeat, `*`/`#` for the
 * keyword at or after the caret. The pattern is a JavaScript regular expression
 * with the `m` flag (vim's `^` and `$` are line anchors, and `/^a` on `a b\na b`
 * at 2 lands on the `a` that opens the second line — measured) plus `\<` and `\>`
 * as `\b`; what that dialect cannot say is named in the differential README rather
 * than translated into something right for one spelling and wrong for the next.
 * Six things about the search are measured against vim 9.1 rather than assumed,
 * and each of them is a trap:
 *   - a forward match must **start after** the caret, so a match the caret is
 *     standing on is skipped — `abcabc` at 0 searching `abc` lands on the second
 *     one at 3, not the first at 0;
 *   - backward is not the mirror: a match *containing* the caret is found, because
 *     what is compared is where the match starts, so `?ab` at 7 in `ab ab ab`
 *     lands on that match's start at 6;
 *   - a count is the number of matches to step over and it wraps **round and
 *     round**, not once: `3/a` on `a a a` at 0 lands back on the `a` at 0 and `4/a`
 *     on the one at 2. A list of the matches ahead plus the ones behind, indexed
 *     once and clamped at the end, answers 0 and 4 instead, so the count is a
 *     modulo over the matches rather than a position in that list;
 *   - the search **wraps** — the whole buffer, for `/`, `?`, `n` and `N` alike,
 *     which is vim's default `wrapscan`. A failed search moves nothing, and
 *     because a REPL has no message area to say `E486` in, a pattern that matches
 *     nothing looks exactly like a pattern that was never typed;
 *   - a search that failed is still the last search, and so is one whose pattern
 *     did not compile: after `/a<CR>/(<CR>` `n` finds nothing, because the broken
 *     pattern is the one that replaced the working one. Escape abandons the line
 *     and keeps the last search; a new one replaces it;
 *   - `*` and `#` both look **forward** for the keyword — on the comma of
 *     `foo, bar` at 3 they both land on the `bar` at 5 — and differ only in the
 *     direction the search then runs, from the keyword's own first character. That
 *     last part is why `#` from the middle of a word skips that word instead of
 *     landing on it, and it is why `*` on a Chinese word works here at all: vim's
 *     `\<word\>` cannot express one through a JavaScript `\b`, and a keyword run
 *     compared as a string can.
 *
 * Deliberate simplifications: f/t/F/T are line-scoped (as in vim); marks,
 * registers beyond the unnamed one, and `:` ex-commands are out of scope — but
 * the keys that would open them are still taken, so the keys after them cannot
 * be read as commands instead: `m`/`"`/`'`/`` ` `` read the name that follows and
 * `z`/`Z`/`q`/`@` the command or the register that follows, and `:` takes its
 * input line up to Enter or Escape and drops it. A search as an operator's motion
 * needs the operator to wait for a pattern that has not been typed yet, which is a
 * second latch open at once; so the operator is dropped and the search runs, and
 * `d/pat` moves the caret and deletes nothing.
 * j/k delegate to prompt-history recall when the buffer has no newline (the
 * common single-line REPL case).
 *
 * Contracts the host relies on:
 *   - Enter is consumed by a `/` or `?` line, because Enter is what runs the
 *     search: submitting the prompt as well would send it, which is not a thing
 *     a user who pressed `/` meant. Every other half-typed command still lets
 *     Enter through, because there it does mean "send this" — an abandoned `:`
 *     line or an unfinished `m`/`"` name included.
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
 * The longest a typed search pattern may be.
 *
 * A pattern is a regular expression, and a regular expression can be written to
 * take more time than a person is willing to wait: `/^(a+)+$/` is eight
 * characters. vim has the same exposure and the same answer, which is that the
 * user typed it; this is a prompt in a terminal rather than a file being edited,
 * and a hang here freezes a session with unsaved work in it, so the length is
 * bounded. That bounds how much a pattern can *say*, not how long one can take —
 * the cap is a guard against a pasted paragraph, not against backtracking.
 */
const MAX_SEARCH_PATTERN = 256;

/**
 * `\<` and `\>` as JavaScript spells them.
 *
 * JS's `\b` is the same boundary for every ASCII word character, which is what
 * vim's is for everything this build's {@link codePointClass} calls a word below
 * 192. It is not the same above: `\b` knows nothing of CJK, so `\<` in front of a
 * Chinese word finds nothing while the same pattern without the anchors works.
 * That is a gap, and it is named in the differential README rather than papered
 * over with a translation that is right for one script and wrong for the next.
 */
function translateSearchPattern(pattern: string): string {
	return pattern.replaceAll(/\\([<>])/g, "\\b");
}

/**
 * A typed `/` or `?` line, split into the pattern and the offset flag after it.
 *
 * A trailing separator is a delimiter and not part of the pattern, which is what
 * makes `//` the repeat vim treats it as rather than a search for a slash —
 * measured, `/a<CR>` and then `//<CR>` moving to the next `a` rather than standing
 * still. An empty pattern is therefore a repeat, and the caller is what turns that
 * into the last search; the split itself only has to not mangle it.
 *
 * The offset is one of `c`, `e`, `E` or `^` **after** a separator, and nothing
 * else: `/ae` is a search for `ae` (measured: it finds nothing in `a a a`, where
 * stripping the `e` would have found the `a` at 2), and `/a/2` is a search for
 * `a/2` because vim counts the match *before* the slash, as `2/a`. The letters
 * that place the caret on another line — `b`, `s`, `W`, `n`, `i`, `-`, `+` — are
 * not here, and the README says so.
 */
export function parseSearchLine(line: string, separator: "/" | "?"): { pattern: string; toEnd: boolean } {
	const offset = new RegExp(`^(.*)\\${separator}([cEe^])$`).exec(line);
	if (offset !== null) {
		const flag = offset[2] ?? "";
		return { pattern: offset[1] ?? "", toEnd: flag === "e" || flag === "E" };
	}
	if (line.endsWith(separator)) return { pattern: line.slice(0, -1), toEnd: false };
	return { pattern: line, toEnd: false };
}

/**
 * The pattern as an expression, or null when it is not one.
 *
 * `m` because vim's `^` and `$` are line anchors, not string anchors. `u` because
 * the buffer is indexed in UTF-16 code units, where a lone surrogate is not a
 * character at all; it also turns a pattern that JavaScript would read as one
 * thing into a throw rather than a match against something the user did not write.
 *
 * `g` is load-bearing and not about matching: without it `exec` ignores
 * `lastIndex` and answers with the first match every time, so
 * {@link collectSearchMatches} — a plain `exec` loop — asks the same question
 * forever and the engine hangs on the first Enter.
 *
 * A throw is caught rather than propagated because the alternative is a REPL that
 * cannot be used after one bad pattern: the caret does not move, and there is no
 * message area to say `E54` in.
 */
function compileSearchPattern(pattern: string): RegExp | null {
	try {
		return new RegExp(translateSearchPattern(pattern), "gmu");
	} catch {
		return null;
	}
}

/** One match: the half-open range of `text` it covers. */
interface SearchMatch {
	start: number;
	end: number;
}

/**
 * What the last search was, in the three shapes it can take.
 *
 * A word search is not a pattern spelled `\<word\>` even though that is how vim
 * writes it down; {@link collectWordRuns} says why, and the short of it is that a
 * JavaScript `\b` cannot find a CJK word where vim's can. A text search is the
 * other kind vim's `*` can produce, where the run was punctuation and became a
 * pattern instead — already escaped, so it is stored ready to compile.
 */
type LastSearch =
	| { kind: "pattern"; pattern: string; forward: boolean; toEnd: boolean }
	| { kind: "word"; word: string; forward: boolean }
	| { kind: "text"; text: string; forward: boolean };

/**
 * Every match of `re` in `text`, in the order they start.
 *
 * A pattern that can match the empty string would otherwise match at every
 * position forever, so a zero-width match steps the scan forward by one unit. It
 * is a real answer — `/\` and `/a*` are patterns a user can type — and it is the
 * only one that terminates. The step is {@link nextChar} rather than one code
 * unit, so it is a whole character on an astral one and a whole paste token on a
 * token, which is the same indivisibility every other motion here gives one.
 */
function collectSearchMatches(text: string, re: RegExp): SearchMatch[] {
	const out: SearchMatch[] = [];
	re.lastIndex = 0;
	for (let hit = re.exec(text); hit !== null; hit = re.exec(text)) {
		out.push({ start: hit.index, end: hit.index + hit[0].length });
		if (hit[0].length === 0) {
			const step = nextChar(text, re.lastIndex);
			// A zero-width match on the last character of a token the step ran to
			// the end of would answer the same position again; the end of the text
			// is the only place left to stop.
			if (step <= re.lastIndex) break;
			re.lastIndex = step;
		}
	}
	return out;
}

/**
 * Where the caret stands once it has landed on `hit`.
 *
 * With a search offset that is the match's last character, and the `Math.max` is
 * what a pattern that matched nothing at all gives — a `c` offset on text with no
 * `c` leaves an empty match, which has no last character, so the match's own start
 * is the only place left to stand.
 */
function searchLanding(hit: SearchMatch, toEnd: boolean): number {
	return toEnd ? Math.max(hit.start, hit.end - 1) : hit.start;
}

/**
 * The `nth` match from `from`, in `forward` order, counting round the buffer.
 *
 * A forward match has to *start* after the caret, which is what makes `abcabc` at
 * 0 land on the second `abc` rather than the one under the caret; a backward match
 * has to start before it, and that is also what makes a match *containing* the
 * caret be found — `?ab` at 7 in `ab ab ab` lands on that match's start at 6,
 * where a mirror of the forward rule would have skipped it.
 *
 * With an offset the comparison is on {@link searchLanding} rather than on the
 * start, and that is the whole of the difference between `/ab` and `/ab/e`: the
 * search is about the position the caret ends up at, so `ab ab` at 0 with `/ab/e`
 * lands on the 1 — the match *under* the caret, reached because its landing is
 * past the caret — where `/ab` skips to the 3. Measured over fourteen forward and
 * eight backward cases, one rule covers all of them; the two readings agree
 * everywhere the match is one character long, which is why the offset was
 * implemented for that case and measured to be wrong for the rest. Reading the
 * start instead is the same bug the backward `from - 1` was papering over, and
 * deleting that fixes the two directions with one change.
 *
 * The count is the number of matches to step over and it wraps round and round
 * rather than once, so the answer is an index taken modulo the number of matches.
 * That is not a detail: `3/a` on `a a a` at 0 lands back on the `a` at 0 and `4/a`
 * on the one at 2, and a list of the matches ahead plus the ones behind — indexed
 * once, clamped at the end of it — answers 0 and 4 instead of 0 and 2. The two
 * misses are the ones the modulo has to carry: a forward search with nothing ahead
 * of the caret starts at the first match, a backward one with nothing behind it
 * starts at the last.
 */
export function nthSearchMatch(
	matches: SearchMatch[],
	from: number,
	forward: boolean,
	nth: number,
	toEnd = false,
): SearchMatch | null {
	const total = matches.length;
	if (total === 0) return null;
	// The nearest one in the direction of travel, which for a sorted list is the
	// first one ahead and the last one behind. Written as two loops rather than one
	// with a direction test because the one-loop version keeps walking past the
	// answer and keeps the *last* match ahead instead of the first, which sends
	// `/a` on `a a a` to the end of the line.
	let at = -1;
	if (forward) {
		for (let i = 0; i < total; i++) {
			const hit = matches[i];
			if (hit !== undefined && searchLanding(hit, toEnd) > from) {
				at = i;
				break;
			}
		}
	} else {
		for (let i = total - 1; i >= 0; i--) {
			const hit = matches[i];
			if (hit !== undefined && searchLanding(hit, toEnd) < from) {
				at = i;
				break;
			}
		}
	}
	// Nothing in that direction: the search wraps round, so it starts at the far end
	// — the first match for a forward search, the last for a backward one.
	if (at < 0) at = forward ? total : -1;
	const index = (((at + (forward ? nth - 1 : 1 - nth)) % total) + total) % total;
	return matches[index] ?? null;
}

/**
 * The identifier run at or after `pos`, never reaching past `stop`.
 *
 * "Identifier" is vim's `FIND_IDENT` pass and it is stricter than "a word
 * character" — that is what the class table is for. It skips forward over blanks
 * and punctuation to the first character of any *other* class, then reaches left
 * and right over that one class and no other, so a Japanese sentence breaks at
 * every script change and a hanzi run does not break at all (measured: `*` on the
 * first `な` of `かなカナ漢字` lands on 0, the first `カ` on 2 and the first `漢` on
 * 4, and none of the three moves to another script's word).
 *
 * The classes that count are everything except blank and punctuation, which is why
 * an emoji is an identifier (`*` on `👍👍 👍👍` lands on the second one) while a euro
 * sign is not (`*` on `€€ €€` skips to the `x` after them). It is also why
 * `a×b` is one run — U+00D7 is inside the `192-255` range `iskeyword` covers.
 *
 * Reaches left past `pos`, and that is the whole of what the caller is given the
 * start for: a caret in the middle of `foo` searches for that same `foo` and
 * starts from its first character. Reporting the scan position instead makes the
 * search skip its own match, and makes {@link collectWordRuns} visit every second
 * run.
 */
function identifierRunAt(text: string, pos: number, stop: number): { word: string; start: number; end: number } | null {
	const clsAt = (at: number): CharClass => (at < stop ? charClass(text, at) : BLANK);
	let first = -1;
	for (let at = pos; at < stop; at = nextChar(text, at)) {
		const cls = clsAt(at);
		if (cls !== BLANK && cls !== PUNCT) {
			first = at;
			break;
		}
	}
	if (first < 0) return null;
	const cls = clsAt(first);
	let start = first;
	const begin = lineStart(text, first);
	while (start > begin) {
		const back = prevChar(text, start);
		if (clsAt(back) !== cls) break;
		start = back;
	}
	let end = nextChar(text, first);
	while (end < stop && clsAt(end) === cls) end = nextChar(text, end);
	return { word: text.slice(start, end), start, end };
}

/**
 * What `*` and `#` search for, as `nv_ident` finds it.
 *
 * `anchored` false is vim's `FIND_STRING` pass and it is a different kind of
 * search, not a second guess at the first: the text becomes a pattern rather than
 * a word, so it matches inside a longer run instead of against one of exactly its
 * own length. Measured on `a.. a..`, where `*` on the `.` at 1 finds the `a` at 4
 * and wraps to 0 — the identifier pass, because the rest of the line has a
 * letter in it — against `a..` with nothing but punctuation left, where the run
 * is the two dots themselves and the search looks for that literal.
 */
interface WordRun {
	word: string;
	start: number;
	end: number;
	anchored: boolean;
}

/**
 * The run at or after `pos` that `*` and `#` take, or null when there is none.
 *
 * Both passes stop at the end of the caret's line, which is vim reading
 * `ml_get_buf` rather than the whole buffer and is the reason `*` on the second
 * blank of `  \nfoo` moves nothing: there is no `foo` on that line to look at,
 * and the one on the next line is not considered. Measured, and the difference is
 * the whole behaviour — a buffer-wide scan finds it and lands on 3.
 *
 * On punctuation or whitespace the identifier pass does not refuse, it skips to
 * the next run: `*` on the comma of `foo, bar` at 3 lands on the `bar` at 5. It
 * skips for `#` too, which is the part that looks wrong and is measured: `#` on
 * that same comma also lands on the `bar` at 5, and it can only do that by having
 * found it forward. The two commands differ in the direction the search runs
 * afterwards, not in which keyword they take.
 */
function wordRunAt(text: string, pos: number): WordRun | null {
	const stop = lineEndExclusive(text, pos);
	const identifier = identifierRunAt(text, pos, stop);
	if (identifier !== null) return { ...identifier, anchored: true };
	// No identifier on the rest of the line, so any non-blank text will do — which
	// on a line of nothing but dots means the dots. It reaches left over its own
	// class only and right over everything non-blank, so the run in `a..` from
	// either dot is both of them (measured: `*` at 1 and at 2 both land on 1).
	let first = -1;
	for (let at = pos; at < stop; at = nextChar(text, at)) {
		if (charClass(text, at) !== BLANK) {
			first = at;
			break;
		}
	}
	if (first < 0) return null;
	const cls = charClass(text, first);
	const begin = lineStart(text, first);
	let start = first;
	while (start > begin) {
		const back = prevChar(text, start);
		if (charClass(text, back) !== cls) break;
		start = back;
	}
	let end = nextChar(text, first);
	while (end < stop && charClass(text, end) !== BLANK) end = nextChar(text, end);
	return { word: text.slice(start, end), start, end, anchored: false };
}

/**
 * The characters `*` and `#` put a backslash in front of, and the `?` one only a
 * `#` needs.
 *
 * Transcribed from `nv_ident` (`normal.c:3594`): the pattern is not escaped into
 * being literal, so `*` on a run holding `(` builds a pattern that does not
 * compile and the search fails — which is what happens here too, since
 * {@link compileSearchPattern} catches the throw.
 */
const STAR_WORD_SPECIALS = "/.*~[^$\\";

function escapeStarWord(word: string, forPound: boolean): string {
	const specials = forPound ? `${STAR_WORD_SPECIALS}?` : STAR_WORD_SPECIALS;
	let out = "";
	for (const ch of word) out += specials.includes(ch) ? `\\${ch}` : ch;
	return out;
}

/**
 * Every run of `word` in the buffer, as the half-open range it covers.
 *
 * The runs come from {@link identifierRunAt}, so they are the words the `w`/`b`/`e`
 * motions step over and `*` searches for the word a Chinese motion would step
 * over, rather than a `\b`-anchored pattern that cannot name one. Compared as
 * strings, which also keeps a keyword out of the regex metacharacter problem: a
 * run is made of one class of character, so there is nothing in one for a `.` or
 * a `(` to mean — and matching the whole string rather than a prefix is what
 * makes `*` on `👍👍👍` find nothing beside it (measured: the two-emoji run after it
 * is not a match, and the caret stays put).
 *
 * The whole buffer, not one line: a search steps over lines even though the run
 * `*` looked at does not.
 *
 * Stepping by `run.end` only visits each run once because that is the run's real
 * end: the run reaches left of wherever the scan started, so the offset handed to
 * the next call is always off the word rather than inside it.
 */
function collectWordRuns(text: string, word: string): SearchMatch[] {
	const out: SearchMatch[] = [];
	let at = 0;
	while (at < text.length) {
		const run = identifierRunAt(text, at, text.length);
		if (run === null) break;
		if (run.word === word) out.push({ start: run.start, end: run.end });
		at = run.end;
	}
	return out;
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

/**
 * `incl()`: the position one character along, which is the *next line's* first
 * character when `pos` is a line's last one, and -1 when the buffer has no
 * further character. That -1 is what makes `current_word` give up instead of
 * wrapping (textobject.c:764), and it is the only FAIL in the word objects'
 * whole walk — worth having as one function rather than open-coded twice.
 */
function inclPos(text: string, pos: number): number {
	const next = nextChar(text, pos);
	if (next >= text.length) return -1;
	// A line break is not a character to stand on, so the step over it is the
	// step onto the next line's first character — two units in a flat buffer.
	// `incl` is `inc` twice when `inc` answers 1 or 2 (misc2.c), which is what
	// makes the step off a line's last character land on the next line rather
	// than in the space between the two.
	return text[next] === "\n" ? nextChar(text, next) : next;
}

/**
 * `decl()` at a line's first column: the last character of the line above,
 * stepping over however many empty lines are in between, or -1 when there is no
 * line above to step onto.
 */
function declPos(text: string, pos: number): number {
	let i = prevChar(text, pos);
	while (i > 0 && text[i] === "\n") i = prevChar(text, i);
	return i < 0 ? -1 : i;
}

/**
 * `oneleft()`: one character back, or -1 where vim's fails — at a line's first
 * column, and at the start of the buffer. It does *not* cross the break; that is
 * `decl()`, and `current_word` reaches for it by name (textobject.c:736-737).
 *
 * The one position that is neither a character nor a line's first column is the
 * offset just past the buffer's end, which is where `inc()`'s answer of 2 leaves
 * the cursor: the last character is the one before it.
 */
function oneLeft(text: string, pos: number): number {
	if (pos <= 0) return -1;
	if (pos >= text.length) return prevChar(text, pos);
	if (lineStart(text, pos) === pos) return -1;
	return prevChar(text, pos);
}

/**
 * `fwd_word(1, bigword, eol=TRUE)` (textobject.c:361-421) — one step, to the
 * first character of the next word.
 *
 * `eol` is what makes this an operator's walk and not a motion's: it stops *on*
 * the next line rather than carrying on into it, and `crossed` is that case,
 * which `current_word` answers by stepping back onto the line it left
 * (textobject.c:736-737). A blank line stops it the same way, so the two need
 * not be told apart — the step back lands on the same character either way.
 *
 * `failed` is vim's FAIL, and it has exactly one cause: the step off the caret
 * answers `i >= 1` on the buffer's last line (textobject.c:387-391), which is the
 * caret standing on the buffer's last character. Every other step past a line's
 * end answers 2 and is kept, leaving the walk one past the last character — so
 * `at` is allowed to be `text.length` here, and the caller's `oneleft()` is what
 * brings it back onto a character. A failed walk leaves the caret in the same
 * place, which is why it is a flag and not a `null`: the first block of
 * `current_word` ignores the return value entirely (textobject.c:736) and only
 * the counted loop above it checks for FAIL.
 */
function fwdWordOnce(text: string, pos: number, big: boolean): { at: number; crossed: boolean; failed: boolean } {
	const n = text.length;
	const first = nextChar(text, pos);
	if (first >= n) return { at: n, crossed: false, failed: true };
	if (text[first] === "\n") return { at: nextChar(text, first), crossed: true, failed: false };
	let i = first;
	const sclass = charClass(text, pos, big);
	// "Go one char past end of current word (if any)".
	if (sclass !== 0) {
		while (charClass(text, i, big) === sclass) {
			const next = nextChar(text, i);
			if (next >= n) return { at: n, crossed: false, failed: false };
			if (text[next] === "\n") return { at: next + 1, crossed: true, failed: false };
			i = next;
		}
	}
	// "Go to next non-white".
	while (charClass(text, i, big) === 0) {
		const next = nextChar(text, i);
		if (next >= n) return { at: n, crossed: false, failed: false };
		if (text[next] === "\n") return { at: next + 1, crossed: true, failed: false };
		i = next;
	}
	return { at: i, crossed: false, failed: false };
}

/**
 * `end_word(1, bigword, stop=TRUE, empty=TRUE)` (textobject.c:490-563) — the
 * last character of a word: the current one when the caret is inside it, the
 * next one when the caret is on the white space in front of it.
 *
 * `stop=TRUE` is why it does not step on when the caret already stands on a
 * word's last character, which is the difference between `e` and `cw` that
 * {@link motionWordEndHere} already draws. `empty=TRUE` is why a blank line
 * ends the white walk instead of being stepped over.
 *
 * `null` is vim's FAIL: the white walk reaching the end of the buffer
 * (textobject.c:551) or the run reaching it (`:545`).
 */
function endWordOnce(text: string, pos: number, big: boolean): number | null {
	const n = text.length;
	const sclass = charClass(text, pos, big);
	let i = nextChar(text, pos);
	// Off the end of the buffer `inc` answers 2 and the character there is white,
	// so a word in progress ends where it started and a white walk runs into the
	// end of the file (textobject.c:545, :551). A line break is that same position
	// in a flat buffer — past this line's end, class white — and that is what stops
	// a word at the end of a line: `end_word` has no `eol`, so nothing carries it
	// onto the next line, and the class test below is the whole mechanism.
	if (i >= n) return sclass === 0 ? null : pos;
	if (sclass !== 0) {
		if (charClass(text, i, big) !== sclass) {
			// Already on a word's last character, or on the space after it: `stop=TRUE`
			// skips both of vim's moves and the trailing `dec_cursor` puts the caret
			// back where it was.
			return pos;
		}
		// In the middle of a word, so just move to the end of it. The loop tests the
		// character *after* `i`, which is how it stops on the last one rather than
		// one past — the whole difference between `e` and the object. Running out of
		// line or of buffer is not a failure here: `inc` answers 2 rather than -1
		// past a line's end, the character there is white, and `skip_chars` stops on
		// it so `end_word`'s `dec_cursor` brings the caret back (textobject.c:532-535).
		for (;;) {
			const next = nextChar(text, i);
			if (next >= n || text[next] === "\n") return i;
			if (charClass(text, next, big) !== sclass) return i;
			i = next;
		}
	}
	// From white: skip it, then finish the word it introduces. The blank-line stop
	// is `i` being a line's first column, where `empty=TRUE` leaves the walk on the
	// empty line rather than crossing it.
	while (i < n && charClass(text, i, big) === 0) {
		if (lineStart(text, i) === i) return i;
		const next = nextChar(text, i);
		if (next >= n) return null;
		i = text[next] === "\n" ? nextChar(text, next) : next;
	}
	// `skip_chars(cls(), FORWARD)` reads the class once, on the character the
	// white walk landed on, and then only ever compares against that one value
	// (textobject.c:139-155). Re-reading it each round instead is what carries a
	// word on through the punctuation behind it: on "a, b; c" from the space
	// before `b`, vim's object is " b" and the naive walk makes it " b;".
	const c = charClass(text, i, big);
	for (;;) {
		const next = nextChar(text, i);
		if (next >= n || charClass(text, next, big) !== c) return i;
		i = next;
	}
}

/**
 * `back_in_line()` (textobject.c:711-718) — the first character of the run of
 * same-class characters `pos` stands in, never past its own line's start. That
 * last part is the whole reason the indent in front of a word is not part of
 * `aw`: the fixup that reaches left for white space stops at the line's edge.
 */
function backInLine(text: string, pos: number, big: boolean): number {
	const cls = charClass(text, pos, big);
	const begin = lineStart(text, pos);
	let i = pos;
	while (i > begin) {
		const back = prevChar(text, i);
		if (charClass(text, back, big) !== cls) break;
		i = back;
	}
	return i;
}

/**
 * The `[count]`-th `iw` / `aw` object around `pos`, as the half-open range an
 * operator cuts — vim's `current_word` (textobject.c:683-853), which is a walk
 * and not a formula.
 *
 * The walk alternates: from a word's last character the next step lands on the
 * last character of the white space before the following word, and from there the
 * step after lands on that word's last character. `[N]iw` therefore ends on a
 * word for odd N and on white space for even N, and `[N]aw` — one white space
 * further along each time — makes `2iw` and `1aw` the same object, which is the
 * equivalence vim's own `:help iw` states and this reproduces rather than assumes
 * (measured: `y2iw` and `yaw` both read back `"one "` on `"one two"`).
 *
 * `landing` is where the walk left the caret, which is what a *failed* object
 * shows: `y4iw` on the second line of `"aa bb\ncc dd"` changes nothing and
 * leaves the caret on the last character, the position `incl()` had reached.
 * `ok` is vim's FAIL — the operator is dropped, the text untouched, the caret
 * moved to the landing.
 */
export function wordObject(
	text: string,
	pos: number,
	count: number,
	include: boolean,
	big = false,
): { start: number; end: number; landing: number; ok: boolean } {
	// The first object is the run of the caret's own class, widened to the whole
	// word or the whole white run. `iw` finishes it at the run's last character;
	// `aw` carries on over the white space that follows it.
	const n = text.length;
	const start = backInLine(text, pos, big);
	let at = pos;
	let includeWhite = false;
	if ((charClass(text, start, big) === 0) === include) {
		const end = endWordOnce(text, start, big);
		if (end === null) return { start, end: start, landing: n, ok: false };
		at = end;
	} else {
		// The first block does not check `fwd_word`'s answer (textobject.c:736) — a
		// failed walk leaves the caret past the end of the line and `oneleft()`
		// brings it back onto the last character, which is a perfectly good end for
		// the object. `daw` on the last word of the last line is the case that shows
		// it: the word is the object, and only the white space in front of it was
		// wanted, which the `include_white` fixup below finds.
		const step = fwdWordOnce(text, start, big);
		const moved = step.crossed ? declPos(text, step.at) : oneLeft(text, step.at);
		if (moved < 0) return { start, end: start, landing: start, ok: false };
		at = moved;
		if (include) includeWhite = true;
	}
	// A count past the first is that many more steps of the walk, and `incl()`
	// running out of buffer is the one way the whole thing fails.
	let remaining = count - 1;
	let inclusive = true;
	while (remaining > 0) {
		inclusive = true;
		const step = inclPos(text, at);
		if (step < 0) return { start, end: nextChar(text, at), landing: n, ok: false };
		at = step;
		if (include !== (charClass(text, at, big) === 0)) {
			const fwd = fwdWordOnce(text, at, big);
			// A FAIL is only fatal while steps remain: vim lets the last one stand
			// (`&& count > 1`, textobject.c:797), which is how `2iw` at the end of the
			// buffer still selects something. Either way the `oneleft()` below still
			// runs, so the walk's landing is the same and only `ok` differs.
			if (fwd.failed && remaining > 1) return { start, end: nextChar(text, at), landing: fwd.at, ok: false };
			const moved = fwd.crossed ? declPos(text, fwd.at) : oneLeft(text, fwd.at);
			// `oneleft()` FAILing is not an error: the object ends one character
			// short, exclusive (textobject.c:800-802).
			if (moved < 0) {
				inclusive = false;
				break;
			}
			at = moved;
		} else {
			const end = endWordOnce(text, at, big);
			if (end === null) return { start, end: nextChar(text, at), landing: n, ok: false };
			at = end;
		}
		remaining--;
	}
	let from = start;
	// `include_white` (textobject.c:813-838): `aw` with nothing after the word —
	// it ends a line, or the buffer — reaches *left* for the white space instead,
	// which is what makes `daw` on the last word of a sentence take the space in
	// front of it. Never at the line's first column, or indentation would go too.
	if (includeWhite && (charClass(text, at, big) !== 0 || (lineStart(text, at) === at && !inclusive))) {
		const back = oneLeft(text, start);
		if (back >= 0) {
			const begin = backInLine(text, back, big);
			if (charClass(text, begin, big) === 0 && begin !== lineStart(text, begin)) from = begin;
		}
	}
	return { start: from, end: nextChar(text, at), landing: at, ok: true };
}

/**
 * `'paragraphs'`' default (optiondefs.h:1940): the nroff macros that begin a
 * paragraph. This engine has none of vim's option storage, so the default is
 * all there is — and it is the default the differential harness runs under, so
 * nothing is lost by having no way to read a user's.
 *
 * Kept whole rather than cut into pairs, because `inmacro()` slides a *window*
 * of two over it in steps of two and a window's second character is allowed to
 * be a space — so the pairs cannot be enumerated on their own. `"P "` is the
 * one window in this default whose second character is a space, and it is the
 * reason a bare `.P` is a paragraph start while a bare `.I` is not.
 */
const NROFF_PARAGRAPH_MACROS = "IPLPPPQPP TPHPLIPpLpItpplpipbp";

/**
 * `inmacro(opt, s)` (textobject.c:252-273) — is `s`, the text after a `.`, a
 * macro name in the `'paragraphs'` option?
 *
 * The window is two characters and it advances by two, and the line's end is a
 * NUL rather than a character: a window's NUL *or* space matches when `s` has
 * ended, which is what lets `"P "` match a one-character `s`. Reading `s` out of
 * the whole buffer instead of out of the line is how a bare `.P` came to be
 * missed — the read crossed the break and saw `"P\n"`, two characters, neither
 * of which is in anything.
 */
function inmacro(line: string, at: number): boolean {
	const s0 = at < line.length ? line[at] : null;
	const s1 = at + 1 < line.length ? line[at + 1] : null;
	for (let m = 0; m + 1 < NROFF_PARAGRAPH_MACROS.length; m += 2) {
		const w0 = NROFF_PARAGRAPH_MACROS[m];
		const w1 = NROFF_PARAGRAPH_MACROS[m + 1];
		const first = w0 === s0 || (w0 === " " && (s0 === null || s0 === " "));
		const second = w1 === s1 || ((w1 === null || w1 === " ") && (s0 === null || s1 === null || s1 === " "));
		if (first && second) return true;
	}
	return false;
}

/**
 * `linewhite(lnum)` (search.c:3183) — `skipwhite()` the line and ask whether
 * what is left is the NUL. `skipwhite` steps over spaces and tabs and nothing
 * else, so a line of `"  \t "` is as blank as an empty one and a line holding a
 * form feed is not.
 */
function isBlankLine(text: string, line: number): boolean {
	const begin = nthLineStart(text, line);
	for (let i = begin; i < text.length && text[i] !== "\n"; i++) {
		if (text[i] !== " " && text[i] !== "\t") return false;
	}
	return true;
}

/**
 * `startPS(lnum, 0, 0)` (textobject.c:280-292) — the other thing that ends a
 * paragraph besides a blank line, and the only part of `current_par` that
 * reads the buffer's text. A form feed in the first column, or a `.` followed
 * by an nroff macro from `'paragraphs'`: two characters, not the whole word,
 * which is why `.IP` splits and `.ABC` does not. `inmacro()` compares
 * case-sensitively, so the list's lowercase `.bp` splits and an upper-case
 * `.BP` does not.
 *
 * Asked only about a line already known not to be blank, which is what every
 * caller in `paragraphObject` does. That matters because `startPS` would answer
 * TRUE for a blank one — with `para` at 0 it compares the line's first
 * character against the NUL an empty line has — and here it does not.
 */
function startsParagraph(text: string, line: number): boolean {
	const begin = nthLineStart(text, line);
	if (text[begin] === "\f") return true;
	if (text[begin] !== ".") return false;
	// The macro is read out of the *line*, so that a name ending at the break
	// hands `inmacro` the NUL it is allowed to match and not the `\n` that
	// happens to follow it in the buffer.
	return inmacro(text.slice(begin, lineEndExclusive(text, begin)), 1);
}

/**
 * The whole lines `ip` / `ap` select, as `current_par` (textobject.c:1500-1672)
 * works them out, or `null` for the FAIL it can return — which a count running
 * off the end of the buffer always is, and which is a no-op rather than a clamp.
 * Measured: `2dip` on the only paragraph of `"a\nb"` changes nothing, while
 * `dip` empties it.
 *
 * A paragraph is a run of non-blank lines, and a run of blank lines counts as
 * a unit of its own: `ip` on a blank line takes the whole run, `2ip` on a
 * paragraph takes the paragraph plus the next *unit* below it. So on
 * `"a\n\n\nb"` the units are `a` / the two blanks / `b`, and `2ip` is three
 * lines while a bare `ip` on a blank is two.
 *
 * `ap` differs in three places, and all three are about the blank lines: it
 * takes the blanks that follow, it stops early when it starts on blanks, and
 * when there is nothing after the paragraph it takes the blanks in front of it
 * instead. That last one is why `dap` on the last paragraph of `"a\n\nb"`
 * removes the blank line too, where `dip` does not.
 *
 * The answer is always whole lines. `current_par` ends by setting
 * `oap->motion_type = MLINE` and never writes `oap->inclusive`, so a caller
 * must not treat this as a characterwise span — there is no `diw` promotion
 * question here, because linewise is what the object already is.
 */
function paragraphObject(
	text: string,
	pos: number,
	count: number,
	include: boolean,
): { firstLine: number; lastLine: number } | null {
	const last = lineCount(text) - 1;
	let firstLine = lineOf(text, pos);
	const blankInFront = isBlankLine(text, firstLine);
	// Up to the top of the unit. Sitting on blanks, the walk stops at the first
	// line with anything in it; otherwise it stops at a blank line, or at a line
	// that begins a paragraph — the cursor's own line included, which is what
	// makes `dip` on `.PP` take that line and nothing above it.
	while (firstLine > 0) {
		const above = isBlankLine(text, firstLine - 1);
		if (blankInFront ? !above : above || startsParagraph(text, firstLine)) break;
		firstLine--;
	}
	// A blank line takes the whole run of blanks it belongs to; anything else
	// starts one line short of its own end and the loop below moves forward.
	let lastLine = firstLine;
	while (lastLine <= last && isBlankLine(text, lastLine)) lastLine++;
	lastLine--;
	// `i = count`, one less when the cursor is already inside a blank run and the
	// object does not want the blanks — `ip` there is just the run, and `2ip`
	// reaches the paragraph below it.
	let remaining = include || !blankInFront ? count : count - 1;
	while (remaining-- > 0) {
		if (lastLine === last) return null;
		// The next unit is a run of blanks only when blanks come directly after
		// this one. `ip` steps over such a run to the paragraph past it; `ap`
		// takes it and this is where it stops when it started on blanks.
		const nextIsBlank = isBlankLine(text, lastLine + 1);
		if (include || !nextIsBlank) {
			lastLine++;
			while (lastLine < last && !isBlankLine(text, lastLine + 1) && !startsParagraph(text, lastLine + 1)) {
				lastLine++;
			}
		}
		if (remaining === 0 && blankInFront && include) break;
		if (include || nextIsBlank) {
			while (lastLine < last && isBlankLine(text, lastLine + 1)) lastLine++;
		}
	}
	// The one place `ap` reaches *back*: there was no blank run after the
	// paragraph to take, so it grows upward over the one in front instead.
	if (!blankInFront && !isBlankLine(text, lastLine) && include) {
		while (firstLine > 0 && isBlankLine(text, firstLine - 1)) firstLine--;
	}
	return { firstLine, lastLine };
}

/**
 * The bracket pairs `i(`/`a(` and their siblings name, keyed by *both*
 * spellings of each: `i)` is `i(` and `a]` is `a[`. Vim's `'matchpairs'`
 * default is `(:),[:],{:},<:>`, and `current_block` looks for the pair it is
 * given with `ccheck`/`ccommand` (textobject.c), so a bracket of any *other*
 * kind is an ordinary character to the scan: `di[` inside `f(a)[b]` reaches
 * the `[b]` and steps over the parentheses without noticing them.
 *
 * `b` and `B` are the remaining two spellings, and only here. `nv_object`
 * (normal.c:7238, :7243) falls through `case 'b': case '(': case ')'` to the
 * same `current_block` call, so `dib` is `di(` — which is a *different* code
 * path from the `b` motion `db`, and so the two coexist rather than collide.
 * `dib` on `x{a{b}c}` fails for want of a `()` just as `diB` does.
 */
const BLOCK_PAIRS: Record<string, readonly [string, string]> = {
	"(": ["(", ")"],
	")": ["(", ")"],
	b: ["(", ")"],
	"[": ["[", "]"],
	"]": ["[", "]"],
	"{": ["{", "}"],
	"}": ["{", "}"],
	B: ["{", "}"],
	"<": ["<", ">"],
	">": ["<", ">"],
};

/**
 * The opening bracket of the innermost pair that reaches `pos`, scanning left
 * over the pair's own nesting: a `close` steps one level in, an `open` either
 * steps back out or, at level zero, is the one being looked for. `pos` itself
 * is scanned as an ordinary character — the caller decides what to make of a
 * caret that is standing on a bracket.
 */
function enclosingOpen(text: string, pos: number, open: string, close: string): number {
	let depth = 0;
	for (let i = Math.min(pos, text.length - 1); i >= 0; i--) {
		const ch = text[i];
		if (ch === close) depth++;
		else if (ch === open) {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

/** The `close` that matches the `open` at `open`, or -1 when it has none. */
function matchingClose(text: string, open: number, pair: readonly [string, string]): number {
	const [o, c] = pair;
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === o) depth++;
		else if (text[i] === c && --depth === 0) return i;
	}
	return -1;
}

/**
 * `i(`/`a(` and the other three pairs — `current_block` (textobject.c), which
 * is a bracket scan and nothing more: it does not know about strings, so `di(`
 * inside `"f(a)"` takes the parentheses *in the string*, which is what vim
 * does and what this measures.
 *
 * The object is the innermost pair that *reaches* the caret, brackets
 * included: a caret standing on either bracket of a pair is inside that pair,
 * which is what makes `di(` on the `(` of `foo(bar)` take `bar` rather than
 * the pair around it. When no pair reaches the caret the search runs forward
 * instead, and takes the next opening bracket that is not already inside a
 * block and that has a mate — so `di(` typed before a call reaches it, `di[`
 * typed inside `f(a)[b]` reaches the `[b]`, and `di(` typed in front of a
 * stray `)` reaches nothing at all, which is a FAIL. See {@link nextOpen}.
 *
 * A count is a number of levels *outward* from the innermost pair, and a count
 * with nothing left to grow into fails the whole object rather than keeping the
 * one that was found: `d2i(` on the outermost pair changes nothing, while
 * `2iw` at the end of a line still selects a word (`2iw` is a count of units,
 * not of nesting levels, and the two are not the same rule).
 *
 * Half-open `[start, end)`, brackets included or not, or `null` when there is
 * no block. The range is the one {@link blockRange} computes, which is not
 * always a span: an object can come back linewise, and one shape comes back
 * with its end behind its start.
 */
function blockObject(
	text: string,
	pos: number,
	count: number,
	include: boolean,
	pair: readonly [string, string],
): BlockRange | null {
	const [open, close] = pair;
	// A caret on a bracket belongs to the pair that bracket is part of, so the
	// scan starts beside it rather than on it — walking left over a `)` would
	// step a level in and find the pair *around* this one.
	let o = -1;
	// Which way the search went decides what a count means, and the two are
	// opposite. `current_block` re-runs the *same* search `count` times from
	// wherever the last one landed (textobject.c:1091-1108), so a backward search
	// walks outward to the enclosing pair while a forward one walks inward to the
	// nested one: `d2i(` from outside `x(a(b(c)d)e)y` deletes `b(c)d`. A forward
	// search therefore has to find that nesting to spend a count on — `d2i(` on
	// `x = "f(a)"; g(b)` fails, because the second sweep comes back with nothing:
	// the `)` after `a` leaves the count one level deep, and the `(g)` that
	// follows only steps back down to it. See {@link nextOpen}.
	let forward = false;
	if (pos < text.length && text[pos] === open) o = pos;
	else {
		const from = pos < text.length && text[pos] === close ? pos - 1 : pos;
		o = enclosingOpen(text, from, open, close);
		if (o < 0) {
			o = nextOpen(text, pos + 1, pair);
			if (o < 0) return null;
			forward = true;
		}
	}
	// The mate is looked up *after* the count, and only then. That ordering is
	// the whole of `d2i(` on `f(a b(c)d`: the first search lands on the `(` at
	// 1, which nothing closes, so the object is a FAIL — while the second search
	// steps inside it and lands on `(c)`, which closes, and the command works.
	// `di(` on the same text does nothing at all.
	let c = matchingClose(text, o, pair);
	for (let level = 1; level < count; level++) {
		const next = forward ? nextOpen(text, o + 1, pair) : enclosingOpen(text, o - 1, open, close);
		if (next < 0) return null;
		o = next;
		c = matchingClose(text, o, pair);
	}
	if (c < 0) return null;
	return blockRange(text, o, c, include);
}

/**
 * The next opening bracket a *forward* `findmatch` sweep can come back with —
 * `findmatchlimit(NULL, what, FM_FORWARD, 0)` (search.c:2175-2240 for the setup,
 * 2810-2820 for the count).
 *
 * `FM_FORWARD` overrides the direction `find_mps_values` picked, and what is left
 * is a sweep that counts a `close` *up* and hands back an `open` at count zero.
 * That is not a scan for the first `(`: the count is what makes it walk into a
 * block rather than over it, and it is the whole of two measured failures.
 *
 *   - `di(` on `a) b(c)` and on `a)\nb(c)` fails, for the same reason: the `)` at
 *     1 puts the sweep one level deep, and the `(` behind it is not an answer —
 *     on one line or across two, which is the level surviving a line break.
 *     Taking it anyway invents a block vim never had. `di(` on `f(a)b)(c)` at 0
 *     is the contrast that shows the count is doing the work: the sweep sees the
 *     `)` at 2 *and* the `(` at 5, so it is back at zero when it reaches the `(`
 *     at 1, and that one is an answer.
 *   - `d2i(` on `f(x)((y)` takes `(y)`. The second sweep starts just past the `(`
 *     the first one found and runs to the end of the buffer, past the close of
 *     that bracket: the level is back to zero at the second `(` and that is the
 *     one it returns. Bounding the sweep at the bracket's own close — which is
 *     what it used to do — stops one character short and fails the object.
 *
 * `from` is the position to start *after*: the sweep moves before it examines
 * anything, so the character under the cursor is never counted.
 */
function nextOpen(text: string, from: number, pair: readonly [string, string]): number {
	const [open, close] = pair;
	let level = 0;
	for (let i = Math.max(0, from); i < text.length; i++) {
		const ch = text[i];
		if (ch === close) level++;
		else if (ch === open) {
			if (level === 0) return i;
			level--;
		}
	}
	return -1;
}

/**
 * The object `current_block` hands the operator, as a range in the buffer.
 *
 * `end` is exclusive and `linewise` says whether the two are whole lines.
 * Neither is enough on its own: `current_block` deals in *positions*, and three
 * separate pieces of `do_pending_operator` turn one into a range before any
 * operator runs. See {@link blockRange}.
 */
interface BlockRange {
	start: number;
	end: number;
	/** Whether the character under the end position is part of the range. */
	inclusive: boolean;
	linewise: boolean;
	firstLine: number;
	lastLine: number;
	/** `current_block` found nothing between the brackets to operate on. */
	empty: boolean;
}

/**
 * One `decl()` step (misc2.c:448), and the flag the walk in `current_block`
 * tests to decide whether to go on.
 *
 * `decl` is `dec`, and a second `dec` when the first crossed a line *and* landed
 * on a real column. `dec` at column zero moves to the line above and puts the
 * column at that line's length — which is a position past its last character,
 * so `decl`'s second step is what pulls it back onto one. A line holding
 * nothing has length zero, there is no character to pull back onto, and `decl`
 * stops with the cursor on the empty line itself. Its return value is 1 in both
 * of those cases, which is what `current_block`'s `if (decl(...) != 0) break;`
 * is reading, and at the start of the file it is -1.
 */
function declStep(text: string, p: number): { pos: number; stop: boolean } {
	if (p > lineStart(text, p)) return { pos: p - 1, stop: false };
	if (p === 0) return { pos: 0, stop: true };
	// The line above ends at the break in front of `p`, so it starts after the
	// break before *that* one — which is what tells an empty line from a full
	// one, since an empty line's start and its own break are the same offset.
	const aboveStart = text.lastIndexOf("\n", p - 2) + 1;
	if (p - 1 === aboveStart) return { pos: aboveStart, stop: true };
	return { pos: p - 2, stop: false };
}

/**
 * `inindent` (indent.c:1101-1112): how far the current line's leading blanks
 * reach, measured against the column. `extra` is the argument and the two calls
 * differ on it — `inindent(0)` is true *on* the first non-blank, `inindent(1)`
 * only strictly before it — which is the whole difference between an empty line
 * (true at 0, false at 1) and a line of nothing but blanks (true at either).
 */
function inIndent(text: string, p: number, extra: number): boolean {
	const ls = lineStart(text, p);
	let col = 0;
	while (text[ls + col] === " " || text[ls + col] === "\t") col++;
	return col >= p - ls + extra;
}

/**
 * The span of an *inner* object, in `current_block`'s own arithmetic
 * (textobject.c:1128-1204).
 *
 * The loop body is `while (!include)`, so an `a` object skips all of it and is
 * `[open, close + 1)`. An `i` object does four things in order, and each is
 * observable:
 *
 *   - `incl(&start_pos)` steps over the opening bracket, and over the break
 *     behind it when the bracket ends its line — so the object can begin on a
 *     line of its own, which is what makes the rest come out differently.
 *   - `sol` is the closing bracket standing at column zero, and the walk below
 *     sets it too.
 *   - `decl` puts the end on the character before the closing bracket, and
 *     `while (inindent(1))` keeps stepping left over the indent in front of it.
 *     A line of nothing but blanks is all indent and the walk crosses it; an
 *     empty line is not, so the walk stops there.
 *   - the emit has three arms (textobject.c:1190-1204): `sol` steps the end one
 *     position on and leaves it non-inclusive, an end at or past the start takes
 *     the character under it and is inclusive, and an end *behind* the start is
 *     nothing at all — `curwin->w_cursor = start_pos`, which is where the caret
 *     goes. `di(` on `a(\n)` changes no text and lands on the closing bracket,
 *     because that is where the text would have begun.
 *
 * Then ops.c:4307-4329 has the last word, before any operator runs: a
 * characterwise range whose end is at column zero of its line and which spans
 * more than one line loses that line, and becomes *linewise* outright if it
 * began on or before the first non-blank of its own line. That is why `di(`
 * and `ci(` on `f(\n  a\n)` are the same edit with different tails, and why the
 * `d`/`c` difference is not in the operator at all.
 */
function blockRange(text: string, open: number, close: number, include: boolean): BlockRange {
	const firstLine = lineOf(text, open);
	const lastLine = lineOf(text, close);
	if (include) {
		return { start: open, end: close + 1, inclusive: false, linewise: false, firstLine, lastLine, empty: false };
	}
	// Neither `incl` can fail here: a closing bracket stands after the opening
	// one, so there is always a character past both.
	const start = inclPos(text, open);
	let sol = close === lineStart(text, close);
	let cursor = declStep(text, close).pos;
	for (;;) {
		if (!inIndent(text, cursor, 1)) break;
		sol = true;
		const next = declStep(text, cursor);
		cursor = next.pos;
		if (next.stop) break;
	}
	// `else if (LTOREQ_POS(start_pos, curwin->w_cursor)) oap->inclusive = TRUE`
	// — the third arm, an end *behind* the start, is the one the comment calls
	// "no text in between <>, []", and it is reached the same way as a `sol`
	// object whose break lands it back on the opening bracket: both leave the
	// range with no length. ops.c:4277-4282 reads that as `oap->empty`, which
	// `op_delete` returns on (ops.c:790) and `op_change` walks past into insert.
	// It is read *before* the promotion below, so a range the promotion folds
	// onto its own start is not empty.
	const endPos = sol ? inclPos(text, cursor) : cursor;
	if (endPos + (sol ? 0 : 1) <= start) {
		return { start, end: start, inclusive: false, linewise: false, firstLine, lastLine, empty: true };
	}
	return promoteEnd(text, start, endPos, !sol);
}

/**
 * ops.c:4307-4329, the adjustment every operator passes through on its way to
 * `op_delete`/`op_yank`/`op_change`, and the reason a bracket object is
 * linewise more often than its span suggests.
 *
 * `endPos` is a *position* the way vim's is, not an offset of the range's end:
 * a non-inclusive end at column zero stops short of that line's first
 * character while still covering the break in front of it, which is why
 * `yi(` on `f(a\n\n)` reads back `a` and the break behind it.
 */
function promoteEnd(text: string, start: number, endPos: number, inclusive: boolean): BlockRange {
	const firstLine = lineOf(text, start);
	const lastLine = lineOf(text, Math.max(start, endPos));
	const end = endPos + (inclusive ? 1 : 0);
	if (inclusive || endPos !== lineStart(text, endPos) || lastLine === firstLine) {
		return { start, end, inclusive, linewise: false, firstLine, lastLine, empty: false };
	}
	// The end was at the head of its own line, so the line goes back to the one
	// above, and the range is linewise if it began in its own line's indent.
	const above = lastLine - 1;
	if (inIndent(text, start, 0)) {
		return { start, end, inclusive, linewise: true, firstLine, lastLine: above, empty: false };
	}
	const aboveStart = nthLineStart(text, above);
	// `oap->end.col = ml_get_len(oap->end.lnum); if (oap->end.col) { --oap->end.col;
	// oap->inclusive = TRUE; }` — a line above holding nothing has no last
	// character to move onto, so the end stays at its column zero and stays
	// non-inclusive, and the range keeps the break in front of that line.
	const lastChar = lineEndExclusive(text, aboveStart) - 1;
	if (lastChar < aboveStart) {
		return { start, end: aboveStart, inclusive: false, linewise: false, firstLine, lastLine: above, empty: false };
	}
	return { start, end: lastChar + 1, inclusive: true, linewise: false, firstLine, lastLine: above, empty: false };
}

/**
 * `'quoteescape'` (optiondefs.h:2161-2163), the one option `current_quote` reads.
 * It is a global string, not a buffer-local one, and its default is a backslash
 * alone — a character that is only ever tested for membership, never counted.
 */
const QUOTE_ESCAPE = "\\";

/** `VIM_ISWHITE` (macros.h:39), which is a space and a tab and nothing else. */
function isSpaceOrTab(ch: string | undefined): boolean {
	return ch === " " || ch === "\t";
}

/**
 * `find_next_quote` (textobject.c:1680-1708), over `[0, end)` of the buffer rather
 * than over a `char_u *`.
 *
 * The escape test is not a parity test. It asks whether the character under the
 * scan is a member of `'quoteescape'` and, if so, steps over *the next one*
 * without examining it — so `a\"b` hides its quote and `a\\"b` shows it, and no
 * number of backslashes is ever taken. `find_prev_quote` reaches the same verdict
 * by a different route (an explicit `n & 1`), which is worth knowing: the two
 * scans are not two spellings of one loop.
 *
 * The advance is a whole character, so a scan crosses accented letters and CJK
 * without stopping in the middle of one. An escape character as the line's last
 * is `-1`, not a quote.
 */
function findNextQuote(text: string, from: number, end: number, quote: string, escapeAware: boolean): number {
	let p = Math.max(0, from);
	while (p < end) {
		const ch = text[p];
		if (escapeAware && ch === QUOTE_ESCAPE) {
			p = nextChar(text, p);
			if (p >= end) return -1;
		} else if (ch === quote) {
			return p;
		}
		p = nextChar(text, p);
	}
	return -1;
}

/**
 * `find_prev_quote` (textobject.c:1716-1740), and the two things it does that the
 * forward scan does not.
 *
 * It steps *left of* the position it is handed, so a quote the caret is standing
 * on is not found by this call — and it returns the line's first column rather
 * than `-1` when it finds nothing, which is why every caller asks whether the
 * character it got back is the quote rather than whether the position is negative.
 *
 * The escape rule here is the parity test: the maximal run of escape characters
 * immediately to the left is counted, and an odd run hides the candidate
 * (`if (n & 1) col_start -= n`, textobject.c:1734-1735). The run is never
 * examined at the line's first column — the guard is `col_start - n > 0`, so the
 * lowest index read is 1 — which is why a backslash in the first column of a line
 * does not escape the quote behind it.
 */
function findPrevQuote(text: string, from: number, start: number, quote: string, escapeAware: boolean): number {
	let p = Math.min(from, text.length);
	while (p > start) {
		p--;
		// `mb_head_off`: a step back can land on a trailing half of a pair, and
		// the scan counts columns, so it goes back onto the character.
		if (p > start && isLowSurrogate(text.charCodeAt(p))) p--;
		let run = 0;
		if (escapeAware) {
			while (p - run > start && text[p - run - 1] === QUOTE_ESCAPE) run++;
		}
		if (run & 1) p -= run;
		else if (text[p] === quote) return p;
	}
	return start;
}

interface QuoteRange {
	start: number;
	end: number;
	/** Whether the character under `end` is part of the range. */
	inclusive: boolean;
	/** `current_quote` gave up: the operator is dropped and the caret does not move. */
	ok: boolean;
}

/**
 * `current_quote` (textobject.c:1742-2029) for `i"` `a"` `i'` `a'` `` i` `` `` a` ``.
 * The three characters are three `case` labels over one arm of `nv_object`
 * (normal.c:7274-7279) with `cap->nchar` handed through untranslated, so they are
 * one object spelled three ways.
 *
 * The whole function runs on `ml_get_curline()` (textobject.c:1753) and the
 * manual says so too (motion.txt:692): a quote object never crosses a line break,
 * so a line whose quote has no mate *on that line* is a FAIL, not a string that
 * runs on into the next one. This buffer is one string, so every scan below is
 * bounded by `[lineStart, lineEndExclusive)` — the thing that makes the rule
 * expressible at all here.
 *
 * Which of the two quotes under the caret is the opening one is not guessed.
 * There are two branches, and the one that runs is decided by whether the caret
 * is standing on a quote at all:
 *
 *   - Not on one (textobject.c:1912-1929): step left for the opener, escape-aware,
 *     and if there is none step *right from the start of the line* — with escapes
 *     switched **off**. That asymmetry is real and is the reason `\` in front of
 *     a quote does not always hide it: a line whose only quote is escaped has its
 *     quote found by the fallback, which cannot see the escape. The closer is
 *     then found from just past the opener, escape-aware.
 *   - On one (textobject.c:1891-1910): re-scan the *whole line* from column zero,
 *     pairing quotes left to right — opener with escapes off, closer with them on
 *     — and take the first pair that contains the caret, both bounds inclusive.
 *     So the caret on the opening quote of `ab"cd"ef` belongs to that string and
 *     not to its neighbour, and the caret on a closing quote belongs to the string
 *     it closes.
 *
 * `a` then adds white space, and the two sides are alternatives rather than a pair
 * (the `else` at textobject.c:1938, and motion.txt:695-696): all of the run after
 * the closing quote, or — only when there is none — all of the run in front of the
 * opening one. A closing quote that ends its line has no white space after it, so
 * it is the leading run that grows, and a string starting at column zero never
 * grows one at all.
 *
 * A count is not a number of strings. `current_quote` mentions it twice
 * (textobject.c:1945, :1973) and both are comparisons against 2, so `d3i"` is
 * `d2i"`: the quotes are in and the white space is not (motion.txt:704-706).
 */
function quoteObject(text: string, pos: number, count: number, include: boolean, quote: string): QuoteRange {
	const start = lineStart(text, pos);
	const end = lineEndExclusive(text, pos);
	let open: number;
	let close: number;
	if (text[pos] === quote) {
		open = start;
		for (;;) {
			open = findNextQuote(text, open, end, quote, false);
			if (open < 0 || open > pos) return { start: pos, end: pos, inclusive: false, ok: false };
			close = findNextQuote(text, open + 1, end, quote, true);
			if (close < 0) return { start: pos, end: pos, inclusive: false, ok: false };
			if (open <= pos && pos <= close) break;
			open = close + 1;
		}
	} else {
		open = findPrevQuote(text, pos, start, quote, true);
		if (text[open] !== quote) {
			open = findNextQuote(text, open, end, quote, false);
			if (open < 0) return { start: pos, end: pos, inclusive: false, ok: false };
		}
		close = findNextQuote(text, open + 1, end, quote, true);
		if (close < 0) return { start: pos, end: pos, inclusive: false, ok: false };
	}
	let from = open;
	if (include) {
		if (isSpaceOrTab(text[close + 1])) {
			while (isSpaceOrTab(text[close + 1])) close++;
		} else {
			// Only when the line ends at the closing quote, and only back to
			// column zero: the guard is `col_start > 0`.
			while (from > start && isSpaceOrTab(text[from - 1])) from--;
		}
	}
	// `if (!include && count < 2 && (vis_empty || !inside_quotes)) ++col_start;`
	// — with an operator pending there is no Visual area, so `vis_empty` holds and
	// the test is the count alone.
	if (!include && count < 2) from++;
	// Whether the closing quote is in the range. The source decides it with
	// `if ((include || count > 1 …) && inc_cursor() == 2) inclusive = TRUE;`
	// (textobject.c:1972-1976), and read as a flag that is the wrong shape: the
	// test that matters is the *outer* one, because `inc_cursor()` moves the cursor
	// (misc2.c:343-365) and `oap->end` is read off the cursor afterwards. A call
	// therefore leaves the end one past the closing quote, and the operator's
	// exclusive range takes it in; no call leaves the end *on* the closing quote
	// and the range stops short of it. The `== 2` is only about not stepping off
	// the end of the line, and it makes no difference here — measured, `da"` on
	// `x "ab"` and on `x "ab"   ` behave the same on both sides of it, and so does
	// `da"` on `x "ab" y` where the extended end is nowhere near the last character.
	// So `i"` stops before the closing quote, `a"` and any counted object take it.
	const inclusive = include || count > 1;
	return { start: from, end: close, inclusive, ok: true };
}

/**
 * Whether a multi-line charwise *delete* is linewise after all — the "strange
 * Vi behaviour" of ops.c:810-829, which is still vim's behaviour because
 * `'cpoptions'` has kept its `z` (CPO_WORD) since 7.4.
 *
 * All five conditions are load-bearing and each one is observable:
 *   - more than one line (`line_count > 1`), which vim counts from the end
 *     *position* rather than from the last character the range covers, so a
 *     non-inclusive end sitting at a line's first column still counts the line
 *     it is on;
 *   - nothing but blanks behind the object on its last line, so the deletion
 *     would leave that line empty (`skipwhite` reaching the NUL);
 *   - the object starts at or before the first non-blank of its own line
 *     (`inindent(0)`, which the cursor is inside: ops.c:4078 leaves it at
 *     `oap->start`);
 *   - a delete and not a change or a yank, so `c2iw` and `y2iw` keep the
 *     characterwise region and `p` pastes it back as text;
 *   - and no visual or block selection, which is what a text object never is.
 *
 * Dropping `z` from `'cpoptions'` in a real vim turns the promotion off, which
 * is how the gate was confirmed to be this rule and not the arithmetic below
 * it: `d2iw` on `"a\nb\nc"` leaves one line `c` by default and two lines
 * (`""`, `c`) with `set cpo-=z`.
 *
 * `endPos` is a position and `inclusive` says whether the character under it is
 * in the range, because ops.c:823-825 reads it that way: the end's own column
 * plus, when the end is not already the line's NUL, its inclusiveness.
 */
function deleteGoesLinewise(text: string, start: number, endPos: number, inclusive: boolean): boolean {
	if (lineOf(text, endPos) === lineOf(text, start)) return false;
	const rest = lineEndExclusive(text, endPos);
	let at = endPos < rest ? endPos + (inclusive ? 1 : 0) : endPos;
	while (at < rest && (text[at] === " " || text[at] === "\t")) at++;
	if (at < rest) return false;
	// `inindent(0)` counts the blanks in front of the start and asks whether the
	// cursor has not passed them.
	for (let i = lineStart(text, start); i < start; i++) {
		if (text[i] !== " " && text[i] !== "\t") return false;
	}
	return true;
}

/**
 * The first non-blank of the line containing `pos` — where `I` inserts, and
 * where a linewise paste leaves the caret.
 *
 * A line that is nothing but blanks has no first non-blank, and the honest
 * answer is the line's own end: in this engine that is the break, which is
 * exactly where `I` types on a line of blanks. Callers that need a *character*
 * there rather than a position are `motionBeginline` below.
 */
export function motionFirstNonBlank(text: string, pos: number): number {
	const start = lineStart(text, pos);
	const end = lineEndExclusive(text, pos);
	let i = start;
	while (i < end && (text[i] === " " || text[i] === "\t")) i++;
	return i;
}

/**
 * `motionFirstNonBlank`, but never past the last character of the line.
 *
 * This is vim's `beginline(BL_WHITE | BL_FIX)` — what every goto runs after
 * itself, `^` (`nv_beginline`) and `gg`/`G`/`+`/`-` (`nv_goto` and `nv_cmds.h:155`)
 * among them. `BL_FIX` is the flag that makes `beginline` stop at the end of a
 * blank-only line, and `check_cursor_col_win` (`misc2.c:560`) then steps the
 * column back onto the last character it has, so `"  "` puts the caret on its
 * second space and not on the break. An empty line has no character at all and
 * stands on its own break, which is the one position in a line this engine
 * allows and vim does not.
 *
 * The two differ, and measuring says so: on a blank-only line `I` types at the
 * end of the blanks while `-` lands on the last one.
 */
function motionBeginline(text: string, pos: number): number {
	const first = motionFirstNonBlank(text, pos);
	return first === lineEndExclusive(text, pos) ? lineLastChar(text, pos) : first;
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
const LINEWISE_MOTIONS = new Set(["gg", "G", "j", "k", "+", "-"]);

/** `d`, `c`, `y` — and `>`/`<`, whose doubled form shifts instead of editing. */
type Operator = "d" | "c" | "y" | ">" | "<";

/**
 * A cap on `[count]`. Vim's own limit is 2^31, which on a 60fps terminal means
 * a count long enough to freeze the event loop before the next frame — and a
 * frozen single-threaded REPL cannot even process the Ctrl+C that would stop
 * it. Nobody types four digits on purpose.
 */
const MAX_COUNT = 10000;

/**
 * One change, kept so `.` can make it again.
 *
 * `keys` is the command as it was typed with the count off the front, `text` the
 * insert-mode typing that followed it, and `geometry` the shape of a Visual
 * selection when one was operated on. Vim keeps the same three things in three
 * places: a key string (`prep_redo_cmd`, `normal.c:1461`), the typed text in the
 * redo buffer's own insert half, and `redo_VIsual` (`ops.c:3890`) for the size
 * of a Visual area. The size is not the motions that made it — measured on vim
 * 9.1, `v$d` then `.` takes the line break with it on a shorter line, where
 * re-typing `v$d` there does not — so it is kept as its own field.
 */
interface RedoEntry {
	keys: string[];
	count: number;
	text: string;
	geometry: RedoGeometry | null;
}

/**
 * A Visual selection's shape: how many lines it touched, and where its end stood
 * in two forms, because `ops.c:4136` picks between them — a selection on one line
 * is re-taken by its **width** (columns, from wherever the caret now is) and one
 * over several by the end's **column** on its own line (the start of the line
 * below it is not a column the redo could use). Both are measured from the
 * selection's own start, which is not where the redo starts from.
 *
 * `toLineEnd` is the third form, and it is not a shape at all: it is vim's
 * `w_curswant == MAXCOL`, checked *before* the two above, so a selection that
 * ended on `$` or `<End>` is re-taken to the end of whatever line the caret is on
 * now. It is wanted-column state rather than selection state, which is the only
 * thing that tells it from {@link #visualPastEnd}: after `v$h` the selection still
 * reaches past the line's last character, but the `h` moved the caret and dropped
 * the MAXCOL, and the redo takes the width instead (measured: `v$hd` then `.`
 * takes four columns where `v$d` then `.` takes the rest of the line).
 */
interface RedoGeometry {
	linewise: boolean;
	lines: number;
	/** Columns the selection covers, for a selection on one line. */
	width: number;
	/** The end's column on the line it ended on, for one over several. */
	endCol: number;
	toLineEnd: boolean;
}

/**
 * The count off the front of a recorded key string, and the keys without it. The
 * count is the one part of a command a new one *replaces*: `3x` then `2.` deletes
 * two characters, not six (measured on vim 9.1).
 */
function splitCount(keys: string[]): { count: number; keys: string[] } {
	let digits = 0;
	while (digits < keys.length && keys[digits] >= "0" && keys[digits] <= "9") digits++;
	if (digits === 0) return { count: 1, keys };
	return { count: Math.min(Number(keys.slice(0, digits).join("")), MAX_COUNT), keys: keys.slice(digits) };
}

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
	/**
	 * `d` `i` — the operator is chosen and the *text object* is the second half,
	 * which is a key of its own (`diw`, `ci(`, `yap`). It is a latch rather than a
	 * branch because the key after `i` names the object and must not also be read
	 * as a command: `diwg` deletes a word and then types `g`, where a latch that
	 * fell through would have deleted to the next `g`.
	 */
	#pendingObject: { operator: Operator; count: number; include: boolean; explicit: boolean } | null = null;
	/** Visual mode has one `g` command (`gJ`), so it needs its own latch. */
	#visualPendingG = false;
	/**
	 * Visual `r` takes the character to write over the selection with, and the latch
	 * has to be its own: `#pendingChar` is read in NORMAL only, so a `r` typed with
	 * a selection open left the next key to be read as a command of its own — and the
	 * commands that follow a `r` are the ones that throw the buffer away (`vrX` ran
	 * the linewise `X` and `vrd` deleted the selection).
	 */
	#visualPendingR = false;
	/**
	 * `m`, `"`, `'` and `` ` `` take one more key. Marks and named registers are out
	 * of scope (see the header), so that key is read and dropped — read, because a
	 * dropped prefix leaves the keys after it to be read as commands again: `ma`
	 * meant "swallow `m`, then append", and `"ayy` typed "ayy" into the prompt.
	 */
	#prefixPending = false;
	/**
	 * `:` opens vim's ex command line, which this engine does not have. The keys go
	 * there and are dropped, until Enter (which still submits) or Escape (which
	 * cancels the line): `:s/x/` used to delete a character and type the rest.
	 *
	 * `/` and `?` have their own latch, {@link #search}, because their line does
	 * something on Enter rather than nothing.
	 */
	#inputPending = false;
	/**
	 * The `/` or `?` line being typed: which way it searches, the count that came
	 * before the separator (`2/pat` is the second match), and the pattern so far.
	 *
	 * A latch of its own rather than a mode on {@link #inputPending}, because the
	 * two lines end differently — one of them runs a search and the other is
	 * dropped — and because this one has to accumulate a string, which no other
	 * latch here does.
	 */
	#search: { forward: boolean; count: number; line: string } | null = null;
	/**
	 * The last search, for `n` and `N` and for a `/` line left empty.
	 *
	 * Written whether or not the search found anything, and whether or not the
	 * pattern even compiled, which is the whole reason it is a field and not a
	 * derived value: after `/a<CR>/zzz<CR>` the caret stands where `/a` left it and
	 * `n` finds nothing, and after `/a<CR>/(<CR>` `n` finds nothing either, because
	 * the broken pattern is the one that replaced the working one (both measured on
	 * vim 9.1). Recording only the searches that worked would make `n` resume `a`
	 * in the first case; keeping the text rather than a compiled expression is what
	 * makes the second one fall out, since `n` recompiles, the compile fails, and
	 * nothing moves.
	 *
	 * The word search is a kind of its own rather than a `\<word\>` pattern, for
	 * the reason the header gives: `\<` is a JavaScript `\b`, which knows nothing
	 * of CJK, so the pattern vim uses here would find nothing where vim finds the
	 * next `中文`.
	 */
	#lastSearch: LastSearch | null = null;
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

	/**
	 * The keys of the command being typed, and whether it has changed the buffer
	 * yet. A command opens the log on its first key and closes it when it is
	 * finished — the key that runs it, or the Escape that leaves the insert mode it
	 * entered — and what is kept is the *change*, not the command: a yank, a
	 * motion, a search and a failed operator all close the log with nothing to
	 * promote, which is why `.` after `yy` repeats the change before it (measured
	 * on vim 9.1: `yyj.p` pastes what was yanked first).
	 */
	#keyLog: string[] | null = null;
	/** Whether the command in the log has written to the buffer. */
	#logDirty = false;
	/**
	 * The last change, as `.` repeats it. Every change replaces it and none of the
	 * commands that change no text do, so it is whatever the buffer last went
	 * through — including a change whose text came out the way it went in: on vim
	 * 9.1 a Visual `r` that writes the character already there (`vrx` over an `x`)
	 * is still the redo, and `.` writes it again somewhere else.
	 */
	#redo: RedoEntry | null = null;
	/** The insert-mode typing since the command entered insert, read at its Escape. */
	#typedText = "";
	/** Where that typing began: the caret `#enterInsert` handed the host. */
	#typedFrom: number | null = null;
	/** The text at that moment, so a change made by typing alone still counts. */
	#typedFromText = "";
	/** A Visual command's shape and the operator that ran it, held for the redo. */
	#pendingVisual: { op: string; geometry: RedoGeometry | null; more?: string[] } | null = null;
	/** Inside a `.` replay: nothing it does may become the redo that follows. */
	#replaying = false;
	/** Whether that replay wrote to the buffer, which is what updates its count. */
	#replayWrote = false;

	constructor(ops: VimOps) {
		this.mode = "normal";
		// `setAll` is where every structural change goes (the header says so, and all
		// eighteen call sites do), so wrapping it is what lets a command be recognised
		// as a *change* without each of them having to say so.
		this.#ops = {
			...ops,
			setAll: (text, cursor) => {
				if (this.#replaying) this.#replayWrote = true;
				else this.#logDirty = true;
				ops.setAll(text, cursor);
			},
		};
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
		if (!this.#replaying) {
			// The log is the command, and it opens on the first key of one. What is
			// typed in insert mode is not part of it: that text is recorded as itself
			// when the Escape arrives, the way vim keeps it in the redo buffer's insert
			// half rather than among the command keys — and the engine never sees it
			// anyway, because the host is the one inserting.
			if (this.#keyLog === null && this.mode !== "insert") this.#keyLog = [];
			if (this.#keyLog !== null && this.mode !== "insert") {
				const token = this.#logToken(input, key);
				if (token !== null) this.#keyLog.push(token);
			}
		}
		const consumed = this.#dispatchKey(input, key);
		this.#finishKeyLog();
		return consumed;
	}

	#dispatchKey(input: string, key: VimKey): boolean {
		if (this.mode === "insert") {
			if (key.escape) {
				// Leaving insert steps back onto the character just typed (vim), which
				// is also what keeps the NORMAL cursor on a character instead of one
				// past the end, where the next `x` would silently do nothing.
				const text = this.#ops.getText();
				const pos = this.#ops.getCursor();
				// The text typed since the command entered insert mode, read off the
				// buffer rather than accumulated: the host did the typing, and a <BS>
				// or a paste in the middle of it is a change this engine was never told
				// about. What stands between the caret and where that command put it is
				// what was inserted there, however it got typed.
				if (this.#typedFrom !== null) {
					this.#typedText = text.slice(this.#typedFrom, pos);
					if (text !== this.#typedFromText) this.#logDirty = true;
					this.#typedFrom = null;
				}
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
			this.#search = null;
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

		// vim's `/` and `?` line: it holds every key up to Enter or Escape, and Enter
		// is the one that runs the search.
		if (this.#search !== null) {
			if (key.escape) {
				this.#search = null;
				return true;
			}
			if (key.return) {
				const pending = this.#search;
				this.#search = null;
				this.#runSearchLine(pending);
				return true; // Enter is the search's, not the host's (see the header)
			}
			if (key.backspace) {
				// vim edits the pattern with <BS>, one character at a time — a code
				// point, so a surrogate pair or an accent goes as one.
				const line = this.#search.line;
				if (line !== "") this.#search.line = line.slice(0, prevChar(line, line.length));
				return true;
			}
			// Everything else belongs to the line. `<Del>` and the arrows land here
			// and change nothing, which is what they do on vim's command line: the
			// caret is at the end of the line as it is typed, so there is no
			// character after it to delete.
			if (this.#search.line.length < MAX_SEARCH_PATTERN) this.#search.line += input;
			return true;
		}

		// vim's `:` input line: it holds every key up to Enter or Escape.
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
			this.#onCharacter();
			return this.#handleVisual(input, key);
		}
		this.#onCharacter();
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
		this.#pendingObject = null;
		this.#visualPendingG = false;
		this.#visualPendingR = false;
		this.#prefixPending = false;
		this.#inputPending = false;
		this.#search = null;
		this.#countBuffer = "";
	}

	#clamp(pos: number): number {
		return Math.max(0, Math.min(pos, this.#ops.getText().length));
	}

	/**
	 * vim's `check_cursor_col_win` (`misc2.c:560`): in NORMAL — and in Visual
	 * with the default `'selection'` of `old` — the caret is on a character, and a
	 * column at or past the end of the line steps back onto the last one. Only
	 * Insert, Select and `'virtualedit'` are allowed to sit there.
	 *
	 * The host hands us that column freely (it is where a text field puts a caret,
	 * and it is where a paste at the end leaves it), and nothing downstream
	 * expects it: `x`, `r`, `d`, `c` and `*` all read a word or a character at the
	 * caret and would silently do nothing. The `w` motion already refuses to park
	 * there for the same reason (`snapToChar`); this is the one place the position
	 * can arrive from outside.
	 */
	#onCharacter(): void {
		const text = this.#ops.getText();
		if (this.#ops.getCursor() < text.length) return;
		// An empty buffer, or a trailing newline that opens an empty last line,
		// keeps the caret where it is: that position already is a real character
		// position, a line with no character of its own to stand on.
		this.#ops.setCursor(settleCursor(text, this.#ops.getCursor()));
		this.#wantHere();
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
			if (this.#pending || this.#pendingChar || this.#pendingG || this.#pendingObject || this.#countBuffer) {
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
			if (
				WORD_MOTIONS.has(input) ||
				["0", "^", "$", "|", "G", "j", "k", "h", "l", " ", "*", "#", "+", "-"].includes(input)
			) {
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
			// `i` and `a` name a text object, whose second half is a key of its own:
			// `diw`, `daw`, `d2iW`. Measured — an object character that is not one
			// (`diZ`) drops the whole operator and swallows itself, and the `d` after
			// it is armed again (`diZdw` deletes), so this cannot fall through to the
			// swallow below without re-arming anything. `w` and `W` are the only
			// objects named so far; the rest of the family gets its own latch here.
			if (input === "i" || input === "a") {
				this.#pending = null;
				this.#pendingObject = {
					operator,
					count: count * this.#takeCount(),
					include: input === "a",
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
				// `d/foo` deletes up to the next match. The operator would have to wait
				// for a pattern that has not been typed yet — a second latch open at
				// once — so it is dropped and the search runs on its own: the caret
				// moves, nothing is deleted. (The input that follows goes where vim's
				// command line is, not into the buffer: `d/foo` used to end in an `o`,
				// opening a line.)
				this.#resetPending();
				if (input === ":") this.#inputPending = true;
				// The count stays the operator's own: `2d/foo` is two deletions, not the
				// second match, and the deletion is not happening anyway.
				else this.#search = { forward: input === "/", count: 1, line: "" };
				return true;
			}
			// Unknown key under an operator: cancel and swallow (vim behavior).
			this.#resetPending();
			return true;
		}

		// 2b. Name the text object: `diw`, `ci(`, `yap`, `2daw`.
		if (this.#pendingObject) {
			const { operator, count, include } = this.#pendingObject;
			this.#pendingObject = null;
			this.#applyTextObject(operator, include, input, count);
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
					this.#ops.setCursor(motionBeginline(text, nthLineStart(text, Math.min(count, lineCount(text)) - 1)));
					this.#wantHere(); // beginline is a move: it discards a pending `$`
				}
			} else if (input === "J" && !operator) {
				// `gJ`: join without the space, and keep the next line's indent.
				this.#joinLines(count, true);
			} else if (input === "*" || input === "#") {
				// `g*` and `g#` are the same search as `*` and `#`, and `dg*` is the
				// same range as `d*` — `nv_ident` reads `cap->cmdchar == 'g'` only to
				// decide on the anchor and never asks whether an operator is waiting.
				//
				// The anchor is what the two spellings differ by, and it is redundant
				// either way: `if (!g_cmd && vim_iswordp(ptr))` adds a leading `\<` to
				// a pattern that is already the whole maximal run, and when the run
				// does not start with a word character — the punctuation `*` searches
				// for as itself — `*` gets no anchor either. Measured on 25 positions
				// over nine buffers, `g*` answered where `*` answered every time,
				// `foobar` at 1 and `foofoo` at 3 among them, which are the cases the
				// two spellings are documented to separate.
				if (operator) this.#applyOperator(operator, input, count, undefined, explicit);
				else this.#identCommand(input, count);
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
				this.#ops.setCursor(motionBeginline(this.#ops.getText(), this.#ops.getCursor()));
				// `beginline` is a move of its own, and it discards a pending wanted
				// column the way `0`, `gg` and `G` do: without this `^j` keeps the
				// column the caret had before the `^` and lands beside it.
				this.#wantHere();
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
				this.#ops.setCursor(motionBeginline(text, nthLineStart(text, line)));
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
			case "+":
			case "-":
				this.#beginlineDown(input === "+" ? count : -count);
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
				this.#startVisual("visual", count);
				return true;
			case "V":
				this.#startVisual("visual-line", count);
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
				// The search line, which Enter runs. A count in front of the separator is
				// the number of matches to step over rather than a repetition, and it
				// wraps: `2/a` on `a a a` at 0 lands on the `a` at 4, and `3/a` back on
				// the one at 0 (measured).
				this.#resetPending();
				this.#search = { forward: input === "/", count, line: "" };
				return true;
			case "n":
			case "N": {
				// vim has no message area to say E35 in, so with no last search `n` and
				// `N` are a no-op rather than an error the user can see.
				if (this.#lastSearch === null) return true;
				// `n` repeats in the direction the last search ran, `N` in the other
				// one, and neither of them changes which that was — a second `N` goes
				// the same way the first did.
				this.#runSearch(
					this.#lastSearch,
					input === "n" ? this.#lastSearch.forward : !this.#lastSearch.forward,
					count,
					this.#ops.getCursor(),
				);
				return true;
			}
			case "*":
			case "#": {
				this.#identCommand(input, count);
				return true;
			}
			case ":":
				// vim's ex command line opens here. This engine has none, so the input is
				// taken and dropped (see #inputPending).
				this.#resetPending();
				this.#inputPending = true;
				return true;
			case "u":
				// `3u` is three undos, as in vim — and an undo discards a pending
				// `$`: the restored caret is where the wanted column starts over.
				for (let i = 0; i < count; i++) this.#ops.undo();
				// The redo is left alone, which is what vim does too (measured:
				// `vrX` then `u` then `.` writes the `X` over the selection again,
				// and so does `x` then `u` then `.` — the entry is not re-pointed at
				// whichever of several undone changes this was, because the undo is
				// the host's and it does not say which).
				this.#forgetCurswant();
				return true;
			case ".":
				this.#runRedo(count, explicitCount);
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

	/**
	 * `+` and `-`: vim binds them to `nv_down` and `nv_up` (`nv_cmds.h:155`) and
	 * then `beginline(BL_WHITE | BL_FIX)`, so it is a line down — or up, or a count
	 * of them — followed by the first non-blank of the line landed on. `nv_down`
	 * refuses before touching anything when there is no line that way, which is why
	 * `+` on the last line leaves the caret on the last character rather than
	 * taking the line's first non-blank; a count that merely overshoots is a
	 * different thing and clamps, as `j` does.
	 *
	 * Not `#vertical`, which recalls history when the buffer holds no line break:
	 * `+` is not a history key in vim, and a single-line buffer here must not
	 * answer `+` with the user's earlier prompt.
	 */
	#beginlineDown(deltaLines: number): void {
		const text = this.#ops.getText();
		const from = lineOf(text, this.#ops.getCursor());
		const target = Math.max(0, Math.min(lineCount(text) - 1, from + deltaLines));
		if (target === from) return;
		this.#ops.setCursor(motionBeginline(text, nthLineStart(text, target)));
		this.#wantHere();
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

	/**
	 * Run the search a `/` or `?` line describes, and remember it.
	 *
	 * An empty pattern is not a search for nothing: vim repeats the last one, in the
	 * direction the *separator* names rather than the direction it ran in. Measured:
	 * `#` on the last `foo` of `foo a foo b foo` lands on the middle one, and `/<CR>`
	 * then goes forward to the one it came from; `?<CR>` instead goes back to the
	 * first. So the separator is the direction, and it is remembered — an `n` after
	 * `/<CR>` goes on forward from there, and an `N` goes back.
	 *
	 * With no last search to repeat, this moves nothing, which is all that can be
	 * done about vim's E35 here.
	 */
	#runSearchLine(line: { forward: boolean; count: number; line: string }): void {
		const parsed = parseSearchLine(line.line, line.forward ? "/" : "?");
		if (parsed.pattern === "") {
			if (this.#lastSearch === null) return;
			this.#lastSearch = { ...this.#lastSearch, forward: line.forward };
			this.#runSearch(this.#lastSearch, line.forward, line.count, this.#ops.getCursor());
			return;
		}
		const search = {
			kind: "pattern",
			pattern: parsed.pattern,
			forward: line.forward,
			toEnd: parsed.toEnd,
		} as const;
		// Written before the search runs and whether or not it finds anything: a
		// search that matched nothing is still the last search, and `n` has to fail
		// rather than fall back on the pattern that used to work.
		this.#lastSearch = search;
		this.#runSearch(search, line.forward, line.count, this.#ops.getCursor());
	}

	/**
	 * The search `*` or `#` runs from `from`, and where it starts, or `null` when
	 * there is no run under the caret to search for.
	 *
	 * One function for the command and the motion, because vim's is one: `nv_ident`
	 * builds the pattern and hands it to `normal_search` without asking whether an
	 * operator is pending, so `d*` searches exactly what `*` searches and the
	 * operator's range is the landing and the caret. Measured on `aa bb aa bb aa`,
	 * where the two directions part company: from 0, `*` lands on 6 and takes the
	 * first six characters, `#` lands on 12 and takes twelve.
	 *
	 * The last search is stored here, in both callers. vim stores it in both too —
	 * `add_to_history(HIST_SEARCH, ...)` is above the point where the search runs,
	 * with no test of `op_pending` in between — which is what makes `n` after a
	 * `d*` search for the same word (measured: `y*` then `n` on `foo bar foo` lands
	 * on the 8).
	 */
	/**
	 * The bare `*`/`#` command, and the `g*`/`g#` spellings with it.
	 *
	 * Nothing to search for: vim says E348 and moves nothing, and with nothing to
	 * say it, moving nothing is the whole of it — measured on the trailing comma of
	 * `foo,`, and on a line whose rest is blank with a word on the next one.
	 */
	#identCommand(input: string, count: number): void {
		const id = this.#identSearch(input === "*", this.#ops.getCursor());
		if (id === null) return;
		// From the run's own first character rather than the caret, which is
		// `nv_ident`'s `curwin->w_cursor.col = ptr - ml_get_curline()` and the reason
		// `*` on the space at 7 of `foo bar foo` comes back round to the `foo` at 0
		// instead of stopping on the one at 8 the caret is a character from.
		this.#runSearch(id.search, input === "*", count, id.from);
	}

	#identSearch(forward: boolean, from: number): { search: LastSearch; from: number } | null {
		const run = wordRunAt(this.#ops.getText(), from);
		if (run === null) return null;
		// A punctuation run is a pattern rather than a word, so it is escaped the way
		// vim escapes it and searched for as written rather than against a run of its
		// own length. `#` escapes the other way round, which is `nv_ident`'s
		// `"/?.*~[^$\\"`.
		const search: LastSearch = run.anchored
			? { kind: "word", word: run.word, forward }
			: { kind: "text", text: escapeStarWord(run.word, !forward), forward };
		this.#lastSearch = search;
		return { search, from: run.start };
	}

	/**
	 * Where the `count`th match of `search` from `from` puts the caret, or `null`
	 * when it finds nothing.
	 *
	 * `from` is the caret for everything that came from typing a pattern, and the
	 * keyword's own first character for `*` and `#`. The offset moves the caret to
	 * the match's last character, and it is that position the search compares, in
	 * both directions — see {@link nthSearchMatch}, which is where the measurement
	 * is written down.
	 *
	 * Split out of {@link #runSearch} so a motion can ask the same question without
	 * moving anything, which is all an operator needs: `d*` is the bare `*`'s
	 * landing and the caret, as a range.
	 */
	#searchLanding(search: LastSearch, forward: boolean, count: number, from: number): number | null {
		const text = this.#ops.getText();
		let matches: SearchMatch[];
		if (search.kind === "word") {
			matches = collectWordRuns(text, search.word);
		} else {
			// A text search is already a pattern — `escapeStarWord` did the escaping — so
			// it goes through the same door, and a `*` on a run holding an unbalanced
			// `(` fails to compile and moves nothing here as it does in vim.
			const re = compileSearchPattern(search.kind === "text" ? search.text : search.pattern);
			// A pattern that does not compile and one that matches nothing are the same
			// thing here: there is no position to land on. vim says E54 and E486 for the
			// two, and there is nowhere here to say either.
			if (re === null) return null;
			matches = collectSearchMatches(text, re);
		}
		const toEnd = search.kind === "pattern" ? search.toEnd : false;
		const hit = nthSearchMatch(matches, from, forward, count, toEnd);
		return hit === null ? null : snapToChar(text, searchLanding(hit, toEnd));
	}

	/**
	 * Land on the `count`th match of `search` from `from`, or move nothing.
	 *
	 * A search that found nothing is a failed motion: the wanted column is left
	 * alone, so a `$j/fz j` still comes back to the end of the line.
	 */
	#runSearch(search: LastSearch, forward: boolean, count: number, from: number): void {
		const landing = this.#searchLanding(search, forward, count, from);
		if (landing === null) return;
		this.#ops.setCursor(landing);
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
		// …and vim refuses the command outright when the line has fewer than the count
		// asks for, rather than replacing the ones that are there (normal.c:4900-4906,
		// "Abort if not enough characters to replace"; the byte count is the first
		// half of that test and the character count the second, so the characters are
		// what is counted here — a line of two hanzi is two characters however wide
		// each one is). Measured on 9.1: `3r+` on the last character of `"abc"`
		// changes nothing, where clamping writes one `+`.
		let available = 0;
		for (let p = pos; p < lineEnd; p = nextChar(text, p)) available++;
		if (available < count) return;
		let end = pos;
		for (let i = 0; i < count; i++) end = nextChar(text, end);
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
		// An empty register pastes nothing — unless it is linewise, where an empty
		// *line* is a thing worth pasting. `yip` on an empty buffer yanks one empty
		// line and `ggP` pastes it as a line break, while an empty characterwise
		// register (`y$` on an empty line) pastes no characters at all.
		if (!this.#register.text && !this.#register.linewise) return;
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
			this.#ops.setAll(out, motionBeginline(out, anchor));
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
		// `.`-style follow-ups and a second `p` land where the eye expects. A
		// register with a line break in it is the exception: it is pasted as more
		// than one line, and vim leaves the caret on the *first* of them — `vjyp`
		// on "ab\ncd" lands at 4, where the paste began, and not on the last
		// character of the second (measured on vim 9.1).
		const pastedEnd = insertAt + this.#register.text.length * count;
		const landing = this.#register.text.includes("\n") ? insertAt : Math.max(insertAt, pastedEnd - 1);
		this.#ops.setAll(out, snapToChar(out, landing));
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
		// The command that got here is not finished — it is finished when the Escape
		// arrives, and what was typed in between is part of what `.` has to repeat.
		// Both are read off the buffer at that point, so nothing has to be told.
		this.#typedFrom = this.#ops.getCursor();
		this.#typedFromText = this.#ops.getText();
		this.#typedText = "";
		this.#ops.enterInsert();
	}

	// -- operators ------------------------------------------------------------

	/**
	 * Run the operator over a text object rather than a motion: the second half of
	 * `diw` / `daw` / `d2iW`, and the first of the daily three the plan file names.
	 * Only the word objects are wired up — `wordObject` is the whole implementation,
	 * and the `object` key is checked rather than switched on, so a key that names
	 * none spends the operator instead of falling through to a motion.
	 *
	 * A character that names no object drops the operator and changes nothing, and
	 * so does a walk that gives up — but the two leave the caret in different
	 * places, and that is the difference between them. The first never calls
	 * `current_word`, so the caret stays where it was; the second has already walked
	 * it (`y4iw` on the second line of `"aa bb\ncc dd"` reads back on the buffer's
	 * last character, where the walk stopped).
	 */
	#applyTextObject(operator: Operator, include: boolean, object: string, count: number): void {
		const text = this.#ops.getText();
		const at = this.#ops.getCursor();
		if (object === "p") {
			// A paragraph is linewise from the moment it is found, so it goes to
			// `#runLinewise` and never sees `#runOperator` or `deleteGoesLinewise`.
			// A FAIL leaves the caret exactly where it was: vim's `clearopbeep`
			// drops the operator and rings the bell, it does not walk anywhere.
			const span = paragraphObject(text, at, count, include);
			if (!span) {
				this.#wantHere();
				return;
			}
			if (operator === ">" || operator === "<") {
				this.#shiftLines(span.lastLine - span.firstLine + 1, operator === ">", 1, nthLineStart(text, span.firstLine));
				return;
			}
			const { start, end, removeFrom } = lineRange(text, span.firstLine, span.lastLine);
			this.#runLinewise(operator, start, end, removeFrom);
			// A linewise *yank* through a text object parks the caret on the object's
			// first line, in column 0. That is the object's own doing, not a linewise
			// rule: `current_par` writes `oap->start = {start_lnum, 0}` (the column
			// with it), and the yank restores the caret there. `yy` leaves
			// `oap->start.col` alone, so `yy` on the same line does not move — which
			// is why this cannot live in `#runLinewise` and is the reason the two
			// look like they should agree.
			if (operator === "y") this.#ops.setCursor(nthLineStart(text, span.firstLine));
			this.#wantHere();
			return;
		}
		// `i"` `a"` `i'` `a'` `` i` `` `` a` `` are one arm of `nv_object` over three
		// characters (normal.c:7274-7279), and they are reached before the register
		// name would be: `d"a…` reads a register, but the `i` has already put the
		// object latch up by the time a `"` arrives after it.
		if (object === '"' || object === "'" || object === "`") {
			const quote = quoteObject(text, at, count, include, object);
			if (!quote.ok) {
				// No string is a FAIL: the operator is dropped, the text is untouched
				// and the caret does not walk, which is what `clearopbeep` leaves
				// behind (normal.c:7291-7292). A quote with no mate on its own line
				// is the case that gets here most, since the object cannot cross a
				// line break.
				this.#wantHere();
				return;
			}
			if (operator === ">" || operator === "<") {
				// A quote object is one line of text by construction — `current_quote`
				// only ever saw `ml_get_curline()` — so the span is that line whatever
				// the range is, and an empty pair shifts the line it stands on rather
				// than the one before it.
				this.#shiftLines(1, operator === ">", 1, nthLineStart(text, lineOf(text, quote.start)));
				return;
			}
			// A pair with nothing between the quotes is a range of no width, which
			// ops.c:4275-4282 reads as `oap->empty` — the same thing the bracket
			// object above reports, reached here by a zero-width range instead of by
			// `current_block` saying so. `di"` on `""` changes no text, `ci"` enters
			// insert at the position the text would have begun, and `yi"` replaces the
			// register with an empty one for the reason spelled out there.
			if (quote.start === quote.end && !quote.inclusive) {
				this.#emptyObject(operator, quote.start);
				return;
			}
			this.#runOperator(operator, quote.start, quote.end + (quote.inclusive ? 1 : 0), quote.inclusive);
			return;
		}
		const pair = BLOCK_PAIRS[object];
		if (pair) {
			const block = blockObject(text, at, count, include, pair);
			if (!block) {
				// No block is a FAIL, the same as a paragraph that runs off the end:
				// the operator is already spent and the caret does not walk anywhere.
				this.#wantHere();
				return;
			}
			if (operator === ">" || operator === "<") {
				// A shift takes the lines the object's own text is on, and `>i(` is
				// the daily use of it. The object starts wherever `incl` put it, which
				// is the line *after* the one holding the bracket: `>i(` on `f(\n  a\n)`
				// indents the `  a` and leaves the `f(` line alone, while `>i(` on
				// `f(a\n  b\n)` takes both lines because the object starts on the `f(`
				// one. A linewise object already knows which lines it is.
				// An object with nothing in it is still a one-line range for `>` and
				// `<`: the operator sees `start == end` and `line_count == 1`, so
				// `op_shift` indents the line the start is on. `>i(` on `())` puts a
				// tab in front of the `(` that holds the empty pair.
				if (block.empty) {
					this.#shiftLines(1, operator === ">", 1, nthLineStart(text, lineOf(text, block.start)));
					return;
				}
				const firstLine = block.linewise ? block.firstLine : lineOf(text, block.start);
				const lastLine = block.linewise ? block.lastLine : lineOf(text, Math.max(block.start, block.end - 1));
				this.#shiftLines(lastLine - firstLine + 1, operator === ">", 1, nthLineStart(text, firstLine));
				return;
			}
			// A pair with nothing left inside it is not a FAIL. `decl` walks the end
			// back behind the start, `current_block` notices and hands back an empty
			// range *and* moves the caret (textobject.c:1200-1203) to `start_pos` —
			// where the text would have begun, which for `a(\n)` is the closing
			// bracket. `di(` there changes no text and `ci(` still enters insert.
			if (block.empty) {
				this.#emptyObject(operator, block.start);
				return;
			}
			// A linewise object goes through the line machinery whole, and the
			// register it leaves is linewise too — `yi(` on `f(\n  a\n)` pastes the
			// `  a` back as a line, not as text.
			if (block.linewise) {
				const { start, end, removeFrom } = lineRange(text, block.firstLine, block.lastLine);
				this.#runLinewise(operator, start, end, removeFrom);
				if (operator === "y") this.#ops.setCursor(nthLineStart(text, block.firstLine));
				return;
			}
			// ops.c:810-829, the other linewise promotion, and unlike the one above
			// it is a delete's alone: a multi-line characterwise range whose tail is
			// nothing but blanks and which began in its own line's indent is deleted
			// as lines. `ci(` and `yi(` on the same shape keep the span.
			const endPos = block.end - (block.inclusive ? 1 : 0);
			if (operator === "d" && deleteGoesLinewise(text, block.start, endPos, block.inclusive)) {
				const { start, end, removeFrom } = lineRange(text, lineOf(text, block.start), lineOf(text, endPos));
				this.#runLinewise(operator, start, end, removeFrom);
				return;
			}
			this.#runOperator(operator, block.start, block.end, block.inclusive);
			return;
		}
		if (object !== "w" && object !== "W") return;
		const found = wordObject(text, at, count, include, object === "W");
		if (!found.ok) {
			// A walk that gave up leaves the caret where it stopped, which is often
			// one past the end of the line or of the buffer. Vim's own readback of a
			// caret there clamps it back onto a character, and `settleCursor` is this
			// engine's name for that.
			this.#ops.setCursor(settleCursor(text, found.landing));
			this.#wantHere();
			return;
		}
		if (operator === ">" || operator === "<") {
			// A text object is a motion `>` and `<` take as much as `d` and `c` do
			// (measured: `>iw` on "one two" indents it, `>2iw` on "a\nb\nc" indents
			// the first two lines and not the third). What they shift is the linewise
			// span the object lands on, which is the same span `#shiftByMotion` works
			// out from a motion's two ends — here they are already known.
			const firstLine = lineOf(text, found.start);
			const lastLine = lineOf(text, Math.max(found.start, found.end - 1));
			this.#shiftLines(lastLine - firstLine + 1, operator === ">", 1, nthLineStart(text, firstLine));
			return;
		}
		if (operator === "d" && deleteGoesLinewise(text, found.start, found.end - 1, true)) {
			// Linewise, which also makes the register linewise — `d2iwp` pastes two
			// lines back, not the two characters the object held.
			const { start, end, removeFrom } = lineRange(
				text,
				lineOf(text, found.start),
				lineOf(text, Math.max(found.start, found.end - 1)),
			);
			this.#runLinewise(operator, start, end, removeFrom);
			return;
		}
		this.#runOperator(operator, found.start, found.end, true);
	}

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
			landing = motionBeginline(text, nthLineStart(text, firstLine));
		} else if (motion === "G") {
			lastLine = targetLine === -1 ? lineCount(text) - 1 : targetLine;
			landing = motionBeginline(text, nthLineStart(text, lastLine));
		} else {
			const delta = motion === "j" || motion === "+" ? count : -count;
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
			// `+`/`-` are the same move with `beginline` after it (nv_cmds.h:155),
			// so they land on the first non-blank of the line they reach.
			landing =
				motion === "+" || motion === "-"
					? motionBeginline(text, nthLineStart(text, target))
					: this.#columnOn(target, this.#wantColumn());
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

		// `d*`/`y*` and `d#`/`y#` are the bare command's own search, used as a range
		// between where it lands and the caret — see {@link #identSearch}, which
		// carries the measurement. The range is open at the far end in both
		// directions, so `d*` from 0 on `aa bb aa bb aa` takes `aa bb ` and leaves the
		// caret on the 0, and `d#` from 0 takes the twelve characters up to the 12.
		// No run under the caret is E348, which is no range at all.
		if (motion === "*" || motion === "#") {
			const id = this.#identSearch(motion === "*", from);
			if (id === null) return null;
			const target = this.#searchLanding(id.search, motion === "*", count, id.from);
			if (target === null) return null;
			return { start: Math.min(from, target), end: Math.max(from, target), inclusive: false };
		}

		let target = from;
		let inclusive = false;
		switch (motion) {
			case "w":
			case "W":
				// `dw` stops at the end of the line: it deletes words, and a newline
				// is line structure. `de`/`d$` keep their own rules; the plain `w`
				// motion still crosses lines, as vim's does.
				//
				// The line end binds the *last* repetition and no other. `fwd_word`'s
				// third argument is `eol`, and every caller under an operator passes
				// `oap->op_type != OP_NOP` (normal.c:6707) — which stops the walk at the
				// end of the line it is on, on the final step, when the move would
				// otherwise leave that line. The steps before it have no such limit,
				// so `d3w` from the first word of `aa bb\ncc dd` reaches the `d` of
				// `dd` and a clamp applied to every step would never leave line one.
				for (let i = 0; i < count; i++) {
					const next = motionForwardWord(text, target, motion === "W");
					target = i === count - 1 ? Math.min(next, lineEndExclusive(text, target)) : next;
				}
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
				target = motionBeginline(text, from);
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

	/**
	 * `oap->empty` (ops.c:4275-4282): a range with no characters in it, which two
	 * of the three text objects can reach. `current_block` reports it for a pair
	 * with nothing between the brackets, and a quote object gets there by being
	 * zero-width — `di"` on `""` steps past the opening quote and lands on the
	 * closing one, which is where the text would have begun.
	 *
	 * It is not a FAIL: the operator has been spent and the caret moves to where
	 * the text would have started, `d` changes nothing and `c` enters insert.
	 *
	 * A yank of nothing is still a yank. `oap->empty` is read by `op_delete`, which
	 * returns on it (ops.c:790), and by `op_change`, which walks past it into
	 * insert; `OP_YANK` bails only on `empty_region_error`, which is 'E' in
	 * 'cpoptions' (ops.c:4285, :4372), and this engine has no 'cpo' to be
	 * Vi-compatible about. So the register is replaced by an empty one, and what
	 * that is worth is the *next* command: a `p` pastes nothing, where a yank that
	 * skipped the write would paste whatever was there before. The linewise
	 * promotion does not reach it — it needs `yanklines > 1` (register.c:1380) and
	 * an empty object is one line, so the register is a characterwise one holding
	 * no characters rather than a linewise one holding a break.
	 */
	#emptyObject(operator: Operator, at: number): void {
		this.#ops.setCursor(at);
		if (operator === "c") {
			this.#enterInsert();
			return;
		}
		if (operator === "y") this.#register = { text: "", linewise: false };
		this.#wantHere();
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
		//
		// "Nothing but this line" is not the same as `out === ""`. When the range ran
		// to the end of the buffer, `lineRange` reaches back over the break *before*
		// the first removed line, so a buffer whose first line was empty loses it too
		// and leaves `out === ""` with `start > 0`. Vim keeps that empty line and
		// opens the new one below it: `cc` on the "a" of "\na" is "\nX", not "X".
		if (operator === "c" && (out !== "" || start > 0)) {
			out = `${out.slice(0, removeFrom)}\n${out.slice(removeFrom)}`;
		}
		// The insert caret stands on that empty line: its newline, or the buffer end
		// when nothing follows it.
		const insertCaret = Math.min(out.length, out.length > removeFrom + 1 ? removeFrom : removeFrom + 1);
		// A change always writes, even when the text it assembles is byte for byte
		// the text it was given: replacing a line that held nothing with an empty
		// line changes no characters and still has to leave the caret standing
		// where the typing goes, which is `ci(` on `f(\n\n)`.
		if (out !== text || operator === "c") {
			this.#ops.setAll(out, operator === "c" ? insertCaret : linewiseLanding(out, removeFrom));
		}
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

	// -- redo -----------------------------------------------------------------

	/**
	 * Close the command in the log and keep it, if it was a change.
	 *
	 * A command is finished when nothing is waiting for another key and the engine
	 * is not sitting in insert mode with the user typing into it — which is the
	 * whole test, and it is why this runs after *every* key rather than at the end
	 * of the commands that change something: `i` is not finished on the `i`.
	 */
	#finishKeyLog(): void {
		if (this.#replaying) {
			this.#clearKeyLog();
			return;
		}
		const log = this.#keyLog;
		if (log === null) return;
		if (
			this.mode === "insert" ||
			this.#pending !== null ||
			this.#pendingChar !== null ||
			this.#pendingG !== null ||
			this.#pendingObject !== null ||
			this.#visualPendingG ||
			this.#visualPendingR ||
			this.#prefixPending ||
			this.#inputPending ||
			this.#search !== null ||
			this.#countBuffer !== ""
		) {
			return; // half-typed: the log stays open for the keys still to come
		}
		this.#keyLog = null;
		const visual = this.#pendingVisual;
		// A yank changes no text, so it is not a change and is not kept. Neither is
		// a motion, a search, or an operator that found nothing to take — the redo
		// is whatever changed the buffer last, and a command that changed nothing
		// leaves it alone (`xu.` redoes the `x`, not the `u`).
		if (!this.#logDirty) {
			this.#clearKeyLog();
			return;
		}
		// A Visual command is kept as its operator and the selection's size, never as
		// the motions that made that selection: see RedoGeometry for why. A `r` also
		// keeps the character it wrote, which is a key of the command and not text
		// anyone typed — the host types the text of a change, but the `r` reads its
		// character off the same key stream.
		if (visual !== null && visual.geometry !== null) {
			this.#redo = {
				keys: [visual.op, ...(visual.more ?? [])],
				count: 1,
				text: this.#typedText,
				geometry: visual.geometry,
			};
		} else {
			const { count, keys } = splitCount(log);
			this.#redo = { count, keys, text: this.#typedText, geometry: null };
		}
		this.#clearKeyLog();
	}

	#clearKeyLog(): void {
		this.#keyLog = null;
		this.#logDirty = false;
		this.#pendingVisual = null;
		this.#typedText = "";
		this.#typedFrom = null;
	}

	/**
	 * The key to record for this event, or null for a key that is not part of a
	 * command. The terminal keys are recorded as the vim command each one *is*
	 * (`<Del>` is `x`, `d<Left>` is `dh`), because a redo that dropped them would
	 * silently be a different command; a key the engine hands back to the host, or
	 * one that abandons the command it was part of, is not recorded at all.
	 */
	#logToken(input: string, key: VimKey): string | null {
		if (key.escape || key.ctrl || key.meta || key.tab || key.return) return null;
		if (key.backspace) return "h"; // in NORMAL and in visual, vim's <BS> is `h`
		if (key.delete) return "x";
		if (key.upArrow) return "k";
		if (key.downArrow) return "j";
		if (key.leftArrow) return "h";
		if (key.rightArrow) return "l";
		if (key.home) return "0";
		if (key.end) return "$";
		return input.length === 1 ? input : null;
	}

	/**
	 * Run the change `.` names, with `count` in front of it.
	 *
	 * `explicit` says the count was typed now, and then it is the redo's count
	 * rather than the one the command was recorded with: `3x` then `2.` deletes
	 * two characters, where the recorded count of three would make six.
	 */
	#runRedo(count: number, explicit: boolean): void {
		const entry = this.#redo;
		// Nothing has changed yet, so there is no change to repeat. A `.` pressed
		// while a selection is open is not here at all — it is a Visual-mode key,
		// and vim leaves the redo where it is (measured: `VrX` then `Gvl.` then `.`
		// writes nothing).
		if (entry === null) return;
		const use = explicit ? count : entry.count;
		this.#replaying = true;
		this.#replayWrote = false;
		try {
			if (entry.geometry !== null) this.#reselectForRedo(entry.geometry);
			for (const token of use > 1 ? [String(use), ...entry.keys] : entry.keys) {
				this.handleKey(token, {});
			}
			// A change command ends in insert mode, and the host is the one who types
			// there — so the text it recorded is put in here, by the engine, or the
			// replay would stop with the caret in the same empty spot the original
			// command opened.
			if (this.mode === "insert" && entry.text !== "") {
				const text = this.#ops.getText();
				const at = this.#ops.getCursor();
				this.#ops.setAll(text.slice(0, at) + entry.text + text.slice(at), at + entry.text.length);
			}
			if (this.mode === "insert") this.handleKey("", { escape: true });
		} finally {
			this.#replaying = false;
			// The redo keeps the count it just used, so a bare `.` after `3.` repeats
			// three: vim's redo buffer is the command with its count (`prep_redo`), and
			// `check_redo` only overwrites that count when one is typed (measured:
			// `x3..` on sixteen characters removes seven of them). A redo that changed
			// nothing is not a change, and a count nothing was repeated with is not
			// kept.
			if (this.#replayWrote) {
				this.#redo = { ...entry, count: use };
			}
			this.#replayWrote = false;
			this.#clearKeyLog();
		}
	}

	/**
	 * The size of the current selection, for the redo of a Visual command.
	 *
	 * The last character of the selection is the one the column is read off, and
	 * `end - 1` is it: `selection.end` is exclusive, and for a selection that took
	 * a line break with it the exclusive end is one past that break, which would
	 * read as a column on the *next* line.
	 */
	#selectionGeometry(): RedoGeometry | null {
		if (this.selection === null) return null;
		const text = this.#ops.getText();
		const { start, end } = this.selection;
		const first = lineOf(text, start);
		const lastChar = Math.max(start, end - 1);
		const last = lineOf(text, lastChar);
		// Read before the command runs: `ops.c:4130` reads `w_curswant` before the
		// operator has touched anything, and a Visual command's own moves are gone by
		// the time the next key arrives.
		//
		// The two conditions are vim's one condition. vim reads `w_curswant ==
		// MAXCOL` alone, but its `oneleft` moves the caret and clears the flag even
		// when the Visual reach is what absorbs the step, so `v$h` reaches the
		// operator with a plain column wanted. This engine spends the reach as "the
		// caret did not move" (see #moveVisualHorizontal), and #wantHereIfMoved leaves
		// the MAXCOL standing in that case — so the reach has to be cleared as well
		// to land on the same answer. Measured: `v$d` then `.` takes the rest of the
		// line, `v$hd` then `.` takes the width the selection had.
		const toLineEnd = this.#curswant === MAXCOL && this.#visualPastEnd;
		if (this.mode === "visual-line") {
			return { linewise: true, lines: last - first + 1, width: 0, endCol: 0, toLineEnd };
		}
		return {
			linewise: false,
			lines: last - first + 1,
			// The whole selection when it is on one line, and its last line's column
			// when it is not — see RedoGeometry.
			width: lastChar - start + 1,
			endCol: lastChar - lineStart(text, lastChar),
			toLineEnd,
		};
	}

	/**
	 * Put the selection back, at the same size, where the caret now is — vim's
	 * `redo_VIsual` (`ops.c:3997`), which is what a `.` after a Visual command
	 * redoes.
	 *
	 * The size is anchored on the caret and measured forwards, which is where the
	 * original selection is *not* always measured from: `vjd` then `.` takes two
	 * lines from wherever the caret is, and `v$` then `.` takes as many columns as
	 * `v$` did, which on a shorter line runs past its last character — and then
	 * vim's end lands on the line break, so the break goes with it (measured: `v$d`
	 * on "abcdef" then `.` on a three-character line removes "xyz\n").
	 */
	#reselectForRedo(geometry: RedoGeometry): void {
		const text = this.#ops.getText();
		const at = this.#ops.getCursor();
		// More lines than are below the caret: the span stops on the last line
		// (`ops.c:4002` clamps the line and keeps the width).
		const endLine = Math.min(lineOf(text, at) + geometry.lines - 1, lineCount(text) - 1);
		this.#anchor = at;
		// The end is computed as a position here, so the reach-past-the-line state
		// `$` leaves behind is not wanted: what that state would add is already in
		// the position.
		this.#visualPastEnd = false;
		if (geometry.linewise) {
			this.mode = "visual-line";
			this.#ops.setCursor(nthLineStart(text, endLine));
			this.#syncSelection();
			return;
		}
		const end = nthLineStart(text, endLine);
		// The end is placed the way the selection was measured: from the caret it is
		// being made at, by the width for one line and by the end's own column for
		// several — or at the end of the line the redo lands on, for a selection that
		// ended on MAXCOL, which is what `v$` arms and `v$h` drops.
		const startCol = at - lineStart(text, at);
		// One *past* the last character for the MAXCOL form, not on it:
		// `coladvance2` computes `idx = len - 1 + one_more` and `one_more` is
		// true whenever Visual mode is active (misc2.c:139-142), so in a Visual
		// command MAXCOL lands on the line's NUL. That is what makes the break go
		// with it: `do_pending_operator` moves an end that is on a NUL to the next
		// line's column 0 and counts it (ops.c:4218-4231). The `pastLine` branch
		// below is that rule.
		const endCol = geometry.toLineEnd
			? lineEndExclusive(text, end) - end
			: geometry.lines === 1
				? startCol + geometry.width - 1
				: startCol + geometry.endCol;
		const pastLine = endCol + 1 > lineEndExclusive(text, end) - end;
		this.mode = "visual";
		// The end offset is exclusive and `#syncSelection` reads a position, so the
		// caret goes on the last character the selection covers. Past the line it
		// goes on the break itself, which `#endpoint` reads as the break.
		const stop = pastLine
			? endLine < lineCount(text) - 1
				? nthLineStart(text, endLine + 1)
				: text.length
			: end + endCol + 1;
		this.#ops.setCursor(Math.max(at, stop - 1));
		this.#syncSelection();
	}

	/**
	 * Run a command that operates on the selection, keeping the selection's size for
	 * the redo. Every operator in {@link #handleVisual} goes through here, because
	 * the size has to be read *before* the command changes the buffer.
	 */
	#overSelection(op: string, run: () => void): void {
		this.#pendingVisual = { op, geometry: this.#selectionGeometry() };
		run();
	}

	// -- visual mode ----------------------------------------------------------

	#startVisual(mode: "visual" | "visual-line", count = 1): void {
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
		// A count in front of `v`/`V` is spent on the command itself, not handed to
		// the motion that follows: nv_visual decrements the count once and runs
		// nv_right / nv_down with what is left (normal.c:5609-5615), so `2v` selects
		// two characters and `2V` two lines. Measured: `2vld` and `2v3ld` on ten
		// characters take three and five, and `2Vjd` on six lines takes three lines.
		// A count of one moves nothing, which is why this is not a call with 0.
		if (count > 1) {
			if (mode === "visual") this.#moveVisualHorizontal(count - 1);
			else this.#moveVisualVertical(1, count - 1);
		}
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
		// `r` reads the character to write before the Escape below gets a look:
		// an Escape cancels the replacement and leaves the selection open, which is
		// vim's own answer (`vr<Esc>` changes nothing and stays in Visual).
		if (this.#visualPendingR) {
			this.#visualPendingR = false;
			// Only a key that *is* a character can be the one to write. vim reads it
			// with plain_vgetc and beeps without a change when it comes back as a
			// special key (an arrow, `<End>`, a function key), and Escape and the two
			// delete keys abandon the command outright. Taken as the character, an
			// empty one would write nothing over every character of the selection —
			// `vr<Right>` would delete it, measured against vim, which changes nothing.
			//
			// `<CR>` is the one key vim carries out here and this engine does not, and
			// the two modes do *different* things with it, so it is worth writing the
			// shape down rather than the summary. A Visual `r` goes to `nv_operator`
			// (normal.c:4866-4880), which writes the character over each selected one —
			// and a CR is a character there, a literal `\r` inside the line: `vlr<CR>`
			// on `"abcdef"` reads back as `"\r\rcdef"`. A NORMAL `r<CR>` does not go
			// through the operator at all; it deletes the characters and runs an insert
			// that breaks the line once (normal.c:4925-4939, "Strange vi behaviour: Only
			// one newline is inserted"), so it reads back as `"ab\ndef"` with the caret
			// at 3. Both are comparable — the harness reads the first back as a `\r`
			// and the second as a `\n` because that is what each of them *is* — and
			// neither is implemented. So this is a feature gap wearing a disagreement's
			// clothes, and it is named as one in the differential README's Known gaps
			// with the two measurements, rather than here as something the instrument
			// cannot judge.
			if (key.escape || key.backspace || key.delete || input.length === 0) return true;
			// The operator is recorded before the change runs, the way every other
			// visual operator's size is: what #finishKeyLog does with a `r` is the
			// other half of the answer, and it reads that field. The character typed
			// is the second key of the command, so it rides along — without it the
			// redo would be a `r` waiting for a character that never comes.
			this.#pendingVisual = { op: "r", geometry: this.#selectionGeometry(), more: [input] };
			this.#replaceSelection(input);
			return true;
		}
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
			if (input === "J") this.#overSelection("gJ", () => this.#joinSelection(true));
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
			this.#overSelection("d", () => this.#deleteSelection());
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
				this.#ops.setCursor(motionBeginline(text, this.#ops.getCursor()));
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
				this.#ops.setCursor(motionBeginline(text, nthLineStart(text, lineCount(text) - 1)));
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
				this.#overSelection("J", () => this.#joinSelection(false));
				return true;
			case ">":
			case "<":
				this.#overSelection(input, () => this.#shiftSelection(input === ">", count));
				return true;
			case "g":
				this.#visualPendingG = true;
				return true;
			case "r":
				// v_visop's replace: one character, written over the whole selection.
				// The character itself is the next key, and a count in front of the
				// `r` is not its own — `vl3rX` is `vlrX` (measured).
				this.#visualPendingR = true;
				return true;
			case "d":
			case "x":
				this.#overSelection("d", () => this.#deleteSelection());
				return true;
			case "y":
				this.#overSelection("y", () => this.#yankSelection());
				return true;
			case "c":
			case "s":
				this.#overSelection("c", () => this.#changeSelection());
				return true;
			// v_visop: an uppercase form is the same command over the *lines* the
			// selection touches — "Uppercase means linewise" — so `v2lD` removes the
			// whole first line where `v2ld` removes three characters. The size is
			// recorded after that, so the redo is a linewise one as well.
			case "C":
			case "S":
			case "D":
			case "X":
			case "Y":
				this.#forceLinewise();
				this.#overSelection(input === "Y" ? "y" : input === "C" || input === "S" ? "c" : "d", () => {
					if (input === "Y") this.#yankSelection();
					else if (input === "C" || input === "S") this.#changeSelection();
					else this.#deleteSelection();
				});
				return true;
			case "u":
				this.#overSelection("u", () => this.#caseSelection("lower"));
				return true;
			case "U":
				this.#overSelection("U", () => this.#caseSelection("upper"));
				return true;
			case "~":
				this.#overSelection("~", () => this.#caseSelection("toggle"));
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
		const text = this.#ops.getText();
		const from = this.#ops.getCursor();
		let steps = delta;
		if (delta < 0 && this.#reachArmed(from)) {
			steps = delta + 1; // the first step back is spent on the reach
			this.#visualPastEnd = false;
		}
		// The move runs first: `delta > 0 && …` would short-circuit a backward step
		// away entirely, and `h` inside a selection has to move like any other `h`.
		const blocked = steps === 0 ? false : this.#moveHorizontal(steps);
		if (delta > 0) {
			this.#visualPastEnd = blocked;
			// A step that ran off the end of the line still moves vim's column: inside
			// a selection `nv_right` counts the line break as a step and stops with the
			// caret one past the last character (normal.c:5822-5828, the `past_line`
			// branch). The engine cannot stand there and keeps the caret on the last
			// character with the reach armed in its place, so the wanted column is what
			// carries the step onward — without it a `j` after `vl` lands a line short
			// (`vljd` on six one-character lines takes two lines in vim and one here).
			// One step is all vim ever records past the end: `nv_right` breaks out of
			// its loop on the first failure, however large the count was.
			if (blocked) this.#curswant = from - lineStart(text, from) + (this.#ops.getCursor() - from) + 1;
		}
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

	/**
	 * Visual `r`: write one character over every character the selection covers.
	 *
	 * Measured on vim 9.1: the width does not change (a wide character becomes the
	 * replacement, it is not padded), a count in front of the `r` is not its own
	 * (`vl3rX` is `vlrX`), and a line break inside the selection stays a line break
	 * — `VrX` on `"ab"` is `"XX"` and not the `"XXXXXX"` that treating the selection
	 * as one flat run would give. So the replacement is per character and a `\n` is
	 * left alone, which also covers a charwise selection that took breaks with it
	 * (`vjrX` on four lines leaves them four lines).
	 *
	 * A paste token inside the selection keeps its spelling, the same rule `u`/`U`/
	 * `~` and normal-mode `r` use: a token's own letters are its format, and
	 * overwriting one makes the payload behind it unreachable at submit.
	 */
	#replaceSelection(char: string): void {
		if (!this.selection) return;
		const { start, end } = this.selection;
		const text = this.#ops.getText();
		const written = mapOutsidePasteTokens(text, start, end, (run) =>
			Array.from(run, (one) => (one === "\n" ? one : char)).join(""),
		);
		// The write is unconditional, even where it changes nothing: on vim 9.1 a
		// Visual `r` that writes the character already there is still the change
		// `.` repeats (`vrx` over an `x`, then `j`, then `.` writes an `x` over the
		// next line). The token rule above is what keeps a pasted payload intact,
		// and it needs no guard of its own: a selection that is one token writes the
		// token back unchanged and is a change all the same.
		this.#ops.setAll(text.slice(0, start) + written + text.slice(end), start);
		this.#exitVisual(start);
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
