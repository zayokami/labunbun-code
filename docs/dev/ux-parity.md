# UX parity with Claude Code 2.1.289

This note compares the interaction surface of LaBunbun Code with Claude Code 2.1.289. It records the four gaps that the 2026-10-19 wave closed, the feedback the 2026-10-20 wave added, the parts that were already there, and the parts that this app will not build. Claude Code is proprietary. Every behavior here is a clean-room implementation from observed behavior. No source code and no prompt text moved between the two trees.

## What this wave added

| Area | Claude Code 2.1.289 | LaBunbun Code now | Code |
| --- | --- | --- | --- |
| Approval diff | The permission question shows a unified diff. Word-level highlight is available. `Ctrl+O` expands the tool card, not the question. | `Edit` and `Write` questions show a unified diff. `Ctrl+A` swaps in the raw input and swaps back. Every other tool keeps its one-line preview. | `packages/tui/src/permission-diff.ts:63`, `packages/tui/src/components/PermissionDialog.tsx:246` |
| Picker search | The `Select` base has a search mode. `/model` opens in it. `/resume` filters as you type. | Every `ListPickerDialog` filters on label and description. `/resume` and the other lists share the same four match tiers. | `packages/tui/src/filter-rank.ts:34`, `packages/tui/src/components/ListPickerDialog.tsx:131` |
| Session title | `/resume` offers `ctrl+r` rename. The name persists with the session. | `/rename <title>` writes a sidecar. The name replaces the directory name in the terminal title and becomes the `/resume` row label. | `packages/coding-agent/src/session-title.ts:19`, `packages/coding-agent/src/interactive.ts:3803` |
| Session preview | `/resume` offers `space` preview for the highlighted session. | `Space` opens a preview of the highlighted session in `/resume`. `Esc` closes the panel first, then the list. | `packages/coding-agent/src/session-preview.ts:133`, `packages/tui/src/components/ListPickerDialog.tsx:310` |

### Approval diff

The question is whether a change is acceptable. A JSON input asks the reader to align two escaped strings by eye. The diff shows the change in the shape it will take on disk.

- The view covers `Edit` and `Write` only. Any other tool, or an input whose fields do not fit, returns no diff and keeps the old preview.
- The body is a line-level LCS when each side has 20 lines or fewer. Above that bound the view shows one removed block and then one added block, and says so.
- A line is cut at 240 code points. The body is cut at 40 lines. Each cut adds a notice. A notice about omitted lines ends with `ctrl+a for the full input.`
- `replace_all` adds the notice `Every occurrence will be replaced.`
- ANSI escapes and control characters are removed. Tab is kept, because alignment is its job.
- `Ctrl+A` still shows the raw input. A second `Ctrl+A` returns to the diff.

### Picker search

- Typing appends to the query. Backspace and Delete remove one code point. `Ctrl+U` clears the query. `Esc` cancels.
- A row matches on its label or its description. The four tiers are prefix, word-start prefix, substring, and subsequence. A better tier sorts first. Items in the same tier keep their original order.
- The list shows 8 rows and scrolls around the highlight. The header reports `N matches`. An empty result reports `No matches`.
- The caller receives the original item index, not the position in the filtered view.
- `onHighlight` receives that same original index. The theme picker keeps its live preview behavior.

### Slash completion

- The completion list ranks command names and descriptions with the same tiers, without the subsequence tier. A subsequence match over a long command description is noise, not a match a person meant.
- The bare `/` still lists every command in table order.
- The list shows 8 rows around the highlight. An empty result reports `No matching commands`.
- Tab cycles the whole result. The window moves at render time, so the last row is reachable.
- The leading `/` is removed from both the text and the names before matching. This is what lets `session` match `/resume` through its description.

### Session title

- `/rename <title>` sets the title. `/rename` alone reports the current title or the usage. `/rename --clear` removes it.
- The title is normalized once, at the write and at the read: ANSI escapes and control characters are removed, whitespace runs collapse, one pair of wrapping quotes is dropped, and the result is cut at 80 code points.
- The title lives in `<session>.jsonl.title.json`, not in the transcript. The payload is `{ version: 1, title, updatedAt }`.
- A missing, damaged, or unknown-version sidecar means "untitled". It never blocks a resume.
- The terminal title becomes `labunbun — <title>`. The running suffix and the action-required suffix are unchanged. The same sanitize-and-cap choke point covers both.
- In `/resume`, a titled row shows the title as its label. The id, the date, the message count, and the first user message stay in the description. An untitled row keeps the old shape byte for byte.

