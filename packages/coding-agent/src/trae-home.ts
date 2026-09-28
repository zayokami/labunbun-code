/**
 * Where TRAE keeps everything this importer looks at.
 *
 * **The citations here are documentation-level, not source-level**, for the same
 * reason as `cursor-home.ts`: TRAE ships no public tree, so a claim here is a
 * dated second-hand reading. That distinction is load-bearing and is stated on
 * every claim below rather than blurred: each path says which of the three kinds
 * of evidence it rests on — **vendor documentation** (`docs.trae.ai` /
 * `docs.trae.cn`, read 2026-09-29), **third-party tooling**, or **inference from
 * VS Code's inheritance** — and a `file:line` citation is not available for any
 * of them and is not invented.
 *
 * A full re-check against the documentation on 2026-09-29 moved the balance a
 * long way from what the first draft of this header said. Nearly every path this
 * module touches is now **vendor-documented**, and the two that are not are named
 * as such where they are used. The header that said "three of its paths are
 * stated in its own documentation and one is not" was written before the pages
 * for skills, commands, hooks and memories had been read, and it is corrected
 * above rather than left to be believed.
 *
 * Two paths that circulate widely are wrong, and both were believed while this
 * importer was being planned:
 *
 *   - **`~/.cursor/mcp.json` is not TRAE's.** The claim traces to one
 *     AI-generated news page about a v1.3.0 release that does not appear in
 *     TRAE's own changelog at all, and the word "Cursor" appears nowhere in that
 *     changelog. The research note that repeats it is wrong on two further counts
 *     in the same paragraph. Nothing reads that file.
 *   - **`~/.trae/mcp.json` is not it either**, which is the harder one to refute
 *     because it is the *tidy* answer: TRAE's own rules, skills, commands, memory
 *     and hooks all live under `~/.trae/`, so a global MCP file there looks
 *     obvious. It has no documentation and no implementation behind it, and the
 *     application resolves MCP from its VS Code *profile* directory instead — a
 *     distinction that is invisible until you know it, and silent when you get it
 *     wrong. (Checked 2026-09-29: `docs.trae.ai/ide/add-mcp-servers` names
 *     `<project>/.trae/mcp.json` explicitly and describes the global one only as
 *     "the `mcp.json` file in TraeCode", reached through a **Raw Config (JSON)**
 *     button. So the project half became vendor-documented and the global half
 *     stayed undocumented.)
 *
 * So the global MCP file is read at `<user data>/User/mcp.json`. That path is
 * **community-verified and vendor-undocumented**: several independent tools
 * hardcode it, two of them after shipping a fix for having hardcoded something
 * else, and one verified it against a running editor by decompiling the bundle
 * and confirming the old path is never opened. Only macOS was verified against a
 * live install, so the Windows and Linux spellings are inference by analogy —
 * which is why {@link traeUserDataRoot} takes its platform from the environment
 * and says which rule it used.
 *
 * **What the vendor does *not* document, and this module does not invent:** the
 * workspace-id hash inside `workspaceStorage` (two incompatible formats are in
 * circulation and neither is reproducible), and the storage of custom agents
 * (`docs.trae.ai/ide/agent`, read 2026-09-29, describes creating, sharing and
 * importing agents at length and never gives a path — they live in editor state).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The project-scoped directory name, and the global one. */
export const TRAE_PROJECT_DIR_BASENAME = ".trae";
export const TRAE_GLOBAL_DIR_BASENAME = ".trae";

