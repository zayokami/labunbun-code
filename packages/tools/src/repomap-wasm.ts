// Tree-sitter's WASM assets, embedded rather than discovered on disk. In a
// compiled executable there is no node_modules beside the binary: `Parser.init()`
// looks for its own wasm under the virtual `$bunfs` root and fails with ENOENT,
// and the same is true of a grammar resolved through `createRequire`. Importing
// each file with `with { type: "file" }` makes the bundler embed it and hand
// back a path Bun can read in both modes; `Language.load` takes the bytes.
//
// Long-form design notes: docs/dev/repomap.md (Grammars).
import bashWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm" with { type: "file" };
import cSharpWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm" with { type: "file" };
import cppWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm" with { type: "file" };
import goWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm" with { type: "file" };
import javaWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm" with { type: "file" };
import javascriptWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import phpWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-php.wasm" with { type: "file" };
import powershellWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-powershell.wasm" with { type: "file" };
import pythonWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" with { type: "file" };
import rubyWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm" with { type: "file" };
import rustWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm" with { type: "file" };
import tsxWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import typescriptWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import { Language, Parser } from "web-tree-sitter";
import webTreeSitterWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import type { RepoMapLanguage } from "./repomap-languages.ts";

const GRAMMAR_WASM: Record<RepoMapLanguage, string> = {
	bash: bashWasm,
	"c-sharp": cSharpWasm,
	cpp: cppWasm,
	go: goWasm,
	java: javaWasm,
	javascript: javascriptWasm,
	php: phpWasm,
	powershell: powershellWasm,
	python: pythonWasm,
	ruby: rubyWasm,
	rust: rustWasm,
	tsx: tsxWasm,
	typescript: typescriptWasm,
};

// The runtime may only be initialised once per process, and the grammars are
// large enough that loading them per scan would be visible. Both live for the
// process; a failed load is not cached, so a caller can retry.
let parserInit: Promise<void> | null = null;

/** Initialise the WASM runtime once, pointed at the embedded `web-tree-sitter.wasm`. */
export function initRepoMapParser(): Promise<void> {
	parserInit ??= Parser.init({ locateFile: () => webTreeSitterWasm }).catch((error: unknown) => {
		parserInit = null;
		throw error;
	});
	return parserInit;
}

const grammars = new Map<RepoMapLanguage, Promise<Language>>();

/**
 * Load one grammar, once per process.
 *
 * A scan loads only the grammars its files actually use: a TypeScript checkout
 * should not pay for Python's WASM, and the six together are several megabytes.
 */
export function loadRepoMapGrammar(name: RepoMapLanguage): Promise<Language> {
	let pending = grammars.get(name);
	if (!pending) {
		pending = (async () => {
			await initRepoMapParser();
			const bytes = new Uint8Array(await Bun.file(GRAMMAR_WASM[name]).arrayBuffer());
			return Language.load(bytes);
		})().catch((error: unknown) => {
			grammars.delete(name);
			throw error;
		});
		grammars.set(name, pending);
	}
	return pending;
}
