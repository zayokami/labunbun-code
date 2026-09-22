/**
 * A local endpoint that caches prefixes the way the providers document it.
 *
 * This is the only way to measure a hit rate end to end without paying for one:
 * everything above the socket is the production stack (the real adapters, the
 * real retry policy, the real SDK clients), and what answers is a model of the
 * documented rules rather than a provider. The distinction matters and is not
 * papered over: a number measured here says the machinery places its
 * breakpoints where the prefix actually ends and keeps the bytes stable in
 * between, and it says nothing about whether a real vendor's cache behaves as
 * its documentation claims. Real numbers come from `/cache` against a real
 * endpoint; this is the strongest evidence available offline.
 *
 * What each route simulates, from the vendors' own documentation:
 *
 * **Anthropic (`POST /v1/messages`).** A prompt is a sequence of positions —
 * the tool definitions, then the system prompt, then one message each — and a
 * prefix is cached only where a `cache_control` block asks for it. A read is an
 * exact byte match at one of those marks, or, failing that, the longest cached
 * prefix found by walking back at most 20 *blocks* from the tail; a request
 * with no marks writes nothing. Prefixes below the model's floor are neither
 * written nor read. The TTL is the one the mark asked for (`5m` default, `1h`
 * where a request asks and the endpoint accepts it), and the write is reported
 * split by bucket, which is how a caller learns it is paying the long-TTL
 * premium on the delta.
 *
 * **OpenAI and its clones (`POST /v1/chat/completions`).** Caching is automatic:
 * the first 1024 tokens of a prompt must match byte for byte, after which a hit
 * is rounded down to the next 128-token boundary. `prompt_cache_key` scopes
 * which cache a prefix belongs to, so two conversations with different keys do
 * not read each other's entries.
 *
 * **Token counting.** There is no tokenizer here and inventing one would make
 * the numbers unfalsifiable. Every count is `ceil(characters / 4)` over the
 * exact text the route would send, which is the same rule the client's own
 * estimates use — so the ceiling a test computes from the reported prompt
 * totals is an arithmetic consequence of these numbers, not a hope.
 *
 * No credential is involved and nothing leaves the machine: the server binds a
 * free port on the loopback interface and the tests point a `Model` at it.
 */

/** One call the answer asks for. */
export interface StubToolCall {
	name: string;
	input: Record<string, unknown>;
}

/** One rung of a scripted conversation. */
export interface StubStep {
	/** Answer with one tool call, which is what keeps an agent loop going. */
	tool?: StubToolCall;
	/**
	 * Answer with several at once, which is how a turn gets heavy: the block
	 * distance between two requests is what the look-back has to cross, and one
	 * call per turn never crosses anything.
	 */
	tools?: StubToolCall[];
	/** Answer with text. */
	text?: string;
	/** Answer with this status and message instead of a stream. */
	fail?: { status: number; message: string };
}

/** The calls an answer asks for, whichever way the script wrote them. */
function callsOf(step: StubStep): StubToolCall[] {
	if (step.tools) return step.tools;
	return step.tool ? [step.tool] : [];
}

/** The usage this endpoint reported for one request, already decoded. */
export interface StubUsage {
	input: number;
	read: number;
	write: number;
	total: number;
	/** The write, split the way Anthropic reports it. */
	write5m: number;
	write1h: number;
}

export interface StubRequest {
	route: "anthropic" | "openai";
	/** The body as it arrived, so a test can assert on the wire. */
	body: Record<string, unknown>;
	/** The usage this endpoint answered with; all zeros where it refused. */
	usage: StubUsage;
	/** The status it answered with. */
	status: number;
	/** How many `cache_control` blocks the body carried. */
	marks: number;
	/** The TTLs those marks asked for, in order; `undefined` where a mark asked for none. */
	ttls: Array<string | undefined>;
	/** The `prompt_cache_key` the route sent, where it sent one. */
	cacheKey?: string;
}

