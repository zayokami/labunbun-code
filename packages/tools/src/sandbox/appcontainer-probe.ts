// The Windows backend's selection probe: whether production should put this
// session's commands inside the container, decided by running them there once.
// Long-form design notes: docs/dev/sandbox.md

/**
 * No cheaper answer is honest. An image a command names can be opened from
 * outside the container whatever the container's own token could do with it,
 * so path arithmetic proves nothing; and the profile, the ACLs and the spawn
 * machinery can all succeed while the shell itself dies at process start —
 * measured: the msys family dies with `0xC0000142` (its runtime needs
 * `BaseNamedObjects`, which the container denies and no grant restores). The
 * one question — "would this session's commands run confined on this
 * machine?" — is answered the way production answers it: grant what
 * production grants (the workspace and the toolchain roots), then run the
 * session's shell, one real spawn, and classify what came back.
 *
 * A decline costs the grant attempt alone: when the roots cannot be made
 * reachable the throwaway spawn is skipped, which is the point of asking
 * before selecting. The probe workspace is one fixed directory under the
 * temp dir, so the profile it creates is one deterministic profile reused by
 * every run — nothing accumulates.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireWorkspaceGrant,
	appContainerAvailable,
	canonicalPathForChild,
	confinedCommandLine,
	confinedEnvBlock,
	confinedProgramName,
	releaseWorkspaceGrant,
	runConfined,
} from "./appcontainer.ts";
import { detectExecutableRoots, resolveToolchainPrograms } from "./toolchain-roots.ts";

/** What the probe needs from a shell: how to name it, how to make it run one command. */
export interface ProbeShell {
	command: string;
	args: (cmd: string) => string[];
}

export interface AppContainerProbeResult {
	/** True when production can put this session's commands inside the container. */
	available: boolean;
	/** Why not, in one sentence a reader can act on. Undefined on success. */
	reason?: string;
	/** The read+execute roots a confined command needs; the roots the probe verified. */
	executableRoots: readonly string[];
}

/** Printed once the shell itself is running — its absence is what a shell that died at startup looks like. */
const SHELL_MARKER = "LBB-PROBE-SHELL";
/** Printed after every listed program has run — the success marker. */
const DONE_MARKER = "LBB-PROBE-DONE";
/** Printed after the program at that index ran — which of them failed, when one did. */
function okMarker(index: number): string {
	return `LBB-PROBE-OK-${index}`;
}

/**
 * The one command the probe runs inside the container: the shell's own start
 * as the first marker, every toolchain program with its success marker after
 * it, and the done marker last. `&&` chaining makes the output say how far it
 * got; the double-quoting around each program survives both cmd's and POSIX
 * shells' parsing, and a program path in these positions is the machine's
 * own (resolved from `PATH`), never text a user typed.
 */
export function probeCommandLine(programs: readonly string[]): string {
	const steps = [`echo ${SHELL_MARKER}`];
	programs.forEach((program, index) => {
		steps.push(`"${program}" --version`);
		steps.push(`echo ${okMarker(index)}`);
	});
	steps.push(`echo ${DONE_MARKER}`);
	return steps.join(" && ");
}

/** The shape `runConfined` returns, as far as the classification reads it. */
export interface ProbeRun {
	exitCode: number;
	stdout: string;
	stderr: string;
	error?: string;
}

/** How the probe run ended, as one of the shapes the runtime reports. */
export type ProbeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Read the one probe run. The markers say how far the script got; the exit
 * codes say why the shell never got that far. Both win32 codes are checked
 * unsigned — the FFI surfaces them as signed 32-bit numbers.
 */
