---
name: skill-writing
description: How to write a new SKILL.md for this repo — frontmatter format, what actually gets loaded, and where to put supporting files.
---

## Where skills live

`.labunbun/skills/<name>/SKILL.md`, under either `~/.labunbun/skills/` (user) or `<project>/.labunbun/skills/` (project — wins on a name collision). Each one becomes a `/skill-<name>` command; invoking it expands to the skill body plus whatever the user typed after the command name.

## Frontmatter is flat — there's no nesting

The loader (`packages/coding-agent/src/skills.ts`) parses frontmatter with one regex for the `---` block, then a per-line `key: value` split. There is no YAML parser behind it:

- Only flat `key: value` pairs work. A nested block or a `- item` list is read back as a literal string, not a structure.
- `name` and `description` are read by the loader, and so is `disable-model-invocation`. Extra keys are harmless but ignored — don't invent a key and expect the loader to act on it without adding that support first.
- `description` is what shows up in autocomplete AND in the discovery block the model reads, so write it in the third person with a concrete trigger ("Use when reviewing a diff for breaking changes to settings.json") rather than a vague label.
- The directory name is the skill's identity: it must match the frontmatter `name`, and must be lowercase letters, digits and single hyphens, at most 64 characters. A folder that fails this is held back at load and named in a startup notice — it is never silently loaded under a different name.

## Two ways a skill reaches the model, and the cost of each

**Discovery** (`skillDiscoveryBlock`): the `name — description` line goes into the system prompt of every session, inside a shared 8000-character budget. That line is the whole Level-1 cost; nothing else about the skill is in the prompt until the model invokes it. `disable-model-invocation: true` keeps a skill out of this list while leaving it callable as `/skill-<name>` — the right choice for skills that are only useful when the user names them.

**Invocation** (`skillsAsCommands`): invoking `/skill-<name>` sends the *entire* `SKILL.md` body to the model in one shot (wrapped in a `<skill>` tag). There's no automatic mechanism that pages in supporting files on demand.

That means:

- Keep the body itself lean — it's a fixed cost paid on every invocation.
- If a skill genuinely needs a large reference doc or a script, put it in a file next to `SKILL.md` and tell the model to `Read` (or run) it explicitly when needed, instead of pasting it into the body. That keeps the per-invocation cost small while the detail stays one `Read` call away.

## Writing the body

- State what to do and in what order — the model reading this has full tool access (Read/Bash/Grep/Task/etc.) but no memory of why this skill exists.
- Name concrete files, schemas, or commands from this repo instead of generic advice — "check `SettingsSchema` in `packages/coding-agent/src/settings.ts`" is checkable; "validate the configuration" is not.
- If the skill should fan out to subagents, say explicitly how many, what each one is told, and whether they run concurrently (see the `code-review` skill for a worked example).
- Don't restate in the body what the description already said.
