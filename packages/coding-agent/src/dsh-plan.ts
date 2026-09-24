/**
 * The DeepSeek harness configuration in the target's shape: the DeepSeek route
 * and its defaults, registered models, the window mismatches worth reporting,
 * MCP servers, and the asset trees.
 *
 * Model extraction is shared with nothing and duplicated nowhere: the harness
 * spells a model entry the same way in its catalog and in a pi-ai route, so one
 * extractor reads both.
 */

import { join } from "node:path";
import { resolveModel } from "@labunbun/ai";
import { McpServerConfigSchema } from "@labunbun/mcp";
import type { DshMcpServer } from "./dsh-cordis.ts";
import type { RawDeepSeekHarness } from "./dsh-read.ts";
import {
	collectFileWrites,
	isRecord,
	mergeProviderSpecs,
	planMemoryAsRule,
	positiveInteger,
	summarizeNames,
	tildePath,
} from "./migrate-core.ts";
import type { ClaimScalar, MigrationItem, PlannedWrite } from "./migrate-types.ts";
import { resolveModelReference } from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";
import { OpenAICompatibleProviderSchema } from "./settings.ts";

// ---------------------------------------------------------------------------
// DeepSeek Harness
// ---------------------------------------------------------------------------

/** The route the harness's own composition serves DeepSeek from (`llm-deepseek`). */
const DSH_DEEPSEEK_ROUTE = "deepseek-official";

/** The credential variable the harness's DeepSeek route reads when its section names none. */
const DSH_DEEPSEEK_DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";

/**
 * Windows a harness deployment falls back to for a model entry that states none.
 * Both are the harness's own defaults, not measurements of the model.
 */
interface DshWindowDefaults {
	contextWindow: number;
	maxTokens: number;
}

/** `llm-pi-ai`'s `defaultContextWindow` / `defaultMaxTokens`. */
const DSH_PI_AI_DEFAULTS: DshWindowDefaults = { contextWindow: 262_144, maxTokens: 32_768 };

/** `llm-deepseek`'s own pair. */
const DSH_DEEPSEEK_DEFAULTS: DshWindowDefaults = { contextWindow: 1_000_000, maxTokens: 256_000 };

/**
 * The name in the harness's *shipped* preset table whose bundle means
 * `bypassPermissions` here.
 *
 * A preset is a name for a bundle — a sandbox mode plus an approval policy — and
 * the table itself is deployment configuration, so a name only settles what the
 * session will do when the document reading it also states the table, or when no
 * table is stated and the shipped one applies. The shipped entry `danger-full-access`
 * is `danger-full-access` + `never`: no confinement and no approval questions,
 * which is exactly what `bypassPermissions` means. The other shipped entry,
 * `workspace-write`, is `workspace-write` + `ask` — a sandbox mode and an approval
 * policy are different axes from a permission mode, so nothing else maps.
 */
const DSH_SHIPPED_BYPASS_PRESET = "danger-full-access";

/** One model entry a source document declares, with only the numbers it states itself. */
interface DshModelEntry {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
}

/**
 * Model entries a harness document declares.
 *
 * The DeepSeek catalog (`llm-deepseek.models`) and a pi-ai route's `models` list
 * spell an entry the same way — `{id, name?, contextWindow?, maxTokens?}` — so one
 * extractor serves both. Both also leave the numbers to the deployment when they
 * omit them, which is why an absent one stays absent here instead of being filled
 * with a default the document never claimed.
 */
function dshModelEntries(models: unknown): DshModelEntry[] {
	if (!Array.isArray(models)) return [];
	const out: DshModelEntry[] = [];
	for (const value of models) {
		if (!isRecord(value)) continue;
		const id = typeof value.id === "string" ? value.id.trim() : "";
		if (id === "") continue;
		const contextWindow = positiveInteger(value.contextWindow);
		const maxTokens = positiveInteger(value.maxTokens);
		out.push({
			id,
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
		});
	}
	return out;
}

