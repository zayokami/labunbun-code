/**
 * The repair a stored transcript goes through before it is sent anywhere.
 *
 * The property that matters is not "the list is well formed" — that can be had
 * by deleting the user's conversation. It is that an interrupted tool call
 * keeps the assistant turn that asked for it, gets exactly one answer placed
 * where the provider expects one, and that a second pass over the repaired
 * output changes nothing: resume, migration and fork all run this on lists that
 * may already have been through it.
 */
import { describe, expect, test } from "bun:test";
import { INTERRUPTED_TOOL_RESULT_TEXT, repairToolPairing } from "../src/transcript.ts";
import type { AgentMessage, AssistantMessage, ToolCall, ToolResultMessage } from "../src/types.ts";
import { assistantMessage, textContent, toolResultMessage, userMessage } from "../src/types.ts";

function call(id: string, name = "Read"): ToolCall {
	return { type: "toolCall", id, name, arguments: "{}" };
}

function assistant(content: AssistantMessage["content"], timestamp = 1000): AssistantMessage {
	return assistantMessage({ content, timestamp, stopReason: "toolUse" });
}

function result(toolCallId: string, text = "output", timestamp = 1000): ToolResultMessage {
	return toolResultMessage(toolCallId, "Read", [textContent(text)], false, timestamp);
}

/** The roles a repaired list reads as, for the tests about shape. */
function roles(messages: AgentMessage[]): string[] {
	return messages.map((message) => message.role);
}

describe("an interrupted tool call", () => {
	test("keeps the assistant turn and is answered immediately after it", () => {
		const user = userMessage("run it");
		const turn = assistant([textContent("checking the file"), call("t1")]);
		const repaired = repairToolPairing([user, turn]);

		expect(roles(repaired.messages)).toEqual(["user", "assistant", "toolResult"]);
		// The turn is the original object: the repair does not rewrite words it did
		// not have to touch, which is what keeps a fork's prefix byte-identical.
		expect(repaired.messages[1]).toBe(turn);
		const synthetic = repaired.messages[2];
		if (synthetic?.role !== "toolResult") throw new Error("expected a synthetic tool result");
		expect(synthetic).toEqual({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "Read",
			content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
			isError: true,
			// The owning turn's time, so a transcript ordered by timestamp keeps the
			// answer beside its question rather than at the moment of the repair.
			timestamp: 1000,
			synthetic: true,
		});
		expect(repaired.dropped).toBe(0);
		expect(repaired.synthesized).toBe(1);
		expect(repaired.droppedMessages).toBe(0);
	});

	test("the wording is the live loop's own, exported from the library", () => {
		expect(INTERRUPTED_TOOL_RESULT_TEXT).toBe("Tool execution was interrupted before completion.");
	});

	test("several calls in one turn are answered in the order they were made", () => {
		const turn = assistant([call("a"), textContent("between"), call("b")]);
		const repaired = repairToolPairing([userMessage("go"), turn]);

		expect(roles(repaired.messages)).toEqual(["user", "assistant", "toolResult", "toolResult"]);
		expect(
			repaired.messages.slice(2).map((message) => (message.role === "toolResult" ? message.toolCallId : "")),
		).toEqual(["a", "b"]);
		expect(repaired.synthesized).toBe(2);
	});

	test("a repeated call id in one turn is one call, answered once", () => {
		const turn = assistant([call("t1"), call("t1", "Edit")]);
		const repaired = repairToolPairing([turn]);

		expect(repaired.messages).toHaveLength(2);
		expect(repaired.synthesized).toBe(1);
		expect(repaired.messages[1]?.role === "toolResult" ? repaired.messages[1].toolName : "").toBe("Read");
	});

	test("a turn that already has a real result is not answered", () => {
		const user = userMessage("go");
		const turn = assistant([call("t1")]);
		const real = result("t1", "the tool's own words");
		const repaired = repairToolPairing([user, turn, real]);

		expect(repaired.messages).toEqual([user, turn, real]);
		expect(repaired.messages[2]).toBe(real);
		expect(repaired.synthesized).toBe(0);
		expect(repaired.dropped).toBe(0);
		expect(repaired.droppedMessages).toBe(0);
	});

	test("a result that arrives later in the list still counts as an answer", () => {
		// The repair does not require adjacency to decide that a call was answered;
		// reordering is not its job, and inventing a second result for a call the
		// transcript already answers would be worse than the adjacency it lacks.
		const turn = assistant([call("t1")]);
		const repaired = repairToolPairing([turn, userMessage("meanwhile"), result("t1")]);

		expect(repaired.synthesized).toBe(0);
		expect(repaired.dropped).toBe(0);
		expect(roles(repaired.messages)).toEqual(["assistant", "user", "toolResult"]);
	});
});

