---
name: simplify
description: Review the current diff for cleanup opportunities by fanning out parallel read-only subagents, then apply only the agreed subset. Use after a batch lands and before committing, or on any "is this clean" question about working-tree changes.
---

Review the working-tree diff (or the range in the args) for cleanup opportunities. The review is read-only; edits happen after the findings are agreed.

## Fan out three reviewers concurrently

Launch three `Task` subagents (`subagent_type: general-purpose`) in one message. Each is read-only and independent, so parallel is safe. Give each one the diff (paste it, or a `git diff` range the subagent can run itself) and one lens:

1. **Dead weight.** Exports nothing reads, code paths no trigger reaches, comments that claim behaviour the code no longer has. Each finding names the file:line and the symbol, and states how it was checked.
2. **Shape.** Near-duplicated blocks worth extracting, and any file grown past the point of review — the repo's own guidance caps a file at 250 lines of real logic; cite the line count with the finding.
3. **Comments that lie.** A comment contradicting its code is a defect, same as a wrong assertion. Quote the comment and the contradictory line together.

Each subagent reports a numbered Markdown list; every item carries an exact `path:line` and one sentence on the concrete cost.

## Merge, then ask

Merge every finding from every reviewer — do not summarize, cap, or drop any of them; renumber sequentially and group by reviewer. If a finding looks speculative, keep it and say so; the user decides what to act on.

Only after the user picks: apply the agreed subset with focused edits, then run the verification gates (tests for the touched packages, tsc, biome) and report the counts.

## Boundaries

- No refactors the user did not agree to. This skill proposes; it does not perform unrequested modernization.
- Behaviour must be identical after the change. If a finding would change behaviour, it is a bug report, not a cleanup — move it out and say so.
- Never touch a file to satisfy a formatting tool without checking the line-ending situation first (repo-wide biome is red on Windows from CRLF; only changed files are in scope).
