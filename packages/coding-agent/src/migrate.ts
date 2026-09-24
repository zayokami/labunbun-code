/**
 * Import an existing agent-tool setup into labunbun's own configuration.
 *
 * Recognised source layouts, all user-scope only:
 *   claude-code  ~/.claude/settings.json, ~/.claude.json, ~/.claude/skills,
 *                ~/.claude/rules
 *   codex        $CODEX_HOME when set, else ~/.codex — config.toml, AGENTS.md
 *                (AGENTS.override.md first when both are there), skills, agents,
 *                prompts, rules, sessions and archived_sessions, history.jsonl
 *   zcode        ~/.zcode/v2/config.json, ~/.zcode/cli/config.json,
 *                ~/.zcode/cli/db/db.sqlite, ~/.zcode/AGENTS.md, ~/.zcode/skills
 *   agents       ~/.agents/AGENTS.md, ~/.agents/skills, ~/.agents/agents
 *   deepseek-harness $DSH_HOME when set, else ~/.dsh — settings.yaml, AGENTS.md,
 *                skills, cordis patches declaring MCP servers, .agent-presets,
 *                sessions
 *   grok-build   $GROK_HOME when set, else ~/.grok — config.toml (models, MCP
 *                servers, permission rules), AGENTS.md, rules, skills, commands,
 *                agents, plugins, memory, sessions
 *   kimi-code    $KIMI_CODE_HOME when set, else ~/.kimi-code — config.toml
 *                (permissions, hooks, models), mcp.json, AGENTS.md, skills,
 *                agents, plugins, sessions, user-history
 *   minimax-code $MINIMAX_DATA_DIR, else $MAVIS_DATA_DIR, else ~/.minimax —
 *                config.yaml, permission.json, mcp.json, AGENTS.md, skills,
 *                agents, plans, v2/sessions
 *
 * Structure: read (I/O) → plan (pure) → apply (I/O). The planning step is where
 * every mapping decision lives, so the decisions are testable without touching
 * a real home directory, and `--apply` has nothing to decide.
 *
 * Two invariants hold throughout:
 * - Sources are read, never written. A migration cannot damage the setup it is
 *   importing from, so re-running it is always safe.
 * - Nothing is written without `apply: true`. The default run reports what it
 *   would do and returns.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRuleText } from "@labunbun/agent";
import type { RawAgents } from "./agents-read.ts";
import { readAgents } from "./agents-read.ts";
import { planClaudeCode } from "./claude-plan.ts";
import type { RawClaudeCode } from "./claude-read.ts";
import { readClaudeCode } from "./claude-read.ts";
import { planCodex, planCodexRules } from "./codex-plan.ts";
import type { RawCodex } from "./codex-read.ts";
import { readCodex } from "./codex-read.ts";
import { planDeepSeekAssets, planDeepSeekHarness } from "./dsh-plan.ts";
import type { RawDeepSeekHarness } from "./dsh-read.ts";
import { readDeepSeekHarness } from "./dsh-read.ts";
import { planGrokAssets, planGrokBuild, planGrokPermissions } from "./grok-plan.ts";
import type { RawGrokBuild } from "./grok-read.ts";
import { readGrokBuild } from "./grok-read.ts";
import { historyFilePath, readHistoryFile } from "./history.ts";
import { planKimiAssets, planKimiCode } from "./kimi-plan.ts";
import type { RawKimiCode } from "./kimi-read.ts";
import { readKimiCode } from "./kimi-read.ts";
import {
	collectFileWrites,
	planAssetTrees,
	planCommands,
	planMemoryAsRule,
	readJson,
	tildePath,
} from "./migrate-core.ts";
import {
	collectHistory,
	DEFAULT_HISTORY_LIMIT,
	DEFAULT_PROMPT_HISTORY_LIMIT,
	type HistoryImport,
	type HistoryScope,
	historyPath,
	type PromptEntry,
	type PromptHistoryImport,
	parseHistoryScope,
	promptKey,
	readPromptHistory,
	renderHistorySession,
} from "./migrate-history.ts";
import type {
	ClaimableScalarKey,
	ClaimedScalarValue,
	ClaimHooks,
	MigrationAction,
	MigrationCategory,
	MigrationItem,
	MigrationPlan,
	MigrationSourceId,
	NormalizedHookEntry,
	PlannedWrite,
} from "./migrate-types.ts";
import {
	detectSources,
	looksLikeSecretName,
	MIGRATION_CATEGORIES,
	MIGRATION_SOURCE_IDS,
	MIGRATION_SOURCE_LABELS,
	targetMcpPath,
	targetSettingsPath,
} from "./migrate-types.ts";
import { planMinimaxAssets, planMinimaxCode } from "./minimax-plan.ts";
import type { RawMinimaxCode } from "./minimax-read.ts";
import { readMinimaxCode } from "./minimax-read.ts";
import { mergeSettings, type RawSettingsInput } from "./settings.ts";
import { planStepAssets, planStepCode } from "./step-plan.ts";
import type { RawStepCode } from "./step-read.ts";
import { readStepCode } from "./step-read.ts";
import { planZcode, planZcodeAssets } from "./zcode-plan.ts";
import type { RawZcode } from "./zcode-read.ts";
import { readZcode } from "./zcode-read.ts";

export interface RawSources {
	home: string;
	claudeCode: RawClaudeCode;
	codex: RawCodex;
	zcode: RawZcode;
	agents: RawAgents;
	deepseekHarness: RawDeepSeekHarness;
	grokBuild: RawGrokBuild;
	kimiCode: RawKimiCode;
	minimaxCode: RawMinimaxCode;
	stepCode: RawStepCode;
}

export function readSources(home: string): RawSources {
	return {
		home,
		claudeCode: readClaudeCode(home),
		codex: readCodex(home),
		zcode: readZcode(home),
		agents: readAgents(home),
		deepseekHarness: readDeepSeekHarness(home),
		grokBuild: readGrokBuild(home),
		kimiCode: readKimiCode(home),
		minimaxCode: readMinimaxCode(home),
		stepCode: readStepCode(home),
	};
}

export interface PlanOptions {
	/** Which sources to consider; defaults to all detected. */
	only?: MigrationSourceId[];
	/** Overwrite values and files that already exist at the target. */
	force?: boolean;
	/** Which categories to carry over; defaults to all three. */
	categories?: MigrationCategory[];
	/** Most sessions to import per source. */
	historyLimit?: number;
	/**
	 * Converted sessions per source, produced by the reading phase. Planning
	 * itself never opens a transcript: the conversations are the one input too
	 * expensive to redo, so they are read once and handed over.
	 */
	history?: HistoryImport;
	/**
	 * Prompts to merge into `~/.labunbun/history.jsonl`, produced by the reading
	 * phase for the same reason the sessions are: the target is read during
	 * planning, the sources are not.
	 */
	promptHistory?: PromptHistoryImport;
	/** Why `history` is empty, when the user turned history import off. */
	historyScope?: HistoryScope;
}

