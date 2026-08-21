import type { ResolvedToolCall } from "./types.ts";

export interface ToolBatch {
	/** Calls in this batch run concurrently when `parallel` is true. */
	calls: ResolvedToolCall[];
	parallel: boolean;
}

/**
 * Partition tool calls into execution batches: maximal runs of consecutive
 * concurrency-safe calls run in parallel; everything else runs serially.
 * Batches preserve assistant source order, and results are always reported
 * in source order regardless of completion order.
 */
export function partitionToolCalls(calls: ResolvedToolCall[], maxConcurrency = 10): ToolBatch[] {
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
