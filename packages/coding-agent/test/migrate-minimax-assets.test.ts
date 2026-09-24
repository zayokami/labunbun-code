/**
 * The asset half of the `minimax-code` source: what `planMinimaxAssets` takes
 * out of `<root>`, and what it names and leaves where it is.
 *
 * Three things shape this file, and all three come from the tree not being one
 * thing:
 *
 *   - **part of it is not the user's.** `readMinimaxAgents` splits
 *     `<root>/agents` three ways: a directory with an `agent.md` is the user's
 *     own, `agents/.builtin` and `.builtin-skills` are what MiniMax ships and
 *     keeps current by its own updates, and `agents/<name>/skills` is a skill
 *     tree scoped to one agent over there (`readConfiguredSkillRoots` builds that
 *     root as `agents/<agent>/skills` at priority 100, `skills/roots.ts:39-46`). A
 *     skill here is loaded into every session, so importing an agent's skills
 *     would hand every session that one agent's instructions. Each of the three
 *     is asserted with the words the report uses, because the difference is only
 *     legible in the report;
 *   - **part of it does not belong to this source at all.** `~/.claude/skills`,
 *     `~/.codex/skills` and `~/.agents/skills` are trees MiniMax *reads*
 *     (`readExternalUserSkillRoots` registers them under the keys `user-cc`,
 *     `user-codex` and `user-agents`, `skills/roots.ts:110-118`) and the
 *     `claude-code`, `codex` and `agents` sources each own one of them.
 *     `readMinimaxBorrowedTrees` honours the per-source switches in
 *     `config.yaml`, so the tests below pin that a user who has switched one off
 *     is not told about it as if it were on;
 *   - **part of it is a direction, not a copy.** `<root>/AGENTS.md` is read in
 *     every project MiniMax runs in, so it becomes a rule file that merges with
 *     existing memory rather than replacing it; `<root>/plans`, `<root>/memory`
 *     and `<root>/review-rules` are named with the reason each one is not that.
 *
 * Fixtures hold fake values only. Nothing here opens a credential path, and the
 * one credential test writes a canary into a fake `credentials.json` whose whole
 * purpose is to prove the value never appears in the plan.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type MigrationItem, type MigrationPlan, planMigration, readMinimaxCode, readSources } from "../src/migrate.ts";
import {
	MINIMAX_DATA_DIR_BASENAME,
	MINIMAX_DATA_DIR_ENV,
	MINIMAX_INSTALL_DIR,
	MINIMAX_LEGACY_DATA_DIR_ENV,
	minimaxRoot,
} from "../src/minimax-home.ts";

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
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
}

/**
 * A home with a MiniMax tree in it, and the two variables a run must not
 * inherit from the machine it is tested on: a developer with
 * `$MINIMAX_DATA_DIR` set would have every fixture read from somewhere else
 * entirely, and one with `$MAVIS_DATA_DIR` set would be handed a tree they never
 * wrote. Both are borrowed away for the rest of the test.
 *
 * The root is created even when the tree is empty, because "the directory exists
 * and holds nothing" is a state this planner has to answer for: `present` is
 * `existsSync(root)`, and an absent root is how a run for this source is left out
 * of the plan altogether.
 */
function minimaxHome(tree: Record<string, string> = {}): { home: string; root: string } {
	const home = makeDir("lbb-mm-assets-");
	setEnv(MINIMAX_DATA_DIR_ENV, undefined);
	setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, undefined);
	const root = join(home, MINIMAX_DATA_DIR_BASENAME);
	writeTree(root, tree);
	mkdirSync(root, { recursive: true });
	return { home, root };
}

/**
 * A home whose only MiniMax tree is the one under the older name.
 *
 * `minimaxHome` creates `<home>/.minimax` even when it is empty, which is exactly
 * the state that makes the legacy fallback *not* apply — so the one test that is
 * about the fallback needs a home where the default directory is absent, not
 * merely empty. Those two states are different questions and the reader answers
 * them differently.
 */
function legacyHome(tree: Record<string, string> = {}): { home: string; root: string } {
	const home = makeDir("lbb-mm-assets-");
	setEnv(MINIMAX_DATA_DIR_ENV, undefined);
	setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, undefined);
	const root = join(home, MINIMAX_DATA_DIR_BASENAME);
	writeTree(join(home, ".mavis"), tree);
	return { home, root };
}

/**
 * The plan for this home's assets alone.
 *
 * `categories: ["assets"]` rather than the default: settings and history are
 * other files' ground, and a fixture holding a `config.yaml` would otherwise mix
 * settings items into the same list as these. The two `every source → …` lines
 * the category filter adds are the only other items `source: "minimax-code"`
 * carries — the tests below match on detail or `from`, so they never count them.
 */
function plan(home: string, force = false): MigrationPlan {
	return planMigration(readSources(home), {}, { only: ["minimax-code"], categories: ["assets"], force });
}

function itemsOf(planned: MigrationPlan): MigrationItem[] {
	return planned.items.filter((item) => item.source === "minimax-code");
}

/** Every `from` label of a plan, for the tests that compare whole strings. */
function itemFroms(planned: MigrationPlan): string[] {
	return itemsOf(planned).map((item) => item.from);
}

/** The item details matching, so a test can name one line of the report. */
function detailsMatching(planned: MigrationPlan, pattern: RegExp): string[] {
	return itemsOf(planned)
		.filter((item) => pattern.test(item.detail))
		.map((item) => item.detail);
}

/** The `from` labels matching — for the lines whose subject is named there. */
function fromsMatching(planned: MigrationPlan, pattern: RegExp): string[] {
	return itemsOf(planned)
		.filter((item) => pattern.test(item.from))
		.map((item) => item.from);
}