### Session preview

- `Space` opens the panel when the query is empty. With a query, Space is an ordinary filter character, because a search field that eats spaces cannot search for a phrase.
- The panel reads only the last 128 KiB of the transcript. It walks the parent chain from the last entry, so an abandoned branch does not appear.
- The panel shows the last 6 messages, up to 12 lines, and cuts each line at 240 code points. Each cut adds a notice: `Showing the last N messages.`, `Showing the last N lines.`, or `Earlier messages not loaded.`
- A user message renders as `You: …`. An assistant text block renders as `Assistant: …`. A tool call renders as `→ <name> <first argument>`. Tool results and compactions are left out.
- The arrow keys reload the panel for the new row. Typing closes it. `Esc` closes the panel first; a second `Esc` leaves the list. `Enter` still chooses the row.
- A read is debounced for 120 ms, cached by path, and guarded by a generation. A slow answer for an old row cannot overwrite the current panel. A superseded request resolves `null` instead of leaving the dialog on `Loading preview…`.
- A file that cannot be read shows `Preview unavailable.` A readable file with nothing to show shows `No messages to preview.`

## Already at parity before this wave

| Area | LaBunbun Code |
| --- | --- |
| Session commands | `/resume`, `/tree`, `/fork`, `/compact`, `/trim`, `/context`, `/cache`, `/export` |
| File recovery | `/checkpoint`, `/rewind` (file content, from a pre-mutation ledger) |
| Planning | Plan mode, plan review dialog, saved plan, ordered steps on the task board |
| Permissions | Three modes, rule syntax, queue of pending questions, `Ctrl+A` raw input, subagent attribution |
| Lists | Theme picker with live preview, model picker, mode picker, shell and subagent pickers |
| Editing | Vim and Emacs engines, completion windows, prompt history |
| Queued messages | `Tab` queues a message; `Enter` steers at the next tool when the turn can take mid-turn text and queues otherwise. Previews above the prompt name the mode, and Esc reports what it dropped (`packages/tui/src/components/QueuedMessages.tsx:34-61`). |
| Terminal | Watch panel, `Ctrl+T`/`Ctrl+V`/`Alt+1..9`, DualShock 4 input |
| Agent surface | Subagents, skills, MCP prompts and resources, output styles, memory tiers, hooks |
| Other front ends | Headless text, JSON, and stream-JSON output; ACP editor sessions |

## The feedback wave (2026-10-20)

The failures this section covers are the ones the user could not see: a retry that looked like a hang, a fallback that changed the model silently, a partial answer that read as finished, a truncated result whose cut was invisible, and two dialogs that promised input they could not collect. The contracts behind the messages are in `error-handling.md`.

| Area | What the user sees | Code |
| --- | --- | --- |
| Retry | The status row reads `retrying attempt N · Xs` while the ladder waits, and keeps the attempt word after the countdown reaches zero until the stream resumes. The durable `retrying…` notice stays in the transcript. | `packages/tui/src/components/StatusLine.tsx:232-240`, `packages/tui/src/ui-state.ts:511-517`, `packages/coding-agent/src/interactive.ts:1748-1749` |
| Model fallback | A durable info line: `[model fallback] <provider>/<id> → <provider>/<id>: <reason>`. | `packages/tui/src/ui-state.ts:519-532` |
| Partial answer | The answer ends with a warning-colored `(response ended early; output is partial)`. | `packages/tui/src/components/MessageList.tsx:41-48`, `packages/tui/src/ui-state.ts:583` |
| Interrupted tool result | The result renders in the warning color with `(interrupted; output is partial)` and the label `interrupted`, not as a red failure. | `packages/tui/src/components/MessageList.tsx:239-243`, `:402-421`, `packages/tui/src/ui-state.ts:639-641` |
| Truncation | A compact tool result ends with `… N more characters · Ctrl+O for transcript`; the transcript view says `(output capped at 16,000 characters)`. `Ctrl+O transcript` is in the key help. | `packages/tui/src/components/MessageList.tsx:367-404`, `packages/tui/src/components/REPL.tsx:117-118` |
| Permission feedback | The fourth option opens a one-line field. Enter sends the sentence to the model as the denial reason; an empty field is a plain deny; Esc goes back to the list. A pad sends the plain deny, because it cannot type. | `packages/tui/src/components/PermissionDialog.tsx:104-115`, `:174-186`, `packages/tui/src/permission-options.ts:36-60`, `:165-170` |
| Free-text answer | A single-select question gains `Other…`, which opens a field. Enter submits a non-empty answer; Esc returns to the options; an empty field does not submit. Multi-select has no `Other…`. | `packages/tui/src/components/QuestionDialog.tsx:47-51`, `:96-105`, `:155-168` |
| Interrupt report | Esc says `[interrupted · N queued message(s) dropped · type a new message to continue]` and previews up to ten dropped messages. | `packages/tui/src/ui-state.ts:671-690`, `packages/agent/src/session.ts:290-300` |

