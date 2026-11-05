/**
 * Model profiles: the family a row belongs to, and the two prompt shapes that
 * follow from it.
 *
 * The point of these tests is not that a particular sentence is in the prompt.
 * It is that a gateway row is read as the model it serves rather than as the
 * gateway, that a small local model gets the short prompt, and that a session
 * with no model keeps the bytes it had before profiles existed. Those are the
 * three ways this layer can go quietly wrong.
 */
import { describe, expect, test } from "bun:test";
import type { Model } from "@labunbun/ai";
import {
	inferModelFamily,
	modelGuidanceSection,
	type ProfileModel,
	resolveModelProfile,
} from "../src/model-profile.ts";
import { buildSubagentContext, buildSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../src/system-prompt.ts";

function row(provider: string, id: string, contextWindow = 200_000): ProfileModel {
	return { provider, id, contextWindow };
}

/** The same row at the width `buildSystemPrompt` takes. */
function model(provider: string, id: string, contextWindow = 200_000): Model {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		contextWindow,
		maxOutputTokens: 8192,
		reasoning: false,
	};
}

describe("inferModelFamily", () => {
	test("a first-party row is read from its own id", () => {
		expect(inferModelFamily(row("anthropic", "claude-sonnet-5"))).toBe("anthropic");
		expect(inferModelFamily(row("openai", "gpt-5.5"))).toBe("openai");
		expect(inferModelFamily(row("google", "gemini-3-pro"))).toBe("google");
		expect(inferModelFamily(row("deepseek", "deepseek-v4"))).toBe("deepseek");
		expect(inferModelFamily(row("kimi", "kimi-k3"))).toBe("kimi");
		expect(inferModelFamily(row("qwen", "qwen3-coder"))).toBe("qwen");
		expect(inferModelFamily(row("glm", "glm-5.3"))).toBe("glm");
		expect(inferModelFamily(row("mistral", "codestral-2"))).toBe("mistral");
		expect(inferModelFamily(row("nvidia", "nemotron-3-ultra"))).toBe("nvidia");
	});

	test("a gateway row is read as the model it serves, not as the gateway", () => {
		// The provider names the route; the id names the model. Reading the
		// provider first would put every OpenRouter row in one "unknown" bucket.
		expect(inferModelFamily(row("openrouter", "anthropic/claude-opus-5"))).toBe("anthropic");
		expect(inferModelFamily(row("openrouter", "openai/gpt-5.5"))).toBe("openai");
		expect(inferModelFamily(row("opencode-zen", "google/gemini-3-pro"))).toBe("google");
		expect(inferModelFamily(row("opencode-go", "moonshotai/kimi-k3"))).toBe("kimi");
		expect(inferModelFamily(row("ollama-cloud", "glm-5.3"))).toBe("glm");
	});

	test("a row whose id carries no vendor word falls back to its provider", () => {
		expect(inferModelFamily(row("tencent", "hy4"))).toBe("tencent");
		expect(inferModelFamily(row("tencent", "hy4-preview"))).toBe("tencent");
		expect(inferModelFamily(row("xiaomi", "mimo-v2.6-pro"))).toBe("xiaomi");
		expect(inferModelFamily(row("meta", "muse-spark-1.1"))).toBe("meta");
	});

	test("a provider no family owns is unknown rather than guessed", () => {
		expect(inferModelFamily(row("my-gateway", "big-pickle"))).toBe("unknown");
		expect(inferModelFamily(row("my-gateway", ""))).toBe("unknown");
	});

	test("a local Ollama row keeps its model family but is still local enough to be short", () => {
		// The family is about behaviour the vendor is known for; the variant is
		// about how much prompt this particular row can carry.
		expect(inferModelFamily(row("ollama", "qwen3:7b"))).toBe("qwen");
		expect(resolveModelProfile(row("ollama", "qwen3:7b")).variant).toBe("lean");
	});
});

describe("resolveModelProfile", () => {
	test("a large first-party model gets the full prompt and its family's tool shape", () => {
		const profile = resolveModelProfile(row("anthropic", "claude-sonnet-5", 1_000_000));
		expect(profile.family).toBe("anthropic");
		expect(profile.label).toBe("Claude");
		expect(profile.variant).toBe("full");
		expect(profile.toolCalls).toBe("parallel");
		expect(profile.editStyle).toBe("exact");
	});

	test("a small window gets the lean prompt even on a first-party family", () => {
		// A discovered row can carry a window no table knows; the prompt is the
		// part that has to fit, not the model's reputation.
		const profile = resolveModelProfile(row("openai", "gpt-5.5", 16_000));
		expect(profile.family).toBe("openai");
		expect(profile.variant).toBe("lean");
		expect(profile.toolCalls).toBe("sequential");
		expect(profile.editStyle).toBe("whole-file");
	});

	test("a small local row is lean, sequential and whole-file", () => {
		for (const id of ["qwen3:7b", "llama3.2:3b", "gemma3:12b", "phi4"]) {
			const profile = resolveModelProfile(row("ollama", id, 128_000));
			expect(profile.variant, id).toBe("lean");
			expect(profile.toolCalls, id).toBe("sequential");
			expect(profile.editStyle, id).toBe("whole-file");
		}
	});

	test("a large local row keeps the full prompt", () => {
		const profile = resolveModelProfile(row("ollama", "llama4:120b", 128_000));
		expect(profile.variant).toBe("full");
	});

	test("a mixture-of-experts tag is read as its total parameter count", () => {
		// `8x7b` is a 56B model, not an 8B one: reading the first number alone
		// would put a large local model on the short prompt.
		expect(resolveModelProfile(row("ollama", "mixtral:8x7b", 32_000)).variant).toBe("full");
	});
});

