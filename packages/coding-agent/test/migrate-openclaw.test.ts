/**
 * The `openclaw` source, from the five path resolvers through to the report.
 *
 * **What this file is for.** OpenClaw is the only source here whose *roots*
 * disagree with each other — five resolvers compute overlapping paths and no two
 * agree — so most of what follows is about the difference between "the directory
 * exists" and "this is the directory the product is running":
 *
 *   - **`.openclaw` is not the answer for two of the three ways this source
 *     installs itself.** The state resolver falls back to the pre-rename
 *     `~/.clawdbot`, and a named profile moves the tree to `~/.openclaw-<name>`.
 *     A detector or reader that looked only at `.openclaw` would report "no
 *     OpenClaw" for an upgraded install whose entire history lives in `.clawdbot`.
 *   - **The state directory and the configuration directory are different paths on
 *     a real install**, because `resolveConfigDir` honours `OPENCLAW_CONFIG_PATH`
 *     and has no `.clawdbot` fallback while `resolveStateDir` has the opposite.
 *   - **`$include` is the layering mechanism.** Reading `openclaw.json` and
 *     stopping imports a document the product is not running; the merge semantics
 *     are specific (arrays concatenate, objects recurse, primitives take the
 *     source) and getting the primitive direction backwards inverts every
 *     override the user wrote.
 *   - **Nothing carries a credential**, and the sharpest case is a URL: OpenClaw
 *     validates `mcp.servers[].url` only as http/https, so a credential inside the
 *     address is invisible to any key-name scan and cannot be dropped while
 *     keeping the server.
 *   - **The transcript is *not* Claude Code's reader.** Its events are
 *     `type: "message"` with the role on the payload, where `readClaudeCodeSession`
 *     switches on `type`. That test is the one that matters most here, so it is
 *     the first test in the history half.
 *
 * Every fixture is a temporary directory. Nothing here reads a real install, a
 * real credential path, or anything under a user's home: `readOpenClaw` takes
 * `home`, `cwd` and `env` as arguments and never calls `homedir()`, and every
 * call below passes an explicit `env` so a developer's own `OPENCLAW_STATE_DIR`
 * cannot leak in.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration } from "../src/migrate.ts";
import { listHistory, readHistory } from "../src/migrate-history.ts";
import { detectSources, MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS, SOURCE_ROOTS } from "../src/migrate-types.ts";
import {
	OPENCLAW_BOOTSTRAP_FILENAMES,
	OPENCLAW_DEFAULT_DIR,
	OPENCLAW_LEGACY_DIR,
	OPENCLAW_PROFILE_NAME_RE,
	openclawAgentDir,
	openclawConfigCandidates,
	openclawConfigDir,
	openclawConfigPath,
	openclawProfile,
	openclawProfileDir,
	openclawProfileRejection,
	openclawSkillDirs,
	openclawStateDir,
	openclawStateRoots,
} from "../src/openclaw-home.ts";
import { readOpenClaw } from "../src/openclaw-read.ts";
import { hasCompressedEvents, readOpenClawEvents } from "../src/openclaw-session.ts";

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

interface OpenClawFixture {
	home: string;
	cwd: string;
}

/**
 * A home and a **separate** workspace directory, with whichever documents the
 * caller asked for.
 *
 * Two roots on purpose: OpenClaw's bootstrap documents live in the *workspace*
 * and its settings in the *state directory*, so a fixture that put both under one
 * directory could not tell a path bug from a document bug.
 */
function openClawFixture(
	options: { config?: unknown; agentSettings?: unknown; files?: Record<string, string> } = {},
): OpenClawFixture {
	const home = makeDir("lbb-openclaw-home-");
	const cwd = makeDir("lbb-openclaw-ws-");
	if (options.config !== undefined) {
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, JSON.stringify(options.config));
	}
	if (options.agentSettings !== undefined) {
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/agents/main/agent/settings.json`, JSON.stringify(options.agentSettings));
	}
	for (const [relative, content] of Object.entries(options.files ?? {})) {
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/${relative}`, content);
	}
	return { home, cwd };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("it is registered, and appended rather than slotted in", () => {
	// **Not on the end, and that is the rule rather than a failure.** Other sources
	// are appended after this one, so the assertion is "OpenClaw holds the place it
	// was given and the ids before it are untouched", by index — not "OpenClaw is
	// the newest", which is a claim about the registry's history that every later
	// source would have to rewrite. This is the same correction
	// `migrate-antigravity.test.ts` and `migrate-qoder.test.ts` made for themselves.
	expect(MIGRATION_SOURCE_LABELS.openclaw).toBe("OpenClaw");
	expect(SOURCE_ROOTS.openclaw).toBe(".openclaw");
	expect(MIGRATION_SOURCE_IDS).toContain("openclaw");
	// Appended after the fourteen that predate it, and before nothing it disturbs.
	expect(MIGRATION_SOURCE_IDS.indexOf("claude-code")).toBe(0);
	expect(MIGRATION_SOURCE_IDS.indexOf("antigravity")).toBe(13);
	expect(MIGRATION_SOURCE_IDS.indexOf("openclaw")).toBeGreaterThan(13);
	expect(new Set(Object.keys(MIGRATION_SOURCE_LABELS))).toEqual(new Set(MIGRATION_SOURCE_IDS));
	expect(new Set(Object.keys(SOURCE_ROOTS))).toEqual(new Set(MIGRATION_SOURCE_IDS));
});

test("a home with an OpenClaw tree is detected, and one without is not", () => {
	const home = makeDir("lbb-openclaw-home-");
	expect(detectSources(home)).not.toContain("openclaw");
	writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, "{}");
	expect(detectSources(home)).toContain("openclaw");
});

// ---------------------------------------------------------------------------
// The five path resolvers
// ---------------------------------------------------------------------------

