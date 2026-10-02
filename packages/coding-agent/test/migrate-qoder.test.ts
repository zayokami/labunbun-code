/**
 * The `qoder` source, from the directory name through to the report.
 *
 * **What this file is for.** Qoder is the one source here whose settings are a
 * *merge of three files* rather than a document, so most of what follows is about
 * the difference between "the file is here" and "the file is what Qoder runs":
 *
 *   - **The configuration directory name is validated, and an invalid value does
 *     not fall back silently.** `QODER_CONFIG_DIR_NAME` is a path segment; the
 *     product throws on a name it refuses, so a reader that quietly read
 *     `~/.qoder` instead would import a tree Qoder itself rejected.
 *   - **The settings are user ⊕ project ⊕ local, and six keys merge only one
 *     level deep.** Reading `~/.qoder/settings.json` alone is a document Qoder is
 *     not running — see the shallow-key table.
 *   - **Nothing carries a credential.** `headers` and `env` *values* are stripped;
 *     their names are reported so the user can fill them in. A `url` carrying one
 *     in its userinfo or its query is the third path, and unlike the other two it
 *     cannot be dropped while keeping the server — see the test for it.
 *   - **A permission mode this build has no word for is skipped, not guessed.**
 *     Four of Qoder's six modes map to nothing, and one of them — `default` — maps
 *     to nothing precisely because importing it would write a posture the user
 *     never stated.
 *
 * Every fixture is a temporary directory. Nothing here reads a real install, a
 * real credential path, or anything under a user's home: `readQoder` takes `home`
 * and `env` as arguments and never calls `homedir()`, and every call below passes
 * an explicit `env` so the developer's own `QODER_CONFIG_DIR` cannot leak in.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration } from "../src/migrate.ts";
import { listHistory } from "../src/migrate-history.ts";
import { detectSources, MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS, SOURCE_ROOTS } from "../src/migrate-types.ts";
import {
	isValidQoderDirName,
	QODER_DEFAULT_DIR,
	QODER_DIR_NAME_REJECTIONS,
	QODER_HOOK_EVENTS,
	QODER_MERGE_SHALLOW,
	QODER_MERGE_UNION,
	QODER_PROJECT_SLUG_MAX,
	QODER_RESERVED_DIR_NAMES,
	type QoderDirNameRejection,
	qoderConfigDir,
	qoderDirName,
	qoderDirNameRejection,
	qoderLocalSettingsPath,
	qoderOtherConfigDir,
	qoderProjectMcpPath,
	qoderProjectSettingsPath,
	qoderProjectSlug,
	qoderProjectSlugUnicode,
	qoderSessionPath,
	validateQoderDirName,
} from "../src/qoder-home.ts";
import { mergeQoderSettings, type QoderSettingsLayer, readQoder } from "../src/qoder-read.ts";

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

interface QoderFixture {
	home: string;
	cwd: string;
}

/**
 * A home holding `~/.qoder` and a separate project directory, with whichever of
 * the three settings layers the caller asked for.
 *
 * **The two trees are separate roots on purpose.** The layers live at
 * `<home>/.qoder/settings.json` and `<cwd>/.qoder/settings.json`, so a fixture
 * that put both under one directory could not tell a merge bug from a path bug —
 * and a merge bug is the thing most of this file is about.
 *
 * `files` are written under `~/.qoder` and are how a test supplies memory,
 * skills and transcripts.
 */
function qoderFixture(
	options: { layers?: { user?: unknown; project?: unknown; local?: unknown }; files?: Record<string, string> } = {},
): QoderFixture {
	const home = makeDir("lbb-qoder-home-");
	const cwd = makeDir("lbb-qoder-proj-");
	const layers = options.layers ?? { user: {} };
	if (layers.user !== undefined) writeUnder(home, `${QODER_DEFAULT_DIR}/settings.json`, JSON.stringify(layers.user));
	if (layers.project !== undefined) writeUnder(cwd, ".qoder/settings.json", JSON.stringify(layers.project));
	if (layers.local !== undefined) writeUnder(cwd, ".qoder/settings.local.json", JSON.stringify(layers.local));
	for (const [relative, content] of Object.entries(options.files ?? {}))
		writeUnder(home, `${QODER_DEFAULT_DIR}/${relative}`, content);
	return { home, cwd };
}

