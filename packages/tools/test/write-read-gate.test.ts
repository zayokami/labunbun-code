/**
 * `write.ts` — the read gate in front of an overwrite.
 *
 * Write replaces a whole file. For an existing file that is only safe when the
 * model was shown that file in this session, in full, and the bytes on disk are
 * still the bytes it was shown. A new file has no such content, and a tool
 * built without a `ReadFileState` keeps the pre-gate behavior because its
 * embedder never opted into the contract.
 *
 * Everything here runs against a temp directory under `%TEMP%`. The assertions
 * about a refusal read the file back from disk: "the tool returned an error" is
 * not the property this gate exists for; "the other writer's bytes survived" is.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCanonical } from "../src/containment.ts";
import { createEditTool, createReadTool, createWriteTool, defaultOperations, ReadFileState } from "../src/index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-write-gate-"));
	roots.push(dir);
	return dir;
}

const ABORT = new AbortController().signal;
const ctx = { callId: "t1", signal: ABORT, cwd: process.cwd(), sandbox: "workspace-write", onUpdate: () => {} };
const call = (tool: any, input: unknown) => tool.call(input, ctx);
const textOf = (result: any): string => (result.content[0] as any).text as string;

/** Read, Write and Edit over one store — the wiring `createAllTools` builds. */
function toolsFor(dir: string, state = new ReadFileState()) {
	const ops = defaultOperations();
	return {
		read: createReadTool(dir, ops, [], state),
		write: createWriteTool(dir, ops, [], state),
		edit: createEditTool(dir, ops, state),
		state,
	};
}

function existingFile(dir: string, name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, body);
	return file;
}

function overTheReadWindow(lines = 2100): string {
	return Array.from({ length: lines }, (_, i) => (i === 0 ? "FIRST_UNIQUE_LINE" : `line ${i + 1}`)).join("\n");
}

