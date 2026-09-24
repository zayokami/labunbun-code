/**
 * The vocabulary every migration module shares: which sources exist, what one
 * of them looks like once read, and what a planned write or a report line is.
 *
 * This module is deliberately a leaf. `migrate-history.ts` needs
 * {@link MigrationSourceId} and the hub needs all of it, so anything that would
 * have to import back from either of them cannot live here — which is why
 * `PlanOptions`, the one type that talks about imported history, stays in the
 * hub. Keeping that edge one-way is what lets `migrate-history.ts` name the source
 * ids without the two modules importing each other.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveModel } from "@labunbun/ai";
import { codexRoot } from "./codex-home.ts";
import { DSH_DEFAULT_DIR, dshRoot } from "./dsh-home.ts";
import { GROK_DEFAULT_DIR, grokRoot } from "./grok-home.ts";
import { KIMI_CODE_DEFAULT_DIR, kimiRoot } from "./kimi-home.ts";
import { MINIMAX_DATA_DIR_BASENAME, minimaxRoot } from "./minimax-home.ts";
import { STEPCODE_DEFAULT_DIR, stepRoot } from "./step-home.ts";

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
	| "step-code";

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
};

/**
 * Directory that marks a source as present, relative to home.
 *
 * Only for the sources whose tree really is under `~`. dsh and grok both let an
 * environment variable put theirs anywhere, so their entries here are the
 * *default* spelling, used to render a label rather than to find the tree — see
 * {@link sourceRoot}, which is what detection and the readers call.
 */
export const SOURCE_ROOTS: Record<MigrationSourceId, string> = {
	"claude-code": ".claude",
	codex: ".codex",
	zcode: ".zcode",
	agents: ".agents",
	"deepseek-harness": DSH_DEFAULT_DIR,
	"grok-build": GROK_DEFAULT_DIR,
	"kimi-code": KIMI_CODE_DEFAULT_DIR,
	"minimax-code": MINIMAX_DATA_DIR_BASENAME,
	"step-code": STEPCODE_DEFAULT_DIR,
};

/**
 * Where a source's tree actually is.
 *
 * Most roots are home-relative. Six are not: `$DSH_HOME`, `$GROK_HOME`,
 * `$CODEX_HOME`, `$KIMI_CODE_HOME`, MiniMax's pair of variables and Step's two
 * can each put their tree anywhere, and a reader that consulted `~/` anyway
 * would call the source absent while the importer went on to import from it —
 * or, worse here, detection would find it while the label named a path nobody
 * read. One function rather than a condition inside `detectSources`, so the
 * detection and the readers cannot disagree about which tree a source is.
 *
 * Step's entry is `stepRoot`, which is also the only one that is *not* a single
 * expression: the directory name itself is a setting (`$STEPCODE_CONFIG_DIR`),
 * an agent-directory override moves the tree out of the home entirely, and the
 * pre-rename `.step-harness` tree is read when the canonical one holds nothing.
 */
function sourceRoot(id: MigrationSourceId, home: string): string {
	if (id === "deepseek-harness") return dshRoot(home);
	if (id === "grok-build") return grokRoot(home);
	if (id === "codex") return codexRoot(home);
	if (id === "kimi-code") return kimiRoot(home);
	if (id === "minimax-code") return minimaxRoot(home).root;
	if (id === "step-code") return stepRoot(home);
	return join(home, SOURCE_ROOTS[id]);
}

/**
 * Detect a source by what is in it, not by whether its directory exists.
 *
 * `~/.agents` (and `~/.claude`, `~/.codex`) are directories other tools create —
 * an empty one has nothing to import, and offering it is a question whose only
 * possible answer still costs the user a read and a keystroke. A root that is
 * present but unreadable counts as empty for the same reason: nothing can be
 * read from it either way.
 */
function sourceHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

export function detectSources(home: string): MigrationSourceId[] {
	return MIGRATION_SOURCE_IDS.filter((id) => sourceHasContent(sourceRoot(id, home)));
}

// ---------------------------------------------------------------------------
// Raw source data
// ---------------------------------------------------------------------------

/**
 * A file that travels with a {@link RawFile} rather than standing on its own: a
 * skill's `references/*.md`, `scripts/`, and so on.
 *
 * A skill is a directory, not a document. Copying only its `SKILL.md` leaves the
 * body pointing at files that are not there, so the supporting files are read
 * alongside it and written next to it.
 */
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

/**
 * Command files found under a source's commands directory, with the ones that
 * could not become a skill.
 *
 * Separate from {@link RawFile} because a command file is not carried as it
 * stands: its header is rewritten, and the reason a file was refused (a README,
 * a name too long to be a directory here) has to survive into the report.
 */
export interface RawCommands {
	files: RawFile[];
	skips: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * `map` — carried over as-is.
 * `downgrade` — carried over with a semantic loss, explained in `detail`.
 * `skip` — deliberately not carried over; `detail` says why.
 *
 * Skips are reported rather than dropped silently. A setting that vanishes
 * without explanation reads as a migration bug, and the user cannot tell the
 * difference between "labunbun has no equivalent" and "the importer missed it".
 */
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

/**
 * Short model aliases → labunbun model references.
 *
 * Source tools accept a family alias where labunbun wants a `provider/id`
 * reference. Each target is verified against the registry during planning, so an
 * alias pointing at a model this build doesn't carry becomes a reported skip
 * rather than an unusable `model` value written into settings.
 */
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

/**
 * Keys in the source state file that are telemetry or runtime bookkeeping.
 *
 * `projects` is deliberately not among them: each entry under it holds that
 * project's local-scope MCP servers (`services/mcp/config.ts` reads them for
 * scope `local`), and those are configuration. They are named one by one in
 * `planClaudeCode` — calling the whole map "not configuration" was a claim the
 * file itself contradicts.
 */
export const STATE_TELEMETRY_KEYS = new Set(["tipsHistory", "promptQueueUseCount", "cachedChangelog"]);

/**
 * Keys of `~/.claude/settings.json` that either get imported or get a note of
 * their own. Anything else is named by the closing aggregate item.
 */
export const CLAUDE_SETTINGS_HANDLED = new Set([
	"env",
	"model",
	"permissions",
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

export type ClaimEnv = (source: MigrationSourceId, name: string, value: string, from: string) => void;

/**
 * Settings keys a source may claim outright, and the value shapes they carry.
 * Widening this list is cheap; claiming a key that the merge cannot undo is not,
 * which is why permission rules take the accumulating path instead.
 */
export type ClaimableScalarKey =
	| "model"
	| "theme"
	| "permissionMode"
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
) => void;

export type ClaimScalar = (
	source: MigrationSourceId,
	key: ClaimableScalarKey,
	value: ClaimedScalarValue,
	from: string,
	detail: string,
) => void;
