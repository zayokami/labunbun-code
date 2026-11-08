# Vendored repository-map grammars

These four WASM modules are the grammars the repository map uses for languages
the `@vscode/tree-sitter-wasm` bundle does not ship. They are built from the
upstream grammar source at the commit below, never downloaded from npm: the
prebuilt grammars published there (`tree-sitter-wasms`, `tree-sitter-wasms-complete`)
are older ABI builds that `web-tree-sitter@0.27` rejects while reading the
dylink section.

| Module | Upstream | Commit | License |
| --- | --- | --- | --- |
| `tree-sitter-zig.wasm` | https://github.com/tree-sitter-grammars/tree-sitter-zig | `6479aa13f32f701c383083d8b28360ebd682fb7d` | MIT |
| `tree-sitter-kotlin.wasm` | https://github.com/fwcd/tree-sitter-kotlin | `d6af96d2e23ef0a8ff5ab512864378cf08fba311` | MIT |
| `tree-sitter-swift.wasm` | https://github.com/alex-pinkus/tree-sitter-swift | `9e3b87f66f1fd2f3b931376fd3723ab788e337c3` | MIT |
| `tree-sitter-lua.wasm` | https://github.com/tree-sitter-grammars/tree-sitter-lua | `10fe0054734eec83049514ea2e718b2a56acd0c9` | MIT |

Each grammar's full license notice is copied verbatim under `LICENSES/`, as the
MIT license requires for a redistributed binary. The WASM modules also contain
the tree-sitter runtime, which is MIT-licensed (`web-tree-sitter` carries its
own notice).

## Rebuilding

```sh
bun run scripts/build-repomap-grammars.ts            # all four
bun run scripts/build-repomap-grammars.ts zig lua    # a subset
```

The script needs `tree-sitter` 0.27.x on `PATH` (or `TREE_SITTER_CLI` pointing
at it). The CLI downloads its own wasi-sdk and binaryen on first use, runs
`tree-sitter generate` and `tree-sitter build --wasm`, then load-checks each
module with `web-tree-sitter` before copying it here.

Swift needs one source patch: its external scanner calls `fprintf(stderr, …)`
and `exit` when allocating scanner state fails, and a wasm parser imports no
libc. The build script replaces that out-of-memory path with `__builtin_trap()`.
