# Compaction

Compaction keeps a long session inside its model's context window. It has two rungs. The cheap rung replaces old tool results with previews and makes no model call. The summary rung pays for a model call and records a boundary that stands in place of the summarized prefix. The mechanism lives in `packages/agent/src/compaction.ts`, and the answer it gives is shared by the REPL, a `-p` run, and an ACP session through `packages/coding-agent/src/compaction-wiring.ts` (`packages/coding-agent/src/compaction-wiring.ts:1-16`).

## Limits and triggers

The trigger line is `contextWindow − min(maxOutputTokens, 20k) − reserve` (`packages/agent/src/compaction.ts:211-238`). The 20k cap and the 13k default reserve are constants (`packages/agent/src/compaction.ts:153-154`). `compaction.reserveTokens` replaces the default (`packages/agent/src/compaction.ts:53`, `packages/coding-agent/src/settings.ts:243`).

A small window can be smaller than the reserves, and the formula then computes a negative trigger. Below the point where the reserves fit, the rule takes 60% of the window instead (`packages/agent/src/compaction.ts:206-207`, `packages/agent/src/compaction.ts:236-237`). The result is clamped at zero and kept strictly under the hard limit (`packages/agent/src/compaction.ts:230-237`).

`compaction.thresholdPercent` is an override, not an input. When it is set, it replaces the reserve arithmetic and does not fall back to the proportional share (`packages/agent/src/compaction.ts:54-61`, `packages/agent/src/compaction.ts:220-233`). The schema accepts 1 through 99 (`packages/coding-agent/src/settings.ts:251`). The result is still clamped under the hard limit (`packages/agent/src/compaction.ts:231-233`).

The hard limit is `contextWindow − 3000` (`packages/agent/src/compaction.ts:240-242`, `packages/agent/src/compaction.ts:152`). A request past this line is not sent (`packages/agent/src/compaction.ts:1071`, `packages/agent/src/compaction.ts:1086-1088`).

`compaction.enabled: false` switches off the automatic side only. It stops the summary the threshold asks for and the idle trim (`packages/agent/src/compaction.ts:45-52`, `packages/agent/src/compaction.ts:911-917`). It does not stop a manual `/compact`, which never comes through the manager's automatic door (`packages/agent/src/compaction.ts:913-914`, `packages/coding-agent/src/commands.ts:224`). It also does not stop the forced pass after a provider refuses an over-long request; that pass sets `force`, and the switch is bypassed (`packages/agent/src/compaction.ts:917`, `packages/agent/src/compaction.ts:965-970`).

The cheap rung runs on its own at the threshold only when `microcompactFirst` is set (`packages/agent/src/compaction.ts:62-72`, `packages/agent/src/compaction.ts:920-933`). The app sets it unless `trimOldToolResults` is false (`packages/coding-agent/src/compaction-wiring.ts:438`, `packages/coding-agent/src/settings.ts:207`).

The idle rung is its own trigger. After one hour with no requests (`packages/agent/src/compaction.ts:185-193`), the old tool results become previews for free, because the provider's prompt cache has expired anyway (`packages/agent/src/compaction.ts:1008-1037`). It runs only under the hard limit and only when `microcompactFirst` is set (`packages/agent/src/compaction.ts:940-949`, `packages/agent/src/compaction.ts:1023-1028`).

Anti-thrash keeps a pass from summarizing nearly the same context twice. After a compaction, another pass on a context that grew by less than 5% of the window is turned away (`packages/agent/src/compaction.ts:208-209`, `packages/agent/src/compaction.ts:951-963`, `packages/agent/src/compaction.ts:1039-1042`).

## The cheap rung

`microcompact` replaces the oldest tool results with previews and leaves the newest three whole (`packages/agent/src/compaction.ts:181-182`, `packages/agent/src/compaction.ts:1554-1564`). Each rewritten result is cut to 2000 characters, marker included (`packages/agent/src/compaction.ts:1543-1546`, `packages/agent/src/compaction.ts:1571`). The budget bounds the preview itself, so a second pass finds nothing left to cut (`packages/agent/src/compaction.ts:1543-1546`, `packages/agent/src/compaction.ts:1574`).

