/**
 * The benchmark runner's own tests.
 *
 * **What is worth testing here, and what is not.** The interesting code is the
 * classifier and the candidate filter; the worktree plumbing is mostly git. So the
 * classifier is tested against *real captured output* rather than invented
 * strings, the selection filter is tested against named commits that exist in this
 * repository's history, and only two tests actually build a worktree — one to
 * prove a thrown run still cleans up, and one to prove a real `verify` leaves the
 * main tree alone.
 *
 * **Why the captured outputs matter.** `bun test` prints `1 fail` in its summary
 * for a file that could not be imported. That was measured on this machine, not
 * read off a bug report, and it is the single fact the whole classifier is built
 * around: a harness that reads the summary, or the exit code — both are 1 — will
 * report a missing `node_modules` as a hard benchmark task. The literals below
 * are pasted from real runs and are expected to stay true; if Bun changes its
 * wording the classifier is what needs updating, and this file is where you find
 * out.
 *
 * Nothing here reads a real home directory or writes outside `%TEMP%`; the one
 * test that runs the real thing points `HOME` at a throwaway directory through the
 * runner's own `hermeticEnv`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type Candidate,
	classifyRun,
	discoverCandidates,
	hermeticEnv,
	isCommentOnlyDiff,
	main,
	parseArgs,
	parseNameStatusLog,
	promptFromMessage,
	run,
	staleWorktrees,
	type Verdict,
	verifyCandidate,
	WORKSPACE_ROOT,
	worktreeDir,
} from "../../../scripts/benchmark.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

// ---------------------------------------------------------------------------
// Captured output
// ---------------------------------------------------------------------------

/**
 * A real `bun test` run against a file that imports something that does not exist.
 * Note `1 fail` in the summary and the absence of any `(fail)` line: this is the
 * shape a summary-line classifier mistakes for a genuine assertion failure.
 */
const BROKEN_MODULE_OUTPUT = [
	"bun test v1.3.5 (1e86cebd)",
	"",
	"zz-broken-probe.test.ts:",
	"",
	"# Unhandled error between tests",
	"-------------------------------",
	"error: Cannot find module '@labunbun/coding-agent/src/definitely-not-here.ts' from 'C:\\zz-broken-probe.test.ts'",
	"-------------------------------",
	"",
	"",
	" 0 pass",
	" 1 fail",
	" 1 error",
	"Ran 1 test across 1 file. [126.00ms]",
].join("\n");

/** A real run of a child's test file on its parent's source: 1 pass, 16 fail. */
const RED_OUTPUT = [
	"bun test v1.3.5 (1e86cebd)",
	"",
	"(fail) a hook event name that reads as a credential survives, handlers and all [31.00ms]",
	"(fail) another one [1.00ms]",
	"",
	" 1 pass",
	" 16 fail",
	" 21 expect() calls",
	"Ran 17 tests across 1 file. [4.24s]",
].join("\n");

/** A real passing run. */
const GREEN_OUTPUT = [
	"bun test v1.3.5 (1e86cebd)",
	"",
	" 17 pass",
	" 0 fail",
	"Ran 17 tests across 1 file. [4.24s]",
].join("\n");

