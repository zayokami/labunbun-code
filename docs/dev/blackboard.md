# The blackboard

The `/beetle` band used to be a message relay: a member handed work to another by sending prose, and the recipient paid for a full request to say "received". This page describes its replacement. The task board is the only durable channel between members; a deterministic dispatcher wakes the member a task belongs to; and a worker's conversation begins at the task and ends with it. The board is also where the environment speaks: a failing command leaves a structured trace — exit code and a bounded cut of the error — instead of a natural-language report written by the member who ran it.

The three pieces already exist in some form. The board is `TaskStore` (`packages/tools/src/tasks.ts:26-123`), shared by every seat and persisted in the session file (`task-snapshot.ts`). The pattern for a board-driven, zero-model control loop is `createTaskNudges` (`packages/coding-agent/src/task-nudges.ts:100`). The bounded cut is `cutText` (`packages/agent/src/output-limits.ts:81`). This page records how they are composed and the invariants the composition must keep.

## The model

```
John ─ TaskCreate(kind, owner, blockedBy, acceptance, commands) ─┐
                                                                ▼
Paul / George / Ringo ─ TaskUpdate, command results ──▶  TaskStore  ──▶ session file
                                                                │
                                                                ▼
                                            BlackboardDispatcher (no model call)
                                            ├─ ready = pending && owned && deps completed
                                            ├─ claim → render task card → wake owner
                                            ├─ failed build/verify → one fix task
                                            └─ no upstream verify → one verify task
```

The dispatcher is a state machine over the board, not an agent. It renders strings and moves tasks; it never calls a model. A wake costs only the woken member's own turn, and that turn starts from the task card rather than a transcript of everything the band has said.

## Invariants

1. **Every handoff is a board write.** A member that wants work done writes a task. There is no worker-to-worker channel in the default path.
2. **Only the dispatcher or a human wakes a member.** A member cannot wake another by talking to it.
3. **A task is claimable only when** its status is `pending`, it has an owner, and every id in `blockedBy` names a task whose status is `completed`. A failed dependency is terminal but not satisfied, so dependents stay blocked until the failure is repaired.
4. **One `in_progress` task per seat.** Two tasks whose `files` intersect are not claimed at the same time.
5. **One wake per revision.** A wake is keyed by `(owner, task id, rev)`; a board change that bumps `rev` may wake again, an unchanged task cannot.
6. **A worker's memory is the board.** The session is created when the task is claimed and destroyed when the task reaches a terminal state. Nothing a worker said survives into the next task.
7. **Environment facts are structured.** A command's result is a `TaskRun` carrying the command, its exit code and a `cutText` summary. A member does not rewrite a test failure as prose.
8. **A failure gets one fix task, not a conversation.** A failed `build`/`verify` task produces a `fix` task owned by the implementer, carrying the error pheromone. Repair attempts are counted; the count has a ceiling.
9. **Code is verified structurally.** An `implement` task that completes with no downstream `verify`/`build` task gets one created for it. "Done" without evidence is not a state the board leaves reachable.
10. **`BandMessage` is an emergency channel, not a bus.** A worker may address John only, at most once per task run. John answers by changing the board, never by messaging back. The human channels are `/beetle say` and `@john`.

## The task record

`AgentTask` (`tasks.ts:13-24`) grows the fields the dispatcher reads. Every new field is optional on disk, so a snapshot written before this page still restores.

| field | owner | meaning |
|---|---|---|
| `kind` | writer | `plan`, `implement`, `verify`, `build`, `research`, `fix`, `escalate`, `report` |
| `acceptance` | writer | what "done" means, in verifiable terms |
| `files` | writer | the files or areas the task touches; the scheduler's conflict key |
| `commands` | writer | commands a `build`/`verify` task declares; only these become evidence |
| `runs` | system | bounded `TaskRun[]`, newest last |
| `errorSummary` | system | the latest failing run's `cutText` summary |
| `verdict` | system or writer | `passed` or `failed` on a `build`/`verify` task |
| `attempts` | system | repair rounds already spent on this task |
| `fixes` | dispatcher | a `fix` task's link to the task it repairs |
| `fixedBy` | dispatcher | the fix task that repaired this one |
| `parent` | writer | the task a worker-derived task came from |
| `createdBy` | writer | the seat or host that wrote it; the policy key |
| `rev` | system | incremented on every store update; the wake dedupe key |
| `updatedAt` | system | when the last write landed |

