/**
 * Tool-call batching and the shared concurrency permit.
 *
 * Two invariants matter here and neither is visible from a passing agent run:
 * a call that is not concurrency-safe must never share a batch with anything,
 * and the semaphore must not hand out more permits than it was constructed with
 * no matter which of its two acquire paths callers take.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_CONCURRENCY, partitionToolCalls, Semaphore } from "../src/concurrency.ts";
import type { AnyTool, ResolvedToolCall } from "../src/types.ts";

/** A resolved call whose only interesting property is whether it may run in parallel. */
function call(id: string, safe: boolean, input: unknown = {}): ResolvedToolCall {
	return { callId: id, tool: { name: id, isConcurrencySafe: () => safe } as unknown as AnyTool, input };
}

/** A call whose safety depends on its input, as Bash's does on the command. */
function conditional(id: string, input: { safe: boolean }): ResolvedToolCall {
	return {
		callId: id,
		tool: { name: id, isConcurrencySafe: (i: { safe: boolean }) => i.safe } as unknown as AnyTool,
		input,
	};
}

const ids = (batches: Array<{ calls: ResolvedToolCall[] }>) => batches.map((b) => b.calls.map((c) => c.callId));
const flags = (batches: Array<{ parallel: boolean }>) => batches.map((b) => b.parallel);

