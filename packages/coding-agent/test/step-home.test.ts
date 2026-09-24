/**
 * Where Step Code keeps its tree, as one rule the readers share.
 *
 * Step resolves its root through `step/environment.ts` (`resolveStepHomeDir`,
 * `resolveStepConfigDir`, `resolveStepAgentDir`, `resolveStepConfigRoot`,
 * `resolveStepSessionDir`), and a file the migrator cannot find is a file the
 * user is told does not exist. These tests pin the rule itself rather than any
 * one call site, because the settings reader and the history importer asking two
 * different questions of the same environment is how a migration imports the
 * settings of one tree and the sessions of another.
 *
 * Three of Step's own behaviours are surprising enough to be pinned by name:
 * the config root is the agent directory's *parent*, a blank variable is unset
 * while a padded one is a directory name, and Step spells the agent directory
 * two ways — verbatim for sessions and tilde-expanded for assets.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	STEPCODE_DEFAULT_DIR,
	STEPCODE_LEGACY_DIR,
	stepAgentDir,
	stepAssetDir,
	stepConfigDirName,
	stepConfigRoot,
	stepLegacyRoot,
	stepRoot,
	stepSessionsDir,
	stepSessionsRoot,
} from "../src/step-home.ts";

/** Temp homes, swept with the test that made them. */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

/** Borrow one environment variable for the rest of the test. */
function setEnv(name: string, value: string | undefined): void {
	if (!borrowed.has(name)) borrowed.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** A throwaway home to resolve against. */
function freshHome(): string {
	const home = mkdtempSync(join(tmpdir(), "lbb-stepcode-home-"));
	roots.push(home);
	return home;
}

/** Put a file where it makes its directory count as a populated tree. */
function seed(dir: string, file = "config.toml"): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), 'theme = "dark"\n', "utf8");
}

/** Every variable that moves this tree, unset, for tests that want the defaults. */
function clearOverrides(): void {
	setEnv("STEPCODE_CONFIG_DIR", undefined);
	setEnv("STEP_CODING_AGENT_DIR", undefined);
	setEnv("STEP_CODING_AGENT_SESSION_DIR", undefined);
}

