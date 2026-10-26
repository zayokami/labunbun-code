/**
 * The `command-code` source, from the reader through the report.
 *
 * **What this file is for.** Command Code is a Claude-shaped product with its
 * own spellings for almost everything, and every translation in
 * `command-code-plan.ts` is a claim about what one of its spellings means. So
 * most of what follows pins a translation to the sentence that justifies it:
 *
 *   - **its permission modes are five where this build has two axes**, and two
 *     of the five (`bypass`, `auto-accept`) are claims about *narrowing* —
 *     `disableBypass` makes the file's own `bypass` a lie at runtime, and
 *     `auto-accept` has no counterpart that applies edits without asking;
 *   - **its rule grammar is a different dialect**, where `?` is a plain
 *     character, `X:*` means two different things at once, and a whole-server
 *     wildcard lives only in the deny pass — so the allow and deny sides of the
 *     same rule can translate differently, and both directions are tested;
 *   - **its hook matchers name display labels** (`SHELL`, not `Bash`), and a
 *     group whose matcher names no translatable label has to be reported rather
 *     than carried as a hook that never fires;
 *   - **its MCP entries hold credentials in three channels that a key-name scan
 *     cannot see** — environment values, header values, and an OAuth block — and
 *     the assertion is that the *values* are nowhere in the plan, not merely
 *     that a key was dropped;
 *   - **its provider registry holds a key in four shapes**, only one of which
 *     (`$VAR`) can be carried as an environment-variable name;
 *   - **every credential file is named and none is opened** — the canary in
 *     each file must be absent from the plan byte for byte.
 *
 * Every fixture is a temporary directory. Nothing here reads a real install,
 * a real credential path, or anything under a user's home: `readCommandCode`
 * takes `home` as an argument, the CLI honours no environment variable for its
 * root, and no test touches `process.env`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMMAND_CODE_BUILT_IN_PROVIDER_IDS,
	COMMAND_CODE_CREDENTIAL_FILES,
	COMMAND_CODE_DEFAULT_DIR,
	COMMAND_CODE_ENTRY_TYPES,
	COMMAND_CODE_HOOK_DEFAULT_TIMEOUT_MS,
	COMMAND_CODE_HOOK_EVENTS,
	COMMAND_CODE_HOOK_MATCH_ALL,
	COMMAND_CODE_HOOK_MATCHER_LABELS,
	COMMAND_CODE_HOOK_MAX_TIMEOUT_MS,
	COMMAND_CODE_LEGACY_CONFIG_KEYS,
	COMMAND_CODE_PERMISSION_MODES,
	COMMAND_CODE_PROMPT_HISTORY_MAX,
	COMMAND_CODE_RESERVED_PROVIDER_IDS,
	COMMAND_CODE_SESSION_VERSION,
	commandCodeAgentsDir,
	commandCodeBypassDisabled,
	commandCodeCommandsDir,
	commandCodeFileHistoryDir,
	commandCodeHistoryPath,
	commandCodeLegacyConfigPath,
	commandCodeMcpPaths,
	commandCodeMemoryPath,
	commandCodeProjectsDir,
	commandCodeProvidersPath,
	commandCodeRoot,
	commandCodeSessionsDir,
	commandCodeSettingsPath,
	commandCodeSkillsDir,
	commandCodeTrustedHooksPath,
	isCommandCodeTranscriptName,
	normalizeCommandCodePermissionMode,
} from "../src/command-code-home.ts";
import { COMMAND_CODE_PERMISSION_MODE_MAP } from "../src/command-code-plan.ts";
import { readCommandCode } from "../src/command-code-read.ts";
import { runMigration } from "../src/migrate.ts";
import { detectSources, MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS, SOURCE_ROOTS } from "../src/migrate-types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** Write `content` at `<root>/<relative>`, creating the directories above it. */
function writeUnder(root: string, relative: string, content: string): void {
	const path = join(root, ...relative.split("/"));
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

interface CommandCodeFixture {
	home: string;
	cwd: string;
}

/** A home and a project directory; `files` is rooted at `~/.commandcode`. */
function commandCodeFixture(
	options: { files?: Record<string, string>; homeFiles?: Record<string, string> } = {},
): CommandCodeFixture {
	const home = makeDir("lbb-command-code-home-");
	const cwd = makeDir("lbb-command-code-proj-");
	for (const [relative, content] of Object.entries(options.files ?? {})) {
		writeUnder(home, `${COMMAND_CODE_DEFAULT_DIR}/${relative}`, content);
	}
	for (const [relative, content] of Object.entries(options.homeFiles ?? {})) {
		writeUnder(home, relative, content);
	}
	return { home, cwd };
}

/** A settings.json body from an object, written the way the file is written. */
function settingsJson(value: Record<string, unknown>): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/**
 * The plan for a run over one fixture, with the source and the categories fixed
 * so every call in this file reads the same way.
 */
function planOf(home: string, cwd: string, extra: Partial<Parameters<typeof runMigration>[0]> = {}) {
	return runMigration({ home, cwd, from: "command-code", only: ["settings", "assets"], apply: false, ...extra }).plan;
}

/** The settings write's object, or null when no settings write was planned. */
function settingsWrite(plan: ReturnType<typeof planOf>): Record<string, unknown> | null {
	const write = plan.writes.find((entry) => entry.kind === "settings");
	return write === undefined ? null : (JSON.parse(write.content) as Record<string, unknown>);
}

/** The settings write's `permissions` object, asserting one was planned at all. */
function permissionsOf(plan: ReturnType<typeof planOf>): Record<string, unknown> {
	const settings = settingsWrite(plan);
	expect(settings).not.toBeNull();
	return (settings as Record<string, unknown>).permissions as Record<string, unknown>;
}

/** Every `from` label a plan produced, for the "which line says what" assertions. */
function itemsFor(plan: ReturnType<typeof planOf>, needle: string) {
	return plan.items.filter((item) => item.from.includes(needle));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("it is appended, so every id before it keeps its place", () => {
	// Appended, never slotted in: the order is what `detectSources` reports, and
	// reordering would silently change which of two sources providing the same
	// file wins.
	expect(MIGRATION_SOURCE_IDS).toContain("command-code");
	expect(MIGRATION_SOURCE_IDS[MIGRATION_SOURCE_IDS.length - 1]).toBe("command-code");
	expect(MIGRATION_SOURCE_LABELS["command-code"]).toBe("Command Code");
	expect(SOURCE_ROOTS["command-code"]).toBe(COMMAND_CODE_DEFAULT_DIR);
	expect(MIGRATION_SOURCE_IDS.indexOf("alma")).toBeLessThan(MIGRATION_SOURCE_IDS.indexOf("command-code"));
});

test("every source id has a label, and every label has an id — one list, two tables", () => {
	expect(Object.keys(MIGRATION_SOURCE_LABELS).sort()).toEqual([...MIGRATION_SOURCE_IDS].sort());
});

test("detection reads ~/.commandcode and an empty home is not a detection", () => {
	const { home } = commandCodeFixture({ files: { "settings.json": settingsJson({ model: "sonnet" }) } });
	expect(detectSources(home)).toContain("command-code");
	const bare = makeDir("lbb-command-code-bare-");
	expect(detectSources(bare)).not.toContain("command-code");
	// An empty directory is the state a home is in before the CLI's first write,
	// and `commandCodeTreeHasContent` reads it as absent.
	mkdirSync(join(bare, COMMAND_CODE_DEFAULT_DIR));
	expect(detectSources(bare)).not.toContain("command-code");
});

// ---------------------------------------------------------------------------
// Paths and tables
// ---------------------------------------------------------------------------

test("every path function takes the root, not the home — the one arity trap here", () => {
	const root = "/root";
	expect(commandCodeRoot("/h")).toBe(join("/h", COMMAND_CODE_DEFAULT_DIR));
	expect(commandCodeSettingsPath(root)).toBe(join(root, "settings.json"));
	expect(commandCodeLegacyConfigPath(root)).toBe(join(root, "config.json"));
	expect(commandCodeProvidersPath(root)).toBe(join(root, "providers.json"));
	expect(commandCodeHistoryPath(root)).toBe(join(root, "history.jsonl"));
	expect(commandCodeProjectsDir(root)).toBe(join(root, "projects"));
	expect(commandCodeFileHistoryDir(root)).toBe(join(root, "file-history"));
	expect(commandCodeSessionsDir(root)).toBe(join(root, "sessions"));
	expect(commandCodeTrustedHooksPath(root)).toBe(join(root, "trusted-hooks.json"));
	expect(commandCodeMemoryPath(root)).toBe(join(root, "AGENTS.md"));
	expect(commandCodeSkillsDir(root)).toBe(join(root, "skills"));
	expect(commandCodeAgentsDir(root)).toBe(join(root, "agents"));
	expect(commandCodeCommandsDir(root)).toBe(join(root, "commands"));
	// The load order is the array order: the second file wins on a name clash.
	expect(commandCodeMcpPaths(root)).toEqual([join(root, "mcp.json"), join(root, ".mcp.json")]);
});

test("isCommandCodeTranscriptName keeps transcripts and drops the three sidecars that share the extension", () => {
	expect(isCommandCodeTranscriptName("abc.jsonl")).toBe(true);
	expect(isCommandCodeTranscriptName("abc.meta.json")).toBe(false);
	expect(isCommandCodeTranscriptName("abc.checkpoints.jsonl")).toBe(false);
	expect(isCommandCodeTranscriptName("abc.prompts.jsonl")).toBe(false);
	expect(isCommandCodeTranscriptName("abc.v2.bak.jsonl")).toBe(false);
});

test("the permission modes: five canonical, eight aliases, and nothing guessed at", () => {
	expect([...COMMAND_CODE_PERMISSION_MODES]).toEqual(["default", "auto-accept", "plan", "bypass", "dont-ask"]);
	expect(normalizeCommandCodePermissionMode("default")).toBe("default");
	expect(normalizeCommandCodePermissionMode("  PLAN  ")).toBe("plan");
	expect(normalizeCommandCodePermissionMode("standard")).toBe("default");
	expect(normalizeCommandCodePermissionMode("manual")).toBe("default");
	expect(normalizeCommandCodePermissionMode("accept-edits")).toBe("auto-accept");
	expect(normalizeCommandCodePermissionMode("acceptedits")).toBe("auto-accept");
	expect(normalizeCommandCodePermissionMode("dontask")).toBe("dont-ask");
	expect(normalizeCommandCodePermissionMode("yolo")).toBe("bypass");
	expect(normalizeCommandCodePermissionMode("bypass-permissions")).toBe("bypass");
	expect(normalizeCommandCodePermissionMode("")).toBeUndefined();
	expect(normalizeCommandCodePermissionMode("  ")).toBeUndefined();
	expect(normalizeCommandCodePermissionMode("sideways")).toBeUndefined();
	expect(normalizeCommandCodePermissionMode(7)).toBeUndefined();
});

test("disableBypass is true or the literal 'disable', and nothing else", () => {
	expect(commandCodeBypassDisabled(true)).toBe(true);
	expect(commandCodeBypassDisabled("disable")).toBe(true);
	expect(commandCodeBypassDisabled(false)).toBe(false);
	expect(commandCodeBypassDisabled("true")).toBe(false);
	expect(commandCodeBypassDisabled(1)).toBe(false);
	expect(commandCodeBypassDisabled(undefined)).toBe(false);
});

test("the hook tables: four events, a label map, a match-all pair and the two timeouts", () => {
	expect([...COMMAND_CODE_HOOK_EVENTS]).toEqual(["PreToolUse", "PostToolUse", "Stop", "SessionStart"]);
	expect([...COMMAND_CODE_HOOK_MATCH_ALL]).toEqual(["*", "**"]);
	expect(COMMAND_CODE_HOOK_MATCHER_LABELS.SHELL).toBe("Bash");
	expect(COMMAND_CODE_HOOK_MATCHER_LABELS.READ_MULTI).toBe("Read");
	expect(COMMAND_CODE_HOOK_MATCHER_LABELS.QUESTION).toBe("AskUserQuestion");
	expect(COMMAND_CODE_HOOK_DEFAULT_TIMEOUT_MS).toBe(30_000);
	expect(COMMAND_CODE_HOOK_MAX_TIMEOUT_MS).toBe(600_000);
	// The table's own shape: every label maps to a tool name, never back to itself.
	for (const [label, name] of Object.entries(COMMAND_CODE_HOOK_MATCHER_LABELS)) {
		expect(label).toBe(label.toUpperCase());
		expect(name).toBeDefined();
	}
});

test("the remaining tables are the CLI's own, verbatim enough to cite", () => {
	expect(COMMAND_CODE_SESSION_VERSION).toBe(3);
	expect([...COMMAND_CODE_ENTRY_TYPES]).toEqual([
		"message",
		"model_change",
		"effort_change",
		"compaction",
		"branch_summary",
		"custom",
		"custom_message",
		"label",
		"session_info",
	]);
	expect([...COMMAND_CODE_CREDENTIAL_FILES]).toEqual([
		"auth.json",
		"auth.local.json",
		"auth.staging.json",
		"credentials.json",
		"mcp-tokens.json",
	]);
	expect([...COMMAND_CODE_BUILT_IN_PROVIDER_IDS]).toHaveLength(6);
	expect([...COMMAND_CODE_RESERVED_PROVIDER_IDS]).toEqual([
		"apiKey",
		"userId",
		"userName",
		"keyName",
		"authenticatedAt",
	]);
	expect([...COMMAND_CODE_LEGACY_CONFIG_KEYS]).toHaveLength(8);
	expect(COMMAND_CODE_PROMPT_HISTORY_MAX).toBe(1000);
	// The mode map is the claim the whole file checks against, so its four rows
	// are spelled out once, here.
	expect(COMMAND_CODE_PERMISSION_MODE_MAP).toEqual({
		default: { mode: "ask", sandbox: "workspace-write" },
		"auto-accept": { mode: "ask", sandbox: "workspace-write" },
		plan: { mode: "plan", sandbox: "workspace-write" },
		bypass: { mode: "agent", sandbox: "danger-full-access" },
	});
});

// ---------------------------------------------------------------------------
// Model and theme
// ---------------------------------------------------------------------------

test("a model alias resolves to a reference this build can load, and the line says so", () => {
	const { home, cwd } = commandCodeFixture({ files: { "settings.json": settingsJson({ model: "sonnet" }) } });
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)?.model).toBe("anthropic/claude-sonnet-5");
	const item = itemsFor(plan, "→ model");
	expect(item).toHaveLength(1);
	expect(item[0].from).toBe('~/.commandcode/settings.json → model ("sonnet")');
	expect(item[0].action).toBe("map");
	expect(item[0].detail).toContain("resolved to anthropic/claude-sonnet-5");
});

