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

/** Every grammar this slice knows. TSX is a separate grammar from TypeScript. */
export type RepoMapLanguage = "typescript" | "tsx" | "javascript";

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

interface CacheEntry {
	mtimeMs: number;
	size: number;
	definitions: RepoMapDefinition[];
}

export interface RepoMapCache {
	get(path: string, mtimeMs: number, size: number): RepoMapDefinition[] | undefined;
	set(path: string, mtimeMs: number, size: number, definitions: RepoMapDefinition[]): void;
}

/** The P0 cache. One process, one repository; a persistent store replaces it later. */
export class InMemoryRepoMapCache implements RepoMapCache {
	readonly #entries = new Map<string, CacheEntry>();

	get(path: string, mtimeMs: number, size: number): RepoMapDefinition[] | undefined {
		const entry = this.#entries.get(path);
		// Size as well as mtime: Windows timestamps can be too coarse to tell two
		// edits in the same tick apart, and a changed size catches nearly all of them.
		return entry && entry.mtimeMs === mtimeMs && entry.size === size ? entry.definitions : undefined;
	}

	set(path: string, mtimeMs: number, size: number, definitions: RepoMapDefinition[]): void {
		this.#entries.set(path, { mtimeMs, size, definitions });
	}

	get size(): number {
		return this.#entries.size;
	}

	clear(): void {
		this.#entries.clear();
	}
}

export interface RepoMapOptions {
	/** Files to consider; defaults to the TS/JS extension set. */
	pattern?: Bun.Glob;
	/** Honour `.gitignore` files; on by default, matching Glob. */
	respectGitignore?: boolean;
	/** Files above this size are skipped without being read. Default: 1 MiB. */
	maxFileBytes?: number;
	/** Share one cache across scans to get the hot path. A fresh cache is allocated otherwise. */
	cache?: RepoMapCache;
	onUnreadableDirectory?: (path: string) => void;
}

