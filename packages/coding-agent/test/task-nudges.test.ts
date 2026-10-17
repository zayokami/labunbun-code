/**
 * The task-board reminder controller in isolation.
 *
 * Every rule is driven by explicit events and a fake session: no clock, no real
 * provider, no REPL. The controller is what the interactive host calls from
 * `attachSessionListeners`; the tests below pin the thresholds, the resets, and
 * the one-per-run gates without needing the host itself.
 */
import { describe, expect, test } from "bun:test";
import { TASK_BOARD_TOOL_NAMES, TaskStore } from "@labunbun/tools";
import { createTaskNudges, MAX_COMPLETION_NUDGES, TASK_NUDGE_THRESHOLD } from "../src/task-nudges.ts";

interface Harness {
	store: TaskStore;
	steers: string[];
	followUps: string[];
	setPlan(value: boolean): void;
	start(): void;
	turns(count: number): void;
	toolEnded(toolName: string): void;
	end(reason: "completed" | "aborted" | "error" | "max_turns"): void;
	stopHookContinued(): void;
}

function harness(options: { plan?: boolean; env?: { LBB_TASK_REMINDER?: string } } = {}): Harness {
	const store = new TaskStore();
	const steers: string[] = [];
	const followUps: string[] = [];
	let plan = options.plan ?? false;
	const nudges = createTaskNudges({
		isPlanMode: () => plan,
		taskStore: store,
		steer: (text) => steers.push(text),
		followUp: (text) => followUps.push(text),
		// Empty by default: the tests read neither the clock nor the ambient
		// process environment, so a developer's own LBB_TASK_REMINDER cannot
		// turn a rule off underneath them.
		env: options.env ?? {},
	});
	return {
		store,
		steers,
		followUps,
		setPlan: (value) => {
			plan = value;
		},
		start: () => nudges.onAgentStart(),
		turns: (count) => {
			for (let i = 0; i < count; i++) nudges.onTurnEnd();
		},
		toolEnded: (toolName) => nudges.onToolExecutionEnd(toolName),
		end: (reason) => nudges.onAgentEnd(reason),
		stopHookContinued: () => nudges.onStopHookContinued(),
	};
}

function addTask(store: TaskStore, status: "pending" | "in_progress" | "completed" = "pending"): string {
	const task = store.create("Do the thing", "With enough context to act", undefined, undefined, []);
	store.update(task.id, { status });
	return task.id;
}

describe("startup announcement", () => {
	test("fires once, on the first agent_start, when the board has open tasks", () => {
		const h = harness();
		addTask(h.store);
		addTask(h.store, "in_progress");
		h.start();
		expect(h.steers).toHaveLength(1);
		expect(h.steers[0]).toContain("2");
		expect(h.steers[0]).toContain("TaskList");
		h.start();
		expect(h.steers).toHaveLength(1);
	});

	test("an empty board announces nothing, and a later first run does not change that", () => {
		const h = harness();
		h.start();
		expect(h.steers).toHaveLength(0);
		addTask(h.store);
		h.start();
		expect(h.steers).toHaveLength(0);
	});

	test("completed tasks alone are not unfinished work", () => {
		const h = harness();
		addTask(h.store, "completed");
		h.start();
		expect(h.steers).toHaveLength(0);
	});
});

