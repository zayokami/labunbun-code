/**
 * The in-app settings screen: `/config`.
 *
 * The settings file has always been the source of truth, and until now the
 * only ways to change the parts that make a session work — the API keys, the
 * endpoints, what the model picker may ask — were an editor and a wizard that
 * only runs once. This screen is the third way: a list of what the machine has
 * and what it is missing, with the same dialogs the rest of the app asks with.
 *
 * It deliberately edits the USER settings file only. Project and local files
 * cannot set `env`, `providers` or `modelDiscovery` at all (see
 * `PROJECT_TIER_KEY_POLICY`), so a save here cannot be shadowed by the
 * checkout, and no other tier is ever written as a side effect of a screen.
 *
 * The flow is a sequence of pickers and one-line prompts rather than a single
 * form. That is the shape the terminal asks in: a list can be typed into to
 * filter, each question has one answer, and Esc means the same thing at every
 * depth. The module owns the words and the writes; the surfaces are the TUI's
 * existing dialogs, so a test drives the whole screen without rendering ink.
 */

import { homedir } from "node:os";
import {
	type CatalogRefresh,
	type CustomProviderApiId,
	clearCustomModels,
	formatCatalogNotice,
	listModels,
	type OpenAICompatibleProviderSpec,
	registerOpenAICompatibleProvider,
} from "@labunbun/ai";
import { detectSubscriptionSignIns, type SubscriptionSignIns } from "./credential-presence.ts";
import type { Settings } from "./settings.ts";
import { writeUserSettingsNestedPatch, writeUserSettingsPatch } from "./user-settings.ts";

/** Where the saved values live, as every line on the screen spells it. */
const SETTINGS_SHOWN = "~/.labunbun/settings.json";

/**
 * The text prompt, structurally.
 *
 * The TUI's `TextPromptRequest` satisfies this and vice versa; the app layer
 * does not import the surface's types because a hand-built dialog in a test is
 * not an Ink component and must not have to be one.
 */
export interface ConfigTextPrompt {
	title: string;
	hint?: string;
	initial?: string;
	mask?: boolean;
	optional?: boolean;
	validate?: (value: string) => string | undefined;
}

/** The three dialogs the screen asks with, as much of each as it uses. */
export interface ConfigDialog {
	askUser(
		questions: Array<{
			question: string;
			header: string;
			options: Array<{ label: string; description?: string }>;
			multiSelect?: boolean;
		}>,
	): Promise<string[] | null>;
	pickFromList(
		title: string,
		items: Array<{ label: string; description?: string }>,
		options?: { initialIndex?: number },
	): Promise<number | null>;
	promptText(request: ConfigTextPrompt): Promise<string | null>;
}

export interface ApiConfigOptions {
	dialog: ConfigDialog;
	/** The live settings. Reads happen against it; writes land in the user file and here. */
	settings: Settings;
	home?: string;
	/** One line at a time; the REPL passes `pushInfo`. */
	report: (text: string) => void;
	/**
	 * The env names startup applied from `settings.env`. A name absent from
	 * this set but present in the process environment came from the shell, and
	 * the shell wins — saying "saved" without saying that would be a lie.
	 */
	appliedEnv?: ReadonlySet<string>;
	/**
	 * The sign-ins, injected so a test never reads the real keychain. The
	 * default reads the stores under `home`.
	 */
	loadSignIns?: () => Promise<SubscriptionSignIns>;
	/** Re-dispatch a REPL command — sign-in and the model picker reuse `/login` and `/model`. */
	runCommand?: (text: string) => boolean;
	/** The session's current model, shown on the hub as the default. */
	modelRef?: string;
	/** Ask one provider what it serves, after its credential changed. */
	probe?: (provider: string) => Promise<CatalogRefresh | undefined>;
	/** Open the settings file in the user's editor. */
	openSettings?: () => boolean;
}

/** A provider the registry knows, with the names a key may arrive under. */
export interface ConfigProvider {
	id: string;
	label: string;
	/** In precedence order; the first is the one the screen writes. */
	envNames: string[];
	signIn?: "claude" | "chatgpt" | "gemini";
	/** Whether discovery has a listing call for this wire. */
	probeable: boolean;
}

