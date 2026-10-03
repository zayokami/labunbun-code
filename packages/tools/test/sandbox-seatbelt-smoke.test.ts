/**
 * Run the generated seatbelt profile through a real `sandbox-exec`.
 *
 * **Why this file exists, and why it is not a fourth translator test.** Every
 * other test of `seatbelt.ts` compares a string. That catches a drifted rule and
 * nothing else: `seatbelt.ts:87-89` says so itself — *"the tests here compare
 * generated strings, and only a Mac parses SBPL, so a name this profile would
 * reject is invisible to the whole suite."*
 *
 * That blind spot has already cost this repository a defect that seven green CI
 * runs did not see. With no `sysctl` rule at all under the `(deny default)`, a
 * JavaScript runtime died during startup: exit 133, SIGTRAP, **both streams
 * empty**. The Bash tool reported `[exit code: 0]`, and a test asserting that a
 * command's output arrives saw nothing. `/bin/echo` under the identical profile
 * was fine — because it queries nothing, which is what pinned the fault on the
 * runtime's startup rather than on `exec`.
 *
 * **The lesson this file encodes.** Asserting "did not throw" would have passed
 * that incident. So the runtime rows assert **stdout carries the string**, not
 * merely that the exit code is zero. An empty stream with a plausible exit code
 * is the exact failure this repository treats as the expensive one, and it is the
 * one a smoke test is uniquely able to catch.
 *
 * ## Gating, and why it is a capability probe and not a platform check
 *
 * `sandbox-exec` is at a fixed absolute path and ships with the OS, so the
 * platform would do. The probe is used anyway because it also distinguishes
 * "absent" from "present but refusing to start", and those want different
 * sentences. A probe that fails **skips with the reason printed** — it never
 * passes silently, which is the convention `ci.yml:16-18` already sets for the
 * vim differential suite (`exit 77 = did not compare`, which has not earned a
 * pass).
 *
 * On a Linux or Windows box this whole file skips, and the skip says why: there
 * is no `sandbox-exec` here to compare against. The other test file is the one
 * that runs everywhere.
 */

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "@labunbun/agent";
import { buildSeatbeltArgs } from "../src/sandbox/seatbelt.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Whether a real `sandbox-exec` can run here, and why not when it cannot.
 *
 * **This profile grants `process-exec`, and the first version of it did not.**
 * That is not a detail — it is what made the gate lie.
 *
 * The probe used `(deny default)(allow file-read*)` and `/usr/bin/true`. On
 * `macos-latest` that returned non-zero with
 * `execvp() of '/usr/bin/true' failed: Operation not permitted`, so every row in
 * this file skipped and **the CI job was green having checked nothing at all**.
 * `deny default` covers `process-exec`, so a profile that grants reads and
 * nothing else refuses to start any program — and the probe was reading its own
 * refusal as "this machine cannot run sandbox-exec".
 *
 * The lesson is the one this file exists to apply: **a probe that fails for a
 * reason of its own making is indistinguishable from a machine that cannot
 * answer the question.** A gate that is wrong in the skipping direction does not
 * announce itself; it reports green. So the probe's profile has to be one the
 * mechanism is actually expected to accept, which is the minimum that starts a
 * process: read, exec, and the process control needed to reach them.
 */
function probeSandboxExec(): { ok: boolean; why: string } {
	if (process.platform !== "darwin") return { ok: false, why: `not macOS (this is ${process.platform})` };
	const PROBE_PROFILE = [
		"(version 1)",
		"(deny default)",
		"(allow process-fork)",
		"(allow process-exec)",
		"(allow signal (target same-sandbox))",
		"(allow sysctl-read)",
		"(allow file-read*)",
		'(allow file-ioctl (literal "/dev/null"))',
	].join("\n");
	const result = spawnSync(SANDBOX_EXEC, ["-p", PROBE_PROFILE, "--", "/usr/bin/true"], {
		encoding: "utf8",
	});
	if (result.error) return { ok: false, why: `${SANDBOX_EXEC} could not be run: ${result.error.message}` };
	if (result.status !== 0) {
		return {
			ok: false,
			why: `${SANDBOX_EXEC} could not start a process here: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`,
		};
	}
	return { ok: true, why: "" };
}

