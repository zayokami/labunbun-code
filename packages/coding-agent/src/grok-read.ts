// Grok Build's user state: `config.toml`, instructions, rules, skills, commands, agents,
// plugins, memory and sessions.
// Long-form design notes: docs/dev/migration-sources.md

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
	// Long-form design notes: docs/dev/migration-sources.md
	/** Key paths grok's parser reads another way, as the file spells them. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Instruction file names grok reads from its home, in grok's own order. */
const GROK_INSTRUCTION_FILES = ["Agents.md", "AGENT.md", "AGENTS.md"];

// Long-form design notes: docs/dev/migration-sources.md
/** Where grok keeps plugins the user put there by hand. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Caches, logs, binaries and machine state under the home, reported by name. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** User-authored trees grok reads that have nothing to land here. */
const GROK_UNIMPORTED_DIRS = ["personas", "roles", "workflows", "agent-memory", "hooks"];

// Long-form design notes: docs/dev/migration-sources.md
/** Read Grok Build's user state from `$GROK_HOME`. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Expand a leading `~` the way grok expands it. */
function expandGrokTilde(home: string, raw: string): string {
	if (raw === "~") return home;
	if (raw.startsWith("~/")) return join(home, raw.slice(2));
	return raw;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The `[skills]` keys that decide which skills exist. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The vendor roots an entry can sit in, which another source owns. */
const GROK_VENDOR_DIRS = [".claude", ".cursor", ".agents"];

function vendorTreeOf(path: string): string | null {
	const parts = path.replace(/\\/g, "/").split("/");
	for (const dir of GROK_VENDOR_DIRS) {
		if (parts.includes(dir)) return dir;
	}
	return null;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The trees outside `$GROK_HOME` that grok itself reads. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Every instruction document grok reads from its home, as one text. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `<root>/config.toml`, parsed, with a retry for numeric key paths. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Grok's own `[skills]` switches, applied: survivors and skips. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Every skill under a skills root, at any depth, named by its directory. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The one skill a config path naming a `SKILL.md` file stands for. */
function readGrokSkillFileEntry(path: string): RawFile | null {
	if (leafName(path) !== "SKILL.md") return null;
	const dir = dirname(path);
	return readSkillAt(dir, leafName(dir));
}

// Long-form design notes: docs/dev/migration-sources.md
/** The skills `[skills] paths` adds, after grok's own trees. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** A name grok accepts for a skill, derived the way grok derives it. */
function grokSkillName(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `.md` files directly inside a `commands/` directory, each one a skill. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The directories a plugin's manifest points its skills or agents at. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Everything one plugin directory contributes. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Plugins under grok's own plugin roots, with contents lifted out. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Every plugin under one plugins directory. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The global memory document, from the tree grok's own switch chooses. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Machine-policy config layers under the home, reported and not imported. */
const GROK_MACHINE_POLICY = ["managed_config.toml", "requirements.toml"];
