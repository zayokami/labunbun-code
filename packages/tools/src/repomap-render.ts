// P1 rendering: turn the ranked list into the text a model sees, under a token
// budget. The budget search is Aider's: probe a number of ranked entries, count
// the rendered text, and binary-search for the largest map that fits (or that
// lands within 15% of the budget, which avoids spending every probe on a
// marginal win).
import type { RankedRepoMapDefinition, RankedRepoMapEntry } from "./repomap-rank.ts";

export interface RepoMapBudgetOptions {
	/** Model input limit, when known. */
	maxInputTokens?: number;
	/** Whether the files being edited are already in the conversation. */
	hasChatFiles?: boolean;
	/** Small map for a conversation that already has files. Default: 1024. */
	mapTokens?: number;
	/** Multiplier when there are no chat files. Default: 8 (Aider's value). */
	mulNoFiles?: number;
	/** Space to leave for the reply and the rest of the prompt. Default: 4096. */
	padding?: number;
}

/**
 * The budget Aider would use: a small map when the conversation already has
 * files, a larger one when the map is the only repository context.
 */
export function repoMapTokenBudget(options: RepoMapBudgetOptions = {}): number {
	const mapTokens = options.mapTokens ?? 1024;
	if (!options.hasChatFiles && options.maxInputTokens !== undefined) {
		const target = Math.min(mapTokens * (options.mulNoFiles ?? 8), options.maxInputTokens - (options.padding ?? 4096));
		return Math.max(0, target);
	}
	return mapTokens;
}

export interface RenderRepoMapOptions {
	/** Default: 1024 tokens. */
	tokenBudget?: number;
	/** Default: four characters per token. Wire a real tokenizer here when one is available. */
	countTokens?: (text: string) => number;
	/** Relative error accepted above the budget. Default: 0.15, as in Aider. */
	tolerance?: number;
}

export interface RenderedRepoMap {
	text: string;
	tokens: number;
	definitions: number;
	files: number;
}

/** Four characters per token is Aider's rough estimate without a model tokenizer. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

interface RenderGroup {
	path: string;
	definitions: RankedRepoMapDefinition[];
}

function renderEntries(entries: readonly RankedRepoMapEntry[]): RenderedRepoMap {
	const groups = new Map<string, RenderGroup>();
	for (const entry of entries) {
		if (entry.kind === "definition") {
			const group = groups.get(entry.path);
			if (group) group.definitions.push(entry);
			else groups.set(entry.path, { path: entry.path, definitions: [entry] });
		} else if (!groups.has(entry.path)) {
			groups.set(entry.path, { path: entry.path, definitions: [] });
		}
	}
	const blocks: string[] = [];
	let files = 0;
	let definitions = 0;
	for (const path of [...groups.keys()].sort()) {
		const group = groups.get(path) as RenderGroup;
		if (group.definitions.length === 0) {
			blocks.push(path);
			files++;
			continue;
		}
		const lines = new Map<number, string>();
		let fileLines = 0;
		for (const definition of group.definitions) {
			definitions++;
			fileLines = Math.max(fileLines, definition.fileLines);
			for (const snippetLine of definition.snippet) {
				if (!lines.has(snippetLine.line)) lines.set(snippetLine.line, snippetLine.text);
			}
		}
		if (lines.size === 0) {
			blocks.push(path);
			files++;
			continue;
		}
		const ordered = [...lines.keys()].sort((a, b) => a - b);
		const rendered: string[] = [`${path}:`];
		if (ordered[0] > 1) rendered.push("⋮");
		for (let index = 0; index < ordered.length; index++) {
			const line = ordered[index];
			if (index > 0 && line > ordered[index - 1] + 1) rendered.push("⋮");
			rendered.push(`│${lines.get(line)}`);
		}
		const last = ordered[ordered.length - 1];
		if (fileLines > 0 && last < fileLines) rendered.push("⋮");
		blocks.push(rendered.join("\n"));
		files++;
	}
	return { text: blocks.join("\n\n"), tokens: 0, definitions, files };
}

/**
 * Render the head of `entries` that best fits the budget.
 *
 * The probe starts at `budget / 25` entries (Aider's estimate of the tokens one
 * entry costs). After the first render, the measured cost per entry names the
 * count the budget actually fits, so the search jumps there instead of halving
 * the interval — usually one more render finishes it. A probe is accepted when
 * it fits and is larger than the best so far, or when it lands within
 * `tolerance` of the budget; the latter stops the search early rather than
 * insisting on an exact fit. When `entries` is empty, the result is empty.
 */
export function renderRepoMap(
	entries: readonly RankedRepoMapEntry[],
	options: RenderRepoMapOptions = {},
): RenderedRepoMap {
	const budget = Math.max(0, options.tokenBudget ?? 1024);
	const count = options.countTokens ?? estimateTokens;
	const tolerance = options.tolerance ?? 0.15;
	let lower = 0;
	let upper = entries.length;
	let middle = Math.min(Math.floor(budget / 25), entries.length);
	let best: RenderedRepoMap | null = null;
	let bestTokens = 0;
	while (lower <= upper) {
		const rendered = renderEntries(entries.slice(0, middle));
		const tokens = count(rendered.text);
		const error = budget > 0 ? Math.abs(tokens - budget) / budget : 0;
		if ((tokens <= budget && tokens > bestTokens) || error < tolerance) {
			best = { ...rendered, tokens };
			bestTokens = tokens;
			if (error < tolerance) break;
		}
		if (tokens < budget) lower = middle + 1;
		else upper = middle - 1;
		const midpoint = Math.floor((lower + upper) / 2);
		// The first probe is only Aider's guess at what one entry costs; once it
		// is measured, the budget names the count directly. The estimate stays
		// inside the interval, so uneven entry sizes still converge through the
		// ordinary halvings.
		const perEntry = middle > 0 && budget > 0 ? tokens / middle : 0;
		const estimate = perEntry > 0 ? Math.round(budget / perEntry) : -1;
		middle = estimate >= lower && estimate <= upper ? estimate : midpoint;
	}
	return best ?? { text: "", tokens: 0, definitions: 0, files: 0 };
}
