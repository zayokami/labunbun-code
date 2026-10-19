# Error handling and interruption

A failure the user cannot see is a failure the user cannot act on. This note covers the seams that turn a failure into something visible and, where a next step exists, name it: a run that could not start, a session file that cannot be read, a settings tier that did not load, a provider that failed, a turn the user interrupted, and a command the user cancelled. The rules are the same in every host; only the surface differs, because a terminal, a scripted `-p` run, and an editor session have different places to look.

Three promises hold the design together:

- A run that emits `agent_start` always emits `agent_end`, including when admission fails before the first turn.
- A marker on a message is persisted with it. A resumed session can still say "this answer is partial" or "this result was interrupted", not only the live one.
- A write that fails leaves memory where the file is, so the session never sends a message no resume can find.

## The admission failure contract

`prompt()` throws in exactly one case: another run is already live (`packages/agent/src/session.ts:338-340`). Every other failure is the run's own, and ends through the normal event stream.

- The `try` opens before admission (`packages/agent/src/session.ts:366`), and `agent_start` is emitted before the first message is admitted (`:367-370`). A subscriber therefore sees the run open and close even when the hook that builds the first user message, or the session file that receives it, fails.
- `#admitMessage` writes to the store first and pushes into the live array second (`packages/agent/src/session.ts:280-283`). A failed append leaves the array untouched; the caller still holds the text.
- The entry-point drain peeks, admits, then shifts (`packages/agent/src/session.ts:380-388`). A queued message whose write fails stays queued for the next run instead of disappearing with the error. The in-loop drain uses the same order (`:687-692`).
- Any throw from the body is caught by the loop's `catch`, which sets `reason = "error"` and records the message (`packages/agent/src/session.ts:714-716`).
- The `finally` clears `#running`, clears the abort controller, computes the host's remedy, and emits `agent_end` (`packages/agent/src/session.ts:721-735`). The event carries `reason`, `messages`, `errorMessage`, and, when they exist, `errorKind`, `errorRemedy`, and the queue an abort dropped (`packages/agent/src/types.ts:533-551`).

The event pair is a contract, not an artifact of the happy path: `agent_start` is emitted before admission so a failure cannot produce an `agent_end` for a run nobody saw begin (`packages/agent/src/types.ts:533-538`).

`followUp()` calls `prompt()` without awaiting it when no run is live. A `#running` race between the check and the call is caught and dropped, because there is no run to report it against and an unhandled rejection would take the process down (`packages/agent/src/session.ts:242-252`).

## Session files that cannot be read

The store distinguishes "nothing is there" from "something is there and the process may not read it".

- `SessionReadError` carries the path and the underlying cause (`packages/agent/src/session-store.ts:130-139`).
- `load` returns an empty store for a path that does not exist, or that vanishes between the existence check and the read (`ENOENT`, `ENOTDIR`) (`packages/agent/src/session-store.ts:193-228`). Anything else — a directory where a file was expected, a permission refusal — throws `SessionReadError` (`:225-226`). Reporting one of those as "no such session" would be a lie about a file the user can see in the listing.
- `append` writes the line first and adopts it into `entries`/leaf after the write succeeds (`packages/agent/src/session-store.ts:269-291`). A missing directory is the one retry: `ENOENT` from the append creates the directory and tries once more (`:276-286`); every other error travels before memory changes.
- `SessionStore.listSessions` keeps a file it cannot stat as a row with `mtimeMs: 0`, reporting it through the optional `onWarning` (`packages/agent/src/session-store.ts:232-266`). A directory it cannot list still yields the rows it has, and says so on the way (`:256-263`).

`packages/coding-agent/src/session-resume.ts` turns that into a picker:

- One unreadable transcript does not take the list down. The row keeps its id and title, reads `(unreadable session)`, counts zero messages, and carries the reason in `unreadable` (`packages/coding-agent/src/session-resume.ts:47-78`). A non-`SessionReadError` still travels, because that is a bug in the reader.
- `--continue` skips unreadable rows while a readable candidate exists. When every file is unreadable, the newest is still offered, so the load fails visibly rather than a fresh session appearing with no explanation (`packages/coding-agent/src/session-resume.ts:117-125`).

The hosts choose recovery over exit:

