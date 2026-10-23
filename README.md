# LaBunbun Code

[![CI](https://github.com/zayokami/labunbun-code/actions/workflows/ci.yml/badge.svg)](https://github.com/zayokami/labunbun-code/actions/workflows/ci.yml)

LaBunbun Code is a terminal coding agent.

```bash
labunbun                              # start the interactive session
labunbun -p "fix the failing tests"   # run one prompt, print the result
```

## Description

LaBunbun Code reads files, changes files, and runs commands. It sends your requests to one language model. The model calls the tools below to do the work.

### Tools

| Tool | Purpose |
|------|---------|
| `Bash` | Run a command. It also runs a command in the background. |
| `BashOutput` | Read the output of a background command. |
| `KillBash` | Stop a background command. |
| `Read` | Read a file. |
| `Write` | Write a new file. |
| `Edit` | Replace exact text in a file. The tool shows a diff first. |
| `Grep` | Search file content with a regular expression. |
| `Glob` | Find files with a name pattern. |
| `LS` | List the content of a directory. |
| `Digest` | Print the SHA-256 hash of the content of each named file. |
| `InspectSqlite` | Report the structure and sample rows of a SQLite database file. |
| `InspectArtifact` | Report the entries of a zip-family archive or an Electron ASAR without unpacking it. |
| `InspectBinary` | Report the format and structure of an executable or object file, and its embedded metadata (Go build info, Rust dependencies, Electron fuses, .NET managed metadata, including method call and field summaries). |
| `InspectSourceMap` | Report what a source map file holds, and whether its VLQ mappings decode. |
| `CompareArtifacts` | Compare two files, directories, zip-family archives, or ASAR archives by path and SHA-256 content, and list the differences. |
| `InspectWebCapture` | Report the records of an offline HAR 1.2 or Fiddler SAZ capture, with metadata and body hashes and no secret values. |
| `WebFetch` | Get one page from the network. |
| `WebSearch` | Search the network. |
| `TaskCreate` | Make a task. A task can name the tasks that block it. |
| `TaskList` | List the tasks. |
| `TaskGet` | Read one task. |
| `TaskUpdate` | Change the status, the owner, or the blockers of a task. |
| `Task` | Start a subagent. |
| `SendMessage` | Send a message to a subagent. |
| `TaskStop` | Stop a subagent. |

The agent runs the tools in parallel when the tools are safe to run in parallel. A tool starts as soon as its arguments arrive.

### Model providers

LaBunbun Code supports these providers:

- Anthropic
- OpenAI, on the Chat Completions wire and on the Responses wire
- Google
- Ollama, on a local daemon and on the Ollama cloud
- OpenAI-compatible endpoints, for example DeepSeek, Kimi, GLM, Mistral, OpenRouter

You add an OpenAI-compatible provider in the user settings file. See [Add a provider](#add-a-provider).

At startup the tool asks each provider that has an API key which models the provider serves. The local Ollama daemon needs no key, and the tool asks it as well. The tool then corrects the model catalog from the answer.

A model that the vendor serves on only one wire is on only that wire. A reseller can serve the same model on the other wire. The tool lists the model on its wire. The tool does not offer the model as a session model. Use `/model` to see the list.

You can use a Claude subscription in place of an Anthropic API key. Run `labunbun login`. The tool opens a browser for the sign-in. Use `/login` inside a session for the same flow. The tool stores the credential in the OS keychain. A machine with no keychain uses a private file under `~/.labunbun` instead, and the tool says so. A subscription outranks the `ANTHROPIC_API_KEY` variable. Use `labunbun logout` or `/logout` to remove the credential.

You can use a ChatGPT subscription for the ChatGPT models. Run `labunbun login chatgpt`. The tool opens a browser for the sign-in. If the local port is not available, the tool shows a device code instead, and you approve it in any browser. Use `/login chatgpt` inside a session for the same flow. The credential follows the same keychain-first rule as the Claude subscription, with the same private-file fallback. Use `labunbun logout chatgpt` or `/logout chatgpt` to remove the credential.

You can use a Gemini subscription for the Gemini models. Run `labunbun login gemini`. The tool opens a browser for the sign-in. If the local port is not available, the tool shows a web page address instead, and you paste the code the page shows. Use `/login gemini` inside a session for the same flow. The credential follows the same keychain-first rule as the Claude subscription, with the same private-file fallback. Use `labunbun logout gemini` or `/logout gemini` to remove the credential.

### Permission, sandbox, and network

LaBunbun Code has three independent axes. Each axis has its own values.

| Axis | Values |
|------|--------|
| Permission mode | `ask`, `plan`, `agent` |
| Sandbox | `workspace-write`, `danger-full-access` |
| Network | `enabled`, `restricted` |

The mode choices combine the first two axes.

| Mode | Permission mode | Sandbox |
|------|-----------------|---------|
| Ask | `ask` | `workspace-write` |
| Plan | `plan` | `workspace-write` |
| Agent | `agent` | `workspace-write` |
| Agent 无沙箱 | `agent` | `danger-full-access` |

Press Shift+Tab to go to the next mode.

**Permission rules.** A rule has the form `Bash(git *)` or `Edit(src/**)` or `mcp__server__*`. A dangerous-command classifier is above every mode. The tool asks you before it runs a tool that no rule permits. You can tell the tool not to ask again for the rest of the session.

**Approval diff.** When the tool asks about an `Edit` or a `Write`, the dialog shows the change as a diff. A removed line starts with `-`. An added line starts with `+`. The dialog shows at most 40 lines, and each line is cut at 240 characters. Press Ctrl+A to show the full input. Press Ctrl+A again to return to the diff. Every other tool keeps the one-line preview.

**Denial feedback.** The fourth answer opens a one-line field. Type a sentence and press Enter. The tool sends the sentence to the model as the reason for the denial. An empty field is a plain denial. Press Esc to return to the list. A controller sends the plain denial, because it cannot type.

**Questions.** A single-choice question has an `Other…` row. Select it and type the answer. Press Enter to submit a non-empty answer. Press Esc to return to the options. An empty field does not submit. A multi-choice question has no `Other…` row.

**Sandbox.** The OS enforces the sandbox on macOS with `sandbox-exec`. The OS enforces the sandbox on Linux with `bwrap`.

> **WARNING**: A Linux system without `bubblewrap` confines nothing.

> **WARNING**: On Windows, a shell command is confined by the kernel only when the container backend is selected. The tool selects it only after a real test: the session's own shell must start inside a live container. When the shell does not start, every Bash command runs with no kernel boundary, and only the tool-layer rules apply.

> **NOTE**: The test is the backend's own question. It grants the workspace and the machine's toolchain roots to a throwaway container profile, then runs the session's shell once. Measured answers: a `cmd.exe` session selects the backend. A Git-for-Windows (msys) shell does not, because its runtime dies inside the container at startup (`0xC0000142`). A toolchain root the user cannot rewrite the ACL of — an elevated `D:\Program Files`, measured — also does not. A `restricted` network axis does not either: the proxy listens on the loopback, and a container child cannot reach it. `/permissions` prints the answer and the reason. To have a Windows session select the backend, point the shell at `cmd.exe` with `LBB_BASH_PATH`.

> **NOTE**: When the backend is selected, the kernel refuses a write outside the roots the policy grants. The mode does not narrow reads — but a container child reads only what its token can reach: System32, the program directories the system drive already exposes to application packages, and the granted roots.

Inside the workspace, the agent cannot write to `.git/`. This rule applies in every mode. It also applies to a nested repository. It also applies to a symbolic link that refers to a `.git` directory. Reading git data is not restricted.

> **NOTE**: The OS backend also enforces this rule in the kernel. macOS denies the writes. Linux mounts `.git` as read-only. On Windows, a selected container backend narrows the container's access to `.git` to read and execute. The rule covers the files that are already inside `.git`.

**Network.** The network axis does not use the filesystem. The tool starts a local HTTP and SOCKS5 proxy. The tool points each command at this proxy. The proxy has a list of domains that it permits.

```jsonc
{ "networkAccess": "restricted", "networkDomains": ["registry.npmjs.org", { "domain": "*.internal", "action": "deny" }] }
```

The value `enabled` is the default. It starts no proxy. It restricts nothing. A string in `networkDomains` permits that domain. The object form denies a domain.

> **WARNING**: A program that does not read `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` is not restricted by the proxy.

> **NOTE**: MCP HTTP servers do not get the proxy. They also do not get the OS sandbox. Their traffic is the session process's own. Hooks and MCP stdio servers get both on macOS and Linux. On Windows they get the proxy variables only, because the container backend cannot wrap them yet. The `!` prompt prefix used to be one of these paths. It now runs through the permission engine under the same workspace policy as the Bash tool.

Only the user tier can set `networkAccess` and `networkDomains`. A repository must not set them. A repository that turns the network off makes `bun install` fail for every user who clones it.

**Web tools.** WebFetch and WebSearch work without a key. Two environment switches move one tool at a time to the paid DeepSeek APIs. Set `LBB_WEB_SEARCH=deepseek` for WebSearch, `LBB_WEB_FETCH=deepseek` for WebFetch, or both. Each tool then needs `DEEPSEEK_API_KEY`. Put the key in the shell environment or in `settings.json` under `env`. Each API costs ¥5 per 1000 successful requests. A request that fails or finds nothing is free. Each API allows 5 requests per second per account. A failed request is one attempt: the tool reports the error and does not retry or fall back. Unset the switch to return to the free path. The network axis covers both backends. Each tool checks the DeepSeek host before any request. The fetch backend checks the target URL against the session domain table too.

Use `/permissions` to see which of the three confinements you have. Use `/doctor` to see the full report.

### Session files

LaBunbun Code stores each session as a JSONL file. The files are in `~/.labunbun/projects/`. The tool appends to a file. It never rewrites one. The tool can reopen a session after a crash.

### Context window

The tool summarizes the conversation when the context window fills. The summary replaces the oldest messages. The tool adds the files from the recent turns again.

The tool first makes old tool results smaller. It replaces each old tool result with a short preview. This step makes no model call. The full text stays in the session file. The tool calls the model for a summary only if the first step did not free enough space.

With a spill writer, the tool writes the full text to disk first. The first line of the preview is `[full output: N chars → path]`. The session file still holds the original record.

The tool also runs the first step after one hour with no activity. The provider's cache is cold at that moment, so a smaller context costs nothing extra.

Set `trimOldToolResults: false` to skip the first step. Use `/trim` to run the first step on request. Use `/context` to see what the window contains. The indicator counts the system prompt and the tool schemas.

`/context` shows `Auto-compact` (`on`, `off (settings)`, or `paused after repeated failures`), `Hard limit`, and `Fixed (system + tools)`. The last row warns when the fixed part alone is over the hard limit.

The `compaction` settings change this behavior. Set `compaction.model` to choose the model that writes the summaries. Set `compaction.thresholdPercent` to compact at a percent of the window. Set `compaction.reserveTokens` to change the space that the trigger line keeps free. Set `compaction.enabled` to `false` to stop the automatic passes. The manual commands still work. `/autocompact` changes this setting from the prompt.

### Memory files

The tool reads memory from two tiers. The user tier is `~/.labunbun/MEMORY.md` and every `.md` file in `~/.labunbun/rules/`. The project tier is a walk from the working directory up to the root of the filesystem. At each directory the tool reads at most one of `LABUNBUN.md`, `AGENTS.md`, and `CLAUDE.md`, plus every `.md` file in `.labunbun/rules/`.

The files are rendered from the root to the working directory, so the nearest file is last. The user tier comes first. The 40000-character budget is spent in the other order: the user tier first, then the project files from the working directory outward. A file that does not fit contributes its first part. Every farther file is left out. A note at the end names the files that were partly or not loaded.

A memory file can include another file with a line of the form `@path`. The tool expands the include at that position. The included path must stay in the tree of the memory file where the include chain started. The tool reports a circular include, a missing include, and an include outside the tree.

The project tier is behind the trust gate. The tool reads no project memory file, from any directory of the walk, until you approve this project with `/agents approve`. The tool prints the number of held-back files at startup. Restart the session after the approval.

Type a line that starts with `#` to add a note to `~/.labunbun/MEMORY.md`. The tool appends the line, reads the memory files again, and updates the system prompt. The note applies from the next request, with no restart. This shortcut is in the terminal session only. A headless or ACP session reads the memory files once at startup.

Use `/memory` to open `~/.labunbun/MEMORY.md` in your editor. Use `/memory rules` to open the rules directory. Use `/memory project` to open the nearest loaded project file. The tool uses `$VISUAL`, then `$EDITOR`. Without an editor, the tool prints the paths. Edits made this way need a restart. A `#` note is the exception.

A subagent also receives the environment, the project memory, and the list of skills.

### Prompt cache

A provider bills a prompt in two parts. The first part comes from the cache. The second part the provider reads again. The cache uses the start of the prompt as its key. Only an exact match is a hit.

Use `/cache` to see the hit rate. The report also shows the ceiling for the conversation. The report also shows each rewrite of the start of the prompt that nobody declared. A rewrite is a defect.

LaBunbun Code sends explicit breakpoints to Anthropic. The tool sets a breakpoint on the last tool definition. The tool sets a breakpoint on the system prompt. The tool sets a breakpoint on the end of the previous turn. The tool sets a breakpoint on the end of the current turn. The tool sends a breakpoint only if the text before it is longer than the minimum for that model. The minimum is 512 tokens on Opus. The minimum is 1024 tokens on Sonnet. The minimum is 4096 tokens on Haiku 4.5.

OpenAI-compatible endpoints cache automatically. They accept no breakpoints.

```json
{ "cache": { "ttl": "auto", "promptCacheKey": "auto" } }
```

The value `auto` for `ttl` asks for the 1-hour lifetime. If the provider refuses it, the tool tries 5 minutes. If the provider refuses that, the tool sends no lifetime. Each failure costs one request. Each failure costs one request per process. `/cache` names each downgrade.

Only the user tier can set `cache`.

### Hooks

A hook is a command that the tool runs at a known time. The tool reads the hook list at startup.

```json
{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./check.sh", "timeout": 10000 }] }] } }
```

The hook events are:

- `PreToolUse`
- `PostToolUse`
- `UserPromptSubmit`
- `SessionStart`
- `SessionEnd`
- `Stop`
- `PreCompact`
- `PostCompact`
- `Notification`

`PreCompact` may veto a pass, including one that a provider refusal forced; a veto then ends the run. `PostCompact` runs after a pass in the REPL, `-p`, and ACP sessions. A compact pass waits for its listeners.

The maximum timeout is 600000 ms.

### MCP servers

LaBunbun Code reads MCP servers from `.mcp.json` and `~/.labunbun/.mcp.json`. It supports the stdio transport and the StreamableHTTP transport. Each tool name starts with `mcp__`, then the server name, then the tool name. Use `/mcp approve <name>` to approve a server in the project file.

The client listens for the list change notifications of a server. When the tool list changes, the session uses the new tools with no restart. Use `/mcp prompts <server>` to show the prompts of a server, and `/mcp prompt <server> <name> [key=value ...]` to render one. Use `/mcp resources <server>` to show its resources, and `/mcp resource <server> <uri>` to read one. The prompt and resource screens are for reading only. They never enter the conversation.

### Subagents

The `Task` tool starts a subagent. The tool keeps the conversation of a finished subagent in memory. Use `SendMessage` to continue it. Use `TaskStop` to stop it. Use `/subagents` to see the state and the age of each subagent. Use `/subagents stop <id>` to cancel one. Use `/subagents retry <id>` to run a failed one again. Use `/subagents log <id>` to read the conversation of one. Without an id, each verb shows a picker.

Subagents use the permission dialog of the session. The dialog shows the subagent name. The `/subagents` command shows the subagent as `waiting` while the question is open. The `/tasks` command shows the session, its subagents, and its background shells as one tree.

Put an agent definition in `~/.labunbun/agents/` or in `<project>/.labunbun/agents/`. The file name ends in `.md`. The file has a frontmatter block. The frontmatter key `name` gives the agent type. The frontmatter key `description` gives the text that the model reads. The frontmatter key `tools` gives a list of tool names. The frontmatter key `model` gives the model. The frontmatter key `maxTurns` gives a limit. The rest of the file is the system prompt of the subagent.

The prompt of a subagent holds the environment, the project memory, and the list of skills. It is not a copy of the main prompt. The subagent does not get the output style or the language line, because its output is a report to the parent session.

### The four-agent band

> **NOTE**: Read this section before you use the band. Each member uses your money on every request.

`/beetle <task>` starts four members:

| Member | Role | Tools |
|--------|------|-------|
| John | Lead | `Read`, `Grep`, `Glob`, `Bash` |
| Paul | Implementer | All tools |
| George | Research and verification | `Read`, `Grep`, `Glob`, `Bash` |
| Ringo | Build and run | `Read`, `Grep`, `Glob`, `Bash` |

Each member also has `BandMessage` and the four task tools.

> **NOTE**: The tool list is a structural guide. It is not a sandbox. A member can still change files through Bash.

The members send messages to each other. A message wakes the member that receives it. A band that has no message is not running. A band that has no message costs nothing. Only `/beetle off` stops a band.

The tool asks you for one model per member on the first run. The tool saves the four answers in `beetle.models`. Only the user tier can set `beetle`. Use `/beetle models` to change the answers later.

The `beetle` block can hold two budgets. Both keys are optional. `beetle.maxTurns` limits the turns in one run of a member. A run that needs more turns ends there. `beetle.maxCostUSD` stops the whole band when the total cost of the four members passes the amount. With no budget, a band runs until `/beetle off`. Only the user tier can set these keys. The cost of a member with no price does not count toward the total.

The `beetle` block can also hold `beetle.stallNoticeMinutes`. A live member that sends no event for this time gets one notice in the transcript. The notice tells you the last action of the member. The notice does not stop anything. The default is five minutes. The value `0` turns the notice off. Only the user tier can set this key.

The band writes a ledger to `~/.labunbun/beetle-state.json`. The ledger holds the last band and the totals of all bands. A new launch reads this file. If a process stops before `/beetle off`, the next start adds that band to the totals. `/beetle status` shows the last band when no band is on stage. The status also shows the lifetime totals.

Use these commands:

| Command | Purpose |
|---------|---------|
| `/beetle <task>` | Start a band, or start one more turn. |
| `/beetle status` | Show the members, their models, their turn counts, and their costs. |
| `/beetle models` | Choose the model for each member. |
| `/beetle say <member> <text>` | Send a message to one member. |
| `/beetle off` | Stop all four members. |

You can also send a message with `@john <text>`. This form works while the main session runs, too. If the band is off, the main session reads the line. After Esc stops the main session, the line goes to the main session.

The four members use the same working directory. `/rewind` does not restore the files that a member changed.

> **NOTE**: Press Esc to stop the main session. Esc does not stop the band. Use `/beetle off`.

### Skills

A skill is a directory that contains a `SKILL.md` file. The tool adds a command for each skill. The command name is `/skill-<name>`.

Put a skill in `~/.labunbun/skills/` or in `<project>/.labunbun/skills/`.

### Plan mode

Plan mode reads the code first. Plan mode does not change files. The tool then shows you a plan for review.

The plan dialog has three answers: approve the plan, keep planning, or send feedback to the planner. Feedback goes back to the model, and the model can submit a revised plan.

An approved plan is saved in the session. Run `/plan` to read it again: the state, the steps, and the full text.

The plan can carry ordered steps. When you approve the plan, each step becomes a pending task on the task board. A step with the subject of an unfinished task is not added again. The tool tells the model how many tasks it made.

The task board is saved in the session file. It survives a restart, a resume, and a compaction. Run `/todo` to show every task with its status, owner, blockers, and description.

The tool reminds the model about the task board: once at startup, after 10 turns without a board change, and after 10 turns in plan mode. A run that used the board and ends with a task in progress gets one reminder, and a session gets at most three. Set `LBB_TASK_REMINDER=off` to turn these reminders off.

Plan mode is interactive. A headless run and an editor session have no plan tools and no review dialog. An editor session can select the `plan` permission mode, which only refuses changes.

The tool restores the two axes that were in force before you entered plan mode.

### Themes

```bash
/theme                    # list the themes, and mark the current one
/theme high-contrast-dark # change the theme now, and remember it
/theme auto               # match the background of your terminal
```

| Name | Use |
|------|-----|
| `dark` | The default. It follows the palette of your terminal. |
| `light` | Light backgrounds. |
| `high-contrast-dark` | Maximum contrast on dark. |
| `high-contrast-light` | Maximum contrast on light. |
| `deuteranopia-dark` | Red and green color blindness. Success is blue. |
| `tritanopia-dark` | Blue and yellow color blindness. |
| `spiderman` | Red and blue. |
| `splatoon` | Green and magenta. |

The key `theme` in the settings file selects a theme. The value `auto` asks your terminal for its background color. The tool asks for the OSC 11 color first. The tool then asks for `COLORFGBG`. A terminal that does not answer uses `dark`.

The tool shows a symbol for each state. Success, warning, error, pending, and the selected row each have a symbol. The transcript is readable without color.

#### Write a theme

Put a JSON file in `~/.labunbun/themes/`. Put it in `<project>/.labunbun/themes/` for one project. The project file wins when the two files have the same name.

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

The key `extends` names a built-in theme. That theme supplies each token that your file does not set. A value is any color that Ink accepts. A value is `"red"`. A value is `"#d55e00"`. A value is `"rgb(215,95,0)"`.

The `Theme` interface has the full token list. The interface is in `packages/tui/src/themes/tokens.ts`. Each token there describes what it colors.

> **NOTE**: A broken theme file does not stop the session. Use `/doctor` to see which file failed and why.

### Output styles

An output style is a Markdown file that changes the voice of the session. Put your styles in `~/.labunbun/output-styles/`. Put the styles of one project in `<project>/.labunbun/output-styles/`. The file name without `.md` is the name of the style.

The tool loads the user styles always. It loads the project styles only after `/agents approve`. The command asks for a restart, because the prompt was built at startup. When a user style and a project style have the same name, the project style wins.

Set `outputStyle` in the settings file to the name of a style. The tool adds the body of the file to the system prompt as the `# Output style` section. The section is an addition. It does not replace the instructions of the agent.

A name that matches no file adds nothing and reports no error. Use `/doctor` to see the `Output style` row. The row warns when the name matches no loaded style.

Set `language` in the settings file to set the language of the answers. The tool adds `Answer in <language>.` to the system prompt. The value is free text. Examples are `Chinese` and `zh-CN`.

### Editing in the terminal

The tool has three editors. Each one is independent.

| Editor | Command |
|--------|---------|
| Default | None |
| Vim | `/vim [on\|off]`, or `vimMode: true` |
| Emacs | `/emacs [on\|off]`, or `emacsMode: true` |

#### Emacs keys

The Emacs editor has no mode line. Use these keys.

| Key | Action |
|-----|--------|
| `C-a`, `C-e` | Go to the start or the end of the line. |
| `C-f`, `C-b` | Move one character forward or back. |
| `C-n`, `C-p` | Move one line down or up. |
| `C-s` | Start an incremental search forward. Enter accepts the match. `C-g` cancels. |
| `C-r` | Start an incremental search backward. Enter accepts the match. `C-g` cancels. |
| `M-f`, `M-b` | Move one word forward or back. |
| `M-C-F` | Jump to the matching bracket. |
| `M-u`, `M-l`, `M-c` | Upcase, downcase, or capitalize one word. |
| `M-t` | Move the word at the point past the next word. A count moves it past that many words. |
| `M-o` | Swap the two characters around the point. This is uemacs's `C-t`, which the watch panel owns here. It does not cross a line break. |
| `C-k` | Kill to the end of the line. |
| `C-w` | Kill the word before the point. |
| `C-d`, `C-h` | Delete one character forward or back. |
| `C-y`, `M-y` | Paste the last kill, or the one before it. |
| `C-SPC` | Set the mark. |
| `M-SPC`, `M-.` | Set the mark. The same command as `C-SPC`. |
| `C-x C-x` | Go to the mark. |
| `C-x C-u`, `C-x C-l` | Upcase or downcase the region. |
| `C-x C-o` | Delete the blank lines around the point. |
| `C-x C-t` | Swap the current line with the previous line. A count moves the previous line past that many lines. A count of zero swaps the lines at the point and the mark. |
| `C-u` | The prefix argument. Its value is `(4)`. Press it again to multiply by 4. |
| `M-1` to `M-9`, `M--` | Set the prefix argument to a number. |
| `M-C-H` | Kill the word before the point. Most terminals cannot send this key. |
| `?` | Show the keys that the engine uses. |

The kill ring has these rules:

- `C-k C-k` joins two lines.
- A backward `C-k` puts the text before the point.
- `M-C-w` joins two kills that were not next to each other.
- A prefix argument makes a delete a kill. `C-u C-d` fills the ring. A `C-d` without a prefix does not.

The engine uses the Emacs rule for words. A boundary is a change of script. `M-f` stops inside CJK text. `foo-bar` is 3 words.

The engine takes this key and does not use it: `M-z`. The engine uses it for nothing. It does not reach the terminal as a character. `C-r` does history search in the other editors; in this editor it starts an incremental search backward, and `C-s` starts one forward. `C-t` and `C-o` are the host's keys: they open the watch panel and the transcript.

### DualShock 4 controller

> **WARNING**: Do not rest a finger on a button. The tool reads a held button as a press.

A DualShock 4 controller can run the session without a keyboard. Connect the controller with USB or with Bluetooth.

```bash
/gamepad on        # read a controller now, and remember it
/gamepad status    # show the transport, the battery, and the bindings
/gamepad watch     # show each press as one line
/gamepad list      # list each controller interface that the OS reports
/gamepad reset     # look for a controller again
/gamepad approve   # ask whether ✕ can answer a permission dialog
/gamepad rumble    # buzz once
/gamepad           # show the table of buttons and actions
```

Use `--gamepad` to turn the controller on for one run. The flag does not write a setting. Use `--no-gamepad` to turn it off for one run.

| Button | Action |
|--------|--------|
| D-pad, left stick | Move in lists, dialogs, and the transcript. |
| Right stick, vertical | Scroll the transcript. |
| `L2`, `R2` | Change the repeat rate. The rates are 160 ms and 30 ms. |
| ✕ | Confirm. Hold for 600 ms in a permission dialog to always allow. |
| ○ | Cancel. Cancel also interrupts a running turn. |
| □ | Clear the screen. In the on-screen keyboard, delete one character. |
| △ | Open the command wheel. In the on-screen keyboard, shift. |
| `L1`, `R1` | Page back or forward. |
| Options | Open the transcript browser. |
| Share | Open the on-screen keyboard. |
| Touchpad press | Run `/status`. |
| `L3`, `R3` | Open `/model`. Pick the permission mode. |
| PS | Nothing. The OS and Steam use this button. |

A repeat starts after 400 ms. A repeat then happens every 80 ms. `L2` and `R2` change these values.

The lightbar uses the accent color of the theme. It is brighter during a turn. It flashes when a dialog waits. It is red when the battery is low.

A waiting dialog also blinks the lightbar on the controller. The bar turns on for 500 ms. The bar turns off for 500 ms. This is the only state that uses a blink.

The motors have these signals:

| Signal | Meaning |
|--------|---------|
| One short tap | The tool found a controller. |
| One firmer tap | Work started. |
| One long tap | The turn ended. |
| Two short taps | You stopped the turn. |
| The faintest tap | The controller said no. |
| A hard kick, both motors | A dialog needs a decision. |
| Both motors, gently | The battery is low. |

Two signals are not delayed by an earlier signal. They are a waiting dialog and a low battery. Each happens once. Every other signal waits its turn.

#### Touchpad

The touchpad is not a mouse. A finger on it gives a position and a gesture.

| Gesture | Action |
|---------|--------|
| Tap | Confirm, the same as ✕. |
| Drag | Move one step. One step is an eighth of the surface. |
| Two fingers | Page back or forward. |

A tap never holds a button. A gesture lasts one report. Buttons keep the hold.

The hold on ✕ is 600 ms of reports from the controller. The tool does not count wall-clock time. A controller that stops and starts reports does not keep the age of the press. The hold starts again.

> **NOTE**: A gap of 250 ms with no reports means the controller is gone. The tool then forgets it.

> **NOTE**: A controller that is connected with USB and switched on appears twice. The tool reads one link and writes to both.

> **NOTE**: Two controllers that are both switched on appear as one. Use the `device` key in the settings to choose one.

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

The keys `rumble` and `lightbar` both have the value `true` by default. Set a key to `false` to stop that part of the controller from working.

> **WARNING**: `allowApprove` has the value `false` by default. With it off, ✕ does not answer a permission dialog. Only a user-tier settings file can set `gamepad`.

`node-hid` is an optional dependency. The tool works without it. Use `/gamepad on` to see the command that installs it.

## Installation

### Requirements

- The tool does not use Node.js.
- Bun 1.3.0 or later
- pnpm 10.33.2 or later
- An API key for one provider

### Procedure

1. Install the packages.

   ```bash
   pnpm install
   ```

2. Set an API key.

   ```bash
   export ANTHROPIC_API_KEY=sk-...
   export DEEPSEEK_API_KEY=sk-...
   ```

   Or sign in to a Claude subscription. This step needs no API key.

   ```bash
   bun run dev login
   ```

   Use `bun run dev login chatgpt` for a ChatGPT subscription instead.

3. Start the session.

   ```bash
   bun run dev
   ```

   On a machine with no settings file, the first start runs the setup wizard. The wizard lists what the machine already holds — a variable you exported above is included — asks how to pay for the model, and writes the settings file. The wizard can also import the settings, MCP servers, skills, and agents of another tool. It shows the full plan before it writes anything.

   Use this command to run one prompt and print the result.

   ```bash
   bun run dev -p "list the files here"
   ```

## Operation

### Command line options

| Option | Purpose |
|--------|---------|
| `-p`, `--print` | Run one prompt, then print the result. |
| `--model <provider/id>` | Use this model for the run. |
| `--permission-mode <mode>` | Set the permission mode. The values are `ask`, `plan`, `agent`. |
| `--sandbox <mode>` | Set the sandbox. The values are `workspace-write`, `danger-full-access`. |
| `--network <policy>` | Set the network access. The values are `restricted`, `enabled`. The flag sets the access only. The domain rules stay in settings. |
| `--max-turns <n>` | Stop after this many turns. This option works in headless mode only. |
| `--no-session` | Do not store the session. This option works in headless mode only. It does not work with `--resume` or `-c`. |
| `--resume <id>` | Open this session in the terminal. A headless run continues the session with the prompt of the run. |
| `-c`, `--continue` | Open the last session in this directory. A headless run continues it with the prompt of the run. |
| `--output-format <format>` | Set the output format. The values are `text`, `json`, `stream-json`. |
| `--settings <json>` | Merge this settings object over the settings files for one run. The value is JSON. A value that is not valid JSON stops the run. |
| `--gamepad` | Use the controller for this run. The tool does not write a setting. |
| `--no-gamepad` | Do not use the controller for this run. |
| `--acp` | Serve the Agent Client Protocol on stdio. Use this option for an editor. It is the same as the `acp` subcommand. |
| `--help`, `-h` | Show the options. |
| `--version`, `-v` | Show the version. |

Every option takes the next argument. The tool does not accept `--option=value`.

The tool stops with an error when `--acp` shares a command line with `-p`, `--resume`, `-c`, `--no-session`, `--output-format`, or a gamepad option.

The default model is `anthropic/claude-sonnet-5`. The number of turns has no limit by default.

The `json` output format has a `cost_usd` field.

### Session commands

Use these commands in the terminal.

| Command | Purpose |
|---------|---------|
| `/status` | Show the model, the context use, the cost, and the settings. |
| `/model [provider/id]` | Show the model, or change it. |
| `/login [claude\|chatgpt\|gemini\|<code#state>]` | Sign in to a subscription. The tool opens a browser. A pasted code completes the Claude or Gemini sign-in. |
| `/logout [claude\|chatgpt\|gemini]` | Sign out of a subscription. |
| `/mode [mode]` | Show the permission mode, or change it. |
| `/permissions` | Show the permission mode and the rules. |
| `/plan` | Show the plan recorded in this session: its state, its steps, and the full text. |
| `/doctor` | Check the environment, the settings, and the provider. |
| `/cost` | Show the cost of this session, then of this project. |
| `/context` | Show what the context window contains. |
| `/cache` | Show the prompt cache hit rate and its ceiling. |
| `/compact [focus]` | Summarize the conversation. Warns when the compacted context is still at or over the hard limit, and points at `/trim`. |
| `/trim` | Replace old tool results with short previews. |
| `/autocompact [on\|off\|<percent>]` | Show or change the automatic compaction passes and their trigger line. |
| `/checkpoint` | Show the tool ledger: the last call, the files that it touched, the tasks, and the context use. |
| `/rewind [number]` | Restore a file from a checkpoint. The tool lists the last 10 checkpoints. |
| `/fork <id>` | Start a new session from an entry. Use `/tree` to find the id. |
| `/tree` | Show the branches of the session. |
| `/rename [<title>\|--clear]` | Give this session a name, or remove the name. The name shows in the terminal title and in `/resume`. |
| `/resume` | Open an earlier session in this directory. |
| `/export [path]` | Export the session to a Markdown file. |
| `/agents [approve]` | List the agent definitions, then load the ones of this project. |
| `/subagents [stop\|retry\|log] [id]` | List the subagents of this session, with their state and age. Stop one, retry a failed one, or read the log of one. |
| `/ps` | List the background shells. Show what one has printed. |
| `/stop [id]` | Stop a background shell. This includes a shell that a previous run left running. |
| `/tasks` | Show the task tree. The tree shows this session, its subagents, and its background shells. |
| `/todo` | Show the full task board: every task, its status, owner, blockers, and description. |
| `/mcp [approve <name>\|prompts <server>\|prompt <server> <name>\|resources <server>\|resource <server> <uri>]` | List the MCP servers, approve one, or read a prompt or a resource. |
| `/activity [7d\|30d\|all]` | Show the days that you used this, and the current streak. |
| `/memory [rules\|project]` | Open your memory files in your editor. Without an editor, print their paths. |
| `/think [level]` | Set how hard the model thinks. The values are `off`, `minimal`, `low`, `medium`, `high`. |
| `/theme [name\|auto]` | Show the themes, or change the theme. |
| `/vim [on\|off]` | Turn vim editing on or off. |
| `/emacs [on\|off]` | Turn Emacs editing on or off. |
| `/gamepad [...]` | Set the controller. See [DualShock 4 controller](#dualshock-4-controller). |
| `/beetle [...]` | Run the four-agent band. See [The four-agent band](#the-four-agent-band). |
| `/yoshi [...]` | Import from another agent tool. See [Import procedure](#import-procedure). |
| `/init` | Make a `LABUNBUN.md` file for this project. |
| `/explain <target>` | Ask the model to explain code or a concept. |
| `/hal` | Play a sound. |
| `/clear` | Clear the display. The session and the model context stay. |
| `/help` | Show this list. |
| `/exit` | Stop the session. It asks first while a run, subagents, or background shells are still active. |

The command `/migrate` is the previous name of `/yoshi`. The command `/quit` is an alias of `/exit`.

In a picker, type to filter the list. The filter reads the name and the description of each row. Use Backspace or Delete to remove one character. Use Ctrl+U to clear the filter. The list shows eight rows at a time. The slash completion list reads names and descriptions too. For example, type `/title` to find `/rename`.

In `/resume`, press Space to preview the highlighted session. The preview shows the last six messages, up to 12 lines. Use the arrow keys to preview another session. Press Esc to close the preview. Press Esc again to close the list. Space is a filter character after you type in the search field.

Use `/rename <title>` to name the current session. The terminal title shows the name instead of the directory name. The `/resume` row uses the name as its label. Use `/rename` alone to show the current title. Use `/rename --clear` to remove it.

Press Ctrl+O to open the transcript. The transcript shows the full text of a tool result that the compact view cut. The compact view says how many characters it hid and names Ctrl+O. The transcript says when the output itself was capped at 16,000 characters. Press Ctrl+O again to return to the session.

Press Ctrl+T to show the watch panel. The panel shows a background shell's tail, the subagent listing, or the session facts, and it takes no keys of its own. Press Ctrl+V while the panel is open to cycle the source: the shell tails in start order, then the subagent listing, then the session facts, wrapping back to the first shell. Press Alt+1 to Alt+9 while the panel is open to jump to the shell with that number. Each shell header shows its number on the left. The tool shows the last running shell, or the last shell that ended. The panel is a snapshot from the two-second poll, and it says so. Press Ctrl+T or Escape to close it. These keys do nothing while a dialog, a question, the command picker, or the transcript is open. Under the Emacs editor, `Alt+1` to `Alt+9` arms a count in the prompt, so the jump does not occur. A terminal that turns Ctrl+V into paste — Windows Terminal does by default — takes the key before the app sees it.

### Headless output

Use `--output-format text` for plain text. Use `--output-format json` for one JSON object. Use `--output-format stream-json` for one JSON object per event.

The JSON result carries `error_kind` and `error_remedy` when the run ended on a classified failure. It carries `incomplete: true` when the reported text is the partial answer of a failed or interrupted turn.

A headless run that opens a stored session (`--resume <id>` or `-c`) prints the recovery line to stderr when the ledger holds one. It also warns about the subagent runs that a previous process left unfinished. The answer stays the only thing on stdout.

### Editor sessions

The `acp` subcommand serves the Agent Client Protocol on stdio. An editor starts the command and speaks JSON-RPC over the pipe.

```bash
bun run dev acp
```

The server reports the `loadSession` capability. The editor can open a new session or a stored one, send a prompt, and receive the updates as they stream. The tool replays a stored session to the editor before the open returns. The permission modes are the same three as the terminal: `ask`, `plan`, `agent`. A decision of `ask` becomes a question to the editor. Warnings go to stderr, because stdout carries the protocol.

## Configuration

### Files and folders

| Path | Content |
|------|---------|
| `~/.labunbun/settings.json` | Your settings. |
| `~/.labunbun/managed-settings.json` | The policy settings of your organization. |
| `~/.labunbun/.mcp.json` | Your MCP servers. |
| `~/.labunbun/MEMORY.md` | Your memory file. |
| `~/.labunbun/rules/` | Your rule files. |
| `~/.labunbun/agents/` | Your agent definitions. |
| `~/.labunbun/skills/` | Your skills. |
| `~/.labunbun/themes/` | Your themes. |
| `~/.labunbun/output-styles/` | Your output styles. |
| `~/.labunbun/history.jsonl` | The prompts that you typed. Press ↑ to recall them. |
| `~/.labunbun/projects/<dir>/` | The sessions, the MCP approvals, and the trust of one project. |
| `<project>/.labunbun/settings.json` | The settings of this project. |
| `<project>/.labunbun/settings.local.json` | Your settings for this project. |
| `<project>/.labunbun/rules/` | The rule files of this project. |
| `<project>/.labunbun/agents/` | The agent definitions of this project. |
| `<project>/.labunbun/skills/` | The skills of this project. |
| `<project>/.labunbun/themes/` | The themes of this project. |
| `<project>/.labunbun/output-styles/` | The output styles of this project. Loaded after approval. |
| `<project>/.mcp.json` | The MCP servers of this project. |
| `<dir>/LABUNBUN.md`, `<dir>/AGENTS.md`, or `<dir>/CLAUDE.md` | The project guide of one directory. The tool reads the first one of the three that exists. |

The tool reads the memory files from the working directory up to the root of the filesystem. At each directory the tool reads at most one of `LABUNBUN.md`, `AGENTS.md`, and `CLAUDE.md`: the first one of the three that exists. The nearest file has the highest priority. The files are rendered from the root to the working directory, so the nearest file is last. The budget is spent from the nearest file outward: if the files are too large, a file that does not fit contributes its first part, and farther files are left out. A note at the end names the files that were partly or not loaded. The total output is at most 40000 characters, the note included.

The tool does not load the memory files of a project at first. It loads them after `/agents approve` and a restart. At startup the tool prints the number of project memory files that it held back. A line in the prompt that starts with `#` is a memory note. The tool appends the note to `~/.labunbun/MEMORY.md` and updates the system prompt at once.

### Settings tiers

The tool reads the settings files in this order. A later file has a higher priority.

1. User: `~/.labunbun/settings.json`
2. Project: `<project>/.labunbun/settings.json`
3. Local: `<project>/.labunbun/settings.local.json`
4. Policy: `~/.labunbun/managed-settings.json`

A project file is controlled by its repository. The tool does not read these keys from a project file:

`model`, `fallbackModels`, `roles`, `thinkingLevel`, `permissionMode`, `sandbox`, `networkAccess`, `networkDomains`, `env`, `providers`, `hooks`, `mcpServers`, `pricing`, `cache`, `trimOldToolResults`, `compaction`, `modelDiscovery`, `backgroundShellNotifications`, `gamepad`, `beetle`, `allowManagedPermissionRulesOnly`, `disableBypassPermissionsMode`, `language`, `outputStyle`, `permissions.allow`, `permissions.additionalDirectories`.

A repository must not choose its own model. A repository must not choose its own confinement. A repository must not approve its own tool calls. A repository must not turn the network off.

The tool reads `permissions.deny` from every tier. It reads `theme`, `vimMode`, and `emacsMode` from a project file.

The tool writes the keys that it ignored to the output at startup.

The tool does not add an ignore rule for `settings.local.json`.

### Approval of project definitions

The tool does not load the agent definitions, the skills, the memory files, or the output styles of a project at first. Use `/agents approve` to load them. The tool remembers this decision in `~/.labunbun/projects/<dir>/`. The tool does not remember it in the repository.

A headless run has no dialog. The tool does not load the definitions of an unapproved project. The tool writes a note to stderr.

### Settings keys

| Key | Values | Tier |
|-----|--------|------|
| `model` | `provider/id` | User |
| `fallbackModels` | An array of `provider/id`. The tool tries each model in order. | User |
| `roles` | An object of the five seats `main`, `plan`, `compaction`, `light`, and `local`. Each seat has `provider`, `model`, `fallback`, and `budgetUSD`. | User |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high` | User |
| `permissionMode` | `ask`, `plan`, `agent` | User |
| `sandbox` | `workspace-write`, `danger-full-access` | User |
| `networkAccess` | `enabled`, `restricted` | User |
| `networkDomains` | An array of strings and objects | User |
| `trimOldToolResults` | A boolean. The value `true` is the default. | User |
| `compaction` | An object with the keys `model`, `reserveTokens`, and `thresholdPercent` | User |
| `modelDiscovery` | A boolean. The value `true` is the default. | User |
| `backgroundShellNotifications` | A boolean. The value `true` is the default. | User |
| `env` | An object of environment variables | User |
| `providers` | An object of OpenAI-compatible providers | User |
| `pricing` | An object of model prices | User |
| `cache` | An object of cache settings | User |
| `beetle` | An object with the keys `models`, `maxTurns`, `maxCostUSD`, and `stallNoticeMinutes` | User |
| `language` | The language of the answers, as free text. For example `Chinese` or `zh-CN`. | User |
| `outputStyle` | The name of an output style file, without `.md`. | User |
| `mcpServers` | An object of MCP servers | User |
| `hooks` | An object of hooks | User |
| `gamepad` | An object of controller settings | User |
| `allowManagedPermissionRulesOnly` | A boolean. Policy tier only. | Policy |
| `disableBypassPermissionsMode` | A boolean. Policy tier only. | Policy |
| `theme` | A theme name, or `auto` | Any |
| `vimMode` | A boolean | Any |
| `emacsMode` | A boolean | Any |
| `permissions.allow` | An array of rules | Any |
| `permissions.deny` | An array of rules | Any |
| `permissions.additionalDirectories` | An array of paths | Any |

Each seat in `roles` can set `budgetUSD`. The budget is opt-in: a seat with no value has no ceiling. The tool compares the spend against the budget before each request and refuses the request when the spend is over the value. The refusal names the setting: `Budget reached: $2.5000 spent of the $2.0000 budget for roles.main. Raise roles.main.budgetUSD or switch models.`

A request on the session's own loop counts the whole session, subagent runs included. The gate before a subagent run counts the share that the `light` seat itself spent. A model that no seat names is not gated. The `local` seat resolves, but no feature reads it yet, and the tool warns at startup when one is set.

### Add a provider

Add a provider in `~/.labunbun/settings.json`.

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

The unit of each price is US dollars per 1 million tokens. The keys `cacheRead` and `cacheWrite` have the value 0 by default.

A key `pricing` at the top level changes the price of a model. Use the form `"anthropic/claude-sonnet-5"`. This is for a gateway or a rate that you negotiated.

The tool does not report a model with no price as free. Use `/cost` to see which models have no price.

You can change the base URL of a provider. Use `<PROVIDER>_BASE_URL`, for example `ANTHROPIC_BASE_URL`. Use `OLLAMA_BASE_URL` to move the local Ollama daemon to another address.

## Import procedure

The command `yoshi` copies the setup of another agent tool. The tool reads the other setup. The tool never changes it.

The tool reads these values for `--from`:

```text
one source: claude-code | codex | zcode | agents | deepseek-harness | grok-build | kimi-code | minimax-code | step-code | opencode | cursor | trae | t3-code | antigravity | qoder | codewhale | mimocode-code | openclaw | alma | command-code | all
```

The value `all` reads every source that the tool finds.

The tool copies these categories:

- `settings`: the model, the environment variables, the MCP servers, the permission rules
- `assets`: the skills, the agents, the rules
- `history`: the sessions and the prompts

### Procedure

1. See what the tool does. This step writes nothing.

   ```bash
   bun run dev yoshi
   ```

2. Choose the sources.

   ```bash
   bun run dev yoshi --from codex
   ```

3. Choose the categories.

   ```bash
   bun run dev yoshi --only settings
   ```

4. Write the changes.

   ```bash
   bun run dev yoshi --apply
   ```

5. Write the changes over the values that already exist.

   ```bash
   bun run dev yoshi --apply --force
   ```

| Option | Values | Default |
|--------|--------|---------|
| `--from` | A list of source names, or `all` | `all` |
| `--only` | A list of categories, or `all` | `all` |
| `--history-scope` | `cwd`, `all`, `none` | `cwd` |
| `--history-limit` | The number of sessions per source. Use 0 for none. | 20 |
| `--apply` | Write the changes | Dry run |
| `--force` | Write over values that exist | Keep them |

Use `/yoshi` in the terminal to run a wizard. The wizard asks which sources and which categories to use. Use `--yoshi` to run the same command as the subcommand.

### What the tool copies

The tool copies the model names, the environment variables, the MCP servers, the permission rules, the skills, the agents, and the rules. The tool copies a skill directory as a whole. The tool reports each file that it did not copy.

The tool turns the slash commands of another tool into skills. The tool expands `$ARGUMENTS`.

> **NOTE**: The rules files of Codex become permission rules. Codex matches part of a command. LaBunbun Code matches the whole command.

The tool imports the sessions under `~/.labunbun/projects/<dir>/`. The tool then imports the prompts into `~/.labunbun/history.jsonl`. Use `--continue` to find a session. Press ↑ to find a prompt.

The tool drops a tool call that has no result. The tool does not write a conversation that the messages API refuses.

> **NOTE**: The tool reports each value that it did not copy. The tool does not report the value of a key.

### Credentials

> **WARNING**: No credential comes across. The tool never writes a credential from another setup into your settings.

The tool removes these keys. It reports each one by name. `api_key`, `webhook_token`, `sandbox_api_key`, `headers`, `env`, `env_headers`.

> **WARNING**: The tool cannot remove a credential from a URL. A URL that has `user:password@` in it keeps no meaning without it. The tool does not copy a server with such a URL.

The tool also does not copy a server whose URL has a parameter that names a credential. Use `/mcp approve` to add such a server.

The report names each file that ends with a credential in it.

## Development

### Gates

```bash
pnpm typecheck        # tsc over all packages
pnpm test             # bun test, no network
pnpm lint             # biome check
pnpm bin:build        # make a standalone executable with bun build --compile
```

The tool runs these gates on Linux, Windows, and macOS. The tool requires all of them for each pull request.

The tool uses no secret in the test suite. The test suite must not need a key or a network.

### Scripts

```bash
bun run scripts/smoke.ts anthropic/claude-sonnet-5
bun run packages/coding-agent/scripts/cache-check.ts anthropic/claude-opus-5 6
bun run scripts/gamepad-probe.ts
bun run scripts/gamepad-probe.ts --touch
```

> **WARNING**: The cache script sends real requests. It costs money.

### Packages

| Package | Purpose |
|---------|---------|
| `@labunbun/ai` | The message model, the stream protocol, the provider adapters, the model catalog, the cache policy, the cost accounting. |
| `@labunbun/agent` | The agent loop, the tool interface, the permission engine, the session files, the compaction. |
| `@labunbun/tools` | The coding tools. |
| `@labunbun/mcp` | The MCP client. |
| `@labunbun/tui` | The terminal interface. It uses React and Ink. |
| `@labunbun/gamepad` | The DualShock 4 support. |
| `@labunbun/coding-agent` | The command line tool, the settings, the commands, the hooks, the subagents, the skills. |

The dependency direction is one way: `ai`, then `agent`, then `tools`, `mcp`, `tui`, then `coding-agent`. The package `gamepad` has no dependency. The tool loop never imports a provider adapter. The adapters arrive in the `StreamFn` parameter. This is why the tests run with no network.

### What CI does not check

Three checks are not in CI:

- The `vim-differential` tests need the `vim` program. They are not part of `bun test`.
- The Emacs citation test and the DeepSeek Harness test skip when they do not find their source.
- `tsconfig.check.json` does not cover `packages/coding-agent/bin/`.

## Contact

Questions and bug reports: labunbun@zayoka.com

## Sponsor

If LaBunbun Code saves you time, you can support the development. Scan a code with a wallet app, or copy the address.

| Network | Address | QR code |
|---------|---------|---------|
| BTC | `bc1qv9zhpzzdddyakzsetgwr4tkznl4ycsuxn7d00g` | ![QR code for the BTC address](./docs/assets/sponsor-btc.svg) |
| ETH | `0x8dFB632F494C694a1a0Ff4CC2566617230530020` | ![QR code for the ETH address](./docs/assets/sponsor-eth.svg) |
| SOL | `AdryGzPCKyH5PPzEmZ9ZxW77A5kCbBuapmrqeYFGcPna` | ![QR code for the SOL address](./docs/assets/sponsor-sol.svg) |

## License

MIT © 2026 zayoka. Read [LICENSE](./LICENSE).

LaBunbun is free software licensed under the MIT License.

If you enjoy this software, please help children living in war zones and those affected by disasters. Children are the future and hope of our world, and every child deserves the chance to grow up healthy, safe, and strong. Every child, wherever they live, has the right to a bright future!

To all the children of the world:

The world needs you to help create a better tomorrow. Whatever your dream may be, if you believe in it and work toward it, you can make a difference. Believe in yourself.

We encourage you to donate through the official donation pages of UNICEF, your national Red Cross society, Doctors Without Borders, or the Heal Los Angeles Foundation.

LaBunbun thanks everyone working to create a better future. You are all true heroes.

We Are The World.
