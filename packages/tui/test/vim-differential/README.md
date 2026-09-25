# Vim differential harness

Three scripts that check this repository's Vim engine against a **real vim** on the
same machine, in the same run, on the same buffer. They are how every expectation
in `../vim-engine.test.ts` was arrived at, and how a new one should be.

```
bun run packages/tui/test/vim-differential/regress.mjs
bun run packages/tui/test/vim-differential/fuzz.mjs [iterations]
bun run packages/tui/test/vim-differential/class.mjs
```

None of them is part of `bun test`. The first two shell out to `vim` once per
case, so they take seconds rather than milliseconds, and a machine without vim
cannot run them at all. The third is one vim run over the whole code space and
takes a minute or two.

## What is compared, and what is not

The **buffer text** and the **cursor offset**, after the same key sequence. Those
are the two things the REPL shows the user, and they are the two vim can be asked
to write out of a `-s` script.

**Mode** is not compared. Real vim has no mode to report from a script, and a case
built around that difference would be measuring the harness rather than the
engine. **A pending operator** is not compared either: a sequence ending on `d`
leaves the two editors in different internal states that identical text and cursor
cannot distinguish, so those sequences are dropped rather than compared.

## Four places the instrument will lie to you

All four of these produced a clean, confident, wrong answer first — a green run
that was reporting the harness's own bug as the engine's. They are written down
because the next person will reach for the same four shortcuts.

**`|` is a screen column, not a character offset.** It counts a double-width
character twice and puts the caret between the two halves of a narrow multibyte
one, so a case placed that way measures where the caret was put rather than what
the engine did. So does `{n}G`, which wants a line. `cursor(line, col)` is the
one that takes a **byte** column, which is what a JS string offset converts to,
and it lands on the character that owns the byte. `runVim` computes that.

**`match()`'s count is a one-based character number to skip**, not a length — so
`match(getline(1), '.', 0, col('.')-1)` answers one *less* than the caret's
column. The harness does not use it, but the same confusion is waiting in
`strchars()`, which is worse: it returns a code-point index, and this engine works
in UTF-16 offsets, so every surrogate pair before the caret puts the two out by
one (64 disagreements on `"👍abc €def"`). **Vim has no UTF-16.** The fix is to ask
vim for the prefix *string* — `strpart()` is byte-based, so it is the one function
here that means what it says — and measure that string's `.length` in JS.

**A terminal key has two spellings and both have to be right.** `vim -s` replays
bytes; the engine takes `handleKey(key, { end: true })`. Getting them apart makes
every result a comparison of two different key sequences, so both spellings live
in `harness.mjs` and `TERMINAL_SEQUENCES` is derived from `TERMINAL_KEYS` rather
than written out again — a case that picks the wrong bytes fails by reporting a
disagreement between two editors that were never sent the same keys.

**A sequence that ends in insert mode has no comparable caret.** A change
operator ends in insert, where this engine's caret is the *insertion point* and
`vim -s` leaves its caret on the last character it typed — so the two are always
one apart, and a case that forgets the trailing `"\x1b"` reports a difference
about the caret that says nothing about what the command did. Every `c`/`s`/`C`/`S`
case in `regress.mjs` ends with that Escape, and `A`/`I` alone cannot be compared
at all: nothing is typed, so vim's readback lands on the last character of the
line while the engine reports where the next one would go. The **buffer** still
compares in every one of these, which is the part worth a case — so a `c` case
that ends in Escape checks the change, and a case that does not end in insert at
all checks the caret too.

## Two buffers the comparison cannot judge

**The caret on a `\n`.** Vim has no line-break character to put a caret on;
`cursor(1, 3)` clamps onto the last character of the line. This engine's buffer
is one string with `\n` in it and does allow that offset, so the two editors would
be answering different questions and a match would mean nothing.

**The caret on half a surrogate pair.** A JS offset can stand between the units of
an astral character; `cursor()` takes a *byte* column and cannot address that. So
`"👍 x"` at 1 asks vim to put the caret on the `👍` and asks the engine to put it
between its halves, and the two answers are about different places. This is why
every case on an astral buffer names an even offset: the runs are 7…10 in
`"👍👍👍 👍👍 x"`, and only 0, 2, 4, 6, 7, 9, 11, 12 are places a caret can be.
The engine's own answer for a low surrogate is pinned in `vim-engine.test.ts`.

