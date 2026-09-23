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
  threshold (structured summary + re-injected recent files), with the cheap rung
  running first: at the threshold the older tool results become previews (no
  model call, full text still in the session file) and a summarization is only
  paid for if that did not free enough — `trimOldToolResults: false` skips
  straight to the summary, `/trim` does the same rewrite on request. `/context`
  for what the window is made of, and a live indicator measured against the
  compaction point — system prompt and tool schemas included, so it reads as full
  when the session is.
- **Prompt caching** — explicit breakpoints on Anthropic (tools, system, the
  previous turn's tail, this turn's tail) and the routing and retention knobs on
  OpenAI-compatible endpoints; `/cache` reports the hit rate, the ceiling this
  conversation can reach, and any rewrite of the prefix nobody declared.
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
- **DualShock 4** — drive the whole REPL from a controller: navigate lists and
  dialogs, confirm and cancel, approve or deny a permission, interrupt a turn,
  open the command wheel, scroll the transcript, tap and swipe the touchpad, and
  type with an on-screen keyboard without touching the keyboard. The lightbar
  follows the theme and what the app is doing, a small vocabulary of buzzes says
  what changed without looking, and the battery sits in the status line. Bindings
  are yours to change, and the motors and the light can each be switched off —
  see [Gamepad](#gamepad).
- **Headless output** — `--output-format text|json|stream-json`.
- **Config import** — `labunbun migrate` maps an existing agent-tool setup
  (Claude Code, Codex, ZCode, DeepSeek Harness, `~/.agents`) onto
  labunbun's own config: settings, skills, rules, slash commands, past
  conversations and the prompts ↑ recalls. Dry run by default, and a `/migrate`
  wizard that asks what to take — or takes everything after one question.

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
bun run dev migrate --from codex       # one source: claude-code | codex | zcode | agents | deepseek-harness | all
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
background color (OSC 11, then `COLORFGBG`) and picks the theme that states that
appearance — one of yours if any of them does, the matching built-in otherwise.
Detection never blocks startup: a terminal that does not answer gets `dark`.

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

## Gamepad

A DualShock 4 (USB or Bluetooth) can drive the REPL on its own — no keyboard
needed to answer a permission, pick a model, or type a prompt.

```bash
/gamepad on        # read a controller now, and remember it
/gamepad status    # transport, battery, reports, last write, which bindings you changed
/gamepad watch     # every change as a line: press a button, read its name
/gamepad list      # every controller interface the OS reports
/gamepad reset     # let go of it and look again, now — the rescue for a stuck pad
/gamepad approve   # may ✕ answer a permission dialog? (on|off, no argument toggles)
/gamepad rumble    # buzz once — the quickest check that writing works
/gamepad           # the current button and gesture → action table
```

`--gamepad` turns it on for one run without writing anything; `--no-gamepad`
turns it off the same way.

| Button | Action |
|--------|--------|
| D-pad, left stick | Move: lists, dialogs, the command wheel, the transcript |
| Right stick (vertical) | Scroll the transcript, speed with the offset |
| L2 / R2 | Modifiers, not rebindable: fine (160 ms) and fast (30 ms) repeats |
| ✕ | Confirm — send, allow, choose. Held 600 ms in a permission dialog: *always* allow |
| ○ | Cancel — close, deny, and interrupt a running turn |
| □ | Clear the screen; backspace in the on-screen keyboard |
| △ | Command wheel; shift in the on-screen keyboard |
| L1 / R1 | Page back / forward in lists, the transcript, and the keyboard |
| Options | Transcript browser |
| Share | On-screen keyboard |
| Touchpad press | `/status` |
| L3 / R3 | Open `/model` / pick the permission mode |
| PS | Nothing on purpose — the OS and Steam claim it |

Movement repeats: 400 ms before the first repeat, then every 80 ms, or at the
L2/R2 rates above. Battery appears in the status line while a pad is connected,
and the lightbar takes the theme's accent — brighter while a turn is running,
flashing in the permission colour while a dialog is waiting, red when the
battery is low.

A waiting dialog also *blinks*: half a second on, half a second off, in the pad's
own hardware. The software pulse only dims the bar, and a bar that dims is one
you can miss from the sofa — which is the one thing a question must not be. It
is the only state that asks for a blink: the battery warning already reaches
black on its own, and two rhythms over one light is a flicker.

The motors have a small vocabulary, and it is a sentence each rather than a
volume:

| Felt | Meaning |
|------|---------|
| One short tap | A controller was found |
| A firmer tap | Work started |
| A long, deep note | The turn finished |
| Two quick taps | You stopped it yourself |
| The faintest tap | A no from the pad: ○ on a dialog, or ✕ where it may not approve |
| A hard kick, both motors | Something wants a decision |
| Both motors, gently | The battery just crossed into the low band |

Two of those are felt even if something else buzzed a moment earlier — a
question, and the battery crossing — because each happens once, and the one that
is dropped is the one that mattered. Everything else waits its turn: two buzzes
a moment apart read as one stutter, not as two pieces of news.

### The touch surface

The touchpad is a second input and not a mouse: a finger on it is a position and
a gesture, never a cursor.

| Gesture | Action |
|---------|--------|
| Tap | Confirm, exactly like ✕ |
| Drag | Move — one step per eighth of the surface, in the direction the finger goes |
| Two-finger slide | Page back / forward in lists and the transcript |

They are bindings like any other, under the names `/gamepad` prints:
`touch-tap`, `touch-up`, `touch-down`, `touch-left`, `touch-right`,
`touch-two-left`, `touch-two-right`.

A tap confirms but never *holds*. The ✕-hold is a real thing — a permission
dialog reads 600 ms of ✕ as "always allow" — and a gesture lasts exactly one
report, so the only way one could ever reach that threshold is the reports
stopping: a pad that went to sleep with a finger resting on it. A controller in
a bag must not be able to answer a dialog on its own, so gestures are edges by
construction and buttons keep the hold. `allowApprove` governs the tap in a
permission dialog exactly as it governs ✕.

Buttons keep the hold on the same principle, measured the same way: 600 ms of
the pad *reporting* ✕ down, not 600 ms of wall clock. A controller that idles
out mid-press and comes back with the button still under a thumb spent that
time saying nothing, so the time is not credited — the press keeps its true age,
which is what a dialog reads to ask whether it was aimed at it. Nothing is
invented on the way back either: the button is neither pressed again nor
released, the hold simply starts over. A silence here means a quarter of a
second with nothing from the pad (`REPORT_GAP_MS` in
`packages/gamepad/src/service.ts`) — dozens of reports at the rate a live DS4
sends them, and an eighth of the two seconds after which the pad is declared
gone and everything is forgotten.

The thresholds — 250 ms and a few surface units for a tap, an eighth of the
height for a step — are constants in `packages/gamepad/src/touch.ts`, named so
that tuning the feel is editing one number.

A controller that is plugged in *and* switched on is attached twice: the OS
lists two collections of one pad, and nothing on either says they belong
together. Both are opened and both are written to in their own shape — 32 bytes
over the wire, 78 with a CRC over the radio — so the bar and the motors work
whichever link the pad is obeying. `/gamepad status` says so:

```
  transport: usb
  links: usb + bluetooth (reading usb)
```

Buttons are read from one link at a time, the wire first, and the reading moves
to the other link when that one goes quiet. That is what makes the cable a
non-event in both directions: pull it and the radio takes over mid-press without
inventing a release; plug it in mid-session and the new link is picked up within
a second and written to from the next frame.

Two controllers switched on at once look exactly like this, because nothing on
either collection says which device it belongs to: two links, one of them read
and both of them written to. A ✕ on the pad in the bag then moves the session
the moment the one in your hands stops reporting, and the bag's bar follows the
screen. There is no identity to sort them by, so nothing is sorted — but a whole
second of the two links reporting *different* buttons (one pad's links are a few
milliseconds apart at an edge, never more) is worth saying out loud:

```
  both links report — these may be two controllers (pin one with the device filter)
```

The filter is the way out: `"device": "wireless"`, or a path from `/gamepad
list`, leaves the other collection alone.

Bindings, the device filter and the deadzone live in `settings.json`:

```json
{
  "gamepad": {
    "enabled": true,
    "deadzone": 0.25,
    "device": "wireless",
    "rumble": true,
    "lightbar": true,
    "bindings": { "cross": "confirm", "r2": "command:/status", "square": "none" },
    "phrases": ["explain what you just did", "run the tests"]
  }
}
```

`rumble` and `lightbar` default to on, and either can be turned off for someone
who does not want a controller that moves or glows on its own. Off is *silence
and darkness* rather than less of them: a packet describes the whole pad, so a
field left out is a field written as zero. The motors stay still, the bar goes
dark, and `/gamepad status` says which of the two is off — as does
`/gamepad rumble`, which is the one check that needs no screen and would
otherwise buzz into the void.

`/gamepad` with no argument prints the button ids and the surface's gestures,
which are the names this file writes. A binding that names a button, a gesture,
an action or a command that does not exist costs that one binding and is
reported at startup and in `/doctor` — the rest of the file is unaffected.

**Approving from the pad is off unless you say otherwise.** `allowApprove` is a
user-tier setting: a project's `.labunbun/settings.json` cannot set `gamepad` at
all, because a button held down in a pocket is not a person deciding, and a
cloned repository must not be able to hand its own tool calls to a controller
lying in your lap. With it off, ✕ does nothing in a permission dialog and the
keyboard answers; the pad still navigates.

`node-hid` is an *optional* dependency. Without it the rest of labunbun is
exactly as it was; `/gamepad on` reports which command installs it. When it *is*
installed, `pnpm bin:build` carries it along: `bun build --compile` embeds the
native prebuild, and the resulting executable reads a controller with no
`node_modules` next to it. (Verified against node-hid 3.4.0 on Windows; nothing
needs `--external`.)

## Prompt caching

Providers bill a prompt in two parts: what they can serve from a cache and what
they have to read again. The cache is keyed on a **prefix**, so the only way to
hit it is to send the same bytes in the same order as last time and to let the
conversation grow by appending. `/cache` prints what that came to:

```
Prompt cache — anthropic/claude-opus-5
  requests     241 request(s) (0 re-asked, 0 not answered)
  tokens       2.87M read · 41.2k written (41.2k 5m · 0 1h) · 0 full price · 18.9k out
  hit rate     98.6% read · ceiling 98.6% for this shape (100.0% of what is reachable)
  prefix       1 extension · 1 cold start · 0 rewinds
  capability   explicit breakpoints · min 512 tokens · TTL 5m or 1h
```

**Two numbers, not one.** The hit rate is `Σ cacheRead / Σ promptTotal` — the
share of everything sent that was served from cache. The ceiling is
`Σ P[t-1] / Σ P[t]`: a request can only read what an earlier request wrote, so
the best any sequence of prompts can do is bounded by how fast the prompt grows.
A conversation that ends at 200k tokens after a hundred turns has a ceiling
around 98%, and no implementation can beat it — the last turn's prompt was never
written by anyone. So the number to read is *both*: a session at its ceiling is
doing everything the provider allows, and a session below it is losing tokens to
something specific. The report prints them side by side for that reason, and
`/cache` names the causes — a cold start, a TTL that expired, a rewrite the app
made on purpose (compaction, `/trim`, `/fork`, an approved MCP server appending
tools), or a **rewind nobody declared**, which is a bug in the shape of the
prefix rather than a cost of the work.

**What each provider gets.** Anthropic takes explicit `cache_control`
breakpoints, and the adapter places up to four: the last tool definition, the
system prompt, the message where the *previous* request ended, and the last
message of this one. Each is only placed if its prefix clears the model's
documented minimum (512 tokens on Opus, 1024 on Sonnet, 4096 on Haiku 4.5), so a
short conversation is not littered with markers the provider would ignore. The
breakpoint on the previous turn's tail is what carries a prefix across a turn
that answers twelve tools at once — a vendor's own look-back reaches twenty
blocks, and that turn puts twenty-four of them between two requests.
OpenAI-compatible endpoints cache automatically and take no breakpoints;
`prompt_cache_key` is sent only where the provider documents it (or where
`cache.promptCacheKey` says `on`), derived from the stable prefix — system
prompt, tools, model, wire format — so the same conversation resumes onto the
same cache, and a key that moved per turn would route every turn somewhere else.

**Settings** are user-tier only, because caching is not something a cloned
repository should be able to change:

```json
{ "cache": { "enabled": true, "ttl": "auto", "promptCacheKey": "auto" } }
```

`ttl: "auto"` asks for the one-hour TTL and falls back down a ladder — 1h, then
5m, then no `ttl` field at all — one failed request per rung, once per process,
each downgrade named in `/cache`. Only the affected requests are retried; a 400
that is not about cache settings propagates as the error it is.

**What the hit rate does not promise.** The number `/cache` prints is what the
provider reported, and nothing here can make a vendor's cache behave as its
documentation claims. The end-to-end tests in `packages/agent/test/
cache-hit-rate.test.ts` run the real adapters, the real client stack and the
real agent loop against a local endpoint implementing the documented rules
(`packages/ai/test/cache-stub-server.ts`) — that measures the machinery, not a
vendor, and a real number comes from `/cache` after a real session.

## Project layout

| Package | Purpose |
|---------|---------|
| `@labunbun/ai` | Provider-neutral message model, streaming protocol, Anthropic/OpenAI-compat adapters, retry, faux test provider |
| `@labunbun/agent` | Agent loop, Tool interface, execution pipeline, permission engine, JSONL session tree, compaction |
| `@labunbun/tools` | Built-in coding tools behind an FS/exec operations abstraction |
| `@labunbun/mcp` | MCP client (stdio/HTTP), tool adaptation |
| `@labunbun/tui` | React Ink REPL: store, message views, editor, dialogs, themes |
| `@labunbun/gamepad` | DualShock 4: report parsing, button mapping, lightbar and rumble rules, the device source (`node-hid`, optional) |
| `@labunbun/coding-agent` | CLI entry, settings hierarchy, commands, memory, hooks, subagents, skills |

Dependency direction is strictly layered: `ai ← agent ← tools/mcp/tui ← coding-agent`.
`gamepad` is a leaf with no runtime dependency at all — `tui` takes its types and
pure functions, and `coding-agent` owns the single place `node-hid` is imported.
The loop never imports provider adapters directly — they arrive via injected
`StreamFn`, which is what makes the zero-network faux-provider test strategy work.

## Development

```bash
pnpm typecheck        # tsc over all packages (source-mapped, no build step)
pnpm test             # bun test — 2000+ tests, no network needed
pnpm lint             # biome check
bun run scripts/smoke.ts anthropic/claude-sonnet-5   # live smoke test
bun run packages/coding-agent/scripts/cache-check.ts anthropic/claude-opus-5 6   # live hit rate (costs money)
bun run scripts/gamepad-probe.ts                     # a controller, without the app in the way
bun run scripts/gamepad-probe.ts --touch             # measure the touchpad: decoded points + raw bytes
pnpm bin:build        # standalone executable via bun build --compile
```

TypeScript runs in erasable-syntax-only mode and packages export their `src/`
directly — Bun executes TS natively, so there is no build step in the dev loop.

### Configuration roots

- User: `~/.labunbun/` — `settings.json`, `.mcp.json`, `MEMORY.md`, `rules/*.md`,
  `agents/`, `skills/`, `themes/`, plus `projects/<cwd>/` for that project's
  sessions, MCP approvals, and the definition trust above
- Project: `.labunbun/` — `settings.json`, `settings.local.json`,
  `rules/*.md`, `agents/`, `skills/`, `themes/`
- Project and local settings are read as **repo-controlled**: they may not set
  `model`, `fallbackModels`, `permissionMode`, `env`, `providers`, `hooks`,
  `mcpServers`, `pricing`, `trimOldToolResults`, `gamepad`, `permissions.allow`,
  or `permissions.additionalDirectories`.
  Those are honored from the user, policy (`managed-settings.json`), and
  `--settings` tiers only; anything dropped is listed at startup. `permissions.deny`
  is still honored from every tier — tightening is always allowed. Whether
  `settings.local.json` is committed is up to you; labunbun writes no ignore
  rule for it.
- A project's own `agents/` and `skills/` are read the same way, and load only
  after one approval per directory (`/agents` lists them, `/agents approve`
  loads them). The decision is remembered under `~/.labunbun/projects/<cwd>/`,
  never in the repository, so a cloned repo cannot ship its own approval; a
  `-p` run has no dialog, so an untrusted project's definitions are simply not
  loaded and it says so on stderr.
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
