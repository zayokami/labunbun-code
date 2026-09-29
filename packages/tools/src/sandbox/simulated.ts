/**
 * The Windows filesystem sandbox — which is not a sandbox, and says so.
 *
 * Codex's Windows implementation compiles two helper binaries and registers a
 * Windows service (`windows-sandbox-rs`, `windows-sandbox-service`); the shell
 * then goes through a service that holds the real handle and applies the real
 * ACLs. This build does none of that — the user ruled a helper program out —
 * and there is no user-mode equivalent of macOS `seatbelt`.
 *
 * So what this module is: **a decision this process makes about calls that
 * arrive through the tools.** A subprocess that goes around the tools is not
 * subject to it, and nothing here should ever be described as if it were. Read
 * the result of this module as "the Write/Edit tool call was refused by this
 * process", never as "the write could not have happened".
 *
 * What it buys is that the decision is *made and said out loud*, in one place,
 * from a policy value that can be asserted. Before this existed the `.git`
 * guard lived only in the tool layer and the policy was never consulted;
 * `rm .git/config` through Bash was `allow` in `agent` mode, measured.
 *
 * The rule every function here obeys: **a wrong answer may narrow access, never
 * widen it.** A path this module cannot place inside a known root is refused.
 * There is no "no opinion" branch, because a caller that reads "no opinion" as
 * "carry on" is a caller that a bug in here turns into a bypass.
 */
import { canRead, canWrite, type FileSystemAccessMode, type SandboxPolicy } from "@labunbun/agent";
import { normalizePathSeparators, resolveCanonical } from "../containment.ts";

/**
 * The one sentence every surface that shows this layer has to show.
 *
 * Exported rather than written into each call site because the mode banner,
 * `/doctor`, and a deny message are three places a softened version would
 * appear, and a softened version — "sandboxed", "protected", "confined" with
 * nothing after it — is how a tool-layer check ends up reading as a kernel one.
 */
export const SIMULATED_SANDBOX_DISCLAIMER =
	"checked in this process for calls that arrive through the tools; a subprocess started outside them is not subject to it, and no OS mechanism is enforcing this";

/**
 * The outcome of a path decision. The `reason` is not a diagnostic: it is what
 * the model reads and has to act on, so an allow carries `undefined` and a deny
 * always carries a non-empty explanation of what rule refused it and where the
 * path actually landed. A deny with no reason is indistinguishable from a bug.
 */
export type SandboxDecision =
	| { allowed: true; reason: undefined; canonicalPath: string }
	| { allowed: false; reason: string; canonicalPath: string };

export interface SandboxDecisionOptions {
	/**
	 * Which filesystem's rules to judge by. Explicit so the layer is testable
	 * from either machine — `classifyDangerousCommand` takes the same parameter
	 * for the same reason, and a test that skips itself on the machine it runs
	 * on reports green without having checked anything.
	 *
	 * Defaults to `process.platform`.
	 */
	platform?: string;
}

/**
 * Whether paths on this platform may differ only in case.
 *
 * Mirrors `caseInsensitivePaths` in `../containment.ts`, including macOS: APFS
 * is case-insensitive by default, and a build that treated a Mac workspace as
 * case-sensitive would let `.GIT/config` past a `.git` rule on the platform
 * where that costs a user their history. Anything not named — a BSD, a
 * hypothetical — is case-sensitive, which is the direction that refuses more.
 */
export function caseInsensitiveSandboxPaths(platform: string = process.platform): boolean {
	return platform === "win32" || platform === "darwin";
}

/**
 * Whether this write is permitted, and if not, why.
 *
 * The candidate is canonicalised first — through `resolveCanonical`, the same
 * helper the tool layer uses — and only then compared. String-prefixing the raw
 * input is the defect this ordering exists to prevent: a path is allowed here
 * because of what it *spells like*, and a symlink, a junction, a `..`, or a
 * different spelling of a directory name all make the spelling lie.
 *
 * The comparison itself is `isWithinRoot` below, which is a three-line
 * predicate rather than a call to `isContainedIn` — see the comment on it for
 * why, and `sandbox-simulated.test.ts` for the assertion that keeps the two
 * from drifting apart.
 *
 * `@labunbun/agent`'s `isWritePermitted` is the same rule judged lexically
 * with no filesystem access. It is the right answer when the caller has
 * already canonicalised and the two platforms' case rules agree, and it is
 * not consulted here because the layer that *has* a filesystem should use it.
 */
