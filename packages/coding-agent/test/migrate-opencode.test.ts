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
import { readOpencodeConversation, readOpencodeSessions, readOpencodeTableNames } from "../src/opencode-db.ts";
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
				expect(raw.skills.map((skill) => skill.name)).toEqual(["mine"]);
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
				".config/opencode/auth.json": JSON.stringify({ anthropic: { type: "oauth", refresh: fileToken } }),
				".config/opencode/mcp-auth.json": JSON.stringify({ secretbox: { access: fileToken } }),
				".config/opencode/.env": `TOKEN=${fileToken}\n`,
			},
			(home) => {
				makeOpencodeDb(dataPath(home), "opencode.db", (db) => {
					db.run("insert into credential (id, secret) values ('c1', ?)", [fileToken]);
					insertSession(db, { id: "s1" });
				});
				const result = runMigration({ home });
				for (const secret of [inlineKey, headerToken, envToken, fileToken]) {
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
});
