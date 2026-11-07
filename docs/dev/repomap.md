# Repository map

The repository map is the ranked, token-budgeted outline of a checkout that a
model receives when it asks "what is in this project?". It is built in stages.
P0 (committed in `8d88093`) proved that walking and parsing a large tree with
tree-sitter is cheap enough to do on demand. P1 adds what makes the output
useful: definitions and call references, a file-level graph, PageRank, a token
budget, and a persistent cache. P2 exposes the result as a tool, a prompt
section and two commands. P3 adds ten more grammars, shares the map with
subagents, lets `/map-refresh` replace the prompt section, and makes a
repository past the walker's file ceiling say so. The stages share one walk, one
grammar loader, and one cache interface.

Long-form notes for the pipeline live here; the code is these modules:

| File | Role |
| --- | --- |
| `packages/tools/src/repomap.ts` | types, grammar loading, the walk-and-extract loop, P0's flat map |
| `packages/tools/src/repomap-languages.ts` | per-grammar definition and reference rules |
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
  `exports.f = …` assignments. TypeScript/JavaScript, Java and PHP skip the
  constructor because its class already is a tag; Ruby's `initialize` and C++
  constructors are ordinary method/function tags. Unlike P0, extraction descends
  into class bodies and nested scopes, matching Aider's tree-sitter query rather
  than reporting only the top level.
- **ref** — the file calls `name` (a `call_expression` callee or a
  `new_expression` constructor). Member calls are recorded under the property
  name (`obj.run()` is a reference to `run`), and `require` is ignored.

### Grammars

`repomap-languages.ts` holds the node vocabulary for each grammar; the walk, the
graph and the ranker know nothing about languages. Thirteen grammars ship, and
the extension picks one:

| Extensions | Grammar |
| --- | --- |
| `.ts`, `.mts`, `.cts` | typescript |
| `.tsx` | tsx |
| `.js`, `.jsx`, `.mjs`, `.cjs` | javascript |
| `.py` | python |
| `.go` | go |
| `.rs` | rust |
| `.java` | java |
| `.cs` | c-sharp |
| `.c`, `.h`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` | cpp |
| `.rb`, `.rake` | ruby |
| `.php` | php |
| `.sh`, `.bash` | bash |
| `.ps1`, `.psm1`, `.psd1` | powershell |

The rules are the same shape for every language: which node types declare a
name and what kind they are, and where a call node names its callee.

- **TypeScript / TSX / JavaScript** — the P1 rules, shared by all three. TSX
  adds JSX tags: `<Widget />` and `<Foo.Bar />` are references to the component
  (the map is how a React file reaches another file's exports), while a
  lower-case tag such as `<div />` is an intrinsic element and is skipped. Only
  the opening element is read, so `<Widget></Widget>` counts once.
- **Python** — `function_definition` and `class_definition`; a call's callee is
  the identifier, or the attribute of `obj.method()`. Nested functions and
  methods are tags; a decorated function is found through its
  `decorated_definition`.
- **Go** — `function_declaration`, `method_declaration` and `type_spec` (both
  structs and interfaces, recorded as `class` because the ranker only needs the
  name). Calls read the identifier or the selector's field.
- **Rust** — `function_item`, `function_signature_item` (a trait method),
  `struct_item`, `enum_item`, `trait_item` and `type_item`. Callees cover free
  calls, `self.method()`, `Thing::new()` and turbofish `foo::<T>()`. Macro
  arguments are raw tokens rather than parsed calls, so `println!` does not
  produce references to what it prints.
- **Java** — classes, interfaces, enums and records, plus methods on any of
  them. A call reads the invocation's `name` field, which covers both `f()` and
  `obj.f()`; `new X()` reads the created type, unwrapping generics and scoped
  names.
- **C#** — classes, interfaces, enums, structs and records, plus methods. A
  namespace body is a container in P0, like a TypeScript module. Invocations
  read the function identifier or the member access's name; `new X()` handles
  generic and qualified type names.
- **C++** — `class_specifier`, `struct_specifier`, `union_specifier`,
  `enum_specifier` and `function_definition`, with the declarator unwrapped
  through function, pointer and reference layers so `int *A::f()` and
  `Foo& Foo::operator=()` still name the function (`reference_declarator` does
  not expose its inner declarator as a field, so the rule falls back to a named
  child). Calls read identifiers, `obj.f()`, `A::f()` and the templated forms;
  `new X()` reads the type. P0 descends `template_declaration`,
  `linkage_specification` (`extern "C"`) and the `preproc_if*` branches, so a
  declaration behind a template or an `#ifdef` is still top-level. The C++
  grammar also parses C, and both use it so a mixed C/C++ tree has one graph.
