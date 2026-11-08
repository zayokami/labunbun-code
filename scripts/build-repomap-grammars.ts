#!/usr/bin/env bun
/**
 * Rebuild the repository-map grammars the `@vscode/tree-sitter-wasm` bundle
 * does not ship, and vendor the result under `packages/tools/wasm`.
 *
 * Prebuilt grammars published on npm (`tree-sitter-wasms`,
 * `tree-sitter-wasms-complete`) are older ABI builds that web-tree-sitter 0.27
 * rejects inside `getDylinkMetadata`, so these four are compiled here from the
 * pinned upstream commit with `tree-sitter-cli`. The CLI downloads its own
 * wasi-sdk and binaryen into the OS cache on first use; there is nothing else to
 * install except the CLI itself.
 *
 * Usage:
 *   bun run scripts/build-repomap-grammars.ts            all four
 *   bun run scripts/build-repomap-grammars.ts zig lua    a subset
 *
 * `TREE_SITTER_CLI` overrides the `tree-sitter` found on PATH, and
 * `LABUNBUN_GRAMMAR_CACHE` overrides where the upstream checkouts live (by
 * default a directory under the OS temp directory, since the checkout is
 * disposable). Each output is load-checked before it is copied, so a toolchain
 * that produces an unreadable module fails here rather than in a scan.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TOOLS_ROOT = join(import.meta.dir, "..", "packages", "tools");
// `web-tree-sitter` is a dependency of the tools package, not of the repo root,
// so it is resolved from there rather than by a bare import this file cannot
// satisfy.
const { Language, Parser } = await import(pathToFileURL(Bun.resolveSync("web-tree-sitter", TOOLS_ROOT)).href);
const webTreeSitterWasm: string = Bun.resolveSync("web-tree-sitter/web-tree-sitter.wasm", TOOLS_ROOT);

interface GrammarBuild {
	/** `zig` means `tree-sitter-zig` on disk and `tree-sitter-zig.wasm` in the package. */
	name: string;
	repo: string;
	commit: string;
	license: string;
	/**
	 * A source change the wasm target needs. Swift's external scanner calls
	 * `fprintf(stderr, …)` and `exit` when its state allocation fails, but a wasm
	 * parser imports no libc and `tree-sitter build` refuses the undefined
	 * symbols. The OOM path traps instead.
	 */
	scannerPatch?: { file: string; from: string; to: string };
}

const SWIFT_SCANNER_OOM = [
	"    if (!payload) {",
	'        fprintf(stderr, "tree-sitter-swift: out of memory allocating scanner state\\n");',
	"        exit(1);",
	"    }",
].join("\n");

const GRAMMARS: readonly GrammarBuild[] = [
	{
		name: "zig",
		repo: "https://github.com/tree-sitter-grammars/tree-sitter-zig.git",
		commit: "6479aa13f32f701c383083d8b28360ebd682fb7d",
		license: "LICENSE",
	},
	{
		name: "kotlin",
		repo: "https://github.com/fwcd/tree-sitter-kotlin.git",
		commit: "d6af96d2e23ef0a8ff5ab512864378cf08fba311",
		license: "LICENSE",
	},
	{
		name: "swift",
		repo: "https://github.com/alex-pinkus/tree-sitter-swift.git",
		commit: "9e3b87f66f1fd2f3b931376fd3723ab788e337c3",
		license: "LICENSE",
		scannerPatch: {
			file: "src/scanner.c",
			from: SWIFT_SCANNER_OOM,
			to: [
				"    if (!payload) {",
				"        /* wasm builds cannot reach stderr/fwrite/exit; trap instead. */",
				"        __builtin_trap();",
				"    }",
			].join("\n"),
		},
	},
	{
		name: "lua",
		repo: "https://github.com/tree-sitter-grammars/tree-sitter-lua.git",
		commit: "10fe0054734eec83049514ea2e718b2a56acd0c9",
		license: "LICENSE.md",
	},
];

const CACHE_ROOT = process.env.LABUNBUN_GRAMMAR_CACHE ?? join(tmpdir(), "labunbun-repomap-grammars");
const PACKAGE_WASM = join(import.meta.dir, "..", "packages", "tools", "wasm");

function run(command: string[], cwd: string): void {
	const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return;
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	throw new Error(`${command.join(" ")} failed in ${cwd}${output ? `:\n${output}` : ""}`);
}

function toolPath(): string {
	const configured = process.env.TREE_SITTER_CLI;
	if (configured) return configured;
	const found = Bun.which("tree-sitter");
	if (!found) {
		throw new Error(
			"tree-sitter-cli was not found. Install tree-sitter@0.27.x (npm i -g tree-sitter-cli) " +
				"or point TREE_SITTER_CLI at the executable.",
		);
	}
	return found;
}

function checkout(grammar: GrammarBuild, treeSitter: string): string {
	const dir = join(CACHE_ROOT, `tree-sitter-${grammar.name}`);
	if (!existsSync(dir)) run(["git", "clone", "--depth", "1", "--no-checkout", grammar.repo, dir], CACHE_ROOT);
	// Fetch by commit: tags move, and a shallow clone still accepts a raw SHA
	// from GitHub. The reset is what makes a dirty checkout (a previous patch)
	// reproducible.
	run(["git", "fetch", "--depth", "1", "origin", grammar.commit], dir);
	run(["git", "reset", "--hard", grammar.commit], dir);
	run(["git", "clean", "-fdx"], dir);
	if (grammar.scannerPatch) {
		const path = join(dir, grammar.scannerPatch.file);
		// A Windows checkout may have turned the upstream LF into CRLF; the
		// patch is written with the line endings the compiler reads either way.
		const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
		if (!source.includes(grammar.scannerPatch.to)) {
			if (!source.includes(grammar.scannerPatch.from)) {
				throw new Error(`${grammar.name}: the pinned scanner no longer matches; update the patch in this script`);
			}
			writeFileSync(path, source.replace(grammar.scannerPatch.from, grammar.scannerPatch.to));
		}
	}
	run([treeSitter, "generate"], dir);
	return dir;
}

async function main(): Promise<void> {
	const requested = process.argv.slice(2);
	for (const name of requested) {
		if (!GRAMMARS.some((grammar) => grammar.name === name)) {
			throw new Error(`unknown grammar "${name}"; known: ${GRAMMARS.map((grammar) => grammar.name).join(", ")}`);
		}
	}
	const selected = requested.length === 0 ? GRAMMARS : GRAMMARS.filter((grammar) => requested.includes(grammar.name));
	const treeSitter = toolPath();
	mkdirSync(CACHE_ROOT, { recursive: true });
	mkdirSync(join(PACKAGE_WASM, "LICENSES"), { recursive: true });
	await Parser.init({ locateFile: () => webTreeSitterWasm });

	for (const grammar of selected) {
		const dir = checkout(grammar, treeSitter);
		const built = join(CACHE_ROOT, `tree-sitter-${grammar.name}.wasm`);
		run([treeSitter, "build", "--wasm", "-o", built], dir);

		const language = await Language.load(new Uint8Array(await Bun.file(built).arrayBuffer()));
		const target = join(PACKAGE_WASM, `tree-sitter-${grammar.name}.wasm`);
		copyFileSync(built, target);
		copyFileSync(join(dir, grammar.license), join(PACKAGE_WASM, "LICENSES", `tree-sitter-${grammar.name}.LICENSE`));
		console.log(
			`${grammar.name}: abi ${language.abiVersion ?? "?"}, ${Math.round((await Bun.file(target).size) / 1024)} KB`,
		);
	}
}

await main();
