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
 * Two more classes are dropped by name in `uncomparable()`, both about a command
 * line the fuzzer opens but cannot see: an Enter that is not closing a `/` or `?`
 * (vim calls it `+`; the engine hands it to the host so a newline submits), and a
 * backspace or delete that *is* on one (vim edits the command line, the engine
 * does not read that key there). The README says why with the measurements.
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
	d: ["d", {}],
	y: ["y", {}],
	2: ["2", {}],
	3: ["3", {}],
	$: ["$", {}],
	0: ["0", {}],
};

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
let skipped = 0;

/** Did the key at `i` go into a `/` or `?` line rather than into the buffer? */
function intoLatch(seq, i) {
	return i > 0 && (seq[i - 1] === "/" || seq[i - 1] === "?");
}

/**
 * The two sequences that answer a different question in the two editors, named so
 * that a mismatch which is neither can be told apart from one that is.
 *
 *  - A `CR` with no latch open. Vim binds it to `nv_down` + `beginline`, which is
 *    this engine's `+`; the engine hands Enter to the host so a newline in the REPL
 *    submits. The buffers agree and the host's half of the answer cannot be
 *    compared, so the whole sequence is dropped rather than the key. (It is not a
 *    *search* latch case: `/foo<CR>` is comparable, and the comment on `CR` above
 *    is why `CR` is in the set at all.)
 *  - A `BS` or `DEL` with a latch open. In vim both are an editing key of the
 *    command line — `BS` cancels it outright, `DEL` erases under the cursor — and
 *    neither is a command the engine reads on that path. Without a latch the same
 *    two keys are ordinary motions and stay in the set.
 */
function uncomparable(seq) {
	for (let i = 0; i < seq.length; i++) {
		if (seq[i] === "CR" && !intoLatch(seq, i)) return true;
		if ((seq[i] === "BS" || seq[i] === "DEL") && intoLatch(seq, i)) return true;
	}
	return false;
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
	const seq = [];
	for (let k = 0; k < length; k++) seq.push(ALPHABET[Math.floor(rand() * ALPHABET.length)]);
	// No half-typed operator or count at the end — see the file comment.
	if (["d", "y", "2", "3"].includes(seq[seq.length - 1])) continue;
	// Two named exclusions, both about a command line the fuzzer opens but cannot
	// see. A `/` or `?` puts both editors on a different side of a latch: vim's is
	// a real command line that the next key is typed into, and the engine's is a
	// one-key read. What arrives next is therefore not the same key in the two.
	if (uncomparable(seq)) continue;

	const steps = seq.map((key) => KEYS[key]);
	// The engine takes the two-key form; vim takes the terminal's, which for
	// backspace, delete, End and the arrows is not a printable character. The
	// spelling comes from the harness so the two cannot drift apart.
	const kseq = steps.map(([input, overrides]) =>
		input === "" ? TERMINAL_SEQUENCES[Object.keys(overrides)[0]] : input,
	);
	const result = compare(text, cursor, kseq);
	if (result.vim === null) {
		skipped += 1;
		continue;
	}
	checked += 1;
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

console.log(`checked ${checked} sequences, ${failures.length} mismatches, ${skipped} skipped`);
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
