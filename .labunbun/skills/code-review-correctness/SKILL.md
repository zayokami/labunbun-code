---
name: code-review-correctness
description: Check core invariants a labunbun change can quietly break — the tool pipeline's never-throws contract, the length-recovery ladder, concurrent-batch result ordering, and schema-as-source-of-truth.
---

Check the diff against invariants that are easy to break quietly because nothing type-checks them:

- **The pipeline never throws** (`packages/agent/src/pipeline.ts`, `runToolPipeline`): every stage — schema validation, `validateInput`, hooks, permissions, `tool.call`, and the outer wrapper itself — catches and converts failure into an `isError` `ToolResultMessage`. A new stage, or a new tool whose `call` awaits something outside its own try/catch, can reintroduce an unhandled throw that breaks the "always paired results" guarantee the agent loop depends on.
- **The length-recovery ladder** (`packages/agent/src/session.ts`, around `stopReason === "length"`): escalation (`escalatedOnce`, raising `maxOutputTokens`) happens once, then continuation retries happen up to `LENGTH_CONTINUE_RETRIES`, then the ladder gives up and reports an error — in that order. A change here needs to keep the ladder bounded; check any new branch actually terminates rather than looping past the retry cap.
- **Retry vs. partial emission** (`packages/ai/src/retry.ts`, `withRetry`): retries only happen when `emittedAny` is still false — once any event has reached the consumer, a retry would duplicate output, so the wrapper re-throws instead. A new call site wrapping a stream function must preserve this: never retry after the caller has already seen part of the response.
- **Concurrent batch ordering** (`packages/agent/src/concurrency.ts`, `partitionToolCalls`): calls execute in parallel within a batch but the contract is that results are still reported in source order regardless of completion order. Check that a change to batching/slicing logic (e.g. the `maxConcurrency` overflow loop) can't silently reorder results relative to the assistant's original tool-call sequence.
- **Schema as the single source of truth** (`packages/agent/src/types.ts`, `Tool.inputSchema`): the same zod schema both validates runtime input (`safeParse` in the pipeline) and generates the wire JSON Schema (`z.toJSONSchema`) sent to the model. A new tool that hand-writes a separate JSON Schema, or validates with ad hoc checks instead of `inputSchema`, will drift from what the model was actually told the tool accepts.

For each hit, say which invariant breaks, the specific input or timing that triggers it, and what a user or the model would observe when it does.
