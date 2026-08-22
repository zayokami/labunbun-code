import { afterEach, describe, expect, test } from "bun:test";
import {
	apiKeyEnvNames,
	applyBaseUrlOverrides,
	baseUrlEnvVar,
	registerOpenAICompatibleProvider,
	resolveApiKey,
	resolveModel,
} from "../src/index.ts";

const TOUCHED = [
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"DEEPSEEK_BASE_URL",
	"ACME_AI_BASE_URL",
];
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
	if (!saved.has(name)) saved.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	for (const name of TOUCHED) {
		if (!saved.has(name)) continue;
		const original = saved.get(name);
		if (original === undefined) delete process.env[name];
		else process.env[name] = original;
	}
	saved.clear();
});

describe("baseUrlEnvVar", () => {
	test.each([
		["anthropic", "ANTHROPIC_BASE_URL"],
		["deepseek", "DEEPSEEK_BASE_URL"],
		// Provider ids are free-form, so anything not allowed in an env var name
		// becomes an underscore rather than producing an unreadable variable.
		["acme-ai", "ACME_AI_BASE_URL"],
		["acme.ai/v2", "ACME_AI_V2_BASE_URL"],
	])("%s → %s", (provider, expected) => {
		expect(baseUrlEnvVar(provider)).toBe(expected);
	});
});

describe("applyBaseUrlOverrides", () => {
	test("an override redirects the model, and absence leaves it alone", () => {
		const model = resolveModel("anthropic/claude-sonnet-5");
		if (!model) throw new Error("expected the built-in model to resolve");
		const builtIn = model.baseUrl;

		setEnv("ANTHROPIC_BASE_URL", undefined);
		expect(applyBaseUrlOverrides(model).baseUrl).toBe(builtIn);

		setEnv("ANTHROPIC_BASE_URL", "https://gateway.example/v1");
		expect(applyBaseUrlOverrides(model).baseUrl).toBe("https://gateway.example/v1");
		// resolveModel applies it too, which is what the providers actually read.
		expect(resolveModel("anthropic/claude-sonnet-5")?.baseUrl).toBe("https://gateway.example/v1");
		expect(resolveModel("claude-sonnet-5")?.baseUrl).toBe("https://gateway.example/v1");
	});

	test("a blank or whitespace override is ignored", () => {
		const model = resolveModel("anthropic/claude-sonnet-5");
		if (!model) throw new Error("expected the built-in model to resolve");
		for (const blank of ["", "   "]) {
			setEnv("ANTHROPIC_BASE_URL", blank);
			expect(applyBaseUrlOverrides(model).baseUrl).toBe(model.baseUrl);
		}
	});

	test("the override is per provider", () => {
		setEnv("ANTHROPIC_BASE_URL", "https://only-anthropic.example");
		expect(resolveModel("deepseek/deepseek-chat")?.baseUrl).not.toBe("https://only-anthropic.example");
	});

	test("does not mutate the registry entry it copies from", () => {
		setEnv("ANTHROPIC_BASE_URL", undefined);
		const before = resolveModel("anthropic/claude-opus-5")?.baseUrl;
		setEnv("ANTHROPIC_BASE_URL", "https://temporary.example");
		resolveModel("anthropic/claude-opus-5");
		setEnv("ANTHROPIC_BASE_URL", undefined);
		expect(resolveModel("anthropic/claude-opus-5")?.baseUrl).toBe(before);
	});
});

describe("resolveApiKey", () => {
	test("the primary variable wins when both are set", () => {
		const model = resolveModel("anthropic/claude-sonnet-5");
		if (!model) throw new Error("expected the built-in model to resolve");
		setEnv("ANTHROPIC_API_KEY", "primary");
		setEnv("ANTHROPIC_AUTH_TOKEN", "fallback");
		expect(resolveApiKey(model)).toBe("primary");
	});

	test("the fallback is used when the primary is unset or empty", () => {
		const model = resolveModel("anthropic/claude-sonnet-5");
		if (!model) throw new Error("expected the built-in model to resolve");
		setEnv("ANTHROPIC_API_KEY", undefined);
		setEnv("ANTHROPIC_AUTH_TOKEN", "fallback");
		expect(resolveApiKey(model)).toBe("fallback");
		// An exported-but-empty primary must not shadow a usable fallback.
		setEnv("ANTHROPIC_API_KEY", "");
		expect(resolveApiKey(model)).toBe("fallback");
	});

	test("nothing set resolves to undefined so callers can report it", () => {
		const model = resolveModel("anthropic/claude-sonnet-5");
		if (!model) throw new Error("expected the built-in model to resolve");
		setEnv("ANTHROPIC_API_KEY", undefined);
		setEnv("ANTHROPIC_AUTH_TOKEN", undefined);
		expect(resolveApiKey(model)).toBeUndefined();
	});

	test("a model without fallbacks reads only its own variable", () => {
		const model = resolveModel("deepseek/deepseek-chat");
		if (!model) throw new Error("expected the built-in model to resolve");
		expect(apiKeyEnvNames(model)).toEqual([model.apiKeyEnv]);
	});

	test("apiKeyEnvNames lists the primary first, for error messages", () => {
		const model = resolveModel("anthropic/claude-sonnet-5");
		if (!model) throw new Error("expected the built-in model to resolve");
		expect(apiKeyEnvNames(model)).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
	});
});

describe("custom providers", () => {
	test("a registered provider honours its own base URL override", () => {
		registerOpenAICompatibleProvider({
			id: "acme-ai",
			baseUrl: "https://acme.example/v1",
			apiKeyEnv: "ACME_API_KEY",
			models: [{ id: "acme-1", contextWindow: 128_000, maxOutputTokens: 8_000 }],
		});
		setEnv("ACME_AI_BASE_URL", "https://acme-proxy.example/v1");
		expect(resolveModel("acme-ai/acme-1")?.baseUrl).toBe("https://acme-proxy.example/v1");
	});
});
