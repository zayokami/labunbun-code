# LaBunbun Code 🐰

A terminal-native AI coding agent built with **Bun** and **pnpm**.

```
labunbun -p "fix the failing tests"     # headless: one prompt, print result
labunbun                                # interactive REPL
```

## Features

- **Multi-provider LLM support** — Anthropic plus any OpenAI-compatible API
  (DeepSeek, Kimi, GLM, OpenRouter, custom endpoints) via settings.
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
  threshold (structured summary + re-injected recent files), microcompaction,
  live context-remaining indicator.
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
- **Terminal UX** — virtualized transcript (sealed history + live tail),
  ctrl+O full-transcript browser, vim modal editing (`vimMode: true`),
  token-based dark/light themes.
- **Headless output** — `--output-format text|json|stream-json`.
- **Config import** — `labunbun migrate` maps an existing agent-tool setup
  (`--from claude-code|codex`) onto labunbun's own config; dry run by default.

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
        "models": [{ "id": "my-model", "contextWindow": 128000, "maxOutputTokens": 8192 }]
      }
    ]
  }
}
```

### Import an existing setup

Already configured another agent tool? Copy over what has an equivalent:

```bash
bun run dev migrate                    # dry run: report only, writes nothing
bun run dev migrate --from codex       # one source (claude-code | codex | all)
bun run dev migrate --apply            # write it
bun run dev migrate --apply --force    # also overwrite values that exist
```

Sources are only read, never modified. Model names, `env`, MCP servers, skills
and rules carry over; anything without an equivalent is reported as skipped with
a reason rather than dropped silently, and existing values are kept unless
`--force` says otherwise. The report names every written file that ends up
holding a credential. `/migrate` does the same from inside the REPL.

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
pnpm test             # bun test — 330+ tests, no network needed
pnpm lint             # biome check
bun run scripts/smoke.ts anthropic/claude-sonnet-5   # live smoke test
pnpm bin:build        # standalone executable via bun build --compile
```

TypeScript runs in erasable-syntax-only mode and packages export their `src/`
directly — Bun executes TS natively, so there is no build step in the dev loop.

### Configuration roots

- User: `~/.labunbun/` — `settings.json`, `.mcp.json`, `MEMORY.md`, `rules/*.md`,
  `agents/`, `skills/`
- Project: `.labunbun/` — `settings.json`, `settings.local.json` (gitignored),
  `rules/*.md`, `agents/`, `skills/`
- Memory files: `LABUNBUN.md` or `AGENTS.md` per directory, walked cwd → root
- Base URLs are overridable per provider via `<PROVIDER>_BASE_URL`, e.g.
  `ANTHROPIC_BASE_URL` for a gateway or proxy

## Sponsor

If LaBunbun Code saves you time, consider supporting development:

| Network | Address |
|---------|---------|
| **BTC** | `bc1qv9zhpzzdddyakzsetgwr4tkznl4ycsuxn7d00g` |
| **ETH** | `0x8dFB632F494C694a1a0Ff4CC2566617230530020` |
| **SOL** | `AdryGzPCKyH5PPzEmZ9ZxW77A5kCbBuapmrqeYFGcPna` |

## License

MIT © 2026 zayoka — see [LICENSE](./LICENSE).
