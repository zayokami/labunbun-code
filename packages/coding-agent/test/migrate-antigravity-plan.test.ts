/**
 * Antigravity's planner: what `~/.gemini/config/config.json`, the MCP
 * documents, the skills, the workflows and the standing instructions become,
 * and what the report says about everything it did not carry.
 *
 * **The planner is called directly rather than through `planMigration`, and
 * that is what makes half of this file possible.** `claimScalar` arrives here
 * as a recorder, so "this importer claims nothing about the permission
 * posture" is an assertion about the calls the mapper made rather than about
 * the absence of a key in a settings patch somebody else assembled. It also
 * means nothing outside `~/.gemini` is ever consulted: `antigravity-home.ts`
 * resolves every path from its `home` argument and reads no environment
 * variable anywhere, so a fixture laid out under `os.tmpdir()` is the whole
 * world this file can see.
 *
 * The claims pinned below, and where each one lives:
 *
 *   - **The seven `AGENT_PERMISSION_PRESET_` names are echoed and nothing is
 *     mapped from them.** The binary enumerates all seven exactly once each and
 *     documents none of them; `planAntigravityPermissionPreset` therefore emits
 *     one `skip` naming the value and the enumeration, and the seven names never
 *     become a permission mode here or anywhere else.
 *   - **No sandbox is ever invented.** `UserSettings` has 44 attested `Get*`
 *     accessors and none of them is `GetSandboxMode`, so there is no second half
 *     to pair with the preset and `planAntigravity` is not even handed a
 *     `claimModePair`.
 *   - **The theme has three absences and they are all different.** A stated
 *     value is claimed, `INHERIT` is reported and claimed nothing, and a
 *     document with no `themeMode`, a document that could not be parsed, and a
 *     `themeMode` that is not a string each produce no line at all — the last
 *     three are pinned separately because `reportUnhandledKeys` is not what
 *     covers any of them.
 *   - **An MCP server has exactly two shapes** and no key the product's own
 *     documentation block does not attest; the rebuilt config is validated
 *     against `McpServerConfigSchema` and a refusal is a skip, not a write.
 *   - **An MCP `env` VALUE is copied into the target's own `.mcp.json` and
 *     never printed.** Only the names are inspected, by `looksLikeSecretName`.
 *     The secret assertions below are scoped to the report for that reason.
 *   - **The two `GEMINI.md` candidates are two rule files.** `planMemoryAsRule`
 *     guards against a file already on disk and nothing is on disk during
 *     planning, so two documents sharing a basename have to be told apart by
 *     name.
 *   - **A line is only ever about something that was seen.** Nothing in this
 *     planner reports `sidecar_data/`, the `antigravity-backup` root, or
 *     `~/.gemini/GEMINI.md`, because none of the three is something the reader
 *     can hand over — they are named in `antigravity-home.ts`'s comments, which
 *     is a different thing from being in the report.
 *
 * Fixtures hold fake values only. This file never opens a real Antigravity
 * install: `~/.gemini` exists only as a directory this file created under
 * `os.tmpdir()`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BUILT_IN_THEME_NAMES } from "@labunbun/tui";
import {
	ANTIGRAVITY_BACKUP_DATA_DIR,
	antigravityConfigDir,
	antigravityConfigPath,
	antigravityDataDirs,
	antigravityGlobalMcpConfigPath,
	antigravityMemoryPaths,
} from "../src/antigravity-home.ts";
import { planAntigravity } from "../src/antigravity-plan.ts";
import { type RawAntigravity, readAntigravity } from "../src/antigravity-read.ts";
import { tildePath } from "../src/migrate-core.ts";
import {
	type ClaimableScalarKey,
	type ClaimedScalarValue,
	type ClaimScalar,
	looksLikeSecretName,
	type MigrationItem,
	type MigrationSourceId,
	type PlannedWrite,
} from "../src/migrate-types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/**
 * Every variable any source's root function in this repo consults.
 *
 * **A guard, not a requirement, for this file.** Antigravity's own paths are
 * `join(homedir(), '.gemini', …)` with no environment variable in any of the
 * five expressions (`asar-out/dist/paths.js`), so nothing here could be
 * relocated even if these were left alone. It is cleared per fixture anyway so
 * that no home this file's helpers can reach is decided by the machine the
 * tests happen to run on — the same convention every other fixture in this
 * directory follows.
 */
const TREE_ENV = [
	"APPDATA",
	"CURSOR_CONFIG_DIR",
	"CURSOR_DATA_DIR",
	"CODEX_HOME",
	"DSH_HOME",
	"GROK_HOME",
	"KIMI_CODE_HOME",
	"KIMI_SHARE_DIR",
	"MAVIS_DATA_DIR",
	"MINIMAX_DATA_DIR",
	"OPENCODE_CONFIG_DIR",
	"OPENCODE_DB",
	"STEPCODE_CONFIG_DIR",
	"STEPCODE_STORAGE_ROOT_DIR",
	"STEP_CODING_AGENT_DIR",
	"STEP_CODING_AGENT_SESSION_DIR",
	"T3CODE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"ZCODE_DATA_BASE_DIR",
	"ZCODE_SESSION_DB",
	"ZCODE_SESSION_DB_PATH",
	"ZCODE_STORAGE_DIR",
];

/** A home with nothing in it at all — no `.gemini`, no `.labunbun`. */
function agHome(): string {
	for (const name of TREE_ENV) setEnv(name, undefined);
	const home = mkdtempSync(join(tmpdir(), "lbb-ag-plan-"));
	made.push(home);
	return home;
}

