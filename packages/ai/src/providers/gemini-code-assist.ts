// Long-form design notes: docs/dev/ai-layer.md
/**
 * The Gemini Code Assist adapter: generate-content as the Code Assist backend at
 * `cloudcode-pa.googleapis.com` speaks it.
 *
 * A wire of its own rather than a mode of the `google` rows, because nothing
 * about the request is the OpenAI-compatibility shape those ride: the model, the
 * project and a per-prompt id sit beside a `request` field that carries the
 * conversation, every stream frame wraps its payload in a `response` envelope,
 * tools ride one `functionDeclarations` list with each schema under
 * `parametersJsonSchema`, and thinking is steered by a camelCase
 * `thinkingConfig` inside a request that is snake_case everywhere else. Two
 * things this wire does not have and therefore never sends: a prompt-cache
 * field, and a header carrying client metadata. The sign-in's bearer is the
 * whole of the credential — these rows name no key variable.
 *
 * The request builder and the stream mapper are plain functions over plain
 * data, so a test drives the whole shape with fixtures and no network.
 */
import { MessageBuilder, parseToolArguments } from "../message-builder.ts";
import type {
	AssistantMessageEvent,
	Context,
	Model,
	StopReason,
	StreamOptions,
	ThinkingLevel,
	WireTool,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The host the Code Assist backend lives on; `GEMINI_BASE_URL` moves a row off it. */
export const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

/** The method namespace the streaming call lives under. */
export const CODE_ASSIST_API_VERSION = "v1internal";

/**
 * The version string the User-Agent carries. A literal rather than a build
 * stamp: the endpoint reads this field as "which client family is calling", and
 * a version from this repo would name a client the backend has never heard of.
 */
export const GEMINI_CLI_VERSION = "0.66.0-nightly.20261013.g204db94ae";

/**
 * The thinking cap the chat traffic runs at when the session asks for a level
 * rather than a number: a cap and not a target, so a run-away loop of thoughts
 * is bounded without the model being told how little to think.
 */
export const DEFAULT_THINKING_BUDGET = 8192;

/**
 * The signature a replayed function call carries. The backend refuses a
 * replayed function-call part that has no signature — a signature is minted
 * with the thought it describes, and our `ToolCall` blocks keep none — so the
 * stand-in the backend documents for exactly this case goes out instead. It
 * asserts nothing about a thought; it says the request cannot prove one.
 */
export const SYNTHETIC_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

// ---------------------------------------------------------------------------
// Raw wire types (structural subset, local so tests use plain fixtures)
// ---------------------------------------------------------------------------

export interface CodeAssistPart {
	text?: string;
	/** Set on the parts that carry the model's thinking rather than its answer. */
	thought?: boolean;
	/** The signature a thought part mints; replayed call parts must carry one. */
	thoughtSignature?: string;
	functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
	functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
	inlineData?: { mimeType: string; data: string };
}

export interface CodeAssistContent {
	role?: "user" | "model";
	parts?: CodeAssistPart[];
}

export interface CodeAssistThinkingConfig {
	/** Whether the thoughts come back in the stream at all. */
	includeThoughts?: boolean;
	/** A cap on the thoughts; 0 is DISABLED and -1 lets the model decide. */
	thinkingBudget?: number;
	/** `"LOW" | "HIGH"` for the models steered by a level instead of a budget. */
	thinkingLevel?: string;
}

export interface CodeAssistGenerationConfig {
	maxOutputTokens?: number;
	thinkingConfig?: CodeAssistThinkingConfig;
}

export interface CodeAssistTool {
	functionDeclarations: Array<{ name: string; description: string; parametersJsonSchema: unknown }>;
}

/** One request as this backend spells it: the model outside, the call inside `request`. */
export interface CodeAssistRequestParams {
	model: string;
	project?: string;
	user_prompt_id: string;
	request: {
		contents: CodeAssistContent[];
		systemInstruction?: CodeAssistContent;
		tools?: CodeAssistTool[];
		generationConfig?: CodeAssistGenerationConfig;
	};
}

export interface CodeAssistUsage {
	/** The whole prompt, cached prefix included. */
	promptTokenCount?: number;
	cachedContentTokenCount?: number;
	candidatesTokenCount?: number;
	/** Reported beside the candidates, not inside them: the frame's own total sums the two. */
	thoughtsTokenCount?: number;
	/** Input-side tokens from tool executions. */
	toolUsePromptTokenCount?: number;
	totalTokenCount?: number;
}

/** One SSE frame: the response rides inside an envelope, under `response`. */
export interface CodeAssistFrame {
	response?: {
		candidates?: Array<{
			content?: CodeAssistContent;
			finishReason?: string;
			finishMessage?: string;
		}>;
		usageMetadata?: CodeAssistUsage;
	};
	traceId?: string;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/**
 * Build one request. `project` comes from the sign-in — the backend routes a
 * subscription's traffic by project — and is omitted when nothing onboarded
 * one, which is the shape a request takes before a project exists.
 */
export function buildCodeAssistRequest(
	model: Model,
	context: Context,
	options?: StreamOptions,
	project?: string | null,
): CodeAssistRequestParams {
	const params: CodeAssistRequestParams = {
		model: model.id,
		// A fresh id per request; the backend echoes it in the frames' trace ids.
		user_prompt_id: crypto.randomUUID(),
		request: { contents: convertContents(context) },
	};
	if (project) params.project = project;
	if (context.systemPrompt) {
		params.request.systemInstruction = { role: "user", parts: [{ text: context.systemPrompt }] };
	}
	if (context.tools && context.tools.length > 0) {
		params.request.tools = [
			{
				functionDeclarations: context.tools.map((tool: WireTool) => ({
					name: tool.name,
					description: tool.description,
					// The raw JSON Schema under the field that takes one: the sibling
					// `parameters` field expects the backend's own Schema dialect, and
					// ours is JSON Schema already.
					parametersJsonSchema: tool.parameters,
				})),
			},
		];
	}
	const generationConfig: CodeAssistGenerationConfig = {};
	if (options?.maxOutputTokens) generationConfig.maxOutputTokens = options.maxOutputTokens;
	if (model.reasoning) generationConfig.thinkingConfig = codeAssistThinkingConfig(model, options?.thinkingLevel);
	if (generationConfig.maxOutputTokens !== undefined || generationConfig.thinkingConfig) {
		params.request.generationConfig = generationConfig;
	}
	return params;
}

/**
 * The conversation as `Content` records: thoughts dropped, consecutive
 * same-role turns merged, and each model turn's first function call stamped so
 * a replayed turn is not refused.
 *
 * A tool result is a `user` turn here, which is why the merge below is not a
 * cosmetic tidy-up: an assistant turn between two results is not always there,
 * and two consecutive `user` turns are a 400 outright.
 */
export function convertContents(context: Context): CodeAssistContent[] {
	const out: CodeAssistContent[] = [];
	for (const message of context.messages) {
		const parts: CodeAssistPart[] = [];
		let role: "user" | "model" = "user";
		if (message.role === "user") {
			if (typeof message.content === "string") {
				parts.push({ text: message.content });
			} else {
				for (const block of message.content) {
					if (block.type === "text") parts.push({ text: block.text });
					else parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
				}
			}
		} else if (message.role === "assistant") {
			role = "model";
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text) parts.push({ text: block.text });
				} else if (block.type === "toolCall") {
					parts.push({ functionCall: { id: block.id, name: block.name, args: parseToolArguments(block.arguments) } });
				}
				// Thinking blocks are dropped: the wire replays neither the thought
				// text nor the signature it minted, and the call part's own replay
				// signature is the stand-in the builder applies below.
			}
			// The one position the backend validates for a replayed call signature.
			const firstCall = parts.find((part) => part.functionCall);
			if (firstCall) firstCall.thoughtSignature = SYNTHETIC_THOUGHT_SIGNATURE;
		} else {
			const text = message.content
				.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			// A failed call answers with `error` where a successful one answers
			// with `output`; the empty object is the answer for a call that said
			// nothing, which is not the same as an error.
			const response = message.isError ? { error: text } : text ? { output: text } : {};
			parts.push({ functionResponse: { id: message.toolCallId, name: message.toolName, response } });
		}
		if (parts.length > 0) out.push({ role, parts });
	}
	return coalesceRoles(out);
}