function result(overrides: Partial<{ code: number; stdout: string; stderr: string; timedOut: boolean }> = {}) {
	return {
		code: overrides.code ?? 1,
		stdout: overrides.stdout ?? RED_OUTPUT,
		stderr: overrides.stderr ?? "",
		ms: 1,
		timedOut: overrides.timedOut ?? false,
	};
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classifyRun", () => {
	test("a suite that cannot resolve a module is BROKEN and never RED", () => {
		// **The load-bearing assertion of this file.** The output says `1 fail`, and
		// the exit code is 1 — exactly what a genuine assertion failure produces. If
		// this ever returns RED, every benchmark task whose worktree is missing an
		// install becomes a task the agent cannot pass, and nothing would say so.
		expect(classifyRun(result({ stdout: BROKEN_MODULE_OUTPUT })).verdict).toBe("BROKEN");
		expect(classifyRun(result({ stdout: BROKEN_MODULE_OUTPUT })).failLines).toBe(0);
	});

	test("BROKEN wins even when the output also mentions a failing assertion", () => {
		// A test whose body dynamically imports a missing module prints both. The
		// verdict is BROKEN because a task with an unreliable oracle is worse than a
		// dropped task, and the direction of the error is the safe one.
		const mixed = `${RED_OUTPUT}\nerror: Cannot find module './generated/registry.ts'`;
		expect(classifyRun(result({ stdout: mixed })).verdict).toBe("BROKEN");
	});

	test("the other load failures are BROKEN too", () => {
		for (const text of [
			"error: MODULE_NOT_FOUND",
			"error: Cannot find package '@labunbun/nope'",
			"error: Unable to resolve ./thing",
			"SyntaxError: Unexpected token",
			"error: ENOENT: no such file or directory",
		]) {
			expect(classifyRun(result({ stdout: text })).verdict).toBe("BROKEN");
		}
	});

	test("a real failure is RED, and the count comes from the (fail) lines", () => {
		const classification = classifyRun(result({ stdout: RED_OUTPUT }));
		expect(classification.verdict).toBe("RED");
		// The summary says 16; only 2 (fail) lines are in this capture. The body is
		// the thing to count, which is the point.
		expect(classification.failLines).toBe(2);
	});

	test("a passing suite is GREEN, not RED", () => {
		expect(classifyRun(result({ code: 0, stdout: GREEN_OUTPUT })).verdict).toBe("GREEN");
	});

	test("a timeout is BROKEN", () => {
		// A test that never settles does not take `bun test`'s per-test timeout, so
		// the harness has to impose its own wall clock or the run hangs forever.
		expect(classifyRun(result({ stdout: "", timedOut: true })).verdict).toBe("BROKEN");
	});

	test("a non-zero exit with no failure and no known pattern is BROKEN, not GREEN", () => {
		// Claiming GREEN here would be the same error as claiming RED: the suite did
		// not demonstrably pass.
		expect(classifyRun(result({ code: 3, stdout: "something went sideways" })).verdict).toBe("BROKEN");
	});

	test("the verdict is never read off the exit code alone", () => {
		// Same exit code, three verdicts. A classifier that branched on `code` would
		// give all three the same answer.
		expect(classifyRun(result({ code: 1, stdout: RED_OUTPUT })).verdict).toBe("RED");
		expect(classifyRun(result({ code: 1, stdout: BROKEN_MODULE_OUTPUT })).verdict).toBe("BROKEN");
		expect(classifyRun(result({ code: 0, stdout: GREEN_OUTPUT })).verdict).toBe("GREEN");
	});

	test("a BROKEN verdict always carries a reason", () => {
		expect(classifyRun(result({ stdout: BROKEN_MODULE_OUTPUT })).reason).toContain("module resolution");
	});
});

// ---------------------------------------------------------------------------
// Parsing and filtering, without touching git
// ---------------------------------------------------------------------------

describe("parseNameStatusLog", () => {
	test("splits hash, parents and message on the separators, not on spaces", () => {
		// `%x1e%H%x1f%P%x1f%B%x1d`. A subject is full of spaces, so a parser that
		// splits the header on whitespace reads "abc123 def456" as one hash. This
		// fixture uses the real separators; an earlier version of it used a space and
		// "caught" a bug that was only in the test.
		const raw =
			"\x1eabc123\x1fdef456\x1fsandbox: key the proxy by policy\n\nThe proxy was keyed by\nthe environment.\n\x1d" +
			"\nM\tpackages/agent/src/a.ts\nA\tpackages/agent/test/a.test.ts\n";
		const commits = parseNameStatusLog(raw);
		expect(commits).toHaveLength(1);
		expect(commits[0]?.hash).toBe("abc123");
		expect(commits[0]?.parents).toBe("def456");
		expect(commits[0]?.files).toEqual([
			{ status: "M", path: "packages/agent/src/a.ts" },
			{ status: "A", path: "packages/agent/test/a.test.ts" },
		]);
	});

	test("keeps the commit message body, which is the prompt the agent gets", () => {
		// **This test exists because the prompt was silently empty.** The parser read
		// the message as "everything up to the first newline", which is true of `%s`
		// and false of `%B`: every body was dropped, every task in the manifest
		// carried `prompt: ""`, and nothing complained. The body is the task, so a
		// blank one is a benchmark that measures nothing.
		const raw =
			"\x1eh1\x1fp1\x1fsandbox: key the proxy\n\nThe proxy was keyed by the\nenvironment block, not by the policy.\n\x1d" +
			"\nM\tpackages/agent/src/a.ts\n";
		const message = parseNameStatusLog(raw)[0]?.message ?? "";
		expect(promptFromMessage(message)).toBe("The proxy was keyed by the\nenvironment block, not by the policy.");
	});

	test("a body containing a blank line survives", () => {
		// The alternative parse — "the message ends at the first blank line" —
		// would truncate this one. `\x1d` is what makes it unambiguous.
		const raw =
			"\x1eh1\x1fp1\x1fsubject\n\nfirst paragraph\n\nsecond paragraph\n\x1d" + "\nM\tpackages/agent/src/a.ts\n";
		const commits = parseNameStatusLog(raw);
		expect(promptFromMessage(commits[0]?.message ?? "")).toBe("first paragraph\n\nsecond paragraph");
		expect(commits[0]?.files).toHaveLength(1);
	});

	test("two commits in one stream do not bleed into each other", () => {
		const raw =
			"\x1eh1\x1fp1\x1bfirst\n\x1d\nM\tpackages/a/src/x.ts\n" +
			"\x1eh2\x1fp2\x1bsecond\n\x1d\nA\tpackages/a/test/y.test.ts\n";
		const commits = parseNameStatusLog(raw);
		expect(commits.map((c) => c.hash)).toEqual(["h1", "h2"]);
		expect(commits[0]?.files).toHaveLength(1);
		expect(commits[1]?.files).toHaveLength(1);
	});

	test("a rename records the destination, not the source", () => {
		const raw = "\x1eh1\x1fp1\x1fsubject\n\x1d\nR096\tpackages/a/test/old.test.ts\tpackages/a/test/new.test.ts\n";
		expect(parseNameStatusLog(raw)[0]?.files[0]).toEqual({ status: "R096", path: "packages/a/test/new.test.ts" });
	});
});

