/**
 * The regression list, measured against real vim.
 *
 * Every case here is a disagreement this repository's engine once had, or a
 * rule whose wrong answer looks like a plausible one: the wanted column across
 * `j`, operators materializing it, `gg`/`G` snapping to the first non-blank,
 * undo throwing it away, the column command, and the visual-line and change
 * forms on a last line that is shorter than the one above it.
 *
 * The cases are not expected values. Each run drives a real vim on this machine
 * and compares, so a case can only be green because the engine agrees with vim
 * today. A case that stops being green is a behaviour change to argue about,
 * not a test to update — which is the reason the list lives here rather than as
 * hand-written assertions in `vim-engine.test.ts`. Those still run under
 * `bun test`, and this does not: it needs a vim and takes a second per case.
 *
 *   bun run packages/tui/test/vim-differential/regress.mjs
 *
 * Exits 0 on a full match, 1 on any difference, 77 when there is no vim to
 * measure against.
 */
import { cleanup, compare, format, haveVim, skipBecause } from "./harness.mjs";

if (!haveVim()) skipBecause("no vim on PATH to measure against");

const A = "abcdef\ngh\nijkl";
const B = "abcdef\nghijklmno";
const C = "abcdef\nghz\nmnopqr";
const D = "a\nbc\ndef";
const E = "abcdef\nghijkl";
// Word motions outside ASCII. The Latin-1 ones are the `iskeyword` range
// (`dw` in `café` used to stop after three characters), and the CJK ones are the
// script classes `utf_class_buf` hands out above U+00FF: hanzi, hiragana and
// katakana are three words to vim, so a Japanese sentence stops at every
// transition between them. A run of hanzi has no transition in it, which is why
// Chinese was never wrong here and Japanese was.
const LATIN1 = "café Ünïcödé naïve wörd";
const SYMBOLS = "a×b ¡c ¿d µe";
const CJK_MIX = "かなカナ漢字";
const HIRAGANA_RUN = "日本語のテキスト";
const CHINESE = "你好世界 abc";
const CYRILLIC = "привет мир";
const COMBINING = "école x";
const HANGLUL = "한글 텍스트";
const EMOJI = "\u{1f44d}abc x";
// An emoji is asked for before the class table and outranks it, so a currency
// sign and a thumbs-up are two words to vim even though U+20AC and U+1F44D sit
// in the same punctuation interval. Without the separate table they are one run
// and `dw` takes both.
const CURRENCY = "€\u{1f44d} x";
// The three characters under 192 that `@` in `iskeyword` has an opinion about:
// `µ` has a case mapping and is a letter, `ª` and `º` have none and are
// punctuation, so `dw` stops between them.
const MICRO = "µ ª º x";
// A code point the class table does not list at all is a word character — the
// last line of `utf_class_buf`, and the one that makes `ß` and `λ` letters.
const UNLISTED = "ß ж λ x";
// A no-break space is blank to `w` and to `W` alike, because `cls()` asks
// `utf_class` first and only then collapses the non-blanks.
const NBSP = "a b c";
// The same word written the other way: `COMBINING` above is U+00E9 in one code
// point, and this is `e` followed by U+0301. Vim counts the mark as its own
// character, so a motion that treated it as punctuation would stop between the
// letter and its accent.
const DECOMPOSED = "école x";

