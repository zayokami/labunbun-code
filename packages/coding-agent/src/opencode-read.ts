/**
 * OpenCode's user state: the three merged settings documents, the provider and
 * MCP tables they hold, the instruction file, and the skill trees.
 *
 * Everything here is transcribed from the OpenCode source rather than from its
 * documentation, and the citations are to `G:\Bunttta\opencode-dev` — which is
 * the one thing that makes this source different from the other nine. Where the
 * source and a blog post disagree, this module follows the source and says so.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	countTreeEntries,
	isRecord,
	parseJsonc,
	readAgentFiles,
	readCommandFiles,
	readSkillDirs,
	readText,
} from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";
import { readOpencodeTableNames } from "./opencode-db.ts";
import {
	OPENCODE_CONFIG_FILES,
	OPENCODE_VENDOR_DIRS,
	opencodeDatabasePath,
	opencodeLegacyStorageDir,
	opencodeLegacyTomlPath,
	opencodeRoots,
	opencodeVendorTree,
} from "./opencode-home.ts";

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

/** Entry names that look like credentials, at the config root. Named; never opened. */
const OPENCODE_CREDENTIAL_NAME = /(credential|secret|token|auth|\.env$)/i;

/**
 * The two files at the config root that hold credentials and are never opened.
 *
 * `auth.json` is written 0600 (`opencode/src/auth/index.ts:10`) and holds an
 * OAuth token per provider; `mcp-auth.json` is the MCP client's own OAuth cache
 * and is written the same way (`opencode/src/mcp/auth.ts:37`). Their contents are
 * the credentials of the user's accounts, and this importer reports their presence
 * and nothing else.
 */
export const OPENCODE_CREDENTIAL_FILES: readonly string[] = ["auth.json", "mcp-auth.json"];

/**
 * The tables in `opencode.db` that are never read, with the reason.
 *
 * Four of OpenCode's tables hold credentials, and three of them hold nothing
 * else: `account` carries `access_token`/`refresh_token`, `credential` and
 * `control_account` are the machine's own stores, and `session_share` has a
 * `secret text notNull` column — the capability URL a shared session is behind.
 * A migration reads the `session` and `message` tables and names these.
 */
export const OPENCODE_CREDENTIAL_TABLES: Readonly<Record<string, string>> = {
	account: "access and refresh tokens for the accounts signed in to this install",
	control_account: "the machine's own account records",
	credential: "a credential store with no session content in it",
	session_share: "the share secret each published session is behind",
};

/** Files at the config root this importer reads nothing out of, with the reason. */
export const OPENCODE_UNREAD_FILES: Readonly<Record<string, string>> = {
	"tui.json": "the terminal UI's own settings — colours, keybinds and layout for OpenCode's TUI",
	"tui.jsonc": "the terminal UI's own settings, in the spelling that allows comments",
	"plugin-meta.json": "install bookkeeping: which plugin versions were fetched and how often they loaded",
};

/** The merged settings, and where each part of the merge came from. */
export interface OpencodeConfigMerge {
	/** All three documents merged, later keys winning, as OpenCode merges them. */
	config: Record<string, unknown>;
	/** The files that were read, in merge order. A file absent is not listed. */
	from: string[];
	/** Files that were there and did not parse, with a fixed reason each. */
	errors: Array<{ path: string; reason: string }>;
	/** Config files that were read and then lost to a later one, key by key. */
	shadowed: Array<{ path: string; keys: string[] }>;
}

