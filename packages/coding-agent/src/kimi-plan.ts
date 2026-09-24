/**
 * Kimi Code's configuration in the target's shape: permission modes and rules,
 * hooks, MCP servers, and the asset trees.
 *
 * The hooks are the interesting part. Kimi names its timeouts in seconds and
 * uses a different spelling for a matcher, but the target's hook schema is the
 * one Claude Code's hooks already normalize into, so this file calls the shared
 * normalizer rather than writing a second one.
 */

import { join } from "node:path";
import { resolveModel } from "@labunbun/ai";
import { McpServerConfigSchema } from "@labunbun/mcp";
import type { HookEventName } from "./hooks.ts";
import { HOOK_EVENTS, HooksConfigSchema } from "./hooks.ts";
import { kimiConfigPath, kimiMcpFile, kimiPluginsDir } from "./kimi-home.ts";
import type { RawKimiCode } from "./kimi-read.ts";
import {
	collectFileWrites,
	DEFAULT_HOOK_TIMEOUT_MS,
	HOOK_MATCHER_METACHARACTERS,
	HOOK_MATCHER_NAME,
	isRecord,
	normalizeClaudeHandler,
	placeholderNote,
	planMemoryAsRule,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
} from "./migrate-core.ts";
import type {
	ClaimHooks,
	ClaimScalar,
	MigrationItem,
	NormalizedHookEntry,
	NormalizedHooks,
	PlannedWrite,
} from "./migrate-types.ts";
import { looksLikeSecretName } from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";

/**
 * Skills, agent definitions and the AGENTS.md memory document for a source
 * whose asset tree has the same layout as `~/.claude`'s.
 *
 * Claude Code and Codex keep inline copies of this — they predate the helper,
 * and their exact report wording is pinned by tests. New sources use this.
 */

// ---------------------------------------------------------------------------
// Kimi Code
// ---------------------------------------------------------------------------

/**
 * Kimi's session-level permission modes, as `[defaultPermissionMode]` names them.
 *
 * Only two of the three have a counterpart here. `yolo` approves everything —
 * the policy that answers a request in that mode is an unconditional approve, and
 * the dangerous-command policy returns nothing — which is this build's
 * `bypassPermissions`; `manual` asks, which is `default`. `auto` is a classifier
 * that approves the calls it judges safe and asks about the rest, and the nearest
 * mode here (`dontAsk`) does the opposite: anything not explicitly allowed is
 * denied. Mapping it would invert the user's posture, so it is left where it is
 * and said out loud — the same call `CLAUDE_PERMISSION_MODES` makes for Claude
 * Code's own `auto`.
 */
const KIMI_PERMISSION_MODES: Record<string, string | undefined> = {
	manual: "default",
	yolo: "bypassPermissions",
	auto: undefined,
};

