/**
 * Where OpenCode keeps its tree.
 *
 * OpenCode is the only source in this repository whose root is not spelled the
 * way anyone would guess, and the reason is worth stating before anything else,
 * because every other line in this file follows from it:
 *
 * **`xdg-basedir@5.1.0` has no Windows branch.** Both of OpenCode's trees pin
 * that version exactly rather than with a range (`packages/core/package.json:126`
 * and `packages/opencode/package.json:151`, both `"xdg-basedir": "5.1.0"`), and
 * that version exports four constants, each of which is its `XDG_*_HOME`
 * environment variable or a POSIX fallback under `os.homedir()`:
 * `xdgConfig` → `<home>/.config`, `xdgData` → `<home>/.local/share`,
 * `xdgState` → `<home>/.local/state`, `xdgCache` → `<home>/.cache`. There is no
 * `process.platform` test anywhere in the package, and none in OpenCode either
 * — `core/src/global.ts:10-13` is four `path.join`s and nothing else.
 *
 * So on Windows the tree is at `C:\Users\<you>\.config\opencode`, **not**
 * `%APPDATA%`. An importer written the way a Windows importer is normally
 * written finds nothing on this machine and reports the source as absent, which
 * is indistinguishable from the user not having OpenCode installed. That is why
 * the fallbacks below are POSIX spellings on every platform, and why the resolved
 * path is carried out to the report: a wrong guess should be visible rather than
 * silent.
 *
 * Everything here computes strings and, for the two questions that cannot be
 * answered from a name alone, stats a path. Nothing is created, and no file
 * outside the caller's own directories is read.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The directory name OpenCode uses under every XDG base. */
export const OPENCODE_DIR_BASENAME = "opencode";

/** OpenCode's own override for the config root (`core/src/global.ts:64`). */
export const OPENCODE_CONFIG_DIR_ENV = "OPENCODE_CONFIG_DIR";

/** The base variables `xdg-basedir` reads first, in its own order. */
export const XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME";
export const XDG_DATA_HOME_ENV = "XDG_DATA_HOME";
export const XDG_STATE_HOME_ENV = "XDG_STATE_HOME";

/** Which rule put a root where it is, so the report can say why it is not the default. */
export type OpencodeRootOrigin = "config-dir" | "xdg-config-home" | "xdg-data-home" | "xdg-state-home" | "default";

/** The three roots, each with the rule that decided it. */
export interface OpencodeRoots {
	/**
	 * `<xdgConfig>/opencode` — where the settings documents and the asset
	 * directories live.
	 *
	 * `OPENCODE_CONFIG_DIR` names the `opencode` directory itself, not the base
	 * it sits in: `Flag.OPENCODE_CONFIG_DIR ?? Path.config` (`core/src/global.ts:64`)
	 * substitutes for the joined path rather than for `xdgConfig`, so the variable
	 * is used exactly as written with no `opencode` appended.
	 */
	config: string;
	/** `<xdgData>/opencode` — where `opencode.db` and the legacy `storage/` live. */
	data: string;
	/** `<xdgState>/opencode` — where `plugin-meta.json` lives. */
	state: string;
	configOrigin: OpencodeRootOrigin;
	dataOrigin: OpencodeRootOrigin;
	stateOrigin: OpencodeRootOrigin;
}

