/**
 * The tenth source: OpenCode.
 *
 * The one source in this repository whose rules were transcribed from its own
 * source tree rather than from its documentation, so the assertions below lean
 * on that tree's behaviour — the three XDG roots and the absence of a Windows
 * branch in `xdg-basedir@5.1.0`, all three settings documents parsed as JSONC,
 * the merge order, the four-way tool state, the compaction pair, and the
 * `~/.claude`/`~/.agents` trees OpenCode harvests that belong to other sources
 * here. Where a claim is about something the source does *not* do, the
 * assertion is negative on purpose: the reader must not read a credential, must
 * not import a skill twice, and must not create the database it opens.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectSources, runMigration } from "../src/migrate.ts";
import { parseJsonc, tildePath } from "../src/migrate-core.ts";
import { collectHistory, listHistory, readPromptHistory } from "../src/migrate-history.ts";
import { MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS } from "../src/migrate-types.ts";
import {
	readOpencodeConversation,
	readOpencodeSessionMessages,
	readOpencodeSessions,
	readOpencodeTableNames,
} from "../src/opencode-db.ts";
import {
	channelDatabaseNames,
	OPENCODE_CONFIG_DIR_ENV,
	OPENCODE_DIR_BASENAME,
	opencodeDatabasePath,
	opencodeLegacyTomlPath,
	opencodePromptHistoryFile,
	opencodeRoots,
	opencodeVendorTree,
	XDG_CONFIG_HOME_ENV,
	XDG_DATA_HOME_ENV,
	XDG_STATE_HOME_ENV,
} from "../src/opencode-home.ts";
import {
	describeOpencodeRoot,
	mergeOpencodeConfig,
	OPENCODE_CREDENTIAL_TABLES,
	OPENCODE_KEY_SPELLINGS,
	OPENCODE_UNREAD_FILES,
	readOpencode,
} from "../src/opencode-read.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

/**
 * Every variable that can move one of OpenCode's three roots.
 *
 * The four below are the whole reason this file needs one: OpenCode's roots come
 * from `OPENCODE_CONFIG_DIR` and the three `XDG_*_HOME` variables, and a
 * developer who exports any of them has a real tree this test never wrote. A test
 * that wants one sets it itself; everything else is deleted and then restored.
 */
const OPENCODE_ENV_VARS = [
	OPENCODE_CONFIG_DIR_ENV,
	XDG_CONFIG_HOME_ENV,
	XDG_DATA_HOME_ENV,
	XDG_STATE_HOME_ENV,
	"OPENCODE_DB",
] as const;

/**
 * Run `body` against a throwaway home seeded with `tree`.
 *
 * `seed` runs after the files exist, which is where the sqlite fixture is built:
 * a database cannot be expressed as a string in `tree`.
 */
function withHome(
	tree: SourceTree,
	body: (home: string) => void,
	seed?: (home: string) => void,
	env: Record<string, string | undefined> = {},
): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-opencode-"));
	const borrowed = new Map<string, string | undefined>(
		["USERPROFILE", "HOME", "APPDATA", ...OPENCODE_ENV_VARS].map((name) => [name, process.env[name]]),
	);
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		// `APPDATA` is not an OpenCode variable — it is the Cursor and Trae profile
		// directory, always set on Windows, and a real `Cursor\User` or `Trae\User`
		// there is read by `readSources` on every call this file makes.
		delete process.env.APPDATA;
		for (const name of OPENCODE_ENV_VARS) delete process.env[name];
		for (const [path, content] of Object.entries(tree)) {
			const full = join(home, path);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, content);
		}
		for (const [name, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		seed?.(home);
		body(home);
	} finally {
		for (const [name, value] of borrowed) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(home, { recursive: true, force: true });
	}
}

/** The config root as `xdg-basedir@5.1.0` spells it on this machine. */
function configPath(home: string, ...rest: string[]): string {
	return join(home, ".config", OPENCODE_DIR_BASENAME, ...rest);
}

/** The data root: `<home>/.local/share/opencode`, the other POSIX fallback. */
function dataPath(home: string, ...rest: string[]): string {
	return join(home, ".local", "share", OPENCODE_DIR_BASENAME, ...rest);
}

/** The state root, where the TUI's recall list lives. */
function statePath(home: string, ...rest: string[]): string {
	return join(home, ".local", "state", OPENCODE_DIR_BASENAME, ...rest);
}

