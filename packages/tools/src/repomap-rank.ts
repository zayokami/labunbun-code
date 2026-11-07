// P1 ranking: a file-level graph, PageRank with a personalization vector, and
// the definition order the map renders in. The shape follows Aider's
// `get_ranked_tags` closely; the comments call out the two places where this
// port deliberately does not copy it.
import type { RepoMapFileTags, RepoMapSnippetLine, RepoMapTag, RepoMapTagDefinitionKind } from "./repomap-tags.ts";

export interface RankedRepoMapDefinition {
	kind: "definition";
	path: string;
	name: string;
	line: number;
	definitionKind: RepoMapTagDefinitionKind;
	snippet: RepoMapSnippetLine[];
	/** Source lines in the file, used to decide whether the map ends in `⋮`. */
	fileLines: number;
	rank: number;
}

/** A file that contributed no definition to the ranked list. Aider renders it bare. */
export interface RankedRepoMapFile {
	kind: "file";
	path: string;
	rank: number;
}

export type RankedRepoMapEntry = RankedRepoMapDefinition | RankedRepoMapFile;

export interface RankRepoMapOptions {
	/** Files in the chat; their definitions are omitted and their references weigh 50x. */
	chatFiles?: readonly string[];
	/** Files mentioned by the user; they receive extra personalization. */
	mentionedFiles?: readonly string[];
	/** Identifiers mentioned by the user; they weigh 10x and personalize matching paths. */
	mentionedIdents?: readonly string[];
	/** PageRank damping. Default: 0.85, the networkx default Aider relies on. */
	alpha?: number;
}

interface GraphEdge {
	src: string;
	dst: string;
	weight: number;
	ident: string;
}

function normalizePath(path: string): string {
	return path.split("\\").join("/");
}

function toPathSet(paths: readonly string[] | undefined): Set<string> {
	return new Set((paths ?? []).map(normalizePath));
}

function identifierMultiplier(ident: string, mentionedIdents: ReadonlySet<string>, definers: number): number {
	let mul = 1;
	const isSnake = ident.includes("_") && /[A-Za-z]/.test(ident);
	const isKebab = ident.includes("-") && /[A-Za-z]/.test(ident);
	const isCamel = /[A-Z]/.test(ident) && /[a-z]/.test(ident);
	if (mentionedIdents.has(ident)) mul *= 10;
	if ((isSnake || isKebab || isCamel) && ident.length >= 8) mul *= 10;
	if (ident.startsWith("_")) mul *= 0.1;
	if (definers > 5) mul *= 0.1;
	return mul;
}

interface RankedGraph {
	nodes: Set<string>;
	edges: GraphEdge[];
}

