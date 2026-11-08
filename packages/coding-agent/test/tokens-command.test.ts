/**
 * `/tokens` — the runtime switch for the unit token counts are written in.
 *
 * The unit lives in the formatter, so two things have to be true at once: the
 * very next reading uses the new unit, and the choice survives to the next
 * run. The second half rewrites a settings file, so it is tested against a
 * throwaway home, never the real one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createStore, formatTokens, getTokenUnit, initialUiState, setTokenUnit, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { SettingsSchema } from "../src/settings.ts";

afterEach(() => setTokenUnit("k"));

/** A project tier setting the unit, in the shape `loadSettings` hands the commands. */
function settingsWithTokenUnit(tokenUnit: "k" | "mtok", path = "/repo/.labunbun/settings.json") {
	return {
		settings: {},
		sources: { project: path },
		perSource: { project: SettingsSchema.parse({ tokenUnit }) },
		ignoredKeys: [],
	};
}

function makeCtx(
	home = mkdtempSync(join(tmpdir(), "lbb-tokens-")),
	tiers: ReturnType<typeof settingsWithTokenUnit> | undefined = undefined,
) {
	const store = createStore<UiState>({ ...initialUiState(false) });
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const ctx = {
		getSession: () => session,
		handle: { store },
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

describe("/tokens command", () => {
	test("no argument toggles, and the next reading follows immediately", () => {
		const { ctx, store, home } = makeCtx();
		expect(getTokenUnit()).toBe("k");

		expect(handleAppCommand("/tokens", ctx)).toBe(true);
		expect(getTokenUnit()).toBe("mtok");
		expect(formatTokens(2_500_000)).toBe("2.5 MTok");
		expect(infoTexts(store)).toContain("Token unit: MTok");
		expect(savedSettings(home)).toEqual({ tokenUnit: "mtok" });

		handleAppCommand("/tokens", ctx);
		expect(getTokenUnit()).toBe("k");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(infoTexts(store)).toContain("Token unit: k");
		expect(savedSettings(home)).toEqual({ tokenUnit: "k" });
	});

	test("an explicit value sets the unit, and the toggle starts from it", () => {
		const { ctx, store } = makeCtx();
		handleAppCommand("/tokens mtok", ctx);
		expect(getTokenUnit()).toBe("mtok");

		handleAppCommand("/tokens", ctx);
		expect(getTokenUnit()).toBe("k");
		expect(infoTexts(store)).toContain("Token unit: k");
	});

	test("a value other than k or mtok changes nothing", () => {
		const { ctx, store, home } = makeCtx();
		expect(handleAppCommand("/tokens megabytes", ctx)).toBe(true);
		expect(getTokenUnit()).toBe("k");
		expect(infoTexts(store)).toContain("Usage: /tokens [k|mtok]");
		expect(savedSettings(home)).toBeNull();
	});

	test("a project tier that sets the unit is named, because it wins next start", () => {
		const path = "/repo/.labunbun/settings.json";
		const { ctx, store } = makeCtx(undefined, settingsWithTokenUnit("mtok", path));
		handleAppCommand("/tokens k", ctx);
		expect(infoTexts(store)).toContain(`sets tokenUnit and wins on the next start`);
	});
});
