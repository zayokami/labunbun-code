/**
 * The twelfth source: Trae.
 *
 * Smaller than Cursor's and for a reason that is a fact about the product rather
 * than a shortcut: Trae exposes less to import. There is no portable provider
 * configuration, no CLI permission list and no hook system, so this file is
 * rules, MCP, and the report of everything else found.
 *
 * Most of what is left is **negative** space, and the negative space is the
 * point. Two of Trae's paths are named in this repo only so that a reader can
 * be shown the path was *not* taken:
 *
 *  - `~/.cursor/mcp.json` is not Trae's, and neither is `~/.trae/mcp.json`. The
 *    global MCP document is at `<editor profile>/User/mcp.json` — vendor
 *    undocumented, which `trae-home.ts` says at the point of use.
 *  - Trae's global rules are a **directory** (`~/.trae/user_rules`). A file
 *    named `user_rules.md` is named as the spelling this importer does not read.
 *
 * So the assertions below are written to fail loudly rather than quietly read
 * nothing: the product-directory probe plants all four names, the depth-cap test
 * plants a rule at the fourth level, and the state-database test plants a file
 * that could only be read by opening it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectSources,
	type MigrationItem,
	type MigrationPlan,
	planMigration,
	readSources,
	runMigration,
} from "../src/migrate.ts";
import { MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS } from "../src/migrate-types.ts";
import {
	TRAE_PRODUCT_DIRS,
	TRAE_RULES_MAX_DEPTH,
	traeEdition,
	traeGlobalMcpFile,
	traeUserDataRoot,
} from "../src/trae-home.ts";
import { readTrae, TRAE_USER_RULES_FILE } from "../src/trae-read.ts";
import { borrowSourceEnv } from "./source-env.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

/**
 * Run `body` against a throwaway home seeded with `tree`, with the project
 * directory the same directory.
 *
 * `seed` runs after the files exist, for the fixtures a string cannot express —
 * a `state.vscdb` is a directory tree rather than a file's contents, and `%APPDATA%`
 * has to point inside the fake home before any profile directory is probed.
 */
function withHome(
	tree: SourceTree,
	body: (home: string) => void,
	seed?: (home: string) => void,
	env: Record<string, string | undefined> = {},
): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-trae-"));
	const releaseSourceEnv = borrowSourceEnv();
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
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
		releaseSourceEnv();
		rmSync(home, { recursive: true, force: true });
	}
}

