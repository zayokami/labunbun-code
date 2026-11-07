// A read-only repository index: which source files exist and what each one
// declares. This is the validation slice of the Repo Map design — the walk and
// the ignore rules are the ones Glob uses, the parse is a WASM tree-sitter
// grammar (the native bindings are unreliable under Bun on Windows), and the
// cache is in memory, keyed by each file's mtime and size. Ranking, a token
// budget and a persistent cache are the next stage; this one exists to show
// that a cold scan of a hundred thousand lines is cheap enough to build on.
//
// Long-form design notes: docs/dev/repomap.md (P0).
import { createRequire } from "node:module";
import { relative } from "node:path";
import { Language, Parser, type Node as SyntaxNode, type Tree } from "web-tree-sitter";
import { walkProjectFiles } from "./glob.ts";
import {
	REPO_MAP_CODE_FILES,
	REPO_MAP_LANGUAGES,
	REPO_MAP_TAG_RULES,
	type RepoMapLanguage,
	type RepoMapTagDefinitionKind,
	repoMapLanguageFor,
} from "./repomap-languages.ts";

export { REPO_MAP_CODE_FILES, type RepoMapLanguage, repoMapLanguageFor };

export type RepoMapDefinitionKind = "function" | "class" | "interface" | "type" | "enum";

export interface RepoMapDefinition {
	name: string;
	kind: RepoMapDefinitionKind;
	/** One-based line the declaration starts on. */
	line: number;
}

export interface RepoMapFile {
	/** Path relative to the map root, forward slashes. */
	path: string;
	definitions: RepoMapDefinition[];
}

export interface RepoMapStats {
	/** Files included in the result (parsed plus cached). */
	files: number;
	/** Files read and parsed this run. */
	parsed: number;
	/** Files served from the cache without a read. */
	cached: number;
	/** Files skipped: too large, unreadable, or vanished mid-scan. */
	skipped: number;
	definitions: number;
	/** Source characters read; not bytes, but the right size for a token estimate. */
	charsRead: number;
	elapsedMs: number;
}

export interface RepoMapResult {
	files: RepoMapFile[];
	/** The rendered map. Files without a top-level definition are in `files` but not here. */
	text: string;
	stats: RepoMapStats;
}

/** The narrow filesystem surface a scan needs; `NodeFileSystemOperations` fits it. */
export interface RepoMapOps {
	readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
	stat(path: string): Promise<{ mtimeMs: number; size: number }>;
	readTextFile(path: string): Promise<string>;
}

type CacheEntry<T> = { mtimeMs: number; size: number; data: T };

/**
 * Per-file cache. The payload is whatever the scan extracts: definitions for
 * P0, tags and snippets for P1. Implementations are synchronous because both
 * the in-memory map and `bun:sqlite` are.
 */
export interface RepoMapCache<T = RepoMapDefinition[]> {
	get(path: string, mtimeMs: number, size: number): T | undefined;
	set(path: string, mtimeMs: number, size: number, data: T): void;
}

/** The default cache. One process, one repository; see `repomap-sqlite.ts` for persistence. */
export class InMemoryRepoMapCache<T = RepoMapDefinition[]> implements RepoMapCache<T> {
	readonly #entries = new Map<string, CacheEntry<T>>();

	get(path: string, mtimeMs: number, size: number): T | undefined {
		const entry = this.#entries.get(path);
		// Size as well as mtime: Windows timestamps can be too coarse to tell two
		// edits in the same tick apart, and a changed size catches nearly all of them.
		return entry && entry.mtimeMs === mtimeMs && entry.size === size ? entry.data : undefined;
	}

	set(path: string, mtimeMs: number, size: number, data: T): void {
		this.#entries.set(path, { mtimeMs, size, data });
	}

	get size(): number {
		return this.#entries.size;
	}

	clear(): void {
		this.#entries.clear();
	}
}

export interface RepoMapOptions<T = RepoMapDefinition[]> {
	/** Files to consider; defaults to the extension set `REPO_MAP_CODE_FILES` covers. */
	pattern?: Bun.Glob;
	/** Honour `.gitignore` files; on by default, matching Glob. */
	respectGitignore?: boolean;
	/** Files above this size are skipped without being read. Default: 1 MiB. */
	maxFileBytes?: number;
	/** Share one cache across scans to get the hot path. A fresh cache is allocated otherwise. */
	cache?: RepoMapCache<T>;
	onUnreadableDirectory?: (path: string) => void;
	/** Files one scan collects before it stops. Default: the walker's 5,000. */
	maxFiles?: number;
	/** Called once when the walk stops at `maxFiles`, so the caller can say the tree is partial. */
	onTruncated?: (maxFiles: number) => void;
}

export type RepoMapLanguages = Record<RepoMapLanguage, Language>;

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 8;

// Tree-sitter's WASM runtime may only be initialised once per process, and the
// grammars are large enough that loading them per scan would be visible. Both
// live for the process; a failed load is not cached, so a caller can retry.
const languagesPromise = new Map<RepoMapLanguage, Promise<Language>>();
let parserInit: Promise<void> | null = null;