/**
 * Write `content` at a path relative to the home, spelled with forward slashes
 * whatever the platform — the same convention `migrate-antigravity.test.ts`
 * uses for a data root.
 */
function writeAt(home: string, relative: string, content: string): void {
	const path = join(home, ...relative.split("/"));
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

/**
 * The home-relative, forward-slashed spelling of a path one of
 * `antigravity-home.ts`'s own functions returned.
 *
 * The alternative is writing `".gemini/config/memory.txt"` here, which would
 * test a literal that could agree with the function and the fixture at once.
 */
function underHome(home: string, path: string): string {
	return path.slice(home.length + 1).replace(/\\/g, "/");
}

/** Write `config/config.json`; a string is written verbatim, so it can be malformed. */
function writeConfig(home: string, config: unknown): void {
	writeAt(
		home,
		underHome(home, antigravityConfigPath(home)),
		typeof config === "string" ? config : JSON.stringify(config),
	);
}

/** Write the documented global `mcp_config.json`. */
function writeMcp(home: string, document: unknown): void {
	writeAt(home, underHome(home, antigravityGlobalMcpConfigPath(home)), JSON.stringify(document));
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** One `claimScalar` call, kept whole so a test can say what was asked for. */
interface ScalarClaim {
	source: MigrationSourceId;
	key: ClaimableScalarKey;
	value: ClaimedScalarValue;
	from: string;
}

/** Everything one `planAntigravity` call produced, in the shapes a test asserts on. */
interface Planned {
	items: MigrationItem[];
	writes: PlannedWrite[];
	/** Every `claimScalar` call, in order. Empty means the importer claimed nothing. */
	claims: ScalarClaim[];
	/** What those claims would write into `settings.json`. */
	settings: Record<string, unknown>;
	/** The servers the plan would add to `~/.labunbun/.mcp.json`. */
	mcpServers: Record<string, unknown>;
	/** Whether any written server's `env` held a name that looks like a credential. */
	mcpHasSecret: boolean;
}

/**
 * Read `home` and plan it, recording the scalar claims rather than resolving
 * them.
 *
 * `claimScalar` here is `migrate.ts`'s without the two branches no test here
 * needs — the "target already sets this key" skip and the supersede rewrite —
 * because every fixture starts with an empty target. What it keeps is the part
 * the claims depend on: the key is written, a `map` line carrying the mapper's
 * own `detail` is emitted, and the call is recorded, so "a preset produced a
 * `claimScalar` call" is observable rather than inferred from an absent key.
 */
function plan(home: string, existingMcpServers: Record<string, unknown> = {}, force = false): Planned {
	const raw = readAntigravity(home);
	return planRaw(raw, existingMcpServers, force);
}

/** {@link plan} over a reader result the test kept, so it can assert on both halves. */
function planRaw(raw: RawAntigravity, existingMcpServers: Record<string, unknown> = {}, force = false): Planned {
	const items: MigrationItem[] = [];
	const writes: PlannedWrite[] = [];
	const claims: ScalarClaim[] = [];
	const settings: Record<string, unknown> = {};
	const mcpServers: Record<string, unknown> = {};
	let mcpHasSecret = false;

	const claimScalar: ClaimScalar = (source, key, value, from, detail) => {
		claims.push({ source, key, value, from });
		settings[key] = value;
		items.push({ source, from, to: `settings.json → ${key}`, action: "map", detail, containsSecret: false });
	};

	planAntigravity(
		raw,
		raw.home,
		items,
		writes,
		claimScalar,
		mcpServers,
		(hasSecret) => {
			mcpHasSecret = mcpHasSecret || hasSecret;
		},
		existingMcpServers,
		force,
	);
	return { items, writes, claims, settings, mcpServers, mcpHasSecret };
}

function itemsOf(planned: Planned): MigrationItem[] {
	return planned.items.filter((item) => item.source === "antigravity");
}

/** The single item whose `to` is exactly this, so a claim can be read whole. */
function itemTo(planned: Planned, to: string): MigrationItem | undefined {
	return itemsOf(planned).find((item) => item.to === to);
}

/** The `from` labels matching — for the lines whose subject is named there. */
function fromsMatching(planned: Planned, pattern: RegExp): string[] {
	return itemsOf(planned)
		.filter((item) => pattern.test(item.from))
		.map((item) => item.from);
}

/** The item details matching, so a test can name one line of the report. */
function detailsMatching(planned: Planned, pattern: RegExp): string[] {
	return itemsOf(planned)
		.filter((item) => pattern.test(item.detail))
		.map((item) => item.detail);
}

/**
 * Everything the report would say, as one string.
 *
 * Used for the absences, where the claim is that a string appears nowhere —
 * `from`, `to` and `detail` together, because a name in any of the three is a
 * name in the report.
 */
function reportText(planned: Planned): string {
	return itemsOf(planned)
		.map((item) => `${item.from}\n${item.to}\n${item.detail}`)
		.join("\n");
}

/** The one item about `subject`, or `undefined` — for the "no line at all" claims. */
function lineAbout(planned: Planned, subject: string): MigrationItem | undefined {
	return itemsOf(planned).find((item) => item.from.includes(subject));
}

// ---------------------------------------------------------------------------
// The permission posture
// ---------------------------------------------------------------------------

describe("the permission posture", () => {
	test("the seven preset names are echoed by name, and none of them is mapped", () => {
		// The production line that would have to be wrong: the single
		// `items.push({ … action: "skip" … })` in `planAntigravityPermissionPreset`.
		// A `claimModePair`, a `claimScalar`, a `map`, or an action other than
		// `skip` all turn one of the last four lines red; the enumeration in the
		// detail is the part a user reads to learn what was declined.
		const home = agHome();
		writeConfig(home, { userSettings: { permissionPreset: "AGENT_PERMISSION_PRESET_TURBO" } });

		const planned = plan(home);
		const line = lineAbout(planned, "userSettings.permissionPreset");
		expect(line?.action).toBe("skip");
		expect(line?.to).toBe("—");
		expect(line?.from).toBe(
			`${tildePath(home, antigravityConfigPath(home))} → userSettings.permissionPreset (AGENT_PERMISSION_PRESET_TURBO)`,
		);

		// The whole enumeration is in the sentence, so a user who set `TURBO` can
		// see that the other six exist and that none of the seven was read. The
		// members are parsed out of the detail rather than listed here, so this
		// cannot be satisfied by a detail that merely mentions one name. The
		// prefix is written once in front of the brace list, so what is inside it
		// is the seven suffixes and nothing else.
		const enumerated = line?.detail.match(/AGENT_PERMISSION_PRESET_\{([^}]*)\}/);
		expect(enumerated).not.toBeNull();
		const members = (enumerated?.[1] ?? "").split(",").map((member) => member.trim());
		expect(members).toHaveLength(7);
		expect(members.every((member) => /^[A-Z_]+$/.test(member))).toBe(true);
		// The value echoed in `from` is one of them, which is what makes the
		// sentence a statement about the user's own setting rather than a list.
		expect(members).toContain("AGENT_PERMISSION_PRESET_TURBO".replace("AGENT_PERMISSION_PRESET_", ""));
		expect(new Set(members).size).toBe(7);

		// The half the enumeration exists to justify: nothing was claimed.
		expect(planned.claims).toEqual([]);
		expect(planned.settings.permissionMode).toBeUndefined();
		expect(planned.settings.sandbox).toBeUndefined();
		expect(itemsOf(planned).every((item) => item.action === "skip")).toBe(true);
	});

	test("a config that names no sandbox key produces no sandbox line and no sandbox claim", () => {
		// The production line that would have to be wrong: `planAntigravity`'s own
		// parameter list — it is not handed a `claimModePair`, and neither
		// `planAntigravityPermissionPreset` nor `planAntigravityTheme` calls one.
		// Threading one in, or inventing a sandbox default in either, puts the word
		// "sandbox" into the report or a `sandbox` key into `claims`.
		//
		// Deliberately the strongest form of the claim: `/sandbox/i` over the whole
		// report, so a line that merely *discusses* a sandbox fails too. The five
		// keys beside the preset (`enableTerminalSandbox`, `sandboxAllowNetwork`,
		// …) are named by `reportUnhandledKeys` when a config carries them — which
		// is a different test, and is not what this one is about.
		const home = agHome();
		writeConfig(home, { userSettings: { permissionPreset: "AGENT_PERMISSION_PRESET_DEFAULT", themeMode: "dark" } });

		const planned = plan(home);
		expect(reportText(planned)).not.toMatch(/sandbox/i);
		expect(planned.claims.map((claim) => claim.key)).toEqual(["theme"]);
		expect(itemsOf(planned).some((item) => item.to === "settings.json → sandbox")).toBe(false);
		expect(itemsOf(planned).some((item) => item.to === "settings.json → permissionMode")).toBe(false);

		// The control, so the negative above is the fixture's doing and not a
		// matcher that cannot fail: a config naming one of the sandbox-family keys
		// puts the word into the report, because `reportUnhandledKeys` names keys
		// it has no mapping for. That line asserts nothing about what the key does,
		// which is exactly why the two cases are separate tests.
		const named = agHome();
		writeConfig(named, { userSettings: { enableTerminalSandbox: true, themeMode: "dark" } });
		expect(reportText(plan(named))).toMatch(/sandbox/i);
	});
});

// ---------------------------------------------------------------------------
// The theme
// ---------------------------------------------------------------------------

describe("the theme", () => {
	test("a stated light is claimed as light and a stated dark as dark", () => {
		// The production line that would have to be wrong:
		// `const mapped = theme.light ? "light" : "dark"` followed by the
		// `claimScalar(SOURCE, "theme", mapped, …)`. If the mapping inverted, or
		// named a theme this build does not carry, one of the four assertions here
		// goes red.
		for (const [stated, claimed] of [
			["LIGHT", "light"],
			["DARK", "dark"],
		]) {
			const home = agHome();
			// The reader's own spelling: `themeMode.includes("LIGHT")`, so the
			// value has to carry the upper-case form the app tests for.
			writeConfig(home, { userSettings: { themeMode: stated } });

			const planned = plan(home);
			expect(planned.settings.theme).toBe(claimed);
			const line = itemTo(planned, "settings.json → theme");
			expect(line?.from).toBe(`${tildePath(home, antigravityConfigPath(home))} → userSettings.themeMode (${stated})`);
			expect(line?.detail).toContain(`built-in theme "${claimed}"`);
		}
		// The claim is that the name is the same on both sides, so the two names
		// have to be in this build's list rather than in the source's.
		expect(BUILT_IN_THEME_NAMES as readonly string[]).toContain("light");
		expect(BUILT_IN_THEME_NAMES as readonly string[]).toContain("dark");
	});

	test("INHERIT is a line and not a theme", () => {
		// The production line that would have to be wrong: the
		// `if (theme.inheritsOsTheme) { … return; }` branch at the top of
		// `planAntigravityTheme`. `nativeTheme.shouldUseDarkColors` is a property
		// of the machine Antigravity ran on, so resolving it here resolves it
		// against whichever machine runs the import — and a `return` that fell
		// through would claim the theme the file did not state.
		const home = agHome();
		writeConfig(home, { userSettings: { themeMode: "INHERIT" } });

		const planned = plan(home);
		const line = lineAbout(planned, "userSettings.themeMode");
		expect(line?.action).toBe("skip");
		expect(line?.detail).toContain("INHERIT");
		expect(line?.detail).toContain("operating system");
		expect(planned.claims).toEqual([]);
		expect(planned.settings.theme).toBeUndefined();
	});

	test("a document that names no themeMode has no theme line at all", () => {
		// The production line that would have to be wrong: the
		// `if (theme.declared === null) return;` guard. Without it the `from`
		// string above it — which is built with `(not stated)` — would be pushed
		// and a user who never chose a theme would be told Antigravity had one.
		const home = agHome();
		writeConfig(home, { userSettings: {} });

		const planned = plan(home);
		expect(reportText(planned)).not.toContain("themeMode");
		expect(reportText(planned)).not.toContain("not stated");
		expect(planned.claims).toEqual([]);
	});

	test("a document that could not be parsed has no theme line, and says why it has none", () => {
		// The production line that would have to be wrong: the same guard, reached
		// the other way. `raw.config` is `null` for an unusable file, so the theme
		// is `declared: null` — and the *reason* has to arrive from somewhere, or
		// "no theme line" and "nothing was read" are the same report. The
		// `for (const entry of raw.skipped)` loop in `planAntigravityLeftovers` is
		// what supplies it; drop that and the last assertion here goes red.
		const home = agHome();
		writeConfig(home, "{ not json");

		const planned = plan(home);
		expect(reportText(planned)).not.toContain("themeMode");
		expect(planned.claims).toEqual([]);
		expect(detailsMatching(planned, /not parseable as JSON/)).toHaveLength(1);
	});

	test("a themeMode that is not a string has no theme line either", () => {
		// The production line that would have to be wrong: `antigravityTheme`'s
		// `typeof mode === "string" ? mode : null`, and then the same
		// `declared === null` guard. The app throws a `TypeError` from
		// `(1).includes` and its `catch` returns `DARK`, so this value *is* a dark
		// theme to Antigravity — importing that fall-through would write a
		// preference nobody picked, and skipping the line entirely would hide a
		// key the user can see. `themeMode` is in
		// `ANTIGRAVITY_USER_SETTINGS_HANDLED`, so `reportUnhandledKeys` does not
		// cover for it: the key is named nowhere.
		const home = agHome();
		writeConfig(home, { userSettings: { themeMode: 1 } });

		const planned = plan(home);
		expect(reportText(planned)).not.toContain("themeMode");
		expect(planned.claims).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The MCP servers
// ---------------------------------------------------------------------------

describe("the MCP servers", () => {
	test("a command is rebuilt as a stdio server carrying nothing but the four documented keys", () => {
		// The production line that would have to be wrong: the
		// `config.type = "stdio" / config.command / config.args` arm of
		// `planAntigravityMcp`. The exact key set is the claim — the product's
		// documentation block for a server names `command`, `args`, `env` and
		// `serverUrl` and nothing else, so a `cwd`, a `headers` or a fifth
		// discriminator would be a key copied from some other tool's shape.
		const home = agHome();
		writeMcp(home, { mcpServers: { alpha: { command: "node", args: ["server.js"], env: { PORT: "8080" } } } });

		const planned = plan(home);
		expect(planned.mcpServers.alpha).toEqual({
			type: "stdio",
			command: "node",
			args: ["server.js"],
			env: { PORT: "8080" },
		});
		expect(Object.keys(planned.mcpServers.alpha as Record<string, unknown>).sort()).toEqual([
			"args",
			"command",
			"env",
			"type",
		]);

		const line = lineAbout(planned, "mcpServers.alpha");
		expect(line?.action).toBe("map");
		expect(line?.to).toContain(".mcp.json");
		expect(line?.to).toContain("mcpServers.alpha");
		// The file the server came from is named, so "this server was imported"
		// and "this server was imported from the file the product documents" stay
		// distinguishable.
		expect(line?.from).toBe(`${tildePath(home, antigravityGlobalMcpConfigPath(home))} → mcpServers.alpha`);
	});

	test("a serverUrl with no command is rebuilt as an http server, also with two keys", () => {
		// The production line that would have to be wrong: the `else` arm's
		// `config.type = "http" / config.url = serverUrl`. If it kept `args` or
		// wrote a `headers` block from an entry that has none, the key set below
		// is where it shows.
		const home = agHome();
		const url = "https://mcp.example.invalid/v1";
		writeMcp(home, { mcpServers: { remote: { serverUrl: url } } });

		const planned = plan(home);
		expect(planned.mcpServers.remote).toEqual({ type: "http", url });
		expect(Object.keys(planned.mcpServers.remote as Record<string, unknown>).sort()).toEqual(["type", "url"]);
	});

	test("a server naming neither transport is skipped, not written empty", () => {
		// The production line that would have to be wrong: the
		// `if (command === "" && serverUrl === "") { … continue; }` guard. Drop it
		// and the entry falls through into the `else` arm as an http server whose
		// `url` is the empty string, which `McpServerConfigSchema` then refuses —
		// so the server still would not be written, but the sentence about it would
		// blame a malformed `serverUrl` the file never contained. The guard is what
		// makes the report name the state that is actually there.
		const home = agHome();
		writeMcp(home, { mcpServers: { broken: { args: ["--verbose"] } } });

		const planned = plan(home);
		expect(planned.mcpServers.broken).toBeUndefined();
		const line = lineAbout(planned, "mcpServers.broken");
		expect(line?.action).toBe("skip");
		expect(line?.detail).toContain("neither a command nor a serverUrl");
	});

	test("a server this build's schema refuses is skipped and counted, not written", () => {
		// The production line that would have to be wrong: the
		// `!McpServerConfigSchema.safeParse(config).success` guard and its
		// `continue`. Two refusals must be two lines — one per entry, because one
		// aggregate would leave a user with two broken servers and one sentence —
		// and neither may reach the written document.
		const home = agHome();
		writeMcp(home, {
			mcpServers: { one: { serverUrl: "not-an-address" }, two: { serverUrl: "also not an address" } },
		});

		const planned = plan(home);
		expect(planned.mcpServers).toEqual({});
		expect(detailsMatching(planned, /is not an address this build's MCP client accepts/)).toHaveLength(2);
		expect(itemsOf(planned).some((item) => item.to !== "—" && item.from.includes("mcpServers."))).toBe(false);
	});

	test("a credential-shaped env name is flagged, and no env value reaches the report", () => {
		// The production lines that would have to be wrong: the
		// `looksLikeSecretName` sweep over `Object.keys(config.env)` and the two
		// `detail` strings built from the NAMES. A count, a name or a whole env
		// block interpolated into a detail would put the value in the report, and
		// the report is the one artefact that reaches a transcript, a screen and a
		// bug report.
		//
		// **Scoped to `items` on purpose.** The value *is* written verbatim into
		// `~/.labunbun/.mcp.json`, which is where the user's own servers already
		// keep their credentials — copying it there is the migration's job. What is
		// asserted here is that the value is never *printed*, and that the file is
		// marked as holding a secret by the `markMcpSecret` hook.
		const value = "sk-not-a-real-antigravity-key-0123456789";
		const home = agHome();
		writeMcp(home, { mcpServers: { creds: { command: "node", env: { API_KEY: value, HOME: "/tmp" } } } });

		// The marker is `looksLikeSecretName`'s own, asked rather than assumed.
		expect(looksLikeSecretName("API_KEY")).toBe(true);
		expect(looksLikeSecretName("HOME")).toBe(false);

		const planned = plan(home);
		const line = lineAbout(planned, "mcpServers.creds");
		expect(line?.containsSecret).toBe(true);
		expect(line?.detail).toContain("only the variable names were read");
		expect(planned.mcpHasSecret).toBe(true);

		expect(JSON.stringify(itemsOf(planned))).not.toContain(value);
		for (const item of itemsOf(planned)) expect(item.detail).not.toContain(value);
		expect(reportText(planned)).not.toContain(value);
	});

	test("a serverUrl carrying a credential is not carried across, and a clean one still is", () => {
		// `serverUrl` is the only field here that says which host to talk to, so a
		// credential inside it is the credential — and no name-based scan reaches
		// it, because it is not under a secret-shaped key. `env` can be dropped whole
		// and leave a working server; a URL cannot, since the same address with its
		// userinfo or its `?access_token=` stripped points at nothing. So the server is
		// left off rather than written under a line saying nothing in it is a secret.
		const userinfoPassword = "sk-url-pass-VALUE";
		const queryToken = "sk-url-token-VALUE";
		const home = agHome();
		writeMcp(home, {
			mcpServers: {
				withUserinfo: { serverUrl: `https://alice:${userinfoPassword}@mcp.example.invalid/sse` },
				withQuery: { serverUrl: `https://mcp.example.invalid/mcp?access_token=${queryToken}` },
				clean: { serverUrl: "https://mcp.example.invalid/mcp" },
			},
		});

		const planned = plan(home);
		const text = reportText(planned);
		expect(text).not.toContain(userinfoPassword);
		expect(text).not.toContain(queryToken);

		// Per-entry, not a gate on the whole file: one credential must not cost the
		// user the servers beside it.
		expect(planned.mcpServers.clean).toEqual({ type: "http", url: "https://mcp.example.invalid/mcp" });
		expect(planned.mcpServers.withUserinfo).toBeUndefined();
		expect(planned.mcpServers.withQuery).toBeUndefined();

		for (const name of ["withUserinfo", "withQuery"]) {
			const skipped = lineAbout(planned, `mcpServers.${name}`);
			expect(skipped?.action).toBe("skip");
			expect(skipped?.to).toBe("—");
			// Nothing was written for these and no file is marked for it — but the
			// value this line is about *was* a credential, and a reader filtering items
			// for one should not have to read the detail to find that out.
			expect(skipped?.containsSecret).toBe(true);
		}
		// The reason names the shape, and prints neither the value nor the address.
		expect(lineAbout(planned, "mcpServers.withUserinfo")?.detail).toContain("name:password@");
		expect(lineAbout(planned, "mcpServers.withQuery")?.detail).toContain("parameter names is a credential word");
	});

	test("a non-string environment entry loses the variable, not the server", () => {
		// The production line that would have to be wrong: the
		// `if (typeof value === "string") env[key] = value;` filter. Losing the
		// whole server because one variable was written as a number would be a
		// worse outcome than losing the variable, and the count is the only way a
		// user learns that something they wrote did not come across.
		const home = agHome();
		writeMcp(home, { mcpServers: { portly: { command: "node", args: ["s.js"], env: { PORT: 8080, HOME: "/tmp" } } } });

		const planned = plan(home);
		const server = planned.mcpServers.portly as { command: string; env: Record<string, string> };
		expect(server.command).toBe("node");
		expect(server.env).toEqual({ HOME: "/tmp" });

		const line = lineAbout(planned, "mcpServers.portly");
		expect(line?.action).toBe("downgrade");
		expect(line?.detail).toContain("1 environment variable(s) whose value was not a string, dropped");
	});

	test("a non-string argument is dropped the same way", () => {
		// The production line that would have to be wrong: the
		// `args.filter((arg): arg is string => typeof arg === "string")` and the
		// length comparison behind its downgrade note. The surviving argv is
		// asserted too, because dropping a non-string is only safe if the string
		// entries around it keep their positions relative to each other.
		const home = agHome();
		writeMcp(home, {
			mcpServers: { argy: { command: "node", args: ["--port", 8080, "--host", null, "--verbose"] } },
		});

		const planned = plan(home);
		expect((planned.mcpServers.argy as { args: string[] }).args).toEqual(["--port", "--host", "--verbose"]);

		const line = lineAbout(planned, "mcpServers.argy");
		expect(line?.action).toBe("downgrade");
		expect(line?.detail).toContain("2 argument(s) that were not strings, dropped");
	});
});

// ---------------------------------------------------------------------------
// The assets
// ---------------------------------------------------------------------------

describe("the assets", () => {
	test("a skill and a workflow from either tree all land in the same skill path", () => {
		// The production line that would have to be wrong: the single
		// `collectFileWrites(SOURCE, raw.assets, (name) => join(home, ".labunbun",
		// "skills", name, "SKILL.md"), …)` call in `planAntigravityAssets`. It is
		// handed every asset, skills and both workflow trees together, so a
		// separate destination for either tree would mean a second call — and the
		// destination asserted here is the one Antigravity's own
		// `migrate-workflows` skill converts to.
		const home = agHome();
		writeAt(home, ".gemini/config/skills/reviewer/SKILL.md", "a skill");
		writeAt(home, ".gemini/config/workflows/deploy.md", "a workflow");
		writeAt(home, ".gemini/config/global_workflows/audit.md", "a workflow");

		const planned = plan(home);
		const skills = planned.writes.filter((write) => write.kind === "skill");
		expect(skills.map((write) => write.path).sort()).toEqual(
			["audit", "deploy", "reviewer"].map((name) => join(home, ".labunbun", "skills", name, "SKILL.md")).sort(),
		);
		for (const name of ["reviewer", "deploy", "audit"]) {
			expect(itemTo(planned, `~/.labunbun/skills/${name}/SKILL.md`)?.action).toBe("map");
		}
		// The two workflows earn one line saying the frontmatter was *not*
		// rewritten, which is the vendor's half of the conversion this importer
		// cannot cite.
		expect(detailsMatching(planned, /2 workflow markdown\(s\)/)).toHaveLength(1);
		expect(detailsMatching(planned, /check that the file has a name and a/)).toHaveLength(1);
	});

	test("each standing-instructions document becomes its own rule file", () => {
		// The production line that would have to be wrong: the
		// `for (const document of raw.memory) { … planMemoryAsRule(…) }` loop. Four
		// candidates can all exist, and one rule file per document is what keeps
		// two of them from overwriting each other.
		const home = agHome();
		const candidates = antigravityMemoryPaths(home);
		// The two candidates whose basenames differ, so nothing here depends on the
		// disambiguation rule — that is the next test.
		writeAt(home, underHome(home, candidates[2]), "agent rules");
		writeAt(home, underHome(home, candidates[3]), "machine-local memory");

		const planned = plan(home);
		const rules = planned.writes.filter((write) => write.kind === "rule");
		expect(rules).toHaveLength(2);
		expect(new Set(rules.map((write) => write.path)).size).toBe(2);
		for (const write of rules) {
			expect(write.path.startsWith(join(home, ".labunbun", "rules"))).toBe(true);
			expect(write.path.endsWith(".md")).toBe(true);
		}
		// And each is claimed at its own path — one line each, `map`, no skip.
		const claimed = itemsOf(planned).filter(
			(item) => item.action === "map" && item.to.startsWith("~/.labunbun/rules/"),
		);
		expect(claimed).toHaveLength(2);
		expect(claimed.map((item) => item.to).sort()).toEqual(rules.map((write) => tildePath(home, write.path)).sort());
	});

	test("the two GEMINI.md candidates are two rule files, not one written twice", () => {
		// The production line that would have to be wrong: `antigravityRuleName`'s
		// disambiguating branch, reached because `planAntigravityAssets` counted
		// two documents sharing the stem `gemini`. `planMemoryAsRule` guards only
		// against a file already *on disk*, and during planning nothing is — so
		// without the fold both documents queue the same write, both report `map`,
		// and the write step leaves whichever came last while the report claims
		// both arrived.
		const home = agHome();
		const candidates = antigravityMemoryPaths(home);
		expect(candidates).toHaveLength(4);
		const shared = candidates.filter((path) => basename(path) === "GEMINI.md");
		expect(shared).toHaveLength(2);
		for (const path of shared) writeAt(home, underHome(home, path), "standing instructions");

		const planned = plan(home);
		const rules = planned.writes.filter((write) => write.kind === "rule");
		expect(rules).toHaveLength(2);
		expect(new Set(rules.map((write) => write.path)).size).toBe(2);

		// The two names differ because one of them carries the directory it was
		// found in — `antigravityConfigDir`'s own basename, so this is not a
		// literal typed here.
		const names = rules.map((write) => basename(write.path));
		const configSegment = basename(antigravityConfigDir(home));
		expect(names.filter((name) => name.includes(configSegment))).toHaveLength(1);
		expect(names.filter((name) => !name.includes(configSegment))).toHaveLength(1);

		// And the report does not claim two things arrived at one path.
		const claimed = itemsOf(planned).filter(
			(item) => item.action === "map" && item.to.startsWith("~/.labunbun/rules/"),
		);
		expect(claimed).toHaveLength(2);
		expect(new Set(claimed.map((item) => item.to)).size).toBe(2);
		expect(claimed.map((item) => item.to).sort()).toEqual(rules.map((write) => tildePath(home, write.path)).sort());

		// The fold is *conditional*, and this is the half that says so: with only
		// one `GEMINI.md` present the stem is unambiguous and the short, readable
		// name is kept. A fold applied unconditionally would pass the two assertions
		// above and make every rule file in every home carry its directory. The
		// second home's own candidates are re-read rather than reusing the first's
		// paths, which would happen to work only while both temp directories are the
		// same length.
		const alone = agHome();
		const soloCandidates = antigravityMemoryPaths(alone);
		writeAt(alone, underHome(alone, soloCandidates[1]), "standing instructions");
		const solo = planRaw(readAntigravity(alone));
		const soloRules = solo.writes.filter((write) => write.kind === "rule");
		expect(soloRules).toHaveLength(1);
		expect(basename(soloRules[0].path)).not.toContain(basename(antigravityConfigDir(alone)));
	});

	test("a name the target already has gets a line, and only --force overwrites it", () => {
		// The production lines that would have to be wrong: `collectFileWrites`'
		// `if (existsSync(path) && !force)` branch, and `planAntigravityMcp`'s
		// `if (name in existingMcpServers && !force)`. Both are the repo's rule
		// rather than this file's — asserted here because a skill and an MCP server
		// are the two things a user is most likely to have written by hand under
		// their own name, and "the migration silently replaced my server" is not a
		// sentence any of these branches is willing to produce.
		const home = agHome();
		writeAt(home, ".gemini/config/skills/reviewer/SKILL.md", "from antigravity");
		writeAt(home, ".labunbun/skills/reviewer/SKILL.md", "already mine");

		const kept = plan(home);
		expect(kept.writes.filter((write) => write.kind === "skill")).toEqual([]);
		const line = lineAbout(kept, "reviewer");
		expect(line?.action).toBe("skip");
		expect(line?.detail).toContain("target skill already exists");
		expect(line?.detail).toContain("--force");

		const forced = plan(home, {}, true);
		expect(forced.writes.filter((write) => write.kind === "skill")).toHaveLength(1);
		expect(itemTo(forced, "~/.labunbun/skills/reviewer/SKILL.md")?.action).toBe("map");

		// The MCP half, where the target's servers arrive as the map
		// `planMigration` hands this planner rather than as files on disk.
		const servers = agHome();
		writeMcp(servers, { mcpServers: { sqlite: { command: "sqlite-mcp" } } });
		const mine = { sqlite: { type: "stdio", command: "my-own-sqlite-mcp" } };
		const keptServer = plan(servers, mine);
		expect(keptServer.mcpServers.sqlite).toBeUndefined();
		const serverLine = lineAbout(keptServer, "mcpServers.sqlite");
		expect(serverLine?.action).toBe("skip");
		expect(serverLine?.detail).toContain("target already defines a server with this name");

		const forcedServer = plan(servers, mine, true);
		expect(forcedServer.mcpServers.sqlite).toEqual({ type: "stdio", command: "sqlite-mcp", args: [] });
	});

	test("two data roots is a line, and only the one that answered is called read", () => {
		// The production line that would have to be wrong: the
		// `const others = roots.filter((root) => root !== here)` branch of
		// `planAntigravityLeftovers`. Both roots are always named on
		// {@link RawAntigravity.dataDirs}, so the report's job is to say which one
		// was read — "there is a second copy of your data directory and it was not
		// read" is a fact a user deciding whether this migration finished is owed,
		// and it is only owed because the reader chose rather than guessed.
		const home = agHome();
		// Content in *both* roots, so the first one wins and the second is the one
		// that was not read.
		for (const dir of antigravityDataDirs(home)) writeAt(home, underHome(home, join(dir, "marker.txt")), "");

		const raw = readAntigravity(home);
		expect(raw.dataDir).toBe(antigravityDataDirs(home)[0]);

		const planned = planRaw(raw);
		expect(detailsMatching(planned, /the other spelling of the data directory, not read/)).toHaveLength(1);
		// The one that was *not* read is named, exactly once and by its own path —
		// derived from `antigravityDataDirs`, so a rename of either constant moves
		// this with it. The conversations line names the other root, which is the
		// half that says which of the two was chosen.
		expect(itemsOf(planned).filter((item) => item.from === tildePath(home, antigravityDataDirs(home)[1]))).toHaveLength(
			1,
		);
		const counted = itemsOf(planned).find((item) => item.detail.includes("conversation(s), each named and measured"));
		expect(counted?.from).toContain(tildePath(home, antigravityDataDirs(home)[0]));
	});
});

// ---------------------------------------------------------------------------
// What the report has to account for
// ---------------------------------------------------------------------------

describe("what the report accounts for", () => {
	test("every entry the reader passed over is replayed, name and reason alike", () => {
		// The production line that would have to be wrong: the
		// `for (const entry of raw.skipped) items.push({ from: entry.name, …,
		// detail: entry.reason })` loop at the end of `planAntigravityLeftovers`.
		// The reader's convention is that a name carries the reason next to it
		// (antigravity-read.ts), so a paraphrase here is a second vocabulary for
		// the same fact — which is why this asserts equality rather than a
		// substring.
		const home = agHome();
		// Six different reasons, so the loop is not accidentally passing on one
		// shape of entry: a skill directory with no SKILL.md, a file in the skills
		// root, an already-converted workflow archive, a README, a named-only path
		// that exists, and a conversation with no transcript.
		writeAt(home, ".gemini/config/skills/empty-skill/notes.txt", "x");
		writeAt(home, ".gemini/config/skills/loose.md", "x");
		writeAt(home, ".gemini/config/workflows/done.md.bak", "x");
		writeAt(home, ".gemini/config/workflows/README.md", "x");
		writeAt(home, ".gemini/config/plugins/one/plugin.json", "{}");
		writeAt(home, ".gemini/antigravity-ide/brain/conv-a/notes.txt", "x");

		const raw = readAntigravity(home);
		expect(raw.skipped.length).toBeGreaterThanOrEqual(6);
		const planned = planRaw(raw);
		for (const entry of raw.skipped) {
			const line = itemsOf(planned).find((item) => item.from === entry.name);
			expect(line).toBeDefined();
			expect(line?.detail).toBe(entry.reason);
			expect(line?.action).toBe("skip");
			expect(line?.to).toBe("—");
		}
	});

	test("a home with nothing in it names nothing that was not there", () => {
		// The production lines that would have to be wrong: every `items.push` in
		// `planAntigravityLeftovers` and `planAntigravityAssets`. Each of the three
		// names below is something a *comment* in `antigravity-home.ts` mentions and
		// the reader can never hand over — `sidecar_data/` is attested as living
		// inside a data root but is not scanned, the backup root is a third copy
		// deliberately not in `antigravityDataDirs`, and `~/.gemini/GEMINI.md` is
		// the one candidate with no attestation behind it. A planner that reported
		// any of them would be telling every user about three paths their install
		// may not have.
		//
		// The last assertion is the control: without it, three absences would also
		// be what a planner that crashed produces.
		const home = agHome();
		const planned = plan(home);
		const report = reportText(planned);

		for (const name of [
			"sidecar_data",
			ANTIGRAVITY_BACKUP_DATA_DIR,
			tildePath(home, antigravityMemoryPaths(home)[0]),
		]) {
			expect(report).not.toContain(name);
		}
		// The one line an empty home does earn, and it is about a fact the reader
		// established: both data roots were looked at and neither held anything.
		expect(detailsMatching(planned, /neither data root held anything/)).toHaveLength(1);
		expect(fromsMatching(planned, /antigravity-ide/)).toHaveLength(1);

		// The second control, for the one of the three that *can* be named. Put a
		// directory where `~/.gemini/GEMINI.md` should be and the reader records it
		// in `skipped`, so the planner replays that name into the report — which is
		// what "a skip is a thing that was actually seen" means. The absence above
		// and the line here are the same code path with and without an observation,
		// so neither can be satisfied by accident.
		const seen = agHome();
		writeAt(seen, ".gemini/GEMINI.md/some-file.txt", "x");
		const seenReport = reportText(plan(seen));
		expect(seenReport).toContain(tildePath(seen, antigravityMemoryPaths(seen)[0]));
		expect(detailsMatching(plan(seen), /a directory where a file was expected/)).toHaveLength(1);
	});

	test("keys this mapper does not know are named, at both levels of the document", () => {
		// The production lines that would have to be wrong: the two
		// `reportUnhandledKeys` calls in `planAntigravityConfigKeys`, and the two
		// handled-key sets beside them. The names are the report — the values are
		// the user's own and are never printed — so the assertion looks at `from`.
		// A key that has a mapper behind it must not appear in either aggregate, or
		// the report would claim it was dropped and ship a green tick for it.
		//
		// `conversationWidth` rather than something ending in "Key": the reader
		// scrubs credential-shaped key names out of `config.json` before the
		// planner sees the document, so a name like that would be deleted and
		// named in `skipped` instead of here.
		const home = agHome();
		writeConfig(home, {
			conversationWidth: 800,
			userSettings: { themeMode: "dark", gcpRegion: "us-central1", allowedCommands: [] },
		});

		const planned = plan(home);
		const top = fromsMatching(planned, /conversationWidth/);
		expect(top).toHaveLength(1);
		expect(top[0]).not.toContain("userSettings");
		expect(detailsMatching(planned, /1 key\(s\) this importer has no mapping for/)).toHaveLength(1);

		const settings = fromsMatching(planned, /gcpRegion/);
		expect(settings).toHaveLength(1);
		expect(settings[0]).toContain("allowedCommands");
		expect(settings[0]).not.toContain("themeMode");
		expect(detailsMatching(planned, /2 key\(s\) this importer has no mapping for/)).toHaveLength(1);

		// The mapped one was still mapped: the aggregate is an addition to the
		// report, not a replacement for it.
		expect(planned.settings.theme).toBe("dark");
	});
});
