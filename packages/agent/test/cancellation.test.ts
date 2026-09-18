import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentMessage, FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import { z } from "zod";
import { DEFAULT_MAX_CONCURRENCY } from "../src/concurrency.ts";
import {
	AgentSession,
	type AnyTool,
	buildTool,
	type PermissionResult,
	runToolPipeline,
	SessionStore,
} from "../src/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function probe(call: AnyTool["call"]): AnyTool {
	return buildTool({ name: "probe", description: "local test probe", inputSchema: z.object({}), call });
}

function paired(messages: AgentMessage[]) {
	const calls = messages.flatMap((m) =>
		m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => b.id) : [],
	);
	const results = messages.filter((m) => m.role === "toolResult");
	expect(results.map((r) => r.toolCallId)).toEqual(calls);
	expect(new Set(results.map((r) => r.toolCallId)).size).toBe(results.length);
	return results;
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pipeline cancellation across real pending gates", () => {
	for (const stage of ["validation", "hook", "permission"] as const) {
		for (const cancel of [false, true]) {
			test(`${stage}: ${cancel ? "abort" : "release"} while pending`, async () => {
				const entered = deferred<void>();
				const release = deferred<void>();
				const controller = new AbortController();
				const visited: string[] = [];
				const gate = async (name: string) => {
					visited.push(name);
					if (stage === name) {
						entered.resolve();
						await release.promise;
					}
				};
				const tool = probe(async () => {
					visited.push("call");
					return { content: [{ type: "text", text: "executed" }] };
				});
				tool.validateInput = async () => {
					await gate("validation");
					return null;
				};
				const running = runToolPipeline({
					callId: "pending",
					tool,
					rawInput: {},
					ctx: { callId: "pending", cwd: process.cwd(), signal: controller.signal },
					permissionContext: { mode: "default", toolName: tool.name, input: {}, cwd: process.cwd() },
					onUpdate: () => {},
					deps: {
						// biome-ignore lint/correctness/useYield: StreamFn requires a generator; this stub must never be called
						streamFn: async function* () {
							throw new Error("no provider call expected");
						},
						canUseTool: async () => {
							await gate("permission");
							return { behavior: "allow" };
						},
						hooks: {
							beforeToolCall: async () => {
								await gate("hook");
								return undefined;
							},
							afterToolCall: async () => {
								visited.push("after");
								return undefined;
							},
						},
					},
				});
				try {
					await entered.promise;
					expect(visited).not.toContain("call");
					if (cancel) controller.abort();
				} finally {
					release.resolve();
				}
				const result = await running;
				const stages = ["validation", "hook", "permission", "call", "after"];
				expect(visited).toEqual(cancel ? stages.slice(0, stages.indexOf(stage) + 1) : stages);
				expect(result).toMatchObject({ toolCallId: "pending", toolName: "probe", isError: cancel });
				expect(result.content).toEqual([{ type: "text", text: cancel ? "Tool execution aborted" : "executed" }]);
			});
		}
	}
});

