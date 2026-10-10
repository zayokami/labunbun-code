// Codewhale user state: the configuration home, the paths codewhale-read.ts opens,
// and the trees this source names but never reads.
// Long-form design notes: docs/dev/migration-sources.md

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// Long-form design notes: docs/dev/migration-sources.md
/** The canonical Codewhale application directory name. */
export const CODEWHALE_DEFAULT_DIR = ".codewhale";

// Long-form design notes: docs/dev/migration-sources.md
/** The pre-rename directory, and a live root rather than a historical one. */
export const CODEWHALE_LEGACY_DIR = ".deepseek";

/** The environment block the resolution reads; injectable so tests need no `process.env`. */
export type CodewhaleEnv = Record<string, string | undefined>;

// Long-form design notes: docs/dev/migration-sources.md
/** The variable that moves the whole tree, and the only one that does. */
export const CODEWHALE_HOME_ENV = "CODEWHALE_HOME";

// Long-form design notes: docs/dev/migration-sources.md
/** Variables that relocate the config file rather than the tree. */
export const CODEWHALE_CONFIG_PATH_ENV = "CODEWHALE_CONFIG_PATH";

/** The second half of the config-file override pair. See {@link CODEWHALE_CONFIG_PATH_ENV}. */
export const CODEWHALE_LEGACY_CONFIG_PATH_ENV = "DEEPSEEK_CONFIG_PATH";

// Long-form design notes: docs/dev/migration-sources.md
/** Whether the tree is env-relocatable, and which variables do it. */
export const CODEWHALE_HOME_ENVS: readonly string[] = [CODEWHALE_HOME_ENV];

// ---------------------------------------------------------------------------
// The two roots
// ---------------------------------------------------------------------------

/** Why `CODEWHALE_HOME` was refused, or `null` when it was unset or usable. */
export type CodewhaleHomeRejection = "relative" | "tilde-without-home";

// Long-form design notes: docs/dev/migration-sources.md
/** The home the reader will open, and why a configured one was not used. */
export interface CodewhaleHome {
	/** `CODEWHALE_HOME` when it names an absolute path, else `<home>/.codewhale`. */
	root: string;
	/** The pre-rename root, `<home>/.deepseek`. Never follows `CODEWHALE_HOME`. */
	legacyRoot: string;
	/** True when `CODEWHALE_HOME` was set to a non-empty value. */
	explicit: boolean;
	/**
	 * Why `CODEWHALE_HOME` was not used, or `null`.
	 *
	 * `null` when it was unset, when it was blank, and when it was usable. A
	 * non-null value is a sentence, not a flag — the report prints it as-is.
	 */
	rejectedHome: string | null;
}

