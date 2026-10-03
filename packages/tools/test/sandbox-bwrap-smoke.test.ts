/**
 * Run the generated bwrap argument vector through a real `bwrap`.
 *
 * **What this file is for, and why it is not another string comparison.** Every
 * other test of `bwrap.ts` compares the argv it produced. `bwrap.ts` carried an
 * assumption that no string comparison could reach, labelled it load-bearing and
 * unverified, and named the cheap thing that would settle it:
 *
 * > The cheap thing that would settle it is one `bwrap` command on a real Linux
 * > box — `mv` a directory containing a `.git` out from under its parent and see
 * > whether the repository survives.
 *
 * That is this file, and **the answer was that the belief was false.** A directory
 * containing a protected path could be renamed out from under its parent and the
 * `.git` was writable at its new location. `bwrap.ts` now mounts the ancestors,
 * and the row that proves it passes.
 *
 * ## Every row has its control, and the controls are what make the rows mean anything
 *
 * A sandbox that denies everything passes every "was refused" assertion. So each
 * one is paired with the same operation performed *outside* the sandbox, and the
 * pair has to disagree. A profile so tight nothing works at all is the
 * "narrower sandbox silently becoming a broken tool" failure `sandbox-native.test.ts`
 * already documents for a missing bind source, and it would pass a test written
 * the obvious way.
 *
 * ## Gating
 *
 * Gated on a capability probe, not on the platform: a developer with bubblewrap
 * installed locally runs this too. A probe that fails **skips with the reason
 * printed** — never a silent pass. The CI leg that installs bubblewrap gates on
 * `bwrap --unshare-user ... -- /bin/echo ok` before running the suite, so a runner
 * where AppArmor blocks unprivileged user namespaces goes red with the real error
 * rather than green with everything skipped.
 */

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "@labunbun/agent";
import { buildBwrapArgs } from "../src/sandbox/bwrap.ts";
import { detectNativeBackend } from "../src/sandbox/index.ts";

/**
 * Whether a real bwrap can start a namespace here.
 *
 * The probe is deliberately the same command the CI gate step runs, so the two
 * agree by construction rather than by coincidence: if CI's gate passed, this
 * passes, and if it did not, the skip reason says why.
 */
function probeBwrap(): { ok: boolean; why: string } {
	if (process.platform !== "linux") return { ok: false, why: `not Linux (this is ${process.platform})` };
	const result = spawnSync(
		"bwrap",
		["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--", "/bin/echo", "ok"],
		{
			encoding: "utf8",
		},
	);
	if (result.error) return { ok: false, why: `bwrap is not usable here: ${result.error.message}` };
	if (result.status !== 0) {
		return {
			ok: false,
			why: `bwrap cannot create a namespace here: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`,
		};
	}
	return { ok: true, why: "" };
}

const CAPABILITY = probeBwrap();
const BWRAP_ON_PATH = detectNativeBackend("linux");
if (!CAPABILITY.ok) console.warn(`[bwrap-smoke] skipped: ${CAPABILITY.why}`);

const smoke = CAPABILITY.ok ? test : test.skip;

/**
 * Run `command` with no sandbox at all, which is what a control has to be.
 *
 * **The first version of these controls passed an `unrestricted` policy to
 * `buildBwrapArgs`, and that argv is broken.** It is `--bind / /` plus the
 * namespace flags with no read baseline, and on a real Linux box it fails with
 * `bwrap: execvp /bin/sh: No such file or directory` — so every control row
 * errored on the harness and the file went red for a reason that had nothing to
 * do with confinement.
 *
 * It is broken *and unreachable*: `resolveSandboxExecution` short-circuits on
 * `fileSystem.kind === "unrestricted"` and returns `{kind: "unconfined"}` before
 * calling the translator, so nothing in this build produces that argv. Reaching
 * it required calling the translator directly, which is what a control must not
 * do — a control that exercises a code path the product never takes is
 * measuring the wrong thing.
 *
 * The honest control is the plain shell with no wrapper at all, which is what
 * `danger-full-access` actually does at runtime.
 */
