# Crash consistency

What survives a killed process, and what does not. Three answers exist in this tree, and which one a file gets is a decision worth being able to look up: the file is *replaced* by a rename, *appended* to and read back generously, or written in place and lost when the write is cut short.

The question behind the split is what a torn file costs. A file that is read back as one answer — a settings file, a ledger of approvals — turns a torn write into no answer at all, because a half-written object does not parse. A file that is read back entry by entry turns a torn write into one lost entry. The first kind is replaced; the second kind is appended to.

## Files that are replaced

Each of these writes its bytes to `<path>.tmp` and renames that file over the target, removing the temp file when the write or the rename fails, so an interrupted write leaves the previous complete file rather than a truncated one.

| File | Writer | What one torn write would cost |
| --- | --- | --- |
| `~/.labunbun/settings.json` | `writeUserSettings` (`packages/coding-agent/src/user-settings.ts:84`) | every later read-merge-write refuses until the file is repaired by hand (`packages/coding-agent/src/user-settings.ts:67`), and the user tier behind it is dropped for that start |
| `<home>/.labunbun/projects/<slug>/costs.json` | `saveCostState` (`packages/coding-agent/src/cost-tracker.ts:208`) | the project's whole cost history, which `/cost` then reports as zero (`loadCostState`, `packages/coding-agent/src/cost-tracker.ts:232`) |
| the subscription credential file, when the OS keychain is not the store | `writeFile` (`packages/coding-agent/src/chatgpt-auth.ts:87`, `packages/coding-agent/src/claude-auth.ts:87`) | signed out, and the user signs in again |
| `<home>/.labunbun/projects/<slug>/mcp-approved.json` | `writeJsonAtomic` (`packages/mcp/src/client.ts:880`) | every project server the user ever approved is asked about again (`loadApprovedMcpServers`, `packages/mcp/src/client.ts:856`) |
| `<home>/.labunbun/projects/<slug>/trusted-definitions.json` | `writeLedgerAtomic` (`packages/coding-agent/src/project-trust.ts:155`) | both tiers of project definitions are withheld again (`loadTrustedDefinitionKinds`, `packages/coding-agent/src/project-trust.ts:53`) |

Two details of the shape:

- The temp name is `<path>.tmp`, next to the file it replaces, so the rename stays inside one filesystem.
- The credential stores re-assert `0o600` on the temp file (`packages/coding-agent/src/chatgpt-auth.ts:90`), and the two stores that had a mode worth keeping re-apply it (`packages/coding-agent/src/user-settings.ts:92`, `packages/coding-agent/src/cost-tracker.ts:220`). The two ledgers added with this note (`packages/mcp/src/client.ts:880`, `packages/coding-agent/src/project-trust.ts:155`) do not copy a mode, which matches what they did before: nothing ever tightened it, and the file lands with the default mode of the process either way.

## Files that are appended to

- The session file is the biggest of these: `append` writes one JSON line with `appendFileSync` (`packages/agent/src/session-store.ts:235`), and `load` reads the file line by line, dropping a line that is not JSON or not a shaped entry and counting it in `skippedLines` (`packages/agent/src/session-store.ts:173`, `packages/agent/src/session-store.ts:145`). A kill during an append costs the line being written; the entries before it are on disk and still parse.
- Three things live in the session file as `custom` entries, and inherit that behavior: the task-list snapshots (`saveTasks`, `packages/coding-agent/src/task-snapshot.ts:44`), the background-shell ledger (`attachShellLedger`, `packages/coding-agent/src/shell-ledger.ts:171`), and the file checkpoints `/rewind` restores from (`packages/coding-agent/src/checkpoint-log.ts:322`, called from `packages/coding-agent/src/interactive.ts:1300-1303`). The task snapshot is written as a whole list rather than as edits, so the previous snapshot is the fallback when the newest one is lost.
- Prompt history is appended the same way, one JSONL line per prompt, and a failed append is swallowed (`packages/coding-agent/src/history.ts:26`). The `MEMORY.md` note appended after a session is the same shape (`appendMemoryNote`, `packages/coding-agent/src/interactive.ts:2341`).
- A background shell's output log is appended to, chunk by chunk (`packages/tools/src/background.ts:130`). It is a stream, not a record: atomic replacement is not available for it, and a kill leaves the log ending where the shell ended.

## No fsync anywhere

No file in `packages/*/src` calls `fsync`. Every claim above is about a process dying — a killed or crashed process — and not about the machine losing power.

- On a running system, `rename` is atomic with respect to other processes: a reader opens the old file or the new one, never a mixture.
- Nothing here waits for the bytes to reach stable storage. On a power loss the replacement file itself can be missing, empty, or holding its previous contents, and the `.tmp` file can still be there. Ordering between the two file names is not guaranteed either, because the directory holding them is never synced.

So the atomic set is a guarantee about process death, which is the failure the app actually sees, and not a durability guarantee. Making it one would mean an `fsync` on the temp file before the rename and on the directory after it, which is a cost this code has not taken on.

## Known gaps

- **Two processes on one session file.** Nothing locks the file. A second `--resume` of the same session in another terminal appends to the same path, and an in-app `/resume` of a session another process is writing has the same shape. `appendFileSync` is atomic per line, so both writers' lines survive and parse, but the tree they form is interleaved and the leaf both processes remember is their own (`packages/agent/src/session-store.ts:237`). This is documented rather than fixed: a lock would have to survive a kill to be worth anything, and a stale lock that refuses a legitimate resume is worse than an interleaved one.
- **Writes still made in place.** The beetle counters (`writeBeetleState`, `packages/coding-agent/src/beetle-state.ts:123`), a migration's output files (`packages/coding-agent/src/migrate.ts:1259`), `/export` (`packages/coding-agent/src/interactive.ts:3387`), and the `/rewind` restore of a file's content (`packages/coding-agent/src/interactive.ts:3715`) truncate their target and write. None of them is a store the app reads back as its own state before the user looks at it: they are user-visible output, a per-home counter, or a restore the user asked for.

## Tests that hold these claims

- `packages/agent/test/crash-consistency.test.ts:139` kills an appending child with `SIGKILL` and asserts the file lost at most its last line, the chain still walks to the header, and no second file is beside it. `packages/agent/test/crash-consistency.test.ts:113` pins the torn tail directly, because a real kill does not reliably tear one.
- `packages/mcp/test/approval-atomic.test.ts:91` and `packages/coding-agent/test/project-trust-atomic.test.ts:88` run one approval in a child whose `writeFileSync` fails after the bytes land, and assert the previous file is intact with no temp file beside it.
- `packages/coding-agent/test/cost-tracker-atomic.test.ts:124` and `packages/coding-agent/test/user-settings-atomic.test.ts:88` hold the same shape for the cost ledger and the settings file.
- `packages/agent/test/session-store.test.ts:68` covers the other side: a line damaged in the middle of a session file costs its own entry and nothing else.
