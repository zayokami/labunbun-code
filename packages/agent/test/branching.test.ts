import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store.ts";

function textMessage(role: "user" | "assistant", text: string) {
	if (role === "user") {
		return { role: "user" as const, content: text, timestamp: Date.now() };
	}
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		provider: "faux",
		model: "faux-1",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("session branching", () => {
	test("branch moves the leaf; abandoned branch stays in file", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-branch-"));
		const store = SessionStore.startNew(dir);

		store.appendMessage(textMessage("user", "start"));
		store.appendMessage(textMessage("assistant", "answer A"));
		const branchPointEntry = store.linearEntries().at(-1);
		if (!branchPointEntry) throw new Error("expected at least one entry");

		// Continue linearly.
		store.appendMessage(textMessage("user", "follow-up"));

		// Fork from the assistant answer.
		expect(store.branch(branchPointEntry.id)).toBe(true);
		store.appendMessage(textMessage("user", "different direction"));

		const linear = store.messages();
		expect(linear.map((m) => (m.role === "user" ? m.content : "a"))).toEqual(["start", "a", "different direction"]);

		// Reload: the file holds BOTH branches; active path is the new one.
		const reloaded = SessionStore.load(store.path);
		expect(reloaded.messages().map((m) => (m.role === "user" ? m.content : "a"))).toEqual([
			"start",
			"a",
			"different direction",
		]);
		expect(reloaded.entries.length).toBeGreaterThan(linear.length + 1); // old branch retained
	});

	test("branchPoints detects forks; describeTree marks the active path", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-tree-"));
		const store = SessionStore.startNew(dir);
		store.appendMessage(textMessage("user", "q1"));
		store.appendMessage(textMessage("assistant", "a1"));
		const forkAt = store.linearEntries().at(-1);
		if (!forkAt) throw new Error("expected at least one entry");
		store.appendMessage(textMessage("user", "b1"));
		store.branch(forkAt.id);
		store.appendMessage(textMessage("user", "b2"));

		expect(store.branchPoints()).toHaveLength(1);
		const tree = store.describeTree();
		const lines = tree.split("\n");
		// Active-path entries are marked with *, abandoned with space.
		expect(lines.filter((l) => l.startsWith("*"))).toHaveLength(3);
		expect(lines.some((l) => l.includes("b1"))).toBe(true);
		expect(lines.filter((l) => l.includes("b1"))[0].startsWith("*")).toBe(false);
		expect(lines.filter((l) => l.includes("b2"))[0].startsWith("*")).toBe(true);
	});

	test("branch rejects header entries and unknown ids", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-branch2-"));
		const store = SessionStore.startNew(dir);
		store.appendMessage(textMessage("user", "x"));
		const headerId = store.entries[0].id;
		expect(store.branch(headerId)).toBe(false);
		expect(store.branch("nonexistent")).toBe(false);
	});
});
