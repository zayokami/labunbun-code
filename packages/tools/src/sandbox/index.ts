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
	permitsNoWrites,
	type SandboxMode,
	type SandboxPolicy,
	type WritableRoot,
} from "@labunbun/agent";
import { canonicalPathForChild, isWithinRoot } from "./appcontainer.ts";
import { type ProbeShell, probeAppContainerSelection } from "./appcontainer-probe.ts";
import type { UnixBridge } from "./bridge.ts";
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
			 * Toolchain install roots outside the policy, granted read+execute and
			 * never write. A separate list because the mask differs — a program
			 * that needs executing is not a program that may be edited.
			 */
			executableRoots: string[];
			/**
			 * Protected paths inside the grant — a `<root>/.git` and whatever the
			 * scan found. The grant narrows each one for the container on the
			 * allow side (a deny is inert against a container token, measured) and
			 * writes the original ACE list back on release. A path outside every
			 * grant root is dropped here rather than carried: the narrowing
			 * refuses domains it does not own, and a resolution must not ask for
			 * one.
			 */
			protectedRoots: string[];
			/**
			 * Always `true`: the branch that returns this kind is reachable only
			 * with an `enabled` network axis, for the measured reason recorded
			 * on the branch itself.
			 */
			network: true;
	  }
	/**
	 * The command does not run. The policy permits no write, and no backend this
	 * machine has can hold that. The reason is what the model and the user read.
	 * Only the read-only policy produces it, and only where no wrapper can be
	 * placed — see `resolveSandboxExecution`.
	 */
	| { kind: "refused"; reason: string }
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
	/**
	 * Toolchain roots to grant read+execute under the Windows backend, carried by
	 * the runtime rather than derived here: where a machine's shell and programs
	 * live is a question about that machine, which this module cannot see.
	 */
	executableRoots?: readonly string[];
	/**
	 * Loopback ports the confined command must still reach: the proxy that
	 * enforces a restricted network axis listens on them, and the macOS
	 * profile expresses that by denying every route and then permitting the
	 * proxy's own ports. The caller starts that proxy first and passes its
	 * ports here; with none, the profile stays a dead network, which is the
	 * fail-closed shape. Bubblewrap does not read them — on Linux the same
	 * reach is carried by `networkBridge` instead — and the Windows container
	 * branch is reachable only with an open axis.
	 */
	networkPorts?: readonly number[];
	/**
	 * The host side of the Linux loopback bridge, when one is running. A
	 * bubblewrap namespace denies every route off the machine, the proxy
	 * included, so the bridge is the one route back: a process inside the
	 * namespace listens on the proxy's own ports and forwards over a Unix
	 * socket to this side. With no bridge the namespace stays a dead network —
	 * the fail-closed shape, same as no ports on macOS. Only the Linux backend
	 * consumes it.
	 */
	networkBridge?: UnixBridge;
	platform?: SandboxPlatform;
	/** Whether the platform's native backend is installed. Injected so this is testable. */
	hasNativeBackend?: boolean;
	// Long-form design notes: docs/dev/sandbox.md
	/** Whether the Windows AppContainer backend is usable here. Injected, and defaults to `false`. */
	hasAppContainer?: boolean;
	/**
	 * Why the container probe declined, carried so the `simulated` reason can be
	 * the probe's own answer rather than a guess about it. Only read on Windows.
	 */
	appContainerReason?: string;
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
/**
 * Whether this platform has an argv-level backend — one that wraps a command
 * by placing a program before it (`bwrap`, `sandbox-exec`). Windows has no
 * such backend: its confinement is the container, which is a spawn-time
 * property rather than an argv prefix, and lives behind
 * `probeAppContainerSelection`.
 */
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
	/** Whether production *selects* the Windows backend — decided by the probe, not by an import. */
	hasAppContainer?: boolean;
	/**
	 * Toolchain roots granted read+execute when the Windows backend runs. Carried
	 * here rather than derived at spawn time so the probe that decides
	 * `hasAppContainer` and the grant that makes it true are answers to one
	 * question about one machine.
	 */
	executableRoots?: readonly string[];
	/**
	 * Why the Windows backend is not selected, when the probe declined. Reported
	 * to the user, never acted on — a reason is not a fallback.
	 */
	appContainerReason?: string;
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * This machine's runtime: one `PATH` scan on every platform, and on Windows
 * also the container selection probe — the profile, the grants and one real
 * spawn of the session's shell, classified (see `appcontainer-probe.ts` for
 * why nothing cheaper is honest). A declined probe carries its reason so the
 * sentence `/permissions` and `/doctor` print is the same answer the spawn
 * branch took. `shell` is optional so tests can judge a machine without one;
 * production resolves the shell first and passes it.
 *
 * The Windows probe is deferred until one of its three fields is first read.
 * A probe writes ACLs, and a single write against a large tree costs seconds —
 * measured 2026-10-15, the probe workspace plus a doomed toolchain root was
 * ~1.3 s of write-then-rollback, and a grant that reaches a big install tree
 * under the user profile cost ~16 s of inheritance propagation. Eagerly that
 * bill lands on every construction, and constructions sit on the REPL startup
 * path, whose measured budget (408 ms, docs/dev/sandbox.md) seconds do not
 * fit. Deferred, the first reader pays it — the first Bash command or the
 * first `/permissions` — and `probeOnce` keeps it once per process.
 */