function initParser(): Promise<void> {
	parserInit ??= Parser.init().catch((error: unknown) => {
		parserInit = null;
		throw error;
	});
	return parserInit;
}

/**
 * Load one grammar, once per process.
 *
 * A scan loads only the grammars its files actually use: a TypeScript checkout
 * should not pay for Python's WASM, and the six together are several megabytes.
 */
export function loadRepoMapLanguage(name: RepoMapLanguage): Promise<Language> {
	let pending = languagesPromise.get(name);
	if (!pending) {
		pending = (async () => {
			await initParser();
			const require = createRequire(import.meta.url);
			return Language.load(require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${name}.wasm`));
		})().catch((error: unknown) => {
			languagesPromise.delete(name);
			throw error;
		});
		languagesPromise.set(name, pending);
	}
	return pending;
}

/** Load every grammar. For tests and one-off parses; a scan loads only what it needs. */
export async function loadRepoMapLanguages(): Promise<RepoMapLanguages> {
	const loaded = await Promise.all(REPO_MAP_LANGUAGES.map((name) => loadRepoMapLanguage(name)));
	const languages = {} as RepoMapLanguages;
	for (const [index, name] of REPO_MAP_LANGUAGES.entries()) languages[name] = loaded[index] as Language;
	return languages;
}

// P0 keeps its own top-level walk; the tag rules are the one place that knows a
// grammar's declaration node types.
function p0Kind(kind: RepoMapTagDefinitionKind): RepoMapDefinitionKind {
	return kind === "method" ? "function" : kind;
}

/**
 * Top-level declarations only. A function declared inside another function is
 * local to it and would turn the map into an outline of every implementation;
 * a method is reachable through its class name, which is already on the map.
 */
function collectDeclarations(node: SyntaxNode, language: RepoMapLanguage, out: RepoMapDefinition[]): void {
	const definition = REPO_MAP_TAG_RULES[language].definition(node);
	if (definition) {
		out.push({ name: definition.name, kind: p0Kind(definition.kind), line: node.startPosition.row + 1 });
		return;
	}
	switch (node.type) {
		case "export_statement": {
			const declaration = node.childForFieldName("declaration");
			if (declaration) collectDeclarations(declaration, language, out);
			return;
		}
		case "ambient_declaration": {
			for (const child of node.namedChildren) if (child) collectDeclarations(child, language, out);
			return;
		}
		case "lexical_declaration":
		case "variable_declaration":
		// Go groups one or more `type Box struct` specs under a declaration.
		case "type_declaration": {
			for (const child of node.namedChildren) if (child) collectDeclarations(child, language, out);
			return;
		}
		// Python wraps a decorated declaration; the definition is its `definition`.
		case "decorated_definition": {
			const definition = node.childForFieldName("definition");
			if (definition) collectDeclarations(definition, language, out);
			return;
		}
		// PowerShell groups a script's top-level statements under a list node.
		case "statement_list": {
			for (const child of node.namedChildren) if (child) collectDeclarations(child, language, out);
			return;
		}
		// A top-level `namespace N {}` is an expression statement wrapping the
		// module; find that module without descending into arbitrary expressions.
		case "expression_statement": {
			for (const child of node.namedChildren) {
				if (child && (child.type === "module" || child.type === "internal_module")) {
					collectDeclarations(child, language, out);
				}
			}
			return;
		}
		// A namespace is a container: its declarations are top-level for the
		// purpose of finding names, even if the map does not spell out the prefix.
		// C# and C++ use their own node; PHP's namespace has no body — its
		// declarations are siblings — so the body lookup finds nothing there.
		case "module":
		case "internal_module":
		case "namespace_declaration":
		case "namespace_definition": {
			const body = node.childForFieldName("body");
			if (body) for (const child of body.namedChildren) if (child) collectDeclarations(child, language, out);
			return;
		}
	}
}

/** Extract the top-level definitions of a parsed file. */
export function extractDefinitions(tree: Tree, language: RepoMapLanguage = "typescript"): RepoMapDefinition[] {
	const out: RepoMapDefinition[] = [];
	for (const child of tree.rootNode.namedChildren) if (child) collectDeclarations(child, language, out);
	return out;
}

/** Parse and extract in one call. Convenient for tests and one-off files. */
export async function definitionsInSource(source: string, language: RepoMapLanguage): Promise<RepoMapDefinition[]> {
	const grammar = await loadRepoMapLanguage(language);
	const parser = new Parser();
	try {
		parser.setLanguage(grammar);
		const tree = parser.parse(source);
		if (!tree) return [];
		try {
			return extractDefinitions(tree, language);
		} finally {
			tree.delete();
		}
	} finally {
		parser.delete();
	}
}

function formatRepoMap(files: readonly RepoMapFile[]): string {
	const lines: string[] = [];
	for (const file of files) {
		if (file.definitions.length === 0) continue;
		lines.push(`${file.path}:`);
		for (const definition of file.definitions) lines.push(`  ${definition.kind} ${definition.name}`);
	}
	return lines.join("\n");
}

export interface ScannedRepoFile<T> {
	/** Path relative to the map root, forward slashes. */
	path: string;
	data: T;
}

export interface RepoMapScanStats {
	/** Files included in the result (parsed plus cached). */
	files: number;
	/** Files read and parsed this run. */
	parsed: number;
	/** Files served from the cache without a read. */
	cached: number;
	/** Files skipped: too large, unreadable, or vanished mid-scan. */
	skipped: number;
	/** Source characters read; not bytes, but the right size for a token estimate. */
	charsRead: number;
	elapsedMs: number;
}

export interface RepoMapScanResult<T> {
	files: ScannedRepoFile<T>[];
	stats: RepoMapScanStats;
}

/** Turns one parsed file into the payload the caller wants to cache. */
export type RepoMapExtractor<T> = (tree: Tree, source: string, language: RepoMapLanguage, path: string) => T;

/**
 * Walk `root` and extract a payload from every source file a grammar covers.
 *
 * Files are processed a few at a time: the reads are I/O-bound and the parses
 * are synchronous, so a handful of in-flight reads keeps the disk busy without
 * interleaving parser state. The result is sorted by path, which is what makes
 * two runs comparable byte for byte, and the cache payload is whatever
 * `extract` returns — definitions in P0, tags in P1.
 *
 * Only the grammars the walk actually found are loaded, so a pure TypeScript
 * repository never pays for the Python parser.
 */
export async function scanRepoFiles<T>(
	root: string,
	ops: RepoMapOps,
	options: RepoMapOptions<T>,
	cache: RepoMapCache<T>,
	extract: RepoMapExtractor<T>,
): Promise<RepoMapScanResult<T>> {
	const started = performance.now();
	const paths = await walkProjectFiles(root, ops, {
		pattern: options.pattern ?? REPO_MAP_CODE_FILES,
		respectGitignore: options.respectGitignore ?? true,
		onUnreadableDirectory: options.onUnreadableDirectory,
		maxFiles: options.maxFiles,
		onTruncated: options.onTruncated,
	});
	const languages = new Map<RepoMapLanguage, Language>();
	const present = new Set<RepoMapLanguage>();
	for (const full of paths) {
		const language = repoMapLanguageFor(full);
		if (language) present.add(language);
	}
	await Promise.all(
		[...present].map(async (name) => {
			languages.set(name, await loadRepoMapLanguage(name));
		}),
	);
	// `new Parser()` throws before the runtime is initialised, and a scan with no
	// files still constructs one.
	await initParser();
	const queue = [...paths].sort();
	const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const parser = new Parser();
	const files: ScannedRepoFile<T>[] = [];
	let parsed = 0;
	let cached = 0;
	let skipped = 0;
	let charsRead = 0;
	let cursor = 0;

	async function worker(): Promise<void> {
		while (cursor < queue.length) {
			const full = queue[cursor++];
			const path = relative(root, full).split("\\").join("/");
			const language = repoMapLanguageFor(path);
			const grammar = language ? languages.get(language) : undefined;
			if (!language || !grammar) continue;
			const stat = await ops.stat(full).catch(() => null);
			if (!stat || stat.size > maxBytes) {
				skipped++;
				continue;
			}
			const known = cache.get(full, stat.mtimeMs, stat.size);
			if (known !== undefined) {
				cached++;
				files.push({ path, data: known });
				continue;
			}
			const source = await ops.readTextFile(full).catch(() => null);
			if (source === null) {
				skipped++;
				continue;
			}
			parser.setLanguage(grammar);
			const tree = parser.parse(source);
			if (!tree) {
				skipped++;
				continue;
			}
			let data: T;
			try {
				data = extract(tree, source, language, path);
			} finally {
				// Trees hold WASM memory until deleted; a 690-file scan would otherwise
				// keep all of them alive until the next GC pass.
				tree.delete();
			}
			cache.set(full, stat.mtimeMs, stat.size, data);
			parsed++;
			charsRead += source.length;
			files.push({ path, data });
		}
	}

	try {
		await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
	} finally {
		parser.delete();
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return {
		files,
		stats: {
			files: files.length,
			parsed,
			cached,
			skipped,
			charsRead,
			elapsedMs: performance.now() - started,
		},
	};
}

/**
 * Walk `root` and return every source file with its top-level definitions.
 * This is the P0 report; `buildRepoMapTags` in `repomap-tags.ts` is the P1 one.
 */
export async function buildRepoMap(
	root: string,
	ops: RepoMapOps,
	options: RepoMapOptions = {},
): Promise<RepoMapResult> {
	const cache = options.cache ?? new InMemoryRepoMapCache();
	const scan = await scanRepoFiles(root, ops, options, cache, (tree, _source, language) =>
		extractDefinitions(tree, language),
	);
	const files: RepoMapFile[] = scan.files.map(({ path, data }) => ({ path, definitions: data }));
	const definitions = files.reduce((count, file) => count + file.definitions.length, 0);
	return {
		files,
		text: formatRepoMap(files),
		stats: { ...scan.stats, definitions },
	};
}
