// The vocabulary every migration module shares: the sources, what one looks like once read, and the write and report lines.
// Long-form design notes: docs/dev/migration-framework.md

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode, SandboxMode } from "@labunbun/agent";
import { resolveModel } from "@labunbun/ai";
import { almaConfigDir, almaDetectionRoots } from "./alma-home.ts";
import { antigravityConfigDir, antigravityDataDirs } from "./antigravity-home.ts";
import { CODEWHALE_DEFAULT_DIR, codewhaleDefaultRoots, resolveCodewhaleHome } from "./codewhale-home.ts";
import { codexRoot } from "./codex-home.ts";
import { cursorDetectionRoots, cursorUserRoot } from "./cursor-home.ts";
import { DSH_DEFAULT_DIR, dshRoot } from "./dsh-home.ts";
import { GROK_DEFAULT_DIR, grokRoot } from "./grok-home.ts";
import { KIMI_CODE_DEFAULT_DIR, kimiRoot } from "./kimi-home.ts";
import { mimocodeRoots } from "./mimocode-home.ts";
import { MINIMAX_DATA_DIR_BASENAME, minimaxRoot } from "./minimax-home.ts";
import { OPENCLAW_DEFAULT_DIR, openclawStateDir, openclawStateRoots } from "./openclaw-home.ts";
import { opencodeRoots } from "./opencode-home.ts";
import { QODER_CN_DEFAULT_DIR, QODER_DEFAULT_DIR, qoderConfigDir } from "./qoder-home.ts";
import { STEPCODE_DEFAULT_DIR, stepRoot } from "./step-home.ts";
import { T3_DEFAULT_DIR, t3Root, t3StateDirs } from "./t3-home.ts";
import { traeDetectionRoots, traeEdition, traeGlobalRulesDir } from "./trae-home.ts";
import { ZCODE_DEFAULT_DIR, zcodeRoot } from "./zcode-home.ts";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type MigrationSourceId =
	| "claude-code"
	| "codex"
	| "zcode"
	| "agents"
	| "deepseek-harness"
	| "grok-build"
	| "kimi-code"
	| "minimax-code"
	| "step-code"
	| "opencode"
	| "cursor"
	| "trae"
	| "t3-code"
	| "antigravity"
	| "qoder"
	| "codewhale"
	| "mimocode-code"
	| "openclaw"
	| "alma";

/**
 * Ordered as the picker and `--from` list them. New sources are appended: the
 * order is what `detectSources` reports, and reordering would silently change
 * which of two sources providing the same file wins.
 */
export const MIGRATION_SOURCE_IDS: MigrationSourceId[] = [
	"claude-code",
	"codex",
	"zcode",
	"agents",
	"deepseek-harness",
	"grok-build",
	"kimi-code",
	"minimax-code",
	"step-code",
	"opencode",
	"cursor",
	"trae",
	"t3-code",
	"antigravity",
	"qoder",
	"codewhale",
	"mimocode-code",
	"openclaw",
	"alma",
];

/** Display names for the picker; the ids themselves are the CLI switches. */
export const MIGRATION_SOURCE_LABELS: Record<MigrationSourceId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	zcode: "ZCode",
	agents: "~/.agents (shared agent home)",
	"deepseek-harness": "DeepSeek Harness",
	"grok-build": "Grok Build",
	"kimi-code": "Kimi Code",
	"minimax-code": "MiniMax Code",
	"step-code": "Step Code",
	opencode: "OpenCode",
	cursor: "Cursor",
	trae: "Trae",
	"t3-code": "T3 Code",
	antigravity: "Antigravity",
	qoder: "Qoder",
	codewhale: "Codewhale",
	"mimocode-code": "MiMo Code",
	openclaw: "OpenClaw",
	alma: "Alma",
};

