// Long-form design notes: docs/dev/ai-layer.md
/** Repairs on a stored transcript, before it is sent anywhere. */

import type { AgentMessage } from "./types.ts";
import { textContent, toolResultMessage } from "./types.ts";

/**
 * The one wording for a tool call that was interrupted before it finished.
 *
 * Shared with the live agent loop, which settles the calls of a dying run with
 * the same sentence: a resumed transcript and a live transcript should read
 * alike, and two spellings would drift the first time either was edited.
 */
export const INTERRUPTED_TOOL_RESULT_TEXT = "Tool execution was interrupted before completion.";

/** What one repair pass did, in the counts its callers report. */
export interface ToolPairingRepair {
	messages: AgentMessage[];
	/**
	 * Blocks removed and turns emptied — the count the migration reports have
	 * always used. An interrupted call is no longer a dropped block, so this
	 * number falls where a call was answered instead; `synthesized` carries the
	 * other half of the same fact.
	 */
	dropped: number;
	/** Interrupted calls answered with a synthetic error result, one per call id. */
	synthesized: number;
	/** Input messages that do not appear in the output at all. */
	droppedMessages: number;
}

/**
 * Structural repair: an interrupted call is answered, an unpaired result goes.
 *
 * The messages API rejects a transcript that carries a tool call and no result,
 * so an unpaired call cannot simply be sent. Dropping both halves used to be
 * the repair, and it cost the user the model's own words — the assistant turn
 * asking for the tool usually says what it is doing and why. Instead the call
 * stays and a synthetic error result is placed immediately after it, which is
 * where the provider expects one and what the live loop already does when a
 * run dies mid-tool. A result whose call was never recorded is still dropped:
 * there is no wording of a call it could answer, and inventing one would put a
 * tool execution in the transcript that nobody asked for.
 *
 * A call with an empty id is the exception: nothing can name it, so it is
 * filtered exactly as before (and a turn that held only such calls is dropped,
 * because an empty content array is not a valid message).
 *
 * Idempotent by construction: a second pass finds the synthetic result paired
 * with its call, filters nothing, and synthesizes nothing, so the output is the
 * same list it was handed.
 */
export function repairToolPairing(messages: AgentMessage[]): ToolPairingRepair {
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId !== "") resultIds.add(message.toolCallId);
	}
	const callIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall" && block.id !== "") callIds.add(block.id);
	}

	let dropped = 0;
	let synthesized = 0;
	let droppedMessages = 0;
	const out: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			// An empty id names no call that could exist, and a result whose call is
			// absent cannot be answered — both go, as they always have.
			if (message.toolCallId !== "" && callIds.has(message.toolCallId)) out.push(message);
			else {
				dropped += 1;
				droppedMessages += 1;
			}
			continue;
		}
		if (message.role !== "assistant") {
			out.push(message);
			continue;
		}
		// Only the calls that can never be paired are filtered. An interrupted call
		// stays in the turn, with its text and thinking around it.
		const content = message.content.filter((block) => block.type !== "toolCall" || block.id !== "");
		dropped += message.content.length - content.length;
		// An assistant turn that held nothing but unnameable calls has nothing left
		// to say, and an empty content array is not a valid message.
		if (content.length === 0) {
			dropped += 1;
			droppedMessages += 1;
			continue;
		}
		out.push(content.length === message.content.length ? message : { ...message, content });
		// One synthetic result per call id, right after the turn that asked for it.
		// A repeated id is one call: answering it twice would put two results on the
		// wire for a call the provider counts once.
		const answered = new Set<string>();
		for (const block of content) {
			if (block.type !== "toolCall" || block.id === "") continue;
			if (resultIds.has(block.id) || answered.has(block.id)) continue;
			answered.add(block.id);
			out.push({
				...toolResultMessage(
					block.id,
					block.name,
					[textContent(INTERRUPTED_TOOL_RESULT_TEXT)],
					true,
					message.timestamp,
				),
				synthetic: true,
				// The repair and the live loop describe the same event, so the
				// marker is the same: a cancelled call, not a broken tool.
				interrupted: true,
			});
			synthesized += 1;
		}
	}
	return { messages: out, dropped, synthesized, droppedMessages };
}
