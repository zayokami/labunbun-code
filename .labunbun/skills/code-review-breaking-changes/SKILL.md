---
name: code-review-breaking-changes
description: Check whether a change breaks labunbun's external integration surfaces — CLI flags, settings.json schema, session file format, hook contract, or cross-package exports.
---

Search the diff for changes to labunbun's external surfaces — the things other people's configs, scripts, or saved state depend on, not just the immediate caller:

- **CLI flags and output** (`packages/coding-agent/src/main.ts`): renaming, removing, or changing the meaning of an existing flag; changing the shape of `--output-format json`/`stream-json`.
- **`settings.json` schema** (`packages/coding-agent/src/settings.ts`, `SettingsSchema`): removing a field, changing its type, or changing merge/precedence behavior across the user/project/local/policy tiers. Existing settings files in the wild must keep working or fail loudly — not silently change meaning.
- **Session file format** (`packages/agent/src/session-store.ts`, `SessionEntry`): changing an existing entry shape breaks `--resume` against sessions written by an older build. Adding a new entry `type` is safe; changing or removing an existing one is not.
- **Hook contract** (`packages/coding-agent/src/hooks.ts`): the stdin JSON payload shape and the stdout `{continue, suppressOutput, decision, reason}` reply shape are a contract with user-written shell scripts. Renaming a field or changing its semantics breaks every existing hook script silently.
- **Permission rule syntax** (`Bash(git *)`, `Edit(src/**)`, `mcp__server__*`): changing how rule text is parsed or matched changes what existing `allow`/`deny` lists actually do — a security-relevant behavior change, not just a compatibility one.
- **Cross-package exports** (`packages/*/src/index.ts`): removing or changing the signature of something another package imports.

Do not stop after finding one issue; check every surface in the list above against the actual diff. For each hit, state which surface it is, what changes for an existing user/script/session, and whether it's additive (safe) or a real break that needs a migration note or reconsideration.
