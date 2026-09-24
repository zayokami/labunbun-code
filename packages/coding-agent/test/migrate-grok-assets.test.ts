/**
 * The `grok-build` asset face: what under `$GROK_HOME` is carried, and what is
 * named instead of carried.
 *
 * Two rules shape this file. The first is that `$GROK_HOME` can point anywhere,
 * so every label has to be built from the resolved root rather than from a
 * `~/<dir>` guess — a guessed label names a file the reader never opened, which
 * is the failure `planGrokAssets` exists to avoid. The second is the credential
 * boundary, which at this level has two files rather than one: `auth.json` and
 * `mcp_credentials.json` are named and never opened, and a sentinel written into
 * either must not turn up anywhere in the plan.
 *
 * The point-name lines get tests of the same weight as the imports. A tree that
 * is walked past in silence reads as an oversight, so each of them is a
 * deliberate statement — and each one is asserted, because a statement nobody
 * checks is the kind that quietly stops being true.
 *
 * Fixture credentials are fake and say so; nothing here is key-shaped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type MigrationItem,
	type MigrationPlan,
	type PlannedWrite,
	planMigration,
	readSources,
} from "../src/migrate.ts";
import type { RawSettingsInput } from "../src/settings.ts";

type SourceTree = Record<string, string>;

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

/** Borrow an environment variable for the rest of the test. */
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

interface PlanOptions {
	/** Files already in the labunbun home when the plan is drawn. */
	labunbun?: SourceTree;
	existing?: RawSettingsInput;
	force?: boolean;
	categories?: Array<"settings" | "assets" | "history">;
}

/**
 * Run `body` against a throwaway home whose `~/.grok` holds `grok` and whose
 * `~/.labunbun` holds `labunbun`, with `$GROK_HOME` unset so the default applies.
 */
function withHome(grok: SourceTree, labunbun: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-grok-assets-"));
	made.push(home);
	const borrowedNames = ["USERPROFILE", "HOME", "GROK_HOME"];
	for (const name of borrowedNames) {
		if (!borrowed.has(name)) borrowed.set(name, process.env[name]);
	}
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		// The machine's own `$GROK_HOME`, if any, must not win over the fixture.
		delete process.env.GROK_HOME;
		writeFiles(join(home, ".grok"), grok);
		writeFiles(join(home, ".labunbun"), labunbun);
		body(home);
	} finally {
		for (const [name, value] of borrowed) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		borrowed.clear();
	}
}

