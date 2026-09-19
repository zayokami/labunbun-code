/**
 * Text bound for a terminal control channel — the window title (OSC 0) or a
 * desktop notification (OSC 9) — rather than for Ink's frame buffer.
 *
 * Both are escape sequences we compose ourselves, so any text spliced into them
 * is interpreted by the terminal as part of that sequence. A directory name the
 * user did not choose, or a model-supplied string, can therefore end the
 * sequence early with BEL and forge a title of its own; a bidi override can
 * rewrite what the title appears to say. Ink sanitizes its own frame output but
 * knows nothing about writes we hand to stdout directly, which is why this
 * exists as a separate step.
 */

/**
 * Control characters (`Cc`: C0, DEL, C1) and format characters (`Cf`: the
 * zero-width marks, the bidi overrides and isolates, the BOM).
 *
 * Named by Unicode category rather than by code point so the set is complete by
 * construction — an enumerated range is only ever as good as the last person to
 * audit it.
 *
 * Global-flagged, so it carries `lastIndex` state between calls: use it with
 * `String.replace`/`match` (which reset it), never with `RegExp.test`.
 */
export const INVISIBLE_RE = /\p{Cc}|\p{Cf}/gu;

/**
 * Flatten text into a single safe line: control and invisible characters become
 * spaces, whitespace runs collapse, and the result is capped. Overlong input is
 * cut rather than ellipsised — a "…" would itself be a character the caller did
 * not ask for in a channel this narrow.
 */
export function sanitizeText(text: string, maxChars: number): string {
	const clean = text.replace(INVISIBLE_RE, " ").replace(/\s+/g, " ").trim();
	return clean.length > maxChars ? clean.slice(0, maxChars) : clean;
}
