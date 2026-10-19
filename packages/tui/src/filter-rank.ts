/**
 * Type-to-filter ranking for the pickers and the slash menu.
 *
 * A picker list is short, and the user is usually typing a word they already
 * see on the row: a session's title, a model's name, a theme. Four tiers are
 * enough to put the row they mean first without pretending to be a search
 * engine — the ordering is stable, so the same query always draws the same
 * list, which is what makes the keyboard path learnable.
 */

/** 0 prefix · 1 word-start prefix · 2 substring · 3 subsequence. Lower wins. */
export type MatchTier = 0 | 1 | 2 | 3;

export interface RankOptions {
	/**
	 * Whether the loosest tier is offered. It is right for a short picker of
	 * names, where a scattered match is still a clue. It is wrong for the slash
	 * menu: "the" is a subsequence of "Set thinking level", and a command list
	 * that seems to answer a word the user never typed is worse than no match.
	 */
	subsequence?: boolean;
}

/**
 * Indices of `items` that match `query`, best tier first, original order
 * within a tier. The caller gets indices because the row it wanted to resolve
 * is the row it showed, not the row the filter moved it to.
 *
 * `fields` returns the strings a row can be found by — typically a label and a
 * description. An item matches when any field matches, and its tier is the
 * best one across those fields; a word in the description that starts the
 * query should not lose to a worse match in the label.
 */
export function rankItems<T>(
	items: readonly T[],
	query: string,
	fields: (item: T) => readonly string[],
	options: RankOptions = {},
): number[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return items.map((_, index) => index);
	const allowSubsequence = options.subsequence ?? true;

	const ranked: Array<{ index: number; tier: MatchTier }> = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (item === undefined) continue;
		let best: MatchTier | undefined;
		for (const field of fields(item)) {
			const tier = matchTier(field.toLowerCase(), needle, allowSubsequence);
			if (tier === undefined) continue;
			if (best === undefined || tier < best) best = tier;
			if (best === 0) break;
		}
		if (best !== undefined) ranked.push({ index, tier: best });
	}

	// Stable at both levels: tier, then the order the caller supplied. A list
	// that reshuffles equal matches would move under the arrow keys for no
	// reason the user can see.
	ranked.sort((a, b) => a.tier - b.tier || a.index - b.index);
	return ranked.map((entry) => entry.index);
}

function matchTier(haystack: string, needle: string, allowSubsequence: boolean): MatchTier | undefined {
	if (haystack.startsWith(needle)) return 0;
	if (hasWordStartPrefix(haystack, needle)) return 1;
	if (haystack.includes(needle)) return 2;
	if (allowSubsequence && isSubsequence(haystack, needle)) return 3;
	return undefined;
}

/**
 * Does `needle` start a word anywhere in `haystack`? `/rename` counts: `/` is
 * a boundary, and a user typing "rename" should not have to remember the
 * slash.
 */
function hasWordStartPrefix(haystack: string, needle: string): boolean {
	let from = 0;
	while (true) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return false;
		if (at === 0 || isWordBoundary(haystack[at - 1] ?? "")) return true;
		from = at + 1;
	}
}

/**
 * Whitespace, punctuation, and symbols end a word. Deliberately not `\b`:
 * that treats `_` as a word character, so "resume" would not match
 * `resume_session` at the underscore, and it is blind to non-ASCII breaks.
 */
function isWordBoundary(character: string): boolean {
	return /[\s\p{P}\p{S}]/u.test(character);
}

function isSubsequence(haystack: string, needle: string): boolean {
	const wanted = Array.from(needle);
	let at = 0;
	for (const character of haystack) {
		if (character === wanted[at]) at++;
		if (at === wanted.length) return true;
	}
	return wanted.length === 0;
}
