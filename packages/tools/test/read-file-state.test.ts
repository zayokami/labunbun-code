/**
 * The record Read leaves behind, and the two properties the edit gate rests on:
 * that a full read is distinguishable from a page, and that the record belongs
 * to one session rather than to the process.
 *
 * Everything here runs against a temp directory. No home directory is consulted
 * and no path outside the fixture is opened — the paths are the ones the tool
 * resolved itself, which is also how the gate will look them up.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseInsensitivePaths, resolveCanonical } from "../src/containment.ts";
import { createAllTools, createReadTool, defaultOperations, ReadFileState } from "../src/index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-readstate-"));
	roots.push(dir);
	return dir;
}

/**
 * The key an entry is filed under.
 *
 * Not the path as written: Read files it under `guardPathContainment`'s result,
 * and on macOS `mkdtempSync(join(tmpdir(), …))` answers `/var/folders/…` where
 * the filesystem says `/private/var/folders/…`. An Edit tool looks up with its
 * own `guardWritablePath` result, which goes through the same resolution, so
 * resolving here is the contract rather than a convenience.
 */
function keyOf(path: string, cwd: string): string {
	return resolveCanonical(path, cwd);
}

const ABORT = new AbortController().signal;
const ctx = { callId: "t1", signal: ABORT, cwd: process.cwd(), onUpdate: () => {} };
const call = (tool: any, input: unknown) => tool.call(input, ctx);

function readToolFor(cwd: string, state: ReadFileState) {
	return createReadTool(cwd, defaultOperations(), [], state);
}

describe("ReadFileState.record", () => {
	test("a read with neither offset nor limit is a full read", () => {
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "a\nb\n" });
		const entry = state.getState("/tmp/x.ts");
		expect(entry?.fullRead).toBe(true);
		expect(entry?.partialView).toBe(false);
		expect(entry?.content).toBe("a\nb\n");
		expect(typeof entry?.timestamp).toBe("number");
	});

	test.each([
		["offset", { offset: 10 }],
		["limit", { limit: 20 }],
		["both", { offset: 10, limit: 20 }],
	])("a read with %s is a page, not a full read", (_label, paging) => {
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "line", ...paging });
		expect(state.getState("/tmp/x.ts")?.fullRead).toBe(false);
	});

	test("a partial view is recorded when the caller says the bytes differ", () => {
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "# injected", partialView: true });
		expect(state.getState("/tmp/x.ts")?.partialView).toBe(true);
	});

	test("a partial view is not recorded when the content matches disk", () => {
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "on disk" });
		expect(state.getState("/tmp/x.ts")?.partialView).toBe(false);
	});

	test("the entry handed out is a frozen copy, not the stored one", () => {
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "first" });
		const first = state.getState("/tmp/x.ts");
		expect(Object.isFrozen(first)).toBe(true);
		state.record("/tmp/x.ts", { content: "second" });
		expect(first?.content).toBe("first");
		expect(state.getState("/tmp/x.ts")?.content).toBe("second");
	});

	test("a path read then forgotten no longer resolves", () => {
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "seen" });
		expect(state.getState("/tmp/x.ts")).toBeDefined();
		expect(state.forget("/tmp/x.ts")).toBe(true);
		expect(state.getState("/tmp/x.ts")).toBeUndefined();
		// Nothing to forget the second time, which is what makes it a Map answer
		// rather than a default object.
		expect(state.forget("/tmp/x.ts")).toBe(false);
	});

	test("paths lists what was recorded, and clear drops it", () => {
		const state = new ReadFileState();
		state.record("/tmp/a.ts", { content: "a" });
		state.record("/tmp/b.ts", { content: "b" });
		expect(state.paths()).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
		expect(state.size).toBe(2);
		state.clear();
		expect(state.paths()).toEqual([]);
		expect(state.size).toBe(0);
	});

	test("separators and, where the filesystem folds case, case name one entry", () => {
		const state = new ReadFileState();
		state.record("/tmp/Repo/FOO.ts", { content: "seen" });
		expect(state.getState("/tmp/Repo/foo.ts")?.content).toBe(caseInsensitivePaths ? "seen" : undefined);
		expect(state.getState("/tmp\\Repo\\FOO.ts")?.content).toBe("seen");
		expect(state.paths()).toEqual(["/tmp/Repo/FOO.ts"]);
	});
});

