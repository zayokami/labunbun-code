/**
 * Where Kimi Code keeps its tree, as one rule the readers share.
 *
 * Kimi Code resolves the same variable two ways (`??` in the engine, a
 * truthiness test in the CLI's own path helper) and the two disagree for exactly
 * one value: the empty string. These tests pin which side this migrator takes
 * and why, because "which tree did the reader walk" is not something a migration
 * report can correct after the fact.
 *
 * The rest of the module is path joining, but three of Kimi's own habits are
 * worth naming: the value is used verbatim (no trim, no `~`, no resolve), the
 * prompt history is keyed by `md5` of a working directory rather than by its
 * name, and the default directory is spelled with a capital-free `.kimi-code`
 * that must not be confused with `kimi-cli`'s `~/.kimi`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	KIMI_CLI_LEGACY_DIR,
	KIMI_CODE_DEFAULT_DIR,
	KIMI_CODE_HOME_ENV,
	kimiAgentsDir,
	kimiConfigPath,
	kimiCredentialsDir,
	kimiInputHistoryDir,
	kimiInputHistoryFile,
	kimiMcpFile,
	kimiPluginsDir,
	kimiRoot,
	kimiSessionsDir,
	kimiSkillsDir,
} from "../src/kimi-home.ts";

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
	const home = mkdtempSync(join(tmpdir(), "lbb-kimi-home-"));
	roots.push(home);
	return home;
}

describe("the Kimi Code root", () => {
	test("an unset variable means ~/.kimi-code", () => {
		const home = freshHome();
		setEnv(KIMI_CODE_HOME_ENV, undefined);
		expect(kimiRoot(home)).toBe(join(home, KIMI_CODE_DEFAULT_DIR));
		expect(KIMI_CODE_DEFAULT_DIR).toBe(".kimi-code");
		// `kimi-cli`, the predecessor, is a different tree and a different product;
		// it is named so the report can point at it, and never resolved into a read.
		expect(KIMI_CLI_LEGACY_DIR).toBe(".kimi");
		expect(kimiRoot(home)).not.toBe(join(home, KIMI_CLI_LEGACY_DIR));
	});

	test("an empty variable is unset, a whitespace one is a directory", () => {
		// The engine's `??` would take `""` as a value and put `config.toml` beside
		// the working directory of whoever launched the process; the CLI's own data
		// dir takes it as unset. This reader follows the CLI, so the two agree on
		// where the prompt history is — the one file both spellings compute — and a
		// shell accident lands on the default tree instead of on this process's cwd.
		const home = freshHome();
		setEnv(KIMI_CODE_HOME_ENV, "");
		expect(kimiRoot(home)).toBe(join(home, KIMI_CODE_DEFAULT_DIR));
		// Not trimmed, on either side: a padded value is a real directory name.
		for (const padded of [" ", "   ", "\t", " .kimi-code "]) {
			setEnv(KIMI_CODE_HOME_ENV, padded);
			expect(kimiRoot(home)).toBe(padded);
		}
	});

	test("a set variable is used verbatim: no trim, no ~, no resolve", () => {
		const home = freshHome();
		setEnv(KIMI_CODE_HOME_ENV, "  /data/kimi  ");
		expect(kimiRoot(home)).toBe("  /data/kimi  ");
		// Kimi never expands a leading `~`, so this names a directory called `~`.
		setEnv(KIMI_CODE_HOME_ENV, "~/elsewhere");
		expect(kimiRoot(home)).toBe("~/elsewhere");
		// And never resolves a relative value, so it stays relative.
		setEnv(KIMI_CODE_HOME_ENV, join("rel", "kimi"));
		expect(kimiRoot(home)).toBe(join("rel", "kimi"));
	});

	test("every path the readers ask for hangs off that one root", () => {
		const home = freshHome();
		const root = join(home, "kimi-root");
		setEnv(KIMI_CODE_HOME_ENV, root);
		expect(kimiConfigPath(root)).toBe(join(root, "config.toml"));
		expect(kimiSessionsDir(root)).toBe(join(root, "sessions"));
		expect(kimiInputHistoryDir(root)).toBe(join(root, "user-history"));
		expect(kimiSkillsDir(root)).toBe(join(root, "skills"));
		expect(kimiAgentsDir(root)).toBe(join(root, "agents"));
		expect(kimiPluginsDir(root)).toBe(join(root, "plugins"));
		expect(kimiCredentialsDir(root)).toBe(join(root, "credentials"));
		expect(kimiMcpFile(root)).toBe(join(root, "mcp.json"));
		// The root itself is the variable, so a moved tree moves all of them.
		expect(kimiConfigPath(kimiRoot(home))).toBe(join(root, "config.toml"));
	});

	test("the prompt history file is keyed by md5 of the working directory", () => {
		// Kimi's own helper is `createHash('md5').update(workDir, 'utf-8')` over the
		// *recorded* cwd, so the file cannot be found from a directory name and the
		// reader has to hash candidate cwds to match one. The literal below is that
		// hash for a path no normalisation would leave alone, which pins the digest
		// and the encoding both.
		const root = "R:/kimi";
		expect(kimiInputHistoryFile(root, "/home/user/proj")).toBe(
			join(root, "user-history", "6c29bb5a3ee7ba21db1ef234e48630f8.jsonl"),
		);
		// Two working directories, two files; a name-keyed scheme would collide here
		// (or, worse, would look for `proj.jsonl` and find nothing).
		const one = kimiInputHistoryFile(root, "C:\\proj");
		const two = kimiInputHistoryFile(root, "c:\\proj");
		expect(one).not.toBe(two);
		expect(() => kimiInputHistoryFile(root, "")).not.toThrow();
	});
});