export function decideWrite(
	policy: SandboxPolicy,
	candidatePath: string,
	cwd: string,
	options: SandboxDecisionOptions = {},
): SandboxDecision {
	const platform = options.platform ?? process.platform;
	const resolved = resolveCanonical(candidatePath, cwd);

	// `danger-full-access` is recognised as the absence of a policy rather than
	// as a policy that happens to allow everything, and this branch returns
	// before any rule is consulted. That is the whole meaning of the mode: the
	// allow below comes from the policy being unrestricted, not from a check
	// having passed, and no check ran.
	if (policy.fileSystem.kind === "unrestricted") {
		return { allowed: true, reason: undefined, canonicalPath: resolved };
	}

	// Most specific first. This ordering is the decision, and getting it backwards
	// is not a slower decision but a wrong one: a `read` entry or a `deny` entry
	// *nested inside* a writable root is the more specific of the two, so an allow
	// that runs first answers for it and the narrower entry never gets read. The
	// case that motivated it is a generated directory marked read-only inside the
	// workspace — the workspace allow matched, the read-only rule did not, and the
	// write went through.
	for (const protectedPath of policy.protected) {
		if (isWithinRoot(resolved, protectedPath, platform)) {
			return {
				allowed: false,
				canonicalPath: resolved,
				reason:
					`'${candidatePath}' resolves to '${resolved}', which is inside '${protectedPath}' — ` +
					`version-control metadata, which this policy protects and a hand edit cannot put back`,
			};
		}
	}

	// The two denials are different failures with different fixes, so they are
	// named separately rather than collapsed into "not allowed": one is a path
	// refused outright, the other is a root the user made readable on purpose.
	for (const entry of policy.fileSystem.entries) {
		if (entry.access !== "deny") continue;
		if (isWithinRoot(resolved, entry.path, platform)) {
			return {
				allowed: false,
				canonicalPath: resolved,
				reason: `'${candidatePath}' resolves to '${resolved}', which is inside '${entry.path}', a path this policy refuses outright`,
			};
		}
	}

	for (const entry of policy.fileSystem.entries) {
		if (!canRead(entry.access) || canWrite(entry.access)) continue;
		if (isWithinRoot(resolved, entry.path, platform)) {
			return {
				allowed: false,
				canonicalPath: resolved,
				reason: `'${candidatePath}' resolves to '${resolved}', which is inside '${entry.path}'; that root is readable but not writable under this policy`,
			};
		}
	}

	for (const entry of policy.fileSystem.entries) {
		if (!canWrite(entry.access)) continue;
		if (isWithinRoot(resolved, entry.path, platform)) {
			return { allowed: true, reason: undefined, canonicalPath: resolved };
		}
	}

	const writableRoots = policy.fileSystem.entries.filter((entry) => canWrite(entry.access)).map((entry) => entry.path);
	const named = writableRoots.length > 0 ? writableRoots.join(", ") : "none defined";
	return {
		allowed: false,
		canonicalPath: resolved,
		reason: `'${candidatePath}' resolves to '${resolved}', which is not inside any root this policy allows writing (${named})`,
	};
}

/**
 * Whether this read is permitted.
 *
 * Kept beside the write decision rather than in the caller because the two
 * answer different questions about the same entry, and a caller that derived
 * "readable" from "writable" would refuse to read a read-only root — the one
 * place a read-only root is useful. The `.git` rule is *not* applied here:
 * reading history, diffs, and logs is ordinary work, which is why
 * `guardWritablePath` refuses it for writes and leaves reads alone too.
 */
export function decideRead(
	policy: SandboxPolicy,
	candidatePath: string,
	cwd: string,
	options: SandboxDecisionOptions = {},
): SandboxDecision {
	const platform = options.platform ?? process.platform;
	const resolved = resolveCanonical(candidatePath, cwd);

	if (policy.fileSystem.kind === "unrestricted") {
		return { allowed: true, reason: undefined, canonicalPath: resolved };
	}

	// Most specific first, for the same reason as `decideWrite`: a `deny` entry
	// nested inside a readable root is the narrower of the two, and an allow that
	// runs first answers for it without ever reaching the refusal.
	for (const entry of policy.fileSystem.entries) {
		if (canRead(entry.access)) continue;
		if (isWithinRoot(resolved, entry.path, platform)) {
			return {
				allowed: false,
				canonicalPath: resolved,
				reason: `'${candidatePath}' resolves to '${resolved}', which is inside '${entry.path}', a path this policy refuses outright`,
			};
		}
	}

	for (const entry of policy.fileSystem.entries) {
		if (canRead(entry.access) && isWithinRoot(resolved, entry.path, platform)) {
			return { allowed: true, reason: undefined, canonicalPath: resolved };
		}
	}

	const readableRoots = policy.fileSystem.entries.filter((entry) => canRead(entry.access)).map((entry) => entry.path);
	const named = readableRoots.length > 0 ? readableRoots.join(", ") : "none defined";
	return {
		allowed: false,
		canonicalPath: resolved,
		reason: `'${candidatePath}' resolves to '${resolved}', which is not inside any root this policy allows reading (${named})`,
	};
}

