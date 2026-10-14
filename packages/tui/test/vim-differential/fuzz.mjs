/**
 * Randomized differential: key sequences against real vim.
 *
 * {@link ./regress.mjs} covers the disagreements this engine is known to have
 * had. This one covers the space between them — 900 sequences drawn from the
 * keys that interact with each other, over a handful of buffers, at a fixed
 * seed so a mismatch is reproducible from the line it prints.
 *
 * The key set is the one the comparison is meaningful for: backspace, delete,
 * `<End>` and the arrows, the motions around them, the operators, and a count.
 * Sequences ending on a half-typed operator are dropped rather than compared,
 * because the two editors would be sitting in different pending states that a
 * buffer-and-cursor comparison cannot see — a difference there is a limitation of
 * what is compared, not a bug in either.
 *
 * One sequence in four is not drawn from that set at all. `textObjectSeq()` puts
 * a text object in the middle of an otherwise ordinary sequence, because a uniform
 * draw cannot reach one and the measurement of that is the reason: with the object
 * keys added to the table, 900 draws kept 557 sequences and **not one** of them
 * spelled a text object, down from 709 kept without them. The interesting shapes
 * are four keys long — `di"j`, `yi"g g P`, `2di"`, `di".` — and the draw is one to
 * three. So the table is left alone and the shape is drawn on purpose.
 *
 * The classes `uncomparable()` drops by name are the states the two editors do not
 * share, and the walk there decides them one key at a time: an Enter that is not
 * closing a `/` or `?` line and not the character an armed `r` is waiting for (vim
 * reads a bare Enter as `+`; the engine hands it to the host so a newline submits),
 * an arrow key on a `/` or `?` line (vim's command line moves its caret and the
 * engine's does not), and an `i`, an `a` or a mark key that is not naming a range —
 * which starts typing, or reads the key after it into a name. The README says why
 * with the measurements.
 *
 *   bun run packages/tui/test/vim-differential/fuzz.mjs [iterations]
 *
 * Exits 0 when nothing differed, 1 on any mismatch, 77 with no vim to measure
 * against.
 */
import { cleanup, compare, haveVim, skipBecause, TERMINAL_SEQUENCES } from "./harness.mjs";

if (!haveVim()) skipBecause("no vim on PATH to measure against");

