# Repository map

This document covers the P0 repository index in `packages/tools/src/repomap.ts`. P0 answers one question: can a scan of the whole checkout produce a file-and-definition map cheaply enough to be worth ranking and injecting later? It does not answer what the map should contain or where it should go. Those are P1 and P2.

## What it does

`buildRepoMap(root, ops, options)` walks the tree with `walkProjectFiles` from `glob.ts`, so the directory skips and the `.gitignore` rules are the ones Glob already uses. Every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs` file is parsed with tree-sitter, and the top-level declarations are collected: functions, classes, interfaces, type aliases, enums, and `const`/`let` bindings whose value is an arrow function, function expression, or class expression. Ambient `declare function` signatures are included, and declarations inside a namespace are collected.

Only top-level declarations are reported. A function declared inside another function is local to it, and a method is reachable through its class name, which is already on the map. An `export` wrapper is unwrapped, and declarations inside a namespace are collected as if they were top-level; the P0 map does not spell out the namespace prefix.

The rendered text lists each file that has at least one definition, then its definitions. Files with no top-level definitions stay in the structured result but are left out of the text, which is why `files.length` and the number of rendered file blocks can differ.

## Why WASM

The native `node-tree-sitter` bindings are unreliable under Bun on Windows. `web-tree-sitter` runs the same grammars from WebAssembly, so the parse path does not depend on a native module compiling for the host. The grammars are the prebuilt files in `@vscode/tree-sitter-wasm` (ABI 14, built for tree-sitter 0.25), loaded once per process and shared by every scan. TypeScript, TSX, and JavaScript are three separate grammars; TSX cannot be parsed by the TypeScript grammar because of JSX.

The grammar files are resolved from `node_modules` with `createRequire`, so the module works from a source checkout. A compiled binary cannot read `node_modules`, so bundling the wasm assets is part of the integration stage, not this one.

## Cache

The in-memory cache is keyed by absolute path and validated by both `mtimeMs` and `size`. Size is in the key because Windows timestamps can be too coarse to distinguish two edits in the same clock tick; a size change catches nearly every such edit. A changed file is read and parsed again, an unchanged one is served without a read, and a deleted file simply stops being returned by the walk and stops being used.

Every run still stats every file and re-walks the tree. That is the hot path's cost: 710 files take 136 ms, most of it from the walk and the stats rather than the parse.

## Measurements

Measured on Windows 11, Bun 1.4.4, 2026-11-07.

| Tree | Files | Lines | Cold | Hot | Definitions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Synthetic (100 files) | 100 | 100,100 | 594 ms | 21 ms | 60,100 |
| This repository | 712 | — | 1,379 ms | 118 ms | 6,053 |

"Cold" is an empty cache: every file is read and parsed. "Hot" is a second scan with the same cache: no reads and no parses. For the synthetic tree the map rendered to 1,131,279 characters (about 283k tokens at four characters per token). For this repository it rendered to 178,332 characters (about 44.6k tokens). Those sizes are the reason P1 needs a token budget before anything is injected.

The synthetic tree is reproducible with `bun run repomap:bench`; pass a path to benchmark a real checkout (`bun run repomap:bench .`).

## What P0 leaves for later

- No file-level graph, no PageRank, and no relevance ordering.
- No token budget or truncation; the full map is whatever the tree declares.
- No persistence: the cache dies with the process.
- No tool, no `/map` command, and no system-prompt section. The module is not re-exported from `packages/tools/src/index.ts` for that reason; importing it directly is the P0 contract.
