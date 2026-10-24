# Compaction

Compaction keeps a long session inside its model's context window. It has two rungs. The cheap rung replaces old tool results with previews and makes no model call. The summary rung pays for a model call and records a boundary that stands in place of the summarized prefix. The mechanism lives in `packages/agent/src/compaction.ts`, and the answer it gives is shared by the REPL, a `-p` run, and an ACP session through `packages/coding-agent/src/compaction-wiring.ts` (`packages/coding-agent/src/compaction-wiring.ts:1-16`).

## Limits and triggers

The trigger line is `contextWindow − min(maxOutputTokens, 20k) − reserve` (`packages/agent/src/compaction.ts:199-226`). The 20k cap and the 13k default reserve are constants (`packages/agent/src/compaction.ts:144-145`). `compaction.reserveTokens` replaces the default (`packages/agent/src/compaction.ts:52`, `packages/coding-agent/src/settings.ts:224`).

A small window can be smaller than the reserves, and the formula then computes a negative trigger. Below the point where the reserves fit, the rule takes 60% of the window instead (`packages/agent/src/compaction.ts:194-195`, `packages/agent/src/compaction.ts:224-225`). The result is clamped at zero and kept strictly under the hard limit (`packages/agent/src/compaction.ts:218-225`).

`compaction.thresholdPercent` is an override, not an input. When it is set, it replaces the reserve arithmetic and does not fall back to the proportional share (`packages/agent/src/compaction.ts:53-60`, `packages/agent/src/compaction.ts:206-221`). The schema accepts 1 through 99 (`packages/coding-agent/src/settings.ts:232`). The result is still clamped under the hard limit (`packages/agent/src/compaction.ts:218-220`).

The hard limit is `contextWindow − 3000` (`packages/agent/src/compaction.ts:228-230`, `packages/agent/src/compaction.ts:143`). A request past this line is not sent (`packages/agent/src/compaction.ts:1001`, `packages/agent/src/compaction.ts:1016-1017`).

`compaction.enabled: false` switches off the automatic side only. It stops the summary the threshold asks for and the idle trim (`packages/agent/src/compaction.ts:43-50`, `packages/agent/src/compaction.ts:842-848`). It does not stop a manual `/compact`, which never comes through the manager's automatic door (`packages/agent/src/compaction.ts:844-845`, `packages/coding-agent/src/commands.ts:168`). It also does not stop the forced pass after a provider refuses an over-long request; that pass sets `force`, and the switch is bypassed (`packages/agent/src/compaction.ts:848`, `packages/agent/src/compaction.ts:865-869`).

The cheap rung runs on its own at the threshold only when `microcompactFirst` is set (`packages/agent/src/compaction.ts:61-71`, `packages/agent/src/compaction.ts:851-864`). The app sets it unless `trimOldToolResults` is false (`packages/coding-agent/src/compaction-wiring.ts:387`, `packages/coding-agent/src/settings.ts:188`).

The idle rung is its own trigger. After one hour with no requests (`packages/agent/src/compaction.ts:176-181`), the old tool results become previews for free, because the provider's prompt cache has expired anyway (`packages/agent/src/compaction.ts:939-967`). It runs only under the hard limit and only when `microcompactFirst` is set (`packages/agent/src/compaction.ts:870-879`, `packages/agent/src/compaction.ts:953-958`).

Anti-thrash keeps a pass from summarizing nearly the same context twice. After a compaction, another pass on a context that grew by less than 5% of the window is turned away (`packages/agent/src/compaction.ts:196-197`, `packages/agent/src/compaction.ts:882-894`, `packages/agent/src/compaction.ts:969-972`).

## The cheap rung

`microcompact` replaces the oldest tool results with previews and leaves the newest three whole (`packages/agent/src/compaction.ts:172-175`, `packages/agent/src/compaction.ts:1461-1471`). Each rewritten result is cut to 2000 characters, marker included (`packages/agent/src/compaction.ts:1443-1453`, `packages/agent/src/compaction.ts:1478`). The budget bounds the preview itself, so a second pass finds nothing left to cut (`packages/agent/src/compaction.ts:1450-1453`, `packages/agent/src/compaction.ts:1506-1507`).

