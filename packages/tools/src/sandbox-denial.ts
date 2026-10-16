/**
 * Whether a failed command reads as the sandbox refusing an operation.
 *
 * A kernel refusal travels spelled as an errno message — `Operation not
 * permitted` from the macOS profile and from bubblewrap's read-only mounts,
 * `Access is denied.` from the Windows container — and the command's own
 * failures arrive in the same two streams. Nothing here can separate the two
 * with certainty, and the user is the only party who knows whether the command
 * should have worked. So this predicate decides nothing. It labels one hedge
 * the Bash tool prints beside a failure: which axes were in force, and where
 * the policy and the way out are stated.
 */
import type { SandboxBackend, SandboxPlatform } from "./sandbox/index.ts";

/**
 * The words a refusal travels as.
 *
 * The generic entries cost little and cover the kinds of program a refused
 * command may be: a process refused at the syscall layer names `seccomp` or
 * `landlock`, a sandboxed helper names `sandbox` itself, and a tool that
 * tried to write says `failed to write file`. The last entry is the Windows
 * spelling — a child that reports its errno the Windows way says `Access is
 * denied.` where the POSIX side says `Permission denied`.
 */
const SANDBOX_DENIED_KEYWORDS = [
	"operation not permitted",
	"permission denied",
	"read-only file system",
	"seccomp",
	"sandbox",
	"landlock",
	"failed to write file",
	"access is denied",
] as const;

/** The facts of a finished command this question reads. */
export interface SandboxDenialFacts {
	/** The exit code, or `null` for a command that never ended — a handoff. */
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * Whether `facts` read as the sandbox refusing the operation rather than the
 * command failing on its own.
 *
 * The gate is asked first: a run no kernel backend confined — no policy, or a
 * resolution that came back `simulated` or `unavailable` — cannot have failed
 * *because of* the sandbox, and the tool-layer refusals say their own name in
 * words. Only a `native` or `appcontainer` run is a candidate.
 *
 * Past the gate the read leans loose, because a refusal usually travels
 * through a shell that wraps it in its own words: any keyword in either
 * stream counts, case-insensitively. The quick-reject codes (2, 126, 127) are
 * never consulted as codes — `127 command not found` is a fact about the
 * shell — but an exit 126 carrying `Permission denied` does count, and that
 * is the shape an exec refusal takes.
 *
 * The one signal read: a command killed by `SIGSYS` while wrapped. That is
 * the signal a sandbox refusing at the syscall layer delivers, and the shell
 * spells it 128+31 on Linux and 128+12 on macOS — the number is the
 * platform's, so it is read per platform. Windows shells do not spell signal
 * deaths this way, so there it is the keywords alone.
 */
export function likelySandboxDenied(
	facts: SandboxDenialFacts,
	backend: SandboxBackend | undefined,
	platform: SandboxPlatform = process.platform,
): boolean {
	if (backend !== "native" && backend !== "appcontainer") return false;
	if (facts.exitCode === null || facts.exitCode === 0) return false;

	// SIGSYS is 31 on Linux and 12 on macOS, so its exit-code spelling differs:
	// 159 there is `128+31`, and on macOS 159 would be SIGUSR2 — the mirror
	// image holds for 140. Reading the number per platform is the whole reason
	// this function takes one.
	const sigsysExit = platform === "linux" ? 159 : platform === "darwin" ? 140 : undefined;
	if (sigsysExit !== undefined && facts.exitCode === sigsysExit) return true;

	const haystack = `${facts.stdout}\n${facts.stderr}`.toLowerCase();
	return SANDBOX_DENIED_KEYWORDS.some((needle) => haystack.includes(needle));
}
