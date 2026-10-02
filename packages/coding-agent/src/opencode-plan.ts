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
	urlCredentialProblem,
} from "./migrate-core.ts";
import type { AddPermissionRules, ClaimScalar, MigrationItem, PlannedWrite } from "./migrate-types.ts";
import { looksLikeSecretName, resolveModelReference } from "./migrate-types.ts";
import { OPENCODE_CONFIG_FILES, opencodeLegacyStorageDir, opencodeLegacyTomlPath } from "./opencode-home.ts";
import type { RawOpencode } from "./opencode-read.ts";
import {
	OPENCODE_CREDENTIAL_TABLES,
	OPENCODE_KEY_SPELLINGS,
	OPENCODE_UNREAD_FILES,
	opencodeConfigKey,
	opencodeConfigValue,
} from "./opencode-read.ts";
import type { RawSettingsInput } from "./settings.ts";
import { OpenAICompatibleProviderSchema } from "./settings.ts";

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

/**
 * Keys of the merged settings this importer either reads or names, so that
 * anything else can be reported as unhandled rather than dropped.
 *
 * The list is the v1 schema's own key set (`core/src/v1/config/config.ts:30-183`)
 * plus **both spellings of the eight keys v2 renamed** and the v2-only keys that
 * have no v1 counterpart, so a v2 document is not told this importer has no
 * mapping for a key it has just read.
 *
 * What is left out of the v1 list is the keys about OpenCode's own runtime rather
 * than about the user's agent — its TUI, its updater, its share prompt, its
 * terminal and diff-snapshot settings. Each of those gets its own line below with
 * the reason it is not a migration, so nothing here is a silent discard.
 */