test("a model name the registry cannot load is reported, not guessed at", () => {
	const { home, cwd } = commandCodeFixture({ files: { "settings.json": settingsJson({ model: "gpt-99-ultra" }) } });
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)).toBeNull();
	const item = itemsFor(plan, "→ model");
	expect(item[0].action).toBe("skip");
	expect(item[0].detail).toContain("no model in the registry matches this name");
});

test("a model set only in the legacy config is carried, and labelled as coming from there", () => {
	const { home, cwd } = commandCodeFixture({ files: { "config.json": settingsJson({ model: "haiku" }) } });
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)?.model).toBe("anthropic/claude-haiku-4-5");
	expect(itemsFor(plan, "→ model")[0].from).toBe('~/.commandcode/config.json → model ("haiku")');
});

test("when both files name a model, settings.json wins — the CLI's own layer order", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ model: "haiku" }), "config.json": settingsJson({ model: "sonnet" }) },
	});
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)?.model).toBe("anthropic/claude-haiku-4-5");
	expect(itemsFor(plan, "→ model")[0].from).toContain("settings.json");
});

test("theme: the two named themes are carried, 'auto' is a decision about the terminal, the rest is not from the UI", () => {
	const dark = commandCodeFixture({ files: { "settings.json": settingsJson({ theme: "dark" }) } });
	const darkPlan = planOf(dark.home, dark.cwd);
	expect(settingsWrite(darkPlan)?.theme).toBe("dark");
	expect(itemsFor(darkPlan, "→ theme")[0].detail).toContain('this build\'s "dark"');

	const auto = commandCodeFixture({ files: { "settings.json": settingsJson({ theme: "auto" }) } });
	const autoPlan = planOf(auto.home, auto.cwd);
	expect(settingsWrite(autoPlan)).toBeNull();
	expect(itemsFor(autoPlan, "→ theme")[0].detail).toContain("follow the terminal");

	const odd = commandCodeFixture({ files: { "settings.json": settingsJson({ theme: "neon" }) } });
	const oddPlan = planOf(odd.home, odd.cwd);
	expect(settingsWrite(oddPlan)).toBeNull();
	expect(itemsFor(oddPlan, "→ theme")[0].detail).toContain("did not come from its settings UI");
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

test("bypass becomes both axes at once: agent mode and an unrestricted sandbox", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { defaultMode: "bypass" } }) },
	});
	const plan = planOf(home, cwd);
	const written = settingsWrite(plan);
	expect(written?.permissionMode).toBe("agent");
	expect(written?.sandbox).toBe("danger-full-access");
	const item = itemsFor(plan, "defaultMode");
	expect(item.some((entry) => entry.detail.includes('mapped to "agent"'))).toBe(true);
	expect(item.some((entry) => entry.detail.includes("no confinement"))).toBe(true);
});

