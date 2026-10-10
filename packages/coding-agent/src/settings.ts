// Settings hierarchy (later overrides earlier): user, project, local, policy and flag.
// Long-form design notes: docs/dev/migration-framework.md

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	NETWORK_DOMAIN_PERMISSIONS,
	NETWORK_SANDBOX_POLICIES,
	type NetworkAxis,
	type NetworkDomainRule,
	PERMISSION_MODES,
	type PermissionMode,
	type PermissionRule,
	parseRuleList,
	type RuleSource,
	SANDBOX_MODES,
	type SandboxMode,
} from "@labunbun/agent";
import { registerOpenAICompatibleProvider, setPricingOverride, THINKING_LEVELS } from "@labunbun/ai";
import { z } from "zod";
import { stripBom } from "./json-text.ts";

// Long-form design notes: docs/dev/migration-framework.md
/** Mode values from releases that had them, and what to write instead. */
const LEGACY_MODE_SUGGESTIONS: Record<string, string> = {
	default: 'permissionMode "ask"',
	manual: 'permissionMode "ask"',
	acceptEdits: 'permissionMode "ask"',
	dontAsk: 'permissionMode "ask"',
	bypassPermissions: 'permissionMode "agent" together with sandbox "danger-full-access"',
};

// Long-form design notes: docs/dev/migration-framework.md
/** The mode axis, validated against the one list that defines it. */
export const PermissionModeSchema = z.custom<PermissionMode>().superRefine((value, ctx) => {
	if (typeof value !== "string") {
		ctx.addIssue({ code: "custom", message: `permissionMode must be a string, got ${typeof value}` });
		return;
	}
	if ((PERMISSION_MODES as readonly string[]).includes(value)) return;
	const suggestion = LEGACY_MODE_SUGGESTIONS[value];
	ctx.addIssue({
		code: "custom",
		message:
			suggestion !== undefined
				? `"${value}" is no longer a permission mode. Write ${suggestion} instead.`
				: `"${value}" is not a permission mode. Valid values: ${PERMISSION_MODES.join(", ")}.`,
	});
});

/** The sandbox axis, derived the same way. */
export const SandboxModeSchema = z.custom<SandboxMode>().superRefine((value, ctx) => {
	if (typeof value !== "string") {
		ctx.addIssue({ code: "custom", message: `sandbox must be a string, got ${typeof value}` });
		return;
	}
	if ((SANDBOX_MODES as readonly string[]).includes(value)) return;
	ctx.addIssue({
		code: "custom",
		message: `"${value}" is not a sandbox mode. Valid values: ${SANDBOX_MODES.join(", ")}.`,
	});
});