describe("session cancellation integration", () => {
	test.each(["allow", "deny", "ask"] as const)(
		"pending permission returns %s after abort without executing",
		async (behavior) => {
			const entered = deferred<void>();
			const release = deferred<PermissionResult>();
			let calls = 0;
			const faux = fauxProvider([{ toolCalls: [{ name: "probe", arguments: {} }] }]);
			const session = new AgentSession({
				model: FAUX_MODEL,
				tools: [
					probe(async () => {
						calls++;
						return { content: [] };
					}),
				],
				deps: {
					streamFn: faux.streamFn,
					canUseTool: async () => {
						entered.resolve();
						return release.promise;
					},
				},
			});
			const run = session.prompt("go");
			try {
				await entered.promise;
				expect(session.isRunning).toBe(true);
				session.abort();
			} finally {
				release.resolve(behavior === "deny" ? { behavior, message: "refused" } : { behavior });
			}
			expect(await run).toBe("aborted");
			expect(calls).toBe(0);
			expect(faux.receivedContexts).toHaveLength(1);
			expect(paired(session.messages)).toHaveLength(1);
			expect(paired(session.messages)[0].isError).toBe(true);
			expect(session.isRunning).toBe(false);
			expect(session.isInterrupted).toBe(true);
		},
	);

	test("aborted serial batch persists all results, drops follow-ups and allows a fresh run", async () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-cancel-test-"));
		roots.push(home);
		const store = SessionStore.startNew(home, home);
		let calls = 0;
		const faux = fauxProvider([
			{ toolCalls: Array.from({ length: 4 }, (_, i) => ({ id: `call-${i}`, name: "probe", arguments: {} })) },
			{ text: "fresh answer" },
		]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			store,
			tools: [
				probe(async () => {
					calls++;
					session.followUp("stale follow-up");
					session.abort();
					throw new Error("running tool interrupted");
				}),
			],
			deps: { streamFn: faux.streamFn },
		});
		const endings: string[] = [];
		session.on((event) => {
			if (event.type === "agent_end") endings.push(event.reason);
		});
		expect(await session.prompt("first")).toBe("aborted");
		expect(calls).toBe(1);
		expect(faux.receivedContexts).toHaveLength(1);
		const results = paired(session.messages);
		expect(results).toHaveLength(4);
		expect(results.every((r) => r.isError)).toBe(true);
		expect(SessionStore.load(store.path).messages()).toEqual(session.messages);
		expect(session.isInterrupted).toBe(true);
		expect(await session.prompt("fresh question")).toBe("completed");
		expect(session.isInterrupted).toBe(false);
		expect(session.isRunning).toBe(false);
		expect(endings).toEqual(["aborted", "completed"]);
		expect(faux.receivedContexts).toHaveLength(2);
		expect(session.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
			"first",
			"fresh question",
		]);
		expect(SessionStore.load(store.path).messages()).toEqual(session.messages);
	});

	test.each([false, true])(
		"saturated semaphore: cancel=%s preserves order and does not start queued tools",
		async (cancel) => {
			const saturated = deferred<void>();
			const streamed = deferred<void>();
			const release = deferred<void>();
			const count = DEFAULT_MAX_CONCURRENCY + 3;
			const started: number[] = [];
			let active = 0;
			let peak = 0;
			const tool = buildTool({
				name: "parallel",
				description: "blocked local probes",
				inputSchema: z.object({ id: z.number() }),
				isConcurrencySafe: () => true,
				call: async (input) => {
					started.push(input.id);
					peak = Math.max(peak, ++active);
					if (active === DEFAULT_MAX_CONCURRENCY) saturated.resolve();
					try {
						await release.promise;
						return { content: [{ type: "text" as const, text: String(input.id) }] };
					} finally {
						active--;
					}
				},
			});
			const faux = fauxProvider([
				{
					toolCalls: Array.from({ length: count }, (_, id) => ({ id: `p-${id}`, name: "parallel", arguments: { id } })),
				},
				{ text: "complete" },
			]);
			const streamFn: StreamFn = async function* (...args) {
				for await (const event of faux.streamFn(...args)) yield event;
				streamed.resolve();
			};
			const session = new AgentSession({ model: FAUX_MODEL, tools: [tool], deps: { streamFn } });
			const run = session.prompt("go");
			try {
				await Promise.all([saturated.promise, streamed.promise]);
				expect(started).toEqual(Array.from({ length: DEFAULT_MAX_CONCURRENCY }, (_, i) => i));
				if (cancel) session.abort();
			} finally {
				release.resolve();
			}
			expect(await run).toBe(cancel ? "aborted" : "completed");
			expect(active).toBe(0);
			expect(peak).toBe(DEFAULT_MAX_CONCURRENCY);
			expect(started).toHaveLength(cancel ? DEFAULT_MAX_CONCURRENCY : count);
			const results = paired(session.messages);
			expect(results).toHaveLength(count);
			expect(results.slice(0, DEFAULT_MAX_CONCURRENCY).every((r) => !r.isError)).toBe(true);
			expect(results.slice(DEFAULT_MAX_CONCURRENCY).every((r) => r.isError === cancel)).toBe(true);
			expect(faux.receivedContexts).toHaveLength(cancel ? 1 : 2);
		},
	);

	test("a stream that completes normally after a cancel is still recorded as aborted", async () => {
		// Transports disagree on how a cancel surfaces: some throw, others just
		// stop the stream. The OpenAI SDK ends an aborted SSE response with no
		// error, so the turn arrives looking like a normal completion — and the
		// tool calls it carries would be dispatched after the user pressed Esc.
		const streaming = deferred<void>();
		const release = deferred<void>();
		let executions = 0;
		const faux = fauxProvider([
			{ text: "working on it", toolCalls: [{ id: "late", name: "probe", arguments: {} }] },
			{ text: "should never be reached" },
		]);
		const streamFn: StreamFn = async function* (model, context, options) {
			for await (const event of faux.streamFn(model, context, options)) {
				if (event.type === "done") {
					// Hold the terminal event past the cancel, then deliver it —
					// exactly what an already-buffered SSE finish looks like.
					streaming.resolve();
					await release.promise;
				}
				yield event;
			}
		};
		const session = new AgentSession({
			model: FAUX_MODEL,
			tools: [
				probe(async () => {
					executions++;
					return { content: [{ type: "text", text: "ran anyway" }] };
				}),
			],
			deps: { streamFn },
		});

		const run = session.prompt("go");
		await streaming.promise;
		expect(session.isRunning).toBe(true);
		session.abort();
		release.resolve();

		expect(await run).toBe("aborted");
		expect(executions).toBe(0);
		expect(faux.receivedContexts).toHaveLength(1);
		const assistant = session.messages.find((m) => m.role === "assistant");
		expect(assistant).toMatchObject({ stopReason: "aborted" });
		const results = paired(session.messages);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(session.isRunning).toBe(false);
		expect(session.isInterrupted).toBe(true);
		// The session stays usable — the cancelled turn must not wedge it.
		expect(await session.prompt("next")).toBe("completed");
		expect(faux.receivedContexts).toHaveLength(2);
	});

	test("abort in an async tool-start subscriber prevents permissions and execution", async () => {
		let calls = 0;
		let permissions = 0;
		const faux = fauxProvider([{ toolCalls: [{ name: "probe", arguments: {} }] }]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			tools: [
				probe(async () => {
					calls++;
					return { content: [] };
				}),
			],
			deps: {
				streamFn: faux.streamFn,
				canUseTool: async () => {
					permissions++;
					return { behavior: "allow" };
				},
			},
		});
		session.on(async (event) => {
			if (event.type === "tool_execution_start") {
				await Promise.resolve();
				session.abort();
			}
		});
		expect(await session.prompt("go")).toBe("aborted");
		expect(calls).toBe(0);
		expect(permissions).toBe(0);
		expect(paired(session.messages)[0].isError).toBe(true);
	});
});
