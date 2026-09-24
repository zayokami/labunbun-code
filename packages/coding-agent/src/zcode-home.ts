import { basename, join, resolve } from "node:path";

/** The directory ZCode uses when neither of its variables names one. */
export const ZCODE_DEFAULT_DIR = ".zcode";

/**
 * The beta channel's storage root: a *sibling* of {@link ZCODE_DEFAULT_DIR},
 * not a child of it (`applyBetaStorageDefault` in the CLI's `env.ts`).
 */
export const ZCODE_BETA_DIR = ".zcode-beta";

/**
 * Where ZCode keeps the half of its state the desktop app owns: the `v2/`
 * config, the session index, the credential store.
 *
 * `$ZCODE_DATA_BASE_DIR` moves that tree by re-rooting it under a `.zcode`
 * directory (`getZCodeDataRootDir` in `packages/services/src/paths.ts`:
 * `join(getDataBaseDir(), ".zcode")`), so the variable names a *base*, not the
 * tree itself — the relationship `$DSH_HOME` and `$KIMI_CODE_HOME` have and
 * `$GROK_HOME` and `$CODEX_HOME` do not.
 *
 * Three details, each a directory the other reading of the variable would miss:
 *
 *   - A whitespace-only value is **unset**, not a directory named a space. The
 *     source is `process.env.ZCODE_DATA_BASE_DIR?.trim() || null`, so a tab is
 *     already `null` before anything reads it. This is the harness's rule, not
 *     grok's or Codex's.
 *   - The trimmed value is joined onto, never expanded or canonicalized.
 *     `$ZCODE_DATA_BASE_DIR=~/elsewhere` names a directory literally called `~`
 *     under the working directory, which is what ZCode opens.
 *   - `setDataBaseDir()` is the only thing that outranks the variable, and it is
 *     called inside ZCode's own process. A migration runs in a different
 *     process, so the variable is the most there is.
 *
 * `$ZCODE_HOME` is in the environment too and is deliberately not read: it names
 * a macOS computer-use helper's install root (`node.ts` in the same package),
 * not any configuration.
 */
export function zcodeRoot(home: string): string {
	const base = process.env.ZCODE_DATA_BASE_DIR?.trim();
	return join(base === undefined || base === "" ? home : base, ZCODE_DEFAULT_DIR);
}

/**
 * `<home>/.zcode/cli` — where the CLI's own config file is, and the one
 * directory of this source that **no variable moves**.
 *
 * `getDefaultConfigPath()` in the CLI's `file-config.adapter.ts` is
 * `join(resolvePath("~/.zcode/cli"), "config.json")` with no environment
 * consulted, and the `userConfigPath` that could have overridden it is a
 * programmatic option nothing in the repository sets from the environment. So
 * `$ZCODE_STORAGE_DIR` and `$ZCODE_SESSION_DB_PATH` move the plugin cache, the
 * rollout logs and the database, and leave `config.json` behind — a split that is
 * invisible while everything sits in one directory, and the whole reason this
 * source has two roots rather than one.
 */
export function zcodeCliConfigDir(home: string): string {
	return join(home, ZCODE_DEFAULT_DIR, "cli");
}

/**
 * Where ZCode keeps what the CLI owns *besides* its config: the plugin cache,
 * the rollout logs, the per-project memory roots.
 *
 * A separate root from {@link zcodeRoot}, and the two can disagree. ZCode's own
 * defaults are independent — `DefaultRuntimeConfig.storage.dir` is the literal
 * `~/.zcode` and never consults `ZCODE_DATA_BASE_DIR` — so a user who moved the
 * desktop tree has a `v2/` under the new base and a `cli/` under `$HOME` unless
 * they moved both.
 *
 * The value is read the way ZCode reads it, which is *not* the way the root above
 * is read. `$ZCODE_STORAGE_DIR` becomes `storage.dir` through the env adapter, and
 * `storage.dir` is then passed to `resolvePath` in `file-config.adapter.ts`: a
 * leading `~/` expands against the home directory and anything else is resolved
 * against the working directory. So here the value **is** expanded and
 * absolutized — the opposite of `zcodeRoot`, and the reason this is a second
 * function rather than a flag on the first.
 *
 * Three details, each deciding a directory the other reading would miss:
 *
 *   - The environment outranks the file outright and takes the value **raw**.
 *     `createConfig` lists its sources lowest to highest with `ZCODE_*` (scope
 *     `Env`) above the user config file (scope `User`), and the env adapter's
 *     `STORAGE_DIR` branch is a bare `config.storage.dir = value` with no trim. A
 *     blank `$ZCODE_STORAGE_DIR` is therefore a real value that points ZCode at
 *     the working directory, not an absent one — the same shape as grok's and
 *     Codex's variables, and the opposite of the desktop half above.
 *   - The **file's** value must be a non-empty string: `storageSchema` is
 *     `z.string().min(1).optional()` and a rejected key is left out. Whitespace is
 *     a value there; the empty string is not.
 *   - `storage.dir` is **not** where the session database lives. See
 *     {@link zcodeDbPath}, which is a separate key for exactly that.
 *
 * `cliConfig` is the already-read `cli/config.json`, because a user who moved the
 * tree with a setting rather than a variable cannot be found any other way: the
 * file that records the move is the one file in this source that does not move
 * with them.
 *
 * Deliberately not read: the project config files, which `createConfig` ranks
 * between the user file and the environment. Those are per-repository, and a
 * migration runs once over a home rather than once per checkout, so the user-level
 * answer is the one reported.
 */
