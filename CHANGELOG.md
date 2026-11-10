# Changelog

What changed in each release. Release pages carry the download links, install
commands, and SHA-256 checksums.

## Unreleased

### Added

- **The process scales to the request.** Every user prompt is now read for its
  size before the model sees it: `trivial` (an explicit small cue such as
  `just`, `typo`, `只改`), `complex` (scope words such as `all`, `refactor`,
  `所有`, or three named files), or `standard`. A trivial change is told to make
  the smallest edit, run the one check that covers it, and add no tests, docs,
  or defensive handling; a complex one to read first, state a short plan, and
  stop once the relevant checks pass. A question with no change verb — or only
  a negated one, as in "do not change anything, explain it" — is read as an
  answer, not an edit, while "don't forget to change it" stays a change; a
  question that asks for advice ("should I refactor this?", "该不该重构整个
  项目？") is an answer even when it names a change verb, while "can you fix
  it?" is still a request; a later imperative sentence makes the message a
  change ("why does it fail? fix it."), and so does a split request ("explain
  first, then fix it", "先解释一下，然后修复这个 bug"). The paths it counts
  ignore URLs and accept both separators, and a negated scope word adds nothing
  ("don't refactor everything, just fix the typo" stays trivial). `standard`
  adds nothing, so an ordinary request keeps the bytes and the effort it had.
  The same read sets thinking effort — `low` for
  trivial, `high` for complex — unless you set a level yourself. The
  instruction is part of the stored message, keeping the cache prefix stable,
  and is stripped from the transcript, the resume preview, export, and the
  requests a compaction keeps verbatim. `LBB_TASK_SCALE=off` turns it off. See
  `docs/dev/task-scale.md`.

- **Claude Fable 5.2 and Claude Mythos 5.2 are in the catalog.** Both carry the
  1M-token window, 128K output, always-on adaptive thinking, and $8/$40 pricing
  with the 0.025x cache read. Their pages are the first to name all five effort
  levels, so `xhigh` and `max` now reach those two rows. The same notes state
  that the prefix check runs on every account, which also moves Mythos 5.1 into
  the rows that opt into dropping a mismatched thinking block. Fable 5.2 is
  pinned on OpenCode Zen and OpenRouter as well, and the `fable` migration alias
  resolves to it.

- **A logo.** `docs/assets/labunbun-logo.png` is the new mark, shown at the top
  of the README.

- **The Windows build carries the mark.** `docs/assets/labunbun-icon.ico` is the
  logo trimmed to its content, set on a white rounded square, and rendered at
  nine sizes from 16 to 256 pixels, so Explorer picks a sharp frame at every
  zoom. `bin:build` embeds it with `--windows-icon` and fills the executable's
  version resource — title and description `LaBunbun Code`, publisher
  `zayokami`, version `0.1.0.4`, and the MIT copyright line — instead of
  leaving Bun's own metadata on the file. The installer takes its setup icon
  from the same file.

- **The system prompt adapts to the model family.** Every session now resolves
  its model to a profile: Claude, GPT, Gemini, DeepSeek, Kimi, Qwen, GLM,
  MiniMax, Mistral, Meta, Hunyuan, MiMo, NVIDIA, a local Ollama model, or an
  unknown row. The profile adds a `# Model guidance` section naming the active
  model and carrying the family's tool and edit habits, and selects a short
  prompt for small windows and small local models. A gateway row is read as the
  model it serves, not as the gateway. `/model` rebuilds the prompt with the
  new model, and a subagent gets the profile of the model it actually runs on.
  The layer is per family, not per model, and it does not change thinking
  parameters, limits, or tool availability — those stay on the model row where
  the wire adapters read them. See `docs/dev/model-profiles.md`.

- **Five more providers: Tencent TokenHub, Xiaomi MiMo, Meta's Model API, and
  Kimi's China and Code hosts.** `tencent/` carries `hy4`, `hy4-preview` and
  `hy3` from TokenHub, Tencent's official home for the Hy generation, keyed by
  `TENCENT_API_KEY` or `TOKENHUB_API_KEY`; `hy4` also joins the OpenCode Go
  plan. `xiaomi/` carries `mimo-v2.6-flash` and `mimo-v2.6-pro` on Xiaomi's
  pay-as-you-go host, keyed by `MIMO_API_KEY` or `XIAOMI_API_KEY`. `meta/`
  carries the six Muse models from `api.meta.ai`, keyed by `META_API_KEY` or
  the docs' `MODEL_API_KEY`. `kimi-cn/` is the China platform's copy of the six
  Kimi API rows, and `kimi-code/` and `kimi-code-cn/` are the two region-locked
  Kimi Code plans, priced at zero because the plan bills a membership. Each
  regional host takes its own key (`KIMI_CN_API_KEY`, `KIMI_CODE_API_KEY`, or
  `KIMI_CODE_CN_API_KEY`) and cannot be reached with another region's. The
  Kimi cache floor applies to all three Kimi doors, `/model` discovers each
  provider's listing at startup, and every host can be moved with
  `<PROVIDER>_BASE_URL`.

- **`/yolo` turns off the permission gates for one session, with a typed
  confirmation.** Typing `/yolo` opens a dialog that names what stops — the
  dangerous-command classifier, ask rules, and every approval prompt — and what
  remains: deny rules, hooks, the sandbox and its network policy, plan mode's
  read-only gate, tool validation, and MCP approvals. It takes the exact
  sentence `I only live once`, capitalisation included, to enable; a mismatch
  keeps the dialog open, and Escape cancels. The posture lives on the session
  only: it is not a permission mode, is not in the picker, the settings, the
  CLI or the policy snapshot, cannot be resumed, and ends with `/yolo`,
  `/yolo off`, any mode change, or a single Shift+Tab. Escalated Bash calls,
  which ask to leave the sandbox, are denied while it is on. Subagents and
  beetle members follow the root session live, and hosts without an interactive
  phrase surface cannot enter it. See `docs/dev/yolo-mode.md`.

- **The built-in skills ship inside the binary.** Release artifacts carry the
  skill files from `.labunbun/skills` (bodies and `references/`) embedded in the
  executable instead of expecting a directory beside it. They are written once
  per version under `~/.labunbun/bundled-skills/<version>/` — a content digest
  rather than the version alone decides when to refresh — and loaded beneath the
  user's and the project's skills, so a local skill with the same name replaces
  the built-in one. `bun run skills:bundle` regenerates the import list;
  `bin:build` and `release:package` run it first.

- **`Ctrl+T` splits the screen when the terminal has room.** On a terminal at
  least 88 columns wide and tall enough for two panes, the watch panel moves to
  a right column and the transcript takes the left one, with the prompt still
  under both — two live surfaces at once instead of one at a time. The
  transcript pane opens on the tail of the conversation, its header names the
  entries it is showing (`Conversation 12-17 of 40`), and `PgUp`/`PgDn` page it
  back and forward by the span the pane is showing. A page, once turned, stays
  put while new output arrives below, and the header counts it (`· 3 new`);
  paging back to the tail resumes following, and sending a message returns
  there. The right column carries the watch panel over a compact task strip —
  up to three unfinished tasks, an exact row budget — with one blank column
  between the panes. `Ctrl+T` or Escape closes the split. The terminal's
  scrollback above the frame is untouched and stays full width, so nothing is
  reprinted or lost. Narrow or short terminals keep the inline watch panel —
  the same key, one honest placement rather than a squeezed split. The left
  pane is drawn by a line model that fits its rows exactly, after a measured
  ink 7.1.1 bug in which an overflowing fixed-height box merged and dropped
  rows; see `docs/dev/split-pane-design.md`. The panes share one height budget
  with the rest of the frame: a dialog or card takes the frame while it is open
  and the split returns unchanged afterwards, and queued-message rows are taken
  from the panes first, so the frame never grows past the terminal.

- **The approval diff marks the words that changed.** A removed/added pair in
  the permission dialog keeps its line colour and draws the words that actually
  differ in bold, so `const answer = 1;` against `const answer = 42;` points at
  `1` and `42` instead of asking the reader to compare the lines by eye. A pair
  with almost nothing in common stays one colour, and an unaligned body or a
  `Write` has no counterpart to pair with, so it is drawn as before.

- **The permission dialog has one-key answers.** `y` allows once, `n` denies,
  and `a` takes the session's standing "don't ask again" answer when the list
  offers one. An escalated Bash call has no such row, and `a` there does
  nothing rather than promising a grant the engine would not honour. The legend
  names `y` and `a`; Esc already stands for deny.

- **The first screen folds its startup notices into one dim line.** Notices
  that used to print raw between the greeting and the prompt — a controller
  that is not attached, skill folders that failed validation, a catalog refresh
  — are summarised under the greeting (`ℹ gamepad idle · skill not loaded ·
  /doctor for details`). None of them needs an answer before the first prompt,
  and unboxed between the two things that do, they read as a broken start.
  `/doctor` prints the full sentences after its health rows. A notice that
  carries something to act on still gets its own transcript row, and one that
  arrives after the conversation has started is said there instead, because
  there is no greeting left to fold it into.

### Changed

- **Interactive mode says why it needs a terminal.** When stdin is not a TTY
  (a pipe, a CI step, a launcher that captures output), the session now exits
  before the first frame with a message pointing at `-p "<prompt>"`, instead of
  drawing the screen and then failing in the renderer — which looked like a
  flash and a crash.

- **The empty screen introduces itself.** A session with no messages now opens
  on a welcome panel instead of a bare prompt: the mascot and
  `Welcome to LaBunbun Code` with the version under it on the left, a short
  `Tips for getting started` column on the right, and the workspace and model
  underneath. The panel measures the terminal and steps down — two columns, then
  one, then the name alone — and is not drawn at all below 34 columns or 14 rows,
  so the prompt always fits. It leaves the screen once someone has written to the
  transcript — startup notices underneath it do not count — or a turn, dialog or
  overlay is active.
- **The first screen is quieter.** The `starting interactive mode…` line is gone:
  it stayed in the scrollback above the greeting, stating the same facts worse.
  Consecutive startup notices now print as one block rather than one blank line
  per row, which keeps the greeting, the notices and the prompt on a short
  terminal.
- **The prompt is a rounded box with a `>` in the margin.** The writing surface
  reads as an input rather than an output log; the glyph carries the accent
  colour and multi-line drafts hang under it. The vim and permission badges and
  the key hint moved below the box, where they are a legend for the prompt
  instead of a second border inside it.
- **An answer has a margin of its own.** Assistant prose now carries the same
  dot a tool call does, in a muted colour, with the body two columns in — so a
  reply, the code block under it and the tool row after it share one left edge,
  and a turn reads as one speaker's. The streaming preview uses the same gutter,
  so the answer does not shift left when the stream seals.
- **The prompt's legend tells the truth while a turn runs.** The hint under the
  box said `Enter send` even mid-turn, when Enter steers the running agent (or
  queues, when it cannot be steered) and Tab queues behind it. It now names
  those meanings while busy and returns to the idle legend when the turn ends.

- **Two working directories no longer share one project key.** The key was the
  absolute path with every `:`, `/` and `\` folded to `-`, so `/srv/a-b` and
  `/srv/a/b` named one directory: sessions, project trust, MCP approvals, costs
  and tool output all landed in the same store. The key now percent-escapes
  those characters along with `%` itself, which is reversible and therefore
  distinct for every path. A session listed under the old key is moved to the
  new one when the `cwd` in its header matches, and a cost ledger under the old
  key is read once — but project trust and MCP approvals are not carried over:
  the old name cannot say which project granted them, so they are asked for once
  more rather than widening a grant to a neighbour.

### Fixed

- **A deny or ask rule sees the command the shell would run.** Quoting,
  backslash escapes and runs of whitespace were invisible to the matcher — `git
  pu"sh" origin main` did not match `git push *` — and a command substitution
  inside an allowed command inherited the allow. Deny and ask now match the line
  as written and normalized, and recurse into nested scripts; allow still has to
  match the whole line, and refuses a line whose substitution it cannot read.

- **A file rule reaches the shell's other readers and writers.** A `Read(...)`
  deny covered the Read tool but not `grep`, `rg`, `sed`, `awk`, `dd if=`, `mv`
  or `tar`, which open the same path from Bash. Their path operands are now
  checked too.

- **A sign-in that cannot reach the session's model says so.** `/login chatgpt`
  (or `gemini`, or the bare Claude form) on a session still on the default
  anthropic model printed the success line, and the next prompt still failed on
  a key that sign-in could never supply — a success followed by a failure reads
  as the sign-in not working. The command now adds one line naming the model
  still in force and the `/model` switch that reaches the signed-in wire. It
  does not switch by itself: a login should not change a setting nobody asked
  it to.

- **A screen taller than the terminal is clipped, not squeezed.** When a
  dialog, the suggestion list or a long draft pushed the live screen past the
  window's height, the last box shrank and drew its rows from overlapping
  offsets — text overprinted itself and the prompt's border was drawn through
  the advice under it. The screen now keeps its height and the frame drops
  whole rows off the top.

- **The slash-command list reads as a table.** Each suggestion was one wrapped
  sentence, so a long description ran to a second row and pushed the next
  command out of alignment. A suggestion is now one row: the name in a column
  of its own, the description aligned beside it and cut with `…` at the
  terminal's edge. Under about 60 columns the descriptions give way and the
  list is names alone.

- **The YOLO phrase field looks like a field.** The confirmation dialog asked
  for the exact sentence but drew the typed text with no marker and no caret,
  so the row read as another line of the list and nothing said the keys had
  somewhere to go. It now carries the prompt's `>` and block caret.

## 0.1.0.3 (Alpha) — 2026-10-29

A drop-in replacement for 0.1.0.2, with fixes to permission matching, the
Anthropic tool-call parser, `-p` output, and the `.git` write guard.

### Changed

- **The PowerShell wrapper follows the last statement.** It no longer sets
  `$ErrorActionPreference = 'Stop'`, which ended the script on the first native
  program that wrote to stderr under `2>&1` (Windows PowerShell 5.1) and so
  skipped everything after it. A cmdlet error no longer ends the script. The
  exit code is the one of the last statement, as in a shell: a failed native
  program returns its own code, and a later success exits 0 instead of
  inheriting an earlier `$LASTEXITCODE`.
- **A broken settings tier is skipped.** Each tier is checked on its own before
  the merge. A project or local file with one bad value used to make the whole
  merge fail and fall back to defaults, which dropped the user's and the
  policy's `sandbox`, `networkAccess` and `permissionMode`. Now only the bad
  tier is skipped, and the diagnostic names the file and the keys.
- **Permission rules reach further.** A `Read(...)` deny or ask rule also
  covers Grep, Glob, LS, Digest and the Inspect tools, and the deny and ask
  rules of Edit, Write and NotebookEdit cover each other. Allow rules are not
  widened. A `Bash(...)` rule is matched against each command of a chain: a
  deny or ask rule fires when any command matches, and an allow rule holds
  only when every command matches.

### Fixed

- **Tool calls on the Anthropic wire parse.** The empty `input: {}` that the
  API sends in a tool call's start event was joined to the argument fragments,
  giving `{}{"path":"a.ts"}`. An empty placeholder is now skipped. Chat
  Completions tool calls that arrive without an `index`, or with a new id on a
  reused slot, are no longer merged, and a name that arrives late is kept. The
  Responses wire reports an `error` event instead of "ended without a terminal
  event".
- **`-p` text mode prints the final answer after a tool call.** The text of an
  earlier turn was never reset, so only its first sentence, or a slice of the
  answer, reached stdout. `-p` also applies the `sandbox` setting now.
- **The `.git` guard resolves 8.3 short names.** A write through `GIT~1` on a
  volume with short names reached `.git/hooks`.
- **Edit and Write refuse non-UTF-8 files.** A GBK, Latin-1 or UTF-16 file was
  rewritten with U+FFFD in place of the bytes that did not decode.
- **A rule with `?` or `**/` matches what it says.** `?` in a Bash rule is a
  literal, and `src/**/*.ts` matches `src/a.ts`.
- **A session file with a torn last line keeps its next entry.** The first
  append after a resume started on the fragment's line and was lost.
- **Reads wait for an earlier write in the same message.** Once an unsafe call
  appeared in a turn, a later read could still start early and see old state.
- **The permission queue and dialog stay with their request.** A second answer
  to the same dialog removed the next request without resolving it, and the
  next dialog opened with the previous one's highlight and feedback text. The
  "tell the model" sentence and the Edit and Write diff now reach the dialog.
- **The Ctrl+O transcript is readable on a terminal.** The frame cap squashed
  every entry to a few lines.
- **A stick that switches controllers does not also press.** A silent DS4 no
  longer closes a healthy Xbox pad, a blank `device` setting no longer pins,
  and a failed first battery read no longer shows "low".
- **MCP stdio servers no longer write onto the screen.** Their stderr is piped
  and discarded. A wrongly shaped approval file is treated as damaged, and
  error text no longer loses short numbers to the secret filter.
- **The beetle ledger is written through a temp file.** A crash in the middle
  of a write no longer empties the lifetime totals.
- Vim `r<CR>` then `.` repeats the split, and Backspace or Delete on an empty
  `/` line behaves as in vim. The caret on an emoji no longer splits the
  surrogate pair.

## 0.1.0.2 (Alpha) — 2026-10-26

A drop-in replacement for 0.1.0.1.

### Added

- **Shift+Enter inserts a newline in the prompt.** The REPL negotiates the
  kitty keyboard protocol, which is what lets the terminal report the shift
  modifier; in legacy mode both keys arrive as a bare carriage return. A
  terminal without the protocol keeps working, but cannot send the key.
- **The thinking level is shown in the status line.** `/think` now badges the
  level it set (`think:high`) beside the model name, in both the idle row and
  a running turn. An unset level shows nothing, because each model's own
  default is not a decision the session made; `off` is.
- **Every answer carries its cache share.** When the provider reports cache
  activity for a turn, the answer is followed by the share served from cache,
  the prompt it was a share of, and the read/write split. A turn with no cache
  activity gets no line.
- **Linux commands run behind a syscall filter.** Bubblewrap loads a cBPF
  program that refuses the io_uring entry points and AF_VSOCK sockets with
  ENOSYS and kills a mismatched ABI. The loopback bridge still works because
  AF_UNIX stays allowed.

### Changed

- **Windows defaults to Windows PowerShell.** Commands run through
  `powershell.exe -Command` with a wrapper that stops on cmdlet errors, forces
  UTF-8 output, and exits with `$LASTEXITCODE`. The search order is
  `LBB_SHELL_PATH` (with `LBB_BASH_PATH` kept as an alias), Windows PowerShell,
  `pwsh.exe`, Git Bash, a PATH `bash`, a Git install found through `git.exe`,
  and finally `cmd.exe`. Windows PowerShell is first because it lives in
  System32 and every container can execute it. The Bash tool's description and
  the system-prompt lines now describe the grammar of the shell in use.
- **Prompt caching reaches further.** Every non-empty cache tier is marked on
  the Anthropic wire, since a mark below the provider's minimum is ignored
  without an error and the estimate has no upside. Tool definitions are sorted
  by name, so a server reconnecting in a new order no longer rewrites the
  prefix. `/cache` and the status line follow the current model's family after
  a switch or fallback. The idle compaction trim waits out a 24-hour cache
  retention instead of assuming the entry expired.

### Fixed

- **Scrolling up no longer duplicates the transcript.** A frame as tall as the
  terminal was treated as fullscreen by ink, which reprinted every sealed row;
  on ConPTY each such frame appended another copy to the scrollback. The frame
  is now capped one row below the viewport and anchored to the bottom, and
  opening and closing the Ctrl+O transcript no longer reprints the sealed rows.
  A permission dialog behind the transcript no longer answers keys.
- **Git Bash is found through `git.exe`.** Git for Windows puts only its `cmd`
  directory on PATH, and the `bash.exe` scan missed the install one level over;
  every command then ran under cmd.exe. cmd.exe commands also keep their quotes
  now, through node's shell mode rather than an argv item escaped as `\"`.

### Internal

- Test coverage is published from its own Ubuntu CI job: the reporter's table
  goes into the job summary and lcov is uploaded. It is not a gate.
- The Windows fixtures read the runner's own paths: PowerShell's cwd is
  compared in the spelling it reports, and the AppContainer timeout test uses
  a cmd builtin sleeper that needs no child process, pipe, file, or socket.

## 0.1.0.1 (Alpha) — 2026-10-24

Adds RPM and AppImage packages for Linux and brings the Kimi K3.1 Pro model
into the direct, Go, and OpenRouter catalogs.

[Release notes](https://github.com/zayokami/labunbun-code/releases/tag/v0.1.0.1-alpha.1)

## 0.1.0 (Alpha) — 2026-10-23

The first public alpha: a terminal coding agent with sandboxed tool
execution, provider migration, and offline binary inspection.

[Release notes](https://github.com/zayokami/labunbun-code/releases/tag/v0.1.0-alpha.1)
