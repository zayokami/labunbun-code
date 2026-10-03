/**
 * Codewhale's user state: where its configuration home is, every path
 * `codewhale-read.ts` opens, and the trees this source names but never reads.
 *
 * **Every path claim in this module carries the `file:line` it was read from in
 * the reference workspace** (`G:\Bunttta\Codewhale-main`, a Rust Cargo
 * workspace). Unlike Qoder's — whose citations are literals out of a 12 MB
 * minified bundle because no line number there is stable — Codewhale is
 * readable Rust, so a line number is a real anchor and a claim can be checked
 * rather than believed. Read this module's citations as claims to re-verify, not
 * as decoration: two of them have already been corrected once (see the "Two
 * corrections" section below).
 *
 * ## The rename, and why it is the first thing to understand
 *
 * **Codewhale is a rename of DeepSeek-TUI, and `~/.deepseek` is a live fallback
 * root.** `LEGACY_APP_DIR = ".deepseek"` (`crates/paths/src/lib.rs:16`) is
 * declared as "Legacy DeepSeek-branded directory retained for compatibility
 * reads", and a large part of the product still reads through it. A user who
 * has used the product under its old name has their whole tree there and nothing
 * under `.codewhale`; a reader that looked only at `.codewhale` would report
 * them as having no Codewhale at all.
 *
 * **But the fallback is per-path, not global, and that is the hard part.** Three
 * different mechanisms implement it and they do not agree:
 *
 *   - `resolve_state_dir` (`crates/config/src/lib.rs:6158-6170`) — an
 *     existence-checked `primary` → `legacy` → `primary` for any state subdir.
 *   - `default_user_state_path_from_environment`
 *     (`crates/tui/src/config/paths.rs:240-263`) — the same
 *     existence-checked rule, spelled out per name, for `config.toml`,
 *     `mcp.json`, `skills`, `notes.txt` and `memory.md`.
 *   - **No fallback at all**, for everything routed through
 *     `codewhale_home()` — `agents/`, `fleets/`, `plugins/`, `themes/`,
 *     `audit.log`, `constitution.json`, `prompts/constitution.md`, `workflows/`.
 *
 * The table {@link CODEWHALE_LEGACY_FALLBACK} records which is which, per path,
 * and {@link codewhaleStatePath} reproduces mechanism 2 for the four names that
 * use it. Nothing here guesses: a path with no fallback is named as such.
 *
 * **One override disables every fallback**, and it is worth stating on its own
 * because it is the opposite of what "fallback" usually means. `codewhale_home_is_explicit()`
 * (`crates/config/src/lib.rs:6105-6111`) says so in the product's own words:
 * "An explicit CodeWhale home is an isolation boundary: state/config resolvers
 * must not fall back to ambient legacy `~/.deepseek` data outside that root."
 * A user who exports `CODEWHALE_HOME` to isolate a profile gets an empty
 * legacy tree on purpose, so falling back would read exactly the data they
 * isolated themselves from. Every resolver below reproduces that gate.
 *
 * ## Two corrections to the brief this module was written against
 *
 * Both were checked against the bytes and both change what an importer reads, so
 * they are recorded where the decision is taken rather than only here.
 *
 * 1. **`DEEPSEEK_HOME` is dead.** The brief said "`DEEPSEEK_*` env vars are live
 *    aliases" and that is true of most of them — `DEEPSEEK_APPROVAL_POLICY` and
 *    `DEEPSEEK_ALLOW_SHELL` are the second halves of explicit
 *    `[CODEWHALE_X, DEEPSEEK_X]` pairs at `crates/tui/src/settings.rs:4374-4375`,
 *    and `DEEPSEEK_API_KEY` is a live provider credential at
 *    `crates/config/src/provider.rs:794` and `:849`. **`DEEPSEEK_HOME` is not.**
 *    `legacy_deepseek_home_override()` (`crates/paths/src/lib.rs:70-78`) is the
 *    only thing that reads it and **nothing in the workspace calls it** — the
 *    whole-repo search finds the definition and nothing else. Tests *remove* it
 *    to neutralise it (`crates/cli/src/metrics.rs:2574`,
 *    `crates/tui/src/utils.rs:1579`), and `docs/CONFIGURATION.md:1440` tells the
 *    user to rename it to `CODEWHALE_HOME`. So the legacy *directory* is live and
 *    the legacy *variable* is not; reading it here would import a tree the
 *    product cannot itself be pointed at. {@link codewhaleHome} honours
 *    `CODEWHALE_HOME` alone.
 * 2. **There is no `<workspace>/.codewhale/settings.toml`, and no
 *    `<workspace>/.codewhale/mcp.json`.** Both were in the brief. Neither exists:
 *    `settings.toml` is resolved at `crates/tui/src/settings.rs:2447-2462`
 *    against three *global* roots, and the CLI refuses a project-scoped settings
 *    write outright (`crates/cli/src/lib.rs:5107-5113`, "`{key}` is a user
 *    setting stored in settings.toml and has no project scope"); `mcp.json` is
 *    user-global via `default_mcp_config_path()`
 *    (`crates/tui/src/config/paths.rs:215-217`) and a configured *relative*
 *    `mcp_config_path` is refused with a warning
 *    (`crates/tui/src/config.rs:7563-7576`). Only `config.toml` has a project
 *    layer. {@link codewhaleProjectConfigPath} is therefore the only project
 *    document this module derives.
 *
 * ## Nothing here calls `os.homedir()`
 *
 * The `home` argument is the only source of a home directory, and `env` is a
 * parameter rather than a `process.env` read, so `source-env-coverage.test.ts`
 * has nothing to complain about and a test that points this at a fixture cannot
 * reach the developer's own install. The product's `user_home()`
 * (`crates/paths/src/lib.rs:92-103`) appears in the comments; the code takes the
 * value as an argument.
 */

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The canonical Codewhale application directory name.
 *
 * `crates/paths/src/lib.rs:13`: `pub const CODEWHALE_APP_DIR: &str = ".codewhale";`
 * — the exact literal, doc comment and all. It is joined onto the user home by
 * `codewhale_home()` (`crates/paths/src/lib.rs:126`) and it is what
 * `default_user_state_path_from_environment` tries first
 * (`crates/tui/src/config/paths.rs:253`).
 */
export const CODEWHALE_DEFAULT_DIR = ".codewhale";

/**
 * The pre-rename directory, and **a live root rather than a historical one**.
 *
 * `crates/paths/src/lib.rs:16`: `pub const LEGACY_APP_DIR: &str = ".deepseek";`
 * with the doc comment "Legacy DeepSeek-branded directory retained for
 * compatibility reads."
 *
 * **"Retained for compatibility reads" is doing real work here**, not the
 * hedge it looks like: {@link CODEWHALE_LEGACY_FALLBACK} below is built from
 * which readers still consult it.
 */
export const CODEWHALE_LEGACY_DIR = ".deepseek";

/** The environment block the resolution reads; injectable so tests need no `process.env`. */
export type CodewhaleEnv = Record<string, string | undefined>;

