/**
 * The sandbox policy: one data shape, several translators.
 *
 * This is deliberately a *value*, not a mechanism. It mirrors Codex's
 * `FileSystemSandboxPolicy` / `NetworkSandboxPolicy` pair
 * (`codex-rs/protocol/src/permissions.rs:80-239`) closely enough that the
 * backends below can be read against theirs, and it is built by pure functions
 * from a `SandboxMode` so that what a mode means can be asserted without
 * spawning anything.
 *
 * Three translators consume it, and which one runs is a property of the
 * platform, not of the policy:
 *
 *   - macOS   `sandbox-exec` with a generated `.sbpl` profile — real, OS-level
 *   - Linux   `bwrap` argv — real, OS-level, and needs bubblewrap installed
 *   - Windows **simulated**: a tool-layer path decision, because the plan
 *             rules out a helper program and there is no user-mode equivalent
 *             of seatbelt. The network half is genuinely enforced (batch 4,
 *             the proxy); the filesystem half is a decision this process makes
 *             about calls that arrive through the tools, and a subprocess that
 *             goes around them is not subject to it.
 *
 * That last line is the honest limit of the pair and is repeated wherever the
 * sandbox is shown to a user. A mechanism that reads as OS-enforced when it is
 * not is worse than no mechanism.
 */
import type { SandboxMode } from "./types.ts";

/** Whether the filesystem is confined at all. Mirrors Codex's `FileSystemSandboxKind`. */
export type FileSystemSandboxKind = "restricted" | "unrestricted";

/**
 * What a single path is allowed. Mirrors Codex's `FileSystemAccessMode`.
 *
 * `write` implies `read`: a path nothing may read is expressed as `deny`
 * rather than as an entry that is simply absent, because "absent" and "denied"
 * mean different things to a backend and only the second is unambiguous.
 */
export type FileSystemAccessMode = "read" | "write" | "deny";

/** Mirrors Codex's `NetworkSandboxPolicy`. */
export type NetworkSandboxPolicy = "restricted" | "enabled";

export interface FileSystemSandboxEntry {
	/** Absolute, already canonical. Backends match on this string, not on a pattern. */
	path: string;
	access: FileSystemAccessMode;
	/**
	 * `skip` drops the entry when the path does not exist instead of failing.
	 *
	 * Codex has exactly this one variant (`FileSystemSandboxEntryMissingPathBehavior`,
	 * `permissions.rs:196`) and defaults to it for self-referential entries, because
	 * a policy naming a directory that was never created would otherwise make every
	 * command fail on a machine where it does not apply.
	 *
	 * **Dropped by the caller, not by a backend.** The translators are pure — they
	 * cannot stat a path — so `resolveSandboxExecution` filters these out before
	 * dispatching, with an injectable `exists` so the branch is testable. That
	 * placement is not arbitrary: it is load-bearing on Linux, where bubblewrap
	 * fails to start when a `--bind` source is absent, so a policy naming an
	 * uncreated build cache would otherwise turn into a shell that does not run.
	 */
	missingPathBehavior?: "skip";
}

export interface FileSystemSandboxPolicy {
	kind: FileSystemSandboxKind;
	entries: FileSystemSandboxEntry[];
}

export interface SandboxPolicy {
	fileSystem: FileSystemSandboxPolicy;
	network: NetworkSandboxPolicy;
	/**
	 * Paths inside the workspace that must never be written, whatever else the
	 * policy allows.
	 *
	 * **A deliberate divergence from Codex**, which expresses the same idea as deny
	 * rules appended to the end of the profile. Keeping them in their own field
	 * means the translators cannot forget them: the ordering that makes them
	 * effective ("a deny must come after every allow that could otherwise cover
	 * it") is a property each backend has to re-establish, and a backend that
	 * forgets is exactly the bug this shape makes hard to write. The tests assert
	 * the ordering on each backend rather than trusting it.
	 *
	 * Today this carries `.git` directories. That is not decoration: the tool-layer
	 * guard in `packages/tools/src/containment.ts` stops Edit and Write, and the
	 * shell is not subject to it — `rm .git/config` through Bash is `allow` in agent
	 * mode, measured before this layer existed. A filesystem sandbox is the first
	 * thing in the build that reaches below the tools.
	 */
	protected: string[];
}

