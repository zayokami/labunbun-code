/**
 * `/config`, driven the way a person drives it.
 *
 * The screen's promises are about what ends up on disk and in the process, not
 * about the words on the rows: a saved key must reach both, a shell's export
 * must survive a save, and an endpoint removed from the list must leave the
 * model registry too. Each test therefore scripts the pickers and prompts in
 * the order the screen asks them, runs the flow, and inspects the settings
 * file, the live `Settings` object, `process.env`, and `listModels`.
 *
 * One scripted call that the screen does not in fact make is a failure, not a
 * no-op: `script.remaining()` is asserted at the end of every test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearCustomModels,
	clearDiscovery,
	listModels,
	type OpenAICompatibleProviderSpec,
	registerOpenAICompatibleProvider,
} from "@labunbun/ai";
import {
	type ApiConfigOptions,
	type ConfigDialog,
	type ConfigTextPrompt,
	configProviders,
	credentialOf,
	describeCredential,
	type ProviderCredential,
	runApiConfig,
} from "../src/api-config.ts";
import { NO_SIGN_INS, type SubscriptionSignIns } from "../src/credential-presence.ts";
import { type Settings, SettingsSchema } from "../src/settings.ts";

interface PickStep {
	match?: string;
	index?: number | null;
	title?: string;
}

interface TextStep {
	value: string | null;
	inspect?: (request: ConfigTextPrompt) => void;
}

interface AskStep {
	value: string[] | null;
}

type Step = { kind: "pick"; step: PickStep } | { kind: "text"; step: TextStep } | { kind: "ask"; step: AskStep };

interface PickCall {
	title: string;
	items: Array<{ label: string; description?: string }>;
}

interface AskCall {
	question: string;
	header: string;
	options: Array<{ label: string; description?: string }>;
}

/**
 * A dialog whose answers are written before the screen runs.
 *
 * Pickers answer by row label — matching the visible label is what a person
 * does, and it keeps a test independent of row order. A label that is missing
 * throws with the whole list, so a renamed or vanished row fails at the call
 * that needed it rather than as a puzzling `undefined` later.
 */
function script() {
	const queue: Step[] = [];
	const picks: PickCall[] = [];
	const texts: ConfigTextPrompt[] = [];
	const asks: AskCall[][] = [];

	const take = (kind: Step["kind"]): Step => {
		const step = queue.shift();
		if (!step) throw new Error(`unscripted ${kind} call`);
		if (step.kind !== kind) throw new Error(`expected a ${step.kind} call, the screen made a ${kind} one`);
		return step;
	};

	const api = {
		picks,
		texts,
		asks,
		remaining: () => queue.length,
		pick(match: string, title?: string) {
			queue.push({ kind: "pick", step: { match, title } });
			return api;
		},
		pickIndex(index: number | null) {
			queue.push({ kind: "pick", step: { index } });
			return api;
		},
		text(value: string | null, inspect?: (request: ConfigTextPrompt) => void) {
			queue.push({ kind: "text", step: { value, inspect } });
			return api;
		},
		ask(value: string[] | null) {
			queue.push({ kind: "ask", step: { value } });
			return api;
		},
		dialog: {
			async pickFromList(title, items) {
				picks.push({ title, items });
				const { step } = take("pick") as { step: PickStep };
				if (step.title !== undefined && !title.includes(step.title)) {
					throw new Error(`expected the picker "${step.title}", got "${title}"`);
				}
				if ("index" in step) return step.index ?? null;
				const match = step.match ?? "";
				let index = items.findIndex((item) => item.label === match);
				if (index === -1) index = items.findIndex((item) => item.label.includes(match));
				if (index === -1) {
					throw new Error(`no row "${match}" in "${title}": ${items.map((item) => item.label).join(" | ")}`);
				}
				return index;
			},
			async promptText(request) {
				texts.push(request);
				const { step } = take("text") as { step: TextStep };
				step.inspect?.(request);
				return step.value;
			},
			async askUser(questions) {
				asks.push(questions);
				return (take("ask") as { step: AskStep }).step.value;
			},
		} satisfies ConfigDialog,
	};
	return api;
}

let home = "";

function settingsPath(): string {
	return join(home, ".labunbun", "settings.json");
}

