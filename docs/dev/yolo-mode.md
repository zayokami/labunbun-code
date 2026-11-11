# YOLO mode

**Status:** implemented. The engine half is pinned in
`packages/agent/test/permissions.test.ts` and `yolo-session.test.ts`, the door
and its screens in `packages/coding-agent/test/yolo-command.test.ts`, and the
phrase dialog and Shift+Tab brake in `packages/tui/test/phrase-confirm.test.tsx`
and `repl-shift-tab.test.tsx`.

YOLO — *You Only Live Once* — is a session-level override that turns off the
automatic permission gates: the dangerous-command classifier, ask rules, and
every approval dialog. It is entered only by typing an exact confirmation
phrase at an interactive prompt. The sandbox stays on. The feature is modeled
on Codex's `--yolo`, but deliberately differs from it in four ways: there is
no CLI flag, it is not persisted, it cannot be enabled without a human typing
the phrase, and `danger-full-access` is not a valid YOLO posture.

The one-line contract, repeated wherever the feature is described:

> No classifier, no prompts, no automatic guardrails. The sandbox remains.
> Deny rules and hooks remain.

## What Codex does, and what we borrow

Codex spells YOLO as `--dangerously-bypass-approvals-and-sandbox`, with
`--yolo` as an alias (`codex-rs/utils/cli/src/shared_options.rs`). It sets the
approval policy to `never` and disables the sandbox at the same time. Its TUI
then labels the session `permissions: YOLO mode`
(`codex-rs/tui/src/history_cell/session.rs`). There is no typed confirmation;
the flag is the whole ceremony.

We borrow the name and the visible badge. We do not borrow the flag or the
sandbox half. A flag is a decision made in a shell, often in a script, and it
is exactly the kind of decision this feature wants a person at the prompt for.
And this build already treats the sandbox as a separate axis whose whole
purpose is to remain when the approval axis widens — `sandbox` is not a
permission mode (`packages/agent/src/types.ts:32-57`). Turning it off is what
`Agent (no sandbox)` is for, and YOLO must not quietly become a second name
for it.

## The shape: a session flag, not a permission mode

`PERMISSION_MODES` has three values (`ask`, `plan`, `agent`) and is the source
every consumer reads: the settings schema, the CLI validator, the picker, the
ACP mode list, and the policy snapshot
(`packages/agent/src/types.ts:48`, `packages/coding-agent/src/settings.ts`,
`packages/coding-agent/src/policy-snapshot.ts:203-210`). YOLO must not be a
fourth value.

Adding it there would create four paths that bypass the phrase:

1. `settings.json` could persist it.
2. `--permission-mode yolo` could set it before any REPL exists.
3. `MODE_CHOICES` would put it in the `/mode` picker and the Shift+Tab cycle.
4. `policy-snapshot.ts` would save it, so `--resume` would re-enter it
   without asking.

The phrase is not decoration on top of a mode; it is the entry condition. A
mode enum is the wrong shape for a state that must not be restorable from a
file or a command line.

So YOLO is a boolean on the live `AgentSession`, not a member of either enum:

```ts
get yolo(): boolean
enableYolo(): { ok: true } | { ok: false; reason: string }
disableYolo(): void
```

`setMode` clears it. Any mode change — `/mode`, Shift+Tab, or the model's own
`EnterPlanMode` — is an exit, because the two postures must never coexist.
`enableYolo` refuses when the session is running, when the mode is `plan`, or
when the sandbox is `danger-full-access`; those checks live beside the flag
rather than only in the command, so every caller gets the same answer.

The flag is read where the permission decision is made, not copied into the
tool-call context. The interactive session reads `sessionRef?.yolo` at the
call, exactly the way it reads the live `sandbox`; subagents and band members
read the root session's flag through a live getter. A copied boolean would go
stale the moment `/yolo` or a mode change landed on the parent, which is the
one failure this feature cannot afford.

### The Kimi name collision

`kimi-plan.ts` already has a `yolo` key: Kimi's session-level `yolo` is
migrated to `agent` with `danger-full-access`
(`packages/coding-agent/src/kimi-plan.ts:57-73`). That is a migration of
another product's posture, not this feature. It stays as it is. Our YOLO is
not a successor to `bypassPermissions` either: that retired key still migrates
to `Agent (no sandbox)` (`packages/coding-agent/src/settings.ts:38`), and the
two are deliberately different — the old posture turns the sandbox off, ours
does not.

