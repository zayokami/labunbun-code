---
name: verify
description: Prove a change works by building and running it — runs this repo's three gates (bun test, tsc, biome) plus a real-surface exercise, and refuses to accept a check that only parses as proof. Use before committing any change, and before claiming a fix works.
---

Verify a change on this repository. The claim this skill exists to prevent: reporting work as done because the compiler was happy.

## The three gates

`bun` is not on PATH on this machine — call `C:/Users/LENGION/.bun/bin/bun.exe` directly.

1. `bun x tsc -p tsconfig.check.json` — tsc is an independent gate. Green tests do not imply it (it covers files no test imports), and it does not cover `packages/coding-agent/bin/`.
2. `bun test` — the whole suite when the change touches the agent loop, the pipeline, or `packages/ai`; the single test file plus its neighbours otherwise. The suite is zero-network by design; a test that needs a key is broken.
3. `bun x biome check .` — on Windows, run it on the changed files only. Repo-wide biome is permanently red here from CRLF line endings, and that red predates most changes; treat a CRLF finding in a file you did not touch as noise, and never "fix" it by converting line endings.

Build gate when the binary can change: `bun run bin:build` → `dist/labunbun-x64.exe`.

## The real surface

A gate that only proves the code parses is not proof:

- Model/provider/wire changes: exercise through the faux provider (`packages/ai/src/providers/faux.ts`), which scripts model behaviour with no network. Real paid models are never called in this repo.
- CLI behaviour: run the real binary as a subprocess with a temporary `HOME`/`USERPROFILE` and a fake key pointing at a local `Bun.serve` stub — never the real home.
- Interactive behaviour: `ink-testing-library` with `connectSessionToStore`, following `packages/tui/test/repl-interrupt.test.tsx`.
- A `-p` run and an interactive run must behave the same; check both when the change is in shared code.

## Rules

- Report the gate counts exactly (pass / expect / files), not "all green".
- If a real check cannot run, name the one you did not run and why, in the same breath as the claim.
- Two known-fragile spots, so a red is not misread: `repl-interrupt.test.tsx` has a 250 ms debounce that can miss under full load (it passes alone), and a promise that never settles does not die at the per-test timeout — it spins the whole run. When either happens, re-run the file alone before investigating code.
- The numbers belong in the commit message; that is what makes a verification claim checkable later.