const CONFIG = {
	provider: {
		gw: {
			name: "Gateway",
			env: ["GW_TOKEN"],
			options: { baseURL: "https://gw.example.invalid/v1" },
			models: { "qwen3-coder": { limit: { context: 65536, output: 32768 } } },
		},
	},
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe("the tenth source", () => {
	test("it is appended, so the nine before it keep their places", () => {
		// The list is append-only (`MIGRATION_SOURCE_IDS`) and its order is what
		// `detectSources` reports: reordering would silently change which of two
		// sources providing the same file wins. So the claim is the position and the
		// nine names above it, not "this is the last one".
		expect(MIGRATION_SOURCE_IDS.indexOf("opencode")).toBe(9);
		expect(MIGRATION_SOURCE_IDS.slice(0, 9)).toEqual([
			"claude-code",
			"codex",
			"zcode",
			"agents",
			"deepseek-harness",
			"grok-build",
			"kimi-code",
			"minimax-code",
			"step-code",
		]);
		expect(MIGRATION_SOURCE_LABELS.opencode).toBe("OpenCode");
	});

	test("the README names every source the importer knows", () => {
		// The one source list TypeScript cannot reach: `README.md` spells `--from`'s
		// values out in prose for a reader who is deciding before running anything.
		// Every other list in the repository is a `Record<MigrationSourceId, …>` that
		// a missing entry fails to compile, so this one needed something else — a test
		// that reads it, which makes a source registered without being documented
		// fail here rather than ship.
		const readme = readFileSync(resolve(import.meta.dir, "..", "..", "..", "README.md"), "utf8");
		const line = readme.split("\n").find((text) => text.includes("one source:"));
		expect(line).toBeDefined();
		// The names are compared as a set, not with `toContain`. A `toContain` per id
		// is satisfied by `opencodeX` just as well as by `opencode`, so a mistyped
		// name in the one list TypeScript cannot reach would ship green — which is
		// the whole failure this test exists to prevent.
		const listed = (line ?? "")
			.split("one source:")[1]
			.split("|")
			.map((name) => name.trim());
		expect([...listed].sort()).toEqual([...MIGRATION_SOURCE_IDS, "all"].sort());
	});
});

// ---------------------------------------------------------------------------
// Where the tree is
// ---------------------------------------------------------------------------

describe("opencode: where the tree is", () => {
	test("the default is the POSIX fallback on every platform, Windows included", () => {
		// `xdg-basedir@5.1.0` is pinned exactly by both of OpenCode's package.json
		// files and has no `process.platform` branch at all, so there is no
		// `%APPDATA%` spelling to fall back to. An importer written the way a Windows
		// importer is normally written reads nothing at all here and reports the
		// source as absent, which is indistinguishable from not having it installed.
		withHome({}, (home) => {
			const roots = opencodeRoots(home);
			expect(roots.config).toBe(join(home, ".config", "opencode"));
			expect(roots.data).toBe(join(home, ".local", "share", "opencode"));
			expect(roots.state).toBe(join(home, ".local", "state", "opencode"));
			expect(roots.configOrigin).toBe("default");
		});
	});

	test("detection finds a tree planted at the fallback, not at %APPDATA%", () => {
		withHome({ ".config/opencode/opencode.json": JSON.stringify(CONFIG) }, (home) => {
			expect(detectSources(home)).toEqual(["opencode"]);
		});
	});

	test("$OPENCODE_CONFIG_DIR names the opencode directory itself, with nothing appended", () => {
		// `Flag.OPENCODE_CONFIG_DIR ?? Path.config` (`core/src/global.ts:64`)
		// substitutes for the joined path, so a reader that appended `opencode` would
		// look one level too deep and find nothing.
		withHome({}, (home) => {
			const moved = join(home, "moved", "cfg");
			const roots = opencodeRootsWith(home, { [OPENCODE_CONFIG_DIR_ENV]: moved });
			expect(roots.config).toBe(moved);
			expect(roots.configOrigin).toBe("config-dir");
			// The override moves one root, not the install.
			expect(roots.data).toBe(join(home, ".local", "share", "opencode"));
		});
	});

	test("the XDG bases move their own root, and each says which rule decided it", () => {
		withHome({}, (home) => {
			const config = join(home, "xdg-config");
			const data = join(home, "xdg-data");
			const state = join(home, "xdg-state");
			const roots = opencodeRootsWith(home, {
				[XDG_CONFIG_HOME_ENV]: config,
				[XDG_DATA_HOME_ENV]: data,
				[XDG_STATE_HOME_ENV]: state,
			});
			expect(roots.config).toBe(join(config, "opencode"));
			expect(roots.data).toBe(join(data, "opencode"));
			expect(roots.state).toBe(join(state, "opencode"));
			expect(roots.configOrigin).toBe("xdg-config-home");
			expect(roots.dataOrigin).toBe("xdg-data-home");
			expect(roots.stateOrigin).toBe("xdg-state-home");
		});
	});

	test("an empty variable is a value opencode ignores, and whitespace is not", () => {
		// `xdg-basedir` reads `process.env.XDG_CONFIG_HOME || fallback`, so an empty
		// string is falsy and falls through. A whitespace string is truthy, and
		// trimming it here would read a directory OpenCode never opens. Reproduced
		// rather than tidied, for the same reason `$KIMI_CODE_HOME` is not trimmed.
		withHome({}, (home) => {
			expect(opencodeRootsWith(home, { [XDG_CONFIG_HOME_ENV]: "" }).config).toBe(join(home, ".config", "opencode"));
			const blank = opencodeRootsWith(home, { [XDG_CONFIG_HOME_ENV]: " " });
			expect(blank.config).toBe(join(" ", "opencode"));
			expect(blank.configOrigin).toBe("xdg-config-home");
		});
	});

	test("a value that is not absolute is used verbatim, not resolved", () => {
		// `xdg-basedir` joins without `resolve`, so a relative value resolves against
		// the process's working directory — which is where OpenCode would look too.
		// A reader that "helpfully" resolved it would read a different directory than
		// the tool does.
		withHome({}, (home) => {
			expect(opencodeRootsWith(home, { [XDG_DATA_HOME_ENV]: "relative/data" }).data).toBe(
				join("relative", "data", "opencode"),
			);
		});
	});

	test("the report says which rule put the config root where it is", () => {
		withHome({ ".config/opencode/opencode.json": JSON.stringify(CONFIG) }, (home) => {
			const result = runMigration({ home });
			const item = result.plan.items.find((i) => i.from === tildePath(home, configPath(home)));
			expect(item?.action).toBe("map");
			expect(item?.detail).toContain("no Windows branch");
		});
	});

	test("the report names the rule for the override and for each XDG base too", () => {
		// The default case's wording is the one worth spelling out, but the other
		// three are the ones a reader needs when the tree is *not* where they expect:
		// a bare path makes them look in the usual place. The enum is pinned by the
		// tests above; this pins the sentence each enum value turns into, which is
		// the part that actually reaches the reader.
		expect(describeOpencodeRoot("config-dir")).toContain("$OPENCODE_CONFIG_DIR");
		expect(describeOpencodeRoot("xdg-config-home")).toContain("$XDG_CONFIG_HOME");
		expect(describeOpencodeRoot("default")).toContain("no Windows branch");
	});

	test("a tree with sessions but no config root says so instead of claiming it looked", () => {
		// `core/src/global.ts:34-42` creates the config root at import time, so the
		// config root existing says the tool ran — but it says nothing about whether
		// there is anything *in* it, and a report that says "config root, resolved
		// as …" about a directory that is not there reads as a directory that was
		// found and found empty.
		withHome({ ".local/share/opencode/storage/session/info/old.json": "{}" }, (home) => {
			const result = runMigration({ home, from: "opencode" });
			const item = result.plan.items.find((i) => i.from === tildePath(home, configPath(home)));
			expect(item?.detail).toContain("does not exist");
			expect(item?.detail).toContain("still import");
		});
	});
});

/** `opencodeRoots` with variables set for the duration of one call. */
function opencodeRootsWith(home: string, env: Record<string, string | undefined>): ReturnType<typeof opencodeRoots> {
	const borrowed = Object.keys(env).map((name) => [name, process.env[name]] as [string, string | undefined]);
	try {
		for (const [name, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		return opencodeRoots(home);
	} finally {
		for (const [name, value] of borrowed) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

// ---------------------------------------------------------------------------
// The three settings documents
// ---------------------------------------------------------------------------

describe("opencode: the settings documents", () => {
	test("all three are JSONC, whatever their extension", () => {
		// `ConfigParse.jsonc` (`opencode/src/config/config.ts:240`) is applied to
		// `config.json`, `opencode.json` and `opencode.jsonc` alike, so `JSON.parse`
		// would reject a commented `opencode.json` and throw the whole document away
		// without a word.
		withHome(
			{
				".config/opencode/config.json": '{\n  // the first document\n  "model": "anthropic/claude-sonnet-5",\n}',
				".config/opencode/opencode.json": '{\n  "model": "anthropic/claude-opus-5", /* the second wins */\n}',
			},
			(home) => {
				const merge = mergeOpencodeConfig(configPath(home));
				expect(merge.errors).toEqual([]);
				expect(merge.config.model).toBe("anthropic/claude-opus-5");
			},
		);
	});

	test("a comment marker inside a string is not a comment", () => {
		// The classic failure of a regex-based stripper: a URL's `//` and a Windows
		// path's `\\` both look like comment starts. Two of the three documents in
		// real OpenCode installs hold a `baseURL`, so this is not hypothetical.
		const parsed = parseJsonc(
			'{\n  "a": "https://gw.example.invalid/v1",\n  "b": "C:\\\\Users\\\\me",\n  "c": "a, }",\n  /* gone */\n  "d": 1,\n}',
		);
		expect(parsed.a).toBe("https://gw.example.invalid/v1");
		expect(parsed.b).toBe("C:\\Users\\me");
		// A trailing comma is dropped, and only where one is really a trailing comma:
		// inside a string value, a comma before a brace is just a comma.
		expect(parsed.c).toBe("a, }");
		expect(parsed.d).toBe(1);
	});

	test("the three documents merge in opencode's order, later winning key by key", () => {
		// `config.ts:272-274` calls `mergeConfig` — a `mergeDeep` — three times in
		// that order, and `mergeDeep` merges objects key by key while replacing
		// everything else. A spread would let the last document's `mcp` block
		// wholesale replace the first's, keeping one server where OpenCode keeps two.
		withHome(
			{
				".config/opencode/config.json": JSON.stringify({
					mcp: { first: { type: "remote", url: "https://one.invalid/mcp" } },
					model: "anthropic/claude-sonnet-5",
				}),
				".config/opencode/opencode.jsonc": JSON.stringify({
					mcp: { second: { type: "remote", url: "https://two.invalid/mcp" } },
					model: "anthropic/claude-opus-5",
				}),
			},
			(home) => {
				const merge = mergeOpencodeConfig(configPath(home));
				expect(Object.keys(merge.config.mcp as Record<string, unknown>)).toEqual(["first", "second"]);
				expect(merge.config.model).toBe("anthropic/claude-opus-5");
			},
		);
	});

	test("a document that lost its keys is named, because the file still holds them", () => {
		withHome(
			{
				".config/opencode/config.json": JSON.stringify({ model: "anthropic/claude-sonnet-5", mode: "build" }),
				".config/opencode/opencode.json": JSON.stringify({ model: "anthropic/claude-opus-5" }),
			},
			(home) => {
				const merge = mergeOpencodeConfig(configPath(home));
				expect(merge.shadowed).toEqual([{ path: configPath(home, "opencode.json"), keys: ["model"] }]);
			},
		);
	});

	test("a document that does not parse is a report line, not a document that vanishes", () => {
		// The reader parses rather than using `readJsonc`, whose catch would return
		// `{}` and leave a sibling document quietly carrying a report that claims to
		// describe the merged result.
		withHome(
			{
				".config/opencode/config.json": "{ this is not json",
				".config/opencode/opencode.json": JSON.stringify(CONFIG),
			},
			(home) => {
				const merge = mergeOpencodeConfig(configPath(home));
				expect(merge.from).toEqual([configPath(home, "opencode.json")]);
				expect(merge.errors).toEqual([
					{ path: configPath(home, "config.json"), reason: "config.json is not parseable as JSON with comments" },
				]);
				const result = runMigration({ home });
				const item = result.plan.items.find((i) => i.from.endsWith("config.json"));
				expect(item?.action).toBe("skip");
				expect(item?.detail).toContain("this report is missing whatever it held");
			},
		);
	});

	test("the pre-JSON TOML file is named, never opened", () => {
		// `config.ts:276-289` folds it into `config.json` and **deletes** it, so a
		// machine that still has one has not run a current build. Reading it would
		// mean a TOML parser this repository has no other use for.
		withHome(
			{ ".config/opencode/config": 'model = "anthropic/claude-sonnet-5"\n', ".config/opencode/opencode.json": "{}" },
			(home) => {
				expect(opencodeLegacyTomlPath(configPath(home))).toBe(configPath(home, "config"));
				expect(readOpencode(home).legacyToml).toBe(true);
				const result = runMigration({ home });
				const item = result.plan.items.find(
					(i) => i.from === tildePath(home, opencodeLegacyTomlPath(configPath(home))),
				);
				expect(item?.action).toBe("skip");
				expect(item?.detail).toContain("has not run a current build");
			},
		);
	});
});

// ---------------------------------------------------------------------------
// Assets, and the trees that belong to another source
// ---------------------------------------------------------------------------

describe("opencode: assets", () => {
	const SKILL = "---\nname: pdf\ndescription: PDFs\n---\n\nBody.\n";

	test("both spellings of every asset directory are read, not just the singular one", () => {
		// Each kind's pair is two directories in OpenCode's own spelling
		// (`skill/index.ts:24` for skills, and the same shape for agents and
		// commands). A test that plants only `skill/` passes just as well against a
		// reader that knows only `skill/`, which is the whole risk in a pair.
		withHome(
			{
				".config/opencode/skill/one/SKILL.md": "---\nname: one\ndescription: One\n---\n\nOne.\n",
				".config/opencode/skills/two/SKILL.md": "---\nname: two\ndescription: Two\n---\n\nTwo.\n",
				".config/opencode/agent/a.md": "Agent A.\n",
				".config/opencode/agents/b.md": "Agent B.\n",
				".config/opencode/command/c.md": "Command C.\n",
				".config/opencode/commands/d.md": "Command D.\n",
			},
			(home) => {
				const raw = readOpencode(home);
				expect(raw.skills.map((s) => s.name).sort()).toEqual(["one", "two"]);
				expect(raw.agents.map((a) => a.sourcePath.replace(/\\/g, "/"))).toEqual([
					expect.stringContaining("/agent/a.md"),
					expect.stringContaining("/agents/b.md"),
				]);
				expect(raw.commands.files.map((f) => f.sourcePath.replace(/\\/g, "/"))).toEqual([
					expect.stringContaining("/command/c.md"),
					expect.stringContaining("/commands/d.md"),
				]);
			},
		);
	});

	test("a skill under {skill,skills} is imported, and its directory travels whole", () => {
		withHome(
			{
				".config/opencode/skill/pdf/SKILL.md": SKILL,
				".config/opencode/skill/pdf/references/api.md": "# api",
				".config/opencode/skill/pdf/scripts/run.ts": "export {}",
			},
			(home) => {
				const result = runMigration({ home });
				const write = result.plan.writes.find((w) => w.path === join(home, ".labunbun", "skills", "pdf", "SKILL.md"));
				expect(write?.content).toContain("Body.");
				// The exact `join`, not a `endsWith` on a forward-slash tail: the plan
				// builds its paths with `join`, so on Windows a `endsWith("references/api.md")`
				// is false for a write that landed correctly — a test that only passes on
				// one platform's separator is not pinning the destination.
				const reference = result.plan.writes.find(
					(w) => w.path === join(home, ".labunbun", "skills", "pdf", "references", "api.md"),
				);
				expect(reference?.content).toBe("# api");
				const script = result.plan.writes.find(
					(w) => w.path === join(home, ".labunbun", "skills", "pdf", "scripts", "run.ts"),
				);
				expect(script?.content).toBe("export {}");
			},
		);
	});

	test("opencode's ~/.claude and ~/.agents harvests are not imported a second time", () => {
		// `opencode/src/skill/index.ts:21-22,190-194` scans `~/.claude` and
		// `~/.agents` for skills whatever the config says. Copying what it found
		// would land a second copy of every skill the user has, attributed to the
		// wrong tool — the failure `GROK_VENDOR_DIRS` exists to prevent in grok's
		// reader, and the same rule for the same reason.
		withHome(
			{
				".config/opencode/skill/mine/SKILL.md": SKILL,
				".claude/skills/theirs/SKILL.md": "---\nname: theirs\n---\n\nNot mine.\n",
				".agents/skills/als/theirs/SKILL.md": "---\nname: theirs\n---\n\nNot mine either.\n",
			},
			(home) => {
				const raw = readOpencode(home);
				// `pdf`, not `mine`: the directory the file was found in and the name
				// OpenCode will invoke it by are different keys
				// (`packages/core/src/skill.ts:87-92` takes the frontmatter's, and
				// `skills.ts:29` on our side does the same), and this fixture is the one
				// place where that difference is visible. Asserting `mine` would pin a
				// directory-name rule neither program has.
				expect(raw.skills.map((skill) => skill.name)).toEqual(["pdf"]);
				const result = runMigration({ home });
				const names = result.plan.items.filter((i) => i.from === "~/.claude, ~/.agents");
				expect(names).toHaveLength(1);
				expect(names[0].detail).toContain("does not copy them a second time");
				expect(names[0].detail).toContain("claude-code and agents source");
			},
		);
	});

	test("a skills.paths entry pointing into another source's tree is excluded the same way", () => {
		// The exclusion has to run over the paths, not over the scan results, or a
		// directory the user named by hand slips past a rule that only ever saw
		// OpenCode's own trees.
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({ skills: { paths: ["~/.claude/skills"] } }),
				".claude/skills/theirs/SKILL.md": "---\nname: theirs\n---\n\nNot mine.\n",
			},
			(home) => {
				const raw = readOpencode(home);
				expect(raw.extraSkillPaths).toEqual([join(home, ".claude", "skills")]);
				expect(raw.skills).toEqual([]);
			},
		);
	});

	test("the vendor rule names a path by the tree it sits in", () => {
		expect(opencodeVendorTree(join("C:", "Users", "me", ".claude", "skills", "x", "SKILL.md"))).toBe(".claude");
		expect(opencodeVendorTree(join("C:", "Users", "me", ".agents", "AGENTS.md"))).toBe(".agents");
		expect(opencodeVendorTree(join("C:", "Users", "me", ".config", "opencode", "skill"))).toBeNull();
	});

	test("a markdown command file becomes a skill, and its skips are named", () => {
		withHome(
			{ ".config/opencode/command/review.md": "Look at the diff.\n", ".config/opencode/command/README.md": "notes" },
			(home) => {
				const result = runMigration({ home });
				const write = result.plan.writes.find(
					(w) => w.path === join(home, ".labunbun", "skills", "review", "SKILL.md"),
				);
				expect(write?.content).toContain("Look at the diff.");
				// The skip is one batched line labelled by the config root, not one per
				// file, so the file is named in the detail rather than in `from`.
				const skip = result.plan.items.find(
					(i) => i.from === `${tildePath(home, configPath(home))} → command` && i.action === "skip",
				);
				expect(skip?.detail).toContain("README.md (a README, not a command)");
			},
		);
	});

	test("an agent markdown file under {agent,agents} lands in the agents directory", () => {
		withHome({ ".config/opencode/agent/reviewer.md": "You review code.\n" }, (home) => {
			const result = runMigration({ home });
			expect(result.plan.writes.some((w) => w.path === join(home, ".labunbun", "agents", "reviewer.md"))).toBe(true);
		});
	});

	test("an agent nested under {agent,agents} is found, and the nesting becomes a dash", () => {
		// `agent`/`agents` is read **recursively** while `mode`/`modes` is read one
		// level deep (`packages/core/src/config/plugin/agent.ts:21-24`), so a
		// one-level reader misses this file and finds the `modes/` one it should not.
		// v2's own name for the agent is `build/plan` (`agent.ts:156-160`); this
		// importer writes one file per agent into a flat directory, so the separator
		// becomes a dash. The `.md` stays, because the target path is built from the
		// name and a one-level `agent/reviewer.md` already landed at `reviewer.md`.
		withHome({ ".config/opencode/agent/build/plan.md": "You plan the build.\n" }, (home) => {
			const result = runMigration({ home });
			const write = result.plan.writes.find((w) => w.path === join(home, ".labunbun", "agents", "build-plan.md"));
			expect(write?.content).toContain("You plan the build.");
		});
	});

	test("a mode file is forced to a primary agent, and the report says so", () => {
		// `mode`/`modes` is v1's spelling of a primary agent and v2 still reads it,
		// forcing `mode: "primary"` on whatever is in there (`agent.ts:173`). That is
		// the difference between a subagent the model spawns and a top-level choice
		// the user picks, so it is worth a sentence rather than a silent copy.
		withHome({ ".config/opencode/mode/plan.md": "You plan.\n" }, (home) => {
			const result = runMigration({ home });
			const write = result.plan.writes.find((w) => w.path === join(home, ".labunbun", "agents", "plan.md"));
			expect(write?.content).toContain("You plan.");
			const item = result.plan.items.find(
				(i) => i.to === tildePath(home, join(home, ".labunbun", "agents", "plan.md")),
			);
			expect(item?.detail).toContain("primary agent");
		});
	});

	test("a file nested under mode/modes is not an agent, because opencode reads that one level only", () => {
		// The other half of the same line: recursion is the difference between the
		// two directory pairs, so a reader that recurses everywhere imports a file
		// OpenCode will never run.
		withHome({ ".config/opencode/modes/build/plan.md": "You plan.\n" }, (home) => {
			const result = runMigration({ home });
			expect(result.plan.writes.some((w) => w.path === join(home, ".labunbun", "agents", "build-plan.md"))).toBe(false);
		});
	});

	test("an agent's own `model:` frontmatter travels with a note, not silently", () => {
		// The name resolves when the subagent starts and falls back to the session
		// model if it no longer names one, so a copy that says nothing about it reads
		// as though the model had been carried over.
		withHome({ ".config/opencode/agent/fast.md": "---\nmodel: some/model-id\n---\n\nYou are quick.\n" }, (home) => {
			const result = runMigration({ home });
			const write = result.plan.writes.find((w) => w.path === join(home, ".labunbun", "agents", "fast.md"));
			expect(write?.content).toContain("some/model-id");
			const item = result.plan.items.find(
				(i) => i.to === tildePath(home, join(home, ".labunbun", "agents", "fast.md")),
			);
			expect(item?.detail).toContain("some/model-id");
		});
	});

	test("a bare markdown file at the top of a skill directory is a skill of its own", () => {
		// One of the two arms of the glob (`packages/core/src/skill.ts:79`): `*.md`
		// directly in the directory. A reader that only looks inside subdirectories
		// for a `SKILL.md` never sees one, and the file then goes unmentioned.
		withHome({ ".config/opencode/skill/pdf.md": "Handle PDFs.\n" }, (home) => {
			const result = runMigration({ home });
			const write = result.plan.writes.find((w) => w.path === join(home, ".labunbun", "skills", "pdf", "SKILL.md"));
			expect(write?.content).toContain("Handle PDFs.");
		});
	});

	test("a nested SKILL.md with no `name:` is a file opencode drops too, and the report says which", () => {
		// `skill.ts:87-92`: with no `name:` in the frontmatter the only fallback is
		// the file's own basename, and that one is available **only** when the file
		// sits directly in the source directory. Nested, there is no name and
		// `if (!name) continue` takes it. Importing it would hand over something the
		// user cannot run in OpenCode either.
		withHome({ ".config/opencode/skill/pdf/SKILL.md": "---\ndescription: PDFs\n---\n\nBody.\n" }, (home) => {
			const raw = readOpencode(home);
			expect(raw.skills).toEqual([]);
			expect(raw.unnamedSkills).toEqual([join(home, ".config", "opencode", "skill", "pdf", "SKILL.md")]);
			const result = runMigration({ home });
			const skip = result.plan.items.find((i) => i.action === "skip" && i.detail.includes("opencode does not load"));
			expect(skip?.detail).toContain("add a `name:` to it");
		});
	});

	test("a top-level markdown file with no frontmatter at all is still a skill, named by its own name", () => {
		// The other half: OpenCode's fallback is the basename for a top-level file
		// whether or not the frontmatter parsed, so an importer that required a
		// `name:` would drop a skill the user can run today.
		withHome({ ".config/opencode/skill/plain.md": "Just text.\n" }, (home) => {
			const raw = readOpencode(home);
			expect(raw.skills.map((skill) => skill.name)).toEqual(["plain"]);
		});
	});

	test("a bare markdown file does not pick up the skills standing beside it", () => {
		// A bare `<dir>/<name>.md` has the source directory as its directory, so a
		// supporting-file scan rooted there would copy every other skill's files —
		// and their `SKILL.md` files with them, since only a scan's own top level
		// excludes that name. The result would be one skill's directory holding
		// another's text.
		withHome(
			{
				".config/opencode/skill/bare.md": "Just text.\n",
				".config/opencode/skill/other/SKILL.md": "---\nname: other\n---\n\nBody.\n",
				".config/opencode/skill/other/reference.md": "# api",
			},
			(home) => {
				const result = runMigration({ home });
				const paths = result.plan.writes.map((w) => w.path);
				expect(paths).toContain(join(home, ".labunbun", "skills", "bare", "SKILL.md"));
				expect(paths).toContain(join(home, ".labunbun", "skills", "other", "reference.md"));
				// `other`'s files must not have been written into `bare`'s directory.
				expect(paths).not.toContain(join(home, ".labunbun", "skills", "bare", "reference.md"));
			},
		);
	});

	test("a SKILL.md two directories down is a skill, because the glob says any depth", () => {
		withHome({ ".config/opencode/skill/a/b/SKILL.md": "---\nname: deep\n---\n\nBody.\n" }, (home) => {
			const result = runMigration({ home });
			const write = result.plan.writes.find((w) => w.path === join(home, ".labunbun", "skills", "deep", "SKILL.md"));
			expect(write?.content).toContain("Body.");
		});
	});

	test("a two-deep SKILL.md with no `name:` is still not a skill, and is still named", () => {
		// The name fallback is keyed on the **source** directory, not on how far
		// down the file is, so depth does not rescue it.
		withHome({ ".config/opencode/skill/a/b/SKILL.md": "---\ndescription: deep\n---\n\nBody.\n" }, (home) => {
			const raw = readOpencode(home);
			expect(raw.skills).toEqual([]);
			expect(raw.unnamedSkills).toHaveLength(1);
		});
	});

	test("AGENTS.md here is opencode's own document, not ~/.agents/AGENTS.md", () => {
		// Two different files in two different trees. The `agents` source reads
		// `~/.agents/AGENTS.md`; this one is `<config>/AGENTS.md`, and importing both
		// is importing two pieces of writing, not a duplicate.
		withHome({ ".config/opencode/AGENTS.md": "OpenCode's own rules.\n" }, (home) => {
			const result = runMigration({ home });
			const write = result.plan.writes.find((w) => w.path.endsWith("imported-opencode.md"));
			expect(write?.content).toContain("OpenCode's own rules.");
		});
	});

	test("a directory nothing reads out of is named with its entry count", () => {
		withHome({ ".config/opencode/cache/one.json": "{}", ".config/opencode/cache/two.json": "{}" }, (home) => {
			const result = runMigration({ home });
			const item = result.plan.items.find((i) => i.from === tildePath(home, configPath(home, "cache")));
			expect(item?.detail).toContain("2 entries this importer reads nothing out of");
		});
	});

	test("a directory and a file are each reported once, and not as each other", () => {
		// One listing feeds two answers, and the two can disagree: a `cache/`
		// directory reported as both "nothing reads out of it" and "a file with no
		// mapping" reads as two things wrong with a tree that has one thing in it,
		// and a directory called `tokens` named as a credential file sends the user
		// looking for a secret that was never there.
		withHome(
			{
				".config/opencode/cache/one.json": "{}",
				".config/opencode/skill/pdf/SKILL.md": SKILL,
				".config/opencode/AGENTS.md": "rules\n",
				".config/opencode/tokens/notes.md": "not a secret\n",
				".config/opencode/stray.md": "# stray\n",
				".config/opencode/opencode.json": "{}",
			},
			(home) => {
				const result = runMigration({ home });
				const unmapped = result.plan.items.filter((i) => i.detail.includes("no mapping for"));
				// The asset directory is read, so it is in neither answer.
				expect(result.plan.items.some((i) => i.from === tildePath(home, configPath(home, "skill")))).toBe(false);
				// `AGENTS.md` is read too, so it is not a file with no mapping.
				expect(unmapped.some((i) => i.from.includes("AGENTS.md"))).toBe(false);
				// The one genuinely stray file is named, and it is the only one.
				expect(unmapped).toHaveLength(1);
				expect(unmapped[0].from).toContain("stray.md");
				// A *directory* called `tokens` matched the credential-name pattern and
				// is still reported as a directory, never as a credential file: the user
				// would otherwise go looking for a secret that was never there.
				expect(result.plan.items.some((i) => i.from === tildePath(home, configPath(home, "tokens")))).toBe(true);
				expect(result.plan.items.some((i) => i.detail.startsWith("credentials:"))).toBe(false);
			},
		);
	});

	test("tui.json, tui.jsonc and plugin-meta.json are named for what they are", () => {
		// All three planted, so the loop below is pinned by the table rather than by
		// a hand-copied pair that would keep passing if a fourth entry were added.
		withHome(
			{
				".config/opencode/tui.json": "{}",
				".config/opencode/tui.jsonc": "{}",
				".config/opencode/plugin-meta.json": "{}",
				".config/opencode/opencode.json": "{}",
			},
			(home) => {
				const result = runMigration({ home });
				for (const name of Object.keys(OPENCODE_UNREAD_FILES)) {
					expect(result.plan.items.some((i) => i.from === tildePath(home, configPath(home, name)))).toBe(true);
				}
			},
		);
	});

	test("a name in the unread table is not claimed when the install has no such file", () => {
		withHome({ ".config/opencode/opencode.json": "{}" }, (home) => {
			const result = runMigration({ home });
			expect(Object.keys(OPENCODE_UNREAD_FILES).length).toBeGreaterThan(0);
			expect(result.plan.items.some((i) => i.from === tildePath(home, configPath(home, "tui.json")))).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// Providers, MCP, permissions
// ---------------------------------------------------------------------------

describe("opencode: providers, MCP and permissions", () => {
	test("a provider's key is read from the variable it names, and its endpoint is registered", () => {
		withHome({ ".config/opencode/opencode.json": JSON.stringify(CONFIG) }, (home) => {
			const result = runMigration({ home });
			const settings = JSON.parse(
				result.plan.writes.find((w) => w.path.endsWith("settings.json"))?.content ?? "{}",
			) as {
				providers: { openaiCompatible: Array<{ id: string; baseUrl: string; apiKeyEnv: string; models: unknown[] }> };
			};
			// An array, not a table keyed by id: `settings.ts:157` types
			// `openaiCompatible` as `z.array(...)`, so the assertion has to look the
			// entry up by its `id` rather than reach for a property.
			const provider = settings.providers.openaiCompatible.find((p) => p.id === "gw");
			expect(provider?.baseUrl).toBe("https://gw.example.invalid/v1");
			expect(provider?.apiKeyEnv).toBe("GW_TOKEN");
			expect(provider?.models).toHaveLength(1);
		});
	});

	test("the first nameable variable in `env` is the one used", () => {
		// `env` is an array, so "the variable it names" is a question about order.
		// The first entry that is actually a variable name wins — not the last entry,
		// and not the first entry whatever it is: a config whose first entry is
		// `${file:./key.txt}` names a *file*, and writing that into `apiKeyEnv` would
		// produce a setting this build cannot use.
		//
		// The nameable entry sits in the *middle* on purpose. With it last, "the last
		// entry" and "the first nameable entry" name the same thing and the assertion
		// cannot tell the two rules apart — which is the only reason this array has
		// three entries and not two.
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					provider: {
						gw: {
							// biome-ignore lint/suspicious/noTemplateCurlyInString: REAL_TOKEN between the two is the control, so the refs must stay literal
							env: ["${file:./key.txt}", "REAL_TOKEN", "${file:./other.txt}"],
							options: { baseURL: "https://gw.example.invalid/v1" },
							models: { m: { limit: { context: 1000 } } },
						},
					},
				}),
			},
			(home) => {
				const result = runMigration({ home });
				const settings = JSON.parse(
					result.plan.writes.find((w) => w.path.endsWith("settings.json"))?.content ?? "{}",
				) as { providers: { openaiCompatible: Array<{ id: string; apiKeyEnv: string }> } };
				expect(settings.providers.openaiCompatible.find((p) => p.id === "gw")?.apiKeyEnv).toBe("REAL_TOKEN");
			},
		);
	});

	test("an inline apiKey is reported by the fact that one is there, and never copied", () => {
		// Writing it into settings.json would move a credential out of the file the
		// user chose to keep it in and into one this migration writes — not a thing a
		// migration should do to a secret nobody asked it to touch. So the provider
		// is registered against a derived variable and the key stays put.
		const secret = "sk-opencode-inline-DO-NOT-LEAK";
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					provider: {
						gw: {
							options: { baseURL: "https://gw.example.invalid/v1", apiKey: secret },
							models: { m: { limit: { context: 1000 } } },
						},
					},
				}),
			},
			(home) => {
				const result = runMigration({ home });
				const settings = JSON.parse(
					result.plan.writes.find((w) => w.path.endsWith("settings.json"))?.content ?? "{}",
				) as { providers: { openaiCompatible: Array<{ id: string; apiKeyEnv: string }> } };
				expect(settings.providers.openaiCompatible.find((p) => p.id === "gw")?.apiKeyEnv).toBe("GW_API_KEY");
				const item = result.plan.items.find((i) => i.from.endsWith("options.apiKey"));
				expect(item?.action).toBe("skip");
				expect(item?.detail).toContain("the key itself was left where you put it");
				expect(result.report).not.toContain(secret);
			},
		);
	});

	test("a provider with no baseURL is named, because opencode resolves one from its npm package", () => {
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					provider: {
						bundled: { npm: "@ai-sdk/anthropic", models: { "claude-sonnet-5": { limit: { context: 200000 } } } },
					},
				}),
			},
			(home) => {
				const result = runMigration({ home });
				const item = result.plan.items.find((i) => i.from.includes("provider.bundled"));
				expect(item?.action).toBe("skip");
				expect(item?.detail).toContain("resolves a provider's endpoint through its npm package");
			},
		);
	});

	test("a model with no context limit is named rather than registered as unusable", () => {
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					provider: { gw: { options: { baseURL: "https://gw.invalid/v1" }, models: { m: {} } } },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				expect(
					result.plan.items.some(
						(i) => i.detail === "it states no context limit, and a provider entry here has to carry one",
					),
				).toBe(true);
			},
		);
	});

	test("a local MCP server's command array is split into command and args", () => {
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					mcp: { files: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				const mcp = JSON.parse(result.plan.writes.find((w) => w.path.endsWith(".mcp.json"))?.content ?? "{}") as {
					mcpServers: Record<string, { type: string; command: string; args: string[] }>;
				};
				expect(mcp.mcpServers.files).toEqual({
					type: "stdio",
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
				});
			},
		);
	});

	test("an MCP entry that names neither transport is named as such", () => {
		withHome({ ".config/opencode/opencode.json": JSON.stringify({ mcp: { odd: { command: "run-me" } } }) }, (home) => {
			const result = runMigration({ home });
			const item = result.plan.items.find((i) => i.from.includes("mcp.odd"));
			expect(item?.action).toBe("skip");
			expect(item?.detail).toContain("names neither of opencode's two transports");
		});
	});

	test("an MCP key this build's server shape has no field for is named, not dropped", () => {
		// The two transports' *expected* keys each get their own note above; a key
		// nobody expected is a different case, and dropping it is the silent loss
		// this importer exists to prevent. Both arms, because the two branches are
		// separate code and one of them reporting is not the other one reporting.
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					mcp: {
						near: { type: "local", command: ["run-me"], somethingNew: true },
						far: { type: "remote", url: "https://mcp.example.invalid/sse", somethingNew: true },
					},
				}),
			},
			(home) => {
				const result = runMigration({ home });
				for (const name of ["mcp.near", "mcp.far"]) {
					const item = result.plan.items.find((i) => i.from.includes(name));
					expect(item?.action).toBe("downgrade");
					expect(item?.detail).toContain("somethingNew");
				}
			},
		);
	});

	test("a permission that stops to ask is counted and written as neither an allow nor a deny", () => {
		// There is no ask tier here, and an allow would run exactly the calls the
		// user meant to be prompted for. The same call grok's plan makes for its own
		// ask tier, and for the same reason.
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					permission: { bash: { "git push *": "ask", "git status": "allow" }, edit: "deny" },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				const settings = JSON.parse(
					result.plan.writes.find((w) => w.path.endsWith("settings.json"))?.content ?? "{}",
				) as { permissions: { allow: string[]; deny: string[] } };
				expect(settings.permissions.allow).toEqual(["Bash(git status)"]);
				expect(settings.permissions.deny).toEqual(["Edit"]);
				const asked = result.plan.items.find((i) => i.detail.includes("would stop and ask about"));
				expect(asked?.action).toBe("skip");
				expect(asked?.detail).toContain("left out of both lists");
			},
		);
	});

	test("a bare action normalises to the whole block, as opencode's own normaliser does", () => {
		withHome({ ".config/opencode/opencode.json": JSON.stringify({ permission: "deny" }) }, (home) => {
			const result = runMigration({ home });
			const settings = JSON.parse(
				result.plan.writes.find((w) => w.path.endsWith("settings.json"))?.content ?? "{}",
			) as { permissions: { deny: string[] } };
			// `"*"`, not a list of every tool name: `permissions.ts:356` reads a rule
			// whose tool name is `*` as matching every tool, which is exactly what
			// opencode's `{"*": "deny"}` means. Enumerating the tools here would be a
			// second list to keep in step with the tool set, and would go stale the
			// first time a tool is added.
			expect(settings.permissions.deny).toEqual(["*"]);
		});
	});

	test("a permission key this build has no tool for is named with what it governed", () => {
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					permission: { external_directory: "deny", todowrite: "allow" },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				expect(
					result.plan.items.some(
						(i) => i.from.includes("external_directory") && i.detail.includes("outside the working directory"),
					),
				).toBe(true);
				expect(result.plan.items.some((i) => i.from.includes("todowrite") && i.detail.includes("TodoWrite"))).toBe(
					true,
				);
			},
		);
	});

	test("a key with nowhere to go is named, and the file keeps it", () => {
		withHome({ ".config/opencode/opencode.json": JSON.stringify({ autoupdate: true, layout: "wide" }) }, (home) => {
			const result = runMigration({ home });
			expect(result.plan.items.some((i) => i.from.endsWith("autoupdate") && i.detail.includes("updates itself"))).toBe(
				true,
			);
			expect(result.plan.items.some((i) => i.from.endsWith("layout") && i.detail.includes("TUI's layout"))).toBe(true);
		});
	});

	test("a key this build has never heard of is named too", () => {
		// `autoupdate` and `layout` each have a line written for them, so they say
		// nothing about the general case. A key OpenCode grows after this importer
		// was written reaches the reader through `reportUnhandledKeys` and nothing
		// else, so that path is pinned with a key no line mentions.
		withHome({ ".config/opencode/opencode.json": JSON.stringify({ some_key_from_the_future: { a: 1 } }) }, (home) => {
			const result = runMigration({ home });
			const item = result.plan.items.find((i) => i.from.endsWith("some_key_from_the_future"));
			expect(item?.action).toBe("skip");
			expect(item?.detail).toContain("no mapping for");
		});
	});
});

