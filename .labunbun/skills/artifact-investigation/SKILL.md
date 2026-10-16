---
name: artifact-investigation
description: Use when investigating a binary, package, bundle, or app: classify each conclusion as observed, inferred, or unknown. A working discipline for verdicts about artifacts you cannot fully execute or rebuild — evidence labels, content identity, coverage accounting, a findings ledger, authorization limits, and claims that never outrun what was done.
---

# Investigating an artifact you cannot fully run

This skill exists to prevent one failure: a polished report whose confidence came from fluent writing rather than from evidence. When the subject is a compiled binary, a packaged or minified application, a recorded capture, or a third-party tool you were not given sources for, no investigation sees everything. The honest deliverable is the part that was established — with its grade — plus the part that remains open. Not a report that rounds the second half away.

Six standing rules, then the work order. The references carry the detail; read the one that matches the stage you are in.

## 1. Every conclusion carries its class: observed, inferred, unknown

- **Observed** — read from output you actually hold: a hash you computed, a string in a listing, a manifest field, a recorded request. Point at the concrete thing; a paraphrase is not an observation.
- **Inferred** — reasoning built on observations. Name the observations it rests on, and keep the chain short enough to audit.
- **Unknown** — not established. Record what would settle it (which artifact, which capture, which authority), not just that it is open.

The drift to guard against is not lying; it is an inference that loses its qualifier on restatement. Ten paragraphs later, "likely validates the license" has become "validates the license", and the reader grades it as seen. Re-read the write-up specifically for these: every sentence should still carry the label its origin earned.

## 2. Compare by content, never by position

Two files are the same artifact when their bytes agree — establish it with a digest, not with names, sizes, folders, or timestamps. Listing order, ordinal positions, and build times are not identity: copies bump timestamps, rebuilds shuffle order, and two different builds share a name. When identity cannot be established, it stays unknown — do not let a path stand in for a digest, and do not read meaning into two records lining up in a list.

## 3. What was not examined is unknown, not clean

A search covers what it searched. A miss inside a partial pass says nothing about the parts that were skipped, truncated, or paged out; absence claims need coverage of the whole relevant surface — and for a comparison, of both sides. When a search has to stop early, report the boundary it stopped at instead of the conclusion you wanted from it.

## 4. Keep a findings ledger

Maintain one live list: every question this investigation is answering, its status (answered / partial / open), the evidence behind it, and what would close an open one. Correct entries in place as evidence lands, so two contradictory lines never coexist. The ledger doubles as anti-repeat bookkeeping — check it before rerunning anything, and reuse what is already gathered. Before the report, walk it end to end; "partial" stays partial.

## 5. Check two different gates: entitlement, then authority

Entitlement is about the target — only examine artifacts the user owns or is authorized to analyze. Authority is about the action — reading a listing, unpacking a copy, or examining an old capture is not the same permission as launching the program, attaching to something live, or sending it traffic. Each step up that ladder is a fresh question. Being able to do a thing is not being allowed to do it: a readability check, an open port, or a passing configuration probe is not the permission itself. When a step is blocked, the fix is to report the blocked step and the authority it needs — not to widen the investigation or weaken a safeguard; see `references/authorization-and-blockers.md`.

## 6. Claim only what was done

The write-up describes the run that happened — not the tools' feature lists, not what a category of artifact usually means. If a step was skipped, a scope was partial, or a check never ran, that belongs in the report as a sentence. Keep wording on the narrow side of the evidence: "the listing contains these symbols" over "the program supports these features"; "consistent with" over "does". A description you have not exercised is a claim, not an observation — when the behavior you ran disagrees with the behavior that was advertised, the run wins, and the disagreement is itself worth a line.

## Work order

1. Fix the target and the question before touching anything. Turn the user's words into one concrete artifact and record its identity — path plus digest. If several artifacts could be meant, ask; do not pick a candidate for the user.
2. Start from the smallest useful overview — an inventory, a manifest, a summary — and let the question choose the follow-ups. Do not haul a whole artifact into context to answer one question, and do not rerun a step whose result is already in hand.
3. One question at a time, with the evidence type the claim requires: behavior claims need runtime observation, sameness and change claims need comparisons with complete coverage, structure claims can rest on static reads. A follow-up is worth it only when a specific open question is on the other end of it.
4. When fanning out to subagents, give each one a distinct question, tell it which evidence already exists so it does not redo it, and require back three things: the sources it read, its conclusions, and the gaps it could not close.
5. Log as you go (rule 4), not at the end. Close by grading every original question, then write the report in plain language with the ledger attached.

## References

- `references/evidence-ledger.md` — the ledger's shape, label discipline at write-up time, and the closing checklist. Read it before writing any final report.
- `references/identity-and-coverage.md` — content identity in practice, comparison rules for versions, and coverage accounting, including the three different results: not examined, examined with nothing found, examined with a contradiction.
- `references/runtime-observation.md` — what a captured run can and cannot establish, passive versus active observation, and pairing static with runtime evidence without sliding into causality.
- `references/authorization-and-blockers.md` — the authority ladder, handling a blocked step, and keeping sensitive material out of the ledger and report.
