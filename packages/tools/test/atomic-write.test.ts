/**
 * `writeTextFileAtomic`'s failure ladder, and the temp file's lifetime on
 * every rung of it: the rename is the fast path, the fallback write covers the
 * filesystems where rename-over-existing fails (Windows), and the temp file
 * has to be gone after either outcome — including the one where the fallback
 * fails too and the caller sees that failure.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystemOperations } from "../src/operations.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "lbb-atomic-"));
	roots.push(dir);
	return dir;
};

describe("writeTextFileAtomic", () => {
	test("a replaced file keeps its content and leaves no temp sibling", async () => {
		const dir = tempDir();
		const path = join(dir, "file.txt");
		writeFileSync(path, "old");

		await new NodeFileSystemOperations().writeTextFileAtomic(path, "new");

		expect(readFileSync(path, "utf8")).toBe("new");
		expect(readdirSync(dir)).toEqual(["file.txt"]);
	});

	test("when rename fails and the fallback fails too, the temp file is still removed", async () => {
		const dir = tempDir();
		// A directory at the target path sends the write down the failure
		// ladder: the rename cannot replace a directory and the fallback write
		// lands on it too (EISDIR on POSIX, a failure on Windows) — so the
		// caller sees the fallback's error, and the temp file's sweep must not
		// depend on that write having succeeded.
		const path = join(dir, "target");
		mkdirSync(path);

		await expect(new NodeFileSystemOperations().writeTextFileAtomic(path, "new")).rejects.toThrow();

		expect(readdirSync(dir)).toEqual(["target"]);
	});
});
