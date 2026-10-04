#!/usr/bin/env bun
/**
 * A self-hosted agent benchmark whose task set is this repository's own history.
 *
 * Usage:
 *   bun run scripts/benchmark.ts list [--limit 200] [--all] [--manifest <path>]
 *   bun run scripts/benchmark.ts verify <hash>... [--no-install] [--timeout <ms>]
 *   bun run scripts/benchmark.ts --help
 *
 * **The shape of a task.** A commit that changes both `src/*.ts` and a matching
 * `test/*.test.ts` yields a benchmark task for free: check out the *parent*, drop
 * the *child's* test file on top of the *parent's* source, and the suite is a
 * written-down assertion about a behaviour the source does not have yet. Run it
 * and it must go red. Hand the agent the parent's source plus the commit message,
 * and red-to-green is the whole pass condition — no hand-written task, no graded
 * rubric, no second implementation of the tests to drift out of sync with the
 * first.
 *
 * **Running the agent is out of scope, deliberately.** This file stops at "is the
 * oracle real?". A harness that cannot classify its own tasks cannot tell a model
 * that solved the task from one that got lucky, and both of those need an API key
 * that a checkout does not have. So the runner is useful — and testable — on a
 * machine that has never authenticated against anything.
 *
 * **Three verdicts, never two, and never read off an exit code.** `bun test`
 * exits 1 for a genuine assertion failure *and* for a file that could not be
 * loaded at all, and the second case even prints `1 fail` in its own summary
 * (measured, not assumed — see `classifyRun`). A harness that called that RED
 * would fill its task list with tests that cannot even import, and every one of
 * them would look like a hard task for the agent. So:
 *
 *   - **RED**    — at least one `(fail)` and no load-time failure. A usable task.
 *   - **GREEN**  — it passes. Not a task: the change was not observable by its own
 *                  test, so an agent could "solve" it without changing anything.
 *   - **BROKEN** — the suite could not run. Never reported as RED.
 *
 * **Isolation is a detached worktree, never the main tree.** The main checkout is
 * where the developer is working and where other agents are working; a benchmark
 * that checked out a parent commit in place would look like a very convincing
 * `git status`. Every task gets `git worktree add --detach`, and every teardown is
 * in a `finally` — a run that dies mid-task must not leave a directory registered
 * with git. `verify` says so when it finds one left by a killed run.
 *
 * **Two things this file will not do.** It never reads a real user's home
 * directory: `bun install` and `bun test` both run with `HOME`/`USERPROFILE`
 * pointed at a throwaway directory, which also stops a test that walks up to a
 * project root from absorbing the operator's real `memory.ts`. And it never writes
 * outside its worktrees and `%TEMP%` — a default run leaves `git status` exactly
 * as it found it, which is what makes it safe to run with uncommitted work in the
 * tree.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Everything this file creates lives under here, and it is under the OS temp
 * directory. The alternative — a worktree directory beside the repo — would put
 * hundreds of megabytes of `node_modules` inside a tree whose `.gitignore` no one
 * would remember to extend, and would make "did the run leave anything behind" a
 * question about the repo rather than about the temp directory.
 */
export const WORKSPACE_ROOT = join(tmpdir(), "labunbun-bench");

/** Per-task worktree directories, one per hash, so a killed run is identifiable. */
export function worktreeDir(hash: string): string {
	return join(WORKSPACE_ROOT, `wt-${hash}`);
}

// ---------------------------------------------------------------------------
// Running processes
// ---------------------------------------------------------------------------

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	/** Wall-clock milliseconds. Printed because the numbers are worth watching. */
	ms: number;
	timedOut: boolean;
}

export interface RunOptions {
	cwd: string;
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
}

/**
 * Run a command and capture both streams.
 *
 * The timeout is ours, not `bun test`'s: a test that never settles does not take
 * a per-test timeout, it takes the whole run down, so a harness that relied on the
 * child's timeout would hang instead of reporting BROKEN.
 */
