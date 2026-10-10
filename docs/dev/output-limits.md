# Output limits

`packages/agent/src/output-limits.ts` and `packages/tools/src/output-capture.ts` bound the text that tool output may add to the conversation. A turn gets too large in two ways. One huge result meets the tool's own `maxResultSizeChars`. Many reasonable results in one round meet the round budget (`packages/agent/src/output-limits.ts:1`).

## Purpose

- Bound one tool result by its tool's own limit, and one whole round of results by `MAX_ROUND_RESULT_CHARS` (`packages/agent/src/output-limits.ts:7`).
- Keep a floor for every result in an over-budget round: `MIN_ROUND_RESULT_CHARS` (`packages/agent/src/output-limits.ts:14`).
- Bound a stream that has not finished yet, before the pipeline sees it (`createStreamCapture`, `packages/tools/src/output-capture.ts:46`).
- Keep one cumulative count of lost text across two cuts: the tool's limit, then the round budget (`packages/agent/src/output-limits.ts:1`).

## Behavior

### The two limits

- `MAX_ROUND_RESULT_CHARS` is 200,000 characters of tool-result text per round. Ten results of 25,000 characters are each well inside their own limit and 250,000 together. One turn's tool output takes a quarter of a large context window (`packages/agent/src/output-limits.ts:7`).
- `MIN_ROUND_RESULT_CHARS` is two thousand characters. Every result in an over-budget round keeps this much, no matter how many results there are or how the budget divides. A result the model cannot see at all is a result it has to re-run the tool for (`packages/agent/src/output-limits.ts:14`).
- A cut is lossy, so both limits cut through `cutText`. It keeps the two ends of the output: what the tool ran, and where it ended up (`packages/agent/src/output-limits.ts:76`).

### What a cut keeps

- The middle goes, not the end. The head says what the tool ran and shows the first lines of the file the model edits. The tail says what the build said about it and which test failed. A reader who has only one of the two cannot tell which case they are in. The notice stands at the cut between them (`packages/agent/src/output-limits.ts:76`).
- `cutText` writes a result out in full on the first cut, when it has a spill path. The path goes on the first line. It is the only part of a cut result that the rest cannot rebuild. It must survive the second cut that the round budget may still apply (`packages/agent/src/output-limits.ts:76`).
- The notice is cumulative for the same reason. The reader of a twice-cut result sees the same number as the reader of a once-cut one (`packages/agent/src/output-limits.ts:76`).
- The pointer line and the notice are both charged on top of the text budget, not out of it. A notice that takes part of the text budget makes the lost count depend on how the notice itself renders. The same output then reports a different truncation at two budgets (`packages/agent/src/output-limits.ts:94`).
- `keep` is `limit` minus the pointer length. The head and the tail split the kept text evenly. The odd character goes to the head. The tail takes the floor (`packages/agent/src/output-limits.ts:99`, `packages/agent/src/output-limits.ts:106`).
- The lost count comes from what survived, not from `keep`. `keep` can be larger than the body, because a second cut can ask for more characters than the body holds (`packages/agent/src/output-limits.ts:109`).
- The notice is its own line, not added onto the line where the cut lands. The head is often half a source file and the tail a stack trace. A notice at the end of either runs into it mid-token (`packages/agent/src/output-limits.ts:117`).
- The assembled result is one of three shapes: pointer and notice, with no head, then `pointer + head + notice`, then `pointer + head + notice + tail` (`packages/agent/src/output-limits.ts:120`).

### Spill

- A `SpillWriter` returns the path to show, or null when the write fails. A failed spill is a lost convenience, and it is never a failed tool (`packages/agent/src/output-limits.ts:29`).
- `formatSpillHeader` writes the first line, `[full output: N chars → path]` (`packages/agent/src/output-limits.ts:32`).
- Callers that bound their own output before the pipeline sees it use the same header format. A shell captures a head and a tail and writes the whole stream out itself. The header that a second cut recognizes is then the header the first one wrote. A later spill finds a pointer that is already there and does not make a second file (`packages/agent/src/output-limits.ts:36`).
- The guarantee that a spill cannot fail a tool lives in `cutText`. No writer has to give that guarantee. Whatever goes wrong on the way to disk, the call it belongs to returns its result (`packages/agent/src/output-limits.ts:84`).

### The cut marker

