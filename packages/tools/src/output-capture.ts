/**
 * Bounded capture of a stream that is still arriving.
 *
 * A shell command's output can be arbitrarily large and arrives in chunks; a
 * string that grows with it is a memory bound nobody picked. A capture keeps a
 * window instead — a head and a tail, fixed at construction — and hands the
 * full stream to an {@link OverflowSink} the moment the middle stops fitting.
 * The text it yields then carries the same one-line notice the pipeline's own
 * cuts use ({@link formatCutMarker}), so a result bounded here and cut again
 * there keeps one cumulative count instead of restarting it.
 *
 * Before the bound is crossed, nothing has been dropped: the head holds the
 * stream's start, the tail its end, and the total has never exceeded their sum,
 * so the two buffers cover the whole stream exactly — which is what makes the
 * seed handed to `overflow` a lossless prefix.
 */

import { join } from "node:path";
import { formatCutMarker } from "@labunbun/agent";

/**
 * Holds the last `maxChars` of a stream without rejoining it on every chunk.
 *
 * Chunks are dropped whole from the front once enough have accumulated, so the
 * set retained stays near the cap instead of growing with the command's total
 * output; only `read()` joins, and it is called once per emission rather than
 * once per chunk. The tail can therefore overshoot the cap by at most the length
 * of one chunk, which `read()` trims.
 */
export function createTailBuffer(maxChars: number): { push(chunk: string): void; read(): string } {
	const chunks: string[] = [];
	let size = 0;
	return {
		push(chunk: string): void {
			if (!chunk) return;
			chunks.push(chunk);
			size += chunk.length;
			while (chunks.length > 1 && size - chunks[0].length >= maxChars) {
				size -= chunks[0].length;
				chunks.shift();
			}
		},
		read(): string {
			const joined = chunks.join("");
			return joined.length > maxChars ? joined.slice(-maxChars) : joined;
		},
	};
}

/** Where a capture sends what its window no longer holds. */
export interface OverflowSink {
	/** The whole stream so far, exactly once, when the bound is first crossed. */
	overflow(prefix: string): void;
	/** Every chunk from the crossing on, in arrival order. */
	chunk(chunk: string): void;
}

export interface StreamCapture {
	push(chunk: string): void;
	/**
	 * The bounded text — head, notice, tail, or the whole stream while it fits —
	 * the number of characters the notice stands for, and the stream's total.
	 */
	finish(): { text: string; dropped: number; total: number };
}

export function createStreamCapture(headChars: number, tailChars: number, sink?: OverflowSink): StreamCapture {
	let head = "";
	let total = 0;
	let overflowed = false;
	const tail = createTailBuffer(tailChars);

	/** Everything seen so far — exact only while nothing has been dropped. */
	function joined(): string {
		const tailText = tail.read();
		const fromTail = total - head.length;
		// The tail may reach past the head's end (`fromTail` > 0, take its last
		// `fromTail` characters) or sit wholly inside it (`fromTail` ≤ 0 — `head`
		// alone is the stream). `slice(-0)` would be the whole thing, hence the
		// guard rather than a bare slice.
		return head + (fromTail > 0 ? tailText.slice(-fromTail) : "");
	}

	return {
		push(chunk: string): void {
			if (!chunk) return;
			if (!overflowed && total + chunk.length > headChars + tailChars) {
				overflowed = true;
				sink?.overflow(joined());
			}
			total += chunk.length;
			if (head.length < headChars) head += chunk.slice(0, headChars - head.length);
			tail.push(chunk);
			if (overflowed) sink?.chunk(chunk);
		},
		finish() {
			const tailText = tail.read();
			// Post-crossing this is always positive: the total passed the two
			// windows' sum, and neither window ever exceeds its cap.
			const dropped = Math.max(0, total - head.length - tailText.length);
			if (dropped === 0) return { text: joined(), dropped: 0, total };
			return { text: `${head}\n${formatCutMarker(dropped)}\n${tailText}`, dropped, total };
		},
	};
}

let spillCounter = 0;

/**
 * A fresh path for one spilled stream: labelled, and unique across calls and
 * across processes — the counter separates two spills in the same millisecond
 * of one process, the pid two processes writing in the same directory.
 */
export function nextSpillPath(dir: string, label: string): string {
	spillCounter += 1;
	return join(dir, `${label}-${Date.now().toString(36)}-${process.pid.toString(36)}-${spillCounter}.txt`);
}
