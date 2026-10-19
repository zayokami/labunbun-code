/**
 * `/rename`, wired.
 *
 * The sidecar has its own test. This one is about the two halves the command
 * moves together: the file that survives a restart, and the running app's
 * window title — a name written only to the disk would leave the title bar
 * naming the old session until the next launch, and a title set only in memory
 * is gone by tomorrow.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { readSessionTitle, SESSION_TITLE_MAX_CHARS, sessionTitlePath } from "../src/session-title.ts";

const ESC = String.fromCharCode(0x1b);

/** The session `makeCtx()` starts by default; the no-session case does not use it. */
function sessionOf(h: ReturnType<typeof makeCtx>): SessionStore {
	const session = h.session;
	if (!session) throw new Error("makeCtx() starts a session unless asked not to");
	return session;
}

function makeCtx(withSession = true) {
	const home = mkdtempSync(join(tmpdir(), "lbb-rename-"));
	const store = createStore<UiState>({ ...initialUiState(false) });
	const session = withSession ? SessionStore.startNew(home, home) : undefined;
	/** What the command told the window title, in order. */
	const titles: Array<string | undefined> = [];
	const ctx = {
		getSession: () => null,
		handle: { store, setSessionTitle: (title?: string) => titles.push(title) },
		home,
		cwd: home,
		sessionStore: () => session,
	} as unknown as AppCommandContext;
	return {
		ctx,
		session,
		titles,
		clean: () => rmSync(home, { recursive: true, force: true }),
		info: () =>
			store
				.get()
				.entries.filter((e) => e.kind === "info")
				.map((e) => (e as { text: string }).text)
				.join("\n"),
	};
}

describe("/rename", () => {
	test("with no session there is nothing to name", () => {
		const h = makeCtx(false);
		try {
			expect(handleAppCommand("/rename anything", h.ctx)).toBe(true);
			expect(h.info()).toContain("No session to rename.");
			expect(h.titles).toEqual([]);
		} finally {
			h.clean();
		}
	});

	test("no argument reports that the session is untitled", () => {
		const h = makeCtx();
		try {
			expect(handleAppCommand("/rename", h.ctx)).toBe(true);
			expect(h.info()).toContain("This session has no title.");
			expect(h.titles).toEqual([]);
		} finally {
			h.clean();
		}
	});

	test("a title is written to the sidecar and pushed to the window title", () => {
		const h = makeCtx();
		try {
			expect(handleAppCommand("/rename My release notes", h.ctx)).toBe(true);
			expect(h.info()).toContain("Session renamed: My release notes");
			expect(readSessionTitle(sessionOf(h).path)).toBe("My release notes");
			expect(h.titles).toEqual(["My release notes"]);
		} finally {
			h.clean();
		}
	});

	test("the next no-argument call reads the title back", () => {
		const h = makeCtx();
		try {
			handleAppCommand("/rename Release notes", h.ctx);
			handleAppCommand("/rename", h.ctx);
			expect(h.info()).toContain('This session is titled "Release notes".');
			expect(h.info()).toContain("/rename --clear");
		} finally {
			h.clean();
		}
	});

	test("--clear removes the sidecar and returns the title to the directory", () => {
		const h = makeCtx();
		try {
			handleAppCommand("/rename Release notes", h.ctx);
			expect(handleAppCommand("/rename --clear", h.ctx)).toBe(true);
			expect(h.info()).toContain("Session title cleared.");
			expect(existsSync(sessionTitlePath(sessionOf(h).path))).toBe(false);
			expect(h.titles).toEqual(["Release notes", undefined]);
		} finally {
			h.clean();
		}
	});

	test("extra whitespace collapses and quotes are dropped", () => {
		const h = makeCtx();
		try {
			handleAppCommand('/rename   "My    title"  ', h.ctx);
			expect(readSessionTitle(sessionOf(h).path)).toBe("My title");
			expect(h.titles).toEqual(["My title"]);
		} finally {
			h.clean();
		}
	});

	test("an overlong title is cut to the cap before it is stored", () => {
		const h = makeCtx();
		try {
			handleAppCommand(`/rename ${"x".repeat(500)}`, h.ctx);
			expect(Array.from(readSessionTitle(sessionOf(h).path) ?? "")).toHaveLength(SESSION_TITLE_MAX_CHARS);
			expect(h.info()).toContain(`Session renamed: ${"x".repeat(SESSION_TITLE_MAX_CHARS)}`);
		} finally {
			h.clean();
		}
	});

	test("a title with nothing visible is refused rather than stored as empty", () => {
		const h = makeCtx();
		try {
			handleAppCommand(`/rename ${ESC}[31m${ESC}[0m`, h.ctx);
			expect(h.info()).toContain("A title needs at least one visible character.");
			expect(existsSync(sessionTitlePath(sessionOf(h).path))).toBe(false);
			expect(h.titles).toEqual([]);
		} finally {
			h.clean();
		}
	});
});