export async function run(cmd: string[], options: RunOptions): Promise<RunResult> {
	const started = performance.now();
	const proc = Bun.spawn(cmd, {
		cwd: options.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: options.env as Record<string, string>,
	});
	let timedOut = false;
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					proc.kill();
				}, options.timeoutMs);
	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		return { code, stdout, stderr, ms: performance.now() - started, timedOut };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * The environment a task runs under.
 *
 * **The point is that the developer's own files cannot reach the run.** Several
 * modules in this repo walk up from the cwd looking for a project root and then
 * read `memory.ts` / `AGENTS.md` from it, so a benchmark run against the real
 * checkout quietly absorbs the operator's private notes and the oracle stops
 * measuring the commit. `homedir()` is not uniform about where it looks: on
 * Windows it reads the Win32 environment block and ignores `HOME`, which is a
 * trap that only shows up on one platform. So all of the names are set.
 */
export function hermeticEnv(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
	return {
		...process.env,
		...extra,
		HOME: home,
		USERPROFILE: home,
		HOMEDRIVE: home,
		HOMEPATH: "",
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		BUN_INSTALL: join(home, ".bun"),
	};
}

/** The merged text of a run's two streams, which is what gets classified. */
export function combined(result: RunResult): string {
	return `${result.stdout}\n${result.stderr}`;
}

// ---------------------------------------------------------------------------
// Classification — the load-bearing part
// ---------------------------------------------------------------------------

export type Verdict = "RED" | "GREEN" | "BROKEN";

export interface Classification {
	verdict: Verdict;
	reason: string;
	/** `(fail)` lines in the output. Zero on any BROKEN caused by a load error. */
	failLines: number;
}

/**
 * Output that means "the suite never ran", regardless of what the exit code or the
 * summary line says.
 *
 * `Cannot find module` is here because of a measurement, not a guess: on this
 * repo's Bun it prints `1 fail` *and* `1 error` in its summary and no `(fail)`
 * line at all, so a runner that counted the summary would call a missing
 * dependency a hard task.
 */
export const BROKEN_PATTERNS: { pattern: RegExp; label: string }[] = [
	{ pattern: /Cannot find module/, label: "module resolution failed (Cannot find module)" },
	{ pattern: /Cannot find package/, label: "package resolution failed (Cannot find package)" },
	{ pattern: /MODULE_NOT_FOUND/, label: "module resolution failed (MODULE_NOT_FOUND)" },
	{ pattern: /Unable to resolve/, label: "module resolution failed (Unable to resolve)" },
	{ pattern: /Failed to resolve import/, label: "module resolution failed (Failed to resolve import)" },
	{ pattern: /SyntaxError/, label: "the test file did not parse (SyntaxError)" },
	{ pattern: /Transform failed/, label: "the test file did not transform" },
	{ pattern: /error: ENOENT/, label: "a file the test reads is missing (ENOENT)" },
	{ pattern: /error: EISDIR/, label: "a path the test reads is a directory (EISDIR)" },
];

/**
 * Turn one test run into a verdict.
 *
 * **The order is the whole function.** BROKEN is checked before the `(fail)`
 * count, because the load-error shapes and the assertion-failure shapes overlap in
 * the summary line and disagree in the body. A verdict read off the exit code
 * would have no way to tell them apart at all: both are 1.
 *
 * A run that produced a `(fail)` line *and* mentioned a module error somewhere is
 * called BROKEN rather than RED. That is the conservative direction, and it is
 * deliberate: a task whose oracle cannot be trusted is worse than a task that was
 * dropped, because the first one scores an agent against a broken test.
 */
