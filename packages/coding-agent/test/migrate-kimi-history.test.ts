/**
 * The Kimi Code tree: which directory a migration reads, where the predecessor's
 * tree sits, and the two lookups that decide whether there is anything to import.
 *
 * Three properties are the point of this file, and all three are about what a
 * migration is allowed to *touch* rather than about what it reads:
 *
 *   - `kimiRoot` resolves one variable and never the host's home directory: the
 *     home is a parameter, so the machine running the migration cannot move
 *     another machine's tree, and `$HOME`/`$USERPROFILE` are set to decoys below
 *     to prove they are not consulted;
 *   - `kimiLegacySourceRoot` answers for `kimi-cli`'s tree, where an
 *     all-whitespace `$KIMI_SHARE_DIR` counts as unset (the *other* variable in
 *     the same file takes whitespace for a directory name), a relative value
 *     resolves against the working directory rather than the home, and a share
 *     directory that moved the tree still leaves `<home>/.kimi` in play for
 *     skills — so the answer carries both paths;
 *   - `kimiInputHistoryLookup` answers for one project's prompt history under the
 *     spellings that working directory could have been hashed as, and answers
 *     `null` when none of them is there.
 *
 * The last two are lookups. A lookup that created the directory it was asked
 * about would turn a migration into a write into the tree it is reading, and
 * nothing else in the run would notice — so every test here that asks about a
 * path also compares the tree before and after it asked.
 *
 * The wire itself is not folded here: `kimi-session.test.ts` pins the fold record
 * by record. What is pinned below is that the same journal is *refused* rather
 * than half-read when it cannot be folded, and that a record kind this build does
 * not know is counted and named instead of being guessed at.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	KIMI_CLI_LEGACY_DIR,
	KIMI_CODE_DEFAULT_DIR,
	KIMI_CODE_HOME_ENV,
	KIMI_SHARE_DIR_ENV,
	kimiConfigPath,
	kimiInputHistoryDir,
	kimiInputHistoryFile,
	kimiInputHistoryLookup,
	kimiLegacySourceRoot,
	kimiMcpFile,
	kimiRoot,
	kimiSessionsDir,
} from "../src/kimi-home.ts";
import { type KimiSessionFile, listKimiSessions, readKimiSession } from "../src/kimi-session.ts";

/** The project the fixtures ran in; a session with no cwd is scoped nowhere. */
const CWD = process.cwd();

/** The fixtures' clock. */
const T0 = Date.parse("2026-03-01T00:00:00Z");

/** Temp directories, swept with the test that made them. */
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

/** A throwaway directory to resolve against. */
function freshDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `lbb-kimi-${prefix}-`));
	roots.push(dir);
	return dir;
}

/** Every path under a directory, so a test can prove nothing was created. */
function snapshot(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			out.push(relative(dir, path));
			if (entry.isDirectory()) walk(path);
		}
	};
	walk(dir);
	return out.sort();
}

/** The key Kimi's own writer hashes a working directory into. */
function md5(text: string): string {
	return createHash("md5").update(text, "utf-8").digest("hex");
}