/** A layer for the pure merge tests, with a path that names which file it was. */
function layer(
	source: QoderSettingsLayer["source"],
	settings: Record<string, unknown>,
	path = `/${source}.json`,
): QoderSettingsLayer {
	return { source, path, settings };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("it is registered as the fourteenth source, on the end of the list", () => {
	expect(MIGRATION_SOURCE_IDS[MIGRATION_SOURCE_IDS.length - 1]).toBe("qoder");
	expect(MIGRATION_SOURCE_IDS).toHaveLength(15);
	expect(MIGRATION_SOURCE_LABELS.qoder).toBe("Qoder");
	expect(SOURCE_ROOTS.qoder).toBe(".qoder");
	// Appended, never slotted in: the id before it keeps its place, so a source
	// added later cannot change which of two sources providing the same file wins.
	expect(MIGRATION_SOURCE_IDS[MIGRATION_SOURCE_IDS.length - 2]).toBe("antigravity");
});

// ---------------------------------------------------------------------------
// The configuration directory name
// ---------------------------------------------------------------------------

/**
 * Names the product accepts. Each one is here because it is a case the checks have
 * to *not* reject — the list is half the test.
 */
const ACCEPTED_NAMES = [
	".qoder",
	"a",
	"my.qoder-1",
	"Qoder CN",
	"配置目录",
	"a".repeat(64),
	// `com0` is not a device name: the product's own pattern is `com[1-9]`, and a
	// reader that widened it to `com\d` would refuse a directory Qoder creates.
	"com0",
];

/** `[name, the rejection the product gives it]`. */
const REJECTED_NAMES: [string, QoderDirNameRejection][] = [
	["", "empty"],
	["a".repeat(65), "too-long"],
	[" lead", "leading-or-trailing-space"],
	["trail ", "leading-or-trailing-space"],
	["name.", "trailing-dot"],
	[".", "trailing-dot"],
	["..", "trailing-dot"],
	["a/b", "characters"],
	["a\\b", "characters"],
	["emoji-😀", "characters"],
	["con", "device-name"],
	["PRN", "device-name"],
	["aux", "device-name"],
	["NUL", "device-name"],
	["com1", "device-name"],
	["lpt9", "device-name"],
	// The pattern is `…(?:\.|$)`, so a device name with an extension is still one.
	["com1.txt", "device-name"],
	[".git", "reserved-name"],
	[".vscode", "reserved-name"],
	["node_modules", "reserved-name"],
];

test.each(ACCEPTED_NAMES)("%j is a directory name Qoder accepts", (name) => {
	expect(validateQoderDirName(name)).toBeNull();
	expect(isValidQoderDirName(name)).toBe(true);
});

test.each(REJECTED_NAMES)("%j is rejected as %s", (name, rejection) => {
	expect(validateQoderDirName(name)).toBe(rejection);
	expect(isValidQoderDirName(name)).toBe(false);
	expect(QODER_DIR_NAME_REJECTIONS[rejection]).toBeTruthy();
});

test("every rejection the table provokes has a sentence, and no sentence names a rejection that cannot happen", () => {
	// `Record<QoderDirNameRejection, string>` already makes the map *total* — the
	// compiler refuses a missing key. What it cannot do is say the other half: that
	// every key is **reachable**. This compares the map against the rejections the
	// table above provokes, so a sentence left behind for a kind the validator no
	// longer returns is caught here.
	const provokable = [...new Set(REJECTED_NAMES.map(([, rejection]) => rejection))].sort();
	expect(Object.keys(QODER_DIR_NAME_REJECTIONS).sort()).toEqual(provokable);
});

test("the reserved names are the nine the product refuses", () => {
	expect([...QODER_RESERVED_DIR_NAMES].sort()).toEqual([
		".git",
		".github",
		".hg",
		".husky",
		".idea",
		".svn",
		".vscode",
		"bower_components",
		"node_modules",
	]);
});

test("a decomposed name is normalized before it is judged, and the normalized form is what is used", () => {
	// The product calls `normalize("NFC")` on the value *before* every check, so
	// `é` written as `e` + a combining acute is one letter to it and two code
	// points to a reader that checked first. Getting this backwards refuses a name
	// Qoder accepts, which is the direction that costs a user their settings.
	// Spelled as character codes because the encoding this file happens to be saved
	// in decides whether a literal here is decomposed at all — an editor that
	// normalizes on save would silently turn this test into its own opposite.
	const decomposed = `e${String.fromCharCode(0x301)}`;
	expect(decomposed.length).toBe(2);
	expect(validateQoderDirName(decomposed)).toBeNull();
	expect(qoderDirName({ QODER_CONFIG_DIR_NAME: decomposed })).toBe(String.fromCharCode(0xe9));
});

test("a refused name falls back to the default and is reported, rather than being read as if it were fine", () => {
	// Both halves matter and they are checked together because either alone would
	// pass: a fallback with no `rejectedDirName` is a silent wrong read, and a
	// rejection with no fallback is a crash for a user whose Qoder runs fine.
	const home = makeDir("lbb-qoder-home-");
	const env = { QODER_CONFIG_DIR_NAME: "con" };
	expect(qoderDirName(env)).toBe(QODER_DEFAULT_DIR);
	expect(qoderDirNameRejection(env)).toBe("device-name");
	expect(qoderConfigDir(home, env)).toBe(join(home, QODER_DEFAULT_DIR));
	// Unset is not a rejection: a user who set nothing has said nothing.
	expect(qoderDirNameRejection({})).toBeNull();
	expect(qoderDirName({})).toBe(QODER_DEFAULT_DIR);
});

test("a whole-path override wins outright and is used verbatim", () => {
	// It is a path, not a segment, so the name checks do not apply to it — and the
	// product resolves it against the working directory rather than the home.
	const home = makeDir("lbb-qoder-home-");
	expect(qoderConfigDir(home, { QODER_CONFIG_DIR: join(home, "elsewhere") })).toBe(join(home, "elsewhere"));
	// A blank value is unset, not an empty directory.
	expect(qoderConfigDir(home, { QODER_CONFIG_DIR: "   " })).toBe(join(home, QODER_DEFAULT_DIR));
});

test("the CLI home is a parent, not a home", () => {
	// The SDK does `join(QODER_CLI_HOME ?? homedir(), name)`. A reader that
	// treated it as the home itself would look one level too high, and every path
	// it produced would be a directory Qoder never wrote.
	const home = makeDir("lbb-qoder-home-");
	expect(qoderConfigDir(home, { QODER_CLI_HOME: "/opt/cli" })).toBe(join("/opt/cli", QODER_DEFAULT_DIR));
});

test("the other build's home is named, and it is the one this importer did not read", () => {
	expect(qoderOtherConfigDir("/h", join("/h", ".qoder"))).toBe(join("/h", ".qoder-cn"));
	expect(qoderOtherConfigDir("/h", join("/h", ".qoder-cn"))).toBe(join("/h", ".qoder"));
});

// ---------------------------------------------------------------------------
// Project paths and the slug
// ---------------------------------------------------------------------------

test("a session lives at projects/<slug>/<id>.jsonl, and the project settings sit under the same directory name", () => {
	const home = makeDir("lbb-qoder-home-");
	const configDir = qoderConfigDir(home, {});
	const cwd = join(home, "code", "app");
	// The directory *inside* a working directory follows `QODER_CONFIG_DIR_NAME`
	// too — `mc()` returns `{user: t, project: t}` when it is set — so a reader
	// that looked for `<cwd>/.qoder` would miss a user's renamed project settings.
	expect(qoderProjectSettingsPath(cwd, {})).toBe(join(cwd, ".qoder", "settings.json"));
	expect(qoderProjectSettingsPath(cwd, { QODER_CONFIG_DIR_NAME: "mine" })).toBe(join(cwd, "mine", "settings.json"));
	expect(qoderLocalSettingsPath(cwd, {})).toBe(join(cwd, ".qoder", "settings.local.json"));
	// The desktop's project MCP file takes no override — it is a literal in the
	// bundle — so with a renamed tree the two live in different places.
	expect(qoderProjectMcpPath(cwd)).toBe(join(cwd, ".qoder", ".mcp.json"));
	expect(qoderSessionPath(configDir, cwd, "abc")).toBe(join(configDir, "projects", qoderProjectSlug(cwd), "abc.jsonl"));
});

test("the slug is the product's, and the two copies the bundle carries name different directories for an astral character", () => {
	// `Bfe` (no `u`) is what the transcript path and the project memory directory
	// use; a second copy with `/gu` is used by the session-bundle exporter only.
	// With no flag a character outside the basic plane becomes one dash per UTF-16
	// code unit, so an emoji is two dashes — and getting this wrong reports "no
	// sessions" for a project that has them.
	const emoji = `/home/me/${String.fromCodePoint(0x1f4c1)}/app`;
	expect(qoderProjectSlug("/home/me/app")).toBe("-home-me-app");
	expect(qoderProjectSlug(emoji)).toBe("-home-me----app");
	expect(qoderProjectSlug(emoji)).not.toBe(qoderProjectSlugUnicode(emoji));
	// The hash suffix only appears past the cap, and it covers the original path. The
	// cap is `<= 200` on the **replaced** string, whose first character is the dash
	// the leading separator became — so 199 `a`s survive here, not 200.
	const long = `/${"a".repeat(QODER_PROJECT_SLUG_MAX + 10)}`;
	expect(qoderProjectSlug(long)).toMatch(new RegExp(`^-a{${QODER_PROJECT_SLUG_MAX - 1}}-[0-9a-z]+$`));
	// Two paths whose first `QODER_PROJECT_SLUG_MAX` characters agree still differ,
	// which is what the hash is there for and what a truncation-only slug would lose.
	expect(qoderProjectSlug(`/${"a".repeat(QODER_PROJECT_SLUG_MAX)}one`)).not.toBe(
		qoderProjectSlug(`/${"a".repeat(QODER_PROJECT_SLUG_MAX)}two`),
	);
	expect(qoderProjectSlug(`/${"a".repeat(5)}`)).toBe("-aaaaa");
});

// ---------------------------------------------------------------------------
// Reading: presence, JSON, and what a missing file is not
// ---------------------------------------------------------------------------

test("a home with no ~/.qoder reads as absent rather than as empty", () => {
	const home = makeDir("lbb-qoder-home-");
	const raw = readQoder(home, home, {});
	expect(raw.present).toBe(false);
	expect(raw.settings).toBeNull();
	expect(raw.settingsLayers).toEqual([]);
	expect(raw.memory).toEqual([]);
	expect(raw.assets).toEqual([]);
	expect(raw.skipped).toEqual([]);
});

test("an unreadable settings document is reported and the rest of the home is still read", () => {
	// Nothing short-circuits: a home with a damaged `settings.json` still yields
	// its skills, and the failure names the file rather than the parser's message —
	// a `SyntaxError` quotes the text it choked on, which would put a fragment of
	// the user's own file into the report.
	const { home, cwd } = qoderFixture({ files: { "skills/one/SKILL.md": "---\nname: one\ndescription: d\n---\n" } });
	writeUnder(home, `${QODER_DEFAULT_DIR}/settings.json`, '{"general": {');
	const raw = readQoder(home, cwd, {});
	expect(raw.settings).toBeNull();
	expect(
		raw.skipped.some((entry) => entry.name.endsWith("settings.json") && entry.reason.includes("not parseable as JSON")),
	).toBe(true);
	expect(raw.assets.map((skill) => skill.name)).toEqual(["one"]);
	// The parser's own words must not have leaked in.
	expect(JSON.stringify(raw.skipped)).not.toContain("position");
});

test("a file JSON.parse refuses is read anyway when only comments or trailing commas stand in the way", () => {
	// This reader's recovery is a strict **superset** of the product's: the SDK
	// strips comments, `parseJsonc` strips comments *and* trailing commas, and the
	// desktop accepts neither. Reading such a file is right for a migration and
	// wrong to do silently, which is what the line is for.
	const { home, cwd } = qoderFixture({
		layers: { user: { general: { defaultPermissionMode: "accept_edits" } } },
	});
	writeUnder(
		home,
		`${QODER_DEFAULT_DIR}/settings.json`,
		'{\n\t// the mode I picked\n\t"general": { "defaultPermissionMode": "accept_edits" },\n}\n',
	);
	const raw = readQoder(home, cwd, {});
	expect(raw.settings).toEqual({ general: { defaultPermissionMode: "accept_edits" } });
	expect(raw.skipped.some((entry) => entry.reason.includes("comments and trailing commas stripped"))).toBe(true);
});

test("a QODER_CLI_HOME that is the working directory suppresses the project layers too", () => {
	// The guard compares the **resolved CLI home** against the working directory,
	// not `home` against it. With `QODER_CLI_HOME` pointing at the project — a real
	// arrangement for anyone running the Qoder CLI inside the tree they are working
	// in — `<cwd>/.qoder/settings.json` is that home's own global settings, so the
	// product reads one layer. Checking `home` instead would read three.
	const home = makeDir("lbb-qoder-home-");
	const cwd = makeDir("lbb-qoder-proj-");
	writeUnder(
		home,
		`${QODER_DEFAULT_DIR}/settings.json`,
		JSON.stringify({ general: { defaultPermissionMode: "bypass_permissions" } }),
	);
	writeUnder(cwd, ".qoder/settings.json", JSON.stringify({ general: { defaultPermissionMode: "plan" } }));
	expect(readQoder(home, cwd, { QODER_CLI_HOME: cwd }).settingsLayers.map((entry) => entry.source)).toEqual(["user"]);
	// The same two files with no CLI home set are two layers, and the project wins.
	expect(readQoder(home, cwd, {}).settingsLayers.map((entry) => entry.source)).toEqual(["user", "project"]);
});

test("a home that is also the project directory reads one layer, not three", () => {
	// `fc` computes `c = resolve(cliHome ?? homedir()) === resolve(cwd)` and skips both
	// `cwd`-relative layers when it holds — which it does for every user who runs
	// Qoder with its CLI home as their working directory. Then
	// `<cwd>/.qoder/settings.json` *is* the user's global settings read from a second
	// path. Reading it again as a "project" layer would count their own keys twice
	// and, for anything not on a shallow path, merge the file into itself. The
	// fixture can only hold one content at that path, which is the whole point:
	// there is no way to tell the layers apart here except by counting them.
	const both = makeDir("lbb-qoder-both-");
	writeUnder(
		both,
		`${QODER_DEFAULT_DIR}/settings.json`,
		JSON.stringify({ general: { defaultPermissionMode: "bypass_permissions" } }),
	);
	const raw = readQoder(both, both, {});
	expect(raw.settingsLayers.map((entry) => entry.source)).toEqual(["user"]);
	expect(raw.settings?.general).toEqual({ defaultPermissionMode: "bypass_permissions" });
	// Through the whole pipeline, a `plan` value that appears twice would also show
	// up as a skip line twice — and `plan` is one of the four modes with no mapping.
	writeUnder(
		both,
		`${QODER_DEFAULT_DIR}/settings.json`,
		JSON.stringify({ general: { defaultPermissionMode: "plan" } }),
	);
	const result = runMigration({ home: both, cwd: both, from: "qoder", only: ["settings"], apply: false });
	expect(result.plan.items.filter((item) => item.detail.includes("is a planning posture"))).toHaveLength(1);
});

test("a missing file is not an error: no settings.json, no line about it", () => {
	// Two of the three layers are absent in the ordinary case, and a home that has
	// never written settings is a home that only installed the CLI. Reporting the
	// absence would fill every such report with noise, and the noise is the kind
	// that teaches a reader to skip the lines that matter.
	const home = makeDir("lbb-qoder-home-");
	const cwd = makeDir("lbb-qoder-proj-");
	writeUnder(home, `${QODER_DEFAULT_DIR}/memory/2026-01-02.md`, "remembered\n");
	const raw = readQoder(home, cwd, {});
	expect(raw.present).toBe(true);
	expect(raw.settings).toBeNull();
	expect(raw.skipped).toEqual([]);
	expect(raw.memory.map((document) => document.name)).toEqual(["2026-01-02.md"]);
});

test("a directory where a file was expected is its own failure, not an exception", () => {
	// `<home>/memory` is a directory here and the settings document lives one level
	// up, so a user with the other arrangement is a real case rather than a
	// hypothetical — and the sentence says which thing was found.
	const home = makeDir("lbb-qoder-home-");
	const cwd = makeDir("lbb-qoder-proj-");
	mkdirSync(join(home, QODER_DEFAULT_DIR, "settings.json"), { recursive: true });
	const raw = readQoder(home, cwd, {});
	expect(raw.settings).toBeNull();
	expect(raw.skipped.some((entry) => entry.reason.includes("a directory where a file was expected"))).toBe(true);
});

// ---------------------------------------------------------------------------
// The three-layer merge
// ---------------------------------------------------------------------------

test("the shallow keys are the six the SDK declares, spelled the way it spells them", () => {
	// A pin, not a proof: `uc` and `cc` are literals in the bundle and this is what
	// stops a well-meaning edit from quietly changing which paths merge one level
	// deep and which merge all the way. The behaviour each entry causes is the next
	// four tests.
	expect(QODER_MERGE_SHALLOW).toEqual([
		"mcpServers",
		"providers",
		"skillOverrides",
		"enabledPlugins",
		"extraKnownMarketplaces",
		"pluginConfigs",
	]);
	expect(QODER_MERGE_UNION).toHaveLength(13);
	expect(QODER_MERGE_UNION).toContain("tools.exclude");
});

// Spread into a mutable array: `test.each` takes a mutable table, and `readonly`
// here is the difference between the test running and the file typechecking.
test.each([...QODER_MERGE_SHALLOW])(
	"%s is merged one level deep: later keys win whole, earlier ones survive",
	(key) => {
		// The shape this test exists for is `{...user, ...project}` — **not** a
		// replacement and **not** a deep merge. An implementation that replaced would
		// drop `kept`; one that merged all the way would produce `{kept, added}`.
		const merged = mergeQoderSettings([
			layer("user", { [key]: { kept: 1 } }),
			layer("project", { [key]: { added: 2 } }),
		]);
		expect(merged.settings[key]).toEqual({ kept: 1, added: 2 });
	},
);

test("an entry both layers declare is taken whole from the later one", () => {
	// The consequence that makes reading the user layer alone wrong: a server the
	// user configured and a project has redefined is one entry with the project's
	// command and environment, not the user's with two fields merged.
	const merged = mergeQoderSettings([
		layer("user", { mcpServers: { shared: { command: "user-bin", args: ["--a"], env: { A: "1" } } } }),
		layer("project", { mcpServers: { shared: { command: "project-bin", args: [] } } }),
	]);
	expect(merged.settings.mcpServers).toEqual({ shared: { command: "project-bin", args: [] } });
});

test("a provider entry is taken whole from the later layer, the way a server entry is", () => {
	// `providers` is in the shallow table in its own right, so a provider the two
	// layers both declare comes from the project whole — no field of the user's
	// survives on top of it. Without the shallow rule the merge would produce
	// `{baseUrl: "https://b.invalid", apiKey: "user-key"}`: a provider half from each
	// layer, which is neither one nor the other and is not a provider either build
	// of Qoder is running.
	const merged = mergeQoderSettings([
		layer("user", { providers: { acme: { baseUrl: "https://a.invalid", apiKey: "user-key" } } }),
		layer("project", {
			providers: { acme: { baseUrl: "https://b.invalid" }, other: { baseUrl: "https://c.invalid" } },
		}),
	]);
	expect(merged.settings.providers).toEqual({
		acme: { baseUrl: "https://b.invalid" },
		other: { baseUrl: "https://c.invalid" },
	});
});

test("a key that is neither shallow, union nor concat merges all the way down", () => {
	const merged = mergeQoderSettings([layer("user", { general: { a: 1 } }), layer("local", { general: { b: 2 } })]);
	expect(merged.settings.general).toEqual({ a: 1, b: 2 });
});

test("two layers that both define a hook event produce both groups, not one winner", () => {
	// `hooks` is matched on **arity**, not on a name list: any two-segment path
	// whose first segment is `hooks` concatenates its group arrays.
	const merged = mergeQoderSettings([
		layer("user", { hooks: { PreToolUse: [{ hooks: [{ command: "u" }] }] } }),
		layer("project", { hooks: { PreToolUse: [{ hooks: [{ command: "p" }] }] } }),
	]);
	expect(merged.settings.hooks).toEqual({
		PreToolUse: [{ hooks: [{ command: "u" }] }, { hooks: [{ command: "p" }] }],
	});
});

test("a union path dedupes by identity, so two structurally equal objects stay two entries", () => {
	// `[...new Set([...i, ...u])]` compares the values themselves. Two objects that
	// look the same are two references, so the product keeps both — and collapsing
	// them would be this importer deciding Qoder's list should be shorter than it is.
	const merged = mergeQoderSettings([
		layer("user", { tools: { exclude: ["a", { b: 1 }] } }),
		layer("project", { tools: { exclude: ["a", { b: 1 }, "c"] } }),
	]);
	expect(merged.settings.tools).toEqual({ exclude: ["a", { b: 1 }, { b: 1 }, "c"] });
});

test("the three prototype key names are dropped wherever they sit", () => {
	// Not a precaution this importer adds: the product's merge skips them at every
	// level, so a settings file carrying `__proto__` has it ignored by Qoder too.
	// A reader that copied them through would be the only thing in the pipeline that
	// took the value. Three positions, and the last one no per-key filter can reach:
	// a `__proto__` nested **inside a shallow entry**, where the whole entry is copied
	// by one call rather than walked key by key.
	//
	// The assertion is on the prototype rather than on `Object.keys`, because that
	// is how the failure would actually present: a copy that did not skip the key
	// would not gain an own property, it would *set the object's prototype*, and
	// `Object.keys` would look the same either way.
	const document = JSON.parse(
		'{"__proto__":{"polluted":true},"general":{"constructor":1,"defaultPermissionMode":"accept_edits"}}',
	);
	const merged = mergeQoderSettings([
		layer("user", { ...document, mcpServers: { other: { command: "a" } } }),
		layer("project", JSON.parse('{"mcpServers":{"demo":{"__proto__":{"deep":true},"command":"bin"}}}')),
	]);
	expect(Object.keys(merged.settings).sort()).toEqual(["general", "mcpServers"]);
	expect(merged.settings.general).toEqual({ defaultPermissionMode: "accept_edits" });
	const servers = merged.settings.mcpServers as Record<string, Record<string, unknown>>;
	expect(Object.keys(servers).sort()).toEqual(["demo", "other"]);
	expect(Object.getPrototypeOf(servers.demo)).toBe(Object.prototype);
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	expect(({} as Record<string, unknown>).deep).toBeUndefined();
});

test("a shallow entry is copied, not aliased, so an `undefined` inside one does not survive the copy", () => {
	// The product's `Et` is a structural copy and its second job — after dropping
	// the three prototype names — is dropping `undefined`, which a `JSON.parse`
	// result can never contain. This is the one caller that can: `mergeQoderSettings`
	// is exported and takes whatever it is handed. Aliasing instead of copying would
	// leave `args: undefined` in the merged entry, where a server's argument list
	// would then fail its own schema check for having the key at all.
	const merged = mergeQoderSettings([
		layer("user", { mcpServers: {} }),
		layer("project", { mcpServers: { demo: { command: "bin", args: undefined } } }),
	]);
	const entry = (merged.settings.mcpServers as Record<string, Record<string, unknown>>).demo;
	expect(Object.keys(entry)).toEqual(["command"]);
	expect("args" in entry).toBe(false);
});

test("provenance names the last file that carried a key by name, which is not always the file whose value survived", () => {
	// From the bundle: `for (let f of Object.keys(d.settings)) … p[f] = {source, path}`
	// — a plain key listing, so a layer that sets a key to `undefined` still claims
	// it even though `Rn` drops the value and the user layer's is what survives.
	// Reproduced rather than corrected, and the test exists so that a future reader
	// who "fixes" it has to come here and say why.
	const merged = mergeQoderSettings([
		layer("user", { mcpServers: { a: {} }, general: { defaultPermissionMode: "accept_edits" } }),
		layer("local", { mcpServers: { b: {} }, general: undefined }),
	]);
	expect(merged.settings.general).toEqual({ defaultPermissionMode: "accept_edits" });
	expect(merged.provenance.general.source).toBe("local");
	expect(merged.provenance.mcpServers).toEqual({ source: "local", path: "/local.json" });
});

test("a project layer's servers are imported, and the report names the project file rather than the user's", () => {
	// The end-to-end half of the merge. Reading the user layer alone would import a
	// command the project has replaced; naming the user file would send the user to
	// edit a file that does not say what the report claims it does.
	const { home, cwd } = qoderFixture({
		layers: {
			user: { mcpServers: { mine: { command: "user-bin", args: [] } } },
			project: { mcpServers: { theirs: { command: "project-bin", args: ["--x"] } } },
		},
	});
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	expect(result.error).toBeUndefined();
	const write = result.plan.writes.find((one) => one.kind === "mcp");
	expect(JSON.parse(write?.content ?? "{}").mcpServers).toEqual({
		mine: { type: "stdio", command: "user-bin", args: [] },
		theirs: { type: "stdio", command: "project-bin", args: ["--x"] },
	});
	const theirs = result.plan.items.find((item) => item.to.includes("mcpServers.theirs"));
	// `tildePath` — which every label here goes through — rewrites separators to `/`
	// on every platform, so the expectation is written the same way rather than by
	// comparing against `join`, whose output is a backslash path on Windows.
	const projectFile = qoderProjectSettingsPath(cwd).replace(/\\/g, "/");
	expect(theirs?.from).toBe(`${projectFile} → mcpServers.theirs (project layer)`);
	// And the user's own server keeps the plain label, because that is where it is.
	// The SDK's provenance is keyed by top-level name, so `mcpServers` itself is
	// attributed to the project layer here; a label that repeated that would send
	// the user to a file with no `mine` in it.
	const mine = result.plan.items.find((item) => item.to.includes("mcpServers.mine"));
	expect(mine?.from).toBe(`~/${QODER_DEFAULT_DIR}/settings.json → mcpServers.mine`);
});

test("the project's own .mcp.json is named in the report and never read", () => {
	// It is a separate location the settings merge does not reach, and nothing in
	// either bundle says how it combines with `settings.json`. Saying so beats
	// importing both and calling it a merge.
	const { home, cwd } = qoderFixture();
	writeUnder(cwd, ".qoder/.mcp.json", '{"mcpServers":{"secret":{"url":"https://example.invalid"}}}');
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const named = result.plan.items.find((item) => item.detail.includes("the project's own MCP file"));
	expect(named?.from).toBe(qoderProjectMcpPath(cwd));
	expect(JSON.stringify(result.plan)).not.toContain("example.invalid");
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("a home with a busy ~/.qoder is offered, with no settings.json at all", () => {
	// The decision this source's detection rests on: `~/.qoder` is not shared with a
	// foreign tool the way `~/.gemini` is, because the Qoder CLI writes its own
	// state under the same directory. A CLI-only home is real and worth offering.
	const home = makeDir("lbb-qoder-home-");
	writeUnder(home, `${QODER_DEFAULT_DIR}/skills/one/SKILL.md`, "---\nname: one\ndescription: d\n---\n");
	expect(detectSources(home)).toContain("qoder");
});

test("the China build's directory is detected too, and an empty one is not", () => {
	// The product picks its build at start-up, so a process cannot see both — which
	// is exactly why listing the two spellings is what makes a machine holding
	// either detectable.
	const empty = makeDir("lbb-qoder-home-");
	mkdirSync(join(empty, QODER_DEFAULT_DIR), { recursive: true });
	expect(detectSources(empty)).not.toContain("qoder");

	const cn = makeDir("lbb-qoder-home-");
	writeUnder(cn, ".qoder-cn/settings.json", "{}");
	expect(detectSources(cn)).toContain("qoder");
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test("no header value and no env value reaches the plan, and both names do", () => {
	// The asymmetry is the design: a bearer token is an ordinary header or
	// environment value, and a user who has to type one in again is inconvenienced
	// while a user who pastes a config file somewhere is not. The names come across
	// so filling them back in is possible.
	const secretHeader = "sk-header-VALUE";
	const secretEnv = "sk-env-VALUE";
	const secretAuth = "sk-auth-VALUE";
	const { home, cwd } = qoderFixture({
		layers: {
			user: {
				mcpServers: {
					demo: {
						command: "npx",
						args: ["-y", "demo"],
						env: { DEMO_TOKEN: secretEnv, DEMO_HOME: "/tmp" },
						headers: { "x-team": secretHeader, authorization: secretAuth },
					},
				},
			},
		},
	});
	const raw = readQoder(home, cwd, {});
	// The reader drops `authorization` outright — it is one of the two keys the
	// product's own MCP reader throws MCP_CONFIG_STATIC_CREDENTIAL_FORBIDDEN for,
	// and the only one no name-based scan here would catch.
	expect(JSON.stringify(raw.mcpServers)).not.toContain(secretAuth);
	expect(raw.skipped.some((entry) => entry.name.endsWith("headers.authorization"))).toBe(true);

	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const plan = JSON.stringify(result.plan);
	for (const secret of [secretHeader, secretEnv, secretAuth]) expect(plan).not.toContain(secret);
	// The names survive, and so does the reason the values did not. `DEMO_TOKEN` is
	// named by the reader, as a `skipped` line carrying its full path; `DEMO_HOME`
	// is named by the planner, in the server's own line. Neither value is anywhere.
	expect(plan).toContain("DEMO_TOKEN");
	expect(plan).toContain("x-team");
	expect(plan).toContain("looks like a credential — name only, value never read");
	expect(plan).toContain("DEMO_HOME");
	const item = result.plan.items.find((one) => one.to.includes("mcpServers.demo"));
	expect(item?.action).toBe("downgrade");
	expect(item?.containsSecret).toBe(false);
	// And the written file holds the parts with no credential in them.
	const write = result.plan.writes.find((one) => one.kind === "mcp");
	const written = JSON.parse(write?.content ?? "{}").mcpServers.demo;
	expect(written).toEqual({ type: "stdio", command: "npx", args: ["-y", "demo"] });
});

test("a URL that carries a credential is not carried across, and a clean one still is", () => {
	// The gap the other two tests do not cover, and the one a name-based scan
	// cannot see: the credential is not under a secret-shaped *key*, it is inside
	// the single string every importer treats as a safe identifier. `headers` and
	// `env` can each be dropped whole while the server survives; a URL cannot —
	// removing its userinfo or its `?access_token=` leaves a different URL pointing
	// at nothing, so writing one would swap a credential on disk for a server that
	// fails to connect while the report still calls the copy a clean `map`.
	const userinfoPassword = "sk-url-pass-VALUE";
	const queryToken = "sk-url-token-VALUE";
	const { home, cwd } = qoderFixture({
		layers: {
			user: {
				mcpServers: {
					withUserinfo: { url: `https://alice:${userinfoPassword}@mcp.example.invalid/sse` },
					withQuery: { url: `https://mcp.example.invalid/mcp?access_token=${queryToken}` },
					clean: { url: "https://mcp.example.invalid/mcp" },
				},
			},
		},
	});

	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const plan = JSON.stringify(result.plan);
	for (const secret of [userinfoPassword, queryToken]) expect(plan).not.toContain(secret);

	// The clean server is untouched by any of this — the check is per-entry, not a
	// gate on the whole file, so one credential cannot cost a user the servers
	// beside it.
	const write = result.plan.writes.find((one) => one.kind === "mcp");
	const written = JSON.parse(write?.content ?? "{}").mcpServers;
	expect(written.clean).toEqual({ type: "http", url: "https://mcp.example.invalid/mcp" });
	expect(written.withUserinfo).toBeUndefined();
	expect(written.withQuery).toBeUndefined();

	for (const name of ["withUserinfo", "withQuery"]) {
		const item = result.plan.items.find((one) => one.from.includes(`mcpServers.${name}`));
		expect(item?.action).toBe("skip");
		// Nothing was written for these, and the flag says so honestly anyway: the
		// value this line is about *was* a credential, and a reader filtering items
		// for one should not have to read the prose to find that out.
		expect(item?.containsSecret).toBe(true);
	}
	// The reason names the shape. It must not print the value, and it must not
	// print the address either — the whole host is not the secret, but neither is
	// it the report's business.
	expect(plan).toContain("it carries a `name:password@` part in front of the address");
	expect(plan).toContain("one of its `?`/`#` parameter names is a credential word");
});

test("a credential-shaped key anywhere in the settings is dropped by the reader, by name only", () => {
	const { home, cwd } = qoderFixture({
		layers: {
			user: {
				general: { apiKey: "sk-value", defaultPermissionMode: "accept_edits" },
				context: { nested: { deep: { clientSecret: "sk-deep" } } },
				timeout: 30,
			},
		},
	});
	const raw = readQoder(home, cwd, {});
	expect(JSON.stringify(raw.settings)).not.toContain("sk-value");
	expect(JSON.stringify(raw.settings)).not.toContain("sk-deep");
	// The rest of `general` is untouched — a guard that dropped the whole object
	// would take the permission mode with it.
	expect(raw.settings?.general).toEqual({ defaultPermissionMode: "accept_edits" });
	expect(raw.settings?.timeout).toBe(30);
	const named = raw.skipped.filter((entry) => entry.reason.includes("looks like a credential"));
	expect(named.map((entry) => entry.name).sort()).toEqual([
		"~/.qoder/settings.json → context.nested.deep.clientSecret",
		"~/.qoder/settings.json → general.apiKey",
	]);
});

// ---------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------

test("a permission mode is claimed only when the file states one", () => {
	// An absent key means nothing claimed and nothing said. Importing the schema's
	// default would be writing a posture on the user's behalf that they never
	// stated — the fail-open direction a migration must not move in on its own.
	const { home, cwd } = qoderFixture({ layers: { user: { general: {} } } });
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	expect(result.plan.items.some((item) => item.to.includes("permissionMode"))).toBe(false);
	expect(result.plan.writes.some((write) => write.kind === "settings")).toBe(false);
});

test("Qoder's one value that means both jobs is claimed as both halves", () => {
	// Claiming only the mode half would leave a session that auto-approves
	// everything inside a sandbox nobody chose.
	const { home, cwd } = qoderFixture({
		layers: { user: { general: { defaultPermissionMode: "bypass_permissions" } } },
	});
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((write) => write.kind === "settings")?.content ?? "{}");
	expect(written.permissionMode).toBe("agent");
	expect(written.sandbox).toBe("danger-full-access");
});

test("accept_edits maps to ask, which is narrower than the name says, and the report says so", () => {
	// This build has no mode that applies edits without asking. Widening a
	// permission setting is the direction a migration must not move in alone.
	const { home, cwd } = qoderFixture({ layers: { user: { general: { defaultPermissionMode: "accept_edits" } } } });
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((write) => write.kind === "settings")?.content ?? "{}");
	expect(written.permissionMode).toBe("ask");
	expect(written.sandbox).toBe("workspace-write");
	const item = result.plan.items.find((one) => one.to === "settings.json → permissionMode");
	expect(item?.detail).toContain("Narrower than the mode it replaced");
});

/** `[the value in the file, what the report must say about it]`. */
const MODES_THAT_MAP_TO_NOTHING: [string, string][] = [
	["default", "is the absence of a choice rather than one"],
	["auto", "is a classifier that approves the calls it judges routine"],
	["dont_ask", "is the far end of Qoder's range"],
	["plan", "is a planning posture rather than a permission one"],
];

test.each(MODES_THAT_MAP_TO_NOTHING)("%s is skipped with its own reason rather than guessed at", (value, phrase) => {
	// The failure this guards is a guess: writing the nearest mode here would set
	// a sandbox the mode never described, in the direction that widens rather than
	// narrows. Each of the four has a different reason and a different consequence,
	// so the table carries the sentence each one has to earn.
	const { home, cwd } = qoderFixture({ layers: { user: { general: { defaultPermissionMode: value } } } });
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	expect(result.plan.items.some((item) => item.to.includes("permissionMode"))).toBe(false);
	expect(result.plan.writes.some((write) => write.kind === "settings")).toBe(false);
	const item = result.plan.items.find((one) => one.from.includes("defaultPermissionMode"));
	expect(item?.action).toBe("skip");
	expect(item?.detail).toContain(phrase);
});

test("a value that is not a string is skipped, not coerced", () => {
	const { home, cwd } = qoderFixture({ layers: { user: { general: { defaultPermissionMode: { mode: "ask" } } } } });
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	expect(result.plan.items.some((item) => item.to.includes("permissionMode"))).toBe(false);
	const item = result.plan.items.find((one) => one.from.includes("defaultPermissionMode"));
	expect(item?.detail).toContain("not a string");
});

test("a mode Qoder has never heard of is skipped too, on the general ground", () => {
	const { home, cwd } = qoderFixture({ layers: { user: { general: { defaultPermissionMode: "yolo" } } } });
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const item = result.plan.items.find((one) => one.from.includes("defaultPermissionMode"));
	expect(item?.detail).toContain("not a permission mode Qoder defines");
	expect(result.plan.items.some((entry) => entry.to.includes("permissionMode"))).toBe(false);
});

// ---------------------------------------------------------------------------
// MCP shapes Qoder's own normalizer decides
// ---------------------------------------------------------------------------

test("an entry Qoder itself refuses is refused here too, with the same reason", () => {
	// From the code that validates an entry before the settings editor will save
	// it: neither `command` nor `url` is MCP_CONFIG_TRANSPORT_REQUIRED, and **both**
	// at once is MCP_CONFIG_TRANSPORT_AMBIGUOUS — an error, not "command wins". An
	// importer that let `command` win would connect a server Qoder refuses to run.
	const { home, cwd } = qoderFixture({
		layers: {
			user: {
				mcpServers: {
					neither: { args: [] },
					both: { command: "bin", url: "https://example.invalid" },
				},
			},
		},
	});
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	expect(result.plan.items.some((item) => item.to.includes("mcpServers."))).toBe(false);
	expect(result.plan.writes.some((write) => write.kind === "mcp")).toBe(false);
	const plan = JSON.stringify(result.plan.items);
	expect(plan).toContain("MCP_CONFIG_TRANSPORT_REQUIRED");
	expect(plan).toContain("MCP_CONFIG_TRANSPORT_AMBIGUOUS");
});

test("a server Qoder has switched off is not imported, because the user turned it off there", () => {
	const { home, cwd } = qoderFixture({
		layers: { user: { mcpServers: { off: { command: "bin", args: [], disabled: true } } } },
	});
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	expect(result.plan.writes.some((write) => write.kind === "mcp")).toBe(false);
	const item = result.plan.items.find((one) => one.from.includes("mcpServers.off"));
	expect(item?.detail).toContain("switched off");
});

test("an entry carrying `enabled` is refused, because Qoder's own editor refuses to save it", () => {
	// `MCP_CONFIG_ENABLED_UNSUPPORTED`: Qoder keeps whether a server runs in
	// `disabled`, and an `enabled` key means the file is not one Qoder would accept.
	// Importing it as a working server would be importing something the user could
	// not have written there in the first place.
	const { home, cwd } = qoderFixture({
		layers: { user: { mcpServers: { x: { command: "bin", args: [], enabled: true } } } },
	});
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	expect(result.plan.writes.some((write) => write.kind === "mcp")).toBe(false);
	expect(JSON.stringify(result.plan.items)).toContain("MCP_CONFIG_ENABLED_UNSUPPORTED");
	// The two `disabled` shapes, because `false` is the common one and must import.
	const ok = qoderFixture({
		layers: {
			user: {
				mcpServers: {
					x: { command: "bin", args: [], disabled: false },
					y: { command: "bin", args: [], disabled: "yes" },
				},
			},
		},
	});
	const mixed = runMigration({ home: ok.home, cwd: ok.cwd, from: "qoder", only: ["settings"], apply: false });
	const written = JSON.parse(mixed.plan.writes.find((write) => write.kind === "mcp")?.content ?? "{}");
	expect(Object.keys(written.mcpServers)).toEqual(["x"]);
	expect(JSON.stringify(mixed.plan.items)).toContain("MCP_CONFIG_DISABLED_INVALID");
});

test("a managed-gateway connector is named and never opened", () => {
	// Qoder accepts `qoder_url` only when it passes a region and trusted-domain
	// check against its own managed MCP environment, which does not exist here.
	const { home, cwd } = qoderFixture({
		layers: { user: { mcpServers: { hub: { qoder_url: "https://hub.example.invalid/mcp" } } } },
	});
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	expect(result.plan.writes.some((write) => write.kind === "mcp")).toBe(false);
	expect(JSON.stringify(result.plan.items)).toContain("managed-gateway connector");
});

test("a relative cwd is named rather than written, and an absolute one is kept", () => {
	// The decision is made on both spellings rather than this process's platform:
	// a Windows path in a file written on another machine is absolute in every
	// sense that matters, and dropping it because the importer is not Windows would
	// lose a working server.
	const { home, cwd } = qoderFixture({
		layers: {
			user: {
				mcpServers: {
					win: { command: "bin", args: [], cwd: "C:\\tools\\demo" },
					posix: { command: "bin", args: [], cwd: "/opt/demo" },
					relative: { command: "bin", args: [], cwd: "./demo" },
				},
			},
		},
	});
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((write) => write.kind === "mcp")?.content ?? "{}").mcpServers;
	expect(written.win.cwd).toBe("C:\\tools\\demo");
	expect(written.posix.cwd).toBe("/opt/demo");
	expect(written.relative.cwd).toBeUndefined();
	expect(JSON.stringify(result.plan.items)).toContain("its relative cwd was left off");
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

test("the events Qoder declares that this build also runs are imported, and the rest are named", () => {
	// Qoder's `hGr` takes **any** key as an event name and never enumerates them,
	// because the dispatcher is in the runtime binary — so the only check available
	// is against a list, and this build runs eight events of which Qoder has seven.
	// The intersection is not the whole story in either direction: `Notification`
	// is one this build runs and Qoder does not have.
	expect(QODER_HOOK_EVENTS).toHaveLength(18);
	expect(QODER_HOOK_EVENTS).toContain("SubagentStop");
	expect(QODER_HOOK_EVENTS).not.toContain("Notification");

	const { home, cwd } = qoderFixture({
		layers: {
			user: {
				hooks: {
					PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo hi" }] }],
					PostToolUseFailure: [{ hooks: [{ command: "echo bye" }] }],
				},
			},
		},
	});
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((write) => write.kind === "settings")?.content ?? "{}");
	expect(Object.keys(written.hooks ?? {})).toEqual(["PreToolUse"]);
	// And the one Qoder has and this build does not is a report line, not a silence.
	const dropped = result.plan.items.find((item) => item.detail.includes("PostToolUseFailure"));
	expect(dropped?.detail).toContain("Qoder declares 18 events in total");
});

test("a handler this build cannot widen is left off and counted from the file", () => {
	// `if`, `once` and `asyncRewake` all change *whether* a hook runs, so importing
	// them without the flag would run the hook every time — the direction a
	// migration must not take on its own judgement. There is also no timeout field
	// anywhere in Qoder's hook record to read.
	const { home, cwd } = qoderFixture({
		layers: {
			user: {
				hooks: {
					Stop: [
						{ hooks: [{ command: "plain" }] },
						{ hooks: [{ command: "conditional", if: "$A == 1" }] },
						{ hooks: [{ command: "one-shot", once: true }] },
					],
				},
			},
		},
	});
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((write) => write.kind === "settings")?.content ?? "{}");
	expect(written.hooks.Stop[0].hooks).toEqual([{ type: "command", command: "plain" }]);
	const detail = result.plan.items.find((item) => item.to.includes("hooks"))?.detail ?? "";
	expect(detail).toContain("1 handler(s) carried an `if` condition");
	expect(detail).toContain("1 handler(s) were marked `once`");
});

// ---------------------------------------------------------------------------
// The planner is wired
// ---------------------------------------------------------------------------

test("a settings run reaches the planner, and so does an assets-only run", () => {
	// A source can be registered end to end — id, label, `SOURCE_ROOTS`,
	// `detectionRoots`, a reader, a planner — and still import nothing, because the
	// one line in `migrate.ts` that calls the planner was never written. The gate is
	// `wants("settings") || wants("assets")` rather than one of the two: a run that
	// asked only for skills would otherwise reach the asset branches through no path
	// at all while every test of the mapping stayed green.
	const settings = qoderFixture({ layers: { user: { general: { defaultPermissionMode: "bypass_permissions" } } } });
	const settingsRun = runMigration({
		home: settings.home,
		cwd: settings.cwd,
		from: "qoder",
		only: ["settings"],
		apply: false,
	});
	expect(settingsRun.error).toBeUndefined();
	// Not merely "an item exists" — the leftover lines are unconditional, so their
	// presence would survive a planner that had stopped claiming anything.
	expect(settingsRun.plan.items.some((item) => item.to === "settings.json → permissionMode")).toBe(true);

	const assets = qoderFixture({ files: { "skills/one/SKILL.md": "---\nname: one\ndescription: d\n---\nbody\n" } });
	const assetsRun = runMigration({ home: assets.home, cwd: assets.cwd, from: "qoder", only: ["assets"], apply: false });
	expect(assetsRun.plan.items.filter((item) => item.action === "map").map((item) => item.to)).toContain(
		"~/.labunbun/skills/one/SKILL.md",
	);
	expect(assetsRun.plan.writes.some((write) => write.path.includes("one"))).toBe(true);
});

test("a model and a theme are reported as absent from the file rather than dropped", () => {
	// The single most important line this source writes. Qoder's desktop reads its
	// settings field by field and every literal field name it names is one of five —
	// there is no settings field for a model or a theme in this build. Without this
	// line a report that lists four settings looks like four settings were quietly
	// dropped.
	const { home, cwd } = qoderFixture({ layers: { user: {} } });
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const item = result.plan.items.find((one) => one.detail.includes("no model and no theme"));
	expect(item?.detail).toContain("chatSession.builtInBrowserHosts");
	expect(item?.detail).toContain("Set them with /model and /theme");
});

// ---------------------------------------------------------------------------
// History: the deferral
// ---------------------------------------------------------------------------

test("no session is offered, the reason is stated, and the count is the real one", () => {
	// A report that says "3 sessions left behind" is worth writing even though the
	// migration moves none of them: it is the difference between a user who expected
	// their history to come across and being told, and a user who never had any.
	// Three files that are never opened is what makes the number worth printing.
	const { home, cwd } = qoderFixture({
		files: {
			"projects/app-a/one.jsonl": "{}\n",
			"projects/app-a/two.jsonl": "{}\n",
			"projects/app-b/three.jsonl": "{}\n",
		},
	});
	const listed = listHistory("qoder", home, { cwd, scope: "all" });
	expect(listed.candidates).toEqual([]);
	expect(listed.notes).toHaveLength(1);
	expect(listed.notes[0].count).toBe(3);
	expect(listed.notes[0].reason).toContain("qoder-runtime-host");
	// The reason names the writer that is missing, so a reader can tell "we did not
	// write this" from "there was nothing".
	expect(listed.notes[0].reason).toContain("copies none of them");
});

test("a Qoder with no transcripts reports zero rather than staying silent", () => {
	// The count is computed rather than a standing zero, so this is the test that
	// would fail if it were hard-coded.
	const { home, cwd } = qoderFixture();
	expect(listHistory("qoder", home, { cwd, scope: "all" }).notes[0].count).toBe(0);
});

test("scope none short-circuits before any of this", () => {
	const { home, cwd } = qoderFixture({ files: { "projects/app-a/one.jsonl": "{}\n" } });
	expect(listHistory("qoder", home, { cwd, scope: "none" }).notes).toEqual([]);
});
