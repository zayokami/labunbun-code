/**
 * Reverse history search — readline's Ctrl+R.
 *
 * ↑ walks history one entry at a time, which is the wrong tool for the case
 * people actually have: they remember a few words of a prompt they typed an
 * hour ago, not how many prompts ago it was.
 */

export interface HistorySearchState {
	query: string;
	/** Which match is selected; counts backwards from the newest. */
	index: number;
}

/** How many matches are shown at once. */
export const HISTORY_SEARCH_MAX = 5;

/**
 * Entries containing `query`, newest first.
 *
 * Case-insensitive: nobody recalls the capitalisation of their own command.
 */
export function historyMatches(history: string[], query: string, max = HISTORY_SEARCH_MAX): string[] {
	const needle = query.toLowerCase();
	const matches: string[] = [];
	for (let i = history.length - 1; i >= 0 && matches.length < max; i--) {
		if (history[i].toLowerCase().includes(needle)) matches.push(history[i]);
	}
	return matches;
}

/**
 * Which match the search currently points at. Wraps like the suggestion lists
 * do, so walking past the oldest match comes back around instead of dead-ending.
 * `-1` when there is nothing to point at.
 */
export function searchSelectionIndex(matches: string[], index: number): number {
	if (matches.length === 0) return -1;
	return ((index % matches.length) + matches.length) % matches.length;
}

/** The match the search currently points at, if any. */
export function searchSelection(matches: string[], index: number): string | undefined {
	return matches[searchSelectionIndex(matches, index)];
}
