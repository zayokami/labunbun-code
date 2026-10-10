// Cursor's state: the CLI's own home, the project half, the editor's user-data directory and
// the per-workspace prompt list, each resolved by the rule the shipped bundle uses.
// Long-form design notes: docs/dev/migration-sources.md

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** The directory name, in the project half and the user half alike. */
export const CURSOR_DIR_BASENAME = ".cursor";

// Long-form design notes: docs/dev/migration-sources.md
/** The files under `~/.cursor` this importer reads, and what each one is. */
export const CURSOR_USER_FILES: Readonly<Record<string, string>> = {
	"cli-config.json": "the CLI's global configuration — permissions, model, approval mode, sandbox and network",
	"hooks.json": "the CLI's global hooks",
	"mcp.json": "the CLI's global MCP servers",
};

/** The same, for the project half, where only permissions are project-scoped. */
export const CURSOR_PROJECT_FILES: Readonly<Record<string, string>> = {
	"cli.json": "the project CLI file, which Cursor documents as permissions-only",
	"hooks.json": "the project's hooks, version-controlled with the repository",
	"mcp.json": "the project's MCP servers",
};

// Long-form design notes: docs/dev/migration-sources.md
/** Which rule put the CLI's config root where it is, for the report to say. */
export type CursorConfigRootOrigin = "cursor-config-dir" | "xdg-config-home" | "default";

// Long-form design notes: docs/dev/migration-sources.md
/** The CLI's own home: `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`. */
export function cursorConfigRoot(home: string): { root: string; origin: CursorConfigRootOrigin } {
	const override = process.env.CURSOR_CONFIG_DIR;
	if (override?.trim()) return { root: override, origin: "cursor-config-dir" };
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg?.trim()) return { root: join(xdg, "cursor"), origin: "xdg-config-home" };
	return { root: join(home, CURSOR_DIR_BASENAME), origin: "default" };
}

// Long-form design notes: docs/dev/migration-sources.md
/** The CLI's home as a bare path: `cursorConfigRoot` without the origin. */
export function cursorUserRoot(home: string): string {
	return cursorConfigRoot(home).root;
}

/** `<cwd>/.cursor` — the project half, relative to the directory a run is in. */
export function cursorProjectRoot(cwd: string): string {
	return join(cwd, CURSOR_DIR_BASENAME);
}

// ---------------------------------------------------------------------------
// The data root, and the one tree under it this importer only ever names
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** `$CURSOR_DATA_DIR`, else `~/.cursor`, a different root from the config root. */
export function cursorDataRoot(home: string): string {
	const override = process.env.CURSOR_DATA_DIR;
	return override?.trim() ? override : join(home, CURSOR_DIR_BASENAME);
}

/** `<data root>/projects` — `m4()` in the same module, one directory per workspace. */
export function cursorProjectDataRoot(home: string): string {
	return join(cursorDataRoot(home), "projects");
}

// Long-form design notes: docs/dev/migration-sources.md
/** The files under `projects/<workspace>/` this importer names, and which is which. */
export const CURSOR_PROJECT_DATA_FILES: Readonly<Record<string, "credential" | "decision">> = {
	"mcp-auth.json": "credential",
	"mcp-approvals.json": "decision",
	"mcp-disabled.json": "decision",
};

// The per-workspace directory name is deliberately not computed here, and the reasons why.
// Long-form design notes: docs/dev/migration-sources.md

/** The extension Cursor's project and user rules carry, and the one it ignores. */
export const CURSOR_RULE_EXTENSION = ".mdc";

// ---------------------------------------------------------------------------
// The asset directories
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The three directories Cursor reads its reusable text out of. */
export type CursorAssetKind = "commands" | "agents" | "skills";

/** `<root>/.cursor/<kind>`, for whichever half `root` is. */
export function cursorAssetDir(root: string, kind: CursorAssetKind): string {
	return join(root, kind);
}

// ---------------------------------------------------------------------------
// The editor's own storage
// ---------------------------------------------------------------------------

/** Which rule put the user-data directory where it is, for the report to say. */
export type CursorUserDataOrigin = "appdata" | "macos-application-support" | "xdg-config-home" | "default";

// Long-form design notes: docs/dev/migration-sources.md
/** `%APPDATA%\Cursor\User` and its two siblings, the directory Cursor inherits from VS Code. */
export function cursorUserDataRoot(home: string): { root: string; origin: CursorUserDataOrigin } {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA?.trim();
		if (appData) return { root: join(appData, "Cursor", "User"), origin: "appdata" };
		return { root: join(home, "AppData", "Roaming", "Cursor", "User"), origin: "default" };
	}
	if (process.platform === "darwin") {
		return {
			root: join(home, "Library", "Application Support", "Cursor", "User"),
			origin: "macos-application-support",
		};
	}
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (xdg) return { root: join(xdg, "Cursor", "User"), origin: "xdg-config-home" };
	return { root: join(home, ".config", "Cursor", "User"), origin: "default" };
}

/** `<user data>/workspaceStorage` — one directory per opened workspace. */
export function cursorWorkspaceStorageDir(userData: string): string {
	return join(userData, "workspaceStorage");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<user data>/workspaceStorage/<hash>/state.vscdb`, named only. */
export function cursorStateDatabase(userData: string, workspace: string): string {
	return join(cursorWorkspaceStorageDir(userData), workspace, "state.vscdb");
}

/** `<user data>/globalStorage/state.vscdb`, named only — the composer index, not the messages. */
export function cursorGlobalStateDatabase(userData: string): string {
	return join(userData, "globalStorage", "state.vscdb");
}

// Long-form design notes: docs/dev/migration-sources.md
/** The trees whose non-empty state means Cursor is here. */
export function cursorDetectionRoots(home: string): string[] {
	return [cursorUserRoot(home), cursorUserDataRoot(home).root];
}

// ---------------------------------------------------------------------------
// The CLI's prompt list
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** `<cli home>/chats/<md5 of the resolved cwd>`, the per-workspace subtree. */
function cursorChatsDir(configRoot: string, cwd: string): string {
	return join(configRoot, "chats", createHash("md5").update(resolve(cwd)).digest("hex"));
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<cli home>/chats/<md5>/view/prompt_history.json`, the CLI's up-arrow recall list. */
export function cursorPromptHistoryPath(home: string, cwd: string): string {
	return join(cursorChatsDir(cursorUserRoot(home), cwd), "view", "prompt_history.json");
}

/**
 * {@link cursorPromptHistoryPath}, when there is something at it — and which of
 * the three config-root rules put the root where it is, so the report can name it
 * rather than print a path the reader has no way to connect to their own disk.
 *
 * `null` when nothing is there, rather than a path to a file that is not.
 */
export function cursorPromptHistoryFile(
	home: string,
	cwd: string,
): { path: string; origin: CursorConfigRootOrigin } | null {
	const config = cursorConfigRoot(home);
	const path = join(cursorChatsDir(config.root, cwd), "view", "prompt_history.json");
	return existsSync(path) ? { path, origin: config.origin } : null;
}
