import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@labunbun/ai";
import { assistantMessage, fauxProvider, toolResultMessage, userMessage } from "@labunbun/ai";
import {
	CompactionManager,
	compactionThreshold,
	estimateContextTokens,
	extractRecentFiles,
	hardContextLimit,
	microcompact,
	SUMMARY_PROMPT,
	stripAnalysis,
} from "../src/compaction.ts";

const CONFIG = { contextWindow: 100_000, maxOutputTokens: 32_000 };

describe("thresholds", () => {
	test("threshold formula: window − min(maxOut, 20k) − 13k", () => {
		expect(compactionThreshold(CONFIG)).toBe(100_000 - 20_000 - 13_000);
		expect(compactionThreshold({ contextWindow: 100_000, maxOutputTokens: 8_000 })).toBe(100_000 - 8_000 - 13_000);
		expect(hardContextLimit(CONFIG)).toBe(100_000 - 3_000);
	});
});

describe("estimateContextTokens", () => {
	test("anchors on last assistant usage plus char estimate for the tail", () => {
		const messages: AgentMessage[] = [
			userMessage("hello"),
			assistantMessage({ usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
			userMessage("x".repeat(400)), // ~100 tokens
		];
		const estimate = estimateContextTokens(messages);
		expect(estimate).toBeGreaterThanOrEqual(1_100);
		expect(estimate).toBeLessThan(1_300);
	});

	test("falls back to pure char estimate without usage anchors", () => {
		const messages: AgentMessage[] = [userMessage("y".repeat(800))];
		expect(estimateContextTokens(messages)).toBe(200);
	});
});

describe("extractRecentFiles", () => {
	test("collects file paths from tool calls, newest first", () => {
		const messages: AgentMessage[] = [
			assistantMessage({
				content: [{ type: "toolCall", id: "1", name: "Read", arguments: JSON.stringify({ file_path: "/old.ts" }) }],
			}),
			assistantMessage({
				content: [
					{ type: "toolCall", id: "2", name: "Edit", arguments: JSON.stringify({ file_path: "/new.ts" }) },
					{ type: "toolCall", id: "3", name: "Write", arguments: JSON.stringify({ file_path: "/newer.ts" }) },
				],
			}),
		];
		expect(extractRecentFiles(messages)).toEqual(["/new.ts", "/newer.ts", "/old.ts"]);
	});
});

describe("microcompact", () => {
	test("truncates oldest tool results, keeps last N intact", () => {
		const big = (id: string) => toolResultMessage(id, "Bash", [{ type: "text", text: "z".repeat(5_000) }]);
		const messages: AgentMessage[] = [big("t1"), big("t2"), big("t3"), big("t4"), userMessage("next")];
		const compacted = microcompact(messages, 2);
		const t1 = compacted.find((m) => m.role === "toolResult" && m.toolCallId === "t1") as any;
		const t3 = compacted.find((m) => m.role === "toolResult" && m.toolCallId === "t3") as any;
		expect(t1.content[0].text).toContain("truncated by microcompact");
		expect(t1.content[0].text.length).toBeLessThan(3_000);
		expect(t3.content[0].text.length).toBe(5_000); // within keep-last-N
	});
});

describe("CompactionManager", () => {
	function makeManager(summaryText: string, deps?: Partial<ConstructorParameters<typeof CompactionManager>[1]>) {
		const faux = fauxProvider([{ text: summaryText, usage: { input: 10, output: 10 } }]);
		return new CompactionManager(CONFIG, {
			streamFn: faux.streamFn,
			readFile: (path) => (path === "/active.ts" ? "const active = true;" : null),
			...deps,
		});
	}

	test("maybeCompact skips below threshold", async () => {
		const manager = makeManager("summary");
		const context = { systemPrompt: "", messages: [userMessage("short")] };
		expect(await manager.maybeCompact(context)).toBeNull();
	});

	test("compacts at threshold with summary + re-injected files", async () => {
		const summary =
			"<analysis>thinking</analysis>\n<summary>\n1. Primary Request: build thing\n9. Next Step: run tests\n</summary>";
		const manager = makeManager(summary);
		const messages: AgentMessage[] = [
			userMessage("work on /active.ts"),
			assistantMessage({
				content: [{ type: "toolCall", id: "1", name: "Edit", arguments: JSON.stringify({ file_path: "/active.ts" }) }],
				usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 },
			}),
		];
		const result = await manager.maybeCompact({ systemPrompt: "sys", messages });
		expect(result).not.toBeNull();
		if (!result) throw new Error("expected compaction result");
		expect(result.messages).toHaveLength(1);
		const boundary = result.messages[0];
		if (boundary.role !== "user") throw new Error("expected user boundary message");
		const text = typeof boundary.content === "string" ? boundary.content : "";
		expect(text).toContain("[Conversation compacted");
		expect(text).toContain("Next Step: run tests"); // analysis stripped
		expect(text).not.toContain("<analysis>");
		expect(text).toContain("/active.ts"); // re-injected file
		expect(text).toContain("const active = true;");
	});

	test("circuit breaker trips after 3 consecutive failures", async () => {
		const failing = fauxProvider([{ throwError: new Error("provider down") }]);
		const manager = new CompactionManager(CONFIG, { streamFn: failing.streamFn });
		const context = { systemPrompt: "", messages: [userMessage("x")] };

		for (let i = 0; i < 3; i++) {
			await expect(manager.compact(context)).rejects.toThrow("provider down");
		}
		expect(manager.isTripped).toBe(true);
		await expect(manager.compact(context)).rejects.toThrow();
	});

	test("stripAnalysis handles summaries without tags", () => {
		expect(stripAnalysis("plain summary")).toBe("plain summary");
		expect(stripAnalysis(SUMMARY_PROMPT.slice(0, 50))).toBeDefined();
	});
});