export function detectRuntime(
	platform: SandboxPlatform = process.platform,
	shell: ProbeShell | null = null,
): SandboxRuntime {
	const runtime: SandboxRuntime = {
		platform,
		hasNativeBackend: detectNativeBackend(platform),
	};
	if (platform === "win32") {
		// The fields are getters, so reading one and running the probe are the
		// same act: a runtime nobody reads never pays, and every reader — the
		// backend sentence, the reason line, the spawn branch — sees the one
		// cached answer. The values are what the eager shape produced.
		let probed: ReturnType<typeof probeAppContainerSelection> | undefined;
		const probe = () => {
			probed ??= probeOnce(shell);
			return probed;
		};
		Object.defineProperties(runtime, {
			hasAppContainer: { get: () => probe().available, enumerable: true },
			appContainerReason: { get: () => (probe().available ? undefined : probe().reason), enumerable: true },
			executableRoots: { get: () => (probe().available ? probe().executableRoots : undefined), enumerable: true },
		});
	}
	return runtime;
}

/**
 * One probe per process and machine state. The answer is a property of the
 * machine, and the default constructors this feeds run per tool set — a test
 * run builds dozens, and each would otherwise pay an ACL grant and a spawn
 * that cannot give a different answer. The key is every input the probe
 * reads, so a caller that changed the environment still gets its own probe;
 * the same inputs on the same machine cannot mean two things inside one
 * process.
 */
let win32ProbeCache: { key: string; probe: ReturnType<typeof probeAppContainerSelection> } | null = null;

function probeOnce(shell: ProbeShell | null): ReturnType<typeof probeAppContainerSelection> {
	const env = process.env;
	const key = [
		shell?.command ?? "",
		env.PATH ?? "",
		env.USERPROFILE ?? "",
		env.SystemRoot ?? "",
		env.windir ?? "",
		env.LBB_BASH_PATH ?? "",
	].join("\u0000");
	if (win32ProbeCache !== null && win32ProbeCache.key === key) return win32ProbeCache.probe;
	const probe = probeAppContainerSelection(shell);
	win32ProbeCache = { key, probe };
	return probe;
}

/**
 * The policy's protected paths that sit strictly inside some grant root, judged
 * by the same rule the narrowing itself enforces (`isWithinRoot` in
 * `appcontainer.ts`): both sides canonicalised — links, junctions and 8.3 names
 * resolved — then compared case-insensitively across a separator boundary.
 *
 * The previous lexical `startsWith` compared the policy's spelling of the root
 * with `findProtectedPaths`' realpath spelling. A workspace opened through a
 * junction or a differently-cased path therefore dropped its nested
 * repositories' `.git` directories, and the inheritable workspace ACE stayed on
 * exactly the directories the grant exists to narrow. A protected path outside
 * every root — or equal to one, which would ask the grant to narrow the whole
 * workspace — is still dropped here rather than carried: the narrowing refuses
 * domains it does not own, and a resolution must not ask for one.
 */
