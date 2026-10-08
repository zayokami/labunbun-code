---
name: fewer-permission-prompts
description: Scan this project's session transcripts for tool calls that were approved once, and propose scoped permissions.allow rules so the same dialog stops interrupting. Use when the permission prompts feel repetitive, or when the user asks to reduce prompts. Writes nothing without showing the rules first.
---

Propose permission rules from what this project actually does, so the same dialog stops interrupting.

## Count what was really approved

1. Read the session transcripts under `~/.labunbun/projects/<dir>/` — the directory is the `sanitizeCwd` slug of the working directory (JSONL files, append-only).
2. Count tool calls by tool name and the shape of their input: which `Bash` commands recur, which file paths are written, which MCP servers are called.
3. Propose rules for the recurring ones only. A one-off call does not earn a rule.

## Scope every rule

A rule has the form `Bash(git *)`, `Edit(src/**)`, `mcp__server__*` — the same shape the session's own "don't ask again" produces, scoped by `ruleSpecifierFor` in `packages/tui/src/permission-options.ts`. That scoping is load-bearing: an unscoped `Bash` rule is the old bug where one approval opened every command.

- Prefer the narrower specifier: `Bash(git status)` and `Bash(git diff)` before `Bash(git *)`; never `Bash(*)`, never a bare tool name.
- Match how the command is actually written: the engine matches the whole command, so a rule for `git status` does not cover `git status -s`.
- Adding a rule never removes a deny rule — denies win from every tier.

## Show, then write

Print the proposed rules with the evidence (which transcripts, how many approvals each covers) and wait for confirmation. On approval, write them to the **user** tier `~/.labunbun/settings.json` under `permissions.allow`.

Do not write them into a project file: the project tier denies `permissions.allow` (`PROJECT_TIER_KEY_POLICY` in `packages/coding-agent/src/settings.ts`), so a repository-shipped allow list is dropped at load time with a notice.

## Report

One list of the rules added, the commands they cover, and the tier they went to. If a recurring prompt cannot be scoped safely (a command whose arguments are the whole point, like `rm`), say so and leave it alone instead of inventing a broad rule.