export function classifyRun(result: RunResult): Classification {
	const text = combined(result);
	const failLines = text.split("\n").filter((line) => /^\s*\(fail\)/.test(line)).length;

	if (result.timedOut) {
		return { verdict: "BROKEN", reason: "timed out before the suite finished", failLines };
	}
	for (const { pattern, label } of BROKEN_PATTERNS) {
		if (pattern.test(text)) {
			return { verdict: "BROKEN", reason: label, failLines };
		}
	}
	if (failLines > 0) {
		return {
			verdict: "RED",
			reason: `${failLines} failing assertion group(s) on the parent's source`,
			failLines,
		};
	}
	if (result.code === 0) {
		return { verdict: "GREEN", reason: "the child's test passes on the parent's source", failLines };
	}
	// Non-zero with no `(fail)` and no pattern we know: not RED, and not GREEN
	// either. Claiming GREEN here would be the same mistake as claiming RED.
	return {
		verdict: "BROKEN",
		reason: `exited ${result.code} without a failing assertion and without a recognised load error`,
		failLines,
	};
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

export interface Candidate {
	hash: string;
	parent: string;
	subject: string;
	/** The commit message body, trimmed — this is the prompt the agent would get. */
	prompt: string;
	srcFiles: string[];
	testFiles: string[];
	/** The one test file the oracle will be written from. */
	testFile: string;
	kept: boolean;
	reason: string;
}

const SRC_PATTERN = /^packages\/[^/]+\/src\/.*\.tsx?$/;
const TEST_PATTERN = /^packages\/[^/]+\/test\/.*\.test\.tsx?$/;

interface ChangedFile {
	status: string;
	path: string;
}

/** Split `git log --name-status` output into one record per commit. */
export function parseNameStatusLog(
	raw: string,
): { hash: string; parents: string; message: string; files: ChangedFile[] }[] {
	const commits: { hash: string; parents: string; message: string; files: ChangedFile[] }[] = [];
	// \x1e starts a record, \x1f separates the leading fields, and \x1d marks the
	// end of the commit message.
	//
	// The \x1d exists because of a bug worth naming. An earlier version of this
	// parser took the message to be everything up to the first newline — true of
	// `%s`, false of `%B`, which is the whole message *including its body* and so
	// spans lines. Every commit body was silently dropped, every prompt came back
	// empty, and the manifest still looked perfectly well formed: 142 tasks, each
	// with `prompt: ""`. An empty prompt is exactly the kind of wrong that a
	// schema cannot catch, and this repository's commits are short enough that
	// nothing downstream ever read the field.
	for (const record of raw.split("\x1e")) {
		if (record.trim() === "") continue;
		const terminator = record.indexOf("\x1d");
		const head = terminator === -1 ? record : record.slice(0, terminator);
		const tail = terminator === -1 ? "" : record.slice(terminator + 1);

		const firstNewline = head.indexOf("\n");
		const header = firstNewline === -1 ? head : head.slice(0, firstNewline);
		const body = firstNewline === -1 ? "" : head.slice(firstNewline + 1);
		const [hash = "", parents = "", subject = ""] = header.split("\x1f");
		// The subject sits on the same line as the hash and parents, so slicing at
		// the newline drops it. `message` has to be the *whole* message — `%B` means
		// the whole message — because `promptFromMessage` is what removes the subject
		// line. Returning the body here quietly ate the first line of every prompt.
		const message = `${subject}\n${body}`;

		const files: ChangedFile[] = [];
		for (const line of tail.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			// `A\tpath`, `M\tpath`, `R100\told\tnew`. Renames keep the destination.
			const parts = trimmed.split("\t");
			const status = parts[0] ?? "";
			const path = status.startsWith("R") || status.startsWith("C") ? (parts[2] ?? "") : (parts[1] ?? "");
			if (path !== "") files.push({ status, path });
		}
		commits.push({ hash, parents, message, files });
	}
	return commits;
}

/** The commit message body without the subject line, trimmed. */
export function promptFromMessage(message: string): string {
	const lines = message.split("\n");
	// Drop the subject, and the blank line that usually follows it.
	while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
	lines.shift();
	return lines.join("\n").trim();
}

/**
 * True when the lines a diff adds and removes are nothing but comments and blank
 * lines.
 *
 * A heuristic, and an honest one: a commit that reflows a comment *and* moves
 * code can read as comment-only. The failure is that a real candidate is dropped,
 * which the summary reports — the opposite of the failure that matters, which is
 * keeping a task whose test asserts nothing.
 */
export function isCommentOnlyDiff(diff: string): boolean {
	let substantive = false;
	for (const line of diff.split("\n")) {
		if (!line.startsWith("+") && !line.startsWith("-")) continue;
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		const body = line.slice(1);
		const trimmed = body.trim();
		if (trimmed === "") continue;
		if (trimmed.startsWith("//")) continue;
		if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("*/")) continue;
		substantive = true;
		break;
	}
	return !substantive;
}

