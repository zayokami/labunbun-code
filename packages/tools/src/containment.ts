/**
 * Path containment guards — prevent traversal outside allowed roots.
 *
 * Mirrors the `resolveCanonical` pattern from packages/agent/src/permissions.ts
 * (used in permission-rule matching) and the fix applied to memory.ts in task #24.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";

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

/**
 * Case folding belongs to the volume, not to the platform: macOS can be
 * formatted case-sensitive, and there `/Users/me/WS` is a different directory
 * from `/Users/me/ws`, so folding one into the other accepts an outside path as
 * contained. Probe once per volume by flipping the case of a name that already
 * exists there and asking whether the lookup lands on the same directory entry.
 * A volume that cannot be probed is treated as case-sensitive, which is the
 * direction that refuses more.
 */
const volumeCaseCache = new Map<string, boolean>();

/** The volume identity a probe answer is cached under. */
function volumeKey(absolutePath: string): string {
	if (process.platform === "win32") {
		const root = parse(absolutePath).root;
		if (root !== "") return `win32:${root.toLowerCase()}`;
	}
	let current = absolutePath;
	for (;;) {
		try {
			return `dev:${statSync(current).dev}`;
		} catch {
			const parent = dirname(current);
			if (parent === current) return `path:${current}`;
			current = parent;
		}
	}
}

function flipFirstLetter(name: string): string {
	return name.replace(/[A-Za-z]/, (char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()));
}

function sameEntry(dir: string, name: string): boolean {
	const flipped = flipFirstLetter(name);
	if (flipped === name) return false;
	try {
		const original = lstatSync(join(dir, name));
		const variant = lstatSync(join(dir, flipped));
		return original.dev === variant.dev && original.ino === variant.ino;
	} catch {
		// The flipped spelling does not resolve: this volume keeps the two apart.
		return false;
	}
}

function probeDirectory(dir: string): boolean {
	try {
		const name = basename(dir);
		// A volume root has no name of its own to flip; borrow one of its entries.
		if (name !== "" && /[A-Za-z]/.test(name) && dirname(dir) !== dir) return sameEntry(dirname(dir), name);
		for (const entry of readdirSync(dir)) {
			if (/[A-Za-z]/.test(entry)) return sameEntry(dir, entry);
		}
	} catch {
		// An unreadable or missing volume answers in the refusing direction.
	}
	return false;
}

/** Whether the filesystem holding `anchor` folds case. Cheap after the first call per volume. */
export function filesystemFoldsCase(anchor: string): boolean {
	const absolute = resolve(anchor);
	const key = volumeKey(absolute);
	const cached = volumeCaseCache.get(key);
	if (cached !== undefined) return cached;
	let current = absolute;
	let answer = false;
	for (;;) {
		try {
			const info = lstatSync(current);
			answer = probeDirectory(info.isDirectory() ? current : dirname(current));
			break;
		} catch {
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	volumeCaseCache.set(key, answer);
	return answer;
}

// Long-form design notes: docs/dev/tools.md
/**
 * Resolve the links in the part of `absolutePath` that exists, and keep the rest verbatim.
 *
 * `realpath` is the resolver to use. The default is Node's JavaScript one, which
 * leaves a Windows 8.3 short name as it was handed; {@link expandShortNames}
 * passes the native one, which expands them.
 */
function resolveSymlinks(
	absolutePath: string,
	realpath: (path: string) => string = (path) => realpathSync(path),
): string {
	const missing: string[] = [];
	let current = absolutePath;
	for (;;) {
		try {
			// A Windows realpath can come back extended-length prefixed; strip it
			// so the result still compares equal to the paths callers pass in.
			const real = realpath(current).replace(/^\\\\\?\\/, "");
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
export function isContainedIn(canonicalPath: string, canonicalRoot: string, foldsCase?: boolean): boolean {
	const trimmedRoot = canonicalRoot.replace(/\/$/, "");
	// The explicit answer exists for tests that have to model a case-sensitive
	// volume from a machine whose filesystems fold; production omits it and asks
	// the volume itself.
	const fold =
		(foldsCase ?? filesystemFoldsCase(trimmedRoot)) ? (value: string) => value.toLowerCase() : (value: string) => value;
	const path = fold(canonicalPath);
	const root = fold(trimmedRoot);
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

/**
 * The first protected segment of `path` below `root`, or `undefined`. Both are
 * canonical, and `fold` is the case rule the volume asks for. Containment is the
 * caller's to have established, so the slice is the workspace-relative path —
 * including any nested repository's own .git.
 */
function protectedSegmentBelow(root: string, path: string, fold: (value: string) => string): string | undefined {
	const foldedRoot = fold(root.replace(/\/$/, ""));
	const folded = fold(path);
	const relative = folded === foldedRoot ? "" : folded.slice(foldedRoot.length + 1);
	return relative.split("/").find((segment) => {
		if ((PROTECTED_SEGMENTS as readonly string[]).includes(segment)) return true;
		// The trimmed spelling counts too: a segment that is `.git` once the
		// dots and spaces at its end are removed is refused as well.
		// Long-form design notes: docs/dev/tools.md
		const trimmed = segment.replace(/[. ]+$/, "");
		return trimmed !== segment && (PROTECTED_SEGMENTS as readonly string[]).includes(trimmed);
	});
}

// Long-form design notes: docs/dev/tools.md
/**
 * A canonical path with the Windows 8.3 short names in its existing part
 * expanded to the long names the directory entries carry. `.git` has the alias
 * `GIT~1` on a volume that generates short names, and a name-based guard that
 * only sees the alias lets a write into the real `.git` through. Everywhere
 * else the answer is the path itself: no other platform has the aliases.
 */
function expandShortNames(canonicalPath: string): string {
	if (process.platform !== "win32") return canonicalPath;
	return normalizePathSeparators(resolveSymlinks(canonicalPath, (path) => realpathSync.native(path)));
}

// Long-form design notes: docs/dev/tools.md
/**
 * Verify a path the agent intends to write: contained in cwd, and not inside version-control metadata.
 *
 * `expandAlias` is the long-name resolver for the second look at the path, and
 * exists for tests: only Windows has aliases to expand, so a test elsewhere
 * supplies the mapping a Windows volume would.
 */
export function guardWritablePath(
	inputPath: string,
	cwd: string,
	operation: string,
	expandAlias: (canonicalPath: string) => string = expandShortNames,
): string {
	const resolved = guardPathContainment(inputPath, cwd, operation);
	const canonicalRoot = resolveCanonical(cwd, cwd);
	const fold = filesystemFoldsCase(canonicalRoot) ? (value: string) => value.toLowerCase() : (value: string) => value;
	let protectedSegment = protectedSegmentBelow(canonicalRoot, resolved, fold);
	if (protectedSegment === undefined) {
		// The spelling the path was given in is not the only one the filesystem
		// answers to. Looked at again in its long-name form, an alias of `.git`
		// shows up under its real name. A path that is not under the root in
		// that form is left to the containment check, which has already passed.
		const longRoot = expandAlias(canonicalRoot);
		const longPath = expandAlias(resolved);
		if (longPath !== resolved && isContainedIn(longPath, longRoot)) {
			protectedSegment = protectedSegmentBelow(longRoot, longPath, fold);
		}
	}

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
