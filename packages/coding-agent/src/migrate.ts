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

import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseRuleText } from "@labunbun/agent";
import { resolveModel } from "@labunbun/ai";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { BUILT_IN_THEME_NAMES } from "@labunbun/tui";
import { codexRoot } from "./codex-home.ts";
import { type DshMcpRead, type DshMcpServer, readDshMcpServers } from "./dsh-cordis.ts";
import { DSH_DEFAULT_DIR, dshRoot } from "./dsh-home.ts";
import { GROK_DEFAULT_DIR, grokRoot, grokSessions } from "./grok-home.ts";
import { historyFilePath, readHistoryFile } from "./history.ts";
import { HOOK_EVENTS, type HookEventName, HooksConfigSchema } from "./hooks.ts";
import {
	KIMI_CODE_DEFAULT_DIR,
	kimiAgentsDir,
	kimiConfigPath,
	kimiLegacySourceRoot,
	kimiMcpFile,
	kimiPluginsDir,
	kimiRoot,
	kimiSkillsDir,
} from "./kimi-home.ts";
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
import {
	MINIMAX_DATA_DIR_BASENAME,
	MINIMAX_INSTALL_DIR,
	MINIMAX_LEGACY_DATA_DIR_BASENAME,
	MINIMAX_PROJECT_INSTRUCTION_FILES,
	MINIMAX_PROJECT_MCP_FILE,
	type MinimaxRoot,
	minimaxAgentsDir,
	minimaxConfigPath,
	minimaxDataState,
	minimaxDraftsDir,
	minimaxGlobalInstructionsPath,
	minimaxLegacyChatsDir,
	minimaxLegacyDataDir,
	minimaxMcpAliasFile,
	minimaxMcpFile,
	minimaxMemoryDir,
	minimaxPermissionFile,
	minimaxPlansDir,
	minimaxPluginsDir,
	minimaxRoot,
	minimaxSkillsDir,
	minimaxV2Root,
} from "./minimax-home.ts";
import { mergeSettings, OpenAICompatibleProviderSchema, type RawSettingsInput, SettingsSchema } from "./settings.ts";
// The same reader the skill loader uses, so what the importer writes back is
// what the loader will read.
import { parseFrontmatter } from "./skills.ts";
import { STEPCODE_DEFAULT_DIR, stepAssetDir, stepConfigDirName, stepConfigRoot, stepRoot } from "./step-home.ts";
import { readZcodeSettings, type ZcodeSettingRow } from "./zcode-db.ts";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type MigrationSourceId =
	| "claude-code"
	| "codex"
	| "zcode"
	| "agents"
	| "deepseek-harness"
	| "grok-build"
	| "kimi-code"
	| "minimax-code"
	| "step-code";

/**
 * Ordered as the picker and `--from` list them. New sources are appended: the
 * order is what `detectSources` reports, and reordering would silently change
 * which of two sources providing the same file wins.
 */
export const MIGRATION_SOURCE_IDS: MigrationSourceId[] = [
	"claude-code",
	"codex",
	"zcode",
	"agents",
	"deepseek-harness",
	"grok-build",
	"kimi-code",
	"minimax-code",
	"step-code",
];

/** Display names for the picker; the ids themselves are the CLI switches. */
export const MIGRATION_SOURCE_LABELS: Record<MigrationSourceId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	zcode: "ZCode",
	agents: "~/.agents (shared agent home)",
	"deepseek-harness": "DeepSeek Harness",
	"grok-build": "Grok Build",
	"kimi-code": "Kimi Code",
	"minimax-code": "MiniMax Code",
	"step-code": "Step Code",
};

/**
 * Directory that marks a source as present, relative to home.
 *
 * Only for the sources whose tree really is under `~`. dsh and grok both let an
 * environment variable put theirs anywhere, so their entries here are the
 * *default* spelling, used to render a label rather than to find the tree — see
 * {@link sourceRoot}, which is what detection and the readers call.
 */
const SOURCE_ROOTS: Record<MigrationSourceId, string> = {
	"claude-code": ".claude",
	codex: ".codex",
	zcode: ".zcode",
	agents: ".agents",
	"deepseek-harness": DSH_DEFAULT_DIR,
	"grok-build": GROK_DEFAULT_DIR,
	"kimi-code": KIMI_CODE_DEFAULT_DIR,
	"minimax-code": MINIMAX_DATA_DIR_BASENAME,
	"step-code": STEPCODE_DEFAULT_DIR,
};

/**
 * Where a source's tree actually is.
 *
 * Most roots are home-relative. Six are not: `$DSH_HOME`, `$GROK_HOME`,
 * `$CODEX_HOME`, `$KIMI_CODE_HOME`, MiniMax's pair of variables and Step's two
 * can each put their tree anywhere, and a reader that consulted `~/` anyway
 * would call the source absent while the importer went on to import from it —
 * or, worse here, detection would find it while the label named a path nobody
 * read. One function rather than a condition inside `detectSources`, so the
 * detection and the readers cannot disagree about which tree a source is.
 *
 * Step's entry is `stepRoot`, which is also the only one that is *not* a single
 * expression: the directory name itself is a setting (`$STEPCODE_CONFIG_DIR`),
 * an agent-directory override moves the tree out of the home entirely, and the
 * pre-rename `.step-harness` tree is read when the canonical one holds nothing.
 */
function sourceRoot(id: MigrationSourceId, home: string): string {
	if (id === "deepseek-harness") return dshRoot(home);
	if (id === "grok-build") return grokRoot(home);
	if (id === "codex") return codexRoot(home);
	if (id === "kimi-code") return kimiRoot(home);
	if (id === "minimax-code") return minimaxRoot(home).root;
	if (id === "step-code") return stepRoot(home);
	return join(home, SOURCE_ROOTS[id]);
}

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
	return MIGRATION_SOURCE_IDS.filter((id) => sourceHasContent(sourceRoot(id, home)));
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

/**
 * Kimi Code's user state.
 *
 * Two trees matter and they are not the same tree: the engine's home
 * (`$KIMI_CODE_HOME`, else `~/.kimi-code` — `app/bootstrap/bootstrap.ts`) and the
 * CLI's data directory (`apps/kimi-code/src/utils/paths.ts`). They disagree on
 * exactly one value, and {@link kimiRoot} follows the CLI, with the reason in its
 * own docstring. Nothing else is done to the value: no `~` expansion, no
 * `resolve`, no existence requirement — the same three things `dsh-home.ts` does
 * and `grok-home.ts` refuses, which is why each source keeps its own reader.
 */
export interface RawKimiCode {
	/** Resolved home: `$KIMI_CODE_HOME` when it holds anything, else `~/.kimi-code`. */
	root: string;
	present: boolean;
	/** `<root>/config.toml`, parsed. Empty when absent or unparseable. */
	config: Record<string, unknown>;
	/** Why `config.toml` contributed nothing, when it was there but unreadable. */
	configError?: string;
	/**
	 * `<root>/mcp.json` — a bare `{name: server}` map, not the `{"mcpServers": …}`
	 * wrapper this build's own file uses (`mcpCore/configLoader.ts` reads it into a
	 * `Record<string, McpServerConfig>` directly).
	 */
	mcp: Record<string, unknown>;
	/** Why `mcp.json` contributed nothing, when it was there but unreadable. */
	mcpError?: string;
	/** `<root>/AGENTS.md` — the user-global instruction document. */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
	/**
	 * `[extraSkillDirs]` / `[extraAgentDirs]` entries this reader opened: the ones
	 * spelled `~`, `~/…` or absolute. A relative entry resolves against the
	 * *source's* own project root (`resolveAgentPath`), which is the repository
	 * kimi was started in rather than the one being migrated into.
	 */
	extraSkillDirs: string[];
	extraAgentDirs: string[];
	/** Those same entries when they name a project-relative path — named, never opened. */
	projectScopedSkillDirs: string[];
	projectScopedAgentDirs: string[];
	/** The raw `[[hooks]]` array, as written. */
	hookDefs: unknown;
	/** Which of `~/.agents/{AGENTS.md,skills,agents}` exist — that tree is the `agents` source's. */
	sharedTree: string[];
	/** Plugin directories under `<root>/plugins`, by name. Counted; never walked. */
	pluginNames: string[];
	/** Credential-shaped entries under the root, by name. Reported; never opened. */
	credentialEntries: string[];
	/** Directories under the root this importer has no mapping for, with entry counts. */
	otherDirs: Array<{ name: string; count: number }>;
	/**
	 * The predecessor tree (`~/.kimi`, or `$KIMI_SHARE_DIR`), when it is there.
	 *
	 * A different product's directory with its own migrate screen inside Kimi Code
	 * (`apps/kimi-code/src/migration/`), and a layout this reader does not parse:
	 * named so the user knows this run saw it and left it, not read.
	 */
	legacy: { root: string; origin: "default" | "share-dir"; skillsRoot?: string } | null;
}

export interface RawClaudeCode {
	/** ~/.claude/settings.json */
	settings: Record<string, unknown>;
	/** ~/.claude.json — mostly runtime state; only a few keys are migratable. */
	state: Record<string, unknown>;
	/**
	 * `~/.claude/CLAUDE.md` — the user's own global instructions, read by Claude
	 * Code on every project (`utils/claudemd.ts`, the "user memory" entry).
	 */
	memory: string | null;
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
	/** The resolved Codex home (`$CODEX_HOME`, else `~/.codex`). */
	root: string;
	/** Parsed <codex home>/config.toml */
	config: Record<string, unknown>;
	/** The instruction document Codex reads: `AGENTS.override.md`, else `AGENTS.md`. */
	memory: string | null;
	/** Which of the two names supplied {@link memory}; null when neither holds anything. */
	memoryFile: string | null;
	/**
	 * The other name, when it holds a document of its own. Codex reads one of the
	 * two and this is the one it does not — a file the user may believe is in force.
	 */
	memoryShadowed: string | null;
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
	/** Profile names under `<codex home>/*.config.toml` — named, never merged. */
	profileArchives: string[];
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

/**
 * DeepSeek Harness (`dsh`): the whole user state lives under one root, and
 * `$DSH_HOME` decides where that root is (see {@link dshRoot}) — so the resolved
 * root travels with the data, and every report line is written from it rather
 * than from a guess about `~`.
 */
export interface RawDeepSeekHarness {
	/** Resolved harness home: `$DSH_HOME` when set, else `~/.dsh`. */
	root: string;
	present: boolean;
	/** <root>/AGENTS.md */
	memory: string | null;
	skills: RawFile[];
	/** Top-level sections of the settings document; its keys are settings namespaces. */
	settings: Record<string, unknown>;
	/**
	 * The settings document that was read, when there was one: its file name, and —
	 * when it could not be parsed — the fact that is worth reporting. Absent when
	 * the root holds no settings file, which is why the plan says nothing about one.
	 */
	settingsSource?: { file: string; error?: string };
	/** MCP servers declared by the root's cordis patches, as the sibling reader found them. */
	mcp: DshMcpRead;
	/** Entries under `.agent-presets`, in either spelling the discovery reads — counted, never read. */
	presetCount: number;
	/** Live session logs under `sessions` — counted, never read. */
	sessionCount: number;
	/** `<root>/.credentials.yaml` exists. Reported by name; never opened. */
	credentialsPresent: boolean;
	/** `<root>/.env` exists. Reported by name; never opened. */
	envFilePresent: boolean;
	/** `<root>/attachments` exists — session payloads, reported by name only. */
	attachmentsPresent: boolean;
	/** `<root>/storages` exists — non-session storage, reported by name only. */
	storagesPresent: boolean;
}

/**
 * Grok Build: one home that `$GROK_HOME` can put anywhere, holding a TOML
 * config, the skill/rule/agent/command trees, plugins, and the sessions.
 *
 * The root travels with the data for the same reason dsh's does — every report
 * line is written from it rather than from a guess about `~`.
 */
export interface RawGrokBuild {
	/** Resolved grok home: `$GROK_HOME` when set, else `~/.grok`. */
	root: string;
	present: boolean;
	/** `<root>/config.toml`, parsed. Empty when absent or unparseable. */
	config: Record<string, unknown>;
	/**
	 * Why `config.toml` contributed nothing, when it was there but unreadable.
	 * Carried so a broken config is reported rather than looking like an absent one.
	 */
	configError?: string;
	/**
	 * Key paths in `config.toml` that grok's parser reads one way and this build's
	 * parser reads not at all, as the file spells them (`model.grok-4.6`).
	 *
	 * Not a defect in the user's file: a digits-only segment after a dot is legal
	 * TOML — `[model.grok-4.6]` is the path `model` → `grok-4` → `6`, one table
	 * nested in another, and grok reads it as such — while `Bun.TOML` rejects the
	 * whole document over it. See {@link requoteNumericKeyPaths}.
	 */
	configDottedKeys: string[];
	/** The user-global instruction file: the first of grok's own names that exists. */
	memory: string | null;
	/**
	 * The global document of grok's memory subsystem, read from the tree grok's
	 * own switch selects: `<root>/memory/MEMORY.md`, or
	 * `<root>/memory-v2/global/MEMORY.md` when `[memory_v2] enabled` is true.
	 */
	globalMemory: string | null;
	/**
	 * Which of the two memory trees `globalMemory` came from, and the path of the
	 * other one's document when it exists. The trees are isolated — v2 cannot see
	 * the legacy root — so the loser of the switch is named rather than merged.
	 */
	globalMemorySource: { generation: "legacy" | "v2"; other: string | null };
	/** Workspace-scoped memory documents (legacy and v2) — counted, never read. */
	memoryWorkspaceCount: number;
	skills: RawFile[];
	/**
	 * Skills the source's own config switches off, with the key that switched
	 * them off. Reported as skips rather than dropped in silence: a user who
	 * disabled a skill in grok still knows it exists, and one who forgot will
	 * notice it missing here.
	 */
	skillSkips: Array<{ name: string; reason: string }>;
	/** `[skills] paths` as written, so the plan can say where it looked. */
	skillPaths: string[];
	/** `[skills] server_skill_dirs` entries — launcher-synced, counted, never read. */
	serverSkillDirCount: number;
	/** `[skills] bundled_skill_dirs` entries — shipped with the platform, counted, never read. */
	bundledSkillDirCount: number;
	rules: RawFile[];
	agents: RawFile[];
	/**
	 * `<root>/commands/*.md`, which grok loads as skills, plus the same from every
	 * plugin.
	 */
	commands: RawCommands;
	/**
	 * User-authored trees grok reads that have no landing place here, with how
	 * many entries each holds. Only the non-empty ones appear.
	 */
	unimported: Array<{ name: string; count: number }>;
	/** Skills and agents lifted out of plugin directories, each marked with its plugin. */
	pluginSkills: RawFile[];
	pluginAgents: RawFile[];
	/** Plugin directories found under grok's own plugin roots. */
	pluginCount: number;
	/** Plugin-provided `.mcp.json` files and `hooks/hooks.json` files — counted, never read. */
	pluginMcpCount: number;
	pluginHookCount: number;
	/** `<root>/bundled` exists — grok's own shipped skills and agents, never read. */
	bundledPresent: boolean;
	/** `<root>/marketplace-cache` exists — downloaded plugins, never read. */
	marketplaceCachePresent: boolean;
	/** `<root>/lsp.json` exists — language-server config, reported by name. */
	lspPresent: boolean;
	/** `<root>/pager.toml` exists — UI preferences, reported by name. */
	pagerPresent: boolean;
	/** `<root>/claude_import_state.json` exists — grok's own record of a Claude import. */
	claudeImportStatePresent: boolean;
	/** Sessions under `<root>/sessions` — counted; the history importer reads them. */
	sessionCount: number;
	/** `<root>/auth.json` exists — the account's tokens. Reported by name; never opened. */
	authPresent: boolean;
	/** `<root>/mcp_credentials.json` exists — MCP OAuth tokens. Reported by name; never opened. */
	mcpCredentialsPresent: boolean;
	/** Runtime artifacts under the home that exist, named so their absence from the plan reads as a decision. */
	runtimePresent: string[];
	/**
	 * Directories outside `$GROK_HOME` that grok itself reads — its compatibility
	 * trees and the `[paths]` extras pointing at them. Named so the plan can say
	 * who owns them instead of leaving their absence unexplained.
	 */
	vendorTrees: string[];
	/**
	 * Machine-policy layers that sit outside the user's own config: the ones in
	 * `<root>` that exist, named so the plan can say they were deliberately left.
	 */
	machinePolicy: string[];
}

/**
 * Why one MiniMax rule could not become a rule here.
 *
 * `inert-there` — MiniMax itself never consults it, so leaving it behind costs
 * nothing: the tool name matches no tool it has (`permissionToolMatches`,
 * `local-runtime/src/permissions/rule-match.ts:87-91`) or the matcher speaks
 * about an action the tool does not perform (`:63-67`).
 *
 * `no-specifier-grammar` — MiniMax does consult it, and this engine does not:
 * a specifier is only read for `Bash`, `Read`, `Write`, `Edit` and MCP tool
 * names (`packages/agent/src/permissions.ts:213-245`). This one is a real loss
 * and the direction of the loss depends on the behavior.
 */
export type MinimaxRuleDropReason = "inert-there" | "no-specifier-grammar";

/** One rule that did not come across, with the name it was written under. */
export interface MinimaxRuleDrop {
	/** The rule as the source spells it, e.g. `glob(/etc/**)`. */
	rule: string;
	/** The tool name the source used, so the report can group by it. */
	tool: string;
	behavior: "allow" | "deny";
	reason: MinimaxRuleDropReason;
}

/**
 * `~/.minimax/permission.json`, decoded into rule text this build's engine reads.
 *
 * The file holds the user's allow/deny/ask decisions in one of two generations
 * (`local-runtime/src/permissions/rule-codec.ts`): v1 is a Claude-Code-shaped
 * `{allow, deny, ask}` of `Tool(pattern)` strings, v2 is
 * `{version: 2, allow, deny, ask}` of `{tool_name, matcher}` records whose
 * matcher is `tool`, `command` or `path` — and only the `path` matcher carries
 * an `actions` list, because the other two are already scoped by the tool.
 *
 * The two engines are close relatives: MiniMax's v1 grammar is Claude Code's,
 * and this build's `Tool(specifier)` grammar is the same family, so a rule
 * carries as text with its tool name translated. The exceptions are the ones
 * the two engines do not agree on, and they are named one by one in
 * {@link notCarried} rather than left to be discovered.
 */
export interface MinimaxPermissions {
	allow: string[];
	deny: string[];
	/** `ask` rules, by count: this build's settings hold allow and deny only. */
	askCount: number;
	/** Which generation of the file was read. */
	version: 1 | 2;
	notCarried: MinimaxRuleDrop[];
	/**
	 * Bash rules that ended in `:*` over there, as the source spelled them.
	 *
	 * MiniMax reads that suffix as its own word-boundary command prefix
	 * (`matchesCommandPrefix`, `rule-match.ts:141-148`), a shape this build's
	 * engine does not have: a Bash specifier here is a glob over the whole
	 * command line (`packages/agent/src/permissions.ts:213-222`), so a rule
	 * carried verbatim as `Bash(sed:*)` would match the literal text `sed:` and
	 * nothing else — a dead allow *and* a dead deny. These are carried as
	 * `Bash(sed*)`, the closest one-rule equivalent, and the two ways that is
	 * wider are named in the report rather than left in the code.
	 */
	widened: string[];
}

/**
 * MiniMax Code's user state.
 *
 * One tree, in one of three places: `$MINIMAX_DATA_DIR`, else `$MAVIS_DATA_DIR`,
 * else `<home>/.minimax` — {@link minimaxRoot} owns that rule, including the
 * trim and the refusal to expand `~`. The predecessor tree `<home>/.mavis` is a
 * second question rather than a second source: it is the same tree under its
 * older name, and {@link minimaxLegacyDataDir} answers "separate directory, or
 * a link to the one we already have" the way the vendor answers it.
 */
export interface RawMinimaxCode {
	/** The tree that was read — see {@link legacyRead} for which one that is. */
	root: string;
	/** Which rule named {@link root}: an override, the older override, or the default. */
	origin: MinimaxRoot["origin"];
	present: boolean;
	/**
	 * `~/.mavis` (or `$MAVIS_DATA_DIR`) when it is a genuinely separate tree, so
	 * the report can say whether this run read it.
	 */
	legacyRoot: string | null;
	/**
	 * True when the rules above produced {@link root} — the vendor renames that
	 * tree into `.minimax` on its next start, so on a machine that has not run a
	 * current build it is the only tree there is.
	 */
	legacyRead: boolean;
	/** `<root>/config.yaml` — the one global settings document. */
	config: Record<string, unknown>;
	/** Why `config.yaml` contributed nothing, when it was there but unreadable. */
	configError?: string;
	permissions: MinimaxPermissions;
	/**
	 * Why `permission.json` contributed nothing.
	 *
	 * Set for every way the file can be unusable, because MiniMax treats them the
	 * same way: one malformed entry, one unknown version, a corrupt document or a
	 * shape that is not an object all raise `LocalPermissionStoreUnhealthyError`
	 * (`local-runtime/src/permissions/rules.ts:214-262`), which its callers turn
	 * into "ask about everything" rather than "allow everything". Rules out of a
	 * store the source itself refuses are intentions currently in force nowhere,
	 * so none of them is imported.
	 */
	permissionError?: string;
	/** `<root>/mcp.json` — a `{"mcpServers": {…}}` wrapper, as this build's own file. */
	mcp: Record<string, unknown>;
	/**
	 * `<root>/mcp/mcp.json` — the older spelling of the same document, read
	 * whatever the first file holds, because a name in it that the first file
	 * does not define is a server the user wrote and never sees again.
	 */
	mcpAlias: Record<string, unknown>;
	/** Why a file contributed nothing, when it was there but unreadable, each named. */
	mcpErrors: string[];
	/** `<root>/AGENTS.md` — the user-global instruction document. */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
	/** Agent directories with no `agent.md`, by name: MiniMax keeps no roster entry for them either. */
	agentSkips: Array<{ name: string; reason: string }>;
	/** The agent copies MiniMax ships under `agents/.builtin`, by name. Counted; never read. */
	builtinAgentNames: string[];
	/**
	 * Skill trees under `agents/<name>/skills`, by agent, with their entry
	 * counts. Scoped to one agent over there, global here — named, not imported.
	 */
	agentSkillTrees: Array<{ name: string; count: number }>;
	/** The vendor's own skills under `<root>/.builtin-skills`. Counted; never read. */
	builtinSkillNames: string[];
	/** Plugin directories under `<root>/plugins`, by name. Counted; never walked. */
	pluginNames: string[];
	/** Plan documents under `<root>/plans`, by name. Counted; never read. */
	planNames: string[];
	/**
	 * `<root>/review-rules`, by name — the user's own instructions for the code
	 * reviewer, which MiniMax splices into a review prompt as
	 * `<user-review-rules>` (`local-runtime/src/review/preparation.ts:80-82`).
	 * Named rather than imported: a rule here is read in every session, and this
	 * one was written for a review turn.
	 */
	reviewRules: string[];
	/** `<root>/memory` entries, by name. Counted; never read. */
	memoryNames: string[];
	/**
	 * `v2/` subdirectories this importer reads nothing out of, by name.
	 *
	 * `chats` holds the pre-`v2` session ledgers and `mcode/drafts` the composer
	 * text a user typed and never sent. Both are the user's own writing and
	 * neither is a settings document, so they are named and left.
	 */
	unreadV2Dirs: string[];
	/**
	 * Entry names under the root that look like credentials — `auth`,
	 * `credentials`, `cli-auth` and anything else matching the same pattern.
	 * Reported by name; never opened.
	 */
	credentialEntries: string[];
	/** Directories under the root this importer has no mapping for, with entry counts. */
	otherDirs: Array<{ name: string; count: number }>;
	/** `~/.minimax-code`, the installer's own directory. Named when it exists; never read. */
	installDirPresent: boolean;
	/**
	 * Trees other sources own that MiniMax reads by borrowing them: the `agents`
	 * source's `~/.agents/skills`, and Claude Code's and Codex's skill
	 * directories, which MiniMax lists as skill sources of its own.
	 */
	borrowedTrees: string[];
}

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
 * for a model.
 *
 * The model name is resolved when a subagent starts, against the models this
 * build knows (`subagents.ts`). A name that resolves is used; one that does not
 * falls back to the session's model and says so at the spawn. The note here is
 * therefore about which of those two the user should expect, not about a field
 * being ignored — it used to read "is not honoured", which stopped being true
 * when that resolution landed, and a report that describes behaviour the build
 * does not have is the same defect as a silent mismatch.
 */
function readAgentFiles(dir: string): RawFile[] {
	const files = readMarkdownDir(dir);
	for (const file of files) {
		const { data } = parseFrontmatter(file.content);
		if (data.model) {
			file.detail = `agent copied verbatim; its "model: ${data.model}" frontmatter is resolved when a subagent starts — a name that no longer resolves falls back to the session model and says so`;
		}
	}
	return files;
}

export function readClaudeCode(home: string): RawClaudeCode {
	const root = join(home, ".claude");
	return {
		settings: readJson(join(root, "settings.json")),
		state: readJson(join(home, ".claude.json")),
		memory: readText(join(root, "CLAUDE.md")),
		skills: readSkillDirs(join(root, "skills")),
		rules: readMarkdownDir(join(root, "rules")),
		agents: readAgentFiles(join(root, "agents")),
		commands: readCommandFiles(join(root, "commands")),
		present: existsSync(root),
	};
}

export function readCodex(home: string): RawCodex {
	const root = codexRoot(home);
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
		root,
		config,
		...readCodexInstructions(root),
		skills: readSkillDirs(join(root, "skills")),
		agents: readAgentFiles(join(root, "agents")),
		prompts: readCommandFiles(join(root, "prompts")),
		execpolicy: readRuleFiles(join(root, "rules")),
		hooksPresent: existsSync(join(root, "hooks.json")),
		agentTomlCount: countFilesWithExtension(join(root, "agents"), ".toml"),
		profileArchives: readCodexProfileArchives(root),
		present: existsSync(root),
	};
}

/**
 * The global instruction document, and which of the two names supplied it.
 *
 * `AGENTS.override.md` wins over `AGENTS.md` when both are there
 * (`codex-home/src/instructions/mod.rs:47-79`, and the core copy of the same
 * rule), and the loser is not read at all — this is a preference, not a merge,
 * unlike the six names grok joins. Reading `AGENTS.md` unconditionally, as this
 * reader used to, imports the file the user left behind when they wrote the
 * override: a document Codex does not read, presented as the user's memory.
 *
 * "Wins" is decided the way Codex decides it: the first name that exists as a
 * file *and* holds something other than whitespace. A present-but-empty
 * override falls through to `AGENTS.md` in Codex, so it does here too.
 */
function readCodexInstructions(root: string): Pick<RawCodex, "memory" | "memoryFile" | "memoryShadowed"> {
	const documents: Array<[name: string, text: string | null]> = [
		["AGENTS.override.md", readText(join(root, "AGENTS.override.md"))],
		["AGENTS.md", readText(join(root, "AGENTS.md"))],
	];
	const decided = documents.find(([, text]) => text !== null && text.trim() !== "");
	if (decided === undefined) return { memory: null, memoryFile: null, memoryShadowed: null };
	// The other name is recorded only when it holds something: an empty file next
	// to the one in force is not a document the user is losing.
	const shadowed = documents.find(([name, text]) => name !== decided[0] && text !== null && text.trim() !== "");
	return { memory: decided[1], memoryFile: decided[0], memoryShadowed: shadowed === undefined ? null : shadowed[0] };
}

/**
 * `<CODEX_HOME>/<name>.config.toml` — the profile files `--profile <name>` loads.
 *
 * Named rather than read: each one is a whole second `config.toml` whose keys
 * override the base file, and merging two configs into one report is a decision
 * the user has to make with the profile name in hand — the base file here is
 * imported as the configuration, and a profile's overrides are not in force
 * unless Codex was started with that switch.
 */
function readCodexProfileArchives(root: string): string[] {
	try {
		return readdirSync(root)
			.filter((name) => name.endsWith(".config.toml"))
			.map((name) => name.slice(0, -".config.toml".length))
			.filter((name) => name !== "")
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
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

/** Settings documents the harness reads, in the order it looks for one. */
const DSH_SETTINGS_FILES = ["settings.yaml", "settings.yml", "settings.json"];

export function readDeepSeekHarness(home: string): RawDeepSeekHarness {
	const root = dshRoot(home);
	return {
		root,
		present: existsSync(root),
		memory: readText(join(root, "AGENTS.md")),
		skills: readDshSkills(join(root, "skills")),
		...readDshSettings(root),
		mcp: readDshMcpServers(root),
		presetCount: countDshPresets(join(root, ".agent-presets")),
		sessionCount: countDshSessionLogs(join(root, "sessions")),
		// Existence only, and deliberately no more than that: both files hold
		// credentials the harness resolves through its own credential service, and
		// a migration has no use for a secret it may not even name in the report.
		credentialsPresent: existsSync(join(root, ".credentials.yaml")),
		envFilePresent: existsSync(join(root, ".env")),
		// Session payloads and non-session storage. Named in the report so their
		// absence from the plan reads as a decision; the trees are large and
		// binary, so neither is walked.
		attachmentsPresent: existsSync(join(root, "attachments")),
		storagesPresent: existsSync(join(root, "storages")),
	};
}

/**
 * Instruction file names grok reads from its home, in grok's own order.
 *
 * grok's list has six names (`INSTRUCTION_FILENAMES`,
 * `xai-grok-tools/src/types/compat.rs:309-316`): `Agents.md`, `Claude.md`,
 * `CLAUDE.md`, `CLAUDE.local.md`, `AGENT.md`, `AGENTS.md`. Three of them are
 * Claude Code's spelling, and grok carries them for its compat cells — it also
 * appends `.claude/CLAUDE.md` and `.claude/CLAUDE.local.md` when the claude cell
 * is on (`agent_filenames`, `:376-382`). Those files live in `~/.claude`, which
 * the `claude-code` source owns here; reading them from this one would land a
 * second copy of the same document, which is the scope decision this file makes
 * everywhere else about vendor trees. The remaining three are grok's own names
 * for the same document.
 *
 * `AGENT.md` used to be left out, on a comment that called the pair it sat beside
 * "grok's own rather than a vendor's". That reason covers `CLAUDE.md` and does not
 * cover `AGENT.md`, which is the singular spelling of grok's own name: a user with
 * `AGENT.md` and not `AGENTS.md` had an instruction file grok reads and this
 * importer walked past.
 *
 * `Agents.md` is not a typo and the case matters twice over: grok carries the
 * capitalised spelling first for case-sensitive filesystems, and a user who has
 * one spelling and not the other has an instruction file grok reads. All of them
 * that exist are read, not the first — grok collects every name it finds
 * (`compat.rs:309`, `read_file/mod.rs:268-275`).
 */
const GROK_INSTRUCTION_FILES = ["Agents.md", "AGENT.md", "AGENTS.md"];

/**
 * Where grok keeps plugins the user put there by hand: one directory each
 * (`scan_plugin_dir` reads direct children, sorted — `discovery.rs:454`).
 *
 * grok's other plugin sources are `~/.claude/plugins` and its marketplace
 * registries, and it explicitly does **not** scan a legacy `~/.grok/plugins`
 * when `$GROK_HOME` points elsewhere, because "trust, persisted data, and install
 * paths all resolve under `grok_home()`, so a legacy scan would be
 * half-initialized" (`discovery.rs:197-200`). This reader follows it in both
 * directions: the vendor tree is another source's, and the legacy tree is not
 * grok's.
 */
const GROK_PLUGIN_DIR = "plugins";

/** grok's marketplace install directory, overridable with `[plugins].install_dir`. */
const GROK_INSTALL_DIR = "installed-plugins";

/** Manifests that make a directory a plugin, in the order grok looks for one. */
const GROK_PLUGIN_MANIFESTS = [
	"plugin.json",
	join(".grok-plugin", "plugin.json"),
	join(".claude-plugin", "plugin.json"),
];

/** A plugin's MCP declaration, and its hooks — both change what the process does. */
const GROK_PLUGIN_MCP = ".mcp.json";
const GROK_PLUGIN_HOOKS = join("hooks", "hooks.json");

/** The component names that make a directory a plugin when it has no manifest. */
const GROK_PLUGIN_COMPONENTS = ["skills", "commands", "agents", GROK_PLUGIN_MCP, GROK_PLUGIN_HOOKS];

/**
 * Entries grok keeps under its home that are caches, logs, binaries or machine
 * state — present so the plan can say they were left, never read.
 *
 * Every name here was checked at its join site rather than inferred from a
 * plausible-sounding directory: `hooks.log` and `memory.log` live under `logs/`,
 * so naming them at the top level would report a real artifact as missing.
 */
const GROK_RUNTIME_ENTRIES = [
	"logs",
	"crash",
	"debug",
	"memtrace",
	"trace-exports",
	"downloads",
	"plugin-data",
	"upload_queue",
	"bin",
	"vendor",
	"completions",
	"docs",
	"indexes",
	"dashboard",
	"worktrees",
	"worktree_pool",
	"worktrees.db",
	"leader.log",
	"leader.sock",
	"version.json",
	"models_cache.json",
	"announcements.json",
	"campaigns_state.json",
	"tip_cursor.json",
	"slash-mru.json",
	"last-copy.txt",
	"active_sessions.json",
	"managed_config_cache.json",
	"agent_id",
	".metadata_version",
	".config-init.lock",
];

/**
 * User-authored trees grok reads that have nothing to land in here, counted and
 * named so each absence is a decision rather than an omission.
 *
 * These are the four that a migration would otherwise silently drop: `personas`
 * and `roles` are grok's own `.toml` definitions, `workflows` are `.rhai`
 * scripts, `agent-memory` is per-agent memory, and `hooks` holds the user's own
 * hook scripts — this build has a hooks system, but a grok hook is a shell script
 * wired through grok's own `hooks.json`, which is a different contract rather
 * than a different spelling of this one.
 */
const GROK_UNIMPORTED_DIRS = ["personas", "roles", "workflows", "agent-memory", "hooks"];

/**
 * Grok Build's user state, read from `$GROK_HOME`.
 *
 * Only this tree is read, and that is the load-bearing decision here. grok
 * itself reads `~/.claude`, `~/.cursor` and `~/.agents` through its compatibility
 * table, and `/import-claude` writes those paths into `[paths] extra_skill_dirs`
 * and `extra_rule_dirs` — but the `claude-code` and `agents` sources in this
 * build already own those trees. Importing them again from here would produce
 * two copies of every skill, so the compat trees are named in the plan and left
 * where they are. `claude_import_state.json` is read for its existence alone and
 * reported, because it is the plainest evidence that grok has already carried
 * that tree across once.
 *
 * Credentials are touched by `existsSync` and nothing else. grok keeps two at
 * this level — `auth.json` for the account and `mcp_credentials.json` for MCP
 * OAuth tokens — and both are named rather than opened. (An earlier reading of
 * this tree concluded `auth.json` was the only one, from the fact that the config
 * watcher special-cases it; that watcher only watches *config* files, which is a
 * different question than what holds a secret.)
 */
export function readGrokBuild(home: string): RawGrokBuild {
	const root = grokRoot(home);
	const config = readGrokConfig(root);
	const switches = readGrokSkillsConfig(config.config);
	const own = readGrokSkills(join(root, "skills"), switches, home);
	const plugins = readGrokPlugins(root, config.config, switches);
	const extra = readGrokSkillPaths(home, switches);
	const ownCommands = readGrokCommands(join(root, "commands"), "");
	return {
		root,
		present: existsSync(root),
		...config,
		memory: readGrokInstructions(root),
		...readGrokGlobalMemory(root, config.config),
		memoryWorkspaceCount: countGrokWorkspaceMemory(root),
		skills: [...own.files, ...extra.files],
		skillSkips: [...own.skips, ...extra.skips, ...plugins.skips],
		skillPaths: switches.paths,
		serverSkillDirCount: switches.serverDirCount,
		bundledSkillDirCount: switches.bundledDirCount,
		rules: readMarkdownDir(join(root, "rules")),
		agents: readAgentFiles(join(root, "agents")),
		commands: {
			files: [...ownCommands.files, ...plugins.commands],
			skips: [...ownCommands.skips, ...plugins.commandSkips],
		},
		pluginSkills: plugins.skills,
		pluginAgents: plugins.agents,
		pluginCount: plugins.pluginCount,
		pluginMcpCount: plugins.mcpCount,
		pluginHookCount: plugins.hookCount,
		bundledPresent: existsSync(join(root, "bundled")),
		marketplaceCachePresent: existsSync(join(root, "marketplace-cache")),
		lspPresent: existsSync(join(root, "lsp.json")),
		pagerPresent: existsSync(join(root, "pager.toml")),
		claudeImportStatePresent: existsSync(join(root, "claude_import_state.json")),
		unimported: GROK_UNIMPORTED_DIRS.map((name) => ({ name, count: countTreeEntries(join(root, name)) })).filter(
			(entry) => entry.count > 0,
		),
		sessionCount: grokSessions(root).length,
		authPresent: existsSync(join(root, "auth.json")),
		mcpCredentialsPresent: existsSync(join(root, "mcp_credentials.json")),
		machinePolicy: GROK_MACHINE_POLICY.filter((name) => existsSync(join(root, name))),
		runtimePresent: GROK_RUNTIME_ENTRIES.filter((name) => existsSync(join(root, name))),
		vendorTrees: readGrokVendorTrees(home, config.config, extra.vendorTrees),
	};
}

/**
 * A config path with a leading `~` expanded, the way grok expands it.
 *
 * `expand_tilde_in` (`prompt/paths.rs:48`) matches exactly two spellings — `~`
 * alone and `~/…` — and passes everything else through untouched. The narrowness
 * is worth copying: on Windows `~\x` looks like it ought to expand and does not,
 * so expanding it here would read a directory grok itself never opens.
 */
function expandGrokTilde(home: string, raw: string): string {
	if (raw === "~") return home;
	if (raw.startsWith("~/")) return join(home, raw.slice(2));
	return raw;
}

/** The last non-empty path segment: what a file, or a skill's own directory, is called. */
function leafName(path: string): string {
	const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
	return parts[parts.length - 1] ?? "";
}

/**
 * The `[skills]` keys that decide which skills exist, and the two that name
 * directories someone else put there.
 *
 * grok's own doc comments (`prompt/skills.rs:21-48`) are the source of each:
 * `paths` are extra locations to load, `ignore` are path prefixes to exclude,
 * `disabled` are skill *names* that stay listed but never load, and the last two
 * are directories the launcher syncs in from the server and from the platform
 * bundle. Those two are not the user's own skills to move between tools, so they
 * are counted and named rather than walked.
 */
interface GrokSkillSwitches {
	paths: string[];
	ignore: string[];
	disabled: string[];
	serverDirCount: number;
	bundledDirCount: number;
}

function readGrokSkillsConfig(config: Record<string, unknown>): GrokSkillSwitches {
	const skills = isRecord(config.skills) ? config.skills : {};
	return {
		paths: grokStringList(skills.paths),
		ignore: grokStringList(skills.ignore),
		disabled: grokStringList(skills.disabled),
		serverDirCount: grokStringList(skills.server_skill_dirs).length,
		bundledDirCount: grokStringList(skills.bundled_skill_dirs).length,
	};
}

/** A TOML string array. A scalar of another type is not a path and not a skill name. */
function grokStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Which vendor roots a `[paths]` / `[skills]` entry belongs to, and whether it
 * is one of them.
 *
 * grok's compatibility table makes it read `~/.claude`, `~/.cursor` and
 * `~/.agents`, and `/import-claude` writes those into `[paths]
 * extra_skill_dirs` and `extra_rule_dirs`. This build has its own `claude-code`
 * and `agents` sources for exactly those trees, so an entry pointing into one is
 * another source's to bring — importing it here too would land two copies of
 * every skill, and the second copy would be attributed to the wrong tool.
 */
const GROK_VENDOR_DIRS = [".claude", ".cursor", ".agents"];

function vendorTreeOf(path: string): string | null {
	const parts = path.replace(/\\/g, "/").split("/");
	for (const dir of GROK_VENDOR_DIRS) {
		if (parts.includes(dir)) return dir;
	}
	return null;
}

/**
 * The trees outside `$GROK_HOME` that grok itself reads, so the plan can name who
 * owns each instead of leaving it unexplained.
 *
 * Two independent reasons a tree lands here: grok's compatibility table makes it
 * read the vendor directories under the user's home, and `[paths]` or
 * `[skills] paths` can name one outright. Both come back as bare directory names,
 * because that is how the plan speaks about them (`~/.claude`).
 *
 * `home` rather than the grok root is deliberate and load-bearing: these trees
 * live beside the user's home, not beside `$GROK_HOME`, so a `$GROK_HOME` of
 * `/srv/grok` would otherwise have its sibling directories probed for `.claude`.
 */
function readGrokVendorTrees(home: string, config: Record<string, unknown>, fromPaths: string[]): string[] {
	const named = new Set<string>(fromPaths);
	for (const dir of GROK_VENDOR_DIRS) {
		if (existsSync(join(home, dir))) named.add(dir);
	}
	const paths = isRecord(config.paths) ? config.paths : {};
	for (const key of ["extra_skill_dirs", "extra_rule_dirs"]) {
		for (const entry of grokStringList(paths[key])) {
			const tree = vendorTreeOf(entry);
			if (tree !== null) named.add(tree);
		}
	}
	return [...named].sort();
}

/**
 * Every instruction document grok reads from its home, as one text.
 *
 * **All** of them, not the first that exists: grok collects every name in
 * `INSTRUCTION_FILENAMES` it finds under the root and injects each one
 * (`find_agent_files`, `agents_md.rs:316`), so a user on a case-sensitive
 * filesystem with both spellings has two documents and grok reads two. Taking
 * only the first would drop one of them in silence.
 *
 * Deduped by the text itself. grok dedups by canonical path (`seen_canonical`),
 * and the case where that matters is a case-insensitive filesystem, where both
 * spellings are one file: reading it twice would put the user's instructions into
 * the imported rule twice. Text identity settles that case without asking the
 * platform which kind of filesystem it is on — and the only other case it
 * collapses is two files that say the same thing, which would have been a
 * duplicate either way. Two *different* instruction files still both arrive.
 */
function readGrokInstructions(root: string): string | null {
	const seen = new Set<string>();
	const documents: string[] = [];
	for (const name of GROK_INSTRUCTION_FILES) {
		const text = readText(join(root, name));
		if (text === null || seen.has(text)) continue;
		seen.add(text);
		documents.push(text);
	}
	return documents.length === 0 ? null : documents.join("\n\n");
}

/**
 * `<root>/config.toml`, parsed.
 *
 * `Bun.TOML.parse`, the same call the Codex reader makes. A document that will
 * not parse migrates nothing from this source and is reported as such: grok
 * refuses to start on one, so there is a file for the user to fix, and aborting
 * the whole run over it would also drop the sources that are fine. The reason is
 * a fixed phrase rather than the parser's own message, which can quote the line
 * it choked on.
 *
 * One class of document is legal, readable by grok, and rejected by this parser
 * — a dotted key path with a digits-only segment — so the parse is retried with
 * those segments quoted before the file is given up on. Quoting is a no-op under
 * the spec, so what comes back is what grok read; the paths are recorded rather
 * than quietly rewritten, because a `[model.grok-4.6]` user asked for an override
 * of a model by that name and got a nested pair of tables instead.
 */
function readGrokConfig(root: string): Pick<RawGrokBuild, "config" | "configError" | "configDottedKeys"> {
	const text = readText(join(root, "config.toml"));
	if (text === null) return { config: {}, configDottedKeys: [] };
	try {
		const parsed = Bun.TOML.parse(text);
		return { config: isRecord(parsed) ? parsed : {}, configDottedKeys: [] };
	} catch {
		const requoted = requoteNumericKeyPaths(text);
		if (requoted !== null) {
			try {
				const parsed = Bun.TOML.parse(requoted.text);
				if (isRecord(parsed)) return { config: parsed, configDottedKeys: requoted.changed };
			} catch {
				// The rewrite did not reach the real problem; reported as unparseable below.
			}
		}
		return { config: {}, configDottedKeys: [], configError: "config.toml is not parseable as TOML" };
	}
}

/** A whole line that is a table header and nothing else: `[a.b]`, `[[a.b]]`. */
const GROK_HEADER_LINE = /^\s*\[\[?\s*([A-Za-z0-9_. -]+?)\s*\]\]?\s*$/;

/** The key part of an assignment: `a.b = …`, quoted segments left out of the match. */
const GROK_ASSIGNMENT_KEY = /^([A-Za-z0-9_. -]+?)\s*=/;

/**
 * Quote the digits-only segments in a document's key paths so this parser can
 * read it, and say which paths were touched.
 *
 * `[model.grok-4.6]` is TOML 1.0, and it is what grok's user guide writes —
 * `docs/user-guide/05-configuration.md`, `11-custom-models.md` (three times) and
 * the shell README all spell per-model overrides that way. It is the path
 * `model.grok-4."6"`: the id with a dot in it becomes *three* keys. grok's own
 * pty test says so in as many words ("bare `[model.grok-4.5]` is TOML key-path
 * syntax, not the id `grok-4.5`"), and its parser takes it. `Bun.TOML` does not:
 * a digits-only bare segment after a dot is rejected, and the rejection costs the
 * whole document — every other setting, rule and MCP server in the file with it.
 *
 * So the segments are quoted, which under the spec produces the identical
 * structure, and the paths are handed back so the report can explain what grok
 * made of them. Only the key part of a line is touched, and nothing inside a
 * triple-quoted string is, so a value that happens to look like a header — a
 * description containing `[model.grok-4.6]` — is left as the user wrote it.
 *
 * Returns `null` when the document needs no repair, which is the case for every
 * file this parser accepts as-is.
 */
export function requoteNumericKeyPaths(text: string): { text: string; changed: string[] } | null {
	const changed: string[] = [];
	let multiline: string | null = null;
	const repair = (path: string): string | null => {
		const segments = path.split(".").map((segment) => segment.trim());
		if (!segments.some((segment) => /^[0-9]+$/.test(segment))) return null;
		changed.push(segments.join("."));
		return segments.map((segment) => (/^[0-9]+$/.test(segment) ? `"${segment}"` : segment)).join(".");
	};
	const lines = text.split("\n").map((line) => {
		if (multiline !== null) {
			// Inside a triple-quoted string a header-shaped line is content. An odd
			// count of the delimiter is what opens or closes one; an even count is
			// two of them on one line, which leaves the state where it was.
			if (line.includes(multiline)) multiline = null;
			return line;
		}
		for (const delimiter of ['"""', "'''"]) {
			if ((line.split(delimiter).length - 1) % 2 === 1) multiline = delimiter;
		}
		const match = GROK_HEADER_LINE.exec(line) ?? GROK_ASSIGNMENT_KEY.exec(line);
		const path = match?.[1];
		if (path === undefined) return line;
		const requoted = repair(path);
		return requoted === null ? line : line.replace(path, requoted);
	});
	return changed.length === 0 ? null : { text: lines.join("\n"), changed };
}

/**
 * Grok's own `[skills]` switches, applied: the skills that survive, and the ones
 * a switch refused with the key that refused them.
 *
 * grok makes a distinction this build cannot: a `disabled` skill stays in the
 * list and is merely not run, while an `ignore` path prefix removes it outright
 * (`filter_skills`, `prompt/skills.rs:590`). Neither state exists here — this
 * build loads every skill it is given — so a skill either crosses over or is
 * reported as a skip. Importing one the user had switched off would hand the
 * model instructions they had already decided against.
 *
 * `ignore` is matched against the path as spelled rather than as resolved. grok
 * canonicalizes both sides first, and a reader that resolved symlinks to decide
 * what to read would be reading files to decide what to read; the plain prefix is
 * what a user writing `ignore = ["~/.grok/skills/foo"]` means, and the report
 * says `ignore` was applied so the rare difference is legible.
 */
function applyGrokSkillSwitches(
	files: RawFile[],
	switches: GrokSkillSwitches,
	home: string,
	detail?: string,
): { files: RawFile[]; skips: Array<{ name: string; reason: string }> } {
	const kept: RawFile[] = [];
	const skips: Array<{ name: string; reason: string }> = [];
	const ignored = switches.ignore.map((entry) => expandGrokTilde(home, entry));
	for (const file of files) {
		if (switches.disabled.includes(file.name)) {
			skips.push({ name: file.name, reason: "disabled by [skills] disabled" });
			continue;
		}
		const prefix = ignored.find((entry) => file.sourcePath.startsWith(entry));
		if (prefix !== undefined) {
			skips.push({ name: file.name, reason: `excluded by [skills] ignore (${prefix})` });
			continue;
		}
		if (detail !== undefined && file.detail === undefined) file.detail = detail;
		kept.push(file);
	}
	return { files: kept, skips };
}

/** Skills under a root, with grok's own `[skills]` switches applied. */
function readGrokSkills(
	skillsRoot: string,
	switches: GrokSkillSwitches,
	home: string,
): { files: RawFile[]; skips: Array<{ name: string; reason: string }> } {
	return applyGrokSkillSwitches(readGrokSkillTree(skillsRoot, false), switches, home);
}

/** One skill directory's `SKILL.md` and its attachments, or `null` when it has none. */
function readSkillAt(skillDir: string, name: string): RawFile | null {
	const content = readText(join(skillDir, "SKILL.md"));
	if (content === null) return null;
	return { name, sourcePath: join(skillDir, "SKILL.md"), content, ...readAttachments(skillDir) };
}

/** How deep grok walks for `SKILL.md`; past this it stops (`MAX_SKILL_WALK_DEPTH`). */
const GROK_MAX_SKILL_DEPTH = 5;

/**
 * Every skill under a skills root, at any depth, each named after its own
 * directory.
 *
 * This is a recursive walk because grok's is (`walk_for_skill_md`,
 * `discovery.rs:114`) — the other four sources keep a flat `skills/<name>/`, so
 * `readSkillDirs` is one level deep, and using it here would silently drop a
 * skill a user had organised into a subdirectory. Two further details are copied
 * from grok rather than chosen:
 *
 *   - the walk does **not** stop at a directory that has a `SKILL.md`; grok keeps
 *     descending, so a skill may hold skills and both are loaded.
 *   - the only bound is grok's depth (`MAX_SKILL_WALK_DEPTH = 5`), not a
 *     directory blacklist. grok skips nothing, `.git` and `node_modules`
 *     included, and a walk that skipped them would report a different set of
 *     skills than grok loads.
 *
 * `selfIsSkill` is the difference between grok's two entry points: a source's own
 * root is searched for skills inside it (`find_skill_paths`), while a `[skills]
 * paths` entry may *be* a skill (`find_skill_md_paths`, which checks the
 * directory's own `SKILL.md` first).
 */
function readGrokSkillTree(root: string, selfIsSkill: boolean): RawFile[] {
	const out: RawFile[] = [];
	if (selfIsSkill) {
		const own = readSkillAt(root, leafName(root));
		if (own !== null) out.push(own);
	}
	const walk = (dir: string, depth: number): void => {
		if (depth > GROK_MAX_SKILL_DEPTH) return;
		let dirs: string[];
		try {
			dirs = readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch {
			return;
		}
		for (const name of dirs) {
			const child = join(dir, name);
			const skill = readSkillAt(child, name);
			if (skill !== null) out.push(skill);
			walk(child, depth + 1);
		}
	};
	walk(root, 0);
	return out;
}

/**
 * The one skill a config path naming a `SKILL.md` file stands for, or `null` if
 * the path names no such file.
 *
 * grok takes exactly this spelling (`expanded.file_name() == "SKILL.md"`,
 * `prompt/skills.rs:335`) and names the skill after the directory holding the
 * file, which is why the directory — not the file — is what gets read.
 */
function readGrokSkillFileEntry(path: string): RawFile | null {
	if (leafName(path) !== "SKILL.md") return null;
	const dir = dirname(path);
	return readSkillAt(dir, leafName(dir));
}

/**
 * The skills `[skills] paths` adds, which grok loads after its own trees.
 *
 * An entry inside a vendor tree is another source's to bring, so it is reported
 * with its owner named rather than read — see {@link GROK_VENDOR_DIRS}. An entry
 * that is not there at all is reported too: grok only warns about that one
 * (`config path does not exist`), and a config path the user deleted is the kind
 * of thing a report should say out loud.
 */
function readGrokSkillPaths(
	home: string,
	switches: GrokSkillSwitches,
): { files: RawFile[]; skips: Array<{ name: string; reason: string }>; vendorTrees: string[] } {
	const files: RawFile[] = [];
	const skips: Array<{ name: string; reason: string }> = [];
	const vendorTrees: string[] = [];
	for (const raw of switches.paths) {
		const path = expandGrokTilde(home, raw);
		const vendor = vendorTreeOf(path);
		if (vendor !== null) {
			vendorTrees.push(vendor);
			skips.push({
				name: raw,
				reason: `inside grok's ${vendor} compatibility tree, which the ${vendor.slice(1)} source already imports`,
			});
			continue;
		}
		// A config path is a `SKILL.md` file, a skill directory, or a directory of
		// skills; `find_skill_md_paths` covers the last two without asking which.
		const single = readGrokSkillFileEntry(path);
		const found = single !== null ? [single] : readGrokSkillTree(path, true);
		if (found.length === 0) {
			skips.push({ name: raw, reason: "no SKILL.md at that path" });
			continue;
		}
		const applied = applyGrokSkillSwitches(found, switches, home, `listed in [skills] paths (${raw})`);
		files.push(...applied.files);
		skips.push(...applied.skips);
	}
	return { files, skips, vendorTrees };
}

/**
 * A name grok would accept for a skill, derived the way grok derives it.
 *
 * `normalize_skill_name` lowercases and turns every other character into a
 * hyphen, collapsing runs and trimming the ends; `is_valid_skill_name` then
 * accepts what is left only if it is non-empty and at most 64 characters
 * (`discovery.rs:316-341`). Both halves matter here: `My Command.md` is the
 * skill `my-command` in grok, and a stem that normalizes to nothing is a skill
 * grok drops — importing either under the other name would present a name the
 * source tool never had, and one of them a skill it never loads.
 */
function grokSkillName(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * `.md` files directly inside a `commands/` directory, each one a skill.
 *
 * grok loads these as skills: `$GROK_HOME` is itself in the skill config-dir
 * chain (`collect_skill_config_dirs_from_sources` adds `grok_home` at priority 3,
 * `skills.rs:192`) and `find_command_paths` runs on every dir in that chain
 * (`skills.rs:298-306`) — so `$GROK_HOME/commands/*.md` is a real user asset, and
 * one that a previous reading of this tree declared absent. Skills win name
 * collisions against commands.
 *
 * Two deliberate differences from {@link readCommandFiles}. It is flat, because
 * grok's `scan_md_files` does not recurse: `commands/fix/bugs.md` is not a
 * command there, so flattening it into `fix-bugs` would import a skill the source
 * tool never had. And it takes the file's own name from the frontmatter when it
 * has one rather than from the path, which is grok's order
 * (`parse_skill_frontmatter(content, fallback_name)`). A `README.md` comes across
 * as the skill `readme`, which is what grok does with it.
 *
 * `provenance`, when given, is a sentence the importer keeps: a command whose file
 * came out of a plugin has to keep saying so, because this build has no plugin to
 * enable or disable it with.
 */
function readGrokCommands(dir: string, provenance: string): RawCommands {
	const files: RawFile[] = [];
	const skips: Array<{ path: string; reason: string }> = [];
	let entries: Array<{ name: string; isFile(): boolean }>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		// Absent or unreadable: no commands, which is what grok sees too.
		return { files, skips };
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		// Exactly `.md`: grok compares the extension literally, so `NOTES.MD` is
		// not a command of its either.
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const content = readText(join(dir, entry.name));
		if (content === null) {
			skips.push({ path: entry.name, reason: "unreadable" });
			continue;
		}
		const declared = parseFrontmatter(content).data.name;
		const name = grokSkillName(declared ?? entry.name.slice(0, -3));
		if (name === "") {
			skips.push({ path: entry.name, reason: "no name grok would take, so grok does not load it" });
			continue;
		}
		if (name.length > MAX_COMMAND_NAME) {
			skips.push({ path: entry.name, reason: `name would be longer than ${MAX_COMMAND_NAME} characters` });
			continue;
		}
		files.push({ name, sourcePath: join(dir, entry.name), content, ...(provenance ? { detail: provenance } : {}) });
	}
	return { files, skips };
}

/**
 * Does this directory look like a plugin to grok?
 *
 * grok's own convention test (`discovery.rs:605-616`): a manifest, or any of the
 * component paths. A directory with none of them is skipped by grok with a
 * warning, so reading it here would import something grok does not load.
 */
function isGrokPluginDir(dir: string): boolean {
	if (GROK_PLUGIN_MANIFESTS.some((name) => existsSync(join(dir, name)))) return true;
	return GROK_PLUGIN_COMPONENTS.some((name) => existsSync(join(dir, name)));
}

/**
 * The directories a plugin's manifest points its skills or agents at.
 *
 * A plugin's content need not sit in `skills/` and `agents/`: the manifest may
 * name other directories, as a single path or a list (`PathOrPaths::resolve`).
 * A reader that only looked at the conventional names would report such a plugin
 * as empty while grok loads all of it. Paths are joined onto the plugin root and
 * must stay inside it, which is grok's containment rule — a `..` that escapes is
 * dropped rather than followed, and `join` normalizes it away before the check.
 */
function grokPluginManifestDirs(dir: string, key: "skills" | "agents" | "commands"): string[] {
	for (const name of GROK_PLUGIN_MANIFESTS) {
		const manifest = readJson(join(dir, name));
		const value = manifest[key];
		if (value === undefined) continue;
		const out: string[] = [];
		for (const entry of typeof value === "string" ? [value] : grokStringList(value)) {
			const resolved = join(dir, entry);
			if (resolved.startsWith(dir)) out.push(resolved);
		}
		return out;
	}
	return [];
}

/** Skills and agents found under one plugin, with the switches that removed any. */
interface GrokPluginContent {
	skills: RawFile[];
	agents: RawFile[];
	skips: Array<{ name: string; reason: string }>;
	commands: RawFile[];
	commandSkips: Array<{ path: string; reason: string }>;
	mcp: number;
	hooks: number;
}

/**
 * Everything one plugin directory contributes.
 *
 * grok enables a plugin as a unit; this build has no such unit. So the content
 * that is just files — skills, agent definitions, commands, which grok loads as
 * skills too — is carried, each marked with the plugin it came from, and the
 * content that changes how the process behaves — an `.mcp.json` and a
 * `hooks/hooks.json` — is counted and named instead. A third-party plugin's hook
 * should not enter a user's own configuration without the user having seen it.
 */
function readOneGrokPlugin(
	dir: string,
	plugin: string,
	provenance: string,
	switches: GrokSkillSwitches,
): GrokPluginContent {
	const skills: RawFile[] = [];
	const agents: RawFile[] = [];
	const skips: Array<{ name: string; reason: string }> = [];
	const skillDirs = grokPluginManifestDirs(dir, "skills");
	const agentDirs = grokPluginManifestDirs(dir, "agents");
	const commandDirs = grokPluginManifestDirs(dir, "commands");
	const alwaysOn = "grok enables a plugin as a unit and this build has none, so this now loads whenever skills do";
	for (const skillsRoot of skillDirs.length > 0 ? skillDirs : [join(dir, "skills")]) {
		for (const file of readSkillDirs(skillsRoot)) {
			// `disabled` is the one switch that reaches plugin skills: grok marks
			// them after merging the plugin skills in, while `ignore` is applied
			// before the merge and so never sees them (`list_skills_with_plugins`).
			if (switches.disabled.includes(file.name)) {
				skips.push({ name: file.name, reason: `disabled by [skills] disabled (in plugin "${plugin}")` });
				continue;
			}
			file.detail = `${provenance} — ${alwaysOn}`;
			skills.push(file);
		}
	}
	for (const agentsRoot of agentDirs.length > 0 ? agentDirs : [join(dir, "agents")]) {
		for (const file of readAgentFiles(agentsRoot)) {
			file.detail = file.detail ? `${provenance}; ${file.detail}` : `${provenance} — ${alwaysOn}`;
			agents.push(file);
		}
	}
	const commandFiles: RawFile[] = [];
	const commandSkips: Array<{ path: string; reason: string }> = [];
	for (const commandsRoot of commandDirs.length > 0 ? commandDirs : [join(dir, "commands")]) {
		const read = readGrokCommands(commandsRoot, `${provenance} — ${alwaysOn}`);
		commandFiles.push(...read.files);
		commandSkips.push(...read.skips);
	}
	// Existence only: a plugin's MCP declaration and its hooks both change what
	// the process does, so they are named rather than carried.
	return {
		skills,
		agents,
		skips,
		commands: commandFiles,
		commandSkips,
		mcp: existsSync(join(dir, GROK_PLUGIN_MCP)) ? 1 : 0,
		hooks: existsSync(join(dir, GROK_PLUGIN_HOOKS)) ? 1 : 0,
	};
}

/**
 * Plugins under grok's own plugin roots, with the skills and agents inside them
 * lifted out.
 *
 * Two roots, which is one fewer than an earlier reading of this tree assumed:
 * `$GROK_HOME/plugins` holds one directory per plugin, and the marketplace
 * install directory — `[plugins].install_dir` when the config sets it, else
 * `<root>/installed-plugins` — holds a clone per repository. A repository is a
 * plugin when it looks like one, and may also hold plugins in subdirectories, so
 * the install tree is walked rather than listed. `trusted-plugins` is **not** a
 * third root: it is a file listing which plugins the user trusts.
 */
function readGrokPlugins(
	root: string,
	config: Record<string, unknown>,
	switches: GrokSkillSwitches,
): {
	skills: RawFile[];
	agents: RawFile[];
	skips: Array<{ name: string; reason: string }>;
	commands: RawFile[];
	commandSkips: Array<{ path: string; reason: string }>;
	pluginCount: number;
	mcpCount: number;
	hookCount: number;
} {
	const acc = {
		skills: [] as RawFile[],
		agents: [] as RawFile[],
		skips: [] as Array<{ name: string; reason: string }>,
		commands: [] as RawFile[],
		commandSkips: [] as Array<{ path: string; reason: string }>,
		pluginCount: 0,
		mcpCount: 0,
		hookCount: 0,
	};
	const take = (dir: string, plugin: string, label: string): void => {
		acc.pluginCount += 1;
		const provenance = `from plugin "${plugin}" (${label})`;
		const content = readOneGrokPlugin(dir, plugin, provenance, switches);
		acc.skills.push(...content.skills);
		acc.agents.push(...content.agents);
		acc.skips.push(...content.skips);
		acc.commands.push(...content.commands);
		acc.commandSkips.push(...content.commandSkips);
		acc.mcpCount += content.mcp;
		acc.hookCount += content.hooks;
	};
	scanGrokPluginRoot(join(root, GROK_PLUGIN_DIR), GROK_PLUGIN_DIR, false, take);
	scanGrokPluginRoot(grokInstallDir(root, config), installDirLabel(root, config), true, take);
	return acc;
}

/** `[plugins].install_dir` when set, else `<root>/installed-plugins`. */
function grokInstallDir(root: string, config: Record<string, unknown>): string {
	const plugins = isRecord(config.plugins) ? config.plugins : {};
	const configured = plugins.install_dir;
	return typeof configured === "string" && configured !== "" ? join(root, configured) : join(root, GROK_INSTALL_DIR);
}

/** How the plan names the install directory: the configured one, or the default's name. */
function installDirLabel(root: string, config: Record<string, unknown>): string {
	return grokInstallDir(root, config) === join(root, GROK_INSTALL_DIR) ? GROK_INSTALL_DIR : "[plugins].install_dir";
}

/**
 * Every plugin under one plugins directory.
 *
 * `$GROK_HOME/plugins` is read one level deep, which is what grok does with it
 * (`scan_plugin_dir` reads direct children). The install directory is walked
 * instead: each of its entries is a repository, and a repository can be a plugin
 * itself, hold one in a subdirectory, or — in a monorepo — both. Descending past
 * a plugin is therefore deliberate; a plugin's own `node_modules` or `.git` is
 * not a plugin because it has none of the components, so the walk stops there on
 * its own.
 */
function scanGrokPluginRoot(
	pluginsDir: string,
	label: string,
	recursive: boolean,
	take: (dir: string, plugin: string, label: string) => void,
): void {
	let names: string[];
	try {
		if (!existsSync(pluginsDir)) return;
		names = readdirSync(pluginsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return;
	}
	for (const name of names) {
		const dir = join(pluginsDir, name);
		if (isGrokPluginDir(dir)) take(dir, name, label);
		else if (recursive) scanGrokPluginRoot(dir, label, true, take);
	}
}

/**
 * Workspace-scoped memory documents, counted.
 *
 * grok stores these as `memory/<slug>-<hash8>/MEMORY.md`, keyed by the git
 * repository the workspace belongs to, plus a `memory-v2/workspaces/<hash>`
 * tree. Carrying one across would change its scope — this build's memory is
 * user-global prose — so a project's notes would become instructions for every
 * project. The global document beside them is a different thing and is imported.
 */
/**
 * The global memory document, from the tree grok's own switch selects.
 *
 * grok runs one of two memory generations and they are isolated trees rather than
 * two views of one: `MemoryStorage::new_for_mode` roots v2 at `memory-v2/` and the
 * legacy pipeline at `memory/`, and the module says so outright — "V2 uses an
 * isolated root and cannot observe files under the legacy root"
 * (`xai-grok-memory/src/storage.rs:53-70`). The switch is `[memory_v2] enabled`
 * (`xai-grok-config-types/src/memory.rs:107-109`, resolved at `:745-747`), with a
 * server-side gate this reader cannot see layered over it.
 *
 * Reading `memory/MEMORY.md` unconditionally, as this importer used to, carries
 * over the document grok stopped reading the moment that switch went on. The
 * other tree's document is recorded too: it is either the one that used to be in
 * force or the one that would be, and either way a user is about to keep exactly
 * one of the two.
 */
function readGrokGlobalMemory(
	root: string,
	config: Record<string, unknown>,
): Pick<RawGrokBuild, "globalMemory" | "globalMemorySource"> {
	const legacy = join(root, "memory", "MEMORY.md");
	const v2 = join(root, "memory-v2", "global", "MEMORY.md");
	const settings = isRecord(config.memory_v2) ? config.memory_v2 : {};
	const chosen = settings.enabled === true ? v2 : legacy;
	const other = settings.enabled === true ? legacy : v2;
	return {
		globalMemory: readText(chosen),
		globalMemorySource: {
			generation: settings.enabled === true ? "v2" : "legacy",
			other: existsSync(other) ? other : null,
		},
	};
}

function countGrokWorkspaceMemory(root: string): number {
	return countDirectoryEntries(join(root, "memory")) + countDirectoryEntries(join(root, "memory-v2", "workspaces"));
}

/** Directories directly under `dir`, or 0 when it is unreadable. */
function countDirectoryEntries(dir: string): number {
	try {
		return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
	} catch {
		return 0;
	}
}

/**
 * Direct children of `dir` of any kind, or 0 when it is unreadable.
 *
 * Not {@link countDirectoryEntries}: grok's `personas`, `roles` and `workflows`
 * trees hold `.toml` and `.rhai` files, and counting only directories would make
 * each of them come back as 0 — which the caller filters out, so a tree full of
 * the user's own definitions would be reported as one grok does not have.
 */
function countTreeEntries(dir: string): number {
	try {
		return existsSync(dir) ? readdirSync(dir).length : 0;
	} catch {
		return 0;
	}
}

/**
 * The config layers that are machine or organization policy rather than user
 * preference, and that live under the grok home.
 *
 * `xai-grok-config/src/lib.rs:4-8` lists the whole chain, lowest priority first:
 * `/etc/grok/managed_config.toml`, `$GROK_HOME/managed_config.toml`, a policy
 * file under `/etc/grok`, `$GROK_HOME/requirements.toml` (an Ed25519-signed cloud
 * cache) and `/etc/grok/requirements.toml`. The two inside the home are checked
 * here; the three outside it are named in the plan.
 *
 * None of them is imported, and that is the point: an administrator's requirement
 * moved into a user's own settings file would survive as the user's own choice
 * once this machine stops being administered, and the user never set it.
 */
const GROK_MACHINE_POLICY = ["managed_config.toml", "requirements.toml"];

/**
 * The harness's settings document, as one namespace-keyed object.
 *
 * `Bun.YAML.parse` reads JSON too, so one call covers all three spellings. Only
 * the first file that exists is read: the harness composes exactly one settings
 * document, so a second one beside it is not a second settings source.
 *
 * A document that will not parse migrates nothing and is reported as such. The
 * harness itself refuses to start on one, so there is a file for the user to fix;
 * aborting the whole migration over it would also drop the sources that are fine.
 * The reason is a fixed phrase rather than the parser's own message, which can
 * quote the line it choked on — and that line is often a credential.
 */
function readDshSettings(
	root: string,
): { settings: Record<string, unknown> } & Pick<RawDeepSeekHarness, "settingsSource"> {
	for (const file of DSH_SETTINGS_FILES) {
		const text = readText(join(root, file));
		if (text === null) continue;
		try {
			const parsed: unknown = Bun.YAML.parse(text);
			// A document with no mapping at its root has no sections to read.
			return { settings: isRecord(parsed) ? parsed : {}, settingsSource: { file } };
		} catch {
			return { settings: {}, settingsSource: { file, error: "is not parseable as YAML or JSON" } };
		}
	}
	return { settings: {} };
}

/**
 * Skills under `<root>/skills`, in both spellings the harness reads side by
 * side: a directory bundle (`<name>/SKILL.md`) and a flat file (`<name>.md`).
 * Both become the same target here — a skill directory whose SKILL.md is the
 * file — which is why the flat form is read rather than reported as unknown.
 *
 * `.system` holds the harness's own bundled skills on this root; its discovery
 * skips that name, and importing them would file somebody else's content as the
 * user's own.
 */
function readDshSkills(skillsRoot: string): RawFile[] {
	const files = readSkillDirs(skillsRoot).filter((file) => file.name !== ".system");
	try {
		if (!existsSync(skillsRoot)) return files;
		for (const name of readdirSync(skillsRoot).sort()) {
			if (!name.endsWith(".md")) continue;
			const base = name.slice(0, -3);
			if (base === ".system") continue;
			const path = join(skillsRoot, name);
			if (!statSync(path).isFile()) continue;
			const content = readText(path);
			if (content !== null) files.push({ name: base, sourcePath: path, content });
		}
	} catch {
		// unreadable skills dir — the directory bundles are already collected
	}
	return files;
}

/**
 * Presets under `<root>/.agent-presets`, counted rather than read.
 *
 * A preset is a whole agent composition (`agent.cordis.yml`), which is another
 * product's plugin wiring; the report names the count and stops there. A file is
 * counted beside a directory: the discovery reads either spelling, so an entry
 * that is there at all is one the harness would offer.
 */
function countDshPresets(dir: string): number {
	try {
		if (!existsSync(dir)) return 0;
		return readdirSync(dir).filter((name) => !name.startsWith(".")).length;
	} catch {
		return 0;
	}
}

/**
 * Live session logs under `<root>/sessions`, counted rather than read: the
 * history importer reads them, and reading them here would pay for the
 * transcript twice.
 *
 * The layout is `<sessions>/<project>/<session-id>/<generation>.jsonl`, or
 * `.jsonl.zstd` on a compressed deployment. Only files one level below a session
 * directory count: an older flat artifact is not a log the harness would open
 * either, so counting one would promise a transcript that is not there.
 */
function countDshSessionLogs(sessionsRoot: string): number {
	let total = 0;
	try {
		if (!existsSync(sessionsRoot)) return 0;
		for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			const projectDir = join(sessionsRoot, project.name);
			for (const session of readdirSync(projectDir, { withFileTypes: true })) {
				if (!session.isDirectory()) continue;
				total += readdirSync(join(projectDir, session.name)).filter(
					(name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.zstd"),
				).length;
			}
		}
	} catch {
		// unreadable sessions tree — nothing to report
	}
	return total;
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

/**
 * The memories kimi reads outside its own home, and who owns them.
 *
 * `agentsMdCollect` walks `~/.agents` as well as the brand directory, and the
 * skills and agents loaders do the same (`skillRoots.ts`, `agentRoots.ts`), so a
 * kimi home is never the whole of what kimi reads. This build has its own
 * `agents` source for that shared tree: importing it here as well would land two
 * copies of every file in it, and the second copy would be attributed to kimi.
 */
const KIMI_SHARED_TREE = [join(".agents", "AGENTS.md"), join(".agents", "skills"), join(".agents", "agents")];

/** Directory names under the home this reader accounts for by name. */
const KIMI_KNOWN_DIRS = new Set(["skills", "agents", "plugins", "sessions", "user-history"]);

/**
 * Credential-shaped entry names, matched by name only.
 *
 * The names are reported so the user can see that they were noticed and left
 * alone. Nothing matching this pattern is ever opened: the importer has no use
 * for a token, and copying one into another tool's settings is the one way a
 * migration can hand somebody's account to a file it does not belong in.
 */
const KIMI_CREDENTIAL_NAME = /(credential|secret|token|auth)/i;

/** Entry names under the home that look like credentials — files or directories. */
function readKimiCredentialEntries(root: string): string[] {
	try {
		return readdirSync(root)
			.filter((name) => KIMI_CREDENTIAL_NAME.test(name))
			.sort();
	} catch {
		return [];
	}
}

/** Directories under the home with no mapping here, each with its entry count. */
function readKimiOtherDirs(root: string, accounted: Set<string>): Array<{ name: string; count: number }> {
	const out: Array<{ name: string; count: number }> = [];
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || KIMI_KNOWN_DIRS.has(entry.name) || accounted.has(entry.name)) continue;
			out.push({ name: entry.name, count: countTreeEntries(join(root, entry.name)) });
		}
	} catch {
		// unreadable home — contributes nothing
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `[extraSkillDirs]` / `[extraAgentDirs]`, split by what an entry can mean here.
 *
 * `resolveAgentPath` handles exactly four spellings: `~`, `~/…`, an absolute
 * path, and a relative one resolved against the project root. Only the first
 * three are a directory this run may open — the fourth belongs to whichever
 * repository kimi was started in, which is not the one being migrated into.
 */
function splitKimiExtraDirs(entries: unknown, home: string): { opened: string[]; projectScoped: string[] } {
	const list = Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === "string") : [];
	const opened: string[] = [];
	const projectScoped: string[] = [];
	for (const entry of list) {
		if (entry === "~") opened.push(home);
		else if (entry.startsWith("~/")) opened.push(join(home, entry.slice(2)));
		else if (isAbsolute(entry)) opened.push(entry);
		else projectScoped.push(entry);
	}
	return { opened, projectScoped };
}

/**
 * A setting name in kimi's own camelCase spelling: `default_model` -> `defaultModel`.
 *
 * Kimi writes `config.toml` with `camelToSnake` and reads it back with
 * `snakeToCamel` (`packages/node-sdk/src/config/toml.ts:35-41`; the write path is
 * `configToTomlData`, which calls `camelToSnake` at `:447`), so the file a user has holds the snake
 * spelling while kimi's own config object — and every line of its docs — names the
 * camel one. Both spellings are legal on the way in.
 *
 * A reader that looked only for the camel spelling would miss `default_model` (and
 * the permission mode, the plan mode, the extra skill directories, the hook-free
 * settings) in every file kimi itself wrote, and would then report those keys as
 * ones "this importer has no mapping for" — which would be false: the mapping is
 * there, under the spelling the file uses.
 */
function kimiSettingName(key: string): string {
	return key.replaceAll(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** One table, its setting names renamed. Entry names are the user's and are kept. */
function kimiRenamedTable(table: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(table)) out[kimiSettingName(key)] = value;
	return out;
}

/**
 * `config.toml` as kimi's own loader sees it, which is camelCase.
 *
 * The rename covers the top level of the file and the inside of the two tables this
 * reader inspects: `[models]`, for the `apiKey` an alias may hold, and
 * `[permission]`, whose `dangerous_command_guard` is the spelling kimi's own
 * documentation uses (`docs/en/configuration/config-files.md:523`) and whose
 * camelCase name is what the engine parses
 * (`packages/agent-core-v2/src/agent/permissionRules/configSection.ts:40`). Kimi
 * renames more than this — the entries of `[providers]` and `[services]`, and the
 * inside of `[thinking]`, `[background]` and the rest — and this reader never looks
 * inside those, so renaming them would be code no report line depends on.
 *
 * Two kinds of key are deliberately *not* renamed. A server name in `[mcp]` and an
 * alias name in `[models]` are names the user chose, not setting names — though
 * kimi's own v1 loader maps whole tables through `snakeToCamel` and so renames them
 * too, which turns an alias called `my_alias` into `myAlias` there. The report
 * repeats the name the file holds, so a reader comparing the two sees the same name
 * in both places.
 */
function kimiConfigView(config: Record<string, unknown>): Record<string, unknown> {
	const out = kimiRenamedTable(config);
	const models = out.models;
	if (isRecord(models)) {
		const aliases: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(models)) {
			aliases[name] = isRecord(value) ? kimiRenamedTable(value) : value;
		}
		out.models = aliases;
	}
	if (isRecord(out.permission)) out.permission = kimiRenamedTable(out.permission);
	return out;
}

/** `config.toml`, parsed, with the reason it contributed nothing when it could not be. */
function readKimiConfig(root: string): Pick<RawKimiCode, "config" | "configError"> {
	const text = readText(kimiConfigPath(root));
	if (text === null) return { config: {} };
	try {
		const parsed = Bun.TOML.parse(text);
		if (typeof parsed === "object" && parsed !== null) {
			return { config: kimiConfigView(parsed as Record<string, unknown>) };
		}
		return { config: {}, configError: "config.toml holds something other than a table" };
	} catch (error) {
		// Named rather than dropped: a home whose config could not be parsed reads in
		// the report exactly like a home that never had one, and only one of those is
		// a reason to stop looking for the file.
		return { config: {}, configError: `config.toml could not be parsed (${String(error)})` };
	}
}

/** `mcp.json`, parsed, with the reason it contributed nothing when it could not be. */
function readKimiMcp(root: string): Pick<RawKimiCode, "mcp" | "mcpError"> {
	const text = readText(kimiMcpFile(root));
	if (text === null) return { mcp: {} };
	try {
		const parsed = JSON.parse(text);
		if (isRecord(parsed)) return { mcp: parsed };
		return { mcp: {}, mcpError: "mcp.json holds something other than an object" };
	} catch (error) {
		return { mcp: {}, mcpError: `mcp.json could not be parsed (${String(error)})` };
	}
}

export function readKimiCode(home: string): RawKimiCode {
	const root = kimiRoot(home);
	const config = readKimiConfig(root);
	const skills = splitKimiExtraDirs(config.config.extraSkillDirs, home);
	const agents = splitKimiExtraDirs(config.config.extraAgentDirs, home);
	const credentialEntries = readKimiCredentialEntries(root);
	// The share dir may be relative, and the CLI resolved it against the directory
	// it was started in — which is the same kind of place this process is running
	// from, so that is what it is resolved against here too.
	const legacy = kimiLegacySourceRoot(home, process.cwd());
	const legacyPresent = existsSync(legacy.root) || (legacy.skillsRoot !== undefined && existsSync(legacy.skillsRoot));
	return {
		root,
		present: existsSync(root),
		...config,
		...readKimiMcp(root),
		memory: readText(join(root, "AGENTS.md")),
		skills: withKimiProvenance(
			[...readSkillDirs(kimiSkillsDir(root)), ...skills.opened.flatMap((dir) => readSkillDirs(dir))],
			skills.opened,
			home,
			"extraSkillDirs",
		),
		agents: withKimiProvenance(
			[...readAgentFiles(kimiAgentsDir(root)), ...agents.opened.flatMap((dir) => readAgentFiles(dir))],
			agents.opened,
			home,
			"extraAgentDirs",
		),
		extraSkillDirs: skills.opened,
		extraAgentDirs: agents.opened,
		projectScopedSkillDirs: skills.projectScoped,
		projectScopedAgentDirs: agents.projectScoped,
		hookDefs: config.config.hooks,
		sharedTree: KIMI_SHARED_TREE.filter((relative) => existsSync(join(home, relative))),
		pluginNames: readKimiPluginNames(root),
		credentialEntries,
		otherDirs: readKimiOtherDirs(root, new Set(credentialEntries)),
		legacy: legacyPresent ? legacy : null,
	};
}

/**
 * Files read from a configured extra directory, marked as such.
 *
 * A skill that arrived through `[extraSkillDirs]` is not in `<root>/skills`, and
 * the report is the only place that says so — without it the user sees a skill
 * appear with no hint of where it came from, and the setting that put it there is
 * one they may have forgotten writing. A note the reader already attached (an
 * agent whose `model:` frontmatter does not carry over) is kept and the
 * provenance joined to it rather than replacing it.
 */
function withKimiProvenance(files: RawFile[], dirs: string[], home: string, key: string): RawFile[] {
	return files.map((file) => {
		const dir = dirs.find((candidate) => file.sourcePath.startsWith(candidate));
		if (dir === undefined) return file;
		const origin = `from ${tildePath(home, file.sourcePath)}, named by [${key}]`;
		return { ...file, detail: file.detail === undefined ? origin : `${file.detail}; ${origin}` };
	});
}

/**
 * Plugin directories, by name.
 *
 * A plugin's skills and agents ship with the plugin (`app/plugin/manifest.ts`
 * resolves its `skills`/`agents` dirs), and this tree is kimi's own install area:
 * a copy here would keep running after the plugin is updated or removed, with
 * nothing to update it. The grok source draws the same line at `bundled/` and
 * `marketplace-cache/` — what a vendor ships is named, what the user wrote is
 * imported.
 */
function readKimiPluginNames(root: string): string[] {
	try {
		return readdirSync(kimiPluginsDir(root), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// MiniMax Code
// ---------------------------------------------------------------------------

/** The vendor's own skills root (`packages/config/src/config.ts:2078`, `builtinSkillsDir`). */
const MINIMAX_BUILTIN_SKILLS_DIR = ".builtin-skills";

/** Top-level entries under the data dir this reader accounts for by name. */
const MINIMAX_KNOWN_DIRS = new Set([
	"v2",
	"agents",
	"skills",
	MINIMAX_BUILTIN_SKILLS_DIR,
	"plugins",
	"plans",
	"memory",
	"mcp",
	"credentials",
	"review-rules",
]);

/**
 * The directories MiniMax reads by borrowing another agent's tree, and the
 * config key that turns each one off.
 *
 * `readExternalUserSkillRoots` (`local-runtime/src/skills/roots.ts:129-137`)
 * adds Claude Code's, Codex's and the shared agents home's skill directories to
 * MiniMax's own skill search, and `DEFAULT_SKILLS_CONFIG`
 * (`packages/config/src/skills-config.ts:62-76`) has all three on. That makes
 * them borrowed rather than MiniMax's: the `claude-code`, `codex` and `agents`
 * sources each own one of them, and importing them here as well would put every
 * skill in the collection twice.
 *
 * The project-level half of the same list (`<workspace>/.minimax/skills`,
 * `<workspace>/.claude/skills`, `<workspace>/.agents/skills`, with a walk up to
 * the repository root when `walkUp` is on) is about a working directory, not
 * about this tree, so it is named in the plan rather than looked for.
 */
const MINIMAX_BORROWED_TREES: Array<{ key: string; legacyKey?: string; path: string }> = [
	{ key: "user-cc", legacyKey: "user-claude", path: join(".claude", "skills") },
	{ key: "user-codex", path: join(".codex", "skills") },
	{ key: "user-agents", path: join(".agents", "skills") },
];

/** Directories under `<root>/agents` that are not one user's agent. */
const MINIMAX_BUILTIN_AGENTS_DIR = ".builtin";

/** The file MiniMax connects MCP servers from, named as the report spells it. */
const MINIMAX_MCP_FILE_NAME = "mcp.json";

/**
 * A tool name in a MiniMax permission rule, and the name this build's engine
 * knows for the same tool.
 *
 * The two engines are relatives — MiniMax's rule strings are Claude Code's
 * syntax (`parseRuleString`, `local-runtime/src/permissions/rule-codec.ts:166-181`)
 * and this build's `Tool(specifier)` is the same shape — but their tool names
 * are not the same strings: MiniMax's are lower case and this build's are not,
 * and a rule naming a tool that does not exist where it is read is a rule that
 * silently does nothing.
 *
 * `action` is the capability MiniMax says this tool performs
 * (`permissionInputAction`, `local-runtime/src/permissions/rule-match.ts:78-85`);
 * it is read only for `path` matchers, the one matcher kind that carries its own
 * `actions` list. `fs` is the umbrella name MiniMax puts over the file tools, so
 * it expands to every one of them whose action the rule asks for.
 */
const MINIMAX_TOOL_NAMES: Record<string, Array<{ name: string; action: MinimaxAction }>> = {
	read: [{ name: "Read", action: "read" }],
	write: [{ name: "Write", action: "write" }],
	edit: [{ name: "Edit", action: "write" }],
	apply_patch: [{ name: "Edit", action: "write" }],
	glob: [{ name: "Glob", action: "read" }],
	grep: [{ name: "Grep", action: "read" }],
	list: [{ name: "LS", action: "read" }],
	web_fetch: [{ name: "WebFetch", action: "network" }],
	web_search: [{ name: "WebSearch", action: "network" }],
	bash: [{ name: "Bash", action: "execute" }],
	fs: [
		{ name: "Read", action: "read" },
		{ name: "Write", action: "write" },
		{ name: "Edit", action: "write" },
	],
};

/** The capabilities a MiniMax rule can be scoped to (`rule-codec.ts:44-51`). */
type MinimaxAction = "read" | "write" | "delete" | "execute" | "network";

/**
 * The tool names whose specifier this build's engine actually consults.
 *
 * `inputMatchesSpecifier` (`packages/agent/src/permissions.ts:213-245`) has a
 * case for `Bash`, one for the file tools, one for `mcp__…`, and a default that
 * answers `false`. A rule for any other name in that position is written to no
 * effect — the file holds it, nothing reads it — which is the one outcome a
 * migration must not produce quietly.
 */
const MINIMAX_SPECIFIER_TOOLS = new Set(["Bash", "Read", "Write", "Edit"]);

/** `Tool(pattern)`, `Tool`, or a bare name; the same split MiniMax's reader makes. */
function splitMinimaxRuleString(raw: string): { toolName: string; pattern?: string } {
	const open = raw.indexOf("(");
	if (open <= 0 || raw[open - 1] === "\\") return { toolName: raw };
	const close = raw.lastIndexOf(")");
	if (close <= open) return { toolName: raw };
	const toolName = raw.slice(0, open);
	const pattern = raw.slice(open + 1, close);
	return pattern ? { toolName, pattern } : { toolName };
}

/** The rule as the source spells it, for the record of what did not come across. */
function formatMinimaxRule(toolName: string, pattern?: string): string {
	return pattern === undefined ? toolName : `${toolName}(${pattern})`;
}

/**
 * One entry of either generation, decoded into this build's rule text.
 *
 * The three things that can happen, and why each is the one that is right:
 *
 *   - the rule carries. Its tool name is translated and its pattern is kept as
 *     written, because the two grammars agree on the shapes that matter: a
 *     `/**` subtree, an exact path, a `*`-suffixed command prefix — with one
 *     exception, the `:*` suffix below. A rule whose meaning would change under
 *     the translation is not carried — that is the next two cases;
 *   - it is left behind because MiniMax does not consult it either, and then
 *     nothing is lost: a name no MiniMax tool has (`permissionToolMatches`,
 *     `rule-match.ts:87-91`, is an exact comparison) or a `path` matcher whose
 *     `actions` exclude the only action its tool performs (`:63-67`);
 *   - it is left behind though MiniMax does consult it, and then something is:
 *     this engine reads a specifier for four tool names and the MCP family, so
 *     `glob(/etc/**)` — live in MiniMax, where a glob's target is the pattern it
 *     was given — is a rule that would sit in the file unread here.
 *
 * The exception is a Bash pattern ending in `:*`. Keeping it as written would
 * be keeping a rule that does nothing here, and *that* is the one outcome worse
 * than a rule that means something slightly different: `Bash(sed:*)` reads as
 * `sed:*` as a glob, which matches no command a user ever runs, so a deny
 * written that way protects nothing after the migration. It is rewritten to the
 * glob the two engines both understand and the rewrite is recorded in
 * {@link widened}, where the report picks it up.
 *
 * What this does not try to reproduce: which *matcher kind* a v1 entry has is
 * inferred over there from the shape of its pattern — a leading `/`, `~/`, `./`
 * or a drive letter makes it a path matcher and anything else a command matcher
 * (`inferLegacyMatcher`, `rule-codec.ts:276-292`). The two kinds read the
 * pattern differently, and reproducing the guess here would mean this build
 * deciding what the user meant by a pattern MiniMax was already guessing at. The
 * pattern travels as written, and the caveat the caller writes for the rules it
 * does carry says the two grammars differ.
 */
function decodeMinimaxRule(
	entry: { toolName: string; pattern?: string; actions?: readonly MinimaxAction[] },
	behavior: "allow" | "deny",
	widened: string[] = [],
): { rules: string[]; drops: MinimaxRuleDrop[] } {
	const rules: string[] = [];
	const drops: MinimaxRuleDrop[] = [];
	const mapped = MINIMAX_TOOL_NAMES[entry.toolName];
	if (mapped === undefined) {
		drops.push({
			rule: formatMinimaxRule(entry.toolName, entry.pattern),
			tool: entry.toolName,
			behavior,
			reason: "inert-there",
		});
		return { rules, drops };
	}
	// A rule with no pattern is a bare tool rule in both engines: it matches the
	// tool whatever it is asked to do, which is what a name alone means.
	if (entry.pattern === undefined) {
		for (const target of mapped) rules.push(target.name);
		return { rules, drops };
	}
	for (const target of mapped) {
		// A `path` matcher carries its own actions; the other kinds are already
		// scoped by the tool. A rule whose actions exclude what the tool does is
		// one MiniMax never consults, so leaving it behind costs nothing.
		if (entry.actions !== undefined && !entry.actions.includes(target.action)) continue;
		if (!MINIMAX_SPECIFIER_TOOLS.has(target.name)) {
			drops.push({
				rule: formatMinimaxRule(entry.toolName, entry.pattern),
				tool: target.name,
				behavior,
				reason: "no-specifier-grammar",
			});
			continue;
		}
		if (target.name === "Bash" && entry.pattern.endsWith(":*")) {
			widened.push(formatMinimaxRule(target.name, entry.pattern));
			rules.push(formatMinimaxRule(target.name, `${entry.pattern.slice(0, -2)}*`));
			continue;
		}
		rules.push(formatMinimaxRule(target.name, entry.pattern));
	}
	return { rules, drops };
}

/**
 * `permission.json`, decoded — or nothing at all, when MiniMax would read
 * nothing from it either.
 *
 * Every way this file can be unusable is a *refusal* over there, not a partial
 * read: a corrupt document, a root that is not an object, one malformed v2
 * entry and any *explicit* `version` other than 2 all raise
 * `LocalPermissionStoreUnhealthyError` (`local-runtime/src/permissions/rules.ts:214-262`). "v1" is the shape *without* a `version` key rather than the
 * shape that spells `1` (`record.version === 2` picks the v2 decoder, `!==
 * undefined` is the refusal, and what is left is v1), so a file that writes
 * `version: 1` is refused over there as well — the distinction a hand-edited file
 * gets wrong. The comment at the first of those refusals says what its callers do
 * with it —
 * "Treating it as an empty rule set could drop a persisted deny and silently
 * authorize a command", so the store is treated as unhealthy and the user is
 * asked. A rule out of such a file is a decision that is in force nowhere, and
 * importing the allows out of it would put a set of permissions into effect
 * that the user's own tool is currently refusing to honour.
 */
function readMinimaxPermissions(root: string): Pick<RawMinimaxCode, "permissions" | "permissionError"> {
	const empty: MinimaxPermissions = { allow: [], deny: [], askCount: 0, version: 1, notCarried: [], widened: [] };
	const text = readText(minimaxPermissionFile(root));
	if (text === null) return { permissions: empty };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			permissions: empty,
			permissionError:
				"holds a document that is not JSON, which MiniMax itself refuses to read (it asks about every call instead) — no rule was taken from it",
		};
	}
	if (!isRecord(parsed)) {
		return {
			permissions: empty,
			permissionError: "does not hold an object, which MiniMax itself refuses to read — no rule was taken from it",
		};
	}
	if (parsed.version !== undefined && parsed.version !== 2) {
		return {
			permissions: empty,
			permissionError: `declares version ${JSON.stringify(parsed.version)}, which MiniMax itself refuses to read — no rule was taken from it`,
		};
	}
	const version: 1 | 2 = parsed.version === 2 ? 2 : 1;
	const allow: string[] = [];
	const deny: string[] = [];
	const notCarried: MinimaxRuleDrop[] = [];
	const widened: string[] = [];
	let askCount = 0;
	for (const behavior of ["allow", "deny", "ask"] as const) {
		const list = parsed[behavior];
		// A value that is not a list is an empty one, which is how MiniMax reads it
		// too (`readRuleStringArray`, `rule-codec.ts:121-126`).
		if (!Array.isArray(list)) continue;
		for (const raw of list) {
			if (version === 1) {
				if (typeof raw !== "string" || raw.trim() === "") continue;
				const entry = splitMinimaxRuleString(raw);
				if (behavior === "ask") {
					askCount += 1;
					continue;
				}
				const decoded = decodeMinimaxRule(entry, behavior, widened);
				(behavior === "allow" ? allow : deny).push(...decoded.rules);
				notCarried.push(...decoded.drops);
				continue;
			}
			// v2: `{tool_name, matcher}`. A bad entry here is not skipped — it is the
			// reason the whole file is unreadable, in MiniMax as well as here.
			//
			// `ask` is validated before it is counted, because that is what the
			// source does: `configV2ToRules` maps all three behaviors through the
			// same reader (`rule-codec.ts:143-153`), so a malformed `ask` entry
			// makes MiniMax refuse the store exactly as a malformed `allow` one
			// does. Counting it first would report "N ask rules here have no
			// equivalent" for a store the source reads as empty.
			if (!isRecord(raw) || typeof raw.tool_name !== "string" || raw.tool_name.trim() === "") {
				return {
					permissions: empty,
					permissionError:
						"holds an entry with no tool name, which makes MiniMax refuse the whole store — no rule was taken from it",
				};
			}
			const matcher = raw.matcher;
			if (!isRecord(matcher) || typeof matcher.kind !== "string") {
				return {
					permissions: empty,
					permissionError:
						"holds an entry with no matcher, which makes MiniMax refuse the whole store — no rule was taken from it",
				};
			}
			if (matcher.kind !== "command" && matcher.kind !== "path" && matcher.kind !== "tool") {
				return {
					permissions: empty,
					permissionError: `holds an entry whose matcher kind is ${JSON.stringify(matcher.kind)}, which MiniMax refuses — no rule was taken from it`,
				};
			}
			if (matcher.kind !== "tool" && (typeof matcher.pattern !== "string" || matcher.pattern.trim() === "")) {
				return {
					permissions: empty,
					permissionError:
						"holds a matcher with no pattern, which makes MiniMax refuse the whole store — no rule was taken from it",
				};
			}
			let actions: MinimaxAction[] | undefined;
			if (matcher.kind === "path") {
				if (!Array.isArray(matcher.actions) || matcher.actions.length === 0) {
					return {
						permissions: empty,
						permissionError:
							"holds a path matcher with no actions, which makes MiniMax refuse the whole store — no rule was taken from it",
					};
				}
				actions = matcher.actions.filter((action): action is MinimaxAction =>
					MINIMAX_ACTIONS.has(action as MinimaxAction),
				);
				if (actions.length !== matcher.actions.length) {
					return {
						permissions: empty,
						permissionError:
							"holds a path matcher naming an action MiniMax does not know, which makes it refuse the whole store — no rule was taken from it",
					};
				}
			}
			if (behavior === "ask") {
				askCount += 1;
				continue;
			}
			const value =
				matcher.kind === "tool"
					? { toolName: raw.tool_name }
					: actions === undefined
						? { toolName: raw.tool_name, pattern: matcher.pattern as string }
						: { toolName: raw.tool_name, pattern: matcher.pattern as string, actions };
			const decoded = decodeMinimaxRule(value, behavior, widened);
			const bucket = behavior === "allow" ? allow : deny;
			bucket.push(...decoded.rules);
			notCarried.push(...decoded.drops);
		}
	}
	return { permissions: { allow, deny, askCount, version, notCarried, widened } };
}

/** The five capabilities a v2 `path` matcher may name (`rule-codec.ts:44-51`). */
const MINIMAX_ACTIONS = new Set<MinimaxAction>(["read", "write", "delete", "execute", "network"]);

/** `config.yaml`, parsed, with the reason it contributed nothing when it could not be. */
function readMinimaxConfig(root: string): Pick<RawMinimaxCode, "config" | "configError"> {
	const text = readText(minimaxConfigPath(root));
	if (text === null) return { config: {} };
	try {
		const parsed: unknown = Bun.YAML.parse(text);
		if (isRecord(parsed)) return { config: parsed };
		return { config: {}, configError: "config.yaml holds something other than a table" };
	} catch {
		// A fixed phrase rather than the parser's message, which can quote the line
		// it choked on — and that line is often `apiKey`. The same reason, and the
		// same wording, as the harness reader's.
		return { config: {}, configError: "config.yaml is not parseable as YAML" };
	}
}

/**
 * `mcp.json` (and the `mcp/mcp.json` MiniMax also looks in), parsed.
 *
 * Unlike kimi's bare `{name: server}` map both files are the same
 * `{"mcpServers": {…}}` wrapper this build's own `.mcp.json` uses, so the values
 * travel as they stand.
 *
 * Both are read, and each one's parse failure is reported against its own path:
 * a report that named `mcp.json` for a broken `mcp/mcp.json` would send the user
 * to a file this run never opened. Which of the two *answers* is the planner's
 * decision, because it depends on what MiniMax does with each — see the note at
 * the top of its MCP section.
 */
function readMinimaxMcp(root: string): Pick<RawMinimaxCode, "mcp" | "mcpAlias" | "mcpErrors"> {
	const read = (path: string): { servers: Record<string, unknown> } | { error: string } | null => {
		const text = readText(path);
		if (text === null) return null;
		try {
			const parsed = JSON.parse(text);
			if (!isRecord(parsed)) return { error: "holds something other than an object" };
			const servers = parsed.mcpServers;
			if (!isRecord(servers)) return { servers: {} };
			return { servers };
		} catch {
			return { error: "is not parseable as JSON" };
		}
	};
	const primary = read(minimaxMcpFile(root));
	const alias = read(minimaxMcpAliasFile(root));
	const mcpErrors: string[] = [];
	if (primary !== null && "error" in primary) mcpErrors.push(`mcp.json ${primary.error}`);
	if (alias !== null && "error" in alias) mcpErrors.push(`mcp/mcp.json ${alias.error}`);
	return {
		mcp: primary !== null && "servers" in primary ? primary.servers : {},
		mcpAlias: alias !== null && "servers" in alias ? alias.servers : {},
		mcpErrors,
	};
}

/**
 * The user's agents, one directory each.
 *
 * A MiniMax agent is a *directory* — `agents/<name>/` holding `agent.md` (the
 * system prompt), `config.yaml` (its model selection), and optionally
 * `PERSONA.md`, `skills/`, `memory/`, `crons/` and `daily/`. This build's
 * subagent is a single markdown file, so `agent.md` is what travels.
 *
 * `PERSONA.md` is deliberately not folded into it. The two are separate prompt
 * assets over there (`getPersona` and `getSystemPrompt`, `agent-files.ts:866,906`),
 * and for a *custom* agent — which is what a user's own directory is — only the
 * system prompt becomes `agentSystemPrompt` (`agent-profile.ts:502`), while the
 * persona travels beside it as its own field. Concatenating them here would
 * invent a document that neither tool has, so the persona is named in the
 * agent's note instead and the user can paste it in if they want it inline.
 *
 * `skills/` under an agent is a skill tree scoped to that agent alone
 * (`resolveConfiguredSkillRoots`, `local-runtime/src/skills/roots.ts:40-50`
 * gives every agent its own root). A skill here is global — loaded into every
 * session — so those trees are counted and named rather than imported, the same
 * line the grok source draws at its per-workspace memory.
 */
function readMinimaxAgents(
	root: string,
): Pick<RawMinimaxCode, "agents" | "agentSkips" | "builtinAgentNames" | "agentSkillTrees"> {
	const dir = minimaxAgentsDir(root);
	const agents: RawFile[] = [];
	const agentSkips: Array<{ name: string; reason: string }> = [];
	const builtinAgentNames: string[] = [];
	const agentSkillTrees: Array<{ name: string; count: number }> = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { agents, agentSkips, builtinAgentNames, agentSkillTrees };
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name === MINIMAX_BUILTIN_AGENTS_DIR) {
			// The copies MiniMax ships. Vendor-written, and the source's own updates
			// are what keeps them current.
			builtinAgentNames.push(
				...readdirSync(join(dir, entry.name), { withFileTypes: true })
					.filter((child) => child.isDirectory())
					.map((child) => child.name)
					.sort(),
			);
			continue;
		}
		if (entry.name.startsWith(".")) continue;
		const agentDir = join(dir, entry.name);
		const skills = countTreeEntries(join(agentDir, "skills"));
		if (skills > 0) agentSkillTrees.push({ name: entry.name, count: skills });
		const body = readText(join(agentDir, "agent.md"));
		if (body === null || body.trim() === "") {
			// MiniMax's own roster skips a directory without a readable `agent.md`
			// (`inspectCanonicalCustomAgent`, `agent-files.ts:167-186`), so there is
			// nothing here that would run over there either.
			agentSkips.push({
				name: entry.name,
				reason: "no agent.md, so MiniMax lists no agent of that name either",
			});
			continue;
		}
		const notes: string[] = [];
		if (existsSync(join(agentDir, "PERSONA.md"))) {
			notes.push(
				"PERSONA.md sits beside it and was not folded in: it is this agent's persona, a separate prompt asset in MiniMax, and a subagent here is one document",
			);
		}
		if (existsSync(join(agentDir, "config.yaml"))) {
			notes.push("its config.yaml (the agent's own model selection) was not carried");
		}
		agents.push({
			name: entry.name,
			sourcePath: join(agentDir, "agent.md"),
			content: body,
			...(notes.length > 0 ? { detail: notes.join("; ") } : {}),
		});
	}
	return { agents, agentSkips, builtinAgentNames, agentSkillTrees };
}

/**
 * The trees MiniMax reads out of other agents' homes, and whether it still does.
 *
 * `skills.external` is on by default and so is each of its sources, so on a
 * default install MiniMax is already showing the user Claude Code's, Codex's
 * and `~/.agents`' skills. Turning a source off in `config.yaml` is a user
 * decision this reader honours: naming a tree as borrowed when the user has
 * switched it off would be telling them something about their own config that
 * is not true.
 *
 * A source is named by its current key or by the spelling it had before the
 * rename, and the current one wins when both are written — `parseSkillsConfig`
 * looks for `user-cc` first and falls back to `user-claude`
 * (`LEGACY_SOURCE_KEY_BY_KIND`, `skills-config.ts:41-46, 110-121`). Missing the
 * legacy spelling would be the exact mistake this function exists to avoid: a
 * user who switched the source off under the old name would be told it is on.
 *
 * A value that is not a table leaves the default in place, which is how the
 * source reads it (`parseSource`, `skills-config.ts:96-101`).
 */
function readMinimaxBorrowedTrees(home: string, config: Record<string, unknown>): string[] {
	const skills = isRecord(config.skills) ? config.skills : {};
	const external = isRecord(skills.external) ? skills.external : {};
	if (external.enabled === false) return [];
	const sources = isRecord(external.sources) ? external.sources : {};
	return MINIMAX_BORROWED_TREES.filter((tree) => {
		const source = Object.hasOwn(sources, tree.key)
			? sources[tree.key]
			: tree.legacyKey !== undefined && Object.hasOwn(sources, tree.legacyKey)
				? sources[tree.legacyKey]
				: undefined;
		if (isRecord(source) && source.enabled === false) return false;
		return existsSync(join(home, tree.path));
	}).map((tree) => tree.path);
}

/** Entry names under the root that look like credentials — files or directories. */
const MINIMAX_CREDENTIAL_NAME = /(credential|secret|token|auth|\.env$)/i;

/** Directories under the root with no mapping here, each with its entry count. */
function readMinimaxOtherDirs(root: string, accounted: Set<string>): Array<{ name: string; count: number }> {
	const out: Array<{ name: string; count: number }> = [];
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || MINIMAX_KNOWN_DIRS.has(entry.name) || accounted.has(entry.name)) continue;
			out.push({ name: entry.name, count: countTreeEntries(join(root, entry.name)) });
		}
	} catch {
		// unreadable root — contributes nothing
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readMinimaxCode(home: string): RawMinimaxCode {
	const primary = minimaxRoot(home);
	const legacyRoot = minimaxLegacyDataDir(home);
	// Which tree the vendor would end up reading, walked the way its own resolution
	// walks it (`resolveDataDirPair`, `packages/config/src/data-dir.ts:286-382`) —
	// because its move of the legacy tree is a rename, never a merge, so two trees
	// on one machine are one tree's worth of decisions plus a backup of the other.
	// What decides is the *content* test and not an existence test: an `.minimax`
	// that is there but empty is exactly the state it moves `.mavis` over
	// (`:310-330`), so an existence test here would report the source as having
	// nothing while its data sits under the older name. Three corners are copied
	// from that function rather than guessed at: a legacy tree answers only when it
	// is a directory (or a link to one) — a plain file at `.mavis` is never read,
	// it is only renamed onto (`:306-308`, `:342`) — a primary directory this
	// process cannot list is *not* empty and does not fall back (`:311-315`), and
	// the one pair that falls back to nothing at all is "empty here, empty there",
	// where the vendor keeps the current name (`:318-321`). An explicit
	// `$MINIMAX_DATA_DIR` skips the pair entirely, which is why the fallback is only
	// open to the default path.
	const primaryState = minimaxDataState(primary.root);
	const legacyState = legacyRoot === null ? "missing" : minimaxDataState(legacyRoot);
	const legacyRead =
		primary.origin === "default" &&
		primaryState !== "hasData" &&
		primaryState !== "unknown" &&
		legacyState !== "missing" &&
		legacyState !== "other" &&
		!(primaryState === "empty" && legacyState === "empty");
	const root = legacyRead && legacyRoot !== null ? legacyRoot : primary.root;
	const config = readMinimaxConfig(root);
	const credentialEntries = readMinimaxCredentialEntries(root);
	return {
		root,
		origin: primary.origin,
		present: existsSync(root),
		legacyRoot,
		legacyRead,
		...config,
		...readMinimaxPermissions(root),
		...readMinimaxMcp(root),
		memory: readText(minimaxGlobalInstructionsPath(root)),
		skills: readSkillDirs(minimaxSkillsDir(root)),
		...readMinimaxAgents(root),
		builtinSkillNames: readDirectoryNames(join(root, MINIMAX_BUILTIN_SKILLS_DIR)),
		pluginNames: readDirectoryNames(minimaxPluginsDir(root)),
		planNames: readDirectoryNames(minimaxPlansDir(root)),
		memoryNames: readDirectoryNames(minimaxMemoryDir(root)),
		unreadV2Dirs: [
			...readDirectoryNames(minimaxLegacyChatsDir(root)).map((name) => join("v2", "chats", name)),
			...readDirectoryNames(minimaxDraftsDir(root)).map((name) => join("v2", "mcode", "drafts", name)),
		],
		credentialEntries,
		otherDirs: readMinimaxOtherDirs(root, new Set(credentialEntries)),
		installDirPresent: existsSync(join(home, MINIMAX_INSTALL_DIR)),
		reviewRules: readDirectoryNames(join(root, "review-rules")),
		borrowedTrees: readMinimaxBorrowedTrees(home, config.config),
	};
}

/** Entry names under a directory, sorted. An unreadable or absent one has none. */
function readDirectoryNames(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/** Entry names under the root that look like credentials. Reported; never opened. */
function readMinimaxCredentialEntries(root: string): string[] {
	try {
		return readdirSync(root)
			.filter((name) => MINIMAX_CREDENTIAL_NAME.test(name))
			.sort();
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Step Code
// ---------------------------------------------------------------------------

/**
 * Step Code's user state, and the reason it needs a reader of its own.
 *
 * Two layers write user files here and they do not share a directory. The *Pi*
 * layer puts `settings.json`, `auth.json`, `models.json`, `themes/`, `prompts/`,
 * `agents/`, `tools/` and `sessions/` inside the agent directory (`config.ts:209-260`:
 * every one of them a `join(getAgentDir(), …)`); the *product* layer keeps
 * `config.toml`, its own `auth.json`, the MCP OAuth store `.credentials.json`
 * and its own `models.json` in the directory that *holds* the agent directory
 * (`resolveStepConfigRoot`, `step/environment.ts:53-70`: "These sit next to the
 * agent directory, not inside it"). With no override those are
 * `<home>/.stepcode/agent/…` and `<home>/.stepcode/…`, so `auth.json` and
 * `models.json` exist in two spellings that are two different files; with
 * `$STEP_CODING_AGENT_DIR` set they move together. Both are read, and which one
 * answered is named, because a reader that picked one would be wrong for half
 * the machines.
 *
 * The product settings file is the TOML one. `config.toml` holds the approval
 * policy (`permissionPreset`, `approvalMode`, `nonInteractiveApproval`,
 * `autoResume`, `feedbackEnabled`), the telemetry switches, the persisted
 * `defaultProvider`/`defaultModel` defaults and the `[mcp_servers.*]` table
 * (`step/settings-manager.ts:299` derives the global sidecar path as
 * `join(dirname(agentDir), "config.toml")`); the JSON `settings.json` beside it
 * is Pi's own schema — model cycling, theme, session directory, extra resource
 * paths and about fifty presentation settings.
 *
 * Credentials are named and never opened: `auth.json` in both spellings,
 * `.credentials.json`, the retired `legacy-auth.json`, and every entry under
 * either tree whose name matches the credential pattern. Reports carry names,
 * never values.
 */
export interface RawStepCode {
	/** The tree that was read: `<home>/.stepcode`, or `.step-harness` when that is where the data is. */
	root: string;
	/** True when {@link root} is the pre-rename tree rather than the canonical one. */
	legacy: boolean;
	present: boolean;
	/** The agent directory ({@link stepAgentDir}): the Pi layer's root, and part of the report's `from`. */
	agentDir: string;
	/** `<root>/config.toml` — the product settings document, parsed. */
	config: Record<string, unknown>;
	/** Why `config.toml` contributed nothing, when it was there but unreadable. */
	configError?: string;
	/** Key paths requoted for this parser's sake, as the grok reader records them. */
	configDottedKeys: string[];
	/**
	 * `<agentDir>/settings.json` — the **retired** settings document, parsed for
	 * the record only.
	 *
	 * `docs/step-configuration.md:13-15` says it plainly: "The retired
	 * `step-settings.json` and `settings.json` files are no longer read, written,
	 * or covered by the project trust prompt", and the file's own tree diagram
	 * marks it with the same note. This Step build keeps its Pi-side settings in
	 * the TOML root instead, so a key that lives only here is a key the source no
	 * longer honours — it is reported as retired rather than applied.
	 */
	settings: Record<string, unknown>;
	/** Why the retired `settings.json` could not be parsed, when it is there. */
	settingsError?: string;
	/**
	 * `<agentDir>/step-settings.json` — the *other* retired settings file, by
	 * presence only.
	 *
	 * The reader does not open it: `docs/step-configuration.md:13-15` retires it
	 * in the same sentence as `settings.json`, and an old install's residue is
	 * not a document this build can translate. It is named so that a file full of
	 * the user's old settings is not simply invisible — the reader enumerates
	 * directories under the agent directory, not files.
	 */
	stepSettingsPresent: boolean;
	/** The provider table from the `models.json` that holds one. */
	providers: Record<string, unknown>;
	/** Which `models.json` that was, or `null` when neither exists. */
	modelsPath: string | null;
	/** Why that file contributed nothing, when it was there but unreadable. */
	modelsError?: string;
	/** The other `models.json` when it is a different file holding providers. Named; its table is not read. */
	otherModelsPath: string | null;
	/** `<agentDir>/SYSTEM.md` — the user's own system prompt, prepended. */
	systemPrompt: string | null;
	/** `<agentDir>/APPEND_SYSTEM.md` — the same document's appended half. */
	appendSystemPrompt: string | null;
	skills: RawFile[];
	agents: RawFile[];
	prompts: RawCommands;
	/**
	 * The resource lists from the **live** settings document — `config.toml`'s
	 * `skills` / `prompts` / `themes` keys — resolved the way Step resolves them:
	 * `~`-forms against the home, absolute as they stand, a relative entry against
	 * the *agent directory* (`resolveLocalEntries`, `package-manager.ts:2311-2335`,
	 * resolves every entry against the scope's base directory, and the user
	 * scope's base is the agent dir).
	 *
	 * They come from the TOML and not from the retired `settings.json` because
	 * that is the document the source reads: `StepTomlSettingsStorage` parses
	 * `config.toml`, drops `mcp_servers`, and hands the rest to Pi's settings
	 * manager (`step/settings-manager.ts:108-114,647`), so a path listed in
	 * `settings.json` is a path this Step build would never load.
	 */
	extraSkillPaths: string[];
	extraPromptPaths: string[];
	extraThemePaths: string[];
	/**
	 * The same lists' glob entries (`isPattern`, `package-manager.ts:271-273`: a
	 * `!`/`+`/`-` prefix or a `*`/`?`). A pattern selects among files Step
	 * collected elsewhere, so there is no directory here to read — named, not
	 * expanded.
	 */
	extraPatterns: string[];
	/**
	 * The names the themes under `<agentDir>/themes` answer to — the `name` field
	 * *inside* each `.json`, which is what `config.toml`'s `theme` setting refers
	 * to. Step takes the name from the body rather than from the file's stem
	 * (`theme/theme.ts:557` lists the file under `loadThemeFromPath(file).name`,
	 * and `getCustomThemeInfos` skips a file whose body names nothing), so a
	 * reader that used the stems would tell a user whose theme is named in the
	 * body that their name is not a theme file here.
	 */
	themeNames: string[];
	/** The `.json` files under `<agentDir>/themes`, by file name. Counted; never converted. */
	themeFiles: string[];
	/** Directories under the plugins root, by name. */
	pluginNames: string[];
	/** Resources the plugins themselves ship, each naming the plugin it came from. */
	pluginSkills: RawFile[];
	pluginAgents: RawFile[];
	pluginPrompts: RawCommands[];
	/** Plugins declaring a `mcpServers` table, by plugin name. Named; never read. */
	pluginMcp: string[];
	/** Plugins shipping code (`entry`/`provision`), by plugin name. Named; never run. */
	pluginCode: string[];
	/** Manifest files that could not be read as JSON, by plugin name. */
	pluginErrors: string[];
	/** Marketplace checkouts under the storage root, by name. Counted; never read. */
	marketplaceNames: string[];
	/** Entry names under either tree that look like credentials. Named; never opened. */
	credentialFiles: string[];
	/** State files (not settings) under either tree, by name. Named; never read. */
	stateFiles: string[];
	/** Directories under the tree this importer reads nothing out of, with entry counts. */
	otherDirs: Array<{ name: string; count: number }>;
	/** Directories under the agent directory this importer reads nothing out of, with entry counts. */
	agentOtherDirs: Array<{ name: string; count: number }>;
	/** Files at the tree's root that are neither settings, state nor credentials, by name. */
	otherFiles: string[];
}

/** Entry names that look like credentials, in either tree. Named; never opened. */
const STEP_CREDENTIAL_NAME = /(credential|secret|token|auth|\.env$)/i;

/**
 * State files Step writes and this importer does not read, with the reason.
 *
 * `mcp-import.json` is the one the vendor's own source documents as pre-`config.toml`
 * (`mcp-import-store.ts:29`: "Pre-config.toml location, read for migration and
 * then removed"); it records which sources the user has already reviewed for
 * MCP import, which is bookkeeping rather than a preference. `models-store.json`
 * is the store beside `models.json` (`models-store.ts:52`) — the credential half
 * of a model entry.
 */
const STEP_STATE_FILES: Record<string, string> = {
	"mcp-import.json": "Step's own record of which MCP sources were already reviewed for import",
	"models-store.json": "the credential store beside models.json",
};

/** Files at the root this importer does not enumerate: run output, not user state. */
const STEP_VOLATILE_FILE = /(\.log$|\.lock$|\.tmp$|~$|^\.DS_Store$)/;

/** `<root>/config.toml` — the live settings document, in the one spelling the tree has for it. */
function stepConfigPath(root: string): string {
	return join(root, "config.toml");
}

/** `<root>/config.toml`, parsed, with the requote retry the grok reader documents. */
function readStepConfigDocument(root: string): Pick<RawStepCode, "config" | "configError" | "configDottedKeys"> {
	const text = readText(stepConfigPath(root));
	if (text === null) return { config: {}, configDottedKeys: [] };
	try {
		const parsed = Bun.TOML.parse(text);
		return { config: isRecord(parsed) ? parsed : {}, configDottedKeys: [] };
	} catch {
		// The same parser deviation the grok reader repairs: TOML 1.0 allows a
		// digits-only segment after a dot and this parser rejects the whole
		// document over it. Step's own parser is spec-compliant (`smol-toml`), so
		// the document is one Step reads; quoting the segments is a no-op under
		// the spec and recovers every other setting in the file.
		const requoted = requoteNumericKeyPaths(text);
		if (requoted !== null) {
			try {
				const parsed = Bun.TOML.parse(requoted.text);
				if (isRecord(parsed)) return { config: parsed, configDottedKeys: requoted.changed };
			} catch {
				// The rewrite did not reach the real problem; reported as unparseable below.
			}
		}
		return { config: {}, configDottedKeys: [], configError: "config.toml is not parseable as TOML" };
	}
}

/** One JSON settings document, with a fixed reason when it was there and unusable. */
function readStepJsonDocument(path: string, name: string): { value: Record<string, unknown>; error?: string } {
	const text = readText(path);
	if (text === null) return { value: {} };
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed)) return { value: {}, error: `${name} holds something other than an object` };
		return { value: parsed };
	} catch {
		// A fixed phrase rather than the parser's message, which can quote the
		// text it choked on.
		return { value: {}, error: `${name} is not parseable as JSON` };
	}
}

/** `<root>/models.json` and `<agentDir>/models.json`, in that order. */
function stepModelsPaths(root: string, agentDir: string): { primary: string; agent: string } {
	return { primary: join(root, "models.json"), agent: join(agentDir, "models.json") };
}

/** Canonical form of a path, for comparing two spellings of one directory. */
function stepPathKey(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * The settings entries that do not name a directory this run already read.
 *
 * The agent directory's own `skills` and `prompts` trees are read whether or not
 * a settings list names them — the loader reads them whenever they exist
 * (`getPromptsDir()`, `config.ts:248-250`; the user-scope roots at
 * `core/resource-loader.ts:818-822`) — and a live `config.toml` is free to list
 * that same directory among its entries. Reading it twice would import every
 * file in it twice, and the report would call the second copy a name collision.
 */
function stepExtraRoots(paths: string[], alreadyRead: string[]): string[] {
	const seen = new Set(alreadyRead.map(stepPathKey));
	return paths.filter((path) => {
		const key = stepPathKey(path);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * One settings document's resource entries, split by what a reader can do with them.
 *
 * Three of `package-manager.ts`'s four spellings are a path this run may open:
 * `~` and `~/…` against the home, an absolute path as it stands, and a relative
 * one against the agent directory (`resolveLocalEntries`, `:2311-2335`, passes
 * the user scope's own base). The fourth is not a path at all — `isPattern`
 * (`:271-273`) calls anything with a `!`/`+`/`-` prefix or a `*`/`?` a pattern,
 * and a pattern only decides which of the files collected elsewhere are enabled.
 */
function splitStepExtraDirs(
	entries: unknown,
	home: string,
	agentDir: string,
): {
	paths: string[];
	patterns: string[];
} {
	const list = Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === "string") : [];
	const paths: string[] = [];
	const patterns: string[] = [];
	for (const entry of list) {
		if (entry === "") continue;
		if (
			entry.startsWith("!") ||
			entry.startsWith("+") ||
			entry.startsWith("-") ||
			entry.includes("*") ||
			entry.includes("?")
		) {
			patterns.push(entry);
			continue;
		}
		if (entry === "~") paths.push(home);
		else if (entry.startsWith("~/")) paths.push(join(home, entry.slice(2)));
		else if (isAbsolute(entry)) paths.push(entry);
		else paths.push(join(agentDir, entry));
	}
	return { paths, patterns };
}

/**
 * A skill that is one file rather than a directory.
 *
 * Pi's `skills` list accepts "local skill file paths or directories"
 * (`core/settings-manager.ts:123`), and a single file is still a skill: it
 * becomes `<name>/SKILL.md` like any other, with the file's own stem as the
 * name.
 */
function readStepSkillFile(path: string): RawFile | null {
	const content = readText(path);
	if (content === null) return null;
	const name = path
		.slice(path.lastIndexOf("/") + 1)
		.slice(path.lastIndexOf("\\") + 1)
		.replace(/\.md$/i, "");
	if (name === "") return null;
	return { name, sourcePath: path, content };
}

/** A file's stem, for the single-file spellings of a skill, agent or prompt. */
function stepFileStem(path: string): string {
	const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	return base.replace(/\.md$/i, "");
}

/**
 * Skills at one path a settings list named, in any of the three shapes it can
 * take: a directory *holding* skill directories (what `<agentDir>/skills` is),
 * one skill directory of its own (`<path>/SKILL.md`), or one markdown file.
 *
 * The two directory shapes are told apart by the file that makes a directory a
 * skill — the same test `readSkillDirs` makes — so neither can be read as the
 * other and silently find nothing.
 */
function readStepSkillPath(path: string): RawFile[] {
	try {
		if (!existsSync(path)) return [];
		if (statSync(path).isDirectory()) {
			if (existsSync(join(path, "SKILL.md"))) {
				const content = readText(join(path, "SKILL.md"));
				if (content === null) return [];
				const { attachments, attachmentSkips } = readAttachments(path);
				const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
				return [{ name, sourcePath: join(path, "SKILL.md"), content, attachments, attachmentSkips }];
			}
			return readSkillDirs(path);
		}
		const file = readStepSkillFile(path);
		return file === null ? [] : [file];
	} catch {
		return [];
	}
}

/** Agents at one declared path: a directory read flat, the way Step reads its own. */
function readStepAgentPath(path: string): RawFile[] {
	try {
		if (!existsSync(path)) return [];
		if (statSync(path).isDirectory()) return readAgentFiles(path);
		if (!path.toLowerCase().endsWith(".md")) return [];
		const content = readText(path);
		if (content === null) return [];
		return [{ name: stepFileStem(path), sourcePath: path, content }];
	} catch {
		return [];
	}
}

/** Prompts at one declared path: a directory read recursively, or one file. */
function readStepPromptPath(path: string): RawCommands {
	try {
		if (!existsSync(path)) return { files: [], skips: [] };
		if (statSync(path).isDirectory()) return readCommandFiles(path);
		if (!path.toLowerCase().endsWith(".md")) return { files: [], skips: [] };
		const content = readText(path);
		if (content === null) return { files: [], skips: [] };
		return { files: [{ name: stepFileStem(path), sourcePath: path, content }], skips: [] };
	} catch {
		return { files: [], skips: [] };
	}
}

/** Prefix each file's report note with the plugin it came from. */
function withStepPluginOrigin(files: RawFile[], pluginName: string): RawFile[] {
	return files.map((file) => ({
		...file,
		detail:
			file.detail === undefined ? `from the "${pluginName}" plugin` : `${file.detail}; from the "${pluginName}" plugin`,
	}));
}

/** One plugin's declared resources, read from its directory inside the plugins root. */
function readStepPlugin(
	pluginDir: string,
	pluginName: string,
): {
	skills: RawFile[];
	agents: RawFile[];
	prompts: RawCommands;
	mcp: boolean;
	code: boolean;
	error?: string;
} {
	const empty = { skills: [], agents: [], prompts: { files: [], skips: [] }, mcp: false, code: false };
	const manifestPath = [join(pluginDir, "step.plugin.json"), join(pluginDir, ".claude-plugin", "plugin.json")].find(
		(candidate) => existsSync(candidate),
	);
	if (manifestPath === undefined) return empty;
	const parsed = readStepJsonDocument(manifestPath, "plugin manifest");
	if (parsed.error !== undefined) return { ...empty, error: parsed.error };
	const manifest = parsed.value;
	const claudeShaped = manifestPath.includes(".claude-plugin");
	const declared = (key: "skills" | "agents" | "commands"): string[] => {
		const value = manifest[key];
		if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
		// A Claude Code shaped manifest spells none of the three when the package
		// keeps the conventional directory (`plugins.ts:364-372`).
		if (claudeShaped && existsSync(join(pluginDir, key))) return [key];
		return [];
	};
	const skills: RawFile[] = [];
	const agents: RawFile[] = [];
	const promptFiles: RawFile[] = [];
	const promptSkips: Array<{ path: string; reason: string }> = [];
	for (const entry of declared("skills")) skills.push(...readStepSkillPath(join(pluginDir, entry)));
	for (const entry of declared("agents")) agents.push(...readStepAgentPath(join(pluginDir, entry)));
	for (const entry of declared("commands")) {
		const read = readStepPromptPath(join(pluginDir, entry));
		promptFiles.push(...read.files);
		promptSkips.push(...read.skips);
	}
	const mcp = manifest.mcpServers !== undefined || (claudeShaped && existsSync(join(pluginDir, ".mcp.json")));
	return {
		skills: withStepPluginOrigin(skills, pluginName),
		agents: withStepPluginOrigin(agents, pluginName),
		prompts: {
			files: withStepPluginOrigin(promptFiles, pluginName),
			// A skip carries its plugin in the path, since there is no `detail` on a
			// skip to hang the provenance on.
			skips: promptSkips.map((skip) => ({ path: `${pluginName}/${skip.path}`, reason: skip.reason })),
		},
		mcp,
		code: manifest.entry !== undefined || manifest.provision !== undefined,
	};
}

/** Entry names under a directory that look like credentials. Named; never opened. */
function readStepCredentialNames(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => STEP_CREDENTIAL_NAME.test(name))
			.sort();
	} catch {
		return [];
	}
}

/** Directories under a directory this importer reads nothing out of, with entry counts. */
function readStepOtherDirs(dir: string, accounted: Set<string>): Array<{ name: string; count: number }> {
	const out: Array<{ name: string; count: number }> = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || accounted.has(entry.name)) continue;
			out.push({ name: entry.name, count: countTreeEntries(join(dir, entry.name)) });
		}
	} catch {
		// unreadable directory — contributes nothing
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Files at the root that are neither settings, state nor credentials, by name. */
function readStepOtherFiles(dir: string, accounted: Set<string>): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && !accounted.has(entry.name) && !STEP_VOLATILE_FILE.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/**
 * The two documents a Step install can hold under one name, and which one
 * answered.
 *
 * `models.json` is read from the tree root, because that is the path the `step`
 * executable hands its own model registry (`apps/cli/src/main.ts:173`:
 * `modelsPath: join(resolveStepConfigRoot(), "models.json")`). The agent
 * directory's copy is Pi's default (`config.ts:222-224`) and is a different file
 * whenever the two roots differ — it is named, and its providers are read only
 * when the CLI's own file is absent, because two tables of providers under one
 * importer would register endpoints from a file this build may never have read.
 */
function readStepModels(
	root: string,
	agentDir: string,
): Pick<RawStepCode, "providers" | "modelsPath" | "modelsError" | "otherModelsPath"> {
	const paths = stepModelsPaths(root, agentDir);
	const primary = readStepJsonDocument(paths.primary, "models.json");
	if (existsSync(paths.primary)) {
		return {
			providers: isRecord(primary.value.providers) ? (primary.value.providers as Record<string, unknown>) : {},
			modelsPath: paths.primary,
			...(primary.error === undefined ? {} : { modelsError: primary.error }),
			otherModelsPath: paths.agent === paths.primary || !existsSync(paths.agent) ? null : paths.agent,
		};
	}
	if (paths.agent !== paths.primary && existsSync(paths.agent)) {
		const agent = readStepJsonDocument(paths.agent, "models.json");
		return {
			providers: isRecord(agent.value.providers) ? (agent.value.providers as Record<string, unknown>) : {},
			modelsPath: paths.agent,
			...(agent.error === undefined ? {} : { modelsError: agent.error }),
			otherModelsPath: null,
		};
	}
	return { providers: {}, modelsPath: null, otherModelsPath: null };
}

/**
 * The names the theme files under a directory answer to.
 *
 * The name is the one *inside* the document, not the file's stem: Step lists a
 * theme file under `loadThemeFromPath(file).name` (`theme/theme.ts:555-560`) and
 * only when the body names one, so `themes/mine.json` holding `{"name": "plum"}`
 * is the theme `plum` and `config.toml`'s `theme = "plum"` is a setting that
 * resolves. Every readable `.json` in the directory is read for this — a few
 * hundred bytes each, and nothing in one is a credential. A file whose body will
 * not parse contributes no name, exactly as it contributes no theme to Step
 * (`loadThemeFromFile` records a warning and pushes nothing); it is still
 * counted among the files, which is why the count comes from the listing.
 */
function readStepThemeNames(dir: string): string[] {
	const names: string[] = [];
	for (const entry of readDirectoryNames(dir)) {
		if (!entry.toLowerCase().endsWith(".json")) continue;
		const parsed = readStepJsonDocument(join(dir, entry), "theme file");
		const name = typeof parsed.value.name === "string" ? parsed.value.name.trim() : "";
		if (name !== "") names.push(name);
	}
	return names.sort();
}

export function readStepCode(home: string): RawStepCode {
	const root = stepRoot(home);
	// The tree is the retired one exactly when it is not the tree the config
	// directory names — the test `stepRoot` itself makes before falling back.
	const legacy = root !== stepConfigRoot(home);
	// `stepAssetDir` is the settings-and-assets spelling of the agent directory
	// (tilde-expanded, `config.ts:209-215`); `join(root, "agent")` is the tree's
	// own spelling, and it is the one that stays inside a retired tree.
	const agentDir = process.env.STEP_CODING_AGENT_DIR?.trim() ? stepAssetDir(home) : join(root, "agent");
	const config = readStepConfigDocument(root);
	const settings = readStepJsonDocument(join(agentDir, "settings.json"), "settings.json");
	// The storage root moves the plugin and marketplace directories without
	// moving the tree (`storage-root.ts:5-7`); with no override it is the tree
	// itself, which is the default spelling of every machine that has not set it.
	const storageRoot = process.env.STEPCODE_STORAGE_ROOT_DIR?.trim() || root;
	const pluginsDir = join(storageRoot, "plugins");
	const pluginNames = readDirectoryNames(pluginsDir);
	const pluginSkills: RawFile[] = [];
	const pluginAgents: RawFile[] = [];
	const pluginPrompts: RawCommands[] = [];
	const pluginMcp: string[] = [];
	const pluginCode: string[] = [];
	const pluginErrors: string[] = [];
	for (const name of pluginNames) {
		const plugin = readStepPlugin(join(pluginsDir, name), name);
		if (plugin.error !== undefined) pluginErrors.push(`${name}: ${plugin.error}`);
		pluginSkills.push(...plugin.skills);
		pluginAgents.push(...plugin.agents);
		if (plugin.prompts.files.length > 0 || plugin.prompts.skips.length > 0) pluginPrompts.push(plugin.prompts);
		if (plugin.mcp) pluginMcp.push(name);
		if (plugin.code) pluginCode.push(name);
	}
	// The live settings document is the TOML root — Pi's keys beside Step's own
	// (`mcp_servers`, `permissionPreset`). `settings.json` is only parsed so the
	// report can name it as retired; nothing is read out of it.
	const stepSettings = config.config;
	const skillExtra = splitStepExtraDirs(stepSettings.skills, home, agentDir);
	const promptExtra = splitStepExtraDirs(stepSettings.prompts, home, agentDir);
	const themeExtra = splitStepExtraDirs(stepSettings.themes, home, agentDir);
	const models = readStepModels(root, agentDir);
	// The agent directory's own `skills` tree is a *container* of skills, so it is
	// read by the reader that knows that shape; a settings entry naming it again
	// is dropped rather than read as if it were one skill directory.
	const skillsDir = join(agentDir, "skills");
	const skills = [
		...readSkillDirs(skillsDir),
		...stepExtraRoots(skillExtra.paths, [skillsDir]).flatMap((path) => readStepSkillPath(path)),
	];
	// The prompts tree the loader reads by default (`getPromptsDir()`,
	// `config.ts:248-250`): `<agentDir>/prompts`. It was never read before, which
	// made a directory full of the user's own prompt templates invisible.
	const promptsDir = join(agentDir, "prompts");
	const prompts: RawCommands = { files: [], skips: [] };
	for (const path of [promptsDir, ...stepExtraRoots(promptExtra.paths, [promptsDir])]) {
		const read = readStepPromptPath(path);
		prompts.files.push(...read.files);
		prompts.skips.push(...read.skips);
	}
	// The names under the agent directory are spelled `agent/<name>` with a forward
	// slash because they are *labels*, not paths: the report renders every path it
	// names with forward slashes, and `join` would put a backslash into one of them
	// on Windows.
	const credentialFiles = [
		...readStepCredentialNames(root),
		...readStepCredentialNames(agentDir).map((name) => `agent/${name}`),
	].sort();
	const stateFiles = [
		...Object.keys(STEP_STATE_FILES).filter((name) => existsSync(join(root, name))),
		...Object.keys(STEP_STATE_FILES)
			.filter((name) => agentDir !== root && existsSync(join(agentDir, name)))
			.map((name) => `agent/${name}`),
	].sort();
	return {
		root,
		legacy,
		present: existsSync(root),
		agentDir,
		...config,
		settings: settings.value,
		...(settings.error === undefined ? {} : { settingsError: settings.error }),
		stepSettingsPresent: existsSync(join(agentDir, "step-settings.json")),
		...models,
		systemPrompt: readText(join(agentDir, "SYSTEM.md")),
		appendSystemPrompt: readText(join(agentDir, "APPEND_SYSTEM.md")),
		skills,
		agents: readAgentFiles(join(agentDir, "agents")),
		prompts,
		extraSkillPaths: skillExtra.paths,
		extraPromptPaths: promptExtra.paths,
		extraThemePaths: themeExtra.paths,
		extraPatterns: [...skillExtra.patterns, ...promptExtra.patterns, ...themeExtra.patterns].sort(),
		themeNames: readStepThemeNames(join(agentDir, "themes")),
		themeFiles: readDirectoryNames(join(agentDir, "themes")).filter((name) => name.toLowerCase().endsWith(".json")),
		pluginNames,
		pluginSkills,
		pluginAgents,
		pluginPrompts,
		pluginMcp,
		pluginCode,
		pluginErrors,
		marketplaceNames: readDirectoryNames(join(storageRoot, "marketplaces")),
		credentialFiles,
		stateFiles,
		otherDirs: readStepOtherDirs(root, new Set(["agent", "plugins", "marketplaces"])),
		// The directories this importer reads (the four asset trees) or that the
		// history half reads (`sessions`) are accounted for; everything else is
		// listed with its size, which is the only thing the line about them has to
		// go on: `extensions` and `tools` are code the user wrote and Step loads at
		// startup, so leaving them out of the list would make the sentence that
		// names them unreachable — a claim about a directory no line mentions.
		agentOtherDirs: readStepOtherDirs(agentDir, new Set(["skills", "agents", "prompts", "themes", "sessions"])),
		otherFiles: readStepOtherFiles(
			root,
			new Set([
				"config.toml",
				"models.json",
				"agent",
				...Object.keys(STEP_STATE_FILES),
				...readStepCredentialNames(root),
			]),
		),
	};
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

/**
 * Keys in the source state file that are telemetry or runtime bookkeeping.
 *
 * `projects` is deliberately not among them: each entry under it holds that
 * project's local-scope MCP servers (`services/mcp/config.ts` reads them for
 * scope `local`), and those are configuration. They are named one by one in
 * `planClaudeCode` — calling the whole map "not configuration" was a claim the
 * file itself contradicts.
 */
const STATE_TELEMETRY_KEYS = new Set(["tipsHistory", "promptQueueUseCount", "cachedChangelog"]);

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
const CLAUDE_STATE_HANDLED = new Set(["env", "model", "mcpServers", "projects", ...STATE_TELEMETRY_KEYS]);

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
	/** Handlers whose timeout came across, converted from the source's seconds. */
	convertedTimeouts: number;
	/** Of those, how many asked for longer than this build waits and were clamped. */
	clampedTimeouts: number;
	/** Handlers that name no timeout, so the target's own default applies. */
	untimedHandlers: number;
}

/**
 * The longest timeout the target's hook schema accepts, in milliseconds, and
 * what a handler that names none runs for there (`hooks.ts`).
 */
const MAX_HOOK_TIMEOUT_MS = 600_000;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/**
 * One handler in the target's shape, or nothing plus a count of why not.
 *
 * The timeout is the one field whose *value* has to change on the way across:
 * the source counts it in seconds — "Timeout in seconds for this specific
 * command", `schemas/hooks.ts` — and runs a handler that names none for ten
 * minutes (`utils/hooks.ts`, `TOOL_HOOK_EXECUTION_TIMEOUT_MS`), where this build
 * counts milliseconds and waits a minute. A copy that keeps the number is the
 * one thing that makes `timeout: 30` mean thirty milliseconds, so the
 * conversion happens here and both counts are reported.
 */
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
	const seconds = handler.timeout;
	let timeout: number | undefined;
	if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
		// Clamped rather than dropped: the schema would reject an oversized value
		// and take every hook in the file down with it, so the longest wait this
		// build has is what a longer one becomes — and the report says how many.
		const millis = Math.round(seconds * 1000);
		timeout = Math.min(Math.max(millis, 1), MAX_HOOK_TIMEOUT_MS);
		counts.convertedTimeouts += 1;
		if (millis > MAX_HOOK_TIMEOUT_MS) counts.clampedTimeouts += 1;
	} else {
		counts.untimedHandlers += 1;
	}
	return [
		timeout === undefined
			? { type: "command", command: handler.command }
			: { type: "command", command: handler.command, timeout },
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
function planCodexRules(
	raw: RawCodex,
	at: (name: string) => string,
	items: MigrationItem[],
	addPermissionRules: AddPermissionRules,
): void {
	for (const file of raw.execpolicy) {
		const { calls, unparsed } = ruleCalls(file.content);
		const from = at(`rules/${file.name}`);
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

function planCodex(
	raw: RawCodex,
	at: (name: string) => string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	/** The base config, as the report names it: the tree `$CODEX_HOME` decides. */
	const configAt = at("config.toml");
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
					from: `${configAt} → model_providers.${name}`,
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
					from: `${configAt} → model_providers.${name} (wire_api="${wireApi}")`,
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
					from: `${configAt} → model_providers.${name}`,
					to: `settings.json → providers.openaiCompatible[${name}]`,
					action: "map",
					detail: `base_url carried over; ${credentialNote}`,
					containsSecret: false,
				});
			}
			if (isRecord(spec.http_headers)) {
				items.push({
					source: "codex",
					from: `${configAt} → model_providers.${name}.http_headers`,
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
		(id) => `${configAt} → model_providers.${id}`,
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
				`${configAt} → model ("${modelName}")`,
				`registered under the "${providerName}" provider with the ${modelContextWindow}-token context window the source records — the protocol is spoken as chat-completions`,
			);
		} else {
			const resolved = resolveModelReference(modelName);
			const resolvedProvider = resolved ? resolveModel(resolved)?.provider : undefined;
			// The endpoint is part of what the user configured. When the source said
			// "this model, on that provider", the name must not be quietly re-pointed at
			// a first-party row that happens to share it — the same id on a different
			// host is somebody else's server, and it would bill a different account.
			const scopedElsewhere =
				resolvedProvider !== undefined && providerName !== undefined && resolvedProvider !== providerName;
			if (resolved && !scopedElsewhere) {
				claimScalar("codex", "model", resolved, `${configAt} → model ("${modelName}")`, `resolved to ${resolved}`);
			} else {
				const providerKeptItsOwn =
					providerName !== undefined && modelContextWindow !== undefined
						? `the target already defines a "${providerName}" provider — add "${modelName}" to its models and set model to "${providerName}/${modelName}"`
						: undefined;
				const scopedDetail =
					`the name also exists on the ${resolvedProvider} provider, but the source runs it on ` +
					`"${providerName}" — add it under providers.openaiCompatible[${providerName}].models with its ` +
					`context window, then set model to "${providerName}/${modelName}"`;
				items.push({
					source: "codex",
					from: `${configAt} → model ("${modelName}")`,
					to: "—",
					action: "skip",
					detail:
						providerKeptItsOwn ??
						(scopedElsewhere
							? scopedDetail
							: providerName
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
			from: `${configAt} → model_context_window`,
			to: "—",
			action: "skip",
			detail: "not a positive number of tokens, so no model entry could be built from it",
			containsSecret: false,
		});
	}
	if (raw.config.model_auto_compact_token_limit !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → model_auto_compact_token_limit`,
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
			from: `${configAt} → disable_response_storage`,
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
			const label = `${configAt} → mcp_servers.${name}`;
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
			from: `${configAt} → model_reasoning_effort`,
			to: "—",
			action: "skip",
			detail: "no reasoning-effort setting exists here; thinking level is chosen per request",
			containsSecret: false,
		});
	}
	if (raw.config.projects !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → projects.*.trust_level`,
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
			from: `${configAt} → windows.sandbox`,
			to: "—",
			action: "skip",
			detail: "no OS-level sandbox setting; tool access is governed by permission rules",
			containsSecret: false,
		});
	}
	if (raw.config.tui !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → tui`,
			to: "—",
			action: "skip",
			detail: "interface state, not configuration",
			containsSecret: false,
		});
	}
	// ── the posture that decides what may run, and the prose this build has no
	// slot for ──────────────────────────────────────────────────────────────
	// Each of these is one decision in the source and a silent change in what the
	// agent may do here, so each gets a sentence of its own rather than the
	// catch-all line at the end: a user who set `sandbox_mode` is entitled to know
	// which of the two builds is the permissive one.
	if (
		raw.config.approval_policy !== undefined ||
		raw.config.sandbox_mode !== undefined ||
		raw.config.sandbox_workspace_write !== undefined
	) {
		items.push({
			source: "codex",
			from: `${configAt} → approval_policy, sandbox_mode, sandbox_workspace_write`,
			to: "—",
			action: "skip",
			detail:
				"how Codex decides whether a command runs, asks first or is refused, and the sandbox it runs under — " +
				"this build has no OS-level sandbox and no per-command policy: a tool call is allowed or denied by permission " +
				"rules, which decide per tool rather than per command, so the rules here are what decides",
			containsSecret: false,
		});
	}
	if (raw.config.default_permissions !== undefined || raw.config.permissions !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → default_permissions, permissions`,
			to: "—",
			action: "skip",
			detail:
				"named permission profiles — filesystem and network policy, workspace roots, and which profile is applied by " +
				"default — permission rules here are one flat list of allow/deny per tool, with neither profiles nor a " +
				"network policy to put them in",
			containsSecret: false,
		});
	}
	if (
		raw.config.instructions !== undefined ||
		raw.config.developer_instructions !== undefined ||
		raw.config.model_instructions_file !== undefined
	) {
		items.push({
			source: "codex",
			from: `${configAt} → instructions, developer_instructions, model_instructions_file`,
			to: "—",
			action: "skip",
			detail:
				"text Codex puts into the model's system prompt — the system prompt here is not configurable from settings; " +
				"the memory documents and ~/.labunbun/rules/*.md are what reaches the model in your own words",
			containsSecret: false,
		});
	}
	if (raw.config.hooks !== undefined) {
		const hookTable = isRecord(raw.config.hooks) ? raw.config.hooks : undefined;
		const hookEvents = hookTable === undefined ? [] : Object.keys(hookTable).filter((key) => key !== "state");
		const unmatchedEvents = hookEvents.filter((event) => !HOOK_EVENTS.includes(event as HookEventName));
		items.push({
			source: "codex",
			from: `${configAt} → hooks`,
			to: "—",
			action: "skip",
			detail:
				hookTable === undefined
					? "not a table, so Codex reads no hooks here and neither does this importer"
					: `${hookEvents.length} hook event(s) declared in this file` +
						(unmatchedEvents.length > 0 ? `, and ${summarizeNames(unmatchedEvents)} of them have no event here` : "") +
						" — hooks here are command hooks written by hand in settings.json → hooks, and these handlers were not " +
						"translated; a timeout on one of them is seconds there against milliseconds here",
			containsSecret: false,
		});
	}
	if (raw.config.skills !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → skills`,
			to: "—",
			action: "skip",
			detail:
				"the skill entries and the catalog around them — an entry can switch one skill off with enabled = false, and " +
				"that switch is not applied here, so a skill turned off in Codex arrives as one this build loads; the catalog " +
				"settings beside them (bundled skills, the instructions block, its token budget) have no counterpart here, " +
				"where every skill under ~/.labunbun/skills is offered",
			containsSecret: false,
		});
	}
	if (raw.config.memories !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → memories`,
			to: "—",
			action: "skip",
			detail:
				"Codex's own memory pipeline — which memory version it runs, how far back it reads threads and which model " +
				"summarises them; nothing here generates memories in the background, memory being the documents it reads " +
				"plus rules",
			containsSecret: false,
		});
	}
	if (raw.config.profile !== undefined) {
		items.push({
			source: "codex",
			from:
				typeof raw.config.profile === "string"
					? `${configAt} → profile ("${raw.config.profile.trim()}")`
					: `${configAt} → profile`,
			to: "—",
			action: "skip",
			detail:
				"a key Codex itself now rejects: a config that sets it does not load, its error pointing at --profile <name> " +
				"with <name>.config.toml instead — so this file was never in force there, and the overlay it names is not " +
				"what the source was running",
			containsSecret: false,
		});
	}
	if (raw.profileArchives.length > 0) {
		items.push({
			source: "codex",
			from: at("*.config.toml"),
			to: "—",
			action: "skip",
			detail:
				`${raw.profileArchives.length} profile file(s) (${summarizeNames(raw.profileArchives)}): each is a whole ` +
				"config.toml layered over the base file when Codex is started with --profile <name>, and only in those " +
				"sessions — this import reads the base file, so a key that lives only in one of these is not among the " +
				"settings written here",
			containsSecret: false,
		});
	}
	for (const [key, reason] of UNMIGRATED_CODEX_KEYS) {
		if (raw.config[key] === undefined) continue;
		items.push({
			source: "codex",
			from: `${configAt} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	// Whatever is left, by name. Codex's config grows a key at a time and this
	// importer knows a fixed set of them; the rest are the user's own settings,
	// and a report that simply omits them reads as if they had never been set.
	reportUnhandledKeys("codex", raw.config, CODEX_CONFIG_HANDLED, configAt, items);
	if (raw.hooksPresent) {
		items.push({
			source: "codex",
			from: at("hooks.json"),
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
			from: at("agents/*.toml"),
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
 * Keys of `config.toml` that are either imported above or named by a line of
 * their own — the ones a report about this file may pass over in silence.
 *
 * Everything else reaches the report through {@link reportUnhandledKeys}. Codex
 * reads around sixty top-level keys, and the half of them this importer knows
 * nothing about (`web_search`, `tools`, `features`, `otel`, `apps`, the realtime
 * block) are exactly the ones a user is most likely to have set by hand.
 */
const CODEX_CONFIG_HANDLED = new Set<string>([
	"model",
	"model_provider",
	"model_providers",
	"model_context_window",
	"model_auto_compact_token_limit",
	"disable_response_storage",
	"mcp_servers",
	"model_reasoning_effort",
	"projects",
	"windows",
	"tui",
	"approval_policy",
	"sandbox_mode",
	"sandbox_workspace_write",
	"default_permissions",
	"permissions",
	"instructions",
	"developer_instructions",
	"model_instructions_file",
	"profile",
	"hooks",
	"skills",
	"memories",
	...UNMIGRATED_CODEX_KEYS.map(([key]) => key),
]);

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
	// allowed to do — the same boundary `PROJECT_TIER_KEY_POLICY` draws for
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

// ---------------------------------------------------------------------------
// DeepSeek Harness
// ---------------------------------------------------------------------------

/** The route the harness's own composition serves DeepSeek from (`llm-deepseek`). */
const DSH_DEEPSEEK_ROUTE = "deepseek-official";

/** The credential variable the harness's DeepSeek route reads when its section names none. */
const DSH_DEEPSEEK_DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";

/**
 * Windows a harness deployment falls back to for a model entry that states none.
 * Both are the harness's own defaults, not measurements of the model.
 */
interface DshWindowDefaults {
	contextWindow: number;
	maxTokens: number;
}

/** `llm-pi-ai`'s `defaultContextWindow` / `defaultMaxTokens`. */
const DSH_PI_AI_DEFAULTS: DshWindowDefaults = { contextWindow: 262_144, maxTokens: 32_768 };

/** `llm-deepseek`'s own pair. */
const DSH_DEEPSEEK_DEFAULTS: DshWindowDefaults = { contextWindow: 1_000_000, maxTokens: 256_000 };

/**
 * The name in the harness's *shipped* preset table whose bundle means
 * `bypassPermissions` here.
 *
 * A preset is a name for a bundle — a sandbox mode plus an approval policy — and
 * the table itself is deployment configuration, so a name only settles what the
 * session will do when the document reading it also states the table, or when no
 * table is stated and the shipped one applies. The shipped entry `danger-full-access`
 * is `danger-full-access` + `never`: no confinement and no approval questions,
 * which is exactly what `bypassPermissions` means. The other shipped entry,
 * `workspace-write`, is `workspace-write` + `ask` — a sandbox mode and an approval
 * policy are different axes from a permission mode, so nothing else maps.
 */
const DSH_SHIPPED_BYPASS_PRESET = "danger-full-access";

/** One model entry a source document declares, with only the numbers it states itself. */
interface DshModelEntry {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
}

/** A positive whole number of tokens, or nothing — a window has no other form. */
function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Model entries a harness document declares.
 *
 * The DeepSeek catalog (`llm-deepseek.models`) and a pi-ai route's `models` list
 * spell an entry the same way — `{id, name?, contextWindow?, maxTokens?}` — so one
 * extractor serves both. Both also leave the numbers to the deployment when they
 * omit them, which is why an absent one stays absent here instead of being filled
 * with a default the document never claimed.
 */
function dshModelEntries(models: unknown): DshModelEntry[] {
	if (!Array.isArray(models)) return [];
	const out: DshModelEntry[] = [];
	for (const value of models) {
		if (!isRecord(value)) continue;
		const id = typeof value.id === "string" ? value.id.trim() : "";
		if (id === "") continue;
		const contextWindow = positiveInteger(value.contextWindow);
		const maxTokens = positiveInteger(value.maxTokens);
		out.push({
			id,
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
		});
	}
	return out;
}

/**
 * Entries in `providers.openaiCompatible` shape.
 *
 * An entry here has to carry positive numbers, so one that states neither takes
 * the deployment's own fallback — the route's `defaultContextWindow` /
 * `defaultMaxTokens` when it states them, the plugin's defaults otherwise.
 * `assumed` counts those, because a deployment default is not a measurement.
 */
function dshRouteModels(
	entries: DshModelEntry[],
	route: Record<string, unknown>,
	fallback: DshWindowDefaults,
): { models: Array<Record<string, unknown>>; assumed: number } {
	const contextWindow = positiveInteger(route.defaultContextWindow) ?? fallback.contextWindow;
	const maxTokens = positiveInteger(route.defaultMaxTokens) ?? fallback.maxTokens;
	let assumed = 0;
	const models = entries.map((entry) => {
		if (entry.contextWindow === undefined || entry.maxTokens === undefined) assumed += 1;
		return {
			id: entry.id,
			contextWindow: entry.contextWindow ?? contextWindow,
			maxOutputTokens: entry.maxTokens ?? maxTokens,
		};
	});
	return { models, assumed };
}

/**
 * The "which models travelled" clause of a provider-entry item: how many, how many
 * were left behind for a window this build's table contradicts, and how many are
 * sized by the harness's own deployment defaults rather than by a window their
 * document states.
 */
function dshModelCarryNote(
	declared: DshModelEntry[],
	carried: number,
	assumed: number,
	defaults: DshWindowDefaults,
): string {
	const parts = [`${carried} model(s) carried`];
	if (declared.length > carried) {
		parts.push(`${declared.length - carried} left out for a window this build's table contradicts (reported above)`);
	}
	if (assumed > 0) {
		parts.push(
			`${assumed} of them sized by the harness's deployment defaults (${defaults.contextWindow} context / ` +
				`${defaults.maxTokens} output) rather than by a window of their own`,
		);
	}
	return parts.join(", ");
}

/** The models this run's patch would leave under `providerId`, when it holds an entry for it at all. */
function dshRegisteredModels(settingsPatch: Record<string, unknown>, providerId: string): Set<string> | undefined {
	const providers = isRecord(settingsPatch.providers) ? settingsPatch.providers.openaiCompatible : undefined;
	if (!Array.isArray(providers)) return undefined;
	for (const entry of providers) {
		if (!isRecord(entry) || entry.id !== providerId) continue;
		const models = Array.isArray(entry.models) ? entry.models : [];
		return new Set(models.filter(isRecord).map((model) => (typeof model.id === "string" ? model.id : "")));
	}
	return undefined;
}

/**
 * The window sentence for an entry whose declared numbers disagree with this
 * build's table for the same model id, or `undefined` when they agree — or when
 * the table does not carry the id at all, which is not a disagreement.
 */
function dshWindowDrift(entry: DshModelEntry): string | undefined {
	const reference = resolveModelReference(entry.id);
	const known = reference === undefined ? undefined : resolveModel(reference);
	if (known === undefined) return undefined;
	const windows: string[] = [];
	if (entry.contextWindow !== undefined && entry.contextWindow !== known.contextWindow) {
		windows.push(`context ${entry.contextWindow} vs ${known.contextWindow}`);
	}
	if (entry.maxTokens !== undefined && entry.maxTokens !== known.maxOutputTokens) {
		windows.push(`output ${entry.maxTokens} vs ${known.maxOutputTokens}`);
	}
	return windows.length === 0 ? undefined : `${entry.id} (${windows.join(", ")}, source first)`;
}

/**
 * Report windows a source document records differently from this build's own
 * table for the same model id.
 *
 * The table's numbers are what a run uses for a model it resolves, and nothing in
 * a settings file can change them, so a disagreement is a fact to state rather
 * than a value to write: keeping one of two numbers in silence is exactly the
 * mismatch the report exists to prevent. Both numbers go in the text, because only
 * the user can say which is right — and an entry that declares a window the table
 * contradicts is left out of the provider entry built from the same document, for
 * the same reason.
 */
function reportDshWindowMismatches(items: MigrationItem[], entries: DshModelEntry[], from: string): void {
	const differing = entries.map(dshWindowDrift).filter((value): value is string => value !== undefined);
	if (differing.length === 0) return;
	items.push({
		source: "deepseek-harness",
		from,
		to: "—",
		action: "skip",
		detail: `the document records a different window than this build's table for ${summarizeNames(differing)} — the table's numbers are what a run uses, and a window from the source is never written`,
		containsSecret: false,
	});
}

/**
 * A reader row in this build's MCP config shape, or `null` for one missing what
 * its transport needs to start.
 *
 * A composition file computes fields with `!!js`, and a computed one comes back
 * absent rather than empty — so each field is checked for the shape this build's
 * config accepts instead of being copied through. An absent field stays absent:
 * `cwd: ""` is a directory, not "no directory", and the difference would be a
 * server started in the wrong place.
 *
 * The returned `secret` flag is true when the row carries env or header values,
 * whatever they are called: a stdio server's env is where its keys live, and a
 * header value is often a bearer token.
 */
function dshMcpConfig(server: DshMcpServer): { config: Record<string, unknown>; secret: boolean } | null {
	if (server.transport === "streamable-http") {
		if (typeof server.url !== "string" || server.url === "") return null;
		const headers = isRecord(server.headers) ? server.headers : {};
		const config: Record<string, unknown> = { type: "http", url: server.url };
		if (Object.keys(headers).length > 0) config.headers = headers;
		return { config, secret: Object.keys(headers).length > 0 };
	}
	if (typeof server.command !== "string" || server.command === "") return null;
	const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
	const env = isRecord(server.env) ? server.env : {};
	const config: Record<string, unknown> = { type: "stdio", command: server.command, args };
	if (Object.keys(env).length > 0) config.env = env;
	if (typeof server.cwd === "string" && server.cwd !== "") config.cwd = server.cwd;
	return { config, secret: Object.keys(env).length > 0 };
}

/**
 * Skills and the AGENTS.md memory document for the harness.
 *
 * Not {@link planAssetTrees}: this source spells skills two ways, and it keeps
 * its memory file under a root `$DSH_HOME` can move, so the labels come from the
 * resolved root instead of from a `~/<dir>` guess.
 */
function planDeepSeekAssets(
	raw: RawDeepSeekHarness,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	collectFileWrites(
		"deepseek-harness",
		raw.skills,
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	if (raw.memory?.trim()) {
		planMemoryAsRule(
			"deepseek-harness",
			tildePath(home, join(raw.root, "AGENTS.md")),
			home,
			raw.memory,
			"imported-deepseek-harness.md",
			force,
			items,
			writes,
		);
	}
}

/**
 * DeepSeek Harness: one settings document under one root, whose top-level keys
 * are the harness's settings namespaces.
 *
 * The namespaces read here are the ones with a counterpart in this build's
 * settings — `agent-default-model` (→ `model`), `llm-pi-ai` (→
 * `providers.openaiCompatible`) and `permission` (→ `permissionMode`). The rest of
 * the document is deployment detail this build has no key for; the parts of it
 * that would change behaviour are named rather than copied.
 *
 * Nothing is written into the harness: its credential store and `.env` are named
 * and never opened, and its session logs are counted because the history importer
 * is the part that reads them.
 *
 * `home` is the labunbun home, used only to render labels: the harness root can
 * sit outside it, and {@link tildePath} leaves such a path absolute rather than
 * folding it under a `~` that does not contain it.
 */
function planDeepSeekHarness(
	raw: RawDeepSeekHarness,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const settingsLabel = raw.settingsSource?.file ?? "settings.yaml";
	if (raw.settingsSource?.error !== undefined) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, raw.settingsSource.file)),
			to: "—",
			action: "skip",
			detail: `the settings document ${raw.settingsSource.error} — nothing was read from it, so no model, provider or permission setting of this source is in this report`,
			containsSecret: false,
		});
	}

	// The routes the document declares. Each one is an endpoint the harness can be
	// asked to serve a model from, which is what a provider entry here is — and a
	// route missing one of the facts an entry needs becomes a skip that names the
	// missing fact rather than a guessed value.
	const piAi = isRecord(raw.settings["llm-pi-ai"]) ? raw.settings["llm-pi-ai"] : undefined;
	const routes = piAi !== undefined && isRecord(piAi.providers) ? piAi.providers : undefined;
	const openaiCompatible: Array<Record<string, unknown>> = [];
	/** Why a declared route has no provider entry, for the model below to cite. */
	const routeNotes = new Map<string, string>();
	/** Where the harness records a thinking default, which this build asks per request instead. */
	const thinkingDefaults: string[] = [];
	/** The default model's route and id, and the one thinking level stored beside them. */
	const defaults = isRecord(raw.settings["agent-default-model"]) ? raw.settings["agent-default-model"] : undefined;
	if (defaults?.reasoningEffort !== undefined) thinkingDefaults.push("agent-default-model");
	if (routes !== undefined) {
		for (const [route, value] of Object.entries(routes)) {
			const label = `${settingsLabel} → llm-pi-ai.providers.${route}`;
			if (!isRecord(value)) {
				routeNotes.set(route, "its section is not an object");
				continue;
			}
			const baseUrl = typeof value.baseURL === "string" ? value.baseURL.trim() : "";
			const apiKeyEnv = typeof value.apiKeyEnv === "string" ? value.apiKeyEnv.trim() : "";
			if (baseUrl === "") {
				routeNotes.set(route, "it declares no baseURL, so the harness takes its endpoint from its own catalog");
				items.push({
					source: "deepseek-harness",
					from: label,
					to: "—",
					action: "skip",
					detail:
						"the route declares no baseURL — its endpoint then comes from the harness's own catalog for that " +
						"protocol, which this importer cannot read; add a providers.openaiCompatible entry with that baseUrl by hand",
					containsSecret: false,
				});
				continue;
			}
			if (apiKeyEnv === "") {
				routeNotes.set(route, "it names no apiKeyEnv to read the key from");
				items.push({
					source: "deepseek-harness",
					from: label,
					to: "—",
					action: "skip",
					detail:
						"the route names no apiKeyEnv, and a provider entry here has to name the environment variable its key " +
						"comes from — name one in the harness, or add the entry by hand if this endpoint needs no key",
					containsSecret: false,
				});
				continue;
			}
			const declared = dshModelEntries(value.models);
			reportDshWindowMismatches(items, declared, `${label}.models → window`);
			// An entry whose declared window contradicts this build's table is left out
			// of the provider entry rather than carried with a number no run would use:
			// the table's window is what a request is assembled against, so a second
			// number in the entry would describe something that never happens.
			const carried = declared.filter((entry) => dshWindowDrift(entry) === undefined);
			const { models, assumed } = dshRouteModels(carried, value, DSH_PI_AI_DEFAULTS);
			const spec = { id: `dsh-${route}`, baseUrl, apiKeyEnv, models };
			if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
				routeNotes.set(route, "its endpoint or model entries are not what a provider entry here accepts");
				items.push({
					source: "deepseek-harness",
					from: label,
					to: "—",
					action: "skip",
					detail: "the route's baseURL or model entries are not usable in a provider entry",
					containsSecret: false,
				});
				continue;
			}
			openaiCompatible.push(spec);
			if (value.reasoning !== undefined) thinkingDefaults.push(`llm-pi-ai.providers.${route}.reasoning`);
			// The harness speaks one of three protocols per route, and only the first
			// is the one a provider entry here uses — so a route naming another is
			// carried with the difference stated rather than presented as equivalent.
			const api = typeof value.api === "string" ? value.api.trim() : "";
			const otherProtocol = api !== "" && api !== "openai-completions";
			items.push({
				source: "deepseek-harness",
				from: label,
				to: `settings.json → providers.openaiCompatible[dsh-${route}]`,
				action: otherProtocol ? "downgrade" : "map",
				detail: [
					dshModelCarryNote(declared, models.length, assumed, DSH_PI_AI_DEFAULTS),
					otherProtocol ? `the route speaks "${api}", which is served here as chat-completions` : "",
					`set ${apiKeyEnv} in your environment`,
				]
					.filter(Boolean)
					.join("; "),
				containsSecret: false,
			});
		}
	}

	// llm-deepseek: the section of the route the harness's own composition mounts,
	// and this deployment's record of where DeepSeek traffic goes. That endpoint is
	// carried as a provider entry of its own rather than folded into the built-in
	// DeepSeek row: the section names both the URL and the variable its key is read
	// from, and either can be one this build does not ship. It is not carried as
	// `DEEPSEEK_BASE_URL` either — that override moves every DeepSeek row this build
	// resolves, including the ones the harness never named.
	const deepseekSection = isRecord(raw.settings["llm-deepseek"]) ? raw.settings["llm-deepseek"] : undefined;
	const deepseekProviderId = `dsh-${DSH_DEEPSEEK_ROUTE}`;
	if (deepseekSection !== undefined) {
		const label = `${settingsLabel} → llm-deepseek`;
		const protocol = typeof deepseekSection.protocol === "string" ? deepseekSection.protocol.trim() : "";
		const baseUrl = typeof deepseekSection.baseURL === "string" ? deepseekSection.baseURL.trim() : "";
		const namedApiKeyEnv = typeof deepseekSection.apiKeyEnv === "string" ? deepseekSection.apiKeyEnv.trim() : "";
		const declared = dshModelEntries(deepseekSection.models);
		reportDshWindowMismatches(items, declared, `${label}.models → window`);
		const carried = declared.filter((entry) => dshWindowDrift(entry) === undefined);
		// A provider entry here speaks chat-completions, and the harness's own
		// protocol default is `messages` — DeepSeek's Anthropic root. Pointing this
		// build's provider at a root that serves only the other protocol would hand
		// it requests it cannot answer, so the section is only carried when it says
		// chat-completions itself.
		if (protocol !== "chat-completions") {
			routeNotes.set(
				DSH_DEEPSEEK_ROUTE,
				protocol === ""
					? "it declares no protocol, and the harness serves that section over the messages protocol unless told otherwise"
					: `it speaks "${protocol}" rather than chat-completions`,
			);
			items.push({
				source: "deepseek-harness",
				from: label,
				to: "—",
				action: "skip",
				detail:
					`the section is served over the harness's ${protocol === "" ? "default messages" : `"${protocol}"`} protocol, ` +
					`while a provider entry here speaks chat-completions — no entry is registered for its endpoint${
						namedApiKeyEnv === "" || namedApiKeyEnv === DSH_DEEPSEEK_DEFAULT_API_KEY_ENV
							? ""
							: `, and its credential variable ${namedApiKeyEnv} is not carried either`
					}`,
				containsSecret: false,
			});
		} else if (baseUrl === "") {
			routeNotes.set(
				DSH_DEEPSEEK_ROUTE,
				"it declares no baseURL, so the harness falls back to DeepSeek's own endpoint",
			);
			items.push({
				source: "deepseek-harness",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"the section declares chat-completions but no baseURL — the harness then uses DeepSeek's own endpoint, or " +
					"$DEEPSEEK_BASE_URL when its environment exports one, and this build's own DeepSeek provider reads that same " +
					"variable — so no entry is registered for it; export DEEPSEEK_BASE_URL here if this deployment points elsewhere",
				containsSecret: false,
			});
		} else {
			const apiKeyEnv = namedApiKeyEnv === "" ? DSH_DEEPSEEK_DEFAULT_API_KEY_ENV : namedApiKeyEnv;
			const { models, assumed } = dshRouteModels(carried, deepseekSection, DSH_DEEPSEEK_DEFAULTS);
			const spec = { id: deepseekProviderId, baseUrl, apiKeyEnv, models };
			if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
				routeNotes.set(DSH_DEEPSEEK_ROUTE, "its endpoint or model entries are not what a provider entry here accepts");
				items.push({
					source: "deepseek-harness",
					from: label,
					to: "—",
					action: "skip",
					detail: "the section's baseURL or model entries are not usable in a provider entry",
					containsSecret: false,
				});
			} else {
				openaiCompatible.push(spec);
				items.push({
					source: "deepseek-harness",
					from: label,
					to: `settings.json → providers.openaiCompatible[${deepseekProviderId}]`,
					action: "map",
					detail: [
						`registered as "${deepseekProviderId}" with the endpoint and credential variable the section names`,
						dshModelCarryNote(declared, models.length, assumed, DSH_DEEPSEEK_DEFAULTS),
						`set ${apiKeyEnv} in your environment`,
					].join("; "),
					containsSecret: false,
				});
			}
		}
		if (deepseekSection.reasoningEffort !== undefined || deepseekSection.thinking !== undefined) {
			thinkingDefaults.push("llm-deepseek");
		}
	}
	if (thinkingDefaults.length > 0) {
		items.push({
			source: "deepseek-harness",
			from: `${settingsLabel} → ${summarizeNames(thinkingDefaults)}`,
			to: "—",
			action: "skip",
			detail:
				"thinking-effort defaults are recorded for the harness and not carried: this build chooses the effort per " +
				"request, so a stored default would describe something it does not do",
			containsSecret: false,
		});
	}
	mergeProviderSpecs(
		"deepseek-harness",
		openaiCompatible,
		(id) =>
			id === deepseekProviderId
				? `${settingsLabel} → llm-deepseek`
				: `${settingsLabel} → llm-pi-ai.providers.${id.replace(/^dsh-/, "")}`,
		items,
		settingsPatch,
		existing,
		force,
	);

	// The default model: a route name and a model id. Only worth claiming when that
	// pair still resolves to something this build can load.
	const route = typeof defaults?.provider === "string" ? defaults.provider.trim() : "";
	const modelId = typeof defaults?.model === "string" ? defaults.model.trim() : "";
	if (modelId !== "") {
		const from =
			route === ""
				? `${settingsLabel} → agent-default-model ("${modelId}")`
				: `${settingsLabel} → agent-default-model ("${route}/${modelId}")`;
		const declaredRoute = route !== "" && routes?.[route] !== undefined;
		const routeProviderId = `dsh-${route}`;
		const registered = declaredRoute ? dshRegisteredModels(settingsPatch, routeProviderId) : undefined;
		if (declaredRoute && registered?.has(modelId)) {
			claimScalar(
				"deepseek-harness",
				"model",
				`${routeProviderId}/${modelId}`,
				from,
				`carried on the "${routeProviderId}" provider entry registered above for the harness's "${route}" route; the prefix keeps a bare id that collides with a built-in from resolving somewhere else`,
			);
		} else if (declaredRoute) {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail: `the harness runs this model on its "${route}" route, which has no provider entry in this plan (${
					routeNotes.get(route) ?? `it does not list "${modelId}" among its models`
				}) — add "${modelId}" to providers.openaiCompatible[${routeProviderId}].models, then set model to "${routeProviderId}/${modelId}"`,
				containsSecret: false,
			});
		} else if (route === DSH_DEEPSEEK_ROUTE) {
			// The harness's own DeepSeek route: its section names both the endpoint and
			// the key variable. An id this build's table knows is claimed as the table's
			// own row only when the two agree about where the model is served — the same
			// id on a different endpoint is that endpoint's model, and re-pointing it
			// here would send the run to a host the user did not name.
			const resolved = resolveModelReference(modelId);
			const servedAt = resolved === undefined ? undefined : resolveModel(resolved)?.baseUrl;
			const harnessEndpoint = typeof deepseekSection?.baseURL === "string" ? deepseekSection.baseURL.trim() : "";
			const deepseekRegistered = dshRegisteredModels(settingsPatch, deepseekProviderId);
			const sectionNote = routeNotes.get(DSH_DEEPSEEK_ROUTE);
			if (resolved !== undefined && (harnessEndpoint === "" || harnessEndpoint === servedAt)) {
				claimScalar(
					"deepseek-harness",
					"model",
					resolved,
					from,
					`resolved to ${resolved} — the harness serves it over ${
						harnessEndpoint === "" ? "its own DeepSeek endpoint" : harnessEndpoint
					}, which is where this build sends the same id${
						sectionNote === undefined ? "" : ` (the section itself is not carried: ${sectionNote})`
					}`,
				);
			} else if (resolved !== undefined) {
				items.push({
					source: "deepseek-harness",
					from,
					to: "—",
					action: "skip",
					detail: `"${modelId}" is served here from ${servedAt}, while the harness serves it from ${harnessEndpoint} — the same id on another endpoint is that endpoint's model, so the name is not carried; set model to "${deepseekProviderId}/${modelId}" to run it there through the entry registered above`,
					containsSecret: false,
				});
			} else if (deepseekRegistered?.has(modelId)) {
				claimScalar(
					"deepseek-harness",
					"model",
					`${deepseekProviderId}/${modelId}`,
					from,
					`carried on the "${deepseekProviderId}" provider entry registered above from the harness's llm-deepseek section`,
				);
			} else {
				items.push({
					source: "deepseek-harness",
					from,
					to: "—",
					action: "skip",
					detail: `no model in this build's registry matches "${modelId}" — the model the harness runs on its "${route}" route; set model to a reference it carries, or register a provider entry for this one`,
					containsSecret: false,
				});
			}
		} else {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail:
					route === ""
						? "the harness's settings name a model without a route, so the endpoint that would serve it is not in the document — set model by hand"
						: `the harness runs "${modelId}" on "${route}", a route its settings document does not declare (the deployment composes it), so this importer cannot tell which endpoint would serve it — set model by hand if you know where it should point`,
				containsSecret: false,
			});
		}
	}

	// Permissions. The section names the preset a new session starts in, and a
	// preset is a *bundle*: a sandbox mode plus an approval policy. Only a bundle
	// that confines nothing and never asks coincides with a permission mode here —
	// a mode decides which calls ask, while a sandbox decides what the process may
	// touch at all, so neither implies the other. The name alone says nothing about
	// the bundle, which is why the entry is what gets read.
	const permissionSection = isRecord(raw.settings.permission) ? raw.settings.permission : undefined;
	const preset = typeof permissionSection?.defaultPreset === "string" ? permissionSection.defaultPreset.trim() : "";
	if (preset !== "") {
		const from = `${settingsLabel} → permission.defaultPreset ("${preset}")`;
		const table = isRecord(permissionSection?.presets) ? permissionSection.presets : undefined;
		const entry = table?.[preset];
		if (table !== undefined && isRecord(entry)) {
			const sandbox = typeof entry.sandbox === "string" ? entry.sandbox.trim() : "";
			const approval = typeof entry.approval === "string" ? entry.approval.trim() : "";
			if (sandbox === "danger-full-access" && approval === "never") {
				claimScalar(
					"deepseek-harness",
					"permissionMode",
					"bypassPermissions",
					from,
					`the document's "${preset}" preset bundles ${sandbox} with ${approval} — no confinement and no approval questions, which is what "bypassPermissions" means here`,
				);
			} else {
				items.push({
					source: "deepseek-harness",
					from,
					to: "—",
					action: "skip",
					detail: `the document's "${preset}" preset bundles ${sandbox || "an unnamed"} sandbox with ${approval || "an unnamed"} approval — a sandbox and a permission mode are different axes: a mode decides which calls ask, a sandbox decides what the process may touch at all; pick a mode with /permissions`,
					containsSecret: false,
				});
			}
		} else if (table !== undefined) {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail: `the document names "${preset}" while the permission.presets table it states does not define that name — a default the harness cannot resolve to a sandbox and an approval policy, so no mode is picked from it; pick one with /permissions`,
				containsSecret: false,
			});
		} else if (preset === DSH_SHIPPED_BYPASS_PRESET) {
			// No table in the document, so the harness's shipped one applies, and its
			// two entries are named after their own sandbox modes.
			claimScalar(
				"deepseek-harness",
				"permissionMode",
				"bypassPermissions",
				from,
				`"${preset}" is one of the harness's shipped presets, whose bundle is an unconfined sandbox and no approval questions — the same meaning as "bypassPermissions" here; the document states no table of its own, so the shipped one is the one that applies`,
			);
		} else {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail:
					preset === "workspace-write"
						? 'the harness\'s shipped "workspace-write" preset is a sandbox that confines writes plus an ask-for-approval policy — a sandbox and a permission mode are different axes, and there is no sandbox here for the confinement to mean anything; pick a mode with /permissions'
						: `"${preset}" is not a name in the harness's shipped preset table, and the table a deployment composes for itself lives in its composition rather than in this document — a name alone does not say which sandbox and approval it stands for; pick a mode with /permissions`,
				containsSecret: false,
			});
		}
	}

	// MCP servers come from the root's cordis patches. The sibling reader has
	// already decided which rows are usable; what is left here is what this build's
	// config can hold, and what it cannot.
	if (raw.mcp.notes.length > 0) {
		items.push({
			source: "deepseek-harness",
			from: `${tildePath(home, raw.root)} → cordis patches`,
			to: "—",
			action: "skip",
			detail: `${raw.mcp.notes.length} composition file(s) contributed no server — ${summarizeNames(
				raw.mcp.notes.map((note) => `${tildePath(home, note.from)} (${note.reason})`),
			)}`,
			containsSecret: false,
		});
	}
	for (const server of raw.mcp.servers) {
		const from = `${tildePath(home, server.from)} → mcp server "${server.name}"`;
		const prepared = dshMcpConfig(server);
		if (prepared === null || !McpServerConfigSchema.safeParse(prepared.config).success) {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail: `the ${server.transport} server does not carry what this build's config needs to start it`,
				containsSecret: false,
			});
			continue;
		}
		if (server.name in existingMcpServers && !force) {
			items.push({
				source: "deepseek-harness",
				from,
				to: "—",
				action: "skip",
				detail: "target already defines a server with this name — kept (use --force to overwrite)",
				containsSecret: false,
			});
			continue;
		}
		// Any env or header value counts as credential-bearing: a stdio server's env
		// is where its keys live, and a header value is often a bearer token. Saying
		// so costs one line of notice; the other error writes a credential into a
		// file the report calls ordinary.
		const secret = prepared.secret;
		mcpServers[server.name] = prepared.config;
		markMcpSecret(secret);
		items.push({
			source: "deepseek-harness",
			from,
			to: `.mcp.json → mcpServers.${server.name}`,
			action: "map",
			detail: secret ? "copied verbatim, including its environment or header values" : "copied verbatim",
			containsSecret: secret,
		});
	}

	// Files and trees that exist and are deliberately never read. Naming them is
	// what keeps their absence from the plan reading as a decision rather than an
	// oversight.
	if (raw.credentialsPresent) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, ".credentials.yaml")),
			to: "—",
			action: "skip",
			detail:
				"the harness's credential store — reported by name and never opened; copy anything you need out of it by hand",
			containsSecret: false,
		});
	}
	if (raw.envFilePresent) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, ".env")),
			to: "—",
			action: "skip",
			detail: "the harness's environment file — reported by name and never opened; export what it holds yourself",
			containsSecret: false,
		});
	}
	if (raw.presetCount > 0) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, ".agent-presets")),
			to: "—",
			action: "skip",
			detail: `${raw.presetCount} agent preset(s) — whole agent compositions, which are another product's plugin wiring rather than settings this build has a key for`,
			containsSecret: false,
		});
	}
	if (raw.attachmentsPresent) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, "attachments")),
			to: "—",
			action: "skip",
			detail: "session payloads stored beside the sessions — named only, never walked",
			containsSecret: false,
		});
	}
	if (raw.storagesPresent) {
		items.push({
			source: "deepseek-harness",
			from: tildePath(home, join(raw.root, "storages")),
			to: "—",
			action: "skip",
			detail: "non-session storage the harness keeps — named only, never walked",
			containsSecret: false,
		});
	}
}

/**
 * Where the report says grok's `config.toml` lives.
 *
 * Not `~/${SOURCE_ROOTS[id]}/config.toml`: `$GROK_HOME` can point anywhere, and
 * that spelling would name a file the reader never opened.
 */
function grokConfigPath(home: string, root: string): string {
	return tildePath(home, join(root, "config.toml"));
}

/** The first string in a value that may be a string or a list of them (`env_key`). */
function firstGrokString(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (Array.isArray(value))
		return grokStringList(value)
			.find((entry) => entry.trim() !== "")
			?.trim();
	return undefined;
}

/** Context window assumed for an imported endpoint whose source states no `context_window`. */
const GROK_ASSUMED_CONTEXT_WINDOW = 128_000;

/**
 * `[models]` keys this importer reports rather than carries.
 *
 * Each is a decision a user could have made and then gone looking for. They are
 * listed rather than left to the closing aggregate because each has a *reason* —
 * something this build does differently, not merely a key with no mapping — and
 * a refusal that explains itself is worth more than a name in a list.
 */
const GROK_UNMIGRATED_MODEL_KEYS: Array<[key: string, reason: string]> = [
	["default_reasoning_effort", "thinking level is chosen per request here, so there is no session-wide default to set"],
	["allowed_models", "a picker allowlist; the models offered here are the built-in catalogue plus your providers"],
	["hidden_models", "picker visibility only — nothing here hides a model"],
	["disabled_models", "removes rows from grok's own catalogue, which is not the catalogue here"],
	["web_search", "names the model grok's web_search tool runs on; search here is a tool call on the session model"],
	["session_summary", "names the model that writes session titles; titles here come from the session model"],
	["image_description", "names the vision model that transcribes pasted images; images go to the session model here"],
	["prompt_suggestion", "names the model behind next-prompt ghost text, which this build does not have"],
	["agent_type", "an agent-definition type for models that name none; agent definitions here are markdown files"],
	[
		"extra_headers",
		"request headers applied to every model — a provider entry here carries an endpoint and a credential " +
			"variable, not headers, so the gateway has to accept what the endpoint sends",
	],
	["max_retries", "inference retry policy, which lives in the provider adapters here rather than in settings"],
	["inference_idle_timeout_secs", "a streaming idle timeout the adapters set for themselves here"],
	["max_completion_tokens", "a global output cap each model overrides; the output budget here is per model"],
	["temperature", "sampling is not configurable per model here"],
	["top_p", "sampling is not configurable per model here"],
	["stream_tool_calls", "a tool-call streaming request shape some BYOK endpoints need; the wire shape here is fixed"],
	["rate_limit_retry_threshold", "retry behaviour on 429s, which the adapters own here"],
	["subagent_rate_limit_max_attempts", "retry behaviour on 429s in subagents, which the adapters own here"],
];

/**
 * `config.toml` sections that get a line of their own rather than a mapping.
 *
 * Every documented key a user could plausibly have set is here, because the one
 * thing a migration report may not do is leave a setting looking simply missed.
 * The reasons are deliberately not interchangeable: each says what the section
 * holds and what this build does instead.
 */
const GROK_UNMIGRATED_SECTIONS: Array<[key: string, reason: string]> = [
	["agent", "names the agent definition grok loads for the session; agents here are files under ~/.labunbun/agents"],
	[
		"auth_provider",
		"named helpers that mint a bearer token for a model entry; a provider here reads its key from an " +
			"environment variable instead",
	],
	[
		"auto_mode",
		"grok's classifier mode, which approves calls it judges safe — there is no classifier here, and the " +
			"nearest mode, dontAsk, does the opposite",
	],
	["default_auto_mode", "starts sessions in that classifier mode; see [auto_mode]"],
	["announcements", "payloads the deployment publishes, not preferences you wrote"],
	["campaigns", "patches the deployment publishes, not preferences you wrote"],
	[
		"cli",
		"update channel, version pins and worktree preferences — this build has no updater or version pin, and " +
			"its own flags",
	],
	["consent", "consent records for grok's servers; nothing here reports to them"],
	["dashboard", "which panes grok's dashboard shows, which is its own interface state"],
	["disable_web_search", "drops grok's web_search tool; which tools may run here is decided by permission rules"],
	["diagnostics", "the panic-report switch for grok's crash handler"],
	["doom_loop_recovery", "grok's own repeated-call detector"],
	["endpoints", "endpoint overrides for grok's services"],
	["feedback", "where feedback uploads go for grok's servers"],
	["goal", "a standing goal applied to every session; there is no such setting here"],
	["grok_com_config", "sign-in settings for grok.com — the same table as [auth], and named rather than read"],
	["harness", "trace-upload timing for grok's servers"],
	["hints", "which worktree offer a /fork or /new shows, which is grok's own interface behaviour"],
	[
		"hooks",
		"matcher groups with command handlers — close to the shape settings.json → hooks takes, but this " +
			"importer does not translate them, so a hook that guards or annotates a tool call is not in force here " +
			"until it is copied over by hand",
	],
	["managed_mcps", "MCP servers the deployment provisions at startup"],
	["marketplace", "plugin marketplace sources; plugins here are read as files rather than subscribed to"],
	["mcp", "the MCP client's own output cap, which the client here sets for itself"],
	[
		"memory",
		"switches for grok's memory subsystem; memory here is the rule files and MEMORY.md a session reads, with " +
			"no extraction pipeline to enable",
	],
	["memory_v2", "the same subsystem's second-generation switches; see [memory]"],
	[
		"path_not_found_hints",
		"enriches path-not-found errors with suggestions; the tools here report the error as it stands",
	],
	["privacy", "a banner-dismissal timestamp for grok's own interface"],
	["relay", "session relay sync to grok's servers, which has no counterpart here"],
	[
		"sandbox",
		"filesystem sandbox profiles (off/workspace/read-only/strict); the shell here is gated by permission " +
			"rules rather than confined by a sandbox",
	],
	[
		"session",
		"the compaction threshold, which follows the model's context window here, and .envrc injection into " +
			"the shell, which this build does not do",
	],
	[
		"shell_environment_policy",
		"what grok's child shells inherit and are handed; env in settings here is injected into this process, " +
			"which is a different thing",
	],
	["storage", "how long grok keeps idle session folders, which is its own storage"],
	[
		"subagents",
		"concurrency, nesting depth and per-type model overrides; the subagent pool here has its own defaults " +
			"and no per-type model table",
	],
	["telemetry", "OpenTelemetry export to grok's servers"],
	["tools", "gitignore handling, media-generation caps and ZDR switches for grok's tool set"],
	[
		"toolset",
		"timeouts, output limits, the file-edit scheme and web allowlists — the tools here fix their own, and " +
			"none of it is per-source configuration",
	],
	["ui", "grok's interface preferences (theme, density, collapsed edits, contextual hints)"],
	["version_overrides", "CLI version pins"],
	["voice", "dictation settings for grok's interface"],
	["workflows", "named workflows declared in config; workflows here are agent definitions and skills"],
	["worktree", "how grok lays out a session's worktree; the worktrees here are git's own"],
];

/**
 * The tool prefixes a *compact* `[permission]` rule may use.
 *
 * Exactly `tool_name_to_filter` (`permission/rules.rs:244`), which is what the
 * array form's parser consults and what it rejects everything else against. Two
 * things about it are easy to guess wrong from the config reference: the
 * spellings are PascalCase with no lowercase arm at all, and there are **no
 * entries for `Any` or `WebSearch`-as-a-filter** beyond the ones listed — a
 * `bash(...)` or `Any(...)` in that array is an `UnknownToolPrefix` warning and a
 * dropped rule, not a rule in force. Carrying one across as if grok had read it
 * would put a rule in this build's list that the user's grok never had.
 */
const GROK_COMPACT_TOOL_NAMES: Record<string, string> = {
	Bash: "bash",
	Read: "read",
	Edit: "edit",
	Write: "edit",
	MCPTool: "mcp",
	Grep: "grep",
	Glob: "grep",
	WebFetch: "webfetch",
	WebSearch: "websearch",
	AgentMessage: "agent_message",
	SendSubagentMessage: "agent_message",
	// The legacy spelling of the same filter, which still parses.
	SendAgentMessage: "agent_message",
};

/**
 * The tool names a *verbose* `[[permission.rules]]` entry may use.
 *
 * A different vocabulary entirely: that field is the serde lowercase name of
 * `ToolFilter`, so `Any` and `Bash` — valid prefixes in the array form — do not
 * deserialize here, and a table holding one costs grok *every* rule in it. The
 * set is narrower than the compact one: `ToolFilter` has no `websearch` variant,
 * so `tool = "websearch"` is one of those table-failing values rather than a
 * search rule, and a name this table does not know is reported as exactly that.
 */
const GROK_VERBOSE_TOOL_NAMES: Record<string, string> = {
	any: "any",
	bash: "bash",
	edit: "edit",
	read: "read",
	grep: "grep",
	mcp: "mcp",
	webfetch: "webfetch",
	agent_message: "agent_message",
	// The `alias` on the same serde field.
	agentmessage: "agent_message",
};

/** Rule prefixes grok itself refuses (`UnsupportedToolPrefix`), with the reason it gives. */
const GROK_UNSUPPORTED_RULE_FORMS = ["EnterWorktree", "NotebookEdit", "NotebookRead"];

/** The `Tool(pattern)` form, split the way grok splits it. */
interface GrokRuleParts {
	tool: string;
	pattern?: string;
	domain: boolean;
}

/**
 * Index of the first `target` at or after `from` that is not backslash-escaped.
 *
 * grok's rule parser is escape-aware (`is_unescaped`), so `Read(a\)b.md)` is one
 * rule with a parenthesis in its pattern rather than a malformed one. `last`
 * selects the search direction grok uses for the closing parenthesis.
 */
function indexOfUnescaped(text: string, target: string, last = false): number {
	const indexes: number[] = [];
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== target) continue;
		let backslashes = 0;
		let back = index;
		while (back > 0 && text[back - 1] === "\\") {
			backslashes += 1;
			back -= 1;
		}
		if (backslashes % 2 === 0) indexes.push(index);
	}
	return last ? (indexes.at(-1) ?? -1) : (indexes[0] ?? -1);
}

/**
 * One compact `[permission]` entry, split the way grok splits it.
 *
 * A mirror of `parse_permission_rule` (`permission/rules.rs:109`) down to the
 * parts this translation needs: the `Tool(...)` prefix and its content, the
 * trailing `:*` that means "the command starts with this" rather than "this
 * glob", the `domain:` marker, and the `.claude` `mcp__<server>[__<tool>]`
 * spelling grok rewrites onto its own qualified names. A prefix grok refuses is
 * refused here too, so the two cannot disagree about which rules exist.
 *
 * The two shapes fail differently on purpose: a bad *compact* entry is warned
 * about and dropped while its neighbours load, but a bad entry in the verbose
 * `rules` array fails the deserialization of the whole table, so grok ends up
 * with **no** rules from it. The caller reproduces both granularities.
 */
function parseGrokRuleText(text: string): GrokRuleParts | { invalid: string } {
	const rule = text.trim();
	if (GROK_UNSUPPORTED_RULE_FORMS.includes(rule)) {
		return { invalid: "grok refuses this tool prefix itself, so no rule was ever in force for it" };
	}
	const open = indexOfUnescaped(rule, "(");
	if (open === -1) {
		// A bare name. grok knows some; the rest fall through to a match-anything
		// rule whose pattern is the literal itself.
		const tool = GROK_COMPACT_TOOL_NAMES[rule];
		if (tool !== undefined) return { tool, domain: false };
		if (rule.startsWith("mcp__")) {
			const rest = rule.slice("mcp__".length);
			if (rest === "") return { tool: "any", pattern: rule, domain: false };
			if (rest === "*") return { tool: "mcp", domain: false };
			// `<server>__<tool>` is already the qualified name; a server alone
			// covers every tool on it.
			return { tool: "mcp", pattern: rest.includes("__") ? rest : `${rest}__*`, domain: false };
		}
		return { tool: "any", pattern: rule === "" ? undefined : rule, domain: false };
	}
	const prefix = rule.slice(0, open).trim();
	if (GROK_UNSUPPORTED_RULE_FORMS.includes(prefix)) {
		return { invalid: "grok refuses this tool prefix itself, so no rule was ever in force for it" };
	}
	// The closing parenthesis is searched for *after* the opening one, as grok
	// does — a `)` before it is part of neither the prefix nor the content.
	const after = rule.slice(open + 1);
	const closeRel = indexOfUnescaped(after, ")", true);
	if (closeRel === -1) return { invalid: "no closing parenthesis — grok drops a rule it cannot parse" };
	const tool = GROK_COMPACT_TOOL_NAMES[prefix];
	if (tool === undefined) {
		return { invalid: `grok does not know the tool prefix "${prefix}" — it warns and drops the rule` };
	}
	// Whatever follows the closing parenthesis is not read at all: grok takes the
	// content up to it and discards the rest, so `Bash(ls) # note` is the rule
	// `Bash(ls)` and is carried as one.
	const content = after.slice(0, closeRel).trim();
	// Empty content and a lone `*` both mean a tool-wide rule in grok. The order
	// of the three strips is grok's: bash colon suffix, then the `domain:` prefix,
	// and only then is an empty pattern read as "no pattern at all".
	let pattern = content === "" || content === "*" ? "" : unescapeGrokRule(content);
	if (tool === "bash") pattern = pattern.endsWith(":*") ? pattern.slice(0, -":*".length) : pattern;
	const domain = pattern.startsWith("domain:");
	const bare = domain ? pattern.slice("domain:".length) : pattern;
	return { tool, pattern: bare === "" ? undefined : bare, domain };
}

/** grok's own reverse of its rule escaping. */
function unescapeGrokRule(text: string): string {
	if (!text.includes("\\")) return text;
	return text.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

/**
 * One grok rule as this build's rule text, or the reason it cannot become one.
 *
 * Three differences between the two engines drive this, and every one of them
 * would be silent if the pattern were copied across:
 *
 *   - grok matches a `Bash` pattern against a command that *starts with* it as
 *     well as against one it globs, while a rule here is either an exact string
 *     or a glob. So a pattern carrying no wildcard gets a trailing `*`, which is
 *     exactly the prefix match and nothing wider (`Bash(sed:*)` in grok blocks
 *     `sed-custom`, and `Bash(sed*)` here does too).
 *   - grok's `edit` covers writes, and `Edit(...)` here does not match the
 *     `Write` tool — so one source rule becomes two. A file protection that
 *     covers half of what it did is not something to let a user discover.
 *   - grok spells MCP tools `server__tool`, this build spells them
 *     `mcp__server__tool`, and a rule written in the source's own `.claude`
 *     spelling is rewritten by grok before it is ever matched.
 *
 * `Any` is refused in both of its forms: bare it is a catch-all (grok drops
 * exactly these from `--allow`), and patterned it matches whatever text the call
 * happens to carry, which a rule here has no form for.
 */
function grokRuleText(
	tool: string,
	pattern: string | undefined,
	domain: boolean,
): { texts: string[]; note?: string } | { reason: string } {
	if (tool === "any") {
		if (pattern === undefined || pattern === "") {
			return {
				reason:
					"a catch-all rule — grok drops exactly these from its own --allow, and one here would allow or " +
					"deny every tool at once",
			};
		}
		return {
			reason: `matched against whatever text the call carries ("${clipped(pattern)}") — a rule here names a tool, so this one would be stored and never read`,
		};
	}
	if (tool === "grep" || tool === "webfetch" || tool === "websearch") {
		return {
			reason:
				`a ${tool} rule — the engine here consults rules for Bash, Read/Edit/Write and MCP tools, so this ` +
				"one would be stored and never read" +
				(domain ? "; and `domain:` means nothing to a rule nothing consults" : ""),
		};
	}
	if (tool === "agent_message") {
		return { reason: "grok's message-a-subagent tool has no counterpart here, so there is nothing for it to gate" };
	}
	if (tool === "mcp") {
		// grok's qualified name is `server__tool` (or `server__*`); the bare-tool
		// form is how a rule for one is written here.
		if (pattern === undefined || pattern === "") return { texts: ["mcp__*"] };
		return { texts: [`mcp__${pattern}`] };
	}
	const spec = pattern ?? "";
	if (tool === "bash") {
		const globbed = spec === "" || /[*?[\]]/.test(spec) ? spec : `${spec}*`;
		return { texts: [globbed === "" ? "Bash" : `Bash(${globbed})`] };
	}
	if (tool === "read") return { texts: [spec === "" ? "Read" : `Read(${spec})`] };
	if (tool === "edit") {
		return {
			texts: [spec === "" ? "Edit" : `Edit(${spec})`, spec === "" ? "Write" : `Write(${spec})`],
			note: "two rules here, because grok's `edit` covers writes and a rule here names one tool",
		};
	}
	return { reason: `a rule for "${tool}", which has no counterpart here` };
}

/** A pattern echoed into a report line, kept short because the report is read in a transcript. */
function clipped(text: string): string {
	return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * `[permission]` in grok's `config.toml`, carried over as this build's rules.
 *
 * The two shapes grok accepts do not merge, and the difference is worth getting
 * right: when any of the compact `allow` / `deny` / `ask` keys holds an array,
 * `parse_toml_permission_section` returns those and **never looks at
 * `[[permission.rules]]`**. A file with both is therefore reported as the one
 * grok reads rather than as their union — importing the other half would put
 * rules in force here that were never in force there.
 *
 * The verbose shape carries its own trap, and it is not the one the config
 * reference implies: an entry with no `action` does not default to deny, it fails
 * the parse and takes the whole table with it (see {@link readGrokVerboseRules}).
 * That is what the report says, rather than a rule-by-rule account of rules
 * nothing ever loaded.
 *
 * `ask` has no tier here, exactly as Codex's `prompt` decision does not: the
 * rules that carry it are named rather than turned into an allow or a deny.
 */
function planGrokPermissions(
	raw: RawGrokBuild,
	home: string,
	items: MigrationItem[],
	addPermissionRules: AddPermissionRules,
): void {
	const permission = isRecord(raw.config.permission) ? raw.config.permission : undefined;
	if (!permission) return;
	const from = `${grokConfigPath(home, raw.root)} → [permission]`;
	const allow: string[] = [];
	const deny: string[] = [];
	const notes: string[] = [];
	const refused: string[] = [];
	const askCount = { value: 0 };

	/**
	 * Translate one rule and file it under its action.
	 *
	 * `action` is "ask" for grok's middle tier, which lands in `refused`: there is
	 * no ask tier here, and the source's own wording for that is in the count.
	 */
	const take = (action: string, tool: string, pattern: string | undefined, domain: boolean, where: string): void => {
		if (action === "ask") {
			askCount.value += 1;
			return;
		}
		if (action !== "allow" && action !== "deny") {
			refused.push(`${where} — unknown action "${action}"`);
			return;
		}
		const translated = grokRuleText(tool, pattern, domain);
		if ("reason" in translated) {
			refused.push(`${where} — ${translated.reason}`);
			return;
		}
		if (translated.note) notes.push(translated.note);
		(action === "allow" ? allow : deny).push(...translated.texts);
	};

	/** The compact keys grok reads first, in the order it reads them. */
	let compact = false;
	for (const [action, key] of GROK_COMPACT_KEYS) {
		const value = permission[key];
		if (value === undefined) continue;
		if (!Array.isArray(value)) {
			// grok warns and falls through to the verbose table rather than failing.
			items.push({
				source: "grok-build",
				from: `${from} → ${key}`,
				to: "—",
				action: "skip",
				detail: `not an array of rule strings, so grok warns about it and reads the rules below instead; its ${describeGrokValue(value)} is left where it is`,
				containsSecret: false,
			});
			continue;
		}
		compact = true;
		value.forEach((entry, index) => {
			const where = `${key}[${index}]`;
			if (typeof entry !== "string") {
				refused.push(`${where} — not a rule string`);
				return;
			}
			const parsed = parseGrokRuleText(entry);
			if ("invalid" in parsed) {
				refused.push(`${where} ("${clipped(entry)}") — ${parsed.invalid}`);
				return;
			}
			take(action, parsed.tool, parsed.pattern, parsed.domain, where);
		});
	}

	if (!compact && permission.rules !== undefined) {
		planGrokVerboseRules(permission, from, items, take);
	} else if (compact && permission.rules !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → rules`,
			to: "—",
			action: "skip",
			detail:
				"grok reads the compact allow/deny/ask arrays and never opens this table when they are present, so " +
				"its rules are not in force there and are not imported here either",
			containsSecret: false,
		});
	}

	// Named rather than imported: see {@link GROK_PROMPT_POLICY_REASON}. It sits
	// with the rules because this is the table it was written in, and a user who
	// set a policy here is owed the news that grok never read it.
	if (permission.prompt_policy !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → prompt_policy`,
			to: "—",
			action: "skip",
			detail: GROK_PROMPT_POLICY_REASON,
			containsSecret: false,
		});
	}

	if (askCount.value > 0) {
		refused.push(
			`${askCount.value} rule(s) the source asks about — there is no ask tier here, and turning a question ` +
				"into an allow would be the wrong half of it",
		);
	}
	const overlap = allow.filter((rule) => deny.includes(rule));
	if (overlap.length > 0) {
		notes.push(
			`${overlap.length} rule(s) appear as both an allow and a deny; deny wins here as it does in grok, and ` +
				"the allow is left in place so the file still reads like the decision that was made",
		);
	}

	const caveat =
		"an allowed command runs without a prompt here, and a deny blocks it whatever else is allowed" +
		(notes.length > 0 ? ` — ${[...new Set(notes)].join("; ")}` : "");
	if (allow.length > 0) addPermissionRules("grok-build", "allow", allow, `${from} → allow`, caveat);
	if (deny.length > 0) addPermissionRules("grok-build", "deny", deny, `${from} → deny`, caveat);
	if (refused.length > 0) {
		items.push({
			source: "grok-build",
			from,
			to: "—",
			action: "skip",
			detail: `${refused.length} rule(s) not carried: ${summarizeNames(refused, 3)}`,
			containsSecret: false,
		});
	}
	reportUnhandledKeys("grok-build", permission, GROK_PERMISSION_HANDLED, from, items);
}

/** What a value is, for a report line that may not print it. */
function describeGrokValue(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

/** One verbose `[[permission.rules]]` entry, as this translation needs it. */
interface GrokVerboseRule {
	action: string;
	tool: string;
	pattern?: string;
	domain: boolean;
}

/**
 * Read the verbose `[permission]` table the way serde reads it, reporting nothing.
 *
 * **`action` is required**, and that is the trap in this shape: `RuleAction`
 * carries `#[default] Deny` (CWE-1188) and `PermissionRule.tool` and
 * `pattern_mode` carry field-level `#[serde(default)]` — but the action field
 * carries none, and the struct has no container-level default either. So the
 * `Deny` default is what *Rust* code gets when it constructs a rule, not what a
 * missing key deserializes to: an entry with no `action` fails the parse, and
 * because `try_into::<PermissionConfig>()` is all-or-nothing, grok then holds
 * **none** of the table's rules. Reading that entry as a deny would put a refusal
 * in force here that was never in force there.
 *
 * Pure, and called from two places on purpose: the rule translator needs the
 * rules, and the policy reader needs to know whether this section loaded at all
 * (a failed table leaves the policy at its type default too). One reader, so the
 * two cannot disagree about whether the user's rules ever applied.
 */
function readGrokVerboseRules(permission: Record<string, unknown>): { rules: GrokVerboseRule[]; omitted: string[] } {
	const rules = permission.rules;
	// A missing `rules` key is the container's own `#[serde(default)]`: an absent
	// table is simply no rules.
	if (rules === undefined) return { rules: [], omitted: [] };
	if (!Array.isArray(rules)) return { rules: [], omitted: ["`rules` is not an array of tables"] };
	/** A string field as serde reads it, or `undefined` when its shape fails the table. */
	const textField = (entry: Record<string, unknown>, name: string, fallback: string): string | undefined => {
		const value = entry[name];
		if (value === undefined) return fallback;
		return typeof value === "string" ? value : undefined;
	};
	const parsed: GrokVerboseRule[] = [];
	for (const [index, entry] of rules.entries()) {
		const where = `rules[${index}]`;
		// The first failure is the one serde reports, so it is the one carried.
		const fail = (detail: string): { rules: GrokVerboseRule[]; omitted: string[] } => ({
			rules: [],
			omitted: [`${where} ${detail}`],
		});
		if (!isRecord(entry)) return fail("is not a table");
		if (entry.action === undefined) return fail("has no action, which this shape requires");
		const action = textField(entry, "action", "deny");
		if (action !== "allow" && action !== "deny" && action !== "ask") {
			return fail(
				`has an action that is ${action === undefined ? "not a string" : `not one grok knows ("${action}")`}`,
			);
		}
		const toolName = textField(entry, "tool", "any");
		const tool = toolName === undefined ? undefined : GROK_VERBOSE_TOOL_NAMES[toolName];
		if (tool === undefined) {
			return fail(
				`names a tool that is ${toolName === undefined ? "not a string" : `not one this shape knows ("${toolName}")`}`,
			);
		}
		const mode = textField(entry, "pattern_mode", "glob");
		if (mode !== "glob" && mode !== "domain") {
			return fail(
				`has a pattern_mode that is ${mode === undefined ? "not a string" : `not one grok knows ("${mode}")`}`,
			);
		}
		if (entry.pattern !== undefined && typeof entry.pattern !== "string")
			return fail("has a pattern that is not a string");
		parsed.push({
			action,
			tool,
			pattern: typeof entry.pattern === "string" ? entry.pattern : undefined,
			domain: mode === "domain",
		});
	}
	return { rules: parsed, omitted: [] };
}

/**
 * The verbose `[[permission.rules]]` table, translated.
 *
 * The granularity is the point: one entry grok cannot deserialize costs it every
 * rule in the table, so the report says that rather than handing over rules grok
 * never loaded.
 */
function planGrokVerboseRules(
	permission: Record<string, unknown>,
	from: string,
	items: MigrationItem[],
	take: (action: string, tool: string, pattern: string | undefined, domain: boolean, where: string) => void,
): void {
	const read = readGrokVerboseRules(permission);
	if (read.omitted.length > 0) {
		unloadedTable(from, items, read.omitted);
		return;
	}
	for (const [index, rule] of read.rules.entries()) {
		take(rule.action, rule.tool, rule.pattern, rule.domain, `rules[${index}]`);
	}
}

/**
 * `[permission] prompt_policy`, which grok does not read from here.
 *
 * The key is real — a session's permission config does carry a `prompt_policy`,
 * and its `Deny` is grok's own dontAsk (`manager/mod.rs` logs
 * `always-approve is active while prompt_policy is dontAsk (Deny)`) — but it does
 * not come from this file. The `config.toml` loader keeps only the rule tables
 * (`extract_toml_permissions` → `parse_toml_permission_section` → a
 * `PermissionConfig` whose sole field is `rules`), and the shell's own test
 * `permission_prompt_policy_warns_as_unconsumed` pins that a `prompt_policy`
 * written in `[permission]` is reported to the user as an unrecognized key. The
 * policy the session actually runs with arrives from the Claude compat layer
 * instead: `DefaultPermissionMode::effects` maps a `.claude` settings
 * `permissions.defaultMode` of `dontAsk` to `Deny` and `auto` to `Auto`.
 *
 * So this is a line and not a mapping: carrying the value over would tell a user
 * that a policy grok warned about and ignored is now in force under another name,
 * and the mode it would have to become is precisely the one this migration may not
 * invent on the user's behalf.
 */
const GROK_PROMPT_POLICY_REASON =
	"grok does not read this key: its config.toml loader keeps only the rule tables and reports prompt_policy as " +
	"an unrecognized key, so nothing written here was ever in force — the policy a session runs with comes from the " +
	"Claude compat layer's permissions.defaultMode, which the claude-code source imports";

/** Keys of `[permission]` that this planner reads or names; the rest reach {@link reportUnhandledKeys}. */
const GROK_PERMISSION_HANDLED = new Set<string>(["rules", "allow", "deny", "ask", "prompt_policy"]);

/**
 * Keys of a `[model.<id>]` entry that this planner reads.
 *
 * The rest of such a table is a list of retunings — `reasoning_effort`,
 * `temperature`, `max_retries` — and each of them is reported rather than
 * dropped, for the same reason the `[models]` keys are: the entry itself may be
 * carried over, and a user reading that line would otherwise take it for a table
 * that came across whole.
 */
const GROK_MODEL_ENTRY_HANDLED = new Set<string>([
	"base_url",
	"api_base_url",
	"model",
	"context_window",
	"max_completion_tokens",
	"env_key",
	"api_key",
	"api_backend",
	// Read as of the provider table below: an entry that names one takes its
	// endpoint from it, which is how grok resolves such a model.
	"model_provider",
	// Read for presence, like `api_key`: a model that names a helper has a
	// credential of its own, so it inherits none of its provider's
	// (`with_provider_defaults`, `model_providers.rs:205-215`).
	"auth_provider",
]);

/**
 * Keys of a `[model_providers.<id>]` entry that this planner reads or names.
 *
 * The three header-shaped tables are named in one line rather than read: a
 * provider entry here carries an endpoint, a credential variable and models, so
 * there is nowhere for request headers or URL query parameters to go. `auth` and
 * `auth_provider` are likewise named: grok runs a command to mint the endpoint's
 * token, which is a mechanism this build does not have.
 */
const GROK_PROVIDER_ENTRY_HANDLED = new Set<string>([
	"base_url",
	"api_base_url",
	"context_window",
	"env_key",
	"api_key",
	"api_backend",
	"extra_headers",
	"query_params",
	"env_http_headers",
	"auth",
	"auth_provider",
]);

/** The compact `[permission]` keys, with the action each carries. */
const GROK_COMPACT_KEYS: Array<[action: "deny" | "allow" | "ask", key: string]> = [
	["deny", "deny"],
	["allow", "allow"],
	["ask", "ask"],
];

/**
 * One line for a `[[permission.rules]]` table grok could not read at all.
 *
 * The all-or-nothing part is the whole reason this is one line rather than a
 * per-entry account: `try_into::<PermissionConfig>()` either produces the table's
 * rules or produces none of them, so there is no shorter list to hand over.
 */
function unloadedTable(from: string, items: MigrationItem[], reasons: string[]): void {
	items.push({
		source: "grok-build",
		from: `${from} → rules`,
		to: "—",
		action: "skip",
		detail:
			`grok reads this section in one deserialization: ${reasons.join("; ")}. An entry it cannot read costs it ` +
			"every rule in the table, so none of them were in force there and none are imported here",
		containsSecret: false,
	});
}

/**
 * Rewrite one `[mcp_servers.<name>]` entry into this build's MCP shape.
 *
 * The transport is the same two shapes Codex uses, and grok reads its table
 * untagged — `Stdio` first — so an entry with both a `command` and a `url` is a
 * stdio server with an unused URL, exactly as it is there.
 *
 * Everything this refuses is a credential grok does not store: `bearer_token_env_var`,
 * `oauth_client_secret_env_var` and `env_http_headers` all name variables in the
 * user's environment. The server is copied and the report says which variables it
 * used to read — reading them here, or inventing an empty value, would turn a
 * working server into one that fails at connect time.
 */
function normalizeGrokMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const extras: string[] = [];
	for (const key of [
		"oauth",
		"setup",
		"startup_timeout_sec",
		"tool_timeout_sec",
		"tool_timeouts",
		"expose_image_base64",
	]) {
		if (entry[key] !== undefined) extras.push(key);
	}
	if (extras.length > 0) {
		downgrades.push(`the source's own ${summarizeNames(extras)} settings have no counterpart here`);
	}
	const url = typeof entry.url === "string" && entry.url.trim() ? entry.url : undefined;
	if (url !== undefined && typeof entry.command !== "string") {
		const out: Record<string, unknown> = { type: "http", url };
		if (isRecord(entry.headers)) out.headers = entry.headers;
		if (typeof entry.bearer_token_env_var === "string") {
			downgrades.push(`its Authorization header came from $${entry.bearer_token_env_var}, which is not expanded here`);
		}
		if (typeof entry.oauth_client_secret_env_var === "string") {
			downgrades.push(
				`its OAuth client secret came from $${entry.oauth_client_secret_env_var}, which is not expanded here`,
			);
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
		if (typeof entry.bearer_token_env_var === "string") {
			downgrades.push(
				`it read $${entry.bearer_token_env_var} for a bearer token in its environment, which is not expanded here`,
			);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	return null;
}

/**
 * `[models]`, `[model.<id>]`, `[model_providers.<id>]`, `[permission]`,
 * `[mcp_servers.*]` and the rest of grok's `config.toml`.
 *
 * `[model.<id>]` is grok's per-model override table. An entry becomes a provider
 * here when something gives it an endpoint: its own `base_url`/`api_base_url`, or
 * a `model_provider` naming a `[model_providers.<id>]` entry that has one. The
 * second spelling is easy to miss and was missed here: grok's own table sits one
 * level over from Codex's, and a model reaching through it has an endpoint while
 * its own table shows none. An entry with neither only retunes a row of grok's
 * own catalogue and stays behind.
 *
 * The credential rule shapes this function. grok accepts an inline `api_key`
 * there and this importer **does not read its value**: the settings schema here
 * holds a variable *name* and has nowhere to put a literal. So such an endpoint
 * is registered with the variable named after it, and the report says the key is
 * still in `config.toml` and has to be exported. Copying it into `settings.json`
 * would put a live credential in a second file, which is the one thing this
 * importer never does.
 */
function planGrokBuild(
	raw: RawGrokBuild,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const from = grokConfigPath(home, raw.root);
	if (raw.configError !== undefined) {
		items.push({
			source: "grok-build",
			from,
			to: "—",
			action: "skip",
			detail: `${raw.configError} — its settings, permission rules and MCP servers were not read`,
			containsSecret: false,
		});
	}

	// Key paths this parser can only read once a digits-only segment is quoted.
	// TOML spells a dot in a bare key as a path separator, so `[model.grok-4.6]` is
	// a table named `grok-4.6` to nobody: grok reads `grok-4` → `6`, and so does the
	// reader above. The user who wrote it meant a model by that name, which is a
	// different override and is not what either parser has — so the path is named
	// rather than imported as what it looks like.
	for (const path of raw.configDottedKeys) {
		const segments = path.split(".");
		const leaf = segments.at(-1) ?? "";
		const parent = segments.slice(0, -1).join(".");
		items.push({
			source: "grok-build",
			from: `${from} → ${path}`,
			to: "—",
			action: "skip",
			detail:
				"a bare digits-only segment after a dot is a key path, not part of a name: grok reads this as a table " +
				`named "${leaf}" inside "${parent}", and so does this importer. Quote the segment ` +
				`([${parent}."${leaf}"]) if you meant one key; nothing written under this path is imported either way`,
			containsSecret: false,
		});
	}

	// ── model_providers: the endpoint table a model inherits from ─────────────
	// grok resolves a model's connection through `with_provider_defaults`
	// (`agent/model_providers.rs:170`): the model's own fields win, and a model
	// that sets none of them inherits the provider's `base_url` / `api_base_url`,
	// `api_backend` and `context_window`, plus the provider's `env_key` / `api_key`
	// / credential helper when it has no credential of its own. So
	// `[model.<id>] model_provider = "gateway"` is an endpoint definition whose
	// endpoint is one table over, and reading only `[model.<id>]` reports "no
	// endpoint of its own" about a model that has one.
	const providerTable = isRecord(raw.config.model_providers) ? raw.config.model_providers : {};
	/** What a model entry can inherit from the provider it names. */
	const providers = new Map<
		string,
		{
			endpoint: string | undefined;
			contextWindow: number | undefined;
			envKey: string | undefined;
			inlineKey: boolean;
			apiBackend: string | undefined;
			authHelper: boolean;
		}
	>();
	/** Provider ids a model entry actually names; the rest are named as unread. */
	const namedProviders = new Set<string>();
	for (const [id, value] of Object.entries(providerTable)) {
		const label = `${from} → model_providers.${id}`;
		if (!isRecord(value)) {
			items.push({
				source: "grok-build",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a table, so grok reads no provider here and neither does this importer",
				containsSecret: false,
			});
			continue;
		}
		reportUnhandledKeys("grok-build", value, GROK_PROVIDER_ENTRY_HANDLED, label, items);
		const headers = ["extra_headers", "query_params", "env_http_headers"].filter((key) => isRecord(value[key]));
		if (headers.length > 0) {
			items.push({
				source: "grok-build",
				from: `${label} → ${summarizeNames(headers)}`,
				to: "—",
				action: "skip",
				detail:
					"folded into every request by grok, and inherited by the models that name this provider — request " +
					"headers, URL query parameters and header-to-variable mappings. A provider entry here carries an " +
					"endpoint, a credential variable and models, so there is nowhere to put them: an endpoint that " +
					"requires them will not answer the same way",
				containsSecret: false,
			});
		}
		const authNames = [
			value.auth !== undefined ? "auth" : null,
			firstGrokString(value.auth_provider) !== undefined ? "auth_provider" : null,
		].filter((name): name is string => name !== null);
		if (authNames.length > 0) {
			items.push({
				source: "grok-build",
				from: `${label} → ${authNames.join(", ")}`,
				to: "—",
				action: "skip",
				detail:
					"a credential helper grok runs to mint this endpoint's bearer token; this build reads a variable " +
					"name instead and runs nothing, so the helper's command is not carried across",
				containsSecret: false,
			});
		}
		providers.set(id, {
			endpoint: firstGrokString(value.base_url) ?? firstGrokString(value.api_base_url),
			contextWindow: positiveInteger(value.context_window),
			envKey: firstGrokString(value.env_key),
			inlineKey: firstGrokString(value.api_key) !== undefined,
			apiBackend: firstGrokString(value.api_backend),
			authHelper: authNames.length > 0,
		});
	}

	// ── models: the session model, and any endpoint the source defines ────────
	const models = isRecord(raw.config.models) ? raw.config.models : {};
	const table = isRecord(raw.config.model) ? raw.config.model : {};
	const specs: Array<Record<string, unknown>> = [];
	/** The endpoints offered this run, by the table key that named them. */
	const endpoints = new Map<string, { wireId: string; contextWindow: number; notes: string[] }>();
	/**
	 * Aliases that exist only because a dotted key path was repaired: `[model.grok-4.6]`
	 * leaves a table called `grok-4` holding one key. Its own line above says what
	 * it is, and this loop has nothing true to add — "an override of a model grok
	 * already knows" is not what the user wrote. An alias that a real `[model.grok-4]`
	 * table also contributes to has an endpoint and is planned as usual.
	 */
	const repairedAliases = new Set(
		raw.configDottedKeys
			.map((path) => path.split("."))
			.filter((segments) => segments[0] === "model" && segments.length > 2)
			.map((segments) => segments.slice(1, -1).join(".")),
	);
	for (const [alias, value] of Object.entries(table)) {
		if (!isRecord(value)) continue;
		const label = `${from} → model.${alias}`;
		const baseUrl = firstGrokString(value.base_url);
		const altBase = firstGrokString(value.api_base_url);
		const ownEndpoint = baseUrl ?? altBase;
		const providerId = firstGrokString(value.model_provider);
		const provider = providerId !== undefined ? providers.get(providerId) : undefined;
		if (providerId !== undefined) namedProviders.add(providerId);
		const endpoint = ownEndpoint ?? provider?.endpoint;
		if (repairedAliases.has(alias) && endpoint === undefined) continue;
		// Named before the endpoint test, because the entries that carry no endpoint
		// are exactly the ones most likely to carry something else — an override for
		// a model grok already knows is a table of retunings, and a key left out of
		// the report would read as a setting this importer forgot.
		reportUnhandledKeys("grok-build", value, GROK_MODEL_ENTRY_HANDLED, label, items);
		if (endpoint === undefined) {
			items.push({
				source: "grok-build",
				from: label,
				to: "—",
				action: "skip",
				detail:
					providerId !== undefined
						? `it names model_providers.${providerId}, which ${
								providers.has(providerId) ? "defines neither base_url nor api_base_url" : "this config does not define"
							} — grok resolves this model with no endpoint of its own, and so does this importer`
						: "an override of a model grok already knows; it names no endpoint of its own to register here",
				containsSecret: false,
			});
			continue;
		}
		const wireId = firstGrokString(value.model) ?? alias;
		// The provider's values apply only where the model states none. That is
		// grok's own merge: `or_else` for the connection fields, and all-or-nothing
		// for the credential — a model with any credential of its own takes none of
		// the provider's (`with_provider_defaults`, `model_providers.rs:205-218`).
		const ownEnvKey = firstGrokString(value.env_key);
		// Presence only. The value is never read, and never reaches a report.
		const ownInlineKey = firstGrokString(value.api_key) !== undefined;
		const ownAuthHelper = firstGrokString(value.auth_provider) !== undefined;
		const ownCredential = ownEnvKey !== undefined || ownInlineKey || ownAuthHelper;
		const envKey = ownCredential ? ownEnvKey : provider?.envKey;
		const inlineKey = ownCredential ? ownInlineKey : (provider?.inlineKey ?? false);
		const contextWindow =
			positiveInteger(value.context_window) ?? provider?.contextWindow ?? GROK_ASSUMED_CONTEXT_WINDOW;
		const maxOutputTokens = positiveInteger(value.max_completion_tokens) ?? ASSUMED_MAX_OUTPUT_TOKENS;
		const apiKeyEnv = envKey ?? `${alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		specs.push({ id: alias, baseUrl: endpoint, apiKeyEnv, models: [{ id: wireId, contextWindow, maxOutputTokens }] });
		const notes: string[] = [];
		if (ownEndpoint === undefined) {
			notes.push(`the endpoint is the one model_providers.${providerId} defines`);
		} else if (baseUrl === undefined) {
			notes.push("the endpoint is the one api_base_url names");
		}
		const backend = firstGrokString(value.api_backend) ?? provider?.apiBackend;
		if (backend !== undefined && backend !== "chat_completions") {
			notes.push(`api_backend is "${backend}", and an imported provider here speaks chat-completions`);
		}
		if (ownCredential) {
			if (inlineKey && envKey === undefined) {
				notes.push(
					`its key is written inline in config.toml (api_key) and was not read — export ${apiKeyEnv} with the same key, or the endpoint cannot authenticate`,
				);
			} else if (inlineKey) {
				notes.push(
					`an inline api_key is present as well and was not read; ${envKey} is the variable a provider here reads`,
				);
			} else if (envKey !== undefined) {
				notes.push(
					ownAuthHelper
						? `the credential is read from ${envKey}; auth_provider names a helper that mints one when that variable ` +
								`does not resolve, and it is not carried across`
						: `the credential is read from ${envKey}`,
				);
			} else {
				// The model names a helper and no variable. Without this branch the line
				// below would read "the credential is read from undefined" — a report
				// that names a variable which is not a variable.
				notes.push(
					`this model's token is minted by the credential helper auth_provider names, which is not carried across — ` +
						`export ${apiKeyEnv} with a key for that endpoint`,
				);
			}
		} else if (provider?.inlineKey) {
			notes.push(
				`the key for it is written inline in config.toml (api_key on model_providers.${providerId}) and was not ` +
					`read — export ${apiKeyEnv} with the same key, or the endpoint cannot authenticate`,
			);
		} else if (envKey !== undefined) {
			notes.push(`the credential comes from ${envKey}, the variable its provider's env_key names`);
		} else if (provider?.authHelper) {
			notes.push(
				`model_providers.${providerId} mints its token with a credential helper, which is not carried across — ` +
					`export ${apiKeyEnv} with a key for that endpoint`,
			);
		} else {
			notes.push(
				`no env_key is recorded, so the provider is registered against ${apiKeyEnv} — set it if the endpoint needs a key`,
			);
		}
		endpoints.set(alias, { wireId, contextWindow, notes });
	}

	// A provider no model resolves through is inert in grok — `model_providers` is
	// consulted per model override and nowhere else — so it is named rather than
	// imported as an endpoint the user would find in the target and wonder about.
	for (const id of Object.keys(providerTable)) {
		if (namedProviders.has(id)) continue;
		items.push({
			source: "grok-build",
			from: `${from} → model_providers.${id}`,
			to: "—",
			action: "skip",
			detail:
				"no model in this config names it, and grok reaches a provider only through the model that names it — " +
				"nothing here is resolved through this table, so no endpoint is registered for it",
			containsSecret: false,
		});
	}
	// The endpoints that actually reached the patch, as reported by the merge
	// itself: an entry the target already defines is kept, and a "map" line for it
	// would say an endpoint moved when it did not.
	const acceptedProviders = new Set(
		mergeProviderSpecs("grok-build", specs, (id) => `${from} → model.${id}`, items, settingsPatch, existing, force),
	);
	for (const [alias, spec] of endpoints) {
		if (!acceptedProviders.has(alias)) continue;
		items.push({
			source: "grok-build",
			from: `${from} → model.${alias}`,
			to: `settings.json → providers.openaiCompatible[${alias}]`,
			action: "map",
			detail: `endpoint carried over for "${spec.wireId}" with a ${spec.contextWindow}-token context window; ${spec.notes.join("; ")}`,
			containsSecret: false,
		});
	}

	const defaultModel = firstGrokString(models.default);
	if (defaultModel !== undefined) {
		const label = `${from} → models.default ("${defaultModel}")`;
		const own = endpoints.get(defaultModel);
		if (own !== undefined && acceptedProviders.has(defaultModel)) {
			claimScalar(
				"grok-build",
				"model",
				`${defaultModel}/${own.wireId}`,
				label,
				`registered under the "${defaultModel}" provider the source defines`,
			);
		} else {
			const resolved = resolveModelReference(defaultModel);
			if (resolved) {
				claimScalar("grok-build", "model", resolved, label, `resolved to ${resolved}`);
			} else {
				items.push({
					source: "grok-build",
					from: label,
					to: "—",
					action: "skip",
					detail:
						"no model here answers to that name — register the endpoint that serves it, then set the " +
						"model reference by hand",
					containsSecret: false,
				});
			}
		}
	}
	for (const [key, reason] of GROK_UNMIGRATED_MODEL_KEYS) {
		if (models[key] === undefined) continue;
		items.push({
			source: "grok-build",
			from: `${from} → models.${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}

	// ── permission: the mode here, the rules in the dispatch ─────────────────
	// The rules are planned from `planGrokPermissions` beside this call rather
	// than inside it, the way Codex's are: the list they append to is built in the
	// dispatch, and a planner that reached for it would take the whole accumulator
	// as a parameter.
	planGrokPermissionMode(raw, home, items, claimScalar);

	// The policy files beside `config.toml` are not a second copy of the user's
	// preferences: `requirements.toml` is where `disable_bypass_permissions_mode`
	// lives and `managed_config.toml` is pushed by an administrator. Carrying one
	// over would put an admin's requirement in the user's own settings file, where
	// it stays in force as the user's own choice after the machine stops being
	// administered — and the user never chose it. See {@link GROK_MACHINE_POLICY}.
	if (raw.machinePolicy.length > 0) {
		items.push({
			source: "grok-build",
			from: `${grokConfigPath(home, raw.root)} → ${raw.machinePolicy.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				"machine or organization policy rather than your own setting, so it is left where it is — a requirement " +
				"copied into your settings would outlive the policy that imposed it",
			containsSecret: false,
		});
	}

	// ── mcp_servers ──────────────────────────────────────────────────────────
	const servers = raw.config.mcp_servers;
	if (isRecord(servers)) {
		for (const [name, value] of Object.entries(servers)) {
			const label = `${from} → mcp_servers.${name}`;
			if (!isRecord(value)) continue;
			if (value.enabled === false) {
				items.push({
					source: "grok-build",
					from: label,
					to: "—",
					action: "skip",
					detail: "disabled in grok — there is no way to keep a server defined and switched off here",
					containsSecret: false,
				});
				continue;
			}
			const normalized = normalizeGrokMcp(value);
			if (normalized === null || !McpServerConfigSchema.safeParse(normalized.config).success) {
				items.push({
					source: "grok-build",
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
					source: "grok-build",
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
				source: "grok-build",
				from: label,
				to: `.mcp.json → mcpServers.${name}`,
				action: normalized.downgrades.length > 0 ? "downgrade" : "map",
				detail: normalized.downgrades.length > 0 ? `${copied} — ${normalized.downgrades.join("; ")}` : copied,
				containsSecret: secret,
			});
		}
	}
	if (raw.config.disabled_mcp_servers !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → disabled_mcp_servers`,
			to: "—",
			action: "skip",
			detail:
				"servers grok knows about but does not start; there is no way to keep one defined and switched off " +
				"here, so importing it would start it",
			containsSecret: false,
		});
	}
	if (raw.config.disabled_mcp_tools !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → disabled_mcp_tools`,
			to: "—",
			action: "skip",
			detail: "tools hidden from the model on a server here are approved per project rather than listed in a file",
			containsSecret: false,
		});
	}

	// ── skills and paths ─────────────────────────────────────────────────────
	const skills = isRecord(raw.config.skills) ? raw.config.skills : {};
	if (raw.skillPaths.length > 0) {
		items.push({
			source: "grok-build",
			from: `${from} → skills.paths`,
			to: "—",
			action: "skip",
			detail: `${raw.skillPaths.length} extra skill directory/directories — read by this importer, and the skills under them are listed with the rest`,
			containsSecret: false,
		});
	}
	if (raw.serverSkillDirCount > 0 || raw.bundledSkillDirCount > 0) {
		items.push({
			source: "grok-build",
			from: `${from} → skills.server_skill_dirs, skills.bundled_skill_dirs`,
			to: "—",
			action: "skip",
			detail:
				`${raw.serverSkillDirCount + raw.bundledSkillDirCount} directory/directories the launcher and the ` +
				"release itself inject — counted, never walked, because they are not yours to carry",
			containsSecret: false,
		});
	}
	const paths = isRecord(raw.config.paths) ? raw.config.paths : {};
	if (paths.extra_skill_dirs !== undefined || paths.extra_rule_dirs !== undefined) {
		const named = [...grokStringList(paths.extra_skill_dirs), ...grokStringList(paths.extra_rule_dirs)];
		items.push({
			source: "grok-build",
			from: `${from} → paths.extra_skill_dirs, paths.extra_rule_dirs`,
			to: "—",
			action: "skip",
			detail:
				`${named.length} director${named.length === 1 ? "y" : "ies"} the Claude importer inside grok wrote, which ` +
				"point at ~/.claude and ~/.agents — other sources' trees, already covered by the claude-code and agents " +
				"sources; importing them here too would land a second copy of every skill",
			containsSecret: false,
		});
	}
	if (isRecord(raw.config.compat) || raw.vendorTrees.length > 0) {
		items.push({
			source: "grok-build",
			from: `${from} → compat`,
			to: "—",
			action: "skip",
			detail:
				`grok's compatibility scanning (its toggles here, and the trees it found: ${summarizeNames(raw.vendorTrees)}); ` +
				"those belong to the tools that own them, and grok's own claude_import_state shows it has already read them once",
			containsSecret: false,
		});
	}
	const plugins = isRecord(raw.config.plugins) ? raw.config.plugins : {};
	if (skills.disabled !== undefined || skills.ignore !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → skills.disabled, skills.ignore`,
			to: "—",
			action: "skip",
			detail: "applied — the skills these switch off are listed with the skills, each with the key that removed it",
			containsSecret: false,
		});
	}
	for (const [key, detail] of [
		[
			"disabled",
			"entries are plugin ids of the form `<scope>/<hash>/<name>`, and this importer cannot recompute the hash " +
				"from a directory — so a plugin you had switched off there is still read and imported as your own files",
		],
		[
			"enabled",
			"the same id form, naming project-scope plugins that default off; the plugin roots read here are the two " +
				"under $GROK_HOME",
		],
		[
			"paths",
			"extra plugin directories, which this importer does not walk: only the two roots under $GROK_HOME are read",
		],
	] as Array<[string, string]>) {
		if (plugins[key] === undefined) continue;
		items.push({
			source: "grok-build",
			from: `${from} → plugins.${key}`,
			to: "—",
			action: "skip",
			detail,
			containsSecret: false,
		});
	}

	// ── the sections with no landing place, then whatever is left ────────────
	for (const [key, reason] of GROK_UNMIGRATED_SECTIONS) {
		if (raw.config[key] === undefined) continue;
		items.push({
			source: "grok-build",
			from: `${from} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	reportUnhandledKeys("grok-build", raw.config, GROK_CONFIG_HANDLED, from, items);
}

/**
 * The asset face of `$GROK_HOME`: the files the user wrote, then the things this
 * importer walks past and names.
 *
 * Not {@link planAssetTrees}, for the reason that helper's own doc gives in
 * reverse: it renders the memory label from `SOURCE_ROOTS[source]`, which is a
 * guess at a directory *under home* — and `$GROK_HOME` can be anywhere. Every
 * path here is built from the resolved root, so a label always names a file the
 * reader actually opened. {@link planDeepSeekAssets} was split off for the same
 * reason.
 *
 * The second half matters as much as the first. A tree the importer walked past
 * without a word reads as an oversight, and the user's next move is to look for
 * it in the target and conclude the migration was broken — so every tree that
 * holds something and has no landing place here gets a line, and the two
 * credential files get one each that says outright that they were not opened.
 */
function planGrokAssets(
	raw: RawGrokBuild,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	/** A path under the resolved root, rendered the way the report renders paths. */
	const at = (name: string): string => tildePath(home, join(raw.root, name));

	collectFileWrites(
		"grok-build",
		[...raw.skills, ...raw.pluginSkills],
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	if (raw.skillSkips.length > 0) {
		// The config section gets its own line in `planGrokBuild` saying the switches
		// were applied; this is the half that says *which* skills they removed, which
		// is what a user who forgot about them needs.
		items.push({
			source: "grok-build",
			from: `${at("skills")} → skills.disabled, skills.ignore`,
			to: "—",
			action: "skip",
			detail: `${raw.skillSkips.length} skill(s) grok itself does not load — ${summarizeNames(
				raw.skillSkips.map((skip) => `${skip.name} (${skip.reason})`),
			)}`,
			containsSecret: false,
		});
	}
	// Original file names, as `planClaudeCode` does: a rule is a document the user
	// named, and `grok-` prefixes would put it in a different sort order than where
	// they left it.
	collectFileWrites(
		"grok-build",
		raw.rules,
		(name) => join(home, ".labunbun", "rules", name),
		"rule",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		"grok-build",
		[...raw.agents, ...raw.pluginAgents],
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	planCommands(
		"grok-build",
		raw.commands,
		raw.pluginCount > 0 ? `${at("commands")} (and each plugin's commands/)` : at("commands"),
		home,
		force,
		items,
		writes,
	);

	// ── memory ───────────────────────────────────────────────────────────────
	// Every spelling of the instruction file is read and joined into one document
	// (`GROK_INSTRUCTION_FILES`), so the label names one and says so rather than
	// claiming the others are not there.
	if (raw.memory?.trim()) {
		planMemoryAsRule(
			"grok-build",
			`${at("AGENTS.md")} (grok reads Agents.md and AGENT.md too, and joins whichever exist)`,
			home,
			raw.memory,
			"imported-grok-build.md",
			force,
			items,
			writes,
		);
	}
	/** The global memory document in force, as a path under the root. */
	const globalMemoryPath =
		raw.globalMemorySource.generation === "v2" ? join("memory-v2", "global", "MEMORY.md") : join("memory", "MEMORY.md");
	if (raw.globalMemory?.trim()) {
		planMemoryAsRule(
			"grok-build",
			at(globalMemoryPath),
			home,
			raw.globalMemory,
			"imported-grok-build-memory.md",
			force,
			items,
			writes,
		);
	}
	// The document in the other tree is named: grok's two memory generations are
	// isolated, so exactly one is in force and a user with both is about to keep
	// one of them. Which one is decided by grok's own switch, and that decision is
	// what the line states — an importer that read the wrong tree silently is how
	// this branch came to exist.
	if (raw.globalMemorySource.other !== null) {
		const v2Selected = raw.globalMemorySource.generation === "v2";
		items.push({
			source: "grok-build",
			from: at(v2Selected ? join("memory", "MEMORY.md") : join("memory-v2", "global", "MEMORY.md")),
			to: "—",
			action: "skip",
			detail: v2Selected
				? "a document under the legacy memory root, which grok stopped reading when [memory_v2] enabled was set — v2 " +
					"runs in its own tree and cannot see the legacy one, so this is not the global memory in force there"
				: "a document under memory-v2, which grok reads only when [memory_v2] enabled is true — that switch is not set " +
					"in this config.toml, so the legacy memory tree is the one in force; a v2 enablement arriving from the " +
					"server, which this importer cannot read, would make this the live document instead",
			containsSecret: false,
		});
	}
	if (raw.memoryWorkspaceCount > 0) {
		// A rule file is loaded in every workspace, and these documents are keyed to
		// the repository grok saw them in. Importing one would not move a note, it
		// would widen its scope — which is a decision for the user, not for this
		// importer.
		items.push({
			source: "grok-build",
			from: `${at("memory")} (and memory-v2/, excluding the global document)`,
			to: "—",
			action: "skip",
			detail:
				`${raw.memoryWorkspaceCount} workspace-scoped memory document(s) — each is keyed to one repository, and a rule ` +
				"file here is loaded in every workspace, so carrying one would turn one project's notes into a global instruction",
			containsSecret: false,
		});
	}

	// ── plugins: what came out of them, and what did not ─────────────────────
	if (raw.pluginCount > 0) {
		items.push({
			source: "grok-build",
			from: `${at(GROK_PLUGIN_DIR)}, ${at(GROK_INSTALL_DIR)} (or [plugins].install_dir)`,
			to: "—",
			action: "skip",
			detail:
				`${raw.pluginCount} plugin(s) — grok enables one as a unit and this build has no such unit, so the skills, ` +
				"commands and agents above are now plain files of yours that load whenever skills do; each line names the " +
				"plugin it came from",
			containsSecret: false,
		});
	}
	if (raw.pluginMcpCount > 0 || raw.pluginHookCount > 0) {
		items.push({
			source: "grok-build",
			from: `${at(GROK_PLUGIN_DIR)}/*/{${GROK_PLUGIN_MCP}, hooks/hooks.json}`,
			to: "—",
			action: "skip",
			detail:
				`${raw.pluginMcpCount} plugin MCP declaration(s) and ${raw.pluginHookCount} hook file(s) — counted, never read: ` +
				"they change what a session does rather than what it knows, and a third-party plugin's hooks should not enter " +
				"your configuration without your having seen them",
			containsSecret: false,
		});
	}

	// ── trees grok keeps that are not the user's writing ─────────────────────
	if (raw.bundledPresent || raw.marketplaceCachePresent) {
		const named = [
			raw.bundledPresent ? at("bundled") : null,
			raw.marketplaceCachePresent ? at("marketplace-cache") : null,
		];
		items.push({
			source: "grok-build",
			from: named.filter((name): name is string => name !== null).join(", "),
			to: "—",
			action: "skip",
			detail: "grok's own shipped content and its download cache — neither is yours to carry, so both are named only",
			containsSecret: false,
		});
	}
	if (raw.lspPresent) {
		items.push({
			source: "grok-build",
			from: at("lsp.json"),
			to: "—",
			action: "skip",
			detail: "the language servers grok starts — named only; nothing here registers a server for this build",
			containsSecret: false,
		});
	}
	if (raw.pagerPresent) {
		items.push({
			source: "grok-build",
			from: at("pager.toml"),
			to: "—",
			action: "skip",
			detail: "preferences for grok's own screen — named only; this build's interface is not configured from a file",
			containsSecret: false,
		});
	}
	if (raw.claudeImportStatePresent) {
		items.push({
			source: "grok-build",
			from: at("claude_import_state.json"),
			to: "—",
			action: "skip",
			detail:
				"grok's own record of a completed ~/.claude import — read for its existence alone, and it is the plainest " +
				"evidence that those trees have been carried across once already, which is why this importer leaves them to " +
				"the claude-code and agents sources",
			containsSecret: false,
		});
	}

	// ── what is left under the home ──────────────────────────────────────────
	if (raw.unimported.length > 0) {
		items.push({
			source: "grok-build",
			from: raw.unimported.map((entry) => `${at(entry.name)} (${entry.count})`).join(", "),
			to: "—",
			action: "skip",
			detail:
				"trees grok reads that have no counterpart here — its own prompt machinery, memory its agents wrote, and the " +
				"scripts it runs around a session — counted so their absence from this report reads as a decision",
			containsSecret: false,
		});
	}
	if (raw.runtimePresent.length > 0) {
		items.push({
			source: "grok-build",
			from: raw.runtimePresent.map((name) => at(name)).join(", "),
			to: "—",
			action: "skip",
			detail: "not configuration at all: logs, caches, downloads and machine state grok writes as it runs",
			containsSecret: false,
		});
	}
	// The two credential files, each by name. `existsSync` is the only thing either
	// one is ever subjected to, and these two lines are the whole of what the report
	// may say about them — no size, no mtime, no content.
	if (raw.authPresent) {
		items.push({
			source: "grok-build",
			from: at("auth.json"),
			to: "—",
			action: "skip",
			detail: "the account's tokens — named, never opened",
			containsSecret: false,
		});
	}
	if (raw.mcpCredentialsPresent) {
		items.push({
			source: "grok-build",
			from: at("mcp_credentials.json"),
			to: "—",
			action: "skip",
			detail: "MCP OAuth tokens — named, never opened",
			containsSecret: false,
		});
	}
	// A repository's own `.grok/` is deliberately outside this planner's reach.
	// Saying so is the point: the tree looks like this source's, so a user who does
	// not find it mentioned will read the silence as a bug. The permission rules in
	// its `config.toml` are the part most worth naming, since they are the one
	// thing in there that would be dangerous to move even if it could be read.
	items.push({
		source: "grok-build",
		from: "each repository's own .grok/ (.grok/skills, .grok/agents, .grok/rules, .grok/plugins)",
		to: "—",
		action: "skip",
		detail:
			"a repository's grok configuration — including the [permission] rules its .grok/config.toml carries, which grok " +
			"applies only once the repository is trusted — lives with the repository rather than under $GROK_HOME, so this " +
			"importer neither reads nor moves it",
		containsSecret: false,
	});
}

/**
 * `[ui] permission_mode`, and the two keys that spell the same decision.
 *
 * The mapping is short because grok's own is: `parse_permission_mode_canonical`
 * knows `always-approve`, `auto` and `ask`, treats `default` as a spelling of ask
 * and sends **everything else** there too. So a user who wrote
 * `permission_mode = "plan"` in `[ui]`, expecting the Claude Code vocabulary, has
 * been running with a mode that never auto-approves — and carrying the *name*
 * they wrote across would hand them a mode grok never applied. This planner
 * imports the mode grok resolved and names the string it resolved it from, which
 * is the only reading that cannot be a lie in either direction.
 *
 * Two details of `permission_mode_from_ui_if_set` are load-bearing. The
 * precedence is **type-gated**: `permission_mode` counts only as a string,
 * `approval_mode` only as a string, `yolo` only as `true`, so a key present in a
 * shape grok does not read falls through to the next instead of deciding. And
 * the presence of *any* of the three pins the answer — an explicit
 * `yolo = false` resolves to ask rather than to "unset", so an account default
 * cannot win — which is why a reading of ask is claimed as an explicit
 * `default` here rather than left out as if nothing had been said.
 */
function planGrokPermissionMode(
	raw: RawGrokBuild,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
): void {
	const ui = isRecord(raw.config.ui) ? raw.config.ui : {};
	const from = `${grokConfigPath(home, raw.root)} → ui`;
	const keys = ["permission_mode", "approval_mode", "yolo"] as const;
	const present = keys.filter((key) => ui[key] !== undefined);
	if (present.length === 0) return;

	/** What one key resolves to on its own, or `undefined` when grok would not read it. */
	const resolveKey = (name: (typeof keys)[number]): "always-approve" | "auto" | "ask" | undefined => {
		const value = ui[name];
		if (value === undefined) return undefined;
		if (name === "yolo") return value === true ? "always-approve" : undefined;
		if (typeof value !== "string") return undefined;
		if (name === "approval_mode") return value === "always-approve" ? "always-approve" : "ask";
		return value === "always-approve" ? "always-approve" : value === "auto" ? "auto" : "ask";
	};
	// grok's precedence, applied to the keys it actually reads. With none of them
	// readable the earlier presence check has still pinned the mode, to ask.
	const readable = keys
		.map((name) => [name, resolveKey(name)] as const)
		.filter(
			(entry): entry is readonly [(typeof keys)[number], "always-approve" | "auto" | "ask"] => entry[1] !== undefined,
		);
	const decidedBy = readable[0]?.[0] ?? present[0];
	const reads = readable[0]?.[1] ?? "ask";
	const written = typeof ui[decidedBy] === "string" ? ui[decidedBy] : undefined;
	const label =
		readable.length > 0 ? `${from}.${decidedBy} (${JSON.stringify(ui[decidedBy])})` : `${from}.${present.join(", ")}`;

	const mode = reads === "always-approve" ? "bypassPermissions" : reads === "ask" ? "default" : undefined;
	if (mode !== undefined) {
		// A name grok does not know is the case worth spelling out: the file says
		// one thing and the session did another, and the user is the only one who
		// can say which of the two they want from here on.
		const surprising = written !== undefined && !GROK_PERMISSION_MODE_NAMES.has(written);
		claimScalar(
			"grok-build",
			"permissionMode",
			mode,
			label,
			surprising
				? `mapped to "${mode}" — grok resolves "${written}" to "${reads}", so the name written there is not the mode it ran`
				: `mapped to "${mode}"`,
		);
	} else {
		items.push({
			source: "grok-build",
			from: label,
			to: "—",
			action: "skip",
			detail:
				'"auto" is a classifier that approves the calls it judges safe, and the nearest mode here, dontAsk, ' +
				"does the opposite — anything not explicitly allowed is denied — so the session keeps whatever mode " +
				"it would otherwise start in",
			containsSecret: false,
		});
	}

	// The other spellings grok reads past. Named only when one of them would have
	// decided differently: a second key saying the same thing is not worth a line.
	for (const name of present) {
		if (name === decidedBy) continue;
		const own = resolveKey(name);
		if (own !== undefined && own === reads) continue;
		items.push({
			source: "grok-build",
			from: `${from}.${name} (${JSON.stringify(ui[name])})`,
			to: "—",
			action: "skip",
			detail:
				own !== undefined
					? `grok reads "${decidedBy}" first and stops there, so this spelling of the same decision is not in force; on its own it would have meant "${own}"`
					: `grok reads this key only as ${name === "yolo" ? "the boolean true" : "a string"}, so a value in this shape falls through to the next key rather than deciding`,
			containsSecret: false,
		});
	}
}

/** The mode names grok's `[ui] permission_mode` recognises, `default` as an alias of ask included. */
const GROK_PERMISSION_MODE_NAMES = new Set(["always-approve", "auto", "ask", "default"]);

/**
 * Keys of grok's `config.toml` that are either imported above or named by a line
 * of their own. Anything else reaches the report through {@link reportUnhandledKeys},
 * so a key the user set is never simply missing from it.
 */
const GROK_CONFIG_HANDLED = new Set<string>([
	"model",
	"models",
	"model_providers",
	"permission",
	"mcp_servers",
	"disabled_mcp_servers",
	"disabled_mcp_tools",
	"skills",
	"paths",
	"compat",
	"plugins",
	"ui",
	...GROK_UNMIGRATED_SECTIONS.map(([key]) => key),
]);

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
	settingsPatch: Record<string, unknown>,
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
	settingsPatch.hooks = normalized.config;
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
	items.push({
		source: "kimi-code",
		from,
		to: "settings.json → hooks",
		action: losses.length > 0 ? "downgrade" : "map",
		detail:
			`${entries} hook entr(ies) across ${events.length} event(s)` +
			(timeouts.length > 0 ? `; ${timeouts.join("; ")}` : "") +
			split +
			(losses.length > 0 ? `; left behind: ${losses.join("; ")}` : ""),
		containsSecret: false,
	});
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
function planKimiCode(
	raw: RawKimiCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
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
	planKimiHooks(raw, home, items, settingsPatch, existing, force);

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
function planKimiAssets(
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

/**
 * The top-level keys of MiniMax's `config.yaml` that this run does not import,
 * each with the reason it does not.
 *
 * The list is the whole interface — every key `Config` declares
 * (`config.ts:928-1030`) minus the six that are planned above and the eleven
 * computed paths below — so a key that is *not* here and not planned shows up in
 * the unhandled-key sweep at the end instead of vanishing. MiniMax's own file is
 * allowed to be a partial table, and this build's reader keeps the raw parse, so
 * the sweep sees keys this list has never heard of.
 *
 * Some of these are feature switches the user genuinely set. They are still not
 * imported, because what they switch on has no counterpart here — and saying
 * which is the point: "your `skillEvolve` setting is not here" is information,
 * while silence would read as "you never set one".
 */
const MINIMAX_UNMIGRATED_SECTIONS: Array<[key: string, reason: string]> = [
	["logLevel", "MiniMax's own log verbosity, and this build has no setting for it"],
	["devPort", "the port MiniMax's web/desktop shell listens on — there is no such shell here"],
	[
		"sseErrorPush",
		"whether MiniMax pushes a stream error into its UI history and its event stream — a display decision of its own shell",
	],
	["notifications", "desktop notifications for MiniMax's own shell"],
	[
		"beta",
		"MiniMax's build-variant feature flags, resolved per build rather than set by you — not a preference that travels",
	],
	[
		"agents",
		"per-agent capability overrides for the agents MiniMax defines itself (which tools, built-in skills and features each may use) — there are no per-agent settings here; the agents themselves come across as files",
	],
	[
		"memory",
		"MiniMax's own memory feature switch (whether it keeps long-term notes, and whether it digests them daily) — nothing here reads that layout, and the notes themselves are named separately",
	],
	[
		"skillEvolve",
		"MiniMax's skill self-improvement loop: a background pass that rewrites your skills from signals it collects — a feature of that runtime",
	],
	[
		"sessionRotate",
		"when MiniMax starts a fresh session instead of continuing an old one — how long a session lives is yours to decide here",
	],
	["agentStop", "the debounce and maximum span of MiniMax's stop detector"],
	["asr", "cloud speech-to-text — there is no voice input here"],
	[
		"skills",
		"MiniMax's unified skill-ingestion switches: whether it scans *other tools'* skill trees (`~/.claude`, `~/.codex`, `~/.agents`), how far up a project it walks to find them, and which source wins a name collision — those trees belong to the sources this migrator already has",
	],
	[
		"askUser",
		"MiniMax's switch for its own interactive-question feature — the equivalent here is a tool, and it exists regardless",
	],
	["sessionTitle", "whether MiniMax has a model title your sessions — no titles are generated here"],
	["cli", "whether MiniMax lets an agent spawn its own CLI — a capability of that runtime"],
	["browser", "MiniMax's bundled browser automation — there is no browser tool here"],
	[
		"tui",
		"MiniMax's terminal UI preferences (its status line, tips, notification method) — this build's own UI has its own",
	],
	["telemetry", "usage metrics and diagnostics, off by default — this build has no such switch"],
	[
		"opencode",
		"MiniMax's OpenCode adapter: a data-isolation mode and process keep-alive tuning for a tool it can host",
	],
	[
		"contextManagement",
		"which models skip its system reminder, and how many screenshots its computer-use backend may hold — both count things this build does not have",
	],
	["runawayGuard", "MiniMax's guard against a runaway loop — this build has its own"],
	["agentRuntime", "which agent framework MiniMax runs sessions on — not a preference that transfers"],
	["logRetentionDays", "how long MiniMax keeps its logs, which are not imported either"],
	["cuBackend", "MiniMax's computer-use backend selection — there is no computer use here"],
	["review", "whether MiniMax's code reviewer runs inline or as a subagent — there is no reviewer here"],
	["promptConfig", "whether MiniMax updates its own system prompt automatically"],
	[
		"goal",
		"MiniMax's goal mode: a standing objective it carries across turns with its own evaluator, budget and breaker — nothing here reads that state, and the documents it keeps are named separately",
	],
	[
		"sandbox",
		"MiniMax's sandbox posture (what a command may reach, what is mounted) — a property of that runtime; the equivalent decisions here are permission rules, and those are imported from `permission.json`",
	],
	[
		"goalWarnings",
		"what MiniMax's own parser wrote back about the goal block — an output of the file rather than a key you set",
	],
	["minimaxModelSource", "which of MiniMax's model sources to bill — an account route, not a model choice"],
	["defaultModelVariant", "a variant of the default model — this build has no variant dimension"],
	[
		"defaultModelThinking",
		"the thinking depth MiniMax applies to the default model — thinking is set here when a model is asked for, not in settings",
	],
	[
		"defaultModelContextWindow",
		"a context-window override for the default model — the window comes from the model table here",
	],
	["defaultLightModel", "the model MiniMax uses for cheap background work — this build picks one per call"],
	["minimaxModelContextLimits", "per-model context-window overrides for MiniMax's own catalogue"],
	["nexus", "MiniMax's hub connection: a remote endpoint and the model to use with it"],
	["contentReview", "a content-review endpoint MiniMax can route prompts through"],
	["mcpToolSearch", "how MiniMax narrows a large MCP tool list before the model sees it"],
	[
		"permission",
		"runtime knobs for MiniMax's permission engine — who owns the policy, how long its classifier may take, whether it prompts you. These are not rules: the rules live in `permission.json` and are imported from there",
	],
];

/**
 * Keys MiniMax *computes* and overwrites on every read
 * (`config.ts:2073-2083`, where each is `join(dataDir, …)`).
 *
 * A value for one of these in the file is ignored on that side too, which is why
 * they are answered together rather than given a reason each: eleven copies of
 * "MiniMax recomputes this" would drown the sections that carry a decision.
 * `dataDir` itself is the root the others hang off, and it comes from
 * `$MINIMAX_DATA_DIR` rather than from the file.
 */
const MINIMAX_COMPUTED_PATHS: string[] = [
	"dataDir",
	"agentsDir",
	"sessionsDir",
	"memoryDir",
	"skillsDir",
	"builtinSkillsDir",
	"logsDir",
	"pluginsDir",
	"plansDir",
	"harnessesDir",
	"subAgentsDir",
];

/**
 * MiniMax's permission mode names, and what each one means over there.
 *
 * The two mode sets were designed against the same four meanings, so this is
 * nearly one-to-one — but two of MiniMax's six values are not imported, and
 * neither is the one a reader would guess:
 *
 *   - `off` is a second spelling of `bypassPermissions` in MiniMax's own code
 *     rather than a third posture: `modeToAskPolicy` sends both to "always
 *     allow" (`ask-policy.ts:22-36`, where the comment reads "PermissionMode
 *     'bypassPermissions' / 'off'"), and the facade rewrites `off` into
 *     `bypassPermissions` before its engine sees the mode (`facade.ts:563-566`).
 *     It travels as the name this build has for it;
 *   - `auto` stays behind: it is a classifier that approves what it judges safe,
 *     and the nearest mode here — `dontAsk` — means the opposite;
 *   - `acceptEdits` travels, with a note, because MiniMax's own readers disagree
 *     about it. The runtime's reader accepts it (`readLocalPermissionMode`,
 *     `local-runtime/src/api/host-helpers.ts:545-554`) and so does the writer
 *     that persists this key (`LOCAL_PERMISSION_MODES`, `config/update.ts:42-48`),
 *     while the reader the bundled config goes through does not list it at all
 *     and falls back to `auto` (`config.ts:2053-2059`). Its documented meaning
 *     there — "default plus pre-seeded edit/write allow rules" (`ask-policy.ts:44-45`)
 *     — is this build's mode of the same name, so the value is carried as
 *     written and the split is named in the report rather than guessed away;
 *   - `dontAsk` is *not* imported. It is a live session mode in MiniMax, reached
 *     through `setMode` and listed by the permission-scope store
 *     (`plugin-hook-permission-state.ts:76-84,232`), and no reader of *this file*
 *     accepts it anywhere, so a `config.yaml` carrying it runs as `auto` over
 *     there. Writing it here would set a posture the source never had — the same
 *     line the rules below draw for a store MiniMax itself refuses to read.
 */
const MINIMAX_PERMISSION_MODES: Record<string, string> = {
	default: "default",
	bypassPermissions: "bypassPermissions",
	off: "bypassPermissions",
	acceptEdits: "acceptEdits",
};

/** `config.yaml → permissionMode`. */
function planMinimaxPermissionMode(
	raw: RawMinimaxCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
): void {
	const from = `${tildePath(home, minimaxConfigPath(raw.root))} → permissionMode`;
	const mode = typeof raw.config.permissionMode === "string" ? raw.config.permissionMode.trim() : "";
	if (mode === "") return;
	const mapped = MINIMAX_PERMISSION_MODES[mode];
	if (mapped !== undefined) {
		const detail =
			mode === "off"
				? 'mapped to "bypassPermissions", which is what MiniMax itself calls it — its ask policy sends both spellings to "always allow"'
				: mode === "acceptEdits"
					? 'mapped to "acceptEdits"; MiniMax\'s runtime reader accepts this value where the reader its bundled config goes through would run the session as "auto"'
					: `mapped to "${mapped}"`;
		claimScalar("minimax-code", "permissionMode", mapped, `${from} ("${mode}")`, detail);
		return;
	}
	if (mode === "auto") {
		items.push({
			source: "minimax-code",
			from: `${from} ("auto")`,
			to: "—",
			action: "skip",
			detail:
				'"auto" is a classifier that approves the calls it judges safe, and the nearest mode here, dontAsk, does the ' +
				"opposite — anything not explicitly allowed is denied — so the session keeps whatever mode it would otherwise start in",
			containsSecret: false,
		});
		return;
	}
	if (mode === "dontAsk") {
		items.push({
			source: "minimax-code",
			from: `${from} ("dontAsk")`,
			to: "—",
			action: "skip",
			detail:
				"MiniMax has this mode, but none of the readers that open this file accept it — a config.yaml carrying it runs as " +
				'"auto" there, so writing it here would put a stricter posture in force than the one you actually had',
			containsSecret: false,
		});
		return;
	}
	items.push({
		source: "minimax-code",
		from: `${from} ("${mode}")`,
		to: "—",
		action: "skip",
		detail: "not a mode MiniMax reads, so it never decided a session — the permission mode is left as it is",
		containsSecret: false,
	});
}

/**
 * `permission.json`, as rules this build's engine will consult.
 *
 * Nothing is taken out of a file MiniMax refuses — {@link readMinimaxPermissions}
 * has already answered that question, and a refusal here is a report line rather
 * than an empty rule list.
 *
 * The caveat is the one every source with a command grammar needs, and the
 * `:*` rewrites are the part of it that cannot be expressed as a caveat: see
 * {@link MinimaxPermissions.widened}.
 */
function planMinimaxPermissions(
	raw: RawMinimaxCode,
	home: string,
	items: MigrationItem[],
	addPermissionRules: AddPermissionRules,
): void {
	const from = tildePath(home, minimaxPermissionFile(raw.root));
	if (raw.permissionError !== undefined) {
		items.push({
			source: "minimax-code",
			from,
			to: "—",
			action: "skip",
			detail: `${raw.permissionError}`,
			containsSecret: false,
		});
		return;
	}
	const { allow, deny, askCount, version, notCarried, widened } = raw.permissions;
	const caveat =
		`permission.json v${version}: a command pattern matches a word-boundary prefix in MiniMax and is refused there for any ` +
		"command that chains (`;`, `&&`, `|`, a substitution), where this build matches the whole command line as a glob — so a " +
		"chained command counts as a match here";
	if (allow.length > 0) addPermissionRules("minimax-code", "allow", allow, `${from} → allow`, caveat);
	if (deny.length > 0) addPermissionRules("minimax-code", "deny", deny, `${from} → deny`, caveat);
	if (askCount > 0) {
		items.push({
			source: "minimax-code",
			from: `${from} → ask`,
			to: "—",
			action: "skip",
			detail: `${askCount} rule(s) that ask rather than decide; this build's settings hold allow and deny only, and a rule turned into an allow would decide what you asked to be asked about`,
			containsSecret: false,
		});
	}
	if (widened.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${from} → ${summarizeNames(widened, 6)}`,
			to: "settings.json → permissions",
			action: "downgrade",
			detail:
				`${widened.length} command rule(s) ended in ":*", MiniMax's "this command or its arguments" suffix. Written as-is ` +
				"they would match the literal text `:*` here and decide nothing, so they are written as a `*` glob instead: that also " +
				"matches a longer first word (`sed*` covers `sedx`) and a command that chains commands",
			containsSecret: false,
		});
	}
	if (notCarried.length > 0) {
		for (const reason of ["inert-there", "no-specifier-grammar"] as const) {
			const group = notCarried.filter((drop) => drop.reason === reason);
			if (group.length === 0) continue;
			items.push({
				source: "minimax-code",
				from: `${from} → ${summarizeNames(
					group.map((drop) => `${drop.rule} (${drop.behavior})`),
					6,
				)}`,
				to: "—",
				action: "skip",
				detail:
					reason === "inert-there"
						? `${group.length} rule(s) naming a tool MiniMax does not have, so they decide nothing there either`
						: `${group.length} rule(s) whose pattern only MiniMax's own engine reads: this build consults a specifier for ` +
							"a command, a file path and the MCP family, so a pattern on any other tool would sit in the file unread",
				containsSecret: false,
			});
		}
	}
}

/**
 * Model entries for one provider, from MiniMax's own model table.
 *
 * Both limits come from the model's own entry where it states them
 * (`ModelConfig.limit`, `config.ts:1053-1057`: `{context, input?, output}`).
 * Where it states none, MiniMax's own fallback for a user-created provider is
 * used rather than one of this importer's — 200k context and 16 384 output
 * tokens (`BYOK_FALLBACK_MODEL_LIMITS`,
 * `local-runtime/src/runtime/model-resolver-byok.ts:27-30`), and the schema here
 * requires an output limit, so "assume nothing" is not an option a report can
 * offer.
 *
 * Prices are not carried, and the reason is not that the key is missing: it is
 * that MiniMax's own runtime never reads it. Its cost reporting comes from the
 * provider's usage payload (`usage.cost.total`, `usage/api.ts:250-252`); the
 * `cost` block a model may carry in `config.yaml` prices nothing over there, so
 * there is no scale to carry it at.
 */
function minimaxModelEntries(models: unknown): {
	entries: Array<Record<string, unknown>>;
	disabled: string[];
	priced: string[];
} {
	const entries: Array<Record<string, unknown>> = [];
	const disabled: string[] = [];
	const priced: string[] = [];
	if (!isRecord(models)) return { entries, disabled, priced };
	for (const [id, spec] of Object.entries(models)) {
		if (!isRecord(spec)) continue;
		if (spec.enabled === false) {
			disabled.push(id);
			continue;
		}
		if (isRecord(spec.cost)) priced.push(id);
		const limit = isRecord(spec.limit) ? spec.limit : {};
		const context = typeof limit.context === "number" && limit.context > 0 ? Math.floor(limit.context) : 200_000;
		const output = typeof limit.output === "number" && limit.output > 0 ? Math.floor(limit.output) : 16_384;
		entries.push({
			id,
			...(typeof spec.name === "string" && spec.name.trim() !== "" ? { name: spec.name.trim() } : {}),
			contextWindow: context,
			maxOutputTokens: output,
			...(spec.reasoning === true ? { reasoning: true } : {}),
		});
	}
	return { entries, disabled, priced };
}

/**
 * `custom_provider.<key>` as `providers.openaiCompatible` entries.
 *
 * Only the user's own tree is imported, and the distinction is the reason.
 * `provider.*` is seeded by MiniMax's installer from a preset — endpoint plus
 * the vendor's model catalogue (`config.ts:1677-1706`) — and what makes it work
 * is the account's route to MiniMax's own service, which this build has no
 * equivalent of; importing it would register an endpoint the user never typed.
 * A custom provider is a table the user created in MiniMax's settings, which is
 * exactly the thing that has to move.
 *
 * No key value is read. MiniMax names the variables a provider's key may come
 * from in `env[]`, and that list is what is carried; when it names none, the
 * variable this build would read is derived from the provider key and spelled
 * out in the report so the user knows what to export.
 */
function planMinimaxProviders(
	raw: RawMinimaxCode,
	from: string,
	newIds: Map<string, string>,
	existing: RawSettingsInput,
	force: boolean,
): { specs: Array<Record<string, unknown>>; items: MigrationItem[] } {
	const items: MigrationItem[] = [];
	const specs: Array<Record<string, unknown>> = [];
	// The id a source provider lands under is derived, so a collision with a
	// provider the user already has is possible and has to be decided *here*
	// rather than left to the merge: a default model that names this provider is
	// rewritten to the derived id, and rewriting it to an id that was never
	// registered would leave settings.json pointing at whatever was already there
	// — a different endpoint answering under the same name.
	const existingIds = new Set(
		((existing.providers?.openaiCompatible ?? []) as Array<{ id?: string }>).map((provider) => provider.id),
	);
	const custom = isRecord(raw.config.custom_provider) ? raw.config.custom_provider : {};
	for (const [key, value] of Object.entries(custom)) {
		const label = `${from} → custom_provider.${key}`;
		if (!isRecord(value)) continue;
		if (value.enabled === false) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "disabled in MiniMax — enable it there first if you want it here",
				containsSecret: false,
			});
			continue;
		}
		const options = isRecord(value.options) ? value.options : {};
		const baseUrl = typeof options.baseURL === "string" ? options.baseURL.trim() : "";
		if (baseUrl === "") {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "no endpoint in its options, so there is nothing here to point a provider at",
				containsSecret: false,
			});
			continue;
		}
		const id = `minimax-${key}`;
		// `env[]` holds variable *names*, so this is a name to read and not a value
		// to copy. The fallback is this build's convention for a provider whose key
		// has no variable yet, and the report says which one it landed on.
		const named = Array.isArray(value.env)
			? value.env.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
			: [];
		const apiKeyEnv = named.length > 0 ? named[0].trim() : `${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		const models = minimaxModelEntries(value.models);
		const spec = { id, baseUrl, apiKeyEnv, models: models.entries };
		if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "its endpoint is not a usable URL for a provider entry",
				containsSecret: false,
			});
			continue;
		}
		const replacing = existingIds.has(id);
		if (replacing && !force) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: `settings.json already defines a provider with the id this would take (${id}) — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		const extras: string[] = [];
		if (replacing) extras.push(`it replaces the provider already registered as ${id}`);
		if (options.apiKey !== undefined) {
			extras.push("the key stored in its options was not read, so export it under the name below");
		}
		if (named.length === 0) extras.push(`it names no api key variable, so this build reads $${apiKeyEnv}`);
		else if (named.length > 1)
			extras.push(`it names ${named.length} variables and this build reads one, $${apiKeyEnv}`);
		if (isRecord(options.headers) && Object.keys(options.headers).length > 0) {
			extras.push("its header table has no counterpart here, so a gateway that needs one needs it by another route");
		}
		if (models.disabled.length > 0) {
			extras.push(
				`${models.disabled.length} model(s) it disables were left out (${summarizeNames(models.disabled, 4)})`,
			);
		}
		if (models.priced.length > 0) {
			extras.push(
				`${models.priced.length} model(s) declare prices, which are not carried: MiniMax itself prices a call from the ` +
					"provider's usage payload rather than from this block, so there is no scale to copy them at",
			);
		}
		specs.push(spec);
		newIds.set(`custom_provider:${key}`, id);
		items.push({
			source: "minimax-code",
			from: label,
			to: `settings.json → providers.openaiCompatible[${id}] (${models.entries.length} model(s))`,
			action: "map",
			detail: extras.length > 0 ? extras.join("; ") : "its endpoint and model list copied",
			containsSecret: false,
		});
	}
	return { specs, items };
}

/**
 * `mcp.json`'s server shape → this build's.
 *
 * The two are close: the wrapper is the same `{"mcpServers": {…}}`, `stdio`
 * means the same two fields, and `streamable-http` is what this build calls
 * `http`. What does not come across is named per server rather than dropped,
 * because every one of them is a key the user set:
 *
 *   - `auth` holds credentials for a remote server. It is never opened; a server
 *     that authenticates by having one was authorised there and has to be
 *     authorised here again;
 *   - `timeout`, `description`, `metadata` and `tools` are MiniMax's own
 *     bookkeeping for the server, and a `tools` list that narrows what the
 *     server may expose is a real decision this build cannot make;
 *   - `cwd` is not a field MiniMax reads at all, so carrying it would import a
 *     value the source itself ignores.
 */
function normalizeMinimaxMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const type = typeof entry.type === "string" ? entry.type : "";
	const command = typeof entry.command === "string" ? entry.command.trim() : "";
	const url = typeof entry.url === "string" ? entry.url.trim() : "";
	const extras: string[] = [];
	for (const key of ["timeout", "description", "metadata", "tools"]) {
		if (entry[key] !== undefined) extras.push(key);
	}
	if (isRecord(entry.auth) && Object.keys(entry.auth).length > 0) {
		downgrades.push("it authenticates with credentials that are neither read nor carried — authorise it again here");
	}
	const out: Record<string, unknown> =
		type === "stdio" || (type === "" && command !== "") ? { type: "stdio", command } : { type: "http", url };
	if (type === "stdio" || (type === "" && command !== "")) {
		if (command === "") return null;
		out.args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
		if (isRecord(entry.env)) out.env = entry.env;
		if (entry.cwd !== undefined)
			downgrades.push("its `cwd` is not a field MiniMax reads either, so it was not carried");
		if (entry.headers !== undefined) {
			downgrades.push("headers on a stdio server have no meaning here and were not carried");
		}
	} else {
		if (url === "") return null;
		if (type === "sse") {
			downgrades.push("it is an SSE server, and the MCP client here connects over stdio or StreamableHTTP only");
		}
		if (isRecord(entry.headers)) out.headers = entry.headers;
		if (entry.env !== undefined) {
			downgrades.push("an env table on a remote server is not read by MiniMax either, so it was not carried");
		}
	}
	if (extras.length > 0) {
		downgrades.push(`MiniMax's own ${summarizeNames(extras)} setting(s) for it have no counterpart here`);
	}
	const placeholder = placeholderNote(out);
	if (placeholder) downgrades.push(placeholder);
	return { config: out, downgrades };
}

/**
 * `config.yaml`, its MCP file and the permission posture.
 *
 * The order of the sections follows the file, so a reader comparing the report
 * with their own `config.yaml` finds the keys in the same order. The provider
 * table is built before the default model is resolved but reported after it,
 * for the same reason: the default model can point *into* a provider that is
 * being imported, and the id it has to be rewritten to only exists once that
 * provider has been read.
 *
 * `permission.json` is a separate file but not a separate section of the report:
 * the mode from `config.yaml` and the rules from `permission.json` are one
 * posture, and they are read in that order for the same reason MiniMax is — the
 * mode decides what happens to a call no rule covers, so the rules mean nothing
 * until it is known.
 */
function planMinimaxCode(
	raw: RawMinimaxCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
	addPermissionRules: AddPermissionRules,
): void {
	const from = tildePath(home, minimaxConfigPath(raw.root));
	if (raw.configError !== undefined) {
		items.push({
			source: "minimax-code",
			from,
			to: "—",
			action: "skip",
			detail: `${raw.configError} — nothing in this file was read, so this report is missing whatever it held`,
			containsSecret: false,
		});
	}
	const config = raw.config;

	// Providers are read first so a default model naming one can be resolved to
	// the id this build will register. Their report lines are emitted in file
	// order, below the default model.
	const newIds = new Map<string, string>();
	const providers = planMinimaxProviders(raw, from, newIds, existing, force);

	// ── defaultModel ─────────────────────────────────────────────────────────
	if (config.defaultModel !== undefined) {
		const raw_model = typeof config.defaultModel === "string" ? config.defaultModel.trim() : "";
		const label = `${from} → defaultModel (${JSON.stringify(config.defaultModel)})`;
		// MiniMax spells a reference `providerID/modelID` (`parseSourceQualifiedModelKey`,
		// `local-runtime/src/config/model-key.ts:46-55`, splits on the first slash), and
		// for a user-created provider the provider id is the qualified form
		// `custom_provider:<key>` (:38-42). So a reference into a provider being
		// imported has to be rewritten to the id that provider is registered under.
		//
		// The rewritten reference is deliberately *not* run through the model
		// registry: a provider from settings is registered when the app starts
		// (`applyCatalogSettings`), not while this plan is being built, so the
		// registry would answer "no such model" for a reference that is in fact
		// about to resolve. What is checked instead is that the model is one the
		// provider itself lists.
		const slash = raw_model.indexOf("/");
		const providerId = slash > 0 ? raw_model.slice(0, slash) : "";
		const modelId = slash > 0 ? raw_model.slice(slash + 1) : "";
		const renamed = newIds.get(providerId);
		const custom = isRecord(config.custom_provider) ? config.custom_provider : {};
		const registered = renamed === undefined ? undefined : providers.specs.find((spec) => spec.id === renamed);
		if (raw_model === "") {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a model reference",
				containsSecret: false,
			});
		} else if (renamed !== undefined && registered !== undefined && modelId === "") {
			// A trailing slash: MiniMax's own parser refuses the whole key
			// (`slash === raw.length - 1`, `model-key.ts:51`), so no model was in
			// force there either.
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "it names a provider with no model after the slash, which MiniMax's own reader refuses",
				containsSecret: false,
			});
		} else if (renamed !== undefined && registered !== undefined) {
			const known = (registered.models as Array<{ id?: string }>).some((model) => model.id === modelId);
			if (known) {
				claimScalar(
					"minimax-code",
					"model",
					`${renamed}/${modelId}`,
					label,
					`mapped to "${renamed}/${modelId}", the same model under the id your provider is imported as`,
				);
			} else {
				items.push({
					source: "minimax-code",
					from: label,
					to: "—",
					action: "skip",
					detail: `it names a model your custom provider "${providerId}" does not list, so the reference would point at nothing here`,
					containsSecret: false,
				});
			}
		} else if (providerId.startsWith("custom_provider:") && renamed === undefined) {
			const key = providerId.slice("custom_provider:".length);
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: Object.hasOwn(custom, key)
					? `it names your custom provider "${key}", which this run did not import — see its own line above`
					: `it names your custom provider "${key}", which is not in config.yaml — a reference to a provider that is not there points at nothing`,
				containsSecret: false,
			});
		} else if (providerId === "minimax_api") {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"it names MiniMax's reserved `minimax_api` route — your own MiniMax API key, whose value was not read and is " +
					"not carried; register a provider of your own here and export the key under its name",
				containsSecret: false,
			});
		} else if (providerId !== "") {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					`it names MiniMax's own "${providerId}" catalogue, which is seeded by its installer and served through your ` +
					"account route — not imported, so this reference would point at nothing here",
				containsSecret: false,
			});
		} else {
			// A bare name with no provider: this build's registry is the right
			// question for it after all, since nothing here registers it.
			const resolved = resolveModelReference(raw_model);
			if (resolved !== undefined) {
				claimScalar("minimax-code", "model", resolved, label, `mapped to "${resolved}"`);
			} else {
				items.push({
					source: "minimax-code",
					from: label,
					to: "—",
					action: "skip",
					detail: "no model of that name exists here, so importing it would leave settings.json pointing at nothing",
					containsSecret: false,
				});
			}
		}
	}

	planMinimaxPermissionMode(raw, home, items, claimScalar);
	planMinimaxPermissions(raw, home, items, addPermissionRules);

	// ── custom_provider / provider / minimax_api ─────────────────────────────
	for (const item of providers.items) items.push(item);
	mergeProviderSpecs(
		"minimax-code",
		providers.specs,
		(id) => `${from} → custom_provider.${id.replace(/^minimax-/, "")}`,
		items,
		settingsPatch,
		existing,
		force,
	);
	if (isRecord(config.provider) && Object.keys(config.provider).length > 0) {
		items.push({
			source: "minimax-code",
			from: `${from} → provider (${summarizeNames(Object.keys(config.provider), 6)})`,
			to: "—",
			action: "skip",
			detail:
				"MiniMax's own model routes, seeded by its installer from a preset: the endpoint and model list are the vendor's, " +
				"and the credentials behind them are your account's — none of it is a table you wrote, so none of it is imported",
			containsSecret: false,
		});
	}
	if (isRecord(config.minimax_api)) {
		items.push({
			source: "minimax-code",
			from: `${from} → minimax_api`,
			to: "—",
			action: "skip",
			detail:
				"your own MiniMax API key and an optional endpoint override — the key was not read, and no value of it appears here; " +
				"point a provider entry at MiniMax's API yourself and export the key under its name",
			containsSecret: false,
		});
	}

	// ── toolResultCompaction ─────────────────────────────────────────────────
	if (isRecord(config.toolResultCompaction)) {
		const compaction = config.toolResultCompaction;
		const label = `${from} → toolResultCompaction`;
		if (compaction.enabled === false) {
			// `enabled: false` there means "go straight to the summary"; this build's
			// switch for the same decision is `trimOldToolResults: false`.
			const current = existing.trimOldToolResults;
			if (current !== undefined && !force) {
				items.push({
					source: "minimax-code",
					from: `${label}.enabled (false)`,
					to: "—",
					action: "skip",
					detail: `target already sets trimOldToolResults to ${JSON.stringify(current)} — kept (use --force to overwrite)`,
					containsSecret: false,
				});
			} else {
				settingsPatch.trimOldToolResults = false;
				items.push({
					source: "minimax-code",
					from: `${label}.enabled (false)`,
					to: "settings.json → trimOldToolResults",
					action: "map",
					detail:
						"MiniMax is set to summarise rather than trim old tool results first, which is what this switch means here",
					containsSecret: false,
				});
			}
		}
		const tuning = [
			"maxInlineKiB",
			"mcpDetailsMaxInlineKiB",
			"watermarkKiB",
			"minSavingsKiB",
			"minCandidateKiB",
			"keepRecentRounds",
		].filter((key) => compaction[key] !== undefined);
		if (tuning.length > 0) {
			items.push({
				source: "minimax-code",
				from: `${label} (${summarizeNames(tuning, 6)})`,
				to: "—",
				action: "skip",
				detail:
					"the watermarks its own compaction works to (inline limits, savings thresholds, how many recent tool rounds are " +
					"protected) — this build's rung has its own thresholds and no settings for them",
				containsSecret: false,
			});
		}
	}

	for (const [key, reason] of MINIMAX_UNMIGRATED_SECTIONS) {
		if (config[key] === undefined) continue;
		items.push({
			source: "minimax-code",
			from: `${from} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	const computedPaths = MINIMAX_COMPUTED_PATHS.filter((key) => config[key] !== undefined);
	if (computedPaths.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${from} → ${summarizeNames(computedPaths, 6)}`,
			to: "—",
			action: "skip",
			detail:
				"paths MiniMax computes from its data directory; a value in the file is ignored there as well, and this build " +
				"keeps its own data under ~/.labunbun",
			containsSecret: false,
		});
	}

	// ── mcp.json, and the older spelling beside it ───────────────────────────
	//
	// Two files, and MiniMax does not read them as one document: its runtime
	// connects servers out of `mcp.json` alone (`filePath`,
	// `mcp/runtime/local-mcp.service.ts:1027`), and reads `mcp/mcp.json` only
	// into the set of names that keep skill references resolvable
	// (`readConfiguredMcpServerNames`, `mcp/runtime/config-file.ts:6-11`). So a
	// server defined there and nowhere else is running in neither tool, and
	// importing it silently would hand the user a working server the source
	// never had. Which file answers is the content test the data-directory pair
	// uses: the older one answers when the current one holds no servers at all,
	// and then what it held is imported because that is the only place those
	// servers are written down.
	const mcpFrom = tildePath(home, minimaxMcpFile(raw.root));
	const aliasFrom = tildePath(home, minimaxMcpAliasFile(raw.root));
	for (const error of raw.mcpErrors) {
		items.push({
			source: "minimax-code",
			from: error.startsWith("mcp/mcp.json") ? aliasFrom : mcpFrom,
			to: "—",
			action: "skip",
			detail: `${error} — no server in it was read`,
			containsSecret: false,
		});
	}
	const aliasNames = Object.keys(raw.mcpAlias).sort();
	const primaryNames = Object.keys(raw.mcp);
	const aliasAnswers = primaryNames.length === 0 && aliasNames.length > 0;
	if (aliasNames.length > 0) {
		const both = aliasNames.filter((name) => name in raw.mcp);
		const only = aliasNames.filter((name) => !(name in raw.mcp));
		items.push({
			source: "minimax-code",
			from: aliasFrom,
			to: "—",
			action: "skip",
			detail: aliasAnswers
				? `the older spelling of the same document, and the only place these servers are written down — MiniMax's own runtime connects servers out of \`${MINIMAX_MCP_FILE_NAME}\` only and reads this file just to keep their names resolvable for skills, so they are imported here anyway${
						both.length > 0
							? `; ${summarizeNames(both, 6)} is defined in both files and came across from \`${MINIMAX_MCP_FILE_NAME}\``
							: ""
					}`
				: `the older spelling of the same document, which MiniMax no longer connects from: its runtime reads servers out of \`${MINIMAX_MCP_FILE_NAME}\` only and keeps this file to resolve names for skills, and the servers in it were not imported — ${
						only.length > 0
							? `${summarizeNames(only, 6)} ${only.length === 1 ? "is" : "are"} defined there and nowhere in \`${MINIMAX_MCP_FILE_NAME}\``
							: "every name in it is also defined there"
					}${both.length > 0 ? `, and ${summarizeNames(both, 6)} came across from \`${MINIMAX_MCP_FILE_NAME}\`` : ""}`,
			containsSecret: false,
		});
	}
	const mcpSource = aliasAnswers ? aliasFrom : mcpFrom;
	for (const [name, value] of Object.entries(aliasAnswers ? raw.mcpAlias : raw.mcp)) {
		const label = `${mcpSource} → ${name}`;
		if (!isRecord(value)) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "entry is not a server definition",
				containsSecret: false,
			});
			continue;
		}
		if (value.builtin === true) {
			// MiniMax's own bundled server: its command is a path inside MiniMax's
			// installation, and its arguments point at that installation's files.
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"a server MiniMax ships with itself — its command runs MiniMax's own bundled program, not something of yours",
				containsSecret: false,
			});
			continue;
		}
		if (value.configured === false) {
			// `isUserConfiguredServer` (`settings-config.ts:33-35`) reads this flag the
			// same way: an entry it is false on is not one of the user's servers, and
			// MiniMax's own settings API refuses to hand it back.
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"an entry MiniMax marks as not configured by you — its own settings refuse to read it back, so it is not imported",
				containsSecret: false,
			});
			continue;
		}
		if (value.enabled === false) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "disabled in MiniMax — there is no way to keep a server defined and switched off here",
				containsSecret: false,
			});
			continue;
		}
		const normalized = normalizeMinimaxMcp(value);
		if (normalized === null || !McpServerConfigSchema.safeParse(normalized.config).success) {
			items.push({
				source: "minimax-code",
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
				source: "minimax-code",
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
			source: "minimax-code",
			from: label,
			to: `.mcp.json → mcpServers.${name}`,
			action: normalized.downgrades.length > 0 ? "downgrade" : "map",
			detail: normalized.downgrades.length > 0 ? `${copied} — ${normalized.downgrades.join("; ")}` : copied,
			containsSecret: secret,
		});
	}

	reportUnhandledKeys(
		"minimax-code",
		config,
		new Set<string>([
			"defaultModel",
			"permissionMode",
			"custom_provider",
			"provider",
			"minimax_api",
			"toolResultCompaction",
			...MINIMAX_UNMIGRATED_SECTIONS.map(([key]) => key),
			...MINIMAX_COMPUTED_PATHS,
		]),
		from,
		items,
	);
}

/** MiniMax's assets: `AGENTS.md`, skills, agents, and the trees it reads but does not own. */
function planMinimaxAssets(
	raw: RawMinimaxCode,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	collectFileWrites(
		"minimax-code",
		raw.skills,
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		"minimax-code",
		raw.agents,
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	if (raw.memory?.trim()) {
		// The document MiniMax injects in every project it runs in — the same
		// standing as `~/.claude/CLAUDE.md` and grok's `AGENTS.md` — so it lands as
		// a rule file that merges with existing memory rather than replacing it.
		planMemoryAsRule(
			"minimax-code",
			tildePath(home, minimaxGlobalInstructionsPath(raw.root)),
			home,
			raw.memory,
			"imported-minimax-code.md",
			force,
			items,
			writes,
		);
	}
	if (raw.agentSkips.length > 0) {
		items.push({
			source: "minimax-code",
			from: raw.agentSkips
				.map((skip) => `${tildePath(home, join(minimaxAgentsDir(raw.root), skip.name))} (${skip.reason})`)
				.join(", "),
			to: "—",
			action: "skip",
			detail: "no agent was taken from these directories, and MiniMax lists no agent for them either",
			containsSecret: false,
		});
	}
	if (raw.agentSkillTrees.length > 0) {
		items.push({
			source: "minimax-code",
			from: raw.agentSkillTrees
				.map((tree) => `${tildePath(home, join(minimaxAgentsDir(raw.root), tree.name, "skills"))} (${tree.count})`)
				.join(", "),
			to: "—",
			action: "skip",
			detail:
				"skills belonging to one agent over there: every skill here is loaded into every session, so importing these would " +
				"hand the whole session the instructions you wrote for a single agent",
			containsSecret: false,
		});
	}
	if (raw.builtinSkillNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, join(raw.root, MINIMAX_BUILTIN_SKILLS_DIR))} (${summarizeNames(raw.builtinSkillNames, 8)})`,
			to: "—",
			action: "skip",
			detail: `${raw.builtinSkillNames.length} skill(s) MiniMax ships with itself, kept current by its own updates rather than by this run`,
			containsSecret: false,
		});
	}
	if (raw.builtinAgentNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, join(minimaxAgentsDir(raw.root), MINIMAX_BUILTIN_AGENTS_DIR))} (${summarizeNames(raw.builtinAgentNames, 8)})`,
			to: "—",
			action: "skip",
			detail: `${raw.builtinAgentNames.length} agent(s) MiniMax ships with itself, on the same footing as its built-in skills`,
			containsSecret: false,
		});
	}
	if (raw.pluginNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, minimaxPluginsDir(raw.root))} (${summarizeNames(raw.pluginNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				`${raw.pluginNames.length} installed plugin(s): their skills and agents ship with the plugin and are updated with it, ` +
				"and this build has no plugin system to track that — the names are here so you can tell what is not",
			containsSecret: false,
		});
	}
	if (raw.reviewRules.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, join(raw.root, "review-rules"))} (${summarizeNames(raw.reviewRules, 8)})`,
			to: "—",
			action: "skip",
			detail:
				"your own instructions for MiniMax's code reviewer, which it splices into a review prompt — a rule here is read in " +
				"every session of every project, so the review rules are named rather than turned into standing instructions",
			containsSecret: false,
		});
	}
	if (raw.planNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, minimaxPlansDir(raw.root))} (${summarizeNames(raw.planNames, 8)})`,
			to: "—",
			action: "skip",
			detail: `${raw.planNames.length} plan document(s) you approved and kept — a document about one piece of work, not an instruction for every session`,
			containsSecret: false,
		});
	}
	if (raw.memoryNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, minimaxMemoryDir(raw.root))} (${summarizeNames(raw.memoryNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				"MiniMax's long-term notes, which its own memory feature reads and writes per topic; nothing here reads that layout, " +
				"and copying the files without the feature would leave notes that nothing maintains",
			containsSecret: false,
		});
	}
	if (raw.unreadV2Dirs.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, minimaxV2Root(raw.root))} (${summarizeNames(raw.unreadV2Dirs, 8)})`,
			to: "—",
			action: "skip",
			detail:
				"`v2/chats` holds the ledgers of MiniMax's older layout and `v2/mcode/drafts` the composer text you typed and never " +
				"sent — neither is a settings document, and a draft is not something you asked to send",
			containsSecret: false,
		});
	}
	if (raw.borrowedTrees.length > 0) {
		items.push({
			source: "minimax-code",
			from: raw.borrowedTrees.map((tree) => `~/${tree}`).join(", "),
			to: "—",
			action: "skip",
			detail:
				"trees MiniMax reads because they belong to other tools (Claude Code's, Codex's and the shared `~/.agents` one): the " +
				"sources that own them import them, and taking them here as well would land two copies of every skill",
			containsSecret: false,
		});
	}
	if (raw.credentialEntries.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, raw.root)}/${raw.credentialEntries.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				"credential-shaped entries reported by name and never opened — no value in them was read, and none is carried",
			containsSecret: false,
		});
	}
	if (raw.legacyRoot !== null) {
		items.push({
			source: "minimax-code",
			from: tildePath(home, raw.legacyRoot),
			to: "—",
			action: "skip",
			detail: raw.legacyRead
				? `the tree under MiniMax's older name (\`${MINIMAX_LEGACY_DATA_DIR_BASENAME}\`), which it renames into \`${MINIMAX_DATA_DIR_BASENAME}\` the next time it starts: this run read it, because the directory under the current name holds nothing on this machine — absent, or there but empty, which is the state MiniMax moves the old one over`
				: `the tree under MiniMax's older name (\`${MINIMAX_LEGACY_DATA_DIR_BASENAME}\`), which this run did not read: MiniMax uses the tree under the current name where that tree holds anything, and where the two hold nothing at all it is the current name it keeps — its own move of the old one is a rename rather than a merge`,
			containsSecret: false,
		});
	}
	if (raw.installDirPresent) {
		items.push({
			source: "minimax-code",
			from: `~/${MINIMAX_INSTALL_DIR}`,
			to: "—",
			action: "skip",
			detail:
				"the installer's own directory (and the data directory of older source builds) — program files, not your state",
			containsSecret: false,
		});
	}
	if (raw.otherDirs.length > 0) {
		items.push({
			source: "minimax-code",
			from: raw.otherDirs.map((entry) => `${tildePath(home, join(raw.root, entry.name))} (${entry.count})`).join(", "),
			to: "—",
			action: "skip",
			detail: "no mapping here for these, so they were left where they are",
			containsSecret: false,
		});
	}
	// A working directory's own MiniMax files are outside this planner's reach,
	// and saying so is the point: `.mcp.json` and `CLAUDE.md` look like this
	// source's, so a user who does not find them mentioned reads the silence as a
	// bug. This importer works from a home, and a repository's files belong to the
	// repository — the same reason grok's own planner gives for `.grok/`.
	items.push({
		source: "minimax-code",
		from: `each working directory's own ${MINIMAX_PROJECT_MCP_FILE} and ${MINIMAX_PROJECT_INSTRUCTION_FILES.join("/")}`,
		to: "—",
		action: "skip",
		detail:
			`a project's MCP servers and instruction document live beside the project rather than under \`${MINIMAX_DATA_DIR_BASENAME}\`, ` +
			"so this importer neither reads nor moves them — MiniMax reads the document under the first of those names that exists",
		containsSecret: false,
	});
}

// ---------------------------------------------------------------------------
// Step Code
// ---------------------------------------------------------------------------

/**
 * Step's three approval modes, as the permission modes this build has for them.
 *
 * The vendor's own tables, in the order the resolution below follows them:
 *
 *   - `step/permissions.ts:22-70` — the four presets and the triple each one
 *     stands for: `ask` → {confirm, deny, false}, `read-only` → {strict, deny,
 *     false}, `bypass` → {auto, allow, false}, `autopilot` → {auto, allow, true};
 *   - `:155-173` — a *preset* name is normalized through an older vocabulary
 *     (`confirm`→ask, `readonly`/`strict`→read-only, `auto`/`bypasspermissions`
 *     →bypass); `:176-195` — a *mode* name through another, one level lower
 *     (`ask`/`default`/`acceptedits`→confirm, `read-only`/`readonly`/`plan`
 *     →strict, `bypass`/`bypasspermissions`→auto);
 *   - `:286-324` — `effectiveMode = approvalMode ?? preset.mode`;
 *   - `:331-418` — `decideStepToolCall`: a read-only tool runs, a mutating tool
 *     is put to the user in `confirm`, denied in `strict`, and runs in `auto`
 *     unless Step's command analyser calls the command dangerous.
 */
const STEP_APPROVAL_MODES: Record<string, { mode: string; detail: string }> = {
	confirm: {
		mode: "default",
		detail:
			'mapped to "default": a mutating call is put to you before it runs, which is what Step\'s confirm mode does',
	},
	strict: {
		mode: "plan",
		detail:
			'mapped to "plan", which denies every mutating tool the way Step\'s read-only mode does — the difference worth knowing is ' +
			"that leaving plan mode here is itself an approval, where read-only is a standing answer",
	},
	auto: {
		mode: "bypassPermissions",
		detail:
			'mapped to "bypassPermissions", the nearest posture and a wider one: Step\'s auto mode still asks before a command its ' +
			"command analyser calls dangerous (`rm -rf` above all — it needs confirming for every target there), and nothing here asks",
	},
};

/** A setting at one of the spellings a live `config.toml` may carry it under. */
type StepCandidate = [key: string, value: unknown];

/** The first candidate the normalizer recognizes, with the key it came from. */
function stepFirstRecognized<T>(
	candidates: StepCandidate[],
	normalize: (value: string | undefined) => T | undefined,
): { key: string; value: T } | undefined {
	for (const [key, value] of candidates) {
		if (typeof value !== "string") continue;
		const normalized = normalize(value);
		if (normalized !== undefined) return { key, value: normalized };
	}
	return undefined;
}

/** The first candidate that is a boolean, with the key it came from. */
function stepFirstBoolean(candidates: StepCandidate[]): { key: string; value: boolean } | undefined {
	for (const [key, value] of candidates) {
		if (typeof value === "boolean") return { key, value };
	}
	return undefined;
}

/** A preset name as `{preset, mode}` — what the preset is called and the mode it stands for. */
function resolveStepPreset(value: string | undefined): { preset: string; mode: string } | undefined {
	switch (value?.trim().toLowerCase()) {
		case "ask":
		case "confirm":
			return { preset: "ask", mode: "confirm" };
		case "read-only":
		case "readonly":
		case "strict":
			return { preset: "read-only", mode: "strict" };
		case "bypass":
		case "auto":
		case "bypasspermissions":
			return { preset: "bypass", mode: "auto" };
		case "autopilot":
			return { preset: "autopilot", mode: "auto" };
		default:
			return undefined;
	}
}

/** A low-level approval mode name, normalized to the one of the three it means. */
function resolveStepApprovalMode(value: string | undefined): string | undefined {
	switch (value?.trim().toLowerCase()) {
		case "confirm":
		case "ask":
		case "default":
		case "acceptedits":
			return "confirm";
		case "strict":
		case "read-only":
		case "readonly":
		case "plan":
			return "strict";
		case "auto":
		case "bypass":
		case "bypasspermissions":
			return "auto";
		default:
			return undefined;
	}
}

/**
 * The starting permission posture, from the live `config.toml`.
 *
 * The resolution is the vendor's own, key for key and in its order: a mode first
 * (`step/settings-manager.ts:149-157`, `[approvalMode, approval.mode,
 * tools.approval.mode]`), then a preset (`:141-148`, `[permissionPreset,
 * permissionMode, approval.preset, tools.approval.preset]`), then
 * `effectiveMode = approvalMode ?? preset.mode`. A value the vendor's tables do
 * not recognize does not decide anything there either — the loop moves to the
 * next candidate — so this does the same, and says so when nothing at the end of
 * that chain was recognized.
 *
 * `autoResume`, `nonInteractiveApproval` and `feedbackEnabled` are resolved too,
 * but only so their report lines can name what they were: none of the three has
 * a counterpart here.
 */
function planStepPermissionMode(
	raw: RawStepCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
): void {
	const config = raw.config;
	const from = tildePath(home, stepConfigPath(raw.root));
	const approval = isRecord(config.approval) ? config.approval : {};
	const tools = isRecord(config.tools) ? config.tools : {};
	const toolsApproval = isRecord(tools.approval) ? tools.approval : {};

	const mode = stepFirstRecognized(
		[
			["approvalMode", config.approvalMode],
			["approval.mode", approval.mode],
			["tools.approval.mode", toolsApproval.mode],
		],
		resolveStepApprovalMode,
	);
	const preset = stepFirstRecognized(
		[
			["permissionPreset", config.permissionPreset],
			["permissionMode", config.permissionMode],
			["approval.preset", approval.preset],
			["tools.approval.preset", toolsApproval.preset],
		],
		resolveStepPreset,
	);
	const effectiveMode = mode?.value ?? preset?.value.mode;

	if (effectiveMode !== undefined) {
		const mapped = STEP_APPROVAL_MODES[effectiveMode];
		const source = mode !== undefined ? `${from} → ${mode.key}` : `${from} → ${preset?.key}`;
		if (mapped !== undefined) {
			// A preset is named as well as applied: `autopilot` is two settings in one,
			// and the half that has no counterpart here is reported below.
			const provenance =
				preset === undefined
					? ""
					: preset.value.mode === effectiveMode
						? `; the preset beside it, "${preset.value.preset}", resolves to the same mode`
						: `; the preset beside it is "${preset.value.preset}", whose mode "${preset.value.mode}" the explicit mode overrides`;
			claimScalar("step-code", "permissionMode", mapped.mode, source, `${mapped.detail}${provenance}`);
		}
	} else {
		// Nothing in the chain was recognized. Only worth a line when something was
		// there to recognize — otherwise the file simply says nothing about it.
		const spelled = [
			["permissionPreset", config.permissionPreset],
			["permissionMode", config.permissionMode],
			["approvalMode", config.approvalMode],
			["approval.preset", approval.preset],
			["approval.mode", approval.mode],
			["tools.approval.preset", toolsApproval.preset],
			["tools.approval.mode", toolsApproval.mode],
		].filter(([, value]) => typeof value === "string" && value.trim() !== "") as Array<[string, string]>;
		if (spelled.length > 0) {
			items.push({
				source: "step-code",
				from: spelled.map(([key, value]) => `${from} → ${key} ("${value}")`).join(", "),
				to: "—",
				action: "skip",
				detail:
					"not a preset or mode Step reads, so it never decided a session there either — the permission mode is left as it is",
				containsSecret: false,
			});
		}
	}

	// ── autoResume / nonInteractiveApproval / feedbackEnabled ────────────────
	const autoResume = stepFirstBoolean([
		["autoResume", config.autoResume],
		["autopilot", config.autopilot],
		["approval.autoResume", approval.autoResume],
		["approval.autopilot", approval.autopilot],
		["tools.approval.autoResume", toolsApproval.autoResume],
		["tools.approval.autopilot", toolsApproval.autopilot],
	]);
	const fromPreset = preset?.value.preset === "autopilot";
	const resumeValue = autoResume?.value ?? (fromPreset ? true : undefined);
	if (resumeValue !== undefined) {
		// `normalizeAutoResume` (`permissions.ts:271-281`) only lets the flag count
		// when the mode is auto *and* the non-interactive fallback allows, which the
		// two auto presets both give it.
		const active = resumeValue && effectiveMode === "auto";
		items.push({
			source: "step-code",
			from: autoResume === undefined ? `${from} → permissionPreset ("autopilot")` : `${from} → ${autoResume.key}`,
			to: "—",
			action: "skip",
			detail:
				(resumeValue ? "" : "set to false, and ") +
				"a continuation ladder for transient model errors, which this build does not have — " +
				(active
					? "it was in force over there, so a run that would have carried on after a transient failure stops here"
					: "it was not in force over there either"),
			containsSecret: false,
		});
	}
	const nonInteractive = stepFirstRecognized(
		[
			["nonInteractiveApproval", config.nonInteractiveApproval],
			["noninteractiveApproval", config.noninteractiveApproval],
			["approval.nonInteractive", approval.nonInteractive],
			["approval.noninteractive", approval.noninteractive],
			["tools.approval.nonInteractive", toolsApproval.nonInteractive],
			["tools.approval.noninteractive", toolsApproval.noninteractive],
		],
		(value) => {
			const normalized = value?.trim().toLowerCase();
			return normalized === "allow" || normalized === "deny" ? normalized : undefined;
		},
	);
	if (nonInteractive !== undefined) {
		items.push({
			source: "step-code",
			from: `${from} → ${nonInteractive.key} ("${nonInteractive.value}")`,
			to: "—",
			action: "skip",
			detail:
				'what an unattended run does with an approval request: Step\'s "allow" runs the call, its "deny" refuses it. This build ' +
				"has one answer for that, so the value is named rather than carried — the preset above already sets the posture an " +
				"attended session asks from",
			containsSecret: false,
		});
	}
	const feedback = stepFirstBoolean([
		["feedbackEnabled", config.feedbackEnabled],
		["feedback.enabled", isRecord(config.feedback) ? config.feedback.enabled : undefined],
	]);
	if (feedback !== undefined) {
		items.push({
			source: "step-code",
			from: `${from} → ${feedback.key} (${JSON.stringify(feedback.value)})`,
			to: "—",
			action: "skip",
			detail:
				"whether Step submits your feedback to the vendor — a switch about their service, with nothing to switch here",
			containsSecret: false,
		});
	}
}

/**
 * One provider from `models.json`, as an entry this build can register.
 *
 * `models.json` is a *strict* document — a TypeBox schema the vendor compiles
 * (`core/model-config.ts:209-213`), so a provider that loads there is
 * well-formed by construction — and it holds two different things under one
 * key: the credentials half (`apiKey`, never read) and the endpoint half.
 *
 * Three dispositions, because the two protocols this build cannot speak are not
 * the same kind of thing as a missing endpoint:
 *
 *   - a model whose protocol is `openai-completions` travels;
 *   - a model speaking `anthropic-messages` or `openai-responses` does not —
 *     `providers.openaiCompatible` here is one chat-completions endpoint for
 *     the whole provider (`settings.ts:39-53`), and there is no per-model
 *     protocol to say otherwise;
 *   - a model with no protocol at all travels nowhere: the vendor's own
 *     composer throws for it (`provider-composer.ts:141-145`, "no \"api\"
 *     specified"), so nothing was serving it there either.
 *
 * The limits use the vendor's own fallbacks rather than this importer's — 128k
 * context and 16 384 output tokens (`provider-composer.ts:165-166`) — because
 * those are the numbers a session over there was actually running under, and
 * the schema here requires both.
 */
function stepModelEntries(
	provider: Record<string, unknown>,
	providerApi: unknown,
): {
	entries: Array<Record<string, unknown>>;
	/** The endpoint behind each carried model, so the caller can tell whether one provider holds several. */
	endpoints: string[];
	foreign: string[];
	silent: string[];
	noEndpoint: string[];
	unapplied: string[];
} {
	const entries: Array<Record<string, unknown>> = [];
	const endpoints: string[] = [];
	const foreign: string[] = [];
	const silent: string[] = [];
	const noEndpoint: string[] = [];
	const unapplied: string[] = [];
	const models = Array.isArray(provider.models) ? provider.models : [];
	const overrides = isRecord(provider.modelOverrides) ? provider.modelOverrides : {};
	const providerBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
	for (const value of models) {
		if (!isRecord(value)) continue;
		const id = typeof value.id === "string" ? value.id.trim() : "";
		if (id === "") continue;
		const override = isRecord(overrides[id]) ? (overrides[id] as Record<string, unknown>) : {};
		const api = value.api ?? providerApi;
		if (typeof api !== "string" || api === "") {
			silent.push(id);
			continue;
		}
		if (api !== "openai-completions") {
			foreign.push(`${id} (${api})`);
			continue;
		}
		const modelBaseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
		const baseUrl = modelBaseUrl || providerBaseUrl;
		if (baseUrl === "") {
			noEndpoint.push(id);
			continue;
		}
		endpoints.push(baseUrl);
		const context = [override.contextWindow, value.contextWindow].find(
			(candidate): candidate is number => typeof candidate === "number" && candidate > 0,
		);
		const output = [override.maxTokens, value.maxTokens].find(
			(candidate): candidate is number => typeof candidate === "number" && candidate > 0,
		);
		const name = [override.name, value.name].find(
			(candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
		);
		const reasoning = [override.reasoning, value.reasoning].find(
			(candidate): candidate is boolean => typeof candidate === "boolean",
		);
		const cost = isRecord(override.cost) ? override.cost : isRecord(value.cost) ? value.cost : undefined;
		// Every cost block Step's schema accepts is complete (`core/model-config.ts:144-151`),
		// so the four rates are read as given; `tiers` is the one part with no
		// counterpart in `ModelPricingSchema`, and it is named rather than dropped.
		const pricing =
			cost === undefined
				? undefined
				: {
						input: typeof cost.input === "number" ? cost.input : 0,
						output: typeof cost.output === "number" ? cost.output : 0,
						cacheRead: typeof cost.cacheRead === "number" ? cost.cacheRead : 0,
						cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : 0,
					};
		if (isRecord(cost) && Array.isArray(cost.tiers) && cost.tiers.length > 0) {
			unapplied.push(`${id}: ${cost.tiers.length} cost tier(s)`);
		}
		// The per-model keys this build's provider shape has nowhere to put.
		for (const [key, what] of [
			["thinkingLevelMap", "a thinking-level map"],
			["samplingParams", "sampling parameters"],
			["headers", "its own headers"],
			["compat", "a protocol-compat block"],
			["input", "an input-modality list"],
		] as const) {
			if (value[key] !== undefined || override[key] !== undefined) unapplied.push(`${id}: ${what}`);
		}
		entries.push({
			id,
			...(name === undefined ? {} : { name }),
			contextWindow: Math.floor(context ?? 128_000),
			maxOutputTokens: Math.floor(output ?? 16_384),
			...(reasoning === true ? { reasoning: true } : {}),
			...(pricing === undefined ? {} : { pricing }),
		});
	}
	const carried = new Set(entries.map((entry) => entry.id));
	for (const id of Object.keys(overrides)) {
		if (!carried.has(id)) unapplied.push(`${id}: an override for a model this provider does not define`);
	}
	return { entries, endpoints, foreign, silent, noEndpoint, unapplied };
}

/**
 * What a Step provider's `apiKey` field says, without reading the key.
 *
 * The field is a small language, not a value (`models.json` documents it as a
 * literal, `$VAR`, `${VAR}` or `!command`), and only the two variable spellings
 * name something this build can read at start-up. A literal key is a secret
 * that must not be copied into a plan; `!command` is a program this importer
 * will not run. Both are reported by shape, never by content.
 */
function stepApiKeyName(value: unknown, fallback: string): { name: string; note?: string } {
	if (typeof value !== "string" || value.trim() === "") {
		return { name: fallback, note: `it names no api key variable, so this build reads $${fallback}` };
	}
	const trimmed = value.trim();
	const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed);
	if (braced) return { name: braced[1] };
	if (trimmed.startsWith("$") && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return { name: trimmed.slice(1) };
	if (trimmed.startsWith("!")) {
		return {
			name: fallback,
			note: `its key is produced by a shell command, which was neither read nor run — export the key yourself under $${fallback}`,
		};
	}
	return {
		name: fallback,
		note: `the key written in its apiKey was not read (a report carries names, not values) — export it under $${fallback}`,
	};
}

/** `models.json`'s provider table → `providers.openaiCompatible` entries. */
function planStepProviders(
	raw: RawStepCode,
	from: string,
	newIds: Map<string, string>,
	existing: RawSettingsInput,
	force: boolean,
): { specs: Array<Record<string, unknown>>; items: MigrationItem[] } {
	const items: MigrationItem[] = [];
	const specs: Array<Record<string, unknown>> = [];
	// The id a provider lands under is derived, so a collision with one the user
	// already has is possible and has to be decided here: a default model that
	// names it is rewritten to the derived id, and rewriting it to an id that was
	// never registered would leave settings.json pointing at another endpoint.
	const existingIds = new Set(
		((existing.providers?.openaiCompatible ?? []) as Array<{ id?: string }>).map((provider) => provider.id),
	);
	for (const [key, value] of Object.entries(raw.providers)) {
		const label = `${from}.${key}`;
		if (!isRecord(value)) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a provider table, so there is nothing here to register",
				containsSecret: false,
			});
			continue;
		}
		const models = stepModelEntries(value, value.api);
		// The endpoints a model carries are the ones that decide whether anything is
		// left to register; a provider whose own `baseUrl` is empty is not a skip in
		// itself, since every model may carry one of its own.
		const distinct = new Set(models.endpoints);
		if (models.entries.length === 0) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					models.foreign.length > 0
						? `no model this build can serve: ${summarizeNames(models.foreign)} speak a protocol other than openai-completions, ` +
							"and a provider entry here is one chat-completions endpoint"
						: models.silent.length > 0
							? `${models.silent.length} model(s) name no protocol at all, which Step's own composer refuses as well ("no "api" specified")`
							: models.noEndpoint.length > 0
								? `${models.noEndpoint.length} model(s) name neither an endpoint of their own nor a provider one`
								: "it defines no model this importer can read, so there is nothing to point a provider at",
				containsSecret: false,
			});
			continue;
		}
		if (distinct.size > 1) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					`its ${models.entries.length} openai-completions model(s) answer at ${distinct.size} different endpoints, and a ` +
					"provider entry here has one — split them into a provider each and import them by hand",
				containsSecret: false,
			});
			continue;
		}
		const endpoint = [...distinct][0] ?? "";
		const id = `step-${key}`;
		const { name: apiKeyEnv, note } = stepApiKeyName(
			value.apiKey,
			`${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
		);
		const spec = { id, baseUrl: endpoint, apiKeyEnv, models: models.entries };
		if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "its endpoint is not a usable URL for a provider entry",
				containsSecret: false,
			});
			continue;
		}
		const replacing = existingIds.has(id);
		if (replacing && !force) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: `settings.json already defines a provider with the id this would take (${id}) — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		const extras: string[] = [];
		if (replacing) extras.push(`it replaces the provider already registered as ${id}`);
		if (note !== undefined) extras.push(note);
		if (models.foreign.length > 0) {
			extras.push(
				`${models.foreign.length} model(s) were left out for speaking another protocol — ${summarizeNames(models.foreign, 4)}`,
			);
		}
		if (models.silent.length > 0) {
			extras.push(
				`${models.silent.length} model(s) name no protocol and were left out — ${summarizeNames(models.silent, 4)}`,
			);
		}
		if (models.unapplied.length > 0) {
			extras.push(`not carried: ${summarizeNames(models.unapplied, 4)}`);
		}
		if (typeof value.name === "string" && value.name.trim() !== "") {
			extras.push(`its display name "${value.name.trim()}" has no field here, where a provider is named by its id`);
		}
		if (value.headers !== undefined || value.compat !== undefined || value.authHeader !== undefined) {
			extras.push("its own headers, protocol-compat block or auth-header switch have no counterpart here");
		}
		specs.push(spec);
		newIds.set(key, id);
		items.push({
			source: "step-code",
			from: label,
			to: `settings.json → providers.openaiCompatible[${id}] (${models.entries.length} model(s))`,
			action: "map",
			detail: extras.length > 0 ? extras.join("; ") : "its endpoint and model list copied",
			containsSecret: false,
		});
	}
	return { specs, items };
}

/** Keys of one `[mcp_servers.<name>]` table this build's server shape can hold. */
const STEP_MCP_CARRIED = new Set([
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"http_headers",
	"bearer_token_env_var",
	"env_http_headers",
	"enabled",
	"startup_timeout_sec",
	"tool_timeout_sec",
	"enabled_tools",
	"disabled_tools",
	"oauth",
]);

/**
 * One `[mcp_servers.<name>]` table → this build's server shape.
 *
 * Step picks the transport the way Codex does — `command` first, and `url`
 * second (`mcp.ts:277-299`) — and its table is wider than the two shapes here.
 * Everything that does not fit is a named downgrade rather than a silent drop:
 *
 *   - `bearer_token_env_var` and `env_http_headers` name *variables* whose
 *     values Step expands into a header; a header value here is the literal
 *     text, so neither can be carried. Names only: no value is read.
 *   - `startup_timeout_sec` and `tool_timeout_sec`: this build has one connect
 *     timeout and no per-call one.
 *   - `enabled_tools` / `disabled_tools`: a filter Step applies to the tools a
 *     server advertises. Here a server's tools are all of them.
 *   - `oauth`: a client registration Step keeps in its own credential store.
 *   - a stdio field on an http server, or the reverse.
 *
 * `enabled = false` is not a downgrade but a refusal: this build has no way to
 * keep a definition while it is switched off, and writing the server anyway
 * would connect the next session to something the user had turned off.
 */
function normalizeStepMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const url = typeof entry.url === "string" ? entry.url.trim() : "";
	if (typeof entry.command === "string" && entry.command.trim() !== "") {
		const out: Record<string, unknown> = {
			type: "stdio",
			command: entry.command,
			args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [],
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") out.cwd = entry.cwd;
		for (const key of ["url", "http_headers", "bearer_token_env_var", "env_http_headers"] as const) {
			if (entry[key] !== undefined) downgrades.push(`it also carries ${key}, which only an http server uses`);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	if (url !== "") {
		const out: Record<string, unknown> = { type: "http", url };
		if (isRecord(entry.http_headers)) out.headers = entry.http_headers;
		for (const key of ["command", "args", "env", "cwd"] as const) {
			if (entry[key] !== undefined) downgrades.push(`it also carries ${key}, which only a stdio server uses`);
		}
		if (typeof entry.bearer_token_env_var === "string" && entry.bearer_token_env_var.trim() !== "") {
			downgrades.push(
				`it authenticates with a bearer token read from $${entry.bearer_token_env_var.trim()} — a header value here is the ` +
					"literal text, so the Authorization header was not copied; set it yourself once the token is in place",
			);
		}
		const envHeaders = isRecord(entry.env_http_headers) ? Object.keys(entry.env_http_headers) : [];
		if (envHeaders.length > 0) {
			downgrades.push(
				`${summarizeNames(envHeaders)} would be filled from ${summarizeNames(
					Object.values(entry.env_http_headers as Record<string, unknown>).map((name) => `$${String(name)}`),
				)} over there, and a header here is the literal text — set them yourself`,
			);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	return null;
}

/**
 * The `[mcp_servers.<name>]` keys with nowhere to go, named once for the server.
 *
 * A table this build can carry as-is is a plain copy; the keys below are the
 * ones whose absence changes what the server does, so each is named rather than
 * left to the reader to notice.
 */
function stepMcpNotes(entry: Record<string, unknown>, downgrades: string[]): void {
	if (typeof entry.startup_timeout_sec === "number") {
		downgrades.push(
			`it is given ${entry.startup_timeout_sec}s to start, and this build has one connect timeout for every server`,
		);
	}
	if (typeof entry.tool_timeout_sec === "number") {
		downgrades.push(`it is given ${entry.tool_timeout_sec}s per tool call, and this build has no per-call timeout`);
	}
	const enabled = Array.isArray(entry.enabled_tools) ? entry.enabled_tools.length : 0;
	const disabled = Array.isArray(entry.disabled_tools) ? entry.disabled_tools.length : 0;
	if (enabled > 0 || disabled > 0) {
		downgrades.push(
			`it filters its own tools (${[enabled > 0 ? `${enabled} enabled` : "", disabled > 0 ? `${disabled} disabled` : ""]
				.filter(Boolean)
				.join(", ")}), and every tool a server advertises is available here`,
		);
	}
	if (isRecord(entry.oauth)) {
		downgrades.push(
			"it registers an OAuth client, which this build has no store for — you will have to authorize it there",
		);
	}
	const extra = Object.keys(entry).filter((key) => !STEP_MCP_CARRIED.has(key));
	if (extra.length > 0) {
		downgrades.push(`${summarizeNames(extra)} has no counterpart here`);
	}
}

/** Text the CLI and the report use for a source whose settings document is one TOML file. */
const STEP_UNMIGRATED_KEYS: Array<[key: string, reason: string]> = [
	["defaultThinkingLevel", "a thinking level this build has no setting for"],
	["transport", "which transport the model client uses; this build picks its own"],
	["compat", "a Pi compatibility block for extensions this build does not load"],
	["extensions", "Pi extensions, which this build has no loader for"],
	["packages", "Pi packages, the same"],
	["enabledModels", "a model-picker allow-list, which this build has no picker setting for"],
	["defaultTools", "a default tool set, which this build's sessions decide for themselves"],
];

/**
 * `config.toml` — the live settings document — and `models.json`.
 *
 * The order follows the file where it can: the provider table is built first so
 * a default model naming one can be rewritten to the id that provider is
 * registered under, and reported after the model for the same reason MiniMax's
 * planner reports it that way.
 *
 * Two documents are named and not read. `settings.json` is the retired Pi
 * settings file (`docs/step-configuration.md:13-15`) and `step-settings.json`
 * its sibling; a key that lives only in either is a key this Step build no
 * longer honours, which is exactly why they get a line rather than silence.
 */
function planStepCode(
	raw: RawStepCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const from = tildePath(home, stepConfigPath(raw.root));
	const config = raw.config;
	if (raw.configError !== undefined) {
		items.push({
			source: "step-code",
			from,
			to: "—",
			action: "skip",
			detail: `${raw.configError} — nothing in this file was read, so this report is missing whatever it held`,
			containsSecret: false,
		});
	}
	// A key path this parser had to requote to read the document at all (a model
	// id with a dot in it, written bare) is named: the file on disk still holds
	// the unquoted spelling, which is what the user will go looking for.
	if (raw.configDottedKeys.length > 0) {
		items.push({
			source: "step-code",
			from: `${from} → ${summarizeNames(raw.configDottedKeys, 6)}`,
			to: "—",
			action: "skip",
			detail:
				"key paths whose dotted segments had to be requoted to parse this document, as the grok reader does with its own — " +
				"the file keeps the spelling it was written in",
			containsSecret: false,
		});
	}

	// ── models.json ──────────────────────────────────────────────────────────
	const modelsFrom =
		raw.modelsPath === null ? `${tildePath(home, raw.root)} → models.json` : tildePath(home, raw.modelsPath);
	if (raw.modelsError !== undefined) {
		items.push({
			source: "step-code",
			from: modelsFrom,
			to: "—",
			action: "skip",
			detail: `${raw.modelsError} — no provider in it was registered`,
			containsSecret: false,
		});
	}
	if (raw.otherModelsPath !== null) {
		items.push({
			source: "step-code",
			from: tildePath(home, raw.otherModelsPath),
			to: "—",
			action: "skip",
			detail:
				"the agent directory's own models.json, which is Step's older location for the file beside config.toml — the document " +
				"this build reads is the one its CLI hands its model registry, and a second table of providers would register " +
				"endpoints from a file that may no longer be read",
			containsSecret: false,
		});
	}
	const newIds = new Map<string, string>();
	const providers = planStepProviders(raw, `${modelsFrom} → providers`, newIds, existing, force);

	// ── defaultProvider / defaultModel ───────────────────────────────────────
	const providerName = typeof config.defaultProvider === "string" ? config.defaultProvider.trim() : "";
	const modelName = typeof config.defaultModel === "string" ? config.defaultModel.trim() : "";
	if (modelName !== "") {
		const label =
			providerName === ""
				? `${from} → defaultModel ("${modelName}")`
				: `${from} → defaultModel ("${modelName}") with defaultProvider ("${providerName}")`;
		// Step keeps the provider and the model as two settings, where a reference
		// here is one string. A provider this run imported is rewritten to the id it
		// lands under; a provider it did not is not resolved through the registry —
		// the registry answers for labunbun's own models, not for a name only Step
		// knows.
		const renamed = providerName === "" ? undefined : newIds.get(providerName);
		const known =
			renamed === undefined
				? undefined
				: (providers.specs.find((spec) => spec.id === renamed)?.models as Array<{ id?: string }> | undefined)?.some(
						(model) => model.id === modelName,
					);
		if (renamed !== undefined && known === true) {
			claimScalar(
				"step-code",
				"model",
				`${renamed}/${modelName}`,
				label,
				`mapped to "${renamed}/${modelName}", the same model under the id your provider is imported as`,
			);
		} else if (renamed !== undefined && known === false) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: `your provider "${providerName}" does not list a model called "${modelName}", so the reference would point at nothing here`,
				containsSecret: false,
			});
		} else if (providerName !== "" && Object.hasOwn(raw.providers, providerName)) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: `it names your provider "${providerName}", which this run did not import — see its own line above`,
				containsSecret: false,
			});
		} else if (providerName !== "") {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: `it names a provider that is not in models.json, so the model it selects was served by something else — ${JSON.stringify(
					providerName,
				)} is not a provider this build registers`,
				containsSecret: false,
			});
		} else {
			// No provider named: this build's registry is the right question after all.
			const resolved = resolveModelReference(modelName);
			if (resolved !== undefined) {
				claimScalar("step-code", "model", resolved, label, `mapped to "${resolved}"`);
			} else {
				items.push({
					source: "step-code",
					from: label,
					to: "—",
					action: "skip",
					detail: "no model of that name exists here, so importing it would leave settings.json pointing at nothing",
					containsSecret: false,
				});
			}
		}
	} else if (providerName !== "") {
		items.push({
			source: "step-code",
			from: `${from} → defaultProvider ("${providerName}")`,
			to: "—",
			action: "skip",
			detail:
				"a provider with no model chosen for it — this build's model setting names a model, and the provider is the part " +
				"before the slash, so there is nothing here to write a reference out of",
			containsSecret: false,
		});
	}

	// ── permission posture, theme ────────────────────────────────────────────
	planStepPermissionMode(raw, home, items, claimScalar);

	const theme = typeof config.theme === "string" ? config.theme.trim() : "";
	if (theme !== "") {
		const label = `${from} → theme ("${theme}")`;
		if (raw.themeNames.includes(theme)) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"it names a theme file of your own under the agent directory — Step's themes are a `vars`/`colors` palette " +
					"and this build's are semantic tokens, so the file was not converted and the name would not resolve here",
				containsSecret: false,
			});
		} else if (BUILT_IN_THEME_NAMES.includes(theme)) {
			claimScalar("step-code", "theme", theme, label, `mapped to the built-in theme of the same name`);
		} else {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					`no built-in theme here has that name — this build ships ${summarizeNames([...BUILT_IN_THEME_NAMES], 8)} — and no ` +
					`theme file under your agent directory is named that either: a theme of your own is named by the "name" inside the ` +
					"file rather than by the file's own name",
				containsSecret: false,
			});
		}
	}

	// ── mcp_servers ──────────────────────────────────────────────────────────
	const servers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
	for (const [name, value] of Object.entries(servers)) {
		const label = `${from} → mcp_servers.${name}`;
		if (!isRecord(value)) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a server table",
				containsSecret: false,
			});
			continue;
		}
		if (value.enabled === false) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"switched off in config.toml, and this build has no way to keep a server's definition while it is disabled — " +
					"importing it would connect every later session to a server you had turned off",
				containsSecret: false,
			});
			continue;
		}
		const normalized = normalizeStepMcp(value);
		if (normalized === null) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "it names neither a command nor a url, so Step has nothing to connect either",
				containsSecret: false,
			});
			continue;
		}
		stepMcpNotes(value, normalized.downgrades);
		if (name in existingMcpServers && !force) {
			items.push({
				source: "step-code",
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
			source: "step-code",
			from: label,
			to: `.mcp.json → mcpServers.${name}`,
			action: normalized.downgrades.length > 0 ? "downgrade" : "map",
			detail: normalized.downgrades.length > 0 ? `${copied} — ${normalized.downgrades.join("; ")}` : copied,
			containsSecret: secret,
		});
	}

	// ── the retired documents ────────────────────────────────────────────────
	if (raw.settingsError !== undefined) {
		items.push({
			source: "step-code",
			from: tildePath(home, join(raw.agentDir, "settings.json")),
			to: "—",
			action: "skip",
			detail: `${raw.settingsError} — and the file is retired in any case, so nothing in it decided anything`,
			containsSecret: false,
		});
	} else if (Object.keys(raw.settings).length > 0) {
		items.push({
			source: "step-code",
			from: tildePath(home, join(raw.agentDir, "settings.json")),
			to: "—",
			action: "skip",
			detail:
				`retired: this Step build no longer reads it (${Object.keys(raw.settings).length} key(s), ` +
				`${summarizeNames(Object.keys(raw.settings), 6)}) — the settings document it uses is config.toml, and its own notes say ` +
				"to move what matters there",
			containsSecret: false,
		});
	}
	if (raw.stepSettingsPresent) {
		items.push({
			source: "step-code",
			from: tildePath(home, join(raw.agentDir, "step-settings.json")),
			to: "—",
			action: "skip",
			detail: "retired in the same sentence as settings.json, and not read here either",
			containsSecret: false,
		});
	}

	// ── sections with no counterpart ─────────────────────────────────────────
	for (const [key, reason] of STEP_UNMIGRATED_KEYS) {
		if (config[key] === undefined) continue;
		items.push({
			source: "step-code",
			from: `${from} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	if (config.telemetry !== undefined) {
		items.push({
			source: "step-code",
			from: `${from} → telemetry`,
			to: "—",
			action: "skip",
			detail:
				"where Step sends its own usage reports — a switch about the vendor's service, not a preference of this build",
			containsSecret: false,
		});
	}
	const tools = isRecord(config.tools) ? config.tools : {};
	reportUnhandledKeys("step-code", tools, new Set(["approval"]), `${from} → tools`, items);

	mergeProviderSpecs(
		"step-code",
		providers.specs,
		(id) => `${modelsFrom} → providers.${id.replace(/^step-/, "")}`,
		items,
		settingsPatch,
		existing,
		force,
	);
	for (const item of providers.items) items.push(item);

	reportUnhandledKeys(
		"step-code",
		config,
		new Set<string>([
			"mcp_servers",
			"permissionPreset",
			"permissionMode",
			"approvalMode",
			"approval",
			"tools",
			"autoResume",
			"autopilot",
			"nonInteractiveApproval",
			"noninteractiveApproval",
			"feedbackEnabled",
			"feedback",
			"defaultProvider",
			"defaultModel",
			"theme",
			...STEP_UNMIGRATED_KEYS.map(([key]) => key),
		]),
		from,
		items,
	);
}

/**
 * Step's assets: skills, agents, prompts, the two system-prompt documents, and
 * everything under the tree that this importer names rather than reads.
 *
 * The plugins' own resources travel with the user's, each carrying the plugin
 * it came from (`withStepPluginOrigin`, set at read time) — Step loads a plugin
 * by giving its declared directories to the same resource loader the user's own
 * directories go through (`core/package-manager.ts`), so on that side they are
 * one set of skills and one set of agents, not two tiers.
 */
function planStepAssets(
	raw: RawStepCode,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	/** A path under the tree or the agent directory, rendered the way the report renders paths. */
	const at = (path: string): string => tildePath(home, path);
	const agentAt = (name: string): string => at(join(raw.agentDir, name));

	if (raw.legacy) {
		items.push({
			source: "step-code",
			from: at(raw.root),
			to: "—",
			action: "skip",
			detail:
				"the tree this run read, under the name Step Code used before its rename: Step itself reaches it in two narrow places " +
				"(importing a credential, and copying a session into the canonical tree), so a user who never launched the renamed " +
				"build keeps everything here — which is why it was read rather than skipped",
			containsSecret: false,
		});
	}

	collectFileWrites(
		"step-code",
		[...raw.skills, ...raw.pluginSkills],
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		"step-code",
		[...raw.agents, ...raw.pluginAgents],
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	const promptFiles = [...raw.prompts.files, ...raw.pluginPrompts.flatMap((prompts) => prompts.files)];
	const promptSkips = [...raw.prompts.skips, ...raw.pluginPrompts.flatMap((prompts) => prompts.skips)];
	planCommands(
		"step-code",
		{ files: promptFiles, skips: promptSkips },
		raw.pluginPrompts.length > 0 ? `${agentAt("prompts")} (and each plugin's commands/)` : `${agentAt("prompts")}`,
		home,
		force,
		items,
		writes,
	);

	// ── the system prompt documents ──────────────────────────────────────────
	// Step prepends `<agentDir>/SYSTEM.md` to the system prompt and appends
	// `APPEND_SYSTEM.md` to it. Here both become rule files, which are loaded as
	// a section of the system prompt: the text is the user's either way, and the
	// half worth stating is which of the two roles it plays.
	if (raw.systemPrompt?.trim()) {
		planMemoryAsRule(
			"step-code",
			agentAt("SYSTEM.md"),
			home,
			raw.systemPrompt,
			"imported-step-code.md",
			force,
			items,
			writes,
		);
	}
	if (raw.appendSystemPrompt?.trim()) {
		planMemoryAsRule(
			"step-code",
			agentAt("APPEND_SYSTEM.md"),
			home,
			raw.appendSystemPrompt,
			"imported-step-code-append.md",
			force,
			items,
			writes,
		);
	}
	// Only when something was actually imported: the sentence is about where the
	// text landed, and a file holding nothing but whitespace has no text to land.
	if (raw.systemPrompt?.trim() || raw.appendSystemPrompt?.trim()) {
		items.push({
			source: "step-code",
			from: `${agentAt("SYSTEM.md")} + ${agentAt("APPEND_SYSTEM.md")}`,
			to: "—",
			action: "skip",
			detail:
				"the text of both was imported; what differs is where it lands — Step splices the first into its own system prompt and " +
				"appends the second, where a rule file here is a memory section of the system prompt, loaded alongside the project's " +
				"own files rather than in place of them",
			containsSecret: false,
		});
	}

	// ── themes ───────────────────────────────────────────────────────────────
	if (raw.themeFiles.length > 0 || raw.extraThemePaths.length > 0) {
		items.push({
			source: "step-code",
			from: [
				raw.themeFiles.length > 0 ? `${agentAt("themes")} (${summarizeNames(raw.themeFiles, 6)})` : "",
				...raw.extraThemePaths.map((path) => at(path)),
			]
				.filter(Boolean)
				.join(", "),
			to: "—",
			action: "skip",
			detail:
				`${raw.themeFiles.length + raw.extraThemePaths.length} theme file(s), not converted: a Step theme is a table of named ` +
				"`vars` plus a `colors` map from that vocabulary onto the terminal's, where a theme file here is a flat `tokens` table " +
				"validated against this build's own token names — the two overlap (text, muted, success, warning, error, accent, " +
				"border, toolOutput, diff colours) and diverge everywhere else, so a conversion would drop the rest without a line " +
				"each. Copy the colours across into `~/.labunbun/themes/<name>.json` if you want the theme back",
			containsSecret: false,
		});
	}

	// ── entries with no directory to read ────────────────────────────────────
	if (raw.extraPatterns.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(stepConfigPath(raw.root))} → ${summarizeNames(raw.extraPatterns, 6)}`,
			to: "—",
			action: "skip",
			detail:
				"glob entries among the resource paths (`!`/`+`/`-` prefixed, or holding `*`/`?`): they select among files Step " +
				"collected from the directories above, and a selection rule over a set that does not exist here has nothing to select",
			containsSecret: false,
		});
	}
	if (raw.pluginNames.length > 0) {
		const extras: string[] = [];
		if (raw.pluginMcp.length > 0) {
			extras.push(`declaring MCP servers (${summarizeNames(raw.pluginMcp)})`);
		}
		if (raw.pluginCode.length > 0) {
			extras.push(`shipping code (${summarizeNames(raw.pluginCode)})`);
		}
		items.push({
			source: "step-code",
			from: `${at(join(raw.root, "plugins"))} (${summarizeNames(raw.pluginNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				`${raw.pluginNames.length} installed plugin(s): their skills, agents and commands were imported above, and what is ` +
				`left behind is the part that has no equivalent here — ${
					extras.length > 0 ? extras.join(", and ") : "their manifests"
				}; a plugin's code runs inside Step, and this build has no plugin host to run it in`,
			containsSecret: false,
		});
	}
	if (raw.pluginErrors.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(join(raw.root, "plugins"))} (${summarizeNames(raw.pluginErrors)})`,
			to: "—",
			action: "skip",
			detail: "plugin manifests that could not be read as JSON, so nothing they declare was taken",
			containsSecret: false,
		});
	}
	if (raw.marketplaceNames.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(join(raw.root, "marketplaces"))} (${summarizeNames(raw.marketplaceNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				"marketplace checkouts — a local copy of each catalogue you browsed, kept current by Step's own updater; the plugins " +
				"installed *from* them were read above",
			containsSecret: false,
		});
	}

	// ── state, credentials, and the rest of the tree ─────────────────────────
	if (raw.stateFiles.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(raw.root)}/${raw.stateFiles.join(", ")}`,
			to: "—",
			action: "skip",
			detail: raw.stateFiles
				.map((name) => STEP_STATE_FILES[leafName(name)])
				.filter((reason) => reason !== undefined)
				.join("; "),
			containsSecret: false,
		});
	}
	if (raw.credentialFiles.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(raw.root)}/${raw.credentialFiles.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				"credential-shaped entries reported by name and never opened — no value in them was read, and none is carried",
			containsSecret: false,
		});
	}
	if (raw.otherDirs.length > 0) {
		items.push({
			source: "step-code",
			from: raw.otherDirs.map((entry) => `${at(join(raw.root, entry.name))} (${entry.count})`).join(", "),
			to: "—",
			action: "skip",
			detail: "no mapping here for these, so they were left where they are",
			containsSecret: false,
		});
	}
	if (raw.agentOtherDirs.length > 0) {
		items.push({
			source: "step-code",
			from: raw.agentOtherDirs.map((entry) => `${at(join(raw.agentDir, entry.name))} (${entry.count})`).join(", "),
			to: "—",
			action: "skip",
			detail:
				"directories under the agent directory this importer reads nothing out of: `extensions` and `tools` are code Step " +
				"loads at startup, and the rest are its own working state",
			containsSecret: false,
		});
	}
	if (raw.otherFiles.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(raw.root)}/${raw.otherFiles.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				"files at the tree's root that are neither settings, state nor credentials — no mapping here for them, so they were " +
				"left where they are",
			containsSecret: false,
		});
	}

	// A working directory's own Step resources are outside this planner's reach,
	// and saying so is the point: `.stepcode/skills` and `.stepcode/agents` look
	// like this source's, so a user who does not find them mentioned reads the
	// silence as a bug. `findNearestProjectAgentsDir` walks up from the working
	// directory, which is a rule about a repository rather than about this tree.
	items.push({
		source: "step-code",
		from: `each working directory's own ${stepConfigDirName()}/{skills,prompts,themes,agents}`,
		to: "—",
		action: "skip",
		detail:
			"a project's resources live beside the project rather than under this tree, so this importer neither reads nor moves " +
			"them — Step finds them by walking up from the working directory, and the project that owns them travels with them",
		containsSecret: false,
	});
}

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
 *
 * A `detail` the reader already set is kept in front of the rest. That is the
 * plugin provenance: a command lifted out of a plugin has to keep saying so, and
 * this rewrite would otherwise be the last word on it.
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
			file.detail ?? "",
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
 *
 * Returns the ids that were taken, so a caller that wants to report on the
 * entries it offered asks this function instead of re-deriving which of them
 * survived. The rule is small and it is exactly the kind of small rule that
 * drifts: two copies of it is how a report starts describing a patch that was
 * never written.
 */
function mergeProviderSpecs(
	source: MigrationSourceId,
	additions: Array<Record<string, unknown>>,
	fromFor: (id: string) => string,
	items: MigrationItem[],
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	force: boolean,
): string[] {
	if (additions.length === 0) return [];
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
	if (accepted.length === 0) return [];
	const kept = force ? currentProviders.filter((p) => !additions.some((a) => a.id === p.id)) : currentProviders;
	settingsPatch.providers = { openaiCompatible: [...kept, ...accepted] };
	return accepted.map((p) => p.id as string);
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
