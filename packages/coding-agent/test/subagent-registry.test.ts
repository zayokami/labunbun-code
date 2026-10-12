/**
 * The subagent registry: the lifecycle as data, and the two rules the tools
 * lean on — a stop that is already in flight outranks a run simply ending,
 * and eviction never touches a live handle, because the live handle is the
 * conversation the cap exists to bound.
 *
 * No sessions are started here; what a real subagent does is the tools'
 * business and is covered where the tools are.
 */
import { describe, expect, test } from "bun:test";
import { type SubagentHandle, SubagentRegistry, subagentStatus } from "../src/subagent-registry.ts";

function handle(overrides: Partial<SubagentHandle> = {}): SubagentHandle {
	return {
		sidechainId: "sidechain-1-aaaa",
		agentType: "general-purpose",
		title: "Research the thing",
		prompt: "Research the thing",
		startedAt: 1_000,
		endedAt: 0,
		pendingAsks: 0,
		state: "live",
		session: {} as never,
		notes: [],
		...overrides,
	};
}

describe("subagentStatus", () => {
	test("a live handle is running, whatever it ran before", () => {
		expect(subagentStatus(handle({ state: "live" }))).toBe("running");
		// A continuation moves the state back to live; the old outcome must not
		// leak through as the one being displayed.
		expect(subagentStatus(handle({ state: "live", endReason: "completed" }))).toBe("running");
	});

	test("a finished run reports the outcome it reached", () => {
		expect(subagentStatus(handle({ state: "finished", endReason: "completed" }))).toBe("completed");
		expect(subagentStatus(handle({ state: "finished", endReason: "error" }))).toBe("failed");
		expect(subagentStatus(handle({ state: "finished", endReason: "max_turns" }))).toBe("failed");
		expect(subagentStatus(handle({ state: "finished", endReason: "aborted" }))).toBe("cancelled");
	});

	// An unlabelled ending is a failure until something says otherwise — the
	// same direction every unknown in this codebase fails in. Showing it as
	// completed would promise work the runner never confirmed.
	test("a finish with no recorded reason reads as failed, not completed", () => {
		expect(subagentStatus(handle({ state: "finished" }))).toBe("failed");
	});

	// Stopping means "cannot be continued", not "did not happen": a subagent
	// stopped after it finished did finish, and rewinding its outcome to
	// cancelled would edit history to match a button.
	test("stopping does not rewrite an outcome the run already reached", () => {
		expect(subagentStatus(handle({ state: "stopped", endReason: "completed" }))).toBe("completed");
		expect(subagentStatus(handle({ state: "stopped", endReason: "aborted" }))).toBe("cancelled");
		// Stopped while live: the run was cut short, and there is no outcome.
		expect(subagentStatus(handle({ state: "stopped" }))).toBe("cancelled");
	});

	// A live run blocked on a human is not "running": that word claims progress
	// the user is the one withholding. Waiting says so for exactly as long as
	// an ask is up.
	test("a live run with an ask pending reads as waiting", () => {
		expect(subagentStatus(handle({ state: "live", pendingAsks: 1 }))).toBe("waiting");
		// Two asks is still one waiting run, not two rows.
		expect(subagentStatus(handle({ state: "live", pendingAsks: 2 }))).toBe("waiting");
	});

	// The same direction every unknown in this file fails in: a record that
	// never counted an ask has none pending, so absence reads as running.
	test("a progress record that never counted an ask is running, not waiting", () => {
		expect(subagentStatus({ state: "live" })).toBe("running");
	});

	// Waiting is a sub-state of live and nothing more: whatever a stale count
	// says, an ended handle keeps the outcome it reached.
	test("waiting never overrides an outcome that already landed", () => {
		expect(subagentStatus(handle({ state: "finished", endReason: "completed", pendingAsks: 1 }))).toBe("completed");
		expect(subagentStatus(handle({ state: "stopped", pendingAsks: 1 }))).toBe("cancelled");
	});
});

