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

Run `git log --oneline -10` before writing anything. labunbun's actual history is plain descriptive imperative-mood summaries (`Add example skills: code review orchestration, PR body, skill writing`, `Close permission bypasses and activate dead configuration`) — it does not use Conventional Commit type prefixes like `feat:`/`fix:`. Match what the log actually shows over a generic external convention: one summary line describing the change, a body only when the why isn't obvious from the diff or summary alone.

What carries over from Conventional Commits here is the discipline behind it, not the prefix syntax: one logical change per commit, described unambiguously. That discipline is exactly what the scope-judging step above already enforces.

## Showing it and waiting for confirmation

Print the exact message and the exact paths about to be staged before touching the repo. Do not run `git add` or `git commit` until the user confirms — this posts to shared history once done, and the cost of asking first is far lower than the cost of an unwanted commit.

## Committing

Stage only the specific paths identified above — never `git add -A` or `git add .` when the working tree has anything outside the current scope. Commit with the confirmed message via a heredoc so a multi-line body survives shell quoting intact. Never push as part of this skill; that is a separate action requiring its own confirmation.