/**
 * The China build's directory. A real product split rather than a locale
 * setting: the two documentation sites print different directories for the same
 * product.
 *
 * **Vendor documentation, and only on the Chinese site.**
 * `docs.trae.cn/ide/rules` (read 2026-09-29) gives global rules as
 * `~/.trae-cn/user_rules` on macOS/Linux and `%userprofile%/.trae-cn/user_rules`
 * on Windows. `docs.trae.ai/ide/rules` (same date) gives the *same sentence*
 * with `~/.trae` / `%userprofile%/.trae` — it documents the international build
 * and never mentions the China one. The string `trae-cn` appears **zero times**
 * in every page fetched from the English site during this re-check
 * (rules, skills, commands, hooks, hook reference, MCP, memories, agent,
 * changelog), including its Chinese-language variant served under `?_lang=zh`,
 * which is itself a useful fact: the two sites are not two translations of one
 * document but two documents for two products, and the `-cn` suffix is the
 * vendor's own way of keeping the two installs from sharing a home directory.
 *
 * So the "the English page gets `~/.trae-cn` wrong" shape was looked for and is
 * **not there** — each site is right about its own product. What *is* worth
 * knowing is the mirror image: a reader who trusts the English site alone will
 * never find a China install, and that is why {@link traeEdition} decides by
 * which directory exists rather than by a locale.
 */
export const TRAE_CN_GLOBAL_DIR_BASENAME = ".trae-cn";

/** Global rules: `~/.trae/user_rules`, a **directory** — see {@link traeGlobalRulesDir}. */
export const TRAE_USER_RULES_DIRNAME = "user_rules";

/** Project rules: `<project>/.trae/rules`, a directory of arbitrary `*.md` names. */
export const TRAE_RULES_DIRNAME = "rules";

/**
 * How deep TRAE looks for rules, and why 3 rather than "all of it".
 *
 * **Vendor documentation**, `docs.trae.ai/ide/rules` and `docs.trae.cn/ide/rules`
 * (both read 2026-09-29), stated twice on each page: the prose says the rules
 * directories "are read recursively. Currently, up to three levels of nesting
 * are supported", and the example tree marks level 3 "Deepest readable level"
 * and level 4 "Exceeds limit (unreadable)". So this is the tool's number and not
 * a reader's choice. A file below it is one TRAE never loaded; it is named rather
 * than imported, and the report says which level it was at, so the limit is
 * visible rather than a reader deciding on the user's behalf what counts as too
 * deep.
 *
 * The identical limit is documented *separately* for commands
 * ({@link TRAE_COMMANDS_MAX_DEPTH}). It is a second constant rather than a shared
 * one because it is a second sentence on a different page: the two directories
 * are unrelated, and a future release could move one without the other.
 */
export const TRAE_RULES_MAX_DEPTH = 3;

/**
 * `~/.trae/user_rules` — a **directory**, and the only documented form.
 *
 * The name appears in the rules page only ever as this path: never as
 * `user_rules.md`, and never under `~/.trae/rules/`. One third-party tool
 * returns `<dir>/user_rules.md` from a function that claims to find it, and puts
 * it under the OS-specific `Trae/User` directory rather than `~/.trae/`; that is
 * a genuine unresolved disagreement between sources, and the documented form is
 * what this module reads. A file named `user_rules.md` under the global root is
 * named in the report as the thing the other reading would have found.
 *
 * **Vendor documentation, re-checked 2026-09-29 and the verdict is unchanged.**
 * The English page heads the section "Rule directories" and gives the path bare;
 * the Chinese page calls the same path 「本地根目录」 — "the local root
 * directory" — in both the macOS/Linux and the Windows bullet. Neither page ever
 * writes a file extension, and neither mentions a `user_rules.md`. The reading
 * this module rejects therefore still has no vendor page behind it.
 */
export function traeGlobalRulesDir(home: string, edition: "intl" | "cn"): string {
	return join(home, edition === "cn" ? TRAE_CN_GLOBAL_DIR_BASENAME : TRAE_GLOBAL_DIR_BASENAME, TRAE_USER_RULES_DIRNAME);
}

/**
 * Which build this home belongs to, decided by which directory is there.
 *
 * One function because three call sites need the answer and three copies of the
 * rule is three chances for them to disagree — the reader, the detection roots
 * and the label all have to name the same edition, or the report says it read
 * `~/.trae` on a machine whose rules live in `~/.trae-cn`.
 *
 * The China build is preferred when its home exists, because the two are separate
 * products: a machine with both directories is one where the China build was
 * installed and the international one later removed, and reading the latter would
 * read a tree nothing writes to any more.
 */
