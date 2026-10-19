// Settings hierarchy (later overrides earlier): user, project, local, policy and flag.
// Long-form design notes: docs/dev/migration-framework.md

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	NETWORK_DOMAIN_PERMISSIONS,
	NETWORK_SANDBOX_POLICIES,
	type NetworkAxis,
	type NetworkDomainRule,
	type NetworkSandboxPolicy,
	PERMISSION_MODES,
	type PermissionMode,
	type PermissionRule,
	parseRuleList,
	type RuleSource,
	SANDBOX_MODES,
	type SandboxMode,
} from "@labunbun/agent";
import { registerOpenAICompatibleProvider, setPricingOverride, THINKING_LEVELS } from "@labunbun/ai";
import { isMissingPathError } from "@labunbun/tools";
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

/**
 * One seat of the role stack, as a settings file writes it.
 *
 * Every field is optional so a half-written entry still parses: an entry that
 * names no model is a configuration mistake, and `resolveRoles` says so and
 * ignores it — a parse error here would drop the whole settings file instead,
 * which is the opposite of fail-soft. The reference syntax matches the one
 * session models have always used (see `model-roles.ts` for the exact rule):
 * `model` alone is a bare id or a `provider/model` reference, and `provider`
 * names the serving side explicitly, which is the only way to reach a gateway
 * row — bare ids never resolve to one.
 */
