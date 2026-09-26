/**
 * `/emacs` — the runtime toggle for modeless editing, and the exclusivity
 * between the two editors.
 *
 * Written beside `vim-command.test.ts` rather than inside it, because the two
 * commands are two names for one operation and the interesting cases are the
 * ones where they meet: whichever is turned on has to take the other down with
 * it, in the store *and* in the settings file, and has to say that it did.
 * Every home here is a throwaway. A test that writes a config file has to be
 * unable to reach the real one.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { writeUserSettingsPatch } from "../src/user-settings.ts";

function makeCtx(vim = false, emacs = false, home = mkdtempSync(join(tmpdir(), "lbb-emacs-"))) {
	const store = createStore<UiState>({ ...initialUiState(vim, emacs) });
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const ctx = {
		getSession: () => session,
		handle: {
			store,
			// The same two rules the real handle has, so the exclusivity under test
			// is the app's and not the stub's.
			setVimMode: (on: boolean) => store.set((s) => (on ? { ...s, vim: true, emacs: false } : { ...s, vim: false })),
			setEmacsMode: (on: boolean) =>
				store.set((s) => (on ? { ...s, emacs: true, vim: false } : { ...s, emacs: false })),
		},
		home,
		cwd: process.cwd(),
		settings: {},
		loadedSettings: { settings: {}, sources: {}, perSource: {}, ignoredKeys: [] },
		costTracker: { state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} } },
		baseRules: [],
		sessionRules: [],
		commands: [],
		compaction: () => ({}),
		mcpConnections: [],
		mcpConfig: {},
		pendingMcpApprovals: [],
		sessionStore: () => undefined,
		theme: { theme: { name: "dark" }, available: ["dark"], problems: [] },
		hotSwapSession: async () => {},
		switchModel: () => false,
	} as unknown as AppCommandContext;
	return { ctx, store, home };
}

function infoTexts(store: { get: () => UiState }): string {
	return store
		.get()
		.entries.filter((e) => e.kind === "info")
		.map((e) => (e as { text: string }).text)
		.join("\n");
}

function savedSettings(home: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(join(home, ".labunbun", "settings.json"), "utf8"));
	} catch {
		return null;
	}
}

describe("/emacs command", () => {
	test("no argument toggles, and the editor follows immediately", () => {
		const { ctx, store } = makeCtx();
		expect(handleAppCommand("/emacs", ctx)).toBe(true);
		expect(store.get().emacs).toBe(true);
		expect(infoTexts(store)).toContain("Emacs mode on");

		handleAppCommand("/emacs", ctx);
		expect(store.get().emacs).toBe(false);
		expect(infoTexts(store)).toContain("Emacs mode off");
	});

	test("on and off are absolute, not toggles", () => {
		const { ctx, store } = makeCtx();
		handleAppCommand("/emacs on", ctx);
		handleAppCommand("/emacs on", ctx);
		expect(store.get().emacs).toBe(true);
		handleAppCommand("/emacs off", ctx);
		handleAppCommand("/emacs off", ctx);
		expect(store.get().emacs).toBe(false);
	});

	test("the choice is written to the user's settings, merged with what was there", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-emacs-"));
		const { ctx, store } = makeCtx(false, false, home);
		writeUserSettingsPatch({ theme: "nord" }, home);
		handleAppCommand("/emacs on", ctx);

		expect(savedSettings(home)).toEqual({ theme: "nord", emacsMode: true, vimMode: false });
		expect(store.get().emacs).toBe(true);
	});

	test("a nonsense argument changes nothing and says the usage", () => {
		const { ctx, store } = makeCtx();
		expect(handleAppCommand("/emacs sideways", ctx)).toBe(true);
		expect(store.get().emacs).toBe(false);
		expect(infoTexts(store)).toContain("Usage: /emacs [on|off]");
	});

	test("an unwritable settings file still applies the mode, and says so", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-emacs-"));
		mkdirSync(join(home, ".labunbun", "settings.json"), { recursive: true });
		const { ctx, store } = makeCtx(false, false, home);
		handleAppCommand("/emacs on", ctx);
		expect(store.get().emacs).toBe(true);
		expect(infoTexts(store)).toContain("not saved");
	});
});

// The two commands are one operation on an exclusive pair, and these are the
// cases that justify sharing the implementation rather than writing `/emacs` as
// a copy of `/vim` and hoping they stay in step.
describe("the two editors are exclusive", () => {
	test("/emacs on takes vim down, in the store and in the file", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-emacs-"));
		const { ctx, store } = makeCtx(true, false, home);
		writeUserSettingsPatch({ vimMode: true }, home);

		handleAppCommand("/emacs on", ctx);
		expect(store.get().emacs).toBe(true);
		expect(store.get().vim).toBe(false);
		// The file matters as much as the store: a store that changed and a file
		// that did not is a run that ends in emacs and a next run that opens in
		// vim, which reads as the setting having been ignored.
		expect(savedSettings(home)).toEqual({ vimMode: false, emacsMode: true });
		expect(infoTexts(store)).toContain("cleared vimMode, which was also on");
	});

	test("/vim on takes emacs down, and says the same thing the other way round", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-emacs-"));
		const { ctx, store } = makeCtx(false, true, home);
		writeUserSettingsPatch({ emacsMode: true }, home);

		handleAppCommand("/vim on", ctx);
		expect(store.get().vim).toBe(true);
		expect(store.get().emacs).toBe(false);
		expect(savedSettings(home)).toEqual({ emacsMode: false, vimMode: true });
		expect(infoTexts(store)).toContain("cleared emacsMode, which was also on");
	});

	test("turning one off says nothing about the other, and leaves it alone", () => {
		// The notice is about a *change of standing*, so `/emacs off` has none to
		// make even when vim happens to be on. A line of noise here would train
		// people to skip the one that matters.
		const { ctx, store } = makeCtx(true, true);
		handleAppCommand("/emacs off", ctx);
		expect(store.get().emacs).toBe(false);
		expect(infoTexts(store)).not.toContain("cleared");
	});

	test("the toggle reads the running editor, not the settings file", () => {
		// Two `/emacs` in a row has to be two states, and the second one is only
		// the opposite of the first if the answer came from the store. Reading the
		// file instead would make the pair a no-op and the second line a lie.
		const home = mkdtempSync(join(tmpdir(), "lbb-emacs-"));
		const { ctx, store } = makeCtx(false, false, home);
		handleAppCommand("/emacs", ctx);
		expect(savedSettings(home)).toEqual({ emacsMode: true, vimMode: false });

		handleAppCommand("/emacs", ctx);
		expect(store.get().emacs).toBe(false);
		expect(savedSettings(home)).toEqual({ emacsMode: false, vimMode: false });
	});
});
