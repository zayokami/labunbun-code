# LaBunbun Code 🐰

A terminal-native AI coding agent built with **Bun** and **pnpm**.

```
labunbun -p "fix the failing tests"     # headless: one prompt, print result
labunbun                                # interactive REPL
```

## Features

- **Multi-provider LLM support** — Anthropic, OpenAI, Google and any
  OpenAI-compatible API (DeepSeek, Kimi, GLM, OpenRouter, custom endpoints) via
  settings; the startup probe asks each provider holding a key what it serves and
  corrects the catalog from the answer.
- **Core coding tools** — Bash (incl. `run_in_background` with BashOutput /
  KillBash), Read, Write, Edit (exact string replace with diff preview),
  Grep, Glob, LS, WebFetch, WebSearch; parallel execution of safe tools,
  started mid-stream as soon as their arguments finish arriving.
- **Task list** — TaskCreate/TaskList/TaskGet/TaskUpdate let the agent plan
  and track multi-step work; progress renders in the REPL.
- **Interactive dialogs** — permission approvals plus structured
  AskUserQuestion multiple-choice prompts.
- **Permission system** — rule engine (`Bash(git *)`, `Edit(src/**)`,
  `mcp__server__*`), five permission modes, interactive approval dialog,
  "don't ask again" session rules.
- **Sessions** — append-only JSONL tree per project (`~/.labunbun/projects/`),
  crash-safe resume with `--resume`, prompt history with ↑ recall.
- **Context management** — automatic compaction at the context-window
  threshold (structured summary + re-injected recent files), `/trim` to replace
  old tool results with previews before paying for a summary (`trimOldToolResults`
  does the same ahead of the threshold), `/context` for what the window is made
  of, and a live indicator measured against the compaction point — system prompt
  and tool schemas included, so it reads as full when the session is.
- **Hooks** — user-configurable `PreToolUse` / `PostToolUse` / `Stop` /
  `SessionStart` … command hooks with a JSON stdin/stdout contract.
- **MCP client** — stdio + StreamableHTTP servers from `.mcp.json`; tools merge
  into the registry as `mcp__server__tool`.
- **Subagents** — the Task tool runs nested agent sessions (sidechain
  transcripts persisted); custom agents via frontmatter `.md` files.
- **Skills** — `SKILL.md` folders become prompt-expanding slash commands.
- **Plan mode** — read-only research then plan approval before mutations.
- **Model fallback chain** — `fallbackModels` in settings are tried in order
  when the primary model fails before streaming any content.
- **Cost** — the built-in catalog carries each model's list price, and `pricing`
  in settings overrides it (per `"provider/model"`, for any model, built-in or
  not). `/cost` reports the conversation you are in and the project it lives in
  as two separate totals, and names any model whose tokens it could not price
  rather than counting them as free. `-p --output-format json` reports the same
  arithmetic as `cost_usd`.
- **Terminal UX** — virtualized transcript (sealed history + live tail),
  ctrl+O full-transcript browser, vim modal editing (`vimMode: true`),
  eight token-based themes with `auto` background detection and third-party
  theme files.
- **Headless output** — `--output-format text|json|stream-json`.
- **Config import** — `labunbun migrate` maps an existing agent-tool setup
  (Claude Code, Codex, ZCode, `~/.agents`) onto labunbun's own config: settings,
  skills, rules, slash commands, past conversations and the prompts ↑ recalls.
  Dry run by default, and a `/migrate` wizard that asks what to take — or takes
  everything after one question.

## Quick start

```bash
pnpm install
export ANTHROPIC_API_KEY=sk-...        # or DEEPSEEK_API_KEY etc.
bun run dev                            # interactive REPL
bun run dev -p "list files here"       # headless
```

### Custom OpenAI-compatible provider

`~/.labunbun/settings.json`:

```json
{
  "model": "myprovider/my-model",
  "providers": {
    "openaiCompatible": [
      {
        "id": "myprovider",
        "baseUrl": "https://api.example.com/v1",
        "apiKeyEnv": "MYPROVIDER_API_KEY",
        "models": [
          {
            "id": "my-model",
            "contextWindow": 128000,
            "maxOutputTokens": 8192,
            "pricing": { "input": 0.6, "output": 2.2, "cacheRead": 0.11 }
          }
        ]
      }
    ]
  }
}
```

