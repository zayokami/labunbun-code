/**
 * Memory-file loading (LABUNBUN.md / AGENTS.md).
 *
 * Load order (later = higher priority, matching the reference design):
 *   1. user memory: ~/.labunbun/MEMORY.md, then ~/.labunbun/rules/*.md
 *   2. project walk, rendered root → cwd (nearest last): at each level
 *      LABUNBUN.md if present else AGENTS.md (nearest wins per level), plus
 *      .labunbun/rules/*.md
 *   3. `@path` includes expanded recursively with cycle guarding
 *
 * The 40k character budget is spent in priority order rather than render
 * order: the user tier first and in its own order, then project files from
 * cwd outward. An oversized guide in an ancestor therefore cannot evict the
 * guide for the directory the session is working in. The rendered order stays
 * root → cwd, so the nearest file is still the last text before the
 * conversation. A file that does not fit contributes the prefix it can and
 * every farther file is left out. The final string — separators and a
 * completeness note included — is never longer than 40k. That note names the
 * partial and omitted files. It is a source description, not a request to read
 * them: Read can reach neither home nor ancestors.
 *
 * The project walk is one tier behind the trust gate (`project-trust.ts`,
 * kind "memory"): every memory file that reaches the prompt is read as if the
 * user had written it, so a file a repository ships is loaded only after this
 * directory has been trusted once. The gate covers the whole walk — ancestors
 * included — because the decision is about this checkout, not one level of it.
 * The user tier is not gated: it is the user's own, read from the same home
 * whatever the cwd.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isProjectTierTrusted } from "./project-trust.ts";

/** The user's own memory file, `<home>/.labunbun/MEMORY.md`. */
export function userMemoryPath(home: string): string {
	return join(home, ".labunbun", "MEMORY.md");
}

/** The user's own rules directory, `<home>/.labunbun/rules`. */
export function userRulesDir(home: string): string {
	return join(home, ".labunbun", "rules");
}

const MAX_TOTAL_CHARS = 40_000;
const MAX_INCLUDE_DEPTH = 5;
/** How many paths a completeness note may name, across both lists. */
const MAX_NOTICE_PATHS = 8;
/** A displayed path is capped so one pathological name cannot crowd out the note. */
const MAX_NOTICE_PATH_CHARS = 80;
const PART_SEPARATOR = "\n\n---\n\n";

export interface MemoryLoadResult {
	content: string;
	/** Files that contributed, nearest-last. */
	files: string[];
	truncated: boolean;
	/** Files whose beginning only is in `content`, in render order. */
	partialFiles?: string[];
	/** Files left out entirely, in render order. */
	omittedFiles?: string[];
}

/** One memory file with its `@include`s already expanded. */
export interface MemoryFileCandidate {
	path: string;
	content: string;
}

export interface MemorySelectionPart extends MemoryFileCandidate {
	/** True when only the beginning of the file fit. */
	partial: boolean;
}

export interface MemorySelection {
	/** Parts that fit, in priority order. */
	parts: MemorySelectionPart[];
	/** Paths left out entirely, in priority order. */
	omitted: string[];
	/** Length of `parts` joined by the separator. */
	length: number;
}

