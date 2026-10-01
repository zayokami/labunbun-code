/**
 * The `t3-code` source, planner half: `settings.json`, the runtime mode, the
 * two model keys, the provider environment, and everything the report has to
 * account for by name.
 *
 * Four facts about this source decide the shape of nearly every test here, and
 * each one is pinned below where it is used:
 *
 *   - **an absent `defaultRuntimeMode` is T3's own default, which is
 *     `full-access`** (`DEFAULT_RUNTIME_MODE`, `packages/contracts/src/orchestration.ts:135`),
 *     and T3 strips defaults before persisting
 *     (`stripDefaultServerSettings`, `apps/server/src/serverSettings.ts:387-419`,
 *     called at `:550`). So a file with no `defaultRuntimeMode` is a user who
 *     said nothing, and importing that absence would hand them agent mode with no
 *     sandbox. The "absent claims nothing" test is the one that would fail if
 *     this importer ever grew a default-filling branch;
 *   - **a sensitive environment entry holds a redaction marker, not a value**
 *     (`SECRET_REDACTED`, `serverSettings.ts:147`). Writing `••••••` into the
 *     target's settings would produce a variable that looks configured and
 *     silently fails, so the sentinel assertions below require the marker to
 *     appear nowhere in the report;
 *   - **the routing key does not port.** A `ModelSelection` names an instance id
 *     from T3's own provider registry, so only a model whose *name* also exists
 *     in this build's registry can be claimed at all;
 *   - **the two settings files beside `settings.json` hold nothing portable**,
 *     and the report says so per file rather than dropping them.
 *
 * Fixtures hold fake values only, and this file never opens a real T3 install:
 * `$T3CODE_HOME` and every other source-relocating variable are borrowed for the
 * duration of each fixture (see `TREE_ENV`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERMISSION_MODES, SANDBOX_MODES } from "@labunbun/agent";
import { BUILT_IN_THEME_NAMES } from "@labunbun/tui";
import {
	detectSources,
	MIGRATION_SOURCE_IDS,
	MIGRATION_SOURCE_LABELS,
	type MigrationItem,
	type MigrationPlan,
	parseFromOption,
	planMigration,
	readSources,
} from "../src/migrate.ts";
import { resolveModelReference } from "../src/migrate-types.ts";
import type { RawSettingsInput } from "../src/settings.ts";
import { T3_DEFAULT_DIR, t3BaseDir, t3Root, t3StateDirs } from "../src/t3-home.ts";
import { T3_RUNTIME_MODES } from "../src/t3-plan.ts";

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

/**
 * Every variable that can put a *tree* outside the fixture's own home.
 *
 * `sourceRoot` asks each source's root function, and every one of them reads an
 * environment variable before its default. A developer with any of these set
 * would have the outcome of a detection test decided by their own machine, so
 * they are all cleared for the duration of a fixture.
 */
const TREE_ENV = [
	"T3CODE_HOME",
	"APPDATA",
	"CODEX_HOME",
	"CURSOR_CONFIG_DIR",
	"CURSOR_DATA_DIR",
	"DSH_HOME",
	"GROK_HOME",
	"KIMI_CODE_HOME",
	"KIMI_SHARE_DIR",
	"MAVIS_DATA_DIR",
	"MINIMAX_DATA_DIR",
	"OPENCODE_CONFIG_DIR",
	"OPENCODE_DB",
	"STEP_CODING_AGENT_DIR",
	"STEP_CODING_AGENT_SESSION_DIR",
	"STEPCODE_CONFIG_DIR",
	"STEPCODE_STORAGE_ROOT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"ZCODE_DATA_BASE_DIR",
	"ZCODE_SESSION_DB",
	"ZCODE_SESSION_DB_PATH",
	"ZCODE_STORAGE_DIR",
];

/**
 * A home with a T3 state tree in it, written under `userdata` unless `dev` is
 * asked for.
 *
 * `settings` is the document's own object, so a test writes exactly the keys it
 * means to write — including none of them, which is the case the runtime-mode
 * table is most easily broken by.
 */
function t3Home(
	settings: Record<string, unknown> | null = {},
	subdir = "userdata",
): { home: string; stateDir: string } {
	const home = makeDir("lbb-t3-home-");
	for (const name of TREE_ENV) setEnv(name, undefined);
	const stateDir = join(home, T3_DEFAULT_DIR, subdir);
	mkdirSync(stateDir, { recursive: true });
	if (settings !== null) {
		writeFileSync(join(stateDir, "settings.json"), JSON.stringify(settings, null, "\t"));
	} else {
		// A state directory with something in it that is not the settings file, so
		// the tree still counts as present — `t3Root` requires content, not a file.
		writeFileSync(join(stateDir, "state.sqlite"), "");
	}
	return { home, stateDir };
}

function plan(home: string, existing: RawSettingsInput = {}, force = false): MigrationPlan {
	return planMigration(readSources(home, home), existing, { only: ["t3-code"], force });
}

function itemsOf(planned: MigrationPlan): MigrationItem[] {
	return planned.items.filter((item) => item.source === "t3-code");
}

/** The single item whose `to` is exactly this, so a claim can be read whole. */
function itemTo(planned: MigrationPlan, to: string): MigrationItem | undefined {
	return itemsOf(planned).find((item) => item.to === to);
}

