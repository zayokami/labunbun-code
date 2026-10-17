import { describe, expect, test } from "bun:test";
import { createTaskTools, TASK_BOARD_TOOL_NAMES, TaskStore } from "../src/tasks.ts";

const NO_CTX = {
	callId: "t1",
	signal: new AbortController().signal,
	cwd: process.cwd(),
	sandbox: "workspace-write" as const,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
};

function toolByName(name: string, store: TaskStore) {
	const tool = createTaskTools(store).find((t) => t.name === name);
	if (!tool) throw new Error(`missing ${name}`);
	return tool;
}

describe("task tools", () => {
	test("create → list → get roundtrip", async () => {
		const store = new TaskStore();
		const created = await toolByName("TaskCreate", store).call(
			{ subject: "Run tests", description: "Execute the suite", activeForm: "Running tests" },
			NO_CTX,
		);
		expect((created.content[0] as any).text).toContain("#1");

		const list = await toolByName("TaskList", store).call({}, NO_CTX);
		expect((list.content[0] as any).text).toContain("[pending] Run tests");

		const got = await toolByName("TaskGet", store).call({ taskId: "1" }, NO_CTX);
		expect((got.content[0] as any).text).toContain("Execute the suite");
	});

	test("update transitions status and adds dependencies", async () => {
		const store = new TaskStore();
		store.create("first", "d1");
		store.create("second", "d2");

		const updated = await toolByName("TaskUpdate", store).call(
			{ taskId: "2", status: "in_progress", addBlockedBy: ["1"] },
			NO_CTX,
		);
		expect((updated.content[0] as any).text).toContain("[in_progress] second");

		const list = await toolByName("TaskList", store).call({}, NO_CTX);
		expect((list.content[0] as any).text).toContain("blocked by: 1");
	});

	test("get/update on missing id yields isError", async () => {
		const store = new TaskStore();
		const got = await toolByName("TaskGet", store).call({ taskId: "99" }, NO_CTX);
		expect(got.isError).toBe(true);
	});

	test("store notifies subscribers for the UI strip", () => {
		const store = new TaskStore();
		let notifications = 0;
		const unsub = store.subscribe(() => notifications++);
		store.create("a", "da");
		store.update("1", { status: "completed" });
		unsub();
		store.create("b", "db");
		expect(notifications).toBe(2);
		expect(store.summary()).toHaveLength(2);
	});

	test("owner rides create, update, display and summary", async () => {
		const store = new TaskStore();
		await toolByName("TaskCreate", store).call({ subject: "Wire notes", description: "d", owner: "john" }, NO_CTX);
		const listed = await toolByName("TaskList", store).call({}, NO_CTX);
		expect((listed.content[0] as any).text).toContain("#1 [pending] (john) Wire notes");
		expect(store.summary()[0]?.owner).toBe("john");

		await toolByName("TaskUpdate", store).call({ taskId: "1", owner: "paul" }, NO_CTX);
		const got = await toolByName("TaskGet", store).call({ taskId: "1" }, NO_CTX);
		expect((got.content[0] as any).text).toContain("#1 [pending] (paul) Wire notes");
		expect(store.summary()[0]?.owner).toBe("paul");
	});

	test("a task with no owner shows none", async () => {
		const store = new TaskStore();
		store.create("plain", "d");
		const listed = await toolByName("TaskList", store).call({}, NO_CTX);
		expect((listed.content[0] as any).text).toContain("#1 [pending] plain");
		expect(store.summary()[0]?.owner).toBeUndefined();
	});

	test("moving to in_progress against an unfinished blocker adds a note, not a refusal", async () => {
		const store = new TaskStore();
		store.create("first", "d1");
		store.create("second", "d2");
		await toolByName("TaskUpdate", store).call({ taskId: "2", addBlockedBy: ["1"] }, NO_CTX);

		const moved = await toolByName("TaskUpdate", store).call({ taskId: "2", status: "in_progress" }, NO_CTX);
		const text = (moved.content[0] as any).text as string;
		expect(moved.isError).toBeFalsy();
		expect(text).toContain("[in_progress] second");
		expect(text).toContain("Note: blocked by #1");
		expect(store.get("2")?.status).toBe("in_progress");

		// A completed dependency quiets the note.
		await toolByName("TaskUpdate", store).call({ taskId: "1", status: "completed" }, NO_CTX);
		await toolByName("TaskUpdate", store).call({ taskId: "2", status: "pending" }, NO_CTX);
		const again = await toolByName("TaskUpdate", store).call({ taskId: "2", status: "in_progress" }, NO_CTX);
		expect((again.content[0] as any).text).not.toContain("Note:");

		// So does anything that is not the in_progress transition itself.
		await toolByName("TaskUpdate", store).call({ taskId: "2", status: "pending" }, NO_CTX);
		const retitled = await toolByName("TaskUpdate", store).call({ taskId: "2", subject: "second" }, NO_CTX);
		expect((retitled.content[0] as any).text).not.toContain("Note:");
	});

	test("a dangling blocker id is flagged too", async () => {
		const store = new TaskStore();
		store.create("solo", "d");
		await toolByName("TaskUpdate", store).call({ taskId: "1", addBlockedBy: ["99"] }, NO_CTX);
		const moved = await toolByName("TaskUpdate", store).call({ taskId: "1", status: "in_progress" }, NO_CTX);
		expect((moved.content[0] as any).text).toContain("Note: blocked by #99");
	});

	test("create seeds blockedBy, deduped and copied", async () => {
		const store = new TaskStore();
		store.create("first", "d1");
		store.create("second", "d2");
		const seed = ["1", "2", "1"];
		await toolByName("TaskCreate", store).call({ subject: "third", description: "d3", blockedBy: seed }, NO_CTX);
		expect(store.get("3")?.blockedBy).toEqual(["1", "2"]);

		// The store keeps its own copy: a later push to the input cannot reach it.
		seed.push("99");
		expect(store.get("3")?.blockedBy).toEqual(["1", "2"]);

		const listed = await toolByName("TaskList", store).call({}, NO_CTX);
		expect((listed.content[0] as any).text).toContain("blocked by: 1, 2");
	});

	test("update sets activeForm", async () => {
		const store = new TaskStore();
		store.create("first", "d1");
		await toolByName("TaskUpdate", store).call({ taskId: "1", activeForm: "Doing first" }, NO_CTX);
		expect(store.get("1")?.activeForm).toBe("Doing first");
		expect(store.summary()[0]?.activeForm).toBe("Doing first");
	});

	test("removeBlockedBy drops listed ids and ignores absent ones", async () => {
		const store = new TaskStore();
		store.create("first", "d1");
		store.create("second", "d2");
		store.create("third", "d3");
		await toolByName("TaskUpdate", store).call({ taskId: "3", addBlockedBy: ["1", "2"] }, NO_CTX);

		await toolByName("TaskUpdate", store).call({ taskId: "3", removeBlockedBy: ["1"] }, NO_CTX);
		expect(store.get("3")?.blockedBy).toEqual(["2"]);

		// An id that is not there is a no-op, not an error.
		const removed = await toolByName("TaskUpdate", store).call({ taskId: "3", removeBlockedBy: ["99"] }, NO_CTX);
		expect(removed.isError).toBeFalsy();
		expect(store.get("3")?.blockedBy).toEqual(["2"]);
	});

	test("add and remove in one patch: removal runs first, so an id in both ends present", async () => {
		const store = new TaskStore();
		store.create("first", "d1");
		store.create("second", "d2");
		store.create("third", "d3");
		await toolByName("TaskUpdate", store).call({ taskId: "3", addBlockedBy: ["1", "2"] }, NO_CTX);

		await toolByName("TaskUpdate", store).call(
			{ taskId: "3", removeBlockedBy: ["1", "2"], addBlockedBy: ["1", "2", "2"] },
			NO_CTX,
		);
		expect(store.get("3")?.blockedBy).toEqual(["1", "2"]);
	});

	test("the task prompts state the board rules", () => {
		const store = new TaskStore();
		const createPrompt = toolByName("TaskCreate", store).prompt ?? "";
		expect(createPrompt).toContain("Create tasks BEFORE starting multi-step work");
		expect(createPrompt).toContain("exactly one task in_progress while work is underway");
		expect(createPrompt).toContain("only when the work is actually done and verified");

		const updatePrompt = toolByName("TaskUpdate", store).prompt ?? "";
		expect(updatePrompt).toContain("Update the board as you go");
		expect(updatePrompt).toContain("never mark a task completed with failing tests, partial work");
		expect(updatePrompt).toContain("or unresolved issues");
	});

	test("the board tool names match the tools actually built", () => {
		const names = createTaskTools(new TaskStore())
			.map((t) => t.name)
			.sort();
		expect(names).toEqual([...TASK_BOARD_TOOL_NAMES].sort());
	});
});