**A buffer whose text ends in `\n`.** Read as a file, `"ab\n"` is *one* line — the
trailing break terminates it and opens none after it. This engine counts the
empty line after it, because a textarea puts the caret there and the REPL hands
the engine the string. Every motion over such a buffer reaches a line the other
editor does not have, so a case would be a record of the modelling difference
rather than of the engine. `vim-engine.test.ts` pins the engine's own side.

`class.mjs` has one more, and it is the sharpest: **U+000A.** Vim has no line-break
character to classify at all; this one has to call it white space or a word motion
would stop on the last character of every line. That one code point is held to the
engine's own answer and everything else — a form feed, a carriage return, U+0085 —
is required to agree with vim.

## Why it exits 77

`regress.mjs` and `class.mjs` exit 0 on a full match, 1 on any difference, and
**77** when there is no vim to measure against. 77 is the automake convention for
"skipped", and it is deliberately not 0: a run that could not compare anything has
not earned a pass, and a script that reports one anyway is worse than no script.

All three use `-u NONE -N -i NONE`, so a developer's own `.vimrc` cannot decide the
behaviour being measured.

## `class.mjs` and the rest

`regress.mjs` and `fuzz.mjs` ask whether the engine and vim *do* the same thing.
Neither can ask whether the character-class table is *right*, because every case
agrees with both or disagrees with both — a table with every class shifted by one
would pass every motion test and be a different partition of the alphabet. So
`class.mjs` asks vim directly, with its own `charclass()`, for the class of all
1,114,112 code points. Seven real transcription errors turned up on its first run,
none of which any word motion had noticed.

## Adding a case

Put it in `CASES` in `regress.mjs` as `[keys, buffer, cursor]`, where `keys` is an
array of single characters so the case reads as the keys it names:

```js
[["d", "a", "w"], "one two three", 0],
```

A case is not an expected value — there is nothing to write down. Run it, and if
the engine disagrees with vim, **that is a behaviour change to argue about**, not
a test to update. The whole reason this harness exists rather than a table of
goldens is that a golden freezes today's behaviour without recording whether it
was right.

Buffers are named (`A`…`E`, then `LATIN1`, `SCRIPTS`, `EMOJI_THREE`, `BLANK_LINE`
and so on) where several cases share one. Escape is `"\x1b"`, and the terminal
keys are the byte sequences in `TERMINAL_KEYS` — `"\r"` for Enter, `"\x7f"` for
backspace, `"\x1b[3~"` for delete, `"\x1b[4~"` for End, `"\x1b[A"`…`"\x1b[D"` for
the arrows.

**`"\r"` is the one that has to be in `TERMINAL_KEYS`.** A search is typed into a
line and run with Enter, so a case that spells `\r` as anything else feeds the
engine a printable character and it reads the pattern as ending early. The whole
`/ ? n N * #` group was silently no-op in the engine until this one line was
added, and the first run after it found five more differences underneath — the
`"\r"` was never a small thing.

A new key belongs in `fuzz.mjs`'s `KEYS` as well, and that is not optional
bookkeeping: `<End>` and the arrows were added to the list for the coverage and
within one run each turned out to be a motion vim runs and the engine did not —
`d<End>` was `d$` and dropped the operator entirely. A key the fuzzer cannot send
is a key nothing is checking.

## `+` and `-`, and the line that is nothing but blanks

`nv_cmds.h:155` binds `+` to `nv_down` and `-` to `nv_up`, each with
`beginline(BL_WHITE | BL_FIX)` run after it. Two halves, and they disagree at the
edges:

- **`nv_down` refuses** when there is no line that way, and leaves the caret
  *exactly* where it was — it does not step back onto the last character. Measured
  on `"  aa\n\n  bb\ncc"`: `+` at 11 and at 12 (both on the last line) answer 11 and
  12, not the line's first non-blank.
- **a count that merely overshoots clamps**, the way `j`'s does: `2+` from the
  third line answers the last line.

So `+` is not `#vertical` and never recalls history — which is also why a
single-line buffer must not answer `+` with the user's earlier prompt, the way
`j` does there.

