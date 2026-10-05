/**
 * `edit.ts` — the two gates in front of the write, the matching they hand the
 * text to, the diagnostic behind them, and what the result claims happened.
 *
 * Everything here runs against a temp directory under `%TEMP%`. No home
 * directory is consulted and no path outside the fixture is opened.
 *
 * Two shapes of test, deliberately interleaved rather than separated:
 *
 * - **Through the tool.** `createEditTool` + `createReadTool` over one
 *   `ReadFileState`, which is the wiring `createAllTools` builds. These are the
 *   rows that would go red if a gate stopped consulting the store, and the rows
 *   that can say "the file on disk now holds X" rather than "the tool returned
 *   X".
 * - **Against the pure helpers.** `findMatches`, `normalizeQuotes` and
 *   `explainMiss` are exported and are where the invariants live. The one that
 *   matters most is that quote normalization is length-preserving: `findMatches`
 *   searches the *normalized* text and slices the *original* at the offset it
 *   found, so a normalizer that changed a string's length would misalign every
 *   match in the file and the failure would be a plausible-looking wrong edit
 *   rather than an error. That is pinned below, by name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCanonical } from "../src/containment.ts";
import {
	applyLineEndings,
	detectLineEnding,
	type EditToolResult,
	explainMiss,
	findMatches,
	miniDiff,
	normalizeQuotes,
} from "../src/edit.ts";
import { createEditTool, createReadTool, createWriteTool, defaultOperations, ReadFileState } from "../src/index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-edit-"));
	roots.push(dir);
	return dir;
}

const ABORT = new AbortController().signal;
const ctx = { callId: "t1", signal: ABORT, cwd: process.cwd(), sandbox: "workspace-write", onUpdate: () => {} };
const call = (tool: any, input: unknown): Promise<EditToolResult> => tool.call(input, ctx);

/** The text a model would read off an Edit result. */
const textOf = (result: EditToolResult): string => (result.content[0] as any).text as string;

/**
 * Read and Edit over one `ReadFileState`, which is the wiring `createAllTools`
 * builds (`index.ts:127`/`:131`). Edit's first gate reads that store, so a row
 * that skips Read is testing the gate rather than the edit.
 */
function readEditPair(dir: string, ops = defaultOperations()): { edit: any; read: any; state: ReadFileState } {
	const state = new ReadFileState();
	return { edit: createEditTool(dir, ops, state), read: createReadTool(dir, ops, [], state), state };
}

function write(dir: string, name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, body);
	return file;
}

/**
 * A body longer than Read's 2000-line window, with a first line no other line
 * can contain.
 *
 * The marker is not decoration: `locate` counts `"line 1"` as an occurrence
 * inside `"line 10"`, `"line 100"` and 1,109 others, so a needle of "line 1"
 * in a generated list of that shape fails on uniqueness rather than on the rule
 * the row is about.
 */
function overTheReadWindow(lines = 2100): string {
	return Array.from({ length: lines }, (_, i) => (i === 0 ? "FIRST_UNIQUE_LINE" : `line ${i + 1}`)).join("\n");
}

// ---------------------------------------------------------------------------
// P1 — the two gates
// ---------------------------------------------------------------------------

