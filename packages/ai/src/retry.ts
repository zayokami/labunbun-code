/**
 * Retry wrapper — THE throw boundary of the streaming protocol.
 *
 * Adapters let SDK/network exceptions propagate; this wrapper catches them,
 * retries with exponential backoff while nothing has been emitted downstream
 * yet, and converts final failure into a terminal `error` event. Once any
 * event has been forwarded to the consumer, exceptions propagate unchanged
 * (the agent loop's recovery ladder owns mid-stream failures).
 */

import { MessageBuilder } from "./message-builder.ts";
import type { AssistantMessageEvent, Context, Model, StreamFn, StreamOptions } from "./types.ts";

export interface RetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Cap on attempts for 529 (overloaded) responses. */
	overloadedMaxAttempts?: number;
	onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
	maxAttempts: 10,
	baseDelayMs: 500,
	maxDelayMs: 30_000,
	overloadedMaxAttempts: 3,
};

/** Extract an HTTP status code from an SDK/HTTP-ish error, or null. */
export function statusCodeOf(error: unknown): number | null {
	if (error === null || typeof error !== "object") return null;
	const status = (error as { status?: unknown }).status;
	if (typeof status === "number") return status;
	const response = (error as { response?: { status?: unknown } }).response;
	if (response && typeof response.status === "number") return response.status;
	return null;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Provider wordings for "this request is bigger than the model's window".
 *
 * They all arrive as 400, which is indistinguishable from a malformed request
 * unless the message is read — and the difference matters: one is worth fixing
 * by sending less, the other is not worth sending at all.
 */
const OVERFLOW_PATTERNS = [
	/maximum context length/i, // OpenAI, and the OpenAI-compatible clones
	/prompt is too long/i, // Anthropic
	/context length exceeded/i,
	/exceeds? the maximum number of tokens/i, // Google
	/input (?:is )?too long/i,
	/too many (?:input )?tokens/i,
];

/** Statuses a provider uses to refuse a body it considers too large. */
function isOverflowStatus(status: number): boolean {
	return status === 400 || status === 413 || status === 422;
}

/** A message that reads like a context-window refusal (in-stream errors too). */
export function looksLikeContextOverflow(message: string): boolean {
	return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * True when the provider refused the request for being too large to send.
 *
 * Nothing is gained by retrying it — the request does not shrink on its own —
 * and nothing is gained by replaying it against the next model in a fallback
 * chain, which is how an oversized context turns into a generic error on every
 * later turn. Only the caller can make it smaller.
 */
export function isContextOverflowError(error: unknown): boolean {
	const status = statusCodeOf(error);
	if (status !== null && !isOverflowStatus(status)) return false;
	// A gateway's "Request Entity Too Large" needs no wording check: the remedy is
	// the same, send less.
	if (status === 413) return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (message && looksLikeContextOverflow(message)) return true;
	return false;
}

/**
 * True for an abort surfaced as an exception (fetch and the various SDKs name
 * it AbortError or APIUserAbortError). An abort is the user's own cancel, not
 * a provider fault: retrying it would override the interrupt, and the
 * fallback chain would walk every model before giving up. Callers rethrow so
 * the session loop can map it to stopReason "aborted".
 */
export function isAbortError(error: unknown): boolean {
	return error instanceof Error && /^(API)?(User)?AbortError$/.test(error.name);
}

function isNetworkError(error: unknown): boolean {
	if (error instanceof Error) {
		// fetch failures surface as TypeError("fetch failed") or similar
		if (error.name === "TypeError" || /network|ECONN|ETIMEDOUT|ENOTFOUND|socket/i.test(error.message)) {
			return true;
		}
	}
	return false;
}

function retryAfterMsOf(error: unknown): number | null {
	if (error !== null && typeof error === "object") {
		const headers = (error as { headers?: Record<string, string | undefined> }).headers;
		const value = headers?.["retry-after"] ?? headers?.["Retry-After"];
		if (value) {
			const seconds = Number(value);
			if (!Number.isNaN(seconds)) return seconds * 1000;
		}
	}
	return null;
}

export function withRetry(streamFn: StreamFn, options: RetryOptions = {}): StreamFn {
	const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
	const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
	const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
	const overloadedMaxAttempts = options.overloadedMaxAttempts ?? DEFAULTS.overloadedMaxAttempts;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	return async function* retryingStream(
		model: Model,
		context: Context,
		streamOptions?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		let attempt = 0;
		let overloadedAttempts = 0;

		while (true) {
			attempt++;
			let emittedAny = false;

			try {
				for await (const event of streamFn(model, context, streamOptions)) {
					emittedAny = true;
					yield event;
					if (event.type === "done" || event.type === "error") return;
				}
				// Underlying stream completed without a terminal event — adapters
				// normally synthesize one; treat silence as an error.
				if (!emittedAny) throw new Error("Provider stream ended without events");
				const builder = new MessageBuilder(model.provider, model.id);
				yield builder.error("Provider stream ended without a terminal event");
				return;
			} catch (error) {
				// After anything was emitted downstream we can no longer retry
				// safely — the consumer already saw partial output.
				if (emittedAny) throw error;

				// A user interrupt is not a provider fault: rethrow immediately so
				// the session loop sees the abort instead of a retry ladder.
				if (streamOptions?.signal?.aborted || isAbortError(error)) throw error;

				const status = statusCodeOf(error);
				const overloaded = status === 529;
				const overflow = isContextOverflowError(error);
				const retryable = isNetworkError(error) || (status !== null && isRetryableStatus(status)) || status === null; // unknown errors before first byte: give one more shot below

				const attemptCap = overloaded ? Math.min(overloadedMaxAttempts, maxAttempts) : maxAttempts;
				const attemptsUsed = overloaded ? overloadedAttempts + 1 : attempt;

				// Overflow is terminal on the first try, including the status-less case
				// that would otherwise earn a retry: the request is not going to get
				// smaller by being sent again.
				if (overflow || !retryable || attemptsUsed >= attemptCap) {
					const builder = new MessageBuilder(model.provider, model.id);
					const message = error instanceof Error ? error.message : String(error);
					yield builder.error(
						overflow
							? `The request is larger than ${model.id}'s context window: ${message}`
							: `Request failed after ${attemptsUsed} attempt(s): ${message}`,
						overflow ? { errorKind: "context_overflow" } : {},
					);
					return;
				}

				if (overloaded) overloadedAttempts++;

				const retryAfter = retryAfterMsOf(error);
				const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
				const delayMs = retryAfter ?? backoff;
				options.onRetry?.(attempt, error, delayMs);
				await sleep(delayMs);
			}
		}
	};
}
