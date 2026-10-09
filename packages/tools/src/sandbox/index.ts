/**
 * Choosing a backend for a policy, and saying which one was chosen.
 *
 * The translators next door are pure: policy in, argv out. This module is the
 * part that knows what machine it is on, what is installed, and — the part that
 * matters most — what to tell the user when the answer is "nothing here is
 * actually confining your commands".
 *
 * Five outcomes, not two, because collapsing them is how a build ends up
 * describing a tool-layer check as a sandbox:
 *
 *   `native`       a real OS backend wraps the shell (macOS seatbelt, Linux bwrap)
 *   `appcontainer` Windows's backend — and not an argv wrapper, because the
 *                  confinement there is the child process's own token: an
 *                  AppContainer package SID derived from the workspace, with an
 *                  ACL grant on the writable roots, spawned through FFI in
 *                  `appcontainer.ts` rather than by decorating an argv. Reached
 *                  only with an `enabled` network axis, for the measured reason
 *                  the branch itself records
 *   `simulated`    no argv backend exists on this platform, or the one that
 *                  exists is Windows's and the policy's network axis rules it
 *                  out; what applies is the tool-layer path policy, and a
 *                  subprocess that goes around the tools is not subject to it
 *   `unavailable`  a backend exists for this platform but is not installed. The
 *                  command still runs — refusing every command on a machine that
 *                  never installed bubblewrap would be a worse failure than the
 *                  one being guarded. The user is not left believing they are
 *                  confined, but see the note below on where that sentence comes
 *                  from, because it is not this one
 *   `unconfined`   the policy says so, and nothing is wrapped
 *
 * The last three all mean "your command is not being confined by this layer", so
 * the distinction between them is for the *report*, not for the argv. Collapsing
 * them into a boolean is precisely how a simulated layer starts reading as a
 * real one.
 *
 * **The `reason` on a resolution has no production reader.** This paragraph used
 * to claim the reason "is reported so the user is not left believing they are
 * confined", and that was false. Both production readers of a resolution test
 * `kind` alone and take the argv from it — `operations.ts` and `background.ts`
 * — and neither looks at anything else on the object, so the `reason` strings
 * built below are read by tests and by nothing else. The sentence a user
 * actually sees is produced independently, by `describeSandboxBackend` from the
 * same two inputs (the detected backend and the session's sandbox mode), and
 * `/permissions` is its one caller.
 *
 * Which is the better shape, and the reason this is worth a sentence rather than
 * a deletion: the two cannot disagree, because the user-facing one is computed
 * from the inputs rather than from a decision that already happened. A reason
 * string with no reader invites a future reader to go looking for the consumer
 * and conclude the disclosure is missing. It is not missing; it is derived.
 */
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