/** The absolute paths the plan would write, sorted. */
function pathsWritten(planned: MigrationPlan): string[] {
	return planned.writes.map((write) => write.path).sort();
}

/**
 * A label with the platform's separators folded.
 *
 * Two labels in this report are built with `join` inside them — the borrowed
 * trees and the `v2` subdirectories — so on Windows the separator inside them is
 * a backslash, unlike every other path in the report, which goes through
 * `tildePath` and is slashed. The claims below are about *which* entries are
 * named, so the separators are folded before comparing rather than the claim
 * being narrowed to one platform's spelling.
 */
function slashed(text: string): string {
	return text.replace(/\\/g, "/");
}

/** Create a directory link when this machine allows one; `false` when it does not. */
function linkIfPossible(target: string, path: string): boolean {
	try {
		symlinkSync(target, path, "junction");
		return true;
	} catch {
		return false;
	}
}

describe("the tree this planner is asked about", () => {
	test("an unset variable means <home>/.minimax, and every label hangs off it", () => {
		const { home, root } = minimaxHome({ "AGENTS.md": "# rules\n" });
		// The default is not decoration: every label below is written relative to
		// `raw.root`, so a reader that resolved the wrong directory would name files it
		// never opened. `minimaxRoot` owns the rule (trim, no `~` expansion, nothing
		// canonicalised); this pins only that the planner is handed its answer.
		expect(minimaxRoot(home).root).toBe(root);
		expect(readMinimaxCode(home).root).toBe(root);
		expect(itemFroms(plan(home))).toContain("~/.minimax/AGENTS.md");
	});

	test("the assets category is the gate, and the report says what a filter left out", () => {
		const { home } = minimaxHome({ "skills/demo/SKILL.md": "# d\n" });
		// `planMinimaxAssets` is called only under `wants("assets")`. A filtered run
		// still has to say so — and it is the planning that is gated, not the read, so
		// the reader's own work is unchanged by the flag.
		expect(pathsWritten(plan(home))).toContain(join(home, ".labunbun", "skills", "demo", "SKILL.md"));
		const settingsOnly = planMigration(readSources(home), {}, { only: ["minimax-code"], categories: ["settings"] });
		expect(settingsOnly.writes.some((write) => write.kind === "skill")).toBe(false);
		expect(fromsMatching(settingsOnly, /^every source → assets$/)).toHaveLength(1);
		// Two: the assets and the history. One line each, because the two omissions are
		// separate decisions the user made.
		expect(detailsMatching(settingsOnly, /excluded by the category filter/)).toHaveLength(2);
	});
});

describe("the user's own skills", () => {
	test("a skill lands under the home's own skills directory, and the report names both ends", () => {
		const { home } = minimaxHome({
			"skills/demo/SKILL.md": "---\nname: demo\n---\n\n# demo\n",
			"skills/demo/references/api.md": "# api\n",
		});
		const planned = plan(home);
		// The target path is where the loader looks for a skill, and the label is that
		// path with the home folded to `~`, so the two columns of the report read at
		// one scale.
		expect(pathsWritten(planned)).toContain(join(home, ".labunbun", "skills", "demo", "SKILL.md"));
		const [item] = itemsOf(planned).filter((candidate) => candidate.to === "~/.labunbun/skills/demo/SKILL.md");
		expect(item.from).toBe("~/.minimax/skills/demo/SKILL.md");
		expect(item.action).toBe("map");
		// A skill is a directory, not a document: the body points at
		// `references/api.md`, so the file it points at travels too and the count is on
		// the line where the user can see that it did.
		expect(item.detail).toBe("skill copied verbatim, with 1 supporting file(s)");
		const attachment = planned.writes.find((write) => write.path.endsWith(join("demo", "references", "api.md")));
		expect(attachment?.content).toBe("# api\n");
		// The trees this planner accounts for by name must not also arrive through the
		// catch-all: a home whose `skills/` was imported and then listed as "no mapping
		// here for these" would report the same tree twice, once of them wrongly.
		expect(detailsMatching(planned, /no mapping here for these/)).toHaveLength(0);
	});

	test("a skill the target already has is kept unless --force", () => {
		const { home } = minimaxHome({ "skills/demo/SKILL.md": "# from minimax\n" });
		writeTree(home, { ".labunbun/skills/demo/SKILL.md": "# mine\n" });
		const kept = plan(home);
		// Kept means untouched: nothing is written, so the file the user already has
		// stands. That is the difference between importing a skill and replacing one.
		expect(detailsMatching(kept, /target skill already exists/)).toHaveLength(1);
		expect(pathsWritten(kept)).not.toContain(join(home, ".labunbun", "skills", "demo", "SKILL.md"));
		const forced = plan(home, true);
		const target = join(home, ".labunbun", "skills", "demo", "SKILL.md");
		expect(forced.writes.find((write) => write.path === target)?.content).toBe("# from minimax\n");
		expect(detailsMatching(forced, /target skill already exists/)).toHaveLength(0);
	});
});

