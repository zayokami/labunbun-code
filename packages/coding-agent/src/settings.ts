/**
 * Settings hierarchy (later overrides earlier):
 *   user (~/.labunbun/settings.json)
 *   → project (<cwd>/.labunbun/settings.json)
 *   → local (<cwd>/.labunbun/settings.local.json, gitignored)
 *   → policy (~/.labunbun/managed-settings.json)
 *   → flag (--settings / CLI-provided object)
 *
 * Objects merge recursively; arrays and scalars replace.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type PermissionMode, type PermissionRule, parseRuleList, type RuleSource } from "@labunbun/agent";
import { z } from "zod";

export const PermissionModeSchema = z.enum(["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]);

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
	permissions: z
		.object({
			allow: z.array(z.string()).default([]),
			deny: z.array(z.string()).default([]),
			additionalDirectories: z.array(z.string()).default([]),
		})
		.default({ allow: [], deny: [], additionalDirectories: [] }),
	env: z.record(z.string(), z.string()).optional(),
	/**
	 * Policy-tier lockdowns. These are only honoured when they come from the
	 * managed (policy) file — a project or local file setting them would be
	 * asking the thing being restricted to restrict itself.
	 */
	allowManagedPermissionRulesOnly: z.boolean().optional(),
	disableBypassPermissionsMode: z.boolean().optional(),
	providers: z.object({ openaiCompatible: z.array(OpenAICompatibleProviderSchema).default([]) }).optional(),
	hooks: z.record(z.string(), z.array(z.unknown())).optional(),
	mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type RawSettingsInput = z.input<typeof SettingsSchema>;

export type SettingsSourceName = "user" | "project" | "local" | "policy" | "flag";

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
		return JSON.parse(readFileSync(path, "utf8"));
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

	for (const source of order) {
		const path = settingsPath(source, cwd);
		const data = readJsonFile(path);
		if (data === undefined) continue;
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
		return { settings: SettingsSchema.parse({}), sources, perSource };
	}
	return { settings: parsed.data, sources, perSource };
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