With a spill writer, the full text is written to disk first (`packages/agent/src/compaction.ts:1577-1590`). The write is one call per result, and every text block of the result is joined into that one call (`packages/agent/src/compaction.ts:1577-1580`). The preview then opens with `[full output: N chars → path]` (`packages/agent/src/compaction.ts:1589`, `packages/agent/src/output-limits.ts:43-45`). The header appears once, on the first block the rewrite actually changes (`packages/agent/src/compaction.ts:1592-1600`).

A result that already opens with a spill header is never spilled a second time (`packages/agent/src/compaction.ts:1577`, `packages/agent/src/output-limits.ts:47-50`). A writer that throws or returns null degrades to the plain preview; the failure is not a failed compaction (`packages/agent/src/compaction.ts:1581-1589`). Without a writer the preview is what it always was (`packages/agent/src/compaction.ts:1575-1577`), and the full text stays in the session file, which is why a rewritten result can still match its record (`packages/agent/src/session-store.ts:97-107`).

The rung is idempotent. A second pass over the same messages finds nothing over budget, so `trim` counts zero changed results and returns null (`packages/agent/src/compaction.ts:990-1005`, `packages/agent/src/compaction.ts:1543-1546`).

The idle rung keeps the newest five whole and requires 20,000 estimated tokens of savings before it applies any of the cut (`packages/agent/src/compaction.ts:194-205`, `packages/agent/src/compaction.ts:1029-1031`). It is all-or-nothing on purpose: previews that free a rounding error of the window trade detail for nothing (`packages/agent/src/compaction.ts:200-205`).

`trim` counts the results and characters the rung changed and returns the new context with that count (`packages/agent/src/compaction.ts:990-1006`). The wiring reports the count and clears the host's read record (`packages/coding-agent/src/compaction-wiring.ts:518-525`).

`slice(-0)` is `slice(0)`, which would keep every result. The hard-limit rescue needs a keep-last-N of zero to mean "the newest results are not protected", so zero gets its own path and an empty cutoff (`packages/agent/src/compaction.ts:1566-1570`).

## The pre-expiry summary

The idle rung above assumes the cache is already gone. The REPL also runs the opposite pass: while the session's own entry is still readable, it pays cache-read prices for a summary and replaces a large prefix before the next turn pays full price for it (`packages/coding-agent/src/idle-summary.ts:1-23`). A `-p` run and an ACP session do not have it — neither has a "later" for the saving to arrive in (`packages/coding-agent/src/interactive.ts:2853-2862`).

The clock is the provider's, not a fixed hour. `effectiveCacheTtl` resolves the tier in force after any downgrade notice, and answers `undefined` for a provider whose cache is automatic and whose lifetime it does not report (`packages/ai/src/cache.ts:228-259`). `cacheFamilyState` reads the family this exact model-and-prefix shape files under, takes the lifetime from the newest record that reported a write bucket, and falls back to that resolved tier when none did (`packages/ai/src/cache-tracker.ts:170-222`). The pass is armed on a 30,000 ms tick and fires inside a lead of 120,000 ms before the entry expires (`packages/coding-agent/src/idle-summary.ts:44-55`). Outside that window — earlier, or after the entry is gone — it does nothing; the free trim owns the cold side (`packages/coding-agent/src/idle-summary.ts:130-139`).

The request has to read the same cache. When the summarizer's `prefixIdentity` differs from the session model's, the summary pays full price for a prefix nobody warmed, so the pass is not offered at all (`packages/coding-agent/src/idle-summary.ts:126-128`). The size gate is the manager's `idleSummaryWorthwhile`: the floor is the threshold, capped at 200,000 tokens so a million-token window still gets the pass (`packages/agent/src/compaction.ts:229-232`, `packages/agent/src/compaction.ts:930-958`). It obeys `compaction.enabled: false` and its own `compaction.idleSummary: false`, and it stands down on a tripped breaker and on a context the anti-thrash floor would refuse anyway (`packages/agent/src/compaction.ts:946-956`, `packages/coding-agent/src/settings.ts:240-252`).