const CAPABILITY = probeSandboxExec();
if (!CAPABILITY.ok) console.warn(`[seatbelt-smoke] skipped: ${CAPABILITY.why}`);

const smoke = CAPABILITY.ok ? test : test.skip;

/**
 * On macOS a skip means this file checked nothing, and that must not be green.
 *
 * **The first version of this gate shipped exactly that way.** `macos-latest`
 * reported success on all eight jobs while every row here skipped, because the
 * probe profile lacked `process-exec` and so refused to start its own command.
 * A skip is the honest answer to "can this machine answer the question", but it
 * is a terrible answer to "did the check run", and the two are not the same
 * question.
 *
 * `test (macos-latest)` has a real `/usr/bin/sandbox-exec` — the path is fixed
 * and it ships with the OS — so a skip *there* means the probe is wrong, not the
 * machine. This row is that assertion. It is the control for the gate: without
 * it, the gate can only ever report success by skipping.
 *
 * Non-macOS platforms still skip: there is no `sandbox-exec` to compare against,
 * and `sandbox-native.test.ts` is the file that runs everywhere.
 */
test("on macOS this file does not skip", () => {
	if (process.platform !== "darwin") {
		console.warn(
			`[seatbelt-smoke] not macOS (this is ${process.platform}); there is no sandbox-exec to compare against`,
		);
		return;
	}
	expect(
		CAPABILITY.ok,
		`every row in this file skipped on a platform that HAS sandbox-exec, so the job was green having checked nothing: ${CAPABILITY.why}`,
	).toBe(true);
});

