/**
 * Where MiniMax Code keeps its tree, as one rule the readers share.
 *
 * Three things about this product make the module worth its own tests.
 *
 * The first is that the directory has *three* historical names and only one of
 * them is live: `~/.minimax` is the current default, `~/.mavis` is the same tree
 * under the name it had before (renamed there, or left as a link to it), and
 * `~/.minimax-code` is the installer's directory — and, separately, the data
 * directory of earlier source builds, which the current default neither moves nor
 * merges. Reading the wrong one of the three is not a small error: it either
 * reads program files as conversations or imports one tree twice.
 *
 * The second is that `$MINIMAX_DATA_DIR` is **trimmed** and an all-whitespace
 * value counts as unset, which is the opposite of both neighbouring sources
 * (`$KIMI_CODE_HOME` is used verbatim, `$DSH_HOME` takes pure whitespace as a
 * value). The tests below pin the trim, because a reader that keeps the padding
 * reads a directory nobody wrote.
 *
 * The third is a negative: MiniMax keeps no cross-session prompt history file.
 * Its input navigation reads the session's own rows and its only other text on
 * disk is unsent composer drafts, so this module exports no `*History*` lookup at
 * all — and the last test below is what keeps that claim true.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as home from "../src/minimax-home.ts";
import {
	MINIMAX_DATA_DIR_BASENAME,
	MINIMAX_DATA_DIR_ENV,
	MINIMAX_INSTALL_DIR,
	MINIMAX_LEGACY_DATA_DIR_BASENAME,
	MINIMAX_LEGACY_DATA_DIR_ENV,
	MINIMAX_PROJECT_INSTRUCTION_FILES,
	MINIMAX_PROJECT_MCP_FILE,
	minimaxAgentsDir,
	minimaxAuthDir,
	minimaxCliAuthDir,
	minimaxConfigPath,
	minimaxCredentialsDir,
	minimaxDraftsDir,
	minimaxGlobalInstructionsPath,
	minimaxLegacyChatsDir,
	minimaxLegacyDataDir,
	minimaxMcpAliasFile,
	minimaxMcpFile,
	minimaxMemoryDir,
	minimaxPermissionFile,
	minimaxPlansDir,
	minimaxPluginsDir,
	minimaxProfileRoot,
	minimaxRoot,
	minimaxRuntimeStateDb,
	minimaxSessionsRoot,
	minimaxSkillsDir,
	minimaxV2Root,
} from "../src/minimax-home.ts";

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
	const home = mkdtempSync(join(tmpdir(), "lbb-minimax-home-"));
	roots.push(home);
	return home;
}

/** Create a link when this machine allows one; `false` when it does not. */
function linkIfPossible(target: string, path: string, kind: "dir" | "junction"): boolean {
	try {
		symlinkSync(target, path, kind);
		return true;
	} catch {
		return false;
	}
}

