import { describe, expect, test } from "bun:test";
import type { AgentDeps } from "@labunbun/agent";
import { z } from "zod";
import { partitionToolCalls } from "../src/concurrency.ts";
import { type AnyTool, allow, buildTool, type ResolvedToolCall } from "../src/index.ts";
import { runToolPipeline } from "../src/pipeline.ts";

const BASE_CTX = {
	callId: "t1",
	signal: new AbortController().signal,
	cwd: process.cwd(),
};
const PERM_CTX = { mode: "default" as const, toolName: "echo", input: {}, cwd: process.cwd() };
// The pipeline never reaches streamFn in these tests; a throwing placeholder
// proves it.
const NO_STREAM: AgentDeps = {
	streamFn: () => {
		throw new Error("streamFn must not be called by the pipeline");
	},
};

function echoTool(overrides: Partial<AnyTool> = {}): AnyTool {
	return buildTool({
		name: "echo",
		description: "echo",
		inputSchema: z.object({ text: z.string() }),
		call: async (input: any) => ({ content: [{ type: "text", text: input.text }] }),
		...overrides,
	});
}

async function run(tool: AnyTool, rawInput: unknown, deps: Partial<AgentDeps> = {}) {
	return runToolPipeline({
		callId: "t1",
		tool,
		rawInput,
		deps: { ...NO_STREAM, ...deps },
		ctx: BASE_CTX,
		permissionContext: { ...PERM_CTX, toolName: tool.name, input: rawInput },
		onUpdate: () => {},
	});
}