export interface DiscoverOptions {
	repoRoot: string;
	limit: number;
	/** Report the commits that changed a test but no source, not just the kept ones. */
	verbose?: boolean;
}

export interface Discovery {
	kept: Candidate[];
	dropped: Candidate[];
	/** Commits with neither a source nor a test change — not candidates at all. */
	unrelated: number;
	/** Commits with a test change and no source change. */
	testOnly: number;
	/** Commits with a source change and no test change — nothing to make an oracle from. */
	srcOnly: number;
	scanned: number;
}

/**
 * Every test-file diff in the walk, keyed commit → file → diff text.
 *
 * **One `git log`, not one per commit.** Asking git for each candidate's diff
 * separately took 41 s for 200 commits, which is the difference between `list`
 * being the thing you run to find out what changed and the thing you avoid. The
 * whole history's test diffs come back in a single call, and the comment-only
 * check becomes a map lookup.
 */
async function loadTestDiffs(repoRoot: string, limit: number): Promise<Map<string, Map<string, string>>> {
	const result = await run(
		[
			"git",
			"log",
			`-${limit}`,
			"--unified=0",
			"--format=%x1e%H",
			"-p",
			"--",
			"packages/*/test/*.test.ts",
			"packages/*/test/*.test.tsx",
		],
		{ cwd: repoRoot, timeoutMs: 300_000 },
	);
	const byCommit = new Map<string, Map<string, string>>();
	for (const record of result.stdout.split("\x1e")) {
		const newline = record.indexOf("\n");
		if (newline === -1) continue;
		const hash = record.slice(0, newline).trim();
		if (hash === "") continue;
		const body = record.slice(newline + 1);
		// Each file's diff begins with `diff --git a/<path> b/<path>`.
		const chunks = body.split(/^diff --git /m).slice(1);
		const files = new Map<string, string>();
		for (const chunk of chunks) {
			const header = chunk.slice(0, chunk.indexOf("\n"));
			const match = /^a\/(.+?) b\/(.+)$/.exec(header);
			const path = match?.[2];
			if (path !== undefined && TEST_PATTERN.test(path)) files.set(path, chunk);
		}
		byCommit.set(hash, files);
	}
	return byCommit;
}

/**
 * Walk the history and decide, per commit, whether it can be a task.
 *
 * Every rejection carries its reason, because "why did this commit not become a
 * benchmark task" is the question a person actually has when the task list is
 * shorter than they expected.
 */
export async function discoverCandidates(options: DiscoverOptions): Promise<Discovery> {
	const { repoRoot, limit } = options;
	// %x1d ends the message so the parser can find where the file list starts
	// without guessing at a blank line, which a commit body may legitimately
	// contain. See parseNameStatusLog.
	const log = await run(["git", "log", `-${limit}`, "--name-status", "--format=%x1e%H%x1f%P%x1f%B%x1d"], {
		cwd: repoRoot,
		timeoutMs: 120_000,
	});
	if (log.code !== 0) throw new Error(`git log failed: ${log.stderr}`);
	const commits = parseNameStatusLog(log.stdout);
	const diffs = await loadTestDiffs(repoRoot, limit);

	const kept: Candidate[] = [];
	const dropped: Candidate[] = [];
	let unrelated = 0;
	let testOnly = 0;
	let srcOnly = 0;

	for (const commit of commits) {
		const srcFiles = commit.files.filter((f) => SRC_PATTERN.test(f.path)).map((f) => f.path);
		const testChanges = commit.files.filter((f) => TEST_PATTERN.test(f.path));
		const parent = commit.parents.split(" ")[0] ?? "";

		if (srcFiles.length === 0 && testChanges.length === 0) {
			unrelated++;
			continue;
		}
		if (srcFiles.length === 0) {
			testOnly++;
			if (options.verbose) {
				const testFile = testChanges[0]?.path ?? "";
				dropped.push({
					hash: commit.hash,
					parent,
					subject: commit.message.split("\n")[0] ?? "",
					prompt: promptFromMessage(commit.message),
					srcFiles: [],
					testFiles: testChanges.map((f) => f.path),
					testFile,
					kept: false,
					reason: "no src change — the test changed but the code under it did not",
				});
			}
			continue;
		}
		// Source with no test has nothing to make an oracle from, and there is no
		// rejection worth reporting: it was never this shape.
		if (testChanges.length === 0) {
			srcOnly++;
			continue;
		}

		const base: Omit<Candidate, "kept" | "reason" | "testFile"> = {
			hash: commit.hash,
			parent,
			subject: commit.message.split("\n")[0] ?? "",
			prompt: promptFromMessage(commit.message),
			srcFiles,
			testFiles: testChanges.map((f) => f.path),
		};

		const reject = (reason: string): void => {
			dropped.push({ ...base, testFile: testChanges[0]?.path ?? "", kept: false, reason });
		};

		if (commit.parents.split(" ").filter((p) => p !== "").length > 1) {
			reject("merge commit — no single parent is the 'before' state");
			continue;
		}
		if (parent === "") {
			reject("root commit — nothing to check out");
			continue;
		}
		// The oracle is written by copying the child's test file over the parent.
		// When every test file in the commit is brand new the copy still works —
		// this exclusion is a policy choice, and `verify` will happily check it.
		const existing = testChanges.filter((f) => f.status !== "A");
		if (existing.length === 0) {
			reject(`test file is new at this commit (${testChanges.map((f) => f.path).join(", ")})`);
			continue;
		}

		const testFile = existing[0]?.path ?? "";
		const diff = diffs.get(commit.hash)?.get(testFile) ?? "";
		if (isCommentOnlyDiff(diff)) {
			reject(`the only test change is a comment (${testFile})`);
			continue;
		}

		kept.push({ ...base, testFile, kept: true, reason: "source and test changed together, test predates the commit" });
	}

	return { kept, dropped, unrelated, testOnly, srcOnly, scanned: commits.length };
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
	path: string;
	head: string | null;
}