The interesting half is `BL_FIX`. A line that is nothing but blanks has **no**
first non-blank, and vim's answer is its *last character*: `beginline` stops at
the end of the line, and `check_cursor_col_win` (`misc2.c:560`) steps the column
back onto the last character it has. `"  "` puts the caret on its second space,
not on the line break. This engine's own end-of-line offset is one past that, and
a caret there is a position no command can use — so the shared helper had to
split in two:

- `motionFirstNonBlank` answers the **line's end**, which is where `I` types and
  where a linewise paste used to land;
- `motionBeginline` answers the **last character**, and is what every goto runs
  after itself: `^`, `gg`, `G`, `+`, `-`, and the landing a linewise yank reads.

The measurement that forced the split: on `"  \nfoo"`, `Ix<Esc>` gives `"  x\nfoo"`
— `I` types at the *end* of the blanks — while `gg`, `G` and `-` all answer 1, the
second space. One line, two different right answers, and the mutants `S36` (the
step-back) hold the pair.

`gg` and `G` had the bug before `+` and `-` existed; the new keys were only what
made it visible, because a line of blanks is the first buffer anybody thought to
run them on.

## What the fuzzer refuses to compare

`fuzz.mjs` draws 1–3 keys from `KEYS` and drops two classes of sequence by name,
in `uncomparable()`. Both are about a **command line the fuzzer opens but cannot
see**: a `/` or `?` puts the two editors on different sides of a latch — vim's is
a real command line the next key is typed into, the engine's is a one-key read.

- **A `CR` with no latch open.** Vim binds Enter to `nv_down` + `beginline`, which
  is this engine's `+`; the engine hands Enter to the host, because in a REPL a
  newline submits. The *buffer* agrees and the host's half of the answer has
  nothing to compare against, so the whole sequence is dropped rather than the
  key. This is **not** the search case: `/foo<CR>` is comparable, and `CR` is in
  the key set for it.
- **A `BS` or `DEL` with a latch open.** In vim both are editing keys of the
  command line — `BS` cancels it outright, `DEL` erases under the cursor — and
  neither is a command the engine reads on that path. Without a latch they are
  ordinary motions and stay in the set.

Everything else the fuzzer finds is compared, and it earned its keep on its first
run in this round: `^ j` on `"abc\ndef"` at 1, out of 900 drawn sequences, was the
one disagreement, and it was a real defect (`^` moved the caret without moving
the wanted column with it, so the `j` landed beside it). Mutant `S37`.

## Known gaps

`fuzz.mjs` and a hand probe found three real defects in the `>`/`<` shift
operators that are **not fixed** and are deliberately not in `CASES` — a case that
fails is not a case, it is a bug report:

- `>2$` and `>3$` shift one line more than vim does. The counted-`$` range ends
  past the line break, and `#shiftByMotion` reads the offset *after* that break as
  the next line.
- `>2w` shifts one line; vim shifts two.
- `>gg` and `>2gg` from below the first line do nothing at all, and leave the
  caret where it was.

### Search, measured and left

Search is the one area of the engine where a **dialect** is the answer rather than
a translation. A pattern is a JavaScript `RegExp` compiled with `gmu`; vim's is
its own. The `m` is what makes `^` and `$` line anchors, `u` is what keeps the
buffer's UTF-16 indexing and rejects a lone surrogate, and `g` is not about
matching at all — without it the `exec` loop that collects the matches asks the
same question forever and the engine hangs on the first Enter. `\<` and `\>` are
translated to `\b` and nothing else is, which is a **narrow** translation: `\b` is
the boundary for every ASCII word character, so `/\<foo` finds an English word
and finds nothing where a Chinese one starts. That is why a word search is *not* a
`\<word\>` pattern here — `collectWordRuns` walks the same character classes a
`w` motion does, which is what finds `中文`. The `\<` translation is kept for the
patterns a user types, and the gap is this sentence.

Not implemented, and named rather than half-done:

- The line-placing offsets — `b`, `s`, `W`, `n`, `i`, `-`, `+`. `parseSearchLine`
  reads `c`, `e`, `E` and `^` after a **separator**, and nothing else: `/ae` is a
  search for `ae` (measured — it finds nothing in `a a a`, where stripping the `e`
  would have found the `a` at 2), and a trailing separator is a delimiter, which
  is what makes `//` the repeat rather than a search for a slash.
- `\|` alternation and `\{n,m}` — those are vim's spellings of what JS writes
  `|` and `{n,m}`, and a JS pattern answers them differently. `+` is the sharper
  one: in vim `*` is "zero or more" and `+` is a literal, while in JS the two are
  quantifiers and `\+` is a literal `+`.