/** `[defaultPermissionMode]` and `[defaultPlanMode]`. */
function planKimiPermissionMode(
	raw: RawKimiCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
): void {
	const from = tildePath(home, kimiConfigPath(raw.root));
	const mode = typeof raw.config.defaultPermissionMode === "string" ? raw.config.defaultPermissionMode.trim() : "";
	const planMode = raw.config.defaultPlanMode === true;
	if (!mode && !planMode) return;

	if (planMode) {
		// `defaultPlanMode = true` is where a session starts, and this build holds one
		// starting mode, so that is the one claimed. The permission mode is named
		// rather than mapped: here it would have to be the same single value.
		claimScalar(
			"kimi-code",
			"permissionMode",
			"plan",
			`${from} → defaultPlanMode (true)`,
			'kimi starts in plan mode, which is what this build calls "plan"',
		);
		if (mode) {
			items.push({
				source: "kimi-code",
				from: `${from} → defaultPermissionMode ("${mode}")`,
				to: "—",
				action: "skip",
				detail:
					"with plan mode on, this value governs only what happens after plan mode is left — this build takes one starting " +
					"mode and the plan mode is the one kimi starts in, so the permission mode is named here rather than written over it",
				containsSecret: false,
			});
		}
		return;
	}

	const mapped = KIMI_PERMISSION_MODES[mode];
	if (mapped !== undefined) {
		claimScalar(
			"kimi-code",
			"permissionMode",
			mapped,
			`${from} → defaultPermissionMode ("${mode}")`,
			`mapped to "${mapped}"`,
		);
		return;
	}
	if (mode === "auto") {
		items.push({
			source: "kimi-code",
			from: `${from} → defaultPermissionMode ("auto")`,
			to: "—",
			action: "skip",
			detail:
				'"auto" is a classifier that approves the calls it judges safe, and the nearest mode here, dontAsk, does the ' +
				"opposite — anything not explicitly allowed is denied — so the session keeps whatever mode it would otherwise start in",
			containsSecret: false,
		});
		return;
	}
	items.push({
		source: "kimi-code",
		from: `${from} → defaultPermissionMode ("${mode}")`,
		to: "—",
		action: "skip",
		detail: "not a mode kimi defines, so it never decided a session — the permission mode is left as it is",
		containsSecret: false,
	});
}

/**
 * `[permission]`.
 *
 * Neither key can come across, and for opposite reasons.
 *
 * `rules` is a table this revision of kimi never loads: its rules live in the
 * agent's own state and reach it only through the live `permission.rules.add`
 * operation — kimi's own test file names that operation "live-only" — and nothing
 * reads this table into that state. Importing it here would enforce decisions the
 * source never enforced, which is the one direction a permission import must not
 * move in.
 *
 * `dangerousCommandGuard` has no switch here at all. With it off kimi stops
 * asking about the commands its classifier calls dangerous, and a session here
 * asks according to whatever mode the import above decided — so the value is
 * named, and the direction it points is said rather than smoothed over.
 */
function planKimiPermissions(raw: RawKimiCode, home: string, items: MigrationItem[]): void {
	const permission = isRecord(raw.config.permission) ? raw.config.permission : undefined;
	if (!permission) return;
	const from = `${tildePath(home, kimiConfigPath(raw.root))} → permission`;

	if (permission.rules !== undefined) {
		const rules = Array.isArray(permission.rules)
			? permission.rules.filter((rule): rule is Record<string, unknown> => isRecord(rule))
			: [];
		const decisions = new Map<string, number>();
		for (const rule of rules) {
			const decision = typeof rule.decision === "string" ? rule.decision : "malformed";
			decisions.set(decision, (decisions.get(decision) ?? 0) + 1);
		}
		const shape =
			Array.isArray(permission.rules) && rules.length < permission.rules.length
				? `${permission.rules.length} entries, ${rules.length} of them in the rule shape`
				: `${rules.length} rule(s)`;
		const breakdown =
			decisions.size > 0
				? ` (${[...decisions.entries()].map(([decision, count]) => `${count} ${decision}`).join(", ")})`
				: "";
		items.push({
			source: "kimi-code",
			from: `${from}.rules`,
			to: "—",
			action: "skip",
			detail:
				`${shape}${breakdown} left where they are: kimi reads permission rules from live session state and loads none ` +
				"from this table — its own `permission.rules.add` is live-only — so writing them here would enforce decisions the " +
				"source never enforced",
			containsSecret: false,
		});
	}

	if (permission.dangerousCommandGuard !== undefined) {
		const off = permission.dangerousCommandGuard === false;
		items.push({
			source: "kimi-code",
			from: `${from}.dangerousCommandGuard (${JSON.stringify(permission.dangerousCommandGuard)})`,
			to: "—",
			action: "skip",
			detail: off
				? "kimi with this off stops asking about the commands it classifies as dangerous, and this build has no such guard " +
					"to switch: a session here asks according to the permission mode above, so the value is left where it is"
				: "this build has no dangerous-command guard switch; a session here asks according to the permission mode above",
			containsSecret: false,
		});
	}
}

