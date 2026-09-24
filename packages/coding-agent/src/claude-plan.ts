/**
 * Claude Code's configuration in the target's shape: permission modes, rules,
 * hooks, and the assembled plan.
 *
 * The hook *vocabulary* — the timeout counts, the matcher syntax, the normalized
 * entry — is in `migrate-core.ts` and `migrate-types.ts` rather than here,
 * because Kimi's hooks are written against the same target schema and reuse all
 * of it. `normalizeClaudeHandler` keeps its name for the same reason it keeps
 * this file's history: renaming it would be a change, and this is a move.
 */

import { McpServerConfigSchema } from "@labunbun/mcp";
import type { RawClaudeCode } from "./claude-read.ts";
import type { HookEventName } from "./hooks.ts";
import { HOOK_EVENTS, HooksConfigSchema } from "./hooks.ts";
import {
	DEFAULT_HOOK_TIMEOUT_MS,
	HOOK_MATCHER_METACHARACTERS,
	HOOK_MATCHER_NAME,
	isRecord,
	MAX_HOOK_TIMEOUT_MS,
	normalizeClaudeHandler,
	placeholderNote,
	reportUnhandledKeys,
	summarizeNames,
} from "./migrate-core.ts";
import type {
	ClaimEnv,
	ClaimPermissionList,
	ClaimScalar,
	MigrationItem,
	NormalizedHookEntry,
	NormalizedHooks,
} from "./migrate-types.ts";
import {
	CLAUDE_SETTINGS_HANDLED,
	CLAUDE_STATE_HANDLED,
	looksLikeSecretName,
	resolveModelReference,
	STATE_TELEMETRY_KEYS,
} from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";

/**
 * Claude Code's `permissions.defaultMode` → this build's permission mode.
 *
 * `manual` is an older spelling of `default`. `auto` is deliberately absent: it
 * means a classifier decides, and the nearest mode here (`dontAsk`) means the
 * opposite — anything not explicitly allowed is denied — so carrying it over
 * under a different name would be a lie about what the session will do.
 */
const CLAUDE_PERMISSION_MODES: Record<string, string> = {
	default: "default",
	manual: "default",
	plan: "plan",
	acceptEdits: "acceptEdits",
	bypassPermissions: "bypassPermissions",
};

/**
 * Rewrite source hooks as the target's hook config.
 *
 * The two shapes look alike enough that copying the block reads as faithful and
 * is not: the target runs a fixed set of events, only shell-command handlers,
 * and a matcher where `*` is the only wildcard. Counting each difference here
 * lets the report say what did not come across, rather than writing a hook that
 * never fires.
 */
export function normalizeClaudeHooks(raw: unknown): NormalizedHooks {
	const result: NormalizedHooks = {
		config: {},
		droppedEvents: [],
		droppedHandlers: 0,
		droppedMatchers: [],
		splitMatchers: [],
		malformed: 0,
		convertedTimeouts: 0,
		clampedTimeouts: 0,
		untimedHandlers: 0,
	};
	if (!isRecord(raw)) {
		if (raw !== undefined) result.malformed += 1;
		return result;
	}
	for (const [event, entries] of Object.entries(raw)) {
		if (!HOOK_EVENTS.includes(event as HookEventName)) {
			result.droppedEvents.push(event);
			continue;
		}
		if (!Array.isArray(entries)) {
			result.malformed += 1;
			continue;
		}
		const kept: NormalizedHookEntry[] = [];
		for (const entry of entries) {
			if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
				result.malformed += 1;
				continue;
			}
			const hooks = entry.hooks.flatMap((handler) => normalizeClaudeHandler(handler, result));
			if (hooks.length === 0) continue;
			const matcher = typeof entry.matcher === "string" ? entry.matcher.trim() : "";
			if (matcher === "") {
				kept.push({ hooks });
				continue;
			}
			// `A|B` is an alternation in the source and a literal here — `|` is one
			// of the characters `matchesPattern` escapes — so the source matcher
			// would import as one that can never match. One entry per name is what
			// it meant, and it is not a widening: those are the tools it named.
			const parts = matcher.split("|");
			if (parts.length > 1) {
				if (!parts.every((part) => HOOK_MATCHER_NAME.test(part))) {
					// An alternation with something in it this build cannot express;
					// splitting it would guess at what the source meant.
					result.droppedMatchers.push(matcher);
					continue;
				}
				result.splitMatchers.push(matcher);
				for (const part of parts) kept.push({ matcher: part, hooks });
				continue;
			}
			if (HOOK_MATCHER_METACHARACTERS.test(matcher)) {
				result.droppedMatchers.push(matcher);
				continue;
			}
			kept.push({ matcher, hooks });
		}
		if (kept.length > 0) result.config[event] = kept;
	}
	return result;
}

