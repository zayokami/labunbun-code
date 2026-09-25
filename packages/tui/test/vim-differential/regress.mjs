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
// For `.`: one line of four words, so `dw`, `cw` and a count have somewhere to
// go and the landing after each of them is a different column.
const FOUR_WORDS = "one two three four";
const TEN = "abcdefghij";
/** One character per line: a horizontal step inside a selection runs off the end. */
const SOLO_LINES = "1\n2\n3\n4";
// Sixteen letters in a row, so `3x` and `2.` remove different numbers of them
// and the total is still enough to see which count won.
const SIXTEEN = "abcdefghijklmnop";
// Short equal-width lines, the shape a Visual selection's geometry is only
// readable against: every line is two wide, so a re-selection that used the
// wrong form (the end's column instead of the width) would still look right on
// a single line and only miss over a re-selection onto a *different* line.
const SHORT_LINES = "ab\ncd\nef\ngh";
// One word and one separator per line, punctuation and all. A word ends before
// the `,` and before the `;`, so a buffer written with spaces between every word
// cannot tell a word from the punctuation behind it.
const PUNCT = "a, b; c";
// Three one-character lines, so a multi-line word object spans whole lines and
// whether the last of them is left empty is the whole question.
const THREE_LINES = "a\nb\nc";
// The first line longer than the last, which is the case the short lines above
// cannot make: a selection ending on line 1 redoes by its *width*, and only a
// shorter line to land on shows that.
const WIDE_NARROW = "abcdef\nxyz\npq";

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
	// Word text objects. `current_word` (textobject.c:683-853) is a walk and not a
	// formula, so the region is a number of *groups* — a word end, then a white
	// end, then a word end — which is why `[N]iw` and `[N-1]aw` are the same
	// region spelled two ways, and why `aw` is a word plus the white behind it
	// rather than "one more character". Four rules here each have one plausible
	// wrong answer: which of the two the caret is standing in, what `aw` reaches
	// for when there is nothing behind the word, where punctuation stops a word,
	// and where the caret ends up afterwards.
	[["d", "i", "w"], FOUR_WORDS, 0],
	[["d", "i", "w"], FOUR_WORDS, 1],
	[["d", "i", "w"], FOUR_WORDS, 3],
	[["d", "a", "w"], FOUR_WORDS, 0],
	[["d", "a", "w"], FOUR_WORDS, 4],
	[["d", "i", "w"], "solo", 3],
	[["d", "a", "w"], "solo", 3],
	[["d", "2", "i", "w"], FOUR_WORDS, 0],
	[["d", "1", "a", "w"], FOUR_WORDS, 0],
	[["d", "2", "a", "w"], FOUR_WORDS, 0],
	[["d", "3", "i", "w"], FOUR_WORDS, 0],
	// A count that runs out of buffer takes what there is, and the caret is left
	// where the walk stopped rather than where a motion would have landed it.
	[["d", "6", "i", "w"], FOUR_WORDS, 0],
	[["d", "3", "i", "w"], "one two", 4],
	[["y", "2", "i", "w"], "one two", 4],
	// A line break is white, and a blank line is where the walk stops rather than
	// something it steps over: `2iw` on "one\n\ntwo" takes "one" and the empty
	// line with it, which is the linewise delete further down.
	[["d", "i", "w"], "one\ntwo", 0],
	[["d", "a", "w"], "one\ntwo three", 0],
	[["d", "2", "i", "w"], "one\n\ntwo", 0],
	[["d", "a", "w"], "one\n\ntwo", 0],
	[["d", "i", "w"], "  one", 0],
	[["d", "a", "w"], "  one two", 0],
	[["d", "i", "w"], "  one two", 1],
	[["d", "2", "i", "w"], "  one two", 2],
	[["d", "i", "w"], "  \n  x", 1],
	// A run of white is one object however long it is, from either end of it.
	[["d", "a", "w"], "one   two", 0],
	[["d", "i", "w"], "one   two", 4],
	[["d", "i", "w"], "one   two", 5],
	// Punctuation ends a word, and the walk pins the class it landed on instead of
	// re-reading it — on "a, b; c" from the space, `aw` is " b" and not " b;". `W`
	// treats the same buffer as two objects with the punctuation inside them.
	[["d", "a", "w"], PUNCT, 2],
	[["d", "i", "w"], PUNCT, 2],
	[["d", "i", "w"], PUNCT, 4],
	[["d", "a", "w"], PUNCT, 4],
	[["d", "i", "W"], PUNCT, 0],
	[["d", "i", "W"], PUNCT, 3],
	[["d", "2", "i", "W"], PUNCT, 0],
	[["d", "a", "W"], PUNCT, 0],
	[["d", "2", "a", "W"], PUNCT, 0],
	// The object uses the same character classes `w` does, which is what makes
	// `diw` take a whole hanzi run and not one of its words.
	[["d", "i", "w"], CHINESE, 0],
	[["d", "a", "w"], CHINESE, 0],
	// The caret after a yank is the start of the region, not where the walk
	// stopped, and a multi-line object's start is a real position on a line above
	// — which `ggP` then shows in the paste.
	[["y", "i", "w", "g", "g", "P"], "aa bb\ncc dd", 6],
	[["y", "2", "i", "w", "g", "g", "P"], "aa bb\ncc dd", 6],
	[["y", "2", "a", "w", "g", "g", "P"], FOUR_WORDS, 0],
	// The object half is a key of its own: case matters, `W` is an object in its
	// own right, and a key that names none abandons the whole operator instead of
	// letting the next key through as a motion.
	[["d", "i", "Z"], FOUR_WORDS, 0],
	[["d", "i", "Z", "d", "w"], FOUR_WORDS, 0],
	[["d", "i", "g", "g"], FOUR_WORDS, 0],
	[["d", "i", "\x1b"], FOUR_WORDS, 0],
	[["d", "i", "W"], FOUR_WORDS, 0],
	[["d", "i", "w", "i"], FOUR_WORDS, 0],
	// A multi-line word object deleted with `d` is deleted linewise — the "strange
	// Vi behaviour" of ops.c:810-825, still vim's behaviour because `'cpoptions'`
	// has kept its `z`. A change is never promoted (that rule names OP_DELETE), so
	// `c2iw` leaves the lines it cut, and `y` cannot be promoted at all.
	[["d", "2", "i", "w"], THREE_LINES, 0],
	[["d", "2", "a", "w"], THREE_LINES, 0],
	[["c", "2", "i", "w", "\x1b"], THREE_LINES, 0],
	[["y", "2", "i", "w"], THREE_LINES, 0],
	// The register is linewise too, which a buffer readback on its own cannot see:
	// `p` pastes two lines back, not the two characters the object held.
	[["d", "2", "i", "w", "p"], THREE_LINES, 0],
	// …and the promotion does not fire when something is left behind on the last
	// line the object touches. These four regions differ only in that, and the
	// last two never cross a line at all.
	[["d", "2", "i", "w"], "a\nb cc", 0],
	[["d", "2", "i", "w"], "a\nb cc\nd", 0],
	[["d", "2", "i", "w"], "aa bb\ncc dd", 0],
	[["d", "2", "i", "w"], "aa bb\ncc dd", 6],
	// Only blanks behind it is the same object, so both of these are promoted —
	// and the change form of the second one still is not.
	[["d", "2", "i", "w"], "a\nb   ", 0],
	[["d", "2", "i", "w"], "a\nb\t", 0],
	[["c", "2", "i", "w", "\x1b"], "a\nb   ", 0],
	[["d", "2", "i", "w"], "a\nb\ncc", 0],
	[["d", "2", "i", "w"], "  a\nb\nc", 2],
	[["d", "2", "i", "w"], "a\nb   \nc", 0],
	// A text object is a motion `>` and `<` take as much as `d` and `c` do. What
	// gets shifted is the linewise span the object lands on — one line for `iw` on
	// the first of three, two for `2iw` — and a `<<` with nothing to take is a
	// caret move to the first non-blank and not a change, which is what the two
	// unindented cases below are for.
	[[">", "i", "w"], "one two", 0],
	[[">", "a", "w"], "one two", 0],
	[["<", "i", "w"], "one two", 0],
	[[">", "i", "w"], "  one", 4],
	[["<", "i", "w"], "  one", 4],
	[[">", "i", "w"], THREE_LINES, 0],
	[[">", "2", "i", "w"], THREE_LINES, 0],
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
	// `.` — the redo. The engine had none, so this group is a new instrument as
	// much as a new feature. What it repeats is the last change to the buffer
	// *and nothing else*: a motion, a yank, a search, an undo and an abandoned
	// operator are all invisible to it, which is the whole of the "what is not
	// the redo" block below.
	[["x", "j", "."], FOUR_WORDS, 0],
	[["d", "w", "w", "."], FOUR_WORDS, 0],
	[["d", "2", "w", "j", "."], FOUR_WORDS, 0],
	[["d", "d", "j", "."], FOUR_WORDS, 0],
	[["D", "j", "."], FOUR_WORDS, 0],
	[["r", "z", "j", "."], FOUR_WORDS, 0],
	[["~", "j", "."], FOUR_WORDS, 0],
	[["J", "j", "."], "a\nb\nc", 0],
	[["x", "j", ".", "j", "."], FOUR_WORDS, 0],
	[["p", "j", "p", "."], FOUR_WORDS, 0],
	// The count on a `.` *replaces* the count the change was made with
	// (`check_redo` only writes one over `old), and a redo that itself changed
	// the buffer becomes the new redo carrying the count it used — which is what
	// makes `x` `3.` `.` remove three and not one. The `0` case is the same rule
	// at its end: a count of zero is a count.
	[["x", "j", "3", ".", "j", "."], SIXTEEN, 0],
	[["3", "x", "2", "."], SIXTEEN, 0],
	[["x", "3", ".", "1", "."], SIXTEEN, 0],
	[["2", "x", "j", "4", "."], SIXTEEN, 0],
	[["x", "j", "0", ".", "j", "."], SIXTEEN, 0],
	// What is *not* the redo: with no change yet, and then the four ways a
	// buffer can be touched without being changed. Each ends in `.` on a buffer
	// where the right answer and the wrong one differ, so a `.` that guessed
	// "the last command" would be caught here.
	[["."], FOUR_WORDS, 0],
	[["w", "."], FOUR_WORDS, 0],
	[["x", "u", "."], FOUR_WORDS, 0],
	[["y", "y", "j", ".", "p"], FOUR_WORDS, 0],
	[["d", "\x1b", "x", "j", "."], FOUR_WORDS, 0],
	[["x", "w", "j", "."], FOUR_WORDS, 0],
	[["x", "n", "j", "."], THREE_AS, 0],
	// The changes that end in insert mode repeat the text as well as the keys,
	// and each case ends with the Escape that leaves it — the caret in insert
	// mode is the insertion point here and the last character typed in vim, so
	// there is nothing to compare until both are out (the README's fourth lie).
	[["s", "\x1b", "j", ".", "\x1b"], FOUR_WORDS, 0],
	[["S", "\x1b", "\x1b", "j", ".", "\x1b"], "a\nb\nc", 2],
	[["C", "\x1b", "j", ".", "\x1b"], FOUR_WORDS, 4],
	[["c", "c", "\x1b", "\x1b", "j", ".", "\x1b"], "a\nb\nc", 2],
	[["c", "w", "Z", "\x1b", "w", ".", "\x1b"], FOUR_WORDS, 0],
	[["i", "X", "\x1b", "l", ".", "\x1b"], FOUR_WORDS, 4],
	[["a", "X", "\x1b", "l", ".", "\x1b"], FOUR_WORDS, 0],
	[["A", "X", "\x1b", "j", ".", "\x1b"], FOUR_WORDS, 0],
	[["I", "X", "\x1b", "j", ".", "\x1b"], "  ab", 0],
	[["o", "X", "\x1b", "\x1b", "j", ".", "\x1b"], "a\nb", 0],
	[["O", "X", "\x1b", "\x1b", "j", ".", "\x1b"], "a\nb", 2],
	// A Visual operator's redo is not the selection typed again: it is a size
	// (`redo_VIsual`, ops.c:3890), re-taken from wherever the caret is now. The
	// two forms it can be recorded in are told apart by where it lands
	// (`ops.c:4136`): a selection on one line is re-taken by its width and one
	// over several by the end's own column on its own line, which is why the
	// width case needs a line narrower than the one it was made on.
	[["v", "j", "d", "0", "."], SHORT_LINES, 0],
	[["v", "j", "d", "j", "."], SHORT_LINES, 0],
	[["v", "l", "d", "l", "."], "abcdef", 0],
	[["v", "$", "d", "0", "."], WIDE_NARROW, 0],
	[["V", "j", "d", "0", "."], SHORT_LINES, 0],
	[["v", "j", "2", "l", "d", "0", "."], SHORT_LINES, 0],
	[["v", ">", "j", "."], "ab\ncd", 0],
	[["v", "<", "j", "."], "ab\ncd", 0],
	[["v", "c", "X", "\x1b", "j", ".", "\x1b"], SHORT_LINES, 0],
	[["V", "c", "X", "\x1b", "\x1b", "j", ".", "\x1b"], SHORT_LINES, 0],
	// A third form, read before the other two: `w_curswant == MAXCOL`
	// (`ops.c:4136`). A selection that ended on `$` is re-taken to the end of
	// whatever line the caret is on — which is only visible when the selection
	// did *not* start at column 0, because from column 0 the width and the end
	// column and MAXCOL all name the same place. The `h` after `$` spends the
	// reach, and with it the MAXCOL, so that pair is the same buffer with the
	// other form.
	[["l", "l", "v", "$", "d", "j", "0", "."], "abcdef\nuvwxyz", 0],
	[["l", "l", "v", "$", "h", "d", "j", "0", "."], "abcdef\nuvwxyz", 0],
	[["v", "j", "$", "d", "G", "."], "ab\ncd\nefgh", 0],
	// …and the two column forms over several lines, where the line the redo
	// lands on has a different length from the one it was measured on.
	[["v", "j", "d", "G", "."], "ab\ncd\nefgh", 0],
	[["v", "j", "h", "d", "0", "."], "ab\ncd\nefghij", 0],
	// A redo that ends a command in insert mode comes back out of it by itself,
	// so these three need no Escape of their own — the original command's Escape
	// is part of what is repeated. They are comparable, which the cases above
	// with a trailing one are not until that one is typed.
	[["c", "w", "Z", "\x1b", "w", "."], FOUR_WORDS, 0],
	[["i", "X", "\x1b", "l", "."], FOUR_WORDS, 4],
	[["o", "X", "\x1b", "\x1b", "j", "."], "a\nb", 0],
	// A charwise register that spans a line break leaves the caret on its last
	// character, not on the insertion point, and the two pastes differ from there
	// — the visual yank is the one register that holds such a register.
	[["v", "j", "y", "j", "p"], "ab\ncd", 0],
	[["v", "j", "y", "j", "P"], "ab\ncd", 0],
	// Visual `r` writes one character over the selection, and the selection's own
	// line breaks are not characters it writes over: `VrX` on `"ab"` is `"XX"`, not
	// the `"XXXXXX"` a flat run would give. A count in front of the `r` is not the
	// `r`'s own (`vl3rX` is `vlrX`), and a digit is as good a character as a letter.
	[["v", "r", "X"], "abcdef", 0],
	[["v", "l", "l", "r", "X"], "abcdef", 0],
	[["v", "j", "r", "X"], SHORT_LINES, 0],
	[["v", "2", "j", "r", "X"], SHORT_LINES, 0],
	[["V", "r", "X"], SHORT_LINES, 0],
	[["V", "j", "r", "X"], SHORT_LINES, 0],
	[["v", "$", "r", "X"], "abcdef", 0],
	[["v", "l", "3", "r", "X"], "abcdef", 0],
	[["v", "r", "2"], "abcdef", 0],
	[["v", "l", "r", "2"], "abcdef", 0],
	// Escape cancels the half-typed character and leaves the selection open, and so
	// does every other key that is not a character: vim reads that key with
	// plain_vgetc and beeps without a change when it comes back as a special key,
	// while a key taken as the character to write would write nothing over the
	// selection and delete it. (`<CR>` is the exception and is in Known gaps.)
	[["v", "l", "r", "\x1b"], "abcdef", 0],
	[["v", "l", "r", "\x1b[C"], "abcdef", 0],
	[["v", "l", "r", "\x1b[B"], "abcdef", 0],
	[["v", "l", "r", "\x1b[4~"], "abcdef", 0],
	[["v", "l", "r", "\x7f"], "abcdef", 0],
	[["v", "l", "r", "\x1b[3~"], "abcdef", 0],
	[["v", "r", "\x1b[C"], "abcdef", 0],
	// …and the count in front of a NORMAL `r` that the line cannot supply is a
	// refusal, not a clamp: vim aborts the whole command (normal.c:4900-4906, "Abort
	// if not enough characters to replace") where clamping writes over the ones that
	// are there. The count is in characters, not units, so the two wide ones answer
	// the same as the two narrow ones and the third character is still too many.
	[["3", "r", "+"], "abc\ndef", 2],
	[["9", "r", "+"], "abc\ndef", 2],
	[["2", "r", "+"], "abcd", 2],
	[["3", "r", "+"], "abcdef", 3],
	[["2", "r", "+"], "你好", 0],
	[["3", "r", "+"], "你好", 0],
	[["2", "r", "+"], "👍👍", 0],
	[["3", "r", "+"], "👍👍", 0],
	[["d", "3", "r", "X"], "abcdef", 0],
	// A Visual `r` is a change like any other, and `.` reaches it — a redo that
	// repeats a `d` must not quietly refuse a `r` (`do_pending_operator` writes
	// the redo buffer for every operator it runs, `r` among them). Each `.` below
	// is on another line, because a `.` over the character just written looks the
	// same whether it ran or not. What it repeats is the *r*, not the change
	// before it: `x` then `vrX` then `.` writes an `X`, where a redo that still
	// held the `x` would delete a character.
	[["v", "r", "X", "j", "."], "abcdefgh\nij", 0],
	[["x", "v", "r", "X", "j", "."], "abcdefgh\nij", 0],
	[["d", "w", "v", "r", "X", "j", "."], "abcdefgh\nij", 0],
	[["V", "r", "X", "j", "."], "abcdefgh\nij\nkl", 0],
	[["x", "V", "r", "X", "j", "."], "abcdefgh\nij\nkl", 0],
	[["x", "v", "r", "X", ".", "."], "abcdefgh\nij\nkl", 0],
	// …even where it changed nothing. The character written is the one that was
	// there, so the buffer reads the same before and after — and the change is
	// still the one `.` repeats, which is only visible off the spot.
	[["v", "r", "x", "j", "."], "xx\nyy", 0],
	[["v", "l", "r", "x", "j", "."], "xx\nyy", 0],
	[["x", "v", "r", "x", "j", "."], "xx\nyy", 0],
	// A `.` pressed with a selection open is not a redo at all, and the change
	// the `r` made is still the redo afterwards. The `Gvl` is what makes that
	// measurable: it writes an `X` over the last line were the redo to run.
	[["V", "r", "X", "G", "v", "l", "."], "ab\ncd\nef", 0],
	[["x", "V", "r", "X", "G", "v", "l", "."], "ab\ncd\nef", 0],
	// An undo does not take the redo away, and it does not re-point it either:
	// `vrX` `u` `.` writes the `X` again, which is the entry the `vrX` left.
	[["v", "r", "X", "u", "."], "abcdefgh", 0],
	// An operator that never ran leaves the redo alone. `drX` is a `d` with a
	// motion that is not one, and both editors abandon the whole thing instead of
	// falling through to the `rX` behind it — so with nothing before, the `.` has
	// nothing to repeat. (What the redo slot *holds* after a command that aborted
	// is not observable here: re-running the aborted command would abort again
	// and print the same buffer, which is the fourth lie's cousin.)
	[["d", "r", "X", "."], "abcdef", 0],
	[["d", "r", "X", "j", "."], "ab\ncd", 0],
	// A count in front of `v`/`V` is spent on the command itself: nv_visual
	// decrements it once and runs nv_right / nv_down with what is left
	// (normal.c:5609-5615), so `2v` selects two characters, `2V` two lines, and a
	// count typed inside adds to it rather than replacing it (`2v3l` is five
	// characters wide, `2v3ll` six).
	[["2", "v", "l", "d"], TEN, 0],
	[["3", "v", "l", "d"], TEN, 0],
	[["2", "v", "3", "l", "d"], TEN, 0],
	[["3", "v", "2", "l", "d"], TEN, 0],
	[["v", "3", "l", "d"], TEN, 0],
	[["2", "v", "d"], "ab\ncd", 0],
	[["4", "v", "h", "d"], TEN, 0],
	[["2", "V", "j", "d"], "aa\nbb\ncc\ndd", 0],
	[["3", "V", "d"], "aa\nbb\ncc\ndd", 0],
	[["2", "V", "j", "j", "d"], "aa\nbb\ncc\ndd", 0],
	// …and the step it takes is a step *past* the end of the line, which is the
	// part the wanted column has to carry: inside a selection `nv_right` counts the
	// line break (normal.c:5822-5828) and stops with the caret one character past
	// the last one. The engine cannot stand there and keeps the reach armed in its
	// place, so without the column a `j` after `vl` lands a line short.
	[["v", "l", "j", "d"], SOLO_LINES, 0],
	[["v", "l", "j", "j", "d"], SOLO_LINES, 0],
	[["v", "4", "l", "j", "d"], SOLO_LINES, 0],
	[["2", "v", "j", "d"], SOLO_LINES, 0],
	[["2", "v", "j", "j", "d"], SOLO_LINES, 0],
	[["v", "l", "j", "d"], "ab\nc\ndef", 0],
	[["v", "l", "j", "d"], "abcdef\ngh", 1],
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
