/**
 * Where Cursor keeps everything this importer looks at.
 *
 * **The citations in this module are documentation-level, not source-level.**
 * That is a real difference from `opencode-home.ts`, where every claim points at
 * a line of a tree that was on disk (`G:\Bunttta\opencode-dev`), and it changes
 * what a reader owes the user. A file:line citation can be checked by opening the
 * file; a documentation citation is a second-hand claim with a date on it, and
 * Cursor ships no public tree to check it against. So each claim below says which
 * kind it is, and the ones that are *not* official are the ones this module is
 * most careful about.
 *
 * Four directories, and they are easy to confuse:
 *
 *   - `~/.cursor/` — the CLI's own home. Four files live here and **each is a
 *     different format**: `cli-config.json` (the global CLI config), `hooks.json`
 *     (the global hooks), `mcp.json` (the global MCP servers), and
 *     `permissions.json`, which belongs to the *IDE* and is read by neither this
 *     importer nor `cursor-agent`. Official docs, all four paths.
 *   - `<project>/.cursor/` — the project half. `rules/`, `mcp.json`,
 *     `hooks.json`, and `cli.json`. Official.
 *   - the editor's user-data directory, which is VS Code–derived and lives
 *     outside the home on two of three platforms.
 *   - `~/.config/cursor/` — where the CLI's one prompt list is, which is
 *     *neither* of the above and is the only Cursor path this importer has that
 *     no official page documents.
 *
 * The naming is deliberately asymmetric and this module keeps it: the global CLI
 * file is `cli-config.json` and the project one is `cli.json`. A reader that
 * guessed symmetrically would read a project file that does not exist and miss
 * the one that does.
 *
 * Nothing here creates anything. Every function computes strings; the two that
 * answer "is it there" answer with `existsSync` and nothing more.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The directory name, in the project half and the user half alike. */
export const CURSOR_DIR_BASENAME = ".cursor";

/**
 * The files under `~/.cursor` this importer reads, and what each one is.
 *
 * The asymmetry is Cursor's own: `cli-config.json` is global and `cli.json` is
 * the project file, and they are not two scopes of one document — the official
 * configuration page says only *permissions* may be set in the project one.
 * `permissions.json` is left out on purpose. It is a third permission system
 * belonging to the IDE, with a different schema again, overridden by the in-app
 * command allowlist, and read by neither `cursor-agent` nor the file beside it;
 * a migration that read it would be importing the one list the CLI never applied.
 */
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

/** `~/.cursor` — the CLI's home, and the home of the three files above. */
export function cursorUserRoot(home: string): string {
	return join(home, CURSOR_DIR_BASENAME);
}

/** `<cwd>/.cursor` — the project half, relative to the directory a run is in. */
export function cursorProjectRoot(cwd: string): string {
	return join(cwd, CURSOR_DIR_BASENAME);
}

/** The extension Cursor's project and user rules carry, and the one it ignores. */
export const CURSOR_RULE_EXTENSION = ".mdc";

// ---------------------------------------------------------------------------
// The editor's own storage
// ---------------------------------------------------------------------------

/** Which rule put the user-data directory where it is, for the report to say. */
export type CursorUserDataOrigin = "appdata" | "macos-application-support" | "xdg-config-home" | "default";

/**
 * `%APPDATA%\Cursor\User` and its two siblings — the directory Cursor inherited
 * from VS Code, which is *not* under the home on Windows or macOS.
 *
 * This is the one Cursor path with a hard platform branch, and it is why the
 * report names the directory rather than printing a path: a reader looking in
 * `~/.cursor` for the editor's state will not find it, and on Windows the place
 * to look is the one place a POSIX-shaped importer never looks.
 *
 * The three spellings are the VS Code convention, which Cursor inherits as a
 * fork. `%APPDATA%` is honoured when it is set and non-empty; an unset or
 * whitespace-only value falls through to the platform default rather than
 * resolving to a path relative to the process's working directory, which is what
 * `join("", "Cursor", "User")` would produce.
 */
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

/**
 * `<user data>/workspaceStorage/<hash>/state.vscdb`, named only.
 *
 * Two facts make this a name and never an open. The chat bodies live inside it,
 * and they are the one part of a Cursor install this importer cannot carry:
 * Cursor is a VS Code fork, so a chat is an editor state record rather than a
 * transcript, and the record is keyed by a workspace hash that **cannot be
 * recomputed** — VS Code mixes the folder's creation time into the digest
 * (`src/vs/platform/workspaces/node/workspaces.ts`,
 * `createHash('md5').update(folderUri.fsPath).update(ctime ? String(ctime) : '')`),
 * which is why the widely repeated "it is the md5 of the folder path" is a
 * loose description rather than a recipe. And the report must not imply the hash
 * is addressable, or a user will try to match it by hand.
 */
export function cursorStateDatabase(userData: string, workspace: string): string {
	return join(cursorWorkspaceStorageDir(userData), workspace, "state.vscdb");
}

/** `<user data>/globalStorage/state.vscdb`, named only — the composer index, not the messages. */
export function cursorGlobalStateDatabase(userData: string): string {
	return join(userData, "globalStorage", "state.vscdb");
}

/**
 * The trees whose being non-empty means "Cursor is here".
 *
 * Two, and the second one is why `~/.cursor` alone is not enough. A user who has
 * used the IDE and never run the CLI has no `~/.cursor` at all — its files are
 * created by the command, and the editor's own state goes to the user-data
 * directory. Detection that looked only at the home would call Cursor absent on
 * exactly the machine where a Cursor install most obviously exists, and then the
 * import would find the workspace databases and the prompt list anyway.
 *
 * Both spellings are returned rather than the one that answered, because
 * `detectSources` asks "is any of these non-empty" and a user may have either.
 */
export function cursorDetectionRoots(home: string): string[] {
	return [cursorUserRoot(home), cursorUserDataRoot(home).root];
}

// ---------------------------------------------------------------------------
// The CLI's prompt list
// ---------------------------------------------------------------------------

/**
 * `~/.config/cursor/prompt_history.json` — the one Cursor path here that **no
 * official page documents**, and the only one with a real uncertainty about
 * where it is.
 *
 * Two spellings are in play and the sources disagree about whether both are
 * used. The path is written XDG-style, and a tool that catalogues the format
 * gives it literally as `${HOME}/.config/cursor/`; a Cursor forum report gives
 * it as `cursor/prompt_history.json` *or* `$XDG_CONFIG_HOME/cursor/…`, which
 * says both are consulted. So both are tried, in that order, and whichever is
 * there is the one read — with the one that answered named in the report, since
 * a file the user cannot find is a file they will assume was not imported.
 *
 * `null` when neither is there, rather than a path to a file that is not.
 */
export function cursorPromptHistoryFile(home: string): { path: string; origin: "xdg-config-home" | "default" } | null {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (xdg) {
		const path = join(xdg, "cursor", "prompt_history.json");
		if (existsSync(path)) return { path, origin: "xdg-config-home" };
	}
	const path = join(home, ".config", "cursor", "prompt_history.json");
	if (existsSync(path)) return { path, origin: "default" };
	return null;
}
