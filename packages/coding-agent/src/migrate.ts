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
import { dirname, join } from "node:path";
import { parseRuleText } from "@labunbun/agent";
import { resolveModel } from "@labunbun/ai";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { historyFilePath, readHistoryFile } from "./history.ts";
import { HOOK_EVENTS, type HookEventName, HooksConfigSchema } from "./hooks.ts";
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
import { mergeSettings, OpenAICompatibleProviderSchema, type RawSettingsInput, SettingsSchema } from "./settings.ts";
// The same reader the skill loader uses, so what the importer writes back is
// what the loader will read.
import { parseFrontmatter } from "./skills.ts";
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

/**
 * Detect a source by what is in it, not by whether its directory exists.
 *
 * `~/.agents` (and `~/.claude`, `~/.codex`) are directories other tools create —
 * an empty one has nothing to import, and offering it is a question whose only
 * possible answer still costs the user a read and a keystroke. A root that is
 * present but unreadable counts as empty for the same reason: nothing can be
 * read from it either way.
 */
function sourceHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

export function detectSources(home: string): MigrationSourceId[] {
	return MIGRATION_SOURCE_IDS.filter((id) => sourceHasContent(join(home, SOURCE_ROOTS[id])));
}

// ---------------------------------------------------------------------------
// Raw source data
// ---------------------------------------------------------------------------

/**
 * A file that travels with a {@link RawFile} rather than standing on its own: a
 * skill's `references/*.md`, `scripts/`, and so on.
 *
 * A skill is a directory, not a document. Copying only its `SKILL.md` leaves the
 * body pointing at files that are not there, so the supporting files are read
 * alongside it and written next to it.
 */
export interface RawAttachment {
	/** Path relative to the owning file's directory, e.g. `references/api.md`. */
	relativePath: string;
	content: string;
}

/** A skill, rule or agent file found in a source tree, carried as content. */
export interface RawFile {
	/** Name used to build the target path: skill directory name, or rule filename. */
	name: string;
	sourcePath: string;
	content: string;
	/** Overrides the report's "copied verbatim" note when the copy has a caveat. */
	detail?: string;
	/** Files belonging beside this one, written into the same target directory. */
	attachments?: RawAttachment[];
	/**
	 * Supporting files deliberately left behind, with the reason. Carried out of
	 * the reading phase because the report is written from the plan, and a file
	 * that neither travels nor is explained reads as an importer bug.
	 */
	attachmentSkips?: Array<{ relativePath: string; reason: string }>;
}

/**
 * Command files found under a source's commands directory, with the ones that
 * could not become a skill.
 *
 * Separate from {@link RawFile} because a command file is not carried as it
 * stands: its header is rewritten, and the reason a file was refused (a README,
 * a name too long to be a directory here) has to survive into the report.
 */
export interface RawCommands {
	files: RawFile[];
	skips: Array<{ path: string; reason: string }>;
}

export interface RawClaudeCode {
	/** ~/.claude/settings.json */
	settings: Record<string, unknown>;
	/** ~/.claude.json — mostly runtime state; only a few keys are migratable. */
	state: Record<string, unknown>;
	skills: RawFile[];
	rules: RawFile[];
	agents: RawFile[];
	/** ~/.claude/commands/**\/*.md — slash commands, imported as skills. */
	commands: RawCommands;
	present: boolean;
}

/** One `*.rules` execpolicy file, as text. */
export interface RawRuleFile {
	/** File name under `rules/`, e.g. `default.rules`. */
	name: string;
	content: string;
}

export interface RawCodex {
	/** Parsed ~/.codex/config.toml */
	config: Record<string, unknown>;
	/** ~/.codex/AGENTS.md, when it exists. */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
	/**
	 * ~/.codex/prompts/*.md — custom prompts. Absent from the Codex versions
	 * this importer was written against (it turns foreign commands into skills
	 * instead), so this is normally empty and read only if the directory appears.
	 */
	prompts: RawCommands;
	/** ~/.codex/rules/*.rules — the user's own execpolicy decisions. */
	execpolicy: RawRuleFile[];
	/** ~/.codex/hooks.json — reported by name, never opened. */
	hooksPresent: boolean;
	/** Definition files under ~/.codex/agents that are not markdown — counted, never parsed. */
	agentTomlCount: number;
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

/** Directories inside a skill that hold somebody else's files, not the skill's. */
const SKILL_EXCLUDED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);

/** Largest supporting file worth carrying; a skill is prose, not an asset store. */
const MAX_ATTACHMENT_BYTES = 256 * 1024;

/** Most supporting files one skill may bring along. */
const MAX_ATTACHMENTS = 200;

/**
 * The files beside a skill's `SKILL.md`, as attachments.
 *
 * A skill is a directory, not a document: its body points at `references/*.md`,
 * `scripts/`, and so on, and copying only the `SKILL.md` leaves those pointers
 * dangling. Text files are carried; binaries and anything oversized are counted
 * and named in the report instead of written, because the writer is text-only
 * and a silent truncation would be worse than an explanation.
 */