export function traeEdition(home: string): "intl" | "cn" {
	return existsSync(join(home, TRAE_CN_GLOBAL_DIR_BASENAME)) ? "cn" : "intl";
}

/** `<project>/.trae` — the project half, relative to the directory a run is in. */
export function traeProjectRoot(cwd: string): string {
	return join(cwd, TRAE_PROJECT_DIR_BASENAME);
}

/** `<project>/.trae/rules` — any `*.md` name, up to three levels deep. */
export function traeProjectRulesDir(cwd: string): string {
	return join(traeProjectRoot(cwd), TRAE_RULES_DIRNAME);
}

// ---------------------------------------------------------------------------
// The editor's profile directory
// ---------------------------------------------------------------------------

/**
 * The product directory names TRAE is known to install under.
 *
 * More than one, and that is not hedging — these are separate products that share
 * a codebase: the international build, the China build, and the two SOLO builds.
 * A reader that guessed one would find nothing on a machine running another, and
 * would report TRAE as absent on a machine that has it.
 *
 * **This is the weakest claim in the module and is labelled as such.** It rests
 * on two things of very different strength, and the difference matters more now
 * that the rest of the module is on vendor documentation:
 *
 *   1. **The derivation, which is solid.** A VS Code fork inherits VS Code's, and
 *      VS Code's is `join(appDataPath, productService.nameShort)` — so the
 *      directory name *is* `nameShort`, and TRAE ships a different one per
 *      product. The derivation is a stock line of VS Code
 *      (`src/vs/platform/environment/node/userDataPath.ts`, reached from
 *      `environmentService.ts`). It tells you the *rule*; it does not tell you
 *      any of the four strings.
 *   2. **The four strings, which are not vendor-documented.** Re-checked
 *      2026-09-29: TRAE's own pages name the profile directory exactly once, in
 *      the troubleshooting article — `%USERPROFILE%\AppData\Roaming\Trae\ModularData\ai-agent\snapshot`
 *      on Windows and `~/Library/Application Support/Trae/ModularData/ai-agent/snapshot`
 *      on macOS (`docs.trae.ai/ide/troubleshoot-general-issues`). That is a
 *      **vendor** page and it confirms `Trae` for the international build on two
 *      platforms, which is what the first entry below rests on. The other three
 *      are **third-party**: the configuration reference at `agentsview.io` lists
 *      `Trae`, `Trae CN` and `TRAE SOLO CN` under each of `%APPDATA%`,
 *      `~/Library/Application Support` and `~/.config`. The bare `TRAE SOLO` is
 *      the weakest of the four — it is in neither the vendor page nor that
 *      third-party list, and it survives on the earlier `product.json` reading
 *      alone.
 *
 * A trap the same evidence exposes: the macOS bundle is `TraeCode.app` and the
 * Windows executable is `TraeCode.exe` while the user-data directory stays `Trae`
 * and the install directory stays `Programs\Trae\`. The name a user sees in
 * Finder or Task Manager is not the name of the directory, and reading by the
 * visible name finds nothing.
 *
 * The two builds do not share a directory on any of the five discriminators,
 * which is why {@link traeUserDataRoot} probes rather than branches on edition.
 */
export const TRAE_PRODUCT_DIRS: readonly string[] = ["Trae", "Trae CN", "TRAE SOLO", "TRAE SOLO CN"];

/** Which rule put the profile directory where it is, for the report to say. */
export type TraeUserDataOrigin =
	| "appdata"
	| "xdg-config-home"
	| "macos-application-support"
	| "appdata-unset"
	| "default";

/**
 * The VS Code profile directory TRAE inherits: `%APPDATA%\Trae\User` on Windows.
 *
 * Not under `~/.trae/` on any platform, which is the point of the module header.
 * `%APPDATA%` is honoured when set and non-empty; otherwise the profile lands
 * under `<home>/AppData/Roaming` rather than resolving to a path relative to the
 * process's working directory, which is what `join("", "Trae", "User")` produces
 * and what a reader must never then go and create.
 */
