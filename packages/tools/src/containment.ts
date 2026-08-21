/**
 * Path containment guards — prevent traversal outside allowed roots.
 *
 * Mirrors the `resolveCanonical` pattern from packages/agent/src/permissions.ts
 * (used in permission-rule matching) and the fix applied to memory.ts in task #24.
 */
import { resolve } from "node:path";

/** Normalize path separators for cross-platform comparison. */
export function normalizePathSeparators(path: string): string {
	return path.replace(/\\/g, "/");
}

/**
 * Resolve a path against cwd, collapsing `..`/`.` segments so traversal
 * sequences can't defeat string-prefix containment checks.
 */
export function resolveCanonical(filePath: string, cwd: string): string {
	return normalizePathSeparators(resolve(cwd, filePath));
}

/**
 * Check if a resolved file path is contained within an allowed root directory,
 * or is the root itself. Both paths must already be canonical (output of
 * resolveCanonical).
 */
export function isContainedIn(canonicalPath: string, canonicalRoot: string): boolean {
	const trimmedRoot = canonicalRoot.replace(/\/$/, "");
	const path = canonicalPath.toLowerCase();
	const root = trimmedRoot.toLowerCase();
	return path === root || path.startsWith(`${root}/`);
}

/**
 * Verify a user-supplied path resolves within cwd. Returns the canonical
 * resolved path on success; throws on containment violation.
 */
export function guardPathContainment(inputPath: string, cwd: string, operation: string): string {
	const resolved = resolveCanonical(inputPath, cwd);
	const canonicalCwd = resolveCanonical(cwd, cwd);

	if (!isContainedIn(resolved, canonicalCwd)) {
		throw new Error(
			`${operation}: path '${inputPath}' resolves outside workspace (${resolved} not under ${canonicalCwd})`,
		);
	}

	return resolved;
}
