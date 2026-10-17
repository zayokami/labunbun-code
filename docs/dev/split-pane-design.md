# Split panes

Whether this TUI can show two things at once. The request behind the note is one sentence — a split screen — and the honest answer is three statements:

- **A split of the transcript is not possible under this rendering model, and no layout work changes that.** The transcript's older rows live in the terminal's scrollback, printed once and no longer in any structure the app can re-lay out (`packages/tui/src/components/MessageList.tsx:489`; measured below). A two-column view would have to re-wrap rows that are no longer the app's to touch.
- **A read-only watch panel is possible**, in the frame that already repaints on every keystroke, while the user keeps typing. It cannot be the transcript, but it can be the thing the request is usually about: a background shell's output tail.
- **A full-screen workspace with real panes is mechanically available** (ink 7.1.1 ships an unused alternate screen; measured) at the price of the terminal scrollback, a full clear-and-reprint on the frame path measured on Windows, and an input-focus system this app has never had. It is the last phase of the plan, gated on whether the watch panel earns it.

P1 of this plan has shipped (`3e97a67..5f636bf`): the read-only watch panel, `packages/tui/src/components/WatchPanel.tsx`, opened by `Ctrl+T` and closed by it or Escape (`packages/tui/src/components/REPL.tsx:582-587`, `:566-569`). The first slice of P2 has shipped as well (`5be767e..68630bc`): the panel draws three sources — each background shell's tail, the subagent listing, the session's cost/context facts — and `Ctrl+V` walks that ring (`packages/tui/src/components/REPL.tsx:598-604`; the cycle is two pure functions, `packages/tui/src/components/WatchPanel.tsx:108-138`). The second slice has shipped (`5726a24`): each shell header's gutter carries the shell's number and `Alt+1..9` jumps straight to it (`packages/tui/src/components/REPL.tsx:617-625`; the rule is `jumpWatchSelection`, `packages/tui/src/components/WatchPanel.tsx:152-156`, and it stands down under the emacs engine, which owns the key — see the key inventory). The rest of the note is still a gate rather than a record: the panel takes no keys of its own (the REPL owns the walk and the jump), it cannot become a right column, it has no full view, and the full-screen workspace (design A) is not built. What shipped against this plan, and what each open decision settled to, is recorded under P1/P2 and the open decisions below.

## What a pane would be for

Four candidates were weighed, by what the user is looking at and where that data already lives:

| The user is | What they want beside the prompt | What serves it today | Ready for a pane |
| --- | --- | --- | --- |
| Waiting on a dev server started with `run_in_background` | The shell's recent output, live | `list()` and `output()` on the shell manager (`packages/tools/src/background.ts:555`, `:544`), a 2 s poll (`packages/coding-agent/src/background-commands.ts:26`), a tail formatter (`:70`), a one-line status row (`packages/tui/src/components/StatusLine.tsx:91`) | Yes — every piece exists |
| Waiting on a subagent | Its status, and what it is doing | Listing and ordering (`packages/coding-agent/src/subagent-commands.ts:18`, `:68`), a retention cap of eight (`packages/coding-agent/src/subagent-registry.ts:26`); no live subscription to a running handle's stream exists | Listing yes, live stream no |
| Reviewing what the agent changed | A diff that updates as it works | The file checkpoints `/rewind` restores from are written before each Edit/Write mutates a file (`packages/coding-agent/src/checkpoint-log.ts:322`, called from `packages/coding-agent/src/interactive.ts:1326-1329`); nothing computes a live diff | No — new plumbing |
| Watching the task list | The tree | Already inline above the prompt: `TaskStrip` (`packages/tui/src/components/REPL.tsx:871`) | Done — nothing to add |

The user stories reduce to two shapes, and only one of them needs a pane:

1. "I started a ten-minute build in the background and I want to keep working while it runs, watching its tail." The status row already names the shell; the tail currently costs four keystrokes and a picker (`/ps`, `packages/coding-agent/src/interactive.ts:3256-3272`) and then arrives as one static info block in the transcript — the opposite of watching.
2. "Show me the transcript beside the thing I am watching." This is the one that cannot be built under the current model, and the rest of the document says why.

## The rendering model a pane has to live in

### The transcript is scrollback, not a buffer

