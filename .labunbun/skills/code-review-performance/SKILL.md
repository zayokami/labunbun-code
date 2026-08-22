---
name: code-review-performance
description: Check a diff for the concrete performance pitfalls labunbun has already hit and fixed once — serialized concurrency, unbounded MCP connects, unbounded tool output, and retry storms.
---

Check for the specific performance failure modes this codebase has already had to fix once — a regression here is a reintroduction, not a new discovery:

- **Concurrency-safety flags** (`packages/agent/src/concurrency.ts`, `isConcurrencySafe` on `Tool`): a new tool that's actually independent (read-only, no shared mutable state) but isn't marked `isConcurrencySafe` gets serialized into its own batch and stalls every other call behind it. Conversely, marking something unsafe as safe risks races — check the tool's own state access, not just its label.
- **MCP connection fan-out** (`packages/mcp/src/client.ts`, `connectAllMcpServers`): all configured servers connect via a single bounded `Promise.all`, each with its own `CONNECT_TIMEOUT_MS`-bounded race — a change that reintroduces a sequential loop here brings back the original bug where one unresponsive server hung startup for everyone.
- **Unbounded tool output** (`packages/agent/src/pipeline.ts`, `truncate`): results are capped at `maxResultSizeChars` (default 30,000) per tool by default. A new tool returning large content (a full file, an unpaginated list) needs either a deliberately smaller cap, a pagination parameter, or a reason the default cap is fine — not silent reliance on the default hiding the problem.
- **Retry backoff bounds** (`packages/ai/src/retry.ts`, `withRetry`): backoff is exponential (`baseDelayMs * 2 ** attempt`) but capped at `maxDelayMs`, and attempts are capped (`maxAttempts`, with a tighter `overloadedMaxAttempts` for 529s). A new retry path without both an attempt ceiling and a delay ceiling can turn a transient failure into a long busy-wait or a retry storm against a struggling provider.
- **Context growth** (`packages/agent/src/compaction.ts`, `estimateContextTokens`/`compactionThreshold`): anything that appends non-trivial content to the conversation every turn (hook `addedContext`, a new tool's result) competes for the same compaction budget. Check whether genuinely large or growing content should be summarized/truncated at the source instead of relying on compaction to catch it later.

For each hit, note whether it's a correctness-adjacent stall (blocks forward progress) or a resource-growth issue (degrades over a long session), since the two need different urgency.
