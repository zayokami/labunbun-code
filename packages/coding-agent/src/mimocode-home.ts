/**
 * MiMo Code's user state: the four roots it resolves, every path
 * `mimocode-read.ts` opens, and the two things this source names but never reads.
 *
 * **Every path claim in this module carries the line it was read from.** The
 * citations are `packages/shared/src/global.ts`, `packages/cli/src/config/*` and
 * `packages/cli/src/storage/db.ts` in the source tree this importer was written
 * against, and they are line numbers rather than searchable literals — this is
 * an unminified TypeScript tree, so a line number is as stable as a literal and
 * far more readable.
 *
 * **The README is wrong about where MiMo Code keeps its files, and this module
 * follows the code.** `README.md:385` claims `%LOCALAPPDATA%\mimocode\` and
 * `:422` claims macOS `~/Library/Application Support/mimocode/`. Neither path
 * appears anywhere in the tree: `packages/shared/src/global.ts:2` imports
 * `xdg-basedir` and there is **no `process.platform` test in the file at all** —
 * `:1-50` is four `path.join`s over four XDG constants. So on Windows the tree
 * is at `%USERPROFILE%\.config\mimocode`, and the same is true on macOS where it
 * is `~/.config/mimocode`. A future reader will find the README first, so the
 * disagreement is repeated here rather than left to be rediscovered.
 *
 * **Four roots, and two of them are siblings rather than nested.** `MIMOCODE_HOME`
 * set gives `$MIMOCODE_HOME/{config,data,state,cache}`; unset gives
 * `{xdgConfig,xdgData,xdgState,xdgCache}/mimocode` with `APP = "mimocode"`
 * (`global.ts:6`). `config` and `data` are **siblings under either root**, which
 * is why labunbun's single-string `SOURCE_ROOTS` cannot express this source and
 * `migrate-types.ts` needed a `detectionRoots()` branch for it.
 *
 * **Nothing here calls `os.homedir()`.** The `home` argument is the only source
 * of a home directory, which is what lets a test point this at a fixture. The
 * product's own `homedir()` appears in the quoted source, never in the code.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The environment block
// ---------------------------------------------------------------------------

/**
 * The environment block the resolution reads; injectable so tests need no
 * `process.env`.
 *
 * **The type is what keeps the hermetic-test guard satisfied.** Every function
 * below takes this as a parameter and reads `env.<NAME>`, never the ambient
 * environment block — `test/source-env-coverage.test.ts` scans `src/*.ts` for the
 * member-expression spelling and fails on a name absent from
 * `MIGRATION_ENV_VARS`, which is the guard that once let `CURSOR_DATA_DIR` leak a
 * developer's real Cursor tree into every test in the repository. See
 * `qoder-home.ts`'s `QoderEnv`, which makes the same trade.
 *
 * **This comment was itself a false positive before it was reworded**, which is
 * the scan being right for the wrong reason: it is a plain text match, so a
 * *mention* of the spelling in prose is reported exactly as a read is. Naming the
 * shape in words rather than in the member expression keeps the explanation and
 * drops the false report, and that is the whole trade — the alternative is adding
 * a variable name to a list whose every other entry is a variable labunbun really
 * reads.
 */
export type MiMoCodeEnv = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// The four roots
// ---------------------------------------------------------------------------

/** The directory name under every XDG base, verbatim: `const APP = "mimocode"`. */
export const MIMOCODE_APP = "mimocode";

/** The one root override. Set → absolute → the four roots become its subdirectories. */
export const MIMOCODE_HOME_ENV = "MIMOCODE_HOME";

/** An extra config **directory**, searched alongside `<config>` for every asset. */
export const MIMOCODE_CONFIG_DIR_ENV = "MIMOCODE_CONFIG_DIR";

/**
 * An extra config **file**, merged after the global one.
 *
 * `config/config.ts:820-822`: `if (Flag.MIMOCODE_CONFIG) merge(Flag.MIMOCODE_CONFIG, loadFile(…))`,
 * after `loadGlobal` has already folded the three `<config>/` documents together.
 * A file, not a directory — the sibling {@link MIMOCODE_CONFIG_DIR_ENV} is the
 * directory, and confusing the two is what makes a reader look for
 * `<file>/mimocode.json` and find nothing.
 */
export const MIMOCODE_CONFIG_FILE_ENV = "MIMOCODE_CONFIG";

/** Relocates the session database. Absolute, `<data>/`-relative, or `:memory:`. */
export const MIMOCODE_DB_ENV = "MIMOCODE_DB";

/** The TUI's own document, merged after `<config>/tui.json(c)` and before the project's. */
export const MIMOCODE_TUI_CONFIG_ENV = "MIMOCODE_TUI_CONFIG";

/**
 * The four variables `xdg-basedir` reads, each verbatim when truthy.
 *
 * `xdg-basedir` reads each variable and falls back to
 * `path.join(os.homedir(), …)` — **no `~` expansion and no `resolve`** — so a
 * relative value produces a relative path that resolves against the process's
 * working directory — which is where MiMo Code
 * would look for it too, and where a reader that "helpfully" resolved it would
 * not. An empty value is falsy to `xdg-basedir` and falls through to the
 * fallback; a value of whitespace is *not* falsy, and {@link mimocodeXdgDir}
 * reproduces that rather than trimming, for the same reason `$KIMI_CODE_HOME`
 * is not trimmed in `kimi-home.ts`.
 */
