// Choosing a backend for a policy, and saying which one was chosen. Five outcomes,
// not two, because collapsing them is how a build starts describing a tool-layer
// check as a sandbox — and the sentence a user reads is derived, not carried here.
// Long-form design notes: docs/dev/sandbox.md
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
	buildSandboxPolicy,
	type NetworkAxis,
	type NetworkConfinement,
	type SandboxMode,
	type SandboxPolicy,
	type WritableRoot,
} from "@labunbun/agent";
import { buildBwrapArgs } from "./bwrap.ts";
import { buildSeatbeltArgs } from "./seatbelt.ts";
import { SIMULATED_SANDBOX_DISCLAIMER } from "./simulated.ts";

// Long-form design notes: docs/dev/sandbox.md
/** How to confine a command: the argv that does it, with the shell appended after `--`. */
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
	| {
			kind: "appcontainer";
			/**
			 * The workspace the container profile is derived from — and therefore
			 * the root whose grant the caller must hold before the spawn.
			 */
			workspace: string;
			// Long-form design notes: docs/dev/sandbox.md
			/** Every root the ACL grant must cover, the workspace first and each path once. */
			grantRoots: string[];
			/**
			 * Always `true`: the branch that returns this kind is reachable only
			 * with an `enabled` network axis, for the measured reason recorded
			 * on the branch itself.
			 */
			network: true;
	  }
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
	// Long-form design notes: docs/dev/sandbox.md
	/** Whether the Windows AppContainer backend is usable here. Injected, and defaults to `false`. */
	hasAppContainer?: boolean;
	/**
	 * Whether a path exists. Injected for the same reason as the flag above, and
	 * consulted for two decisions rather than one: the `missingPathBehavior` filter
	 * below runs before a translator, and the bwrap translator needs the answer for
	 * a protected path too. Neither is allowed to see the filesystem for itself, so
	 * neither being a translator that stops being pure is a cost worth paying twice.
	 */
	exists?: (path: string) => boolean;
}