test("dont-ask has no counterpart and is left as this build's default, in so many words", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { defaultMode: "dont-ask" } }) },
	});
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)).toBeNull();
	const item = itemsFor(plan, "defaultMode")[0];
	expect(item.action).toBe("skip");
	expect(item.detail).toContain("no counterpart");
});

test("auto-accept lands on 'ask' and the line says it narrowed deliberately", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { defaultMode: "auto-accept" } }) },
	});
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)?.permissionMode).toBe("ask");
	expect(itemsFor(plan, "defaultMode")[0].detail).toContain("Narrower than the mode it replaced, deliberately");
});

test("the legacy top-level permissionMode is read too, and labelled by its own key", () => {
	const { home, cwd } = commandCodeFixture({ files: { "settings.json": settingsJson({ permissionMode: "yolo" }) } });
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)?.permissionMode).toBe("agent");
	const item = itemsFor(plan, "permissionMode");
	expect(item[0].from).toBe('~/.commandcode/settings.json → permissionMode ("yolo")');
});

test("disableBypass is reported as a policy-tier key, and the fallback is what gets imported", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { defaultMode: "bypass", disableBypass: true } }) },
	});
	const plan = planOf(home, cwd);
	const written = settingsWrite(plan);
	expect(written?.permissionMode).toBe("ask");
	expect(written?.sandbox).toBe("workspace-write");
	const flag = itemsFor(plan, "disableBypass")[0];
	expect(flag.action).toBe("downgrade");
	expect(flag.detail).toContain("managed-settings.json");
	expect(flag.detail).toContain("disableBypassPermissionsMode");
	const mode = itemsFor(plan, "defaultMode")[0];
	expect(mode.detail).toContain('starts in "default" instead');
});

test("the string form of disableBypass ('disable') is honoured the same way", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { defaultMode: "bypass", disableBypass: "disable" } }) },
	});
	expect(settingsWrite(planOf(home, cwd))?.permissionMode).toBe("ask");
});

test("a mode the source's own normalizer cannot read is reported, not approximated", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { defaultMode: "sideways" } }) },
	});
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)).toBeNull();
	expect(itemsFor(plan, "defaultMode")[0].detail).toContain("not one of the source's five modes");
});

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

test("a shell rule becomes the pair that covers the same commands, and the loss is stated", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { allow: ["shell(npm test)"] } }) },
	});
	const plan = planOf(home, cwd);
	const permissions = settingsWrite(plan)?.permissions as { allow: string[] };
	expect(permissions.allow).toEqual(["Bash(npm test)", "Bash(npm test *)"]);
	const item = itemsFor(plan, "permissions.allow")[0];
	expect(item.action).toBe("map");
	expect(item.detail).toContain("allow pass requires every segment of a chained command");
	expect(item.detail).toContain("crosses line breaks");
});

test("read(*) denies the three tools it stands for, unscoped on this side", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { deny: ["read(*)"] } }) },
	});
	const plan = planOf(home, cwd);
	const permissions = settingsWrite(plan)?.permissions as { deny: string[] };
	expect(permissions.deny).toEqual(["Read", "Glob", "Grep"]);
	expect(itemsFor(plan, "permissions.deny")[0].detail).toContain(
		"denies a chained command when any part of it matches",
	);
});

test("a wildcard over tool names is carried on the deny side, because that is the side it matches on", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { deny: ["*"] } }) },
	});
	const plan = planOf(home, cwd);
	const permissions = settingsWrite(plan)?.permissions as { deny: string[] };
	expect(permissions.deny).toEqual(["*"]);
	expect(itemsFor(plan, "permissions.deny")[0].detail).toContain("wildcard over tool names");
});