function protectedWithinGrant(paths: readonly string[], grantRoots: readonly string[]): string[] {
	const roots = grantRoots.map((root) => canonicalPathForChild(root));
	return paths.filter((path) => {
		const canonical = canonicalPathForChild(path);
		return roots.some((root) => isWithinRoot(canonical, root));
	});
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

	// A policy that permits no write can only be held by a wrapper. The container branch below grants
	// writes, and an unwrapped spawn writes anywhere the user can, so where no wrapper can be placed the
	// command is refused rather than run. This reads the declared policy, not `present`, so a missing
	// skip-marked root cannot change the answer.
	if (permitsNoWrites(policy) && !(hasNativeSandboxBackend(platform) && (options.hasNativeBackend ?? true))) {
		return { kind: "refused", reason: readOnlyRefusal(platform) };
	}

	// The AppContainer branch sits after the unrestricted short-circuit and
	// before the `hasNativeSandboxBackend` check, which answers false for win32.
	// The grant list covers every writable root and is read from `present`.
	// The policy's protected paths ride along, filtered to the grant: the grant
	// is what narrows them, and it may only narrow what it owns.
	// Long-form design notes: docs/dev/sandbox.md
	if (platform === "win32" && policy.network === "enabled" && (options.hasAppContainer ?? false)) {
		const writable = present.fileSystem.entries.filter((entry) => entry.access === "write");
		const workspace = writable.find((entry) => entry.missingPathBehavior !== "skip");
		if (workspace !== undefined) {
			const grantRoots = [...new Set([workspace.path, ...writable.map((entry) => entry.path)])];
			return {
				kind: "appcontainer",
				workspace: workspace.path,
				grantRoots,
				executableRoots: [...(options.executableRoots ?? [])],
				protectedRoots: protectedWithinGrant(policy.protected, grantRoots),
				network: true,
			};
		}
	}

	if (!hasNativeSandboxBackend(platform)) {
		// Windows has a backend; it is the *selection* that declined — the probe's
		// reason when it has one, the network axis when the container was usable
		// but the session's network is restricted (measured: a restricted axis
		// lives on the loopback proxy, which a container child cannot reach, so
		// the branch above requires `enabled`). "No backend in this build" would
		// be false about that machine, and the sentence a user reads has to be
		// about the machine they are on.
		if (platform === "win32") {
			const why =
				options.appContainerReason ??
				(options.hasAppContainer
					? "this session's network axis is restricted, and the proxy it confines to lives on the loopback, which a container child cannot reach"
					: "the container backend was not probed for this session");
			return {
				kind: "simulated",
				reason: `the Windows container backend was not selected: ${why}. What applies is the tool-layer path policy, the deny rules, and the dangerous-command classifier — a subprocess started outside the tools is not subject to any of them`,
			};
		}
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
			? buildSeatbeltArgs(present, options.command, options.networkPorts)
			: buildBwrapArgs(present, options.command, exists, options.networkBridge);

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
/**
 * Why a read-only command is refused on this platform, in words a user can act on. Each reason names what an
 * unwrapped run would have done, because a refusal is only acceptable if the reader knows the alternative.
 */
function readOnlyRefusal(platform: SandboxPlatform): string {
	if (platform === "win32") {
		return "the read-only sandbox has no OS backend on Windows in this build: the container backend can grant write access to a workspace but has no read-only grant, so a command here would run with the session's full write access. Bash is refused under read-only; Read, Grep and Glob are not affected, and Write and Edit are refused by the tool layer. Switch the sandbox to workspace-write to run commands";
	}
	return `the read-only sandbox needs ${nativeSandboxProgram(platform)}, which is not on PATH, and a command without it would run with the session's full write access. Install it, or switch the sandbox to workspace-write to run commands`;
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
/**
 * Which of `describeNetworkPolicy`'s caveats applies here. The question order
 * is the function: an open axis beats a working backend, and a mode that asked
 * for no wrapper beats one too. The platform then splits the native case, and
 * both answers leave exactly one route standing — the enforcing proxy: a macOS
 * profile permits the proxy's own loopback ports while denying every other
 * route (`proxy-ports`), and the bubblewrap namespace carries the same reach
 * through its loopback bridge (`proxy-bridge`), the one route back across the
 * namespace wall. A command with no running proxy to name gets no ports or
 * bridge either and the wrapper in that case denies everything, the proxy
 * included. `platform` is defaulted the way `describeSandboxBackend` defaults
 * it, and keying on it can only ever move the answer toward the stronger
 * claim, where the wrapper really does carry the route rules: the executor
 * passes them every time it runs a restricted policy, because the same call
 * starts the proxy.
 */
export function networkConfinement(
	backend: SandboxBackend | undefined,
	sandbox: SandboxMode,
	network: "restricted" | "enabled",
	platform: SandboxPlatform = process.platform,
): NetworkConfinement {
	if (network === "enabled") return "network-left-open";
	if (sandbox === "danger-full-access") return "filesystem-axis-off";
	if (backend === "native") return platform === "darwin" ? "proxy-ports" : "proxy-bridge";
	if (backend === "unavailable") return "backend-missing";
	// `simulated`, an unreported backend, and `appcontainer` all land here. The
	// third is not an oversight — see the function's own doc for why a restricted
	// command under an appcontainer runtime is not kernel-confined.
	return "no-os-backend";
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * The sentence `/permissions` prints. Written per case; an unreported backend
 * reads as simulated. `appContainerReason` is the selection probe's own why,
 * printed when it declined — the machine that has a backend and did not
 * select it deserves a sentence about the machine, not about the build.
 */
export function describeSandboxBackend(
	backend: SandboxBackend | undefined,
	sandbox: SandboxMode,
	platform: SandboxPlatform = process.platform,
	appContainerReason?: string,
): string {
	// Asked first because it is true in all three backend cases: an unrestricted
	// policy wraps nothing on macOS with `sandbox-exec` sitting right there, so
	// "native" must not be allowed to imply confinement on its own.
	if (sandbox === "danger-full-access") {
		return "Sandbox: off. This mode asks about nothing and confines nothing at the filesystem level — the deny rules and the dangerous-command classifier are the only limits, and they sit above every mode.";
	}
	if (sandbox === "read-only") {
		// Per backend, like the workspace-write sentence. Only a native wrapper holds this mode; everything
		// else refuses the command, and the sentence says so rather than describing a boundary that is not there.
		if (backend === "native") {
			return `Sandbox: read-only, enforced by the OS. Commands run under ${nativeSandboxProgram(platform)} with no writable path on the disk, so the kernel refuses every write to one apart from the device nodes every process uses. Reads are not narrowed. The kernel is what holds this rather than this process, and it is attached to the process rather than the command, so it survives however the process tree is arranged.`;
		}
		const why =
			platform === "win32"
				? "this build's Windows container backend has no read-only grant"
				: `${nativeSandboxProgram(platform)} is not installed`;
		return `Sandbox: read-only, not enforced here, so Bash is refused under this mode: ${why}. Read, Grep and Glob are not affected, and Write and Edit are refused by the tool layer.`;
	}
	switch (backend) {
		case "native":
			// A write-only claim, scoped to the mode rather than to the policy: both
			// backends start from an already-readable baseline, and the `.git`
			// sentence holds for every policy `buildSandboxPolicy` produces.
			// Long-form design notes: docs/dev/sandbox.md
			return `Sandbox: enforced by the OS. Commands run under ${nativeSandboxProgram(platform)}. The workspace boundary is a write boundary — version-control metadata is refused for writing — and this mode does not narrow reads, which start from the machine's own. The kernel is what holds this rather than this process, and it is attached to the process rather than to the command, so it survives however the process tree is arranged.`;
		case "appcontainer":
			// The version-control promise is made in the fixed string, on the allow
			// side: the grant narrows an existing `.git` so the kernel refuses the
			// write. The `.git`-that-does-not-exist-yet case and the restricted-axis
			// gap are stated in the string too.
			// Long-form design notes: docs/dev/sandbox.md
			return `Sandbox: enforced by the OS. Commands run in a Windows AppContainer profile derived from this workspace, and the kernel refuses a write outside the roots the policy grants — every writable root the session names, not only the workspace. The confinement is the child's own token rather than a wrapper around it, so it is attached to the process and survives however the process tree is arranged. This mode does not narrow reads. Version-control metadata inside a granted root is narrowed on disk when it exists: the grant rewrites the container SID's own allow ACE on .git to read and execute and protects the DACL, so the kernel refuses a confined write there, and release writes the original ACE list back. The deny route is not used at all, because a deny ACE does not bind a container token (measured). A .git that does not exist yet is not narrowed, so a confined command could create one inside its grant and only the tool-layer rule refuses writes to that. A restricted network axis is not confined by this backend either: the proxy that enforces it listens on loopback, which a container child cannot reach, so that command runs on the tool-layer policy and the proxy rather than being held here.`;
		case "unavailable":
			return `Sandbox: not enforced. ${nativeSandboxProgram(platform)} is not installed here, so commands run without filesystem confinement. The deny rules and the dangerous-command classifier still apply — they live in this process — but the workspace boundary is not being held.`;
		default: {
			// Windows has a backend; the selection declined, and the reason says
			// which machine state declined it. "This build ships no backend"
			// would be false there, and the sentence a user reads has to be
			// about the machine they are on.
			if (platform === "win32") {
				const why = appContainerReason ?? "the container probe did not select it for this session";
				return `Sandbox: simulated, not OS-enforced. This machine's Windows container backend was not selected: ${why}. The tool-layer view: writes are ${SIMULATED_SANDBOX_DISCLAIMER}, for calls that arrive through the tools. The deny rules and the dangerous-command classifier are separate and still apply.`;
			}
			// "Calls that arrive through the tools" is about `Write` and `Edit`, and
			// not about `Bash` — which builds this same policy, hands it to `exec`, and
			// has it dropped unread the moment the resolution is not `native`. The
			// sentence is true as written; it is worth the comment here because the
			// gap is the kind a reader assumes is closed.
			return `Sandbox: simulated, not OS-enforced. This build ships no filesystem-sandbox backend for this platform, and adding one would mean a helper program, which is out of scope. Writes are ${SIMULATED_SANDBOX_DISCLAIMER}. The deny rules and the dangerous-command classifier are separate and still apply.`;
		}
	}
}