/** What the process can actually bring to this provider. */
export type ProviderCredential =
	| { kind: "env"; name: string; from: "shell" | "settings" }
	| { kind: "sign-in" }
	| { kind: "keyless" }
	| { kind: "none" };

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: "Anthropic (Claude)",
	chatgpt: "ChatGPT (subscription)",
	deepseek: "DeepSeek",
	gemini: "Gemini (subscription)",
	glm: "GLM (Zhipu)",
	google: "Google",
	kimi: "Kimi (Moonshot)",
	"kimi-cn": "Kimi China",
	"kimi-code": "Kimi Code",
	"kimi-code-cn": "Kimi Code China",
	meta: "Meta",
	minimax: "MiniMax",
	mistral: "Mistral",
	ollama: "Ollama (local)",
	"ollama-cloud": "Ollama Cloud",
	openai: "OpenAI",
	"opencode-go": "OpenCode Go",
	"opencode-go-oai": "OpenCode Go (OpenAI wire)",
	"opencode-zen": "OpenCode Zen",
	"opencode-zen-oai": "OpenCode Zen (OpenAI wire)",
	openrouter: "OpenRouter",
	tencent: "Tencent",
	xiaomi: "Xiaomi (MiMo)",
};

const SIGN_IN_BY_PROVIDER: Record<string, "claude" | "chatgpt" | "gemini"> = {
	anthropic: "claude",
	chatgpt: "chatgpt",
	gemini: "gemini",
};

const SIGN_IN_HINTS: Record<"claude" | "chatgpt" | "gemini", string> = {
	claude: "a browser opens; runs /login claude",
	chatgpt: "a browser or a device code; runs /login chatgpt",
	gemini: "a browser opens; runs /login gemini",
};

/** The order the hub lists providers in: the two subscription wires first. */
const PROVIDER_ORDER = ["anthropic", "openai"];

/** The hub's short names for the three wires a custom endpoint may speak. */
const WIRES: Array<{ id: CustomProviderApiId; label: string; description: string }> = [
	{
		id: "openai-completions",
		label: "Chat completions",
		description: "most gateways: DeepSeek, Kimi, GLM, OpenRouter, vLLM, Ollama",
	},
	{ id: "openai-responses", label: "Responses API", description: "when the endpoint speaks OpenAI's newer wire" },
	{
		id: "anthropic-messages",
		label: "Anthropic messages",
		description: "a proxy or gateway in front of Claude",
	},
];

/**
 * The providers the registry serves, one row each, keyed by provider id.
 *
 * Derived from the model table rather than written down a second time: a
 * provider added to the registry appears here with its own key variable, and
 * the row cannot disagree with what a request will look for. `faux` is left
 * out — it is the test provider, and a row offering to save a key for it
 * would be advice about a wire no user has.
 */
export function configProviders(): ConfigProvider[] {
	const byId = new Map<string, ConfigProvider>();
	for (const model of listModels()) {
		if (model.provider === "faux") continue;
		const envNames = [model.apiKeyEnv, ...(model.apiKeyEnvFallbacks ?? [])].filter(
			(name): name is string => name !== undefined && name !== "",
		);
		const existing = byId.get(model.provider);
		if (existing) {
			for (const name of envNames) if (!existing.envNames.includes(name)) existing.envNames.push(name);
			if (model.api !== "chatgpt-responses" && model.api !== "gemini-code-assist") existing.probeable = true;
			continue;
		}
		byId.set(model.provider, {
			id: model.provider,
			label: PROVIDER_LABELS[model.provider] ?? model.provider,
			envNames,
			signIn: SIGN_IN_BY_PROVIDER[model.provider],
			probeable: model.api !== "chatgpt-responses" && model.api !== "gemini-code-assist",
		});
	}
	return [...byId.values()].sort((a, b) => {
		const rank = (p: ConfigProvider) => {
			const index = PROVIDER_ORDER.indexOf(p.id);
			return index === -1 ? PROVIDER_ORDER.length : index;
		};
		return rank(a) - rank(b) || a.label.localeCompare(b.label);
	});
}

/**
 * What this process can run the provider with.
 *
 * The order is the request path's: an environment key first (the shell's wins
 * over the file's, which is why `appliedEnv` exists), then a sign-in. A
 * provider whose rows name no key variable is "keyless" only when it has no
 * subscription wire either — chatgpt and gemini name no variable and are not
 * usable without their sign-in.
 */
export function credentialOf(
	provider: ConfigProvider,
	signIns: SubscriptionSignIns,
	appliedEnv: ReadonlySet<string>,
	env: NodeJS.ProcessEnv = process.env,
): ProviderCredential {
	for (const name of provider.envNames) {
		if (!env[name]) continue;
		return { kind: "env", name, from: appliedEnv.has(name) ? "settings" : "shell" };
	}
	if (provider.signIn && signIns[provider.signIn]) return { kind: "sign-in" };
	if (provider.envNames.length === 0 && !provider.signIn) return { kind: "keyless" };
	return { kind: "none" };
}