function readSettingsFile(): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath(), "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function savedEnv(file: Record<string, unknown> | undefined): Record<string, string | undefined> {
	return (file?.env ?? {}) as Record<string, string | undefined>;
}

function savedSpecs(file: Record<string, unknown> | undefined): OpenAICompatibleProviderSpec[] {
	const providers = file?.providers as { openaiCompatible?: OpenAICompatibleProviderSpec[] } | undefined;
	return providers?.openaiCompatible ?? [];
}

/** A run of the screen against the temp home, with the process env the test set up. */
function harness(settings: Settings, s: ReturnType<typeof script>, overrides: Partial<ApiConfigOptions> = {}) {
	const reports: string[] = [];
	const probes: string[] = [];
	const options: ApiConfigOptions = {
		dialog: s.dialog,
		settings,
		home,
		report: (line) => reports.push(line),
		appliedEnv: new Set<string>(),
		loadSignIns: async () => NO_SIGN_INS,
		probe: async (provider) => {
			probes.push(provider);
			return undefined;
		},
		...overrides,
	};
	return { options, reports, probes };
}

const savedEnvNames = new Map<string, string | undefined>();

beforeEach(() => {
	clearCustomModels();
	clearDiscovery();
	home = mkdtempSync(join(tmpdir(), "labunbun-config-"));
	savedEnvNames.clear();
	for (const name of [...configProviders().flatMap((provider) => provider.envNames), "MYBOX_API_KEY"]) {
		if (savedEnvNames.has(name)) continue;
		savedEnvNames.set(name, process.env[name]);
		delete process.env[name];
	}
});

afterEach(() => {
	for (const [name, value] of savedEnvNames) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	clearCustomModels();
	clearDiscovery();
	rmSync(home, { recursive: true, force: true });
});

const SPEC: OpenAICompatibleProviderSpec = {
	id: "mybox",
	baseUrl: "https://box.example/v1",
	apiKeyEnv: "MYBOX_API_KEY",
	api: "openai-completions",
	models: [{ id: "qwen3", contextWindow: 65536, maxOutputTokens: 8192 }],
};

