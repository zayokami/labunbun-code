// TRAE's user state: `~/.trae`, `~/.trae-cn`, the VS Code profile directory, and every path
// `trae-read.ts` looks at.
// Long-form design notes: docs/dev/migration-sources.md

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The project-scoped directory name, and the global one. */
export const TRAE_PROJECT_DIR_BASENAME = ".trae";
export const TRAE_GLOBAL_DIR_BASENAME = ".trae";

// Long-form design notes: docs/dev/migration-sources.md
/** The China build's directory: `~/.trae-cn`, a real product split. */
export const TRAE_CN_GLOBAL_DIR_BASENAME = ".trae-cn";

/** Global rules: `~/.trae/user_rules`, a **directory** — see {@link traeGlobalRulesDir}. */
export const TRAE_USER_RULES_DIRNAME = "user_rules";

/** Project rules: `<project>/.trae/rules`, a directory of arbitrary `*.md` names. */
export const TRAE_RULES_DIRNAME = "rules";

// Long-form design notes: docs/dev/migration-sources.md
/** The rules depth limit, 3, from the vendor rules page. */
export const TRAE_RULES_MAX_DEPTH = 3;

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.trae[-cn]/user_rules`, a directory, and the only documented form. */
export function traeGlobalRulesDir(home: string, edition: "intl" | "cn"): string {
	return join(home, edition === "cn" ? TRAE_CN_GLOBAL_DIR_BASENAME : TRAE_GLOBAL_DIR_BASENAME, TRAE_USER_RULES_DIRNAME);
}

// Long-form design notes: docs/dev/migration-sources.md
/** Which build this home belongs to, decided by which directory is there. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Product directory names TRAE is known to install under. */
export const TRAE_PRODUCT_DIRS: readonly string[] = ["Trae", "Trae CN", "TRAE SOLO", "TRAE SOLO CN"];

/** Which rule put the profile directory where it is, for the report to say. */
export type TraeUserDataOrigin =
	| "appdata"
	| "xdg-config-home"
	| "macos-application-support"
	| "appdata-unset"
	| "default";

// Long-form design notes: docs/dev/migration-sources.md
/** The VS Code profile directory TRAE inherits, with the rule that placed it. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The first installed product directory, or `null`. */
export function traeUserDataRoot(home: string): { root: string; product: string; origin: TraeUserDataOrigin } | null {
	const { base, origin } = traeProfileBase(home);
	for (const product of TRAE_PRODUCT_DIRS) {
		const root = join(base, product, "User");
		if (existsSync(root)) return { root, product, origin };
	}
	return null;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<profile>/User/mcp.json`, the global MCP document. */
export function traeGlobalMcpFile(userData: string): string {
	return join(userData, "mcp.json");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<project>/.trae/mcp.json`, vendor-documented. */
export function traeProjectMcpFile(cwd: string): string {
	return join(traeProjectRoot(cwd), "mcp.json");
}

// ---------------------------------------------------------------------------
// The four documented trees this importer names but does not carry
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Trae-owned trees and files its documentation names, reported without a read. */
export const TRAE_OWNED_ASSETS: readonly {
	// Long-form design notes: docs/dev/migration-sources.md
	/** The path segment under the global or project root, and a reason-table key. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** One row of {@link TRAE_OWNED_ASSETS} turned into a path. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The commands depth limit, documented separately from the rules one. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.trae[-cn]/memory/user_profile.md`, the global memory file. */
export function traeGlobalMemoryFile(home: string, edition: "intl" | "cn"): string {
	return join(traeGlobalOwned(home, edition, "memory"), "user_profile.md");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.trae[-cn]/memory/projects`, the per-project memory tree. */
export function traeProjectMemoryDir(home: string, edition: "intl" | "cn"): string {
	return join(traeGlobalOwned(home, edition, "memory"), "projects");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<project>/.trae/skill-config.json`, the disabled-skill list. */
export const TRAE_SKILL_CONFIG_FILENAME = "skill-config.json";

/** The `~/.trae[-cn]/<name>` join, so every global-owned path agrees on the edition. */
function traeGlobalOwned(home: string, edition: "intl" | "cn", name: string): string {
	return join(home, edition === "cn" ? TRAE_CN_GLOBAL_DIR_BASENAME : TRAE_GLOBAL_DIR_BASENAME, name);
}

/** `<profile>/workspaceStorage` — one directory per opened workspace. */
export function traeWorkspaceStorageDir(userData: string): string {
	return join(userData, "workspaceStorage");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<profile>/workspaceStorage/<id>/state.vscdb`, named only. */
export function traeStateDatabase(userData: string, workspace: string): string {
	return join(traeWorkspaceStorageDir(userData), workspace, "state.vscdb");
}

/** `<profile>/globalStorage/state.vscdb`, named only. */
export function traeGlobalStateDatabase(userData: string): string {
	return join(userData, "globalStorage", "state.vscdb");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<project>/.agents/skills`, the cross-tool skills directory, named never read. */
export function traeCrossToolSkillsDir(cwd: string): string {
	return join(cwd, ".agents", "skills");
}

// Long-form design notes: docs/dev/migration-sources.md
/** The trees whose non-empty state means "TRAE is here". */
export function traeDetectionRoots(home: string): string[] {
	const roots = [join(home, TRAE_GLOBAL_DIR_BASENAME), join(home, TRAE_CN_GLOBAL_DIR_BASENAME)];
	const userData = traeUserDataRoot(home);
	if (userData) roots.push(dirname(userData.root));
	return roots;
}