test("the same wildcard on the allow side widens and is refused with instructions", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { allow: ["*"] } }) },
	});
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)).toBeNull();
	const item = itemsFor(plan, "permissions.allow")[0];
	expect(item.action).toBe("skip");
	expect(item.detail).toContain("Write one rule per tool instead");
});

test("`?` is a plain character there and a wildcard here, so any rule with one is refused", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { allow: ["shell(ls ?)"] } }) },
	});
	const plan = planOf(home, cwd);
	expect(itemsFor(plan, "permissions.allow")[0].detail).toContain("`?` is a plain character");
});

test("a token naming no tool this build has is refused by name", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { deny: ["frobnicate(x)"] } }) },
	});
	const plan = planOf(home, cwd);
	expect(itemsFor(plan, "permissions.deny")[0].detail).toContain("`frobnicate` does not name a tool this build has");
});

test("mcp rules travel in the spelling both sides share", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"settings.json": settingsJson({
				permissions: { deny: ["mcp__github__get_issue", "mcp__github__*", "mcp__github"] },
			}),
		},
	});
	const permissions = settingsWrite(planOf(home, cwd))?.permissions as { deny: string[] };
	expect(permissions.deny).toEqual(["mcp__github__get_issue", "mcp__github__*", "mcp__github"]);
});

test("a whole-server wildcard rides the deny side and widens the allow side, so each gets its own answer", () => {
	const deny = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { deny: ["mcp__*"] } }) },
	});
	const denyPlan = planOf(deny.home, deny.cwd);
	expect(permissionsOf(denyPlan).deny).toEqual(["mcp__*"]);

	const allow = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { allow: ["mcp__*"] } }) },
	});
	const allowPlan = planOf(allow.home, allow.cwd);
	expect(settingsWrite(allowPlan)).toBeNull();
	expect(itemsFor(allowPlan, "permissions.allow")[0].detail).toContain("would widen");
});

test("a scoped edit rule becomes the four rules that cover the same directories", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { allow: ["edit(/src/**)"] } }) },
	});
	const permissions = settingsWrite(planOf(home, cwd))?.permissions as { allow: string[] };
	// The leading `/` is the workspace root there and the workspace-relative path
	// here, so it is dropped; `/**` also matched the directory itself there, so
	// the base is written as its own rule.
	expect(permissions.allow).toEqual(["Edit(src)", "Edit(src/**)", "Write(src)", "Write(src/**)"]);
});

test("a scoped read rule carries the Read part and says which side was left out", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { allow: ["read(/a/b.txt)"] } }) },
	});
	const plan = planOf(home, cwd);
	const permissions = settingsWrite(plan)?.permissions as { allow: string[] };
	expect(permissions.allow).toEqual(["Read(a/b.txt)"]);
	expect(itemsFor(plan, "permissions.allow")[0].detail).toContain("Glob/Grep");
	expect(itemsFor(plan, "permissions.allow")[0].detail).toContain("left out");
});

test("web and agent rules cannot be scoped here, and the refusal says how to write the same allow", () => {
	const fetch = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { allow: ["webfetch(https://example.com)"] } }) },
	});
	expect(itemsFor(planOf(fetch.home, fetch.cwd), "permissions.allow")[0].detail).toContain(
		"cannot scope WebFetch by address",
	);

	const agent = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { allow: ["agent(explore)"] } }) },
	});
	expect(itemsFor(planOf(agent.home, agent.cwd), "permissions.allow")[0].detail).toContain(
		"cannot be scoped by subagent type",
	);
});

test("a non-string entry is counted in the same detail line as the rules that travelled", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { allow: ["read", 7] } }) },
	});
	const plan = planOf(home, cwd);
	expect(permissionsOf(plan).allow).toEqual(["Read", "Glob", "Grep"]);
	expect(itemsFor(plan, "permissions.allow")[0].detail).toContain("not strings");
});

test("the ask tier is reported for a by-hand move because this build does have one", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { ask: ["read(x)"] } }) },
	});
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "permissions.ask")[0];
	expect(item.action).toBe("skip");
	expect(item.detail).toContain("does not carry");
	expect(item.detail).toContain("moved by hand");
});

test("additionalDirectories is the same key name with the same meaning and is copied verbatim", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ permissions: { additionalDirectories: ["/extra/dir"] } }) },
	});
	const plan = planOf(home, cwd);
	const permissions = settingsWrite(plan)?.permissions as { additionalDirectories: string[] };
	expect(permissions.additionalDirectories).toEqual(["/extra/dir"]);
	expect(itemsFor(plan, "additionalDirectories")[0].detail).toContain(
		"the same key name and the same meaning on both sides",
	);
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

test("a hook matcher is translated from the display label, and seconds become milliseconds", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"settings.json": settingsJson({
				hooks: {
					PreToolUse: [{ matcher: "SHELL", hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }],
				},
			}),
		},
	});
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)?.hooks).toEqual({
		PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi", timeout: 5000 }] }],
	});
	const item = itemsFor(plan, "→ hooks")[0];
	expect(item.action).toBe("downgrade");
	expect(item.detail).toContain("seconds in the source and were converted to milliseconds");
});

test("an event name the source's own loader ignores leaves nothing to write, and the line names it", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"settings.json": settingsJson({ hooks: { PreCommit: [{ hooks: [{ type: "command", command: "x" }] }] } }),
		},
	});
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)).toBeNull();
	const item = itemsFor(plan, "→ hooks")[0];
	expect(item.action).toBe("skip");
	expect(item.detail).toContain("no hook survived the translation");
	expect(item.detail).toContain("PreCommit");
	expect(item.detail).toContain("loader ignores");
});

test("a matcher on Stop never runs there either, so the group is dropped rather than carried as dead weight", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"settings.json": settingsJson({
				hooks: { Stop: [{ matcher: "SHELL", hooks: [{ type: "command", command: "x" }] }] },
			}),
		},
	});
	const plan = planOf(home, cwd);
	expect(itemsFor(plan, "→ hooks")[0].detail).toContain("never runs");
});

test("a matcher naming no translatable label is dropped with the label vocabulary stated", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"settings.json": settingsJson({
				hooks: { PreToolUse: [{ matcher: "TODOWRITE", hooks: [{ type: "command", command: "x" }] }] },
			}),
		},
	});
	const plan = planOf(home, cwd);
	const detail = itemsFor(plan, "→ hooks")[0].detail;
	expect(detail).toContain("cannot translate");
	expect(detail).toContain("SHELL, READ, EDIT");
});

test("async and failClosed are carried as the loss they are", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"settings.json": settingsJson({
				hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "x", async: true }] }] },
			}),
		},
	});
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "→ hooks")[0];
	expect(item.action).toBe("downgrade");
	expect(item.detail).toContain("neither has a field here");
	expect(settingsWrite(plan)?.hooks).toEqual({
		PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }],
	});
});

