/**
 * Import an existing agent-tool setup into labunbun's own configuration.
 *
 * Four source layouts are recognised, all user-scope only:
 *   claude-code  ~/.claude/settings.json, ~/.claude.json, ~/.claude/skills,
 *                ~/.claude/rules
 *   codex        ~/.codex/config.toml, ~/.codex/AGENTS.md, ~/.codex/skills
 *   zcode        ~/.zcode/v2/config.json, ~/.zcode/cli/config.json,
 *                ~/.zcode/cli/db/db.sqlite, ~/.zcode/AGENTS.md, ~/.zcode/skills
 *   agents       ~/.agents/AGENTS.md, ~/.agents/skills, ~/.agents/agents
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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveModel } from "@labunbun/ai";
import { McpServerConfigSchema } from "@labunbun/mcp";
import {
	collectHistory,
	DEFAULT_HISTORY_LIMIT,
	type HistoryImport,
	type HistoryScope,
	historyPath,
	parseHistoryScope,
	renderHistorySession,
} from "./migrate-history.ts";
import { mergeSettings, OpenAICompatibleProviderSchema, type RawSettingsInput, SettingsSchema } from "./settings.ts";
import { parseFrontmatter } from "./subagents.ts";
import { readZcodeSettings, type ZcodeSettingRow } from "./zcode-db.ts";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type MigrationSourceId = "claude-code" | "codex" | "zcode" | "agents";

/**
 * Ordered as the picker and `--from` list them. New sources are appended: the
 * order is what `detectSources` reports, and reordering would silently change
 * which of two sources providing the same file wins.
 */
export const MIGRATION_SOURCE_IDS: MigrationSourceId[] = ["claude-code", "codex", "zcode", "agents"];

/** Display names for the picker; the ids themselves are the CLI switches. */
export const MIGRATION_SOURCE_LABELS: Record<MigrationSourceId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	zcode: "ZCode",
	agents: "~/.agents (shared agent home)",
};

/** Directory that marks a source as present, relative to home. */
const SOURCE_ROOTS: Record<MigrationSourceId, string> = {
	"claude-code": ".claude",
	codex: ".codex",
	zcode: ".zcode",
	agents: ".agents",
};

export function detectSources(home: string): MigrationSourceId[] {
	return MIGRATION_SOURCE_IDS.filter((id) => existsSync(join(home, SOURCE_ROOTS[id])));
}

// ---------------------------------------------------------------------------
// Raw source data
// ---------------------------------------------------------------------------

/** A skill, rule or agent file found in a source tree, carried as content. */
export interface RawFile {
	/** Name used to build the target path: skill directory name, or rule filename. */
	name: string;
	sourcePath: string;
	content: string;
	/** Overrides the report's "copied verbatim" note when the copy has a caveat. */
	detail?: string;
}

export interface RawClaudeCode {
	/** ~/.claude/settings.json */
	settings: Record<string, unknown>;
	/** ~/.claude.json — mostly runtime state; only a few keys are migratable. */
	state: Record<string, unknown>;
	skills: RawFile[];
	rules: RawFile[];
	agents: RawFile[];
	present: boolean;
}

export interface RawCodex {
	/** Parsed ~/.codex/config.toml */
	config: Record<string, unknown>;
	/** ~/.codex/AGENTS.md, when it exists. */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
	present: boolean;
}

export interface RawZcode {
	/** ~/.zcode/v2/config.json — providers. */
	config: Record<string, unknown>;
	/** ~/.zcode/cli/config.json — CLI-side config, where `mcp.servers` lives. */
	cliConfig: Record<string, unknown>;
	/** ~/.zcode/cli/db/db.sqlite; absent when only the desktop app was installed. */
	dbPath: string;
	dbPresent: boolean;
	/** ~/.zcode/AGENTS.md */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
	/** Third-party plugin directories found under plugins/cache — reported, never read. */
	pluginCount: number;
	/** Raw model I/O logs under cli/rollout — counted, never opened (they embed live Authorization headers). */
	rolloutCount: number;
	/**
	 * `local_setting` rows (permission mode, permission ruleset, reasoning level).
	 * Read here rather than in the planner so planning stays free of I/O.
	 */
	settings: ZcodeSettingRow[];
	present: boolean;
}

/** The shared `~/.agents` home some tools read agent/skill definitions from. */
export interface RawAgents {
	/** ~/.agents/AGENTS.md */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
	present: boolean;
}

export interface RawSources {
	home: string;
	claudeCode: RawClaudeCode;
	codex: RawCodex;
	zcode: RawZcode;
	agents: RawAgents;
}

function readJson(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// A malformed source file migrates nothing rather than aborting the run:
		// the other sources are still worth importing.
		return {};
	}
}

