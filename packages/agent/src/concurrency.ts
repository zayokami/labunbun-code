import type { ResolvedToolCall } from "./types.ts";

export interface ToolBatch {
	/** Calls in this batch run concurrently when `parallel` is true. */
	calls: ResolvedToolCall[];
	parallel: boolean;
}

/** Shared cap for how many tool calls may run at once, in any single batch or start-early wave. */
export const DEFAULT_MAX_CONCURRENCY = 10;

/**
 * Partition tool calls into execution batches: maximal runs of consecutive
 * concurrency-safe calls run in parallel; everything else runs serially.
 * Batches preserve assistant source order, and results are always reported
 * in source order regardless of completion order.
 */
export function partitionToolCalls(calls: ResolvedToolCall[], maxConcurrency = DEFAULT_MAX_CONCURRENCY): ToolBatch[] {
	const batches: ToolBatch[] = [];
	let i = 0;
	while (i < calls.length) {
		const call = calls[i];
		if (call.tool.isConcurrencySafe?.(call.input)) {
			const batch: ResolvedToolCall[] = [call];
			i++;
			while (i < calls.length && calls[i].tool.isConcurrencySafe?.(calls[i].input)) {
				batch.push(calls[i]);
				i++;
			}
			batches.push({ calls: batch.slice(0, maxConcurrency), parallel: true });
			// Overflow beyond maxConcurrency becomes additional parallel batches.
			for (let j = maxConcurrency; j < batch.length; j += maxConcurrency) {
				batches.push({ calls: batch.slice(j, j + maxConcurrency), parallel: true });
			}
		} else {
			batches.push({ calls: [call], parallel: false });
			i++;
		}
	}
	return batches;
}

/**
 * Counting semaphore shared across the early-start streaming path and the
 * post-stream batch path, so a single turn's concurrency-safe tool calls
 * never exceed the combined cap regardless of which path a given call takes.
 * `tryAcquire` is non-blocking, for callers that must not stall (the stream
 * reader); `acquire` blocks until a permit frees up, for callers already in
 * an async batch loop.
 */
export class Semaphore {
	#available: number;
	#waiters: Array<() => void> = [];

	constructor(permits: number) {
		this.#available = permits;
	}

	tryAcquire(): boolean {
		if (this.#available <= 0) return false;
		this.#available--;
		return true;
	}

	acquire(): Promise<void> {
		if (this.#available > 0) {
			this.#available--;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.#waiters.push(resolve));
	}

	release(): void {
		const next = this.#waiters.shift();
		if (next) {
			next();
		} else {
			this.#available++;
		}
	}
}
