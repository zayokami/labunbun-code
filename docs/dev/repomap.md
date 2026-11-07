# Repository map

The repository map is the ranked, token-budgeted outline of a checkout that a
model receives when it asks "what is in this project?". It is built in two
stages. P0 (committed in `8d88093`) proved that walking and parsing a large tree
with tree-sitter is cheap enough to do on demand. P1 adds what makes the output
useful: definitions and call references, a file-level graph, PageRank, a token
budget, and a persistent cache. The stages share one walk, one grammar loader,
and one cache interface.

Long-form notes for the pipeline live here; the code is four modules:

| File | Role |
| --- | --- |
| `packages/tools/src/repomap.ts` | types, grammar loading, the walk-and-extract loop, P0's flat map |
| `packages/tools/src/repomap-tags.ts` | P1 tag extraction and snippets |
| `packages/tools/src/repomap-rank.ts` | file graph, PageRank, ranked definitions |
| `packages/tools/src/repomap-render.ts` | token budget and rendered text |
| `packages/tools/src/repomap-sqlite.ts` | `bun:sqlite` cache |
| `packages/tools/src/repomap-generate.ts` | the three stages in one call |
| `packages/tools/src/repomap-service.ts` | the session's cache, path containment, the prompt threshold |
| `packages/tools/src/repomap-tool.ts` | the read-only `RepoMap` tool |
| `packages/coding-agent/src/repomap-wiring.ts` | per-project cache path and host wiring |

## Tags

A tag is one of two facts about a file:

- **def** — the file declares `name` on line `line`. The declaration kinds are
  the P0 set (functions, classes, interfaces, types, enums, bound arrow/function
  expressions) plus class methods, interface method signatures, and
  `exports.f = …` assignments. A constructor is not a tag because its class
  already is one. Unlike P0, extraction descends into class bodies and nested
  scopes, matching Aider's tree-sitter query rather than reporting only the
  top level.
- **ref** — the file calls `name` (a `call_expression` callee or a
  `new_expression` constructor). Member calls are recorded under the property
  name (`obj.run()` is a reference to `run`), and `require` is ignored.

Each definition carries a **snippet**: its declaration and a bounded amount of
its body. Classes, interfaces, type aliases, and enums contribute only their
header because their members are separate tags; functions and methods
contribute up to 12 lines. The definition's own final closing brace is dropped,
matching Aider's rendering; a closing brace in the middle of the body is kept.
Lines are trimmed of trailing whitespace and truncated at 100 characters, as
Aider does.

The snippets are stored in the cache, so rendering never re-reads the source.
That trades cache size for a much smaller hot path and makes the map
deterministic.

## Ranking

The ranker follows Aider's `get_ranked_tags`:

1. Build `defines: name -> files` and `references: name -> occurrences`. If a
   grammar produced no references at all, treat every definition file as a
   reference so the graph stays connected.
2. For every name defined and referenced somewhere, add a weighted edge from
   each referencing file to each defining file. The weight is
   `mul * sqrt(occurrences)`, where `mul` is 10 for a mentioned identifier, 10
   for a snake/kebab/camel identifier of at least eight characters, 0.1 for a
   leading underscore, 0.1 when more than five files define the name, and 50
   more when the referencing file is in the chat. Definitions nobody references
   get a 0.1 self-edge.
3. Run PageRank with damping 0.85. Files in the chat, files the user mentioned,
   and files whose path component matches a mentioned identifier receive
   personalization; the vector is normalized exactly as networkx normalizes it.
   Dangling mass is redistributed by the same vector.
4. Distribute each file's rank across its out-edges and accumulate the share
   for each `(defining file, name)` pair. Sort by rank, then by path and name
   descending, and skip definitions in chat files.
5. Append a bare entry for every file that contributed no selected definition:
   graph nodes first in rank order, then files that never entered the graph in
   path order.

Two deliberate differences from Aider are worth knowing when comparing output:

- Aider takes `sqrt(occurrences)` inside the definer loop, so a name with
  several definers is square-rooted once per definer. That looks accidental;
  this port takes the root once.
- Aider appends the remaining tagless files by iterating a Python set, so their
  order is not stable. This port sorts them.

The result is compared against Aider's own fixture:
`packages/tools/test/fixtures/repomap/sample.js` renders byte-for-byte to
`sample.js.expected` (the JavaScript half of
`tests/fixtures/sample-code-base-repo-map.txt` in Aider), modulo the leading
blank line Aider emits.

## Token budget

`renderRepoMap` renders the smallest-ranked prefix that fits the budget. It
starts at `budget / 25` entries — Aider's estimate of an entry's cost — counts
the rendered text, and halves the interval until the probe fits (and is larger
than the best so far) or lands within 15% of the budget. The 15% tolerance is
Aider's: it stops the search from spending probes on a marginal improvement.

The token counter is injectable. By default it estimates four characters per
token, which is coarse but enough for a budget; P2 can pass a model tokenizer
without changing the ranker or renderer. `repoMapTokenBudget` mirrors Aider's
defaults: 1,024 tokens when the chat already has files, up to
`min(8,192, maxInputTokens - 4,096)` when the map is the only repository
context.

The rendered format is one block per file:

```
src/tools.ts:
⋮
│export function run(input: string) {
│  return parse(input);
⋮
```

`⋮` marks a gap between non-adjacent source lines, a leading gap when the first
selected line is not line 1, and a trailing gap when the file continues after
the last selected line. A file with no selected definitions is rendered as its
bare path. Blocks are separated by one blank line.

## Cache

`SqliteRepoMapCache` stores the scan payload as JSON, keyed by the absolute
path and validated by `mtimeMs` and `size` — the same rule as the in-memory
cache, whose size component catches Windows edits that land in the same clock
tick. The table is named `repo_map_cache_v1`; a payload shape change belongs in
a new table so an old binary cannot read new rows. `:memory:` gives the same
code a process-local store. WAL mode is on for file-backed caches.

Both caches implement `RepoMapCache<T>`; the payload is definitions in P0 and
`RepoMapFileTags` in P1. Closing the SQLite cache is the caller's job; nothing
holds a database handle open after a scan.

## Tool, prompt and commands (P2)

P2 turns the pipeline into three things a session can reach.

**The service.** `RepoMapService` owns one cache per session. Its `map()` call
resolves the requested directory, refuses one outside the workspace, and keeps
the scan, rank and render behind a `RepoMapSummary` that says how much of the
repository the budget left out (`partial`). The budget defaults to 1,024 tokens
and is clamped to 128–16,384; `refresh: true` clears the cache first. The cache
is created on first use, so a session that never asks for a map opens no file.
A SQLite path that cannot be opened (read-only home, a locked file) falls back
to memory rather than failing the map. The handle is open only while a scan is
running: the last map to finish closes it, and the next map reopens the same
file, so the rows persist without a session holding the database open between
requests (on Windows an open WAL sidecar also keeps the directory from being
removed). A caller-supplied cache is never closed by the service.

Every host builds the service once and passes it to `createAllTools`, so the
RepoMap tool, `/map` and the startup prompt section share one cache. The path is
`<sessionsRoot>/<sanitizeCwd(cwd)>/repomap.sqlite` — beside the transcripts, so
every session in the same checkout starts hot.

**The tool.** `RepoMap` takes an optional `path`, `maxTokens` and `refresh`. It
returns the rendered map followed by one line saying how many definitions and
files the budget allowed and how long the scan took; a partial map says so and
suggests raising `maxTokens`. It is declared read-only and concurrency-safe, and
its result cap is 80,000 characters — a maximum-budget map is roughly 64,000.
An input that cannot be mapped (outside the workspace, not a directory) comes
back as the result text, not a thrown error.

**The prompt section.** At startup each host asks the service for
`promptSection()`. It is offered only when the walk fits 200 files and 512 KiB,
the scan finds at least one definition, and every definition fits the 1,024-token
budget. A larger repository gets no section — a truncated map presented as *the*
map would say the files it left out have nothing in them — and the tool answers
instead, where the model can raise the budget. The section is injected below
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, after the model guidance and before project
memory.

**The commands.** `/map [path] [--tokens N]` renders the map and a one-line
summary; `/map-refresh` does the same after clearing the cache, for a file edited
outside the session. The directory is positional and the budget needs its flag,
because a bare number is indistinguishable from a path component. The command
framework holds a structural `RepoMapCommand` handle rather than importing the
scanner, and a context without one answers that maps are unavailable. Local
commands exist only in the REPL; `-p` runs and ACP sessions still get the tool
and the prompt section.

## Measurements

Measured on Windows 11, Bun 1.4.4, 2026-11-07.

| Tree | Files | Lines | Cold scan | Hot scan | Rank | Render | Definitions | References |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Synthetic (100 files) | 100 | 100,100 | 800 ms | 18 ms | 67 ms | 19 ms | 80,100 | 10,000 |
| This repository | 717 | — | 1,968 ms | 124 ms | 68 ms | <1 ms | 8,073 | 147,932 |

"Cold" is an empty in-memory cache: every file is read and parsed. "Hot" is a
second pass with the same cache: no reads, no parses, only stats and the walk.
Render is the time for both the 1,024- and 4,096-token probes (the reported
column is the 1,024 probe).

Map sizes at the two budgets:

| Tree | 1,024 tokens | 4,096 tokens |
| --- | ---: | ---: |
| Synthetic | 49 definitions, 1 file, 1,006 tokens | 202 definitions, 3 files, 4,089 tokens |
| This repository | 24 definitions, 18 files, 1,078 tokens | 81 definitions, 51 files, 4,233 tokens |

The synthetic tree is reproducible with `bun run repomap:bench`; pass a path to
benchmark a real checkout (`bun run repomap:bench .`).

## What is left

- P3: Python and other grammars, sharing a map between subagents, and the
  million-line case. The current scan is linear in files and parses only what
  the cache misses; the remaining large-tree cost is the walk and the stats,
  which is where a worker pool or a persistent file index would help.
- The prompt section is computed once per process. A session whose files change
  while it runs keeps the startup map until restarted; `/map-refresh` shows the
  new one but does not replace the section. Making the section follow a refresh
  would mean rebuilding the system prompt, which the `#` memory shortcut already
  knows how to do — a natural next step, not a P2 claim.
