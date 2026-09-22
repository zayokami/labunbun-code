/**
 * `/status` as a card.
 *
 * The command used to print a block of lines into the transcript, which is the
 * one place a dozen details scroll away from the question they answer. It now
 * hands structured data to the card, so what is under test is that data: which
 * value came from which live source — the store's vim flag rather than the
 * startup setting, the measured context rather than a promise — and that the
 * transcript still records that the question was asked.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createStore, initialUiState, type StatusCardData, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand, shortenHome } from "../src/interactive.ts";

function makeCtx(options: { cwd?: string; sessionId?: string } = {}) {
	const home = mkdtempSync(join(tmpdir(), "lbb-status-"));
	const cwd = options.cwd ?? join(home, "project");
	const store = createStore<UiState>({ ...initialUiState(false) });
	const cards: Array<StatusCardData | null> = [];
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });

	const ctx = {
		getSession: () => session,
		handle: {
			store,
			setStatusCard: (card: StatusCardData | null) => cards.push(card),
		},
		home,
		cwd,
		settings: {},
		costTracker: {
			state: { totalCostUSD: 0.1234, totalDurationMs: 0, modelsUsage: {} },
			sessionState: { totalCostUSD: 0.0567, totalDurationMs: 0, modelsUsage: {} },
		},
		baseRules: [],
		sessionRules: [],
		commands: [],
		compaction: () => ({}),
		mcpConnections: [],
		mcpConfig: {},
		pendingMcpApprovals: [],
		sessionStore: () => (options.sessionId ? { sessionId: options.sessionId } : undefined),
		theme: { theme: { name: "nord" }, available: ["dark", "nord"], problems: [] },
		hotSwapSession: async () => {},
		switchModel: () => false,
	} as unknown as AppCommandContext;

	return { ctx, store, cards };
}

const infoTexts = (store: { get: () => UiState }) =>
	store
		.get()
		.entries.filter((e) => e.kind === "info")
		.map((e) => (e as { text: string }).text)
		.join("\n");

describe("/status", () => {
	test("fills the card from the live session, the store and the cost tracker", () => {
		const h = makeCtx({ sessionId: "abcdef0123456789" });
		h.store.set((s) => ({ ...s, contextInfo: { usedTokens: 42_000, threshold: 200_000 } }));
		expect(handleAppCommand("/status", h.ctx)).toBe(true);

		const card = h.cards[0];
		expect(card).toBeDefined();
		expect(card?.model).toBe(`${h.ctx.getSession()?.model.provider}/${h.ctx.getSession()?.model.id}`);
		expect(card?.directory).toBe(`~${sep}project`);
		expect(card?.permissions).toBe("default");
		expect(card?.session).toBe("abcdef01");
		expect(card?.context).toEqual({ usedTokens: 42_000, threshold: 200_000 });
		expect(card?.details.map(([label]) => label)).toEqual(["Cost", "Cache", "Theme", "MCP"]);
		// Both totals on one row: a single number here would be read as whichever of
		// the two the reader assumed, and the two differ by an order of magnitude.
		expect(card?.details[0]?.[1]).toContain("$0.0567 this session");
		expect(card?.details[0]?.[1]).toContain("$0.1234 this project");
		// A context with no tracker behind it says so rather than showing a number
		// nobody measured.
		expect(card?.details[1]?.[1]).toBe("not tracked");
		expect(card?.details[2]?.[1]).toContain("nord");
	});

	// The editor is the store's, not the settings file's: /vim may have flipped it
	// during the session, and a card that reports the startup value is lying about
	// the app the user is looking at.
	test("reports the vim mode the editor is actually in", () => {
		const h = makeCtx();
		handleAppCommand("/status", h.ctx);
		expect(h.cards[0]?.details[2]?.[1]).toContain("Vim off");

		h.store.set((s) => ({ ...s, vim: true }));
		handleAppCommand("/status", h.ctx);
		expect(h.cards[1]?.details[2]?.[1]).toContain("Vim on");
	});

	test("an unpersisted session says so instead of showing a blank id", () => {
		const h = makeCtx();
		handleAppCommand("/status", h.ctx);
		expect(h.cards[0]?.session).toBe("(not persisted)");
	});

	test("leaves one line in the transcript", () => {
		const h = makeCtx({ sessionId: "abcdef0123456789" });
		handleAppCommand("/status", h.ctx);
		const text = infoTexts(h.store);
		expect(text).toContain("Status:");
		expect(text).toContain("abcdef01");
		// The card is transient; the transcript is not, and it must not carry the
		// whole block that the card exists to replace.
		expect(text.split("\n")).toHaveLength(1);
	});

	test("a working directory outside the home directory is shown in full", () => {
		const h = makeCtx({ cwd: join(tmpdir(), "elsewhere") });
		handleAppCommand("/status", h.ctx);
		expect(h.cards[0]?.directory).toBe(join(tmpdir(), "elsewhere"));
	});
});

describe("shortenHome", () => {
	test("the home directory itself is a tilde", () => {
		expect(shortenHome(join("a", "b"), join("a", "b"))).toBe("~");
	});

	test("a path inside it keeps the rest, with the separator", () => {
		expect(shortenHome(join("a", "b", "c", "d"), join("a", "b"))).toBe(`~${sep}c${sep}d`);
	});

	test("a path that merely starts with the same letters is left alone", () => {
		// "ab" is not inside "a": a prefix match on the raw string would claim it.
		expect(shortenHome(join("ab", "c"), "a")).toBe(join("ab", "c"));
	});

	test("no home directory means no rewriting", () => {
		expect(shortenHome(join("a", "b"), undefined)).toBe(join("a", "b"));
	});
});
