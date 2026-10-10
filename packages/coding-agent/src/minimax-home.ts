// MiniMax Code's tree (`mcode`, npm `@minimax-ai/code`, once `mavis`): three
// historical names, one live tree, and the credential paths a reader leaves closed.
// Long-form design notes: docs/dev/migration-sources.md
import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The directory MiniMax Code keeps its state in when no variable names another. */
export const MINIMAX_DATA_DIR_BASENAME = ".minimax";

// Long-form design notes: docs/dev/migration-sources.md
/** `.mavis`, the older name of the same tree rather than a second tool's directory. */
export const MINIMAX_LEGACY_DATA_DIR_BASENAME = ".mavis";

// Long-form design notes: docs/dev/migration-sources.md
/** Where the installer unpacks the package, and a data tree the current default does not merge. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `$MINIMAX_DATA_DIR`, else `$MAVIS_DATA_DIR`, else `<home>/.minimax`, with the rule that named it. */
export function minimaxRoot(home: string): MinimaxRoot {
	const named = process.env[MINIMAX_DATA_DIR_ENV]?.trim();
	if (named) return { root: named, origin: "data-dir" };
	const legacyNamed = process.env[MINIMAX_LEGACY_DATA_DIR_ENV]?.trim();
	if (legacyNamed) return { root: legacyNamed, origin: "legacy-data-dir" };
	return { root: join(home, MINIMAX_DATA_DIR_BASENAME), origin: "default" };
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<home>/.minimax-<profile>`, the tree of one profile. */
export function minimaxProfileRoot(home: string, profile: string): string {
	return profile ? join(home, `${MINIMAX_DATA_DIR_BASENAME}-${profile}`) : join(home, MINIMAX_DATA_DIR_BASENAME);
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<home>/.mavis[-<profile>]` when it is a different tree, `null` when it is not. */
export function minimaxLegacyDataDir(home: string, profile = ""): string | null {
	const legacy = profile
		? join(home, `${MINIMAX_LEGACY_DATA_DIR_BASENAME}-${profile}`)
		: join(home, MINIMAX_LEGACY_DATA_DIR_BASENAME);
	const current = minimaxProfileRoot(home, profile);
	if (!existsSync(legacy)) return null;
	if (sameDirectory(legacy, current)) return null;
	return legacy;
}

// Long-form design notes: docs/dev/migration-sources.md
/** True when two paths name one directory, following a link at the candidate. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** What a data directory holds, as MiniMax itself decides it before it moves a legacy tree in. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `<root>/AGENTS.md`, the one global instruction file with one spelling. */
export function minimaxGlobalInstructionsPath(root: string): string {
	return join(root, "AGENTS.md");
}

/** `<root>/v2` — the current on-disk generation; everything below hangs off it. */
export function minimaxV2Root(root: string): string {
	return join(root, "v2");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<root>/v2/sessions`, one dated directory per session, four levels deep. */
export function minimaxSessionsRoot(root: string): string {
	return join(minimaxV2Root(root), "sessions");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<root>/v2/sqlite/runtime-state.sqlite`, the only place the row fields are written. */
export function minimaxRuntimeStateDb(root: string): string {
	return join(minimaxV2Root(root), "sqlite", "runtime-state.sqlite");
}

/** `<root>/v2/chats` — the pre-`v2` layout's ledgers, kept for migration only. */
export function minimaxLegacyChatsDir(root: string): string {
	return join(minimaxV2Root(root), "chats");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<root>/v2/mcode/drafts`, unsent composer text rather than history. */
export function minimaxDraftsDir(root: string): string {
	return join(minimaxV2Root(root), "mcode", "drafts");
}

/** `<root>/agents` — user subagent profiles; `<root>/agents/<name>/skills` sits inside. */
export function minimaxAgentsDir(root: string): string {
	return join(root, "agents");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<root>/skills`, the user's own MiniMax skills rather than the borrowed trees. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `<root>/mcp.json`, the only file MiniMax connects from. */
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
