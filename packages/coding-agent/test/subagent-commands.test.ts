/**
 * `/subagents` is thin: it reads the registry, prints, and routes the three
 * acting verbs. The reading is where the mistakes live — a listing that shows
 * a running subagent below a finished one, an age that counts from the wrong
 * end, a row that drops the id the user needs to address the subagent with,
 * a verb that acts on the wrong run or on nothing at all.
 *
 * No sessions are started here; what a real subagent does is the tools'
 * business and is covered where the tools are — including the control
 * mechanics the stop and retry verbs are wired to.
 */
import { describe, expect, test } from "bun:test";
import { createStore } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import {
	formatRetryEnding,
	formatSubagentList,
	formatSubagentLog,
	LOG_MESSAGE_WINDOW,
	orderSubagents,
	resolveSubagentId,
	subagentAgeMs,
	subagentCountsLine,
	subagentPickerItems,
	subagentSourceLabel,
} from "../src/subagent-commands.ts";
import { type SubagentHandle, SubagentRegistry } from "../src/subagent-registry.ts";

const NOW = 1_700_000_000_000;

function handle(overrides: Partial<SubagentHandle> = {}): SubagentHandle {
	return {
		sidechainId: "sidechain-42-abcd",
		agentType: "general-purpose",
		title: "Fix the flaky test",
		prompt: "Fix the flaky test",
		startedAt: NOW - 12_000,
		endedAt: 0,
		pendingAsks: 0,
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

	test("a waiting subagent stays in the live group, oldest first", () => {
		// Waiting is a sub-state of live, so it sorts where running does: the
		// group order is about what is happening now, and a blocked run is now.
		const early = handle({ sidechainId: "s-early", startedAt: NOW - 30_000, pendingAsks: 1 });
		const late = handle({ sidechainId: "s-late", startedAt: NOW - 5_000 });
		expect(orderSubagents([late, early]).map((h) => h.sidechainId)).toEqual(["s-early", "s-late"]);
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

	test("waiting buckets between running and the ended", () => {
		const waiting = handle({ pendingAsks: 1 });
		const running = handle();
		const done = handle({ state: "finished", endReason: "completed", endedAt: 1 });
		expect(subagentCountsLine([done, waiting, running])).toBe("3 subagents: 1 running, 1 waiting, 1 completed");
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

	test("a waiting row says waiting, not running", () => {
		const lines = formatSubagentList([handle({ pendingAsks: 1 })], NOW).split("\n");
		expect(flat(lines[1] ?? "")).toBe("waiting general-purpose 12s Fix the flaky test (sidechain-42-abcd)");
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
	/** The acting verbs run async bodies even though they answer true now. */
	const tick = () => new Promise((r) => setTimeout(r, 0));

	interface Ctx {
		ctx: AppCommandContext;
		infos: () => string[];
		/** Ids the fake control was asked to stop, in order. */
		stopped: string[];
		/** Ids the fake control was asked to retry, in order. */
		retried: string[];
		/** Every picker that was opened, with the rows it was given. */
		picked: Array<{ title: string; labels: string[] }>;
	}

	function makeCtx(registry: SubagentRegistry, opts: { failingRetry?: string } = {}): Ctx {
		const store = createStore<{ entries: Array<{ kind: string; text: string }> }>({ entries: [] });
		const stopped: string[] = [];
		const retried: string[] = [];
		const picked: Array<{ title: string; labels: string[] }> = [];
		// A stand-in for the real control (tested where the tools are): what
		// the dispatch owns is which handle reaches it, and when, not how the
		// mechanics abort a session.
		const ctx = {
			getSession: () => undefined,
			handle: {
				store,
				pickFromList: (title: string, items: Array<{ label: string }>) => {
					picked.push({ title, labels: items.map((item) => item.label) });
					return Promise.resolve(0);
				},
			},
			subagents: registry,
			subagentControl: {
				stop: (target: SubagentHandle) => {
					stopped.push(target.sidechainId);
					return target.state === "live";
				},
				retry: (target: SubagentHandle, _scope: unknown, onSpawned?: (spawned: SubagentHandle) => void) => {
					retried.push(target.sidechainId);
					if (opts.failingRetry) return Promise.reject(new Error(opts.failingRetry));
					onSpawned?.(handle({ sidechainId: "sidechain-retry-1", title: target.title }));
					return Promise.resolve({ content: [{ type: "text", text: "REPORT" }], details: { reason: "completed" } });
				},
			},
			cwd: process.cwd(),
		} as unknown as AppCommandContext;
		return { ctx, infos: () => store.get().entries.map((e) => e.text), stopped, retried, picked };
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

	test("/subagents stop names the id, stops it, and says it will not resume", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-live-1" }));
		const t = makeCtx(registry);
		handleAppCommand("/subagents stop sidechain-live-1", t.ctx);
		await tick();
		expect(t.stopped).toEqual(["sidechain-live-1"]);
		expect(t.infos().join("\n")).toContain("Stopped sidechain-live-1; it will not be resumed.");
	});

	test("/subagents stop takes the tail of an id, like /stop takes the shell number", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-42-abcd" }));
		const t = makeCtx(registry);
		handleAppCommand("/subagents stop abcd", t.ctx);
		await tick();
		expect(t.stopped).toEqual(["sidechain-42-abcd"]);
	});

	test("/subagents stop on an id nobody has lists the fleet instead of guessing", async () => {
		const t = makeCtx(new SubagentRegistry());
		handleAppCommand("/subagents stop sidechain-nope", t.ctx);
		await tick();
		expect(t.stopped).toEqual([]);
		expect(t.infos().join("\n")).toContain('No subagent "sidechain-nope". /subagents lists them.');
	});

	test("/subagents stop with no argument only offers the live ones", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-ended-1", state: "finished", endReason: "completed" }));
		registry.register(handle({ sidechainId: "sidechain-live-1" }));
		const t = makeCtx(registry);
		handleAppCommand("/subagents stop", t.ctx);
		await tick();
		expect(t.picked.map((p) => p.title)).toEqual(["Stop a subagent"]);
		// A finished handle in this list would make "stop" a no-op that reads
		// like a success — the same rule /stop gives to finished shells.
		expect(t.picked[0]?.labels).toEqual(["sidechain-live-1  Fix the flaky test"]);
		expect(t.stopped).toEqual(["sidechain-live-1"]);
	});

	test("/subagents stop with nothing running says so", async () => {
		const t = makeCtx(new SubagentRegistry());
		handleAppCommand("/subagents stop", t.ctx);
		await tick();
		expect(t.infos().join("\n")).toContain("No subagents are running.");
		expect(t.picked).toEqual([]);
	});

	test("/subagents stop on an id that was already stopped says so and acts on nothing", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-dead-1", state: "stopped", endReason: "aborted" }));
		const t = makeCtx(registry);
		handleAppCommand("/subagents stop sidechain-dead-1", t.ctx);
		await tick();
		// A second stop would report a fresh stop that never happened.
		expect(t.stopped).toEqual([]);
		expect(t.infos().join("\n")).toContain("sidechain-dead-1 was already stopped.");
	});

	test("/subagents retry re-runs a failed handle and narrates both moments", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-bad-1", state: "finished", endReason: "error", endedAt: 1 }));
		const t = makeCtx(registry);
		handleAppCommand("/subagents retry sidechain-bad-1", t.ctx);
		await tick();
		expect(t.retried).toEqual(["sidechain-bad-1"]);
		const shown = t.infos().join("\n");
		// Both moments: the new id the moment the spawn is registered, and the
		// ending when the run came back — a retry that only said "ok" would
		// leave the person watching a listing that never changes.
		expect(shown).toContain('Retrying "Fix the flaky test" as sidechain-retry-1.');
		expect(shown).toContain("Retry of sidechain-bad-1 ended: completed.");
	});

	test("/subagents retry refuses a run that is still going", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-live-1" }));
		const t = makeCtx(registry);
		handleAppCommand("/subagents retry sidechain-live-1", t.ctx);
		await tick();
		expect(t.retried).toEqual([]);
		expect(t.infos().join("\n")).toContain(
			"sidechain-live-1 is running; only failed or cancelled subagents can be retried.",
		);
	});

	test("/subagents retry refuses a run that completed", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-ok-1", state: "finished", endReason: "completed", endedAt: 1 }));
		const t = makeCtx(registry);
		handleAppCommand("/subagents retry ok-1", t.ctx);
		await tick();
		expect(t.retried).toEqual([]);
		expect(t.infos().join("\n")).toContain(
			"sidechain-ok-1 is completed; only failed or cancelled subagents can be retried.",
		);
	});

	test("/subagents retry with no argument only offers the failed and cancelled", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-ok-1", state: "finished", endReason: "completed", endedAt: 1 }));
		registry.register(handle({ sidechainId: "sidechain-stop-1", state: "finished", endReason: "aborted", endedAt: 2 }));
		const t = makeCtx(registry);
		handleAppCommand("/subagents retry", t.ctx);
		await tick();
		expect(t.picked.map((p) => p.title)).toEqual(["Retry a subagent"]);
		// Most recently ended first, like the listing.
		expect(t.picked[0]?.labels).toEqual(["sidechain-stop-1  Fix the flaky test"]);
		expect(t.retried).toEqual(["sidechain-stop-1"]);
	});

	test("/subagents retry with nothing failed says so", async () => {
		const t = makeCtx(new SubagentRegistry());
		handleAppCommand("/subagents retry", t.ctx);
		await tick();
		expect(t.infos().join("\n")).toContain("No failed subagents to retry.");
	});

	test("/subagents retry reports a retry that could not start", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-bad-1", state: "finished", endReason: "error", endedAt: 1 }));
		const t = makeCtx(registry, { failingRetry: "no model" });
		handleAppCommand("/subagents retry sidechain-bad-1", t.ctx);
		await tick();
		// The spawn itself threw: the transcript must say so instead of staying
		// silent about a retry that never ran.
		expect(t.infos().join("\n")).toContain("Retry of sidechain-bad-1 failed: no model");
	});

	test("/subagents log prints the retained conversation of the named run", async () => {
		const registry = new SubagentRegistry();
		registry.register(
			handle({
				sidechainId: "sidechain-42-abcd",
				state: "finished",
				endReason: "error",
				session: { messages: [{ role: "user", content: "fix it", timestamp: 1 }] } as never,
			}),
		);
		const t = makeCtx(registry);
		handleAppCommand("/subagents log sidechain-42-abcd", t.ctx);
		await tick();
		const shown = t.infos().join("\n");
		expect(shown).toContain('subagent "Fix the flaky test" (sidechain-42-abcd): failed');
		expect(shown).toContain("user: fix it");
	});

	test("/subagents log with no argument opens the picker over the fleet", async () => {
		const registry = new SubagentRegistry();
		registry.register(
			handle({
				sidechainId: "sidechain-42-abcd",
				session: { messages: [{ role: "user", content: "fix it", timestamp: 1 }] } as never,
			}),
		);
		const t = makeCtx(registry);
		handleAppCommand("/subagents log", t.ctx);
		await tick();
		expect(t.picked.map((p) => p.title)).toEqual(["Show a subagent's log"]);
		expect(t.infos().join("\n")).toContain("user: fix it");
	});

	test("an unknown verb is still the listing, not an error", async () => {
		const registry = new SubagentRegistry();
		registry.register(handle({ sidechainId: "sidechain-live-1" }));
		const t = makeCtx(registry);
		handleAppCommand("/subagents nope", t.ctx);
		await tick();
		expect(t.infos().join("\n")).toContain("1 subagent: 1 running");
	});
});