`VirtualMessageList` keeps the newest eight entries live and seals everything older into ink's `<Static>` (`packages/tui/src/components/MessageList.tsx:411`, `:489`). `<Static>` prints its children once and takes them out of the tree — its own comment says so (`packages/tui/src/components/MessageList.tsx:428`), and a spike confirmed it byte by byte:

- Editing the *content* of a sealed row produced **zero writes**. The edit is invisible; the row is no longer rendered.
- Narrowing the terminal from 40 to 20 columns wrote **only the live row** — sealed rows were not re-wrapped, because re-wrapping is a layout step that no longer happens to them.
- Appending one item printed **only the new row**, above the live region.

So the transcript on screen is not a region the app repaints; it is history the terminal owns. The one way back is the wipe-and-reprint path the app already uses for theme changes (`packages/tui/src/app.tsx:274-300`), `Ctrl+L` (`packages/tui/src/components/REPL.tsx:637-654`) and the transcript paint key (`packages/tui/src/components/MessageList.tsx:439-448`) — a full screen wipe followed by reprinting rows at full width, driven from `entries` data the store still holds.

The `Ctrl+O` transcript does not contradict any of this, and it is worth being precise about why: it does not re-lay out what is on screen. It renders a fresh window of the last twenty-five `entries` (`packages/tui/src/components/REPL.tsx:851-865`) — a second render from data, full width, hiding the main screen rather than splitting it. It is a screen, not a pane, and the difference is the whole note.

### The frame, and its ceiling

What the app *does* repaint is the frame: the live tail, the streaming preview, the task strip, the status block, dialogs, the prompt — everything below the sealed rows. Measured on a 40-column fake TTY, a width change rewrote the frame with erase codes and fresh text (`\x1b[2K\x1b[1A\x1b[2K\x1b[G` + the live row); a 20-row frame on an 80×24 terminal cost 15.8 ms/update including the harness's own 4 ms sleep, 477 bytes per write. ink throttles frames to 30 fps (`packages/tui/node_modules/ink/build/ink.js:194`), so the budget is met with room to spare — while the frame stays below the terminal.

The ceiling matters more than the cost. When the frame's height reaches the viewport height, ink leaves the incremental path: `renderInteractiveFrame` writes `clearTerminal + fullStaticOutput + frame` (`packages/tui/node_modules/ink/build/ink.js:748-768`), and `fullStaticOutput` is the accumulated reprint of every sealed row the session has produced (`ink.js:416`) — it grows with the session. On Windows the condition is not an edge case: `shouldClearTerminalForFrame` returns true whenever the frame was or is fullscreen (`ink.js:100`), so every frame clears. The spike measured exactly that shape — each frame wrote `\x1b[2J\x1b[3J\x1b[H` followed by the sealed row and all twelve frame rows, again and again. Note the `3J` in ink's erase: the repo strips `3J` from its own wipe on a Console host because it eats the scrollback (`packages/tui/src/components/REPL.tsx:130-138`, `packages/tui/src/conpty.ts:28`, pinned by `packages/tui/test/repl-clear-screen.test.tsx:124`); ink's internal clear is not stripped. The consequence for a design: **a panel must budget its rows so the frame never approaches viewport height.** This is why a "just add a pane at the bottom" design is not free even though it touches no new rendering machinery.

### Alternate screen is available and unused

ink 7.1.1 ships the option (`packages/tui/node_modules/ink/build/ink.d.ts:70-72`), enters on mount and leaves on unmount (`ink.js:702`, `:549`); the spike measured `\x1b[?1049h` on mount and `\x1b[?1049l` on unmount. `mountRepl` passes only `{ exitOnCtrlC: false }` (`packages/tui/src/app.tsx:439`) — this tree has never entered the alternate screen.

What it buys: a screen the app owns completely, where nothing is scrollback, so panes can be laid out, re-laid out, and scrolled by the app on every frame. What it costs: the user's terminal scrollback and the transcript that currently lives in it — both are replaced by whatever the workspace re-renders from data. It also moves, rather than removes, the ceiling: inside a workspace nothing is sealed into `<Static>` (the panes render windowed slices with their own scroll offsets), so `fullStaticOutput` stays empty and the clear is one screen's worth of bytes per frame — but it is still a clear per frame on the Windows path.

### Input has no focus system

