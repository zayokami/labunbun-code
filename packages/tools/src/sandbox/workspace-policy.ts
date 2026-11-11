// The one place a workspace's `SandboxPolicy` is built, shared by the Bash tool
// and the file tools so both ask the same question and get the same answer.
// Long-form design notes: docs/dev/sandbox.md
import type { NetworkAxis, SandboxMode, SandboxPolicy, WritableRoot } from "@labunbun/agent";
import { policyFor } from "./index.ts";
import { findProtectedPaths } from "./protected-paths.ts";

/** Reported once per process: the scan runs on every call, the condition does not change under it. */
let protectedPathsFailureReported = false;

// Long-form design notes: docs/dev/sandbox.md
/** `.git` directories inside a workspace, re-derived on every call. The smoke test keeps the cache story. */
function protectedPathsFor(workspace: string): Promise<string[]> {
	return findProtectedPaths(workspace).catch((error: unknown) => {
		// The walk itself already absorbs per-directory failures (see
		// `protected-paths.ts` — one unreadable subtree costs only its own coverage),
		// so reaching here means something it cannot degrade past. The empty list is
		// still returned — a policy that does not load confines nothing, which is
		// worse than one that confines less — but not silently: an unreported drop
		// of `.git` protection is the exact failure this seam exists to prevent.
		if (!protectedPathsFailureReported) {
			protectedPathsFailureReported = true;
			console.error(
				`Warning: could not scan ${workspace} for protected paths: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return [] as string[];
	});
}

export interface WorkspacePolicyOptions {
	/** The sandbox axis value, read per call so `/mode` can change it mid-session. */
	sandbox: SandboxMode;
	/** Directories outside the workspace Read may still open (the spill dir). */
	readOnlyRoots?: string[];
	/**
	 * Directories outside the workspace that may be written.
	 *
	 * Each one carries whether it is a `project` or a `data` place, which is what
	 * decides whether `<root>/.git` is derived as protected. `resolveWritableRoots`
	 * in `default-writable-roots.ts` is what fills this in for the shell.
	 */
	writableRoots?: WritableRoot[];
	// Long-form design notes: docs/dev/sandbox.md
	/** The network axis, read per call. Optional, because the read policy below is built without a session. */
	network?: NetworkAxis;
	/**
	 * Whether to walk the workspace for nested `.git` directories. Defaults to
	 * true. Write and Edit pass false: `guardWritablePath` refuses `.git` at any
	 * depth before either tool consults the policy, so a path the scan finds can
	 * never reach a write decision. Bash keeps the default and still re-derives
	 * on every call — this flag is not a cache.
	 */
	deriveProtectedPaths?: boolean;
}

// Long-form design notes: docs/dev/sandbox.md
/** The policy for "may this path be read", which is **not** the sandbox axis. */
export function readableRootsPolicy(workspace: string, readOnlyRoots: string[]): SandboxPolicy {
	return policyFor({ sandbox: "workspace-write", workspace, readOnlyRoots });
}

// Long-form design notes: docs/dev/sandbox.md
/** Build the policy the shell and the write tools consult. */
export async function workspacePolicy(workspace: string, options: WorkspacePolicyOptions): Promise<SandboxPolicy> {
	// The scan is only consulted for `workspace-write`: the other two modes
	// return an empty protected list from `buildSandboxPolicy` and discard its
	// answer, so walking the tree for them is cost with no decision behind it.
	const derive = options.deriveProtectedPaths !== false && options.sandbox === "workspace-write";
	return policyFor({
		sandbox: options.sandbox,
		workspace,
		protectedPaths: derive ? await protectedPathsFor(workspace) : [],
		readOnlyRoots: options.readOnlyRoots,
		writableRoots: options.writableRoots,
		network: options.network,
	});
}
