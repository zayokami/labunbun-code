/**
 * Grok Build's user state: `config.toml`, instructions, rules, skills,
 * commands, agents, plugins, memory and sessions.
 *
 * The largest reader, and the only one that walks a plugin directory tree
 * component by component. A plugin can carry hooks, MCP servers, skills, agents
 * and commands at once, so a scan that stops at the first component found would
 * silently drop the rest — which is why `readOneGrokPlugin` returns all of them
 * and the caller reports each.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { grokRoot, grokSessions } from "./grok-home.ts";
import {
	countTreeEntries,
	isRecord,
	leafName,
	MAX_COMMAND_NAME,
	readAgentFiles,
	readAttachments,
	readJson,
	readMarkdownDir,
	readSkillDirs,
	readText,
	requoteNumericKeyPaths,
} from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";
// The same reader the skill loader uses, so what the importer writes back is
// what the loader will read.
import { parseFrontmatter } from "./skills.ts";

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
export const GROK_PLUGIN_DIR = "plugins";

/** grok's marketplace install directory, overridable with `[plugins].install_dir`. */
export const GROK_INSTALL_DIR = "installed-plugins";

/** Manifests that make a directory a plugin, in the order grok looks for one. */
const GROK_PLUGIN_MANIFESTS = [
	"plugin.json",
	join(".grok-plugin", "plugin.json"),
	join(".claude-plugin", "plugin.json"),
];

/** A plugin's MCP declaration, and its hooks — both change what the process does. */
export const GROK_PLUGIN_MCP = ".mcp.json";

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
export function grokStringList(value: unknown): string[] {
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