// ---------------------------------------------------------------------------
// The v2 config surface
// ---------------------------------------------------------------------------

/**
 * The same three settings written both ways: the ones that produce **writes**.
 *
 * Only `provider`, `mcp` and `permission` are here, and the omission is the point
 * rather than an oversight — the other five renamed keys produce report lines and
 * no file, so a comparison of writes cannot see them and they are pinned by their
 * own tests below. What this pair is for is the one question a v2 user cares
 * about: does the same config import the same thing under either spelling.
 */
function v1WrittenConfig(): Record<string, unknown> {
	return {
		provider: {
			gw: { options: { baseURL: "https://gw.example.invalid/v1" }, models: { m: { limit: { context: 1000 } } } },
		},
		mcp: {
			files: { type: "local", command: ["run-me", "--flag"] },
			far: { type: "remote", url: "https://m.invalid/mcp" },
		},
		permission: { bash: { "git push *": "allow" }, read: "deny" },
	};
}

function v2WrittenConfig(): Record<string, unknown> {
	return {
		providers: v1WrittenConfig().provider,
		mcp: { servers: v1WrittenConfig().mcp },
		permissions: [
			{ action: "bash", resource: "git push *", effect: "allow" },
			{ action: "read", resource: "*", effect: "deny" },
		],
	};
}