/**
 * Entries in `providers.openaiCompatible` shape.
 *
 * An entry here has to carry positive numbers, so one that states neither takes
 * the deployment's own fallback — the route's `defaultContextWindow` /
 * `defaultMaxTokens` when it states them, the plugin's defaults otherwise.
 * `assumed` counts those, because a deployment default is not a measurement.
 */
function dshRouteModels(
	entries: DshModelEntry[],
	route: Record<string, unknown>,
	fallback: DshWindowDefaults,
): { models: Array<Record<string, unknown>>; assumed: number } {
	const contextWindow = positiveInteger(route.defaultContextWindow) ?? fallback.contextWindow;
	const maxTokens = positiveInteger(route.defaultMaxTokens) ?? fallback.maxTokens;
	let assumed = 0;
	const models = entries.map((entry) => {
		if (entry.contextWindow === undefined || entry.maxTokens === undefined) assumed += 1;
		return {
			id: entry.id,
			contextWindow: entry.contextWindow ?? contextWindow,
			maxOutputTokens: entry.maxTokens ?? maxTokens,
		};
	});
	return { models, assumed };
}

/**
 * The "which models travelled" clause of a provider-entry item: how many, how many
 * were left behind for a window this build's table contradicts, and how many are
 * sized by the harness's own deployment defaults rather than by a window their
 * document states.
 */
function dshModelCarryNote(
	declared: DshModelEntry[],
	carried: number,
	assumed: number,
	defaults: DshWindowDefaults,
): string {
	const parts = [`${carried} model(s) carried`];
	if (declared.length > carried) {
		parts.push(`${declared.length - carried} left out for a window this build's table contradicts (reported above)`);
	}
	if (assumed > 0) {
		parts.push(
			`${assumed} of them sized by the harness's deployment defaults (${defaults.contextWindow} context / ` +
				`${defaults.maxTokens} output) rather than by a window of their own`,
		);
	}
	return parts.join(", ");
}

/** The models this run's patch would leave under `providerId`, when it holds an entry for it at all. */
function dshRegisteredModels(settingsPatch: Record<string, unknown>, providerId: string): Set<string> | undefined {
	const providers = isRecord(settingsPatch.providers) ? settingsPatch.providers.openaiCompatible : undefined;
	if (!Array.isArray(providers)) return undefined;
	for (const entry of providers) {
		if (!isRecord(entry) || entry.id !== providerId) continue;
		const models = Array.isArray(entry.models) ? entry.models : [];
		return new Set(models.filter(isRecord).map((model) => (typeof model.id === "string" ? model.id : "")));
	}
	return undefined;
}

/**
 * The window sentence for an entry whose declared numbers disagree with this
 * build's table for the same model id, or `undefined` when they agree — or when
 * the table does not carry the id at all, which is not a disagreement.
 */
function dshWindowDrift(entry: DshModelEntry): string | undefined {
	const reference = resolveModelReference(entry.id);
	const known = reference === undefined ? undefined : resolveModel(reference);
	if (known === undefined) return undefined;
	const windows: string[] = [];
	if (entry.contextWindow !== undefined && entry.contextWindow !== known.contextWindow) {
		windows.push(`context ${entry.contextWindow} vs ${known.contextWindow}`);
	}
	if (entry.maxTokens !== undefined && entry.maxTokens !== known.maxOutputTokens) {
		windows.push(`output ${entry.maxTokens} vs ${known.maxOutputTokens}`);
	}
	return windows.length === 0 ? undefined : `${entry.id} (${windows.join(", ")}, source first)`;
}

/**
 * Report windows a source document records differently from this build's own
 * table for the same model id.
 *
 * The table's numbers are what a run uses for a model it resolves, and nothing in
 * a settings file can change them, so a disagreement is a fact to state rather
 * than a value to write: keeping one of two numbers in silence is exactly the
 * mismatch the report exists to prevent. Both numbers go in the text, because only
 * the user can say which is right — and an entry that declares a window the table
 * contradicts is left out of the provider entry built from the same document, for
 * the same reason.
 */
