// Alma's user state: the four independent roots it writes to, every path
// `alma-read.ts` opens, and the trees this source names but never reads.
// Long-form design notes: docs/dev/migration-sources.md

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The environment block a root is resolved from; injectable so tests need no `process.env`. */
export type AlmaEnv = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// The four roots
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.alma`, the dot-prefixed cache and bin root. Nothing under it is configuration, so it is a detection root only. */
export const ALMA_DEFAULT_DIR = ".alma";

/**
 * `~/alma`, **without** the leading dot.
 *
 * One occurrence of `"alma","chrome-extension"` in the whole bundle, inside
 * `getStablePath()`. A sibling of `~/.alma` rather than a child, which is why
 * this is a constant and not a derivation of {@link ALMA_DEFAULT_DIR}.
 */
export const ALMA_PLAIN_DIR = "alma";

// Long-form design notes: docs/dev/migration-sources.md
/** The Electron `userData` directory's own name. The basename is never spelled in the bundle, so this is the one claim not taken from a literal. */
export const ALMA_USER_DATA_DIR = "alma";

/** `~/.config/alma` — the configuration root, and the only one this importer reads files from. */
export function almaConfigDir(home: string): string {
	return join(home, ".config", "alma");
}

/** `~/.alma` — binaries, npm cache, activity records, cache. Named for detection. */
export function almaDotDir(home: string): string {
	return join(home, ALMA_DEFAULT_DIR);
}

/** `~/alma` — the chrome-extension stable path and `worktrees/`. Named for detection. */
export function almaPlainDir(home: string): string {
	return join(home, ALMA_PLAIN_DIR);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The platform application-data directory from `APPDATA`, or `undefined` where there is none. No `process.platform` test, so a fixture works on every CI job. */
export function almaAppData(env: AlmaEnv = process.env): string | undefined {
	const value = env.APPDATA;
	return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * `<appData>/alma` — the Electron `userData` root — or `null` on a platform with
 * no app-data path this importer will guess at.
 */
export function almaUserDataDir(appData: string | undefined, name: string = ALMA_USER_DATA_DIR): string | null {
	return appData === undefined ? null : join(appData, name);
}

/** All four roots, resolved. `userData` is `null` where the platform has no such path. */
export interface AlmaRoots {
	configDir: string;
	dotDir: string;
	plainDir: string;
	userData: string | null;
}

export function almaRoots(home: string, env: AlmaEnv = process.env): AlmaRoots {
	return {
		configDir: almaConfigDir(home),
		dotDir: almaDotDir(home),
		plainDir: almaPlainDir(home),
		userData: almaUserDataDir(almaAppData(env), ALMA_USER_DATA_DIR),
	};
}

/** Whether a directory exists and holds something, as detection reads it. */
export function almaTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** The roots whose being non-empty means "Alma is installed here". All four are needed because each has a state where it is the only marker. */
export function almaDetectionRoots(home: string, env: AlmaEnv = process.env): string[] {
	const roots = almaRoots(home, env);
	return roots.userData === null
		? [roots.configDir, roots.dotDir, roots.plainDir]
		: [roots.configDir, roots.userData, roots.dotDir, roots.plainDir];
}

// ---------------------------------------------------------------------------
// Files under the configuration root
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.config/alma/mcp.json`, the MCP configuration, quoted whole from the bundle. */
export function almaMcpPath(configDir: string): string {
	return join(configDir, "mcp.json");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.config/alma/hooks.json`. The name is hoisted into a constant in the bundle, so a search for the assembled literal finds nothing. */
export function almaHooksPath(configDir: string): string {
	return join(configDir, "hooks.json");
}

/** `~/.config/alma/skills` — the personal skill root, Alma's own. */
export function almaSkillsDir(configDir: string): string {
	return join(configDir, "skills");
}

/** `~/.config/alma/plugins` — installed plugins, each with its own `plugin.json`. */
export function almaPluginsDir(configDir: string): string {
	return join(configDir, "plugins");
}

/** `~/.config/alma/memory` — the long-term memory directory beside `MEMORY.md`. */
export function almaMemoryDir(configDir: string): string {
	return join(configDir, "memory");
}

/** `~/.config/alma/groups` — chat-group state, `telegram-state.json` and so on. */
export function almaGroupDir(configDir: string): string {
	return join(configDir, "groups");
}

/** `~/.config/alma/cron` — the scheduled-job store. */
export function almaCronDir(configDir: string): string {
	return join(configDir, "cron");
}

/** `~/alma/worktrees` — `getWorktreeBaseDir(){return Y.join(D.homedir(),"alma","worktrees")}`. */
export function almaWorktreesDir(home: string): string {
	return join(home, ALMA_PLAIN_DIR, "worktrees");
}

/** `~/alma/chrome-extension` — the browser extension's stable copy. */
export function almaChromeExtensionDir(home: string): string {
	return join(home, ALMA_PLAIN_DIR, "chrome-extension");
}

/** `<userData>/chat_threads.db` — the only real database in the product. */
export function almaDbPath(userData: string): string {
	return join(userData, "chat_threads.db");
}

/** `<userData>/plugin-storage/<plugin id>` — a plugin's own state directory. */
export function almaPluginStorageDir(userData: string, pluginId: string): string {
	return join(userData, "plugin-storage", pluginId);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The five identity documents in `~/.config/alma/`, in load order. None is an instruction document; only `MEMORY.md` has a destination here. */
export const ALMA_IDENTITY_DOCS: readonly string[] = ["SOUL.md", "USER.md", "MEMORY.md", "SECURITY.md", "HEARTBEAT.md"];

/** One identity document's path in the configuration root. */
export function almaIdentityDocPath(configDir: string, name: string): string {
	return join(configDir, name);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Alma's six skill roots in load order, split into own, shared and foreign trees, plus the seventh bundled root outside the home. */
export function almaOwnSkillRoots(configDir: string, workspacePath?: string | null): string[] {
	const roots = [almaSkillsDir(configDir)];
	if (workspacePath !== undefined && workspacePath !== null) roots.push(join(workspacePath, ".alma", "skills"));
	return roots;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The shared agent home Alma also reads, and this importer does not. `KIMI_SHARED_TREE` in `kimi-read.ts` is the precedent. */
export function almaSharedSkillRoots(home: string, workspacePath?: string | null): string[] {
	const roots = [join(home, ".agents", "skills")];
	if (workspacePath !== undefined && workspacePath !== null) roots.push(join(workspacePath, ".agents", "skills"));
	return roots;
}

/** Other products' homes Alma reads skills out of, named and never imported. */
export function almaForeignSkillRoots(home: string): string[] {
	return [join(home, ".claude", "skills"), join(home, ".codex", "skills"), join(home, ".claude", "plugins")];
}

// Long-form design notes: docs/dev/migration-sources.md
/** The order Alma resolves a skill name in, first match wins. A shadowed skill is invisible, so `RawAlma` carries the collision list. */
export const ALMA_SKILL_ROOT_PRECEDENCE: readonly string[] = [
	"~/.config/alma/skills",
	"~/.claude/skills",
	"~/.codex/skills",
	"~/.agents/skills",
	"~/.claude/plugins",
	"<workspace>/.agents/skills",
	"<workspace>/.alma/skills",
];

// Long-form design notes: docs/dev/migration-sources.md
/** How many skills Alma ships in `resources/bundled-skills/`. Counted, not quoted: 40 directories in the 0.4.160 win-x64 package. */
export const ALMA_BUNDLED_SKILL_COUNT = 40;

// Long-form design notes: docs/dev/migration-sources.md
/** A skill is a directory holding a `SKILL.md` whose frontmatter carries `name` and `description`. */

// Long-form design notes: docs/dev/migration-sources.md
/** The hook events Alma has, verbatim: `tool.willExecute`, `tool.didExecute`, `chat.message.willSend`, `app.willQuit`. */
export const ALMA_HOOK_EVENTS: readonly string[] = [
	"tool.willExecute",
	"tool.didExecute",
	"chat.message.willSend",
	"app.willQuit",
];

// Long-form design notes: docs/dev/migration-sources.md
/** Alma's four events mapped to this build's. Three are a rename; `app.willQuit` has no counterpart and is not `SessionEnd`. */
export const ALMA_HOOK_EVENT_MAP: Readonly<Record<string, string | undefined>> = {
	"tool.willExecute": "PreToolUse",
	"tool.didExecute": "PostToolUse",
	"chat.message.willSend": "UserPromptSubmit",
	"app.willQuit": undefined,
};

// Long-form design notes: docs/dev/migration-sources.md
/** What an Alma hook's `matcher` is tested against. A content matcher has no analogue here and is dropped and counted. */
export const ALMA_HOOK_MATCHER_TARGETS: Readonly<Record<string, "tool-name" | "content" | "nothing">> = {
	"tool.willExecute": "tool-name",
	"tool.didExecute": "tool-name",
	"chat.message.willSend": "content",
	"app.willQuit": "nothing",
};

// Long-form design notes: docs/dev/migration-sources.md
/** Alma's default hook timeout, 10_000 ms. The unit is already this build's, so no conversion applies; the 600,000 ms clamp still does. */
export const ALMA_HOOK_DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Settings are a row, not a file: `app_settings` with one row whose id is `'default'`. */
export const ALMA_SETTINGS_HANDLE = "default";

// Long-form design notes: docs/dev/migration-sources.md
/** The keys this importer reads out of `settings_data`, and nothing else. A whitelist rather than a scrub, drawn from the app's shipped `AppSettings` interface. */
export const ALMA_SETTINGS_KEYS_READ: readonly string[] = [
	"general",
	"chat",
	"security",
	"agents",
	"ui",
	"network",
	"data",
	"memory",
	"advanced",
	"whisper",
	"webSearch",
	"keybindings",
	"terminal",
	"themeConfig",
	"tools",
	"onboarding",
	"toolModel",
	"workspace",
];

// Long-form design notes: docs/dev/migration-sources.md
/** The extra top-level keys Alma's blob carries beyond the shipped interface. This list is the credential boundary, written down. */
export const ALMA_SETTINGS_NOT_READ: readonly string[] = [
	"chromeRelayAuthToken",
	"telegram",
	"discord",
	"feishu",
	"weixin",
	"heartbeat",
	"crystal",
	"threadBrief",
	"mobileRelay",
	"mobile",
	"team",
	"plugin-provider-models:*",
	"tts",
];

// Long-form design notes: docs/dev/migration-sources.md
/** Whether a key the reader passed over is one of `ALMA_SETTINGS_NOT_READ`, honouring the trailing `*` as a prefix. */
export function isAlmaCredentialKey(key: string): boolean {
	return ALMA_SETTINGS_NOT_READ.some((entry) =>
		entry.endsWith("*") ? key.startsWith(entry.slice(0, -1)) : entry === key,
	);
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The link from a thread to the directory it was had in, added after the fact with `ON DELETE SET NULL`, so an orphaned thread has no path. */
export const ALMA_THREAD_WORKSPACE_COLUMN = "workspace_id";

// Long-form design notes: docs/dev/migration-sources.md
/** Threads whose title starts with this are never archived. The plain-file archive has three traps, all named in the report. */
export const ALMA_CRON_TITLE_PREFIX = "⏰ Cron:";

/** The YAML frontmatter keys the archive writes, verbatim and in this order. */
export const ALMA_ARCHIVE_FRONT_KEYS: readonly string[] = [
	"threadId",
	"title",
	"createdAt",
	"updatedAt",
	"model",
	"messageCount",
];

/** Where a thread's markdown archive lives, given the archiver's one workspace. */
export function almaThreadsArchiveDir(workspacePath: string): string {
	return join(workspacePath, "threads");
}

// ---------------------------------------------------------------------------
// Credential stores
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The stores whose names a report may print and whose values this importer must never read, with the two behaviours that make the app's own environment a credential surface. */
export const ALMA_CREDENTIAL_TABLES: readonly string[] = [
	"providers.api_key",
	"secrets.encrypted_value",
	"mcp_oauth_tokens.access_token",
	"mcp_oauth_tokens.refresh_token",
	"mcp_oauth_tokens.client_secret",
	"mcp_oauth_tokens.code_verifier",
	"email_accounts.password",
];

/** Credential files in the `userData` root, named and never opened. */
export const ALMA_CREDENTIAL_FILES: readonly string[] = [
	".claude_subscription_token",
	".copilot_accounts/<id>.token",
	"weixin-state/credentials.json",
	"plugin-storage/<id>/secrets.json",
	"<userData>/../alma/chrome-extension/config.json",
];

// Long-form design notes: docs/dev/migration-sources.md
/** A second MCP store exists and is dormant: the configuration routes never write it, but the built-in export reads it. */
export const ALMA_DORMANT_MCP_TABLE = "mcp_servers";

// Long-form design notes: docs/dev/migration-sources.md
/** Alma's built-in export and import, and the three reasons the export is not the same as this migration. */
export const ALMA_EXPORT_FILES: readonly string[] = [
	"providers.json",
	"threads.json",
	"promptApps.json",
	"prompts.json",
	"workspaces.json",
	"mcpServers.json",
	"customThemes.json",
	"memories.json",
	"settings.json",
	"manifest.json",
];