`pricing` is USD per million tokens (`cacheRead`/`cacheWrite` default to 0,
which is what an API that does not bill cached tokens separately means). A
top-level `pricing` map — `{ "anthropic/claude-sonnet-5": { "input": 1.5,
"output": 7.5 } }` — overrides the catalog's own list prices, which is how a
gateway or a negotiated rate gets costed correctly. Without a price, tokens are
counted and `/cost` says they could not be costed; it does not report them as
free.

### Import an existing setup

Already configured another agent tool? Copy over what has an equivalent:

```bash
bun run dev migrate                    # dry run: report only, writes nothing
bun run dev migrate --from codex       # one source (claude-code | codex | zcode | agents | all)
bun run dev migrate --only settings    # categories: settings | assets | history | all
bun run dev migrate --apply            # write it
bun run dev migrate --apply --force    # also overwrite values that exist
```

Sources are only read, never modified. Model names, `env`, MCP servers,
permission rules, skills, agents (`~/.labunbun/agents/`) and rules carry over,
and a skill directory travels whole — a body pointing at `references/x.md` finds
it on the other side, and the supporting files that could not come (binary, too
large) are counted in the report. Slash commands (`~/.claude/commands/**`)
arrive as skills with `$ARGUMENTS` expanded; a frontmatter key with no
equivalent here (`allowed-tools`, `model`, `argument-hint`) is named in the
report rather than written as if it worked. Codex's `~/.codex/rules/*.rules`
become permission rules — Codex matches a parsed argv prefix where labunbun
matches the whole command line, so a chained `git commit && …` matches here too.

Anything without an equivalent is reported as skipped with a reason rather than
dropped silently, keys the importer does not know included: they are listed by
name, never by value. Existing values are kept unless `--force` says otherwise.
The report names every written file that ends up holding a credential.

Past conversations import as sessions under `~/.labunbun/projects/<cwd>/`, so
`--continue` finds them, and the prompts you typed import into
`~/.labunbun/history.jsonl`, so ↑ recalls them in the directory each was typed
in. Both answer to the same scope: only the current project is taken by default
— `--history-scope all` goes across projects, `none` skips history entirely —
and `--history-limit <n>` (default 20) caps the sessions from each source, with
a separate cap for prompts. A tool call whose other half is missing is dropped
on the way in: a transcript the messages API would reject is worse than a
shorter one.

`/migrate` in the REPL asks rather than assumes. The first question offers
`Import everything` — every source found, every category — or `Choose…` for the
step-by-step questions; either way it asks once about history, prints the same
dry-run report, and writes only after you confirm. `--migrate` is the same
command as the subcommand, for when the flag is easier to type than the word.

## Themes

```bash
/theme                    # list every theme, marking the active one
/theme high-contrast-dark # switch immediately and remember the choice
/theme auto               # match the terminal background
```

| Name | For |
|------|-----|
| `dark` | default; follows the terminal's own palette |
| `light` | light backgrounds, where terminal-default colors wash out |
| `high-contrast-dark` | maximum contrast on dark, every state bold |
| `high-contrast-light` | maximum contrast on light, every state bold |
| `deuteranopia-dark` | red/green color blindness — success is blue, not green |
| `tritanopia-dark` | blue/yellow color blindness — avoids the blue/green pair |
| `spiderman` | red and blue |
| `splatoon` | green and magenta |

`theme` in `settings.json` selects one; `"auto"` asks the terminal for its
background color (OSC 11, then `COLORFGBG`) and picks `light` or `dark`. Detection
never blocks startup: a terminal that does not answer gets `dark`.

State is never carried by color alone. Success, warning, error, pending and the
selected row each render a symbol as well, so the transcript stays readable to a
colorblind reader and through anything that strips ANSI.

### Writing a theme

Drop a JSON file in `~/.labunbun/themes/` (or `.labunbun/themes/` for one
project, which wins on a name collision):

