/**
 * Qoder's user state: where its configuration home is, every path
 * `qoder-read.ts` opens, and the two things this source names but never reads.
 *
 * **Every path claim in this module is quoted from the shipped bundle.** The
 * citations are `out/main/index.js` (the extracted Electron main bundle of
 * Qoder 0.4.3) and `@qoder-ai/qoder-agent-sdk/dist/index.js`, both under the
 * extraction this importer was written against. Line numbers are not usable —
 * the bundle is 12 MB over ~11,000 lines — so each comment carries the literal
 * it was taken from, which is searchable, rather than a line number that would
 * drift with any other build.
 *
 * **One derivation is deliberately NOT reproduced, and this is the sharpest
 * difference between the two halves of the product.** Qoder's home resolution
 * exists twice:
 *
 *   - the SDK's, in `fc`/`mc` (`…/qoder-agent-sdk/dist/index.js`, the function
 *     that joins `…,"settings.json"`): `configDirEnv` wins outright, else
 *     `join(cliHome ?? homedir(), validatedDirName)`;
 *   - the desktop's simpler `wfe` in `out/main/index.js`, which is
 *     `QODER_CONFIG_DIR?.trim()` → else `join(QODER_CLI_HOME?.trim(), ".qoder")`
 *     → else `join(homedir(), ".qoder")`. That one hard-codes `.qoder` in the
 *     CLI-home branch and never reads `QODER_CONFIG_DIR_NAME`.
 *
 * {@link qoderConfigDir} implements the **SDK** rule, and says why in its own
 * comment. The full rule the SDK implements is in `WV` in the desktop bundle,
 * where the second half is `pxt(t[\`${prefix}_CONFIG_DIR_NAME\`], …)` — the same
 * validator, called the same way.
 *
 * **Nothing here calls `os.homedir()`.** The `home` argument is the only source
 * of a home directory, which is what lets a test point this at a fixture. The
 * product's own `homedir()` appears in the quoted source, never in the code.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Directory-name validation
// ---------------------------------------------------------------------------

/**
 * The global build's configuration directory name.
 *
 * The SDK ships both descriptors as one frozen pair and picks between them at
 * module load on `const zn = xr === "cn"` where `xr = "global"`; the global
 * branch is `configDirName: ".qoder"`. The desktop carries the same two names
 * in its own table — `const $Kr = { qoder: ".qoder", "qoder-cn": ".qoder-cn" }` —
 * used for the app-status file, which is a different derivation from this one
 * and named as such.
 */
export const QODER_DEFAULT_DIR = ".qoder";

/**
 * The China build's configuration directory name.
 *
 * `configDirName: ".qoder-cn"` in the SDK's `qoder-cn` descriptor — the *same*
 * descriptor gives `projectConfigDirName: ".qoder"`, so a CN install writes its
 * user home under `.qoder-cn` and its **project** settings under `.qoder`
 * whichever build it is. Read from `qoder-home.ts`'s callers only for naming a
 * tree this importer did not read; see {@link qoderOtherConfigDir}.
 */
export const QODER_CN_DEFAULT_DIR = ".qoder-cn";

/**
 * The per-project directory name, **the same for both builds**.
 *
 * `projectConfigDirName: ".qoder"` in the SDK's global descriptor *and* in its
 * `qoder-cn` one. Both are quoted in the comment on {@link QODER_DEFAULT_DIR};
 * this is the half a reader gets wrong if it assumes the CN build renames
 * everything, because a `.qoder` project directory then holds a global install's
 * project settings and a CN install's at the same path.
 */
export const QODER_PROJECT_DIR = ".qoder";

/** Longest directory name the product accepts, in code points. */
export const QODER_DIR_NAME_MAX = 64;

/**
 * The characters a configuration directory name may be made of.
 *
 * `/^[\p{L}\p{N}\p{M}._ -]+$/u`, verbatim — the same regex appears twice in the
 * product under two minified names (`cxt` in the desktop bundle, `rc` in the
 * SDK), and both copies are byte-identical, which is why this importer can
 * reproduce the rule rather than approximate it.
 *
 * `\p{M}` (combining marks) is in there, so a decomposed name is legal; both
 * implementations normalize to NFC first, which is why
 * {@link isValidQoderDirName} normalizes before testing.
 */
export const QODER_DIR_NAME_PATTERN = /^[\p{L}\p{N}\p{M}._ -]+$/u;