describe("runToolPipeline stages", () => {
	for (const stage of ["entry", "validation", "hook", "permission"] as const) {
		test(`cancellation at ${stage} prevents execution and later gates`, async () => {
			const controller = new AbortController();
			const visited: string[] = [];
			const tool = echoTool({
				validateInput: async () => {
					visited.push("validation");
					if (stage === "validation") controller.abort();
					return null;
				},
				call: async () => {
					visited.push("call");
					return { content: [] };
				},
			});
			if (stage === "entry") controller.abort();
			const result = await runToolPipeline({
				callId: "cancelled",
				tool,
				rawInput: { text: "hello" },
				ctx: { ...BASE_CTX, signal: controller.signal },
				permissionContext: PERM_CTX,
				onUpdate: () => {},
				deps: {
					...NO_STREAM,
					hooks: {
						beforeToolCall: async () => {
							visited.push("hook");
							if (stage === "hook") controller.abort();
						},
					},
					canUseTool: async () => {
						visited.push("permission");
						if (stage === "permission") controller.abort();
						return allow();
					},
				},
			});
			const gates = ["validation", "hook", "permission"];
			expect(visited).toEqual(stage === "entry" ? [] : gates.slice(0, gates.indexOf(stage) + 1));
			expect(result).toMatchObject({ toolCallId: "cancelled", isError: true });
			expect(result.content).toEqual([{ type: "text", text: "Tool execution aborted" }]);
		});
	}

	test("schema failure reports the offending input", async () => {
		const result = await run(echoTool(), { wrong: 42 });
		expect(result.isError).toBe(true);
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("InputValidationError");
		expect(text).toContain("JSON.stringify" in {} ? "" : '{"wrong":42}');
	});

	test("validateInput semantic failure short-circuits before call", async () => {
		let called = false;
		const tool = echoTool({
			validateInput: async () => "text must not be empty-ish",
			call: async () => {
				called = true;
				return { content: [] };
			},
		});
		const result = await run(tool, { text: "hi" });
		expect(called).toBe(false);
		expect((result.content[0] as any).text).toContain("must not be empty-ish");
	});

	test("beforeToolCall block prevents execution; non-block proceeds", async () => {
		const tool = echoTool();
		const blocked = await run(
			tool,
			{ text: "x" },
			{
				hooks: { beforeToolCall: async () => ({ block: true, reason: "policy says no" }) },
			},
		);
		expect(blocked.isError).toBe(true);
		expect((blocked.content[0] as any).text).toContain("policy says no");

		const allowed = await run(
			tool,
			{ text: "y" },
			{
				hooks: { beforeToolCall: async () => undefined },
			},
		);
		expect(allowed.isError).toBeFalsy();
	});

	test("canUseTool deny and unresolved ask both fail safe", async () => {
		const denied = await run(
			echoTool(),
			{ text: "x" },
			{
				canUseTool: async () => ({ behavior: "deny", message: "nope" }),
			},
		);
		expect(denied.isError).toBe(true);
		expect((denied.content[0] as any).text).toContain("nope");

		const asked = await run(
			echoTool(),
			{ text: "x" },
			{
				canUseTool: async () => ({ behavior: "ask" }),
			},
		);
		expect(asked.isError).toBe(true);
		expect((asked.content[0] as any).text).toContain("unresolved");
	});

	test("allow with updatedInput feeds the replacement to the tool", async () => {
		let received: unknown;
		const tool = echoTool({
			call: async (input: any) => {
				received = input;
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		await run(
			tool,
			{ text: "original" },
			{
				canUseTool: async () => allow({ text: "rewritten" }),
			},
		);
		expect(received).toEqual({ text: "rewritten" });
	});

	test("afterToolCall hook may replace the result message", async () => {
		const result = await run(
			echoTool(),
			{ text: "secret" },
			{
				hooks: {
					afterToolCall: async (_name, _input, resultMessage) => ({
						...resultMessage,
						content: [{ type: "text" as const, text: "[redacted]" }],
					}),
				},
			},
		);
		expect((result.content[0] as any).text).toBe("[redacted]");
	});

	test("results truncate at maxResultSizeChars with a notice", async () => {
		const tool = echoTool({ maxResultSizeChars: 50 });
		const result = await run(tool, { text: "z".repeat(500) });
		const text = (result.content[0] as any).text as string;
		expect(text.length).toBeLessThan(200);
		expect(text).toContain("truncated"); // "[output truncated]" when the cap leaves no room for a preview
	});

	test("a tool that spills keeps its output and hands back a path", async () => {
		const written: string[] = [];
		const tool = echoTool({ maxResultSizeChars: 50, overflow: "spill" });
		const result = await run(
			tool,
			{ text: "s".repeat(500) },
			{
				spillOutput: (request) => {
					written.push(request.text);
					return `/spill/${request.toolName}-${request.callId}.txt`;
				},
			},
		);
		const text = (result.content[0] as any).text as string;
		expect(written).toEqual(["s".repeat(500)]);
		expect(text).toContain("[full output: 500 chars → /spill/echo-t1.txt]");
		// The path is addressed by the same call id the model will quote back.
		expect(text).toContain("truncated");
	});

	test("a truncating tool is not spilled, even with a writer configured", async () => {
		// Read is the reason this matters: its content is on disk already, and a
		// spilled copy of a file is a copy nobody asked for.
		let calls = 0;
		const tool = echoTool({ maxResultSizeChars: 50 });
		const result = await run(
			tool,
			{ text: "z".repeat(500) },
			{
				spillOutput: () => {
					calls++;
					return "/spill/never.txt";
				},
			},
		);
		expect(calls).toBe(0);
		expect((result.content[0] as any).text).not.toContain("full output:");
	});

	test("what an afterToolCall hook substitutes is bounded too", async () => {
		// The hook's replacement is still a result going into the context; leaving
		// it unbounded would make the hook a way around every limit in this file.
		const tool = echoTool({ maxResultSizeChars: 50 });
		const result = await run(
			tool,
			{ text: "small" },
			{
				hooks: {
					afterToolCall: async () => ({
						role: "toolResult" as const,
						toolCallId: "t1",
						toolName: "echo",
						content: [{ type: "text" as const, text: "h".repeat(1_000) }],
						isError: false,
						timestamp: 1,
					}),
				},
			},
		);
		const text = (result.content[0] as any).text as string;
		expect(text.length).toBeLessThan(200);
		expect(text).toContain("truncated");
	});

	test("an error thrown by a hook is bounded like any other result", async () => {
		// The catch-all used to build its message outside the limit — a failure
		// path that could put any amount of text into the context.
		const tool = echoTool();
		const result = await run(
			tool,
			{ text: "small" },
			{
				hooks: {
					afterToolCall: async () => {
						throw new Error("k".repeat(500_000));
					},
				},
			},
		);
		const text = (result.content[0] as any).text as string;
		expect(result.isError).toBe(true);
		expect(text.length).toBeLessThan(31_000);
		expect(text).toContain("truncated");
	});

	test("tool throw inside call becomes isError result, not a rejection", async () => {
		const tool = echoTool({
			call: async () => {
				throw new Error("boom inside");
			},
		});
		const result = await run(tool, { text: "x" });
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("boom inside");
	});
});

describe("partitionToolCalls overflow", () => {
	function safe(id: string): ResolvedToolCall {
		return {
			callId: id,
			tool: echoTool({ isConcurrencySafe: () => true }),
			input: {},
		};
	}
	function unsafe(id: string): ResolvedToolCall {
		return { callId: id, tool: echoTool({ isConcurrencySafe: () => false }), input: {} };
	}

	test("more than maxConcurrency safe calls split into additional parallel batches", () => {
		const calls = Array.from({ length: 12 }, (_, i) => safe(`c${i}`));
		const batches = partitionToolCalls(calls, 10);
		expect(batches).toHaveLength(2);
		expect(batches[0]).toMatchObject({ parallel: true });
		expect(batches[0].calls).toHaveLength(10);
		expect(batches[1].calls).toHaveLength(2);
	});

	test("unsafe calls stay single-item serial batches between parallel runs", () => {
		const batches = partitionToolCalls([safe("a"), unsafe("b"), safe("c"), safe("d")], 10);
		expect(batches.map((b) => `${b.parallel ? "P" : "S"}:${b.calls.length}`)).toEqual(["P:1", "S:1", "P:2"]);
	});
});