test("target hooks are kept unless --force, and --force replaces rather than merges", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"settings.json": settingsJson({
				hooks: { PreToolUse: [{ matcher: "SHELL", hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }] },
			}),
		},
	});
	const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "own" }] }] } };
	const kept = planOf(home, cwd, { existing });
	expect(itemsFor(kept, "→ hooks")[0].detail).toContain("target already defines hooks");
	const forced = planOf(home, cwd, { existing, force: true });
	const hooks = settingsWrite(forced)?.hooks as Record<string, unknown>;
	expect(hooks.PreToolUse).toBeDefined();
	expect(hooks.Stop).toBeUndefined();
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test("the three MCP stores merge later-wins, and both collisions are one line each", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"settings.json": settingsJson({ mcp: { servers: [{ name: "b", command: "cmd-settings" }] } }),
			"mcp.json": JSON.stringify({ mcpServers: { b: { command: "cmd-mcp" }, only: { command: "cmd-only" } } }),
			".mcp.json": JSON.stringify({ mcpServers: { b: { command: "cmd-dot" } } }),
		},
	});
	const plan = planOf(home, cwd);
	const write = plan.writes.find((entry) => entry.kind === "mcp");
	expect(write).toBeDefined();
	const servers = (JSON.parse(write?.content ?? "{}") as { mcpServers: Record<string, { command: string }> })
		.mcpServers;
	expect(servers.b.command).toBe("cmd-dot");
	expect(servers.only.command).toBe("cmd-only");
	// Two collisions, both on `b`: settings.json's copy is displaced by mcp.json,
	// and mcp.json's copy by `.mcp.json`. The surviving copy has its own line.
	const collisions = itemsFor(plan, "→ b").filter((entry) => entry.detail.includes("later wins in Command Code"));
	expect(collisions).toHaveLength(2);
	expect(collisions[0].detail).toContain("later wins in Command Code");
	expect(collisions.some((entry) => entry.from === "~/.commandcode/.mcp.json → b")).toBe(true);
});

test("an stdio server is copied with its args, and every credential channel is left by name", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"mcp.json": JSON.stringify({
				mcpServers: {
					gh: {
						command: "npx",
						args: ["-y", "server"],
						env: { TOKEN: "sk-canary-env-1" },
						headers: { Authorization: "Bearer sk-canary-hdr-2" },
						oauth: {
							authorizationUrl: "https://a",
							tokenUrl: "https://t",
							clientId: "id",
							clientSecret: "sk-canary-oauth-3",
						},
					},
				},
			}),
		},
	});
	const plan = planOf(home, cwd);
	const write = plan.writes.find((entry) => entry.kind === "mcp");
	const servers = (JSON.parse(write?.content ?? "{}") as { mcpServers: Record<string, unknown> }).mcpServers;
	expect(servers.gh).toEqual({ type: "stdio", command: "npx", args: ["-y", "server"] });
	const item = itemsFor(plan, "→ gh")[0];
	expect(item.action).toBe("downgrade");
	expect(item.detail).toContain("left off 1 environment variable(s)");
	expect(item.detail).toContain("TOKEN");
	expect(item.detail).toContain("left off its header block");
	expect(item.detail).toContain("left off its OAuth block");
	const planText = JSON.stringify(plan);
	for (const canary of ["sk-canary-env-1", "sk-canary-hdr-2", "sk-canary-oauth-3"]) {
		expect(planText).not.toContain(canary);
	}
});

test("a server switched off there is reported rather than switched on here", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "mcp.json": JSON.stringify({ mcpServers: { off: { command: "x", enabled: false } } }) },
	});
	const plan = planOf(home, cwd);
	expect(plan.writes.find((entry) => entry.kind === "mcp")).toBeUndefined();
	expect(itemsFor(plan, "→ off")[0].detail).toContain("switched off there");
});

test("a URL carrying a credential is refused whole, and the value is nowhere in the plan", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"mcp.json": JSON.stringify({ mcpServers: { web: { url: "https://alice:topsecretsauce@example.com/mcp" } } }),
		},
	});
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "→ web")[0];
	expect(item.action).toBe("skip");
	expect(item.containsSecret).toBe(true);
	expect(item.detail).toContain("carries a credential");
	expect(item.detail).toContain("`name:password@` part");
	expect(JSON.stringify(plan)).not.toContain("topsecretsauce");
});

test("an entry the CLI's own normalizer would refuse is named, because silence is the CLI's other choice", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "mcp.json": JSON.stringify({ mcpServers: { bad: { env: { X: "1" } } } }) },
	});
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "→ bad")[0];
	expect(item.action).toBe("skip");
	expect(item.detail).toContain("not a server the CLI's own normalizer would load");
});

test("sse is spelled differently there and connects the same way here", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "mcp.json": JSON.stringify({ mcpServers: { events: { transport: "sse", url: "https://x/mcp" } } }) },
	});
	const plan = planOf(home, cwd);
	const write = plan.writes.find((entry) => entry.kind === "mcp");
	const servers = (JSON.parse(write?.content ?? "{}") as { mcpServers: Record<string, unknown> }).mcpServers;
	expect(servers.events).toEqual({ type: "http", url: "https://x/mcp" });
	const item = itemsFor(plan, "→ events")[0];
	expect(item.action).toBe("downgrade");
	expect(item.detail).toContain('spells this transport "sse"');
});

test("a name the target already has is kept unless --force, and --force writes the import", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "mcp.json": JSON.stringify({ mcpServers: { gh: { command: "npx" } } }) },
		homeFiles: { ".labunbun/.mcp.json": JSON.stringify({ mcpServers: { gh: { type: "stdio", command: "old" } } }) },
	});
	const kept = planOf(home, cwd);
	expect(itemsFor(kept, "→ gh")[0].detail).toContain("use --force to overwrite");
	const forced = planOf(home, cwd, { force: true });
	const write = forced.writes.find((entry) => entry.kind === "mcp");
	const servers = (JSON.parse(write?.content ?? "{}") as { mcpServers: Record<string, { command: string }> })
		.mcpServers;
	expect(servers.gh.command).toBe("npx");
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** One providers.json with one entry. */
function providersJson(id: string, entry: Record<string, unknown>): string {
	return JSON.stringify({ providers: { [id]: entry } });
}

const PROVIDER_MODELS = { models: { m1: {} } };

test("a $VAR key is carried as the environment variable name it already is", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("myrouter", {
				baseURL: "https://api.example.com/v1",
				apiKey: "$MY_KEY",
				...PROVIDER_MODELS,
			}),
		},
	});
	const plan = planOf(home, cwd);
	const providers = settingsWrite(plan)?.providers as { openaiCompatible: Array<Record<string, unknown>> };
	expect(providers.openaiCompatible).toEqual([
		{
			id: "myrouter",
			baseUrl: "https://api.example.com/v1",
			apiKeyEnv: "MY_KEY",
			models: [{ id: "m1", contextWindow: 200_000, maxOutputTokens: 8192 }],
		},
	]);
	const item = itemsFor(plan, "providers.json → myrouter")[0];
	expect(item.action).toBe("map");
	expect(item.to).toBe("settings.json → providers.openaiCompatible[myrouter]");
	expect(item.detail).toContain("the key read as the environment variable name it was");
});