function traeProfileBase(home: string): { base: string; origin: TraeUserDataOrigin } {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA?.trim();
		if (appData) return { base: appData, origin: "appdata" };
		return { base: join(home, "AppData", "Roaming"), origin: "appdata-unset" };
	}
	if (process.platform === "darwin") {
		return { base: join(home, "Library", "Application Support"), origin: "macos-application-support" };
	}
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (xdg) return { base: xdg, origin: "xdg-config-home" };
	return { base: join(home, ".config"), origin: "default" };
}

/**
 * The first of {@link TRAE_PRODUCT_DIRS} that is actually installed, or `null`.
 *
 * Probing rather than guessing is the whole point: the four names are four
 * products, a user runs exactly one of them, and the difference between "TRAE is
 * installed" and "TRAE is not" is a question with two wrong answers if it is
 * answered by picking a name. The edition that answered is carried in the result
 * so the report can name it, and so the rules directory is read from the
 * matching home — `~/.trae` and `~/.trae-cn` are not interchangeable.
 */
export function traeUserDataRoot(home: string): { root: string; product: string; origin: TraeUserDataOrigin } | null {
	const { base, origin } = traeProfileBase(home);
	for (const product of TRAE_PRODUCT_DIRS) {
		const root = join(base, product, "User");
		if (existsSync(root)) return { root, product, origin };
	}
	return null;
}

/**
 * `<profile>/User/mcp.json` — the global MCP document.
 *
 * The one path in this module with **no vendor citation**, and named as such in
 * the header. The evidence is three independent tools that hardcode exactly this
 * path, two of them after shipping corrections for having hardcoded a different
 * one, plus a bundle-level check that the widely-repeated alternatives are never
 * opened by the application. It is read, and the report says where it was read
 * from, because a file a user cannot find is a file they will assume was skipped.
 *
 * Re-checked 2026-09-29 and the verdict is unchanged, which is worth stating
 * because it is the one place a reader would most want the vendor to have
 * published something: `docs.trae.ai/ide/add-mcp-servers` names the *project*
 * document as `<project>/.trae/mcp.json` and then, for the global one, says only
 * that you can paste raw JSON into "the `mcp.json` file in TraeCode" through a
 * **Raw Config (JSON)** button. No path, no directory, on either documentation
 * site.
 */
export function traeGlobalMcpFile(userData: string): string {
	return join(userData, "mcp.json");
}

/**
 * `<project>/.trae/mcp.json` — the project's MCP document.
 *
 * **Vendor documentation**, `docs.trae.ai/ide/add-mcp-servers` (read
 * 2026-09-29): "You can create an `mcp.json` file in the `.trae/` directory
 * under the project root and declare one or more MCP servers' configurations in
 * it." It also names the switch that turns the half on — Settings > MCP, enable
 * project-level MCP, then confirm in a popup — which is why the report's sentence
 * for a project document says the servers are named rather than merged: the
 * feature is off until the user turns it on, and this importer must not look like
 * the reason it did nothing.
 */
export function traeProjectMcpFile(cwd: string): string {
	return join(traeProjectRoot(cwd), "mcp.json");
}

// ---------------------------------------------------------------------------
// The four documented trees this importer names but does not carry
// ---------------------------------------------------------------------------

/**
 * Trae-owned trees and files that its documentation names, and that this
 * importer finds and reports without reading.
 *
 * **This section is the result of a full re-check on 2026-09-29 and it did not
 * exist before it.** The first draft of this module was written from the rules
 * page alone and quietly assumed the rest of `~/.trae/` was empty of anything
 * importable; in fact four more features are documented with paths, and a user
 * with any of them was getting a report that said nothing at all about them.
 * They are named here rather than imported, and the reason they are not imported
 * is a boundary rather than a verdict: carrying a skill, a command, a hook or a
 * memory needs this repo's asset planner and its writer, and neither is in this
 * module. What this module can do without touching either is make the gap
 * visible, which is what {@link traeCarriedByNoOne} is for.
 *
 * Every entry below is **vendor-documented** on `docs.trae.ai` unless the entry
 * says otherwise. Each carries the changelog version that introduced it, because
 * "TRAE has this" is a claim with a date attached and a reader three years from
 * now needs to know which release made it true. The reader probes each one and
 * puts it in `notImported` with its own sentence; see `readTrae` in
 * `trae-read.ts` for the sentences and `TRAE_OWNED_ASSET_REASONS` there for the
 * text they are built from.
 */