- **Ruby** — `method`, `singleton_method`, `class` and `module` (a module is
  recorded as a class; the ranker only needs the name). Every call node names
  its callee in the `method` field, so `helper()`, `Widget.make` and
  `Box.new` all resolve.
- **PHP** — classes, traits (recorded as classes), interfaces, enums,
  functions and methods; `__construct` is skipped like a JavaScript
  constructor. Calls cover `f()`, `$obj->f()` and `X::f()`; `new X()` reads the
  created name.
- **Bash** — `function_definition` for both `f() { … }` and `function f { … }`.
  Every command is a reference; builtins like `echo` simply never match a
  defined name.
- **PowerShell** — `function_statement` (also how `filter` is spelled), plus
  `class_statement`, `enum_statement`, `class_method_definition` and
  `class_property_definition`. The class name is a `simple_name` child and a
  property's name is a `variable` with a leading `$` that is dropped so it joins
  the `$this.Name` reference. A constructor repeats the class name and is
  skipped. Commands (`Write-Host`, a bare `Beta`) are references the same way
  shell commands are, and so is a member invocation such as `$obj.Speak()`
  (the grammar spells the node `invokation_expression`).

CSS and INI are not mapped. They have no call graph — only names in a
stylesheet or a config file — and listing those names would spend the token
budget while ranking nothing, so they stay out of `REPO_MAP_CODE_FILES`.

The grammars are loaded per language and once per process: a scan looks at the
extensions its walk found and loads only those, so a pure TypeScript checkout
never pays for Python's WASM. P0's flat map (`extractDefinitions`) reports
top-level declarations only; a method or nested function is reachable through
the name its container already has. P1's `extractTags` descends everywhere.

A file with no grammar is skipped by the scan rather than reported as empty.
`REPO_MAP_CODE_FILES` is the glob that picks these extensions, and the
small-repository count uses the same set.

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
code a process-local store. WAL mode is on for file-backed caches, with
`synchronous = NORMAL` (WAL's recommended level: a crash can lose the newest
commits but not corrupt the file, and the cache can be rebuilt anyway) and a
five-second `busy_timeout`, because two sessions in one checkout share the file.

Writes are buffered and land in one transaction: `set` fills a pending map, an
in-scan `get` reads that map first, and `scanRepoFiles` calls `flush()` once its
workers finish. Autocommitting each file costs an fsync per row — seconds on a
twenty-thousand-file `refresh` — and the buffer turns them into one commit. A
scan that dies before flushing simply loses those rows; the next scan reads the
files again.

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
suggests raising `maxTokens`. The footer also names files the scan could not
read or skipped for size, and directories the walk could not list — a hole in
the map must not read as an empty part of the repository. It is declared
read-only and concurrency-safe, and
its result cap is 80,000 characters — a maximum-budget map is roughly 64,000.
An input that cannot be mapped (outside the workspace, not a directory) comes
back as the result text, not a thrown error.

**The prompt section.** At startup each host asks the service for
`promptSection()`. It is offered only when the walk fits 200 files and 512 KiB,
the scan finds at least one definition, and every definition fits the 1,024-token
budget. The walk is asked for 201 matches, so a large repository is rejected as
soon as the ceiling is crossed rather than after walking thousands of files; the
byte pass runs only for a tree that is still a candidate. A larger repository
gets no section — a truncated map presented as *the*
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

