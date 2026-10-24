# Plan mode

Plan mode is two things that share one name. The first is a permission mode: a value on the session's mode axis that the permission engine reads on every call. The second is a cycle: an interactive session can enter the mode, design, present the plan for review, and leave the mode with an answer. The engine enforces the first with no help from the tools (`packages/agent/src/permissions.ts:381-383`). The cycle is built from two tools, a review dialog, and a snapshot in the session file (`packages/coding-agent/src/plan-mode.ts:350-450`).

The distinction matters because only one host has the cycle. A headless run and an editor session can hold the permission mode, and then the mode is only a refusal: every non-read-only call is denied with no tool to present a plan and no dialog to approve one (`packages/agent/src/permissions.ts:381-383`). Nothing in the engine requires a plan to exist.

## The mode, and the pair it is entered from

`plan` is one of the three permission modes, and `MODE_CHOICES` pairs it with `workspace-write` (`packages/agent/src/types.ts:77-91`). The mode axis and the sandbox axis are separate. Entering plan mode changes only the mode, so restoring "how you found it" means restoring both axes (`packages/coding-agent/src/plan-mode.ts:120-140`).

The callbacks keep that pair in a `WeakMap` keyed by the session that entered plan mode (`plan-mode.ts:161`). A `WeakMap` rather than a field on the callbacks because an in-app `/resume` can swap the live session while a review dialog is open: the saved pair belongs to the session that asked, not to whichever session is current when the user answers (`:120-127`).

`remember` writes the pair together with the session's model at that moment (`:172-179`). A record taken while the session is already in plan mode is redundant when it came from outside plan mode: there is no "before plan" to save, and the cycle's own snapshot stays (`:160-171`). A record taken *from* plan mode is ignored for the same reason (`:207-211`). A record taken outside plan mode replaces an older one, because a user can leave plan mode by hand with no approval to delete the previous entry, and the next cycle must restore the pair it actually left (`:156-171`).

### Model-driven entry

`EnterPlanMode` calls `enterPlanMode` (`plan-mode.ts:360-361`, `:193-204`). That method:

- records the current pair and model;
- calls `session.setMode("plan")`;
- swaps the session model to the plan seat when one is configured and different;
- calls `onModelSwapped`, which the host uses to rebuild everything bound to a model;
- calls `onModeChanged`, which the host uses to publish the badge and persist the policy.

The plan seat is described in "The plan seat" below.

### User-driven entry

There are two user doors, and neither goes through `enterPlanMode`:

- `/mode plan`, by argument or by picker. The host records the pair *before* moving the session: the pair to restore is the one the session is in now, not `plan` itself (`packages/coding-agent/src/interactive.ts:4477-4484`, `:4512-4523`). Re-selecting `plan` while already in plan mode records nothing (`:4480-4482`, `:4520-4522`).
- Shift+Tab. The REPL owns the key and moves both axes before the app layer hears about it, so the host passes the pair it left as `previous` (`interactive.ts:2173-2184`). `recordPlanEntry(previous)` stores that pair and the model that is live now; it does not move the model, because this callback records rather than enters (`plan-mode.ts:205-219`).

Both doors therefore produce the same state as a model-driven entry, minus the model swap: a saved pair that an approval can restore.

## Approval, rejection, and cancellation

`ExitPlanMode` calls `requestPlanApproval` and blocks until the review answers (`plan-mode.ts:415`). The method captures the current session and the saved pair before its first `await` (`:224-232`). If the session is not in plan mode, the saved pair is the current pair; otherwise it is the `WeakMap` entry, with `DEFAULT_MODE_CHOICE` as the fallback when no entry exists (`:229-232`).

Three surfaces can answer:

1. A host with a review surface gets `requestPlanReview`, which can carry feedback (`:228-234`). The REPL wires this to the plan review dialog (`packages/coding-agent/src/interactive.ts:1375-1378`).
2. A host with only a permission dialog gets `requestPermission("ExitPlanMode", …)` and a boolean answer (`plan-mode.ts:238-242`).
3. A missing session or a missing UI answers a rejection with the text "No interactive session to approve the plan" (`:218-222`).

The possible endings:

