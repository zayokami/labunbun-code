# Cell grid

A fixed screen of terminal cells, stored in TypedArrays, drawn by diffing a
front buffer against a back buffer. The engine lives in
`packages/tui/src/render` and is exported as `@labunbun/tui/render`; Ink still
draws the transcript and the prompt, and this is the substrate for a view that
wants its own screen of cells and a frame diff.

## Why a second renderer

Ink owns the scrollback: it lays out a React tree, writes rows, and never
erases what it has printed. That is the right model for a conversation, and the
wrong model for a view that repaints the same rectangle — a dashboard, an
editor, a full-screen browser — where the useful unit is "which cells changed
since the last frame". A cell grid answers that question directly, and the
answer is usually a handful of bytes instead of a re-print.

The two coexist. Adopting the grid for one view does not change how the
transcript renders, and nothing in the engine knows about React, Ink, or the
store.

## The model

```
paint(draw) ─▶ back.beginFrame() ─▶ draw(back) ─▶ diff(front, back)
                                                     │
                                    cursor moves + SGR + text
                                                     ▼
                                                   stdout
                                                     │
                                              swap(front, back)
```

- **Cell**: three array slots — a code point (`Uint32Array`), an interned style
  id (`Uint32Array`), and a flag byte (`Uint8Array`). A 200×60 screen is three
  contiguous allocations, reused for the life of the screen.
- **Blank**: code point 0 and style 0. A space typed with the default style is
  normalized to blank so two visually identical frames compare equal.
- **Wide glyph**: the head cell carries the glyph and the `WIDE` flag; the cell
  to its right is a `CONTINUATION` holding no glyph. Writing over either half
  clears both — a half glyph is the corruption a resize is most likely to
  expose.
- **Cluster**: a grapheme made of more than one code point (a combining mark, a
  ZWJ emoji) is kept in a `Map<cell index, string>`; the cell carries the
  `CLUSTER` flag instead of a code point. Only clusters pay for a map entry.
- **Style**: colours and attributes are interned into a `StyleTable`; a cell
  stores the id, and the encoder emits one SGR sequence per style change. Id 0
  is the empty style and exists before the first intern.
- **Width**: `graphemeWidth` measures a cluster as its widest code point, capped
  at two cells; U+FE0F promotes a text-presentation base to its two-cell emoji
  form. A wide glyph that does not fit at the right edge is written as a space
  and the rest of the line is dropped — skipping it would shift every following
  glyph one column left.

## Invariants

1. **`front` is what the terminal shows.** `present()` swaps; it never copies.
   The old front becomes next frame's scratch buffer.
2. **A frame that changed nothing emits the empty string.** `TerminalScreen.paint`
   returns `false` and writes nothing, cursor included.
3. **Every frame is absolute.** `beginFrame()` clears the back buffer, so a
   caller never has to know what it drew last time.
4. **Control bytes are data, never commands.** C0, DEL and C1 are written as a
   space (newline included). Text cannot inject an escape sequence.
5. **A wide glyph's two halves are written and cleared together.** No state
   leaves a continuation without its head.
6. **Resize invalidates the physical screen.** The grid reallocates, the next
   frame erases with `CSI 2 J`, and the screen is repainted from scratch. The
   erase is screen-only, never scrollback.
7. **Disposal restores the terminal.** The default style is reset and the
   cursor is shown exactly once; a disposed screen ignores further paints.
8. **A frame is atomic where the terminal supports it.** Frames are wrapped in
   DEC mode 2026 (synchronized output) unless the caller turns it off.
9. **No write splits an escape sequence.** Windows' ConPTY loses track of large
   writes, and a frame has no newline for `chunkForConPTY` to cut at, so the
   screen chunks the encoded frame itself, only between sequences and code
   points. Every chunk is under the ConPTY budget.

## The encoder

`diffBuffers` groups adjacent changed cells of one style into runs. A blank
cell that changed still emits a space: erasing is a write, and a styled blank (a
background colour) has to be repainted even though it holds no glyph.
`encodeFrame` positions the cursor only when a run does not continue where the
previous one ended, emits SGR only when the style changes, and finishes in the
default style. Grid coordinates are zero-based; the escape grammar is
one-based; the conversion happens in one place.

## Lifecycle

`TerminalScreen` owns a `CellGrid`, hides the cursor on construction, and
restores it on `dispose`. The screen owns the display, so its first paint
erases whatever the terminal held. `paint(draw, cursor?)` is the whole draw
call; `cursor` parks the cursor after a frame that drew something. `resize` is
explicit — the caller owns the terminal-size source — and leaves a pending erase
that the next paint spends, even if that frame is empty.

The engine is deliberately not wired into Ink: Ink owns layout, and a bridge
would have to parse Ink's ANSI back into cells only to diff it again. The
adoption path is one view at a time, with the view drawing into `CellBuffer`
instead of returning React elements.

## Tests

- `packages/tui/test/cell-grid.test.ts`: width measurement, wide glyphs, half
  clearing, clipping at the edge, combining and ZWJ clusters, control-byte
  sanitizing, buffer reuse across frames, resize invalidation, the diff's run
  grouping, every SGR/positioning rule in the encoder, and sequence-safe
  chunking under the ConPTY budget.
- `packages/tui/test/terminal-screen.test.ts`: hide/show cursor, the opening
  erase, no-op frames, change-sized writes, the resize erase, cursor parking,
  and idempotent disposal.
