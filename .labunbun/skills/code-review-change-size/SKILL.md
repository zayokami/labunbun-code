---
name: code-review-change-size
description: Judge whether a diff is too large to review carefully, using labunbun's own batching history as the yardstick, and say how to split it into landable stages.
---

Line count is a weak instrument here, because this repo has committed both a 5-file change and a 31-file one and was right both times. What separates them is not size but whether a reviewer can hold the whole thing in one pass — so say that first and use the count only as evidence.

The batches that actually landed give the range. A 5-file change (ada154f) and a 31-file, +31,877/−2,759 change (aae111f) were both single commits; a 9-file change touching three unrelated concerns was split into three (a5e9788, f2b47bd, 6a1bfd5), and so was a 21-file emacs change (a9df8db, then ada154f). None of those were wrong. So the finding to raise is not "this is big" — it is **"this diff mixes concerns, and here is where they divide."**

When it does, do the division on the actual dependency graph in the diff — which files the rest of the change calls into, and which tests belong to which implementation. Tests separate cleanly from the code they cover and usually should. A change that genuinely cannot be split (one atomic rename across the repo, a generated lockfile, a mechanical reformat) should be said so plainly rather than forced into artificial stages.

**If the working tree mixes concerns, do not trust a hand-written file list to divide them.** That is not caution, it is a measured failure in this repo: a batch split into three commits initially left a test file behind because its state in the working tree did not match the state the split assumed, and the omission was invisible — the staged diff came out 156 lines against the 24 the plan described, and nothing errored. Verify the partition against the blobs each file would end up in, not against the names on the list. And say which files go in which group, so the grouping is reviewable rather than asserted.
