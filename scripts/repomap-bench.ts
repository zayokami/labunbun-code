#!/usr/bin/env bun
/**
 * Cold/hot benchmark for the P0 repository map.
 *
 * The question this answers is whether a full scan is cheap enough to put in
 * front of a model at all: how long does the first pass over a hundred thousand
 * lines take, and how long does the second pass take once every unchanged file
 * comes back from the in-memory cache. A cold run reads and parses; a hot run
 * only stats the files.
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
import { buildRepoMap, InMemoryRepoMapCache, type RepoMapResult } from "../packages/tools/src/repomap.ts";

const FILE_COUNT = 100;
const BLOCKS_PER_FILE = 100;

/** Ten lines per block, so 100 files x 100 blocks is 100,000 lines. */
function syntheticFile(index: number): string {
	const lines: string[] = [`export interface Row${index} { id: number; label: string }`];
	for (let block = 0; block < BLOCKS_PER_FILE; block++) {
		lines.push(
			`export function fn${index}_${block}(value: number): number { return value + ${block}; }`,
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

function report(label: string, result: RepoMapResult): void {
	const { stats } = result;
	const tokens = Math.ceil(result.text.length / 4);
	console.log(
		`${label.padEnd(5)} ${stats.elapsedMs.toFixed(0).padStart(5)}ms  ` +
			`parsed=${stats.parsed}  cached=${stats.cached}  skipped=${stats.skipped}  ` +
			`files=${stats.files}  defs=${stats.definitions}  ` +
			`map=${result.text.length} chars (~${tokens} tokens)`,
	);
}

async function bench(root: string, description: string): Promise<void> {
	const ops = new NodeFileSystemOperations();
	const cache = new InMemoryRepoMapCache();
	console.log(`\n${description}`);
	const cold = await buildRepoMap(root, ops, { cache });
	report("cold", cold);
	const hot = await buildRepoMap(root, ops, { cache });
	report("hot", hot);
	if (hot.text !== cold.text) {
		console.error("HOT MAP DIFFERS FROM COLD MAP");
		process.exitCode = 1;
	}
}

const argument = process.argv[2];
if (argument) {
	const root = resolve(argument);
	await bench(root, `Repo Map P0 — ${root}`);
} else {
	const { root, lines } = makeSynthetic();
	try {
		await bench(root, `Repo Map P0 — synthetic (${FILE_COUNT} files, ${lines.toLocaleString("en-US")} lines)`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
