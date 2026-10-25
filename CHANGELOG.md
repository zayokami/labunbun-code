# Changelog

What changed in each release. Release pages carry the download links, install
commands, and SHA-256 checksums.

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