test("an exactly-{env:VAR} key is the same reference in the other spelling", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("myrouter", {
				baseURL: "https://api.example.com/v1",
				apiKey: "{env:MY_KEY}",
				...PROVIDER_MODELS,
			}),
		},
	});
	const providers = settingsWrite(planOf(home, cwd))?.providers as { openaiCompatible: Array<Record<string, unknown>> };
	expect(providers.openaiCompatible[0].apiKeyEnv).toBe("MY_KEY");
});

test("a template key names the variables it interpolates and is refused, because this build's field holds one name", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("myrouter", {
				baseURL: "https://api.example.com/v1",
				apiKey: "sk-{env:CANARY_KEY}-tail",
				...PROVIDER_MODELS,
			}),
		},
	});
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "providers.json → myrouter")[0];
	expect(item.action).toBe("skip");
	expect(item.detail).toContain("its key reference is a template");
	expect(item.detail).toContain("CANARY_KEY");
});

test("a command key becomes a synthesized variable name that has to be filled in by hand", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("my-router.v2", {
				baseURL: "https://api.example.com/v1",
				apiKey: "!secret-tool lookup svc",
				...PROVIDER_MODELS,
			}),
		},
	});
	const plan = planOf(home, cwd);
	const providers = settingsWrite(plan)?.providers as { openaiCompatible: Array<Record<string, unknown>> };
	// The id sanitized: uppercase, every non-alphanumeric a `_`.
	expect(providers.openaiCompatible[0].apiKeyEnv).toBe("MY_ROUTER_V2_API_KEY");
	const item = itemsFor(plan, "providers.json → my-router.v2")[0];
	expect(item.action).toBe("downgrade");
	expect(item.detail).toContain("synthesized");
});

test("a keyless provider cannot be represented, because the target's key field has no value that means 'none'", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("local", {
				baseURL: "https://localhost.example/v1",
				apiKey: false,
				...PROVIDER_MODELS,
			}),
		},
	});
	const plan = planOf(home, cwd);
	expect(settingsWrite(plan)).toBeNull();
	expect(itemsFor(plan, "providers.json → local")[0].detail).toContain("marked keyless");
});

test("a plaintext key never leaves the file, and the line says so without the value", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("myrouter", {
				baseURL: "https://api.example.com/v1",
				apiKey: "sk-canary-provider-4",
				...PROVIDER_MODELS,
			}),
		},
	});
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "providers.json → myrouter")[0];
	expect(item.action).toBe("skip");
	expect(item.containsSecret).toBe(true);
	expect(item.detail).toContain("held a plaintext key");
	expect(JSON.stringify(plan)).not.toContain("sk-canary-provider-4");
});

test("a built-in sign-in lane is skipped with the CLI's own rename advice", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "providers.json": providersJson("anthropic", { baseURL: "https://x", apiKey: "$K", ...PROVIDER_MODELS }) },
	});
	const plan = planOf(home, cwd);
	expect(itemsFor(plan, "providers.json → anthropic")[0].detail).toContain("anthropic-api");
	expect(itemsFor(plan, "providers.json → anthropic")[0].detail).toContain("sign-in lanes");
});

test("an id the CLI's own pattern refuses is refused here by the same rule", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "providers.json": providersJson("Bad_Id", { baseURL: "https://x", apiKey: "$K", ...PROVIDER_MODELS }) },
	});
	expect(itemsFor(planOf(home, cwd), "providers.json → Bad_Id")[0].detail).toContain("not a usable provider id");
});

test("every reserved name carries an upper-case letter, so the id rule shadows the reserved rule — in the CLI too", () => {
	// `parseProvidersConfig` checks in this order: built-in lane, then the id
	// pattern, then the five auth-file field names. Every one of the five fails
	// the pattern first (`apiKey`, `userId`, … all contain upper-case letters),
	// so the reserved sentence is unreachable there and here — the entry is
	// refused either way, which is what this pins.
	for (const id of COMMAND_CODE_RESERVED_PROVIDER_IDS) {
		expect(id).toMatch(/[A-Z]/);
	}
	const { home, cwd } = commandCodeFixture({
		files: { "providers.json": providersJson("apiKey", { baseURL: "https://x", apiKey: "$K", ...PROVIDER_MODELS }) },
	});
	expect(itemsFor(planOf(home, cwd), "providers.json → apiKey")[0].detail).toContain("not a usable provider id");
});

test("an entry with no model the reader would load is refused with the CLI's own reasoning", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "providers.json": providersJson("myrouter", { baseURL: "https://x", apiKey: "$K", models: {} }) },
	});
	expect(itemsFor(planOf(home, cwd), "providers.json → myrouter")[0].detail).toContain(
		"declares no model this reader would load",
	);
});

test("a fully-specified model carries its window, budget, name and price", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("myrouter", {
				baseURL: "https://x",
				apiKey: "$K",
				models: {
					m1: {
						name: "M One",
						limit: { context: 100_000, output: 4096 },
						cost: { input: 1, output: 2, cacheRead: 0.5 },
						reasoning: true,
						reasoningEfforts: ["low", "ultra"],
					},
				},
			}),
		},
	});
	const plan = planOf(home, cwd);
	const providers = settingsWrite(plan)?.providers as { openaiCompatible: Array<Record<string, unknown>> };
	expect(providers.openaiCompatible[0].models).toEqual([
		{
			id: "m1",
			contextWindow: 100_000,
			maxOutputTokens: 4096,
			name: "M One",
			reasoning: true,
			pricing: { input: 1, output: 2, cacheRead: 0.5 },
		},
	]);
	expect(itemsFor(plan, "providers.json → myrouter")[0].detail).toContain("no destination");
});

test("a wire protocol decided by an npm package says what the source did with it", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("claudeish", {
				npm: "@ai-sdk/anthropic",
				baseURL: "https://x",
				apiKey: "$K",
				...PROVIDER_MODELS,
			}),
		},
	});
	const plan = planOf(home, cwd);
	const providers = (settingsWrite(plan) as Record<string, unknown>).providers as {
		openaiCompatible: Array<Record<string, unknown>>;
	};
	expect(providers.openaiCompatible).toHaveLength(1);
	// The package named the Anthropic wire, and this build speaks it: the
	// protocol travels, so the entry needs no downgrade of its own. The note
	// that remains is about the package not being installed.
	expect(providers.openaiCompatible[0].api).toBe("anthropic-messages");
	const item = itemsFor(plan, "providers.json → claudeish")[0];
	expect(item.action).toBe("downgrade");
	expect(item.detail).toContain("@ai-sdk/anthropic");
	expect(item.detail).toContain("protocol it stood for was read");
});

test("the Messages wire's version segment is folded into the client", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("claudeish", {
				api: "anthropic-messages",
				baseURL: "https://api.example.com/v1",
				apiKey: "$K",
				...PROVIDER_MODELS,
			}),
		},
	});
	const plan = planOf(home, cwd);
	const providers = (settingsWrite(plan) as Record<string, unknown>).providers as {
		openaiCompatible: Array<Record<string, unknown>>;
	};
	// The source's client appends `/messages` to this address; this build's
	// appends `/v1/messages`, so the version segment must not stay in the URL.
	expect(providers.openaiCompatible[0].baseUrl).toBe("https://api.example.com");
	const item = itemsFor(plan, "providers.json → claudeish")[0];
	expect(item.action).toBe("map");
	expect(item.detail).toContain("lost the trailing /v1");
});

