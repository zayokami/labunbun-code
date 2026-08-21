/**
 * Model fallback chain: on a provider error that arrives BEFORE any content
 * was streamed (auth failure, model unavailable, rate-limited past retries),
 * transparently retry the turn with the next model in the chain. Errors after
 * content started flowing propagate unchanged — the loop's recovery ladder
 * owns mid-stream failures.
 */
import type { AssistantMessageEvent, Context, Model, StreamFn, StreamOptions } from "./types.ts";

export function withModelFallback(base: StreamFn, resolveChain: (model: Model) => Model[]): StreamFn {
	return async function* fallbackStream(
		model: Model,
		context: Context,
		options?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		const chain = [model, ...resolveChain(model).filter((m) => m.id !== model.id || m.provider !== model.provider)];

		for (let i = 0; i < chain.length; i++) {
			const candidate = chain[i];
			const isLast = i === chain.length - 1;
			let sawContent = false;
			let terminal: AssistantMessageEvent | null = null;

			try {
				for await (const event of base(candidate, context, options)) {
					if (event.type === "done") {
						terminal = event;
						break;
					}
					if (event.type === "error") {
						terminal = event;
						break;
					}
					if (event.type !== "start") sawContent = true;
					yield event;
				}
			} catch (error) {
				// Pre-content throw (network/SDK): fall through to the next model.
				if (sawContent || isLast) throw error;
				continue;
			}

			if (!terminal) {
				// Stream ended without a terminal event — treat as an error.
				if (isLast) {
					const { MessageBuilder } = await import("./message-builder.ts");
					const builder = new MessageBuilder(candidate.provider, candidate.id);
					yield builder.error(`Model ${candidate.id}: stream ended without a terminal event`);
					return;
				}
				continue;
			}

			if (terminal.type === "done" || sawContent || isLast) {
				yield terminal;
				return;
			}
			// Error before any content: silently try the next model. Its own
			// start event re-anchors the consumer's partial state.
		}
	};
}