With a spill writer, the full text is written to disk first (`packages/agent/src/compaction.ts:1484-1496`). The write is one call per result, and every text block of the result is joined into that one call (`packages/agent/src/compaction.ts:1485-1488`). The preview then opens with `[full output: N chars → path]` (`packages/agent/src/compaction.ts:1496`, `packages/agent/src/output-limits.ts:36-38`). The header appears once, on the first block the rewrite actually changes (`packages/agent/src/compaction.ts:1498-1507`).

A result that already opens with a spill header is never spilled a second time (`packages/agent/src/compaction.ts:1484`, `packages/agent/src/output-limits.ts:40-43`). A writer that throws or returns null degrades to the plain preview; the failure is not a failed compaction (`packages/agent/src/compaction.ts:1488-1496`). Without a writer the preview is what it always was (`packages/agent/src/compaction.ts:1482-1484`), and the full text stays in the session file, which is why a rewritten result can still match its record (`packages/agent/src/session-store.ts:86-96`).

The rung is idempotent. A second pass over the same messages finds nothing over budget, so `trim` counts zero changed results and returns null (`packages/agent/src/compaction.ts:924-935`, `packages/agent/src/compaction.ts:1450-1453`).

The idle rung keeps the newest five whole and requires 20,000 estimated tokens of savings before it applies any of the cut (`packages/agent/src/compaction.ts:182-193`, `packages/agent/src/compaction.ts:959-961`). It is all-or-nothing on purpose: previews that free a rounding error of the window trade detail for nothing (`packages/agent/src/compaction.ts:188-193`).

`trim` counts the results and characters the rung changed and returns the new context with that count (`packages/agent/src/compaction.ts:921-937`). The wiring reports the count and clears the host's read record (`packages/coding-agent/src/compaction-wiring.ts:451-459`).

`slice(-0)` is `slice(0)`, which would keep every result. The hard-limit rescue needs a keep-last-N of zero to mean "the newest results are not protected", so zero gets its own path and an empty cutoff (`packages/agent/src/compaction.ts:1473-1477`).

## Summarization pass

The summary prompt asks for exactly 11 sections (`packages/agent/src/compaction.ts:74-100`). The same list is data in `SUMMARY_SECTIONS`, because the prompt and the check of a reply read the same headers (`packages/agent/src/compaction.ts:102-123`). A reply missing a header gets a warning, never a failure: a renamed header still carries its section, and failing the pass would trade a paid-for summary for nothing (`packages/agent/src/compaction.ts:125-141`, `packages/coding-agent/src/compaction-wiring.ts:146-156`).

The request is cache-aligned. It uses the session's own system prompt and tool list, over the transcript as the last request sent it, so the unchanged prefix reads from the prompt cache (`packages/agent/src/compaction.ts:1259-1277`, `packages/agent/src/compaction.ts:1295-1299`). Bytes are given up only after the provider refuses the full request for size. The ladder is: the whole prefix, then the same prefix with old tool results previewed, then the oldest whole round dropped, at most three retries (`packages/agent/src/compaction.ts:1285-1291`, `packages/agent/src/compaction.ts:1379-1395`, `packages/agent/src/compaction.ts:166-169`).

The summary request carries an explicit output cap: the smaller of 20k, the summarizer model's own maximum, and the window's remaining room, with that last term floored at 1024 tokens (`packages/agent/src/compaction.ts:1300-1307`).

The retained suffix is everything from the last user message on, to a 20,000-token budget (`packages/agent/src/compaction.ts:159-160`, `packages/agent/src/compaction.ts:373-399`). Past the budget the tail is made smaller, never dropped: previews first, then the oldest texts elided front and back around a marker (`packages/agent/src/compaction.ts:401-427`, `packages/agent/src/compaction.ts:429-479`). The request itself is never elided (`packages/agent/src/compaction.ts:404-407`).

