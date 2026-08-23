/**
 * @-mention file completion, pure and renderer-free.
 *
 * Typing `@src/ma` in the prompt selects the file under the cursor's word;
 * Tab replaces the partial mention with the real path. The file list itself
 * comes from a caller-supplied callback — this package has no filesystem
 * access, so the app layer decides what is listable.
 */

/** The @query word ending at `cursor`, or null when none is active. */
export function currentAtWord(text: string, cursor: number): string | null {
	// Walk back to the start of the word the caret sits in.
	let start = cursor;
	while (start > 0 && !/\s/.test(text[start - 1])) start--;
	if (start >= cursor) return null;
	if (text[start] !== "@") return null;
	const query = text.slice(start + 1, cursor);
	return query;
}

/**
 * Rank candidate paths against a query. Case-insensitive; segment-prefix
 * matches (a path component starting with the query) beat substring matches,
 * which beat subsequence matches. Equal ranks keep their input order so the
 * mtime-sorted list from the walker survives filtering.
 */
export function filterFiles(files: string[], query: string, cap = 8): string[] {
	if (!query) return files.slice(0, cap);
	const q = query.toLowerCase();
	const segmentPrefix: string[] = [];
	const substring: string[] = [];
	const subsequence: string[] = [];

	for (const file of files) {
		const f = file.toLowerCase();
		if (f.split("/").some((segment) => segment.startsWith(q))) {
			segmentPrefix.push(file);
		} else if (f.includes(q)) {
			substring.push(file);
		} else if (isSubsequence(q, f)) {
			subsequence.push(file);
		}
	}
	return [...segmentPrefix, ...substring, ...subsequence].slice(0, cap);
}

function isSubsequence(needle: string, haystack: string): boolean {
	let at = 0;
	for (const ch of needle) {
		at = haystack.indexOf(ch, at);
		if (at === -1) return false;
		at++;
	}
	return true;
}

/**
 * Replace the @word ending at `cursor` with the completed path. Paths with
 * spaces are double-quoted so they survive as one shell-ish token. A trailing
 * space separates the path from whatever the user types next.
 */
export function applyFileCompletion(text: string, cursor: number, path: string): { text: string; cursor: number } {
	let start = cursor;
	while (start > 0 && !/\s/.test(text[start - 1])) start--;
	const completed = /[\s"]/.test(path) ? `"${path}"` : `${path} `;
	return {
		text: text.slice(0, start) + completed + text.slice(cursor),
		cursor: start + completed.length,
	};
}
