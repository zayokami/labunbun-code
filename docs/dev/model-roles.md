# Model roles

A session is not one model. The main conversation answers, plan mode designs, compaction summarizes, subagents research, and the catalog already contains a local seat — and each of those may want its own provider, model and fallback order. `settings.roles` names them. `packages/coding-agent/src/model-roles.ts` turns the settings into resolved models and those into the fallback chains the stream pipeline walks.

Resolution is fail-soft, and the boundary is worth stating: a role that names nothing warns on stderr and leaves its seat on the host default, where an unknown `settings.model` still stops the app (`settings.ts:327-329`). A role is a convenience, and a convenience that stops the app is worse than one that does not apply.

## The five seats

`ROLE_NAMES = ["main", "plan", "compaction", "light", "local"]` (`model-roles.ts:47`). The order is the order warnings come out in.

- **main** — the main conversation's default, when nothing more explicit picks one. The precedence is `--model` (or the persisted `settings.model`) first, then `roles.main`, then the built-in default (`interactive.ts:479-481`, `headless.ts:244-246`, `acp.ts:894-896`). A persisted `/model` switch outranks the role, exactly as the user's explicit ask should.
- **plan** — what plan mode runs on while planning. A model-driven entry swaps the session model to the seat (`plan-mode.ts:187-198`); an approval restores the session's previous model along with the two axes (`plan-mode.ts:262-279`). A rejection keeps the session in plan mode and on the plan model, because the cycle is not over. A `/model` switch made mid-plan outranks the restore, and a seat equal to the session model is not a swap (`plan-mode.ts:192-196`, `:265-279`). The user-driven `/mode plan` does not swap: the seat belongs to the planning cycle the tools drive (`plan-mode.ts:103-107`).
- **compaction** — the model that writes compaction summaries. It is the newer spelling of `settings.compaction.model` and wins where both are set; the older key keeps working alone (`interactive.ts:511-517`, `headless.ts:274-280`). Only `roles.compaction.model` set means no tuning knobs, but the model still travels (`interactive.ts:519-522`).
- **light** — where subagents run, unless their own definition names a model. The precedence at spawn is: the definition's own model, then the light seat, then the parent's model (`subagents.ts:525-536`).
- **local** — no feature consumes it yet. A configured one draws exactly this warning at startup (`model-roles.ts:166`): `Warning: roles.local is configured, but no feature consumes a local seat yet.` The check reads the raw entry, not the resolution: a local seat that resolved perfectly is still unconsumed, and a user who fixes a bad reference should not have to discover that second fact by reading source (`model-roles.ts:158-167`).

Not every host has every seat. A `-p` run has no plan tools and no plan order (`headless.ts:491-492`); `--permission-mode plan` gives it the read-only gate and nothing to present or approve a plan (`main.ts:189-190`, `headless.ts:413-423`). An editor session (ACP) advertises the `plan` permission mode but has no `EnterPlanMode`/`ExitPlanMode` tools and no review loop, so its plan seat resolves but is never used; it also has no `Task` subagents (`acp.ts:904-908`, `:1076-1077`). Their orders cover main and compaction, and headless also covers light (`headless.ts:502-511`, `acp.ts:1086-1091`). The seats still resolve, and a warning about one is still worth its line, because the same settings file serves the terminal.

## How a seat resolves

`RoleEntrySchema` (`settings.ts:110-128`): `provider` and `model` are optional strings, `fallback` an optional array of references, `budgetUSD` a positive number. The reference syntax is the session model's (`model-roles.ts:30-44`):

- `model` alone is resolved verbatim: a bare id or a `provider/model` string split at its first slash. A bare id names its vendor only — a bare id never resolves to a gateway row.
- `provider` together with `model` builds `provider/model`. The provider is the serving side and the model the id it serves under, which may contain slashes of its own (OpenRouter serves `deepseek/deepseek-chat`) — that is why the serving side has to be nameable at all.
- `provider` without `model` names nothing: the entry warns and is ignored.

Per seat, in `ROLE_NAMES` order (`model-roles.ts:120-157`):

- No model: `Warning: roles.<name> sets no model[(only a provider)] — ignored; <role default sentence>.` — the per-role sentence is one of "the built-in default model will be used" (main), "plan mode will keep the session's model", "the session's model will write summaries", "subagents will run on the session's model", "the local role stays unset" (`model-roles.ts:75-81`).
- Unknown reference: one catalog refresh is offered, then `Warning: unknown model "<ref>" for roles.<name> — <sentence>.` The refresh exists because a reference nothing matched yet may be one a provider is about to name — the local daemon's loadout exists only in its own answer.
- Missing API key: `Warning: <message> — <sentence>.\nExample: export <VAR>=sk-...`. Checked at startup rather than left to the first request, because a light or plan role that only fails when used would present as a request error, not a settings mistake.

Fallback references get no warning and no refresh: an unresolvable entry in a seat's `fallback` list is dropped in silence, exactly as `settings.fallbackModels` has always been handled — a longer safety net that could not be woven should not turn into startup noise (`model-roles.ts:101-104`, `:151-155`).

All three hosts print the warnings to stderr (`interactive.ts:468`, `headless.ts:235`, `acp.ts:892`).