function readAttachments(skillDir: string): Pick<RawFile, "attachments" | "attachmentSkips"> {
	const attachments: RawAttachment[] = [];
	const attachmentSkips: Array<{ relativePath: string; reason: string }> = [];
	const walk = (dir: string, prefix: string): void => {
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (attachments.length >= MAX_ATTACHMENTS) {
				attachmentSkips.push({ relativePath, reason: `more than ${MAX_ATTACHMENTS} files` });
				continue;
			}
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKILL_EXCLUDED_DIRS.has(entry.name)) {
					attachmentSkips.push({ relativePath, reason: "not part of the skill (dependencies or VCS data)" });
					continue;
				}
				walk(full, relativePath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (entry.name === "SKILL.md" && prefix === "") continue;
			let bytes: Buffer;
			try {
				bytes = readFileSync(full);
			} catch {
				attachmentSkips.push({ relativePath, reason: "unreadable" });
				continue;
			}
			if (bytes.length > MAX_ATTACHMENT_BYTES) {
				attachmentSkips.push({ relativePath, reason: `larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB` });
				continue;
			}
			if (bytes.includes(0)) {
				attachmentSkips.push({ relativePath, reason: "binary file" });
				continue;
			}
			attachments.push({ relativePath, content: bytes.toString("utf8") });
		}
	};
	walk(skillDir, "");
	return { attachments, attachmentSkips };
}

/** Skill directories, each contributing its SKILL.md and the files beside it. */
function readSkillDirs(skillsRoot: string): RawFile[] {
	const out: RawFile[] = [];
	try {
		if (!existsSync(skillsRoot)) return out;
		for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const skillDir = join(skillsRoot, entry.name);
			const content = readText(join(skillDir, "SKILL.md"));
			if (content === null) continue;
			const { attachments, attachmentSkips } = readAttachments(skillDir);
			out.push({ name: entry.name, sourcePath: join(skillDir, "SKILL.md"), content, attachments, attachmentSkips });
		}
	} catch {
		// unreadable skills dir — contributes nothing
	}
	return out;
}

/** Longest skill name to derive from a command file's path. */
const MAX_COMMAND_NAME = 64;

/**
 * Slash-command markdown files, read recursively.
 *
 * Unlike a rules or agents directory, a commands tree mirrors how the source
 * tool namespaced its commands: `fix/bugs.md` is a different command from
 * `fix.md`, and the two files may say different things. The nesting is
 * flattened into the name (`fix-bugs`) because a skill here is one directory
 * per name, and a collision would be reported as one skill having been kept.
 */
function readCommandFiles(root: string): RawCommands {
	const files: RawFile[] = [];
	const skips: Array<{ path: string; reason: string }> = [];
	const walk = (dir: string, prefix: string): void => {
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (SKILL_EXCLUDED_DIRS.has(entry.name)) continue;
				walk(join(dir, entry.name), relativePath);
				continue;
			}
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
			if (entry.name.toLowerCase() === "readme.md") {
				skips.push({ path: relativePath, reason: "a README, not a command" });
				continue;
			}
			const name = relativePath.slice(0, -3).split("/").join("-");
			if (name === "") {
				skips.push({ path: relativePath, reason: "no usable name" });
				continue;
			}
			if (name.length > MAX_COMMAND_NAME) {
				skips.push({ path: relativePath, reason: `name would be longer than ${MAX_COMMAND_NAME} characters` });
				continue;
			}
			const content = readText(join(dir, entry.name));
			if (content === null) {
				skips.push({ path: relativePath, reason: "unreadable" });
				continue;
			}
			files.push({ name, sourcePath: join(dir, entry.name), content });
		}
	};
	walk(root, "");
	return { files, skips };
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
		commands: readCommandFiles(join(root, "commands")),
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
		prompts: readCommandFiles(join(root, "prompts")),
		execpolicy: readRuleFiles(join(root, "rules")),
		hooksPresent: existsSync(join(root, "hooks.json")),
		agentTomlCount: countFilesWithExtension(join(root, "agents"), ".toml"),
		present: existsSync(root),
	};
}

/**
 * `~/.codex/rules/*.rules` — the execpolicy files, read as text.
 *
 * These hold decisions the user made by hand about what may run (`prefix_rule`)
 * and are the closest thing Codex has to this build's permission rules, so they
 * are worth reading. Parsing them is left to the planner: a `.rules` file is
 * Starlark, and the planner is where the "cannot express this" decisions belong.
 */
