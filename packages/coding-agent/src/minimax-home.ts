/**
 * Where MiniMax Code (`mcode`, the npm package `@minimax-ai/code`, internal
 * codename `mavis`) keeps its tree.
 *
 * Two things about this product shape the module, and both are the reason it is
 * a module rather than a handful of `join` calls.
 *
 * The first is that the directory has *three* historical names and only one of
 * them is the live one. The current default is `~/.minimax`
 * (`packages/config/src/data-dir.ts:5-6`, `docs/installation.md:75-90`); `~/.mavis`
 * is the same tree under its older name, which the tool itself renames (or links)
 * into place on startup (`resolveDataDirPair`); and `~/.minimax-code` is the
 * installer's own directory on macOS/Linux/WSL — and, separately, the data
 * directory of earlier source builds, which the current default deliberately
 * neither moves nor merges (`docs/installation.md:85-87`). A migration that read
 * `.minimax-code` would be reading the tool's program files; a migration that
 * read `.mavis` without checking it is a link would import one tree twice.
 *
 * The second is that the credentials of the account that owns those sessions
 * live *inside* the same directory: `auth/`, `credentials/`, `cli-auth/`,
 * `codex-auth.json`, `local-runtime.auth.json`, and BYOK keys in `config.yaml`.
 * A reader therefore works from an allow-list of paths it knows how to parse,
 * and never from "everything under the root that looks interesting". Every
 * credential path below is named for the report and never opened.
 *
 * Everything here computes strings and, for the one legacy question that cannot
 * be answered from a name alone, stats a path. Nothing is created, and no file
 * outside the caller's own data directory is read except to answer whether a
 * legacy directory is a link to the current one.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The directory MiniMax Code keeps its state in when no variable names another. */
export const MINIMAX_DATA_DIR_BASENAME = ".minimax";

/**
 * The name the same directory used to have, and the name an older release's
 * *variable* still has.
 *
 * This is not a second product's tree — unlike `kimi-cli`'s `~/.kimi`, which is
 * a different tool's directory — it is this tool's own history: `~/.mavis` is
 * renamed (or, if the rename is refused, junction-linked) into `~/.minimax` by
 * `resolveDataDirPair` the first time a build that knows the new name starts
 * (`packages/config/src/data-dir.ts:5-6, 287-382`), and `$MAVIS_DATA_DIR` is
 * still read, after `$MINIMAX_DATA_DIR`, as an override of the very same tree.
 * So both names point at one directory, and the only question a reader has to
 * answer about them is which one is live on this machine right now.
 */
export const MINIMAX_LEGACY_DATA_DIR_BASENAME = ".mavis";

/**
 * The directory the macOS/Linux/WSL installer unpacks the npm package into
 * (`MCODE_INSTALL_DIR` changes it), and — before the current default took over —
 * the data directory of source builds, which `docs/installation.md:85-87` says
 * the new default does not move or merge.
 *
 * Named here so a report can say why a tree full of program files was not read
 * as sessions, and never resolved into a read by this module.
 */
export const MINIMAX_INSTALL_DIR = ".minimax-code";

/** The variable that moves the tree. */
export const MINIMAX_DATA_DIR_ENV = "MINIMAX_DATA_DIR";

/** The variable's older name, read second; it names the same tree, not another tool's. */
export const MINIMAX_LEGACY_DATA_DIR_ENV = "MAVIS_DATA_DIR";

/** Where the tree is, and which rule put it there. */
export interface MinimaxRoot {
	/** The tree to read: the resolved override, else `<home>/.minimax`. */
	root: string;
	/** Which of the two names named it, so the report can say why it is not the default. */
	origin: "data-dir" | "legacy-data-dir" | "default";
}