describe("the model guidance section", () => {
	const claude = row("anthropic", "claude-sonnet-5", 1_000_000);
	const deepseek = row("deepseek", "deepseek-v4", 128_000);
	const unknown = row("my-gateway", "big-pickle", 128_000);

	test("names the model and the family", () => {
		const section = modelGuidanceSection(claude, resolveModelProfile(claude));
		expect(section).toContain("Current model: `anthropic/claude-sonnet-5` (Claude).");
	});

	test("carries the family's tool and edit shape", () => {
		const parallel = modelGuidanceSection(claude, resolveModelProfile(claude));
		expect(parallel).toContain("Batch independent read-only calls");
		expect(parallel).toContain("copy `old_string` verbatim");

		const sequential = modelGuidanceSection(deepseek, resolveModelProfile(deepseek));
		expect(sequential).toContain("one tool call at a time");
		expect(sequential).toContain("copy `old_string` verbatim");
	});

	test("an unknown family emits no section at all", () => {
		expect(modelGuidanceSection(unknown, resolveModelProfile(unknown))).toBeUndefined();
	});
});

describe("the system prompt with a model", () => {
	const base = { cwd: "G:\\work\\proj", platform: "win32", isTTY: true };
	const claude = model("anthropic", "claude-sonnet-5", 1_000_000);
	const local = model("ollama", "qwen3:7b", 128_000);

	test("no model keeps the prompt exactly as it was", () => {
		const prompt = buildSystemPrompt([], base);
		expect(prompt).toContain("# Attitude");
		expect(prompt).toContain("# Context");
		expect(prompt).not.toContain("# Model guidance");
	});

	test("a full-prompt model adds the section and keeps the full body", () => {
		const prompt = buildSystemPrompt([], { ...base, model: claude });
		expect(prompt).toContain("# Attitude");
		expect(prompt).toContain("# Model guidance");
		expect(prompt).toContain("(Claude)");
		// The section is below the marker: it is rebuilt on `/model`, and the
		// marker is the prompt's ordering claim about what is static.
		expect(prompt.indexOf("# Model guidance")).toBeGreaterThan(prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY));
	});

	test("a lean model gets the short body, not the full one with a section appended", () => {
		const prompt = buildSystemPrompt([], { ...base, model: local });
		expect(prompt).toContain("# Rules");
		expect(prompt).not.toContain("# Attitude");
		expect(prompt).not.toContain("# Context");
		expect(prompt).toContain("# Model guidance");
		expect(prompt.indexOf("# Model guidance")).toBeGreaterThan(prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY));
		expect(prompt.length).toBeLessThan(buildSystemPrompt([], { ...base, model: claude }).length);
	});

	test("the model section follows the tool guidance", () => {
		const tool = {
			name: "Read",
			description: "read",
			parameters: { type: "object" as const },
			prompt: "TOOL-MARKER",
			isConcurrencySafe: () => true,
			call: async () => ({ content: [] }),
		};
		const prompt = buildSystemPrompt([tool as never], { ...base, model: claude });
		expect(prompt.indexOf("# Tool guidance")).toBeLessThan(prompt.indexOf("# Model guidance"));
		expect(prompt).toContain("TOOL-MARKER");
	});
});

describe("a subagent's context with a model", () => {
	const base = { cwd: "G:\\work\\proj", platform: "win32", isTTY: false };

	test("no model keeps the block free of model guidance", () => {
		expect(buildSubagentContext(base)).not.toContain("# Model guidance");
	});

	test("a worker's own model adds its guidance, after the shared context", () => {
		const prompt = buildSubagentContext({ ...base, model: model("ollama", "qwen3:7b", 128_000) });
		expect(prompt).toContain("# Environment");
		expect(prompt).toContain("# Model guidance");
		expect(prompt).toContain("(Qwen)");
		// The worker's model, not the parent's: the section says `ollama/qwen3:7b`.
		expect(prompt).toContain("Current model: `ollama/qwen3:7b`");
		// A lean worker gets the conservative shapes even though Qwen's family
		// table says parallel.
		expect(prompt).toContain("one tool call at a time");
		expect(prompt).toContain("Write the whole file");
	});
});