- The REPL's `--resume` prints `${message} — starting a new one.` and starts a fresh session (`packages/coding-agent/src/interactive.ts:570-595`). `--continue` does the same when the chosen target cannot be read (`:596-620`).
- An in-app `/resume` stays in the current conversation and pushes the reason into the transcript (`packages/coding-agent/src/interactive.ts:1846-1858`).
- A `-p` run writes one line to stderr and starts a new session, because a scripted run has nobody to prompt and exiting would turn a damaged file into a failed batch job (`packages/coding-agent/src/headless.ts:374-394`, `:395-419`).
- ACP distinguishes the two failures the protocol can express: an id nothing lists is `invalidParams`, and a listed session the environment cannot read is `internalError` (`packages/coding-agent/src/acp.ts:655-667`). `invalidParams` would tell the client to stop asking; `internalError` tells the truth.

## Settings diagnostics

A tier that is present and broken must not read as a tier that was never written.

- `SettingsDiagnostic` records the source, path, kind (`unreadable`, `invalid-json`, `invalid-shape`, `unknown-key`), and a message (`packages/coding-agent/src/settings.ts:415-421`).
- `readJsonFile` separates an absent file from an unreadable one. Absence is not a finding; a permission refusal is (`packages/coding-agent/src/settings.ts:633-646`). Invalid JSON is its own diagnostic (`:647-657`).
- A top-level key this release does not know is reported rather than silently dropped by zod (`packages/coding-agent/src/settings.ts:675-691`).
- Each tier is parsed on its own for attribution; a malformed tier records `invalid-shape` without taking down the well-formed tiers' views (`packages/coding-agent/src/settings.ts:752-760`, `:762-774`).
- The merge is still fail-closed. When the merged result is invalid, the defaults are used and one diagnostic says so, naming the culprit tier when a tier-level diagnostic found it (`packages/coding-agent/src/settings.ts:777-792`). A partially applied file would be a session running settings nobody wrote.
- `formatSettingsDiagnostics` deduplicates by content, so two readers naming the same broken file produce one line (`packages/coding-agent/src/settings.ts:699-701`).

The REPL buffers these lines into the startup notices instead of printing to stderr, because stderr is the screen the REPL is about to draw over (`packages/coding-agent/src/interactive.ts:454-456`). A `-p` run and an ACP session write each line to stderr (`packages/coding-agent/src/headless.ts:239`, `packages/coding-agent/src/acp.ts:924`). The lines carry paths and messages, never the values the files held.

## Notes from memory, skills, styles, and approvals

These loaders are allow-failure: a missing optional file is normal, and an unreadable one contributes nothing. The change is that the second case is now said instead of being indistinguishable from the first.

- `MemoryLoadResult.warnings` lists memory or rules files that are present and could not be read (`packages/coding-agent/src/memory.ts:66-84`). `readIfExists` reports every failure except a missing path (`packages/coding-agent/src/memory.ts:106-125`); the rules walk and the project-level walk collect the same notes (`:266-281`, `:306-316`).
- The three hosts print each note as `Memory: <message>` (`packages/coding-agent/src/interactive.ts:857-859`, `packages/coding-agent/src/headless.ts:564`, `packages/coding-agent/src/acp.ts:1125`).
- Skill loading returns `notes` beside `skills` (`packages/coding-agent/src/skills.ts:46-50`, `:192-199`). A bad `SKILL.md`, an unreadable directory, or a name collision becomes a note instead of a silent gap (`:63-101`). The REPL pushes `Skill not loaded: <note>` (`packages/coding-agent/src/interactive.ts:2424`); the other hosts prefix `Skills: ` on stderr (`packages/coding-agent/src/headless.ts:600`, `packages/coding-agent/src/acp.ts:1137`).
- Output styles load through `loadOutputStylesWithNotes`, whose `notes` explain a style that exists and could not be read (`packages/coding-agent/src/output-styles.ts:89-99`). The REPL prints `Output style: <note>` (`packages/coding-agent/src/interactive.ts:1459-1460`); ACP writes the same prefix to stderr (`packages/coding-agent/src/acp.ts:1219-1220`).
- MCP approvals have a status form: `loadApprovedMcpServersWithStatus` answers `{ approved, warning? }` (`packages/mcp/src/client.ts:989-1035`). A damaged or unreadable store returns the empty set and a warning saying earlier approvals are not in effect. The read path never moves or rewrites the file; only the write path (`approveMcpServer`) moves a corrupt ledger aside (`packages/mcp/src/client.ts:1084-1100`). The REPL holds the warning for the startup notice and repeats it in the bare `/mcp` view (`packages/coding-agent/src/interactive.ts:1141-1146`, `:4392`); a `-p` run prints it immediately (`packages/coding-agent/src/headless.ts:616-618`).

## Provider failures

### Retries

