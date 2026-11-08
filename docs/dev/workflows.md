# Workflows

A workflow is a JavaScript script that orchestrates subagents. The `Workflow` tool runs the script in a sandbox and gives it one way to reach the fleet: `agent()`, which is the same nested `AgentSession` a `Task` call spawns. The difference is who owns the control flow. In a `Task` fan-out the model decides the next call while answering; in a workflow the script decides, so a loop, a fan-out, or a staged pipeline happens the same way on every run.

The runtime is `packages/coding-agent/src/workflow-*.ts`. Saved definitions are user-tier (`~/.labunbun/workflows`) and project-tier (`.labunbun/workflows`, behind the `workflows` trust kind). The built-in `workflow` skill teaches the script API to the model.

## Why the script sits in a sandbox

`workflow-script.ts` evaluates the body in a fresh `node:vm` context with no `process`, `require`, `fetch` or filesystem. That is not a security boundary against malicious code — the script is written by the model in the same session — it is a correctness boundary. A workflow's value is that its calls are reproducible: the same script and args must produce the same sequence of agent calls. Two globals would break that, so both throw:

- `Date.now()` and `new Date()` — a timestamp in a prompt changes the call, and resume could never match it. Timestamps travel through `args`.
- `Math.random()` — the same reason. Variation belongs in an index or a prompt.

`console` is shadowed to `log()`, so a stray `console.log` becomes a progress line instead of writing somewhere nobody reads. `Object.create(Math)` keeps every other `Math` method while replacing only `random`.

The script is wrapped in an async IIFE; the meta statement is blanked with spaces (newlines preserved) before evaluation, so line numbers in a stack trace still point at the saved file. Only `export const meta` is allowed as an export; any other `export` is rejected before anything runs.

## Hooks

`agent(prompt, opts)` resolves, never rejects. A failed call becomes `null`, which is the documented contract (`.filter(Boolean)`). `parallel()` and `pipeline()` apply the same rule per item, and report the failure as a progress line — the harness² lesson that a missing result must never be mistaken for a successful one.

The concurrency cap is one `Gate` for the whole run, held around the `agent()` call itself rather than around a stage. Nested `parallel()` calls therefore share the cap, and a stage waiting on nested work holds no permit, so it cannot deadlock. `min(16, cpus - 2)` is the default; `MAX_WORKFLOW_AGENTS` (1000) and `MAX_WORKFLOW_ITEMS` (4096) are runaway backstops. Passing more items than the limit is an error, not a silent truncation.

`budget` exists for script compatibility but is not wired to a token pool: `total` is `null`, `remaining()` is `Infinity`. A script guarding on `budget.total` therefore runs to its agent cap, which is what the tool description says.

## Structured output

`agent(prompt, {schema})` returns a validated object instead of text. The subagent layer appends an instruction to its system prompt and, where the wire has the field, sends the schema natively (`output-schema.ts`, shared with `-p --output-schema`). After the run, `parseJsonValue` extracts the answer — a fenced block, the whole text, or the first balanced `{`/`[` span — and `validateWorkflowSchema` checks the keywords a workflow author reaches for: `type`, `properties`, `required`, `items`, `enum`, `const`, string and number bounds, `additionalProperties`, and `allOf`/`anyOf`/`oneOf`. Unknown keywords are treated as satisfied, so a schema written for a stricter validator still works.

One failure gets one retry with the validator's complaints in the prompt. A second failure is reported, not retried again: the caller decides how much one answer is worth. The retry is a new prompt on the same subagent session, so the model keeps the context that produced the answer it is fixing.

## Resume

Every run gets a directory under `~/.labunbun/workflows/runs/<runId>/`:

- `run.json` — name, script hash, args hash, timestamps, status, agent counts.
- `script.js` — the script exactly as it ran. A resume with an edited script writes `script.resume.js` beside it rather than overwriting the record.
- `args.json` — the args value, when one was passed.
- `journal.jsonl` — one line per agent call, appended as it completes.
- `log.txt` — the progress lines, for post-mortem reading.
- `worktrees/` — one checkout per isolated call.

