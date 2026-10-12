// Long-form design notes: docs/dev/ai-layer.md
/**
 * The ChatGPT subscription adapter: the Responses wire as the codex backend at
 * `chatgpt.com/backend-api/codex` speaks it.
 *
 * A wire of its own rather than a mode of `openai-responses`, because the three
 * shape differences are structural. The system prompt is not a top-level
 * `instructions` field — it is spliced into the input as a developer-role
 * message, first in the array behind the tool set. The models the backend's own
 * catalog marks `use_responses_lite` take their whole tool set inside a single
 * `additional_tools` input item wrapped in one namespace, with no top-level
 * `tools`, `parallel_tool_calls: false`, and `reasoning.context: "all_turns"`.
 * And `prompt_cache_retention` does not exist in the request struct the
 * backend's client builds, so this adapter never sends it.
 *
 * The request builder iterates the shared Responses builder's output field by
 * field instead of mutating it, so every field this wire carries is a line here
 * that someone chose, and a field added upstream does not drift onto a wire
 * nobody verified it against.
 */
import type { CachePolicy } from "../cache.ts";
import { statusCodeOf } from "../retry.ts";
import { composeSignals } from "../signals.ts";
import type { AssistantMessageEvent, Context, Model, StreamOptions, ThinkingLevel } from "../types.ts";
import {
	CHATGPT_ORIGINATOR,
	ChatGptOAuthError,
	type ChatGptTokenGrant,
	type ChatGptTokenProvider,
} from "./chatgpt-oauth.ts";
import {
	buildResponsesRequest,
	mapResponsesStream,
	type ResponsesClientLike,
	type ResponsesInputItem,
	type ResponsesRawEvent,
} from "./openai-responses.ts";

/**
 * The namespace the lite wire folds every tool into. The backend's own client
 * names it `functions` with an empty description, and the model's calls come
 * back under it — a call in the default namespace carries its plain name, which
 * is why the response mapper needs no namespace handling.
 */
export const CHATGPT_FUNCTION_NAMESPACE = "functions";

/** One request as this backend spells it. */
export interface ChatGptRequestParams {
	[key: string]: unknown;
	model: string;
	input: ResponsesInputItem[];
	stream: true;
	store: false;
	include: string[];
	/** Sent on every request: false on lite rows, true otherwise. */
	parallel_tool_calls: boolean;
	/** A constant on this wire, sent even when a lite request carries no top-level tools. */
	tool_choice: "auto";
	/** Only on rows the catalog does not mark lite; lite rows carry tools in the frame instead. */
	tools?: Array<{ type: "function"; name: string; description: string; parameters: unknown }>;
	max_output_tokens?: number;
	prompt_cache_key?: string;
	reasoning?: { effort?: Exclude<ThinkingLevel, "off">; summary?: "auto"; context?: "all_turns" };
}

// Long-form design notes: docs/dev/ai-layer.md
/** Build the request: the shared Responses shape, rearranged the way this backend asks for it. */
export function buildChatGptRequest(
	model: Model,
	context: Context,
	options?: StreamOptions,
	policy?: CachePolicy,
): ChatGptRequestParams {
	const base = buildResponsesRequest(model, context, options, policy);
	const lite = model.responsesLite === true;
	const tools = base.tools;

	// The frame, in the backend's own order: the tool set (lite only), then the
	// system prompt, then the conversation. Neither splice carries the
	// deterministic uuid-v5 id its client stamps on these items — they are
	// optional on the wire, and the first thing to revisit against the live
	// service if a request is refused for a reason this adapter cannot name.
	const prefix: ResponsesInputItem[] = [];
	if (lite && tools && tools.length > 0) {
		prefix.push({
			type: "additional_tools",
			role: "developer",
			tools: [{ type: "namespace", name: CHATGPT_FUNCTION_NAMESPACE, description: "", tools }],
		});
	}
	if (base.instructions) {
		prefix.push({ role: "developer", content: [{ type: "input_text", text: base.instructions }] });
	}

	const params: ChatGptRequestParams = {
		model: base.model,
		input: [...prefix, ...base.input],
		stream: true,
		store: false,
		include: base.include ?? [],
		// A constant on this wire and sent even when a lite request carries no
		// top-level tools, which is the backend's own client's shape.
		tool_choice: "auto",
		// The same expression the backend's client computes, with its config
		// default of true: lite never takes parallel calls.
		parallel_tool_calls: !lite,
	};
	if (!lite && tools) params.tools = tools;
	if (base.max_output_tokens !== undefined) params.max_output_tokens = base.max_output_tokens;
	if (base.prompt_cache_key) params.prompt_cache_key = base.prompt_cache_key;
	// `context` is a property of the lite wire, not of the session's thinking
	// level, so it goes out even when no effort does. `summary` and `effort`
	// still ride along when the session resolved one, exactly as on the public
	// Responses wire.
	if (base.reasoning || lite) {
		params.reasoning = { ...base.reasoning, ...(lite ? { context: "all_turns" as const } : {}) };
	}
	return params;
}