/**
 * Windows reserved device names.
 *
 * `/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu`, verbatim. The `(?:\.|$)`
 * tail is what makes `con.txt` a match and `content` not one: without it
 * `console` would be rejected, and a directory named `console` is one a user
 * plausibly has.
 */
export const QODER_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/**
 * Directory names the product refuses outright.
 *
 * `.git`, `.svn`, `.hg`, `.vscode`, `.idea`, `.husky`, `.github`,
 * `node_modules`, `bower_components` — byte-for-byte the `new Set([...])` in
 * both copies. Two of them are ordinary directories a user's project root
 * contains, which is the point: a configuration home named `.git` would put
 * agent state inside a repository's own metadata.
 *
 * The lookup is a membership test, so it is exact rather than a pattern: unlike
 * {@link QODER_DEVICE_NAME_PATTERN} it does not match a name that merely starts
 * with one of these.
 */
export const QODER_RESERVED_DIR_NAMES: ReadonlySet<string> = new Set([
	".git",
	".svn",
	".hg",
	".vscode",
	".idea",
	".husky",
	".github",
	"node_modules",
	"bower_components",
]);

/**
 * Why a name is not usable, or `null` when it is.
 *
 * Returns the reason rather than a boolean because the report needs it: a name
 * the importer refused and a name that was accepted have to be distinguishable
 * to a user reading why their `QODER_CONFIG_DIR_NAME` did not take effect. The
 * two spellings the product uses are kept apart — the desktop says
 * `"<ENV> is not a valid configuration directory name."` and the SDK says
 * `"<ENV> must be a valid directory name"` / `"… must not use a protected
 * directory name"` — because they are genuinely different code paths and a
 * message that mixed them would name a check the failing one does not have.
 */
export type QoderDirNameRejection =
	| "empty"
	| "too-long"
	| "leading-or-trailing-space"
	| "trailing-dot"
	| "characters"
	| "device-name"
	| "reserved-name";

/**
 * Normalize and validate a configuration directory name, or say why not.
 *
 * **Reproduces the product's checks in its own order**, which is what makes the
 * result agree with it rather than merely resemble it:
 *
 *   1. `normalize("NFC")` — the SDK does `t.normalize("NFC")`, the desktop
 *      `t.normalize("NFC")`; both before every test below.
 *   2. length by **code point**: `Array.from(t).length`, so a name of 64 astral
 *      characters passes where 64 UTF-16 units would be 128 code points.
 *   3. no leading and no trailing space; no trailing `.`; not `.` and not `..`.
 *   4. {@link QODER_DIR_NAME_PATTERN}.
 *   5. {@link QODER_DEVICE_NAME_PATTERN}.
 *   6. {@link QODER_RESERVED_DIR_NAMES}, lowercased.
 *
 * The lowercasing in step 6 is `toLowerCase()` here. The desktop uses
 * `toLocaleLowerCase("en-US")`; the SDK uses `toLowerCase()`. The set is ASCII,
 * so the two agree on every name this can reject, and reproducing the desktop's
 * would make the answer depend on the machine's default locale.
 *
 * **Why this is a migration concern and not trivia.** The name becomes a path
 * segment under the user's home, and steps 3–6 are what stop a name from
 * escaping it or landing somewhere a tool reads as something else. An importer
 * that resolved `QODER_CONFIG_DIR_NAME` without these checks would read
 * `~/.git/…` on a machine configured that way — a directory the product itself
 * refuses to use.
 */
export function validateQoderDirName(name: string): QoderDirNameRejection | null {
	if (name === "") return "empty";
	const normalized = name.normalize("NFC");
	if (Array.from(normalized).length > QODER_DIR_NAME_MAX) return "too-long";
	if (normalized.startsWith(" ") || normalized.endsWith(" ")) return "leading-or-trailing-space";
	if (normalized.endsWith(".") || normalized === "." || normalized === "..") return "trailing-dot";
	if (!QODER_DIR_NAME_PATTERN.test(normalized)) return "characters";
	if (QODER_DEVICE_NAME_PATTERN.test(normalized)) return "device-name";
	if (QODER_RESERVED_DIR_NAMES.has(normalized.toLowerCase())) return "reserved-name";
	return null;
}

/** Whether {@link validateQoderDirName} accepts this name. */
export function isValidQoderDirName(name: string): boolean {
	return validateQoderDirName(name) === null;
}