The user's own requests from the summarized part are carried verbatim beside the summary, taken newest first and kept in order, to a 20,000-token budget (`packages/agent/src/compaction.ts:164-165`, `packages/agent/src/compaction.ts:534-567`). A request that does not fit is truncated rather than dropped, and the walk stops there (`packages/agent/src/compaction.ts:561-564`).

An empty reply fails the pass (`packages/agent/src/compaction.ts:1369-1377`). The `validating` phase is announced before that check, with the size that would be kept (`packages/agent/src/compaction.ts:1370-1376`).

A cancellation is not a failure. A stream cut by the run's signal is not adopted and not recorded (`packages/agent/src/compaction.ts:1358-1368`). The failed pass does not count against the breaker when the signal is aborted (`packages/agent/src/compaction.ts:1170-1176`), and `check` answers nothing rather than reporting that the conversation no longer fits (`packages/agent/src/compaction.ts:1020-1025`).

The `<analysis>` block is stripped before the summary is stored; the boundary carries only the actionable part (`packages/agent/src/compaction.ts:1418-1422`).

## Boundary and store

The boundary is a user message that opens with `COMPACTION_BOUNDARY_LEAD` (`packages/agent/src/compaction.ts:481-493`, `packages/agent/src/compaction.ts:506-532`). The lead must stay the first line, because the rules that recognize a boundary read it there (`packages/agent/src/compaction.ts:525-526`, `packages/agent/src/compaction.ts:569-573`).

The boundary carries the summary, the retained user requests, the re-injected files, and a pointer to the session file the replaced prefix still lives in (`packages/agent/src/compaction.ts:518-532`). Up to five recently touched files are re-injected, to a 50,000-character budget (`packages/agent/src/compaction.ts:170-171`, `packages/agent/src/compaction.ts:1401-1415`). The transcript pointer is omitted when there is no store to name (`packages/agent/src/compaction.ts:527-529`, `packages/agent/src/compaction.ts:1061-1064`).

The rebuilt transcript is the boundary followed by the retained suffix (`packages/agent/src/compaction.ts:1066`). The record is written through `appendCompaction`, which verifies that the suffix is the session file's own tail (`packages/agent/src/compaction.ts:1128-1155`, `packages/agent/src/session-store.ts:411`). Synthetic tool results from the resume repair are left out of the recorded suffix, because the file never held them (`packages/agent/src/compaction.ts:1121-1128`).

A resume reads `contextMessages()`, which is the last boundary followed by everything after it (`packages/agent/src/session-store.ts:388-406`). The transcript the summary replaced stays in the file as an abandoned branch: the boundary hangs off the chain root, and the suffix is appended below it (`packages/agent/src/session-store.ts:425-439`).

The pass also records what it can verify about itself: the messages summarized and kept, the missing sections, the files fingerprinted, and whether the session file took the record (`packages/agent/src/compaction.ts:1156-1164`, `packages/agent/src/compaction.ts:645-674`).

## After a pass

A successful pass clears the consecutive-failure count, manual or automatic (`packages/agent/src/compaction.ts:1089-1093`). A manual pass also clears the rapid-refill run; an automatic pass increments it when it comes within three checks of the previous one (`packages/agent/src/compaction.ts:1094-1106`, `packages/agent/src/compaction.ts:147-158`).

`#lastPostTokens` is the size the pass left behind (`packages/agent/src/compaction.ts:766-767`, `packages/agent/src/compaction.ts:1107-1111`). The anti-thrash floor measures growth from it (`packages/agent/src/compaction.ts:882-894`). The constructor reads the same number from the last record in the store, so `/resume`, `/model`, and a restart do not pay for the same summary again (`packages/agent/src/compaction.ts:781-792`).

The breaker and the setting are different switches with different words. `isTripped` is this session's breaker; `isDisabled` is the user's setting (`packages/agent/src/compaction.ts:795-808`). The breaker trips after three consecutive failures or three compactions that each refilled within three checks (`packages/agent/src/compaction.ts:146-158`, `packages/agent/src/compaction.ts:795-797`). Each gets its own notice (`packages/agent/src/compaction.ts:1524-1539`, `packages/agent/src/compaction.ts:1246-1257`).