/**
 * One entry of the target's hook config, from a matcher this build can reproduce.
 *
 * `A|B` is an alternation in kimi and a literal here — `|` is one of the
 * characters `matchesPattern` escapes — so the source matcher would import as one
 * that can never match. One entry per name is what it meant, and it is not a
 * widening: those are the tools it named.
 */
function hookMatcherEntries(
	matcher: string,
	hooks: NormalizedHookEntry["hooks"],
	result: NormalizedHooks,
): NormalizedHookEntry[] {
	if (matcher === "") return [{ hooks }];
	const parts = matcher.split("|");
	if (parts.length > 1) {
		if (!parts.every((part) => HOOK_MATCHER_NAME.test(part))) {
			// An alternation with something in it this build cannot express; splitting
			// it would guess at what the source meant.
			result.droppedMatchers.push(matcher);
			return [];
		}
		result.splitMatchers.push(matcher);
		return parts.map((part) => ({ matcher: part, hooks }));
	}
	if (HOOK_MATCHER_METACHARACTERS.test(matcher)) {
		result.droppedMatchers.push(matcher);
		return [];
	}
	return [{ matcher, hooks }];
}

/** What `matchHooks.ts` waits for a hook that names no timeout. */
const KIMI_DEFAULT_HOOK_TIMEOUT_SECONDS = 30;

/**
 * Kimi's own hook event names, in the order `internal/types.ts` lists them.
 *
 * The eight this build also has are the ones that can carry over; the other
 * twelve are events kimi runs a hook for that have no counterpart here, so a hook
 * under one of them is named and left behind rather than written to a file where
 * nothing would ever call it.
 */
const KIMI_HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
	"PermissionResult",
	"UserPromptSubmit",
	"UserPromptQueued",
	"TurnStarted",
	"Stop",
	"StopFailure",
	"Interrupt",
	"SessionStart",
	"SessionEnd",
	"SessionHeartbeat",
	"SubagentStart",
	"SubagentStop",
	"TaskStarted",
	"PreCompact",
	"PostCompact",
	"Notification",
];

/** Does kimi's own `HookDefSchema` accept this entry? `.strict()`, so unknown keys do not. */
function isKimiHookDef(entry: unknown): entry is Record<string, unknown> {
	if (!isRecord(entry)) return false;
	for (const key of Object.keys(entry)) {
		if (!["event", "matcher", "command", "timeout"].includes(key)) return false;
	}
	if (typeof entry.event !== "string" || !KIMI_HOOK_EVENTS.includes(entry.event)) return false;
	if (typeof entry.command !== "string" || entry.command === "") return false;
	if (entry.matcher !== undefined && typeof entry.matcher !== "string") return false;
	if (entry.timeout !== undefined) {
		if (typeof entry.timeout !== "number" || !Number.isInteger(entry.timeout)) return false;
		if (entry.timeout < 1 || entry.timeout > 600) return false;
	}
	return true;
}

/**
 * `[[hooks]]`, rewritten for this build's hook config.
 *
 * The whole array is checked against kimi's own schema first, because that schema
 * — one object per entry, `.strict()`, with `event`, a non-empty `command`, a
 * string `matcher` and a timeout between 1 and 600 seconds — rejects the *array*,
 * not the entry. One definition with a key kimi does not know means kimi runs none
 * of them, and importing the rest would switch on hooks the source never ran.
 *
 * Where the array is valid, the timeout is the value that has to change: kimi
 * counts seconds and runs an entry without one for thirty of them (`matchHooks.ts`),
 * where this build counts milliseconds and waits sixty. A copy that kept the
 * number is what makes `timeout: 30` mean thirty milliseconds. Kimi's own ceiling,
 * 600 seconds, is exactly this build's longest wait, so a value kimi accepts is
 * never clamped — only a hand-written file that could not have run there would be.
 */