- **Approved.** The saved pair is restored with `setMode(mode, sandbox)`, the entry is deleted, and the model is restored under the conditions in "The plan seat". `onModeChanged` fires so the badge and the persisted policy follow (`:262-282`).
- **Rejected with feedback.** The answer is returned unchanged, and the pair stays saved: a retry keeps the same restore point (`:246-248`, `:262`). The tool result names the feedback and asks for a revised plan (`:432-439`).
- **Rejected without feedback.** Same path, with no sentence to carry (`:246-248`).
- **Canceled.** A review surface answers `null` for Esc, abort, or replacement; the tool reports "Plan approval canceled" rather than a verdict on the plan (`:240-245`). A dialog that throws reports "Plan approval dialog failed" (`:237-239`).
- **Aborted.** `session.isInterrupted` or an aborted signal after the dialog counts as canceled, not approved, so the plan-mode gate stays as it was (`:249-256`).
- **Session changed.** If `/resume` replaced the session during the dialog, the new session does not inherit a lift granted to its predecessor (`:257-261`).

The rejection path deliberately does not restore anything. The session stays in plan mode and keeps the plan model, because the cycle is not over; only an approval ends it (`:246-282`).

In the REPL the wait also races the run's abort a second time at the wiring layer: the signal is passed into the review slot, and a dialog whose slot missed the abort is still cleared when the wait ends (`interactive.ts:2779-2820`). The callbacks report that null as "canceled" (`plan-mode.ts:246-251`).

## `ExitPlanMode` and the optional steps

The input schema has a required `plan` string and an optional `steps` array, each step a `subject` and an optional `description` (`plan-mode.ts:388-399`). The schema is the contract the model sees; the tool's own behavior is:

- If the session is in plan mode at the call, a snapshot with `approved: false` is recorded *before* the dialog (`:397-408`). The read happens before approval on purpose: approval restores the pre-plan pair, so a check after the dialog would always say "not plan mode" and the archive would never happen (`:397-400`).
- On approval inside plan mode, a second snapshot with `approved: true` replaces the proposal (`:420-425`), the steps are handed to the host's `createTasksFromSteps` (`:426`), and the result reports the count the host returns (`:427-430`).
- On rejection, the proposal stays as recorded, and no tasks are created (`:432-439`).
- An `ExitPlanMode` called outside plan mode still asks and still answers, but records nothing and creates nothing: an abnormal path with no proposal to archive and no steps to add (`:411-419`). A test pins this (`packages/coding-agent/test/plan-lifecycle.test.ts:722-738`).

### The result text promises only what happened

`planApprovedText` (`plan-mode.ts:325-348`) has one unconditional sentence — the plan is archived, because the snapshot was written before the result — and then only what the board actually did:

- zero steps: asks the model to build the board with `TaskCreate` (`:332-334`);
- one or more created: names the number and says they are pending (`:335-337`);
- zero created because every step was a duplicate: says no new tasks were added (`:338-340`);
- no host board at all (`created === undefined`): no task sentence (`:341`).

The last case is the honest boundary: a tool must not promise a board it cannot see (`:326-328`).

## The step-to-board bridge

`createPlanTasks` is the function the REPL passes as `createTasks` (`packages/coding-agent/src/interactive.ts:1415-1419`; `plan-mode.ts:294-323`). Its rules:

- Every step becomes a task with status `pending`, which is the default of `TaskStore.create` (`plan-mode.ts:298-299`, `:316`; `packages/tools/src/tasks.ts:40-61`).
- A step whose subject already names an *unfinished* task is skipped (`plan-mode.ts:307-312`). A completed task with that subject is history, not an obstacle (`:300-302`).
- De-duplication also applies within one call: a plan that names the same step twice gets one task (`:311-313`).
- The return value is the number actually created: `0` when the board already held every step, `undefined` when the host has no board (`:296-297`, `:316`).
- An empty or whitespace-only subject is skipped (`:309`).

The deduplication belongs to the host rather than to `ExitPlanMode` because only the host can see the board (`plan-mode.ts:55-62`). Re-approving the same plan — a retry, a repeated call — must not double the board, and the count is what the result text is allowed to say.

The task board itself is documented in [Tools](tools.md). The behavior worth repeating here: the plan's steps are created `pending`, and the task board persists in the session file, so an approved plan's board outlives the run that created it (`packages/coding-agent/src/task-snapshot.ts:18`, `:44-63`).

## The plan snapshot

A plan is kept in the session file so that a later `EnterPlanMode` can put the earlier proposal back in front of the model, and so `/plan` can print it (`packages/coding-agent/src/plan-snapshot.ts:1-13`).