// Long-form design notes: docs/dev/ai-layer.md
/** The headers one request adds beside the bearer token the client carries. */
export function chatGptHeaders(grant: ChatGptTokenGrant, extra?: Record<string, string>): Record<string, string> {
	// The caller's headers first, so the ones this wire requires win a collision:
	// an account id is a requirement of the endpoint, not an incidental value.
	const headers: Record<string, string> = { ...extra, originator: CHATGPT_ORIGINATOR };
	if (grant.accountId) headers["ChatGPT-Account-ID"] = grant.accountId;
	if (grant.fedramp) headers["X-OpenAI-Fedramp"] = "true";
	return headers;
}

// ---------------------------------------------------------------------------
// Live StreamFn
// ---------------------------------------------------------------------------

export interface ChatGptStreamFnOptions {
	policy?: CachePolicy;
	/**
	 * Where the subscription's bearer comes from. Consulted per request; the
	 * factory receives the grant it returned so that a test can both fake the
	 * client and observe which token that request authenticated with.
	 */
	credentials?: ChatGptTokenProvider;
	clientFactory?: (grant: ChatGptTokenGrant) => ResponsesClientLike;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * The subscription is the only way in — these rows name no key variable — so a
 * refusal to serve one is this layer's to write. It carries `invalidGrant` so
 * the retry wrapper lets it out before the ladder: waiting does not produce a
 * sign-in.
 */
export function subscriptionMissingError(model: Model): ChatGptOAuthError {
	return new ChatGptOAuthError(`Not signed in to a ChatGPT subscription for ${model.id}: run /login.`, {
		invalidGrant: true,
	});
}

export function createChatGptStreamFn(settings: ChatGptStreamFnOptions = {}) {
	const credentials = settings.credentials;

	return async function* chatGptStream(
		model: Model,
		context: Context,
		options?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		// One forced refresh is the whole recovery, the same reading as on the
		// Anthropic adapter: a second 401 on a token minted moments ago is the
		// account's answer, not a stale token's.
		let authRetried = false;
		while (true) {
			if (!credentials) throw subscriptionMissingError(model);
			const grant = await credentials();
			const params = buildChatGptRequest(model, context, options, settings.policy);
			const headers = chatGptHeaders(grant, options?.headers);
			const client = settings.clientFactory
				? settings.clientFactory(grant)
				: await defaultClient(model, options, grant);

			let raw: AsyncIterable<ResponsesRawEvent>;
			try {
				raw = (await client.responses.create(params, { headers })) as unknown as AsyncIterable<ResponsesRawEvent>;
			} catch (error) {
				if (statusCodeOf(error) === 401 && !authRetried) {
					authRetried = true;
					// A 401 says the token is bad however fresh its stamp looks; the
					// forced mint bypasses the freshness window and re-saves, and the
					// retry goes out on the new token. A refresh that fails leaves the
					// original 401 as the better answer — it is what the API said.
					try {
						await credentials({ forceRefresh: true });
						continue;
					} catch {
						throw error;
					}
				}
				throw error;
			}
			// The same event stream the public Responses wire speaks; the lite
			// request shape does not change the response vocabulary.
			yield* mapResponsesStream(raw, model.provider, model.id);
			return;
		}
	};
}

async function defaultClient(
	model: Model,
	options: StreamOptions | undefined,
	grant: ChatGptTokenGrant,
): Promise<ResponsesClientLike> {
	const { default: OpenAI } = await import("openai");
	// The subscription's bearer is the SDK's `apiKey`; the headers that pair it
	// with the account ride per request, where the grant is at hand.
	const callerSignal = options?.signal;
	return new OpenAI({
		apiKey: grant.token,
		baseURL: model.baseUrl || undefined,
		maxRetries: 0, // our retry wrapper owns retry policy
		// Both signals must reach the request: the SDK puts its own on the init —
		// its timeout timer aborts through that one — so replacing it with the
		// caller's alone would leave the timeout with no listener.
		fetch: callerSignal
			? (input, init) => fetch(input, { ...init, signal: composeSignals(init?.signal, callerSignal) })
			: undefined,
	}) as unknown as ResponsesClientLike;
}
