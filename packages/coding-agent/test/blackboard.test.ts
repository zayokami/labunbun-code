/**
 * The blackboard dispatcher and the task card, without a provider anywhere.
 *
 * The dispatcher is a state machine over `TaskStore`: it claims the lowest-id
 * ready task per idle seat, wakes that seat with a rendered card, and wakes it
 * again only when the board's revision moves. These tests pin those rules —
 * dependency gating, one task per seat, the revision key, terminal release —
 * on a real store and a recorder in place of a session.
 */
import { describe, expect, test } from "bun:test";
import { TaskStore } from "@labunbun/tools";
import {
	BlackboardDispatcher,
	DEFAULT_TASK_CARD_CHARS,
	depsMet,
	filesConflict,
	isReady,
	pathsConflict,
	readyTasks,
	renderTaskCard,
} from "../src/blackboard.ts";

const SEATS = ["john", "paul", "george", "ringo"] as const;

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Woken {
	seat: string;
	taskId: string;
	card: string;
}

function fixture(
	store: TaskStore,
	options: { maxAttempts?: number; fixer?: string; verifier?: string; autoFix?: boolean } = {},
) {
	const wakes: Woken[] = [];
	const released: string[] = [];
	const notices: string[] = [];
	const busy = new Set<string>();
	const dispatcher = new BlackboardDispatcher({
		store,
		seats: SEATS,
		isBusy: (seat) => busy.has(seat),
		wake: (seat, card, task) => wakes.push({ seat, taskId: task.id, card }),
		release: (seat, task) => released.push(`${seat}:${task.id}`),
		notice: (line) => notices.push(line),
		...options,
	});
	return { dispatcher, wakes, released, notices, busy };
}

describe("the pure rules", () => {
	test("a task is ready only when it is pending, owned by a seat, and its dependencies are completed", () => {
		const store = new TaskStore();
		const first = store.create("first", "d");
		const second = store.create("second", "d", undefined, "paul", [first.id]);
		expect(isReady(second, store, SEATS)).toBe(false);
		expect(depsMet(second, store)).toBe(false);

		store.update(first.id, { status: "completed" });
		expect(depsMet(second, store)).toBe(true);
		expect(isReady(second, store, SEATS)).toBe(true);

		// A failed dependency is terminal but not satisfied.
		store.update(second.id, { status: "in_progress" });
		expect(readyTasks(store, SEATS).map((task) => task.id)).toEqual([]);

		// An owner outside the seats is never routed to.
		const stranger = store.create("stranger", "d", undefined, "outsider");
		expect(isReady(stranger, store, SEATS)).toBe(false);
		// Neither is an unowned task.
		const unowned = store.create("unowned", "d");
		expect(isReady(unowned, store, SEATS)).toBe(false);
	});

	test("the card carries the task's facts and a bounded failure, and nothing from a conversation", () => {
		const store = new TaskStore();
		const build = store.create("run the build", "Compile and run the suite.", undefined, "ringo", [], {
			kind: "build",
			acceptance: "exit 0 on both commands",
			files: ["packages/tools/src/tasks.ts"],
			commands: ["bun test"],
		});
		store.update(build.id, { errorSummary: `${"x".repeat(8000)} the tail` });

		const card = renderTaskCard(build, store);
		expect(card).toContain("[blackboard] Task #1 — build: run the build (owner: ringo)");
		expect(card).toContain("What done looks like: exit 0 on both commands");
		expect(card).toContain("Files: packages/tools/src/tasks.ts");
		expect(card).toContain("Commands: bun test");
		expect(card).toContain("the tail");
		expect(card).toContain("[truncated");
		expect(card.length).toBeLessThan(DEFAULT_TASK_CARD_CHARS + 100);
	});

	test("the card is cut to its budget as a last resort", () => {
		const store = new TaskStore();
		const task = store.create("long", "y".repeat(20_000), undefined, "paul", [], { kind: "implement" });
		const card = renderTaskCard(task, store, { charBudget: 500 });
		expect(card.length).toBeLessThan(600);
		expect(card).toContain("[truncated");
	});

	test("two tasks conflict when any of their paths is equal to or contains another", () => {
		expect(pathsConflict("packages/a.ts", "packages/a.ts")).toBe(true);
		expect(pathsConflict("packages\\a.ts", "packages/a.ts")).toBe(true);
		expect(pathsConflict("packages/", "packages/a.ts")).toBe(true);
		expect(pathsConflict("packages", "packages/a.ts")).toBe(true);
		expect(pathsConflict("packages/a.ts", "packages/b.ts")).toBe(false);
		// A prefix is not a containment: `packages-old` is a different directory.
		expect(pathsConflict("packages-old/a.ts", "packages/a.ts")).toBe(false);

		expect(filesConflict(["packages/a.ts"], ["packages/b.ts", "packages/a.ts"])).toBe(true);
		expect(filesConflict(["packages/"], ["packages/a.ts"])).toBe(true);
		// A task that names no files conflicts with nothing.
		expect(filesConflict(undefined, ["packages/a.ts"])).toBe(false);
		expect(filesConflict([], [])).toBe(false);
	});
});