function reportDshWindowMismatches(items: MigrationItem[], entries: DshModelEntry[], from: string): void {
	const differing = entries.map(dshWindowDrift).filter((value): value is string => value !== undefined);
	if (differing.length === 0) return;
	items.push({
		source: "deepseek-harness",
		from,
		to: "—",
		action: "skip",
		detail: `the document records a different window than this build's table for ${summarizeNames(differing)} — the table's numbers are what a run uses, and a window from the source is never written`,
		containsSecret: false,
	});
}

/**
 * A reader row in this build's MCP config shape, or `null` for one missing what
 * its transport needs to start.
 *
 * A composition file computes fields with `!!js`, and a computed one comes back
 * absent rather than empty — so each field is checked for the shape this build's
 * config accepts instead of being copied through. An absent field stays absent:
 * `cwd: ""` is a directory, not "no directory", and the difference would be a
 * server started in the wrong place.
 *
 * The returned `secret` flag is true when the row carries env or header values,
 * whatever they are called: a stdio server's env is where its keys live, and a
 * header value is often a bearer token.
 */
function dshMcpConfig(server: DshMcpServer): { config: Record<string, unknown>; secret: boolean } | null {
	if (server.transport === "streamable-http") {
		if (typeof server.url !== "string" || server.url === "") return null;
		const headers = isRecord(server.headers) ? server.headers : {};
		const config: Record<string, unknown> = { type: "http", url: server.url };
		if (Object.keys(headers).length > 0) config.headers = headers;
		return { config, secret: Object.keys(headers).length > 0 };
	}
	if (typeof server.command !== "string" || server.command === "") return null;
	const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
	const env = isRecord(server.env) ? server.env : {};
	const config: Record<string, unknown> = { type: "stdio", command: server.command, args };
	if (Object.keys(env).length > 0) config.env = env;
	if (typeof server.cwd === "string" && server.cwd !== "") config.cwd = server.cwd;
	return { config, secret: Object.keys(env).length > 0 };
}

/**
 * Skills and the AGENTS.md memory document for the harness.
 *
 * Not {@link planAssetTrees}: this source spells skills two ways, and it keeps
 * its memory file under a root `$DSH_HOME` can move, so the labels come from the
 * resolved root instead of from a `~/<dir>` guess.
 */