/**
 * Where MiniMax Code keeps its tree: `$MINIMAX_DATA_DIR`, else `$MAVIS_DATA_DIR`,
 * else `<home>/.minimax`.
 *
 * Three rules of the tool's own resolution are reproduced here and one is
 * deliberately not; the not is as load-bearing as the others.
 *
 *   - the value is **trimmed**, and an all-whitespace value is **unset**
 *     (`process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim()`,
 *     `packages/config/src/config.ts:1316-1319`; the TUI resolves it the same way
 *     in `readDataDirOverride`, `packages/tui/src/runtime/data-dir.ts:36-45`).
 *     This is worth stating because it is the opposite of what a reader of the
 *     neighbouring sources would expect — `$KIMI_CODE_HOME` is used verbatim,
 *     `$DSH_HOME` counts pure whitespace as a value — and because the audit this
 *     module was written from describes the value as used "as-is". The source
 *     disagrees, and the source wins: a value of `  /data/mcode  ` names
 *     `/data/mcode`, and a value of `"   "` names nothing and leaves
 *     `$MAVIS_DATA_DIR` to decide;
 *   - a leading `~` is not expanded and a relative value is not resolved: the
 *     vendor returns the value from `getExplicitDataDirArg` to its callers
 *     unchanged, so `~/elsewhere` names a directory literally called `~` under
 *     the process's working directory, exactly as `$KIMI_CODE_HOME` does. A
 *     reader that resolved it would read a tree nobody wrote;
 *   - `$MINIMAX_DATA_DIR` wins over `$MAVIS_DATA_DIR` even when both are set,
 *     because the two are one setting with two names and the newer name is the
 *     one the shipped build documents (`docs/installation.md:83-84`);
 *   - what is *not* here: `--data-dir`/`--profile` (`cliArgValue`,
 *     `config.ts:1220-1228`), the internal `__MAVIS_RUNTIME_DATA_DIR` /
 *     `__MAVIS_RUNTIME_PROFILE` (read only when `__MAVIS_ALLOW_LEGACY_RUNTIME_ENV
 *     === "1"`, `config.ts:84, 1214-1219`), and git auto-detection
 *     (`detectGitPortInfo`, `REPO_NAMES` at `config.ts:1247`). The first two are
 *     a running process's own argv and environment; the third fires only inside
 *     the vendor's repositories and picks a per-branch profile, which is a tree
 *     this module can name — `minimaxProfileRoot` below — but cannot detect
 *     without asking git the same questions the tool asks.
 */
export function minimaxRoot(home: string): MinimaxRoot {
	const named = process.env[MINIMAX_DATA_DIR_ENV]?.trim();
	if (named) return { root: named, origin: "data-dir" };
	const legacyNamed = process.env[MINIMAX_LEGACY_DATA_DIR_ENV]?.trim();
	if (legacyNamed) return { root: legacyNamed, origin: "legacy-data-dir" };
	return { root: join(home, MINIMAX_DATA_DIR_BASENAME), origin: "default" };
}

/**
 * `<home>/.minimax-<profile>`: the tree of one profile.
 *
 * `basenameForProfile` is `base + "-" + profile` with no separator of its own
 * (`packages/config/src/data-dir.ts:36-38`), and a profile reaches the tool as
 * `--profile` or through the internal runtime environment; the branch-isolated
 * profile of a git auto-detected run has `/` replaced by `-`
 * (`config.ts:1400-1420`). An empty profile is the unscoped tree rather than a
 * directory named `.minimax-`.
 */
export function minimaxProfileRoot(home: string, profile: string): string {
	return profile ? join(home, `${MINIMAX_DATA_DIR_BASENAME}-${profile}`) : join(home, MINIMAX_DATA_DIR_BASENAME);
}

