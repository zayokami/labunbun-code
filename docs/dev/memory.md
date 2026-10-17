# Memory and style

Memory is standing instruction text from two tiers. The loader joins it into one string, and the prompt builder puts that string in one `# Project memory` section of the system prompt (`packages/coding-agent/src/system-prompt.ts:96-100`, `:143-151`). The user tier is `~/.labunbun/MEMORY.md` plus `~/.labunbun/rules/*.md` (`packages/coding-agent/src/memory.ts:48-56`). The project tier is a walk from the working directory to the filesystem root (`packages/coding-agent/src/memory.ts:296-307`).

An output style is a voice instruction from a Markdown file. The prompt builder puts the selected body in its own `# Output style` section (`packages/coding-agent/src/system-prompt.ts:153-161`). The section is an addition. The instructions of the agent stay in the prompt (`packages/coding-agent/src/system-prompt.ts:60-68`).

Memory is a prompt section and not a user message for one reason: the model has to keep seeing it. The system prompt is what the cache covers, and no compaction and no transcript edit drops it (`packages/coding-agent/src/system-prompt.ts:26-37`).

## Loading and precedence

- The user tier loads first: `~/.labunbun/MEMORY.md`, then every `*.md` file in `~/.labunbun/rules/` (`packages/coding-agent/src/memory.ts:444-447`, `:250-269`).
- The project walk reads one directory at a time. At each level the loader tries `LABUNBUN.md`, then `AGENTS.md`, then `CLAUDE.md`. It reads the first one that exists and stops the list. Exactly one of the three enters the prompt per level (`packages/coding-agent/src/memory.ts:271-294`, `:284-290`).
- Each level also contributes every `*.md` file in `.labunbun/rules/` (`packages/coding-agent/src/memory.ts:292`).
- Files are deduplicated by path, with the user tier first. When the working directory sits under the home directory, the walk revisits the user rules, and this step keeps the copy that already loaded (`packages/coding-agent/src/memory.ts:458-467`).
- Render order and budget order differ on purpose. The text renders user tier first, then root to cwd, so the nearest file is last. The budget is spent user tier first, then project files nearest-first (`packages/coding-agent/src/memory.ts:469-476`).
- The total is at most 40000 characters, and the completeness note is inside that cap (`packages/coding-agent/src/memory.ts:58`, `:505-508`).
- A file that does not fit contributes a prefix, cut without splitting a surrogate pair. Every farther file is omitted (`packages/coding-agent/src/memory.ts:313-319`, `:350-364`).
- The note names the partial files and the omitted files. It names at most eight paths across both lists. A path is shortened relative to the cwd or home, stripped of control characters, and capped at 80 characters (`packages/coding-agent/src/memory.ts:60-63`, `:395-406`, `:421-433`).
- The note describes the source. It does not ask the model to read the named files (`packages/coding-agent/src/memory.ts:415-420`, `:432`).
- The loader reports the contributing files, the partial files, the omitted files, and a `truncated` flag (`packages/coding-agent/src/memory.ts:66-75`, `:509-516`).
- A session with an untrusted project lists the files the gate holds back through a separate, un-gated reading of the same walk. The user tier is subtracted, because it still loads (`packages/coding-agent/src/memory.ts:519-539`).

## Includes

- A memory file can include another file with a line of the form `@path/to/file`. The line must be the whole line; trailing spaces are allowed (`packages/coding-agent/src/memory.ts:236`).
- The expander resolves the path against the directory of the file that names it (`packages/coding-agent/src/memory.ts:237`).
- The included path must stay inside the tree of the file that names the outermost include. The check is lexical first, then repeated with real paths, so an intermediate directory link cannot escape the tree (`packages/coding-agent/src/memory.ts:204-217`, `:222-227`, `:238`).
- A path that leaves the tree becomes `[include outside allowed directory: ...]`, and the file is not read (`packages/coding-agent/src/memory.ts:238-239`).
- A path already expanded becomes `[circular include: ...]` (`packages/coding-agent/src/memory.ts:241`).
- A missing path becomes `[include not found: ...]` (`packages/coding-agent/src/memory.ts:243-244`).
- The depth guard is a cap on the number of expanded include paths. The constant is named `MAX_INCLUDE_DEPTH`, but the guard refuses a new path once more than `MAX_INCLUDE_DEPTH * 10`, that is 50, paths are in the set (`packages/coding-agent/src/memory.ts:59`, `:242`).
- The loader reads only regular files. A symlink, a directory, or a device is treated as absent, so an include cannot pull an arbitrary file into the prompt through a link (`packages/coding-agent/src/memory.ts:97-110`).

