// P1 tags: what a file declares and what it calls. Aider's repository map
// builds a file-level graph from exactly these two facts — a definition names a
// symbol, a reference says another file needed it — and ranks the graph with
// PageRank. The extraction here follows Aider's tags queries so the two
// implementations can be compared on Aider's own fixture. The per-grammar node
// vocabulary lives in `repomap-languages.ts`.
//
// Long-form design notes: docs/dev/repomap.md (P1).
import { relative } from "node:path";
import { Parser, type Node as SyntaxNode, type Tree } from "web-tree-sitter";
import {
	InMemoryRepoMapCache,
	loadRepoMapLanguage,
	type RepoMapCache,
	type RepoMapOps,
	type RepoMapOptions,
	type RepoMapScanStats,
	scanRepoFiles,
} from "./repomap.ts";
import {
	REPO_MAP_TAG_RULES,
	type RepoMapLanguage,
	type RepoMapTagDefinitionKind,
	repoMapLanguageFor,
} from "./repomap-languages.ts";

export type { RepoMapTagDefinitionKind };

/** One line of a definition's body, already trimmed and bounded in length. */
export interface RepoMapSnippetLine {
	/** One-based line number in the source file. */
	line: number;
	text: string;
}

export interface RepoMapTag {
	/** Path relative to the map root, forward slashes. */
	path: string;
	name: string;
	kind: "def" | "ref";
	/** One-based line the tag occurs on. */
	line: number;
	definitionKind?: RepoMapTagDefinitionKind;
	/** For definitions: the declaration and a bounded amount of its body. */
	snippet?: RepoMapSnippetLine[];
}

export interface RepoMapFileTags {
	path: string;
	tags: RepoMapTag[];
	/** Source lines, excluding the empty line a trailing newline produces. */
	lineCount: number;
}

export interface RepoMapTagsOptions extends RepoMapOptions<RepoMapFileTags> {
	/** Lines of a function or method kept in its snippet. Default: 12. */
	maxSnippetLines?: number;
}

export interface RepoMapTagsStats extends RepoMapScanStats {
	definitions: number;
	references: number;
}

export interface RepoMapTagsResult {
	files: RepoMapFileTags[];
	stats: RepoMapTagsStats;
}

const DEFAULT_MAX_SNIPPET_LINES = 12;

/** Aider's map truncates every rendered source line at 100 characters. */
export const MAX_SNIPPET_LINE_CHARS = 100;

/** Types whose body is summarized by their members rather than repeated. */
const HEADER_ONLY_KINDS = new Set<RepoMapTagDefinitionKind>(["class", "interface", "type", "enum"]);

const CLOSING_ONLY = /^\s*[})\];,]+\s*$/;

/**
 * A definition's declaration plus a bounded amount of its body. Classes and
 * interfaces contribute only their header because their members are separate
 * tags; functions and methods contribute their body up to `maxLines`. The
 * function's own closing brace is left out, matching the shape Aider renders:
 * a line that is nothing but delimiters says less than the line above it.
 */
function makeSnippet(
	node: SyntaxNode,
	lines: readonly string[],
	kind: RepoMapTagDefinitionKind,
	maxLines: number,
): RepoMapSnippetLine[] {
	const start = node.startPosition.row;
	let end = HEADER_ONLY_KINDS.has(kind) ? start : node.endPosition.row;
	if (end > start && CLOSING_ONLY.test(lines[end] ?? "")) end--;
	const snippet: RepoMapSnippetLine[] = [];
	for (let row = start; row <= end && snippet.length < maxLines; row++) {
		const text = (lines[row] ?? "").replace(/\s+$/, "");
		if (text === "") continue;
		snippet.push({ line: row + 1, text: text.slice(0, MAX_SNIPPET_LINE_CHARS) });
	}
	return snippet;
}

/**
 * Extract every definition and call reference in a parsed file.
 *
 * Unlike `extractDefinitions` in `repomap.ts`, this descends into class bodies
 * and nested scopes: Aider's query matches declarations wherever they occur,
 * and a method is a useful definition even though it is reachable through its
 * class. Definitions carry a snippet; references carry only a name and a line.
 *
 * The grammar comes from `options.language`, or from the path's extension when
 * it is omitted.
 */