describe("the MiniMax Code root", () => {
	test("an unset variable means ~/.minimax, and the two older names are not that", () => {
		const home = freshHome();
		setEnv(MINIMAX_DATA_DIR_ENV, undefined);
		setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, undefined);
		expect(minimaxRoot(home)).toEqual({ root: join(home, MINIMAX_DATA_DIR_BASENAME), origin: "default" });
		expect(MINIMAX_DATA_DIR_BASENAME).toBe(".minimax");
		// `~/.mavis` is the same product's tree under its old name, so it is read
		// *second*, never alongside; `~/.minimax-code` is the installer's directory
		// and, before the current default, a source build's data directory — program
		// files, deliberately neither moved nor merged.
		expect(MINIMAX_LEGACY_DATA_DIR_BASENAME).toBe(".mavis");
		expect(MINIMAX_INSTALL_DIR).toBe(".minimax-code");
		expect(minimaxRoot(home).root).not.toBe(join(home, MINIMAX_INSTALL_DIR));
	});

	test("the value is trimmed, and one that is all whitespace names no tree at all", () => {
		// This is where the audit and the source disagree, and the source wins:
		// `process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim()`
		// (`config.ts:1316-1319`, and the TUI's `readDataDirOverride` agrees). So a
		// padded value names the unpadded directory, and a value of spaces is *unset*
		// — which is exactly the difference from `$KIMI_CODE_HOME`, used verbatim, and
		// from `$DSH_HOME`, where pure whitespace is a directory name.
		const home = freshHome();
		setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, undefined);
		setEnv(MINIMAX_DATA_DIR_ENV, "  /data/mcode  ");
		expect(minimaxRoot(home)).toEqual({ root: "/data/mcode", origin: "data-dir" });
		setEnv(MINIMAX_DATA_DIR_ENV, "\t/data/mcode\n");
		expect(minimaxRoot(home).root).toBe("/data/mcode");
		// Whiteness alone falls through to the older name, and then to the default.
		setEnv(MINIMAX_DATA_DIR_ENV, "   ");
		setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, "  /data/mavis  ");
		expect(minimaxRoot(home)).toEqual({ root: "/data/mavis", origin: "legacy-data-dir" });
		setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, " ");
		expect(minimaxRoot(home)).toEqual({ root: join(home, MINIMAX_DATA_DIR_BASENAME), origin: "default" });
	});

	test("the newer name wins over the older one, because it is one setting with two names", () => {
		const home = freshHome();
		setEnv(MINIMAX_DATA_DIR_ENV, "/data/new");
		setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, "/data/old");
		expect(minimaxRoot(home)).toEqual({ root: "/data/new", origin: "data-dir" });
		// The old name is a real override, not an alias: it moves the tree when it is
		// the only one set, and the report says which name moved it.
		setEnv(MINIMAX_DATA_DIR_ENV, undefined);
		expect(minimaxRoot(home)).toEqual({ root: "/data/old", origin: "legacy-data-dir" });
	});

	test("a leading ~ is not expanded and a relative value is not resolved", () => {
		// The vendor hands the value back to its callers unchanged, so a reader that
		// resolved it would read a tree nobody wrote — `~/elsewhere` names a directory
		// literally called `~` under the *process's* working directory, exactly as
		// `$KIMI_CODE_HOME` does.
		const home = freshHome();
		setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, undefined);
		for (const value of ["~/elsewhere", join("rel", "mcode"), ".", "../up"]) {
			setEnv(MINIMAX_DATA_DIR_ENV, value);
			expect(minimaxRoot(home)).toEqual({ root: value, origin: "data-dir" });
		}
	});

	test("a profile is the base name plus the profile, and the empty profile is the unscoped tree", () => {
		const home = freshHome();
		// `basenameForProfile` is `base + '-' + profile` with no separator of its own, and
		// the branch-isolated profile of a git auto-detected run is a branch with its
		// slashes folded — a caller that detects one passes the folded name in.
		expect(minimaxProfileRoot(home, "work")).toBe(join(home, ".minimax-work"));
		expect(minimaxProfileRoot(home, "feature-x")).toBe(join(home, ".minimax-feature-x"));
		// No profile is the unscoped tree, not a directory named `.minimax-`.
		expect(minimaxProfileRoot(home, "")).toBe(join(home, MINIMAX_DATA_DIR_BASENAME));
	});

	test("a moved tree moves every path, and the profile tree is not the default one", () => {
		const home = freshHome();
		setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, undefined);
		setEnv(MINIMAX_DATA_DIR_ENV, "/data/mcode");
		expect(minimaxConfigPath(minimaxRoot(home).root)).toBe(join("/data/mcode", "config.yaml"));
		expect(minimaxSessionsRoot(minimaxRoot(home).root)).toBe(join("/data/mcode", "v2", "sessions"));
		setEnv(MINIMAX_DATA_DIR_ENV, "/data/mcode-work");
		expect(minimaxConfigPath(minimaxRoot(home).root)).toBe(join("/data/mcode-work", "config.yaml"));
		// A profile tree is a different directory, and the variable overrides both names.
		expect(minimaxProfileRoot(home, "work")).toBe(join(home, ".minimax-work"));
		expect(minimaxProfileRoot(home, "work")).not.toBe(minimaxRoot(home).root);
	});
});

