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
 *             of seatbelt. The filesystem half is a decision this process
 *             makes about calls that arrive through the tools, and a
 *             subprocess that goes around them is not subject to it.
 *
 * The network half is a proxy, on all three platforms, and it is enforced by
 * convention rather than by the kernel everywhere: `HTTP_PROXY` is something
 * most tooling honours and not something the OS requires. Where a native
 * sandbox backend is installed it closes that gap, so the two are layered.
 * Where one is not — Windows, or Linux without bubblewrap — the proxy is the
 * whole of it. `describeNetworkPolicy` in `network-policy.ts` says which, and
 * the sentence differs; `networkConfinement` in @labunbun/tools is the
 * derivation, because whether a backend is *installed* is not a fact this
 * package can see.
 *
 * That limit is the honest one and is repeated wherever the sandbox is shown
 * to a user. A mechanism that reads as OS-enforced when it is not is worse
 * than no mechanism.
 */
import { join } from "node:path";
import type { NetworkDomainRule } from "./network-policy.ts";
import type { SandboxMode } from "./types.ts";

/**
 * The one spelling a path inside a policy is allowed to have.
 *
 * Every comparison downstream — `isWithin` here, `isAtOrBelow` in
 * `packages/tools/src/sandbox/seatbelt.ts`, `isWithinRoot` in `simulated.ts` —
 * is a `startsWith` against a path a caller resolved, and every such caller
 * resolves with `/` separators (`resolveCanonical` normalises, and
 * `node:path.resolve` does the same on Windows). So a policy entry spelled with
 * `\` does not merely look different: it fails to match, and whether that
 * narrows or *widens* depends on which side of the comparison it landed on.
 * Here it widened, measured, which is the direction that must not happen.
 *
 * Deliberately not `resolve`. This module does no filesystem access, and
 * resolving a relative path would silently rebase it on `process.cwd()`, which
 * on Windows turns the fixture `/w/repo` into `<drive>:\w\repo`. Callers pass
 * absolute paths; this keeps whatever absoluteness they had and makes only the
 * separator claim true, which is the part the comparisons actually depend on.
 */
function canonicalPolicyPath(path: string): string {
	return path.replace(/\\/g, "/");
}

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

/**
 * The network axis values, as a value so the settings schema can derive its
 * enum from them — the `PERMISSION_MODES` lesson (F1), applied to the second
 * axis: a hand-written `z.enum(["enabled", "restricted"])` in the settings file
 * is a copy of this list that can drift.
 */
export const NETWORK_SANDBOX_POLICIES = ["restricted", "enabled"] as const;

/** Mirrors Codex's `NetworkSandboxPolicy`. */
export type NetworkSandboxPolicy = (typeof NETWORK_SANDBOX_POLICIES)[number];

