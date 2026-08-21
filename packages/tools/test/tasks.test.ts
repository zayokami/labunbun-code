import { describe, expect, test } from "bun:test";
import { createTaskTools, TaskStore } from "../src/tasks.ts";

const NO_CTX = {
	callId: "t1",
	signal: new AbortController().signal,
	cwd: process.cwd(),
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
});