At `done`, each host clears its read record and re-saves the state the boundary stranded. The REPL clears at `packages/coding-agent/src/interactive.ts:994`, saves the task board at `:995`, re-anchors the plan at `:1003`, saves the policy at `:1005`, and puts the file checkpoints back at `:1006`. A `-p` run clears and saves in its own `done` handler (`packages/coding-agent/src/headless.ts:777-785`). An ACP session does the same (`packages/coding-agent/src/acp.ts:1183-1191`). `/trim` clears the read record on the same reasoning (`packages/coding-agent/src/commands.ts:301-305`).

The `/compact` command prints the headline, the receipt, and an over-limit warning (`packages/coding-agent/src/commands.ts:187-210`). The receipt is `compactionReceiptLines`: summarized and kept counts, fingerprint coverage, missing sections, and a refused record (`packages/coding-agent/src/compaction-wiring.ts:82-120`). The automatic path prints the phase line and the receipt in the REPL, and the phase line plus warnings on a `-p` stream and in ACP (`packages/coding-agent/src/interactive.ts:959-968`, `packages/coding-agent/src/compaction-wiring.ts:355-370`).

## Hard-limit rescue

A summary is real progress even when it is not enough. After the rebuild, the pass measures the rebuilt context against the hard limit again (`packages/agent/src/compaction.ts:1009-1017`, `packages/agent/src/compaction.ts:1076-1077`). When it is still over and `microcompactFirst` is set, one final `microcompact(rebuilt, 0, TRIM_PER_RESULT_BUDGET, spill)` makes every result eligible for a preview, the newest included (`packages/agent/src/compaction.ts:1067-1079`). A keep-last-N of zero is what removes the newest results' protection (`packages/agent/src/compaction.ts:1473-1477`).

The rescue is adopted only when it is strictly smaller; a rewrite that frees nothing costs the detail for no room (`packages/agent/src/compaction.ts:1081-1086`). The adopted size becomes the final `postTokens` recorded on the compaction entry and carried on the `done` phase (`packages/agent/src/compaction.ts:1107-1111`, `packages/agent/src/compaction.ts:1149`, `packages/agent/src/compaction.ts:1167`).

If the rebuilt context is still at or over the hard limit, `check` returns `blocked` with the produced context (`packages/agent/src/compaction.ts:1016-1018`). The `CompactionCheck` type carries that context (`packages/agent/src/types.ts:512-524`). `AgentSession` adopts it before it ends the run, so the next run starts from the summary rather than from the history that just failed (`packages/agent/src/session.ts:439-451`, adoption at `:448`).

`blockedMessage(context?)` adds the measured numbers when a context is given: the total against the hard limit, and the fixed-prefix diagnosis when the system prompt and tool schemas alone are over that line (`packages/agent/src/compaction.ts:1200-1218`). The fixed part is the part no summary can shrink (`packages/agent/src/compaction.ts:1206-1213`). A rapid-refill trip is named first, in its own words, because "failed N times" would misreport a working mechanism (`packages/agent/src/compaction.ts:1220-1234`). Every other refusal names the cause and the commands that exist (`packages/agent/src/compaction.ts:1235-1243`).

A manual `/compact` reads the same arithmetic from the manager and warns when the compacted context is still at or over the hard limit, pointing at `/trim` and at a larger model (`packages/coding-agent/src/commands.ts:196-210`).

A manual `/compact` is also the one pass the user can stop. The command declares `cancellable: true` and passes the host's abort signal into the manager (`packages/coding-agent/src/commands.ts:152-168`); the REPL's Esc reaches it before it reaches the session (`packages/tui/src/components/REPL.tsx:686-689`). The manager checks the signal immediately before it records the compaction (`packages/agent/src/compaction.ts:1133-1140`). An abort before that line throws `AbortError`, and the command answers `Compaction cancelled.` (`packages/coding-agent/src/commands.ts:169-175`). An abort after it has no effect: the record is already written, and the command reports the success it committed. A pass the loop starts on its own has no command signal and keeps the cancellation behavior above.