/** The key sequence `regress.mjs` would spell, for the engine's `handleKey`. */
const KEYS = {
	BS: ["", { backspace: true }],
	DEL: ["", { delete: true }],
	// `<End>` and the arrows are in the set for the same reason: vim binds them to
	// `nv_dollar`, `nv_left` and friends, so after an operator they are the motions
	// their letters name. The engine took them as plain movements and dropped the
	// operator instead — every one of these keys was in the set for a batch before
	// it found that.
	END: ["", { end: true }],
	UP: ["", { upArrow: true }],
	DOWN: ["", { downArrow: true }],
	RIGHT: ["", { rightArrow: true }],
	LEFT: ["", { leftArrow: true }],
	// Enter, for the same reason: a search is typed into a line and run with it, and
	// a `"\r"` that is not in this set is fed to the engine as a printable character
	// and read as part of the pattern. Every key below depends on this one being
	// spelled right, so a fuzzer without it checks none of them.
	CR: ["", { return: true }],
	// Search, and the two commands that take a word rather than a pattern. They are
	// here because a key the fuzzer cannot send is a key nothing is checking — which
	// is how the whole group was found: `/` and `?` read their line and threw it
	// away, so a user typing `/foo` got silence, and no case in the file said so.
	"/": ["/", {}],
	"?": ["?", {}],
	n: ["n", {}],
	N: ["N", {}],
	"*": ["*", {}],
	"#": ["#", {}],
	// The line moves that carry their own `beginline`. `+` and `-` are the
	// measurements `regress.mjs` pins; they are here because they are complete on
	// their own — no count, no prefix, no second key — and a key the fuzzer cannot
	// send is a key nothing is checking. `^` and `G` are the two gotos that share
	// the same `beginline`, and the blank-line step-back is a rule they have that
	// `+`/`-` do not reach on their own.
	"+": ["+", {}],
	"-": ["-", {}],
	"^": ["^", {}],
	G: ["G", {}],
	h: ["h", {}],
	l: ["l", {}],
	j: ["j", {}],
	k: ["k", {}],
	x: ["x", {}],
	// `.`, the redo. It is complete in one key — nothing half-typed about it — and
	// every key above can be what it repeats: `x`, a `d` and its motion, the delete
	// key. Three drawn keys is enough for the pair that matters (`x` then `.`), and
	// enough for a count to be wrong (`2` `x` `.`), which is the rule the engine
	// got wrong first. No key in this set opens insert mode, so no sequence drawn
	// from it can end as one — which is what would make a `.` replay unmeasurable
	// (the README's fourth lie) and is why that exclusion is not needed here.
	".": [".", {}],
	// `r`, the replace, in NORMAL and in a selection. It is the one operator in
	// the set whose character is *the next key*, so it is here for the same reason
	// the terminal keys are: a key the fuzzer cannot send is a key nothing is
	// checking. It has earned its place twice over — the selection half is a
	// command that reads a key of its own and a Visual mode that had no answer for
	// it, which no `regress.mjs` case was asking about, and putting `r` in the set
	// is what turned up the count refusal below. One exclusion comes with it: a
	// half-typed `r` at the end. `r<CR>` is comparable — the engine carries both
	// halves out and the `regress.mjs` `r` `CR` cases pin them, redo included — and
	// the walk in `uncomparable()` admits it as the character the armed `r` is
	// waiting for, which the lookback rule it replaced could not see.
	r: ["r", {}],
	d: ["d", {}],
	y: ["y", {}],
	2: ["2", {}],
	3: ["3", {}],
	$: ["$", {}],
	0: ["0", {}],
};
// The text objects are deliberately *not* in this table. They were, and the
// measurement said so: adding `i`, `a` and the three quote characters to a
// uniform draw over 36 keys cost 152 of 900 sequences (709 kept → 557) and
// produced **zero** text-object sequences. `di"` is three keys and the draw is one
// to three, so it lands about 0.06 times per run, and `di"` followed by a `.` or a
// count is four keys and never lands at all. `textObjectSeq()` below draws that
// shape on purpose instead, which is the only reason it is worth drawing at all.

const ALPHABET = Object.keys(KEYS);
const TEXTS = [
	"ab",
	"abcdef",
	"ab\ncdef",
	"ab\ncdef\ngh",
	"ab\n\ncd",
	"abc\ndef",
	"a\nbc\ndef",
	// The non-ASCII ones are here for the same reason the key set is narrow: a
	// buffer is only interesting if the classes in it differ, and ASCII has three
	// classes and no argument about which is which. These put a Latin-1 letter
	// next to a symbol, three scripts next to each other, and a two-byte
	// character next to a one-byte one, where a byte-indexed cursor or a
	// surrogate half would show up as a disagreement that is neither engine's
	// fault.
	"café Ünïcödé",
	"a×b ¡c ¿d µe",
	"かなカナ漢字",
	"你好世界 abc",
	"привет мир",
	"école x",
	"👍abc €def",
	"a b c",
	// And the quote objects need buffers with quotes in them, for the same reason:
	// a buffer is only interesting if it has the thing the new keys act on. These
	// five are the shapes the object has rules *for* — two pairs on a line (which of
	// them a caret between them gets), an apostrophe inside a word, a backtick pair
	// inside a double-quoted one, an escaped quote (which is why the fourth is
	// written as a JS escape, and why its run of backslashes is even), and a line
	// holding two unpaired quotes, which is the FAIL path. Every one of them is nine
	// characters or fewer, so the `CURSORS` below reaches into all of them.
	'"ab" "cd"',
	"it's ok",
	'"a `b` c"',
	'x \\"y\\" z',
	'a "b" c "d',
];
const CURSORS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
/** Fixed, so a printed mismatch is the same one on the next run. */
const SEED = 20260919;
const ITERATIONS = Number(process.argv[2] ?? 900);

