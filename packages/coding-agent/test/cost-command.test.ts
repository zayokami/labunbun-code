/**
 * `/cost` as the user meets it.
 *
 * The command's whole job is to be unambiguous about which total it is showing,
 * so what is under test here is the wiring: the session total read from the
 * session state and the project total from the project state, in that order,
 * both in the one line the transcript keeps.
 */
import { describe, expect, test } from "bun:test";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import type { CostState } from "../src/cost-tracker.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const SESSION: CostState = {
	totalCostUSD: 0.25,
	totalDurationMs: 0,
	modelsUsage: {
		"anthropic/claude-sonnet-5": {
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUSD: 0.25,
		},
	},
};

const PROJECT: CostState = {
	totalCostUSD: 12.5,
	totalDurationMs: 0,
	modelsUsage: {
		"anthropic/claude-sonnet-5": {
			inputTokens: 500_000,
			outputTokens: 250_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUSD: 12.5,
		},
	},
};

function makeCtx() {
	const store = createStore<UiState>({ ...initialUiState(false) });
	const ctx = {
		getSession: () => undefined,
		handle: { store },
		costTracker: { state: PROJECT, sessionState: SESSION },
	} as unknown as AppCommandContext;
	return { ctx, store };
}

const infoText = (store: { get: () => UiState }): string =>
	store
		.get()
		.entries.filter((e) => e.kind === "info")
		.map((e) => (e as { text: string }).text)
		.join("\n");

describe("/cost", () => {
	test("reports this conversation and this project, each under its own name", () => {
		const h = makeCtx();
		expect(handleAppCommand("/cost", h.ctx)).toBe(true);
		const text = infoText(h.store);
		expect(text).toContain("This session: $0.2500");
		expect(text).toContain("This project, all sessions: $12.5000");
		// Session first: it is the number the user is asking about, and the project
		// total is context for it rather than the answer.
		expect(text.indexOf("This session")).toBeLessThan(text.indexOf("This project"));
	});

	test("names a model it cannot price instead of counting it as free", () => {
		const h = makeCtx();
		(h.ctx as unknown as { costTracker: { state: CostState } }).costTracker.state = {
			totalCostUSD: 0,
			totalDurationMs: 0,
			modelsUsage: {
				"somebody/some-model": {
					inputTokens: 1_000,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUSD: 0,
				},
			},
		};
		handleAppCommand("/cost", h.ctx);
		expect(infoText(h.store)).toContain("No price is known for somebody/some-model");
	});
});