Routing is not a tree. Every listener that is active receives every key — measured directly: two `useInput` hooks both received `q`, and a third with `isActive: false` received nothing. Components guard themselves (`packages/tui/src/components/PromptInput.tsx:390`, `:491`, `:723`; `packages/tui/src/components/ListPickerDialog.tsx:146` has no guard and relies on where it is mounted). ink ships `useFocus` and `useFocusManager` and nothing in this tree uses them. A pane that takes keys would be the first thing here to need a focus model; a pane that is read-only sidesteps the problem entirely, which is a large part of why the recommendation below is read-only.

The key inventory is tight, and one part of it is closed by measurement:

- **Function keys are unusable.** Fed `\x1bOP`, `\x1bOQ`, `\x1b[11~` and `\x1b[12~` (the two sequence families terminals send), ink 7.1.1 delivered `input: ""` with no flags every time; delivered in two chunks it delivered Escape followed by the tail as literal text (`OP`, `12~`). There is no bindable F-key in this version.
- The ctrl letters are crowded:

| Key | Held by |
| --- | --- |
| `C-o` | transcript toggle (`packages/tui/src/components/REPL.tsx:570-574`) |
| `C-l` | clear screen (`packages/tui/src/components/REPL.tsx:637-654`) |
| `C-c` | interrupt / idle exit (`packages/tui/src/components/REPL.tsx:670-689`) |
| `C-r` | prompt history search (`packages/tui/src/components/PromptInput.tsx:566`) |
| `C-a`, `C-e`, `C-w`, `C-k`, `C-u`, `C-y`, `C-_` | line editing (`packages/tui/src/components/PromptInput.tsx:651-694`) |
| `C-q`, `C-g`, `C-s`, `C-r` (emacs spelling) | reserved by the emacs engine and consumed there (`packages/tui/src/emacs.ts`). What that consumption takes was measured, and it is narrower than this table first recorded: the claim is made inside the prompt's own `useInput`, and ink delivers each key to every active hook separately (`node_modules/ink/build/hooks/use-input.js:115-123`) — so `C-r` is gone (history search is a prompt-level branch, `packages/tui/src/components/PromptInput.tsx:566`). `C-t` and `C-o` are host-owned — the watch panel and the transcript — and the 3a cleanup withdrew the engine's declarations, so the engine neither claims nor consumes them. The measurement still stands: while the engine did claim both, the REPL received both keys and the panel and the transcript opened under emacs (`packages/tui/test/watch-panel.test.tsx`, frame-measured). The shortcuts overlay names the host action in every editor (`packages/tui/src/shortcuts.ts`) |
| `M-1`..`M-9` | the watch panel's jump key, and `digit-argument` in the emacs engine (`packages/tui/src/emacs.ts:1292-1296`). Free with no editor and under vim; under emacs the REPL's branch stands down so one press is one action, not an armed count plus a jump (`packages/tui/src/components/REPL.tsx:617-625`) |
| `C-v` | held by the watch panel's source cycle (`packages/tui/src/components/REPL.tsx:598-604`); no editor in this tree contests it — no handler in the emacs engine, none in the prompt, and the vim engine hands all ctrl combos to the host by design (`packages/tui/src/vim.ts:2632-2643`). The one place it can be swallowed is the terminal: Windows Terminal's default keymap sends `Ctrl+V` to paste, a real-machine check recorded under the open decisions |

- Escape has per-screen conventions already: dialogs own it when mounted, the activity panel closes on it (`packages/tui/src/components/REPL.tsx:554-557`, `packages/tui/src/components/ActivityPanel.tsx:361`), the transcript leaves on it (`packages/tui/src/components/REPL.tsx:631-634`). A recorded wrinkle sits in the code: `Ctrl+O` while the activity panel is up leaves the prompt disabled with nothing on screen explaining why — "a confusing state, not a lock", with the missing rule named but unshipped ("a modal screen owns the view-switch key", `packages/tui/src/components/REPL.tsx:541-553`). Every new panel or screen multiplies this interaction, and the watch panel design has to take a position on it rather than inherit it silently.

## Candidate designs

### A. Full-screen workspace on the alternate screen

