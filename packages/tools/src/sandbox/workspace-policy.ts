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
import type { NetworkAxis, SandboxMode, SandboxPolicy } from "@labunbun/agent";
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
 * it costs — but the narrower coverage is real and nobody is told. The one
 * function that formats the count is `describeSimulatedSandbox`, and nothing in
 * production calls it, so a scan that came back empty is silent.
 *
 * **What an empty list costs is the nested repositories, not the one you are
 * standing in.** An earlier version of this paragraph said the opposite — that
 * `buildSandboxPolicy` does not derive the workspace's own `.git` without a
 * scan, so an empty scan costs the top-level repository too, and "a root the
 * process cannot list loses every repository, and the policy that comes back
 * protects nothing at all." That is false, and false in the direction that
 * matters most for a reader deciding whether they are protected. `protectedFor`
 * in `sandbox-policy.ts:258-266` adds `join(root, ".git")` for every writable
 * root unconditionally, after the scan result is in hand — so the top-level
 * repository is derived, not found, and a scan that returns nothing still leaves
 * it in the policy. Two tests assert it from opposite directions:
 * `sandbox-policy.test.ts:34-50` ("derives `.git` rather than waiting to find
 * it" — two cases, an empty scan and a second writable root) against the policy
 * itself, and `sandbox-simulated.test.ts:353-357` from the layer that consumes
 * it.
 *
 * What the scan *is* for is repositories **below** the root, and it is narrower
 * than "below": `findProtectedPaths` stops at
 * `DEFAULT_PROTECTED_SCAN_DEPTH` = 4 segments (`protected-paths.ts:52-59`) and
 * does not descend into `node_modules` at all (`:74`, for the measured 76 ms vs
 * 1762 ms). Nothing else finds those, so the failure this file can actually
 * have is "a repository nested deeper than four segments, or under
 * `node_modules`, or on a machine where the walk threw, goes unprotected" — and
 * the top-level one is safe regardless of the scan.
 *
 * This is not Windows-only, and the residual exposure is worth being exact
 * about, because the backends fail differently:
 *
 *   - **native** takes its `--ro-bind` / `deny file-write*` entries from this
 *     same list plus `protectedFor`'s derivation, so an empty scan leaves
 *     `bwrap` and `sandbox-exec` protecting the workspace's own `.git` and
 *     nothing else — the kernel confinement is real and what it confines is
 *     partly missing.
 *   - **Write and Edit** are unaffected by this list entirely, because
 *     `containment.ts` matches on the path and never consults one.
 *   - `rm -rf .git` is still refused, by the dangerous-command classifier, which
 *     is also a list — but one that is not this list.
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

export interface WorkspacePolicyOptions {
	/** The sandbox axis value, read per call so `/mode` can change it mid-session. */
	sandbox: SandboxMode;
	/** Directories outside the workspace Read may still open (the spill dir). */
	readOnlyRoots?: string[];
	/** Directories outside the workspace that may be written. */
	writableRoots?: string[];
	/**
	 * The network axis. Read per call alongside `sandbox` for the same reason:
	 * `/mode` can change the session and a tool holding the value it was built
	 * with would keep enforcing the old one.
	 *
	 * Optional, unlike `sandbox`, because the *read* policy below is built
	 * without a session and the network does not move the Read tool's boundary.
	 */
	network?: NetworkAxis;
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
		network: options.network,
	});
}
