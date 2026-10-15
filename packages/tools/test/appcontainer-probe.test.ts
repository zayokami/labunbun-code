/**
 * The Windows selection probe, tested against the machine it describes.
 *
 * Three rings, and each one answers a question the other two cannot. The
 * classification rows are pure — the marker grammar and the exit codes are
 * properties of the script and of NTSTATUS, so they run everywhere. The seam
 * rows inject the one `runConfined` call, which makes a decline's wording and
 * a selection's shape reachable without a machine that can actually select;
 * the grant half stays real by design, so the seam does not make the probe's
 * own machinery the thing under test. The real rows run the probe end to end:
 * a session shell the container genuinely can execute (a positive control
 * every Windows machine can host) and one the machine genuinely has (its msys
 * bash, which every Git for Windows install ships) — skipped visibly, with
 * the skip count bun prints, when the machine has neither.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcessExecOperations, detectShell } from "../src/operations.ts";
import {
	classifyProbeRun,
	type ProbeRun,
	probeAppContainerSelection,
	probeCommandLine,
	probeWorkspacePath,
} from "../src/sandbox/appcontainer-probe.ts";
import { detectRuntime, sandboxBackendFor } from "../src/sandbox/index.ts";

describe("the probe script", () => {
	test("one chain: the shell's marker, each program with its own, the done marker last", () => {
		// The grammar `classifyProbeRun` reads back. `&&` is what makes the
		// output say how far the run got, and the marker pair around each
		// program is what names the one that failed rather than "something
		// after the shell did".
		expect(probeCommandLine(["C:\\Tools\\git.exe", "D:\\node\\node.exe"])).toBe(
			'echo LBB-PROBE-SHELL && "C:\\Tools\\git.exe" --version && echo LBB-PROBE-OK-0 && ' +
				'"D:\\node\\node.exe" --version && echo LBB-PROBE-OK-1 && echo LBB-PROBE-DONE',
		);
	});

	test("no programs is still the full frame: shell marker, then done", () => {
		expect(probeCommandLine([])).toBe("echo LBB-PROBE-SHELL && echo LBB-PROBE-DONE");
	});
});

describe("reading the one probe run", () => {
	const programs = ["D:\\Git\\git.exe", "C:\\node\\node.exe"];

	test("the done marker is the selection, whatever number rode beside it", () => {
		const verdict = classifyProbeRun(
			{ exitCode: 0, stdout: "LBB-PROBE-SHELL\nLBB-PROBE-OK-0\nLBB-PROBE-OK-1\nLBB-PROBE-DONE\n", stderr: "" },
			programs,
		);
		expect(verdict.ok).toBe(true);
	});

	test("a shell that died at startup is named in both exit-code spellings", () => {
		// The FFI surfaces the NTSTATUS as a signed 32-bit number and the raw
		// constant is unsigned; both spell 0xC0000142, and a check that missed
		// the sign would read the most common decline as a generic failure.
		for (const exitCode of [0xc0000142, -1073741502]) {
			const verdict = classifyProbeRun({ exitCode, stdout: "", stderr: "" }, programs);
			expect(verdict.ok).toBe(false);
			if (verdict.ok) return;
			expect(verdict.reason).toContain("0xC0000142");
			expect(verdict.reason).toContain("BaseNamedObjects");
			// The reason carries the way out, or it is a dead end for the reader.
			expect(verdict.reason).toContain("LBB_BASH_PATH");
		}
	});

	test("a shell that cannot load its dependencies is its own sentence, not the startup one", () => {
		const verdict = classifyProbeRun({ exitCode: 0xc0000135, stdout: "", stderr: "" }, programs);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.reason).toContain("0xC0000135");
		expect(verdict.reason).toContain("STATUS_DLL_NOT_FOUND");
		expect(verdict.reason).not.toContain("BaseNamedObjects");
	});

	test("a program that died at process start blames the program, not the shell that ran it", () => {
		// `cmd` propagates the child's exit code, so 0xC0000142 can arrive with
		// the shell marker already printed — a msys-based `git.exe` under a
		// granted root dies exactly this way. Reading the code before the
		// markers would tell a cmd-shell user their shell died at startup and
		// send them to `LBB_BASH_PATH`, which changes nothing they have.
		const verdict = classifyProbeRun({ exitCode: 0xc0000142, stdout: "LBB-PROBE-SHELL\n", stderr: "" }, programs);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.reason).toContain("could not run D:\\Git\\git.exe");
		expect(verdict.reason).toContain("(0xC0000142)");
		expect(verdict.reason).not.toContain("the session's shell");
		expect(verdict.reason).not.toContain("LBB_BASH_PATH");
	});

	test("a shell that ran and a program that did not names the program, with the output tail as evidence", () => {
		const verdict = classifyProbeRun(
			{ exitCode: 1, stdout: "LBB-PROBE-SHELL\nLBB-PROBE-OK-0\n", stderr: "bash: D:\\node\\node.exe: No such file\n" },
			programs,
		);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		// The second program never printed its marker; the first did, so the
		// blame is the program and not the shell.
		expect(verdict.reason).toContain("could not run C:\\node\\node.exe");
		expect(verdict.reason).toContain("at exit 1");
		expect(verdict.reason).toContain("No such file");
	});

	test("a probe child that never started says so, rather than blaming the container", () => {
		const verdict = classifyProbeRun({ exitCode: -1, stdout: "", stderr: "", error: "spawn refused" }, programs);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.reason).toContain("could not start");
		expect(verdict.reason).toContain("spawn refused");
	});

	test("an unmarked end is the generic sentence, carrying the exit and the tail", () => {
		const verdict = classifyProbeRun({ exitCode: 0xc0000005, stdout: "", stderr: "the last words" }, programs);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.reason).toContain(String(0xc0000005 >>> 0));
		expect(verdict.reason).toContain("the last words");
	});
});

test.skipIf(process.platform === "win32")(
	"off Windows the probe declines by platform, before any machine state is read",
	() => {
		const result = probeAppContainerSelection({ command: "cmd.exe", args: (cmd) => ["/c", cmd] });
		expect(result.available).toBe(false);
		expect(result.reason).toContain("only on Windows");
		expect(result.executableRoots).toEqual([]);
	},
);

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("the probe against this machine", () => {
	/** Recorded by the seam, so the rows can assert what the probe handed the runner. */
	interface SeamCall {
		commandLine: string;
		cwd?: string;
		timeoutMs?: number;
	}

	/** The one injected `runConfined`: answers with a fixed run, records its call. */
	function seam(run: ProbeRun, calls: SeamCall[]): Parameters<typeof probeAppContainerSelection>[2] {
		return ((_profile: unknown, commandLine: string, options?: { cwd?: string; timeoutMs?: number }) => {
			calls.push({ commandLine, cwd: options?.cwd, timeoutMs: options?.timeoutMs });
			return { ...run, killed: false };
		}) as unknown as Parameters<typeof probeAppContainerSelection>[2];
	}

	// The shell every Windows machine can host: System32's own, which the
	// container executes without any grant. The env strips the two inputs the
	// probe reads out of it — the toolchain scan and the `~\.bun` fallback —
	// so the grant under test is the probe workspace alone, on every machine.
	const cmdShell = { command: "C:\\Windows\\System32\\cmd.exe", args: (cmd: string) => ["/d", "/s", "/c", cmd] };
	const toolchainFree = {
		...process.env,
		PATH: "C:\\Windows\\System32",
		USERPROFILE: join(tmpdir(), `lbb-probe-nohome-${process.pid}`),
	};

	test("the seam decides by the run's shape, and the script it ran is the resolved one", () => {
		const calls: SeamCall[] = [];
		const selected = probeAppContainerSelection(
			cmdShell,
			toolchainFree,
			seam({ exitCode: 0, stdout: "LBB-PROBE-SHELL\nLBB-PROBE-DONE\n", stderr: "" }, calls),
		);
		expect(selected.available).toBe(true);
		expect(selected.executableRoots).toEqual([]);
		expect(calls.length).toBe(1);
		// The command line is the shell with the script — the same shape
		// production hands a confined child, not a special probe program.
		expect(calls[0].commandLine).toContain("C:\\Windows\\System32\\cmd.exe");
		expect(calls[0].commandLine).toContain("LBB-PROBE-SHELL");
		expect(calls[0].commandLine).toContain("LBB-PROBE-DONE");
		// The cwd is the granted workspace, canonicalised — on the runner TEMP
		// is spelled 8.3 (`RUNNER~1`), and a raw path here would hand the child
		// a directory its grant does not cover. Compared against `realpathSync`
		// rather than the module's own canonicaliser, so the check is not the
		// thing it checks.
		expect(calls[0].cwd).toBe(realpathSync(probeWorkspacePath()));
		expect(calls[0].timeoutMs).toBeGreaterThan(0);
	});

	test("a fake run that died of BaseNamedObjects declines with that reason, and nothing else", () => {
		const declined = probeAppContainerSelection(
			cmdShell,
			toolchainFree,
			seam({ exitCode: 0xc0000142, stdout: "", stderr: "" }, []),
		);
		expect(declined.available).toBe(false);
		expect(declined.reason).toContain("BaseNamedObjects");
		// A decline carries no roots: they are the grant a selection promised,
		// and there is no selection.
		expect(declined.executableRoots).toEqual([]);
	});

	test("the real thing: the container must run this shell once, and System32's cmd is that shell", () => {
		// The positive control the whole probe rests on, with no seam: a real
		// grant on the probe workspace, then one real confined spawn. Every
		// Windows machine can host it, which is why it is the row that pins
		// "a selection means the shell actually started inside the container"
		// rather than "the arithmetic around it was consistent".
		const result = probeAppContainerSelection(cmdShell, toolchainFree);
		expect(result.available, result.reason).toBe(true);
		expect(result.executableRoots).toEqual([]);
	});

	const gitBash = [
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
		"D:\\Program Files\\Git\\bin\\bash.exe",
		"D:\\Program Files\\Git\\usr\\bin\\bash.exe",
	].find((candidate) => existsSync(candidate));

	test.skipIf(gitBash === undefined)("the machine's own msys shell declines, with a reason a reader can act on", () => {
		// No fake here either. Two measured ending shapes, and the row accepts
		// both because both are honest: where the toolchain root cannot be
		// reached (a `D:\Program Files` ACL the user cannot rewrite), the grant
		// itself fails and the spawn never happens; where the root is reachable
		// (the system drive's own program directory), the spawn happens and the
		// msys runtime dies on BaseNamedObjects. Which one this machine gives
		// is the machine's answer, not the test's.
		const result = probeAppContainerSelection(
			{ command: gitBash as string, args: (cmd) => ["-lc", cmd] },
			toolchainFree,
		);
		expect(result.available).toBe(false);
		expect(result.reason ?? "").toMatch(/SetNamedSecurityInfoW|BaseNamedObjects/);
		expect(result.executableRoots).toEqual([]);
	});

	test("the default executor's answer and the runtime's are one answer, probe included", () => {
		// The production shape: a bare `ChildProcessExecOperations` resolves
		// the shell first and asks `detectRuntime` about this machine — the
		// same question `/permissions` prints its sentence from. The per-process
		// probe cache is what keeps the construction cheap here, and it must
		// not break the equality: two constructions in one process are one
		// machine.
		const runtime = detectRuntime(process.platform, detectShell());
		const ops = new ChildProcessExecOperations();
		expect(ops.sandboxBackend).toBe(sandboxBackendFor("win32", false, runtime.hasAppContainer ?? false));
		expect(ops.appContainerReason).toBe(runtime.appContainerReason);
		if (runtime.hasAppContainer === true) {
			// Selected: there is nothing to explain.
			expect(ops.appContainerReason).toBeUndefined();
		} else {
			// Declined: the reason is the probe's own, not a placeholder.
			expect(ops.appContainerReason ?? "").not.toBe("");
		}
	});
});