/** OpenCode's user state. */
export interface RawOpencode {
	/** The three resolved roots, each with the rule that decided it. */
	roots: ReturnType<typeof opencodeRoots>;
	/**
	 * True when this install has run, judged by the config root or by either of the
	 * two things only a run leaves behind.
	 *
	 * The config root alone is not enough of a test. `DatabaseMigration.apply(db)`
	 * runs in the database service's own constructor
	 * (`core/src/database/database.ts:24-35`), so the file is there after the first
	 * launch whether or not the user has ever written a setting — and a user who
	 * has deleted, or never created, `~/.config/opencode` still has every session
	 * in it. Reporting that machine as "no source configuration found" is a true
	 * sentence in front of a false conclusion.
	 */
	present: boolean;
	/** Where the config root came from, rendered for the report. */
	configOrigin: string;
	merge: OpencodeConfigMerge;
	/**
	 * `<config>/AGENTS.md` — the user's own global instructions.
	 *
	 * Not a conflict with the `agents` source: that one reads `~/.agents/AGENTS.md`
	 * (`agents-read.ts:36`), a different file in a different tree. This is
	 * OpenCode's own document, and the two are separate pieces of writing.
	 */
	instructions: string | null;
	/** The `provider` table, keyed by provider id. */
	providers: Record<string, unknown>;
	/** Provider ids named by `enabled_providers`/`disabled_providers`. */
	enabledProviders: string[];
	disabledProviders: string[];
	/** `skills.paths` — the user's own additional skill directories. */
	extraSkillPaths: string[];
	/** `skills.urls` — skills OpenCode fetches over the network. Named; never fetched. */
	skillUrls: string[];
	/** `plugin` — plugin specifiers. Named; never installed or run. */
	plugins: string[];
	/** `instructions` — extra instruction files, resolved the way OpenCode resolves them. */
	instructionPaths: string[];
	/** Skills under `<config>/skill` and `<config>/skills`. */
	skills: RawFile[];
	/** Agent markdown under `<config>/agent` and `<config>/agents`. */
	agents: RawFile[];
	/** Command markdown under `<config>/command` and `<config>/commands`. */
	commands: RawCommands;
	/** Credential files at the config root, by name. Named; never opened. */
	credentialFiles: string[];
	/** Credential tables found in the database, by name, with the reason each was left. */
	credentialTables: string[];
	/** `auth.json`/`mcp-auth.json`, whether or not the directory listing showed them. */
	credentialFilesNamed: string[];
	/** The pre-JSON TOML file, by presence only. */
	legacyToml: boolean;
	/** The pre-SQLite `storage/` tree, by presence only. */
	legacyStorage: boolean;
	/** The database this install reads, or `null` when it keeps none. */
	databasePath: string | null;
	/** Directories under the config root this importer reads nothing out of. */
	otherDirs: Array<{ name: string; count: number }>;
	/** Files at the config root that are neither read nor accounted for, by name. */
	otherFiles: string[];
	/** Which of {@link OPENCODE_UNREAD_FILES} this install actually has. */
	unreadFiles: string[];
	/**
	 * The `~/.claude` and `~/.agents` trees OpenCode reads skills from, that this
	 * importer does not read twice — see {@link OPENCODE_VENDOR_DIRS}.
	 */
	vendorTrees: string[];
}

/**
 * Merge the three settings documents the way `loadGlobal` merges them.
 *
 * `opencode/src/config/config.ts:272-274` calls `mergeConfig` — a `mergeDeep` —
 * three times in the order `config.json`, `opencode.json`, `opencode.jsonc`, so a
 * key present in more than one document takes the value from the last one that
 * has it. `mergeDeep` merges objects key by key and replaces everything else, so
 * that is what this does; the array-valued keys (`plugin`, `instructions`,
 * `enabled_providers`) are *replaced* rather than concatenated, which is what
 * makes a shadowed document worth naming.
 *
 * All three go through `ConfigParse.jsonc` (`:240`) whatever their extension, so
 * they are read with {@link readJsonc} — `JSON.parse` would throw away a file
 * whose author left a comment in it, and throw it away silently.
 */
export function mergeOpencodeConfig(configRoot: string): OpencodeConfigMerge {
	const merged: Record<string, unknown> = {};
	const from: string[] = [];
	const errors: OpencodeConfigMerge["errors"] = [];
	const shadowed: OpencodeConfigMerge["shadowed"] = [];
	for (const name of OPENCODE_CONFIG_FILES) {
		const path = join(configRoot, name);
		if (!existsSync(path)) continue;
		const text = readText(path);
		if (text === null) continue;
		let parsed: Record<string, unknown>;
		try {
			// `parseJsonc` rather than `readJsonc`, so a file that fails to parse is
			// a report line naming it instead of a document that quietly contributes
			// nothing — the failure mode `readJson`'s own catch is right about for a
			// malformed source file and wrong about here, where the sibling documents
			// are still perfectly good.
			parsed = parseOpencodeConfig(text);
		} catch {
			errors.push({ path, reason: `${name} is not parseable as JSON with comments` });
			continue;
		}
		from.push(path);
		const overwritten = Object.keys(parsed).filter((key) => key in merged);
		if (overwritten.length > 0) shadowed.push({ path, keys: overwritten.sort() });
		mergeDeepInto(merged, parsed);
	}
	return { config: merged, from, errors, shadowed };
}

/**
 * `mergeDeep` as OpenCode applies it: objects merge key by key, everything else
 * is replaced by the later value.
 *
 * Reproduced rather than replaced with a spread because a spread would let
 * `config.json`'s `mcp` block be wholly replaced by `opencode.jsonc`'s, where
 * OpenCode's `mergeDeep` keeps the two servers that only one of them names.
 */
function mergeDeepInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		if (isRecord(value) && isRecord(target[key])) {
			mergeDeepInto(target[key] as Record<string, unknown>, value);
			continue;
		}
		target[key] = value;
	}
}

/**
 * One settings document, parsed the way OpenCode parses it.
 *
 * Wrapped rather than inlined so the failure above has something to name. The
 * reason given is fixed rather than the parser's, which can quote the text it
 * choked on — and for this source the text it choked on may be an API key.
 */
function parseOpencodeConfig(text: string): Record<string, unknown> {
	return parseJsonc(text);
}

/** Directories under a config root that hold one kind of asset, in the tool's own spelling. */
const OPENCODE_ASSET_DIRS: Readonly<Record<"skills" | "agents" | "commands", readonly string[]>> = {
	// `{skill,skills}/**/SKILL.md` (opencode/src/skill/index.ts:24, scanned over
	// every config directory at `:204-208`).
	skills: ["skill", "skills"],
	agents: ["agent", "agents"],
	commands: ["command", "commands"],
};

/** Every directory under a config root that holds one kind of asset. */
function opencodeAssetDirs(configRoot: string, kind: keyof typeof OPENCODE_ASSET_DIRS): string[] {
	return OPENCODE_ASSET_DIRS[kind].map((name) => join(configRoot, name)).filter((path) => existsSync(path));
}

/**
 * The config root's own entries, split into the directories this importer reads
 * nothing out of and the files it has no mapping for.
 *
 * One listing with `withFileTypes` rather than two calls to `readDirectoryNames`,
 * because that helper returns both kinds and the two answers then disagree: a
 * `cache/` directory would be reported once as "N entries this importer reads
 * nothing out of" and again as a file with no mapping, which reads as two
 * separate things wrong with a tree that has one thing in it. The credential
 * names come out of the same pass for the same reason — a directory called
 * `tokens` is not a credential file, and naming it as one sends the user
 * looking for a secret that was never there.
 */
function readOpencodeConfigRoot(
	configRoot: string,
	accounted: Set<string>,
): { dirs: Array<{ name: string; count: number }>; files: string[] } {
	const dirs: Array<{ name: string; count: number }> = [];
	const files: string[] = [];
	try {
		for (const entry of readdirSync(configRoot, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!accounted.has(entry.name))
					dirs.push({ name: entry.name, count: countTreeEntries(join(configRoot, entry.name)) });
				continue;
			}
			// No `isFile()` test, because the `continue` above has already taken every
			// directory out and a `Dirent` that is neither a directory nor a file (a
			// symlink, a socket) is not a settings document under either spelling. An
			// earlier `if (entry.isFile())` here read as the thing keeping directories
			// out of the file list when the `continue` is what does it — and a falsifying
			// driver mutating that guard turned red nothing, because mutating it changes
			// no answer.
			files.push(entry.name);
		}
	} catch {
		// an unreadable config root contributes nothing
	}
	return { dirs: dirs.sort((a, b) => a.name.localeCompare(b.name)), files: files.sort() };
}

/** Names of the credential tables the database actually has. */
function readOpencodeCredentialTables(dbPath: string | null): string[] {
	if (dbPath === null) return [];
	return readOpencodeTableNames(dbPath).filter((name) => name in OPENCODE_CREDENTIAL_TABLES);
}