The pass is the same manager door as `/compact`, with trigger `idle` (`packages/agent/src/session-store.ts:67`). That trigger is what makes it a different event: it clears the rapid-refill run instead of counting one, because the pass was bought to make the next request cheap, not to answer a threshold the last summary missed (`packages/agent/src/compaction.ts:1240-1246`). Its `done` phase is reported in the REPL as "Context compacted while idle", and its `failed` phase is not shown at all — nobody was waiting for it (`packages/coding-agent/src/compaction-wiring.ts:86-91`, `packages/coding-agent/src/interactive.ts:1018-1031`).

A turn takes precedence. The pass never starts while `AgentSession.isRunning`, aborts its request when a turn starts, and does not adopt a summary that finished after a turn had already admitted a new message; the session file keeps the record, so memory catches up on resume (`packages/coding-agent/src/idle-summary.ts:143-171`, `packages/coding-agent/src/interactive.ts:1923-1928`). Before the pass, the `PreCompact` hook is asked with the same payload as the automatic side, so quiet hours are not a way around a deferral (`packages/coding-agent/src/idle-summary.ts:142-147`, `packages/coding-agent/src/interactive.ts:2881`). The summary's own request counts as activity: `noteRequest` restarts the idle clock, so the next turn does not hand the free trim the prefix this pass just warmed (`packages/coding-agent/src/idle-summary.ts:150-155`, `packages/coding-agent/src/compaction-wiring.ts:376-385`).

## Summarization pass

The summary prompt asks for exactly 11 sections (`packages/agent/src/compaction.ts:83-109`). The same list is data in `SUMMARY_SECTIONS`, because the prompt and the check of a reply read the same headers (`packages/agent/src/compaction.ts:111-132`). A reply missing a header gets a warning, never a failure: a renamed header still carries its section, and failing the pass would trade a paid-for summary for nothing (`packages/agent/src/compaction.ts:134-150`, `packages/coding-agent/src/compaction-wiring.ts:157-167`).

The request is cache-aligned. It uses the session's own system prompt and tool list, over the transcript as the last request sent it, so the unchanged prefix reads from the prompt cache (`packages/agent/src/compaction.ts:1340-1358`, `packages/agent/src/compaction.ts:1376-1380`). Bytes are given up only after the provider refuses the full request for size. The ladder is: the whole prefix, then the same prefix with old tool results previewed, then the oldest whole round dropped, at most three retries (`packages/agent/src/compaction.ts:1366-1372`, `packages/agent/src/compaction.ts:1474-1487`, `packages/agent/src/compaction.ts:177-178`).

The summary request carries an explicit output cap: the smaller of 20k, the summarizer model's own maximum, and the window's remaining room, with that last term floored at 1024 tokens (`packages/agent/src/compaction.ts:1381-1388`).

The retained suffix is everything from the last user message on, to a 20,000-token budget (`packages/agent/src/compaction.ts:168-169`, `packages/agent/src/compaction.ts:397-423`). Past the budget the tail is made smaller, never dropped: previews first, then the oldest texts elided front and back around a marker (`packages/agent/src/compaction.ts:425-451`, `packages/agent/src/compaction.ts:453-503`). The request itself is never elided (`packages/agent/src/compaction.ts:439-442`).

The user's own requests from the summarized part are carried verbatim beside the summary, taken newest first and kept in order, to a 20,000-token budget (`packages/agent/src/compaction.ts:173-174`, `packages/agent/src/compaction.ts:573-597`). A request that does not fit is truncated rather than dropped, and the walk stops there (`packages/agent/src/compaction.ts:591-594`).