/** The sentence the report prints for each rejection, in the product's own terms. */
export const QODER_DIR_NAME_REJECTIONS: Record<QoderDirNameRejection, string> = {
	empty: "it is empty",
	"too-long": `it is longer than ${QODER_DIR_NAME_MAX} characters`,
	"leading-or-trailing-space": "it starts or ends with a space",
	"trailing-dot": "it ends with a dot, or is `.` or `..`",
	characters: "it has a character outside letters, numbers, combining marks, `.`, `_`, space and `-`",
	"device-name": "it is a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)",
	"reserved-name": `it is one of ${[...QODER_RESERVED_DIR_NAMES].join(", ")}`,
};

// ---------------------------------------------------------------------------
// The configuration home
// ---------------------------------------------------------------------------

/** The environment block the resolution reads; injectable so tests need no `process.env`. */
export type QoderEnv = Record<string, string | undefined>;

/**
 * The configuration home: `$QODER_CONFIG_DIR` when it names one, else
 * `<cli home or home>/<validated directory name>`.
 *
 * This is the SDK's rule (`fc` plus `mc`), which is also the desktop's fuller
 * one (`WV`, where the second half is a call to the same validator). The
 * precedence is not a preference:
 *
 *   - **`QODER_CONFIG_DIR` wins outright and is used verbatim** — the SDK does
 *     `B.resolve(cwd, env[configDirEnv])` and never consults the other two.
 *   - **`QODER_CLI_HOME` is a *parent*, not a home.** The SDK computes
 *     `r = o ? B.resolve(cwd, o) : homedir()` and then `B.join(r, s.user)` —
 *     the directory name is appended to whatever `QODER_CLI_HOME` names. A
 *     reader that treated it as the home itself would look one level too high.
 *   - **A blank value is unset.** The SDK tests `env[x] === undefined || === ""`
 *     and the desktop `?.trim()` then truthiness; a whitespace-only value is
 *     therefore *not* unset to the desktop but *is* a path of `" "` to the SDK's
 *     `B.resolve`. This function trims first, which is the desktop's reading and
 *     the one a user setting the variable by accident gets.
 *
 * **`QODER_CONFIG_DIR_NAME` is validated, and an invalid value does not fall
 * back.** Both implementations `throw` rather than substituting the default, so
 * a user who set it to something Qoder refuses is running a Qoder that refuses
 * to start. This function must not silently read `~/.qoder` in that case — that
 * would import a tree the product itself rejected. It falls back to
 * {@link QODER_DEFAULT_DIR} and reports the rejection through
 * {@link QoderHomes.rejectedDirName}, so the report says the override was
 * refused rather than the migration quietly reading the wrong directory.
 *
 * `QODER_CONFIG_DIR` itself is **not** validated: neither implementation runs it
 * through the name check, because it is a whole path rather than a segment. It
 * is used as written, after `resolve()` against the working directory exactly as
 * the SDK does (`B.resolve(e, env[v.configDirEnv])`).
 *
 * **`GEMINI_CLI_HOME` is deliberately not honoured, and the two bundles disagree.**
 * The SDK's settings loader reads `env[v.cliHomeEnv] ?? env.GEMINI_CLI_HOME`
 * before falling back to `homedir()`, which is a Qoder-is-a-Gemini-CLI-fork
 * artifact. The other copy of the same derivation in the SDK
 * (`qa() { return process.env[Oa] || Ia() }`) does not read it, and
 * **`GEMINI_CLI_HOME` occurs zero times in the desktop bundle**. So a user who has
 * that variable set for the Gemini CLI would have the *SDK* resolve a different
 * home from the *desktop*, and this importer follows the desktop — the product
 * whose data is actually being imported, and the one whose settings file layout
 * the report describes.
 */
export function qoderConfigDir(home: string, env: QoderEnv = process.env): string {
	const override = env.QODER_CONFIG_DIR?.trim();
	if (override !== undefined && override !== "") return override;
	const parent = env.QODER_CLI_HOME?.trim();
	const name = qoderDirName(env);
	return join(parent !== undefined && parent !== "" ? parent : home, name);
}

/**
 * The directory name to put under the CLI home, from `QODER_CONFIG_DIR_NAME`
 * when it validates, else the build's own default.
 *
 * Returns the **default** rather than throwing when the value is invalid; see
 * {@link qoderConfigDir} for why, and {@link QoderHomes.rejectedDirName} for
 * where the refusal is reported.
 */