## Phase contract and hooks

A pass reports exactly one lifecycle: `preparing`, `summarizing`, `validating`, `resuming`, and then `done` or `failed` (`packages/agent/src/compaction.ts:676-709`). `summarizing` carries the attempt number and whether the request is out or the reply is arriving (`packages/agent/src/compaction.ts:697-700`). `done` carries the sizes, the trigger, and the verification (`packages/agent/src/compaction.ts:702-708`). Every pass ends in exactly one of `done` or `failed`, because a status painted while the work is in flight needs the ending as much as the start (`packages/agent/src/compaction.ts:685-689`).

`onPhase` may return a promise, and the manager awaits it at every emit (`packages/agent/src/compaction.ts:728-736`, `packages/agent/src/compaction.ts:1051-1056`). The wiring awaits the host's listener through to the manager, so a `PostCompact` hook a `-p` run fires on `done` completes before the pass returns and before the process can exit (`packages/coding-agent/src/compaction-wiring.ts:355-360`, `packages/agent/src/compaction.ts:1167`). This waiting was added in `c35f405`.

`PreCompact` may veto a pass before it starts. The wiring consults it for the automatic passes and for the forced overflow pass (`packages/coding-agent/src/compaction-wiring.ts:425-431`). A veto of an automatic pass defers it; a veto of a forced pass returns `blocked`, and the run ends (`packages/coding-agent/src/compaction-wiring.ts:430`, `packages/agent/src/session.ts:439-451`). A manual `/compact` asks the same hook directly, because it runs its summary through the manager itself (`packages/coding-agent/src/commands.ts:156-162`, `packages/coding-agent/src/compaction-wiring.ts:322-332`).

`PostCompact` is an observer. A failing hook is a line, never a veto (`packages/coding-agent/src/interactive.ts:1007-1019`, `packages/coding-agent/src/headless.ts:790-801`, `packages/coding-agent/src/acp.ts:1196-1207`). The REPL, a `-p` run, and an ACP session all run it after `done` (`packages/coding-agent/src/interactive.ts:1010-1018`, `packages/coding-agent/src/headless.ts:790-801`, `packages/coding-agent/src/acp.ts:1196-1207`).

The host hook doors are wired next to the manager. The REPL wires `PreCompact` at `packages/coding-agent/src/interactive.ts:1034-1049`, a `-p` run at `packages/coding-agent/src/headless.ts:759-769`, and an ACP session at `packages/coding-agent/src/acp.ts:1165-1177`.

## Visibility

`/context` builds rows from the manager's own limits and state (`packages/coding-agent/src/context-report.ts:122-180`, `packages/coding-agent/src/interactive.ts:4701-4729`). `Auto-compact` says `on`, `off (settings)`, or `paused after repeated failures` (`packages/coding-agent/src/context-report.ts:157-163`). `Hard limit` gives the refusal line (`packages/coding-agent/src/context-report.ts:164`). `Fixed (system + tools)` gives the part no summary can touch, and warns when that part alone is over the hard limit (`packages/coding-agent/src/context-report.ts:165-177`).

With automatic compaction off in settings, the wiring says so once when the estimate crosses the threshold (`packages/coding-agent/src/compaction-wiring.ts:32-46`, `packages/coding-agent/src/compaction-wiring.ts:461-476`). The notice is edge-triggered: one per crossing, not one per turn (`packages/coding-agent/src/compaction-wiring.ts:342-348`).

A tripped breaker is announced once per trip through the same path (`packages/coding-agent/src/compaction-wiring.ts:477-484`). The REPL also paints the pass's state in a status row, using the phase text that has a word for every step (`packages/coding-agent/src/compaction-wiring.ts:163-186`, `packages/coding-agent/src/interactive.ts:936-953`).

## Settings and commands