An empty reply fails the pass (`packages/agent/src/compaction.ts:1463-1471`). The `validating` phase is announced before that check, with the size that would be kept (`packages/agent/src/compaction.ts:1464-1470`).

A cancellation is not a failure. A stream cut by the run's signal is not adopted and not recorded (`packages/agent/src/compaction.ts:1451-1461`). The failed pass does not count against the breaker when the signal is aborted (`packages/agent/src/compaction.ts:1251-1254`), and `check` answers nothing rather than reporting that the conversation no longer fits (`packages/agent/src/compaction.ts:1090-1095`).

The `<analysis>` block is stripped before the summary is stored; the boundary carries only the actionable part (`packages/agent/src/compaction.ts:1511-1515`).

Every attempt that came back with billed usage is booked into whatever ledger bills the session (`packages/agent/src/compaction.ts:1447-1450`). The summary's message never enters the transcript, so a host that costs the conversation from its messages alone would leave unpaid the most expensive request a session sends; the booking is also the only record of an attempt whose summary was thrown away. It comes before the ending is decided, because a refusal for size, an empty reply and a cancel each paid for the request that produced them, and the smaller request that replaces a refusal is billed as its own attempt. The entry names the model that actually answered, taken from the terminal event rather than the summarizer that was asked, because a fallback chain may have answered instead (`packages/agent/src/compaction.ts:1420-1430`). The wiring hands the booking to the host as `onSummaryUsage` (`packages/coding-agent/src/compaction-wiring.ts:331-340`, `packages/coding-agent/src/compaction-wiring.ts:460`); the REPL books it into the session ledger every other call uses (`packages/coding-agent/src/interactive.ts:1096-1105`), a `-p` run adds it to the `cost_usd` it reports and to the stream-json `usage` total (`packages/coding-agent/src/headless.ts:737-741`, `packages/coding-agent/src/headless.ts:980-988`, `packages/coding-agent/src/headless.ts:1268`), an ACP session adds it to the spend its budget gate reads (`packages/coding-agent/src/acp.ts:1235`, `packages/coding-agent/src/acp.ts:1374-1382`), and a subagent books it on the seat the run answers on (`packages/coding-agent/src/subagents.ts:695-700`). A beetle member books it too, into a per-member accumulator that outlives the task sessions it was spent across (`packages/coding-agent/src/beetle.ts:553-568`, `packages/coding-agent/src/beetle.ts:1180-1185`).

Every assistant turn a successful summary replaces is booked through `onDroppedUsage` (`packages/agent/src/compaction.ts:802-816`, `packages/agent/src/compaction.ts:1238-1247`). The swap keeps the boundary and the retained suffix and drops the prefix; the usage those turns recorded was paid for when they were admitted, and a host that costs a resumed conversation from its messages alone would report the transcript it inherited as free. The callback fires once per replaced message that billed something, after the record is written and before the caller adopts the rebuilt context: a failed, cancelled, or empty pass replaces nothing and books nothing, and a message retained in the suffix is left to the transcript's own re-cost. The wiring hands it through unchanged (`packages/coding-agent/src/compaction-wiring.ts:341-348`, `packages/coding-agent/src/compaction-wiring.ts:461`). Headless adds the accumulator to `cost_usd` and to the stream-json `usage` total (`packages/coding-agent/src/headless.ts:746`, `packages/coding-agent/src/headless.ts:985-989`, `packages/coding-agent/src/headless.ts:1269`), the ACP budget gate adds it to the spend it reads (`packages/coding-agent/src/acp.ts:1240`, `packages/coding-agent/src/acp.ts:1374-1382`), and a beetle member's tally adds it beside the summary (`packages/coding-agent/src/beetle.ts:553-568`, `packages/coding-agent/src/beetle.ts:931`). The REPL and subagents do not receive it: both book every `turn_end` as it happens, and booking a replaced turn again at the swap would count it twice.

## Boundary and store

