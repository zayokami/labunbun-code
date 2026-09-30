/**
 * Choosing a backend for a policy, and saying which one was chosen.
 *
 * The translators next door are pure: policy in, argv out. This module is the
 * part that knows what machine it is on, what is installed, and — the part that
 * matters most — what to tell the user when the answer is "nothing here is
 * actually confining your commands".
 *
 * Four outcomes, not two, because collapsing them is how a build ends up
 * describing a tool-layer check as a sandbox:
 *
 *   `native`       a real OS backend wraps the shell (macOS seatbelt, Linux bwrap)
 *   `simulated`    no argv backend exists on this platform; what applies is the
 *                  tool-layer path policy, and a subprocess that goes around the
 *                  tools is not subject to it
 *   `unavailable`  a backend exists for this platform but is not installed. The
 *                  command still runs — refusing every command on a machine that
 *                  never installed bubblewrap would be a worse failure than the
 *                  one being guarded — and the reason is reported so the user is
 *                  not left believing they are confined
 *   `unconfined`   the policy says so, and nothing is wrapped
 *
 * The last three all mean "your command is not being confined by this layer", so
 * the distinction between them is for the *report*, not for the argv. Collapsing
 * them into a boolean is precisely how a simulated layer starts reading as a
 * real one.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { buildSandboxPolicy, type NetworkAxis, type SandboxMode, type SandboxPolicy } from "@labunbun/agent";
import { buildBwrapArgs } from "./bwrap.ts";
import { buildSeatbeltArgs } from "./seatbelt.ts";
import { SIMULATED_SANDBOX_DISCLAIMER } from "./simulated.ts";

/**
 * How to confine a command, expressed as the argv that does it.
 *
 * `argv` replaces nothing: the shell and its own arguments are appended after a
 * `--` separator, so the wrapper wraps *the shell* rather than being wrapped by
 * it. That direction is not a detail. A sandbox placed inside the command line
 * confines whatever the shell chooses to run, which on a POSIX line is anything
 * at all — `bash -c` re-execs, background jobs escape, and a wrapper that only
 * sees the outer shell's argv has already lost. Codex composes them the same way
 * (`sandboxing/src/seatbelt.rs`: `["-p", profile, …, "--", …command]`).
 *
 * This type lives here rather than beside `ExecOperations` so that this module
 * does not have to import the one that calls it.
 */
export interface SandboxExecution {
	/** Program plus its own arguments. The shell follows, after `--`. */
	argv: string[];
	/**
	 * True when no OS-level backend applies and the confinement is this process's
	 * own decision about calls that arrive through the tools.
	 *
	 * Carried rather than inferred so a caller can say so to the user instead of
	 * describing a tool-layer check as a sandbox.
	 */
	simulated: boolean;
}

export type SandboxPlatform = "darwin" | "linux" | "win32" | string;

export type SandboxResolution =
	| { kind: "native"; execution: SandboxExecution; program: string }
	| { kind: "simulated"; reason: string }
	| { kind: "unavailable"; reason: string }
	| { kind: "unconfined" };

export interface ResolveSandboxOptions {
	/**
	 * The policy to realise. Built by the caller from a `SandboxMode`, so this
	 * function has one job — pick a backend — and does not also decide what the
	 * mode means. Two places building a policy would be two answers.
	 */
	policy: SandboxPolicy;
	/**
	 * The argv to enclose, normally the shell and its own arguments. This module
	 * cannot build it: only `ChildProcessExecOperations` knows which shell was
	 * resolved, and a wrapper around the wrong shell is no wrapper at all.
	 */
	command: string[];
	platform?: SandboxPlatform;
	/** Whether the platform's native backend is installed. Injected so this is testable. */
	hasNativeBackend?: boolean;
	/**
	 * Whether a path exists. Injected for the same reason as the flag above: the
	 * `missingPathBehavior` filter below has to run before a translator, and a
	 * translator that could see the filesystem would stop being pure.
	 */
	exists?: (path: string) => boolean;
}

/** Build the policy for a mode. Exported so callers and tests share one answer. */
export function policyFor(options: {
	sandbox: SandboxMode;
	workspace: string;
	protectedPaths?: string[];
	readOnlyRoots?: string[];
	writableRoots?: string[];
	/** The network axis. Both halves, or the caller has to say why it has none. */
	network?: NetworkAxis;
}): SandboxPolicy {
	return buildSandboxPolicy({
		sandbox: options.sandbox,
		workspace: options.workspace,
		protectedPaths: options.protectedPaths,
		readOnlyRoots: options.readOnlyRoots,
		// Forwarded, and it was not: this function accepted `writableRoots` and
		// dropped it on the floor, so every caller that named a writable root —
		// `workspacePolicy` included — got a policy without it. Narrower than
		// asked for, so nothing leaked, but a root a user was told was writable
		// was not. The type kept accepting the argument the whole time, which is
		// why no error ever pointed at it.
		writableRoots: options.writableRoots,
		network: options.network?.access,
		networkRules: options.network?.domains,
	});
}