describe("the roots", () => {
	test("$OPENCLAW_STATE_DIR wins outright, and it is not verbatim", () => {
		// The product runs it through `resolveHomeRelativePath`
		// (`src/config/state-dir.ts:27`), so a leading `~` is expanded rather than
		// treated as a literal directory named `~`.
		const home = makeDir("lbb-openclaw-home-");
		const env = { OPENCLAW_STATE_DIR: join(home, "elsewhere") };
		expect(openclawStateDir(home, env)).toBe(join(home, "elsewhere"));
		expect(openclawStateDir(home, { OPENCLAW_STATE_DIR: "  " })).toBe(join(home, OPENCLAW_DEFAULT_DIR));
	});

	test("`.clawdbot` is the fallback, so an upgraded install is not reported absent", () => {
		// `resolveStateDirFromHome` (`state-dir.ts:33-43`): `.openclaw` wins if it
		// exists, `.clawdbot` is used only when it exists and `.openclaw` does not.
		const home = makeDir("lbb-openclaw-home-");
		// Neither exists: the answer is `.openclaw` anyway, because a first run
		// creates it there.
		expect(openclawStateDir(home, {})).toBe(join(home, OPENCLAW_DEFAULT_DIR));
		mkdirSync(join(home, OPENCLAW_LEGACY_DIR), { recursive: true });
		expect(openclawStateDir(home, {})).toBe(join(home, OPENCLAW_LEGACY_DIR));
		mkdirSync(join(home, OPENCLAW_DEFAULT_DIR), { recursive: true });
		expect(openclawStateDir(home, {})).toBe(join(home, OPENCLAW_DEFAULT_DIR));
	});

	test("detectionRoots holds all three spellings, so a `.clawdbot` home is detected", () => {
		// The failure this guards: a detector that looked only at `.openclaw` would
		// say "no OpenClaw" for a user who upgraded from the pre-rename build, whose
		// entire history lives in `.clawdbot`.
		const home = makeDir("lbb-openclaw-home-");
		const roots = openclawStateRoots(home, {});
		expect(roots).toContain(join(home, OPENCLAW_DEFAULT_DIR));
		expect(roots).toContain(join(home, OPENCLAW_LEGACY_DIR));
	});

	test("a named profile is a fourth root, and `default` is not a suffix", () => {
		// `resolveProfileStateDir` (`cli/profile-utils.ts:35-37`) returns
		// `~/.openclaw` for the profile named `default`, which is why a
		// default-profile install and a no-profile install share one tree.
		const home = makeDir("lbb-openclaw-home-");
		expect(openclawProfileDir(home, "default")).toBe(join(home, OPENCLAW_DEFAULT_DIR));
		expect(openclawProfileDir(home, "work")).toBe(join(home, `${OPENCLAW_DEFAULT_DIR}-work`));
		const roots = openclawStateRoots(home, { OPENCLAW_PROFILE: "work" });
		expect(roots).toContain(join(home, `${OPENCLAW_DEFAULT_DIR}-work`));
		// And the state dir itself *is* the profile root, so `sourceRoot` agrees.
		expect(openclawStateDir(home, { OPENCLAW_PROFILE: "work" })).toBe(join(home, `${OPENCLAW_DEFAULT_DIR}-work`));
	});

	test("an invalid profile name is a distinct answer from no profile", () => {
		// The product **throws** on a name it rejects (`profile-utils.ts:31-33`) rather
		// than falling back, so an invalid one names a configuration OpenClaw would
		// refuse to start with — not a home with no profile.
		expect(openclawProfile({})).toBeNull();
		expect(openclawProfileRejection({})).toBeNull();
		expect(openclawProfile({ OPENCLAW_PROFILE: "default" })).toBeNull();
		expect(openclawProfile({ OPENCLAW_PROFILE: "work" })).toBe("work");
		expect(openclawProfile({ OPENCLAW_PROFILE: "bad name!" })).toBeNull();
		expect(openclawProfileRejection({ OPENCLAW_PROFILE: "bad name!" })).toBe("invalid");
	});

	test("the profile name rule is the product's, at its own bound", () => {
		// `/^[a-z0-9][a-z0-9_-]{0,63}$/i` (`profile-utils.ts:5`): 1 to 64 characters,
		// starting with a letter or digit. **A dot is not in the class**, which is easy
		// to get wrong from a neighbouring tool's rule — `my.profile` is rejected.
		expect(OPENCLAW_PROFILE_NAME_RE.test("a")).toBe(true);
		expect(OPENCLAW_PROFILE_NAME_RE.test("my_profile-1")).toBe(true);
		expect(OPENCLAW_PROFILE_NAME_RE.test("a".repeat(64))).toBe(true);
		expect(OPENCLAW_PROFILE_NAME_RE.test("a".repeat(65))).toBe(false);
		expect(OPENCLAW_PROFILE_NAME_RE.test("-leading")).toBe(false);
		expect(OPENCLAW_PROFILE_NAME_RE.test("has space")).toBe(false);
		expect(OPENCLAW_PROFILE_NAME_RE.test("my.profile")).toBe(false);
	});

	test("the config directory takes $OPENCLAW_CONFIG_PATH only when no state dir is set", () => {
		// `resolveConfigDir` (`infra/config-dir.ts:7-20`) checks `OPENCLAW_STATE_DIR`
		// **first**, then `OPENCLAW_CONFIG_PATH`, then `.openclaw`. So the precedence
		// between the two variables is the opposite of what "config path overrides
		// state dir" suggests — and `resolveStateDir` honours only the first of them,
		// so with both set the two resolvers agree rather than disagree. The
		// disagreement between them is the `.clawdbot` fallback, which only the state
		// resolver has; see the next test.
		const home = makeDir("lbb-openclaw-home-");
		const elsewhere = join(home, "cfg");
		expect(openclawConfigDir(home, { OPENCLAW_CONFIG_PATH: join(elsewhere, "custom.json") })).toBe(elsewhere);
		const env = { OPENCLAW_STATE_DIR: join(home, "state"), OPENCLAW_CONFIG_PATH: join(elsewhere, "custom.json") };
		expect(openclawStateDir(home, env)).toBe(join(home, "state"));
		expect(openclawConfigDir(home, env)).toBe(join(home, "state"));
	});

	test("`openclaw.json` is tried before the legacy `clawdbot.json`, not after", () => {
		// `configPathsInStateDir` (`paths.ts:38-40`) is
		// `[CONFIG_FILENAME, ...LEGACY_CONFIG_FILENAMES]` and `findExistingConfigPath`
		// takes the first that exists (`paths.ts:42-44`). An importer that tried the
		// legacy name first would import a document the product is not running.
		const home = makeDir("lbb-openclaw-home-");
		writeUnder(home, `${OPENCLAW_LEGACY_DIR}/clawdbot.json`, "{}");
		writeUnder(home, `${OPENCLAW_LEGACY_DIR}/openclaw.json`, "{}");
		expect(openclawConfigPath(home, {})).toBe(join(home, OPENCLAW_LEGACY_DIR, "openclaw.json"));
		const candidates = openclawConfigCandidates(home, {});
		expect(candidates.indexOf(join(home, OPENCLAW_LEGACY_DIR, "openclaw.json"))).toBeLessThan(
			candidates.indexOf(join(home, OPENCLAW_LEGACY_DIR, "clawdbot.json")),
		);
	});

	test("the agent directory is a config key and takes no environment override", () => {
		// `agents[].agentDir` wins outright and is resolved through `resolveUserPath`;
		// otherwise the tree is `<stateDir>/agents/<id>/agent`
		// (`agent-scope-config.ts:578-589`, where `:577` states the rule: per-agent
		// paths stay independent of process-wide install overrides).
		// `OPENCLAW_AGENT_DIR` is a real process-wide variable the product reads
		// elsewhere (`shared-main-dir.ts:8`, `install-agent-dir.ts:43`,
		// `agent-store-source.ts:108`), but per-agent resolution does not read it —
		// and this test exercises the per-agent resolution.
		//
		// A real temp directory rather than `/state`, because the configured arm runs
		// the value through `resolve()` — on Windows `resolve("/elsewhere")` is a
		// drive-rooted path, and a POSIX literal here would assert the wrong thing.
		const home = makeDir("lbb-openclaw-home-");
		const elsewhere = join(home, "elsewhere");
		expect(openclawAgentDir(home, "main")).toBe(join(home, "agents", "main", "agent"));
		expect(openclawAgentDir(home, "main", elsewhere)).toBe(elsewhere);
		expect(openclawAgentDir(home, "main", "  ")).toBe(join(home, "agents", "main", "agent"));
	});

	test("skills come from two roots and the managed one comes first", () => {
		expect(openclawSkillDirs("/cfg")).toEqual([join("/cfg", "skills"), join("/cfg", "plugin-skills")]);
	});

	test("`TOOLS.md` is not among the six bootstrap documents", () => {
		// `DEFAULT_TOOLS_FILENAME` *is* declared (`workspace-bootstrap-policy.ts:12`)
		// and is a real file on many workspaces, but it is not in
		// `WORKSPACE_BOOTSTRAP_FILENAMES` (`:29-37`) and `openclaw doctor --fix`
		// folds it into `AGENTS.md` (`doctor-tools-md-migration.ts:142,464`).
		// Importing it would resurrect a document the product is retiring.
		expect(OPENCLAW_BOOTSTRAP_FILENAMES).toEqual([
			"AGENTS.md",
			"SOUL.md",
			"IDENTITY.md",
			"USER.md",
			"BOOTSTRAP.md",
			"MEMORY.md",
		]);
		expect(OPENCLAW_BOOTSTRAP_FILENAMES).not.toContain("TOOLS.md");
	});
});

