#!/usr/bin/env bun
/**
 * Cold/hot benchmark for the P1 repository map.
 *
 * The question this answers is whether the full pipeline — tree-sitter tags,
 * the file graph, PageRank, and the token-budgeted render — is cheap enough to
 * run in front of a model. A cold run reads and parses every file; a hot run
 * stats them and serves tags from the shared in-memory cache.
 *
 * Usage:
 *   bun run scripts/repomap-bench.ts               synthetic ~100k-line repository
 *   bun run scripts/repomap-bench.ts <root>        an existing checkout
 *
 * The synthetic tree is built under the OS temp directory and removed before
 * the script exits; a real root is only read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeFileSystemOperations } from "../packages/tools/src/operations.ts";
import { InMemoryRepoMapCache } from "../packages/tools/src/repomap.ts";
import { type RankedRepoMapEntry, rankRepoMap } from "../packages/tools/src/repomap-rank.ts";
import { type RenderedRepoMap, renderRepoMap } from "../packages/tools/src/repomap-render.ts";
import { buildRepoMapTags, type RepoMapFileTags } from "../packages/tools/src/repomap-tags.ts";
import { defaultRepoMapParseWorkers } from "../packages/tools/src/repomap-worker-pool.ts";

/** `REPOMAP_BENCH_WORKERS=0` measures the same tree without parser threads. */
const PARSE_WORKERS = process.env.REPOMAP_BENCH_WORKERS === "0" ? 0 : defaultRepoMapParseWorkers();

const FILE_COUNT = 100;
const BLOCKS_PER_FILE = 100;
const BUDGETS = [1024, 4096];

/** Ten lines per block, so 100 files x 100 blocks is ~100,000 lines. */
function syntheticFile(index: number): string {
	const lines: string[] = [`export interface Row${index} { id: number; label: string }`];
	const next = (index + 1) % FILE_COUNT;
	for (let block = 0; block < BLOCKS_PER_FILE; block++) {
		lines.push(
			`export function fn${index}_${block}(value: number): number { return fn${next}_${block}(value + ${block}); }`,
			`class Box${index}_${block} { get() { return ${block}; } }`,
			`const cell${index}_${block} = (value: number) => value * ${block};`,
			`type Shape${index}_${block} = { value: number };`,
			`const plain${index}_${block} = ${block};`,
			`function local${index}_${block}() { function nested() {} return nested; }`,
			`// filler line ${block}`,
			`export enum Kind${index}_${block} { A, B }`,
			`export const config${index}_${block} = { on: true, value: ${block} };`,
			"",
		);
	}
	return lines.join("\n");
}

function makeSynthetic(): { root: string; lines: number } {
	const root = mkdtempSync(join(tmpdir(), "lbb-repomap-bench-"));
	mkdirSync(join(root, "src"));
	for (let file = 0; file < FILE_COUNT; file++) {
		writeFileSync(join(root, "src", `file${file}.ts`), syntheticFile(file));
	}
	return { root, lines: FILE_COUNT * (1 + BLOCKS_PER_FILE * 10) };
}

interface Pass {
	scanMs: number;
	rankMs: number;
	parsed: number;
	cached: number;
	definitions: number;
	references: number;
	entries: RankedRepoMapEntry[];
	maps: Map<number, { rendered: RenderedRepoMap; renderMs: number }>;
}

async function runPass(root: string, cache: InMemoryRepoMapCache<RepoMapFileTags>): Promise<Pass> {
	const ops = new NodeFileSystemOperations();
	// Same worker count the service uses; a hot pass never reaches the parse
	// threshold, so it still measures the cache path with no threads started.
	const scan = await buildRepoMapTags(root, ops, { cache, parseWorkers: PARSE_WORKERS });
	const rankStarted = performance.now();
	const entries = rankRepoMap(scan.files);
	const rankMs = performance.now() - rankStarted;
	const maps = new Map<number, { rendered: RenderedRepoMap; renderMs: number }>();
	for (const budget of BUDGETS) {
		const started = performance.now();
		const rendered = renderRepoMap(entries, { tokenBudget: budget });
		maps.set(budget, { rendered, renderMs: performance.now() - started });
	}
	return {
		scanMs: scan.stats.elapsedMs,
		rankMs,
		parsed: scan.stats.parsed,
		cached: scan.stats.cached,
		definitions: scan.stats.definitions,
		references: scan.stats.references,
		entries,
		maps,
	};
}

function report(label: string, pass: Pass): void {
	console.log(
		`${label.padEnd(5)} scan=${pass.scanMs.toFixed(0).padStart(6)}ms  rank=${pass.rankMs.toFixed(0).padStart(4)}ms  ` +
			`parsed=${pass.parsed}  cached=${pass.cached}  defs=${pass.definitions}  refs=${pass.references}  ` +
			`ranked=${pass.entries.length}`,
	);
	for (const budget of BUDGETS) {
		const { rendered, renderMs } = pass.maps.get(budget) as { rendered: RenderedRepoMap; renderMs: number };
		console.log(
			`      budget=${String(budget).padStart(4)}  render=${renderMs.toFixed(0).padStart(4)}ms  ` +
				`defs=${rendered.definitions}  files=${rendered.files}  ` +
				`map=${rendered.text.length} chars (~${rendered.tokens} tokens)`,
		);
	}
}

async function bench(root: string, description: string): Promise<void> {
	const cache = new InMemoryRepoMapCache<RepoMapFileTags>();
	console.log(`\n${description} (parse workers: ${PARSE_WORKERS})`);
	const cold = await runPass(root, cache);
	report("cold", cold);
	const hot = await runPass(root, cache);
	report("hot", hot);
	for (const budget of BUDGETS) {
		if (
			(hot.maps.get(budget) as { rendered: RenderedRepoMap }).rendered.text !== cold.maps.get(budget)?.rendered.text
		) {
			console.error(`HOT MAP AT BUDGET ${budget} DIFFERS FROM COLD MAP`);
			process.exitCode = 1;
		}
	}
}

const argument = process.argv[2];
if (argument) {
	const root = resolve(argument);
	await bench(root, `Repo Map P1 — ${root}`);
} else {
	const { root, lines } = makeSynthetic();
	try {
		await bench(root, `Repo Map P1 — synthetic (${FILE_COUNT} files, ${lines.toLocaleString("en-US")} lines)`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