describe("re-recording after an edit", () => {
	test("replaces the entry instead of accumulating", () => {
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "before" });
		const first = state.getState("/tmp/x.ts");
		state.record("/tmp/x.ts", { content: "after" });
		const second = state.getState("/tmp/x.ts");
		expect(state.size).toBe(1);
		expect(second?.content).toBe("after");
		expect(second?.timestamp).toBeGreaterThanOrEqual(first?.timestamp ?? 0);
	});

	test("does not widen the view: a page re-recorded stays a page", () => {
		// The case that makes this a rule rather than a default: an edit tool that
		// re-records after applying an edit knows the file's new content and
		// nothing about what the model has seen of the rest of it. Recording
		// `{ content }` alone must not turn a 10-line page into a whole-file read.
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "line 10", offset: 10, limit: 1, partialView: true });
		state.record("/tmp/x.ts", { content: "line 10, edited" });
		const entry = state.getState("/tmp/x.ts");
		expect(entry?.content).toBe("line 10, edited");
		expect(entry?.fullRead).toBe(false);
		expect(entry?.partialView).toBe(true);
	});

	test("an explicit offset or partialView does override the carried flags", () => {
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "x", offset: 3, limit: 4, partialView: true });
		state.record("/tmp/x.ts", { content: "x, edited", offset: 3, partialView: false });
		const entry = state.getState("/tmp/x.ts");
		expect(entry?.fullRead).toBe(false);
		expect(entry?.partialView).toBe(false);
	});

	test("an mtime is carried the same way — a content-only re-record does not clear it", () => {
		// Same safe direction as the flags above: a caller that only knows the new
		// content must not silently drop the baseline the staleness check compares
		// a cut view against. A caller that *wrote* the file passes a fresh mtime
		// (that is the edit/write re-record), and that one replaces the old value.
		const state = new ReadFileState();
		state.record("/tmp/x.ts", { content: "before", mtime: 111 });
		state.record("/tmp/x.ts", { content: "after" });
		expect(state.getState("/tmp/x.ts")?.mtime).toBe(111);
		state.record("/tmp/x.ts", { content: "written", mtime: 222 });
		expect(state.getState("/tmp/x.ts")?.mtime).toBe(222);
	});

	test("a file the model wrote rather than read is a full read it may edit", () => {
		const state = new ReadFileState();
		state.record("/tmp/new.ts", { content: "what I just wrote" });
		expect(state.getState("/tmp/new.ts")?.fullRead).toBe(true);
	});
});