describe("the user's own agents", () => {
	test("an agent becomes one document, and the assets beside it are named rather than folded in", () => {
		const { home } = minimaxHome({
			"agents/reviewer/agent.md": "---\nname: reviewer\n---\n\n# reviewer\n",
			"agents/reviewer/PERSONA.md": "you are terse\n",
			"agents/reviewer/config.yaml": "model: fixture-model-not-carried\n",
		});
		const planned = plan(home);
		// A subagent here is one document, so the target is the agent's name rather
		// than a directory with a file inside it.
		expect(pathsWritten(planned)).toContain(join(home, ".labunbun", "agents", "reviewer"));
		const [item] = itemsOf(planned).filter((candidate) => candidate.to === "~/.labunbun/agents/reviewer");
		expect(item.from).toBe("~/.minimax/agents/reviewer/agent.md");
		expect(item.action).toBe("map");
		// Both notes are on the agent's *own* line, not in a footnote somewhere else:
		// over there an agent is three documents side by side — `agent.md`,
		// `PERSONA.md` and `config.yaml` (`agent-files.ts:46-48`) — and a document here
		// has no place to put a second one; the agent's own model selection is a
		// settings decision this planner does not carry.
		expect(item.detail).toContain("PERSONA.md sits beside it and was not folded in");
		expect(item.detail).toContain("a separate prompt asset in MiniMax");
		expect(item.detail).toContain("its config.yaml (the agent's own model selection) was not carried");
		// Named is the whole of it: neither file reaches a write, and the model the
		// config selected appears nowhere in the plan.
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "agents", "reviewer", "PERSONA.md"));
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "agents", "reviewer", "config.yaml"));
		expect(JSON.stringify(planned)).not.toContain("fixture-model-not-carried");
	});

	test("an agent directory with no readable agent.md is skipped, in MiniMax's own terms", () => {
		const { home } = minimaxHome({ "agents/empty-dir/notes.txt": "x\n" });
		const planned = plan(home);
		// MiniMax's own roster skips a directory with no readable `agent.md`
		// (`listCanonicalCustomAgents` keeps only what `inspectCanonicalCustomAgent`
		// returns, `agent-files.ts:128,163-188`), so there is nothing here that would run
		// over there either. The reason travels in the `from` column, beside the
		// directory it is about, and the line as a whole says that nothing at all was
		// taken from these.
		expect(
			detailsMatching(planned, /no agent was taken from these directories, and MiniMax lists no agent/),
		).toHaveLength(1);
		expect(fromsMatching(planned, /agents\/empty-dir \(no agent\.md/)).toHaveLength(1);
		expect(pathsWritten(planned)).toHaveLength(0);
	});

	test("a skill tree under one agent is counted and named, never imported", () => {
		const { home } = minimaxHome({
			"agents/reviewer/agent.md": "# reviewer\n",
			"agents/reviewer/skills/one/SKILL.md": "---\nname: one\n---\n\n# one\n",
			"agents/reviewer/skills/two/SKILL.md": "---\nname: two\n---\n\n# two\n",
		});
		const planned = plan(home);
		// A skill here is loaded into every session, so importing these would hand the
		// whole session the instructions the user wrote for a single agent.
		const [detail] = detailsMatching(planned, /skills belonging to one agent over there/);
		expect(detail).toContain("every skill here is loaded into every session");
		expect(detail).toContain("hand the whole session the instructions you wrote for a single agent");
		expect(fromsMatching(planned, /agents\/reviewer\/skills \(2\)/)).toHaveLength(1);
		// The agent's `agent.md` still travels: the two decisions are separate, and a
		// reader who saw only the skills line would think the agent was skipped too.
		expect(pathsWritten(planned)).toContain(join(home, ".labunbun", "agents", "reviewer"));
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "skills", "one", "SKILL.md"));
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "skills", "two", "SKILL.md"));
	});
});

describe("what MiniMax ships with itself", () => {
	test("its built-in skills and agents are counted by name and never imported", () => {
		const { home } = minimaxHome({
			"agents/.builtin/main/agent.md": "# builtin agent\n",
			"agents/.builtin/mavis/agent.md": "# builtin agent two\n",
			".builtin-skills/guide/SKILL.md": "---\nname: guide\n---\n\n# guide\n",
			"AGENTS.md": "# rules\n",
		});
		const planned = plan(home);
		// Both trees are vendor-written and kept current by the source's own updates —
		// the built-in skills root is the one the runtime seeds at startup
		// (`roots.ts:48-54`), and the built-in agents live beside the user's own at
		// `agents/.builtin/<name>` (`builtinAgentDir`, `agent-files.ts:113-115`) — which
		// is the reason a copy here would go stale rather than the reason it would be
		// wrong.
		const [skills] = detailsMatching(planned, /MiniMax ships with itself, kept current by its own updates/);
		expect(skills).toContain("1 skill(s)");
		const [agents] = detailsMatching(planned, /MiniMax ships with itself, on the same footing/);
		expect(agents).toContain("2 agent(s)");
		expect(fromsMatching(planned, /\.builtin-skills \(guide\)/)).toHaveLength(1);
		// `agents/.builtin` is not offered as one agent called `.builtin`: the directory
		// holds the shipped copies, one per agent, so the names are the subject.
		expect(fromsMatching(planned, /agents\/\.builtin \(main, mavis\)/)).toHaveLength(1);
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "skills", "guide", "SKILL.md"));
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "agents", "main"));
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "agents", "mavis"));
	});
});

