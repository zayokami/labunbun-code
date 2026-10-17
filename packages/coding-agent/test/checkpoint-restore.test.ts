/**
 * Restoring a checkpoint writes a session-file payload over a live workspace,
 * so it must refuse every destination that is not a plain, singly-linked file.
 *
 * A symlink would make `/rewind` overwrite whatever it points at — including a
 * file outside the project — and a hard link would silently rewrite the other
 * name sharing the inode. The capture side has the mirror-image rule: content
 * copied into the session file comes from regular files only, because following
 * a link there would put a file the session never named into the session file.
 *
 * Real temporary directories, real links: the guards are about what the
 * filesystem reports, and a mocked `lstat` would only re-test the mock. Windows
 * can refuse `symlinkSync` (EPERM without Developer Mode), so link cases are
 * probed once and skipped rather than failed there; the test names say so.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { createToolLedger, restoreCheckpointFile } from "../src/checkpoint-log.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

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

/** Whether this machine/filesystem lets a test make the link it needs. */
function linkWorks(make: (dir: string) => void): boolean {
	const dir = mkdtempSync(join(tmpdir(), "lbb-restore-probe-"));
	try {
		make(dir);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const canSymlinkFiles = linkWorks((dir) => {
	const target = join(dir, "target.txt");
	writeFileSync(target, "probe", "utf8");
	symlinkSync(target, join(dir, "link.txt"), process.platform === "win32" ? "file" : undefined);
});

const canHardLink = linkWorks((dir) => {
	const target = join(dir, "target.txt");
	writeFileSync(target, "probe", "utf8");
	linkSync(target, join(dir, "other-name.txt"));
});

/** The payloads of every `file_checkpoint` entry, in session-file order. */
function fileCheckpoints(store: SessionStore): unknown[] {
	const out: unknown[] = [];
	for (const entry of store.entries) {
		if (entry.type === "custom" && entry.kind === "file_checkpoint") out.push(entry.data);
	}
	return out;
}

/** The ledger under test: real files, a throwaway session file. */
function ledgerFor(store: SessionStore) {
	return createToolLedger({
		store: () => store,
		readFile: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
	});
}

describe("restoreCheckpointFile", () => {
	test("restores the content verbatim over a regular file", () => {
		const target = join(tempDir("lbb-restore-cwd-"), "notes.md");
		writeFileSync(target, "after the edit", "utf8");

		restoreCheckpointFile(target, "before\nsecond line\n");

		expect(readFileSync(target, "utf8")).toBe("before\nsecond line\n");
	});

	// Skipped where Windows forbids file symlinks (EPERM without Developer Mode).
	test.skipIf(!canSymlinkFiles)(
		"refuses a symlink and leaves its target untouched (skipped where Windows forbids symlinks)",
		() => {
			const dir = tempDir("lbb-restore-sym-");
			const target = join(dir, "target.md");
			const link = join(dir, "notes.md");
			writeFileSync(target, "original target", "utf8");
			symlinkSync(target, link, "file");

			expect(() => restoreCheckpointFile(link, "overwritten through the link")).toThrow(/symbolic link/i);

			expect(readFileSync(target, "utf8")).toBe("original target");
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
		},
	);

	// Skipped only where the filesystem cannot make hard links at all.
	test.skipIf(!canHardLink)(
		"refuses a hard-linked destination and leaves the other name untouched (skipped where hard links are unavailable)",
		() => {
			const dir = tempDir("lbb-restore-hard-");
			const target = join(dir, "target.md");
			const other = join(dir, "other-name.md");
			writeFileSync(target, "original target", "utf8");
			linkSync(target, other);

			expect(() => restoreCheckpointFile(other, "overwritten through the link")).toThrow(/hard link/i);

			expect(readFileSync(target, "utf8")).toBe("original target");
			expect(readFileSync(other, "utf8")).toBe("original target");
			expect(lstatSync(target).nlink).toBe(2);
		},
	);

	test("creates a path that does not exist yet, with the restore content", () => {
		const target = join(tempDir("lbb-restore-new-"), "created.md");

		restoreCheckpointFile(target, "the checkpoint's content");

		expect(readFileSync(target, "utf8")).toBe("the checkpoint's content");
		// The default the restore writes with; Windows reports synthetic mode
		// bits, so the exact number is a POSIX assertion.
		if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	test("a missing parent directory fails the way the plain write did", () => {
		const dir = tempDir("lbb-restore-parent-");
		const parent = join(dir, "no-such-dir");
		const target = join(parent, "file.md");

		// No mkdir on the caller's behalf: the old writeFileSync failed here and
		// the restore is not allowed to invent a tree the caller did not ask for.
		expect(() => restoreCheckpointFile(target, "x")).toThrow();
		expect(existsSync(target)).toBe(false);
		expect(existsSync(parent)).toBe(false);
	});

	test("does not widen the permissions the file arrived with", () => {
		const target = join(tempDir("lbb-restore-mode-"), "notes.md");
		writeFileSync(target, "old", "utf8");
		chmodSync(target, 0o640);
		const before = statSync(target).mode & 0o777;

		restoreCheckpointFile(target, "new");

		expect(readFileSync(target, "utf8")).toBe("new");
		expect(statSync(target).mode & 0o777).toBe(before);
	});
});

describe("checkpoint capture of linked files", () => {
	test("a regular file is still captured", () => {
		const target = join(tempDir("lbb-capture-cwd-"), "notes.md");
		writeFileSync(target, "before the edit", "utf8");
		const store = SessionStore.startNew(tempDir("lbb-capture-session-"), tempDir("lbb-capture-home-"));

		ledgerFor(store).noteBeforeMutation("Edit", { file_path: target });

		expect(fileCheckpoints(store)).toEqual([{ path: target, content: "before the edit", at: expect.any(Number) }]);
	});

	// Skipped where Windows forbids file symlinks (EPERM without Developer Mode).
	test.skipIf(!canSymlinkFiles)(
		"a symlink is not captured, so its target never enters the session file (skipped where Windows forbids symlinks)",
		() => {
			const dir = tempDir("lbb-capture-sym-");
			const secret = join(tempDir("lbb-capture-secret-"), "secret.md");
			const link = join(dir, "notes.md");
			writeFileSync(secret, "OUTSIDE SECRET", "utf8");
			symlinkSync(secret, link, "file");
			const store = SessionStore.startNew(tempDir("lbb-capture-session-"), tempDir("lbb-capture-home-"));

			ledgerFor(store).noteBeforeMutation("Edit", { file_path: link });

			expect(fileCheckpoints(store)).toEqual([]);
			expect(JSON.stringify(store.entries)).not.toContain("OUTSIDE SECRET");
		},
	);
});

describe("/rewind over a linked destination", () => {
	// Skipped where Windows forbids file symlinks (EPERM without Developer Mode).
	test.skipIf(!canSymlinkFiles)(
		"/rewind reports the refusal and records no rewind (skipped where Windows forbids symlinks)",
		() => {
			const home = tempDir("lbb-rewind-sym-home-");
			const cwd = tempDir("lbb-rewind-sym-cwd-");
			const store = SessionStore.startNew(cwd, home);
			const target = join(tempDir("lbb-rewind-sym-target-"), "outside.md");
			const link = join(cwd, "notes.md");
			writeFileSync(target, "outside content", "utf8");
			symlinkSync(target, link, "file");
			store.appendCustom("file_checkpoint", { path: link, content: "restored", at: 1 });
			const ui = createStore<UiState>(initialUiState(false));
			const ctx = {
				getSession: () => null,
				sessionStore: () => store,
				handle: { store: ui },
			} as unknown as AppCommandContext;

			expect(handleAppCommand("/rewind 0", ctx)).toBe(true);

			const info = ui
				.get()
				.entries.filter((entry) => entry.kind === "info")
				.map((entry) => (entry as { text: string }).text)
				.join("\n");
			expect(info).toContain("Restore failed");
			expect(info).toContain("symbolic link");
			expect(readFileSync(target, "utf8")).toBe("outside content");
			const rewinds = store.entries.filter((entry) => entry.type === "custom" && entry.kind === "rewind");
			expect(rewinds).toEqual([]);
		},
	);
});