describe("the config screen", () => {
	test("lists every provider with what the process can run it with", async () => {
		const settings = SettingsSchema.parse({});
		const s = script().pick("Providers & API keys").pick("DeepSeek").pickIndex(null).pickIndex(null);
		await runApiConfig(harness(settings, s).options);

		const hub = s.picks[0];
		expect(hub?.title).toBe("Settings");
		expect(hub?.items.map((item) => item.label)).toEqual([
			"Providers & API keys",
			"Custom endpoints",
			"Model discovery",
			"Default model",
			"Open settings file",
		]);
		const providers = configProviders();
		const ready = providers
			.map((provider) => credentialOf(provider, NO_SIGN_INS, new Set()))
			.filter((credential) => credential.kind !== "none").length;
		expect(hub?.items[0]?.description).toBe(`${ready} of ${providers.length} ready — sign in, or save a key`);

		expect(s.picks[1]?.items.find((item) => item.label === "DeepSeek")?.description).toBe("no key");
		expect(s.picks[2]?.title).toBe("DeepSeek — no key");
		expect(s.picks[2]?.items.map((item) => item.label)).toEqual(["Set API key…"]);
		expect(s.remaining()).toBe(0);
	});

	test("saving a key writes the user file and applies it to this session", async () => {
		const settings = SettingsSchema.parse({});
		const s = script()
			.pick("Providers & API keys")
			.pick("DeepSeek")
			.pick("Set API key…")
			.text("sk-live", (request) => {
				expect(request.title).toBe("DEEPSEEK_API_KEY");
				expect(request.mask).toBe(true);
				expect(request.validate?.("has a space")).toBe("An API key does not contain spaces.");
				expect(request.validate?.("sk-live")).toBeUndefined();
			})
			.pickIndex(null)
			.pickIndex(null);
		const h = harness(settings, s);
		await runApiConfig(h.options);

		expect(savedEnv(readSettingsFile())).toEqual({ DEEPSEEK_API_KEY: "sk-live" });
		expect(settings.env?.DEEPSEEK_API_KEY).toBe("sk-live");
		expect(process.env.DEEPSEEK_API_KEY).toBe("sk-live");
		expect(h.reports[0]).toBe("Saved DEEPSEEK_API_KEY to ~/.labunbun/settings.json and applied it to this session.");
		expect(h.probes).toEqual(["deepseek"]);
		expect(h.reports.at(-1)).toContain("did not answer");
		expect(s.remaining()).toBe(0);
	});

	test("a shell-exported key keeps its value, and the screen says so", async () => {
		process.env.DEEPSEEK_API_KEY = "from-shell";
		const settings = SettingsSchema.parse({});
		const s = script()
			.pick("Providers & API keys")
			.pick("DeepSeek")
			.pick("Replace API key…")
			.text("from-file")
			.pickIndex(null)
			.pickIndex(null);
		const h = harness(settings, s);
		await runApiConfig(h.options);

		expect(savedEnv(readSettingsFile())).toEqual({ DEEPSEEK_API_KEY: "from-file" });
		expect(process.env.DEEPSEEK_API_KEY).toBe("from-shell");
		expect(h.reports[0]).toBe(
			"Saved DEEPSEEK_API_KEY to ~/.labunbun/settings.json. This shell already exports DEEPSEEK_API_KEY; its value stays in force for this session.",
		);
		expect(s.remaining()).toBe(0);
	});

	test("removing a saved key deletes it, and only unsets what startup applied", async () => {
		const settings = SettingsSchema.parse({ env: { DEEPSEEK_API_KEY: "sk-file" } });
		process.env.DEEPSEEK_API_KEY = "sk-file";
		const s = script()
			.pick("Providers & API keys")
			.pick("DeepSeek")
			.pick("Remove saved key")
			.ask(["Remove DEEPSEEK_API_KEY"])
			.pickIndex(null)
			.pickIndex(null);
		const h = harness(settings, s, { appliedEnv: new Set(["DEEPSEEK_API_KEY"]) });
		await runApiConfig(h.options);

		expect(s.picks[2]?.title).toBe("DeepSeek — key: DEEPSEEK_API_KEY · saved");
		expect(s.picks[2]?.items.map((item) => item.label)).toContain("Remove saved key");
		expect(savedEnv(readSettingsFile()).DEEPSEEK_API_KEY).toBeUndefined();
		expect(settings.env?.DEEPSEEK_API_KEY).toBeUndefined();
		expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
		expect(h.reports).toContain("Removed DEEPSEEK_API_KEY from ~/.labunbun/settings.json.");
		expect(s.remaining()).toBe(0);
	});

	test("keeping the key changes nothing, in the file or the process", async () => {
		const settings = SettingsSchema.parse({ env: { DEEPSEEK_API_KEY: "sk-file" } });
		process.env.DEEPSEEK_API_KEY = "sk-file";
		const s = script()
			.pick("Providers & API keys")
			.pick("DeepSeek")
			.pick("Remove saved key")
			.ask(["Keep it"])
			.pickIndex(null)
			.pickIndex(null);
		const h = harness(settings, s, { appliedEnv: new Set(["DEEPSEEK_API_KEY"]) });
		await runApiConfig(h.options);

		expect(readSettingsFile()).toBeUndefined();
		expect(settings.env?.DEEPSEEK_API_KEY).toBe("sk-file");
		expect(process.env.DEEPSEEK_API_KEY).toBe("sk-file");
		expect(h.reports).toEqual([]);
		expect(s.remaining()).toBe(0);
	});

	test("the discovery toggle writes the setting and moves the live object with it", async () => {
		const settings = SettingsSchema.parse({});
		const off = script().pick("Model discovery").pickIndex(1).pickIndex(null);
		const first = harness(settings, off);
		await runApiConfig(first.options);
		expect(readSettingsFile()).toEqual({ modelDiscovery: false });
		expect(settings.modelDiscovery).toBe(false);
		expect(first.reports).toEqual(["Model discovery: off. /model lists the built-in table and sends no probes."]);

		const on = script().pick("Model discovery").pickIndex(0).pickIndex(null);
		const second = harness(settings, on);
		await runApiConfig(second.options);
		expect(readSettingsFile()).toEqual({ modelDiscovery: true });
		expect(settings.modelDiscovery).toBe(true);
		expect(second.reports[0]).toContain("Model discovery: on.");
		expect(off.remaining()).toBe(0);
		expect(on.remaining()).toBe(0);
	});

	test("adding an endpoint saves the spec, registers its models, and stores the key", async () => {
		const settings = SettingsSchema.parse({});
		const s = script()
			.pick("Custom endpoints")
			.pick("Add an endpoint…")
			.text("mybox", (request) => {
				expect(request.validate?.("Bad Id")).toBe("Use lowercase letters, digits and dashes, starting with a letter.");
				expect(request.validate?.("openai")).toBe('"openai" is a built-in provider; choose another id.');
				expect(request.validate?.("mybox")).toBeUndefined();
			})
			.text("https://box.example/v1", (request) => {
				expect(request.validate?.("nope")).toBe("That is not a URL.");
				expect(request.validate?.("ftp://box.example")).toBe("Use an http:// or https:// URL.");
				expect(request.validate?.("https://box.example/v1")).toBeUndefined();
			})
			.text("MYBOX_API_KEY", (request) => {
				expect(request.initial).toBe("MYBOX_API_KEY");
				expect(request.validate?.("9lives")).toBe("Use a shell variable name: letters, digits, underscores.");
			})
			.pick("Chat completions")
			.text("qwen3", (request) => expect(request.title).toBe("Model id"))
			.text("65536", (request) => {
				expect(request.validate?.("0")).toBe("Enter a whole number greater than zero.");
				expect(request.validate?.("65536")).toBeUndefined();
			})
			.text("8192")
			.pick("Done")
			.text("sk-box", (request) => {
				expect(request.title).toBe("MYBOX_API_KEY (optional)");
				expect(request.mask).toBe(true);
				expect(request.optional).toBe(true);
			})
			.pickIndex(null)
			.pickIndex(null);
		const h = harness(settings, s);
		await runApiConfig(h.options);

		expect(savedSpecs(readSettingsFile())).toEqual([SPEC]);
		expect(settings.providers?.openaiCompatible).toEqual([SPEC]);
		const registered = listModels().find((model) => model.provider === "mybox" && model.id === "qwen3");
		expect(registered?.baseUrl).toBe("https://box.example/v1");
		expect(process.env.MYBOX_API_KEY).toBe("sk-box");
		expect(h.reports).toContain("Added mybox. /model now lists mybox/qwen3.");
		expect(h.probes).toEqual(["mybox"]);
		expect(s.remaining()).toBe(0);
	});

	test("an endpoint with no models adds nothing at all", async () => {
		const settings = SettingsSchema.parse({});
		const s = script()
			.pick("Custom endpoints")
			.pick("Add an endpoint…")
			.text("emptybox")
			.text("https://empty.example/v1")
			.text("EMPTYBOX_API_KEY")
			.pick("Chat completions")
			.text(null)
			.pickIndex(null)
			.pickIndex(null);
		const h = harness(settings, s);
		await runApiConfig(h.options);

		expect(h.reports).toContain("Nothing was added: an endpoint needs at least one model.");
		expect(readSettingsFile()).toBeUndefined();
		expect(settings.providers?.openaiCompatible).toBeUndefined();
		expect(s.remaining()).toBe(0);
	});

	test("removing an endpoint drops it from the file and from the model list", async () => {
		registerOpenAICompatibleProvider(SPEC);
		const settings = SettingsSchema.parse({ providers: { openaiCompatible: [SPEC] } });
		const s = script()
			.pick("Custom endpoints")
			.pick("mybox —")
			.pick("Remove endpoint…")
			.ask(["Remove endpoint"])
			.pickIndex(null)
			.pickIndex(null);
		const h = harness(settings, s);
		await runApiConfig(h.options);

		expect(savedSpecs(readSettingsFile())).toEqual([]);
		expect(settings.providers?.openaiCompatible).toEqual([]);
		expect(listModels().some((model) => model.provider === "mybox")).toBe(false);
		expect(h.reports).toContain("Removed mybox.");
		expect(s.remaining()).toBe(0);
	});

	test("editing the base URL updates the spec and the registered models", async () => {
		registerOpenAICompatibleProvider(SPEC);
		const settings = SettingsSchema.parse({ providers: { openaiCompatible: [SPEC] } });
		const s = script()
			.pick("Custom endpoints")
			.pick("mybox —")
			.pick("Edit base URL…")
			.text("https://new.example/v1", (request) => expect(request.initial).toBe("https://box.example/v1"))
			.pickIndex(null)
			.pickIndex(null);
		const h = harness(settings, s);
		await runApiConfig(h.options);

		expect(savedSpecs(readSettingsFile())[0]?.baseUrl).toBe("https://new.example/v1");
		const registered = listModels().find((model) => model.provider === "mybox");
		expect(registered?.baseUrl).toBe("https://new.example/v1");
		expect(h.reports[0]).toContain("mybox now points at https://new.example/v1.");
		expect(s.remaining()).toBe(0);
	});

	test("the default model row re-dispatches /model and ends the screen", async () => {
		const settings = SettingsSchema.parse({});
		const commands: string[] = [];
		const s = script().pick("Default model");
		await runApiConfig(
			harness(settings, s, {
				runCommand: (text) => {
					commands.push(text);
					return true;
				},
			}).options,
		);

		expect(commands).toEqual(["/model"]);
		expect(s.remaining()).toBe(0);
	});

	test("the settings file row says whether an editor opened", async () => {
		const settings = SettingsSchema.parse({});
		const opened = script().pick("Open settings file").pickIndex(null);
		const first = harness(settings, opened, { openSettings: () => true });
		await runApiConfig(first.options);
		expect(first.reports).toEqual([
			"Opening ~/.labunbun/settings.json in your editor. Saved changes load at the next start.",
		]);

		const closed = script().pick("Open settings file").pickIndex(null);
		const second = harness(settings, closed, { openSettings: () => false });
		await runApiConfig(second.options);
		expect(second.reports[0]).toContain("Set $VISUAL or $EDITOR");
	});

	test("a signed-in provider offers signing in again and dispatches /login", async () => {
		const settings = SettingsSchema.parse({});
		const commands: string[] = [];
		const signIns: SubscriptionSignIns = { ...NO_SIGN_INS, claude: true };
		const s = script()
			.pick("Providers & API keys")
			.pick("Anthropic (Claude)")
			.pick("Sign in again")
			.pickIndex(null)
			.pickIndex(null);
		await runApiConfig(
			harness(settings, s, {
				loadSignIns: async () => signIns,
				runCommand: (text) => {
					commands.push(text);
					return true;
				},
			}).options,
		);

		expect(s.picks[1]?.items.find((item) => item.label === "Anthropic (Claude)")?.description).toBe("signed in");
		expect(s.picks[2]?.title).toBe("Anthropic (Claude) — signed in");
		expect(commands).toEqual(["/login claude"]);
		expect(s.remaining()).toBe(0);
	});
});

