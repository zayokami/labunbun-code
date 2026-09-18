/**
 * The web tools must stop when the run is cancelled: a request that keeps
 * waiting out its own 30s timeout is indistinguishable from an app that
 * ignores Esc. `fetch` is stubbed — no network is contacted.
 */
import { describe, expect, test } from "bun:test";
import { createWebFetchTool, createWebSearchTool } from "../src/web.ts";

/** A fetch that behaves like the real one: rejects as soon as its signal aborts. */
function stallingFetch() {
	const original = globalThis.fetch;
	const state = { calls: 0 };
	globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
		state.calls++;
		return new Promise((_resolve, reject) => {
			const signal = init?.signal ?? undefined;
			const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
			if (signal?.aborted) {
				fail();
				return;
			}
			signal?.addEventListener("abort", fail, { once: true });
		});
	}) as typeof fetch;
	return {
		state,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

const ctx = (signal: AbortSignal) => ({ callId: "t1", signal, cwd: process.cwd(), onUpdate: () => {} });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("web tools honour the run's abort signal", () => {
	test("WebFetch stops on abort instead of waiting out its timeout", async () => {
		const stub = stallingFetch();
		try {
			const controller = new AbortController();
			const started = Date.now();
			// Literal public address: the guard resolves hostnames over DNS, and
			// nothing here is actually dialed — fetch is stubbed.
			const pending = createWebFetchTool().call({ url: "http://1.1.1.1/" }, ctx(controller.signal));
			await delay(50);
			expect(stub.state.calls).toBe(1);

			controller.abort();
			const result = await pending;

			expect(Date.now() - started).toBeLessThan(5_000);
			expect(result.isError).toBe(true);
			expect((result.content[0] as { text: string }).text).toBe("Tool execution aborted");
		} finally {
			stub.restore();
		}
	}, 15_000);

	test("WebSearch stops on abort instead of waiting out its timeout", async () => {
		const stub = stallingFetch();
		try {
			const controller = new AbortController();
			const started = Date.now();
			const pending = createWebSearchTool().call({ query: "labunbun" }, ctx(controller.signal));
			await delay(50);
			expect(stub.state.calls).toBe(1);

			controller.abort();
			const result = await pending;

			expect(Date.now() - started).toBeLessThan(5_000);
			expect(result.isError).toBe(true);
			expect((result.content[0] as { text: string }).text).toBe("Tool execution aborted");
		} finally {
			stub.restore();
		}
	}, 15_000);
});
