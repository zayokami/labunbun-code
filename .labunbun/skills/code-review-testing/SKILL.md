---
name: code-review-testing
description: Test-authoring conventions for labunbun changes — what kind of test a change needs and where it belongs.
---

All tests use `bun:test` (`describe`/`test`/`expect`) and live under each package's `test/` directory, mirroring `src/`.

- Pure logic (state machines, parsers, permission rules) gets a direct unit test with no I/O — see `packages/tui/test/vim-engine.test.ts` or `packages/agent/test/permissions.test.ts` for the in-memory fixture pattern: drive the real thing through its real interface and assert on the resulting state, don't mock its internals.
- Behavior that spans multiple modules (the Task tool plus a nested AgentSession, settings loading across tiers, hook dispatch) gets an integration-style test that exercises the real collaborators together rather than stubbing them — see `packages/coding-agent/test/subagents-skills-plan.test.ts`.
- Prefer table-driven cases (an array of `[input, expected]` tuples run through one assertion body) over several near-duplicate test blocks when checking many similar inputs against the same rule.
- A bug fix needs a regression test that fails without the fix. A new tool, command, or schema field needs at least one test exercising its real path, not just a type-check.
- Check the target package's existing `test/*.test.ts` files for a fixture helper that already does what's needed before writing a new one.

Flag a diff that adds behavior with no test covering it, or that changes an existing schema/contract (settings, session entries, hook payloads) without a test that would catch a future regression there.
