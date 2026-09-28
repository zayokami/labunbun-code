/**
 * Where Cursor keeps everything this importer looks at.
 *
 * **The citations in this module are of two kinds, and the difference changes
 * what a reader owes the user.** Most are documentation-level: a second-hand
 * claim with a date on it, checkable only against Cursor's published pages,
 * because Cursor ships no public tree. A few are source-level, read out of the
 * minified bundle the CLI actually ships and cited as **module path + function
 * name + build id** — never as a `file:line`, which would be invented precision
 * about a file nobody can open. Each claim below says which kind it is. The
 * source-level ones are the CLI's own path arithmetic, the part that is
 * impossible to get right from documentation and that had been got wrong twice.
 *
 * Four directories, and they are easy to confuse:
 *
 *   - the CLI's own home — `~/.cursor/` unless one of two environment variables
 *     says otherwise, so it is **not necessarily under the home at all**. Four
 *     files live here and **each is a different format**: `cli-config.json` (the
 *     global CLI config), `hooks.json` (the global hooks), `mcp.json` (the global
 *     MCP servers), and `permissions.json`, which belongs to the *IDE* and is
 *     read by neither this importer nor `cursor-agent`. Official docs, all four
 *     paths.
 *   - `<project>/.cursor/` — the project half. `rules/`, `mcp.json`,
 *     `hooks.json`, and `cli.json`. Official.
 *   - the editor's user-data directory, which is VS Code–derived and lives
 *     outside the home on two of three platforms.
 *   - `<cli home>/chats/<md5 of the resolved cwd>/` — where the CLI's one prompt
 *     list is. It is *neither* of the above: a different subtree of the CLI's own
 *     home, one directory per workspace, and the only Cursor path this importer
 *     has that no official page documents.
 *
 * The naming is deliberately asymmetric and this module keeps it: the global CLI
 * file is `cli-config.json` and the project one is `cli.json`. A reader that
 * guessed symmetrically would read a project file that does not exist and miss
 * the one that does.
 *
 * Nothing here creates anything. Every function computes strings; the two that
 * answer "is it there" answer with `existsSync` and nothing more.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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

/**
 * Which rule put the CLI's config root where it is, for the report to say.
 *
 * Three rules, in the order the source applies them, and the first two can put
 * the root **outside the user's home entirely** — which is why this is a union
 * rather than a boolean and why {@link cursorConfigRoot} hands the rule back
 * rather than only the path. A reader who cannot tell "the default" from "you
 * set `CURSOR_CONFIG_DIR`" has no way to check the importer's work, and the two
 * look identical in a path listing.
 */
export type CursorConfigRootOrigin = "cursor-config-dir" | "xdg-config-home" | "default";

/**
 * The CLI's own home: `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else
 * `~/.cursor`.
 *
 * **Source-level, verified against the shipped bundle** — module
 * `cursor-config/dist/paths.js`, function `WI()`, build `2026.09.26-dd393fe`:
 *
 * ```js
 * function a(){
 *   const e=process.env.CURSOR_CONFIG_DIR;
 *   if(null==e?void 0:e.trim())return e;
 *   const t=process.env.XDG_CONFIG_HOME;
 *   return(null==t?void 0:t.trim())?(0,i.join)(t,"cursor"):(0,i.join)((0,s.homedir)(),".cursor");
 * }
 * ```
 *
 * Three details in five lines, and the importer was wrong about all three before
 * this was checked against that function:
 *
 *   - **The variable is `CURSOR_CONFIG_DIR`, and the middle one is
 *     `XDG_CONFIG_HOME`** — not the `~/.cursor` the importer used to hard-code.
 *     On a Linux desktop that exports `XDG_CONFIG_HOME` the config genuinely
 *     lives at `$XDG_CONFIG_HOME/cursor`, `~/.cursor` does not exist, every read
 *     came back empty, and the report said **nothing at all**: no file, no
 *     directory, no "not installed" either, because the importer reported the
 *     source as absent while the evidence it was looking for was one directory
 *     away.
 *   - **The test is `value?.trim()` being truthy, so whitespace-only is not a
 *     value.** `CURSOR_CONFIG_DIR=" "` falls through to the next rule rather than
 *     resolving to a path relative to the working directory, which is what
 *     `join(" ", "cli-config.json")` would produce. This is the same convention
 *     the other importers in this repo use.
 *   - **The override is returned verbatim, not trimmed.** The source trims to
 *     *test* and returns the original, and that is reproduced here rather than
 *     tidied: a value with a stray trailing space points where the source points.
 *
 * The default is `join(home, ".cursor")` — the same three files the official
 * configuration page documents, which is why the documentation-level citations
 * for those files survived the root becoming conditional: the path is the
 * documented one whenever neither variable is set.
 */
export function cursorConfigRoot(home: string): { root: string; origin: CursorConfigRootOrigin } {
	const override = process.env.CURSOR_CONFIG_DIR;
	if (override?.trim()) return { root: override, origin: "cursor-config-dir" };
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg?.trim()) return { root: join(xdg, "cursor"), origin: "xdg-config-home" };
	return { root: join(home, CURSOR_DIR_BASENAME), origin: "default" };
}