/** The plan for one trae tree, and nothing else. */
function plan(
	tree: SourceTree,
	seed?: (home: string) => void,
	env: Record<string, string | undefined> = {},
): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome(
		tree,
		(home) => {
			planned = planMigration(readSources(home, home), {}, { only: ["trae"] });
		},
		seed,
		env,
	);
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/** The write queued for a path, addressed by its tail (`~/.labunbun/…`). */
function writeAt(planned: MigrationPlan, tail: string) {
	const normalized = tail.replace(/\\/g, "/").replace(/^~\//, "");
	return planned.writes.find((write) => write.path.replace(/\\/g, "/").endsWith(normalized));
}

/** The first item whose source label contains `needle`. */
function line(planned: MigrationPlan, needle: string): MigrationItem | undefined {
	return planned.items.find((item) => item.from.includes(needle));
}

/** Every item whose source label contains `needle`. */
function lines(planned: MigrationPlan, needle: string): MigrationItem[] {
	return planned.items.filter((item) => item.from.includes(needle));
}

/** A rule in the shape Trae writes: a plain `.md` carrying Cursor's frontmatter. */
function rule(options: { description?: string; globs?: string; alwaysApply?: string; body?: string } = {}): string {
	return [
		"---",
		...(options.description === undefined ? [] : [`description: ${options.description}`]),
		...(options.globs === undefined ? [] : [`globs: ${options.globs}`]),
		...(options.alwaysApply === undefined ? [] : [`alwaysApply: ${options.alwaysApply}`]),
		...(options.description === undefined && options.globs === undefined && options.alwaysApply === undefined
			? []
			: ["---", ""]),
		options.body ?? "Do the thing.",
		"",
	].join("\n");
}

/** `appdata/<product>/User` for whichever product `product` names. */
function profileDir(home: string, product: string): string {
	return join(home, "appdata", product, "User");
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe("the twelfth source", () => {
	test("it is appended, so the eleven before it keep their places", () => {
		// Append-only, and the order is what `detectSources` reports: reordering
		// would silently change which of two sources providing the same file wins.
		expect(MIGRATION_SOURCE_IDS.indexOf("trae")).toBe(11);
		expect(MIGRATION_SOURCE_IDS.slice(0, 11)).toEqual([
			"claude-code",
			"codex",
			"zcode",
			"agents",
			"deepseek-harness",
			"grok-build",
			"kimi-code",
			"minimax-code",
			"step-code",
			"opencode",
			"cursor",
		]);
		expect(MIGRATION_SOURCE_LABELS.trae).toBe("Trae");
	});
});

// ---------------------------------------------------------------------------
// The two editions
// ---------------------------------------------------------------------------

describe("trae's two editions", () => {
	test("the china home is read when it is there, and the international one is not", () => {
		// Two separate products, not a locale setting: the two documentation sites
		// print different directories for the same product, and a China install has
		// `~/.trae-cn` and no `~/.trae`. Reading the latter would read a directory
		// nothing writes to any more — and would find nothing, so the rules would
		// vanish from the report with no line saying where they were looked for.
		const planned = plan({
			".trae-cn/user_rules/cn.md": rule({ alwaysApply: "true" }),
			".trae/user_rules/intl.md": rule({ alwaysApply: "true" }),
		});
		expect(line(planned, "cn.md")?.detail).toContain("your user rules");
		expect(line(planned, "intl.md")).toBeUndefined();
	});

	test("the China home wins when both directories exist, because it is a product of its own", () => {
		// A machine with both is one where the China build was installed and the
		// international one later removed. That is the reasoning `traeEdition` is
		// written on, and the test is what keeps a later "prefer whichever is
		// non-empty" simplification from quietly reversing it.
		withHome({ ".trae/user_rules/a.md": rule(), ".trae-cn/user_rules/b.md": rule() }, (home) => {
			expect(traeEdition(home)).toBe("cn");
			expect(readTrae(home, home).roots.edition).toBe("cn");
		});
	});

	test("with only the international home the label is the international one", () => {
		withHome({ ".trae/user_rules/a.md": rule() }, (home) => {
			expect(traeEdition(home)).toBe("intl");
		});
	});
});

// ---------------------------------------------------------------------------
// Project rules
// ---------------------------------------------------------------------------

describe("trae rules", () => {
	test("the frontmatter is carried over byte for byte and the loss is named", () => {
		const content = rule({ description: "React conventions", globs: "**/*.tsx", alwaysApply: "false" });
		const planned = plan({ ".trae/rules/react.md": content });
		const write = writeAt(planned, "~/.labunbun/rules/react.md");
		// Byte for byte, not "the body survived": Trae's documentation asserts the
		// `.md`-with-frontmatter compatibility with Cursor's `.mdc`, so stripping it
		// would be the same as deleting the user's own description of the rule.
		expect(write?.content).toBe(content);
		const item = line(planned, "react.md");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("with its frontmatter intact");
		expect(item?.detail).toContain('its globs ("**/*.tsx")');
		expect(item?.detail).toContain("alwaysApply: false");
	});

	test("alwaysApply: true is the one activation that survives", () => {
		const planned = plan({ ".trae/rules/always.md": rule({ alwaysApply: "true" }) });
		const item = line(planned, "always.md");
		expect(item?.action).toBe("map");
		expect(item?.detail).toContain("it applies always");
	});

	test("a file that is not .md is not a rule and is not named as one", () => {
		// The walk takes `*.md` and nothing else. A `project_rules.yaml` beside the
		// rules is not a Trae rule, and naming it would put a sentence in the report
		// about a file Trae never read either.
		const planned = plan({ ".trae/rules/notes.txt": "hi", ".trae/rules/real.md": rule({ alwaysApply: "true" }) });
		expect(planned.writes.filter((write) => write.kind === "rule")).toHaveLength(1);
		expect(planned.items.map((item) => item.from).join("\n")).not.toContain("notes.txt");
	});

	test("a rule one level past the limit is named, not imported", () => {
		// TRAE's own documentation draws the tree and marks the fourth level
		// "exceeds limit (unreadable)", so this is the tool's number and not a
		// reader's choice. The file at level 3 comes in; the one at level 4 is a
		// line in the report. Written as `MAX + 1` rather than spelled out so the
		// boundary is the constant and not a number typed twice.
		const deep = `${"d/".repeat(TRAE_RULES_MAX_DEPTH + 1)}deep.md`;
		const atLimit = `${"d/".repeat(TRAE_RULES_MAX_DEPTH)}edge.md`;
		const planned = plan({
			[`.trae/rules/${atLimit}`]: rule({ alwaysApply: "true" }),
			[`.trae/rules/${deep}`]: rule(),
		});
		expect(writeAt(planned, "~/.labunbun/rules/edge.md")).toBeDefined();
		expect(writeAt(planned, "~/.labunbun/rules/deep.md")).toBeUndefined();
		// The line names the directory the walk refused to enter, not the file inside
		// it — a fourth-level tree of twenty rules is one sentence, not twenty.
		const named = line(planned, `d/d/d/d`);
		expect(named?.action).toBe("skip");
		expect(named?.detail).toContain(`below TRAE's own ${TRAE_RULES_MAX_DEPTH}-level limit`);
	});

	test("the same limit applies to the global directory, and says so", () => {
		// A choice rather than a citation: the three-level limit is documented for
		// project rules and no separate limit is documented for `user_rules`, so
		// this applies the one number TRAE published rather than inventing an
		// uncapped scan.
		const deep = `.trae/user_rules/${"d/".repeat(TRAE_RULES_MAX_DEPTH + 1)}deep.md`;
		const planned = plan({ [deep]: rule() });
		const named = line(planned, "user_rules/d/d/d/d");
		expect(named?.action).toBe("skip");
		expect(named?.detail).toContain(`${TRAE_RULES_MAX_DEPTH}-level limit`);
	});

	test("two rules that flatten to one name are reported as a collision", () => {
		// A name collision inside one source is handled the same way as across
		// sources: the first is kept, the second is named, and neither is dropped in
		// silence — the alternative is a report claiming two imports and producing
		// one file. "The first" is the first the alphabetical walk reaches, so
		// `backend` wins over `frontend`.
		const planned = plan({
			".trae/rules/frontend/style.md": rule({ alwaysApply: "true", body: "One" }),
			".trae/rules/backend/style.md": rule({ alwaysApply: "true", body: "Two" }),
		});
		const both = lines(planned, "style.md");
		expect(both).toHaveLength(2);
		expect(both.filter((item) => item.action === "skip")).toHaveLength(1);
		expect(writeAt(planned, "~/.labunbun/rules/style.md")?.content).toContain("Two");
		expect(both[0].from).toContain("backend");
	});

	test("a global rule is read from the directory, and named as such", () => {
		const planned = plan({ ".trae/user_rules/preferences.md": rule({ alwaysApply: "true" }) });
		const item = line(planned, "preferences.md");
		expect(item?.detail).toContain("your user rules");
		expect(writeAt(planned, "~/.labunbun/rules/preferences.md")).toBeDefined();
	});

	test("a rule directly in the global root is not a user rule", () => {
		// The correction `trae-home.ts` leads with, made into an assertion: Trae's
		// global rules live in `~/.trae/user_rules/`, not in `~/.trae/`. Every other
		// test in this file plants its global rule inside the directory, which means
		// all of them would still pass against a reader that scanned the *parent* —
		// the walk recurses, so it finds `user_rules/preferences.md` either way. A
		// file at the level above is the one thing that tells the two apart, and it is
		// a real shape: a user who put their rules in the wrong place gets them named
		// rather than quietly carried under a directory Trae never read.
		const planned = plan({
			".trae/user_rules/inside.md": rule({ alwaysApply: "true" }),
			".trae/stray.md": rule({ alwaysApply: "true" }),
		});
		expect(writeAt(planned, "~/.labunbun/rules/inside.md")).toBeDefined();
		expect(writeAt(planned, "~/.labunbun/rules/stray.md")).toBeUndefined();
		expect(planned.items.find((item) => item.detail.includes("this importer reads nothing out of"))?.detail).toContain(
			"stray.md",
		);
	});

	test("a user_rules.md file is named as the spelling this importer does not read", () => {
		// A genuine unresolved disagreement between sources: one third-party tool
		// returns `<dir>/user_rules.md` and puts it under the OS-specific profile
		// directory rather than `~/.trae/`. The documented form is a directory, so
		// the file is named — and the reason says which reading would have found it.
		const planned = plan({ ".trae/user_rules.md": rule() });
		const item = line(planned, "user_rules.md");
		expect(item?.action).toBe("skip");
		expect(item?.detail).toContain(TRAE_USER_RULES_FILE);
		expect(item?.detail).toContain("this importer reads that");
	});
});

// ---------------------------------------------------------------------------
// The rules this build will not import
// ---------------------------------------------------------------------------

describe("trae: rules found and deliberately not imported", () => {
	test("a subdirectory's rules are named and not imported", () => {
		// Trae reads a `.trae/rules` in *any* subdirectory and applies it to that
		// subtree. A flat target directory cannot express "this subtree", so
		// importing it would apply a scoped instruction everywhere — the failure is
		// not that something is missing but that something is wrong, which is worse
		// and harder to notice.
		const planned = plan({
			".trae/rules/project.md": rule({ alwaysApply: "true" }),
			"sub/.trae/rules/nested.md": rule(),
		});
		expect(writeAt(planned, "~/.labunbun/rules/project.md")).toBeDefined();
		expect(writeAt(planned, "~/.labunbun/rules/nested.md")).toBeUndefined();
		// The line names the *directory*, not each file in it: a subtree carrying
		// forty rules is one sentence about a scoped directory, not forty.
		const named = line(planned, "sub/.trae/rules");
		expect(named?.action).toBe("skip");
		expect(named?.detail).toContain("that subtree only");
		expect(named?.detail).toContain("would make a scoped rule global");
		// And the project's own `.trae/rules` is in neither the subdirectory line nor
		// the imports' absence: it was imported one line above, and a report that
		// called the same directory both imported and not imported is the one
		// disagreement a migration must not have.
		const subdirectoryLines = planned.items.filter((item) => item.detail.includes("that subtree only"));
		expect(subdirectoryLines).toHaveLength(1);
		expect(subdirectoryLines[0].from).not.toBe("~/.trae/rules");
	});

	test("the walk does not enter the directories a project walk should skip", () => {
		// A `node_modules` with a `.trae/rules` in it is a dependency's rules, and
		// a report naming forty of them is a report nobody reads.
		const planned = plan({
			"node_modules/pkg/.trae/rules/dep.md": rule(),
			".git/.trae/rules/vcs.md": rule(),
			"dist/.trae/rules/built.md": rule(),
		});
		expect(planned.items.map((item) => item.from).join("\n")).not.toContain("node_modules");
		expect(planned.items.map((item) => item.from).join("\n")).not.toContain("dep.md");
	});

	test("the walk stops at the same depth, and the bound is stated in the module that walks it", () => {
		// The bound is the honest part of an otherwise unbounded scan, and it is
		// TRAE's own number rather than a reader's: a rules directory four levels
		// down is one TRAE did not read either, so naming it is not information the
		// user could act on by hand.
		const beyond = ["a", "b", "c", "d", "e"].join("/");
		const planned = plan({ [`${beyond}/.trae/rules/far.md`]: rule() });
		expect(planned.items.map((item) => item.from).join("\n")).not.toContain("far.md");
	});

	test("AGENTS.md at the project root is named, because this build already reads it", () => {
		// The double-import trap: this build reads the project's `AGENTS.md` where
		// it stands, so importing a second copy would put the same instructions in
		// the context twice under two owners. Trae reads all three names since
		// v3.5.18, and the other two are named for the same reason plus a settings
		// toggle this build does not have.
		const planned = plan({
			"AGENTS.md": "shared instructions",
			"CLAUDE.md": "claude instructions",
			"CLAUDE.local.md": "local instructions",
		});
		const agents = line(planned, "AGENTS.md");
		expect(agents?.action).toBe("skip");
		expect(agents?.detail).toContain("twice");
		// And nothing was written from any of the three.
		expect(planned.writes.filter((write) => write.kind === "rule")).toHaveLength(0);
		// The other two share one reason, so they share one line and both names are
		// in it — which is why this is looked up by the sentence and not by path.
		const toggled = planned.items.find((item) => item.detail.includes("settings toggle"));
		expect(toggled?.detail).toContain("2 entr(ies) not imported");
		expect(toggled?.detail).toContain("CLAUDE.local.md");
	});

	test("a home with only an AGENTS.md is still a trae install, and the sentence is printed", () => {
		// `present` gates the whole plan, so a home whose only trace is one of the
		// things this importer will not carry would print none of the sentences
		// written for it — and report "nothing migratable in it" instead.
		const planned = plan({ "AGENTS.md": "shared instructions" });
		expect(planned.items).toHaveLength(1);
		expect(planned.items[0].action).toBe("skip");
	});

	test("a home whose only trace is a subdirectory's rules is still a trae install", () => {
		// The third of the three `notImported` sentences, isolated the same way. The
		// subdirectory test above needs a project rule beside the nested one — that is
		// what proves the project's own `.trae/rules` is not counted as a subdirectory
		// — and a project rule is enough on its own to make the source `present`. So
		// without this the subdirectory sentence's reachability rested on a flag set by
		// a different fixture, and nothing would have noticed the flag being dropped.
		const planned = plan({ "sub/.trae/rules/nested.md": rule() });
		expect(planned.items).toHaveLength(1);
		expect(planned.items[0].action).toBe("skip");
		expect(planned.items[0].detail).toContain("that subtree only");
	});

	test("the cross-tool .agents/skills directory is named, and the agents source keeps it", () => {
		const planned = plan({ ".agents/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n" });
		const named = line(planned, ".agents/skills");
		expect(named?.action).toBe("skip");
		expect(named?.detail).toContain("the agents source owns the .agents convention here");
		expect(planned.writes.filter((write) => write.kind === "skill")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

describe("trae mcp", () => {
	/** A fake profile directory holding a global `mcp.json`. */
	function seedProfile(home: string, product: string, servers: unknown): void {
		process.env.APPDATA = join(home, "appdata");
		mkdirSync(profileDir(home, product), { recursive: true });
		writeFileSync(
			join(profileDir(home, product), "mcp.json"),
			typeof servers === "string" ? servers : JSON.stringify(servers),
		);
	}

	test("the global document is read from the editor profile, not from ~/.trae", () => {
		// The consequential fact in `trae-home.ts`, and the one with no vendor
		// citation behind it: Trae's rules, skills and memory all live under
		// `~/.trae/`, so a global MCP file there is the *tidy* answer and it is
		// wrong. The application resolves MCP from its VS Code profile directory.
		// `~/.trae/mcp.json` is planted too, with a different server, so a reader
		// that took the tidy answer would produce the wrong file rather than none.
		const planned = plan(
			{ ".trae/mcp.json": JSON.stringify({ mcpServers: { tidy: { type: "http", url: "https://mcp.invalid/tidy" } } }) },
			(home) => seedProfile(home, "Trae", { mcpServers: { real: { type: "http", url: "https://mcp.invalid/real" } } }),
		);
		const written = writeAt(planned, "~/.labunbun/.mcp.json")?.content ?? "";
		expect(written).toContain("real");
		expect(written).not.toContain("tidy");
		expect(line(planned, "mcpServers.real")?.action).toBe("map");
	});

	test("the path the document came from is named, because a file the user cannot find is one they assume was skipped", () => {
		let item: MigrationItem | undefined;
		let expected = "";
		withHome({}, (home) => {
			seedProfile(home, "Trae", { mcpServers: { docs: { type: "http", url: "https://mcp.invalid/d" } } });
			const planned = planMigration(readSources(home, home), {}, { only: ["trae"] });
			item = planned.items.find((entry) => entry.from.includes("mcpServers.docs"));
			// Asserted against the derivation rather than a literal, so moving the
			// profile directory has to be made here too instead of quietly leaving
			// the report pointing at a file that is not there.
			expected = traeGlobalMcpFile(profileDir(home, "Trae")).replace(/\\/g, "/").replace(home.replace(/\\/g, "/"), "~");
		});
		expect(item?.from).toContain(expected);
		expect(item?.from).toContain("appdata/Trae/User/mcp.json");
	});

	test("all four product directories are probed, and the one that answered is named", () => {
		// Not hedging: these are four separate products sharing a codebase, and the
		// directory name is the product's `nameShort` inherited from VS Code. A
		// reader that guessed one would report Trae as absent on a machine that has
		// it, and a machine with `TRAE SOLO CN` installed is a machine that has it.
		for (const product of TRAE_PRODUCT_DIRS) {
			let located: { root: string; product: string } | null | undefined;
			withHome({}, (home) => {
				process.env.APPDATA = join(home, "appdata");
				mkdirSync(join(home, "appdata", product, "User"), { recursive: true });
				located = traeUserDataRoot(home);
			});
			expect(located?.product).toBe(product);
		}
	});

	test("with none of the four installed the global half is absent rather than guessed", () => {
		let located: unknown = "unset";
		let plan_: MigrationPlan | undefined;
		withHome({ ".trae/user_rules/a.md": rule({ alwaysApply: "true" }) }, (home) => {
			located = traeUserDataRoot(home);
			plan_ = planMigration(readSources(home, home), {}, { only: ["trae"] });
		});
		expect(located).toBeNull();
		// And the rules are still imported: no profile directory is not a reason to
		// skip the half that does not need one.
		expect(writeAt(plan_ as MigrationPlan, "~/.labunbun/rules/a.md")).toBeDefined();
	});

	test("a project document is named rather than merged into the global file", () => {
		const planned = plan(
			{
				".trae/mcp.json": JSON.stringify({ mcpServers: { local: { type: "stdio", command: "node", args: ["s.js"] } } }),
			},
			(home) => seedProfile(home, "Trae", { mcpServers: { global: { type: "http", url: "https://mcp.invalid/g" } } }),
		);
		const skipped = planned.items.find((item) => item.action === "skip" && item.detail.includes("project-scope"));
		expect(skipped?.detail).toContain("<cwd>/.mcp.json");
		expect(skipped?.detail).toContain("~/.labunbun/.mcp.json");
		const written = writeAt(planned, "~/.labunbun/.mcp.json")?.content ?? "";
		expect(written).toContain("global");
		expect(written).not.toContain("local");
	});

	test("a document that is not JSON, and one whose mcpServers is not a table, are named apart", () => {
		// Two documents at two documented places, and the sentences are different
		// because the faults are: one is not JSON at all, the other parses and its
		// server table is not a table. Nothing else in this home is importable, so
		// this doubles as the assertion that a source with nothing to carry is still
		// reached — both sentences live only in the plan.
		const bad = plan({ ".trae/mcp.json": "{ not json" }, (home) => seedProfile(home, "Trae", { mcpServers: ["node"] }));
		expect(line(bad, ".trae/mcp.json")?.detail).toContain("not a JSON object");
		expect(line(bad, "mcpServers")?.detail).toContain("not a table of servers");
		expect(bad.items.length).toBeGreaterThanOrEqual(2);
	});

	test("a server table that is not a table, and nothing else, still reaches the report", () => {
		// The first of those two tests cannot fail for the wrong reason on its own,
		// because `~/.trae/mcp.json` is also an *unaccounted name in the global root*
		// — and that list is enough to make the source `present` on its own. So the
		// reachability of the malformed-server sentence is pinned here, in a home
		// where the only thing wrong is the one thing this test is about.
		const bad = plan({}, (home) => seedProfile(home, "Trae", { mcpServers: ["node"] }));
		expect(bad.items).toHaveLength(1);
		expect(bad.items[0].from.replace(/\\/g, "/")).toContain("appdata/Trae/User/mcp.json");
		expect(bad.items[0].detail).toContain("not a table of servers");
	});

	test("an environment reference in the colon spelling is named, not passed through as text", () => {
		const planned = plan({ ".trae/mcp.json": "{}" }, (home) =>
			seedProfile(home, "Trae", {
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture writes VSCode's own spelling into the file
				mcpServers: { files: { type: "stdio", command: "node", env: { ROOT: "${env:PROJECT_ROOT}" } } },
			}),
		);
		const item = line(planned, "mcpServers.files");
		expect(item?.action).toBe("downgrade");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the assertion is that this text survives unexpanded
		expect(item?.detail).toContain("${env:PROJECT_ROOT}");
		expect(item?.detail).toContain("is not expanded here");
	});
});

// ---------------------------------------------------------------------------
// The editor's storage and settings
// ---------------------------------------------------------------------------

describe("trae's editor storage and settings", () => {
	test("the state databases are named and never opened", () => {
		// The sentinel is the whole assertion. `state.vscdb` is where the chat bodies
		// are, so a reader that opened one would either fail on this non-database or
		// — worse, with a driver that creates what it opens — write into a directory
		// it promised to leave alone. Both outcomes are checked, because "nowhere in
		// the report" alone would not notice a file rewritten to the same length.
		const sentinel = "trae-state-sentinel-not-a-database";
		let located: MigrationItem | undefined;
		let report = "";
		let bytesAfter = "";
		let sizeBefore = 0;
		withHome({ ".trae/user_rules/a.md": rule({ alwaysApply: "true" }) }, (home) => {
			process.env.APPDATA = join(home, "appdata");
			mkdirSync(join(profileDir(home, "Trae"), "workspaceStorage", "abc123"), { recursive: true });
			const database = join(profileDir(home, "Trae"), "workspaceStorage", "abc123", "state.vscdb");
			writeFileSync(database, sentinel);
			sizeBefore = statSync(database).size;
			const result = runMigration({ home, cwd: home, from: "trae" });
			located = result.plan.items.find((item) => item.from.includes("editor storage"));
			report = result.report;
			bytesAfter = readFileSync(database, "utf8");
			expect(statSync(database).size).toBe(sizeBefore);
		});
		expect(located?.action).toBe("skip");
		expect(located?.detail).toContain("1 state database(s) (1 workspace, 0 global)");
		expect(located?.detail).toContain("opened by name only, never read");
		// The workspace id is a hash of the folder's path *and its creation time*, so
		// the report must not imply it is addressable by hand.
		expect(located?.detail).toContain("rather than a transcript");
		expect(report).not.toContain(sentinel);
		expect(bytesAfter).toBe(sentinel);
	});

	test("a database whose name is a directory entry of either shape is still named", () => {
		// Older VS Code workspaces are a 32-character hex digest and newer ones are a
		// numeric timestamp, and both are observed in one directory. A reader that
		// pattern-matched one shape would skip half a real install.
		let located: MigrationItem | undefined;
		withHome({}, (home) => {
			process.env.APPDATA = join(home, "appdata");
			for (const id of ["0123456789abcdef0123456789abcdef", "1758901200000"]) {
				mkdirSync(join(profileDir(home, "Trae"), "workspaceStorage", id), { recursive: true });
				writeFileSync(join(profileDir(home, "Trae"), "workspaceStorage", id, "state.vscdb"), "x");
			}
			located = planMigration(readSources(home, home), {}, { only: ["trae"] }).items.find((item) =>
				item.from.includes("editor storage"),
			);
		});
		expect(located?.detail).toContain("2 state database(s) (2 workspace, 0 global)");
	});

	test("settings.json and keybindings.json are named, and the reason is about the editor", () => {
		// Not speculative: each is named because a user coming from Trae will look
		// for it, and an importer that says nothing about the file a tool documents
		// as its main configuration reads as having missed it.
		const planned = plan({}, (home) => {
			process.env.APPDATA = join(home, "appdata");
			mkdirSync(profileDir(home, "Trae"), { recursive: true });
			writeFileSync(join(profileDir(home, "Trae"), "settings.json"), JSON.stringify({ "editor.fontSize": 14 }));
			writeFileSync(join(profileDir(home, "Trae"), "keybindings.json"), "[]");
		});
		const settings = line(planned, "settings.json");
		expect(settings?.action).toBe("skip");
		expect(settings?.detail).toContain("configure the editor rather than an agent");
		expect(line(planned, "keybindings.json")?.detail).toContain("key bindings");
	});

	test("a home with only the editor's settings is still a trae install", () => {
		// The same `present` rule as everywhere else: those two sentences exist
		// only when the plan is reached, so a home whose only trace is the editor's
		// settings must not be reported as having nothing migratable in it.
		const planned = plan({}, (home) => {
			process.env.APPDATA = join(home, "appdata");
			mkdirSync(profileDir(home, "Trae"), { recursive: true });
			writeFileSync(join(profileDir(home, "Trae"), "settings.json"), "{}");
		});
		const settings = planned.items.find((item) => item.detail.includes("configure the editor"));
		expect(settings?.from.replace(/\\/g, "/")).toContain("appdata/Trae/User/settings.json");
	});

	test("entries in the global root this importer reads nothing out of are named", () => {
		// No rule beside it, on purpose. A home with an importable rule in it is
		// `present` whatever this list says, so a rule here would leave the sentence's
		// reachability untested — the very thing this source's `present` flag exists
		// to guarantee. The lone unaccounted name has to be the whole of it.
		const planned = plan({ ".trae/somethingelse.json": "{}" });
		// Looked up by the sentence rather than by path, which is also why the rule
		// above had to go: a rule imported from `~/.trae/user_rules/` has `~/.trae` at
		// the front of its label, so a path lookup would find the wrong item and pass
		// for the wrong reason.
		const named = planned.items.find((item) => item.detail.includes("this importer reads nothing out of"));
		expect(named?.action).toBe("skip");
		expect(named?.from).toBe("~/.trae");
		expect(named?.detail).toContain("somethingelse.json");
	});
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("trae detection", () => {
	test("the two global homes and the product directory are the detection roots", () => {
		withHome({}, (home) => {
			process.env.APPDATA = join(home, "appdata");
			mkdirSync(profileDir(home, "Trae"), { recursive: true });
			const roots = traeUserDataRoot(home);
			expect(roots?.root).toBe(profileDir(home, "Trae"));
			// The detection entry is the *product* directory, one level up from
			// `User`, because `User` is created on first launch and can be empty on
			// an install that has been opened once — and a root that reads as empty
			// is a root detection skips.
			expect(join(profileDir(home, "Trae"), "..")).toContain("Trae");
		});
	});

	test("a rules file with no global home at all is a trae install", () => {
		let detected: string[] = [];
		withHome({ ".trae/rules/project.md": rule({ alwaysApply: "true" }) }, (home) => {
			detected = detectSources(home);
		});
		expect(detected).toContain("trae");
	});

	test("a home with nothing of trae's in it is not a trae install", () => {
		withHome({}, (home) => {
			expect(detectSources(home)).not.toContain("trae");
		});
	});
});

// ---------------------------------------------------------------------------
// The credential boundary
// ---------------------------------------------------------------------------

describe("trae: the credential boundary", () => {
	test("a value planted in every place a credential can be never reaches the report", () => {
		// The values below are fake. The assertion is on the rendered report, since
		// the report is what a person reads, and a report is often pasted into a
		// bug — so this is the boundary that matters.
		const headerToken = "trae-HDR-SENTINEL";
		const envToken = "trae-ENV-SENTINEL";
		let report = "";
		let items: MigrationItem[] = [];
		withHome({ ".trae/user_rules/a.md": rule({ alwaysApply: "true" }) }, (home) => {
			process.env.APPDATA = join(home, "appdata");
			mkdirSync(profileDir(home, "Trae"), { recursive: true });
			writeFileSync(
				join(profileDir(home, "Trae"), "mcp.json"),
				JSON.stringify({
					mcpServers: {
						vault: {
							type: "http",
							url: "https://mcp.invalid/v",
							headers: { Authorization: headerToken },
							env: { VAULT_TOKEN: envToken },
						},
					},
				}),
			);
			const result = runMigration({ home, cwd: home, from: "trae" });
			report = result.report;
			items = result.plan.items;
		});
		for (const value of [headerToken, envToken]) {
			expect(report).not.toContain(value);
		}
		// The name still comes out, and the file it will be written to is named, or
		// the boundary would be a silent one.
		expect(report).toContain("~/.labunbun/.mcp.json");
		expect(items.find((item) => item.from.includes("mcpServers.vault"))?.containsSecret).toBe(true);
		expect(report).toContain("including credential headers");
	});
});
