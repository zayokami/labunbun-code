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

## Three places the instrument will lie to you

All three of these produced a clean, confident, wrong answer first — a green run
that was reporting the harness's own bug as the engine's. They are written down
because the next person will reach for the same three shortcuts.

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

## Two buffers the comparison cannot judge

**The caret on a `\n`.** Vim has no line-break character to put a caret on;
`cursor(1, 3)` clamps onto the last character of the line. This engine's buffer
is one string with `\n` in it and does allow that offset, so the two editors would
be answering different questions and a match would mean nothing.

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

Buffers are named `A`…`E` where several cases share one. Escape is `"\x1b"`, and
the terminal keys are the byte sequences in `TERMINAL_KEYS` — `"\x7f"` for
backspace, `"\x1b[3~"` for delete, `"\x1b[4~"` for End, `"\x1b[A"`…`"\x1b[D"` for
the arrows.

A new key belongs in `fuzz.mjs`'s `KEYS` as well, and that is not optional
bookkeeping: `<End>` and the arrows were added to the list for the coverage and
within one run each turned out to be a motion vim runs and the engine did not —
`d<End>` was `d$` and dropped the operator entirely. A key the fuzzer cannot send
is a key nothing is checking.

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