export const TRAE_OWNED_ASSETS: readonly {
	/**
	 * The path segment under `~/.trae[-cn]/` or `<project>/.trae/`, and the key
	 * into `TRAE_OWNED_ASSET_REASONS` in `trae-read.ts`.
	 *
	 * A union rather than `string` so the two tables cannot drift: adding a row
	 * here without a sentence for it is a type error rather than a report line
	 * that renders as `undefined`.
	 */
	readonly name: "skills" | "commands" | "hooks.json";
	readonly scope: "project" | "global";
	/** Whether it is a directory of things or a single document. */
	readonly shape: "directory" | "file";
	/** What the vendor calls it, for the report. */
	readonly what: string;
	/** The release that introduced it, from the vendor changelog. */
	readonly since: string;
	/** The page that documents it, relative to `docs.trae.ai`. */
	readonly doc: string;
}[] = [
	{
		name: "skills",
		scope: "project",
		shape: "directory",
		what: "skills",
		since: "v3.5.24/25 (2026-01-23)",
		doc: "/ide/skills",
	},
	{
		name: "skills",
		scope: "global",
		shape: "directory",
		what: "global skills",
		since: "v3.5.24/25 (2026-01-23)",
		doc: "/ide/skills",
	},
	{
		name: "commands",
		scope: "project",
		shape: "directory",
		what: "slash commands",
		since: "v3.5.56 (2026-04-28)",
		doc: "/ide/slash-commands",
	},
	{
		name: "commands",
		scope: "global",
		shape: "directory",
		what: "global slash commands",
		since: "v3.5.54 (2026-04-15)",
		doc: "/ide/slash-commands",
	},
	{
		name: "hooks.json",
		scope: "project",
		shape: "file",
		what: "hooks",
		since: "v3.5.66 (2026-06-10)",
		doc: "/ide/automate-actions-with-hooks",
	},
	{
		name: "hooks.json",
		scope: "global",
		shape: "file",
		what: "global hooks",
		since: "v3.5.66 (2026-06-10)",
		doc: "/ide/hook-configuration-reference",
	},
];

/**
 * One row of {@link TRAE_OWNED_ASSETS} turned into a path.
 *
 * The rule is arithmetic — the documented basename under the documented root for
 * that scope — and it holds for every row, which is the reason the table is
 * restricted to rows it holds for. Memories and `skill-config.json` are named by
 * the reader instead: the first is a file one level under its directory, the
 * second is a file rather than a tree, and folding either into this table would
 * mean the table no longer means what its doc comment says.
 */
export function traeOwnedPath(
	asset: (typeof TRAE_OWNED_ASSETS)[number],
	home: string,
	edition: "intl" | "cn",
	cwd: string,
): string {
	return asset.scope === "project"
		? join(traeProjectRoot(cwd), asset.name)
		: traeGlobalOwned(home, edition, asset.name);
}

/**
 * How deep TRAE looks for commands.
 *
 * **Vendor documentation**, `docs.trae.ai/ide/slash-commands` (read 2026-09-29):
 * "Project command: The `.trae/commands` directory under the project path.
 * Support up to three levels of nested directories", and the example tree marks
 * level 3 "Deepest readable level" and level 4 "Exceeds limit (unreadable)" —
 * the same sentence and the same tree shape the rules page gives for
 * {@link TRAE_RULES_MAX_DEPTH}. A second constant rather than a shared one
 * because it is a second sentence on a second page; nothing ties the two limits
 * together except that they currently agree.
 */
export const TRAE_COMMANDS_MAX_DEPTH = 3;

/** `<project>/.trae/skills` — TRAE's own skills, distinct from the `.agents` one. */
export function traeProjectSkillsDir(cwd: string): string {
	return join(traeProjectRoot(cwd), "skills");
}