export { DEFAULT_HISTORY_LIMIT };

/**
 * Decide everything the migration would do.
 *
 * `existing` is the current user-scope settings — needed because conflicts
 * default to keeping the value already there. Without it the importer would
 * silently overwrite configuration the user set up deliberately.
 */
export function planMigration(raw: RawSources, existing: RawSettingsInput, options: PlanOptions = {}): MigrationPlan {
	const only = options.only ?? detectSources(raw.home);
	const force = options.force === true;
	const categories = options.categories ?? [...MIGRATION_CATEGORIES];
	const wants = (category: MigrationCategory): boolean => categories.includes(category);
	const items: MigrationItem[] = [];
	const writes: PlannedWrite[] = [];

	// An explicit filter is a decision the user made, so the report states what
	// it left out. A shorter list with no explanation reads as a bug — the same
	// reason every skip carries its own `detail`.
	if (options.categories !== undefined) {
		for (const category of MIGRATION_CATEGORIES) {
			if (wants(category) || only.length === 0) continue;
			items.push({
				source: only[0],
				from: `every source → ${category}`,
				to: "—",
				action: "skip",
				detail: "excluded by the category filter — nothing from this category was imported",
				containsSecret: false,
			});
		}
	}

	// Settings accumulated across sources, applied as one merge at the end.
	const settingsPatch: Record<string, unknown> = {};
	const env: Record<string, string> = {};
	const mcpServers: Record<string, unknown> = {};
	let mcpHasSecret = false;

	// The MCP config is a separate file from settings, so it gets its own read:
	// the file is rewritten whole, and without the current contents an import
	// would drop every server the user had configured themselves.
	const existingMcp = readJson(targetMcpPath(raw.home));
	const existingMcpServers =
		typeof existingMcp.mcpServers === "object" &&
		existingMcp.mcpServers !== null &&
		!Array.isArray(existingMcp.mcpServers)
			? (existingMcp.mcpServers as Record<string, unknown>)
			: {};

	/** Claim a scalar settings key, respecting an existing value unless forced. */
	const claimScalar = (
		source: MigrationSourceId,
		key: ClaimableScalarKey,
		value: ClaimedScalarValue,
		from: string,
		detail: string,
	): void => {
		const current = (existing as Record<string, unknown>)[key];
		if (current !== undefined && !force) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				// `JSON.stringify` quotes strings and renders lists and booleans as
				// they would appear in the file — the user is being told what their
				// own settings hold, so it should read like their settings.
				detail: `target already sets ${key} to ${JSON.stringify(current)} — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			return;
		}
		settingsPatch[key] = value;
		items.push({ source, from, to: `settings.json → ${key}`, action: "map", detail, containsSecret: false });
	};

	/**
	 * Permission rules claimed across sources, written once at the end.
	 *
	 * Two sources can each have decided something about what may run unasked, and
	 * a later source must add to what an earlier one claimed rather than replace
	 * it — a rules list that silently loses half its entries is worse than one
	 * that was never imported.
	 */
	const permissionRules: { allow: string[]; deny: string[]; additionalDirectories: string[] } = {
		allow: [],
		deny: [],
		additionalDirectories: [],
	};
	let permissionsTouched = false;

	/** Claim a whole permission list, respecting an existing one unless forced. */
	const claimPermissionList = (
		source: MigrationSourceId,
		behavior: "allow" | "deny" | "additionalDirectories",
		rules: string[],
		from: string,
		detail: string,
		action: MigrationAction = "map",
	): void => {
		// A rule the target cannot parse is not a rule. Dropping it in silence is
		// how a deny rule disappears from a migration report.
		const unique = [...new Set(rules)];
		const usable =
			behavior === "additionalDirectories" ? unique : unique.filter((rule) => parseRuleText(rule) !== null);
		if (usable.length < rules.length) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `${rules.length - usable.length} of ${rules.length} rule(s) are not in the \`Tool(specifier)\` form this build parses — written by hand would mean written to no effect`,
				containsSecret: false,
			});
		}
		if (usable.length === 0) return;
		const current = existing.permissions?.[behavior];
		// An empty list at the target is not a decision to protect: nothing is
		// lost by filling it in.
		if (current !== undefined && current.length > 0 && !force) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `target already defines permissions.${behavior} — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			return;
		}
		// Union, not assignment: the object above exists so that a later source
		// adds to what an earlier one claimed, and a second claimant replacing the
		// list would drop the first source's rules while its report item still said
		// they were written.
		permissionRules[behavior] = [...new Set([...permissionRules[behavior], ...usable])];
		permissionsTouched = true;
		items.push({
			source,
			from,
			to: `settings.json → permissions.${behavior}`,
			action,
			detail,
			containsSecret: false,
		});
	};

	/**
	 * Hooks claimed across sources, written once at the end.
	 *
	 * A hook is keyed by event, and two sources holding a `Stop` hook each are
	 * describing one configuration rather than two rival ones. This exists
	 * because writing the key from each source meant the last one reached erased
	 * the first while both report lines still said their hooks were written.
	 */
	const hookConfig: Record<string, NormalizedHookEntry[]> = {};
	let hooksTouched = false;
	// Whether `--force` claimed to replace the target's hooks rather than add to
	// them. The write is a recursive merge, so a forced `hooks` comes back with
	// the target's own events folded into it unless it is assigned after the
	// merge — see the write below.
	let hooksReplaced = false;

	/**
	 * Claim a whole hook config. The caller has already established that the
	 * target has none (or that `--force` says so); what happens here is the union.
	 */
	const claimHooks: ClaimHooks = (source, config, from, detail, action = "map") => {
		for (const [event, entries] of Object.entries(config)) {
			hookConfig[event] = [...(hookConfig[event] ?? []), ...entries];
		}
		hooksTouched = true;
		items.push({ source, from, to: "settings.json → hooks", action, detail, containsSecret: false });
	};

	/** Add rules beside whatever is already claimed. Adding a rule never removes one. */
	const addPermissionRules = (
		source: MigrationSourceId,
		behavior: "allow" | "deny",
		rules: string[],
		from: string,
		caveat: string,
	): void => {
		const present = new Set([...(existing.permissions?.[behavior] ?? []), ...permissionRules[behavior]]);
		const unique = [...new Set(rules)];
		const added = unique.filter((rule) => !present.has(rule));
		if (added.length === 0) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `${unique.length === 1 ? "the rule is" : `all ${unique.length} rules are`} already defined here — nothing to add`,
				containsSecret: false,
			});
			return;
		}
		// The accumulator holds the whole list this migration would leave behind,
		// not just the new part: it is written as one value at the end, and a list
		// missing the user's own rules would drop them on the way through.
		permissionRules[behavior] = [
			...new Set([...(existing.permissions?.[behavior] ?? []), ...permissionRules[behavior], ...added]),
		];
		permissionsTouched = true;
		const already = unique.length - added.length;
		items.push({
			source,
			from,
			to: `settings.json → permissions.${behavior}`,
			action: "map",
			detail:
				`${added.length} rule(s) added${already > 0 ? `, ${already} already present` : ""}; ${caveat}` +
				" — review them with /permissions",
			containsSecret: false,
		});
	};

	/** Claim one env var, respecting an existing value unless forced. */
	const claimEnv = (source: MigrationSourceId, name: string, value: string, from: string): void => {
		const current = existing.env?.[name];
		const secret = looksLikeSecretName(name);
		if (current !== undefined && current !== value && !force) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `target already sets env.${name} — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			return;
		}
		// Later sources win among themselves; first-wins would make the outcome
		// depend on source ordering in a way the report doesn't show.
		env[name] = value;
		items.push({
			source,
			from,
			to: `settings.json → env.${name}`,
			action: "map",
			detail: secret ? "credential copied verbatim" : "copied verbatim",
			containsSecret: secret,
		});
	};

	if (only.includes("claude-code") && raw.claudeCode.present) {
		if (wants("settings")) {
			planClaudeCode(
				raw.claudeCode,
				items,
				claimEnv,
				claimScalar,
				claimPermissionList,
				claimHooks,
				mcpServers,
				(hasSecret) => {
					mcpHasSecret = mcpHasSecret || hasSecret;
				},
				existing,
				existingMcpServers,
				force,
			);
		}
		if (wants("assets")) {
			collectFileWrites(
				"claude-code",
				raw.claudeCode.skills,
				(name) => join(raw.home, ".labunbun", "skills", name, "SKILL.md"),
				"skill",
				force,
				items,
				writes,
				raw.home,
			);
			collectFileWrites(
				"claude-code",
				raw.claudeCode.rules,
				(name) => join(raw.home, ".labunbun", "rules", name),
				"rule",
				force,
				items,
				writes,
				raw.home,
			);
			collectFileWrites(
				"claude-code",
				raw.claudeCode.agents,
				(name) => join(raw.home, ".labunbun", "agents", name),
				"agent",
				force,
				items,
				writes,
				raw.home,
			);
			planCommands("claude-code", raw.claudeCode.commands, "~/.claude/commands", raw.home, force, items, writes);
			// The user's global memory document. Every other source that has one
			// imports it; this source did not, which left the most widely used
			// instructions of the six on disk with the report saying nothing at all.
			if (raw.claudeCode.memory?.trim()) {
				planMemoryAsRule(
					"claude-code",
					"~/.claude/CLAUDE.md",
					raw.home,
					raw.claudeCode.memory,
					"imported-claude-code.md",
					force,
					items,
					writes,
				);
			}
		}
	}

	if (only.includes("codex") && raw.codex.present) {
		/**
		 * A path under the resolved Codex home, rendered the way the report renders
		 * paths. `$CODEX_HOME` can put the tree anywhere, and a label that said
		 * `~/.codex/config.toml` for a tree that is not there would point the user at
		 * a file nobody read — the reason the grok source renders its paths the same
		 * way.
		 */
		const codexAt = (name: string): string => tildePath(raw.home, join(raw.codex.root, name));
		if (wants("settings")) {
			planCodex(
				raw.codex,
				codexAt,
				items,
				claimScalar,
				mcpServers,
				(hasSecret) => {
					mcpHasSecret = mcpHasSecret || hasSecret;
				},
				settingsPatch,
				existing,
				existingMcpServers,
				force,
			);
			planCodexRules(raw.codex, codexAt, items, addPermissionRules);
		}
		if (wants("assets")) {
			collectFileWrites(
				"codex",
				raw.codex.skills,
				(name) => join(raw.home, ".labunbun", "skills", name, "SKILL.md"),
				"skill",
				force,
				items,
				writes,
				raw.home,
			);
			collectFileWrites(
				"codex",
				raw.codex.agents,
				(name) => join(raw.home, ".labunbun", "agents", name),
				"agent",
				force,
				items,
				writes,
				raw.home,
			);
			planCommands("codex", raw.codex.prompts, codexAt("prompts"), raw.home, force, items, writes);
			if (raw.codex.memory?.trim()) {
				planMemoryAsRule(
					"codex",
					codexAt(raw.codex.memoryFile ?? "AGENTS.md"),
					raw.home,
					raw.codex.memory,
					"imported-codex.md",
					force,
					items,
					writes,
				);
			}
			if (raw.codex.memoryShadowed !== null) {
				// Codex reads one of the two names and the other is not in force. A user
				// who wrote both is about to keep the one they believed was overridden —
				// or to lose the one they forgot was being read.
				items.push({
					source: "codex",
					from: codexAt(raw.codex.memoryShadowed),
					to: "—",
					action: "skip",
					detail: `Codex reads ${raw.codex.memoryFile} and not this file, so its instructions are not the ones in force — the one that is was imported`,
					containsSecret: false,
				});
			}
		}
	}

	if (only.includes("zcode") && raw.zcode.present) {
		if (wants("settings")) {
			planZcode(
				raw.zcode,
				items,
				claimEnv,
				claimPermissionList,
				claimScalar,
				claimHooks,
				mcpServers,
				(hasSecret) => {
					mcpHasSecret = mcpHasSecret || hasSecret;
				},
				settingsPatch,
				existing,
				existingMcpServers,
				force,
			);
		}
		if (wants("assets")) {
			planZcodeAssets(raw.zcode, raw.home, force, items, writes);
		}
	}

	if (only.includes("agents") && raw.agents.present) {
		if (wants("assets")) planAssetTrees("agents", raw.agents, raw.home, force, items, writes);
	}

	if (only.includes("deepseek-harness") && raw.deepseekHarness.present) {
		if (wants("settings")) {
			planDeepSeekHarness(
				raw.deepseekHarness,
				raw.home,
				items,
				claimScalar,
				mcpServers,
				(hasSecret) => {
					mcpHasSecret = mcpHasSecret || hasSecret;
				},
				settingsPatch,
				existing,
				existingMcpServers,
				force,
			);
		}
		if (wants("assets")) planDeepSeekAssets(raw.deepseekHarness, raw.home, force, items, writes);
	}

	if (only.includes("grok-build") && raw.grokBuild.present) {
		if (wants("settings")) {
			planGrokBuild(
				raw.grokBuild,
				raw.home,
				items,
				claimScalar,
				mcpServers,
				(hasSecret) => {
					mcpHasSecret = mcpHasSecret || hasSecret;
				},
				settingsPatch,
				existing,
				existingMcpServers,
				force,
			);
			planGrokPermissions(raw.grokBuild, raw.home, items, addPermissionRules);
		}
		if (wants("assets")) planGrokAssets(raw.grokBuild, raw.home, force, items, writes);
	}

	if (only.includes("kimi-code") && raw.kimiCode.present) {
		if (wants("settings")) {
			planKimiCode(
				raw.kimiCode,
				raw.home,
				items,
				claimScalar,
				claimHooks,
				mcpServers,
				(hasSecret) => {
					mcpHasSecret = mcpHasSecret || hasSecret;
				},
				existing,
				existingMcpServers,
				force,
			);
		}
		if (wants("assets")) planKimiAssets(raw.kimiCode, raw.home, force, items, writes);
	}

	if (only.includes("minimax-code") && raw.minimaxCode.present) {
		if (wants("settings")) {
			planMinimaxCode(
				raw.minimaxCode,
				raw.home,
				items,
				claimScalar,
				mcpServers,
				(hasSecret) => {
					mcpHasSecret = mcpHasSecret || hasSecret;
				},
				settingsPatch,
				existing,
				existingMcpServers,
				force,
				addPermissionRules,
			);
		}
		if (wants("assets")) planMinimaxAssets(raw.minimaxCode, raw.home, force, items, writes);
	}

	if (only.includes("step-code") && raw.stepCode.present) {
		if (wants("settings")) {
			planStepCode(
				raw.stepCode,
				raw.home,
				items,
				claimScalar,
				mcpServers,
				(hasSecret) => {
					mcpHasSecret = mcpHasSecret || hasSecret;
				},
				settingsPatch,
				existing,
				existingMcpServers,
				force,
			);
		}
		if (wants("assets")) planStepAssets(raw.stepCode, raw.home, force, items, writes);
	}

	if (options.historyScope === "none" && wants("history")) {
		items.push({
			source: only[0] ?? "claude-code",
			from: "every source → history",
			to: "—",
			action: "skip",
			detail: "history import is off (--history-scope none) — no session was read",
			containsSecret: false,
		});
	}
	if (wants("history") && options.history) {
		planHistory(raw.home, options.history, only, items, writes, force);
	}
	if (wants("history") && options.promptHistory && options.historyScope !== "none") {
		planPromptHistory(raw.home, options.promptHistory, only, items, writes);
	}

	if (Object.keys(env).length > 0) settingsPatch.env = env;

	// Permission rules are written once, from every source that contributed. The
	// lists the target already had are carried in as well, so this cannot drop a
	// rule through a shallow merge whatever the claimed lists happen to hold.
	if (permissionsTouched) {
		const merged = {
			allow: [...(existing.permissions?.allow ?? [])],
			deny: [...(existing.permissions?.deny ?? [])],
			additionalDirectories: [...(existing.permissions?.additionalDirectories ?? [])],
		};
		for (const behavior of ["allow", "deny", "additionalDirectories"] as const) {
			if (permissionRules[behavior].length > 0) merged[behavior] = permissionRules[behavior];
		}
		settingsPatch.permissions = merged;
	}

	// Hooks, for the same reason: written once from every source that claimed
	// some. `--force` replaces the target's outright; without it a source that
	// found hooks already there never claimed, so there is nothing to merge and
	// the existing ones are carried in only so the recursive merge below cannot
	// drop one through a shallow overwrite.
	if (hooksTouched) {
		const targetHooks = (existing.hooks as Record<string, NormalizedHookEntry[]> | undefined) ?? {};
		settingsPatch.hooks = force ? hookConfig : { ...targetHooks, ...hookConfig };
		hooksReplaced = force;
	}

	if (Object.keys(settingsPatch).length > 0) {
		const merged = mergeSettings(existing as Record<string, unknown>, settingsPatch) as Record<string, unknown>;
		// `--force` has to mean one thing for the whole key. `mergeSettings` merges
		// objects key by key, so a forced `hooks` would keep every event the target
		// already had and the skip line that told the user to run `--force` would be
		// describing a merge. Assigning it after the merge is what makes the flag
		// do what it says, and it touches nothing else: only the forced case, only
		// this key.
		if (hooksReplaced) merged.hooks = hookConfig;
		writes.push({
			path: targetSettingsPath(raw.home),
			kind: "settings",
			content: `${JSON.stringify(merged, null, "\t")}\n`,
			containsSecret: Object.keys(env).some(looksLikeSecretName),
		});
	}

	if (Object.keys(mcpServers).length > 0) {
		writes.push({
			path: targetMcpPath(raw.home),
			kind: "mcp",
			// Merged with what's already on disk — imported servers are added
			// alongside the user's own rather than replacing the file.
			content: `${JSON.stringify({ mcpServers: { ...existingMcpServers, ...mcpServers } }, null, "\t")}\n`,
			containsSecret: mcpHasSecret,
		});
	}

	return { home: raw.home, sources: only, categories, items, writes };
}