/** `CODEWHALE_HOME` trimmed the way the product trims it, or `undefined`. */
function codewhaleHomeEnv(env: CodewhaleEnv): string | undefined {
	const raw = env[CODEWHALE_HOME_ENV];
	if (raw === undefined) return undefined;
	// `normalize_path_value` (`crates/paths/src/lib.rs:213-225`): empty is unset,
	// and a Unicode value is trimmed, so a whitespace-only value is unset too.
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Resolve the two roots. */
export function resolveCodewhaleHome(home: string, env: CodewhaleEnv = process.env): CodewhaleHome {
	const legacyRoot = join(home, CODEWHALE_LEGACY_DIR);
	const configured = codewhaleHomeEnv(env);
	if (configured === undefined) {
		return { root: join(home, CODEWHALE_DEFAULT_DIR), legacyRoot, explicit: false, rejectedHome: null };
	}

	// `~` alone is the home; `~/x` is the home with `x` appended
	// (`crates/paths/src/lib.rs:169-189`). Both separators are accepted because
	// the product accepts both there (`suffix.starts_with('/') || starts_with('\\')`).
	const expanded = expandLeadingTilde(configured, home);
	if (expanded === null) {
		return {
			root: join(home, CODEWHALE_DEFAULT_DIR),
			legacyRoot,
			explicit: true,
			rejectedHome:
				`${CODEWHALE_HOME_ENV} is set to a value Codewhale itself refuses: it begins with "~", and the user home could not be ` +
				"expanded, so the product raises PathOverrideErrorKind::HomeUnavailable and refuses to start. This import fell back to " +
				CODEWHALE_DEFAULT_DIR,
		};
	}
	if (!isAbsolute(expanded)) {
		return {
			root: join(home, CODEWHALE_DEFAULT_DIR),
			legacyRoot,
			explicit: true,
			rejectedHome:
				`${CODEWHALE_HOME_ENV} is set to a relative path, which Codewhale rejects outright — "${expanded}" is not absolute, and the ` +
				`product's own message is "${CODEWHALE_HOME_ENV} must be an absolute path". This import fell back to ${CODEWHALE_DEFAULT_DIR}`,
		};
	}
	return { root: expanded, legacyRoot, explicit: true, rejectedHome: null };
}

// Long-form design notes: docs/dev/migration-sources.md
/** Expand a leading `~`, or say it could not be done. */
export function expandLeadingTilde(value: string, home: string): string | null {
	if (value === "~") return home === "" ? null : home;
	if (!value.startsWith("~")) return value;
	const suffix = value.slice(1).replace(/^[\\/]+/, "");
	if (!value.startsWith("~/") && !value.startsWith("~\\")) return value;
	if (home === "") return null;
	return suffix === "" ? home : join(home, suffix);
}

// ---------------------------------------------------------------------------
// The per-path legacy fallback
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Whether a state path still falls back to `~/.deepseek`. */
export const CODEWHALE_LEGACY_FALLBACK: Readonly<Record<string, boolean>> = {
	// `config/src/lib.rs:6947-6960` (`default_config_path`) — primary, then
	// legacy, then primary. Mirrored by `home_config_path_from_environment`,
	// `tui/src/config/paths.rs:104-124`.
	"config.toml": true,
	// A **sibling of whatever `config.toml` resolved to**, so it inherits that
	// resolution rather than having one of its own:
	// `config/src/lib.rs:6620-6623`, `config_sibling_path_unchecked(config_path, PERMISSIONS_FILE_NAME)`.
	"permissions.toml": true,
	// `tui/src/config/paths.rs:215-217` → `default_user_state_path("mcp.json")`
	// → `:252-262`.
	"mcp.json": true,
	// `tui/src/config/paths.rs:211-213` → the same helper. **But see
	// {@link codewhaleSkillRoots}: the *skill loader* uses a second
	// `default_skills_dir` (`tui/src/skills/mod.rs:188`) that does not fall back,
	// so a `.deepseek/skills` tree is read by one and missed by the other.
	skills: true,
	"notes.txt": true,
	"memory.md": true,
	// `settings.rs:2447-2462` — **two** legacy candidates, and the second is not
	// under the home at all: `dirs::config_dir()/deepseek/settings.toml`, which on
	// Windows is `%APPDATA%\deepseek\settings.toml`.
	"settings.toml": true,
	// `settings.rs:141-150` maps `[primary, legacy_home]` through
	// `with_file_name(TUI_PREFS_FILE_NAME)`, so it inherits the settings roots.
	"tui.toml": true,
	// `tui/src/session_manager.rs:3758` `ensure_state_dir("sessions")`, whose
	// **write** form additionally relocates a legacy `sessions` tree into the
	// primary on first creation (`config/src/lib.rs:6177-6186`, "#3240").
	sessions: true,
	// `config/src/lib.rs:6158` `resolve_state_dir`, the generic one.
	state: true,
	tool_outputs: true,

	// **No fallback.** Each of these is joined straight onto `codewhale_home()`.
	agents: false, // fleet/profile.rs:63
	fleets: false, // fleet/store.rs:597-598
	plugins: false, // plugins/discovery.rs:61-63
	themes: false, // palette/user_theme.rs:196-198
	"audit.log": false, // tui/audit.rs:94
	"constitution.json": false, // config/user_constitution.rs:506
	"prompts/constitution.md": false, // tui/lib.rs:6544-6546
	workflows: false, // commands/user_commands.rs:110 — hardcoded ".codewhale" literal
	secrets: false, // secrets/src/lib.rs:833-841
	"keyring-locks": false, // secrets/src/lib.rs:344-352
	imports: false, // commands/groups/config/import_claude.rs:49-52
};

// Long-form design notes: docs/dev/migration-sources.md
/** Where a state path resolved to, and which of the two roots answered. */
export interface CodewhaleStateLocation {
	/** The path the product would use, whether or not anything is there. */
	path: string;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Which root the path resolves into: `codewhale`, `deepseek` or `absent`. */
	root: "codewhale" | "deepseek" | "absent";
	/** Whether the file is on disk right now. */
	exists: boolean;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Resolve one state path and say which root it came from. */
export function codewhaleStateLocation(
	home: CodewhaleHome,
	name: string,
	exists: (path: string) => boolean = existsSync,
): CodewhaleStateLocation {
	// An explicit `CODEWHALE_HOME` is an isolation boundary
	// (`crates/config/src/lib.rs:6105-6111`), so there is no legacy root to fall
	// back to and the answer is one of the first two states.
	if (home.explicit) {
		const path = join(home.root, name);
		const present = exists(path);
		return { path, root: present ? "codewhale" : "absent", exists: present };
	}
	const primary = join(home.root, name);
	if (exists(primary)) return { path: primary, root: "codewhale", exists: true };
	if (CODEWHALE_LEGACY_FALLBACK[name] === false) return { path: primary, root: "absent", exists: false };
	const legacy = join(home.legacyRoot, name);
	if (exists(legacy)) return { path: legacy, root: "deepseek", exists: true };
	return { path: primary, root: "absent", exists: false };
}

// Long-form design notes: docs/dev/migration-sources.md
/** One state path, under whichever root the product would read it from. */
export function codewhaleStatePath(
	home: CodewhaleHome,
	name: string,
	exists: (path: string) => boolean = existsSync,
): string {
	if (home.explicit) return join(home.root, name);
	const primary = join(home.root, name);
	if (CODEWHALE_LEGACY_FALLBACK[name] === false) return primary;
	if (exists(primary)) return primary;
	const legacy = join(home.legacyRoot, name);
	if (exists(legacy)) return legacy;
	return primary;
}

// ---------------------------------------------------------------------------
// The settings documents — five, not one
// ---------------------------------------------------------------------------

/** `config.toml` — the provider, model and mode document. */
export function codewhaleConfigPath(home: CodewhaleHome, exists?: (path: string) => boolean): string {
	return codewhaleStatePath(home, "config.toml", exists);
}

/** `permissions.toml` — the typed allow/ask/deny rules, a sibling of `config.toml`. */
export function codewhalePermissionsPath(home: CodewhaleHome, exists?: (path: string) => boolean): string {
	return codewhaleStatePath(home, "permissions.toml", exists);
}

// Long-form design notes: docs/dev/migration-sources.md
/** `settings.toml` — the TUI's own preferences, and a third candidate root nobody would guess. */
export const CODEWHALE_LEGACY_CONFIG_DIR_NAME = "deepseek";

/**
 * Where `settings.toml` is read from, in the product's own order.
 *
 * Every entry is returned rather than the winner, so the reader can say which
 * of the candidates answered and which were not there.
 */
export function codewhaleSettingsCandidates(
	home: CodewhaleHome,
	exists: (path: string) => boolean = existsSync,
): string[] {
	if (home.explicit) return [join(home.root, "settings.toml")];
	const primary = join(home.root, "settings.toml");
	if (exists(primary)) return [primary];
	const legacy = join(home.legacyRoot, "settings.toml");
	if (exists(legacy)) return [legacy];
	return [primary];
}

// Long-form design notes: docs/dev/migration-sources.md
/** `tui.toml` — the superseded preferences store, folded into `settings.toml` on load and then moved aside. */
export function codewhaleTuiPrefsPath(settingsPath: string): string {
	return settingsPath.replace(/settings\.toml$/, "tui.toml");
}

// ---------------------------------------------------------------------------
// The project (workspace) layer
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** `<workspace>/.codewhale/config.toml`, and the legacy sibling beside it. */
export function codewhaleProjectConfigPath(workspace: string, exists: (path: string) => boolean = existsSync): string {
	const primary = join(workspace, CODEWHALE_DEFAULT_DIR, "config.toml");
	if (exists(primary)) return primary;
	const legacy = join(workspace, CODEWHALE_LEGACY_DIR, "config.toml");
	return exists(legacy) ? legacy : primary;
}

// Long-form design notes: docs/dev/migration-sources.md
/** A project config that exists but cannot be used, kept distinct from absence. */
export function codewhaleProjectConfigReport(
	workspace: string,
	exists: (path: string) => boolean = existsSync,
): {
	path: string;
	present: boolean;
} {
	const path = codewhaleProjectConfigPath(workspace, exists);
	return { path, present: exists(path) };
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** `mcp.json` — the user's MCP servers, under whichever root holds it. */
export function codewhaleMcpPath(home: CodewhaleHome, exists?: (path: string) => boolean): string {
	return codewhaleStatePath(home, "mcp.json", exists);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The top-level key the servers live under, and the one it is also spelled. */
export const CODEWHALE_MCP_SERVERS_KEY = "servers";

/** The alias `mcpServers` deserializes from. See {@link CODEWHALE_MCP_SERVERS_KEY}. */
export const CODEWHALE_MCP_SERVERS_ALIAS = "mcpServers";

// Long-form design notes: docs/dev/migration-sources.md
/** The keys `McpServerConfig` recognises on one server entry. */
export const CODEWHALE_MCP_SERVER_KEYS: readonly string[] = [
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"allow_private_network",
	"transport",
	"connect_timeout",
	"execute_timeout",
	"read_timeout",
	"disabled",
	"enabled",
	"required",
	"enabled_tools",
	"disabled_tools",
	"headers",
	"env_headers",
	"env_http_headers",
	"bearer_token_env_var",
	"scopes",
	"oauth",
	"oauth_resource",
];

// Long-form design notes: docs/dev/migration-sources.md
/** Entry keys whose values are credentials by the product's own account. */
export const CODEWHALE_MCP_CREDENTIAL_KEYS: readonly string[] = ["headers", "env", "bearer_token_env_var"];

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The skill roots Codewhale owns, and the ones it does not. */
export function codewhaleSkillRoots(skillsDir: string): string[] {
	return [skillsDir];
}

// Long-form design notes: docs/dev/migration-sources.md
/** The shared `.agents` tree Codewhale reads, which this importer names rather than imports. */
export const CODEWHALE_SHARED_TREE: readonly string[] = [
	join(".agents", "skills"),
	join(".agents", "AGENTS.md"),
	join(".agents", "instructions.md"),
];

/** `<workspace>/.codewhale/skills` — the project scope, which no other source claims. */
export function codewhaleProjectSkillsDir(workspace: string): string {
	return join(workspace, CODEWHALE_DEFAULT_DIR, "skills");
}

/** `<workspace>/.agents/skills` — the shared project tree; imported because nothing else claims it. */
export function codewhaleProjectSharedSkillsDir(workspace: string): string {
	return join(workspace, ".agents", "skills");
}

/** `~/.deepseek/skills` — the pre-rename root for this name, named for the report. */
export function codewhaleLegacySkillsRoot(home: string): string {
	return join(home, CODEWHALE_LEGACY_DIR, "skills");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.codewhale/agents/<id>.toml` — Fleet personal agent profiles. */
export function codewhaleAgentsDir(root: string): string {
	return join(root, "agents");
}

/** `<workspace>/.codewhale/agents` — the project half. `fleet/profile.rs:20`. */
export function codewhaleProjectAgentsDir(workspace: string): string {
	return join(workspace, CODEWHALE_DEFAULT_DIR, "agents");
}

/** `~/.codewhale/fleets/<slug>.toml` — `FLEET_DIR = "fleets"` (`fleet/store.rs:76`), joined at `:597-598`. */
export function codewhaleFleetsDir(root: string): string {
	return join(root, "fleets");
}

/** `~/.codewhale/plugins/<name>/` — `plugins/discovery.rs:61-63`. */
export function codewhalePluginsDir(root: string): string {
	return join(root, "plugins");
}

// ---------------------------------------------------------------------------
// Instruction documents
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The user-global instruction documents, in the product's own precedence. */
export const CODEWHALE_GLOBAL_INSTRUCTIONS: readonly (readonly [string, string])[] = [
	[CODEWHALE_DEFAULT_DIR, "AGENTS.md"],
	[".agents", "AGENTS.md"],
	[CODEWHALE_LEGACY_DIR, "AGENTS.md"],
	[CODEWHALE_DEFAULT_DIR, "instructions.md"],
	[".agents", "instructions.md"],
	[CODEWHALE_LEGACY_DIR, "instructions.md"],
];

/** The deprecated global documents, which Codewhale reads only to warn. `project_context.rs:343,357-359`. */
export const CODEWHALE_GLOBAL_DOCUMENTS: readonly (readonly [string, string])[] = [
	[CODEWHALE_DEFAULT_DIR, "WHALE.md"],
	[".agents", "WHALE.md"],
	[CODEWHALE_LEGACY_DIR, "WHALE.md"],
];

// Long-form design notes: docs/dev/migration-sources.md
/** The project-scoped rule directories, `.md` files in filename order. */
export function codewhaleProjectRulesDir(workspace: string): string {
	return join(workspace, CODEWHALE_DEFAULT_DIR, "rules");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<workspace>/.codewhale/hooks.toml` — the project half of the hook config. */
export function codewhaleProjectHooksPath(workspace: string): string {
	return join(workspace, CODEWHALE_DEFAULT_DIR, "hooks.toml");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<workspace>/.codewhale/anchors.md`, with the legacy sibling. */
export function codewhaleProjectAnchorsPath(workspace: string, exists: (path: string) => boolean = existsSync): string {
	const primary = join(workspace, CODEWHALE_DEFAULT_DIR, "anchors.md");
	if (exists(primary)) return primary;
	return join(workspace, CODEWHALE_LEGACY_DIR, "anchors.md");
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Both roots a detection pass should look at, and not the pair a reader uses. */
export function codewhaleDefaultRoots(home: string, env: CodewhaleEnv = process.env): string[] {
	const resolved = resolveCodewhaleHome(home, env);
	// A home with no explicit override falls back per file, so both are real
	// candidates. One with an override never does.
	return resolved.explicit ? [resolved.root] : [resolved.root, resolved.legacyRoot];
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<sessions dir>` — one `<id>.json` per session. */
export function codewhaleSessionsDir(home: CodewhaleHome): string {
	return codewhaleStateLocation(home, "sessions").path;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `sessions` resolved with the root that answered, for the report. */
export function codewhaleSessionsLocation(
	home: CodewhaleHome,
	exists: (path: string) => boolean = existsSync,
): CodewhaleStateLocation {
	return codewhaleStateLocation(home, "sessions", exists);
}

/** `<sessions dir>/<id>.json`. */
export function codewhaleSessionPath(sessionsDir: string, id: string): string {
	return join(sessionsDir, `${id}.json`);
}

// ---------------------------------------------------------------------------
// Trees this source names and never opens
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The credential store: `~/.codewhale/secrets/secrets.json`. */
export function codewhaleSecretsPath(root: string): string {
	return join(root, "secrets", "secrets.json");
}

/**
 * `~/.codewhale/keyring-locks/*` — per-user lock files for the OS keyring.
 *
 * `crates/secrets/src/lib.rs:344-352`, with the comment "OS keyring authority is
 * per user, not per `CODEWHALE_HOME`/profile." **Named, never listed, never
 * opened.**
 */
export function codewhaleKeyringLocksDir(root: string): string {
	return join(root, "keyring-locks");
}

// Long-form design notes: docs/dev/migration-sources.md
/** Home entries Codewhale's own extension host refuses to expose to a subprocess. */
export const CODEWHALE_DENIED_HOME_ENTRIES: readonly string[] = [
	"secrets",
	"credentials",
	"tokens",
	"state",
	"state.db",
	"sessions",
	"session-archives",
	"session_index.jsonl",
	"tool_outputs",
	"composer_history.txt",
	"composer_history.jsonl",
	"remote-control",
	"integrations",
	"audit.log",
	"logs",
	"memory",
	"mcp.json",
	"mcp.json.bak",
	"config.toml.bak",
	"settings.toml",
];

// ---------------------------------------------------------------------------
// The competing importer
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Codewhale ships its own Claude Code importer, and this run saw it. */
export const CODEWHALE_IMPORT_CLAUDE = {
	command: "/import-claude",
	commandModule: "crates/tui/src/commands/groups/config/import_claude.rs",
	engineModule: "crates/tui/src/import_claude.rs",
	commandLines: 305,
	engineLines: 543,
	/** The one file `--apply` moves, and where it lands. */
	writesClaudeMdTo: "instructions.md",
} as const;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Whether a directory exists and holds something, as `sourceHasContent` reads it.
 *
 * The same test, spelled out rather than imported, because `migrate-types.ts`
 * owns that one and importing it here would close a cycle the source registry
 * exists to keep one-way.
 */
export function codewhaleTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** The config-file override, if one is set, and the environment it came from. */
export function codewhaleConfigOverride(
	home: CodewhaleHome,
	env: CodewhaleEnv = process.env,
): { path: string; from: string } | null {
	for (const name of [CODEWHALE_CONFIG_PATH_ENV, CODEWHALE_LEGACY_CONFIG_PATH_ENV]) {
		const raw = env[name];
		if (raw === undefined) continue;
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		const expanded = expandLeadingTilde(trimmed, home.root);
		if (expanded === null || !isAbsolute(expanded)) continue;
		return { path: expanded, from: name };
	}
	return null;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The config document, honouring a file-level override when one is set. */
export function codewhaleConfigPathWithOverride(home: CodewhaleHome, env: CodewhaleEnv = process.env): string {
	return codewhaleConfigOverride(home, env)?.path ?? codewhaleConfigPath(home);
}

/** `permissions.toml` beside the resolved `config.toml`, which is what the product reads. */
export function codewhalePermissionsPathWithOverride(home: CodewhaleHome, env: CodewhaleEnv = process.env): string {
	const overridden = codewhaleConfigOverride(home, env);
	if (overridden !== null) return join(resolve(overridden.path, ".."), "permissions.toml");
	return codewhalePermissionsPath(home);
}

/** `settings.toml` beside the resolved `config.toml` when one is overridden. */
export function codewhaleSettingsPathWithOverride(home: CodewhaleHome, env: CodewhaleEnv = process.env): string {
	const overridden = codewhaleConfigOverride(home, env);
	if (overridden !== null) return join(resolve(overridden.path, ".."), "settings.toml");
	return codewhaleSettingsCandidates(home)[0];
}
