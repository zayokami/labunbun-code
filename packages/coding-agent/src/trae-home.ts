/**
 * Where TRAE keeps everything this importer looks at.
 *
 * **The citations here are documentation-level, not source-level**, for the same
 * reason as `cursor-home.ts`: TRAE ships no public tree, so a claim here is a
 * dated second-hand reading. What makes TRAE worth the trouble is that three of
 * its paths are stated in its own documentation and one — the global MCP file —
 * is not, which is the single most consequential fact in this module and is
 * marked as such below.
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
 *     because it is the *tidy* answer: TRAE's own rules, skills and memory all
 *     live under `~/.trae/`, so a global MCP file there looks obvious. It has no
 *     documentation and no implementation behind it, and the application resolves
 *     MCP from its VS Code *profile* directory instead — a distinction that is
 *     invisible until you know it, and silent when you get it wrong.
 *
 * So the global MCP file is read at `<user data>/User/mcp.json`. That path is
 * **community-verified and vendor-undocumented**: several independent tools
 * hardcode it, two of them after shipping a fix for having hardcoded something
 * else, and one verified it against a running editor by decompiling the bundle
 * and confirming the old path is never opened. Only macOS was verified against a
 * live install, so the Windows and Linux spellings are inference by analogy —
 * which is why {@link traeUserDataRoot} takes its platform from the environment
 * and says which rule it used.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The project-scoped directory name, and the global one. */
export const TRAE_PROJECT_DIR_BASENAME = ".trae";
export const TRAE_GLOBAL_DIR_BASENAME = ".trae";

/**
 * The China build's directory. A real product split rather than a locale
 * setting: the two documentation sites print different directories for the same
 * product, and the rules page gives `~/.trae-cn/user_rules` for it.
 */
export const TRAE_CN_GLOBAL_DIR_BASENAME = ".trae-cn";

/** Global rules: `~/.trae/user_rules`, a **directory** — see {@link traeGlobalRulesDir}. */
export const TRAE_USER_RULES_DIRNAME = "user_rules";

/** Project rules: `<project>/.trae/rules`, a directory of arbitrary `*.md` names. */
export const TRAE_RULES_DIRNAME = "rules";

/**
 * How deep TRAE looks for rules, and why 3 rather than "all of it".
 *
 * TRAE's own documentation draws a tree and marks the fourth level "exceeds
 * limit (unreadable)", so this is the tool's number and not a reader's choice.
 * A file below it is one TRAE never loaded; it is named rather than imported, and
 * the report says which level it was at, so the limit is visible rather than a
 * reader deciding on the user's behalf what counts as too deep.
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
 * a codebase: the international build, the China build, and the two SOLO builds,
 * one of which has since been renamed. A reader that guessed one would find
 * nothing on a machine running another, and would report TRAE as absent on a
 * machine that has it.
 *
 * Where these names come from, since a VS Code fork has no convention of its own
 * to appeal to: it inherits VS Code's, and VS Code's derivation is
 * `join(appDataPath, productService.nameShort)` — so the directory name **is**
 * `nameShort`, and TRAE ships four different ones. The derivation is a stock line
 * of VS Code (`src/vs/platform/environment/node/userDataPath.ts`, reached from
 * `environmentService.ts`), which is why this module can lean on the fact rather
 * than on each product separately. A trap the same evidence exposes: the macOS
 * bundle is `TraeCode.app` and the Windows executable is `TraeCode.exe` while the
 * user-data directory stays `Trae` and the install directory stays
 * `Programs\Trae\`. The name a user sees in Finder or Task Manager is not the
 * name of the directory, and reading by the visible name finds nothing.
 *
 * **Unread from the shipped builds, not from this source tree:** the two
 * `product.json` files were pulled out of the published artifacts, so `nameShort`
 * is measured at the versions quoted rather than read from code. The two builds do
 * not share a directory on any of the five discriminators, which is why
 * {@link traeUserDataRoot} probes rather than branches on edition.
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
 */
export function traeGlobalMcpFile(userData: string): string {
	return join(userData, "mcp.json");
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
 */
export function traeProjectSkillsDir(cwd: string): string {
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
 */
export function traeDetectionRoots(home: string): string[] {
	const roots = [join(home, TRAE_GLOBAL_DIR_BASENAME), join(home, TRAE_CN_GLOBAL_DIR_BASENAME)];
	const userData = traeUserDataRoot(home);
	if (userData) roots.push(dirname(userData.root));
	return roots;
}
