// Qoder's user state: the configuration home, the name check and the
// settings layers, with the bundle literals that attest each claim.
// Long-form design notes: docs/dev/migration-sources.md

import { readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Directory-name validation
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The global build's configuration directory name. */
export const QODER_DEFAULT_DIR = ".qoder";

// Long-form design notes: docs/dev/migration-sources.md
/** The China build's configuration directory name. */
export const QODER_CN_DEFAULT_DIR = ".qoder-cn";

// Long-form design notes: docs/dev/migration-sources.md
/** The per-project directory name, the same for both builds. */
export const QODER_PROJECT_DIR = ".qoder";

/** Longest directory name the product accepts, in code points. */
export const QODER_DIR_NAME_MAX = 64;

// Long-form design notes: docs/dev/migration-sources.md
/** The characters a configuration directory name may be made of. */
export const QODER_DIR_NAME_PATTERN = /^[\p{L}\p{N}\p{M}._ -]+$/u;

// Long-form design notes: docs/dev/migration-sources.md
/** Windows reserved device names. */
export const QODER_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

// Long-form design notes: docs/dev/migration-sources.md
/** Directory names the product refuses outright. */
export const QODER_RESERVED_DIR_NAMES: ReadonlySet<string> = new Set([
	".git",
	".svn",
	".hg",
	".vscode",
	".idea",
	".husky",
	".github",
	"node_modules",
	"bower_components",
]);

// Long-form design notes: docs/dev/migration-sources.md
/** Why a name is not usable, or `null` when it is. */
export type QoderDirNameRejection =
	| "empty"
	| "too-long"
	| "leading-or-trailing-space"
	| "trailing-dot"
	| "characters"
	| "device-name"
	| "reserved-name";

// Long-form design notes: docs/dev/migration-sources.md
/** Normalize and validate a configuration directory name, or say why not. */
export function validateQoderDirName(name: string): QoderDirNameRejection | null {
	if (name === "") return "empty";
	const normalized = name.normalize("NFC");
	if (Array.from(normalized).length > QODER_DIR_NAME_MAX) return "too-long";
	if (normalized.startsWith(" ") || normalized.endsWith(" ")) return "leading-or-trailing-space";
	if (normalized.endsWith(".") || normalized === "." || normalized === "..") return "trailing-dot";
	if (!QODER_DIR_NAME_PATTERN.test(normalized)) return "characters";
	if (QODER_DEVICE_NAME_PATTERN.test(normalized)) return "device-name";
	if (QODER_RESERVED_DIR_NAMES.has(normalized.toLowerCase())) return "reserved-name";
	return null;
}

/** Whether {@link validateQoderDirName} accepts this name. */
export function isValidQoderDirName(name: string): boolean {
	return validateQoderDirName(name) === null;
}

/** The sentence the report prints for each rejection, in the product's own terms. */
export const QODER_DIR_NAME_REJECTIONS: Record<QoderDirNameRejection, string> = {
	empty: "it is empty",
	"too-long": `it is longer than ${QODER_DIR_NAME_MAX} characters`,
	"leading-or-trailing-space": "it starts or ends with a space",
	"trailing-dot": "it ends with a dot, or is `.` or `..`",
	characters: "it has a character outside letters, numbers, combining marks, `.`, `_`, space and `-`",
	"device-name": "it is a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)",
	"reserved-name": `it is one of ${[...QODER_RESERVED_DIR_NAMES].join(", ")}`,
};

// ---------------------------------------------------------------------------
// The configuration home
// ---------------------------------------------------------------------------

/** The environment block the resolution reads; injectable so tests need no `process.env`. */
export type QoderEnv = Record<string, string | undefined>;

// Long-form design notes: docs/dev/migration-sources.md
/** The configuration home: `$QODER_CONFIG_DIR` when it names one, else `<cli home or home>/<validated directory name>`. */
export function qoderConfigDir(home: string, env: QoderEnv = process.env): string {
	const override = env.QODER_CONFIG_DIR?.trim();
	if (override !== undefined && override !== "") return override;
	const parent = env.QODER_CLI_HOME?.trim();
	const name = qoderDirName(env);
	return join(parent !== undefined && parent !== "" ? parent : home, name);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The directory name to put under the CLI home, from `QODER_CONFIG_DIR_NAME` when it validates, else the build's own default. */
export function qoderDirName(env: QoderEnv = process.env): string {
	const configured = env.QODER_CONFIG_DIR_NAME;
	if (configured === undefined || configured === "") return QODER_DEFAULT_DIR;
	return isValidQoderDirName(configured) ? configured.normalize("NFC") : QODER_DEFAULT_DIR;
}

/** Why `QODER_CONFIG_DIR_NAME` was refused, or `null` when it was not set or was fine. */
export function qoderDirNameRejection(env: QoderEnv = process.env): QoderDirNameRejection | null {
	const configured = env.QODER_CONFIG_DIR_NAME;
	if (configured === undefined || configured === "") return null;
	return validateQoderDirName(configured);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The configuration home this importer will not read: the other build's. */
export function qoderOtherConfigDir(home: string, read: string): string {
	return join(home, read.endsWith(QODER_CN_DEFAULT_DIR) ? QODER_DEFAULT_DIR : QODER_CN_DEFAULT_DIR);
}

/** Whether a directory exists and holds something, as `sourceHasContent` reads it. */
export function qoderTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Paths under the home
// ---------------------------------------------------------------------------

/** `<home>/settings.json` — the user layer of the one settings document both builds read. */
export function qoderSettingsPath(configDir: string): string {
	return join(configDir, "settings.json");
}

// ---------------------------------------------------------------------------
// The three settings layers
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The layers Qoder loads settings from, in the order it applies them. */
export const QODER_SETTINGS_SOURCES = ["user", "project", "local"] as const;

/** Which of the three files a settings key came from. */
export type QoderSettingsSource = (typeof QODER_SETTINGS_SOURCES)[number];

// Long-form design notes: docs/dev/migration-sources.md
/** The directory name Qoder uses inside a project's own directory; it follows `QODER_CONFIG_DIR_NAME` rather than the constant. */
export function qoderProjectDirName(env: QoderEnv = process.env): string {
	return qoderDirName(env);
}

/** `<cwd>/<project dir name>/settings.json` — the project layer. */
export function qoderProjectSettingsPath(cwd: string, env: QoderEnv = process.env): string {
	return join(cwd, qoderProjectDirName(env), "settings.json");
}

/** `<cwd>/<project dir name>/settings.local.json` — the local layer, never committed. */
export function qoderLocalSettingsPath(cwd: string, env: QoderEnv = process.env): string {
	return join(cwd, qoderProjectDirName(env), "settings.local.json");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<cwd>/.qoder/.mcp.json` — the project's own MCP file, named and never read. */
export function qoderProjectMcpPath(cwd: string): string {
	return join(cwd, QODER_PROJECT_DIR, ".mcp.json");
}

// Long-form design notes: docs/dev/migration-sources.md
/** Top-level keys that are merged one level deep rather than all the way, verbatim from `uc` in the SDK. */
export const QODER_MERGE_SHALLOW: readonly string[] = [
	"mcpServers",
	"providers",
	"skillOverrides",
	"enabledPlugins",
	"extraKnownMarketplaces",
	"pluginConfigs",
];

// Long-form design notes: docs/dev/migration-sources.md
/** Dotted paths whose arrays are unioned rather than replaced, verbatim from `cc`. */
export const QODER_MERGE_UNION: readonly string[] = [
	"context.fileFiltering.customIgnoreFilePaths",
	"tools.exclude",
	"mcp.enabledProjectMcpServers",
	"mcp.disabledProjectMcpServers",
	"security.approvedExternalImportProjects",
	"advanced.excludedEnvVars",
	"extensions.disabled",
	"extensions.workspacesWithMigrationNudge",
	"plugins.enabled",
	"plugins.disabled",
	"skills.disabled",
	"blockedMarketplaces",
	"allowedHttpHookUrls",
];

// Long-form design notes: docs/dev/migration-sources.md
/** Key names the merge drops wherever they appear, verbatim from `Cn`. */
export const QODER_PROTOTYPE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** `<home>/projects` — one directory per working directory that has been used. */
export function qoderProjectsDir(configDir: string): string {
	return join(configDir, "projects");
}

/** `<home>/projects/<slug>` — one project's sessions and memory. */
export function qoderProjectDir(configDir: string, cwd: string): string {
	return join(qoderProjectsDir(configDir), qoderProjectSlug(cwd));
}

// Long-form design notes: docs/dev/migration-sources.md
/** One session's transcript: `<home>/projects/<slug>/<sessionId>.jsonl`. */
export function qoderSessionPath(configDir: string, cwd: string, sessionId: string): string {
	return join(qoderProjectDir(configDir, cwd), `${sessionId}.jsonl`);
}

/** `<home>/memory` — the machine-wide memory directory. */
export function qoderMemoryDir(configDir: string): string {
	return join(configDir, "memory");
}

/**
 * `<home>/projects/<slug>/memory` — the per-project memory directory.
 *
 * `join(t, "projects", Bfe(cwd), "memory")`, verbatim in shape. The slug comes
 * from {@link qoderProjectSlug} rather than a slug of its own so that the two
 * directories cannot disagree about which project they are for.
 */
export function qoderProjectMemoryDir(configDir: string, cwd: string): string {
	return join(qoderProjectDir(configDir, cwd), "memory");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<configDir>/AGENTS.md` — Qoder's standing instruction document; the name is attested, this location is a choice. */
export function qoderAgentsMdPath(configDir: string): string {
	return join(configDir, "AGENTS.md");
}

// Long-form design notes: docs/dev/migration-sources.md
/** The pattern a memory entry file matches, verbatim: `/^\d{4}-\d{2}-\d{2}\.md$/u`. */
export const QODER_MEMORY_ENTRY_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/u;

// Long-form design notes: docs/dev/migration-sources.md
/** The name of the index that sits inside the memory directory, beside the dated entries; the name test is case-insensitive. */
export const QODER_MEMORY_INDEX_NAME = "MEMORY.md";

/** The memory documents to read from the machine-wide directory, in this order. */
export function qoderMemoryIndexPaths(configDir: string): string[] {
	return [join(qoderMemoryDir(configDir), QODER_MEMORY_INDEX_NAME)];
}

// Long-form design notes: docs/dev/migration-sources.md
/** Qoder's own hook event names, verbatim from the SDK: 18 events in the SDK's order, seven of which this build also runs. */
export const QODER_HOOK_EVENTS: readonly string[] = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"UserPromptSubmit",
	"SessionStart",
	"SessionEnd",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"PostCompact",
	"CwdChanged",
	"InstructionsLoaded",
	"FileChanged",
	"PermissionRequest",
	"PermissionDenied",
	"WorktreeCreate",
	"WorktreeRemove",
];

/** Longest a project directory name may be before the hash suffix is added. */
export const QODER_PROJECT_SLUG_MAX = 200;

// Long-form design notes: docs/dev/migration-sources.md
/** `djb2` with XOR, exactly as the product spells it, returned signed as the callers expect. */
function qoderSlugHash(value: string): number {
	let hash = 5381;
	for (let i = 0; i < value.length; i += 1) hash = (hash * 33) ^ value.charCodeAt(i);
	return hash;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The directory name the product gives a working directory, without the `u` flag; the transcripts and memory directory are under this one. */
export function qoderProjectSlug(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	return slug.length <= QODER_PROJECT_SLUG_MAX
		? slug
		: `${slug.slice(0, QODER_PROJECT_SLUG_MAX)}-${Math.abs(qoderSlugHash(cwd)).toString(36)}`;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The same transformation with the `u` flag, which the product uses for one caller only. */
export function qoderProjectSlugUnicode(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]/gu, "-");
	return slug.length <= QODER_PROJECT_SLUG_MAX
		? slug
		: `${slug.slice(0, QODER_PROJECT_SLUG_MAX)}-${Math.abs(qoderSlugHash(cwd)).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The two directories Qoder reads user skills from, its own first; the same folder name in both is one skill to Qoder and the reason `qoder-read.ts` de-duplicates. */
export function qoderSkillsDirs(configDir: string, home: string): string[] {
	return [join(configDir, "skills"), join(home, ".agents", "skills")];
}

// ---------------------------------------------------------------------------
// Paths this source names and does not read
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The desktop application's data directory name, from the packaged manifest. */
export const QODER_DESKTOP_DATA_DIR = "com.qoder.app.stable";

// Long-form design notes: docs/dev/migration-sources.md
/** The desktop application's SQLite store, existence-checked only; nothing in this importer opens it. */
export function qoderDesktopStorePath(appData: string, dataDirectoryName: string = QODER_DESKTOP_DATA_DIR): string {
	return join(appData, dataDirectoryName, "main.sqlite");
}

// Long-form design notes: docs/dev/migration-sources.md
/** Tables inside that store whose names are worth a report line and whose values this importer must never read. */
export const QODER_CREDENTIAL_TABLES: readonly string[] = [
	"byok_model_credentials",
	"mcp_oauth_credentials",
	"app_settings",
	"account_profiles",
];

/**
 * Tables that hold derived state rather than the user's conversations.
 *
 * `chat_session_search_segments` and its FTS shadow are a search index over the
 * message rows, and the turn-payload buffer is a worker queue. All three are
 * named here so a report can say they were passed over; none is opened.
 */
export const QODER_DERIVED_TABLES: readonly string[] = [
	"chat_session_search_segments",
	"chat_session_search_fts",
	"chat-session-turn-payload-buffer.sqlite",
];