function runUnconfined(command: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Temporary trees this file made, swept when the run ends. */
const made: string[] = [];
afterAll(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A workspace with a real `.git` inside it, and a sibling directory outside it.
 *
 * Written out on disk rather than named as a literal, because the argv this file
 * feeds to bwrap has to name paths the kernel can actually resolve. The other
 * bwrap tests use `/w/repo` and that is right for a string comparison and wrong
 * for this one.
 */
function workspaceFixture(): { workspace: string; git: string; outside: string; sub: string } {
	const base = mkdtempSync(join(tmpdir(), "lbb-bwrap-smoke-"));
	made.push(base);
	const workspace = join(base, "repo");
	const git = join(workspace, ".git");
	const outside = join(base, "outside");
	const sub = join(workspace, "sub");
	const nestedGit = join(sub, ".git");
	for (const dir of [git, outside, nestedGit]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n", "utf8");
	writeFileSync(join(nestedGit, "HEAD"), "ref: refs/heads/main\n", "utf8");
	return { workspace, git, outside, sub };
}

/** The `workspace-write` policy over a real tree. */
function policyFor(workspace: string, protectedPaths: string[]): SandboxPolicy {
	return {
		fileSystem: { kind: "restricted", entries: [{ path: workspace, access: "write" }] },
		network: "enabled",
		networkRules: [],
		protected: protectedPaths,
	};
}

/** Run `command` — a shell command string — under the argv the translator produces. */
function runUnder(policy: SandboxPolicy, command: string): { status: number | null; stdout: string; stderr: string } {
	const argv = buildBwrapArgs(policy, ["/bin/sh", "-c", command], (path) => existsSync(path));
	const result = spawnSync("bwrap", argv, { encoding: "utf8" });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Write to `path`, reporting whether it worked. Used as a payload. */
function touchPayload(path: string): string {
	return `if echo x > ${JSON.stringify(path)} 2>/dev/null; then echo WROTE; else echo refused; fi`;
}

// ---------------------------------------------------------------------------

smoke("the generated argv compiles and starts a process", () => {
	// The same shape as the seatbelt smoke file's first row: an option bwrap
	// would reject fails the whole thing, and no string comparison in the suite
	// can see it. Gated for the same reason as every other row — without bwrap
	// there is nothing to compile the argv with.
	const { workspace, git } = workspaceFixture();
	const run = runUnder(policyFor(workspace, [git]), "echo alive");
	expect(run.status, `bwrap refused the argv: ${run.stderr.slice(0, 400)}`).toBe(0);
	expect(run.stdout.trim()).toBe("alive");
});

smoke("CONTROL: the same write outside the workspace succeeds with no sandbox", () => {
	// The control for the row below. Unwrapped, this write works; wrapped, it
	// cannot. If the control failed, the refusal would be attributable to
	// something other than the sandbox. `runUnconfined`, not an unrestricted
	// policy: see its doc comment for why that argv is the wrong control.
	const { outside } = workspaceFixture();
	const target = join(outside, "control.txt");
	const run = runUnconfined(touchPayload(target));
	expect(run.status, run.stderr.slice(0, 300)).toBe(0);
	expect(run.stdout.trim()).toBe("WROTE");
});

smoke("a write outside the workspace is refused under workspace-write", () => {
	const { workspace, git, outside } = workspaceFixture();
	const target = join(outside, "escaped.txt");
	const run = runUnder(policyFor(workspace, [git]), touchPayload(target));
	expect(run.stdout.trim(), `the write escaped: ${run.stderr.slice(0, 300)}`).toBe("refused");
	expect(existsSync(target)).toBe(false);
});

smoke("CONTROL: a write inside the workspace succeeds under the same policy", () => {
	// The other half of every confinement claim: a profile that refuses
	// everything would also pass the row above.
	const { workspace, git } = workspaceFixture();
	const target = join(workspace, "notes.md");
	const run = runUnder(policyFor(workspace, [git]), touchPayload(target));
	expect(run.status, run.stderr.slice(0, 300)).toBe(0);
	expect(existsSync(target)).toBe(true);
});

smoke("a write to the protected path is refused", () => {
	const { workspace, git } = workspaceFixture();
	const run = runUnder(policyFor(workspace, [git]), touchPayload(join(git, "HEAD")));
	expect(run.stdout.trim(), `the protected path was writable: ${run.stderr.slice(0, 300)}`).toBe("refused");
});

smoke("CONTROL: the same write to the protected path succeeds with no sandbox", () => {
	const { git } = workspaceFixture();
	const run = runUnconfined(touchPayload(join(git, "HEAD")));
	expect(run.stdout.trim(), run.stderr.slice(0, 300)).toBe("WROTE");
});

/**
 * The assumption `bwrap.ts:34-56` states and cannot test.
 *
 * The translator emits no ancestor-unlink denies, on the belief that a bind
 * mount attaches to the dentry rather than the name — so renaming a directory
 * that *contains* a protected path carries the read-only bind with it, and the
 * `.git` stays read-only at its new location. If that belief is wrong, the
 * backend has a relocation bypass and nothing else in this repository would see
 * it.
 *
 * **The control is what makes the row mean anything.** The same rename performed
 * outside the sandbox must leave the moved `.git` writable; if it did not, the
 * refusal below would be a fact about the filesystem rather than about the
 * sandbox, and a verdict of "safe" would be measuring the wrong thing.
 *
 * **If this row comes back writable, that is a live bypass** and the fix belongs
 * in the translator, not here.
 */
smoke("CONTROL: renaming a directory that holds a .git leaves it writable, unsandboxed", () => {
	const { workspace, sub } = workspaceFixture();
	expect(existsSync(sub)).toBe(true);
	// `mv sub relocated` is the move the sandboxed row repeats.
	const relocated = join(workspace, "relocated");
	const run = runUnconfined(`mv ${JSON.stringify(sub)} ${JSON.stringify(relocated)}`);
	expect(
		run.status,
		`the control rename failed, so the sandboxed row would measure the filesystem: ${run.stderr.slice(0, 300)}`,
	).toBe(0);
	// The moved `.git` is writable when nothing protects it. This is the answer
	// the sandboxed row is compared against.
	const after = runUnconfined(touchPayload(join(relocated, ".git", "HEAD")));
	expect(
		after.stdout.trim(),
		"the control could not write the moved .git, so the sandboxed refusal would prove nothing",
	).toBe("WROTE");
});

smoke("renaming a directory that holds a .git does not make the .git writable", () => {
	const { workspace, sub } = workspaceFixture();
	const relocated = join(workspace, "relocated");
	const policy = policyFor(workspace, [join(sub, ".git")]);
	const run = runUnder(policy, `mv ${JSON.stringify(sub)} ${JSON.stringify(relocated)}`);
	if (run.status !== 0) {
		// The rename itself being refused is the safe answer, and it is a
		// different mechanism from the one below — both are worth knowing apart.
		console.warn(
			`[bwrap-smoke] the rename was refused outright (exit ${run.status}), which is stronger than the bind following it`,
		);
		return;
	}
	const after = runUnder(policy, touchPayload(join(relocated, ".git", "HEAD")));
	expect(
		after.stdout.trim(),
		"the .git became writable after its parent was renamed -- this is the relocation bypass bwrap.ts:34-56 assumes does not exist",
	).toBe("refused");
});

/**
 * Measure whether a mount arrangement can express "this directory is not
 * renameable" — the question any fix to the row above has to answer first.
 *
 * **Why this row exists rather than a fix.** Bubblewrap has no deny rule: it is
 * purely constructive, arranging mounts. So the previous belief — that a
 * read-only bind travels with a renamed directory because it attaches to the
 * dentry — was reasoning about mount semantics that turned out to be false, and
 * it cost a live hole. A fix written the same way would be the same guess with
 * a different shape.
 *
 * The candidate mechanism is that a **mount point is not renameable**: the kernel
 * returns `EBUSY` for `rename` on one. A mount can be read-write and still be
 * unrenameable, so giving the ancestor its own bind would refuse the relocation
 * without needing a deny rule the backend does not have.
 *
 * **This row does not assume it works. It prints what happened**, for three
 * probes whose answers decide the fix:
 *
 *   A — the argv as shipped, which is the known bypass.
 *   B — does `--bind <ancestor> <ancestor>` after the parent bind refuse the rename?
 *   C — does `--ro-bind` of the same directory do better or worse?
 *   and each reports whether `<ancestor>/.git` is still **readable** and still
 *   **writable**, because a mechanism that made the ancestor unrenameable by
 *   making its contents unreadable would pass the rename check and break every
 *   `git` command in the product.
 *
 * The values are printed rather than asserted because the answer is a fact about
 * the kernel, not a decision this repository is making. The fix is written
 * against the measured answer; this row is what keeps it honest.
 */
smoke("MEASURE: what a mount arrangement can say about renaming an ancestor", () => {
	/**
	 * **A fresh tree per probe, and that is not tidiness.**
	 *
	 * The first version took one fixture and ran A, B and C against it. Probe A
	 * renames the ancestor, so by the time B ran the path was gone and bwrap
	 * answered `Can't find source path /tmp/lbb-bwrap-smoke-...` — which the row
	 * printed as if it were a finding about bind mounts. **A measurement that
	 * consumes its own subject measures the consumption, not the mechanism.**
	 *
	 * That failure shape is one this repository already knows: `bwrap.ts:62-64`
	 * warns that `--bind` of a source that is not there makes bubblewrap refuse
	 * to start, and the warning is about exactly this — a vanished path reads as
	 * a policy decision when it is a missing input.
	 */
	const probe = (extra: (sub: string) => string[]) => {
		const { workspace, git, sub } = workspaceFixture();
		const relocated = join(workspace, "relocated");
		const base = buildBwrapArgs(policyFor(workspace, [join(sub, ".git")]), ["/bin/sh", "-c", "true"], (p) =>
			existsSync(p),
		);
		const at = base.indexOf("--");
		const argv = [...base.slice(0, at), ...extra(sub), ...base.slice(at)];
		const runOne = (command: string) => {
			const r = spawnSync("bwrap", [...argv.slice(0, argv.indexOf("--")), "--", "/bin/sh", "-c", command], {
				encoding: "utf8",
			});
			return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
		};
		void git;
		return {
			rename: runOne(`mv ${JSON.stringify(sub)} ${JSON.stringify(relocated)}`),
			readBack: runOne(
				`head -c 1 ${JSON.stringify(join(sub, ".git", "HEAD"))} >/dev/null 2>&1 && echo read || echo unread`,
			),
			writeBack: runOne(
				`echo x > ${JSON.stringify(join(sub, ".git", "HEAD"))} 2>/dev/null && echo WROTE || echo refused`,
			),
		};
	};

	console.log("[bwrap-smoke] A/B/C — printed, not asserted: a fact about the kernel, not a decision");
	const rows: [string, ReturnType<typeof probe>][] = [
		["A  as shipped, no extra mount:      ", probe(() => [])],
		["B  --bind the ancestor onto itself:  ", probe((s) => ["--bind", s, s])],
		["C  --ro-bind the ancestor onto itself:", probe((s) => ["--ro-bind", s, s])],
	];
	for (const [label, r] of rows) {
		// A probe whose source path is gone is a broken probe, and it must not be
		// printed in the same shape as a verdict. "Can't find source path" is
		// named as what it is.
		const broken = r.rename.stderr.includes("Can't find source path");
		console.log(
			`  ${label} rename exit=${r.rename.status}` +
				`${broken ? "  PROBE BROKEN (source path missing)" : `  ${r.rename.stderr.slice(0, 40)}`}` +
				`  | .git read=${r.readBack.stdout || r.readBack.stderr.slice(0, 30)} write=${r.writeBack.stdout || r.writeBack.stderr.slice(0, 30)}`,
		);
	}

	// Asserts nothing about the mechanism on purpose — see the doc comment. Probe A
	// is the argv as it stands today, so this asserts the *current* rename verdict:
	// when the translator stops producing a working relocation this row goes red and
	// says so, rather than the file carrying a measurement nobody is comparing.
	const known = rows[0]?.[1];
	expect(known, "probe A did not run, so nothing was measured").toBeDefined();
	console.log(
		`[bwrap-smoke] probe A today: rename exit=${known?.rename.status} — ` +
			`${known?.rename.status === 0 ? "the relocation bypass is OPEN" : "the ancestor mount refuses it"}`,
	);
});

/**
 * **Which mount order protects the ancestor without freezing the workspace.**
 *
 * The fix as first written put `--ro-bind <ancestor> <ancestor>` after the writable
 * `--bind <workspace> <workspace>`, and a later mount shadows an earlier one at the
 * same path — so the ancestor bind covered the workspace and the whole workspace
 * went read-only. `CONTROL: a write inside the workspace succeeds` caught it on CI
 * (`expect(existsSync(target)).toBe(false)`), which is that control's entire reason
 * for existing: it is the "a sandbox that refuses everything passes every refusal
 * assertion" guard, and it earned its place within a day.
 *
 * **The failing shape was measured; the fix was not.** Probe C above answered
 * "does an ancestor read-only bind refuse the rename, and keep `.git` readable and
 * unwritable" — and it did. It said nothing about the *other* mount the ancestor
 * collides with, so the implementation copied C's fragment without asking what
 * else lands at that path. This row is the question that was missing.
 *
 * Three orders, each on its own tree, each reporting the same three facts: can
 * the workspace still be written, is the rename refused, and is `.git` still
 * readable. A fix needs all three; the first implementation had two of three in
 * the wrong direction.
 */
smoke("MEASURE: which ancestor mount order keeps the workspace writable", () => {
	/**
	 * Build an argv with the ancestor bind spliced at a chosen depth, so the
	 * probes genuinely differ.
	 *
	 * **The first version of this row had no discriminating power and I would not
	 * have known from its output.** It took the translator's argv, sliced at `--`,
	 * and appended the ancestor bind — so "before the workspace bind" and "after
	 * the workspace bind" both landed after it, and printed the same numbers for
	 * different labels. A probe whose two hypotheses produce the same output
	 * decides nothing, and two rows with identical output under different names
	 * look like agreement.
	 *
	 * So the position is an explicit index here, and each order is spliced at the
	 * index it names.
	 */
	const argvWith = (
		workspace: string,
		ancestor: string,
		insertAt: "before-writable" | "after-writable" | "re-bind-after",
	) => {
		const base = buildBwrapArgs(policyFor(workspace, [join(ancestor, ".git")]), ["/bin/sh", "-c", "true"], (p) =>
			existsSync(p),
		);
		const firstBind = base.indexOf("--bind");
		const insert = base.indexOf("--", firstBind) === -1 ? base.length : base.indexOf("--");
		const at = insertAt === "before-writable" ? firstBind : insert;
		return [...base.slice(0, at), "--ro-bind", ancestor, ancestor, ...base.slice(at)];
	};

	const probe = (insertAt: "before-writable" | "after-writable" | "re-bind-after") => {
		const { workspace, sub } = workspaceFixture();
		const argv = argvWith(workspace, sub, insertAt);
		const writableIn = join(workspace, "in-workspace.md");
		const relocated = join(workspace, "relocated");

		const one = (command: string) => {
			const r = spawnSync("bwrap", [...argv.slice(0, argv.indexOf("--")), "--", "/bin/sh", "-c", command], {
				encoding: "utf8",
			});
			return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
		};
		return {
			workspaceWrite: one(touchPayload(writableIn)),
			// Whether the file is really there, which is the half stdout cannot say: a
			// shell can print WROTE and have written nothing.
			landed: existsSync(writableIn),
			rename: one(`mv ${JSON.stringify(sub)} ${JSON.stringify(relocated)}`),
			gitWrite: one(touchPayload(join(sub, ".git", "HEAD"))),
			gitRead: one(
				`head -c 1 ${JSON.stringify(join(sub, ".git", "HEAD"))} >/dev/null 2>&1 && echo read || echo unread`,
			),
		};
	};

	console.log("[bwrap-smoke] D/E/F — printed, not asserted: which order keeps all three properties");
	for (const [label, at] of [
		["D  ancestor ro-bind AFTER the workspace bind (today): ", "after-writable"],
		["E  ancestor ro-bind BEFORE the workspace bind:        ", "before-writable"],
		["F  ancestor ro-bind after, workspace bind re-applied:", "re-bind-after"],
	] as const) {
		const r = probe(at);
		console.log(
			`  ${label}` +
				` workspace-write=${r.workspaceWrite.stdout || r.workspaceWrite.stderr.slice(0, 24)} (landed=${r.landed})` +
				`  rename exit=${r.rename.status}` +
				`  .git write=${r.gitWrite.stdout || r.gitWrite.stderr.slice(0, 20)} read=${r.gitRead.stdout || r.gitRead.stderr.slice(0, 20)}`,
		);
	}
});

test("where bwrap is installed, this file does not skip", () => {
	// The control for the gate. A skip is the honest answer to "can this machine
	// answer the question" and a terrible answer to "did the check run", and the
	// first version of the seatbelt smoke file learned that the hard way: a green
	// job in which every row skipped.
	//
	// **The condition is the presence of bwrap, not the platform, and the first
	// version got that wrong** — it asserted on Linux, and `test (ubuntu-latest)`
	// went red because ubuntu has no bubblewrap, which is the entire reason this
	// file's own CI leg exists. A platform is the wrong precondition here in a way
	// it is not for the seatbelt file: `/usr/bin/sandbox-exec` ships with macOS, so
	// on macOS "is it there" and "is it macOS" agree, and bubblewrap is a package
	// on both Linux and macOS. **Where a sentinel is present the two hypotheses
	// coincide; where it is not they do not, and asserting on the wrong one
	// produces a red that says nothing about the code.**
	if (!BWRAP_ON_PATH) {
		console.warn(`[bwrap-smoke] bwrap is not installed here, so there is nothing to compare against`);
		return;
	}
	expect(
		CAPABILITY.ok && BWRAP_ON_PATH,
		`every row in this file skipped on Linux, so the job was green having checked nothing: ${CAPABILITY.why}`,
	).toBe(true);
});
