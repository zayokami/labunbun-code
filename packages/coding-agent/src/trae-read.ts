/**
 * TRAE's user state: the two rules directories, the two MCP documents, and the
 * editor's storage as a set of names.
 *
 * Read `trae-home.ts` first — every path claim comes from there, and the standing
 * caveat for this source is that they are documentation-level rather than
 * source-level. Two of the plan's premises were wrong and both corrections are
 * load-bearing below: TRAE's global rules are a **directory** (`~/.trae/user_rules`),
 * and TRAE's global MCP file is **not** under `~/.trae/`.
 *
 * What is here, and one thing that deliberately is not:
 *
 *  - **Project rules** — `<project>/.trae/rules`, arbitrary `*.md` names, up to
 *    three levels deep. The rules carry Cursor's frontmatter (`alwaysApply`,
 *    `description`, `globs`) in a plain `.md`; TRAE's documentation asserts the
 *    compatibility itself. Carried over verbatim, like the `.mdc` case.
 *  - **Global rules** — `~/.trae/user_rules/`.
 *  - **Subdirectory rules** — TRAE reads a `.trae/rules` in *any* subdirectory and
 *    applies it to that subtree. Those are **named, not imported**, and the reason
 *    is the same one that loses Cursor's `globs`: this build's rules directory is
 *    flat, so a rule that means "in this subtree only" would arrive meaning
 *    "everywhere", which is the opposite of what the file says.
 *  - **`AGENTS.md` / `CLAUDE.md` / `CLAUDE.local.md` at the project root** — TRAE
 *    reads all three since v3.5.18, and `AGENTS.md` is the cross-tool convention.
 *    None of them is imported, because **this build already reads the project's
 *    `AGENTS.md` where it stands**; importing a second copy would put the same
 *    instructions in the context twice under two owners. The two settings toggles
 *    TRAE requires are named too, because a copy that never activates is a silent
 *    failure in TRAE even after a faithful copy.
 *
 * **What the 2026-09-29 re-check added to that list, and it is most of it.** This
 * module was written from the rules page and the MCP page alone, and a home whose
 * only TRAE content was a skill, a command, a hook or a memory produced a report
 * that said nothing about any of it — the global names fell into the anonymous
 * "N entries this importer reads nothing out of" line and the project ones were
 * never looked for at all. Seven more paths are now named with their own
 * sentences; see {@link TRAE_OWNED_ASSET_REASONS} and the table behind it in
 * `trae-home.ts`. None of them is **imported**, and that is a boundary rather
 * than a verdict: each one has a home in this repo's asset planner, and reaching
 * it is a change to the shared planner and the source registry rather than to this
 * reader. Naming them is what this module can do alone, and it is the difference
 * between a report that is silent and one that is honest.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isRecord, readText } from "./migrate-core.ts";
import {
	TRAE_OWNED_ASSETS,
	TRAE_RULES_MAX_DEPTH,
	TRAE_SKILL_CONFIG_FILENAME,
	traeCrossToolSkillsDir,
	traeEdition,
	traeGlobalMcpFile,
	traeGlobalMemoryFile,
	traeGlobalRulesDir,
	traeGlobalStateDatabase,
	traeOwnedPath,
	traeProjectMcpFile,
	traeProjectMemoryDir,
	traeProjectRoot,
	traeProjectRulesDir,
	traeUserDataRoot,
	traeWorkspaceStorageDir,
} from "./trae-home.ts";

/** One rule file, and the thing about it the report cannot leave out. */
export interface TraeRule {
	name: string;
	sourcePath: string;
	content: string;
	scope: "project" | "user";
}

/** Something this importer found and will not import, with the reason. */
export interface TraeNotImported {
	path: string;
	reason: string;
}

/** A configuration document in the three states it can be in. */
export type TraeDocument =
	| { kind: "absent" }
	| { kind: "unreadable" }
	| { kind: "document"; value: Record<string, unknown> };

function readTraeDocument(path: string): TraeDocument {
	if (!existsSync(path)) return { kind: "absent" };
	const text = readText(path);
	if (text === null) return { kind: "unreadable" };
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? { kind: "document", value: parsed } : { kind: "unreadable" };
	} catch {
		return { kind: "unreadable" };
	}
}