/** Map Claude Code's `permissions` block onto this build's, sub-key by sub-key. */
function planClaudePermissions(
	settings: Record<string, unknown>,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	claimPermissionList: ClaimPermissionList,
): void {
	const permissions = isRecord(settings.permissions) ? settings.permissions : undefined;
	if (!permissions) return;
	const from = "~/.claude/settings.json → permissions";

	const mode = typeof permissions.defaultMode === "string" ? permissions.defaultMode.trim() : "";
	if (mode) {
		const mapped = CLAUDE_PERMISSION_MODES[mode];
		if (mapped) {
			claimScalar("claude-code", "permissionMode", mapped, `${from}.defaultMode ("${mode}")`, `mapped to "${mapped}"`);
		} else {
			items.push({
				source: "claude-code",
				from: `${from}.defaultMode ("${mode}")`,
				to: "—",
				action: "skip",
				detail:
					mode === "auto"
						? '"auto" has no equivalent here: it is a classifier that approves calls it judges safe, and the nearest mode, "dontAsk", does the opposite — anything not explicitly allowed is denied'
						: "no permission mode here corresponds to this value — the session keeps the mode it would otherwise start in",
				containsSecret: false,
			});
		}
	}

	// A rule list the target cannot parse is a list that would take effect
	// silently as nothing; both lists go through the claimer, which says so.
	for (const behavior of ["allow", "deny"] as const) {
		const list = permissions[behavior];
		if (!Array.isArray(list)) continue;
		const rules = list.filter((rule): rule is string => typeof rule === "string" && rule.trim() !== "");
		if (rules.length === 0) continue;
		claimPermissionList(
			"claude-code",
			behavior,
			rules,
			`${from}.${behavior}`,
			`${rules.length} rule(s) copied verbatim; a Bash rule matches the whole command line here, so a chained command counts as a match too`,
		);
	}

	const dirs = permissions.additionalDirectories;
	if (Array.isArray(dirs)) {
		const paths = dirs.filter((dir): dir is string => typeof dir === "string" && dir.trim() !== "");
		if (paths.length > 0) {
			claimPermissionList(
				"claude-code",
				"additionalDirectories",
				paths,
				`${from}.additionalDirectories`,
				`${paths.length} path(s) added to the directories this session may work in`,
			);
		}
	}

	const ask = permissions.ask;
	if (Array.isArray(ask) && ask.length > 0) {
		items.push({
			source: "claude-code",
			from: `${from}.ask`,
			to: "—",
			action: "skip",
			detail: `${ask.length} rule(s) did not come across: there is no ask tier here, and a call that is neither denied nor allowed simply runs under the session's permission mode — move the ones you still want to be asked about into permissions.deny`,
			containsSecret: false,
		});
	}

	const lockdown = permissions.disableBypassPermissionsMode;
	if (lockdown !== undefined) {
		items.push({
			source: "claude-code",
			from: `${from}.disableBypassPermissionsMode`,
			to: "—",
			action: "downgrade",
			detail: `not written to ~/.labunbun/settings.json: this key is honoured only from the policy tier, where the file being restricted cannot lift its own restriction — put "disableBypassPermissionsMode": ${JSON.stringify(lockdown)} in ~/.labunbun/managed-settings.json instead`,
			containsSecret: false,
		});
	}
}

