/**
 * The directories a confined command may write to outside the workspace.
 *
 * ## Why this file exists
 *
 * `workspace-write` meant, until this was measured, "the workspace is the only
 * writable path". Every ordinary command breaks there: `mktemp` cannot create
 * its directory, `npm install` cannot write `~/.npm/_cacache`, `bun install`
 * cannot write `~/.bun/install/cache`. The policy was doing exactly what it was
 * told — the tools simply never named a second root — so this is a usability
 * defect and not a hole, and the fix belongs at the call site
 * (`bash.ts`), not in the translators that were faithfully emitting what they
 * were given.
 *
 * ## The three roots, and why exactly these three
 *
 *   `os.tmpdir()`  `$TMPDIR` when it is set, the platform's own answer
 *                  otherwise. Every tool that stages a file needs it, and on
 *                  Linux it is `/tmp` — a directory every process on the
 *                  machine already writes to, and one whose contents are
 *                  discarded. Uncontroversial.
 *
 *   `~/.npm`       npm's own directory: `_cacache`, `_logs`, `_npx`. Without it
 *                  `npm install` fails, which is the other half of the reported
 *                  symptom. It belongs to one tool, so granting it grants that
 *                  tool's data and nothing else.
 *
 *   `~/.bun`       the same for this repository's own package manager
 *                  (`~/.bun/install/cache`). This is a Bun monorepo and
 *                  `bun install` is on its documented path.
 *
 * **`~/.cache` is deliberately not among them.** It is the XDG *cache home* —
 * the shared parent of `~/.cache/pip`, `~/.cache/yarn`, `~/.cache/uv` and every
 * other tool on the machine — not one tool's directory. Granting a directory
 * because some tool might use it is a different and larger decision than
 * granting the two directories this project's own install path needs, and there
 * is nothing in this repository that reads an XDG cache. A user on yarn or pnpm
 * adds `~/.cache/yarn` (or `~/.local/share/pnpm/store`) through
 * `permissions.additionalDirectories`, which is one settings line; the cost of
 * guessing wrong in the other direction is the same one line.
 *
 * ## `home` is a parameter and there is no default
 *
 * **Nothing here calls `os.homedir()`.** That is the repo's standing rule, and
 * it is not stylistic: `os.homedir()` resolves through the Win32 environment
 * block, so a test that pointed the process at a fixture home read the
 * developer's real one instead, and CI read a developer's real config. Every
 * reader in this repository takes `home` as an argument precisely so a test can
 * hand it a fixture.
 *
 * So when no home is supplied the per-user roots are simply **absent**, rather
 * than resolved from the process. That is the narrow reading, and it is the
 * right one for an embedder that did not tell us which home it is serving: it
 * gets the temp directory and nothing it did not name.
 *
 * ## Configured roots replace the defaults; they do not extend them
 *
 * A **non-empty** `permissions.additionalDirectories` *is* the list. Empty or
 * absent means the defaults apply. The merging alternative was rejected for a
 * reason that is not about taste: a merge has no way to drop a default, and
 * there is a good reason to want one.
 *
 * **An empty list cannot mean "nothing is writable", and that is a measurement
 * rather than a preference.** `SettingsSchema` declares `additionalDirectories`
 * with `.default([])`, so by the time the merged settings reach here it is `[]`
 * for *every* user who has never touched the key — verified:
 * `SettingsSchema.parse({}).permissions.additionalDirectories` is `[]`. And
 * `migrate.ts` writes `"additionalDirectories": []` into the settings file it
 * produces. So "present and empty" describes the ordinary, unconfigured
 * machine, not a user asking for a narrower sandbox. Reading it as "nothing may
 * be written outside the workspace" would have left every default install
 * exactly where it was — the fix would have been a no-op for the people it was
 * written for — and it would have done so silently.
 *
 * The cost is that there is no setting which turns the temp directory off. That
 * is accepted: `/tmp` being writable under `workspace-write` is what every other
 * tool on the machine already assumes, and the user who wants no confinement at
 * all has `danger-full-access`.
 */
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
	/**
	 * `permissions.additionalDirectories`, verbatim.
	 *
	 * Non-empty **replaces** the defaults; empty or absent means "use the
	 * defaults". The schema's `.default([])` is why empty cannot mean anything
	 * else — see the file header.
	 */
	configured?: readonly string[];
}

/** The per-user package caches this build grants, relative to a supplied home. */
const PACKAGE_CACHE_DIRS = [".npm", ".bun"] as const;

/**
 * The writable roots a confined Bash command gets, in the order they are handed
 * to the policy builder.
 *
 * Deduplicated on the `/`-spelled form, because `buildSandboxPolicy` emits one
 * bind per entry and a user who lists the temp directory that is already there
 * should not get two of them. Case is **not** folded: `C:\Temp` and `c:\temp`
 * are one directory on Windows and two on Linux, and this module has no
 * filesystem to ask — so a case-variant duplicate survives, which costs a
 * redundant `--bind` rather than anything worse. The consumers that do fold case
 * against the real filesystem are `decideWrite` and `guardWritablePath`.
 */
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

/**
 * A directory the user named in `permissions.additionalDirectories`.
 *
 * Labelled `project`, which is the conservative reading and the reason the label
 * is worth anything: the user is declaring a place the agent works, and a
 * sibling checkout named there should have its `.git` protected exactly as the
 * workspace's own is. If the directory turns out to be a cache instead, the cost
 * is a protected path at a path that holds no repository — read-only, unused,
 * and harmless.
 *
 * The alternative — labelling a hand-named root `data` because the app cannot
 * know what it is — trades that harmless read-only mount for a real hole: a
 * sibling worktree a user added by hand would lose the protection the workspace
 * gets for free, and would lose it silently.
 */
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

/**
 * The `/permissions` line, built from the same function that builds the roots —
 * so the screen and the policy cannot disagree about which roots are in force.
 *
 * Says where the list came from, because "a directory is writable" is a question
 * a user cannot answer from a path alone: `["/srv/deploy"]` reads differently
 * when it came from `permissions.additionalDirectories` than when it is one of
 * three defaults the build chose.
 */
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