export const XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME";
export const XDG_DATA_HOME_ENV = "XDG_DATA_HOME";
export const XDG_STATE_HOME_ENV = "XDG_STATE_HOME";
export const XDG_CACHE_HOME_ENV = "XDG_CACHE_HOME";

/** Which rule put the tree where it is, so the report can say why it is not the default. */
export type MiMoCodeRootMode = "mimocode-home" | "xdg";

export interface MiMoCodeRoots {
	/** `<config>` — settings documents, `AGENTS.md`, `skill(s)/`, `agent(s)/`, … */
	config: string;
	/** `<data>` — `mimocode.db`, `auth.json`, `mcp-auth.json`, `memory/`, `log/`. */
	data: string;
	/** `<state>` — nothing this importer reads; named so a report can point at it. */
	state: string;
	/** `<cache>` — `bin/` (`global.ts:70`) and anything else MiMo Code downloads. */
	cache: string;
	/** Which of the two rules in `resolveMimocodeHome` answered. */
	mode: MiMoCodeRootMode;
	/**
	 * `$MIMOCODE_HOME` as written, when it was set.
	 *
	 * Kept so the report can say the tree is somewhere unusual without printing a
	 * path that may be on another machine's disk layout. It is a path, not user
	 * content, and {@link MiMoCodeRoots.config} is already printed — this is here
	 * for the *rejected* case below, not as a second copy of the same fact.
	 */
	home: string | null;
	/**
	 * Why `$MIMOCODE_HOME` was refused, or `null`.
	 *
	 * **`resolveMimocodeHome` throws on a relative value** (`global.ts:29-33`:
	 * `MIMOCODE_HOME must be an absolute path, got: …`), so a user who set it that
	 * way has a MiMo Code that refuses to start. This importer must not throw
	 * either — a migration that aborts on one source's misconfiguration loses every
	 * other source's import — so it falls back to the XDG spelling and reports the
	 * refusal, rather than silently reading a tree the product itself rejected.
	 */
	rejectedHome: string | null;
}

/** One XDG base: the variable verbatim if truthy, else the POSIX fallback. */
function mimocodeXdgDir(envVar: string, fallback: string, home: string, env: MiMoCodeEnv): string {
	return join(env[envVar] || join(home, ...fallback.split("/")), MIMOCODE_APP);
}

/**
 * True for a path MiMo Code would use without resolving it against a base.
 *
 * Both spellings, deliberately: `path.isAbsolute` in `global.ts:29` is
 * platform-dependent, and a `MIMOCODE_HOME` written on Windows and read on Linux
 * is absolute in every sense that matters here. Testing only this process's
 * spelling would call a working configuration refused.
 */
export function isMiMoCodeAbsolutePath(value: string): boolean {
	return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value);
}

/**
 * The four roots, resolved the way `resolveMimocodeHome` resolves them.
 *
 * `$MIMOCODE_HOME` wins outright when it is a non-empty **absolute** path, and
 * the four roots become its `{config,data,state,cache}` subdirectories in that
 * order. Otherwise all four come from the XDG bases with `mimocode` appended,
 * which is the branch that runs on every machine that has not set the variable —
 * **including every Windows machine**, because `xdg-basedir@5.1.0` has no
 * platform branch.
 *
 * **`config` and `data` are siblings under either root.** That is the whole
 * reason this source needs a `detectionRoots()` branch: labunbun's `SOURCE_ROOTS`
 * holds one home-relative string per source, and there is no single directory
 * here that answers "is MiMo Code installed".
 */
export function mimocodeRoots(home: string, env: MiMoCodeEnv): MiMoCodeRoots {
	const configured = env[MIMOCODE_HOME_ENV];
	if (configured !== undefined && configured !== "") {
		if (!isMiMoCodeAbsolutePath(configured)) {
			return {
				...xdgRoots(home, env),
				home: configured,
				rejectedHome:
					`${MIMOCODE_HOME_ENV} is set to a relative path, which MiMo Code itself refuses — \`resolveMimocodeHome\` throws ` +
					"`MIMOCODE_HOME must be an absolute path` before it reads anything (packages/shared/src/global.ts:29-33), so a " +
					"MiMo Code configured that way is one that will not start. This import read the XDG locations instead; set the variable to an " +
					"absolute path and re-run if that is not where your tree lives",
			};
		}
		return {
			config: join(configured, "config"),
			data: join(configured, "data"),
			state: join(configured, "state"),
			cache: join(configured, "cache"),
			mode: "mimocode-home",
			home: configured,
			rejectedHome: null,
		};
	}
	return xdgRoots(home, env);
}

/** The `mode: "xdg"` arm of {@link mimocodeRoots}, spelled once. */
function xdgRoots(home: string, env: MiMoCodeEnv): MiMoCodeRoots {
	return {
		config: mimocodeXdgDir(XDG_CONFIG_HOME_ENV, ".config", home, env),
		data: mimocodeXdgDir(XDG_DATA_HOME_ENV, ".local/share", home, env),
		state: mimocodeXdgDir(XDG_STATE_HOME_ENV, ".local/state", home, env),
		cache: mimocodeXdgDir(XDG_CACHE_HOME_ENV, ".cache", home, env),
		mode: "xdg",
		home: null,
		rejectedHome: null,
	};
}

// ---------------------------------------------------------------------------
// The settings documents
// ---------------------------------------------------------------------------