- `CUT_MARKER` matches the notice a cut leaves at the point where it cut, and reads back how many characters are not shown there (`packages/agent/src/output-limits.ts:42`).
- The marker matches wherever it sits, not only at the end, because a cut that keeps both ends puts it in the middle. The price: a body that has this sentence in the middle of a string is misread on a second cut. That is the same exposure the end-anchored form had, widened from the last line to any line (`packages/agent/src/output-limits.ts:42`).
- The digits are plain on purpose. `cutText` reads the marker back on a second cut, and a locale-grouped `1.234.567` parses as `1.234` in half of Europe. The marker is never shown to a person. The model reads it as a number (`packages/agent/src/output-limits.ts:42`).
- `formatCutMarker` writes one line, with no newlines of its own. Whoever joins a head and a tail around it supplies those (`packages/agent/src/output-limits.ts:46`). The marker format, like the spill header, is a shared format. A caller that drops a middle before the pipeline cuts writes a marker that this module parses. The cumulative count then survives a second cut. It does not start a new count (`packages/agent/src/output-limits.ts:46`).

### Taking a result apart

- `takeApart` recognizes a spill header and an earlier cut marker in a result that may already show a cut (`packages/agent/src/output-limits.ts:50`).
- `takeApart` removes the notice and both of the line breaks that hold it, and rejoins the two ends across the gap (`packages/agent/src/output-limits.ts:61`).
- The break at the end goes too, and not for tidiness. The two breaks replaced the middle that is gone. If either one stays, it leaves a character in `body` that no original text had. `body.length + omitted` has to stay equal to the length the text had before any cut touched it (`packages/agent/src/output-limits.ts:61`).
- A second cut measures its notice against that identity. Anything left behind here counts twice, once as shown text and once as lost text (`packages/agent/src/output-limits.ts:61`).
- `Cuttable` is the result of that step. It holds `body` as it stands and the `header` path if the result already has one. `omitted` holds the characters already lost from an earlier cut (`packages/agent/src/output-limits.ts:51`).

### Small cases and block splitting

- `cutText` returns the text unchanged when it is not longer than the limit. This function bears the name of a cut. It is the wrong place to discover that it can lengthen a short string with a claim of a cut that never happened (`packages/agent/src/output-limits.ts:80`).
- At one character of budget, or none, there is nothing to divide. The tail gets nothing and the cut is exactly the head-only one it used to be. A cut result with an empty head keeps only text that was already at the end (`packages/agent/src/output-limits.ts:100`).
- `cutContent` spreads one result's limit across its text blocks in order (`packages/agent/src/output-limits.ts:126`).

### The round budget

- `capRoundResults` splits the round budget in proportion to size, with a floor reserved first for every result (`packages/agent/src/output-limits.ts:150`).
- Proportional, because the result that carries the most output is usually the one the model works on. Floored, because a plain proportional split can hand a result a hundred characters and call that a preview. Reserved first: if floors come out as one goes, a round of many results can exceed the budget (`packages/agent/src/output-limits.ts:150`).
- The split: `floor` is `MIN_ROUND_RESULT_CHARS` or an even share, whichever is smaller. `spare` is the budget minus the floors. Each result's limit is the floor plus a share of the spare, in proportion to its size (`packages/agent/src/output-limits.ts:160`, `packages/agent/src/output-limits.ts:165`).
- A round that fits the budget, or that has no results, comes back unchanged (`packages/agent/src/output-limits.ts:158`).
- `capRoundResults` spills results that are still whole and have somewhere to spill, and does not throw them away. The text is complete at this point: the tool's own limit did not have to cut it, only the turn's budget did. This is the last moment with a full copy of the output (`packages/agent/src/output-limits.ts:150`).

### Streaming capture

- A shell command's output can be arbitrarily large and arrives in chunks. A string that grows with it sets a memory bound that nobody chose. `createStreamCapture` keeps a window instead: a head and a tail, fixed at construction (`packages/tools/src/output-capture.ts:1`).
- When the middle no longer fits, the capture hands the full stream to an `OverflowSink`. `overflow(prefix)` receives the whole stream so far, exactly once. `chunk(chunk)` receives every later chunk, in arrival order (`packages/tools/src/output-capture.ts:30`).
- The capture drops nothing before it crosses the bound. The head holds the start of the stream, the tail holds its end, and the total never exceeded their sum. The two buffers cover the whole stream exactly, so the seed handed to `overflow` is a lossless prefix (`packages/tools/src/output-capture.ts:1`).
- The text that `finish()` yields carries the same one-line notice the pipeline's own cuts use, `formatCutMarker`. A result bounded here and cut again there keeps one cumulative count. The count does not restart (`packages/tools/src/output-capture.ts:1`).
- `finish()` reports the bounded text, the number of characters the notice stands for, and the stream total. Its `dropped` count is always positive after that point: the total passed the two windows' sum, and neither window exceeds its cap (`packages/tools/src/output-capture.ts:75`).
- `createTailBuffer` holds the last `maxChars` of a stream. It does not rebuild the whole stream on every chunk. Chunks leave whole from the front, once enough of them accumulate. The kept set stays near the cap, and it does not grow with the command's total output. Only `read()` joins, and it runs once per emission, not once per chunk. The tail can overshoot the cap by at most one chunk, and `read()` trims that (`packages/tools/src/output-capture.ts:9`).
- `nextSpillPath` gives a fresh path for one spilled stream, labelled and unique across calls and across processes. The counter separates two spills in the same millisecond of one process. The pid separates two processes that write in the same directory (`packages/tools/src/output-capture.ts:93`).

