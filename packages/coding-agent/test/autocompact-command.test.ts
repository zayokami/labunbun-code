/**
 * `/autocompact`, wired.
 *
 * The parser and the merge rule have their own test. This one is about the two
 * halves the command has to move together: the user's settings file, and the
 * session that is already running — a switch written only to the file would
 * take effect at the next startup, after the user has stopped thinking about
 * it, and a switch applied only to the session is gone by tomorrow.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

/** What the command told the running session, in order. */
type Applied = Array<{ enabled?: boolean; thresholdPercent?: number }>;

function makeCtx() {
	const home = mkdtempSync(join(tmpdir(), "lbb-autocompact-"));
	const store = createStore<UiState>({ ...initialUiState(false) });
	const applied: Applied = [];

	const ctx = {
		getSession: () => null,
		handle: { store },
		home,
		cwd: home,
		settings: {},
		costTracker: {
			state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} },
			sessionState: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} },
		},
		baseRules: [],
		sessionRules: [],
		commands: [],
		applyCompactionSettings: (patch: { enabled?: boolean; thresholdPercent?: number }) => applied.push(patch),
	} as unknown as AppCommandContext;

	const settingsPath = join(home, ".labunbun", "settings.json");
	return {
		ctx,
		home,
		applied,
		settingsPath,
		clean: () => rmSync(home, { recursive: true, force: true }),
		info: () =>
			store
				.get()
				.entries.filter((e) => e.kind === "info")
				.map((e) => (e as { text: string }).text)
				.join("\n"),
		settings: () => (existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : undefined),
	};
}

describe("/autocompact", () => {
	test("no argument reports the state and writes nothing", () => {
		const h = makeCtx();
		try {
			expect(handleAppCommand("/autocompact", h.ctx)).toBe(true);
			expect(h.info()).toContain("Auto-compaction is on: the trigger line comes from the window's reserve formula.");
			expect(h.applied).toEqual([]);
			expect(h.settings()).toBeUndefined();
		} finally {
			h.clean();
		}
	});

	test("off writes the user file and flips the running session", () => {
		const h = makeCtx();
		try {
			handleAppCommand("/autocompact off", h.ctx);
			expect(h.info()).toContain("Auto-compaction is off");
			expect(h.settings()).toEqual({ compaction: { enabled: false } });
			expect(h.applied).toEqual([{ enabled: false, thresholdPercent: undefined }]);
		} finally {
			h.clean();
		}
	});

	test("a percent sets the line, and `on` is what the write implies", () => {
		const h = makeCtx();
		try {
			handleAppCommand("/autocompact 70", h.ctx);
			expect(h.info()).toContain("Auto-compaction is on at 70% of the window.");
			// No `enabled` key lands in the file: a file that never said off is on,
			// and writing `true` would be a key whose value was already in effect.
			expect(h.settings()).toEqual({ compaction: { thresholdPercent: 70 } });
			expect(h.applied).toEqual([{ enabled: undefined, thresholdPercent: 70 }]);
		} finally {
			h.clean();
		}
	});

	test("the next report reads back what was written", () => {
		const h = makeCtx();
		try {
			handleAppCommand("/autocompact off", h.ctx);
			handleAppCommand("/autocompact", h.ctx);
			expect(h.info()).toContain("Auto-compaction is off");
		} finally {
			h.clean();
		}
	});

	test("an argument that is none of its forms is answered with the forms it has", () => {
		const h = makeCtx();
		try {
			handleAppCommand("/autocompact 150", h.ctx);
			handleAppCommand("/autocompact on off", h.ctx);
			expect(h.info()).toContain("Usage: /autocompact on | off | <percent 1-99>");
			expect(h.applied).toEqual([]);
			expect(h.settings()).toBeUndefined();
		} finally {
			h.clean();
		}
	});

	test("a settings file nobody can parse is reported, not overwritten", () => {
		const h = makeCtx();
		try {
			mkdirSync(join(h.home, ".labunbun"), { recursive: true });
			writeFileSync(h.settingsPath, "{ not json");
			handleAppCommand("/autocompact off", h.ctx);
			expect(h.info()).toContain("is not valid JSON");
			// The merge could not read what it was about to preserve, so it wrote
			// nothing — and the running session is untouched too.
			expect(readFileSync(h.settingsPath, "utf8")).toBe("{ not json");
			expect(h.applied).toEqual([]);
		} finally {
			h.clean();
		}
	});
});