// Long-form design notes: docs/dev/migration-framework.md
/** One domain rule, in either of the two spellings a user would write. */
export const NetworkDomainRuleSchema = z.union([
	z.string(),
	z.object({ domain: z.string(), action: z.enum(NETWORK_DOMAIN_PERMISSIONS) }),
]);

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
	// Long-form design notes: docs/dev/migration-framework.md
	/** How hard the model should think, for every request this session makes. */
	thinkingLevel: z.enum(THINKING_LEVELS).optional(),
	permissionMode: PermissionModeSchema.optional(),
	// Long-form design notes: docs/dev/migration-framework.md
	/** The other axis: what the process may touch, as opposed to what asks. */
	sandbox: SandboxModeSchema.optional(),
	// Long-form design notes: docs/dev/migration-framework.md
	/** The network axis, which is **not** derived from `sandbox`. */
	networkAccess: z.enum(NETWORK_SANDBOX_POLICIES).optional(),
	// Long-form design notes: docs/dev/migration-framework.md
	/** Domain rules for the proxy, in either spelling. See {@link NetworkDomainRuleSchema}. */
	networkDomains: z.array(NetworkDomainRuleSchema).optional(),
	/**
	 * Theme name: a built-in, a theme file from `~/.labunbun/themes/`, or
	 * `"auto"` to follow the terminal background. Free-form rather than an enum
	 * because third-party theme names cannot be enumerated here; a name that
	 * does not resolve falls back to the default and is reported by `/doctor`.
	 */
	theme: z.string().optional(),
	vimMode: z.boolean().optional(),
	/**
	 * Emacs key bindings in the prompt. Separate from `vimMode` rather than a
	 * second value of it: the two are different models, not different bindings,
	 * and a repository that turned on the wrong one would have to be trusted
	 * with both. `resolveEditingMode` is the one place that decides which of them
	 * is actually in effect, so setting both is reportable rather than ambiguous.
	 */
	emacsMode: z.boolean().optional(),
	// Long-form design notes: docs/dev/migration-framework.md
	/** Let the cheap rung run by itself when the context crosses the compaction threshold. */
	trimOldToolResults: z.boolean().optional(),
	/**
	 * Ask each provider with a key what it serves, once at startup, and let the
	 * answer narrow the `/model` picker. On by default: it is one request per
	 * provider, it never blocks anything, and a failure leaves the catalog's own
	 * table in place. Set false to keep the picker to the table — an air-gapped
	 * or metered machine should not have to firewall a startup chat.
	 */
	modelDiscovery: z.boolean().optional(),
	// Long-form design notes: docs/dev/migration-framework.md
	/** Wake the session when a background shell finishes on its own. */
	backgroundShellNotifications: z.boolean().optional(),
	permissions: z
		.object({
			allow: z.array(z.string()).default([]),
			deny: z.array(z.string()).default([]),
			additionalDirectories: z.array(z.string()).default([]),
		})
		.default({ allow: [], deny: [], additionalDirectories: [] }),
	// Long-form design notes: docs/dev/migration-framework.md
	/** The DualShock 4: whether one is read, and what its buttons do. */
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
			// Long-form design notes: docs/dev/migration-framework.md
			/** Button → action, replacing the defaults one entry at a time. */
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
	 * What the app asks every provider to do about its prompt cache.
	 *
	 * Not under `providers`, because none of it is a property of one: the same
	 * policy applies to every model, and the adapters translate it into whatever
	 * their own wire format calls the same idea.
	 */
	cache: z
		.object({
			/** Place explicit breakpoints on providers that need them. */
			explicitBreakpoints: z.boolean().optional(),
			/** How long a written entry should live; "auto" asks for the long one. */
			ttl: z.enum(["auto", "5m", "1h"]).optional(),
			/** Send the routing key: "auto" follows the provider's own guide. */
			promptCacheKey: z.enum(["auto", "on", "off"]).optional(),
			/**
			 * How long the provider should keep an entry. Unset sends nothing, which
			 * is usually right: on OpenAI an organization without zero-data-retention
			 * already gets the long retention.
			 */
			promptCacheRetention: z.enum(["in_memory", "24h"]).optional(),
		})
		.optional(),
	/**
	 * What a model is billed at, in USD per million tokens, keyed by
	 * "provider/model" — or by model id alone, which applies to every provider
	 * serving it. Overrides the catalog's dated snapshot of list prices; that is
	 * the point, because a gateway, a negotiated rate or a repriced model makes
	 * the published number wrong for the bill it is meant to describe.
	 */
	// Long-form design notes: docs/dev/migration-framework.md
	/** The /beetle band: which model each of the four members runs. */
	beetle: z
		.object({
			models: z.record(z.string(), z.string()).optional(),
			maxTurns: z.number().int().positive().optional(),
			maxCostUSD: z.number().positive().optional(),
			stallNoticeMinutes: z.number().int().nonnegative().optional(),
		})
		.optional(),
	pricing: z.record(z.string(), ModelPricingSchema).optional(),
	hooks: z.record(z.string(), z.array(z.unknown())).optional(),
	mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type RawSettingsInput = z.input<typeof SettingsSchema>;

// Long-form design notes: docs/dev/migration-framework.md
/** Make the providers and prices a settings file declares real. */
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

// Long-form design notes: docs/dev/migration-framework.md
/** Settings a repository is not allowed to set for itself. */
export const PROJECT_TIER_KEY_POLICY: Record<keyof Settings, "denied" | "repo"> = {
	model: "denied",
	fallbackModels: "denied",
	permissionMode: "denied",
	// A cloned repository choosing its own confinement level is the same move as
	// one choosing its own approval policy: it hands itself the widest one.
	sandbox: "denied",
	// Same reasoning, applied to the network axis. A repository that could turn
	// the network on would be choosing where the user's traffic goes, and one
	// that could turn it *off* would be choosing which of its own commands fail.
	networkAccess: "denied",
	networkDomains: "denied",
	env: "denied",
	providers: "denied",
	hooks: "denied",
	mcpServers: "denied",
	pricing: "denied",
	cache: "denied",
	trimOldToolResults: "denied",
	// The same cost class as `cache` and `trimOldToolResults`: it decides how much
	// the model chews on the user's own conversation — what the turns are billed,
	// and how fast the context fills — and a repo has no business choosing that.
	thinkingLevel: "denied",
	// Not a lockdown but the same rule: whether this startup asks the network a
	// question is the user's decision, not the repository's.
	modelDiscovery: "denied",
	// The same class as `modelDiscovery`: whether a finished command spends a
	// turn and sends the end of the log to the provider is the user's decision,
	// and a repository that re-enabled silenced notices would be spending on its
	// own checkout's behalf.
	backgroundShellNotifications: "denied",
	gamepad: "denied",
	// The same money question as `model`: the band's four members spend the
	// user's budget per request, and which models they run is the user's call.
	beetle: "denied",
	allowManagedPermissionRulesOnly: "denied",
	disableBypassPermissionsMode: "denied",
	// Cosmetic, no reach beyond the user's own terminal.
	theme: "repo",
	vimMode: "repo",
	emacsMode: "repo",
	// Merged field by field — see PROJECT_TIER_PERMISSION_KEY_POLICY below.
	permissions: "repo",
};

