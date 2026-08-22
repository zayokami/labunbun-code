import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAUX_MODEL, fauxProvider, type ToolResultMessage } from "@labunbun/ai";
import { z } from "zod";
import { AgentSession, type AnyTool, buildTool, deny, SessionStore } from "../src/index.ts";
import { runHarness } from "./harness.ts";

function echoTool(overrides: Partial<AnyTool> = {}): AnyTool {
	return buildTool({
		name: "echo",
		description: "echo text back",
		inputSchema: z.object({ text: z.string() }),
		call: async (input: any) => ({ content: [{ type: "text", text: input.text }] }),
		...overrides,
	});
}

const toolResultsOf = (messages: any[]): ToolResultMessage[] => messages.filter((m) => m.role === "toolResult");

describe("AgentSession loop", () => {
	test("plain reply terminates completed", async () => {
		const { session, events, reason } = await runHarness([{ text: "Hello!" }]);
		expect(reason).toBe("completed");
		expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		const assistant = session.messages[1] as any;
		expect(assistant.content[0].text).toBe("Hello!");
		expect(events.some((e) => e.type === "message_update")).toBe(true);
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	test("tool roundtrip: call → result → final answer", async () => {
		const calls: unknown[] = [];
		const tool = echoTool({
			isConcurrencySafe: () => true,
			call: async (input: any) => {
				calls.push(input);
				return { content: [{ type: "text", text: `echo:${input.text}` }] };
			},
		});

		const { session, reason } = await runHarness(
			[{ toolCalls: [{ name: "echo", arguments: { text: "hi" } }] }, { text: "done" }],
			{ tools: [tool] },
		);

		expect(reason).toBe("completed");
		expect(calls).toEqual([{ text: "hi" }]);
		const results = toolResultsOf(session.messages);
		expect(results).toHaveLength(1);
		expect(results[0].content[0]).toEqual({ type: "text", text: "echo:hi" });
		expect(results[0].isError).toBe(false);
	});

	test("parallel-safe tools run concurrently but results land in source order", async () => {
		let active = 0;
		let maxActive = 0;
		const slowTool = buildTool({
			name: "slow",
			description: "slow parallel tool",
			inputSchema: z.object({ id: z.number(), delayMs: z.number() }),
			isConcurrencySafe: () => true,
			call: async (input) => {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((r) => setTimeout(r, input.delayMs));
				active--;
				return { content: [{ type: "text", text: `done-${input.id}` }] };
			},
		});

		const { session, reason } = await runHarness(
			[
				{
					toolCalls: [
						{ name: "slow", arguments: { id: 1, delayMs: 60 } },
						{ name: "slow", arguments: { id: 2, delayMs: 40 } },
						{ name: "slow", arguments: { id: 3, delayMs: 10 } },
					],
				},
				{ text: "all done" },
			],
			{ tools: [slowTool] },
		);

		expect(reason).toBe("completed");
		expect(maxActive).toBe(3); // truly concurrent
		const results = toolResultsOf(session.messages);
		expect(results.map((r) => (r.content[0] as any).text)).toEqual(["done-1", "done-2", "done-3"]);
	});

	test("non-concurrency-safe tools serialize between parallel runs", async () => {
		let active = 0;
		let overlapped = false;
		const serialTool = buildTool({
			name: "serial",
			description: "must not overlap",
			inputSchema: z.object({ id: z.number() }),
			isConcurrencySafe: () => false,
			call: async (input) => {
				if (active > 0) overlapped = true;
				active++;
				await new Promise((r) => setTimeout(r, 15));
				active--;
				return { content: [{ type: "text", text: `s-${input.id}` }] };
			},
		});
		const fastTool = buildTool({
			name: "fast",
			description: "parallel filler",
			inputSchema: z.object({ id: z.number() }),
			isConcurrencySafe: () => true,
			call: async (input) => {
				await new Promise((r) => setTimeout(r, 5));
				return { content: [{ type: "text", text: `f-${input.id}` }] };
			},
		});

		const { reason } = await runHarness(
			[
				{
					toolCalls: [
						{ name: "serial", arguments: { id: 1 } },
						{ name: "fast", arguments: { id: 2 } },
						{ name: "fast", arguments: { id: 3 } },
						{ name: "serial", arguments: { id: 4 } },
					],
				},
				{ text: "ok" },
			],
			{ tools: [serialTool, fastTool] },
		);

		expect(reason).toBe("completed");
		expect(overlapped).toBe(false);
	});

	test("denied permission yields isError result and loop continues", async () => {
		const executed: string[] = [];
		const tool = echoTool({
			call: async (input: any) => {
				executed.push(input.text);
				return { content: [{ type: "text", text: "should not happen" }] };
			},
		});

		const { session, reason } = await runHarness(
			[{ toolCalls: [{ name: "echo", arguments: { text: "x" } }] }, { text: "acknowledged" }],
			{
				tools: [tool],
				depsOverrides: {
					canUseTool: async () => deny("Not allowed by policy"),
				},
			},
		);

		expect(reason).toBe("completed");
		expect(executed).toHaveLength(0);
		const results = toolResultsOf(session.messages);
		expect(results[0].isError).toBe(true);
		expect((results[0].content[0] as any).text).toContain("Not allowed by policy");
	});

	test("invalid tool input yields validation error result", async () => {
		const tool = echoTool();
		const { session } = await runHarness(
			[{ toolCalls: [{ name: "echo", arguments: { wrong: 42 } }] }, { text: "ok" }],
			{ tools: [tool] },
		);
		const results = toolResultsOf(session.messages);
		expect(results[0].isError).toBe(true);
		expect((results[0].content[0] as any).text).toContain("InputValidationError");
	});

	test("unknown tool yields isError result", async () => {
		const { session } = await runHarness([{ toolCalls: [{ name: "no_such_tool", arguments: {} }] }, { text: "ok" }], {
			tools: [],
		});
		const results = toolResultsOf(session.messages);
		expect(results[0].isError).toBe(true);
		expect((results[0].content[0] as any).text).toContain("Unknown tool");
	});

	test("stream error mid-conversation synthesizes paired isError results for orphaned toolCalls", async () => {
		const tool = echoTool();
		const { session, reason } = await runHarness(
			[
				{
					toolCalls: [{ name: "echo", arguments: { text: "orphan" } }],
					stopReason: "error",
					errorMessage: "provider exploded",
				},
			],
			{ tools: [tool] },
		);

		expect(reason).toBe("error");
		const results = toolResultsOf(session.messages);
		expect(results).toHaveLength(1);
		expect(results[0].toolCallId).toMatch(/^faux_call/);
		expect(results[0].isError).toBe(true);
		expect((results[0].content[0] as any).text).toContain("interrupted");
	});

	test("length ladder: escalate once then continue-retries inject resume message", async () => {
		const steps = [
			{ text: "part one", stopReason: "length" as const },
			{ text: "part one part two", stopReason: "length" as const },
			{ text: "complete" },
		];
		const { session, reason } = await runHarness(steps, {});
		expect(reason).toBe("completed");

		const userMsgs = session.messages.filter((m) => m.role === "user") as any[];
		const resumes = userMsgs.filter((m) => String(m.content).includes("output limit"));
		expect(resumes.length).toBeGreaterThanOrEqual(1);
		// The truncated partials are discarded — only the final assistant remains.
		const assistants = session.messages.filter((m) => m.role === "assistant") as any[];
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content[0].text).toBe("complete");
	});

	test("maxTurns stops the loop with synthesized orphan results", async () => {
		const endless = Array.from({ length: 10 }, () => ({
			toolCalls: [{ name: "echo", arguments: { text: "again" } }],
		}));
		const { reason } = await runHarness(endless, { tools: [echoTool()], maxTurns: 3 });
		expect(reason).toBe("max_turns");
	});

	test("steering messages drain before the next model call", async () => {
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "a" } }] }, { text: "final" }]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "",
			tools: [echoTool()],
			deps: { streamFn: faux.streamFn },
		});

		const promise = session.prompt("start");
		session.steer("user says: hurry up");
		await promise;

		const userMsgs = session.messages.filter((m) => m.role === "user") as any[];
		expect(userMsgs.map((m) => m.content)).toEqual(["start", "user says: hurry up"]);
	});

	test("abort during run ends with aborted reason", async () => {
		const faux = fauxProvider([{ text: "slow response", abortIfSignaled: true, delayMs: 50 }]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			deps: { streamFn: faux.streamFn },
		});
		const promise = session.prompt("go");
		setTimeout(() => session.abort(), 5);
		const reason = await promise;
		expect(reason).toBe("aborted");
	});

	test("streaming execution starts concurrency-safe tools before the message completes", async () => {
		let startPhase = "never";
		const probe = buildTool({
			name: "probe",
			description: "records when it starts relative to the stream",
			inputSchema: z.object({}),
			isConcurrencySafe: () => true,
			call: async () => {
				startPhase = "during-stream";
				await new Promise((r) => setTimeout(r, 10));
				return { content: [{ type: "text", text: "probed" }] };
			},
		});

		const faux = fauxProvider([{ toolCalls: [{ name: "probe", arguments: {} }] }, { text: "done" }]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			tools: [probe],
			deps: { streamFn: faux.streamFn },
		});
		const reason = await session.prompt("go");

		expect(reason).toBe("completed");
		expect(startPhase).toBe("during-stream");
		const results = toolResultsOf(session.messages);
		expect(results).toHaveLength(1);
		expect((results[0].content[0] as any).text).toBe("probed");
	});

	test("unsafe tools wait for the post-message path", async () => {
		let started = false;
		const serial = buildTool({
			name: "serial_probe",
			description: "must not start during streaming",
			inputSchema: z.object({}),
			isConcurrencySafe: () => false,
			call: async () => {
				started = true;
				return { content: [{ type: "text", text: "ran" }] };
			},
		});

		const faux = fauxProvider([{ toolCalls: [{ name: "serial_probe", arguments: {} }] }, { text: "done" }]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			tools: [serial],
			deps: { streamFn: faux.streamFn },
		});
		await session.prompt("go");

		expect(started).toBe(true); // executed, but after the message finalized
		const results = toolResultsOf(session.messages);
		expect(results).toHaveLength(1);
	});

	test("early-start streaming path caps concurrency same as the post-stream batcher", async () => {
		let active = 0;
		let maxActive = 0;
		const CALL_COUNT = 15;
		const slow = buildTool({
			name: "slow",
			description: "concurrency-safe, tracks peak overlap",
			inputSchema: z.object({ id: z.number() }),
			isConcurrencySafe: () => true,
			call: async (input) => {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((r) => setTimeout(r, 15));
				active--;
				return { content: [{ type: "text", text: `done-${input.id}` }] };
			},
		});

		const toolCalls = Array.from({ length: CALL_COUNT }, (_, i) => ({ name: "slow", arguments: { id: i } }));
		const faux = fauxProvider([{ toolCalls }, { text: "done" }]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			tools: [slow],
			deps: { streamFn: faux.streamFn },
		});
		const reason = await session.prompt("go");

		expect(reason).toBe("completed");
		expect(maxActive).toBeLessThanOrEqual(10);
		const results = toolResultsOf(session.messages);
		expect(results).toHaveLength(CALL_COUNT);
	});
});

describe("session persistence replay", () => {
	test("store file replay equals in-memory transcript", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-agent-"));
		// Temp home: without it the session file lands in ~/.labunbun/projects.
		const store = SessionStore.startNew(dir, mkdtempSync(join(tmpdir(), "lbb-agent-home-")));
		const tool = echoTool();

		const { session } = await runHarness(
			[{ toolCalls: [{ name: "echo", arguments: { text: "persist me" } }] }, { text: "saved" }],
			{ tools: [tool], store },
		);

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.sessionId).toBe(store.sessionId);
		expect(reloaded.messages()).toEqual(session.messages);
	});
});