`budgetUSD` rides the resolution rather than the raw settings (`RoleResolution.budgetUSD`, `model-roles.ts:48-58`): an entry whose model did not resolve is ignored whole, budget included, because a ceiling on a seat that never runs reads as enforcement and is none.

## Budgets

`budgetVerdict` (`model-roles.ts:217-225`) has two deliberate rules:

- **A seat with no budget is ok.** Unset `budgetUSD` is the pre-budget behaviour, and a check that blocked there would end runs nobody asked it to end. The budget is opt-in.
- **The comparison is strict**: spending exactly the budget is not over it. A ceiling is a limit, and a run that has spent exactly its limit has not crossed anything; the check before the next spend is where the refusal belongs. A positive-only schema enforces the other half: a ceiling of zero is not a budget, it is a seat that may never run (`settings.ts:127`).

The refusal sentence names the numbers and the setting (`model-roles.ts:221-224`): `Budget reached: $2.5000 spent of the $2.0000 budget for roles.main. Raise roles.main.budgetUSD or switch models.`

`spentUSD` is the number the caller vouches for, and it is *the seat's* spend:

- For a seat about to answer on the session's own loop it is the session's cumulative spend at that moment, subagent runs included — their money is booked into the same session total, so a fan-out counts against the seat that ordered it. The REPL reads it through the cost tracker (`interactive.ts:1485-1488`); headless re-costs the transcript and adds the subagent accumulator, which is what makes a resumed conversation count what it already spent (`headless.ts:794-804`); an editor session re-costs the transcript alone, having no subagents (`acp.ts:1093-1096`).
- For the light seat's subagent gates it is the part of the session total the seat itself spent — `roleCostUSD`, the only share attributable to a seat (`interactive.ts:1202-1208`, `headless.ts:666-672`). The light gate runs twice: at spawn, where a refusal is a tool result saying `No subagent was started.` (`subagents.ts:541-553`), and after each turn's booking, where the refusal is reported and that subagent's own run is aborted (`subagents.ts:393-402`).

Which seat a request belongs to is decided by the ref table, not the request: `seatsByRef` (`model-roles.ts:245-253`) is keyed by `provider/id` because that is all the loop can see. When two roles name the same model the first in `ROLE_NAMES` order owns the ref, so a shared model gets one label and one ceiling. A role that resolved no model owns no ref, and a ref no role names belongs to no seat and is never gated (`model-roles.ts:236-243`).

Two honest limits of the numbers:

- `roleCostUSD` only ever holds `light`. The label rides a subagent booking, and a run books under the light role only when the light seat answered — a definition's own model and the parent's are not role seats (`cost-tracker.ts:70-82`, `subagents.ts:521-531`). Main, plan and compaction spend is in the totals with no record saying which of the three it was, which is why the loop gate asks about the session total and not a per-seat share.
- A resumed session opens `roleCostUSD` at zero: a booking is not a message, so no transcript holds one and there is nothing for a resume to re-derive (`cost-tracker.ts:76-81`).

`/cost` prints a line per seat that has a ceiling: `roles.<role>: $<spent> of $<ceiling>` (`cost-tracker.ts:328-332`). The ceilings come from the raw settings (`roleCeilings`, `model-roles.ts:265-272`), so a budget set for a seat whose model never resolved still shows, reading `$0.0000` — which is how a user finds out the seat they budgeted for is not the one running (`interactive.ts:3523-3526`).

## Fallback chains

`roleOrder` (`model-roles.ts:281-287`) builds one seat's candidates: its model first, then its own `fallback` list, then the global `fallbackModels` as the outer net every role shares. Duplicates keep their first position. The hosts assemble the orders per seat (`interactive.ts:796-808`, `headless.ts:502-511`, `acp.ts:1093-1099`) and hand them to `createModelChainResolver` (`model-roles.ts:308-319`), whose descent rule is: whichever order owns the failing model is walked from *below* that position. Ownership is checked in two passes — first the orders whose primary seat is the failing model, then membership anywhere — and a chain only descends: it never climbs back to a candidate that outranks the model that just failed, because a session moved to a lower rung on purpose must not be dragged back up by another rung's failure. A model no order names gets the global list alone.

## Tests that hold these claims

- `packages/coding-agent/test/model-roles.test.ts` covers resolution, the warning sentences, `budgetVerdict` (`model-roles.test.ts:236`), `seatsByRef` (`model-roles.test.ts:290`), `roleCeilings`, `roleOrder` and the chain resolver.
- `packages/coding-agent/test/interactive-roles.test.ts` and `packages/coding-agent/test/headless-roles.test.ts` run a real process per precedence rule: `--model` versus `settings.model` versus `roles.main`, an unknown `roles.main` warning and falling back, an entry with a provider but no model (`headless-roles.test.ts:162`), and the compaction alias both ways (`headless-roles.test.ts:213`).
- `packages/coding-agent/test/headless-budget.test.ts` holds the refusal end to end, including that a ceiling above what was spent is not a refusal (`headless-budget.test.ts:185`).
- `packages/coding-agent/test/subagent-model-seat.test.ts` holds the light-seat precedence and the usage booking, including that a definition's own model books with no role (`subagent-model-seat.test.ts:169`).
- `packages/coding-agent/test/plan-model-routing.test.ts` holds the plan swap and its restore.