export interface CacheStubOptions {
	/** One entry per request; the last one repeats once the script runs out. */
	steps: StubStep[];
	/** The model id to answer as. */
	modelId?: string;
	/** The documented floor for that model, in tokens. */
	minPrefixTokens?: number;
	/**
	 * Refuse any request whose marks carry a `ttl` field.
	 *
	 * An endpoint that has not enabled the extended-TTL beta answers exactly
	 * this way, which is the only way to exercise the client's downgrade ladder
	 * against a real socket.
	 */
	rejectTtl?: boolean;
	/** Which spelling of the cached-token count the OpenAI route reports. */
	usageSpelling?: "nested" | "topLevel" | "deepseek";
}

export interface CacheStub {
	/** The origin, as the Anthropic SDK wants it: it appends `/v1/messages`. */
	baseUrl: string;
	/** The same origin with the `/v1` the OpenAI SDK expects in a base URL. */
	openAIBaseUrl: string;
	/** Every request this endpoint answered, in order. */
	requests: StubRequest[];
	/** Whether a `ttl` field is currently refused. */
	setRejectTtl(value: boolean): void;
	stop(): void;
}

interface CacheEntry {
	tokens: number;
	expiresAt: number;
}

const MS_PER_MINUTE = 60_000;

/**
 * How far back a read may reach when no mark is found where the prefix ends.
 *
 * The vendors document this as "at most 20 blocks before the breakpoint" and do
 * not publish the boundary condition, so the count here stops where the
 * documented number is exhausted. Nothing asserts on the exact rung — the tests
 * that touch it are about a client that does not need the walk at all.
 */
const WALK_BACK_BLOCKS = 20;

function ttlMs(ttl: string | undefined): number {
	return ttl === "1h" ? 60 * MS_PER_MINUTE : 5 * MS_PER_MINUTE;
}

/** The token count every route here reports, and the one rule behind it. */
function tokensOf(text: string): number {
	return Math.ceil(text.length / 4);
}

/** What a request that was refused is recorded with: it was never billed. */
const NO_USAGE: StubUsage = { input: 0, read: 0, write: 0, total: 0, write5m: 0, write1h: 0 };

/**
 * A prefix store keyed by the exact bytes it was written under.
 *
 * A hash rather than the text itself, because the entries are whole prompts and
 * a long conversation would hold hundreds of them; `crypto.subtle` is not
 * available synchronously in every runtime this runs in, so this is the same
 * FNV pair the client uses for its own identities. A collision would be a cache
 * hit that never happened, which is the one way this endpoint could flatter the
 * client — with a few hundred entries of tens of kilobytes it is not a
 * realistic concern, and no claim in the tests rests on it.
 */
function identityOf(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		a = Math.imul(a ^ code, 16777619) >>> 0;
		b = Math.imul(b ^ code, 2166136261) >>> 0;
	}
	return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/** Strip the marker from a block: `cache_control` is metadata, not prompt bytes. */
function stripMark(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripMark);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
		if (key === "cache_control") continue;
		out[key] = stripMark(inner);
	}
	return out;
}

/**
 * The TTL a position asked for, if it asked for one at all.
 *
 * A mark rides on a *block* — the system prompt's text block, a message's last
 * content block, a `tool_result` — so a message has to be looked into to find
 * one. Where a block inside a message is marked, the whole message position is
 * treated as marked: that is where the prefix ends as far as the cache is
 * concerned, and it is the only place this client ever puts one.
 */