function readIfExists(path: string): string | null {
	try {
		// `lstat` describes the name, not what it points at: a memory file
		// swapped for a symlink would otherwise turn `@include`, a rules file or
		// LABUNBUN.md into a way to pull an arbitrary file into the system
		// prompt. Only a regular file of our own is readable here; a link, a
		// directory or a device is "nothing to read", the same answer as absent.
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile()) return null;
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

/** cwd → filesystem root, root first, so nearest wins by later append. */
function levelsFromCwd(cwd: string): string[] {
	const levels: string[] = [];
	let current = resolve(cwd);
	while (true) {
		levels.unshift(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return levels;
}

/**
 * Take the prefix of `content` that fits in `available` characters without
 * splitting a surrogate pair.
 */
function prefixThatFits(content: string, available: number): string {
	let end = Math.min(available, content.length);
	if (end > 0 && end < content.length) {
		const code = content.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	return content.slice(0, end);
}

/**
 * Spend `budget` over `files` in the order given (highest priority first) and
 * report what fits. The returned `length` counts the separators the rendered
 * text will carry, so `length <= budget` for a non-negative budget.
 *
 * A file that does not fit contributes the prefix it can and stops the walk:
 * a nearer file is never dropped in favour of a farther one, and once a file
 * is partial every remaining file is omitted. A full separator with no room
 * for content is not a partial file — the next file is omitted instead.
 */
export function selectMemoryContent(files: readonly MemoryFileCandidate[], budget: number): MemorySelection {
	const parts: MemorySelectionPart[] = [];
	const omitted: string[] = [];
	let length = 0;
	let stopped = false;

	for (const file of files) {
		if (stopped) {
			omitted.push(file.path);
			continue;
		}
		const separatorLength = parts.length === 0 ? 0 : PART_SEPARATOR.length;
		const available = budget - length - separatorLength;
		if (available <= 0) {
			stopped = true;
			omitted.push(file.path);
			continue;
		}
		if (file.content.length <= available) {
			parts.push({ path: file.path, content: file.content, partial: false });
			length += separatorLength + file.content.length;
			continue;
		}
		const prefix = prefixThatFits(file.content, available);
		if (prefix.length === 0) {
			stopped = true;
			omitted.push(file.path);
			continue;
		}
		parts.push({ path: file.path, content: prefix, partial: true });
		length += separatorLength + prefix.length;
		stopped = true;
	}

	return { parts, omitted, length };
}

/**
 * How one memory path is named in the completeness note: relative to cwd for a
 * file inside it, `~/...` inside home, and the bare name otherwise. Located
 * before cwd is located before home so a project file in a checkout under the
 * home directory stays short.
 */
function displayMemoryPath(path: string, cwd: string, home: string): string {
	const slashed = (value: string): string => value.replace(/\\/g, "/");
	let shown: string;
	if (isWithinRoot(path, cwd)) {
		const rel = relative(cwd, path);
		shown = rel ? slashed(rel) : basename(path);
	} else if (isWithinRoot(path, home)) {
		const rel = relative(home, path);
		shown = rel ? `~/${slashed(rel)}` : "~";
	} else {
		shown = basename(path);
	}
	return sanitizeNoticePath(shown);
}

/**
 * Make a path safe to embed in one line of prompt text. Newlines and control
 * characters become spaces, bidi/zero-width controls disappear, and brackets
 * are rewritten so a file name cannot imitate the note's own delimiters.
 */
function sanitizeNoticePath(path: string): string {
	const cleaned = path
		// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the purpose of this line
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
		.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/\[/g, "(")
		.replace(/\]/g, ")")
		.replace(/\s+/g, " ")
		.trim();
	const capped = cleaned.length > MAX_NOTICE_PATH_CHARS ? `${cleaned.slice(0, MAX_NOTICE_PATH_CHARS - 3)}...` : cleaned;
	return capped || "?";
}

/** Join a bounded path list, folding the rest into an `and N more` tail. */
function noticePathList(paths: string[], more: number): string {
	if (paths.length === 0) return `and ${more} more`;
	const joined = paths.join(", ");
	return more > 0 ? `${joined} and ${more} more` : joined;
}

/**
 * The source-completeness note appended after the loaded memory. It describes
 * what is present and what is not; it never asks the model to read the named
 * files (the Read tool is confined to the workspace, so most of these paths
 * are unreachable from it anyway).
 */
export function buildTruncationNotice(partial: string[], omitted: string[], cwd: string, home: string): string {
	if (partial.length === 0 && omitted.length === 0) return "";
	const partialShown = partial.slice(0, MAX_NOTICE_PATHS).map((path) => displayMemoryPath(path, cwd, home));
	const omittedShown = omitted
		.slice(0, Math.max(0, MAX_NOTICE_PATHS - partialShown.length))
		.map((path) => displayMemoryPath(path, cwd, home));
	const more = partial.length - partialShown.length + (omitted.length - omittedShown.length);
	const clauses = ["memory context: source completeness note", "the 40000-character limit was reached"];
	if (partialShown.length > 0)
		clauses.push(`partial (start only): ${noticePathList(partialShown, omittedShown.length === 0 ? more : 0)}`);
	if (omittedShown.length > 0) clauses.push(`not loaded: ${noticePathList(omittedShown, more)}`);
	return `[${clauses.join("; ")}. This note records what was omitted from the context; it is not an instruction to read those files.]`;
}

/** Expand one file's `@include`s. */
function expandCandidate(file: MemoryFileCandidate): MemoryFileCandidate {
	return { path: file.path, content: expandIncludes(file.content, dirname(file.path), new Set([file.path])) };
}

export function loadMemoryFiles(cwd: string, home = homedir()): MemoryLoadResult {
	// 1. User-global memory, plus user-global rules. The cwd→root walk below
	// only reaches `~/.labunbun/rules` when cwd happens to sit under the home
	// directory, so user-scope rules need their own read to apply everywhere.
	const userFiles: MemoryFileCandidate[] = [];
	const userMemory = readIfExists(userMemoryPath(home));
	if (userMemory !== null) userFiles.push({ path: userMemoryPath(home), content: userMemory });
	userFiles.push(...collectRules(userRulesDir(home)));

	// 2. Walk cwd → root; root-level files first so the render keeps the nearest
	// last. The walk is behind the trust gate as a whole (see the header): an
	// untrusted checkout contributes nothing from any level, while the user tier
	// above stays.
	const projectLevels: MemoryFileCandidate[][] = [];
	if (isProjectTierTrusted(cwd, "memory", home)) {
		for (const dir of levelsFromCwd(cwd)) projectLevels.push(collectLevel(dir));
	}

	// Deduped by path with the user tier first: when cwd sits under the home
	// directory the walk revisits `~/.labunbun/rules`, which step 1 already read.
	const seenPaths = new Set<string>();
	const dedupe = (file: MemoryFileCandidate): boolean => {
		if (seenPaths.has(file.path)) return false;
		seenPaths.add(file.path);
		return true;
	};
	const userCandidates = userFiles.filter(dedupe).map(expandCandidate);
	const projectCandidatesByLevel = projectLevels.map((level) => level.filter(dedupe).map(expandCandidate));

	// Selection order is priority order: user tier as loaded, then project
	// files nearest-first. Render order stays user tier, then root → cwd.
	const priorityOrder: MemoryFileCandidate[] = [...userCandidates];
	for (let level = projectCandidatesByLevel.length - 1; level >= 0; level--) {
		const files = projectCandidatesByLevel[level];
		if (files) priorityOrder.push(...files);
	}
	const renderOrder: MemoryFileCandidate[] = [...userCandidates, ...projectCandidatesByLevel.flat()];

	// The note lives inside the cap, and its size depends on which files the
	// budget dropped. Shrink the content budget by the overflow and reselect
	// until the whole string fits; the note is bounded, so this converges.
	let budget = MAX_TOTAL_CHARS;
	let rendered: MemorySelectionPart[] = [];
	let omittedRender: string[] = [];
	let partialRender: string[] = [];
	let content = "";
	let notice = "";
	for (let attempt = 0; attempt < 16; attempt++) {
		const selection = selectMemoryContent(priorityOrder, Math.max(0, budget));
		const selected = new Map(selection.parts.map((part) => [part.path, part]));
		rendered = renderOrder.flatMap((file) => {
			const part = selected.get(file.path);
			return part ? [part] : [];
		});
		const omittedPaths = new Set(selection.omitted);
		omittedRender = renderOrder.flatMap((file) => (omittedPaths.has(file.path) ? [file.path] : []));
		partialRender = rendered.filter((part) => part.partial).map((part) => part.path);
		content = rendered.map((part) => part.content).join(PART_SEPARATOR);
		notice = buildTruncationNotice(partialRender, omittedRender, cwd, home);
		const total = content.length + (notice ? PART_SEPARATOR.length + notice.length : 0);
		if (total <= MAX_TOTAL_CHARS) break;
		const next = Math.max(0, budget - (total - MAX_TOTAL_CHARS));
		if (next === budget) break;
		budget = next;
	}
	if (notice) content = `${content}${PART_SEPARATOR}${notice}`;
	// The loop above converges with a bounded note. This clamp is a last
	// resort: the hard cap is the invariant that must survive even a bug here.
	if (content.length > MAX_TOTAL_CHARS) content = content.slice(0, MAX_TOTAL_CHARS);
	const truncated = partialRender.length > 0 || omittedRender.length > 0;
	return {
		content,
		files: rendered.map((part) => part.path),
		truncated,
		partialFiles: partialRender,
		omittedFiles: omittedRender,
	};
}

/**
 * The project-tier files the trust gate is holding back, for the startup notice
 * and `/agents` to name — the un-gated reading of the very walk
 * `loadMemoryFiles` skips.
 *
 * The user tier is subtracted because it still loads: when cwd sits under the
 * home directory the walk would revisit `~/.labunbun/rules`, which step 1 reads
 * from anywhere, and counting it as withheld would put a file that is in the
 * prompt on the list of files that are not.
 */
export function withheldProjectMemoryFiles(cwd: string, home: string = homedir()): string[] {
	if (isProjectTierTrusted(cwd, "memory", home)) return [];
	const userTier = new Set<string>([
		userMemoryPath(home),
		...collectRules(userRulesDir(home)).map((file) => file.path),
	]);
	return levelsFromCwd(cwd)
		.flatMap((dir) => collectLevel(dir))
		.map((file) => file.path)
		.filter((path) => !userTier.has(path));
}