/**
 * Whether this platform has an argv-level backend at all.
 *
 * Windows is `false` and is not going to become `true` in this build: the
 * alternatives are compiling a helper and registering a Windows service, or
 * using the MXC container runner, and the user ruled both out. Saying so here,
 * in one place, is what keeps the answer from being re-derived — hopefully
 * wrongly — further along.
 */
export function hasNativeSandboxBackend(platform: SandboxPlatform): boolean {
	return platform === "darwin" || platform === "linux";
}

/** The program each native backend wraps with, for the availability check. */
export function nativeSandboxProgram(platform: SandboxPlatform): string {
	return platform === "darwin" ? "/usr/bin/sandbox-exec" : "bwrap";
}

/**
 * Whether the native backend is actually installed, by looking for it.
 *
 * `sandbox-exec` is at a fixed absolute path on macOS and is part of the OS, so
 * that one is a single check. `bwrap` is a distribution package on Linux, so it
 * is a PATH scan — and the answer genuinely varies by machine, which is why
 * `MISSING_BWRAP_WARNING` is a real state Codex has to handle and not a
 * theoretical one.
 */
export function detectNativeBackend(platform: SandboxPlatform, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!hasNativeSandboxBackend(platform)) return false;
	if (platform === "darwin") return existsSync("/usr/bin/sandbox-exec");
	for (const entry of (env.PATH ?? "").split(delimiter)) {
		const dir = entry.trim();
		if (dir === "") continue;
		if (existsSync(join(dir, "bwrap"))) return true;
	}
	return false;
}

/**
 * The two facts a resolution needs, read once.
 *
 * Bundled into a value rather than passed as loose arguments so the spawn path
 * and the reporting path cannot be given different answers: the sentence in
 * `/permissions` and the argv in `exec` both come from one `SandboxRuntime`, and
 * the test seam is the same for both. Constructing one by hand is how a test
 * reaches the "Linux, and bubblewrap is there" branch from a machine that has
 * neither.
 */
export interface SandboxRuntime {
	platform: SandboxPlatform;
	hasNativeBackend: boolean;
}

/** This machine's runtime. One PATH scan, at construction, not per command. */
export function detectRuntime(platform: SandboxPlatform = process.platform): SandboxRuntime {
	return { platform, hasNativeBackend: detectNativeBackend(platform) };
}

/**
 * Pick a backend and build the argv for it.
 *
 * `hasNativeBackend` is a parameter rather than a PATH probe so that every branch
 * here is reachable from a test on any machine. The real caller passes the
 * result of checking for the program, and the two are kept honest by
 * `operations.test.ts` asserting the wiring rather than this function asserting
 * its own inputs.
 */
export function resolveSandboxExecution(options: ResolveSandboxOptions): SandboxResolution {
	const platform = options.platform ?? process.platform;
	const { policy } = options;

	// Checked before the platform question, because `danger-full-access` is not
	// "a sandbox with a very wide allow list" — it is the absence of one, and
	// reporting it as a wrapped-but-permissive sandbox would be a lie in the
	// direction that matters.
	if (policy.fileSystem.kind === "unrestricted") return { kind: "unconfined" };

	if (!hasNativeSandboxBackend(platform)) {
		return {
			kind: "simulated",
			reason:
				"this platform has no filesystem-sandbox backend in this build, and adding one means a helper program, which is out of scope here. What actually applies is the tool-layer path policy, the deny rules, and the dangerous-command classifier — a subprocess started outside the tools is not subject to any of them",
		};
	}

	const installed = options.hasNativeBackend ?? true;
	if (!installed) {
		return {
			kind: "unavailable",
			reason: `${nativeSandboxProgram(platform)} is not on PATH, so commands run without filesystem confinement. The deny rules and the dangerous-command classifier still apply — they are in this process, not in the kernel — but the workspace boundary is not being enforced`,
		};
	}

	const present = presentEntries(policy, options.exists ?? ((path) => existsSync(path)));

	// Both translators return the argv *after* the program name — that is how
	// Codex returns them too (`seatbelt.rs:1087`, `bwrap.rs:248`) — so the program
	// is named here and nowhere else. Absolute for `sandbox-exec`, which must be
	// the system binary: resolving it through `PATH` is how a wrapper gets
	// substituted.
	const program = nativeSandboxProgram(platform);
	const args =
		platform === "darwin" ? buildSeatbeltArgs(present, options.command) : buildBwrapArgs(present, options.command);

	return { kind: "native", execution: { argv: [program, ...args], simulated: false }, program };
}