describe("stale board reminder", () => {
	test(`stays silent at ${TASK_NUDGE_THRESHOLD - 1} turns and fires at ${TASK_NUDGE_THRESHOLD}`, () => {
		expect(TASK_NUDGE_THRESHOLD).toBe(10);
		const h = harness();
		addTask(h.store);
		h.turns(TASK_NUDGE_THRESHOLD - 1);
		expect(h.steers).toHaveLength(0);
		h.turns(1);
		expect(h.steers).toHaveLength(1);
		expect(h.steers[0]).toContain("TaskList");
		expect(h.steers[0]).toContain(String(TASK_NUDGE_THRESHOLD));
	});

	test("does not fire on an empty board", () => {
		const h = harness();
		h.turns(TASK_NUDGE_THRESHOLD);
		expect(h.steers).toHaveLength(0);
	});

	test("does not fire when every task is completed", () => {
		const h = harness();
		addTask(h.store, "completed");
		h.turns(TASK_NUDGE_THRESHOLD);
		expect(h.steers).toHaveLength(0);
	});

	test("does not repeat on the next turn after firing", () => {
		const h = harness();
		addTask(h.store);
		h.turns(TASK_NUDGE_THRESHOLD);
		expect(h.steers).toHaveLength(1);
		h.turns(1);
		expect(h.steers).toHaveLength(1);
	});

	test.each([...TASK_BOARD_TOOL_NAMES])("a %s call restarts the write counter", (toolName) => {
		const h = harness();
		addTask(h.store);
		h.turns(5);
		h.toolEnded(toolName);
		h.turns(TASK_NUDGE_THRESHOLD - 1);
		expect(h.steers).toHaveLength(0);
		h.turns(1);
		expect(h.steers).toHaveLength(1);
	});

	test("a non-board tool does not restart the write counter", () => {
		const h = harness();
		addTask(h.store);
		h.turns(TASK_NUDGE_THRESHOLD - 1);
		h.toolEnded("Bash");
		h.turns(1);
		expect(h.steers).toHaveLength(1);
	});
});

describe("plan-mode long run", () => {
	test(`fires after ${TASK_NUDGE_THRESHOLD} consecutive plan turns`, () => {
		const h = harness({ plan: true });
		h.turns(TASK_NUDGE_THRESHOLD - 1);
		expect(h.steers).toHaveLength(0);
		h.turns(1);
		expect(h.steers).toHaveLength(1);
		expect(h.steers[0]).toContain("ExitPlanMode");
	});

	test("does not fire outside plan mode", () => {
		const h = harness();
		h.turns(TASK_NUDGE_THRESHOLD * 2);
		expect(h.steers).toHaveLength(0);
	});

	test("leaving plan mode resets the consecutive count", () => {
		const h = harness({ plan: true });
		h.turns(TASK_NUDGE_THRESHOLD - 1);
		h.setPlan(false);
		h.turns(1);
		h.setPlan(true);
		h.turns(TASK_NUDGE_THRESHOLD - 1);
		expect(h.steers).toHaveLength(0);
		h.turns(1);
		expect(h.steers).toHaveLength(1);
	});

	test("does not repeat on the turn after firing", () => {
		const h = harness({ plan: true });
		h.turns(TASK_NUDGE_THRESHOLD);
		expect(h.steers).toHaveLength(1);
		h.turns(1);
		expect(h.steers).toHaveLength(1);
	});
});