// Long-form design notes: docs/dev/migration-framework.md
/** The same question for `permissions`, which merges field by field. */
export const PROJECT_TIER_PERMISSION_KEY_POLICY: Record<keyof Settings["permissions"], "denied" | "repo"> = {
	allow: "denied",
	additionalDirectories: "denied",
	deny: "repo",
};

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
	for (const [key, policy] of Object.entries(PROJECT_TIER_KEY_POLICY)) {
		if (policy !== "denied" || !(key in out)) continue;
		delete out[key];
		ignored.push({ source, key });
	}
	const permissions = out.permissions;
	if (typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)) {
		const kept: Record<string, unknown> = { ...(permissions as Record<string, unknown>) };
		for (const [key, policy] of Object.entries(PROJECT_TIER_PERMISSION_KEY_POLICY)) {
			if (policy !== "denied" || !(key in kept)) continue;
			delete kept[key];
			ignored.push({ source, key: `permissions.${key}` });
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
export type UserChoiceKey = "theme" | "model" | "vimMode" | "emacsMode" | "gamepad" | "thinkingLevel";

/** Tiers that outrank the user's own file, highest first. */
const OVERRIDING_TIERS = ["flag", "policy", "local", "project"] as const;

interface TierSource {
	perSource: Partial<Record<SettingsSourceName, Settings>>;
	sources: Partial<Record<SettingsSourceName, string>>;
}

// Long-form design notes: docs/dev/migration-framework.md
/** The tier that would win over a choice written to the user file, if there is one. */
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

// Long-form design notes: docs/dev/migration-framework.md
/** One clause for a confirmation line, saying where the choice that was just saved will be overridden. */
export function shadowedChoiceNotice(
	loaded: TierSource,
	key: UserChoiceKey,
	display: (path: string) => string,
): string | undefined {
	const tier = shadowingTier(loaded, key);
	if (!tier) return undefined;
	return `${display(tier.path)} sets ${key} and wins on the next start`;
}

function settingsPath(source: SettingsSourceName, cwd: string, home: string): string {
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

// Long-form design notes: docs/dev/migration-framework.md
/** Read the four file tiers. `home` is a parameter with a default rather than a call to `homedir()` in the body. */
export function loadSettings(cwd: string, flagSettings?: RawSettingsInput, home: string = homedir()): LoadedSettings {
	const order: SettingsSourceName[] = ["user", "project", "local", "policy"];
	let merged: RawSettingsInput = {};
	const sources: Partial<Record<SettingsSourceName, string>> = {};
	const perSource: Partial<Record<SettingsSourceName, Settings>> = {};
	const ignoredKeys: IgnoredSettingsKey[] = [];

	for (const source of order) {
		const path = settingsPath(source, cwd, home);
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

// Long-form design notes: docs/dev/migration-framework.md
/** Resolve the effective pair, letting the policy tier veto the unrestricted sandbox. */
export function resolveMode(
	requested: { mode: PermissionMode; sandbox: SandboxMode },
	loaded: LoadedSettings,
): { mode: PermissionMode; sandbox: SandboxMode; downgradeReason?: string } {
	if (requested.sandbox === "danger-full-access" && loaded.perSource.policy?.disableBypassPermissionsMode === true) {
		return {
			mode: requested.mode,
			sandbox: "workspace-write",
			downgradeReason:
				"the unrestricted sandbox is disabled by managed settings — commands will run under workspace-write instead",
		};
	}
	return { ...requested };
}

// Long-form design notes: docs/dev/migration-framework.md
/** Read the network axis out of a settings object. */
export function networkAxisFrom(settings: Settings): NetworkAxis {
	return {
		access: settings.networkAccess ?? "enabled",
		domains: (settings.networkDomains ?? []).map(
			(rule): NetworkDomainRule =>
				typeof rule === "string"
					? { pattern: rule, permission: "allow" }
					: { pattern: rule.domain, permission: rule.action },
		),
	};
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