/** What the migration actually produced, with the report's own spelling left out. */
function planOutput(result: ReturnType<typeof runMigration>): { settings: unknown; mcp: unknown } {
	return {
		settings: JSON.parse(result.plan.writes.find((w) => w.path.endsWith("settings.json"))?.content ?? "{}"),
		mcp: JSON.parse(result.plan.writes.find((w) => w.path.endsWith(".mcp.json"))?.content ?? "{}"),
	};
}

function runWithConfig(config: Record<string, unknown>): ReturnType<typeof runMigration> {
	let out: ReturnType<typeof runMigration> | undefined;
	withHome({ ".config/opencode/opencode.json": JSON.stringify(config) }, (home) => {
		out = runMigration({ home });
	});
	if (out === undefined) throw new Error("withHome did not run the body");
	return out;
}

describe("opencode: the v2 config surface", () => {
	/**
	 * The load-bearing test of this block: the same settings, spelled both ways,
	 * import the same thing.
	 *
	 * A reader that ignored a v2 key entirely would also produce identical writes
	 * for the two documents — so this is only a real check because the v1 arm is
	 * known to import, which the assertions below pin separately. Read together
	 * they say "v2 imports what v1 imports" rather than "both import nothing".
	 */
	test("the same settings under v2's spellings import exactly what v1's spellings do", () => {
		const v1 = runWithConfig(v1WrittenConfig());
		const v2 = runWithConfig(v2WrittenConfig());
		expect(planOutput(v2)).toEqual(planOutput(v1));
		// …and the v1 arm is not vacuous. Without this the test is satisfied by both
		// documents importing nothing, which is the one outcome it must not accept.
		const settings = planOutput(v1).settings as {
			providers: { openaiCompatible: Array<{ id: string }> };
			permissions: { allow: string[]; deny: string[]; additionalDirectories: string[] };
		};
		expect(settings.providers.openaiCompatible.map((p) => p.id)).toEqual(["gw"]);
		// `additionalDirectories` is always written alongside the two lists
		// (`migrate.ts:808-817`), so it is part of the expected value rather than
		// something to leave out and call equal.
		expect(settings.permissions).toEqual({
			allow: ["Bash(git push *)"],
			deny: ["Read"],
			additionalDirectories: [],
		});
		const servers = (planOutput(v1).mcp as { mcpServers: Record<string, unknown> }).mcpServers;
		expect(Object.keys(servers).sort()).toEqual(["far", "files"]);
	});

	/**
	 * The eight renamed keys, checked as a set.
	 *
	 * `test.each` over the table above would pass if a row were deleted from it, so
	 * the list is written out here as well: a table that loses a row and a test that
	 * loses a row are the same edit, and only one of them is visible.
	 */
	test("all eight renamed keys are the ones this importer claims to read", () => {
		expect(Object.values(OPENCODE_KEY_SPELLINGS).flat().sort()).toEqual([
			"agent",
			"agents",
			"attachment",
			"attachments",
			"command",
			"commands",
			"permission",
			"permissions",
			"plugin",
			"plugins",
			"provider",
			"providers",
			"reference",
			"references",
			"snapshot",
			"snapshots",
		]);
	});

	/**
	 * A document holding **every** spelling of **every** renamed key, and the one
	 * thing that must not happen: any of them reported as a key with no mapping.
	 *
	 * The value is derived from the table, so a ninth pair added to it is covered
	 * the moment it is added — the failure this guards against is a pair that gets
	 * read but not registered, which is what produced seven false alarms.
	 */
	test("no spelling of a renamed key is ever reported as a key with no mapping", () => {
		const config: Record<string, unknown> = {};
		for (const spellings of Object.values(OPENCODE_KEY_SPELLINGS)) {
			for (const spelling of spellings) config[spelling] = {};
		}
		const result = runWithConfig(config);
		expect(result.plan.items.filter((i) => i.detail.includes("no mapping for"))).toEqual([]);
	});

	/**
	 * A line has to name a key that is in the file the user is looking at.
	 *
	 * Every one of these says the v2 name in a document that has the v2 name, and
	 * the v1 name in a document that has the v1 name. A report that named `provider`
	 * at a v2 user is not lying about anything load-bearing — but it is pointing at
	 * a key they cannot find, which is the same defect as the credentials one.
	 */
	test.each([
		["attachments", "attachment"],
		["snapshots", "snapshot"],
		["references", "reference"],
	])("%s is named by the spelling the document used", (v2Name, v1Name) => {
		const v2 = runWithConfig({ [v2Name]: {} });
		const v1 = runWithConfig({ [v1Name]: {} });
		expect(v2.plan.items.some((i) => i.from.endsWith(`→ ${v2Name}`))).toBe(true);
		expect(v1.plan.items.some((i) => i.from.endsWith(`→ ${v1Name}`))).toBe(true);
		// And the v2 line says the thing that is true about a v2 name, not the
		// comfortable one: opencode's own migration drops keys it does not know.
		const line = v2.plan.items.find((i) => i.from.endsWith(`→ ${v2Name}`));
		expect(line?.detail).toContain("drops this one");
		const v1Line = v1.plan.items.find((i) => i.from.endsWith(`→ ${v1Name}`));
		expect(v1Line?.detail).toContain("which is where opencode reads it from");
	});

	/**
	 * The v1 half of that sentence, from the other direction: a v1-only key keeps
	 * it, because for a v1 name it is true.
	 */
	test("a v1 name still says opencode reads it from its own file", () => {
		const result = runWithConfig({ snapshot: true, autoupdate: true });
		for (const key of ["snapshot", "autoupdate"]) {
			const line = result.plan.items.find((i) => i.from.endsWith(`→ ${key}`));
			expect(line?.detail).toContain("which is where opencode reads it from");
			expect(line?.detail).not.toContain("drops this one");
		}
	});

	/**
	 * A key with a reason of its own is reported once, not twice.
	 *
	 * `username_mode` is in the list of keys that get a written reason and was not
	 * in the set of handled keys, so a document containing it produced two lines:
	 * one explaining it and one from the unhandled sweep saying there is no
	 * mapping. The unhandled set is now derived, so a key cannot be in one list and
	 * missing from the other.
	 */
	test("a key that has a reason of its own is not also reported as unmapped", () => {
		const result = runWithConfig({ username_mode: "x" });
		const lines = result.plan.items.filter((i) => i.from.endsWith("→ username_mode"));
		expect(lines).toHaveLength(1);
		expect(lines[0].detail).toContain("retired spelling of username");
	});

	// ── MCP ────────────────────────────────────────────────────────────────

	/**
	 * The false positive, and the reason it is the first thing in this block.
	 *
	 * A v2 `mcp` is an envelope, so reading it as the server table named two
	 * servers that do not exist — `timeout` and `servers` — and reported each with a
	 * line about a transport it has none of. The assertion is that the two names are
	 * **absent** from the report, which is the shape of the old bug and nothing
	 * else.
	 */
	test("a v2 mcp envelope produces its servers and not the envelope's own keys", () => {
		const result = runWithConfig({
			mcp: { timeout: { request: 30000 }, servers: { files: { type: "local", command: ["run-me"] } } },
		});
		const servers = (planOutput(result).mcp as { mcpServers: Record<string, unknown> }).mcpServers;
		expect(Object.keys(servers)).toEqual(["files"]);
		// The bug's exact shape: a line about a server called `servers`, which the
		// envelope's own key used to produce. `endsWith` rather than `includes`,
		// because `mcp.servers.files` is a real line and must not be caught by this.
		expect(result.plan.items.some((i) => i.from.endsWith("→ mcp.servers"))).toBe(false);
		// The envelope's timeout is a real setting and is named as one, rather than
		// turned into a server.
		const line = result.plan.items.find((i) => i.from.endsWith("mcp.timeout"));
		expect(line?.action).toBe("skip");
		expect(line?.detail).toContain("request timeout for every server");
	});

	test("a v1 flat mcp table is still read as a table of servers", () => {
		const result = runWithConfig({ mcp: { files: { type: "local", command: ["run-me"] } } });
		const servers = (planOutput(result).mcp as { mcpServers: Record<string, unknown> }).mcpServers;
		expect(Object.keys(servers)).toEqual(["files"]);
	});

	/**
	 * v2 spells a server's own timeout as `{startup?, request?}` and a v1 one as a
	 * number. `positiveInteger({request: 30000})` is `undefined`, so the object form
	 * matched no branch and — because `timeout` is a key the reader expects — the
	 * uncarried-key check stayed quiet too. A setting that reaches no report line
	 * from either direction.
	 */
	test("a v2 server timeout object is named rather than dropped", () => {
		const result = runWithConfig({
			mcp: {
				servers: {
					files: { type: "remote", url: "https://m.invalid/mcp", timeout: { startup: 5000, request: 30000 } },
				},
			},
		});
		const line = result.plan.items.find((i) => i.from.includes("mcp.servers.files"));
		expect(line?.action).toBe("downgrade");
		expect(line?.detail).toContain("startup and request timeout");
	});

	test("a v2 server switched off with `disabled` is named", () => {
		const result = runWithConfig({
			mcp: { servers: { files: { type: "local", command: ["run-me"], disabled: true } } },
		});
		const line = result.plan.items.find((i) => i.from.includes("mcp.servers.files"));
		expect(line?.detail).toContain("switched off");
		// …and not by the generic "no field for" path, which is what a new key used
		// to fall into.
		expect(line?.detail).not.toContain("no field for");
	});

	// ── permissions ────────────────────────────────────────────────────────

	/**
	 * v2's array is the flattened form of v1's object, so reading it back is the
	 * reverse of `migrate.ts:82-89` and needs no judgement — with one exception,
	 * `resource: "*"`, which is how a whole-tool rule is written. Turning it into
	 * `Tool(*)` would ask about a literal asterisk, so the bare form is pinned here
	 * separately from the patterned one.
	 */
	test("a v2 permission ruleset writes the same rules the v1 object would", () => {
		const fromArray = runWithConfig({
			permissions: [
				{ action: "bash", resource: "git push *", effect: "allow" },
				{ action: "read", resource: "*", effect: "deny" },
			],
		});
		const fromObject = runWithConfig({ permission: { bash: { "git push *": "allow" }, read: "deny" } });
		const rules = (r: ReturnType<typeof runMigration>) =>
			(planOutput(r).settings as { permissions: { allow: string[]; deny: string[] } }).permissions;
		expect(rules(fromArray)).toEqual(rules(fromObject));
		expect(rules(fromArray).allow).toEqual(["Bash(git push *)"]);
		// `Read`, not `Read(*)`: the asterisk is the whole-tool spelling, not a pattern.
		expect(rules(fromArray).deny).toEqual(["Read"]);
	});

	test("a v2 rule whose effect is ask is counted and written into neither list", () => {
		const result = runWithConfig({ permissions: [{ action: "bash", resource: "rm *", effect: "ask" }] });
		const rules = (planOutput(result).settings as { permissions?: { allow: string[]; deny: string[] } }).permissions;
		expect(rules?.allow ?? []).toEqual([]);
		expect(rules?.deny ?? []).toEqual([]);
		const line = result.plan.items.find((i) => i.detail.includes("would stop and ask about"));
		expect(line?.action).toBe("skip");
		expect(line?.detail).toContain("no ask tier here");
	});

	/**
	 * `action` is a free string in v2's schema, so an unknown one is a user's own
	 * tool rather than a typo — and v1's tables are the right tables for it, because
	 * v1's keys became v2's `action` values unchanged.
	 */
	test("a v2 rule for a tool this build has no name for is named with what it governed", () => {
		const result = runWithConfig({
			permissions: [
				{ action: "external_directory", resource: "/etc", effect: "deny" },
				{ action: "some_user_tool", resource: "*", effect: "allow" },
			],
		});
		expect(
			result.plan.items.some((i) => i.from.includes("external_directory") && i.detail.includes("outside the working")),
		).toBe(true);
		expect(result.plan.items.some((i) => i.from.includes("some_user_tool") && i.detail.includes("no tool for"))).toBe(
			true,
		);
	});

	test("a v2 rule missing an action or a resource is named, not guessed at", () => {
		const result = runWithConfig({
			permissions: [
				{ resource: "*", effect: "deny" },
				{ action: "bash", effect: "deny" },
				{ action: "bash", resource: "*", effect: "sometimes" },
				"not a rule at all",
			],
		});
		const items = result.plan.items.filter((i) => i.from.includes("permissions["));
		expect(items).toHaveLength(4);
		expect(items[0].detail).toContain("does not name both an action and a resource");
		expect(items[1].detail).toContain("does not name both an action and a resource");
		expect(items[2].detail).toContain("not one of opencode's three answers");
		expect(items[3].detail).toContain("not a rule entry");
	});

	// ── skills ─────────────────────────────────────────────────────────────

	/**
	 * v2's `skills` is one flat list with nothing marking which entries are paths
	 * and which are URLs, so the split is made by v2's own test
	 * (`config/plugin/skill.ts:35`: `URL.canParse` and an `http:`/`https:`
	 * protocol) and the report says it was made. A path that is really a path
	 * imports; a URL is named and never fetched.
	 */
	test("a v2 skills list is split into paths and URLs by opencode's own test", () => {
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					// `~/` and not `./`: opencode expands `~/` against the global home
					// (`skill.ts:39`) and resolves a relative path against the workspace
					// directory (`:43`), which a migration reading one user's home has no
					// equivalent of. Only the first form is a directory this run can find.
					skills: ["https://example.invalid/skills/", "~/extra-skills", "git+ssh://git@host/repo"],
				}),
				// A real directory, because the path arm's whole claim is that its
				// skills turn up in the import — a path that resolved to nothing would
				// pass the same assertion.
				"extra-skills/alpha/SKILL.md": "---\nname: alpha\ndescription: an alpha skill\n---\n\nbody\n",
			},
			(home) => {
				const result = runMigration({ home });
				const raw = readOpencode(home);
				expect(raw.skillsSpelling).toBe("list");
				expect(raw.skillUrls).toEqual(["https://example.invalid/skills/"]);
				// `git+ssh://` parses as a URL and is not http, so it is a directory —
				// which is what opencode does with it too (`skill.ts:35`).
				// `~/` is reported already expanded, because that is the path the
				// skill was read from.
				expect(raw.extraSkillPaths).toEqual([join(home, "extra-skills"), "git+ssh://git@host/repo"]);
				expect(raw.skills.map((s) => s.name)).toContain("alpha");
				// The line says the list was split, so a wrong call is checkable
				// rather than silent.
				const line = result.plan.items.find((i) => i.detail.includes("one flat list in v2"));
				expect(line?.detail).toContain("https://example.invalid/skills/");
			},
		);
	});

	test("a v1 skills object is read as the two named fields it is", () => {
		const raw = (() => {
			let out: ReturnType<typeof readOpencode> | undefined;
			withHome(
				{
					".config/opencode/opencode.json": JSON.stringify({
						skills: { paths: ["./extra-skills"], urls: ["https://example.invalid/skills/"] },
					}),
					"extra-skills/alpha/SKILL.md": "---\nname: alpha\ndescription: an alpha skill\n---\n\nbody\n",
				},
				(home) => {
					out = readOpencode(home);
				},
			);
			if (out === undefined) throw new Error("withHome did not run the body");
			return out;
		})();
		expect(raw.skillsSpelling).toBe("object");
		expect(raw.skillUrls).toEqual(["https://example.invalid/skills/"]);
		expect(raw.extraSkillPaths).toEqual(["./extra-skills"]);
	});

	test("a v2 skills list labels its lines `skills`, not the v1 fields", () => {
		let report = "";
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					skills: ["https://example.invalid/skills/", "./extra-skills"],
				}),
				"extra-skills/alpha/SKILL.md": "---\nname: alpha\ndescription: an alpha skill\n---\n\nbody\n",
			},
			(home) => {
				report = runMigration({ home }).report;
			},
		);
		expect(report).toContain("→ skills ");
		expect(report).not.toContain("skills.urls");
		expect(report).not.toContain("skills.paths");
	});
});

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