/** Every worktree git currently has registered, main tree included. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
	const result = await run(["git", "worktree", "list", "--porcelain"], { cwd: repoRoot, timeoutMs: 30_000 });
	const worktrees: WorktreeInfo[] = [];
	let path: string | null = null;
	let head: string | null = null;
	const flush = (): void => {
		if (path !== null) worktrees.push({ path, head });
		path = null;
		head = null;
	};
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			path = line.slice("worktree ".length).trim();
		} else if (line.startsWith("HEAD ")) {
			head = line.slice("HEAD ".length).trim();
		} else if (line.trim() === "") {
			flush();
		}
	}
	flush();
	return worktrees;
}

/**
 * Worktrees this harness owns that a previous run left behind.
 *
 * Reported rather than silently removed: a directory still being written to by a
 * `verify` that is running *right now* would be destroyed by a well-meaning
 * sweep, so `verify` only mentions them and says how to clear them.
 */
export async function staleWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
	const all = await listWorktrees(repoRoot);
	return all.filter((w) => w.path.startsWith(WORKSPACE_ROOT));
}

/**
 * Delete one worktree, then clear any registration git still holds for it.
 *
 * Three attempts because they fail for different reasons: a worktree with a
 * `node_modules` in it is "dirty" and needs `--force`; a directory that was
 * removed out from under git leaves a stale record that only `prune` clears; and
 * on Windows a file can briefly stay locked by a just-exited process.
 */
export async function removeWorktree(repoRoot: string, dir: string): Promise<boolean> {
	const removed = await run(["git", "worktree", "remove", "--force", dir], { cwd: repoRoot, timeoutMs: 120_000 });
	if (removed.code === 0 && !existsSync(dir)) return true;
	rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	await run(["git", "worktree", "prune"], { cwd: repoRoot, timeoutMs: 60_000 });
	return !existsSync(dir);
}

// ---------------------------------------------------------------------------
// Verifying one task
// ---------------------------------------------------------------------------

export interface VerifyOptions {
	repoRoot: string;
	install?: boolean;
	timeoutMs?: number;
	/** Called after the worktree exists; the seam a test uses to force a throw. */
	afterSetup?: (dir: string) => Promise<void>;
	/** Kept out of the returned object so a caller cannot mistake it for output. */
	onProgress?: (message: string) => void;
}

export interface VerifyResult {
	candidate: Candidate;
	verdict: Verdict;
	reason: string;
	failLines: number;
	/** Wall clock for the whole task, teardown included. */
	ms: number;
	installMs: number;
	testMs: number;
	cleanedUp: boolean;
	error?: string;
}