/** Map source hooks onto the target's hook config, reporting what cannot run. */
function planClaudeHooks(
	settings: Record<string, unknown>,
	items: MigrationItem[],
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	force: boolean,
): void {
	if (settings.hooks === undefined) return;
	// An empty block is not a hook file with nothing runnable; it is nothing.
	if (isRecord(settings.hooks) && Object.keys(settings.hooks).length === 0) return;
	const from = "~/.claude/settings.json → hooks";
	const normalized = normalizeClaudeHooks(settings.hooks);
	const losses: string[] = [];
	if (normalized.droppedEvents.length > 0) {
		losses.push(
			`${normalized.droppedEvents.length} event(s) with no hook here (${summarizeNames(normalized.droppedEvents)})`,
		);
	}
	if (normalized.droppedHandlers > 0)
		losses.push(`${normalized.droppedHandlers} handler(s) that are not shell commands`);
	if (normalized.droppedMatchers.length > 0) {
		losses.push(`${normalized.droppedMatchers.length} matcher(s) using pattern characters this build escapes`);
	}
	if (normalized.malformed > 0) losses.push(`${normalized.malformed} entr(ies) not in the hook shape`);
	if (normalized.clampedTimeouts > 0) {
		losses.push(
			`${normalized.clampedTimeouts} timeout(s) longer than the ${MAX_HOOK_TIMEOUT_MS / 1000} s this build waits, clamped to it`,
		);
	}

	const events = Object.keys(normalized.config);
	if (events.length === 0) {
		items.push({
			source: "claude-code",
			from,
			to: "—",
			action: "skip",
			detail:
				losses.length > 0
					? `nothing here would run: ${losses.join("; ")}`
					: "no hook in this file has a command this build could run",
			containsSecret: false,
		});
		return;
	}
	if (!HooksConfigSchema.safeParse(normalized.config).success) {
		items.push({
			source: "claude-code",
			from,
			to: "—",
			action: "skip",
			detail: "hooks are not in a shape this build accepts, even after rewriting",
			containsSecret: false,
		});
		return;
	}
	if (existing.hooks !== undefined && !force) {
		items.push({
			source: "claude-code",
			from,
			to: "—",
			action: "skip",
			detail: "target already defines hooks — kept (use --force to overwrite)",
			containsSecret: false,
		});
		return;
	}
	settingsPatch.hooks = normalized.config;
	const entries = events.reduce((count, event) => count + normalized.config[event].length, 0);
	const split =
		normalized.splitMatchers.length > 0
			? `; ${summarizeNames(normalized.splitMatchers)} written as A|B, split into one entry per name`
			: "";
	// Converting a timeout is not a loss — the wait is the one the source asked
	// for — so it belongs beside the rewrite, not in the "not carried" list. The
	// default does have to be said out loud: the source's ten minutes become this
	// build's sixty seconds for every handler that named no timeout of its own.
	const timeouts = [
		normalized.convertedTimeouts > 0
			? `${normalized.convertedTimeouts} timeout(s) converted from the seconds the source writes to milliseconds here`
			: "",
		normalized.untimedHandlers > 0
			? `a handler that names no timeout runs for ${DEFAULT_HOOK_TIMEOUT_MS / 1000} s here, where the source allowed 10 minutes`
			: "",
	]
		.filter(Boolean)
		.join("; ");
	items.push({
		source: "claude-code",
		from,
		to: "settings.json → hooks",
		action: losses.length > 0 ? "downgrade" : "map",
		detail: `${entries} matcher entr(ies) over ${events.length} event(s) rewritten${split}${timeouts ? `; ${timeouts}` : ""}${losses.length > 0 ? `; not carried: ${losses.join("; ")}` : ""}`,
		containsSecret: false,
	});
}