/**
 * The three global settings documents, **in the order `loadGlobal` merges them**.
 *
 * `config/config.ts:630-636`:
 *
 * ```js
 * let result = pipe({},
 *   mergeDeep(yield* loadFile(path.join(Global.Path.config, "config.json"),    modelsOnly)),
 *   mergeDeep(yield* loadFile(path.join(Global.Path.config, "mimocode.json"),  modelsOnly)),
 *   mergeDeep(yield* loadFile(path.join(Global.Path.config, "mimocode.jsonc"), modelsOnly)))
 * ```
 *
 * **So the `.jsonc` is the last and wins, and `config.json` is the first and
 * loses** — which is the opposite of what the filenames suggest to anyone who
 * assumes the more specific name is the base. `mergeDeep` is a *deep* merge, not
 * a replace, so a machine carrying all three is running a document no single file
 * describes.
 *
 * After the global three, and in this order: `$MIMOCODE_CONFIG`'s file
 * (`:820-822`), then every `.mimocode/mimocode.json(c)` found walking **up** from
 * the working directory (`:825-830`, via `ConfigPaths.files`, which walks up and
 * then `.toReversed()`s so the nearest directory is applied last).
 *
 * Every one of these is **JSONC**: `loadFile` runs the text through
 * `ConfigVariable.substitute` and then `ConfigParse.jsonc`, so a comment and a
 * trailing comma are legal in a file whose extension promises plain JSON. Reading
 * them with `JSON.parse` alone throws away a whole settings document.
 */
export const MIMOCODE_SETTINGS_FILES: readonly string[] = ["config.json", "mimocode.json", "mimocode.jsonc"];

/**
 * Keys deleted from every loaded document **before** the schema sees it.
 *
 * `config/config.ts:61-75`, verbatim in effect:
 *
 * ```js
 * delete copy.history
 * delete copy.auto_worktree
 * const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
 * if (!hadLegacy) return copy
 * delete copy.theme; delete copy.keybinds; delete copy.tui
 * ```
 *
 * **This is load-bearing for a reader.** `Info` is `.strict()`
 * (`config.ts:500` — "additionalProperties: false in openapi.json"), so a
 * document carrying one of these five keys would fail validation if they were
 * left in. MiMo Code deletes them first, so a file carrying them is a file MiMo
 * Code reads; a reader that does not delete them reports five keys the user
 * never set as "unhandled", or — worse — validates them and refuses the whole
 * document. They are removed here and named in the report rather than dropped in
 * silence, because a user who *wrote* `theme` is owed the sentence that it is no
 * longer read by anything.
 */
export const MIMOCODE_LEGACY_KEYS: readonly string[] = ["history", "auto_worktree", "theme", "keybinds", "tui"];

/** `<config>/tui.json` | `tui.jsonc` — the TUI's own layer, separate from the 41-key document. */
export const MIMOCODE_TUI_FILES: readonly string[] = ["tui.json", "tui.jsonc"];

/**
 * Top-level keys whose value is a **map from a name the user chose to an entry**.
 *
 * **The distinction this set exists to draw is between a key that names a slot and
 * a key that names a thing.** `headers.authorization` is a slot: the credential is
 * under it, and deleting it removes the credential and nothing else.
 * `mcp.keyboard-mcp` is not a slot — it is *the name of an MCP server the user
 * created*, and deleting it deletes the server, its command array and its
 * environment with it. `looksLikeSecretName` matches `KEY` inside it, and the naive
 * walk takes that as a finding.
 *
 * **So the scrub's job is to drop credential-shaped keys *inside* an entry and
 * never the entry itself**: below one of these keys the immediate children are
 * names the user typed, so they are stepped over and only the entries' own
 * contents are scrubbed. This is the same rule `qoder-read.ts` applies to
 * `mcpServers` and `hooks`, and it is stated rather than inherited because MiMo
 * Code's own redaction list (`config/mcp.ts:82`) would get it wrong in exactly
 * this direction — it is a substring test (`mcp.ts:91-93`), so it flags
 * `keyboard-mcp`, `monkey` and `/etc/keys` as sensitive.
 *
 * **Every entry here is a key whose *own* name is a noun the user chose**, so the
 * key itself is still tested and still deleted if it matches: `mcp` does not, and
 * a settings file whose top level carried `apiKey` still loses it. What is exempt
 * is the next level.
 *
 *   - `mcp` — `<server name>` → `Local` / `Remote` (`config/mcp.ts:16-73`).
 *   - `provider` — `<provider id>` → `ProviderConfig`, whose `options` may hold
 *     `apiKey` and whose `headers` may hold a bearer (`config/provider.ts:64,89`).
 *   - `agent` — `<agent name>` → an agent definition with a `prompt` body.
 *   - `command` — `<command name>` → a command definition (`config/config.ts:115`).
 *   - `model_groups` — `<group name>` → a named set of models (`config/config.ts:158`).
 *   - `lsp` — `<language>` → `{command, environment}`; `lsp.<x>.env` is the
 *     credential channel (`config/lsp.ts`).
 *   - `permission` — `<verb>` or `<path pattern>` → `allow` | `deny` | `ask`, and
 *     **nothing else can be there**: `config/permission.ts:16` is
 *     `Schema.Union([Action, Object])` over exactly those three literals. This one
 *     is here because of a real false positive a test found rather than a
 *     theoretical one — `looksLikeSecretName` matches `SECRET` and `KEY` as
 *     substrings, so a rule as ordinary as `read: {"~/secrets/*": "deny"}` had its
 *     **pattern** deleted as though it were a credential, which silently turned the
 *     user's deny rule into nothing.
 *   - `enabled_providers` / `disabled_providers` — arrays, so the exemption does
 *     not apply, but they are listed so a reader does not have to re-derive the set
 *     when one of them grows an object-valued member.
 */
