// Long-form design notes: docs/dev/ai-layer.md
/** Retry wrapper: the throw boundary of the streaming protocol. */

import { MessageBuilder } from "./message-builder.ts";
import { MissingApiKeyError } from "./model.ts";
import { ClaudeOAuthError } from "./providers/anthropic-oauth.ts";
import { ChatGptOAuthError } from "./providers/chatgpt-oauth.ts";
import { GeminiCodeAssistError } from "./providers/gemini-code-assist.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	RetryNotice,
	StreamFn,
	StreamOptions,
} from "./types.ts";

export interface RetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Cap on attempts for 529 (overloaded) responses. */
	overloadedMaxAttempts?: number;
	onRetry?: (retry: RetryNotice) => void;
	sleep?: (ms: number) => Promise<void>;
	/** Jitter source for the backoff; injectable so tests can pin it. */
	random?: () => number;
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

// Long-form design notes: docs/dev/ai-layer.md
/** True when the provider refused the request for being too large to send. */
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

/** One header off an error, whichever container the SDK put it in. */
function headerValue(headers: unknown, name: string): string | null {
	if (!headers || typeof headers !== "object") return null;
	if (headers instanceof Headers) return headers.get(name);
	const record = headers as Record<string, string | undefined>;
	const titleCase = name
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("-");
	return record[name] ?? record[titleCase] ?? null;
}

// Long-form design notes: docs/dev/ai-layer.md
/** The wait a `Retry-After` response asks for, in milliseconds, or null. */
function retryAfterMsOf(error: unknown): number | null {
	if (error === null || typeof error !== "object") return null;
	const headers = (error as { headers?: unknown }).headers;
	const ms = headerValue(headers, "retry-after-ms");
	if (ms) {
		const value = Number(ms);
		if (Number.isFinite(value)) return Math.max(0, value);
	}
	const value = headerValue(headers, "retry-after");
	// Empty counts as absent: `Number("")` is 0, and a header that says nothing
	// must not be read as "retry immediately".
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	return null;
}

/**
 * The kind of a terminal failure, where its status names one of the situations
 * the fallback walk acts on.
 *
 * Only statuses the ladder has finished with reach here: a 429 or 529 that
 * exhausted its attempts is a fact about this model's capacity, and a 401 or
 * 403 is a fact about its credential — neither changes by being sent to the
 * same model again, while another model, or another provider with its own
 * key, may still answer. Statuses outside those stay unlabelled; an
 * unlabelled failure keeps the walk for the reason it always has.
 */
function terminalErrorKind(status: number | null): AssistantMessage["errorKind"] {
	if (status === 429) return "rate_limit";
	if (status === 529) return "overload";
	if (status === 401 || status === 403) return "auth";
	return undefined;
}