/**
 * The three roots, resolved the way `xdg-basedir` and `core/src/global.ts`
 * resolve them.
 *
 * The variable is used **verbatim** when set: `xdg-basedir` reads
 * `process.env.XDG_CONFIG_HOME` and joins it, with no `~` expansion and no
 * `resolve`, and a value that is not absolute produces a relative path that
 * resolves against the process's working directory — which is where OpenCode
 * would look for it too, so a reader that "helpfully" resolved it would read a
 * different directory than the tool does. An empty value is falsy in
 * `xdg-basedir` (`process.env.XDG_CONFIG_HOME || fallback`), so an empty
 * variable falls through to the fallback here as well; a value of whitespace is
 * *not* falsy, and this reproduces that rather than trimming, for the same
 * reason `$KIMI_CODE_HOME` is not trimmed.
 *
 * What is deliberately absent: `OPENCODE_DB` (a database *file* override, and
 * `:memory:`, which a migration has nowhere to read from), `OPENCODE_TEST_HOME`
 * (a test harness's own home, not a user's), and the desktop app's practice of
 * setting `XDG_*_HOME` itself before OpenCode starts
 * (`desktop/src/main/index.ts:135-138`) — which needs no handling here, since
 * setting the variable is exactly the first rule above.
 */
export function opencodeRoots(home: string): OpencodeRoots {
	const named = process.env[OPENCODE_CONFIG_DIR_ENV];
	if (named) {
		// The override replaces the whole config path, so `data` and `state` still
		// come from the XDG bases — the variable moves one root, not the install.
		return {
			config: named,
			data: xdgDir(XDG_DATA_HOME_ENV, ".local/share", home),
			state: xdgDir(XDG_STATE_HOME_ENV, ".local/state", home),
			configOrigin: "config-dir",
			dataOrigin: process.env[XDG_DATA_HOME_ENV] ? "xdg-data-home" : "default",
			stateOrigin: process.env[XDG_STATE_HOME_ENV] ? "xdg-state-home" : "default",
		};
	}
	return {
		config: xdgDir(XDG_CONFIG_HOME_ENV, ".config", home),
		data: xdgDir(XDG_DATA_HOME_ENV, ".local/share", home),
		state: xdgDir(XDG_STATE_HOME_ENV, ".local/state", home),
		configOrigin: process.env[XDG_CONFIG_HOME_ENV] ? "xdg-config-home" : "default",
		dataOrigin: process.env[XDG_DATA_HOME_ENV] ? "xdg-data-home" : "default",
		stateOrigin: process.env[XDG_STATE_HOME_ENV] ? "xdg-state-home" : "default",
	};
}

/** One XDG base: the variable verbatim if truthy, else the POSIX fallback. */
function xdgDir(envVar: string, fallback: string, home: string): string {
	const value = process.env[envVar];
	return join(value || join(home, ...fallback.split("/")), OPENCODE_DIR_BASENAME);
}

/**
 * The config documents, in the order OpenCode merges them.
 *
 * Later wins, key by key: `mergeConfig` is a `mergeDeep` called three times in
 * this order (`opencode/src/config/config.ts:272-274`). All three go through
 * `ConfigParse.jsonc` (`config.ts:240`) — **not** only the `.jsonc` one — so a
 * comment or a trailing comma in `opencode.json` is legal and `JSON.parse` would
 * reject the whole document, silently migrating nothing from a file the user can
 * see is full of settings.
 */
export const OPENCODE_CONFIG_FILES: readonly string[] = ["config.json", "opencode.json", "opencode.jsonc"];

/**
 * `<config>/config` — the pre-JSON TOML file, in either spelling OpenCode's own
 * launcher knows.
 *
 * `config.ts:276-289` reads it with a TOML import assertion, folds `provider` and
 * `model` into `model` as `"<provider>/<model>"`, writes the result to
 * `config.json` and **deletes** it. A machine that has run a current build
 * therefore cannot have one; a machine that has not is running a build this
 * importer is not reading anyway. It is named rather than parsed, because parsing
 * it would mean a TOML reader this repository has no other use for.
 */
export function opencodeLegacyTomlPath(configRoot: string): string {
	return join(configRoot, "config");
}

/**
 * The database this build opens, or `null` when the install keeps none of the
 * names OpenCode does.
 *
 * `core/src/database/database.ts:43-57`: `OPENCODE_DB` when it names a file,
 * else `opencode.db` for the `latest`/`beta`/`prod` channels, else
 * `opencode-<channel>.db`. The channel filename is the one that has to be looked
 * for rather than computed — a build installed from a nightly writes
 * `opencode-nightly-20260925.db` and this function has no way to know which
 * nightlies exist — so the caller lists the data root and matches
 * `opencode` + `-` + anything.
 */