/** The three tables and the `notNull`/`nullable` columns the reader selects. */
function makeOpencodeDb(dir: string, name: string, seed?: (db: Database) => void): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	const db = new Database(path);
	db.run(
		"create table session (id text primary key, project_id text, parent_id text, slug text, directory text not null, title text, time_created integer, time_archived integer)",
	);
	db.run("create table message (id text primary key, session_id text, time_created integer, data text)");
	db.run("create table part (id text primary key, message_id text, session_id text, time_created integer, data text)");
	// The four tables the importer names and never opens.
	db.run("create table account (id text primary key, access_token text, refresh_token text)");
	db.run("create table control_account (id text primary key)");
	db.run("create table credential (id text primary key, secret text)");
	db.run("create table session_share (id text primary key, secret text not null)");
	seed?.(db);
	db.close();
	return path;
}

function insertSession(
	db: Database,
	row: {
		id: string;
		parentId?: string;
		directory?: string;
		title?: string;
		created?: number;
		archived?: number | null;
	},
): void {
	db.run("insert into session (id, directory, title, time_created, time_archived) values (?, ?, ?, ?, ?)", [
		row.id,
		row.directory ?? process.cwd(),
		row.title ?? "A session",
		row.created ?? 1,
		row.archived ?? null,
	]);
	if (row.parentId) db.run("update session set parent_id = ? where id = ?", [row.parentId, row.id]);
}

