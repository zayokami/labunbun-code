// The sandbox policy: one data shape, several translators. Pure, so what a mode
// means can be asserted without spawning anything.
// Long-form design notes: docs/dev/sandbox.md
import { join } from "node:path";
import type { NetworkDomainRule } from "./network-policy.ts";
import type { SandboxMode } from "./types.ts";

// Long-form design notes: docs/dev/sandbox.md
/** The one spelling a path inside a policy is allowed to have. */
function canonicalPolicyPath(path: string): string {
	return path.replace(/\\/g, "/");
}

/** Whether the filesystem is confined at all. */
export type FileSystemSandboxKind = "restricted" | "unrestricted";

// Long-form design notes: docs/dev/sandbox.md
/** What a single path is allowed. `write` implies `read`. */
export type FileSystemAccessMode = "read" | "write" | "deny";

// Long-form design notes: docs/dev/sandbox.md
/** What kind of place a writable root is, which decides whether `<root>/.git` is derived. A `project` root derives it. */
export type WritableRootKind = "project" | "data";

// Long-form design notes: docs/dev/sandbox.md
/** A writable root, as a bare path or with the kind that decides its `.git` derivation. A bare string means `project`. */
export type WritableRoot = string | { path: string; kind: WritableRootKind };

/** The two fields the builders below need, whichever spelling arrived. */
export interface NormalizedWritableRoot {
	path: string;
	kind: WritableRootKind;
}

export function normalizeWritableRoot(root: WritableRoot): NormalizedWritableRoot {
	return typeof root === "string" ? { path: root, kind: "project" } : { path: root.path, kind: root.kind };
}

/**
 * The network axis values, as a value so the settings schema can derive its
 * enum from them — the `PERMISSION_MODES` lesson (F1), applied to the second
 * axis: a hand-written `z.enum(["enabled", "restricted"])` in the settings file
 * is a copy of this list that can drift.
 */
export const NETWORK_SANDBOX_POLICIES = ["restricted", "enabled"] as const;

/** How much of the network a confined command may use. */
export type NetworkSandboxPolicy = (typeof NETWORK_SANDBOX_POLICIES)[number];

export interface FileSystemSandboxEntry {
	// Long-form design notes: docs/dev/sandbox.md
	/** Absolute, with `/` separators. Backends match on this string, not on a pattern. */
	path: string;
	access: FileSystemAccessMode;
	// Long-form design notes: docs/dev/sandbox.md
	/** `skip` drops the entry when the path does not exist instead of failing. */
	missingPathBehavior?: "skip";
}

export interface FileSystemSandboxPolicy {
	kind: FileSystemSandboxKind;
	entries: FileSystemSandboxEntry[];
}

export interface SandboxPolicy {
	fileSystem: FileSystemSandboxPolicy;
	network: NetworkSandboxPolicy;
	// Long-form design notes: docs/dev/sandbox.md
	/** The domain table the proxy enforces. Empty means "judge by mode alone". */
	networkRules: NetworkDomainRule[];
	// Long-form design notes: docs/dev/sandbox.md
	/** Paths inside the workspace that must never be written, whatever else the policy allows. */
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
	/**
	 * Directories outside the workspace that may be written (a build cache, say).
	 *
	 * Each one says whether it is a `project` or `data` place, and that label is
	 * read here for exactly one thing: whether `<root>/.git` is derived. A bare
	 * string counts as `project`, which is what every caller before this type got.
	 */
	writableRoots?: WritableRoot[];
	/** Outside the workspace, readable but not writable (the tool-output spill dir). */
	readOnlyRoots?: string[];
	// Long-form design notes: docs/dev/sandbox.md
	/** The network axis, which is **not** derived from `sandbox`. Defaults to `enabled`. */
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

// Long-form design notes: docs/dev/sandbox.md
/** Build the policy for a sandbox axis value. `danger-full-access` produces an empty policy, not a very wide one. */
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
	// Normalised once, here, so the entry list and the `.git` derivation below are
	// two readings of one answer. Reading `options.writableRoots` twice would be
	// two places that have to agree about which spelling a bare string means.
	const writableRoots = (options.writableRoots ?? []).map(normalizeWritableRoot);
	for (const root of writableRoots) {
		entries.push({ path: canonicalPolicyPath(root.path), access: "write", missingPathBehavior: "skip" });
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
		protected: protectedFor(options, [
			workspace,
			// Only the roots that said they are a project get a derived `.git`. The
			// workspace always does — it is one by definition. A `data` root is a
			// cache or a scratch directory; deriving `<root>/.git` for one puts a
			// read-only mount at a path no repository is going to use, and on Linux
			// `readOnlyPathArgs` *creates* an empty read-only directory there when the
			// path is absent, so the cost is a directory that appears for nobody.
			...writableRoots.filter((root) => root.kind === "project").map((root) => root.path),
		]),
	};
}

// Long-form design notes: docs/dev/sandbox.md
/** The protected paths a confined policy carries: what the caller found, plus the derived `<root>/.git`. */
function protectedFor(options: BuildSandboxPolicyOptions, gitRoots: string[]): string[] {
	const found = options.protectedPaths ?? [];
	const out = new Set(found.map(canonicalPolicyPath));
	for (const root of gitRoots) {
		if (root === "") continue;
		// `join` first, then canonicalise. The other order loses: `join` is what
		// puts a `\` into the string on Windows, and `canonicalPolicyPath` after it
		// is the only ordering that ends with the one spelling `isWithin` compares.
		out.add(canonicalPolicyPath(join(root, ".git")));
	}
	return [...out];
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether `candidate` is a write this policy permits, judged lexically, with no filesystem access. */
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

// Long-form design notes: docs/dev/sandbox.md
/** Whether `candidate` sits inside `root`, treating the root itself as inside. */
function isWithin(candidate: string, root: string): boolean {
	const normalizedRoot = root.replace(/\/+$/, "");
	return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}
