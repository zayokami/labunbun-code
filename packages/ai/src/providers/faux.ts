/**
 * Scripted fake provider for tests — the backbone of the zero-network test
 * strategy. Each `stream()` call consumes the next script step; a step either
 * provides shorthand (text/toolCalls) or a raw event list, and can assert on
 * the Context it receives.
 */

import { MessageBuilder } from "../message-builder.ts";
import type { AssistantMessageEvent, Context, Model, StreamFn, ToolCall } from "../types.ts";

export const FAUX_MODEL: Model = {
	id: "faux-1",
	name: "Faux Model",
	api: "anthropic-messages",
	provider: "faux",
	baseUrl: "",
	apiKeyEnv: "FAUX_API_KEY",
	contextWindow: 200_000,
	maxOutputTokens: 8_192,
	reasoning: false,
	input: ["text"],
};

export interface FauxToolCallSpec {
	id?: string;
	name: string;
	/** JSON object (not string) — stringified into raw arguments. */
	arguments: Record<string, unknown>;
}

export interface FauxStep {
	/** Shorthand: plain text response. */
	text?: string;
	/** Shorthand: text + tool calls (stopReason toolUse). */
	toolCalls?: FauxToolCallSpec[];
	/** Shorthand: thinking text emitted before text/toolCalls. */
	thinking?: string;
	/** Full control: raw events emitted verbatim after `start`. */
	events?: AssistantMessageEvent[];
	/** Terminal stopReason override (e.g. "length", "error"). */
	stopReason?: "stop" | "toolUse" | "length" | "error" | "aborted";
	/** Error message when stopReason is "error"/"aborted". */
	errorMessage?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	/** Thrown (not emitted) when the model call receives a mismatching context. */
	assertContext?: (context: Context, callIndex: number) => void;
	/** Throw instead of emitting (simulates network/SDK failure). */
	throwError?: Error;
	/** Simulate a mid-stream abort signal already fired. */
	abortIfSignaled?: boolean;
	/** Pause before emitting events (lets tests fire timers mid-stream). */
	delayMs?: number;
}

export interface FauxProvider {
	streamFn: StreamFn;
	/** Contexts received by each call, in order (for assertions). */
	readonly receivedContexts: Context[];
}

export function fauxProvider(steps: FauxStep[]): FauxProvider {
	const receivedContexts: Context[] = [];
	let callIndex = 0;

	const streamFn: StreamFn = async function* (model, context, options) {
		const step = steps[Math.min(callIndex, steps.length - 1)];
		receivedContexts.push(context);

		if (step.assertContext) step.assertContext(context, callIndex);
		if (step.throwError) throw step.throwError;

		const builder = new MessageBuilder(model.provider, model.id);
		yield builder.start();

		if (step.delayMs) {
			await new Promise((resolve) => setTimeout(resolve, step.delayMs));
		}

		if (step.abortIfSignaled && options?.signal?.aborted) {
			yield builder.aborted(step.usage);
			return;
		}

		if (step.events) {
			for (const event of step.events) {
				yield event;
			}
			callIndex++;
			return;
		}

		let contentIndex = 0;
		if (step.thinking) {
			yield builder.thinkingStart(contentIndex);
			yield builder.thinkingDelta(contentIndex, step.thinking);
			yield builder.thinkingEnd(contentIndex);
			contentIndex++;
		}

		const text = step.text ?? "";
		if (text || !step.toolCalls || step.toolCalls.length === 0) {
			yield builder.textStart(contentIndex);
			if (text) {
				// Emit in a few chunks to exercise delta handling.
				const chunkSize = Math.max(1, Math.ceil(text.length / 3));
				for (let i = 0; i < text.length; i += chunkSize) {
					yield builder.textDelta(contentIndex, text.slice(i, i + chunkSize));
				}
			}
			yield builder.textEnd(contentIndex);
			contentIndex++;
		}

		const calls: ToolCall[] = (step.toolCalls ?? []).map((spec, i) => ({
			type: "toolCall",
			id: spec.id ?? `faux_call_${callIndex}_${i}`,
			name: spec.name,
			arguments: JSON.stringify(spec.arguments),
		}));

		for (const call of calls) {
			const index = contentIndex++;
			yield builder.toolCallStart(index, call.id, call.name);
			// Split arguments into two fragments to exercise delta reassembly.
			const mid = Math.ceil(call.arguments.length / 2);
			yield builder.toolCallDelta(index, call.arguments.slice(0, mid));
			yield builder.toolCallDelta(index, call.arguments.slice(mid));
			yield builder.toolCallEnd(index);
		}

		const stop = step.stopReason ?? (calls.length > 0 ? "toolUse" : "stop");
		if (stop === "error" || stop === "aborted") {
			if (stop === "aborted") {
				yield builder.aborted(step.usage);
			} else {
				yield builder.error(step.errorMessage ?? "faux error", step.usage);
			}
		} else {
			yield builder.done(stop, step.usage);
		}
		callIndex++;
	};

	return { streamFn, receivedContexts };
}

export type FauxScriptStep = FauxStep;