/**
 * Subtrees that provably contain no credential, however deep.
 *
 * **`permission` is here and not in {@link MIMOCODE_ENTRY_MAP_KEYS}, and the
 * difference is one level of nesting and it cost a test to find.**
 * `permission` is two levels of names the user chose: `<verb>` then `<path
 * pattern>` (`config/permission.ts:56`, where `ObjectShape` is a
 * `Schema.StructWithRest` over a `Schema.Record(String, Rule)`). The entry-map
 * exemption protects the *first* level — the verb — and then walks the verb's
 * contents normally, so the **pattern** was tested as though it were a key, and a
 * rule as ordinary as `read: {"~/secrets/*": "deny"}` had its pattern deleted for
 * containing `SECRET`. The user would have been left with `read: {}` and no report
 * line about it beyond the scrub's own, which claimed a credential they never wrote.
 *
 * **The whole subtree is safe, and that is provable rather than assumed:** `Rule`
 * is `Schema.Union([Action, Object])` over
 * `Action = Schema.Literals(["allow", "deny", "ask"])` (`config/permission.ts:8-16`),
 * so the only leaf values anywhere under `permission` are those three words. There
 * is no `apiKey`, no `token` and no `headers` for a walk to find at any depth — the
 * exceptions it would find are all key *names*, and the point of the exemption is
 * that the names are the user's.
 *
 * **One entry, and it is short on purpose.** A subtree belongs here when its leaf
 * values are drawn from a closed vocabulary the schema pins, not merely when no
 * credential has been observed in it. `tools` (a map of tool name to boolean) would
 * pass the second test and fail the first, which is why it is not here.
 */
export const MIMOCODE_NON_CREDENTIAL_SUBTREES: ReadonlySet<string> = new Set(["permission"]);

export const MIMOCODE_ENTRY_MAP_KEYS: ReadonlySet<string> = new Set([
	"mcp",
	"provider",
	"agent",
	"command",
	"model_groups",
	"lsp",
	"enabled_providers",
	"disabled_providers",
]);

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * The directory names a skill may live in, both spellings, under each root.
 *
 * `config/skills.ts` scans `{skill,skills}/` for a `SKILL.md` at any depth, the
 * way `config/agent.ts:129` scans `{agent,agents}/` for a `.md` at any depth and
 * `config/command.ts:29-34` scans `{command,commands}/` for the same;
 * `config/plugin.ts:33` scans `{plugin,plugins}/` for `*.ts` and `*.js` one level
 * down. **Both spellings are always live** — this is
 * not one deprecated name and one current one, it is a brace expansion, and a
 * user with `skill/` gets their skills read.
 *
 * The roots themselves come from `ConfigPaths.directories` (`config/paths.ts:24-39`):
 * `<config>`, every `.mimocode` walking up from the working directory, every
 * `.mimocode` walking up from the home, and `$MIMOCODE_CONFIG_DIR`.
 */
export const MIMOCODE_SKILL_DIRS: readonly string[] = ["skill", "skills"];
export const MIMOCODE_AGENT_DIRS: readonly string[] = ["agent", "agents"];
export const MIMOCODE_MODE_DIRS: readonly string[] = ["mode", "modes"];
export const MIMOCODE_COMMAND_DIRS: readonly string[] = ["command", "commands"];
export const MIMOCODE_PLUGIN_DIRS: readonly string[] = ["plugin", "plugins"];

/** `<root>/<one of the spellings>`, for the root MiMo Code would search. */
export function mimocodeAssetDirs(root: string, spellings: readonly string[]): string[] {
	return spellings.map((name) => join(root, name));
}

/**
 * A skill or agent file's name, path-relative and **with the nesting kept**.
 *
 * `config/entry-name.ts:12-16` verbatim:
 *
 * ```js
 * export function configEntryNameFromPath(filePath, searchRoots) {
 *   const candidate = sliceAfterMatch(filePath, searchRoots) ?? path.basename(filePath)
 *   const ext = path.extname(candidate)
 *   return ext.length ? candidate.slice(0, -ext.length) : candidate
 * }
 * ```
 *
 * with `sliceAfterMatch` cutting everything up to and including the first search
 * root it finds. So `agents/team/reviewer.md` is named **`team/reviewer`**, not
 * `reviewer`. **Flattening it creates collisions** — two teams each with a
 * `reviewer.md` become one name, and `collectFileWrites` would report one kept
 * and one skipped for two skills the user plainly has. A skill here is one
 * directory per name, so a name carrying a `/` becomes nested directories at the
 * target; that is the only lossless spelling.
 *
 * The roots are the *whole* `patterns` arrays the product passes
 * (`config/agent.ts:146`, `config/command.ts:47-52`), which is why `.claude` is
 * in the command list and not in the agent one — see
 * {@link MIMOCODE_CLAUDE_COMMAND_ROOTS}.
 */
export function mimocodeEntryName(relativePath: string): string {
	const normalized = relativePath.replace(/\\/g, "/");
	const ext = normalized.slice(normalized.lastIndexOf("."));
	const withoutExtension =
		ext.length > 0 && normalized.lastIndexOf(".") > normalized.lastIndexOf("/")
			? normalized.slice(0, -ext.length)
			: normalized;
	return withoutExtension;
}

/**
 * Roots a **command** file may be named relative to, verbatim from
 * `config/command.ts:47-52`:
 *
 * ```js
 * const patterns = ["/.mimocode/command/", "/.mimocode/commands/",
 *                    "/.claude/command/",     "/.claude/commands/",
 *                    "/command/",             "/commands/"]
 * ```
 */
