/**
 * Kimi Code's user state: `config.toml`, `mcp.json`, `AGENTS.md`, skills,
 * agents, plugins and sessions.
 *
 * Two trees matter and they are not the same tree — the engine's home and the
 * CLI's data directory disagree on exactly one value, and `kimiRoot` follows
 * the CLI, with the reason in its own docstring.
 */

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	kimiAgentsDir,
	kimiConfigPath,
	kimiLegacySourceRoot,
	kimiMcpFile,
	kimiPluginsDir,
	kimiRoot,
	kimiSkillsDir,
} from "./kimi-home.ts";
import { countTreeEntries, isRecord, readAgentFiles, readSkillDirs, readText, tildePath } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";

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