function insertMessage(
	db: Database,
	id: string,
	sessionId: string,
	created: number,
	data: Record<string, unknown>,
): void {
	db.run("insert into message (id, session_id, time_created, data) values (?, ?, ?, ?)", [
		id,
		sessionId,
		created,
		JSON.stringify(data),
	]);
}

function insertPart(
	db: Database,
	id: string,
	messageId: string,
	sessionId: string,
	created: number,
	data: Record<string, unknown>,
): void {
	db.run("insert into part (id, message_id, session_id, time_created, data) values (?, ?, ?, ?, ?)", [
		id,
		messageId,
		sessionId,
		created,
		JSON.stringify(data),
	]);
}

describe("opencode: the database", () => {
	test("a channel database is found by looking for it, because a nightly's name cannot be computed", () => {
		// `core/src/database/database.ts:43-57`: `opencode.db` for the release
		// channels, `opencode-<channel>.db` otherwise. Only the first can be
		// computed — a nightly writes its own date into the name.
		withHome({}, (home) => {
			const dir = dataPath(home);
			expect(opencodeDatabasePath(dir)).toBeNull();
			makeOpencodeDb(dir, "opencode-nightly-20260925.db");
			expect(channelDatabaseNames(dir)).toEqual([join(dir, "opencode-nightly-20260925.db")]);
			expect(opencodeDatabasePath(dir)).toBe(join(dir, "opencode-nightly-20260925.db"));
		});
	});

	test("opencode.db wins over a channel file when both are present", () => {
		withHome({}, (home) => {
			const dir = dataPath(home);
			makeOpencodeDb(dir, "opencode.db");
			makeOpencodeDb(dir, "opencode-nightly.db");
			expect(opencodeDatabasePath(dir)).toBe(join(dir, "opencode.db"));
		});
	});

	test("a database is never created by reading: `new Database(path)` would make one", () => {
		// The whole reason `withDb` stats the file first. A migration on a machine
		// without OpenCode would otherwise leave a brand-new file inside a directory
		// this importer promised only to read, before the user has seen a word of the
		// report.
		withHome({}, (home) => {
			const dir = dataPath(home);
			const path = join(dir, "opencode.db");
			expect(readOpencodeSessions(path)).toEqual([]);
			expect(readOpencodeTableNames(path)).toEqual([]);
			expect(existsSync(path)).toBe(false);
		});
	});

	test("the four credential tables are named from the schema and never opened", () => {
		// `sqlite_master` is a query against the schema rather than against any row,
		// which is what lets the report say "this install has a `session_share`
		// table" instead of naming four tables that may not exist.
		const secret = "tok-DO-NOT-LEAK";
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				db.run("insert into session_share (id, secret) values ('s1', ?)", [secret]);
				db.run("insert into account (id, access_token) values ('a1', ?)", [secret]);
				insertSession(db, { id: "sess1" });
			});
			const raw = readOpencode(home);
			expect(raw.credentialTables.sort()).toEqual(Object.keys(OPENCODE_CREDENTIAL_TABLES).sort());
			const result = runMigration({ home });
			const item = result.plan.items.find((i) => i.detail.startsWith("tables of opencode's own database"));
			expect(item?.action).toBe("skip");
			expect(item?.detail).toContain("the share secret each published session is behind");
			// The path is written the way every other line in the report writes one:
			// relative to the home. An absolute temp path here would be the only line
			// in the report a user cannot read as "where this came from".
			expect(item?.from.startsWith("~/")).toBe(true);
			expect(item?.from).toContain("opencode.db");
			expect(result.report).not.toContain(secret);
		});
	});

	test("an archived session is imported with the flag, not skipped", () => {
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1", created: 10 });
				insertSession(db, { id: "s2", created: 20, archived: 30 });
				insertMessage(db, "m1", "s1", 10, { role: "user", time: { created: 10 } });
				insertPart(db, "p1", "m1", "s1", 10, { type: "text", text: "hello" });
			});
			const listing = listHistory("opencode", home, { cwd: process.cwd(), scope: "all" });
			expect(listing.candidates.map((c) => c.sourceId)).toEqual(["s2", "s1"]);
			expect(listing.candidates.find((c) => c.sourceId === "s2")?.archived).toBe(true);
			expect(listing.candidates.find((c) => c.sourceId === "s1")?.archived).toBeUndefined();
		});
	});

	test("a subagent session is counted and skipped, the way zcode's are", () => {
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "parent", created: 10 });
				insertSession(db, { id: "child", parentId: "parent", created: 11 });
			});
			const listing = listHistory("opencode", home, { cwd: process.cwd(), scope: "all" });
			expect(listing.candidates.map((c) => c.sourceId)).toEqual(["parent"]);
			expect(listing.notes).toEqual([{ reason: "subagent session", count: 1 }]);
		});
	});

	test("a tool result is read off whichever arm of the state union it carries", () => {
		// `ToolState` is discriminated on `status` (`session.ts:304-310`): `output`
		// once completed, `error` once it failed, neither while pending or running. A
		// call with no terminal state is still emitted, because dropping it would
		// leave a tool call with no answer — which is what `repairToolPairing` is for.
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertMessage(db, "a1", "s1", 10, { role: "assistant", time: { created: 10 } });
				insertPart(db, "p1", "a1", "s1", 10, {
					type: "tool",
					callID: "c1",
					tool: "bash",
					state: { status: "completed", input: { command: "ls" }, output: "a.txt" },
				});
				insertPart(db, "p2", "a1", "s1", 11, {
					type: "tool",
					callID: "c2",
					tool: "read",
					state: { status: "error", input: { path: "nope" }, error: "no such file" },
				});
				insertPart(db, "p3", "a1", "s1", 12, {
					type: "tool",
					callID: "c3",
					tool: "grep",
					state: { status: "running", input: { pattern: "x" } },
				});
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const session = read.sessions[0];
			const results = session.entries.filter((e) => e.kind === "message" && e.message.role === "toolResult") as Array<{
				message: { isError: boolean; content: Array<{ type: string; text?: string }> };
			}>;
			expect(results).toHaveLength(3);
			expect(results[0].message.isError).toBe(false);
			expect(results[0].message.content[0].text).toContain("a.txt");
			expect(results[1].message.isError).toBe(true);
			expect(results[1].message.content[0].text).toContain("no such file");
			expect(read.notes).toContainEqual({ reason: "tool call with no recorded output", count: 1 });
			// The arguments come off `state.input`, which is a record on all four arms
			// of the union — so it is stringified as it stands rather than parsed out
			// of a string, and they are what the model will be shown on `--continue`.
			const calls = session.entries.filter((e) => e.kind === "message" && e.message.role === "assistant") as Array<{
				message: { content: Array<{ type: string; name?: string; arguments?: string }> };
			}>;
			const argumentsOf = (tool: string): string =>
				calls.flatMap((e) => e.message.content).find((b) => b.type === "toolCall" && b.name === tool)?.arguments ?? "";
			expect(JSON.parse(argumentsOf("bash"))).toEqual({ command: "ls" });
			expect(JSON.parse(argumentsOf("read"))).toEqual({ path: "nope" });
		});
	});

	test("a compaction is the pair opencode records, joined by parentID rather than by order", () => {
		// The user's message gains a `compaction` part and a separate assistant
		// message carries `summary: true` and names it in its `parentID` — the only
		// link between them, since `messageBase` is just `{ id, sessionID }`. An
		// assistant landing in between is the case that tells adjacency apart from
		// the link, and the marker belongs to the message `parentID` names.
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertMessage(db, "u1", "s1", 10, { role: "user", time: { created: 10 } });
				insertPart(db, "p1", "u1", "s1", 10, { type: "text", text: "the long request" });
				insertPart(db, "p2", "u1", "s1", 11, { type: "compaction", auto: false });
				insertMessage(db, "a1", "s1", 12, { role: "assistant", parentID: "u1", time: { created: 12 } });
				insertPart(db, "p3", "a1", "s1", 12, { type: "text", text: "  a summary  " });
				// An assistant written between the trigger and its summary.
				insertMessage(db, "a0", "s1", 11, { role: "assistant", parentID: "u0", time: { created: 11 } });
				insertPart(db, "p0", "a0", "s1", 11, { type: "text", text: "something else" });
				insertMessage(db, "a2", "s1", 13, { role: "assistant", parentID: "u1", summary: true, time: { created: 13 } });
				insertPart(db, "p4", "a2", "s1", 13, { type: "text", text: "the summary" });
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const markers = read.sessions[0].entries.filter((e) => e.kind === "compaction") as Array<{
				kind: "compaction";
				summary: string;
				preTokens: number;
			}>;
			expect(markers).toHaveLength(1);
			expect(markers[0].summary).toBe("the summary");
			// `CompactionPart` records no token count, and a guess would read as a
			// measurement this importer never took.
			expect(markers[0].preTokens).toBe(0);
			// The summary's text is in the marker, so the assistant message must not
			// also carry it.
			const texts = read.sessions[0].entries
				.filter((e) => e.kind === "message")
				.map((e) => (e as { message: { role: string } }).message.role);
			expect(texts).not.toContain("summary");
		});
	});

	test("a compaction whose summary is missing still leaves a marker, saying so", () => {
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertMessage(db, "u1", "s1", 10, { role: "user", time: { created: 10 } });
				insertPart(db, "p1", "u1", "s1", 10, { type: "text", text: "the long request" });
				insertPart(db, "p2", "u1", "s1", 11, { type: "compaction", auto: true });
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const markers = read.sessions[0].entries.filter((e) => e.kind === "compaction") as Array<{ summary: string }>;
			expect(markers[0].summary).toContain("its summary is not in this database");
		});
	});

	test("a user's own `summary` object is not read as a compaction flag", () => {
		// `summary` is `true` on an assistant and `{ title, body, diffs }` on a user
		// (`session.ts:339-345`) — the same key name with two different types, which
		// is why the comparison is against `true` and not for truthiness.
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertMessage(db, "u1", "s1", 10, {
					role: "user",
					time: { created: 10 },
					summary: { title: "A title", body: "A body", diffs: [] },
				});
				insertPart(db, "p1", "u1", "s1", 10, { type: "text", text: "ask" });
				insertMessage(db, "a1", "s1", 11, { role: "assistant", parentID: "u1", time: { created: 11 } });
				insertPart(db, "p2", "a1", "s1", 11, { type: "text", text: "answer" });
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			expect(read.sessions[0].entries.filter((e) => e.kind === "compaction")).toEqual([]);
		});
	});

	test("a part this build has no shape for is counted, not dropped in silence", () => {
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertMessage(db, "u1", "s1", 10, { role: "user", time: { created: 10 } });
				insertPart(db, "p1", "u1", "s1", 10, { type: "text", text: "look", synthetic: true });
				insertPart(db, "p2", "u1", "s1", 10, { type: "file", mime: "image/png", url: "data:..." });
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			expect(read.notes).toContainEqual({ reason: "tool-injected text part", count: 1 });
			expect(read.notes).toContainEqual({ reason: "unsupported part", count: 1 });
		});
	});

	test("the pre-database storage tree is named, not read", () => {
		withHome({ ".local/share/opencode/storage/session/info/s1.json": "{}" }, (home) => {
			expect(readOpencode(home).legacyStorage).toBe(true);
			const result = runMigration({ home });
			expect(result.plan.items.some((i) => i.detail.includes("one JSON file per session, message and part"))).toBe(
				true,
			);
		});
	});

	test("a conversation read for one session does not bring another's rows along", () => {
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSession(db, { id: "s2" });
				insertMessage(db, "m1", "s1", 10, { role: "user", time: { created: 10 } });
				insertMessage(db, "m2", "s2", 11, { role: "user", time: { created: 11 } });
			});
			expect(readOpencodeConversation(join(dataPath(home), "opencode.db"), "s1").messages.map((m) => m.id)).toEqual([
				"m1",
			]);
		});
	});
});