## Trust

- The trust gate sits around the whole project walk. An untrusted checkout contributes no project memory from any level, ancestors included (`packages/coding-agent/src/memory.ts:449-456`; the reason is in `:23-29`).
- The user tier is not gated. It is the user's own and loads from the same home whatever the cwd (`packages/coding-agent/src/memory.ts:28-29`, `:444-447`).
- The decision is recorded per directory, in `~/.labunbun/projects/<sanitized-cwd>/trusted-definitions.json`, under the kinds `agents`, `skills`, `memory`, and `styles` (`packages/coding-agent/src/project-trust.ts:42-49`).
- `isProjectTierTrusted(cwd, kind, home)` reads that ledger for one kind (`packages/coding-agent/src/project-trust.ts:151-154`). Memory asks for kind `memory` (`packages/coding-agent/src/memory.ts:454`).
- An approval adds the kinds to the ledger and writes it by replacement (`packages/coding-agent/src/project-trust.ts:185-222`).
- The ledger is keyed by the working directory, not by the repository root. A session in a subdirectory of a Git project gets a notice that the approval covers that subdirectory only (`packages/coding-agent/src/project-trust.ts:17-24`, `:104-122`).
- The REPL prints the withheld counts at startup when any exist (`packages/coding-agent/src/interactive.ts:2236-2251`). A `-p` run prints the same notice on stderr (`packages/coding-agent/src/headless.ts:535-545`; the wording is in `packages/coding-agent/src/project-trust.ts:104-122`).
- `/agents approve` adds the `memory` kind to the ledger when memory files are withheld (`packages/coding-agent/src/interactive.ts:3313-3325`). The approval loads agents and skills in place, but memory is read once at startup. The command tells the user to restart (`packages/coding-agent/src/interactive.ts:3370-3377`).
- `/memory` repeats the same rule after an edit: memory is read at startup, so a restart applies the edit (`packages/coding-agent/src/interactive.ts:4127-4134`).
- A project output-style directory uses the same ledger under kind `styles` (`packages/coding-agent/src/output-styles.ts:64-66`, `packages/coding-agent/src/project-trust.ts:42-45`).

## Quick notes and /memory

