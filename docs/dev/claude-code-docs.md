# What LaBunbun takes from Claude Code's documentation

Claude Code's docs describe the behaviour of a harness built around the same
kind of loop LaBunbun runs. Most of the mechanics already exist here in some
form; the value is in the small number of rules that are stated more sharply
there, and in knowing which recommendations do not transfer.

Sources (all read 2026-11-12):

- [Documentation index](https://code.claude.com/docs/llms.txt)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works.md)
- [Best practices](https://code.claude.com/docs/en/best-practices.md)
- [Explore the context window](https://code.claude.com/docs/en/context-window.md)
- [Keep Claude working toward a goal](https://code.claude.com/docs/en/goal.md)

Prompt-side findings are recorded separately in
[Prompt guidance](prompt-guidance.md); this note covers the product side.

## Adopted now

**`/init` writes a short file of what the code cannot say.** The documented
failure is a generated memory file that describes the architecture and file
layout — things a later session can read for itself — until the file is long
enough that its real rules get lost. The `/init` prompt now asks for the commands
needed to check work (including one test file), the non-obvious conventions and
gotchas written as concrete, checkable instructions, no architecture, and well
under 200 lines. The same rule applies to an existing file: suggest lines to
remove rather than rewriting it.

**`/compact` already takes a focus.** The docs recommend
`/compact focus on …` for the same reason LaBunbun implemented it: the user
knows what the next task needs better than the automatic pass does. No change.

## Already present, so nothing to copy

- A runnable check and visible evidence: the base prompt requires a real build,
  type check or test, and a passing check counts only with its output in the
  conversation.
- Compaction, trimming, and a context report: `autocompact.ts`,
  `trim` (`commands.ts`), and `context-report.ts`.
- Stop hooks and tool hooks: `hooks.ts` supports `PreToolUse`, `PostToolUse`,
  `SessionStart`/`SessionEnd`, `Stop`, and the compaction events.
- Memory hierarchy and rules: `LABUNBUN.md` > `AGENTS.md` > `CLAUDE.md` per
  directory, plus user and project `.labunbun/rules/`.
- Skills, subagents, MCP, plan mode, sandbox, permission modes, checkpoints and
  `/rewind`: each has its own module and design note.
- Sessions, resume, and JSONL history: `session-resume.ts`, `session-store`.
- Worktrees for workflow subagents: `workflow-worktree.ts`.

## Worth considering later, not built

**`/goal`.** A session-scoped completion condition checked by a separate model
after every turn, with verdicts *not yet met*, *met*, and *impossible*. LaBunbun
already has a mission ledger and an exit guard, but no evaluator loop. The
honest version needs: goal state in the session file and on resume, an
evaluator call on the light seat, a visible indicator and verdict history,
background-work deferral, retry/pause rules for provider errors, and a cap on
runaway turn loops. That is a feature, not a prompt clause, and a prompt cannot
substitute for it.

**Path-scoped rules.** `.claude/rules/*.md` with a `paths:` frontmatter loads a
rule when a matching file is read or edited, and reloads it on demand after
compaction. LaBunbun's rules are unscoped and all load at startup. Useful for
large monorepos; it needs a matcher on the file tools, a frontmatter reader, and
a decision about whether scoped rules survive compaction (upstream reloads them
on demand rather than re-injecting them).

**A prompt audit.** Claude Code's `/doctor prompt-audit` flags instructions
written for older models, references to files that no longer exist, and rules
that contradict each other. LaBunbun's `/doctor` checks configuration but does
not read the memory files for contradictions. A smaller version — duplicate
headings, `paths:` targets that do not exist once scoped rules land, and lines
naming commands the project no longer has — would be cheap to add.

**`/btw`.** A side question answered without adding to the conversation
history. It is a UX affordance rather than a capability, and it depends on the
session model exposing a throwaway request path.

## Deliberately not copied

- **Auto mode's classifier as the default.** LaBunbun has its own classifier
  and approval path. Changing a session's default permission mode because
  another product does is not a documentation finding, and the permission
  boundary is not ours to loosen.
- **Cloud, desktop, mobile, and Slack surfaces.** They depend on an account and
  infrastructure LaBunbun does not have.
- **"Tell Claude what it can't see" as more prompt text.** The advice is aimed
  at the user writing `CLAUDE.md`; the prompt-side version of it is the `/init`
  change above, plus the existing rule to read before claiming.
- **Heavy persistence wording.** The best-practices page says current models
  are more likely to over-work than to stop short when told to keep going. That
  is true for the models it measured, but LaBunbun runs many families, and long
  turns here ended with a to-do list and an offer to continue. The adopted rule
  is scoped to ordinary obstacles and bounded by the no-destructive-shortcut
  line, rather than a general "keep going" instruction.

## Where the behaviour is tested

`packages/coding-agent/test/prompt-command-dispatch.test.ts` pins the `/init`
prompt by the phrases that carry the rule. The prompt-side clauses from the
companion note are pinned in `system-prompt.test.ts`.