// ---------------------------------------------------------------------------
// v2's message table
// ---------------------------------------------------------------------------

/**
 * A database shaped the way v2 leaves one.
 *
 * **The v1 `message`/`part` tables are created and left empty on purpose.** v2
 * keeps them — its own migration re-indexes `message` and `part` rather than
 * dropping them (`packages/core/src/database/migration/20260312043431_session_message_cursor.ts:6-11`)
 * and adds `session_message` beside them
 * (`20260427172553_slow_nightmare.ts:9-17`) — but nothing under
 * `packages/core/src/` reads or writes them. A fixture that omitted them would
 * pass for a reader that simply prefers the new table; a fixture where they are
 * present and empty fails for a reader that asks the v1 question first, which is
 * the bug.
 */
function makeOpencodeV2Db(dir: string, name: string, seed?: (db: Database) => void): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	const db = new Database(path);
	db.run(
		"create table session (id text primary key, project_id text, parent_id text, slug text, directory text not null, title text, time_created integer, time_archived integer)",
	);
	db.run("create table message (id text primary key, session_id text, time_created integer, data text)");
	db.run("create table part (id text primary key, message_id text, session_id text, time_created integer, data text)");
	db.run(
		"create table session_message (id text primary key, session_id text not null, type text not null, seq integer not null, time_created integer not null, time_updated integer not null, data text not null)",
	);
	seed?.(db);
	db.close();
	return path;
}

/** `session_message` columns in the order `sql.ts:116-131` declares them. */
function insertSessionMessage(
	db: Database,
	row: {
		id: string;
		sessionId: string;
		seq: number;
		type: string;
		created?: number;
		updated?: number;
		data: Record<string, unknown>;
	},
): void {
	db.run(
		"insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)",
		[
			row.id,
			row.sessionId,
			row.type,
			row.seq,
			row.created ?? 1,
			row.updated ?? row.created ?? 1,
			JSON.stringify(row.data),
		],
	);
}

/** A v2 `user` row, the one shape the reader turns into a turn. */
function v2User(
	seq: number,
	text: string,
	created = 1000 + seq,
	files?: unknown[],
): Parameters<typeof insertSessionMessage>[1] {
	return {
		id: `msg_u${seq}`,
		sessionId: "s1",
		seq,
		type: "user",
		created,
		data: { type: "user", text, ...(files ? { files } : {}) },
	};
}

function v2Assistant(
	seq: number,
	content: unknown[],
	created = 1000 + seq,
): Parameters<typeof insertSessionMessage>[1] {
	return {
		id: `msg_a${seq}`,
		sessionId: "s1",
		seq,
		type: "assistant",
		created,
		data: { type: "assistant", agent: "build", model: { providerID: "p", modelID: "m" }, content, time: { created } },
	};
}

describe("opencode: v2's session_message table", () => {
	test("a v2 conversation is imported, and the empty v1 tables beside it are not what says so", () => {
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				// Content in the v1 tables too, so "the reader found the rows" cannot
				// be satisfied by falling back to them — only the v2 row has `text`.
				insertMessage(db, "m1", "s1", 10, { role: "user", time: { created: 10 } });
				insertPart(db, "p1", "m1", "s1", 10, { type: "text", text: "the v1 table's text" });
				insertSessionMessage(db, v2User(0, "the v2 table's text"));
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const session = read.sessions[0];
			const texts = session.entries
				.filter((e) => e.kind === "message")
				.map((e) => JSON.stringify((e as { message: { content: unknown } }).message.content));
			expect(texts).toEqual([JSON.stringify("the v2 table's text")]);
		});
	});

	test("`readOpencodeSessionMessages` says `null` for a v1 database, so the two are told apart", () => {
		// `[]` and `null` are different answers: an empty v2 session, and a database
		// with no such table at all. Collapsing them is what makes a v1 install
		// report a conversation it never read.
		withHome({}, (home) => {
			makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
			});
			expect(readOpencodeSessionMessages(join(dataPath(home), "opencode.db"), "s1")).toBeNull();
		});
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
			});
			// A v2 database with nothing in the session is `[]`, not `null`.
			expect(readOpencodeSessionMessages(join(dataPath(home), "opencode.db"), "s1")).toEqual([]);
		});
	});

	test("messages are ordered by `seq`, not by the clock", () => {
		// `(session_id, seq)` is the unique index the source puts on the table
		// (`session/sql.ts:133`), and two rows can share a millisecond — so a
		// reader that ordered by time would depend on the rowid it happened to get.
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSessionMessage(db, { ...v2User(2, "third"), created: 5 });
				insertSessionMessage(db, { ...v2User(0, "first"), created: 9 });
				insertSessionMessage(db, { ...v2User(1, "second"), created: 1 });
			});
			const rows = readOpencodeSessionMessages(join(dataPath(home), "opencode.db"), "s1");
			expect(rows?.map((r) => r.data.text)).toEqual(["first", "second", "third"]);
		});
	});

	test("a conversation read for one session does not bring another's rows along", () => {
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSession(db, { id: "s2" });
				insertSessionMessage(db, v2User(0, "s1's text"));
				insertSessionMessage(db, { ...v2User(0, "s2's text"), id: "msg_u0b", sessionId: "s2" });
			});
			const rows = readOpencodeSessionMessages(join(dataPath(home), "opencode.db"), "s1");
			expect(rows?.map((r) => r.data.text)).toEqual(["s1's text"]);
		});
	});

	test("a row whose `data` is not JSON is skipped, and the rest of the session still reads", () => {
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSessionMessage(db, v2User(0, "before"));
				db.run(
					"insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)",
					["msg_bad", "s1", "user", 1, 2, 2, "{not json"],
				);
				insertSessionMessage(db, { ...v2User(2, "after") });
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const texts = read.sessions[0].entries
				.filter((e) => e.kind === "message")
				.map((e) => JSON.stringify((e as { message: { content: unknown } }).message.content));
			expect(texts).toEqual([JSON.stringify("before"), JSON.stringify("after")]);
		});
	});

	test("the `type` column is read, and the blob's own copy of it is only a fallback", () => {
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				// A row whose blob claims one type and whose column claims another.
				insertSessionMessage(db, {
					id: "msg_x",
					sessionId: "s1",
					seq: 0,
					type: "system",
					created: 1,
					data: { type: "user", text: "claimed to be a user turn" },
				});
				insertSessionMessage(db, { ...v2User(1, "a real turn"), id: "msg_real" });
			});
			const rows = readOpencodeSessionMessages(join(dataPath(home), "opencode.db"), "s1");
			// The column is the discriminator the union is indexed by, so it wins.
			expect(rows?.[0].type).toBe("system");
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const texts = read.sessions[0].entries
				.filter((e) => e.kind === "message")
				.map((e) => JSON.stringify((e as { message: { content: unknown } }).message.content));
			// Had the blob's copy won, the session would carry two user turns and
			// the system message would be one of them.
			expect(texts).toEqual([JSON.stringify("a real turn")]);
			expect(read.notes).toContainEqual({ reason: "system message", count: 1 });
		});
	});

	test("a tool result is read off whichever arm of v2's `ToolState` carries the answer", () => {
		// v2 has **no `state.output`** — that was v1's field. The four arms
		// (`session-message.ts:83-114`) put the answer in `result` once completed,
		// `error.message` once it failed, `content[]` on both, and none of the three
		// while pending or running. A reader that still asked for `output` would find
		// the empty string on all four and report every call as unanswered.
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSessionMessage(
					db,
					v2Assistant(0, [
						{
							type: "tool",
							id: "c1",
							name: "bash",
							state: { status: "completed", input: { command: "ls" }, result: "a.txt", content: [] },
						},
						{
							type: "tool",
							id: "c2",
							name: "read",
							state: { status: "error", input: { path: "nope" }, error: { type: "unknown", message: "no such file" } },
						},
						{
							type: "tool",
							id: "c3",
							name: "read",
							state: { status: "completed", input: {}, content: [{ type: "text", text: "from content" }] },
						},
						{ type: "tool", id: "c4", name: "grep", state: { status: "running", input: { pattern: "x" } } },
						{
							// A tool that finished and returned nothing: `result` is
							// `Schema.Unknown.pipe(optional)` (`session-message.ts:104`), so
							// the empty string is a legal result rather than an absent one.
							// The blocks beside it are what it showed the model, so stopping at
							// the empty string reports a call as unanswered when the answer is
							// sitting in the same state.
							type: "tool",
							id: "c5",
							name: "edit",
							state: { status: "completed", input: {}, result: "", content: [{ type: "text", text: "wrote it" }] },
						},
					]),
				);
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const results = read.sessions[0].entries.filter(
				(e) => e.kind === "message" && e.message.role === "toolResult",
			) as Array<{ message: { isError: boolean; content: Array<{ type: string; text?: string }> } }>;
			expect(results).toHaveLength(5);
			expect(results[0].message.content[0].text).toContain("a.txt");
			expect(results[1].message.isError).toBe(true);
			expect(results[1].message.content[0].text).toContain("no such file");
			expect(results[2].message.content[0].text).toContain("from content");
			expect(results[4].message.content[0].text).toContain("wrote it");
			expect(read.notes).toContainEqual({ reason: "tool call with no recorded output", count: 1 });
		});
	});

	test("`ToolState.input` is a string on a pending call, so it is not stringified to `{}`", () => {
		// `session-message.ts:85-88`: `pending` holds `input` as a `Schema.String`
		// and the other three hold a record. A reader that assumed the record — as
		// the v1 path could, because all four of v1's arms are records — reports
		// `{}` for every call that was recorded before it ran.
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSessionMessage(
					db,
					v2Assistant(0, [{ type: "tool", id: "c1", name: "bash", state: { status: "pending", input: "git status" } }]),
				);
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const call = read.sessions[0].entries.find((e) => e.kind === "message" && e.message.role === "assistant") as {
				message: { content: Array<{ type: string; arguments?: string }> };
			};
			const block = call.message.content.find((c) => c.type === "toolCall");
			expect(block?.arguments).toBe("git status");
		});
	});

	test("a compaction is one row here, and it becomes a marker holding the summary", () => {
		// v1 split it across two messages joined by a `parentID` link; v2 records one
		// `compaction` row with both halves in it (`session-message.ts:184-189`), so
		// the v1 pairing pass has nothing to pair and the summary has to be read off
		// this row directly.
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSessionMessage(db, v2User(0, "the long one"));
				insertSessionMessage(db, {
					id: "msg_c",
					sessionId: "s1",
					seq: 1,
					type: "compaction",
					created: 12,
					data: { type: "compaction", reason: "auto", summary: "what it decided", recent: "…" },
				});
				insertSessionMessage(db, { ...v2User(2, "after"), id: "msg_u2" });
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const entries = read.sessions[0].entries;
			const marker = entries.findIndex((e) => e.kind === "compaction");
			expect(marker).toBe(1);
			expect((entries[marker] as { summary: string }).summary).toBe("what it decided");
			expect(read.notes).toContainEqual({ reason: "compaction summary", count: 1 });
		});
	});

	test("the types that are not messages are counted under their own names, not turned into turns", () => {
		// This importer's transcript has three roles — user, assistant, tool result
		// (`packages/ai/src/types.ts:125`) — and no system one. `synthetic` is what
		// the tool injected, `system` is the harness talking to itself, `shell` is a
		// record of a command and its output rather than something the user said, and
		// the two switches record a setting change. Rendering any of them as a user
		// turn would put words in the user's mouth.
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSessionMessage(db, v2User(0, "the only real turn"));
				for (const [seq, type, data] of [
					[1, "synthetic", { text: "injected" }],
					[2, "system", { text: "harness" }],
					[3, "shell", { callID: "c", command: "ls", output: "a.txt" }],
					[4, "agent-switched", { agent: "plan" }],
					[5, "model-switched", { model: { providerID: "p", modelID: "m" } }],
				] as Array<[number, string, Record<string, unknown>]>) {
					insertSessionMessage(db, {
						id: `msg_${type}`,
						sessionId: "s1",
						seq,
						type,
						created: 100 + seq,
						data: { type, ...data },
					});
				}
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const texts = read.sessions[0].entries
				.filter((e) => e.kind === "message")
				.map((e) => JSON.stringify((e as { message: { content: unknown } }).message.content));
			expect(texts).toEqual([JSON.stringify("the only real turn")]);
			expect(read.notes).toEqual([
				{ reason: "tool-injected message", count: 1 },
				{ reason: "system message", count: 1 },
				{ reason: "shell record, with its output", count: 1 },
				{ reason: "agent or model switch", count: 2 },
			]);
		});
	});

	test("a file attached to a user turn is counted, and the turn still imports", () => {
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSessionMessage(
					db,
					v2User(0, "look at this", 10, [
						{ uri: "file:///a.png", mime: "image/png", name: "a.png" },
						{ uri: "file:///b.txt", mime: "text/plain" },
					]),
				);
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			expect(read.sessions[0].entries.filter((e) => e.kind === "message")).toHaveLength(1);
			expect(read.notes).toContainEqual({ reason: "file attachment", count: 2 });
		});
	});

	test("text, reasoning and an unknown content block are each read or counted", () => {
		withHome({}, (home) => {
			makeOpencodeV2Db(dataPath(home), "opencode.db", (db) => {
				insertSession(db, { id: "s1" });
				insertSessionMessage(
					db,
					v2Assistant(0, [
						{ type: "text", id: "t1", text: "the answer" },
						{ type: "reasoning", id: "r1", text: "the thinking" },
						{ type: "citation", id: "c1" },
						"not an object",
					]),
				);
			});
			const read = collectHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 5 });
			const message = read.sessions[0].entries.find((e) => e.kind === "message" && e.message.role === "assistant") as {
				message: { content: Array<{ type: string }> };
			};
			expect(message.message.content.map((c) => c.type)).toEqual(["text", "thinking"]);
			expect(read.notes).toContainEqual({ reason: "message this build does not read", count: 2 });
		});
	});
});

