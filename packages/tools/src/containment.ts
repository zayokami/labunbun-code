/**
 * Path containment guards — prevent traversal outside allowed roots.
 *
 * Mirrors the `resolveCanonical` pattern from packages/agent/src/permissions.ts
 * (used in permission-rule matching) and the fix applied to memory.ts in task #24.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Normalize path separators for cross-platform comparison. */
export function normalizePathSeparators(path: string): string {
	return path.replace(/\\/g, "/");
}

/**
 * Whether path comparison may fold case, which is a property of the filesystem
 * rather than of the code: on a case-sensitive filesystem `Repo/FOO` and
 * `repo/foo` are different directories, so folding would accept a path that
 * only *spells* like one inside the workspace.
 */
export const caseInsensitivePaths = process.platform === "win32" || process.platform === "darwin";

function foldCase(path: string): string {
	return caseInsensitivePaths ? path.toLowerCase() : path;
}

// Long-form design notes: docs/dev/tools.md
/** Resolve the links in the part of `absolutePath` that exists, and keep the rest verbatim. */
function resolveSymlinks(absolutePath: string): string {
	const missing: string[] = [];
	let current = absolutePath;
	for (;;) {
		try {
			// A Windows realpath can come back extended-length prefixed; strip it
			// so the result still compares equal to the paths callers pass in.
			const real = realpathSync(current).replace(/^\\\\\?\\/, "");
			return missing.length > 0 ? join(real, ...missing.reverse()) : real;
		} catch {
			const parent = dirname(current);
			// Nothing on this path exists — keep the lexical resolution.
			if (parent === current) return absolutePath;
			missing.push(basename(current));
			current = parent;
		}
	}
}

/**
 * Resolve a path against cwd, collapsing `..`/`.` segments so traversal
 * sequences can't defeat string-prefix containment checks, and resolving
 * symlinks so a link can't be used to point those checks somewhere else.
 */
export function resolveCanonical(filePath: string, cwd: string): string {
	return normalizePathSeparators(resolveSymlinks(resolve(cwd, filePath)));
}

/**
 * Check if a resolved file path is contained within an allowed root directory,
 * or is the root itself. Both paths must already be canonical (output of
 * resolveCanonical).
 */
export function isContainedIn(canonicalPath: string, canonicalRoot: string): boolean {
	const trimmedRoot = canonicalRoot.replace(/\/$/, "");
	const path = foldCase(canonicalPath);
	const root = foldCase(trimmedRoot);
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

/** Directories the agent must not rewrite, whatever the permission mode says. */
const PROTECTED_SEGMENTS = [".git"] as const;

// Long-form design notes: docs/dev/tools.md
/** Verify a path the agent intends to write: contained in cwd, and not inside version-control metadata. */
export function guardWritablePath(inputPath: string, cwd: string, operation: string): string {
	const resolved = guardPathContainment(inputPath, cwd, operation);
	const root = foldCase(resolveCanonical(cwd, cwd).replace(/\/$/, ""));
	const folded = foldCase(resolved);
	// Containment above guarantees the prefix, so the slice is the workspace-
	// relative path — including any nested repository's own .git.
	const relative = folded === root ? "" : folded.slice(root.length + 1);
	const protectedSegment = relative.split("/").find((segment) => {
		if ((PROTECTED_SEGMENTS as readonly string[]).includes(segment)) return true;
		// The trimmed spelling counts too: a segment that is `.git` once the
		// dots and spaces at its end are removed is refused as well.
		// Long-form design notes: docs/dev/tools.md
		const trimmed = segment.replace(/[. ]+$/, "");
		return trimmed !== segment && (PROTECTED_SEGMENTS as readonly string[]).includes(trimmed);
	});

	if (protectedSegment !== undefined) {
		// The *canonical* name in the message, not the spelling that was refused:
		// `.git /config` reading "is inside .git /" is confusing in a way that
		// matters, since the user has to act on this string. The canonical name is
		// `PROTECTED_SEGMENTS` if the trimmed form matched and the raw one did not.
		const named = (PROTECTED_SEGMENTS as readonly string[]).includes(protectedSegment)
			? protectedSegment
			: protectedSegment.replace(/[. ]+$/, "");
		throw new Error(
			`${operation}: '${inputPath}' is inside ${named}/ — version-control metadata is not writable by the agent (${resolved})`,
		);
	}

	return resolved;
}