describe("the dispatcher", () => {
	test("claims the lowest-id ready task and wakes its owner with a card", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes } = fixture(store);
		store.create("second", "d", undefined, "paul", [], { kind: "implement" });
		store.create("first", "d", undefined, "paul", [], { kind: "implement" });
		await settle();

		expect(wakes).toHaveLength(1);
		expect(wakes[0]?.seat).toBe("paul");
		expect(wakes[0]?.taskId).toBe("1");
		expect(wakes[0]?.card).toContain("[blackboard] Task #1");
		expect(store.get("1")?.status).toBe("in_progress");
		expect(store.get("2")?.status).toBe("pending");
		dispatcher.dispose();
	});

	test("one in_progress task per seat, in id order", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes } = fixture(store);
		store.create("a", "d", undefined, "george", [], { kind: "verify" });
		store.create("b", "d", undefined, "george", [], { kind: "verify" });
		await settle();
		expect(wakes.map((wake) => wake.taskId)).toEqual(["1"]);

		store.update("1", { status: "completed" });
		await settle();
		expect(wakes.map((wake) => wake.taskId)).toEqual(["1", "2"]);
		dispatcher.dispose();
	});

	test("a dependency gates the claim until it completes", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes } = fixture(store);
		// `research`, not `implement`: completing an implement task here would
		// also spawn the automatic verifier, and this test is about the gate.
		store.create("first", "d", undefined, "paul", [], { kind: "research" });
		store.create("second", "d", undefined, "ringo", ["1"], { kind: "build" });
		await settle();
		expect(wakes.map((wake) => wake.taskId)).toEqual(["1"]);

		store.update("1", { status: "completed" });
		await settle();
		expect(wakes.map((wake) => wake.taskId)).toEqual(["1", "2"]);
		dispatcher.dispose();
	});

	test("one wake per revision: an unrelated write does not wake again, a task write does", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes } = fixture(store);
		store.create("the task", "d", undefined, "paul", [], { kind: "implement" });
		await settle();
		expect(wakes).toHaveLength(1);

		// The board changes, but not this task or its owner: no second card.
		store.create("someone else's", "d", undefined, "outsider");
		await settle();
		expect(wakes).toHaveLength(1);

		// John answers a clarification by editing the task; rev moves, and the
		// owner is woken with the updated card.
		store.update("1", { acceptance: "the suite passes" });
		await settle();
		expect(wakes).toHaveLength(2);
		expect(wakes[1]?.card).toContain("the suite passes");
		dispatcher.dispose();
	});

	test("a busy seat is not woken", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes, busy } = fixture(store);
		busy.add("paul");
		store.create("work", "d", undefined, "paul", [], { kind: "implement" });
		await settle();
		expect(wakes).toEqual([]);
		expect(store.get("1")?.status).toBe("pending");

		busy.delete("paul");
		dispatcher.kick();
		await settle();
		expect(wakes).toHaveLength(1);
		expect(store.get("1")?.status).toBe("in_progress");
		dispatcher.dispose();
	});

	test("a terminal task releases its seat, and the next task starts a fresh wake", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes, released } = fixture(store);
		// `research` keeps the automatic verifier out of this test: the claim is
		// the subject, not the verify task completing an implement task spawns.
		store.create("first", "d", undefined, "paul", [], { kind: "research" });
		await settle();
		store.update("1", { status: "completed" });
		await settle();
		expect(released).toEqual(["paul:1"]);

		store.create("second", "d", undefined, "paul", [], { kind: "implement" });
		await settle();
		expect(wakes.map((wake) => wake.taskId)).toEqual(["1", "2"]);
		dispatcher.dispose();
	});

	test("an in_progress task restored on a fresh dispatcher is resumed", async () => {
		const store = new TaskStore();
		store.create("carried over", "d", undefined, "george", [], { kind: "verify" });
		store.update("1", { status: "in_progress" });
		const { dispatcher, wakes } = fixture(store);
		dispatcher.kick();
		await settle();
		expect(wakes.map((wake) => wake.taskId)).toEqual(["1"]);
		expect(wakes[0]?.card).toContain("carried over");
		dispatcher.dispose();
	});

	test("dispose stops the routing", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes } = fixture(store);
		dispatcher.dispose();
		store.create("after", "d", undefined, "paul");
		await settle();
		expect(wakes).toEqual([]);
	});

	test("two tasks that touch the same files are not claimed together", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes } = fixture(store);
		store.create("touches the tree", "d", undefined, "paul", [], { kind: "research", files: ["packages/a.ts"] });
		store.create("touches the file", "d", undefined, "george", [], { kind: "research", files: ["packages\\a.ts"] });
		await settle();
		expect(wakes.map((wake) => wake.taskId)).toEqual(["1"]);
		expect(store.get("2")?.status).toBe("pending");

		store.update("1", { status: "completed" });
		await settle();
		expect(wakes.map((wake) => wake.taskId)).toEqual(["1", "2"]);
		dispatcher.dispose();
	});

	test("tasks that touch different files are claimed together", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes } = fixture(store);
		store.create("a", "d", undefined, "paul", [], { kind: "research", files: ["packages/a.ts"] });
		store.create("b", "d", undefined, "george", [], { kind: "research", files: ["packages/b.ts"] });
		await settle();
		expect(wakes.map((wake) => wake.taskId)).toEqual(["1", "2"]);
		dispatcher.dispose();
	});

	test("a continuation past the attempt ceiling is noticed once and not woken", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes, notices } = fixture(store, { maxAttempts: 3 });
		store.create("stuck", "d", undefined, "paul", [], { kind: "implement", attempts: 3 });
		await settle();
		expect(wakes).toHaveLength(1);

		store.update("1", { acceptance: "first edit" });
		await settle();
		expect(wakes).toHaveLength(1);
		expect(notices.filter((line) => line.includes("has used 3 attempt(s)"))).toHaveLength(1);

		// A later edit does not re-report: the task stays open, once noticed.
		store.update("1", { acceptance: "second edit" });
		await settle();
		expect(wakes).toHaveLength(1);
		expect(notices.filter((line) => line.includes("has used 3 attempt(s)"))).toHaveLength(1);
		dispatcher.dispose();
	});
});