export function planClaudeCode(
	raw: RawClaudeCode,
	items: MigrationItem[],
	claimEnv: ClaimEnv,
	claimScalar: ClaimScalar,
	claimPermissionList: ClaimPermissionList,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	// env: the settings file first, then the state file. Both hold the same kind
	// of values and either may carry the proxy credentials.
	for (const [file, container] of [
		["~/.claude/settings.json", raw.settings],
		["~/.claude.json", raw.state],
	] as const) {
		const envBlock = container.env;
		if (typeof envBlock !== "object" || envBlock === null || Array.isArray(envBlock)) continue;
		for (const [name, value] of Object.entries(envBlock as Record<string, unknown>)) {
			if (typeof value !== "string") continue;
			claimEnv("claude-code", name, value, `${file} → env.${name}`);
		}
	}

	// model alias
	const modelValue = typeof raw.settings.model === "string" ? raw.settings.model : raw.state.model;
	if (typeof modelValue === "string" && modelValue.trim()) {
		const resolved = resolveModelReference(modelValue);
		if (resolved) {
			claimScalar(
				"claude-code",
				"model",
				resolved,
				`~/.claude/settings.json → model ("${modelValue}")`,
				`resolved to ${resolved}`,
			);
		} else {
			items.push({
				source: "claude-code",
				from: `~/.claude/settings.json → model ("${modelValue}")`,
				to: "—",
				action: "skip",
				detail: "no model in the registry matches this name — set a model reference manually",
				containsSecret: false,
			});
		}
	}

	// MCP servers
	const servers = raw.state.mcpServers;
	if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
		for (const [name, config] of Object.entries(servers as Record<string, unknown>)) {
			const parsed = McpServerConfigSchema.safeParse(config);
			if (!parsed.success) {
				items.push({
					source: "claude-code",
					from: `~/.claude.json → mcpServers.${name}`,
					to: "—",
					action: "skip",
					detail: "server definition does not match the supported stdio/http shapes",
					containsSecret: false,
				});
				continue;
			}
			if (name in existingMcpServers && !force) {
				items.push({
					source: "claude-code",
					from: `~/.claude.json → mcpServers.${name}`,
					to: "—",
					action: "skip",
					detail: "target already defines a server with this name — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			const record = config as { headers?: Record<string, string>; env?: Record<string, string> };
			const secret =
				Object.keys(record.headers ?? {}).length > 0 ||
				Object.keys(record.env ?? {}).some((key) => looksLikeSecretName(key));
			const placeholder = placeholderNote(record as Record<string, unknown>);
			mcpServers[name] = config;
			markMcpSecret(secret);
			const copied = secret ? "copied verbatim, including credential headers" : "copied verbatim";
			items.push({
				source: "claude-code",
				from: `~/.claude.json → mcpServers.${name}`,
				to: `.mcp.json → mcpServers.${name}`,
				action: placeholder ? "downgrade" : "map",
				detail: placeholder ? `${copied} — ${placeholder}` : copied,
				containsSecret: secret,
			});
		}
	}

	// Each `projects` entry holds that project's local-scope MCP servers —
	// `services/mcp/config.ts` reads them for scope `local`. This build has no
	// local scope: its servers live in `<cwd>/.mcp.json`, which is the
	// repository's file, or in `~/.labunbun/.mcp.json`, which serves every
	// project. A local server fits neither — carrying it into the second runs it
	// everywhere — so each one is named, with both doors spelled out.
	const projects = raw.state.projects;
	if (isRecord(projects)) {
		for (const [project, entry] of Object.entries(projects)) {
			const local = isRecord(entry) && isRecord(entry.mcpServers) ? Object.keys(entry.mcpServers) : [];
			for (const name of local) {
				items.push({
					source: "claude-code",
					from: `~/.claude.json → projects["${project}"].mcpServers.${name}`,
					to: "—",
					action: "skip",
					detail:
						"local-scope server: the source holds it for this one project and there is no local scope here — " +
						"copy it into <cwd>/.mcp.json to keep it to this project (that file belongs to the repository), or " +
						"into ~/.labunbun/.mcp.json to have it everywhere",
					containsSecret: false,
				});
			}
		}
		items.push({
			source: "claude-code",
			from: "~/.claude.json → projects",
			to: "—",
			action: "skip",
			detail:
				"per-project bookkeeping — run history and onboarding flags, none of it configuration this build reads; " +
				"the local-scope MCP servers it also holds are named one by one when there are any",
			containsSecret: false,
		});
	}

	// fallback model: the source names one, the target keeps a list.
	const fallback = typeof raw.settings.fallbackModel === "string" ? raw.settings.fallbackModel : undefined;
	if (fallback?.trim()) {
		const resolved = resolveModelReference(fallback);
		if (resolved) {
			claimScalar(
				"claude-code",
				"fallbackModels",
				[resolved],
				`~/.claude/settings.json → fallbackModel ("${fallback}")`,
				`resolved to ${resolved}`,
			);
		} else {
			items.push({
				source: "claude-code",
				from: `~/.claude/settings.json → fallbackModel ("${fallback}")`,
				to: "—",
				action: "skip",
				detail:
					"no model in the registry matches this name — set fallbackModels manually if you want it tried after the primary",
				containsSecret: false,
			});
		}
	}

	planClaudePermissions(raw.settings, items, claimScalar, claimPermissionList);
	planClaudeHooks(raw.settings, items, settingsPatch, existing, force);

	if (raw.settings.effortLevel !== undefined) {
		items.push({
			source: "claude-code",
			from: "~/.claude/settings.json → effortLevel",
			to: "—",
			action: "skip",
			detail: "no reasoning-effort setting exists here; thinking level is chosen per request",
			containsSecret: false,
		});
	}
	if (raw.settings.enabledPlugins !== undefined) {
		// The old wording claimed skills and MCP servers covered the same ground.
		// They do not: a plugin is where all of those live at once — its skills,
		// agents, commands, hooks and MCP servers — and nothing under a plugin's
		// directory is read by this import. Naming the enabled ones at least says
		// what is on the other side of the gap.
		const enabled = isRecord(raw.settings.enabledPlugins)
			? Object.entries(raw.settings.enabledPlugins)
					.filter(([, on]) => on === true)
					.map(([id]) => id)
			: null;
		const names =
			enabled === null
				? ""
				: enabled.length > 0
					? `; enabled in the source: ${summarizeNames(enabled)}`
					: "; none of them is enabled in the source";
		items.push({
			source: "claude-code",
			from: "~/.claude/settings.json → enabledPlugins",
			to: "—",
			action: "skip",
			detail:
				"no plugin system here, and nothing under a plugin's own directory is read — a plugin carries skills, " +
				`agents, commands, hooks and MCP servers, none of which this import takes from it${names}`,
			containsSecret: false,
		});
	}
	for (const key of Object.keys(raw.state)) {
		if (!STATE_TELEMETRY_KEYS.has(key)) continue;
		items.push({
			source: "claude-code",
			from: `~/.claude.json → ${key}`,
			to: "—",
			action: "skip",
			detail: "usage statistics and runtime bookkeeping, not configuration",
			containsSecret: false,
		});
	}

	// Everything else, so that no key is absent from the report without saying
	// so. One line per file, names only: the user's settings may hold values
	// this importer has no business printing.
	reportUnhandledKeys("claude-code", raw.settings, CLAUDE_SETTINGS_HANDLED, "~/.claude/settings.json", items);
	reportUnhandledKeys("claude-code", raw.state, CLAUDE_STATE_HANDLED, "~/.claude.json", items);
}