function readText(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

/** Skill directories, each contributing its SKILL.md. */
function readSkillDirs(skillsRoot: string): RawFile[] {
	const out: RawFile[] = [];
	try {
		if (!existsSync(skillsRoot)) return out;
		for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(skillsRoot, entry.name, "SKILL.md");
			const content = readText(path);
			if (content !== null) out.push({ name: entry.name, sourcePath: path, content });
		}
	} catch {
		// unreadable skills dir — contributes nothing
	}
	return out;
}

function readMarkdownDir(dir: string): RawFile[] {
	const out: RawFile[] = [];
	try {
		if (!existsSync(dir)) return out;
		for (const name of readdirSync(dir).sort()) {
			if (!name.endsWith(".md")) continue;
			const path = join(dir, name);
			if (!statSync(path).isFile()) continue;
			const content = readText(path);
			if (content !== null) out.push({ name, sourcePath: path, content });
		}
	} catch {
		// unreadable rules dir — contributes nothing
	}
	return out;
}

/**
 * Agent definition files (`agents/*.md`), annotated when the frontmatter asks
 * for a model. The importer copies such a file verbatim, but labunbun runs
 * every subagent on the session's own model, so the note belongs in the report
 * rather than in a silent mismatch between file and behaviour.
 */
function readAgentFiles(dir: string): RawFile[] {
	const files = readMarkdownDir(dir);
	for (const file of files) {
		const { data } = parseFrontmatter(file.content);
		if (data.model) {
			file.detail = `agent copied verbatim; its "model: ${data.model}" frontmatter is not honoured — subagents run on the session model`;
		}
	}
	return files;
}

export function readClaudeCode(home: string): RawClaudeCode {
	const root = join(home, ".claude");
	return {
		settings: readJson(join(root, "settings.json")),
		state: readJson(join(home, ".claude.json")),
		skills: readSkillDirs(join(root, "skills")),
		rules: readMarkdownDir(join(root, "rules")),
		agents: readAgentFiles(join(root, "agents")),
		present: existsSync(root),
	};
}

export function readCodex(home: string): RawCodex {
	const root = join(home, ".codex");
	const configText = readText(join(root, "config.toml"));
	let config: Record<string, unknown> = {};
	if (configText !== null) {
		try {
			const parsed = Bun.TOML.parse(configText);
			if (typeof parsed === "object" && parsed !== null) config = parsed as Record<string, unknown>;
		} catch {
			// unparseable TOML migrates nothing from this source
		}
	}
	return {
		config,
		memory: readText(join(root, "AGENTS.md")),
		skills: readSkillDirs(join(root, "skills")),
		agents: readAgentFiles(join(root, "agents")),
		present: existsSync(root),
	};
}

export function readZcode(home: string): RawZcode {
	const root = join(home, ".zcode");
	const cliRoot = join(root, "cli");
	const dbPath = join(cliRoot, "db", "db.sqlite");
	return {
		config: readJson(join(root, "v2", "config.json")),
		cliConfig: readJson(join(cliRoot, "config.json")),
		dbPath,
		dbPresent: existsSync(dbPath),
		memory: readText(join(root, "AGENTS.md")),
		skills: readSkillDirs(join(root, "skills")),
		agents: readAgentFiles(join(root, "agents")),
		pluginCount: countPluginDirs(cliRoot),
		rolloutCount: countRolloutLogs(cliRoot),
		settings: readZcodeSettings(dbPath),
		present: existsSync(root),
	};
}

export function readAgents(home: string): RawAgents {
	const root = join(home, ".agents");
	return {
		memory: readText(join(root, "AGENTS.md")),
		skills: readSkillDirs(join(root, "skills")),
		agents: readAgentFiles(join(root, "agents")),
		present: existsSync(root),
	};
}

/**
 * Count installed plugins (`<root>/plugins/cache/<marketplace>/<plugin>`) without
 * reading them. Plugin code is third-party content, not the user's own
 * configuration, so the report names the count and stops there.
 */
function countPluginDirs(root: string): number {
	let total = 0;
	try {
		const cache = join(root, "plugins", "cache");
		if (!existsSync(cache)) return 0;
		for (const marketplace of readdirSync(cache, { withFileTypes: true })) {
			if (!marketplace.isDirectory()) continue;
			total += readdirSync(join(cache, marketplace.name), { withFileTypes: true }).filter((entry) =>
				entry.isDirectory(),
			).length;
		}
	} catch {
		// unreadable plugin cache — nothing to report
	}
	return total;
}

/**
 * Count the raw model I/O logs (`<root>/rollout/*.jsonl`) without reading one.
 * Each line records a request and response, `Authorization` header included, so
 * the importer treats them as a source it may name and must not open.
 */
