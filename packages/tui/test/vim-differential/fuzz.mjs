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