The boundary is a user message that opens with `COMPACTION_BOUNDARY_LEAD` (`packages/agent/src/compaction.ts:505-517`, `packages/agent/src/compaction.ts:530-556`). The lead must stay the first line, because the rules that recognize a boundary read it there (`packages/agent/src/compaction.ts:549-550`, `packages/agent/src/compaction.ts:599-603`).

The boundary carries the summary, the retained user requests, the re-injected files, and a pointer to the session file the replaced prefix still lives in (`packages/agent/src/compaction.ts:542-556`). Up to five recently touched files are re-injected, to a 50,000-character budget (`packages/agent/src/compaction.ts:179-180`, `packages/agent/src/compaction.ts:1494-1508`). The transcript pointer is omitted when there is no store to name (`packages/agent/src/compaction.ts:551-553`, `packages/agent/src/compaction.ts:1131-1134`).

The rebuilt transcript is the boundary followed by the retained suffix (`packages/agent/src/compaction.ts:1136`). The record is written through `appendCompaction`, which verifies that the suffix is the session file's own tail (`packages/agent/src/compaction.ts:1198-1225`, `packages/agent/src/session-store.ts:581`). Synthetic tool results from the resume repair are left out of the recorded suffix, because the file never held them (`packages/agent/src/compaction.ts:1191-1198`).

A resume reads `contextMessages()`, which is the last boundary followed by everything after it (`packages/agent/src/session-store.ts:559-577`). The transcript the summary replaced stays in the file as an abandoned branch: the boundary hangs off the chain root, and the suffix is appended below it (`packages/agent/src/session-store.ts:597-624`).

The pass also records what it can verify about itself: the messages summarized and kept, the missing sections, the files fingerprinted, and whether the session file took the record (`packages/agent/src/compaction.ts:1226-1234`, `packages/agent/src/compaction.ts:675-704`).

## After a pass

A successful pass clears the consecutive-failure count, manual or automatic (`packages/agent/src/compaction.ts:1159-1163`). A manual pass also clears the rapid-refill run; an automatic pass increments it when it comes within three checks of the previous one (`packages/agent/src/compaction.ts:1164-1176`, `packages/agent/src/compaction.ts:156-167`).

`#lastPostTokens` is the size the pass left behind (`packages/agent/src/compaction.ts:835-836`, `packages/agent/src/compaction.ts:1177-1181`). The anti-thrash floor measures growth from it (`packages/agent/src/compaction.ts:951-963`). The constructor reads the same number from the last record in the store, so `/resume`, `/model`, and a restart do not pay for the same summary again (`packages/agent/src/compaction.ts:850-861`).

The breaker and the setting are different switches with different words. `isTripped` is this session's breaker; `isDisabled` is the user's setting (`packages/agent/src/compaction.ts:864-877`). The breaker trips after three consecutive failures or three compactions that each refilled within three checks (`packages/agent/src/compaction.ts:155-167`, `packages/agent/src/compaction.ts:864-866`). Each gets its own notice (`packages/agent/src/compaction.ts:1617-1632`, `packages/agent/src/compaction.ts:1327-1338`).

At `done`, each host clears its read record and re-saves the state the boundary stranded. The REPL clears at `packages/coding-agent/src/interactive.ts:1056`, saves the task board at `:1057`, re-anchors the plan at `:1065`, saves the policy at `:1067`, and puts the file checkpoints back at `:1068`. A `-p` run clears and saves in its own `done` handler (`packages/coding-agent/src/headless.ts:923-931`). An ACP session does the same (`packages/coding-agent/src/acp.ts:1291-1299`). `/trim` clears the read record on the same reasoning (`packages/coding-agent/src/commands.ts:359-361`).