/**
 * The variable that moves the whole tree, and the only one that does.
 *
 * `crates/paths/src/lib.rs:60-62` reads it through `absolute_path_env`, so it
 * must be absolute after `~` expansion or the product **errors** rather than
 * falling back — `PathOverrideErrorKind::Relative` ("<VAR> must be an absolute
 * path, got <path>"), `crates/paths/src/lib.rs:35-39`.
 *
 * **An unusable value does not fall back here either, and that is a decision
 * with a reason.** A Codewhale configured with a relative `CODEWHALE_HOME` fails
 * to start; this importer falls back to {@link CODEWHALE_DEFAULT_DIR} and says
 * so through {@link CodewhaleHome.rejectedHome}, for the same reason
 * `qoder-home.ts` does it for `QODER_CONFIG_DIR_NAME`: silently reading
 * `~/.codewhale` would import a tree the product itself refused to look at.
 */
export const CODEWHALE_HOME_ENV = "CODEWHALE_HOME";

/**
 * Variables that relocate the **config file** rather than the tree.
 *
 * `crates/config/src/lib.rs:145-150`:
 *
 * ```rust
 * pub fn config_path_override() -> Result<Option<PathBuf>, PathOverrideError> {
 *     if let Some(path) = absolute_path_env("CODEWHALE_CONFIG_PATH")? { return Ok(Some(path)); }
 *     absolute_path_env("DEEPSEEK_CONFIG_PATH")
 * }
 * ```
 *
 * **`DEEPSEEK_CONFIG_PATH` is live** — unlike `DEEPSEEK_HOME`, this one really
 * is read, and the TUI's settings resolver walks the same pair to find where
 * `settings.toml` lives beside it (`crates/tui/src/settings.rs:2466-2471`,
 * `for var in ["CODEWHALE_CONFIG_PATH", "DEEPSEEK_CONFIG_PATH"]`).
 *
 * A path here names a *whole file*, not a directory, so it is used verbatim
 * after the same `~`-expansion and absolute-path check the product applies.
 */
export const CODEWHALE_CONFIG_PATH_ENV = "CODEWHALE_CONFIG_PATH";

/** The second half of the config-file override pair. See {@link CODEWHALE_CONFIG_PATH_ENV}. */
export const CODEWHALE_LEGACY_CONFIG_PATH_ENV = "DEEPSEEK_CONFIG_PATH";

/**
 * Whether the tree is env-relocatable, and which variables do it.
 *
 * `CODEWHALE_HOME` is the only one, and the only one this importer honours. The
 * other two move a single file rather than the tree, and the two halves of the
 * "live `DEEPSEEK_*` alias" claim are covered above: `DEEPSEEK_CONFIG_PATH` is
 * read, `DEEPSEEK_HOME` is not.
 */
export const CODEWHALE_HOME_ENVS: readonly string[] = [CODEWHALE_HOME_ENV];

// ---------------------------------------------------------------------------
// The two roots
// ---------------------------------------------------------------------------

/** Why `CODEWHALE_HOME` was refused, or `null` when it was unset or usable. */
export type CodewhaleHomeRejection = "relative" | "tilde-without-home";

/**
 * The home the reader will open, and why a configured one was not used.
 *
 * `present` is the product's own question — `codewhale_home()` returns `Ok(None)`
 * when there is no home at all — and `rejectedHome` is the case the product
 * turns into an error. Both are facts about the environment rather than about
 * the filesystem, which is why they are separated: a home that resolved is not
 * a home that exists.
 */
export interface CodewhaleHome {
	/** `CODEWHALE_HOME` when it names an absolute path, else `<home>/.codewhale`. */
	root: string;
	/** The pre-rename root, `<home>/.deepseek`. Never follows `CODEWHALE_HOME`. */
	legacyRoot: string;
	/** True when `CODEWHALE_HOME` was set to a non-empty value. */
	explicit: boolean;
	/**
	 * Why `CODEWHALE_HOME` was not used, or `null`.
	 *
	 * `null` when it was unset, when it was blank, and when it was usable. A
	 * non-null value is a sentence, not a flag — the report prints it as-is.
	 */
	rejectedHome: string | null;
}

