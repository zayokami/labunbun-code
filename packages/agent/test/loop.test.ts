import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentMessage,
	FAUX_MODEL,
	type FauxStep,
	fauxProvider,
	type StreamFn,
	type ToolResultMessage,
	userMessage,
	withRetry,
} from "@labunbun/ai";
import { z } from "zod";
import {
	type AgentEvent,
	AgentSession,
	type AnyTool,
	buildTool,
	deny,
	MAX_ROUND_RESULT_CHARS,
	SessionStore,
} from "../src/index.ts";
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
	test("abort in a serial batch skips later tools and preserves result pairing", async () => {
		let writes = 0;
		const permissions: string[] = [];
		const faux = fauxProvider([
			{
				toolCalls: [
					{ name: "interrupt", arguments: { text: "stop" } },
					{ name: "Write", arguments: { text: "must not write" } },
				],
			},
			{ text: "must not request another turn" },
		]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "test",
			tools: [
				echoTool({
					name: "interrupt",
					isConcurrencySafe: () => false,
					call: async () => {
						session.abort();
						return { content: [] };
					},
				}),
				echoTool({
					name: "Write",
					isConcurrencySafe: () => false,
					call: async () => {
						writes++;
						return { content: [] };
					},
				}),
			],
			deps: {
				streamFn: faux.streamFn,
				canUseTool: async (name) => {
					permissions.push(name);
					return { behavior: "allow" };
				},
			},
		});
		expect(await session.prompt("go")).toBe("aborted");
		expect(writes).toBe(0);
		expect(permissions).toEqual(["interrupt"]);
		const results = toolResultsOf(session.messages);
		expect(results).toHaveLength(2);
		expect(results[1]).toMatchObject({ toolName: "Write", isError: true });
		const calls = session.messages.flatMap((m) =>
			m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => b.id) : [],
		);
		expect(results.map((r) => r.toolCallId)).toEqual(calls);
	});

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

	test("one round's tool results are bounded together, not just one by one", async () => {
		// Each result is inside its own limit; the turn is not, and the turn is
		// what the context grows by. What the session records is the bounded set —
		// the same text the next request will carry.
		const big = buildTool({
			name: "big",
			description: "returns a lot",
			inputSchema: z.object({ id: z.number(), chars: z.number() }),
			isConcurrencySafe: () => true,
			maxResultSizeChars: Number.POSITIVE_INFINITY,
			call: async (input) => ({ content: [{ type: "text", text: `${input.id}`.repeat(input.chars) }] }),
		});

		const { session } = await runHarness(
			[
				{
					toolCalls: [
						{ name: "big", arguments: { id: 1, chars: 100_000 } },
						{ name: "big", arguments: { id: 2, chars: 100_000 } },
						{ name: "big", arguments: { id: 3, chars: 100_000 } },
					],
				},
				{ text: "done" },
			],
			{ tools: [big] },
		);

		const results = toolResultsOf(session.messages);
		expect(results).toHaveLength(3);
		const shown = results.reduce(
			(sum, result) => sum + result.content.reduce((s, b) => s + (b.type === "text" ? b.text.length : 0), 0),
			0,
		);
		expect(shown).toBeLessThan(210_000);
		// Every one of them is still there, and says it was cut: a tool result the
		// model cannot see at all is a call it has to run again.
		for (const result of results) {
			expect(JSON.stringify(result.content)).toContain("truncated");
		}
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

	// A steering message promises "before the next model call". An abort is the
	// end of the run that made that promise, so the message must die with it —
	// otherwise it resurfaces at the top of a later run's first turn, after
	// whatever the user typed in the meantime.
	test("an interrupt drops steered messages instead of leaking them into the next run", async () => {
		const faux = fauxProvider([{ text: "slow response", abortIfSignaled: true, delayMs: 50 }, { text: "second run" }]);
		const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });

		const first = session.prompt("start");
		// Mid-turn, not before it: a steer typed before the first model call is
		// simply delivered by that call, and there is nothing left to drop.
		await new Promise((r) => setTimeout(r, 10));
		session.steer("typed for the interrupted turn");
		session.abort();
		expect(await first).toBe("aborted");

		await session.prompt("what I actually asked next");

		const userMsgs = session.messages.filter((m) => m.role === "user") as any[];
		expect(userMsgs.map((m) => m.content)).toEqual(["start", "what I actually asked next"]);
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

describe("context overflow", () => {
	function sessionWith(
		checkCompaction: NonNullable<ConstructorParameters<typeof AgentSession>[0]["deps"]>["checkCompaction"],
		steps: FauxStep[] = [{ text: "answer" }],
	) {
		const faux = fauxProvider(steps);
		// Snapshot what each request carried. The context the loop hands the stream
		// holds the live message array, so reading it after the run would show the
		// reply that came back — which is not what was sent.
		const sent: AgentMessage[][] = [];
		const streamFn: StreamFn = async function* (model, context, options) {
			sent.push([...context.messages]);
			yield* faux.streamFn(model, context, options);
		};
		const dir = mkdtempSync(join(tmpdir(), "lbb-agent-"));
		const home = mkdtempSync(join(tmpdir(), "lbb-agent-home-"));
		const session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "test system prompt",
			store: SessionStore.startNew(dir, home),
			deps: { streamFn, checkCompaction },
		});
		const events: AgentEvent[] = [];
		session.on((event) => {
			events.push(event);
		});
		return { session, sent, events };
	}

	test("a blocked check ends the run without sending anything", async () => {
		// What the provider does with a request that cannot fit is a 400, which the
		// retry layer turns into a generic error — and a fallback chain then replays
		// the same oversized context against the next model. Refusing here is the
		// only place that can say why.
		const { session, sent, events } = sessionWith(async () => ({
			action: "blocked",
			message: "Too big to send. Run /compact or /new.",
		}));

		expect(await session.prompt("still here")).toBe("error");
		expect(sent).toHaveLength(0);
		const end = events.find((event) => event.type === "agent_end");
		expect(end?.type === "agent_end" ? end.errorMessage : undefined).toBe("Too big to send. Run /compact or /new.");
		// The prompt is not lost: /compact acts on it, so the retry is a retry and
		// the user does not have to type it again.
		expect(session.messages.at(-1)).toMatchObject({ role: "user", content: "still here" });
	});

	test("a compact decision is what gets sent, and it replaces the live history", async () => {
		const boundary = userMessage("[Conversation compacted] the summary so far");
		const { session, sent } = sessionWith(async (context) => ({
			action: "compact",
			context: { ...context, messages: [boundary, ...context.messages.slice(-1)] },
		}));

		expect(await session.prompt("go")).toBe("completed");
		// Exactly one request, carrying exactly the compacted context.
		expect(sent).toHaveLength(1);
		expect(sent[0]?.[0]).toBe(boundary);
		expect(sent[0]?.[1]).toMatchObject({ role: "user", content: "go" });
		// The live history is the compacted one, so the next turn does not send what
		// the summary just replaced — the same object, not a copy that can drift.
		expect(session.messages[0]).toBe(boundary);
	});

	test("a refusal for size is answered in the same run: make room, then send again", async () => {
		// The estimate said this session had room; the provider said otherwise. The
		// estimate is now known to be wrong, so the next check does not get to
		// consult it — and the turn it refused does not end here: the prompt is sent
		// again, compacted. Ending the run instead meant the user had to type
		// something before the session would make room, which is a `-p` run that
		// dies on its own refusal with nobody to type it.
		const forced: (boolean | undefined)[] = [];
		const boundary = userMessage("[Conversation compacted] the summary so far");
		const { session, sent } = sessionWith(
			async (context, options) => {
				forced.push(options?.force);
				if (!options?.force) return null;
				return { action: "compact", context: { ...context, messages: [boundary] } };
			},
			[
				{ stopReason: "error", errorMessage: "prompt is too long: 250000 tokens", errorKind: "context_overflow" },
				{ text: "answer" },
				{ text: "later" },
			],
		);

		expect(await session.prompt("first")).toBe("completed");
		// Two requests: the one the provider refused, and the compacted one it took.
		expect(sent).toHaveLength(2);
		// Unforced, this check would have answered null and the identical oversized
		// request would have been sent again.
		expect(forced).toEqual([false, true]);
		expect(sent[1]?.[0]).toBe(boundary);
		// Room was made, so the flag does not outlive the compaction: the next turn
		// gets to trust the estimate again.
		expect(session.contextOverflowed).toBe(false);
		expect(await session.prompt("second")).toBe("completed");
		expect(forced).toEqual([false, true, false]);
		expect(sent).toHaveLength(3);
	});

	test("an overflow nothing can fix is retried once, then reported", async () => {
		// The retry exists to make room and send again. Where no room can be made it
		// must not become a loop: the same request refused twice is the provider's
		// answer, and the second refusal is the one the user sees.
		let checks = 0;
		const overflow: FauxStep = {
			stopReason: "error",
			errorMessage: "prompt is too long: 250000 tokens",
			errorKind: "context_overflow",
		};
		const { session, sent, events } = sessionWith(async () => {
			checks++;
			return null;
		}, [overflow, overflow]);

		expect(await session.prompt("go")).toBe("error");
		expect(sent).toHaveLength(2);
		expect(checks).toBe(2);
		// Latched, so a later prompt still forces the check rather than trusting the
		// estimate that was just contradicted.
		expect(session.contextOverflowed).toBe(true);
		const end = events.find((event) => event.type === "agent_end");
		expect(end?.type === "agent_end" ? end.errorMessage : undefined).toBe("prompt is too long: 250000 tokens");
	});
});