/** `~/.trae/skills` — the global half of the same feature. */
export function traeGlobalSkillsDir(home: string, edition: "intl" | "cn"): string {
	return traeGlobalOwned(home, edition, "skills");
}

/** `<project>/.trae/commands` — TRAE's own slash commands. */
export function traeProjectCommandsDir(cwd: string): string {
	return join(traeProjectRoot(cwd), "commands");
}

/** `~/.trae/commands` — the global half of the same feature. */
export function traeGlobalCommandsDir(home: string, edition: "intl" | "cn"): string {
	return traeGlobalOwned(home, edition, "commands");
}

/** `<project>/.trae/hooks.json` — **vendor-documented**, see {@link TRAE_OWNED_ASSETS}. */
export function traeProjectHooksFile(cwd: string): string {
	return join(traeProjectRoot(cwd), "hooks.json");
}

/** `~/.trae/hooks.json` — the global half of the same feature. */
export function traeGlobalHooksFile(home: string, edition: "intl" | "cn"): string {
	return traeGlobalOwned(home, edition, "hooks.json");
}

/**
 * `~/.trae/memory/user_profile.md` — the global memory file.
 *
 * **Vendor documentation**, `docs.trae.ai/ide/memories` (read 2026-09-29), which
 * gives the storage location in a table: global memory is
 * `~/.trae/memory/user_profile.md` on macOS and Linux and
 * `%userprofile%/.trae/memory/user_profile.md` on Windows. It also says the
 * feature is off until the Memory switch is turned on under
 * Settings > Rules & Memories > Memory, which is why this is a *user profile*
 * file and not a project one.
 */
export function traeGlobalMemoryFile(home: string, edition: "intl" | "cn"): string {
	return join(traeGlobalOwned(home, edition, "memory"), "user_profile.md");
}

/**
 * `~/.trae/memory/projects/` — where the per-project memory files live.
 *
 * **Vendor documentation with one hole in it.** The memories page gives project
 * memory as `~/.trae/memory/projects/{project_path}/project_memory.md` and never
 * says what `{project_path}` is spelled like — an absolute path, a slug, a hash
 * — and the importer has no way to reconstruct it, so the *directory* is named
 * and the file inside it is not guessed at. A report that printed a fabricated
 * path would be worse than one that prints the tree and says why.
 */
export function traeProjectMemoryDir(home: string, edition: "intl" | "cn"): string {
	return join(traeGlobalOwned(home, edition, "memory"), "projects");
}

/**
 * `<project>/.trae/skill-config.json` — the list of disabled project skills.
 *
 * **Vendor documentation**, `docs.trae.ai/ide/skills` (read 2026-09-29): "After
 * disabling skills, TraeCode will create a `skill-config.json` file in the
 * project's `.trae/` directory. This file lists the disabled project skills.
 * Disabled global skills will not appear in this file." The second sentence is
 * the reason the file is worth naming at all: it is the only record of which
 * skills the user deliberately turned off, and it lives nowhere else.
 */
export const TRAE_SKILL_CONFIG_FILENAME = "skill-config.json";

/** The `~/.trae[-cn]/<name>` join, so every global-owned path agrees on the edition. */
function traeGlobalOwned(home: string, edition: "intl" | "cn", name: string): string {
	return join(home, edition === "cn" ? TRAE_CN_GLOBAL_DIR_BASENAME : TRAE_GLOBAL_DIR_BASENAME, name);
}

/** `<profile>/workspaceStorage` — one directory per opened workspace. */
export function traeWorkspaceStorageDir(userData: string): string {
	return join(userData, "workspaceStorage");
}

