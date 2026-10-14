// Command Code's user directory: the one root it writes to, every path
// `command-code-read.ts` opens, and the trees this source names but never reads.
// Long-form design notes: docs/dev/migration-sources.md

import { readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The root
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.commandcode`. The bundle spells the name once and builds every path from it. */
export const COMMAND_CODE_DEFAULT_DIR = ".commandcode";

/**
 * `~/.commandcode`. The CLI resolves its home as `env().HOME ?? env().USERPROFILE`
 * and appends the directory name; no `COMMANDCODE_*` variable moves it, so the
 * root is a function of the home directory alone.
 */
export function commandCodeRoot(home: string): string {
	return join(home, COMMAND_CODE_DEFAULT_DIR);
}

/** Whether a directory exists and holds something, as detection reads it. */
export function commandCodeTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Files under the root
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.commandcode/settings.json` — the user configuration layer, first in the CLI's own `configLayerPaths`. */
export function commandCodeSettingsPath(root: string): string {
	return join(root, "settings.json");
}

// Long-form design notes: docs/dev/migration-sources.md
/** The release-channel configuration file. The CLI picks its legacy config by channel; a released build reads `config.json`. */
export const COMMAND_CODE_LEGACY_CONFIG_FILE = "config.json";

// Long-form design notes: docs/dev/migration-sources.md
/** The other channels' configuration files (`config.local.json`, `config.staging.json`). Named so the report can say they are there; never read, because a released build never reads them either. */
export const COMMAND_CODE_OTHER_CHANNEL_CONFIG_FILES: readonly string[] = ["config.local.json", "config.staging.json"];

/** `~/.commandcode/config.json` — the legacy configuration file. */
export function commandCodeLegacyConfigPath(root: string): string {
	return join(root, COMMAND_CODE_LEGACY_CONFIG_FILE);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The keys the legacy file's reader passes on, verbatim from `pickLegacyConfigFields`. Of these, only `model` and `theme` have a destination here. */
export const COMMAND_CODE_LEGACY_CONFIG_KEYS: readonly string[] = [
	"model",
	"modelProvider",
	"theme",
	"featureModels",
	"byokFeatureTasks",
	"reasoningEffort",
	"compactMode",
	"tasteLearning",
];

// Long-form design notes: docs/dev/migration-sources.md
/**
 * `~/.commandcode/mcp.json` then `~/.commandcode/.mcp.json` — the user's two MCP
 * files, in the CLI's load order, so the second wins on a name clash. The other
 * scopes it reads (the project's `.mcp.json` and
 * `~/.commandcode/projects/<slug>/mcp.json`) are named in the report, not read:
 * they belong to one project, and this importer never reads a project.
 */
export function commandCodeMcpPaths(root: string): string[] {
	return [join(root, "mcp.json"), join(root, ".mcp.json")];
}

/** `~/.commandcode/providers.json` — the BYOK provider registry. */
export function commandCodeProvidersPath(root: string): string {
	return join(root, "providers.json");
}

/** `~/.commandcode/history.jsonl` — the ↑ recall list, named by the bundle's `defaultHistoryPath`. */
export function commandCodeHistoryPath(root: string): string {
	return join(root, "history.jsonl");
}

/**
 * `~/.commandcode/projects` — one directory per working directory, each named
 * by a slug of the cwd it belongs to and holding that project's session files.
 */
export function commandCodeProjectsDir(root: string): string {
	return join(root, "projects");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.commandcode/file-history/<sessionId>` — per-session file checkpoints, the material a rewind replays. Named, never read: the importer's business is configuration and conversation, not undo state. */
export function commandCodeFileHistoryDir(root: string): string {
	return join(root, "file-history");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.commandcode/sessions` — where the CLI writes its hook audit logs (`hooks-audit-<id>.jsonl`). Named, never read: nothing in it is user configuration or conversation. */
export function commandCodeSessionsDir(root: string): string {
	return join(root, "sessions");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.commandcode/trusted-hooks.json` — fingerprints of approved project hooks. Named, never read: trust state for hooks this importer does not carry. */
export function commandCodeTrustedHooksPath(root: string): string {
	return join(root, "trusted-hooks.json");
}

/** `~/.commandcode/AGENTS.md` — the personal instruction file. */
export function commandCodeMemoryPath(root: string): string {
	return join(root, "AGENTS.md");
}

/** `~/.commandcode/skills` — the personal skill root: the CLI calls it `".commandcode/skills"` and resolves it against the home, not a project. */
export function commandCodeSkillsDir(root: string): string {
	return join(root, "skills");
}

/** `~/.commandcode/agents` — personal sub-agent definitions, one `<name>.md` per agent. */
export function commandCodeAgentsDir(root: string): string {
	return join(root, "agents");
}

/** `~/.commandcode/commands` — personal slash-command files, `<name>.md`, loaded recursively alongside the project's own. */
export function commandCodeCommandsDir(root: string): string {
	return join(root, "commands");
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * The stores whose names a report may print and whose values this importer must
 * never read. `auth.json` and its other-channel variants hold the subscription
 * tokens, `credentials.json` the OAuth results, and `mcp-tokens.json` the MCP
 * token vault. Their permission bits are the only fact a scan may use.
 */
export const COMMAND_CODE_CREDENTIAL_FILES: readonly string[] = [
	"auth.json",
	"auth.local.json",
	"auth.staging.json",
	"credentials.json",
	"mcp-tokens.json",
];

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The transcript format's version. The CLI's loader reads headers with `version === 3` and no others. */
export const COMMAND_CODE_SESSION_VERSION = 3;

/** `<id>.meta.json` — the sidecar beside `<id>.jsonl` that holds the session's title and model. */
export const COMMAND_CODE_META_SUFFIX = ".meta.json";

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Whether a file name is a session transcript, verbatim from the CLI's own
 * `isSessionTranscriptFileName`: the sidecars (`.checkpoints.jsonl`,
 * `.prompts.jsonl`, `.v2.bak`) share the `.jsonl` tail and are excluded by
 * name. What the CLI lists as a session, this importer lists as one.
 */
export function isCommandCodeTranscriptName(name: string): boolean {
	return (
		name.endsWith(".jsonl") &&
		!name.includes(".checkpoints.") &&
		!name.includes(".prompts.") &&
		!name.includes(".v2.bak")
	);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The nine entry types a version 3 session may carry, verbatim from the loader's `pv` set. Four of them hold text a transcript can use; the rest are bookkeeping. */
export const COMMAND_CODE_ENTRY_TYPES: readonly string[] = [
	"message",
	"model_change",
	"effort_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
];

// ---------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The five canonical permission modes, verbatim from the bundle's canonical set. */
export const COMMAND_CODE_PERMISSION_MODES: readonly string[] = [
	"default",
	"auto-accept",
	"plan",
	"bypass",
	"dont-ask",
];

// Long-form design notes: docs/dev/migration-sources.md
/** The spellings `normalizePermissionMode` folds onto the canonical five, verbatim. */
export const COMMAND_CODE_PERMISSION_MODE_ALIASES: Readonly<Record<string, string>> = {
	standard: "default",
	manual: "default",
	acceptedits: "auto-accept",
	"accept-edits": "auto-accept",
	dontask: "dont-ask",
	yolo: "bypass",
	bypasspermissions: "bypass",
	"bypass-permissions": "bypass",
};

/** `normalizePermissionMode`, as the CLI spells it: trim, lower-case, canonical or alias, else nothing. */
export function normalizeCommandCodePermissionMode(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "") return undefined;
	if (COMMAND_CODE_PERMISSION_MODES.includes(trimmed)) return trimmed;
	return COMMAND_CODE_PERMISSION_MODE_ALIASES[trimmed];
}

/**
 * `permissions.disableBypass`: `true` or `"disable"`, and nothing else.
 * When it is set, the CLI refuses to enter bypass mode and falls back to the
 * default mode — so a settings file that says `bypass` here does not mean
 * bypass at runtime, and the reader follows the same rule.
 */
export function commandCodeBypassDisabled(value: unknown): boolean {
	return value === true || value === "disable";
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The four hook events the CLI recognizes, verbatim. A key outside this list is a warning in the CLI and noise here. */
export const COMMAND_CODE_HOOK_EVENTS: readonly string[] = ["PreToolUse", "PostToolUse", "Stop", "SessionStart"];

// Long-form design notes: docs/dev/migration-sources.md
/** How a hook group names "every tool", verbatim from the loader's match-all set. The CLI compiles both to an empty regex. */
export const COMMAND_CODE_HOOK_MATCH_ALL: readonly string[] = ["*", "**"];

/** The matcher's length cap, verbatim; longer matchers are skipped with a warning rather than compiled. */
export const COMMAND_CODE_HOOK_MATCHER_MAX = 200;

// Long-form design notes: docs/dev/migration-sources.md
/** The CLI's own default hook timeout, 30,000 ms, from `Math.min(o.timeout ? 1e3 * o.timeout : XS, 1e3 * ZS)` with `XS = 3e4`. This build's default is 60,000 ms, so a hook that names no timeout runs longer once imported. */
export const COMMAND_CODE_HOOK_DEFAULT_TIMEOUT_MS = 30_000;

/** The heaviest timeout a hook may name, 600 seconds, `ZS = 600` — the same ceiling this build clamps to. */
export const COMMAND_CODE_HOOK_MAX_TIMEOUT_MS = 600_000;

// Long-form design notes: docs/dev/migration-sources.md
/**
 * What a matcher is tested against, translated. The CLI tests its matcher
 * regex (case-insensitive) against the tool's display label — `SHELL` for
 * `shell_command`, `READ` for `read_file` — not against the tool's own name,
 * so a matcher is written in labels. This table maps the labels whose tools
 * have a counterpart here; a matcher naming any other label matches a tool
 * this build does not have and is dropped with that as its reason.
 */
export const COMMAND_CODE_HOOK_MATCHER_LABELS: Readonly<Record<string, string | undefined>> = {
	SHELL: "Bash",
	READ: "Read",
	READ_MULTI: "Read",
	EDIT: "Edit",
	WRITE: "Write",
	SEARCH: "Grep",
	GLOB: "Glob",
	WEB_SEARCH: "WebSearch",
	WEB_FETCH: "WebFetch",
	QUESTION: "AskUserQuestion",
};

// ---------------------------------------------------------------------------
// Settings keys
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The `settings.json` keys this importer reads for a claim, and nothing else. */
export const COMMAND_CODE_SETTINGS_KEYS_READ: readonly string[] = [
	"model",
	"theme",
	"permissions",
	"permissionMode",
	"hooks",
	"mcp",
];

// Long-form design notes: docs/dev/migration-sources.md
/**
 * The `settings.json` keys this importer recognizes and deliberately does not
 * carry: skill behaviour, compact-mode and taste preferences, per-task model
 * overrides. Listed rather than ignored so the report can say they were
 * understood and left, not missed.
 */
export const COMMAND_CODE_SETTINGS_KEYS_PASSED_OVER: readonly string[] = [
	"skills",
	"disabledSkills",
	"disableSkillShellExecution",
	"disableScratchpad",
	"compactMode",
	"tasteLearning",
	"reasoningEffort",
	"featureModels",
	"byokFeatureTasks",
	"modelProvider",
];

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The id shape a `providers.json` entry must have, verbatim: one lower-case alphanumeric, then up to 63 of `a-z0-9_.-`. */
export const COMMAND_CODE_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

// Long-form design notes: docs/dev/migration-sources.md
/**
 * The six ids the CLI reserves for its own sign-in lanes, verbatim from
 * `pb = new Set([...Object.values(ib), ...Object.keys(ib), qr.COMMAND])`: the
 * three account keys (`anthropic`, `github-copilot`, `codex`), the three
 * transport aliases they map onto (`anthropic`, `copilot`, `openai`), and the
 * product's own gateway id. A `providers.json` entry under one of these is
 * skipped rather than read as a BYOK provider.
 */
export const COMMAND_CODE_BUILT_IN_PROVIDER_IDS: readonly string[] = [
	"anthropic",
	"copilot",
	"openai",
	"github-copilot",
	"codex",
	"command-code",
];

// Long-form design notes: docs/dev/migration-sources.md
/** The five ids reserved for the auth file's own account fields, verbatim from `lo = ["apiKey","userId","userName","keyName","authenticatedAt"]`. A `providers.json` entry under one of these collides with the account record and is skipped. */
export const COMMAND_CODE_RESERVED_PROVIDER_IDS: readonly string[] = [
	"apiKey",
	"userId",
	"userName",
	"keyName",
	"authenticatedAt",
];

// Long-form design notes: docs/dev/migration-sources.md
/** The three API kinds a provider may speak, verbatim. An absent kind means the first; anything else means the provider is skipped. */
export const COMMAND_CODE_PROVIDER_API_KINDS: readonly string[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
];

/** The context window assumed for a model whose entry does not name one. */
export const COMMAND_CODE_DEFAULT_CONTEXT_WINDOW = 200_000;

// Long-form design notes: docs/dev/migration-sources.md
/** The reasoning efforts a model entry may name, in the CLI's order. An entry naming anything else is filtered down to these. */
export const COMMAND_CODE_REASONING_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The two spellings of the skill manifest the scanner accepts. A skill is a directory holding one of these. */
export const COMMAND_CODE_SKILL_MANIFESTS: readonly string[] = ["SKILL.md", "skill.md"];

/** How deep the scanner walks below a skill root; directories at depth 5 and beyond are not entered. */
export const COMMAND_CODE_SKILL_MAX_DEPTH = 5;

// Long-form design notes: docs/dev/migration-sources.md
/** The metadata rules the CLI enforces on a skill before registering it, verbatim: the name pattern, the name's length, the description's length, the compatibility line's length. A skill that breaks one is refused rather than guessed at. */
export const COMMAND_CODE_SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

export const COMMAND_CODE_SKILL_NAME_MAX = 64;
export const COMMAND_CODE_SKILL_DESCRIPTION_MAX = 1024;
export const COMMAND_CODE_SKILL_COMPATIBILITY_MAX = 500;

// ---------------------------------------------------------------------------
// Prompt history
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/**
 * How many prompts `history.jsonl` keeps, `RA = 1e3`. Every append rewrites
 * the whole file with the newest entries and stamps every line with the same
 * `t`, the time of that write — so the timestamps are the last write, not each
 * prompt's own moment, and ordering falls back to the file's own order.
 */
export const COMMAND_CODE_PROMPT_HISTORY_MAX = 1000;