function countRolloutLogs(root: string): number {
	try {
		const dir = join(root, "rollout");
		if (!existsSync(dir)) return 0;
		return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

export function readSources(home: string): RawSources {
	return {
		home,
		claudeCode: readClaudeCode(home),
		codex: readCodex(home),
		zcode: readZcode(home),
		agents: readAgents(home),
	};
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * `map` — carried over as-is.
 * `downgrade` — carried over with a semantic loss, explained in `detail`.
 * `skip` — deliberately not carried over; `detail` says why.
 *
 * Skips are reported rather than dropped silently. A setting that vanishes
 * without explanation reads as a migration bug, and the user cannot tell the
 * difference between "labunbun has no equivalent" and "the importer missed it".
 */
export type MigrationAction = "map" | "downgrade" | "skip";

export interface MigrationItem {
	source: MigrationSourceId;
	/** Human-readable origin, e.g. "~/.claude/settings.json → env.ANTHROPIC_BASE_URL". */
	from: string;
	/** Human-readable destination, or "—" for skips. */
	to: string;
	action: MigrationAction;
	detail: string;
	/** Whether the migrated value is a credential, for the report's secrets notice. */
	containsSecret: boolean;
}

/** File writes the plan would perform, keyed by absolute target path. */
export interface PlannedWrite {
	path: string;
	kind: "settings" | "mcp" | "skill" | "rule" | "memory" | "agent" | "history";
	/** Full file content to write. */
	content: string;
	/** True when `content` embeds a credential. */
	containsSecret: boolean;
}

/**
 * What kind of thing is being carried over. The user chooses at this
 * granularity (`--only`, the wizard) because the three have very different
 * consequences: settings change behaviour, assets add files to the home
 * directory, history writes a transcript that resume will replay.
 */
export type MigrationCategory = "settings" | "assets" | "history";

export const MIGRATION_CATEGORIES: MigrationCategory[] = ["settings", "assets", "history"];

const KIND_CATEGORY: Record<PlannedWrite["kind"], MigrationCategory> = {
	settings: "settings",
	mcp: "settings",
	skill: "assets",
	rule: "assets",
	memory: "assets",
	agent: "assets",
	history: "history",
};

export function categoryOfKind(kind: PlannedWrite["kind"]): MigrationCategory {
	return KIND_CATEGORY[kind];
}

export interface MigrationPlan {
	home: string;
	sources: MigrationSourceId[];
	/** Categories this plan was allowed to touch. */
	categories: MigrationCategory[];
	items: MigrationItem[];
	writes: PlannedWrite[];
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
	/** Why `history` is empty, when the user turned history import off. */
	historyScope?: HistoryScope;
}

export { DEFAULT_HISTORY_LIMIT };

/**
 * Environment variables whose values are credentials rather than configuration.
 * Drives the report's closing notice about which written files hold secrets;
 * matched case-insensitively as a substring so `*_API_KEY` variants are covered.
 */
const SECRET_ENV_MARKERS = ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL"];

export function looksLikeSecretName(name: string): boolean {
	const upper = name.toUpperCase();
	return SECRET_ENV_MARKERS.some((marker) => upper.includes(marker));
}

/**
 * Short model aliases → labunbun model references.
 *
 * Source tools accept a family alias where labunbun wants a `provider/id`
 * reference. Each target is verified against the registry during planning, so an
 * alias pointing at a model this build doesn't carry becomes a reported skip
 * rather than an unusable `model` value written into settings.
 */
const MODEL_ALIASES: Record<string, string> = {
	opus: "anthropic/claude-opus-5",
	sonnet: "anthropic/claude-sonnet-5",
	haiku: "anthropic/claude-haiku-4-5",
	fable: "anthropic/claude-fable-5",
};

/** Resolve a source `model` value to a reference labunbun can actually load. */
export function resolveModelReference(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const alias = MODEL_ALIASES[trimmed.toLowerCase()];
	const candidates = alias ? [alias, trimmed] : [trimmed];
	for (const candidate of candidates) {
		if (resolveModel(candidate)) return candidate;
	}
	return undefined;
}

/** Keys in the source state file that are telemetry or runtime bookkeeping. */
const STATE_TELEMETRY_KEYS = new Set(["projects", "tipsHistory", "promptQueueUseCount", "cachedChangelog"]);

function targetSettingsPath(home: string): string {
	return join(home, ".labunbun", "settings.json");
}

function targetMcpPath(home: string): string {
	return join(home, ".labunbun", ".mcp.json");
}

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
		key: "model" | "theme",
		value: string,
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
				detail: `target already sets ${key} to "${String(current)}" — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			return;
		}
		settingsPatch[key] = value;
		items.push({ source, from, to: `settings.json → ${key}`, action: "map", detail, containsSecret: false });
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
		}
	}

	if (only.includes("codex") && raw.codex.present) {
		if (wants("settings")) planCodex(raw.codex, items, claimScalar, settingsPatch, existing, force);
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
			if (raw.codex.memory?.trim()) {
				planMemoryAsRule(
					"codex",
					"~/.codex/AGENTS.md",
					raw.home,
					raw.codex.memory,
					"imported-codex.md",
					force,
					items,
					writes,
				);
			}
		}
	}

	if (only.includes("zcode") && raw.zcode.present) {
		if (wants("settings")) {
			planZcode(
				raw.zcode,
				items,
				claimEnv,
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
			planAssetTrees("zcode", raw.zcode, raw.home, force, items, writes);
		}
	}

	if (only.includes("agents") && raw.agents.present) {
		if (wants("assets")) planAssetTrees("agents", raw.agents, raw.home, force, items, writes);
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

	if (Object.keys(env).length > 0) settingsPatch.env = env;

	if (Object.keys(settingsPatch).length > 0) {
		const merged = mergeSettings(existing as Record<string, unknown>, settingsPatch);
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

type ClaimEnv = (source: MigrationSourceId, name: string, value: string, from: string) => void;
type ClaimScalar = (
	source: MigrationSourceId,
	key: "model" | "theme",
	value: string,
	from: string,
	detail: string,
) => void;

function planClaudeCode(
	raw: RawClaudeCode,
	items: MigrationItem[],
	claimEnv: ClaimEnv,
	claimScalar: ClaimScalar,
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
			mcpServers[name] = config;
			markMcpSecret(secret);
			items.push({
				source: "claude-code",
				from: `~/.claude.json → mcpServers.${name}`,
				to: `.mcp.json → mcpServers.${name}`,
				action: "map",
				detail: secret ? "copied verbatim, including credential headers" : "copied verbatim",
				containsSecret: secret,
			});
		}
	}

	// permissions / hooks: same rule grammar and hook shape on both sides, so
	// these carry over structurally when present.
	for (const [key, label] of [
		["permissions", "permissions"],
		["hooks", "hooks"],
	] as const) {
		if (raw.settings[key] === undefined) continue;
		const probe = SettingsSchema.safeParse({ [key]: raw.settings[key] });
		if (!probe.success) {
			items.push({
				source: "claude-code",
				from: `~/.claude/settings.json → ${label}`,
				to: "—",
				action: "skip",
				detail: "shape not accepted by the settings schema",
				containsSecret: false,
			});
			continue;
		}
		if (existing[key] !== undefined && !force) {
			items.push({
				source: "claude-code",
				from: `~/.claude/settings.json → ${label}`,
				to: "—",
				action: "skip",
				detail: `target already defines ${label} — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		settingsPatch[key] = raw.settings[key];
		items.push({
			source: "claude-code",
			from: `~/.claude/settings.json → ${label}`,
			to: `settings.json → ${label}`,
			action: "map",
			detail: "same rule grammar on both sides",
			containsSecret: false,
		});
	}

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
		items.push({
			source: "claude-code",
			from: "~/.claude/settings.json → enabledPlugins",
			to: "—",
			action: "skip",
			detail: "no plugin system here; skills and MCP servers cover the same ground",
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
}

function planCodex(
	raw: RawCodex,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	force: boolean,
): void {
	// Providers. `base_url` maps directly; the wire protocol may not.
	const providers = raw.config.model_providers;
	const openaiCompatible: Array<Record<string, unknown>> = [];
	if (typeof providers === "object" && providers !== null && !Array.isArray(providers)) {
		for (const [name, value] of Object.entries(providers as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			const spec = value as Record<string, unknown>;
			const baseUrl = typeof spec.base_url === "string" ? spec.base_url : undefined;
			if (!baseUrl) {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${name}`,
					to: "—",
					action: "skip",
					detail: "no base_url to point a provider at",
					containsSecret: false,
				});
				continue;
			}
			const apiKeyEnv = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
			// A provider entry with no models is still worth writing: it records the
			// endpoint and credential variable, and models can be added to it later.
			openaiCompatible.push({ id: name, baseUrl, apiKeyEnv, models: [] });
			const wireApi = typeof spec.wire_api === "string" ? spec.wire_api : undefined;
			if (wireApi && wireApi !== "chat" && wireApi !== "completions") {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${name} (wire_api="${wireApi}")`,
					to: `settings.json → providers.openaiCompatible[${name}]`,
					action: "downgrade",
					detail:
						`only the chat-completions and Anthropic messages protocols are supported, so this ` +
						`provider is registered as chat-completions; set ${apiKeyEnv} in your environment`,
					containsSecret: false,
				});
			} else {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${name}`,
					to: `settings.json → providers.openaiCompatible[${name}]`,
					action: "map",
					detail: `base_url carried over; set ${apiKeyEnv} in your environment`,
					containsSecret: false,
				});
			}
		}
	}
	mergeProviderSpecs(
		"codex",
		openaiCompatible,
		(id) => `~/.codex/config.toml → model_providers.${id}`,
		items,
		settingsPatch,
		existing,
		force,
	);

	// model: only meaningful if the registry (built-in or just-added provider)
	// can resolve it. A provider-scoped id needs the provider prefix.
	const model = raw.config.model;
	if (typeof model === "string" && model.trim()) {
		const provider = typeof raw.config.model_provider === "string" ? raw.config.model_provider : undefined;
		const resolved = resolveModelReference(model);
		if (resolved) {
			claimScalar("codex", "model", resolved, `~/.codex/config.toml → model ("${model}")`, `resolved to ${resolved}`);
		} else {
			items.push({
				source: "codex",
				from: `~/.codex/config.toml → model ("${model}")`,
				to: "—",
				action: "skip",
				detail: provider
					? `not in the registry — add it under providers.openaiCompatible[${provider}].models, then set model to "${provider}/${model}"`
					: "no model in the registry matches this name — set a model reference manually",
				containsSecret: false,
			});
		}
	}

	if (raw.config.model_reasoning_effort !== undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → model_reasoning_effort",
			to: "—",
			action: "skip",
			detail: "no reasoning-effort setting exists here; thinking level is chosen per request",
			containsSecret: false,
		});
	}
	if (raw.config.projects !== undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → projects.*.trust_level",
			to: "—",
			action: "skip",
			detail:
				"directory trust has no equivalent — permission rules are per-tool and MCP servers are approved " +
				"individually per project, so trusting a directory would not translate faithfully",
			containsSecret: false,
		});
	}
	if (raw.config.windows !== undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → windows.sandbox",
			to: "—",
			action: "skip",
			detail: "no OS-level sandbox setting; tool access is governed by permission rules",
			containsSecret: false,
		});
	}
	if (raw.config.tui !== undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → tui",
			to: "—",
			action: "skip",
			detail: "interface state, not configuration",
			containsSecret: false,
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Output-token budget assumed for an imported model whose source does not say. */
export const ASSUMED_MAX_OUTPUT_TOKENS = 8192;

/**
 * Model entries for `providers.openaiCompatible`, from ZCode's
 * `models.<name>.limit.context`. ZCode does not record an output limit, so one
 * is assumed rather than omitted — the schema requires it, and a value the user
 * can see beats a provider entry that fails to load.
 */
function zcodeModelEntries(models: unknown): Array<Record<string, unknown>> {
	if (!isRecord(models)) return [];
	const out: Array<Record<string, unknown>> = [];
	for (const [id, spec] of Object.entries(models)) {
		const limit = isRecord(spec) ? spec.limit : undefined;
		const context = isRecord(limit) && typeof limit.context === "number" ? limit.context : undefined;
		out.push({
			id,
			contextWindow: context && context > 0 ? Math.floor(context) : 128_000,
			maxOutputTokens: ASSUMED_MAX_OUTPUT_TOKENS,
		});
	}
	return out;
}

/** `model-a, model-b, model-c +4 more` — enough to act on, short enough to read. */
function summarizeNames(names: string[], max = 5): string {
	const unique = [...new Set(names)];
	if (unique.length <= max) return unique.join(", ");
	return `${unique.slice(0, max).join(", ")} +${unique.length - max} more`;
}

/**
 * ZCode (Z.ai) stores its configuration in two JSON files and its session
 * database in sqlite; `raw.settings` carries the database's `local_setting`
 * rows, read during the I/O pass.
 *
 * Credentials move across as-is, into the variables labunbun's Anthropic
 * provider already reads. They are never named in the report: `claimEnv` marks
 * the write as secret-bearing and the closing notice lists the file, not the
 * value.
 */
function planZcode(
	raw: RawZcode,
	items: MigrationItem[],
	claimEnv: ClaimEnv,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	// Providers. ZCode's built-in catalogue lists six; only the enabled ones say
	// anything about how this machine is actually configured.
	const disabled: string[] = [];
	const modelNames: string[] = [];
	const openaiCompatible: Array<Record<string, unknown>> = [];
	if (isRecord(raw.config.provider)) {
		for (const [id, value] of Object.entries(raw.config.provider)) {
			if (!isRecord(value)) continue;
			const label = `~/.zcode/v2/config.json → provider.${id}`;
			if (value.enabled !== true) {
				disabled.push(id);
				continue;
			}
			// A name this build can already resolve needs no report — the point of
			// the list below is the models that would silently not work.
			if (isRecord(value.models)) {
				modelNames.push(...Object.keys(value.models).filter((name) => !resolveModelReference(name)));
			}
			const options = isRecord(value.options) ? value.options : {};
			const kind = typeof value.kind === "string" ? value.kind : "";
			const baseUrl = typeof options.baseURL === "string" ? options.baseURL.trim() : "";
			const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
			if (kind === "anthropic") {
				if (baseUrl) claimEnv("zcode", "ANTHROPIC_BASE_URL", baseUrl, `${label}.options.baseURL`);
				if (apiKey) {
					// The same variable labunbun's Anthropic provider falls back to, so
					// an imported provider works without the user copying anything by hand.
					claimEnv("zcode", "ANTHROPIC_AUTH_TOKEN", apiKey, `${label}.options.apiKey`);
				} else {
					items.push({
						source: "zcode",
						from: `${label}.options.apiKey`,
						to: "—",
						action: "skip",
						detail:
							"no key stored in this file — ZCode keeps credentials in its own store, which the importer " +
							"does not read; set ANTHROPIC_AUTH_TOKEN yourself to use this provider",
						containsSecret: false,
					});
				}
				continue;
			}
			// A non-Anthropic protocol is registered as a chat-completions provider.
			// The id is prefixed because model references resolve first-match, so a
			// bare id colliding with a built-in would silently resolve elsewhere.
			const providerId = `zcode-${id}`;
			if (!baseUrl) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "no baseURL to point a provider at",
					containsSecret: false,
				});
				continue;
			}
			const apiKeyEnv = `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
			const spec = { id: providerId, baseUrl, apiKeyEnv, models: zcodeModelEntries(value.models) };
			if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "baseURL is not a usable URL for a provider entry",
					containsSecret: false,
				});
				continue;
			}
			openaiCompatible.push(spec);
			items.push({
				source: "zcode",
				from: `${label} (kind="${kind}")`,
				to: `settings.json → providers.openaiCompatible[${providerId}]`,
				action: "downgrade",
				detail:
					"only the chat-completions and Anthropic messages protocols are supported here, and ZCode " +
					`records no output limit, so models carry maxOutputTokens=${ASSUMED_MAX_OUTPUT_TOKENS}; set ` +
					`${apiKeyEnv} in your environment`,
				containsSecret: false,
			});
			if (apiKey) claimEnv("zcode", apiKeyEnv, apiKey, `${label}.options.apiKey`);
		}
	}
	if (disabled.length > 0) {
		items.push({
			source: "zcode",
			from: `~/.zcode/v2/config.json → provider.{${disabled.join(", ")}}`,
			to: "—",
			action: "skip",
			detail: "disabled in ZCode — enable the provider there first if you want it here",
			containsSecret: false,
		});
	}
	if (modelNames.length > 0) {
		items.push({
			source: "zcode",
			from: "~/.zcode/v2/config.json → provider.*.models",
			to: "—",
			action: "skip",
			detail:
				`not in this build's model registry (${summarizeNames(modelNames)}) — register a matching ` +
				'providers.openaiCompatible[].models entry, then reference it as "<provider>/<model>"',
			containsSecret: false,
		});
	}
	mergeProviderSpecs(
		"zcode",
		openaiCompatible,
		(id) => `~/.zcode/v2/config.json → provider.${id.replace(/^zcode-/, "")}`,
		items,
		settingsPatch,
		existing,
		force,
	);

	// MCP servers live in the CLI-side config, in a shape that is close to ours
	// but not identical: `http_headers` has to become `headers`, and a stdio
	// server's argv arrives joined in `command`.
	const servers = isRecord(raw.cliConfig.mcp) ? raw.cliConfig.mcp.servers : undefined;
	if (isRecord(servers)) {
		for (const [name, value] of Object.entries(servers)) {
			const label = `~/.zcode/cli/config.json → mcp.servers.${name}`;
			if (!isRecord(value)) continue;
			if (value.enabled === false || value.enable === false) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "disabled in ZCode",
					containsSecret: false,
				});
				continue;
			}
			const normalized = normalizeZcodeMcp(value);
			if (normalized === null || !McpServerConfigSchema.safeParse(normalized.config).success) {
				items.push({
					source: "zcode",
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
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "target already defines a server with this name — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			const record = normalized.config;
			const secret =
				Object.keys(isRecord(record.headers) ? record.headers : {}).length > 0 ||
				Object.keys(isRecord(record.env) ? record.env : {}).some((key) => looksLikeSecretName(key));
			mcpServers[name] = normalized.config;
			markMcpSecret(secret);
			items.push({
				source: "zcode",
				from: label,
				to: `.mcp.json → mcpServers.${name}`,
				action: "map",
				detail: secret
					? normalized.renamed
						? "copied verbatim, including credential headers (http_headers renamed to headers)"
						: "copied verbatim, including credential headers"
					: normalized.renamed
						? "copied verbatim (http_headers renamed to headers)"
						: "copied verbatim",
				containsSecret: secret,
			});
		}
	}

	// local_setting rows. Permission entries are recorded per project in ZCode,
	// and a repo-controlled permission decision may not widen what the agent is
	// allowed to do — the same boundary `PROJECT_TIER_DENIED_KEYS` draws for
	// project-scope settings files.
	for (const row of raw.settings) {
		const label = `~/.zcode/cli/db/db.sqlite → ${row.namespace}/${row.key} (${row.scope})`;
		if (row.namespace === "model" && row.key === "reasoningLevel") {
			items.push({
				source: "zcode",
				from: label,
				to: "—",
				action: "skip",
				detail: "no reasoning-effort setting exists here; thinking level is chosen per request",
				containsSecret: false,
			});
			continue;
		}
		if (row.namespace !== "permission") continue;
		if (row.scope !== "user") {
			items.push({
				source: "zcode",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"recorded per project rather than for you as a user, and a decision that travels with a " +
					"repository may not widen permissions — set it here with /permissions instead",
				containsSecret: false,
			});
			continue;
		}
		if (row.key === "mode") {
			const mode = isRecord(row.value) && typeof row.value.mode === "string" ? row.value.mode : "";
			items.push({
				source: "zcode",
				from: label,
				to: "—",
				action: "skip",
				detail: mode
					? `"${mode}" is ZCode's own mode vocabulary and has no faithful equivalent here — pick one with /permissions`
					: "unrecognised mode value — pick a permission mode with /permissions",
				containsSecret: false,
			});
			continue;
		}
		if (row.key === "ruleset") {
			const rules = zcodeAllowRules(row.value);
			if (rules.length === 0) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "no allow rules recorded",
					containsSecret: false,
				});
				continue;
			}
			const current = existing.permissions?.allow;
			if (current !== undefined && current.length > 0 && !force) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "target already defines permissions.allow — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			const probe = SettingsSchema.safeParse({ permissions: { allow: rules } });
			if (!probe.success) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "rule list not accepted by the settings schema",
					containsSecret: false,
				});
				continue;
			}
			settingsPatch.permissions = { allow: rules };
			items.push({
				source: "zcode",
				from: label,
				to: "settings.json → permissions.allow",
				action: "downgrade",
				detail: `${rules.length} allow rule(s) rewritten from ZCode's {toolName, ruleContent} form — review them with /permissions`,
				containsSecret: false,
			});
		}
	}

	if (raw.pluginCount > 0) {
		items.push({
			source: "zcode",
			from: "~/.zcode/cli/plugins/cache",
			to: "—",
			action: "skip",
			detail: `${raw.pluginCount} installed plugin(s) — third-party code rather than your own configuration`,
			containsSecret: false,
		});
	}
	if (raw.rolloutCount > 0) {
		items.push({
			source: "zcode",
			from: "~/.zcode/cli/rollout/*.jsonl",
			to: "—",
			action: "skip",
			detail: `${raw.rolloutCount} raw model I/O log(s), which embed live request Authorization headers — never opened`,
			containsSecret: false,
		});
	}
}