## Entry: the only door

`/yolo` in the interactive REPL is the only way in. It checks, in order:

1. There is a live session.
2. The session is not running a turn. A policy change that lands halfway
   through a run is a change nobody confirmed against the work already in
   flight.
3. The mode is not `plan`. Plan mode's whole promise is that mutations are
   denied; YOLO would either be a no-op or would have to break that promise.
   The answer is to leave plan mode first.
4. The sandbox is not `danger-full-access`. The user asked for YOLO with the
   sandbox retained; a session with no sandbox is the Codex posture, not this
   one. The answer is `/mode agent` (the confined `Agent` row), then `/yolo`.
5. A managed policy has not set `disableBypassPermissionsMode`
   (`packages/coding-agent/src/settings.ts:312-318,876-880`). A policy that
   forbids bypass-permission modes must forbid this one too; the confirmation
   phrase cannot overrule the policy tier. This is checked before the dialog,
   so the user is not asked to type a phrase that cannot unlock anything.
6. An interactive phrase-confirmation surface exists. A headless run, an ACP
   client, or a host without a dialog has no way to satisfy the confirmation.

If a condition fails, the command prints one line naming the reason and
changes nothing. It does not open the phrase dialog first and fail
afterwards.

There is deliberately no `--yolo` flag, no settings key, no environment
variable, and no ACP mode. A scripted invocation has no person to type the
phrase; a flag would be a second, weaker door.

### The confirmation

`/yolo` opens a dedicated phrase dialog. It is not the structured
`QuestionDialog`: that dialog's free-text `Other…` row resolves whatever was
typed, with no validation and no retry
(`packages/tui/src/components/QuestionDialog.tsx:156-182`), which is the
opposite of what a safety confirmation needs.

The dialog shows:

- The name and the consequences, in two lists: what stops running and what
  still applies.
- The active sandbox mode by name, and the fact that the sandbox is now the
  only remaining automatic containment.
- The exact phrase, verbatim and in the same capitalisation:
  **`I only live once`**.
- The input field, with a persistent hint that the phrase is case-sensitive.
- `Enter` to submit, `Esc` to cancel.

The comparison is case-sensitive and exact after trimming surrounding
whitespace. A mismatch keeps the dialog open and shows an error; it does not
close, and it does not count as a refusal. There is no attempt limit — this
is a confirmation, not a lockout. `Esc` resolves `false` and leaves both
axes, the badge, and the policy untouched.

The field is keyboard territory. A gamepad cannot type the phrase, and the
pad's confirm button must do nothing while this dialog is up. That is not a
gap: a controller user can still choose every mode on the existing picker;
YOLO is the one posture that requires a keyboard because it requires a typed
acknowledgment.

The phrase constant lives in one place in the app layer and is exported for
tests. It is displayed, not hashed or hidden — the user has to be able to
read what to type, and the phrase is a warning, not a secret.

## What changes in the evaluator

`evaluatePermissions` gains one optional input, `yolo?: boolean`. Absent means
`false`; every host that cannot enable YOLO simply omits it, and the engine's
default is the safe one.

The existing order (`packages/agent/src/permissions.ts:15-40`) is preserved.
Only the marked rows change:

| Step | Rule | Under YOLO |
| --- | --- | --- |
| 1 | Deny rules, every source | unchanged |
| 2 | `plan` read-only gate | unchanged; YOLO cannot be entered in `plan`, and a move to `plan` clears it |
| 2b | `read-only` sandbox's `Write`/`Edit` gate | unchanged; this is the sandbox, not an approval |
| 3 | Bash shape check | unchanged |
| 3 | Dangerous-command classifier | **skipped** |
| 3b | Escalated Bash (`escalate: true`) | **denied**, not allowed — see below |
| 4 | Ask rules | **skipped** |
| 5 | Allow rules | unchanged |
| 6 | Mode's fallback | **allow**, regardless of mode |