/**
 * The one line `/doctor` and the mode banner show for this layer.
 *
 * A single sentence, because the sentence is the thing a user forms their
 * mental model from. It names what the mode means, what the mechanism actually
 * is, and — the part that must not be dropped in a summary — that nothing
 * outside this process is subject to it.
 */
export function describeSimulatedSandbox(policy: SandboxPolicy): string {
	if (policy.fileSystem.kind === "unrestricted") {
		return "danger-full-access: the policy is unrestricted, so no path check runs at all — every path, including .git, is writable";
	}

	const writable = policy.fileSystem.entries.filter((entry) => canWrite(entry.access)).length;
	const readable = policy.fileSystem.entries.filter((entry) => !canWrite(entry.access)).length;
	const protectedCount = policy.protected.length;
	const roots =
		`${writable} writable root${writable === 1 ? "" : "s"}` +
		(readable > 0 ? `, ${readable} read-only root${readable === 1 ? "" : "s"}` : "") +
		(protectedCount > 0 ? `, ${protectedCount} protected path${protectedCount === 1 ? "" : "s"}` : "");

	return `workspace-write, simulated: ${roots} — ${SIMULATED_SANDBOX_DISCLAIMER}`;
}

/**
 * Whether `candidate` sits inside `root`, the root itself included.
 *
 * This is `isContainedIn` with the case rule supplied rather than read off the
 * host, and that is the entire reason it exists. `isContainedIn` folds case
 * when — and only when — the process is running on a case-insensitive
 * filesystem, so on a Linux CI machine there is no way to ask this function the
 * Windows question, and a Windows machine cannot be shown the POSIX one. Both
 * answers are reachable, and both are wrong to guess: a decision that folded
 * case on a case-sensitive filesystem would refuse more than it should, and one
 * that did not fold on a case-insensitive one would let `.GIT/config` past a
 * `.git` rule, which is the direction this layer is not allowed to fail in.
 *
 * Duplicating a three-line predicate is cheaper than a wrong answer, but only
 * because it is pinned: `sandbox-simulated.test.ts` asserts that on the
 * platform where the two case rules agree, this and `isContainedIn` return the
 * same answer for the same inputs. Change either and that test goes red.
 *
 * The root is canonicalised here rather than at the point the policy is built,
 * because the two are not the same guarantee. `candidate` arrives already
 * resolved by the caller; `root` arrives however the caller spelled it, and
 * those two spellings are not always the same directory. macOS is the case that
 * broke this — and it broke it in the loudest direction available: `os.tmpdir()`
 * is `/var/folders/…`, which is a symlink to `/private/var/folders/…`, so every
 * canonicalised path stopped matching a lexically-compared root and the layer
 * refused *every write in the workspace*. Not one machine this was developed on
 * has that symlink, so no local run could see it; the macOS CI job did, in the
 * first run. `guardPathContainment` never had the bug because it resolves both
 * sides, which is the shape this now has.
 *
 * The cost is a `realpathSync` per root per decision — a policy carries a
 * handful of roots, and a write is already a file operation, so this is not the
 * expensive part of the answer. Correctness in the decision function beats a
 * cache here for the reason given above: a "roots are canonical" convention is
 * exactly the kind of invariant that lives in a comment and dies with the
 * caller that knew about it.
 */
function isWithinRoot(candidate: string, root: string, platform: string): boolean {
	const fold = caseInsensitiveSandboxPaths(platform)
		? (value: string) => value.toLowerCase()
		: (value: string) => value;
	// `resolveCanonical(root, root)` is `guardPathContainment`'s own spelling:
	// resolve the absolute path against itself, which is a no-op for the
	// `resolve` step and a symlink walk for the rest. A root that does not exist
	// degrades to the lexical form rather than throwing, which is what keeps the
	// decision usable for a workspace that has not been created yet.
	const normalizedRoot = normalizePathSeparators(resolveCanonical(root, root)).replace(/\/$/, "");
	const path = fold(normalizePathSeparators(candidate));
	const trimmedRoot = fold(normalizedRoot);
	return path === trimmedRoot || path.startsWith(`${trimmedRoot}/`);
}

/** Re-exported so a caller reading this file can see which access levels exist. */
export type { FileSystemAccessMode };
