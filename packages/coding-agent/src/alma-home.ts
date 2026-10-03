/**
 * Alma's user state: the **four** independent roots it writes to, every path
 * `alma-read.ts` opens, and the two things this source names and never reads.
 *
 * **Every path claim in this module is quoted from the shipped bundle.** The
 * citation is `out/main/index.js` inside `app.asar` — Alma 0.4.160 — which is
 * minified to two lines, so **a line number would be a lie** and every comment
 * carries the string literal it was taken from instead. Literals are searchable;
 * a line number drifts with any other build.
 *
 * **Four roots, and the app never derives one from another.** This is the fact
 * that shapes every path here, and it is worth stating plainly because two of
 * the four are easy to miss entirely:
 *
 *   1. **Electron `userData`** — 39 occurrences of `getPath("userData")`. On
 *      Windows that is `%APPDATA%\alma`; see {@link ALMA_USER_DATA_DIR}. It holds
 *      the only real database, `chat_threads.db`, and the plugin storage.
 *   2. **`~/.config/alma/`** — 78 occurrences of `".config","alma"`. The
 *      identity documents, `skills/`, `plugins/`, `mcp.json`, `hooks.json`,
 *      `groups/`, `cron/`, `memory/`.
 *   3. **`~/.alma/`** — 15 occurrences of `".alma",`. `bin/`, `npm-cache/`,
 *      `activity-records/`, `cache/`. **Nothing in it is importable**, which is
 *      why {@link almaDetectionRoots} still offers it: a user who has only ever
 *      installed the CLI has this and nothing else.
 *   4. **`~/alma/`** — **no leading dot**, and one occurrence:
 *      `getStablePath(){return B.join(ft.homedir(),"alma","chrome-extension")}`.
 *      Plus `join(D.homedir(),"alma","worktrees")`.
 *
 * Root 4 is the one a reader gets wrong. `.alma` and `alma` are two different
 * directories in the same home, both written by the same product, and an
 * importer that assumed the dot was present would look for a chrome-extension
 * tree that is not there and never notice the one that is.
 *
 * **Nothing here calls `os.homedir()`.** The `home` argument is the only source
 * of a home directory, which is what lets a test point this at a fixture. The
 * product's own `homedir()` appears in the quoted source, never in the code.
 *
 * **The one environment variable is `APPDATA`**, and only to reach root 1. It is
 * a platform path rather than an Alma override — Alma has no
 * `ALMA_HOME`-style variable anywhere in the bundle — and `source-env.ts`
 * already lists it, which is what keeps `readSources` hermetic on a machine
 * with a live Alma install.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The environment block a root is resolved from; injectable so tests need no `process.env`. */
export type AlmaEnv = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// The four roots
// ---------------------------------------------------------------------------

/**
 * `~/.alma`, the dot-prefixed cache/bin root.
 *
 * Quoted from `".alma","bin"` and its three siblings — `npm-cache`,
 * `activity-records`, `cache` — all four present, so the name is attested as a
 * joined segment and not only as a substring. **Nothing under it is
 * configuration**: a `bin/`, an npm cache, a screenshot/activity store and a
 * cache directory. That is why it is a *detection* root and never a read root.
 */
export const ALMA_DEFAULT_DIR = ".alma";

/**
 * `~/alma`, **without** the leading dot.
 *
 * One occurrence of `"alma","chrome-extension"` in the whole bundle, inside
 * `getStablePath()`. A sibling of `~/.alma` rather than a child, which is why
 * this is a constant and not a derivation of {@link ALMA_DEFAULT_DIR}.
 */
export const ALMA_PLAIN_DIR = "alma";

/**
 * The Electron `userData` directory's own name, `"alma"`.
 *
 * `this.dbPath=Y.join(e,"chat_threads.db")` where `e = n?.getPath?n.getPath("userData"):process.cwd()`
 * — the path's **basename** is never spelled in the bundle, because Electron
 * derives it from the app's `name`/`productName` in `package.json`. `alma` is
 * therefore the one claim in this module not taken from a string literal, and it
 * is the claim that matters least: it renders a label, and
 * {@link almaDbPath} takes whatever directory name it is given.
 *
 * The `process.cwd()` fallback is why the name is a parameter rather than a
 * constant baked into the reader: on a machine where `getPath` is unavailable
 * the database lands beside the process rather than under `%APPDATA%`, and a
 * report that named one path would be wrong for the other case. This importer
 * reports the platform path and says when the app-data directory was not
 * resolvable, rather than claiming a location it did not check.
 */
export const ALMA_USER_DATA_DIR = "alma";

/** `~/.config/alma` — the configuration root, and the only one this importer reads files from. */
export function almaConfigDir(home: string): string {
	return join(home, ".config", "alma");
}