```json
{
  "name": "midnight",
  "appearance": "dark",
  "extends": "dark",
  "tokens": {
    "accent": "#7aa2f7",
    "error": "#f7768e",
    "codeText": "#9aa5ce",
    "marks": { "error": "×" }
  }
}
```

`extends` names a built-in that supplies every token the file leaves out, so a
theme that changes a handful of colors does not have to restate the two dozen it
is happy with. Values are anything Ink accepts: `"red"`, `"#d55e00"`,
`"rgb(215,95,0)"`.

The full token list is the `Theme` interface in
`packages/tui/src/themes/tokens.ts`, where each token documents what it colors.
A broken theme file never stops the REPL from starting; run `/doctor` to see
which file failed and why — including misspelled token names, which otherwise
just do nothing.

## Project layout

| Package | Purpose |
|---------|---------|
| `@labunbun/ai` | Provider-neutral message model, streaming protocol, Anthropic/OpenAI-compat adapters, retry, faux test provider |
| `@labunbun/agent` | Agent loop, Tool interface, execution pipeline, permission engine, JSONL session tree, compaction |
| `@labunbun/tools` | Built-in coding tools behind an FS/exec operations abstraction |
| `@labunbun/mcp` | MCP client (stdio/HTTP), tool adaptation |
| `@labunbun/tui` | React Ink REPL: store, message views, editor, dialogs, themes |
| `@labunbun/coding-agent` | CLI entry, settings hierarchy, commands, memory, hooks, subagents, skills |

Dependency direction is strictly layered: `ai ← agent ← tools/mcp/tui ← coding-agent`.
The loop never imports provider adapters directly — they arrive via injected
`StreamFn`, which is what makes the zero-network faux-provider test strategy work.

## Development

```bash
pnpm typecheck        # tsc over all packages (source-mapped, no build step)
pnpm test             # bun test — 400+ tests, no network needed
pnpm lint             # biome check
bun run scripts/smoke.ts anthropic/claude-sonnet-5   # live smoke test
pnpm bin:build        # standalone executable via bun build --compile
```

TypeScript runs in erasable-syntax-only mode and packages export their `src/`
directly — Bun executes TS natively, so there is no build step in the dev loop.

### Configuration roots

- User: `~/.labunbun/` — `settings.json`, `.mcp.json`, `MEMORY.md`, `rules/*.md`,
  `agents/`, `skills/`, `themes/`, plus `projects/<cwd>/` for that project's
  sessions and MCP approvals
- Project: `.labunbun/` — `settings.json`, `settings.local.json`,
  `rules/*.md`, `agents/`, `skills/`, `themes/`
- Project and local settings are read as **repo-controlled**: they may not set
  `model`, `fallbackModels`, `permissionMode`, `env`, `providers`, `hooks`,
  `mcpServers`, `pricing`, `trimOldToolResults`, `permissions.allow`, or
  `permissions.additionalDirectories`.
  Those are honored from the user, policy (`managed-settings.json`), and
  `--settings` tiers only; anything dropped is listed at startup. `permissions.deny`
  is still honored from every tier — tightening is always allowed. Whether
  `settings.local.json` is committed is up to you; labunbun writes no ignore
  rule for it.
- Memory files: `LABUNBUN.md` or `AGENTS.md` per directory, walked cwd → root
- Base URLs are overridable per provider via `<PROVIDER>_BASE_URL`, e.g.
  `ANTHROPIC_BASE_URL` for a gateway or proxy
- Inside the workspace, `.git/` is not writable by the agent — in any mode, and
  including a nested repository's own `.git` or a symlink that resolves into one.
  Rewriting history is not an edit the user can undo, so it is not something a
  permission can grant. Reading git metadata is unaffected (`git` runs as usual).

## Sponsor

If LaBunbun Code saves you time, consider supporting development:

| Network | Address |
|---------|---------|
| **BTC** | `bc1qv9zhpzzdddyakzsetgwr4tkznl4ycsuxn7d00g` |
| **ETH** | `0x8dFB632F494C694a1a0Ff4CC2566617230530020` |
| **SOL** | `AdryGzPCKyH5PPzEmZ9ZxW77A5kCbBuapmrqeYFGcPna` |

## License

MIT © 2026 zayoka — see [LICENSE](./LICENSE).