export function extractTags(
	tree: Tree,
	source: string,
	path: string,
	options: { maxSnippetLines?: number; language?: RepoMapLanguage } = {},
): RepoMapFileTags {
	const lines = source.split(/\r?\n/);
	const maxSnippetLines = options.maxSnippetLines ?? DEFAULT_MAX_SNIPPET_LINES;
	const rules = REPO_MAP_TAG_RULES[options.language ?? repoMapLanguageFor(path) ?? "typescript"];
	const tags: RepoMapTag[] = [];
	const stack: SyntaxNode[] = [];
	const root = tree.rootNode;
	for (let index = root.namedChildCount - 1; index >= 0; index--) {
		const child = root.namedChild(index);
		if (child) stack.push(child);
	}
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		const definition = rules.definition(node);
		if (definition) {
			tags.push({
				path,
				name: definition.name,
				kind: "def",
				line: node.startPosition.row + 1,
				definitionKind: definition.kind,
				snippet: makeSnippet(node, lines, definition.kind, maxSnippetLines),
			});
		}
		const reference = rules.reference(node);
		if (reference) tags.push({ path, name: reference, kind: "ref", line: node.startPosition.row + 1 });
		for (let index = node.namedChildCount - 1; index >= 0; index--) {
			const child = node.namedChild(index);
			if (child) stack.push(child);
		}
	}
	tags.sort((a, b) => {
		if (a.line !== b.line) return a.line - b.line;
		if (a.kind !== b.kind) return a.kind === "def" ? -1 : 1;
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
	// A trailing newline produces one empty entry that is not a source line.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return { path, tags, lineCount: lines.length };
}

/** Parse and extract in one call. Convenient for tests and one-off files. */
export async function tagsInSource(
	source: string,
	language: RepoMapLanguage,
	options: { maxSnippetLines?: number; path?: string } = {},
): Promise<RepoMapFileTags> {
	const grammar = await loadRepoMapLanguage(language);
	const parser = new Parser();
	try {
		parser.setLanguage(grammar);
		const tree = parser.parse(source);
		if (!tree) return { path: options.path ?? "", tags: [], lineCount: 0 };
		try {
			return extractTags(tree, source, options.path ?? "", { ...options, language });
		} finally {
			tree.delete();
		}
	} finally {
		parser.delete();
	}
}

/** A tag as stored: the file path is the row's key, so repeating it is dead weight. */
type CompactRepoMapTag = Omit<RepoMapTag, "path">;

interface CompactRepoMapFileTags {
	tags: CompactRepoMapTag[];
	lineCount: number;
}

/**
 * Store a file's path once, as the cache key, instead of once per tag. A tag
 * row is dominated by its path and a call-heavy file has hundreds of them, so
 * dropping the repeated field takes roughly a quarter off the persisted cache.
 * `get` restores the path from the key, which keeps the payload the same shape
 * the rest of the pipeline sees.
 */
function compactTagsCache(cache: RepoMapCache<RepoMapFileTags>, root: string): RepoMapCache<RepoMapFileTags> {
	const inner = cache as RepoMapCache<unknown>;
	const relativePath = (full: string) => relative(root, full).split("\\").join("/");
	const compact: RepoMapCache<RepoMapFileTags> = {
		get(full, mtimeMs, size) {
			const stored = inner.get(full, mtimeMs, size) as RepoMapFileTags | CompactRepoMapFileTags | undefined;
			// A definitions payload (or a corrupted row) is not this cache's shape;
			// treating it as a miss lets the scan overwrite it.
			if (!stored || !Array.isArray(stored.tags)) return undefined;
			const path = relativePath(full);
			// A row written before the payload was compacted carries its own path.
			// The key-derived path wins so both shapes read back the same.
			return { path, lineCount: stored.lineCount, tags: stored.tags.map((tag) => ({ ...tag, path })) };
		},
		set(full, mtimeMs, size, data) {
			inner.set(full, mtimeMs, size, {
				lineCount: data.lineCount,
				tags: data.tags.map(({ path: _path, ...tag }) => tag),
			});
		},
	};
	if (cache.flush) compact.flush = () => cache.flush?.();
	return compact;
}

/** Walk `root` and extract tags, using `cache` to skip unchanged files. */
export async function buildRepoMapTags(
	root: string,
	ops: RepoMapOps,
	options: RepoMapTagsOptions = {},
): Promise<RepoMapTagsResult> {
	const cache: RepoMapCache<RepoMapFileTags> = options.cache ?? new InMemoryRepoMapCache<RepoMapFileTags>();
	const maxSnippetLines = options.maxSnippetLines ?? DEFAULT_MAX_SNIPPET_LINES;
	const scan = await scanRepoFiles(root, ops, options, compactTagsCache(cache, root), (tree, source, language, path) =>
		extractTags(tree, source, path, { maxSnippetLines, language }),
	);
	let definitions = 0;
	let references = 0;
	for (const file of scan.files) {
		for (const tag of file.data.tags) {
			if (tag.kind === "def") definitions++;
			else references++;
		}
	}
	return {
		files: scan.files.map(({ path, data }) => ({ path, tags: data.tags, lineCount: data.lineCount })),
		stats: { ...scan.stats, definitions, references },
	};
}
