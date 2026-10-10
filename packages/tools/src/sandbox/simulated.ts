// The Windows filesystem sandbox — which is not a sandbox, and says so. It is
// not OS-level enforcement: read its result as "the tool call was refused by
// this process", never as "the write could not have happened".
// Long-form design notes: docs/dev/sandbox.md
import { canRead, canWrite, type FileSystemAccessMode, type SandboxPolicy } from "@labunbun/agent";
import { normalizePathSeparators, resolveCanonical } from "../containment.ts";

// Long-form design notes: docs/dev/sandbox.md
/** The one sentence every surface that shows this layer has to show. */
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
	// Long-form design notes: docs/dev/sandbox.md
	/** Which filesystem's rules to judge by, explicit so the layer is testable from either machine. */
	platform?: string;
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether paths on this platform may differ only in case, mirroring the tool layer's own rule. */
export function caseInsensitiveSandboxPaths(platform: string = process.platform): boolean {
	return platform === "win32" || platform === "darwin";
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether this write is permitted, and if not, why. */
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

// Long-form design notes: docs/dev/sandbox.md
/** Whether this read is permitted. Kept beside the write decision because they answer different questions. */
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

// Long-form design notes: docs/dev/sandbox.md
/** A one-line summary of this layer, for a caller holding a policy and nowhere to put it. */
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

// Long-form design notes: docs/dev/sandbox.md
/** Whether `candidate` sits inside `root`, the root itself included, with the case rule supplied. */
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
