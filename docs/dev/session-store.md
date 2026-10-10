# Session store

`packages/agent/src/session-store.ts` keeps one session in one append-only JSONL file. Every entry points to its parent by id, so branches and forks are part of the file format and not a feature added later. The file is the only record that survives restarts, model changes, and a resume (`packages/agent/src/session-store.ts:304`).

## Purpose

- Keep the conversation as a tree of entries with a stable file format (`SessionEntry`, `packages/agent/src/session-store.ts:18`).
- Give the rest of the app a linear view from the header to the active leaf (`linearEntries`, `packages/agent/src/session-store.ts:250`).
- Let a caller branch from an old entry and describe the tree for `/tree` (`branch`, `packages/agent/src/session-store.ts:378`, `describeTree`, `packages/agent/src/session-store.ts:399`).
- Record each compaction in the file itself (`appendCompaction`, `packages/agent/src/session-store.ts:341`).

## Behavior

### Files and ids

- A session file lives under `~/.labunbun/projects`, in a directory named after the session cwd. `sanitizeCwd` replaces `:`, `\`, and `/` with `-` (`packages/agent/src/session-store.ts:87`, `packages/agent/src/session-store.ts:91`).
- `startNew` writes the header entry, with `version: 1`, the session id, the cwd, and the creation time (`packages/agent/src/session-store.ts:142`).
- The session id is an ISO date with `:` and `.` replaced by `-`, an underscore, and the first eight characters of `crypto.randomUUID()` (`packages/agent/src/session-store.ts:143`).
- `newEntryId` joins three parts: `Date.now()` in base 36, a counter that wraps at `0xffff` with a four-digit pad, and four random characters (`packages/agent/src/session-store.ts:102`).
- Entry types are `header`, `message`, `compaction`, and `custom` (`packages/agent/src/session-store.ts:18`).

### Appends

- `append` pushes the entry into the in-memory array, moves the leaf, drops the cached walk, and writes one JSON line to the file (`packages/agent/src/session-store.ts:215`).
- `appendMessage` and `appendCustom` hang the new entry under the current leaf, or under the last entry when no leaf is set (`packages/agent/src/session-store.ts:223`, `packages/agent/src/session-store.ts:235`).
- Only this class appends. The cached walk drops when those appends write, not because of a watch on the array (`packages/agent/src/session-store.ts:112`).

### Load

- `load` reads the file one line at a time. A line that is not JSON, or that is not a shaped entry, is skipped and counted in `skippedLines` (`packages/agent/src/session-store.ts:161`).
- `isEntryShaped` accepts only an object with a non-empty string `id` and a known type. `{"foo": 1}` parses and is not an entry. An entry type from a newer build is one this build cannot interpret (`packages/agent/src/session-store.ts:453`).
- `skippedLines` is not a diagnostic counter. A session that came back shorter than it was written is something the person who resumes it must hear about. This count is where the lost messages get counted (`packages/agent/src/session-store.ts:133`).
- `truncated` is true when the file was longer than the caller let the store read (`packages/agent/src/session-store.ts:138`).
- With `maxBytes`, the store reads only the head of the file, through `readHead` (`packages/agent/src/session-store.ts:164`, `packages/agent/src/session-store.ts:436`). `listSessions` uses this for labels, not for a conversation.

### The linear view

`linearEntries` walks from the active leaf to the header by `parentId`, then returns the chain in conversation order (`packages/agent/src/session-store.ts:250`).

- The leaf is the remembered leaf id, or the last entry in the file.
- `parentId` can name an entry that is not there. A damaged line takes its entry's id with it, and the child that pointed at it is orphaned. The fallback is the entry written just before the orphan. Entries are appended in the order they happened, so the line above a lost entry is the message that came before it. Without that fallback, one bad line hides every older message, which is the largest part of the conversation.
- A visited set stops the walk when it meets an id twice. A file with hand-edited links can point forward, or in a circle. A walk that trusts such a file never returns.
- The answer is the same for the same tree. The tree only changes where this store changes it: `append`, `branch`, and the leaf recomputation after a load. The walk is cached until one of them runs (`packages/agent/src/session-store.ts:119`).
- The store shares the array and does not copy it. `readonly` is the whole of the contract. A caller that reorders the array corrupts every later reader (`packages/agent/src/session-store.ts:250`).
- `messages()` returns the message entries of this view (`packages/agent/src/session-store.ts:296`).
- `describeTree` writes one line per entry for `/tree`, with `*` on the active path. The header is skipped. A user message shows a 60-character preview or `[blocks]`. An assistant message shows its text blocks joined. Anything else shows the tool name (`packages/agent/src/session-store.ts:399`, `packages/agent/src/session-store.ts:460`).

### Compaction

- A compaction entry records the boundary message, the summary, and the `preservedFiles` list. It also records the token counts before and after, the model that wrote the summary, and the trigger (`CompactionRecord`, `packages/agent/src/session-store.ts:56`).
- The boundary message lives on the compaction entry itself, not as a separate message entry. The store writes the boundary and the record of it together. A torn pair resumes from a summary whose context is already gone (`packages/agent/src/session-store.ts:35`).
- `appendCompaction` turns the active chain into `[root, boundary, ..suffix]`. The boundary hangs off the chain root, not off the last replaced entry. It stands in place of everything above it, so the old entries stay off the chain (`packages/agent/src/session-store.ts:341`).
- The replaced entries stay in the file as an abandoned branch. History is never rewritten, and `/tree` can still branch back into it.
- `appendCompaction` returns null when the entries at the end are not the messages to keep. The store must not guess at a live array that diverged from it.
- `sameMessage` accepts identity, and one exception: a tool result that the cheap rung rewrote. The live list then carries a preview where the file carries the full text. The call it came from, `toolCallId`, `toolName`, and `isError`, says that both messages are the same (`packages/agent/src/session-store.ts:75`).
- `compactions()` returns the compactions on the active path, oldest first (`packages/agent/src/session-store.ts:304`).
- `compactionCount()` counts compaction entries in the whole file (`packages/agent/src/session-store.ts:312`).
- `contextMessages()` returns what the model is sent on a resume: the boundary of the last compaction, then everything after it (`packages/agent/src/session-store.ts:320`).

### Branching

- `branch` moves the active leaf to an entry that is already in the file, so the next append becomes a child of it. The id can be a prefix. A header id is refused (`packages/agent/src/session-store.ts:378`).
- Entries on the abandoned branch stay in the file. History is never rewritten.
- `branchPoints` returns the entries with more than one child (`packages/agent/src/session-store.ts:389`).

## Why it is like this

- **Why load skips bad lines.** The file is append-only, so a damaged line is a damaged entry. A stop at that line throws away every message written after it. The count stays, so the caller can say what is lost (`packages/agent/src/session-store.ts:161`).
- **Why a capped read drops its last fragment.** A byte prefix ends in the middle of a line, and that fragment is not damage. It is where the caller's cap fell. The store drops it at the last newline, so `skippedLines` counts only damage that was found (`packages/agent/src/session-store.ts:169`).
- **Why `truncated` reads the file size and not the read.** A file that is exactly the cap was read whole (`packages/agent/src/session-store.ts:166`).
- **Why the orphan fallback is the line above.** Entries are appended in the order they happened. The line above a lost entry is the message that came before it. Without the fallback, one bad line hides the older part of the conversation. That part is the largest part (`packages/agent/src/session-store.ts:250`).
- **Why the store caches the walk.** The expensive caller is not `/tree` or `/rewind`, which a person types, but the event path: `readTaskSnapshot` walks the whole chain on every task change. On a 20,000-entry session that walk cost 32 ms. The cached array costs nothing by comparison (`packages/agent/src/session-store.ts:119`).
- **Why the walk is iterative.** The old walk was worse than linear. Four times the entries was thirteen times the cost. Every step moved the whole chain with `unshift` and paid for a map of every entry. The cost was felt exactly where it hurts most. It lands at the end of a long session, on the path that saves the plan, on every task change (`packages/agent/src/session-store.ts:268`).
- **Why the chain is built leaf-ward and reversed once.** `unshift` on every step moves the whole chain each time, which is the other half of why the old walk was quadratic (`packages/agent/src/session-store.ts:268`).
- **Why the id map uses a loop, not `Map` over a mapped array.** The short form builds a two-element array per entry and throws it away. At 20,000 entries that was a fifth of what the map cost (`packages/agent/src/session-store.ts:254`).
- **Why the position map is lazy.** Only the fallback path needs an entry's position, and it runs when a link is broken. That is rare enough that the second map is built on the walk that needs it, not on every walk (`packages/agent/src/session-store.ts:260`).
- **Why the store does not freeze the walk.** A freeze says "do not touch" more loudly than `readonly`. It measured 5.8 ms for the privilege on this walk, which is more than the walk itself (`packages/agent/src/session-store.ts:250`).
- **Why the fallback uses `index` with an explicit type.** The walk closes a loop over this variable. The narrowed type of `cursor` on the next line is computed from the assignment that uses `index`. An inferred `index` asks for both types at once (`packages/agent/src/session-store.ts:278`).
- **Why the store reads compactions back from the file.** The counter that holds them in memory, `CompactionManager`, is rebuilt on every `/model` and `/resume`. The file survives those (`packages/agent/src/session-store.ts:304`).
- **Why `compactions()` and `compactionCount()` answer different questions.** `compactions()` answers "what shaped the conversation in hand". Each compaction re-roots the chain onto its own boundary. The entries left by earlier passes sit on branches the current one does not run through. "On the active path" is therefore at most one. `compactionCount()` answers how much of this conversation the summaries rewrote, which decides whether another summary is still worth its cost. That is a property of the session, not of the leaf it happens to be on. A resumed session reads its own history back, so the answer does not restart when a new manager comes up (`packages/agent/src/session-store.ts:312`).
- **Why `contextMessages()` is not `messages()`.** A compaction leaves the transcript it replaced in the file. That is the audit trail. A replay of it resurrects the very context the summary was written to replace, at full price, and then summarizes it again (`packages/agent/src/session-store.ts:320`).
- **Why the boundary hangs off the root.** A boundary that hung off the last replaced entry leaves those entries on the chain. Then `linearEntries()` and every view built on it, `/tree` included, claim the session still holds the transcript it just summarized away (`packages/agent/src/session-store.ts:355`).
- **Why the trigger is recorded, not inferred.** A session read back weeks later has no other way to say why the transcript changed shape (`packages/agent/src/session-store.ts:53`). The three values: `auto` is the threshold. `manual` is `/compact`. `overflow` is a request the provider already refused for size. In that case the estimate is known to be wrong, and "not yet" is not an available answer.
- **Why a comment rewrite of a tool result does not block a compaction.** A text compare refuses the record exactly when the session ran long enough to trim. A refusal is not free: the file keeps the transcript that the summary just replaced. A resume then replays it and pays for the same summary twice (`packages/agent/src/session-store.ts:75`).

## Known traps

- `slice(-0)` is `slice(0)`. An empty compaction suffix needs its own path, or the check compares the whole message list (`packages/agent/src/session-store.ts:344`).
- `branch` clears the cached walk even when the branch itself writes nothing. A branch that wrote nothing is exactly the case a stale cached walk gets wrong (`packages/agent/src/session-store.ts:382`).
- `skippedLines` must stay damage-only. A capped read that reported its own byte fragment as a loss makes the count meaningless at the moment a caller reads it (`packages/agent/src/session-store.ts:169`).
- `readHead` decodes the first `maxBytes` bytes as UTF-8. A cap that falls inside a character gives a replacement character, which the same line skip then handles (`packages/agent/src/session-store.ts:436`).
- An entry with no id joins the chain as a node that nothing can point at. That is why `isEntryShaped` checks the id and not only the type (`packages/agent/src/session-store.ts:186`, `packages/agent/src/session-store.ts:453`).
- The identity fast path in `sameMessage` compares object references. A user or assistant message that is not the same object means the live array diverged, and the caller gets null (`packages/agent/src/session-store.ts:75`).
- Only `append`, `branch`, and `#recomputeLeaf` may change the tree. Any other change to `entries` leaves the cached walk stale, and the store keeps the wrong chain (`packages/agent/src/session-store.ts:112`).

## Source map

| File | Role |
| --- | --- |
| `packages/agent/src/session-store.ts` | The session store. Entry format, append, load, linear view, compaction records, branch points, and `/tree` output all live here. |
