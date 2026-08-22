/**
 * The streaming accumulator every provider adapter feeds.
 *
 * Two properties are worth pinning down because a violation shows up as a
 * corrupted transcript rather than an exception: the partial snapshot on each
 * event must reflect the stream so far, and blocks the event did not touch must
 * be shared rather than copied — consumers rely on that to render deltas without
 * re-reducing, and the hot path relies on it to avoid a full copy per delta.
 */
import { describe, expect, test } from "bun:test";
import { MessageBuilder, parseToolArguments } from "../src/message-builder.ts";
import type { AssistantMessageEvent } from "../src/types.ts";

/** The partial carried by an event, for the events that carry one. */
function partialOf(event: AssistantMessageEvent) {
	return "partial" in event ? event.partial : undefined;
}

describe("MessageBuilder lifecycle", () => {
	test("starts empty, pending, with the given provider and model", () => {
		const b = new MessageBuilder("anthropic", "claude-sonnet-5", 1234);
		expect(b.message).toMatchObject({
			role: "assistant",
			content: [],
			provider: "anthropic",
			model: "claude-sonnet-5",
			stopReason: "pending",
			timestamp: 1234,
		});
		expect(b.message.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("tracks whether start has been emitted", () => {
		const b = new MessageBuilder("p", "m", 0);
		expect(b.started).toBe(false);
		expect(b.start().type).toBe("start");
		expect(b.started).toBe(true);
	});
});

describe("text blocks", () => {
	test("accumulates deltas into one block", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		b.textDelta(0, "Hel");
		b.textDelta(0, "lo");
		expect(b.message.content[0]).toEqual({ type: "text", text: "Hello" });
	});

	test("each delta event carries the text so far, not just the delta", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		const first = b.textDelta(0, "Hel");
		const second = b.textDelta(0, "lo");
		expect(partialOf(first)?.content[0]).toEqual({ type: "text", text: "Hel" });
		expect(partialOf(second)?.content[0]).toEqual({ type: "text", text: "Hello" });
		expect(first).toMatchObject({ type: "text_delta", contentIndex: 0, delta: "Hel" });
	});

	test("textEnd reports the finished content", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		b.textDelta(0, "done");
		expect(b.textEnd(0)).toMatchObject({ type: "text_end", contentIndex: 0, content: "done" });
	});

	test("an empty delta leaves the text as it was", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		b.textDelta(0, "");
		expect(b.message.content[0]).toEqual({ type: "text", text: "" });
	});
});

describe("thinking blocks", () => {
	test("accumulates deltas and keeps the signature from the start event", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.thinkingStart(0, "sig-1");
		b.thinkingDelta(0, "step ");
		b.thinkingDelta(0, "two");
		expect(b.message.content[0]).toEqual({ type: "thinking", thinking: "step two", signature: "sig-1" });
	});

	test("a signature on the end event replaces the earlier one", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.thinkingStart(0, "old");
		b.thinkingEnd(0, "new");
		expect(b.message.content[0]).toMatchObject({ signature: "new" });
	});

	test("no signature on the end event keeps the one already there", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.thinkingStart(0, "keep");
		b.thinkingEnd(0);
		expect(b.message.content[0]).toMatchObject({ signature: "keep" });
	});

	test("thinkingEnd reports the accumulated content", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.thinkingStart(0);
		b.thinkingDelta(0, "reasoning");
		expect(b.thinkingEnd(0)).toMatchObject({ type: "thinking_end", contentIndex: 0, content: "reasoning" });
	});
});

describe("tool call blocks", () => {
	test("buffers argument fragments as raw text", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.toolCallStart(0, "call-1", "Bash");
		b.toolCallDelta(0, '{"command":');
		b.toolCallDelta(0, '"ls"}');
		expect(b.message.content[0]).toEqual({
			type: "toolCall",
			id: "call-1",
			name: "Bash",
			arguments: '{"command":"ls"}',
		});
	});

	test("toolCallEnd reports the finished call, id and name included", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.toolCallStart(0, "call-1", "Read");
		b.toolCallDelta(0, '{"file_path":"a.ts"}');
		const event = b.toolCallEnd(0);
		expect(event.type).toBe("toolcall_end");
		expect(event).toMatchObject({ toolCall: { id: "call-1", name: "Read", arguments: '{"file_path":"a.ts"}' } });
	});

	test("a call with no arguments ends with an empty buffer rather than failing", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.toolCallStart(0, "c", "TaskList");
		const event = b.toolCallEnd(0);
		expect(event).toMatchObject({ toolCall: { arguments: "" } });
	});
});

describe("mixed content", () => {
	test("interleaves text, thinking, and tool calls at their own indexes", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.thinkingStart(0);
		b.thinkingDelta(0, "plan");
		b.textStart(1);
		b.textDelta(1, "Running it.");
		b.toolCallStart(2, "c1", "Bash");
		b.toolCallDelta(2, "{}");
		expect(b.message.content.map((c) => c.type)).toEqual(["thinking", "text", "toolCall"]);
	});

	test("deltas to different blocks do not bleed into each other", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		b.textStart(1);
		b.textDelta(0, "first");
		b.textDelta(1, "second");
		expect(b.message.content[0]).toEqual({ type: "text", text: "first" });
		expect(b.message.content[1]).toEqual({ type: "text", text: "second" });
	});

	test("a gap in indexes is filled rather than left undefined", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(2);
		expect(b.message.content).toHaveLength(3);
		expect(b.message.content[0]).toEqual({ type: "text", text: "" });
		expect(b.message.content[1]).toEqual({ type: "text", text: "" });
	});
});

