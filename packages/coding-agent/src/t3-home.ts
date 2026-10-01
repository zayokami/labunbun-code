import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** The directory T3 Code keeps its state in when `$T3CODE_HOME` names none. */
export const T3_DEFAULT_DIR = ".t3";

/**
 * The state directory inside the base directory.
 *
 * T3 derives this twice, independently, and the two rules are *not* the same.
 * The Electron shell reads
 * `useDevSubdir = isDevelopment && $T3CODE_HOME is none`
 * (`apps/desktop/src/app/DesktopStatePaths.ts:23-32`, the flag computed at
 * `:29-30`), and the server reads
 * `devUrl !== undefined && !baseDirIsExplicit`
 * (`apps/server/src/config.ts:136-139`). They agree only on what a released
 * build does, which is the half that matters here: with no dev server and no
 * flag, both land on `userdata`.
 *
 * Neither dev half can be reproduced by a migrator, and this function does not
 * pretend otherwise. `isDevelopment` is the packaged app's own flag — set when
 * `VITE_DEV_SERVER_URL` names a dev server — and `devUrl` is a server argument,
 * so a migrator is never the build either of them describes and always computes
 * the production directory, which is the one a user who installed T3 has.
 *
 * A user who *did* run a dev build has their state in `~/.t3/dev` instead, and
 * {@link t3StateDirs} reads it as a second root rather than leaving it
 * unreachable. Reading it is not pretending to be the dev build; it is not
 * reading the tree a user who never ran one would have.
 */
export const T3_STATE_SUBDIR = "userdata";

/** The subdirectory a dev build uses, read as a second root. See {@link T3_STATE_SUBDIR}. */
export const T3_DEV_STATE_SUBDIR = "dev";

/**
 * `$T3CODE_HOME` trimmed and resolved, else `<home>/.t3`.
 *
 * Ported from `resolveDesktopBaseDir`
 * (`apps/desktop/src/app/DesktopStatePaths.ts:13-21`), including the detail that
 * reads like an accident and is not: the override is `resolve()`d, so a relative
 * `$T3CODE_HOME` resolves against this process's working directory rather than
 * the source home. T3 is an Electron app whose working directory is wherever the
 * user launched it from, which is genuinely ambiguous for a relative value —
 * but T3 resolves it against *its own* cwd and so does this, and pretending
 * otherwise would put the state directory somewhere T3 would never have written
 * it. An empty or whitespace-only value is unset, matching
 * `normalizeConfiguredBaseDir`, which trims before testing
 * (`DesktopStatePaths.ts:6-11`).
 *
 * The server has a second spelling of this — a `--base-dir` flag that also sets
 * the base directory (`apps/server/src/cli/config.ts:316-330`). A migration has
 * no argv, so only the variable is read, and a user who launched T3 with that
 * flag has their state wherever the flag pointed, which this reports as absent.
 * That is a false negative in the safe direction: the importer finds nothing and
 * says so rather than reading a tree the flag never named.
 */
export function t3BaseDir(home: string): string {
	const override = process.env.T3CODE_HOME?.trim();
	if (override === undefined || override === "") return join(home, T3_DEFAULT_DIR);
	return resolve(override);
}

/** `<base dir>/userdata` — where an installed T3 Code keeps everything. */
export function t3StateDir(baseDir: string): string {
	return join(baseDir, T3_STATE_SUBDIR);
}

/**
 * Every state directory worth *detecting*, most authoritative first.
 *
 * Normally one has content. Both when the user has run a dev build as well as an
 * installed one, which is the only way the two subdirectories exist together: the
 * installed app writes `userdata` and a dev launch writes `dev`, and neither
 * removes the other's. Detection needs both so that a machine whose only T3 is a
 * dev checkout is not called empty — see `detectionRoots` in `migrate-types.ts`.
 *
 * **This function returns both directories; {@link t3Root} reads only the first
 * one with content in it.** That is deliberate and it is not the same as reading
 * both. A dev build's tree is the one an *installed* T3 would never resume, and a
 * migration's job is to reproduce what the user's tool does, not to union two
 * incompatible histories into one settings file. A dev tree that is not the one
 * read is not silently dropped either — `t3-plan.ts` names it — so "unreachable"
 * would be the wrong word for it here.
 */
export function t3StateDirs(home: string): string[] {
	const base = t3BaseDir(home);
	return [join(base, T3_STATE_SUBDIR), join(base, T3_DEV_STATE_SUBDIR)];
}

/**
 * The one state directory to read, or `null` when there is nothing to read.
 *
 * The production directory wins over the dev one even when both hold something,
 * so a session present in both is read from the tree an installed T3 would
 * resume. See {@link t3StateDirs} for why that is a choice rather than an
 * oversight.
 *
 * "Something to read" is the same test `sourceHasContent` applies to every other
 * source: a directory that exists but is empty has nothing in it, and offering a
 * migration from an empty tree is a question whose only answer still costs the
 * user a read and a keystroke.
 *
 * A directory that exists and cannot be read counts as empty, for the same
 * reason and not as an excuse: nothing can be imported from it either way.
 */
export function t3Root(home: string): string | null {
	for (const dir of t3StateDirs(home)) {
		if (treeHasContent(dir)) return dir;
	}
	return null;
}

/** Whether a directory exists and holds something, as `sourceHasContent` reads it. */
function treeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

/**
 * `<state dir>/settings.json` — the server-authoritative settings file.
 *
 * The name is the one T3 writes and the one its own schema is bound to
 * (`apps/desktop/src/app/DesktopEnvironment.ts:216`, and the server's own
 * `serverSettingsPath` at `apps/server/src/config.ts:149`, which is a second
 * derivation of the same path). This is *not* the Antigravity agent's
 * `settings.json`, which lives under that agent's own profile directory and is a
 * different file with an unrelated shape.
 */
export function t3SettingsPath(stateDir: string): string {
	return join(stateDir, "settings.json");
}

/** `<state dir>/client-settings.json` — the desktop client's UI preferences. */
export function t3ClientSettingsPath(stateDir: string): string {
	return join(stateDir, "client-settings.json");
}

/**
 * `<state dir>/desktop-settings.json` — the Electron shell's own state.
 *
 * Read for completeness of the report only. Every key in its schema
 * (`DesktopSettingsDocument`, `apps/desktop/src/settings/DesktopAppSettings.ts:98-115`)
 * is about the window, the update channel, Tailscale serving and the WSL
 * backend; none of it is a model, a permission, a rule or an asset, so nothing
 * here is claimed. The file is still named in the report, because a settings file
 * a user can see was silently not migrated is a worse experience than one the
 * report explains.
 */
export function t3DesktopSettingsPath(stateDir: string): string {
	return join(stateDir, "desktop-settings.json");
}

/**
 * `<state dir>/state.sqlite` — where conversations and projects live.
 *
 * Path from `apps/server/src/config.ts:140`. Opened with WAL journaling
 * (`PRAGMA journal_mode = WAL`, `apps/server/src/persistence/Layers/Sqlite.ts:20`)
 * and a 5000 ms busy timeout set *because* the CLI and the server write from
 * separate processes (`:18`), so the `-wal` and `-shm` siblings are expected
 * beside it and a missing `state.sqlite` is not evidence of an empty
 * installation.
 */
export function t3StateDatabase(stateDir: string): string {
	return join(stateDir, "state.sqlite");
}

/** `<state dir>/attachments/` — files a conversation referenced. */
export function t3AttachmentsDir(stateDir: string): string {
	return join(stateDir, "attachments");
}
