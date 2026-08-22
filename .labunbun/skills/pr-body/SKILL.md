---
name: pr-body
description: Write or update a pull request title and body for the current branch — why before what, preserve existing content worth keeping, keep it repo-relative and free of local paths.
---

## Finding the PR

If no PR number or URL was given, infer it from the current branch:

```bash
gh pr view --json number,url,body --jq '{number, url}'
```

If that fails, the branch may not have an open PR yet — ask before creating one.

## What goes in the body

Explain *why* the change is being made before *what* changed. If the conversation already established the motivation (a bug report, a user request, a design decision), carry that into the body — don't make the reader re-derive it from the diff.

Then describe what changed, more briefly than the why, and how it was verified — which tests are new or updated specifically because of this change, not routine things CI already checks (no "ran the linter" bullet).

Cover only the *net* change. Drop anything that was tried and reverted in earlier commits on the branch — that belongs in commit history, not in a body future readers use to understand what shipped.

## Preserving existing content

Before overwriting, fetch the current body:

```bash
gh pr view <number> --json body --jq '.body'
```

Never drop an image, checklist, or reviewer-added section from the existing body — merge new content in rather than replacing it wholesale, unless the user explicitly asked for a full rewrite.

## Formatting

- Inline code in single backticks; fenced blocks for multi-line snippets or shell transcripts.
- Link existing code with permalinks rather than pasting large excerpts.
- Use repo-relative paths, never a local absolute path (`/home/you/...`, `C:\Users\...`).
- Never include secrets, internal URLs, or anything the user flagged as confidential.
- Reference related issues/PRs by number; the PR doesn't need to reference itself.

## Applying the update

```bash
gh pr edit <number> --title "<title>" --body-file <path-to-body.md>
```

Show the user the drafted title/body before running `gh pr edit` — this posts publicly and updates state visible to every collaborator on the PR.