function markTtl(value: unknown): { marked: true; ttl: string | undefined } | undefined {
	if (Array.isArray(value)) {
		for (const block of value) {
			const found = markTtl(block);
			if (found) return found;
		}
		return undefined;
	}
	if (value === null || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const control = record.cache_control;
	if (control === undefined) {
		return Array.isArray(record.content) ? markTtl(record.content) : undefined;
	}
	if (control === null || typeof control !== "object") return { marked: true, ttl: undefined };
	const ttl = (control as Record<string, unknown>).ttl;
	return { marked: true, ttl: typeof ttl === "string" ? ttl : undefined };
}

/** One cached position: its cumulative bytes, and the TTL its mark asked for. */
interface Position {
	text: string;
	tokens: number;
	ttl: string | undefined;
	marked: boolean;
}

/**
 * The Anthropic request, split into the positions a cache is keyed on.
 *
 * A position is a *content block*, not a message: the vendor's breakpoint caches
 * the prefix through the block it sits on, so a breakpoint on the first block of
 * a twelve-block answer covers one twelfth of it and the rest is charged again
 * on the next request. Modelling a whole message as one position would credit
 * such a request with the whole message and hide exactly the mistake this is
 * here to catch.
 *
 * Cumulative rather than per-position, because that is what a prefix is: each
 * entry's text is everything before it plus itself, so two requests agree on a
 * prefix only when the bytes up to that point are identical. The tools and the
 * system prompt are one position each — a breakpoint anywhere inside them covers
 * all of them, the tool block being the last tool definition and the system
 * block being the whole system array.
 *
 * The look-back is documented in blocks, which is now the same unit: one
 * position, one block.
 */
function anthropicPositions(body: Record<string, unknown>): Position[] {
	const out: Position[] = [];
	let cumulative = "";
	const push = (value: unknown, mark: { marked: true; ttl: string | undefined } | undefined): void => {
		cumulative += JSON.stringify(stripMark(value));
		out.push({ text: cumulative, tokens: tokensOf(cumulative), ttl: mark?.ttl, marked: mark?.marked ?? false });
	};

	const tools = body.tools;
	if (Array.isArray(tools) && tools.length > 0) {
		// The tool definitions are one prefix, and a breakpoint on the last of them
		// is what marks it — one on an earlier tool would cover less.
		push(tools, markTtl(tools.at(-1)));
	}
	if (body.system !== undefined) push(body.system, markTtl(body.system));

	const messages = body.messages;
	if (!Array.isArray(messages)) return out;
	for (const message of messages) {
		if (message === null || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;
		const content = record.content;
		if (!Array.isArray(content)) {
			// A bare-string message has no block for a breakpoint to sit on, so it
			// cannot be marked and cannot be a mark's target.
			push(record, undefined);
			continue;
		}
		for (let index = 0; index < content.length; index++) {
			const block = { ...record, content: content.slice(0, index + 1) };
			push(block, markTtl(content[index]));
		}
	}
	return out;
}

/**
 * Read, write and bill one Anthropic request against the store.
 *
 * The order is the documented one: find the longest cached prefix this request
 * can read, write everything from there to the last mark, and charge the rest
 * as uncached input.
 */
function chargeAnthropic(positions: Position[], store: Map<string, CacheEntry>, minPrefixTokens: number): StubUsage {
	const usage: StubUsage = { input: 0, read: 0, write: 0, total: 0, write5m: 0, write1h: 0 };
	const last = positions.at(-1);
	if (!last) return usage;
	usage.total = last.tokens;

	const marked = positions.map((position, index) => ({ position, index })).filter(({ position }) => position.marked);
	const now = Date.now();
	const alive = (index: number): CacheEntry | undefined => {
		const entry = store.get(identityOf(positions[index]?.text ?? ""));
		if (!entry || entry.expiresAt <= now) return undefined;
		return entry.tokens >= minPrefixTokens ? entry : undefined;
	};

	// Longest marked position first: a read is worth what it covers, and the
	// report below is what the provider would have billed.
	let hit = -1;
	for (let i = marked.length - 1; i >= 0; i--) {
		const index = marked[i]?.index ?? -1;
		const entry = index >= 0 ? alive(index) : undefined;
		if (entry) {
			hit = index;
			usage.read = entry.tokens;
			break;
		}
	}
	if (hit < 0) {
		// The documented walk: at most 20 blocks back from the tail, looking for a
		// prefix some earlier request already caused to be cached. An answer that
		// called twelve tools puts twenty-four blocks between two consecutive
		// requests, so whatever was written two messages ago is out of reach from
		// here — which is the whole reason a client marks the previous tail
		// explicitly rather than trusting the walk.
		for (let index = positions.length - 1; index >= 0; index--) {
			if (positions.length - 1 - index > WALK_BACK_BLOCKS) break;
			const entry = alive(index);
			if (entry) {
				hit = index;
				usage.read = entry.tokens;
				break;
			}
		}
	}

	// Writes happen at the marks above the read, and the bill is the tokens between
	// them — the part of the prefix this request was the first to cache.
	let written = hit >= 0 ? (positions[hit]?.tokens ?? 0) : 0;
	for (const { position, index } of marked) {
		if (index <= hit) continue;
		const key = identityOf(position.text);
		store.set(key, { tokens: position.tokens, expiresAt: now + ttlMs(position.ttl) });
		const delta = Math.max(0, position.tokens - written);
		written = position.tokens;
		if (position.ttl === "1h") usage.write1h += delta;
		else usage.write5m += delta;
	}
	usage.write = usage.write5m + usage.write1h;
	usage.input = Math.max(0, usage.total - usage.read - usage.write);
	return usage;
}

/** The longest common prefix of two strings, in characters. */
function commonChars(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

/**
 * Read and bill one OpenAI-compatible request.
 *
 * Automatic caching, so there are no marks to find: the endpoint caches the
 * prompt it was sent and the next request reads as much of it as matches, down
 * to the 128-token granularity, provided the first 1024 tokens are identical.
 */
function chargeOpenAI(
	text: string,
	key: string,
	store: Map<string, { text: string }>,
	minPrefixTokens: number,
): StubUsage {
	const usage: StubUsage = { input: 0, read: 0, write: 0, total: tokensOf(text), write5m: 0, write1h: 0 };
	const floor = Math.max(1024, minPrefixTokens);
	const previous = store.get(key);
	if (previous) {
		const matched = Math.floor(commonChars(previous.text, text) / 4 / 128) * 128;
		if (matched >= floor) {
			usage.read = matched;
			usage.write = 0;
			usage.input = Math.max(0, usage.total - matched);
			store.set(key, { text });
			return usage;
		}
	}
	store.set(key, { text });
	usage.input = usage.total;
	return usage;
}

/** One SSE frame. */
function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamResponse(frames: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
	});
}

function anthropicFrames(step: StubStep, modelId: string, usage: StubUsage): string[] {
	const start = {
		type: "message_start",
		message: {
			id: "msg_stub",
			type: "message",
			role: "assistant",
			model: modelId,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: usage.input,
				output_tokens: 0,
				cache_read_input_tokens: usage.read,
				cache_creation_input_tokens: usage.write,
				cache_creation: {
					ephemeral_5m_input_tokens: usage.write5m,
					ephemeral_1h_input_tokens: usage.write1h,
				},
			},
		},
	};
	const frames = [sse("message_start", start)];
	const calls = callsOf(step);

	if (calls.length > 0) {
		calls.forEach((call, index) => {
			frames.push(
				sse("content_block_start", {
					type: "content_block_start",
					index,
					content_block: { type: "tool_use", id: `toolu_stub_${index}`, name: call.name, input: {} },
				}),
				sse("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
				}),
				sse("content_block_stop", { type: "content_block_stop", index }),
			);
		});
		frames.push(
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 12 },
			}),
		);
	} else {
		frames.push(
			sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: step.text ?? "" },
			}),
			sse("content_block_stop", { type: "content_block_stop", index: 0 }),
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 8 },
			}),
		);
	}

	frames.push(sse("message_stop", { type: "message_stop" }));
	return frames;
}