describe("partitionToolCalls", () => {
	test("no calls produce no batches", () => {
		expect(partitionToolCalls([])).toEqual([]);
	});

	test("a run of safe calls becomes one parallel batch", () => {
		const batches = partitionToolCalls([call("a", true), call("b", true), call("c", true)]);
		expect(ids(batches)).toEqual([["a", "b", "c"]]);
		expect(flags(batches)).toEqual([true]);
	});

	// An unsafe call alone in its batch is the whole point: it must not run
	// alongside anything else.
	test("each unsafe call gets a serial batch to itself", () => {
		const batches = partitionToolCalls([call("a", false), call("b", false)]);
		expect(ids(batches)).toEqual([["a"], ["b"]]);
		expect(flags(batches)).toEqual([false, false]);
	});

	test("an unsafe call splits the safe runs around it", () => {
		const batches = partitionToolCalls([
			call("r1", true),
			call("r2", true),
			call("w", false),
			call("r3", true),
			call("r4", true),
		]);
		expect(ids(batches)).toEqual([["r1", "r2"], ["w"], ["r3", "r4"]]);
		expect(flags(batches)).toEqual([true, false, true]);
	});

	test("assistant source order survives batching", () => {
		const batches = partitionToolCalls([
			call("a", true),
			call("b", false),
			call("c", true),
			call("d", false),
			call("e", true),
		]);
		expect(ids(batches).flat()).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("a tool with no isConcurrencySafe is treated as unsafe", () => {
		const bare: ResolvedToolCall = { callId: "x", tool: { name: "x" } as unknown as AnyTool, input: {} };
		const batches = partitionToolCalls([bare, bare]);
		expect(flags(batches)).toEqual([false, false]);
	});

	// Bash decides per command, so the same tool can appear on both sides of a
	// split within one turn.
	test("safety is decided per input, not per tool", () => {
		const batches = partitionToolCalls([
			conditional("a", { safe: true }),
			conditional("b", { safe: false }),
			conditional("c", { safe: true }),
		]);
		expect(ids(batches)).toEqual([["a"], ["b"], ["c"]]);
		expect(flags(batches)).toEqual([true, false, true]);
	});

	test("a safe run longer than the cap splits into full-size parallel batches", () => {
		const batches = partitionToolCalls(
			Array.from({ length: 25 }, (_, i) => call(`c${i}`, true)),
			10,
		);
		expect(batches.map((b) => b.calls.length)).toEqual([10, 10, 5]);
		expect(flags(batches)).toEqual([true, true, true]);
	});

	test("splitting at the cap loses no calls and keeps them in order", () => {
		const input = Array.from({ length: 23 }, (_, i) => call(`c${i}`, true));
		const batches = partitionToolCalls(input, 10);
		expect(ids(batches).flat()).toEqual(input.map((c) => c.callId));
	});

	test("a run exactly at the cap stays a single batch", () => {
		const batches = partitionToolCalls(
			Array.from({ length: 10 }, (_, i) => call(`c${i}`, true)),
			10,
		);
		expect(batches).toHaveLength(1);
		expect(batches[0].calls).toHaveLength(10);
	});

	test("a cap of one makes every safe call its own parallel batch", () => {
		const batches = partitionToolCalls([call("a", true), call("b", true), call("c", true)], 1);
		expect(ids(batches)).toEqual([["a"], ["b"], ["c"]]);
		expect(flags(batches)).toEqual([true, true, true]);
	});

	test("the cap applies per run, not across an intervening unsafe call", () => {
		const batches = partitionToolCalls(
			[...Array.from({ length: 3 }, (_, i) => call(`a${i}`, true)), call("w", false), call("b", true)],
			10,
		);
		expect(ids(batches)).toEqual([["a0", "a1", "a2"], ["w"], ["b"]]);
	});

	test("defaults to the shared cap when none is given", () => {
		const batches = partitionToolCalls(
			Array.from({ length: DEFAULT_MAX_CONCURRENCY + 1 }, (_, i) => call(`c${i}`, true)),
		);
		expect(batches).toHaveLength(2);
		expect(batches[0].calls).toHaveLength(DEFAULT_MAX_CONCURRENCY);
	});
});

describe("Semaphore", () => {
	test("tryAcquire hands out exactly the permits it has", () => {
		const sem = new Semaphore(2);
		expect(sem.tryAcquire()).toBe(true);
		expect(sem.tryAcquire()).toBe(true);
		expect(sem.tryAcquire()).toBe(false);
	});

	test("a release makes a permit available to tryAcquire again", () => {
		const sem = new Semaphore(1);
		expect(sem.tryAcquire()).toBe(true);
		expect(sem.tryAcquire()).toBe(false);
		sem.release();
		expect(sem.tryAcquire()).toBe(true);
	});

	test("zero permits never lets anyone in", () => {
		const sem = new Semaphore(0);
		expect(sem.tryAcquire()).toBe(false);
	});

	test("acquire resolves immediately while permits remain", async () => {
		const sem = new Semaphore(1);
		let resolved = false;
		await sem.acquire().then(() => {
			resolved = true;
		});
		expect(resolved).toBe(true);
	});

	// The blocking path: the waiter must not resolve before a release, or the cap
	// means nothing.
	test("acquire waits for a release when the permits are gone", async () => {
		const sem = new Semaphore(1);
		await sem.acquire();
		let resolved = false;
		const waiting = sem.acquire().then(() => {
			resolved = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(resolved).toBe(false);
		sem.release();
		await waiting;
		expect(resolved).toBe(true);
	});

	test("waiters resume in the order they arrived", async () => {
		const sem = new Semaphore(1);
		await sem.acquire();
		const order: number[] = [];
		const waiters = [1, 2, 3].map((n) => sem.acquire().then(() => order.push(n)));
		for (const _ of waiters) {
			sem.release();
			await new Promise((r) => setTimeout(r, 5));
		}
		await Promise.all(waiters);
		expect(order).toEqual([1, 2, 3]);
	});

	// A release consumed by a waiter must not also raise the count, or the two
	// acquire paths together would exceed the cap.
	test("a release that wakes a waiter does not also add a permit", async () => {
		const sem = new Semaphore(1);
		await sem.acquire();
		const waiting = sem.acquire();
		sem.release();
		await waiting;
		expect(sem.tryAcquire()).toBe(false);
	});

	test("the two acquire paths share one budget", async () => {
		const sem = new Semaphore(2);
		expect(sem.tryAcquire()).toBe(true);
		await sem.acquire();
		expect(sem.tryAcquire()).toBe(false);
		sem.release();
		expect(sem.tryAcquire()).toBe(true);
	});

	test("never runs more than the cap concurrently under contention", async () => {
		const sem = new Semaphore(3);
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 12 }, async () => {
				await sem.acquire();
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
				sem.release();
			}),
		);
		expect(peak).toBe(3);
		expect(active).toBe(0);
	});
});
