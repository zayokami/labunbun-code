# The checkpoint ledger

The tool ledger is the record of what the agent did while it ran. The session file already holds the conversation, the compaction history and the task list, and none of them say which tools were called, whether they worked, or what the files they touched held on either side. The ledger is that answer: one `custom` entry per finished tool call, plus the file snapshots `/rewind` restores from. It is what `/checkpoint` renders, what the recovery line at startup summarizes, and the state a restore has to exist before anything can be put back.

The shape, the writer and the readers live in `packages/coding-agent/src/checkpoint-log.ts`. One writer serves both hosts — the REPL builds it at `packages/coding-agent/src/interactive.ts:1324` and a `-p` run at `packages/coding-agent/src/headless.ts:736` — because both run the same tool loop and both have to leave the same record of it.

## The three entry kinds

The kind strings are fixed on disk (`checkpoint-log.ts:36-40`):

- `checkpoint` — one finished tool call (`writeToolCheckpoint`, `checkpoint-log.ts:483`).
- `file_checkpoint` — the content of one file just before an Edit or Write touched it; `/rewind`'s payload.
- `rewind` — a restore that `/rewind` performed, so a later reader can tell a workspace that was rolled back from one that was merely edited (`recordRewind`, `checkpoint-log.ts:488`).

Every append is best effort (`appendEntry`, `checkpoint-log.ts:665`): a checkpoint that cannot be written must not cost the turn that was running. A lost entry is a line a later reader will not have, which is the cost this module accepts.

The readers differ on purpose:

- `/checkpoint` reads over every entry in the file, not the active chain (`readToolCheckpoints`, `checkpoint-log.ts:502`). The question is what this session did, and a compaction is exactly the moment the chain stops holding the calls above it.
- `/rewind` reads `store.linearEntries()` (`listCheckpoints`, `interactive.ts:2733`). A restore payload outside the live chain is not offered, which is why the compaction pass has to put the latest one back: `resendCheckpointsAcrossCompaction` (`checkpoint-log.ts:561`) re-appends the newest `file_checkpoint` per path and every shell start no end has closed, at the moment the boundary is written (`interactive.ts:895`). Older checkpoints for a path are deliberately left behind — after a summary the useful thing to restore is the newest state of a file, not its whole editing history.

## What one `checkpoint` entry holds

`ToolCheckpoint` (`checkpoint-log.ts:60`):

- `at`, `callId`, `toolName`, `isError` — required.
- `filesTouched` — one row per file an Edit/Write named, with a sha256 of the file just before and just after the call. The hash, not the content: the `file_checkpoint` beside it already holds content, capped, and the hash is the half that stays cheap to compare (`checkpoint-log.ts:16-18`). A null hash is "unknown", never "unchanged" (`checkpoint-log.ts:45-51`).
- `inputSummary` and `truncated` — a capped slice of one string field of the input: the command for Bash, the path for Edit/Write, the pattern for Grep. The field is picked from a fixed list, most specific first (`SUMMARY_FIELDS`, `checkpoint-log.ts:149`), because JSON key order is not something a caller promises. The cap is `INPUT_SUMMARY_MAX_CHARS = 160` (`checkpoint-log.ts:138`), with the cut admitted in `truncated`.
- `failedTests` and `failedTestsOmitted` — the failing tests a test run's result reported, in the runner's order. Read only when the call failed and its command passed `looksLikeTestRun` (`checkpoint-log.ts:201`); the names come from bun's `(fail) <name>` lines alone (`BUN_FAIL_LINE`, `checkpoint-log.ts:188`), capped at `FAILED_TESTS_MAX = 20` with the rest kept as a count (`checkpoint-log.ts:243`). Every other runner's format is left alone rather than guessed at, because a checkpoint that named the wrong test would be worse than one that named none.
- `nextStep` — the step the session's own task board stated when the call ended: the in-progress task's `activeForm` (else its subject), or the first pending task's subject (`nextStepFromTasks`, `checkpoint-log.ts:269`). Derived from that record, never invented; absent when the board had no open work.

## The writer

`createToolLedger` (`checkpoint-log.ts:313`) returns four methods:

- `noteToolStart` keeps the input each running call was announced with; the end event carries none.
- `noteBeforeMutation` (Edit/Write only) snapshots the file about to change: the sha256, and the content itself when it is at most `CHECKPOINT_MAX_CHARS = 200_000` (`checkpoint-log.ts:276`). Over the cap the hash still goes in and the copy does not — the entry can say the file changed on this call even when `/rewind` cannot restore it (`checkpoint-log.ts:330-336`).
- `noteAfterMutation` records the post-call hash, and only when the call reported success: a failed edit left the file as it was, so "the hash after" would be the before side wearing the wrong label (`checkpoint-log.ts:361-364`).
- `noteToolEnd` writes the entry (`checkpoint-log.ts:367`).

The hook-shaped methods run before the user's own hooks at their call sites (`interactive.ts:1466-1483`, `headless.ts:808-815`), so a hook that blocks a call still leaves the ledger saying what was attempted, and the before-fingerprint is taken before anything else could touch the file. A file lands in `filesTouched` only when a validated call reached its before hook: an input the schema refused never named a file this build fingerprinted, and a row for it would be a claim built on input nothing accepted (`checkpoint-log.ts:374-381`).

## `/checkpoint`