export const RoleEntrySchema = z.object({
	provider: z.string().optional(),
	model: z.string().optional(),
	fallback: z.array(z.string()).optional(),
	/**
	 * A ceiling, in USD, on what this seat's conversation may spend: once the
	 * session has spent past it, a request that seat is about to make is
	 * refused before it is sent — see `budgetVerdict` in `model-roles.ts` for
	 * the exact rule (strictly over, not equal, and no budget means no
	 * ceiling).
	 *
	 * Like every other field here it is only honoured on an entry that
	 * resolved: a seat whose model did not resolve is ignored whole, budget
	 * included, and `resolveRoles` says so. Positive because a ceiling of zero
	 * is not a budget — it is a seat that may never run, and the honest way to
	 * say that is to stop configuring it.
	 */
	budgetUSD: z.number().positive().optional(),
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
	/**
	 * The language answers should be written in, injected into the system prompt
	 * verbatim (`system-prompt.ts`). Free-form rather than an enum for the same
	 * reason as `theme`: a fixed list would have to decide between rejecting
	 * "Chinese" and rejecting "zh-CN", and this app has no list of languages it
	 * could claim to have enumerated.
	 */
	language: z.string().min(1).optional(),
	/**
	 * The output style this session should speak in: the name of a file in the
	 * user's — or, once trusted, this project's — `.labunbun/output-styles/`
	 * (`output-styles.ts`), whose body is injected as the `# Output style`
	 * section. Free-form because the names come from disk; a name that resolves
	 * to nothing injects nothing, which is the kind of typo `/doctor` can report.
	 */
	outputStyle: z.string().optional(),
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
	/**
	 * Let the cheap rung run by itself: at the compaction threshold, and after an
	 * hour of quiet where the provider's cache is cold anyway. The same
	 * permission covers both moments — false leaves old results whole until
	 * `/trim` is asked or a summary replaces them.
	 */
	trimOldToolResults: z.boolean().optional(),
	// Long-form design notes: docs/dev/migration-framework.md
	/**
	 * The compaction knobs, for a conversation the defaults manage the wrong
	 * way: whether the automatic passes run at all, which model writes the
	 * summaries, how much headroom is kept below the window, and where the
	 * trigger line sits. The arithmetic itself is `compactionThreshold`'s, in
	 * the agent package; `/autocompact` reads and writes the first and the last.
	 */
	compaction: z
		.object({
			/**
			 * Off silences the passes the app takes by itself: the automatic
			 * summary when the context crosses the trigger line, and the
			 * automatic cheap trim that runs before one is paid for. Undefined
			 * and true are the same state — the behavior every session had
			 * before this key existed — so the knob only ever turns things off
			 * that ran, never upgrades anything that did not.
			 *
			 * The scope is deliberate and is exactly two passes. The ones a
			 * person starts (`/compact`, `/trim`) run on request whatever this
			 * says, and so does the recovery pass after a provider refuses an
			 * over-long request: that pass is not a habit of the app but the
			 * only way forward for the conversation that is already too big,
			 * and an off switch that reached it would be a decision to break
			 * the next request. `/autocompact off` says as much in its line.
			 *
			 * It sits in this object rather than a key of its own because the
			 * two are one question — what does automatic context management
			 * cost this session — and a reader looking for the cost knobs
			 * should find all of them, the off switch included, in one place.
			 */
			enabled: z.boolean().optional(),
			/** The model that writes summaries; the session's own model when unset. */
			model: z.string().optional(),
			/** Tokens kept free below the window when the trigger line is computed. */
			reserveTokens: z.number().int().positive().optional(),
			/**
			 * The trigger line as a percent of the window. When set it replaces the
			 * reserve arithmetic rather than feeding it — a session the user wants
			 * to compact early says so directly. Bounded on both ends: a line at 0%
			 * would compact before the first request could be sent, and one at 100%
			 * sits past the point where requests are refused.
			 */
			thresholdPercent: z.number().gt(0).lt(100).optional(),
		})
		.optional(),
	/**
	 * Ask each provider with a key — and each one that takes no key at all, like
	 * the local Ollama daemon — what it serves, once at startup, and let the
	 * answer narrow the `/model` picker. On by default: it is one request per
	 * provider, it never blocks anything, and a failure leaves the catalog's own
	 * table in place. Set false to keep the picker to the table — an air-gapped
	 * or metered machine should not have to firewall a startup chat.
	 */
	modelDiscovery: z.boolean().optional(),
	// Long-form design notes: docs/dev/migration-framework.md
	/**
	 * Wake the session when a background shell finishes on its own, and when
	 * one stalls on what looks like an interactive prompt. A manager cap that
	 * stops a shell is reported on screen either way — that is an action the
	 * session took, not a notification to opt out of.
	 */
	backgroundShellNotifications: z.boolean().optional(),
	permissions: z
		.object({
			allow: z.array(z.string()).default([]),
			deny: z.array(z.string()).default([]),
			/**
			 * Rules whose match still comes to a person, in every mode — the one
			 * behavior no mode resolves on its own. Nothing runs because of this
			 * list, so like `deny` it is a tightening and a project file may carry
			 * it (see the project tier's key policy).
			 */
			ask: z.array(z.string()).default([]),
			additionalDirectories: z.array(z.string()).default([]),
		})
		.default({ allow: [], deny: [], ask: [], additionalDirectories: [] }),
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
	/**
	 * The role stack: which model each seat of the session runs on.
	 *
	 * Compatible services do not have compatible abilities: one OpenAI-shaped
	 * endpoint can take a tool call, another can only chat, and a gateway serves
	 * ids its vendors never named. A role names one seat — the main
	 * conversation, plan mode, compaction, subagents, local work — and lets it
	 * pin a provider beside the model, plus its own fallback order and spending
	 * ceiling, independently of every other seat.
	 *
	 * Resolution is fail-soft and lives in `model-roles.ts`: a reference that
	 * names nothing (or a model whose key is missing) warns on stderr and leaves
	 * the role on its host default, where an unknown `model` still stops the app.
	 */
	roles: z
		.object({
			/** The main conversation's default model, when nothing more explicit picks one. */
			main: RoleEntrySchema.optional(),
			/** The model plan mode runs on while planning. */
			plan: RoleEntrySchema.optional(),
			/** The model that writes compaction summaries; aliases `compaction.model`. */
			compaction: RoleEntrySchema.optional(),
			/** Where subagents run, unless their own definition names a model. */
			light: RoleEntrySchema.optional(),
			/**
			 * The local seat (a machine-local daemon). No feature consumes it yet, so
			 * `resolveRoles` warns when one is configured: a seat that looks wired
			 * and is not has to say so itself.
			 */
			local: RoleEntrySchema.optional(),
		})
		.optional(),
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

/**
 * One thing a settings file did wrong.
 *
 * The loader used to report a broken file by `console.error`, which is invisible
 * in a TUI and easy to miss in a script. The finding travels with the load now,
 * and each host decides where its user will read it.
 */
export interface SettingsDiagnostic {
	source: SettingsSourceName;
	/** The file the finding is about; `--settings` for the flag tier. */
	path: string;
	kind: "unreadable" | "invalid-json" | "invalid-shape" | "unknown-key";
	message: string;
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
	/** Files that could not be read, parsed, or validated — see {@link SettingsDiagnostic}. */
	diagnostics: SettingsDiagnostic[];
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
	// The same cost class as `model` and `trimOldToolResults` together: it names
	// the model that spends on the conversation and decides when the transcript
	// is rewritten, and a cloned repository choosing either is the move `model`
	// is already denied for.
	compaction: "denied",
	// The same cost class as `cache` and `trimOldToolResults`: it decides how much
	// the model chews on the user's own conversation — what the turns are billed,
	// and how fast the context fills — and a repo has no business choosing that.
	thinkingLevel: "denied",
	// `model` and `fallbackModels` once over, applied per seat: a repository that
	// could name the models would be choosing what the user's conversation spends
	// on — and `roles.compaction` aliases a key already denied above.
	roles: "denied",
	// Not a lockdown but the same rule: whether this startup asks the network a
	// question is the user's decision, not the repository's.
	modelDiscovery: "denied",
	// The same class as `modelDiscovery`: whether a shell event that wakes the
	// session — a completion, or a stall at a prompt — spends a turn and sends
	// part of the log to the provider is the user's decision, and a repository
	// that re-enabled silenced notices would be spending on its own checkout's
	// behalf.
	backgroundShellNotifications: "denied",
	gamepad: "denied",
	// The same money question as `model`: the band's four members spend the
	// user's budget per request, and which models they run is the user's call.
	beetle: "denied",
	allowManagedPermissionRulesOnly: "denied",
	disableBypassPermissionsMode: "denied",
	// A repository choosing the language the user is answered in, or the style
	// the session speaks in, is deciding how this checkout's assistant talks to
	// them. The style files themselves may be project-tier (behind the trust
	// gate), but the *selection* cannot be: a style the user never named, active
	// the moment a session starts, is a prompt section they did not see.
	language: "denied",
	outputStyle: "denied",
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
	// Tightening, like `deny`: an ask rule never runs a call, it only adds a
	// question — and one the user answers. A repo that made commands ask more
	// often has constrained what the session does on its own behalf, not widened
	// anything it does.
	ask: "repo",
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
	// `__proto__` is never a settings key, and `JSON.parse` gives it an own data
	// property that every copy in this loader hands along — `mergeSettings` used
	// to assign it, which fires Object.prototype's accessor setter instead, so
	// the merged object's prototype became the repo's object and any key inside
	// it read as an inherited setting. Dropped (and reported) here as well as
	// skipped in the merge, so the repo's value never reaches the schema parse
	// of the tier either.
	if (Object.hasOwn(out, "__proto__")) {
		// `Reflect.deleteProperty`, not the delete operator, because a `__proto__`
		// member access is what the noProto lint bans — and this one is a key in
		// JSON, not a prototype operation.
		Reflect.deleteProperty(out, "__proto__");
		ignored.push({ source, key: "__proto__" });
	}
	for (const [key, policy] of Object.entries(PROJECT_TIER_KEY_POLICY)) {
		if (policy !== "denied" || !(key in out)) continue;
		delete out[key];
		ignored.push({ source, key });
	}
	const permissions = out.permissions;
	if (typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)) {
		const kept: Record<string, unknown> = { ...(permissions as Record<string, unknown>) };
		if (Object.hasOwn(kept, "__proto__")) {
			Reflect.deleteProperty(kept, "__proto__");
			ignored.push({ source, key: "permissions.__proto__" });
		}
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

/** What reading one tier's file produced. */
type JsonFileRead =
	| { kind: "missing" }
	| { kind: "ok"; value: unknown }
	| { kind: "failed"; diagnostic: Pick<SettingsDiagnostic, "kind" | "message"> };

function readJsonFile(path: string): JsonFileRead {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		// Most tiers are absent on most machines, and absent is not a finding. A
		// file that is there and could not be read is one the user should hear
		// about: otherwise a permission error reads as "this tier was empty".
		if (isMissingPathError(error)) return { kind: "missing" };
		return {
			kind: "failed",
			diagnostic: { kind: "unreadable", message: `could not be read: ${messageOf(error)}` },
		};
	}
	try {
		// Read the same way everywhere settings are read: a byte-order mark from a
		// Windows editor is not a parse error, and treating it as one drops a
		// whole tier of settings without the user ever learning why.
		return { kind: "ok", value: JSON.parse(stripBom(text)) };
	} catch (error) {
		return {
			kind: "failed",
			diagnostic: { kind: "invalid-json", message: `is not valid JSON: ${messageOf(error)}` },
		};
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The first problem zod found, and the count of the ones behind it. */
function issueSummary(error: z.ZodError): string {
	const [first, ...rest] = error.issues;
	const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
	const more = rest.length > 0 ? ` (and ${rest.length} more issue${rest.length === 1 ? "" : "s"})` : "";
	return `${where}${first?.message ?? "no detail"}${more}`;
}

/** Top-level keys this release knows; a key outside the set is reported, not silently dropped by zod. */
const KNOWN_SETTINGS_KEYS: ReadonlySet<string> = new Set(Object.keys(SettingsSchema.shape));

function collectUnknownSettingsKeys(
	out: SettingsDiagnostic[],
	source: SettingsSourceName,
	path: string,
	data: unknown,
): void {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return;
	for (const key of Object.keys(data)) {
		if (KNOWN_SETTINGS_KEYS.has(key)) continue;
		out.push({
			source,
			path,
			kind: "unknown-key",
			message: `sets an unknown key "${key}"; it was ignored`,
		});
	}
}

/**
 * The startup lines a host prints for {@link LoadedSettings.diagnostics}.
 *
 * Deduplicated by content: the same file can produce the same sentence through
 * two readers, and saying it twice would read as two broken files.
 */
export function formatSettingsDiagnostics(loaded: Pick<LoadedSettings, "diagnostics">): string[] {
	return [...new Set(loaded.diagnostics.map((diagnostic) => `Settings ${diagnostic.path} ${diagnostic.message}`))];
}

/** Recursive merge: objects merge, arrays/scalars replace. Later wins. */
export function mergeSettings<T>(base: T, override: unknown): T {
	if (override === undefined) return base;
	if (typeof base !== "object" || base === null || Array.isArray(base)) return override as T;
	if (typeof override !== "object" || override === null || Array.isArray(override)) return override as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(override)) {
		// `__proto__` is never a settings key, and `out[key] = value` for it would
		// invoke Object.prototype's accessor setter — retargeting the merged
		// object's prototype at the override's value, whose keys would then read
		// as inherited settings. Skipped rather than assigned, at every depth.
		if (key === "__proto__") continue;
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
	const diagnostics: SettingsDiagnostic[] = [];

	for (const source of order) {
		const path = settingsPath(source, cwd, home);
		const read = readJsonFile(path);
		if (read.kind === "missing") continue;
		if (read.kind === "failed") {
			diagnostics.push({ source, path, ...read.diagnostic });
			continue;
		}
		let data = read.value;
		collectUnknownSettingsKeys(diagnostics, source, path, data);
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
		else
			diagnostics.push({
				source,
				path,
				kind: "invalid-shape",
				message: `has invalid settings: ${issueSummary(tierParsed.error)}`,
			});
	}
	if (flagSettings !== undefined) {
		merged = mergeSettings(merged, flagSettings);
		sources.flag = "--settings";
		collectUnknownSettingsKeys(diagnostics, "flag", "--settings", flagSettings);
		const flagParsed = SettingsSchema.safeParse(flagSettings);
		if (flagParsed.success) perSource.flag = flagParsed.data;
		else
			diagnostics.push({
				source: "flag",
				path: "--settings",
				kind: "invalid-shape",
				message: `has invalid settings: ${issueSummary(flagParsed.error)}`,
			});
	}

	const parsed = SettingsSchema.safeParse(merged);
	if (!parsed.success) {
		// Fail closed, as before: a partially applied file is a session running
		// settings nobody wrote. The difference is that the reason now survives
		// the load; a broken file used to be a `console.error` in a TUI that
		// never shows stderr, which is the same as saying nothing.
		const culprit = diagnostics.find((diagnostic) => diagnostic.kind === "invalid-shape");
		diagnostics.push({
			source: culprit?.source ?? "user",
			path: culprit?.path ?? "(merged settings)",
			kind: "invalid-shape",
			message: `has invalid settings, so the defaults are in effect: ${issueSummary(parsed.error)}`,
		});
		return { settings: SettingsSchema.parse({}), sources, perSource, ignoredKeys, diagnostics };
	}
	return { settings: parsed.data, sources, perSource, ignoredKeys, diagnostics };
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
 * regardless of tier, and ask rules are consulted before allows, so this
 * ordering only affects the allow list and display — within a tier the three
 * behaviors are pushed in the severity order the engine reads them.
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
			...parseRuleList(tier.permissions.ask, "ask", ruleSource),
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
/**
 * Read the network axis out of a settings object.
 *
 * `accessOverride` is the `--network` flag, when one was typed. A flag names
 * the access half of the axis and nothing else: the domain table keeps its
 * settings source, because a command line cannot spell a rule list, and a
 * `--network restricted` that silently emptied the allowlist would be a
 * narrower policy than the one the user asked for.
 */
export function networkAxisFrom(settings: Settings, accessOverride?: NetworkSandboxPolicy): NetworkAxis {
	return {
		access: accessOverride ?? settings.networkAccess ?? "enabled",
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
