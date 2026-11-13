import { describe, expect, test } from "bun:test";
import { FAUX_MODEL, fauxProvider, userMessage } from "@labunbun/ai";
import { z } from "zod";
import { type AgentEvent, AgentSession, type AnyTool, buildTool } from "../src/index.ts";

const systemPrompt = "test system prompt";

function echoTool(): AnyTool {
	return buildTool({
		name: "echo",
		description: "echo text back",
		inputSchema: z.object({ text: z.string() }),
		call: async (input) => ({ content: [{ type: "text", text: input.text }] }),
	});
}

function session(streamFn: ConstructorParameters<typeof AgentSession>[0]["deps"]["streamFn"]) {
	const events: AgentEvent[] = [];
	const created = new AgentSession({
		model: FAUX_MODEL,
		systemPrompt,
		tools: [echoTool()],
		deps: { streamFn },
	});
	created.on((event) => {
		events.push(event);
	});
	return { session: created, events };
}

describe("AgentSession.aside", () => {
	test("answers from the transcript without adding the question or answer to it", async () => {
		const faux = fauxProvider([{ text: "first answer" }, { text: "aside answer" }, { text: "second answer" }]);
		const { session: asideSession, events } = session(faux.streamFn);

		expect(await asideSession.prompt("first question")).toBe("completed");
		const before = asideSession.messages.slice();

		expect(await asideSession.aside("what did that mean?")).toBe("aside answer");

		// The aside's own request saw the history plus the question, and no tools.
		const asideContext = faux.receivedContexts[1];
		expect(asideContext?.tools).toEqual([]);
		expect(asideContext?.messages.length).toBe(before.length + 1);
		// The question as the model sees it. The timestamp is the clock tick the
		// session stamped on its own copy, so asserting it would compare the test's
		// `Date.now()` to a call a millisecond earlier — a race, not a claim.
		const asked = asideContext?.messages.at(-1);
		expect({ role: asked?.role, content: asked?.content }).toEqual({
			role: "user",
			content: userMessage("what did that mean?").content,
		});

		// The live history is what it was: the next prompt sends no trace of it.
		expect(asideSession.messages).toEqual(before);
		await asideSession.prompt("second question");
		const nextContext = faux.receivedContexts[2];
		// The contexts are captured live, so this is read as text: neither the
		// question nor the answer may appear anywhere in what the model is sent.
		const sent = JSON.stringify(nextContext?.messages);
		expect(sent).not.toContain("what did that mean?");
		expect(sent).not.toContain("aside answer");
		expect(nextContext?.tools?.length ?? 0).toBeGreaterThan(0);

		// An aside is not a run: no start/end pair was emitted for it.
		expect(events.filter((event) => event.type === "agent_start")).toHaveLength(2);
	});

	test("surfaces a provider error instead of a silent empty answer", async () => {
		const faux = fauxProvider([{ stopReason: "error", errorMessage: "boom" }]);
		const { session: asideSession } = session(faux.streamFn);
		await expect(asideSession.aside("hello?")).rejects.toThrow("boom");
	});

	test("an aborted request reports AbortError", async () => {
		const faux = fauxProvider([{ abortIfSignaled: true }]);
		const { session: asideSession } = session(faux.streamFn);
		const controller = new AbortController();
		controller.abort();
		await expect(asideSession.aside("hello?", { signal: controller.signal })).rejects.toThrow("Aside interrupted");
	});

	test("refuses to run while a prompt is in flight", async () => {
		const faux = fauxProvider([{ text: "slow", delayMs: 30 }]);
		const { session: asideSession } = session(faux.streamFn);
		const running = asideSession.prompt("go");
		await expect(asideSession.aside("meanwhile")).rejects.toThrow("already running");
		expect(await running).toBe("completed");
	});
});