export function normalizeKimiHooks(raw: unknown): NormalizedHooks {
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
	if (raw === undefined) return result;
	if (!Array.isArray(raw)) {
		result.malformed += 1;
		return result;
	}
	const rejected = raw.find((entry) => !isKimiHookDef(entry));
	if (rejected !== undefined) {
		result.malformed += raw.length;
		return result;
	}
	for (const entry of raw as Array<Record<string, unknown>>) {
		const event = entry.event as string;
		if (!HOOK_EVENTS.includes(event as HookEventName)) {
			// A valid kimi event this build has no hook for: the entry runs there and
			// cannot run here, which is a loss to report rather than a malformed line.
			result.droppedEvents.push(event);
			continue;
		}
		const hooks = normalizeClaudeHandler({ type: "command", command: entry.command, timeout: entry.timeout }, result);
		if (hooks.length === 0) continue;
		const matcher = typeof entry.matcher === "string" ? entry.matcher.trim() : "";
		const kept = result.config[event] ?? [];
		kept.push(...hookMatcherEntries(matcher, hooks, result));
		if (kept.length > 0) result.config[event] = kept;
	}
	return result;
}

/** `[[hooks]]` onto this build's hook config, reporting what cannot run. */
function planKimiHooks(
	raw: RawKimiCode,
	home: string,
	items: MigrationItem[],
	claimHooks: ClaimHooks,
	existing: RawSettingsInput,
	force: boolean,
): void {
	if (raw.hookDefs === undefined) return;
	if (Array.isArray(raw.hookDefs) && raw.hookDefs.length === 0) return;
	const from = `${tildePath(home, kimiConfigPath(raw.root))} → hooks`;
	const normalized = normalizeKimiHooks(raw.hookDefs);
	if (normalized.malformed > 0 && Object.keys(normalized.config).length === 0) {
		// The count comes from the array's length, not from "one bad entry": kimi
		// rejects the whole array, so every entry in it — the valid ones included — is
		// one the user wrote and kimi will not run. Reporting a bare "1" would describe
		// a file with one entry, which is what makes this number worth reading.
		const rejected = Array.isArray(raw.hookDefs) ? normalized.malformed : 0;
		items.push({
			source: "kimi-code",
			from,
			to: "—",
			action: "skip",
			detail:
				"kimi's own schema holds this to one shape per entry and rejects the whole array when an entry breaks it — " +
				(rejected > 0
					? `all ${rejected} entr(ies) here went with it, and it runs none of these either, so nothing was imported`
					: "it runs none of these either, so nothing was imported"),
			containsSecret: false,
		});
		return;
	}
	const losses: string[] = [];
	if (normalized.droppedEvents.length > 0) {
		losses.push(
			`${normalized.droppedEvents.length} event(s) with no hook here (${summarizeNames(normalized.droppedEvents)})`,
		);
	}
	if (normalized.droppedMatchers.length > 0) {
		losses.push(`${normalized.droppedMatchers.length} matcher(s) using pattern characters this build escapes`);
	}
	if (normalized.malformed > 0) losses.push(`${normalized.malformed} entr(ies) not in the hook shape`);

	const events = Object.keys(normalized.config);
	if (events.length === 0) {
		items.push({
			source: "kimi-code",
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
			source: "kimi-code",
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
			source: "kimi-code",
			from,
			to: "—",
			action: "skip",
			detail: "target already defines hooks — kept (use --force to overwrite)",
			containsSecret: false,
		});
		return;
	}
	const entries = events.reduce((count, event) => count + normalized.config[event].length, 0);
	const split =
		normalized.splitMatchers.length > 0
			? `; ${summarizeNames(normalized.splitMatchers)} written as A|B, split into one entry per name`
			: "";
	// Converting a timeout is not a loss — the wait is the one the source asked
	// for — so it reads beside the rewrite. The default does have to be said: kimi
	// waits thirty seconds for an entry that names none, and this build waits
	// sixty, so an untimed hook gets a longer wait here than it had there.
	const timeouts = [
		normalized.convertedTimeouts > 0
			? `${normalized.convertedTimeouts} timeout(s) converted from the seconds kimi counts`
			: "",
		normalized.untimedHandlers > 0
			? `${normalized.untimedHandlers} hook(s) named no timeout: kimi waits ${KIMI_DEFAULT_HOOK_TIMEOUT_SECONDS} s, this build ${DEFAULT_HOOK_TIMEOUT_MS / 1000} s`
			: "",
	].filter((part) => part !== "");
	claimHooks(
		"kimi-code",
		normalized.config,
		from,
		`${entries} hook entr(ies) across ${events.length} event(s)` +
			(timeouts.length > 0 ? `; ${timeouts.join("; ")}` : "") +
			split +
			(losses.length > 0 ? `; left behind: ${losses.join("; ")}` : ""),
		losses.length > 0 ? "downgrade" : "map",
	);
}