describe("what Read records", () => {
	test("a full read records the file byte for byte", () => {
		const dir = tempDir();
		const file = join(dir, "sample.ts");
		const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(file, body);
		const state = new ReadFileState();

		return call(readToolFor(dir, state), { file_path: file }).then(() => {
			const entry = state.getState(keyOf(file, dir));
			// Byte-identical, because a gate's staleness check compares this string
			// against a fresh read and anything else would make that check a guess.
			expect(entry?.content).toBe(readFileSync(file, "utf8"));
			expect(entry?.fullRead).toBe(true);
			expect(entry?.partialView).toBe(false);
		});
	});

	test("a ranged read records the range and says it is not the whole file", () => {
		const dir = tempDir();
		const file = join(dir, "sample.ts");
		writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
		const state = new ReadFileState();

		return call(readToolFor(dir, state), { file_path: file, offset: 11, limit: 5 }).then(() => {
			const entry = state.getState(keyOf(file, dir));
			expect(entry?.content).toBe("line 11\nline 12\nline 13\nline 14\nline 15");
			expect(entry?.fullRead).toBe(false);
			// Paging is what the model asked for, so it is not a partial view.
			expect(entry?.partialView).toBe(false);
		});
	});

	test("the recorded text is what a gate can match an old_string against", () => {
		const dir = tempDir();
		const file = join(dir, "sample.ts");
		writeFileSync(file, "const a = 1;\nconst b = 2;\n");
		const state = new ReadFileState();

		return call(readToolFor(dir, state), { file_path: file }).then(() => {
			const content = state.getState(keyOf(file, dir))?.content ?? "";
			// Read renders `     1\tconst a = 1;`. Recording that rendering would put
			// a tab between every pair of lines, and an `old_string` spanning two
			// lines would then match nothing the model ever saw.
			expect(content).toContain("const a = 1;\nconst b = 2;");
		});
	});

	test("a line over the per-line cap is recorded as a partial view", () => {
		const dir = tempDir();
		const file = join(dir, "long-line.txt");
		writeFileSync(file, `${"x".repeat(3000)}\nshort\n`);
		const state = new ReadFileState();

		return call(readToolFor(dir, state), { file_path: file }).then(() => {
			const entry = state.getState(keyOf(file, dir));
			expect(entry?.partialView).toBe(true);
			expect(entry?.content).toContain("…");
			expect(entry?.content).not.toContain("x".repeat(3000));
		});
	});

	test("a file longer than the default window is a partial view even unpaged", () => {
		const dir = tempDir();
		const file = join(dir, "long.txt");
		writeFileSync(file, Array.from({ length: 2100 }, (_, i) => `line ${i + 1}`).join("\n"));
		const state = new ReadFileState();

		return call(readToolFor(dir, state), { file_path: file }).then(() => {
			const entry = state.getState(keyOf(file, dir));
			// `fullRead` is about what the caller asked for and is true here; the
			// model still never saw lines 2001-2100. A gate that reads `fullRead`
			// alone would call this a whole-file read.
			expect(entry?.fullRead).toBe(true);
			expect(entry?.partialView).toBe(true);
			expect(entry?.content?.split("\n")).toHaveLength(2000);
		});
	});

	test("a result the pipeline will cut through the middle is a partial view", () => {
		const dir = tempDir();
		const file = join(dir, "wide.txt");
		// 2000 lines of 120 characters render past Read's 200_000-char result cap,
		// and `cutText` (`output-limits.ts:108`) keeps a head and a tail.
		writeFileSync(file, Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"y".repeat(110)}`).join("\n"));
		const state = new ReadFileState();

		return call(readToolFor(dir, state), { file_path: file }).then((result: { content: Array<any> }) => {
			expect((result.content[0] as any).text.length).toBeGreaterThan(200_000);
			expect(state.getState(keyOf(file, dir))?.partialView).toBe(true);
		});
	});

	test("a read that failed records nothing", async () => {
		const dir = tempDir();
		const state = new ReadFileState();
		const tool = readToolFor(dir, state);

		const missing = await call(tool, { file_path: join(dir, "not-here.txt") });
		expect(missing.isError).toBe(true);
		expect(state.getState(keyOf(join(dir, "not-here.txt"), dir))).toBeUndefined();

		const file = join(dir, "three-lines.txt");
		writeFileSync(file, "one\ntwo\nthree");
		const past = await call(tool, { file_path: file, offset: 99 });
		expect(past.isError).toBe(true);
		expect(state.getState(keyOf(file, dir))).toBeUndefined();
	});

	test("a failed read leaves an earlier record alone", async () => {
		const dir = tempDir();
		const file = join(dir, "sample.ts");
		writeFileSync(file, "one\ntwo\n");
		const state = new ReadFileState();
		const tool = readToolFor(dir, state);
		await call(tool, { file_path: file });
		const before = state.getState(keyOf(file, dir));

		await call(tool, { file_path: file, offset: 99 });
		expect(state.getState(keyOf(file, dir))).toEqual(before);
	});
});

describe("two sessions in one process", () => {
	test("one session's reads are invisible to the other", async () => {
		const dir = tempDir();
		const file = join(dir, "shared.ts");
		writeFileSync(file, "export const shared = true;\n");
		const mine = new ReadFileState();
		const theirs = new ReadFileState();

		await call(readToolFor(dir, mine), { file_path: file });

		expect(mine.getState(keyOf(file, dir))?.content).toBe("export const shared = true;\n");
		// The whole reason this is a class and not a module-level map: the second
		// conversation has to be told to read the file, not handed the first one's
		// record of it.
		expect(theirs.getState(keyOf(file, dir))).toBeUndefined();
		expect(theirs.size).toBe(0);
	});

	test("two tool sets from createAllTools keep two states apart", async () => {
		const dir = tempDir();
		const file = join(dir, "shared.ts");
		writeFileSync(file, "export const shared = true;\n");
		const first = new ReadFileState();
		const second = new ReadFileState();
		const readOf = (state: ReadFileState) =>
			createAllTools(dir, { operations: defaultOperations(), readState: state }).find((t) => t.name === "Read");

		await call(readOf(first), { file_path: file });
		await call(readOf(second), { file_path: file, offset: 1, limit: 1 });

		expect(first.getState(keyOf(file, dir))?.fullRead).toBe(true);
		expect(second.getState(keyOf(file, dir))?.fullRead).toBe(false);
		expect(first.getState(keyOf(file, dir))?.content).toBe("export const shared = true;\n");
	});

	test("the default state is built per call, never at module scope", () => {
		// The seam no behavioural test can reach: whether `createAllTools` makes
		// its own `ReadFileState` or reuses one that lives at module scope. Read
		// both files and pin the two construction sites, because a third one at
		// the top level would make the class above decorative.
		const src = join(import.meta.dir, "..", "src");
		const index = readFileSync(join(src, "index.ts"), "utf8");
		const read = readFileSync(join(src, "read.ts"), "utf8");

		expect(index).toContain("options.readState ?? new ReadFileState()");
		expect(index).toContain("createReadTool(cwd, ops, options.readOnlyRoots ?? [], readState)");
		expect(read).toContain("readState: ReadFileState = new ReadFileState()");
		const moduleLevel = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*new ReadFileState\(\)/m;
		expect(index).not.toMatch(moduleLevel);
		expect(read).not.toMatch(moduleLevel);
	});
});
