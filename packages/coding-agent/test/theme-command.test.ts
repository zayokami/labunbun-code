/**
 * `/theme` with no argument now picks from a list that previews itself.
 *
 * The command is driven through `handleAppCommand` with a stub handle standing
 * in for the REPL, so what is under test is the wiring: which theme the app is
 * told to show while the user moves, which one survives a cancel, and what gets
 * written down when the choice is confirmed. Every path runs against a throwaway
 * home — `/theme` writes the user's settings file, and a test must never touch
 * the real one.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createStore, initialUiState, type Theme, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { resolveTheme } from "../src/theme-file.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pick {
	title: string;
	items: Array<{ label: string; description?: string }>;
	onHighlight?: (index: number) => void;
	onCancel?: () => void;
}

async function makeCtx() {
	const home = mkdtempSync(join(tmpdir(), "lbb-theme-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-theme-cwd-"));
	const registry = await resolveTheme(undefined, cwd, home);
	const store = createStore<UiState>({ ...initialUiState(false), theme: registry.theme });

	const picks: Pick[] = [];
	let settle: ((index: number | null) => void) | undefined;
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });

	const ctx = {
		getSession: () => session,
		sessionRef: session,
		handle: {
			store,
			setTheme: (theme: Theme) => store.set((s) => ({ ...s, theme })),
			pickFromList: (title: string, items: Pick["items"], options?: Pick) => {
				picks.push({ title, items, ...options });
				return new Promise<number | null>((resolve) => {
					settle = resolve;
				});
			},
		},
		home,
		cwd,
		settings: {},
		costTracker: { state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} } },
		baseRules: [],
		sessionRules: [],
		commands: [],
		compaction: () => ({}),
		mcpConnections: [],
		mcpConfig: {},
		pendingMcpApprovals: [],
		sessionStore: () => undefined,
		theme: { ...registry, theme: registry.theme },
		hotSwapSession: async () => {},
		switchModel: () => false,
	} as unknown as AppCommandContext;

	return {
		ctx,
		store,
		home,
		names: registry.available,
		picks,
		finish: (index: number | null) => settle?.(index),
	};
}

function savedTheme(home: string): unknown {
	const path = join(home, ".labunbun", "settings.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { theme?: unknown }).theme : undefined;
}

const infoTexts = (store: { get: () => UiState }) =>
	store
		.get()
		.entries.filter((e) => e.kind === "info")
		.map((e) => (e as { text: string }).text)
		.join("\n");

/** Open the picker and hand back what the command passed to it. */
async function openPicker() {
	const h = await makeCtx();
	expect(handleAppCommand("/theme", h.ctx)).toBe(true);
	await delay(30);
	expect(h.picks).toHaveLength(1);
	return { ...h, pick: h.picks[0] };
}

describe("/theme without an argument", () => {
	test("offers every theme plus auto, marking the active one", async () => {
		const h = await openPicker();
		const labels = h.pick.items.map((item) => item.label.replace(/^\*?\s*/, ""));
		expect(labels).toEqual([...h.names, "auto"]);
		// The active theme is the one the user is looking at right now.
		expect(h.pick.items.find((item) => item.label.startsWith("*"))?.label).toContain(h.store.get().theme.name);
		h.finish(null);
	});

	test("moving the highlight repaints the app, and writes nothing", async () => {
		const h = await openPicker();
		const second = h.names[1];
		expect(second).toBeDefined();
		h.pick.onHighlight?.(1);

		expect(h.store.get().theme.name).toBe(second);
		expect(savedTheme(h.home)).toBeUndefined();
		h.finish(null);
	});

	test("cancelling puts the theme that was there back", async () => {
		const h = await openPicker();
		const was = h.store.get().theme.name;
		h.pick.onHighlight?.(1);
		expect(h.store.get().theme.name).not.toBe(was);

		h.pick.onCancel?.();
		h.finish(null);
		await delay(10);
		expect(h.store.get().theme.name).toBe(was);
		expect(savedTheme(h.home)).toBeUndefined();
	});

	test("confirming applies the highlighted theme and saves it", async () => {
		const h = await openPicker();
		const second = h.names[1];
		h.pick.onHighlight?.(1);
		h.finish(1);
		await delay(10);

		expect(h.store.get().theme.name).toBe(second);
		expect(savedTheme(h.home)).toBe(second);
		expect(infoTexts(h.store)).toContain(`Theme: ${second}`);
	});

	test("auto is resolved through the picker, not just named", async () => {
		const h = await openPicker();
		const index = h.pick.items.length - 1;
		h.pick.onHighlight?.(index);
		h.finish(index);
		await delay(10);

		// The probe cannot answer under a test's streams, so it lands on the
		// fallback — what matters is that a concrete theme was applied and that
		// what got written down is the word "auto".
		expect(["dark", "light"]).toContain(h.store.get().theme.name);
		expect(savedTheme(h.home)).toBe("auto");
		expect(infoTexts(h.store)).toContain("(detected)");
	});
});

describe("/theme with a name", () => {
	test("applies and saves it without opening anything", async () => {
		const h = await makeCtx();
		const name = h.names[2];
		handleAppCommand(`/theme ${name}`, h.ctx);
		await delay(30);

		expect(h.picks).toHaveLength(0);
		expect(h.store.get().theme.name).toBe(name);
		expect(savedTheme(h.home)).toBe(name);
	});

	test("an unknown name is reported and nothing is written", async () => {
		const h = await makeCtx();
		handleAppCommand("/theme definitely-not-a-theme", h.ctx);
		await delay(30);

		expect(infoTexts(h.store)).toContain("Unknown theme");
		expect(savedTheme(h.home)).toBeUndefined();
		expect(h.store.get().theme.name).toBe(h.ctx.theme.theme.name);
	});
});