`TaskStore.subscribe` passes a change record — `create`, `update` (with the previous snapshot) or `restore` — so the dispatcher does not have to diff the list. A listener registered before this change still works: it simply ignores the argument.

## Scheduling

`blackboard.ts` owns the rules. It is written as pure functions plus a small controller, the way `task-nudges.ts` is, so every rule is testable without a provider.

- **ready**: `pending`, `owner` is a seat, and every `blockedBy` is `completed`.
- **claim**: the lowest-id ready task for an idle owner is moved to `in_progress` in one store update, then its card is handed to the owner. A claimed task is not woken again until `rev` changes or its session ends with the task still open.
- **reconcile**: every store change queues one reconciliation pass on a microtask. Writes the dispatcher itself makes during a pass set a dirty bit and schedule a second pass instead of recursing through `#notify`.
- **re-entry**: a seat whose run ends with its task still `in_progress` gets one continuation card. The count is stored in `attempts`; past the ceiling the task is left open with a notice, never silently completed.
- **crash recovery**: on band start, an `in_progress` task whose owner has no live session is returned to `pending` with `attempts` incremented, so a restarted band resumes the board instead of forgetting it.
- **completion**: `completed` is a fact the writer records, not one the dispatcher invents. The deterministic exception is a `build`/`verify` task whose declared commands all ran: the recorder writes the verdict and closes it.
- **verification**: an `implement` task that completes with no `verify`/`build` task naming it in `blockedBy` gets one created, owner George by default. It is created once; a task that already has a verifier is left alone.

## The task card

The wake payload is a rendered card, bounded by `beetle.taskCardChars` (default 4000). It carries exactly what the task needs and nothing that happened in another conversation:

```
[blackboard] Task #7 — verify: blackboard dispatcher (owner: george)
What done looks like: ...
Files: packages/coding-agent/src/blackboard.ts
Blocked by: #5 completed 12:04 (build: exit 0)
Last failure: #6 at 12:05 — [exit code: 1]
  ... [truncated 8421 chars of output] ...
  [the head and tail of the error, cutText]
Board: TaskList shows every task; TaskGet #7 reads this one.
```

The card is generated by a pure `renderTaskCard(task, store, budget)`. No chat, no summary of the band's activity, no instruction that a peer already said.

## Environment pheromones

A worker runs commands with Bash; the result already begins with `[exit code: N]` (`packages/tools/src/bash.ts:303`), and a result too large for the conversation already begins with a spill pointer (`formatSpillHeader`, `output-limits.ts:36`). The band's event observer reads both facts for free:

- On `tool_execution_start`, the command is remembered per call id.
- On `tool_execution_end`, a Bash result whose command is in the seat's current task's `commands` becomes a `TaskRun`; the summary is `cutText(raw, beetle.errorSummaryChars)`, so it keeps the spill pointer and both ends of the error.
- The run is appended to `runs` (bounded; oldest dropped), `errorSummary` is replaced, `rev` is bumped, and `updatedAt` moves. This is a store write from the host, not a model turn.
- For a `build`/`verify` task, once every declared command has a run, the verdict is `passed` iff every exit code is zero. The task closes itself; Ringo's job is only to run the commands.

The full output is not copied onto the board. The spill pointer inside the summary is the handle, and `Read` opens it — the same contract every other tool result follows.

## The fix loop

```
pending ──deps satisfied──▶ in_progress ──▶ completed
                                  │
                                  ├─(build/verify exit != 0)──▶ failed
                                  │                              │
                                  │        dispatcher creates one fix task (owner: paul,
                                  │        fixes: #verify, errorSummary inherited)
                                  │                              │
                                  │        fix completed ──▶ verify `fixedBy`, dependents unblock
                                  │                              │
                                  └─ attempts >= maxFixRounds ──▶ escalate to John once
```