/**
 * `<home>/.mavis[-<profile>]` when that is a *different* tree from `<home>/.minimax`,
 * `null` when it is the same one.
 *
 * The vendor's own migration renames `.mavis` into `.minimax`, and when the
 * rename leaves a link behind it points at the new directory
 * (`createCompatLink`, `data-dir.ts:83-90`), so on a machine that has run any
 * build of this tool the old name is not a second tree — it is the same tree
 * under both names, and importing from both would import every session twice.
 * This function answers that question the way the tool answers it: resolve the
 * link, compare the resolved paths, and only call it a separate tree when the
 * comparison fails. Case is folded on Windows, where the same directory is
 * routinely spelled two ways.
 *
 * A `null` here means "do not read this path". A returned path means a `.mavis`
 * directory that still holds its own data — the vendor has not visited this
 * machine yet — and reading it is reading exactly what the vendor would read
 * (the rename it would perform moves that data to the same place).
 *
 * The comparison is the module's one filesystem touch, and it is a `stat`, not a
 * read: nothing inside either directory is opened.
 */
export function minimaxLegacyDataDir(home: string, profile = ""): string | null {
	const legacy = profile
		? join(home, `${MINIMAX_LEGACY_DATA_DIR_BASENAME}-${profile}`)
		: join(home, MINIMAX_LEGACY_DATA_DIR_BASENAME);
	const current = minimaxProfileRoot(home, profile);
	if (!existsSync(legacy)) return null;
	if (sameDirectory(legacy, current)) return null;
	return legacy;
}

/**
 * True when two paths name one directory, following a link at `candidate`.
 *
 * `data-dir.ts:61-81` does the same: canonicalise with `resolve`, strip the
 * Windows `\\?\` prefix, fold case on win32, and accept either an absolute link
 * target or one relative to the link's own directory (both spellings occur in
 * the wild, and `fs.symlinkSync` writes the second).
 */
function sameDirectory(candidate: string, target: string): boolean {
	if (!existsSync(target)) return false;
	try {
		if (!lstatSync(candidate).isSymbolicLink()) return false;
		const linked = readlinkSync(candidate);
		if (samePath(resolve(dirname(candidate), linked), target)) return true;
		return samePath(resolve(linked), target);
	} catch {
		// A junction that cannot be read is not evidence that two trees are one;
		// the caller reports `.mavis` by name and the user decides.
		return false;
	}
}

/** Canonical form of a path, as `normalizeResolvedPathForCompare` computes it. */
function samePath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		let resolved = resolve(value);
		if (process.platform === "win32") resolved = resolved.replace(/^\\\\\?\\/, "").toLowerCase();
		return resolved;
	};
	return normalize(left) === normalize(right);
}

/**
 * What a data directory holds, as MiniMax itself decides it before it moves a
 * legacy tree in.
 *
 * `"empty"` and `"hasData"` are the vendor's own content test: a directory with
 * no entries, or with nothing but an empty `workspace/`, counts as empty
 * (`contentState`, `packages/config/src/data-dir.ts:110-125`).
 *
 * A **link is read through**, because that is what the vendor does with one: a
 * legacy link's content is its target's (`linkTargetDirectoryContentState`,
 * `data-dir.ts:301-308`), and a primary link never gets a content test of its own
 * at all (`:372`). So the question this answers — "would MiniMax find data here" —
 * has the same answer on either side of a link, and the vendor's own compat link
 * makes `.minimax` and `.mavis` a link and a directory rather than two trees.
 * `"other"` is therefore a path that is neither a directory nor a link to one (a
 * plain file, or a link to a file), which the vendor migrates onto and never
 * reads as data. `"unknown"` is a directory this process cannot list — the vendor
 * refuses to treat that as empty (`:311-315`), and neither does this.
 *
 * `"missing"` is also what a path this process cannot stat returns: nothing can
 * be said about it, and the caller treats it as a path with no data.
 */
export type MinimaxDataState = "missing" | "empty" | "hasData" | "unknown" | "other";