The `/compact` command prints the headline, the receipt, and an over-limit warning (`packages/coding-agent/src/commands.ts:243-266`). The receipt is `compactionReceiptLines`: summarized and kept counts, fingerprint coverage, missing sections, and a refused record (`packages/coding-agent/src/compaction-wiring.ts:106-131`). The automatic path prints the phase line and the receipt in the REPL, and the phase line plus warnings on a `-p` stream and in ACP (`packages/coding-agent/src/interactive.ts:1021-1030`, `packages/coding-agent/src/compaction-wiring.ts:406-421`).

## Hard-limit rescue

A summary is real progress even when it is not enough. After the rebuild, the pass measures the rebuilt context against the hard limit again (`packages/agent/src/compaction.ts:1146-1148`, `packages/agent/src/compaction.ts:1086-1087`). When it is still over and `microcompactFirst` is set, one final `microcompact(rebuilt, 0, TRIM_PER_RESULT_BUDGET, spill)` makes every result eligible for a preview, the newest included (`packages/agent/src/compaction.ts:1148-1157`). A keep-last-N of zero is what removes the newest results' protection (`packages/agent/src/compaction.ts:1566-1570`).

The rescue is adopted only when it is strictly smaller; a rewrite that frees nothing costs the detail for no room (`packages/agent/src/compaction.ts:1151-1156`). The adopted size becomes the final `postTokens` recorded on the compaction entry and carried on the `done` phase (`packages/agent/src/compaction.ts:1177-1181`, `packages/agent/src/compaction.ts:1219`, `packages/agent/src/compaction.ts:1237`).

If the rebuilt context is still at or over the hard limit, `check` returns `blocked` with the produced context (`packages/agent/src/compaction.ts:1086-1088`). The `CompactionCheck` type carries that context (`packages/agent/src/types.ts:532-535`). `AgentSession` adopts it before it ends the run, so the next run starts from the summary rather than from the history that just failed (`packages/agent/src/session.ts:507-519`, adoption at `:516`).

`blockedMessage(context?)` adds the measured numbers when a context is given: the total against the hard limit, and the fixed-prefix diagnosis when the system prompt and tool schemas alone are over that line (`packages/agent/src/compaction.ts:1280-1300`). The fixed part is the part no summary can shrink (`packages/agent/src/compaction.ts:1288-1295`). A rapid-refill trip is named first, in its own words, because "failed N times" would misreport a working mechanism (`packages/agent/src/compaction.ts:1301-1315`). Every other refusal names the cause and the commands that exist (`packages/agent/src/compaction.ts:1316-1324`).

A manual `/compact` reads the same arithmetic from the manager and warns when the compacted context is still at or over the hard limit, pointing at `/trim` and at a larger model (`packages/coding-agent/src/commands.ts:252-266`).

A manual `/compact` is also the one pass the user can stop. The command declares `cancellable: true` and passes the host's abort signal into the manager (`packages/coding-agent/src/commands.ts:208-224`); the REPL's Esc reaches it before it reaches the session (`packages/tui/src/components/REPL.tsx:999-1002`). The manager checks the signal immediately before it records the compaction (`packages/agent/src/compaction.ts:1205-1209`). An abort before that line throws `AbortError`, and the command answers `Compaction cancelled.` (`packages/coding-agent/src/commands.ts:225-232`). An abort after it has no effect: the record is already written, and the command reports the success it committed. A pass the loop starts on its own has no command signal and keeps the cancellation behavior above.

## Phase contract and hooks

A pass reports exactly one lifecycle: `preparing`, `summarizing`, `validating`, `resuming`, and then `done` or `failed` (`packages/agent/src/compaction.ts:706-739`). `summarizing` carries the attempt number and whether the request is out or the reply is arriving (`packages/agent/src/compaction.ts:729`). `done` carries the sizes, the trigger, and the verification (`packages/agent/src/compaction.ts:732-738`). Every pass ends in exactly one of `done` or `failed`, because a status painted while the work is in flight needs the ending as much as the start (`packages/agent/src/compaction.ts:717-719`).