// ---------------------------------------------------------------------------
// Reading the configuration
// ---------------------------------------------------------------------------

describe("the configuration document", () => {
	test("a JSON5 document is read tolerantly and never written back", () => {
		// Strict JSON first, JSON5 second (`utils/parse-json-compat.ts:48-55`), and
		// OpenClaw **strips JSON5 comments on write** (`config/json5-comments.ts:24-34`)
		// — which is why this is a reader and not a rewriter.
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, '{\n  // a comment\n  "theme": "dark",\n}\n');
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.settings?.theme).toBe("dark");
		expect(raw.skipped.some((entry) => entry.reason.includes("JSON5"))).toBe(true);
	});

	test("a `//` inside a string is not a comment", () => {
		// The part a naive comment-stripper gets wrong, and the reason this is
		// hand-written: a URL in a config value contains `//` and stripping to
		// end-of-line would truncate the document.
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, '{"gateway": {"url": "https://example.test/mcp"}}');
		const raw = readOpenClaw(home, cwd, {});
		expect((raw.settings?.gateway as Record<string, unknown>)?.url).toBe("https://example.test/mcp");
	});

	test("an absent document is null and says nothing about itself, which is not a failure", () => {
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.settings).toBeNull();
		// Scoped to this document rather than the whole list: a workspace with no
		// `AGENTS.md` *does* earn a line, and asserting `[]` here would be asserting
		// that the workspace half of the reader is silent too.
		expect(raw.skipped.filter((entry) => entry.name.includes("openclaw.json"))).toEqual([]);
	});

	test("a document that is not an object says which of the two reasons applies", () => {
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, "[1, 2, 3]");
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.settings).toBeNull();
		expect(raw.skipped.some((entry) => entry.reason.includes("not a JSON object"))).toBe(true);
	});

	test("46 top-level keys is the shape, and the reader does not guess at them", () => {
		// `types.openclaw.ts:42-144` declares this many. The count is here because a
		// reader that silently grew a 47th would import a document the product does
		// not have, and one that shrank would drop a key the product reads.
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		const config = {
			audit: {},
			$schema: "x",
			meta: {},
			auth: {},
			accessGroups: {},
			acp: {},
			env: {},
			wizard: {},
			diagnostics: {},
			logging: {},
			security: {},
			update: {},
			telemetry: {},
			browser: {},
			ui: {},
			secrets: {},
			skills: {},
			plugins: {},
			surfaces: {},
			models: {},
			nodeHost: {},
			agents: {},
			worktreeRoot: "x",
			worktreeAcceleration: true,
			tools: {},
			bindings: [],
			broadcast: {},
			attachments: {},
			messages: {},
			tts: {},
			commands: {},
			approvals: {},
			session: {},
			channels: {},
			cron: {},
			transcripts: {},
			hooks: {},
			discovery: {},
			talk: {},
			gateway: {},
			cloudWorkers: {},
			storage: {},
			desktop: {},
			memory: {},
			mcp: {},
			proxy: {},
		};
		expect(Object.keys(config)).toHaveLength(46);
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, JSON.stringify(config));
		const raw = readOpenClaw(home, cwd, {});
		// **One of the forty-six does not come back, and the drop is a decision.**
		// `secrets` is removed by the credential scrub — `looksLikeSecretName`
		// matches `SECRET` inside it — because this build has nowhere to put
		// OpenClaw's own secret-provider configuration. `env` *does* survive: it
		// recurses rather than being dropped whole, so `env.shellEnv` is kept and only
		// the credential-bearing parts go. Asserting the exact survivor set is what
		// catches a reader that quietly drops a forty-seventh or keeps one of these.
		const read = Object.keys(raw.settings ?? {}).sort();
		expect(read).toEqual(
			Object.keys(config)
				.filter((key) => key !== "secrets")
				.sort(),
		);
		expect(raw.envNames).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// `$include`
// ---------------------------------------------------------------------------

describe("`$include`", () => {
	test("an included document is merged, and the file list says so", () => {
		// **An importer that reads `openclaw.json` without resolving `$include`
		// imports a document the product is not running** (`includes.ts:25`).
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, '{"$include": "shared.json", "theme": "dark"}');
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/shared.json`, '{"model": "shared-model"}');
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.settings?.theme).toBe("dark");
		expect(raw.settings?.model).toBe("shared-model");
		expect(raw.includeFiles).toHaveLength(2);
	});

	test("an include path is relative to the *including file's* directory", () => {
		// `includes.ts:415-418`. An include written as `./shared.json` beside
		// `agents/dev.json` resolves to `<dir-of-dev.json>/shared.json` — getting
		// this backwards against the root config's directory is the second thing an
		// importer gets wrong here.
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, '{"$include": "agents/dev.json"}');
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/agents/dev.json`, '{"$include": "shared.json"}');
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/agents/shared.json`, '{"model": "from-agents-dir"}');
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.settings?.model).toBe("from-agents-dir");
	});

	test("arrays concatenate, objects merge, and the *including* file's own key wins", () => {
		// **The direction is the whole test, and it is the opposite of the obvious
		// reading.** `includes.ts:368` returns `deepMerge(included, rest)`, so the
		// including document's own keys are the merge *source* and primitives take
		// the source (`:204-207`). A key written in `openclaw.json` therefore beats
		// the same key in an included file — get this backwards and every override
		// the user wrote in the file they actually edited is inverted.
		//
		// The array order falls out of the same call: `deepMerge` concatenates
		// `[...target, ...source]` (`:205-206`), and the target is the *included*
		// file — so the shared entries come first and the root's own after.
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		writeUnder(
			home,
			`${OPENCLAW_DEFAULT_DIR}/openclaw.json`,
			'{"$include": "shared.json", "theme": "dark", "tools": {"web": true}, "list": [1]}',
		);
		writeUnder(
			home,
			`${OPENCLAW_DEFAULT_DIR}/shared.json`,
			'{"theme": "light", "tools": {"shell": true}, "list": [2]}',
		);
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.settings?.theme).toBe("dark");
		expect(raw.settings?.tools).toEqual({ shell: true, web: true });
		expect(raw.settings?.list).toEqual([2, 1]);
	});

	test("an array of includes is applied in order, and a later one wins over an earlier", () => {
		// `entries.reduce((current, entry) => deepMerge(current, entry.value), {})`
		// (`includes.ts:336`) makes each **later** entry the merge source, so `b`
		// overrides `a`. The root's own key still wins over both — the same rule one
		// level down, and the reason a user can always override an included default.
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, '{"$include": ["a.json", "b.json"], "theme": "dark"}');
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/a.json`, '{"from": "a"}');
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/b.json`, '{"from": "b", "theme": "b-theme"}');
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.settings?.from).toBe("b");
		expect(raw.settings?.theme).toBe("dark");
	});

	test("a missing include is a named gap, not a silent thin document", () => {
		// The product isolates a malformed branch rather than failing the whole read
		// (`resolveConfigIncludesForTopLevelKey`, `includes.ts:637-646`), so a home
		// whose include is broken still reports the keys it has — and this says which
		// are missing.
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, '{"$include": "gone.json", "theme": "dark"}');
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.settings?.theme).toBe("dark");
		expect(raw.includeFailures).toHaveLength(1);
		expect(raw.includeFailures[0]?.reason).toContain("not on disk");
		expect(raw.skipped.some((entry) => entry.reason.includes("$include could not be applied"))).toBe(true);
	});

	test("a cycle is stopped and named rather than followed", () => {
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, '{"$include": "a.json"}');
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/a.json`, '{"$include": "b.json"}');
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/b.json`, '{"$include": "a.json"}');
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.includeFailures.some((entry) => entry.reason.includes("already included"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("credentials", () => {
	test("a server `url` carrying a credential is not migrated, and the report says why", () => {
		// **The same hole found in Qoder and then fixed across all fourteen existing
		// sources.** OpenClaw validates a server URL only as http/https
		// (`zod-schema.mcp-server.ts:26`), so `https://user:token@host/mcp` is a
		// working server to the product with the credential inside a string every
		// key-name scan treats as a safe identifier. Unlike a header or an env var
		// there is no way to drop the credential and keep the address.
		const { home, cwd } = openClawFixture({
			config: { mcp: { servers: { remote: { url: "https://user:token@example.test/mcp" } } } },
		});
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		expect(result.error).toBeUndefined();
		const line = result.plan.items.find((item) => item.from.includes("mcp.servers.remote"));
		expect(line?.action).toBe("skip");
		expect(line?.containsSecret).toBe(true);
		expect(line?.detail).toContain("credential");
		// The credential itself is never printed — the reason names the shape.
		expect(line?.detail).not.toContain("token@example.test");
		const write = result.plan.writes.find((one) => one.kind === "mcp");
		expect(write?.content ?? "").not.toContain("token@example.test");
	});

	test("a credential in a URL parameter is caught too", () => {
		const { home, cwd } = openClawFixture({
			config: { mcp: { servers: { remote: { url: "https://example.test/mcp?access_token=abc" } } } },
		});
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		const line = result.plan.items.find((item) => item.from.includes("mcp.servers.remote"));
		expect(line?.action).toBe("skip");
		expect(line?.containsSecret).toBe(true);
	});

	test("`env` and `headers` values are dropped and their names reported", () => {
		// Both are registered sensitive by the product's own schema
		// (`zod-schema.mcp-server.ts:20-24,33-37`) — every value, whatever it is called.
		const { home, cwd } = openClawFixture({
			config: {
				mcp: {
					servers: {
						local: {
							command: "srv",
							args: [],
							env: { MY_TOKEN: "s3cret", PLAIN: "v" },
							headers: { authorization: "Bearer x" },
						},
					},
				},
			},
		});
		const raw = readOpenClaw(home, cwd, {});
		expect(JSON.stringify(raw.mcpServers)).not.toContain("s3cret");
		expect(JSON.stringify(raw.mcpServers)).not.toContain("Bearer x");
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		const line = result.plan.items.find((item) => item.from.includes("mcp.servers.local"));
		expect(line?.action).toBe("downgrade");
		expect(line?.detail).toContain("MY_TOKEN");
		expect(line?.detail).toContain("authorization");
		expect(line?.containsSecret).toBe(false);
	});

	test("a server the user *named* like a credential is kept", () => {
		// The distinction `scrubQoderCredentials` exists to draw: `env.API_TOKEN` is a
		// slot and `mcpServers.keyboard-mcp` is the name of a thing the user created.
		// Deleting the latter deletes their server.
		const { home, cwd } = openClawFixture({
			config: { mcp: { servers: { "keyboard-mcp": { command: "srv", args: [] } } } },
		});
		const raw = readOpenClaw(home, cwd, {});
		expect(Object.keys(raw.mcpServers)).toEqual(["keyboard-mcp"]);
	});

	test("a configuration carrying a retired MCP key is refused whole, and the key is named", () => {
		// **A file carrying one does not load at all** — nine top-level keys plus the
		// nested one (`zod-schema.mcp-server.ts:77-113`). Importing the surviving
		// servers would report a healthy install where the product refuses to start,
		// and the user would have no idea which key to remove.
		const { home, cwd } = openClawFixture({
			config: {
				mcp: { servers: { a: { command: "srv", args: [] }, b: { url: "https://example.test/mcp", timeout: 5 } } },
			},
		});
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.retiredMcpKeys).toEqual(["timeout"]);
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		const line = result.plan.items.find((item) => item.detail.includes("nothing was imported"));
		expect(line?.action).toBe("skip");
		expect(line?.detail).toContain("timeout");
		// Neither server was copied.
		const write = result.plan.writes.find((one) => one.kind === "mcp");
		expect(write?.content ?? "").not.toContain('"a"');
		expect(write?.content ?? "").not.toContain('"b"');
	});

	test("every one of the nine rejected keys is detected, and the nested one too", () => {
		const rejected = [
			"connectTimeout",
			"connect_timeout",
			"timeout",
			"workingDirectory",
			"supports_parallel_tool_calls",
			"ssl_verify",
			"client_cert",
			"client_key",
			"disabled",
		];
		for (const key of rejected) {
			const { home, cwd } = openClawFixture({ config: { mcp: { servers: { s: { [key]: "x" } } } } });
			expect(readOpenClaw(home, cwd, {}).retiredMcpKeys).toEqual([key]);
		}
		const { home, cwd } = openClawFixture({
			config: { mcp: { servers: { s: { codex: { default_tools_approval_mode: "auto" } } } } },
		});
		expect(readOpenClaw(home, cwd, {}).retiredMcpKeys).toEqual(["codex.default_tools_approval_mode"]);
	});

	test("`env.vars` names are reported and their values never come across", () => {
		// **The finding that outlives the migration.** OpenClaw's own provider key
		// list (`src/infra/dotenv.ts:43,61,62,76`) includes `KIMI_API_KEY`,
		// `KIMICODE_API_KEY`, `OPENCODE_API_KEY` and `DEEPSEEK_API_KEY`, so an `env`
		// block is a place *other tools'* credentials live. An importer that dumped it
		// into this build's settings would hand one tool's key to another file.
		const { home, cwd } = openClawFixture({
			config: { env: { vars: { KIMI_API_KEY: "kk", MY_OWN: "mm" } } },
		});
		const raw = readOpenClaw(home, cwd, {});
		expect(JSON.stringify(raw.settings)).not.toContain("kk");
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		const line = result.plan.items.find((item) => item.detail.includes("KIMI_API_KEY"));
		expect(line?.action).toBe("skip");
		expect(line?.detail).toContain("dotenv.ts");
		expect(line?.detail).not.toContain("kk");
	});

	test("`models.providers.<id>.apiKey` is dropped whether it is a literal or a reference", () => {
		// `types.models.ts:64` types it `SecretInput` — a literal *or* a
		// `SecretRef` — and `memory.search.remote.apiKey` is its sibling.
		const { home, cwd } = openClawFixture({
			config: {
				models: { providers: { x: { apiKey: "literal", baseUrl: "https://api.test" } } },
				memory: { search: { remote: { apiKey: "another" } } },
			},
		});
		const raw = readOpenClaw(home, cwd, {});
		const serialized = JSON.stringify(raw.settings);
		expect(serialized).not.toContain("literal");
		expect(serialized).not.toContain("another");
		expect(serialized).toContain("api.test");
	});
});