describe("an unpaired tool result", () => {
	test("is dropped, and the message count says so", () => {
		const orphan = result("gone", "nothing called me");
		const repaired = repairToolPairing([userMessage("hi"), orphan]);

		expect(repaired.messages.map((message) => message.role)).toEqual(["user"]);
		expect(repaired.dropped).toBe(1);
		expect(repaired.synthesized).toBe(0);
		expect(repaired.droppedMessages).toBe(1);
	});

	test("stays dropped even beside a call with a different id", () => {
		const repaired = repairToolPairing([assistant([call("t1")]), result("t2")]);

		expect(roles(repaired.messages)).toEqual(["assistant", "toolResult"]);
		expect(repaired.messages[1]?.role === "toolResult" ? repaired.messages[1].toolCallId : "").toBe("t1");
		expect(repaired.dropped).toBe(1);
		expect(repaired.synthesized).toBe(1);
		expect(repaired.droppedMessages).toBe(1);
	});

	test("an empty id names no call, so it is dropped like any other orphan", () => {
		const repaired = repairToolPairing([userMessage("hi"), result("")]);

		expect(roles(repaired.messages)).toEqual(["user"]);
		expect(repaired.dropped).toBe(1);
		expect(repaired.droppedMessages).toBe(1);
	});
});

describe("a call with no id", () => {
	test("is filtered, never synthesized, and a turn left with nothing goes", () => {
		const user = userMessage("hi");
		const turn = assistant([call("")]);
		const repaired = repairToolPairing([user, turn]);

		expect(repaired.messages).toEqual([user]);
		expect(repaired.synthesized).toBe(0);
		// The block, and the turn it emptied.
		expect(repaired.dropped).toBe(2);
		expect(repaired.droppedMessages).toBe(1);
	});

	test("is filtered out of a turn that keeps the words around it", () => {
		const turn = assistant([textContent("still says this"), call("")]);
		const repaired = repairToolPairing([turn]);

		expect(repaired.messages).toHaveLength(1);
		const kept = repaired.messages[0];
		if (kept?.role !== "assistant") throw new Error("expected an assistant message");
		expect(kept.content).toEqual([{ type: "text", text: "still says this" }]);
		expect(repaired.synthesized).toBe(0);
		expect(repaired.dropped).toBe(1);
		expect(repaired.droppedMessages).toBe(0);
	});
});

describe("idempotency", () => {
	test("a second pass adds nothing, removes nothing, and is byte-identical", () => {
		const first = repairToolPairing([
			userMessage("go"),
			assistant([textContent("looking"), call("t1"), call("t2")]),
			result("gone"),
			assistant([call("")]),
		]);
		// The first pass did some of everything: synthesized two answers, dropped an
		// orphan result, and dropped the turn that held only an unnameable call.
		expect(first.synthesized).toBe(2);
		expect(first.dropped).toBe(3);
		expect(first.droppedMessages).toBe(2);

		const second = repairToolPairing(first.messages);
		expect(second.synthesized).toBe(0);
		expect(second.dropped).toBe(0);
		expect(second.droppedMessages).toBe(0);
		expect(second.messages).toHaveLength(first.messages.length);
		expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
	});

	test("the repaired list is unchanged on repeated application", () => {
		const once = repairToolPairing([assistant([call("t1")])]).messages;
		const twice = repairToolPairing(once).messages;
		const thrice = repairToolPairing(twice).messages;
		expect(JSON.stringify(thrice)).toBe(JSON.stringify(once));
	});

	test("an already-paired transcript is returned as it stands", () => {
		const messages = [userMessage("x"), assistant([textContent("y"), call("t1")]), result("t1")];
		const repaired = repairToolPairing(messages);

		expect(repaired.messages).toEqual(messages);
		expect(repaired.dropped).toBe(0);
		expect(repaired.synthesized).toBe(0);
		expect(repaired.droppedMessages).toBe(0);
	});
});

describe("messages the repair does not own", () => {
	test("user messages and their content blocks pass through untouched", () => {
		const user = userMessage([
			{ type: "text", text: "look at this" },
			{ type: "image", mimeType: "image/png", data: "QUJD" },
		]);
		const repaired = repairToolPairing([user]);
		expect(repaired.messages).toEqual([user]);
		expect(repaired.messages[0]).toBe(user);
	});

	test("an empty transcript stays empty", () => {
		expect(repairToolPairing([])).toEqual({
			messages: [],
			dropped: 0,
			synthesized: 0,
			droppedMessages: 0,
		});
	});

	test("a real result carries no synthetic marker", () => {
		const real = result("t1");
		expect(repairToolPairing([assistant([call("t1")]), real]).messages[1]).toBe(real);
		expect("synthetic" in real).toBe(false);
	});
});