- `d/pattern`: vim deletes to the match. Here the operator is dropped and the
  search runs, which is the part of it that is not a data-loss surprise.
- A bare `<CR>` in NORMAL mode. Vim treats it as `+` (see the section above); the
  engine hands Enter to the host, so a newline in the REPL submits. This is a
  **deliberate** divergence — a mode that swallowed Enter would make the prompt
  unusable — and the fuzzer drops every sequence with an unlatched `CR` rather
  than reporting it, because the buffer agrees and only the host's half of the
  answer is missing.
- Telling the user why nothing happened. A pattern that does not compile, one
  that matched nothing, and one that was never typed all leave the caret alone,
  and vim would say `E54`, `E486` and `E35` respectively. There is no message
  area here to say them in.

### The offset is a comparison, not only a landing

An offset search is about the position it *lands* on, and the whole rule follows
from that: which matches are ahead of the caret is decided on `end - 1` rather
than on the match's start, **in both directions**. So `/ab/e` on `ab ab` at 0
answers the **1** — the match the caret is already inside, reached because that
match *ends* past it — where `/ab` skips to the 3 and where a search that compared
the starts answers 3 as well.

It is written down because it is the rule that every one-character case agreed
with the wrong answer: where a match is a single character its start and its
landing are the same offset, so the offset flag looked right everywhere it had
been measured. A two-character pattern is what tells them apart, and the first
one tried (`ab ab` and `abcabc`, 22 cases between them) showed the engine had been
reading the start all along. The count is counted from the landing too, so
`2/ab/e` on `ab ab ab` at 1 answers the 7 where a start comparison answers the 4,
and `2/2ab/e` — two counts of two — answers the 0.

And one **measured disagreement**, left alone on purpose because the engine's
answer is not a rule this harness could establish:

- A pattern that can match the empty string is a real answer — `/\` and `/a*` are
  patterns a user can type — and the engine walks them a character at a time so
  the walk terminates. Vim's treatment is not the one this engine has. Measured
  on vim 9.1, from the first column: `/a*` on `"aaa"` leaves the caret at 0 where
  the engine steps to 3, `/.*` on `"abc"`, `"ab cd"` and `"a.. a.."` likewise
  stays put where the engine steps to the end of the buffer, while `/x*` and
  `/\W*` — the two whose first match is *empty* — agree with the engine on every
  buffer tried. Two answers from four measurements is not a rule, and a rule
  invented from it would be worse than the honest sentence. The mutants `S1` and
  `S26` hold the two things that *are* established here: that the scan terminates
  at all, and that the step is a whole character rather than a code unit
  (`/x*` on `"👍 x"` answers 2, and a code-unit step answers 1, which is between
  the halves of a surrogate pair and not a place a caret can stand).

## The one thing the engine knows that vim does not

A paste of more than 500 characters, or of anything at all that spans lines, is
folded into a literal ASCII token in the buffer: `[Pasted 800 chars #1]`
(`packages/tui/src/paste.ts`). It is expanded back into the real payload at
submit, and **the payload is gone from the buffer** — so a command that takes one
of the token's characters leaves a string nothing matches, and the model receives
the remains of a placeholder.

The Vim engine therefore treats a token as one indivisible character: a motion
steps over it, `x` takes all of it, `r` refuses, a find cannot stop in its
interior, a wanted column that aims inside it is snapped onto its `[`.

**No case for this belongs in `regress.mjs`, `fuzz.mjs` or `class.mjs`**, and
that is a decision rather than an oversight. Real vim has no paste token, so
every such case mismatches by construction and a comparison that cannot be won
is not evidence — a harness full of known-red cases trains you to ignore it.
The evidence for this batch is `packages/tui/test/vim-engine.test.ts` and
`packages/tui/test/editing.test.ts` instead, held in place by the mutants
`W1`–`W8` and `X1`–`X3` in **`driver-vim-b.ts`, which is not under version
control** — it rewrites `vim.ts` in place, runs `bun test`, and restores the
original bytes, so it is a machine-local instrument rather than something the
repository can hold. The end-to-end assertion is the one that matters: a yank, a
delete and a paste put the token back byte for byte, and `expandPasteTokens` still
finds the payload inside it.
