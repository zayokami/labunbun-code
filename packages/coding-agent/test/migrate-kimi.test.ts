/**
 * The `kimi-code` source: where the tree is, and what the planner takes from it.
 *
 * Kimi Code reads `$KIMI_CODE_HOME` two ways, and the two disagree about a value
 * that looks empty. The engine's bootstrap keeps it — `homeDir ?? env[…] ??
 * join(osHomeDir, '.kimi-code')` — and the CLI's data-dir helper drops it —
 * `if (envDir)`. The reader follows the CLI, because the files it opens are the
 * CLI's; a whitespace-only value is a path to both halves, so that one has a test
 * of its own. Nothing else is done to the value: no `~` expansion, no `resolve`,
 * no existence requirement.
 *
 * The planner's decisions are policy calls, and a policy call that is not written
 * down reads as an oversight, so each one is pinned here with the words that carry
 * it: `auto` is not mapped because the nearest mode here does the opposite,
 * `[permission].rules` is not imported because kimi never loads it, a hook array
 * with one bad entry is not partly imported because kimi rejects the whole array.
 *
 * Fixtures hold fake values only, and the credential sentinel is deliberately not
 * key-shaped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KIMI_CODE_DEFAULT_DIR, kimiInputHistoryFile, kimiRoot } from "../src/kimi-home.ts";
import {
	detectSources,
	MIGRATION_SOURCE_IDS,
	MIGRATION_SOURCE_LABELS,
	type MigrationItem,
	type MigrationPlan,
	normalizeKimiHooks,
	parseFromOption,
	planMigration,
	readKimiCode,
	readSources,
	runMigration,
} from "../src/migrate.ts";
import { listHistory, readHistory } from "../src/migrate-history.ts";
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

/** One file at an absolute path, with the directories it needs. */
function writeFileAt(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/**
 * One session under `sessions/<bucket>/<id>/`, in the layout kimi writes: a
 * `state.json` beside the journal, which is what makes the listing call the
 * directory a conversation rather than a folder.
 */
function writeKimiSession(root: string, id: string, cwd: string): void {
	const dir = join(root, "sessions", "wd_proj_abc123", id);
	writeFileAt(
		join(dir, "agents", "main", "wire.jsonl"),
		`${[
			JSON.stringify({ type: "metadata", time: 1, protocol_version: "1.5", created_at: 1 }),
			JSON.stringify({
				time: 2,
				type: "context.append_message",
				message: { role: "user", content: [{ type: "text", text: "canary-from-kimi" }] },
			}),
		].join("\n")}\n`,
	);
	writeFileAt(join(dir, "state.json"), JSON.stringify({ cwd, agents: { main: { type: "main" } } }));
}

/**
 * A home with a kimi tree in it, and the two variables a run must not inherit
 * from the machine it is tested on: a developer with `$KIMI_CODE_HOME` set would
 * have every fixture read from the wrong directory, and one with
 * `$KIMI_SHARE_DIR` set would get a predecessor tree they never wrote.
 */
function kimiHome(tree: Record<string, string> = {}): { home: string; root: string } {
	const home = makeDir("lbb-kimi-home-");
	setEnv("KIMI_CODE_HOME", undefined);
	setEnv("KIMI_SHARE_DIR", undefined);
	const root = join(home, KIMI_CODE_DEFAULT_DIR);
	writeTree(root, tree);
	return { home, root };
}

function plan(home: string, existing: RawSettingsInput = {}, force = false): MigrationPlan {
	return planMigration(readSources(home), existing, { only: ["kimi-code"], force });
}

function itemsOf(planned: MigrationPlan): MigrationItem[] {
	return planned.items.filter((item) => item.source === "kimi-code");
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

/** The settings file the plan would write, parsed. */
function settingsWritten(planned: MigrationPlan): Record<string, unknown> {
	const write = planned.writes.find((candidate) => candidate.kind === "settings");
	return write === undefined ? {} : (JSON.parse(write.content) as Record<string, unknown>);
}

/** The MCP file the plan would write, parsed into its server table. */
function mcpWritten(planned: MigrationPlan): Record<string, Record<string, unknown>> {
	const write = planned.writes.find((candidate) => candidate.kind === "mcp");
	if (write === undefined) return {};
	const parsed = JSON.parse(write.content) as { mcpServers: Record<string, Record<string, unknown>> };
	return parsed.mcpServers;
}

describe("the Kimi Code root", () => {
	test("an unset variable means ~/.kimi-code", () => {
		const home = makeDir("lbb-kimi-root-");
		setEnv("KIMI_CODE_HOME", undefined);
		expect(kimiRoot(home)).toBe(join(home, KIMI_CODE_DEFAULT_DIR));
		expect(kimiRoot(home)).toBe(join(home, ".kimi-code"));
	});

	test("an empty variable is unset, but a whitespace one is a directory name", () => {
		const home = makeDir("lbb-kimi-root-");
		setEnv("KIMI_CODE_HOME", "");
		expect(kimiRoot(home)).toBe(join(home, ".kimi-code"));
		// The CLI's `if (envDir)` keeps all three of these, so each names a directory
		// the reader has to follow it to: reading them as unset would import
		// `~/.kimi-code` while kimi itself writes to somewhere else entirely.
		for (const blank of ["   ", "\t", "\n"]) {
			setEnv("KIMI_CODE_HOME", blank);
			expect(kimiRoot(home)).toBe(blank);
		}
	});

	test("a ~ is a directory name, not the home directory", () => {
		const home = makeDir("lbb-kimi-root-");
		setEnv("KIMI_CODE_HOME", "~/elsewhere");
		expect(kimiRoot(home)).toBe("~/elsewhere");
		expect(kimiRoot(home)).not.toBe(join(home, "elsewhere"));
	});

	test("a relative value stays relative", () => {
		const home = makeDir("lbb-kimi-root-");
		setEnv("KIMI_CODE_HOME", "kimi-state");
		expect(kimiRoot(home)).toBe("kimi-state");
	});

	test("the variable is read per call, not snapshotted at import", () => {
		const home = makeDir("lbb-kimi-root-");
		setEnv("KIMI_CODE_HOME", undefined);
		const first = kimiRoot(home);
		setEnv("KIMI_CODE_HOME", join(home, "moved"));
		expect(kimiRoot(home)).not.toBe(first);
	});
});

describe("the seventh source", () => {
	test("it is appended, so the six before it keep their places", () => {
		// Named change: this asserted `kimi-code` was the *last* id. `minimax-code`
		// was appended after it, so the claim kept here is the one the title makes —
		// this source sits after the six, and still does — rather than "no source
		// will ever be added after it". The list is append-only, so the position is
		// the durable half of the old assertion.
		expect(MIGRATION_SOURCE_IDS.indexOf("kimi-code")).toBe(6);
		expect(MIGRATION_SOURCE_IDS.slice(0, 6)).toEqual([
			"claude-code",
			"codex",
			"zcode",
			"agents",
			"deepseek-harness",
			"grok-build",
		]);
		expect(MIGRATION_SOURCE_LABELS["kimi-code"]).toBe("Kimi Code");
	});

	test("--from kimi-code is accepted, and a misspelling still names the whole list", () => {
		const home = makeDir("lbb-kimi-root-");
		expect(parseFromOption("kimi-code", home)).toEqual(["kimi-code"]);
		const bad = parseFromOption("kimi", home);
		expect(bad).toHaveProperty("error");
		expect((bad as { error: string }).error).toContain("kimi-code");
	});

	test("detection follows $KIMI_CODE_HOME, and wants content rather than a directory", () => {
		const inside = kimiHome({ "skills/demo/SKILL.md": "# demo\n" });
		expect(detectSources(inside.home)).toContain("kimi-code");

		const home = makeDir("lbb-kimi-elsewhere-");
		const moved = join(home, "state");
		writeTree(moved, { "skills/demo/SKILL.md": "# demo\n" });
		setEnv("KIMI_CODE_HOME", moved);
		expect(detectSources(home)).toContain("kimi-code");

		// An empty root is not a source: the question it would ask has one answer.
		const empty = makeDir("lbb-kimi-empty-");
		mkdirSync(join(empty, "nothing-here"), { recursive: true });
		setEnv("KIMI_CODE_HOME", join(empty, "nothing-here"));
		expect(detectSources(empty)).not.toContain("kimi-code");
	});
});

describe("the category filter", () => {
	/** A home with one of each, so a category can be seen to hold the rest back. */
	function both(): { home: string } {
		return kimiHome({
			"config.toml": 'defaultModel = "kimi-k3"\n',
			"skills/demo/SKILL.md": "---\nname: demo\n---\n\n# demo\n",
		});
	}

	test("--only assets leaves the settings side unplanned", () => {
		// The gate is the only thing keeping `settings` out of this run: without it the
		// settings planner runs and claims `model`, so a run the user scoped to assets
		// would write settings.json anyway.
		const { home } = both();
		const planned = planMigration(readSources(home), {}, { only: ["kimi-code"], categories: ["assets"] });
		expect(planned.categories).toEqual(["assets"]);
		expect(planned.writes.some((write) => write.kind === "settings")).toBe(false);
		expect(planned.writes.map((write) => write.path)).toContain(join(home, ".labunbun", "skills", "demo", "SKILL.md"));
	});

	test("--only settings leaves the asset side unplanned", () => {
		const { home } = both();
		const planned = planMigration(readSources(home), {}, { only: ["kimi-code"], categories: ["settings"] });
		expect(planned.writes.some((write) => write.kind === "settings")).toBe(true);
		expect(planned.writes.map((write) => write.path)).not.toContain(
			join(home, ".labunbun", "skills", "demo", "SKILL.md"),
		);
	});
});

describe("the model", () => {
	test("an alias is written as the model behind it, and reported under the name kimi used", () => {
		// `kimi-k2.5` is a spelling the provider still answers and the model behind it is
		// `kimi-k2.6`. Both halves matter: writing the alias would leave settings.json
		// naming something this build has no row for, and reporting the resolved id would
		// stop naming the line of config.toml the value came from.
		const { home } = kimiHome({ "config.toml": 'defaultModel = "kimi-k2.5"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBe("kimi-k2.6");
		const [item] = itemsOf(planned).filter((candidate) => candidate.detail.includes('mapped to "kimi-k2.6"'));
		expect(item.from).toContain('"kimi-k2.5"');
	});

	test("a name this build knows is mapped", () => {
		const { home } = kimiHome({ "config.toml": 'defaultModel = "kimi-k3"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBe("kimi-k3");
		const [item] = itemsOf(planned).filter((candidate) => candidate.detail.includes('mapped to "kimi-k3"'));
		expect(item.to).toBe("settings.json → model");
		expect(item.from).toContain("→ defaultModel");
	});

	test("a name this build does not know is skipped, with the reason", () => {
		const { home } = kimiHome({ "config.toml": 'defaultModel = "kimi-k9-unreleased"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		expect(detailsMatching(planned, /no model of that name exists here/)).toHaveLength(1);
	});

	test("a name pointing into the user's own [models] table is named, never guessed at", () => {
		const { home } = kimiHome({
			"config.toml": ['defaultModel = "fast"', "", "[models.fast]", 'provider = "moonshot"', ""].join("\n"),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		const [detail] = detailsMatching(planned, /names an entry of your own \[models\] table/);
		expect(detail).toContain("endpoint");
		// The table itself is named in the same report, and its keys are not read: an
		// entry may hold an inline key, and reading one to write it into a second file
		// is the thing this importer never does.
		expect(fromsMatching(planned, /→ models \(fast\)/)).toHaveLength(1);
		expect(detailsMatching(planned, /1 model alias\(es\) of your own/)).toHaveLength(1);
	});

	test("a defaultModel that is not a string is not a model name", () => {
		const { home } = kimiHome({ "config.toml": "defaultModel = 7\n" });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		expect(detailsMatching(planned, /^not a model name$/)).toHaveLength(1);
	});
});

describe("the permission posture", () => {
	test("manual and yolo map", () => {
		const manual = kimiHome({ "config.toml": 'defaultPermissionMode = "manual"\n' });
		expect(settingsWritten(plan(manual.home)).permissionMode).toBe("default");

		const yolo = kimiHome({ "config.toml": 'defaultPermissionMode = "yolo"\n' });
		expect(settingsWritten(plan(yolo.home)).permissionMode).toBe("bypassPermissions");
	});

	test("auto is left alone, and the line says why the nearest mode is the wrong one", () => {
		const { home } = kimiHome({ "config.toml": 'defaultPermissionMode = "auto"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
		const [detail] = detailsMatching(planned, /approves the calls it judges safe/);
		expect(detail).toContain("dontAsk");
		expect(detail).toContain("denied");
	});

	test("a mode kimi does not define is a skip that says it never decided a session", () => {
		const { home } = kimiHome({ "config.toml": 'defaultPermissionMode = "godmode"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
		expect(detailsMatching(planned, /not a mode kimi defines/)).toHaveLength(1);
	});

	test("plan mode is the starting mode, and the permission mode is named rather than folded into it", () => {
		const { home } = kimiHome({ "config.toml": 'defaultPlanMode = true\ndefaultPermissionMode = "yolo"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBe("plan");
		const [item] = itemsOf(planned).filter((candidate) =>
			candidate.detail.includes("this build takes one starting mode"),
		);
		expect(item.from).toContain('defaultPermissionMode ("yolo")');
		expect(settingsWritten(planned).permissionMode).not.toBe("bypassPermissions");
	});

	test("a plan mode that is not exactly true is not plan mode", () => {
		const { home } = kimiHome({ "config.toml": 'defaultPlanMode = "true"\n' });
		expect(settingsWritten(plan(home)).permissionMode).toBeUndefined();
	});

	test("[permission].rules is named and not imported, because kimi loads none of it", () => {
		// The shape kimi's own documentation writes (`decision`, `pattern`, one
		// `[[permission.rules]]` table per rule), so the line's count is the count of
		// rules a reader of the file would make.
		const { home } = kimiHome({
			"config.toml": [
				"[[permission.rules]]",
				'decision = "allow"',
				'pattern = "Read"',
				"",
				"[[permission.rules]]",
				'decision = "deny"',
				'pattern = "Bash(rm -rf*)"',
				"",
			].join("\n"),
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /kimi reads permission rules from live session state/);
		expect(detail).toContain("2 rule(s)");
		expect(detail).toContain("(1 allow, 1 deny)");
		expect(detail).toContain("live-only");
		// Nothing from the table reaches this build's rule list.
		expect(settingsWritten(planned).permissions).toBeUndefined();
	});

	test("the dangerous-command guard is named, and the direction it points is said", () => {
		const { home } = kimiHome({ "config.toml": "[permission]\ndangerousCommandGuard = false\n" });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /stops asking about the commands it classifies as dangerous/);
		expect(detail).toContain("no such guard");
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
	});
});

describe("hooks", () => {
	test("seconds become milliseconds, and an untimed hook gets a longer wait here", () => {
		const { home } = kimiHome({
			"config.toml": [
				"[[hooks]]",
				'event = "PreToolUse"',
				'matcher = "Bash"',
				'command = "echo hi"',
				"timeout = 30",
				"",
				"[[hooks]]",
				'event = "Stop"',
				'command = "echo bye"',
				"",
			].join("\n"),
		});
		const planned = plan(home);
		const hooks = settingsWritten(planned).hooks as Record<
			string,
			Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>
		>;
		expect(hooks.PreToolUse[0].hooks[0].timeout).toBe(30_000);
		expect(hooks.PreToolUse[0].hooks[0].command).toBe("echo hi");
		expect(hooks.Stop[0].hooks[0].timeout).toBeUndefined();
		const [detail] = detailsMatching(planned, /converted from the seconds kimi counts/);
		expect(detail).toContain("kimi waits 30 s, this build 60 s");
		expect(detail).toContain("2 hook entr(ies) across 2 event(s)");
	});

	test("a matcher written as an alternation is split, not imported as a literal", () => {
		const { home } = kimiHome({
			"config.toml": ["[[hooks]]", 'event = "PreToolUse"', 'matcher = "Bash|Write"', 'command = "echo hi"', ""].join(
				"\n",
			),
		});
		const planned = plan(home);
		const hooks = settingsWritten(planned).hooks as Record<string, Array<{ matcher?: string }>>;
		expect(hooks.PreToolUse.map((entry) => entry.matcher)).toEqual(["Bash", "Write"]);
		const [detail] = detailsMatching(planned, /split into one entry per name/);
		expect(detail).toContain("Bash|Write");
	});

	test("a matcher with a pattern character this build escapes is dropped and counted", () => {
		const { home } = kimiHome({
			"config.toml": ["[[hooks]]", 'event = "PreToolUse"', 'matcher = "mcp__.*__delete"', 'command = "x"', ""].join(
				"\n",
			),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).hooks).toBeUndefined();
		const [detail] = detailsMatching(planned, /nothing here would run/);
		expect(detail).toContain("pattern characters this build escapes");
	});

	test("a hook event this build has no name for is counted, not written", () => {
		const { home } = kimiHome({
			"config.toml": ["[[hooks]]", 'event = "SessionHeartbeat"', 'command = "x"', ""].join("\n"),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).hooks).toBeUndefined();
		const [detail] = detailsMatching(planned, /event\(s\) with no hook here/);
		expect(detail).toContain("SessionHeartbeat");
	});

	test("one entry kimi itself would reject keeps the whole array out", () => {
		const { home } = kimiHome({
			"config.toml": [
				"[[hooks]]",
				'event = "PreToolUse"',
				'command = "echo ok"',
				"",
				"[[hooks]]",
				'event = "PreToolUse"',
				'command = "echo bad"',
				'unknownKey = "x"',
				"",
			].join("\n"),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).hooks).toBeUndefined();
		const [detail] = detailsMatching(planned, /kimi's own schema holds this to one shape per entry/);
		expect(detail).toContain("it runs none of these either");
	});

	test("a key kimi does not know keeps the entry out, whatever the key is called", () => {
		// Kimi's schema is strict and the four names it reads are the whole table, so
		// any other key rejects the array. "Any other" can only be sampled, which is why
		// each spelling below is its own claim: one fixture carrying one unknown name
		// pins that name alone and lets the table widen by one without a sound.
		for (const key of ["note", "description", "enabled", "timeoutMs", "once"]) {
			const { home } = kimiHome({
				"config.toml": ["[[hooks]]", 'event = "Stop"', 'command = "x"', `${key} = "x"`, ""].join("\n"),
			});
			const planned = plan(home);
			expect(settingsWritten(planned).hooks).toBeUndefined();
			expect(detailsMatching(planned, /kimi's own schema holds this to one shape per entry/)).toHaveLength(1);
		}
	});

	test("every entry goes down with the array, and the report says how many", () => {
		// Kimi rejects the array rather than the entry, so the loss is the whole file —
		// here both entries are the user's and one of them was valid. A count of one
		// would describe a file with one entry, which is not the file that was read.
		const { home } = kimiHome({
			"config.toml": [
				"[[hooks]]",
				'event = "PreToolUse"',
				'command = "echo ok"',
				"",
				"[[hooks]]",
				'event = "Stop"',
				'command = "echo bad"',
				'timeout = "30"',
				"",
			].join("\n"),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).hooks).toBeUndefined();
		const [detail] = detailsMatching(planned, /kimi's own schema holds this to one shape per entry/);
		expect(detail).toContain("all 2 entr(ies) here went with it");
	});

	test("a timeout at kimi's own ceiling is never clamped", () => {
		// 600 is kimi's ceiling and this build's longest wait, so the two agree at the
		// edge: the largest value kimi accepts must convert without a clamping note,
		// which is what makes "a value kimi accepts is never clamped" true.
		const normalized = normalizeKimiHooks([{ event: "Stop", command: "x", timeout: 600 }]);
		expect(normalized.config.Stop[0].hooks[0].timeout).toBe(600_000);
		expect(normalized.clampedTimeouts).toBe(0);
		expect(normalized.convertedTimeouts).toBe(1);
		expect(normalized.untimedHandlers).toBe(0);
	});

	test("an entry with a timeout above kimi's ceiling is not a hook kimi has", () => {
		// Not a value kimi could have run, so the report says the array was left alone
		// rather than describing a wait that never happened there.
		const normalized = normalizeKimiHooks([{ event: "Stop", command: "x", timeout: 601 }]);
		expect(normalized.malformed).toBe(1);
		expect(Object.keys(normalized.config)).toHaveLength(0);
	});

	test("hooks the target already defines are kept unless --force", () => {
		const { home } = kimiHome({
			"config.toml": ["[[hooks]]", 'event = "Stop"', 'command = "echo kimi"', ""].join("\n"),
		});
		const existing: RawSettingsInput = {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
		};
		const kept = plan(home, existing);
		expect(detailsMatching(kept, /target already defines hooks/)).toHaveLength(1);
		// Kept means untouched: no hooks key is written, so the target's own config
		// stands — which is the difference between keeping and copying over.
		expect(settingsWritten(kept).hooks).toBeUndefined();
		const forced = plan(home, existing, true);
		expect(JSON.stringify(settingsWritten(forced).hooks)).toContain("echo kimi");
	});
});

describe("the spelling kimi writes", () => {
	/**
	 * `config.toml` holds snake_case keys, because kimi's own writer renames every
	 * scalar with `camelToSnake` (`packages/node-sdk/src/config/toml.ts:447`) and its
	 * reader renames them back with `snakeToCamel` (`:35-41`, applied to every
	 * top-level key). Both spellings are legal on the way in, and the docs use the
	 * snake one (`docs/en/configuration/config-files.md:523`), so a reader that only
	 * knows the camel spelling misses the settings in every file kimi itself wrote.
	 */
	const kimiSpelled = [
		'default_model = "kimi-k9-unreleased"',
		'default_permission_mode = "yolo"',
		'extra_skill_dirs = ["~/team-skills"]',
		"",
		"[permission]",
		"dangerous_command_guard = false",
		"",
		"[models.fast]",
		'api_key = "fixture-value-not-a-key"',
		"",
	].join("\n");
	const camelSpelled = [
		'defaultModel = "kimi-k9-unreleased"',
		'defaultPermissionMode = "yolo"',
		'extraSkillDirs = ["~/team-skills"]',
		"",
		"[permission]",
		"dangerousCommandGuard = false",
		"",
		"[models.fast]",
		'apiKey = "fixture-value-not-a-key"',
		"",
	].join("\n");

	test("default_model is the model setting, not a key with no mapping", () => {
		const { home } = kimiHome({ "config.toml": kimiSpelled });
		const planned = plan(home);
		// The name is looked up, and it is not one this build knows, so the line says
		// so — the outcome a file spelled the other way gets.
		expect(detailsMatching(planned, /no model of that name exists here/)).toHaveLength(1);
		expect(detailsMatching(planned, /no mapping for and no note about/)).toHaveLength(0);
	});

	test("default_permission_mode is the posture, and it maps", () => {
		const { home } = kimiHome({ "config.toml": kimiSpelled });
		expect(settingsWritten(plan(home)).permissionMode).toBe("bypassPermissions");
	});

	test("dangerous_command_guard is named with the direction it points", () => {
		const { home } = kimiHome({ "config.toml": kimiSpelled });
		const [detail] = detailsMatching(plan(home), /stops asking about the commands it classifies as dangerous/);
		expect(detail).toContain("no such guard");
	});

	test("an api_key inside an alias counts as a key that was not read", () => {
		const { home } = kimiHome({ "config.toml": kimiSpelled });
		const planned = plan(home);
		const [models] = detailsMatching(planned, /model alias\(es\) of your own/);
		expect(models).toContain("1 of them set an apiKey, which was not read");
		// And the value behind it is carried nowhere, whichever way the key is spelled.
		expect(JSON.stringify(planned)).not.toContain("fixture-value-not-a-key");
	});

	test("extra_skill_dirs names the same trees extraSkillDirs does", () => {
		const { home } = kimiHome({ "config.toml": kimiSpelled });
		writeTree(home, { "team-skills/from-team/SKILL.md": "---\nname: from-team\n---\n\n# t\n" });
		const planned = plan(home);
		expect(planned.writes.map((write) => write.path)).toContain(
			join(home, ".labunbun", "skills", "from-team", "SKILL.md"),
		);
		expect(detailsMatching(planned, /named by \[extraSkillDirs\]/)).toHaveLength(1);
	});

	test("a file in either spelling produces the same plan", () => {
		const snake = kimiHome({ "config.toml": kimiSpelled });
		writeTree(snake.home, { "team-skills/from-team/SKILL.md": "---\nname: from-team\n---\n\n# t\n" });
		const camel = kimiHome({ "config.toml": camelSpelled });
		writeTree(camel.home, { "team-skills/from-team/SKILL.md": "---\nname: from-team\n---\n\n# t\n" });
		const lines = (home: string): string =>
			JSON.stringify(
				itemsOf(plan(home)).map((item) => ({ from: item.from, to: item.to, action: item.action, detail: item.detail })),
			);
		expect(lines(snake.home)).toBe(lines(camel.home));
	});
});

describe("config.toml sections with no mapping", () => {
	test("models, providers and the MCP timeouts are named", () => {
		const { home } = kimiHome({
			"config.toml": [
				"[models.fast]",
				'provider = "moonshot"',
				'apiKey = "fixture-value-not-a-key"',
				"",
				"[providers.moonshot]",
				'baseURL = "https://example.invalid/v1"',
				"",
				"[mcp]",
				"startupTimeoutMs = 20000",
				"",
			].join("\n"),
		});
		const planned = plan(home);
		const [models] = detailsMatching(planned, /model alias\(es\) of your own/);
		expect(models).toContain("1 of them set an apiKey, which was not read");
		expect(models).toContain("still in config.toml");
		expect(detailsMatching(planned, /named provider endpoints/)).toHaveLength(1);
		expect(detailsMatching(planned, /connect and tool timeouts/)).toHaveLength(1);
		// The key itself is carried nowhere.
		expect(JSON.stringify(planned)).not.toContain("fixture-value-not-a-key");
	});

	test("a section with no note of its own reaches the report through the sweep", () => {
		const { home } = kimiHome({
			"config.toml": [
				"[tools]",
				'enabled = ["bash"]',
				"",
				"[swarm]",
				"maxAgents = 2",
				"",
				"[madeUpKey]",
				"x = 1",
				"",
			].join("\n"),
		});
		const planned = plan(home);
		expect(detailsMatching(planned, /per-tool enable list/)).toHaveLength(1);
		expect(detailsMatching(planned, /parallel-agent settings/)).toHaveLength(1);
		// The sweep names keys in the `from` column, not in the prose.
		expect(fromsMatching(planned, /→ madeUpKey/)).toHaveLength(1);
		expect(detailsMatching(planned, /no mapping for and no note about/)).toHaveLength(1);
	});

	test("a listed section carries its own reason, not the sweep's", () => {
		// Every section in the table has a reason written for it and the sweep is what
		// catches the ones that do not, so a section that fell out of the table would
		// still be named — in the `from` column, with the sweep's generic line. Only
		// the reason itself tells the two apart, which is what this pins.
		const { home } = kimiHome({ "config.toml": ["[subagent]", "maxConcurrent = 2", ""].join("\n") });
		const planned = plan(home);
		expect(detailsMatching(planned, /kimi's own subagent limits/)).toHaveLength(1);
		expect(fromsMatching(planned, /→ subagent$/)).toHaveLength(1);
		expect(detailsMatching(planned, /no mapping for and no note about/)).toHaveLength(0);
	});

	test("a config.toml that cannot be parsed is reported rather than read as absent", () => {
		const { home } = kimiHome({ "config.toml": "this is not = = toml\n" });
		const planned = plan(home);
		expect(detailsMatching(planned, /config.toml could not be parsed/)).toHaveLength(1);
		expect(detailsMatching(planned, /missing whatever it held/)).toHaveLength(1);
	});
});

describe("mcp.json", () => {
	test("a stdio server is carried with its args, env and cwd", () => {
		const { home } = kimiHome({
			"mcp.json": JSON.stringify(
				{ local: { command: "npx", args: ["-y", "some-server"], env: { LOG_LEVEL: "info" }, cwd: "/tmp/work" } },
				null,
				"\t",
			),
		});
		const server = mcpWritten(plan(home)).local;
		expect(server.type).toBe("stdio");
		expect(server.command).toBe("npx");
		expect(server.args).toEqual(["-y", "some-server"]);
		expect(server.env).toEqual({ LOG_LEVEL: "info" });
		expect(server.cwd).toBe("/tmp/work");
	});

	test("a server whose command is empty is not a server", () => {
		const { home } = kimiHome({ "mcp.json": JSON.stringify({ broken: { command: "" } }) });
		const planned = plan(home);
		expect(mcpWritten(planned).broken).toBeUndefined();
		expect(detailsMatching(planned, /does not match the supported stdio\/http shapes/)).toHaveLength(1);
	});

	test("a remote server keeps its url, and one with no auth is said to be OAuth", () => {
		const { home } = kimiHome({
			"mcp.json": JSON.stringify({ hosted: { transport: "http", url: "https://example.invalid/mcp" } }),
		});
		const planned = plan(home);
		expect(mcpWritten(planned).hosted.url).toBe("https://example.invalid/mcp");
		const [detail] = detailsMatching(planned, /authorises it with OAuth by default/);
		expect(detail).toContain("authorise it again here");
		expect(detail).toContain("copied verbatim");
	});

	test("an SSE server is a downgrade that says which transports this client speaks", () => {
		const { home } = kimiHome({
			"mcp.json": JSON.stringify({ legacy: { transport: "sse", url: "https://example.invalid/sse", auth: "none" } }),
		});
		const planned = plan(home);
		expect(mcpWritten(planned).legacy.url).toBe("https://example.invalid/sse");
		const [detail] = detailsMatching(planned, /SSE server/);
		expect(detail).toContain("stdio or StreamableHTTP");
		// `auth: "none"` is not OAuth, so that line must not be there as well.
		expect(detailsMatching(planned, /authorises it with OAuth by default/)).toHaveLength(0);
	});

	test("a bearer token is named by its variable, and no value is carried", () => {
		const sentinel = "SENTINEL-EXPANDED-9c1f";
		const { home } = kimiHome({
			"mcp.json": JSON.stringify({
				gated: { transport: "http", url: "https://example.invalid/mcp", bearerTokenEnvVar: "KIMI_MCP_TOKEN" },
			}),
		});
		// The variable is set to something recognisable: the client here expands no
		// variables, so a report that resolved it would write a live token into a file
		// — and that is the failure this pins, not just the wording around it.
		setEnv("KIMI_MCP_TOKEN", sentinel);
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /bearer token came from \$KIMI_MCP_TOKEN/);
		expect(detail).toContain("not expanded here");
		expect(detailsMatching(planned, /authorises it with OAuth by default/)).toHaveLength(0);
		expect(JSON.stringify(planned)).not.toContain(sentinel);
	});

	test("a server kimi had switched off is skipped, because this build has no off switch", () => {
		const { home } = kimiHome({ "mcp.json": JSON.stringify({ parked: { command: "npx", enabled: false } }) });
		const planned = plan(home);
		expect(mcpWritten(planned).parked).toBeUndefined();
		expect(detailsMatching(planned, /disabled in kimi/)).toHaveLength(1);
	});

	test("an entry that is not an object is not a server either", () => {
		const { home } = kimiHome({ "mcp.json": JSON.stringify({ odd: "npx -y somewhere" }) });
		const planned = plan(home);
		expect(detailsMatching(planned, /entry is not a server definition/)).toHaveLength(1);
	});

	test("the settings kimi keeps for a server do not disappear without a word", () => {
		const { home } = kimiHome({
			"mcp.json": JSON.stringify({
				big: { command: "npx", deferred: true, toolTimeoutMs: 5000, disabledTools: ["drop"] },
			}),
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /no counterpart here/);
		expect(detail).toContain("deferred");
		expect(detail).toContain("toolTimeoutMs");
		expect(detail).toContain("disabledTools");
		// Still carried — the settings are named, the server is not dropped for them.
		expect(mcpWritten(planned).big.command).toBe("npx");
	});

	test("a server with credential-bearing env says so, and the item is marked", () => {
		const { home } = kimiHome({
			"mcp.json": JSON.stringify({ keyed: { command: "npx", env: { SERVICE_API_KEY: "fixture-not-a-key" } } }),
		});
		const planned = plan(home);
		const [item] = itemsOf(planned).filter((candidate) => candidate.to === ".mcp.json → mcpServers.keyed");
		expect(item.detail).toContain("including credential headers");
		expect(item.containsSecret).toBe(true);
	});

	test("a server whose name the target already uses is kept unless --force", () => {
		const { home } = kimiHome({ "mcp.json": JSON.stringify({ shared: { command: "npx", args: ["kimi"] } }) });
		writeTree(home, {
			".labunbun/.mcp.json": JSON.stringify({ mcpServers: { shared: { type: "stdio", command: "mine" } } }),
		});
		const kept = plan(home);
		expect(detailsMatching(kept, /target already defines a server with this name/)).toHaveLength(1);
		// Nothing was added, so no MCP file is written at all.
		expect(kept.writes.some((write) => write.kind === "mcp")).toBe(false);
		const forced = plan(home, {}, true);
		expect(mcpWritten(forced).shared.command).toBe("npx");
	});
});

describe("assets", () => {
	test("skills, agents and AGENTS.md land where the loader looks", () => {
		const { home } = kimiHome({
			"skills/demo/SKILL.md": "---\nname: demo\ndescription: fixture\n---\n\n# demo\n",
			"skills/demo/references/api.md": "# api\n",
			"agents/reviewer.md": "---\nname: reviewer\ndescription: fixture\n---\n\n# reviewer\n",
			"AGENTS.md": "# house rules\n",
		});
		const planned = plan(home);
		const paths = planned.writes.map((write) => write.path);
		expect(paths).toContain(join(home, ".labunbun", "skills", "demo", "SKILL.md"));
		expect(paths).toContain(join(home, ".labunbun", "skills", "demo", "references", "api.md"));
		expect(paths).toContain(join(home, ".labunbun", "agents", "reviewer.md"));
		expect(paths).toContain(join(home, ".labunbun", "rules", "imported-kimi-code.md"));
		const rule = planned.writes.find((write) => write.path.endsWith("imported-kimi-code.md"));
		expect(rule?.content).toBe("# house rules\n");
		const [ruleItem] = itemsOf(planned).filter((item) => item.to.endsWith("imported-kimi-code.md"));
		expect(ruleItem.from).toContain(".kimi-code/AGENTS.md");
		// The directories the reader accounts for by name must not also arrive through
		// the catch-all: a home whose `skills/` was imported and then listed as "no
		// mapping here for these" would report the same tree twice, once wrongly.
		expect(detailsMatching(planned, /no mapping here for these/)).toHaveLength(0);
	});

	test("an AGENTS.md that is only whitespace lands nowhere", () => {
		const { home } = kimiHome({ "AGENTS.md": "   \n\n", "skills/demo/SKILL.md": "# d\n" });
		const planned = plan(home);
		expect(planned.writes.some((write) => write.path.endsWith("imported-kimi-code.md"))).toBe(false);
	});

	test("the shared ~/.agents tree is named and left to its own source", () => {
		const { home } = kimiHome({ "AGENTS.md": "# mine\n" });
		writeTree(home, { ".agents/skills/shared/SKILL.md": "---\nname: shared\n---\n\n# shared\n" });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /part of the shared `~\/\.agents` tree/);
		expect(detail).toContain("the `agents` source imports it");
		expect(detail).toContain("two copies");
		expect(planned.writes.map((write) => write.path)).not.toContain(
			join(home, ".labunbun", "skills", "shared", "SKILL.md"),
		);
	});

	test("an AGENTS.md under a moved $KIMI_CODE_HOME is named where it was read", () => {
		// The root is not always `<home>/.kimi-code`. With the variable set, a report
		// that spelled the default would name a file this run never opened — and the
		// file it did open would go unnamed.
		const home = makeDir("lbb-kimi-moved-");
		const moved = join(home, "state");
		writeTree(moved, { "AGENTS.md": "# house rules\n", "skills/demo/SKILL.md": "---\nname: demo\n---\n\n# d\n" });
		setEnv("KIMI_CODE_HOME", moved);
		const planned = plan(home);
		const [item] = itemsOf(planned).filter((candidate) => candidate.to.endsWith("imported-kimi-code.md"));
		expect(item.from).toContain("~/state/AGENTS.md");
		expect(item.from).not.toContain(".kimi-code");
	});

	test("an extra skill directory under ~ is read, and its files say where they came from", () => {
		const { home } = kimiHome({ "config.toml": 'extraSkillDirs = ["~/team-skills"]\n' });
		writeTree(home, { "team-skills/from-team/SKILL.md": "---\nname: from-team\n---\n\n# t\n" });
		const planned = plan(home);
		expect(planned.writes.map((write) => write.path)).toContain(
			join(home, ".labunbun", "skills", "from-team", "SKILL.md"),
		);
		const [detail] = detailsMatching(planned, /named by \[extraSkillDirs\]/);
		expect(detail).toContain("from-team");
		expect(fromsMatching(planned, /→ extraSkillDirs \(~/)).toHaveLength(1);
		// "map" is the half that says those files were read: a skip carrying the same
		// label would name the setting and leave everything it points at behind.
		const [item] = itemsOf(planned).filter((candidate) => candidate.from.includes("→ extraSkillDirs ("));
		expect(item.action).toBe("map");
	});

	test("a relative extra directory belongs to the source's project, so it is named and not opened", () => {
		const { home } = kimiHome({ "config.toml": 'extraAgentDirs = ["tools/agents"]\n' });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /these entries are relative/);
		expect(detail).toContain("repository, not to this home");
		expect(planned.writes).toHaveLength(0);
	});

	test("a home whose extra directories are all absolute says nothing about relative ones", () => {
		// That line reports something that is there. Emitting it with an empty list
		// would put a sentence about the project's tree into a run that never saw one,
		// which reads as a loss that did not happen.
		const { home } = kimiHome({ "config.toml": 'extraSkillDirs = ["~/team-skills"]\n' });
		const planned = plan(home);
		expect(detailsMatching(planned, /these entries are relative/)).toHaveLength(0);
	});

	test("installed plugins are counted by name, because a copy of one stops being updated", () => {
		const { home } = kimiHome({
			"plugins/alpha/plugin.json": JSON.stringify({ name: "alpha" }),
			"plugins/alpha/skills/from-plugin/SKILL.md": "---\nname: from-plugin\n---\n\n# p\n",
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /installed plugin\(s\)/);
		expect(detail).toContain("no plugin system");
		expect(planned.writes.map((write) => write.path)).not.toContain(
			join(home, ".labunbun", "skills", "from-plugin", "SKILL.md"),
		);
		expect(fromsMatching(planned, /plugins \(alpha\)/)).toHaveLength(1);
	});

	test("a credential-shaped file is named, and its content appears nowhere in the plan", () => {
		const sentinel = "SENTINEL-NOT-A-KEY-7f3a";
		const { home } = kimiHome({
			"credentials.json": JSON.stringify({ apiKey: sentinel }),
			"AGENTS.md": "# rules\n",
		});
		const planned = plan(home);
		expect(detailsMatching(planned, /credential-shaped entries reported by name/)).toHaveLength(1);
		expect(fromsMatching(planned, /credentials\.json/)).toHaveLength(1);
		expect(JSON.stringify(planned)).not.toContain(sentinel);
		// The reader's own return value is held to the same rule.
		expect(JSON.stringify(readKimiCode(home))).not.toContain(sentinel);
	});

	test("a directory with no mapping is named with its size, so nothing looks forgotten", () => {
		const { home } = kimiHome({ "AGENTS.md": "# rules\n" });
		writeTree(home, { ".kimi-code/logs/a.log": "x\n", ".kimi-code/logs/b.log": "y\n" });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /no mapping here for these/);
		expect(detail).toContain("left where they are");
		expect(fromsMatching(planned, /logs \(2\)/)).toHaveLength(1);
	});

	test("the predecessor tree is named when it is there, and never opened", () => {
		const { home } = kimiHome({ "AGENTS.md": "# rules\n" });
		writeTree(home, { ".kimi/plans/one.json": "{}" });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /the tree kimi-cli left behind/);
		expect(detail).toContain("Kimi Code migrates itself");
		expect(planned.writes.some((write) => write.path.startsWith(join(home, ".kimi")))).toBe(false);
	});

	test("a predecessor tree moved by $KIMI_SHARE_DIR is named where it is, and its skills root too", () => {
		const { home } = kimiHome({ "AGENTS.md": "# rules\n" });
		writeTree(home, { "share/plans/one.json": "{}" });
		setEnv("KIMI_SHARE_DIR", join(home, "share"));
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /the tree kimi-cli left behind/);
		// Both paths are named: the moved tree, and the default one that skills are
		// still read from after the move.
		expect(detail).toContain(", and ");
		expect(detail).toContain("for its skills");
		expect(fromsMatching(planned, /\$KIMI_SHARE_DIR/)).toHaveLength(1);
	});

	test("a share directory of nothing but whitespace counts as unset", () => {
		// The two variables this one module resolves disagree about an empty-looking
		// value: `$KIMI_CODE_HOME` takes `"  "` for a directory name, `$KIMI_SHARE_DIR`
		// does not (`shareDir === undefined || shareDir.trim() === ''`). With it read
		// the other way round, a shell that exported a blank value would send the
		// report to a directory named after the spaces and leave the real tree unnamed.
		const { home } = kimiHome({ "AGENTS.md": "# rules\n" });
		writeTree(home, { ".kimi/plans/one.json": "{}" });
		setEnv("KIMI_SHARE_DIR", "   ");
		const planned = plan(home);
		// The line is the default one: named at its usual path, with nothing said
		// about a variable, and no second path standing in as the skills root.
		expect(fromsMatching(planned, /^~\/\.kimi$/)).toHaveLength(1);
		expect(fromsMatching(planned, /for its skills/)).toHaveLength(0);
		expect(fromsMatching(planned, /\$KIMI_SHARE_DIR/)).toHaveLength(0);
	});
});

describe("prompt history", () => {
	test("the current project's prompts are merged newest end first", () => {
		const { home, root } = kimiHome({ "AGENTS.md": "# rules\n" });
		// The reader computes the file name from the working directory, so the fixture
		// has to ask the same function for the path it will look at.
		writeFileAt(
			kimiInputHistoryFile(root, process.cwd()),
			`${['{"content":"one"}', '{"content":"two"}', '{"content":"three"}'].join("\n")}\n`,
		);
		const result = runMigration({ home, from: "kimi-code", only: "history", historyScope: "cwd" });
		expect(result.error).toBeUndefined();
		const write = result.plan.writes.find((candidate) => candidate.kind === "prompt-history");
		const entries = (write?.content ?? "")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { text: string; cwd: string; timestamp: number });
		// The file is append-only and its lines carry no timestamp, so the order is the
		// only ordering there is — and it runs the other way. Reading it top-down would
		// hand the oldest prompts to a selection that keeps the first `limit` of a
		// stable sort by time, which is every one of them at epoch 0.
		expect(entries.map((entry) => entry.text)).toEqual(["three", "two", "one"]);
		expect(entries.every((entry) => entry.timestamp === 0)).toBe(true);
		// Every entry is this project's: the file's directory is the project, and the
		// reader takes it from there rather than from anything in the line.
		expect(entries.every((entry) => entry.cwd === process.cwd())).toBe(true);
	});

	test("a shell line and a slash command are not prompts, and are counted", () => {
		const { home, root } = kimiHome({ "AGENTS.md": "# rules\n" });
		writeFileAt(
			kimiInputHistoryFile(root, process.cwd()),
			`${['{"content":"!ls -la"}', '{"content":"/help"}', '{"content":"keep me"}'].join("\n")}\n`,
		);
		const result = runMigration({ home, from: "kimi-code", only: "history", historyScope: "cwd" });
		const write = result.plan.writes.find((candidate) => candidate.kind === "prompt-history");
		expect(write?.content).toContain("keep me");
		expect(write?.content).not.toContain("!ls -la");
		expect(write?.content).not.toContain("/help");
		expect(detailsMatching(result.plan, /`!` command/)).toHaveLength(1);
		expect(detailsMatching(result.plan, /slash command/)).toHaveLength(1);
	});

	test("a home with no history file offers no prompts, and still names the source", () => {
		const { home } = kimiHome({ "AGENTS.md": "# rules\n" });
		const result = runMigration({ home, from: "kimi-code", only: "history", historyScope: "cwd" });
		expect(result.plan.writes.some((write) => write.kind === "prompt-history")).toBe(false);
		expect(result.plan.sources).toEqual(["kimi-code"]);
	});

	test("scope all reaches another project through the session that ran in it", () => {
		// The file name is a hash of a directory, so the only way to a project other
		// than this one is through a session that names it — and that is the branch
		// this pins. The third file belongs to a project no session remembers, which
		// is the case the count exists for: the format cannot say where it came from.
		const { home, root } = kimiHome({ "AGENTS.md": "# rules\n" });
		const elsewhere = join(home, "elsewhere");
		writeKimiSession(root, "s-1", elsewhere);
		writeFileAt(kimiInputHistoryFile(root, process.cwd()), '{"content":"prompt here"}\n');
		writeFileAt(kimiInputHistoryFile(root, elsewhere), '{"content":"prompt from elsewhere"}\n');
		writeFileAt(kimiInputHistoryFile(root, join(home, "third")), '{"content":"unreachable prompt"}\n');
		const result = runMigration({ home, from: "kimi-code", only: ["history"], historyScope: "all" });
		expect(result.error).toBeUndefined();
		const content = result.plan.writes.find((write) => write.kind === "prompt-history")?.content ?? "";
		expect(content).toContain("prompt here");
		expect(content).toContain("prompt from elsewhere");
		expect(content).not.toContain("unreachable prompt");
		expect(detailsMatching(result.plan, /no session left to name it/)).toHaveLength(1);
	});
});

describe("sessions", () => {
	test("a session on disk is listed and read through the migration, not only by the reader", () => {
		// The reader's own tests hand it a session object they built themselves; this
		// is the path that goes looking for one on disk, so it is the only one that
		// can show the listing and the reader are wired to each other at all.
		const { home, root } = kimiHome({ "AGENTS.md": "# rules\n" });
		writeKimiSession(root, "s-1", process.cwd());
		const result = runMigration({ home, from: "kimi-code", only: ["history"], historyScope: "cwd" });
		expect(result.error).toBeUndefined();
		const writes = result.plan.writes.filter((write) => write.kind === "history");
		expect(writes).toHaveLength(1);
		expect(writes[0]?.content).toContain("canary-from-kimi");
		// Named after the source and the session id rather than a fresh id, so the
		// same import run twice writes the same file instead of a second copy.
		expect(writes[0]?.path).toContain("imported-kimi-code-");
	});

	test("a session that went away between the listing and the read is reported, not rebuilt", () => {
		// The picker lists sessions and the read happens later, so the file can be gone
		// by then — kimi deletes on request. The candidate carries a path, and reading
		// that path directly is the tempting shortcut: it would import a session the
		// listing no longer counts, and a report would call it imported.
		const { home, root } = kimiHome({ "AGENTS.md": "# rules\n" });
		writeKimiSession(root, "s-1", process.cwd());
		const listing = listHistory("kimi-code", home, { cwd: process.cwd(), scope: "cwd" });
		expect(listing.candidates).toHaveLength(1);
		rmSync(join(root, "sessions", "wd_proj_abc123", "s-1"), { recursive: true, force: true });
		const read = readHistory("kimi-code", home, listing.candidates);
		expect(read.sessions).toEqual([]);
		expect(read.notes).toContainEqual({ reason: "session is no longer on disk", count: 1 });
	});
});
