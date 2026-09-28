/**
 * OpenCode's configuration in the target's shape: providers, MCP servers,
 * permission rules, the default model, and the asset trees.
 *
 * The rule translations are taken from the OpenCode source, not its docs; the
 * doc comments name the file and line each one was transcribed from, so a reader
 * who doubts one can go and look at the thing rather than at this paraphrase.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	ASSUMED_MAX_OUTPUT_TOKENS,
	collectFileWrites,
	isRecord,
	mergeProviderSpecs,
	placeholderNote,
	planCommands,
	planMemoryAsRule,
	positiveInteger,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
} from "./migrate-core.ts";
import type { AddPermissionRules, ClaimScalar, MigrationItem, PlannedWrite } from "./migrate-types.ts";
import { looksLikeSecretName, resolveModelReference } from "./migrate-types.ts";
import { OPENCODE_CONFIG_FILES, opencodeLegacyStorageDir, opencodeLegacyTomlPath } from "./opencode-home.ts";
import type { RawOpencode } from "./opencode-read.ts";
import { OPENCODE_CREDENTIAL_TABLES, OPENCODE_UNREAD_FILES } from "./opencode-read.ts";
import type { RawSettingsInput } from "./settings.ts";
import { OpenAICompatibleProviderSchema } from "./settings.ts";

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

/**
 * Keys of the merged settings this importer either reads or names, so that
 * anything else can be reported as unhandled rather than dropped.
 *
 * The list is the schema's own key set (`core/src/v1/config/config.ts:30-183`,
 * which is what the `awk` over that `Info` struct yields) minus the keys that are
 * about OpenCode's own runtime rather than about the user's agent — its TUI, its
 * updater, its share prompt, its terminal and diff-snapshot settings. Each of
 * those gets its own line below with the reason it is not a migration, so
 * nothing here is a silent discard.
 */
const OPENCODE_HANDLED = new Set([
	"provider",
	"model",
	"small_model",
	"mcp",
	"permission",
	"instructions",
	"agent",
	"skills",
	"plugin",
	"command",
	"enabled_providers",
	"disabled_providers",
	"default_agent",
	"mode",
	"tools",
	// Named below, never imported: OpenCode's own runtime.
	"$schema",
	"shell",
	"server",
	"references",
	"reference",
	"watcher",
	"snapshot",
	"share",
	"autoshare",
	"autoupdate",
	"username",
	"subagent_depth",
	"formatter",
	"lsp",
	"layout",
	"attachment",
	"compaction",
	"enterprise",
	"experimental",
	"tool_output",
]);

/** Keys whose only job is to be said out loud, with the reason. */
const OPENCODE_RUNTIME_KEYS: Array<[key: string, reason: string]> = [
	["shell", "which shell OpenCode's terminal tool runs — this build has a fixed one"],
	["server", "the settings for `opencode serve` and its web UI, which are OpenCode's own"],
	["references", "named git or local directory references OpenCode resolves for itself"],
	["watcher", "which paths its file watcher ignores"],
	["snapshot", "whether it takes its own revert snapshots, which its diff tool writes"],
	["share", "whether a session may be published to a public URL"],
	["autoupdate", "whether it updates itself"],
	["username", "the name it displays instead of the system username"],
	["subagent_depth", "how deep subagents may nest; this build's subagents cannot launch subagents"],
	["formatter", "which formatter it runs on edit, which this build does not have a setting for"],
	["lsp", "its language-server wiring, which this build has no equivalent of"],
	["layout", "its TUI's layout settings"],
	["attachment", "how files get attached to a message, which this build always does as a path"],
	["compaction", "its own compaction thresholds, which this build sets itself"],
	["enterprise", "its enterprise-deployment block"],
	["experimental", "a flag namespace for builds in flux, none of which this build reads"],
	["tool_output", "per-tool output truncation limits"],
	["username_mode", "a retired spelling of username"],
];

/** Permission keys OpenCode spells with a tool name this build uses differently. */
const OPENCODE_PERMISSION_TOOL: Readonly<Record<string, string>> = {
	read: "Read",
	edit: "Edit",
	glob: "Glob",
	grep: "Grep",
	list: "Glob",
	bash: "Bash",
	task: "Task",
	webfetch: "WebFetch",
	websearch: "WebSearch",
	skill: "Skill",
};