/** `~/.alma` — binaries, npm cache, activity records, cache. Named for detection. */
export function almaDotDir(home: string): string {
	return join(home, ALMA_DEFAULT_DIR);
}

/** `~/alma` — the chrome-extension stable path and `worktrees/`. Named for detection. */
export function almaPlainDir(home: string): string {
	return join(home, ALMA_PLAIN_DIR);
}

/**
 * The platform's application-data directory, or `undefined` where there is none.
 *
 * `APPDATA` is set by Windows itself and is the only spelling Electron's
 * `getPath("userData")` resolves through there; macOS and Linux put it under
 * `~/Library/Application Support` and the XDG data base, which this importer does
 * not guess at — **a path this source names but did not read is better than one
 * it names wrongly**, and the report says which platform it is on.
 *
 * **There is deliberately no `process.platform` test**, and that is what makes
 * this testable off Windows. The variable is unset in practice everywhere but
 * Windows, so on those platforms the answer is already `undefined` and the check
 * would change nothing for a real home. It would change a *fixture*: a test that
 * puts a `chat_threads.db` under a temporary `APPDATA` is telling this reader
 * where the userData root is, and refusing the answer because the test happened
 * to run on Linux would leave the whole settings half of this source untested on
 * two thirds of the CI matrix. So a supplied value is trusted on every platform
 * and an absent one is `undefined` on every platform.
 */