export function minimaxDataState(target: string): MinimaxDataState {
	try {
		// `statSync` follows a link — deliberately: see the note on this type.
		if (!statSync(target).isDirectory()) return "other";
	} catch {
		return "missing";
	}
	let entries: string[];
	try {
		entries = readdirSync(target);
	} catch {
		return "unknown";
	}
	if (entries.length === 0) return "empty";
	if (entries.length === 1 && entries[0] === "workspace") {
		try {
			return readdirSync(join(target, "workspace")).length > 0 ? "hasData" : "empty";
		} catch {
			return "unknown";
		}
	}
	return "hasData";
}

/** `<root>/config.yaml` — the one global settings file, BYOK keys included. */
export function minimaxConfigPath(root: string): string {
	return join(root, "config.yaml");
}

/**
 * `<root>/AGENTS.md` — the user-global instruction document.
 *
 * Only the global file has one spelling (`join(dataDir, 'AGENTS.md')`,
 * `static-prompt-reader.ts:99,109`). A *project* file is read as `CLAUDE.md`
 * first and `AGENTS.md` second (`static-prompt-reader.ts:124`, where the first
 * name is spelled with hex escapes), which is a rule about a working directory
 * rather than about this tree, and the caller that walks projects owns it.
 */
export function minimaxGlobalInstructionsPath(root: string): string {
	return join(root, "AGENTS.md");
}

/** `<root>/v2` — the current on-disk generation; everything below hangs off it. */
export function minimaxV2Root(root: string): string {
	return join(root, "v2");
}

/**
 * `<root>/v2/sessions` — one dated directory per session, four levels deep:
 * `<year>/<month>/<day>/<HH-mm-ss-SSS>-session_<base64url(sessionId)>/`.
 *
 * The four-level shape is not a convention this reader invented; the tool's own
 * discovery walks exactly these depths (`listManifestPaths`,
 * `session-history-location.ts:186-202`) and its own writer refuses a relative
 * directory that is not four non-empty segments (`validateRelativeDir`,
 * `session-history-paths.ts:120-139`). The timestamp segment is UTC for every
 * session the current build creates and local time for the earlier `v1` writer,
 * which is why nothing here parses the directory name back into an id: the
 * directory's `manifest.json` states `sessionId` and `createdAtMs`, and that is
 * the only reading that survives both writers.
 */
export function minimaxSessionsRoot(root: string): string {
	return join(minimaxV2Root(root), "sessions");
}

/**
 * `<root>/v2/sqlite/runtime-state.sqlite` — the live database, and the only
 * place a session's *title*, project directory, archived flag and internal kind
 * are written.
 *
 * MiniMax's manifest carries identity and paths and nothing else, and the
 * manifest is written once, when the session directory is created; the row in
 * `local_runtime_sessions` is the record the sidebar reads
 * (`projects/sidebar/predicate.ts:30-56`). A reader may open it read-only for
 * that metadata; it must not create it, which is why every entry point checks
 * for the file first.
 */
export function minimaxRuntimeStateDb(root: string): string {
	return join(minimaxV2Root(root), "sqlite", "runtime-state.sqlite");
}

/** `<root>/v2/chats` — the pre-`v2` layout's ledgers, kept for migration only. */
export function minimaxLegacyChatsDir(root: string): string {
	return join(minimaxV2Root(root), "chats");
}

/**
 * `<root>/v2/mcode/drafts` — unsent composer text, not history.
 *
 * `resolveTuiDraftRecoveryPath` (`composer/draft-recovery.ts:498-513`) keys a
 * draft by `sha256(resolve(workspaceDir)).slice(0, 24)` and, per session, by
 * `sha256(normalizeSessionKey(sessionKey)).slice(0, 24)` under that workspace's
 * own directory. Named here so this module can say what it is *not*: a draft is
 * text the user never sent, and a migration that imported it would put words in
 * their mouth in a session that has no turn for them.
 */
export function minimaxDraftsDir(root: string): string {
	return join(minimaxV2Root(root), "mcode", "drafts");
}

/** `<root>/agents` — user subagent profiles; `<root>/agents/<name>/skills` sits inside. */
export function minimaxAgentsDir(root: string): string {
	return join(root, "agents");
}

