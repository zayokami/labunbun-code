/**
 * `/rewind` restores a file from a `file_checkpoint` entry in the session file.
 *
 * The payload it writes over a real file comes off disk, from a file the app
 * does not otherwise trust: a session that was damaged, hand-edited, or written
 * by a different build can hold a checkpoint entry whose data is not what this
 * build writes. `/rewind` is the one path where such an entry becomes a write
 * over a real file, so an entry it cannot fully read has to be refused — a
 * missing `content` defaulted to the empty string truncates the very file the
 * user asked to recover, and reports the restore as done.
 *
 * The other half is the numbering: entries are addressed by position, so an
 * unreadable entry that still occupies a slot shifts every entry after it onto
 * the wrong number.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp directory that is cleaned up with the run. */
function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

interface Harness {
	ctx: AppCommandContext;
	store: SessionStore;
	cwd: string;
	target: string;
	/** Everything the commands said, newest last. */
	info(): string;
}

/**
 * A session file and a file on disk, wired the way the REPL wires them: the
 * command reads the store it is handed, and says what it did through the UI
 * store underneath `handle`.
 */
function harness(): Harness {
	const home = scratch("lbb-rewind-home-");
	const cwd = scratch("lbb-rewind-cwd-");
	const store = SessionStore.startNew(cwd, home);
	const target = join(cwd, "notes.md");
	const ui = createStore<UiState>(initialUiState(false));
	const ctx = {
		getSession: () => null,
		sessionStore: () => store,
		handle: { store: ui },
	} as unknown as AppCommandContext;
	return {
		ctx,
		store,
		cwd,
		target,
		info: () =>
			ui
				.get()
				.entries.filter((entry) => entry.kind === "info")
				.map((entry) => (entry as { text: string }).text)
				.join("\n"),
	};
}

describe("/rewind over checkpoint entries this build cannot fully read", () => {
	test("an entry with no content does not truncate the file it names", () => {
		const h = harness();
		writeFileSync(h.target, "the user's notes", "utf8");
		// A payload this build did not write: the path is there, the content is
		// not. Restoring it used to write the empty default over the file.
		h.store.appendCustom("file_checkpoint", { path: h.target, at: Date.now() });

		expect(handleAppCommand("/rewind 0", h.ctx)).toBe(true);

		expect(readFileSync(h.target, "utf8")).toBe("the user's notes");
		expect(h.info()).not.toContain("Restored");
		expect(h.info()).toContain("cannot be read");
	});

	test("an unreadable entry between two good ones shifts no numbering", () => {
		const h = harness();
		writeFileSync(h.target, "on disk now", "utf8");
		h.store.appendCustom("file_checkpoint", { path: h.target, content: "first state", at: 1 });
		h.store.appendCustom("file_checkpoint", { path: h.target, at: 2 });
		h.store.appendCustom("file_checkpoint", { path: h.target, content: "second state", at: 3 });

		// With the unreadable entry counted, this number lands on it and the file
		// is truncated; with it refused, the number still names "second state".
		expect(handleAppCommand("/rewind 1", h.ctx)).toBe(true);

		expect(readFileSync(h.target, "utf8")).toBe("second state");
	});

	test("a fully readable checkpoint still restores", () => {
		const h = harness();
		writeFileSync(h.target, "after the edit", "utf8");
		h.store.appendCustom("file_checkpoint", { path: h.target, content: "before the edit", at: 1700000000000 });

		expect(handleAppCommand("/rewind 0", h.ctx)).toBe(true);

		expect(readFileSync(h.target, "utf8")).toBe("before the edit");
		expect(h.info()).toContain("Restored");
	});
});
