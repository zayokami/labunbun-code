// OpenCode's user state: the three merged settings documents, the provider and
// MCP tables, the instruction file, and the skill trees.
// Long-form design notes: docs/dev/migration-sources.md

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { countTreeEntries, isRecord, parseJsonc, readAttachments, readCommandFiles, readText } from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";
import { readOpencodeTableNames } from "./opencode-db.ts";
import {
	OPENCODE_CONFIG_FILES,
	OPENCODE_VENDOR_DIRS,
	type OpencodeRoots,
	opencodeDatabasePath,
	opencodeLegacyStorageDir,
	opencodeLegacyTomlPath,
	opencodeRoots,
	opencodeVendorTree,
} from "./opencode-home.ts";
import { parseFrontmatter } from "./skills.ts";

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

/** Entry names that look like credentials, at the config root. Named; never opened. */
const OPENCODE_CREDENTIAL_NAME = /(credential|secret|token|auth|\.env$)/i;

// Long-form design notes: docs/dev/migration-sources.md
/** The eight config keys that changed spelling between v1 and v2, v2's name first. */
export const OPENCODE_KEY_SPELLINGS = {
	providers: ["providers", "provider"],
	permissions: ["permissions", "permission"],
	agents: ["agents", "agent"],
	commands: ["commands", "command"],
	plugins: ["plugins", "plugin"],
	snapshots: ["snapshots", "snapshot"],
	attachments: ["attachments", "attachment"],
	references: ["references", "reference"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** Every spelling of `key`, whichever of the two names it is written under. */
export function opencodeConfigSpellings(key: string): readonly string[] {
	for (const spellings of Object.values(OPENCODE_KEY_SPELLINGS)) {
		if ((spellings as readonly string[]).includes(key)) return spellings;
	}
	return [key];
}

// Long-form design notes: docs/dev/migration-sources.md
/** Where a key was found, and whether only the v2 engine reads it there. */
export interface OpencodeConfigKey {
	/** The spelling the merged document actually used. */
	spelling: string;
	/** Whether that spelling is one only the v2 engine reads. */
	v2Only: boolean;
	/** The value under it. */
	value: unknown;
}

/** The key as the user's file spells it, or `null` when the document has neither. */
export function opencodeConfigKey(config: Record<string, unknown>, key: string): OpencodeConfigKey | null {
	const spellings = opencodeConfigSpellings(key);
	for (const [index, spelling] of spellings.entries()) {
		if (config[spelling] === undefined) continue;
		return { spelling, v2Only: index < spellings.length - 1, value: config[spelling] };
	}
	return null;
}

/** The value under whichever spelling is present, without the rest of the answer. */
export function opencodeConfigValue(config: Record<string, unknown>, key: string): unknown {
	return opencodeConfigKey(config, key)?.value;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The files OpenCode writes credentials into, by the root each one sits in. */
export const OPENCODE_CREDENTIAL_FILES: Readonly<Record<"data" | "state", readonly string[]>> = {
	data: ["auth.json", "mcp-auth.json"],
	state: ["password"],
};

/** One known credential file that was actually found, and where. */
export interface OpencodeCredentialFile {
	/** The file name, as the report prints it. */
	name: string;
	/** Which root it lives in, so the report can name that root rather than a guess. */
	root: keyof typeof OPENCODE_CREDENTIAL_FILES;
	/** The path it was found at, absolute. */
	path: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The tables in `opencode.db` that are never read, with the reason. */
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
	// Long-form design notes: docs/dev/migration-sources.md
	/** True when this install has run, judged by the config root or by what a run leaves behind. */
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
	// Long-form design notes: docs/dev/migration-sources.md
	/** Which `skills` shape the file had: v1's `{paths, urls}` or v2's one list. */
	skillsSpelling: "object" | "list";
	/** `plugin` — plugin specifiers. Named; never installed or run. */
	plugins: string[];
	/** `instructions` — extra instruction files, resolved the way OpenCode resolves them. */
	instructionPaths: string[];
	/** Skills under `<config>/skill` and `<config>/skills`, plus any `skills.paths`. */
	skills: RawFile[];
	/**
	 * `SKILL.md` files OpenCode itself will not load — nested ones whose frontmatter
	 * has no `name:` (`packages/core/src/skill.ts:87-99`). Named in the report
	 * rather than imported, because importing them would hand over a skill the user
	 * cannot run in OpenCode either.
	 */
	unnamedSkills: string[];
	/** Agent markdown under `<config>/agent`, `agents`, `mode` and `modes`. */
	agents: RawFile[];
	/** Command markdown under `<config>/command` and `<config>/commands`. */
	commands: RawCommands;
	/** Credential-shaped file names at the config root, by name. Named; never opened. */
	credentialFiles: string[];
	/** Credential tables found in the database, by name, with the reason each was left. */
	credentialTables: string[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** The known credential files, found under the root each one lives in. */
	credentialFilesNamed: OpencodeCredentialFile[];
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

// Long-form design notes: docs/dev/migration-sources.md
/** `mergeDeep` as OpenCode applies it: objects merge key by key, everything else is replaced. */
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
	// every config directory at `:204-208`). v2 registers **both** of these
	// unconditionally, as two separate sources
	// (`packages/core/src/config/plugin/skill.ts:23-34`).
	skills: ["skill", "skills"],
	// `agent`/`agents` recursively and `mode`/`modes` one level deep
	// (`packages/core/src/config/plugin/agent.ts:21-24`) — four directories, two
	// depths. `mode`/`modes` are v1's spelling of a primary agent and are still
	// read by v2.
	agents: ["agent", "agents", "mode", "modes"],
	commands: ["command", "commands"],
};

/** Every directory under a config root that holds one kind of asset. */
function opencodeAssetDirs(configRoot: string, kind: keyof typeof OPENCODE_ASSET_DIRS): string[] {
	return OPENCODE_ASSET_DIRS[kind].map((name) => join(configRoot, name)).filter((path) => existsSync(path));
}

// Long-form design notes: docs/dev/migration-sources.md
/** The skills in one source directory, by OpenCode's own rule, and the ones it skips. */
function readOpencodeSkillDir(dir: string): { skills: RawFile[]; unnamed: string[] } {
	const skills: RawFile[] = [];
	const unnamed: string[] = [];
	const entries: string[] = [];
	try {
		if (!existsSync(dir)) return { skills, unnamed };
		// The two glob arms, spelled out: `*.md` directly in `dir`, and `SKILL.md`
		// at any depth below it. A `.md` below the top that is not named `SKILL.md`
		// is not a skill, and is not counted either — OpenCode's glob does not match
		// it, so nothing is lost by not mentioning it.
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (!name.endsWith(".md") || !statSync(path).isFile()) continue;
			entries.push(path);
		}
		const walk = (current: string): void => {
			for (const sub of readdirSync(current, { withFileTypes: true })) {
				if (!sub.isDirectory() || sub.name === "node_modules") continue;
				const full = join(current, sub.name);
				const nested = join(full, "SKILL.md");
				if (existsSync(nested) && statSync(nested).isFile()) entries.push(nested);
				walk(full);
			}
		};
		walk(dir);
	} catch {
		return { skills, unnamed };
	}

	for (const file of entries) {
		const content = readText(file);
		if (content === null) continue;
		const { data } = parseFrontmatter(content);
		const declared = typeof data.name === "string" ? data.name.trim() : "";
		// The fallback is the file's own basename, and it is offered **only** to a
		// file sitting directly in the source directory. The comparison is against
		// the source directory rather than the immediate parent, because that is
		// the directory OpenCode globs in.
		const isTopLevel = dirname(file) === dir;
		const name = declared !== "" ? declared : isTopLevel ? basename(file, ".md") : "";
		if (name === "") {
			unnamed.push(file);
			continue;
		}
		// A bare `.md` gets no attachments: its "directory" is the source directory
		// itself, and scanning that would carry every skill beside it — including
		// their own `SKILL.md` files, which `readAttachments` only excludes at the
		// top of a scan. A nested skill's directory is its own, so that one scans.
		const { attachments, attachmentSkips } = isTopLevel
			? { attachments: undefined, attachmentSkips: undefined }
			: readAttachments(dirname(file));
		skills.push({
			name,
			sourcePath: file,
			content,
			attachments,
			attachmentSkips,
			detail: isTopLevel ? "a bare markdown file opencode loads as a skill of its own" : undefined,
		});
	}
	return { skills, unnamed };
}

// Long-form design notes: docs/dev/migration-sources.md
/** Agent markdown under the four directories v2 reads, with the nesting flattened. */
function readOpencodeAgentFiles(configRoot: string): RawFile[] {
	const files: RawFile[] = [];
	for (const name of OPENCODE_ASSET_DIRS.agents) {
		const dir = join(configRoot, name);
		if (!existsSync(dir)) continue;
		const primary = name === "mode" || name === "modes";
		for (const file of primary ? markdownFilesIn(dir) : markdownFilesUnder(dir)) {
			const content = readText(file.path);
			if (content === null) continue;
			const { data } = parseFrontmatter(content);
			const notes: string[] = [];
			if (primary) {
				notes.push(
					"opencode forces this one to be a primary agent, so it is offered as a top-level choice rather than spawned as a subagent",
				);
			}
			if (data.model) {
				notes.push(
					`agent copied verbatim; its "model: ${data.model}" frontmatter is resolved when a subagent starts — a name that no longer resolves falls back to the session model and says so`,
				);
			}
			files.push({
				name: file.name,
				sourcePath: file.path,
				content,
				detail: notes.length === 0 ? undefined : `${notes.join(" — ")}`,
			});
		}
	}
	return files;
}

/** `*.md` directly in `dir`, sorted. */
function markdownFilesIn(dir: string): Array<{ name: string; path: string }> {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => ({ name, path: join(dir, name) }))
			.filter((entry) => statSync(entry.path).isFile());
	} catch {
		return [];
	}
}

/** `*.md` at any depth under `dir`, with the separators flattened into the name. */
function markdownFilesUnder(dir: string): Array<{ name: string; path: string }> {
	const out: Array<{ name: string; path: string }> = [];
	const walk = (current: string, prefix: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === "node_modules") continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(path, prefix === "" ? entry.name : `${prefix}-${entry.name}`);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			// The extension stays: `readMarkdownDir` — which read one level and is
			// what this replaces for `agent`/`agents` — put it in the name, and the
			// target path is built from that name. Dropping it would move every
			// already-migrated agent's file.
			out.push({ name: prefix === "" ? entry.name : `${prefix}-${entry.name}`, path });
		}
	};
	try {
		if (!existsSync(dir)) return out;
		walk(dir, "");
	} catch {
		return out;
	}
	return out;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The config root's own entries, split into directories and files with no mapping. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The known credential files on this machine, each against the root it is in. */