describe("Write's read gate", () => {
	test("a new file is created with no prior read, parent directories included", async () => {
		const dir = tempDir();
		const file = join(dir, "deep", "nested", "new.txt");
		const { write } = toolsFor(dir);

		const result = await call(write, { file_path: file, content: "hello\n" });

		expect(result.isError).toBeFalsy();
		expect(readFileSync(file, "utf8")).toBe("hello\n");
	});

	test("an existing file nobody read is refused and keeps its bytes", async () => {
		const dir = tempDir();
		const file = existingFile(dir, "unread.txt", "original\n");
		const { write } = toolsFor(dir);

		const result = await call(write, { file_path: file, content: "overwritten\n" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("was not read this session");
		expect(textOf(result)).toContain("no offset/limit");
		expect(readFileSync(file, "utf8")).toBe("original\n");
	});

	test("a paged read is not enough", async () => {
		const dir = tempDir();
		const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		const file = existingFile(dir, "paged.txt", body);
		const { read, write } = toolsFor(dir);
		await call(read, { file_path: file, offset: 1, limit: 5 });

		const result = await call(write, { file_path: file, content: "replaced\n" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("offset/limit");
		expect(textOf(result)).toContain("not the whole file");
		expect(readFileSync(file, "utf8")).toBe(body);
	});

	test("a partial view is refused even when the read was not paged", async () => {
		// What Read records for a file it had to cut: `fullRead` is true because
		// no page was asked for, and `partialView` is the flag that says the model
		// never received these bytes. Write's gate must consult the flag, not just
		// the paging arguments.
		const dir = tempDir();
		const body = overTheReadWindow();
		const file = existingFile(dir, "cut.txt", body);
		const { read, write, state } = toolsFor(dir);
		await call(read, { file_path: file });

		const key = resolveCanonical(file, dir);
		expect(state.getState(key)?.fullRead).toBe(true);
		expect(state.getState(key)?.partialView).toBe(true);

		const result = await call(write, { file_path: file, content: "replaced\n" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("partial view");
		expect(readFileSync(file, "utf8")).toBe(body);
		// The refusal neither forgets nor rewrites the evidence.
		expect(state.getState(key)?.partialView).toBe(true);
	});

	test("a full read allows the write", async () => {
		const dir = tempDir();
		const file = existingFile(dir, "read.txt", "const a = 1;\n");
		const { read, write } = toolsFor(dir);
		await call(read, { file_path: file });

		const result = await call(write, { file_path: file, content: "const a = 2;\n" });

		expect(result.isError, result.isError ? textOf(result) : undefined).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("const a = 2;\n");
	});

	test("a change after the read is refused, and the other writer's bytes survive", async () => {
		const dir = tempDir();
		const file = existingFile(dir, "moved.txt", "read me\n");
		const { read, write } = toolsFor(dir);
		await call(read, { file_path: file });
		// Someone else wrote it: content and mtime both move.
		const external = "written by someone else\n";
		writeFileSync(file, external);
		const later = new Date(Date.now() + 60_000);
		utimesSync(file, later, later);

		const result = await call(write, { file_path: file, content: "clobbered\n" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("changed since you read it");
		expect(textOf(result)).toContain("content no longer matches what you read");
		expect(readFileSync(file, "utf8")).toBe(external);
	});

	test("a successful write refreshes the record, so the next Edit passes the gate", async () => {
		const dir = tempDir();
		const file = existingFile(dir, "created.ts", "const a = 1;\n");
		const { read, write, edit, state } = toolsFor(dir);
		await call(read, { file_path: file });

		const wrote = await call(write, { file_path: file, content: "const a = 2;\n" });
		expect(wrote.isError).toBeFalsy();

		const key = resolveCanonical(file, dir);
		const entry = state.getState(key);
		expect(entry?.content).toBe("const a = 2;\n");
		expect(entry?.fullRead).toBe(true);
		expect(entry?.partialView).toBe(false);
		expect(typeof entry?.mtime).toBe("number");

		const edited = await call(edit, { file_path: file, old_string: "const a = 2;", new_string: "const a = 3;" });
		expect(edited.isError, edited.isError ? textOf(edited) : undefined).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("const a = 3;\n");
	});

	test("a file that vanished after its read may be created again", async () => {
		const dir = tempDir();
		const file = existingFile(dir, "gone.txt", "old content\n");
		const { read, write } = toolsFor(dir);
		await call(read, { file_path: file });
		rmSync(file);

		const result = await call(write, { file_path: file, content: "new content\n" });

		expect(result.isError, result.isError ? textOf(result) : undefined).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("new content\n");
	});

	test("a file that vanished after a paged read may still be created again", async () => {
		// The gate allows the create because stat says ENOENT. The record that
		// replaces the page has to state `fullRead`, or the next Edit would be
		// refused for a file this very call wrote in full.
		const dir = tempDir();
		const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		const file = existingFile(dir, "gone-paged.txt", body);
		const { read, write, edit, state } = toolsFor(dir);
		await call(read, { file_path: file, offset: 1, limit: 5 });
		rmSync(file);

		const result = await call(write, { file_path: file, content: "new content\n" });
		expect(result.isError, result.isError ? textOf(result) : undefined).toBeUndefined();
		const key = resolveCanonical(file, dir);
		expect(state.getState(key)?.fullRead).toBe(true);
		expect(state.getState(key)?.content).toBe("new content\n");

		const edited = await call(edit, { file_path: file, old_string: "new content", new_string: "edited" });
		expect(edited.isError, edited.isError ? textOf(edited) : undefined).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("edited\n");
	});

	test("a file that vanished after a cut read may still be created again", async () => {
		// Same edge as the paged case, plus the other carried flag: the cut read
		// was partial, but the file this call writes is exactly what the model
		// authored, so the record must not inherit the cut.
		const dir = tempDir();
		const file = existingFile(dir, "gone-cut.txt", overTheReadWindow());
		const { read, write, edit, state } = toolsFor(dir);
		await call(read, { file_path: file });
		const key = resolveCanonical(file, dir);
		expect(state.getState(key)?.partialView).toBe(true);
		rmSync(file);

		const result = await call(write, { file_path: file, content: "new content\n" });
		expect(result.isError, result.isError ? textOf(result) : undefined).toBeUndefined();
		expect(state.getState(key)?.fullRead).toBe(true);
		expect(state.getState(key)?.partialView).toBe(false);

		const edited = await call(edit, { file_path: file, old_string: "new content", new_string: "edited" });
		expect(edited.isError, edited.isError ? textOf(edited) : undefined).toBeUndefined();
	});

	test("without a readState, Write keeps its old behavior", async () => {
		// The two-argument factory is what a bare embedder or a unit test builds.
		// The gate is opt-in through the store, so this call must overwrite an
		// existing file without a read, exactly as it did before the gate existed.
		const dir = tempDir();
		const file = existingFile(dir, "legacy.txt", "old\n");
		const write = createWriteTool(dir, defaultOperations());

		const result = await call(write, { file_path: file, content: "new\n" });

		expect(result.isError).toBeFalsy();
		expect(readFileSync(file, "utf8")).toBe("new\n");
	});
});