Two details matter at step 3. The `Bash` call with no readable string command
is still denied (`packages/agent/src/permissions.ts:517-525`). That is a
shape check, not a classifier decision: a call that is not shaped like a Bash
call should have failed schema validation, and a fail-safe that catches it
must not disappear with the classifier. Only `classifyDangerousCommand` and
`decideDangerous` are skipped.

And the classifier is skipped for every Bash surface, including the `!`
passthrough. `!cmd` is still evaluated by the same engine
(`packages/coding-agent/src/interactive.ts:2226-2240`), still sandboxed by the
same policy (`packages/coding-agent/src/shell-passthrough.ts:76-97`), and
still refused by deny rules. YOLO removes the classifier from the user's own
typed command too; that is what "classifier disabled" means.

### Why escalated Bash is denied

`escalate: true` is a request to run one command *outside* the sandbox
(`packages/tools/src/bash.ts:215`). The existing engine answers it with an
ask on every call, above every allow rule and every mode
(`packages/agent/src/permissions.ts:530-551`). Under YOLO there is no ask.

The obvious "standing yes" would approve it, and that would silently defeat
the one thing YOLO promises to keep. A mode that keeps the sandbox but
approves every request to leave it is a mode that does not keep the sandbox.
So under YOLO the well-formed escalated call is **denied**, with a message
that says why and what to do: remove `escalate`, or leave YOLO.

The shape checks above it still run first: an escalated call in the
background, or one with no justification, is refused for its own reason
before the YOLO refusal. If the sandbox were `danger-full-access`, escalation
would be moot, but YOLO cannot be entered there, so there is no allow case to
write.

### Ask rules are lifted, deny rules are not

This is the one place the design makes a distinction the word "disabled" does
not:

- An **ask rule** is a request for a human decision. YOLO is a standing
  approval for everything the human would have been asked. There is no dialog
  to show, so the rule has nothing left to do; treating it as a denial would
  make YOLO stop unpredictably on rules the user wrote to be *consulted*, not
  to be refused.
- A **deny rule** is not a prompt. It is the user's own floor, and this
  repository's security invariant is deny-scan-first: no mode, no shortcut,
  and no earlier bypass may reach past a deny rule
  (`packages/agent/src/permissions.ts:62-73`;
  `.labunbun/skills/code-review-security/SKILL.md`). YOLO does not reopen
  that. If a user wants a hard stop under YOLO, they should write a deny rule
  — and the confirmation dialog says so.
- **Hooks** are in the same category as deny rules: explicit user-authored
  policy, not an automatic guardrail. They still run.

The confirmation dialog says all three things, because a user who expects
"everything off" would otherwise be surprised in either direction.

The plan gate and the read-only write-tool gate also stay for a simpler
reason: they are not approvals. They are what the chosen mode and sandbox
mean. YOLO does not change the mode or the sandbox, so it does not change
them.

## The sandbox, and what "retained" covers

YOLO never writes the sandbox axis. Whatever the session was in — `read-only`
or `workspace-write` — is what it keeps running under, including the writable
roots, the network axis, and the platform backend. The `Agent (no sandbox)`
row is still the only way to turn confinement off, and YOLO refuses to start
there.

All existing tool-layer enforcement stays:

- `workspace-write` still confines writes to the workspace and the configured
  writable roots.
- `read-only` still refuses `Write` and `Edit`, and still refuses `Bash` where
  the platform has no read-only backend
  (`packages/tools/src/sandbox/index.ts:487-494`).
- The network proxy and its domain table are unchanged.

The classifier was the last automatic *semantic* check before a command ran.
With it gone, the sandbox is the only automatic containment left. The
confirmation dialog says that in as many words. This is the risk the phrase
exists to make explicit: a dangerous command that the classifier would have
stopped now reaches the sandbox, and the sandbox decides.

## Subagents, bands, and other hosts

YOLO is a property of the root interactive session. It is not a new mode that
every host has to advertise.

- **Subagents** spawned while it is on must continue under it; otherwise the
  parent would interrupt itself with a permission dialog for work it already
  approved. The subagent bridge already exposes the parent's live mode and
  sandbox as getters (`packages/coding-agent/src/subagents.ts:187-194`), and
  YOLO joins them. The subagent's `canUseTool` passes the live answer into the
  engine (`packages/coding-agent/src/subagents.ts:602-610`); turning YOLO off
  in the parent reaches the worker's next call without a restart.