function readOpencodeCredentialFiles(roots: OpencodeRoots): OpencodeCredentialFile[] {
	const found: OpencodeCredentialFile[] = [];
	for (const root of ["data", "state"] as const) {
		for (const name of OPENCODE_CREDENTIAL_FILES[root]) {
			const path = join(roots[root], name);
			if (existsSync(path)) found.push({ name, root, path });
		}
	}
	return found.sort((a, b) => a.name.localeCompare(b.name));
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
	const skillEntries = opencodeSkillEntries(config);
	const extraSkillPaths = skillEntries.paths;
	// OpenCode's own skill rules, not the generic one-level reader nine sources
	// share: a skill is either a directory holding a `SKILL.md` **that names
	// itself** or a bare `.md` sitting directly in the source directory. Both are
	// read, and what OpenCode skips is counted and named.
	const scanned = [...opencodeAssetDirs(roots.config, "skills"), ...extraSkillPaths].map((dir) =>
		readOpencodeSkillDir(dir),
	);
	const skills = scanned.flatMap((entry) => entry.skills);
	const unnamedSkills = scanned.flatMap((entry) => entry.unnamed);
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
		providers: isRecord(opencodeConfigValue(config, "providers"))
			? (opencodeConfigValue(config, "providers") as Record<string, unknown>)
			: {},
		enabledProviders: opencodeStringList(config.enabled_providers),
		disabledProviders: opencodeStringList(config.disabled_providers),
		extraSkillPaths,
		skillUrls: skillEntries.urls,
		// Which of the two `skills` shapes the file had, because the two produce
		// report lines that name different keys and a v2 list was split here rather
		// than read as two named fields.
		skillsSpelling: Array.isArray(opencodeConfigValue(config, "skills")) ? "list" : "object",
		plugins: opencodeStringList(opencodeConfigValue(config, "plugins")),
		instructionPaths: opencodeInstructionPaths(config, home),
		skills: allowedSkills,
		unnamedSkills,
		agents: readOpencodeAgentFiles(roots.config),
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
		credentialFilesNamed: readOpencodeCredentialFiles(roots),
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

// Long-form design notes: docs/dev/migration-sources.md
/** The rule that decided a root, in the report's own words. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `skills` under both shapes: v1's `{paths, urls}` and v2's one flat list. */
function opencodeSkillEntries(config: Record<string, unknown>): { paths: string[]; urls: string[] } {
	const value = opencodeConfigValue(config, "skills");
	const expand = (entry: string): string => {
		if (entry === "~") return homeDir();
		if (entry.startsWith("~/")) return join(homeDir(), entry.slice(2));
		return entry;
	};
	if (Array.isArray(value)) {
		const paths: string[] = [];
		const urls: string[] = [];
		for (const entry of opencodeStringList(value)) {
			let remote = false;
			try {
				remote = URL.canParse(entry) && /^(https?:)$/.test(new URL(entry).protocol);
			} catch {
				// `URL.canParse` already rejected it; this only catches a parser that
				// disagrees with itself, and a directory is the safe reading.
				remote = false;
			}
			(remote ? urls : paths).push(remote ? entry : expand(entry));
		}
		return { paths, urls };
	}
	if (!isRecord(value)) return { paths: [], urls: [] };
	return { paths: opencodeStringList(value.paths).map(expand), urls: opencodeStringList(value.urls) };
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