- **Kind.** `PLAN_SNAPSHOT_KIND = "plan"`, a `custom` entry on the session's active chain (`plan-snapshot.ts:17-18`).
- **Shape.** `{ plan, steps?, approved, at }`: the full text the user was shown, the ordered steps, whether the state is a proposal or an approval, and an ISO timestamp (`:36-45`). `PlanStep` is the task board's shape without the board's ids (`:30-34`).
- **Write.** Best effort: a session file that cannot be appended to must not fail the turn (`:57-66`). A snapshot equal to the newest one is skipped (`:60-61`, comparison at `:119-129`). An absent session is a no-op (`:58`).
- **Read.** The newest *valid* snapshot on the active chain, walking backwards and checking each candidate (`:77-86`, validation at `:131-155`). The active chain is the point: a plan abandoned by a branch is not resurrected (`:68-75`). A non-boolean `approved` or a blank `plan` is rejected rather than trusted (`:131-155`).
- **Compaction.** A compaction hangs its boundary off the chain's root, so the snapshot above it leaves the active chain. The REPL reads the plan when the pass announces `preparing` and writes it back when the pass is `done` (`packages/coding-agent/src/interactive.ts:940`, `:1003`); `reanchorPlanSnapshot` is the write-back, and `writePlanSnapshot`'s de-duplication keeps a pass that did not re-root from growing the file (`plan-snapshot.ts:88-102`; `interactive.ts:1003`). A failed pass clears the held snapshot so a stale plan is not written later (`interactive.ts:1024`).
- **Injection cap.** A re-entering `EnterPlanMode` injects the saved plan under a short header (`plan-mode.ts:366-379`). The body is bounded to `MAX_INJECTED_PLAN_CHARS = 8000`, and the cut is marked with the exact number of characters dropped (`plan-snapshot.ts:20-28`, `:104-117`). The bound exists because a session can enter plan mode many times, and every re-entry would otherwise carry every earlier plan (`:20-27`).

`/plan` prints the full body, not the bounded copy: the cap exists for what goes back into a turn, and the user asked to read it (`interactive.ts:4555-4560`).

## The review surface

The REPL's plan review is a separate component from the permission dialog. A plan is read, not scanned for danger, and the useful rejection is a sentence rather than a no (`packages/tui/src/components/PlanReviewDialog.tsx:15-29`).

- **Three answers.** Approve, keep planning, or send feedback to the planner (`PlanReviewDialog.tsx:67-80`, `:181`).
- **Inline feedback.** The third answer opens a one-line input; Enter sends the trimmed text, Backspace deletes, and Esc backs out to the answer list without answering (`:118-131`). The text travels back through `ExitPlanMode`'s result to the planner (`:20-24`); a review that could only say no would make the model guess what was wrong.
- **Two-level Esc.** On the answer list Esc cancels the whole review (a `null` answer); inside the feedback input Esc returns to the list. A single Esc that canceled a half-typed sentence would throw away work (`:25-28`, `:119-122`, `:147-150`).
- **Display cap.** The dialog prints at most `PLAN_REVIEW_MAX = 12000` characters and says how many of the total it showed. The string is React state redrawn every frame, so it is bounded; the reader gets a note, not a silent cut (`:8-13`, `:57-58`, `:190-192`).
- **One settle.** A burst can contain Enter and Esc in one read, so the dialog resolves once (`:48-55`).
- **Keyboard and pad.** `↑`/`↓` move, Enter confirms, `1`-`3` answer directly, `y`/`n` are shortcuts on the answer list only (`:147-179`). The controller maps up/left and down/right to movement, confirm to the highlighted answer, and cancel to `null`; in feedback mode confirm sends and cancel goes back (`:83-116`).

The dialog is held in a single slot (`packages/tui/src/plan-review-slot.ts:18-33`). A second request replaces the first and settles it as canceled, `clear` settles the current one as canceled, and an abort that lands while the plan is up takes the dialog down in the same statement that settles the promise (`:34-91`). Replacement, `clear`, and abort all end in `null`, which the caller reads as "canceled" rather than as a rejection nobody gave (`:29-33`; `plan-mode.ts:246-251`).

Hosts without this surface fall back to the boolean permission dialog, which cannot carry feedback (`plan-mode.ts:90-98`, `:234-242`).

