/**
 * The `grok-build` migration source: where the tree is, and what the reader takes
 * from it.
 *
 * Grok Build resolves its home through `resolve_grok_home_from`
 * (`crates/codegen/xai-dirs/src/lib.rs`), and that rule differs from the harness's
 * in three places a reader is tempted to paper over: a `~` is *not* expanded, a
 * relative value is *not* resolved against the working directory, and a
 * whitespace-only value *is* a path. Each of those is a directory another tool
 * would never write to, so each gets a test here — a reader that "helpfully"
 * normalized them would import the wrong tree and call the right one absent.
 *
 * The reader's own invariants get tests too, and the load-bearing one is the
 * credential boundary: `auth.json` is touched by `existsSync` and nothing else, so
 * a sentinel written into it must not appear anywhere in what the reader returns.
 * The same holds for a plugin's `.mcp.json`, which is counted and never opened.
 *
 * Fixtures use fake values only — no fixture here holds anything shaped like a
 * real credential, and the sentinels are deliberately not key-shaped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeGrokCwdDir, GROK_DEFAULT_DIR, grokRoot, grokSessions, grokSessionsRoot } from "../src/grok-home.ts";
import {
	detectSources,
	MIGRATION_SOURCE_IDS,
	MIGRATION_SOURCE_LABELS,
	type MigrationItem,
	type MigrationPlan,
	planMigration,
	type RawGrokBuild,
	readGrokBuild,
	readSources,
} from "../src/migrate.ts";
import type { RawSettingsInput } from "../src/settings.ts";

/** Directories a test made, swept when it ends. */
const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Environment variables a test borrowed, restored after it. */
const borrowed = new Map<string, string | undefined>();
afterEach(() => {
	for (const [name, value] of borrowed) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	borrowed.clear();
});

