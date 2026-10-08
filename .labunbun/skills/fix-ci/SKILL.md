---
name: fix-ci
description: Diagnose and fix a failing GitHub Actions run on this repository. Use when CI is red — fetches the failed job logs, tells a real regression from a runner flake or environment wave, and fixes the cause instead of the symptom. Trigger words: CI red, Actions failing, check failed, rerun.
---

Fix a failing CI run on this repository. The pipeline is nine jobs — `lint`, `typecheck`, `test` ×4 (windows / ubuntu / macos / bwrap-on-PATH) and `build` ×3 — defined in `.github/workflows/ci.yml`.

## Read the logs, not the job names

1. Identify the run: `gh run list --branch main -L 5`, or take the run id from the args.
2. Fetch the failure itself: `gh run view <run-id> --log-failed`. If that is truncated, download the full archive. Never classify a failure from the job name or the red X — the assertion text in the log is the evidence.
3. Quote the failing assertion and the test name in your report before saying anything about cause.

## Classify before touching code

**Our change.** The failure names a file, symbol, or behaviour in the diff. Reproduce it locally with the same command the job runs, then fix the cause.

**A known flake.** These have all been seen on this repo's CI and are environment-shaped, not code-shaped:

- macOS sandbox-wiring: one test at ~5000 ms while the shell spawn next to it takes 14 ms — the runner paused, not the code.
- ubuntu cache-prefix: an assertion races a rewrite registration (`UNREGISTERED` read before the rewrite exists).
- macOS walk-ratio: a ratio assertion swings 648 ms / 1887 ms between adjacent runs, with the quadratic prediction in the comment right next to it.
- Windows marginal timeouts: a test killed past 5 s while the adjacent tests in the same run ran 3–4× their normal cost, and a docs-only control run also went red.

**An environment wave.** Four signatures, in the order to check them: (1) the same test passes when run alone locally; (2) a control run that only touched docs also failed; (3) adjacent tests in the same run cost multiples of their usual time; (4) the log ends with no summary line and process-spawn errors (`Resource temporarily unavailable`, `cygheap read copy failed`, `0xC0000142`) — machine exhaustion, not the change. Measure resources (`tasklist`) before suspecting code.

**A rerun going green proves intermittence, not a fix.** Say exactly that in the report; never call a flake "fixed" because the rerun passed.

## Fix rules

- Reproduce first: run the failing test file locally (`bun test packages/<pkg>/test/<file>.ts`), then the gate the job runs.
- Never widen a timeout to hide a marginal failure. A budget may only be raised when both signatures hold — a decay wave (later tests in the same run recovering) AND a docs-only control run that also failed — and the commit message has to name both.
- Platform-specific failure (one OS red, others green) means platform code: check the Windows CRLF path, the macOS-only branch, or the Linux sandbox before anything else.
- After the fix: rerun the gates (`bun test`, `bun x tsc -p tsconfig.check.json`, `bun x biome check .`) and report the counts, not "green".

## Output

One short section: root cause in one sentence, the fix, and the evidence (log line, local reproduction, gate counts). If it is a flake and not a defect, say which kind and why, and do not "fix" it.