`onPhase` may return a promise, and the manager awaits it at every emit (`packages/agent/src/compaction.ts:769-777`, `packages/agent/src/compaction.ts:1121-1126`). The wiring awaits the host's listener through to the manager, so a `PostCompact` hook a `-p` run fires on `done` completes before the pass returns and before the process can exit (`packages/coding-agent/src/compaction-wiring.ts:406-410`, `packages/agent/src/compaction.ts:1237`). This waiting was added in `c35f405`.

`PreCompact` may veto a pass before it starts. The wiring consults it for the automatic passes and for the forced overflow pass (`packages/coding-agent/src/compaction-wiring.ts:500-505`), and the REPL's idle summary asks the same door with the `idle` trigger (`packages/coding-agent/src/interactive.ts:2881`). A veto of an automatic pass defers it; a veto of a forced pass returns `blocked`, and the run ends (`packages/coding-agent/src/compaction-wiring.ts:504`, `packages/agent/src/session.ts:507-519`). A manual `/compact` asks the same hook directly, because it runs its summary through the manager itself (`packages/coding-agent/src/commands.ts:212-218`, `packages/coding-agent/src/compaction-wiring.ts:357-366`).

`PostCompact` is an observer. A failing hook is a line, never a veto (`packages/coding-agent/src/interactive.ts:1069-1081`, `packages/coding-agent/src/headless.ts:936-947`, `packages/coding-agent/src/acp.ts:1304-1315`). The REPL, a `-p` run, and an ACP session all run it after `done` (`packages/coding-agent/src/interactive.ts:1072-1080`, `packages/coding-agent/src/headless.ts:936-947`, `packages/coding-agent/src/acp.ts:1304-1315`).

The host hook doors are wired next to the manager. The REPL wires `PreCompact` at `packages/coding-agent/src/interactive.ts:1106-1121`, a `-p` run at `packages/coding-agent/src/headless.ts:904-916`, and an ACP session at `packages/coding-agent/src/acp.ts:1273-1285`.

## Visibility

`/context` builds rows from the manager's own limits and state (`packages/coding-agent/src/context-report.ts:122-180`, `packages/coding-agent/src/interactive.ts:5104-5132`). `Auto-compact` says `on`, `off (settings)`, or `paused after repeated failures` (`packages/coding-agent/src/context-report.ts:157-163`). `Hard limit` gives the refusal line (`packages/coding-agent/src/context-report.ts:164`). `Fixed (system + tools)` gives the part no summary can touch, and warns when that part alone is over the hard limit (`packages/coding-agent/src/context-report.ts:165-177`).

With automatic compaction off in settings, the wiring says so once when the estimate crosses the threshold (`packages/coding-agent/src/compaction-wiring.ts:43-57`, `packages/coding-agent/src/compaction-wiring.ts:526-541`). The notice is edge-triggered: one per crossing, not one per turn (`packages/coding-agent/src/compaction-wiring.ts:393-399`).

A tripped breaker is announced once per trip through the same path (`packages/coding-agent/src/compaction-wiring.ts:542-549`). The REPL also paints the pass's state in a status row, using the phase text that has a word for every step (`packages/coding-agent/src/compaction-wiring.ts:174-197`, `packages/coding-agent/src/interactive.ts:998-1015`).

## Settings and commands