describe("gate 1: the file must have been read this session", () => {
	test("an edit on a file nobody read is refused, and says so", async () => {
		const dir = tempDir();
		const file = write(dir, "unread.ts", "const a = 1;\n");
		const { edit } = readEditPair(dir);

		const result = await call(edit, { file_path: file, old_string: "const a = 1;", new_string: "const a = 2;" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("was not read this session");
		expect(readFileSync(file, "utf8")).toBe("const a = 1;\n");
	});

	test("a read that was forgotten is the same as a read that never happened", async () => {
		// `forget` is the only other way the store hands back `undefined`, and a
		// gate that treated it as "still read" would be a gate a caller could walk
		// past without touching the filesystem.
		const dir = tempDir();
		const file = write(dir, "forgotten.ts", "const a = 1;\n");
		const { edit, read, state } = readEditPair(dir);
		await call(read, { file_path: file });
		expect(state.forget(resolveCanonical(file, dir))).toBe(true);

		const result = await call(edit, { file_path: file, old_string: "const a = 1;", new_string: "const a = 2;" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("was not read this session");
	});

	test("a ranged read is not consent to rewrite the whole file", async () => {
		// The distinction the gate draws is not "was it opened" but "was it opened
		// whole": a page is a disjoint slice, and the replacement is applied to
		// every line of the file.
		const dir = tempDir();
		const file = write(dir, "paged.ts", Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file, offset: 1, limit: 5 });

		const result = await call(edit, { file_path: file, old_string: "line 1", new_string: "line one" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("was a range");
		expect(textOf(result)).toContain("offset/limit");
		expect(readFileSync(file, "utf8")).toContain("line 1");
	});

	test("a read that was cut is not refused by gate 1 — it is gate 2's question", async () => {
		// A file over Read's 2000-line window records `fullRead: true,
		// partialView: true`. Gate 1 passes it, and the staleness rule falls to
		// mtime rather than to a content comparison it cannot make.
		const dir = tempDir();
		const file = write(dir, "long.ts", overTheReadWindow());
		const { edit, read, state } = readEditPair(dir);
		await call(read, { file_path: file });
		expect(state.getState(resolveCanonical(file, dir))?.partialView).toBe(true);

		const result = await call(edit, {
			file_path: file,
			old_string: "FIRST_UNIQUE_LINE",
			new_string: "FIRST_UNIQUE_LINE_EDITED",
		});

		// The refusal text rides the assertion: when this failed on Windows CI the
		// log showed only `Received: true`, and *which* refusal fired was not
		// recoverable from it.
		expect(result.isError, result.isError ? textOf(result) : undefined).toBeUndefined();
		expect(readFileSync(file, "utf8")).toContain("FIRST_UNIQUE_LINE_EDITED\n");
	});
});

describe("gate 2: the file must not have changed since it was read", () => {
	test("a full read, then a change on disk, is refused", async () => {
		const dir = tempDir();
		const file = write(dir, "moved.ts", "const a = 1;\nconst b = 2;\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });
		// Someone else edited it — a formatter, a merge, another agent.
		writeFileSync(file, "const a = 1;\nconst b = 20;\n");

		const result = await call(edit, { file_path: file, old_string: "const b = 2;", new_string: "const b = 3;" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("changed since you read it");
		expect(textOf(result)).toContain("content no longer matches what you read");
		// The refusal left the other writer's bytes alone.
		expect(readFileSync(file, "utf8")).toBe("const a = 1;\nconst b = 20;\n");
	});

	test("the same file, read in full and untouched, is edited", async () => {
		const dir = tempDir();
		const file = write(dir, "still.ts", "const a = 1;\nconst b = 2;\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, { file_path: file, old_string: "const b = 2;", new_string: "const b = 3;" });

		expect(result.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("const a = 1;\nconst b = 3;\n");
	});

	test("a record for a file that has since been deleted refuses rather than writes it back", async () => {
		const dir = tempDir();
		const file = write(dir, "gone.ts", "const a = 1;\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });
		rmSync(file);

		const result = await call(edit, { file_path: file, old_string: "const a = 1;", new_string: "const a = 2;" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("File not found");
	});
});

describe("the Windows carve-out: mtime alone does not make a file stale", () => {
	test("a full read, an mtime bump and byte-identical content still edits", async () => {
		// OneDrive, Dropbox, Defender and every other file-watcher touch mtime on
		// files whose bytes did not move. A gate that refuses on that basis is a
		// gate users disable, and the direction is asymmetric on purpose: a false
		// "changed" costs one re-read, a false "unchanged" costs a wrong edit.
		const dir = tempDir();
		const body = "const a = 1;\nconst b = 2;\n";
		const file = write(dir, "touched.ts", body);
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const later = new Date(Date.now() + 60_000);
		utimesSync(file, later, later);
		// Assert the fixture is what it claims to be: an mtime change with no byte
		// change. Without this the row would still be testing gate 2's content rule.
		expect(readFileSync(file, "utf8")).toBe(body);

		const result = await call(edit, { file_path: file, old_string: "const b = 2;", new_string: "const b = 3;" });

		expect(result.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("const a = 1;\nconst b = 3;\n");
	});

	test("where there is nothing to compare, an mtime bump does refuse", async () => {
		// The other half of the pair, so the row above cannot be green because the
		// mtime rule stopped existing. `partialView` means `seen.content` is a
		// prefix rather than the file, so the file's own mtime is the only
		// evidence available — and it moved, so something wrote the file.
		const dir = tempDir();
		const file = write(dir, "long.ts", overTheReadWindow());
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const later = new Date(Date.now() + 60_000);
		utimesSync(file, later, later);

		const result = await call(edit, {
			file_path: file,
			old_string: "FIRST_UNIQUE_LINE",
			new_string: "FIRST_UNIQUE_LINE_EDITED",
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("mtime no longer matches your read");
		expect(readFileSync(file, "utf8")).toContain("FIRST_UNIQUE_LINE\n");
	});

	test("an mtime moved backwards is a write too — it refuses the same way", async () => {
		// The bump's symmetric case, and a strengthening: the old rule compared
		// the file's mtime against the instant of the read, so a file whose mtime
		// moved *back* (a restore from backup, an archive unpacked with stored
		// times) read as "untouched". Against a same-clock baseline, any change
		// at all is evidence the file was written.
		const dir = tempDir();
		const file = write(dir, "back.ts", overTheReadWindow());
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const earlier = new Date(Date.now() - 60_000);
		utimesSync(file, earlier, earlier);

		const result = await call(edit, {
			file_path: file,
			old_string: "FIRST_UNIQUE_LINE",
			new_string: "FIRST_UNIQUE_LINE_EDITED",
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("mtime no longer matches your read");
	});

	test("an mtime ahead of the reading process's clock is not a change", async () => {
		// mtime is the file's clock; the read instant is this process's. They need
		// not agree — a checkout from a machine with skew, a filesystem with
		// coarser timestamps, a CI runner mid time-sync — and a rule comparing one
		// against the other refuses edits on files nothing has touched. Measured
		// live: Windows CI refused this edit on a file written milliseconds
		// earlier in the same test. The baseline is the file's own mtime at read
		// time, so "did anything touch it" is asked in one clock, not two.
		const dir = tempDir();
		const file = write(dir, "ahead.ts", overTheReadWindow());
		const ahead = new Date(Date.now() + 60_000);
		utimesSync(file, ahead, ahead);
		const { edit, read, state } = readEditPair(dir);
		await call(read, { file_path: file });
		expect(state.getState(resolveCanonical(file, dir))?.partialView).toBe(true);

		const result = await call(edit, {
			file_path: file,
			old_string: "FIRST_UNIQUE_LINE",
			new_string: "FIRST_UNIQUE_LINE_EDITED",
		});

		expect(result.isError, result.isError ? textOf(result) : undefined).toBeUndefined();
		expect(readFileSync(file, "utf8")).toContain("FIRST_UNIQUE_LINE_EDITED\n");
	});

	test("a cut read that was edited keeps its staleness baseline current", async () => {
		const dir = tempDir();
		const file = write(dir, "two-edits.ts", overTheReadWindow());
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const first = await call(edit, {
			file_path: file,
			old_string: "FIRST_UNIQUE_LINE",
			new_string: "FIRST_UNIQUE_LINE_ONE",
		});
		expect(first.isError, first.isError ? textOf(first) : undefined).toBeUndefined();

		// No re-read: the successful edit re-recorded the file. If that record
		// carried the pre-edit mtime, this second edit — against the first one's
		// own output — would be refused as changed-since-read.
		const second = await call(edit, {
			file_path: file,
			old_string: "FIRST_UNIQUE_LINE_ONE",
			new_string: "FIRST_UNIQUE_LINE_TWO",
		});

		expect(second.isError, second.isError ? textOf(second) : undefined).toBeUndefined();
		expect(readFileSync(file, "utf8")).toContain("FIRST_UNIQUE_LINE_TWO\n");
	});
});

describe("a file the model wrote is a file it may edit", () => {
	test("the store treats a recorded write as a whole-file read", async () => {
		// `ReadFileState.record`'s documented case: recording over a path that was
		// never read means the model authored the content, so the whole-file badge
		// is correct. Recorded under `resolveCanonical` because that is the key Read
		// files under and the one Edit looks up with.
		const dir = tempDir();
		const body = "export const greeting = 'hello';\n";
		const file = write(dir, "written.ts", body);
		const { edit, state } = readEditPair(dir);
		state.record(resolveCanonical(file, dir), { content: body });

		const result = await call(edit, {
			file_path: file,
			old_string: "'hello'",
			new_string: "'hi'",
		});

		expect(result.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("export const greeting = 'hi';\n");
	});

	test("a successful edit re-records, so the second edit in a conversation works", async () => {
		// Without the refresh the second edit fails against the first one's own
		// output — gate 2 would compare the pre-edit text to the post-edit file.
		const dir = tempDir();
		const file = write(dir, "twice.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
		const { edit, read, state } = readEditPair(dir);
		await call(read, { file_path: file });

		const first = await call(edit, { file_path: file, old_string: "const a = 1;", new_string: "const a = 10;" });
		expect(first.isError).toBeUndefined();
		expect(state.getState(resolveCanonical(file, dir))?.content).toBe("const a = 10;\nconst b = 2;\nconst c = 3;\n");

		const second = await call(edit, { file_path: file, old_string: "const c = 3;", new_string: "const c = 30;" });
		expect(second.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n");
	});

	test("a file created with Write can then be edited", async () => {
		// The end-to-end version of the rule above. `ReadFileState`'s header calls
		// this out by name ("Recording over a path that was never read means the
		// model authored the content — a Write of a new file, which is the one case
		// where a file the model did not read is still a file whose whole content it
		// knows"), which only holds if the Write tool records too.
		const dir = tempDir();
		const file = join(dir, "created.ts");
		// **One store, shared.** The first version built the Write tool with no store
		// and handed Edit a brand-new one, so it asserted that a Write the session
		// recorded nowhere makes a file Edit will accept — which is the opposite of
		// the rule. It can only be true if the two tools do not share state, and two
		// tools that do not share state is the bug this gate exists to prevent.
		const store = new ReadFileState();
		const write = createWriteTool(dir, defaultOperations(), [], store);
		const edit = createEditTool(dir, defaultOperations(), store);

		const written = await call(write, { file_path: file, content: "const a = 1;\n" });
		expect(written.isError).toBeFalsy();

		const result = await call(edit, { file_path: file, old_string: "const a = 1;", new_string: "const a = 2;" });

		expect(result.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("const a = 2;\n");
	});

	test("writing over a cut read refreshes the baseline the next edit uses", async () => {
		// The cut view's `partialView` is carried through the Write's re-record
		// (the record still says the model never saw those bytes), so the next
		// edit's staleness rule is mtime — and the mtime that matters is the one
		// the write just produced. A pre-write baseline would read the write
		// itself as "changed since your read".
		const dir = tempDir();
		const file = join(dir, "rewritten.ts");
		const { read, state } = readEditPair(dir);
		writeFileSync(file, overTheReadWindow());
		await call(read, { file_path: file });

		const write = createWriteTool(dir, defaultOperations(), [], state);
		const edited = createEditTool(dir, defaultOperations(), state);
		const wrote = await call(write, { file_path: file, content: "const a = 1;\n" });
		expect(wrote.isError).toBeFalsy();
		// The premise of the row: the cut-view flag really did ride through.
		expect(state.getState(resolveCanonical(file, dir))?.partialView).toBe(true);

		const result = await call(edited, {
			file_path: file,
			old_string: "const a = 1;",
			new_string: "const a = 2;",
		});

		expect(result.isError, result.isError ? textOf(result) : undefined).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("const a = 2;\n");
	});
});

// ---------------------------------------------------------------------------
// P2 — line endings
// ---------------------------------------------------------------------------

describe("line endings", () => {
	test("a CRLF file stays CRLF and no line becomes LF", async () => {
		// The recorded defect this repository already has: no line-ending
		// normalisation, and the reference implementation rewrites every file it
		// touches to LF. A model builds `new_string` with `\n` regardless of what
		// the file uses, so the conversion has to happen here or a Windows
		// worktree acquires one mixed-ending line per edit.
		const dir = tempDir();
		const file = write(dir, "crlf.ts", "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, {
			file_path: file,
			old_string: "const b = 2;",
			// What a model actually types.
			new_string: "const b = 20;\nconst d = 4;",
		});

		expect(result.isError).toBeUndefined();
		const onDisk = readFileSync(file, "utf8");
		expect(onDisk).toBe("const a = 1;\r\nconst b = 20;\r\nconst d = 4;\r\nconst c = 3;\r\n");
		// Every newline is preceded by a carriage return: no bare LF anywhere.
		expect(onDisk.replace(/\r\n/g, "")).not.toContain("\n");
		expect(result.transformations).toContain("line-endings-preserved");
	});

	test("an LF file stays LF", async () => {
		const dir = tempDir();
		const file = write(dir, "lf.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, {
			file_path: file,
			old_string: "const b = 2;",
			new_string: "const b = 20;\nconst d = 4;",
		});

		expect(result.isError).toBeUndefined();
		const onDisk = readFileSync(file, "utf8");
		expect(onDisk).toBe("const a = 1;\nconst b = 20;\nconst d = 4;\nconst c = 3;\n");
		expect(onDisk).not.toContain("\r");
		expect(result.transformations).toEqual([]);
	});

	test("a CRLF old_string still matches a CRLF file exactly", async () => {
		// The other direction: the conversion is applied to the *replacement*, and
		// the needle still has to be the file's own bytes. A CRLF file read and
		// copied verbatim must not go through quote-normalized matching.
		const dir = tempDir();
		const file = write(dir, "verbatim.ts", "function f() {\r\n  return 1;\r\n}\r\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, {
			file_path: file,
			old_string: "function f() {\r\n  return 1;\r\n}",
			new_string: "function f() {\r\n  return 2;\r\n}",
		});

		expect(result.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("function f() {\r\n  return 2;\r\n}\r\n");
	});

	test("the helpers agree with what the file does", () => {
		expect(detectLineEnding("a\r\nb\r\nc\r\n")).toBe("crlf");
		expect(detectLineEnding("a\nb\nc\n")).toBe("lf");
		// A file with no newline at all is LF: nothing to preserve, and the
		// alternative adds a carriage return to a single-line file.
		expect(detectLineEnding("one line")).toBe("lf");
		expect(applyLineEndings("a\nb", "crlf")).toBe("a\r\nb");
		expect(applyLineEndings("a\r\nb", "crlf")).toBe("a\r\nb");
		expect(applyLineEndings("a\r\nb", "lf")).toBe("a\nb");
	});
});

// ---------------------------------------------------------------------------
// P3 — matching
// ---------------------------------------------------------------------------

describe("findMatches", () => {
	test("an exact match is found and labelled as one", () => {
		const content = "const a = 1;\nconst b = 2;\n";
		const plan = findMatches(content, "const b = 2;");
		expect(plan.strategy).toBe("exact");
		expect(plan.indices).toEqual([content.indexOf("const b = 2;")]);
		expect(plan.texts[0]).toBe("const b = 2;");
	});

	test("a curly-quote file is matched by a straight-quote old_string", () => {
		const content = "const a = 1;\nconst b = “two”;\nconst c = 3;\n";
		const plan = findMatches(content, 'const b = "two";');
		expect(plan.strategy).toBe("quote-normalized");
		expect(plan.indices).toHaveLength(1);
	});

	test("and what comes back is the file's own spelling, not the model's", () => {
		// The whole reason `texts` exists separately from `indices`: the splice
		// slices the ORIGINAL content at the model's spelling's length, so a
		// `texts` entry that echoed the model would corrupt the bytes around the
		// match.
		const content = "const a = 1;\nconst b = “two”;\nconst c = 3;\n";
		const plan = findMatches(content, 'const b = "two";');
		expect(plan.texts[0]).toBe("const b = “two”;");
		expect(content.slice(plan.indices[0], plan.indices[0] + plan.texts[0].length)).toBe(plan.texts[0]);
	});

	test("no match is no match, in either strategy", () => {
		expect(findMatches("const a = 1;\n", "const b = 2;").indices).toEqual([]);
		expect(findMatches("const a = “1”;\n", 'const b = "2";').indices).toEqual([]);
	});

	test("occurrences do not overlap", () => {
		// `"aaa".replaceAll("aa", "b")` is `"ba"`: one replacement. Counting the
		// overlap at index 1 would report a second that never happens.
		expect(findMatches("aaa", "aa").indices).toEqual([0]);
	});
});

describe("QUOTE NORMALISATION IS LENGTH-PRESERVING", () => {
	// `findMatches` searches `normalizeQuotes(content)` with
	// `normalizeQuotes(oldString)` and then slices the ORIGINAL string at the
	// offset it found there. Every match in the file depends on those offsets
	// being the same number. A normalizer that grew or shrank a string — mapping
	// `...` to `…`, folding a ligature, adding an astral curly quote — would make
	// every match land at the wrong offset, and the failure would be a
	// plausible-looking wrong edit rather than an error. This is the assertion
	// that says so; edit.ts:410-412 names it as the line that would break.
	test.each([
		["straight quotes", 'he said "hi"'],
		["curly doubles", "he said “hi”"],
		["curly singles", "it’s ‘fine’"],
		["german and reversed forms", "„low“ ‛high‛ ‚x‘ ’"],
		["mixed in one string", "“a\" b‘c’d 'e' “f”"],
		["nothing to change", "no quotes here at all"],
		["every mapped character", "“”„‟‘’‚‛"],
		["repeated", "“““”””"],
		["astral characters around a mapped one", "😀“x”🎉‘y’"],
	])("%s keeps its length", (_label, text) => {
		expect(normalizeQuotes(text).length).toBe(text.length);
	});

	test("every character it maps maps to exactly one character", () => {
		expect(normalizeQuotes("“”„‟‘’‚‛")).toBe("\"\"\"\"''''");
	});

	test("an offset found in the normalised text is the same offset in the original", () => {
		// The property the length-preservation buys, asserted through the caller
		// rather than through the normalizer alone: a needle several characters
		// past some curly quotes lands on the file's own spelling, and the slice
		// taken at that index is that spelling and not a neighbour of it.
		const content = "const a = “one”;\nconst b = “two”;\nconst c = “three”;\nconst d = “four”;\n";
		const plan = findMatches(content, 'const d = "four";');
		expect(plan.strategy).toBe("quote-normalized");
		expect(plan.indices).toHaveLength(1);
		expect(plan.indices[0]).toBe(content.indexOf("const d = “four”;"));
		expect(plan.texts[0]).toBe("const d = “four”;");
	});
});

describe("whitespace is not normalised, on purpose", () => {
	test("a stale indentation refuses rather than landing somewhere plausible", async () => {
		const body = "function f() {\n    return 1;\n}\n";
		const dir = tempDir();
		const file = write(dir, "indent.ts", body);
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, {
			file_path: file,
			old_string: "function f() {\n  return 1;\n}",
			new_string: "function f() {\n  return 2;\n}",
		});

		expect(result.isError).toBe(true);
		// The refusal is loud and the file is untouched. Fuzzy whitespace would
		// have made this *succeed*, at the cost of an edit the model did not ask
		// for.
		expect(readFileSync(file, "utf8")).toBe(body);
	});

	test("a tab is not two spaces", () => {
		expect(findMatches("\treturn 1;\n", "  return 1;\n").indices).toEqual([]);
	});

	test("internal spacing is not collapsed", () => {
		expect(findMatches("const a = 1 +  2;\n", "const a = 1 + 2;\n").indices).toEqual([]);
	});
});

describe("uniqueness", () => {
	test("an old_string that appears twice is refused with both occurrences named", async () => {
		const dir = tempDir();
		const file = write(dir, "twice-found.ts", "tick();\ntock();\ntick();\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, { file_path: file, old_string: "tick();", new_string: "tack();" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("appears 2 times");
		expect(textOf(result)).toContain("[0]");
		expect(textOf(result)).toContain("[1]");
		expect(readFileSync(file, "utf8")).toBe("tick();\ntock();\ntick();\n");
	});

	test("replace_all replaces every occurrence", async () => {
		const dir = tempDir();
		const file = write(dir, "all.ts", "tick();\ntock();\ntick();\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, {
			file_path: file,
			old_string: "tick();",
			new_string: "tack();",
			replace_all: true,
		});

		expect(result.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("tack();\ntock();\ntack();\n");
		expect(textOf(result)).toContain("2 replacement(s)");
	});
});

// ---------------------------------------------------------------------------
// P4 — the not-found diagnostic
// ---------------------------------------------------------------------------

describe("explainMiss", () => {
	test("a miss reports the differing lines with their line numbers", () => {
		// No trailing newline on the needle: a trailing newline makes the empty
		// last line of `old_string` a line to compare, and it is then reported as
		// differing from whatever follows the block.
		const content = "one\ntwo\nthree\nfour\n";
		const diagnostic = explainMiss(content, "one\nTWO\nthree");
		expect(diagnostic.anchor?.line).toBe(0);
		expect(diagnostic.differences).toEqual([{ line: 2, expected: "TWO", actual: "two" }]);
		expect(diagnostic.suggestion).toBeNull();
		expect(diagnostic.declined).toBe("not-indentation-only");
	});

	test("an indentation drift gets the file's own text back", () => {
		// The case `explainMiss` exists for: the commonest cause of a miss, and the
		// one the reference answers with a boolean.
		const content = "function f() {\n  const a = 1;\n}\n";
		const diagnostic = explainMiss(content, "function f() {\nconst a = 1;\n}\n");
		expect(diagnostic.suggestion).toBe("function f() {\n  const a = 1;\n}\n");
		expect(diagnostic.declined).toBeNull();
		expect(diagnostic.notes).toContain("the difference is leading whitespace only");
		// The contract: it is literally a slice of the file, so it occurs exactly
		// once and can be sent back unchanged.
		expect(findMatches(content, diagnostic.suggestion as string).indices).toHaveLength(1);
	});

	test("a suggested old_string sent back unchanged works", async () => {
		const body = "function f() {\n  const a = 1;\n}\n";
		const dir = tempDir();
		const file = write(dir, "recoverable.ts", body);
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const miss = await call(edit, {
			file_path: file,
			old_string: "function f() {\nconst a = 1;\n}\n",
			new_string: "function f() {\n  const a = 2;\n}\n",
		});
		expect(miss.isError).toBe(true);
		const suggestion = explainMiss(readFileSync(file, "utf8"), "function f() {\nconst a = 1;\n}\n").suggestion;
		expect(suggestion).not.toBeNull();

		const retried = await call(edit, {
			file_path: file,
			old_string: suggestion as string,
			new_string: "function f() {\n  const a = 2;\n}\n",
		});
		expect(retried.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("function f() {\n  const a = 2;\n}\n");
	});

	test("an old_string that spells out its escapes is respelled from the file", () => {
		// Direction one: the model double-escaped — `\n` as the two characters
		// backslash and `n` — where the file has a real line break. The miss is a
		// spelling, not a content difference, and the suggestion is the file's own
		// text, which the detector had to find exactly once before firing.
		const content = "const a = 1;\nconst b = 2;\n";
		const diagnostic = explainMiss(content, "const a = 1;\\nconst b = 2;");

		expect(diagnostic.suggestion).toBe("const a = 1;\nconst b = 2;");
		expect(diagnostic.declined).toBeNull();
		expect(diagnostic.notes.join("\n")).toContain("spells line breaks or tabs as the two-character escape sequences");
	});

	test("an escaped old_string, once respelled by the diagnostic, edits the file", async () => {
		const body = "const a = 1;\nconst b = 2;\n";
		const dir = tempDir();
		const file = write(dir, "escaped.ts", body);
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const miss = await call(edit, {
			file_path: file,
			old_string: "const a = 1;\\nconst b = 2;",
			new_string: "const a = 3;\nconst b = 4;",
		});
		expect(miss.isError).toBe(true);
		expect(textOf(miss)).toContain("Send this old_string back unchanged");
		const suggestion = explainMiss(readFileSync(file, "utf8"), "const a = 1;\\nconst b = 2;").suggestion;
		expect(suggestion).not.toBeNull();

		const retried = await call(edit, {
			file_path: file,
			old_string: suggestion as string,
			new_string: "const a = 3;\nconst b = 4;",
		});
		expect(retried.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("const a = 3;\nconst b = 4;\n");
	});

	test("a file that spells out its escapes is matched from the real characters", () => {
		// Direction two: the file itself contains the two characters — a source
		// literal *about* escapes — and the model unescaped when it copied. The
		// suggestion is again the file's text, this time with the escapes intact.
		const content = 'const msg = "line1\\nline2";\n';
		const diagnostic = explainMiss(content, 'const msg = "line1\nline2";');

		expect(diagnostic.suggestion).toBe('const msg = "line1\\nline2";');
		expect(diagnostic.notes.join("\n")).toContain(
			"the file spells line breaks or tabs as the two-character escape sequences",
		);
	});

	test("a tab spelled as an escape is respelled too", () => {
		const content = "first\tsecond\n";
		const diagnostic = explainMiss(content, "first\\tsecond");
		expect(diagnostic.suggestion).toBe("first\tsecond");
	});

	test("an escape with no unique match is reported as an ordinary miss", () => {
		// The bar the detector does not lower: a `\n` written as two characters is
		// not evidence on its own. Here the respelled block occurs nowhere, so
		// nothing is offered and nothing claims an escape caused the miss.
		const content = "const a = 1;\n";
		const diagnostic = explainMiss(content, "nothing\\nlike\\nthis");
		expect(diagnostic.suggestion).toBeNull();
		expect(diagnostic.notes.join("\n")).not.toContain("escape");
	});

	test("an escape that would land in two places is declined like any other ambiguity", () => {
		// Uniqueness is the bar for the respelled text exactly as it is for an
		// indentation rescue: a correction the real matcher finds twice would be
		// refused by Edit's own uniqueness rule, so it is not offered at all. The
		// two copies are separated by an island line — three identical lines in a
		// row would overlap, and the matcher counts non-overlapping matches only.
		const content = "const a = 1;\nconst a = 1;\n--\nconst a = 1;\nconst a = 1;\n";
		const diagnostic = explainMiss(content, "const a = 1;\\nconst a = 1;");
		expect(diagnostic.suggestion).toBeNull();
		expect(diagnostic.notes.join("\n")).not.toContain("escape");
	});

	test("and the suggestion is rendered even when no anchor was found", async () => {
		// The render path without a region line: the escaped spelling is too short
		// to anchor anywhere, yet the respelled block matches the file uniquely —
		// so the corrected text, not the generic "read it again" advice, is what
		// the model gets.
		const dir = tempDir();
		const file = write(dir, "short.ts", 'x = "a\\nb"\n');
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, { file_path: file, old_string: 'x = "a\nb"', new_string: 'x = "c"' });
		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("Send this old_string back unchanged");
		expect(text).toContain("the file spells line breaks or tabs");
		expect(text).not.toContain("No line of old_string resembles anything");
	});

	test("a CRLF-only drift is offered the file's own CRLF text back", () => {
		// Same class as the row above, one platform over: the file uses CRLF and
		// the model's `old_string` was typed with `\n`. `edit.ts` documents this
		// case twice — the prompt promises "when the only difference is
		// indentation or line endings, an `old_string` you can send back
		// unchanged", and `explainMiss` has a `crOnly` branch and a note saying
		// "the file uses CRLF line endings and your old_string did not".
		//
		// **The block must cover the same lines in both files.** The first version of
		// this row sent `"alpha\nbeta\n"` against a file whose next line is `gamma`,
		// so the model was asking for a trailing break that is not there — a genuine
		// line-count mismatch, and declining it is the correct answer. The suggestion
		// it asserted (`"alpha\r\nbeta\r\n"`) was also not text the model could send
		// back, so the row was asking for the wrong thing twice over.
		const content = "alpha\r\nbeta\r\ngamma\r\n";
		const diagnostic = explainMiss(content, "alpha\nbeta");

		// The file's own endings, and only over the lines the model actually named.
		expect(diagnostic.suggestion).toBe("alpha\r\nbeta");
		// And the note that names the actual cause.
		expect(diagnostic.notes.join("\n")).toContain("CRLF");
		expect(diagnostic.differences).toEqual([]);
		expect(diagnostic.declined).toBeNull();
	});

	test("a CRLF file and a line-count mismatch is declined, not answered as a CRLF case", () => {
		// The row above, and the shape that hid it: the model sends a trailing break
		// the file does not have. Refusing is right — but the refusal must not claim
		// the lines are identical, because they are not the lines the model asked
		// about. This is the "two answers under one name" failure, and it is why
		// the crOnly check had to move ahead of the equality check.
		const diagnostic = explainMiss("alpha\r\nbeta\r\ngamma\r\n", "alpha\nbeta\n");

		expect(diagnostic.suggestion).toBeNull();
		expect(diagnostic.declined).not.toBeNull();
		// Whatever it says, it must not simultaneously claim the only difference
		// was the line ending.
		expect(diagnostic.notes.join("\n")).not.toContain("CRLF");
	});

	test("when the anchor search is ambiguous it declines rather than guessing", () => {
		// The same corrected block sits twice in the file. Naming either one as
		// *the* region would put line numbers on the wrong copy, and a wrong
		// suggestion costs more turns than none.
		const content =
			"const alpha = 1;\n    const beta = 2;\nconst gamma = 3;\n---\nconst alpha = 1;\n    const beta = 2;\nconst delta = 4;\n";
		const diagnostic = explainMiss(content, "const alpha = 1;\n  const beta = 2;");

		expect(diagnostic.suggestion).toBeNull();
		expect(diagnostic.declined).toBe("suggestion-not-unique");
		// The unique-line search correctly refused the repeated line, and the
		// fallback located the region rather than picking one of the two at random.
		expect(diagnostic.anchor?.how).toBe("common-prefix");
	});

	test("and the ambiguity is said out loud rather than answered silently", async () => {
		const content =
			"const alpha = 1;\n    const beta = 2;\nconst gamma = 3;\n---\nconst alpha = 1;\n    const beta = 2;\nconst delta = 4;\n";
		const dir = tempDir();
		const file = write(dir, "ambiguous.ts", content);
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, {
			file_path: file,
			old_string: "const alpha = 1;\n  const beta = 2;",
			new_string: "const alpha = 9;\n  const beta = 9;",
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("No corrected old_string is offered");
		expect(textOf(result)).toContain("would not be unique in the file");
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	test("a line that resembles nothing in the file gets no anchor and no numbers", () => {
		const content = "const alpha = 1;\nconst beta = 2;\n";
		const diagnostic = explainMiss(content, "totally_unrelated_symbol();\nand_another();");
		expect(diagnostic.anchor).toBeNull();
		expect(diagnostic.differences).toEqual([]);
		expect(diagnostic.suggestion).toBeNull();
		expect(diagnostic.declined).toBe("no-anchor");
	});

	test("a block that runs past the end of the file is declined as such", () => {
		const content = "alpha\nbeta\n";
		const diagnostic = explainMiss(content, "alpha\nbeta\ngamma\ndelta\n");
		expect(diagnostic.suggestion).toBeNull();
		expect(diagnostic.declined).toBe("line-count-differs");
	});

	test("a miss with no anchor does not claim the lines are identical", async () => {
		const dir = tempDir();
		const file = write(dir, "nowhere.ts", "const alpha = 1;\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, {
			file_path: file,
			old_string: "somewhere_else_entirely()",
			new_string: "x",
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("No line of old_string resembles anything in the file");
		expect(textOf(result)).not.toContain("byte-identical");
	});

	test("a declined diagnostic does not also claim the difference is only whitespace", () => {
		// Two lines differ and only one of them is an indentation drift. The note is
		// about what the model should *do* — "the difference is leading whitespace
		// only", which here is false, and it is printed directly above "No corrected
		// old_string is offered (the lines differ by more than indentation and line
		// endings)".
		const content = "function f() {\n    const a = 1;\n    const b = 2;\n}\n";
		const diagnostic = explainMiss(content, "function f() {\n  const a = 1;\n    const bX = 2;\n}\n");

		expect(diagnostic.declined).toBe("not-indentation-only");
		expect(diagnostic.notes).not.toContain("the difference is leading whitespace only");
	});
});

describe("the rendered miss message", () => {
	test("it names the line, the differing lines, and what to send back", async () => {
		const dir = tempDir();
		const file = write(dir, "message.ts", "function f() {\n  const a = 1;\n}\nconst g = 2;\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, {
			file_path: file,
			old_string: "function f() {\nconst a = 1;\n}",
			new_string: "function f() {\nconst a = 2;\n}",
		});

		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("old_string not found in");
		expect(text).toContain("located by its first line");
		expect(text).toContain("Send this old_string back unchanged");
	});
});

// ---------------------------------------------------------------------------
// P5 — what the result claims happened
// ---------------------------------------------------------------------------

describe("reporting what happened", () => {
	test("newString is the bytes on disk, not the bytes that were requested", async () => {
		const dir = tempDir();
		// A file whose own spelling is curly, a straight-quote replacement, and a
		// multi-line replacement on an LF file. Every transformation that can fire
		// fires at once except the line-ending one, which needs a CRLF file.
		const file = write(dir, "curly.ts", 'const msg = “one”;\nconst other = "two";\n');
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const requested = 'const msg = "three";\nconst extra = "four";';
		const result = await call(edit, { file_path: file, old_string: 'const msg = "one";', new_string: requested });

		expect(result.isError).toBeUndefined();
		expect(result.newString).toBe("const msg = “three”;\nconst extra = “four”;");
		expect(result.transformations).toContain("quote-style-preserved");
		// The claim and the disk are the same string.
		const onDisk = readFileSync(file, "utf8");
		expect(onDisk).toContain(result.newString as string);
		expect(onDisk).toBe('const msg = “three”;\nconst extra = “four”;\nconst other = "two";\n');
		// The text the model reads repeats the on-disk string, so a model that
		// believes it wrote straight quotes is corrected by the result itself.
		expect(textOf(result)).toContain(result.newString as string);
	});

	test("transformations is empty when nothing was transformed", async () => {
		const dir = tempDir();
		const file = write(dir, "plain.ts", "const a = 1;\nconst b = 2;\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, { file_path: file, old_string: "const a = 1;", new_string: "const a = 2;" });

		expect(result.isError).toBeUndefined();
		expect(result.transformations).toEqual([]);
		expect(result.newString).toBe("const a = 2;");
	});

	test("a deletion reports the empty string it left behind", async () => {
		const dir = tempDir();
		const file = write(dir, "delete.ts", "one\ntwo\nthree\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, { file_path: file, old_string: "two", new_string: "" });

		expect(result.isError).toBeUndefined();
		expect(result.newString).toBe("");
		// The line break that followed the deletion is eaten with it, so no blank
		// line is left behind.
		expect(readFileSync(file, "utf8")).toBe("one\nthree\n");
	});

	test("a replacement that stops mid-line keeps the next line's break", async () => {
		const dir = tempDir();
		const file = write(dir, "inline.ts", "const a = 1; const b = 2;\nconst c = 3;\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, { file_path: file, old_string: "const a = 1;", new_string: "const a = 10;" });

		expect(result.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("const a = 10; const b = 2;\nconst c = 3;\n");
	});

	test("a write that does not land is reported rather than reported as success", async () => {
		// The read-back is the only thing that makes "newString is on disk" a fact
		// rather than an intention. Here something else wins the race and appends
		// to the file between the write and the read.
		const dir = tempDir();
		const file = write(dir, "raced.ts", "const a = 1;\n");
		const ops = defaultOperations();
		const inner = ops.writeTextFileAtomic.bind(ops);
		ops.writeTextFileAtomic = async (path, content) => {
			await inner(path, `${content}// appended by someone else\n`);
		};
		const { edit, read } = readEditPair(dir, ops);
		await call(read, { file_path: file });

		const result = await call(edit, { file_path: file, old_string: "const a = 1;", new_string: "const a = 2;" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("does not match what was written");
	});

	test("the diff is rendered from the offset, so a quote-normalized edit has one", () => {
		// `miniDiff` takes the offset rather than searching for the model's
		// spelling, because under quote normalization `indexOf` on that spelling
		// returns -1 for the very edit that needed the diff. The file has to be the
		// curly one for this to be the quote-normalized strategy at all.
		const content = "const a = “one”;\nconst b = “two”;\nconst c = 3;\n";
		const plan = findMatches(content, 'const b = "two";');
		expect(plan.strategy).toBe("quote-normalized");
		const diff = miniDiff(content, plan.indices[0], plan.texts[0], "const b = “TWO”;");
		expect(diff).toContain("@@ -2,1 +2,1 @@");
		expect(diff).toContain("- const b = “two”;");
		expect(diff).toContain("+ const b = “TWO”;");
	});

	test("a successful edit carries a diff hunk", async () => {
		const dir = tempDir();
		const file = write(dir, "diffed.ts", "one\ntwo\nthree\nfour\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const result = await call(edit, { file_path: file, old_string: "two", new_string: "TWO" });

		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toContain("@@ -2,1 +2,1 @@");
		expect(textOf(result)).toContain("- two");
		expect(textOf(result)).toContain("+ TWO");
	});
});

// ---------------------------------------------------------------------------
// The input guards
// ---------------------------------------------------------------------------

describe("validateInput", () => {
	// These two refusals live in `validateInput`, not in `call`, because the
	// pipeline runs them before the tool is invoked (`pipeline.ts:67`). Calling
	// `tool.call` directly — which is what every other row in this file does —
	// does not run them, so they are exercised through the hook itself.
	const editFor = (dir: string) => createEditTool(dir, defaultOperations(), new ReadFileState());

	test("an empty old_string is refused as matching every position", async () => {
		const tool = editFor(tempDir());
		const reason = await (tool as any).validateInput({ file_path: "x", old_string: "", new_string: "y" });
		expect(reason).toContain("old_string is empty");
	});

	test("identical old_string and new_string is refused as a no-op", async () => {
		const tool = editFor(tempDir());
		const reason = await (tool as any).validateInput({ file_path: "x", old_string: "y", new_string: "y" });
		expect(reason).toContain("identical");
	});

	test("an ordinary edit passes the guard", async () => {
		const tool = editFor(tempDir());
		expect(await (tool as any).validateInput({ file_path: "x", old_string: "a", new_string: "b" })).toBeNull();
	});
});