The command (`interactive.ts:3357`) renders, from the ledger alone: how many tool calls are recorded and how many failed; the last call with its time and input summary; the next step the newest call recorded; the failing tests of the newest failing test run, by name; the files touched, each read against the disk now with one of four verdicts — `unchanged`, `changed`, `missing`, `unfingerprinted` (`TouchedFileState`, `checkpoint-log.ts:107`; a later call on the same path replaces the earlier fingerprint, `checkpoint-log.ts:520`); a task summary from the session's task board; and the context use against the auto-compact threshold.

## `/rewind`

The listing takes the last ten file checkpoints, newest first, and numbers them for `/rewind <number>` (`interactive.ts:4278-4293`). Entries that fail the shape check are counted and skipped rather than defaulted — the content is about to be written over a real file, and defaulting a missing field used to write the empty string over the file the entry named (`interactive.ts:2733-2754`). A restore writes the stored content back (`interactive.ts:4311`) and then records itself with `recordRewind` (`interactive.ts:4317`), after the write succeeded: a restore that failed must not be logged as one that happened.

## The recovery line

`formatResumeSummary` (`checkpoint-log.ts:459`) is the first move of the recovery protocol. The line is `Resumed: last <tool> <ok|failed> at <time>, <n> tool call(s) recorded[, <n> file(s) touched][, <n> failing test(s)]. Next: <step>. /checkpoint shows the ledger; /rewind restores a file.` — the file and test clauses appear only when the ledger holds them, and `Next:` only when the newest call recorded one. Undefined when nothing was recorded, which is what lets a fresh session print nothing without a branch of its own.

Both hosts print it to stderr at startup, at the same moment and for the same reason — it is startup context for the transcript that is about to render, not part of the answer: `interactive.ts:620-621`, `headless.ts:407-408`. (In headless mode stderr is the only stream it could go to; `-p`'s stdout is the answer.)

## Resuming a session

- `findSession` (`session-resume.ts:69`) matches an exact id first, then a substring. An empty token finds nothing: `includes("")` is true for every session, so without the guard a bare `--resume` would match whichever session came first.
- `-c` lands on the most recently touched session with something in it (`resolveContinueTarget`, `session-resume.ts:86`). Skipping empty shells is the point: every process start writes a header-only file, so the newest file is usually a session nobody said anything in.
- `loadSessionForResume` (`session-resume.ts:123`) rebuilds the model-facing transcript through `contextMessages()` — a compacted session resumes from its boundary — and repairs tool pairing with `repairToolPairing`, reporting how many messages the repair removed (`droppedMessages`) and how many interrupted calls it answered (`synthesized`). An interrupted call keeps its assistant turn and gains a synthetic error result immediately after it, because dropping both halves cost the user the model's own words; an unpaired result is still dropped. The pair keeps a recoverable session from becoming one the provider rejects.
- `damagedSessionNotice` (`session-resume.ts:156`) names the losses separately, because one damaged line can produce more than one and a user should not read one lost line as several lost things: `Session file damaged: <n> damaged line(s) and <m> message(s) removed by the tool-call repair and <k> interrupted tool call(s) answered with an error result (<path>). The rest of the conversation is intact.` Each repair clause and its joiner appear only when its count is above zero. The REPL prints it as `Warning: …` before the transcript (`interactive.ts:582`); headless prints it to stderr (`headless.ts:358-359`, `headless.ts:371-372`).

A resume target that matches but cannot be rebuilt — its header is gone — starts a new session and says so (`Could not read session <id> — starting a new one.`, `interactive.ts:558`, `headless.ts:362`). A missing id stops the run with `Session not found: <id>` (`interactive.ts:544`; headless returns exit 1, `headless.ts:352-353`). An empty `-c` target says `No previous session to continue — starting a new one.` (`interactive.ts:573`, `headless.ts:377`).

The exit line tells the user how to come back: `To resume: labunbun --resume <last 8>` (`exitSummaryLine`, `session-resume.ts:170-175`; written after the REPL unmounts so the frame cannot erase it, `interactive.ts:2454-2460`). The tail of the id is used because an id opens with an ISO timestamp: the first eight characters are the same for every session started in the same month.

## Deliberate limits

- The failed-test reader understands bun's `(fail)` lines only; other runners are left alone (`checkpoint-log.ts:185-188`), and failures are read only off a call that failed and whose command looks like a test run (`checkpoint-log.ts:399-409`).
- A file over 200k characters gets a fingerprint but no content copy, so it can be reported changed but not restored.
- The ledger does not record subagent or shell termination: those live in their own ledgers in the same session file (see `missions.md`).
- Appends have no fsync, and two processes on one session file can interleave; `crash-consistency.md` records both.

## Tests that hold these claims

- `packages/coding-agent/test/checkpoint-log.test.ts` covers the entry shape, the input summary, the touched-file verdicts, the compaction put-back (`checkpoint-log.test.ts:223`), `recordRewind`, `/rewind`'s rollout record, `/checkpoint`, the test-run gate and the next-step read.
- `packages/coding-agent/test/checkpoint-headless.test.ts` runs the `-p` side: the ledger a finished run leaves, the recovery line on stderr (`checkpoint-headless.test.ts:160`), `-c`, the fresh-session silence (`checkpoint-headless.test.ts:231`), and the `--no-session` refusal (`checkpoint-headless.test.ts:243`).
- `packages/coding-agent/test/rewind-checkpoint.test.ts` holds the restore path, including that a file with no content checkpoint does not truncate the file it names (`rewind-checkpoint.test.ts:76`) and that unreadable entries shift no numbering (`rewind-checkpoint.test.ts:104`).
- `packages/coding-agent/test/checkpoint-e2e.test.ts` and `packages/coding-agent/test/resume-compaction.test.ts` cover the end-to-end write-then-resume shape across a compaction boundary.