// Long-form design notes: docs/dev/migration-framework.md
/** Directory that marks a source as present, relative to home. */
export const SOURCE_ROOTS: Record<MigrationSourceId, string> = {
	"claude-code": ".claude",
	codex: ".codex",
	zcode: ZCODE_DEFAULT_DIR,
	agents: ".agents",
	"deepseek-harness": DSH_DEFAULT_DIR,
	"grok-build": GROK_DEFAULT_DIR,
	"kimi-code": KIMI_CODE_DEFAULT_DIR,
	"minimax-code": MINIMAX_DATA_DIR_BASENAME,
	"step-code": STEPCODE_DEFAULT_DIR,
	// Not a single segment, and the only entry here that is two directories deep:
	// OpenCode puts its tree under the XDG bases, and `xdg-basedir@5.1.0` has no
	// Windows branch, so on Windows this is `~/.config/opencode` and not
	// `%APPDATA%`. The path exists to render a label — see `sourceRoot`, which is
	// what actually finds the tree.
	opencode: ".config/opencode",
	// Both of these are *also* not the whole story, and for a reason the other nine
	// do not have: an IDE that has been opened and used keeps its state in a
	// profile directory outside the home, so the home-relative spelling is the CLI
	// half only. `cursor` is the CLI's home; `trae` is the international global
	// home, and the China build's is `.trae-cn`. Both exist to render a label —
	// `detectionRoots` is what finds the trees.
	cursor: ".cursor",
	trae: ".trae",
	// T3 Code's *base* directory, not its state directory, and the gap between
	// the two is the whole reason `sourceRoot` has a branch for it. The tree a
	// migration reads lives at `<base>/userdata` (`t3-home.ts`), which is also
	// where a `$T3CODE_HOME` override lands, so `~/.t3` is the spelling that
	// exists for every user who has not overridden it — the label, not the answer.
	// See `sourceRoot`.
	"t3-code": T3_DEFAULT_DIR,
	// `~/.gemini`, and this one is **not** a directory only Antigravity uses — the
	// Gemini CLI keeps its own state beside it. That is why it cannot be a detection
	// root, and why the entry below it says so in as many words: a home with only
	// Gemini CLI content has a non-empty `~/.gemini` and no Antigravity in it at all,
	// and detection that looked here would offer those users a source with nothing
	// to read. `detectionRoots` looks inside instead. See `sourceRoot`.
	antigravity: ".gemini",
	// `~/.qoder`, and unlike `~/.gemini` above this one is **not** shared with a
	// foreign tool: the Qoder CLI's home is `~/.qoder` too — `$QODER_CLI_HOME`
	// defaults to the user's home and the directory name is appended to it — so
	// anything in here was written by Qoder and only by Qoder. That is why this
	// entry can be a plain relative spelling while `sourceRoot` still has a branch
	// for the id: the *override* is what moves the tree, not a second tool. See
	// `sourceRoot`.
	qoder: QODER_DEFAULT_DIR,
	// `~/.codewhale`, and this one is the **first source whose root is not a single
	// directory**: Codewhale is a rename of DeepSeek-TUI and `~/.deepseek` is a
	// live fallback root for some of its readers and not for others
	// (`CODEWHALE_LEGACY_FALLBACK` in `codewhale-home.ts` records which is which).
	// The spelling here is the canonical half; `sourceRoot` and `detectionRoots`
	// resolve both.
	codewhale: CODEWHALE_DEFAULT_DIR,
	// Long-form design notes: docs/dev/migration-framework.md
	"mimocode-code": ".config/mimocode",
	// Long-form design notes: docs/dev/migration-framework.md
	openclaw: OPENCLAW_DEFAULT_DIR,
	// Long-form design notes: docs/dev/migration-framework.md
	alma: ".config/alma",
};