## Languages, subagents and large trees (P3)

**Grammars.** Python, Go, Rust, Java, C#, C++, Ruby, PHP, Bash and PowerShell
joined TypeScript, TSX and JavaScript (see *Grammars* above). A scan loads only
the grammars its walk actually found, each once per process; a failed load is not
cached, so a retry is possible.

**Subagents.** A subagent's context block now carries the same `# Repository
map` the parent holds, between the environment section and project memory. The
map is read at spawn time, so a subagent spawned after a `/map-refresh` sees the
new one. It shares the parent's `RepoMap` tool and service already
(`ctx.allTools()`); the prompt section is the half that was missing. As with the
parent, a large checkout contributes no section and the worker uses the tool.

**Refreshing the prompt.** `/map-refresh` rebuilds the section from the cache the
scan just filled and calls `sessionRef.setSystemPrompt(buildPrompt(memoryText))`
— the same path the `#` memory shortcut and `/model` use. `/map` deliberately
does not: looking at the map should not discard the cached prompt prefix. A
section that declines after the refresh (the tree grew past 200 files) becomes
`undefined`, removing a map the session no longer deserves to carry. If the
rebuild fails, the report says the files were re-read but the prompt still holds
the old map.

**A tree past the file ceiling.** `walkProjectFiles` collects 5,000 matches by
default — enough for the `Glob` tool, which shows 200 anyway, but a million-line
checkout reaches it. The walk now takes `maxFiles` and an optional
`onTruncated(limit)` callback; a map passes `REPO_MAP_SCAN_MAX_FILES` (20,000)
and reports `truncated` in its summary. The tool footer and `/map` say the scan
stopped at its ceiling and the rest of the tree is unindexed, which is a
different claim from the budget note: one means "more exists but did not fit",
the other "it was never looked at". `promptSection` is unaffected — it declines
at 200 files long before either ceiling.

## Measurements

Measured on Windows 11, Bun 1.4.4, 2026-11-07.

| Tree | Files | Lines | Cold scan | Hot scan | Rank | Render | Definitions | References |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Synthetic (100 files) | 100 | 100,100 | 780 ms | 10 ms | 64 ms | 19 ms | 80,100 | 10,000 |
| This repository | 724 | — | 1,974 ms | 87 ms | 60 ms | <1 ms | 8,152 | 149,441 |

"Cold" is an empty in-memory cache: every file is read and parsed. "Hot" is a
second pass with the same cache: no reads, no parses, only stats and the walk.
Render is the time for both the 1,024- and 4,096-token probes (the reported
column is the 1,024 probe).

Map sizes at the two budgets:

| Tree | 1,024 tokens | 4,096 tokens |
| --- | ---: | ---: |
| Synthetic | 49 definitions, 1 file, 1,006 tokens | 202 definitions, 3 files, 4,089 tokens |
| This repository | 24 definitions, 17 files, 974 tokens | 81 definitions, 49 files, 4,189 tokens |

The synthetic tree is reproducible with `bun run repomap:bench`; pass a path to
benchmark a real checkout (`bun run repomap:bench .`).

## What is left

- More grammars than `@vscode/tree-sitter-wasm` ships. The set it does ship is
  covered except CSS, INI and regex, which are left out on purpose (see
  *Grammars*; regex is not a source language). A grammar for a language the
  package lacks would need its own WASM build and a test per rule.
- A million-line tree is still linear in files: the scan is parallel across
  reads but synchronous across parses, and the remaining cost is the walk and
  the stats. A worker pool or a persistent file index (a directory-level mtime
  summary stored beside the cache) is where that work belongs. The 20,000-file
  ceiling makes the current behaviour honest; it does not make it fast.
- Nothing watches the tree. `/map-refresh` is the only thing that pulls an edit
  made outside the session into the prompt; a watcher would let it follow every
  save, at the cost of invalidating the cached prefix each time.