function readRuleFiles(dir: string): RawRuleFile[] {
	const out: RawRuleFile[] = [];
	try {
		if (!existsSync(dir)) return out;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".rules")) continue;
			const content = readText(join(dir, entry.name));
			if (content !== null) out.push({ name: entry.name, content });
		}
	} catch {
		// unreadable rules directory — contributes nothing
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Files directly under `dir` with the given extension; unreadable counts as none. */
function countFilesWithExtension(dir: string, extension: string): number {
	try {
		if (!existsSync(dir)) return 0;
		return readdirSync(dir).filter((name) => name.endsWith(extension)).length;
	} catch {
		return 0;
	}
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
	return countFilesWithExtension(join(root, "rollout"), ".jsonl");
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
	kind: "settings" | "mcp" | "skill" | "rule" | "memory" | "agent" | "history" | "prompt-history";
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
	"prompt-history": "history",
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
	fable: "anthropic/claude-fable-5-1",
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

/**
 * Keys of `~/.claude/settings.json` that either get imported or get a note of
 * their own. Anything else is named by the closing aggregate item.
 */
const CLAUDE_SETTINGS_HANDLED = new Set([
	"env",
	"model",
	"permissions",
	"hooks",
	"fallbackModel",
	"effortLevel",
	"enabledPlugins",
]);

/** Keys of `~/.claude.json` that are accounted for above; the rest is state. */
const CLAUDE_STATE_HANDLED = new Set(["env", "model", "mcpServers", ...STATE_TELEMETRY_KEYS]);

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
		permissionRules[behavior] = usable;
		permissionsTouched = true;
		items.push({
			source,
			from,
			to: `settings.json → permissions.${behavior}`,
			action: "map",
			detail,
			containsSecret: false,
		});
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
			planCommands("claude-code", raw.claudeCode.commands, "~/.claude/commands", raw.home, force, items, writes);
		}
	}

	if (only.includes("codex") && raw.codex.present) {
		if (wants("settings")) {
			planCodex(
				raw.codex,
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
			planCodexRules(raw.codex, items, addPermissionRules);
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
			planCommands("codex", raw.codex.prompts, "~/.codex/prompts", raw.home, force, items, writes);
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

/**
 * Settings keys a source may claim outright, and the value shapes they carry.
 * Widening this list is cheap; claiming a key that the merge cannot undo is not,
 * which is why permission rules take the accumulating path instead.
 */
export type ClaimableScalarKey =
	| "model"
	| "theme"
	| "permissionMode"
	| "fallbackModels"
	| "disableBypassPermissionsMode";

export type ClaimedScalarValue = string | string[] | boolean;

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
 * Characters that make a hook matcher mean something different in each tool.
 *
 * `matchesPattern` in `hooks.ts` treats `*` as the only wildcard and escapes
 * every other pattern character, so a source matcher written as a regular
 * expression (`mcp__.*__delete.*`) imports as a literal that can never match.
 * Keeping this list equal to the escape list there is what makes the check
 * honest — a character escaped there but not here would be a silent miss.
 */
const HOOK_MATCHER_METACHARACTERS = /[.+^${}()|[\]\\]/;

/** A matcher name this build can reproduce: tool names, MCP ids, and `*`. */
const HOOK_MATCHER_NAME = /^[A-Za-z0-9_:*-]+$/;

/** One entry of the target's hook config. */
export interface NormalizedHookEntry {
	matcher?: string;
	hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

/** What survived hook normalization, and what did not. */
export interface NormalizedHooks {
	/** Event name → entries that will run. Events with nothing runnable are absent. */
	config: Record<string, NormalizedHookEntry[]>;
	/** Source event names this build has no event for; hooks under them never fire. */
	droppedEvents: string[];
	/** Handlers dropped because their `type` is not a shell command (e.g. `prompt`). */
	droppedHandlers: number;
	/** Matchers dropped because this build would escape their pattern characters. */
	droppedMatchers: string[];
	/** Alternation matchers (`A|B`) split into one entry per name. */
	splitMatchers: string[];
	/** Handlers that carried no usable command, or entries that were not objects. */
	malformed: number;
}

/** One handler in the target's shape, or nothing plus a count of why not. */
function normalizeClaudeHandler(handler: unknown, counts: NormalizedHooks): NormalizedHookEntry["hooks"] {
	if (!isRecord(handler)) {
		counts.malformed += 1;
		return [];
	}
	if ((handler.type ?? "command") !== "command") {
		counts.droppedHandlers += 1;
		return [];
	}
	if (typeof handler.command !== "string" || handler.command.trim() === "") {
		counts.malformed += 1;
		return [];
	}
	const timeout = handler.timeout;
	const usableTimeout =
		typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0 && timeout <= 600_000 ? timeout : undefined;
	return [
		usableTimeout === undefined
			? { type: "command", command: handler.command }
			: { type: "command", command: handler.command, timeout: usableTimeout },
	];
}

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

type AddPermissionRules = (
	source: MigrationSourceId,
	behavior: "allow" | "deny",
	rules: string[],
	from: string,
	caveat: string,
) => void;

/** A `name(args)` call in a `.rules` file, with its arguments as text. */
interface RuleCall {
	name: string;
	args: Record<string, string | string[]>;
}

/** Index just past the string literal starting at `start`, or past the end. */
function skipString(text: string, start: number): number {
	const quote = text[start];
	let index = start + 1;
	while (index < text.length) {
		if (text[index] === "\\") index += 2;
		else if (text[index] === quote) return index + 1;
		else index += 1;
	}
	return text.length;
}

/** Index of the `)` matching the `(` at `open`, or -1 when the call is unterminated. */
function matchParen(text: string, open: number): number {
	let depth = 0;
	let index = open;
	while (index < text.length) {
		const char = text[index];
		if (char === "#") {
			const lineEnd = text.indexOf("\n", index);
			index = lineEnd === -1 ? text.length : lineEnd + 1;
			continue;
		}
		if (char === '"' || char === "'") {
			index = skipString(text, index);
			continue;
		}
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
		index += 1;
	}
	return -1;
}

function unquote(literal: string): string {
	return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** `key = value` pairs inside a call body; values stay strings or string lists. */
function parseRuleArgs(body: string): Record<string, string | string[]> {
	const args: Record<string, string | string[]> = {};
	const pair = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\[[\s\S]*?\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
	for (const match of body.matchAll(pair)) {
		const value = match[2];
		args[match[1]] = value.startsWith("[")
			? [...value.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)].map((item) => unquote(item[0]))
			: unquote(value);
	}
	return args;
}

/**
 * The `name(...)` calls in a `.rules` file, in order.
 *
 * A `.rules` file is Starlark, and this is not a Starlark interpreter: it finds
 * calls, steps over string literals (so a `)` inside a pattern does not end the
 * call early) and comments, and reads `key = value` pairs. Whatever it cannot
 * follow is counted rather than guessed at, and the count reaches the report.
 */
function ruleCalls(content: string): { calls: RuleCall[]; unparsed: number } {
	const calls: RuleCall[] = [];
	let unparsed = 0;
	let index = 0;
	while (index < content.length) {
		const char = content[index];
		if (char === "#") {
			const lineEnd = content.indexOf("\n", index);
			index = lineEnd === -1 ? content.length : lineEnd + 1;
			continue;
		}
		if (char === '"' || char === "'") {
			index = skipString(content, index);
			continue;
		}
		if (!/[A-Za-z_]/.test(char)) {
			index += 1;
			continue;
		}
		const start = index;
		while (index < content.length && /[A-Za-z0-9_]/.test(content[index])) index += 1;
		const name = content.slice(start, index);
		while (index < content.length && /\s/.test(content[index])) index += 1;
		if (content[index] !== "(") continue;
		const end = matchParen(content, index);
		if (end === -1) {
			unparsed += 1;
			break;
		}
		calls.push({ name, args: parseRuleArgs(content.slice(index + 1, end)) });
		index = end + 1;
	}
	return { calls, unparsed };
}

/**
 * `prefix_rule` pattern → a `Bash(...)` rule for this build.
 *
 * Codex matches the pattern against the parsed argv, token by token; this build
 * matches a rule against the command line as text, so the tokens are joined and a
 * trailing `*` lets the arguments match. A token holding a character that means
 * something else here (`*`, `?`, parentheses) is refused rather than translated:
 * widening a permission rule is not something an importer should do quietly.
 */
function codexPatternToSpecifier(tokens: string[]): { specifier: string } | { reason: string } {
	if (tokens.length === 0) return { reason: "its pattern is empty" };
	for (const token of tokens) {
		if (/[*?()[\]]/.test(token)) {
			// Quoted back truncated: a pattern is whatever the user typed there, and
			// the report ends up in a transcript, so only its head travels.
			const shown = token.length > 80 ? `${token.slice(0, 80)}…` : token;
			return { reason: `its pattern token "${shown}" means something else in this build's rule syntax` };
		}
	}
	// The `*` is glued to the last token so the command matches with and without
	// arguments, the way a prefix match does.
	return { specifier: `Bash(${tokens.join(" ")}*)` };
}

/**
 * Carry `prefix_rule` decisions over as permission rules.
 *
 * The source's allow means "run it without a prompt inside a sandbox that still
 * confines it"; an allow rule here is the whole gate, which is why the report
 * says so on every rule it adds. Rules are added, never replaced — the target's
 * own rules and the other source's rules have to survive the import.
 */
function planCodexRules(raw: RawCodex, items: MigrationItem[], addPermissionRules: AddPermissionRules): void {
	for (const file of raw.execpolicy) {
		const { calls, unparsed } = ruleCalls(file.content);
		const from = `~/.codex/rules/${file.name}`;
		const allow: string[] = [];
		const deny: string[] = [];
		const skipped: string[] = [];
		for (const call of calls) {
			if (call.name !== "prefix_rule") {
				skipped.push(`a ${call.name} rule — this build only has command rules`);
				continue;
			}
			const pattern = call.args.pattern;
			const tokens = Array.isArray(pattern) ? pattern : typeof pattern === "string" ? [pattern] : undefined;
			if (tokens === undefined) {
				skipped.push("a prefix_rule with no readable pattern");
				continue;
			}
			const translated = codexPatternToSpecifier(tokens);
			if ("reason" in translated) {
				skipped.push(`a prefix_rule — ${translated.reason}`);
				continue;
			}
			const decision = call.args.decision;
			if (decision === "allow") allow.push(translated.specifier);
			else if (decision === "forbidden" || decision === "deny") deny.push(translated.specifier);
			else if (decision === "prompt") {
				skipped.push(`${translated.specifier} — the source prompts before running it, and there is no ask tier here`);
			} else if (decision === undefined) {
				skipped.push(
					`${translated.specifier} — no decision was given, which Codex reads as allow; nothing is allowed implicitly here`,
				);
			} else {
				skipped.push(`${translated.specifier} — unknown decision "${String(decision)}"`);
			}
		}
		if (unparsed > 0) skipped.push(`${unparsed} call(s) the reader could not follow`);

		const caveat =
			"an allowed command runs without a prompt and without Codex's sandbox, and the whole command line is matched, so a chained command that begins the same way matches too";
		if (allow.length > 0) addPermissionRules("codex", "allow", allow, from, caveat);
		if (deny.length > 0) {
			addPermissionRules(
				"codex",
				"deny",
				deny,
				from,
				"a denied command is refused here whether or not another rule allows it",
			);
		}
		if (skipped.length > 0) {
			items.push({
				source: "codex",
				from,
				to: "—",
				action: "skip",
				detail: `${skipped.length} rule(s) not carried: ${summarizeNames(skipped, 3)}`,
				containsSecret: false,
			});
		}
	}
}

type ClaimPermissionList = (
	source: MigrationSourceId,
	behavior: "allow" | "deny" | "additionalDirectories",
	rules: string[],
	from: string,
	detail: string,
) => void;

/**
 * One line naming the keys that were neither imported nor explained.
 *
 * Silence is the one thing a migration report may not do: a key the user set is
 * either carried across or named here, so the report cannot leave them
 * wondering whether something went missing. Values are never printed — the
 * names are the report, the contents are the user's own.
 */
function reportUnhandledKeys(
	source: MigrationSourceId,
	container: Record<string, unknown>,
	handled: Set<string>,
	from: string,
	items: MigrationItem[],
): void {
	const unhandled = Object.keys(container).filter((key) => !handled.has(key));
	if (unhandled.length === 0) return;
	items.push({
		source,
		from: `${from} → ${summarizeNames(unhandled, 8)}`,
		to: "—",
		action: "skip",
		detail: `${unhandled.length} key(s) this importer has no mapping for and no note about, so they were left where they are — copy over by hand whatever matters`,
		containsSecret: false,
	});
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
	items.push({
		source: "claude-code",
		from,
		to: "settings.json → hooks",
		action: losses.length > 0 ? "downgrade" : "map",
		detail: `${entries} matcher entr(ies) over ${events.length} event(s) rewritten${split}${losses.length > 0 ? `; not carried: ${losses.join("; ")}` : ""}`,
		containsSecret: false,
	});
}

type ClaimScalar = (
	source: MigrationSourceId,
	key: ClaimableScalarKey,
	value: ClaimedScalarValue,
	from: string,
	detail: string,
) => void;

function planClaudeCode(
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

	// Everything else, so that no key is absent from the report without saying
	// so. One line per file, names only: the user's settings may hold values
	// this importer has no business printing.
	reportUnhandledKeys("claude-code", raw.settings, CLAUDE_SETTINGS_HANDLED, "~/.claude/settings.json", items);
	reportUnhandledKeys("claude-code", raw.state, CLAUDE_STATE_HANDLED, "~/.claude.json", items);
}

function planCodex(
	raw: RawCodex,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	// Providers. `base_url` maps directly; the wire protocol may not.
	const providers = raw.config.model_providers;
	const openaiCompatible: Array<Record<string, unknown>> = [];
	// `model` and `model_context_window` are top-level keys that describe the one
	// model this machine is set up to run: with both present, the provider entry
	// can carry the model instead of being written model-less and unusable.
	const modelName =
		typeof raw.config.model === "string" && raw.config.model.trim() ? raw.config.model.trim() : undefined;
	const providerName =
		typeof raw.config.model_provider === "string" && raw.config.model_provider.trim()
			? raw.config.model_provider.trim()
			: undefined;
	const modelContextWindow =
		typeof raw.config.model_context_window === "number" && raw.config.model_context_window > 0
			? Math.floor(raw.config.model_context_window)
			: undefined;
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
			// The credential variable is named by the source, not guessed: `env_key`
			// is the only place Codex records which variable holds the key. The
			// synthesized fallback is for entries that expect no key at all.
			const envKey = typeof spec.env_key === "string" && spec.env_key.trim() ? spec.env_key.trim() : undefined;
			const apiKeyEnv = envKey ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
			// `requires_openai_auth` means ChatGPT sign-in rather than a key; telling
			// the user to "set X_API_KEY" for such a provider sends them looking for
			// a credential that the source never used.
			const credentialNote =
				spec.requires_openai_auth === true
					? `the source reached it by signing in to an OpenAI account (requires_openai_auth), which this build ` +
						`cannot do — export ${apiKeyEnv} with an API key to use this endpoint here`
					: `set ${apiKeyEnv} in your environment${envKey ? " (the variable its env_key names)" : ""}`;
			const models: Array<Record<string, unknown>> = [];
			if (name === providerName && modelName && modelContextWindow !== undefined) {
				models.push({
					id: modelName,
					contextWindow: modelContextWindow,
					maxOutputTokens: ASSUMED_MAX_OUTPUT_TOKENS,
				});
			}
			// A provider entry with no models is still worth writing: it records the
			// endpoint and credential variable, and models can be added to it later.
			openaiCompatible.push({ id: name, baseUrl, apiKeyEnv, models });
			const wireApi = typeof spec.wire_api === "string" ? spec.wire_api : undefined;
			if (wireApi && wireApi !== "chat" && wireApi !== "completions") {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${name} (wire_api="${wireApi}")`,
					to: `settings.json → providers.openaiCompatible[${name}]`,
					action: "downgrade",
					detail:
						`only the chat-completions and Anthropic messages protocols are supported, so this ` +
						`provider is registered as chat-completions; ${credentialNote}`,
					containsSecret: false,
				});
			} else {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${name}`,
					to: `settings.json → providers.openaiCompatible[${name}]`,
					action: "map",
					detail: `base_url carried over; ${credentialNote}`,
					containsSecret: false,
				});
			}
			if (isRecord(spec.http_headers)) {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${name}.http_headers`,
					to: "—",
					action: "skip",
					detail:
						"a provider entry here carries an endpoint and a credential variable, not request headers — " +
						"the gateway has to accept what this endpoint sends",
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
	if (modelName) {
		// Which providers actually made it into the patch — the target may already
		// define one and keep its own definition, in which case the model entry
		// written above is not there either.
		const acceptedProviders = isRecord(settingsPatch.providers) ? settingsPatch.providers.openaiCompatible : undefined;
		const providerAccepted =
			providerName !== undefined &&
			Array.isArray(acceptedProviders) &&
			acceptedProviders.some((entry) => isRecord(entry) && entry.id === providerName);
		if (providerAccepted && modelContextWindow !== undefined && providerName) {
			const reference = `${providerName}/${modelName}`;
			claimScalar(
				"codex",
				"model",
				reference,
				`~/.codex/config.toml → model ("${modelName}")`,
				`registered under the "${providerName}" provider with the ${modelContextWindow}-token context window the source records — the protocol is spoken as chat-completions`,
			);
		} else {
			const resolved = resolveModelReference(modelName);
			if (resolved) {
				claimScalar(
					"codex",
					"model",
					resolved,
					`~/.codex/config.toml → model ("${modelName}")`,
					`resolved to ${resolved}`,
				);
			} else {
				const providerKeptItsOwn =
					providerName !== undefined && modelContextWindow !== undefined
						? `the target already defines a "${providerName}" provider — add "${modelName}" to its models and set model to "${providerName}/${modelName}"`
						: undefined;
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model ("${modelName}")`,
					to: "—",
					action: "skip",
					detail:
						providerKeptItsOwn ??
						(providerName
							? `not in the registry — add it under providers.openaiCompatible[${providerName}].models, then set model to "${providerName}/${modelName}"`
							: "no model in the registry matches this name — set a model reference manually"),
					containsSecret: false,
				});
			}
		}
	}
	if (raw.config.model_context_window !== undefined && modelContextWindow === undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → model_context_window",
			to: "—",
			action: "skip",
			detail: "not a positive number of tokens, so no model entry could be built from it",
			containsSecret: false,
		});
	}
	if (raw.config.model_auto_compact_token_limit !== undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → model_auto_compact_token_limit",
			to: "—",
			action: "skip",
			detail:
				"no equivalent threshold — compaction starts at the context-window threshold here, and the model's " +
				"context window is what decides it",
			containsSecret: false,
		});
	}
	if (raw.config.disable_response_storage !== undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → disable_response_storage",
			to: "—",
			action: "skip",
			detail: "server-side response storage is a request field of that API; nothing here sends it either way",
			containsSecret: false,
		});
	}

	// MCP servers. Codex keeps them in the same TOML file as the model settings,
	// in a shape that maps onto ours except for the two ways it supplies a
	// credential without storing one: `env_vars` names variables to forward from
	// the shell, and `bearer_token_env_var` does the same for a header.
	const servers = raw.config.mcp_servers;
	if (isRecord(servers)) {
		for (const [name, value] of Object.entries(servers)) {
			const label = `~/.codex/config.toml → mcp_servers.${name}`;
			if (!isRecord(value)) continue;
			if (value.enabled === false) {
				items.push({
					source: "codex",
					from: label,
					to: "—",
					action: "skip",
					detail: "disabled in Codex",
					containsSecret: false,
				});
				continue;
			}
			const normalized = normalizeCodexMcp(value);
			if (normalized === null || !McpServerConfigSchema.safeParse(normalized.config).success) {
				items.push({
					source: "codex",
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
					source: "codex",
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
				Object.keys(isRecord(normalized.config.env) ? normalized.config.env : {}).some((key) =>
					looksLikeSecretName(key),
				);
			mcpServers[name] = normalized.config;
			markMcpSecret(secret);
			const copied = secret ? "copied verbatim, including credential headers" : "copied verbatim";
			items.push({
				source: "codex",
				from: label,
				to: `.mcp.json → mcpServers.${name}`,
				action: normalized.downgrades.length > 0 ? "downgrade" : "map",
				detail: normalized.downgrades.length > 0 ? `${copied} — ${normalized.downgrades.join("; ")}` : copied,
				containsSecret: secret,
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
	for (const [key, reason] of UNMIGRATED_CODEX_KEYS) {
		if (raw.config[key] === undefined) continue;
		items.push({
			source: "codex",
			from: `~/.codex/config.toml → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	if (raw.hooksPresent) {
		items.push({
			source: "codex",
			from: "~/.codex/hooks.json",
			to: "—",
			action: "skip",
			detail:
				"event handlers in a shape this build does not read — hooks here are command hooks in " +
				"settings.json → hooks, written by hand rather than translated",
			containsSecret: false,
		});
	}
	if (raw.agentTomlCount > 0) {
		items.push({
			source: "codex",
			from: "~/.codex/agents/*.toml",
			to: "—",
			action: "skip",
			detail: `${raw.agentTomlCount} agent definition(s) in Codex's TOML shape; agents here are markdown files with frontmatter`,
			containsSecret: false,
		});
	}
}

/**
 * Codex configuration this importer reports but does not carry.
 *
 * Each names something a user could have set and then gone looking for after the
 * migration. `[projects]`, `[windows]` and `[tui]` are reported by their own code
 * above because their wording is pinned by tests; these are the rest.
 */
const UNMIGRATED_CODEX_KEYS: Array<[key: string, reason: string]> = [
	[
		"notify",
		"an external program Codex runs on events; the equivalent here is a command hook " +
			"(settings.json → hooks), which is not derived from this argv",
	],
	["history", "Codex's own transcript-persistence settings; prompt history here is one file with its own limit"],
	[
		"shell_environment_policy",
		"controls what Codex's child processes inherit; settings env injects variables into this process " +
			"instead, which is a different thing",
	],
	["profiles", "named overlays selected with --profile; there is no profile switch here"],
	["features", "feature flags for Codex's own runtime"],
	["agents", "per-agent overrides for Codex's built-in agents"],
	["oss_provider", "which provider Codex's local OSS model would use"],
];

/**
 * Rewrite one Codex `[mcp_servers.<name>]` entry into labunbun's config shape.
 *
 * The differences are all about credentials Codex does not store: `env_vars` and
 * `bearer_token_env_var` name variables in the user's shell environment rather
 * than holding values. The importer copies the server and says which variables
 * it used to read — it will not read them itself, and inventing an empty value
 * would turn a working server into one that fails at connect time.
 *
 * Returns `null` when the entry is neither of the two shapes that can be
 * carried over; the caller reports that as a skip.
 */
/**
 * `${VAR}` names used in the values of an env or header block.
 *
 * The target's MCP client does not expand variables (`packages/mcp` has no such
 * step), so a copied value that says `${TOKEN}` stays the literal text — a
 * server that would have authenticated does not. Names only: whatever else is in
 * the value is the user's.
 */
function placeholderNames(config: unknown): string[] {
	const names = new Set<string>();
	if (!isRecord(config)) return [];
	for (const value of Object.values(config)) {
		if (typeof value !== "string") continue;
		for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1]);
	}
	return [...names];
}

/** The reason a copied MCP config is a downgrade rather than a plain copy. */
function placeholderNote(config: Record<string, unknown>): string | undefined {
	const names = [...placeholderNames(config.env), ...placeholderNames(config.headers)];
	if (names.length === 0) return undefined;
	return `${names.map((name) => `\${${name}}`).join(", ")} is not expanded here — replace it with the value itself`;
}

function normalizeCodexMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const url = typeof entry.url === "string" ? entry.url : undefined;
	if (url) {
		const out: Record<string, unknown> = { type: "http", url };
		if (isRecord(entry.http_headers)) out.headers = entry.http_headers;
		if (typeof entry.bearer_token_env_var === "string") {
			downgrades.push(`its Authorization header came from $${entry.bearer_token_env_var}, which is not expanded here`);
		}
		if (isRecord(entry.env_http_headers)) {
			const names = Object.values(entry.env_http_headers).filter((value) => typeof value === "string");
			if (names.length > 0) {
				downgrades.push(
					`header values came from ${names.map((name) => `$${name}`).join(", ")}, which are not expanded here`,
				);
			}
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	const command = entry.command;
	if (typeof command === "string" && command) {
		const out: Record<string, unknown> = {
			type: "stdio",
			command,
			args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [],
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		const forwarded = Array.isArray(entry.env_vars)
			? entry.env_vars.filter((name): name is string => typeof name === "string")
			: [];
		if (forwarded.length > 0) {
			downgrades.push(
				`it expected ${summarizeNames(forwarded.map((name) => `$${name}`))} forwarded from your shell environment — ` +
					"set them under env here if it needs them",
			);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	return null;
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

/** Command frontmatter keys that do nothing once the file is a skill here. */
const UNHONORED_COMMAND_KEYS = ["allowed-tools", "model", "argument-hint"];

/**
 * Rewrite a source command file as a skill.
 *
 * The body is carried byte for byte — a command is prose the user wrote, and
 * the only part that has to change is the header, which this build reads as a
 * skill's `name`/`description`. Everything else the source understood is named
 * in the report rather than copied into a file that looks like it honours it:
 * `allowed-tools` and `model` do nothing here, and `$1`-`$9` and inline shell
 * expansion are never substituted.
 */
function commandAsSkill(file: RawFile): RawFile {
	const { data, body } = parseFrontmatter(file.content);
	const description = (data.description ?? "").replace(/\s+/g, " ").trim();
	// A description spread over several lines — a YAML block scalar, say — is
	// collapsed onto one: the reader here takes one line per key, and a header
	// that splits its own value would come back as an empty description.
	const header = [`name: ${file.name}`, ...(description ? [`description: ${description}`] : [])];
	const unhonored = UNHONORED_COMMAND_KEYS.filter((key) => data[key] !== undefined);
	return {
		...file,
		content: `---\n${header.join("\n")}\n---\n${body}`,
		detail: [
			"command imported as a skill: frontmatter rewritten to name/description",
			description ? "" : "the source had no description, so none was written",
			unhonored.length > 0 ? `${summarizeNames(unhonored)} is not honoured here` : "",
			"$ARGUMENTS is substituted, $1..$9 and inline shell expansion are not",
		]
			.filter(Boolean)
			.join("; "),
	};
}

/**
 * Command files become skills: a command is a named prompt, and a skill here is
 * exactly that, so this is a rewrite of the header rather than a translation.
 *
 * Codex's own importer turns Claude Code commands into skills the same way,
 * which is a sign the mapping is the intended one rather than merely the
 * convenient one.
 */
function planCommands(
	source: MigrationSourceId,
	commands: RawCommands,
	fromLabel: string,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	if (commands.skips.length > 0) {
		items.push({
			source,
			from: fromLabel,
			to: "—",
			action: "skip",
			detail: `${commands.skips.length} command file(s) not imported — ${summarizeNames(
				commands.skips.map((skip) => `${skip.path} (${skip.reason})`),
			)}`,
			containsSecret: false,
		});
	}
	collectFileWrites(
		source,
		commands.files.map(commandAsSkill),
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
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
				detail: `this ${kind} is already being written by this run — kept the first one`,
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
		const attachments = collectAttachmentWrites(file, path, force, items, writes, home, source, kind);
		items.push({
			source,
			from,
			to: tildePath(home, path),
			action: "map",
			detail:
				attachments.copied === 0
					? (file.detail ?? `${kind} copied verbatim`)
					: `${file.detail ?? `${kind} copied verbatim`}, with ${attachments.copied} supporting file(s)`,
			containsSecret: false,
		});
		if (file.attachmentSkips?.length) {
			// One line per file, whatever the mix of reasons: a skill with a dozen
			// images should not turn the report into a directory listing.
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `${file.attachmentSkips.length} supporting file(s) not copied — ${summarizeNames(
					file.attachmentSkips.map((skip) => `${skip.relativePath} (${skip.reason})`),
				)}`,
				containsSecret: false,
			});
		}
	}
}

/**
 * Queue the files that belong beside `file` (a skill's `references/`, say).
 *
 * They are written into the same directory as the file they arrived with, which
 * is what keeps a skill's internal links pointing at something real after the
 * move. A supporting file that is already at the target is kept rather than
 * overwritten, for the same reason the main file is: the user may have edited
 * it, and `--force` is how they say they did not.
 */
function collectAttachmentWrites(
	file: RawFile,
	mainPath: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
	home: string,
	source: MigrationSourceId,
	kind: PlannedWrite["kind"],
): { copied: number } {
	if (!file.attachments?.length) return { copied: 0 };
	const root = dirname(mainPath);
	let copied = 0;
	for (const attachment of file.attachments) {
		const path = join(root, attachment.relativePath);
		// Guarded rather than assumed: two entries resolving to one path would
		// otherwise write twice, and the report would show one of them only.
		if (writes.some((write) => write.path === path)) continue;
		if (existsSync(path) && !force) {
			items.push({
				source,
				from: tildePath(home, join(dirname(file.sourcePath), attachment.relativePath)),
				to: "—",
				action: "skip",
				detail: `supporting ${kind} file already exists at the target — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		writes.push({ path, kind, content: attachment.content, containsSecret: false });
		copied += 1;
	}
	return { copied };
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
		if (!input || input.seen === 0) continue;
		const from = `${MIGRATION_SOURCE_LABELS[source]} prompt history`;
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