// Long-form design notes: docs/dev/migration-framework.md
/** Where a source's tree actually is. */
function sourceRoot(id: MigrationSourceId, home: string): string {
	if (id === "deepseek-harness") return dshRoot(home);
	if (id === "grok-build") return grokRoot(home);
	if (id === "codex") return codexRoot(home);
	if (id === "kimi-code") return kimiRoot(home);
	if (id === "minimax-code") return minimaxRoot(home).root;
	if (id === "step-code") return stepRoot(home);
	// OpenCode's three roots are three different XDG bases, and this is the config
	// one; detection looks at the config and data roots together, in
	// `detectionRoots`. See `opencodeRoots`, which is what the reader uses for all
	// three.
	if (id === "opencode") return opencodeRoots(home).config;
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "mimocode-code") return mimocodeRoots(home, process.env).config;
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "cursor") return cursorUserRoot(home);
	if (id === "trae") return traeGlobalRulesDir(home, traeEdition(home));
	if (id === "zcode") return zcodeRoot(home);
	// T3 Code's state is a *subdirectory* of the directory this table names, and
	// which of the two subdirectories a given install has depends on whether the
	// user ever launched a dev build — a fact only `t3Root` and `t3StateDirs`
	// know, and the reason this entry falls through to `join(home, ".t3")` would
	// be wrong. `t3Root` is the directory the reader will actually open; the
	// `??` is the fallback for a label rendered against a tree nothing was read
	// from, which is the same state `detectionRoots` reports as absent.
	if (id === "t3-code") return t3Root(home) ?? t3StateDirs(home)[0];
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "qoder") return qoderConfigDir(home);
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "codewhale") return resolveCodewhaleHome(home).root;
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "openclaw") return openclawStateDir(home, process.env);
	// Alma's configuration root, which is the only one of its four that a report
	// points a user at for something they can edit. There is no environment
	// variable to honour — `alma-home.ts` records that Alma reads none anywhere in
	// its bundle — so this is a plain home-relative join and the branch exists
	// only to say so, in the one place a reader looks for the reason a source did
	// not fall through.
	if (id === "alma") return almaConfigDir(home);
	// Antigravity needs no branch, and the fallthrough being correct is itself the
	// interesting part: `~/.gemini` is a plain home-relative join, so this source is
	// the first whose *tree* is unambiguous while its *detection* is not. What it
	// is not is a tree only it uses — the Gemini CLI shares the parent — which is
	// why `detectionRoots` looks inside rather than here.
	return join(home, SOURCE_ROOTS[id]);
}

// Long-form design notes: docs/dev/migration-framework.md
/** Detect a source by what is in it, not by whether its directory exists. */
function sourceHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

export function detectSources(home: string): MigrationSourceId[] {
	return MIGRATION_SOURCE_IDS.filter((id) => detectionRoots(id, home).some(sourceHasContent));
}

// Long-form design notes: docs/dev/migration-framework.md
/** The trees whose being non-empty means "this source is here". */
function detectionRoots(id: MigrationSourceId, home: string): string[] {
	if (id === "opencode") {
		const roots = opencodeRoots(home);
		return [roots.config, roots.data];
	}
	// The two IDE sources, and the same mistake avoided in both. A user who has
	// opened the editor and never run its CLI has no home-relative directory at
	// all, and a user who has run the CLI and never opened the editor has no
	// profile directory. Looking at one of each would call the source absent on
	// half the machines that have it — and the import would then find the other's
	// contents, which is the worse of the two failures: a source that was offered
	// as empty and then imported from anyway.
	if (id === "cursor") return cursorDetectionRoots(home);
	if (id === "trae") return traeDetectionRoots(home);
	// T3 Code is the same mistake a third time, and for the same reason as the two
	// above: the state directory an installed build writes and the one a dev build
	// writes are different directories under the same base, and which exist
	// depends on how the user launched T3. Reading only the production one would
	// call the source absent on every machine whose only T3 is a dev checkout —
	// and then find nothing to import, which is the more embarrassing half of
	// that failure rather than the safer one.
	if (id === "t3-code") return t3StateDirs(home);
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "antigravity") return [...antigravityDataDirs(home), antigravityConfigDir(home)];
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "qoder") return [sourceRoot(id, home), join(home, QODER_CN_DEFAULT_DIR)];
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "codewhale") return codewhaleDefaultRoots(home);
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "openclaw") return openclawStateRoots(home, process.env);
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "alma") return almaDetectionRoots(home, process.env);
	// Long-form design notes: docs/dev/migration-framework.md
	if (id === "mimocode-code") {
		const roots = mimocodeRoots(home, process.env);
		return [roots.config, roots.data, roots.state, roots.cache];
	}
	return [sourceRoot(id, home)];
}

// ---------------------------------------------------------------------------
// Raw source data
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-framework.md
/** A file that travels with a {@link RawFile} rather than standing on its own. */
export interface RawAttachment {
	/** Path relative to the owning file's directory, e.g. `references/api.md`. */
	relativePath: string;
	content: string;
}

