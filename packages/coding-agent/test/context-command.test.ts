/**
 * `/context` as a card.
 *
 * The number on the status row raises a question — full of what, and is there
 * anything I can do — and this card is the answer. What is under test is that
 * the card is built from the live session: the same estimator the threshold
 * uses, the manager's own limits rather than a recomputation, and the memory
 * that was actually loaded.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentSession,
	type AnyTool,
	buildTool,
	CompactionManager,
	contextBreakdown,
	SessionStore,
} from "@labunbun/agent";
import { assistantMessage, FAUX_MODEL, fauxProvider, textContent, toolResultMessage, userMessage } from "@labunbun/ai";
import { createStore, initialUiState, type StatusCardData, type UiState } from "@labunbun/tui";
import { z } from "zod";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const MEMORY = "## Project memory\nRun the tests with bun.";
const CONFIG = { contextWindow: 200_000, maxOutputTokens: 8_192 };

/** Stands in for the toolset: a schema whose conversion costs real characters. */
const READ_TOOL: AnyTool = buildTool({
	name: "Read",
	description: "Read a file from disk",
	inputSchema: z.object({ file_path: z.string().describe("Path of the file to read") }),
	call: async () => ({ content: [] }),
});

function makeCtx(options: { store?: SessionStore } = {}) {
	const home = mkdtempSync(join(tmpdir(), "lbb-context-cmd-"));
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({
		model: FAUX_MODEL,
		// Memory arrives as a section of this prompt, the way buildSystemPrompt
		// writes it, so the card and the request are looking at the same thing.
		systemPrompt: `You are a coding agent. ${"word ".repeat(200)}\n\n# Project memory\n${MEMORY}`,
		// A real schema, because the session converts it to the JSON the model is
		// sent: those characters are part of what the card reports.
		tools: [READ_TOOL],
		deps: { streamFn: faux.streamFn },
	});
	// A conversation with the thing this card exists to point at: tool output.
	session.messages.push(
		userMessage("read the big file"),
		assistantMessageWithCall(),
		toolResultMessage("call_1", "Bash", [textContent("x".repeat(60_000))]),
	);
	const compaction = new CompactionManager(CONFIG, { streamFn: faux.streamFn, summarizerModel: FAUX_MODEL });

	const cards: Array<StatusCardData | null> = [];
	const store = createStore<UiState>({ ...initialUiState(false) });
	const ctx = {
		getSession: () => session,
		sessionRef: session,
		handle: {
			store,
			setStatusCard: (card: StatusCardData | null) => cards.push(card),
		},
		home,
		cwd: home,
		settings: {},
		costTracker: { state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} } },
		baseRules: [],
		sessionRules: [],
		commands: [],
		compaction: () => compaction,
		memory: MEMORY,
		mcpConnections: [],
		mcpConfig: {},
		pendingMcpApprovals: [],
		sessionStore: () => options.store,
		theme: { theme: { name: "nord" }, available: ["dark", "nord"], problems: [] },
		refreshContextInfo: () => {},
		hotSwapSession: async () => {},
		switchModel: () => false,
	} as unknown as AppCommandContext;

	return { ctx, session, compaction, cards, store };
}

/** An assistant turn that called the tool whose result is in the transcript. */
function assistantMessageWithCall() {
	return assistantMessage({
		content: [{ type: "toolCall", id: "call_1", name: "Bash", arguments: JSON.stringify({ command: "cat big" }) }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

const infoTexts = (store: { get: () => UiState }) =>
	store
		.get()
		.entries.filter((e) => e.kind === "info")
		.map((e) => (e as { text: string }).text)
		.join("\n");

const rowOf = (card: StatusCardData | null | undefined, label: string) =>
	card?.details.find(([name]) => name === label)?.[1];

describe("/context", () => {
	test("draws the same total the threshold is compared against, and the manager's own limits", () => {
		const h = makeCtx();
		handleAppCommand("/context", h.ctx);

		const card = h.cards[0];
		expect(card?.title).toBe("Context");
		// Recomputed here from the live context: the card is not allowed to have a
		// private arithmetic that could drift from the one compaction uses.
		const breakdown = contextBreakdown(h.session.currentContext());
		expect(card?.context).toEqual({
			usedTokens: breakdown.usedTokens,
			threshold: h.compaction.limits().threshold,
		});
		expect(rowOf(card, "System prompt")).toBeDefined();
		expect(rowOf(card, "Free before auto-compact")).toBeDefined();
	});

	test("names the tool results, and the memory that was loaded", () => {
		const h = makeCtx();
		handleAppCommand("/context", h.ctx);
		expect(rowOf(h.cards[0], "Messages")).toContain("1 tool result");
		// Where it lives, not whether it is still reachable: memory is a section
		// of the system prompt, so it is in every request by construction — and
		// the row says so rather than reading as tokens on top of the sum.
		expect(rowOf(h.cards[0], "Memory")).toContain("part of the system prompt");
	});

	test("memory survives a compaction that replaces every message", () => {
		// The property that matters: a request is the system prompt plus a
		// transcript, and memory is in the first. A session whose messages have
		// all been replaced by a boundary is not a session that stopped seeing
		// the rules it was started under.
		const h = makeCtx();
		h.session.applyCompaction({
			...h.session.currentContext(),
			messages: [userMessage("<summary of everything so far>")],
		});
		handleAppCommand("/context", h.ctx);
		expect(rowOf(h.cards[0], "Memory")).toContain("part of the system prompt");
		expect(h.session.currentContext().systemPrompt).toContain(MEMORY);
	});

	test("leaves one line in the transcript, not the block the card exists to hold", () => {
		const h = makeCtx();
		handleAppCommand("/context", h.ctx);
		const text = infoTexts(h.store);
		expect(text).toStartWith("Context: ");
		expect(text).toContain("of the auto-compact point");
		expect(text.split("\n")).toHaveLength(1);
	});

	test("a working directory with no memory files has no memory row", () => {
		const h = makeCtx();
		(h.ctx as unknown as { memory?: string }).memory = "";
		handleAppCommand("/context", h.ctx);
		expect(rowOf(h.cards[0], "Memory")).toBeUndefined();
	});

	test("counts the session's compactions, from the file rather than the chain", () => {
		// The count is asked of the session file, because that is what survives a
		// `/resume` — and it is counted over the whole file, because each compaction
		// re-roots the chain and the view of it holds at most one. Two of them here,
		// with the last one's reason and sizes.
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-context-store-")),
			mkdtempSync(join(tmpdir(), "lbb-context-home-")),
		);
		for (let round = 0; round < 2; round++) {
			const tail = [userMessage(`request ${round}`)];
			for (const message of tail) store.appendMessage(message);
			store.appendCompaction({
				boundary: userMessage(`[boundary ${round}]`),
				suffix: tail,
				summary: "1. Request: something earlier",
				preservedFiles: [],
				preTokens: 90_000,
				postTokens: 5_000,
				model: "faux-1",
				trigger: round === 1 ? "overflow" : "auto",
			});
		}
		const h = makeCtx({ store });

		handleAppCommand("/context", h.ctx);

		expect(rowOf(h.cards[0], "Compactions")).toBe("2 this session");
		expect(rowOf(h.cards[0], "Last compaction")).toBe("overflow · 90.0k → 5.0k");
	});

	test("a session with no file to read gets no compaction rows at all", () => {
		const h = makeCtx();
		handleAppCommand("/context", h.ctx);
		expect(rowOf(h.cards[0], "Compactions")).toBeUndefined();
		expect(rowOf(h.cards[0], "Last compaction")).toBeUndefined();
	});
});