describe("subagentSourceLabel", () => {
	test("names the subagent the way its listing row does: title and full id", () => {
		// The person answering reads this off the permission dialog; both halves
		// have a job — the title identifies, the id addresses (SendMessage and
		// TaskStop both take it).
		expect(subagentSourceLabel(handle())).toBe('subagent "Fix the flaky test" (sidechain-42-abcd)');
	});
});

describe("resolveSubagentId", () => {
	const handles = [
		handle({ sidechainId: "sidechain-1758981234567-a3f9" }),
		handle({ sidechainId: "sidechain-41-efgh" }),
	];

	test("the full id and the tail both name the same subagent", () => {
		expect(resolveSubagentId("sidechain-41-efgh", handles)?.sidechainId).toBe("sidechain-41-efgh");
		expect(resolveSubagentId("efgh", handles)?.sidechainId).toBe("sidechain-41-efgh");
		expect(resolveSubagentId("  EFGH ", handles)?.sidechainId).toBe("sidechain-41-efgh");
	});

	test("an id nobody has is undefined rather than a near miss", () => {
		expect(resolveSubagentId("nope", handles)).toBeUndefined();
		expect(resolveSubagentId("", handles)).toBeUndefined();
		// Only the whole id or the tail: a middle segment addresses nothing, and
		// neither does the literal word the ids happen to start with.
		expect(resolveSubagentId("1758981234567", handles)).toBeUndefined();
		expect(resolveSubagentId("sidechain", handles)).toBeUndefined();
	});
});

