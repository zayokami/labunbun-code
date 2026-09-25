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

## Five places the instrument will lie to you

All five of these produced a clean, confident, wrong answer first — a green run
that was reporting the harness's own bug as the engine's. They are written down
because the next person will reach for the same five shortcuts.

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

**A `-s` script never syncs the undo between its keys.** `may_sync_undo()`
(`getchar.c:1481`) is the one thing that closes an undo block and opens the next,
and it returns without calling `u_sync()` while a script file is being read — the
source says so in its own comment, "*Do not sync: … While reading a script file*".
So two changes in one case are **one** undo block, where a person at a keyboard
would get two. Measured, on `"ab\ncd"`:

| keys | vim | engine |
|---|---|---|
| `x` `u` | `"ab\ncd"`@0 | `"ab\ncd"`@0 |
| `x` `j` `x` `u` | `"ab\ncd"`@0 | `"b\ncd"`@2 |
| `x` `j` `x` `u` `u` | `"ab\ncd"`@0 | `"ab\ncd"`@0 |

Read the middle row and the last one together, because the last one is the trap.
`x j x u` disagrees, which is the lie; `x j x u u` **agrees**, because vim's second
`u` has nothing left to undo and the engine's second step lands where vim's first
did. So the obvious workaround — give the case a second `u` — makes it green for
the wrong reason, and a case written that way is worse than no case. The rule is
simply: **one change in front of a `u`, never two.** All six `u` cases in `CASES`
have exactly one, which was checked by reading them rather than by a script, and
this is the reason the redo cases that need an undo (`vrX` `u` `.`) are written
with the `.` on the spot rather than moved off it: the script's undo grouping is
the same in both, so a comparison there is still meaningful, but only because
there is one change to undo.

## Three buffers the comparison cannot judge

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

## The redo, `.`

`.` repeats the **last change the buffer went through**, and there is no flag and
no arming step: every change replaces the entry and the commands that change no
text do not touch it. Three things have to be kept to repeat one.

- **The keys.** Split into the count and the rest, so `2x` repeats two deletions.
- **The text a change typed.** A `c`/`s`/`C`/`S` ends in insert mode, where the
  *host* types into the buffer and the engine never sees a character — so the text
  is diffed at the Escape and written back on the replay (`S46`, `S47`).
- **The size of a selection, not the motions that made it.** A Visual operator is
  redone at the same width: `redo_VIsual` (`ops.c:3890`), with the size recorded
  in one of three forms at `ops.c:4136` — `w_curswant == MAXCOL` (asked first),
  the width for a selection on one line, and the end's own column on its own line
  for one over several. `S43`–`S45` and `S50`–`S52` hold the three forms and the
  two ways to tell `MAXCOL` from the reach it is not.

The measured rule that replaced a wrong one is the short version: **a Visual `r`
is the redo like any other change.** The first model here said a Visual `r`
emptied the redo slot, and the three cases written to hold it all put the `.` on
the line the `VrX` had just written — where running and not running look the
same, so all three passed against a flag that was wrong. The matrix that settled
it is 14 cases in `CASES` (`xvrXj.`, `dwvrXj.`, `VrXj.`, `vrxj.`, `vlrxj.`,
`xvrxj.`, `VrXGvl.`, `xVrXGvl.`, `vrXu.`, `drX.`, …) and the rule that came out
of it is three sentences:

- a Visual `r` is the redo **with or without** a change before it, linewise or
  charwise, and **even when it wrote the character that was already there** —
  `vrxj.` on `"xx\nyy"` writes an `x` over the `y`, and the buffer reads the same
  before and after;
- an **undo** neither takes the redo away nor re-points it: `vrX` `u` `.` writes
  the `X` again, which is the entry the `vrX` left;
- the only thing that blocks a `.` is a **selection being open**: `VrXGvl.`
  writes nothing, and the `VrX` is still the redo afterwards.

So a redo case has one obligation beyond the usual: **move the caret off the
change before pressing `.`.** `S61` (the size dropped, so the redo re-types
`vrX`) and `S62` (a `.` in a selection runs the redo) are the two halves of that
rule, and they are the two that a case with the `.` in the wrong place would not
have caught. The reason the re-point is not modelled is worth one sentence: the
undo belongs to the host's stack, which does not say which of several undone
changes this was, so there is nothing to re-point at — and since an undo does not
change the entry anyway, nothing is lost.

## `r`: the character *after* the operator

`r` is the one operator whose second key is a character, and both modes read it
from the same place, so the three rules below are all about the same key.

