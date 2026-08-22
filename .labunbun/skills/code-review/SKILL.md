---
name: code-review
description: Orchestrate a thorough code review by fanning out one subagent per code-review-* leaf skill, then merge every finding into a single numbered report.
---

Review the current changes (the working tree diff, or a range given in the invocation args) by delegating to focused leaf skills instead of reviewing everything in one pass.

## Steps

1. List every skill directory under `.labunbun/skills/` whose name starts with `code-review-` (excluding this orchestrator itself). Note each one's `SKILL.md` path.
2. For each leaf skill, launch one `Task` subagent (`subagent_type: general-purpose`). Give it in the prompt:
   - The full path to that skill's `SKILL.md`, with an instruction to `Read` it first and follow it exactly.
   - The diff or file list under review — paste it, or point at a path/range; the subagent has Bash and can run its own `git diff` if none is given.
   - An instruction to report findings as a numbered Markdown list, each with an exact `file:line` and one sentence on the concrete failure it causes.
3. Launch the subagents concurrently — each is read-only and independent of the others, so parallel `Task` calls are safe.
4. Collect every finding from every subagent. Do not summarize, cap, or drop any of them — merge them into one report, renumbered sequentially and grouped by which leaf skill raised them.
5. If a finding looks weak or speculative, keep it but say so in the merged report instead of silently dropping it — the user decides what to act on, not the orchestrator.

## Output

Raw Markdown, findings numbered for reference, each with a `path:line`. Don't post the review anywhere (no GitHub/GitLab comments) unless the user explicitly asked for that in this turn.