/** Temporary trees this file made, swept when the run ends. */
const made: string[] = [];
afterAll(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A workspace the policy can confine, with a `.git` inside it, under a real
 * temporary directory.
 *
 * The existing translator tests write their policy out literally against paths
 * that do not exist (`/w/repo`), which is right for a string comparison and
 * useless here: a profile naming a path the kernel cannot resolve is a
 * different thing to test. So this one is built by the builder and lands on disk.
 */
function workspaceFixture(): { workspace: string; git: string; outside: string } {
	const base = mkdtempSync(join(tmpdir(), "lbb-seatbelt-smoke-"));
	made.push(base);
	const workspace = join(base, "repo");
	const git = join(workspace, ".git");
	const outside = join(base, "outside");
	for (const dir of [workspace, git, outside]) {
		spawnSync("mkdir", ["-p", dir], { encoding: "utf8" });
	}
	return { workspace, git, outside };
}

/** The `workspace-write` policy over a real tree. */
function policyFor(workspace: string, git: string, network: "enabled" | "restricted"): SandboxPolicy {
	return {
		fileSystem: { kind: "restricted", entries: [{ path: workspace, access: "write" }] },
		network,
		networkRules: [],
		protected: [git],
	};
}

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Run `command` under the profile `policy` generates, with the real interpreter. */
function runUnder(policy: SandboxPolicy, command: string[]): Run {
	const argv = buildSeatbeltArgs(policy, command);
	// `-p` takes the profile as argv[1] and every `-D` follows it; the command is
	// after `--`. Reconstructing that here rather than re-deriving it means this
	// test exercises the argv the executor would actually spawn.
	const result = spawnSync(SANDBOX_EXEC, argv, { encoding: "utf8" });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The runtime under test: whatever is running this file. */
function interpreter(): { program: string } {
	return { program: process.execPath };
}

// ---------------------------------------------------------------------------

smoke("the profile this build generates compiles, for every policy shape", () => {
	// The failure this catches is an operation name SBPL does not define. The
	// symptom is `sandbox-exec` exiting 65 with a parser backtrace, which no
	// string comparison in the suite can see — and `seatbelt.ts` carries a real
	// example of one (`ipc-posix-sysv*`, which is not a family).
	const { workspace, git } = workspaceFixture();
	for (const network of ["enabled", "restricted"] as const) {
		const run = runUnder(policyFor(workspace, git, network), ["/usr/bin/true"]);
		expect(run.status, `profile for network=${network} did not compile: ${run.stderr.slice(0, 400)}`).toBe(0);
	}
});

smoke("a JavaScript runtime starts under the profile and its output arrives", () => {
	// The stdout assertion is the whole point. The SIGTRAP incident produced exit
	// 133 with both streams empty, and a test asserting only "did not throw"
	// would have called that a pass — so this asserts the string, not the code.
	const { workspace, git } = workspaceFixture();
	const { program } = interpreter();
	const run = runUnder(policyFor(workspace, git, "enabled"), [program, "-e", "process.stdout.write('alive')"]);

	expect(run.status, `runtime died under the profile, stderr: ${run.stderr.slice(0, 400)}`).toBe(0);
	// Not `toContain("alive")` on the combined streams: stderr carrying it would
	// be a different bug, and the check should be about the program speaking.
	expect(run.stdout).toBe("alive");
});

smoke("CONTROL: /bin/echo under the identical profile also succeeds", () => {
	// Without this the runtime row pins the fault on nothing — a profile that
	// denied everything would fail the runtime test for the same reason it
	// failed the incident, and the two hypotheses would be indistinguishable.
	// The pair differing is what makes the runtime row mean something.
	const { workspace, git } = workspaceFixture();
	const run = runUnder(policyFor(workspace, git, "enabled"), ["/bin/echo", "ok"]);
	expect(run.status).toBe(0);
	expect(run.stdout.trim()).toBe("ok");
});

smoke("CONTROL: the same runtime outside the sandbox also prints alive", () => {
	// The other half of the pair. If the runtime fails for an unrelated reason —
	// a bad path, a missing file, this test machine being broken — then the
	// sandboxed row above is measuring the machine, not the profile.
	const { program } = interpreter();
	const bare = spawnSync(program, ["-e", "process.stdout.write('alive')"], { encoding: "utf8" });
	expect(bare.status, `the runtime is broken on this machine, not by the profile: ${bare.stderr ?? ""}`).toBe(0);
	expect(bare.stdout).toBe("alive");
});

smoke("the workspace is writable inside the profile", () => {
	// The positive half of every confinement claim. A test that only asserts a
	// write was REFUSED passes against a profile so tight nothing can be written
	// at all — the "narrower sandbox silently becoming a broken tool" failure
	// `sandbox-native.test.ts` already documents for a missing bind source.
	const { workspace, git } = workspaceFixture();
	const target = join(workspace, "notes.md");
	const { program } = interpreter();
	const run = runUnder(policyFor(workspace, git, "enabled"), [
		program,
		"-e",
		`require("fs").writeFileSync(${JSON.stringify(target)}, "x")`,
	]);
	expect(run.status, `a write inside the workspace was refused: ${run.stderr.slice(0, 400)}`).toBe(0);
});

smoke("the protected path is not writable inside the profile", () => {
	// The `.git` boundary, asserted by the kernel rather than by the string. The
	// existing suite pins the rule's position in the profile; this pins that the
	// rule does what it says once the kernel has read it.
	const { workspace, git } = workspaceFixture();
	const target = join(git, "config");
	const { program } = interpreter();
	const run = runUnder(policyFor(workspace, git, "enabled"), [
		program,
		"-e",
		`try { require("fs").writeFileSync(${JSON.stringify(target)}, "x"); process.stdout.write("WROTE") } catch { process.stdout.write("refused") }`,
	]);
	expect(run.stdout, `a write to the protected path was not refused: ${run.stderr.slice(0, 400)}`).toBe("refused");
});

smoke("CONTROL: the same write outside the profile succeeds", () => {
	// The control for the row above, and the reason that row means something.
	const { git } = workspaceFixture();
	const target = join(git, "config");
	const { program } = interpreter();
	const bare = spawnSync(
		program,
		[
			"-e",
			`try { require("fs").writeFileSync(${JSON.stringify(target)}, "x"); process.stdout.write("WROTE") } catch { process.stdout.write("refused") }`,
		],
		{ encoding: "utf8" },
	);
	expect(bare.stdout, "the control write failed for an unrelated reason, so the sandboxed row proves nothing").toBe(
		"WROTE",
	);
});