export function qoderDirName(env: QoderEnv = process.env): string {
	const configured = env.QODER_CONFIG_DIR_NAME;
	if (configured === undefined || configured === "") return QODER_DEFAULT_DIR;
	return isValidQoderDirName(configured) ? configured.normalize("NFC") : QODER_DEFAULT_DIR;
}

/** Why `QODER_CONFIG_DIR_NAME` was refused, or `null` when it was not set or was fine. */
export function qoderDirNameRejection(env: QoderEnv = process.env): QoderDirNameRejection | null {
	const configured = env.QODER_CONFIG_DIR_NAME;
	if (configured === undefined || configured === "") return null;
	return validateQoderDirName(configured);
}

/**
 * The configuration home this importer will not read: the other build's.
 *
 * Qoder resolves **one** home per process — `mc()` returns a single
 * `{ user, project }` pair, chosen at module load — so a home holding both
 * `.qoder` and `.qoder-cn` is two *installs*, not two halves of one. Reading
 * both would import two builds' settings into one file and two builds'
 * conversations into one history. So the tree that did not answer is **named**
 * instead, which is the same treatment `t3-home.ts` gives a dev build's
 * `userdata` sibling.
 */
export function qoderOtherConfigDir(home: string, read: string): string {
	return join(home, read.endsWith(QODER_CN_DEFAULT_DIR) ? QODER_DEFAULT_DIR : QODER_CN_DEFAULT_DIR);
}

/** Whether a directory exists and holds something, as `sourceHasContent` reads it. */
export function qoderTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Paths under the home
// ---------------------------------------------------------------------------

/** `<home>/settings.json` — the user layer of the one settings document both builds read. */
export function qoderSettingsPath(configDir: string): string {
	return join(configDir, "settings.json");
}

// ---------------------------------------------------------------------------
// The three settings layers
// ---------------------------------------------------------------------------

/**
 * The layers Qoder loads settings from, in the order it applies them.
 *
 * `oc = ["user","project","local"]` is the **default** `settingSources`, so a
 * Qoder that read only `~/.qoder/settings.json` would be reading a third of what
 * the product reads. The three files, from `fc`:
 *
 * ```js
 * user:    join(configDir,                        "settings.json")
 * project: join(resolve(cwd, v.projectConfigDir),  "settings.json")
 * local:   join(resolve(cwd, v.projectConfigDir),  "settings.local.json")
 * ```
 *
 * and both project-layer files live under `v.projectConfigDir`, which is `".qoder"`
 * for **both** builds (`{configDirName: ".qoder", projectConfigDirName: ".qoder"}`
 * — the per-user and per-project directories are spelled the same way, one under
 * the home and one under the working directory).
 */
export const QODER_SETTINGS_SOURCES = ["user", "project", "local"] as const;

/** Which of the three files a settings key came from. */
export type QoderSettingsSource = (typeof QODER_SETTINGS_SOURCES)[number];

/**
 * The directory name Qoder uses **inside a working directory**.
 *
 * `mc()` returns one `{user, project}` pair, and the two halves are not
 * independent: with `QODER_CONFIG_DIR_NAME` unset they are `v.configDirName` and
 * `v.projectConfigDirName` (both `".qoder"` for both builds), and with it set
 * **both become the configured name** — `return {user: t, project: t}`. So a user
 * who renamed the tree has also renamed the per-project one, and a reader that
 * looked for `<cwd>/.qoder/` would find nothing where their project settings are.
 *
 * That is why this is {@link qoderDirName} and not the constant.
 */
export function qoderProjectDirName(env: QoderEnv = process.env): string {
	return qoderDirName(env);
}

/** `<cwd>/<project dir name>/settings.json` — the project layer. */
export function qoderProjectSettingsPath(cwd: string, env: QoderEnv = process.env): string {
	return join(cwd, qoderProjectDirName(env), "settings.json");
}

/** `<cwd>/<project dir name>/settings.local.json` — the local layer, never committed. */
export function qoderLocalSettingsPath(cwd: string, env: QoderEnv = process.env): string {
	return join(cwd, qoderProjectDirName(env), "settings.local.json");
}