/**
 * `<root>/skills` — the user's own MiniMax skills.
 *
 * The tool reads three *borrowed* skill trees as well — `~/.claude/skills`,
 * `~/.codex/skills`, `~/.agents/skills` at user scope and `.claude/skills`,
 * `.agents/skills` beside a project (`packages/local-runtime/src/skills/roots.ts:60-125`,
 * `skills-config.ts:1-25`) — and they are copied from for a reason, not owned:
 * those trees belong to the sources this migrator already has, and importing
 * them here would import every skill twice. Two more roots inside this tree are
 * not the user's either: `skills` under an *agent* directory, and the builtin
 * assets seeded into `<root>/.builtin-skills` (`skills/roots.ts:19-22`).
 */
export function minimaxSkillsDir(root: string): string {
	return join(root, "skills");
}

/** `<root>/plugins` — install records and managed copies of installed plugins. */
export function minimaxPluginsDir(root: string): string {
	return join(root, "plugins");
}

/** `<root>/plans` — plan-mode documents the user approved and kept. */
export function minimaxPlansDir(root: string): string {
	return join(root, "plans");
}

/** `<root>/memory` — the agent's long-term notes, `topics/*.md` included. */
export function minimaxMemoryDir(root: string): string {
	return join(root, "memory");
}

/**
 * `<root>/mcp.json` — user-level MCP servers, and the only file MiniMax connects from.
 *
 * `<root>/mcp/mcp.json` is read beside it, but not as a second source of
 * connections: the runtime's own path is `join(dataDir, 'mcp.json')`
 * (`filePath`, `mcp/runtime/local-mcp.service.ts:1027`), and the older spelling
 * is read only into the set of configured *names*, for the deprecated wiring
 * that resolves skill references to MCP tools (`readConfiguredMcpServerNames`,
 * `mcp/runtime/config-file.ts:6-11`; its one caller is
 * `local-runtime/src/api/host.ts:945`). So a reader that found only the alias
 * must name it rather than pass it off as this file, and a reader that takes
 * servers out of it must say what the source itself does with them.
 */
export function minimaxMcpFile(root: string): string {
	return join(root, "mcp.json");
}

/** `<root>/mcp/mcp.json` — the older spelling of the same document, read for names. */
export function minimaxMcpAliasFile(root: string): string {
	return join(root, "mcp", "mcp.json");
}

/**
 * `<root>/permission.json` — the user's permission rules (allow/ask/deny), one
 * file at the data directory's root and one per agent directory
 * (`permission/rules.ts:330-347`, `fs-permission.ts:707-733`).
 */
export function minimaxPermissionFile(root: string): string {
	return join(root, "permission.json");
}

/** `<root>/auth` — login state, per build environment and region. Named only. */
export function minimaxAuthDir(root: string): string {
	return join(root, "auth");
}

/** `<root>/credentials` — per-agent, per-platform credentials. Named only. */
export function minimaxCredentialsDir(root: string): string {
	return join(root, "credentials");
}

/** `<root>/cli-auth` — the CLI's own credential store. Named only. */
export function minimaxCliAuthDir(root: string): string {
	return join(root, "cli-auth");
}

/**
 * `<workspace>/.mcp.json` — a project's MCP servers, read before the user's file
 * (`mcp/project-config.ts:23-26`). A path about a project, exported here so the
 * importer and this module agree on one spelling.
 */
export const MINIMAX_PROJECT_MCP_FILE = ".mcp.json";

/**
 * The project instruction documents, in the order the tool reads them: the
 * legacy `CLAUDE.md` first, then `AGENTS.md`
 * (`static-prompt-reader.ts:124`, first name spelled with hex escapes).
 */
export const MINIMAX_PROJECT_INSTRUCTION_FILES: readonly string[] = ["CLAUDE.md", "AGENTS.md"];
