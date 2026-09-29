/**
 * The one place a workspace's `SandboxPolicy` is built.
 *
 * The Bash tool and the file tools have to ask the *same* question — is this
 * write inside the roots, and is it version-control metadata — and get the same
 * answer. Two builders would be two policies: the shell could be confined to a
 * `.git` list the Write tool is not, and the symptom would be a refusal in one
 * tool and a success in the other for the same path, which is the shape a bug
 * takes when nobody is looking for it.
 *
 * So this is shared, and the `.git` discovery behind it is shared too.
 */
import type { SandboxMode, SandboxPolicy } from "@labunbun/agent";
import { policyFor } from "./index.ts";
import { findProtectedPaths } from "./protected-paths.ts";

/**
 * `.git` directories inside a workspace, discovered once per workspace.
 *
 * Keyed rather than a single module-level promise because tests build tools for
 * several temporary directories in one process, and a cache that answered for
 * the first workspace would hand the rest of them a list of paths that are not
 * theirs. A `.git` created *after* the first call is not picked up either,
 * which is stated rather than papered over: re-walking the tree on every tool
 * call would cost more than it is worth, and the tool-layer guard in
 * `containment.ts` covers the common case regardless — it matches on the path
 * rather than on a list, so it needs no scan.
 *
 * A failed scan resolves to an empty list rather than rejecting. The caller is a
 * tool that is about to do something the user asked for, and a permission error
 * in one subtree is a worse reason to refuse a write than the narrower coverage
 * it costs — but the narrower coverage is real, so `describeSimulatedSandbox`
 * reports the count the policy ended up with, and the count is 0 when this
 * happened.
 */
const protectedPathsCache = new Map<string, Promise<string[]>>();

function protectedPathsFor(workspace: string): Promise<string[]> {
	let found = protectedPathsCache.get(workspace);
	if (found === undefined) {
		found = findProtectedPaths(workspace).catch(() => [] as string[]);
		protectedPathsCache.set(workspace, found);
	}
	return found;
}

/** Forget what a workspace's scan found. Exists for tests, which build many. */
export function clearProtectedPathsCache(): void {
	protectedPathsCache.clear();
}

export interface WorkspacePolicyOptions {
	/** The sandbox axis value, read per call so `/mode` can change it mid-session. */
	sandbox: SandboxMode;
	/** Directories outside the workspace Read may still open (the spill dir). */
	readOnlyRoots?: string[];
	/** Directories outside the workspace that may be written. */
	writableRoots?: string[];
}

/**
 * The policy for "may this path be read", which is **not** the sandbox axis.
 *
 * Deliberately built with `workspace-write` whatever the session's sandbox is.
 * The Read tool's boundary is the application's — the workspace, plus the roots
 * the caller named — and it does not move with the mode: the same file is
 * readable in Agent and in Agent 无沙箱, exactly as the write tools' `.git` rule
 * does not move with the mode either. What the sandbox axis governs is the
 * shell, which on macOS and Linux is confined by the kernel and on Windows is
 * not confined at all.
 *
 * Passing the session's real policy here would be a widening nobody asked for.
 * `buildSandboxPolicy` returns `kind: "unrestricted"` for `danger-full-access`,
 * and `decideRead` on an unrestricted policy allows every path — so the mode
 * that turns the sandbox off would turn the Read tool into a way to open the
 * whole disk. Measured, not hypothesised: with the session policy threaded
 * through, `danger-full-access` + `Read("/etc/hosts")` succeeded.
 */
export function readableRootsPolicy(workspace: string, readOnlyRoots: string[]): SandboxPolicy {
	return policyFor({ sandbox: "workspace-write", workspace, readOnlyRoots });
}

/**
 * Build the policy the shell and the write tools consult.
 *
 * `readOnlyRoots` is the same list `createAllTools` already passes to the Read
 * tool, and it is passed here for the same reason: a directory that is readable
 * and not writable has to be sayable, and a `read` entry is how it is said. It
 * is what makes `decideWrite`'s read-only branch reachable at all — every root
 * the app currently builds is *outside* the workspace, and a tool that refuses
 * paths outside the workspace never gets that far.
 */
export async function workspacePolicy(workspace: string, options: WorkspacePolicyOptions): Promise<SandboxPolicy> {
	return policyFor({
		sandbox: options.sandbox,
		workspace,
		protectedPaths: await protectedPathsFor(workspace),
		readOnlyRoots: options.readOnlyRoots,
		writableRoots: options.writableRoots,
	});
}