/** Borrow one environment variable for the rest of the test. */
function setEnv(name: string, value: string | undefined): void {
	if (!borrowed.has(name)) borrowed.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** Files keyed by path relative to a base, written with their parents. */
function writeTree(base: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		const full = join(base, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

/**
 * A skill laid out as grok keeps one: `skills/<name>/SKILL.md` under a root.
 *
 * A name may carry a slash, which is how a nested skill inside a `[skills] paths`
 * entry is expressed.
 */
function skill(name: string, body = `# ${name}\n`): Record<string, string> {
	return { [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: fixture\n---\n\n${body}` };
}

/**
 * A path as a TOML literal string.
 *
 * A TOML basic string reads `\` as an escape, so a Windows path drops straight
 * into one as `\U` and the whole document fails to parse — which would make a
 * config fixture silently empty rather than wrong. Single quotes are TOML's
 * no-escapes spelling, and a temp path cannot contain one.
 */
function tomlPath(path: string): string {
	return `'${path}'`;
}

/** Skill names in reader order. */
function skillNames(raw: RawGrokBuild): string[] {
	return raw.skills.map((file) => file.name);
}

describe("the Grok Build root", () => {
	test("an unset variable means ~/.grok", () => {
		const home = makeDir("lbb-grok-home-");
		setEnv("GROK_HOME", undefined);
		expect(grokRoot(home)).toBe(join(home, GROK_DEFAULT_DIR));
		expect(grokRoot(home)).toBe(join(home, ".grok"));
	});

	test("an empty variable is unset, but a whitespace one is a path", () => {
		const home = makeDir("lbb-grok-home-");
		setEnv("GROK_HOME", "");
		expect(grokRoot(home)).toBe(join(home, ".grok"));
		// The harness treats all four of these as unset; grok filters on
		// `is_empty` alone, so three of them name a directory this reader has to
		// follow it to — reading them as unset would import `~/.grok` while grok
		// itself writes elsewhere.
		for (const blank of ["   ", "\t", "\n"]) {
			setEnv("GROK_HOME", blank);
			expect(grokRoot(home)).toBe(blank);
		}
	});

	test("a ~ is a directory name, not the home directory", () => {
		const home = makeDir("lbb-grok-home-");
		setEnv("GROK_HOME", "~/elsewhere");
		// `PathBuf::from(env)` takes the value verbatim. Expanding it here would
		// read `<home>/elsewhere`, which grok never opens.
		expect(grokRoot(home)).toBe("~/elsewhere");
		expect(grokRoot(home)).not.toBe(join(home, "elsewhere"));
	});

	test("a relative value stays relative and an absolute one is taken whole", () => {
		const home = makeDir("lbb-grok-home-");
		setEnv("GROK_HOME", "grok-state");
		expect(grokRoot(home)).toBe("grok-state");
		const absolute = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", absolute);
		expect(grokRoot(home)).toBe(absolute);
	});

	test("the default is consulted per call, not snapshotted at import", () => {
		const home = makeDir("lbb-grok-home-");
		setEnv("GROK_HOME", undefined);
		const first = grokRoot(home);
		setEnv("GROK_HOME", join(home, "moved"));
		expect(grokRoot(home)).not.toBe(first);
		expect(grokRoot(home)).toBe(join(home, "moved"));
	});

	test("the sixth source is appended, so the five before it keep their order", () => {
		// At a fixed index rather than at the end: sources added after this one are
		// appended behind it, which is what "appended" means for a list whose order
		// decides detection and which source wins a shared target file.
		expect(MIGRATION_SOURCE_IDS[5]).toBe("grok-build");
		expect(MIGRATION_SOURCE_IDS.slice(0, 5)).toEqual(["claude-code", "codex", "zcode", "agents", "deepseek-harness"]);
		expect(MIGRATION_SOURCE_LABELS["grok-build"]).toBe("Grok Build");
	});
});

describe("a session directory's working directory", () => {
	test("a percent-encoded absolute path decodes to itself", () => {
		const root = makeDir("lbb-grok-sessions-");
		const dir = join(root, encodeURIComponent("/home/dev/project"));
		mkdirSync(dir, { recursive: true });
		expect(decodeGrokCwdDir(dir)).toBe("/home/dev/project");
	});

	test("a Windows drive letter counts as absolute, as it does for grok", () => {
		const root = makeDir("lbb-grok-sessions-");
		const dir = join(root, encodeURIComponent("G:\\work\\repo"));
		mkdirSync(dir, { recursive: true });
		expect(decodeGrokCwdDir(dir)).toBe("G:\\work\\repo");
	});

	test("a slug-hash name reads its .cwd sidecar", () => {
		const root = makeDir("lbb-grok-sessions-");
		const dir = join(root, "very-long-repo-name-9f2c1a4b7e0d3856");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".cwd"), "/srv/very/long/path/repo\n");
		expect(decodeGrokCwdDir(dir)).toBe("/srv/very/long/path/repo");
	});

	test("a name that decodes to nothing absolute and has no sidecar is null", () => {
		const root = makeDir("lbb-grok-sessions-");
		const dir = join(root, "not-a-path-name");
		mkdirSync(dir, { recursive: true });
		// A guess here would put one project's prompts under another's.
		expect(decodeGrokCwdDir(dir)).toBeNull();
	});

	test("a stray percent sign falls through to the sidecar rather than throwing", () => {
		const root = makeDir("lbb-grok-sessions-");
		const dir = join(root, "50%-repo");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".cwd"), "/tmp/fifty\n");
		expect(decodeGrokCwdDir(dir)).toBe("/tmp/fifty");
	});
});

describe("enumerating sessions", () => {
	test("a directory without summary.json is not a session", () => {
		const root = makeDir("lbb-grok-root-");
		const cwd = join(grokSessionsRoot(root), "encoded");
		writeTree(cwd, {
			"has-marker/summary.json": "{}",
			"has-marker/updates.jsonl": "{}\n",
			// The marker is written last; its absence is how an interrupted
			// `x.ai/session/import` looks, and such a session is not worth offering.
			"interrupted/updates.jsonl": "{}\n",
		});
		const found = grokSessions(root);
		expect(found.map((session) => session.id)).toEqual(["has-marker"]);
		expect(found[0]?.summaryPath).toBe(join(cwd, "has-marker", "summary.json"));
		expect(found[0]?.updatesPath).toBe(join(cwd, "has-marker", "updates.jsonl"));
	});

	test("sessions come back sorted, across working directories", () => {
		const root = makeDir("lbb-grok-root-");
		writeTree(grokSessionsRoot(root), {
			"b-cwd/z-session/summary.json": "{}",
			"b-cwd/a-session/summary.json": "{}",
			"a-cwd/m-session/summary.json": "{}",
		});
		expect(grokSessions(root).map((session) => session.id)).toEqual(["m-session", "a-session", "z-session"]);
	});

	test("a missing or unreadable sessions root is no sessions, not an error", () => {
		const root = makeDir("lbb-grok-root-");
		expect(grokSessions(root)).toEqual([]);
		const blocked = makeDir("lbb-grok-root-");
		writeFileSync(grokSessionsRoot(blocked), "not a directory\n");
		expect(grokSessions(blocked)).toEqual([]);
	});
});

describe("reading a Grok Build home", () => {
	test("the reader follows $GROK_HOME away from the home directory", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(home, { ".grok/AGENTS.md": "home copy\n" });
		writeTree(root, { "AGENTS.md": "moved copy\n" });
		const raw = readGrokBuild(home);
		expect(raw.root).toBe(root);
		expect(raw.memory).toBe("moved copy\n");
	});

	test("the instruction file is read under either of grok's two spellings, once", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, { "Agents.md": "capitalised\n" });
		expect(readGrokBuild(home).memory).toBe("capitalised\n");
		writeFileSync(join(root, "AGENTS.md"), "shouting\n");
		// One file or two, depending on the filesystem, and this is the assertion
		// that holds either way: on a case-insensitive one both names are this file
		// — grok dedups exactly here, by canonical path — and reading it twice would
		// put the user's instructions into the imported rule twice. Which of the two
		// names wins cannot be observed here at all: the filesystem collapses them.
		expect(readGrokBuild(home).memory).toBe("shouting\n");
	});

	test("AGENT.md is one of grok's instruction files, and the singular name was skipped", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, { "AGENT.md": "singular\n" });
		// The name is in grok's own list (`INSTRUCTION_FILENAMES`,
		// `xai-grok-tools/src/types/compat.rs:309-316`) beside two that are not: it is
		// grok's name in the singular, not a vendor's spelling of anything, so a user
		// who wrote this file has instructions grok loads. This importer used to read
		// only the two plural spellings and walk past it.
		expect(readGrokBuild(home).memory).toBe("singular\n");
	});

	test("every spelling that exists is read, and the Claude ones are left to their source", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"AGENTS.md": "plural\n",
			"AGENT.md": "singular\n",
			// Claude Code's spelling. grok carries it for its compat cells, and the tree
			// it is read from — `~/.claude` — belongs to the claude-code source here.
			"CLAUDE.md": "zz-claude-not-read-zz\n",
		});
		const raw = readGrokBuild(home);
		// Sorted, because which of the two grok-named spellings is read first depends on
		// the filesystem: `Agents.md` and `AGENTS.md` are one file on a case-insensitive
		// one and two on a case-sensitive one, and grok joins whichever exist.
		expect(
			raw.memory
				?.split("\n\n")
				.map((document) => document.trim())
				.sort(),
		).toEqual(["plural", "singular"]);
		expect(JSON.stringify(raw)).not.toContain("zz-claude-not-read-zz");
	});

	test("a config.toml that will not parse is reported, and the rest still reads", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, { "config.toml": "this is = = not toml\n", ...skill("alpha") });
		const raw = readGrokBuild(home);
		expect(raw.configError).toBe("config.toml is not parseable as TOML");
		expect(raw.config).toEqual({});
		// Aborting the whole run over one bad file would also drop the sources
		// that are fine, so the trees are still read.
		expect(skillNames(raw)).toEqual(["alpha"]);
	});

	test("an absent config.toml is not an error, it is an empty config", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		const raw = readGrokBuild(home);
		expect(raw.config).toEqual({});
		expect(raw.configError).toBeUndefined();
	});

	test("the global memory document is read; the workspace ones are counted", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"memory/MEMORY.md": "global notes\n",
			"memory/repo-1a2b3c4d/MEMORY.md": "project notes\n",
			"memory/other-9f8e7d6c/MEMORY.md": "another project\n",
			"memory-v2/workspaces/deadbeef/MEMORY.md": "v2 notes\n",
		});
		const raw = readGrokBuild(home);
		expect(raw.globalMemory).toBe("global notes\n");
		// Three workspace documents: two legacy, one v2. They keep their scope by
		// staying put — this build's memory is user-global, so importing one would
		// make project notes into instructions for every project.
		expect(raw.memoryWorkspaceCount).toBe(3);
		expect(JSON.stringify(raw)).not.toContain("project notes");
		expect(JSON.stringify(raw)).not.toContain("v2 notes");
	});

	test("[memory_v2] enabled moves the global document to the v2 tree", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"config.toml": "[memory_v2]\nenabled = true\n",
			"memory/MEMORY.md": "legacy notes\n",
			"memory-v2/global/MEMORY.md": "v2 notes\n",
		});
		const raw = readGrokBuild(home);
		// The two generations are isolated trees rather than two views of one: with the
		// switch on, grok reads this file and cannot see the legacy root at all. Reading
		// `memory/MEMORY.md` here would carry over a document grok no longer loads.
		expect(raw.globalMemory).toBe("v2 notes\n");
		expect(raw.globalMemorySource.generation).toBe("v2");
		// The document left behind is recorded, not merged: it is the one that used to
		// be in force, and the plan names it rather than dropping it in silence.
		expect(raw.globalMemorySource.other).toBe(join(root, "memory", "MEMORY.md"));
	});

	test("the switch absent and the switch false are the same tree — the legacy one", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"memory/MEMORY.md": "legacy notes\n",
			"memory-v2/global/MEMORY.md": "v2 notes\n",
		});
		const absent = readGrokBuild(home);
		expect(absent.globalMemory).toBe("legacy notes\n");
		expect(absent.globalMemorySource.generation).toBe("legacy");
		expect(absent.globalMemorySource.other).toBe(join(root, "memory-v2", "global", "MEMORY.md"));
		// `Absent or false falls through to legacy` is grok's own wording for the gate
		// (`xai-grok-config-types/src/memory.rs:107-109`), so both spellings land here.
		writeFileSync(join(root, "config.toml"), "[memory_v2]\nenabled = false\n");
		expect(readGrokBuild(home).globalMemory).toBe("legacy notes\n");
	});

	test("a skill named in [skills] disabled is left behind, with the key that did it", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"config.toml": '[skills]\ndisabled = ["beta"]\n',
			...skill("alpha"),
			...skill("beta"),
			...skill("gamma"),
		});
		const raw = readGrokBuild(home);
		expect(skillNames(raw)).toEqual(["alpha", "gamma"]);
		expect(raw.skillSkips).toEqual([{ name: "beta", reason: "disabled by [skills] disabled" }]);
	});

	test("[skills] ignore drops a skill by path prefix, expanded and named in the reason", () => {
		const home = makeDir("lbb-grok-home-");
		// No `$GROK_HOME`, so the root is `<home>/.grok` and a `~` in the config
		// has something to expand to. That pairing is the test: a `~` is the user's
		// home, not the grok root, and expanding it to the wrong one would match
		// nothing and import a skill the user excluded.
		setEnv("GROK_HOME", undefined);
		const root = join(home, GROK_DEFAULT_DIR);
		writeTree(home, {
			".grok/config.toml": `[skills]\nignore = ["~/.grok/skills/noisy"]\n`,
			...prefixKeys(".grok/", { ...skill("kept"), ...skill("noisy") }),
		});
		const raw = readGrokBuild(home);
		expect(skillNames(raw)).toEqual(["kept"]);
		// The reason names the expanded path, so a user can see which prefix did
		// it even though the config said `~`.
		expect(raw.skillSkips).toEqual([
			{ name: "noisy", reason: `excluded by [skills] ignore (${join(root, "skills", "noisy")})` },
		]);
	});

	test("[skills] disabled and ignore are reported separately when both would fire", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"config.toml": `[skills]\ndisabled = ["quiet"]\nignore = [${tomlPath(join(root, "skills", "quiet"))}]\n`,
			...skill("quiet"),
		});
		const raw = readGrokBuild(home);
		expect(skillNames(raw)).toEqual([]);
		// Disabled is checked first, and grok applies it later, so it is the one
		// that names the reason rather than the path rule that also matched.
		expect(raw.skillSkips).toEqual([{ name: "quiet", reason: "disabled by [skills] disabled" }]);
	});

	test("a skill nested under the skills root is still a skill, as it is for grok", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		// A skill that holds a skill: grok keeps descending past a directory with
		// its own `SKILL.md`, so both of these load.
		writeTree(root, { ...skill("grouped"), ...skill("grouped/deep"), ...skill("kept") });
		expect(skillNames(readGrokBuild(home))).toEqual(["grouped", "deep", "kept"]);
	});

	test("the recursive skill walk stops at grok's own depth, not earlier or later", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		// Six levels is the deepest grok reaches (`MAX_SKILL_WALK_DEPTH = 5`); the
		// seventh is past it. Pinning both ends is the point — a walk that stopped
		// at one level would pass a "some nesting works" test and still drop a
		// skill grok loads.
		writeTree(root, { ...skill("a/b/c/d/e/f"), ...skill("a/b/c/d/e/f/g") });
		expect(skillNames(readGrokBuild(home))).toEqual(["f"]);
	});

	test("[skills] paths adds skills from outside the home, walked recursively", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		const extra = makeDir("lbb-grok-extra-");
		setEnv("GROK_HOME", root);
		writeTree(extra, { ...skill("top"), ...skill("nested/deep") });
		writeTree(root, { "config.toml": `[skills]\npaths = [${tomlPath(extra)}]\n`, ...skill("own") });
		const raw = readGrokBuild(home);
		expect(skillNames(raw).sort()).toEqual(["deep", "own", "top"]);
		const nested = raw.skills.find((file) => file.name === "deep");
		expect(nested?.detail).toBe(`listed in [skills] paths (${extra})`);
	});

	test("[skills] paths accepts a SKILL.md file, the other spelling grok takes", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		const extra = makeDir("lbb-grok-extra-");
		setEnv("GROK_HOME", root);
		writeTree(extra, { "skills/solo/SKILL.md": "---\nname: solo\n---\n\nbody\n" });
		writeTree(root, { "config.toml": `[skills]\npaths = [${tomlPath(join(extra, "skills", "solo", "SKILL.md"))}]\n` });
		const raw = readGrokBuild(home);
		expect(skillNames(raw)).toEqual(["solo"]);
	});

	test("a [skills] paths entry inside a vendor tree belongs to that vendor's source", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, { "config.toml": `[skills]\npaths = ["~/.claude/skills"]\n` });
		writeTree(home, { ".claude/skills/from-claude/SKILL.md": "---\nname: from-claude\n---\nbody\n" });
		const raw = readGrokBuild(home);
		// Not imported here: `claude-code` is a source of its own in this build,
		// and importing the same tree twice would file two copies of every skill.
		expect(skillNames(raw)).toEqual([]);
		expect(raw.skillSkips).toEqual([
			{
				name: "~/.claude/skills",
				reason: "inside grok's .claude compatibility tree, which the claude source already imports",
			},
		]);
		expect(raw.vendorTrees).toContain(".claude");
	});

	test("a [skills] paths entry with nothing at it is named, not dropped", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, { "config.toml": `[skills]\npaths = ["./gone"]\n` });
		const raw = readGrokBuild(home);
		expect(raw.skillSkips).toEqual([{ name: "./gone", reason: "no SKILL.md at that path" }]);
	});

	test("the launcher-injected skill directories are counted, never walked", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"config.toml": '[skills]\nserver_skill_dirs = ["/srv/a", "/srv/b"]\nbundled_skill_dirs = ["/opt/c"]\n',
			"/srv/a/SKILL.md": "never read\n",
			"/opt/c/SKILL.md": "never read\n",
		});
		const raw = readGrokBuild(home);
		expect(raw.serverSkillDirCount).toBe(2);
		expect(raw.bundledSkillDirCount).toBe(1);
		expect(skillNames(raw)).toEqual([]);
	});

	test("plugin skills and agents cross over, each carrying its plugin", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			...prefixKeys("plugins/loose/", { ...skill("plug-in"), "agents/helper.md": "---\nname: helper\n---\nbody\n" }),
			...prefixKeys("installed-plugins/market/", { ...skill("market-skill") }),
			// A file, not a third root: grok keeps the list of plugins the user has
			// trusted here. A reader that treated it as a directory would report its
			// contents as plugins grok never loads.
			"trusted-plugins": "loose\nmarket\n",
		});
		const raw = readGrokBuild(home);
		expect(raw.pluginCount).toBe(2);
		// Plugin-root order, then name order within each root: the two roots are
		// walked in grok's own order rather than merged and sorted.
		expect(raw.pluginSkills.map((file) => file.name)).toEqual(["plug-in", "market-skill"]);
		const loose = raw.pluginSkills.find((file) => file.name === "plug-in");
		expect(loose?.detail).toContain('from plugin "loose" (plugins)');
		expect(raw.pluginAgents.map((file) => file.name)).toEqual(["helper.md"]);
		expect(raw.pluginAgents[0]?.detail).toContain('from plugin "loose" (plugins)');
	});

	test("the install directory is walked, so a repository and a plugin inside it are both found", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			// A marketplace clone: the repository root is not a plugin, but it holds
			// several, which is the layout a monorepo of plugins has.
			"installed-plugins/repo/.git/HEAD": "ref: refs/heads/main\n",
			...prefixKeys("installed-plugins/repo/plugins/one/", skill("one")),
			...prefixKeys("installed-plugins/repo/plugins/two/", skill("two")),
		});
		const raw = readGrokBuild(home);
		expect(raw.pluginCount).toBe(2);
		expect(raw.pluginSkills.map((file) => file.name)).toEqual(["one", "two"]);
	});

	test("[plugins] install_dir moves the second root, and the plan says which one it read", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"config.toml": `[plugins]\ninstall_dir = ${tomlPath("elsewhere")}\n`,
			...prefixKeys("elsewhere/moved/", skill("moved")),
			...prefixKeys("installed-plugins/ignored/", skill("ignored")),
		});
		const raw = readGrokBuild(home);
		expect(raw.pluginSkills.map((file) => file.name)).toEqual(["moved"]);
		expect(raw.pluginSkills[0]?.detail).toContain('from plugin "moved" ([plugins].install_dir)');
	});

	test("a manifest may point the content somewhere else, and only inside the plugin", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			// A manifest naming its own directories: a reader that only looked at the
			// conventional `skills/` would report this plugin as empty while grok
			// loads all of it. `PathOrPaths` takes one path or a list, so both
			// spellings are here.
			"plugins/shifted/plugin.json": '{"skills":["lib/skills","./keys"],"agents":"lib/agents","commands":"lib/cmd"}\n',
			"plugins/shifted/lib/skills/inside/SKILL.md": `---\nname: inside\n---\nbody\n`,
			"plugins/shifted/keys/key/SKILL.md": `---\nname: key\n---\nbody\n`,
			"plugins/shifted/lib/agents/a.md": "---\nname: a\n---\nbody\n",
			"plugins/shifted/lib/cmd/go.md": "---\nname: go\n---\nbody\n",
			// The conventional directories are not consulted once the manifest has
			// named others, which is how grok reads it.
			"plugins/shifted/skills/conventional/SKILL.md": `---\nname: conventional\n---\nbody\n`,
		});
		const raw = readGrokBuild(home);
		expect(raw.pluginSkills.map((file) => file.name)).toEqual(["inside", "key"]);
		expect(raw.pluginAgents.map((file) => file.name)).toEqual(["a.md"]);
		expect(raw.commands.files.map((file) => file.name)).toEqual(["go"]);
	});

	test("a manifest path that escapes the plugin is dropped, not followed", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			// Two levels up from the plugin lands on the grok root, which is what
			// makes this test able to fail: a reader without the containment check
			// would import a skill that is not this plugin's at all. Three levels
			// would land outside the root, where nothing exists and the mutant would
			// look contained because there was nothing to find.
			"plugins/escapee/plugin.json": '{"skills":"../../skills"}\n',
			"skills/outside/SKILL.md": `---\nname: outside\n---\nbody\n`,
			"plugins/escapee/agents/a.md": "---\nname: a\n---\nbody\n",
		});
		const raw = readGrokBuild(home);
		// grok keeps a manifest path only when it stays inside the plugin root, so a
		// `..` that climbs out is not a directory this plugin has.
		expect(raw.pluginSkills).toEqual([]);
	});

	test("a plugin's commands are skills too, and keep saying which plugin they came from", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"plugins/p/commands/ship.md": "---\nname: ship\n---\ndeploy it\n",
			"plugins/p/skills/kept/SKILL.md": "---\nname: kept\n---\nbody\n",
		});
		const raw = readGrokBuild(home);
		expect(raw.commands.files.map((file) => file.name)).toEqual(["ship"]);
		expect(raw.commands.files[0]?.detail).toContain('from plugin "p" (plugins)');
	});

	test("a plugin's MCP declaration and hooks are counted and never opened", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"plugins/with-both/.mcp.json": '{"mcpServers":{"x":{"command":"mcp-sentinel-value"}}}\n',
			"plugins/with-both/hooks/hooks.json": '{"hooks":{"x":"hook-sentinel-value"}}\n',
			"plugins/with-both/skills/tiny/SKILL.md": "---\nname: tiny\n---\nbody\n",
			"plugins/plain/skills/only/SKILL.md": "---\nname: only\n---\nbody\n",
		});
		const raw = readGrokBuild(home);
		expect(raw.pluginMcpCount).toBe(1);
		expect(raw.pluginHookCount).toBe(1);
		const text = JSON.stringify(raw);
		expect(text).not.toContain("mcp-sentinel-value");
		expect(text).not.toContain("hook-sentinel-value");
	});

	test("[skills] disabled reaches plugin skills, [skills] ignore does not", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"config.toml": `[skills]\ndisabled = ["kept-silent"]\nignore = [${tomlPath(join(root, "plugins", "p", "skills"))}]\n`,
			...prefixKeys("plugins/p/", { ...skill("kept-silent"), ...skill("ignored-but-plugin") }),
		});
		const raw = readGrokBuild(home);
		// grok marks disabled skills after merging plugin skills in, and applies
		// `ignore` before that merge — so the name switch reaches them and the path
		// switch never sees them.
		expect(raw.pluginSkills.map((file) => file.name)).toEqual(["ignored-but-plugin"]);
		expect(raw.skillSkips).toEqual([{ name: "kept-silent", reason: 'disabled by [skills] disabled (in plugin "p")' }]);
	});

	test("the vendor trees are read from the home, not from beside the grok root", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(home, { ".cursor/rules/a.md": "cursor's\n", ".agents/AGENTS.md": "agents'\n" });
		writeTree(root, { ".claude/rules/a.md": "beside the root, not the home\n" });
		const raw = readGrokBuild(home);
		expect(raw.vendorTrees).toEqual([".agents", ".cursor"]);
	});

	test("[paths] names the vendor trees it was pointed at, even when they are absent", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"config.toml":
				'[paths]\nextra_rule_dirs = ["/nowhere/.claude/rules"]\nextra_skill_dirs = ["/nowhere/.agents/skills"]\n',
		});
		const raw = readGrokBuild(home);
		expect(raw.vendorTrees).toEqual([".agents", ".claude"]);
	});

	test("machine policy layers under the home are named and not read", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"managed_config.toml": 'model = "policy-sentinel-value"\n',
			"requirements.toml": "fail_closed = true\n",
		});
		const raw = readGrokBuild(home);
		expect(raw.machinePolicy).toEqual(["managed_config.toml", "requirements.toml"]);
		// An administrator's requirement is not the user's preference: importing it
		// would put a restriction into a file the user owns.
		expect(JSON.stringify(raw)).not.toContain("policy-sentinel-value");
	});

	test("runtime artifacts and the remaining trees are named so their absence reads as a decision", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"logs/a.log": "noise\n",
			"crash/b.txt": "noise\n",
			"completions/grok.bash": "noise\n",
			"bundled/skills/x/SKILL.md": "not the user's\n",
			"marketplace-cache/plug/x": "downloaded\n",
			"lsp.json": "{}\n",
			"pager.toml": "[pager]\n",
			"claude_import_state.json": '{"imported_at":"whenever"}\n',
			"models_cache.json": "{}\n",
			"announcements.json": "[]\n",
			"mcp_preferences.json": "{}\n",
		});
		const raw = readGrokBuild(home);
		expect(raw.runtimePresent).toEqual(["logs", "crash", "completions", "models_cache.json", "announcements.json"]);
		expect(raw.bundledPresent).toBe(true);
		expect(raw.marketplaceCachePresent).toBe(true);
		expect(raw.lspPresent).toBe(true);
		expect(raw.pagerPresent).toBe(true);
		expect(raw.claudeImportStatePresent).toBe(true);
		expect(skillNames(raw)).toEqual([]);
	});

	test("sessions are counted through the same rule the history importer uses", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"sessions/%2Fwork%2Fone/s1/summary.json": "{}",
			"sessions/%2Fwork%2Ftwo/s2/summary.json": "{}",
			"sessions/%2Fwork%2Ftwo/half-imported/updates.jsonl": "{}\n",
		});
		expect(readGrokBuild(home).sessionCount).toBe(2);
	});

	test("auth.json is named and never opened", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, { "auth.json": '{"api_key":"credential-sentinel-value"}\n' });
		const raw = readGrokBuild(home);
		// Without this the leak assertion below could pass by the file being absent.
		expect(raw.authPresent).toBe(true);
		expect(JSON.stringify(raw)).not.toContain("credential-sentinel-value");
	});

	test("rules and agents come from their own trees", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"rules/style.md": "# style\n",
			"agents/reviewer.md": "---\nname: reviewer\nmodel: some-model\n---\nbody\n",
		});
		const raw = readGrokBuild(home);
		expect(raw.rules.map((file) => file.name)).toEqual(["style.md"]);
		expect(raw.agents.map((file) => file.name)).toEqual(["reviewer.md"]);
	});

	test("mcp_credentials.json is named and never opened", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, { "mcp_credentials.json": '{"server":{"access_token":"mcp-sentinel-value"}}\n' });
		const raw = readGrokBuild(home);
		expect(raw.mcpCredentialsPresent).toBe(true);
		// grok keeps two credentials at this level, not one: `auth.json` for the
		// account and this one for MCP OAuth tokens. Both are only ever stat'ed.
		expect(JSON.stringify(raw)).not.toContain("mcp-sentinel-value");
	});

	test("trees with no landing place here are counted, and an absent one is not listed", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, {
			"personas/p.toml": "name = 'p'\n",
			"roles/r.toml": "name = 'r'\n",
			"workflows/one.rhai": "fn main() {}\n",
			"workflows/two.rhai": "fn main() {}\n",
			"agent-memory/agent/notes.md": "# notes\n",
			"hooks/pre.sh": "#!/bin/sh\n",
		});
		const raw = readGrokBuild(home);
		// Files count, not just directories: these trees are `.toml`, `.rhai` and
		// scripts, so a directory-only tally reports every one of them as absent.
		// A tree grok does not have is left out rather than listed as empty — an
		// entry with nothing behind it reads as "considered and empty" instead of
		// "not there".
		expect(raw.unimported).toEqual([
			{ name: "personas", count: 1 },
			{ name: "roles", count: 1 },
			{ name: "workflows", count: 2 },
			{ name: "agent-memory", count: 1 },
			{ name: "hooks", count: 1 },
		]);
	});
});

describe("commands, which grok loads as skills", () => {
	/** A reader over one `commands/` tree. */
	function commandsIn(tree: Record<string, string>): RawGrokBuild {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, prefixKeys("commands/", tree));
		return readGrokBuild(home);
	}

	test("a flat .md file is a skill named after its stem", () => {
		const raw = commandsIn({ "ship.md": "---\ndescription: deploy\n---\ndeploy it\n" });
		expect(raw.commands.files.map((file) => file.name)).toEqual(["ship"]);
		expect(raw.commands.files[0]?.sourcePath).toBe(join(raw.root, "commands", "ship.md"));
	});

	test("a nested file is not a command, because grok does not recurse", () => {
		const raw = commandsIn({ "fix/bugs.md": "# bugs\n" });
		// grok's `scan_md_files` reads direct children only, so this file is not a
		// skill there — importing it as `fix-bugs` would invent one.
		expect(raw.commands.files).toEqual([]);
		expect(raw.commands.skips).toEqual([]);
	});

	test("the frontmatter's name wins over the file name, as it does for grok", () => {
		const raw = commandsIn({ "whatever.md": "---\nname: Real Name\n---\nbody\n" });
		expect(raw.commands.files.map((file) => file.name)).toEqual(["real-name"]);
	});

	test("a name that does not survive grok's normalization is skipped, with the reason", () => {
		const raw = commandsIn({ "---.md": "body\n" });
		// grok drops the skill outright when neither the frontmatter nor the stem
		// yields a valid name, so there is nothing here to import.
		expect(raw.commands.files).toEqual([]);
		expect(raw.commands.skips).toEqual([
			{ path: "---.md", reason: "no name grok would take, so grok does not load it" },
		]);
	});

	test("a name past grok's 64-character limit is skipped rather than truncated", () => {
		const long = `${"a".repeat(65)}.md`;
		const raw = commandsIn({ [long]: "body\n" });
		expect(raw.commands.files).toEqual([]);
		expect(raw.commands.skips).toEqual([{ path: long, reason: "name would be longer than 64 characters" }]);
	});

	test("a README comes across, because grok has no special case for one", () => {
		const raw = commandsIn({ "README.md": "# readme\n" });
		expect(raw.commands.files.map((file) => file.name)).toEqual(["readme"]);
		expect(raw.commands.skips).toEqual([]);
	});

	test("only lowercase .md files are commands, which is how grok tests the extension", () => {
		const raw = commandsIn({ "notes.MD": "# not one\n", "notes.txt": "not one\n" });
		expect(raw.commands.files).toEqual([]);
		expect(raw.commands.skips).toEqual([]);
	});
});

describe("detecting the source", () => {
	test("$GROK_HOME pointing elsewhere is enough to detect it", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		writeTree(root, { "config.toml": "[models]\n" });
		expect(detectSources(home)).toContain("grok-build");
	});

	test("an empty $GROK_HOME root is not offered, and neither is an absent home", () => {
		const home = makeDir("lbb-grok-home-");
		const root = makeDir("lbb-grok-root-");
		setEnv("GROK_HOME", root);
		expect(detectSources(home)).not.toContain("grok-build");
		setEnv("GROK_HOME", undefined);
		expect(detectSources(home)).not.toContain("grok-build");
	});

	test("the default home is detected when the variable is unset", () => {
		const home = makeDir("lbb-grok-home-");
		setEnv("GROK_HOME", undefined);
		writeTree(home, { ".grok/config.toml": "[models]\n" });
		expect(detectSources(home)).toContain("grok-build");
	});

	test("a whitespace $GROK_HOME names a directory, so the home tree is not this source", () => {
		const home = makeDir("lbb-grok-home-");
		setEnv("GROK_HOME", "   ");
		writeTree(home, { ".grok/config.toml": "[models]\n" });
		// `~/.grok` is populated, but grok is not reading it — and a report that
		// offered those contents would be describing a tree the tool ignores.
		expect(detectSources(home)).not.toContain("grok-build");
	});
});

/** Rewrite a tree's keys under a prefix, for fixtures that live inside a directory. */
function prefixKeys(prefix: string, tree: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, content] of Object.entries(tree)) out[prefix + path] = content;
	return out;
}

/**
 * Run the planner over a throwaway home whose `~/.grok` holds `tree`.
 *
 * `$GROK_HOME` is cleared so the reader lands on the fixture rather than on a tree
 * the machine running the tests happens to have exported — the same discipline the
 * reader tests above follow, for the same reason.
 */
function plan(tree: Record<string, string>, existing: RawSettingsInput = {}, force = false): MigrationPlan {
	const home = makeDir("lbb-grok-plan-");
	setEnv("USERPROFILE", home);
	setEnv("HOME", home);
	setEnv("GROK_HOME", undefined);
	writeTree(join(home, GROK_DEFAULT_DIR), tree);
	return planMigration(readSources(home), existing, { only: ["grok-build"], force });
}

/** The settings document the plan would write, or an empty one when it writes none. */
function writtenSettings(planned: MigrationPlan): Record<string, unknown> {
	const write = planned.writes.find((w) => w.kind === "settings");
	return JSON.parse(write?.content ?? "{}") as Record<string, unknown>;
}

/** The permissions block of that document, in the shape the planner fills in. */
function writtenPermissions(planned: MigrationPlan): Record<string, string[]> {
	const settings = writtenSettings(planned) as { permissions?: Record<string, string[]> };
	return settings.permissions ?? { allow: [], deny: [], additionalDirectories: [] };
}

/** The report line whose `from` names `needle`, or `undefined` when there is none. */
function line(planned: MigrationPlan, needle: string): MigrationItem | undefined {
	return planned.items.find((item) => item.from.includes(needle));
}

describe("the grok permission table", () => {
	test("the compact arrays are carried as the same decisions", () => {
		const planned = plan({
			"config.toml": [
				"[permission]",
				'allow = ["Bash(git status:*)", "Read(//tmp/**)"]',
				'deny = ["Bash(rm -rf:*)"]',
			].join("\n"),
		});
		const permissions = writtenPermissions(planned);
		// `Bash(git status:*)` is grok's spelling of a prefix rule: it strips the
		// trailing `:*` and prefix-matches the rest against the raw command line, with
		// no word boundary. Plain text is an exact match in this build's grammar, so
		// the wildcard has to be written out or the imported rule would match one
		// command where grok matched a family of them.
		expect(permissions.allow).toEqual(["Bash(git status*)", "Read(//tmp/**)"]);
		expect(permissions.deny).toEqual(["Bash(rm -rf*)"]);
		// The caveat is the sentence that says what carrying a rule over means here,
		// and both halves of it are the reason a user would review the list rather
		// than trust it: an allow runs without a prompt, a deny blocks regardless.
		const added = line(planned, "[permission] → allow");
		expect(added?.detail).toContain("an allowed command runs without a prompt here");
		expect(line(planned, "[permission] → deny")?.detail).toContain("a deny blocks it whatever else is allowed");
		expect(added?.detail).toContain("/permissions");
	});

	test("an ask rule is named, never turned into an allow", () => {
		const planned = plan({ "config.toml": '[permission]\nask = ["WebFetch"]\ndeny = ["Bash(ls:*)"]\n' });
		expect(writtenPermissions(planned).allow).toEqual([]);
		expect(writtenPermissions(planned).deny).toEqual(["Bash(ls*)"]);
		const refused = planned.items.find((item) => item.detail.includes("asks about"));
		expect(refused?.detail).toContain("1 rule(s) the source asks about");
	});

	test("a compact key in the wrong shape falls through to the verbose table", () => {
		const planned = plan({
			"config.toml": [
				"[permission]",
				'allow = "Bash(ls)"',
				"[[permission.rules]]",
				'action = "deny"',
				'tool = "bash"',
				'pattern = "rm"',
			].join("\n"),
		});
		// grok warns about the shape and reads the table below it, so the string is
		// not a rule and the entry under it is.
		expect(line(planned, "[permission] → allow")?.action).toBe("skip");
		expect(line(planned, "[permission] → allow")?.detail).toContain("not an array of rule strings");
		expect(writtenPermissions(planned).allow).toEqual([]);
		expect(writtenPermissions(planned).deny).toEqual(["Bash(rm*)"]);
	});

	test("with the compact arrays present the verbose table is reported, not read", () => {
		const planned = plan({
			"config.toml": [
				"[permission]",
				'deny = ["Bash(rm:*)"]',
				"[[permission.rules]]",
				'action = "allow"',
				'tool = "bash"',
				'pattern = "cargo"',
			].join("\n"),
		});
		// `parse_toml_permission_section` returns the arrays and never opens the
		// table. Importing both halves would put a rule in force here that the
		// source never applied.
		const notInForce = line(planned, "[permission] → rules");
		expect(notInForce?.action).toBe("skip");
		expect(notInForce?.detail).toContain("never opens this table");
		expect(writtenPermissions(planned).allow).toEqual([]);
		expect(writtenPermissions(planned).deny).toEqual(["Bash(rm*)"]);
	});

	test("an entry with no action costs the whole table, as it does in grok", () => {
		const planned = plan({
			"config.toml": [
				"[permission]",
				"[[permission.rules]]",
				'action = "allow"',
				'tool = "bash"',
				'pattern = "cargo"',
				"[[permission.rules]]",
				'tool = "bash"',
				'pattern = "ls"',
			].join("\n"),
		});
		// `RuleAction` defaults to `Deny` in Rust, but the field carries no
		// `#[serde(default)]` and the table is deserialized whole: the missing action
		// is not a deny, it is no rules at all. Reading it as a deny would put a
		// refusal in force here that the source never had.
		const unloaded = line(planned, "[permission] → rules");
		expect(unloaded?.action).toBe("skip");
		expect(unloaded?.detail).toContain("rules[1] has no action");
		expect(unloaded?.detail).toContain("none of them were in force");
		expect(writtenPermissions(planned).allow).toEqual([]);
		expect(writtenPermissions(planned).deny).toEqual([]);
	});

	test("an entry naming a tool the shape does not know costs the table too", () => {
		const planned = plan({
			"config.toml": [
				"[permission]",
				"[[permission.rules]]",
				'action = "deny"',
				'tool = "websearch"',
				'pattern = "x"',
			].join("\n"),
		});
		// `websearch` is not a `ToolFilter` variant, so it fails the whole
		// deserialization — the same all-or-nothing path as a missing action.
		expect(line(planned, "[permission] → rules")?.detail).toContain('not one this shape knows ("websearch")');
		expect(writtenPermissions(planned).deny).toEqual([]);
	});

	test("a verbose table is translated tool by tool", () => {
		const planned = plan({
			"config.toml": [
				"[[permission.rules]]",
				'action = "allow"',
				'tool = "bash"',
				'pattern = "sed"',
				"[[permission.rules]]",
				'action = "allow"',
				'tool = "edit"',
				'pattern = "//tmp/**"',
				"[[permission.rules]]",
				'action = "deny"',
				'tool = "mcp"',
				'pattern = "srv"',
			].join("\n"),
		});
		const permissions = writtenPermissions(planned);
		// A bash pattern with no wildcard is a prefix in grok and an exact match
		// here; grok's `edit` covers writes, and a rule here names one tool.
		expect(permissions.allow).toEqual(["Bash(sed*)", "Edit(//tmp/**)", "Write(//tmp/**)"]);
		expect(permissions.deny).toEqual(["mcp__srv"]);
		expect(line(planned, "[permission] → allow")?.detail).toContain("grok's `edit` covers writes");
	});

	test("a catch-all rule is refused rather than imported", () => {
		const planned = plan({
			"config.toml": ["[[permission.rules]]", 'action = "allow"', 'tool = "any"'].join("\n"),
		});
		// `Action::Any` with no pattern is every tool at once; grok drops exactly
		// these from its own `--allow`, and one here would allow the lot.
		expect(line(planned, "[permission]")?.detail).toContain("a catch-all rule");
		expect(writtenPermissions(planned).allow).toEqual([]);
	});

	test("a rule the engine here never consults is refused, domain prefix and all", () => {
		const planned = plan({ "config.toml": '[permission]\nallow = ["WebFetch(domain:example.com)"]\n' });
		const refused = planned.items.find((item) => item.detail.includes("not carried"));
		expect(refused?.detail).toContain("would be stored and never read");
		expect(refused?.detail).toContain("`domain:` means nothing");
		expect(writtenPermissions(planned).allow).toEqual([]);
	});

	test("prompt_policy is named and not imported", () => {
		const planned = plan({ "config.toml": '[permission]\nprompt_policy = "deny"\ndeny = ["Bash(rm:*)"]\n' });
		const named = line(planned, "[permission] → prompt_policy");
		expect(named?.action).toBe("skip");
		expect(named?.detail).toContain("grok does not read this key");
		// The rules beside it still came across, and the policy did not become a
		// mode: grok itself reports the key as unrecognized, so a session has been
		// running without it.
		expect(writtenPermissions(planned).deny).toEqual(["Bash(rm*)"]);
		expect(writtenSettings(planned).permissionMode).toBeUndefined();
	});

	test("an unknown key in the section is named", () => {
		const planned = plan({ "config.toml": '[permission]\ndeny = ["Bash(rm:*)"]\nprompt_polcy = "deny"\n' });
		// grok warns about a typo'd sub-key too, so that a misspelled rule cannot sit
		// there looking like it is in force. The report does the same.
		const named = line(planned, "prompt_polcy");
		expect(named?.action).toBe("skip");
		expect(named?.detail).toContain("no mapping");
	});

	test("a rules key that is not an array of tables is named", () => {
		const planned = plan({ "config.toml": '[permission]\nrules = "Bash(rm:*)"\n' });
		expect(line(planned, "[permission] → rules")?.detail).toContain("`rules` is not an array of tables");
	});
});

describe("the grok permission mode", () => {
	test("always-approve becomes bypass, named as the mode grok resolved", () => {
		const planned = plan({ "config.toml": '[ui]\npermission_mode = "always-approve"\n' });
		expect(writtenSettings(planned).permissionMode).toBe("bypassPermissions");
		expect(line(planned, 'ui.permission_mode ("always-approve")')?.to).toContain("permissionMode");
	});

	test("a name grok does not know is imported as what grok did with it", () => {
		const planned = plan({ "config.toml": '[ui]\npermission_mode = "plan"\n' });
		// `parse_permission_mode_canonical` sends everything it does not recognize to
		// ask, so a Claude Code mode name written here never auto-approved anything.
		// Carrying the name across would hand the user a mode grok never applied.
		expect(writtenSettings(planned).permissionMode).toBe("default");
		expect(line(planned, "ui.permission_mode")?.detail).toContain('grok resolves "plan" to "ask"');
	});

	test("auto keeps whatever mode the session would otherwise start in", () => {
		const planned = plan({ "config.toml": '[ui]\npermission_mode = "auto"\n' });
		expect(writtenSettings(planned).permissionMode).toBeUndefined();
		expect(line(planned, "ui.permission_mode")?.detail).toContain("classifier that approves");
	});

	test("yolo = false pins the mode to ask rather than leaving it unset", () => {
		const planned = plan({ "config.toml": "[ui]\nyolo = false\n" });
		// grok reads the presence of any of the three keys as a decision, so a
		// `false` is an explicit ask rather than an unset a remote default could fill.
		// `false` is not a reading of the key, so the label names the key rather than
		// a value — the decision it pinned is still the one grok makes.
		const claimed = line(planned, "ui.yolo");
		expect(claimed?.to).toContain("permissionMode");
		expect(claimed?.detail).toBe('mapped to "default"');
		// And the key that decided is not also reported as one that did not.
		expect(planned.items.filter((item) => item.from.includes("ui.yolo"))).toHaveLength(1);
	});

	test("a key in a shape grok does not read does not decide", () => {
		const planned = plan({ "config.toml": "[ui]\npermission_mode = 3\nyolo = true\n" });
		expect(writtenSettings(planned).permissionMode).toBe("bypassPermissions");
		expect(line(planned, "ui.permission_mode (3)")?.detail).toContain("only as a string");
	});

	test("a second spelling of the same decision is named when it would have differed", () => {
		const planned = plan({ "config.toml": '[ui]\npermission_mode = "ask"\napproval_mode = "always-approve"\n' });
		expect(writtenSettings(planned).permissionMode).toBe("default");
		expect(line(planned, "ui.approval_mode")?.detail).toContain('grok reads "permission_mode" first');
	});

	test("no mode key means no mode is claimed", () => {
		const planned = plan({ "config.toml": '[ui]\ntheme = "dark"\n' });
		expect(writtenSettings(planned).permissionMode).toBeUndefined();
		expect(planned.items.find((item) => item.to.includes("permissionMode"))).toBeUndefined();
	});

	test("the policy files beside config.toml are named and left alone", () => {
		const planned = plan({
			"config.toml": '[ui]\npermission_mode = "ask"\n',
			"requirements.toml": "[ui]\ndisable_bypass_permissions_mode = true\n",
		});
		const managed = line(planned, "requirements.toml");
		expect(managed?.action).toBe("skip");
		expect(managed?.detail).toContain("machine or organization policy");
		// The one thing that must not happen: an administrator's requirement
		// becoming the user's own setting, where it would outlive the policy.
		expect(writtenSettings(planned).disableBypassPermissionsMode).toBeUndefined();
	});
});