export function withRetry(streamFn: StreamFn, options: RetryOptions = {}): StreamFn {
	const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
	const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
	const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
	const overloadedMaxAttempts = options.overloadedMaxAttempts ?? DEFAULTS.overloadedMaxAttempts;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const random = options.random ?? Math.random;

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
				// safely — the consumer already saw partial output. The loop
				// records the partial as an errored turn when this lands there.
				if (emittedAny) throw error;

				// A user interrupt is not a provider fault: rethrow immediately so
				// the session loop sees the abort instead of a retry ladder.
				if (streamOptions?.signal?.aborted || isAbortError(error)) throw error;

				// A credential the environment does not hold is not something a later
				// attempt can produce. It arrives status-less, like the unknown errors
				// that earn "one more shot", so without this it takes the whole ladder
				// — two minutes of silence — to report a key that was never there.
				if (error instanceof MissingApiKeyError) {
					const builder = new MessageBuilder(model.provider, model.id);
					// Labelled `auth` like any other refused credential: another
					// model may hold the key this one is missing, so the walk is
					// still on the table for the caller that configured one.
					yield builder.error(error.message, { errorKind: "auth" });
					return;
				}

				// The same impossibility for a subscription: no amount of waiting
				// produces a sign-in. Only the errors that say the session cannot be
				// repaired carry the mark — a token endpoint having a bad day
				// (invalidGrant: false) is exactly what the ladder is for. All three
				// subscription adapters share the shape, so all three share this
				// door; the Gemini one arrives here as this package's own error
				// because its login layer lives outside this package.
				if (
					(error instanceof ClaudeOAuthError ||
						error instanceof ChatGptOAuthError ||
						error instanceof GeminiCodeAssistError) &&
					error.invalidGrant
				) {
					const builder = new MessageBuilder(model.provider, model.id);
					// The same label as the missing key above: a session that cannot
					// sign in will not sign in on the next attempt, but a model on
					// another provider does not share the dead credential.
					yield builder.error(error.message, { errorKind: "auth" });
					return;
				}

				const status = statusCodeOf(error);
				const overloaded = status === 529;
				const overflow = isContextOverflowError(error);
				const retryable = isNetworkError(error) || (status !== null && isRetryableStatus(status)) || status === null; // unknown errors before first byte: give one more shot below

				const attemptCap = overloaded ? Math.min(overloadedMaxAttempts, maxAttempts) : maxAttempts;
				const attemptsUsed = overloaded ? overloadedAttempts + 1 : attempt;

				// Overflow is terminal on the first try, including the status-less case
				// that would otherwise earn a retry: the request is not going to get
				// smaller by being sent again. The other terminal statuses — exhausted
				// 429s and 529s, refused credentials — are labelled so the fallback
				// walk can tell them from an overflow and act on each.
				if (overflow || !retryable || attemptsUsed >= attemptCap) {
					const builder = new MessageBuilder(model.provider, model.id);
					const message = error instanceof Error ? error.message : String(error);
					const kind = overflow ? ("context_overflow" as const) : terminalErrorKind(status);
					yield builder.error(
						overflow
							? `The request is larger than ${model.id}'s context window: ${message}`
							: `Request failed after ${attemptsUsed} attempt(s): ${message}`,
						kind ? { errorKind: kind } : {},
					);
					return;
				}

				if (overloaded) overloadedAttempts++;

				// Half fixed, half random: retries from parallel sessions on the
				// same schedule otherwise synchronize into a herd, and a delay
				// that could shrink to nothing would retry instantly. The jitter
				// applies to the exponential backoff only — a Retry-After is the
				// server's own number. Both live under the caller's cap.
				const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
				const jittered = backoff / 2 + random() * (backoff / 2);
				const delayMs = Math.min(retryAfterMsOf(error) ?? jittered, maxDelayMs);
				// Per-request first: the caller that knows which turn this is retrying is
				// also the one holding a place to say so.
				const notice: RetryNotice = {
					attempt,
					error,
					delayMs,
					message: error instanceof Error ? error.message : String(error),
				};
				await (streamOptions?.onRetry ?? options.onRetry)?.(notice);
				await sleepUnlessAborted(sleep, delayMs, streamOptions?.signal);
			}
		}
	};
}

/** The caller's abort as a thrown error, keeping whatever reason it carried. */
function abortErrorOf(signal: AbortSignal): unknown {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason;
	// Shaped like the platform default so every layer above reads it as an
	// interrupt via isAbortError.
	return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

/**
 * Sleep, unless the caller aborts first.
 *
 * A wait can run to `maxDelayMs` — thirty seconds, which is also the number a
 * `Retry-After: 30` asks for — and nothing inside it reads the signal. Without
 * the race, an interrupt during the backoff goes unseen until the sleep runs
 * out: Esc does nothing for the rest of the wait, however long that is.
 */
async function sleepUnlessAborted(
	sleep: (ms: number) => Promise<void>,
	delayMs: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	const waiting = sleep(delayMs);
	// The abort can win the race and leave the wait running; the loser still
	// needs a handler or its settlement surfaces as an unhandled rejection.
	waiting.catch(() => {});
	if (!signal) return waiting;
	if (signal.aborted) throw abortErrorOf(signal);
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			waiting,
			new Promise<never>((_, reject) => {
				onAbort = () => reject(abortErrorOf(signal));
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