describe("credentialOf", () => {
	test("a key the settings file supplied is reported as saved, ahead of the sign-in", () => {
		const provider = configProviders().find((entry) => entry.id === "anthropic");
		if (!provider) throw new Error("the registry lost anthropic");
		process.env.ANTHROPIC_API_KEY = "sk-ant";
		const credential: ProviderCredential = credentialOf(
			provider,
			{ ...NO_SIGN_INS, claude: true },
			new Set(["ANTHROPIC_API_KEY"]),
		);
		expect(credential).toEqual({ kind: "env", name: "ANTHROPIC_API_KEY", from: "settings" });
		expect(describeCredential(credential)).toBe("key: ANTHROPIC_API_KEY · saved");
	});

	test("a subscription with no key variable is usable, and a wire with no key is keyless", () => {
		const chatgpt = configProviders().find((entry) => entry.id === "chatgpt");
		if (!chatgpt) throw new Error("the registry lost chatgpt");
		expect(credentialOf(chatgpt, NO_SIGN_INS, new Set())).toEqual({ kind: "none" });
		expect(credentialOf(chatgpt, { ...NO_SIGN_INS, chatgpt: true }, new Set())).toEqual({ kind: "sign-in" });
		expect(describeCredential({ kind: "keyless" })).toBe("no key needed");
	});
});
