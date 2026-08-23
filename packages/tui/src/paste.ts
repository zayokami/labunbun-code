/**
 * Large-paste handling. A terminal with bracketed paste enabled delivers the
 * whole payload as one event; pasting a file-sized blob into the buffer would
 * both flood the prompt and make the transcript unreadable. Long or multiline
 * payloads are folded into a compact placeholder token that is expanded back
 * to the original text only at submit time.
 *
 * Pure module: the token format, threshold, and expansion are testable without
 * a rendered frame.
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