// ---------------------------------------------------------------------------
// Settings, MCP and permissions through the pipeline
// ---------------------------------------------------------------------------

describe("the plan", () => {
	test("a stdio server is copied and an HTTP one keeps its address", () => {
		const { home, cwd } = openClawFixture({
			config: {
				mcp: {
					servers: {
						local: { command: "srv", args: ["--x"], cwd: "/w" },
						remote: { url: "https://example.test/mcp", transport: "streamable-http" },
					},
				},
			},
		});
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		const write = result.plan.writes.find((one) => one.kind === "mcp");
		const written = JSON.parse(write?.content ?? "{}").mcpServers;
		expect(written.local).toEqual({ type: "stdio", command: "srv", args: ["--x"], cwd: "/w" });
		expect(written.remote).toEqual({ type: "http", url: "https://example.test/mcp" });
	});

	test("`enabled: false` is not imported, because the user turned it off", () => {
		const { home, cwd } = openClawFixture({
			config: { mcp: { servers: { off: { command: "srv", args: [], enabled: false } } } },
		});
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		const line = result.plan.items.find((item) => item.from.includes("mcp.servers.off"));
		expect(line?.action).toBe("skip");
		expect(line?.detail).toContain("switched off");
	});

	test("a permission mode is claimed by name, and `default` claims nothing", () => {
		// **`default` maps to nothing** because it is the schema's absence rather than
		// a choice; importing it would write a posture the user's file never stated.
		const bypass = openClawFixture({ config: { agents: { defaults: { permissionMode: "bypassPermissions" } } } });
		const bypassed = runMigration({
			home: bypass.home,
			cwd: bypass.cwd,
			from: "openclaw",
			only: ["settings"],
			apply: false,
		});
		// `bypassPermissions` is the one value doing two jobs — never ask *and* no
		// confinement — so both halves are claimed together. Looking for the pair in
		// the claim itself is what catches a change that claims only one.
		expect(
			bypassed.plan.items.some(
				(item) =>
					item.source === "openclaw" && item.to !== "—" && item.detail.includes("no confirmation and no confinement"),
			),
		).toBe(true);
		const schemaDefault = openClawFixture({ config: { agents: { defaults: { permissionMode: "default" } } } });
		const plan = runMigration({
			home: schemaDefault.home,
			cwd: schemaDefault.cwd,
			from: "openclaw",
			only: ["settings"],
			apply: false,
		});
		expect(plan.plan.items.some((item) => item.detail.includes("schema's own default"))).toBe(true);
	});

	test("a mode this build has no word for is skipped, not guessed at", () => {
		const { home, cwd } = openClawFixture({ config: { agents: { defaults: { permissionMode: "yoloish" } } } });
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		const line = result.plan.items.find((item) => item.from.includes("permissionMode"));
		expect(line?.action).toBe("skip");
		expect(line?.detail).toContain("must not widen");
	});

	test("the two settings documents are both read, and a model in either is named", () => {
		// **A user's model, theme and thinking level may live in
		// `<agentDir>/settings.json` and not in `openclaw.json`** — reading only the
		// first reports "no model set" for a user who set one.
		const inAgent = openClawFixture({ agentSettings: { defaultModel: "anthropic/claude-opus-4" } });
		const agentPlan = runMigration({
			home: inAgent.home,
			cwd: inAgent.cwd,
			from: "openclaw",
			only: ["settings"],
			apply: false,
		});
		expect(agentPlan.plan.items.some((item) => item.detail.includes("a model is named"))).toBe(true);
		const inConfig = openClawFixture({ config: { agents: { defaults: { model: "x/y" } } } });
		const configPlan = runMigration({
			home: inConfig.home,
			cwd: inConfig.cwd,
			from: "openclaw",
			only: ["settings"],
			apply: false,
		});
		expect(configPlan.plan.items.some((item) => item.detail.includes("a model is named"))).toBe(true);
	});

	test("a retired agent-settings key is reported and that document is not used", () => {
		// Four checks, two of which are not top-level names — `skills` is rejected
		// **as an object** and `retry.maxDelayMs` is nested. Reporting either as a
		// top-level key would be a finding the user cannot act on.
		const { home, cwd } = openClawFixture({ agentSettings: { queueMode: "all", skills: { customDirectories: [] } } });
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.retiredAgentSettingKeys).toEqual(["queueMode", "skills (as an object)"]);
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		expect(result.plan.items.some((item) => item.detail.includes("does not load at all"))).toBe(true);
	});

	test("`AGENTS.md` is imported from the workspace and the other five are named", () => {
		// A configuration file as well, because `present` is "a resolved root exists" —
		// a fixture with no OpenClaw document at all plans nothing, which would make
		// this test read as "AGENTS.md is never imported" when it is the fixture.
		const { home, cwd } = openClawFixture({ config: {} });
		writeUnder(cwd, "AGENTS.md", "always be careful\n");
		writeUnder(cwd, "SOUL.md", "a persona\n");
		const result = runMigration({ home, cwd, from: "openclaw", only: ["assets"], apply: false });
		const rule = result.plan.writes.find((one) => one.kind === "rule");
		expect(rule?.content).toBe("always be careful\n");
		const named = result.plan.items.find((item) => item.detail.includes("SOUL.md"));
		expect(named?.detail).toContain("IDENTITY.md");
		expect(named?.detail).toContain('not "we did not look"');
	});

	test("a `MEMORY.md` that is a symlink is not counted as present", () => {
		// The product requires a real file and not a symlink
		// (`root-memory-files.ts:41-52`), so `statSync` — which follows the link —
		// would report a case the product refuses as one it accepts.
		const { home, cwd } = openClawFixture();
		writeUnder(cwd, "real.md", "x\n");
		symlinkSync(join(cwd, "real.md"), join(cwd, "MEMORY.md"));
		const raw = readOpenClaw(home, cwd, {});
		expect(raw.otherBootstrapDocs.find((doc) => doc.name === "MEMORY.md")?.present).toBe(false);
	});

	test("the macOS Keychain and OpenClaw's own importer are both named", () => {
		const { home, cwd } = openClawFixture({ config: {} });
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		const keychain = result.plan.items.find((item) => item.from === "macOS Keychain");
		expect(keychain?.detail).toContain("Codex Auth");
		expect(keychain?.detail).toContain("Claude Code-credentials");
		const own = result.plan.items.find((item) => item.from === "openclaw migrate");
		expect(own?.detail).toContain("migrate-claude");
		expect(own?.detail).toContain("migrate-hermes");
	});

	test("the two disagreeing roots are named when they disagree", () => {
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-ws-");
		// A `.clawdbot`-only install: the state directory is `.clawdbot` while the
		// config directory is `.openclaw` (`state-dir.ts:33-43` against
		// `infra/config-dir.ts:7-20`).
		writeUnder(home, `${OPENCLAW_LEGACY_DIR}/openclaw.json`, "{}");
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		expect(result.plan.items.some((item) => item.detail.includes("different paths on this machine"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Build an agent store the way the product writes one. */
function makeAgentDb(
	home: string,
	rows: Array<{ sessionId: string; cwd: string; events: unknown[] }>,
	sessionCwd: string,
): string {
	const dbPath = join(home, OPENCLAW_DEFAULT_DIR, "agents", "main", "agent", "openclaw-agent.sqlite");
	// Every row records `sessionCwd`, a directory this test created. `narrowCandidates`
	// drops a candidate whose working directory no longer exists, so a `/w` literal
	// would test that filter rather than the reader.
	for (const row of rows) row.cwd = sessionCwd;
	mkdirSync(join(dbPath, ".."), { recursive: true });
	const db = new Database(dbPath, { create: true });
	db.run(
		"create table session_windows (session_id text primary key, session_key text not null, spawned_by text, status text, display_name text, created_at integer not null, updated_at integer not null)",
	);
	db.run(
		"create table transcript_events (session_id text not null, seq integer not null, event_json text not null, created_at integer not null, primary key (session_id, seq))",
	);
	for (const row of rows) {
		// `display_name` is null, as it is on a session the user never named — so
		// the title has to come from the first user turn, which is the path worth
		// testing. A session that *does* carry a label uses it instead.
		db.run("insert into session_windows values (?, ?, null, null, ?, 1, 1)", [
			row.sessionId,
			`agent:main:${row.sessionId}`,
			null,
		]);
		row.events.forEach((event, index) => {
			db.run("insert into transcript_events values (?, ?, ?, 1)", [row.sessionId, index, JSON.stringify(event)]);
		});
	}
	db.close();
	return dbPath;
}

/** The header event the product writes unconditionally (`transcript-header.ts:18-27`). */
function header(cwd: string): Record<string, unknown> {
	return { type: "session", version: 4, id: "s", timestamp: "2026-09-01T00:00:00.000Z", cwd };
}

describe("history", () => {
	test("a session is listed with the working directory from its transcript header", () => {
		// **The cwd is not in the schema.** Neither `session_windows` nor
		// `session_nodes` has a working-directory column; it is in the header event.
		const home = makeDir("lbb-openclaw-home-");
		const sessionCwd = makeDir("lbb-openclaw-proj-");
		makeAgentDb(
			home,
			[
				{
					sessionId: "s1",
					cwd: sessionCwd,
					events: [
						header(sessionCwd),
						{
							type: "message",
							id: "m1",
							parentId: null,
							timestamp: "2026-09-01T00:00:01.000Z",
							message: { role: "user", content: [{ type: "text", text: "hello there" }] },
						},
					],
				},
			],
			sessionCwd,
		);
		const listing = listHistory("openclaw", home, { cwd: sessionCwd, scope: "all" });
		expect(listing.candidates).toHaveLength(1);
		// The value comes from the transcript **header**, and it is the directory this
		// test created — not the state directory and not a guess.
		expect(listing.candidates[0]?.cwd).toBe(sessionCwd);
		expect(listing.candidates[0]?.title).toBe("hello there");
	});

	test("the transcript is read — `claude-session.ts`'s reader is not reused and cannot be", () => {
		// **The load-bearing test for this source.** `readClaudeCodeSession`
		// (`migrate-history.ts:674-716`) switches on `type === "user" | "assistant"`.
		// OpenClaw's events are `type: "message"` with the role on the *payload*
		// (`session-accessor.sqlite-transcript-message-append.ts:89-95,255-262`), so
		// every line would fail that test, be counted as a "non-conversation entry",
		// and the session would import **zero messages while the report claimed the
		// file was read**.
		const home = makeDir("lbb-openclaw-home-");
		const sessionCwd = makeDir("lbb-openclaw-proj-");
		makeAgentDb(
			home,
			[
				{
					sessionId: "s1",
					cwd: sessionCwd,
					events: [
						header(sessionCwd),
						{
							type: "message",
							id: "m1",
							parentId: null,
							timestamp: "2026-09-01T00:00:01.000Z",
							message: { role: "user", content: [{ type: "text", text: "what is 2+2" }] },
						},
						{
							type: "message",
							id: "m2",
							parentId: "m1",
							timestamp: "2026-09-01T00:00:02.000Z",
							message: {
								role: "assistant",
								model: "claude-opus-4",
								usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
								stopReason: "toolUse",
								content: [
									{ type: "text", text: "Let me check" },
									{ type: "thinking", thinking: "arithmetic" },
									{ type: "toolCall", id: "t1", name: "calc", arguments: { expr: "2+2" } },
								],
							},
						},
						{
							type: "message",
							id: "m3",
							parentId: "m2",
							timestamp: "2026-09-01T00:00:03.000Z",
							message: {
								role: "toolResult",
								toolCallId: "t1",
								toolName: "calc",
								isError: false,
								content: [{ type: "text", text: "4" }],
							},
						},
					],
				},
			],
			sessionCwd,
		);
		const listing = listHistory("openclaw", home, { cwd: sessionCwd, scope: "all" });
		const read = readHistory("openclaw", home, listing.candidates);
		expect(read.sessions).toHaveLength(1);
		const entries = read.sessions[0]?.entries ?? [];
		// Three messages: the user turn, the assistant turn, the tool result. **The
		// header event is not a message**, so a reader that treated it as one would
		// report four.
		expect(entries).toHaveLength(3);
		const roles = entries.map((entry) => (entry.kind === "message" ? entry.message.role : null));
		expect(roles).toEqual(["user", "assistant", "toolResult"]);
		// `toolResult` is a first-class role here, not a block inside a user turn —
		// which is the second reason the Claude reader cannot be reused.
		expect(roles).toContain("toolResult");
	});

	test("the tool call keeps its arguments, which are an object and not a string", () => {
		const home = makeDir("lbb-openclaw-home-");
		const sessionCwd = makeDir("lbb-openclaw-proj-");
		makeAgentDb(
			home,
			[
				{
					sessionId: "s1",
					cwd: sessionCwd,
					events: [
						header(sessionCwd),
						{
							type: "message",
							id: "m1",
							parentId: null,
							timestamp: "2026-09-01T00:00:01.000Z",
							message: { role: "user", content: [{ type: "text", text: "go" }] },
						},
						{
							type: "message",
							id: "m2",
							parentId: "m1",
							timestamp: "2026-09-01T00:00:02.000Z",
							message: {
								role: "assistant",
								model: "m",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
								stopReason: "toolUse",
								content: [{ type: "toolCall", id: "t1", name: "calc", arguments: { expr: "2+2" } }],
							},
						},
						{
							type: "message",
							id: "m3",
							parentId: "m2",
							timestamp: "2026-09-01T00:00:03.000Z",
							message: {
								role: "toolResult",
								toolCallId: "t1",
								toolName: "calc",
								isError: false,
								content: [{ type: "text", text: "4" }],
							},
						},
					],
				},
			],
			sessionCwd,
		);
		const listing = listHistory("openclaw", home, { cwd: sessionCwd, scope: "all" });
		const read = readHistory("openclaw", home, listing.candidates);
		const assistant = read.sessions[0]?.entries.find(
			(entry) => entry.kind === "message" && entry.message.role === "assistant",
		);
		const call =
			assistant?.kind === "message" && assistant.message.role === "assistant"
				? assistant.message.content.find((block) => block.type === "toolCall")
				: undefined;
		expect(call?.type === "toolCall" ? JSON.parse(call.arguments) : null).toEqual({ expr: "2+2" });
	});

	test("an event stored as zstd is read, and the release that lacks the column is handled", () => {
		// **Which column is populated is asked, not assumed.** The current schema
		// makes `event_json` and `event_zstd` mutually exclusive with a `CHECK`
		// (`openclaw-agent-schema.sql:566-585`); the released 2026.9.2 / 2026.9.3
		// fixtures have **no `event_zstd` column at all** (agent schema 19), so the
		// column itself is probed through `sqlite_master`.
		const home = makeDir("lbb-openclaw-home-");
		const plain = makeAgentDb(
			home,
			[{ sessionId: "s1", cwd: "", events: [header("/w")] }],
			makeDir("lbb-openclaw-proj-"),
		);
		expect(hasCompressedEvents(plain)).toBe(false);
		expect(readOpenClawEvents(plain, "s1")[0]?.json.type).toBe("session");

		// The same store with the compressed column present and a zstd payload.
		const zstdHome = makeDir("lbb-openclaw-home-");
		const dbPath = join(zstdHome, OPENCLAW_DEFAULT_DIR, "agents", "main", "agent", "openclaw-agent.sqlite");
		mkdirSync(join(dbPath, ".."), { recursive: true });
		const db = new Database(dbPath, { create: true });
		db.run(
			"create table session_windows (session_id text primary key, session_key text not null, spawned_by text, status text, display_name text, created_at integer not null, updated_at integer not null)",
		);
		db.run(
			"create table transcript_events (session_id text not null, seq integer not null, event_json text, created_at integer not null, event_zstd blob, event_utf8_bytes integer)",
		);
		db.run("insert into session_windows values ('s1', 'agent:main:s1', null, null, 'x', 1, 1)");
		const payload = JSON.stringify({
			type: "session",
			version: 4,
			id: "s1",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: "/w",
		});
		db.run("insert into transcript_events values ('s1', 0, null, 1, ?, ?)", [
			Bun.zstdCompressSync(Buffer.from(payload)),
			payload.length,
		]);
		db.close();
		expect(hasCompressedEvents(dbPath)).toBe(true);
		// **A reader that only took the text column would report this session as
		// empty**, which is the truncated-history-as-the-whole-history failure.
		const events = readOpenClawEvents(dbPath, "s1");
		expect(events).toHaveLength(1);
		expect(events[0]?.compressed).toBe(true);
		expect(events[0]?.json.type).toBe("session");
	});

	test("the recall list says OpenClaw keeps none, and why", () => {
		const home = makeDir("lbb-openclaw-home-");
		const result = runMigration({ home, cwd: home, from: "openclaw", only: ["history"], apply: false });
		expect(result.error).toBeUndefined();
	});

	test("the shared `~/.agents` tree is named, and imported exactly once — by `agents`", () => {
		// **The test the addendum asked for, and it is the whole point.** OpenClaw
		// loads `~/.agents/skills` as part of its own skill plan
		// (`src/agents/sessions/package-manager.ts:873`), and this build already has a
		// source that owns `~/.agents` — the `agents` source. A run over both sources
		// must yield **exactly one** write for that skill, attributed to `agents`.
		// **Two writes is the bug**: identical bytes written twice, the second
		// attributed to OpenClaw, and a report that looks clean.
		//
		// Note the direction of the assertion: it counts *writes* rather than checking
		// that OpenClaw skipped something, because "OpenClaw correctly skipped it" and
		// "`agents` wrote it" are the same fact and only the count is the guarantee.
		const home = makeDir("lbb-openclaw-home-");
		const cwd = makeDir("lbb-openclaw-proj-");
		// The shared tree, written in the shape both sources would read.
		writeUnder(home, ".agents/skills/shared-one/SKILL.md", "---\nname: shared-one\n---\n\nshared body\n");
		// An OpenClaw tree as well, so both sources are actually present.
		writeUnder(home, `${OPENCLAW_DEFAULT_DIR}/openclaw.json`, JSON.stringify({}));

		const result = runMigration({
			home,
			cwd,
			from: "all",
			only: ["assets"],
			apply: false,
		});
		expect(result.error).toBeUndefined();
		// `writes[].path` is a raw `join`, so it is a backslash path on Windows —
		// normalising before the substring test is what makes this assertion mean the
		// same thing on every platform.
		const sharedWrites = result.plan.writes.filter((one) =>
			one.path.replace(/\\/g, "/").includes("shared-one/SKILL.md"),
		);
		expect(sharedWrites).toHaveLength(1);
		expect(sharedWrites[0]?.content).toContain("shared body");
		// And OpenClaw names the tree rather than staying silent about it.
		expect(
			result.plan.items.some(
				(item) => item.source === "openclaw" && item.detail.includes("the **shared** skill tree, not read"),
			),
		).toBe(true);
	});

	test("`hooks.presets` is named, not merged with `tools.profile`", () => {
		// The product composes these itself (`mergeHookPresets(baseConfig.hooks?.presets,
		// "gmail")`, `src/hooks/gmail-ops.ts:197`) rather than storing hook entries
		// under them. `normalizeClaudeHooks` would read `presets` as an *event* name
		// and drop it, so without this line the preset vanishes with no report.
		const { home, cwd } = openClawFixture({
			config: { hooks: { presets: ["gmail"], Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } },
		});
		const result = runMigration({ home, cwd, from: "openclaw", only: ["settings"], apply: false });
		const line = result.plan.items.find(
			(item) => item.detail.includes("hooks.presets") || item.detail.includes("gmail"),
		);
		expect(line?.detail).toContain("gmail-ops.ts:197");
		expect(line?.detail).toContain("nothing to merge with `tools.profile`");
	});

	test("a missing store is absent, not a crash", () => {
		const home = makeDir("lbb-openclaw-home-");
		expect(listHistory("openclaw", home, { cwd: home, scope: "all" })).toEqual({ candidates: [], notes: [] });
		expect(readHistory("openclaw", home, [])).toEqual({ sessions: [], notes: [] });
	});
});

// ---------------------------------------------------------------------------
// Hermeticity
// ---------------------------------------------------------------------------

test("the reader takes its environment as an argument and reads no real one", () => {
	// The reason this test exists rather than the reason the parameter does: a
	// reader that called `homedir()` or reached for `process.env` itself would make
	// every other test in this file depend on the machine it runs on, which is the
	// failure `source-env.ts`'s own header describes at length.
	const { home, cwd } = openClawFixture({ config: { theme: "dark" } });
	const raw = readOpenClaw(home, cwd, {});
	expect(raw.env).toEqual({});
	expect(raw.settings?.theme).toBe("dark");
});
