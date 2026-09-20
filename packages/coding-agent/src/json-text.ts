/**
 * Text that has just been read off disk, made parseable.
 *
 * A UTF-8 byte-order mark is what several Windows editors write in front of a
 * file without being asked, and PowerShell's `Set-Content` writes one by
 * default. `JSON.parse` refuses it — "Unexpected token" at position 0 — so a
 * settings file a user edited and saved is otherwise reported as broken, or,
 * worse, silently discarded by callers that treat a parse failure as "no file".
 * The mark is an encoding signature, not content, so dropping it is the whole
 * of the repair.
 */
export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