/**
 * Merge imported prompts into `~/.labunbun/history.jsonl`.
 *
 * Targets are read, not written, everywhere else in this file; this is the one
 * path that rewrites a file the user is also writing to, since ↑ recall appends
 * to it as they type. So the merge is a single whole-file write, the imported
 * prompts go *before* the existing ones — the newest entries are what ↑ offers
 * first, and those should be the ones typed here — and an entry already in the
 * file is never written again. That last rule is also what makes a second run
 * write nothing at all.
 *
 * There is no `--force`: the file is merged, never replaced, and the only thing
 * forcing could do is duplicate prompts the user already has.
 */
function planPromptHistory(
	home: string,
	promptHistory: PromptHistoryImport,
	only: MigrationSourceId[],
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	const existing = readHistoryFile(home);
	// Keyed by prompt *and* directory: recall is filtered by project, so a prompt
	// typed in two projects is two entries, and the target may hold it in either.
	const seen = new Set(existing.entries.map((entry) => promptKey(entry.text, entry.cwd)));
	const accepted: PromptEntry[] = [];
	for (const source of only) {
		const input = promptHistory[source];
		if (!input) continue;
		const from = `${MIGRATION_SOURCE_LABELS[source]} prompt history`;
		// A source with no list at all says so; one with an empty list stays quiet.
		if (input.absent !== undefined) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: input.absent,
				containsSecret: false,
			});
			continue;
		}
		if (input.seen === 0) continue;
		let taken = 0;
		let already = 0;
		for (const entry of input.entries) {
			const key = promptKey(entry.text, entry.cwd);
			if (seen.has(key)) {
				already += 1;
				continue;
			}
			seen.add(key);
			accepted.push(entry);
			taken += 1;
		}
		const loss = input.truncated
			? "; the source file is larger than this reads, so only its newest end was considered"
			: "";
		if (taken > 0) {
			items.push({
				source,
				from,
				to: tildePath(home, historyFilePath(home)),
				action: "map",
				detail:
					`${taken} prompt(s) added to the recall history${already > 0 ? `, ${already} already there` : ""}` +
					` — ↑ offers them in the directory each was typed in${loss}`,
				containsSecret: false,
			});
		} else if (already > 0) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `${already} prompt(s) already in the recall history — nothing to add`,
				containsSecret: false,
			});
		}
		for (const note of input.notes) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `${note.reason} — ${note.count} not imported`,
				containsSecret: false,
			});
		}
		if (input.overLimit > 0) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `${input.overLimit} older prompt(s) beyond the newest ones imported — the recall list is not a transcript`,
				containsSecret: false,
			});
		}
	}
	if (accepted.length === 0) return;
	accepted.sort((a, b) => a.timestamp - b.timestamp);
	// Imported lines first, then the file's own lines exactly as they were.
	const merged = [...accepted.map((entry) => JSON.stringify(entry)), ...existing.lines].join("\n");
	writes.push({
		path: historyFilePath(home),
		kind: "prompt-history",
		content: `${merged}\n`,
		containsSecret: false,
	});
}