describe("the old directory, which is read only when it is a different tree", () => {
	test("it is read when it holds its own data, and never when it is a link to the current tree", () => {
		const home = freshHome();
		// The vendor renames `.mavis` into `.minimax` and, when the rename leaves a
		// link behind, that link points at the new directory. Reading both names would
		// then import every session twice, so the comparison is the point of this rule.
		expect(minimaxLegacyDataDir(home)).toBeNull();
		const legacy = join(home, MINIMAX_LEGACY_DATA_DIR_BASENAME);
		mkdirSync(legacy);
		expect(minimaxLegacyDataDir(home)).toBe(legacy);
		expect(minimaxLegacyDataDir(home, "work")).toBeNull();
		mkdirSync(join(home, ".mavis-work"));
		expect(minimaxLegacyDataDir(home, "work")).toBe(join(home, ".mavis-work"));

		// A `.minimax` that is not there at all cannot be what the old name points at.
		const other = freshHome();
		mkdirSync(join(other, MINIMAX_LEGACY_DATA_DIR_BASENAME));
		expect(minimaxLegacyDataDir(other)).toBe(join(other, MINIMAX_LEGACY_DATA_DIR_BASENAME));
	});

	test("a link is followed: an absolute target and a relative one both mean one tree", () => {
		// `data-dir.ts:61-81` resolves the link and compares the resolved paths, and it
		// accepts both spellings because both occur in the wild: a junction is written
		// with an absolute target and `fs.symlinkSync` with a relative one. The two
		// link assertions below are the only conditional ones in this file — on a
		// machine that forbids creating links they cannot run, and the unlinked cases
		// above still do.
		const home = freshHome();
		const current = join(home, MINIMAX_DATA_DIR_BASENAME);
		mkdirSync(current);
		const kind = process.platform === "win32" ? "junction" : "dir";
		expect(linkIfPossible(current, join(home, MINIMAX_LEGACY_DATA_DIR_BASENAME), kind)).toBe(true);
		expect(minimaxLegacyDataDir(home)).toBeNull();
		// The same directory through a *relative* target: still the same tree, so still
		// nothing to read twice.
		const relative = freshHome();
		mkdirSync(join(relative, MINIMAX_DATA_DIR_BASENAME));
		expect(linkIfPossible(MINIMAX_DATA_DIR_BASENAME, join(relative, MINIMAX_LEGACY_DATA_DIR_BASENAME), kind)).toBe(
			true,
		);
		expect(minimaxLegacyDataDir(relative)).toBeNull();
		// A link that points somewhere else entirely names its own tree, and is read.
		const elsewhere = freshHome();
		mkdirSync(join(elsewhere, "kept"));
		mkdirSync(join(elsewhere, MINIMAX_DATA_DIR_BASENAME));
		expect(linkIfPossible(join(elsewhere, "kept"), join(elsewhere, MINIMAX_LEGACY_DATA_DIR_BASENAME), kind)).toBe(true);
		expect(minimaxLegacyDataDir(elsewhere)).toBe(join(elsewhere, MINIMAX_LEGACY_DATA_DIR_BASENAME));
	});

	test("a relative target is resolved against the link's own directory", () => {
		// The two spellings are two comparisons, not one: a target is either absolute
		// or written relative to the directory the link lives in, and only the second
		// needs the link's own directory to be resolved against. The test above writes
		// each platform's usual link, which on Windows is the absolute one (a junction
		// absolutises whatever it is given), so this is the other branch on its own.
		const home = freshHome();
		mkdirSync(join(home, MINIMAX_DATA_DIR_BASENAME));
		const link = join(home, MINIMAX_LEGACY_DATA_DIR_BASENAME);
		// A plain directory link, not a junction: only this spelling keeps the target
		// relative, and a machine that forbids creating one cannot run this at all.
		if (!linkIfPossible(MINIMAX_DATA_DIR_BASENAME, link, "dir")) return;
		expect(readlinkSync(link)).toBe(MINIMAX_DATA_DIR_BASENAME);
		// Resolving the target against the process's directory would name a directory
		// nowhere near this home, and the old name would be read as a second tree.
		expect(minimaxLegacyDataDir(home)).toBeNull();
	});
});