- **Beetle members** get the same live getter. Their evaluator call site is
  `packages/coding-agent/src/beetle.ts:818-825`.
- Workers **cannot enable** YOLO. They have no `/yolo` command and no phrase
  dialog; only the root session's interactive command does.
- **Headless runs** (`packages/coding-agent/src/headless.ts:949-963`) and
  **ACP sessions** (`packages/coding-agent/src/acp.ts:812-818`) omit the
  flag. They have no phrase surface, and adding one to the protocol would be
  a second entry door. Their existing fail-closed behavior for an unresolved
  ask is unchanged.
- Enabling YOLO while a background subagent or band is already running
  applies to it from its next permission decision. The confirmation dialog
  says so. This matches how `/mode` already changes a live session's posture;
  it is not a retroactive rewording of an answer already given, and it does
  not auto-answer an ask that is currently on screen.

## Lifecycle and persistence

YOLO is session-only, in the strongest sense:

- It is not in `Settings`, so no file can enable it.
- It is not in the CLI validator, so no flag can enable it.
- It is not in `PolicySnapshot`, so `--resume` cannot restore it. The policy
  snapshot's validator keeps checking the three modes and three sandboxes
  (`packages/coding-agent/src/policy-snapshot.ts:203-210`); there is no
  fourth axis to validate.
- It is not carried across `/resume`. The incoming session starts without it;
  the incoming session's own mode and sandbox decide its badge.
- It dies with the process. A crash, a kill, or a normal exit leaves nothing
  to re-enter.

Three exits:

1. `/yolo` again, or `/yolo off`: turn it off, restore the badge to the
   underlying `describeModeChoice` label, and print one info line.
2. `/mode …`: the mode change itself clears it; the selected row is applied
   and published as usual.
3. Shift+Tab: if YOLO is on, the first press **only exits YOLO**. It does not
   cycle the mode on that press. The next press cycles normally. A key whose
   first press both disarms the widest posture and moves to the next row
   would make the safety brake and a mode change the same gesture, and the
   user would have to predict which row they land on to know whether they
   actually stopped YOLO. One press, one meaning.

Any other mode change, including the model's `EnterPlanMode`, also clears
it: `setMode` is the single place that owns the transition, and the plan
callback that publishes the new badge already reads the live pair
(`packages/coding-agent/src/interactive.ts:1408-1413`).

Because YOLO never mutates the mode or the sandbox, exiting needs no saved
"previous pair". The session was in its original posture the whole time;
YOLO was an overlay that stopped applying.

## The surfaces

### The prompt badge

The prompt already shows the permission mode as `[Label]` under the input,
coloured by `MODE_BADGE_COLOR`
(`packages/tui/src/components/PromptInput.tsx:174-179`). While YOLO is on,
the label is `YOLO` and the colour is the one already used for the
permission class (`Agent (no sandbox)`). On exit the label goes back to
`describeModeChoice(session.permissionMode, session.sandbox)`.

The badge is a copy in the UI store — the session has no event for `setMode`
— so `/yolo`, its exit path, Shift+Tab, and the plan callback all write it
through `publishModeLabel`/`setModeLabel`, the same route `/mode` already
uses (`packages/coding-agent/src/interactive.ts:3397-3402`).

### `/status` and `/permissions`

The `/status` card's `permissions` row becomes
`YOLO · <describeModeChoice(label)>` while the flag is on. The underlying
mode is still named, because it is still what runs the moment YOLO ends.

`/permissions` is the screen a user opens to find out what is actually
holding the session in, so it gets the full statement:

```
YOLO: on — classifier off, ask rules ignored, approvals suppressed.
Deny rules, hooks, and the sandbox still apply.
```

The rules list marks ask rules as `ask (ignored under YOLO)` while it is on,
and the existing sentence that says the classifier applies in every case
including the unrestricted sandbox
(`packages/coding-agent/src/interactive.ts:3763-3765`) is made conditional:
it is true in every posture except this one. The deny rules above it are
still the floor the screen describes.

