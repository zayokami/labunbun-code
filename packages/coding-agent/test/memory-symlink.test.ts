/**
 * Memory reads must refuse links.
 *
 * A memory file reaches the system prompt as if the user had written it, so a
 * path that is a symlink is a way to inject a file from anywhere on the machine
 * through a name the loader trusts — a project LABUNBUN.md, a user MEMORY.md or
 * an `@include` swapped for a link. `readIfExists` therefore reads only regular
 * files of its own; a link, a directory or a broken link is "nothing to read".
 *
 * Real temporary directories and real symlinks throughout: a mocked `lstat`
 * would prove the branch was written, not that the loader and the filesystem
 * agree on what a link is. Windows can refuse `symlinkSync` (EPERM) unless
 * Developer Mode or SeCreateSymbolicLinkPrivilege is available, so the link
 * cases are probed once and skipped, not failed, on a machine that cannot make
 * one; the test names say which cases those are.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemoryNoteAt, expandIncludes, loadMemoryFiles, userMemoryPath } from "../src/memory.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp directory that is cleaned up after the test that made it. */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/**
 * Whether a link of this kind can be made here. `file` needs a Windows
 * privilege; `junction` does not, so directory-link coverage still runs there.
 * On POSIX the type argument is ignored and both are plain symlinks.
 */
function symlinkWorks(type: "file" | "junction"): boolean {
	const dir = mkdtempSync(join(tmpdir(), "lbb-memsym-probe-"));
	try {
		const target = join(dir, type === "file" ? "target.txt" : "target-dir");
		if (type === "file") writeFileSync(target, "probe", "utf8");
		else mkdirSync(target);
		symlinkSync(target, join(dir, "link"), type);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const canSymlinkFiles = symlinkWorks("file");
const canSymlinkDirs = symlinkWorks("junction");

/** Create the shape `userMemoryPath` names, so the user tier has one file. */
function userMemoryHome(): { home: string; memory: string } {
	const home = tempDir("lbb-memsym-home-");
	const memory = userMemoryPath(home);
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	return { home, memory };
}

describe("memory reads refuse links", () => {
	test("a regular memory file is still read", () => {
		const { home, memory } = userMemoryHome();
		writeFileSync(memory, "REGULAR USER MEMORY", "utf8");

		const result = loadMemoryFiles(tempDir("lbb-memsym-cwd-"), home);

		expect(result.content).toContain("REGULAR USER MEMORY");
		expect(result.files).toContain(memory);
	});

	// Skipped where Windows forbids file symlinks (EPERM without Developer Mode).
	test.skipIf(!canSymlinkFiles)(
		"a symlink to an outside file is not read (skipped where Windows forbids symlinks)",
		() => {
			const { home, memory } = userMemoryHome();
			const outside = tempDir("lbb-memsym-secret-");
			const secret = join(outside, "secret.md");
			writeFileSync(secret, "OUTSIDE SECRET", "utf8");
			symlinkSync(secret, memory, "file");

			const result = loadMemoryFiles(tempDir("lbb-memsym-cwd-"), home);

			expect(result.content).not.toContain("OUTSIDE SECRET");
			expect(result.files).toEqual([]);
		},
	);

	// Directory links use a junction on Windows, which needs no privilege; the
	// skip is only for machines whose filesystem refuses links entirely.
	test.skipIf(!canSymlinkDirs)(
		"a symlink to a directory is not read (skipped where the platform forbids symlinks)",
		() => {
			const { home, memory } = userMemoryHome();
			const directory = join(home, "a-directory");
			mkdirSync(directory);
			symlinkSync(directory, memory, process.platform === "win32" ? "junction" : "dir");

			const result = loadMemoryFiles(tempDir("lbb-memsym-cwd-"), home);

			expect(result.content).toBe("");
			expect(result.files).toEqual([]);
		},
	);

	// Skipped where Windows forbids file symlinks (EPERM without Developer Mode).
	test.skipIf(!canSymlinkFiles)("a broken symlink is not read (skipped where Windows forbids symlinks)", () => {
		const { home, memory } = userMemoryHome();
		const missing = join(tempDir("lbb-memsym-gone-"), "never-there.md");
		symlinkSync(missing, memory, "file");

		const result = loadMemoryFiles(tempDir("lbb-memsym-cwd-"), home);

		expect(result.content).toBe("");
		expect(result.files).toEqual([]);
	});
});

describe("a rules directory is never followed through a link", () => {
	test.skipIf(!canSymlinkDirs)(
		"a linked rules directory contributes nothing (skipped where the platform forbids links)",
		() => {
			const { home } = userMemoryHome();
			const outside = tempDir("lbb-memsym-rules-");
			writeFileSync(join(outside, "secret.md"), "OUTSIDE RULE", "utf8");
			symlinkSync(outside, join(home, ".labunbun", "rules"), process.platform === "win32" ? "junction" : "dir");

			const result = loadMemoryFiles(tempDir("lbb-memsym-cwd-"), home);

			expect(result.content).not.toContain("OUTSIDE RULE");
			expect(result.files).toEqual([]);
		},
	);
});

describe("@include containment resolves links before reading", () => {
	test.skipIf(!canSymlinkDirs)(
		"an intermediate directory link that escapes the root is a placeholder (skipped where links are forbidden)",
		() => {
			const root = tempDir("lbb-memsym-inc-root-");
			const outside = tempDir("lbb-memsym-inc-out-");
			writeFileSync(join(outside, "secret.md"), "INCLUDE SECRET", "utf8");
			symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");

			const expanded = expandIncludes("@link/secret.md", root);

			expect(expanded).toContain("include outside allowed directory");
			expect(expanded).not.toContain("INCLUDE SECRET");
		},
	);

	test.skipIf(!canSymlinkFiles)(
		"a direct file link that escapes the root is a placeholder (skipped where Windows forbids symlinks)",
		() => {
			const root = tempDir("lbb-memsym-inc2-");
			const outside = tempDir("lbb-memsym-inc2-out-");
			writeFileSync(join(outside, "secret.md"), "INCLUDE SECRET", "utf8");
			symlinkSync(join(outside, "secret.md"), join(root, "linked.md"), "file");

			const expanded = expandIncludes("@linked.md", root);

			expect(expanded).toContain("include outside allowed directory");
			expect(expanded).not.toContain("INCLUDE SECRET");
		},
	);
});

describe("the # note writer refuses links", () => {
	test.skipIf(!canSymlinkFiles)(
		"a symlinked MEMORY.md is refused and its target is untouched (skipped where Windows forbids symlinks)",
		() => {
			const { home, memory } = userMemoryHome();
			const outside = tempDir("lbb-memsym-note-out-");
			const target = join(outside, "target.md");
			writeFileSync(target, "ORIGINAL\n", "utf8");
			symlinkSync(target, memory, "file");

			expect(() => appendMemoryNoteAt(home, "leak")).toThrow(/symbolic link/);
			expect(readFileSync(target, "utf8")).toBe("ORIGINAL\n");
		},
	);

	test.skipIf(!canSymlinkDirs)(
		"a symlinked .labunbun directory is refused and nothing is created outside (skipped where links are forbidden)",
		() => {
			const home = tempDir("lbb-memsym-note2-home-");
			const outside = tempDir("lbb-memsym-note2-out-");
			symlinkSync(outside, join(home, ".labunbun"), process.platform === "win32" ? "junction" : "dir");

			expect(() => appendMemoryNoteAt(home, "leak")).toThrow(/symbolic link/);
			expect(existsSync(join(outside, "MEMORY.md"))).toBe(false);
		},
	);
});