/** Build the policy for a mode. Exported so callers and tests share one answer. */
export function policyFor(options: {
	sandbox: SandboxMode;
	workspace: string;
	protectedPaths?: string[];
	readOnlyRoots?: string[];
	// Long-form design notes: docs/dev/sandbox.md
	/** Directories the policy may write, each tagged; only a `project` root derives a `.git`. */
	writableRoots?: WritableRoot[];
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

// Long-form design notes: docs/dev/sandbox.md
/** Whether this platform has an argv-level backend at all. Windows does not, in this build. */
export function hasNativeSandboxBackend(platform: SandboxPlatform): boolean {
	return platform === "darwin" || platform === "linux";
}

/** The program each native backend wraps with, for the availability check. */
export function nativeSandboxProgram(platform: SandboxPlatform): string {
	return platform === "darwin" ? "/usr/bin/sandbox-exec" : "bwrap";
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether the native backend is installed: one check on macOS, a `PATH` scan on Linux. */
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
 * The facts a resolution needs, read once.
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
	// Long-form design notes: docs/dev/sandbox.md
	/** Whether production *selects* the Windows backend — off until the toolchain reaches the child. */
	hasAppContainer?: boolean;
}

// Long-form design notes: docs/dev/sandbox.md
/** This machine's runtime, from one `PATH` scan at construction. Deliberately does not probe AppContainer. */
export function detectRuntime(platform: SandboxPlatform = process.platform): SandboxRuntime {
	return {
		platform,
		hasNativeBackend: detectNativeBackend(platform),
	};
}

// Long-form design notes: docs/dev/sandbox.md
/** Pick a backend and build the argv for it. Every branch is reachable from a test on any machine. */
export function resolveSandboxExecution(options: ResolveSandboxOptions): SandboxResolution {
	const platform = options.platform ?? process.platform;
	const { policy } = options;

	// `danger-full-access` is the absence of a policy, not a very wide one, and
	// the network half does not change that: a restricted axis denies every route
	// off the machine, and the proxy shares the one route the shell could use.
	// Long-form design notes: docs/dev/sandbox.md
	if (policy.fileSystem.kind === "unrestricted") return { kind: "unconfined" };

	// One predicate, three callers, three uses: a `skip`-marked entry that is
	// missing is dropped, while a protected path that is missing is kept and
	// turned into an empty read-only mount.
	// Long-form design notes: docs/dev/sandbox.md
	const exists = options.exists ?? ((path: string) => existsSync(path));
	const present = presentEntries(policy, exists);

	// The AppContainer branch sits after the unrestricted short-circuit and
	// before the `hasNativeSandboxBackend` check, which answers false for win32.
	// The grant list covers every writable root and is read from `present`.
	// Long-form design notes: docs/dev/sandbox.md
	if (platform === "win32" && policy.network === "enabled" && (options.hasAppContainer ?? false)) {
		const writable = present.fileSystem.entries.filter((entry) => entry.access === "write");
		const workspace = writable.find((entry) => entry.missingPathBehavior !== "skip");
		if (workspace !== undefined) {
			return {
				kind: "appcontainer",
				workspace: workspace.path,
				grantRoots: [...new Set([workspace.path, ...writable.map((entry) => entry.path)])],
				network: true,
			};
		}
	}

	if (!hasNativeSandboxBackend(platform)) {
		return {
			kind: "simulated",
			reason:
				"this platform has no filesystem-sandbox backend in this build, and adding one means a helper program, which is out of scope here. What actually applies is the tool-layer path policy, the deny rules, and the dangerous-command classifier — a subprocess started outside the tools is not subject to any of them",
		};
	}

	// Defaults to *installed*: guessing "not installed" would run the command
	// with no wrapper at all — the fail-open. A spawn error is the correct side.
	// Long-form design notes: docs/dev/sandbox.md
	const installed = options.hasNativeBackend ?? true;
	if (!installed) {
		return {
			kind: "unavailable",
			reason: `${nativeSandboxProgram(platform)} is not on PATH, so commands run without filesystem confinement. The deny rules and the dangerous-command classifier still apply — they are in this process, not in the kernel — but the workspace boundary is not being enforced`,
		};
	}

	// Both translators return the argv *after* the program name, so the program
	// is named here and nowhere else. Absolute for `sandbox-exec`.
	// Long-form design notes: docs/dev/sandbox.md
	const program = nativeSandboxProgram(platform);
	const args =
		platform === "darwin"
			? buildSeatbeltArgs(present, options.command)
			: buildBwrapArgs(present, options.command, exists);

	return { kind: "native", execution: { argv: [program, ...args], simulated: false }, program };
}

// Long-form design notes: docs/dev/sandbox.md
/** The policy with its `skip`-marked entries that do not exist removed, for both translators. */
function presentEntries(policy: SandboxPolicy, exists: (path: string) => boolean): SandboxPolicy {
	return {
		...policy,
		fileSystem: {
			...policy.fileSystem,
			entries: policy.fileSystem.entries.filter((entry) => entry.missingPathBehavior !== "skip" || exists(entry.path)),
		},
	};
}

// Long-form design notes: docs/dev/sandbox.md
/** What confines a command on this machine. Four answers: the two Windows kinds are different facts. */
export type SandboxBackend = "native" | "simulated" | "unavailable" | "appcontainer";

// Long-form design notes: docs/dev/sandbox.md
/** The backend this machine would get, a function of its platform so every case is testable anywhere. */
export function sandboxBackendFor(
	platform: SandboxPlatform,
	hasNativeBackend: boolean,
	hasAppContainer = false,
): SandboxBackend {
	if (platform === "win32") return hasAppContainer ? "appcontainer" : "simulated";
	if (!hasNativeSandboxBackend(platform)) return "simulated";
	return hasNativeBackend ? "native" : "unavailable";
}

// Long-form design notes: docs/dev/sandbox.md
/** Which of `describeNetworkPolicy`'s caveats applies here. The question order is the function. */
export function networkConfinement(
	backend: SandboxBackend | undefined,
	sandbox: SandboxMode,
	network: "restricted" | "enabled",
): NetworkConfinement {
	if (network === "enabled") return "network-left-open";
	if (sandbox === "danger-full-access") return "filesystem-axis-off";
	if (backend === "native") return "os-namespace";
	if (backend === "unavailable") return "backend-missing";
	// `simulated`, an unreported backend, and `appcontainer` all land here. The
	// third is not an oversight — see the function's own doc for why a restricted
	// command under an appcontainer runtime is not kernel-confined.
	return "no-os-backend";
}

// Long-form design notes: docs/dev/sandbox.md
/** The sentence `/permissions` prints. Written per case; an unreported backend reads as simulated. */
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
			// A write-only claim, scoped to the mode rather than to the policy: both
			// backends start from an already-readable baseline, and the `.git`
			// sentence holds for every policy `buildSandboxPolicy` produces.
			// Long-form design notes: docs/dev/sandbox.md
			return `Sandbox: enforced by the OS. Commands run under ${nativeSandboxProgram(platform)}. The workspace boundary is a write boundary — version-control metadata is refused for writing — and this mode does not narrow reads, which start from the machine's own. The kernel is what holds this rather than this process, and it is attached to the process rather than to the command, so it survives however the process tree is arranged.`;
		case "appcontainer":
			// The `.git` promise is deliberately not repeated: the deny ACE is out,
			// so a confined command can write `.git` inside its grant. The
			// restricted-axis gap is stated in the fixed string.
			// Long-form design notes: docs/dev/sandbox.md
			return `Sandbox: enforced by the OS. Commands run in a Windows AppContainer profile derived from this workspace, and the kernel refuses a write outside the roots the policy grants — every writable root the session names, not only the workspace. The confinement is the child's own token rather than a wrapper around it, so it is attached to the process and survives however the process tree is arranged. This mode does not narrow reads. Version-control metadata is not protected by this backend: the deny ACE that would protect it is out until the timing anomaly in its measurement is understood, so a confined command can still write .git inside its grant and only the tool-layer rule refuses that, for calls that arrive through the tools. A restricted network axis is not confined by this backend either: the proxy that enforces it listens on loopback, which a container child cannot reach, so that command runs on the tool-layer policy and the proxy rather than being held here.`;
		case "unavailable":
			return `Sandbox: not enforced. ${nativeSandboxProgram(platform)} is not installed here, so commands run without filesystem confinement. The deny rules and the dangerous-command classifier still apply — they live in this process — but the workspace boundary is not being held.`;
		default:
			// "Calls that arrive through the tools" is about `Write` and `Edit`, and
			// not about `Bash` — which builds this same policy, hands it to `exec`, and
			// has it dropped unread the moment the resolution is not `native`. The
			// sentence is true as written; it is worth the comment here because the
			// gap is the kind a reader assumes is closed.
			return `Sandbox: simulated, not OS-enforced. This build ships no filesystem-sandbox backend for this platform, and adding one would mean a helper program, which is out of scope. Writes are ${SIMULATED_SANDBOX_DISCLAIMER}. The deny rules and the dangerous-command classifier are separate and still apply.`;
	}
}
