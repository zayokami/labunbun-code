/**
 * Marks the transcript's shape is drawn with: the dot on a tool call and the
 * lead its output hangs under.
 *
 * They live together because tests and callers must not spell the dot out
 * themselves — it differs by platform, and CI runs on three — and because the
 * lead and the indent are a pair: continuation lines only line up under the
 * first while the two strings stay the same width.
 */

/**
 * The tool-call status dot: one glyph cell plus one space, so every row starts
 * its name in the same column.
 *
 * macOS terminals have the record symbol and align it cleanly against the
 * text; on Windows and Linux it is usually missing from the font and falls
 * back to a placeholder box, so those get the plain filled circle instead.
 * State is never in the glyph — every tool wears the same dot, and color and
 * dimming are what fill it in.
 */
export const TOOL_DOT = process.platform === "darwin" ? "⏺" : "●";

/**
 * The dot before an assistant message.
 *
 * The same glyph as a tool call's, because both are the assistant's side of the
 * transcript: the color is what tells a sentence from an action (a tool's dot
 * carries its state; this one stays muted), and the shared shape is what makes
 * a turn read as one speaker. The body hangs two columns in from it, so a
 * wrapped paragraph and the code block under it share one left edge.
 */
export const ASSISTANT_DOT = TOOL_DOT;

/** The result lead — two spaces, `⎿`, two spaces — dim, on a result's first line. */
export const RESULT_LEAD = "  ⎿  ";

/** The indent under the lead, so continuation lines align with the first. */
export const RESULT_INDENT = "     ";