export const MIMOCODE_CLAUDE_COMMAND_ROOTS: readonly string[] = [
	"/.mimocode/command/",
	"/.mimocode/commands/",
	"/.claude/command/",
	"/.claude/commands/",
	"/command/",
	"/commands/",
];

/**
 * Roots an **agent** file may be named relative to, verbatim from
 * `config/agent.ts:146`:
 *
 * ```js
 * const patterns = ["/.mimocode/agent/", "/.mimocode/agents/", "/agent/", "/agents/"]
 * ```
 *
 * **The asymmetry is real, verified, and worth reproducing.** `.claude/command/`
 * and `.claude/commands/` are in this product's name-derivation list and
 * `.claude/agent/` and `.claude/agents/` are **not** — so MiMo Code names Claude
 * Code's commands but has no spelling for Claude Code's agents. It is also true
 * at the *load* level rather than only at the name level: `ConfigPaths
 * .claudeCommandDirectories` (`config/paths.ts:41-55`) returns `<home>/.claude`
 * and every `.claude` walking up from the working directory, and
 * `config/config.ts:844-847` feeds exactly that list to `ConfigCommand.load` —
 * there is no `claudeAgentDirectories` and no `ConfigAgent.load` call for it.
 *
 * So `.claude/commands/*.md` **is** read by MiMo Code and `.claude/agents/*.md`
 * is **not**. Importing the latter would import files the product itself ignores
 * and attribute them to a tool that never looked at them.
 */
export const MIMOCODE_AGENT_NAME_ROOTS: readonly string[] = [
	"/.mimocode/agent/",
	"/.mimocode/agents/",
	"/agent/",
	"/agents/",
];

/**
 * The working directories a `.claude` tree is read from, as paths this importer
 * can construct: `<home>/.claude` and `<cwd>/.claude`.
 *
 * `config/paths.ts:44-53` returns `<home>/.claude` plus every `.claude` walking
 * **up** from the working directory with the walk rooted at the project. The
 * walk stops at the project root, so the two named here are the two a reader
 * with a `cwd` can name; the intermediate directories are a function of where the
 * project happens to sit and {@link mimocodeReadRoots} walks them itself.
 */
export function mimocodeClaudeCommandRoots(home: string, cwd: string): string[] {
	return [join(home, ".claude"), join(cwd, ".claude")];
}

// ---------------------------------------------------------------------------
// Skills MiMo Code borrows from other tools
// ---------------------------------------------------------------------------

/**
 * One tree MiMo Code reads skills out of that **is not its own**.
 *
 * `skill/index.ts:24-27`:
 *
 * ```js
 * // Scan order is load order: later roots win same-name collisions against earlier
 * // non-bundled skills. Open-standard .agents sits last among brand roots;
 * // .mimocode config dirs load after these.
 * const EXTERNAL_DIRS = [".claude", ".codex", ".opencode", ".agents"]
 * const EXTERNAL_SKILL_PATTERN = <glob under skills/ for a SKILL.md at any depth>
 * ```
 *
 * scanned at `<home>/<dir>` (`skill/index.ts:232-235`) and, for the project scope,
 * at every `<dir>` walking **up** from the working directory (`:257-261`). So a
 * MiMo Code install sees Claude Code's, Codex's and OpenCode's skills with no
 * configuration at all — that is the point of the list.
 */
export interface MiMoCodeVendorSkillDir {
	/** The directory name under a home or a working directory. */
	dir: string;
	/** Which tool actually writes it, and whose files these are. */
	owner: string;
	/** Which labunbun source imports it, when one does. `null` when none does. */
	labunbunSource: string | null;
	/** Whether MiMo Code reads it with nothing configured. */
	onByDefault: boolean;
	/** The variable that turns it on, when it is off by default. */
	enableEnv: string | null;
	/** The variable that turns it off, when it is on by default. */
	disableEnv: string | null;
}

/**
 * The four trees, in the product's own scan order.
 *
 * **`.agents` is the sharp one and it is why this constant exists.**
 * `skill/index.ts:34-42` keeps it **on unless** `MIMOCODE_DISABLE_AGENTS_SKILLS`
 * is set, while the other three need an explicit
 * `MIMOCODE_ENABLE_{CLAUDE_CODE,CODEX,OPENCODE}_SKILLS`. `~/.agents` is also a tree
 * **this repository already migrates**, as its `agents` source. Importing it here
 * as well would write every one of the user's skills twice — once attributed to
 * `agents` and once to `mimocode-code` — and both report lines would say they were
 * imported. This is the same bug `KIMI_SHARED_TREE` in `kimi-read.ts` exists to
 * prevent, reached the same way, by a product that harvests the shared tree.
 *
 * **None of the four is imported, and the other three are named instead.** They
 * are other products' files: importing `~/.claude/skills` as MiMo Code's would
 * file Claude Code's skills under the wrong product's name, and the user's
 * `claude-code` migration already imports them. `opencode` is the one labunbun
 * source that does *not* import its `skills/` tree — it harvests the tree but
 * imports only its providers, MCP and AGENTS.md — so the honest line there names
 * the directory and says the user must copy it by hand.
 */