/**
 * Turn converted sessions into plans and their skips into items.
 *
 * The target id is derived from the source id, so importing a session twice
 * names the same file and the second run reports "already imported" instead of
 * writing a duplicate conversation. That check is a `statSync` on the *target*,
 * which is the one directory this function is allowed to look at.
 */
function planHistory(
	home: string,
	history: HistoryImport,
	only: MigrationSourceId[],
	items: MigrationItem[],
	writes: PlannedWrite[],
	force: boolean,
): void {
	for (const source of only) {
		const input = history[source];
		if (!input) continue;
		const label = MIGRATION_SOURCE_LABELS[source];
		for (const session of input.sessions) {
			const path = historyPath(session, home);
			// A session the source had filed away says so in the label rather than in
			// a footnote: the transcript is the same kind of thing either way, but a
			// reader who archived it there may well have forgotten it exists, and the
			// report is where they find out it came across too.
			const from = `${label} session ${session.sourceId}${session.title ? ` — ${session.title}` : ""}${
				session.archived ? " (archived)" : ""
			}`;
			if (writes.some((write) => write.path === path) || (existsSync(path) && !force)) {
				items.push({
					source,
					from,
					to: "—",
					action: "skip",
					detail: "already imported — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			writes.push({ path, kind: "history", content: renderHistorySession(session), containsSecret: false });
			items.push({
				source,
				from,
				to: tildePath(home, path),
				action: "map",
				detail: `transcript with ${session.entries.length} entries — resumable with --continue${
					session.archived ? "; the source had archived it, and this build keeps every session in one place" : ""
				}`,
				containsSecret: false,
			});
		}
		for (const note of input.notes) {
			items.push({
				source,
				from: `${label} history`,
				to: "—",
				action: "skip",
				detail: `${note.reason} — ${note.count} turned away`,
				containsSecret: false,
			});
		}
		if (input.overLimit > 0) {
			items.push({
				source,
				from: `${label} history`,
				to: "—",
				action: "skip",
				detail: `${input.overLimit} more session(s) matched but exceeded the limit — raise --history-limit to take them`,
				containsSecret: false,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface AppliedResult {
	written: string[];
	failed: Array<{ path: string; error: string }>;
}

/**
 * Perform the plan's writes. Only reached when the caller passed `--apply`;
 * every decision was already made during planning.
 */
export function applyMigration(plan: MigrationPlan): AppliedResult {
	const written: string[] = [];
	const failed: Array<{ path: string; error: string }> = [];
	for (const write of plan.writes) {
		try {
			mkdirSync(join(write.path, ".."), { recursive: true });
			writeFileSync(write.path, write.content, "utf8");
			written.push(write.path);
		} catch (error) {
			failed.push({ path: write.path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { written, failed };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ACTION_ICON: Record<MigrationAction, string> = { map: "✓", downgrade: "!", skip: "·" };

/**
 * Render the plan for a human to check before committing to it.
 *
 * Grouped by source so the output lines up with the files the user recognises,
 * and closing with the credential-bearing targets: the values are copied
 * verbatim by design, so the user should know which files now hold them.
 */
export function formatMigrationReport(plan: MigrationPlan, applied?: AppliedResult): string {
	const lines: string[] = [];

	if (plan.sources.length === 0) {
		return "No source configuration found. Nothing to import.";
	}
	if (plan.items.length === 0) {
		return `Found ${plan.sources.join(", ")} but nothing migratable in it.`;
	}

	for (const source of plan.sources) {
		const items = plan.items.filter((item) => item.source === source);
		if (items.length === 0) continue;
		lines.push(`${source}:`);
		for (const item of items) {
			const arrow = item.action === "skip" ? "" : ` → ${item.to}`;
			lines.push(`  ${ACTION_ICON[item.action]} ${item.from}${arrow}`);
			lines.push(`      ${item.detail}`);
		}
		lines.push("");
	}

	const counts = {
		map: plan.items.filter((i) => i.action === "map").length,
		downgrade: plan.items.filter((i) => i.action === "downgrade").length,
		skip: plan.items.filter((i) => i.action === "skip").length,
	};
	lines.push(`${counts.map} mapped, ${counts.downgrade} downgraded, ${counts.skip} skipped.`);

	if (applied) {
		lines.push("");
		lines.push(applied.written.length > 0 ? `Wrote ${applied.written.length} file(s):` : "No files written.");
		for (const path of applied.written) lines.push(`  ${tildePath(plan.home, path)}`);
		for (const failure of applied.failed) {
			lines.push(`  ✗ ${tildePath(plan.home, failure.path)}: ${failure.error}`);
		}
	} else {
		lines.push("");
		lines.push(
			plan.writes.length > 0
				? `Dry run — nothing written. ${plan.writes.length} file(s) would change:`
				: "Dry run — nothing to write.",
		);
		for (const write of plan.writes) lines.push(`  ${tildePath(plan.home, write.path)}`);
		if (plan.writes.length > 0) lines.push("Re-run with --apply to write these files.");
	}

	const secretPaths = plan.writes.filter((w) => w.containsSecret).map((w) => tildePath(plan.home, w.path));
	if (secretPaths.length > 0) {
		lines.push("");
		lines.push(
			`Credentials are copied verbatim. ${applied ? "These files now contain" : "These files would contain"} secrets:`,
		);
		for (const path of secretPaths) lines.push(`  ${path}`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point shared by the CLI subcommand and the REPL command
// ---------------------------------------------------------------------------

export interface RunMigrationOptions {
	from?: string;
	apply?: boolean;
	force?: boolean;
	home?: string;
	/** Existing user-scope settings; read from disk when omitted. */
	existing?: RawSettingsInput;
	/**
	 * Raw `--only` value, or a list the wizard already decided on. Accepting both
	 * keeps validation in one place: the CLI passes its string straight through,
	 * so `--only settings` and the picker produce the same plan.
	 */
	only?: string | MigrationCategory[];
	/** Raw `--history-limit` value; the CLI passes its string through. */
	historyLimit?: string | number;
	/** Prompts to merge into the recall list; read from the sources when absent. */
	promptHistory?: PromptHistoryImport;
	/** Raw `--history-scope` value; defaults to the current project only. */
	historyScope?: string;
	/**
	 * Source session ids the wizard picked, when it asked the user to choose.
	 * Absent means "take the newest `historyLimit` per source", which is what the
	 * non-interactive form does.
	 */
	historySelected?: string[];
	/**
	 * Sessions the caller already converted, so a wizard that listed them does
	 * not pay for a second read. When omitted the runner reads them itself.
	 */
	history?: HistoryImport;
}

export interface RunMigrationResult {
	report: string;
	plan: MigrationPlan;
	applied?: AppliedResult;
	/** Set when the request itself was invalid, e.g. an unknown --from value. */
	error?: string;
}

/** Resolve `--from` to a source list; `undefined`/`all` means every detected source. */
export function parseFromOption(value: string | undefined, home: string): MigrationSourceId[] | { error: string } {
	if (value === undefined || value.trim() === "" || value === "all") return detectSources(home);
	const requested = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const unknown = requested.filter((part) => !MIGRATION_SOURCE_IDS.includes(part as MigrationSourceId));
	if (unknown.length > 0) {
		return {
			error: `Unknown migration source: ${unknown.join(", ")} (expected ${MIGRATION_SOURCE_IDS.join(", ")}, all)`,
		};
	}
	return requested as MigrationSourceId[];
}

/** Resolve `--only` to a category list; `undefined`/`all` means every category. */
export function parseOnlyOption(
	value: string | MigrationCategory[] | undefined,
): MigrationCategory[] | { error: string } {
	if (Array.isArray(value)) return value;
	if (value === undefined || value.trim() === "" || value === "all") return [...MIGRATION_CATEGORIES];
	const requested = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const unknown = requested.filter((part) => !MIGRATION_CATEGORIES.includes(part as MigrationCategory));
	if (unknown.length > 0) {
		return {
			error: `Unknown category: ${unknown.join(", ")} (expected ${MIGRATION_CATEGORIES.join(", ")}, all)`,
		};
	}
	return requested as MigrationCategory[];
}

/** Resolve `--history-limit` to a session count; `undefined` means the default. */
export function parseHistoryLimit(value: string | number | undefined): number | { error: string } {
	if (value === undefined) return DEFAULT_HISTORY_LIMIT;
	const parsed = typeof value === "number" ? value : Number(value.trim());
	// 0 is allowed and means "import no sessions" — a way to ask for a history-free
	// migration without dropping the category from the report.
	if (!Number.isInteger(parsed) || parsed < 0) {
		return { error: `Invalid history limit: ${value} (expected a whole number of sessions, 0 or more)` };
	}
	return parsed;
}

/** Is this source's tree on disk, so that looking for transcripts is worthwhile? */
function historySourcePresent(raw: RawSources, source: MigrationSourceId): boolean {
	if (source === "claude-code") return raw.claudeCode.present;
	if (source === "codex") return raw.codex.present;
	if (source === "zcode") return raw.zcode.present;
	if (source === "deepseek-harness") {
		// The root is there as soon as dsh runs once; what makes looking for
		// transcripts worth the walk is that some exist. The count also carries the
		// answer past the sibling's reader, which reads the same tree.
		return raw.deepseekHarness.present && raw.deepseekHarness.sessionCount > 0;
	}
	// grok is asked the shallower question on purpose. Its prompt history lives
	// under `sessions/` too, so a home whose sessions were all pruned or never
	// finished still has prompts to offer, and requiring a session to exist would
	// drop them in silence — the walk over a home with neither is one `readdir`
	// that fails and returns nothing.
	if (source === "grok-build") return raw.grokBuild.present;

	// Kimi keeps session transcripts and the recall list under the same home, so the
	// same shallow question grok is asked is the right one here too: a home whose
	// sessions were pruned can still hold prompts.
	if (source === "kimi-code") return raw.kimiCode.present;

	// MiniMax asks the shallow question for the same reason as its two neighbours,
	// and one of its own: its sessions live four directories deep under `v2/` and
	// the count that would answer the deep question is guarded behind a database
	// this reader opens read-only, if at all.
	if (source === "minimax-code") return raw.minimaxCode.present;

	// Step's transcripts sit under `<agent dir>/sessions/<cwd bucket>/`, and the
	// buckets are named after directories that may since have been deleted, so
	// the count that would answer the deeper question costs a walk this source
	// has no other reason to make: unlike its three neighbours, Step keeps no
	// prompt list on disk, so there is nothing the walk could rescue.
	if (source === "step-code") return raw.stepCode.present;
	return raw.agents.present;
}

/**
 * Convert every source the run is allowed to touch.
 *
 * Scope `none` returns nothing at all rather than an empty result per source,
 * because "the user said no" and "there was nothing" print differently in the
 * report and only one of them is worth explaining.
 */
function readHistoryFor(
	raw: RawSources,
	only: MigrationSourceId[],
	categories: MigrationCategory[],
	options: { scope: HistoryScope; limit: number; selected?: string[] },
): HistoryImport {
	if (options.scope === "none" || !categories.includes("history")) return {};
	const history: HistoryImport = {};
	for (const source of only) {
		if (!historySourcePresent(raw, source)) continue;
		history[source] = collectHistory(source, raw.home, {
			// Sessions are imported into their *own* project's directory, so the
			// scope compares against the directory the user is running from.
			cwd: process.cwd(),
			scope: options.scope,
			limit: options.limit,
			selected: options.selected,
		});
	}
	return history;
}

/**
 * Read the prompts each source remembers, under the same scope as its sessions.
 *
 * The scope question is asked once per source and means "what of mine should
 * come across" — a user who asked for this project's history did not ask for
 * every prompt they have ever typed, and one who said no to history did not mean
 * "except the recall list".
 */
function readPromptHistoryFor(
	raw: RawSources,
	only: MigrationSourceId[],
	categories: MigrationCategory[],
	options: { scope: HistoryScope; cwd: string },
): PromptHistoryImport {
	if (options.scope === "none" || !categories.includes("history")) return {};
	const prompts: PromptHistoryImport = {};
	for (const source of only) {
		if (!historySourcePresent(raw, source)) continue;
		prompts[source] = readPromptHistory(source, raw.home, {
			cwd: options.cwd,
			scope: options.scope,
			limit: DEFAULT_PROMPT_HISTORY_LIMIT,
		});
	}
	return prompts;
}

export function runMigration(options: RunMigrationOptions = {}): RunMigrationResult {
	const home = options.home ?? homedir();
	const only = parseFromOption(options.from, home);
	if ("error" in only) {
		const plan: MigrationPlan = { home, sources: [], categories: [], items: [], writes: [] };
		return { report: only.error, plan, error: only.error };
	}
	const categories = parseOnlyOption(options.only);
	if ("error" in categories) {
		const plan: MigrationPlan = { home, sources: only, categories: [], items: [], writes: [] };
		return { report: categories.error, plan, error: categories.error };
	}
	const historyLimit = parseHistoryLimit(options.historyLimit);
	if (typeof historyLimit !== "number") {
		const plan: MigrationPlan = { home, sources: only, categories, items: [], writes: [] };
		return { report: historyLimit.error, plan, error: historyLimit.error };
	}
	const historyScope = parseHistoryScope(options.historyScope);
	if (typeof historyScope !== "string") {
		const plan: MigrationPlan = { home, sources: only, categories, items: [], writes: [] };
		return { report: historyScope.error, plan, error: historyScope.error };
	}

	const raw = readSources(home);
	const existing = options.existing ?? (readJson(targetSettingsPath(home)) as RawSettingsInput);
	// Transcripts are read here rather than inside the planner: they are the one
	// input whose reading is expensive, and the planner is meant to be a pure
	// function of what was read.
	const history =
		options.history ??
		readHistoryFor(raw, only, categories, {
			scope: historyScope,
			limit: historyLimit,
			selected: options.historySelected,
		});
	const promptHistory =
		options.promptHistory ?? readPromptHistoryFor(raw, only, categories, { scope: historyScope, cwd: process.cwd() });
	const plan = planMigration(raw, existing, {
		only,
		force: options.force,
		categories,
		historyLimit,
		history,
		promptHistory,
		historyScope,
	});

	if (!options.apply) {
		return { report: formatMigrationReport(plan), plan };
	}
	const applied = applyMigration(plan);
	return { report: formatMigrationReport(plan, applied), plan, applied };
}
export type { RawAgents } from "./agents-read.ts";
export { readAgents } from "./agents-read.ts";
export type { RawClaudeCode } from "./claude-read.ts";
export { readClaudeCode } from "./claude-read.ts";
export type { RawCodex, RawRuleFile } from "./codex-read.ts";
export { readCodex } from "./codex-read.ts";
export type { RawDeepSeekHarness } from "./dsh-read.ts";
export { readDeepSeekHarness } from "./dsh-read.ts";
export type { RawGrokBuild } from "./grok-read.ts";
export { readGrokBuild } from "./grok-read.ts";
export { normalizeKimiHooks } from "./kimi-plan.ts";
export type { RawKimiCode } from "./kimi-read.ts";
export { readKimiCode } from "./kimi-read.ts";
export { ASSUMED_MAX_OUTPUT_TOKENS, normalizeClaudeHooks, requoteNumericKeyPaths } from "./migrate-core.ts";
export type {
	ClaimableScalarKey,
	ClaimedScalarValue,
	MigrationAction,
	MigrationCategory,
	MigrationItem,
	MigrationPlan,
	MigrationSourceId,
	NormalizedHookEntry,
	NormalizedHooks,
	PlannedWrite,
	RawAttachment,
	RawCommands,
	RawFile,
} from "./migrate-types.ts";
// ---------------------------------------------------------------------------
// The migration's public surface
// ---------------------------------------------------------------------------
//
// Everything above lives in the module that owns it. This list is what the rest
// of the codebase imports, so no consumer of `./migrate.ts` had to change.
export {
	categoryOfKind,
	detectSources,
	looksLikeSecretName,
	MIGRATION_CATEGORIES,
	MIGRATION_SOURCE_IDS,
	MIGRATION_SOURCE_LABELS,
	resolveModelReference,
} from "./migrate-types.ts";
export type { MinimaxPermissions, MinimaxRuleDrop, MinimaxRuleDropReason, RawMinimaxCode } from "./minimax-read.ts";
export { readMinimaxCode } from "./minimax-read.ts";
export type { RawStepCode } from "./step-read.ts";
export { readStepCode } from "./step-read.ts";
export type { RawZcode } from "./zcode-read.ts";
export { readZcode } from "./zcode-read.ts";
