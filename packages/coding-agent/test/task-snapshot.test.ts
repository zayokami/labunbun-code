/**
 * The task list across a restart.
 *
 * A task list is a plan for work longer than one turn, and the turn ends when
 * the process does. If the list lives only in memory, the next run opens with an
 * empty strip and a model that has to be told what it was in the middle of —
 * which is exactly the state the task tools exist to avoid.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { TaskStore } from "@labunbun/tools";
import { bindTaskStore, readTaskSnapshot, restoreTasks, TASK_SNAPSHOT_KIND } from "../src/task-snapshot.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshStore(): SessionStore {
	const store = SessionStore.startNew(
		mkdtempSync(join(tmpdir(), "lbb-tasks-cwd-")),
		mkdtempSync(join(tmpdir(), "lbb-tasks-home-")),
	);
	roots.push(store.path);
	return store;
}

function task(id: string, subject: string, status = "pending") {
	return { id, subject, description: `${subject} — details`, status, blockedBy: [], createdAt: Number(id) };
}

/** The snapshots a file holds, in the order they were written. */
function snapshots(path: string): unknown[] {
	return SessionStore.load(path)
		.entries.filter((entry) => entry.type === "custom" && entry.kind === TASK_SNAPSHOT_KIND)
		.map((entry) => (entry.type === "custom" ? entry.data : undefined));
}

describe("a task list saved in a session", () => {
	test("every change is recorded, and the list comes back whole", () => {
		const store = freshStore();
		const tasks = new TaskStore();
		bindTaskStore(tasks, () => store);

		tasks.create("Run the suite", "bun test", "Running the suite");
		tasks.create("Write it up", "a summary of what failed");
		tasks.update("1", { status: "in_progress" });
		tasks.update("2", { addBlockedBy: ["1"] });

		expect(snapshots(store.path)).toHaveLength(4);
		// A second run reads the file rather than sharing memory with the first.
		const reloaded = SessionStore.load(store.path);
		const second = new TaskStore();
		bindTaskStore(second, () => reloaded);
		expect(second.list()).toEqual(tasks.list());
		// Ids are the conversation's names for the tasks, so they carry over — and
		// the next new one does not reuse a number the model has already seen.
		second.create("Third", "and another");
		expect(second.list().map((t) => t.id)).toEqual(["1", "2", "3"]);
	});

	test("a restored task keeps the id the conversation already named it by", () => {
		const store = freshStore();
		// Ids with a gap in them, which is what a saved list looks like once tasks
		// have been worked through: a list rebuilt with fresh numbers would not
		// have that gap, and the conversation says "#5 is done".
		store.appendCustom(TASK_SNAPSHOT_KIND, [task("2", "the second"), task("5", "the fifth")]);

		const tasks = new TaskStore();
		bindTaskStore(tasks, () => store);

		expect(tasks.list().map((t) => t.id)).toEqual(["2", "5"]);
		tasks.update("5", { status: "completed" });
		expect(tasks.get("5")?.status).toBe("completed");
		// And the next new task is numbered after the highest one already used,
		// rather than reusing a number the model has seen.
		tasks.create("The sixth", "a new one");
		expect(tasks.list().map((t) => t.id)).toEqual(["2", "5", "6"]);
	});

	test("a list that has not changed is not written again", () => {
		const store = freshStore();
		const tasks = new TaskStore();
		bindTaskStore(tasks, () => store);
		tasks.create("Only one", "one task");
		const before = readFileSync(store.path, "utf8");

		// Adopting a session is itself a change to the store — it notifies the
		// strip — but it is not news to the file it was read from.
		restoreTasks(tasks, SessionStore.load(store.path));

		expect(readFileSync(store.path, "utf8")).toBe(before);
		// And a real change after that is written.
		tasks.update("1", { status: "completed" });
		expect(readTaskSnapshot(SessionStore.load(store.path))?.[0]?.status).toBe("completed");
		expect(snapshots(store.path)).toHaveLength(2);
	});

	test("a session that never held a list is not given an empty one", () => {
		const store = freshStore();
		const tasks = new TaskStore();
		bindTaskStore(tasks, () => store);
		const before = readFileSync(store.path, "utf8");

		// What `/resume` does to a store that is already bound: adopt a session
		// that holds no list. Adopting notifies the strip, and the subscriber that
		// saves sees the change too — but "no list saved" and "the list is now
		// empty" are the same state, and a file that has recorded nothing yet
		// should not start recording it.
		restoreTasks(tasks, store);

		expect(tasks.list()).toEqual([]);
		expect(readFileSync(store.path, "utf8")).toBe(before);
	});

	test("adopting a session with no list clears the one on screen", () => {
		const withTasks = freshStore();
		withTasks.appendCustom(TASK_SNAPSHOT_KIND, [task("1", "carried over")]);
		const withoutTasks = freshStore();
		const tasks = new TaskStore();
		restoreTasks(tasks, withTasks);
		expect(tasks.list().map((t) => t.subject)).toEqual(["carried over"]);

		restoreTasks(tasks, withoutTasks);

		expect(tasks.list()).toEqual([]);
	});

	test("the newest readable snapshot is the list", () => {
		const store = freshStore();
		store.appendCustom(TASK_SNAPSHOT_KIND, [task("1", "the old plan")]);
		store.appendCustom(TASK_SNAPSHOT_KIND, [task("2", "the new plan")]);

		expect(readTaskSnapshot(store)?.map((t) => t.subject)).toEqual(["the new plan"]);

		// A snapshot written by a build that meant something else by it — or a
		// status this one cannot render — is skipped, and the plan before it is
		// what the session is understood to hold.
		store.appendCustom(TASK_SNAPSHOT_KIND, [{ id: "3", subject: "no status" }]);
		store.appendCustom(TASK_SNAPSHOT_KIND, [{ ...task("4", "bad status"), status: "finished" }]);
		store.appendCustom(TASK_SNAPSHOT_KIND, "not a list at all");

		expect(readTaskSnapshot(store)?.map((t) => t.subject)).toEqual(["the new plan"]);
		const tasks = new TaskStore();
		bindTaskStore(tasks, () => store);
		expect(tasks.list()).toHaveLength(1);
	});

	test("a list abandoned by a branch is not resurrected", () => {
		const store = freshStore();
		store.appendCustom(TASK_SNAPSHOT_KIND, [task("1", "the plan that stands")]);
		const fork = store.entries.at(-1);
		if (!fork) throw new Error("expected the snapshot entry");
		store.appendCustom(TASK_SNAPSHOT_KIND, [task("2", "the plan that was abandoned")]);
		expect(store.branch(fork.id)).toBe(true);

		const tasks = new TaskStore();
		bindTaskStore(tasks, () => store);

		expect(tasks.list().map((t) => t.subject)).toEqual(["the plan that stands"]);
	});

	test("a restored list cannot be edited from outside, and a session that is not there changes nothing", () => {
		const store = freshStore();
		const saved = [task("1", "original")];
		store.appendCustom(TASK_SNAPSHOT_KIND, saved);

		const tasks = new TaskStore();
		restoreTasks(tasks, store);
		tasks.update("1", { subject: "renamed", addBlockedBy: ["2"] });

		expect(saved[0]?.subject).toBe("original");
		expect(saved[0]?.blockedBy).toEqual([]);
		expect(tasks.list()[0]?.subject).toBe("renamed");

		// A bind with no session (a caller that never got one) is a no-op, not a crash.
		const before = tasks.snapshot();
		bindTaskStore(tasks, () => undefined);
		expect(tasks.snapshot()).toEqual(before);
	});
});