// ---------------------------------------------------------------------------
// The recall list
// ---------------------------------------------------------------------------

describe("opencode: the recall list", () => {
	test("it is on disk and it is reported rather than imported", () => {
		// `<state>/prompt-history.jsonl` holds the last 50 entries
		// (`tui/src/prompt/history.tsx:53,75-78`), and `PromptInfo` is
		// `{ input, mode?, parts }` — no session, no directory, no timestamp, at
		// either append site. `loadHistory` drops every line whose `cwd` is not the
		// project being opened, so an entry filed under no directory is one ↑ will
		// never offer. Importing 50 of them would report a recall list that does not
		// exist; naming the count says what the user is leaving behind.
		withHome(
			{
				".local/state/opencode/prompt-history.jsonl": [
					JSON.stringify({ input: "first ask", mode: "normal", parts: [] }),
					JSON.stringify({ input: "ls -la", mode: "shell", parts: [] }),
					JSON.stringify({ input: "second ask", parts: [] }),
					"not json",
				].join("\n"),
			},
			(home) => {
				expect(opencodePromptHistoryFile(statePath(home))).toBe(statePath(home, "prompt-history.jsonl"));
				const read = readPromptHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 100 });
				expect(read.entries).toEqual([]);
				expect(read.seen).toBe(3);
				const reasons = read.notes.map((n) => n.reason);
				expect(reasons).toContain("line typed in shell mode — a shell command, not a prompt to a model");
				expect(reasons.some((r) => r.includes("records no working directory or session"))).toBe(true);
				expect(reasons).toContain("line not in the history shape");
				const result = runMigration({ home });
				expect(result.plan.writes.some((w) => w.path.endsWith("history.jsonl"))).toBe(false);
			},
		);
	});

	test("a home with no recall file says nothing, which is not the same as an empty one", () => {
		withHome({}, (home) => {
			const read = readPromptHistory("opencode", home, { cwd: process.cwd(), scope: "all", limit: 100 });
			expect(read.seen).toBe(0);
			expect(read.notes).toEqual([]);
			expect(read.absent).toBeUndefined();
		});
	});
});

// ---------------------------------------------------------------------------
// The credential boundary
// ---------------------------------------------------------------------------

describe("opencode: the credential boundary", () => {
	test("a value planted in every place a credential can be never reaches the report", () => {
		// OpenCode's config file can itself be a secret file — an inline
		// `options.apiKey` and an MCP server's `environment`/`headers` are both
		// ordinary config keys — so the document has to be read and the values still
		// have to stay out. This is the sentinel: the values below are fake, and the
		// assertion is on the rendered report, not on the plan.
		const inlineKey = "sk-opencode-INLINE-SENTINEL";
		const headerToken = "opencode-HEADER-SENTINEL";
		const envToken = "opencode-ENV-SENTINEL";
		const fileToken = "opencode-FILE-SENTINEL";
		const daemonSecret = "opencode-DAEMON-SENTINEL";
		withHome(
			{
				".config/opencode/opencode.json": JSON.stringify({
					provider: {
						gw: {
							options: { baseURL: "https://gw.invalid/v1", apiKey: inlineKey },
							models: { m: { limit: { context: 1000 } } },
						},
					},
					mcp: { secretbox: { type: "remote", url: "https://m.invalid/mcp", headers: { Authorization: headerToken } } },
				}),
				// The data root, not the config root: `auth/index.ts:10` and
				// `mcp/auth.ts:37` both join `Global.Path.data`. Planted under
				// `.config` these were found only because this importer was looking
				// there too, which is the bug this placement is what pins down.
				".local/share/opencode/auth.json": JSON.stringify({ anthropic: { type: "oauth", refresh: fileToken } }),
				".local/share/opencode/mcp-auth.json": JSON.stringify({ secretbox: { access: fileToken } }),
				".config/opencode/.env": `TOKEN=${fileToken}\n`,
				// The state root, and a third secret, so the daemon's own is covered by
				// the same boundary as the two provider ones.
				".local/state/opencode/password": daemonSecret,
			},
			(home) => {
				makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
					db.run("insert into credential (id, secret) values ('c1', ?)", [fileToken]);
					insertSession(db, { id: "s1" });
				});
				const result = runMigration({ home });
				for (const secret of [inlineKey, headerToken, envToken, fileToken, daemonSecret]) {
					expect(result.report).not.toContain(secret);
				}
				// The files are still named, so the user knows a credential was here.
				const named = result.plan.items.find((i) => i.detail.startsWith("credentials: named"));
				expect(named?.action).toBe("skip");
				expect(named?.detail).toContain("never opened");
			},
		);
	});

	test("a credential-named file at the config root is named without being opened", () => {
		withHome({ ".config/opencode/.env": "A=1\n", ".config/opencode/opencode.json": "{}" }, (home) => {
			const raw = readOpencode(home);
			expect(raw.credentialFiles).toContain(".env");
			expect(raw.credentialFilesNamed).toEqual([]);
			expect(raw.otherFiles).toEqual([]);
		});
	});

	/**
	 * The three known files live in three different places, and the reader is the
	 * only thing that knows which.
	 *
	 * Every one of these assertions is a location, not a membership: a reader that
	 * asked the wrong root finds nothing and says "no credentials here", which is
	 * the one answer a credential warning must never give. So each file is planted
	 * under its real root, and each assertion checks the root the reader named — a
	 * version of this that only checked the file names would pass against the
	 * original, which looked in the config root for all three.
	 */
	test("each known credential file is found under the root its source joins it to", () => {
		withHome(
			{
				".local/share/opencode/auth.json": "{}",
				".local/share/opencode/mcp-auth.json": "{}",
				".local/state/opencode/password": "s",
				".config/opencode/opencode.json": "{}",
			},
			(home) => {
				const raw = readOpencode(home);
				expect(raw.credentialFilesNamed.map((f) => [f.name, f.root])).toEqual([
					["auth.json", "data"],
					["mcp-auth.json", "data"],
					["password", "state"],
				]);
				// The paths are the ones under the resolved roots, spelled the way the
				// machine spells them.
				expect(raw.credentialFilesNamed.map((f) => f.path)).toEqual([
					join(dataPath(home), "auth.json"),
					join(dataPath(home), "mcp-auth.json"),
					join(statePath(home), "password"),
				]);
			},
		);
	});

	/**
	 * The reverse direction, because that is the bug: a credential file parked in
	 * the config root is **not** one of the known three.
	 *
	 * Nothing stops a user from putting a file there, and it is still caught — by
	 * the config-root listing, which is what `credentialFiles` is. What must not
	 * happen is the known-name probe claiming it, because the report would then name
	 * a directory the tool does not read those names from.
	 */
	test("a known name in the config root is not reported as one of the known files", () => {
		withHome(
			{
				".config/opencode/auth.json": "{}",
				".config/opencode/opencode.json": "{}",
				".local/share/opencode/mcp-auth.json": "{}",
			},
			(home) => {
				const raw = readOpencode(home);
				// Still named — by the listing, which is the mechanism that actually
				// finds an unplaced file.
				expect(raw.credentialFiles).toContain("auth.json");
				// And the probe found only the one that is in its own root.
				expect(raw.credentialFilesNamed.map((f) => f.name)).toEqual(["mcp-auth.json"]);
			},
		);
	});

	/**
	 * The report line names the directory the file is really in.
	 *
	 * The line used to hardcode the config root, so a machine whose credentials sat
	 * in the data root — which is where they sit — was told to look in a directory
	 * that has none. Two roots in one home produce two lines rather than one merged
	 * line, because the daemon's password is not a provider token and the advice
	 * that is right for one is wrong for the other.
	 */
	test("the report names each root the credentials are in", () => {
		withHome(
			{
				".local/share/opencode/auth.json": "{}",
				".local/share/opencode/mcp-auth.json": "{}",
				".local/state/opencode/password": "s",
				".config/opencode/opencode.json": "{}",
			},
			(home) => {
				const result = runMigration({ home });
				const lines = result.plan.items.filter(
					(i) => i.detail.startsWith("credentials: named") || i.detail.startsWith("opencode's own daemon"),
				);
				expect(lines.map((i) => [i.from, i.action])).toEqual([
					[`${tildePath(home, dataPath(home))} → auth.json, mcp-auth.json`, "skip"],
					[`${tildePath(home, statePath(home))} → password`, "skip"],
				]);
				// The env-var advice is for the provider tokens; the daemon's own secret
				// gets the line that says there is nothing to carry across.
				expect(lines[0].detail).toContain("environment variables");
				expect(lines[1].detail).toContain("daemon server password");
				expect(lines[1].detail).not.toContain("environment variables");
			},
		);
	});
});