- A line typed in the REPL that starts with `#` becomes a memory note. The handler appends it, loads the memory files again, swaps the live system prompt, and reports success (`packages/coding-agent/src/interactive.ts:2109-2127`).
- The append writes one `- note` line to `<home>/.labunbun/MEMORY.md` (`packages/coding-agent/src/memory.ts:129-172`, `:158`).
- The write refuses a symbolic link or a non-directory at `.labunbun`, and a symbolic link or a non-regular file at `MEMORY.md` (`packages/coding-agent/src/memory.ts:130-156`).
- On POSIX the append also passes `O_NOFOLLOW` to `open` (`packages/coding-agent/src/memory.ts:112-113`, `:166-171`). Windows defines no such flag and its `open` rejects the numeric flags, so there the `lstat` guard is the defense (`packages/coding-agent/src/memory.ts:159-165`).
- A refused or failed write throws. The REPL shows the error instead of reporting the note as saved (`packages/coding-agent/src/memory.ts:119-127`, `packages/coding-agent/src/interactive.ts:2124-2126`).
- The re-read uses the same gated loader as startup, so a note cannot make an untrusted project memory file enter the prompt (`packages/coding-agent/src/interactive.ts:2113-2119`).
- The live swap is `sessionRef?.setSystemPrompt(buildPrompt(memoryText))`. The note reaches the next request, not the next process, and a subagent spawned after it reads the same value (`packages/coding-agent/src/interactive.ts:2119-2123`, `:755-759`).
- The shortcut exists in the REPL only. A `-p` run loads memory once (`packages/coding-agent/src/headless.ts:520`). An ACP session loads it once (`packages/coding-agent/src/acp.ts:1101`).
- `/memory` accepts `rules`, `project`, or no argument. Any other argument prints the usage line (`packages/coding-agent/src/interactive.ts:4083-4088`).
- With no argument, `/memory` opens `~/.labunbun/MEMORY.md` and creates it with a `# Memory` header when it is missing (`packages/coding-agent/src/interactive.ts:4120-4124`).
- `/memory rules` opens `~/.labunbun/rules/` and creates the directory when it is missing (`packages/coding-agent/src/interactive.ts:4098-4102`).
- `/memory project` opens the nearest project file that is in the prompt. `lastProjectMemoryFile` scans the loaded list from the end and skips the user MEMORY.md and the user rules directory (`packages/coding-agent/src/interactive.ts:2746-2764`, `:4103-4104`).
- When no project file is loaded, `/memory project` gives one of two messages. With withheld files it names the count and says `/agents approve, then restart`. With none it says no file was found and points at `/init` (`packages/coding-agent/src/interactive.ts:4105-4112`).
- The editor is `$VISUAL` first, then `$EDITOR`. The command string is split on whitespace, so `EDITOR="code -w"` works (`packages/coding-agent/src/interactive.ts:2715-2718`).
- A missing target is created only after an editor resolves, so a typo in the editor variable cannot leave files behind (`packages/coding-agent/src/interactive.ts:2695-2704`, `:2721-2728`).
- The editor starts detached with `stdio: "ignore"`, and the parent does not wait for it. That is what lets the REPL continue while the editor is open (`packages/coding-agent/src/interactive.ts:2734-2739`).
- Without an editor, `/memory` prints the path it would have opened. For the bare and `rules` forms it also prints the loaded memory files (`packages/coding-agent/src/interactive.ts:4135-4144`).

## Subagent context

- A subagent gets its role definition, then `buildSubagentContext` (`packages/coding-agent/src/interactive.ts:1166-1185`, `packages/coding-agent/src/headless.ts:618-636`).
- `buildSubagentContext` returns three things in order: the environment section, the memory section, and the skill discovery block. Empty sections are left out (`packages/coding-agent/src/system-prompt.ts:176-193`).
- The type it reads is a subset of the main prompt context: cwd, platform, terminal flag, clock, memory, and skills (`packages/coding-agent/src/system-prompt.ts:173-174`).
- It does not include `# Attitude`, `# Context`, `# Doing tasks`, `# Communication`, `# Tool guidance`, the language line, or the output style (`packages/coding-agent/src/system-prompt.ts:183-187`).
- A subagent's output is a report to the parent. A voice instruction belongs to the parent session, not to every worker it spawns (`packages/coding-agent/src/system-prompt.ts:185-187`).
- The REPL reads memory through the live value, so a `#` note appended before a spawn reaches that subagent. The style and language are still absent (`packages/coding-agent/src/interactive.ts:1166-1172`).

## Output styles