The cache key is a SHA-256 of the call's inputs (prompt, schema, model, effort, agent type, isolation) plus an occurrence index (`hash#0`, `hash#1`). Labels and phases are display-only and stay out of the hash, so renaming a stage does not invalidate it. The occurrence index is assigned for every call — including failed ones — so a loop's second identical question is a distinct draw and the replay sequence matches the original run. Only `status: "ok"` entries are reused; a failed call consumes its slot and runs again. Reordering a script changes the first call's inputs only where they actually changed, and everything after the first miss runs live.

On resume the occurrence counters start at zero for every call hash, not after the journal's last occurrence: the script is replayed from its first line, so the k-th identical call must claim `#k` again and meet the entry it wrote last time. Seeding the counter from the journal would turn every replay into a cache miss.

A result too large to store (over 4 MB of JSON) is journaled as an error saying so, so resume re-runs that call instead of replaying part of it. This is the same rule as the item cap: fail loudly, never hand back a silent truncation.

`resume_from` with no script or name reuses the saved `script.js` and `args.json`. A new run is created for every call without `resume_from`; there is no automatic "continue the last run", because a resumed workflow is a deliberate act.

## Worktree isolation

`isolation: "worktree"` creates a detached worktree at HEAD for that call, runs the subagent with `cwd` set to it, then checks `git status --porcelain` and `rev-parse HEAD`:

- unchanged → `git worktree remove --force`, the directory goes away;
- changed, or any git failure → the worktree is kept and its path reported in the tool result and the journal.

Kept worktrees are the one cleanup decision that can destroy work, so the rule is fail-closed. This also means a script that isolates a read-only agent pays a checkout per call with nothing to show for it; the tool description and the skill both say to use it only for parallel mutation.

## Trust and discovery

Workflow scripts are executable, so the project tier sits behind the same one-time trust decision as project agents, skills, memory files and output styles. `DefinitionKind` gains `"workflows"`; `/agents approve` records it alongside the others and pushes the adopted definitions into the live list the tool reads, so a project workflow runs in the session that approved it. The tool description's catalogue is frozen at mount, like every other prompt list — the next start lists it there, while `/agents` lists it immediately. A `-p` run has no dialog and withholds the project tier, saying so on stderr.

Definition loading details:

- Direct children only, `.js` files; `references/` subdirectories are data, not definitions.
- The file name is the workflow name; `meta.name`, when present, must match it. Names follow the Agent Skills rule (`[a-z0-9-]`, ≤64) because they appear in the tool description.
- A missing meta is allowed (the file name and an empty description still work); an invalid meta, a second export, or an over-long description is a startup note, not a silent skip.
- The user tier always loads; a project definition overrides a user definition of the same name, matching skills.

## Testing

- `workflow-schema.test.ts` — the JSON Schema subset, extraction from fenced/prose answers, root shape rules.
- `workflow-script.test.ts` — meta parsing, the sandbox globals, agent/parallel/pipeline semantics, limits, abort.
- `workflow-journal.test.ts` — keys and occurrence indices, append/replay, size cap, resume script handling.
- `workflow-runner.test.ts` — journal wiring, caching, structured failures, worktree creation and cleanup, abort/failure statuses.
- `workflow-definitions.test.ts` — tier precedence, name validation, notes, catalogue.
- `workflow-tool.test.ts` — input resolution, saved names, result formatting, resume, unknown-definition errors.
- `subagent-structured.test.ts` — the spawn extension: model/cwd/schema overrides, parse, retry.

The faux provider drives the subagent tests the same way `subagent-model-seat.test.ts` does; no network is involved.

## Lineage

The journal, occurrence-keyed cache and fail-closed worktree cleanup adapt ideas from the harness² experiment in `G:\Bunttta\harness2-main`: a content-addressed call cache, explicit completion markers instead of assuming an output file means success, ledger accounting that refuses duplicate work, and validation feedback rather than silent acceptance. The differences are deliberate: labunbun's journal is one JSONL file appended per call (not a database), schema checking is a small keyword subset (not a general validator), and the script API keeps the shape Claude Code's Workflow tool uses so a script written for one is close to portable to the other.
