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

// Search buffers. None of them ends in `\n`, for the reason the word-motion cases
// give: a trailing break is a line this engine has and vim does not.
const SPACED = "a a a";
const SIX_A = "a a a a a a";
const THREE_FOO = "foo foo foo";
const MIXED = "foo bar foo baz";
// Script changes, an emoji and a currency sign. What `*` treats as one word is a
// run of *one class*, so the three scripts in the first are three words and the
// two emoji in the second are one — while the euro signs in the third are
// punctuation and are stepped over.
const SCRIPTS = "かなカナ漢字";
const EMOJI_RUN = "👍👍 x";
const EMOJI_SPLIT = "👍👍 👍👍 x";
const EURO_RUN = "€€ €€ x";
const CJK_RUN = "中文 中文";
// Two runs of emoji and a word, where the first is *longer* than the second. A
// word search matches a run whole, so `*` on the short one finds nothing beside
// it; a search that only checked the first two emoji would find the long one.
const EMOJI_THREE = "👍👍👍 👍👍 x";
// A line whose rest is punctuation, which is the only way to reach vim's second
// pass: a word search becomes a pattern search there. The blank line in the
// second buffer is the other half — `*` does not look past the end of the line.
const DOTS = "a..";
const DOTS_AGAIN = "a.. a..";
const FOUR_DOTS = ".... ....";
const BLANK_LINE = "  \nfoo";
const TAIL_BLANKS = "foo  \nbar";
// One word three times, so a forward and a backward word search come back to
// different places, and one word twice, which is what `n` needs to walk on.
const THREE_AS = "aa bb aa bb aa";
const BAR_TWICE = "foo bar foo";
// A word glued to a longer one, and a caret inside one: the cases the two
// spellings are documented to separate, and the only place a `\<` could matter.
const GLUED = "foofoo foo";
const GLUED_INSIDE = "foobar foo";
// Four lines, none of them empty but one and all of them blank-prefixed except
// the last, so `+`/`-` are measured over an empty line, over a line with no
// first non-blank, and over a line they cannot move to at all.
const FOUR_LINES = "  aa\n\n  bb\ncc";
// The same two-line shape with tabs, because `beginline`'s first non-blank is
// the first character `cls()` calls a blank, and a tab is one.
const TABBED = "\taa\n\tbb";

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
	// Search. Every case here is a rule that has one plausible wrong answer:
	// whether a match at the caret counts, whether a count wraps once or round and
	// round, whether a search that matched nothing is still the last search, and
	// which way `*` looks for the keyword. `\r` is Enter — the key the search line
	// is waiting for, and the one the engine has to keep for itself.
	[["/", "a", "\r"], SPACED, 0],
	[["/", "abc", "\r"], "abcabc", 0],
	[["?", "ab", "\r"], "ab ab ab", 7],
	[["?", "a", "\r"], "a a a a", 0],
	[["?", "a", "\r", "n"], "a a a a", 0],
	[["?", "a", "\r", "N"], "a a a a", 0],
	[["/", "a", "\r", "?", "a", "\r", "n"], "a a a a", 0],
	[["/", "a", "\r", "?", "a", "\r", "N"], "a a a a", 0],
	[["?", "a", "\r", "/", "a", "\r", "n"], "a a a a", 6],
	[["?", "a", "\r", "/", "a", "\r", "N"], "a a a a", 6],
	// A count steps over matches and wraps with them, so the sequence 2, 0, 2 for
	// counts 2, 3, 4 on three matches is the whole of it.
	[["2", "/", "a", "\r"], SPACED, 0],
	[["3", "/", "a", "\r"], SPACED, 0],
	[["4", "/", "a", "\r"], SPACED, 0],
	[["2", "/", "a", "\r"], "a a\na a", 5],
	[["/", "a", "\r", "n"], SIX_A, 0],
	[["/", "a", "\r", "2", "n"], SIX_A, 0],
	[["/", "a", "\r", "2", "N"], SIX_A, 0],
	// A search that found nothing is still the last search, so `n` finds nothing
	// too rather than resuming the pattern that worked. A pattern that does not
	// compile replaces the last search the same way, which is what makes keeping
	// the text instead of a compiled expression the right shape for the field.
	[["/", "a", "\r", "/", "z", "z", "z", "\r", "n"], "a b a", 0],
	[["/", "a", "\r", "/", "(", "\r", "n"], "a b a", 0],
	[["/", "a", "\r", "/", "[", "\r", "n"], "a b a", 0],
	// Escape abandons the line and keeps the last search; an empty line and a
	// doubled separator are both that repeat.
	[["/", "a", "\r", "/", "b", "\x1b", "n"], "a b a b", 0],
	[["/", "a", "\r", "/", "\r"], "a b a b", 0],
	[["/", "a", "\r", "/", "/", "\r"], "a b a b", 0],
	[["/", "a", "\r", "/", "a", "/", "\r"], "a b a b", 0],
	[["/", "\r"], "a b a", 0],
	[["n"], "a b a", 0],
	// The offset is a letter after a separator and nothing else: `e` lands on the
	// last character of the match and comes back with `n`, `c` and `^` are the
	// default, and an `e` with no separator in front of it is part of the pattern.
	[["/", "a", "/", "e", "\r"], SPACED, 0],
	[["/", "a", "/", "e", "\r", "n"], SPACED, 0],
	[["/", "a", "/", "c", "\r"], SPACED, 0],
	[["/", "a", "/", "^", "\r"], SPACED, 0],
	[["?", "ab", "?", "e", "\r"], "abcabc", 5],
	[["/", "ae", "\r"], SPACED, 0],
	// An offset searches for the position it *lands* on, so a match longer than one
	// character is reached by its end and not by its start: `/ab/e` on `ab ab` at 0
	// answers the 1, the match the caret is already inside, because that match ends
	// past it. The four above it are all one character long, where the two readings
	// are the same offset and the rule above cannot be told apart from the wrong one.
	// Backward is the same comparison and not a special case of its own, which is
	// what the two wrap cases say: nothing behind the caret takes the far end.
	[["/", "a", "b", "/", "e", "\r"], "ab ab", 0],
	[["/", "a", "b", "/", "e", "\r"], "ab ab", 3],
	[["/", "a", "b", "/", "e", "\r", "n"], "ab ab ab", 0],
	[["?", "a", "b", "?", "e", "\r"], "abcabc", 3],
	[["?", "a", "b", "?", "e", "\r"], "abcabc", 1],
	[["?", "a", "?", "e", "\r"], "a a a a", 2],
	[["?", "a", "b", "?", "e", "\r", "n"], "ab ab ab", 5],
	// And the count is counted from there: the first landing past 1 is the 4, so two
	// from it is the 7. A third wraps, a second count multiplies into the fourth, and
	// the backward form is the same arithmetic.
	[["2", "/", "a", "b", "/", "e", "\r"], "ab ab ab", 1],
	[["3", "/", "a", "b", "/", "e", "\r"], "ab ab ab", 1],
	[["2", "/", "2", "a", "b", "/", "e", "\r"], "ab ab ab ab", 0],
	[["2", "?", "a", "b", "?", "e", "\r"], "ab ab ab ab", 6],
	// `^` and `$` are line anchors, which is the `m` flag and the reason for it.
	[["/", "^", "a", "\r"], "a b\na b", 2],
	[["/", "b", "$", "\r"], "a b\na b", 0],
	[["/", "b", "\r"], "a\nb", 0],
	// A pattern that can match nothing is still a pattern, and a search for one
	// steps a whole character rather than a code unit: `x*` matches empty beside
	// every character, and the first one *after* the caret on an astral character
	// is the one after both of its units.
	[["/", "x", "*", "\r"], EMOJI_THREE, 0],
	// `*` and `#` both look forward for the keyword and differ only in the
	// direction the search then runs, from the keyword's own first character.
	[["*"], THREE_FOO, 0],
	[["*"], THREE_FOO, 4],
	[["*"], THREE_FOO, 8],
	[["#"], THREE_FOO, 8],
	[["#"], THREE_FOO, 5],
	[["#"], THREE_FOO, 6],
	[["*", "n"], THREE_FOO, 0],
	[["*", "N"], THREE_FOO, 0],
	// `N` reverses the *next* match and nothing else, so the `n` after it goes
	// forward again. An `N` that wrote the direction back would answer the other
	// way here, which is the only case that can tell the two apart.
	[["*", "N", "n"], THREE_FOO, 0],
	[["#", "n"], THREE_FOO, 8],
	[["*", "/", "\r"], THREE_FOO, 0],
	[["#", "/", "\r"], "foo a foo b foo", 12],
	[["*", "/", "b", "a", "r", "\r", "n"], MIXED, 0],
	[["#", "/", "b", "a", "r", "\r", "n"], MIXED, 8],
	// On punctuation the keyword is the next run, for `#` as much as for `*`, and
	// with no run at or after the caret the caret does not move at all.
	[["*"], "foo, bar, baz", 3],
	[["#"], "foo, bar, baz", 3],
	[["*"], "foo, bar, baz", 7],
	[["*"], "foo,", 3],
	[["*"], "foo, bar", 3],
	[["*", "n"], "foo, bar, baz", 3],
	// A keyword run is what a word motion steps over, so a word search finds a
	// Chinese word where a `\<`-anchored pattern cannot — and does not find it
	// where the pattern can, which is the `\<` case here.
	[["*"], "中文 中文", 0],
	[["*"], "café café", 0],
	[["*"], "foo\nfoo", 0],
	[["2", "*"], "foo a foo b foo", 0],
	[["3", "*"], "foo a foo b foo", 0],
	[["2", "#"], "foo a foo b foo", 12],
	[["/", "\\<", "f", "\r"], "foo foo", 0],
	// A search arms the wanted column where it lands, like any other motion.
	[["/", "a", "\r", "j"], "a a\na a", 0],
	// A bare separator line takes the direction it was typed with, whatever the
	// last search ran in, and remembers it — so this pair is the whole of it, and
	// an `n` after each says which way the repeat will go on.
	[["#", "/", "\r"], "foo a foo b foo", 12],
	[["#", "/", "\r", "n"], "foo a foo b foo", 12],
	[["#", "/", "\r", "N"], "foo a foo b foo", 12],
	[["#", "?", "\r"], "foo a foo b foo", 12],
	[["#", "?", "\r", "n"], "foo a foo b foo", 12],
	[["/", "foo", "\r", "?", "\r", "n"], "foo a foo b foo", 0],
	[["#", "2", "/", "\r"], "foo a foo b foo", 0],
	[["#", "2", "?", "\r"], "foo a foo b foo", 0],
	// A word run reaches left of the caret, so a caret in the middle of a word
	// searches for that word and starts from its first character. Every offset of
	// `foo foo foo` is here because a rule that only works when the caret is on a
	// word's first character is not the rule.
	[["*"], THREE_FOO, 1],
	[["#"], THREE_FOO, 2],
	[["*"], THREE_FOO, 5],
	[["#"], THREE_FOO, 6],
	// And the search starts from the run's first character rather than from the
	// caret, which on a space in front of a run is the difference between wrapping
	// round to 0 and landing on the run the caret is already next to.
	[["*"], THREE_FOO, 7],
	// What a word *is* is a run of one character class, not a run of letters: the
	// three scripts are three words and the two emoji are one, while the euro sign
	// is punctuation that both commands step over.
	[["*"], SCRIPTS, 1],
	[["#"], SCRIPTS, 3],
	[["*"], SCRIPTS, 5],
	[["*"], EMOJI_RUN, 0],
	[["*"], EMOJI_SPLIT, 0],
	[["*", "n"], EMOJI_SPLIT, 0],
	[["*"], EURO_RUN, 0],
	[["*"], CJK_RUN, 1],
	// A run is matched whole, so a longer run of the same class beside it is not a
	// match — the `\<` vim writes is doing that, and three emoji find no two. The
	// caret on the *short* run is the half that tells the two apart: from there the
	// answer is a wrap onto the match under the caret, and a search that compared
	// only as far as the word's own length would answer 0 instead.
	[["*"], EMOJI_THREE, 0],
	[["*"], EMOJI_THREE, 7],
	// Both passes stop at the end of the caret's line. The word on the next line
	// is not looked at, so `*` moves nothing at all rather than finding it.
	[["*"], BLANK_LINE, 1],
	[["#"], BLANK_LINE, 1],
	[["*"], BLANK_LINE, 0],
	[["*"], TAIL_BLANKS, 4],
	[["/", "foo", "\r"], BLANK_LINE, 1],
	// With no identifier left on the line, the run is plain text and the search
	// becomes a pattern search: the dots are searched for as a literal, so the run
	// under the caret is skipped and the search wraps back onto it.
	[["*"], DOTS, 1],
	[["*"], DOTS, 2],
	[["#"], DOTS, 1],
	[["*", "n"], DOTS_AGAIN, 1],
	[["*"], FOUR_DOTS, 1],
	[["*", "n"], FOUR_DOTS, 1],
	// `*` and `#` are the same search under an operator, and the operator takes the
	// range between the caret and where that search lands, open at the far end. Three
	// copies of the word, because with two the directions coincide mod wrapping and
	// both halves of the range would agree with either reading.
	[["d", "*"], THREE_AS, 0],
	[["d", "#"], THREE_AS, 0],
	[["d", "*"], THREE_AS, 6],
	[["d", "#"], THREE_AS, 6],
	[["d", "*"], THREE_AS, 12],
	[["d", "#"], THREE_AS, 12],
	[["y", "*"], THREE_AS, 0],
	[["y", "#"], THREE_AS, 0],
	// The operator's search is stored like any other, so `n` after a yank walks on.
	[["y", "*", "n"], BAR_TWICE, 0],
	[["d", "*", "n"], THREE_AS, 0],
	// A caret one past the last character is a position this engine allows and vim
	// does not have: `check_cursor_col_win` steps it back onto the last character
	// before the command runs, so every command here answers as if it started there.
	// The engine is handed that column by the host — it is where a paste at the end
	// of the line leaves it — and without the step `x`, `r` and `h` all read past
	// the end and do nothing at all.
	[["h"], THREE_AS, 14],
	[["l"], THREE_AS, 14],
	[["x"], THREE_AS, 14],
	[["r", "z"], THREE_AS, 14],
	[["d", "l"], THREE_AS, 14],
	[["*"], THREE_AS, 14],
	[["$"], THREE_AS, 14],
	[["0"], THREE_AS, 14],
	// `g*`/`g#` are the same search and `dg*` the same range: `nv_ident` reads
	// `cap->cmdchar == 'g'` only to decide on the anchor, and never asks whether an
	// operator is waiting. The glued runs are the two positions the spellings are
	// documented to separate, and they are here because they agree.
	[["g", "*"], THREE_AS, 0],
	[["g", "#"], THREE_AS, 0],
	[["g", "*"], THREE_AS, 6],
	[["g", "#"], THREE_AS, 6],
	[["g", "*"], GLUED, 0],
	[["g", "#"], GLUED, 3],
	[["g", "*"], GLUED_INSIDE, 1],
	[["g", "#"], GLUED_INSIDE, 2],
	[["d", "g", "*"], THREE_AS, 0],
	[["d", "g", "#"], THREE_AS, 6],
	[["y", "g", "*"], THREE_AS, 12],
	[["2", "g", "*"], THREE_AS, 0],
	[["g", "*", "n"], BAR_TWICE, 0],
	// `+` and `-` are `nv_down`/`nv_up` with `beginline` after them
	// (nv_cmds.h:155), so they land on the first non-blank of the line they reach
	// — and `nv_down` refuses to move at all when there is no line that way,
	// while an overshooting count clamps the way `j`'s does. The line with no
	// character on it has its own answer: `beginline` stops at the end of it.
	[["+"], FOUR_LINES, 0],
	[["+"], FOUR_LINES, 2],
	[["+"], FOUR_LINES, 3],
	[["+"], FOUR_LINES, 5],
	[["+"], FOUR_LINES, 7],
	[["+"], FOUR_LINES, 11],
	[["-"], FOUR_LINES, 0],
	[["-"], FOUR_LINES, 5],
	[["-"], FOUR_LINES, 7],
	[["-"], FOUR_LINES, 9],
	[["-"], FOUR_LINES, 12],
	[["2", "+"], FOUR_LINES, 0],
	[["2", "+"], FOUR_LINES, 8],
	[["2", "-"], FOUR_LINES, 12],
	[["0", "+"], FOUR_LINES, 0],
	[["+", "j"], FOUR_LINES, 0],
	[["+", "+"], FOUR_LINES, 0],
	[["+"], TABBED, 0],
	[["-"], TABBED, 4],
	[["+"], BLANK_LINE, 0],
	[["-"], BLANK_LINE, 3],
	[["+"], "abc", 0],
	[["-"], "abc", 1],
	// `d+`/`d-` are linewise, and their landing is the `beginline` of the line the
	// motion reached — which is what decides where a linewise yank leaves the
	// caret, so `y+` is the case that reads the rule back.
	[["d", "+"], FOUR_LINES, 0],
	[["d", "-"], FOUR_LINES, 12],
	[["d", "-"], FOUR_LINES, 5],
	[["d", "+"], FOUR_LINES, 11],
	[["y", "+"], FOUR_LINES, 0],
	[["y", "-"], FOUR_LINES, 12],
	[["2", "d", "+"], FOUR_LINES, 0],
	[["c", "+"], FOUR_LINES, 5],
	[[">", "+"], FOUR_LINES, 0],
	[["<", "+"], FOUR_LINES, 5],
	// A line that is nothing but blanks has no first non-blank, and vim splits on
	// what it does instead: `beginline(BL_FIX)` — which every goto runs after
	// itself — steps back onto the last character, while `I` types at the end of
	// the blanks. The paste case is the third answer to the same question: a line
	// yanked while it was blank lands the caret on its last character, not on the
	// break the engine would have put there.
	[["-"], BLANK_LINE, 3],
	[["g", "g"], BLANK_LINE, 3],
	[["G"], "foo\n  ", 0],
	[["2", "G"], "a\n  \nc", 0],
	[["3", "g", "g"], "a\n  \n  \nc", 0],
	[["+", "-"], "foo\n  \nbar", 8],
	[["g", "g"], " \t \nfoo", 4],
	[["I", "x", "\x1b"], BLANK_LINE, 0],
	[["I", "x", "\x1b"], "  ", 0],
	[["A", "Z", "\x1b"], "  ", 0],
	[["y", "y", "G", "p"], BLANK_LINE, 0],
	[["y", "y", "G", "k", "P"], BLANK_LINE, 0],
	[["y", "y", "G", "3", "p"], BLANK_LINE, 0],
	// `^` is a move of its own and discards the wanted column, the way `0`, `gg`
	// and `G` do — so a `j` after it lands on the first column rather than on
	// whatever column the caret happened to be in. The `$` case is the same rule
	// from the other end: a wanted column armed past the end of the line is what
	// `^` throws away.
	[["^", "j"], "abc\ndef", 1],
	[["^", "j"], "abc\ndef", 2],
	[["^", "k"], "def\nabc", 5],
	[["$", "^", "j"], "abc\ndef", 0],
	[["0", "j"], "abc\ndef", 1],
	[["G", "j"], "a\nb\nc", 0],
	[["+", "j"], "a\nb\nc", 0],
	[["-", "j"], "a\nb\nc", 4],
	[["^", "j", "j"], "a\nb\nc", 0],
	[["^", "$"], "abc\ndef", 1],
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