export interface FileSystemSandboxEntry {
	/**
	 * Absolute, with `/` separators. Backends match on this string, not on a pattern.
	 *
	 * **The separator half is enforced, the absolute half is a convention.**
	 * `buildSandboxPolicy` runs every path it is given through
	 * `canonicalPolicyPath` below, so a `join`-shaped or caller-spelled
	 * backslash path cannot reach the comparison functions with two spellings in
	 * play. This is not a cosmetic normalisation: `isWithin` compares by
	 * `startsWith`, so a root spelled `C:\w\r` never matches a canonical
	 * candidate `C:/w/r`, and the derived `.git` is built with `join` while a
	 * caller may hand in a forward-slash workspace. Measured on Windows, before
	 * this was enforced: `isWritePermitted` returned `true` for `<ws>/.git/config`
	 * with the workspace spelled either way, because the protected entry missed
	 * and the writable entry matched. Absolute is left as a convention because
	 * making it true would mean `resolve`-ing against `process.cwd()`, which
	 * turns a test fixture like `/w/repo` into a path under the real drive on
	 * Windows — a worse trade than the one it fixes.
	 */
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
	 * The domain table the proxy enforces. Empty means "judge by mode alone",
	 * which under `restricted` reaches nothing and under `enabled` reaches
	 * everything — both correct, and both reachable from this build.
	 *
	 * It lives on the policy rather than being passed to `exec` beside it so
	 * that the network axis arrives the way the filesystem one does: as one
	 * value a caller cannot assemble from two arguments that disagree. Every
	 * producer of a `SandboxPolicy` now states its domain rules, including the
	 * ones that have none.
	 */
	networkRules: NetworkDomainRule[];
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
	/**
	 * Domain rules for the proxy. A copy, not a reference to the loaded
	 * settings: a policy is read by backends that must not be able to see it
	 * change underneath them mid-command.
	 */
	networkRules?: readonly NetworkDomainRule[];
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
 *
 * The derived `.git` below does not apply there, and that is not an oversight
 * left to be rediscovered. `resolveSandboxExecution` short-circuits on an
 * unrestricted policy and wraps nothing, so a protected path in it would be
 * inert for both native backends — while the tool layer, which *is* still in
 * force in this mode, refuses `.git` from `containment.ts` by matching the path
 * rather than by consulting a list. Putting a list here would mean the mode's
 * protection lived in a place that stops being read, which is the shape of a
 * guarantee that quietly stops existing.
 */
export function buildSandboxPolicy(options: BuildSandboxPolicyOptions): SandboxPolicy {
	const { sandbox, workspace } = options;

	if (sandbox === "danger-full-access") {
		return {
			fileSystem: { kind: "unrestricted", entries: [] },
			network: options.network ?? "enabled",
			networkRules: [...(options.networkRules ?? [])],
			protected: [],
		};
	}

	const entries: FileSystemSandboxEntry[] = [
		// The workspace is the one thing that is writable, which is what the mode
		// name says. `missingPathBehavior` is not set: a workspace that does not
		// exist is a broken session, not a policy to be skipped past.
		{ path: canonicalPolicyPath(workspace), access: "write" },
	];
	for (const root of options.writableRoots ?? []) {
		entries.push({ path: canonicalPolicyPath(root), access: "write", missingPathBehavior: "skip" });
	}
	for (const root of options.readOnlyRoots ?? []) {
		// Read-only roots are additions to an already read-everything baseline, so
		// on the backends where the default is readable they are not emitted at
		// all. They are recorded here regardless, because the Windows simulated
		// layer has no "readable by default" and needs the list to answer at all.
		entries.push({ path: canonicalPolicyPath(root), access: "read", missingPathBehavior: "skip" });
	}

	return {
		fileSystem: { kind: "restricted", entries },
		network: options.network ?? "enabled",
		networkRules: [...(options.networkRules ?? [])],
		protected: protectedFor(options, [workspace, ...(options.writableRoots ?? [])]),
	};
}

/**
 * The protected paths a confined policy carries: what the caller found, plus the
 * one that is derived rather than found.
 *
 * **The derived `.git` is the point of this function.** Everything in
 * `protectedPaths` arrives from `findProtectedPaths`, which walks the tree to
 * depth 4, skips `node_modules`, is cached per workspace for the life of the
 * process, and resolves to `[]` if it fails. Those are reasonable limits for
 * *discovering* directories nobody told us about — but they are the wrong limits
 * for the one directory everybody knows is there. A repository created after the
 * first Bash call, or one whose `.git` sits five levels down, produced no
 * protected entry, so seatbelt emitted no `(deny file-write*)` for it and bwrap
 * emitted no `--ro-bind`: the session wrote `.git/config` and reported success.
 *
 * Codex derives the same paths rather than scanning for them —
 * `permissions.rs:2392-2415` builds `.git` / `.agents` / `.codex` per writable
 * root unconditionally — and the reason is the same: a security control that is
 * only as good as the scan's coverage is not a control on the path that matters.
 * Only `.git` is derived here, because `.git` is the one this build's docs, its
 * tool-layer guard and its tests all name.
 *
 * Deduplicated, because the scan will usually have found it: a workspace that is
 * a git repository lists `<workspace>/.git` in `protectedPaths` already, and a
 * policy carrying it twice makes every "how many protected paths" assertion in
 * the suite wrong for a reason that is not a behaviour change.
 *
 * A path that does not exist is still derived. That is deliberate and it is why
 * the bwrap translator needs the empty-directory recipe: `--ro-bind` on an absent
 * source makes bubblewrap refuse to start, so a narrower sandbox would become a
 * broken tool on a machine that is simply not a repository. Creating an empty,
 * read-only mount at the path instead is both harmless when it is absent and the
 * stronger answer when it appears later — an empty `.git` cannot be written into
 * either.
 */
function protectedFor(options: BuildSandboxPolicyOptions, writableRoots: string[]): string[] {
	const found = options.protectedPaths ?? [];
	const out = new Set(found.map(canonicalPolicyPath));
	for (const root of writableRoots) {
		if (root === "") continue;
		// `join` first, then canonicalise. The other order loses: `join` is what
		// puts a `\` into the string on Windows, and `canonicalPolicyPath` after it
		// is the only ordering that ends with the one spelling `isWithin` compares.
		out.add(canonicalPolicyPath(join(root, ".git")));
	}
	return [...out];
}

/**
 * Whether `candidate` is a write this policy permits, judged lexically, from the
 * policy, with no filesystem access.
 *
 * The backends that can consult the kernel do not use this — they hand the whole
 * policy to `sandbox-exec` or `bwrap` and let it decide. **Neither does the
 * Windows simulated layer**: `decideWrite` in `@labunbun/tools` uses its own
 * `isWithinRoot`, because that one takes the case rule as a parameter and
 * canonicalises the root, neither of which is available here. So the honest
 * inventory is: **no production caller.** It is exported, it is what this
 * module's tests use to state the filesystem rule, and it is the piece a
 * policy-shaped caller would reach for. It is kept for that, and saying so is
 * the point — the previous version of this comment claimed the simulated layer
 * used it, and that was false in a way that would have sent a reader looking
 * for a caller that does not exist.
 *
 * It is **directional**: it may only narrow. A path it cannot place inside a
 * known root is refused, never allowed, so a caller that treats a wrong answer
 * as "no opinion" is not a caller that can widen access by being wrong. That
 * held for the POSIX spelling and did **not** hold on Windows until
 * `buildSandboxPolicy` began emitting canonical separators — see
 * `FileSystemSandboxEntry.path`, where the measured fail-open is recorded.
 *
 * **Both sides must already be canonical.** It has no filesystem to consult, so
 * a root that reaches it through a symlink is compared as the spelling it
 * arrived with, and a candidate resolved past that symlink will not match it.
 * On macOS that is the difference between `/var/folders/…` and
 * `/private/var/folders/…`, and it means this answers "no" for a directory that
 * is genuinely inside the root — the wrong direction to be wrong in, which is
 * why `decideWrite` is what production code calls. Use this where the caller
 * already holds both forms and has no filesystem to resolve them with.
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
 * slashes. The separator half of that is now **enforced** rather than assumed —
 * `buildSandboxPolicy` runs everything it emits through `canonicalPolicyPath`,
 * so this no longer depends on the caller spelling a workspace the way
 * `resolveCanonical` would. The absolute half is still a convention, and
 * `isWritePermitted`'s doc says where it stops.
 *
 * Case folding is the caller's decision and is not done here: on a
 * case-sensitive filesystem `Repo` and `repo` are different directories, and
 * folding would accept a path that only *spells* like one inside the root.
 * `packages/tools/src/containment.ts` already draws that line and does the
 * folding against the real filesystem; this is the pure fallback, and it says
 * so by not folding. Note that this makes the predicate over-strict rather
 * than permissive on Windows and macOS, where `.GIT/config` would slip past a
 * `.git` root — `decideWrite` is the one that takes the platform's answer, and
 * production calls it for exactly that reason.
 */
function isWithin(candidate: string, root: string): boolean {
	const normalizedRoot = root.replace(/\/+$/, "");
	return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}
