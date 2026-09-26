---
name: commit
description: Stage and commit the current changes with a clear, well-scoped message — checks the working tree and diff first, refuses to bundle unrelated changes into one commit, and always shows the message for user confirmation before committing.
---

## Checking the working tree

Run `git status` first. If there's nothing staged or unstaged, say so and stop.

Then read the actual changes, not just the file list: `git diff` for unstaged, `git diff --staged` for anything already staged, and open any untracked files that matter. The commit message comes from what the diff does, not from guessing off filenames.

## Judging the scope — and splitting when needed

Group the changed files by the concern they serve. Two hunks belong in the same commit only when they're part of one coherent change (an implementation file and the test that covers it; a rename and its call-site updates). They don't belong together just because they happened to be edited in the same session.

**This is the hard rule, not a suggestion: never commit unrelated changes together.** If the working tree mixes, say, a bug fix with an unrelated formatting pass, or two independent fixes that don't call into each other, stop and propose splitting into separate commits — each staged with its own explicit `git add <path>` — before writing any message. Say which files go in which group and why.

## Matching this repo's commit style

Run `git log --oneline -15` before writing anything, and match what it shows. The history has two shapes and it moved between them, so a description of "the style" that doesn't say which is current will send you the wrong way:

- **Older commits** (roughly 70 of the last 200) are a plain imperative summary with no prefix at all: `Stop trusting repo-controlled settings tiers`, `Teach the Vim engine vim's character classes and terminal motions`.
- **Recent commits** — every batch since the migration work — lead with a scope and a colon: `vim: the quote text objects`, `emacs: modeless editing in the prompt, alongside vim`, `zcode: read the MCP legacy spellings the way ZCode reads them`, `/activity: session heatmap with current and longest streak`, `test: pin the mtimes the newest-session test asserts on`. The scope is a feature, module, or batch name, and the summary after the colon starts lowercase.

What is *not* the convention is Conventional Commits' `feat:`/`fix:`/`chore:` type vocabulary, and it is worth being explicit about the difference: a scope names **which part of the product** a commit touches, a type names **what kind of change** it is. Use the first.

A body is now the norm rather than the exception, and the recent ones earn their length. They typically open with why the change was made — including the reason it was wrong before, when there was one — and often close with a short verification list naming the tests, cases, or counts that back it up. "Ran the linter" is not verification; "33 differential cases (947 -> 980), 980/980 against a real vim" is. What carries over from Conventional Commits here is the discipline behind it, not the prefix syntax: one logical change per commit, described unambiguously. That discipline is exactly what the scope-judging step above already enforces.

## Showing it and waiting for confirmation

Print the exact message and the exact paths about to be staged before touching the repo. Do not run `git add` or `git commit` until the user confirms — this posts to shared history once done, and the cost of asking first is far lower than the cost of an unwanted commit.

## Committing

Stage only the specific paths identified above — never `git add -A` or `git add .` when the working tree has anything outside the current scope. Commit with the confirmed message via a heredoc so a multi-line body survives shell quoting intact.

End the message with the `Co-Authored-By: Claude <noreply@anthropic.com>` trailer, after the body and separated by a blank line. Most of the recent history carries one (74 of the last 200 commits), so a commit without it is the odd one out. Show it in the preview above, since it is part of the message the user is approving.

Never push as part of this skill; that is a separate action requiring its own confirmation.