## `/plan` and `/todo`

Both are app commands, so `/help` lists them: the help text is generated from `appCommandTable` (`packages/coding-agent/src/interactive.ts:3400-3451`), and `/plan` and `/todo` are entries there (`:3431`, `:3442`).

- `/plan` takes no arguments and refuses extra ones with a usage line (`interactive.ts:4539-4543`). It reads the live session store, so after an in-app `/resume` it prints the incoming conversation's plan (`:4544-4548`). With no snapshot it says so (`:4549-4552`). Otherwise it prints the state (`approved` or `proposed`), the step count, the save time, and the full text (`:4553-4561`).
- `/todo` reads the live task board at dispatch, for the same resume reason (`interactive.ts:4563-4567`). An empty board has its own line (`:4568-4571`). Each task prints its id, status, subject, and, when present, the owner, the active form, the blockers, and the description (`:4572-4580`). The board comes through `taskSnapshot`, which the host wires to `taskStore.snapshot()` (`:2360`).

## Reminders

The board reminders are an interactive-host feature (`packages/coding-agent/src/task-nudges.ts:1-15`). The controller is plain counters over a `TaskStore`, pumped from session events (`:94-122`), with these rules:

- **Startup announcement, once per attached session.** The first `agent_start` announces the number of unfinished tasks, and only when that number is above zero; later starts do not repeat it (`task-nudges.ts:124-135`).
- **Stale board, ten turns.** Two counters run: turns since the last board-tool call and turns since the last reminder. A reminder fires only when both reach `TASK_NUDGE_THRESHOLD = 10`, and firing restarts both, so the next turn cannot repeat it (`:19-20`, `:105-108`, `:137-154`). Any of the four board tools restarts the write counter, reads included: a model that keeps consulting the board has not forgotten it (`:166-173`).
- **Long planning, ten turns.** `turn_end` events observed while the session is in plan mode advance a separate counter; at 10 the model is reminded that `ExitPlanMode` hands the plan over, and the counter restarts. A turn outside plan mode resets it (`:109-110`, `:141-142`, `:160-163`).
- **Completion follow-up.** Only `agent_end` with reason `completed` qualifies (`:175-176`). It fires at most once per run, at most `MAX_COMPLETION_NUDGES = 3` times per attached session, only when the run touched a board tool, and only when a task is still `in_progress` (`:22-28`, `:111-121`, `:175-192`). The once-per-run gate resets at `agent_start` (`:128`).
- **Stop hook.** When the Stop hook resumes the run, `onStopHookContinued` marks it and the completion reminder is skipped: the host's own continuation is already the reason to keep going (`:177-179`, `:194-197`; `interactive.ts:1802-1815`).
- **Abort and error.** Any end reason other than `completed` leaves the board alone (`task-nudges.ts:176`).
- **Delivery.** Reminders steer a live run and follow up after it ends (`task-nudges.ts:12-14`, `:33-34`).
- **Switch.** `LBB_TASK_REMINDER=off` turns every reminder off for the attached session; the value is read once at construction (`:36-40`, `:100-102`).

The REPL builds one controller per attached session, so a hot swap starts from fresh counters and the incoming conversation's own plan-mode state (`interactive.ts:1707-1719`). It is wired into `agent_start`, `tool_execution_end`, `turn_end`, and `agent_end` (`:1725`, `:1735`, `:1740`, `:1810-1815`).

## Hosts

| Host | Plan tools and review | Plan snapshot | Task board |
| --- | --- | --- | --- |
| Interactive REPL | `EnterPlanMode` and `ExitPlanMode`, review dialog, abort race (`interactive.ts:1375-1378`, `:1421`, `:2711-2738`) | Written, read, re-anchored, and injected (`interactive.ts:940`, `:1415-1419`, `:1003`) | One store bound to the live session, restored on `/resume` (`interactive.ts:669-673`, `:1907`) |
| Headless `-p` | None: no plan tools and no plan order (`headless.ts:531-532`) | Neither written nor read | One store bound to the run's session; `--no-session` keeps it in memory (`headless.ts:324-330`, `:418-424`) |
| ACP editor | None. The connection advertises the `plan` permission mode and `session/set_mode` can select it, but there is no plan tool, no review dialog, and no way to approve a plan (`acp.ts:519-532`, `:693-704`, `:1099-1100`) | Neither written nor read | One store per live session, bound to that session's store, re-saved after a compaction (`acp.ts:997-998`, `:1020-1025`, `acp.ts:1183-1191`) |