function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

const rand = rng(SEED);
const failures = [];
let checked = 0;
/**
 * How many of the checked sequences came from the text-object draw. This is the
 * number that says whether the structured draw is worth its quarter of the sample,
 * and it is the only honest way to report what the alphabet version of this would
 * have been: 0, out of 557 kept, measured.
 */
let withObject = 0;
let skipped = 0;

/**
 * The walk that decides whether the two editors are being asked the same question,
 * one key at a time — a state machine rather than a lookback rule at each key,
 * because every state that changes what a key means is a state the key before it
 * does not know about.
 *
 * The states, and what an Enter means inside each:
 *
 *  - **A `/` or `?` line.** The engine's `#search` holds the whole line — it
 *    accumulates, `<BS>` edits it one code point at a time, and Enter runs the
 *    search rather than reaching the host — and vim's command line does the same.
 *    An Enter here runs the search in both, so the sequence is comparable: the old
 *    rule asked whether the *previous* key was the separator and therefore dropped
 *    every pattern with a character typed before its Enter along with the bare
 *    ones. What does diverge is the caret — the arrows and `<End>` move vim's
 *    command line and the engine ignores them — so one of those anywhere inside a
 *    line drops the sequence: everything typed after the move would land at a
 *    different place in the two lines. A `+` or a `?` typed into a pattern drops
 *    it too, and that one is the dialect rather than the caret: neither is magic
 *    in vim, which reads both as literals where the engine's JavaScript reads
 *    them as quantifiers — the dialect the README names as not implemented — and
 *    a known difference reported as a discovery is noise.
 *  - **An armed `r`.** The key it is waiting for is a character, Enter included:
 *    the character under the caret becomes a line break, and both editors carry
 *    that out (`regress.mjs` pins both halves, the redo included). Comparable, and
 *    the old rule dropped it without cause.
 *  - **An armed `g`.** Vim has no `g<CR>`; it beeps. The engine abandons the
 *    pending `g` and hands the Enter to the host. Incomparable.
 *  - **An operator in flight.** Vim reads a bare Enter as `+`, a motion, so
 *    `d<CR>` deletes two lines; the engine abandons the operator and submits.
 *    Incomparable. A count between the operator and its motion keeps the operator
 *    waiting, in either order.
 *  - **Nothing pending.** Vim moves (`+`), the engine submits. Incomparable.
 *
 * The `i`/`a` rule is the text-object draw's own and this same walk decides it: an
 * `i` or an `a` that is not naming a range starts typing instead, which puts the
 * two editors on different sides of a mode change, so only a pair with its object
 * character behind it is comparable. It is written the way vim parses a command —
 * an operator is spent by whatever key comes next, which is what a count between
 * the two is for — because the first version of it was not: it treated an operator
 * as pending until an `i` or an `a` turned up, so `y` `d` `i` `}` read as "a `y`
 * waiting, then a `d` waiting, then a text object". `yd` is one command — a yank
 * to the end of the line — and the `i` after it opens insert mode, where the `}`
 * is typed into the buffer. The fuzzer found it on the first run of the
 * structured draw.
 *
 * The quote, mark and register keys are the same kind of state: away from an
 * `i`/`a` a `"` names a register and a `'` and a `` ` `` name a mark, and all
 * three read the key after them — so they are dropped like a bare `i`/`a`, and the
 * skip that consumes the object character is what keeps `di"` from being read as
 * a `d` waiting for a register name.
 */