/** The `from` labels matching — for the lines whose subject is named there. */
function fromsMatching(planned: MigrationPlan, pattern: RegExp): string[] {
	return itemsOf(planned)
		.filter((item) => pattern.test(item.from))
		.map((item) => item.from);
}

/** The item details matching, so a test can name one line of the report. */
function detailsMatching(planned: MigrationPlan, pattern: RegExp): string[] {
	return itemsOf(planned)
		.filter((item) => pattern.test(item.detail))
		.map((item) => item.detail);
}

/** The settings file the plan would write, parsed. */
function settingsWritten(planned: MigrationPlan): Record<string, unknown> {
	const write = planned.writes.find((candidate) => candidate.kind === "settings");
	return write === undefined ? {} : (JSON.parse(write.content) as Record<string, unknown>);
}

/** Everything the report would say, as one string — for the sentinel assertions. */
function reportText(planned: MigrationPlan): string {
	return itemsOf(planned)
		.map((item) => `${item.from}\n${item.to}\n${item.detail}`)
		.join("\n");
}

// ---------------------------------------------------------------------------
// The source itself
// ---------------------------------------------------------------------------

describe("the thirteenth source", () => {
	test("it is appended, so the twelve before it keep their places", () => {
		// The list is append-only (`MIGRATION_SOURCE_IDS`, migrate-types.ts:53-67) and
		// its order is what `detectSources` reports — reordering silently changes
		// which of two sources providing the same file wins. So the claim is the
		// position and the twelve names above it, not "this is the last one".
		expect(MIGRATION_SOURCE_IDS.indexOf("t3-code")).toBe(12);
		expect(MIGRATION_SOURCE_IDS.slice(0, 12)).toEqual([
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
			"trae",
		]);
		expect(MIGRATION_SOURCE_LABELS["t3-code"]).toBe("T3 Code");
	});

	test("--from t3-code is accepted, and a misspelling still names the whole list", () => {
		const home = makeDir("lbb-t3-root-");
		expect(parseFromOption("t3-code", home)).toEqual(["t3-code"]);
		const bad = parseFromOption("t3", home);
		expect(bad).toHaveProperty("error");
		const message = (bad as { error: string }).error;
		for (const id of MIGRATION_SOURCE_IDS) expect(message).toContain(id);
		expect(message).toContain("all");
	});

	test("detection wants content in the state directory, not the base directory", () => {
		// `t3StateDirs` returns two paths and `detectionRoots` hands both to
		// `sourceHasContent`, so an empty `.t3` is not a T3 install. A base directory
		// that exists and holds nothing is what T3 leaves behind after a settings
		// reset, and calling that "you have T3" would be a detection that fires on
		// every machine that ever opened it.
		const home = makeDir("lbb-t3-detect-");
		for (const name of TREE_ENV) setEnv(name, undefined);
		mkdirSync(join(home, T3_DEFAULT_DIR, "userdata"), { recursive: true });
		expect(detectSources(home)).not.toContain("t3-code");

		writeFileSync(join(home, T3_DEFAULT_DIR, "userdata", "settings.json"), "{}");
		expect(detectSources(home)).toContain("t3-code");
	});

	test("$T3CODE_HOME moves the tree, and a blank value is unset", () => {
		// `t3BaseDir` (t3-home.ts) trims and treats an all-whitespace value as
		// unset, which is T3's own reading (`normalizeConfiguredBaseDir`,
		// `DesktopStatePaths.ts:6-11`) — a blank value does not name a directory
		// called "   ".
		const { home } = t3Home({ defaultRuntimeMode: "approval-required" });
		expect(t3BaseDir(home)).toBe(join(home, T3_DEFAULT_DIR));

		setEnv("T3CODE_HOME", "   ");
		expect(t3BaseDir(home)).toBe(join(home, T3_DEFAULT_DIR));

		const moved = makeDir("lbb-t3-moved-");
		mkdirSync(join(moved, "userdata"), { recursive: true });
		writeFileSync(join(moved, "userdata", "settings.json"), '{"defaultRuntimeMode":"full-access"}');
		setEnv("T3CODE_HOME", moved);
		expect(t3BaseDir(home)).toBe(moved);
		expect(t3Root(home)).toBe(join(moved, "userdata"));

		// The override wins over the default tree, so the report's paths name the
		// tree T3 would have written, not the one it would have found. Two lines,
		// because `claimModePair` claims each axis under the same `from` — and the
		// path is not shortened, because the override put the tree outside the home
		// the report shortens against.
		const planned = plan(home);
		const moved_ = moved.replace(/\\/g, "/");
		expect(fromsMatching(planned, /defaultRuntimeMode/)).toEqual([
			`${moved_}/userdata/settings.json → defaultRuntimeMode ("full-access")`,
			`${moved_}/userdata/settings.json → defaultRuntimeMode ("full-access")`,
		]);
	});

	test("the dev tree is detected but only read when it is the one with something in it", () => {
		// `t3StateDirs` returns both and `t3Root` reads the first with content, so
		// a machine whose only T3 is a dev checkout is not called empty. The
		// production directory still wins when both hold something — see
		// t3-home.ts for why that is a choice rather than an oversight — and the
		// tree that was not read is named rather than dropped in silence.
		const home = makeDir("lbb-t3-dev-");
		for (const name of TREE_ENV) setEnv(name, undefined);
		const devDir = join(home, T3_DEFAULT_DIR, "dev");
		mkdirSync(devDir, { recursive: true });
		writeFileSync(join(devDir, "settings.json"), '{"defaultRuntimeMode":"approval-required"}');
		expect(detectSources(home)).toContain("t3-code");
		expect(t3Root(home)).toBe(devDir);
		expect(t3StateDirs(home)).toEqual([join(home, T3_DEFAULT_DIR, "userdata"), devDir]);

		// Now give the installed tree something too. Production wins, and the dev
		// tree is named in the report — "the migration ignored a directory full of
		// my conversations" and "there was no dev tree" look identical from outside.
		const userdata = join(home, T3_DEFAULT_DIR, "userdata");
		mkdirSync(userdata, { recursive: true });
		writeFileSync(join(userdata, "settings.json"), '{"defaultRuntimeMode":"full-access"}');
		expect(t3Root(home)).toBe(userdata);
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBe("agent");
		const named = detailsMatching(planned, /development build's state directory/);
		expect(named).toHaveLength(1);
		expect(named[0]).toContain("Nothing here was merged in");
	});

	test("a dev tree that is not there is not named either", () => {
		// The other half of the line above, and the one an installed user sees on
		// every single run. `t3StateDirs` always returns two paths, so a check that
		// asks "does the other directory have content" and treats *cannot tell* as
		// *yes* would tell every user with a normal install that a development
		// build's state directory was found and left behind — a directory that does
		// not exist. `noteOtherStateDirs` reads existence, not just emptiness, and
		// this is the test that says so.
		const { home } = t3Home({ defaultRuntimeMode: "approval-required" });
		expect(existsSync(join(home, T3_DEFAULT_DIR, "dev"))).toBe(false);
		const planned = plan(home);
		expect(detailsMatching(planned, /development build's state directory/)).toEqual([]);
		expect(reportText(planned)).not.toContain(`${T3_DEFAULT_DIR}/dev`);
	});
});

// ---------------------------------------------------------------------------
// The runtime mode
// ---------------------------------------------------------------------------

describe("the runtime mode", () => {
	/**
	 * Every row of T3's own mode table, as the pair this build splits it into.
	 *
	 * Both halves are claimed on every mapped row, and that is the claim: a
	 * foreign mode is one value doing two jobs, and an import that writes
	 * `permissionMode` and leaves `sandbox` to a default nobody chose is carrying
	 * half a decision (`claimModePair`, migrate.ts:339-352).
	 */
	const ROWS = [
		{ t3: "approval-required", mode: "ask", sandbox: "workspace-write" },
		{ t3: "auto-accept-edits", mode: "ask", sandbox: "workspace-write" },
		{ t3: "full-access", mode: "agent", sandbox: "danger-full-access" },
	] as const;

	test("the table holds exactly T3's four modes, and the fourth is the unmapped one", () => {
		// `RuntimeMode` is `Schema.Literals(["approval-required", "auto-accept-edits",
		// "auto", "full-access"])`, `packages/contracts/src/orchestration.ts:127-132`.
		// Spelled out here rather than imported: the point is that this table has
		// one row per vendor value, and a vendor that adds a fifth is a row nobody
		// has checked.
		expect(Object.keys(T3_RUNTIME_MODES).sort()).toEqual([
			"approval-required",
			"auto",
			"auto-accept-edits",
			"full-access",
		]);
		// `auto` is the deliberate hole: T3's own description is "Supported providers
		// approve routine actions; others still ask" (`runtimeModeConfig.ts:19-22`) —
		// a classifier decides, and the nearest mode here puts a person in the loop
		// instead. `undefined` is a value in the table on purpose: it is what makes
		// `Object.keys` count the row.
		expect(T3_RUNTIME_MODES.auto).toBeUndefined();
		expect(Object.values(T3_RUNTIME_MODES).filter(Boolean)).toHaveLength(3);
	});

	test("every row of the table claims both halves of the pair", () => {
		for (const row of ROWS) {
			const { home } = t3Home({ defaultRuntimeMode: row.t3 });
			const planned = plan(home);
			const written = settingsWritten(planned);
			expect(written.permissionMode).toBe(row.mode);
			expect(written.sandbox).toBe(row.sandbox);

			const mode = itemTo(planned, "settings.json → permissionMode");
			const sandbox = itemTo(planned, "settings.json → sandbox");
			const label = `~/.t3/userdata/settings.json → defaultRuntimeMode ("${row.t3}")`;
			expect(mode?.from).toBe(label);
			expect(sandbox?.from).toBe(label);
			expect(mode?.detail).toContain(`mapped to "${row.mode}"`);
		}
	});

	test("no row lands on a mode or a sandbox this build does not have", () => {
		// The value space is the two constant tables rather than a second list of
		// literals spelled here: a row resolving to a retired name is still a string
		// this build would write, and `settings.json` refuses it at load rather than
		// at the moment a user goes looking for the setting.
		for (const row of ROWS) {
			const written = settingsWritten(plan(t3Home({ defaultRuntimeMode: row.t3 }).home));
			expect(PERMISSION_MODES as readonly unknown[]).toContain(written.permissionMode);
			expect(SANDBOX_MODES as readonly unknown[]).toContain(written.sandbox);
		}
	});

	test("absent claims nothing, because T3's own default is full access", () => {
		// This is the assertion the whole mapper is built around. T3's
		// `defaultRuntimeMode` decodes to `DEFAULT_RUNTIME_MODE` = `full-access`
		// (`settings.ts:1148`), and its writer strips anything equal to the decoded
		// defaults before persisting (`serverSettings.ts:387-419`, called at `:550`).
		// So a file with no such key is a user who never chose one, and filling in
		// the default here would write `agent` + `danger-full-access` for a decision
		// nobody made. Nothing is written and the report says the mode was left
		// alone, which is the direction that fails safe.
		const { home } = t3Home({ defaultModelSelection: { instanceId: "codex", model: "sonnet" } });
		const planned = plan(home);
		const written = settingsWritten(planned);
		expect(written.permissionMode).toBeUndefined();
		expect(written.sandbox).toBeUndefined();
		expect(itemsOf(planned).some((item) => item.to === "settings.json → permissionMode")).toBe(false);
		expect(itemsOf(planned).some((item) => /defaultRuntimeMode/.test(item.from))).toBe(false);
	});

	test("an empty settings file claims nothing, and the two files that are not there are named", () => {
		// The degenerate version of the row above: a file T3 wrote before the user
		// changed anything, or one a user emptied by hand. `reportUnhandledKeys` has
		// nothing to account for either, so what is left is the reader saying which
		// of the other two documents it looked for — and finding neither is a fact
		// about this install, not a gap in the report.
		const planned = plan(t3Home({}).home);
		expect(fromsMatching(planned, /settings\.json$/)).toEqual(["client-settings.json", "desktop-settings.json"]);
		expect(detailsMatching(planned, /not in the state directory/)).toHaveLength(2);
		expect(settingsWritten(planned)).toEqual({});
	});

	test("auto is reported rather than renamed, and the reason says what a mode would change", () => {
		// `ask` and `agent` are both wrong in opposite directions, and saying only
		// "unmapped" would leave the user to guess which one they would have got.
		const { home } = t3Home({ defaultRuntimeMode: "auto" });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
		const line = fromsMatching(planned, /defaultRuntimeMode/);
		expect(line).toEqual(['~/.t3/userdata/settings.json → defaultRuntimeMode ("auto")']);
		const detail = detailsMatching(planned, /classifier/);
		expect(detail).toHaveLength(1);
		expect(detail[0]).toContain("Either would change the posture the mode names");
	});

	test("a value T3 does not define is reported as never having decided a session", () => {
		// The file is decoded leniently and outlives the build that wrote it, so a
		// hand-edited or legacy value can hold anything. "Not a mode t3 code defines"
		// is a different sentence from `auto`'s, and the two are not interchangeable:
		// one says the value means nothing, the other says the value means something
		// this build cannot express.
		const { home } = t3Home({ defaultRuntimeMode: "yolo" });
		const detail = detailsMatching(plan(home), /not a mode t3 code defines/);
		expect(detail).toHaveLength(1);
		expect(detail[0]).toContain("never decided a session");
		expect(settingsWritten(plan(home)).permissionMode).toBeUndefined();
	});

	test("the auto-accept-edits row says it is narrower than the mode it replaced", () => {
		// Mapping `auto-accept-edits` to `ask` widens what asks, not what runs, and
		// the same call `CLAUDE_PERMISSION_MODES` and `MINIMAX_PERMISSION_MODES` make.
		// A report that called this a rename would tell the user their writes are now
		// silent when the truth is the reverse.
		const { home } = t3Home({ defaultRuntimeMode: "auto-accept-edits" });
		const detail = detailsMatching(plan(home), /Narrower than the mode it replaced/);
		expect(detail).toHaveLength(1);
	});

	test("the full-access row is the only one that unconfines the sandbox, and the report says so", () => {
		// The other three rows keep the sandbox confined, and the half T3 never
		// mentioned is recorded as chosen rather than found — otherwise a user
		// reading the report cannot tell which rows widened anything.
		const { home } = t3Home({ defaultRuntimeMode: "full-access" });
		const sandbox = itemTo(plan(home), "settings.json → sandbox");
		expect(sandbox?.detail).toContain("also meant no confinement");
		expect(sandbox?.detail).toContain("It is a separate key here");

		const asked = itemTo(plan(t3Home({ defaultRuntimeMode: "approval-required" }).home), "settings.json → sandbox");
		expect(asked?.detail).toContain("no separate confinement setting");
		expect(asked?.detail).not.toContain("unrestricted");
	});
});

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

describe("the model", () => {
	/** A model this build's registry carries, so the claim can succeed. */
	const KNOWN = (() => {
		for (const candidate of ["anthropic/claude-sonnet-5", "opus", "sonnet", "gpt-5.1"]) {
			if (resolveModelReference(candidate) !== undefined) return candidate;
		}
		throw new Error("no model in this build's registry to test the claim against");
	})();

	test("a name this build also carries is claimed, with the instance named", () => {
		// The instance is not carried — nothing here resolves one — but it is the
		// only record of which of T3's provider instances the model was pointed at,
		// and a user with three of them would otherwise lose it.
		const { home } = t3Home({ defaultModelSelection: { instanceId: "claude-agent", model: KNOWN } });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBe(resolveModelReference(KNOWN));
		const line = itemTo(planned, "settings.json → model");
		expect(line?.from).toBe(`~/.t3/userdata/settings.json → defaultModelSelection.model ("${KNOWN}")`);
		expect(line?.detail).toContain('routed through "claude-agent"');
		expect(line?.detail).toContain("an instance is a t3 code concept");
	});

	test("a name only T3 knows is reported, because its model list is its own", () => {
		// T3's picker is a list of providers it launches, not a shared registry, so
		// "gpt-4o" here means whatever that T3 install was configured with. There is
		// no lookup that would turn a coincidental name match into a correct one.
		const { home } = t3Home({ defaultModelSelection: { instanceId: "antigravity", model: "gemini-3-pro-preview" } });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		const detail = detailsMatching(planned, /provider registry/);
		expect(detail).toHaveLength(1);
		expect(detail[0]).toContain("no model this build carries goes by that name");
		expect(detail[0]).toContain('"antigravity" instance');
	});

	test("the pre-split provider field is read as the routing key, and named as such", () => {
		// T3's transform takes `provider` as the routing key when `instanceId` is
		// absent (`orchestration.ts:99-107`). A selection written by an older build
		// is not dropped for naming a field the current one no longer has.
		const { home } = t3Home({ defaultModelSelection: { provider: "codex", model: KNOWN } });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBe(resolveModelReference(KNOWN));
		expect(itemTo(planned, "settings.json → model")?.detail).toContain("pre-split provider field");
		expect(itemTo(planned, "settings.json → model")?.detail).toContain("is not carried");
	});

	test("an instanceId wins over a provider when a file somehow holds both", () => {
		// T3's transform prefers the current field (`:99-107`), so a file carrying
		// both is read the way T3 reads it rather than the way it happens to be
		// spelled in the fixture. The two words are how the report says which field
		// it read, so a reader that swapped them would show the wrong one.
		const { home } = t3Home({
			defaultModelSelection: { instanceId: "from-instance", provider: "from-legacy", model: KNOWN },
		});
		const line = itemTo(plan(home), "settings.json → model");
		expect(line?.detail).toContain('routed through "from-instance"');
		expect(line?.detail).not.toContain("from-legacy");
	});

	test("the default model wins over the text one, and the loser is named", () => {
		// One `model` key here, two in T3, so exactly one can be claimed and the
		// choice has to be stated. Preferring the text selection would frequently
		// import a model nobody chose: it decodes to the schema's own default
		// (`settings.ts:1244`) rather than anything the user wrote.
		const { home } = t3Home({
			defaultModelSelection: { instanceId: "codex", model: KNOWN },
			textGenerationModelSelection: { instanceId: "codex", model: "some-other-model" },
		});
		const planned = plan(home);
		expect(itemTo(planned, "settings.json → model")?.from).toContain("defaultModelSelection");
		const named = fromsMatching(planned, /textGenerationModelSelection/);
		expect(named).toEqual(['~/.t3/userdata/settings.json → textGenerationModelSelection.model ("some-other-model")']);
		expect(detailsMatching(planned, /one `model` setting/)).toHaveLength(1);
	});

	test("the text model is claimed when the default is absent", () => {
		// The other half of "the default wins": preferring it must not mean
		// requiring it. A user who set only the text selection gets that one.
		const { home } = t3Home({ textGenerationModelSelection: { instanceId: "codex", model: KNOWN } });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBe(resolveModelReference(KNOWN));
		expect(itemTo(planned, "settings.json → model")?.from).toContain("textGenerationModelSelection");
		// Nothing was superseded, so the loser line must not exist at all.
		expect(fromsMatching(planned, /defaultModelSelection/)).toEqual([]);
	});

	test("a selection with no model in it is not a selection", () => {
		// `ModelSelection` requires a non-empty model (`TrimmedNonEmptyString`), so a
		// T3 file cannot hold one — but the file is decoded leniently here and the
		// report's "nothing claimed" must be for the stated reason rather than
		// because an empty object happened to fall through.
		const { home } = t3Home({ defaultModelSelection: { instanceId: "codex" } });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		expect(detailsMatching(planned, /provider registry/)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The theme
// ---------------------------------------------------------------------------

describe("the theme", () => {
	test("no T3 theme id is a theme name here, and that is checked rather than assumed", () => {
		// T3 ships `t3-chat, grove, ocean, ember, iris`
		// (`packages/shared/src/themePalettes.ts:1`); this build's names come from
		// `@labunbun/tui`. The membership check in the mapper is kept even though the
		// sets cannot meet: a hand-written or legacy value can hold anything, and a
		// check that is *expected* to fail is still the correct thing to write.
		for (const id of ["t3-chat", "grove", "ocean", "ember", "iris"]) {
			expect(BUILT_IN_THEME_NAMES as readonly string[]).not.toContain(id);
		}
		// The two that *would* collide are `dark` and `light` — and this build has
		// both, which is why T3 excludes them structurally rather than by naming
		// convention: `EnvironmentThemeId` rejects `system|light|dark` by pattern
		// (`packages/contracts/src/server.ts:510-512`), because a published
		// `dark.json` would otherwise capture every client whose stored preference is
		// the stock `"dark"`.
		expect(BUILT_IN_THEME_NAMES as readonly string[]).toContain("dark");
		expect(BUILT_IN_THEME_NAMES as readonly string[]).toContain("light");
		expect(BUILT_IN_THEME_NAMES as readonly string[]).not.toContain("system");

		const { home } = t3Home({ defaultTheme: "grove" });
		const planned = plan(home);
		expect(settingsWritten(planned).theme).toBeUndefined();
		const detail = detailsMatching(planned, /names a theme t3 code owns/);
		expect(detail).toHaveLength(1);
		expect(detail[0]).toContain("t3-chat, grove, ocean, ember and iris");
	});

	test("a theme that does exist here is claimed, so the branch is not a skip in disguise", () => {
		// Without this the mapper would be a line that can only ever report, and the
		// membership test would be untested. The file is decoded leniently and
		// outlives the build that wrote it, so a hand-written value is reachable.
		const name = BUILT_IN_THEME_NAMES[0];
		const { home } = t3Home({ defaultTheme: name });
		const planned = plan(home);
		expect(settingsWritten(planned).theme).toBe(name);
		expect(itemTo(planned, "settings.json → theme")?.detail).toContain("built-in theme of the same name");
	});

	test("an absent theme claims nothing", () => {
		expect(settingsWritten(plan(t3Home({ defaultRuntimeMode: "ask" }).home)).theme).toBeUndefined();
		expect(fromsMatching(plan(t3Home({}).home), /defaultTheme/)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The provider environment
// ---------------------------------------------------------------------------

describe("the provider environment", () => {
	/**
	 * One provider instance, in the shape `settings.json` holds it.
	 *
	 * The id is **not** a parameter: it is the key the instance is filed under in
	 * the `providerInstances` map, and a helper that also took it would be a
	 * second place for the two to disagree.
	 */
	function instance(driver: string, environment: Array<Record<string, unknown>>): Record<string, unknown> {
		return { driver, environment };
	}

	test("a non-sensitive value is carried, and the report says its scope grew", () => {
		// In T3 these are injected into the one provider's process
		// (`providerInstance.ts:104-110`); a target `settings.env` reaches every tool
		// call, Bash included. Copying an `ANTHROPIC_BASE_URL` meant for one provider
		// into every shell is a widening the user did not ask for, so the line is a
		// `downgrade` and says so.
		const { home } = t3Home({
			providerInstances: {
				"claude-1": instance("claudeAgent", [{ name: "ANTHROPIC_BASE_URL", value: "https://gw.invalid" }]),
			},
		});
		const planned = plan(home);
		const written = settingsWritten(planned);
		expect((written.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe("https://gw.invalid");
		const line = itemTo(planned, "settings.json → env.ANTHROPIC_BASE_URL");
		expect(line?.action).toBe("downgrade");
		expect(line?.from).toBe("~/.t3/userdata/settings.json → providerInstances.claude-1.environment.ANTHROPIC_BASE_URL");
		expect(line?.detail).toContain('scoped it to the "claude-1" provider instance');
		expect(line?.detail).toContain("every tool call");
	});

	test("a sensitive entry is skipped by name, and the marker never reaches the report", () => {
		// T3 persists `SECRET_REDACTED` (`serverSettings.ts:147`) instead of the
		// value, so there is nothing here to copy — and copying the marker would
		// produce an environment variable that looks configured and silently fails.
		// The value never appears in the file either, so the marker is what would
		// leak; both are asserted.
		const { home, stateDir } = t3Home({
			providerInstances: {
				"claude-1": instance("claudeAgent", [
					{ name: "ANTHROPIC_API_KEY", value: "••••••", sensitive: true, valueRedacted: true },
				]),
			},
		});
		// The directory the real values live in is never opened — only its existence
		// would be visible, and this importer has no code that stats it.
		mkdirSync(join(stateDir, "secrets"), { recursive: true });
		writeFileSync(join(stateDir, "secrets", "opaque"), "not read by this importer");

		const planned = plan(home);
		expect(settingsWritten(planned).env).toBeUndefined();
		const report = reportText(planned);
		expect(report).toContain("ANTHROPIC_API_KEY");
		expect(report).not.toContain("••••••");
		expect(report).not.toContain("not read by this importer");
		expect(detailsMatching(planned, /kept in T3's secrets directory/)).toHaveLength(1);
	});

	test("two instances that disagree about one name are not merged", () => {
		// One value per variable at the target, so choosing one would silently drop
		// the other while the report line for the dropped one still said it was
		// imported. Naming both instances is the only outcome the user can fix.
		const { home } = t3Home({
			providerInstances: {
				"claude-1": instance("claudeAgent", [{ name: "HTTPS_PROXY", value: "http://a.invalid" }]),
				"codex-1": instance("codex", [{ name: "HTTPS_PROXY", value: "http://b.invalid" }]),
			},
		});
		const planned = plan(home);
		expect(settingsWritten(planned).env).toBeUndefined();
		const line = fromsMatching(planned, /HTTPS_PROXY/);
		expect(line).toEqual(['"claude-1", "codex-1" → environment.HTTPS_PROXY']);
		const detail = detailsMatching(planned, /2 provider instance\(s\)/);
		expect(detail).toHaveLength(1);
		expect(detail[0]).toContain("copying either would silently drop the other");
	});

	test("two instances that agree are claimed once, naming both", () => {
		// Agreement is not a conflict — there is nothing to choose — so the value is
		// written, and the report says it was not a merge of two different things.
		const { home } = t3Home({
			providerInstances: {
				"claude-1": instance("claudeAgent", [{ name: "NO_PROXY", value: "localhost" }]),
				"codex-1": instance("codex", [{ name: "NO_PROXY", value: "localhost" }]),
			},
		});
		const planned = plan(home);
		expect((settingsWritten(planned).env as Record<string, string>).NO_PROXY).toBe("localhost");
		const line = itemTo(planned, "settings.json → env.NO_PROXY");
		expect(line?.from).toBe('"claude-1", "codex-1" → environment.NO_PROXY');
		expect(line?.detail).toContain("nothing was lost by making it global");
	});

	test("the legacy single-instance providers map is read too", () => {
		// Same information in an older shape, keyed by the driver slug. Skipping it
		// would drop the environment of any user whose T3 predates the split.
		const { home } = t3Home({
			providers: {
				codex: { environment: [{ name: "CODEX_HOME_OVERRIDE", value: "x" }] },
			},
		});
		const planned = plan(home);
		const line = itemTo(planned, "settings.json → env.CODEX_HOME_OVERRIDE");
		expect(line?.from).toBe("~/.t3/userdata/settings.json → providerInstances.codex.environment.CODEX_HOME_OVERRIDE");
	});

	test("a per-driver config blob is never searched for a key", () => {
		// `config` is `Schema.Unknown` by design — each driver registers its own
		// decoder with the runtime registry — so a blob that happens to hold an
		// api key is not configuration this importer can read, and looking would be
		// the one place a credential could enter a report.
		const { home } = t3Home({
			providerInstances: {
				"claude-1": {
					driver: "claudeAgent",
					config: { apiKey: "sk-not-a-real-key", env: { HOME: "/root" } },
					environment: [],
				},
			},
		});
		const report = reportText(plan(home));
		expect(report).not.toContain("sk-not-a-real-key");
		expect(settingsWritten(plan(home)).env).toBeUndefined();
	});

	test("an entry with no name is not a variable", () => {
		// The schema requires a name, so this cannot come from T3 — but a leniently
		// decoded file can hold it, and a nameless entry would otherwise be written
		// as an environment variable called `undefined`.
		const { home } = t3Home({
			providerInstances: { "claude-1": instance("claudeAgent", [{ value: "orphan" }]) },
		});
		expect(settingsWritten(plan(home)).env).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// What the report has to account for
// ---------------------------------------------------------------------------

describe("what the report accounts for", () => {
	test("the per-project overrides are counted and named, never applied", () => {
		// A T3 project id is a key in its own database, not a directory, so even
		// with a per-project setting here there would be nothing to resolve it
		// against. The count is what makes "twelve decisions went missing" visible
		// rather than a migration that claims to have finished.
		const { home } = t3Home({
			projectSettingsOverrides: {
				"proj-a": { defaultModelSelection: { instanceId: "codex", model: "gpt-5.1" } },
				"proj-b": { defaultRuntimeMode: "approval-required" },
			},
		});
		const planned = plan(home);
		const line = fromsMatching(planned, /projectSettingsOverrides/);
		expect(line).toEqual(["~/.t3/userdata/settings.json → projectSettingsOverrides"]);
		const detail = detailsMatching(planned, /2 project\(s\) override the model/);
		expect(detail).toHaveLength(1);
		expect(detail[0]).toContain("proj-a");
		expect(detail[0]).toContain("proj-b");
		// Nothing about the override's own model was claimed: this build has no
		// per-project setting, so importing one would be a key nothing reads.
		expect(settingsWritten(planned).model).toBeUndefined();
	});

	test("one project is worded in the singular", () => {
		// A count-driven sentence with `they` for one project is the kind of report
		// line that makes a reader doubt the rest of the file.
		const { home } = t3Home({ projectSettingsOverrides: { "proj-a": {} } });
		const detail = detailsMatching(plan(home), /1 project\(s\) override the model/);
		expect(detail).toHaveLength(1);
		expect(detail[0]).toContain("so it could not be resolved to a path");
	});

	test("the rest of settings.json is named by one aggregate, not one line each", () => {
		// T3's schema holds dozens of keys that belong to a desktop app with a web,
		// a desktop and a mobile client. One line per key would bury the two that
		// matter; the aggregate is what makes a half-migrated document explainable.
		const { home } = t3Home({
			defaultRuntimeMode: "approval-required",
			defaultModelSelection: { instanceId: "codex", model: "sonnet" },
			defaultTheme: "grove",
			worktreeCleanup: { enabled: true },
			storageCleanup: { retentionDays: 30 },
			tailscale: { serving: { enabled: true } },
			deviceHosts: {},
		});
		const planned = plan(home);
		// `reportUnhandledKeys` puts the names in `from` and the count in `detail` —
		// the names are the report, so a test has to look where they are.
		const aggregate = fromsMatching(planned, /worktreeCleanup/);
		expect(aggregate).toHaveLength(1);
		expect(aggregate[0]).toContain("storageCleanup");
		expect(aggregate[0]).toContain("tailscale");
		expect(detailsMatching(planned, /this importer has no mapping for and no note about/)).toHaveLength(1);
		// A key with a mapper behind it is not in the aggregate, or the report would
		// claim it was dropped and shipped a green tick for it.
		expect(aggregate[0]).not.toContain("defaultRuntimeMode");
		expect(aggregate[0]).not.toContain("defaultModelSelection");
	});

	test("the two other settings files are named, and a missing one is named too", () => {
		// A settings file a user can see was silently not migrated is a worse
		// experience than one the report explains — and the reason is a fact about
		// T3 (they are client-surface preferences), not a shrug.
		const { home, stateDir } = t3Home({ defaultRuntimeMode: "approval-required" });
		writeFileSync(join(stateDir, "client-settings.json"), JSON.stringify({ chatWidth: 80, notifications: true }));
		const planned = plan(home);
		const client = fromsMatching(planned, /client-settings\.json/);
		expect(client).toEqual(["~/.t3/userdata/client-settings.json"]);
		const detail = detailsMatching(planned, /chatWidth/);
		expect(detail).toHaveLength(1);
		expect(detail[0]).toContain("notifications");

		// The file that is not there is named as not there, so "nothing to import"
		// and "not installed" are different sentences.
		expect(detailsMatching(planned, /not in the state directory/)).toHaveLength(1);
	});

	test("an empty other-settings file produces no line at all", () => {
		// "There is a `desktop-settings.json` holding nothing" is not information a
		// report needs, and a zero-key line reads as an error.
		const { home, stateDir } = t3Home({ defaultRuntimeMode: "approval-required" });
		writeFileSync(join(stateDir, "desktop-settings.json"), "{}");
		expect(fromsMatching(plan(home), /desktop-settings/)).toEqual([]);
	});

	test("settings.json that is not JSON is named as such, and nothing else is claimed", () => {
		// One malformed document must cost this importer its settings, not its
		// report — and the reason has to be the parse failure, because "nothing to
		// migrate" and "nothing to read" lead to opposite conclusions.
		const home = makeDir("lbb-t3-bad-");
		for (const name of TREE_ENV) setEnv(name, undefined);
		const stateDir = join(home, T3_DEFAULT_DIR, "userdata");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "settings.json"), "{ not json");
		const planned = plan(home);
		expect(detailsMatching(planned, /not valid JSON/)).toHaveLength(1);
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
	});

	test("a home with no T3 tree in it says so and claims nothing", () => {
		const home = makeDir("lbb-t3-empty-");
		for (const name of TREE_ENV) setEnv(name, undefined);
		const planned = plan(home);
		expect(itemsOf(planned)).toEqual([]);
	});

	test("an attachments directory is named, because transcripts will not carry it", () => {
		// An imported conversation carries its text and nothing else, so a message
		// naming a file leaves a path that resolves to nothing. Half of that
		// migration — copying the bytes and rewriting the references — is a
		// different one, and doing half of it would be worse than neither.
		const { home, stateDir } = t3Home({ defaultRuntimeMode: "approval-required" });
		mkdirSync(join(stateDir, "attachments"), { recursive: true });
		writeFileSync(join(stateDir, "attachments", "shot.png"), "not a real png");
		const detail = detailsMatching(plan(home), /imported transcripts carry their text only/);
		expect(detail).toHaveLength(1);
		expect(fromsMatching(plan(home), /^attachments$/)).toEqual(["attachments"]);
	});
});

// ---------------------------------------------------------------------------
// Reading is reading
// ---------------------------------------------------------------------------

describe("reading the tree", () => {
	test("nothing under the state directory is modified", () => {
		// The importer is a reader. A settings import that rewrites the document it
		// parsed is a write to a tool the user is still running, and `state.sqlite`
		// in particular is open by a live server with a `-wal` beside it.
		const { home, stateDir } = t3Home({ defaultRuntimeMode: "full-access" });
		mkdirSync(join(stateDir, "attachments"), { recursive: true });
		writeFileSync(join(stateDir, "attachments", "a.txt"), "x");
		const paths = ["settings.json", join("attachments", "a.txt")];
		const before = paths.map((path) =>
			createHash("sha256")
				.update(readFileSync(join(stateDir, path)))
				.digest("hex"),
		);
		plan(home);
		const after = paths.map((path) =>
			createHash("sha256")
				.update(readFileSync(join(stateDir, path)))
				.digest("hex"),
		);
		expect(after).toEqual(before);
	});

	test("an existing value at the target is kept, and --force is what changes that", () => {
		// Every source goes through the same claim helpers, so the rule is the
		// repo's rather than this one's — asserted here because T3 is the source
		// whose posture import is most consequential to overwrite. Note there is no
		// settings write at all in the kept case: the plan only writes a patch, so a
		// run that changes nothing writes nothing and leaves the file alone.
		const { home } = t3Home({ defaultRuntimeMode: "full-access" });
		const kept = plan(home, { permissionMode: "ask", sandbox: "workspace-write" });
		expect(kept.writes.find((write) => write.kind === "settings")).toBeUndefined();
		expect(detailsMatching(kept, /target already sets permissionMode to "ask"/)).toHaveLength(1);
		expect(detailsMatching(kept, /target already sets sandbox to "workspace-write"/)).toHaveLength(1);

		const forced = settingsWritten(plan(home, { permissionMode: "ask", sandbox: "workspace-write" }, true));
		expect(forced.permissionMode).toBe("agent");
		expect(forced.sandbox).toBe("danger-full-access");
	});
});
