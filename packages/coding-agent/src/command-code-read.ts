// Command Code's user state as read from a home directory: the settings file
// and the legacy config below it, the two MCP files and their one merge order,
// the providers registry, skills, agents, commands, memory, and the trees
// named but never read. Read `command-code-home.ts` first for every path claim.
// Long-form design notes: docs/dev/migration-sources.md

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
	COMMAND_CODE_BUILT_IN_PROVIDER_IDS,
	COMMAND_CODE_CREDENTIAL_FILES,
	COMMAND_CODE_LEGACY_CONFIG_KEYS,
	COMMAND_CODE_OTHER_CHANNEL_CONFIG_FILES,
	COMMAND_CODE_PROVIDER_API_KINDS,
	COMMAND_CODE_PROVIDER_ID_PATTERN,
	COMMAND_CODE_REASONING_EFFORTS,
	COMMAND_CODE_RESERVED_PROVIDER_IDS,
	COMMAND_CODE_SETTINGS_KEYS_PASSED_OVER,
	COMMAND_CODE_SETTINGS_KEYS_READ,
	COMMAND_CODE_SKILL_COMPATIBILITY_MAX,
	COMMAND_CODE_SKILL_DESCRIPTION_MAX,
	COMMAND_CODE_SKILL_MANIFESTS,
	COMMAND_CODE_SKILL_MAX_DEPTH,
	COMMAND_CODE_SKILL_NAME_MAX,
	COMMAND_CODE_SKILL_NAME_PATTERN,
	commandCodeAgentsDir,
	commandCodeCommandsDir,
	commandCodeFileHistoryDir,
	commandCodeLegacyConfigPath,
	commandCodeMcpPaths,
	commandCodeMemoryPath,
	commandCodeProvidersPath,
	commandCodeRoot,
	commandCodeSessionsDir,
	commandCodeSettingsPath,
	commandCodeSkillsDir,
	commandCodeTreeHasContent,
	commandCodeTrustedHooksPath,
} from "./command-code-home.ts";
import { isRecord, readAgentFiles, readAttachments, readCommandFiles, readText, tildePath } from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";
import { parseFrontmatter } from "./skills.ts";