/** Permission keys with no counterpart, with what they governed. */
const OPENCODE_PERMISSION_UNMAPPED: Readonly<Record<string, string>> = {
	external_directory: "reading and writing outside the working directory, which this build's workspace roots govern",
	todowrite: "writing a to-do list, which this build's TodoWrite tool has no permission tier",
	question: "asking the user a question, which this build has no permission tier for",
	lsp: "talking to a language server, which this build has no tool for",
	doom_loop: "repeating a failing tool call, which this build does not do",
};

/** `opencode-read.ts`'s keys the credential report is written from. */
const from = (home: string, path: string): string => tildePath(home, path);

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

/**
 * OpenCode's `permission` block → this build's allow/deny rule strings.
 *
 * The shape (`core/src/v1/config/permission.ts`): a bare `"ask" | "allow" |
 * "deny"` that normalizes to `{"*": <action>}`, or an object whose keys are tool
 * names and whose values are either a bare action or a `Record<pattern, action>`.
 * So a nested object is a pattern rule and a bare string is a whole-tool rule,
 * which is the same distinction this build's `Tool(pattern)` syntax already makes.
 *
 * The two-tier problem is `ask`, which has no counterpart: a permission that stops
 * to ask is not an allow and turning it into one would run commands the user
 * meant to be prompted about. Every `ask` is therefore counted and named, and
 * **not** added to either list. That is the same call `grok-plan.ts` makes for its
 * own ask tier, and for the same reason.
 */
