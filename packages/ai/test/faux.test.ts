import { describe, expect, test } from "bun:test";
import { FAUX_MODEL, fauxProvider } from "../src/providers/faux.ts";
import type { AssistantMessageEvent } from "../src/types.ts";
import { userMessage } from "../src/types.ts";

async function collect(events: AsyncIterable<AssistantMessageEvent>) {
	const out: AssistantMessageEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

describe("fauxProvider", () => {
	test("text step emits protocol-conformant sequence", async () => {
		const faux = fauxProvider([{ text: "Hello world", usage: { input: 5, output: 2 } }]);
		const events = await collect(faux.streamFn(FAUX_MODEL, { systemPrompt: "", messages: [userMessage("hi")] }));

		expect(events[0].type).toBe("start");
		expect(events.at(-1)?.type).toBe("done");
		const done = events.at(-1) as any;
		expect(done.message.stopReason).toBe("stop");
		expect(done.message.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect(done.message.usage).toMatchObject({ input: 5, output: 2 });

		// every event carries the partial snapshot
		for (const e of events) {
			if (e.type !== "done" && e.type !== "error") {
				expect(e.partial).toBeDefined();
			}
		}
	});

	test("toolCalls step ends with toolUse and parses-free raw arguments", async () => {
		const faux = fauxProvider([{ toolCalls: [{ name: "bash", arguments: { cmd: "ls -la" } }] }]);
		const events = await collect(faux.streamFn(FAUX_MODEL, { systemPrompt: "", messages: [userMessage("run ls")] }));

		const end = events.find((e) => e.type === "toolcall_end") as any;
		expect(end.toolCall.name).toBe("bash");
		expect(JSON.parse(end.toolCall.arguments)).toEqual({ cmd: "ls -la" });
		expect((events.at(-1) as any).message.stopReason).toBe("toolUse");
	});

	test("assertContext receives the exact context per call", async () => {
		const seen: string[] = [];
		const faux = fauxProvider([
			{
				text: "one",
				assertContext: (ctx) => {
					seen.push(ctx.systemPrompt);
				},
			},
			{
				text: "two",
				assertContext: (ctx) => {
					seen.push(ctx.messages.map((m) => m.role).join(","));
				},
			},
		]);

		await collect(faux.streamFn(FAUX_MODEL, { systemPrompt: "s1", messages: [userMessage("a")] }));
		await collect(
			faux.streamFn(FAUX_MODEL, {
				systemPrompt: "s1",
				messages: [
					userMessage("a"),
					{
						role: "assistant",
						content: [],
						provider: "faux",
						model: "faux-1",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						stopReason: "stop",
						timestamp: 0,
					},
				],
			}),
		);

		expect(seen).toEqual(["s1", "user,assistant"]);
		expect(faux.receivedContexts).toHaveLength(2);
	});

	test("stopReason length scripting", async () => {
		const faux = fauxProvider([{ text: "partial", stopReason: "length" }]);
		const events = await collect(faux.streamFn(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect((events.at(-1) as any).message.stopReason).toBe("length");
	});

	test("throwError propagates (retry wrapper is the throw boundary)", async () => {
		const faux = fauxProvider([{ throwError: new Error("boom") }]);
		expect(async () => {
			await collect(faux.streamFn(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		}).toThrow("boom");
	});

	test("script exhaustion repeats last step", async () => {
		const faux = fauxProvider([{ text: "only" }]);
		const first = await collect(faux.streamFn(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		const second = await collect(faux.streamFn(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(first.length).toBeGreaterThan(0);
		expect(second.length).toBe(first.length);
	});
});
