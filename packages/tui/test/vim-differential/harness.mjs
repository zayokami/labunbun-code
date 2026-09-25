/**
 * The two halves of a differential comparison, side by side.
 *
 * One side is this repository's {@link VimEngine}, driven through the same
 * `handleKey` the REPL calls. The other is a real `vim` in a temporary file,
 * fed a keystroke script and asked to write its own buffer back out. Neither
 * side is the authority on its own: the point is that every expectation below
 * is one real vim produced on this machine, so a test written by hand cannot
 * quietly encode what the engine happens to do.
 *
 * Both sides are compared on exactly two things — the buffer text and the cursor
 * offset — because those are the two the REPL shows. Mode is deliberately not
 * compared: real vim has no mode to report from a `-s` script, and a case that
 * turned on the mode difference would be measuring the harness.
 *
 * Real vim is required. Without it the runners here cannot say anything true,
 * so the entry points say so and exit 77 (the automake convention for "skipped")
 * rather than reporting a pass they did not earn.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VimEngine } from "../../src/vim.ts";

/** The buffer each side is handed and compared on. */
const DIR = mkdtempSync(join(tmpdir(), "vim-differential-"));
let counter = 0;

/** How long one `vim` invocation may take before it is treated as a skip. */
const VIM_TIMEOUT_MS = 15_000;

/**
 * Whether a `vim` on PATH can be driven this way.
 *
 * `-u NONE -N -i NONE` is a bare, nocompatible, no-viminfo vim: without those
 * three a developer's own `.vimrc` decides the behaviour being measured, which
 * would make every result below a statement about their configuration.
 */
export function haveVim() {
	try {
		const out = execFileSync("vim", ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: VIM_TIMEOUT_MS });
		return /VIM - Vi IMproved/.test(out.toString());
	} catch {
		return false;
	}
}

export const SKIP_EXIT_CODE = 77;

/** Print the reason a run cannot proceed, and leave with {@link SKIP_EXIT_CODE}. */
export function skipBecause(what) {
	console.log(`SKIPPED — ${what}`);
	console.log("  These cases are measured against a real vim. Put one on PATH and run again;");
	console.log("  a run that cannot compare is not a run that passed.");
	rmSync(DIR, { recursive: true, force: true });
	process.exit(SKIP_EXIT_CODE);
}

/**
 * Drive real vim over `kseq` and read back what it did.
 *
 * `kseq` is an array of single characters so a case reads as the keys it names;
 * `ESC` is spelled `"\\x1b"` and becomes a real escape in the script. A `null`
 * result means vim never reached the write, which is the case for a key it
 * refuses or a replay quirk — the caller decides whether that is a skip.
 */
export function runVim(text, cursor, kseq) {
	const id = `c${counter++}`;
	const inFile = join(DIR, `${id}.txt`);
	const outFile = join(DIR, `${id}.out`);
	const keys = join(DIR, `${id}.keys`);
	writeFileSync(inFile, text, "utf8");
	// The `out` path goes into a `:` command, so its separators are escaped there
	// and its own drive letter is left alone.
	const target = outFile.split("\\").join("\\\\");
	// `cursor` is a character offset, and neither obvious way to hand that to vim
	// will do. `{n}G` wants a *line*; `|` wants a *screen* column, so it counts a
	// wide character twice and puts the caret between the halves of a narrow
	// multibyte one — a case placed that way measures the caret's position, not
	// the engine's. `cursor()` is the one that takes a byte column, which is what
	// the offset converts to, and it puts the caret on the character that owns
	// that byte.
	const before = text.slice(0, cursor);
	const line = before.split("\n").length;
	const byteCol = Buffer.byteLength(before.slice(before.lastIndexOf("\n") + 1), "utf8") + 1;
	writeFileSync(
		keys,
		`:call cursor(${line}, ${byteCol})\r${kseq.join("")}` +
			// `col('.')` is a byte column and the comparison is in the offsets a
			// JavaScript string is indexed by, so vim is asked for the *prefix*
			// rather than for a count: `strpart()` takes bytes, and the string that
			// comes back is measured with `.length`, which is UTF-16 units. Asking
			// vim for a character count instead looks right and is not — vim has no
			// UTF-16, so `strchars()` answers a code point index and every
			// surrogate pair before the caret makes the two disagree by one. The
			// same reason rules out `match()`, whose `count` is a one-based
			// character *number* to skip and so answers one less besides.
			`\x1b:call writefile([json_encode([getline(1,'$'), line('.'), ` +
			`strpart(getline(line('.')), 0, col('.')-1)])], '${target}')\r:qall!\r`,
		"binary",
	);
	try {
		execFileSync(
			"vim",
			["-u", "NONE", "-N", "-i", "NONE", "-n", "--not-a-term", "--cmd", "set encoding=utf-8", "-s", keys, inFile],
			{ stdio: ["ignore", "pipe", "pipe"], timeout: VIM_TIMEOUT_MS },
		);
	} catch {
		return null;
	}
	let arr;
	try {
		arr = JSON.parse(readFileSync(outFile, "utf8").split("\n")[0]);
	} catch {
		return null;
	}
	const [lines, ln, prefix] = arr;
	let pos = 0;
	for (let i = 0; i < ln - 1; i++) pos += lines[i].length + 1;
	return { text: lines.join("\n"), cursor: pos + prefix.length };
}