/**
 * The CLI's home as a bare path — {@link cursorConfigRoot} without the origin.
 *
 * The wrapper rather than the other way round, and the reason is scope: the
 * origin is what a *report* wants, and threading `{ root, origin }` through the
 * three consumers that only ever join a path would be churn in files this batch
 * does not own. A caller that needs to say which rule answered asks
 * {@link cursorConfigRoot}. The `home` argument is the **last** fallback, so a
 * path from this function is not necessarily under it.
 */
export function cursorUserRoot(home: string): string {
	return cursorConfigRoot(home).root;
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
 * Two, and the second one is why the CLI's home alone is not enough. A user who
 * has used the IDE and never run the CLI has no CLI home at all — its files are
 * created by the command, and the editor's own state goes to the user-data
 * directory. Detection that looked only at the CLI home would call Cursor absent
 * on exactly the machine where a Cursor install most obviously exists, and then
 * the import would find the workspace databases and the prompt list anyway.
 *
 * Both are returned rather than the one that answered, because `detectSources`
 * asks "is any of these non-empty" and a user may have either. The first is
 * {@link cursorUserRoot}, so it moves with `CURSOR_CONFIG_DIR`; a user who
 * relocated the root is detected through the relocated one.
 */
export function cursorDetectionRoots(home: string): string[] {
	return [cursorUserRoot(home), cursorUserDataRoot(home).root];
}

// ---------------------------------------------------------------------------
// The CLI's prompt list
// ---------------------------------------------------------------------------

/**
 * `<cli home>/chats/<md5 of the resolved cwd>` — the per-workspace subtree the
 * CLI keeps its own state in.
 *
 * **Source-level, verified against the shipped bundle** — module
 * `./src/state/index.ts` (build `2026.09.26-dd393fe`), the three functions
 * webpack calls `mh`, `wk` and `r7`:
 *
 * ```js
 * function s(){return(0,o.join)((0,i.WI)(),"chats")}
 * function a(e){const t=(0,o.resolve)(e),n=(0,r.createHash)("md5").update(t).digest("hex");return(0,o.join)(s(),n)}
 * function d(){return a(process.cwd())}   // exported as r7
 * ```
 *
 * **This md5 is recomputable, and it is not the hash two functions up this file.**
 * Both are md5, both are called "the workspace hash", and they are computed from
 * completely different things:
 *
 *   - **This one** is `md5(resolve(cwd))` and nothing else. No timestamp, no
 *     inode, no creation time. Anyone can check it, which is why
 *     {@link cursorPromptHistoryFile} takes the cwd as an argument rather than
 *     scanning for a directory whose name it could not predict.
 *   - **The `state.vscdb` one** ({@link cursorStateDatabase}) mixes the folder's
 *     creation time into the digest, and is documented there as *not*
 *     recomputable. "It is the md5 of the folder path" is a loose description of
 *     that one, and this one is the exact recipe for the other.
 *
 * They are kept apart deliberately. A reader who assumes the recomputable rule
 * applies to `state.vscdb` will compute a digest that matches nothing and
 * conclude the install is broken; a reader who assumes `state.vscdb`'s rule
 * applies here will not notice that the prompt list is missing when it is not.
 */
function cursorChatsDir(configRoot: string, cwd: string): string {
	return join(configRoot, "chats", createHash("md5").update(resolve(cwd)).digest("hex"));
}

/**
 * `<cli home>/chats/<md5>/view/prompt_history.json` — the CLI's ↑ recall list,
 * named whether or not it is there.
 *
 * **Source-level, verified against the shipped bundle** — module
 * `./src/history/prompt-history.ts`, function `c(e)` (build `2026.09.26-dd393fe`):
 *
 * ```js
 * function c(e){return(0,r.join)((0,s.r7)(),e,"prompt_history.json")}   // called as c("view")
 * ```
 *
 * The importer used to look for `~/.config/cursor/prompt_history.json` and
 * `$XDG_CONFIG_HOME/cursor/prompt_history.json`, guessing between two
 * second-hand spellings because no official page documents the file. **Neither
 * guess was a path the source ever writes to**: the root is
 * {@link cursorConfigRoot} — the same root as `cli-config.json` — and the
 * `chats/<md5>/` segments were missing entirely, so the file had never been
 * found on any machine. It is one of the four pillars of the source's `present`
 * flag, so a user who had typed prompts and written no rule, config or server
 * file was reported as having nothing to migrate.
 *
 * Returned unconditionally, because "there is no list" is a report sentence and
 * a report that cannot name the directory it looked in is a report the user
 * cannot check.
 *
 * **Named, not read, alongside it:** `pasted_text.json`, in the same `chats/<md5>/`
 * directory and built by the same `join(base, sub, name)` shape — module
 * `./src/history/pasted-text-store.ts` (build `2026.09.26-dd393fe`). The bodies of
 * pasted blocks are not prompts and are not imported.
 */
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
