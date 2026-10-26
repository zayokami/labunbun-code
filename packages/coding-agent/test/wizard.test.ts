/**
 * First-run wizard: the trigger rule and the answers→settings translation are
 * pure and asserted directly. The interactive readline flow itself is TTY-only
 * and stays manual.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listModels } from "@labunbun/ai";
import { AUTO_THEME_NAME, BUILT_IN_THEME_NAMES } from "@labunbun/tui";
import { NO_SIGN_INS } from "../src/credential-presence.ts";
import { MIGRATION_SOURCE_LABELS, SOURCE_ROOTS } from "../src/migrate-types.ts";
import {
	askChoice,
	buildWizardSettings,
	firstRunRecord,
	importOfferLine,
	shouldRunWizard,
	userSettingsPath,
	WIZARD_CHATGPT_MODEL,
	WIZARD_THEME_CHOICES,
	WIZARD_THEME_DEFAULT,
	wizardDetectionLines,
	wizardProviderDefault,
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
		// A bare Enter takes `auto`, not the dark default: the terminal probe
		// exists, and `auto` is the one answer that cannot be wrong about the
		// terminal the user is already looking at.
		expect(WIZARD_THEME_DEFAULT).toBe("auto");
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
		expect(await ask([""])).toBe("auto");
		expect(await ask(["   "])).toBe("auto");
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
			emacsMode: false,
		});
		// `emacsMode: false` is the named change here: the wizard now states both
		// halves of the exclusive pair rather than leaving the unchosen one absent,
		// so a reader of the file is told what "no editor" meant instead of inferring
		// it from a missing key.
		expect(settings).toEqual({ model: "anthropic/claude-sonnet-5", theme: "dark", vimMode: false, emacsMode: false });
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
			emacsMode: false,
		});
		expect(settings.env).toEqual({ ANTHROPIC_API_KEY: "sk-test-123" });
		expect("providers" in settings).toBe(false);
		expect(settings.model).toBe("anthropic/claude-sonnet-5");
	});

	test("chatgpt path: the sign-in is the credential, so only the model it implies is written", () => {
		const settings = buildWizardSettings({
			provider: "chatgpt",
			apiKey: null,
			baseUrl: "",
			apiKeyEnvName: "",
			modelId: "",
			contextWindow: 128_000,
			maxOutputTokens: 8192,
			reasoning: false,
			theme: "auto",
			vimMode: false,
			emacsMode: false,
		});
		// The credential lives in the sign-in store, not here; the file's whole
		// job for this answer is the model that credential can run. No env block
		// and no provider spec — there is no key to write.
		expect(settings).toEqual({ model: WIZARD_CHATGPT_MODEL, theme: "auto", vimMode: false, emacsMode: false });
	});

	test("the chatgpt model reference resolves in the registry", () => {
		// The reference is a string in this file; the row is the registry's. A
		// rename or retirement upstream turn this red, which is the point — the
		// alternative is a sign-in that writes a model nothing can run.
		const refs = listModels().map((model) => `${model.provider}/${model.id}`);
		expect(refs).toContain(WIZARD_CHATGPT_MODEL);
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
			emacsMode: false,
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
		// Chat completions is what an entry without `api` already means, so the
		// default answer leaves the field out rather than writing it down.
		expect("api" in spec).toBe(false);
	});

	test("a non-default wire is written on the provider, never on the model", () => {
		for (const api of ["openai-responses", "anthropic-messages"] as const) {
			const settings = buildWizardSettings({
				provider: "openai-compatible",
				apiKey: null,
				baseUrl: "https://api.example.com",
				apiKeyEnvName: "MY_KEY",
				api,
				modelId: "m",
				contextWindow: 128_000,
				maxOutputTokens: 8192,
				reasoning: false,
				theme: "dark",
				vimMode: false,
				emacsMode: false,
			});
			const spec = (settings.providers as { openaiCompatible: Array<Record<string, unknown>> }).openaiCompatible[0];
			expect(spec.api).toBe(api);
			// One wire per endpoint: the models under it all speak the provider's.
			expect((spec.models as Array<Record<string, unknown>>)[0]).not.toHaveProperty("api");
		}
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
			emacsMode: false,
		});
		expect(settings.env).toBeUndefined();
	});
});

describe("wizardProviderDefault", () => {
	test("the default row is the one that is already true for this machine", () => {
		expect(wizardProviderDefault({ claudeConfigured: true, envKeysPresent: false })).toBe("1");
		expect(wizardProviderDefault({ claudeConfigured: false, envKeysPresent: true })).toBe("3");
		// A bare machine gets the sign-in row: it needs nothing typed.
		expect(wizardProviderDefault({ claudeConfigured: false, envKeysPresent: false })).toBe("1");
		// A Claude config outranks a stray key variable.
		expect(wizardProviderDefault({ claudeConfigured: true, envKeysPresent: true })).toBe("1");
	});
});

describe("wizardDetectionLines", () => {
	test("a bare machine yields no lines — the block stays silent", () => {
		expect(wizardDetectionLines({ sources: [], envKeys: [], signIns: NO_SIGN_INS })).toEqual([]);
	});

	test("each finding gets one row: a source names its tree, a variable and a sign-in their state", () => {
		const lines = wizardDetectionLines({
			sources: ["claude-code", "codex"],
			envKeys: ["ANTHROPIC_API_KEY"],
			signIns: { claude: true, chatgpt: false, gemini: true },
		});
		// The first row against its literal spelling, not just its parts: this is
		// the rendering the user reads, `label — ~/tree`.
		expect(lines[0]).toBe("Claude Code — ~/.claude");
		expect(lines[1]).toBe(`${MIGRATION_SOURCE_LABELS.codex} — ~/${SOURCE_ROOTS.codex}`);
		expect(lines[2]).toBe("ANTHROPIC_API_KEY is set");
		expect(lines[3]).toBe("Claude subscription signed in");
		expect(lines[4]).toBe("Gemini subscription signed in");
		expect(lines).toHaveLength(5);
	});
});

describe("importOfferLine", () => {
	test("no sources, no question", () => {
		expect(importOfferLine([])).toBeUndefined();
	});

	test("names every detected source and promises the plan", () => {
		const line = importOfferLine(["claude-code", "codex"]);
		expect(line).toContain(MIGRATION_SOURCE_LABELS["claude-code"]);
		expect(line).toContain(MIGRATION_SOURCE_LABELS.codex);
		expect(line).toContain("full plan");
		// History is the one category the first-run offer leaves out; the question
		// must not promise the conversations its own plan will not count.
		expect(line).not.toContain("conversation");
	});
});

describe("firstRunRecord", () => {
	test("stamps the run: the injected instant as ISO, both sign-in flags, the import verdict", () => {
		const record = firstRunRecord({
			signIns: { claude: true, chatgpt: false, gemini: false },
			imported: true,
			now: new Date("2026-10-14T08:30:00Z"),
		});
		expect(record).toEqual({
			offeredAt: "2026-10-14T08:30:00.000Z",
			signedIn: { claude: true, chatgpt: false, gemini: false },
			imported: true,
		});
	});

	test("a run that signed in nowhere and imported nothing still records — false is a fact here, not an absence", () => {
		const record = firstRunRecord({ signIns: NO_SIGN_INS, imported: false, now: new Date(0) });
		expect(record.offeredAt).toBe("1970-01-01T00:00:00.000Z");
		expect(record.signedIn).toEqual({ claude: false, chatgpt: false, gemini: false });
		expect(record.imported).toBe(false);
	});
});