function openAIFrames(
	step: StubStep,
	modelId: string,
	usage: StubUsage,
	spelling: CacheStubOptions["usageSpelling"],
): string[] {
	const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
		`data: ${JSON.stringify({
			id: "chatcmpl_stub",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	const calls = callsOf(step);
	const usageChunk: Record<string, unknown> = {
		prompt_tokens: usage.total,
		completion_tokens: calls.length > 0 ? 12 : 8,
		total_tokens: usage.total + (calls.length > 0 ? 12 : 8),
	};
	if (spelling === "topLevel") usageChunk.cached_tokens = usage.read;
	else if (spelling === "deepseek") {
		usageChunk.prompt_cache_hit_tokens = usage.read;
		usageChunk.prompt_tokens_details = { cached_tokens: 0 };
	} else usageChunk.prompt_tokens_details = { cached_tokens: usage.read };

	const frames: string[] = [];
	if (calls.length > 0) {
		frames.push(
			chunk(
				{
					tool_calls: calls.map((call, index) => ({
						index,
						id: `call_stub_${index}`,
						type: "function",
						function: { name: call.name, arguments: "" },
					})),
				},
				null,
			),
			chunk(
				{
					tool_calls: calls.map((call, index) => ({ index, function: { arguments: JSON.stringify(call.input) } })),
				},
				null,
			),
			chunk({}, "tool_calls"),
		);
	} else {
		frames.push(chunk({ content: step.text ?? "" }, null), chunk({}, "stop"));
	}
	frames.push(
		`data: ${JSON.stringify({ id: "chatcmpl_stub", object: "chat.completion.chunk", created: 0, model: modelId, choices: [], usage: usageChunk })}\n\n`,
	);
	frames.push("data: [DONE]\n\n");
	return frames;
}

/**
 * Start the endpoint. Always call `stop()`: a server outlives the test that
 * started it, and bun keeps the process alive for one.
 */
export function startCacheStub(options: CacheStubOptions): CacheStub {
	const modelId = options.modelId ?? "claude-opus-5";
	const minPrefixTokens = options.minPrefixTokens ?? 512;
	const spelling = options.usageSpelling ?? "nested";
	const requests: StubRequest[] = [];
	const prefixes = new Map<string, CacheEntry>();
	const openAICache = new Map<string, { text: string }>();
	let rejectTtl = options.rejectTtl ?? false;
	let call = 0;

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const url = new URL(request.url);
			const body = (await request.json()) as Record<string, unknown>;
			const step = options.steps[Math.min(call++, options.steps.length - 1)] ?? { text: "" };
			const refuse = (status: number, message: string): Response =>
				Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status });

			if (step.fail) {
				requests.push({ route: "anthropic", body, usage: NO_USAGE, status: step.fail.status, marks: 0, ttls: [] });
				return refuse(step.fail.status, step.fail.message);
			}

			if (url.pathname.endsWith("/messages")) {
				const positions = anthropicPositions(body);
				const marks = positions.filter((position) => position.marked);
				const ttls = marks.map((position) => position.ttl);
				// Recorded before the refusal is decided, so a test can see the rungs the
				// ladder climbed: a request that was refused is exactly the evidence that
				// the fallback happened rather than that the field was never sent.
				if (rejectTtl && ttls.some((ttl) => ttl !== undefined)) {
					requests.push({ route: "anthropic", body, usage: NO_USAGE, status: 400, marks: marks.length, ttls });
					return refuse(
						400,
						"cache_control.ttl: unknown field — the extended cache TTL beta is not enabled for this key",
					);
				}
				const usage = chargeAnthropic(positions, prefixes, minPrefixTokens);
				requests.push({ route: "anthropic", body, usage, status: 200, marks: marks.length, ttls });
				return streamResponse(anthropicFrames(step, modelId, usage));
			}

			// Everything else is the chat-completions shape: the OpenAI SDK puts the
			// `/v1` in the base URL, so the path arrives as `/v1/chat/completions`.
			const text = JSON.stringify([stripMark(body.messages), stripMark(body.tools ?? null)]);
			const key = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : "no-key";
			const usage = chargeOpenAI(text, key, openAICache, minPrefixTokens);
			requests.push({
				route: "openai",
				body,
				usage,
				status: 200,
				marks: 0,
				ttls: [],
				cacheKey: typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined,
			});
			return streamResponse(openAIFrames(step, modelId, usage, spelling));
		},
	});

	const port = server.port ?? 0;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		openAIBaseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		setRejectTtl: (value: boolean) => {
			rejectTtl = value;
		},
		stop: () => {
			server.stop(true);
		},
	};
}