/**
 * How to confine a command, expressed as the argv that does it.
 *
 * `argv` replaces nothing: the shell and its own arguments are appended after a
 * `--` separator, so the wrapper wraps *the shell* rather than being wrapped by
 * it. That direction is not a detail. A sandbox placed inside the command line
 * confines whatever the shell chooses to run, which on a POSIX line is anything
 * at all — `bash -c` re-execs, background jobs escape, and a wrapper that only
 * sees the outer shell's argv has already lost. Both translators emit the command
 * last, after a `--` separator, for the same reason.
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
	| {
			kind: "appcontainer";
			/**
			 * The workspace the container profile is derived from — and therefore
			 * the root whose grant the caller must hold before the spawn.
			 */
			workspace: string;
			/**
			 * Every root the ACL grant must cover, the workspace first and each
			 * path once. It is more than `workspace` because more than the
			 * workspace is writable: a real session's policy names the home
			 * package caches and the temp directory, and an un-granted container
			 * child cannot write any of them — the kernel refuses, so the grant
			 * list is what makes the confined command work rather than merely
			 * the workspace's own files.
			 *
			 * Carried on the resolution rather than re-derived by the two spawn
			 * paths because there are two of them and one answer: a caller that
			 * filtered the policy's entries itself would be a second place
			 * deciding which root is the workspace, and the skip-marker rule
			 * that decides it is a one-line predicate nobody should have to
			 * re-read.
			 */
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
	/**
	 * Whether the Windows AppContainer backend is usable on this machine.
	 *
	 * Injected for the same reason as `hasNativeBackend`, so the branch it
	 * guards is reachable from a test on a machine that has neither — and
	 * there is a second reason here that the native flag does not have: the
	 * answer is a pair of DLL loads, and a resolution function that performs
	 * them itself stops being a pure function of its inputs. The default is
	 * `false`, and the direction is the safe one: a wrong `true` sends a
	 * command down a container path whose profile and grant were never
	 * established, while a wrong `false` is the simulated answer this
	 * platform already gives — the status quo, not a new hole.
	 */
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
	/**
	 * Directories the policy may write, each tagged with what it is.
	 *
	 * The tag is not decoration: `protectedFor` derives a `.git` only under a
	 * `project` root, because a cache directory is not a repository and a derived
	 * read-only mount inside `%TEMP%` is a directory that appears for nobody.
	 * A bare `string[]` cannot carry that, which is why this is not one.
	 */
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
 * "bubblewrap is not installed here" is a real state the caller has to handle
 * and not a theoretical one.
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
	/**
	 * Whether production *selects* the Windows AppContainer backend — which is
	 * not the same question as whether the backend loads.
	 *
	 * **Production does not claim it, and the reason is measured, not
	 * cautious.** The backend itself works: a profile spawns, the ACL grant
	 * holds, and a command that runs inside the granted workspace reads and
	 * writes it while the kernel refuses everything beyond it. What does not
	 * work is the session's own toolchain: the confined child inherits an
	 * AppContainer token, and a token of that shape executes only what the
	 * filesystem grants its package SID. `C:\Windows\System32` does; the
	 * directories this machine's tools live in do not — `git`, `node`, and
	 * `bun` from `D:\Program Files` and the user profile all come back
	 * "not recognized" inside the container, and an absolute path to the same
	 * binary comes back "Access is denied" (a copy placed inside the granted
	 * workspace runs, which is what separates the two). So selecting the
	 * backend on this machine would confine every default-mode command into
	 * something that cannot run `git status`. The README's "simulated on
	 * Windows" stays true until the toolchain reaches the child.
	 *
	 * A test constructs a runtime with it `true` to drive the container branch,
	 * the same way `hasNativeBackend` is faked for the Linux branch; that is
	 * what `sandbox-wiring.test.ts` does.
	 */
	hasAppContainer?: boolean;
}

/**
 * This machine's runtime. One PATH scan, at construction rather than per
 * command.
 *
 * The AppContainer backend is deliberately not probed here — see
 * {@link SandboxRuntime.hasAppContainer} for the measurement that keeps
 * production off it. `appContainerAvailable` remains exported from
 * `./appcontainer.ts` and stays the honest answer to the narrower question
 * ("do the DLLs load"), which is the question the tests ask of it.
 */
export function detectRuntime(platform: SandboxPlatform = process.platform): SandboxRuntime {
	return {
		platform,
		hasNativeBackend: detectNativeBackend(platform),
	};
}

/**
 * Pick a backend and build the argv for it.
 *
 * `hasNativeBackend` is a parameter rather than a PATH probe so that every branch
 * here is reachable from a test on any machine. The real caller passes the
 * result of checking for the program, and the two are kept honest by
 * `sandbox-wiring.test.ts` asserting the wiring rather than this function
 * asserting its own inputs. That file is the one that exists and drives a real
 * `exec`; an earlier version of this comment named `operations.test.ts`, which
 * has never existed in this repository, so the assertion it claimed as the
 * guard was in a file nobody could go and read.
 */