export function almaAppData(env: AlmaEnv = process.env): string | undefined {
	const value = env.APPDATA;
	return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * `<appData>/alma` — the Electron `userData` root — or `null` on a platform with
 * no app-data path this importer will guess at.
 */
export function almaUserDataDir(appData: string | undefined, name: string = ALMA_USER_DATA_DIR): string | null {
	return appData === undefined ? null : join(appData, name);
}

/** All four roots, resolved. `userData` is `null` where the platform has no such path. */
export interface AlmaRoots {
	configDir: string;
	dotDir: string;
	plainDir: string;
	userData: string | null;
}

export function almaRoots(home: string, env: AlmaEnv = process.env): AlmaRoots {
	return {
		configDir: almaConfigDir(home),
		dotDir: almaDotDir(home),
		plainDir: almaPlainDir(home),
		userData: almaUserDataDir(almaAppData(env), ALMA_USER_DATA_DIR),
	};
}

/** Whether a directory exists and holds something, as detection reads it. */
export function almaTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

/**
 * The roots whose being non-empty means "Alma is installed here".
 *
 * **Alma is the first source in this repository whose home is four places, and
 * detection needs all four** — not because any one of them is a good marker, but
 * because each of the other three has a state where it is the *only* one that
 * answers:
 *
 *   - `~/.config/alma` holds the identity documents, `mcp.json`, `hooks.json` and
 *     the personal `skills/`. A user who installed Alma and never opened it has
 *     this and nothing else.
 *   - `~/.alma` holds `bin/`, an npm cache, activity records and a cache. **None
 *     of it is importable**, and all four are written by the CLI rather than the
 *     desktop app, so a headless user has this and nothing else.
 *   - `~/alma` holds the chrome-extension copy and `worktrees/`. Also not
 *     importable, and the **no-leading-dot** spelling is the single most-missed
 *     path in the product.
 *   - the `userData` root holds `chat_threads.db` — the conversations — plus
 *     `plugin-storage/` and the plugin account tokens. **A user who has only
 *     ever chatted has this and nothing else**, and it is also the root that
 *     makes `detectSources` fire for someone who deleted `~/.config/alma` to
 *     "clean up" and lost the settings without touching the conversations.
 *
 * The order puts the two that carry importable content first, so a home with
 * more than one of them is detected by the one that has something to read.
 *
 * `userData` is `null` off Windows and is simply absent from the list there
 * rather than replaced by a guessed path — see {@link almaAppData}.
 */
export function almaDetectionRoots(home: string, env: AlmaEnv = process.env): string[] {
	const roots = almaRoots(home, env);
	return roots.userData === null
		? [roots.configDir, roots.dotDir, roots.plainDir]
		: [roots.configDir, roots.userData, roots.dotDir, roots.plainDir];
}

// ---------------------------------------------------------------------------
// Files under the configuration root
// ---------------------------------------------------------------------------

/**
 * `~/.config/alma/mcp.json` — **the** MCP configuration, quoted whole:
 * `this.configPath=J.join(n.getPath("home"),".config","alma","mcp.json")`.
 *
 * One occurrence in the bundle. The shape is `{"mcpServers":{…}}` and the
 * variant is chosen by `"command" in e` versus `"url" in e`, two one-line
 * functions (`Ss` and `As`) that exist for no other purpose.
 */
export function almaMcpPath(configDir: string): string {
	return join(configDir, "mcp.json");
}

/**
 * `~/.config/alma/hooks.json`.
 *
 * Quoted in two pieces, which is why the literal `".config","alma","hooks.json"`
 * **occurs zero times** and a search for it finds nothing — the name is hoisted
 * into a constant first:
 *
 * ```js
 * sz = "hooks.json"
 * iz = new class { configPath; config = { hooks: {} }; …
 *   constructor(){ this.configPath = J.join(n.getPath("home"), ".config", "alma", sz) } … }
 * ```
 *
 * This is the clearest example in Alma of the trap this repository keeps hitting:
 * **a search for the assembled path is not a search for the path.** The same
 * applies to every other name below — `mcp.json` happens to be inline, `SOUL.md`
 * is not.
 */
export function almaHooksPath(configDir: string): string {
	return join(configDir, "hooks.json");
}

/** `~/.config/alma/skills` — the personal skill root, Alma's own. */
export function almaSkillsDir(configDir: string): string {
	return join(configDir, "skills");
}

/** `~/.config/alma/plugins` — installed plugins, each with its own `plugin.json`. */
export function almaPluginsDir(configDir: string): string {
	return join(configDir, "plugins");
}

/** `~/.config/alma/memory` — the long-term memory directory beside `MEMORY.md`. */
export function almaMemoryDir(configDir: string): string {
	return join(configDir, "memory");
}

/** `~/.config/alma/groups` — chat-group state, `telegram-state.json` and so on. */
export function almaGroupDir(configDir: string): string {
	return join(configDir, "groups");
}

/** `~/.config/alma/cron` — the scheduled-job store. */
export function almaCronDir(configDir: string): string {
	return join(configDir, "cron");
}

/** `~/alma/worktrees` — `getWorktreeBaseDir(){return Y.join(D.homedir(),"alma","worktrees")}`. */
export function almaWorktreesDir(home: string): string {
	return join(home, ALMA_PLAIN_DIR, "worktrees");
}

/** `~/alma/chrome-extension` — the browser extension's stable copy. */
export function almaChromeExtensionDir(home: string): string {
	return join(home, ALMA_PLAIN_DIR, "chrome-extension");
}

/** `<userData>/chat_threads.db` — the only real database in the product. */
export function almaDbPath(userData: string): string {
	return join(userData, "chat_threads.db");
}

/** `<userData>/plugin-storage/<plugin id>` — a plugin's own state directory. */
export function almaPluginStorageDir(userData: string, pluginId: string): string {
	return join(userData, "plugin-storage", pluginId);
}

/**
 * The five identity documents in `~/.config/alma/`, in the order the loader reads
 * them.
 *
 * **These are Alma's equivalent of an instruction document, and none of them is
 * one.** `AGENTS.md`, `CLAUDE.md` and `ALMA.md` occur **zero** times in
 * `out/main/index.js` — that is a literal count over the 3,104,824-character
 * bundle, not an inference — so there is no standing-instruction file to import
 * the way eleven other sources in this repository import one. What Alma has is
 * a *persona and a relationship*, in five files:
 *
 * | file | how it is used | count in the bundle |
 * | --- | --- | --- |
 * | `SOUL.md` | the agent's persona, prepended to its instructions | 13 |
 * | `USER.md` | the human's name and platform ids, parsed out of YAML frontmatter | 22 |
 * | `MEMORY.md` | the memory index beside a dated `memory/` directory | 4 |
 * | `SECURITY.md` | prepended with `SECURITY RULES (HIGHEST PRIORITY …)` | 3 |
 * | `HEARTBEAT.md` | the checklist an unattended session follows | 10 |
 *
 * The counts are occurrences of the bare filename in the bundle, so `USER.md`
 * reading 22 is three near-identical `getOwnerInfo()` implementations (Telegram,
 * Discord, Feishu) each reading it, not twenty-two documents.
 *
 * **None has a labunbun equivalent and none is imported as one.** `MEMORY.md`
 * and `memory/` become memory files; the other four are named in the report. See
 * `alma-plan.ts`.
 */
export const ALMA_IDENTITY_DOCS: readonly string[] = ["SOUL.md", "USER.md", "MEMORY.md", "SECURITY.md", "HEARTBEAT.md"];

/** One identity document's path in the configuration root. */
export function almaIdentityDocPath(configDir: string, name: string): string {
	return join(configDir, name);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * Alma's **six** skill roots, in the order its own
 * `getAllSkillRootPaths(workspace?)` returns them.
 *
 * ```js
 * constructor() {
 *   this.personalSkillsPath   = J.join(home, ".config", "alma", "skills")
 *   this.claudeCodeSkillsPath = J.join(home, ".claude", "skills")
 *   this.codexSkillsPath      = J.join(home, ".codex", "skills")
 *   this.agentSkillsPath      = J.join(home, ".agents", "skills")
 *   this.claudePluginsPath    = J.join(home, ".claude", "plugins")
 * }
 * getProjectSkillsPath(ws)         { return J.join(ws, ".alma", "skills") }
 * getProjectSkillsReadPaths(ws)    { return [J.join(ws, ".agents", "skills"), this.getProjectSkillsPath(ws)] }
 * getAllSkillRootPaths(ws) {
 *   const t = [personal, claudeCode, codex, agent, claudePlugins]
 *   if (ws) t.push(...this.getProjectSkillsReadPaths(ws))
 *   return t
 * }
 * ```
 *
 * **Five of the six are somebody else's tree**, and the split below is the whole
 * reason this importer does not simply loop over them:
 *
 *   - {@link ALMA_OWN_SKILL_ROOTS} — `~/.config/alma/skills` and
 *     `<workspace>/.alma/skills`. Alma's own. **These are imported.**
 *   - {@link ALMA_SHARED_SKILL_ROOTS} — `~/.agents/skills` and
 *     `<workspace>/.agents/skills`. The shared agent home **this repository
 *     already migrates as its `agents` source**. Reading them here as well would
 *     write two copies of every skill and attribute the second to `alma`, so
 *     they are named and not read. This is the same bug `kimi-read.ts` already
 *     hit and fixed, and the same constant that fix produced.
 *   - {@link ALMA_FOREIGN_SKILL_ROOTS} — `~/.claude/skills`, `~/.codex/skills`
 *     and `~/.claude/plugins`. Other products' homes, which Alma reads for
 *     cross-tool portability. Naming them is the honest answer: importing them
 *     would file another product's content under Alma, and not importing them
 *     without saying so would read as Alma having no skills.
 *
 * **The seventh root is not in a home at all**: `process.resourcesPath/bundled-skills`,
 * resolved by `resolveBundledSkillsDir()` with six candidate paths. It is Alma's
 * **shipped** content — see {@link ALMA_BUNDLED_SKILL_COUNT} — and a user has
 * never edited it, so it is named and never imported.
 */
export function almaOwnSkillRoots(configDir: string, workspacePath?: string | null): string[] {
	const roots = [almaSkillsDir(configDir)];
	if (workspacePath !== undefined && workspacePath !== null) roots.push(join(workspacePath, ".alma", "skills"));
	return roots;
}

/**
 * The shared agent home Alma also reads, and **this importer does not**.
 *
 * `KIMI_SHARED_TREE` in `kimi-read.ts` is the precedent and the reason: this
 * repository already owns `~/.agents` as the `agents` migration source, so a
 * second source reading it lands two copies of every file and attributes the
 * second to whichever source ran second — while the report says both were
 * imported. A test in `migrate-alma.test.ts` plans `alma` and `agents` together
 * over one shared skill and asserts exactly one write.
 */
export function almaSharedSkillRoots(home: string, workspacePath?: string | null): string[] {
	const roots = [join(home, ".agents", "skills")];
	if (workspacePath !== undefined && workspacePath !== null) roots.push(join(workspacePath, ".agents", "skills"));
	return roots;
}

/** Other products' homes Alma reads skills out of, named and never imported. */
export function almaForeignSkillRoots(home: string): string[] {
	return [join(home, ".claude", "skills"), join(home, ".codex", "skills"), join(home, ".claude", "plugins")];
}

/**
 * The order Alma resolves a skill name in, first match wins.
 *
 * Quoted from `getAllSkillRootPaths`: personal, Claude Code, Codex, the shared
 * agent home, Claude plugins, then the two project roots. **The consequence a
 * migration has to respect is that a shadowed skill is invisible.** When the
 * same folder name sits in two roots, Alma loads the higher-priority one and the
 * lower one is never read — so a reader that imported both would show the user a
 * skill they cannot change without understanding why, and one that imported only
 * the first would look correct and say nothing about the second. {@link RawAlma}
 * therefore carries a collision list and the report prints it.
 */
export const ALMA_SKILL_ROOT_PRECEDENCE: readonly string[] = [
	"~/.config/alma/skills",
	"~/.claude/skills",
	"~/.codex/skills",
	"~/.agents/skills",
	"~/.claude/plugins",
	"<workspace>/.agents/skills",
	"<workspace>/.alma/skills",
];

/**
 * How many skills Alma ships in `resources/bundled-skills/`.
 *
 * **Counted, not quoted**: forty directories, each holding exactly one
 * `SKILL.md`, in the 0.4.160 win-x64 package. They are Alma's own authored
 * content — `alchemy`, `browser`, `computer-use`, `plan-mode`, `web-fetch` and
 * thirty-five others — and they are copied into
 * `~/.config/alma/skills` on first run behind a `.bundled-skills-migrated`
 * marker (`get bundledMigrationMarkerPath()`), which is why a migrated home
 * holds both copies and the count below is not a promise about any one user's
 * `skills/` directory.
 *
 * The number is here so the report can say "40 of these are Alma's own bundled
 * skills and are not yours" rather than leaving the user to work out why a
 * migration they did not ask for did not import their browser skill.
 */
export const ALMA_BUNDLED_SKILL_COUNT = 40;

/**
 * A skill is a directory holding a `SKILL.md` whose frontmatter carries
 * **`name` and `description`**, and a file missing either is **rejected**.
 *
 * Quoted from `parseSkillMd`, which is a nested ternary that says so out loud:
 *
 * ```js
 * return e.name && typeof e.name === "string"
 *   ? e.description && typeof e.description === "string"
 *     ? { metadata: e, content: r.trim() }
 *     : (console.warn('[Skills] SKILL.md missing required "description" field'), null)
 *   : (console.warn('[Skills] SKILL.md missing required "name" field'), null)
 * ```
 *
 * The frontmatter block itself is `/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/` after
 * CRLF is normalised, so a file with no `---` fence is refused before the YAML
 * is even parsed. This importer applies the same two requirements and reports
 * each refusal by path, because a skill Alma silently ignored is a skill the
 * user believes is loaded.
 */

/**
 * The hook events Alma has, verbatim: four of them.
 *
 * Each is attested by a `trigger`/`getMatchTarget` pair in the bundle:
 * `tool.willExecute`, `tool.didExecute`, `chat.message.willSend`,
 * `app.willQuit`. **Alma has no other hook event**, which is a much smaller set
 * than any other source in this repository and is the reason its hooks are
 * cheap to reason about: three of the four have an exact twin here and one has
 * none.
 */
export const ALMA_HOOK_EVENTS: readonly string[] = [
	"tool.willExecute",
	"tool.didExecute",
	"chat.message.willSend",
	"app.willQuit",
];

/**
 * Alma's four events → this build's, and which of them are exact.
 *
 * Three are the same decision at the same moment, so mapping them is a rename
 * rather than a guess:
 *
 * | Alma | here | why it is the same |
 * | --- | --- | --- |
 * | `tool.willExecute` | `PreToolUse` | before the call, may block it |
 * | `tool.didExecute` | `PostToolUse` | after the call, sees the result |
 * | `chat.message.willSend` | `UserPromptSubmit` | before the prompt is sent |
 *
 * `app.willQuit` has **no counterpart**, and is not mapped to `SessionEnd`:
 * that fires at the end of a *conversation* and this one fires when the
 * *application* is about to quit, which is a different trigger with a different
 * amount of work still outstanding. Mapping it would run a hook at a moment the
 * user did not choose.
 */
export const ALMA_HOOK_EVENT_MAP: Readonly<Record<string, string | undefined>> = {
	"tool.willExecute": "PreToolUse",
	"tool.didExecute": "PostToolUse",
	"chat.message.willSend": "UserPromptSubmit",
	"app.willQuit": undefined,
};

/**
 * What an Alma hook's `matcher` is tested against, which decides whether it can
 * come across at all.
 *
 * ```js
 * getMatchTarget(event, input) {
 *   return event.startsWith("tool.")
 *     ? input?.tool ?? null
 *     : event === "chat.message.willSend" ? input?.content ?? null : ""
 * }
 * ```
 *
 * So a `tool.*` matcher is a regular expression over the **tool name**, and a
 * `chat.message.willSend` matcher is one over the **message content**. The
 * second has no analogue here: this build tests every matcher against
 * `payload.tool_name`, which is empty for a prompt event, so a content pattern
 * imported unchanged would be tested against the empty string and match whatever
 * matches nothing. Those matchers are dropped and counted rather than carried.
 * The default is `^$`, matched against `""` — the empty pattern, which matches
 * everything, and which is why an Alma matcher of `""` is not "match nothing".
 */
export const ALMA_HOOK_MATCHER_TARGETS: Readonly<Record<string, "tool-name" | "content" | "nothing">> = {
	"tool.willExecute": "tool-name",
	"tool.didExecute": "tool-name",
	"chat.message.willSend": "content",
	"app.willQuit": "nothing",
};

/**
 * Alma's default hook timeout, `10_000` ms, and **the unit is already this
 * build's**.
 *
 * `r.timeout ?? 1e4` — one `1e4`, milliseconds, no conversion factor anywhere.
 * Most sources in this repository name their timeout in seconds and have to be
 * multiplied by a thousand; Alma does not, and a converter written by pattern-
 * matching the other sources would turn a ten-second hook into a
 * ten-thousand-second one. The clamp still applies, because this build caps at
 * 600,000 ms and Alma does not.
 */
export const ALMA_HOOK_DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Settings are a **row**, not a file. `app_settings` has two occurrences in the
 * bundle, both the same table, and the raw DDL is quoted in `alma-read.ts`:
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS app_settings (
 *   id TEXT PRIMARY KEY DEFAULT 'default',
 *   settings_data TEXT NOT NULL,
 *   created_at TEXT NOT NULL,
 *   updated_at TEXT NOT NULL
 * )
 * ```
 *
 * `DEFAULT 'default'` is not decoration: `getSettings()` reads
 * `where(is.id, "default")` and `saveSettings()` writes to the same literal, so
 * **there is exactly one settings row per database** and any other `id` is not
 * settings this app wrote.
 */
export const ALMA_SETTINGS_HANDLE = "default";

/**
 * The keys this importer reads out of `settings_data`, and nothing else.
 *
 * **A whitelist rather than a scrub, and the choice is the whole credential
 * story for this source.** Alma's settings blob is not a settings file with a
 * few secrets in it — it is the application's entire configuration state, and
 * `chromeRelayAuthToken`, `tts.apiKey`, `network.proxy.password`,
 * `telegram.botToken` and the Discord bridge token are all ordinary members of
 * it, sitting beside `general.theme` and `chat.defaultModel` in the same JSON
 * object. Every other importer here that faces this shape either scrubs
 * credential-shaped keys on the way in or never looks.
 *
 * Reading a named list cannot leak: a key that is not in this set is never
 * copied out of the blob, so there is no path by which a new credential-shaped
 * setting a future Alma release adds reaches a planner, a plan, a report or a
 * written file. The price is that a key added to Alma and forgotten here is
 * reported as unhandled rather than migrated, and {@link RawAlma.unhandledSettings}
 * exists precisely so that cost is visible.
 *
 * The list is drawn from the `AppSettings` interface **the app itself ships**:
 * on every start-up it writes `~/.config/alma/api-spec.md`, and that document
 * carries the whole `interface AppSettings { … }` declaration. It is a better
 * source than the runtime code because it is one coherent schema rather than
 * forty call sites — but it is **not complete**, and the discrepancy is stated
 * in `alma-read.ts` rather than hidden: at least nine top-level keys the running
 * app reads are absent from the declared interface.
 */
export const ALMA_SETTINGS_KEYS_READ: readonly string[] = [
	"general",
	"chat",
	"security",
	"agents",
	"ui",
	"network",
	"data",
	"memory",
	"advanced",
	"whisper",
	"webSearch",
	"keybindings",
	"terminal",
	"themeConfig",
	"tools",
	"onboarding",
	"toolModel",
	"workspace",
];

/**
 * Alma's settings blob is a **superset** of the `AppSettings` interface the app
 * ships, and this is where the extra keys are.
 *
 * Read off `saveSettings(` and `JSON.parse(settingsData)` call sites in the
 * bundle; every one of these is written by a live code path and read by another:
 *
 * `chromeRelayAuthToken`, `telegram`, `discord`, `feishu`, `weixin`,
 * `heartbeat`, `crystal`, `threadBrief`, `mobileRelay`, `mobile`, `team`,
 * `plugin-provider-models:*` (one per plugin provider), `general.defaultWorkspaceId`,
 * and `general.windowsShell` — which the shipped interface does not list either.
 *
 * (Alma also writes `~/.config/alma/api-spec.md` itself, the document the
 * interface came out of. That is a file the product creates and the user reads,
 * not a settings key, and it is named in this module's header rather than here.)
 *
 * **This list is the credential boundary, written down.** Every name in it is
 * either a credential itself or a container that holds one, and none is read.
 * The names are here because a report should be able to say *why* a key was
 * passed over without a reader having to grep a minified bundle.
 *
 * A trailing `*` is a prefix match rather than a literal — `plugin-provider-models`
 * is one key per plugin provider and the ids are the user's plugin ids.
 */
export const ALMA_SETTINGS_NOT_READ: readonly string[] = [
	"chromeRelayAuthToken",
	"telegram",
	"discord",
	"feishu",
	"weixin",
	"heartbeat",
	"crystal",
	"threadBrief",
	"mobileRelay",
	"mobile",
	"team",
	"plugin-provider-models:*",
	"tts",
];

/**
 * Whether a key the reader passed over is one of {@link ALMA_SETTINGS_NOT_READ},
 * honouring the trailing `*` as a prefix.
 *
 * Exported because the distinction changes the sentence the report prints: a
 * known-credential key gets "it is a credential or a container of one, and
 * nothing under it was opened", and an unknown one gets "this importer has no
 * mapping for it", which is a different promise and should read differently.
 */
export function isAlmaCredentialKey(key: string): boolean {
	return ALMA_SETTINGS_NOT_READ.some((entry) =>
		entry.endsWith("*") ? key.startsWith(entry.slice(0, -1)) : entry === key,
	);
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/**
 * The link from a thread to the directory it was had in.
 *
 * Added after the fact, guarded by a bare `try`/`catch` that swallows a
 * duplicate-column error:
 *
 * ```js
 * try { this.sqlite.exec(
 *   "ALTER TABLE chat_threads ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL")
 * } catch {}
 * ```
 *
 * **`ON DELETE SET NULL` is why an orphaned thread has no path at all** rather
 * than a stale one: deleting a workspace nulls the column on every thread that
 * pointed at it, and there is no fallback. `chat_threads` carries twenty-two
 * columns and **none of them is a path** — the assertion in the bundle is
 * `workspaces(id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, …)`.
 * `alma-session.ts` says plainly that a thread has no directory rather than
 * inventing one.
 */
export const ALMA_THREAD_WORKSPACE_COLUMN = "workspace_id";

/**
 * Threads whose title starts with this are **never archived to markdown**.
 *
 * `WHERE updated_at > ? AND title NOT LIKE '⏰ Cron:%'`, quoted from both
 * `archiveUpdatedThreads` and `archiveAllThreads`, and re-checked in
 * `archiveThread` as `!n.title?.startsWith("⏰ Cron:")`.
 *
 * Three traps in the plain-file archive, all three confirmed against
 * `archiveThreadInternal` and all three named in the report:
 *
 *   1. **The archive root is ONE workspace.** `initializeThreadArchiver` reads
 *      `settings.workspace.path || getOrCreateDefaultWorkspace().path` and hands
 *      that one directory to the archiver, which joins `"threads"` onto it. Every
 *      archived `.md` therefore sits under a single workspace's path whatever
 *      project the thread was actually had in, and **the file never records which
 *      project it came from**.
 *   2. **Cron threads are absent**, by the `LIKE` above.
 *   3. **Only `text` parts survive.** `(parts || []).filter(p => p.type === "text")`
 *      — tool calls, images and reasoning are dropped, so an archive is a
 *      transcript with every action removed from it.
 *
 * The filename is `${created_at.substring(0,10)}_${title-slug.substring(0,60)}.md`,
 * where the slug has `[/\\:*?"<>|]` replaced with `_` and whitespace collapsed to
 * `_`. **Two threads from the same day with a shared first sixty characters of
 * title collide**, and the second overwrites the first.
 */
export const ALMA_CRON_TITLE_PREFIX = "⏰ Cron:";

/** The YAML frontmatter keys the archive writes, verbatim and in this order. */
export const ALMA_ARCHIVE_FRONT_KEYS: readonly string[] = [
	"threadId",
	"title",
	"createdAt",
	"updatedAt",
	"model",
	"messageCount",
];

/** Where a thread's markdown archive lives, given the archiver's one workspace. */
export function almaThreadsArchiveDir(workspacePath: string): string {
	return join(workspacePath, "threads");
}

// ---------------------------------------------------------------------------
// Credential stores
// ---------------------------------------------------------------------------

/**
 * The stores whose *names* a report may print and whose *values* this importer
 * must never read.
 *
 * Alma is the leakiest source in this repository by count, and the reasons are
 * worth separating because they are different kinds of bad:
 *
 *   - **`providers.api_key` is a plaintext column.** The raw DDL is
 *     `api_key TEXT NOT NULL` with no encryption call on the write path, and the
 *     product's own `api-spec.md` says "Provider API keys are stored encrypted" —
 *     which the DDL does not support. **The documentation and the schema
 *     disagree**, and the schema is what the bytes do. This importer's
 *     `SELECT` names its columns and never selects this one.
 *   - **`secrets.encrypted_value` is `enc:`+base64 or `plain:`+base64**, and
 *     Electron's `safeStorage` **falls back to plaintext** when unavailable, so
 *     the `enc:` prefix is not a guarantee. The table is `secrets(name PRIMARY
 *     KEY, encrypted_value, note, env DEFAULT 1, …)`.
 *   - **`mcp_oauth_tokens`** holds `access_token`, `refresh_token`,
 *     `client_secret` and `code_verifier` as plaintext columns.
 *   - **`email_accounts.password`** is a plaintext column.
 *   - **Files:** `<userData>/.claude_subscription_token`,
 *     `<userData>/.copilot_accounts/<id>.token`,
 *     `<userData>/weixin-state/credentials.json`,
 *     `<userData>/plugin-storage/<id>/secrets.json`, and
 *     `~/alma/chrome-extension/config.json`, whose whole content is
 *     `{ port, token }` — `const r = { port: e, token: this.getToken() }`.
 *
 * **Two behaviours make the app's own environment a credential surface**, and
 * both are attested:
 *
 *   - `getEnvSecrets()` returns `{ name: value }` for every secret whose `env`
 *     column is set — and it **defaults to 1**, so a user who never thought about
 *     it has every stored secret injected into **every shell command's
 *     environment**: `env: { ...ix.getEnvSecrets(), … }` on the spawn.
 *   - `redactSecretValues` replaces each value in tool output with
 *     `[REDACTED:<NAME>]`, so an exported transcript may contain those markers as
 *     literal text — **and the guard has a hole**: its condition is
 *     `r.value.length < 6 || t.includes(r.value) && (…)`, and `||` binds looser
 *     than `&&`, so **a secret shorter than six characters is never redacted**.
 *
 * The last one is a fact about the product, not a licence to go looking: the
 * function is named in a report line, never called.
 */
export const ALMA_CREDENTIAL_TABLES: readonly string[] = [
	"providers.api_key",
	"secrets.encrypted_value",
	"mcp_oauth_tokens.access_token",
	"mcp_oauth_tokens.refresh_token",
	"mcp_oauth_tokens.client_secret",
	"mcp_oauth_tokens.code_verifier",
	"email_accounts.password",
];

/** Credential files in the `userData` root, named and never opened. */
export const ALMA_CREDENTIAL_FILES: readonly string[] = [
	".claude_subscription_token",
	".copilot_accounts/<id>.token",
	"weixin-state/credentials.json",
	"plugin-storage/<id>/secrets.json",
	"<userData>/../alma/chrome-extension/config.json",
];

/**
 * A second MCP store exists and is **dormant**, which is the kind of fact that
 * produces a confident wrong report.
 *
 * `mcp_servers(id, registry_id, name, description, config JSON, enabled, status,
 * last_error, installed_at, updated_at)` is a real table with real CRUD methods
 * (`getAllMCPServers`, `getEnabledMCPServers`, `getMCPServerById`, …). **The
 * configuration routes do not write it**: the manager's `saveConfig` writes
 * `mcp.json` and nothing else touches this table.
 *
 * But the app's own `GET /api/data/export` reads it —
 * `fi.getAllMCPServers()` — so **Alma's built-in export can emit an empty
 * `mcpServers.json` on an install that has working MCP servers in `mcp.json`.**
 * This importer reads `mcp.json` and names the table rather than reading it,
 * because the file is what the product runs and the table is what nothing
 * writes. It also strips `env` from every entry it exports, which is worth
 * knowing for the same reason: the export is lossy in the credential-safe
 * direction and the table underneath it is empty.
 */
export const ALMA_DORMANT_MCP_TABLE = "mcp_servers";

/**
 * Alma ships a built-in export and import, and the user has it as an
 * alternative to this migration.
 *
 * `GET /api/data/export?include=…` produces a zip holding `providers.json`,
 * `threads.json`, `promptApps.json`, `prompts.json`, `workspaces.json`,
 * `mcpServers.json`, `customThemes.json`, `memories.json`, `settings.json` and
 * `manifest.json`; `POST /api/data/import` is the matching importer.
 *
 * **Three reasons it is not the same as this migration**, all of which the
 * report should carry:
 *
 *   1. **It omits secrets, skills, hooks and the `~/.config/alma/` identity
 *      documents.** `mcpServers` entries are written with
 *      `config: { …e.config, env: undefined }`, so an environment block is
 *      dropped rather than exported.
 *   2. **Its `mcpServers.json` may be empty** — see
 *      {@link ALMA_DORMANT_MCP_TABLE}.
 *   3. **It is Alma's own format**, not labunbun's. Moving between the two
 *      products is what this importer does; the export only moves a user out of
 *      Alma and into a zip.
 */
export const ALMA_EXPORT_FILES: readonly string[] = [
	"providers.json",
	"threads.json",
	"promptApps.json",
	"prompts.json",
	"workspaces.json",
	"mcpServers.json",
	"customThemes.json",
	"memories.json",
	"settings.json",
	"manifest.json",
];
