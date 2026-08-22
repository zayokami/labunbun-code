/**
 * Memory-file loading (LABUNBUN.md / AGENTS.md).
 *
 * Load order (later = higher priority, matching the reference design):
 *   1. user memory: ~/.labunbun/MEMORY.md
 *   2. project walk: cwd → filesystem root; at each level LABUNBUN.md if
 *      present else AGENTS.md (nearest wins per level), plus .labunbun/rules/*.md
 *   3. `@path` includes expanded recursively with cycle guarding
 * Total cap 40k chars — truncated with a notice.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_TOTAL_CHARS = 40_000;
const MAX_INCLUDE_DEPTH = 5;

export interface MemoryLoadResult {
	content: string;
	/** Files that contributed, nearest-last. */
	files: string[];
	truncated: boolean;
}

function readIfExists(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		if (!statSync(path).isFile()) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Normalize for cross-platform, case-insensitive path comparison. */
function normalizeForCompare(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}

/** Is `target` equal to or nested inside `root`? Both must already be resolved/absolute. */
function isWithinRoot(target: string, root: string): boolean {
	const normalizedTarget = normalizeForCompare(target);
	const normalizedRoot = normalizeForCompare(root).replace(/\/$/, "");
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

/**
 * Expand `@path/to/file` includes recursively (cycle-guarded).
 *
 * `root` pins the containment boundary to the directory of the file that
 * originally referenced an include (defaults to `baseDir` on the initial
 * call, then threaded unchanged through recursion) — an untrusted
 * AGENTS.md/LABUNBUN.md pulled in from a cloned repo can't use `@../../../
 * etc/passwd` or a `\\host\share` UNC path to read or trigger network
 * access outside its own directory tree.
 */
export function expandIncludes(
	content: string,
	baseDir: string,
	seen: Set<string> = new Set(),
	root: string = baseDir,
): string {
	const resolvedRoot = resolve(root);
	return content.replace(/^@([\w./\\-]+)\s*$/gm, (_match, rawPath: string) => {
		const includePath = resolve(baseDir, rawPath);
		if (!isWithinRoot(includePath, resolvedRoot)) return `[include outside allowed directory: ${rawPath}]`;
		if (seen.has(includePath)) return `[circular include: ${rawPath}]`;
		if (seen.size > MAX_INCLUDE_DEPTH * 10) return "[include depth exceeded]";
		const text = readIfExists(includePath);
		if (text === null) return `[include not found: ${rawPath}]`;
		seen.add(includePath);
		return expandIncludes(text, dirname(includePath), seen, resolvedRoot);
	});
}

/** Read every `*.md` in a rules directory, sorted, skipping an unreadable dir. */
function collectRules(rulesDir: string): Array<{ path: string; content: string }> {
	const out: Array<{ path: string; content: string }> = [];
	try {
		if (existsSync(rulesDir)) {
			for (const name of readdirSync(rulesDir).sort()) {
				if (!name.endsWith(".md")) continue;
				const content = readIfExists(join(rulesDir, name));
				if (content !== null) out.push({ path: join(rulesDir, name), content });
			}
		}
	} catch {
		// unreadable rules dir — skip
	}
	return out;
}

/** Collect memory files for one directory level: LABUNBUN.md else AGENTS.md + rules/. */
function collectLevel(dir: string): Array<{ path: string; content: string }> {
	const out: Array<{ path: string; content: string }> = [];
	const labunbunPath = join(dir, "LABUNBUN.md");
	const agentsPath = join(dir, "AGENTS.md");
	const mainContent = readIfExists(labunbunPath);
	if (mainContent !== null) {
		out.push({ path: labunbunPath, content: mainContent });
	} else {
		const agentsContent = readIfExists(agentsPath);
		if (agentsContent !== null) out.push({ path: agentsPath, content: agentsContent });
	}

	out.push(...collectRules(join(dir, ".labunbun", "rules")));
	return out;
}

export function loadMemoryFiles(cwd: string, home = homedir()): MemoryLoadResult {
	const files: Array<{ path: string; content: string }> = [];

	// 1. User-global memory, plus user-global rules. The cwd→root walk below
	// only reaches `~/.labunbun/rules` when cwd happens to sit under the home
	// directory, so user-scope rules need their own read to apply everywhere.
	const userMemory = readIfExists(join(home, ".labunbun", "MEMORY.md"));
	if (userMemory !== null) files.push({ path: join(home, ".labunbun", "MEMORY.md"), content: userMemory });
	files.push(...collectRules(join(home, ".labunbun", "rules")));

	// 2. Walk cwd → root; root-level files first so nearest wins by later append.
	const start = resolve(cwd);
	let current = start;
	const levels: string[] = [];
	while (true) {
		levels.unshift(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const dir of levels) {
		files.push(...collectLevel(dir));
	}

	// 3. Expand includes and join. Deduped by path: when cwd sits under the home
	// directory the walk revisits `~/.labunbun/rules`, which step 1 already read.
	const parts: string[] = [];
	const contributing: string[] = [];
	const seenPaths = new Set<string>();
	let total = 0;
	let truncated = false;

	for (const file of files) {
		if (seenPaths.has(file.path)) continue;
		seenPaths.add(file.path);
		const expanded = expandIncludes(file.content, dirname(file.path), new Set([file.path]));
		contributing.push(file.path);
		parts.push(expanded);
		total += expanded.length;
		if (total > MAX_TOTAL_CHARS) {
			truncated = true;
			break;
		}
	}

	let content = parts.join("\n\n---\n\n");
	if (truncated) {
		content = `${content.slice(0, MAX_TOTAL_CHARS)}\n\n[memory files truncated at ${MAX_TOTAL_CHARS} chars]`;
	}
	return { content, files: contributing, truncated };
}

/** Empty-result helper for tests and callers without memory files. */
export function emptyMemory(): MemoryLoadResult {
	return { content: "", files: [], truncated: false };
}