describe("the repair loop", () => {
	/**
	 * A verify task whose implement dependency has completed and whose
	 * deterministic verdict is already `failed` — the state the pheromone
	 * recorder leaves behind. The dispatcher never claimed anything yet, so the
	 * first pass sees the failure cold.
	 */
	function failedVerify(store: TaskStore, attempts?: number) {
		const implement = store.create("write the parser", "d", undefined, "paul", [], { kind: "implement" });
		const verify = store.create("verify the parser", "d", undefined, "george", [implement.id], {
			kind: "verify",
			commands: ["bun test"],
			acceptance: "the suite passes",
			files: ["packages/parser.ts"],
		});
		store.update(implement.id, { status: "completed" });
		store.update(verify.id, {
			status: "in_progress",
			verdict: "failed",
			errorSummary: "[exit code: 1] boom",
			...(attempts === undefined ? {} : { attempts }),
		});
		return { implement, verify };
	}

	test("a failed verify creates one fix for the implementer and re-arms the failure", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes, notices } = fixture(store);
		failedVerify(store);
		await settle();

		const fix = store.get("3");
		expect(fix).toMatchObject({
			kind: "fix",
			owner: "paul",
			fixes: "2",
			attempts: 1,
			errorSummary: "[exit code: 1] boom",
			acceptance: "the suite passes",
		});
		expect(fix?.files).toEqual(["packages/parser.ts"]);
		// The failure is re-armed under its repair, and the stale verdict is gone
		// so the next pass cannot answer the same failure a second time.
		expect(store.get("2")).toMatchObject({ status: "pending", attempts: 1 });
		expect(store.get("2")?.verdict).toBeUndefined();
		expect(store.get("2")?.blockedBy).toContain("3");
		expect(wakes.map((wake) => wake.taskId)).toEqual(["3"]);
		expect(notices.some((line) => line.includes("fix #3 created for Paul"))).toBe(true);
		dispatcher.dispose();
	});

	test("a completed fix marks the repaired task and re-claims its verifier", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes } = fixture(store);
		failedVerify(store);
		await settle();

		store.update("3", { status: "completed" });
		await settle();

		expect(store.get("2")?.fixedBy).toBe("3");
		expect(store.get("2")).toMatchObject({ status: "in_progress" });
		expect(wakes.map((wake) => [wake.seat, wake.taskId])).toEqual([
			["paul", "3"],
			["george", "2"],
		]);
		// The second claim is a fresh card that names the repair.
		expect(wakes[1]?.card).toContain("Repaired by #3");
		dispatcher.dispose();
	});

	test("a failure with one active fix gets no second fix", async () => {
		const store = new TaskStore();
		const { dispatcher } = fixture(store);
		failedVerify(store);
		await settle();
		expect(store.list()).toHaveLength(3);

		// The same failure reported again (a worker setting the verdict by hand)
		// while the fix is still open: the board already answered it.
		store.update("2", { verdict: "failed" });
		await settle();
		expect(store.list()).toHaveLength(3);
		dispatcher.dispose();
	});

	test("a failure with no identifiable implementer goes to the fixer", async () => {
		const store = new TaskStore();
		const { dispatcher } = fixture(store, { fixer: "ringo" });
		store.create("check the build", "d", undefined, "george", [], { kind: "verify", commands: ["bun test"] });
		store.update("1", { status: "in_progress", verdict: "failed" });
		await settle();
		expect(store.get("2")).toMatchObject({ kind: "fix", owner: "ringo", fixes: "1" });
		dispatcher.dispose();
	});

	test("at the attempt ceiling the failure becomes one escalation for John", async () => {
		const store = new TaskStore();
		const { dispatcher, notices } = fixture(store, { maxAttempts: 2 });
		failedVerify(store, 2);
		await settle();

		const escalation = store.get("3");
		expect(escalation).toMatchObject({ kind: "escalate", owner: "john", parent: "2", createdBy: "dispatcher" });
		// John is a seat, so the escalation is claimed in the same pass.
		expect(escalation?.status).toBe("in_progress");
		expect(store.get("2")).toMatchObject({ status: "pending", attempts: 2 });
		expect(store.get("2")?.verdict).toBeUndefined();
		expect(store.get("2")?.blockedBy).toContain("3");
		expect(notices.some((line) => line.includes("escalation #3 is John's"))).toBe(true);
		expect(dispatcher.report().escalations).toBe(1);
		dispatcher.dispose();
	});

	test("with autoFix off a failure is left open for John, not repaired or woken", async () => {
		const store = new TaskStore();
		const { dispatcher, wakes, notices } = fixture(store, { autoFix: false });
		failedVerify(store);
		await settle();

		// No fix and no escalation: the failure keeps its verdict and its seat.
		expect(store.list()).toHaveLength(2);
		expect(store.get("2")).toMatchObject({ status: "in_progress", verdict: "failed" });
		expect(store.get("2")?.attempts).toBe(0);
		// Nor is its owner woken with the failure: that wake would be the repair
		// the switch turned off.
		expect(wakes).toHaveLength(0);
		expect(notices.filter((line) => line.includes("autoFix is off"))).toHaveLength(1);

		// Later passes stay quiet; the board already said whose failure it is.
		dispatcher.kick();
		await settle();
		expect(notices.filter((line) => line.includes("autoFix is off"))).toHaveLength(1);
		dispatcher.dispose();
	});

	test("autoFix off does not turn the automatic verifier off", async () => {
		const store = new TaskStore();
		const { dispatcher } = fixture(store, { autoFix: false });
		store.create("write the parser", "d", undefined, "paul", [], { kind: "implement" });
		store.update("1", { status: "completed" });
		await settle();

		expect(store.get("2")).toMatchObject({ kind: "verify", owner: "george", status: "in_progress" });
		dispatcher.dispose();
	});

	test("the report counts the dispatcher's handoffs and the work it wrote", async () => {
		const store = new TaskStore();
		const { dispatcher } = fixture(store);
		store.create("write the parser", "d", undefined, "paul", [], { kind: "implement" });
		store.update("1", { status: "completed" });
		await settle();
		// One verify created for the unverified implement, and claimed: one handoff.
		expect(dispatcher.report()).toEqual({ wakes: 1, claims: 1, fixes: 0, verifications: 1, escalations: 0 });

		// Fail the verify: a fix is written and claimed on the same pass.
		store.update("2", { status: "in_progress", verdict: "failed", errorSummary: "boom" });
		await settle();
		expect(dispatcher.report()).toEqual({ wakes: 2, claims: 2, fixes: 1, verifications: 1, escalations: 0 });

		// A copy, so a caller cannot corrupt the counters.
		dispatcher.report().wakes = 99;
		expect(dispatcher.report().wakes).toBe(2);
		dispatcher.dispose();
	});

	test("a completed implement task with no verifier gets exactly one", async () => {
		const store = new TaskStore();
		const { dispatcher, notices } = fixture(store);
		store.create("write the parser", "d", undefined, "paul", [], {
			kind: "implement",
			acceptance: "the suite passes",
			files: ["packages/parser.ts"],
			commands: ["bun test"],
		});
		store.update("1", { status: "completed" });
		await settle();

		const verify = store.get("2");
		expect(verify).toMatchObject({
			kind: "verify",
			owner: "george",
			status: "in_progress",
			acceptance: "the suite passes",
			commands: ["bun test"],
			parent: "1",
			createdBy: "dispatcher",
		});
		expect(verify?.blockedBy).toEqual(["1"]);
		expect(verify?.files).toEqual(["packages/parser.ts"]);
		expect(notices.some((line) => line.includes("completed unverified"))).toBe(true);

		// Another pass finds the verifier and writes nothing.
		dispatcher.kick();
		await settle();
		expect(store.list()).toHaveLength(2);
		dispatcher.dispose();
	});

	test("an implement task that already has a verifier is left alone", async () => {
		const store = new TaskStore();
		const { dispatcher } = fixture(store);
		store.create("write the parser", "d", undefined, "paul", [], { kind: "implement" });
		store.create("check the parser", "d", undefined, "ringo", ["1"], { kind: "build" });
		store.update("1", { status: "completed" });
		await settle();
		expect(store.list().map((task) => task.kind)).toEqual(["implement", "build"]);
		dispatcher.dispose();
	});
});
