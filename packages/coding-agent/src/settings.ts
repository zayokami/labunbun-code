/**
 * Settings hierarchy (later overrides earlier):
 *   user (~/.labunbun/settings.json)
 *   → project (<cwd>/.labunbun/settings.json)
 *   → local (<cwd>/.labunbun/settings.local.json)
 *   → policy (~/.labunbun/managed-settings.json)
 *   → flag (--settings / CLI-provided object)
 *
 * Objects merge recursively; arrays and scalars replace.
 *
 * `project` and `local` both live inside the working tree, so both are treated
 * as repo-controlled: they are filtered through {@link stripUntrustedKeys}
 * before merging, and only the user's own tiers (user/policy/flag) can set the
 * keys that decide what the agent may do or where it sends data. The "local"
 * tier is not a trust boundary either — labunbun never writes an ignore rule
 * for it, so whether it is committed is up to whoever cloned the repo.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type PermissionMode, type PermissionRule, parseRuleList, type RuleSource } from "@labunbun/agent";
import { registerOpenAICompatibleProvider, setPricingOverride } from "@labunbun/ai";
import { z } from "zod";
import { stripBom } from "./json-text.ts";

export const PermissionModeSchema = z.enum(["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]);

/** USD per million tokens, the same shape the built-in catalog uses. */
export const ModelPricingSchema = z.object({
	input: z.number().nonnegative(),
	output: z.number().nonnegative(),
	/** OpenAI-style APIs charge cached input at a discount; 0 means "not billed here". */
	cacheRead: z.number().nonnegative().default(0),
	/** 0 is the norm outside Anthropic: populating a cache is ordinary input. */
	cacheWrite: z.number().nonnegative().default(0),
});

export const OpenAICompatibleProviderSchema = z.object({
	id: z.string(),
	baseUrl: z.string().url(),
	apiKeyEnv: z.string(),
	models: z.array(
		z.object({
			id: z.string(),
			name: z.string().optional(),
			contextWindow: z.number().int().positive(),
			maxOutputTokens: z.number().int().positive(),
			reasoning: z.boolean().optional(),
			pricing: ModelPricingSchema.optional(),
		}),
	),
});