A retry is announced as it is scheduled. The agent emits `retry` with the attempt, delay, and message (`packages/agent/src/types.ts:559-566`). The REPL shows it twice: the status line owns the wait (`packages/tui/src/components/StatusLine.tsx:236-247`), and the transcript keeps one persistent line (`packages/coding-agent/src/interactive.ts:1748-1749`). The status line counts down from `untilMs` and keeps the attempt word after the countdown reaches zero, because "retrying" is still true until the stream resumes. A `-p` run writes the same line to stderr (`packages/coding-agent/src/headless.ts:959-965`); ACP has no handler for it and adds no frame.

### Fallbacks

The fallback walk reports only the descents it actually makes.

- `StreamOptions.onFallback` receives one `FallbackNotice` per step: the model that failed, the model about to be tried, the reason, and the kind when one was classified (`packages/ai/src/types.ts:327-338`).
- The walk notifies on a pre-content throw (`packages/ai/src/fallback.ts:76`), a stream that ended with no terminal event (`:88`), and a provider error before any content (`:107`). It does not notify when it stays on the first model, on an abort, on `context_overflow`, on a kind the walk does not descend for, or after content has streamed (`:60-75`, `:92-105`).
- The session loop is what wires the callback into the event stream (`packages/agent/src/session.ts:487`); the `fallback` event carries the same fields (`packages/agent/src/types.ts:568-580`). The compaction manager's summarizer request does not set the callback (`packages/agent/src/compaction.ts:1328-1331`), so a summarizer's descent is not announced.
- The REPL adds `[model fallback] from → to: reason` as a transcript line (`packages/tui/src/ui-state.ts:519-530`). A `-p` run and ACP write the same line to stderr (`packages/coding-agent/src/headless.ts:966-973`, `packages/coding-agent/src/acp.ts:770-776`). ACP adds no protocol frame: the protocol has none for it, and a client that shows the stream still sees the answer.

### Classified errors and remedies

`errorKind` names the four failures a caller can act on (`packages/ai/src/types.ts:108-115`). The classification is the agent's; the remedy belongs to the app, because it names `/login`, `/model`, and `/compact` (`packages/coding-agent/src/error-remedy.ts:1-18`).

- `errorRemedy(kind, model)` answers `rate_limit`, `overload`, `auth`, and `context_overflow`, and returns undefined for every other kind (`packages/coding-agent/src/error-remedy.ts:40-53`). The auth sentence reads the model's wire: a subscription wire points at `/login`, an env-keyed wire at its key variable, and a keyless row at `/model` (`:21-33`).
- A host supplies the function through `AgentDeps.errorRemedy`; the session calls it once when the run ends on a classified error and puts the answer on `agent_end` (`packages/agent/src/types.ts:455-464`, `packages/agent/src/session.ts:724-733`).
- The REPL prints the remedy under `Error: <message>` (`packages/tui/src/ui-state.ts:660-671`). A `-p` run prints it under the session-ended line in text mode (`packages/coding-agent/src/headless.ts:1128-1134`) and carries `error_kind`/`error_remedy` in JSON and stream-JSON (`:178-183`, `:1087-1091`, `:1120-1122`). ACP appends it to the error message, since the protocol has no field for advice (`packages/coding-agent/src/acp.ts:1335-1346`).

### Partial answers

`AssistantMessage.incomplete` marks text that is real but unfinished (`packages/ai/src/types.ts:116-125`).

- It is set when an abort keeps the last partial (`packages/agent/src/session.ts:539-545`), when a mid-stream throw is sealed with streamed content (`:557-565`), when the length ladder is exhausted (`:599-604`), and when any error or abort ends a turn that already had content (`:620-625`).
- It is written to the session file with the message. Provider adapters build their payloads field by field, so the marker never reaches the wire; a resumed session still knows (`packages/ai/src/types.ts:116-124`).
- The REPL marks the row `(response ended early; output is partial)` in the warning color (`packages/tui/src/components/MessageList.tsx:48`), and a resumed transcript carries the same flag (`packages/tui/src/ui-state.ts:26`, `:770-776`).
- A `-p` run reports `incomplete` in both machine formats (`packages/coding-agent/src/headless.ts:1073`, `:1092-1095`, `:1122`). ACP has no field for it; the partial content is what the client already received.

### Malformed tool arguments

A tool call whose arguments are not JSON is not a stream failure. `toolCallEnd` hands the buffered text over unparsed (`packages/ai/src/message-builder.ts:89-101`). The agent parses once at dispatch and turns a parse failure into `{ __malformedArguments: raw }`, which the pipeline's schema validation reports as an invalid-input tool result (`packages/agent/src/session.ts:1088-1096`, `packages/agent/src/pipeline.ts:51-63`). The stream continues, the call is paired, and the raw text is available to the error. `parseToolArguments` still exists for the adapters that replay a stored block to a provider; it maps malformed text to `{}` (`packages/ai/src/message-builder.ts:160-169`).