describe("subagentPickerItems", () => {
	test("one row per subagent in listing order: full id, title, and what it is doing", () => {
		const running = handle({ sidechainId: "sidechain-live-1", title: "Scan the repo" });
		const done = handle({
			sidechainId: "sidechain-done-1",
			title: "Fix the flaky test",
			state: "finished",
			endReason: "error",
			finishedAt: NOW - 3_000,
		});
		const items = subagentPickerItems([done, running], NOW);
		expect(items).toHaveLength(2);
		// Running first, like the listing — the picker is the same screen.
		expect(items[0]?.label).toBe("sidechain-live-1  Scan the repo");
		expect(items[0]?.description).toBe("running · general-purpose · 12s");
		expect(items[1]?.label).toBe("sidechain-done-1  Fix the flaky test");
		expect(items[1]?.description).toBe("failed · general-purpose · 9s");
	});
});

describe("formatSubagentLog", () => {
	test("a header, then the conversation: what was asked, said, called, and returned", () => {
		const lines = formatSubagentLog(
			handle({
				state: "finished",
				endReason: "error",
				finishedAt: NOW - 2_000,
				session: {
					messages: [
						{ role: "user", content: "fix the flaky test", timestamp: 1 },
						{
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "internal reasoning" },
								{ type: "text", text: "I'll run the suite." },
								{ type: "toolCall", id: "c1", name: "Bash", arguments: '{"command":"bun test"}' },
							],
							timestamp: 2,
						},
						{
							role: "toolResult",
							toolCallId: "c1",
							toolName: "Bash",
							content: [{ type: "text", text: "1 fail" }],
							isError: true,
							timestamp: 3,
						},
					],
				} as never,
			}),
			NOW,
		).split("\n");
		expect(lines[0]).toBe('subagent "Fix the flaky test" (sidechain-42-abcd): failed, 10s');
		expect(lines[1]).toBe("  user: fix the flaky test");
		expect(lines[2]).toBe("  assistant: I'll run the suite.");
		expect(lines[3]).toBe('  → Bash {"command":"bun test"}');
		expect(lines[4]).toBe("  ← Bash (error): 1 fail");
		// Thinking is left out: the log is what the run said and did.
		expect(lines.join("\n")).not.toContain("internal reasoning");
	});

	test("a silent run says so rather than printing a bare header", () => {
		expect(formatSubagentLog(handle({ session: { messages: [] } as never }), NOW)).toBe(
			'subagent "Fix the flaky test" (sidechain-42-abcd): running, 12s\n  (no messages)',
		);
	});

	test("long entries fold to one line and elide, so one file cannot bury the log", () => {
		const lines = formatSubagentLog(
			handle({
				session: {
					messages: [
						{
							role: "toolResult",
							toolCallId: "c1",
							toolName: "Read",
							content: [{ type: "text", text: `line one\n${"x".repeat(500)}` }],
							isError: false,
							timestamp: 1,
						},
					],
				} as never,
			}),
			NOW,
		).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]?.startsWith("  ← Read: line one ")).toBe(true);
		expect(lines[1]?.endsWith("…")).toBe(true);
		expect(lines[1]?.length).toBeLessThanOrEqual(10 + 200);
	});

	test("a long conversation is windowed from the end, saying what was dropped", () => {
		const messages = Array.from({ length: LOG_MESSAGE_WINDOW + 5 }, (_, i) => ({
			role: "user" as const,
			content: `turn ${i + 1}`,
			timestamp: i,
		}));
		const lines = formatSubagentLog(handle({ session: { messages } as never }), NOW).split("\n");
		expect(lines[1]).toBe("  … 5 earlier messages omitted");
		expect(lines[2]).toBe("  user: turn 6");
		expect(lines[lines.length - 1]).toBe(`  user: turn ${LOG_MESSAGE_WINDOW + 5}`);
	});

	test("notes from the subagent's own context management ride along", () => {
		const lines = formatSubagentLog(
			handle({ notes: ["compacted 12 messages"], session: { messages: [] } as never }),
			NOW,
		).split("\n");
		expect(lines).toContain("  notes:");
		expect(lines).toContain("    compacted 12 messages");
	});

	test("the request-failure line is shown when the last request died", () => {
		const shown = formatSubagentLog(
			handle({
				session: {
					messages: [
						{
							role: "assistant",
							content: [],
							provider: "p",
							model: "m",
							usage: {},
							stopReason: "error",
							errorMessage: "rate limited",
							timestamp: 1,
						},
					],
				} as never,
			}),
			NOW,
		);
		expect(shown).toContain("(request failed: rate limited)");
	});
});

describe("formatRetryEnding", () => {
	test("a finished retry names its ending", () => {
		expect(
			formatRetryEnding("sidechain-42-abcd", {
				content: [{ type: "text", text: "report" }],
				details: { reason: "completed" },
			}),
		).toBe("Retry of sidechain-42-abcd ended: completed.");
	});

	test("a retry the tool never started reports the failure, folded to one line", () => {
		// The unknown-agent-type early return: no run happened, and the reason
		// has to reach the transcript or the retry looks hung.
		expect(
			formatRetryEnding("sidechain-42-abcd", {
				content: [{ type: "text", text: "Unknown agent type: x.\nAvailable: a, b" }],
				isError: true,
			}),
		).toBe("Retry of sidechain-42-abcd failed: Unknown agent type: x. Available: a, b");
	});
});