export const SettingsSchema = z.object({
	model: z.string().optional(),
	/** Model references tried in order when the primary errors before streaming. */
	fallbackModels: z.array(z.string()).optional(),
	permissionMode: PermissionModeSchema.optional(),
	/**
	 * Theme name: a built-in, a theme file from `~/.labunbun/themes/`, or
	 * `"auto"` to follow the terminal background. Free-form rather than an enum
	 * because third-party theme names cannot be enumerated here; a name that
	 * does not resolve falls back to the default and is reported by `/doctor`.
	 */
	theme: z.string().optional(),
	vimMode: z.boolean().optional(),
	/**
	 * Let the cheap rung run by itself when the context crosses the compaction
	 * threshold: the older tool results become previews, and a summarization call
	 * happens only if that did not free enough. Off by default — it is lossy, and
	 * `/trim` does the same thing on request.
	 */
	trimOldToolResults: z.boolean().optional(),
	/**
	 * Ask each provider with a key what it serves, once at startup, and let the
	 * answer narrow the `/model` picker. On by default: it is one request per
	 * provider, it never blocks anything, and a failure leaves the catalog's own
	 * table in place. Set false to keep the picker to the table — an air-gapped
	 * or metered machine should not have to firewall a startup chat.
	 */
	modelDiscovery: z.boolean().optional(),
	permissions: z
		.object({
			allow: z.array(z.string()).default([]),
			deny: z.array(z.string()).default([]),
			additionalDirectories: z.array(z.string()).default([]),
		})
		.default({ allow: [], deny: [], additionalDirectories: [] }),
	/**
	 * The DualShock 4: whether one is read, and what its buttons do.
	 *
	 * Every key here is honored from the user's own tiers only (see
	 * {@link PROJECT_TIER_DENIED_KEYS}) — the whole block is denied rather than
	 * filtered key by key, because there is no harmless sub-key to keep: a cloned
	 * repository that could write `allowApprove` would be handing a controller in
	 * the user's lap the power to approve that repository's own tool calls.
	 */
	gamepad: z
		.object({
			/** Look for a controller at startup. Off until the user turns it on. */
			enabled: z.boolean().optional(),
			/**
			 * Whether ✕ may answer a permission dialog. Off unless the user says
			 * otherwise, in their own file: a button held down in a pocket is not a
			 * person deciding.
			 */
			allowApprove: z.boolean().optional(),
			/** Path, or a substring of one, of the controller to open. */
			device: z.string().optional(),
			/**
			 * How far the left stick must move before it counts as a direction.
			 * Bounded on both ends: a deadzone outside 0–1 is a stick that can never
			 * work or one that reads every tremor as a direction.
			 */
			deadzone: z.number().min(0).max(1).optional(),
			/**
			 * Button → action, replacing the defaults one entry at a time.
			 *
			 * Deliberately not an enum: a name that resolves to nothing becomes a
			 * line in `/doctor` and costs that one binding, whereas validating it here
			 * would reject the whole settings file over a typo — the same bargain
			 * theme files strike for an unknown token.
			 */
			bindings: z.record(z.string(), z.string()).optional(),
			/** Whole prompts the command wheel offers at one press. */
			phrases: z.array(z.string()).optional(),
			/**
			 * The motors, and the lightbar. Both are on unless the user says
			 * otherwise: these are the two things a controller does to the room it is
			 * in, and a pad that cannot be silenced is a pad that gets unplugged.
			 */
			rumble: z.boolean().optional(),
			lightbar: z.boolean().optional(),
		})
		.optional(),
	env: z.record(z.string(), z.string()).optional(),
	/**
	 * Policy-tier lockdowns. These are only honoured when they come from the
	 * managed (policy) file — a project or local file setting them would be
	 * asking the thing being restricted to restrict itself.
	 */
	allowManagedPermissionRulesOnly: z.boolean().optional(),
	disableBypassPermissionsMode: z.boolean().optional(),
	providers: z.object({ openaiCompatible: z.array(OpenAICompatibleProviderSchema).default([]) }).optional(),
	/**
	 * What a model is billed at, in USD per million tokens, keyed by
	 * "provider/model" — or by model id alone, which applies to every provider
	 * serving it. Overrides the catalog's dated snapshot of list prices; that is
	 * the point, because a gateway, a negotiated rate or a repriced model makes
	 * the published number wrong for the bill it is meant to describe.
	 */
	pricing: z.record(z.string(), ModelPricingSchema).optional(),
	hooks: z.record(z.string(), z.array(z.unknown())).optional(),
	mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type RawSettingsInput = z.input<typeof SettingsSchema>;

/**
 * Make the providers and prices a settings file declares real: register the
 * OpenAI-compatible providers so their models resolve, then apply the declared
 * prices over the catalog's own.
 *
 * Called once at startup by both modes, before anything resolves a model — a
 * reference to a model that only exists in settings is unknown until this runs,
 * and a price is only used by whoever resolves the model afterwards. Shared
 * rather than written twice so the two entry points cannot drift into costing
 * the same run differently.
 */
export function applyCatalogSettings(settings: Settings): void {
	for (const provider of settings.providers?.openaiCompatible ?? []) {
		registerOpenAICompatibleProvider(provider);
	}
	for (const [reference, price] of Object.entries(settings.pricing ?? {})) {
		setPricingOverride(reference, price);
	}
}

export type SettingsSourceName = "user" | "project" | "local" | "policy" | "flag";

/** A key a project-tier file tried to set and was not allowed to. */
export interface IgnoredSettingsKey {
	source: SettingsSourceName;
	key: string;
}

export interface LoadedSettings {
	settings: Settings;
	/** Which sources contributed (for /permissions display). */
	sources: Partial<Record<SettingsSourceName, string>>;
	/**
	 * Each tier's own parsed settings, before merging. The merged `settings` can
	 * no longer say which tier a given value came from, which is what rule
	 * attribution and the policy-tier lockdowns both need.
	 */
	perSource: Partial<Record<SettingsSourceName, Settings>>;
	/** Keys dropped from project/local files by {@link stripUntrustedKeys}. */
	ignoredKeys: IgnoredSettingsKey[];
}

/**
 * Settings a repository is not allowed to set for itself.
 *
 * `project` (`<cwd>/.labunbun/settings.json`) and `local` values come from files
 * inside the working tree — repo contents the user did not necessarily write.
 * Left unfiltered, a cloned repo can hand itself `bypassPermissions`, register a
 * provider pointed at a host it controls, redirect credentials through `env`
 * (`ANTHROPIC_BASE_URL` and friends), install a hook that runs on every turn,
 * connect an MCP server without passing the approval gate, or declare that the
 * model it is about to run costs nothing. These keys are honored only from tiers
 * the user controls: user, policy, flag.
 *
 * Deliberately not denied:
 *   - `permissions.deny` — tightening is always safe, and a repo's own
 *     guardrails stay effective against the agent it just configured.
 *   - `theme` / `vimMode` — cosmetic, no reach beyond the user's own terminal.
 *   - `trimOldToolResults` is denied for the opposite reason: it decides how much
 *     of the user's own conversation the model keeps, and a cloned repository
 *     should not get to make the agent forget on the user's behalf.
 *   - `gamepad` is denied *whole*, where `permissions` is denied key by key.
 *     There is no sub-key worth keeping: `enabled` claims an input device,
 *     `device` and `bindings` decide which one and what its buttons mean,
 *     `phrases` puts repository-authored text one press away from the prompt, and
 *     `allowApprove` would let a repository hand a physical button the power to
 *     approve its own tool calls. "Tightening is always safe" has no analogue
 *     here — every field widens what something outside the keyboard can do.
 *   - `allowManagedPermissionRulesOnly` / `disableBypassPermissionsMode` — these
 *     are read only from the policy tier already; they are listed here so the
 *     merged settings can never carry a repo-supplied value even if a future
 *     reader forgets that rule.
 */
const PROJECT_TIER_DENIED_KEYS = [
	"model",
	"fallbackModels",
	"permissionMode",
	"env",
	"providers",
	"hooks",
	"mcpServers",
	"pricing",
	"trimOldToolResults",
	// Not a lockdown but the same rule: whether this startup asks the network a
	// question is the user's decision, not the repository's.
	"modelDiscovery",
	"gamepad",
	"allowManagedPermissionRulesOnly",
	"disableBypassPermissionsMode",
] as const;

/** Permission sub-keys denied from the same tiers. `deny` is intentionally absent. */
const PROJECT_TIER_DENIED_PERMISSION_KEYS = ["allow", "additionalDirectories"] as const;

/**
 * Remove repo-controlled keys from a project/local tier before it is merged, so
 * the value never reaches `merged` (and thus never reaches perSource either —
 * `collectPermissionRules` reads perSource for rule attribution, which is the
 * path a project `permissions.allow` would otherwise use to widen access).
 */
function stripUntrustedKeys(
	data: unknown,
	source: SettingsSourceName,
): { data: unknown; ignored: IgnoredSettingsKey[] } {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return { data, ignored: [] };
	const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
	const ignored: IgnoredSettingsKey[] = [];
	for (const key of PROJECT_TIER_DENIED_KEYS) {
		if (key in out) {
			delete out[key];
			ignored.push({ source, key });
		}
	}
	const permissions = out.permissions;
	if (typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)) {
		const kept: Record<string, unknown> = { ...(permissions as Record<string, unknown>) };
		for (const key of PROJECT_TIER_DENIED_PERMISSION_KEYS) {
			if (key in kept) {
				delete kept[key];
				ignored.push({ source, key: `permissions.${key}` });
			}
		}
		out.permissions = kept;
	}
	return { data: out, ignored };
}

/** One-line notice for the keys a repo tried to set for itself and we dropped. */
export function formatIgnoredKeysNotice(ignored: IgnoredSettingsKey[]): string | undefined {
	if (ignored.length === 0) return undefined;
	const list = ignored.map((entry) => `${entry.source}:${entry.key}`).join(", ");
	return (
		`Ignoring repo-controlled settings (${list}): these can only be set from your own settings files ` +
		`(~/.labunbun/settings.json, managed-settings.json, or --settings), not from files inside the project.`
	);
}

/** The settings a command persists for the user, which another tier can override. */
export type UserChoiceKey = "theme" | "model" | "vimMode" | "gamepad";

/** Tiers that outrank the user's own file, highest first. */
const OVERRIDING_TIERS = ["flag", "policy", "local", "project"] as const;

interface TierSource {
	perSource: Partial<Record<SettingsSourceName, Settings>>;
	sources: Partial<Record<SettingsSourceName, string>>;
}

/**
 * The tier that would win over a choice written to the user file, if there is
 * one.
 *
 * `/theme`, `/model` and `/vim` all write `~/.labunbun/settings.json`, and every
 * other tier is merged on top of it. So a project's settings file, a local
 * override or the managed one quietly undoes the choice at the next startup —
 * the write is fine, and the silence about it is what leaves a user setting the
 * same theme every morning.
 *
 * Ordered by precedence, so the tier reported is the one that actually wins.
 * Only keys with no schema default are meaningful here: `theme`, `model` and
 * `vimMode` are all optional, so a value present in a tier's own parsed
 * settings is a value its file really set.
 */
export function shadowingTier(
	loaded: TierSource,
	key: UserChoiceKey,
): { source: SettingsSourceName; path: string } | undefined {
	for (const source of OVERRIDING_TIERS) {
		if (loaded.perSource[source]?.[key] !== undefined) {
			return { source, path: loaded.sources[source] ?? source };
		}
	}
	return undefined;
}

/**
 * One clause for a confirmation line, saying where the choice that was just
 * saved will be overridden. Undefined when nothing outranks the user file — the
 * common case, and the one that must stay quiet.
 *
 * `display` is how the caller shortens a path for the screen; passed in rather
 * than applied here so this module keeps knowing nothing about `~`.
 */
export function shadowedChoiceNotice(
	loaded: TierSource,
	key: UserChoiceKey,
	display: (path: string) => string,
): string | undefined {
	const tier = shadowingTier(loaded, key);
	if (!tier) return undefined;
	return `${display(tier.path)} sets ${key} and wins on the next start`;
}

function settingsPath(source: SettingsSourceName, cwd: string): string {
	const home = homedir();
	switch (source) {
		case "user":
			return join(home, ".labunbun", "settings.json");
		case "project":
			return join(resolve(cwd), ".labunbun", "settings.json");
		case "local":
			return join(resolve(cwd), ".labunbun", "settings.local.json");
		case "policy":
			return join(home, ".labunbun", "managed-settings.json");
		case "flag":
			return "";
	}
}

function readJsonFile(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		// Read the same way everywhere settings are read: a byte-order mark from a
		// Windows editor is not a parse error, and treating it as one drops a
		// whole tier of settings without the user ever learning why.
		return JSON.parse(stripBom(readFileSync(path, "utf8")));
	} catch (error) {
		console.error(`Warning: failed to parse ${path}: ${error instanceof Error ? error.message : error}`);
		return undefined;
	}
}

