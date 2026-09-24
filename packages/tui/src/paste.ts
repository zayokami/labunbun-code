/**
 * Large-paste handling. A terminal with bracketed paste enabled delivers the
 * whole payload as one event; pasting a file-sized blob into the buffer would
 * both flood the prompt and make the transcript unreadable. Long or multiline
 * payloads are folded into a compact placeholder token that is expanded back
 * to the original text only at submit time.
 *
 * Pure module: the token format, threshold, and expansion are testable without
 * a rendered frame.
 *
 * The token is literal ASCII in the buffer the user can edit, which is what
 * {@link pasteTokenAt} is for: the Vim engine asks it where a token is so that
 * an edit cannot take one of its characters and leave a string
 * {@link expandPasteTokens} no longer matches, which is the one way a pasted
 * payload can disappear from a prompt that looks perfectly normal.
 */

/** Pastes longer than this become placeholders. */
export const PASTE_PLACEHOLDER_THRESHOLD = 500;

/**
 * A paste becomes a placeholder when it is long OR multiline. The newline rule
 * is deliberate: a multiline paste is almost always code or logs, and keeping
 * it inline in a single-line-looking prompt misrepresents its shape.
 */
export function shouldPlaceholderize(text: string): boolean {
	return text.length > PASTE_PLACEHOLDER_THRESHOLD || text.includes("\n");
}

/** Compact stand-in for one paste. `#seq` keeps multiple pastes distinct. */
export function makePasteToken(seq: number, chars: number): string {
	return `[Pasted ${chars} chars #${seq}]`;
}

export const PASTE_TOKEN_RE = /\[Pasted \d+ chars #\d+\]/g;

/** The opening a scan can check for before it bothers to look for the rest. */
const PASTE_TOKEN_PREFIX = "[Pasted ";

/** The same token, anchored — `PASTE_TOKEN_RE` is global and its state is shared. */
const PASTE_TOKEN_ONE = /^\[Pasted \d+ chars #\d+\]$/;

/**
 * Every character a token is made of, and nothing else.
 *
 * A fast reject for {@link pasteTokenAt}, and the reason that scan is affordable:
 * a character outside this set cannot be inside a token, so the one that would
 * otherwise walk the buffer backwards never starts. Spelled out rather than
 * derived from the format, because a format that grows a character this set does
 * not know would quietly make every token editable again — so
 * `editing.test.ts` holds this against `makePasteToken`'s own output.
 */
export const PASTE_TOKEN_CHARACTERS: ReadonlySet<string> = new Set([
	"[",
	"]",
	" ",
	"#",
	..."0123456789",
	..."Pastedchars",
]);

/**
 * The half-open range `[start, end)` of the paste token covering `pos`, or null
 * when `pos` is not inside one. The token's first character counts as inside: it
 * is the one position a caret may stand on, and the interior is not a position
 * any motion may land on.
 *
 * Only the nearest `[` at or before `pos` can open the token — a token's interior
 * holds no `[` of its own — so if that one does not open a token, no earlier one
 * does either, and the scan stops there instead of walking the buffer back to the
 * start. That, plus {@link PASTE_TOKEN_CHARACTERS}, is what keeps the answer
 * cheap for the buffers that have no token in them, which is nearly all of them.
 */
export function pasteTokenAt(text: string, pos: number): { start: number; end: number } | null {
	if (pos < 0 || pos >= text.length) return null;
	if (!PASTE_TOKEN_CHARACTERS.has(text[pos] as string)) return null;
	const start = text.lastIndexOf("[", pos);
	if (start < 0 || !text.startsWith(PASTE_TOKEN_PREFIX, start)) return null;
	const close = text.indexOf("]", start);
	if (close < 0) return null;
	const end = close + 1;
	if (pos >= end || !PASTE_TOKEN_ONE.test(text.slice(start, end))) return null;
	return { start, end };
}

/**
 * Expand placeholder tokens back to their payloads. Unknown tokens — usually
 * the remains of a partially deleted token — stay literal rather than
 * corrupting unrelated text.
 */
export function expandPasteTokens(text: string, map: Map<string, string>): string {
	return text.replace(PASTE_TOKEN_RE, (token) => map.get(token) ?? token);
}

/** Normalize terminal paste payloads: CRLF and lone CR become LF. */
export function normalizePaste(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}