/** A skill, rule or agent file found in a source tree, carried as content. */
export interface RawFile {
	/** Name used to build the target path: skill directory name, or rule filename. */
	name: string;
	sourcePath: string;
	content: string;
	/** Overrides the report's "copied verbatim" note when the copy has a caveat. */
	detail?: string;
	/** Files belonging beside this one, written into the same target directory. */
	attachments?: RawAttachment[];
	/**
	 * Supporting files deliberately left behind, with the reason. Carried out of
	 * the reading phase because the report is written from the plan, and a file
	 * that neither travels nor is explained reads as an importer bug.
	 */
	attachmentSkips?: Array<{ relativePath: string; reason: string }>;
}

// Long-form design notes: docs/dev/migration-framework.md
/** Command files found under a source's commands directory, with the ones that could not become a skill. */
export interface RawCommands {
	files: RawFile[];
	skips: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-framework.md
/** The three outcomes for one source value: carried as is, carried with a loss, or refused with a reason. */
export type MigrationAction = "map" | "downgrade" | "skip";

export interface MigrationItem {
	source: MigrationSourceId;
	/** Human-readable origin, e.g. "~/.claude/settings.json → env.ANTHROPIC_BASE_URL". */
	from: string;
	/** Human-readable destination, or "—" for skips. */
	to: string;
	action: MigrationAction;
	detail: string;
	/** Whether the migrated value is a credential, for the report's secrets notice. */
	containsSecret: boolean;
}

/** File writes the plan would perform, keyed by absolute target path. */
export interface PlannedWrite {
	path: string;
	kind: "settings" | "mcp" | "skill" | "rule" | "memory" | "agent" | "history" | "prompt-history";
	/** Full file content to write. */
	content: string;
	/** True when `content` embeds a credential. */
	containsSecret: boolean;
}

/**
 * What kind of thing is being carried over. The user chooses at this
 * granularity (`--only`, the wizard) because the three have very different
 * consequences: settings change behaviour, assets add files to the home
 * directory, history writes a transcript that resume will replay.
 */
export type MigrationCategory = "settings" | "assets" | "history";

export const MIGRATION_CATEGORIES: MigrationCategory[] = ["settings", "assets", "history"];

const KIND_CATEGORY: Record<PlannedWrite["kind"], MigrationCategory> = {
	settings: "settings",
	mcp: "settings",
	skill: "assets",
	rule: "assets",
	memory: "assets",
	agent: "assets",
	history: "history",
	"prompt-history": "history",
};

export function categoryOfKind(kind: PlannedWrite["kind"]): MigrationCategory {
	return KIND_CATEGORY[kind];
}

export interface MigrationPlan {
	home: string;
	sources: MigrationSourceId[];
	/** Categories this plan was allowed to touch. */
	categories: MigrationCategory[];
	items: MigrationItem[];
	writes: PlannedWrite[];
}

/**
 * Environment variables whose values are credentials rather than configuration.
 * Drives the report's closing notice about which written files hold secrets;
 * matched case-insensitively as a substring so `*_API_KEY` variants are covered.
 */
const SECRET_ENV_MARKERS = ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL"];

export function looksLikeSecretName(name: string): boolean {
	const upper = name.toUpperCase();
	return SECRET_ENV_MARKERS.some((marker) => upper.includes(marker));
}

// Long-form design notes: docs/dev/migration-framework.md
/** Short model aliases → labunbun model references. */
const MODEL_ALIASES: Record<string, string> = {
	opus: "anthropic/claude-opus-5",
	sonnet: "anthropic/claude-sonnet-5",
	haiku: "anthropic/claude-haiku-4-5",
	fable: "anthropic/claude-fable-5-1",
};

/** Resolve a source `model` value to a reference labunbun can actually load. */
export function resolveModelReference(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const alias = MODEL_ALIASES[trimmed.toLowerCase()];
	const candidates = alias ? [alias, trimmed] : [trimmed];
	for (const candidate of candidates) {
		if (resolveModel(candidate)) return candidate;
	}
	return undefined;
}

// Long-form design notes: docs/dev/migration-framework.md
/** Keys in the source state file that are telemetry or runtime bookkeeping. */
export const STATE_TELEMETRY_KEYS = new Set(["tipsHistory", "promptQueueUseCount", "cachedChangelog"]);

/**
 * Keys of `~/.claude/settings.json` that either get imported or get a note of
 * their own. Anything else is named by the closing aggregate item.
 */
export const CLAUDE_SETTINGS_HANDLED = new Set([
	"env",
	"model",
	"permissions",
	"sandbox",
	"hooks",
	"fallbackModel",
	"effortLevel",
	"enabledPlugins",
]);

/** Keys of `~/.claude.json` that are accounted for above; the rest is state. */
export const CLAUDE_STATE_HANDLED = new Set(["env", "model", "mcpServers", "projects", ...STATE_TELEMETRY_KEYS]);

export function targetSettingsPath(home: string): string {
	return join(home, ".labunbun", "settings.json");
}

export function targetMcpPath(home: string): string {
	return join(home, ".labunbun", ".mcp.json");
}

// Long-form design notes: docs/dev/migration-framework.md
/** Claim one environment variable. */
export type ClaimEnv = (
	source: MigrationSourceId,
	name: string,
	value: string,
	from: string,
	action?: MigrationAction,
	detail?: string,
) => void;

/**
 * Settings keys a source may claim outright, and the value shapes they carry.
 * Widening this list is cheap; claiming a key that the merge cannot undo is not,
 * which is why permission rules take the accumulating path instead.
 */
export type ClaimableScalarKey =
	| "model"
	| "theme"
	| "permissionMode"
	| "sandbox"
	| "fallbackModels"
	| "disableBypassPermissionsMode";

export type ClaimedScalarValue = string | string[] | boolean;

/** One entry of the target's hook config. */
export interface NormalizedHookEntry {
	matcher?: string;
	hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

/** What survived hook normalization, and what did not. */
export interface NormalizedHooks {
	/** Event name → entries that will run. Events with nothing runnable are absent. */
	config: Record<string, NormalizedHookEntry[]>;
	/** Source event names this build has no event for; hooks under them never fire. */
	droppedEvents: string[];
	/** Handlers dropped because their `type` is not a shell command (e.g. `prompt`). */
	droppedHandlers: number;
	/** Matchers dropped because this build would escape their pattern characters. */
	droppedMatchers: string[];
	/** Alternation matchers (`A|B`) split into one entry per name. */
	splitMatchers: string[];
	/** Handlers that carried no usable command, or entries that were not objects. */
	malformed: number;
	/** Handlers whose timeout came across, converted from the source's seconds. */
	convertedTimeouts: number;
	/** Of those, how many asked for longer than this build waits and were clamped. */
	clampedTimeouts: number;
	/** Handlers that name no timeout, so the target's own default applies. */
	untimedHandlers: number;
}

export type AddPermissionRules = (
	source: MigrationSourceId,
	behavior: "allow" | "deny",
	rules: string[],
	from: string,
	caveat: string,
) => void;

export type ClaimPermissionList = (
	source: MigrationSourceId,
	behavior: "allow" | "deny" | "additionalDirectories",
	rules: string[],
	from: string,
	detail: string,
	/**
	 * How the report should score the claim. `map` when the rules arrive intact,
	 * `downgrade` when the source's form had to be rewritten on the way — a
	 * permission list that arrived in another shape is not a faithful copy, and
	 * the tally is where a user notices.
	 */
	action?: MigrationAction,
) => void;

export type ClaimScalar = (
	source: MigrationSourceId,
	key: ClaimableScalarKey,
	value: ClaimedScalarValue,
	from: string,
	detail: string,
) => void;

// Long-form design notes: docs/dev/migration-framework.md
/** Claim a mode and a sandbox together, as the one decision they are. */
export type ClaimModePair = (
	source: MigrationSourceId,
	mode: PermissionMode,
	sandbox: SandboxMode,
	from: string,
	detail: string,
) => void;

// Long-form design notes: docs/dev/migration-framework.md
/** One source's share of the target's hook config, claimed rather than written. */
export type ClaimHooks = (
	source: MigrationSourceId,
	config: Record<string, NormalizedHookEntry[]>,
	from: string,
	detail: string,
	/** `downgrade` when something of the source's hook block did not come across. */
	action?: MigrationAction,
) => void;
