/**
 * `/subagents` is thin: it reads the registry and prints. The reading is
 * where the mistakes live — a listing that shows a running subagent below a
 * finished one, an age that counts from the wrong end, a row that drops the
 * id the user needs to address the subagent with.
 *
 * No sessions are started here; what a real subagent does is the tools'
 * business and is covered where the tools are.
 */
import { describe, expect, test } from "bun:test";
import { createStore } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { formatSubagentList, orderSubagents, subagentAgeMs, subagentCountsLine } from "../src/subagent-commands.ts";
import { type SubagentHandle, SubagentRegistry } from "../src/subagent-registry.ts";

const NOW = 1_700_000_000_000;

function handle(overrides: Partial<SubagentHandle> = {}): SubagentHandle {
	return {
		sidechainId: "sidechain-42-abcd",
		agentType: "general-purpose",
		title: "Fix the flaky test",
		startedAt: NOW - 12_000,
		endedAt: 0,
		state: "live",
		session: {} as never,
		notes: [],
		...overrides,
	};
}

/** The frame's whitespace is not what is under test; alignment has its own test. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

describe("orderSubagents", () => {
	test("running first, oldest spawn on top, stable as others end", () => {
		const early = handle({ sidechainId: "s-early", startedAt: NOW - 30_000 });
		const late = handle({ sidechainId: "s-late", startedAt: NOW - 5_000 });
		expect(orderSubagents([late, early]).map((h) => h.sidechainId)).toEqual(["s-early", "s-late"]);
	});

	test("finished below, most recently ended first", () => {
		const old = handle({ sidechainId: "s-old", state: "finished", endReason: "completed", endedAt: 1 });
		const recent = handle({ sidechainId: "s-recent", state: "finished", endReason: "completed", endedAt: 2 });
		const running = handle({ sidechainId: "s-running" });
		expect(orderSubagents([old, running, recent]).map((h) => h.sidechainId)).toEqual([
			"s-running",
			"s-recent",
			"s-old",
		]);
	});
});

describe("subagentAgeMs", () => {
	test("a running subagent is as old as now minus its spawn", () => {
		expect(subagentAgeMs(handle({ startedAt: NOW - 12_000 }), NOW)).toBe(12_000);
	});

	test("a finished subagent's age is frozen at its end", () => {
		const done = handle({ state: "finished", endReason: "completed", finishedAt: NOW - 2_000 });
		expect(subagentAgeMs(done, NOW)).toBe(10_000);
		// Read again an hour later: the age must not grow.
		expect(subagentAgeMs(done, NOW + 3_600_000)).toBe(10_000);
	});

	// A clock that went backwards must not render as a negative age.
	test("a start time in the future reads as just spawned", () => {
		expect(subagentAgeMs(handle({ startedAt: NOW + 5_000 }), NOW)).toBe(0);
	});
});

describe("subagentCountsLine", () => {
	test("nothing to show says so", () => {
		expect(subagentCountsLine([])).toBe("No subagents have run in this session.");
	});

	test("only the buckets that have something in them appear, in lifecycle order", () => {
		const done = handle({ state: "finished", endReason: "completed", endedAt: 1 });
		const failed = handle({ state: "finished", endReason: "error", endedAt: 2 });
		const running = handle();
		expect(subagentCountsLine([done, failed, running])).toBe("3 subagents: 1 running, 1 completed, 1 failed");
		// Two failed is two failed, not two lines.
		expect(subagentCountsLine([failed, failed])).toBe("2 subagents: 2 failed");
	});

	test("one subagent is not one subagents", () => {
		expect(subagentCountsLine([handle()])).toBe("1 subagent: 1 running");
	});
});

describe("formatSubagentList", () => {
	test("an empty registry is just the sentence", () => {
		expect(formatSubagentList([], NOW)).toBe("No subagents have run in this session.");
	});

	test("one row per subagent: status, type, age, title, and the addressable id", () => {
		const running = handle();
		const done = handle({
			sidechainId: "sidechain-41-efgh",
			title: "Write the migration",
			startedAt: NOW - 65_000,
			state: "finished",
			endReason: "completed",
			finishedAt: NOW - 60_000,
			endedAt: 1,
		});
		const lines = formatSubagentList([done, running], NOW).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("2 subagents: 1 running, 1 completed");
		// Both the id and the title: the screen is where a person reads off
		// what SendMessage takes, so a row without one is a dead end.
		expect(flat(lines[1])).toBe("running general-purpose 12s Fix the flaky test (sidechain-42-abcd)");
		expect(flat(lines[2])).toBe("completed general-purpose 5s Write the migration (sidechain-41-efgh)");
	});

	test("the columns line up, so a wall of rows stays readable", () => {
		const rows = formatSubagentList(
			[
				handle({ sidechainId: "s-1", agentType: "general-purpose" }),
				handle({ sidechainId: "s-2", agentType: "researcher", startedAt: NOW - 3_000 }),
			],
			NOW,
		).split("\n");
		// Different type and age lengths, same column: the title field starts
		// where every row's title field starts, which is the padding's job.
		const titleAt = (line: string) => line.indexOf("Fix the flaky test");
		expect(titleAt(rows[1] ?? "")).toBe(titleAt(rows[2] ?? ""));
		expect(titleAt(rows[1] ?? "")).toBeGreaterThan(0);
	});
});

describe("the /subagents command", () => {
	function makeCtx(registry: SubagentRegistry) {
		const store = createStore<{ entries: Array<{ kind: string; text: string }> }>({ entries: [] });
		const ctx = {
			getSession: () => undefined,
			handle: { store },
			subagents: registry,
		} as unknown as AppCommandContext;
		return { ctx, infos: () => store.get().entries.map((e) => e.text) };
	}

	test("with nothing to show it says so", () => {
		const t = makeCtx(new SubagentRegistry());
		expect(handleAppCommand("/subagents", t.ctx)).toBe(true);
		expect(t.infos().join("\n")).toContain("No subagents have run in this session.");
	});

	test("it prints what the registry holds, live and retained alike", () => {
		const registry = new SubagentRegistry();
		const running = handle({ sidechainId: "sidechain-live-1", title: "Scan the repo" });
		const done = handle({
			sidechainId: "sidechain-done-1",
			title: "Fix the flaky test",
			state: "finished",
			endReason: "error",
		});
		registry.register(running);
		registry.register(done);
		const t = makeCtx(registry);
		handleAppCommand("/subagents", t.ctx);
		const shown = t.infos().join("\n");
		expect(shown).toContain("2 subagents: 1 running, 1 failed");
		expect(shown).toContain("Scan the repo");
		expect(shown).toContain("sidechain-live-1");
		expect(shown).toContain("sidechain-done-1");
	});
});
