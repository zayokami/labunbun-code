/**
 * The `.gitignore` subset the file walker honours.
 *
 * The tree a developer searches is the tree git tracks. A file git will not
 * show in `git status` is a file a search result should not be quoting, and
 * the project already said which files those are — in the file it wrote for
 * exactly that purpose. Searching past a `.gitignore` means Grep and Glob
 * report matches from build output and logs that the developer cannot see,
 * which is worse than a miss: it reads as real.
 *
 * The subset is exactly this, and the Grep description says the same words:
 *
 * - blank lines and lines starting with `#` are skipped;
 * - `!` re-includes what an earlier rule excluded (last matching rule wins);
 * - a trailing `/` restricts a rule to directories;
 * - a pattern containing a slash anywhere is anchored to the directory its
 *   `.gitignore` lives in and matched against the path from there;
 * - a pattern with no slash is matched against the name, at any depth;
 * - a directory that is excluded is never re-included from inside it — git's
 *   own rule ("It is not possible to re-include a file if a parent directory
 *   of that file is excluded"), and the reason the walker may prune a matched
 *   directory instead of descending to test each descendant.
 *
 * Deliberately not here, none of it claimed in the description: `.git/info/
 * exclude`, the global `core.excludesFile`, escaped trailing spaces, and
 * `**` semantics — `Bun.Glob` reads `**` its own way, and the walker does not
 * re-interpret it. Matching is case-sensitive everywhere, because the skip
 * list next door is and a guess about the filesystem's case behaviour is one
 * more thing to be wrong about.
 *
 * Nested `.gitignore` files are read, and a deeper one is evaluated after the
 * ones above it, so it overrides them — git's precedence, expressed as the
 * fold in {@link isIgnored}.
 */

/** One `.gitignore` file, parsed. */
export interface IgnoreSet {
	/** Absolute directory the patterns are relative to, forward slashes. */
	base: string;
	rules: IgnoreRule[];
}

interface IgnoreRule {
	/** `!`: matching this rule un-ignores. */
	negated: boolean;
	/** Trailing `/`: the rule applies to directories only. */
	dirOnly: boolean;
	/** The pattern contains a slash: matched from {@link IgnoreSet.base}, else against the name. */
	pathType: boolean;
	pattern: string;
	/** Lazy `Bun.Glob` for the pattern; parsing does not compile, matching does once. */
	compiled?: Bun.Glob;
}

/** Parse one `.gitignore`'s text. Lines that would match nothing are dropped. */
export function parseGitignore(text: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const raw of text.split("\n")) {
		// A CRLF `.gitignore` is the normal case on Windows; the `\r` is not
		// part of any pattern.
		const line = raw.replace(/\r$/, "");
		if (line.length === 0 || line.startsWith("#")) continue;
		let body = line;
		let negated = false;
		if (body.startsWith("!")) {
			negated = true;
			body = body.slice(1);
		}
		let dirOnly = false;
		if (body.endsWith("/")) {
			dirOnly = true;
			body = body.slice(0, -1);
		}
		let pathType = false;
		if (body.startsWith("/")) {
			pathType = true;
			body = body.slice(1);
		} else if (body.includes("/")) {
			pathType = true;
		}
		// A lone `!`, a lone `/`, `!/` — nothing left to match with. Git would
		// treat these as matching nothing, and so does dropping them.
		if (body.length === 0) continue;
		rules.push({ negated, dirOnly, pathType, pattern: body });
	}
	return rules;
}

/**
 * Is `path` ignored, judged by the chain of `.gitignore` sets that apply to
 * it (root first, deeper later)? The verdict is the last matching rule's, so a
 * deeper file's rule overrides a shallower one exactly when git says it does.
 */
export function isIgnored(chain: readonly IgnoreSet[], path: string, isDir: boolean): boolean {
	const forward = path.split("\\").join("/");
	let verdict = false;
	for (const set of chain) {
		const rel = forward.startsWith(`${set.base}/`) ? forward.slice(set.base.length + 1) : null;
		if (rel === null || rel.length === 0) continue; // not under this set's directory
		const name = rel.slice(rel.lastIndexOf("/") + 1);
		for (const rule of set.rules) {
			if (rule.dirOnly && !isDir) continue;
			if (globFor(rule).match(rule.pathType ? rel : name)) verdict = !rule.negated;
		}
	}
	return verdict;
}

function globFor(rule: IgnoreRule): Bun.Glob {
	let glob = rule.compiled;
	if (!glob) {
		glob = new Bun.Glob(rule.pattern);
		rule.compiled = glob;
	}
	return glob;
}
