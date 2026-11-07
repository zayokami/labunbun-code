// The P1 pipeline in one call: scan tags, rank the file graph, render under a
// token budget. P2 wraps this in a tool; until then the benchmark and tests use
// the stages directly when they need the intermediate values.
import type { RepoMapOps } from "./repomap.ts";
import { type RankedRepoMapEntry, type RankRepoMapOptions, rankRepoMap } from "./repomap-rank.ts";
import { type RenderedRepoMap, type RenderRepoMapOptions, renderRepoMap } from "./repomap-render.ts";
import { buildRepoMapTags, type RepoMapTagsOptions, type RepoMapTagsStats } from "./repomap-tags.ts";

export interface GenerateRepoMapOptions extends RepoMapTagsOptions, RankRepoMapOptions {
	render?: RenderRepoMapOptions;
}

export interface GeneratedRepoMap {
	rendered: RenderedRepoMap;
	entries: RankedRepoMapEntry[];
	stats: RepoMapTagsStats;
}

export async function generateRepoMap(
	root: string,
	ops: RepoMapOps,
	options: GenerateRepoMapOptions = {},
): Promise<GeneratedRepoMap> {
	const scan = await buildRepoMapTags(root, ops, options);
	const entries = rankRepoMap(scan.files, options);
	const rendered = renderRepoMap(entries, options.render);
	return { rendered, entries, stats: scan.stats };
}
