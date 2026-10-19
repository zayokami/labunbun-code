/**
 * The sentence printed under `Error: <message>` when a run ends on a classified
 * provider failure.
 *
 * The classification is the agent's; the remedy is this app's, because every
 * sentence ends in a command only this layer dispatches. What is under test is
 * that each kind names an action that exists, and that the auth remedy matches
 * the wire the model is actually on — a sign-in hint on an env-keyed row, or an
 * export hint on a wire with no environment variable to export, is advice that
 * cannot work.
 */
import { describe, expect, test } from "bun:test";
import { FAUX_MODEL, type Model } from "@labunbun/ai";
import { errorRemedy } from "../src/error-remedy.ts";

function testModel(overrides: Partial<Model> = {}): Model {
	return { ...FAUX_MODEL, ...overrides };
}

describe("errorRemedy", () => {
	test("rate limit and overload name a wait and the switch that avoids it", () => {
		const rate = errorRemedy("rate_limit", testModel({ provider: "anthropic", id: "claude-sonnet-5" })) ?? "";
		expect(rate).toContain("anthropic is rate limiting claude-sonnet-5");
		expect(rate).toContain("wait a moment");
		expect(rate).toContain("/model");

		const overload = errorRemedy("overload", testModel({ provider: "openai", id: "gpt-5.6" })) ?? "";
		expect(overload).toContain("openai is overloaded");
		expect(overload).toContain("/model");
	});

	test("an auth remedy names the fix the model's wire actually takes", () => {
		// An ordinary env-keyed row: the variable is the whole fix.
		expect(
			errorRemedy("auth", testModel({ provider: "deepseek", id: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY" })),
		).toBe("No valid credential for deepseek/deepseek-chat — set DEEPSEEK_API_KEY in the environment.");

		// The two subscription wires name no variable by construction.
		const chatgpt = errorRemedy(
			"auth",
			testModel({ provider: "chatgpt", id: "gpt-5.6", api: "chatgpt-responses", apiKeyEnv: undefined }),
		);
		expect(chatgpt).toContain("/login chatgpt");
		const gemini = errorRemedy(
			"auth",
			testModel({ provider: "google", id: "gemini-row", api: "gemini-code-assist", apiKeyEnv: undefined }),
		);
		expect(gemini).toContain("/login gemini");

		// The anthropic wire runs on a key or a sign-in, and with neither variable
		// named the sign-in is the one left to name.
		const anthropic = errorRemedy(
			"auth",
			testModel({ provider: "anthropic", id: "claude-sonnet-5", apiKeyEnv: undefined }),
		);
		expect(anthropic).toContain("/login");
	});

	test("context overflow points at the two ways out", () => {
		const advice = errorRemedy("context_overflow", testModel()) ?? "";
		expect(advice).toContain("/compact");
		expect(advice).toContain("start a new session");
	});
});
