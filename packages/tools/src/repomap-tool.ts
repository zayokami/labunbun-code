/**
 * RepoMap — the ranked outline of the repository, as a tool.
 *
 * Search is how a model finds one symbol it can already name; this is the tool
 * for not knowing what is there. It returns the definitions Aider-style ranking
 * judged most central (the ones other files call), with a bounded snippet of
 * each, and it reports how much of the repository the budget left out — because
 * a map that silently stops is a map the model reads as complete. The scan is
 * read-only and served from the session's cache, so asking twice is cheap.
 *
 * Long-form design notes: docs/dev/repomap.md (P2).
 */
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import type { RepoMapOps } from "./repomap.ts";
import { RepoMapService, type RepoMapSummary } from "./repomap-service.ts";

export interface RepoMapToolOptions {
	operations: RepoMapOps;
	/** Share the session's service with `/map` and the system prompt. */
	service?: RepoMapService;
	/** Only used when no service is given: a SQLite cache path, or in-memory when absent. */
	cachePath?: string;
}

/** The tool result: the rendered map, then one line saying how complete it is. */
export function formatRepoMapResult(summary: RepoMapSummary): string {
	if (!summary.text) {
		return `RepoMap: no functions, classes or methods found under ${summary.root}.`;
	}
	const scope = summary.partial
		? `${summary.definitions.toLocaleString()} of ${summary.totalDefinitions.toLocaleString()} definitions ` +
			`in ${summary.files.toLocaleString()} of ${summary.totalFiles.toLocaleString()} files`
		: `${summary.definitions.toLocaleString()} definitions in ${summary.files.toLocaleString()} ` +
			`file${summary.files === 1 ? "" : "s"}`;
	const hints: string[] = [];
	if (summary.partial) hints.push("Raise maxTokens to see more.");
	// The budget note and the tree note answer different questions: one is about
	// what the ranking left out, the other about files never looked at at all.
	if (summary.truncated) hints.push("The scan stopped at its file ceiling, so the rest of the tree is unindexed.");
	const hint = hints.length > 0 ? ` ${hints.join(" ")}` : "";
	const footer = `Repo map: ${scope}, ~${summary.tokens.toLocaleString()} tokens, ${(summary.elapsedMs / 1000).toFixed(1)}s.${hint}`;
	return `${summary.text}\n\n${footer}`;
}

export function createRepoMapTool(cwd: string, options: RepoMapToolOptions): AnyTool {
	const service =
		options.service ?? new RepoMapService({ root: cwd, ops: options.operations, cachePath: options.cachePath });
	return buildTool({
		name: "RepoMap",
		description:
			"Shows the repository's most-referenced functions, classes and methods with a snippet of each, ranked " +
			"by how much the rest of the code calls into them and fitted to a token budget. Use it to learn the " +
			"shape of an unfamiliar repository before searching file by file. Read-only.",
		inputSchema: z.object({
			path: z.string().optional().describe("Directory to map, relative to the workspace root (default: the root)"),
			maxTokens: z.number().int().optional().describe("Token budget for the map (default 1024, clamped to 128-16384)"),
			refresh: z.boolean().optional().describe("Ignore the cache and re-read every file"),
		}),
		prompt:
			"- Use RepoMap when you do not yet know which files matter; it ranks definitions by the calls that reach " +
			"them. Then Read the files it names rather than mapping again.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		// A maximum-budget map is roughly 64,000 characters; the footer fits beside it.
		maxResultSizeChars: 80_000,
		call: async (input) => {
			try {
				const summary = await service.map(input);
				return { content: [{ type: "text", text: formatRepoMapResult(summary) }] };
			} catch (error) {
				// A path outside the workspace or a directory that cannot be read is
				// the caller's input, not a harness failure: say so in the result.
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				};
			}
		},
	});
}