test("an explicit Responses wire is carried as-is, with no downgrade line", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("responser", {
				api: "openai-responses",
				baseURL: "https://api.example.com/v1",
				apiKey: "$K",
				...PROVIDER_MODELS,
			}),
		},
	});
	const plan = planOf(home, cwd);
	const providers = (settingsWrite(plan) as Record<string, unknown>).providers as {
		openaiCompatible: Array<Record<string, unknown>>;
	};
	expect(providers.openaiCompatible[0].api).toBe("openai-responses");
	expect(itemsFor(plan, "providers.json → responser")[0].action).toBe("map");
});

test("a base URL carrying a credential is refused whole, with the password absent from the plan", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": providersJson("myrouter", {
				baseURL: "https://u:password123@api.example.com/v1",
				apiKey: "$K",
				...PROVIDER_MODELS,
			}),
		},
	});
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "providers.json → myrouter")[0];
	expect(item.containsSecret).toBe(true);
	expect(item.detail).toContain("base URL carries a credential");
	expect(JSON.stringify(plan)).not.toContain("password123");
});

test("a tombstoned id is named as disabled rather than imported over", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"providers.json": JSON.stringify({
				providers: { dupe: { disabled: true }, live: { baseURL: "https://x", apiKey: "$K", ...PROVIDER_MODELS } },
			}),
		},
	});
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "providers.json → disabled")[0];
	expect(item.detail).toContain("recorded as disabled");
	expect(item.detail).toContain("dupe");
	const providers = (settingsWrite(plan) as Record<string, unknown>).providers as {
		openaiCompatible: Array<{ id: string }>;
	};
	expect(providers.openaiCompatible).toHaveLength(1);
});

test("an id the target already defines is kept unless --force", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "providers.json": providersJson("myrouter", { baseURL: "https://x", apiKey: "$K", ...PROVIDER_MODELS }) },
	});
	const existing = {
		providers: {
			openaiCompatible: [{ id: "myrouter", baseUrl: "https://mine.example/v1", apiKeyEnv: "MINE_KEY", models: [] }],
		},
	};
	const kept = planOf(home, cwd, { existing });
	expect(kept.items.some((entry) => entry.detail.includes("target already defines a provider with this id"))).toBe(
		true,
	);
	const forced = planOf(home, cwd, { existing, force: true });
	expect(settingsWrite(forced)?.providers).toBeDefined();
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const SKILL_OK = "---\nname: mine\ndescription: Does mine things\n---\nBody\n";

test("a skill under ~/.commandcode/skills travels to the target's skills tree", () => {
	const { home, cwd } = commandCodeFixture({ files: { "skills/mine/SKILL.md": SKILL_OK } });
	const plan = planOf(home, cwd);
	const write = plan.writes.find((entry) => entry.kind === "skill");
	expect(write?.path).toBe(join(home, ".labunbun", "skills", "mine", "SKILL.md"));
	expect(write?.content).toBe(SKILL_OK);
});

test("the CLI's own six skill rules are enforced before anything is written", () => {
	const mismatch = commandCodeFixture({
		files: { "skills/mine/SKILL.md": "---\nname: other\ndescription: d\n---\nB\n" },
	});
	expect(itemsFor(planOf(mismatch.home, mismatch.cwd), "SKILL.md")[0].detail).toContain("does not match directory");

	const noDescription = commandCodeFixture({
		files: { "skills/mine/SKILL.md": "---\nname: mine\n---\nB\n" },
	});
	expect(itemsFor(planOf(noDescription.home, noDescription.cwd), "SKILL.md")[0].detail).toContain(
		"description: Skill description is required",
	);

	const badName = commandCodeFixture({
		files: { "skills/bad_skill/SKILL.md": "---\nname: bad_skill\ndescription: d\n---\nB\n" },
	});
	expect(itemsFor(planOf(badName.home, badName.cwd), "SKILL.md")[0].detail).toContain(
		"only lowercase letters, numbers, and hyphens",
	);
});

test("the lowercase manifest spelling is accepted, and skills are found one level down", () => {
	const lower = commandCodeFixture({
		files: { "skills/lower/skill.md": "---\nname: lower\ndescription: d\n---\nB\n" },
	});
	expect(planOf(lower.home, lower.cwd).writes.some((entry) => entry.kind === "skill")).toBe(true);

	const nested = commandCodeFixture({
		files: { "skills/group/one/SKILL.md": "---\nname: one\ndescription: d\n---\nB\n" },
	});
	expect(planOf(nested.home, nested.cwd).writes.some((entry) => entry.kind === "skill")).toBe(true);
});

test("a loose .md file and a directory with nothing in it get the CLI's own two warnings", () => {
	const { home, cwd } = commandCodeFixture({ files: { "skills/loose.md": "# loose\n" } });
	mkdirSync(join(home, COMMAND_CODE_DEFAULT_DIR, "skills", "hollow"), { recursive: true });
	const plan = planOf(home, cwd);
	const details = itemsFor(plan, "skills/").map((entry) => entry.detail);
	expect(details.some((detail) => detail.includes("wrapped in a directory named after the skill"))).toBe(true);
	expect(details.some((detail) => detail.includes("no SKILL.md (or skill.md) in the first 5 levels"))).toBe(true);
});

test("agents travel one file per agent", () => {
	const { home, cwd } = commandCodeFixture({ files: { "agents/reviewer.md": "You review.\n" } });
	const plan = planOf(home, cwd);
	const write = plan.writes.find((entry) => entry.kind === "agent");
	expect(write?.path).toBe(join(home, ".labunbun", "agents", "reviewer.md"));
	expect(write?.content).toBe("You review.\n");
});

test("a command file becomes a skill under its dashed name, frontmatter rewritten, and the rename is one line", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "commands/git/commit.md": "---\ndescription: Commit helper\n---\nRun git\n" },
	});
	const plan = planOf(home, cwd);
	const write = plan.writes.find((entry) => entry.kind === "skill");
	expect(write?.path).toBe(join(home, ".labunbun", "skills", "git-commit", "SKILL.md"));
	expect(write?.content).toBe("---\nname: git-commit\ndescription: Commit helper\n---\nRun git\n");
	// The per-file line says what happens to a command; a second line joins the
	// files that land under a different name and spells the rename out.
	const item = itemsFor(plan, "commands")[0];
	expect(item.detail).toContain("command imported as a skill");
	expect(
		itemsFor(plan, "commands").some((entry) => entry.detail.includes("`git/commit.md` becomes `git-commit`")),
	).toBe(true);
});

test("AGENTS.md becomes a rule file rather than MEMORY.md, so it merges instead of replacing", () => {
	const { home, cwd } = commandCodeFixture({ files: { "AGENTS.md": "# Memo\n" } });
	const plan = planOf(home, cwd);
	const write = plan.writes.find((entry) => entry.kind === "rule");
	expect(write?.path).toBe(join(home, ".labunbun", "rules", "imported-command-code.md"));
	expect(write?.content).toBe("# Memo\n");
	expect(itemsFor(plan, "AGENTS.md")[0].detail).toContain(
		"imported as a rule file so it merges with existing memory instead of replacing it",
	);
});

