# Session store

`packages/agent/src/session-store.ts` keeps one session in one append-only JSONL file. Every entry points to its parent by id, so branches and forks are part of the file format and not a feature added later. The file is the only record that survives a restart, a model change, and a resume (`packages/agent/src/session-store.ts:193`).

## Purpose

- Keep the conversation as a tree of entries with a stable file format (`SessionEntry`, `packages/agent/src/session-store.ts:18`).
- Give the rest of the app a linear view from the header to the active leaf (`linearEntries`, `packages/agent/src/session-store.ts:320`).
- Let a caller branch from an old entry and describe the tree for `/tree` (`branch`, `packages/agent/src/session-store.ts:448`, `describeTree`, `packages/agent/src/session-store.ts:469`).
- Record each compaction in the file itself (`appendCompaction`, `packages/agent/src/session-store.ts:411`).

## Behavior

### Files and ids

- A session file lives under `~/.labunbun/projects`, in a directory named after the session cwd. `sanitizeCwd` replaces `:`, `\`, and `/` with `-` (`packages/agent/src/session-store.ts:99`, `packages/agent/src/session-store.ts:103`).
- `startNew` writes the header entry, with `version: 1`, the session id, the cwd, and the creation time (`packages/agent/src/session-store.ts:174`).
- The session id is an ISO date with `:` and `.` replaced by `-`, an underscore, and the first eight characters of `crypto.randomUUID()` (`packages/agent/src/session-store.ts:175`).
- `newEntryId` joins three parts: `Date.now()` in base 36, a counter that wraps at `0xffff` with a four-digit pad, and four random characters (`packages/agent/src/session-store.ts:114`).
- Entry types are `header`, `message`, `compaction`, and `custom` (`packages/agent/src/session-store.ts:18`).
- The `/rename` title is not an entry. It lives in `<session>.jsonl.title.json` next to the session file. The payload is `{ version: 1, title, updatedAt }`. A missing, damaged, or future-shaped sidecar means "untitled". The writer uses a temporary file and a rename, so a kill leaves the old title or the new one. The name does not end in `.jsonl`, so the session listing never returns it as a session (`packages/coding-agent/src/session-title.ts:19`, `packages/coding-agent/src/session-title.ts:76`).

Two `custom` kinds carry state rather than transcript. Kind `tasks` holds the task board (`packages/coding-agent/src/task-snapshot.ts:18`), and kind `plan` holds the last plan with its steps, approval flag, and timestamp (`packages/coding-agent/src/plan-snapshot.ts:18`, `plan-snapshot.ts:36-45`). Both read the newest *valid* entry on the active chain, walking backwards past anything else (`task-snapshot.ts:74-82`, `plan-snapshot.ts:77-86`), and both write best effort (`task-snapshot.ts:91-97`, `plan-snapshot.ts:57-66`). A compaction re-roots the chain above them, so the hosts re-save after a pass ends: the board at `done` (`packages/coding-agent/src/interactive.ts:995`, `packages/coding-agent/src/headless.ts:757`, `packages/coding-agent/src/acp.ts:1191`), and the plan through `reanchorPlanSnapshot` (`interactive.ts:1003`, `plan-snapshot.ts:96-102`). Since `c35f405`, the phase listener may return a promise and the manager awaits it, so these saves finish before the pass returns (`packages/coding-agent/src/compaction-wiring.ts:355-360`, `packages/agent/src/compaction.ts:1167`).

### Appends

- `append` writes one JSON line to the file first, then pushes the entry, moves the leaf, and drops the cached walk (`packages/agent/src/session-store.ts:269`). A failed write leaves the in-memory tree exactly where the file is (`:271-291`).
- The directory is created only when it is actually missing. An `ENOENT` from the first append creates it and retries once; every other error travels before memory changes (`packages/agent/src/session-store.ts:276-286`).
- `appendMessage` and `appendCustom` hang the new entry under the current leaf, or under the last entry when there is no leaf (`packages/agent/src/session-store.ts:293`, `packages/agent/src/session-store.ts:305`).
- Only this class appends. The cached walk drops when those appends write, not because of a watch on the array (`packages/agent/src/session-store.ts:144`).

### Load

- `load` reads the file one line at a time. It skips a line that is not JSON, or that is not a shaped entry, and counts it in `skippedLines` (`packages/agent/src/session-store.ts:193`).
- A path that is absent, or that vanishes between the existence check and the read (`ENOENT`, `ENOTDIR`), loads as an empty store. Every other read failure throws `SessionReadError` with the path and the cause (`packages/agent/src/session-store.ts:218-226`).
- `isEntryShaped` accepts only an object with a non-empty string `id` and a known type. `{"foo": 1}` parses and is not an entry. An entry type from a newer build is one this build cannot interpret (`packages/agent/src/session-store.ts:546`).
- `skippedLines` is not a diagnostic counter. A session that came back shorter than the store wrote it is something the person who resumes it must hear about. This count is where the lost messages get counted (`packages/agent/src/session-store.ts:165`).
- `truncated` is true when the file was longer than the caller let the store read (`packages/agent/src/session-store.ts:170`).
- With `maxBytes`, the store reads only the head of the file, through `readHead` (`packages/agent/src/session-store.ts:197`, `packages/agent/src/session-store.ts:506`). `listSessions` uses this for labels, not for a conversation.
- `SessionStore.listSessions` keeps a file it cannot stat as a row with `mtimeMs: 0` and reports it through the optional `onWarning` (`packages/agent/src/session-store.ts:245-254`). A directory it cannot list still returns the rows it has and writes the reason to stderr (`:256-263`).

### The linear view

`linearEntries` walks from the active leaf to the header by `parentId`, then returns the chain in conversation order (`packages/agent/src/session-store.ts:320`).

- The leaf is the remembered leaf id, or the last entry in the file.
- `parentId` can name an entry that is not there. A damaged line takes its entry's id with it, and the child that pointed at it becomes an orphan. The fallback is the entry written just before the orphan. The store appends entries in the order they happened, so the line above a lost entry is the message that came before it. Without that fallback, one bad line hides every older message, which is the largest part of the conversation.
- A visited set stops the walk when it meets an id twice. A file with hand-edited links can point forward, or in a circle. A walk that trusts such a file never returns.
- The answer is the same for the same tree. The tree only changes where this store changes it: `append`, `branch`, and the leaf recomputation after a load. The store caches the walk until one of them runs (`packages/agent/src/session-store.ts:151`).
- The store shares the array and does not copy it. `readonly` is the whole of the contract. A caller that reorders the array corrupts every later reader (`packages/agent/src/session-store.ts:320`).
- `messages()` returns the message entries of this view (`packages/agent/src/session-store.ts:366`).
- `describeTree` writes one line per entry for `/tree`, with `*` on the active path. It skips the header. A user message shows a 60-character preview or `[blocks]`. An assistant message shows its text blocks joined. Anything else shows the tool name (`packages/agent/src/session-store.ts:469`, `packages/agent/src/session-store.ts:553`).

### Compaction

- A compaction entry records the boundary message, the summary, and the `preservedFiles` list. A preserved file is a path with a hash of the file's content at that moment, so a later pass can tell a file the summary still describes from one that has changed. The hash is absent when the file could not be read (`PreservedFile`, `packages/agent/src/session-store.ts:79`). The entry also records the token counts before and after, the model that wrote the summary, and the trigger (`CompactionRecord`, `packages/agent/src/session-store.ts:56`).
- The boundary message lives on the compaction entry itself, not as a separate message entry. The store writes the boundary and the record of it together. A torn pair resumes from a summary whose context is already gone (`packages/agent/src/session-store.ts:35`).
- `appendCompaction` turns the active chain into `[root, boundary, ..suffix]`. The boundary hangs off the chain root, not off the last replaced entry. It stands in place of everything above it, so the old entries stay off the chain (`packages/agent/src/session-store.ts:411`).
- The replaced entries stay in the file as an abandoned branch. History is never rewritten, and `/tree` can still branch back into it.
- `appendCompaction` returns null when the entries at the end are not the messages to keep. The store must not guess at a live array that diverged from it.
- `sameMessage` accepts identity, and one exception: a tool result that the cheap pass rewrote. The live list then carries a preview where the file carries the full text. The call it came from, `toolCallId`, `toolName`, and `isError`, says that both messages are the same (`packages/agent/src/session-store.ts:86-96`). The live preview may open with the spill header `[full output: N chars → path]`; the file still holds the full original text (`packages/agent/src/compaction.ts:1484-1497`, `packages/agent/src/output-limits.ts:36-43`).
- `compactions()` returns the compactions on the active path, oldest first (`packages/agent/src/session-store.ts:374`).
- `compactionCount()` counts compaction entries in the whole file (`packages/agent/src/session-store.ts:382`).
- `contextMessages()` returns what the caller sends to the model on a resume: the boundary of the last compaction, then everything after it (`packages/agent/src/session-store.ts:390`).

### Branching

- `branch` moves the active leaf to an entry that is already in the file, so the next append becomes a child of it. The id can be a prefix. `branch` refuses a header id (`packages/agent/src/session-store.ts:448`).
- Entries on the abandoned branch stay in the file. History is never rewritten.
- `branchPoints` returns the entries with more than one child (`packages/agent/src/session-store.ts:459`).

## Why it is like this

- **Why load skips bad lines.** The file is append-only, so a damaged line is a damaged entry. A stop at that line throws away every message written after it. The count stays, so the caller can say what is lost (`packages/agent/src/session-store.ts:193`).
- **Why append is write-first.** A write that fails after the entry joined the array leaves the session holding a message no resume can find, and the next turn sends it to the provider. Writing first turns a full disk into a failed append, which the caller can report, rather than a tree that disagrees with its own file (`packages/agent/src/session-store.ts:271-274`).
- **Why a missing session and an unreadable one are different answers.** A file that is not there is an empty session. A file that is there and cannot be read is something the user can see in the listing, and "no such session" would be a lie about it. The caller gets `SessionReadError` with the reason and decides between recovering and stopping (`packages/agent/src/session-store.ts:218-226`).
- **Why a capped read drops its last fragment.** A byte prefix ends in the middle of a line, and that fragment is not damage. It is where the caller's cap fell. The store drops it at the last newline, so `skippedLines` counts only damage that the store found (`packages/agent/src/session-store.ts:201-206`).
- **Why `truncated` reads the file size and not the read.** The store reads a file that is exactly the cap in full (`packages/agent/src/session-store.ts:199-200`).
- **Why the orphan fallback is the line above.** The store appends entries in the order they happened. The line above a lost entry is the message that came before it. Without the fallback, one bad line hides the older part of the conversation. That part is the largest part (`packages/agent/src/session-store.ts:320`).
- **Why the store caches the walk.** The expensive caller is not `/tree` or `/rewind`, which a person types, but the event path: `readTaskSnapshot` walks the whole chain on every task change. On a 20,000-entry session that walk cost 32 ms. The cached array costs nothing by comparison (`packages/agent/src/session-store.ts:151`).
- **Why the walk is iterative.** The old walk was worse than linear. Four times the entries was thirteen times the cost. Every step moved the whole chain with `unshift` and paid for a map of every entry. The cost was felt exactly where it hurts most. It lands at the end of a long session, on the path that saves the plan, on every task change (`packages/agent/src/session-store.ts:338`).
- **Why the chain is built leaf-ward and reversed once.** `unshift` on every step moves the whole chain each time, which is the other half of why the old walk was quadratic (`packages/agent/src/session-store.ts:338`).
- **Why the id map uses a loop, not `Map` over a mapped array.** The short form builds a two-element array per entry and throws it away. At 20,000 entries that was a fifth of what the map cost (`packages/agent/src/session-store.ts:324`).
- **Why the position map is lazy.** Only the fallback path needs an entry's position, and it runs when a link is broken. That is rare enough that the store builds the second map on the walk that needs it, not on every walk (`packages/agent/src/session-store.ts:330`).
- **Why the store does not freeze the walk.** A freeze says "do not touch" more loudly than `readonly`. It measured 5.8 ms for the privilege on this walk, which is more than the walk itself (`packages/agent/src/session-store.ts:320`).
- **Why the fallback uses `index` with an explicit type.** The walk closes a loop over this variable. The narrowed type of `cursor` on the next line comes from the assignment that uses `index`. An inferred `index` asks for both types at once (`packages/agent/src/session-store.ts:348`).
- **Why the store reads compactions back from the file.** The counter that holds them in memory, `CompactionManager`, is rebuilt on every `/model` and `/resume`. The file survives those (`packages/agent/src/session-store.ts:374`).
- **Why `compactions()` and `compactionCount()` answer different questions.** `compactions()` answers "what shaped the conversation in hand". Each compaction re-roots the chain onto its own boundary. The entries left by earlier passes sit on branches the current one does not run through. "On the active path" is therefore at most one. `compactionCount()` answers how much of this conversation the summaries rewrote, which decides whether to spend on another summary. That is a property of the session, not of the leaf it happens to be on. A resumed session reads its own history back, so the answer does not restart when a new manager comes up (`packages/agent/src/session-store.ts:382`).
- **Why `contextMessages()` is not `messages()`.** A compaction leaves the transcript it replaced in the file. That is the audit trail. A replay of it resurrects the very context the summary replaced, at full price, and then summarizes it again (`packages/agent/src/session-store.ts:390`).
- **Why the boundary hangs off the root.** If a boundary hangs off the last replaced entry, those entries stay on the chain. Then `linearEntries()` and every view built on it, `/tree` included, claim the session still holds the transcript it just summarized away (`packages/agent/src/session-store.ts:425`).
- **Why the trigger is recorded, not inferred.** A session read back weeks later has no other way to say why the transcript changed shape (`packages/agent/src/session-store.ts:53`). The three values: `auto` is the threshold. `manual` is `/compact`. `overflow` is a request the provider already refused for size. In that case the session knows the estimate is wrong, and "not yet" is not an available answer.
- **Why a comment rewrite of a tool result does not block a compaction.** A text compare refuses the record exactly when the session is long enough to trim. A refusal is not free: the file keeps the transcript that the summary just replaced. A resume then replays it and pays for the same summary twice (`packages/agent/src/session-store.ts:87`).
- **Why the title is a sidecar.** `listSessions` builds its rows from the head of each transcript (`packages/coding-agent/src/session-resume.ts:47`), so a `custom` entry at the tail would be invisible to the picker. The transcript is append-only, so a rename cannot edit an earlier line. A sidecar is small, optional, and replaceable: damage costs the title, not the session (`packages/coding-agent/src/session-title.ts:1-11`).

## Known traps

- `slice(-0)` is `slice(0)`. A compaction suffix that is empty needs its own path, or the check compares the whole message list (`packages/agent/src/session-store.ts:414`).
- `branch` clears the cached walk even when the branch itself writes nothing. A branch that wrote nothing is exactly the case a stale cached walk gets wrong (`packages/agent/src/session-store.ts:452`).
- `skippedLines` must stay damage-only. A capped read that reported its own byte fragment as a loss makes the count meaningless at the moment a caller reads it (`packages/agent/src/session-store.ts:201-206`).
- `readHead` decodes the first `maxBytes` bytes as UTF-8. A cap that falls inside a character gives a replacement character, which the same line skip then handles (`packages/agent/src/session-store.ts:506`).
- An entry with no id joins the chain as a node that nothing can point at. That is why `isEntryShaped` checks the id and not only the type (`packages/agent/src/session-store.ts:534`, `packages/agent/src/session-store.ts:546`).
- The identity fast path in `sameMessage` compares object references. A user or assistant message that is not the same object means the live array diverged, and the caller gets null (`packages/agent/src/session-store.ts:87`).
- Only `append`, `branch`, and `#recomputeLeaf` may change the tree. Any other change to `entries` leaves the cached walk stale, and the store keeps the wrong chain (`packages/agent/src/session-store.ts:144`).

## Source map

| File | Role |
| --- | --- |
| `packages/agent/src/session-store.ts` | The session store. Entry format, append, load, linear view, compaction records, branch points, and `/tree` output all live here. |