describe("completion reminder", () => {
	test("follows up once per run when the run touched the board and a task is in_progress", () => {
		const h = harness();
		addTask(h.store, "in_progress");
		h.start();
		h.toolEnded("TaskUpdate");
		h.end("completed");
		expect(h.followUps).toHaveLength(1);
		expect(h.followUps[0]).toContain("in_progress");
		h.end("completed");
		expect(h.followUps).toHaveLength(1);
	});

	test("a new run can trigger it again", () => {
		const h = harness();
		addTask(h.store, "in_progress");
		h.start();
		h.toolEnded("TaskUpdate");
		h.end("completed");
		expect(h.followUps).toHaveLength(1);
		h.start();
		h.toolEnded("TaskList");
		h.end("completed");
		expect(h.followUps).toHaveLength(2);
	});

	test(`caps the session at ${MAX_COMPLETION_NUDGES} follow-ups`, () => {
		expect(MAX_COMPLETION_NUDGES).toBe(3);
		const h = harness();
		addTask(h.store, "in_progress");
		for (let run = 0; run < MAX_COMPLETION_NUDGES; run++) {
			h.start();
			h.toolEnded("TaskUpdate");
			h.end("completed");
		}
		expect(h.followUps).toHaveLength(MAX_COMPLETION_NUDGES);
		// A fourth run that meets every condition is accepted as it ends: a model
		// that never closes the task must not buy itself runs forever.
		h.start();
		h.toolEnded("TaskUpdate");
		h.end("completed");
		expect(h.followUps).toHaveLength(MAX_COMPLETION_NUDGES);
	});

	test("abort and error never remind", () => {
		const h = harness();
		addTask(h.store, "in_progress");
		h.start();
		h.toolEnded("TaskUpdate");
		h.end("aborted");
		h.end("error");
		h.end("max_turns");
		expect(h.followUps).toHaveLength(0);
	});

	test("an abort does not re-arm a completed run", () => {
		const h = harness();
		addTask(h.store, "in_progress");
		h.start();
		h.toolEnded("TaskUpdate");
		h.end("completed");
		expect(h.followUps).toHaveLength(1);
		h.end("aborted");
		h.end("completed");
		expect(h.followUps).toHaveLength(1);
	});

	test("a Stop-hook continuation skips this run's completion reminder", () => {
		const h = harness();
		addTask(h.store, "in_progress");
		h.start();
		h.toolEnded("TaskUpdate");
		h.stopHookContinued();
		h.end("completed");
		expect(h.followUps).toHaveLength(0);
	});

	test("the skip belongs to that run, not to the session", () => {
		const h = harness();
		addTask(h.store, "in_progress");
		h.start();
		h.toolEnded("TaskUpdate");
		h.stopHookContinued();
		h.end("completed");
		h.start();
		h.toolEnded("TaskUpdate");
		h.end("completed");
		expect(h.followUps).toHaveLength(1);
	});

	test("does not follow up when the run never touched the board", () => {
		const h = harness();
		addTask(h.store, "in_progress");
		h.start();
		h.end("completed");
		expect(h.followUps).toHaveLength(0);
	});

	test("the board gate resets at the next agent_start", () => {
		const h = harness();
		addTask(h.store, "in_progress");
		h.start();
		h.toolEnded("TaskUpdate");
		h.end("completed");
		expect(h.followUps).toHaveLength(1);
		// A plain question in the next run does not count as board work.
		h.start();
		h.end("completed");
		expect(h.followUps).toHaveLength(1);
	});

	test("does not follow up with no in_progress task", () => {
		const pending = harness();
		addTask(pending.store);
		pending.start();
		pending.toolEnded("TaskUpdate");
		pending.end("completed");
		expect(pending.followUps).toHaveLength(0);

		const done = harness();
		addTask(done.store, "completed");
		done.start();
		done.toolEnded("TaskUpdate");
		done.end("completed");
		expect(done.followUps).toHaveLength(0);
	});

	test("does not follow up when the board is empty", () => {
		const h = harness();
		h.start();
		h.toolEnded("TaskList");
		h.end("completed");
		expect(h.followUps).toHaveLength(0);
	});
});

describe("LBB_TASK_REMINDER=off", () => {
	test("disables every reminder at construction", () => {
		const h = harness({ env: { LBB_TASK_REMINDER: "off" } });
		addTask(h.store, "in_progress");
		h.start();
		h.turns(TASK_NUDGE_THRESHOLD * 2);
		h.end("completed");
		h.stopHookContinued();
		h.end("completed");
		expect(h.steers).toHaveLength(0);
		expect(h.followUps).toHaveLength(0);
	});

	test("matches the switch with surrounding space and case", () => {
		const h = harness({ env: { LBB_TASK_REMINDER: "  OFF  " } });
		addTask(h.store);
		h.start();
		h.turns(TASK_NUDGE_THRESHOLD);
		expect(h.steers).toHaveLength(0);
	});
});