/** Put one project's prompt history where the CLI would have written it. */
function writeHistory(root: string, hashed: string): string {
	const dir = kimiInputHistoryDir(root);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${md5(hashed)}.jsonl`);
	writeFileSync(path, `${JSON.stringify({ content: "hello" })}\n`);
	return path;
}

// ---------------------------------------------------------------------------
// The root
// ---------------------------------------------------------------------------

describe("the Kimi Code root a migration resolves", () => {
	test("an unset variable means <home>/.kimi-code, and the host's own home is a decoy", () => {
		const home = freshDir("home");
		// If anything here reached for `os.homedir()` these two would answer instead,
		// and a migration run on one machine would read another machine's tree.
		setEnv("HOME", freshDir("decoy-home"));
		setEnv("USERPROFILE", freshDir("decoy-profile"));
		setEnv(KIMI_CODE_HOME_ENV, undefined);
		expect(kimiRoot(home)).toBe(join(home, KIMI_CODE_DEFAULT_DIR));
		expect(KIMI_CODE_DEFAULT_DIR).toBe(".kimi-code");
		// `kimi-cli` is a different tree in a different directory name, so the two
		// must not be confused for one another by a stray default.
		expect(KIMI_CLI_LEGACY_DIR).toBe(".kimi");
		expect(kimiRoot(home)).not.toBe(join(home, KIMI_CLI_LEGACY_DIR));
	});

	test("an empty variable is unset, and a whitespace one is a directory", () => {
		const home = freshDir("home");
		setEnv(KIMI_CODE_HOME_ENV, "");
		expect(kimiRoot(home)).toBe(join(home, KIMI_CODE_DEFAULT_DIR));
		// Not trimmed: a padded value is a real directory name, which is also why the
		// predecessor's resolver below cannot borrow this rule.
		for (const padded of [" ", "   ", "\t", " .kimi-code "]) {
			setEnv(KIMI_CODE_HOME_ENV, padded);
			expect(kimiRoot(home)).toBe(padded);
		}
	});

	test("a set variable is used verbatim: no trim, no ~, no resolve", () => {
		const home = freshDir("home");
		setEnv(KIMI_CODE_HOME_ENV, "  /data/kimi  ");
		expect(kimiRoot(home)).toBe("  /data/kimi  ");
		// Kimi never expands `~`, so this names a directory called `~`.
		setEnv(KIMI_CODE_HOME_ENV, "~/elsewhere");
		expect(kimiRoot(home)).toBe("~/elsewhere");
		// And never resolves a relative value, so it stays relative.
		setEnv(KIMI_CODE_HOME_ENV, join("rel", "kimi"));
		expect(kimiRoot(home)).toBe(join("rel", "kimi"));
		expect(KIMI_CODE_HOME_ENV).toBe("KIMI_CODE_HOME");
	});

	test("every path hangs off that one root, and the history directory is named", () => {
		const home = freshDir("home");
		const root = join(home, "kimi-root");
		setEnv(KIMI_CODE_HOME_ENV, root);
		expect(kimiConfigPath(root)).toBe(join(root, "config.toml"));
		expect(kimiMcpFile(root)).toBe(join(root, "mcp.json"));
		expect(kimiSessionsDir(root)).toBe(join(root, "sessions"));
		expect(kimiInputHistoryDir(root)).toBe(join(root, "user-history"));
		// The root itself is the variable, so a moved tree moves all of them.
		expect(kimiConfigPath(kimiRoot(home))).toBe(join(root, "config.toml"));
	});
});

// ---------------------------------------------------------------------------
// The predecessor's tree
// ---------------------------------------------------------------------------

describe("kimi-cli's tree, which is named and never opened", () => {
	test("with no share directory it is <home>/.kimi, and asking creates nothing", () => {
		const home = freshDir("legacy");
		setEnv(KIMI_SHARE_DIR_ENV, undefined);
		const before = snapshot(home);
		// The whole answer, compared at once: `skillsRoot` being *absent* when the
		// tree is the default is part of the shape, not an undefined value to ignore.
		expect(kimiLegacySourceRoot(home, CWD)).toEqual({ root: join(home, KIMI_CLI_LEGACY_DIR), origin: "default" });
		expect(existsSync(join(home, KIMI_CLI_LEGACY_DIR))).toBe(false);
		expect(snapshot(home)).toEqual(before);
	});

	test("an all-whitespace share directory is unset here, and a directory name one root over", () => {
		const home = freshDir("legacy");
		// The two variables in this one file disagree about a blank value, each
		// because its own tool says so: `$KIMI_CODE_HOME` is compared to `""`, this
		// one is trimmed first.
		for (const blank of [" ", "   ", "\t", "\n\t "]) {
			setEnv(KIMI_CODE_HOME_ENV, blank);
			setEnv(KIMI_SHARE_DIR_ENV, blank);
			expect(kimiLegacySourceRoot(home, CWD)).toEqual({
				root: join(home, KIMI_CLI_LEGACY_DIR),
				origin: "default",
			});
			expect(kimiRoot(home)).toBe(blank);
		}
		expect(KIMI_SHARE_DIR_ENV).toBe("KIMI_SHARE_DIR");
	});

	test("an absolute share directory is resolved, and a relative one against the working directory", () => {
		const home = freshDir("legacy");
		const absolute = resolve(tmpdir(), "lbb-kimi-share-dir");
		setEnv(KIMI_SHARE_DIR_ENV, absolute);
		const before = snapshot(home);
		expect(kimiLegacySourceRoot(home, CWD)).toEqual({
			root: absolute,
			origin: "share-dir",
			// The default tree is still in play for skills, so it is reported rather
			// than retired — this is the pair the report has to name both halves of.
			skillsRoot: join(home, KIMI_CLI_LEGACY_DIR),
		});
		expect(existsSync(absolute)).toBe(false);
		expect(snapshot(home)).toEqual(before);

		// A relative value is relative to the *working directory*, not the home: the
		// two bases are different depths here so a resolver that used the wrong one
		// cannot land on the same path by accident.
		const cwd = resolve(tmpdir(), "lbb-kimi-cwd", "one-level-down");
		const relativeValue = join("..", "elsewhere", "kimi");
		setEnv(KIMI_SHARE_DIR_ENV, relativeValue);
		expect(kimiLegacySourceRoot(home, cwd).root).toBe(resolve(cwd, relativeValue));
		expect(kimiLegacySourceRoot(home, cwd).root).not.toBe(resolve(home, relativeValue));
	});

	test("a `~` is not expanded but is resolved, unlike the other variable", () => {
		const home = freshDir("legacy");
		const cwd = resolve(tmpdir(), "lbb-kimi-cwd", "one-level-down");
		setEnv(KIMI_SHARE_DIR_ENV, "~/kimi");
		// Not absolute, so it resolves against the working directory as a literal
		// directory named `~` — where `$KIMI_CODE_HOME` would keep the string as is.
		expect(kimiLegacySourceRoot(home, cwd).root).toBe(resolve(cwd, "~/kimi"));
		expect(kimiLegacySourceRoot(home, cwd).root).not.toBe("~/kimi");
	});

	test("a share directory that names the default is the default, skills included", () => {
		const home = freshDir("legacy");
		// Absolute, and equal to the default once resolved: the resolver's own test
		// is `===` on the two computed strings, so this is the moved-tree branch whose
		// skills root is *not* a second path.
		setEnv(KIMI_SHARE_DIR_ENV, join(home, KIMI_CLI_LEGACY_DIR));
		expect(kimiLegacySourceRoot(home, CWD)).toEqual({
			root: join(home, KIMI_CLI_LEGACY_DIR),
			origin: "share-dir",
		});
	});
});

// ---------------------------------------------------------------------------
// Prompt history
// ---------------------------------------------------------------------------

describe("one project's prompt history", () => {
	test("the key is md5 of the working directory, spelling and case included", () => {
		const home = freshDir("history");
		const root = join(home, "kimi");
		// The digest is pinned as a literal for a directory no normalisation would
		// leave alone, which fixes the hash, the encoding and the `.jsonl` suffix at
		// once — and pins that the key function itself asks nothing of the disk.
		expect(kimiInputHistoryFile(root, "/home/user/proj")).toBe(
			join(root, "user-history", "6c29bb5a3ee7ba21db1ef234e48630f8.jsonl"),
		);
		// Two spellings of one directory are two files, because only the first is the
		// string the CLI hashed with `process.cwd()`.
		expect(kimiInputHistoryFile(root, "C:\\proj")).toBe(join(root, "user-history", `${md5("C:\\proj")}.jsonl`));
		expect(kimiInputHistoryFile(root, "c:\\proj")).toBe(join(root, "user-history", `${md5("c:\\proj")}.jsonl`));
		expect(kimiInputHistoryFile(root, "C:\\proj")).not.toBe(kimiInputHistoryFile(root, "c:\\proj"));
		// The file is the directory's child, which is the relation a report states.
		expect(kimiInputHistoryFile(root, "/home/user/proj").startsWith(kimiInputHistoryDir(root))).toBe(true);
		expect(existsSync(root)).toBe(false);
	});

	test("a lookup finds the file under the spelling the CLI wrote", () => {
		const home = freshDir("history");
		const root = join(home, "kimi");
		const project = join(home, "project");
		const written = writeHistory(root, project);
		expect(kimiInputHistoryLookup(root, project)).toBe(written);
	});

	test("the spellings are tried in order: as given, slashed, resolved", () => {
		// A *relative* value with a separator, so its three spellings are three
		// different keys: for an absolute native path the first and the third are the
		// same string, and a test written with one could not tell which was asked.
		const value = join("one", "two");
		const slashed = value.replaceAll("\\", "/");

		// Only the slashed spelling is on disk: a lookup that hashed the string as
		// given and stopped would answer `null` here.
		const slashedOnly = freshDir("history-slashed");
		const slashedFile = writeHistory(slashedOnly, slashed);
		expect(kimiInputHistoryLookup(slashedOnly, value)).toBe(slashedFile);

		// Only the resolved spelling is on disk: the value has to be made absolute
		// before it can be hashed at all.
		const resolvedOnly = freshDir("history-relative");
		const resolvedFile = writeHistory(resolvedOnly, resolve(value));
		expect(kimiInputHistoryLookup(resolvedOnly, value)).toBe(resolvedFile);

		// All three, and the first one wins: the resolved key is a different file that
		// is also there, so this is the phase that pins the order.
		const all = freshDir("history-all");
		const asGiven = writeHistory(all, value);
		writeHistory(all, slashed);
		writeHistory(all, resolve(value));
		expect(kimiInputHistoryLookup(all, value)).toBe(asGiven);
	});

	test("a project with no history answers null, and the lookup writes nothing", () => {
		const home = freshDir("history");
		const root = join(home, "kimi");
		const before = snapshot(home);
		expect(kimiInputHistoryLookup(root, join(home, "project"))).toBeNull();
		// A path to a file that is not there would be worse than a miss: the caller
		// would report history it is about to fail to read.
		expect(existsSync(root)).toBe(false);
		expect(existsSync(kimiInputHistoryDir(root))).toBe(false);
		expect(snapshot(home)).toEqual(before);

		// A history file keyed by some *other* spelling is still a miss: the lookup
		// answers from the keys it can compute, it does not scan the directory.
		const other = freshDir("history-other");
		const otherRoot = join(other, "kimi");
		const written = writeHistory(otherRoot, join(other, "project").toUpperCase());
		const after = snapshot(other);
		expect(kimiInputHistoryLookup(otherRoot, join(other, "project"))).toBeNull();
		// And the miss changed nothing on disk, not even a directory it named.
		expect(after).toContain(relative(other, written));
		expect(snapshot(other)).toEqual(after);
	});
});

// ---------------------------------------------------------------------------
// What the reader refuses
// ---------------------------------------------------------------------------

describe("a journal the reader will not guess about", () => {
	let root = "";
	beforeEach(() => {
		root = freshDir("wire");
	});

	/** A session directory with one main-agent wire, the way Kimi lays one out. */
	function writeWire(lines: string[]): KimiSessionFile {
		const dir = join(root, "sessions", "wd_proj_abc123", "s-1");
		mkdirSync(join(dir, "agents", "main"), { recursive: true });
		writeFileSync(
			join(dir, "state.json"),
			JSON.stringify({ cwd: CWD, createdAt: T0, agents: { main: { type: "main" } } }),
		);
		writeFileSync(join(dir, "agents", "main", "wire.jsonl"), `${lines.join("\n")}\n`);
		const session = listKimiSessions(root).sessions[0];
		if (!session) throw new Error("the fixture session was not listed");
		return session;
	}

	/** The `metadata` record every wire opens with. */
	function metadata(protocolVersion = "1.5"): string {
		return JSON.stringify({ time: T0, type: "metadata", protocol_version: protocolVersion, created_at: T0 });
	}

	/** A user turn, as the journal appends one. */
	function user(text: string): string {
		return JSON.stringify({
			time: T0 + 1000,
			type: "context.append_message",
			message: { role: "user", content: [{ type: "text", text }] },
		});
	}

	test("a journal that cannot be folded is refused rather than half-read", () => {
		// `content.part` for a step no `step.begin` ever opened: the source's own fold
		// throws here, and a reader that skipped the line instead would import a
		// prefix the source itself dropped.
		const session = writeWire([
			metadata(),
			user("hello"),
			JSON.stringify({
				time: T0 + 2000,
				type: "context.append_loop_event",
				event: { type: "content.part", stepUuid: "never-opened", part: { type: "text", text: "orphan" } },
			}),
		]);
		const read = readKimiSession(session);
		expect("error" in read).toBe(true);
		expect("entries" in read).toBe(false);
		if ("error" in read) expect(read.error).toContain("never-opened");
	});

	test("a transcript that vanished between listing and reading says so", () => {
		const session = writeWire([metadata(), user("hello")]);
		rmSync(session.path);
		const read = readKimiSession(session);
		expect("error" in read).toBe(true);
		// An empty read would be a session reported as having nothing in it, which is
		// the one answer a migration must never give for a file it could not open.
		if ("error" in read) expect(read.error).toContain("could not be read");
	});

	test("a record kind this build does not know is counted and named", () => {
		const session = writeWire([
			metadata(),
			user("hello"),
			JSON.stringify({
				time: T0 + 2000,
				type: "context.append_loop_event",
				event: { type: "future.event", uuid: "x" },
			}),
		]);
		const read = readKimiSession(session);
		expect("error" in read).toBe(false);
		if ("error" in read) return;
		// The turn the reader does understand still arrives, and the one it does not
		// is named in the notes rather than silently dropped.
		expect(read.entries.length).toBe(1);
		expect(read.notes.find((entry) => entry.reason === "unknown loop event")?.count).toBe(1);
	});
});