/** Recursive merge: objects merge, arrays/scalars replace. Later wins. */
export function mergeSettings<T>(base: T, override: unknown): T {
	if (override === undefined) return base;
	if (typeof base !== "object" || base === null || Array.isArray(base)) return override as T;
	if (typeof override !== "object" || override === null || Array.isArray(override)) return override as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(override)) {
		out[key] = key in out ? mergeSettings(out[key], value) : value;
	}
	return out as T;
}

export function loadSettings(cwd: string, flagSettings?: RawSettingsInput): LoadedSettings {
	const order: SettingsSourceName[] = ["user", "project", "local", "policy"];
	let merged: RawSettingsInput = {};
	const sources: Partial<Record<SettingsSourceName, string>> = {};
	const perSource: Partial<Record<SettingsSourceName, Settings>> = {};
	const ignoredKeys: IgnoredSettingsKey[] = [];

	for (const source of order) {
		const path = settingsPath(source, cwd);
		let data = readJsonFile(path);
		if (data === undefined) continue;
		// Project and local files travel with the repo; the other tiers are the
		// user's own or managed by their org. Strip before merging so a dropped
		// key can't win by tier order.
		if (source === "project" || source === "local") {
			const stripped = stripUntrustedKeys(data, source);
			data = stripped.data;
			ignoredKeys.push(...stripped.ignored);
		}
		merged = mergeSettings(merged, data);
		sources[source] = path;
		// Keep the tier's own view too. Parsed leniently: a malformed tier must
		// not take down rule attribution for the tiers that are well-formed.
		const tierParsed = SettingsSchema.safeParse(data);
		if (tierParsed.success) perSource[source] = tierParsed.data;
	}
	if (flagSettings !== undefined) {
		merged = mergeSettings(merged, flagSettings);
		sources.flag = "--settings";
		const flagParsed = SettingsSchema.safeParse(flagSettings);
		if (flagParsed.success) perSource.flag = flagParsed.data;
	}

	const parsed = SettingsSchema.safeParse(merged);
	if (!parsed.success) {
		console.error(`Warning: invalid settings ignored: ${parsed.error.message}`);
		return { settings: SettingsSchema.parse({}), sources, perSource, ignoredKeys };
	}
	return { settings: parsed.data, sources, perSource, ignoredKeys };
}