test("the shared ~/.agents home is named here and imported by the agents source, not twice", () => {
	const shared = "---\nname: shared\ndescription: d\n---\nB\n";
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ model: "sonnet" }) },
		homeFiles: { ".agents/skills/shared/SKILL.md": shared },
	});
	const plan = planOf(home, cwd);
	expect(itemsFor(plan, "~/.agents/skills")[0].detail).toContain("run `--from agents` for it");
	expect(plan.writes.some((entry) => entry.path.endsWith(join("shared", "SKILL.md")))).toBe(false);

	const both = runMigration({
		home,
		cwd,
		from: "command-code,agents",
		only: ["settings", "assets"],
		apply: false,
	}).plan;
	const copies = both.writes.filter((entry) => entry.path.endsWith(join("shared", "SKILL.md")));
	expect(copies).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Leftovers
// ---------------------------------------------------------------------------

test("a settings file that is present and not JSON is a sentence, not silence", () => {
	const { home, cwd } = commandCodeFixture({ files: { "settings.json": "}}}not json{{{" } });
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "settings.json")[0];
	expect(item.action).toBe("skip");
	expect(item.detail).toContain("is present and is not JSON");
});

test("the legacy keys with no destination are named, and the ones outside the eight are named too", () => {
	const recognized = commandCodeFixture({ files: { "config.json": settingsJson({ reasoningEffort: "high" }) } });
	const recognizedPlan = planOf(recognized.home, recognized.cwd);
	const item = itemsFor(recognizedPlan, "reasoningEffort")[0];
	expect(item.detail).toContain("no destination here");
	expect(item.detail).toContain("`model` and `theme` are the two of its eight");

	const unhandled = commandCodeFixture({ files: { "config.json": settingsJson({ mysteryKey: "canary-legacy-5" }) } });
	const unhandledPlan = planOf(unhandled.home, unhandled.cwd);
	const other = itemsFor(unhandledPlan, "mysteryKey")[0];
	expect(other.detail).toContain("outside the eight its own reader recognizes");
	expect(JSON.stringify(unhandledPlan)).not.toContain("canary-legacy-5");
});

test("settings keys are split three ways: read, passed over, and not read — each named as its own kind of thing", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ telemetry: 1, skills: {} }) },
	});
	const plan = planOf(home, cwd);
	const unread = plan.items.find((entry) => entry.detail.includes("were not read"));
	expect(unread?.detail).toContain("telemetry");
	const passedOver = plan.items.find((entry) => entry.detail.includes("recognizes and deliberately leaves"));
	expect(passedOver?.detail).toContain("skills");
});

test("a subkey inside `mcp` that is not `servers` is named too", () => {
	const { home, cwd } = commandCodeFixture({
		files: { "settings.json": settingsJson({ mcp: { servers: [], proxy: "x" } }) },
	});
	expect(planOf(home, cwd).items.some((entry) => entry.detail.includes("mcp.proxy"))).toBe(true);
});

test("the other release channels' config files are named and not read", () => {
	const { home, cwd } = commandCodeFixture({ files: { "config.local.json": settingsJson({ model: "sonnet" }) } });
	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "config.local.json")[0];
	expect(item.action).toBe("skip");
	expect(item.detail).toContain("release channels other than the released one");
});

test("the four trees that exist but are not read each get their reason in one line", () => {
	const { home, cwd } = commandCodeFixture({});
	mkdirSync(join(home, COMMAND_CODE_DEFAULT_DIR, "file-history"), { recursive: true });
	mkdirSync(join(home, COMMAND_CODE_DEFAULT_DIR, "sessions"), { recursive: true });
	mkdirSync(join(home, COMMAND_CODE_DEFAULT_DIR, "projects"), { recursive: true });
	writeFileSync(join(home, COMMAND_CODE_DEFAULT_DIR, "trusted-hooks.json"), "{}\n");
	const plan = planOf(home, cwd);
	const byPath = (name: string) => plan.items.find((entry) => entry.from.includes(name));
	expect(byPath("file-history")?.detail).toContain("per-session file checkpoints");
	expect(byPath("sessions")?.detail).toContain("hook audit logs");
	expect(byPath("projects")?.detail).toContain("reads no project's configuration");
	expect(byPath("trusted-hooks")?.detail).toContain("fingerprints of hooks you have approved");
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test("the credential files are named by the report and never opened — the canaries stay in their files", () => {
	const canaries = {
		"auth.json": "sk-canary-auth-6",
		"credentials.json": "sk-canary-creds-7",
		"mcp-tokens.json": "sk-canary-mcp-8",
	};
	const files: Record<string, string> = {};
	for (const [name, canary] of Object.entries(canaries)) files[name] = JSON.stringify({ apiKey: canary });
	const { home, cwd } = commandCodeFixture({ files: { ...files, "settings.json": settingsJson({ model: "sonnet" }) } });

	const raw = readCommandCode(home);
	expect(raw.credentialFiles).toEqual(["auth.json", "credentials.json", "mcp-tokens.json"]);
	const rawText = JSON.stringify(raw);
	for (const canary of Object.values(canaries)) expect(rawText).not.toContain(canary);

	const plan = planOf(home, cwd);
	const item = itemsFor(plan, "auth.json")[0];
	expect(item.action).toBe("skip");
	expect(item.from).toBe("~/.commandcode → auth.json, credentials.json, mcp-tokens.json");
	expect(item.detail).toContain("checked that the files are there and never opened them");
	const planText = JSON.stringify(plan);
	for (const canary of Object.values(canaries)) expect(planText).not.toContain(canary);
});

test("no shape of credential reaches the plan, across every channel this source has", () => {
	const { home, cwd } = commandCodeFixture({
		files: {
			"mcp.json": JSON.stringify({
				mcpServers: {
					a: { command: "x", env: { TOKEN: "sk-canary-1" } },
					b: { command: "x", headers: { Authorization: "Bearer sk-canary-2" } },
					c: { url: "https://u:sk-canary-3@h/mcp" },
				},
			}),
			"providers.json": providersJson("myrouter", {
				baseURL: "https://x",
				apiKey: "sk-canary-4",
				...PROVIDER_MODELS,
			}),
			"auth.json": JSON.stringify({ apiKey: "sk-canary-5" }),
			"config.json": settingsJson({ mysteryKey: "sk-canary-6" }),
		},
	});
	const result = runMigration({ home, cwd, from: "command-code", only: ["settings", "assets"], apply: false });
	const text = JSON.stringify(result.plan);
	for (const canary of ["sk-canary-1", "sk-canary-2", "sk-canary-3", "sk-canary-4", "sk-canary-5", "sk-canary-6"]) {
		expect(text).not.toContain(canary);
	}
	// The plan still carries the parts that *are* importable — a scrub that
	// refused everything would pass the loop above and fail this.
	expect(result.plan.writes.some((entry) => entry.kind === "mcp")).toBe(true);
});