describe("SubagentRegistry", () => {
	test("records spawns in order and answers by id", () => {
		const registry = new SubagentRegistry();
		const first = handle({ sidechainId: "sidechain-1-aaaa" });
		const second = handle({ sidechainId: "sidechain-2-bbbb" });
		registry.register(first);
		registry.register(second);
		expect(registry.get("sidechain-1-aaaa")).toBe(first);
		expect(registry.list()).toEqual([first, second]);
		expect(registry.get("sidechain-9-zzzz")).toBeUndefined();
	});

	test("finish stamps the end time and records the reason, from live only", () => {
		const registry = new SubagentRegistry();
		const target = handle();
		registry.register(target);
		const before = Date.now();
		registry.finish(target, "completed");
		expect(target.state).toBe("finished");
		expect(target.endReason).toBe("completed");
		expect(target.finishedAt).toBeGreaterThanOrEqual(before);
		expect(target.endedAt).toBeGreaterThan(0);
	});

	// The race TaskStop runs into: the stop lands while the run is still
	// unwinding, and its verdict — never resumed — must survive the run
	// ending. The end time is stamped anyway, because the run did end.
	test("a finish cannot un-stop a handle, but still stamps its end", () => {
		const registry = new SubagentRegistry();
		const target = handle();
		registry.register(target);
		registry.stop(target);
		registry.finish(target, "aborted");
		expect(target.state).toBe("stopped");
		expect(target.endReason).toBeUndefined();
		expect(target.finishedAt).toBeGreaterThan(0);
	});

	test("stop is terminal and ordered after whatever ran before", () => {
		const registry = new SubagentRegistry();
		const first = handle({ sidechainId: "sidechain-1-aaaa" });
		const second = handle({ sidechainId: "sidechain-2-bbbb" });
		registry.register(first);
		registry.register(second);
		registry.finish(first, "completed");
		registry.stop(second);
		expect(second.state).toBe("stopped");
		expect(second.endedAt).toBeGreaterThan(first.endedAt);
	});

	test("only the last eight finished handles stay addressable, oldest first", () => {
		const registry = new SubagentRegistry();
		const all = Array.from({ length: 9 }, (_, i) => handle({ sidechainId: `sidechain-${i}-x` }));
		for (const target of all) registry.register(target);
		for (const target of all) registry.finish(target, "completed");

		expect(registry.get("sidechain-0-x")).toBeUndefined();
		expect(registry.list()).toHaveLength(8);
		expect(registry.get("sidechain-1-x")).toBeDefined();
	});

	// The cap counts memory, and a live handle is the memory: evicting one
	// would drop the conversation of the subagent still writing it.
	test("a live handle survives a sweep that ends others", () => {
		const registry = new SubagentRegistry();
		const live = handle({ sidechainId: "sidechain-live" });
		registry.register(live);
		for (let i = 0; i < 9; i++) {
			const target = handle({ sidechainId: `sidechain-f${i}` });
			registry.register(target);
			registry.finish(target, "completed");
		}
		expect(registry.list()).toHaveLength(9);
		expect(registry.get("sidechain-live")).toBe(live);
		// Nine finished would sit one over the cap; the oldest of them went.
		expect(registry.get("sidechain-f0")).toBeUndefined();
	});

	test("eviction follows finish order, not spawn order", () => {
		const registry = new SubagentRegistry();
		const all = Array.from({ length: 10 }, (_, i) => handle({ sidechainId: `sidechain-${i}-x` }));
		for (const target of all) registry.register(target);
		// Finished in reverse spawn order: the newest spawn ended first, and it
		// is the one eviction may drop. An implementation that sorted by
		// startedAt would keep it and drop sidechain-0 instead.
		for (const target of [...all].reverse()) registry.finish(target, "completed");
		expect(registry.get("sidechain-9-x")).toBeUndefined();
		expect(registry.get("sidechain-8-x")).toBeUndefined();
		expect(registry.get("sidechain-0-x")).toBeDefined();
		expect(registry.list()).toHaveLength(8);
	});

	test("askStarted and askEnded raise and lower the waiting count", () => {
		const registry = new SubagentRegistry();
		const target = handle();
		registry.register(target);
		expect(subagentStatus(target)).toBe("running");

		registry.askStarted(target);
		expect(subagentStatus(target)).toBe("waiting");
		// A turn runs its concurrency-safe tools in parallel: two questions can
		// be up at once, and one answer is not both.
		registry.askStarted(target);
		registry.askEnded(target);
		expect(subagentStatus(target)).toBe("waiting");

		registry.askEnded(target);
		expect(subagentStatus(target)).toBe("running");
	});

	test("an end without a start cannot drive the count negative", () => {
		const registry = new SubagentRegistry();
		const target = handle();
		registry.register(target);
		registry.askEnded(target);
		expect(target.pendingAsks).toBe(0);
		expect(subagentStatus(target)).toBe("running");
	});
});