function uncomparable(seq) {
	/** `"operator"` waits for a motion or an object; `"r"` and `"g"` for the key that spends them. */
	let armed = null;
	/** Inside a `/` or `?` line, where every key is pattern text until Enter. */
	let latch = false;
	for (let i = 0; i < seq.length; i++) {
		const key = seq[i];
		if (latch) {
			if (key === "CR") {
				latch = false; // the pattern's Enter: both editors run the search
				continue;
			}
			if (ARROW_KEYS.has(key)) return true; // vim's line moves its caret; the engine's does not
			if (key === "+" || key === "?") return true; // literals in vim, quantifiers in JavaScript
			continue; // pattern text, and `<BS>`/`<Del>` at the line's end: identical in the two
		}
		if (armed === "r") {
			armed = null; // the character to write, Enter included
			continue;
		}
		if (armed === "g") {
			if (key === "CR") return true; // vim beeps where the engine abandons the `g` and submits
			armed = null;
			continue;
		}
		if (armed === "operator") {
			if (key === "2" || key === "3") continue; // the count keeps the operator waiting
			if (key === "CR") return true; // vim reads the bare Enter as `+`
			if (key === "i" || key === "a") {
				if (i + 1 >= seq.length) return true; // an object with no character: a latch only vim sits in
				i += 1; // the object character, spent with the object
				armed = null;
				continue;
			}
			armed = null; // the motion; an `r` or `g` after an operator is spent, not armed
			continue;
		}
		if (key === "CR") return true; // a bare Enter: vim moves (`+`), the engine submits
		if (key === "/" || key === "?") {
			latch = true;
			continue;
		}
		if (OPERATORS.has(key)) {
			armed = "operator";
			continue;
		}
		if (LITERAL_KEYS.has(key)) {
			armed = key;
			continue;
		}
		if (QUOTE_KEYS.has(key)) return true; // a register or a mark: the key after it is read into a name
		if (key === "i" || key === "a") return true; // a bare `i` or `a` starts typing
	}
	return false;
}

/** The keys that move vim's command line, kept out of the `/` and `?` states above. */
const ARROW_KEYS = new Set(["UP", "DOWN", "LEFT", "RIGHT", "END"]);

/** The operators in the set above. `>` and `<` are not: they are shift keys, and nothing else. */
const OPERATORS = new Set(["d", "y"]);
/**
 * Keys that read the key after them as a *literal* rather than as a command: `r`
 * writes whatever comes next over the character under the caret, and `g` is the
 * first half of `gg`, `ge` and the rest. Both leave a pending state that the next
 * key is spent on, which is the same shape as an operator's — and getting it wrong
 * is not a near miss. The first version of this rule knew about operators and not
 * about these, and the 3000-sequence sweep found four sequences where it was
 * wrong: `r` `y` `i` `"` is not a text object, because `r` ate the `y` as the
 * character to write and the `i` after it opens insert mode. Both editors agreed on
 * the buffer in all four — the `"` typed in — and differed only in the caret
 * sitting one to the right of the character it went in at.
 */
const LITERAL_KEYS = new Set(["r", "g"]);
/** The three quote characters, spelled the way the engine receives them. */
const QUOTE_KEYS = new Set(['"', "'", "`"]);

/** `d`, `y`, and the four ways a count may sit in front of either. */
const ARMED = [["d"], ["y"], ["2", "d"], ["3", "d"], ["2", "y"], ["3", "y"]];
/**
 * Every character the engine's `#applyTextObject` names a range with. This is the
 * list a text object is *not* checked against, so it is also the list where a
 * disagreement would mean the two sides disagree about what a text object is — a
 * disagreement worth finding. An `i` or `a` in it answers with nothing in both
 * editors, which is why they are in and the fuzzer does not trip over them.
 */
const OBJECT_CHARS = ["w", "W", "p", "(", ")", "{", "}", "[", "]", '"', "'", "`"];

/**
 * One sequence with a text object deliberately put in the middle of it: an
 * operator, an `i` or `a`, one of the twelve object characters, and up to one key
 * on either side drawn from the alphabet above.
 *
 * The keys on either side are the point. A bare `di"` checks the object's own
 * range, which is what `regress.mjs`'s cases are for; what a random draw could
 * never reach is the object *combined* with the rest of the key space — `di"j`
 * to see whether the caret lands where the next line starts, `yi"g g P` to see
 * what a range yank leaves in the register, `2di"` to see whether the count
 * reaches the object, and `di".` to see whether the redo replays it.
 */
