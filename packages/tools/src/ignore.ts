// The `.gitignore` subset the file walker honours.
// Long-form design notes: docs/dev/tools.md

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