/**
 * The policy with its `skip`-marked entries that do not exist removed.
 *
 * Both translators are pure, so neither can do this, and both say so on
 * themselves — a comment on a function naming a contract its caller has not
 * implemented is worse than no comment, because the next reader trusts it.
 *
 * It is not cosmetic on the Linux side. bubblewrap fails to start when a `--bind`
 * source is absent, so a policy naming a build cache that was never created would
 * turn into a shell that does not run at all — a narrower sandbox becoming a
 * broken tool, on the machine least able to see why. Under seatbelt the same
 * entry is harmless (a `subpath` filter matching nothing grants nothing), but the
 * filter is applied for both so the policy a caller passed is the policy a
 * backend got, whichever platform that turns out to be.
 *
 * Entries not marked `skip` are left alone whatever their status: a workspace
 * that does not exist is a broken session, and quietly dropping it would confine
 * the session to nothing and report success.
 */
function presentEntries(policy: SandboxPolicy, exists: (path: string) => boolean): SandboxPolicy {
	return {
		...policy,
		fileSystem: {
			...policy.fileSystem,
			entries: policy.fileSystem.entries.filter((entry) => entry.missingPathBehavior !== "skip" || exists(entry.path)),
		},
	};
}

/** What confines a command on this machine. See `ChildProcessExecOperations.sandboxBackend`. */
export type SandboxBackend = "native" | "simulated" | "unavailable";

/**
 * The backend this machine would get, from the two facts that decide it.
 *
 * A function of its platform rather than a read of `process.platform` inside, so
 * that the "Linux without bubblewrap" case — the one that decides whether a user
 * is told a lie — is reachable from a test running on any machine, including the
 * Windows one this was written on.
 */
export function sandboxBackendFor(platform: SandboxPlatform, hasNativeBackend: boolean): SandboxBackend {
	if (!hasNativeSandboxBackend(platform)) return "simulated";
	return hasNativeBackend ? "native" : "unavailable";
}

/**
 * One sentence saying what the sandbox is actually doing here.
 *
 * This is the text `/permissions` prints, and it is written per case rather than
 * as one hedged sentence covering all of them, because the three confined cases
 * are genuinely different facts and averaging them is how a simulated layer
 * starts reading as a real one. A user who is told "sandbox on" on a machine
 * where nothing is confined has been told something false, and the only defence
 * is that this sentence is derived from the same resolution the argv is.
 *
 * `backend` is `undefined` for an `Operations` implementation that does not
 * report one — a test fake, or an embedder's own executor. It is treated as
 * `simulated`, because the honest reading of "I do not know what confines this"
 * is "nothing I can point at", and the alternative would let an unreported
 * backend render as a real one.
 */
export function describeSandboxBackend(
	backend: SandboxBackend | undefined,
	sandbox: SandboxMode,
	platform: SandboxPlatform = process.platform,
): string {
	// Asked first because it is true in all three backend cases: an unrestricted
	// policy wraps nothing on macOS with `sandbox-exec` sitting right there, so
	// "native" must not be allowed to imply confinement on its own.
	if (sandbox === "danger-full-access") {
		return "Sandbox: off. This mode asks about nothing and confines nothing at the filesystem level — the deny rules and the dangerous-command classifier are the only limits, and they sit above every mode.";
	}
	switch (backend) {
		case "native":
			return `Sandbox: enforced by the OS. Commands run under ${nativeSandboxProgram(platform)}, confined to the workspace, with version-control metadata refused for writing. This holds at the kernel, however the process tree is arranged.`;
		case "unavailable":
			return `Sandbox: not enforced. ${nativeSandboxProgram(platform)} is not installed here, so commands run without filesystem confinement. The deny rules and the dangerous-command classifier still apply — they live in this process — but the workspace boundary is not being held.`;
		default:
			return `Sandbox: simulated, not OS-enforced. This build ships no filesystem-sandbox backend for this platform, and adding one would mean a helper program, which is out of scope. Writes are ${SIMULATED_SANDBOX_DISCLAIMER}. The deny rules and the dangerous-command classifier are separate and still apply.`;
	}
}