| Name | Effect | Source |
| --- | --- | --- |
| `compaction.model` | The model that writes summaries. Resolved once at startup; an unknown ref or a missing key warns and falls back to the session model. | `packages/coding-agent/src/settings.ts:221-222`, `packages/coding-agent/src/compaction-wiring.ts:215-252` |
| `compaction.reserveTokens` | The space the reserve arithmetic keeps free. Default 13k. | `packages/coding-agent/src/settings.ts:223-224`, `packages/agent/src/compaction.ts:145` |
| `compaction.thresholdPercent` | The trigger line as a percent of the window. Replaces the reserve arithmetic. | `packages/coding-agent/src/settings.ts:225-232`, `packages/agent/src/compaction.ts:217-221` |
| `compaction.enabled` | False stops the automatic summary and the idle trim. Manual and forced passes still run. | `packages/coding-agent/src/settings.ts:220`, `packages/coding-agent/src/compaction-wiring.ts:390` |
| `trimOldToolResults` | False turns off the cheap rung at the threshold and on idle. | `packages/coding-agent/src/settings.ts:188`, `packages/coding-agent/src/compaction-wiring.ts:261-270` |
| `/compact [focus]` | Runs a manual summary. The focus text is added to the prompt. Prints the receipt and the over-limit warning. Esc cancels it until the record is written. | `packages/coding-agent/src/commands.ts:148-212` |
| `/trim` | Runs the cheap rung on request. No model call. Clears the read record. | `packages/coding-agent/src/commands.ts:286-314` |
| `/autocompact [on\|off\|<percent>]` | Reports or changes the automatic passes and the trigger line, in the settings file and in the live manager. | `packages/coding-agent/src/interactive.ts:3957-3980`, `packages/coding-agent/src/autocompact.ts:1-14` |
| `/context` | Shows the window's parts, the auto-compact and hard limits, the fixed part, and the last compaction. | `packages/coding-agent/src/interactive.ts:4701-4729` |

## Why

- **The cancelled pass counts nothing.** Counting an Esc press would let three of them trip the breaker and switch automatic compaction off for the session. A cancel is the user's change of mind, not a verdict about the conversation (`packages/agent/src/compaction.ts:1170-1174`, `packages/agent/src/compaction.ts:1020-1025`).
- **`slice(-0)` gets its own path.** `slice(-0)` is `slice(0)`, which keeps every result. The hard-limit rescue needs zero to mean the opposite (`packages/agent/src/compaction.ts:1473-1477`).
- **A blocked check carries its context.** The summary already ran and was already recorded. Dropping its context would make the pass look like it changed nothing, and the next run would replay the history that just failed (`packages/agent/src/compaction.ts:1013-1017`, `packages/agent/src/types.ts:512-520`).
- **`thresholdPercent` is the line, not an input.** A user who names a percent named a percent. Feeding it back into the reserve formula would answer a different question (`packages/agent/src/compaction.ts:53-58`, `packages/agent/src/compaction.ts:206-215`).
- **The summary request reads the cache first.** It goes out as the session's own request; bytes are given up only after a refusal, because each rung below the raw transcript forfeits the cache (`packages/agent/src/compaction.ts:1259-1277`).
- **A spill is a convenience, never a failure.** Whatever goes wrong on the way to disk, the pass returns a result rather than an exception (`packages/agent/src/compaction.ts:1454-1459`, `packages/agent/src/compaction.ts:1488-1496`).

## Source map

| File | Role |
| --- | --- |
| `packages/agent/src/compaction.ts` | The threshold arithmetic, the cheap and idle rungs, the summary request and its ladder, the boundary and record, the breaker, and the blocked message. |
| `packages/coding-agent/src/compaction-wiring.ts` | The shared answer for every host: manager construction, phase reporting, `PreCompact`, the reduced-pass report, and the notices. |
| `packages/coding-agent/src/context-report.ts` | The `/context` rows, the compaction history, the kept-file drift, and the accuracy notice. |
| `packages/coding-agent/src/commands.ts` | `/compact` and `/trim`, their receipts, and the over-limit warning. |
| `packages/agent/src/output-limits.ts` | The spill header and writer that the cheap rung uses for full-text pointers. |