/**
 * The keys a terminal sends that are not a printable character, in the two
 * spellings each side needs: the byte sequence `vim -s` replays, and the
 * `handleKey` override the REPL's input layer resolves it to.
 *
 * Both spellings live here rather than in the case files, because a case names a
 * key once and getting the two apart wrong makes every result a comparison of
 * two different key sequences.
 */
const TERMINAL_KEYS = {
	"\r": { return: true },
	"\x7f": { backspace: true },
	"\x1b[3~": { delete: true },
	"\x1b[4~": { end: true },
	"\x1b[A": { upArrow: true },
	"\x1b[B": { downArrow: true },
	"\x1b[C": { rightArrow: true },
	"\x1b[D": { leftArrow: true },
	"\x1b": { escape: true },
};

/**
 * The same keys the other way round, for a case that names the override the engine
 * takes rather than the bytes `vim -s` replays.
 *
 * Derived rather than written out again, because the fuzzer picking the wrong bytes
 * for a key does not fail loudly: it feeds vim a sequence the engine never saw and
 * reports the difference as a disagreement between the two editors.
 */
export const TERMINAL_SEQUENCES = Object.fromEntries(
	Object.entries(TERMINAL_KEYS).map(([bytes, overrides]) => [Object.keys(overrides)[0], bytes]),
);

/**
 * Drive this repository's engine over the same `kseq`.
 *
 * The host is the whole REPL pad's editing surface reduced to what a buffer of
 * plain text needs: `enterInsert`/`toNormal` are the REPL's own, `recallHistory`
 * is not a thing a single buffer has, and undo/redo are backed by real stacks
 * rather than no-ops so a case that reaches them measures something.
 *
 * A key the engine does not consume while it is in insert mode is the user's
 * next character — that fallback is how the REPL feeds it, and a case that ends
 * mid-insert depends on it.
 */
export function runEngine(text, cursor, kseq) {
	const state = { text, cursor };
	const undoStack = [];
	const redoStack = [];
	const snapshot = () => ({ text: state.text, cursor: state.cursor });
	const engine = new VimEngine({
		getText: () => state.text,
		getCursor: () => state.cursor,
		setCursor: (p) => {
			state.cursor = Math.max(0, Math.min(p, state.text.length));
		},
		setAll: (t, c) => {
			undoStack.push(snapshot());
			redoStack.length = 0;
			state.text = t;
			state.cursor = Math.max(0, Math.min(c, t.length));
		},
		enterInsert: () => {},
		toNormal: () => {},
		recallHistory: () => {},
		undo: () => {
			const s = undoStack.pop();
			if (s) {
				redoStack.push(snapshot());
				state.text = s.text;
				state.cursor = s.cursor;
			}
		},
		redo: () => {
			const s = redoStack.pop();
			if (s) {
				undoStack.push(snapshot());
				state.text = s.text;
				state.cursor = s.cursor;
			}
		},
	});
	for (const k of kseq) {
		const terminal = TERMINAL_KEYS[k];
		if (terminal !== undefined) {
			engine.handleKey("", terminal);
			continue;
		}
		const consumed = engine.handleKey(k, {});
		if (!consumed && engine.mode === "insert" && k.length === 1 && k >= " ") {
			state.text = state.text.slice(0, state.cursor) + k + state.text.slice(state.cursor);
			state.cursor += 1;
		}
	}
	return { text: state.text, cursor: state.cursor, mode: engine.mode };
}

/** The two answers to one case, and whether they agree. */
export function compare(text, cursor, kseq) {
	const vim = runVim(text, cursor, kseq);
	const ours = runEngine(text, cursor, kseq);
	return { vim, ours, ok: vim !== null && vim.text === ours.text && vim.cursor === ours.cursor };
}

/** One line describing a case, printed whether it matched or not. */
export function format(text, cursor, kseq, result) {
	const wanted = result.vim === null ? "vim <did not run>" : `${JSON.stringify(result.vim.text)}@${result.vim.cursor}`;
	return (
		`${result.ok ? "ok  " : "DIFF"} ${JSON.stringify(kseq.join("")).padEnd(16)} ` +
		`${JSON.stringify(text).padEnd(20)}@${String(cursor).padEnd(2)} ` +
		`vim ${wanted}  ours ${JSON.stringify(result.ours.text)}@${result.ours.cursor}`
	);
}

/** Remove the scratch directory both runners share. */
export function cleanup() {
	rmSync(DIR, { recursive: true, force: true });
}