// Long-form design notes: docs/dev/migration-sources.md
/** One thing the walk found and did not carry over. `name` is a label, never a value from a credential-shaped key. */
export interface CommandCodeSkipped {
	name: string;
	reason: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * A credential reference as `providers.json` spells it — the three forms the
 * CLI resolves at request time, and nothing else. The value itself is never
 * kept: `env` and `template` keep only the variable names, and a `!command`
 * keeps no text at all, because a command's arguments are not this importer's
 * to read.
 */
export interface CommandCodeApiKeyReference {
	/** `env`: a `$VAR` or an exactly-`{env:VAR}` reference — the variable is named instead of resolved. */
	kind: "env" | "template" | "command";
	/** The single variable an `env` reference names. */
	variable?: string;
	/** The variables a `template` reference interpolates into a larger string. */
	variables?: string[];
}

/** USD per million tokens in the entry's own field names; only the numbers it actually carries. */
export interface CommandCodeProviderCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** One model under a provider entry, as `parseModel` reads it. */
export interface CommandCodeProviderModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxOutput?: number;
	/** True when the entry says `reasoning: true`; absent otherwise, as in the source's own result. */
	reasoning?: boolean;
	/** Post-filter levels; an empty array means the source said `reasoning: false`, which is a statement. */
	reasoningEfforts?: string[];
	/** Levels the source's own filter dropped (anything outside its five). */
	droppedReasoningEfforts?: number;
	cost?: CommandCodeProviderCost;
	/** A model-level `options` block is present; its contents were not read. */
	hasOptions?: boolean;
	/** A model-level wire override, when the source carries one. */
	api?: string;
	baseURL?: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** One BYOK provider, as far as this importer is concerned. The key itself is a reference or a flag, never a value. */
export interface CommandCodeProvider {
	id: string;
	/** The user's own name for it, when the entry carries one. Safe to print; it is not a credential. */
	name?: string;
	/** The resolved wire kind — always one of the three. */
	api: string;
	/** Which part of the entry decided the wire kind: its own `api`, its `npm` package through the source's map, or the source's default. */
	apiSource: "explicit" | "npm" | "default";
	/** The `npm` package the entry names, kept so the report can say what the source did with it. */
	npm?: string;
	baseURL: string;
	/** `apiKey: false` (top-level or under `options`): the endpoint needs no key. */
	keyless: boolean;
	/** The reference the entry names, when it names one this importer can keep. */
	apiKey?: CommandCodeApiKeyReference;
	/** True when the entry carried a plaintext key, which the source itself refuses and drops. */
	rawApiKeyDropped?: boolean;
	/** A `headers` block is present; the header names were not read out of it. */
	hasHeaders?: boolean;
	/** The models the source would load; an entry with none was refused before reaching here. */
	models: CommandCodeProviderModel[];
}

// Long-form design notes: docs/dev/migration-sources.md
/** One MCP server, credential channels already removed, with the file the winning entry came from. */
export interface CommandCodeMcp {
	name: string;
	/** The home-relative label of the place the winning entry was read from. */
	from: string;
	/**
	 * The transcription the planner works from: `transport` plus whichever of
	 * `command`, `args`, `url`, `enabled`, `envNames`, `hasHeaders`, `hasOAuth`
	 * the entry had. Header values and environment values are not in here at
	 * all — they were removed before this structure existed.
	 */
	config: Record<string, unknown>;
}

/** A server whose name a later file redefined; the later one is what runs, in the CLI and here. */
export interface CommandCodeMcpCollision {
	name: string;
	/** The source label of the entry that won — the later one. */
	kept: string;
	/** The source label of the entry it replaced — the earlier one. */
	dropped: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `settings.json`, as far as this importer reads it. A whitelist, so it is small. */
export interface CommandCodeSettings {
	/** `model` — the session model, when the file names one. */
	model?: string;
	/** `theme` — one of the CLI's three, when the file names one. */
	theme?: string;
	/** The whole `permissions` block, verbatim: allow/deny/ask/additionalDirectories rules, defaultMode, disableBypass. */
	permissions?: Record<string, unknown>;
	/** The legacy top-level `permissionMode`, which the CLI folds into `permissions.defaultMode`. */
	permissionMode?: string;
	/** The `hooks` block, verbatim and uninterpreted. */
	hooks?: unknown;
}

/**
 * Command Code's user state, as one read of one home.
 *
 * Every field is a value read out of a file, a *count* or a *label*, or a line
 * saying why neither happened. No field holds a credential and no field holds
 * a conversation.
 */
export interface RawCommandCode {
	/** The home directory the root was resolved against. */
	home: string;
	/** `~/.commandcode`, the one root the CLI writes to. */
	root: string;
	/** True when the root exists and holds something. */
	present: boolean;
	/** `~/.commandcode/settings.json`, named whether or not it was there. */
	settingsPath: string;
	/** Why `settings.json` could not be read, or `null`. "There is no file" is not a problem. */
	settingsProblem: string | null;
	/** The whitelisted settings; `null` when there was no readable file. */
	settings: CommandCodeSettings | null;
	/** `~/.commandcode/config.json`'s `model`, when the legacy file carries one. */
	legacyModel?: string;
	/** The legacy file's `theme`, when it carries one. */
	legacyTheme?: string;
	/** Why the legacy file could not be read, or `null`. */
	legacyProblem: string | null;
	/** The legacy file's path, named whether or not it was there. */
	legacyConfigPath: string;
	/** Keys of the legacy file outside the eight its own reader passes on. */
	legacyUnhandledKeys: string[];
	/** Every key the legacy file held, sorted — the plan names the recognized ones that had no destination. */
	legacyKeys: string[];
	/** The other release channels' config files that are on disk; named, never read. */
	otherChannelConfigs: string[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** Top-level `settings.json` keys present and not in this importer's catalogue. */
	unhandledSettings: string[];
	/** Keys present that the catalogue names, with the reason they do not travel. */
	passedOverSettings: string[];
	/** The merged MCP servers: settings below, then `mcp.json`, then `.mcp.json`, later winning by name. */
	mcpServers: CommandCodeMcp[];
	/** Names a later MCP file redefined over an earlier one. */
	mcpCollisions: CommandCodeMcpCollision[];
	/** `providers.json`'s BYOK entries that the CLI's own parser would load. */
	providers: CommandCodeProvider[];
	/** Ids `providers.json` records as tombstones (`disabled: true` / `enabled: false`). */
	disabledProviderIds: string[];
	/** Why `providers.json` could not be read, or `null`. */
	providersProblem: string | null;
	/** The registry file's path, named whether or not it was there. */
	providersPath: string;
	/** Skills from `~/.commandcode/skills`, validated by the CLI's own six rules. */
	assets: RawFile[];
	/** Personal sub-agent files, one Markdown file per agent. */
	agents: RawFile[];
	/** Personal command files, recursively, with the ones that could not become a skill. */
	commands: RawCommands;
	/** `~/.commandcode/AGENTS.md`, verbatim, or `null`. */
	memory: string | null;
	/** The credential stores that exist, **by name only**. Not one of them was opened. */
	credentialFiles: string[];
	/** Everything seen and not carried over, each with the reason. Sorted by name. */
	skipped: CommandCodeSkipped[];
}

/** A directory's entries, name-sorted. Unreadable or absent contributes none. */
function commandCodeDirectoryEntries(dir: string): Dirent[] {
	try {
		return [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * The three states of a JSON file, kept apart: absent, present-but-not-a-
 * readable-object, and a record. The difference between "no file" and "a file
 * that did not parse" is the difference between silence and a report line.
 */
function readJsonFileObject(path: string): { blob: Record<string, unknown> | null; problem: string | null } {
	if (!existsSync(path)) return { blob: null, problem: null };
	const text = readText(path);
	if (text === null) return { blob: null, problem: "is present but unreadable, so nothing was read from it" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			blob: null,
			problem: "is present and is not JSON — a half-written or hand-edited file, and nothing was read from it",
		};
	}
	if (!isRecord(parsed)) {
		return { blob: null, problem: "is present and is not a JSON object, so nothing was read from it" };
	}
	return { blob: parsed, problem: null };
}

/** A non-empty string, or nothing — the shape every scalar in this reader takes. */
function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** A finite positive number, or nothing — `asPositiveNumber`'s rule. */
function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A finite non-negative number, or nothing — `asNonNegativeNumber`'s rule. */
function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Whether a string parses as a URL at all — the whole of the CLI's own `isValidUrl`. */
function urlParses(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

/** `asApiKind`: the three wire kinds the CLI speaks, or nothing. */
function asCommandCodeApiKind(value: unknown): string | undefined {
	return typeof value === "string" && COMMAND_CODE_PROVIDER_API_KINDS.includes(value) ? value : undefined;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The source's `npm` package map, verbatim: AI-SDK packages it recognizes, and the native transport each stands for. */
const COMMAND_CODE_NPM_PACKAGE_MAP: Readonly<Record<string, string>> = {
	"@ai-sdk/openai-compatible": "openai-completions",
	"@ai-sdk/openai": "openai-completions",
	"@ai-sdk/anthropic": "anthropic-messages",
};

/** `readConnectionField`: a non-empty string at the top level, else the same key under `options`. */
function connectionField(raw: Record<string, unknown>, key: string): string | undefined {
	const direct = stringValue(raw[key]);
	if (direct !== undefined) return direct;
	const options = raw.options;
	if (!isRecord(options)) return undefined;
	return stringValue(options[key]);
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Classify a reference, keeping only names. `$VAR` and an exactly-`{env:VAR}`
 * string are one variable; a `{env:VAR}` inside a larger string is a template
 * (kept as the list of names it interpolates); a leading `!` is a command,
 * whose text is not kept at all. Anything else is a plaintext key, which the
 * CLI itself refuses — `undefined` says so.
 */
function classifyApiKeyReference(value: string): CommandCodeApiKeyReference | undefined {
	const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
	if (bare) return { kind: "env", variable: bare[1] };
	const exact = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
	if (exact) return { kind: "env", variable: exact[1] };
	const embedded = value.match(/\{env:[A-Za-z_][A-Za-z0-9_]*\}/g);
	if (embedded) return { kind: "template", variables: embedded.map((match) => match.slice(5, -1)) };
	if (value.startsWith("!")) return { kind: "command" };
	return undefined;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `parseCost`: read the four numbers in the source's own two spellings; a block with no number is not a cost. */
function readProviderCost(
	value: unknown,
	where: string,
	skipped: CommandCodeSkipped[],
): CommandCodeProviderCost | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		skipped.push({ name: `${where}.cost`, reason: "not an object — ignored, as the CLI's own reader does" });
		return undefined;
	}
	const cost: CommandCodeProviderCost = {
		input: nonNegativeNumber(value.input),
		output: nonNegativeNumber(value.output),
		cacheRead: nonNegativeNumber(value.cacheRead ?? value.cache_read),
		cacheWrite: nonNegativeNumber(value.cacheWrite ?? value.cache_write),
	};
	const carried = Object.entries(cost).filter(([, number]) => number !== undefined);
	if (carried.length === 0) return undefined;
	return Object.fromEntries(carried) as CommandCodeProviderCost;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `parseModel`, as faithfully as the report needs it: the same refusals, the same field set. */
function readProviderModel(
	id: string,
	raw: unknown,
	providerWhere: string,
	skipped: CommandCodeSkipped[],
): CommandCodeProviderModel | null {
	const where = `${providerWhere}.models.${id}`;
	if (!isRecord(raw)) {
		skipped.push({ name: where, reason: "not an object — the CLI's own reader skips a model that is not a table" });
		return null;
	}
	const limit = isRecord(raw.limit) ? raw.limit : undefined;
	const contextWindow = positiveNumber(raw.contextWindow) ?? (limit ? positiveNumber(limit.context) : undefined);
	const maxOutput = positiveNumber(raw.maxOutput) ?? (limit ? positiveNumber(limit.output) : undefined);
	let reasoningEfforts: string[] | undefined;
	let droppedReasoningEfforts = 0;
	if (Array.isArray(raw.reasoningEfforts)) {
		const kept = raw.reasoningEfforts.filter(
			(level): level is string => typeof level === "string" && COMMAND_CODE_REASONING_EFFORTS.includes(level),
		);
		droppedReasoningEfforts = raw.reasoningEfforts.length - kept.length;
		reasoningEfforts = kept;
	} else if (raw.reasoning === true) {
		reasoningEfforts = ["low", "medium", "high"];
	} else if (raw.reasoning === false) {
		reasoningEfforts = [];
	}
	let api: string | undefined;
	if (raw.api !== undefined) {
		api = asCommandCodeApiKind(raw.api);
		if (api === undefined) {
			skipped.push({
				name: where,
				reason: `its \`api\` is not one of ${COMMAND_CODE_PROVIDER_API_KINDS.join(", ")} — the CLI skips the model over it`,
			});
			return null;
		}
	}
	let baseURL: string | undefined;
	if (raw.baseURL !== undefined) {
		if (typeof raw.baseURL !== "string" || !urlParses(raw.baseURL)) {
			skipped.push({ name: where, reason: "its `baseURL` is not a URL — the CLI skips the model over it" });
			return null;
		}
		baseURL = raw.baseURL;
	}
	const cost = readProviderCost(raw.cost, where, skipped);
	const model: CommandCodeProviderModel = { id };
	const name = stringValue(raw.name);
	if (name !== undefined) model.name = name;
	if (contextWindow !== undefined) model.contextWindow = contextWindow;
	if (maxOutput !== undefined) model.maxOutput = maxOutput;
	if (raw.reasoning === true) model.reasoning = true;
	if (reasoningEfforts !== undefined) model.reasoningEfforts = reasoningEfforts;
	if (droppedReasoningEfforts > 0) model.droppedReasoningEfforts = droppedReasoningEfforts;
	if (cost !== undefined) model.cost = cost;
	// `options` is copied verbatim into the CLI's own parsed model, so it is an
	// ordinary place for a value that reached the file by mistake. It is carried
	// as a flag; its contents were not read.
	if (isRecord(raw.options)) model.hasOptions = true;
	if (api !== undefined) model.api = api;
	if (baseURL !== undefined) model.baseURL = baseURL;
	return model;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `parseProvider`, with the same refusals and the same resolve order: explicit `api`, then `npm`, then the default. */
function readProvider(
	id: string,
	raw: Record<string, unknown>,
	where: string,
	skipped: CommandCodeSkipped[],
): CommandCodeProvider | null {
	let api: string | undefined;
	let apiSource: CommandCodeProvider["apiSource"] = "default";
	if (raw.api !== undefined) {
		api = asCommandCodeApiKind(raw.api);
		if (api === undefined) {
			skipped.push({
				name: where,
				reason: `\`api\` is not one of ${COMMAND_CODE_PROVIDER_API_KINDS.join(", ")} — the CLI refuses the provider over it`,
			});
			return null;
		}
		apiSource = "explicit";
	}
	let npm: string | undefined;
	if (typeof raw.npm === "string") {
		npm = raw.npm;
		const mapped = COMMAND_CODE_NPM_PACKAGE_MAP[npm];
		if (api === undefined && mapped !== undefined) {
			api = mapped;
			apiSource = "npm";
		}
	}
	api = api ?? "openai-completions";
	const baseURL = connectionField(raw, "baseURL");
	if (baseURL !== undefined && !urlParses(baseURL)) {
		skipped.push({ name: where, reason: "its `baseURL` is not a URL — the CLI refuses the provider over it" });
		return null;
	}
	if (baseURL === undefined) {
		skipped.push({
			name: where,
			reason: "no `baseURL`, top-level or under `options` — the CLI refuses the provider over it",
		});
		return null;
	}
	let hasHeaders = false;
	if (raw.headers !== undefined) {
		const headers = raw.headers;
		if (isRecord(headers) && Object.values(headers).every((value) => typeof value === "string")) {
			hasHeaders = true;
		} else {
			skipped.push({
				name: `${where}.headers`,
				reason: "not a map of strings — ignored, as the CLI's own reader does",
			});
		}
	}
	const models: CommandCodeProviderModel[] = [];
	if (isRecord(raw.models)) {
		for (const [modelId, modelRaw] of Object.entries(raw.models)) {
			const model = readProviderModel(modelId, modelRaw, where, skipped);
			if (model !== null) models.push(model);
		}
	}
	if (models.length === 0) {
		skipped.push({
			name: where,
			reason:
				"it declares no model this reader would load, and a provider with no models can never serve a request — which is the wording of the CLI's own refusal",
		});
		return null;
	}
	const keyless = raw.apiKey === false || (isRecord(raw.options) && raw.options.apiKey === false);
	const provider: CommandCodeProvider = { id, api, apiSource, baseURL, keyless, models };
	const name = stringValue(raw.name);
	if (name !== undefined) provider.name = name;
	if (npm !== undefined) provider.npm = npm;
	if (!keyless) {
		const value = connectionField(raw, "apiKey");
		if (value !== undefined) {
			const reference = classifyApiKeyReference(value);
			// A plaintext key is refused by the CLI itself, so there is no parsed
			// form of this provider over there either — the flag is the report.
			if (reference === undefined) provider.rawApiKeyDropped = true;
			else provider.apiKey = reference;
		}
	}
	if (hasHeaders) provider.hasHeaders = true;
	return provider;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `parseProvidersConfig`: the two key spellings, the tombstones, the four reserved-id rules, then `parseProvider` per entry. */
function readCommandCodeProviders(
	root: string,
	home: string,
	skipped: CommandCodeSkipped[],
): { providers: CommandCodeProvider[]; disabledProviderIds: string[]; problem: string | null } {
	const path = commandCodeProvidersPath(root);
	const read = readJsonFileObject(path);
	if (read.problem !== null) return { providers: [], disabledProviderIds: [], problem: read.problem };
	const blob = read.blob;
	if (blob === null) return { providers: [], disabledProviderIds: [], problem: null };
	const mapping = blob.provider ?? blob.providers;
	if (mapping === undefined) return { providers: [], disabledProviderIds: [], problem: null };
	const label = tildePath(home, path);
	if (!isRecord(mapping)) {
		skipped.push({
			name: label,
			reason:
				"its `provider`/`providers` key is not an object map, which is the first thing the CLI's reader checks — no provider was read out of it",
		});
		return { providers: [], disabledProviderIds: [], problem: null };
	}
	const providers: CommandCodeProvider[] = [];
	const disabledProviderIds: string[] = [];
	for (const [id, raw] of Object.entries(mapping)) {
		if (isRecord(raw) && (raw.disabled === true || raw.enabled === false)) {
			disabledProviderIds.push(id);
			continue;
		}
		if (!isRecord(raw)) {
			skipped.push({
				name: `${label} → ${id}`,
				reason: "not an object — the CLI's own reader refuses an entry that is not a table",
			});
			continue;
		}
		if (COMMAND_CODE_BUILT_IN_PROVIDER_IDS.includes(id)) {
			skipped.push({
				name: `${label} → ${id}`,
				reason:
					`'${id}' is one of the ids the CLI reserves for its own sign-in lanes — its own warning says to rename the entry ` +
					`(e.g. '${id}-api') and set "baseURL" explicitly, and the provider was skipped there and here`,
			});
			continue;
		}
		if (!COMMAND_CODE_PROVIDER_ID_PATTERN.test(id)) {
			skipped.push({
				name: `${label} → ${id}`,
				reason: "not a usable provider id — lowercase letters, digits, '.', '-' and '_' only",
			});
			continue;
		}
		if (COMMAND_CODE_RESERVED_PROVIDER_IDS.includes(id)) {
			skipped.push({
				name: `${label} → ${id}`,
				reason:
					`'${id}' is reserved for the auth file's own account fields (${COMMAND_CODE_RESERVED_PROVIDER_IDS.join(", ")}) ` +
					"— the CLI refuses the entry and the name was not used",
			});
			continue;
		}
		const provider = readProvider(id, raw, `${label} → ${id}`, skipped);
		if (provider !== null) providers.push(provider);
	}
	return { providers, disabledProviderIds, problem: null };
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * `inferTransport` + `toServerConfig`, then the scrub this importer always
 * applies before anything else sees the entry: header values are dropped
 * whole, environment values become names, the OAuth block becomes a flag.
 * `null` means the CLI itself would not load the entry.
 */
function normalizeMcpEntry(raw: unknown): Record<string, unknown> | null {
	if (!isRecord(raw)) return null;
	const declared = raw.transport ?? raw.type ?? "";
	const lower = typeof declared === "string" ? declared.toLowerCase() : "";
	const transport =
		lower === "http" || lower === "sse" || lower === "stdio" ? lower : raw.url && !raw.command ? "http" : "stdio";
	if (transport === "stdio" && !raw.command) return null;
	if ((transport === "http" || transport === "sse") && !raw.url) return null;
	const config: Record<string, unknown> = { transport };
	if (raw.command !== undefined) config.command = raw.command;
	if (raw.args !== undefined) config.args = raw.args;
	if (raw.url !== undefined) config.url = raw.url;
	if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
	if (isRecord(raw.env)) config.envNames = Object.keys(raw.env);
	if (raw.headers !== undefined) config.hasHeaders = true;
	// `toOAuthConfig` needs all three of these as strings before an OAuth block
	// counts; a partial block yields no OAuth in the CLI either, so it does not
	// become a flag here.
	if (
		isRecord(raw.oauth) &&
		typeof raw.oauth.authorizationUrl === "string" &&
		typeof raw.oauth.tokenUrl === "string" &&
		typeof raw.oauth.clientId === "string"
	) {
		config.hasOAuth = true;
	}
	return config;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The three MCP stores, in the CLI's own merge order: `settings.json` below, then `mcp.json`, then `.mcp.json`, later winning by name. */
function readCommandCodeMcp(
	settingsBlob: Record<string, unknown> | null,
	root: string,
	home: string,
	skipped: CommandCodeSkipped[],
): { mcpServers: CommandCodeMcp[]; collisions: CommandCodeMcpCollision[] } {
	const merged = new Map<string, CommandCodeMcp>();
	const collisions: CommandCodeMcpCollision[] = [];
	const add = (name: string, from: string, config: Record<string, unknown>): void => {
		const prior = merged.get(name);
		if (prior !== undefined) collisions.push({ name, kept: from, dropped: prior.from });
		merged.set(name, { name, from, config });
	};

	if (settingsBlob !== null && settingsBlob.mcp !== undefined) {
		const mcp = settingsBlob.mcp;
		if (!isRecord(mcp) || !Array.isArray(mcp.servers)) {
			skipped.push({
				name: `${tildePath(home, commandCodeSettingsPath(root))} → mcp.servers`,
				reason:
					"not the array of named servers the CLI reads — a `servers` value of any other shape is ignored there too",
			});
		} else {
			const from = `${tildePath(home, commandCodeSettingsPath(root))} → mcp.servers`;
			for (const entry of mcp.servers) {
				// The CLI's own filter, verbatim: an object with a string `name`.
				if (!isRecord(entry) || typeof entry.name !== "string") continue;
				const config = normalizeMcpEntry(entry);
				if (config === null) {
					skipped.push({
						name: `${from} → ${entry.name}`,
						reason: "an entry with neither a command nor a URL — nothing was serving it there either",
					});
					continue;
				}
				add(entry.name, from, config);
			}
		}
	}

	for (const path of commandCodeMcpPaths(root)) {
		if (!existsSync(path)) continue;
		const label = tildePath(home, path);
		const read = readJsonFileObject(path);
		if (read.problem !== null) {
			skipped.push({ name: label, reason: read.problem });
			continue;
		}
		const blob = read.blob;
		if (blob === null) continue;
		const servers = blob.mcpServers;
		if (servers === undefined) continue;
		if (!isRecord(servers)) {
			skipped.push({
				name: label,
				reason:
					"`mcpServers` is not a JSON object, so no server was read from it — the CLI's own reader iterates its keys and would have nothing to iterate",
			});
			continue;
		}
		for (const [name, entry] of Object.entries(servers)) {
			const config = normalizeMcpEntry(entry);
			// The CLI drops an entry its normalizer refuses, silently. Here it gets
			// a line, because a server missing from the import is worth knowing about.
			if (config === null) {
				skipped.push({
					name: `${label} → ${name}`,
					reason:
						"not a server the CLI's own normalizer would load — a stdio server needs a command, an HTTP one needs a URL, and this entry has neither it could use",
				});
				continue;
			}
			add(name, label, config);
		}
	}

	return { mcpServers: [...merged.values()], collisions };
}

// Long-form design notes: docs/dev/migration-sources.md
/** `validateSkillName`, verbatim messages included: the five rules the CLI refuses a skill over. */
function commandCodeSkillNameProblem(name: string): string | null {
	if (name.length === 0) return "Skill name is required";
	if (name.length > COMMAND_CODE_SKILL_NAME_MAX)
		return `Skill name must be ${COMMAND_CODE_SKILL_NAME_MAX} characters or less`;
	if (!COMMAND_CODE_SKILL_NAME_PATTERN.test(name))
		return "Skill name must contain only lowercase letters, numbers, and hyphens";
	if (name.startsWith("-") || name.endsWith("-")) return "Skill name cannot start or end with a hyphen";
	if (name.includes("--")) return "Skill name cannot contain consecutive hyphens";
	return null;
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * `validateSkillMetadata`'s checks, in its own order and with its own words,
 * as far as a line-based frontmatter reader can see them: name present and
 * well-formed, description present and bounded, compatibility bounded, and the
 * directory/name agreement the CLI enforces. `allowed-tools` is read as a
 * string by both parsers' common case; the array form passes the same way.
 * Returns the declared name, or the refusal reason.
 */
function validateCommandCodeSkill(content: string, directoryName: string): { name: string } | { reason: string } {
	const { data } = parseFrontmatter(content);
	const name = typeof data.name === "string" ? data.name : undefined;
	if (name === undefined) return { reason: "name: Skill name is required" };
	const nameProblem = commandCodeSkillNameProblem(name);
	if (nameProblem !== null) return { reason: `name: ${nameProblem}` };
	const description = typeof data.description === "string" ? data.description : undefined;
	if (description === undefined || description.length === 0)
		return { reason: "description: Skill description is required" };
	if (description.length > COMMAND_CODE_SKILL_DESCRIPTION_MAX) {
		return {
			reason: `description: Skill description must be ${COMMAND_CODE_SKILL_DESCRIPTION_MAX} characters or less`,
		};
	}
	const compatibility = typeof data.compatibility === "string" ? data.compatibility : undefined;
	if (compatibility !== undefined && compatibility.length > COMMAND_CODE_SKILL_COMPATIBILITY_MAX) {
		return {
			reason: `compatibility: Skill compatibility must be ${COMMAND_CODE_SKILL_COMPATIBILITY_MAX} characters or less`,
		};
	}
	if (name !== directoryName) return { reason: `name "${name}" does not match directory "${directoryName}"` };
	return { name };
}

interface CommandCodeSkillCandidate {
	directory: string;
	directoryName: string;
	manifest: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `resolveManifestIn`: the first of the two manifest spellings that exists. */
function skillManifestIn(directory: string): string | null {
	for (const manifest of COMMAND_CODE_SKILL_MANIFESTS) {
		if (existsSync(join(directory, manifest))) return manifest;
	}
	return null;
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * `walkLevel`: candidates under `dir`, depth-capped, dot-directories and
 * `node_modules` skipped. A top-level directory that contributes nothing gets
 * the CLI's own warning as a line; a loose `.md` file at the top gets the
 * other. Returns how many candidates were found, which is what the warning at
 * depth zero tests.
 */
function walkSkillLevel(
	dir: string,
	depth: number,
	candidates: CommandCodeSkillCandidate[],
	home: string,
	skipped: CommandCodeSkipped[],
): number {
	let count = 0;
	for (const entry of commandCodeDirectoryEntries(dir)) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (!entry.isDirectory()) {
			if (depth === 0 && entry.name.toLowerCase().endsWith(".md")) {
				skipped.push({
					name: tildePath(home, path),
					reason:
						"a loose .md file — the CLI asks for it to be wrapped in a directory named after the skill, so it was not registered there either",
				});
			}
			continue;
		}
		const manifest = skillManifestIn(path);
		if (manifest !== null) {
			candidates.push({ directory: path, directoryName: entry.name, manifest });
			count += 1;
			continue;
		}
		let below = 0;
		if (depth + 1 < COMMAND_CODE_SKILL_MAX_DEPTH) {
			below = walkSkillLevel(path, depth + 1, candidates, home, skipped);
		}
		count += below;
		if (depth === 0 && below === 0) {
			skipped.push({
				name: tildePath(home, path),
				reason: `a directory with no SKILL.md (or skill.md) in the first ${COMMAND_CODE_SKILL_MAX_DEPTH} levels — the CLI does not register it, and neither does this importer`,
			});
		}
	}
	return count;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `walkSkillLocation` over the personal root: the root itself may be one skill, named by its own directory name. */
function readCommandCodeSkills(root: string, home: string, skipped: CommandCodeSkipped[]): RawFile[] {
	const rootDir = commandCodeSkillsDir(root);
	if (!existsSync(rootDir)) return [];
	const candidates: CommandCodeSkillCandidate[] = [];
	const rootManifest = skillManifestIn(rootDir);
	if (rootManifest !== null) {
		// The CLI's `baseName(root)` rule: a manifest at the root itself makes the
		// root one skill, and its name is the root's own directory name.
		candidates.push({ directory: rootDir, directoryName: basename(rootDir), manifest: rootManifest });
	} else {
		walkSkillLevel(rootDir, 0, candidates, home, skipped);
	}
	const assets: RawFile[] = [];
	for (const candidate of candidates) {
		const manifestPath = join(candidate.directory, candidate.manifest);
		const content = readText(manifestPath);
		if (content === null) {
			skipped.push({ name: tildePath(home, manifestPath), reason: "the manifest is present but unreadable" });
			continue;
		}
		const validated = validateCommandCodeSkill(content, candidate.directoryName);
		if ("reason" in validated) {
			skipped.push({
				name: tildePath(home, manifestPath),
				reason: `the CLI does not register this skill — ${validated.reason}`,
			});
			continue;
		}
		const { attachments, attachmentSkips } = readAttachments(candidate.directory);
		assets.push({
			name: validated.name,
			sourcePath: manifestPath,
			content,
			attachments,
			attachmentSkips,
		});
	}
	return assets;
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Read one Command Code home. Resolves against `home` only — the CLI honours no
 * environment variable for its root — and never calls `os.homedir()`, so a test
 * that asserts on content must pass the same `home` the paths were built from.
 */
export function readCommandCode(home: string): RawCommandCode {
	const root = commandCodeRoot(home);
	const skipped: CommandCodeSkipped[] = [];

	// settings.json, then the legacy config below it for the two keys with a
	// destination. The three states are kept apart: "there is no file" is not a
	// problem, and "there is one and it did not parse" is a sentence.
	const settingsRead = readJsonFileObject(commandCodeSettingsPath(root));
	const settingsBlob = settingsRead.blob;
	let settings: CommandCodeSettings | null = null;
	if (settingsBlob !== null) {
		settings = {};
		const model = stringValue(settingsBlob.model);
		if (model !== undefined) settings.model = model;
		const theme = stringValue(settingsBlob.theme);
		if (theme !== undefined) settings.theme = theme;
		if (isRecord(settingsBlob.permissions)) settings.permissions = settingsBlob.permissions;
		const permissionMode = stringValue(settingsBlob.permissionMode);
		if (permissionMode !== undefined) settings.permissionMode = permissionMode;
		if (settingsBlob.hooks !== undefined) settings.hooks = settingsBlob.hooks;
	}
	const unhandledSettings: string[] = [];
	const passedOverSettings: string[] = [];
	if (settingsBlob !== null) {
		for (const key of Object.keys(settingsBlob).sort()) {
			if (COMMAND_CODE_SETTINGS_KEYS_READ.includes(key)) continue;
			if (COMMAND_CODE_SETTINGS_KEYS_PASSED_OVER.includes(key)) {
				passedOverSettings.push(key);
				continue;
			}
			unhandledSettings.push(key);
		}
		// Inside `mcp`, only `servers` is read; anything else under the key is
		// named here rather than silently walked past.
		if (isRecord(settingsBlob.mcp)) {
			for (const key of Object.keys(settingsBlob.mcp).sort()) {
				if (key !== "servers") unhandledSettings.push(`mcp.${key}`);
			}
		}
	}

	const legacyConfigPath = commandCodeLegacyConfigPath(root);
	const legacyRead = readJsonFileObject(legacyConfigPath);
	const legacyBlob = legacyRead.blob;
	const legacyModel = legacyBlob === null ? undefined : stringValue(legacyBlob.model);
	const legacyTheme = legacyBlob === null ? undefined : stringValue(legacyBlob.theme);
	const legacyKeys = legacyBlob === null ? [] : Object.keys(legacyBlob).sort();
	const legacyUnhandledKeys = legacyKeys.filter((key) => !COMMAND_CODE_LEGACY_CONFIG_KEYS.includes(key));
	const otherChannelConfigs = COMMAND_CODE_OTHER_CHANNEL_CONFIG_FILES.filter((name) => existsSync(join(root, name)));

	const { mcpServers, collisions } = readCommandCodeMcp(settingsBlob, root, home, skipped);
	const { providers, disabledProviderIds, problem: providersProblem } = readCommandCodeProviders(root, home, skipped);

	const assets = readCommandCodeSkills(root, home, skipped);
	const agents = readAgentFiles(commandCodeAgentsDir(root));
	const commands = readCommandFiles(commandCodeCommandsDir(root));
	const memory = readText(commandCodeMemoryPath(root));

	const credentialFiles = COMMAND_CODE_CREDENTIAL_FILES.filter((name) => existsSync(join(root, name)));

	// The trees that exist but are not read, each named once with the reason it
	// is named rather than opened. These are the lines that stop a report from
	// reading as "Command Code had nothing here".
	const fileHistoryDir = commandCodeFileHistoryDir(root);
	if (existsSync(fileHistoryDir)) {
		skipped.push({
			name: tildePath(home, fileHistoryDir),
			reason:
				"per-session file checkpoints, the material a rewind replays. Undo state is not configuration or conversation, so nothing here was read",
		});
	}
	const sessionsDir = commandCodeSessionsDir(root);
	if (existsSync(sessionsDir)) {
		skipped.push({
			name: tildePath(home, sessionsDir),
			reason:
				"the hook audit logs (`hooks-audit-<id>.jsonl`). A record of what hooks ran is not user configuration or conversation, so nothing here was read",
		});
	}
	const projectsDir = join(root, "projects");
	if (existsSync(projectsDir)) {
		skipped.push({
			name: tildePath(home, projectsDir),
			reason:
				"one directory per working directory, each holding that project's sessions and its private MCP file. The sessions are imported by the history phase; the MCP file belongs to one checkout and was not read. " +
				"This importer reads no project's configuration at all — not this, and not the `.commandcode` directories inside your checkouts either",
		});
	}
	const trustedHooksPath = commandCodeTrustedHooksPath(root);
	if (existsSync(trustedHooksPath)) {
		skipped.push({
			name: tildePath(home, trustedHooksPath),
			reason:
				"fingerprints of hooks you have approved. Trust state for project hooks this importer does not carry, so nothing here was read",
		});
	}
	const sharedSkillsDir = join(home, ".agents", "skills");
	if (existsSync(sharedSkillsDir)) {
		skipped.push({
			name: tildePath(home, sharedSkillsDir),
			reason:
				"the shared cross-tool `.agents` home, which Command Code reads below its own tree and this importer did not import. " +
				"This repository has an `agents` source that owns that home outright, so importing it here too would write every file in it twice and attribute the second copy to Command Code; run `--from agents` for it",
		});
	}

	skipped.sort((a, b) => a.name.localeCompare(b.name));
	return {
		home,
		root,
		present: commandCodeTreeHasContent(root),
		settingsPath: commandCodeSettingsPath(root),
		settingsProblem: settingsRead.problem,
		settings,
		legacyModel,
		legacyTheme,
		legacyProblem: legacyRead.problem,
		legacyConfigPath,
		legacyUnhandledKeys,
		legacyKeys,
		otherChannelConfigs,
		unhandledSettings,
		passedOverSettings,
		mcpServers,
		mcpCollisions: collisions,
		providers,
		disabledProviderIds,
		providersProblem,
		providersPath: commandCodeProvidersPath(root),
		assets,
		agents,
		commands,
		memory,
		credentialFiles,
		skipped,
	};
}