/**
 * `*.md` under one rules directory, and whatever is too deep for TRAE to have read.
 *
 * The depth cap is TRAE's own number and is applied to the *global* directory too,
 * which is a choice rather than a citation: the three-level limit is documented
 * for project rules and no separate limit is documented for `user_rules`, so this
 * applies the one number TRAE published rather than inventing an uncapped scan. A
 * file past it is named, so the cap is a line in the report instead of a silent
 * truncation.
 */
function readTraeRuleDir(dir: string, scope: TraeRule["scope"]): { rules: TraeRule[]; tooDeep: TraeNotImported[] } {
	const rules: TraeRule[] = [];
	const tooDeep: TraeNotImported[] = [];
	const walk = (current: string, depth: number): void => {
		// `Dirent[]` rather than `ReturnType<typeof readdirSync>`: that resolves to
		// the `Buffer` overload and the names come out typed as buffers.
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (depth + 1 > TRAE_RULES_MAX_DEPTH) {
					tooDeep.push({
						path,
						reason: `below TRAE's own ${TRAE_RULES_MAX_DEPTH}-level limit for rules, so TRAE never read it either`,
					});
					continue;
				}
				walk(path, depth + 1);
				continue;
			}
			if (!entry.name.endsWith(".md")) continue;
			const content = readText(path);
			if (content === null) {
				tooDeep.push({ path, reason: "unreadable" });
				continue;
			}
			rules.push({ name: entry.name.slice(0, -".md".length), sourcePath: path, content, scope });
		}
	};
	walk(dir, 0);
	return { rules, tooDeep };
}

/**
 * `.trae/rules` directories anywhere below the project, named rather than read.
 *
 * A bounded walk, because the alternative is not reading a project at all: the
 * subdirectory feature is real and a user with one has rules this importer would
 * otherwise never mention. The bound is the honest part — the walk stops at
 * {@link TRAE_RULES_MAX_DEPTH} levels and at the three directories no project
 * walk should enter, and the report says how far it went. A monorepo whose
 * packages each carry rules gets a line naming them, not forty rule files
 * flattened into one global directory.
 */
function findNestedTraeRules(cwd: string): TraeNotImported[] {
	const out: TraeNotImported[] = [];
	const projectRoot = traeProjectRoot(cwd);
	const skip = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".next", "vendor"]);
	const walk = (dir: string, depth: number): void => {
		if (depth > TRAE_RULES_MAX_DEPTH) return;
		// `Dirent[]` rather than `ReturnType<typeof readdirSync>`: that resolves to
		// the `Buffer` overload and the names come out typed as buffers.
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || skip.has(entry.name)) continue;
			const child = join(dir, entry.name);
			// The project's **own** `.trae` is not a subdirectory's rules: it is the
			// tree `readTraeRuleDir` has just imported, one line above in the same
			// report. Reporting it here put one directory in the report as both
			// imported and not imported, which is the one thing a plan and its report
			// must never do — and it also merged into the subdirectory reason group,
			// so a real subdirectory's line lost its own path to a summary label.
			if (entry.name === ".trae" && child !== projectRoot && existsSync(join(child, "rules"))) {
				out.push({
					path: join(child, "rules"),
					reason:
						"TRAE reads rules from a subdirectory like this and applies them to that subtree only; this build's rules directory is flat, so importing it would make a scoped rule global",
				});
				continue;
			}
			walk(child, depth + 1);
		}
	};
	walk(cwd, 0);
	return out;
}

/** One `mcp.json`, read as the document it is. */
export interface RawTraeMcpDocument {
	path: string;
	scope: "global" | "project";
	servers: Record<string, unknown>;
	malformed: boolean;
	unreadable: boolean;
}

function readTraeMcpDocument(path: string, scope: RawTraeMcpDocument["scope"]): RawTraeMcpDocument {
	const doc = readTraeDocument(path);
	if (doc.kind === "absent") return { path, scope, servers: {}, malformed: false, unreadable: false };
	if (doc.kind === "unreadable") return { path, scope, servers: {}, malformed: false, unreadable: true };
	const servers = doc.value.mcpServers;
	if (servers === undefined) return { path, scope, servers: {}, malformed: false, unreadable: false };
	if (!isRecord(servers)) return { path, scope, servers: {}, malformed: true, unreadable: false };
	return { path, scope, servers, malformed: false, unreadable: false };
}