If a managed policy has disabled bypass modes, `/permissions` says that too,
and `/yolo` refuses before it opens the dialog.

### `/help` and completion

`/yolo` joins `appCommandTable()` with a one-line description, so `/help` and
the prompt's command completion both learn it. The description names the
cost: no classifier, no approvals, sandbox retained, confirmation required.
It is alphabetically last (`/vim`, then `/yolo`).

An info line records both transitions:

```
YOLO on · classifier and approvals off · sandbox workspace-write · deny rules still apply
YOLO off · Agent (agent · sandbox workspace-write)
```

The entry line is the only durable trace in the transcript. There is no
separate audit log to add: the session file already records the transcript,
and the flag itself is deliberately not a persisted fact.

## Edge cases worth pinning

- `/yolo` while a turn is running: refused, with the reason. The run is not
  stopped and no dialog is opened.
- `/yolo` in plan mode: refused. `/mode agent` first, then `/yolo`.
- `/yolo` with `danger-full-access`: refused. This is the one condition that
  distinguishes us from Codex; the message says so.
- `/yolo` under a managing policy with `disableBypassPermissionsMode`:
  refused before the phrase dialog.
- Wrong phrase, wrong case, extra words: dialog stays open, error shown,
  nothing enabled.
- `Esc` in the dialog: cancels, nothing enabled.
- `/mode plan` while YOLO is on: exits YOLO and enters plan. The plan gate
  holds.
- `EnterPlanMode` from the model while YOLO is on: `setMode` clears YOLO;
  the plan gate holds.
- Shift+Tab while YOLO is on: exits YOLO only; the next press cycles.
- A subagent running when YOLO is enabled: its next permission decision uses
  the new flag; an ask already on screen is still answered by the human.
- A deny rule matching a command: still denied, with the rule's own message,
  in every YOLO state.
- An ask rule matching a command: does not prompt; the call falls through to
  an allow rule or to YOLO's fallback allow. `/permissions` marks the rule as
  ignored.
- An escalated Bash call: denied with the sandbox explanation, not asked.
- `!cmd` with a classified command: runs if the sandbox permits it and no
  deny rule refuses it. That is the classifier being off, not the sandbox.
- `AskUserQuestion`: still asks. It is a question to the user, not a
  permission gate, and YOLO does not answer questions on the user's behalf.
- MCP server approval: unchanged. Trusting a server is not a tool-call
  permission, and the approval ledger stays outside the working tree.
- `bypassPermissions` in an old settings file: still migrates to
  `Agent (no sandbox)`, not to YOLO. YOLO is not a restored mode.
- Kimi's `yolo` migration: still maps to `agent` with
  `danger-full-access`; it does not enter this feature.

## Tests

The engine tests are the load-bearing ones, because they are the only place
the order can be checked without a terminal:

- YOLO bypasses the dangerous-command classifier for a command that is
  otherwise a final deny in `agent` mode.
- A missing `command` string is still denied under YOLO.
- YOLO skips ask rules but still honours deny rules first.
- YOLO returns `allow` in `ask` mode for an undecided call.
- YOLO does not bypass the `plan` gate; the plan case is denied.
- YOLO does not bypass the read-only sandbox's `Write`/`Edit` refusal.
- An escalated Bash call is denied under YOLO with the sandbox message, and
  the malformed escalated cases still fail their own checks first.
- The default (`yolo` absent or `false`) is byte-for-byte the old behavior on
  every one of those cases.

Session and app tests:

- `enableYolo` refuses while running, in `plan`, and with
  `danger-full-access`.
- `setMode` clears the flag; `disableYolo` is idempotent.
- `/yolo` refuses before the dialog under a managed
  `disableBypassPermissionsMode`.
- The phrase dialog: exact phrase enables; wrong case, wrong words, empty,
  and surrounding whitespace are answered as specified; `Esc` cancels; a
  mismatch leaves the dialog up.
- The badge is `YOLO` while on and returns to the underlying label on every
  exit path.
- Shift+Tab while on exits only; the next press cycles.
- `/mode` and `EnterPlanMode` clear the flag.
- `/status` and `/permissions` name the flag and the ignored ask rules.
- The policy snapshot and resumed session do not carry it.
- A subagent started under YOLO uses it; turning it off in the parent stops
  it at the worker's next decision.