**A count in front of a NORMAL `r` the line cannot supply is a refusal.** Vim
aborts the command (`normal.c:4900-4906`, "Abort if not enough characters to
replace") rather than replacing the characters that are there, and the test has
two halves: `ml_get_cursor_len()` is the **bytes** left on the line and
`mb_charlen(ml_get_cursor())` is the **characters**; the second is the stronger of
the two, so the engine counts characters and stops at the end of the line rather
than the end of the text. That is why `2r+` on `"你好"` writes two `+` — two
characters, however wide — where a unit count would refuse it, and why `3r+` on
the same line writes nothing at all. This is a **pre-existing** defect the
fuzzer found by itself: with `r` newly in the key set, one draw in three thousand
was `3 r +` on `"abc\ndef"` at 2, where the engine wrote one `+` and vim writes
none. `S65`, `S66` and `S67` take the three halves apart, because a refusal
counted in units would be a second bug wearing the first one's coat.

**A Visual `r` writes the character over every character of the selection** — and
the selection's own line breaks are not characters it writes over, which is what
makes `VrX` on `"ab"` answer `"XX"` and not `"XXXXXX"`. A count in front of the
`r` is **not** the `r`'s own (`vl3rX` is `vlrX`, and `vlr2` writes a `2`), and a
digit is as good a character as a letter. A half-typed character that never
arrives is cancelled by Escape and by every key that is not a character — the
arrows, `<End>`, backspace and delete all beep and change nothing — because vim
reads that key with `plain_vgetc` and bails when it comes back special
(`normal.c:4857-4863`), while a key taken as the character would write the empty
string over the selection and **delete** it. `<CR>` is the exception and is a
named gap below. A pasted token inside the selection keeps its spelling, the same
rule every other command that rewrites a selection follows.

**A count in front of `v`/`V` is spent on the command itself.** `nv_visual`
decrements it once and runs `nv_right`/`nv_down` with what is left
(`normal.c:5609-5615`), so `2v` is two characters wide, `2V` is two lines, and a
count typed *inside* adds to it rather than replacing it (`2v3l` is five
characters, `2v3ll` six). The step it takes is a step **past** the end of the
line — inside a selection `nv_right` counts the line break
(`normal.c:5822-5828`) and stops with the caret one character past the last one,
a position this engine cannot stand in. The wanted column is what carries it
(`S60`): without it a `j` after `vl` lands a line short, which is a pre-existing
defect the count work exposed rather than one it created.

## Text objects: `iw` `aw`, then `ip` `ap`

An operator followed by `i` or `a` opens a latch for **one** key, and the key is
an object name rather than a motion. Three things have to be true for that to be
an object and not a silent `diw`, and all three were defects first:

- **A name the engine does not know is a cancellation, not a word** (`V6`).
  `diZ` used to cut a word, because the latch spent whatever arrived. It now
  spends the operator, and the buffer is untouched.
- **The walk is by character class, and it re-reads it once** (`V4`, `V5`).
  `endWordOnce` finished its loop by asking the class of each character again
  instead of the once `skip_chars` reads (`textobject.c:139-155`), so a word ran
  on through the punctuation behind it: `daw` on `"a, b; c"` at 2 cut `"a, c"`
  where vim cuts `"a,; c"`. `W` walks the big classes and is not `w` with the
  rules loosened.
- **A multi-line charwise delete may become linewise** (`V7a`–`V7c`). A delete
  that leaves a blank line behind the object is promoted — register included —
  by the "strange Vi behaviour" of `ops.c:810-825`, which survives because
  `'cpoptions'` has kept its `z` (`CPO_WORD`) since 7.4. A `c` and a `y` are not
  promoted, and the promotion looks *behind* the object, not at its own length.

`aw` has one asymmetry worth stating because it looks like a bug and is not: it
reaches for the white **behind** the word (`V2a`), and the white it reaches for
does not take the indentation with it (`V2b`).

### `ip` and `ap` are linewise from the moment they are found

A paragraph object sets `oap->motion_type = MLINE` (`textobject.c:1500-1672`) and
never writes `oap->inclusive`, so it is not a characterwise object that happens to
span lines. In this engine that means it goes to `#runLinewise` and never reaches
`#runOperator` or `deleteGoesLinewise` at all — which is also why `V23`, routing a
paragraph through the characterwise path, is red on the very first case.

What the source settles, each of which cost a measurement to believe:

- **A blank line is one that holds nothing but space and tab** (`V14`).
  `linewhite` (`search.c:3183`) is `skipwhite(line) == NUL`, so `"   "` separates
  paragraphs and indentation never does.
- **A paragraph also begins at a form feed or an nroff macro** (`V15`–`V17`).
  `startPS` takes a form feed or `.` plus `inmacro`, and `inmacro`
  (`textobject.c:252-273`) slides a **two**-character window at even offsets
  across the whole option string — the space is a *position in a window*, not a
  separator, which is why the list's lowercase `.bp` is in it and `.BP` is not.
  Three letters do not split: `.ABC` is a paragraph of its own only by accident.
- **`ap` takes the blank run after the paragraph** (`V18`), or **reaches back for
  the blanks in front** when there is nothing after (`V19`).
- **From a blank, `ap` is the run plus the paragraph below it — and stops there**
  (`V20`). The blanks *after* that second paragraph are somebody else's; the
  source breaks out of the loop before the walk to the end of the white lines.
  `dap` on the blank of `"a\n\nb\n\nc"` leaves `"a\n\nc"`, not `"a\nc"`.
- **A count is a number of units, and a blank run is one unit** (`V21`) — one
  fewer when the caret is already inside that run, which is the whole difference
  between `2ip` and `2ap` there.
- **A count past the end is a FAIL, not a clamp** (`V22`). `current_par` returns
  `FAIL` when `end_lnum == line_count`, and a FAIL spends the operator rather
  than taking what is left. This one is worth flagging because a hand-written
  expectation got it wrong first: `2dip` on the blank of `"a\n\nb"` is not a
  no-op, it is `"a"` — the run plus the paragraph below — while `2ap` from the
  same place gives up. The engine was right and the expectation was rewritten.
- **A FAIL rings the bell and walks nowhere** (`V27`): `clearopbeep` drops the
  operator, so the caret is exactly where it was.
- **`>` and `<` take the span the object lands on** (`V24`), not one line — the
  same rule `V12` holds for `iw`.

One fix in this round was not about paragraphs at all. An **empty linewise
register is a thing worth pasting**: `yip` on an empty buffer yanks one empty
line, and `ggP` pastes it as a line break, where an empty characterwise register
(`y$` on an empty line) pastes no characters at all. `#paste` conflated the two
and pasted nothing (`V26`). The object made the path reachable; the defect was
already there.

The evidence for the round is 47 cases in `CASES` and a 780-case `ip`/`ap` grid,
on top of the 1053-case word-object grid that found `V1`–`V9`. Both grids skip the
two classes in **Three buffers the comparison cannot judge**, which is why
`CASES` carries no case with the caret on a `\n` and none whose text ends in one.

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

### `r` and `<CR>`, measured and left

Not a disagreement this harness cannot judge — both answers are readable, and the
reason the gap is here rather than in `CASES` is only that a case in `CASES` has
to be green. The two modes do **different** things with the key, which is what
made this worth writing down rather than summarising as "a line break":

- **NORMAL.** `r<CR>` does not go through the operator. It deletes the characters
  the count covered and then runs an insert that breaks the line once —
  `normal.c:4925-4939`, "*Strange vi behaviour: Only one newline is inserted*" —
  so `3r<CR>` would remove three characters and leave one break. Measured at
  column 2 of `"abcdef"`: `"ab\ndef"` with the caret at 3, which is the first
  character of the new line.
- **Visual.** A Visual `r` goes to `nv_operator` (`normal.c:4866-4880`), which
  writes the character over each selected one, and a CR is a character there — a
  literal `\r` *inside* the line, not a break. Measured: `vlr<CR>` on
  `"abcdef"` reads back as `"\r\rcdef"`, two CRs and no new line.

The engine cancels in both, so `fuzz.mjs` drops a `CR` straight after an `r` by
name (a guaranteed mismatch otherwise) and `vim-engine.test.ts` pins what the
engine does instead. Both halves also want a redo form — vim's is an insert-mode
edit rather than a `r`, which is why `invoke_edit` is called with the `r` — so
this is a small feature with a sharp edge in it, and it is the first thing on the
list after the text objects rather than something to bolt onto this round.

### Visual `gU` and `gu`, measured and left

`gU` in NORMAL mode with no motion does nothing in both editors, and neither
implements the Visual form. Measured: `vjgU` on `"ab\ncd"` gives `"AB\nCd"` in
vim — characterwise, and the caret leaves Visual — where the engine is still in
Visual with the buffer untouched. `vlgu` on `"ABCdef"` gives `"abCdef"`. A
selection is the only place the two halves of `gU` differ, because the NORMAL form
is a motion-plus-operator and the Visual form is the operator alone, so this is
one missing branch rather than a missing command.

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

Every mutant name in this file belongs to that driver, and a name is a pointer
rather than a promise: the driver has been renumbered twice, and a rewrite of it
once dropped the whole `S`/`W`/`X` scheme — 78 checks — without saying so, which
left this section citing mutants that no runner was executing. The assertions were
never lost, and every anchor still resolved against the source, so carrying the
checks back was bookkeeping rather than re-derivation. But the coupling is real
and the failure mode is quiet: a name in a README cannot go red. **The evidence
in this repository is the test file; the mutants only tell you which assertion is
load-bearing.** `ANCHORS_ONLY=1` on the driver is the command that finds a dead
one, and it is worth running whenever a batch renames anything.