/**
 * `<cwd>/.qoder/.mcp.json` — the project's own MCP file, **named and never read**.
 *
 * `sourcePath: join(projectRoot, ".qoder", ".mcp.json")` beside `scopeKind:"project"`
 * and a `scopeId` of `sha256(projectRoot)`, in the desktop's settings-location
 * table. It is a separate location from `settings.json`: the three-layer merge
 * above never reaches it, and its sibling inside a *plugin* directory
 * (`{path:".mcp.json",type:"file"}` in the plugin manifest's own file list) is a
 * third place with the same basename and nothing to do with either.
 *
 * **The `.qoder` here is a literal and takes no `env`,** which is not an
 * oversight in this function: the desktop writes it as a literal while the SDK's
 * project settings directory follows `QODER_CONFIG_DIR_NAME` (see
 * {@link qoderProjectDirName}). A user who renamed the tree therefore has their
 * project `settings.json` under the new name and their project `.mcp.json` under
 * `.qoder` — two different places, and this function is the one that is right for
 * the second.
 *
 * Why it is not read: a project directory is not something this importer may pick
 * for itself, and `runMigration` is given exactly one — so it could read this one.
 * The reason it does not is narrower and is the honest one: **nothing in either
 * bundle says how this file combines with `settings.json`.** The desktop
 * enumerates locations and canonicalises them (`canonicalProjectLocations`) but the
 * merge that would combine two `mcpServers` maps from two scopes is not something
 * these bytes answer. Importing both and calling it a merge would be a guess with
 * a report attached to it. It is named instead, so a user who knows they have one
 * is told it stayed.
 */
export function qoderProjectMcpPath(cwd: string): string {
	return join(cwd, QODER_PROJECT_DIR, ".mcp.json");
}

/**
 * Top-level keys that are merged **one level deep** rather than all the way,
 * verbatim from `uc` in the SDK.
 *
 * ```js
 * uc = new Set(["mcpServers","providers","skillOverrides","enabledPlugins",
 *               "extraKnownMarketplaces","pluginConfigs"])
 * // and the merge itself:
 * //   if (a === "shallow" && i && o) { const u = {};
 * //     isRecord(i) && Object.assign(u, clone(i));
 * //     isRecord(o) && Object.assign(u, clone(o));
 * //     target[key] = u; continue; }
 * ```
 *
 * **So it is a merge, not a replacement, and the difference is worth being exact
 * about** — an earlier draft of this file called these keys "replaced wholesale",
 * which the bytes do not support. For `mcpServers` the consequence is:
 *
 *   - The **names** union. A project layer declaring `theirs` leaves a user's
 *     `mine` in place, and both run.
 *   - The **entries** do not. A server declared in both layers is taken whole
 *     from the later one — `Object.assign` over the top-level map, not a walk
 *     into each server — so a project that redefines `mine` changes its command,
 *     args, cwd and environment wholesale and cannot inherit the user's.
 *
 * That second half is why reading the user layer alone would still be wrong: a
 * server the user believes they configured, and which the project has replaced
 * with a different command and a different environment, is one import.
 */
export const QODER_MERGE_SHALLOW: readonly string[] = [
	"mcpServers",
	"providers",
	"skillOverrides",
	"enabledPlugins",
	"extraKnownMarketplaces",
	"pluginConfigs",
];

/**
 * Dotted paths whose arrays are **unioned** rather than replaced, verbatim from
 * `cc`.
 *
 * ```js
 * cc = new Set(["context.fileFiltering.customIgnoreFilePaths","tools.exclude",
 *   "mcp.enabledProjectMcpServers","mcp.disabledProjectMcpServers",
 *   "security.approvedExternalImportProjects","advanced.excludedEnvVars",
 *   "extensions.disabled","extensions.workspacesWithMigrationNudge",
 *   "plugins.enabled","plugins.disabled","skills.disabled",
 *   "blockedMarketplaces","allowedHttpHookUrls"])
 * ```
 *
 * Thirteen of them. The union is by `Set` identity — `[...new Set([...i, ...o])]` —
 * so two structurally equal objects at the same position are **two** entries, and
 * deduping them would be this importer inventing a policy Qoder does not have.
 */
export const QODER_MERGE_UNION: readonly string[] = [
	"context.fileFiltering.customIgnoreFilePaths",
	"tools.exclude",
	"mcp.enabledProjectMcpServers",
	"mcp.disabledProjectMcpServers",
	"security.approvedExternalImportProjects",
	"advanced.excludedEnvVars",
	"extensions.disabled",
	"extensions.workspacesWithMigrationNudge",
	"plugins.enabled",
	"plugins.disabled",
	"skills.disabled",
	"blockedMarketplaces",
	"allowedHttpHookUrls",
];

