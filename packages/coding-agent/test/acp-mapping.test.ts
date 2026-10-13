/**
 * The translations between this app's vocabulary and ACP's, asserted on the
 * wire shape rather than through a session.
 *
 * These are the places a mapping can be silently wrong in a way no client can
 * complain about: `isError` becoming "completed" paints a failed command green,
 * `aborted` becoming `end_turn` reports a cancelled turn as a finished one, and
 * a kind that says "read" for a write is a lie the editor renders. The e2e file
 * next door proves the wiring; these pin the meanings.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "@labunbun/agent";
import { assistantMessage, toolResultMessage, userMessage } from "@labunbun/ai";
import {
	acpPermissionOptions,
	permissionFromOptionId,
	permissionModeFromModeId,
	promptTextFrom,
	replayUpdatesForMessages,
	sessionModesFor,
	stopReasonFor,
	toolKindFor,
	toolTitleFor,
	updatesForEvent,
} from "../src/acp.ts";

function textDelta(delta: string): AgentEvent {
	const partial = assistantMessage({ content: [{ type: "text", text: delta }] });
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
	};
}

function thinkingDelta(delta: string): AgentEvent {
	const partial = assistantMessage({ content: [{ type: "thinking", thinking: delta }] });
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial },
	};
}

function toolEnd(callId: string, text: string, isError: boolean): AgentEvent {
	return {
		type: "tool_execution_end",
		callId,
		toolName: "Bash",
		result: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "Bash",
			content: [{ type: "text", text }],
			isError,
			timestamp: 0,
		},
	};
}

describe("stop reasons", () => {
	test("each end reason that has a protocol spelling maps to it", () => {
		expect(stopReasonFor("completed")).toBe("end_turn");
		// The cancel contract: `session/cancel` is a notification, and the answer to
		// the prompt it interrupted is this reason — not `end_turn`, and not an error.
		expect(stopReasonFor("aborted")).toBe("cancelled");
		expect(stopReasonFor("max_turns")).toBe("max_turn_requests");
	});

	test("error has no stop reason and says so instead of claiming one", () => {
		// `null` is the statement that the run failed: the caller turns it into a
		// JSON-RPC error. Mapping it to `end_turn` would report a broken run as a
		// completed one, and to `refusal` would blame the model for a transport.
		expect(stopReasonFor("error")).toBeNull();
	});
});

describe("tool updates", () => {
	test("a tool's start becomes a pending tool_call with kind and title", () => {
		const [update] = updatesForEvent({
			type: "tool_execution_start",
			callId: "call_1",
			toolName: "Bash",
			input: { command: "bun test" },
		});
		expect(update).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: "call_1",
			title: "Bash: bun test",
			kind: "execute",
			status: "pending",
			rawInput: { command: "bun test" },
		});
	});

	test("a partial update is announced as in_progress, without the partial", () => {
		const updates = updatesForEvent({
			type: "tool_execution_update",
			callId: "call_1",
			toolName: "Bash",
			partial: "half a build log",
		});
		expect(updates).toEqual([{ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress" }]);
	});

	test("a successful result completes the call and carries its text", () => {
		const [update] = updatesForEvent(toolEnd("call_1", "all green", false));
		expect(update.sessionUpdate).toBe("tool_call_update");
		if (update.sessionUpdate !== "tool_call_update") throw new Error("unreachable");
		expect(update.status).toBe("completed");
		expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "all green" } }]);
		expect(update.rawOutput).toEqual({ content: "all green", isError: false });
	});

	test("isError becomes failed — a command that exited 1 is not a completed call", () => {
		const [update] = updatesForEvent(toolEnd("call_1", "boom", true));
		if (update.sessionUpdate !== "tool_call_update") throw new Error("unreachable");
		expect(update.status).toBe("failed");
	});

	test("message deltas become chunks; the rest of a message's life becomes nothing", () => {
		expect(updatesForEvent(textDelta("hello"))).toEqual([
			{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
		]);
		expect(updatesForEvent(thinkingDelta("hmm"))).toEqual([
			{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
		]);
		// `text_end` repeats what the deltas already said; a second announcement
		// would duplicate the text in every editor that concatenates chunks.
		const partial = assistantMessage();
		expect(
			updatesForEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hello", partial },
			}),
		).toEqual([]);
		expect(updatesForEvent({ type: "agent_start" })).toEqual([]);
		expect(updatesForEvent({ type: "turn_start" })).toEqual([]);
		expect(updatesForEvent({ type: "retry", attempt: 1, delayMs: 1000, message: "socket" })).toEqual([]);
	});

	test("tool kinds come from the tool's own name, and the unknown default is other", () => {
		expect(toolKindFor("Read")).toBe("read");
		expect(toolKindFor("Edit")).toBe("edit");
		expect(toolKindFor("Grep")).toBe("search");
		expect(toolKindFor("Bash")).toBe("execute");
		expect(toolKindFor("WebFetch")).toBe("fetch");
		expect(toolKindFor("ExitPlanMode")).toBe("switch_mode");
		expect(toolKindFor("Task")).toBe("other");
	});

	test("a title is one line of the input that identifies the call", () => {
		expect(toolTitleFor("Read", { file_path: "/tmp/x.ts" })).toBe("Read: /tmp/x.ts");
		expect(toolTitleFor("Bash", { command: "echo  a\n  b" })).toBe("Bash: echo a b");
		expect(toolTitleFor("Bash", {})).toBe("Bash");
		const long = toolTitleFor("Bash", { command: "x".repeat(200) });
		expect(long.length).toBeLessThanOrEqual(100);
		expect(long.endsWith("…")).toBe(true);
	});

	test("a subagent prompt is a title, not a wall of text", () => {
		expect(toolTitleFor("Task", { description: "audit the parser" })).toBe("Task: audit the parser");
	});
});

describe("history replay", () => {
	test("the stored conversation becomes frames in file order, one per piece", () => {
		// A turn as a session file holds it: the question, thinking, a tool call
		// and its result, then the answer that used the result.
		const messages = [
			userMessage("what does the config say"),
			assistantMessage({
				content: [
					{ type: "thinking", thinking: "checking the config" },
					{ type: "text", text: "let me look" },
					{ type: "toolCall", id: "call_1", name: "Read", arguments: JSON.stringify({ file_path: "config.json" }) },
				],
			}),
			toolResultMessage("call_1", "Read", [{ type: "text", text: "port = 8080" }]),
			assistantMessage({ content: [{ type: "text", text: "the port is 8080" }] }),
		];
		expect(replayUpdatesForMessages(messages)).toEqual([
			{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "what does the config say" } },
			{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking the config" } },
			{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "let me look" } },
			{
				sessionUpdate: "tool_call",
				toolCallId: "call_1",
				title: "Read: config.json",
				kind: "read",
				status: "pending",
				rawInput: { file_path: "config.json" },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call_1",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "port = 8080" } }],
				rawOutput: { content: "port = 8080", isError: false },
			},
			{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the port is 8080" } },
		]);
	});

	test("parallel calls finish in the order their results sit in the file", () => {
		const updates = replayUpdatesForMessages([
			assistantMessage({
				content: [
					{ type: "toolCall", id: "call_a", name: "Read", arguments: '{"file_path":"a.ts"}' },
					{ type: "toolCall", id: "call_b", name: "Read", arguments: '{"file_path":"b.ts"}' },
				],
			}),
			toolResultMessage("call_b", "Read", [{ type: "text", text: "b" }]),
			toolResultMessage("call_a", "Read", [{ type: "text", text: "a" }]),
		]);
		expect(
			updates.map((update) =>
				update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
					? `${update.sessionUpdate}:${update.toolCallId}`
					: update.sessionUpdate,
			),
		).toEqual(["tool_call:call_a", "tool_call:call_b", "tool_call_update:call_b", "tool_call_update:call_a"]);
	});

	test("a call whose result never came is announced and left pending", () => {
		// `pending` is the live announcement's own status and the only value that
		// claims nothing: the file does not say the call failed, finished, or is
		// running now.
		const updates = replayUpdatesForMessages([
			assistantMessage({
				content: [{ type: "toolCall", id: "call_9", name: "Bash", arguments: '{"command":"bun test"}' }],
			}),
		]);
		expect(updates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "call_9",
				title: "Bash: bun test",
				kind: "execute",
				status: "pending",
				rawInput: { command: "bun test" },
			},
		]);
	});

	test("a result whose call is gone is still shown, over a row built from the result", () => {
		// The damaged-file case: the announcement is reconstructed from what the
		// result itself knows. Dropping the result instead would quietly shorten
		// the conversation the editor shows.
		const updates = replayUpdatesForMessages([
			toolResultMessage("call_3", "Bash", [{ type: "text", text: "boom" }], true),
		]);
		expect(updates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "call_3",
				title: "Bash",
				kind: "execute",
				status: "pending",
				rawInput: {},
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call_3",
				status: "failed",
				content: [{ type: "content", content: { type: "text", text: "boom" } }],
				rawOutput: { content: "boom", isError: true },
			},
		]);
	});

	test("an image the user attached is replayed as an image chunk, not dropped", () => {
		expect(
			replayUpdatesForMessages([
				userMessage([
					{ type: "text", text: "look at this" },
					{ type: "image", mimeType: "image/png", data: "AAAA" },
				]),
			]),
		).toEqual([
			{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "look at this" } },
			{ sessionUpdate: "user_message_chunk", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
		]);
	});

	test("a call whose arguments never parsed keeps its raw text as the input", () => {
		const [update] = replayUpdatesForMessages([
			assistantMessage({ content: [{ type: "toolCall", id: "call_4", name: "Bash", arguments: "{not json" }] }),
		]);
		expect(update).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: "call_4",
			title: "Bash",
			kind: "execute",
			status: "pending",
			rawInput: { input: "{not json" },
		});
	});

	test("a message with nothing to show contributes no frames", () => {
		expect(replayUpdatesForMessages([assistantMessage()])).toEqual([]);
	});
});

describe("prompt blocks", () => {
	test("text blocks are joined in order", () => {
		expect(
			promptTextFrom([
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			]),
		).toBe("first\n\nsecond");
	});

	test("a resource link arrives as this app's own mention spelling", () => {
		// The URI an editor on this platform actually sends: file URLs are built
		// from the platform's own paths, and `fileURLToPath` inverts exactly that
		// (measured on win32: `file:///C:/...` converts, the POSIX-looking
		// `file:///tmp/...` throws — so the test may only assert the native form).
		const filePath = join(tmpdir(), "project", "src", "main.ts");
		const text = promptTextFrom([{ type: "resource_link", uri: pathToFileURL(filePath).href, name: "main.ts" }]);
		// `@path` is what Read opens and what the transcript shows, so a file the
		// user referenced in the editor is the same message as one referenced in
		// the REPL, and the path is the platform's own spelling.
		expect(text).toBe(`@${filePath}`);
		expect(text).not.toContain("file:");
	});

	test("a non-file URI is passed through as it was sent", () => {
		expect(promptTextFrom([{ type: "resource_link", uri: "untitled:Untitled-1", name: "x" }])).toBe(
			"@untitled:Untitled-1",
		);
	});

	test("an unsupported block is dropped without taking the text with it", () => {
		const text = promptTextFrom([
			{ type: "text", text: "look at this" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		expect(text).toBe("look at this");
	});
});

describe("permission options", () => {
	test("the four kinds are offered, and the labels are the REPL's", () => {
		const options = acpPermissionOptions("Write", { file_path: "/w/sub/out.txt", content: "x" }, "/w");
		expect(options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
		expect(options.map((o) => o.optionId)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
		// The shared table, not a second copy of it: the "always" label names the
		// scope `ruleSpecifierFor` actually grants.
		expect(options[1]?.name).toContain("files under `sub/`");
		// The fourth kind has no REPL counterpart; its label has to say what it does
		// differently, or two "no" answers look identical and one of them is permanent.
		expect(options[3]?.name).toContain("Write");
		expect(options[3]?.name).toContain("this session");
	});

	test("option ids map back to allow/deny and remembering, and an unknown one fails closed", () => {
		expect(permissionFromOptionId("allow_once")).toEqual({ allow: true, remember: false });
		expect(permissionFromOptionId("allow_always")).toEqual({ allow: true, remember: true });
		expect(permissionFromOptionId("reject_once")).toEqual({ allow: false, remember: false });
		expect(permissionFromOptionId("reject_always")).toEqual({ allow: false, remember: true });
		expect(permissionFromOptionId("allow_everything_forever")).toBeNull();
	});
});

describe("session modes", () => {
	test("the three approval modes are advertised, with the table's own labels", () => {
		const state = sessionModesFor("ask");
		expect(state.currentModeId).toBe("ask");
		expect(state.availableModes.map((m) => m.id)).toEqual(["ask", "plan", "agent"]);
		for (const mode of state.availableModes) {
			expect(mode.name).not.toBe("");
			expect(mode.description ?? "").not.toBe("");
		}
	});

	test("a mode id the agent advertises maps back to its approval mode; anything else does not", () => {
		expect(permissionModeFromModeId("ask")).toBe("ask");
		expect(permissionModeFromModeId("plan")).toBe("plan");
		expect(permissionModeFromModeId("agent")).toBe("agent");
		// The sandbox pairing is one opaque id in the protocol, so `agentNoSandbox`
		// is deliberately not a settable mode here.
		expect(permissionModeFromModeId("agentNoSandbox")).toBeUndefined();
		expect(permissionModeFromModeId("bypassPermissions")).toBeUndefined();
	});
});
