/**
 * The character-class table, held against real vim over the whole code space.
 *
 * `regress.mjs` and `fuzz.mjs` ask whether the engine and vim *do* the same
 * thing. They cannot ask whether {@link codePointClass} is *right*, because
 * every case either agrees with both or disagrees with both — a table that had
 * every class shifted by one would still match them, it would just be a
 * different partition of the alphabet. The partition is the thing, and it came
 * here transcribed from `utf_class_buf`'s `classes[]` and `emoji_all` in vim's
 * `mbyte.c`, which is exactly the kind of copy that is wrong once and never
 * noticed.
 *
 * So this asks vim directly, with its own `charclass()` string function, for the
 * class of every code point from 0 to the top of the astral planes and compares.
 * One vim invocation does the work: a wrong interval shows up as a run of
 * disagreeing code points, named, rather than as a word motion that stopped in
 * the wrong place three months later.
 *
 *   bun run packages/tui/test/vim-differential/class.mjs
 *
 * Exits 0 when the two agree everywhere, 1 on any difference, 77 with no vim.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codePointClass } from "../../src/vim.ts";
import { haveVim, skipBecause } from "./harness.mjs";

if (!haveVim()) skipBecause("no vim on PATH to measure against");

/** One past the largest code point, so the range covers the astral planes. */
const LAST = 0x110000;

const DIR = mkdtempSync(join(tmpdir(), "vim-class-"));
const outFile = join(DIR, "classes.txt");
// `writefile()` of 1.1M lines is faster than echoing, and one range at a time
// keeps a single `:for` from being a megabyte-long command line.
const script = [];
for (let from = 0; from < LAST; from += 0x8000) {
	const to = Math.min(LAST, from + 0x8000);
	script.push(`:call writefile(map(range(${from}, ${to - 1}), 'charclass(nr2char(v:val))'), '${outFile}', 'a')\r`);
}
script.push(":qall!\r");

const keys = join(DIR, "keys");
writeFileSync(keys, script.join(""), "binary");
const scratch = join(DIR, "empty.txt");
writeFileSync(scratch, "", "utf8");
try {
	execFileSync(
		"vim",
		["-u", "NONE", "-N", "-i", "NONE", "-n", "--not-a-term", "--cmd", "set encoding=utf-8", "-s", keys, scratch],
		{ stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 },
	);
} catch {
	rmSync(DIR, { recursive: true, force: true });
	console.log("vim did not finish asking for the classes — nothing to compare, so nothing passed.");
	process.exit(1);
}

const theirs = readFileSync(outFile, "utf8")
	.split("\n")
	.filter((line) => line !== "")
	.map(Number);

/**
 * Why the two can be off by a name rather than a value: the engine renumbers
 * vim's script classes to 4..10, since only equality is ever asked of them.
 */
const RENAMED = new Map([
	[0x2070, 4], // superscript
	[0x2080, 5], // subscript
	[0x2800, 6], // braille
	[0x3040, 7], // hiragana
	[0x30a0, 8], // katakana
	[0x4e00, 9], // hanzi
	[0xac00, 10], // hangul
]);

const bad = [];
for (let code = 0; code < theirs.length; code++) {
	// A lone surrogate is not a character; `nr2char` refuses to make one and
	// `charclass()` gets the empty string, which says nothing about either table.
	if (code >= 0xd800 && code <= 0xdfff) continue;
	const vim = theirs[code];
	const ours = codePointClass(code);
	// U+000A is the one code point the two are meant to disagree on, and it is
	// held to this engine's own answer rather than excused: vim has no line-break
	// character to classify, while this engine's buffer is one string with `\n`
	// in it, so a word motion here has to call it white space (class 0) or it
	// would stop on the last character of a line. Everything else — a form feed,
	// a carriage return, U+0085 — follows vim and is meant to be checked.
	const want = code === 0x0a ? 0 : vim > 3 ? (RENAMED.get(vim) ?? vim) : vim;
	if (ours !== want) bad.push({ code, vim, ours, want });
}

console.log(`${theirs.length} code points, ${bad.length} disagree`);
for (const { code, vim, ours, want } of bad.slice(0, 40)) {
	console.log(
		`  U+${code.toString(16).toUpperCase().padStart(4, "0")}  ` +
			`${String.fromCodePoint(code)}  vim ${vim} (here ${want})  ours ${ours}`,
	);
}
if (bad.length > 40) console.log(`  … and ${bad.length - 40} more`);
rmSync(DIR, { recursive: true, force: true });
process.exit(bad.length === 0 ? 0 : 1);