function textObjectSeq() {
	const seq = [];
	if (rand() < 0.5) {
		const pre = ALPHABET[Math.floor(rand() * ALPHABET.length)];
		// A `/` or `?` right before the operator would swallow it into the search
		// line — a real line in both editors, so the object would be compared as
		// pattern text and never act on the buffer, which is the point of the
		// draw — so the draw refuses to build it.
		if (pre !== "/" && pre !== "?") seq.push(pre);
	}
	for (const key of ARMED[Math.floor(rand() * ARMED.length)]) seq.push(key);
	seq.push(rand() < 0.5 ? "i" : "a");
	seq.push(OBJECT_CHARS[Math.floor(rand() * OBJECT_CHARS.length)]);
	if (rand() < 0.5) seq.push(ALPHABET[Math.floor(rand() * ALPHABET.length)]);
	return seq;
}

for (let i = 0; i < ITERATIONS; i++) {
	const text = TEXTS[Math.floor(rand() * TEXTS.length)];
	const cursor = CURSORS[Math.floor(rand() * CURSORS.length)];
	// Only NORMAL-mode positions both editors agree on: on a character, never past
	// the end, never on a line break, and never half of a surrogate pair — a
	// cursor there is inside a character, which neither editor can act on.
	if (cursor >= text.length || text[cursor] === "\n") continue;
	const unit = text.codePointAt(cursor);
	if (unit !== undefined && unit >= 0xd800 && unit <= 0xdfff) continue;
	const length = 1 + Math.floor(rand() * 3);
	// One draw in four puts a text object in the middle of an otherwise ordinary
	// sequence, because the uniform draw cannot reach one — see `textObjectSeq()`.
	const structured = rand() < 0.25;
	const seq = structured
		? textObjectSeq()
		: Array.from({ length }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]);
	// No half-typed operator or count at the end — see the file comment. An `r` is
	// one too: both editors would be waiting for the character to write.
	if (["d", "y", "2", "3", "r"].includes(seq[seq.length - 1])) continue;
	// The named exclusions, by the walk in `uncomparable()`: a `/` or `?` line
	// makes every key after it pattern text in both editors, an armed key changes
	// what the next one does, and the walk is where each shape is judged — the
	// text-object draw's `i`/`a` rule included.
	if (uncomparable(seq)) continue;

	// A key the table above has no entry for is a printable one the text-object
	// draw supplied — the twelve object characters, most of which are not commands
	// in their own right. It is its own input in both editors, so it needs nothing
	// looked up.
	const kseq = seq.map((key) => {
		const entry = KEYS[key];
		if (entry === undefined) return key;
		// The engine takes the two-key form; vim takes the terminal's, which for
		// backspace, delete, End and the arrows is not a printable character. The
		// spelling comes from the harness so the two cannot drift apart.
		return entry[0] === "" ? TERMINAL_SEQUENCES[Object.keys(entry[1])[0]] : entry[0];
	});
	const result = compare(text, cursor, kseq);
	if (result.vim === null) {
		skipped += 1;
		continue;
	}
	checked += 1;
	if (structured) withObject += 1;
	if (!result.ok) {
		failures.push({
			seq: seq.join(" "),
			text,
			cursor,
			got: `${JSON.stringify(result.ours.text)}@${result.ours.cursor}`,
			want: `${JSON.stringify(result.vim.text)}@${result.vim.cursor}`,
		});
	}
}

console.log(
	`checked ${checked} sequences (${withObject} with a text object), ${failures.length} mismatches, ${skipped} skipped`,
);
const seen = new Set();
for (const failure of failures) {
	const sig = `${failure.seq}|${failure.text}|${failure.cursor}`;
	if (seen.has(sig)) continue;
	seen.add(sig);
	console.log(JSON.stringify(failure));
	if (seen.size > 25) break;
}
cleanup();
process.exit(failures.length === 0 ? 0 : 1);