/** Files keyed by path relative to a base, written with their parents. */
function writeFiles(base: string, tree: SourceTree): void {
	for (const [path, content] of Object.entries(tree)) {
		const full = join(base, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

function plan(tree: SourceTree, options: PlanOptions = {}): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome(tree, options.labunbun ?? {}, (home) => {
		planned = planMigration(readSources(home), options.existing ?? {}, {
			only: ["grok-build"],
			force: options.force,
			categories: options.categories,
		});
	});
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/** A skill laid out as grok keeps one, with the header this build reads. */
function skillFile(name: string): SourceTree {
	return { [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n` };
}

/**
 * The write queued for a target path, addressed by its tail.
 *
 * The tail is written the way the report renders it (`~/.labunbun/…`), so the
 * leading `~/` is dropped: a write carries the real path, and matching on a tilde
 * would find nothing whichever way the assertion read.
 */
function writeAt(planned: MigrationPlan, tail: string): PlannedWrite | undefined {
	const normalized = tail.replace(/\\/g, "/").replace(/^~\//, "");
	return planned.writes.find((write) => write.path.replace(/\\/g, "/").endsWith(normalized));
}

/** The first item whose source label contains `needle`. */
function line(planned: MigrationPlan, needle: string): MigrationItem | undefined {
	return planned.items.find((item) => item.from.includes(needle));
}

/** Every byte the plan would report or write, for "this value is nowhere" claims. */
function planText(planned: MigrationPlan): string {
	return JSON.stringify({ items: planned.items, writes: planned.writes });
}

describe("grok assets", () => {
	test("skills, rules and agents land in their own trees, under their own names", () => {
		const planned = plan({
			...skillFile("commit"),
			"rules/style.md": "# style\n",
			"agents/reviewer.md": "---\nname: reviewer\n---\nbody\n",
		});
		expect(writeAt(planned, "~/.labunbun/skills/commit/SKILL.md")?.kind).toBe("skill");
		expect(writeAt(planned, "~/.labunbun/rules/style.md")?.content).toBe("# style\n");
		expect(writeAt(planned, "~/.labunbun/agents/reviewer.md")?.kind).toBe("agent");
		// A rule keeps the name the user gave it: a `grok-` prefix would put it in a
		// different place in a sorted list than where they left it.
		expect(planned.writes.some((write) => write.path.includes("grok-style"))).toBe(false);
		// The label comes from the resolved root, which is what makes it a path the
		// reader actually opened rather than a `~/<dir>` guess.
		expect(line(planned, "/.grok/rules/style.md")?.to).toContain("~/.labunbun/rules/style.md");
	});

	test("a command becomes a skill, and a nested one is not invented", () => {
		const planned = plan({
			"commands/ship.md": "---\ndescription: deploy\n---\ndeploy it\n",
			"commands/fix/bugs.md": "# bugs\n",
			// A name grok would not take, so there is a skip line for the label below to
			// appear on — the label names the tree the skips came from.
			"commands/---.md": "body\n",
		});
		const write = writeAt(planned, "~/.labunbun/skills/ship/SKILL.md");
		expect(write?.kind).toBe("skill");
		expect(write?.content).toContain("name: ship");
		// grok's own scanner does not recurse, so neither does this: importing
		// `fix/bugs.md` as a skill would be one grok never had.
		expect(planned.writes.some((entry) => entry.path.includes("bugs"))).toBe(false);
		// No plugins here, so the label claims none: with a plugin in the picture the
		// skips come from two trees, and saying so then is what keeps this one honest.
		const skipLine = planned.items.find((item) => item.detail.includes("command file(s) not imported"));
		expect(skipLine?.from).toContain("~/.grok/commands");
		expect(skipLine?.from).not.toContain("each plugin's commands/");
	});

	test("a skill the source's own switches remove is named, with the key that did it", () => {
		const planned = plan({
			"config.toml": '[skills]\ndisabled = ["legacy"]\n',
			...skillFile("legacy"),
			...skillFile("kept"),
		});
		expect(writeAt(planned, "~/.labunbun/skills/legacy/SKILL.md")).toBeUndefined();
		expect(writeAt(planned, "~/.labunbun/skills/kept/SKILL.md")).toBeDefined();
		// Two lines end this way on purpose: the settings planner says the switch was
		// applied, and this one says which skill it removed. A user who forgot about
		// the switch is the one this line is for.
		const switchLines = planned.items.filter((item) => item.from.endsWith("skills.disabled, skills.ignore"));
		expect(switchLines.length).toBe(2);
		expect(switchLines[1]?.detail).toContain("legacy (disabled by [skills] disabled)");
	});

	test("a plugin's own content is imported, and each file says which plugin it came from", () => {
		const planned = plan({
			"plugins/p1/plugin.json": '{"name":"p1"}',
			"plugins/p1/skills/hello/SKILL.md": "---\nname: hello\ndescription: fixture\n---\n\nhi\n",
			"plugins/p1/agents/helper.md": "---\nname: helper\n---\nbody\n",
			"plugins/p1/commands/deploy.md": "---\ndescription: deploy\n---\ngo\n",
			"plugins/p1/commands/---.md": "body\n",
		});
		const skill = line(planned, "plugins/p1/skills/hello/SKILL.md");
		expect(skill?.to).toContain("~/.labunbun/skills/hello/SKILL.md");
		expect(skill?.detail).toContain('from plugin "p1"');
		expect(skill?.detail).toContain("loads whenever skills do");
		expect(writeAt(planned, "~/.labunbun/agents/helper.md")?.kind).toBe("agent");
		expect(line(planned, "plugins/p1/commands/deploy.md")?.detail).toContain('from plugin "p1"');
		// The skip line's label names both trees the commands came from: a skip is
		// aggregated across them, so naming one would send the user to the wrong one.
		const skipLine = planned.items.find((item) => item.detail.includes("command file(s) not imported"));
		expect(skipLine?.from).toContain("each plugin's commands/");
		// grok switches a plugin on as a unit and this build has no such unit, so the
		// report has to say the imported files now load unconditionally.
		expect(line(planned, "installed-plugins")?.detail).toContain("grok enables one as a unit");
	});

	test("the instruction file becomes a rule, under every spelling grok reads", () => {
		const planned = plan({ "AGENTS.md": "# house rules\n" });
		expect(writeAt(planned, "~/.labunbun/rules/imported-grok-build.md")?.content).toBe("# house rules\n");
		const item = line(planned, "AGENTS.md");
		expect(item?.from).toContain("Agents.md");
		// All three spellings, because the label names one file and says what grok
		// does with the rest: naming fewer would claim a spelling is not read.
		expect(item?.from).toContain("AGENT.md");
		expect(item?.detail).toContain("merges with existing memory");
	});

	test("the global memory document is carried and the workspace-scoped ones are not", () => {
		// The two sentinels are deliberately unlike the report's own prose: a fixture
		// line reading "one project's notes" would be found inside the sentence that
		// explains why it was not carried, and the assertion would fail for a reason
		// that has nothing to do with the document.
		const planned = plan({
			"memory/MEMORY.md": "# global notes\n",
			"memory/labunbun-1a2b3c4d/MEMORY.md": "# zz-workspace-legacy-not-real-zz\n",
			"memory-v2/workspaces/deadbeef/MEMORY.md": "# zz-workspace-v2-not-real-zz\n",
		});
		expect(writeAt(planned, "~/.labunbun/rules/imported-grok-build-memory.md")?.content).toBe("# global notes\n");
		// Neither project's document is carried, and neither is partly carried.
		expect(planText(planned)).not.toContain("zz-workspace-legacy-not-real-zz");
		expect(planText(planned)).not.toContain("zz-workspace-v2-not-real-zz");
		const item = line(planned, "and memory-v2");
		expect(item?.detail).toContain("2 workspace-scoped memory document(s)");
		// The consequence, not just the fact: these are loaded everywhere, so carrying
		// one would not move a note, it would widen its scope. An assertion that
		// stopped at "loaded in every workspace" would hold for a line that said
		// nothing about what importing one would do.
		expect(item?.detail).toContain("into a global instruction");
	});

	test("with v2 on, the global document comes from its tree and the legacy one is named", () => {
		const planned = plan({
			"config.toml": "[memory_v2]\nenabled = true\n",
			"memory/MEMORY.md": "# zz-legacy-doc-not-real-zz\n",
			"memory-v2/global/MEMORY.md": "# v2 global notes\n",
		});
		// The file grok actually reads. The legacy path used to be hard-coded here, and
		// the whole defect is that it went on being read after the switch flipped.
		expect(writeAt(planned, "~/.labunbun/rules/imported-grok-build-memory.md")?.content).toBe("# v2 global notes\n");
		expect(line(planned, "memory-v2/global/MEMORY.md")?.to).toContain("imported-grok-build-memory.md");
		// The document that stopped being read is neither carried nor merged, and the
		// report says so: silence here would leave the user believing both came across.
		expect(planText(planned)).not.toContain("zz-legacy-doc-not-real-zz");
		const legacy = line(planned, "memory/MEMORY.md");
		expect(legacy?.action).toBe("skip");
		expect(legacy?.detail).toContain("stopped reading when [memory_v2] enabled was set");
	});

	test("with v2 off, the legacy document is read and the v2 one is named", () => {
		const planned = plan({
			"memory/MEMORY.md": "# legacy global notes\n",
			"memory-v2/global/MEMORY.md": "# zz-v2-doc-not-real-zz\n",
		});
		expect(writeAt(planned, "~/.labunbun/rules/imported-grok-build-memory.md")?.content).toBe(
			"# legacy global notes\n",
		);
		expect(planText(planned)).not.toContain("zz-v2-doc-not-real-zz");
		const v2 = line(planned, "memory-v2/global/MEMORY.md");
		expect(v2?.detail).toContain("[memory_v2] enabled is true");
		// The limit of what a file reader can know, stated rather than papered over: the
		// switch this reader can see is the local one, and grok also honours a gate
		// pushed from the server.
		expect(v2?.detail).toContain("arriving from the server");
	});

	test("the two credential files are named and never opened", () => {
		const account = "zz-account-token-not-real-zz";
		const mcp = "zz-mcp-oauth-token-not-real-zz";
		const planned = plan({
			"auth.json": `{"tokens":{"access_token":"${account}"}}\n`,
			"mcp_credentials.json": `{"files":{"access_token":"${mcp}"}}\n`,
		});
		// Without the two lines below a plan that never opened the files at all would
		// satisfy the leak assertions for the wrong reason.
		expect(line(planned, "auth.json")?.detail).toContain("never opened");
		expect(line(planned, "mcp_credentials.json")?.detail).toContain("never opened");
		// And the line claims no credential was carried: nothing was read out of
		// either file, so a report that flags one would send the user looking for a
		// secret in a migration that holds none.
		expect(line(planned, "auth.json")?.containsSecret).toBe(false);
		expect(line(planned, "mcp_credentials.json")?.containsSecret).toBe(false);
		expect(planText(planned)).not.toContain(account);
		expect(planText(planned)).not.toContain(mcp);
	});

	test("a plugin's MCP declaration and hooks are counted, not carried", () => {
		const sentinel = "zz-plugin-declaration-not-real-zz";
		const planned = plan({
			"plugins/p1/plugin.json": '{"name":"p1"}',
			"plugins/p1/.mcp.json": `{"mcpServers":{"x":{"command":"node","env":{"K":"${sentinel}"}}}}\n`,
			"plugins/p1/hooks/hooks.json": `{"hooks":{"Stop":[{"command":"echo ${sentinel}"}]}}\n`,
			// A second plugin with only a declaration: the two counts differ, so a line
			// that reported one of them twice would not read as the same statement.
			"plugins/p2/plugin.json": '{"name":"p2"}',
			"plugins/p2/.mcp.json": `{"mcpServers":{"y":{"command":"node","env":{"K":"${sentinel}"}}}}\n`,
			...{ "plugins/p1/skills/hello/SKILL.md": "---\nname: hello\ndescription: fixture\n---\n\nhi\n" },
		});
		expect(line(planned, "hooks/hooks.json")?.detail).toContain("2 plugin MCP declaration(s) and 1 hook file(s)");
		// The plugin's skills still come across; only the files that change what a
		// session does are held back.
		expect(writeAt(planned, "~/.labunbun/skills/hello/SKILL.md")).toBeDefined();
		expect(planText(planned)).not.toContain(sentinel);
	});

	test("the trees grok keeps for itself are named, and nothing inside them is carried", () => {
		const planned = plan({
			"bundled/skills/shipped/SKILL.md": "# shipped\n",
			"marketplace-cache/repo/pkg/x": "downloaded\n",
			"lsp.json": '{"rust":{"command":"rust-analyzer"}}\n',
			"pager.toml": "[pager]\n",
			"claude_import_state.json": '{"imported_at":"whenever"}\n',
		});
		expect(line(planned, "~/.grok/bundled")?.detail).toContain("download cache");
		expect(line(planned, "~/.grok/lsp.json")?.detail).toContain("language servers");
		expect(line(planned, "~/.grok/pager.toml")?.detail).toContain("grok's own screen");
		expect(line(planned, "claude_import_state.json")?.detail).toContain("completed ~/.claude import");
		expect(planned.writes.some((write) => write.path.includes("shipped"))).toBe(false);
		// One of the two alone still gets the line, and the line names only what is
		// there: a home with a download cache and no bundled tree is the ordinary case,
		// and a label listing a directory that does not exist sends the user to look
		// for it.
		const cacheOnly = line(plan({ "marketplace-cache/repo/pkg/x": "downloaded\n" }), "marketplace-cache");
		expect(cacheOnly?.from).toBe("~/.grok/marketplace-cache");
		expect(cacheOnly?.action).toBe("skip");
	});

	test("trees with no landing place are counted, and the runtime artifacts are named", () => {
		const planned = plan({
			"personas/p.toml": "name = 'p'\n",
			"workflows/one.rhai": "fn main() {}\n",
			"workflows/two.rhai": "fn main() {}\n",
			"logs/today.log": "zz-log-line-not-real-zz\n",
		});
		const unimported = line(planned, "personas (1)");
		expect(unimported?.detail).toContain("no counterpart here");
		expect(unimported?.from).toContain("workflows (2)");
		expect(line(planned, "~/.grok/logs")?.detail).toContain("not configuration at all");
		expect(planText(planned)).not.toContain("zz-log-line-not-real-zz");
	});

	test("the labels follow $GROK_HOME, which need not sit under the home", () => {
		// The reason this planner is not `planAssetTrees`: that one renders its
		// source paths from a `~/<dir>` guess, and here the tree is a directory that
		// guess does not name — so every label would point at a file nobody opened.
		const home = makeDir("lbb-grok-assets-");
		const elsewhere = makeDir("lbb-grok-elsewhere-");
		setEnv("USERPROFILE", home);
		setEnv("HOME", home);
		setEnv("GROK_HOME", elsewhere);
		// The carried file's own label comes from the reader's path either way, so the
		// fixture needs a tree that is only ever named by the planner: the skip lines
		// are where a guessed `~/.grok` would show up.
		writeFiles(elsewhere, { "rules/style.md": "# style\n", "lsp.json": "{}\n", "personas/p.toml": "name = 'p'\n" });
		const planned = planMigration(readSources(home), {}, { only: ["grok-build"] });
		const root = elsewhere.replace(/\\/g, "/");
		expect(line(planned, `${root}/rules/style.md`)?.to).toContain("~/.labunbun/rules/style.md");
		expect(line(planned, `${root}/lsp.json`)?.action).toBe("skip");
		expect(line(planned, `${root}/personas (1)`)?.action).toBe("skip");
		expect(planned.items.some((item) => item.from.startsWith("~/.grok/"))).toBe(false);
	});

	test("a repository's own .grok tree is named as read by nobody", () => {
		// Unconditional: the tree looks like this source's, so silence about it is
		// what a user would read as a bug. The permission rules its config carries are
		// named because they are the part that would matter most if it were moved.
		const item = line(plan({ "config.toml": 'model = "grok-4"\n' }), "each repository's own .grok/");
		expect(item?.detail).toContain(".grok/config.toml");
		expect(item?.detail).toContain("trusted");
		expect(item?.detail).toContain("neither reads nor moves it");
	});

	test("a target that already holds the file is kept unless forced", () => {
		const tree = { "rules/style.md": "# from grok\n" };
		const kept = plan(tree, { labunbun: { "rules/style.md": "# mine\n" } });
		expect(writeAt(kept, "~/.labunbun/rules/style.md")).toBeUndefined();
		expect(line(kept, "/.grok/rules/style.md")?.detail).toContain("already exists");
		expect(
			writeAt(plan(tree, { labunbun: { "rules/style.md": "# mine\n" }, force: true }), "rules/style.md")?.content,
		).toBe("# from grok\n");
	});

	test("the assets category is what gates all of it", () => {
		const tree = { ...skillFile("commit"), "logs/today.log": "noise\n" };
		const settingsOnly = plan(tree, { categories: ["settings"] });
		expect(settingsOnly.writes.some((write) => write.kind === "skill")).toBe(false);
		expect(line(settingsOnly, "each repository's own .grok/")).toBeUndefined();
		expect(writeAt(plan(tree, { categories: ["assets"] }), "skills/commit/SKILL.md")?.kind).toBe("skill");
	});
});