**Shape.** Opening the workspace enters the alternate screen (ink's `alternateScreen: true`, either on a second render or by remounting) and renders a flex row of panes: transcript pane, watch pane, task pane. Nothing inside uses `<Static>`; the transcript pane renders a window of `entries` it scrolls itself. A focus model routes keys to the focused pane; the rest of the app's dialogs and the `Ctrl+O` screen stay outside the workspace, unchanged.

**Trade-offs.**
- Real simultaneity and real re-layout — the only design that delivers the literal request. Panes can be resized, reordered, added.
- The terminal's scrollback is gone while the workspace is open, and the transcript comes back as a re-rendered facade. Nothing is lost (the store holds `entries`; text is capped per entry at `packages/tui/src/ui-state.ts:308`), but the user's paging, selection and copy habits change in one step.
- Every frame is a clear plus redraw on the Windows path. One screen's bytes at 30 fps is affordable in theory; Windows Console write throughput at that rate is unverified (see risks).
- The blast radius is the whole TUI: focus is new, the pane scroll model is new, and the existing suite mounts through `ink-testing-library`, where alternate-screen codes and focus semantics reach every test file.

**Implementation surface.** `packages/tui/src/app.tsx` render options; a workspace component beside `REPL.tsx`; scroll offsets in `ui-state.ts`; a focus module; the watch data plumbing shared with B.

**Risks.** Real-terminal behavior of `1049h` under Windows Console/ConPTY (unverified); dialogs and pickers rendered from inside a workspace; the theme-repaint remount path (`packages/tui/src/app.tsx:274-300`) replayed into a fullscreen context; copy from the alternate screen.

### B. A watch panel in the frame (read-only, toggled) — shipped as P1

**Shape.** A bordered panel in the same bottom block the activity panel already occupies (`packages/tui/src/components/REPL.tsx:871`, the panel itself at `:932`), toggled by a key, closed by the same key or Escape. It renders rows and takes no keys of its own, so the prompt keeps the keyboard and typing continues while it is open — which is the point. Phases widen the sources; P1 is one background shell's tail on the existing 2 s cadence.

**Trade-offs.**
- No new rendering machinery: same frame, same paint contract, and a test template that already exists (`packages/tui/test/activity-panel.test.tsx:209`).
- Scrollback, key behavior and every existing guard stay as they are. The feature is additive in the strongest sense.
- It cannot show the transcript. It is a window on a *source*, not a second view of history.
- It spends vertical budget against the ceiling above. The height must be clamped from `useWindowSize().rows` — the precedent cited here was wrong about what it is: `packages/tui/src/components/ActivityPanel.tsx:325` reads `columns`, and nothing in this tree reads `rows`, so the panel is that hook's first user and its tests need a fixture that overrides `rows` the way the activity panel's tests override `columns` — with a reserve for the live tail, streaming preview, status block and a multi-line prompt — and the reserve needs a real-terminal check, because the spike measured the fake-TTY path only.
- It must answer the recorded `Ctrl+O` wrinkle: while the panel is open, `Ctrl+O` either wins (panel hides with the screen and returns with it) or is muted; silence is not an option, and the choice needs a pinning test.

**Implementation surface.** REPL state, one key, one render slot; `packages/tui/src/components/WatchPanel.tsx`; the poll in `packages/coding-agent/src/interactive.ts:2092-2101` publishes each shell's tail (`SHELL_TAIL_LINES = 8`, `:2076`) through the app handle (`setBackgroundShells`, `packages/tui/src/app.tsx:189`); a shortcuts row (`packages/tui/src/shortcuts.ts:128`); tests in `packages/tui/test/watch-panel.test.tsx`, modeled on `packages/tui/test/repl-transcript.test.tsx:70` and `packages/tui/test/activity-panel.test.tsx:209`.

**Risks.** The height ceiling (measured path, fake TTY only); a tail that lags 2 s behind a noisy shell (acceptable for watching, wrong for debugging — the panel should say what it is); a second source of truth for "which shell am I watching" if the user stops the shell from elsewhere.

### C. View screens: the `Ctrl+O` pattern generalized

**Shape.** Keep the screen pattern and add siblings: shell output, subagent list, diff. One at a time; the prompt stays mounted under `display={... ? "none" : "flex"}` so drafts survive, exactly as `Ctrl+O` does (`packages/tui/src/components/REPL.tsx:967`) and as `packages/tui/test/repl-transcript.test.tsx:70` pins.

**Trade-offs.**
- Cheapest to build and to test; reuses a pattern that already survived a bug cycle (the unmount variant lost drafts).
- Answers "let me look at it", never "let me watch it while typing". It is the same information the watch panel shows, minus simultaneity.
- It also spends no vertical budget and touches no new machinery.

**Implementation surface.** Generalize the `transcriptMode` boolean into a screen value (`packages/tui/src/components/REPL.tsx:505`); one component per source, shaped like the transcript branch (`:858-865`).

**Risks.** The modal-screen key wrinkle, again, per screen; and scope creep — five screens is a key map, not a feature.

## Recommendation and plan

The spine is **B**, with **C** as its natural enlargement (a panel key held with a modifier, or a pager inside the panel, becomes a screen when a source outgrows the height budget), and **A** deferred behind evidence.

### P1 — watch panel, background shells only

**Shipped** at `3e97a67..5f636bf`. Two details landed differently than this plan wrote them — the panel takes no input to pick a shell: it watches the last running shell, else the last (`packages/tui/src/components/WatchPanel.tsx:84-89`), and marks that shell's header with a `▶` two-column gutter so the reader can tell whose tail the rows below are — and its header rows carry id, command and status but no `shellAge` (`:347-352`). Picking a shell by key has since shipped with P2's first slice, and it kept the same posture: the panel still takes no keys at all — the ring is walked by the REPL and arrives as the `selection` prop; the jump key arrived the same way, and the gutter's second column is where the number it names is drawn. Of P2 the source cycling and the jump are built; the right column, the full view and all of P3 are not. The key and the placement were settled from the recommendations below (`Ctrl+T`, the bottom band); the shipped panel adds one refusal this plan did not name: `Ctrl+T` is ignored while the transcript is up (`packages/tui/src/components/REPL.tsx:582-587`).

- Toggle `Ctrl+T` (recommendation; see open decisions), Escape closes. While open the prompt keeps every key and the panel takes none. While a dialog is up, the toggle key is ignored — the least surprising of the available rules until "a modal screen owns the view-switch key" is written for real.
- Content: one header row per running shell (id, elided command, `shellAge`, all already written — `packages/coding-agent/src/background-commands.ts:34`) and the tail of the selected shell, newest first by start order, from `liveOutputLines`/`formatShellOutput` (`packages/coding-agent/src/background-commands.ts:70`).
- Height: `min(desired, rows - reserve)`, never more; the reserve covers the live tail's worst realistic case, the status block and the prompt, and it is documented in the component rather than tuned invisibly.
- Cadence: the existing 2 s poll (`packages/coding-agent/src/background-commands.ts:26`); no timer of the panel's own. The panel must render "as of the last poll" honestly if a shell ended between polls.
- Tests: a panel component test (template `packages/tui/test/activity-panel.test.tsx:209`), a REPL-level test that the toggle leaves the draft intact and keys typed with the panel open go to the prompt (template `packages/tui/test/repl-transcript.test.tsx:70`, including its spelling discipline for keys that mean nothing), and a `shortcuts.test.ts:74` row.

### P2 — more sources, and the side-by-side variant

- **Source cycling — shipped** (`5be767e..68630bc`), the first slice of P2. The ring is every background shell's tail in manager order, then the subagent listing (`packages/coding-agent/src/subagent-commands.ts:18`, `:68`, formatted for the panel by `formatSubagentWatchLines`), then the session facts a `/status` otherwise costs; one `Ctrl+V` press per step, wrapping (pure functions at `packages/tui/src/components/WatchPanel.tsx:108-138`; the REPL's branch at `packages/tui/src/components/REPL.tsx:598-604`). Picks are shell ids, not positions, so the walk survives the list reordering under it. Live subagent streams are still not built and remain their own decision.
- **Jump to a shell — shipped** (`5726a24`), the second slice of P2. Every shell header's gutter carries the shell's number (`▶1 shell_1`, ` 2 shell_2`, `·` past the ninth) and `Alt+1..9` jumps to it — the number is the manager's order, the same order the cycle walks, and the answer is the shell's id, not a position (`jumpWatchSelection` at `packages/tui/src/components/WatchPanel.tsx:152-156`; the REPL's branch at `packages/tui/src/components/REPL.tsx:617-625`). A number past the list does nothing rather than landing on a neighbour. The branch stands down under the emacs engine, where `M-1`..`M-9` are `digit-argument` and one press would otherwise both arm a count and move the panel; with no editor and under vim the key is free.
- Width-adaptive placement: when the terminal is wide (a threshold, measured at P2, not guessed), the panel may become a right column beside the live tail. Be honest in the code about what that is: a split of the *live area*, with history still full width above it. **Not built.**
- A "full view" action from the panel into a C-style screen for sources that outgrow the rows. **Not built** — no key decided.

Two P2 decisions were settled by a user call on 2026-10-14 and are recorded under the open decisions: the cycle is one key walking a ring rather than a picker, and that key is `Ctrl+V`. A third was settled a day later, when the jump shipped: `Alt+1..9` onto the number each header draws (2026-10-15, entry 6 below). The one check this machine cannot make is terminal-level paste; until the ten-second real-terminal check passes, `Ctrl+V` carries it as a recorded trade.

### P3 — full-screen workspace (design A), gated

Only if P1/P2 show the need for true simultaneity *and* the user accepts losing the terminal scrollback for the duration. Preconditions before any code: a real-ConPTY measurement of alternate-screen entry, exit, and clear-per-frame cost; a decision on selection/copy; and a focus design reviewed against every existing `isActive` guard.

### What not to build

A two-column split of the transcript itself. The sealed rows cannot be re-wrapped (measured), so a surface that showed history side-by-side would first have to reprint the whole session full width and lie about it, or hold the session in data and stop using the terminal's scrollback — which is design A, not a small feature. A degraded "split" that silently reprints history above a two-column live area would be a lie about what the user is looking at, and the shape of that lie is the one this document exists to avoid.

## Measured

Method: a discardable spike (`packages/tui/spike-pane.tsx`, deleted before the commit that added this note), run under bun against a fake TTY — an `EventEmitter` stdout with `write`/`isTTY`/`columns`/`rows` and a resize emitter, and a fake stdin that buffers and emits `readable` (ink 7 reads via `readable`, not `data`). `interactive: true`, ink 7.1.1, Windows host. No PTY is available on this machine, so every number is ink's behavior against a terminal that never answers back.

| # | Question | Result |
| --- | --- | --- |
| 1 | Does `<Static>` re-render sealed rows? | No. Content edit: 0 writes. Width 40→20: only the live row rewritten (sealed rows not re-wrapped). Append: only the new row printed. |
| 2 | What does a frame at least viewport-height do? | Every frame wrote `\x1b[2J\x1b[3J\x1b[H` + the sealed `<Static>` output + all frame rows. Clear and reprint, not diff. |
| 3 | Does `alternateScreen: true` work in 7.1.1? | Yes. Mount wrote `\x1b[?1049h`; unmount wrote `\x1b[?1049l`. |
| 4 | Cost of updating a 20-row frame (80×24, below the ceiling) | 60 updates → 63 writes, 29.3 KB, 15.8 ms/update wall including the harness's 4 ms sleep, 477 bytes/write. |
| 5 | Do two active `useInput` hooks both get a key? | Yes — `q` reached both; an `isActive: false` hook received nothing. |
| 6 | Does memoizing 19 of 20 rows change case 4? | 15.7 ms/update and 398 bytes/write — indistinguishable from case 4 at this resolution. The cost is the frame path, not the row render. |
| 7 | Can function keys be bound? | No. `\x1bOP`, `\x1bOQ`, `\x1b[11~`, `\x1b[12~` all delivered `input: ""` with no flags (chunked delivery: Escape, then the tail as literal text). `C-p`/`C-g`/`C-b`/`C-t` arrived as `{input, ctrl: true}` normally. |

Two readings that carried the design: #1 is the constraint (the transcript is not repaintable), #2 is the ceiling and its price (a full frame clears and reprints history, and `3J` is in the erase), #7 is why the toggle key is a ctrl letter and not a function key.

## Risks and unknowns

- **Real terminals were not measured.** Everything above is ink's bytes against a fake stdout. Alternate-screen behavior under Windows Console/ConPTY, and the clear-per-frame path on a real screen, are unverified — no PTY was available on this machine.
- **The non-Windows clear path is read, not measured.** `shouldClearTerminalForFrame` (`packages/tui/node_modules/ink/build/ink.js:89-112`) was exercised on the win32 branch only; the exact-fill incremental path for other platforms comes from source.
- **ink's erase carries `3J` and the repo's does not.** `clearTerminal` includes the scrollback wipe (`ink.js:768`, measured bytes in #2). The repo strips it for Console hosts in its own wipe (`packages/tui/src/components/REPL.tsx:138`) because of what it costs a scrolled-up reader. What a Console host does when ink's own path takes it, once per frame, has not been watched.
- **The 2 s poll is a display cadence.** A noisy shell shows a tail that is stale by up to the interval; fine for watching, wrong if the panel is ever pitched as live debugging output.
- **The subagent live stream does not exist yet.** Only listing and formatting exist; what subscribing to a running handle's output would cost was not investigated.
- **The diff source is unscoped.** The checkpoint ledger stores the material `/rewind` needs; a live diff pane needs its own computation and rendering decisions (which files, how much, at what cadence) — a design on its own.
- **Focus is new territory if A is built.** Nothing in the tree uses ink's focus hooks; every `isActive` guard would need auditing in the workspace context.
- **Selection and copy from any non-scrollback surface** (alternate screen or a large panel) is a terminal-concern this note does not resolve and users will notice first.
- **The frame ceiling is live today.** A long live tail, a big dialog or a large paste can already push the frame to viewport height and take the clear-and-reprint path; the panel raises the probability and must budget for it, but it would not introduce the mechanism.

## Open decisions

Each needed a user call before P1 started. The first three were settled by the shipped panel, from the recommendations here — `Ctrl+T`, the bottom band, background shells only. The fourth was settled by a user call on 2026-10-14, along the same lines, and the fifth and sixth came with the P2 slices:

1. **The toggle key.** Recommendation: `Ctrl+T` — unclaimed by the app, the prompt and the vim engine, and reachable in the default editor mode. Under the emacs editor the engine no longer claims it: the 3a cleanup withdrew the engine's declarations for `Ctrl+T` and `Ctrl+O`, so both keys are host-owned — the watch panel and the transcript — and the shortcuts rows name those actions in every editor (`packages/tui/src/shortcuts.ts`). This entry first read "the engine eats it" and that was wrong: measured later (see the key inventory above), a reserved-key claim was made inside the prompt's own `useInput` and the REPL kept receiving the key, so both `Ctrl+T` and `Ctrl+O` already worked under emacs before the declarations were removed. The alternative is `Ctrl+V`, cleaner in-tree still (no engine claims it, `packages/tui/src/vim.ts:2632-2643`) but exposed to terminal-level paste — Windows Terminal's default keymap sends `Ctrl+V` to paste — which is a ten-second check on the user's real terminal that this machine cannot make (no PTY). If `Ctrl+V` survives that check it is the better key; otherwise `Ctrl+T` is the fallback. Function keys are ruled out by measurement, not preference.
2. **Panel placement.** Recommendation: the bottom band above the prompt, where the activity panel already lives. The right-column variant is a P2 question and only at wide terminals; a right column splits the live area, not the transcript, and may read as a split without being one.
3. **P1 scope.** Recommendation: background shells only — the one source whose plumbing is complete. Subagents and diffs are P2/P3 questions with their own unknowns.
4. **Is the full-screen workspace (A) a goal at all?** Decided — **not now; A stays P3** (user call, 2026-10-14). The trigger to revisit is the one recommended here: the watch panel's actual usage shows people needing the transcript and the watch *at once*, with the scrollback trade accepted explicitly at that point. Until the trigger fires, no design work is owed on A — the focus audit, selection and the diff pane stay attached to this entry, not to the panel that shipped.
5. **The P2 cycle key and the ring's order.** Decided — **one key, `Ctrl+V`, walking shells → subagents → status and wrapping** (user call, 2026-10-14). Alternatives weighed: `C-n`/`C-p` (two keys, no ring-order question, but two keys where the panel's own note row advertises one), `Tab` (taken by completion at the prompt), and a picker key (a dialog to choose between two rows is heavier than the panel). No editor in this tree contests `Ctrl+V` — the one place it can be eaten is the terminal: Windows Terminal's default keymap sends `Ctrl+V` to paste, so the key may never reach the app there. **Unverified on a real terminal** (this machine has no PTY). The ten-second check: copy some text, press `Ctrl+V` at the prompt, watch what happens — pasted text means the terminal ate the key and the cycle moves to `C-n`/`C-p` (the panel's note row is the one place the key is advertised, so the note moves with the decision); no paste and no change to the draft means the walk above is live. Until that check has been run, this is a recorded trade, not a verified choice.
6. **The jump key.** Decided — **`Alt+1..9` jumps to the shell whose header gutter carries that number** (user call, 2026-10-15). Alternatives weighed: a picker (a dialog to choose between rows the panel is already drawing), `C-n`/`C-p` (chosen as the cycle's fallback, but two keys where the numbering already gives a one-key map), and `)` / `(` (`next-error`/`previous-error` in Emacs, which would make the panel's own P1 promise — "takes no keys of its own" — depend on an editor's vocabulary). The number is drawn where the press looks: the gutter of the header it names. `M-<digit>` is the one contested key here — `digit-argument` in the emacs engine (`packages/tui/src/emacs.ts:1292-1296`) — and since ink delivers each key to both the engine and the REPL, the jump branch stands down under emacs rather than letting one press arm a count and jump at once; the shortcuts row says "taken" there in the vocabulary the `Ctrl+R` row uses. Whether the tenth shell on should be jumpable (a second keystroke after `Alt+9`, or a picker) is not decided; today a number past the list does nothing and the gutter says `·`.

## Tests that hold these claims

The claims above rest on measurements and on existing tests that a split-pane feature must not break:

- `packages/tui/test/repl-transcript.test.tsx:70`, `:92`, `:113` — the screen pattern as shipped: the draft survives the switch, keys meaningless on the screen stay out of the prompt, and the window is exact. A watch panel is held to the same contract, and the harness is its template.
- `packages/tui/test/watch-panel.test.tsx` — the P2 source ring: `watchRing`/`nextWatchSelection` walked edge by edge (wrap in both directions, the first press steps past the automatic shell, a pick whose shell has left the list restarts at the head), the two published stops rendered, and the REPL-level walk with keys typed at the panel landing in the prompt. The jump's edges live there too: `jumpWatchSelection` for every number the key has, `null` past the list and for an empty list, the drawn numbering on a full list of nine (and `jumpDigit`'s `·` edge directly, which no frame today can draw — the budget tops out at nine headers), the REPL-level jump moving the marker and the tail together, a plain digit still landing in the prompt, the closed panel's key doing nothing, and the emacs gate where the engine's count fires and the panel does not move. The same file holds the frame measurement that falsified the "taken" wording: with the engine on, `Ctrl+T` and `Ctrl+O` still reach the REPL. The rings and the rules live in pure functions for exactly this reason — a cycle that can only be exercised through a terminal is a cycle half of whose edges are never tested.
- `packages/tui/test/repl-clear-screen.test.tsx:124` — the repo's wipe stops at the screen on a Console host because `3J` eats the scrollback. This is the test that says why the frame must never reach viewport height on Windows, and why ink's unstripped `clearTerminal` is a risk rather than a style point.
- `packages/tui/test/activity-panel.test.tsx:209`, `:248` — the closest existing inline panel: it measures the terminal for its own layout and takes Escape. The watch panel's sizing should be testable the same way, from a pure function, not from a terminal snapshot.
- `packages/tui/test/theme-repaint.test.tsx:43`, `:92` — the wipe-and-reprint contract the current model depends on; any pane must keep its behavior when the theme changes under it.
- `packages/tui/test/transcript-render.test.tsx:41`, `:62` — the sealing boundary itself, the constraint in test form.
- `packages/tui/test/shortcuts.test.ts:74` — every advertised shortcut names a key that exists per editor; the panel's rows (toggle, cycle, jump) must pass it, and the emacs table's reserved keys must not be contradicted. The `Ctrl+T`/`Ctrl+O` rows name the watch panel and the transcript in all three editors; those two keys are host-owned, no longer appear in the engine's reserved table, and `packages/tui/test/shortcuts.test.ts` pins that absence.
- ink's `build/components/Static.js` (dependency, unmodified) — print-once semantics as shipped; the spike measured the same behavior through the public surface.
