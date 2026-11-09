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
	isReady,
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

function fixture(store: TaskStore) {
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
		store.create("first", "d", undefined, "paul", [], { kind: "implement" });
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
		store.create("first", "d", undefined, "paul", [], { kind: "implement" });
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
});
