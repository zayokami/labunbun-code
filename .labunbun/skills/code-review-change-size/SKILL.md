---
name: code-review-change-size
description: Flag reviews that are too large to review carefully and suggest how to split them into landable stages.
---

Unless the change is purely mechanical (rename, reformat, generated code), a single review should cover at most 800 changed lines. Changes that touch non-trivial logic should stay under 500 lines.

When a diff exceeds that:

1. Say so explicitly — don't silently review a huge diff end-to-end and hope nothing was missed.
2. Identify the smallest coherent slice that could land on its own (a single package, a single behavior change, tests separated from the implementation they cover).
3. Base the split on the actual dependency graph in the diff — which files and functions the rest of the change calls into — not just a raw line count.
4. If the change genuinely cannot be split (e.g. a single atomic rename across the repo, or a generated lockfile), say that explicitly instead of forcing an artificial split.