/** Merge consecutive same-role turns into one, preserving order within each. */
function coalesceRoles(contents: CodeAssistContent[]): CodeAssistContent[] {
	const merged: CodeAssistContent[] = [];
	for (const content of contents) {
		const last = merged.at(-1);
		if (last && last.role === content.role) {
			last.parts = [...(last.parts ?? []), ...(content.parts ?? [])];
		} else {
			merged.push(content);
		}
	}
	return merged;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * The thinking knobs for a model's family. The id says which: the 2.5 family is
 * steered by a budget, everything later — the 3.x models and both Gemma 4s — by
 * a level, and neither family accepts the other's field.
 *
 * The session's five levels map onto what each family states. The budget family
 * takes the one cap the chat traffic runs at, or the disabled value for off.
 * The level family's vocabulary is two rungs, LOW and HIGH: low and minimal land
 * on LOW, everything else on HIGH, and off is answered by not asking for the
 * thoughts at all, because no rung below LOW exists to ask for.
 */
export function codeAssistThinkingConfig(model: Model, thinkingLevel?: ThinkingLevel): CodeAssistThinkingConfig {
	const asked = thinkingLevel ?? (model.reasoning ? "medium" : "off");
	if (/^gemini-2\.5/.test(model.id)) {
		if (asked === "off") return { thinkingBudget: 0 };
		return { includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET };
	}
	if (asked === "off") return { includeThoughts: false };
	if (asked === "minimal" || asked === "low") return { includeThoughts: true, thinkingLevel: "LOW" };
	return { includeThoughts: true, thinkingLevel: "HIGH" };
}

// ---------------------------------------------------------------------------
// SSE reading
// ---------------------------------------------------------------------------

/**
 * The frames of a `text/event-stream` body: `data:` lines accumulate until a
 * blank line, then parse as one JSON document. Other lines — comments, ids —
 * are not payload and are ignored.
 *
 * Two readings are deliberate. A frame whose JSON does not parse is skipped
 * rather than fatal: one bad frame should not cost the turn the frames around
 * it. And a trailing event whose terminating blank line never arrived is
 * dropped, which is what the event-stream format says to do with an incomplete
 * event — an unflushed buffer at end of stream is not a frame.
 */
export async function* parseCodeAssistSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<CodeAssistFrame> {
	if (!body) return;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const dataLines: string[] = [];
	let pending = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			while (true) {
				const breakIndex = pending.indexOf("\n");
				if (breakIndex === -1) break;
				let line = pending.slice(0, breakIndex);
				pending = pending.slice(breakIndex + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.startsWith("data: ")) {
					dataLines.push(line.slice(6).trim());
					continue;
				}
				if (line !== "") continue;
				if (dataLines.length === 0) continue;
				const chunk = dataLines.join("\n");
				dataLines.length = 0;
				let frame: CodeAssistFrame;
				try {
					frame = JSON.parse(chunk) as CodeAssistFrame;
				} catch {
					continue;
				}
				yield frame;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// ---------------------------------------------------------------------------
// Stream mapping
// ---------------------------------------------------------------------------

const FINISH_REASON_MAP: Record<string, "stop" | "length" | "refusal"> = {
	STOP: "stop",
	MAX_TOKENS: "length",
	// The safety family, read as one class: each of these ends the turn because
	// the content was blocked, which is a refusal — "stop" would file it as a
	// successful turn that happened to say nothing.
	SAFETY: "refusal",
	RECITATION: "refusal",
	BLOCKLIST: "refusal",
	PROHIBITED_CONTENT: "refusal",
	SPII: "refusal",
	IMAGE_SAFETY: "refusal",
	IMAGE_PROHIBITED_CONTENT: "refusal",
};

/** The reasons that are a protocol failure rather than a way to stop, with what to say about each. */
const FINISH_REASON_FAILURES: Record<string, string> = {
	MALFORMED_FUNCTION_CALL: "The model's function call was malformed and could not be run",
	UNEXPECTED_TOOL_CALL: "The model called a tool that was not offered to it",
};

/**
 * One stream of frames as the event protocol this app speaks. A call arrives
 * whole — arguments included — inside a single part, where the OpenAI wires
 * stream it as fragments, so a call is emitted as its three events back to
 * back.
 */
export async function* mapCodeAssistStream(
	frames: AsyncIterable<CodeAssistFrame>,
	provider: string,
	modelId: string,
): AsyncGenerator<AssistantMessageEvent> {
	const builder = new MessageBuilder(provider, modelId);
	let textIndex = -1;
	let thinkingIndex = -1;
	let thinkingSignature: string | undefined;
	let nextContentIndex = 0;
	let finishReason: string | undefined;
	let finishMessage: string | undefined;
	let sawToolCall = false;
	let sawContent = false;

	for await (const frame of frames) {
		if (!sawContent) {
			// Start marks the first wire event, not the act of connecting: a
			// connection accepted and then gone silent must look event-less to the
			// retry layer above, where it earns a second attempt instead of ending
			// the turn.
			yield builder.start();
		}
		sawContent = true;

		const response = frame?.response;
		if (!response) continue;

		if (response.usageMetadata) {
			const usage = response.usageMetadata;
			const promptTokens = usage.promptTokenCount;
			const toolPrompt = usage.toolUsePromptTokenCount ?? 0;
			const cached = usage.cachedContentTokenCount ?? 0;
			const thoughts = usage.thoughtsTokenCount;
			builder.message.usage = {
				// `promptTokenCount` counts the cached prefix; `input` must not, or
				// the cached tokens are billed once as input and once as a cache
				// read. The tool-use prompt rides beside `promptTokenCount` in the
				// frame's own total (prompt + candidates + toolUsePrompt + thoughts)
				// and is input all the same, so it joins both prompt figures here.
				input:
					promptTokens === undefined ? builder.message.usage.input : Math.max(0, promptTokens - cached) + toolPrompt,
				output: (usage.candidatesTokenCount ?? 0) + (thoughts ?? 0),
				cacheRead: cached,
				cacheWrite: builder.message.usage.cacheWrite,
				reasoning: thoughts,
				promptTotal: promptTokens === undefined ? builder.message.usage.promptTotal : promptTokens + toolPrompt,
			};
		}

		const parts = response.candidates?.[0]?.content?.parts ?? [];
		for (const part of parts) {
			if (part.functionCall) {
				// The id is the model's when it sent one; when it did not, one is
				// minted so the result can name the call it answers.
				const name = part.functionCall.name?.trim() || "generic_tool";
				const id = part.functionCall.id?.trim() || `${name}_${crypto.randomUUID()}`;
				const index = nextContentIndex++;
				sawToolCall = true;
				yield builder.toolCallStart(index, id, name);
				yield builder.toolCallDelta(index, JSON.stringify(part.functionCall.args ?? {}));
				yield builder.toolCallEnd(index);
				continue;
			}
			if (part.thought) {
				if (part.thoughtSignature) thinkingSignature = part.thoughtSignature;
				if (part.text) {
					if (thinkingIndex === -1) {
						thinkingIndex = nextContentIndex++;
						yield builder.thinkingStart(thinkingIndex);
					}
					yield builder.thinkingDelta(thinkingIndex, part.text);
				}
				continue;
			}
			if (part.text) {
				if (textIndex === -1) {
					textIndex = nextContentIndex++;
					yield builder.textStart(textIndex);
				}
				yield builder.textDelta(textIndex, part.text);
			}
		}

		finishReason = response.candidates?.[0]?.finishReason ?? finishReason;
		finishMessage = response.candidates?.[0]?.finishMessage ?? finishMessage;
	}

	if (!sawContent) {
		yield builder.error("Gemini Code Assist stream produced no content");
		return;
	}

	// Close open blocks in creation order.
	if (thinkingIndex !== -1) yield builder.thinkingEnd(thinkingIndex, thinkingSignature);
	if (textIndex !== -1) yield builder.textEnd(textIndex);

	// Long-form design notes: docs/dev/ai-layer.md
	let stop: StopReason = "stop";
	if (finishReason === undefined) {
		// A stream that ends without stating why is a cut-off answer that closed
		// cleanly: the stall watchdog cannot see it — the close itself is an
		// event — so filing it as a stop would be the one way a truncated turn
		// reports success.
		stop = "error";
		builder.message.errorMessage = "The stream ended without a finish reason";
	} else {
		const mapped = FINISH_REASON_MAP[finishReason];
		if (mapped) {
			stop = mapped;
		} else {
			// Every unmapped reason is an error: a turn that ended for a reason
			// this adapter cannot name must not be sealed as a successful stop.
			stop = "error";
			builder.message.errorMessage =
				FINISH_REASON_FAILURES[finishReason] ?? `Unrecognized finish reason: ${finishReason}`;
		}
		// A call-bearing turn is the tool loop's continue signal, and the reason
		// beside it is usually a plain STOP: the calls are what make it a tool
		// turn. A truncated or blocked turn keeps its own reason — the calls, if
		// any, are partial.
		if (stop === "stop" && sawToolCall) stop = "toolUse";
		// A blocked turn's reason is its explanation; without one the session
		// states the refusal itself.
		if (stop === "refusal" && finishMessage) builder.message.errorMessage = finishMessage;
	}
	builder.message.stopReason = stop;
	yield builder.done(stop);
}

// ---------------------------------------------------------------------------
// Live StreamFn
// ---------------------------------------------------------------------------

/**
 * What one request needs from a login: the bearer, when it goes stale, and the
 * project the backend routes the traffic by when the sign-in onboarded one.
 */
export interface GeminiTokenGrant {
	token: string;
	/** Epoch ms, or null when the grant stated no lifetime. */
	expiresAt: number | null;
	project?: string | null;
}

/** The wire layer's contract: called per request, `forceRefresh` bypassing the freshness window after a 401. */
export interface GeminiTokenProvider {
	(options?: { forceRefresh?: boolean }): Promise<GeminiTokenGrant>;
	available(): Promise<boolean>;
}

/**
 * This layer's error, in the shape the retry wrapper reads: a `status` so a
 * refused request is classified by what the endpoint said, and `invalidGrant`
 * for a session no amount of waiting can repair.
 */
export class GeminiCodeAssistError extends Error {
	readonly status: number | null;
	readonly invalidGrant: boolean;

	constructor(message: string, options: { status?: number | null; invalidGrant?: boolean } = {}) {
		super(message);
		this.name = "GeminiCodeAssistError";
		this.status = options.status ?? null;
		this.invalidGrant = options.invalidGrant ?? false;
	}
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * The subscription is the only way in — these rows name no key variable — so a
 * refusal to serve one is this layer's to write. It carries `invalidGrant` so
 * the retry wrapper lets it out before the ladder: waiting does not produce a
 * sign-in.
 */
export function geminiSubscriptionMissingError(model: Model): GeminiCodeAssistError {
	return new GeminiCodeAssistError(`Not signed in to a Gemini subscription for ${model.id}: run /login.`, {
		invalidGrant: true,
	});
}

/** The URL one streaming call goes to. */
export function codeAssistUrl(model: Model): string {
	const endpoint = (model.baseUrl || CODE_ASSIST_ENDPOINT).replace(/\/+$/, "");
	return `${endpoint}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`;
}

/** The headers one request carries: the bearer, the JSON content type, and the client the User-Agent names. */
export function codeAssistHeaders(
	model: Model,
	grant: GeminiTokenGrant,
	extra?: Record<string, string>,
): Record<string, string> {
	// The caller's headers first, so the ones this wire requires win a collision:
	// the bearer and the content type are requirements of the endpoint, not
	// incidental values.
	return {
		...extra,
		"content-type": "application/json",
		authorization: `Bearer ${grant.token}`,
		"user-agent": `GeminiCLI/${GEMINI_CLI_VERSION}/${model.id} (${process.platform}; ${process.arch}; terminal)`,
	};
}

export interface CodeAssistStreamFnOptions {
	/** Where the subscription's bearer comes from. Consulted per request. */
	credentials?: GeminiTokenProvider;
	/** The fetch this wire speaks through; injectable so a test can answer with scripted frames. */
	fetch?: typeof fetch;
}

export function createCodeAssistStreamFn(settings: CodeAssistStreamFnOptions = {}) {
	const credentials = settings.credentials;

	return async function* codeAssistStream(
		model: Model,
		context: Context,
		options?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		// One forced refresh is the whole recovery, the same reading as on the
		// other subscription wires: a second 401 on a token minted moments ago is
		// the account's answer, not a stale token's.
		let authRetried = false;
		while (true) {
			if (!credentials) throw geminiSubscriptionMissingError(model);
			const grant = await mintGrant(credentials);
			const params = buildCodeAssistRequest(model, context, options, grant.project);
			const headers = codeAssistHeaders(model, grant, options?.headers);
			const doFetch = settings.fetch ?? fetch;
			const response = await doFetch(codeAssistUrl(model), {
				method: "POST",
				headers,
				body: JSON.stringify(params),
				signal: options?.signal,
			});
			if (!response.ok) {
				const error = new GeminiCodeAssistError(await httpErrorMessage(response), { status: response.status });
				if (response.status === 401 && !authRetried) {
					authRetried = true;
					// A refresh that fails leaves the original 401 as the better
					// answer — it is what the API said.
					try {
						await credentials({ forceRefresh: true });
						continue;
					} catch {
						throw error;
					}
				}
				throw error;
			}
			yield* mapCodeAssistStream(parseCodeAssistSse(response.body), model.provider, model.id);
			return;
		}
	};
}

/**
 * One credential mint, with the login layer's error shape translated: whether
 * a grant is dead is read off the error structurally rather than by class, so
 * this package does not have to depend on the package that writes the sign-in —
 * and the retry door above sees the mark it knows.
 */
async function mintGrant(credentials: GeminiTokenProvider): Promise<GeminiTokenGrant> {
	try {
		return await credentials();
	} catch (error) {
		if (error instanceof GeminiCodeAssistError) throw error;
		if (typeof error === "object" && error !== null && (error as { invalidGrant?: unknown }).invalidGrant === true) {
			throw new GeminiCodeAssistError(error instanceof Error ? error.message : String(error), {
				invalidGrant: true,
			});
		}
		throw error;
	}
}

/**
 * What a failed answer says. The body is the only place the endpoint states
 * why it refused — an over-window request, for one, is a 400 whose wording the
 * retry layer above matches against its overflow patterns — so the start of it
 * goes into the message, bounded, because a gateway's HTML error page is not a
 * reason.
 */
async function httpErrorMessage(response: Response): Promise<string> {
	let detail = "";
	try {
		detail = (await response.text()).trim().slice(0, 500);
	} catch {
		// A body that cannot be read leaves the status line as the whole message.
	}
	const head = `Gemini Code Assist request failed: ${response.status} ${response.statusText}`.trim();
	return detail ? `${head}: ${detail}` : head;
}