describe("snapshot sharing", () => {
	// Copy-on-write: the changed block is copied so an earlier snapshot keeps its
	// value, and the untouched blocks are shared so a delta does not copy the
	// whole content array.
	test("an earlier snapshot keeps the value it was taken with", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		const first = partialOf(b.textDelta(0, "one"));
		b.textDelta(0, "-two");
		expect(first?.content[0]).toEqual({ type: "text", text: "one" });
		expect(b.message.content[0]).toEqual({ type: "text", text: "one-two" });
	});

	test("blocks the event did not touch are shared, not copied", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		b.textStart(1);
		const snapshot = partialOf(b.textDelta(1, "x"));
		expect(snapshot?.content[0]).toBe(b.message.content[0]);
		expect(snapshot?.content[1]).not.toBe(b.message.content[1]);
	});

	test("a snapshot is a distinct message object from the builder's own", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		expect(partialOf(b.textDelta(0, "x"))).not.toBe(b.message);
	});
});

describe("terminal events", () => {
	test("done records the stop reason and merges usage", () => {
		const b = new MessageBuilder("p", "m", 0);
		const event = b.done("stop", { input: 10, output: 20 });
		expect(event.type).toBe("done");
		expect(b.message.stopReason).toBe("stop");
		// Merged, not replaced: the fields the provider omitted keep their zeros.
		expect(b.message.usage).toEqual({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0 });
	});

	test("done without usage leaves the counters alone", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.done("stop");
		expect(b.message.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("error records the reason, the message, and any usage billed before it", () => {
		const b = new MessageBuilder("p", "m", 0);
		const event = b.error("provider down", { input: 5 });
		expect(event.type).toBe("error");
		expect(b.message.stopReason).toBe("error");
		expect(b.message.errorMessage).toBe("provider down");
		expect(b.message.usage.input).toBe(5);
	});

	test("aborted is an error event with the aborted reason and no message", () => {
		const b = new MessageBuilder("p", "m", 0);
		const event = b.aborted({ output: 7 });
		expect(event.type).toBe("error");
		expect(b.message.stopReason).toBe("aborted");
		expect(b.message.errorMessage).toBeUndefined();
		expect(b.message.usage.output).toBe(7);
	});

	test("terminal events carry the content accumulated so far", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		b.textDelta(0, "partial answer");
		const event = b.done("stop");
		expect("message" in event && event.message.content[0]).toEqual({ type: "text", text: "partial answer" });
	});
});

describe("malformed streams", () => {
	// A provider that sends a delta for a block it never opened, or opens a block
	// as one type and deltas it as another, is a bug worth failing loudly on
	// rather than silently writing to the wrong block.
	test("a delta for a block that was never opened throws, naming the index", () => {
		const b = new MessageBuilder("p", "m", 0);
		expect(() => b.textDelta(3, "x")).toThrow(/content\[3\]/);
	});

	test("a delta whose type does not match the block throws, naming both types", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		expect(() => b.toolCallDelta(0, "{}")).toThrow(/is text, expected toolCall/);
		expect(() => b.thinkingDelta(0, "x")).toThrow(/expected thinking/);
	});

	test("reopening an index replaces the block rather than merging into it", () => {
		const b = new MessageBuilder("p", "m", 0);
		b.textStart(0);
		b.textDelta(0, "old");
		b.toolCallStart(0, "c", "Bash");
		expect(b.message.content[0]).toEqual({ type: "toolCall", id: "c", name: "Bash", arguments: "" });
	});
});

describe("parseToolArguments", () => {
	test("parses an object", () => {
		expect(parseToolArguments('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
	});

	test("an empty or whitespace-only payload is an empty object", () => {
		expect(parseToolArguments("")).toEqual({});
		expect(parseToolArguments("   \n\t ")).toEqual({});
	});

	// Malformed arguments must not crash the stream; the agent layer reports them
	// as an invalid-input error instead.
	test("malformed JSON is an empty object, not a throw", () => {
		expect(parseToolArguments("{not json")).toEqual({});
		expect(parseToolArguments('{"a":')).toEqual({});
	});

	test("valid JSON that is not an object is an empty object", () => {
		expect(parseToolArguments("42")).toEqual({});
		expect(parseToolArguments('"a string"')).toEqual({});
		expect(parseToolArguments("true")).toEqual({});
		expect(parseToolArguments("null")).toEqual({});
	});

	test("an array parses as-is, since it is an object", () => {
		expect(parseToolArguments("[1,2]")).toEqual([1, 2] as unknown as Record<string, unknown>);
	});

	test("nested structures survive intact", () => {
		expect(parseToolArguments('{"a":{"b":[1,{"c":2}]}}')).toEqual({ a: { b: [1, { c: 2 }] } });
	});
});