/**
 * Rewrite a ZCode MCP entry into labunbun's config shape.
 *
 * `http_headers` is the one field that must be renamed — leaving it would make
 * the server definition fail the schema, and a server that silently loses its
 * credential headers fails at connect time with an auth error instead of
 * saying what changed.
 */
function normalizeZcodeMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; renamed: boolean } | null {
	const headers = isRecord(entry.http_headers) ? entry.http_headers : undefined;
	const url = typeof entry.url === "string" ? entry.url : undefined;
	if (url) {
		const out: Record<string, unknown> = { type: "http", url };
		const merged = headers ?? (isRecord(entry.headers) ? entry.headers : undefined);
		if (merged) out.headers = merged;
		return { config: out, renamed: headers !== undefined && entry.headers === undefined };
	}
	const command = entry.command;
	if (typeof command === "string" && command) {
		const out: Record<string, unknown> = {
			type: "stdio",
			command,
			args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [],
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		return { config: out, renamed: false };
	}
	if (Array.isArray(command) && typeof command[0] === "string") {
		const out: Record<string, unknown> = {
			type: "stdio",
			command: command[0],
			args: command.slice(1).filter((a): a is string => typeof a === "string"),
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		return { config: out, renamed: false };
	}
	return null;
}

/** ZCode's `{version, allow: [{toolName, ruleContent}]}` → this build's rule strings. */
function zcodeAllowRules(value: unknown): string[] {
	if (!isRecord(value) || !Array.isArray(value.allow)) return [];
	const rules: string[] = [];
	for (const entry of value.allow) {
		if (typeof entry === "string") {
			rules.push(entry);
			continue;
		}
		if (!isRecord(entry)) continue;
		const tool = typeof entry.toolName === "string" ? entry.toolName.trim() : "";
		if (!tool) continue;
		const content = typeof entry.ruleContent === "string" ? entry.ruleContent.trim() : "";
		rules.push(content ? `${tool}(${content})` : tool);
	}
	return rules;
}

/**
 * Skills, agent definitions and the AGENTS.md memory document for a source
 * whose asset tree has the same layout as `~/.claude`'s.
 *
 * Claude Code and Codex keep inline copies of this — they predate the helper,
 * and their exact report wording is pinned by tests. New sources use this.
 */
function planAssetTrees(
	source: MigrationSourceId,
	raw: { skills: RawFile[]; agents: RawFile[]; memory: string | null },
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	collectFileWrites(
		source,
		raw.skills,
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		source,
		raw.agents,
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	if (raw.memory?.trim()) {
		planMemoryAsRule(
			source,
			`~/${SOURCE_ROOTS[source]}/AGENTS.md`,
			home,
			raw.memory,
			`imported-${source}.md`,
			force,
			items,
			writes,
		);
	}
}

/**
 * An imported memory document becomes a rule file rather than `MEMORY.md`.
 *
 * `MEMORY.md` is a file the user curates and may already have; dropping an
 * imported document on top of it would destroy their own notes. `rules/` is
 * additive by design and loaded with the same weight.
 */
function planMemoryAsRule(
	source: MigrationSourceId,
	fromLabel: string,
	home: string,
	memory: string,
	fileName: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	const path = join(home, ".labunbun", "rules", fileName);
	if (existsSync(path) && !force) {
		items.push({
			source,
			from: fromLabel,
			to: "—",
			action: "skip",
			detail: "target rule file already exists — kept (use --force to overwrite)",
			containsSecret: false,
		});
		return;
	}
	writes.push({ path, kind: "rule", content: memory, containsSecret: false });
	items.push({
		source,
		from: fromLabel,
		to: tildePath(home, path),
		action: "map",
		detail: "imported as a rule file so it merges with existing memory instead of replacing it",
		containsSecret: false,
	});
}

/**
 * Merge prepared provider specs into the settings patch, reporting a collision
 * rather than overwriting it: `id` is what a model reference resolves against,
 * so replacing an existing entry silently repoints configuration that was
 * already working.
 */
function mergeProviderSpecs(
	source: MigrationSourceId,
	additions: Array<Record<string, unknown>>,
	fromFor: (id: string) => string,
	items: MigrationItem[],
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	force: boolean,
): void {
	if (additions.length === 0) return;
	const currentProviders = (existing.providers?.openaiCompatible ?? []) as Array<{ id?: string }>;
	const existingIds = new Set(currentProviders.map((p) => p.id));
	for (const provider of additions) {
		if (force || !existingIds.has(provider.id as string)) continue;
		items.push({
			source,
			from: fromFor(provider.id as string),
			to: "—",
			action: "skip",
			detail: "target already defines a provider with this id — kept (use --force to overwrite)",
			containsSecret: false,
		});
	}
	const accepted = force ? additions : additions.filter((p) => !existingIds.has(p.id as string));
	if (accepted.length === 0) return;
	const kept = force ? currentProviders.filter((p) => !additions.some((a) => a.id === p.id)) : currentProviders;
	settingsPatch.providers = { openaiCompatible: [...kept, ...accepted] };
}

/**
 * Render a path the way the rest of the report does: under home with a leading
 * `~`, so an item's source and target read at the same scale. Paths outside
 * home are left alone rather than mangled into a misleading relative form.
 */
function tildePath(home: string, path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const base = home.replace(/\\/g, "/").replace(/\/+$/, "");
	return base && normalized.startsWith(`${base}/`) ? `~/${normalized.slice(base.length + 1)}` : normalized;
}

function collectFileWrites(
	source: MigrationSourceId,
	files: RawFile[],
	targetFor: (name: string) => string,
	kind: PlannedWrite["kind"],
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
	home: string,
): void {
	for (const file of files) {
		const path = targetFor(file.name);
		const from = tildePath(home, file.sourcePath);
		// An earlier source may already have claimed this exact path — two sources
		// can hold a skill of the same name. `existsSync` can't see that, since
		// nothing has been written yet during planning.
		if (writes.some((w) => w.path === path)) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `another source already provides this ${kind} — kept the first one`,
				containsSecret: false,
			});
			continue;
		}
		if (existsSync(path) && !force) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `target ${kind} already exists — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		writes.push({ path, kind, content: file.content, containsSecret: false });
		items.push({
			source,
			from,
			to: tildePath(home, path),
			action: "map",
			detail: file.detail ?? `${kind} copied verbatim`,
			containsSecret: false,
		});
	}
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
			const from = `${label} session ${session.sourceId}${session.title ? ` — ${session.title}` : ""}`;
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
				detail: `transcript with ${session.entries.length} entries — resumable with --continue`,
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
	const plan = planMigration(raw, existing, {
		only,
		force: options.force,
		categories,
		historyLimit,
		history,
		historyScope,
	});

	if (!options.apply) {
		return { report: formatMigrationReport(plan), plan };
	}
	const applied = applyMigration(plan);
	return { report: formatMigrationReport(plan, applied), plan, applied };
}