`beetle.maxFixRounds` (default 3) bounds the loop per failing task. The fix task carries the failing task's `attempts + 1`, so a chain of fixes cannot restart the count. At the ceiling the dispatcher creates one `escalate` task owned by John and stops producing fixes; it does not keep paying for attempts the band cannot finish.

## `BandMessage` after the change

| sender | allowed targets | budget |
|---|---|---|
| Paul, George, Ringo | John only | one call per claimed task (continuation wakes share the budget) |
| John | none | John answers by editing the board |
| main session | none as a tool | `/beetle say`, `@john` |

The worker copy of the tool is built with a one-value target enum, and the delivery path counts calls against the sender's current task. The second call in one task is refused with a receipt that says to put the question on the board or record a blocked verdict. Because John has no send tool, a clarification cannot grow into a reply chain. The host keeps `deliver()` for the human's one-way commands.

## Settings

| key | default | meaning |
|---|---|---|
| `beetle.context` | `"task"` | `"task"` destroys the worker session at the task boundary; `"session"` keeps the old long-lived conversation |
| `beetle.maxFixRounds` | `3` | repair attempts before escalation |
| `beetle.taskCardChars` | `4000` | wake payload bound |
| `beetle.errorSummaryChars` | `1200` | per-run pheromone bound |

## Implementation status

Phase 0 and Phase 1 are landed; the rest of this page is the design they are
built toward.

- **Landed:** the task record and its snapshot acceptance, change-carrying
  subscriptions, the dispatcher and task card, task-scoped worker sessions
  (`beetle.context: "task"` is the default when a board is connected), and the
  restricted `BandMessage`. The card's budget and the error-summary budget are
  band options (`taskCardChars`, `errorSummaryChars`), not settings keys yet.
- **Not yet:** the pheromone recorder and deterministic verdicts (Phase 2); the
  fix loop, automatic verifier, file-conflict serialisation, the worker
  `TaskCreate` limits and crash recovery (Phase 3); the remaining settings keys
  and the status lines (Phase 4).
- **Compatibility:** a band constructed with no `taskStore` has nothing to
  dispatch over, so its context is `"session"` — the long-lived band this page
  replaces. The app always connects the board, so its default is `"task"`.

## Rollout

- **Phase 0** — the task record, change-carrying subscriptions, snapshot acceptance, tool schemas. No behavior change.
- **Phase 1** — the dispatcher, task cards, task-scoped sessions, and the restricted `BandMessage`. This is the phase that removes the handoff requests.
- **Phase 2** — the pheromone recorder and deterministic verdicts.
- **Phase 3** — the fix loop, the automatic verifier, file-conflict serialisation and crash recovery.
- **Phase 4** — settings, `/beetle status`, and this page's implementation notes.

## Tests that hold these claims

Landed:

- `packages/tools/test/tasks.test.ts`: the new fields round-trip; `rev`/`updatedAt` move on update; the change record names the previous task.
- `packages/coding-agent/test/task-snapshot.test.ts`: an old snapshot restores with the new fields defaulted; a malformed optional field is refused, not half-read.
- `packages/coding-agent/test/blackboard.test.ts`: ready/claim ordering, dependency gates, one task per seat, wake dedupe by `rev`, terminal release, resumed `in_progress` tasks, and dispose.
- `packages/coding-agent/test/beetle.test.ts`: a start becomes one lead task owned by John; a worker's first request carries its card and nothing from a prior task; a completed task destroys the session; workers address John only, once per task; John has no send tool; the human channels still deliver; a board edit under a finished run wakes the worker with the edited card.
- `packages/coding-agent/test/beetle-command.test.ts`: on the board path the main session gets no `BandMessage` and the band writes no tool-block change, while `/beetle say` and `@john` still reach a seat; an explicit `"session"` context keeps the old tool and the old briefings.

Planned, one file per phase: the pheromone recorder (`beetle-pheromone.test.ts`),
the fix loop and automatic verifier (the rest of `blackboard.test.ts`).