/** The hub row's right-hand column: what the credential is, in as few words as fit. */
export function describeCredential(credential: ProviderCredential): string {
	switch (credential.kind) {
		case "env":
			return `key: ${credential.name}${credential.from === "settings" ? " · saved" : " · shell"}`;
		case "sign-in":
			return "signed in";
		case "keyless":
			return "no key needed";
		case "none":
			return "no key";
	}
}

/**
 * The screen, from the hub down.
 *
 * A loop rather than recursion: every sub-screen returns here to re-read what
 * it just changed, so the hub's counts and marks are never a snapshot taken
 * before the save below them.
 */
export async function runApiConfig(options: ApiConfigOptions): Promise<void> {
	const home = options.home ?? homedir();
	const dialog = options.dialog;
	const settings = options.settings;
	const applied = new Set(options.appliedEnv ?? []);
	const signIns = await (options.loadSignIns?.() ?? detectSubscriptionSignIns({ home }));

	/** One write of a key value, through every layer it has to reach. */
	const saveKey = (name: string, value: string): string => {
		writeUserSettingsNestedPatch("env", { [name]: value }, home);
		settings.env = { ...settings.env, [name]: value };
		// The shell's copy wins over the file at startup and here for the same
		// reason: redirecting a credential the user exported is not a settings
		// screen's call. `applied` is the set startup did apply from the file, so
		// a name in it is ours to move.
		const shellOwns = process.env[name] !== undefined && !applied.has(name);
		if (!shellOwns) {
			process.env[name] = value;
			applied.add(name);
		}
		return shellOwns
			? `Saved ${name} to ${SETTINGS_SHOWN}. This shell already exports ${name}; its value stays in force for this session.`
			: `Saved ${name} to ${SETTINGS_SHOWN} and applied it to this session.`;
	};

	/** Ask the provider what it serves, and say what moved. */
	const probe = async (provider: string): Promise<void> => {
		if (!options.probe) return;
		let refresh: CatalogRefresh | undefined;
		try {
			refresh = await options.probe(provider);
		} catch {
			// The screen already saved the thing the user came to save; a probe
			// that blew up is one provider not answering, not a failed save.
		}
		const notice = formatCatalogNotice(refresh);
		options.report(
			notice ??
				(refresh
					? "The provider answered; the model list is unchanged."
					: "The provider did not answer; the model list is unchanged."),
		);
	};

	/** The provider screen, returned to after each action that changes it. */
	const editProvider = async (provider: ConfigProvider): Promise<void> => {
		for (;;) {
			const credential = credentialOf(provider, signIns, applied);
			const savedNames = provider.envNames.filter((name) => settings.env?.[name] !== undefined);
			const rows: Array<{ label: string; description?: string; action: () => Promise<void> }> = [];

			if (provider.signIn) {
				rows.push({
					label: credential.kind === "sign-in" ? "Sign in again" : "Sign in with a subscription",
					description: SIGN_IN_HINTS[provider.signIn],
					action: async () => {
						const ran = options.runCommand?.(`/login ${provider.signIn}`);
						if (!ran) {
							options.report(`Run /login ${provider.signIn} to sign in to ${provider.label}.`);
						}
					},
				});
			}
			if (provider.envNames.length > 0) {
				const primary = provider.envNames[0];
				const also = provider.envNames.slice(1);
				rows.push({
					label: credential.kind === "env" && credential.name === primary ? "Replace API key…" : "Set API key…",
					description: `saved as ${primary}${also.length > 0 ? `; ${also.join(", ")} also accepted` : ""}`,
					action: async () => {
						const value = await dialog.promptText({
							title: primary,
							hint: `Pasted into a masked field and saved to ${SETTINGS_SHOWN}.`,
							mask: true,
							validate: (text) => (/\s/.test(text) ? "An API key does not contain spaces." : undefined),
						});
						if (value === null || value === "") return;
						try {
							options.report(saveKey(primary, value));
						} catch (error) {
							options.report(`Could not save the key: ${messageOf(error)}`);
							return;
						}
						if (provider.probeable) await probe(provider.id);
					},
				});
			}
			if (savedNames.length > 0) {
				rows.push({
					label: "Remove saved key",
					description: `deletes ${savedNames.join(", ")} from ${SETTINGS_SHOWN}`,
					action: async () => {
						const answer = await dialog.askUser([
							{
								header: provider.label,
								question: `Remove the saved key${savedNames.length > 1 ? "s" : ""} for ${provider.label}?`,
								options: [
									{ label: "Keep it", description: "nothing changes" },
									{
										label: `Remove ${savedNames.join(", ")}`,
										description: "the value is deleted from the settings file",
									},
								],
							},
						]);
						if (answer?.[0]?.startsWith("Remove ") !== true) return;
						try {
							writeUserSettingsNestedPatch(
								"env",
								Object.fromEntries(savedNames.map((name) => [name, undefined])),
								home,
							);
						} catch (error) {
							options.report(`Could not remove the key: ${messageOf(error)}`);
							return;
						}
						const env = { ...settings.env };
						for (const name of savedNames) {
							delete env[name];
							// Only a value this settings file put there is ours to take
							// away; the shell's own export is not.
							if (applied.has(name)) {
								delete process.env[name];
								applied.delete(name);
							}
						}
						settings.env = env;
						options.report(`Removed ${savedNames.join(", ")} from ${SETTINGS_SHOWN}.`);
					},
				});
			}
			if (provider.probeable && credential.kind !== "none") {
				rows.push({
					label: "Check what it serves now",
					description: "asks the provider and refreshes the /model list",
					action: async () => {
						await probe(provider.id);
					},
				});
			}

			const title =
				rows.length === 0
					? `${provider.label} — ${describeCredential(credential)} · nothing to configure`
					: `${provider.label} — ${describeCredential(credential)}`;
			const index = await dialog.pickFromList(
				title,
				rows.map(({ label, description }) => ({ label, description })),
				{ initialIndex: 0 },
			);
			if (index === null) return;
			await rows[index]?.action();
		}
	};

	const customSpecs = (): OpenAICompatibleProviderSpec[] => [...(settings.providers?.openaiCompatible ?? [])];

	/** Save the custom endpoint list, in the file and in the live settings object. */
	const saveCustomSpecs = (specs: OpenAICompatibleProviderSpec[]): void => {
		const providers = { ...(settings.providers ?? {}), openaiCompatible: specs };
		writeUserSettingsPatch({ providers }, home);
		settings.providers = providers;
	};

	/** Rebuild the live custom-model registry from a list — the only way a removal takes effect. */
	const reregister = (specs: OpenAICompatibleProviderSpec[]): void => {
		clearCustomModels();
		for (const spec of specs) registerOpenAICompatibleProvider(spec);
	};

	/** A positive whole number, asked as text. */
	const promptCount = async (title: string, hint: string): Promise<number | null> => {
		const raw = await dialog.promptText({
			title,
			hint,
			validate: (text) =>
				/^\d+$/.test(text) && Number(text) > 0 ? undefined : "Enter a whole number greater than zero.",
		});
		if (raw === null || raw === "") return null;
		return Number(raw);
	};

	const addEndpoint = async (): Promise<void> => {
		const existing = customSpecs();
		const known = new Set(configProviders().map((provider) => provider.id));
		const id = await dialog.promptText({
			title: "Endpoint id",
			hint: "the prefix in provider/model, and the name /config shows",
			validate: (text) => {
				if (!/^[a-z][a-z0-9-]*$/.test(text)) return "Use lowercase letters, digits and dashes, starting with a letter.";
				if (known.has(text)) return `"${text}" is a built-in provider; choose another id.`;
				if (existing.some((spec) => spec.id === text)) return `An endpoint named "${text}" already exists.`;
				return undefined;
			},
		});
		if (!id) return;
		const baseUrl = await dialog.promptText({
			title: "Base URL",
			hint: "the endpoint's root, e.g. https://api.deepseek.com/v1",
			validate: (text) => {
				try {
					const url = new URL(text);
					if (url.protocol !== "http:" && url.protocol !== "https:") return "Use an http:// or https:// URL.";
				} catch {
					return "That is not a URL.";
				}
				return undefined;
			},
		});
		if (!baseUrl) return;
		const defaultEnv = `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
		const apiKeyEnv = await dialog.promptText({
			title: "API key variable",
			initial: defaultEnv,
			hint: "the environment variable the key is read from",
			validate: (text) =>
				/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? undefined : "Use a shell variable name: letters, digits, underscores.",
		});
		if (!apiKeyEnv) return;
		const wireIndex = await dialog.pickFromList(
			"Wire protocol",
			WIRES.map(({ label, description }) => ({ label, description })),
			{ initialIndex: 0 },
		);
		if (wireIndex === null) return;
		const api = WIRES[wireIndex]?.id ?? "openai-completions";

		const models: OpenAICompatibleProviderSpec["models"] = [];
		for (;;) {
			const modelId = await dialog.promptText({
				title: models.length === 0 ? "Model id" : "Another model id",
				hint: `as the endpoint names it${models.length > 0 ? " — Esc when the list is done" : ""}`,
			});
			if (!modelId) break;
			const contextWindow = await promptCount("Context window", "how many tokens the model can read");
			if (contextWindow === null) break;
			const maxOutputTokens = await promptCount("Max output tokens", "how many tokens one answer may spend");
			if (maxOutputTokens === null) break;
			models.push({ id: modelId, contextWindow, maxOutputTokens });
			const more = await dialog.pickFromList(
				`${models.length} model${models.length === 1 ? "" : "s"}`,
				[{ label: "Add another model" }, { label: "Done" }],
				{ initialIndex: 1 },
			);
			if (more !== 0) break;
		}
		if (models.length === 0) {
			options.report("Nothing was added: an endpoint needs at least one model.");
			return;
		}

		const key = await dialog.promptText({
			title: `${apiKeyEnv} (optional)`,
			hint: `paste the key now and it is saved to ${SETTINGS_SHOWN}, or leave it empty and export it yourself`,
			mask: true,
			optional: true,
		});
		if (key === null) return;

		const spec: OpenAICompatibleProviderSpec = { id, baseUrl, apiKeyEnv, api, models };
		try {
			saveCustomSpecs([...existing, spec]);
		} catch (error) {
			options.report(`Could not save the endpoint: ${messageOf(error)}`);
			return;
		}
		registerOpenAICompatibleProvider(spec);
		if (key !== "") {
			try {
				options.report(saveKey(apiKeyEnv, key));
			} catch (error) {
				options.report(`The endpoint was saved, but the key was not: ${messageOf(error)}`);
			}
		}
		options.report(`Added ${id}. /model now lists ${id}/${models[0]?.id}.`);
		await probe(id);
	};

	const editEndpoint = async (spec: OpenAICompatibleProviderSpec): Promise<void> => {
		for (;;) {
			const index = await dialog.pickFromList(`${spec.id} — ${spec.baseUrl}`, [
				{
					label: "Edit base URL…",
					description: "the endpoint's root; new sessions and /model switches read it",
				},
				{
					label: "Set or replace API key…",
					description: `saved as ${spec.apiKeyEnv}`,
				},
				{ label: "Remove endpoint…", description: "also drops its models from /model" },
			]);
			if (index === null) return;

			if (index === 0) {
				const nextBase = await dialog.promptText({
					title: "Base URL",
					initial: spec.baseUrl,
					validate: (text) => {
						try {
							const url = new URL(text);
							if (url.protocol !== "http:" && url.protocol !== "https:") return "Use an http:// or https:// URL.";
						} catch {
							return "That is not a URL.";
						}
						return undefined;
					},
				});
				if (!nextBase || nextBase === spec.baseUrl) return;
				const specs = customSpecs().map((entry) => (entry.id === spec.id ? { ...entry, baseUrl: nextBase } : entry));
				try {
					saveCustomSpecs(specs);
				} catch (error) {
					options.report(`Could not save the base URL: ${messageOf(error)}`);
					return;
				}
				for (const entry of specs) if (entry.id === spec.id) registerOpenAICompatibleProvider(entry);
				options.report(
					`${spec.id} now points at ${nextBase}. A session already running on one of its models keeps the URL it resolved; new sessions and /model switches read the new one.`,
				);
				await probe(spec.id);
				return;
			}

			if (index === 1) {
				const value = await dialog.promptText({
					title: spec.apiKeyEnv,
					hint: `Pasted into a masked field and saved to ${SETTINGS_SHOWN}.`,
					mask: true,
					validate: (text) => (/\s/.test(text) ? "An API key does not contain spaces." : undefined),
				});
				if (value === null || value === "") return;
				try {
					options.report(saveKey(spec.apiKeyEnv, value));
				} catch (error) {
					options.report(`Could not save the key: ${messageOf(error)}`);
					return;
				}
				await probe(spec.id);
				return;
			}

			if (index === 2) {
				const answer = await dialog.askUser([
					{
						header: spec.id,
						question: `Remove the endpoint ${spec.id}?`,
						options: [
							{ label: "Keep it", description: "nothing changes" },
							{ label: "Remove endpoint", description: `its ${spec.models.length} model(s) leave /model` },
						],
					},
				]);
				if (answer?.[0] !== "Remove endpoint") return;
				const specs = customSpecs().filter((entry) => entry.id !== spec.id);
				try {
					saveCustomSpecs(specs);
				} catch (error) {
					options.report(`Could not remove the endpoint: ${messageOf(error)}`);
					return;
				}
				reregister(specs);
				options.report(`Removed ${spec.id}.`);
				return;
			}
		}
	};

	const customScreen = async (): Promise<void> => {
		for (;;) {
			const specs = customSpecs();
			const items = [
				...specs.map((spec) => ({
					label: `${spec.id} — ${spec.baseUrl}`,
					description: `${spec.models.length} model${spec.models.length === 1 ? "" : "s"} · key ${spec.apiKeyEnv}`,
				})),
				{ label: "Add an endpoint…", description: "an OpenAI-compatible gateway, proxy or local daemon" },
			];
			const index = await dialog.pickFromList("Custom endpoints", items, {
				initialIndex: specs.length === 0 ? specs.length : 0,
			});
			if (index === null) return;
			if (index === specs.length) {
				await addEndpoint();
				continue;
			}
			const spec = specs[index];
			if (spec) await editEndpoint(spec);
		}
	};

	for (;;) {
		const providers = configProviders();
		const credentials = providers.map((provider) => credentialOf(provider, signIns, applied));
		const ready = credentials.filter((credential) => credential.kind !== "none").length;
		const specs = customSpecs();
		const discovery = settings.modelDiscovery !== false;

		const index = await dialog.pickFromList("Settings", [
			{
				label: "Providers & API keys",
				description: `${ready} of ${providers.length} ready — sign in, or save a key`,
			},
			{
				label: "Custom endpoints",
				description:
					specs.length === 0
						? "none — add an OpenAI-compatible gateway or local daemon"
						: `${specs.length} configured — add, edit or remove`,
			},
			{
				label: "Model discovery",
				description: discovery
					? "on — ask each provider what it serves; /model shows the answer"
					: "off — the picker lists the built-in table",
			},
			{
				label: "Default model",
				description: options.modelRef ? `this session: ${options.modelRef}` : "opens the /model picker",
			},
			{ label: "Open settings file", description: SETTINGS_SHOWN },
		]);
		if (index === null) return;

		if (index === 0) {
			const rows = providers.map((provider, i) => ({
				label: provider.label,
				description: describeCredential(credentials[i] ?? { kind: "none" }),
			}));
			const chosen = await dialog.pickFromList("Providers & API keys", rows);
			if (chosen === null) continue;
			const provider = providers[chosen];
			if (provider) await editProvider(provider);
			continue;
		}

		if (index === 1) {
			await customScreen();
			continue;
		}

		if (index === 2) {
			const chosen = await dialog.pickFromList(
				"Model discovery",
				[
					{
						label: `${discovery ? "* " : "  "}On`,
						description: "one request per provider with a key, at startup and as /model opens",
					},
					{
						label: `${discovery ? "  " : "* "}Off`,
						description: "no probes; the picker lists the built-in table only",
					},
				],
				{ initialIndex: discovery ? 0 : 1 },
			);
			if (chosen === null) continue;
			const on = chosen === 0;
			try {
				writeUserSettingsPatch({ modelDiscovery: on }, home);
			} catch (error) {
				options.report(`Could not save the discovery setting: ${messageOf(error)}`);
				continue;
			}
			settings.modelDiscovery = on;
			options.report(
				on
					? "Model discovery: on. /model asks the providers what they serve as it opens."
					: "Model discovery: off. /model lists the built-in table and sends no probes.",
			);
			continue;
		}

		if (index === 3) {
			if (options.runCommand?.("/model")) return;
			options.report("Run /model to see and switch models.");
			continue;
		}

		if (index === 4) {
			if (options.openSettings?.()) {
				options.report(`Opening ${SETTINGS_SHOWN} in your editor. Saved changes load at the next start.`);
			} else {
				options.report(`Settings file: ${SETTINGS_SHOWN}. Set $VISUAL or $EDITOR to open it from here.`);
			}
		}
	}
}

/** One line for a failed write or call. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
