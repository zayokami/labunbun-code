# The findings ledger

## Why a live list

An investigation accumulates facts faster than a report can be written, and the expensive mistakes all come from a stale or partial picture: a question silently dropped, a run repeated that was already done, an early inference outliving the observation that later contradicted it. One list, updated continuously, prevents all three. Start it as soon as the target and the question are fixed, not when the report is due.

Keep it wherever a note survives the session — a small markdown file in the working directory is the reliable option; a session task list works if it actually persists. It needs no ceremony; it needs to be the single place the state of the investigation lives.

## Shape

A row per question:

| # | Question | Status | Evidence | To close |
|---|----------|--------|----------|----------|
| 0 | Target identity | — | path, size, digest | — |
| 1 | Does the updater contact a server on first launch? | partial | requests recorded in capture A (host confirmed); auth exchange not captured | an active session while the network channel records |
| 2 | Is the stored config JSON or binary? | answered | parser output: JSON with a binary trailing table | — |
| 3 | Which crypto implementation is linked in? | open | not examined yet | symbol listing of the main module |

Status vocabulary, kept small on purpose:

- answered — the evidence behind the row would convince a skeptic who reads it.
- partial — some sub-questions are settled; name the part that is not.
- open — not established; the "To close" column says what would establish it.

Row 0 is the anchor: the target's identity sits at the top so every other row inherits it. When the ledger covers two artifacts (a comparison), give each its own identity row and keep their evidence columns separate.

## Updating discipline

- Correct entries in place. Two lines stating different answers to the same question is how a ledger turns into a trap. When new evidence downgrades an earlier grade, rewrite the row; note the change only where a reader could otherwise be misled by the old version.
- Anything that took real work to establish earns a row, including negative results with their boundary: "searched the strings of module A for the host name; no match; scope was module A only".
- Before rerunning a step, check whether its result is already a row. Rereading a recorded result is cheap; repeating a run of the target may not be, and firing an identical failed action again is a loop, not a method.
- A blocked step is a row, not a dead end: status open, "To close" naming the missing authority or environment.

## Write-up discipline

The report is the ledger, translated for someone who did not watch the investigation.

- Every headline sentence inherits the grade of its weakest input. A number computed from an inference is an inference; a conclusion assembled from observations plus one assumption is an assumption. Hedge where the chain is weak, and hedge with precise words — "consistent with", "in one recorded run", "not examined" — rather than vague softening.
- Numbers come from measurements that actually happened. Do not round an estimate up into a fact, and do not carry a number over from a different scope — a different version, a different run — without saying so.
- Say what did not run in the same breath as what it would have supported. An untested claim and a tested claim read identically unless the report distinguishes them.
- Separate what the artifact does from what you would do in its place. Design commentary is welcome and should be visibly separate from findings.

## Closing checklist

1. Re-read the user's original words and make sure every question they imply is a row.
2. Grade each row honestly: answered rows cite their evidence; partial rows name the missing part; open rows say what would close them.
3. Bounded searches stay described as bounded. "No occurrences in the examined files" is a finding; "no occurrences" is a claim the coverage does not support.
4. Do not talk the gaps away: if the honest headline is "established X and Y; Z remains open pending authority A", write that. A summary that reads as complete while a required question is open is the failure this skill exists to stop.