export function classifyProbeRun(run: ProbeRun, programs: readonly string[]): ProbeVerdict {
	const unsigned = run.exitCode >>> 0;
	const output = `${run.stdout}\n${run.stderr}`.trim();
	if (run.error !== undefined) {
		return { ok: false, reason: `the probe child could not start: ${run.error}` };
	}
	if (output.includes(DONE_MARKER)) return { ok: true };
	if (output.includes(SHELL_MARKER)) {
		// The shell ran, so a missing marker belongs to the program at that
		// index — and so does the exit code beside it. `cmd` propagates its
		// child's code, so the same 0xC0000142 that means "the shell died at
		// startup" when no marker was printed means "this program's own
		// runtime died at process start" when one was (measured: a msys-based
		// program under a granted root dies exactly this way). Programs can
		// also fail on a dependency the grant does not cover, which is why
		// every one of them runs for real.
		for (let index = 0; index < programs.length; index += 1) {
			if (!output.includes(okMarker(index))) {
				const startupDeath =
					unsigned === 0xc0000142
						? " — its own runtime died at process start inside the container (0xC0000142), the same wall the msys family hits"
						: "";
				const detail = output.length > 0 ? `: ${output.slice(-300)}` : "";
				return {
					ok: false,
					reason: `the container could not run ${programs[index]} (the probe ended at exit ${unsigned})${startupDeath}${detail}`,
				};
			}
		}
	}
	// No shell marker: the codes below describe the shell itself, which never
	// printed its first line.
	if (unsigned === 0xc0000142) {
		return {
			ok: false,
			reason:
				"the session's shell dies inside the container at startup (0xC0000142, STATUS_DLL_INIT_FAILED): " +
				"the msys-based shells need BaseNamedObjects, which the container denies and no grant restores. " +
				"Point the session's shell at one the container can run — LBB_BASH_PATH=C:\\Windows\\System32\\cmd.exe — " +
				"and the container is selected; until then the session's commands run outside it",
		};
	}
	if (unsigned === 0xc0000135) {
		return {
			ok: false,
			reason:
				"the session's shell cannot load its own dependencies inside the container (0xC0000135, " +
				"STATUS_DLL_NOT_FOUND) — a shell outside C:\\Windows\\System32 must keep its runtime beside it",
		};
	}
	return {
		ok: false,
		reason: `the container probe ended with exit ${unsigned}${output.length > 0 ? `: ${output.slice(-300)}` : ""}`,
	};
}

const PROBE_WORKSPACE_NAME = "lbb-container-probe";
const PROBE_TIMEOUT_MS = 15_000;

/** The fixed probe workspace: deterministic, so the profile it anchors is one profile, reused. */
export function probeWorkspacePath(): string {
	return join(tmpdir(), PROBE_WORKSPACE_NAME);
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * Whether production should select the container for this machine and shell,
 * and why not when it should not. The `run` seam is the one `runConfined`
 * call — injectable so the classification has tests on every platform; the
 * grant half has no seam on purpose, because stubbing it would make the
 * probe's own answer the thing under test.
 */
export function probeAppContainerSelection(
	shell: ProbeShell | null | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
	run: typeof runConfined = runConfined,
): AppContainerProbeResult {
	if (process.platform !== "win32") {
		return { available: false, reason: "the container backend exists only on Windows hosts", executableRoots: [] };
	}
	if (!appContainerAvailable()) {
		return {
			available: false,
			reason: "userenv.dll and kernel32 are not loadable, so the container API is unavailable",
			executableRoots: [],
		};
	}
	if (shell === null || shell === undefined) {
		return {
			available: false,
			reason: "no shell was resolved to probe, so the container cannot be judged for this session",
			executableRoots: [],
		};
	}
	const shellProgram = confinedProgramName(shell.command);
	const roots = detectExecutableRoots(shell.command, env);
	const workspace = probeWorkspacePath();
	try {
		mkdirSync(workspace, { recursive: true });
	} catch (error) {
		return {
			available: false,
			reason: `the probe workspace could not be created: ${String(error)}`,
			executableRoots: [],
		};
	}
	// The same call production makes before a confined command, with the same
	// all-or-nothing rule: a root this fails on is a root production would
	// fail on, and declining now is the difference between a session that runs
	// outside the container and one whose every command errors on a grant.
	const grant = acquireWorkspaceGrant(workspace, true, [], roots);
	if (grant.error !== undefined || grant.profile === undefined) {
		return {
			available: false,
			reason:
				`the container cannot reach this machine's toolchain: ${grant.error ?? "the profile could not be established"}. ` +
				'A toolchain root the user cannot rewrite the ACL of (measured: an elevated "D:\\Program Files") has no ' +
				"path into the container; a toolchain under the user profile, or one under a program directory the " +
				"system drive already exposes to application packages, does",
			executableRoots: [],
		};
	}
	// The shell itself is the spawn below, so the script runs only the resolved
	// toolchain programs — through the same resolver the roots came from.
	const programs = resolveToolchainPrograms(null, env);
	const envBlock = confinedEnvBlock(
		Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	);
	let verdict: ProbeVerdict;
	try {
		const confined = run(
			grant.profile,
			confinedCommandLine([shellProgram, ...shell.args(probeCommandLine(programs))]),
			{
				cwd: canonicalPathForChild(workspace),
				env: envBlock,
				timeoutMs: PROBE_TIMEOUT_MS,
			},
		);
		verdict = classifyProbeRun(confined, programs);
	} finally {
		// One acquire, one release, whatever the spawn did.
		releaseWorkspaceGrant(workspace, true);
	}
	if (!verdict.ok) return { available: false, reason: verdict.reason, executableRoots: [] };
	return { available: true, executableRoots: roots };
}