A headless run can still be started in the plan permission mode through `--permission-mode` (`packages/coding-agent/src/main.ts:189-190`, `headless.ts:453-463`). There it is only the gate: every non-read-only call is denied, and nothing exists to present or lift a plan.

The ACP host's task board is part of the same tool set assembly as the other two: `createAllTools` appends the four task tools when a `taskStore` is present (`packages/tools/src/index.ts:120`, `:193`; `acp.ts:998-1005`). ACP's plan absence is therefore a property of its tool list, not of the protocol: the mode it advertises and the tools it offers are different tables (`acp.ts:519-532` versus `:998-1005`).

## The plan seat

`settings.roles.plan` names the model the planning cycle runs on (`packages/coding-agent/src/model-roles.ts:9`). The `PlanModelSwap` contract is read at the call: `planModel()` returns the resolved seat or `undefined`, and `undefined` means the session keeps its model (`plan-mode.ts:101-118`).

- **Model-driven entry swaps.** If the seat resolves and differs from the session model, `enterPlanMode` sets it and calls `onModelSwapped` (`plan-mode.ts:198-202`). The host rebuilds everything that binds to a model — the compaction wiring, the threshold, and the status row (`interactive.ts:1382-1399`).
- **Approval restores, with a guard.** The previous model is restored only when the seat is what is in effect: a `/model` switch made mid-plan is the user's own choice and outranks the restore (`plan-mode.ts:271-285`).
- **No persistence.** Entering and leaving plan mode is a cycle, not a model choice, so nothing is written to the user's settings (`plan-mode.ts:109-111`).
- **The user door does not swap.** `/mode plan` typed at the prompt sets the mode without starting a planning task, and it keeps the session's model; the seat is for the cycle the tools drive (`plan-mode.ts:111-113`; `interactive.ts:4465-4493`).
- **Rejection keeps the seat.** The pair and the model stay saved and live while the session remains in plan mode; the restore happens only on approval (`plan-mode.ts:252-288`).

## Tests that hold these claims

- `packages/coding-agent/test/plan-lifecycle.test.ts` covers the cycle end to end: entry, approval, rejection and feedback, cancellation, abort, session swap, the steps bridge, the result text, the re-entry injection, and `/plan` and `/todo` (`plan-lifecycle.test.ts:722-950`).
- `packages/coding-agent/test/plan-snapshot.test.ts` covers the snapshot shape, the checked read, the de-duplication, and the injection cap (`plan-snapshot.test.ts:182-189`).
- `packages/coding-agent/test/task-nudges.test.ts` pins the thresholds and the completion ceiling (`task-nudges.test.ts:94-227`).
- `packages/coding-agent/test/plan-model-routing.test.ts` holds the plan seat's swap and restore.
- `packages/coding-agent/test/plan-mode-allowlist.test.ts` holds the plan gate against each tool's own `isReadOnly`, so the denial list and the declarations cannot drift (`plan-mode-allowlist.test.ts:1-20`).

## Known traps

- **Two axes, not one.** Saving only the permission mode restored a sandbox the user never chose; the pair is the restore point (`plan-mode.ts:120-140`).
- **The first snapshot must not win forever.** A cycle can end without an approval, so an outside record replaces an older one (`plan-mode.ts:162-177`).
- **A canceled review is not a rejected plan.** Null, abort, and a replaced dialog all become "canceled"; only an answer from the reviewer is reported as one (`plan-mode.ts:246-267`).
- **Approval is checked after the await.** A dialog that answered "approved" while its run aborted, or while `/resume` swapped the session, must not lift the gate (`plan-mode.ts:255-267`).
- **The archive is recorded before the result.** The approval sentence says the plan is archived because the write happened first; the step sentence promises only the count (`plan-mode.ts:325-348`, `:426-436`).
- **A snapshot is file data.** Both snapshots validate what they read; an unknown status or a non-boolean decision is rejected rather than trusted (`plan-snapshot.ts:131-155`; `task-snapshot.ts:99-124`).
- **A pass that never re-rooted is not a reason to grow the file.** The post-compaction write-back de-duplicates (`plan-snapshot.ts:57-66`, `:88-102`).
