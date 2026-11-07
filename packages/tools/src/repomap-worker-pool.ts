// A small pool of parser workers for a cold repository scan. Parsing is
// synchronous work on the main thread, so the scan's eight read workers keep
// the disk busy but still parse one file at a time. Handing the parse to a few
// threads lets a multi-core machine spend the cold-scan seconds in parallel.
//
// The pool is deliberately optional at every layer: starting a worker is the
// one step that can fail for reasons the map does not control (a packaging
// change, a platform that refuses threads), and the caller's fallback is the
// in-thread parse that existed before this module. A worker that dies mid-scan
// costs its own job the parallelism, not the map.
//
// Long-form design notes: docs/dev/repomap.md (Grammars and Measurements).
import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { RepoMapWorkerExtractor } from "./repomap.ts";
import type { RepoMapLanguage } from "./repomap-languages.ts";
import type { RepoMapFileTags } from "./repomap-tags.ts";

/** One parse job. `maxSnippetLines` is part of the extraction contract, not the grammar. */
export interface RepoMapWorkerJob {
	id: number;
	path: string;
	language: RepoMapLanguage;
	source: string;
	maxSnippetLines: number;
}

export type RepoMapWorkerReply = { id: number; data: RepoMapFileTags } | { id: number; error: string };

interface Slot {
	worker: Worker;
	current: {
		resolve: (data: RepoMapFileTags) => void;
		reject: (error: Error) => void;
	} | null;
	dead: boolean;
}

interface Queued {
	job: RepoMapWorkerJob;
	resolve: (data: RepoMapFileTags) => void;
	reject: (error: Error) => void;
}

/** Four workers keeps three cores for the rest of the process on a small machine. */
export function defaultRepoMapParseWorkers(): number {
	const cpus = availableParallelism();
	return cpus <= 1 ? 0 : Math.min(4, cpus - 1);
}

const WORKER_FILE = /^repomap-worker\.(?:js|mjs|cjs|ts)$/;

/** The part of a `Dirent` this search uses; `readdirSync`'s own type is generic per overload. */
interface DirectoryEntry {
	name: string;
	isFile(): boolean;
	isDirectory(): boolean;
}

function findWorkerFile(directory: string, depth = 0): string | null {
	if (depth > 8) return null;
	let entries: DirectoryEntry[];
	try {
		entries = readdirSync(directory, { withFileTypes: true }) as DirectoryEntry[];
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (entry.isFile() && WORKER_FILE.test(entry.name)) return join(directory, entry.name);
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const found = findWorkerFile(join(directory, entry.name), depth + 1);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Where the worker script lives.
 *
 * In a checkout it is the TypeScript file beside this module. In a
 * `bun build --compile` executable `import.meta.url` is the executable itself,
 * and an additional entrypoint is embedded under the build root — the path
 * gains the entries' common ancestor (`tools/src/…`, not `src/…`), so the
 * sibling URL does not exist. The virtual root is small, so look for the entry
 * there. A build that omitted the entrypoint finds nothing and parses in the
 * calling thread, which is the pool's documented fallback.
 */
function findWorkerScript(): string | null {
	const beside = fileURLToPath(new URL("./repomap-worker.ts", import.meta.url));
	if (existsSync(beside)) return beside;
	return findWorkerFile(fileURLToPath(new URL("./", import.meta.url)));
}

/**
 * Start `size` parser workers. Returns `null` when none could be started, which
 * is the caller's signal to parse on its own thread; a scan with no parse work
 * never calls this.
 */
export function createRepoMapWorkerPool(
	size: number,
	maxSnippetLines: number,
): RepoMapWorkerExtractor<RepoMapFileTags> | null {
	if (size < 1) return null;
	const script = findWorkerScript();
	if (script === null) return null;
	const slots: Slot[] = [];
	const queue: Queued[] = [];
	let nextId = 0;
	let closed = false;

	function pump(): void {
		if (closed) return;
		while (queue.length > 0) {
			const slot = slots.find((candidate) => !candidate.dead && candidate.current === null);
			if (!slot) break;
			const next = queue.shift() as Queued;
			slot.current = { resolve: next.resolve, reject: next.reject };
			try {
				slot.worker.postMessage(next.job);
			} catch (error) {
				// A worker that has already terminated cannot take the job. Marking it
				// dead here keeps the rejection path the same as an `exit` event.
				slot.current = null;
				slot.dead = true;
				void slot.worker.terminate();
				next.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (queue.length > 0 && slots.every((slot) => slot.dead)) {
			const error = new Error("RepoMap worker pool has no live workers");
			for (const queued of queue.splice(0)) queued.reject(error);
		}
	}

	function settle(slot: Slot, reply: RepoMapWorkerReply): void {
		const pending = slot.current;
		if (!pending) return;
		slot.current = null;
		if ("error" in reply) pending.reject(new Error(reply.error));
		else pending.resolve(reply.data);
		pump();
	}

	function failSlot(slot: Slot, error: Error): void {
		if (slot.dead || closed) return;
		slot.dead = true;
		const pending = slot.current;
		slot.current = null;
		pending?.reject(error);
		void slot.worker.terminate();
		if (slots.every((candidate) => candidate.dead)) {
			for (const queued of queue.splice(0)) queued.reject(error);
			return;
		}
		pump();
	}

	try {
		for (let index = 0; index < size; index++) {
			const worker = new Worker(script);
			const slot: Slot = { worker, current: null, dead: false };
			worker.on("message", (reply: RepoMapWorkerReply) => settle(slot, reply));
			worker.on("error", (error: Error) => failSlot(slot, error));
			worker.on("exit", (code: number) => failSlot(slot, new Error(`RepoMap worker exited with code ${code}`)));
			slots.push(slot);
		}
	} catch {
		// A partial start is still a failure: terminate what exists and let the
		// scan parse in this thread.
		for (const slot of slots) void slot.worker.terminate();
		return null;
	}

	return {
		extract(source, language, path) {
			if (closed) return Promise.reject(new Error("RepoMap worker pool is closed"));
			if (slots.every((slot) => slot.dead)) {
				return Promise.reject(new Error("RepoMap worker pool has no live workers"));
			}
			const job: RepoMapWorkerJob = { id: nextId++, path, language, source, maxSnippetLines };
			return new Promise<RepoMapFileTags>((resolve, reject) => {
				queue.push({ job, resolve, reject });
				pump();
			});
		},
		close() {
			if (closed) return;
			closed = true;
			const error = new Error("RepoMap worker pool is closed");
			for (const queued of queue.splice(0)) queued.reject(error);
			for (const slot of slots) {
				const pending = slot.current;
				slot.current = null;
				pending?.reject(error);
				void slot.worker.terminate();
			}
		},
	};
}
