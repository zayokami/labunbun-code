---
name: code-review-testing
description: Test-authoring conventions for labunbun changes — what kind of test a change needs and where it belongs.
---

All tests use `bun:test` (`describe`/`test`/`expect`) and live under each package's `test/` directory, mirroring `src/`.

- Pure logic (state machines, parsers, permission rules) gets a direct unit test with no I/O — see `packages/tui/test/vim-engine.test.ts` or `packages/agent/test/permissions.test.ts` for the in-memory fixture pattern: drive the real thing through its real interface and assert on the resulting state, don't mock its internals.
- Behavior that spans multiple modules (the Task tool plus a nested AgentSession, settings loading across tiers, hook dispatch) gets an integration-style test that exercises the real collaborators together rather than stubbing them — see `packages/coding-agent/test/subagents-skills-plan.test.ts`.
- Prefer table-driven cases (an array of `[input, expected]` tuples run through one assertion body) over several near-duplicate test blocks when checking many similar inputs against the same rule.
- A bug fix needs a regression test that fails without the fix. A new tool, command, or schema field needs at least one test exercising its real path, not just a type-check.
- **An invariant the skills name should have a test of its own.** The other `code-review-*` skills point at specific mechanisms as the thing to protect — `extractBashFilePaths`, the length-recovery ladder, the deny-before-allow scan. Those citations are only as good as the tests behind them, and a skill that names a mechanism nothing exercises is asserting a guarantee the repo does not actually hold. Check it, and treat a missing test as the finding. The standing example is `extractBashFilePaths`: it is what stops a `Read(...)` deny rule from being sidestepped by `Bash(cat <the same file>)`, and the permission tests exercise deny-versus-allow only *within* one tool, so the cross-tool extension is the part most likely to rot unnoticed.
- **A new assertion has to be falsifiable on its own, not merely pass.** The question to ask of any test added in this diff is: if the one line of production code it is about were changed to something wrong, would this test go red? A test that exercises a fixture but asserts on a neighbouring value will stay green through the exact regression it was written for. The repo's heavier tools for this — the vim differential harness under `packages/tui/test/vim-differential/`, and the mutation drivers used per batch — exist because reading a test is not the same as running the check backwards.
- Check the target package's existing `test/*.test.ts` files for a fixture helper that already does what's needed before writing a new one.

Flag a diff that adds behavior with no test covering it, or that changes an existing schema/contract (settings, session entries, hook payloads) without a test that would catch a future regression there.