## Interruption

### Esc and queued messages

An abort is the user's decision, and the run's report says what it cost.

- `abort()` saves the queued follow-ups and steering messages before clearing them, and does not overwrite the first record with a second, empty one (`packages/agent/src/session.ts:285-303`).
- `agent_end` carries `interrupted: { followUp, steering }` when anything was dropped (`packages/agent/src/session.ts:726-734`, `packages/agent/src/types.ts:526-531`, `:551`).
- The REPL prints `[interrupted · N queued message(s) dropped · type a new message to continue]` and up to ten one-line previews of 200 characters each (`packages/tui/src/ui-state.ts:675-690`, `:483-504`). With nothing dropped, the line is `[interrupted · type a new message to continue]`.
- A `-p` run counts the dropped queues on stderr and never quotes the text, because the stream may be piped to a log (`packages/coding-agent/src/headless.ts:941-951`). It prints `Interrupted.` beside the exit code, which stays 130 (`:1140`).
- ACP reports the stop reason `cancelled` on the prompt response (`packages/coding-agent/src/acp.ts:171-179`, `:740-749`). The protocol has no field for the dropped queue, and ACP does not consume `interrupted`.

### Interrupted tool results

A tool result the loop wrote because an abort cut the call is an error on the wire and an interruption on screen.

- `ToolResultMessage.interrupted` is persisted; `isError` stays true because the wire pairing needs a failed result (`packages/ai/src/types.ts:146-156`).
- The live loop sets it on every call it settles itself (`packages/agent/src/session.ts:1068-1074`), on orphaned tool calls (`:1028-1040`), and the resume repair sets the same flag on the synthetic result it writes (`packages/ai/src/transcript.ts:95-116`).
- The REPL paints the result in the warning color and appends `(interrupted; output is partial)` instead of the red error style (`packages/tui/src/components/MessageList.tsx:402-410`). The live reducer copies the flag from the result (`packages/tui/src/ui-state.ts:641`); a resumed transcript copies it from the message (`:785`).
- A `-p` run's last-error search skips interrupted results. They are errors on the wire, but the failure is the user's own Esc (`packages/coding-agent/src/headless.ts:1203-1215`).

### Manual compaction

A manual `/compact` is a full-prefix model call and may take half a minute, so the host may let Esc stop it.

- The command context carries the run's own signal and declares whether the command watches it (`packages/coding-agent/src/commands.ts:76-95`). `/compact` passes the signal into the manager and returns `Compaction cancelled.` when the abort wins (`:149-175`).
- The manager checks the signal before it records anything (`packages/agent/src/compaction.ts:1133-1140`). An abort after the commit point therefore has no effect: the record is written and the command reports success.
- A cancelled summary is not a failure: the stream's abort is recognized (`packages/agent/src/compaction.ts:1327-1363`), and the pass does not count against the breaker when the signal is aborted (`:1170-1176`).
- The REPL gives each command one abort controller and clears the slot by identity on completion (`packages/coding-agent/src/interactive.ts:819-849`). Esc runs the dialog first, then the command cancel, then the session abort (`packages/tui/src/components/REPL.tsx:680-714`, `:689`).
- Only a command that declared itself cancellable raises `esc to cancel` on the status line (`packages/tui/src/components/StatusLine.tsx:214-227`). A summarization the loop started on its own is not cancellable and keeps the row without the promise.

## Dialog feedback

### The permission fourth option

The fourth answer used to deny without collecting the sentence its label promised. It now opens a text field, and the denial carries what was typed.

- `PermissionReply` is `boolean` or `{ allow, alwaysAllow?, alwaysAsk?, message? }`, so every existing boolean stub keeps working (`packages/tui/src/permission-options.ts:36-38`). `replyAllowed` is the only reader a decision site needs (`:40-43`); `replyMessage` drops whitespace-only text (`:45-50`).
- A denial's message is trimmed and capped at 2000 characters before it enters the tool result (`packages/tui/src/permission-options.ts:52-63`).
- The fourth option is marked `collectsFeedback` (`packages/tui/src/permission-options.ts:164-170`). Selecting it opens the field instead of answering (`packages/tui/src/components/PermissionDialog.tsx:105-123`). Enter submits; an empty field is a plain denial; Esc returns to the list rather than denying (`:174-187`). The help line states the empty-field rule (`:268-281`). A game pad cannot type, so the pad's fourth-button press is the plain denial (`:165-167`).
- The REPL's tool gate passes the message through as the denial text (`packages/coding-agent/src/interactive.ts:1560-1566`). The subagent bridge and plan mode read only the decision (`packages/coding-agent/src/subagents.ts:628-632`, `packages/coding-agent/src/plan-mode.ts:240`).

