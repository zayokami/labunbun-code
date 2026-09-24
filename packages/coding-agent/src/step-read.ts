/**
 * Step Code's user state: `config.json`, `models.json`, the state files, and
 * the trees it keeps skills, agents, prompts, plugins and themes in.
 *
 * Step's TOML-free configuration is read through the same generic readers as
 * everyone else's; what is here is the part that knows where Step keeps things.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	countTreeEntries,
	isRecord,
	readAgentFiles,
	readAttachments,
	readCommandFiles,
	readDirectoryNames,
	readSkillDirs,
	readText,
	requoteNumericKeyPaths,
} from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";
import { stepAssetDir, stepConfigRoot, stepRoot } from "./step-home.ts";

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
export const STEP_STATE_FILES: Record<string, string> = {
	"mcp-import.json": "Step's own record of which MCP sources were already reviewed for import",
	"models-store.json": "the credential store beside models.json",
};

/** Files at the root this importer does not enumerate: run output, not user state. */
const STEP_VOLATILE_FILE = /(\.log$|\.lock$|\.tmp$|~$|^\.DS_Store$)/;

/** `<root>/config.toml` — the live settings document, in the one spelling the tree has for it. */
export function stepConfigPath(root: string): string {
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
