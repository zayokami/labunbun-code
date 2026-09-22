/**
 * `/vim` — the runtime toggle for modal editing.
 *
 * Two things have to be true at once: the editor changes now (so the flag is
 * store state, not a startup prop), and the choice survives to the next run (so
 * it is written to the user's settings). The second half is the dangerous one —
 * a command that rewrites a config file on a single keystroke — so it is tested
 * against a throwaway home, never the real one.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { SettingsSchema } from "../src/settings.ts";
import { writeUserSettingsPatch } from "../src/user-settings.ts";

/** A settings file per tier, in the shape `loadSettings` hands the commands. */
function settingsWithVim(vimMode: boolean, path = "/repo/.labunbun/settings.json") {
	return {
		settings: {},
		sources: { project: path },
		perSource: { project: SettingsSchema.parse({ vimMode }) },
		ignoredKeys: [],
	};
}

function makeCtx(
	vim: boolean,
	home = mkdtempSync(join(tmpdir(), "lbb-vim-")),
	tiers: ReturnType<typeof settingsWithVim> | undefined = undefined,
) {
	const store = createStore<UiState>({ ...initialUiState(vim) });
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const ctx = {
		getSession: () => session,
		handle: {
			store,
			setVimMode: (on: boolean) => store.set((s) => ({ ...s, vim: on })),
		},
		home,
		cwd: process.cwd(),
		settings: {},
		loadedSettings: tiers ?? { settings: {}, sources: {}, perSource: {}, ignoredKeys: [] },
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

describe("/vim command", () => {
	test("no argument toggles, and the editor follows immediately", () => {
		const { ctx, store } = makeCtx(false);
		expect(handleAppCommand("/vim", ctx)).toBe(true);
		expect(store.get().vim).toBe(true);
		expect(infoTexts(store)).toContain("Vim mode on");

		handleAppCommand("/vim", ctx);
		expect(store.get().vim).toBe(false);
		expect(infoTexts(store)).toContain("Vim mode off");
	});

	test("on and off are absolute, not toggles", () => {
		const { ctx, store } = makeCtx(false);
		handleAppCommand("/vim on", ctx);
		handleAppCommand("/vim on", ctx);
		expect(store.get().vim).toBe(true);
		handleAppCommand("/vim off", ctx);
		handleAppCommand("/vim off", ctx);
		expect(store.get().vim).toBe(false);
	});

	test("the choice is written to the user's settings, merged with what was there", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-vim-"));
		const { ctx, store } = makeCtx(false, home);
		// Something else already in the file must survive the write.
		writeUserSettingsPatch({ theme: "nord" }, home);
		handleAppCommand("/vim on", ctx);

		expect(savedSettings(home)).toEqual({ theme: "nord", vimMode: true });
		expect(store.get().vim).toBe(true);
	});

	// Written to the user's file, overridden by a project file at the next
	// startup — the same shape as the theme, and the same reason to say so.
	test("says which file will override the choice on the next start", () => {
		const { ctx, store } = makeCtx(false, undefined, settingsWithVim(false, "/repo/.labunbun/settings.local.json"));
		handleAppCommand("/vim on", ctx);

		expect(store.get().vim).toBe(true);
		expect(infoTexts(store)).toContain("Vim mode on");
		expect(infoTexts(store)).toContain("sets vimMode and wins on the next start");
		expect(infoTexts(store)).toContain("/repo/.labunbun/settings.local.json");
	});

	test("a nonsense argument changes nothing and says the usage", () => {
		const { ctx, store } = makeCtx(false);
		expect(handleAppCommand("/vim sideways", ctx)).toBe(true);
		expect(store.get().vim).toBe(false);
		expect(infoTexts(store)).toContain("Usage: /vim [on|off]");
	});

	test("an unwritable settings file still applies the mode, and says so", () => {
		// A directory where the settings file should be: the write fails, the
		// editor must not care.
		const home = mkdtempSync(join(tmpdir(), "lbb-vim-"));
		mkdirSync(join(home, ".labunbun", "settings.json"), { recursive: true });
		const { ctx, store } = makeCtx(false, home);
		handleAppCommand("/vim on", ctx);
		expect(store.get().vim).toBe(true);
		expect(infoTexts(store)).toContain("not saved");
	});
});