const CASES = [
	// wanted column: MAXCOL and short lines
	[["$", "j"], A, 0],
	[["$", "j", "j"], A, 0],
	[["$", "j", "k"], A, 0],
	[["4", "l", "j"], A, 0],
	[["4", "l", "j", "j"], A, 0],
	[["4", "l", "j", "j", "k"], A, 0],
	[["4", "l", "k"], A, 8],
	[["$", "j", "l", "j"], A, 0],
	[["$", "j", "h", "j"], A, 0],
	[["$", "j", "x", "j"], A, 0],
	[["$", "j", "0", "j"], A, 0],
	[["$", "j", "0", "f", "z", "j"], C, 0],
	[["$", "j", "0", "f", "q", "j"], C, 0],
	[["f", "c", "j"], C, 0],
	[["t", "c", "j"], C, 0],
	// operators materialize the column
	[["$", "y", "G", "j"], A, 0],
	[["y", "G", "j"], A, 0],
	[["y", "g", "g", "j"], A, 8],
	[["y", "$", "j"], A, 0],
	[["d", "$", "j"], A, 0],
	[["$", "J", "j"], A, 0],
	[["$", "x", "j"], A, 0],
	// gg/G snap to the first non-blank
	[["G", "k"], A, 0],
	[["$", "G", "k"], A, 0],
	[["G", "j"], A, 0],
	[["4", "|", "g", "g", "j"], A, 0],
	[["y", "g", "g", "j"], A, 10],
	[["y", "G", "j"], A, 10],
	// undo throws the wanted column away
	[["x", "$", "u", "j"], E, 0],
	[["x", "u", "j"], E, 0],
	[["2", "|", "x", "u", "j"], E, 0],
	[["$", "u", "j"], E, 0],
	// the column command
	[["4", "|"], A, 0],
	[["2", "|", "j"], A, 0],
	[["2", "|", "j", "j"], A, 0],
	[["6", "|", "j"], A, 0],
	[["6", "|", "j", "j"], A, 0],
	[["8", "|"], A, 0],
	[["8", "|", "j"], A, 0],
	[["d", "4", "|"], A, 0],
	[["d", "4", "|"], A, 3],
	[["d", "|"], A, 3],
	[["d", "2", "|"], A, 5],
	[["2", "|", "d", "4", "|"], A, 0],
	[["d", "8", "|"], A, 0],
	[["4", "|", "d", "j"], A, 0],
	// a count on `$` is `cursor_down(count-1)`, which has two ways to say no and
	// reaches only one of them: the caret already on the last line is a refusal
	// that leaves the caret alone, while a count that merely runs past the end is
	// not one — the line clamps and the column still lands on the last line. The
	// engine read both as "nowhere to go" and clamped, which is the opposite of
	// what vim does with the first of them. The wanted column the refusal armed is
	// still armed, which is what the `k` here is reading.
	[["3", "$"], "ab\ncdef", 4],
	[["2", "$"], "ab\ncdef", 4],
	[["2", "$", "j"], "ab\ncdef", 4],
	[["2", "$", "k"], "ab\ncdef", 4],
	[["2", "$", "j", "k"], "ab\ncdef", 4],
	[["2", "$", "k", "j"], "ab\ncdef", 4],
	[["3", "$"], "ab\ncdef", 0],
	[["2", "$"], "ab\ncdef", 0],
	[["d", "2", "$"], "ab\ncdef", 4],
	[["d", "2", "$"], "ab\ncdef", 0],
	[["d", "2", "$"], "ab\ncdef\nghi", 0],
	[["d", "3", "$"], "abc\ndef\nghi", 0],
	// `k` on the first line is the same refusal as `j` on the last (`cursor_up`).
	// The column it skips is not reachable from there — MAXCOL is the only wanted
	// column that can disagree with the caret, and only a refused count arms it off
	// the end of a line — so this pins the caret, not the reasoning behind it.
	[["k"], "ab\ncdef", 1],
	[["j"], "ab\ncdef", 4],
	// `<End>` is `nv_dollar` in vim, count and all. The engine ran `$`'s movement
	// without `$`'s count, so `2<End>` stopped where a bare `$` stops.
	[["2", "\x1b[4~"], "ab\ncdef\nghi", 0],
	[["3", "\x1b[4~"], "ab\ncdef\nghi", 0],
	[["2", "\x1b[4~"], "ab\ncdef", 4],
	[["2", "\x1b[4~", "j"], "ab\ncdef", 0],
	// After an operator the terminal movement keys are the motions vim binds them
	// to — `d<End>` is `d$`, `d<Left>` is `dh`, `d<Down>` is the linewise `dj` — each
	// with the count. The engine took them as plain movements, and an empty `input`
	// is no motion at all to the character path an operator reads, so the operator
	// was dropped and the buffer left exactly as it was.
	[["d", "\x1b[4~"], "abcdef", 2],
	[["c", "\x1b[4~", "Z", "\x1b"], "abcdef", 2],
	[["d", "2", "\x1b[4~"], "ab\ncdef", 0],
	[["d", "2", "\x1b[4~"], "ab\ncdef\nghi", 0],
	[["2", "d", "\x1b[4~"], "ab\ncdef\nghi", 0],
	[["y", "\x1b[4~"], "abcdef", 2],
	[["d", "\x1b[C"], "abcdef", 2],
	[["2", "d", "\x1b[C"], "abcdef", 0],
	[["d", "2", "\x1b[C"], "ab\ncdef", 0],
	[["d", "\x1b[D"], "abcdef", 2],
	[["d", "\x1b[B"], "ab\ncd", 0],
	[["d", "\x1b[A"], "ab\ncd", 3],
	[["d", "\x1b[B"], "abcdef", 0], // `dj` with no line to step to
	[["d", "\x1b[A"], "abcdef", 0],
	[["y", "\x1b[C"], "abcdef", 2],
	[[">", "\x1b[B"], "ab\ncd", 0],
	[["2", ">", "\x1b[B"], "ab\ncd\nef", 0],
	// visual-line delete on the last line
	[["V", "d"], D, 5],
	[["V", "d"], D, 7],
	[["V", "d"], D, 6],
	[["V", "x"], "abc\nde", 4],
	[["V", "d", "j"], D, 5],
	// v/V toggle
	[["v", "j", "v"], A, 0],
	[["V", "j", "V"], A, 0],
	[["v", "V"], A, 0],
	[["V", "v"], A, 0],
	[["v", "v", "d"], A, 0],
	[["$", "v", "v", "j"], B, 0],
	[["2", "|", "v", "v", "j"], B, 0],
	[["$", "v", "\x1b", "j"], B, 0],
	[["$", "v", "j", "v", "j"], B, 0],
	// the linewise change
	[["V", "c", "x", "\x1b"], D, 2],
	[["V", "c", "x", "\x1b"], D, 0],
	[["V", "c", "x", "\x1b"], D, 5],
	[["V", "c", "x", "\x1b"], "a\nbc", 2],
	[["V", "c", "x", "\x1b"], "abc", 0],
	[["c", "c", "x", "\x1b"], D, 2],
	[["V", "c", "x", "\x1b", "j"], D, 2],
	[["V", "2", "j", "c", "x", "\x1b"], "a\nbc\ndef\ngh", 2],
	[["V", "c", "\x1b"], D, 2],
	[["V", "c", "\x1b", "j"], D, 2],
	[["v", "j", "c", "x", "\x1b"], D, 2],
	// the uppercase visual forms take whole lines
	[["v", "2", "l", "C", "x", "\x1b"], B, 0],
	[["v", "2", "l", "S", "x", "\x1b"], B, 0],
	[["v", "2", "l", "D"], B, 0],
	[["v", "2", "l", "X"], B, 0],
	[["v", "2", "l", "Y", "p"], B, 0],
	[["v", "2", "l", "x"], B, 0],
	[["v", "2", "l", "d"], B, 0],
	[["v", "2", "l", "y", "$", "p"], B, 0],
	[["y", "G", "j"], A, 4],
	[["y", "2", "j", "j"], A, 4],
	[["y", "2", "j"], A, 4],
	[["y", "G"], A, 4],
	[["y", "g", "g", "j"], A, 8],
	[["y", "y", "j"], A, 0],
	[["V", "d"], D, 2],

	// word motions outside ASCII
	[["d", "w"], LATIN1, 0],
	[["d", "w"], LATIN1, 5],
	[["d", "e"], LATIN1, 0],
	[["w"], LATIN1, 0],
	[["b"], LATIN1, 0],
	[["c", "w", "Z", "\x1b"], LATIN1, 0],
	[["d", "w"], SYMBOLS, 0],
	[["d", "w"], SYMBOLS, 2],
	[["d", "w"], CJK_MIX, 0],
	[["d", "w"], CJK_MIX, 2],
	[["d", "w"], HIRAGANA_RUN, 0],
	[["d", "w"], CHINESE, 0],
	[["d", "w"], CHINESE, 4],
	[["d", "e"], CHINESE, 0],
	[["d", "w"], CYRILLIC, 0],
	[["d", "w"], COMBINING, 0],
	[["d", "w"], HANGLUL, 0],
	[["d", "w"], EMOJI, 0],
	[["x"], EMOJI, 0],
	[["V", "d"], CHINESE, 0],
	[["y", "y", "p"], CJK_MIX, 0],
	[["d", "w"], CURRENCY, 0],
	[["d", "e"], CURRENCY, 0],
	[["d", "w"], MICRO, 0],
	// The next two only say anything because the pair is *adjacent*: a space
	// between them makes every one of them its own word whichever class they get,
	// so a case written with spaces cannot tell a letter from a symbol.
	[["d", "w"], "µª x", 0],
	[["d", "w"], "ªµ x", 0],
	[["d", "w"], "ßabc x", 0],
	[["d", "w"], "жabc x", 0],
	[["d", "w"], "€abc x", 0],
	[["d", "w"], UNLISTED, 0],
	[["d", "W"], NBSP, 0],
	[["W"], NBSP, 0],
	[["d", "w"], NBSP, 0],
	[["d", "w"], DECOMPOSED, 0],
	[["w"], DECOMPOSED, 0],
	[["d", "W"], CJK_MIX, 0],
	[["w"], CJK_MIX, 2],
	[["d", "e"], CJK_MIX, 2],
	[["b"], CJK_MIX, 4],
	[["d", "w"], "ab\ncd", 0],
	[["d", "b"], "ab\ncd", 3],
	// Not here: anything with the caret on the `\n` of `"ab\ncd"`. Vim has no
	// line-break character to put a caret on — `cursor(1, 3)` clamps onto the
	// last character of the line — so the two editors would be answering a
	// different question and a match would mean nothing. The engine does allow
	// that offset, and `vim-engine.test.ts` says what it does there.
	//
	// And not here: any buffer whose text *ends* in `\n`, for a larger version of
	// the same reason. Read as a file, `"ab\n"` is one line — the trailing break
	// terminates it and opens no line after it — while this engine's buffer is one
	// string in which the offset just past the break is a place the caret can
	// stand, on an empty last line. Every motion over such a buffer measures that
	// (`j`, `G`, `x`, `d$` and `yy` all reach a line the other editor does not
	// have), so a case here would be a record of the modelling difference and not
	// of the engine. `vim-engine.test.ts` pins the engine's own side of it.
];

let bad = 0;
for (const [kseq, text, cursor] of CASES) {
	const result = compare(text, cursor, kseq);
	if (!result.ok) bad++;
	console.log(format(text, cursor, kseq, result));
}
console.log(`${CASES.length - bad}/${CASES.length} match`);
cleanup();
process.exit(bad === 0 ? 0 : 1);