/**
 * Key names the merge drops wherever they appear, verbatim from `Cn`.
 *
 * `new Set(["__proto__","constructor","prototype"])`. Not a precaution this
 * importer adds: `Rn` skips them at every level and `Et` will not copy them, so a
 * settings file carrying `__proto__` at any depth has it ignored by the product
 * too. A reader that copied them through would be the only thing in the pipeline
 * that took the value.
 */
export const QODER_PROTOTYPE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** `<home>/projects` — one directory per working directory that has been used. */
export function qoderProjectsDir(configDir: string): string {
	return join(configDir, "projects");
}

/** `<home>/projects/<slug>` — one project's sessions and memory. */
export function qoderProjectDir(configDir: string, cwd: string): string {
	return join(qoderProjectsDir(configDir), qoderProjectSlug(cwd));
}

/**
 * One session's transcript: `<home>/projects/<slug>/<sessionId>.jsonl`.
 *
 * `join(t.configDirectory, "projects", Bfe(t.cwd), \`${t.targetSessionId}.jsonl\`)`
 * — the whole function, verbatim, one call to the one non-`u` slug. So the
 * **shape** is settled: a project directory per working directory, one `.jsonl`
 * per session inside it.
 *
 * What is *not* settled is what is in the file. The writer is the native
 * `qoder-runtime-host` binary, which is not in the JavaScript bundle and not in
 * the SDK, so no record format could be read from bytes. See
 * `qoder-session.ts`, which counts these files and reads none of them.
 */
export function qoderSessionPath(configDir: string, cwd: string, sessionId: string): string {
	return join(qoderProjectDir(configDir, cwd), `${sessionId}.jsonl`);
}

/** `<home>/memory` — the machine-wide memory directory. */
export function qoderMemoryDir(configDir: string): string {
	return join(configDir, "memory");
}

/**
 * `<home>/projects/<slug>/memory` — the per-project memory directory.
 *
 * `join(t, "projects", Bfe(cwd), "memory")`, verbatim in shape. The slug comes
 * from {@link qoderProjectSlug} rather than a slug of its own so that the two
 * directories cannot disagree about which project they are for.
 */
export function qoderProjectMemoryDir(configDir: string, cwd: string): string {
	return join(qoderProjectDir(configDir, cwd), "memory");
}

/**
 * The pattern a memory **entry** file matches, verbatim: `/^\d{4}-\d{2}-\d{2}\.md$/u`.
 *
 * This is the discriminator the product itself uses to tell an entry from an
 * index. The reader keeps only the files whose name matches it, sorts them by
 * name **descending**, and reads each one's date as `name.slice(0, -3)` — so a
 * memory file is named for the day it was written, and the most recent days come
 * first.
 *
 * It matters for a migration in a way that is easy to get backwards: a reader
 * that took *every* `.md` file would sweep up `MEMORY.md` itself, which is the
 * index rather than an entry.
 */
export const QODER_MEMORY_ENTRY_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/u;

/**
 * The name of the index that sits beside the dated entries, verbatim.
 *
 * `const Pfe = "MEMORY.md"` beside the memory helpers, and the name test
 * compares against it with `.toLowerCase()` on both sides — so the check is
 * case-insensitive and this constant is the exact spelling.
 *
 * **The index lives *inside* the memory directory, not beside it.** This is the
 * one place the QoderWork migration's layout and Qoder's own layout look alike
 * and are not the same, so it is worth being exact about. The QoderWork source
 * reader splits a `MEMORY.md` at the root of *its* source directory on `§` and
 * reads dated entries from a `memory/` **subdirectory** beside it. Qoder's own
 * tree is the destination that reader writes into — `<configDir>/memory/` — and it
 * holds both the dated entries and the index, with the writer rebuilding the
 * index from the entries it wrote.
 */
export const QODER_MEMORY_INDEX_NAME = "MEMORY.md";

/** The memory documents to read from the machine-wide directory, in this order. */
export function qoderMemoryIndexPaths(configDir: string): string[] {
	return [join(qoderMemoryDir(configDir), QODER_MEMORY_INDEX_NAME)];
}

/**
 * Qoder's own hook event names, verbatim from the SDK.
 *
 * Eighteen of them, in the order the SDK declares. This is the list that makes
 * hook migration decidable rather than a guess in either direction: **seven of
 * the eighteen are events this build also runs**, so those import; the other
 * eleven are events only Qoder has, and each one is a hook that would silently
 * never fire here. Naming them is what turns that from a silent loss into a
 * report line — `normalizeClaudeHooks` already collects an unknown event into
 * `droppedEvents`, and this list is what that collection is checked against.
 *
 * Note what is **not** in it: `Notification`, which this build runs and Qoder
 * does not have. The intersection is not the whole story in either direction, and
 * a source whose events were assumed to be a subset of this build's would be
 * wrong in exactly that way.
 */