Structural tests, in the spirit of `mode-enum.test.ts`:

- `PERMISSION_MODES` is still exactly `["ask", "plan", "agent"]`.
- `MODE_CHOICES` has no YOLO row and `findModeChoice("yolo")` is undefined.
- The settings schema, CLI validator, and policy snapshot have no YOLO key.
- `appCommandTable()` has a `/yolo` row and the dispatch handles it.

## Alternatives considered

**A fourth permission mode.** Rejected for the reasons in "The shape" above:
it would be settable from settings, CLI, policy, and resume, and the phrase
would become optional decoration.

**A `--yolo` CLI flag, mirroring Codex.** Rejected. A flag is a shell-level
decision, usually scripted, and it cannot demand a typed phrase. It would
also need a persistence story, which is exactly what this feature must not
have.

**Codex parity: turn the sandbox off too.** Rejected. The user's requirement
is that the sandbox remains, and this build already has a separate row for
"no sandbox". Making YOLO a synonym for it would remove the distinction the
two-axis design exists to preserve.

**Ignore deny rules too.** Rejected. Deny-scan-first is a documented security
invariant; reintroducing an early allow before the deny scan is the exact
bug that was removed when `bypassPermissions` lost its early return
(`packages/agent/src/permissions.ts:68-72`). A user who wants a command never
to run should write a deny rule, and YOLO says so.

**Treat ask rules as denials under YOLO.** Rejected. An ask rule is written
to be consulted, not refused; turning it into a denial would make YOLO stop
on rules the user did not write as stop rules, and the user would have no
prompt explaining why. Lifting asks is the meaning of the standing approval;
deny rules are the place for a hard stop.

**Allow escalated Bash because there is no dialog left to ask.** Rejected.
That would make YOLO a sandbox bypass in practice. The sandbox is the one
thing YOLO promises to retain; an escalated call is a request to leave it, so
the only safe no-human answer is no.

**Reuse `QuestionDialog`'s `Other…` field.** Rejected. It resolves whatever
was typed, has no validation or retry, and its state is a list of questions
with options. A phrase confirmation needs exact-match checking and an error
state that keeps the dialog open; a dedicated `PhraseConfirmDialog` is
smaller than teaching the question dialog a second, stricter mode.

**A settings key or environment variable.** Rejected. Both are scriptable
and both would let a repository or a wrapper enable the posture without a
person at the prompt.

## Implementation map

| Area | Files |
| --- | --- |
| Engine input and order | `packages/agent/src/permissions.ts`: add `yolo?: boolean`; skip classifier and ask rules; deny escalated Bash; YOLO fallback; keep shape checks and deny scan first |
| Session flag | `packages/agent/src/session.ts`: `#yolo`, getter, `enableYolo`/`disableYolo`, `setMode` clears it |
| Command and wiring | `packages/coding-agent/src/interactive.ts`: `/yolo` dispatch and help row; entry conditions including policy; phrase prompt; pass `yolo` to `canUseTool`, the recheck, `canAutoResolve`, and `!cmd`; `/status`, `/permissions` |
| Confirmation UI | new `packages/tui/src/components/PhraseConfirmDialog.tsx`; `packages/tui/src/ui-state.ts` state; `packages/tui/src/app.tsx` handle and slot; `packages/tui/src/components/REPL.tsx` overlay, key gating, Shift+Tab brake |
| Badge | `packages/tui/src/components/PromptInput.tsx`: `YOLO` colour |
| Workers | `packages/coding-agent/src/subagents.ts`, `packages/coding-agent/src/beetle.ts`: live `yolo` getter into the evaluator |
| Unavailable hosts | `packages/coding-agent/src/headless.ts`, `packages/coding-agent/src/acp.ts`: omit the flag; no new mode advertisement |
| Docs | this file, `docs/dev/README.md`, and a `CHANGELOG.md` entry when implemented |

The implementation is intentionally small at the engine and deliberately
explicit at the entry. There is one boolean to add to the evaluator, one
boolean on the session, one command, and one dialog. The work is in the
conditions around them, because those conditions are the feature.