function buildGraph(
	files: readonly RepoMapFileTags[],
	chatFiles: ReadonlySet<string>,
	mentionedIdents: ReadonlySet<string>,
): { graph: RankedGraph; definitions: Map<string, RepoMapTag[]>; allPaths: string[] } {
	const defines = new Map<string, Set<string>>();
	const references = new Map<string, string[]>();
	const definitions = new Map<string, RepoMapTag[]>();
	const allPaths: string[] = [];

	const definitionKey = (path: string, name: string) => `${path}\0${name}`;

	for (const file of files) {
		allPaths.push(file.path);
		for (const tag of file.tags) {
			if (tag.kind === "def") {
				let definers = defines.get(tag.name);
				if (!definers) {
					definers = new Set();
					defines.set(tag.name, definers);
				}
				definers.add(file.path);
				const key = definitionKey(file.path, tag.name);
				const list = definitions.get(key);
				if (list) list.push(tag);
				else definitions.set(key, [tag]);
			} else {
				const list = references.get(tag.name);
				if (list) list.push(file.path);
				else references.set(tag.name, [file.path]);
			}
		}
	}

	// Some grammars report definitions but no references. Aider falls back to
	// treating every definition as a reference so the graph is still connected;
	// this slice's grammars do report calls, but an unusual file can still be
	// definition-only.
	if (references.size === 0) {
		for (const [name, definers] of defines) references.set(name, [...definers]);
	}

	const nodes = new Set<string>();
	const edges: GraphEdge[] = [];
	for (const [ident, definers] of defines) {
		if (!references.has(ident)) {
			for (const definer of definers) {
				nodes.add(definer);
				edges.push({ src: definer, dst: definer, weight: 0.1, ident });
			}
			continue;
		}
		const counts = new Map<string, number>();
		for (const referencer of references.get(ident) as string[]) {
			counts.set(referencer, (counts.get(referencer) ?? 0) + 1);
		}
		const mul = identifierMultiplier(ident, mentionedIdents, definers.size);
		for (const [referencer, count] of counts) {
			const useMul = mul * (chatFiles.has(referencer) ? 50 : 1);
			// Aider takes the square root inside the definer loop, so a name with
			// several definers decays once per definer. That looks accidental; the
			// square root is applied once here.
			const weight = useMul * Math.sqrt(count);
			for (const definer of definers) {
				nodes.add(referencer);
				nodes.add(definer);
				edges.push({ src: referencer, dst: definer, weight, ident });
			}
		}
	}
	return { graph: { nodes, edges }, definitions, allPaths };
}

/**
 * PageRank over a weighted multigraph, with the same iteration networkx uses:
 * dangling mass is spread by the dangling vector, teleportation by the
 * personalization vector, both normalized to sum to one.
 */
function pageRank(
	graph: RankedGraph,
	personalization: ReadonlyMap<string, number>,
	alpha: number,
): Map<string, number> {
	const nodes = [...graph.nodes].sort();
	const rank = new Map<string, number>();
	if (nodes.length === 0) return rank;
	const index = new Map(nodes.map((node, i) => [node, i]));
	const outWeight = new Array<number>(nodes.length).fill(0);
	const incoming: Array<Array<[number, number]>> = nodes.map(() => []);
	for (const edge of graph.edges) {
		const src = index.get(edge.src) as number;
		const dst = index.get(edge.dst) as number;
		outWeight[src] += edge.weight;
		incoming[dst].push([src, edge.weight]);
	}
	const rawPersonal = nodes.map((node) => personalization.get(node) ?? 1 / nodes.length);
	const personalSum = rawPersonal.reduce((sum, value) => sum + value, 0);
	const personal =
		personalSum > 0 ? rawPersonal.map((value) => value / personalSum) : rawPersonal.map(() => 1 / nodes.length);
	// Aider passes the personalization map as `dangling` too. With no map there
	// is no dangling vector, and networkx falls back to the personalization.
	const dangling = personal;
	let x = nodes.map(() => 1 / nodes.length);
	for (let iteration = 0; iteration < 100; iteration++) {
		const previous = x;
		let danglingMass = 0;
		for (let i = 0; i < nodes.length; i++) if (outWeight[i] === 0) danglingMass += previous[i];
		x = nodes.map((_, dst) => {
			let incomingMass = 0;
			for (const [src, weight] of incoming[dst]) incomingMass += previous[src] * (weight / outWeight[src]);
			return alpha * (incomingMass + danglingMass * dangling[dst]) + (1 - alpha) * personal[dst];
		});
		let error = 0;
		for (let i = 0; i < nodes.length; i++) error += Math.abs(x[i] - previous[i]);
		if (error < nodes.length * 1e-6) break;
	}
	for (let i = 0; i < nodes.length; i++) rank.set(nodes[i], x[i]);
	return rank;
}

function compareRanked(
	a: { rank: number; path: string; name: string },
	b: { rank: number; path: string; name: string },
): number {
	if (a.rank !== b.rank) return b.rank - a.rank;
	// Aider sorts `(rank, (fname, ident))` in reverse; equal ranks are therefore
	// ordered by path and then name, descending.
	if (a.path !== b.path) return a.path < b.path ? 1 : -1;
	if (a.name !== b.name) return a.name < b.name ? 1 : -1;
	return 0;
}