/** `CODEWHALE_HOME` trimmed the way the product trims it, or `undefined`. */
function codewhaleHomeEnv(env: CodewhaleEnv): string | undefined {
	const raw = env[CODEWHALE_HOME_ENV];
	if (raw === undefined) return undefined;
	// `normalize_path_value` (`crates/paths/src/lib.rs:213-225`): empty is unset,
	// and a Unicode value is trimmed, so a whitespace-only value is unset too.
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve the two roots.
 *
 * The precedence is the product's, from `codewhale_home()`
 * (`crates/paths/src/lib.rs:121-138`) and `legacy_deepseek_home()`
 * (`crates/paths/src/lib.rs:203-211`):
 *
 *   - **`CODEWHALE_HOME` wins outright** when it is absolute, after a leading
 *     `~` is expanded against the home (`validate_absolute_path`,
 *     `crates/paths/src/lib.rs:163-201`).
 *   - **A relative value is an error in the product and a fallback here**, with
 *     the reason reported. See {@link CODEWHALE_HOME_ENV}.
 *   - **The legacy root never follows `CODEWHALE_HOME`.** Its doc comment is
 *     explicit — "This never follows `CODEWHALE_HOME`: callers must suppress
 *     legacy fallback whenever [`codewhale_home_is_explicit`] is true" — and this
 *     function keeps the second root as a *name* rather than a candidate, because
 *     whether it is ever read is {@link codewhaleStatePath}'s question and not
 *     this one's.
 */
export function resolveCodewhaleHome(home: string, env: CodewhaleEnv = process.env): CodewhaleHome {
	const legacyRoot = join(home, CODEWHALE_LEGACY_DIR);
	const configured = codewhaleHomeEnv(env);
	if (configured === undefined) {
		return { root: join(home, CODEWHALE_DEFAULT_DIR), legacyRoot, explicit: false, rejectedHome: null };
	}

	// `~` alone is the home; `~/x` is the home with `x` appended
	// (`crates/paths/src/lib.rs:169-189`). Both separators are accepted because
	// the product accepts both there (`suffix.starts_with('/') || starts_with('\\')`).
	const expanded = expandLeadingTilde(configured, home);
	if (expanded === null) {
		return {
			root: join(home, CODEWHALE_DEFAULT_DIR),
			legacyRoot,
			explicit: true,
			rejectedHome:
				`${CODEWHALE_HOME_ENV} is set to a value Codewhale itself refuses: it begins with "~", and the user home could not be ` +
				"expanded, so the product raises PathOverrideErrorKind::HomeUnavailable and refuses to start. This import fell back to " +
				CODEWHALE_DEFAULT_DIR,
		};
	}
	if (!isAbsolute(expanded)) {
		return {
			root: join(home, CODEWHALE_DEFAULT_DIR),
			legacyRoot,
			explicit: true,
			rejectedHome:
				`${CODEWHALE_HOME_ENV} is set to a relative path, which Codewhale rejects outright — "${expanded}" is not absolute, and the ` +
				`product's own message is "${CODEWHALE_HOME_ENV} must be an absolute path". This import fell back to ${CODEWHALE_DEFAULT_DIR}`,
		};
	}
	return { root: expanded, legacyRoot, explicit: true, rejectedHome: null };
}

/**
 * Expand a leading `~`, or say it could not be done.
 *
 * `null` is the `HomeUnavailable` case and only that: `validate_absolute_path`
 * (`crates/paths/src/lib.rs:169-189`) fails when the value *is* `~` or starts
 * with `~` and `user_home()` returned nothing. Since `home` is this module's own
 * argument and is always a string, the only way to reach it is a `~` value with
 * an empty home — which is why the branch exists rather than being asserted away.
 *
 * Exported because the same expansion governs the **config-file** override pair
 * (`CODEWHALE_CONFIG_PATH`, `DEEPSEEK_CONFIG_PATH`), which the product also runs
 * through `absolute_path_env`; see {@link codewhaleConfigOverride}. Two rules
 * from one place is the point.
 */
export function expandLeadingTilde(value: string, home: string): string | null {
	if (value === "~") return home === "" ? null : home;
	if (!value.startsWith("~")) return value;
	const suffix = value.slice(1).replace(/^[\\/]+/, "");
	if (!value.startsWith("~/") && !value.startsWith("~\\")) return value;
	if (home === "") return null;
	return suffix === "" ? home : join(home, suffix);
}

// ---------------------------------------------------------------------------
// The per-path legacy fallback
// ---------------------------------------------------------------------------

/**
 * Whether a state path still falls back to `~/.deepseek`.
 *
 * **This table is the heart of the two-root problem and every row is cited.**
 * The answer is not uniform, and a reader that applied "fall back if the
 * primary is absent" to everything would read a `~/.deepseek` tree Codewhale
 * itself has stopped reading — importing settings, skills or MCP servers the
 * product is no longer willing to load.
 *
 * `true` here means "the product's own resolver checks the legacy root for this
 * name"; `false` means "every reader of this path goes through
 * `codewhale_home()`, which never returns `.deepseek`".
 */
export const CODEWHALE_LEGACY_FALLBACK: Readonly<Record<string, boolean>> = {
	// `config/src/lib.rs:6947-6960` (`default_config_path`) — primary, then
	// legacy, then primary. Mirrored by `home_config_path_from_environment`,
	// `tui/src/config/paths.rs:104-124`.
	"config.toml": true,
	// A **sibling of whatever `config.toml` resolved to**, so it inherits that
	// resolution rather than having one of its own:
	// `config/src/lib.rs:6620-6623`, `config_sibling_path_unchecked(config_path, PERMISSIONS_FILE_NAME)`.
	"permissions.toml": true,
	// `tui/src/config/paths.rs:215-217` → `default_user_state_path("mcp.json")`
	// → `:252-262`.
	"mcp.json": true,
	// `tui/src/config/paths.rs:211-213` → the same helper. **But see
	// {@link codewhaleSkillRoots}: the *skill loader* uses a second
	// `default_skills_dir` (`tui/src/skills/mod.rs:188`) that does not fall back,
	// so a `.deepseek/skills` tree is read by one and missed by the other.
	skills: true,
	"notes.txt": true,
	"memory.md": true,
	// `settings.rs:2447-2462` — **two** legacy candidates, and the second is not
	// under the home at all: `dirs::config_dir()/deepseek/settings.toml`, which on
	// Windows is `%APPDATA%\deepseek\settings.toml`.
	"settings.toml": true,
	// `settings.rs:141-150` maps `[primary, legacy_home]` through
	// `with_file_name(TUI_PREFS_FILE_NAME)`, so it inherits the settings roots.
	"tui.toml": true,
	// `tui/src/session_manager.rs:3758` `ensure_state_dir("sessions")`, whose
	// **write** form additionally relocates a legacy `sessions` tree into the
	// primary on first creation (`config/src/lib.rs:6177-6186`, "#3240").
	sessions: true,
	// `config/src/lib.rs:6158` `resolve_state_dir`, the generic one.
	state: true,
	tool_outputs: true,

	// **No fallback.** Each of these is joined straight onto `codewhale_home()`.
	agents: false, // fleet/profile.rs:63
	fleets: false, // fleet/store.rs:597-598
	plugins: false, // plugins/discovery.rs:61-63
	themes: false, // palette/user_theme.rs:196-198
	"audit.log": false, // tui/audit.rs:94
	"constitution.json": false, // config/user_constitution.rs:506
	"prompts/constitution.md": false, // tui/lib.rs:6544-6546
	workflows: false, // commands/user_commands.rs:110 — hardcoded ".codewhale" literal
	secrets: false, // secrets/src/lib.rs:833-841
	"keyring-locks": false, // secrets/src/lib.rs:344-352
	imports: false, // commands/groups/config/import_claude.rs:49-52
};

/**
 * Where a state path resolved to, and **which of the two roots answered**.
 *
 * The root is the field this type exists for. "Codewhale's settings came across"
 * is a sentence that hides three different facts: they were in `~/.codewhale`,
 * they were in the pre-rename `~/.deepseek`, or they were in neither and the
 * import had nothing to read. The first two are the same install at two points in
 * its life; the third is the ordinary state of a home that has not written the
 * file, and a report that printed one sentence for all three would be claiming a
 * read that did not happen.
 */
export interface CodewhaleStateLocation {
	/** The path the product would use, whether or not anything is there. */
	path: string;
	/**
	 * Which root the path resolves into:
	 *   - `codewhale` — `~/.codewhale`, or `$CODEWHALE_HOME` when one is set;
	 *   - `deepseek` — the pre-rename root, reached only through a fallback;
	 *   - `absent` — the path is where it would be written, and nothing is there
	 *     yet. **Not an error:** a home that has never written `mcp.json` is in
	 *     this state for every document.
	 */
	root: "codewhale" | "deepseek" | "absent";
	/** Whether the file is on disk right now. */
	exists: boolean;
}

/**
 * Resolve one state path and say which root it came from.
 *
 * The three-way answer is the third clause of
 * `default_user_state_path_from_environment`
 * (`crates/tui/src/config/paths.rs:240-263`) made visible rather than discarded:
 * the product returns the primary path in that case because it is about to write
 * there, and a reader that cannot tell that apart from "found it" would report a
 * read it never made.
 */
export function codewhaleStateLocation(
	home: CodewhaleHome,
	name: string,
	exists: (path: string) => boolean = existsSync,
): CodewhaleStateLocation {
	// An explicit `CODEWHALE_HOME` is an isolation boundary
	// (`crates/config/src/lib.rs:6105-6111`), so there is no legacy root to fall
	// back to and the answer is one of the first two states.
	if (home.explicit) {
		const path = join(home.root, name);
		const present = exists(path);
		return { path, root: present ? "codewhale" : "absent", exists: present };
	}
	const primary = join(home.root, name);
	if (exists(primary)) return { path: primary, root: "codewhale", exists: true };
	if (CODEWHALE_LEGACY_FALLBACK[name] === false) return { path: primary, root: "absent", exists: false };
	const legacy = join(home.legacyRoot, name);
	if (exists(legacy)) return { path: legacy, root: "deepseek", exists: true };
	return { path: primary, root: "absent", exists: false };
}

/**
 * One state path, under whichever root the product would read it from.
 *
 * Reproduces `default_user_state_path_from_environment`
 * (`crates/tui/src/config/paths.rs:240-263`) statement for statement:
 *
 * ```rust
 * match codewhale_home_dir() {
 *     Ok(Some(home)) => return Some(home.join(name)),        // explicit: no fallback
 *     Ok(None) => {}
 *     Err(error) => return None,                            // refused: no fallback
 * }
 * effective_home_dir().map(|home| {
 *     let primary = home.join(".codewhale").join(name);
 *     if primary.exists() { return primary; }
 *     let legacy = home.join(".deepseek").join(name);
 *     if legacy.exists() { return legacy; }
 *     primary
 * })
 * ```
 *
 * **The third line is why this function takes `exists` rather than computing
 * both candidates:** the answer is whichever root *has* the file, and the file
 * being absent is the normal state of a home that has not written one yet.
 * `codewhaleStatePath` below is the `existsSync` wrapper; this one takes the
 * predicate so a pure test can drive all three branches without a filesystem.
 *
 * **A `false` row in {@link CODEWHALE_LEGACY_FALLBACK} is honoured here too**,
 * because a caller asking for one of those names is asking for a path the
 * product computes from `codewhale_home()` alone.
 */
export function codewhaleStatePath(
	home: CodewhaleHome,
	name: string,
	exists: (path: string) => boolean = existsSync,
): string {
	if (home.explicit) return join(home.root, name);
	const primary = join(home.root, name);
	if (CODEWHALE_LEGACY_FALLBACK[name] === false) return primary;
	if (exists(primary)) return primary;
	const legacy = join(home.legacyRoot, name);
	if (exists(legacy)) return legacy;
	return primary;
}

// ---------------------------------------------------------------------------
// The settings documents — five, not one
// ---------------------------------------------------------------------------

/** `config.toml` — the provider, model and mode document. */
export function codewhaleConfigPath(home: CodewhaleHome, exists?: (path: string) => boolean): string {
	return codewhaleStatePath(home, "config.toml", exists);
}

/** `permissions.toml` — the typed allow/ask/deny rules, a sibling of `config.toml`. */
export function codewhalePermissionsPath(home: CodewhaleHome, exists?: (path: string) => boolean): string {
	return codewhaleStatePath(home, "permissions.toml", exists);
}

/**
 * `settings.toml` — the TUI's own preferences, and **a third candidate root
 * nobody would guess**.
 *
 * `crates/tui/src/settings.rs:2447-2462` builds a triple and
 * `resolve_settings_path_from_candidates` (`:2016-2044`) takes the first that
 * exists:
 *
 * ```rust
 * let primary = codewhale_home()?.join(SETTINGS_FILE_NAME);
 * if codewhale_home_is_explicit() { return (primary, None, None); }
 * let legacy_home = legacy_deepseek_home()?.join(SETTINGS_FILE_NAME);
 * let legacy_config_dir = dirs::config_dir().map(|d| d.join("deepseek").join(SETTINGS_FILE_NAME));
 * ```
 *
 * So the third candidate is a **platform config directory with no `~/.` at all** —
 * `%APPDATA%\deepseek\settings.toml` on Windows, `~/.config/deepseek/settings.toml`
 * on Linux. This importer resolves the two home-relative candidates and **names**
 * the third: `dirs::config_dir()` is an XDG lookup whose Windows spelling is
 * `%APPDATA%`, and a migration that opened it would be reading a file outside
 * the home the caller was given. {@link CODEWHALE_LEGACY_CONFIG_DIR_NAME} is
 * what the report prints for it.
 */
export const CODEWHALE_LEGACY_CONFIG_DIR_NAME = "deepseek";

/**
 * Where `settings.toml` is read from, in the product's own order.
 *
 * Every entry is returned rather than the winner, so the reader can say which
 * of the candidates answered and which were not there.
 */
export function codewhaleSettingsCandidates(
	home: CodewhaleHome,
	exists: (path: string) => boolean = existsSync,
): string[] {
	if (home.explicit) return [join(home.root, "settings.toml")];
	const primary = join(home.root, "settings.toml");
	if (exists(primary)) return [primary];
	const legacy = join(home.legacyRoot, "settings.toml");
	if (exists(legacy)) return [legacy];
	return [primary];
}

/**
 * `tui.toml` — the **superseded** preferences store, folded into `settings.toml`
 * on load and then moved aside.
 *
 * `crates/tui/src/settings.rs:7`: "There is one persisted settings store. The
 * historical `tui.toml` second store is folded into it on load and moved aside
 * with a receipt — see `TuiPrefsMigration`." The path is built at `:141-150` by
 * `with_file_name` over the same candidate list as `settings.toml`.
 *
 * **It is named rather than read**, and the reason is the file's own: its
 * contents have already been folded into `settings.toml` by the product, so
 * reading it as a second settings document would import the same preferences
 * twice from a tree the product considers spent.
 */
export function codewhaleTuiPrefsPath(settingsPath: string): string {
	return settingsPath.replace(/settings\.toml$/, "tui.toml");
}

// ---------------------------------------------------------------------------
// The project (workspace) layer
// ---------------------------------------------------------------------------

/**
 * `<workspace>/.codewhale/config.toml`, and the legacy sibling beside it.
 *
 * **The only project-scoped settings document Codewhale has.** The brief listed
 * a project `settings.toml` and a project `mcp.json`; neither exists (see the
 * module header), and this is the reason that matters here:
 *
 *   - `config.toml`: `load_project_config_outcome`
 *     (`crates/config/src/lib.rs:3938-3941`) iterates
 *     `[CODEWHALE_APP_DIR, LEGACY_APP_DIR]`, so **both are read** and the
 *     `.codewhale` one wins when both exist;
 *   - `settings.toml`: user-global only, and a project-scoped write is refused
 *     (`crates/cli/src/lib.rs:5107-5113`);
 *   - `mcp.json`: user-global only, and a configured relative `mcp_config_path`
 *     is refused with a warning (`crates/tui/src/config.rs:7563-7576`).
 */
export function codewhaleProjectConfigPath(workspace: string, exists: (path: string) => boolean = existsSync): string {
	const primary = join(workspace, CODEWHALE_DEFAULT_DIR, "config.toml");
	if (exists(primary)) return primary;
	const legacy = join(workspace, CODEWHALE_LEGACY_DIR, "config.toml");
	return exists(legacy) ? legacy : primary;
}

/**
 * A project config that exists but cannot be used, kept distinct from absence.
 *
 * `crates/config/src/lib.rs:3925-3932` and its own doc comment make the
 * distinction security-relevant in the product's words: "The distinction between
 * 'no project config' and 'a project config that is broken' is security-relevant
 * … if a typo makes it unparseable and that is reported as absence, the project
 * silently loses its restrictions and falls back to the user's more permissive
 * baseline."
 *
 * **A project config can only *tighten* `approval_policy` / `sandbox_mode`**
 * (`project_approval_policy_is_allowed`, `crates/config/src/lib.rs:3846-3855`,
 * and `project_sandbox_mode_is_allowed` at `:3857-3872`). So this importer
 * reading it as "restrictions the project asked for" and importing those would
 * be **widening** the target's posture at import time — the one direction a
 * migration must not move on its own judgement. It is reported, never claimed.
 */
export function codewhaleProjectConfigReport(
	workspace: string,
	exists: (path: string) => boolean = existsSync,
): {
	path: string;
	present: boolean;
} {
	const path = codewhaleProjectConfigPath(workspace, exists);
	return { path, present: exists(path) };
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** `mcp.json` — the user's MCP servers, under whichever root holds it. */
export function codewhaleMcpPath(home: CodewhaleHome, exists?: (path: string) => boolean): string {
	return codewhaleStatePath(home, "mcp.json", exists);
}

/**
 * The top-level key the servers live under, and the one it is also spelled.
 *
 * `crates/tui/src/mcp.rs:508-516`:
 *
 * ```rust
 * pub struct McpConfig {
 *     #[serde(default)] pub timeouts: McpTimeouts,
 *     #[serde(default, alias = "mcpServers")] pub servers: HashMap<String, McpServerConfig>,
 * }
 * ```
 *
 * **The file's own key is `servers`; `mcpServers` is a deserialization alias.**
 * A reader that looked for `mcpServers` and found nothing would report a
 * configured user as having no MCP servers at all, so both are accepted and
 * `servers` is preferred when a file carries both — which is the only reading
 * consistent with serde, where the alias is consulted only when the canonical
 * name is absent.
 */
export const CODEWHALE_MCP_SERVERS_KEY = "servers";

/** The alias `mcpServers` deserializes from. See {@link CODEWHALE_MCP_SERVERS_KEY}. */
export const CODEWHALE_MCP_SERVERS_ALIAS = "mcpServers";

/**
 * The keys `McpServerConfig` recognises on one server entry.
 *
 * `crates/tui/src/mcp.rs:562-658`, field by field. **The struct carries no
 * `#[serde(rename_all)]`**, so every name on disk is the bare Rust name — this
 * list is snake_case and there is no camelCase spelling of any of it. The two
 * that look like they might be are the ones worth stating:
 *
 *   - `env_headers` (`:631`) with `#[serde(default, alias = "env_http_headers")]`
 *     (`:629`), so `env_http_headers` also deserializes;
 *   - `enabled_tools` (`:600`) and `disabled_tools` (`:602`) — not
 *     `enabledTools` / `disabledTools`.
 *
 * **`enabled` and `disabled` are both real and independent** (`:594`, `:596`),
 * with `enabled` defaulting to `true` through `default_enabled` and `disabled`
 * to `false`. A file carrying both is a file the product reads both ways, so
 * this importer treats `disabled: true` as the switch-off and says so.
 */
export const CODEWHALE_MCP_SERVER_KEYS: readonly string[] = [
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"allow_private_network",
	"transport",
	"connect_timeout",
	"execute_timeout",
	"read_timeout",
	"disabled",
	"enabled",
	"required",
	"enabled_tools",
	"disabled_tools",
	"headers",
	"env_headers",
	"env_http_headers",
	"bearer_token_env_var",
	"scopes",
	"oauth",
	"oauth_resource",
];

/**
 * Entry keys whose values are credentials **by the product's own account**.
 *
 * Three of them, and the first is the sharpest because it is a *name* rather
 * than a secret:
 *
 *   - `headers` (`:626`) — `HashMap<String, String>`, and the product says so
 *     itself at `:619-623`: "Header keys and values are passed through as-is —
 *     we do not substitute environment variables in v0.8.31. If you store a real
 *     token here, the value lives in plain text in `~/.deepseek/mcp.json`; treat
 *     that file with the same care as any other secret-bearing config." (The path
 *     in that sentence is itself stale — the resolver prefers
 *     `~/.codewhale/mcp.json` — which is independent evidence that the rename
 *     happened after the comment was written.)
 *   - `env` (`:568`) — the spawned server's process environment.
 *   - `bearer_token_env_var` (`:636`) — names a variable, not a value, but the
 *     name is not credential-shaped in a way a scan can rely on and the
 *     variable it names is a bearer token by the field's own doc.
 *
 * `env_headers` is deliberately **not** in this list: its values are looked up in
 * the environment at request time (`crates/tui/src/mcp.rs:628-631`), so the file
 * holds an environment *variable name* and no token. It is still dropped, for a
 * different reason — this build's MCP client has nowhere to put it — which
 * `codewhale-plan.ts` states where it happens.
 */
export const CODEWHALE_MCP_CREDENTIAL_KEYS: readonly string[] = ["headers", "env", "bearer_token_env_var"];

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * The skill roots Codewhale owns, and **the ones it does not.**
 *
 * `crates/tui/src/skills/mod.rs:985-991` states the full precedence in the
 * product's words: "Project order is `.codewhale`, `.agents`, `.claude`,
 * `.opencode`, `.cursor`, followed by an opted-in flat `skills` root. Global
 * order is `.codewhale`, `.agents`, `.claude`, then legacy `.deepseek`. Project
 * roots outrank global roots."
 *
 * **Only Codewhale's own roots are imported, and the exclusion is the same one
 * `kimi-read.ts` makes with `KIMI_SHARED_TREE`.** `~/.agents` is the shared
 * agentskills.io home, and this repository already has an `agents` source that
 * owns it outright (`agents-read.ts:34-39` reads `~/.agents/AGENTS.md`,
 * `skills/`, `agents/` and `commands/`). Importing it here as well would land
 * two copies of every file in it, and — because `collectFileWrites` keys on the
 * target path — the second copy would be reported as a written skill and
 * attributed to Codewhale when it was the same file the `agents` run already
 * wrote. So the shared tree is **named** and the `agents` source owns it.
 *
 * **`~/.deepseek/skills` is reached through the fallback rather than listed
 * separately**, because `CODEWHALE_LEGACY_FALLBACK["skills"]` is `true`: the
 * product checks the pre-rename root for this name
 * (`crates/tui/src/config/paths.rs:240-263`). Note the trap in the other
 * direction: `skills/mod.rs:188`'s own `default_skills_dir` hardcodes
 * `.codewhale` at `:199` with **no** fallback, and the sibling function of the
 * same name at `config/paths.rs:211-213` has one. Two functions, one name, and
 * the loader is the one that decides what a skill is — so a `.deepseek/skills`
 * tree is read by one and missed by the other, and this importer follows the
 * falling-back one and says which root answered.
 *
 * `<workspace>/.agents/skills` **is** imported, and the reason is a checked one:
 * the `agents` source reads `join(home, ".agents")` and nothing else
 * (`agents-read.ts:34`), so no source claims the project-level shared tree. If
 * that ever changes, `collectFileWrites`' target-path de-duplication turns the
 * second claim into a reported skip rather than a second write.
 */
export function codewhaleSkillRoots(skillsDir: string): string[] {
	return [skillsDir];
}

/**
 * The **shared** `.agents` tree Codewhale reads, which this importer names rather
 * than imports.
 *
 * Two of these are the `agents` source's outright; the third is a
 * `~/.agents/instructions.md` that `agents-read.ts` does **not** read, so it is
 * listed here and handled separately in `codewhale-read.ts`. Every entry is
 * filtered by existence at the call site, as `kimi-read.ts:281` does.
 *
 * `agents_global_skills_dir()` (`crates/tui/src/skills/mod.rs:214-225`, the join
 * at `:225`) is the second; the instruction documents are the
 * `GLOBAL_AGENTS_VENDOR_NEUTRAL_PATH` and `GLOBAL_INSTRUCTIONS_VENDOR_NEUTRAL_PATH`
 * rows of `project_context.rs:355` and `:363`.
 */
export const CODEWHALE_SHARED_TREE: readonly string[] = [
	join(".agents", "skills"),
	join(".agents", "AGENTS.md"),
	join(".agents", "instructions.md"),
];

/** `<workspace>/.codewhale/skills` — the project scope, which no other source claims. */
export function codewhaleProjectSkillsDir(workspace: string): string {
	return join(workspace, CODEWHALE_DEFAULT_DIR, "skills");
}

/** `<workspace>/.agents/skills` — the shared project tree; imported because nothing else claims it. */
export function codewhaleProjectSharedSkillsDir(workspace: string): string {
	return join(workspace, ".agents", "skills");
}

/** `~/.deepseek/skills` — the pre-rename root for this name, named for the report. */
export function codewhaleLegacySkillsRoot(home: string): string {
	return join(home, CODEWHALE_LEGACY_DIR, "skills");
}

/**
 * `~/.codewhale/agents/<id>.toml` — Fleet personal agent profiles.
 *
 * `PERSONAL_AGENT_PROFILE_DIR = "agents"`
 * (`crates/tui/src/fleet/profile.rs:21`), joined onto `codewhale_home()` at
 * `:63`; the per-profile file name is `format!("{}.toml", self.id)` at `:1031`.
 *
 * **The brief cited `:20`, which is a different constant**: `:20` is
 * `WORKSPACE_AGENT_PROFILE_DIR = ".codewhale/agents"` — the *project* half.
 * Both exist and both are named below.
 */
export function codewhaleAgentsDir(root: string): string {
	return join(root, "agents");
}

/** `<workspace>/.codewhale/agents` — the project half. `fleet/profile.rs:20`. */
export function codewhaleProjectAgentsDir(workspace: string): string {
	return join(workspace, CODEWHALE_DEFAULT_DIR, "agents");
}

/** `~/.codewhale/fleets/<slug>.toml` — `FLEET_DIR = "fleets"` (`fleet/store.rs:76`), joined at `:597-598`. */
export function codewhaleFleetsDir(root: string): string {
	return join(root, "fleets");
}

/** `~/.codewhale/plugins/<name>/` — `plugins/discovery.rs:61-63`. */
export function codewhalePluginsDir(root: string): string {
	return join(root, "plugins");
}

// ---------------------------------------------------------------------------
// Instruction documents
// ---------------------------------------------------------------------------

/**
 * The user-global instruction documents, **in the product's own precedence**.
 *
 * `crates/tui/src/project_context.rs:354-364` declares six two-segment relative
 * paths, and `global_context_relative_paths()` (`:806-815`) returns them in this
 * order:
 *
 * ```rust
 * const GLOBAL_AGENTS_RELATIVE_PATH:           &[&str] = &[".codewhale", "AGENTS.md"];       // :354
 * const GLOBAL_AGENTS_VENDOR_NEUTRAL_PATH:     &[&str] = &[".agents",     "AGENTS.md"];       // :355
 * const GLOBAL_AGENTS_LEGACY_PATH:             &[&str] = &[".deepseek",   "AGENTS.md"];       // :356
 * const GLOBAL_INSTRUCTIONS_RELATIVE_PATH:     &[&str] = &[".codewhale", "instructions.md"];  // :362
 * const GLOBAL_INSTRUCTIONS_VENDOR_NEUTRAL_PATH: &[&str] = &[".agents", "instructions.md"];   // :363
 * const GLOBAL_INSTRUCTIONS_LEGACY_PATH:       &[&str] = &[".deepseek",  "instructions.md"];  // :364
 * ```
 *
 * **Three roots per file name, not one** — `.codewhale` first, then the
 * vendor-neutral `.agents`, then legacy `.deepseek` — and the doc comment at
 * `:348-353` states the ordering as a rule: "Within each file name, `.codewhale/`
 * takes priority over vendor-neutral `.agents/`, which takes priority over
 * legacy `.deepseek/`."
 *
 * `WHALE.md` is **not** here because it is never loaded:
 * `DEPRECATED_WHALE_FILENAME = "WHALE.md"` (`:343`) and
 * `WHALE_IGNORED_WARNING` (`:346`) — "WHALE.md is ignored; move project
 * instructions to AGENTS.md, or Codewhale-specific authority policy to
 * `.codewhale/constitution.json`." It is named in
 * {@link CODEWHALE_GLOBAL_DOCUMENTS} so a user who has one is told it does
 * nothing.
 *
 * `~/.agents/AGENTS.md` and `~/.agents/instructions.md` are the **shared** agent
 * home, which this repository already migrates as its `agents` source. They are
 * in the list because Codewhale reads them and this importer should say so when
 * it declines to read them twice.
 */
export const CODEWHALE_GLOBAL_INSTRUCTIONS: readonly (readonly [string, string])[] = [
	[CODEWHALE_DEFAULT_DIR, "AGENTS.md"],
	[".agents", "AGENTS.md"],
	[CODEWHALE_LEGACY_DIR, "AGENTS.md"],
	[CODEWHALE_DEFAULT_DIR, "instructions.md"],
	[".agents", "instructions.md"],
	[CODEWHALE_LEGACY_DIR, "instructions.md"],
];

/** The deprecated global documents, which Codewhale reads only to warn. `project_context.rs:343,357-359`. */
export const CODEWHALE_GLOBAL_DOCUMENTS: readonly (readonly [string, string])[] = [
	[CODEWHALE_DEFAULT_DIR, "WHALE.md"],
	[".agents", "WHALE.md"],
	[CODEWHALE_LEGACY_DIR, "WHALE.md"],
];

/**
 * The project-scoped rule directories, `.md` files in filename order.
 *
 * `RULES_DIRS = [".codewhale/rules", ".claude/rules"]`
 * (`crates/tui/src/project_context.rs:340`), with the live builder at `:253`
 * seeding `[".codewhale/rules"]` and adding `.claude/rules` only when the Claude
 * import format is enabled. **Only the Codewhale-native one is read**; the
 * Claude one belongs to a different product's files and Codewhale itself will not
 * create or recommend it (`:33-41`).
 *
 * Note that these are **workspace-only** — there is no global rules directory.
 */
export function codewhaleProjectRulesDir(workspace: string): string {
	return join(workspace, CODEWHALE_DEFAULT_DIR, "rules");
}

/**
 * `<workspace>/.codewhale/hooks.toml` — the project half of the hook config.
 *
 * **A sixth settings document the brief did not list, and finding it late is why
 * this module's other citations are worth re-checking.** I first read
 * `ConfigToml`'s field list, saw no `hooks` field, and wrote that Codewhale had
 * no hooks at all. It does — `HooksConfig` is deserialized **separately** from
 * the root config, the same way the TUI's own `Config` is
 * (`crates/tui/src/hooks/config.rs:379`, "Configuration for hooks (loaded from
 * config.toml)"). That is precisely the mistake that reads "the field is not on
 * the struct" when the truth is "the struct is not the one that reads it", and it
 * is the same shape as the two corrections already recorded in this header.
 *
 * The two locations are the halves of `HooksConfig::load_with_project`
 * (`crates/tui/src/hooks/config.rs:440-441`): global from `config.toml`, then this
 * file appended — "Trusted project hooks are appended after global hooks"
 * (`:443-444`), the join at `:490`.
 *
 * **The project half is gated on workspace trust and exact-byte approval**
 * (`approved_project_hooks`, called at `:491`): "Project hooks are executable
 * repository configuration, so they are only honored after workspace trust and
 * exact-byte hook approval" (`:442-443`). A hook that runs code out of a
 * repository is the sharpest thing this importer touches, which is why the report
 * names the gate rather than importing the file silently.
 */
export function codewhaleProjectHooksPath(workspace: string): string {
	return join(workspace, CODEWHALE_DEFAULT_DIR, "hooks.toml");
}

/**
 * `<workspace>/.codewhale/anchors.md`, with the legacy sibling.
 *
 * `crates/tui/src/commands/groups/core/anchor.rs:70-76`:
 *
 * ```rust
 * let primary = app.workspace.join(".codewhale").join("anchors.md");
 * if primary.symlink_metadata().is_ok() || app.workspace.join(".codewhale").is_symlink() { return primary; }
 * app.workspace.join(".deepseek").join("anchors.md")
 * ```
 *
 * The symlink clause is load-bearing in the product and is **not** reproduced
 * here: a `.codewhale` that is itself a symlink must win even when the file
 * inside it is absent, because that is how a user redirects the whole directory.
 */
export function codewhaleProjectAnchorsPath(workspace: string, exists: (path: string) => boolean = existsSync): string {
	const primary = join(workspace, CODEWHALE_DEFAULT_DIR, "anchors.md");
	if (exists(primary)) return primary;
	return join(workspace, CODEWHALE_LEGACY_DIR, "anchors.md");
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Both roots a detection pass should look at, and **not the pair a reader uses.**
 *
 * `~/.deepseek` is a live fallback root — `resolve_state_dir`
 * (`crates/config/src/lib.rs:6158-6170`) and
 * `default_user_state_path_from_environment`
 * (`crates/tui/src/config/paths.rs:240-263`) both check it — so a home that used
 * Codewhale under its old name has its tree there and nothing under `.codewhale`.
 *
 * **An explicit `CODEWHALE_HOME` narrows this to one**, and that is the product's
 * rule rather than a decision made here: "An explicit Codewhale home is an
 * isolation boundary: state/config resolvers must not fall back to ambient legacy
 * `~/.deepseek` data outside that root"
 * (`crates/config/src/lib.rs:6105-6111`). A user who exported it to isolate a
 * profile has an empty legacy tree *on purpose*, and a detection pass that looked
 * there would offer them a source holding the data they isolated themselves from.
 *
 * Which root answers a *particular* file is {@link codewhaleStatePath}'s
 * question and not this one's; this says only "the source is here".
 */
export function codewhaleDefaultRoots(home: string, env: CodewhaleEnv = process.env): string[] {
	const resolved = resolveCodewhaleHome(home, env);
	// A home with no explicit override falls back per file, so both are real
	// candidates. One with an override never does.
	return resolved.explicit ? [resolved.root] : [resolved.root, resolved.legacyRoot];
}

/**
 * `<sessions dir>` — one `<id>.json` per session.
 *
 * The directory comes from `ensure_state_dir("sessions")`
 * (`crates/tui/src/session_manager.rs:3758`), whose **write** form relocates a
 * legacy `sessions` tree into the primary on first creation
 * (`crates/config/src/lib.rs:6177-6186`, "#3240") — so this is one of the two
 * paths the product has actually been known to move, and a home still holding
 * only `~/.deepseek/sessions` is a real state.
 *
 * The file name is `format!("{trimmed}.json")` at
 * `crates/tui/src/session_manager.rs:1427`.
 */
export function codewhaleSessionsDir(home: CodewhaleHome): string {
	return codewhaleStateLocation(home, "sessions").path;
}

/**
 * `sessions` resolved with the root that answered, for the report.
 *
 * The one state path with a **write-side move** attached: `ensure_state_dir`
 * (`crates/config/src/lib.rs:6177-6186`) relocates a legacy `~/.deepseek/sessions`
 * into the canonical tree on its first real creation (#3240), so a home still
 * holding only the pre-rename tree is a state the product itself produces, not an
 * abandoned install.
 */
export function codewhaleSessionsLocation(
	home: CodewhaleHome,
	exists: (path: string) => boolean = existsSync,
): CodewhaleStateLocation {
	return codewhaleStateLocation(home, "sessions", exists);
}

/** `<sessions dir>/<id>.json`. */
export function codewhaleSessionPath(sessionsDir: string, id: string): string {
	return join(sessionsDir, `${id}.json`);
}

// ---------------------------------------------------------------------------
// Trees this source names and never opens
// ---------------------------------------------------------------------------

/**
 * The credential store: `~/.codewhale/secrets/secrets.json`.
 *
 * `crates/secrets/src/lib.rs:833-841` builds it as
 * `codewhale_home()/secrets/secrets.json`, with the doc comment at `:481-493`:
 * "serialised as a JSON object at `<home>/.codewhale/secrets/secrets.json` with
 * Unix file mode `0600` (owner read/write only). The parent directory is created
 * with mode `0700` … On Windows, the ACL model is too different to enforce
 * programmatically."
 *
 * **Its shape is `{ "entries": { <name>: <value> } }`**
 * (`FileSecretsBlob`, `crates/secrets/src/lib.rs:515-528`), plus a
 * `legacy_deepseek_migrated` flag. Account tokens live in it too —
 * `token_type`, `access_token`, `refresh_token`
 * (`crates/secrets/src/account.rs:37-41`), and that module says account sessions
 * "must never touch the OS keyring" (`:573`) precisely because the file is the
 * store.
 *
 * **Nothing in this importer opens it, and its existence is the only thing
 * asked of it.** `existsSync` on the path and nothing more — a path is not user
 * content, but a report is something a user may paste into an issue.
 */
export function codewhaleSecretsPath(root: string): string {
	return join(root, "secrets", "secrets.json");
}

/**
 * `~/.codewhale/keyring-locks/*` — per-user lock files for the OS keyring.
 *
 * `crates/secrets/src/lib.rs:344-352`, with the comment "OS keyring authority is
 * per user, not per `CODEWHALE_HOME`/profile." **Named, never listed, never
 * opened.**
 */
export function codewhaleKeyringLocksDir(root: string): string {
	return join(root, "keyring-locks");
}

/**
 * Home entries Codewhale's own extension host refuses to expose to a subprocess.
 *
 * `HOST_DENIED_HOME_ENTRIES`, `crates/tui/src/extension_host/supervisor.rs:340-358`
 * — twenty names, with the header comment at `:364-368` confirming it covers
 * "Codewhale's homes (the runtime home, the ambient `~/.codewhale`, and the
 * legacy `~/.deepseek`)".
 *
 * **This is the product's own denylist and it is the right list for a migration
 * to name.** Three of its entries are read elsewhere in this importer, on
 * purpose and with their own handling: `sessions` (the history arm),
 * `mcp.json` and `settings.toml`. Everything else is named and left alone.
 * `state.db` is in the list and is never opened here.
 */
export const CODEWHALE_DENIED_HOME_ENTRIES: readonly string[] = [
	"secrets",
	"credentials",
	"tokens",
	"state",
	"state.db",
	"sessions",
	"session-archives",
	"session_index.jsonl",
	"tool_outputs",
	"composer_history.txt",
	"composer_history.jsonl",
	"remote-control",
	"integrations",
	"audit.log",
	"logs",
	"memory",
	"mcp.json",
	"mcp.json.bak",
	"config.toml.bak",
	"settings.toml",
];

// ---------------------------------------------------------------------------
// The competing importer
// ---------------------------------------------------------------------------

/**
 * Codewhale ships its own Claude Code importer, and this run saw it.
 *
 * `/import-claude` lives in two files, both verified present:
 *
 *   - `crates/tui/src/commands/groups/config/import_claude.rs` — the command,
 *     305 lines, doc comment `:1`: "`/import-claude` — explicit, reviewable
 *     Claude Code migration (#5557)";
 *   - `crates/tui/src/import_claude.rs` — the engine, 543 lines, doc comment
 *     `:1-18`: "Reads `~/.claude.json` and `~/.claude/settings.json` (bounded,
 *     read-only) and builds a plan — never a silent import."
 *
 * **It is reported, never invoked and never emulated.** Two reasons, and the
 * second is the one that decides it:
 *
 *   1. It writes into `~/.codewhale/imports/`
 *     (`commands/groups/config/import_claude.rs:49-52`) — inside the very tree
 *     a migration must leave untouched, which is this repository's first
 *     invariant ("Sources are read, never written").
 *   2. What it does is **narrower**, not different: on a bare invocation it
 *     writes `claude-import-report.md` and an **unapplied**
 *     `claude-portable-bundle.json`, and `--apply` performs exactly one
 *     mutation — copying `~/.claude/CLAUDE.md` to `~/.codewhale/instructions.md`
 *     when the destination is absent (`:118-131`). MCP servers are named for a
 *     manual `/mcp import` (`:153-159`) and hooks are refused outright
 *     (`:161-166`).
 *
 * So a user running both would find Codewhale's importer had already moved their
 * `CLAUDE.md` into `~/.codewhale/instructions.md`, which is a file this importer
 * *does* read as a global instruction document. That is a genuine interaction and
 * the report names it rather than leaving the user to discover a file that moved.
 */
export const CODEWHALE_IMPORT_CLAUDE = {
	command: "/import-claude",
	commandModule: "crates/tui/src/commands/groups/config/import_claude.rs",
	engineModule: "crates/tui/src/import_claude.rs",
	commandLines: 305,
	engineLines: 543,
	/** The one file `--apply` moves, and where it lands. */
	writesClaudeMdTo: "instructions.md",
} as const;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Whether a directory exists and holds something, as `sourceHasContent` reads it.
 *
 * The same test, spelled out rather than imported, because `migrate-types.ts`
 * owns that one and importing it here would close a cycle the source registry
 * exists to keep one-way.
 */
export function codewhaleTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

/**
 * The config-file override, if one is set, and the environment it came from.
 *
 * `config_path_override()` (`crates/config/src/lib.rs:145-150`) prefers
 * `CODEWHALE_CONFIG_PATH` and falls back to `DEEPSEEK_CONFIG_PATH`, both through
 * `absolute_path_env` — so `~` is expanded and a relative value is **rejected**,
 * the same way `CODEWHALE_HOME` is. `expandLeadingTilde` is shared with
 * {@link resolveCodewhaleHome} for that reason.
 */
export function codewhaleConfigOverride(
	home: CodewhaleHome,
	env: CodewhaleEnv = process.env,
): { path: string; from: string } | null {
	for (const name of [CODEWHALE_CONFIG_PATH_ENV, CODEWHALE_LEGACY_CONFIG_PATH_ENV]) {
		const raw = env[name];
		if (raw === undefined) continue;
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		const expanded = expandLeadingTilde(trimmed, home.root);
		if (expanded === null || !isAbsolute(expanded)) continue;
		return { path: expanded, from: name };
	}
	return null;
}

/**
 * The config document, honouring a file-level override when one is set.
 *
 * `resolve_config_path` (`crates/config/src/lib.rs:6419-6427`) consults the
 * override **before** the default, so this does too — and because an override
 * names a file rather than a tree, the two `permissions.toml` and `settings.toml`
 * candidates move with it: `permissions.toml` is a sibling of whatever
 * `config.toml` resolved to (`config/src/lib.rs:6620-6623`) and `settings.toml`
 * is looked for beside the override (`settings.rs:2438-2442`).
 */
export function codewhaleConfigPathWithOverride(home: CodewhaleHome, env: CodewhaleEnv = process.env): string {
	return codewhaleConfigOverride(home, env)?.path ?? codewhaleConfigPath(home);
}

/** `permissions.toml` beside the resolved `config.toml`, which is what the product reads. */
export function codewhalePermissionsPathWithOverride(home: CodewhaleHome, env: CodewhaleEnv = process.env): string {
	const overridden = codewhaleConfigOverride(home, env);
	if (overridden !== null) return join(resolve(overridden.path, ".."), "permissions.toml");
	return codewhalePermissionsPath(home);
}

/** `settings.toml` beside the resolved `config.toml` when one is overridden. */
export function codewhaleSettingsPathWithOverride(home: CodewhaleHome, env: CodewhaleEnv = process.env): string {
	const overridden = codewhaleConfigOverride(home, env);
	if (overridden !== null) return join(resolve(overridden.path, ".."), "settings.toml");
	return codewhaleSettingsCandidates(home)[0];
}