describe("the global instruction document", () => {
	test("AGENTS.md becomes a rule file, so it merges with memory instead of replacing it", () => {
		const { home } = minimaxHome({ "AGENTS.md": "# house rules\n" });
		const planned = plan(home);
		const write = planned.writes.find((candidate) => candidate.kind === "rule");
		expect(write?.path).toBe(join(home, ".labunbun", "rules", "imported-minimax-code.md"));
		// Byte for byte: this is a document the user wrote, and the only decision made
		// about it is which file it lands in.
		expect(write?.content).toBe("# house rules\n");
		const [item] = itemsOf(planned).filter((candidate) => candidate.to.endsWith("imported-minimax-code.md"));
		expect(item.from).toBe("~/.minimax/AGENTS.md");
		expect(item.action).toBe("map");
		// The point of the rule path: a rule file is one more document read alongside
		// the user's memory, where the `memory` kind *is* the memory. So the kind, not
		// just the directory, is part of the claim.
		expect(item.detail).toBe("imported as a rule file so it merges with existing memory instead of replacing it");
		expect(planned.writes.some((candidate) => candidate.kind === "memory")).toBe(false);
	});

	test("an existing rule file is kept unless --force", () => {
		const { home } = minimaxHome({ "AGENTS.md": "# from minimax\n" });
		writeTree(home, { ".labunbun/rules/imported-minimax-code.md": "# mine\n" });
		expect(detailsMatching(plan(home), /target rule file already exists/)).toHaveLength(1);
		const forced = plan(home, true);
		const target = join(home, ".labunbun", "rules", "imported-minimax-code.md");
		expect(forced.writes.find((write) => write.path === target)?.content).toBe("# from minimax\n");
	});

	test("an AGENTS.md that is only whitespace lands nowhere", () => {
		const { home } = minimaxHome({ "AGENTS.md": "   \n\n", "skills/demo/SKILL.md": "# d\n" });
		const planned = plan(home);
		// An empty document is not an empty rule: writing one would leave a file in the
		// user's rules directory that says nothing, while the report named it as
		// something that had been imported.
		expect(planned.writes.some((candidate) => candidate.path.endsWith("imported-minimax-code.md"))).toBe(false);
		// Matched on the whole label rather than on `AGENTS.md`: the unconditional
		// project line names `CLAUDE.md/AGENTS.md` whatever the tree holds, so a
		// looser pattern would fail here for a reason that has nothing to do with
		// this document.
		expect(fromsMatching(planned, /^~\/\.minimax\/AGENTS\.md$/)).toHaveLength(0);
		// The rest of the tree is unaffected — the whitespace check is about this one
		// document, not about the run.
		expect(pathsWritten(planned)).toContain(join(home, ".labunbun", "skills", "demo", "SKILL.md"));
	});
});