/** The child's version of the test file, as bytes on disk. */
function testFileSource(repoRoot: string, hash: string, testFile: string): string {
	const result = Bun.spawnSync({
		cmd: ["git", "show", `${hash}:${testFile}`],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!result.success) {
		throw new Error(`git show ${hash}:${testFile} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

/**
 * Set up the parent's source, overwrite the test with the child's, run it,
 * classify, and tear the worktree down whatever happens.
 *
 * The teardown is in a `finally` on purpose and it is the only reason a task that
 * throws cannot leave the repository's worktree list growing.
 */
export async function verifyCandidate(candidate: Candidate, options: VerifyOptions): Promise<VerifyResult> {
	const { repoRoot } = options;
	const install = options.install !== false;
	const timeoutMs = options.timeoutMs ?? 180_000;
	const dir = worktreeDir(candidate.hash);
	const started = performance.now();
	const progress = options.onProgress ?? ((): void => {});

	let verdict: Verdict = "BROKEN";
	let reason = "not run";
	let failLines = 0;
	let installMs = 0;
	let testMs = 0;
	let error: string | undefined;
	let cleanedUp = false;
	// Hoisted so the `finally` can delete it. A per-task HOME left behind in the
	// temp directory is small, but a full `verify` of a hundred tasks leaves a
	// hundred of them, and "did the run clean up after itself" has to have one
	// answer rather than two.
	let fakeHome: string | null = null;

	mkdirSync(WORKSPACE_ROOT, { recursive: true });
	rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

	try {
		progress(`  worktree  ${dir}`);
		const add = await run(["git", "worktree", "add", "--detach", dir, candidate.parent], {
			cwd: repoRoot,
			timeoutMs: 180_000,
		});
		if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);

		// A throwaway HOME, so a module that walks up from the cwd finds an empty
		// directory instead of the operator's real project memory.
		fakeHome = mkdtempSync(join(WORKSPACE_ROOT, "home-"));
		const env = hermeticEnv(fakeHome);

		if (install) {
			progress("  bun install (~40s, the worktree has no node_modules)");
			const installed = await run(["bun", "install"], { cwd: dir, timeoutMs: 600_000, env });
			installMs = installed.ms;
			if (installed.code !== 0) {
				reason = "bun install failed — the worktree has no dependencies to run a test against";
				throw new Error(reason);
			}
		}

		const contents = testFileSource(repoRoot, candidate.hash, candidate.testFile);
		const target = join(dir, ...candidate.testFile.split("/"));
		writeFileSync(target, contents, "utf8");
		progress(`  oracle    ${candidate.testFile} (${contents.length} bytes from ${candidate.hash})`);

		if (options.afterSetup) await options.afterSetup(dir);

		progress("  bun test");
		const test = await run(["bun", "test", candidate.testFile], { cwd: dir, timeoutMs, env });
		testMs = test.ms;
		const classification = classifyRun(test);
		verdict = classification.verdict;
		reason = classification.reason;
		failLines = classification.failLines;
	} catch (thrown) {
		error = thrown instanceof Error ? thrown.message : String(thrown);
		if (verdict === "BROKEN" && reason === "not run") reason = error;
	} finally {
		cleanedUp = await removeWorktree(repoRoot, dir);
		if (fakeHome !== null) rmSync(fakeHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	}

	return {
		candidate,
		verdict,
		reason,
		failLines,
		ms: performance.now() - started,
		installMs,
		testMs,
		cleanedUp,
		error,
	};
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface Manifest {
	generatedAt: string;
	repoHead: string;
	limit: number;
	tasks: {
		hash: string;
		parent: string;
		subject: string;
		prompt: string;
		srcFiles: string[];
		testFile: string;
		expected: Verdict;
	}[];
}

export async function buildManifest(discovery: Discovery, repoRoot: string, limit: number): Promise<Manifest> {
	const head = await run(["git", "rev-parse", "HEAD"], { cwd: repoRoot, timeoutMs: 30_000 });
	return {
		generatedAt: new Date().toISOString(),
		repoHead: head.stdout.trim(),
		limit,
		tasks: discovery.kept.map((c) => ({
			hash: c.hash,
			parent: c.parent,
			subject: c.subject,
			prompt: c.prompt,
			srcFiles: c.srcFiles,
			testFile: c.testFile,
			// The whole point of the harness is that this column is a prediction
			// that `verify` gets to check.
			expected: "RED" as Verdict,
		})),
	};
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `labunbun self-hosted benchmark — this repository's history as the task set

Usage:
  bun run scripts/benchmark.ts list [--limit <n>] [--all] [--verbose] [--manifest <path>]
  bun run scripts/benchmark.ts verify <hash>... [--no-install] [--timeout <ms>]

Commands:
  list        Walk the history and print the candidate tasks with the reason each
              commit was kept or dropped. No worktrees, no installs — seconds, not
              minutes.
  verify      For each hash: check out its parent in a throwaway worktree, install,
              overwrite the test file with the child's version, run it, print the
              verdict, tear the worktree down.

Options:
  --limit <n>        How far back to walk. Default 200.
  --all              Walk the whole history.
  --verbose          Also list the test-only commits, not just the src+test ones.
  --manifest <path>  Write the selected tasks as JSON. Without this flag nothing is
                     written, so a run leaves 'git status' exactly as it found it.
  --no-install       Skip 'bun install'. Only for a warm worktree — and note that
                     the worktrees are throwaway, so it is never warm.
  --timeout <ms>     Per-task wall clock for 'bun test'. Default 180000.
  -h, --help         This text.

Verdicts:
  RED      the child's test fails on the parent's source. A usable task.
  GREEN    it passes. Not a task — the change was invisible to its own test.
  BROKEN   the suite could not run. Never reported as RED.

'verify' exits non-zero if any task is GREEN or BROKEN, so a selection regression
is loud instead of a silently shorter benchmark.

Running the agent itself is OUT OF SCOPE and there is no flag for it. This file
answers "is this oracle real?", and it can answer that on a machine with no API
key at all — which is what makes it testable before a model is ever involved.`;

interface CliArgs {
	command: string;
	help: boolean;
	limit: number | null;
	all: boolean;
	verbose: boolean;
	install: boolean;
	timeoutMs: number | null;
	manifest: string | null;
	hashes: string[];
}

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		command: "",
		help: false,
		limit: null,
		all: false,
		verbose: false,
		install: true,
		timeoutMs: null,
		manifest: null,
		hashes: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				args.help = true;
				break;
			case "--all":
				args.all = true;
				break;
			case "--verbose":
				args.verbose = true;
				break;
			case "--no-install":
				args.install = false;
				break;
			case "--limit":
				args.limit = Number(argv[++i]) || null;
				break;
			case "--timeout":
				args.timeoutMs = Number(argv[++i]) || null;
				break;
			case "--manifest":
				args.manifest = argv[++i] ?? null;
				break;
			default:
				if (arg?.startsWith("-")) throw new Error(`Unknown argument: ${arg} (see --help)`);
				if (args.command === "") args.command = arg ?? "";
				else args.hashes.push(arg ?? "");
				break;
		}
	}
	return args;
}

/** Fixed-width table; the columns are the ones a person scans. */
function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: string[]): string =>
		cells
			.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

async function commandList(args: CliArgs, repoRoot: string): Promise<number> {
	const limit = args.all ? 100_000 : (args.limit ?? 200);
	const discovery = await discoverCandidates({ repoRoot, limit, verbose: args.verbose });

	console.log(
		`scanned ${discovery.scanned} commits (limit ${limit})\n` +
			`  ${discovery.unrelated} touched neither src/ nor test/\n` +
			`  ${discovery.srcOnly} touched src/ but no test/\n` +
			`  ${discovery.testOnly} touched test/ but no src/\n` +
			`  ${discovery.kept.length} kept, ${discovery.dropped.length} dropped\n`,
	);

	console.log(
		table(
			["hash", "subject", "src", "test"],
			discovery.kept.map((c) => [c.hash.slice(0, 8), c.subject, c.srcFiles[0] ?? "", c.testFile]),
		),
	);

	if (discovery.dropped.length > 0) {
		console.log("\ndropped:");
		for (const c of discovery.dropped) {
			console.log(`  ${c.hash.slice(0, 8)}  ${c.subject}\n      ${c.reason}`);
		}
	}

	if (args.manifest) {
		const manifest = await buildManifest(discovery, repoRoot, limit);
		const path = resolve(args.manifest);
		writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		console.log(`\nmanifest: ${path} (${manifest.tasks.length} tasks)`);
	}
	return 0;
}

async function commandVerify(args: CliArgs, repoRoot: string): Promise<number> {
	const stale = await staleWorktrees(repoRoot);
	if (stale.length > 0) {
		console.log(
			`${stale.length} worktree(s) from an earlier run are still registered:\n` +
				stale.map((w) => `  ${w.path}  (HEAD ${w.head ?? "?"})`).join("\n") +
				"\n  they are safe to delete, and this run will not delete them for you —\n" +
				"  a live 'verify' owns its own directory. Clear them with:\n" +
				`  git worktree remove --force <path>   (or: git worktree prune)\n`,
		);
	}

	// One walk of the history for the whole invocation. Doing it per hash cost a
	// twelve-second diff walk each time, which is longer than most tasks take.
	const discovery = await discoverCandidates({ repoRoot, limit: 100_000 });

	const results: VerifyResult[] = [];
	for (const hash of args.hashes) {
		const full = await run(["git", "rev-parse", "--verify", `${hash}^{commit}`], { cwd: repoRoot, timeoutMs: 30_000 });
		if (full.code !== 0) {
			console.error(`\n${hash}: not a commit in this repository`);
			continue;
		}
		const found =
			discovery.kept.find((c) => c.hash.startsWith(hash)) ?? discovery.dropped.find((c) => c.hash.startsWith(hash));
		if (!found) {
			console.error(`\n${hash}: not a benchmark candidate (no src+test change)`);
			continue;
		}

		console.log(`\n${found.hash.slice(0, 8)}  ${found.subject}`);
		if (!found.kept) console.log(`  note: this commit is dropped by 'list' — ${found.reason}`);
		const result = await verifyCandidate(found, {
			repoRoot,
			install: args.install,
			timeoutMs: args.timeoutMs ?? undefined,
			onProgress: (m) => console.log(m),
		});
		results.push(result);
		console.log(
			`  => ${result.verdict}: ${result.reason}  [install ${Math.round(result.installMs / 1000)}s, ` +
				`test ${(result.testMs / 1000).toFixed(1)}s, total ${Math.round(result.ms / 1000)}s]` +
				(result.cleanedUp ? "" : "  WORKTREE CLEANUP FAILED"),
		);
	}

	if (results.length > 0) {
		console.log(
			"\n" +
				table(
					["hash", "verdict", "fails", "why"],
					results.map((r) => [r.candidate.hash.slice(0, 8), r.verdict, String(r.failLines), r.reason]),
				),
		);
		const bad = results.filter((r) => r.verdict !== "RED");
		console.log(
			bad.length === 0
				? `\nall ${results.length} task(s) RED — the oracle holds on every one.`
				: `\n${bad.length} of ${results.length} are not RED: ${bad.map((r) => `${r.candidate.hash.slice(0, 8)}=${r.verdict}`).join(", ")}`,
		);
		console.log("\nRunning the agent is out of scope for this harness.");
		return bad.length === 0 ? 0 : 1;
	}
	return 2;
}

export async function main(argv: string[] = process.argv.slice(2), repoRoot = process.cwd()): Promise<number> {
	let args: CliArgs;
	try {
		args = parseArgs(argv);
	} catch (thrown) {
		console.error(thrown instanceof Error ? thrown.message : String(thrown));
		return 2;
	}
	if (args.help || args.command === "") {
		console.log(HELP);
		return args.command === "" && !args.help ? 2 : 0;
	}
	if (args.command === "list") return commandList(args, repoRoot);
	if (args.command === "verify") {
		if (args.hashes.length === 0) {
			console.error("verify needs at least one hash (see --help)");
			return 2;
		}
		return commandVerify(args, repoRoot);
	}
	console.error(`Unknown command: ${args.command} (list | verify)`);
	return 2;
}

if (import.meta.main) {
	process.exit(await main());
}