export function zcodeStorageDir(home: string, cliConfig: Record<string, unknown>): string {
	const fromEnv = process.env.ZCODE_STORAGE_DIR;
	if (fromEnv !== undefined) return resolveZcodePath(fromEnv, home);
	const configured = zcodeConfiguredStorageValue(cliConfig, "dir");
	return configured === undefined ? join(home, ZCODE_DEFAULT_DIR) : resolveZcodePath(configured, home);
}

/** A `storage.<key>` out of the CLI config, when the file's schema would have kept it. */
function zcodeConfiguredStorageValue(cliConfig: Record<string, unknown>, key: string): string | undefined {
	const storage = cliConfig.storage;
	if (typeof storage !== "object" || storage === null) return undefined;
	const value = (storage as Record<string, unknown>)[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** ZCode's `resolvePath`: `~/x` against the home directory, anything else absolutized. */
function resolveZcodePath(value: string, home: string): string {
	return value.startsWith("~/") ? join(home, value.slice(2)) : resolve(value);
}

/**
 * The `cli/` directory, which is where the plugin cache and the rollout logs live.
 *
 * ZCode appends `cli` unless the storage directory it was given is already named
 * `cli` (`getCliStorageRoot` in the bootstrap's `paths.ts`), so a
 * `$ZCODE_STORAGE_DIR` pointing straight at a CLI directory is not doubled up.
 */
export function zcodeCliDir(home: string, cliConfig: Record<string, unknown>): string {
	const storage = zcodeStorageDir(home, cliConfig);
	return basename(storage) === "cli" ? storage : join(storage, "cli");
}

/**
 * The session database — the one file this importer reads as a database, and the
 * one the permission rules live in.
 *
 * **Not** under {@link zcodeCliDir}. It has a key of its own: `storage.sessionDbPath`,
 * defaulting to the literal `~/.zcode/cli/db/db.sqlite` in `DefaultRuntimeConfig`,
 * and `getSessionDbPath` hands that straight to `resolvePath` without consulting
 * `storage.dir` at all. `getDefaultSessionDbPath` in the session store spells the
 * same path out from `homedir()` a second time. So a user who moved `storage.dir`,
 * or set `$ZCODE_STORAGE_DIR`, has their plugins and logs in the new tree and
 * their **transcripts and permission rules still under the home** — reading the
 * database at `<cli>/db/db.sqlite` would find nothing there and report every rule
 * as absent, which is the failure this function exists to prevent.
 *
 * It moves for one of three reasons, in the order ZCode applies them:
 * `$ZCODE_SESSION_DB_PATH`, then `$ZCODE_SESSION_DB` (the env adapter tests them
 * in that order off the one `ZCODE_` prefix), then the file's
 * `storage.sessionDbPath`.
 */
export function zcodeDbPath(home: string, cliConfig: Record<string, unknown>): string {
	const fromEnv = process.env.ZCODE_SESSION_DB_PATH ?? process.env.ZCODE_SESSION_DB;
	if (fromEnv !== undefined) return resolveZcodePath(fromEnv, home);
	const configured = zcodeConfiguredStorageValue(cliConfig, "sessionDbPath");
	// Spelled with the `~/` prefix because that is how the default is written in
	// `DefaultRuntimeConfig`, and `resolveZcodePath` is what turns it into a path
	// under the home — a bare `.zcode/...` would be resolved against the working
	// directory instead, which is how the default ends up somewhere nobody installed it.
	return configured === undefined
		? resolveZcodePath(`~/${ZCODE_DEFAULT_DIR}/cli/db/db.sqlite`, home)
		: resolveZcodePath(configured, home);
}

/**
 * The beta channel's tree, beside the default one.
 *
 * A beta install keeps its CLI state here instead of in `~/.zcode`, chosen by the
 * CLI's own runtime: `$ZCODE_BETA=1`, `$ZCODE_ENV=beta`, or a binary whose path
 * says `zcode-beta`. The first two are readable from an environment; the third is
 * not — it is decided by the name this importer is not running under — so a beta
 * user whose stable binary name is first on their `PATH` cannot be told apart from
 * one who never installed the beta at all. The reader therefore only *names* this
 * tree when it finds one and leaves the choice to the user, rather than importing a
 * channel it cannot confirm.
 *
 * Relative to `home` and not to {@link zcodeRoot}'s base, because that is how ZCode
 * writes it: `join(homedir(), ".zcode-beta")`, unconditionally. Its config file is
 * not in there — see {@link zcodeCliConfigDir} — so what lives under it is the
 * database, the plugins and the logs, and the first two of those are named in
 * {@link zcodeDbPath}'s terms: a beta channel that set its own `sessionDbPath` is
 * the one case where its database is not beside its plugins.
 */
export function zcodeBetaDir(home: string): string {
	return join(home, ZCODE_BETA_DIR);
}
