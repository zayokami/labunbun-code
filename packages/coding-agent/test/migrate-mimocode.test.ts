/**
 * The `mimocode-code` source, from the four roots through to the report.
 *
 * **What this file is for.** MiMo Code is the first source here whose tree is
 * **four sibling directories rather than one**, and the first whose settings are
 * a merge of three global files in an order the filenames do not suggest. Most of
 * what follows is about those two facts plus the three credential channels that
 * are not key-shaped:
 *
 *   - **The four roots.** `config` and `data` are siblings under either
 *     `$MIMOCODE_HOME` or an XDG base, so `SOURCE_ROOTS` holds a label and
 *     `detectionRoots()` finds the tree. **The product's own README is wrong about
 *     where these are** — it claims `%LOCALAPPDATA%` and
 *     `~/Library/Application Support`, and neither path is in its code — so a test
 *     that pinned the README's spelling would pin a path nothing reads.
 *   - **The merge order is `config.json`, `mimocode.json`, `mimocode.jsonc`** —
 *     first, second, last — so the `.jsonc` wins and the `.json` loses. Reading
 *     any one file would import a document MiMo Code is not running.
 *   - **`mcp.<name>.command` is an ARRAY.** A reader expecting `command` plus
 *     `args` reads `undefined` and either drops the server or writes an empty
 *     command.
 *   - **A `url` carrying a credential is not carried across**, and `headers` and
 *     `environment` values are dropped while their names are reported.
 *   - **Every settings document is JSONC**, so a comment in a file called
 *     `config.json` is legal and `JSON.parse` alone loses the whole document.
 *
 * Every fixture is a temporary directory. Nothing here reads a real install, a
 * real credential path, or anything under a user's home: `readMiMoCode` takes
 * `home` and `env` as arguments and never calls `homedir()`, and every call below
 * passes an explicit `env` so the developer's own `MIMOCODE_HOME` cannot leak in.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runMigration } from "../src/migrate.ts";
import { listHistory } from "../src/migrate-history.ts";
import { detectSources, MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS, SOURCE_ROOTS } from "../src/migrate-types.ts";
import {
	isMiMoCodeAbsolutePath,
	MIMOCODE_APP,
	MIMOCODE_ENTRY_MAP_KEYS,
	MIMOCODE_INSTRUCTION_FILES,
	MIMOCODE_LEGACY_KEYS,
	MIMOCODE_MEMORY_SCOPES,
	MIMOCODE_SETTINGS_FILES,
	MIMOCODE_VENDOR_SKILL_DIRS,
	type MiMoCodeEnv,
	mimocodeChannelDatabaseNames,
	mimocodeDatabasePath,
	mimocodeEntryName,
	mimocodeManagedConfigDir,
	mimocodeMemoryPath,
	mimocodeReadRoots,
	mimocodeRoots,
} from "../src/mimocode-home.ts";
import { MIMOCODE_PERMISSION_TOOLS, planMiMoCode } from "../src/mimocode-plan.ts";
import { type MiMoCodeSettingsLayer, mergeMiMoCodeSettings, readMiMoCode } from "../src/mimocode-read.ts";
import { borrowSourceEnv, releaseEnv } from "./source-env.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const made: string[] = [];

/**
 * Every test runs with no relocation variable set, and gets them back after.
 *
 * **This is a `beforeEach` and not a fixture call, and the difference is the whole
 * bug.** MiMo Code is the one source here whose roots come from `XDG_*`, and this
 * file builds its homes two ways: the `mimocodeFixture` helper and thirteen
 * hand-rolled `makeDir` calls. It also calls `readMiMoCode(home, cwd, {})` twenty
 * times with an explicit empty environment, because that is how you test a
 * resolver — while `runMigration` takes no environment at all and falls through
 * to `process.env`.
 *
 * So the file contained **two worlds**: a fixture that resolved against `{}` and
 * a migration that resolved against the real environment. On a developer machine
 * `XDG_CONFIG_HOME` is usually unset and the two agree, which is why it passed
 * locally. A GitHub Linux runner has it set, the fixture writes into one
 * directory and the reader looks in another, and 32 assertions saw an empty plan
 * on `test (ubuntu-latest)` and 5 on `test (macos-latest)`.
 *
 * Borrowing per-fixture fixed most of it and left five failing, because those five
 * reach `runMigration` through a hand-rolled home. One hook, before anything runs,
 * is the seam that cannot be bypassed — a test that forgets to call it is green
 * locally and red on a runner, which is the property that has to not exist.
 */