describe("every path the readers ask for hangs off that one root", () => {
	test("the tree, and nothing created while asking about it", () => {
		const root = join(freshHome(), "mcode-root");
		expect(minimaxV2Root(root)).toBe(join(root, "v2"));
		expect(minimaxSessionsRoot(root)).toBe(join(root, "v2", "sessions"));
		expect(minimaxRuntimeStateDb(root)).toBe(join(root, "v2", "sqlite", "runtime-state.sqlite"));
		expect(minimaxLegacyChatsDir(root)).toBe(join(root, "v2", "chats"));
		expect(minimaxDraftsDir(root)).toBe(join(root, "v2", "mcode", "drafts"));
		// The paths the importer reads beside the sessions, and the ones it only names.
		expect(minimaxConfigPath(root)).toBe(join(root, "config.yaml"));
		expect(minimaxGlobalInstructionsPath(root)).toBe(join(root, "AGENTS.md"));
		expect(minimaxAgentsDir(root)).toBe(join(root, "agents"));
		expect(minimaxSkillsDir(root)).toBe(join(root, "skills"));
		expect(minimaxPluginsDir(root)).toBe(join(root, "plugins"));
		expect(minimaxPlansDir(root)).toBe(join(root, "plans"));
		expect(minimaxMemoryDir(root)).toBe(join(root, "memory"));
		expect(minimaxMcpFile(root)).toBe(join(root, "mcp.json"));
		expect(minimaxMcpAliasFile(root)).toBe(join(root, "mcp", "mcp.json"));
		expect(minimaxPermissionFile(root)).toBe(join(root, "permission.json"));
		// Credentials are named where they are and never opened; the three live at the
		// root and are distinct from each other.
		expect(minimaxAuthDir(root)).toBe(join(root, "auth"));
		expect(minimaxCredentialsDir(root)).toBe(join(root, "credentials"));
		expect(minimaxCliAuthDir(root)).toBe(join(root, "cli-auth"));
		expect(new Set([minimaxAuthDir(root), minimaxCredentialsDir(root), minimaxCliAuthDir(root)]).size).toBe(3);
		// The alias is an alias, not a second file: one list of servers, one path.
		expect(minimaxMcpAliasFile(root)).not.toBe(minimaxMcpFile(root));
		// Asking about a tree must not build it — the source tree is the user's, and a
		// migration that created a directory in it would leave a trace of itself.
		const guess = freshHome();
		for (const path of [minimaxSessionsRoot(guess), minimaxRuntimeStateDb(guess), minimaxDraftsDir(guess)]) {
			expect(existsSync(path)).toBe(false);
		}
		expect(readdirSync(guess)).toEqual([]);
	});

	test("the project files are named where the tool reads them", () => {
		// A project's instructions are read as the legacy `CLAUDE.md` first and
		// `AGENTS.md` second, and its MCP servers come from `.mcp.json` before the
		// user's own file — the order is the tool's, and a caller that reordered it
		// would read a different prompt than the one the user wrote.
		expect(MINIMAX_PROJECT_INSTRUCTION_FILES).toEqual(["CLAUDE.md", "AGENTS.md"]);
		expect(MINIMAX_PROJECT_MCP_FILE).toBe(".mcp.json");
	});
});

describe("the prompt history this source does not have", () => {
	test("no history lookup is invented here, and the drafts are not one", () => {
		// MiniMax keeps no cross-session prompt-history file: the input history is the
		// session's own rows, read back through SQLite, and the only other text on disk
		// is the composer's draft recovery — unsent text, keyed by a digest of the
		// working directory. This module therefore exports no `*History*` path or
		// lookup, and this test is what keeps that true instead of a comment that can
		// quietly go stale: add one, and it goes red.
		const history = Object.keys(home).filter((name) => /history/i.test(name));
		expect(history).toEqual([]);
		const root = join(freshHome(), "mcode-root");
		expect(minimaxDraftsDir(root)).toBe(join(root, "v2", "mcode", "drafts"));
		// A draft is keyed by a digest of the working directory and holds text the user
		// never sent, so there is no name to look it up by and nothing here reads it.
		expect(existsSync(minimaxDraftsDir(root))).toBe(false);
	});
});
