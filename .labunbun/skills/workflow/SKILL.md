---
name: workflow
description: Write and run a Workflow script that orchestrates subagents — fan-out, staged pipelines, adversarial verification — with resume and worktree isolation.
---

# Workflows

Use the `Workflow` tool when the task has a shape worth encoding: many independent items, several verification passes, or stages that can overlap. One self-contained question is a `Task` call; a workflow is for control flow the model would otherwise have to remember and repeat.

## Calling it

- Inline: `Workflow({script: "..."})`.
- Saved: `Workflow({name: "review-changes", args: {...}})`. Saved scripts live in `~/.labunbun/workflows/<name>.js` and, once the checkout is trusted, `.labunbun/workflows/<name>.js`. The file name is the workflow name.
- Resume: `Workflow({resume_from: "<run id>"})`. Every call that succeeded is replayed from the journal instead of spawned again. A changed script can be passed alongside the run id; the cache survives up to the first changed call.

Every result ends with a `[workflow run: …]` line. Keep it: it is the only handle resume takes.

## The script

Plain JavaScript, not TypeScript — no type annotations, interfaces or generics. The body runs inside an async function, so `await` works at the top level and `return` is the workflow's result (JSON-serializable).

```js
export const meta = {
  name: 'review-changes',              // must match the file name when saved
  description: 'Review the diff across dimensions, then verify each finding',
  whenToUse: 'When the user asks for a thorough review',
};
```

`export const meta` is the only export allowed. It must be a pure object literal — no variables, calls, spreads or template interpolation.

### Hooks

- `agent(prompt, options?)` — one subagent.
  - Without `schema`: resolves to the final text.
  - With `schema`: resolves to the validated object. The root must be `{type: "object", ...}`, and every name in `required` must be declared in `properties`. One malformed answer gets one retry with the validator's complaints; after that the call fails.
  - A failed, aborted or skipped call resolves to `null`. It never rejects, so `.filter(Boolean)` before using results.
  - `options`: `label`, `phase`, `schema`, `model` (a model reference), `effort` (`off`…`max`), `agentType`, `isolation: "worktree"`.
- `parallel(thunks)` — a barrier: runs every thunk, waits for all, failures become `null`.
- `pipeline(items, ...stages)` — no barrier between stages. Each stage is `(previous, originalItem, index)`. Item A can be in stage 3 while item B is still in stage 1. A throwing stage drops that item to `null` and skips its remaining stages.
- `phase(title)` — start a progress group. Inside concurrent stages pass `phase` in the agent options instead; the implicit current phase is shared mutable state.
- `log(message)` — one progress line.
- `args` — the call's `args` value.
- `budget` — `{total, spent(), remaining()}`. No token target is wired in this build: `total` is `null` and `remaining()` is `Infinity`, so guard a budget loop on `budget.total`.

### Limits and rules

- 1000 agent calls per run; 4096 items per `parallel()`/`pipeline()` call (more is an error, not a truncation).
- At most `min(16, cpus - 2)` agent calls run at once; the cap is shared by every nested `parallel`/`pipeline`.
- `Date.now()`, `new Date()` and `Math.random()` throw: they would make a resumed run differ from the original. Pass timestamps through `args`, vary prompts by index.
- No filesystem, `process`, `require` or network access in the script. Agents have tools; the script does not.

## Patterns

- **Default to `pipeline()`.** Use `parallel()` between stages only when stage N genuinely needs all of stage N-1 (deduping across every finding, early exit on zero results, a prompt that cites the other results).
- **Adversarial verify**: for each finding, spawn 2–3 skeptics asked to refute it, each with a distinct lens (`correctness`, `security`, `does it reproduce`). Keep the finding only when a majority fails to refute.
- **Loop until dry**: for unknown-size discovery, run finder rounds until two consecutive rounds surface nothing new. Dedup against everything *seen*, not only what was confirmed, or rejected findings come back forever.
- **Worktree isolation** is expensive (a checkout per call). Use it only when parallel agents edit files; a changed worktree is kept and its path reported.
- **No silent caps**: if you bound coverage (top-N, one round, sampling), `log()` what was dropped. A truncated sweep that says nothing reads as complete.

## Worked example

`references/review-changes.js` is a complete script: four review dimensions in parallel, findings deduped across all of them, then a three-lens adversarial verify per finding. Read it before writing a new workflow from scratch.