export interface BuildSandboxPolicyOptions {
	/** The axis value this policy is for. */
	sandbox: SandboxMode;
	/** The workspace root, absolute and canonical. */
	workspace: string;
	/**
	 * Paths inside the workspace that must not be written. Discovered by the
	 * caller rather than scanned here, so this module stays pure — the scan is
	 * filesystem I/O and belongs in the layer that is allowed to do I/O.
	 */
	protectedPaths?: string[];
	/** Directories outside the workspace that may be written (a build cache, say). */
	writableRoots?: string[];
	/** Outside the workspace, readable but not writable (the tool-output spill dir). */
	readOnlyRoots?: string[];
	/**
	 * The network axis, which is **not** derived from `sandbox`.
	 *
	 * Codex keeps these separate too (`FileSystemSandboxPolicy` and
	 * `NetworkSandboxPolicy` are independent fields), and collapsing them would
	 * mean `workspace-write` silently cut the network — breaking `npm install` and
	 * `git fetch` for every user who picked the default. The field exists now
	 * because the proxy in batch 4 needs somewhere to land; until that setting
	 * exists this defaults to `enabled`, which is today's behaviour.
	 */
	network?: NetworkSandboxPolicy;
}

/** Whether an entry's access level permits writing. */
export function canWrite(access: FileSystemAccessMode): boolean {
	return access === "write";
}

/** Whether an entry's access level permits reading. */
export function canRead(access: FileSystemAccessMode): boolean {
	return access !== "deny";
}

/**
 * Build the policy for a sandbox axis value.
 *
 * `danger-full-access` produces a policy with no entries and no protected paths
 * rather than one that happens to allow everything: an empty policy is one a
 * backend can recognise and refuse to wrap at all, and a test can tell apart
 * "unconfined" from "confined with a very wide allow list".
 */
export function buildSandboxPolicy(options: BuildSandboxPolicyOptions): SandboxPolicy {
	const { sandbox, workspace } = options;

	if (sandbox === "danger-full-access") {
		return {
			fileSystem: { kind: "unrestricted", entries: [] },
			network: options.network ?? "enabled",
			protected: [],
		};
	}

	const entries: FileSystemSandboxEntry[] = [
		// The workspace is the one thing that is writable, which is what the mode
		// name says. `missingPathBehavior` is not set: a workspace that does not
		// exist is a broken session, not a policy to be skipped past.
		{ path: workspace, access: "write" },
	];
	for (const root of options.writableRoots ?? []) {
		entries.push({ path: root, access: "write", missingPathBehavior: "skip" });
	}
	for (const root of options.readOnlyRoots ?? []) {
		// Read-only roots are additions to an already read-everything baseline, so
		// on the backends where the default is readable they are not emitted at
		// all. They are recorded here regardless, because the Windows simulated
		// layer has no "readable by default" and needs the list to answer at all.
		entries.push({ path: root, access: "read", missingPathBehavior: "skip" });
	}

	return {
		fileSystem: { kind: "restricted", entries },
		network: options.network ?? "enabled",
		protected: [...(options.protectedPaths ?? [])],
	};
}

/**
 * Whether `candidate` is a write this policy permits, judged the way the Windows
 * layer has to judge it: lexically, from the policy, with no filesystem access.
 *
 * The backends that can consult the kernel do not use this — they hand the whole
 * policy to `sandbox-exec` or `bwrap` and let it decide. It exists for the
 * simulated layer and for tests, and it is **directional**: it may only narrow.
 * A path it cannot place inside a known root is refused, never allowed, so a
 * caller that treats a wrong answer as "no opinion" is not a caller that can
 * widen access by being wrong.
 *
 * **Both sides must already be canonical.** It has no filesystem to consult, so
 * a root that reaches it through a symlink is compared as the spelling it
 * arrived with, and a candidate resolved past that symlink will not match it.
 * On macOS that is the difference between `/var/folders/…` and
 * `/private/var/folders/…`, and it means this answers "no" for a directory that
 * is genuinely inside the root. `decideWrite` in `@labunbun/tools` resolves the
 * root for this reason and is what production code should call; use this where
 * the caller already holds both forms.
 */
export function isWritePermitted(policy: SandboxPolicy, candidate: string): boolean {
	// `protected` first. `buildSandboxPolicy` cannot produce an unrestricted
	// policy that also carries protected paths, so the order is not observable
	// through it — but a helper whose stated job is to be *directional and never
	// widen by being wrong* should not have a branch that silently discards the
	// narrower rule. The two lines cost the same and only one of them can widen.
	if (policy.protected.some((path) => isWithin(candidate, path))) return false;
	if (policy.fileSystem.kind === "unrestricted") return true;
	return policy.fileSystem.entries.some((entry) => canWrite(entry.access) && isWithin(candidate, entry.path));
}

/**
 * Whether `candidate` sits inside `root`, treating the root itself as inside.
 *
 * Both sides are compared as already-canonical absolute paths with forward
 * slashes, which is what every producer in this build produces. Case folding is
 * the caller's decision and is not done here: on a case-sensitive filesystem
 * `Repo` and `repo` are different directories, and folding would accept a path
 * that only *spells* like one inside the root. `packages/tools/src/containment.ts`
 * already draws that line and does the folding against the real filesystem; this
 * is the pure fallback, and it says so by not folding.
 */
function isWithin(candidate: string, root: string): boolean {
	const normalizedRoot = root.replace(/\/+$/, "");
	return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}
