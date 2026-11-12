# Path-scoped rules

A rule file in `.labunbun/rules/` can say which files it governs. The rule then
loads when the agent first reads, edits or writes one of them, instead of at
startup. This note covers the frontmatter, the match, the attachment, and the
places the feature deliberately stops.

## The file

```markdown
---
paths:
  - src/api/**/*.ts
  - docs/handlers/
---

Every handler answers with the envelope in `api/respond.ts`.
```

`paths:` may be a YAML list, one inline scalar (`paths: src/api/**`), an inline
list (`paths: [a/*.ts, b/*.md]`), or any of those quoted. The reader is in
`packages/coding-agent/src/rule-paths.ts:49` (`parseRulePaths`) and handles one
key rather than pulling in a YAML dependency for a field with one shape. A
trailing `/` means the whole tree and is read as `dir/**`
(`rule-paths.ts:121`, `ruleMatches`).

A rule file with no `paths:` is an ordinary startup rule. `collectRules`
filters the scoped ones out of the startup memory
(`packages/coding-agent/src/memory.ts:307`), and `loadPathRules` reads them
into `PathRule` values from the same two tiers the startup rules come from —
the user's `~/.labunbun/rules` and the project walk behind the memory trust
gate (`memory.ts:571`). A file that names `paths:` but lists none is treated
as unscoped: the frontmatter stays in its body and it loads at startup.

## The match

Globs are matched against the file's path **relative to the workspace cwd**,
with forward slashes, using `Bun.Glob` (`rule-paths.ts:104`). Patterns compile
once per session and are cached by pattern. Only `Read`, `Edit` and `Write`
are considered — a tool with no single subject (`Glob`, `Grep`, a shell
command) cannot say which file it touched, and guessing from its arguments
would attach rules to the wrong files (`rule-paths.ts:128`).

A path that resolves outside the workspace is ignored (`rule-paths.ts:179`):
the rule set is about this project, and `../shared/lib.ts` is another tree
whose own rules would be the right ones, if it had a session to load them.

## The attachment

The first tool result about a matching file gets the rule appended as a text
block (`rule-paths.ts:175`):

```
[path rule — .labunbun/rules/api.md (src/api/**)]
Every handler answers with the envelope in `api/respond.ts`.
[end of path rule]
```

The header names the rule file and the globs that pulled it in, so the model
can tell a project rule from tool output. The rule then lives in the transcript
like any other tool result and is part of every later request. Each rule
attaches once per session (`rule-paths.ts:230`); reading forty files that match
the same glob does not paste it forty times.

A finished compaction replaces the messages above the boundary, which is where
the attachment lived. Every host calls `reset()` on the compaction `done` phase
(`interactive.ts:1022`, `headless.ts:941`, `acp.ts:1308`). The cheap and idle
rungs do the same one rung earlier: they replace old tool results with previews
without a `done` phase, so the wiring's `onContextReduced` resets the set in
every host (`interactive.ts:1117`, `headless.ts:905`, `acp.ts:1272`), and a
manual `/trim` resets it through the command context's `resetPathRules`
(`commands.ts:401`). The next matching read attaches the rule again rather
than leaving the session working under a rule it can no longer see.

A resumed session is the other direction: its transcript may already carry a
rule the new process never attached. Each host calls `seed()` over the loaded
messages after restoring them (`interactive.ts:1901`, `headless.ts:1099`,
`acp.ts:1419`), which marks a rule attached when its own header appears in a
tool result — so a resume, and a `/resume` hot swap (`interactive.ts:2149`),
do not paste a rule the model can already read.

## Where the hosts wire it

All three hosts build the injector after loading memory and hand it the same
cwd and home: the REPL at `interactive.ts:943`, `-p` at `headless.ts:642`, and
ACP at `acp.ts:1216`. The REPL has its own `afterToolCall`; `-p` and ACP share
`sessionHookDeps`, which accepts `pathRules` and applies it before the
`PostToolUse` hook (`hooks.ts:276`). A user hook therefore sees the tool result
with the rule attached, and a hook that replaces the result can still drop it.

## What is not built

- **Subagents do not receive path rules.** A subagent builds its own system
  prompt (`subagents.ts:708`) and runs a session with its own hooks; the
  injector belongs to the parent. A subagent that reads a governed file works
  without the rule. Fixing this means giving each subagent session its own
  injector over the same `loadPathRules` output, not sharing the parent's
  attached set.
- **Scoped rules are not listed anywhere the user can see them.** `/memory`
  opens the rules directory, and the startup notice names unreadable files,
  but no command says "these rules are scoped, to what". The `/doctor` audit
  sketched in [Claude Code documentation](claude-code-docs.md) would be the
  natural home for checking that a `paths:` glob matches at least one file.
- **A rule file edited mid-session is read once.** Like the startup rules, the
  set is loaded at session start; changing its globs needs a new session.

## Where the behaviour is tested

`packages/coding-agent/test/path-rules.test.ts` covers the frontmatter reader,
the glob match, the injector's attach/dedupe/reset behaviour, and the split
between startup memory and scoped rules in both tiers.
`packages/coding-agent/test/path-rules-e2e.test.ts` runs the whole app in a
child process and asserts the marker is absent from the startup prompt and
present in the request after a matching `Read`.