/** Rule tier each settings file maps to, for precedence and attribution. */
const RULE_SOURCE_BY_SETTINGS_SOURCE: Record<SettingsSourceName, RuleSource> = {
	user: "userSettings",
	project: "projectSettings",
	local: "localSettings",
	policy: "policy",
	flag: "cliArg",
};

/**
 * Permission rules from every settings tier, each tagged with its real source.
 *
 * Order follows the settings hierarchy, so later tiers win among allows, and
 * `/permissions` can show which file a rule came from. Deny rules win
 * regardless of tier, so this ordering only affects allows and display.
 */
export function collectPermissionRules(loaded: LoadedSettings): PermissionRule[] {
	const order: SettingsSourceName[] = ["user", "project", "local", "policy", "flag"];
	const managedOnly = loaded.perSource.policy?.allowManagedPermissionRulesOnly === true;
	const rules: PermissionRule[] = [];

	for (const source of order) {
		// Absent when the tier had no file, or when its file failed to parse.
		// Present tiers always carry a permissions block (schema default), whose
		// empty arrays simply contribute no rules.
		const tier = loaded.perSource[source];
		if (!tier) continue;
		const ruleSource = RULE_SOURCE_BY_SETTINGS_SOURCE[source];
		// Under allowManagedPermissionRulesOnly the policy file is the only
		// grantor of permission: everything below it is discarded rather than
		// merged, so a project file cannot widen what policy allows.
		if (managedOnly && ruleSource !== "policy" && ruleSource !== "cliArg") continue;
		rules.push(
			...parseRuleList(tier.permissions.deny, "deny", ruleSource),
			...parseRuleList(tier.permissions.allow, "allow", ruleSource),
		);
	}
	return rules;
}

/**
 * Resolve the effective permission mode, letting the policy tier veto
 * `bypassPermissions`. Returns the reason when a downgrade happened so the
 * caller can tell the user why the mode they asked for isn't the one they got.
 */
export function resolvePermissionMode(
	requested: PermissionMode,
	loaded: LoadedSettings,
): { mode: PermissionMode; downgradeReason?: string } {
	if (requested === "bypassPermissions" && loaded.perSource.policy?.disableBypassPermissionsMode === true) {
		return {
			mode: "default",
			downgradeReason: "bypassPermissions is disabled by managed settings — using default mode instead",
		};
	}
	return { mode: requested };
}

/**
 * Apply `settings.env` to the process environment.
 *
 * Real environment variables win: a settings file must not be able to silently
 * redirect a key that the user exported in their shell. Returns the names that
 * were applied (never the values, which are usually credentials).
 */
export function applySettingsEnv(settings: Settings): string[] {
	const applied: string[] = [];
	for (const [key, value] of Object.entries(settings.env ?? {})) {
		if (process.env[key] !== undefined) continue;
		process.env[key] = value;
		applied.push(key);
	}
	return applied;
}
