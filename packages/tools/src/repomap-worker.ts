// The parser worker for `repomap-worker-pool.ts`. It owns one Parser and loads
// each grammar once, so a scan of ten thousand files pays for the WASM once per
// worker rather than once per file. The pool sends one job at a time.
//
// This file must stay a build entrypoint: `bun build --compile` does not find a
// worker reached only through `new URL(…, import.meta.url)` on its own.
import { parentPort } from "node:worker_threads";
import { Parser } from "web-tree-sitter";
import type { RepoMapLanguage } from "./repomap-languages.ts";
import { extractTags, type RepoMapFileTags } from "./repomap-tags.ts";
import { initRepoMapParser, loadRepoMapGrammar } from "./repomap-wasm.ts";
import type { RepoMapWorkerJob, RepoMapWorkerReply } from "./repomap-worker-pool.ts";

let parser: Parser | null = null;
// One Parser holds one language at a time. A job does not remember which grammar
// the previous one set, so track it here; a "grammar loaded" set would skip
// `setLanguage` after a job in another language and parse `.ts` as JavaScript.
let current: RepoMapLanguage | null = null;

async function extract(job: RepoMapWorkerJob): Promise<RepoMapFileTags> {
	if (!parser) {
		await initRepoMapParser();
		parser = new Parser();
	}
	if (current !== job.language) {
		parser.setLanguage(await loadRepoMapGrammar(job.language));
		current = job.language;
	}
	const tree = parser.parse(job.source);
	if (!tree) return { path: job.path, tags: [], lineCount: 0 };
	try {
		return extractTags(tree, job.source, job.path, {
			maxSnippetLines: job.maxSnippetLines,
			language: job.language,
		});
	} finally {
		tree.delete();
	}
}

parentPort?.on("message", (job: RepoMapWorkerJob) => {
	void extract(job).then(
		(data) => {
			const reply: RepoMapWorkerReply = { id: job.id, data };
			parentPort?.postMessage(reply);
		},
		(error: unknown) => {
			const reply: RepoMapWorkerReply = {
				id: job.id,
				error: error instanceof Error ? error.message : String(error),
			};
			parentPort?.postMessage(reply);
		},
	);
});
