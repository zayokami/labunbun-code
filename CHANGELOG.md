# Changelog

What changed in each release. Release pages carry the download links, install
commands, and SHA-256 checksums.

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