export const QODER_HOOK_EVENTS: readonly string[] = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"UserPromptSubmit",
	"SessionStart",
	"SessionEnd",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"PostCompact",
	"CwdChanged",
	"InstructionsLoaded",
	"FileChanged",
	"PermissionRequest",
	"PermissionDenied",
	"WorktreeCreate",
	"WorktreeRemove",
];

/** Longest a project directory name may be before the hash suffix is added. */
export const QODER_PROJECT_SLUG_MAX = 200;

/**
 * `djb2` with XOR, exactly as the product spells it.
 *
 * `e = 5381; for each character: e = e * 33 ^ charCodeAt(i)` — in that order,
 * with `^` and `*` at the same precedence so it is `(e * 33) ^ code`. Returned
 * **signed**, and the callers wrap it in `Math.abs`, so a name that overflows
 * into the negative half hashes to `Math.abs` of a negative number rather than
 * being treated as unsigned. Reproducing the sign is the point: a reimplementation
 * that used `>>> 0` would produce a different suffix for the same name and read a
 * directory the product never wrote.
 */
function qoderSlugHash(value: string): number {
	let hash = 5381;
	for (let i = 0; i < value.length; i += 1) hash = (hash * 33) ^ value.charCodeAt(i);
	return hash;
}

/**
 * The directory name the product gives a working directory.
 *
 * ```js
 * function Bfe(t) {
 *   const e = t.replace(/[^a-zA-Z0-9]/g, "-");
 *   return e.length <= 200 ? e : `${e.slice(0, 200)}-${Math.abs(qdr(t)).toString(36)}`;
 * }
 * ```
 *
 * **The regex has no `u` flag, and that is deliberate here.** The bundle carries
 * two copies of this function and the difference is load-bearing rather than a
 * typo: `Bfe` above, with `/g`, is the one both the transcript path (`vze`) and
 * the per-project memory directory (`join(t,"projects",Bfe(e),"memory")`) use,
 * while a second copy with `/gu` is used only by the session-bundle exporter.
 * With no `u` flag a character outside the basic plane matches **per UTF-16 code
 * unit**, so an emoji in a path becomes two dashes rather than one; with `u` it
 * becomes one. The two spellings therefore name different directories for the
 * same `cwd`, and the product uses both.
 *
 * This function is the one the transcripts and the project memory directory are
 * actually under, so it is reproduced without the flag. A working directory
 * containing an astral character is the only case where the two differ, and
 * getting it wrong would mean reporting "no sessions" for a project that has
 * them.
 *
 * The comparison is `e.length <= 200` on the **already-replaced** string, in
 * UTF-16 units, so the cap is on units and the hash covers the *original* path.
 */
export function qoderProjectSlug(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	return slug.length <= QODER_PROJECT_SLUG_MAX
		? slug
		: `${slug.slice(0, QODER_PROJECT_SLUG_MAX)}-${Math.abs(qoderSlugHash(cwd)).toString(36)}`;
}

/**
 * The same transformation with the `u` flag, which the product uses for one
 * caller only.
 *
 * Exported because the difference is the kind that gets "fixed" by someone
 * reading {@link qoderProjectSlug} and assuming the flag was forgotten: for a
 * `cwd` containing a character outside the basic plane this returns a **different
 * directory name**, and both are names the product uses. See that function's
 * comment for which caller uses which.
 */