describe("the Step Code root", () => {
	test("an unset variable means ~/.stepcode", () => {
		const home = freshHome();
		clearOverrides();
		expect(stepConfigDirName()).toBe(STEPCODE_DEFAULT_DIR);
		expect(stepConfigRoot(home)).toBe(join(home, ".stepcode"));
		expect(stepAgentDir(home)).toBe(join(home, ".stepcode", "agent"));
		expect(stepLegacyRoot(home)).toBe(join(home, STEPCODE_LEGACY_DIR));
	});

	test("a blank variable is not a path, it is an unset one", () => {
		const home = freshHome();
		for (const blank of ["", "   ", "\t", "\n"]) {
			setEnv("STEPCODE_CONFIG_DIR", blank);
			expect(stepConfigDirName()).toBe(STEPCODE_DEFAULT_DIR);
			expect(stepConfigRoot(home)).toBe(join(home, ".stepcode"));
			setEnv("STEP_CODING_AGENT_DIR", blank);
			expect(stepAgentDir(home)).toBe(join(home, ".stepcode", "agent"));
			expect(stepConfigRoot(home)).toBe(join(home, ".stepcode"));
		}
	});

	test("a set variable is trimmed and used as a name, relative or not", () => {
		const home = freshHome();
		setEnv("STEP_CODING_AGENT_DIR", undefined);
		setEnv("STEPCODE_CONFIG_DIR", "  my-code  ");
		expect(stepConfigDirName()).toBe("my-code");
		expect(stepConfigRoot(home)).toBe(join(home, "my-code"));
		// A relative directory name stays relative: Step joins it onto the home it
		// resolved, and absolutizing it here would name a different place.
		setEnv("STEPCODE_CONFIG_DIR", join("nested", "deep"));
		expect(stepConfigRoot(home)).toBe(join(home, "nested", "deep"));
	});

	test("the config root is the agent directory's parent, not the agent directory", () => {
		// `config.toml`, `auth.json` and `.credentials.json` sit beside `agent/`.
		// A reader that joined them onto the agent directory looks one level too
		// deep and reports a configured Step Code as having no settings at all.
		const home = freshHome();
		const agent = join(home, "elsewhere", "agent");
		setEnv("STEP_CODING_AGENT_DIR", agent);
		expect(stepAgentDir(home)).toBe(agent);
		expect(stepConfigRoot(home)).toBe(join(home, "elsewhere"));
		expect(stepConfigRoot(home)).not.toBe(agent);
	});

	test("a relative agent directory is resolved before its parent is taken", () => {
		// Step's own comment: appending ".." is textual, so a relative override
		// would place credentials beside the process's working directory. Both
		// sides resolve against a cwd, which is why this one is not resolved
		// against the home.
		const home = freshHome();
		setEnv("STEP_CODING_AGENT_DIR", join("rel", "agent"));
		expect(stepAgentDir(home)).toBe(join("rel", "agent"));
		expect(stepConfigRoot(home)).toBe(join(process.cwd(), "rel"));
	});

	test("a filesystem root keeps its files inside the agent directory", () => {
		// A drive or `/` has no parent to hold them. Step keeps them where the host
		// asked rather than writing outside the namespace.
		const home = freshHome();
		const filesystemRoot = process.platform === "win32" ? "C:\\" : "/";
		setEnv("STEP_CODING_AGENT_DIR", filesystemRoot);
		expect(stepConfigRoot(home)).toBe(resolve(filesystemRoot));
	});

	test("the agent directory is used verbatim, the assets directory is not", () => {
		// Step spells this setting twice and both spellings are load-bearing: the
		// session machinery uses it as it stands, while `getAgentDir()` expands a
		// leading `~` for the settings, skills, prompts and `models.json`. A
		// migrator that expanded it everywhere would read a `~`-named directory
		// that does not exist and report the user's assets as absent.
		const home = freshHome();
		setEnv("STEP_CODING_AGENT_DIR", "~/agents");
		expect(stepAgentDir(home)).toBe("~/agents");
		expect(stepAssetDir(home)).toBe(join(home, "agents"));
		setEnv("STEP_CODING_AGENT_DIR", "~");
		expect(stepAssetDir(home)).toBe(home);
		// A `~` that is not the whole leading segment is an ordinary character.
		setEnv("STEP_CODING_AGENT_DIR", join(home, "~odd"));
		expect(stepAssetDir(home)).toBe(join(home, "~odd"));
		// Step expands `~/` on every platform and `~\` only on Windows
		// (`utils/paths.ts:89-90`, `agent-core/src/harness/env/nodejs.ts:53-55`), so
		// the expectation is platform-shaped: a reader that dropped the second branch
		// leaves the path literal on the one platform where the vendor expands it.
		setEnv("STEP_CODING_AGENT_DIR", "~\\agents");
		const backslashTilde = process.platform === "win32" ? join(home, "agents") : "~\\agents";
		expect(stepAssetDir(home)).toBe(backslashTilde);
		setEnv("STEP_CODING_AGENT_DIR", undefined);
		expect(stepAssetDir(home)).toBe(join(home, ".stepcode", "agent"));
	});

	test("the session root is the override, then the setting, then the tree", () => {
		const home = freshHome();
		clearOverrides();
		const root = stepConfigRoot(home);
		expect(stepSessionsDir(root)).toBe(join(root, "agent", "sessions"));
		expect(stepSessionsRoot(root, home)).toBe(join(home, ".stepcode", "agent", "sessions"));
		// The settings key is the `--session-dir` value, so it outranks the default.
		expect(stepSessionsRoot(root, home, join(home, "sessions-here"))).toBe(join(home, "sessions-here"));
		// The environment outranks the settings key.
		setEnv("STEP_CODING_AGENT_SESSION_DIR", join(home, "from-env"));
		expect(stepSessionsRoot(root, home, join(home, "sessions-here"))).toBe(join(home, "from-env"));
		// Tilde-expanded, then resolved against the home the migrator was given.
		setEnv("STEP_CODING_AGENT_SESSION_DIR", "~/sessions-from-env");
		expect(stepSessionsRoot(root, home, join(home, "sessions-here"))).toBe(join(home, "sessions-from-env"));
		setEnv("STEP_CODING_AGENT_SESSION_DIR", join("rel", "sessions"));
		expect(stepSessionsRoot(root, home)).toBe(join(home, "rel", "sessions"));
	});

	test("a blank session override is unset, a whitespace setting is a name", () => {
		// The two are read differently by Step itself: the variable is trimmed and
		// tested for emptiness, the setting is only tested for truthiness — so
		// `sessionDir = " "` really does name a directory called a single space.
		const home = freshHome();
		clearOverrides();
		const root = stepConfigRoot(home);
		for (const blank of ["", "   ", "\t"]) {
			setEnv("STEP_CODING_AGENT_SESSION_DIR", blank);
			expect(stepSessionsRoot(root, home)).toBe(join(root, "agent", "sessions"));
		}
		expect(stepSessionsRoot(root, home, " ")).toBe(join(home, " "));
		expect(stepSessionsRoot(root, home, "")).toBe(join(root, "agent", "sessions"));
	});

	test("the canonical tree wins, and the retired tree is read only when it is empty", () => {
		const home = freshHome();
		clearOverrides();
		seed(join(home, ".step-harness"), "auth.json");
		expect(stepRoot(home)).toBe(join(home, ".step-harness"));
		// Populated canonical tree: read it, and only it.
		seed(join(home, ".stepcode"));
		expect(stepRoot(home)).toBe(join(home, ".stepcode"));
		// A canonical directory that exists but holds nothing is still nothing.
		const bare = freshHome();
		mkdirSync(join(bare, ".stepcode"), { recursive: true });
		seed(join(bare, ".step-harness"));
		expect(stepRoot(bare)).toBe(join(bare, ".step-harness"));
		// Neither tree: the canonical path is reported, and detection reads it as
		// empty by the same test.
		const empty = freshHome();
		expect(stepRoot(empty)).toBe(join(empty, ".stepcode"));
	});

	test("an environment variable that names the tree also cancels the fallback", () => {
		// Somebody who moved their tree has said where it is; importing the
		// directory an abandoned release left behind is importing a tree they did
		// not name.
		const home = freshHome();
		seed(join(home, ".step-harness"));
		setEnv("STEP_CODING_AGENT_DIR", undefined);
		setEnv("STEPCODE_CONFIG_DIR", "custom");
		expect(stepRoot(home)).toBe(join(home, "custom"));
		// A variable that is nothing but whitespace names no tree, so it cancels
		// nothing: the fallback stands exactly as it would with the variable unset.
		// `stepConfigDirName` trims the same value to the default, so a reader that
		// only trimmed in one of the two places would read a tree the user never
		// named — an empty `~/.stepcode` beside their populated `.step-harness`.
		setEnv("STEPCODE_CONFIG_DIR", "   ");
		expect(stepRoot(home)).toBe(join(home, ".step-harness"));
		clearOverrides();
		setEnv("STEP_CODING_AGENT_DIR", join(home, "elsewhere", "agent"));
		expect(stepRoot(home)).toBe(join(home, "elsewhere"));
	});
});