export interface RepoMapLanguages {
	typescript: Language;
	tsx: Language;
	javascript: Language;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 8;
const CODE_FILES = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");

// Tree-sitter's WASM runtime may only be initialised once per process, and the
// grammars are large enough that loading them per scan would be visible. Both
// live for the process; a failed load is not cached, so a caller can retry.
let languagesPromise: Promise<RepoMapLanguages> | null = null;

/** Load the three grammars this slice uses, once per process. */
export function loadRepoMapLanguages(): Promise<RepoMapLanguages> {
	languagesPromise ??= (async () => {
		await Parser.init();
		const require = createRequire(import.meta.url);
		const load = (name: string) =>
			Language.load(require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${name}.wasm`));
		const [typescript, tsx, javascript] = await Promise.all([load("typescript"), load("tsx"), load("javascript")]);
		return { typescript, tsx, javascript };
	})().catch((error: unknown) => {
		languagesPromise = null;
		throw error;
	});
	return languagesPromise;
}

/** The grammar for a path, or null when the extension is not one this slice parses. */
export function repoMapLanguageFor(path: string): RepoMapLanguage | null {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return null;
	switch (path.slice(dot).toLowerCase()) {
		case ".ts":
		case ".mts":
		case ".cts":
			return "typescript";
		case ".tsx":
			return "tsx";
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return "javascript";
		default:
			return null;
	}
}

const DECLARATION_KINDS: Record<string, RepoMapDefinitionKind> = {
	function_declaration: "function",
	generator_function_declaration: "function",
	class_declaration: "class",
	abstract_class_declaration: "class",
	interface_declaration: "interface",
	type_alias_declaration: "type",
	enum_declaration: "enum",
	// `declare function f(): void` — the body-less signature an ambient
	// declaration wraps.
	function_signature: "function",
};

/** What a `const x = …` value has to be for the binding to count as a declaration. */
const VALUE_KINDS: Record<string, RepoMapDefinitionKind> = {
	arrow_function: "function",
	function_expression: "function",
	generator_function: "function",
	class: "class",
};

function pushNamed(node: SyntaxNode, kind: RepoMapDefinitionKind, out: RepoMapDefinition[]): void {
	const name = node.childForFieldName("name");
	if (name) out.push({ name: name.text, kind, line: node.startPosition.row + 1 });
}

/**
 * Top-level declarations only. A function declared inside another function is
 * local to it and would turn the map into an outline of every implementation;
 * a method is reachable through its class name, which is already on the map.
 */
function collectDeclarations(node: SyntaxNode, out: RepoMapDefinition[]): void {
	const kind = DECLARATION_KINDS[node.type];
	if (kind) {
		pushNamed(node, kind, out);
		return;
	}
	switch (node.type) {
		case "export_statement": {
			const declaration = node.childForFieldName("declaration");
			if (declaration) collectDeclarations(declaration, out);
			return;
		}
		case "ambient_declaration": {
			for (const child of node.namedChildren) if (child) collectDeclarations(child, out);
			return;
		}
		case "lexical_declaration":
		case "variable_declaration": {
			for (const declarator of node.namedChildren) {
				if (declarator?.type !== "variable_declarator") continue;
				const value = declarator.childForFieldName("value");
				const valueKind = value ? VALUE_KINDS[value.type] : undefined;
				if (valueKind) pushNamed(declarator, valueKind, out);
			}
			return;
		}
		// A top-level `namespace N {}` is an expression statement wrapping the
		// module; find that module without descending into arbitrary expressions.
		case "expression_statement": {
			for (const child of node.namedChildren) {
				if (child && (child.type === "module" || child.type === "internal_module")) {
					collectDeclarations(child, out);
				}
			}
			return;
		}
		// A namespace is a container: its declarations are top-level for the
		// purpose of finding names, even if the map does not spell out the prefix.
		case "module":
		case "internal_module": {
			const body = node.childForFieldName("body");
			if (body) for (const child of body.namedChildren) if (child) collectDeclarations(child, out);
			return;
		}
	}
}

/** Extract the top-level definitions of a parsed file. */
export function extractDefinitions(tree: Tree): RepoMapDefinition[] {
	const out: RepoMapDefinition[] = [];
	for (const child of tree.rootNode.namedChildren) if (child) collectDeclarations(child, out);
	return out;
}

/** Parse and extract in one call. Convenient for tests and one-off files. */
export async function definitionsInSource(source: string, language: RepoMapLanguage): Promise<RepoMapDefinition[]> {
	const languages = await loadRepoMapLanguages();
	const parser = new Parser();
	try {
		parser.setLanguage(languages[language]);
		const tree = parser.parse(source);
		if (!tree) return [];
		try {
			return extractDefinitions(tree);
		} finally {
			tree.delete();
		}
	} finally {
		parser.delete();
	}
}

function parseDefinitions(
	parser: Parser,
	languages: RepoMapLanguages,
	language: RepoMapLanguage,
	source: string,
): RepoMapDefinition[] {
	parser.setLanguage(languages[language]);
	const tree = parser.parse(source);
	if (!tree) return [];
	try {
		return extractDefinitions(tree);
	} finally {
		// Trees hold WASM memory until deleted; a 690-file scan would otherwise
		// keep all of them alive until the next GC pass.
		tree.delete();
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

/**
 * Walk `root` and return every TS/JS file with its top-level definitions.
 *
 * Files are processed a few at a time: the reads are I/O-bound and the parses
 * are synchronous, so a handful of in-flight reads keeps the disk busy without
 * interleaving parser state. The result is sorted by path, which is what makes
 * two runs comparable byte for byte.
 */
export async function buildRepoMap(
	root: string,
	ops: RepoMapOps,
	options: RepoMapOptions = {},
): Promise<RepoMapResult> {
	const started = performance.now();
	const languages = await loadRepoMapLanguages();
	const cache = options.cache ?? new InMemoryRepoMapCache();
	const paths = await walkProjectFiles(root, ops, {
		pattern: options.pattern ?? CODE_FILES,
		respectGitignore: options.respectGitignore ?? true,
		onUnreadableDirectory: options.onUnreadableDirectory,
	});
	const queue = [...paths].sort();
	const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const parser = new Parser();
	const files: RepoMapFile[] = [];
	let parsed = 0;
	let cached = 0;
	let skipped = 0;
	let definitions = 0;
	let charsRead = 0;
	let cursor = 0;

	async function worker(): Promise<void> {
		while (cursor < queue.length) {
			const full = queue[cursor++];
			const path = relative(root, full).split("\\").join("/");
			const language = repoMapLanguageFor(path);
			if (!language) continue;
			const stat = await ops.stat(full).catch(() => null);
			if (!stat || stat.size > maxBytes) {
				skipped++;
				continue;
			}
			const known = cache.get(full, stat.mtimeMs, stat.size);
			if (known) {
				cached++;
				definitions += known.length;
				files.push({ path, definitions: known });
				continue;
			}
			const source = await ops.readTextFile(full).catch(() => null);
			if (source === null) {
				skipped++;
				continue;
			}
			const found = parseDefinitions(parser, languages, language, source);
			cache.set(full, stat.mtimeMs, stat.size, found);
			parsed++;
			definitions += found.length;
			charsRead += source.length;
			files.push({ path, definitions: found });
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
		text: formatRepoMap(files),
		stats: {
			files: files.length,
			parsed,
			cached,
			skipped,
			definitions,
			charsRead,
			elapsedMs: performance.now() - started,
		},
	};
}