export function qoderProjectSlugUnicode(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]/gu, "-");
	return slug.length <= QODER_PROJECT_SLUG_MAX
		? slug
		: `${slug.slice(0, QODER_PROJECT_SLUG_MAX)}-${Math.abs(qoderSlugHash(cwd)).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * The two directories Qoder reads user skills from, its own first.
 *
 * ```js
 * new fZt({
 *   "user-managed":   join(t, "skills"),
 *   "user-agents":   e.userAgentSkillsPath ?? join(homedir(), ".agents", "skills"),
 * })
 * ```
 *
 * `t` is the configuration home and the second is the **shared** agent home this
 * repository already migrates as its `agents` source. The source labels in that
 * constructor are the same two strings `sortSkills` and the inventory rows compare
 * against, so a folder carrying the source `"user-managed"` is one this build
 * reads first.
 *
 * **A skill is a directory holding a `SKILL.md`, which is exactly the shape
 * `readSkillDirs` already produces.** The product's own walker treats a directory
 * as a skill *only* when `join(dir, "SKILL.md")` is a file and otherwise recurses
 * into its subdirectories, to a depth of 8 and a budget of 4096 skills; and the
 * reader that resolves one builds its path as
 * `join(qoderConfigPath, "skills", folderName, "SKILL.md")`. So a skill travels as
 * a skill rather than as a rewrite, and the frontmatter (`name`, `description`,
 * and `descriptionZh`) is the metadata the product reads back.
 *
 * One consequence is worth stating because it is the reason for de-duplicating in
 * `qoder-read.ts`: the same folder name in both roots is *one* skill to Qoder and
 * two files to a naive reader, and importing both would write one over the other
 * while both report lines said they were imported.
 */
export function qoderSkillsDirs(configDir: string, home: string): string[] {
	return [join(configDir, "skills"), join(home, ".agents", "skills")];
}

// ---------------------------------------------------------------------------
// Paths this source names and does not read
// ---------------------------------------------------------------------------

/**
 * The desktop application's data directory name, from the packaged manifest.
 *
 * `resources/product.json` is real and says `"productId": "qoder"`,
 * `"dataDirectoryName": "com.qoder.app.stable"`, `"channel": "stable"`. That
 * value is what the app joins onto the platform's app-data path before opening
 * `main.sqlite`, and it is why {@link qoderDesktopStorePath} takes the name as an
 * argument rather than hard-coding a path: a different channel of the same
 * product ships a different name, and the manifest is where that is settled.
 *
 * The CN build is **not** a second literal here. The bundle carries the pair
 * `{qoder: ".qoder", "qoder-cn": ".qoder-cn"}` but only for the app-status file,
 * which is a different derivation from this one, and no second data-directory name
 * is readable from the shipped package — the product catalogue it would come from
 * is not shipped. So a CN install's store is not named by this importer rather
 * than named wrongly.
 */
export const QODER_DESKTOP_DATA_DIR = "com.qoder.app.stable";

/**
 * The desktop application's SQLite store, **existence-checked only**.
 *
 * **Nothing in this importer opens it.** Not this module, not `qoder-read.ts`,
 * not any plan, and not any test. The reason is stated where the decision is
 * taken (`qoder-session.ts` and `qoder-plan.ts`), and it is not "it is hard": the
 * store is a live database the desktop app writes to while the user works — it is
 * opened with `PRAGMA journal_mode = WAL` — and two of its tables hold
 * credentials.
 *
 * **`existsSync` is the whole of what is asked of it, and the *name* is what a
 * report may print.** A path is not user content, but a report is something a user
 * may paste into an issue, so nothing past this function's return value reaches
 * one.
 *
 * One caveat is worth stating because it would otherwise make this a false
 * negative: **the store can also land in a temporary directory.** The app-data
 * resolution has a `catch` that falls back to `join(tmpdir(), \`${name}-startup-\`)`
 * when the requested path cannot be created. So "the store was not there" means
 * "not at the app-data path", not "there is none".
 */
export function qoderDesktopStorePath(appData: string, dataDirectoryName: string = QODER_DESKTOP_DATA_DIR): string {
	return join(appData, dataDirectoryName, "main.sqlite");
}

/**
 * Tables inside that store whose *names* are worth a report line and whose
 * *values* this importer must never read.
 *
 * Four of them are credential-shaped by name: `byok_model_credentials`,
 * `mcp_oauth_credentials`, `app_settings`, `account_profiles`. A migration report
 * is something a user may paste into an issue, so the sentence that names these
 * quotes the table names and nothing else.
 */
export const QODER_CREDENTIAL_TABLES: readonly string[] = [
	"byok_model_credentials",
	"mcp_oauth_credentials",
	"app_settings",
	"account_profiles",
];

/**
 * Tables that hold derived state rather than the user's conversations.
 *
 * `chat_session_search_segments` and its FTS shadow are a search index over the
 * message rows, and the turn-payload buffer is a worker queue. All three are
 * named here so a report can say they were passed over; none is opened.
 */
export const QODER_DERIVED_TABLES: readonly string[] = [
	"chat_session_search_segments",
	"chat_session_search_fts",
	"chat-session-turn-payload-buffer.sqlite",
];