const OPENCODE_HANDLED = new Set([
	// Every spelling of the eight renamed keys. Derived rather than written out, so
	// adding one to the table above cannot leave a spelling unhandled here — which
	// is the whole failure mode: a key this importer reads, reported as one it has
	// no mapping for.
	...Object.values(OPENCODE_KEY_SPELLINGS).flat(),
	"model",
	"small_model",
	"mcp",
	"instructions",
	"skills",
	"enabled_providers",
	"disabled_providers",
	"default_agent",
	"mode",
	"tools",
	// Named below, never imported: OpenCode's own runtime. Listed here as well as
	// in `OPENCODE_RUNTIME_KEYS` because a key with a reason of its own must not
	// also be collected by `reportUnhandledKeys` — that printed the same key twice,
	// once explained and once not.
	"$schema",
	"shell",
	"server",
	"watcher",
	"share",
	"autoshare",
	"autoupdate",
	"username",
	"username_mode",
	"subagent_depth",
	"formatter",
	"lsp",
	"layout",
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
): { allow: string[]; deny: string[] } {
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
	} else if (Array.isArray(block)) {
		// v2's shape, and it is the **flattened** form of v1's object: v1
		// `{bash: {"git push *": "ask"}}` is lowered to
		// `{action: "bash", resource: "git push *", effect: "ask"}` and v1's bare
		// `{bash: "ask"}` to `{action: "bash", resource: "*", effect: "ask"}`
		// (`core/src/v1/config/migrate.ts:82-89`) — so reading it back needs no
		// judgement at all, only the grouping the reverse of that does.
		//
		// `resource: "*"` is the one spelling that has to be recognised, because it is
		// how a whole-tool rule is written and turning it into `Tool(*)` would ask
		// about a literal asterisk.
		for (const [index, rule] of block.entries()) {
			const at = `${label}[${index}]`;
			if (!isRecord(rule)) {
				items.push({
					source: "opencode",
					from: at,
					to: "—",
					action: "skip",
					detail: "not a rule entry, so there was nothing in it to read",
					containsSecret: false,
				});
				continue;
			}
			const action_ = typeof rule.action === "string" ? rule.action : "";
			const resource = typeof rule.resource === "string" ? rule.resource : "";
			const effect = rule.effect;
			if (action_ === "" || resource === "") {
				items.push({
					source: "opencode",
					from: at,
					to: "—",
					action: "skip",
					detail:
						"it does not name both an action and a resource, which a v2 rule has to, so no rule was written for it",
					containsSecret: false,
				});
				continue;
			}
			const verdict = action(effect);
			if (verdict === null) {
				items.push({
					source: "opencode",
					from: at,
					to: "—",
					action: "skip",
					detail: `not one of opencode's three answers (ask, allow, deny), so no rule was written for it`,
					containsSecret: false,
				});
				continue;
			}
			// `action` is a free string in the schema
			// (`schema/src/permission.ts:58`), so an unknown one is a user's own tool
			// rather than a typo to correct — and the v1 tables are the same tables,
			// because v1's keys became v2's `action` values unchanged.
			const tool = OPENCODE_PERMISSION_TOOL[action_];
			if (tool === undefined) {
				const why = OPENCODE_PERMISSION_UNMAPPED[action_];
				items.push({
					source: "opencode",
					from: `${at} → ${action_}`,
					to: "—",
					action: "skip",
					detail: why
						? `${why} — there is no rule here that means the same thing`
						: `a permission action this build has no tool for, so there is nothing to write a rule about`,
					containsSecret: false,
				});
				continue;
			}
			take(tool, resource, verdict, resource === "*" ? action_ : `${action_}(${resource})`);
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
		return { allow, deny };
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
	return { allow, deny };
}

/**
 * OpenCode's v1 `tools` block → this build's allow/deny rule strings.
 *
 * v1 had two ways to say the same thing and v1's own migration folds them into
 * one list: `tools` is a table of tool names to booleans and `permission` a table
 * of tool names to one of three answers, and
 * `permissions(permission, tools)` (`core/src/v1/config/migrate.ts:74-92`) writes
 * the `tools` entries first and the `permission` entries after. v2 takes the
 * **last** rule that matches (`core/src/permission.ts:76-86`, `findLast`), so a
 * tool named in both is decided by `permission`.
 *
 * Two consequences this build has to reproduce rather than approximate:
 *
 * - the spelling is normalized first, and only by one rule —
 *   `normalizeAction` (`migrate.ts:95-97`) maps `write` and `patch` to `edit` and
 *   changes nothing else, so `tools: {write: true}` is an `Edit` allow;
 * - a tool both blocks name is reported, because this build keeps the two lists
 *   apart and resolves the conflict structurally (deny wins) instead of by order.
 *   Silently preferring one would be a different decision from the one the file
 *   already made.
 *
 * A value that is not a boolean is named rather than read: a third state here is
 * neither an allow nor a deny, and guessing which one the user meant is the one
 * thing a permission must not do.
 */
function planOpencodeTools(
	block: unknown,
	label: string,
	permission: { allow: string[]; deny: string[] },
	items: MigrationItem[],
	addPermissionRules: AddPermissionRules,
): void {
	if (!isRecord(block) || Object.keys(block).length === 0) {
		items.push({
			source: "opencode",
			from: label,
			to: "—",
			action: "skip",
			detail: "not a table of tool names to on/off answers, so none of its switches were read",
			containsSecret: false,
		});
		return;
	}
	const allow: string[] = [];
	const deny: string[] = [];
	for (const [name, enabled] of Object.entries(block)) {
		if (typeof enabled !== "boolean") {
			items.push({
				source: "opencode",
				from: `${label} → ${name}`,
				to: "—",
				action: "skip",
				detail: "not an on/off answer, so it is neither an allow nor a deny and no rule was written for it",
				containsSecret: false,
			});
			continue;
		}
		// `normalizeAction`, transcribed: two names become one and the rest are
		// themselves, so the lookup below is the same table `permission` uses.
		const action = name === "write" || name === "patch" ? "edit" : name;
		const tool = OPENCODE_PERMISSION_TOOL[action];
		if (tool === undefined) {
			const why = OPENCODE_PERMISSION_UNMAPPED[action];
			items.push({
				source: "opencode",
				from: `${label} → ${name}`,
				to: "—",
				action: "skip",
				detail: why
					? `${why} — there is no rule here that means the same thing`
					: "a tool this build has no permission rule for, so there is nothing to write a rule about",
				containsSecret: false,
			});
			continue;
		}
		(enabled ? allow : deny).push(tool);
	}

	const notes: string[] = [];
	// Two conflicts, and they come out differently here, so both are named.
	const shadowed = allow.filter((rule) => permission.deny.includes(rule));
	const overridden = deny.filter((rule) => permission.allow.includes(rule));
	if (shadowed.length > 0) {
		// opencode keeps the `permission` deny, and so does this file: same answer.
		notes.push(
			`${summarizeNames(shadowed, 6)} switched on here and denied by the \`permission\` block, which is the one opencode keeps — the ` +
				"allow is written and the deny still wins, as it does there",
		);
	}
	if (overridden.length > 0) {
		// opencode keeps the `permission` **allow**; this file's two lists cannot
		// carry an order, so the deny wins instead. That is the one place the two
		// programs disagree about the same pair of lines, so it is said outright
		// rather than left for the user to discover by being blocked.
		notes.push(
			`${summarizeNames(overridden, 6)} switched off here and allowed by the \`permission\` block — opencode keeps that allow, but a ` +
				"deny wins in this file whichever list it is in, so the two disagree and the deny is the one in force",
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
	"disabled",
	"url",
	"headers",
	"oauth",
	"timeout",
]);

/**
 * What to say about an `mcp` timeout, in either of the two things that is one.
 *
 * v2's is `{startup?, request?}` (`core/src/config/mcp.ts:6-13`) and v1's is a
 * single number of milliseconds per server. The number is already named in
 * `normalizeOpencodeMcp`; what it misses is the object, because
 * `positiveInteger({request: 30000})` is `undefined` — so a v2 server's timeout
 * was dropped with no line at all, and `timeout` being in
 * {@link OPENCODE_MCP_CARRIED} kept the uncarried-key check from naming it
 * either. Two spellings, one of which was invisible.
 */
function opencodeMcpTimeoutNote(timeout: unknown): string {
	if (!isRecord(timeout)) {
		return "it is given a per-request timeout, and this build has one connect timeout for every server and no per-call one";
	}
	const named = [
		positiveInteger(timeout.startup) === undefined ? "" : "startup",
		positiveInteger(timeout.request) === undefined ? "" : "request",
	]
		.filter(Boolean)
		.join(" and ");
	if (named === "") {
		return "it carries a timeout whose shape this build could not read, so none of it came across";
	}
	return (
		`it sets a ${named} timeout for every server; this build has one connect timeout for every server and no per-call one, so a ` +
		"slow server here gets the one number rather than the pair"
	);
}

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
		// v2 spells the same thing `disabled` (`migrateMcp`, `:139`: `!info.enabled`)
		// and reads it as its own field, so a v2 server switched off is one whose
		// definition came across silently.
		if (entry.disabled === true) {
			downgrades.push("opencode keeps this definition while it is switched off");
		}
		if (entry.timeout !== undefined) {
			downgrades.push(opencodeMcpTimeoutNote(entry.timeout));
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
		if (entry.disabled === true) {
			downgrades.push("opencode keeps this definition while it is switched off");
		}
		if (entry.timeout !== undefined) {
			downgrades.push(opencodeMcpTimeoutNote(entry.timeout));
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
	// The label carries the spelling the file used, because every line below it is
	// `${providerFrom}.<id>` and a v2 user's file says `providers`.
	const providerKey = opencodeConfigKey(config, "providers");
	const providerFrom = `${configFrom} → ${providerKey?.spelling ?? "provider"}`;
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

	// ── default agent ─────────────────────────────────────────────────────────
	// `default_agent` names the primary agent a session starts as, and v1's own
	// description carries the part that matters: it must be a primary agent, and
	// an invalid one falls back to `build` rather than failing
	// (`core/src/v1/config/config.ts:80-83`). Both halves are reported, because a
	// user who set this to a name this build has never heard of should know that
	// OpenCode was quietly running `build` and that nothing here reproduces the
	// choice at all.
	const defaultAgent = config.default_agent;
	if (typeof defaultAgent === "string" && defaultAgent.trim() !== "") {
		items.push({
			source: "opencode",
			from: `${configFrom} → default_agent`,
			to: "—",
			action: "skip",
			detail:
				`"${defaultAgent}" is the primary agent opencode starts a session as, falling back to "build" when that name is not a primary ` +
				"agent; this build's sessions all run as the same agent and pick a subagent by name, so there is no setting for it",
			containsSecret: false,
		});
	} else if (defaultAgent !== undefined) {
		items.push({
			source: "opencode",
			from: `${configFrom} → default_agent`,
			to: "—",
			action: "skip",
			detail: "not a name, so it selected no agent; there is no setting here for it either way",
			containsSecret: false,
		});
	}

	// ── MCP ──────────────────────────────────────────────────────────────────
	// v1's `mcp` is the server table; v2's is an envelope with the table inside it
	// (`{timeout?, servers?}`, `core/src/config/mcp.ts:45-48`) and v1's migration
	// produces exactly that shape (`core/src/v1/config/migrate.ts:128-134`). Reading
	// a v2 envelope as a table named the envelope's own two keys as servers, and
	// reported two servers that do not exist.
	//
	// The discriminator is the presence of a `servers` table, not the presence of
	// `timeout`: a v1 server called `timeout` is absurd, a v1 file with a
	// `servers` key that is not a table of server entries is not a v2 envelope
	// either, and requiring the second condition as well means the one case that
	// would be read wrongly is one that cannot happen.
	const mcpConfig = opencodeConfigValue(config, "mcp");
	if (isRecord(mcpConfig)) {
		const envelope = isRecord(mcpConfig.servers);
		const servers: Record<string, unknown> = envelope ? (mcpConfig.servers as Record<string, unknown>) : mcpConfig;
		if (envelope && mcpConfig.timeout !== undefined) {
			// `{startup?, request?}` (`core/src/config/mcp.ts:6-13`), which v1 spells
			// as one number per server. Named rather than dropped: it is a real
			// setting a user has a reason to have written.
			items.push({
				source: "opencode",
				from: `${configFrom} → mcp.timeout`,
				to: "—",
				action: "skip",
				detail: opencodeMcpTimeoutNote(mcpConfig.timeout),
				containsSecret: false,
			});
		}
		for (const [name, entry] of Object.entries(servers)) {
			const label = `${configFrom} → mcp.${envelope ? "servers." : ""}${name}`;
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
			// `url` is the one credential channel a name-based scan cannot reach: the
			// token is inside the one string every importer treats as a safe
			// identifier, not under a secret-shaped key. A `local` entry that also
			// carries one has it named as uncarried, so this only fires for a
			// `remote` server whose address is the thing being written. There is no
			// half to keep — the same address with its userinfo or its
			// `?access_token=` stripped is a different address pointing at nothing —
			// so nothing is written, and the OAuth block below the copy is the
			// alternative to point at. `containsSecret` is `true` even so, because
			// the value this line is about was one; no `markMcpSecret` runs because no
			// file receives it.
			const url = normalized.config.url;
			if (typeof url === "string" && url !== "") {
				const problem = urlCredentialProblem(url);
				if (problem !== null) {
					items.push({
						source: "opencode",
						from: label,
						to: "—",
						action: "skip",
						detail:
							`left off, because its url ${problem} — unlike headers or environment there is no way to drop the ` +
							"credential and keep the address, so nothing was written; add the server again here and authorize it there",
						containsSecret: true,
					});
					continue;
				}
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
	// v1's object and v2's array are the same rules in two spellings, and the label
	// says which one the file used so the per-rule lines point at keys that exist.
	//
	// `tools` goes through the same door and is planned **after**, so a tool the
	// two blocks name differently is reported: v1's own migration writes the
	// `tools` rules first and the `permission` rules after and v2 takes the last
	// match, so the order of the two calls is the order the file's two halves are
	// weighed in.
	const permissionKey = opencodeConfigKey(config, "permissions");
	const permission =
		permissionKey === null
			? { allow: [] as string[], deny: [] as string[] }
			: planOpencodePermissions(
					permissionKey.value,
					`${configFrom} → ${permissionKey.spelling}`,
					items,
					addPermissionRules,
				);
	const tools = config.tools;
	if (tools !== undefined) {
		planOpencodeTools(tools, `${configFrom} → tools`, permission, items, addPermissionRules);
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
	// Both keys were renamed in v2, and the labels carry the spelling so the line
	// names a key that is in the file rather than one that is not.
	//
	// `mode` joins the same line: v1 marked it `@deprecated Use \`agent\` field
	// instead` (`core/src/v1/config/config.ts:90-96`) and v1's own migration folds
	// it into the same table as `agent` (`migrate.ts:96-105`). A file with both
	// spellings is one table written twice, and two lines about it would read as
	// two decisions.
	const agentsKey = opencodeConfigKey(config, "agents");
	const modeKey = isRecord(config.mode) && Object.keys(config.mode).length > 0 ? config.mode : null;
	const inlineAgents = [agentsKey?.value, modeKey].filter(
		(value): value is Record<string, unknown> => isRecord(value) && Object.keys(value).length > 0,
	);
	if (inlineAgents.length > 0) {
		const spellings = [agentsKey?.spelling, modeKey === null ? undefined : "mode"].filter(
			(name): name is string => name !== undefined,
		);
		const names = [...new Set(inlineAgents.flatMap((value) => Object.keys(value)))];
		items.push({
			source: "opencode",
			from: `${configFrom} → ${spellings.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(names, 6)} are opencode's own built-in agent definitions (plan, build, ` +
				"explore and the rest), overridden inline in the config; this build's own agents are its own, and a copied " +
				"definition would describe opencode's tool names rather than this one's" +
				(modeKey === null
					? ""
					: " — and a `mode` entry is forced to a primary agent by opencode, which this build has no counterpart for"),
			containsSecret: false,
		});
	}
	const commandsKey = opencodeConfigKey(config, "commands");
	if (commandsKey !== null && isRecord(commandsKey.value) && Object.keys(commandsKey.value).length > 0) {
		items.push({
			source: "opencode",
			from: `${configFrom} → ${commandsKey.spelling}`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(Object.keys(commandsKey.value), 6)} are command templates written inline in the config, which opencode ` +
				"resolves against its own model and agent names; the markdown command files in its directory are imported below",
			containsSecret: false,
		});
	}

	// ── keys with nowhere to go ──────────────────────────────────────────────
	for (const [key, reason] of OPENCODE_RUNTIME_KEYS) {
		// Under whichever spelling the document used, and the line names that one:
		// a reason attached to `attachment` used to be dead text on a v2 file,
		// where the key is `attachments` and the v1 name appears nowhere.
		const found = opencodeConfigKey(config, key);
		if (found === null) continue;
		// "…which is where opencode reads it from" is true of a v1 name and false
		// of a v2 one left in an old file: v2's own v1→v2 migration returns a
		// literal object of twenty-five keys (`core/src/v1/config/migrate.ts:36-72`)
		// and every name not on it is dropped without a word. So for a v2-only key
		// the honest sentence is the opposite one, and saying the comfortable thing
		// here is how a user ends up believing a value OpenCode is about to delete
		// is safe where it sits.
		const tail = found.v2Only
			? "opencode's own migration to v2 rebuilds this file from a fixed key list and drops this one, so copy it across before it runs"
			: "it stays in opencode's file, which is where opencode reads it from";
		items.push({
			source: "opencode",
			from: `${configFrom} → ${found.spelling}`,
			to: "—",
			action: "skip",
			detail: `${reason} — ${tail}`,
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
	// Every label below names the key as the user's file spells it, because a line
	// reading `opencode.json → plugin` is pointing at a key a v2 file does not have.
	const config = raw.merge.config;
	const pluginsKey = opencodeConfigKey(config, "plugins");
	const commandsKey = opencodeConfigKey(config, "commands");
	planCommands(
		"opencode",
		raw.commands,
		`${at(raw.roots.config)} → ${commandsKey?.spelling ?? "command"}`,
		home,
		force,
		items,
		writes,
	);

	// A v2 `skills` is one list of paths and URLs with nothing marking which is
	// which, so the two lines below name `skills` and say the list was split —
	// rather than naming `skills.urls` and `skills.paths`, which are keys that
	// exist only in the v1 shape.
	const skillLabel = raw.skillsSpelling === "list" ? "skills" : "skills.urls";
	const skillSplit =
		raw.skillsSpelling === "list" ? " (one flat list in v2, split here the way opencode splits it)" : "";

	if (raw.skillUrls.length > 0) {
		items.push({
			source: "opencode",
			from: `${at(raw.roots.config)} → ${skillLabel}`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(raw.skillUrls, 4)} are fetched over the network by opencode${skillSplit}, so a migration could only ` +
				"import them by making the same outbound request; copy them across by hand if you want them here",
			containsSecret: false,
		});
	}
	if (pluginsKey !== null && raw.plugins.length > 0) {
		items.push({
			source: "opencode",
			from: `${at(raw.roots.config)} → ${pluginsKey.spelling}`,
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
			from: `${at(raw.roots.config)} → ${raw.skillsSpelling === "list" ? "skills" : "skills.paths"}`,
			to: "—",
			action: "map",
			detail: `${summarizeNames(raw.extraSkillPaths, 4)} read as skill directories${skillSplit}, and their skills are in the list above`,
			containsSecret: false,
		});
	}
	if (raw.unnamedSkills.length > 0) {
		// OpenCode drops these itself, in silence: a nested `SKILL.md` is only a
		// skill if its frontmatter names it, and a file that is not a skill there
		// is not one to hand over as though it were.
		items.push({
			source: "opencode",
			from: raw.unnamedSkills.map((path) => at(path)).join(", "),
			to: "—",
			action: "skip",
			detail:
				"a skill file opencode does not load: its frontmatter has no `name:`, and a nested `SKILL.md` without one is skipped " +
				"rather than named after its directory — add a `name:` to it and it is a skill again",
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