/**
 * Rank every definition against the file graph and append a bare entry for
 * files that contributed none. The result is what the renderer budgets.
 */
export function rankRepoMap(files: readonly RepoMapFileTags[], options: RankRepoMapOptions = {}): RankedRepoMapEntry[] {
	const chatFiles = toPathSet(options.chatFiles);
	const mentionedFiles = toPathSet(options.mentionedFiles);
	const mentionedIdents = new Set(options.mentionedIdents ?? []);
	const { graph, definitions, allPaths } = buildGraph(files, chatFiles, mentionedIdents);
	if (files.length === 0) return [];

	const personalize = 100 / files.length;
	const personalization = new Map<string, number>();
	for (const file of files) {
		let current = 0;
		if (chatFiles.has(file.path)) current += personalize;
		if (mentionedFiles.has(file.path)) current = Math.max(current, personalize);
		const parts = file.path.split("/");
		const basename = parts[parts.length - 1] ?? file.path;
		const dot = basename.lastIndexOf(".");
		const withoutExtension = dot > 0 ? basename.slice(0, dot) : basename;
		let matched = false;
		for (const component of parts) if (mentionedIdents.has(component)) matched = true;
		if (mentionedIdents.has(basename) || mentionedIdents.has(withoutExtension)) matched = true;
		if (matched) current += personalize;
		if (current > 0) personalization.set(file.path, current);
	}

	const rank = pageRank(graph, personalization, options.alpha ?? 0.85);

	// Distribute each source's rank across its out-edges and accumulate the share
	// that lands on each (definition file, identifier) pair.
	const outWeight = new Map<string, number>();
	for (const edge of graph.edges) outWeight.set(edge.src, (outWeight.get(edge.src) ?? 0) + edge.weight);
	const distributed = new Map<string, { path: string; name: string; rank: number }>();
	for (const edge of graph.edges) {
		const srcRank = rank.get(edge.src) ?? 0;
		const total = outWeight.get(edge.src) ?? 0;
		if (total === 0) continue;
		const share = (srcRank * edge.weight) / total;
		const key = `${edge.dst}\0${edge.ident}`;
		const entry = distributed.get(key);
		if (entry) entry.rank += share;
		else distributed.set(key, { path: edge.dst, name: edge.ident, rank: share });
	}

	const ordered = [...distributed.values()].sort(compareRanked);
	const entries: RankedRepoMapEntry[] = [];
	const includedPaths = new Set<string>();
	const fileLines = new Map(files.map((file) => [file.path, file.lineCount]));
	for (const item of ordered) {
		if (chatFiles.has(item.path)) continue;
		const tags = definitions.get(`${item.path}\0${item.name}`) ?? [];
		for (const tag of tags) {
			entries.push({
				kind: "definition",
				path: tag.path,
				name: tag.name,
				line: tag.line,
				definitionKind: tag.definitionKind ?? "function",
				snippet: tag.snippet ?? [],
				fileLines: fileLines.get(tag.path) ?? 0,
				rank: item.rank,
			});
			includedPaths.add(tag.path);
		}
	}

	// Files with no reachable definitions still show up as a bare name, ordered
	// by the rank they received as graph nodes, then by path. Aider's final set
	// is unordered; this port sorts it so two runs produce the same bytes.
	const rankedNodes = [...rank.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
	const remaining = new Set(allPaths);
	for (const path of includedPaths) remaining.delete(path);
	for (const path of chatFiles) remaining.delete(path);
	for (const [path, value] of rankedNodes) {
		if (!remaining.delete(path) || chatFiles.has(path)) continue;
		entries.push({ kind: "file", path, rank: value });
	}
	for (const path of [...remaining].sort()) entries.push({ kind: "file", path, rank: 0 });
	return entries;
}