### AskUserQuestion `Other…`

A single-select question gets a free-text row. A multi-select one does not: "tags plus arbitrary text" has no meaning the answer pipeline defines yet (`packages/tui/src/components/QuestionDialog.tsx:10-14`).

- The row is appended only when `multiSelect` is not set (`packages/tui/src/components/QuestionDialog.tsx:47-50`).
- Confirming the row opens a field rather than answering, because an empty answer is not one (`packages/tui/src/components/QuestionDialog.tsx:95-110`). Enter submits a non-empty value, Esc returns to the options, and an empty Enter does nothing (`:153-187`).
- The pad skips the row for the same reason the permission pad does: a controller cannot type (`packages/tui/src/components/QuestionDialog.tsx:76-80`).
- The submitted text joins the answers array as an ordinary answer; the bridge needs no change.

## Where each host reports it

| Surface | REPL | `-p` run | ACP |
| --- | --- | --- | --- |
| Settings, memory, skills, styles, MCP approval | Startup notice in the transcript | stderr | stderr |
| Retry | Status line and one transcript line | stderr | none |
| Fallback | Transcript info line | stderr | stderr |
| Error remedy | Under the error line | stderr, `error_kind`/`error_remedy`, `incomplete` | Appended to the error message |
| Partial answer | `(response ended early; output is partial)` | `incomplete` in both JSON formats | No field; partial content is delivered |
| Interrupted queue | Count and previews | Count only | `cancelled` stop reason |
| Interrupted tool result | Warning color and `(interrupted; output is partial)` | Skipped by the last-error search | An error result, as the wire requires |
| Resume of an unreadable session | stderr, then a new session; in-app stays put | stderr, then a new session | `internalError` |
| Cancelled `/compact` | `Compaction cancelled.` | Not reachable | Not reachable |

## Tests that hold these claims

- `packages/agent/test/admission-failure.test.ts` holds the start/end pair across a hook failure and a store refusal, and that a failed queue admission stays queued.
- `packages/agent/test/session-store.test.ts` holds the write-first append, the missing/unreadable split, and the capped read's damage-only count.
- `packages/ai/test/fallback.test.ts` holds the three descent notices and the cases that must stay silent.
- `packages/ai/test/transcript.test.ts` holds the interrupted marker on a repaired call.
- `packages/coding-agent/test/continue.test.ts` covers `--continue` skipping an unreadable row and failing visibly when none is readable.
- `packages/coding-agent/test/settings-loader.test.ts` covers each diagnostic kind, the fail-closed fallback, and the deduplicated lines.
- `packages/coding-agent/test/checkpoint-log.test.ts` covers the failure list and its dedupe.
- `packages/coding-agent/test/error-remedy.test.ts` covers each kind and the auth wording per wire.
- `packages/coding-agent/test/compact-command.test.ts` covers `Compaction cancelled.` and the abort-before-commit rule.
- `packages/tui/test/repl-interrupt.test.tsx` covers the dropped-queue line and the previews.
- `packages/tui/test/permission-options.test.ts`, `packages/tui/test/question-dialog.test.tsx`, and `packages/tui/test/pad-dialogs.test.tsx` cover the fourth-option field, `Other…`, and the pad's plain answers.
- `packages/tui/test/status-battery.test.tsx` covers the retry label, the countdown, and the `esc to cancel` row.
- `packages/tui/test/resume-replay.test.tsx` covers the partial marker and the interrupted result arriving from a resumed transcript.

## Source map

| File | Role |
| --- | --- |
| `packages/agent/src/session.ts` | Admission, the event pair, the abort record, partial and interrupted markers, and the remedy hook. |
| `packages/agent/src/session-store.ts` | Write-first appends, `SessionReadError`, and the tolerant listing. |
| `packages/coding-agent/src/session-resume.ts` | The picker row for an unreadable file and the continue target. |
| `packages/coding-agent/src/settings.ts` | Per-tier diagnostics and the fail-closed merge. |
| `packages/coding-agent/src/error-remedy.ts` | The app's next step per classified provider failure. |
| `packages/mcp/src/client.ts` | The approval store's status form. |
| `packages/tui/src/ui-state.ts` | How each event reaches the transcript. |
| `packages/tui/src/permission-options.ts` | The reply union and the bounded denial text. |
