/**
 * First-run wizard: the trigger rule and the answers→settings translation are
 * pure and asserted directly. The interactive readline flow itself is TTY-only
 * and stays manual.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AUTO_THEME_NAME, BUILT_IN_THEME_NAMES } from "@labunbun/tui";
import {
	askChoice,
	buildWizardSettings,
	shouldRunWizard,
	userSettingsPath,
	WIZARD_THEME_CHOICES,
	WIZARD_THEME_DEFAULT,
} from "../src/wizard.ts";

let home: string;

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "lbb-wizard-"));
});

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("shouldRunWizard", () => {
	test("runs when the settings file is absent and stdin is a TTY", () => {
		expect(shouldRunWizard({ home, isTTY: true })).toBe(true);
	});

	test("never runs headless, whatever the file state", () => {
		expect(shouldRunWizard({ home, isTTY: false })).toBe(false);
	});

	test("does not run once a settings file exists — including the cancel shape {}", () => {
		const path = userSettingsPath(home);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{}\n", "utf8");
		expect(shouldRunWizard({ home, isTTY: true })).toBe(false);
	});
});

describe("the theme question", () => {
	// The list the wizard offers is the REPL's own: a copy written out here is how
	// it came to accept a set of names that could drift from the themes that exist.
	test("offers every built-in plus auto, and no others", () => {
		expect([...WIZARD_THEME_CHOICES]).toEqual([...BUILT_IN_THEME_NAMES, AUTO_THEME_NAME]);
		expect(WIZARD_THEME_DEFAULT).toBe("dark");
	});

	/** Drive the question with a scripted answer or two. */
	async function ask(answers: string[]): Promise<string> {
		let i = 0;
		return askChoice(
			async () => answers[Math.min(i++, answers.length - 1)] ?? "",
			"Theme",
			WIZARD_THEME_CHOICES,
			WIZARD_THEME_DEFAULT,
		);
	}

	test("a named theme is taken as given", async () => {
		expect(await ask(["splatoon"])).toBe("splatoon");
		expect(await ask(["AUTO"])).toBe("auto"); // the answer is folded, the name is not invented
	});

	test("an empty answer takes the default the prompt promised", async () => {
		expect(await ask([""])).toBe("dark");
		expect(await ask(["   "])).toBe("dark");
	});

	// The bug this replaces: an unrecognised name was rewritten to "auto" without
	// a word, so the setting the user found afterwards was one they never chose.
	test("an unknown name is re-asked rather than rewritten", async () => {
		expect(await ask(["nord", "light"])).toBe("light");
		// Still unknown on the second try: the loop keeps asking rather than
		// falling back to something the user did not ask for.
		expect(await ask(["nord", "nord", "light"])).toBe("light");
	});
});

describe("buildWizardSettings", () => {
	test("anthropic path: defaults, no env block when no key was pasted", () => {
		const settings = buildWizardSettings({
			provider: "anthropic",
			apiKey: null,
			baseUrl: "",
			apiKeyEnvName: "",
			modelId: "",
			contextWindow: 128_000,
			maxOutputTokens: 8192,
			reasoning: false,
			theme: "dark",
			vimMode: false,
		});
		expect(settings).toEqual({ model: "anthropic/claude-sonnet-5", theme: "dark", vimMode: false });
		expect("env" in settings).toBe(false);
	});

	test("anthropic path: a pasted key lands in settings.env, not in a provider spec", () => {
		const settings = buildWizardSettings({
			provider: "anthropic",
			apiKey: "sk-test-123",
			baseUrl: "",
			apiKeyEnvName: "",
			modelId: "",
			contextWindow: 128_000,
			maxOutputTokens: 8192,
			reasoning: false,
			theme: "auto",
			vimMode: true,
		});
		expect(settings.env).toEqual({ ANTHROPIC_API_KEY: "sk-test-123" });
		expect("providers" in settings).toBe(false);
		expect(settings.model).toBe("anthropic/claude-sonnet-5");
	});

	test("openai-compatible path: provider spec holds the env var NAME; the key value rides in env", () => {
		const settings = buildWizardSettings({
			provider: "openai-compatible",
			apiKey: "kv-secret",
			baseUrl: "https://api.example.com/v1",
			apiKeyEnvName: "MY_KEY",
			modelId: "big-model",
			contextWindow: 200_000,
			maxOutputTokens: 16_384,
			reasoning: true,
			theme: "dark",
			vimMode: false,
		});
		expect(settings.model).toBe("custom/big-model");
		const providers = settings.providers as { openaiCompatible: Array<Record<string, unknown>> };
		const spec = providers.openaiCompatible[0];
		expect(spec.apiKeyEnv).toBe("MY_KEY");
		// The spec must never carry the secret itself.
		expect(JSON.stringify(spec)).not.toContain("kv-secret");
		expect(settings.env).toEqual({ MY_KEY: "kv-secret" });
		const models = spec.models as Array<Record<string, unknown>>;
		expect(models[0]).toEqual({ id: "big-model", contextWindow: 200_000, maxOutputTokens: 16384, reasoning: true });
	});

	test("openai-compatible path without a pasted key omits the env block entirely", () => {
		const settings = buildWizardSettings({
			provider: "openai-compatible",
			apiKey: null,
			baseUrl: "https://api.example.com/v1",
			apiKeyEnvName: "MY_KEY",
			modelId: "m",
			contextWindow: 128_000,
			maxOutputTokens: 8192,
			reasoning: false,
			theme: "dark",
			vimMode: false,
		});
		expect(settings.env).toBeUndefined();
	});
});
