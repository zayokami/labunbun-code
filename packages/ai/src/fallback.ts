// Long-form design notes: docs/dev/ai-layer.md
/** Model fallback chain: try the next model on a pre-content provider error. */
import { isAbortError } from "./retry.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, StreamFn, StreamOptions } from "./types.ts";

/**
 * The error kinds a later model may answer, and the only ones the chain
 * descends on.
 *
 * `rate_limit` and `overload` are facts about this model's capacity, `auth` is
 * a fact about its credential: another model — or another provider, with its
 * own key — may answer where this one will not, which is the walk's one job.
 * `context_overflow` is not one of them: the context is too large for this
 * model, so it is too large for every model after it with the same window,
 * and for the ones that would take it the caller asked the wrong question —
 * walking replays one explainable refusal into a generic error per model.
 * A kind this version does not know is not safe either; a newer producer opts
 * into the walk by naming a safe kind. An absent kind — an error no
 * classifier reached, provider wordings above all — keeps the walk, the
 * documented resilience that predates any classification.
 */
const FALLBACK_SAFE_KINDS: ReadonlySet<NonNullable<AssistantMessage["errorKind"]>> = new Set([
	"rate_limit",
	"overload",
	"auth",
]);

function isFallbackSafe(kind: AssistantMessage["errorKind"]): boolean {
	return kind === undefined || FALLBACK_SAFE_KINDS.has(kind);
}

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
				// Pre-content throw (network/SDK): fall through to the next model —
				// but an abort must propagate even then, or Esc would silently walk
				// the entire fallback chain before taking effect.
				if (sawContent || isLast || options?.signal?.aborted || isAbortError(error)) throw error;
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

			// Only a failure whose kind says another model may answer walks on
			// (see FALLBACK_SAFE_KINDS): a rate limit, an overload, a refused
			// credential. Anything else — an overflow, or a kind this version
			// does not know — is yielded as it stands.
			if (terminal.type === "error" && !isFallbackSafe(terminal.message.errorKind)) {
				yield terminal;
				return;
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