export function readOpencode(home: string): RawOpencode {
	const roots = opencodeRoots(home);
	const merge = mergeOpencodeConfig(roots.config);
	const config = merge.config;
	const databasePath = opencodeDatabasePath(roots.data);
	const legacyStorage = existsSync(opencodeLegacyStorageDir(roots.data));
	// See `RawOpencode["present"]`: a database or the pre-SQLite tree is a run, and
	// a run is the only thing that decides whether this source is here at all.
	const present = existsSync(roots.config) || databasePath !== null || legacyStorage;

	// The vendor trees are named by their presence under the home rather than by a
	// scan: OpenCode harvests them whatever the config says, and the point of the
	// report line is that the user learns another source owns them.
	const vendorTrees = OPENCODE_VENDOR_DIRS.filter((dir) => existsSync(join(home, dir)));

	const root = readOpencodeConfigRoot(
		roots.config,
		new Set([...OPENCODE_ASSET_DIRS.skills, ...OPENCODE_ASSET_DIRS.agents, ...OPENCODE_ASSET_DIRS.commands]),
	);
	const credentialFiles = root.files.filter((name) => OPENCODE_CREDENTIAL_NAME.test(name));
	const extraSkillPaths = opencodeSkillPaths(config);
	const skills = [
		...opencodeAssetDirs(roots.config, "skills").flatMap((dir) => readSkillDirs(dir)),
		...extraSkillPaths.flatMap((path) => readSkillDirs(path)),
	];
	// The vendor exclusion runs over the paths themselves, not over the results,
	// so a `skills.paths` entry pointing into `~/.claude` is caught the same way a
	// scan of that tree would be.
	const allowedSkills = skills.filter((skill) => opencodeVendorTree(skill.sourcePath) === null);

	return {
		roots,
		present,
		configOrigin: describeOpencodeRoot(roots.configOrigin),
		merge,
		instructions: readText(join(roots.config, "AGENTS.md")),
		providers: isRecord(config.provider) ? (config.provider as Record<string, unknown>) : {},
		enabledProviders: opencodeStringList(config.enabled_providers),
		disabledProviders: opencodeStringList(config.disabled_providers),
		extraSkillPaths,
		skillUrls: opencodeStringList(isRecord(config.skills) ? config.skills.urls : undefined),
		plugins: opencodeStringList(config.plugin),
		instructionPaths: opencodeInstructionPaths(config, home),
		skills: allowedSkills,
		agents: opencodeAssetDirs(roots.config, "agents").flatMap((dir) => readAgentFiles(dir)),
		commands: opencodeAssetDirs(roots.config, "commands").reduce<RawCommands>(
			(acc, dir) => {
				const read = readCommandFiles(dir);
				acc.files.push(...read.files);
				acc.skips.push(...read.skips);
				return acc;
			},
			{ files: [], skips: [] },
		),
		credentialFiles,
		credentialTables: readOpencodeCredentialTables(databasePath),
		credentialFilesNamed: OPENCODE_CREDENTIAL_FILES.filter((name) => existsSync(join(roots.config, name))),
		legacyToml: existsSync(opencodeLegacyTomlPath(roots.config)),
		legacyStorage,
		databasePath,
		otherDirs: root.dirs,
		otherFiles: root.files.filter(
			(name) =>
				!OPENCODE_CONFIG_FILES.includes(name) &&
				!(name in OPENCODE_UNREAD_FILES) &&
				!OPENCODE_CREDENTIAL_NAME.test(name) &&
				name !== "AGENTS.md" &&
				name !== "config",
		),
		unreadFiles: Object.keys(OPENCODE_UNREAD_FILES).filter((name) => existsSync(join(roots.config, name))),
		vendorTrees,
	};
}

/**
 * The rule that decided a root, in the report's own words.
 *
 * The default case is the one worth spelling out rather than leaving as a bare
 * path: on Windows the tree is at `~/.config/opencode` and not under
 * `%APPDATA%`, because `xdg-basedir@5.1.0` has no Windows branch. A report that
 * prints a bare path makes a reader who is looking in the usual place wonder
 * whether the importer is broken.
 */
export function describeOpencodeRoot(origin: string): string {
	switch (origin) {
		case "config-dir":
			return `$OPENCODE_CONFIG_DIR (OpenCode's own override — it names the opencode directory itself)`;
		case "xdg-config-home":
			return "$XDG_CONFIG_HOME/opencode";
		case "xdg-data-home":
			return "$XDG_DATA_HOME/opencode";
		case "xdg-state-home":
			return "$XDG_STATE_HOME/opencode";
		default:
			return "the default under the home directory — OpenCode's xdg-basedir has no Windows branch, so this is ~/.config on Windows too, not %APPDATA%";
	}
}

/** `skills.paths` entries that are directories, `~` expanded the way OpenCode expands them. */
function opencodeSkillPaths(config: Record<string, unknown>): string[] {
	if (!isRecord(config.skills)) return [];
	const paths = Array.isArray(config.skills.paths) ? config.skills.paths : [];
	return paths
		.filter((entry): entry is string => typeof entry === "string" && entry !== "")
		.map((entry) => {
			if (entry === "~") return homeDir();
			if (entry.startsWith("~/")) return join(homeDir(), entry.slice(2));
			return entry;
		});
}

/** `instructions` entries, with the same `~` handling `skills.paths` gets. */
function opencodeInstructionPaths(config: Record<string, unknown>, home: string): string[] {
	return opencodeStringList(config.instructions).map((entry) =>
		entry.startsWith("~/") ? join(home, entry.slice(2)) : entry,
	);
}

/** The home the skill loader expands `~` against — the process's, as `global.home` is. */
function homeDir(): string {
	return process.env.USERPROFILE || process.env.HOME || "";
}

/** The string entries of an array-valued key, blanks dropped. */
function opencodeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}