/**
 * `<profile>/workspaceStorage/<id>/state.vscdb`, named only.
 *
 * The `<id>` is deliberately not parsed. A VS Code fork carries **two** id
 * formats — older workspaces are a 32-character hex digest and newer ones are a
 * numeric timestamp — and both are observed in the same directory on one
 * machine. A reader that pattern-matched one shape would silently skip half of a
 * real install, so every entry in the directory is checked and named.
 *
 * The directory name is a hash that also cannot be recomputed reliably (it mixes
 * in the folder's creation time, and older versions hashed differently), so the
 * report must not imply the id is addressable. A sibling `workspace.json` holds
 * the real path; reading it is not attempted here, because nothing in this
 * importer needs a chat and a chat is the one thing in that database this
 * importer cannot carry.
 *
 * The re-check on 2026-09-29 found **no vendor page naming this file at all**,
 * which is worth recording as a fact about the evidence rather than a gap in it:
 * `docs.trae.ai/ide/agent` describes creating, sharing, importing and deleting
 * custom agents in detail and never says where they are kept, and the
 * troubleshooting page, which is the one place TRAE names anything inside its own
 * profile, points at `ModularData/ai-agent/snapshot` instead. So the "custom
 * agents are in editor state" reading is the best available one, and it is an
 * inference — the alternative, guessing a path, would be worse.
 */
export function traeStateDatabase(userData: string, workspace: string): string {
	return join(traeWorkspaceStorageDir(userData), workspace, "state.vscdb");
}

/** `<profile>/globalStorage/state.vscdb`, named only. */
export function traeGlobalStateDatabase(userData: string): string {
	return join(userData, "globalStorage", "state.vscdb");
}

/**
 * `<project>/.agents/skills` — the cross-tool skills directory TRAE reads.
 *
 * Named, never read. This build's own `agents` source reads `~/.agents/skills`,
 * which is a different directory in a different tree, and the reason this is named
 * rather than imported is the one that applies to every such case: two sources
 * reading one file is how the same skill lands twice under two owners.
 *
 * **Vendor documentation**, `docs.trae.ai/ide/skills` (read 2026-09-29), which
 * describes it as "a convention-based directory specified by Agent Skills" and
 * puts it behind a switch: you add the directory to the project *and* toggle
 * **Enable the `.agents/skills/` directory** on under Settings > Skills &
 * Commands. The changelog dates the feature to v3.5.44 (2026-04-02). The
 * toggle matters for the report sentence, which is corrected to say so — an
 * importer that told a user TRAE reads this directory unconditionally would be
 * describing a state the user's own settings may not have reached.
 *
 * The name is `traeCrossToolSkillsDir` rather than the `traeProjectSkillsDir` it
 * used to be called because {@link traeProjectSkillsDir} now means TRAE's *own*
 * skills directory, and two different "skills directories" in one module under
 * names that differ by four letters is a trap for whoever reads it next.
 */
export function traeCrossToolSkillsDir(cwd: string): string {
	return join(cwd, ".agents", "skills");
}

/**
 * The trees whose being non-empty means "TRAE is here".
 *
 * Three spellings for the same question, and all three are returned rather than
 * the one that answered. The two global homes are the CLI-and-rules half, and
 * only one of them can exist per install — the China build and the international
 * build are separate products. The profile directory is the IDE half, and it is
 * the one that catches the user who has opened TRAE and never written a rule.
 *
 * The profile entry is the *product* directory rather than the `User` directory
 * inside it, which is one level up for a reason worth stating: `User` is created
 * on first launch and can be empty or near-empty on an install that has been
 * opened once, and a root that reads as empty is a root detection skips.
 *
 * The global root is worth more than it was when this was written: since
 * v3.5.21 (2026-01-13) it holds memories, since v3.5.24/25 (2026-01-23) global
 * skills, since v3.5.54 (2026-04-15) global commands and since v3.5.66
 * (2026-06-10) `hooks.json`. A user whose only TRAE trace is a global skill has
 * a non-empty root, and this detection is what stops that machine reporting no
 * TRAE install at all.
 */
export function traeDetectionRoots(home: string): string[] {
	const roots = [join(home, TRAE_GLOBAL_DIR_BASENAME), join(home, TRAE_CN_GLOBAL_DIR_BASENAME)];
	const userData = traeUserDataRoot(home);
	if (userData) roots.push(dirname(userData.root));
	return roots;
}