describe("the trees that are named and left", () => {
	test("installed plugins are named and counted, and never walked", () => {
		const { home } = minimaxHome({
			"plugins/alpha/plugin.json": JSON.stringify({ name: "alpha" }),
			"plugins/alpha/skills/from-plugin/SKILL.md": "---\nname: from-plugin\n---\n\n# p\n",
			"AGENTS.md": "# rules\n",
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /installed plugin\(s\)/);
		expect(detail).toContain("their skills and agents ship with the plugin and are updated with it");
		expect(detail).toContain("this build has no plugin system to track that");
		expect(fromsMatching(planned, /plugins \(alpha\)/)).toHaveLength(1);
		// Their skills ship with the plugin and are updated with it, so a copy here
		// would be a second, frozen copy of something the user is still updating.
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "skills", "from-plugin", "SKILL.md"));
	});

	test("plans, memory and review-rules get three lines and three reasons", () => {
		const { home } = minimaxHome({
			"plans/one.md": "# plan\n",
			"memory/topic.md": "# note\n",
			"review-rules/style.md": "# be terse\n",
			"AGENTS.md": "# rules\n",
		});
		const planned = plan(home);
		// One line each rather than one line for all three: the reasons differ, and a
		// merged line would have to pick one of them.
		const [plans] = detailsMatching(planned, /plan document\(s\) you approved and kept/);
		expect(plans).toContain("a document about one piece of work");
		expect(plans).toContain("not an instruction for every session");
		const [memory] = detailsMatching(planned, /long-term notes/);
		expect(memory).toContain("its own memory feature reads and writes per topic");
		expect(memory).toContain("nothing here reads that layout");
		expect(memory).toContain("notes that nothing maintains");
		// The review rules are the one case where importing would be *possible* and
		// false: over there they are spliced into a review prompt, so here they would
		// read as standing instructions for every session of every project — the
		// opposite of what they are.
		const [review] = detailsMatching(planned, /instructions for MiniMax's code reviewer/);
		expect(review).toContain("splices into a review prompt");
		expect(review).toContain("read in every session of every project");
		expect(fromsMatching(planned, /\/(plans|memory|review-rules) \(/)).toHaveLength(3);
		// The instruction document itself still imports; only the three directories are
		// named and left.
		expect(pathsWritten(planned)).toHaveLength(1);
	});

	test("the older layout's ledgers and the composer's unsent text are named together", () => {
		const { home } = minimaxHome({
			"v2/chats/one/ledger.json": "{}",
			"v2/mcode/drafts/two.txt": "words the user typed and never sent\n",
			"AGENTS.md": "# rules\n",
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /holds the ledgers of MiniMax's older layout/);
		expect(detail).toContain("the composer text you typed and never sent");
		expect(detail).toContain("a draft is not something you asked to send");
		// One line for the two, because they are one decision: neither is a settings
		// document. The names still have to say which is which — a reader who saw `v2`
		// alone could not tell what was being left behind.
		const [from] = fromsMatching(planned, /\/v2 \(/);
		expect(slashed(from)).toContain("v2/chats/one");
		expect(slashed(from)).toContain("v2/mcode/drafts/two");
		// A draft is text the user wrote and did not send. Importing it would put words
		// in their mouth in a session that has no turn for them — the one thing the text
		// itself cannot say is that it was never meant to be a message.
		expect(JSON.stringify(planned)).not.toContain("words the user typed and never sent");
		expect(pathsWritten(planned)).toHaveLength(1);
	});

	test("a credential-shaped entry is named, and no value of it is anywhere in the plan", () => {
		const sentinel = "SENTINEL-NOT-A-KEY-3c71";
		const { home } = minimaxHome({
			// Key-shaped in the file and obviously fake in the value: the claim is that
			// the *value* is never read, which a fixture whose value looked plausible
			// could not make.
			"credentials.json": JSON.stringify({ apiKey: sentinel }),
			"auth/token.json": JSON.stringify({ accessToken: sentinel }),
			"AGENTS.md": "# rules\n",
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /credential-shaped entries reported by name/);
		expect(detail).toContain("no value in them was read, and none is carried");
		// Both are named — the file and the directory — because the pattern matches
		// names rather than kinds: a credential directory is as unread as a credential
		// file, and the user has to be able to see that both were noticed.
		const [from] = fromsMatching(planned, /credentials\.json/);
		expect(from).toBe("~/.minimax/auth, credentials.json");
		expect(JSON.stringify(planned)).not.toContain(sentinel);
		// The reader's own return value is held to the same rule: the names travel, the
		// contents do not.
		expect(JSON.stringify(readMinimaxCode(home))).not.toContain(sentinel);
		// An entry the credentials line has claimed is not also reported as a directory
		// with no mapping — one tree, one line.
		expect(fromsMatching(planned, /auth \(/)).toHaveLength(0);
		expect(detailsMatching(planned, /no mapping here for these/)).toHaveLength(0);
	});

	test("a directory with no mapping is named with its size, so nothing looks forgotten", () => {
		const { home } = minimaxHome({ "AGENTS.md": "# rules\n" });
		writeTree(home, { ".minimax/logs/a.log": "x\n", ".minimax/logs/b.log": "y\n" });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /no mapping here for these/);
		expect(detail).toContain("left where they are");
		// The count is what makes the line actionable: a name alone could be one file or
		// a thousand, and this reader never opened any of them.
		expect(fromsMatching(planned, /logs \(2\)/)).toHaveLength(1);
		expect(JSON.stringify(planned)).not.toContain("a.log");
	});
});

describe("the directory that is not this tree", () => {
	test("the installer's own directory is named as program files, not state", () => {
		const { home } = minimaxHome({ "AGENTS.md": "# rules\n" });
		writeTree(home, { [join(MINIMAX_INSTALL_DIR, "package.json")]: "{}" });
		const planned = plan(home);
		// `~/.minimax-code` is where the installer unpacks the package, and — before the
		// current default — the data directory of older source builds, which the default
		// deliberately neither moves nor merges with. It is named, and nothing inside it
		// is read: a `package.json` there is a program, not a setting.
		const [detail] = detailsMatching(planned, /installer's own directory/);
		expect(detail).toContain("the data directory of older source builds");
		expect(detail).toContain("program files, not your state");
		expect(fromsMatching(planned, /^~\/\.minimax-code$/)).toHaveLength(1);
		expect(pathsWritten(planned)).toHaveLength(1);
	});
});

describe("the older tree, which is read only when it is the only one", () => {
	test("a ~/.mavis on its own is read, and the report says so", () => {
		const { home } = legacyHome({
			"skills/from-mavis/SKILL.md": "---\nname: from-mavis\n---\n\n# m\n",
			"AGENTS.md": "# old rules\n",
		});
		const planned = plan(home);
		// The vendor renames this tree into `.minimax` on its next start, so on a machine
		// that has not yet run a current build it is the only tree there is — reading it
		// is reading exactly what the vendor would read.
		expect(pathsWritten(planned)).toContain(join(home, ".labunbun", "skills", "from-mavis", "SKILL.md"));
		expect(fromsMatching(planned, /^~\/\.mavis\/AGENTS\.md$/)).toHaveLength(1);
		const [detail] = detailsMatching(planned, /older name/);
		expect(detail).toContain(
			"this run read it, because the directory under the current name holds nothing on this machine",
		);
		// The assets inside it say where they came from rather than being relabelled as if
		// the default directory had held them.
		expect(itemFroms(planned)).toContain("~/.mavis/skills/from-mavis/SKILL.md");
	});

	test("a ~/.minimax that holds anything is the tree, and the legacy one is named unread", () => {
		const { home } = minimaxHome({ "skills/new/SKILL.md": "# n\n" });
		writeTree(home, { ".mavis/skills/old/SKILL.md": "# o\n" });
		const planned = plan(home);
		// MiniMax reads `.minimax` when it holds anything, and its own move of the old
		// tree is a *rename*, never a merge, so two trees on one machine are one tree's
		// worth of decisions plus a backup.
		const [detail] = detailsMatching(planned, /older name/);
		expect(detail).toContain("this run did not read");
		expect(detail).toContain("a rename rather than a merge");
		expect(itemFroms(planned)).not.toContain("~/.mavis/skills/old/SKILL.md");
		expect(pathsWritten(planned)).toContain(join(home, ".labunbun", "skills", "new", "SKILL.md"));
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "skills", "old", "SKILL.md"));
	});

	test("a .mavis that links to the current tree is the same tree, so there is no line at all", () => {
		const { home } = minimaxHome({ "skills/new/SKILL.md": "# n\n" });
		// The vendor leaves a link behind when a rename is refused, so on a machine that
		// has run any build of this tool the old name is not a second tree. Importing
		// from both would import every skill and every session twice.
		if (!linkIfPossible(join(home, ".minimax"), join(home, ".mavis"))) return;
		const planned = plan(home);
		expect(fromsMatching(planned, /mavis/)).toHaveLength(0);
		expect(readMinimaxCode(home).legacyRead).toBe(false);
		expect(readMinimaxCode(home).legacyRoot).toBeNull();
		expect(itemFroms(planned)).toContain("~/.minimax/skills/new/SKILL.md");
	});

	/**
	 * The fallback is a content test, not an existence test — which is the vendor's
	 * own rule and was a defect here until it was fixed.
	 *
	 * `readMinimaxCode` decided it with `!existsSync(primary.root)`, while the vendor
	 * asks `contentState(newDir)`: `empty` is a directory with no entries, or with
	 * only an empty `workspace/` (`data-dir.ts:110-125`) — not a directory that is
	 * *absent*. On `empty` with data on the legacy side it moves the legacy tree into
	 * the primary and reads that (`data-dir.ts:306-330`). So a `.minimax` that exists
	 * and holds nothing is exactly the state where MiniMax reads the user's data —
	 * and where this reader used to read the empty directory and report the source as
	 * having nothing.
	 */
	test("a ~/.minimax that exists and holds nothing still leaves the legacy tree the one to read", () => {
		const { home } = minimaxHome();
		writeTree(home, {
			".mavis/skills/from-mavis/SKILL.md": "---\nname: from-mavis\n---\n\n# m\n",
			".mavis/AGENTS.md": "# old rules\n",
		});
		// `minimaxHome` already made the directory — empty, which is the whole point
		// of this fixture. Nothing is written into it.
		const planned = plan(home);
		expect(readMinimaxCode(home).legacyRead).toBe(true);
		expect(pathsWritten(planned)).toContain(join(home, ".labunbun", "skills", "from-mavis", "SKILL.md"));
		// The sentence is on the item's `detail`, which is where the reader's words
		// live: the `from` of that line is the legacy path itself, so the assertion
		// has to look at the field that carries the reason.
		expect(
			detailsMatching(
				planned,
				/this run read it, because the directory under the current name holds nothing on this machine/,
			),
		).toHaveLength(1);
	});

	/**
	 * The other half of the same content test: a directory holding nothing *but* an
	 * empty `workspace/` is `empty` to the vendor as well (`contentState` checks that
	 * one name on its own), so it falls back too. A `workspace/` with anything in it
	 * is `hasData` and the primary answers.
	 */
	test("an empty workspace/ is the same as empty, and a populated one is not", () => {
		const { home } = minimaxHome();
		writeTree(home, { ".mavis/skills/from-mavis/SKILL.md": "---\nname: from-mavis\n---\n\n# m\n" });
		// An empty directory, not a directory with an empty file in it: the vendor
		// asks `readdirSync(workspace).length`, so one dotfile is enough to make it
		// `hasData` — and the second half of this test is that boundary.
		mkdirSync(join(home, ".minimax", "workspace"), { recursive: true });
		expect(readMinimaxCode(home).legacyRead).toBe(true);
		expect(pathsWritten(plan(home))).toContain(join(home, ".labunbun", "skills", "from-mavis", "SKILL.md"));

		const other = minimaxHome();
		writeTree(other.home, {
			".mavis/skills/from-mavis/SKILL.md": "---\nname: from-mavis\n---\n\n# m\n",
			".minimax/workspace/notes.md": "# work\n",
		});
		expect(readMinimaxCode(other.home).legacyRead).toBe(false);
		expect(readMinimaxCode(other.home).root).toBe(join(other.home, ".minimax"));
	});

	/**
	 * A link is not a directory, and asking "does this path hold anything" without
	 * following it answers no for a tree full of sessions. The vendor follows it on
	 * both sides: a legacy link's content is its target's
	 * (`linkTargetDirectoryContentState`, `data-dir.ts:301-308`) and it then moves
	 * that target in (`:323-324`); a primary link never gets a content test of its
	 * own at all, it is simply used (`:372`). These two tests are that pair — the
	 * first pins reading *through* a legacy link, the second that a link on the
	 * current name holding data is not a reason to move the older tree in.
	 */
	test("a legacy name that is a link to a tree elsewhere answers with that tree", () => {
		const { home } = legacyHome();
		const elsewhere = makeDir("lbb-mm-linked-");
		writeTree(elsewhere, { "skills/from-mavis/SKILL.md": "---\nname: from-mavis\n---\n\n# m\n" });
		// The vendor's own compat link is the ordinary case (`.mavis` → `.minimax`,
		// which `minimaxLegacyDataDir` already reports as one tree); this is the other
		// one — a junction a user made, pointing at where their data actually lives.
		if (!linkIfPossible(elsewhere, join(home, ".mavis"))) return;
		expect(readMinimaxCode(home).legacyRead).toBe(true);
		expect(pathsWritten(plan(home))).toContain(join(home, ".labunbun", "skills", "from-mavis", "SKILL.md"));
		expect(itemFroms(plan(home))).toContain("~/.mavis/skills/from-mavis/SKILL.md");
	});

	test("a current name that is a link to a tree holding data is the tree, and the older name is left alone", () => {
		const { home } = legacyHome({ "skills/old/SKILL.md": "---\nname: old\n---\n\n# o\n" });
		const elsewhere = makeDir("lbb-mm-linked-");
		writeTree(elsewhere, { "skills/new/SKILL.md": "---\nname: new\n---\n\n# n\n" });
		if (!linkIfPossible(elsewhere, join(home, ".minimax"))) return;
		const planned = plan(home);
		expect(readMinimaxCode(home).legacyRead).toBe(false);
		expect(readMinimaxCode(home).root).toBe(join(home, ".minimax"));
		expect(pathsWritten(planned)).toContain(join(home, ".labunbun", "skills", "new", "SKILL.md"));
		expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "skills", "old", "SKILL.md"));
	});

	/**
	 * The other half of "not a directory": a plain file is not read as data, and the
	 * two names answer differently. The vendor migrates the legacy tree *onto* the
	 * current name when the current name is a file, so the content that ends up in
	 * use is the legacy tree's (`data-dir.ts:342-347`, then `:372-377` for a legacy
	 * that is not a directory either); a legacy *file* is only ever renamed onto —
	 * never read — so the current name is the tree.
	 */
	test("a name that is a plain file is never data, and which tree answers follows from that", () => {
		const { home } = legacyHome({ "skills/from-mavis/SKILL.md": "---\nname: from-mavis\n---\n\n# m\n" });
		writeFileSync(join(home, ".minimax"), "this is not a directory\n");
		expect(readMinimaxCode(home).legacyRead).toBe(true);
		expect(pathsWritten(plan(home))).toContain(join(home, ".labunbun", "skills", "from-mavis", "SKILL.md"));

		const fileLegacy = minimaxHome({ "skills/new/SKILL.md": "---\nname: new\n---\n\n# n\n" });
		writeFileSync(join(fileLegacy.home, ".mavis"), "neither is this\n");
		const planned = plan(fileLegacy.home);
		expect(readMinimaxCode(fileLegacy.home).legacyRead).toBe(false);
		expect(readMinimaxCode(fileLegacy.home).root).toBe(join(fileLegacy.home, ".minimax"));
		expect(pathsWritten(planned)).toContain(join(fileLegacy.home, ".labunbun", "skills", "new", "SKILL.md"));
		expect(detailsMatching(planned, /older name/)[0]).toContain("this run did not read");

		// And where that rule is the only one deciding: nothing under the current name
		// at all, and a file under the older one. A legacy *directory* answers in that
		// position; a legacy file is only ever renamed onto, so the empty current name
		// stays the tree.
		const emptyPrimary = minimaxHome();
		writeFileSync(join(emptyPrimary.home, ".mavis"), "still not a directory\n");
		expect(readMinimaxCode(emptyPrimary.home).legacyRead).toBe(false);
		expect(readMinimaxCode(emptyPrimary.home).root).toBe(join(emptyPrimary.home, ".minimax"));
	});

	/**
	 * The one pair where the vendor moves nothing: empty under the current name and
	 * empty under the older one. Its move is guarded on the *legacy* tree holding
	 * data — `legacyContent === 'hasData'` (`data-dir.ts:318-321`) — so with both
	 * empty it keeps the current name and reads an empty tree. Which tree answered
	 * is the same "nothing" either way; what a test can see is that this run does
	 * not claim to have read the older one, and the sentence it gives for that has
	 * to be true of *both* reasons a run leaves the older tree alone.
	 */
	test("two names that both hold nothing leave the older one unread", () => {
		const { home } = minimaxHome();
		mkdirSync(join(home, ".mavis"), { recursive: true });
		const planned = plan(home);
		expect(readMinimaxCode(home).legacyRead).toBe(false);
		expect(readMinimaxCode(home).root).toBe(join(home, ".minimax"));
		const [detail] = detailsMatching(planned, /older name/);
		expect(detail).toContain("this run did not read");
		expect(detail).toContain("where the two hold nothing at all it is the current name it keeps");
	});
});

describe("the trees MiniMax reads but does not own", () => {
	test("another tool's skill tree is named as one, and never imported", () => {
		const { home } = minimaxHome({ "AGENTS.md": "# rules\n" });
		writeTree(home, {
			".claude/skills/cc/SKILL.md": "---\nname: cc\n---\n\n# cc\n",
			".codex/skills/cx/SKILL.md": "---\nname: cx\n---\n\n# cx\n",
			".agents/skills/ag/SKILL.md": "---\nname: ag\n---\n\n# ag\n",
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /trees MiniMax reads because they belong to other tools/);
		expect(detail).toContain("Claude Code's, Codex's and the shared `~/.agents` one");
		expect(detail).toContain("the sources that own them import them");
		expect(detail).toContain("two copies of every skill");
		const [from] = fromsMatching(planned, /\.claude/);
		expect(slashed(from)).toBe("~/.claude/skills, ~/.codex/skills, ~/.agents/skills");
		for (const name of ["cc", "cx", "ag"]) {
			expect(pathsWritten(planned)).not.toContain(join(home, ".labunbun", "skills", name, "SKILL.md"));
		}
	});

	test("only the trees that are there are named", () => {
		const { home } = minimaxHome({ "AGENTS.md": "# rules\n" });
		writeTree(home, { ".claude/skills/cc/SKILL.md": "# cc\n" });
		// A user with no Codex install should not be told their Codex skills are being
		// skipped; the existence check is what keeps the line about their machine.
		const [from] = fromsMatching(plan(home), /\.claude/);
		expect(slashed(from)).toBe("~/.claude/skills");
	});

	test("skills.external.enabled: false is a user decision this reader honours", () => {
		const { home } = minimaxHome({
			"config.yaml": ["skills:", "  external:", "    enabled: false", ""].join("\n"),
			"AGENTS.md": "# rules\n",
		});
		writeTree(home, {
			".claude/skills/cc/SKILL.md": "# cc\n",
			".codex/skills/cx/SKILL.md": "# cx\n",
			".agents/skills/ag/SKILL.md": "# ag\n",
		});
		// Hands off entirely: naming a tree as borrowed when the master switch is off
		// would be telling the user something about their own config that is not true.
		expect(readMinimaxCode(home).borrowedTrees).toEqual([]);
		expect(detailsMatching(plan(home), /belong to other tools/)).toHaveLength(0);
	});

	test("switching one source off drops that one and leaves the others", () => {
		// `readMinimaxBorrowedTrees` reads `skills.external.sources.<key>.enabled`, and the
		// three keys are the vendor's own — the same three `readExternalUserSkillRoots`
		// registers at `skills/roots.ts:116-118`, each gated by its own `enabled` in
		// `externalSkillRoot` (`:122-138`). All three are on by default, which the tests
		// above rely on.
		const { home } = minimaxHome({
			"config.yaml": ["skills:", "  external:", "    sources:", "      user-codex:", "        enabled: false", ""].join(
				"\n",
			),
			"AGENTS.md": "# rules\n",
		});
		writeTree(home, {
			".claude/skills/cc/SKILL.md": "# cc\n",
			".codex/skills/cx/SKILL.md": "# cx\n",
			".agents/skills/ag/SKILL.md": "# ag\n",
		});
		expect(readMinimaxCode(home).borrowedTrees).toEqual([join(".claude", "skills"), join(".agents", "skills")]);
		// The switch is per source and it is the *user's*: the other two are untouched,
		// and the line that remains names only what is still being read.
		const [from] = fromsMatching(plan(home), /\.claude/);
		expect(slashed(from)).toBe("~/.claude/skills, ~/.agents/skills");
	});

	test("the source kind is honoured under the name it had before the rename too", () => {
		// `user-cc` was `user-claude` until the source kinds were renamed, and the
		// vendor still reads the old spelling: `LEGACY_SOURCE_KEY_BY_KIND` maps
		// `user-cc → user-claude` and `parseSkillsConfig` falls back to it when the
		// current key is absent (`skills-config.ts:41-46, 110-121`). A reader that
		// only knew the new name would tell a user who switched the source off under
		// the old one that it is on — the exact mistake this function exists to
		// avoid.
		const { home } = minimaxHome({
			"config.yaml": [
				"skills:",
				"  external:",
				"    sources:",
				"      user-claude:",
				"        enabled: false",
				"",
			].join("\n"),
			"AGENTS.md": "# rules\n",
		});
		writeTree(home, {
			".claude/skills/cc/SKILL.md": "# cc\n",
			".codex/skills/cx/SKILL.md": "# cx\n",
		});
		expect(readMinimaxCode(home).borrowedTrees).toEqual([join(".codex", "skills")]);
	});

	test("the current spelling wins when both are written", () => {
		// `Object.hasOwn(sourcesObj, kind)` decides which one is read, so the new
		// name is not merely preferred — the old one is not consulted at all once
		// the new key is there (`skills-config.ts:113-119`). Reading the legacy key
		// first would turn the source *on* against a switch the user had just set.
		const { home } = minimaxHome({
			"config.yaml": [
				"skills:",
				"  external:",
				"    sources:",
				"      user-claude:",
				"        enabled: true",
				"      user-cc:",
				"        enabled: false",
				"",
			].join("\n"),
			"AGENTS.md": "# rules\n",
		});
		writeTree(home, {
			".claude/skills/cc/SKILL.md": "# cc\n",
			".codex/skills/cx/SKILL.md": "# cx\n",
		});
		expect(readMinimaxCode(home).borrowedTrees).toEqual([join(".codex", "skills")]);
	});

	test("the current spelling is what is read, table or not", () => {
		// `Object.hasOwn` is the whole test the vendor makes (`skills-config.ts:113-119`),
		// and `parseSource` then reads a value that is not a table as "leave it as it
		// was" (`:41-46`). So a current key that is present but meaningless *shadows*
		// the old name — the old switch is not consulted at all, and the source stays
		// on. A reader that only fell back to the legacy key when the current one was
		// unreadable would report this source as switched off, which is a setting the
		// user does not have.
		const { home } = minimaxHome({
			"config.yaml": [
				"skills:",
				"  external:",
				"    sources:",
				'      user-cc: "off"',
				"      user-claude:",
				"        enabled: false",
				"",
			].join("\n"),
			"AGENTS.md": "# rules\n",
		});
		writeTree(home, {
			".claude/skills/cc/SKILL.md": "# cc\n",
			".codex/skills/cx/SKILL.md": "# cx\n",
		});
		expect(readMinimaxCode(home).borrowedTrees).toEqual([join(".claude", "skills"), join(".codex", "skills")]);
	});

	test("a value that is not a table leaves the default in place", () => {
		// How the source itself reads it: `skills.external` as a string is not a switch
		// and turns nothing off — reading it as one would invent a setting the user
		// never made.
		const { home } = minimaxHome({ "config.yaml": 'skills:\n  external: "yes"\n', "AGENTS.md": "# rules\n" });
		writeTree(home, { ".claude/skills/cc/SKILL.md": "# cc\n" });
		expect(readMinimaxCode(home).borrowedTrees).toEqual([join(".claude", "skills")]);
	});
});

describe("the line that is always there", () => {
	test("a project's own files are said to live beside the project, read and moved nowhere", () => {
		// The smallest home this planner will run for: the root exists and holds nothing
		// at all. `.mcp.json` and `CLAUDE.md`/`AGENTS.md` beside a working directory look
		// like this source's files, so a user who does not find them mentioned reads the
		// silence as a bug — which is why this line is unconditional rather than tied to
		// anything being found.
		const { home } = minimaxHome();
		const planned = plan(home);
		const [item] = itemsOf(planned).filter((candidate) => candidate.from.startsWith("each working directory's own"));
		expect(item.from).toBe("each working directory's own .mcp.json and CLAUDE.md/AGENTS.md");
		expect(item.action).toBe("skip");
		expect(item.to).toBe("—");
		const [detail] = detailsMatching(planned, /live beside the project/);
		expect(detail).toContain("neither reads nor moves them");
		// The reader order is stated because it is a fact about the source the user can
		// act on: MiniMax takes the first of the two names that exists, so a project with
		// a stale `CLAUDE.md` never sees its `AGENTS.md` at all.
		expect(detail).toContain("MiniMax reads the document under the first of those names that exists");
		expect(planned.writes).toHaveLength(0);
	});
});