export function resolveSandboxExecution(options: ResolveSandboxOptions): SandboxResolution {
	const platform = options.platform ?? process.platform;
	const { policy } = options;

	// Checked before the platform question, because `danger-full-access` is not
	// "a sandbox with a very wide allow list" — it is the absence of one, and
	// reporting it as a wrapped-but-permissive sandbox would be a lie in the
	// direction that matters.
	//
	// The **network** half does not change this, and the reason is not the one
	// this comment used to give. It used to claim the problem was confined to
	// this branch — "both translators carry a branch for *unconfined filesystem,
	// restricted network* that still wraps, and removing this short-circuit
	// reaches it". That was half of it, and the half that mattered was left out:
	// `workspace-write` with a restricted network reaches `--unshare-net` and a
	// `(deny default)` profile with no network rule **today**, and has the same
	// consequence. The command's only route to the proxy is loopback, and both
	// of those take loopback away.
	//
	// So the situation is not a property of this short-circuit. It is what a
	// restricted network means on a native backend: the OS denies every route
	// off the machine, the proxy is on one of those routes, and therefore a
	// command run through the shell reaches nothing — allowed or denied — while
	// the domain list governs the web tools, which fetch in this process. That is
	// now what `describeNetworkPolicy` says for the `os-namespace` case, and it
	// says it because this function is the resolution it is derived from.
	//
	// What is *not* done here is the fix that would make the list work from a
	// shell: dropping the OS denial so the network stays open and the proxy is
	// the boundary. That is a real option and it is deliberately not taken
	// silently — it converts `restricted` from "the kernel denies it" into "a
	// proxy the program can ignore", which is a different and weaker promise,
	// and a user who set `restricted` chose the stronger one. Both can be true at
	// once, but only with a routing bridge between them: keep `--unshare-net` for
	// the kernel's refusal and hand the confined process's own traffic to a Unix
	// socket, which a small forwarder carries out over TCP to the proxy that
	// applies the domain list. That bridge is a helper program, and this build
	// ships none — so it has one of the two properties rather than both, and says
	// which.
	if (policy.fileSystem.kind === "unrestricted") return { kind: "unconfined" };

	// One predicate, consulted in three places for three different reasons, so
	// that all three consult it about the same machine rather than about three
	// lookups that could straddle a `mkdir` and disagree. What they do with the
	// answer differs and the difference is the point: an *entry* marked `skip`
	// that is missing is dropped (see `presentEntries`, and the AppContainer
	// grant list below drops them for the same reason — granting a path that is
	// not there fails the grant), whereas a *protected* path that is missing is
	// kept and turned into an empty read-only mount, because dropping it would
	// be the one answer that quietly removes the protection it is there to
	// provide.
	const exists = options.exists ?? ((path: string) => existsSync(path));
	const present = presentEntries(policy, exists);

	// The Windows AppContainer backend, and it is placed here — after the
	// unrestricted short-circuit and before the `hasNativeSandboxBackend`
	// check — because that check answers `false` for win32 and would return
	// `simulated` before this branch were ever reached. Windows has no argv
	// wrapper, so nothing about an argv decision applies to it; what it has is
	// a child-process token, and the branch says so in the shape it returns.
	//
	// The conditions, and what each one is for:
	//
	//   - `win32`, because the backend is `AppContainer` calls in `userenv.dll`
	//     and nothing else reaches them.
	//   - `policy.network === "enabled"`, and this is the one that is easy to
	//     get wrong, so it carries the measured reason rather than a guess.
	//     A `restricted` axis is enforced by the proxy, and the proxy listens
	//     on loopback; a container child cannot reach loopback (loopback
	//     denied even with `privateNetworkClientServer`, measured). So
	//     confining a restricted command would enforce the axis by breaking
	//     the network — every allowed domain failing alongside every denied
	//     one — which is the failure the native backends already have and
	//     document. `enabled` starts no proxy and needs no loopback, so it is
	//     the one axis this backend can enforce exactly. `restricted` keeps
	//     falling through to `simulated`, which is honest: the tool layer and
	//     the proxy still hold the axis, the OS does not.
	//   - `hasAppContainer`, which defaults to `false` — see the option's own
	//     doc for why that direction is the safe one.
	//
	// What the branch returns says what the caller must do that `native` does
	// not: acquire the ACL grants before the spawn and release them after,
	// because an un-granted container child cannot read the workspace at all —
	// fail-closed, and a command that does not run is a legible failure, but
	// the grant is what makes the backend usable rather than merely honest.
	//
	// The grants cover every writable root, not only the workspace, and the
	// reason is a real session's shape: `resolveWritableRoots` always returns
	// the temp directory and the home package caches beside the workspace, so
	// a container granted only the workspace cannot `mktemp` and cannot write
	// its install cache — the narrower-than-asked-for failure this repository
	// already fixed once in `policyFor`. The workspace leads the list because
	// the profile — and with it the container identity, and the refcount that
	// decides when a grant is released — is derived from it; an identity per
	// root would be an identity per command.
	//
	// Read-only roots are absent from the list on purpose: an AppContainer
	// child reads outside its grant by default and only writes are refused, so
	// a grant there would buy nothing the token does not already have.
	//
	// The workspace itself is the one writable entry `buildSandboxPolicy`
	// emits without a `skip` marker — every other writable root is a cache or
	// an additional directory the policy tolerates being absent, and the
	// workspace is not one of those. A policy with no such entry (a hand-built
	// one, or one whose only roots are all skip-marked) has nothing to derive
	// a container from, so the branch does not fire and the existing
	// `simulated` answer below stands.
	//
	// The list is read from `present`, the filtered policy, for the same reason
	// the translators are: a `skip`-marked root that does not exist would fail
	// the grant outright, and a build cache that was never created is exactly
	// such a root — dropping it keeps a confined command runnable, where
	// granting it would turn the sandbox into a broken tool.
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

	// Defaults to *installed*, and the direction is the point rather than an
	// oversight. Guessing "not installed" would return `unavailable`, and a
	// confined command would then run with no wrapper at all — the fail-open.
	// Guessing "installed" makes a machine without `bwrap` fail to spawn it, so
	// the command does not run; that is fail-closed, and it is the correct side
	// to be wrong on. The cost is a command that fails with a spawn error naming
	// a program the caller believed was installed, which is a legible failure.
	//
	// No production caller reaches this default: `operations.ts:370` passes
	// `this.#runtime.hasNativeBackend`, which comes from `detectNativeBackend`.
	// It is here for a hand-built call and for the tests, and it is documented
	// because a bare `?? true` in a confinement decision is exactly the sort of
	// thing a later reader "corrects" to `?? false` without asking which way the
	// error runs.
	const installed = options.hasNativeBackend ?? true;
	if (!installed) {
		return {
			kind: "unavailable",
			reason: `${nativeSandboxProgram(platform)} is not on PATH, so commands run without filesystem confinement. The deny rules and the dangerous-command classifier still apply — they are in this process, not in the kernel — but the workspace boundary is not being enforced`,
		};
	}

	// Both translators return the argv *after* the program name, so the program
	// is named here and nowhere else. Absolute for `sandbox-exec`, which must be
	// the system binary: resolving it through `PATH` is how a wrapper gets
	// substituted.
	//
	// Only bwrap is given `exists`. Under seatbelt a protected path that is absent
	// needs nothing special: a `subpath` filter that matches no file grants
	// nothing, which is exactly the protection, and the profile it produces is the
	// profile it produced before any of this was derived.
	const program = nativeSandboxProgram(platform);
	const args =
		platform === "darwin"
			? buildSeatbeltArgs(present, options.command)
			: buildBwrapArgs(present, options.command, exists);

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

/**
 * What confines a command on this machine. See `ChildProcessExecOperations.sandboxBackend`.
 *
 * Four answers rather than the three this began as, because the two Windows
 * kinds are different facts: `simulated` means nothing OS-level applies to the
 * command, `appcontainer` means a container child is spawned and the kernel
 * refuses its writes outside the granted roots. They cannot share a name —
 * the over-claim direction, a simulated command reporting itself as confined,
 * is the one that costs a user, and a string cannot be narrowed after the
 * fact.
 */
export type SandboxBackend = "native" | "simulated" | "unavailable" | "appcontainer";

/**
 * The backend this machine would get, from the facts that decide it.
 *
 * A function of its platform rather than a read of `process.platform` inside, so
 * that the "Linux without bubblewrap" case — the one that decides whether a user
 * is told a lie — is reachable from a test running on any machine, including the
 * Windows one this was written on.
 *
 * `hasAppContainer` is the third fact, and only win32 has one to supply: this
 * backend is a pair of DLL loads and a profile, not a program on PATH, so it
 * does not vary by machine the way `bwrap` does. Its default follows the same
 * rule as the twin in `resolveSandboxExecution` — a wrong `false` reports the
 * tool-layer answer this platform already gives, the status quo, while a wrong
 * `true` tells a user the kernel is holding a boundary it is not. Production
 * passes `SandboxRuntime.hasAppContainer`, which `detectRuntime` does not claim.
 */
export function sandboxBackendFor(
	platform: SandboxPlatform,
	hasNativeBackend: boolean,
	hasAppContainer = false,
): SandboxBackend {
	if (platform === "win32") return hasAppContainer ? "appcontainer" : "simulated";
	if (!hasNativeSandboxBackend(platform)) return "simulated";
	return hasNativeBackend ? "native" : "unavailable";
}

/**
 * Which of `describeNetworkPolicy`'s five caveats applies on this machine.
 *
 * The knowledge lives here and not at the call site because the caller is the
 * app: `agent` is a downstream package that cannot see whether bubblewrap is
 * installed, and having it answer anyway is exactly how the sentence came to
 * key off `process.platform` and print "the OS sandbox holds the rest of the
 * boundary" on a Linux box with no bubblewrap on it.
 *
 * The order of the questions is the whole function, and each one exists because
 * a later check would have answered "yes" for a command nothing is around:
 *
 *   1. `network === "enabled"` — an OS sandbox that denied outbound would also
 *      deny the traffic the allowlist exists to permit, so an open network has
 *      to stay open inside the wrapper and the proxy is the whole boundary even
 *      on a Mac with `sandbox-exec` in front of the shell.
 *   2. `danger-full-access` — the filesystem axis is off, so
 *      `resolveSandboxExecution` short-circuits and nothing wraps the command at
 *      all. This is the case a platform-only check gets wrong: every fact about
 *      the machine says native and the command is still unwrapped.
 *   3. The backend itself, and only now can "native" mean what it says.
 *
 * An unreported backend is read as the weakest, matching
 * `describeSandboxBackend`: not knowing what confines this is not evidence that
 * something does. An `appcontainer` backend joins it on a `restricted` axis for
 * a measured reason rather than a cautious one: the resolver's container branch
 * is reachable only with an `enabled` axis, because the proxy that enforces
 * `restricted` listens on loopback and a container child cannot reach it — so
 * the command being asked about resolved to `simulated` and runs on the proxy.
 * Reading that as `os-namespace` would describe a kernel denial it never got.
 */
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
			// "Confined to the workspace" is a claim about writes only, and it used to
			// be made about the whole command. Both backends start from an
			// already-readable baseline — bwrap emits `--ro-bind / /` and seatbelt
			// emits `(allow file-read*)` — so a `read`-marked root produces no rule at
			// all rather than a narrower one. The string is scoped to the *mode* rather
			// than to the policy on purpose: this function is not handed the policy,
			// and `SandboxPolicy` is a type an embedder can fill with `deny` entries,
			// so "reads are unrestricted" would be one mechanism's answer wearing the
			// other's name. "This mode does not narrow reads" is true of every policy
			// `buildSandboxPolicy` produces, which is the only one this mode has.
			//
			// "Version-control metadata is refused for writing" carries the same
			// exposure and was left unargued, which is the gap worth closing here: a
			// hand-built `SandboxPolicy` with `protected: []` would render this exact
			// sentence while emitting no protection at all. The argument is the same
			// one, and it holds for the stronger claim: for `workspace-write`,
			// `buildSandboxPolicy` returns through `protectedFor`, which adds
			// `join(root, ".git")` for every writable root unconditionally — the scan
			// only ever *adds* to the list, so no result it can produce removes a
			// `.git`. The early return for `danger-full-access` is the one branch that
			// yields an empty `protected`, and that mode never reaches this `case`.
			// So the sentence is true of every policy this build produces and false
			// only of one an embedder writes by hand, which is the same line already
			// drawn for reads.
			//
			// The process-tree sentence is kept, and is a different claim from the one
			// the bwrap header leaves open: it is about *descendants* keeping the
			// confinement, which is what the parent-of-the-shell wrapping in
			// `operations.ts` and seatbelt's inherited profile both give. Whether a
			// `mv` can carry a protected `.git` out from under its read-only bind on
			// Linux is a separate question, it is unverified, and it stays in
			// `bwrap.ts` rather than being resolved in a string this long.
			return `Sandbox: enforced by the OS. Commands run under ${nativeSandboxProgram(platform)}. The workspace boundary is a write boundary — version-control metadata is refused for writing — and this mode does not narrow reads, which start from the machine's own. The kernel is what holds this rather than this process, and it is attached to the process rather than to the command, so it survives however the process tree is arranged.`;
		case "appcontainer":
			// The `.git` promise the native case makes is deliberately not repeated:
			// the deny ACE is out until the timing anomaly in its measurement is
			// understood (`appcontainer.ts` carries the record), so a confined
			// command CAN write `.git` inside its grant and only the tool layer
			// refuses it. And the restricted-axis gap is stated in the fixed
			// string because this function is not handed the axis, the sentence
			// is the same either way, and a reader told "enforced by the OS"
			// while their axis is restricted would rely on a confinement they
			// do not have.
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