function planOpencodePermissions(
	block: unknown,
	label: string,
	items: MigrationItem[],
	addPermissionRules: AddPermissionRules,
): void {
	const action = (value: unknown): "allow" | "deny" | "ask" | null => {
		if (value === "allow" || value === "deny" || value === "ask") return value;
		return null;
	};
	const take = (tool: string, pattern: string, verdict: string, where: string): void => {
		if (verdict === "ask") {
			ask.push(where);
			return;
		}
		(verdict === "deny" ? deny : allow).push(pattern === "*" ? tool : `${tool}(${pattern})`);
	};

	const allow: string[] = [];
	const deny: string[] = [];
	const ask: string[] = [];

	// `normalizeInput` (core/src/v1/config/permission.ts:40-41) is exactly this:
	// a bare action means every key gets it.
	const whole = action(block);
	if (whole !== null) {
		take("*", "*", whole, "the whole permission block");
	} else if (isRecord(block)) {
		for (const [key, value] of Object.entries(block)) {
			const tool = OPENCODE_PERMISSION_TOOL[key];
			if (tool === undefined) {
				const why = OPENCODE_PERMISSION_UNMAPPED[key];
				items.push({
					source: "opencode",
					from: `${label} → ${key}`,
					to: "—",
					action: "skip",
					detail: why
						? `${why} — there is no rule here that means the same thing`
						: `a permission key this build has no tool for, so there is nothing to write a rule about`,
					containsSecret: false,
				});
				continue;
			}
			const bare = action(value);
			if (bare !== null) {
				take(tool, "*", bare, `${key}`);
				continue;
			}
			if (isRecord(value)) {
				for (const [pattern, verdict] of Object.entries(value)) {
					const verdictAction = action(verdict);
					if (verdictAction === null) {
						items.push({
							source: "opencode",
							from: `${label} → ${key}.${pattern}`,
							to: "—",
							action: "skip",
							detail: `not one of opencode's three answers (ask, allow, deny), so no rule was written for it`,
							containsSecret: false,
						});
						continue;
					}
					take(tool, pattern, verdictAction, `${key}(${pattern})`);
				}
				continue;
			}
			items.push({
				source: "opencode",
				from: `${label} → ${key}`,
				to: "—",
				action: "skip",
				detail: "neither one of opencode's three answers nor a table of pattern answers, so no rule was written for it",
				containsSecret: false,
			});
		}
	} else {
		items.push({
			source: "opencode",
			from: label,
			to: "—",
			action: "skip",
			detail: "neither one of opencode's three answers nor a table of them, so none of its rules were read",
			containsSecret: false,
		});
		return;
	}

	if (ask.length > 0) {
		items.push({
			source: "opencode",
			from: `${label} → ${summarizeNames(ask, 6)}`,
			to: "—",
			action: "skip",
			detail:
				`${ask.length} rule(s) opencode would stop and ask about — there is no ask tier here, and writing an allow would run ` +
				"exactly the calls the user meant to be prompted for, so they were left out of both lists",
			containsSecret: false,
		});
	}

	const overlap = allow.filter((rule) => deny.includes(rule));
	const notes: string[] = [];
	if (overlap.length > 0) {
		notes.push(
			`${overlap.length} rule(s) appear as both an allow and a deny; deny wins here as it does in opencode, and the allow is left ` +
				"in place so the file still reads like the decision that was made",
		);
	}
	const caveat =
		"an allowed command runs without a prompt here, and a deny blocks it whatever else is allowed" +
		(notes.length > 0 ? ` — ${notes.join("; ")}` : "");
	if (allow.length > 0) addPermissionRules("opencode", "allow", allow, `${label} → allow`, caveat);
	if (deny.length > 0) addPermissionRules("opencode", "deny", deny, `${label} → deny`, caveat);
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** `mcp` keys this build's server shape can hold, from either transport. */
const OPENCODE_MCP_CARRIED = new Set([
	"type",
	"command",
	"cwd",
	"environment",
	"enabled",
	"url",
	"headers",
	"oauth",
	"timeout",
]);

/**
 * Keys the entry holds that {@link OPENCODE_MCP_CARRIED} does not account for.
 *
 * The two branches above name every key they *expect* — a `url` on a local server,
 * an `oauth` block, a per-call `timeout` — because each of those is a key a user
 * has a reason to have written. A key nobody expected is a different case: it is
 * dropped, and a dropped key is the silent loss this importer exists to prevent.
 * `core/src/v1/config/mcp.ts:6-59` is the list this is checked against, and it
 * grows; the report grows with it rather than the import quietly not.
 */
function opencodeMcpUncarried(entry: Record<string, unknown>): string[] {
	return Object.keys(entry)
		.filter((key) => !OPENCODE_MCP_CARRIED.has(key))
		.map((key) => `it also carries ${key}, which this build's server shape has no field for`);
}

/**
 * One `mcp.<name>` entry → this build's server shape, or `null` when it is
 * neither transport.
 *
 * The two shapes are OpenCode's own (`core/src/v1/config/mcp.ts:6-59`):
 * `Local` has `type: "local"` and a `command` that is **the command and its
 * arguments in one array**, and `Remote` has `type: "remote"` and a `url`. The
 * union is discriminated on `type` (`:61`), so a missing `type` is not a
 * transport question at all and is reported as such rather than guessed at from
 * the presence of a `command`.
 *
 * `Local.command` is split here: this build's stdio server takes the executable
 * as `command` and the rest as `args`, and a one-element array is a bare command.
 */
function normalizeOpencodeMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const type = typeof entry.type === "string" ? entry.type : "";

	if (type === "local") {
		const parts = Array.isArray(entry.command) ? entry.command.filter((p): p is string => typeof p === "string") : [];
		if (parts.length === 0) return null;
		const [command, ...args] = parts;
		const out: Record<string, unknown> = { type: "stdio", command, args };
		if (isRecord(entry.environment)) out.env = entry.environment;
		if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") out.cwd = entry.cwd;
		if (entry.url !== undefined) downgrades.push("it also carries url, which only a remote server has");
		if (entry.headers !== undefined) downgrades.push("it also carries headers, which only a remote server has");
		if (isRecord(entry.oauth)) {
			downgrades.push(
				"it registers an OAuth client, which this build has no store for — you will have to authorize it there",
			);
		}
		if (entry.enabled === false) {
			downgrades.push("opencode keeps this definition while it is switched off");
		}
		if (positiveInteger(entry.timeout) !== undefined) {
			downgrades.push(
				`it is given ${entry.timeout}ms per request, and this build has one connect timeout for every server and no per-call one`,
			);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		downgrades.push(...opencodeMcpUncarried(entry));
		return { config: out, downgrades };
	}

	if (type === "remote") {
		const url = typeof entry.url === "string" ? entry.url.trim() : "";
		if (url === "") return null;
		const out: Record<string, unknown> = { type: "http", url };
		if (isRecord(entry.headers)) out.headers = entry.headers;
		if (entry.command !== undefined) downgrades.push("it also carries command, which only a local server has");
		if (entry.environment !== undefined) downgrades.push("it also carries environment, which only a local server has");
		if (entry.cwd !== undefined) downgrades.push("it also carries cwd, which only a local server has");
		if (isRecord(entry.oauth)) {
			downgrades.push(
				"it registers an OAuth client, which this build has no store for — you will have to authorize it there",
			);
		} else if (entry.oauth === false) {
			downgrades.push("it turns off OAuth auto-detection, which this build does not do anyway");
		}
		if (entry.enabled === false) {
			downgrades.push("opencode keeps this definition while it is switched off");
		}
		if (positiveInteger(entry.timeout) !== undefined) {
			downgrades.push(
				`it is given ${entry.timeout}ms per request, and this build has one connect timeout for every server and no per-call one`,
			);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		downgrades.push(...opencodeMcpUncarried(entry));
		return { config: out, downgrades };
	}

	return null;
}

/** Why one server could not be carried, or what did not come across with it. */
function opencodeMcpNote(entry: Record<string, unknown>, downgrades: string[]): string {
	if (typeof entry.type !== "string" || entry.type === "") {
		return "it names neither of opencode's two transports (type: local or type: remote), so there is no server to write";
	}
	return downgrades.length > 0 ? downgrades.join("; ") : "it has nothing this build's server shape does not hold";
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** One provider's `options.baseURL`, which is the only endpoint this build can use. */
function opencodeBaseUrl(provider: Record<string, unknown>): string {
	if (!isRecord(provider.options)) return "";
	const base = provider.options.baseURL;
	return typeof base === "string" ? base.trim() : "";
}

/**
 * The environment variable a provider's key is read from, named but never read.
 *
 * OpenCode resolves a provider's credential in four ways
 * (`core/src/v1/config/provider.ts:919`): an environment variable named by
 * `env`, a key in `auth.json`, the config's own inline `options.apiKey`, and a
 * `{env:VAR}`/`{file:path}` substitution (`config/variable.ts:33-90`). Only the
 * first is a name this build can be pointed at, and only the first is read from
 * the environment rather than stored.
 *
 * So: an `env` entry is used **by name**; an inline `apiKey` is reported by the
 * fact that one is there and **never copied** — writing it into settings.json
 * would move a credential out of the file the user chose to keep it in and into
 * one this migration writes, which is not a thing a migration should do to a
 * secret nobody asked it to touch.
 */
function opencodeApiKeyEnv(provider: Record<string, unknown>, id: string): { name: string; inline: boolean } {
	const env = Array.isArray(provider.env) ? provider.env.filter((e): e is string => typeof e === "string") : [];
	const first = env.find((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
	if (first !== undefined) return { name: first, inline: false };
	const inline =
		isRecord(provider.options) && typeof provider.options.apiKey === "string" && provider.options.apiKey !== "";
	return {
		name: `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
		inline,
	};
}

/** Model ids and their context windows, as far as the provider table says. */
function opencodeModels(
	provider: Record<string, unknown>,
	from: string,
	items: MigrationItem[],
): Array<{ id: string; contextWindow: number; maxOutputTokens: number }> {
	if (!isRecord(provider.models)) return [];
	const out: Array<{ id: string; contextWindow: number; maxOutputTokens: number }> = [];
	for (const [modelId, value] of Object.entries(provider.models)) {
		if (!isRecord(value)) {
			items.push({
				source: "opencode",
				from: `${from}.models.${modelId}`,
				to: "—",
				action: "skip",
				detail: "not a model entry, so there is nothing here to register",
				containsSecret: false,
			});
			continue;
		}
		// `limit.context` and `limit.output` (the Model schema's first fields,
		// core/src/v1/config/provider.ts:33-56). A model that states no limit at
		// all gets the assumed output budget, and says so — the alternative is to
		// register nothing and leave the user with no way to use the model.
		const limit = isRecord(value.limit) ? value.limit : {};
		const contextWindow = positiveInteger(limit.context);
		if (contextWindow === undefined) {
			items.push({
				source: "opencode",
				from: `${from}.models.${modelId}`,
				to: "—",
				action: "skip",
				detail: "it states no context limit, and a provider entry here has to carry one",
				containsSecret: false,
			});
			continue;
		}
		out.push({
			id: modelId,
			contextWindow,
			maxOutputTokens: positiveInteger(limit.output) ?? ASSUMED_MAX_OUTPUT_TOKENS,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** The settings documents, the provider and MCP tables they hold, and the permission block. */
export function planOpencode(
	raw: RawOpencode,
	home: string,
	items: MigrationItem[],
	writes: PlannedWrite[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
	addPermissionRules: AddPermissionRules,
): void {
	const config = raw.merge.config;
	const configFrom = raw.merge.from.length > 0 ? from(home, raw.merge.from[0]) : "opencode's config";

	items.push({
		source: "opencode",
		from: from(home, raw.roots.config),
		to: "—",
		action: "map",
		// The line is the answer to "where did it look", so it is printed whenever
		// the source counts as present — which, since `RawOpencode["present"]`, can
		// mean a machine with a database and no config root at all. Saying the root
		// was "resolved" without saying whether it was there would read as a
		// directory that was found and emptied.
		detail: existsSync(raw.roots.config)
			? `config root, resolved as ${raw.configOrigin}`
			: `config root ${from(home, raw.roots.config)} does not exist, so there are no settings documents to merge; the sessions in ${from(home, raw.roots.data)} still import`,
		containsSecret: false,
	});

	for (const failure of raw.merge.errors) {
		items.push({
			source: "opencode",
			from: from(home, failure.path),
			to: "—",
			action: "skip",
			detail: `${failure.reason} — nothing in this file was read, so this report is missing whatever it held`,
			containsSecret: false,
		});
	}

	// A document that was read and then partly replaced is worth a line, because
	// the file on disk still holds the values that lost — and a user comparing the
	// two is looking for the difference this names.
	for (const shadow of raw.merge.shadowed) {
		items.push({
			source: "opencode",
			from: from(home, shadow.path),
			to: "—",
			action: "downgrade",
			detail: `${shadow.keys.length} key(s) in it were replaced by a document opencode merges after it (${summarizeNames(
				shadow.keys,
				6,
			)}) — the file keeps the values it was written with, and the report describes the merged document`,
			containsSecret: false,
		});
	}

	if (raw.legacyToml) {
		items.push({
			source: "opencode",
			from: from(home, opencodeLegacyTomlPath(raw.roots.config)),
			to: "—",
			action: "skip",
			detail:
				"opencode's pre-JSON TOML file: this build folds it into config.json and deletes it on startup, so a machine that " +
				"still has one has not run a current build — its contents were not read",
			containsSecret: false,
		});
	}

	// ── providers ────────────────────────────────────────────────────────────
	const providerFrom = `${configFrom} → provider`;
	const specs: Array<Record<string, unknown>> = [];
	const registered = new Map<string, number>();
	for (const [id, value] of Object.entries(raw.providers)) {
		const label = `${providerFrom}.${id}`;
		if (!isRecord(value)) {
			items.push({
				source: "opencode",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a provider entry, so there is nothing here to register",
				containsSecret: false,
			});
			continue;
		}
		const baseUrl = opencodeBaseUrl(value);
		const models = opencodeModels(value, label, items);
		if (models.length === 0) {
			items.push({
				source: "opencode",
				from: label,
				to: "—",
				action: "skip",
				detail: "it defines no model with a context limit, and a provider entry here needs one to point a model at",
				containsSecret: false,
			});
			continue;
		}
		if (baseUrl === "") {
			items.push({
				source: "opencode",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"it states no options.baseURL, and opencode resolves a provider's endpoint through its npm package when there is " +
					"none — there is no URL here to register",
				containsSecret: false,
			});
			continue;
		}
		const { name: apiKeyEnv, inline } = opencodeApiKeyEnv(value, id);
		const spec = {
			id,
			baseUrl,
			apiKeyEnv,
			models: models.map((model) => ({
				id: model.id,
				contextWindow: model.contextWindow,
				maxOutputTokens: model.maxOutputTokens,
			})),
		};
		if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
			items.push({
				source: "opencode",
				from: label,
				to: "—",
				action: "skip",
				detail: "its endpoint or model limits are not what a provider entry here accepts",
				containsSecret: false,
			});
			continue;
		}
		specs.push(spec);
		registered.set(id, models.length);
		if (inline) {
			items.push({
				source: "opencode",
				from: `${label} → options.apiKey`,
				to: "—",
				action: "skip",
				detail:
					"this provider's key is written inline in opencode's own config, so the provider was registered against " +
					`$${apiKeyEnv} and the key itself was left where you put it`,
				containsSecret: false,
			});
		}
	}

	// A provider `enabled_providers`/`disabled_providers` names but that has no
	// entry here is a name, not an endpoint: OpenCode's provider registry is much
	// larger than this table, and a name with no table entry is a built-in.
	if (raw.enabledProviders.length > 0 || raw.disabledProviders.length > 0) {
		items.push({
			source: "opencode",
			from: `${configFrom} → ${[
				raw.enabledProviders.length > 0 ? "enabled_providers" : "",
				raw.disabledProviders.length > 0 ? "disabled_providers" : "",
			]
				.filter(Boolean)
				.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames([...raw.enabledProviders, ...raw.disabledProviders], 6)} switch opencode's own provider registry on ` +
				"and off, including providers it ships built in; this build has no such switch",
			containsSecret: false,
		});
	}

	const accepted = new Set(
		mergeProviderSpecs("opencode", specs, (id) => `${providerFrom}.${id}`, items, settingsPatch, existing, force),
	);
	for (const id of registered.keys()) {
		if (!accepted.has(id)) continue;
		items.push({
			source: "opencode",
			from: `${providerFrom}.${id}`,
			to: `settings.json → providers.openaiCompatible[${id}]`,
			action: "map",
			detail: `endpoint and ${registered.get(id) ?? 0} model(s) carried over`,
			containsSecret: false,
		});
	}

	// ── default model ────────────────────────────────────────────────────────
	for (const key of ["model", "small_model"] as const) {
		const value = config[key];
		if (typeof value !== "string" || value.trim() === "") continue;
		const reference = resolveModelReference(value);
		if (reference === undefined) {
			items.push({
				source: "opencode",
				from: `${configFrom} → ${key}`,
				to: "—",
				action: "skip",
				detail: `"${value}" is not a model this build carries — opencode resolves it through its own registry`,
				containsSecret: false,
			});
			continue;
		}
		if (key === "small_model") {
			items.push({
				source: "opencode",
				from: `${configFrom} → ${key}`,
				to: "—",
				action: "skip",
				detail:
					"the model opencode uses for title and summary generation; this build has no separate small-model setting and " +
					"picks its own for that work",
				containsSecret: false,
			});
			continue;
		}
		claimScalar("opencode", "model", reference, `${configFrom} → ${key}`, "carried over as the default model");
	}

	// ── MCP ──────────────────────────────────────────────────────────────────
	if (isRecord(config.mcp)) {
		for (const [name, entry] of Object.entries(config.mcp)) {
			const label = `${configFrom} → mcp.${name}`;
			if (!isRecord(entry)) {
				items.push({
					source: "opencode",
					from: label,
					to: "—",
					action: "skip",
					detail: "not a server entry, so there was nothing to connect to",
					containsSecret: false,
				});
				continue;
			}
			const normalized = normalizeOpencodeMcp(entry);
			if (normalized === null) {
				items.push({
					source: "opencode",
					from: label,
					to: "—",
					action: "skip",
					detail: opencodeMcpNote(entry, []),
					containsSecret: false,
				});
				continue;
			}
			if (!force && name in existingMcpServers) {
				items.push({
					source: "opencode",
					from: label,
					to: "—",
					action: "skip",
					detail: "the target already defines an MCP server with this name — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			// `environment` and `headers` are where opencode keeps a server's
			// credentials, and they are copied because a server without them will
			// not connect — so the write is marked secret and the values stay out of
			// every line of the report.
			const secret =
				looksLikeSecretName(name) ||
				Object.keys((normalized.config.env as Record<string, unknown>) ?? {}).some(looksLikeSecretName) ||
				Object.keys((normalized.config.headers as Record<string, unknown>) ?? {}).some(looksLikeSecretName);
			if (secret) markMcpSecret(true);
			mcpServers[name] = normalized.config;
			items.push({
				source: "opencode",
				from: label,
				to: `.mcp.json → mcpServers.${name}`,
				action: normalized.downgrades.length > 0 ? "downgrade" : "map",
				detail: normalized.downgrades.length > 0 ? normalized.downgrades.join("; ") : "carried over as configured",
				containsSecret: secret,
			});
		}
	}

	// ── permissions ──────────────────────────────────────────────────────────
	if (config.permission !== undefined) {
		planOpencodePermissions(config.permission, `${configFrom} → permission`, items, addPermissionRules);
	}

	// ── instructions ─────────────────────────────────────────────────────────
	if (raw.instructions !== null) {
		// The same `writes` the rest of the plan accumulates into. Passing a fresh
		// `[]` here would leave the report claiming a rule file that nothing ever
		// writes — the plan and the report disagreeing is the one outcome a
		// migration tool must not have.
		planMemoryAsRule("opencode", "AGENTS.md", home, raw.instructions, "imported-opencode.md", force, items, writes);
	}
	if (raw.instructionPaths.length > 0) {
		items.push({
			source: "opencode",
			from: `${configFrom} → instructions`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(raw.instructionPaths, 4)} name instruction files opencode loads from wherever they are on disk; ` +
				"this build reads the rules directory instead, so a file outside it is not picked up by copying its name across",
			containsSecret: false,
		});
	}

	// ── inline agents and commands ───────────────────────────────────────────
	if (isRecord(config.agent) && Object.keys(config.agent).length > 0) {
		items.push({
			source: "opencode",
			from: `${configFrom} → agent`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(Object.keys(config.agent), 6)} are opencode's own built-in agent definitions (plan, build, ` +
				"explore and the rest), overridden inline in the config; this build's own agents are its own, and a copied " +
				"definition would describe opencode's tool names rather than this one's",
			containsSecret: false,
		});
	}
	if (isRecord(config.command) && Object.keys(config.command).length > 0) {
		items.push({
			source: "opencode",
			from: `${configFrom} → command`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(Object.keys(config.command), 6)} are command templates written inline in the config, which opencode ` +
				"resolves against its own model and agent names; the markdown command files in its directory are imported below",
			containsSecret: false,
		});
	}

	// ── keys with nowhere to go ──────────────────────────────────────────────
	for (const [key, reason] of OPENCODE_RUNTIME_KEYS) {
		if (config[key] === undefined) continue;
		items.push({
			source: "opencode",
			from: `${configFrom} → ${key}`,
			to: "—",
			action: "skip",
			detail: `${reason} — it stays in opencode's file, which is where opencode reads it from`,
			containsSecret: false,
		});
	}
	reportUnhandledKeys("opencode", config, OPENCODE_HANDLED, configFrom, items);

	// ── credentials, named and never opened ──────────────────────────────────
	// Each name with the path it was found at, because the two sources of names
	// live under different roots: the config-root ones come out of a directory
	// listing, the known ones out of a probe of a named path, and the known ones are
	// in the data and state roots (`OPENCODE_CREDENTIAL_FILES`). Grouped by the
	// directory they are actually in, so a root holding two files is named once and
	// two roots are never collapsed into one line that reads as a single directory.
	const credentials = [
		...raw.credentialFiles.map((name) => ({ name, path: join(raw.roots.config, name) })),
		...raw.credentialFilesNamed.map((file) => ({ name: file.name, path: file.path })),
	];
	const byRoot = new Map<string, string[]>();
	for (const entry of credentials) {
		const dir = dirname(entry.path);
		byRoot.set(dir, [...(byRoot.get(dir) ?? []), entry.name]);
	}
	for (const [dir, names] of [...byRoot].sort(([a], [b]) => a.localeCompare(b))) {
		// The state root holds the daemon's own server password, and the advice that
		// is right for a provider token is wrong for it: there is no environment
		// variable to set, because it is not a credential this build has any use
		// for. Saying "set the same values as environment variables" about it would
		// be a line that reads as a secret a user should go and put somewhere.
		const isDaemonState = dir === raw.roots.state;
		items.push({
			source: "opencode",
			from: `${from(home, dir)} → ${summarizeNames(names, 6)}`,
			to: "—",
			action: "skip",
			detail: isDaemonState
				? "opencode's own daemon server password, kept under the state root. Named so you know a secret was here, never " +
					"opened, and nothing to carry across — it belongs to a server this build does not run"
				: "credentials: named so you know they were here, never opened. Set the same values as environment variables after " +
					"importing, and the providers above will find them",
			containsSecret: false,
		});
	}
	if (raw.credentialTables.length > 0) {
		items.push({
			source: "opencode",
			from: `${raw.databasePath === null ? "opencode.db" : from(home, raw.databasePath)} → ${summarizeNames(raw.credentialTables, 6)}`,
			to: "—",
			action: "skip",
			detail: `tables of opencode's own database, left unread: ${raw.credentialTables
				.map((name) => `${name} (${OPENCODE_CREDENTIAL_TABLES[name]})`)
				.join(", ")}`,
			containsSecret: false,
		});
	}

	// ── the vendor trees ─────────────────────────────────────────────────────
	if (raw.vendorTrees.length > 0) {
		// `~/${dir}` and not `~/${dir.slice(1)}`: the names are `.claude` and
		// `.agents` with their leading dot, and dropping it reports a directory the
		// user does not have.
		const spelled = raw.vendorTrees.map((dir) => `~/${dir}`);
		items.push({
			source: "opencode",
			from: spelled.join(", "),
			to: "—",
			action: "skip",
			detail:
				`opencode reads skills out of ${spelled.join(" and ")} as well as its ` +
				`own, and this importer does not copy them a second time — the ${raw.vendorTrees
					.map((dir) => (dir === ".claude" ? "claude-code" : "agents"))
					.join(
						" and ",
					)} source${raw.vendorTrees.length > 1 ? "s" : ""} already import${raw.vendorTrees.length > 1 ? "" : "s"} that tree`,
			containsSecret: false,
		});
	}

	if (raw.legacyStorage) {
		items.push({
			source: "opencode",
			from: from(home, opencodeLegacyStorageDir(raw.roots.data)),
			to: "—",
			action: "skip",
			detail:
				"opencode's pre-database on-disk layout (one JSON file per session, message and part). This build of opencode writes " +
				"opencode.db instead, so these are a retired generation's records rather than anything it still reads",
			containsSecret: false,
		});
	}
}

/** The documents, instruction file and asset trees. */
export function planOpencodeAssets(
	raw: RawOpencode,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	const at = (path: string): string => tildePath(home, path);

	collectFileWrites(
		"opencode",
		raw.skills,
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		"opencode",
		raw.agents,
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	planCommands("opencode", raw.commands, `${at(raw.roots.config)} → command`, home, force, items, writes);

	if (raw.skillUrls.length > 0) {
		items.push({
			source: "opencode",
			from: `${at(raw.roots.config)} → skills.urls`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(raw.skillUrls, 4)} are fetched over the network by opencode, so a migration could only import them ` +
				"by making the same outbound request; copy them across by hand if you want them here",
			containsSecret: false,
		});
	}
	if (raw.plugins.length > 0) {
		items.push({
			source: "opencode",
			from: `${at(raw.roots.config)} → plugin`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(raw.plugins, 6)} are opencode plugins, which are javascript modules it loads; this build has no ` +
				"plugin loader, and installing them would run code written for another tool",
			containsSecret: false,
		});
	}
	if (raw.extraSkillPaths.length > 0) {
		items.push({
			source: "opencode",
			from: `${at(raw.roots.config)} → skills.paths`,
			to: "—",
			action: "map",
			detail: `${summarizeNames(raw.extraSkillPaths, 4)} read as skill directories, and their skills are in the list above`,
			containsSecret: false,
		});
	}

	for (const entry of raw.otherDirs) {
		items.push({
			source: "opencode",
			from: at(join(raw.roots.config, entry.name)),
			to: "—",
			action: "skip",
			detail: `${entry.count} entr${entry.count === 1 ? "y" : "ies"} this importer reads nothing out of`,
			containsSecret: false,
		});
	}
	if (raw.otherFiles.length > 0) {
		items.push({
			source: "opencode",
			from: `${at(raw.roots.config)} → ${summarizeNames(raw.otherFiles, 6)}`,
			to: "—",
			action: "skip",
			detail: "files at the config root this importer has no mapping for and no note about",
			containsSecret: false,
		});
	}
	for (const [name, reason] of Object.entries(OPENCODE_UNREAD_FILES)) {
		if (!raw.unreadFiles.includes(name)) continue;
		items.push({
			source: "opencode",
			from: at(join(raw.roots.config, name)),
			to: "—",
			action: "skip",
			detail: `${reason} — it stays in opencode's file, which is where opencode reads it from`,
			containsSecret: false,
		});
	}
	// The three settings documents are named once, so a user can see which of them
	// the merged settings above actually came from.
	if (raw.merge.from.length > 0) {
		items.push({
			source: "opencode",
			from: raw.merge.from.map((path) => at(path)).join(", "),
			to: "—",
			action: "map",
			detail:
				`${raw.merge.from.length} of opencode's ${OPENCODE_CONFIG_FILES.length} settings document names present, merged in the ` +
				"order opencode merges them (later wins); every setting below describes the merged result",
			containsSecret: false,
		});
	}
}