describe("a round of tool output, on its way into the history", () => {
	/** Four results of this size are 400k together: twice the round budget. */
	const RESULT_CHARS = 100_000;

	test("is spilled first and bounded after, so every cut result still names its file", async () => {
		// The order is the whole point. The round budget cuts what is left after the
		// tool's own limit, and spilling is what happens to a result that is still
		// whole at that moment — so cutting before spilling would throw away the only
		// complete copy of the text, leaving four previews of nothing.
		const spilled: string[] = [];
		const faux = fauxProvider([
			{ toolCalls: [0, 1, 2, 3].map((i) => ({ name: "echo", arguments: { text: `${i}` } })) },
			{ text: "done" },
		]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "test",
			tools: [
				echoTool({
					overflow: "spill",
					// High enough that the tool's own limit leaves each result whole:
					// what cuts them is the round, not the tool.
					maxResultSizeChars: 1_000_000,
					call: async () => ({ content: [{ type: "text" as const, text: "y".repeat(RESULT_CHARS) }] }),
				}),
			],
			deps: {
				streamFn: faux.streamFn,
				spillOutput: (request) => {
					spilled.push(request.text);
					return `/spill/${request.toolName}-${request.callId}.txt`;
				},
			},
		});

		await session.prompt("go");

		const results = toolResultsOf(session.messages);
		expect(results).toHaveLength(4);
		const total = results.reduce(
			(sum, result) =>
				sum + result.content.reduce((s, block) => s + (block.type === "text" ? block.text.length : 0), 0),
			0,
		);
		expect(total).toBeLessThanOrEqual(MAX_ROUND_RESULT_CHARS + 4 * 100);
		// Each of them reached the disk in full before being cut...
		expect(spilled.map((text) => text.length)).toEqual([RESULT_CHARS, RESULT_CHARS, RESULT_CHARS, RESULT_CHARS]);
		// ...and what the model is left holding points at the file that has it.
		for (const result of results) {
			expect((result.content[0] as { text: string }).text).toContain("/spill/echo-");
		}
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

describe("a retried request", () => {
	// Why this needs an event at all: a turn that is backing off is still in
	// flight, so nothing downstream — no turn_end, no message on screen —
	// reports that anything is happening. The ladder runs for minutes, and
	// without the notice the only difference between "working" and "waiting on
	// a key that does not exist" is the clock.
	test("is announced to subscribers inside the turn it belongs to", async () => {
		const faux = fauxProvider([{ text: "recovered" }]);
		let calls = 0;
		const flaky: StreamFn = async function* (model, context, options) {
			calls++;
			if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
			yield* faux.streamFn(model, context, options);
		};

		// Steps are empty because the harness's own script is replaced wholesale
		// by the retrying transport under test.
		const { events, reason } = await runHarness([], {
			depsOverrides: { streamFn: withRetry(flaky, { baseDelayMs: 1, sleep: async () => {} }) },
		});

		expect(reason).toBe("completed");
		expect(calls).toBe(2);
		expect(events.filter((e) => e.type === "retry")).toEqual([
			{ type: "retry", attempt: 1, delayMs: 1, message: "rate limited" },
		]);
		const retried = events.findIndex((e) => e.type === "retry");
		expect(events.findIndex((e) => e.type === "turn_start")).toBeLessThan(retried);
		expect(retried).toBeLessThan(events.findIndex((e) => e.type === "turn_end"));
	});
});