/**
 * One `mcp.json` server, in this build's shape or nothing plus why.
 *
 * `transport` is the discriminator, with kimi's own preprocessing behind it: an
 * entry that names none but has a `command` is stdio and one with a `url` is
 * http. `sse` is a shape this build's client does not speak, and a remote server
 * whose authentication is OAuth — kimi's default for a remote server with no
 * `auth` key — cannot be carried: the client here takes literal headers and
 * expands no variables, so the report has to say the server will need
 * authorising again rather than claim it was copied whole.
 */
function normalizeKimiMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const transport =
		typeof entry.transport === "string"
			? entry.transport
			: typeof entry.command === "string"
				? "stdio"
				: typeof entry.url === "string"
					? "http"
					: "";
	const extras: string[] = [];
	for (const key of ["deferred", "startupTimeoutMs", "toolTimeoutMs", "enabledTools", "disabledTools"]) {
		if (entry[key] !== undefined) extras.push(key);
	}
	if (extras.length > 0) {
		downgrades.push(`kimi's own ${summarizeNames(extras)} setting(s) have no counterpart here`);
	}
	if (transport === "stdio") {
		const command = typeof entry.command === "string" ? entry.command : "";
		if (command === "") return null;
		const out: Record<string, unknown> = {
			type: "stdio",
			command,
			args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [],
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		if (entry.executor !== undefined || entry.runtime_id !== undefined) {
			downgrades.push("it named the executor kimi should launch it on, which has no meaning here");
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	if (transport === "http" || transport === "sse") {
		if (typeof entry.url !== "string" || entry.url.trim() === "") return null;
		if (transport === "sse") {
			downgrades.push("it is an SSE server, and the MCP client here connects over stdio or StreamableHTTP only");
		}
		const out: Record<string, unknown> = { type: "http", url: entry.url };
		if (isRecord(entry.headers)) out.headers = entry.headers;
		if (entry.auth === "oauth" || (entry.auth === undefined && typeof entry.bearerTokenEnvVar !== "string")) {
			downgrades.push(
				"kimi authorises it with OAuth by default, and credentials are neither read nor carried — authorise it again here",
			);
		}
		if (typeof entry.bearerTokenEnvVar === "string") {
			downgrades.push(`its bearer token came from $${entry.bearerTokenEnvVar}, which is not expanded here`);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	return null;
}

/**
 * `config.toml` sections that are neither imported nor worth a line of their own,
 * each with the reason it stays behind.
 *
 * Anything not listed here — and not named by a line of its own — reaches the
 * report through {@link reportUnhandledKeys}, so a key the user set is never
 * simply missing from it.
 */
const KIMI_UNMIGRATED_SECTIONS: Array<[key: string, reason: string]> = [
	[
		"providers",
		"model endpoints and the credentials that go with them, neither of which belongs in this build's settings",
	],
	[
		"thinking",
		"the reasoning effort kimi's own catalogue uses, where this build sets effort per request from its own rows",
	],
	["tools", "a per-tool enable list, which has no switch here"],
	["secondaryModel", "a second model kimi falls back to, where this build takes one"],
	["subagent", "kimi's own subagent limits"],
	["task", "kimi's task-runner settings"],
	["swarm", "kimi's own parallel-agent settings"],
	["background", "kimi's background-job runtime"],
	["cron", "kimi's own scheduler"],
	["loopControl", "kimi's own loop guard"],
	["watch", "file-watching settings for kimi's watcher"],
	["database", "the local store's settings"],
	["image", "image-handling limits"],
	["read", "file-reading limits"],
	["tokenCounting", "kimi's own token estimator"],
	["modelCatalog", "how kimi refreshes its model catalogue from the network"],
	["mergeAllAvailableSkills", "a skill-merging policy with no equivalent here"],
	["builtinProductSkills", "the skills shipped with kimi, not the user's own"],
	["identity", "the account's own identity block"],
	["services", "telemetry and service endpoints"],
	["experimental", "kimi's own feature flags"],
];

/**
 * Kimi's `config.toml`, `mcp.json` and the permission posture.
 *
 * The order of the sections below follows the file, so a reader comparing the
 * report with `config.toml` finds them in the same order.
 */
export function planKimiCode(
	raw: RawKimiCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	claimHooks: ClaimHooks,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const from = tildePath(home, kimiConfigPath(raw.root));
	if (raw.configError !== undefined) {
		items.push({
			source: "kimi-code",
			from,
			to: "—",
			action: "skip",
			detail: `${raw.configError} — nothing in this file was read, so this report is missing whatever it held`,
			containsSecret: false,
		});
	}
	const config = raw.config;

	// ── defaultModel ─────────────────────────────────────────────────────────
	if (config.defaultModel !== undefined) {
		const label = `${from} → defaultModel (${JSON.stringify(config.defaultModel)})`;
		const name = typeof config.defaultModel === "string" ? config.defaultModel.trim() : "";
		const own = name !== "" && isRecord(isRecord(config.models) ? config.models[name] : undefined);
		const resolved = name === "" ? undefined : resolveModel(name)?.id;
		if (name === "") {
			items.push({
				source: "kimi-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a model name",
				containsSecret: false,
			});
		} else if (own) {
			// Named rather than resolved: the table it points into is the user's own,
			// and its rows hold an endpoint and a key this build has nowhere to put.
			items.push({
				source: "kimi-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"this names an entry of your own [models] table, which pairs a provider, an endpoint and a model id — this build " +
					"has no alias table of that kind, and the keys that entry holds are named with the table below rather than guessed at",
				containsSecret: false,
			});
		} else if (resolved !== undefined) {
			claimScalar("kimi-code", "model", resolved, label, `mapped to "${resolved}"`);
		} else {
			items.push({
				source: "kimi-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "no model of that name exists here, so importing it would leave settings.json pointing at nothing",
				containsSecret: false,
			});
		}
	}

	planKimiPermissionMode(raw, home, items, claimScalar);
	planKimiPermissions(raw, home, items);
	planKimiHooks(raw, home, items, claimHooks, existing, force);

	// ── [models] / [providers] ───────────────────────────────────────────────
	// Named by key, never by value: an entry may carry an inline `apiKey`, and the
	// one thing this importer never does is read a credential out of the file that
	// holds it and write it into a second file.
	const models = isRecord(config.models) ? config.models : {};
	const modelNames = Object.keys(models);
	const withKeys = modelNames.filter((name) => isRecord(models[name]) && models[name].apiKey !== undefined);
	if (modelNames.length > 0) {
		items.push({
			source: "kimi-code",
			from: `${from} → models (${summarizeNames(modelNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				`${modelNames.length} model alias(es) of your own, each a provider, an endpoint and a model id — this build has no ` +
				"per-alias table, and " +
				(withKeys.length > 0
					? `${withKeys.length} of them set an apiKey, which was not read: that key is still in config.toml and has to be exported here`
					: "none of them sets an apiKey"),
			containsSecret: false,
		});
	}
	if (config.providers !== undefined) {
		items.push({
			source: "kimi-code",
			from: `${from} → providers`,
			to: "—",
			action: "skip",
			detail: "named provider endpoints, listed with the keys that authenticate them — neither is read or carried",
			containsSecret: false,
		});
	}

	// ── [mcp] ────────────────────────────────────────────────────────────────
	if (isRecord(config.mcp)) {
		const keys = Object.keys(config.mcp);
		if (keys.length > 0) {
			items.push({
				source: "kimi-code",
				from: `${from} → mcp (${summarizeNames(keys, 8)})`,
				to: "—",
				action: "skip",
				detail:
					"connect and tool timeouts for MCP servers as a whole, which this build's client does not take from settings",
				containsSecret: false,
			});
		}
	}

	for (const [key, reason] of KIMI_UNMIGRATED_SECTIONS) {
		if (config[key] === undefined) continue;
		items.push({
			source: "kimi-code",
			from: `${from} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}

	// ── mcp.json ─────────────────────────────────────────────────────────────
	const mcpFrom = tildePath(home, kimiMcpFile(raw.root));
	if (raw.mcpError !== undefined) {
		items.push({
			source: "kimi-code",
			from: mcpFrom,
			to: "—",
			action: "skip",
			detail: `${raw.mcpError} — no server in it was read`,
			containsSecret: false,
		});
	}
	for (const [name, value] of Object.entries(raw.mcp)) {
		const label = `${mcpFrom} → ${name}`;
		if (!isRecord(value)) {
			items.push({
				source: "kimi-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "entry is not a server definition",
				containsSecret: false,
			});
			continue;
		}
		if (value.enabled === false) {
			items.push({
				source: "kimi-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "disabled in kimi — there is no way to keep a server defined and switched off here",
				containsSecret: false,
			});
			continue;
		}
		const normalized = normalizeKimiMcp(value);
		if (normalized === null || !McpServerConfigSchema.safeParse(normalized.config).success) {
			items.push({
				source: "kimi-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "server definition does not match the supported stdio/http shapes",
				containsSecret: false,
			});
			continue;
		}
		if (name in existingMcpServers && !force) {
			items.push({
				source: "kimi-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "target already defines a server with this name — kept (use --force to overwrite)",
				containsSecret: false,
			});
			continue;
		}
		const secret =
			Object.keys(isRecord(normalized.config.headers) ? normalized.config.headers : {}).length > 0 ||
			Object.keys(isRecord(normalized.config.env) ? normalized.config.env : {}).some((key) => looksLikeSecretName(key));
		mcpServers[name] = normalized.config;
		markMcpSecret(secret);
		const copied = secret ? "copied verbatim, including credential headers" : "copied verbatim";
		items.push({
			source: "kimi-code",
			from: label,
			to: `.mcp.json → mcpServers.${name}`,
			action: normalized.downgrades.length > 0 ? "downgrade" : "map",
			detail: normalized.downgrades.length > 0 ? `${copied} — ${normalized.downgrades.join("; ")}` : copied,
			containsSecret: secret,
		});
	}

	reportUnhandledKeys(
		"kimi-code",
		config,
		new Set<string>([
			"defaultModel",
			"defaultPermissionMode",
			"defaultPlanMode",
			"permission",
			"hooks",
			"models",
			"providers",
			"mcp",
			"extraSkillDirs",
			"extraAgentDirs",
			...KIMI_UNMIGRATED_SECTIONS.map(([key]) => key),
		]),
		from,
		items,
	);
}

/** Kimi's assets: `AGENTS.md`, skills, agents, and the trees it reads but does not own. */
export function planKimiAssets(
	raw: RawKimiCode,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	collectFileWrites(
		"kimi-code",
		raw.skills,
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		"kimi-code",
		raw.agents,
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	if (raw.memory?.trim()) {
		// The document kimi always injects, whichever project it runs in — the same
		// standing as `~/.claude/CLAUDE.md` and grok's `AGENTS.md`, so it lands as a
		// rule file that merges with existing memory rather than replacing it.
		planMemoryAsRule(
			"kimi-code",
			tildePath(home, join(raw.root, "AGENTS.md")),
			home,
			raw.memory,
			"imported-kimi-code.md",
			force,
			items,
			writes,
		);
	}
	if (raw.sharedTree.length > 0) {
		items.push({
			source: "kimi-code",
			from: raw.sharedTree.map((relative) => tildePath(home, join(home, relative))).join(", "),
			to: "—",
			action: "skip",
			detail:
				"part of the shared `~/.agents` tree, which kimi reads and so does this build: the `agents` source imports it, " +
				"and taking it here as well would land two copies of every file under kimi's name",
			containsSecret: false,
		});
	}
	for (const [key, dirs] of [
		["extraSkillDirs", raw.projectScopedSkillDirs],
		["extraAgentDirs", raw.projectScopedAgentDirs],
	] as const) {
		if (dirs.length === 0) continue;
		items.push({
			source: "kimi-code",
			from: `${tildePath(home, kimiConfigPath(raw.root))} → ${key} (${dirs.join(", ")})`,
			to: "—",
			action: "skip",
			detail:
				"these entries are relative, so kimi resolved them against the project it was started in — that tree belongs to " +
				"the repository, not to this home, and this run does not read it",
			containsSecret: false,
		});
	}
	for (const [label, dirs] of [
		["extraSkillDirs", raw.extraSkillDirs],
		["extraAgentDirs", raw.extraAgentDirs],
	] as const) {
		if (dirs.length === 0) continue;
		items.push({
			source: "kimi-code",
			from: `${tildePath(home, kimiConfigPath(raw.root))} → ${label} (${dirs
				.map((dir) => tildePath(home, dir))
				.join(", ")})`,
			to: "—",
			action: "map",
			detail: "read from where these point, and anything in them is marked with the setting it came from",
			containsSecret: false,
		});
	}
	if (raw.pluginNames.length > 0) {
		items.push({
			source: "kimi-code",
			from: `${tildePath(home, kimiPluginsDir(raw.root))} (${summarizeNames(raw.pluginNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				`${raw.pluginNames.length} installed plugin(s): their skills and agents ship with the plugin and are updated with ` +
				"it, and this build has no plugin system to track that — the names are here so you can tell what is not",
			containsSecret: false,
		});
	}
	if (raw.credentialEntries.length > 0) {
		items.push({
			source: "kimi-code",
			from: `${tildePath(home, raw.root)}/${raw.credentialEntries.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				"credential-shaped entries reported by name and never opened — no value in them was read, and none is carried",
			containsSecret: false,
		});
	}
	if (raw.legacy !== null) {
		const where =
			raw.legacy.origin === "share-dir"
				? `${raw.legacy.root} (moved there by $KIMI_SHARE_DIR)`
				: tildePath(home, raw.legacy.root);
		const also =
			raw.legacy.skillsRoot === undefined ? "" : `, and ${tildePath(home, raw.legacy.skillsRoot)} for its skills`;
		items.push({
			source: "kimi-code",
			from: where,
			to: "—",
			action: "skip",
			detail: `the tree kimi-cli left behind${also} — a different product's layout, which Kimi Code migrates itself: nothing in it was opened here`,
			containsSecret: false,
		});
	}
	if (raw.otherDirs.length > 0) {
		items.push({
			source: "kimi-code",
			from: raw.otherDirs.map((entry) => `${tildePath(home, join(raw.root, entry.name))} (${entry.count})`).join(", "),
			to: "—",
			action: "skip",
			detail: "no mapping here for these, so they were left where they are",
			containsSecret: false,
		});
	}
}