export function planDeepSeekAssets(
	raw: RawDeepSeekHarness,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	collectFileWrites(
		"deepseek-harness",
		raw.skills,
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	if (raw.memory?.trim()) {
		planMemoryAsRule(
			"deepseek-harness",
			tildePath(home, join(raw.root, "AGENTS.md")),
			home,
			raw.memory,
			"imported-deepseek-harness.md",
			force,
			items,
			writes,
		);
	}
}

/**
 * DeepSeek Harness: one settings document under one root, whose top-level keys
 * are the harness's settings namespaces.
 *
 * The namespaces read here are the ones with a counterpart in this build's
 * settings — `agent-default-model` (→ `model`), `llm-pi-ai` (→
 * `providers.openaiCompatible`) and `permission` (→ `permissionMode`). The rest of
 * the document is deployment detail this build has no key for; the parts of it
 * that would change behaviour are named rather than copied.
 *
 * Nothing is written into the harness: its credential store and `.env` are named
 * and never opened, and its session logs are counted because the history importer
 * is the part that reads them.
 *
 * `home` is the labunbun home, used only to render labels: the harness root can
 * sit outside it, and {@link tildePath} leaves such a path absolute rather than
 * folding it under a `~` that does not contain it.
 */
export function planDeepSeekHarness(
	raw: RawDeepSeekHarness,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const settingsLabel = raw.settingsSource?.file ?? "settings.yaml";
	if (raw.settingsSource?.error !== undefined) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, raw.settingsSource.file)),
			to: "—",
			action: "skip",
			detail: `the settings document ${raw.settingsSource.error} — nothing was read from it, so no model, provider or permission setting of this source is in this report`,
			containsSecret: false,
		});
	}

	// The routes the document declares. Each one is an endpoint the harness can be
	// asked to serve a model from, which is what a provider entry here is — and a
	// route missing one of the facts an entry needs becomes a skip that names the
	// missing fact rather than a guessed value.
	const piAi = isRecord(raw.settings["llm-pi-ai"]) ? raw.settings["llm-pi-ai"] : undefined;
	const routes = piAi !== undefined && isRecord(piAi.providers) ? piAi.providers : undefined;
	const openaiCompatible: Array<Record<string, unknown>> = [];
	/** Why a declared route has no provider entry, for the model below to cite. */
	const routeNotes = new Map<string, string>();
	/** Where the harness records a thinking default, which this build asks per request instead. */
	const thinkingDefaults: string[] = [];
	/** The default model's route and id, and the one thinking level stored beside them. */
	const defaults = isRecord(raw.settings["agent-default-model"]) ? raw.settings["agent-default-model"] : undefined;
	if (defaults?.reasoningEffort !== undefined) thinkingDefaults.push("agent-default-model");
	if (routes !== undefined) {
		for (const [route, value] of Object.entries(routes)) {
			const label = `${settingsLabel} → llm-pi-ai.providers.${route}`;
			if (!isRecord(value)) {
				routeNotes.set(route, "its section is not an object");
				continue;
			}
			const baseUrl = typeof value.baseURL === "string" ? value.baseURL.trim() : "";
			const apiKeyEnv = typeof value.apiKeyEnv === "string" ? value.apiKeyEnv.trim() : "";
			if (baseUrl === "") {
				routeNotes.set(route, "it declares no baseURL, so the harness takes its endpoint from its own catalog");
				items.push({
					source: "deepseek-harness",
					from: label,
					to: "—",
					action: "skip",
					detail:
						"the route declares no baseURL — its endpoint then comes from the harness's own catalog for that " +
						"protocol, which this importer cannot read; add a providers.openaiCompatible entry with that baseUrl by hand",
					containsSecret: false,
				});
				continue;
			}
			if (apiKeyEnv === "") {
				routeNotes.set(route, "it names no apiKeyEnv to read the key from");
				items.push({
					source: "deepseek-harness",
					from: label,
					to: "—",
					action: "skip",
					detail:
						"the route names no apiKeyEnv, and a provider entry here has to name the environment variable its key " +
						"comes from — name one in the harness, or add the entry by hand if this endpoint needs no key",
					containsSecret: false,
				});
				continue;
			}
			const declared = dshModelEntries(value.models);
			reportDshWindowMismatches(items, declared, `${label}.models → window`);
			// An entry whose declared window contradicts this build's table is left out
			// of the provider entry rather than carried with a number no run would use:
			// the table's window is what a request is assembled against, so a second
			// number in the entry would describe something that never happens.
			const carried = declared.filter((entry) => dshWindowDrift(entry) === undefined);
			const { models, assumed } = dshRouteModels(carried, value, DSH_PI_AI_DEFAULTS);
			const spec = { id: `dsh-${route}`, baseUrl, apiKeyEnv, models };
			if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
				routeNotes.set(route, "its endpoint or model entries are not what a provider entry here accepts");
				items.push({
					source: "deepseek-harness",
					from: label,
					to: "—",
					action: "skip",
					detail: "the route's baseURL or model entries are not usable in a provider entry",
					containsSecret: false,
				});
				continue;
			}
			openaiCompatible.push(spec);
			if (value.reasoning !== undefined) thinkingDefaults.push(`llm-pi-ai.providers.${route}.reasoning`);
			// The harness speaks one of three protocols per route, and only the first
			// is the one a provider entry here uses — so a route naming another is
			// carried with the difference stated rather than presented as equivalent.
			const api = typeof value.api === "string" ? value.api.trim() : "";
			const otherProtocol = api !== "" && api !== "openai-completions";
			items.push({
				source: "deepseek-harness",
				from: label,
				to: `settings.json → providers.openaiCompatible[dsh-${route}]`,
				action: otherProtocol ? "downgrade" : "map",
				detail: [
					dshModelCarryNote(declared, models.length, assumed, DSH_PI_AI_DEFAULTS),
					otherProtocol ? `the route speaks "${api}", which is served here as chat-completions` : "",
					`set ${apiKeyEnv} in your environment`,
				]
					.filter(Boolean)
					.join("; "),
				containsSecret: false,
			});
		}
	}

	// llm-deepseek: the section of the route the harness's own composition mounts,
	// and this deployment's record of where DeepSeek traffic goes. That endpoint is
	// carried as a provider entry of its own rather than folded into the built-in
	// DeepSeek row: the section names both the URL and the variable its key is read
	// from, and either can be one this build does not ship. It is not carried as
	// `DEEPSEEK_BASE_URL` either — that override moves every DeepSeek row this build
	// resolves, including the ones the harness never named.
	const deepseekSection = isRecord(raw.settings["llm-deepseek"]) ? raw.settings["llm-deepseek"] : undefined;
	const deepseekProviderId = `dsh-${DSH_DEEPSEEK_ROUTE}`;
	if (deepseekSection !== undefined) {
		const label = `${settingsLabel} → llm-deepseek`;
		const protocol = typeof deepseekSection.protocol === "string" ? deepseekSection.protocol.trim() : "";
		const baseUrl = typeof deepseekSection.baseURL === "string" ? deepseekSection.baseURL.trim() : "";
		const namedApiKeyEnv = typeof deepseekSection.apiKeyEnv === "string" ? deepseekSection.apiKeyEnv.trim() : "";
		const declared = dshModelEntries(deepseekSection.models);
		reportDshWindowMismatches(items, declared, `${label}.models → window`);
		const carried = declared.filter((entry) => dshWindowDrift(entry) === undefined);
		// A provider entry here speaks chat-completions, and the harness's own
		// protocol default is `messages` — DeepSeek's Anthropic root. Pointing this
		// build's provider at a root that serves only the other protocol would hand
		// it requests it cannot answer, so the section is only carried when it says
		// chat-completions itself.
		if (protocol !== "chat-completions") {
			routeNotes.set(
				DSH_DEEPSEEK_ROUTE,
				protocol === ""
					? "it declares no protocol, and the harness serves that section over the messages protocol unless told otherwise"
					: `it speaks "${protocol}" rather than chat-completions`,
			);
			items.push({
				source: "deepseek-harness",
				from: label,
				to: "—",
				action: "skip",
				detail:
					`the section is served over the harness's ${protocol === "" ? "default messages" : `"${protocol}"`} protocol, ` +
					`while a provider entry here speaks chat-completions — no entry is registered for its endpoint${
						namedApiKeyEnv === "" || namedApiKeyEnv === DSH_DEEPSEEK_DEFAULT_API_KEY_ENV
							? ""
							: `, and its credential variable ${namedApiKeyEnv} is not carried either`
					}`,
				containsSecret: false,
			});
		} else if (baseUrl === "") {
			routeNotes.set(
				DSH_DEEPSEEK_ROUTE,
				"it declares no baseURL, so the harness falls back to DeepSeek's own endpoint",
			);
			items.push({
				source: "deepseek-harness",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"the section declares chat-completions but no baseURL — the harness then uses DeepSeek's own endpoint, or " +
					"$DEEPSEEK_BASE_URL when its environment exports one, and this build's own DeepSeek provider reads that same " +
					"variable — so no entry is registered for it; export DEEPSEEK_BASE_URL here if this deployment points elsewhere",
				containsSecret: false,
			});
		} else {
			const apiKeyEnv = namedApiKeyEnv === "" ? DSH_DEEPSEEK_DEFAULT_API_KEY_ENV : namedApiKeyEnv;
			const { models, assumed } = dshRouteModels(carried, deepseekSection, DSH_DEEPSEEK_DEFAULTS);
			const spec = { id: deepseekProviderId, baseUrl, apiKeyEnv, models };
			if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
				routeNotes.set(DSH_DEEPSEEK_ROUTE, "its endpoint or model entries are not what a provider entry here accepts");
				items.push({
					source: "deepseek-harness",
					from: label,
					to: "—",
					action: "skip",
					detail: "the section's baseURL or model entries are not usable in a provider entry",
					containsSecret: false,
				});
			} else {
				openaiCompatible.push(spec);
				items.push({
					source: "deepseek-harness",
					from: label,
					to: `settings.json → providers.openaiCompatible[${deepseekProviderId}]`,
					action: "map",
					detail: [
						`registered as "${deepseekProviderId}" with the endpoint and credential variable the section names`,
						dshModelCarryNote(declared, models.length, assumed, DSH_DEEPSEEK_DEFAULTS),
						`set ${apiKeyEnv} in your environment`,
					].join("; "),
					containsSecret: false,
				});
			}
		}
		if (deepseekSection.reasoningEffort !== undefined || deepseekSection.thinking !== undefined) {
			thinkingDefaults.push("llm-deepseek");
		}
	}
	if (thinkingDefaults.length > 0) {
		items.push({
			source: "deepseek-harness",
			from: `${settingsLabel} → ${summarizeNames(thinkingDefaults)}`,
			to: "—",
			action: "skip",
			detail:
				"thinking-effort defaults are recorded for the harness and not carried: this build chooses the effort per " +
				"request, so a stored default would describe something it does not do",
			containsSecret: false,
		});
	}
	mergeProviderSpecs(
		"deepseek-harness",
		openaiCompatible,
		(id) =>
			id === deepseekProviderId
				? `${settingsLabel} → llm-deepseek`
				: `${settingsLabel} → llm-pi-ai.providers.${id.replace(/^dsh-/, "")}`,
		items,
		settingsPatch,
		existing,
		force,
	);

	// The default model: a route name and a model id. Only worth claiming when that
	// pair still resolves to something this build can load.
	const route = typeof defaults?.provider === "string" ? defaults.provider.trim() : "";
	const modelId = typeof defaults?.model === "string" ? defaults.model.trim() : "";
	if (modelId !== "") {
		const from =
			route === ""
				? `${settingsLabel} → agent-default-model ("${modelId}")`
				: `${settingsLabel} → agent-default-model ("${route}/${modelId}")`;
		const declaredRoute = route !== "" && routes?.[route] !== undefined;
		const routeProviderId = `dsh-${route}`;
		const registered = declaredRoute ? dshRegisteredModels(settingsPatch, routeProviderId) : undefined;
		if (declaredRoute && registered?.has(modelId)) {
			claimScalar(
				"deepseek-harness",
				"model",
				`${routeProviderId}/${modelId}`,
				from,
				`carried on the "${routeProviderId}" provider entry registered above for the harness's "${route}" route; the prefix keeps a bare id that collides with a built-in from resolving somewhere else`,
			);
		} else if (declaredRoute) {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail: `the harness runs this model on its "${route}" route, which has no provider entry in this plan (${
					routeNotes.get(route) ?? `it does not list "${modelId}" among its models`
				}) — add "${modelId}" to providers.openaiCompatible[${routeProviderId}].models, then set model to "${routeProviderId}/${modelId}"`,
				containsSecret: false,
			});
		} else if (route === DSH_DEEPSEEK_ROUTE) {
			// The harness's own DeepSeek route: its section names both the endpoint and
			// the key variable. An id this build's table knows is claimed as the table's
			// own row only when the two agree about where the model is served — the same
			// id on a different endpoint is that endpoint's model, and re-pointing it
			// here would send the run to a host the user did not name.
			const resolved = resolveModelReference(modelId);
			const servedAt = resolved === undefined ? undefined : resolveModel(resolved)?.baseUrl;
			const harnessEndpoint = typeof deepseekSection?.baseURL === "string" ? deepseekSection.baseURL.trim() : "";
			const deepseekRegistered = dshRegisteredModels(settingsPatch, deepseekProviderId);
			const sectionNote = routeNotes.get(DSH_DEEPSEEK_ROUTE);
			if (resolved !== undefined && (harnessEndpoint === "" || harnessEndpoint === servedAt)) {
				claimScalar(
					"deepseek-harness",
					"model",
					resolved,
					from,
					`resolved to ${resolved} — the harness serves it over ${
						harnessEndpoint === "" ? "its own DeepSeek endpoint" : harnessEndpoint
					}, which is where this build sends the same id${
						sectionNote === undefined ? "" : ` (the section itself is not carried: ${sectionNote})`
					}`,
				);
			} else if (resolved !== undefined) {
				items.push({
					source: "deepseek-harness",
					from,
					to: "—",
					action: "skip",
					detail: `"${modelId}" is served here from ${servedAt}, while the harness serves it from ${harnessEndpoint} — the same id on another endpoint is that endpoint's model, so the name is not carried; set model to "${deepseekProviderId}/${modelId}" to run it there through the entry registered above`,
					containsSecret: false,
				});
			} else if (deepseekRegistered?.has(modelId)) {
				claimScalar(
					"deepseek-harness",
					"model",
					`${deepseekProviderId}/${modelId}`,
					from,
					`carried on the "${deepseekProviderId}" provider entry registered above from the harness's llm-deepseek section`,
				);
			} else {
				items.push({
					source: "deepseek-harness",
					from,
					to: "—",
					action: "skip",
					detail: `no model in this build's registry matches "${modelId}" — the model the harness runs on its "${route}" route; set model to a reference it carries, or register a provider entry for this one`,
					containsSecret: false,
				});
			}
		} else {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail:
					route === ""
						? "the harness's settings name a model without a route, so the endpoint that would serve it is not in the document — set model by hand"
						: `the harness runs "${modelId}" on "${route}", a route its settings document does not declare (the deployment composes it), so this importer cannot tell which endpoint would serve it — set model by hand if you know where it should point`,
				containsSecret: false,
			});
		}
	}

	// Permissions. The section names the preset a new session starts in, and a
	// preset is a *bundle*: a sandbox mode plus an approval policy. Only a bundle
	// that confines nothing and never asks coincides with a permission mode here —
	// a mode decides which calls ask, while a sandbox decides what the process may
	// touch at all, so neither implies the other. The name alone says nothing about
	// the bundle, which is why the entry is what gets read.
	const permissionSection = isRecord(raw.settings.permission) ? raw.settings.permission : undefined;
	const preset = typeof permissionSection?.defaultPreset === "string" ? permissionSection.defaultPreset.trim() : "";
	if (preset !== "") {
		const from = `${settingsLabel} → permission.defaultPreset ("${preset}")`;
		const table = isRecord(permissionSection?.presets) ? permissionSection.presets : undefined;
		const entry = table?.[preset];
		if (table !== undefined && isRecord(entry)) {
			const sandbox = typeof entry.sandbox === "string" ? entry.sandbox.trim() : "";
			const approval = typeof entry.approval === "string" ? entry.approval.trim() : "";
			if (sandbox === "danger-full-access" && approval === "never") {
				claimScalar(
					"deepseek-harness",
					"permissionMode",
					"bypassPermissions",
					from,
					`the document's "${preset}" preset bundles ${sandbox} with ${approval} — no confinement and no approval questions, which is what "bypassPermissions" means here`,
				);
			} else {
				items.push({
					source: "deepseek-harness",
					from,
					to: "—",
					action: "skip",
					detail: `the document's "${preset}" preset bundles ${sandbox || "an unnamed"} sandbox with ${approval || "an unnamed"} approval — a sandbox and a permission mode are different axes: a mode decides which calls ask, a sandbox decides what the process may touch at all; pick a mode with /permissions`,
					containsSecret: false,
				});
			}
		} else if (table !== undefined) {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail: `the document names "${preset}" while the permission.presets table it states does not define that name — a default the harness cannot resolve to a sandbox and an approval policy, so no mode is picked from it; pick one with /permissions`,
				containsSecret: false,
			});
		} else if (preset === DSH_SHIPPED_BYPASS_PRESET) {
			// No table in the document, so the harness's shipped one applies, and its
			// two entries are named after their own sandbox modes.
			claimScalar(
				"deepseek-harness",
				"permissionMode",
				"bypassPermissions",
				from,
				`"${preset}" is one of the harness's shipped presets, whose bundle is an unconfined sandbox and no approval questions — the same meaning as "bypassPermissions" here; the document states no table of its own, so the shipped one is the one that applies`,
			);
		} else {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail:
					preset === "workspace-write"
						? 'the harness\'s shipped "workspace-write" preset is a sandbox that confines writes plus an ask-for-approval policy — a sandbox and a permission mode are different axes, and there is no sandbox here for the confinement to mean anything; pick a mode with /permissions'
						: `"${preset}" is not a name in the harness's shipped preset table, and the table a deployment composes for itself lives in its composition rather than in this document — a name alone does not say which sandbox and approval it stands for; pick a mode with /permissions`,
				containsSecret: false,
			});
		}
	}

	// MCP servers come from the root's cordis patches. The sibling reader has
	// already decided which rows are usable; what is left here is what this build's
	// config can hold, and what it cannot.
	if (raw.mcp.notes.length > 0) {
		items.push({
			source: "deepseek-harness",
			from: `${tildePath(home, raw.root)} → cordis patches`,
			to: "—",
			action: "skip",
			detail: `${raw.mcp.notes.length} composition file(s) contributed no server — ${summarizeNames(
				raw.mcp.notes.map((note) => `${tildePath(home, note.from)} (${note.reason})`),
			)}`,
			containsSecret: false,
		});
	}
	for (const server of raw.mcp.servers) {
		const from = `${tildePath(home, server.from)} → mcp server "${server.name}"`;
		const prepared = dshMcpConfig(server);
		if (prepared === null || !McpServerConfigSchema.safeParse(prepared.config).success) {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail: `the ${server.transport} server does not carry what this build's config needs to start it`,
				containsSecret: false,
			});
			continue;
		}
		if (server.name in existingMcpServers && !force) {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail: "target already defines a server with this name — kept (use --force to overwrite)",
				containsSecret: false,
			});
			continue;
		}
		// Any env or header value counts as credential-bearing: a stdio server's env
		// is where its keys live, and a header value is often a bearer token. Saying
		// so costs one line of notice; the other error writes a credential into a
		// file the report calls ordinary.
		const secret = prepared.secret;
		mcpServers[server.name] = prepared.config;
		markMcpSecret(secret);
		items.push({
			source: "deepseek-harness",
			from,
			to: `.mcp.json → mcpServers.${server.name}`,
			action: "map",
			detail: secret ? "copied verbatim, including its environment or header values" : "copied verbatim",
			containsSecret: secret,
		});
	}

	// Files and trees that exist and are deliberately never read. Naming them is
	// what keeps their absence from the plan reading as a decision rather than an
	// oversight.
	if (raw.credentialsPresent) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, ".credentials.yaml")),
			to: "—",
			action: "skip",
			detail:
				"the harness's credential store — reported by name and never opened; copy anything you need out of it by hand",
			containsSecret: false,
		});
	}
	if (raw.envFilePresent) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, ".env")),
			to: "—",
			action: "skip",
			detail: "the harness's environment file — reported by name and never opened; export what it holds yourself",
			containsSecret: false,
		});
	}
	if (raw.presetCount > 0) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, ".agent-presets")),
			to: "—",
			action: "skip",
			detail: `${raw.presetCount} agent preset(s) — whole agent compositions, which are another product's plugin wiring rather than settings this build has a key for`,
			containsSecret: false,
		});
	}
	if (raw.attachmentsPresent) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, "attachments")),
			to: "—",
			action: "skip",
			detail: "session payloads stored beside the sessions — named only, never walked",
			containsSecret: false,
		});
	}
	if (raw.storagesPresent) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, "storages")),
			to: "—",
			action: "skip",
			detail: "non-session storage the harness keeps — named only, never walked",
			containsSecret: false,
		});
	}
}
