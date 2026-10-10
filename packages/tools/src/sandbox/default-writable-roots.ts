// The directories a confined command may write to outside the workspace: the
// temp directory and the per-user package caches, unless a user list replaces them.
// Long-form design notes: docs/dev/sandbox.md
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WritableRoot } from "@labunbun/agent";

export interface WritableRootOptions {
	/**
	 * The home directory this session is serving, or `undefined` when the caller
	 * has not said. Never defaulted to the process's own — see the file header.
	 */
	home?: string;
	/**
	 * Stands in for `os.tmpdir()`. A parameter rather than a call in the body, for
	 * the same reason `home` is one: the value this function returns is a fact
	 * about a machine, and a test that asserted on the developer's temp directory
	 * would be asserting about the developer's machine.
	 */
	tempDir?: string;
	// Long-form design notes: docs/dev/sandbox.md
	/** `permissions.additionalDirectories`, verbatim. Non-empty replaces the defaults. */
	configured?: readonly string[];
}

/** The per-user package caches this build grants, relative to a supplied home. */
const PACKAGE_CACHE_DIRS = [".npm", ".bun"] as const;

// Long-form design notes: docs/dev/sandbox.md
/** The writable roots a confined Bash command gets, in the order they are handed to the policy builder. */
export function resolveWritableRoots(options: WritableRootOptions): WritableRoot[] {
	// A configured list is checked *after* it is cleaned, not before: the rule is
	// "a list that names a usable directory replaces the defaults", so `[]`,
	// `[""]` and `["", ""]` all mean the same thing and none of them can leave a
	// session with no writable root outside the workspace at all. The measured
	// reason the fallback exists at all is in the file header.
	const configured = options.configured === undefined ? [] : dedupe(options.configured.map(projectRoot));
	if (configured.length > 0) return configured;

	const roots: WritableRoot[] = [];
	const temp = options.tempDir ?? tmpdir();
	// `data`, not `project`: `$TMPDIR/.git` is not a repository, and on Linux
	// deriving one would make bwrap create an empty read-only directory inside the
	// temp dir for nobody. See `WritableRootKind`.
	if (temp !== "") roots.push({ path: temp, kind: "data" });

	// Guarded on `""` as well as `undefined`: `join("", ".npm")` is the relative
	// path `.npm`, and a relative entry matches nothing while looking like a root.
	if (options.home !== undefined && options.home !== "") {
		for (const dir of PACKAGE_CACHE_DIRS) roots.push({ path: join(options.home, dir), kind: "data" });
	}
	return roots;
}

// Long-form design notes: docs/dev/sandbox.md
/** A directory the user named in `permissions.additionalDirectories`, labelled `project`. */
function projectRoot(path: string): WritableRoot {
	return { path, kind: "project" };
}

function dedupe(roots: WritableRoot[]): WritableRoot[] {
	const seen = new Set<string>();
	const out: WritableRoot[] = [];
	for (const root of roots) {
		const path = typeof root === "string" ? root : root.path;
		// An empty entry is not a root. `buildSandboxPolicy` skips it when deriving
		// `.git` but still emits a writable entry for it, and an entry at `""`
		// matches every absolute path on the way through `isWithin` — so it has to
		// be dropped here, not left to a comparison further down.
		if (path === "") continue;
		const key = path.replace(/\\/g, "/");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(root);
	}
	return out;
}

// Long-form design notes: docs/dev/sandbox.md
/** The `/permissions` line, built from the same function that builds the roots. */
export function describeWritableRoots(options: WritableRootOptions): string {
	const roots = resolveWritableRoots(options);
	// The same predicate `resolveWritableRoots` branches on, not `!== undefined`:
	// the schema hands every unconfigured user an empty array, and a line that
	// said "from permissions.additionalDirectories" on a machine where the user
	// has never written one would be a lie in the direction that costs them the
	// most — it would read as "you configured this and I am showing you what you
	// configured", for a list they never touched.
	const configured = options.configured !== undefined && dedupe(options.configured.map(projectRoot)).length > 0;
	const source = configured
		? "permissions.additionalDirectories"
		: "default: the temp directory and this user's package caches";
	if (roots.length === 0) {
		return `Writable outside the workspace: none — every write goes to the workspace (${source}).`;
	}
	return `Writable outside the workspace (${roots.length}, ${source}): ${roots
		.map((root) => (typeof root === "string" ? root : root.path))
		.join(", ")}`;
}
