// MiMo Code user state: the four roots it resolves, every path that
// `mimocode-read.ts` opens, and the trees this source names but never reads.
// Long-form design notes: docs/dev/migration-sources.md

import { readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The environment block
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The environment block the resolution reads; injectable so tests need no `process.env`. */
export type MiMoCodeEnv = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// The four roots
// ---------------------------------------------------------------------------

/** The directory name under every XDG base, verbatim: `const APP = "mimocode"`. */
export const MIMOCODE_APP = "mimocode";

/** The one root override. Set → absolute → the four roots become its subdirectories. */
export const MIMOCODE_HOME_ENV = "MIMOCODE_HOME";

/** An extra config **directory**, searched alongside `<config>` for every asset. */
export const MIMOCODE_CONFIG_DIR_ENV = "MIMOCODE_CONFIG_DIR";

// Long-form design notes: docs/dev/migration-sources.md
/** An extra config file, merged after the global one. */
export const MIMOCODE_CONFIG_FILE_ENV = "MIMOCODE_CONFIG";

/** Relocates the session database. Absolute, `<data>/`-relative, or `:memory:`. */
export const MIMOCODE_DB_ENV = "MIMOCODE_DB";

/** The TUI's own document, merged after `<config>/tui.json(c)` and before the project's. */
export const MIMOCODE_TUI_CONFIG_ENV = "MIMOCODE_TUI_CONFIG";

// Long-form design notes: docs/dev/migration-sources.md
/** The four variables `xdg-basedir` reads, each verbatim when truthy. */
export const XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME";
export const XDG_DATA_HOME_ENV = "XDG_DATA_HOME";
export const XDG_STATE_HOME_ENV = "XDG_STATE_HOME";
export const XDG_CACHE_HOME_ENV = "XDG_CACHE_HOME";

/** Which rule put the tree where it is, so the report can say why it is not the default. */
export type MiMoCodeRootMode = "mimocode-home" | "xdg";

export interface MiMoCodeRoots {
	/** `<config>` — settings documents, `AGENTS.md`, `skill(s)/`, `agent(s)/`, … */
	config: string;
	/** `<data>` — `mimocode.db`, `auth.json`, `mcp-auth.json`, `memory/`, `log/`. */
	data: string;
	/** `<state>` — nothing this importer reads; named so a report can point at it. */
	state: string;
	/** `<cache>` — `bin/` (`global.ts:70`) and anything else MiMo Code downloads. */
	cache: string;
	/** Which of the two rules in `resolveMimocodeHome` answered. */
	mode: MiMoCodeRootMode;
	// Long-form design notes: docs/dev/migration-sources.md
	/** `$MIMOCODE_HOME` as written, when it was set. */
	home: string | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Why `$MIMOCODE_HOME` was refused, or `null`. */
	rejectedHome: string | null;
}

/** One XDG base: the variable verbatim if truthy, else the POSIX fallback. */
function mimocodeXdgDir(envVar: string, fallback: string, home: string, env: MiMoCodeEnv): string {
	return join(env[envVar] || join(home, ...fallback.split("/")), MIMOCODE_APP);
}

// Long-form design notes: docs/dev/migration-sources.md
/** True for a path MiMo Code would use without resolving it against a base. */
export function isMiMoCodeAbsolutePath(value: string): boolean {
	return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The four roots, resolved the way `resolveMimocodeHome` resolves them. */
export function mimocodeRoots(home: string, env: MiMoCodeEnv): MiMoCodeRoots {
	const configured = env[MIMOCODE_HOME_ENV];
	if (configured !== undefined && configured !== "") {
		if (!isMiMoCodeAbsolutePath(configured)) {
			return {
				...xdgRoots(home, env),
				home: configured,
				rejectedHome:
					`${MIMOCODE_HOME_ENV} is set to a relative path, which MiMo Code itself refuses — \`resolveMimocodeHome\` throws ` +
					"`MIMOCODE_HOME must be an absolute path` before it reads anything (packages/shared/src/global.ts:29-33), so a " +
					"MiMo Code configured that way is one that will not start. This import read the XDG locations instead; set the variable to an " +
					"absolute path and re-run if that is not where your tree lives",
			};
		}
		return {
			config: join(configured, "config"),
			data: join(configured, "data"),
			state: join(configured, "state"),
			cache: join(configured, "cache"),
			mode: "mimocode-home",
			home: configured,
			rejectedHome: null,
		};
	}
	return xdgRoots(home, env);
}

/** The `mode: "xdg"` arm of {@link mimocodeRoots}, spelled once. */
function xdgRoots(home: string, env: MiMoCodeEnv): MiMoCodeRoots {
	return {
		config: mimocodeXdgDir(XDG_CONFIG_HOME_ENV, ".config", home, env),
		data: mimocodeXdgDir(XDG_DATA_HOME_ENV, ".local/share", home, env),
		state: mimocodeXdgDir(XDG_STATE_HOME_ENV, ".local/state", home, env),
		cache: mimocodeXdgDir(XDG_CACHE_HOME_ENV, ".cache", home, env),
		mode: "xdg",
		home: null,
		rejectedHome: null,
	};
}

// ---------------------------------------------------------------------------
// The settings documents
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The three global settings documents, in the order `loadGlobal` merges them. */
export const MIMOCODE_SETTINGS_FILES: readonly string[] = ["config.json", "mimocode.json", "mimocode.jsonc"];

// Long-form design notes: docs/dev/migration-sources.md
/** Keys deleted from every loaded document before the schema sees it. */
export const MIMOCODE_LEGACY_KEYS: readonly string[] = ["history", "auto_worktree", "theme", "keybinds", "tui"];

/** `<config>/tui.json` | `tui.jsonc` — the TUI's own layer, separate from the 41-key document. */
export const MIMOCODE_TUI_FILES: readonly string[] = ["tui.json", "tui.jsonc"];

// Long-form design notes: docs/dev/migration-sources.md
/** Top-level keys whose value is a map from a name the user chose to an entry. */
// Long-form design notes: docs/dev/migration-sources.md
/** Subtrees that provably hold no credential, however deep. */
export const MIMOCODE_NON_CREDENTIAL_SUBTREES: ReadonlySet<string> = new Set(["permission"]);

export const MIMOCODE_ENTRY_MAP_KEYS: ReadonlySet<string> = new Set([
	"mcp",
	"provider",
	"agent",
	"command",
	"model_groups",
	"lsp",
	"enabled_providers",
	"disabled_providers",
]);

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The directory names a skill may live in, both spellings, under each root. */
export const MIMOCODE_SKILL_DIRS: readonly string[] = ["skill", "skills"];
export const MIMOCODE_AGENT_DIRS: readonly string[] = ["agent", "agents"];
export const MIMOCODE_MODE_DIRS: readonly string[] = ["mode", "modes"];
export const MIMOCODE_COMMAND_DIRS: readonly string[] = ["command", "commands"];
export const MIMOCODE_PLUGIN_DIRS: readonly string[] = ["plugin", "plugins"];

/** `<root>/<one of the spellings>`, for the root MiMo Code would search. */
export function mimocodeAssetDirs(root: string, spellings: readonly string[]): string[] {
	return spellings.map((name) => join(root, name));
}

// Long-form design notes: docs/dev/migration-sources.md
/** A skill or agent file's name, path-relative, with the nested segments kept. */
export function mimocodeEntryName(relativePath: string): string {
	const normalized = relativePath.replace(/\\/g, "/");
	const ext = normalized.slice(normalized.lastIndexOf("."));
	const withoutExtension =
		ext.length > 0 && normalized.lastIndexOf(".") > normalized.lastIndexOf("/")
			? normalized.slice(0, -ext.length)
			: normalized;
	return withoutExtension;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Roots a command file may be named relative to, from `config/command.ts:47-52`. */
export const MIMOCODE_CLAUDE_COMMAND_ROOTS: readonly string[] = [
	"/.mimocode/command/",
	"/.mimocode/commands/",
	"/.claude/command/",
	"/.claude/commands/",
	"/command/",
	"/commands/",
];

// Long-form design notes: docs/dev/migration-sources.md
/** Roots an agent file may be named relative to, from `config/agent.ts:146`. */
export const MIMOCODE_AGENT_NAME_ROOTS: readonly string[] = [
	"/.mimocode/agent/",
	"/.mimocode/agents/",
	"/agent/",
	"/agents/",
];

// Long-form design notes: docs/dev/migration-sources.md
/** The `.claude` directories this importer can name: `<home>/.claude` and `<cwd>/.claude`. */
export function mimocodeClaudeCommandRoots(home: string, cwd: string): string[] {
	return [join(home, ".claude"), join(cwd, ".claude")];
}

// ---------------------------------------------------------------------------
// Skills MiMo Code borrows from other tools
// ---------------------------------------------------------------------------

/**
 * One tree MiMo Code reads skills out of that **is not its own**.
 *
 * `skill/index.ts:24-27`:
 *
 * ```js
 * // Scan order is load order: later roots win same-name collisions against earlier
 * // non-bundled skills. Open-standard .agents sits last among brand roots;
 * // .mimocode config dirs load after these.
 * const EXTERNAL_DIRS = [".claude", ".codex", ".opencode", ".agents"]
 * const EXTERNAL_SKILL_PATTERN = <glob under skills/ for a SKILL.md at any depth>
 * ```
 *
 * scanned at `<home>/<dir>` (`skill/index.ts:232-235`) and, for the project scope,
 * at every `<dir>` walking **up** from the working directory (`:257-261`). So a
 * MiMo Code install sees Claude Code's, Codex's and OpenCode's skills with no
 * configuration at all — that is the point of the list.
 */
export interface MiMoCodeVendorSkillDir {
	/** The directory name under a home or a working directory. */
	dir: string;
	/** Which tool actually writes it, and whose files these are. */
	owner: string;
	/** Which labunbun source imports it, when one does. `null` when none does. */
	labunbunSource: string | null;
	/** Whether MiMo Code reads it with nothing configured. */
	onByDefault: boolean;
	/** The variable that turns it on, when it is off by default. */
	enableEnv: string | null;
	/** The variable that turns it off, when it is on by default. */
	disableEnv: string | null;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The four trees, in the product's own scan order. */
export const MIMOCODE_VENDOR_SKILL_DIRS: readonly MiMoCodeVendorSkillDir[] = [
	{
		dir: ".claude",
		owner: "Claude Code",
		labunbunSource: "claude-code",
		onByDefault: false,
		enableEnv: "MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS",
		disableEnv: null,
	},
	{
		dir: ".codex",
		owner: "Codex",
		labunbunSource: "codex",
		onByDefault: false,
		enableEnv: "MIMOCODE_ENABLE_CODEX_SKILLS",
		disableEnv: null,
	},
	{
		dir: ".opencode",
		owner: "OpenCode",
		// `opencode-read.ts` harvests the tree for its own inventory and imports
		// providers, MCP and `AGENTS.md` — not `skills/`. So there is no source here
		// to file these under, which is why the report says "by hand".
		labunbunSource: null,
		onByDefault: false,
		enableEnv: "MIMOCODE_ENABLE_OPENCODE_SKILLS",
		disableEnv: null,
	},
	{
		dir: ".agents",
		owner: "the shared agent home",
		labunbunSource: "agents",
		onByDefault: true,
		enableEnv: null,
		disableEnv: "MIMOCODE_DISABLE_AGENTS_SKILLS",
	},
];

// ---------------------------------------------------------------------------
// Instruction documents
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The three document names MiMo Code injects, from `session/instruction.ts:17-21`. */
export const MIMOCODE_INSTRUCTION_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];

/** The character count below which a project `AGENTS.md` also pulls in `CLAUDE.md`. */
export const MIMOCODE_CLAUDE_FALLBACK_MAX_CHARS = 500;

// Long-form design notes: docs/dev/migration-sources.md
/** The global instruction documents, in the order `globalFiles` returns them (`session/instruction.ts:28-36`). */
export function mimocodeGlobalInstructionPaths(configRoot: string, configDirEnv: string | undefined): string[] {
	const files: string[] = [];
	if (configDirEnv !== undefined && configDirEnv !== "") files.push(join(configDirEnv, "AGENTS.md"));
	files.push(join(configRoot, "AGENTS.md"));
	return files;
}

/** `<home>/.claude/CLAUDE.md` — named so the report can say it was not read. */
export function mimocodeVendoredClaudeMd(home: string): string {
	return join(home, ".claude", "CLAUDE.md");
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The three memory scopes, from the pattern at `memory/paths.ts:47`. */
export const MIMOCODE_MEMORY_SCOPES: readonly string[] = ["global", "projects", "sessions"];

/** `<data>/memory` — the machine-wide memory root. */
export function mimocodeMemoryRoot(dataRoot: string): string {
	return join(dataRoot, "memory");
}

// Long-form design notes: docs/dev/migration-sources.md
/** Parse a memory file's path back into `{scope, scopeId, key}`, or `null`. */
export function mimocodeMemoryPath(path: string): { scope: string; scopeId: string; key: string } | null {
	const normalized = path.replace(/\\/g, "/");
	const marker = normalized.lastIndexOf("/memory/");
	if (marker === -1) return null;
	const rest = normalized.slice(marker + "/memory/".length);
	const parts = rest.split("/");
	if (parts.length < 2 || !parts[parts.length - 1].endsWith(".md")) return null;
	const scope = parts[0];
	if (!MIMOCODE_MEMORY_SCOPES.includes(scope)) return null;
	// **`global` has no id segment and the other two do**, which is the one asymmetry
	// in the pattern (`:47`, with `scope_id = scope === "global" ? "" : (idMaybe ?? "")`
	// at `:50`). Slicing by a fixed index gets a nested `global` key wrong — it would
	// drop its first segment — so the index is decided by the scope, which is what
	// the product's own regex capture decides.
	const hasId = scope !== "global";
	const key = parts
		.slice(hasId ? 2 : 1)
		.join("/")
		.replace(/\.md$/, "");
	if (key === "") return null;
	return { scope, scopeId: hasId ? (parts[1] ?? "") : "", key };
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

/** The database filename for the channels `getChannelPath` short-circuits on. */
export const MIMOCODE_DB_NAME = "mimocode.db";

// Long-form design notes: docs/dev/migration-sources.md
/** The database this install reads, or `null` when the install keeps none of the names MiMo Code does. */
export function mimocodeDatabasePath(dataRoot: string, env: MiMoCodeEnv): string | null {
	const named = env[MIMOCODE_DB_ENV];
	if (named !== undefined && named !== "") {
		if (named === ":memory:") return null;
		if (isMiMoCodeAbsolutePath(named)) return named;
		return join(dataRoot, named);
	}
	const primary = join(dataRoot, MIMOCODE_DB_NAME);
	if (mimocodeChannelDatabaseNames(dataRoot).includes(primary)) return primary;
	return mimocodeChannelDatabaseNames(dataRoot)[0] ?? null;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `mimocode.db` plus every `mimocode-<channel>.db`, sorted so the choice is reproducible. */
export function mimocodeChannelDatabaseNames(dataRoot: string): string[] {
	try {
		const names = readdirSync(dataRoot).filter((name) => name === MIMOCODE_DB_NAME || /^mimocode-.+\.db$/.test(name));
		return names.sort().map((name) => join(dataRoot, name));
	} catch {
		return [];
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** The `-wal` and `-shm` files a MiMo Code database has beside it. */
export function mimocodeDatabaseSidecars(dbPath: string): string[] {
	return [`${dbPath}-wal`, `${dbPath}-shm`];
}

// ---------------------------------------------------------------------------
// Credentials — named, never opened
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The files and tables that hold credentials, by name only. */
export const MIMOCODE_CREDENTIAL_FILES: readonly string[] = ["auth.json", "mcp-auth.json"];

export const MIMOCODE_CREDENTIAL_TABLES: readonly string[] = ["account", "account_state", "session_share"];

// Long-form design notes: docs/dev/migration-sources.md
/** A derived table that holds an index rather than content, and which must not be read as history. */
export const MIMOCODE_DERIVED_TABLES: readonly string[] = ["history_fts", "external_import"];

// Long-form design notes: docs/dev/migration-sources.md
/** The message rows that are subagent turns rather than the conversation. */
export const MIMOCODE_MAIN_AGENT_ID = "main";

// ---------------------------------------------------------------------------
// Managed configuration — report only
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The managed-config directories, named in the report and never read. */
export function mimocodeManagedConfigDir(platform: string, programData: string | undefined): string {
	if (platform === "darwin") return "/Library/Application Support/opencode";
	if (platform === "win32")
		return join(programData === undefined || programData === "" ? "C:\\ProgramData" : programData, "opencode");
	return "/etc/opencode";
}

// ---------------------------------------------------------------------------
// The roots this importer searches
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Every directory `mimocode-read.ts` walks, in the product's own precedence order. */
export function mimocodeReadRoots(
	home: string,
	roots: MiMoCodeRoots,
	cwd: string | undefined,
	env: MiMoCodeEnv,
): string[] {
	const found = [roots.config];
	if (cwd !== undefined) found.push(...walkUp(cwd, ".mimocode"));
	// The home walk: `afs.up({targets:[".mimocode"], start: Global.Path.home,
	// stop: Global.Path.home})` — the start is also the stop, so it yields exactly
	// one directory, `<home>/.mimocode`.
	found.push(join(home, ".mimocode"));
	const configDirEnv = env[MIMOCODE_CONFIG_DIR_ENV];
	if (configDirEnv !== undefined && configDirEnv !== "") found.push(configDirEnv);
	// `unique()` in the product: a directory named twice is one entry.
	return [...new Set(found.filter((dir) => dir !== ""))];
}

// Long-form design notes: docs/dev/migration-sources.md
/** Every `<name>` directory from `start` up to and including `start` itself. */
function walkUp(start: string, name: string): string[] {
	const normalized = start.replace(/\\/g, "/");
	// A POSIX absolute path starts with `/` and a Windows one with a drive letter
	// plus a separator. Either way the root is not a directory that can hold a
	// child, so the walk starts one level below it.
	const posixRoot = normalized.startsWith("/");
	const windowsRoot = /^[a-zA-Z]:[\\/]/.test(normalized);
	const parts = normalized.split("/").filter((part) => part !== "");
	if (parts.length === 0) return [];
	// `from` is the index of the first segment that is a real directory. For a
	// POSIX root it is 1, because the `tmp` in `/tmp/...` is below the root; for a
	// Windows root the drive letter is `parts[0]` and `Users` is `parts[1]`, so it
	// is 1 as well; for a relative path nothing is above the first segment, so 0.
	const from = posixRoot || windowsRoot ? 1 : 0;
	const out: string[] = [];
	for (let i = parts.length; i > from; i -= 1) {
		// The root prefix is re-attached, or every result is relative.
		const prefix = posixRoot ? ["/"] : [];
		out.push(join(...prefix, ...parts.slice(0, i), name));
	}
	return out;
}