/** The editor's databases, by name only. */
function readTraeStateDatabases(userData: string): RawTrae["stateDatabases"] {
	const out: RawTrae["stateDatabases"] = [];
	const global = traeGlobalStateDatabase(userData);
	if (existsSync(global)) out.push({ path: global, kind: "global" });
	const storage = traeWorkspaceStorageDir(userData);
	try {
		for (const entry of readdirSync(storage, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(storage, entry.name, "state.vscdb");
			if (existsSync(path)) out.push({ path, kind: "workspace", workspace: entry.name });
		}
	} catch {
		// no workspaceStorage: TRAE has not been opened here, or the directory is
		// not readable, and either way there is no database to name
	}
	return out;
}

/** TRAE's user state. */
export interface RawTrae {
	roots: {
		global: string;
		project: string;
		/** `null` when none of the four product directories is installed. */
		userData: string | null;
		product: string | null;
		/** Which global-rules home the edition implies. */
		edition: "intl" | "cn";
	};
	/**
	 * True when there is anything here at all.
	 *
	 * Wider than "is there something importable", for the same reason Cursor's and
	 * OpenCode's are: `planMigration` gates this source on `present`, so a home
	 * whose only TRAE trace is one of the things this importer deliberately does
	 * not carry — a `user_rules.md` where the documentation gives a directory, an
	 * `AGENTS.md` this build already reads, a `settings.json` that configures an
	 * editor, a broken `mcp.json` — would print none of the sentences written for
	 * it and report "nothing migratable in it" instead. The report is the only
	 * place those sentences live, so `present` gates on the sentences.
	 */
	present: boolean;
	rules: TraeRule[];
	/** Files found and deliberately not imported, each with its reason. */
	notImported: TraeNotImported[];
	mcp: RawTraeMcpDocument[];
	stateDatabases: Array<{ path: string; kind: "workspace" | "global"; workspace?: string }>;
	/**
	 * The editor's own settings files, found here and reported there.
	 *
	 * The probe lives in the reader rather than in `trae-plan.ts` for two reasons,
	 * and the second is the load-bearing one: the planner must not reach into the
	 * *source* filesystem, and `present` has to know about these files — a home
	 * whose only trace is a `settings.json` would otherwise be reported as having
	 * nothing migratable in it, with the sentence explaining it unreachable.
	 */
	editorSettings: Array<{ name: "settings.json" | "keybindings.json"; path: string }>;
	/** Names in the global root this importer has no mapping for. */
	otherGlobalEntries: string[];
}

/**
 * The `~/.trae/user_rules.md` shape, named because one source claims it exists.
 *
 * Exported so a test names this sentence rather than copying it: a test that
 * retypes a report string stops being an assertion about the report the day
 * somebody rewords it, and starts passing again by coincidence.
 */
export const TRAE_USER_RULES_FILE =
	"a user_rules.md file rather than the documented user_rules directory — the documentation only ever gives the directory, and this importer reads that";

/**
 * One sentence per documented TRAE feature this importer names and does not carry.
 *
 * Exported for the same reason {@link TRAE_USER_RULES_FILE} is: a test that
 * retypes a report string stops being an assertion about the report the day
 * somebody rewords it, and starts passing again by coincidence. Each one names
 * the feature, says it is real, and says the one thing that would make an import
 * wrong — because "this importer does not read it" on its own reads as an
 * oversight rather than as a decision.
 *
 * Every feature here is **vendor-documented** (`docs.trae.ai`, read 2026-09-29);
 * the changelog version that introduced each is in the sentence, so a reader can
 * tell "TRAE has this" from "TRAE had this once". The changelog is what dates
 * the hooks claim in particular — v3.5.66, 2026-06-10, "Supported hooks" — and
 * that entry is the reason the previous draft of `trae-plan.ts`, which said
 * TRAE had no hook system, was wrong rather than merely out of date.
 *
 * The first three keys are the `name` column of `TRAE_OWNED_ASSETS` in
 * `trae-home.ts` and are typed to match it, so the two tables cannot drift: a
 * row with no sentence is a compile error rather than a report line that renders
 * as `undefined`. The last three are named by the reader directly, because they
 * are not "the documented basename under the documented root".
 */
export const TRAE_OWNED_ASSET_REASONS = {
	skills:
		"trae skills (docs.trae.ai/ide/skills, since v3.5.24/25 on 2026-01-23) are a directory of SKILL.md folders that trae loads on demand; this importer carries no skills at all yet, so naming the tree is the whole of what it can do",
	commands:
		"trae slash commands (docs.trae.ai/ide/slash-commands, since v3.5.54/56 in April 2026) are a directory of .md files up to three levels deep; this build's rules directory is flat and its commands are not the same shape, so importing them here would change what runs",
	"hooks.json":
		"trae hooks (docs.trae.ai/ide/automate-actions-with-hooks, since v3.5.66 on 2026-06-10) are user-defined shell commands on six lifecycle events; they are executable code, not settings, and a copy that lands in the wrong place runs at the wrong time — the events are not the same as this build's",
	memory:
		"trae memories (docs.trae.ai/ide/memories, since v3.5.21 on 2026-01-13) are a user-profile file the agent maintains about you; this importer carries no memory of its own yet, so naming it is all it can do",
	"memory-projects":
		"trae's per-project memory (docs.trae.ai/ide/memories) lives under memory/projects/{project_path}/project_memory.md, and the vendor never says what {project_path} is spelled like — the tree is named so you can look, and the file inside it is not guessed at",
	"skill-config":
		"trae's skill-config.json (docs.trae.ai/ide/skills) is the only record of which project skills you switched off; it configures trae rather than this build, so it is named and left where it is",
} as const satisfies Record<string, string>;

/**
 * The invariant that makes {@link TRAE_OWNED_ASSETS} safe to index by `name`.
 *
 * Written as a value rather than a comment because a comment is not checked: if
 * a seventh row is ever added to the table in `trae-home.ts`, this stops
 * compiling until a sentence exists for it. `TraeName` is exactly the union of
 * the table's `name` column, inferred rather than restated.
 */
type TraeOwnedName = (typeof TRAE_OWNED_ASSETS)[number]["name"];
// A value so the type is used, and an error rather than a silent widening if a
// row's name ever falls outside the sentences above.
const _everyNameHasASentence: Record<TraeOwnedName, true> = {
	skills: true,
	commands: true,
	"hooks.json": true,
};
void _everyNameHasASentence;

/** The project-root files TRAE reads, named because this build reads them itself. */
const TRAE_PROJECT_CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"] as const;

export function readTrae(home: string, cwd: string): RawTrae {
	const projectRoot = traeProjectRoot(cwd);
	const userData = traeUserDataRoot(home);
	// The edition is decided by which global home is actually there, because the
	// two builds are separate products: a China install has `~/.trae-cn` and no
	// `~/.trae`, so defaulting to the international one would read a directory that
	// was never written. The rule itself lives in `traeEdition` so the reader, the
	// detection roots and the label cannot disagree about which build this is.
	const edition = traeEdition(home);
	const globalRules = traeGlobalRulesDir(home, edition);
	const globalRoot = join(home, edition === "cn" ? ".trae-cn" : ".trae");

	const project = readTraeRuleDir(traeProjectRulesDir(cwd), "project");
	const global = readTraeRuleDir(globalRules, "user");
	const notImported: TraeNotImported[] = [...project.tooDeep, ...global.tooDeep, ...findNestedTraeRules(cwd)];
	for (const name of TRAE_PROJECT_CONTEXT_FILES) {
		const path = join(cwd, name);
		if (existsSync(path)) {
			notImported.push({
				path,
				reason:
					name === "AGENTS.md"
						? "this build reads the project's AGENTS.md where it stands, so importing a second copy would put the same instructions in the context twice"
						: "TRAE reads this at the project root behind a settings toggle; this build reads the project's AGENTS.md instead, and does not read this one",
			});
		}
	}
	const skills = traeCrossToolSkillsDir(cwd);
	if (existsSync(skills)) {
		notImported.push({
			path: skills,
			reason:
				'TRAE reads the cross-tool .agents/skills directory, and only once you add the directory to the project and switch on "Enable the .agents/skills directory" under Settings > Skills & Commands; the agents source owns the .agents convention here, and two sources reading one tree is how a skill lands twice',
		});
	}
	if (existsSync(join(globalRoot, "user_rules.md"))) {
		notImported.push({ path: join(globalRoot, "user_rules.md"), reason: TRAE_USER_RULES_FILE });
	}
	// The four features the 2026-09-29 re-check found documented. Probed rather
	// than listed unconditionally, because a sentence about a directory that is
	// not there is noise, and because each of these is opt-in in trae itself
	// (a toggle, or a file the editor only writes once the user creates
	// something) — its absence is the normal case on most machines.
	for (const asset of TRAE_OWNED_ASSETS) {
		const path = traeOwnedPath(asset, home, edition, cwd);
		if (existsSync(path)) notImported.push({ path, reason: TRAE_OWNED_ASSET_REASONS[asset.name] });
	}
	// The two memory paths and the skill switch file are outside that table on
	// purpose. The memories page names a *file* one level under the directory
	// (`user_profile.md`) and a project tree whose directory is written as
	// `{project_path}` and never defined, and the skill page names a file rather
	// than a directory; none of the three is "the documented basename under the
	// root", so none of them belongs in a table that means exactly that.
	const globalMemory = traeGlobalMemoryFile(home, edition);
	if (existsSync(globalMemory)) {
		notImported.push({ path: globalMemory, reason: TRAE_OWNED_ASSET_REASONS.memory });
	}
	const projectMemory = traeProjectMemoryDir(home, edition);
	if (existsSync(projectMemory)) {
		notImported.push({ path: projectMemory, reason: TRAE_OWNED_ASSET_REASONS["memory-projects"] });
	}
	const skillConfig = join(traeProjectRoot(cwd), TRAE_SKILL_CONFIG_FILENAME);
	if (existsSync(skillConfig)) {
		notImported.push({ path: skillConfig, reason: TRAE_OWNED_ASSET_REASONS["skill-config"] });
	}

	const mcp = [
		...(userData ? [readTraeMcpDocument(traeGlobalMcpFile(userData.root), "global")] : []),
		readTraeMcpDocument(traeProjectMcpFile(cwd), "project"),
	];
	const stateDatabases = userData ? readTraeStateDatabases(userData.root) : [];
	const editorSettings = userData
		? (["settings.json", "keybindings.json"] as const)
				.map((name) => ({ name, path: join(userData.root, name) }))
				.filter((entry) => existsSync(entry.path))
		: [];

	// The global names already accounted for above. Every one of these now has a
	// sentence of its own, and leaving them in this list as well would put the
	// same directory in one report twice — once as "trae skills, not carried"
	// and once as "an entry this importer reads nothing out of" — which is the
	// self-contradiction this module warns about one screen up. The list is what
	// is left over, and it is only meaningful if the accounted half is really
	// accounted.
	const accountedGlobalNames = new Set<string>([
		"user_rules",
		"user_rules.md",
		...TRAE_OWNED_ASSETS.filter((asset) => asset.scope === "global").map((asset) => asset.name),
		"memory",
	]);
	let otherGlobalEntries: string[] = [];
	try {
		otherGlobalEntries = existsSync(globalRoot)
			? readdirSync(globalRoot)
					.filter((name) => !accountedGlobalNames.has(name))
					.sort()
			: [];
	} catch {
		otherGlobalEntries = [];
	}

	return {
		roots: {
			global: globalRules,
			project: projectRoot,
			userData: userData?.root ?? null,
			product: userData?.product ?? null,
			edition,
		},
		present:
			project.rules.length > 0 ||
			global.rules.length > 0 ||
			mcp.some((doc) => Object.keys(doc.servers).length > 0) ||
			// A document that is there and cannot be read has a sentence written for
			// it in the plan, and a source that is not `present` prints none of them.
			mcp.some((doc) => doc.malformed || doc.unreadable) ||
			stateDatabases.length > 0 ||
			// The editor's settings are the one thing TRAE documents as its main
			// configuration and this importer cannot carry, so the two sentences
			// explaining that have to be reachable — and they are only printed when
			// the plan is reached at all.
			editorSettings.length > 0 ||
			// Same reasoning for everything found and deliberately not carried, and
			// for the names in the global root nobody reads. Each of those lists is a
			// report line that exists only when the source is reached at all.
			notImported.length > 0 ||
			otherGlobalEntries.length > 0,
		rules: [...project.rules, ...global.rules],
		notImported,
		mcp,
		stateDatabases,
		editorSettings,
		otherGlobalEntries,
	};
}