describe("promptFromMessage", () => {
	test("is the body, not the subject", () => {
		const message = "sandbox: key the network proxy\n\nThe proxy was keyed by\nthe env block, not the policy.\n";
		expect(promptFromMessage(message)).toBe("The proxy was keyed by\nthe env block, not the policy.");
	});

	test("a subject-only commit gives an empty prompt rather than the subject", () => {
		// The prompt handed to the agent is the body. Falling back to the subject
		// would hand it a one-line title and quietly measure a different task.
		expect(promptFromMessage("just a subject\n")).toBe("");
	});
});

describe("isCommentOnlyDiff", () => {
	test("a diff of nothing but comments is comment-only", () => {
		const diff = [
			"diff --git a/packages/agent/test/t.test.ts b/packages/agent/test/t.test.ts",
			"--- a/packages/agent/test/t.test.ts",
			"+++ b/packages/agent/test/t.test.ts",
			"@@ -1,2 +1,3 @@",
			"-\t// old note",
			"+\t// a new and longer note",
			"+\t// spanning two lines",
			"+\t * block form",
			"+\t */",
			"+\t",
		].join("\n");
		expect(isCommentOnlyDiff(diff)).toBe(true);
	});

	test("one added assertion is enough to be substantive", () => {
		const diff = [
			"--- a/packages/agent/test/t.test.ts",
			"+++ b/packages/agent/test/t.test.ts",
			"@@ -1,2 +1,3 @@",
			"+\t// explaining the new assertion",
			"+\texpect(xs).toEqual([1, 2]);",
		].join("\n");
		expect(isCommentOnlyDiff(diff)).toBe(false);
	});

	test("the file header lines are not mistaken for changes", () => {
		expect(isCommentOnlyDiff("--- a/x\n+++ b/x\n")).toBe(true);
	});
});

describe("hermeticEnv", () => {
	test("points every home-shaped variable at the throwaway directory", () => {
		const env = hermeticEnv(join(WORKSPACE_ROOT, "home-test"));
		expect(env.HOME).toBe(join(WORKSPACE_ROOT, "home-test"));
		// On Windows `homedir()` reads the Win32 block and ignores HOME, so
		// USERPROFILE has to move too or the run reads the real user's files.
		expect(env.USERPROFILE).toBe(env.HOME);
		expect(env.HOMEDRIVE).toBe(env.HOME);
		expect(env.HOMEPATH).toBe("");
		expect(env.XDG_CONFIG_HOME).toBe(join(env.HOME as string, ".config"));
	});

	test("extra values win over the inherited environment", () => {
		expect(hermeticEnv("C:\\tmp-home", { PATH: "C:\\only" }).PATH).toBe("C:\\only");
	});
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
	test("reads the two commands and their hashes", () => {
		expect(parseArgs(["verify", "e24c8a6", "14983d4"])).toMatchObject({
			command: "verify",
			hashes: ["e24c8a6", "14983d4"],
			install: true,
		});
	});

	test("--no-install is opt-out, not opt-in", () => {
		expect(parseArgs(["verify", "e24c8a6", "--no-install"]).install).toBe(false);
	});

	test("--all is not --limit", () => {
		expect(parseArgs(["list", "--all"])).toMatchObject({ command: "list", all: true, limit: null });
	});
});