Esc keeps its order: a dialog owns the press first, then the editor (insert mode, an `@` list, a half-typed command), then a command that declared itself cancellable, and only then the session (`packages/tui/src/components/REPL.tsx:676-693`). That order is what makes `/compact` cancellable without making Esc mean two things at once.

## Deliberately not built

| Feature | Why not |
| --- | --- |
| Split panes | The transcript is terminal scrollback after `<Static>` seals a row. A pane cannot re-lay out what the terminal owns. The measured design and its gates are in `docs/dev/split-pane-design.md`. |
| Mouse input | Ink 7.1.1 exposes no mouse events. Terminal selection and scrollback stay native. |
| Image paste | There is no clipboard image reader in the app, and a new image content block would touch the provider adapters. The value does not pay for that surface yet. |
| A keybinding JSON file | The key inventory is crowded, and the vim and Emacs engines already own large parts of it. A user map would need a conflict model before it needs a file. |
| Function keys | Measured in this tree: ink 7.1.1 delivers no bindable F-key sequence. It sends an empty input or splits Escape from the tail. |
| Conversation rewind | `/rewind` restores file content from checkpoints. Moving the conversation leaf backwards is `/tree` plus `/fork`, and it keeps the append-only file honest. A rewind that rewrote the leaf would make the file say something that did not happen. |
| A startup trust dialog | Project trust here is `/agents approve`, and it gates memory files, agents, skills, and output styles. It does not gate tool calls: the permission rules and the sandbox do. A second dialog would ask the same question with a different answer. |

## Tests that hold these claims

- `packages/tui/test/permission-diff.test.ts` and `packages/tui/test/components.test.tsx`: the diff body, the caps, the notices, the `Ctrl+A` swap, and the unchanged fallback.
- `packages/tui/test/filter-rank.test.ts`, `packages/tui/test/list-picker.test.tsx`, and `packages/tui/test/prompt-input.test.tsx`: the four tiers, stable order, the 8-row window, the original-index contract, the Space rule, and the two-stage `Esc`.
- `packages/coding-agent/test/session-title.test.ts`, `packages/coding-agent/test/rename-command.test.ts`, and `packages/tui/test/terminal-title.test.ts`: normalization, the atomic sidecar, the clear path, the `/resume` label, and the terminal title.
- `packages/coding-agent/test/session-preview.test.ts` and the preview group in `packages/tui/test/list-picker.test.tsx`: the tail read, the parent chain, the caps and notices, the requester, and the stale-answer guard.
- `packages/tui/test/status-battery.test.tsx`: the retry label counts down and keeps the attempt after the wait; `packages/tui/test/components.test.tsx` and `packages/tui/test/resume-replay.test.tsx`: the fallback line, the partial marker, the interrupted result, the truncation notes, and the dropped-message previews. `packages/tui/test/queued.test.tsx` holds the interrupt report against the queue state.
- `packages/tui/test/permission-options.test.ts`, `packages/tui/test/question-dialog.test.tsx`, and `packages/tui/test/pad-dialogs.test.tsx`: the fourth option's feedback field, `Other…` on a single-select only, the empty-field and Esc rules, and the pad's plain deny.