export const MIMOCODE_VENDOR_SKILL_DIRS: readonly MiMoCodeVendorSkillDir[] = [
	{
		dir: ".claude",
		owner: "Claude Code",
		labunbunSource: "claude-code",
		onByDefault: false,
		enableEnv: "MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS",
		disableEnv: null,
	},
	{
		dir: ".codex",
		owner: "Codex",
		labunbunSource: "codex",
		onByDefault: false,
		enableEnv: "MIMOCODE_ENABLE_CODEX_SKILLS",
		disableEnv: null,
	},
	{
		dir: ".opencode",
		owner: "OpenCode",
		// `opencode-read.ts` harvests the tree for its own inventory and imports
		// providers, MCP and `AGENTS.md` — not `skills/`. So there is no source here
		// to file these under, which is why the report says "by hand".
		labunbunSource: null,
		onByDefault: false,
		enableEnv: "MIMOCODE_ENABLE_OPENCODE_SKILLS",
		disableEnv: null,
	},
	{
		dir: ".agents",
		owner: "the shared agent home",
		labunbunSource: "agents",
		onByDefault: true,
		enableEnv: null,
		disableEnv: "MIMOCODE_DISABLE_AGENTS_SKILLS",
	},
];

// ---------------------------------------------------------------------------
// Instruction documents
// ---------------------------------------------------------------------------

/**
 * The three document names MiMo Code injects, verbatim from
 * `session/instruction.ts:17-21`.
 *
 * ```js
 * const FILES = ["AGENTS.md",
 *   ...(Flag.MIMOCODE_DISABLE_CLAUDE_CODE_PROMPT ? [] : ["CLAUDE.md"]),
 *   "CONTEXT.md"] // deprecated
 * ```
 *
 * `AGENTS.md` is unconditional, `CLAUDE.md` is gated on a flag that defaults to
 * loading it, and `CONTEXT.md` is marked deprecated in the source's own comment —
 * which is why it is read here but reported as deprecated rather than as an
 * instruction MiMo Code prefers.
 */
export const MIMOCODE_INSTRUCTION_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];

/** The character count below which a project `AGENTS.md` also pulls in `CLAUDE.md`. */
export const MIMOCODE_CLAUDE_FALLBACK_MAX_CHARS = 500;

/**
 * The **global** instruction documents, in the order `globalFiles` returns them
 * (`session/instruction.ts:28-36`).
 *
 * ```js
 * if (Flag.MIMOCODE_CONFIG_DIR) files.push(path.join(Flag.MIMOCODE_CONFIG_DIR, "AGENTS.md"))
 * files.push(path.join(Global.Path.config, "AGENTS.md"))
 * files.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
 * ```
 *
 * **`~/.claude/CLAUDE.md` is a fourth source's file and is named, not read.** This
 * repository already migrates `~/.claude` as `claude-code`; importing it here
 * would land a second copy of the same instructions under a different product's
 * name — the failure `OPENCODE_VENDOR_DIRS` in `opencode-home.ts:233` exists to
 * prevent, and the same rule for the same reason.
 */
export function mimocodeGlobalInstructionPaths(configRoot: string, configDirEnv: string | undefined): string[] {
	const files: string[] = [];
	if (configDirEnv !== undefined && configDirEnv !== "") files.push(join(configDirEnv, "AGENTS.md"));
	files.push(join(configRoot, "AGENTS.md"));
	return files;
}