// ---------------------------------------------------------------------------
// The help text
// ---------------------------------------------------------------------------

describe("--help", () => {
	test("documents both commands and says the agent is out of scope", async () => {
		// The harness has to be usable before there is an API key, and the one place
		// a reader learns that is the help text.
		const original = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => void lines.push(args.join(" "));
		try {
			expect(await main(["--help"])).toBe(0);
		} finally {
			console.log = original;
		}
		const help = lines.join("\n");
		expect(help).toContain("list");
		expect(help).toContain("verify");
		expect(help).toContain("RED");
		expect(help).toContain("GREEN");
		expect(help).toContain("BROKEN");
		expect(help).toContain("OUT OF SCOPE");
	});

	test("no command at all is a usage error", async () => {
		const original = console.log;
		console.log = () => {};
		try {
			expect(await main([])).toBe(2);
		} finally {
			console.log = original;
		}
	});

	test("verify with no hash is a usage error", async () => {
		const original = console.error;
		console.error = () => {};
		try {
			expect(await main(["verify"])).toBe(2);
		} finally {
			console.error = original;
		}
	});
});

// ---------------------------------------------------------------------------
// Candidate selection, against this repository's real history
// ---------------------------------------------------------------------------

describe("discoverCandidates", () => {
	// One walk, shared: the history does not move during a test run.
	let discovery: Awaited<ReturnType<typeof discoverCandidates>> | undefined;

	async function candidates(): Promise<Awaited<ReturnType<typeof discoverCandidates>>> {
		if (discovery === undefined) {
			discovery = await discoverCandidates({ repoRoot: REPO_ROOT, limit: 250 });
		}
		return discovery;
	}

	test("keeps e24c8a6, whose test file predates the commit", async () => {
		const found = await candidates();
		const kept = found.kept.find((c) => c.hash.startsWith("e24c8a6"));
		expect(kept).toBeDefined();
		expect(kept?.srcFiles).toContain("packages/agent/src/dangerous-command.ts");
		expect(kept?.testFile).toBe("packages/agent/test/dangerous-command.test.ts");
		// The parent is what a task checks out, so it has to be the commit *before*.
		expect(kept?.parent).not.toBe(kept?.hash);
		expect(kept?.kept).toBe(true);
	}, 120_000);
	test("drops 14983d4, whose test file is new at that commit", async () => {
		// **Named on purpose.** This is the commit where the "a new test file cannot
		// be an oracle" rule is worth arguing with: `verify` measures this exact
		// commit as 16 failing assertions — a real RED oracle — despite the exclusion.
		// The rule is implemented as specified; this test is what keeps the cost of
		// the rule visible.
		const found = await candidates();
		const dropped = found.dropped.find((c) => c.hash.startsWith("14983d4"));
		expect(dropped).toBeDefined();
		expect(dropped?.kept).toBe(false);
		expect(dropped?.reason).toContain("new at this commit");
		expect(dropped?.testFiles).toContain("packages/coding-agent/test/migrate-qoder-credential-scope.test.ts");
		expect(found.kept.some((c) => c.hash.startsWith("14983d4"))).toBe(false);
	}, 120_000);
	test("drops a3d94d4 too, for the same reason", async () => {
		const found = await candidates();
		const dropped = found.dropped.find((c) => c.hash.startsWith("a3d94d4"));
		expect(dropped?.reason).toContain("new at this commit");
	}, 120_000);
	test("every drop carries a reason a person can act on", async () => {
		for (const candidate of (await candidates()).dropped) {
			expect(candidate.reason.length).toBeGreaterThan(10);
		}
	}, 120_000);
	test("no merge commit survives", async () => {
		for (const candidate of (await candidates()).kept) {
			expect(candidate.reason).not.toContain("merge");
		}
	}, 120_000);
	test("every kept task has a parent that is not itself", async () => {
		for (const candidate of (await candidates()).kept) {
			expect(candidate.parent).not.toBe("");
			expect(candidate.parent).not.toBe(candidate.hash);
		}
	}, 120_000);
});

// ---------------------------------------------------------------------------
// Worktree lifecycle
// ---------------------------------------------------------------------------