## Why it is like this

- **Why the ends, not the start.** The two ends answer the two questions a reader asks: what the tool ran, and where it ended up. The middle is the part that repeats (`packages/agent/src/output-limits.ts:76`).
- **Why the pointer is on the first line.** The rest of a cut result cannot rebuild it. The second cut must not erase it (`packages/agent/src/output-limits.ts:76`).
- **Why the notice is not charged to the text budget.** The lost count then depends on how the notice renders, and the same output reports differently at two budgets (`packages/agent/src/output-limits.ts:94`).
- **Why the lost count comes from what survived.** `keep` can be larger than the body. That count is the only number that stays put when the shape of the cut changes. A result cut twice by two limits stays short by one number (`packages/agent/src/output-limits.ts:109`).
- **Why the notice sits on its own line.** The head is often half a source file, the tail a stack trace. A notice attached to either end runs into a token (`packages/agent/src/output-limits.ts:117`).
- **Why the marker matches anywhere.** A cut that keeps both ends puts the notice in the middle. The cost is one false-positive case, wider than before, as stated above (`packages/agent/src/output-limits.ts:42`).
- **Why `takeApart` removes both breaks.** `body.length + omitted` is the identity a second cut measures against. A break left over counts once as shown text and once as lost text (`packages/agent/src/output-limits.ts:61`).
- **Why the split gives the odd character to the head.** It is the whole deviation from a plain half each, and it keeps the smallest cases exact. At no budget there is nothing to divide (`packages/agent/src/output-limits.ts:100`).
- **Why the split reserves the floors first.** Floors taken out as one goes let a round of many results exceed the budget that is meant to bound it (`packages/agent/src/output-limits.ts:150`).
- **Why whole results go to a spill at the last moment.** The tool's own limit did not cut them, only the turn's budget did. This is the last point with a full copy of the output (`packages/agent/src/output-limits.ts:150`).
- **Why the capture keeps a window, not a string that grows.** A string that keeps pace with the command's output sets a memory bound that nobody chose (`packages/tools/src/output-capture.ts:1`).
- **Why the capture says nothing before it crosses the bound.** The head and the tail cover the whole stream exactly before the capture crosses the bound. There is no loss to report, and the seed handed to the sink is lossless (`packages/tools/src/output-capture.ts:1`).
- **Why the capture marker matches the pipeline marker.** One notice format means one cumulative count when both layers cut the same result (`packages/tools/src/output-capture.ts:1`).

## Known traps

- `slice(-0)` is `slice(0)`. In `createStreamCapture`, the tail can pass the head's end or sit wholly inside it. The join needs the guard, not a bare slice (`packages/tools/src/output-capture.ts:58`).
- `nextSpillPath` names files with the pid and a counter. Two spills in the same millisecond of one process differ, and two processes in one directory differ (`packages/tools/src/output-capture.ts:93`).
- The marker format has one false-positive case, by design. A body that has the notice sentence in the middle of a string is misread on a second cut. The end-anchored form had the same case on the last line (`packages/agent/src/output-limits.ts:42`).
- `keep` can be larger than the body on a second cut that asks for more characters than the body holds. The lost count comes from what survived, for exactly that case (`packages/agent/src/output-limits.ts:109`).
- The floor for a round is `min(MIN_ROUND_RESULT_CHARS, floor(budget / count))`. A round with very many results gets a smaller floor than the constant (`packages/agent/src/output-limits.ts:160`).
- `formatCutMarker` writes one line with no newlines of its own. A caller that joins a head and a tail around it supplies the line breaks (`packages/agent/src/output-limits.ts:46`).
- A spill writer that throws is caught inside `cutText` and treated as a null path. The tool call still returns its result (`packages/agent/src/output-limits.ts:87`).

## Source map

| File | Role |
| --- | --- |
| `packages/agent/src/output-limits.ts` | The two limits, `cutText`, the spill header and cut marker formats, and `capRoundResults`. |
| `packages/tools/src/output-capture.ts` | Bounded capture of a stream that has not finished, the overflow sink, the tail buffer, and spill path names. |