| Name | Effect | Source |
| --- | --- | --- |
| `compaction.model` | The model that writes summaries. Resolved once at startup; an unknown ref or a missing key warns and falls back to the session model. | `packages/coding-agent/src/settings.ts:240-241`, `packages/coding-agent/src/compaction-wiring.ts:226-263` |
| `compaction.reserveTokens` | The space the reserve arithmetic keeps free. Default 13k. | `packages/coding-agent/src/settings.ts:242-243`, `packages/agent/src/compaction.ts:154` |
| `compaction.thresholdPercent` | The trigger line as a percent of the window. Replaces the reserve arithmetic. | `packages/coding-agent/src/settings.ts:244-251`, `packages/agent/src/compaction.ts:220-223` |
| `compaction.enabled` | False stops the automatic summary, the idle trim, and the pre-expiry summary. Manual and forced passes still run. | `packages/coding-agent/src/settings.ts:239`, `packages/coding-agent/src/compaction-wiring.ts:460` |
| `compaction.idleSummary` | False stops only the pre-expiry summary. On by default; it obeys `compaction.enabled` too. | `packages/coding-agent/src/settings.ts:240-252`, `packages/agent/src/compaction.ts:946` |
| `trimOldToolResults` | False turns off the cheap rung at the threshold and on idle. | `packages/coding-agent/src/settings.ts:207`, `packages/coding-agent/src/compaction-wiring.ts:272-281` |
| `/compact [focus]` | Runs a manual summary. The focus text is added to the prompt. Prints the receipt and the over-limit warning. Esc cancels it until the record is written. | `packages/coding-agent/src/commands.ts:204-268` |
| `/trim` | Runs the cheap rung on request. No model call. Clears the read record. | `packages/coding-agent/src/commands.ts:341-371` |
| `/autocompact [on\|off\|<percent>]` | Reports or changes the automatic passes and the trigger line, in the settings file and in the live manager. | `packages/coding-agent/src/interactive.ts:4349-4372`, `packages/coding-agent/src/autocompact.ts:1-14` |
| `/context` | Shows the window's parts, the auto-compact and hard limits, the fixed part, and the last compaction. | `packages/coding-agent/src/interactive.ts:5104-5132` |

## Why

- **The cancelled pass counts nothing.** Counting an Esc press would let three of them trip the breaker and switch automatic compaction off for the session. A cancel is the user's change of mind, not a verdict about the conversation (`packages/agent/src/compaction.ts:1250-1254`, `packages/agent/src/compaction.ts:1090-1095`).
- **`slice(-0)` gets its own path.** `slice(-0)` is `slice(0)`, which keeps every result. The hard-limit rescue needs zero to mean the opposite (`packages/agent/src/compaction.ts:1566-1570`).
- **A blocked check carries its context.** The summary already ran and was already recorded. Dropping its context would make the pass look like it changed nothing, and the next run would replay the history that just failed (`packages/agent/src/compaction.ts:1086-1088`, `packages/agent/src/types.ts:532-535`).
- **`thresholdPercent` is the line, not an input.** A user who names a percent named a percent. Feeding it back into the reserve formula would answer a different question (`packages/agent/src/compaction.ts:55-60`, `packages/agent/src/compaction.ts:220-233`).
- **The summary request reads the cache first.** It goes out as the session's own request; bytes are given up only after a refusal, because each rung below the raw transcript forfeits the cache (`packages/agent/src/compaction.ts:1340-1358`).
- **A spill is a convenience, never a failure.** Whatever goes wrong on the way to disk, the pass returns a result rather than an exception (`packages/agent/src/compaction.ts:1583-1588`, `packages/agent/src/compaction.ts:1581-1589`).

## Source map

| File | Role |
| --- | --- |
| `packages/agent/src/compaction.ts` | The threshold arithmetic, the cheap and idle rungs, the summary request and its ladder, its per-attempt usage booking, the boundary and record, the breaker, and the blocked message. |
| `packages/coding-agent/src/compaction-wiring.ts` | The shared answer for every host: manager construction, phase reporting, `PreCompact`, the reduced-pass report, the summary booking, and the notices. |
| `packages/coding-agent/src/idle-summary.ts` | The REPL's pre-expiry summary: the clock read, the cache/identity/size gates, the abort, and the `idle` trigger. |
| `packages/coding-agent/src/context-report.ts` | The `/context` rows, the compaction history, the kept-file drift, and the accuracy notice. |
| `packages/coding-agent/src/commands.ts` | `/compact` and `/trim`, their receipts, and the over-limit warning. |
| `packages/agent/src/output-limits.ts` | The spill header and writer that the cheap rung uses for full-text pointers. |
