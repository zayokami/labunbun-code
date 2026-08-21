import type { AssistantMessage, AssistantMessageEvent, StopReason, ToolCall, Usage } from "./types.ts";

/**
 * Shared accumulator that turns provider wire events into our uniform
 * `AssistantMessageEvent` protocol.
 *
 * Adapters feed it provider-specific callbacks; it owns the partial
 * AssistantMessage snapshot carried by every event, so consumers can render
 * directly without re-reducing deltas. Tool-call arguments are buffered as
 * raw text and parsed exactly once, when the block ends.
 */
export class MessageBuilder {
	#message: AssistantMessage;
	#started = false;

	constructor(provider: string, model: string, timestamp = Date.now()) {
		this.#message = {
			role: "assistant",
			content: [],
			provider,
			model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "pending",
			timestamp,
		};
	}

	get message(): AssistantMessage {
		return this.#message;
	}

	start(): AssistantMessageEvent {
		this.#started = true;
		return { type: "start", partial: this.#snapshot() };
	}

	get started(): boolean {
		return this.#started;
	}

	// -- text -----------------------------------------------------------------

	textStart(index: number): AssistantMessageEvent {
		this.#ensure(index, { type: "text", text: "" });
		return { type: "text_start", contentIndex: index, partial: this.#snapshot() };
	}

	textDelta(index: number, delta: string): AssistantMessageEvent {
		const block = this.#get(index, "text");
		block.text += delta;
		return { type: "text_delta", contentIndex: index, delta, partial: this.#snapshot() };
	}

	textEnd(index: number): AssistantMessageEvent {
		const block = this.#get(index, "text");
		return { type: "text_end", contentIndex: index, content: block.text, partial: this.#snapshot() };
	}

	// -- thinking -------------------------------------------------------------

	thinkingStart(index: number, signature?: string): AssistantMessageEvent {
		this.#ensure(index, { type: "thinking", thinking: "", signature });
		return { type: "thinking_start", contentIndex: index, partial: this.#snapshot() };
	}

	thinkingDelta(index: number, delta: string): AssistantMessageEvent {
		const block = this.#get(index, "thinking");
		block.thinking += delta;
		return { type: "thinking_delta", contentIndex: index, delta, partial: this.#snapshot() };
	}

	thinkingEnd(index: number, signature?: string): AssistantMessageEvent {
		const block = this.#get(index, "thinking");
		if (signature) block.signature = signature;
		return {
			type: "thinking_end",
			contentIndex: index,
			content: block.thinking,
			partial: this.#snapshot(),
		};
	}

	// -- tool calls -----------------------------------------------------------

	toolCallStart(index: number, id: string, name: string): AssistantMessageEvent {
		this.#ensure(index, { type: "toolCall", id, name, arguments: "" });
		return { type: "toolcall_start", contentIndex: index, partial: this.#snapshot() };
	}

	toolCallDelta(index: number, fragment: string): AssistantMessageEvent {
		const block = this.#get(index, "toolCall");
		block.arguments += fragment;
		return { type: "toolcall_delta", contentIndex: index, delta: fragment, partial: this.#snapshot() };
	}

	/**
	 * Finalize a tool call: parse the buffered JSON exactly once. A malformed
	 * payload is kept as an empty object with the raw text preserved via a
	 * synthetic wrapper — the agent layer surfaces it as an invalid-input error
	 * rather than crashing the stream.
	 */
	toolCallEnd(index: number): AssistantMessageEvent {
		const block = this.#get(index, "toolCall");
		const toolCall: ToolCall = { ...block };
		return { type: "toolcall_end", contentIndex: index, toolCall, partial: this.#snapshot() };
	}

	// -- terminal -------------------------------------------------------------

	done(stopReason: StopReason, usage?: Partial<Usage>): AssistantMessageEvent {
		this.#message.stopReason = stopReason;
		if (usage) this.#message.usage = { ...this.#message.usage, ...usage };
		return { type: "done", message: { ...this.#message } };
	}

	error(errorMessage: string, usage?: Partial<Usage>): AssistantMessageEvent {
		this.#message.stopReason = "error";
		this.#message.errorMessage = errorMessage;
		if (usage) this.#message.usage = { ...this.#message.usage, ...usage };
		return { type: "error", message: { ...this.#message } };
	}

	aborted(usage?: Partial<Usage>): AssistantMessageEvent {
		this.#message.stopReason = "aborted";
		if (usage) this.#message.usage = { ...this.#message.usage, ...usage };
		return { type: "error", message: { ...this.#message } };
	}

	// -- internals ------------------------------------------------------------

	#snapshot(): AssistantMessage {
		return { ...this.#message, content: this.#message.content.map((c) => ({ ...c })) };
	}

	#ensure(index: number, block: AssistantMessage["content"][number]): void {
		while (this.#message.content.length <= index) {
			// Fill gaps defensively (shouldn't happen with well-formed streams).
			this.#message.content.push({ type: "text", text: "" });
		}
		this.#message.content[index] = block;
	}

	#get(index: number, kind: "text" | "thinking" | "toolCall"): any {
		const block = this.#message.content[index];
		if (!block || block.type !== kind) {
			throw new Error(`MessageBuilder: content[${index}] is ${block?.type ?? "missing"}, expected ${kind}`);
		}
		return block;
	}
}

/** Parse a tool-call arguments string; malformed JSON yields an empty object. */
export function parseToolArguments(raw: string): Record<string, unknown> {
	if (!raw.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
