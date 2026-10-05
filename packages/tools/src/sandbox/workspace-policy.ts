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
import type { NetworkAxis, SandboxMode, SandboxPolicy, WritableRoot } from "@labunbun/agent";
import { policyFor } from "./index.ts";
import { findProtectedPaths } from "./protected-paths.ts";

/**
 * `.git` directories inside a workspace, **re-derived on every call**.
 *
 * **This was a cache, and the cache was the hole.** `protectedPathsFor` used to
 * memoise the walk per workspace for the life of the process, so the sequence
 * below handed the next spawn a list naming a path that no longer described
 * reality:
 *
 *   1. a Bash command runs `mv /w/repo/sub /w/repo/relocated`, where `sub/.git`
 *      was protected. The cached list still names `/w/repo/sub/.git`.
 *   2. a later Bash call spawns. `resolveSandboxExecution` re-derives every
 *      mount from that list, `exists("/w/repo/sub/.git")` is false, the
 *      protection lands on a path nothing uses, and `/w/repo/relocated/.git`
 *      receives **no mount at all**. A write through the new location succeeds
 *      inside the sandbox.
 *
 * **Both steps are required and neither is sufficient alone** — the rename
 * protects nothing by itself, and the stale list is what loses the protection.
 * The exposure is Bash and only Bash: `guardWritablePath` in `containment.ts`
 * matches `.git` at any depth for Edit and Write regardless of this list, and
 * the dangerous-command classifier still refuses `rm -rf .git`.
 *
 * **The backend was never the problem, and this is measured.** A real `bwrap`
 * (CI leg `test (bwrap on PATH)`) printed:
 *
 * ```console
 * [bwrap-smoke] ONE-PROCESS verdict: the read-only bind travels with the renamed
 *              directory; the row above is measuring re-derivation
 * ```
 *
 * The bind attaches to the dentry and `vfs_rename` renames in place, so
 * `…/relocated/.git` still resolves onto the same dentry and is still read-only
 * within the namespace that made the move. No argv change belongs here.
 * `sandbox-bwrap-smoke.test.ts` runs the two-command sequence against a real
 * `bwrap` with each command deriving its own policy through `workspacePolicy`,
 * so reintroducing a cache here turns that row red. (Before its rewrite the row
 * was red for a different reason — it built one policy by hand and reused it
 * across the move, asking this function nothing, so no fix here could ever make
 * it green. The smoke file's header keeps that story.)
 *
 * **Re-derive, not invalidate — the numbers are this machine's, measured, not
 * quoted.** The 76 ms below was measured elsewhere; these were re-taken here on
 * Windows against this repository as the workspace:
 *
 *   - one `findProtectedPaths` call, `node_modules` skipped: **152 ms** median
 *     over 5 runs (149.6–158.4). A trivial spawn on the same machine is 74 ms,
 *     so this is about two process creations, once per Bash call, on the
 *     largest tree anyone is plausibly to open this on.
 *   - with the skip removed: **3111 ms**. The skip stays, and its cost is the
 *     reason the walk is affordable at all.
 *
 * Invalidation was rejected because it fixes the reported instance and not the
 * class. Stat-ing the workspace root and re-walking when its mtime moves
 * detects the rename above — measured `true` — and **misses** `mv <ws>/a/b
 * <ws>/a/c` and `mv <ws>/src/deep <ws>/vendor/deep`, both measured `false`,
 * because neither changes the *root's* mtime, only the subtree's. A TTL is the
 * same guess in slower clothing: it answers "enough time has passed", never "a
 * rename happened one level down". Re-deriving has no such blind spot, and the
 * failure being fixed is the silent kind — a stale list produces a narrower
 * sandbox that reports success.
 *
 * A failed scan resolves to an empty list rather than rejecting, and there is
 * now **no previous answer to fall back to**: the last good list is precisely
 * the stale one this change exists to stop handing out, so reusing it would
 * reintroduce the hole on the error path. `findProtectedPaths` already skips an
 * unreadable subtree and keeps walking, so the `catch` below covers only a
 * failure of the walk as a whole. The caller is a tool about to do something
 * the user asked for, and a walk that cannot complete is a worse reason to
 * refuse that than the narrower coverage it costs — but the narrower coverage is
 * real and nobody is told. The one function that formats the count is
 * `describeSimulatedSandbox`, and nothing in production calls it, so a scan
 * that came back empty is silent.
 *
 * **What an empty list costs is the nested repositories, not the one you are
 * standing in.** An earlier version of this paragraph said the opposite — that
 * `buildSandboxPolicy` does not derive the workspace's own `.git` without a
 * scan, so an empty scan costs the top-level repository too, and "a root the
 * process cannot list loses every repository, and the policy that comes back
 * protects nothing at all." That is false, and false in the direction that
 * matters most for a reader deciding whether they are protected. `protectedFor`
 * in `sandbox-policy.ts:304-315` adds `join(root, ".git")` for every writable
 * root unconditionally, after the scan result is in hand — so the top-level
 * repository is derived, not found, and a scan that returns nothing still leaves
 * it in the policy. Two tests assert it from opposite directions:
 * `sandbox-policy.test.ts:34-50` ("derives `.git` rather than waiting to find
 * it" — two cases, an empty scan and a second writable root) against the policy
 * itself, and `sandbox-simulated.test.ts:443-447` from the layer that consumes
 * it.
 *
 * What the scan *is* for is repositories **below** the root, and it is narrower
 * than "below": `findProtectedPaths` stops at
 * `DEFAULT_PROTECTED_SCAN_DEPTH` = 4 segments (`protected-paths.ts:52-59`) and
 * does not descend into `node_modules` at all (`:74` — re-measured on this
 * machine at 152 ms with the skip and 3111 ms without it, against the 76 ms /
 * 1762 ms originally quoted from another one). Nothing else finds those, so the
 * failure this file can actually have is "a repository nested deeper than four
 * segments, or under `node_modules`, or on a machine where the walk threw, goes
 * unprotected" — and the top-level one is safe regardless of the scan.
 *
 * This is not Windows-only, and the residual exposure is worth being exact
 * about, because the backends fail differently:
 *
 *   - **native** takes its `--ro-bind` / `deny file-write*` entries from this
 *     same list plus `protectedFor`'s derivation, so an empty scan leaves
 *     `bwrap` and `sandbox-exec` protecting the workspace's own `.git` and
 *     nothing else — the kernel confinement is real and what it confines is
 *     partly missing.
 *   - **Write and Edit** are unaffected by this list: `decideWrite` reads it,
 *     but `guardWritablePath` in front of it matches the path and refuses
 *     every `.git` whatever the list says, so an empty scan cannot change
 *     what either tool does.
 *   - `rm -rf .git` is still refused, by the dangerous-command classifier, which
 *     is also a list — but one that is not this list.
 *
 * **The residual gap left here, stated so it is not rediscovered as a surprise.**
 * Re-deriving fixes the *staleness*, not the *reach*: a `mv` can carry a
 * protected `.git` to a depth the four-segment bound does not examine, and a
 * `.git` under `node_modules` is never found by a scan that skips it. That is a
 * separate, narrower hole and it is deliberately not fixed here — widening the
 * depth cap or the skip set is a cost decision, and the cost was measured above
 * for the skip. What re-deriving guarantees is the exact one: **a repository the
 * scan can see is protected at the place it currently is.**
 */
function protectedPathsFor(workspace: string): Promise<string[]> {
	return findProtectedPaths(workspace).catch(() => [] as string[]);
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
