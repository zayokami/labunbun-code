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