beforeEach(() => {
	borrowSourceEnv();
});
afterEach(() => {
	releaseEnv();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Kept as a name so a reader can see why the hook above exists. */
function borrowEnvForFixture(): void {
	borrowSourceEnv();
}

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

interface MiMoCodeFixture {
	home: string;
	cwd: string;
	/** `<config>`, for tests that need to name the path. */
	config: string;
	/** `<data>`, likewise. */
	data: string;
}

/**
 * A home holding an empty MiMo Code tree and a separate project directory, with
 * whichever settings layers and files the caller asked for.
 *
 * **The two trees are separate roots on purpose.** The global documents live at
 * `<config>/…` and the project one at `<cwd>/.mimocode/mimocode.jsonc`, so a
 * fixture that put both under one directory could not tell a merge bug from a
 * path bug — and a merge bug is the thing most of this file is about.
 *
 * `files` are written **relative to `<config>`** when the key starts with
 * `config/`, relative to `<data>` when it starts with `data/`, and relative to
 * the home otherwise. That split is spelled out rather than implied because the two
 * roots are *siblings* and neither is under the home by any short name: `<config>`
 * is `<home>/.config/mimocode` and `<data>` is `<home>/.local/share/mimocode`, so
 * a fixture that wrote `config/…` against the home would put a `skills/` tree where
 * the reader would correctly find nothing — a fixture bug indistinguishable from a
 * reader bug.
 */
function mimocodeFixture(
	options: {
		env?: MiMoCodeEnv;
		files?: Record<string, string>;
		global?: Record<string, unknown>;
		project?: unknown;
	} = {},
): MiMoCodeFixture {
	borrowEnvForFixture();
	const home = makeDir("lbb-mimocode-home-");
	const cwd = makeDir("lbb-mimocode-proj-");
	const roots = mimocodeRoots(home, options.env ?? {});
	mkdirSync(roots.config, { recursive: true });
	mkdirSync(roots.data, { recursive: true });
	if (options.global !== undefined) {
		writeUnder(roots.config, "mimocode.json", JSON.stringify(options.global));
	}
	if (options.project !== undefined) {
		writeUnder(cwd, ".mimocode/mimocode.jsonc", JSON.stringify(options.project));
	}
	for (const [relative, content] of Object.entries(options.files ?? {})) {
		if (relative.startsWith("data/")) writeUnder(roots.data, relative.slice("data/".length), content);
		else if (relative.startsWith("config/")) writeUnder(roots.config, relative.slice("config/".length), content);
		else writeUnder(home, relative, content);
	}
	return { home, cwd, config: roots.config, data: roots.data };
}

/** A layer for the pure merge tests, with a path that names which file it was. */
function layer(
	source: MiMoCodeSettingsLayer["source"],
	settings: Record<string, unknown>,
	path = `/${source}.json`,
): MiMoCodeSettingsLayer {
	return { source, path, settings };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("it holds the sixteenth place, and the fifteen before it are untouched", () => {
	// **By index and not "on the end", because the end moves.** Another source
	// appended after this one would make a `length - 1` assertion here fail for a
	// reason that has nothing to do with this importer — the same fix the qoder and
	// antigravity tests made. What the rule really is: *appended, never slotted in*,
	// so the ids before this one keep their places and a later source cannot change
	// which of two sources providing the same file wins.
	expect(MIGRATION_SOURCE_IDS.indexOf("mimocode-code")).toBeGreaterThan(14);
	expect(MIGRATION_SOURCE_IDS.indexOf("qoder")).toBe(14);
	expect(MIGRATION_SOURCE_IDS.indexOf("antigravity")).toBe(13);
	expect(MIGRATION_SOURCE_IDS.indexOf("claude-code")).toBe(0);
	expect(MIGRATION_SOURCE_IDS.length).toBeGreaterThan(15);
	// Appended, not slotted in: the ids between `claude-code` and this one are the
	// fourteen that were already there, in the order they were in. Checking the two
	// neighbours by index is what would catch a reordering, and checking only the
	// length would not.
	expect(MIGRATION_SOURCE_IDS.slice(0, 14)).toEqual([
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
		"t3-code",
		"antigravity",
	]);
	expect(MIGRATION_SOURCE_LABELS["mimocode-code"]).toBe("MiMo Code");
	// **The label is the XDG spelling, not the product's README's.** Its README
	// claims `%LOCALAPPDATA%\mimocode\` (README.md:385) and
	// `~/Library/Application Support/mimocode/` (`:422); neither path is anywhere in
	// its tree, because `packages/shared/src/global.ts` imports `xdg-basedir` with
	// no platform branch. Pinning the README's spelling here would pin a path that
	// nothing reads on any platform.
	expect(SOURCE_ROOTS["mimocode-code"]).toBe(`.config/${MIMOCODE_APP}`);
	expect(SOURCE_ROOTS["mimocode-code"]).not.toContain("LOCALAPPDATA");
	expect(SOURCE_ROOTS["mimocode-code"]).not.toContain("Application Support");
});

// ---------------------------------------------------------------------------
// The four roots
// ---------------------------------------------------------------------------

test("the four roots are siblings under an XDG base, and none of them is a platform branch", () => {
	// **`xdg-basedir` has no `process.platform` test**, which is the whole point:
	// the same four POSIX spellings apply on Windows, macOS and Linux. A reader
	// written the way a Windows importer is normally written finds nothing on this
	// machine and reports the source as absent.
	const home = makeDir("lbb-mimocode-home-");
	const roots = mimocodeRoots(home, {});
	expect(roots.mode).toBe("xdg");
	expect(roots.config).toBe(join(home, ".config", MIMOCODE_APP));
	expect(roots.data).toBe(join(home, ".local", "share", MIMOCODE_APP));
	expect(roots.state).toBe(join(home, ".local", "state", MIMOCODE_APP));
	expect(roots.cache).toBe(join(home, ".cache", MIMOCODE_APP));
	// **Siblings, not nested** — the fact that forced a `detectionRoots()` branch,
	// because labunbun's `SOURCE_ROOTS` holds one home-relative string per source
	// and no single directory here answers "is MiMo Code installed".
	expect(roots.data.startsWith(roots.config)).toBe(false);
	expect(roots.config.startsWith(roots.data)).toBe(false);
});

test("an XDG_* variable moves one base and is used verbatim, with no resolve", () => {
	const home = makeDir("lbb-mimocode-home-");
	const roots = mimocodeRoots(home, { XDG_CONFIG_HOME: "/elsewhere/cfg" });
	// Verbatim: `xdg-basedir` reads `process.env.X || path.join(homedir(), …)` with
	// no `~` expansion and no `resolve`, so a relative value would resolve against
	// the process's working directory — which is where MiMo Code would look too.
	expect(roots.config).toBe(join("/elsewhere/cfg", MIMOCODE_APP));
	// One base only: the other three are untouched by it.
	expect(roots.data).toBe(join(home, ".local", "share", MIMOCODE_APP));
	// An empty value is falsy to `xdg-basedir` and falls through to the fallback;
	// whitespace is *not* falsy, and that is reproduced rather than trimmed.
	expect(mimocodeRoots(home, { XDG_CONFIG_HOME: "" }).config).toBe(join(home, ".config", MIMOCODE_APP));
	expect(mimocodeRoots(home, { XDG_CONFIG_HOME: "   " }).config).toBe(join("   ", MIMOCODE_APP));
});

test("MIMOCODE_HOME replaces all four roots, and a relative one is refused and reported", () => {
	const home = makeDir("lbb-mimocode-home-");
	const rooted = mimocodeRoots(home, { MIMOCODE_HOME: "/opt/mimo" });
	expect(rooted.mode).toBe("mimocode-home");
	expect(rooted.config).toBe(join("/opt/mimo", "config"));
	expect(rooted.data).toBe(join("/opt/mimo", "data"));
	expect(rooted.state).toBe(join("/opt/mimo", "state"));
	expect(rooted.cache).toBe(join("/opt/mimo", "cache"));

	// **`resolveMimocodeHome` throws on a relative value** (global.ts:29-33), so a
	// MiMo Code configured that way is one that will not start. This importer must
	// not throw either — a migration that aborts on one source's misconfiguration
	// loses every other source's import — so it falls back and *says so*.
	const relative = mimocodeRoots(home, { MIMOCODE_HOME: "somewhere/mimo" });
	expect(relative.config).toBe(join(home, ".config", MIMOCODE_APP));
	expect(relative.rejectedHome).toContain("must be an absolute path");
	expect(relative.rejectedHome).toContain("will not start");
	// Both spellings of absolute, because `path.isAbsolute` is platform-dependent
	// and a `MIMOCODE_HOME` written on Windows must not be refused on Linux.
	expect(isMiMoCodeAbsolutePath("/opt/mimo")).toBe(true);
	expect(isMiMoCodeAbsolutePath("C:\\mimo")).toBe(true);
	expect(mimocodeRoots(home, { MIMOCODE_HOME: "C:\\mimo" }).mode).toBe("mimocode-home");
	expect(isMiMoCodeAbsolutePath("somewhere/mimo")).toBe(false);
});

test("the roots that are read are the product's, weakest first", () => {
	borrowEnvForFixture();
	const home = makeDir("lbb-mimocode-home-");
	const cwd = join(home, "code", "app");
	const roots = mimocodeRoots(home, {});
	// `ConfigPaths.directories` (config/paths.ts:24-39): `<config>`, every
	// `.mimocode` walking **up** from the working directory, `<home>/.mimocode`,
	// and `$MIMOCODE_CONFIG_DIR` — merged in that order, so a later one overwrites.
	const found = mimocodeReadRoots(home, roots, cwd, {});
	expect(found[0]).toBe(roots.config);
	expect(found).toContain(join(cwd, ".mimocode"));
	expect(found).toContain(join(home, "code", ".mimocode"));
	expect(found).toContain(join(home, ".mimocode"));
	expect(found.indexOf(join(cwd, ".mimocode"))).toBeLessThan(found.indexOf(join(home, ".mimocode")));
	expect(mimocodeReadRoots(home, roots, cwd, { MIMOCODE_CONFIG_DIR: "/extra" })).toContain("/extra");
	// No `cwd`, no project walk: a reader that invented one would read the test
	// runner's own checkout.
	expect(mimocodeReadRoots(home, roots, undefined, {})).toEqual([roots.config, join(home, ".mimocode")]);
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("a home whose only populated root is the data one is still detected", () => {
	borrowEnvForFixture();
	// **The case a single detection root gets wrong.** `config` gets a starter
	// `mimocode.jsonc` written on first run (config/config.ts:656-662) so it is
	// non-empty early; `data` is where every session and `auth.json` live and is
	// empty for a user who ran the TUI without keeping a conversation. Looking at
	// `config` alone would call the source absent on exactly the machines whose
	// history is the thing being migrated.
	const dataOnly = makeDir("lbb-mimocode-home-");
	const data = mimocodeRoots(dataOnly, {}).data;
	mkdirSync(data, { recursive: true });
	writeUnder(data, "auth.json", "{}");
	expect(detectSources(dataOnly)).toContain("mimocode-code");

	const empty = makeDir("lbb-mimocode-home-");
	mkdirSync(mimocodeRoots(empty, {}).config, { recursive: true });
	expect(detectSources(empty)).not.toContain("mimocode-code");
});

// ---------------------------------------------------------------------------
// The settings merge
// ---------------------------------------------------------------------------

test("the three global documents are applied in an order the filenames do not suggest", () => {
	// `config/config.ts:630-636` folds them in with `mergeDeep` in exactly this
	// order, so **`mimocode.jsonc` is last and wins** and `config.json` is first and
	// loses. That is the opposite of what the filenames suggest to anyone who
	// assumes the more specific name is the base.
	expect(MIMOCODE_SETTINGS_FILES).toEqual(["config.json", "mimocode.json", "mimocode.jsonc"]);

	const home = makeDir("lbb-mimocode-home-");
	const cwd = makeDir("lbb-mimocode-proj-");
	const roots = mimocodeRoots(home, {});
	mkdirSync(roots.config, { recursive: true });
	writeUnder(roots.config, "config.json", JSON.stringify({ model: "a/model", username: "u" }));
	writeUnder(roots.config, "mimocode.json", JSON.stringify({ model: "b/model" }));
	writeUnder(roots.config, "mimocode.jsonc", JSON.stringify({ model: "c/model" }));

	const raw = readMiMoCode(home, cwd, {});
	expect(raw.settingsLayers.map((one) => one.source)).toEqual([
		"global-config-json",
		"global-mimocode-json",
		"global-mimocode-jsonc",
	]);
	expect(raw.settings?.model).toBe("c/model");
	// The other key survives, because the merge is deep and not a replace.
	expect(raw.settings?.username).toBe("u");
	expect(raw.provenance.model.source).toBe("global-mimocode-jsonc");
});

test("a project layer wins over every global one, and its label says so", () => {
	// The report's answer to "why does my project say something my global settings
	// do not". A label that pointed at `<config>/mimocode.json` would send the user
	// to edit a file that no longer decides anything.
	const { home, cwd } = mimocodeFixture({
		global: { mcp: { mine: { type: "local", command: ["global-bin"] } } },
		project: { mcp: { theirs: { type: "local", command: ["project-bin"] } } },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const theirs = result.plan.items.find((item) => item.to.includes("mcpServers.theirs"));
	expect(theirs?.from).toContain("(project layer)");
	expect(theirs?.from).toContain(".mimocode/mimocode.jsonc");
	const mine = result.plan.items.find((item) => item.to.includes("mcpServers.mine"));
	expect(mine?.from).not.toContain("project layer");
});

test("a project config.json is not read, because MiMo Code does not read one", () => {
	// `config/config.ts:847-855` gates the second pass on
	// `dir.endsWith(".mimocode") || dir === MIMOCODE_CONFIG_DIR` and then reads only
	// `["mimocode.json", "mimocode.jsonc"]`. A project's `config.json` is a file
	// MiMo Code ignores, and reading it would import settings that were never in
	// force.
	const { home, cwd } = mimocodeFixture();
	writeUnder(cwd, ".mimocode/config.json", JSON.stringify({ model: "ghost/model" }));
	expect(readMiMoCode(home, cwd, {}).settings).toBeNull();
});

test("objects merge and arrays are leaves, except `instructions`, which unions", () => {
	// `mergeDeep` (remeda, via config/config.ts:54) recurses into objects and
	// replaces everything else; `mergeConfigConcatArrays` (`:52-58`) adds back the
	// one exception, `Array.from(new Set([...target, ...source]))`. The consequence
	// is load-bearing in both directions: a project file can **drop** a global
	// provider or server, and it **adds to** the global instruction list rather than
	// replacing it.
	const merged = mergeMiMoCodeSettings([
		layer("global-config-json", { provider: { a: { npm: "x" }, b: { npm: "y" } }, tools: { bash: true, grep: false } }),
		layer("project", { provider: { a: { npm: "z" } }, tools: { grep: true }, instructions: ["one"] }),
	]);
	expect(merged.settings.provider).toEqual({ a: { npm: "z" }, b: { npm: "y" } });
	// A deep merge, so the untouched sibling survives: `bash` is in neither the
	// second layer nor out of the first.
	expect(merged.settings.tools).toEqual({ bash: true, grep: true });
	const union = mergeMiMoCodeSettings([
		layer("global-mimocode-json", { instructions: ["a", "b"] }),
		layer("project", { instructions: ["b", "c"] }),
	]);
	expect(union.settings.instructions).toEqual(["a", "b", "c"]);
});

test("a file JSON.parse refuses is read anyway, and the report says why", () => {
	// **Every MiMo Code settings file is JSONC** — `ConfigParse.jsonc` runs
	// `jsonc-parser` with `allowTrailingComma: true` (config/parse.ts:9) — so a
	// comment and a trailing comma are both legal in a file called `config.json`.
	// Here the recovery is not a superset of the product's the way it is for Qoder:
	// anything `parseJsonc` reads, MiMo Code reads too.
	const { home, cwd, config } = mimocodeFixture();
	writeUnder(config, "config.json", '{\n\t// the mode I picked\n\t"permission": { "bash": "deny" },\n}\n');
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.settings?.permission).toEqual({ bash: "deny" });
	expect(raw.skipped.some((entry) => entry.reason.includes("JSONC"))).toBe(true);
	// And a genuinely damaged file is named by *what* is wrong, never by the
	// parser's message — `ConfigParse.jsonc`'s own error dumps the entire file
	// (config/parse.ts:36).
	writeUnder(config, "config.json", '{"permission": {');
	const broken = readMiMoCode(home, cwd, {});
	expect(broken.settings).toBeNull();
	expect(broken.skipped.some((entry) => entry.reason.includes("not parseable as JSON or JSONC"))).toBe(true);
	expect(JSON.stringify(broken.skipped)).not.toContain("position");
});

test("the five legacy keys are reported as unread rather than as unmapped", () => {
	// `normalizeLoadedConfig` (config/config.ts:61-75) deletes `history`,
	// `auto_worktree` and the legacy `theme`/`keybinds`/`tui` from every document
	// **before** `Info` — which is `.strict()` (config.ts:500) — validates it. So a
	// user who wrote `theme` is looking at a key *nothing* reads, including MiMo
	// Code itself. Reporting it as an "unhandled key" would be a weaker sentence
	// about the same fact.
	expect(MIMOCODE_LEGACY_KEYS).toEqual(["history", "auto_worktree", "theme", "keybinds", "tui"]);
	// **`keybinds` is in this list and is not a credential**, which is a real false
	// positive rather than a hypothetical one: `looksLikeSecretName` matches `KEY` as
	// a substring, so an unguarded scrub deletes the key and then reports having
	// deleted a credential the user never wrote. The reader exempts the five.
	const { home, cwd } = mimocodeFixture({ global: { theme: "dark", keybinds: { a: "b" }, unrelated: 1 } });
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.legacyKeys.map((one) => one.key).sort()).toEqual(["keybinds", "theme"]);
	expect(JSON.stringify(raw.skipped)).not.toContain("looks like a credential");

	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const theme = result.plan.items.find((item) => item.from.endsWith("theme"));
	expect(theme?.detail).toContain("no longer read by anything, including MiMo Code itself");
	expect(theme?.detail).toContain(".strict()");
	// …and it is not *also* named as a key with no mapping, which would be two
	// sentences saying the same thing in different words.
	expect(JSON.stringify(result.plan.items)).not.toContain("theme, keybinds");
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test("no header value, no environment value and no oauth secret reaches the plan", () => {
	const secretHeader = "sk-header-VALUE";
	const secretEnv = "sk-env-VALUE";
	const secretOAuth = "sk-oauth-VALUE";
	const { home, cwd } = mimocodeFixture({
		global: {
			mcp: {
				demo: {
					type: "local",
					command: ["npx", "-y", "demo"],
					environment: { DEMO_TOKEN: secretEnv, DEMO_HOME: "/tmp" },
					headers: { "x-team": secretHeader, authorization: secretOAuth },
					oauth: { clientId: "id", clientSecret: secretOAuth },
				},
			},
		},
	});
	// The reader drops `headers` *values*? No — it drops credential-shaped **keys**,
	// and `authorization` is the one word `looksLikeSecretName` misses, which is why
	// `MIMOCODE_SECRET_KEY` exists. So the reader removes that key outright.
	const raw = readMiMoCode(home, cwd, {});
	expect(JSON.stringify(raw.mcpServers)).not.toContain(secretEnv);
	expect(JSON.stringify(raw.mcpServers)).not.toContain(secretOAuth);
	expect(raw.skipped.some((entry) => entry.name.endsWith("headers.authorization"))).toBe(true);
	expect(raw.skipped.some((entry) => entry.name.endsWith("oauth.clientSecret"))).toBe(true);

	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const plan = JSON.stringify(result.plan);
	for (const secret of [secretHeader, secretEnv, secretOAuth]) expect(plan).not.toContain(secret);
	// The names survive, and so does the reason the values did not.
	expect(plan).toContain("x-team");
	expect(plan).toContain("DEMO_HOME");
	expect(plan).toContain("looks like a credential — name only, value never read");
	const item = result.plan.items.find((one) => one.to.includes("mcpServers.demo"));
	expect(item?.action).toBe("downgrade");
	expect(item?.containsSecret).toBe(false);
	// And the written file holds the parts with no credential in them.
	const write = result.plan.writes.find((one) => one.kind === "mcp");
	expect(JSON.parse(write?.content ?? "{}").mcpServers.demo).toEqual({
		type: "stdio",
		command: "npx",
		args: ["-y", "demo"],
	});
});

test("a server named like a credential survives, because the name is not a credential", () => {
	// **The bug this guards is a plausible-looking one.** MiMo Code's own redaction
	// list (`config/mcp.ts:82`) is matched with `includes` (`mcp.ts:91-93`), so it
	// flags a server *named* `keyboard-mcp`, a path `monkey` and a header
	// `x-team-keynote`. That list is for *values*; applied to keys it deletes the
	// user's own servers. `MIMOCODE_ENTRY_MAP_KEYS` is what keeps it from happening.
	expect(MIMOCODE_ENTRY_MAP_KEYS.has("mcp")).toBe(true);
	const { home, cwd } = mimocodeFixture({
		global: {
			mcp: {
				"keyboard-mcp": { type: "local", command: ["kb-mcp"] },
				monkey: { type: "local", command: ["monkey-mcp"] },
			},
			provider: { "x-key": { options: { apiKey: "sk-value" } } },
		},
	});
	const raw = readMiMoCode(home, cwd, {});
	expect(Object.keys(raw.mcpServers).sort()).toEqual(["keyboard-mcp", "monkey"]);
	// The provider entry survives by name — it is a name the user chose — and its
	// `options.apiKey` is what goes, because `options` is the slot and `apiKey` is
	// under it.
	expect(JSON.stringify(raw.settings?.provider)).not.toContain("sk-value");
	expect(raw.skipped.some((entry) => entry.name.endsWith("provider.x-key.options.apiKey"))).toBe(true);

	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((one) => one.kind === "mcp")?.content ?? "{}").mcpServers;
	expect(Object.keys(written).sort()).toEqual(["keyboard-mcp", "monkey"]);
	expect(JSON.stringify(result.plan)).not.toContain("sk-value");
});

test("a URL that carries a credential is not carried across, and a clean one still is", () => {
	// The one credential channel no name-based scan can see: the token is not under
	// a secret-shaped *key*, it is inside the single string every importer treats as
	// a safe identifier. MiMo Code validates `Remote.url` as a bare `Schema.String`
	// with no format (config/mcp.ts:52), so `https://user:token@host/mcp` passes.
	// **The shared `urlCredentialProblem` guard is what decides this**, not a
	// second implementation written for this source.
	const userinfoPassword = "sk-url-pass-VALUE";
	const queryToken = "sk-url-token-VALUE";
	const { home, cwd } = mimocodeFixture({
		global: {
			mcp: {
				withUserinfo: { type: "remote", url: `https://alice:${userinfoPassword}@mcp.example.invalid/sse` },
				withQuery: { type: "remote", url: `https://mcp.example.invalid/mcp?access_token=${queryToken}` },
				clean: { type: "remote", url: "https://mcp.example.invalid/mcp" },
			},
		},
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const plan = JSON.stringify(result.plan);
	for (const secret of [userinfoPassword, queryToken]) expect(plan).not.toContain(secret);

	// The check is per-entry, not a gate on the whole file, so one credential
	// cannot cost a user the server beside it.
	const written = JSON.parse(result.plan.writes.find((one) => one.kind === "mcp")?.content ?? "{}").mcpServers;
	expect(written.clean).toEqual({ type: "http", url: "https://mcp.example.invalid/mcp" });
	expect(written.withUserinfo).toBeUndefined();
	expect(written.withQuery).toBeUndefined();

	for (const name of ["withUserinfo", "withQuery"]) {
		const item = result.plan.items.find((one) => one.from.includes(`mcp.${name}`));
		expect(item?.action).toBe("skip");
		// Nothing was written, and the flag says so honestly anyway: the value this
		// line is about *was* a credential.
		expect(item?.containsSecret).toBe(true);
	}
	expect(plan).toContain("it carries a `name:password@` part in front of the address");
	expect(plan).toContain("one of its `?`/`#` parameter names is a credential word");
});

test("the credential files and tables are named and never opened", () => {
	// `auth.json` holds every provider key and OAuth refresh token in the install
	// (`auth/index.ts:9`, written 0o600 at `:96-98`); the `account` table holds
	// `access_token` and `refresh_token`; `session_share` holds a `secret` that is
	// the bearer half of a share link.
	const { home, cwd, data } = mimocodeFixture({ files: { "data/auth.json": '{"x":{"key":"sk-secret"}}' } });
	writeUnder(data, "mcp-auth.json", "{}");
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.credentials.filter((one) => one.exists).map((one) => one.path)).toEqual([
		join(data, "auth.json"),
		join(data, "mcp-auth.json"),
	]);

	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(JSON.stringify(result.plan)).not.toContain("sk-secret");
	const authLine = result.plan.items.find((item) => item.from.includes("auth.json"));
	expect(authLine?.detail).toContain("not opened");
	expect(authLine?.detail).toContain("sign in again here");
	expect(JSON.stringify(result.plan)).toContain("access_token");
	expect(JSON.stringify(result.plan)).toContain("session_share");
});

// ---------------------------------------------------------------------------
// MCP shapes MiMo Code's own schema decides
// ---------------------------------------------------------------------------

test("`command` is an ARRAY, and reading it as a string would drop the executable", () => {
	// `Local.command` is `Schema.mutable(Schema.Array(Schema.String))`
	// (config/mcp.ts:18-20). A reader expecting `command` plus an `args` key reads
	// `undefined` here and either drops the server or writes an empty command.
	expect(
		runMigrationLengthOfFirstServer(
			mimocodeFixture({ global: { mcp: { demo: { type: "local", command: ["npx", "-y", "demo"] } } } }),
		),
	).toEqual({ type: "stdio", command: "npx", args: ["-y", "demo"] });
	// A bare string is not the schema and the product would refuse the file.
	expect(
		runMigrationItems(mimocodeFixture({ global: { mcp: { bad: { type: "local", command: "npx" } } } })).join(" "),
	).toContain("not a non-empty array of strings");
	// And a one-element array is a command with no arguments — `args` is absent,
	// not `[]`, so the schema's own shape is reproduced.
	expect(
		runMigrationLengthOfFirstServer(
			mimocodeFixture({ global: { mcp: { solo: { type: "local", command: ["kb-mcp"] } } } }),
		),
	).toEqual({ type: "stdio", command: "kb-mcp" });
});

test("a `{env:VAR}` placeholder is refused rather than written, and never substituted", () => {
	// MiMo Code expands `{env:VAR}` and `{file:path}` into the config text *before*
	// parsing it (config/variable.ts:32-45). Substituting here would freeze an
	// environment lookup into a literal — and this build expands neither, so the
	// argv written would be a literal MiMo Code never ran.
	const { home, cwd } = mimocodeFixture({
		global: { mcp: { demo: { type: "local", command: ["npx", "{env:MY_TOKEN}"] } } },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(result.plan.writes.some((one) => one.kind === "mcp")).toBe(false);
	const item = result.plan.items.find((one) => one.from.includes("mcp.demo"));
	expect(item?.from).toContain("{env:MY_TOKEN}");
	expect(item?.detail).toContain("expands neither");
});

test("an entry whose type is neither `local` nor `remote` is refused, with the product's reason", () => {
	// `ConfigMCP.Info` is a discriminated union on `type` over exactly those two
	// (`config/mcp.ts:70-72`). Choosing one for a third value would be choosing for
	// MiMo Code.
	const { home, cwd } = mimocodeFixture({
		global: { mcp: { weird: { type: "http", url: "https://example.invalid" } } },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(result.plan.writes.some((one) => one.kind === "mcp")).toBe(false);
	expect(JSON.stringify(result.plan.items)).toContain("not `local` or `remote`");
});

test("the legacy disable-only form is recognised as what it is", () => {
	// `{enabled: false}` works in MiMo Code only because the config merge is deep,
	// so a project's `{enabled: false}` folds into a server the global file defined.
	// Read alone it looks like a server with nothing to run.
	const { home, cwd } = mimocodeFixture({
		global: { mcp: { demo: { type: "local", command: ["kb-mcp"] } } },
		project: { mcp: { demo: { enabled: false } } },
	});
	// With a deep merge the two fold into one entry, which is the real shape.
	const folded = readMiMoCode(home, cwd, {});
	expect(folded.mcpServers.demo).toEqual({ type: "local", command: ["kb-mcp"], enabled: false });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(result.plan.writes.some((one) => one.kind === "mcp")).toBe(false);
	const item = result.plan.items.find((one) => one.from.includes("mcp.demo"));
	expect(item?.detail).toContain("switched off");
});

test("a disable-only entry on its own is named as the deep-merge artifact it is", () => {
	// A global document too, so the home is **present**: `present` asks whether any
	// of the four roots holds something, and a project-only `.mimocode` is not one of
	// them — a MiMo Code with no home is not a MiMo Code install, and that is the
	// same question `detectionRoots` asks.
	const { home, cwd } = mimocodeFixture({ global: {}, project: { mcp: { ghost: { enabled: false } } } });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const item = result.plan.items.find((one) => one.from.includes("mcp.ghost"));
	expect(item?.detail).toContain("legacy disable-only form");
	expect(item?.detail).toContain("config merge is deep");
});

test("`sampling` and `timeout` are reported, and the timeout quote is the code's, not the schema's", () => {
	// **The schema's own description says "Defaults to 5000"** (`config/mcp.ts:28`
	// and `:63`) and the code says `DEFAULT_TIMEOUT = 30_000` (`mcp/index.ts:42`).
	// The comment is stale; the constant runs. The report quotes 30000 and says so,
	// because a reader who finds the schema sentence needs to know which is which.
	const { home, cwd } = mimocodeFixture({
		global: { mcp: { demo: { type: "local", command: ["kb-mcp"], timeout: 5000, sampling: "deny" } } },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const detail = result.plan.items.find((one) => one.to.includes("mcpServers.demo"))?.detail ?? "";
	expect(detail).toContain("30000");
	expect(detail).toContain("schema description says 5000");
	expect(detail).toContain("no field for it");
	expect(detail).toContain("sampling");
});

test("a switched-off server is not imported, because the user turned it off there", () => {
	const { home, cwd } = mimocodeFixture({
		global: { mcp: { off: { type: "local", command: ["kb-mcp"], enabled: false } } },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(result.plan.writes.some((one) => one.kind === "mcp")).toBe(false);
	expect(JSON.stringify(result.plan.items)).toContain("switched off");
});

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

test("the verb table is the nine that map, and `edit` covers the write tools too", () => {
	// `EDIT_TOOLS = ["edit","write","apply_patch","multiedit"]`
	// (`permission/index.ts:614`), so `edit: "deny"` denies writes as well as
	// edits. Mapping it to `Edit` alone would narrow a deny into a hole.
	expect(Object.keys(MIMOCODE_PERMISSION_TOOLS).sort()).toEqual([
		"bash",
		"edit",
		"glob",
		"grep",
		"list",
		"question",
		"read",
		"webfetch",
		"websearch",
	]);
	expect(MIMOCODE_PERMISSION_TOOLS.edit).toEqual(["Edit", "Write"]);
	// Nothing else gets a rule, and each of these names a thing this build either
	// has no tool for or does not mean the same thing by.
	for (const verb of ["task", "actor", "codesearch", "lsp", "doom_loop", "skill", "external_directory", "*"]) {
		expect(MIMOCODE_PERMISSION_TOOLS[verb]).toBeUndefined();
	}
});

test("an allow and a deny both come across, and an ask rule comes across as neither", () => {
	// **There is no ask tier in a rule list here.** Writing an allow for an `ask`
	// rule would run exactly the calls the user meant to be prompted for — the same
	// rule `opencode-plan.ts` keeps, and for the same reason.
	const { home, cwd } = mimocodeFixture({
		global: {
			permission: {
				read: "allow",
				bash: { "git push*": "deny" },
				grep: "ask",
				edit: "deny",
			},
		},
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((one) => one.kind === "settings")?.content ?? "{}");
	expect(written.permissions.allow).toEqual(["Read"]);
	expect(written.permissions.deny.sort()).toEqual(["Bash(git push*)", "Edit", "Write"]);
	const asked = result.plan.items.find((item) => item.detail.includes("would stop and ask"));
	expect(asked?.detail).toContain("no ask tier");
	expect(asked?.detail).toContain("left out of both lists");
});

test('a bare action becomes MiMo Code\'s `"*"` wildcard and is reported, not guessed at', () => {
	// `config/permission.ts:61-63`: `if (typeof x === "string") return { "*": x }`.
	// So `permission: "deny"` is *deny everything*, and the closest thing here would
	// be a rule that changes what every tool can do — a widening a migration must not
	// make on its own judgement.
	const { home, cwd } = mimocodeFixture({ global: { permission: "deny" } });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(result.plan.writes.some((one) => one.kind === "settings")).toBe(false);
	const item = result.plan.items.find((one) => one.detail.includes("deny-everything"));
	expect(item?.detail).toContain("None was guessed at");
});

test("a `~/` pattern is copied verbatim rather than expanded, and the report says why", () => {
	// `expand()` (`permission/index.ts:583-589`) rewrites `~/` and `$HOME/` against
	// `os.homedir()` of the machine that **ran MiMo Code**. Substituting here would
	// write the *importing* machine's home into a rule that meant another one —
	// silently widening a path pattern, in the one direction a permission import
	// must not move on its own.
	const { home, cwd } = mimocodeFixture({
		global: { permission: { read: { "~/secrets/*": "deny" } } },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((one) => one.kind === "settings")?.content ?? "{}");
	expect(written.permissions.deny).toEqual(["Read(~/secrets/*)"]);
	const item = result.plan.items.find((one) => one.detail.includes("rather than expanded"));
	expect(item?.detail).toContain("this machine's home");
	expect(item?.action).toBe("downgrade");
});

test("a later rule wins over an earlier one for the same tool and pattern", () => {
	// `evaluate` uses `findLast` (`permission/evaluate.ts:11-14`) and the config's
	// own `permissionPreprocess` (`config/permission.ts:25-30`) exists purely to
	// preserve the user's key order. `Object.entries` on a `JSON.parse` result *is*
	// that order, so reading the file is enough — a reader that sorted the keys
	// would silently resolve every such pair the other way.
	const merged = mergeMiMoCodeSettings([
		layer("global-mimocode-json", { permission: { bash: { "*": "deny", "git *": "allow" } } }),
	]);
	expect(merged.settings.permission).toEqual({ bash: { "*": "deny", "git *": "allow" } });
	const { home, cwd } = mimocodeFixture({ global: { permission: { bash: { "*": "deny", "git *": "allow" } } } });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((one) => one.kind === "settings")?.content ?? "{}");
	expect(written.permissions.allow).toEqual(["Bash(git *)"]);
	expect(written.permissions.deny).toEqual(["Bash(*)"]);
});

test("a verb with no tool here is named, with the reason each one is absent", () => {
	const { home, cwd } = mimocodeFixture({ global: { permission: { task: "allow", codesearch: "allow" } } });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(result.plan.writes.some((one) => one.kind === "settings")).toBe(false);
	const detail = JSON.stringify(result.plan.items);
	expect(detail).toContain("codesearch");
	expect(detail).toContain("todo list");
});

test("there is no permission mode to claim, and that is the product's shape", () => {
	// MiMo Code's 41-key document has no mode key: `permission` is a rule map whose
	// unmatched default is `ask` (`permission/evaluate.ts:14`). Importing a mode
	// would write a posture the user never stated.
	const { home, cwd } = mimocodeFixture({ global: { permission: { read: "allow" } } });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((one) => one.kind === "settings")?.content ?? "{}");
	expect(written.permissionMode).toBeUndefined();
	expect(written.sandbox).toBeUndefined();
	// No settings write at all when the permission block maps to nothing.
	const none = mimocodeFixture({ global: { permission: { task: "allow" } } });
	const empty = runMigration({
		home: none.home,
		cwd: none.cwd,
		from: "mimocode-code",
		only: ["settings"],
		apply: false,
	});
	expect(empty.plan.writes.some((one) => one.kind === "settings")).toBe(false);
});

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

test("a model is claimed only when the reference resolves against this build", () => {
	const { home, cwd } = mimocodeFixture({ global: { model: "anthropic/claude-sonnet-5" } });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((one) => one.kind === "settings")?.content ?? "{}");
	expect(written.model).toBe("anthropic/claude-sonnet-5");

	const ghost = mimocodeFixture({ global: { model: "no-such-provider/no-such-model" } });
	const refused = runMigration({
		home: ghost.home,
		cwd: ghost.cwd,
		from: "mimocode-code",
		only: ["settings"],
		apply: false,
	});
	expect(refused.plan.writes.some((one) => one.kind === "settings")).toBe(false);
	const item = refused.plan.items.find((one) => one.detail.includes("carries no model by that name"));
	expect(item?.detail).toContain("/model");
});

test("an absent model is nothing claimed and nothing said", () => {
	// Importing the schema's default would be writing a model on the user's behalf
	// that they never stated.
	const { home, cwd } = mimocodeFixture({ global: { permission: { read: "deny" } } });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(result.plan.items.some((item) => item.to.includes("model"))).toBe(false);
});

test("`small_model` and `model_groups` are named rather than mapped onto something else", () => {
	// `small_model` is the model MiMo Code uses for a *smaller job*; this build's
	// `fallbackModels` means "try these when the first fails". Importing one as the
	// other would change what happens on an error rather than reproduce a smaller
	// job.
	const { home, cwd } = mimocodeFixture({
		global: { small_model: "anthropic/claude-haiku-4-5", model_groups: { fast: { a: 1 } } },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((one) => one.kind === "settings")?.content ?? "{}");
	expect(written.fallbackModels).toBeUndefined();
	const small = result.plan.items.find((item) => item.from.includes("small_model"));
	expect(small?.detail).toContain("narrower job");
	expect(result.plan.items.some((item) => item.from.includes("model_groups"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

test("a nested agent keeps its nesting, because MiMo Code's own name keeps it", () => {
	// `configEntryNameFromPath` (`config/entry-name.ts:12-16`) cuts the path at the
	// first search root and strips only the extension, so
	// `agents/team/reviewer.md` is the agent **`team/reviewer`**. Flattening it
	// creates collisions: two teams each with a `reviewer.md` would collapse into
	// one name, one written and one silently dropped.
	expect(mimocodeEntryName("reviewer.md")).toBe("reviewer");
	expect(mimocodeEntryName("team/reviewer.md")).toBe("team/reviewer");
	expect(mimocodeEntryName("a/b/c/agent.md")).toBe("a/b/c/agent");

	const { home, cwd } = mimocodeFixture({
		files: { "config/agents/team/reviewer.md": "---\ndescription: reviews\n---\nbody\n" },
	});
	expect(readMiMoCode(home, cwd, {}).agents.map((one) => one.name)).toEqual(["team/reviewer"]);
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["assets"], apply: false });
	const write = result.plan.writes.find((one) => one.kind === "agent");
	expect(write?.path).toBe(join(home, ".labunbun", "agents", "team", "reviewer.md"));
	expect(write?.content).toContain("body");
});

test("both spellings of every asset directory are live", () => {
	// These are brace expansions, not one current name and one deprecated one, so a
	// user with `skill/` gets their skills read.
	const { home, cwd, config } = mimocodeFixture({
		files: {
			"config/skill/singular/SKILL.md": "---\nname: singular\ndescription: d\n---\n",
			"config/skills/plural/SKILL.md": "---\nname: plural\ndescription: d\n---\n",
			"config/command/one.md": "---\ndescription: d\n---\nbody\n",
			"config/mode/build.md": "---\ndescription: d\n---\nbody\n",
			"config/plugin/thing.ts": "export default {}\n",
		},
	});
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.assets.map((one) => one.name).sort()).toEqual(["plural", "singular"]);
	expect(raw.commands.files.map((one) => one.name)).toEqual(["one"]);
	expect(raw.modes).toEqual(["build"]);
	// A plugin is an imported module, so the *name* is all that comes across.
	expect(raw.plugins).toEqual(["thing.ts"]);
	void config;
});

test("a skill two roots both answer is de-duplicated with the later root winning", () => {
	// `config/config.ts:846-892` folds the asset roots in with `mergeDeep` in
	// `mimocodeReadRoots`'s order, so a later directory overwrites an earlier one's
	// entry of the same name. Qoder's reader keeps the *first* root because Qoder's
	// own precedence is first-wins; copying that reflex here would keep the global
	// copy over the project one MiMo Code would actually have loaded.
	const { home, cwd } = mimocodeFixture({
		files: { "config/skills/shared/SKILL.md": "---\nname: shared\ndescription: global\n---\nglobal\n" },
	});
	writeUnder(cwd, ".mimocode/skills/shared/SKILL.md", "---\nname: shared\ndescription: project\n---\nproject\n");
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.assets).toHaveLength(1);
	expect(raw.assets[0].content).toContain("project");
	expect(raw.assetCollisions).toHaveLength(1);
	expect(raw.assetCollisions[0].name).toBe("shared");

	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["assets"], apply: false });
	expect(result.plan.items.some((item) => item.detail.includes("in both"))).toBe(true);
	expect(result.plan.writes.filter((one) => one.kind === "skill")).toHaveLength(1);
});

test("`.claude/commands` is read and `.claude/agents` is not, because MiMo Code says so", () => {
	// **The asymmetry is verified, not inferred.** `config/paths.ts:41-55` defines
	// `claudeCommandDirectories` and `config/config.ts:844-847` feeds it to
	// `ConfigCommand.load`; there is no `claudeAgentDirectories` and no
	// `ConfigAgent.load` for `~/.claude`. `config/command.ts:47-52`'s name patterns
	// list `.claude`'s two directories and `config/agent.ts:146`'s do not.
	const { home, cwd } = mimocodeFixture({ files: { ".claude/commands/cc.md": "---\ndescription: d\n---\nbody\n" } });
	writeUnder(home, ".claude/agents/cc-agent.md", "---\ndescription: d\n---\nagent body\n");
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.commands.files.map((one) => one.name)).toEqual(["cc"]);
	expect(raw.agents.map((one) => one.name)).not.toContain("cc-agent");
	expect(raw.agents).toHaveLength(0);
});

test("a command becomes a skill, and the report says its frontmatter was rewritten", () => {
	const { home, cwd } = mimocodeFixture({
		files: { "config/commands/deploy.md": "---\ndescription: ship it\nallowed-tools: Bash\n---\nrun $1\n" },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["assets"], apply: false });
	const write = result.plan.writes.find((one) => one.kind === "skill");
	expect(write?.path).toBe(join(home, ".labunbun", "skills", "deploy", "SKILL.md"));
	expect(write?.content).toContain("name: deploy");
	expect(write?.content).toContain("description: ship it");
	expect(write?.content).toContain("run $1");
	const item = result.plan.items.find((one) => one.to.includes("skills/deploy"));
	expect(item?.detail).toContain("frontmatter rewritten");
	expect(item?.detail).toContain("allowed-tools");
});

test("AGENTS.md is imported as a rule file, and a home without one gets no line", () => {
	// Only `AGENTS.md` is read, though `MIMOCODE_INSTRUCTION_FILES` names three:
	// `~/.claude/CLAUDE.md` is **another source's file** (`claude-code` already
	// migrates `~/.claude`) and `CONTEXT.md` is marked `// deprecated` in the
	// product's own comment (`session/instruction.ts:21`).
	expect(MIMOCODE_INSTRUCTION_FILES).toEqual(["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]);

	const withDoc = mimocodeFixture({ files: { "config/AGENTS.md": "# house rules\n\nBe brief.\n" } });
	expect(readMiMoCode(withDoc.home, withDoc.cwd, {}).agentsMd).toBe("# house rules\n\nBe brief.\n");
	const result = runMigration({
		home: withDoc.home,
		cwd: withDoc.cwd,
		from: "mimocode-code",
		only: ["assets"],
		apply: false,
	});
	const write = result.plan.writes.find(
		(one) => one.path === join(withDoc.home, ".labunbun", "rules", "imported-mimocode-agents.md"),
	);
	expect(write?.kind).toBe("rule");
	// Verbatim: a rule file is re-read at the top of every session, so a reformat
	// here would be the importer quietly editing the user's instructions.
	expect(write?.content).toBe("# house rules\n\nBe brief.\n");

	const without = mimocodeFixture({ files: { "data/memory/global/note.md": "remembered\n" } });
	expect(readMiMoCode(without.home, without.cwd, {}).agentsMd).toBeNull();
	const quiet = runMigration({
		home: without.home,
		cwd: without.cwd,
		from: "mimocode-code",
		only: ["assets"],
		apply: false,
	});
	expect(quiet.plan.writes.some((one) => one.path.includes("imported-mimocode-agents"))).toBe(false);
});

test("memory scopes are told apart by name, because one stem would be three documents", () => {
	// `memory/paths.ts:47` matches `/memory/(global|projects|sessions)/<key>.md`, and
	// `:50` gives a `global` entry an **empty** id while the other two carry the
	// project's or the session's. Filing all three under one stem writes two
	// different documents to one path.
	expect(MIMOCODE_MEMORY_SCOPES).toEqual(["global", "projects", "sessions"]);
	expect(mimocodeMemoryPath("/d/memory/global/note.md")).toEqual({ scope: "global", scopeId: "", key: "note" });
	expect(mimocodeMemoryPath("/d/memory/projects/app-a/note.md")).toEqual({
		scope: "projects",
		scopeId: "app-a",
		key: "note",
	});
	expect(mimocodeMemoryPath("/d/memory/sessions/s-1/note.md")).toEqual({
		scope: "sessions",
		scopeId: "s-1",
		key: "note",
	});
	expect(mimocodeMemoryPath("/d/memory/global/deep/nested/note.md")).toEqual({
		scope: "global",
		scopeId: "",
		key: "deep/nested/note",
	});
	expect(mimocodeMemoryPath("/d/elsewhere/note.md")).toBeNull();

	const { home, cwd } = mimocodeFixture({
		files: {
			"data/memory/global/note.md": "global note\n",
			"data/memory/projects/app-a/note.md": "project note\n",
		},
	});
	expect(readMiMoCode(home, cwd, {}).memory).toHaveLength(2);
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["assets"], apply: false });
	const rules = result.plan.writes.filter((one) => one.kind === "rule").map((one) => basename(one.path));
	expect(rules.sort()).toEqual(["imported-mimocode-global-note.md", "imported-mimocode-projects-note.md"]);
	expect(result.plan.items.filter((item) => item.action === "map" && item.to.includes("rules/"))).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// Skills MiMo Code borrows from other tools
// ---------------------------------------------------------------------------

test("the four trees it harvests are named, and the three that are another source's are not imported", () => {
	// `skill/index.ts:26` is `[".claude", ".codex", ".opencode", ".agents"]`, scanned
	// at `<home>/<dir>/skills` (`:232-235`) and at every `<dir>` walking up from the
	// working directory (`:257-261`). **`.agents` is on by default** (`:34-42`) and
	// the other three are off unless a `MIMOCODE_ENABLE_*_SKILLS` variable says
	// otherwise — so a stock install really does see one shared tree and three
	// opt-in ones.
	expect(MIMOCODE_VENDOR_SKILL_DIRS.map((one) => one.dir)).toEqual([".claude", ".codex", ".opencode", ".agents"]);
	expect(MIMOCODE_VENDOR_SKILL_DIRS.map((one) => one.onByDefault)).toEqual([false, false, false, true]);
	expect(MIMOCODE_VENDOR_SKILL_DIRS.find((one) => one.dir === ".agents")).toMatchObject({
		labunbunSource: "agents",
		disableEnv: "MIMOCODE_DISABLE_AGENTS_SKILLS",
		enableEnv: null,
	});

	// `global: {}` so the home is **present**: `present` asks whether any of the four
	// roots holds something, and a home holding only a *borrowed* tree holds nothing
	// of its own. That is a real state, but it is one where `planMigration`'s dispatch
	// gate is closed and these lines would never be written at all.
	const { home, cwd } = mimocodeFixture({ global: {} });
	writeUnder(home, ".agents/skills/shared/SKILL.md", "---\nname: shared\ndescription: d\n---\nagents body\n");
	writeUnder(home, ".claude/skills/cc/SKILL.md", "---\nname: cc\ndescription: d\n---\nclaude body\n");
	writeUnder(cwd, ".codex/skills/cx/SKILL.md", "---\nname: cx\ndescription: d\n---\ncodex body\n");
	writeUnder(home, ".opencode/skills/oc/SKILL.md", "---\nname: oc\ndescription: d\n---\nopencode body\n");

	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["assets"], apply: false });
	// **Not one of the four reached a write.** They are other products' files, and
	// the importer that owns each of them is named in the line instead.
	const written = result.plan.writes
		.filter((one) => one.kind === "skill")
		.map((one) => one.content)
		.join("\n");
	for (const name of ["shared", "cc", "cx", "oc"]) expect(written).not.toContain(name);
	const detail = JSON.stringify(result.plan.items);
	expect(detail).toContain("the shared agent home");
	expect(detail).toContain("already imports it as `agents`");
	expect(detail).toContain("already imports it as `claude-code`");
	expect(detail).toContain("already imports it as `codex`");
	// `.opencode` has no importer here, so its line says "by hand" rather than
	// pointing at a source that will not do it.
	expect(detail).toContain("No source in this repository imports that tree");
	// And each names the variable that turns it on or off, because the sentence
	// "this is another tool's" is only actionable if the user can see the switch.
	expect(detail).toContain("MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS");
	expect(detail).toContain("MIMOCODE_DISABLE_AGENTS_SKILLS");
});

test("a `~/.agents` skill is written exactly once, by the source that owns it", () => {
	borrowEnvForFixture();
	// **The bug this test exists to prevent is a double import that looks clean.**
	// `~/.agents` is a tree this repository already migrates, as its `agents`
	// source, and MiMo Code harvests it for skills by default — so a reader that
	// walked `EXTERNAL_DIRS` would write every one of the user's skills a second
	// time under `mimocode-code`, and *both* report lines would say they were
	// imported. The report is what makes it invisible: nothing in it would say the
	// second copy overwrote the first.
	//
	// The assertion is on the **whole plan across both sources**, because that is
	// the only place the double shows up — each source's own tests are green either
	// way, which is the same blindness the `t3-code` `historySourcePresent` comment
	// records.
	const home = makeDir("lbb-mimocode-home-");
	const cwd = makeDir("lbb-mimocode-proj-");
	const roots = mimocodeRoots(home, {});
	mkdirSync(roots.config, { recursive: true });
	// A MiMo Code home with a skills tree of its own, so the source is present and
	// its planner is actually reached.
	writeUnder(roots.config, "skills/mine/SKILL.md", "---\nname: mine\ndescription: d\n---\nmimocode body\n");
	// The shared tree, which both sources can see.
	writeUnder(home, ".agents/skills/shared/SKILL.md", "---\nname: shared\ndescription: d\n---\nshared body\n");
	writeUnder(home, ".agents/AGENTS.md", "# shared\n");

	const result = runMigration({ home, cwd, from: "all", only: ["assets"], apply: false });
	const shared = result.plan.writes.filter((one) => one.path.endsWith(join("skills", "shared", "SKILL.md")));
	expect(shared).toHaveLength(1);
	expect(shared[0].content).toContain("shared body");
	// And it is attributed to the owner, not to the product that borrowed it.
	const item = result.plan.items.find((one) => one.to.endsWith("skills/shared/SKILL.md"));
	expect(item?.source).toBe("agents");

	// MiMo Code's own skill still comes across — the exemption is for the four
	// borrowed trees, not for skills as a category.
	expect(result.plan.writes.filter((one) => one.path.endsWith(join("skills", "mine", "SKILL.md")))).toHaveLength(1);
	expect(JSON.stringify(result.plan.items)).toContain("is the shared agent home's, not MiMo Code's");
});

// ---------------------------------------------------------------------------
// Named and not carried
// ---------------------------------------------------------------------------

test("the managed-config directories are still named `opencode`, and are named rather than read", () => {
	// `config/managed.ts:23-36` — the rename to MiMo Code did not reach this
	// function, so grepping the tree for `mimocode` misses all three. They are MDM
	// territory: they belong to whoever deployed the machine.
	expect(mimocodeManagedConfigDir("linux", undefined)).toBe("/etc/opencode");
	expect(mimocodeManagedConfigDir("darwin", undefined)).toBe("/Library/Application Support/opencode");
	expect(mimocodeManagedConfigDir("win32", undefined)).toContain("ProgramData");
	expect(mimocodeManagedConfigDir("linux", undefined)).toContain("opencode");

	const { home, cwd } = mimocodeFixture({ global: { plugin: ["./x.ts"] } });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(JSON.stringify(result.plan)).toContain("still named `opencode`");
});

test("a plugin is named and never imported, because it is code the engine runs", () => {
	const { home, cwd } = mimocodeFixture({ files: { "config/plugins/thing.ts": "export default {}\n" } });
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["assets"], apply: false });
	expect(result.plan.writes.every((one) => one.content !== "export default {}\n")).toBe(true);
	const item = result.plan.items.find((one) => one.detail.includes("installed module"));
	expect(item?.detail).toContain("imports at start-up");
	expect(item?.detail).toContain("thing.ts");
});

test("a config-defined agent and a deprecated `mode` are named, with the shape as the reason", () => {
	// The entry carries a `prompt` — the agent's whole system prompt — alongside
	// `model`, `temperature`, `steps`, `permission` and a free-form `options` block
	// (`config/agent.ts:115-125`), and a subagent file here has no field for the
	// last three. `mode` is marked `@deprecated Use \`agent\` field instead` in the
	// product's own schema (`config/config.ts:186`).
	const { home, cwd } = mimocodeFixture({
		global: { agent: { reviewer: { prompt: "you are..." } }, mode: { build: "reviewer" } },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["assets"], apply: false });
	expect(result.plan.writes.some((one) => one.kind === "agent")).toBe(false);
	const detail = JSON.stringify(result.plan.items);
	expect(detail).toContain("reviewer");
	expect(detail).toContain("silently not the one you tuned");
	expect(detail).toContain("is deprecated in MiMo Code's own schema");
});

test("the inline-config channels are named and not read, because they are not files", () => {
	// `MIMOCODE_CONFIG_CONTENT` and `MIMOCODE_CONFIG_DEFAULTS` are inline JSON **in
	// the environment**; `MIMOCODE_AUTH_CONTENT` is still read by
	// `auth/index.ts:76` but `util/credential-env.ts:15` deliberately strips it from
	// every child process's environment.
	const { home, cwd } = mimocodeFixture();
	const env = { MIMOCODE_CONFIG_CONTENT: '{"model":"ghost/model"}', MIMOCODE_AUTH_CONTENT: '{"x":{"key":"sk-x"}}' };
	const items = JSON.stringify(plan(readMiMoCode(home, cwd, env)).items);
	expect(items).toContain("MIMOCODE_CONFIG_CONTENT");
	expect(items).toContain("MIMOCODE_AUTH_CONTENT");
	expect(items).toContain("inline JSON");
	// **Neither the value nor anything derived from it.** A migration that expanded
	// an inline `auth.json` would be copying a live credential out of the
	// environment and into a file it wrote.
	expect(items).not.toContain("ghost/model");
	expect(items).not.toContain("sk-x");
	// And with nothing set there is no line at all.
	expect(JSON.stringify(plan(readMiMoCode(home, cwd, {})).items)).not.toContain("MIMOCODE_CONFIG_CONTENT");
});

test("the database is named, and its channel filename is looked for rather than guessed", () => {
	const home = makeDir("lbb-mimocode-home-");
	const data = mimocodeRoots(home, {}).data;
	mkdirSync(data, { recursive: true });
	// A nightly writes `mimocode-<channel>.db` and the channel is a build-time
	// constant no reader can know, so the data root is listed and matched.
	expect(mimocodeDatabasePath(data, {})).toBeNull();
	writeUnder(data, "mimocode-nightly-20260925.db", "");
	expect(mimocodeChannelDatabaseNames(data)).toEqual([join(data, "mimocode-nightly-20260925.db")]);
	expect(mimocodeDatabasePath(data, {})).toBe(join(data, "mimocode-nightly-20260925.db"));
	// The primary name wins over a channel one, which is the product's own order.
	writeUnder(data, "mimocode.db", "");
	expect(mimocodeDatabasePath(data, {})).toBe(join(data, "mimocode.db"));
	// `$MIMOCODE_DB` wins outright; `:memory:` is not a file at all.
	expect(mimocodeDatabasePath(data, { MIMOCODE_DB: "/elsewhere/mimo.db" })).toBe("/elsewhere/mimo.db");
	expect(mimocodeDatabasePath(data, { MIMOCODE_DB: "other.db" })).toBe(join(data, "other.db"));
	expect(mimocodeDatabasePath(data, { MIMOCODE_DB: ":memory:" })).toBeNull();

	const { home: h2, cwd: c2, data: d2 } = mimocodeFixture();
	writeUnder(d2, "mimocode.db", "");
	const raw = readMiMoCode(h2, c2, {});
	expect(raw.database?.path).toBe(join(d2, "mimocode.db"));
	expect(raw.database?.exists).toBe(true);
	// WAL mode means the sidecars exist, and naming them is how the report can say
	// a MiMo Code is running or crashed mid-write.
	expect(raw.database?.sidecars).toEqual([join(d2, "mimocode.db-wal"), join(d2, "mimocode.db-shm")]);
});

test("a home with no database reports zero rather than staying silent, and history says so", () => {
	// **No database means no sessions, and the report says which** rather than
	// claiming there was nothing to import.
	const { home, cwd } = mimocodeFixture({ global: { permission: { read: "allow" } } });
	expect(listHistory("mimocode-code", home, { cwd, scope: "all" }).candidates).toEqual([]);
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	expect(JSON.stringify(result.plan.items)).toContain("no session database was found");
	// And scope `none` short-circuits before any of this.
	expect(listHistory("mimocode-code", home, { cwd, scope: "none" }).notes).toEqual([]);
});

test("the TUI layer is counted and reported, and `$MIMOCODE_TUI_CONFIG` is named beside it", () => {
	// **"There is a `tui.json` and none of it applies here" is a sentence a user is
	// owed and "nothing was found" is not.** And the override is merged *after*
	// `<config>/tui.json(c)` (`cli/cmd/tui/config/tui.ts:110-115`), so a line about
	// the TUI document describes the wrong file for every key the override sets.
	// **Through the reader and the planner directly, not through `runMigration`.**
	// `runMigration` calls `readSources(home, cwd)`, which calls
	// `readMiMoCode(home, cwd)` with `env` defaulted to `process.env` — so a test
	// that sets the variable only on its fixture would be asserting about the
	// developer's own environment and nothing else. That is the same trap
	// `readMiMoCode`'s own header names, and it is why every fixture here passes an
	// explicit `env` to the *reader*.
	const { home, cwd } = mimocodeFixture({ files: { "config/tui.json": '{"keybinds":{"a":"b"},"theme":"dark"}' } });
	const raw = readMiMoCode(home, cwd, { MIMOCODE_TUI_CONFIG: "/elsewhere/tui.json" });
	expect(raw.tui?.keys).toBe(2);
	expect(raw.tuiConfigEnvPath).toBe("/elsewhere/tui.json");
	const items = JSON.stringify(plan(readMiMoCode(home, cwd, { MIMOCODE_TUI_CONFIG: "/elsewhere/tui.json" })).items);
	expect(items).toContain("TUI configuration");
	expect(items).toContain("$MIMOCODE_TUI_CONFIG");
	// With the variable unset there is no override to name, and saying so would be
	// a line about nothing.
	expect(readMiMoCode(home, cwd, {}).tuiConfigEnvPath).toBeNull();
	// `~/.claude/CLAUDE.md` is named as another source's file.
	expect(items).toContain("another source's file");
	expect(items).toContain("deprecated");
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
	const settings = mimocodeFixture({ global: { permission: { read: "allow" } } });
	const settingsRun = runMigration({
		home: settings.home,
		cwd: settings.cwd,
		from: "mimocode-code",
		only: ["settings"],
		apply: false,
	});
	expect(settingsRun.error).toBeUndefined();
	expect(settingsRun.plan.items.some((item) => item.to === "settings.json → permissions.allow")).toBe(true);

	const assets = mimocodeFixture({
		files: { "config/skills/one/SKILL.md": "---\nname: one\ndescription: d\n---\nbody\n" },
	});
	const assetsRun = runMigration({
		home: assets.home,
		cwd: assets.cwd,
		from: "mimocode-code",
		only: ["assets"],
		apply: false,
	});
	expect(assetsRun.plan.items.filter((item) => item.action === "map").map((item) => item.to)).toContain(
		"~/.labunbun/skills/one/SKILL.md",
	);
});

test("a key with no mapping is named rather than dropped in silence", () => {
	// 41 top-level keys, six of which this planner accounts for. The other 35 are
	// the unhandled-key catch-all's business, and the report says so per **layer**
	// rather than over the merge — the merged document's keys are the union of every
	// file's, so one line over it would name each file's keys against whichever file
	// the user reads first.
	const { home, cwd } = mimocodeFixture({
		global: { snapshot: true, retry: { attempts: 3 }, model: "anthropic/claude-sonnet-5" },
	});
	const result = runMigration({ home, cwd, from: "mimocode-code", only: ["settings"], apply: false });
	// `reportUnhandledKeys` puts the **names** in `from` and only the count in
	// `detail`, so the assertion is on the label — the same convention every report
	// line in this repository follows.
	const unhandled = result.plan.items.find((item) => item.detail.includes("no mapping for and no note about"));
	expect(unhandled?.from).toContain("mimocode.json");
	expect(unhandled?.from).toContain("snapshot");
	expect(unhandled?.from).toContain("retry");
	expect(unhandled?.detail).toContain("2 key(s)");
	// `model` is handled and so must not be named here.
	expect(unhandled?.from).not.toContain("model");
});

test("an unreadable settings document is reported and the rest of the home is still read", () => {
	// Nothing short-circuits: a home with a damaged document still yields its
	// skills, and the failure names the file rather than a fragment of its own text.
	const { home, cwd, config } = mimocodeFixture({
		files: { "config/skills/one/SKILL.md": "---\nname: one\ndescription: d\n---\n" },
	});
	writeUnder(config, "mimocode.json", '{"mcp": {');
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.settings).toBeNull();
	expect(raw.skipped.some((entry) => entry.name.endsWith("mimocode.json"))).toBe(true);
	expect(raw.assets.map((skill) => skill.name)).toEqual(["one"]);
});

test("a home that has never run MiMo Code reads as absent, not as empty", () => {
	const home = makeDir("lbb-mimocode-home-");
	const cwd = makeDir("lbb-mimocode-proj-");
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.present).toBe(false);
	expect(raw.settings).toBeNull();
	expect(raw.settingsLayers).toEqual([]);
	expect(raw.memory).toEqual([]);
	expect(raw.assets).toEqual([]);
	expect(raw.skipped).toEqual([]);
});

test("a directory where a file was expected is its own failure, not an exception", () => {
	// A real case: `<config>` is a directory and a user who made `mimocode.json`
	// one too gets a sentence saying which thing was found.
	const home = makeDir("lbb-mimocode-home-");
	const cwd = makeDir("lbb-mimocode-proj-");
	const roots = mimocodeRoots(home, {});
	mkdirSync(join(roots.config, "mimocode.json"), { recursive: true });
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.settings).toBeNull();
	expect(raw.skipped.some((entry) => entry.reason.includes("a directory where a file was expected"))).toBe(true);
});

test("a missing file is not an error: no settings document, no line about one", () => {
	// Four of the five layer kinds are absent in the ordinary case, and a home that
	// has never written settings is a home that only installed the CLI. Reporting
	// the absence would teach a reader to skip the lines that matter.
	const home = makeDir("lbb-mimocode-home-");
	const cwd = makeDir("lbb-mimocode-proj-");
	mkdirSync(mimocodeRoots(home, {}).config, { recursive: true });
	const raw = readMiMoCode(home, cwd, {});
	expect(raw.settings).toBeNull();
	expect(raw.skipped).toEqual([]);
});

test("the planner is pure: the same read twice plans the same thing", () => {
	// Planning takes no clock, no cwd and no environment of its own, so a plan is a
	// function of what was read. A reader that reached for any of the three would
	// make this fail for reasons unrelated to the mapping.
	const fixture = mimocodeFixture({
		global: { mcp: { demo: { type: "local", command: ["npx"] } }, permission: { read: "allow" } },
	});
	const raw = readMiMoCode(fixture.home, fixture.cwd, {});
	const first = plan(raw);
	const second = plan(raw);
	expect(JSON.stringify(first)).toBe(JSON.stringify(second));
});

/** Run the planner over a fixture with no claim callbacks that record anything. */
function plan(raw: ReturnType<typeof readMiMoCode>): { items: unknown[]; writes: unknown[] } {
	const items: unknown[] = [];
	const writes: unknown[] = [];
	planMiMoCode(
		raw,
		items as never[],
		writes as never[],
		(_source, key, value, from) => items.push({ claimed: key, value, from }),
		(_source, behavior, rules, from) => items.push({ added: behavior, rules, from }),
		{},
		() => {},
		{},
		false,
	);
	return { items, writes };
}

/** The first MCP server the plan would write, or `undefined`. */
function runMigrationLengthOfFirstServer(fixture: MiMoCodeFixture): unknown {
	const result = runMigration({
		home: fixture.home,
		cwd: fixture.cwd,
		from: "mimocode-code",
		only: ["settings"],
		apply: false,
	});
	const write = result.plan.writes.find((one) => one.kind === "mcp");
	const servers = JSON.parse(write?.content ?? "{}").mcpServers ?? {};
	return Object.values(servers)[0];
}

/** Every report line the plan produced, as one string, for `toContain`. */
function runMigrationItems(fixture: MiMoCodeFixture): string[] {
	return runMigration({
		home: fixture.home,
		cwd: fixture.cwd,
		from: "mimocode-code",
		only: ["settings"],
		apply: false,
	}).plan.items.map((item) => item.detail);
}