/** `<home>/.claude/CLAUDE.md` — named so the report can say it was not read. */
export function mimocodeVendoredClaudeMd(home: string): string {
	return join(home, ".claude", "CLAUDE.md");
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * The three memory scopes, verbatim from `memory/paths.ts:47`:
 *
 * ```js
 * const m = absPath.match(/\/memory\/(global|projects|sessions)(?:\/([^/]+))?\/(.+)\.md$/)
 * ```
 *
 * so a memory file is `<data>/memory/<scope>/[<id>/]<key>.md`, with `global`
 * carrying no id (`scope_id = scope === "global" ? "" : (idMaybe ?? "")`, `:50`) and
 * `<key>` itself allowed to contain `/` for nested directories.
 */
export const MIMOCODE_MEMORY_SCOPES: readonly string[] = ["global", "projects", "sessions"];

/** `<data>/memory` — the machine-wide memory root. */
export function mimocodeMemoryRoot(dataRoot: string): string {
	return join(dataRoot, "memory");
}

/**
 * Parse a memory file's path back into `{scope, scopeId, key}`, or `null`.
 *
 * `memory/paths.ts:46-53` reproduced, including the optional id segment and the
 * `global`-has-no-id rule. Reproduced rather than approximated because the three
 * cases have different target shapes: a `global` entry and a `projects/<slug>`
 * entry are different documents, and a reader that filed them all under one name
 * would write two rules to one path.
 */
export function mimocodeMemoryPath(path: string): { scope: string; scopeId: string; key: string } | null {
	const normalized = path.replace(/\\/g, "/");
	const marker = normalized.lastIndexOf("/memory/");
	if (marker === -1) return null;
	const rest = normalized.slice(marker + "/memory/".length);
	const parts = rest.split("/");
	if (parts.length < 2 || !parts[parts.length - 1].endsWith(".md")) return null;
	const scope = parts[0];
	if (!MIMOCODE_MEMORY_SCOPES.includes(scope)) return null;
	// **`global` has no id segment and the other two do**, which is the one asymmetry
	// in the pattern (`:47`, with `scope_id = scope === "global" ? "" : (idMaybe ?? "")`
	// at `:50`). Slicing by a fixed index gets a nested `global` key wrong — it would
	// drop its first segment — so the index is decided by the scope, which is what
	// the product's own regex capture decides.
	const hasId = scope !== "global";
	const key = parts
		.slice(hasId ? 2 : 1)
		.join("/")
		.replace(/\.md$/, "");
	if (key === "") return null;
	return { scope, scopeId: hasId ? (parts[1] ?? "") : "", key };
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

/** The database filename for the channels `getChannelPath` short-circuits on. */
export const MIMOCODE_DB_NAME = "mimocode.db";

/**
 * The database this install reads, or `null` when the install keeps none of the
 * names MiMo Code does.
 *
 * `storage/db.ts:33-45`:
 *
 * ```js
 * export function getChannelPath() {
 *   if (["latest","beta","prod"].includes(InstallationChannel) || Flag.MIMOCODE_DISABLE_CHANNEL_DB)
 *     return path.join(Global.Path.data, "mimocode.db")
 *   return path.join(Global.Path.data, `mimocode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g,"-")}.db`)
 * }
 * export const Path = iife(() => {
 *   if (Flag.MIMOCODE_DB) {
 *     if (Flag.MIMOCODE_DB === ":memory:" || path.isAbsolute(Flag.MIMOCODE_DB)) return Flag.MIMOCODE_DB
 *     return path.join(Global.Path.data, Flag.MIMOCODE_DB)
 *   }
 *   return getChannelPath()
 * })
 * ```
 *
 * Three things follow, and all three are cases this function has to handle:
 *
 *   - **`$MIMOCODE_DB` wins outright** and is used verbatim when it is absolute
 *     or `:memory:`. `:memory:` is **not** a file, so a run that resolved it would
 *     be looking for a database that cannot exist — `null` rather than a path.
 *   - **The channel list is not enumerable from here.** `InstallationChannel` is
 *     a build-time constant, so a nightly writes `mimocode-nightly-20260925.db`
 *     and no reader can know which nightlies exist. The data root is listed and
 *     matched instead, exactly as `opencodeDatabasePath` does for OpenCode's own
 *     channel databases.
 *   - **The primary name is checked first**, so a machine with both a release and
 *     a nightly database reads the release — the same preference
 *     `getChannelPath` makes for the `latest`/`beta`/`prod` channels.
 */
export function mimocodeDatabasePath(dataRoot: string, env: MiMoCodeEnv): string | null {
	const named = env[MIMOCODE_DB_ENV];
	if (named !== undefined && named !== "") {
		if (named === ":memory:") return null;
		if (isMiMoCodeAbsolutePath(named)) return named;
		return join(dataRoot, named);
	}
	const primary = join(dataRoot, MIMOCODE_DB_NAME);
	if (mimocodeChannelDatabaseNames(dataRoot).includes(primary)) return primary;
	return mimocodeChannelDatabaseNames(dataRoot)[0] ?? null;
}

/**
 * `mimocode.db` plus every `mimocode-<channel>.db`, sorted so the choice is
 * reproducible across two runs over one install.
 *
 * Sorted, and `mimocode.db` sorts before every `mimocode-…` name only by luck of
 * the ASCII table, so {@link mimocodeDatabasePath} checks the primary by name
 * first rather than relying on the sort.
 */
export function mimocodeChannelDatabaseNames(dataRoot: string): string[] {
	try {
		const names = readdirSync(dataRoot).filter((name) => name === MIMOCODE_DB_NAME || /^mimocode-.+\.db$/.test(name));
		return names.sort().map((name) => join(dataRoot, name));
	} catch {
		return [];
	}
}

/**
 * The `-wal` and `-shm` files a MiMo Code database has beside it.
 *
 * `storage/db.ts:93` runs `PRAGMA journal_mode = WAL` on every connection, so a
 * database that has been written to carries both sidecars. They are named here
 * because the presence of a `-wal` is the cheapest evidence that a MiMo Code is
 * running or crashed mid-write, and because a reader that copied only
 * `mimocode.db` out of the data root would be copying a database whose most
 * recent transactions are still in a file it left behind.
 */
export function mimocodeDatabaseSidecars(dbPath: string): string[] {
	return [`${dbPath}-wal`, `${dbPath}-shm`];
}

// ---------------------------------------------------------------------------
// Credentials — named, never opened
// ---------------------------------------------------------------------------

/**
 * The files and tables that hold credentials, **by name only**.
 *
 * Nothing in this repository opens any of them, and the reason is the same for
 * every entry: a migration report is something a user may paste into an issue, so
 * the sentence that names these quotes the names and nothing else.
 *
 *   - `<data>/auth.json` — `auth/index.ts:9`, written with mode `0o600`
 *     (`:96-98`). Holds every provider key and OAuth refresh token the install has.
 *   - `<data>/mcp-auth.json` — `mcp/auth.ts:32`, the per-server OAuth entries.
 *   - the `account` table — `account/account.sql.ts:6-17`: `email`, `url`,
 *     `access_token`, `refresh_token`, all `notNull`.
 *   - the `session_share` table — `share/share.sql.ts:5-12`: `id`, `secret`,
 *     `url`. The `secret` is the bearer half of a share link.
 */
export const MIMOCODE_CREDENTIAL_FILES: readonly string[] = ["auth.json", "mcp-auth.json"];

export const MIMOCODE_CREDENTIAL_TABLES: readonly string[] = ["account", "account_state", "session_share"];

/**
 * A table whose *rows* are a derived index rather than the user's conversations,
 * and which this importer must not read as content.
 *
 * `history_fts` is SQLite's own full-text shadow over the message bodies: the
 * text it holds is a copy of what `message.data` already says, so reading it as
 * a transcript would duplicate every turn and present the duplicates as
 * separate messages.
 */
export const MIMOCODE_DERIVED_TABLES: readonly string[] = ["history_fts", "external_import"];

/**
 * The message rows that are **subagent turns** rather than the conversation.
 *
 * `session/session.sql.ts:94` gives `agent_id` a `notNull()` default of `"main"`,
 * and both of the product's own readers filter on it: `session/session.ts:964`
 * (`eq(MessageTable.agent_id, "main")`) and `session/message-v2.ts:1217`
 * (`input.agentID === "*" ? undefined : eq(MessageTable.agent_id, input.agentID ?? "main")`).
 *
 * **Not filtering these duplicates the main thread.** A subagent's tool calls and
 * answers are written into the same session's `message` and `part` tables under
 * a different `agent_id`, so a reader that takes every row gets the user's turn
 * followed by the whole of a task the agent ran on their behalf — and the report
 * would say the user asked for it.
 */
export const MIMOCODE_MAIN_AGENT_ID = "main";

// ---------------------------------------------------------------------------
// Managed configuration — report only
// ---------------------------------------------------------------------------

/**
 * The MDM/managed-config directories, and the reason they are here even though
 * nothing reads them.
 *
 * `config/managed.ts:23-36`:
 *
 * ```js
 * switch (process.platform) {
 *   case "darwin": return "/Library/Application Support/opencode"
 *   case "win32":  return path.join(<ProgramData> || "C:\\ProgramData", "opencode")
 *   default:       return "/etc/opencode"
 * }
 * ```
 *
 * The one `<…>` is the environment's `ProgramData` value, written in angle
 * brackets rather than as a member expression: this importer never reads it, and
 * spelling it out would put a name in `test/source-env-coverage.test.ts`'s report
 * for a variable no line of this repository reads. The directory name is what the
 * three arms have in common and it is the point of the quote.
 *
 * **They are still named `opencode`.** MiMo Code is a fork and the rename did not
 * reach this function, so grepping the tree for `mimocode` misses all three
 * directories and a reader concludes there is no managed configuration anywhere.
 * Nothing here is machine-managed state a migration should touch — it belongs to
 * the administrator who deployed it and is overwritten on the next policy push —
 * so it is named in the report and never read.
 */
export function mimocodeManagedConfigDir(platform: string, programData: string | undefined): string {
	if (platform === "darwin") return "/Library/Application Support/opencode";
	if (platform === "win32")
		return join(programData === undefined || programData === "" ? "C:\\ProgramData" : programData, "opencode");
	return "/etc/opencode";
}

// ---------------------------------------------------------------------------
// The roots this importer searches
// ---------------------------------------------------------------------------

/**
 * Every directory `mimocode-read.ts` walks, **in the product's own precedence
 * order — weakest first, so the reader's last-wins de-duplication is the
 * product's**.
 *
 * `ConfigPaths.directories` (`config/paths.ts:24-39`) returns, in order:
 * `<config>`, every `.mimocode` walking up from the working directory,
 * `<home>/.mimocode`, and `$MIMOCODE_CONFIG_DIR`. The two walks are
 * `AppFileSystem.up({targets:[".mimocode"], start, stop})`, root-first — which is
 * why `ConfigPaths.files` calls `.toReversed()` on its own result when it wants
 * the nearest file applied last (`config/paths.ts:19-22`) — and the home walk
 * passes `stop` equal to `start`, so it yields exactly one directory.
 *
 * `config/config.ts:846-892` then folds them in with
 * `mergeDeep(result.command ?? {}, await ConfigCommand.load(dir))` in that
 * order, so **a later directory overwrites an earlier one's entry of the same
 * name**: the nearest `.mimocode` beats `<config>`, and `$MIMOCODE_CONFIG_DIR`
 * beats everything.
 *
 * **Why last-wins and not first-wins.** Qoder's reader keeps the *first* root
 * because Qoder's own precedence is first-wins; copying that reflex here would
 * keep `<config>` over the project directory that MiMo Code would actually have
 * loaded. The difference is not cosmetic: a user who has shadowed a skill in
 * their project is running the project's copy, and importing the global one would
 * hand them a skill their own tool had already overridden. The collision is
 * reported either way, so the copy that lost is named rather than dropped in
 * silence.
 */
export function mimocodeReadRoots(
	home: string,
	roots: MiMoCodeRoots,
	cwd: string | undefined,
	env: MiMoCodeEnv,
): string[] {
	const found = [roots.config];
	if (cwd !== undefined) found.push(...walkUp(cwd, ".mimocode"));
	// The home walk: `afs.up({targets:[".mimocode"], start: Global.Path.home,
	// stop: Global.Path.home})` — the start is also the stop, so it yields exactly
	// one directory, `<home>/.mimocode`.
	found.push(join(home, ".mimocode"));
	const configDirEnv = env[MIMOCODE_CONFIG_DIR_ENV];
	if (configDirEnv !== undefined && configDirEnv !== "") found.push(configDirEnv);
	// `unique()` in the product: a directory named twice is one entry.
	return [...new Set(found.filter((dir) => dir !== ""))];
}

/** Every `.mimocode` from `start` up to and including `start` itself. */
function walkUp(start: string, name: string): string[] {
	const parts = start
		.replace(/\\/g, "/")
		.split("/")
		.filter((part) => part !== "");
	if (parts.length === 0) return [];
	// A leading `/` (or a Windows drive letter, which survives as the first part)
	// is not a directory that can hold one, so the walk starts one level below it.
	const from = parts[0] === "" || /^[a-zA-Z]:$/.test(parts[0]) ? 1 : 0;
	const out: string[] = [];
	for (let i = parts.length; i > from; i -= 1) {
		out.push(join(...parts.slice(0, i), name));
	}
	return out;
}