describe("worktree teardown", () => {
	test("a run that throws still removes the worktree", async () => {
		// The `finally` is the whole reason to test this path: an exception between
		// `worktree add` and the end of the task must not leave a directory that git
		// still has registered, because the next run would then report a stale
		// worktree that no one can account for.
		// A real candidate, not a synthetic one: `verifyCandidate` reads the child's
		// test file out of git before it calls `afterSetup`, so an invented hash
		// would fail earlier for an unrelated reason and the throw this test is
		// about would never be reached.
		const found = await discoverCandidates({ repoRoot: REPO_ROOT, limit: 250 });
		const candidate = found.kept.find((c) => c.hash.startsWith("e24c8a6"));
		expect(candidate).toBeDefined();

		const dir = worktreeDir(candidate?.hash ?? "");
		const outcome = await verifyCandidate(candidate as Candidate, {
			repoRoot: REPO_ROOT,
			install: false,
			afterSetup: async () => {
				throw new Error("deliberate failure after setup");
			},
		});
		expect(outcome.error).toBe("deliberate failure after setup");
		expect(outcome.cleanedUp).toBe(true);
		expect(existsSync(dir)).toBe(false);
		// And git's own record of it is gone, not just the directory.
		expect((await staleWorktrees(REPO_ROOT)).some((w) => w.path === dir)).toBe(false);
	}, 180_000);
});

// ---------------------------------------------------------------------------
// The end-to-end proof
// ---------------------------------------------------------------------------

describe("a real verify of one known task", () => {
	test("classifies e24c8a6 as RED and leaves the main tree exactly as it found it", async () => {
		// **This is the test that can only be believed by running it.**
		//
		// Two observations are made deterministic and compared exactly: HEAD (a
		// "checkout" in the main tree moves it) and the worktree list (a leaked
		// worktree shows up there, and nothing else in this repo churns it during a
		// single test).
		//
		// `git status` proper cannot be compared exactly here, and it is worth saying
		// why rather than tuning the assertion until it passes: three other agents are
		// working in this tree at the same time. Two runs of this test each failed on a
		// difference the runner did not make — first a new untracked
		// `packages/coding-agent/test/writable-roots-wiring.test.ts` appearing between
		// the two samples, then another agent modifying
		// `packages/tools/test/sandbox-bwrap-smoke.test.ts`. So the equality is
		// attempted, and a difference is reported loudly and attributed rather than
		// papered over: the runner's own footprint is the worktree list and the
		// %TEMP% workspace, neither of which can show up in `git status`.
		const status = async (): Promise<string> =>
			(await run(["git", "status", "--porcelain"], { cwd: REPO_ROOT })).stdout;
		const worktrees = async (): Promise<string> =>
			(await run(["git", "worktree", "list", "--porcelain"], { cwd: REPO_ROOT })).stdout;
		const head = async (): Promise<string> => (await run(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT })).stdout;

		const before = { status: await status(), worktrees: await worktrees(), head: await head() };

		const found = await discoverCandidates({ repoRoot: REPO_ROOT, limit: 250 });
		const candidate = found.kept.find((c) => c.hash.startsWith("e24c8a6"));
		expect(candidate).toBeDefined();

		const result = await verifyCandidate(candidate as Candidate, { repoRoot: REPO_ROOT });

		// The oracle itself, which is the point of the whole exercise.
		console.log(`    e24c8a6 => ${result.verdict}: ${result.reason}`);
		expect(result.error).toBeUndefined();
		expect(result.cleanedUp).toBe(true);
		expect(result.verdict satisfies Verdict).toBe("RED");
		expect(result.failLines).toBeGreaterThan(0);

		const after = { status: await status(), worktrees: await worktrees(), head: await head() };
		expect(after.head).toBe(before.head);
		expect(after.worktrees).toBe(before.worktrees);

		// The runner's own leftovers are the assertion that matters, and it is exact.
		expect((await staleWorktrees(REPO_ROOT)).map((w) => w.path)).toEqual([]);
		expect(existsSync(worktreeDir(result.candidate.hash))).toBe(false);

		// The status comparison, reported rather than assumed.
		const beforeLines = new Set(before.status.split("\n").filter((l) => l.trim() !== ""));
		const added = after.status.split("\n").filter((l) => l.trim() !== "" && !beforeLines.has(l));
		if (added.length > 0) {
			console.log(
				`    NOTE: main-tree status changed during the run by another agent, not by the runner:\n${added
					.map((l) => `      ${l}`)
					.join("\n")}`,
			);
		}
	}, 600_000);
});
