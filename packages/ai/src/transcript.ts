/**
 * Repairs on a stored transcript, before it is sent anywhere.
 *
 * A conversation that has been read back from disk, converted from another
 * tool's history, or reassembled after a damaged line was skipped is a list of
 * messages that may no longer be well-formed. The provider is the judge of
 * that, and its verdict is a 400 with no message index and no explanation —
 * so the repair happens here, where the structure is still in hand.
 */
import type { AgentMessage } from "./types.ts";

/**
 * Structural repair: both halves of an unpaired tool call go.
 *
 * A transcript with a call and no result — or a result whose call was dropped
 * upstream — is rejected by the messages API on the next request, so it would
 * import as a session that can be listed but never resumed.
 */
export function repairToolPairing(messages: AgentMessage[]): { messages: AgentMessage[]; dropped: number } {
	const callIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") callIds.add(block.id);
	}
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") resultIds.add(message.toolCallId);
	}

	let dropped = 0;
	const out: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			if (callIds.has(message.toolCallId)) out.push(message);
			else dropped += 1;
			continue;
		}
		if (message.role !== "assistant") {
			out.push(message);
			continue;
		}
		const content = message.content.filter((block) => block.type !== "toolCall" || resultIds.has(block.id));
		dropped += message.content.length - content.length;
		// An assistant turn that held nothing but the dropped call has nothing left
		// to say, and an empty content array is not a valid message.
		if (content.length === 0) {
			dropped += 1;
			continue;
		}
		out.push({ ...message, content });
	}
	return { messages: out, dropped };
}