export function opencodeDatabasePath(dataRoot: string): string | null {
	const named = process.env.OPENCODE_DB;
	if (named && named !== ":memory:" && !isAbsolutePath(named)) {
		return join(dataRoot, named);
	}
	const primary = join(dataRoot, "opencode.db");
	if (existsSync(primary)) return primary;
	for (const name of channelDatabaseNames(dataRoot)) return name;
	return null;
}

/** `opencode-<channel>.db` files, sorted so the choice is reproducible. */
export function channelDatabaseNames(dataRoot: string): string[] {
	try {
		return readdirSync(dataRoot)
			.filter((name) => /^opencode-.+\.db$/.test(name))
			.sort()
			.map((name) => join(dataRoot, name));
	} catch {
		return [];
	}
}

/** True for a path OpenCode would use without resolving against a base. */
function isAbsolutePath(value: string): boolean {
	return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value);
}

/**
 * `<state>/prompt-history.jsonl` — the TUI's own ↑ recall list.
 *
 * Under the *state* base rather than data or config, and the base is the reason it
 * is found: it is the one root a reading migration rarely looks at, so a reader
 * that resolves the config root and stops never sees this file. Both of the other
 * roots are already covered by the settings documents and the database.
 *
 * `packages/tui/src/prompt/history.tsx:53` — `path.join(paths.state, "prompt-history.jsonl")`.
 * The writer trims the file to its own last 50 entries (`:75-78`), so there is no
 * cap to re-apply here.
 */
export function opencodePromptHistoryFile(stateRoot: string): string {
	return join(stateRoot, "prompt-history.jsonl");
}

/**
 * `<data>/storage` — the pre-SQLite on-disk layout.
 *
 * `<data>/storage/session/info/<id>.json`, `.../message/<sid>/<mid>.json` and
 * `.../part/<sid>/<mid>/<pid>.json` (`opencode/src/storage/storage.ts:139-176`).
 * Its presence is what says the install predates the database, and it is
 * reported rather than read: a one-file-per-record tree of a retired generation
 * is a second history reader, and this importer reads the current one.
 */
export function opencodeLegacyStorageDir(dataRoot: string): string {
	return join(dataRoot, "storage");
}

/**
 * The trees OpenCode harvests that belong to another source, and which one.
 *
 * OpenCode reads skills out of `~/.claude` and `~/.agents` as well as its own:
 * `opencode/src/skill/index.ts:21-22` names them `CLAUDE_EXTERNAL_DIR` and
 * `AGENTS_EXTERNAL_DIR`, and `:190-194` scans `path.join(global.home, dir)` with
 * `{ dot: true, scope: "global" }` for every build whose
 * `disableClaudeCodeSkills` is off — which is the default. It walks up from the
 * project directory for the same two names too (`:196-199`).
 *
 * This repository already has sources for both: `claude-code` reads
 * `~/.claude/CLAUDE.md` (`claude-read.ts:45`) and `agents` reads
 * `~/.agents/AGENTS.md` (`agents-read.ts:36`). Importing what OpenCode found
 * would land a second copy of every skill the user has, attributed to the wrong
 * tool — the failure `GROK_VENDOR_DIRS` in `grok-read.ts:386` exists to prevent,
 * and the same rule for the same reason.
 */
export const OPENCODE_VENDOR_DIRS: readonly string[] = [".claude", ".agents"];

/** Which of {@link OPENCODE_VENDOR_DIRS} a path sits inside, if any. */
export function opencodeVendorTree(path: string): string | null {
	const parts = path.replace(/\\/g, "/").split("/");
	for (const dir of OPENCODE_VENDOR_DIRS) {
		if (parts.includes(dir)) return dir;
	}
	return null;
}