- Styles are `*.md` files in `~/.labunbun/output-styles/` and, once trusted, `<cwd>/.labunbun/output-styles/` (`packages/coding-agent/src/output-styles.ts:1-5`, `:62-66`).
- Only regular `.md` files are styles. Directory entries are sorted by name, and the file name minus `.md` is the style name (`packages/coding-agent/src/output-styles.ts:36-42`).
- A file that disappears between the listing and the read is skipped. An unreadable directory counts as an empty one. A broken style does not fail the other styles (`packages/coding-agent/src/output-styles.ts:47-54`).
- The user directory always loads. The project directory loads only when the ledger has kind `styles` for this cwd (`packages/coding-agent/src/output-styles.ts:62-66`).
- A project style overrides a user style with the same name. The merge is a map keyed by name, with the project list written last (`packages/coding-agent/src/output-styles.ts:67-70`).
- `settings.outputStyle` selects one loaded style by name (`packages/coding-agent/src/settings.ts:163-170`). `resolveOutputStyle` returns the match, or `undefined` when the name matches nothing (`packages/coding-agent/src/output-styles.ts:73-84`).
- An unknown name is soft-failure. The session runs without a style section, and no error stops it (`packages/coding-agent/src/output-styles.ts:73-79`, `packages/coding-agent/src/system-prompt.ts:158-161`).
- `/doctor` reports the selection in an `Output style` row. With no name the row says `none selected`. With a match it names the source and the path. With no match it warns and lists the loaded names (`packages/coding-agent/src/doctor.ts:193-227`, `:204-225`).
- The selected body becomes an added `# Output style` section between memory and skills. The coding instructions above it are not removed (`packages/coding-agent/src/system-prompt.ts:153-161`, `:60-68`).
- The selection itself is denied to project settings. A repository can ship style files behind the trust gate, but only the user's own settings can name the active style (`packages/coding-agent/src/settings.ts:470-476`).
- `settings.language` is a free-text string (`packages/coding-agent/src/settings.ts:155-162`). The prompt uses it verbatim as `Answer in <language>.`, in place of the generic language line (`packages/coding-agent/src/system-prompt.ts:128-129`, `:51-59`).
- The language setting is also denied to project settings (`packages/coding-agent/src/settings.ts:470-476`).

## Why

- **Why the trust gate covers the whole memory walk.** Every memory file reaches the prompt as if the user had written it. A repository that could write prompt text on clone would change what the model is told to do with no user action (`packages/coding-agent/src/project-trust.ts:1-14`). The gate is per directory because the decision is about this checkout, and it covers ancestors because a file one level up is still on the walk (`packages/coding-agent/src/memory.ts:23-29`).
- **Why an unknown style name does not fail.** A typo must not stop a session. The session runs without the section, and `/doctor` is where the typo becomes visible (`packages/coding-agent/src/output-styles.ts:73-79`, `packages/coding-agent/src/doctor.ts:193-196`).
- **Why the budget is spent in priority order, not render order.** An oversized guide in an ancestor must not evict the guide for the directory the session is working in. The render order still puts the nearest file last, so the model reads it closest to the conversation (`packages/coding-agent/src/memory.ts:12-21`).
- **Why a project style overrides a user style.** The project is what makes a project style useful: the same name can mean the checkout's own voice. The trust gate is what keeps that override from happening silently (`packages/coding-agent/src/output-styles.ts:7-13`).
- **Why a note updates the prompt at once.** The REPL tells the user the note was remembered. A prompt that only changed after a restart would make that a claim about the next process, not the next request (`packages/coding-agent/src/interactive.ts:2113-2116`).
- **Why the append refuses symlinks.** A `MEMORY.md` or `.labunbun` swapped for a link would make the shortcut write wherever the link points, with the content of the user's note. The `lstat` guard and `O_NOFOLLOW` keep the write inside the home directory (`packages/coding-agent/src/memory.ts:119-127`).

## Source map

| File | Role |
| --- | --- |
| `packages/coding-agent/src/memory.ts` | The two tiers, the cwd-to-root walk, `@include` expansion, the 40000-character selection, the truncation note, the trust-aware loader, the withheld list, and the `#` append. |
| `packages/coding-agent/src/output-styles.ts` | The user and project style directories, the trust gate, the name merge, and `resolveOutputStyle`. |
| `packages/coding-agent/src/system-prompt.ts` | The `# Project memory` and `# Output style` sections, the language line, and `buildSubagentContext`. |
| `packages/coding-agent/src/interactive.ts` | The REPL startup load, the `#` handler and live prompt swap, `openInEditor`, `lastProjectMemoryFile`, `/memory`, and `/agents approve`. |
| `packages/coding-agent/src/headless.ts` | One memory load per `-p` run, the subagent context, and the withheld notice on stderr. |
| `packages/coding-agent/src/acp.ts` | One memory load per editor session, and the same prompt sections. |
| `packages/coding-agent/src/settings.ts` | The `language` and `outputStyle` schemas, and the policy that denies both to project settings. |
| `packages/coding-agent/src/doctor.ts` | The `Output style` row, including the warning for an unknown name. |
| `packages/coding-agent/src/project-trust.ts` | The per-directory trust ledger, the four kinds, and the withheld-notice wording. |
