/**
 * How many terminal cells a piece of text occupies.
 *
 * The cell grid stores one screen cell per array slot, so every string has to
 * be measured before it is placed. Two questions are asked separately:
 *
 * - `codePointWidth` is the width of one code point. It is what the split
 *   workspace's line breaker walks, because a break may fall between any two
 *   code points of a line.
 * - `graphemeWidth` is the width of one *grapheme cluster*. A terminal composes
 *   a base and its combining marks (and a ZWJ emoji sequence) onto one glyph, so
 *   the cluster is as wide as its widest member, not the sum of its parts.
 *
 * Both agree for plain text; they part on `e` + U+0301 (two code points, one
 * cell) and on an emoji family (several code points, one two-cell glyph).
 */

/**
 * Printable width of one code point, near enough for terminal layout.
 *
 * An underestimate is the safe direction — a row truncates rather than wraps —
 * but a CJK transcript laid out as half-width reads as broken spacing, so the
 * common wide ranges are listed. Control bytes have already been sanitized by
 * the time text reaches a cell; any that survive take no cell.
 */
export function codePointWidth(code: number): number {
	// Combining marks and zero-width joiners take no cell of their own.
	if (
		code === 0x200b ||
		code === 0x200c ||
		code === 0x200d ||
		code === 0xfeff ||
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0x20d0 && code <= 0x20ff) ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		(code >= 0xfe20 && code <= 0xfe2f)
	) {
		return 0;
	}
	// C0/C1 control bytes have already been stripped; any that survive take no cell.
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
	// East Asian wide and fullwidth ranges, plus the emoji blocks a terminal
	// renders two cells wide. Regional indicators are two-cell flags when paired.
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f1e6 && code <= 0x1f1ff) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f680 && code <= 0x1f6ff) ||
		(code >= 0x1f900 && code <= 0x1f9ff) ||
		(code >= 0x1fa70 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Width of one grapheme cluster: its widest code point, capped at the two
 * columns a terminal will ever give a glyph.
 *
 * U+FE0F asks for the emoji presentation of a character whose default is text
 * (`❤` + VS16). That is one code point wide by the table and two cells on the
 * screen, so the selector promotes it.
 */
export function graphemeWidth(cluster: string): number {
	let width = 0;
	let emojiPresentation = false;
	for (const char of cluster) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 0xfe0f) emojiPresentation = true;
		width = Math.max(width, codePointWidth(code));
	}
	return Math.min(2, emojiPresentation && width === 1 ? 2 : width);
}

/** The columns `text` occupies on screen. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const { segment } of SEGMENTER.segment(text)) width += graphemeWidth(segment);
	return width;
}
