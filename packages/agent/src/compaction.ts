/**
 * Context compaction: threshold-triggered LLM summarization that keeps long
 * sessions alive past the context window.
 *
 * - Threshold: contextWindow − min(maxOutputTokens, 20k) − reserve(13k)
 * - Hard limit: contextWindow − 3k → caller should abort with an error
 * - Summary prompt: 8 structured sections (request/concepts/files/errors/
 *   solving/pending/current/next)
 * - After compaction, up to 5 recently-touched files are re-injected
 *   (50k char total budget) so active work continues seamlessly
 * - Summarizer: the session's own model, passed in by the caller. The summary
 *   request needs a credential and an endpoint, and those live on the model —
 *   a fabricated one has neither, so it fails 401 and takes compaction with it
 * - Circuit breaker: 3 consecutive failures disable autocompact until the
 *   estimated context drops back under the threshold
 */
import type { AgentMessage, AssistantMessage, Context, Model, StreamFn, Usage, UserMessage } from "@labunbun/ai";
import { textContent, userMessage } from "@labunbun/ai";
import type { CompactionTrigger, SessionStore } from "./session-store.ts";
import type { CompactionCheck, TrimmedToolResults } from "./types.ts";

export interface CompactionConfig {
	contextWindow: number;
	maxOutputTokens: number;
	reserveTokens?: number;
	/**
	 * Whether the cheap rung runs on its own when the threshold is crossed.
	 *
	 * The app turns this on, and the flag's own default is off for a reason worth
	 * keeping: whether previews of old tool results are acceptable is a decision
	 * about someone's conversation, so it is the caller's to make rather than
	 * this module's. Enabled, the rung answers first and full compaction runs
	 * only if the previews did not free enough — and it is a no-op when nothing
	 * was large enough to cut.
	 */
	microcompactFirst?: boolean;
}

export const SUMMARY_PROMPT = `You are summarizing a coding-agent conversation so work can continue in a fresh context. Produce a structured summary with EXACTLY these sections:

<analysis>
Let me analyze the conversation chronologically to capture all essential context.
</analysis>

<summary>
1. Primary Request and Intent:
   [The user's ORIGINAL request, in their own words, before any later refinement — not the most recent thing they said]
2. Key Technical Concepts:
3. Files and Code Sections:
4. Errors and Fixes:
5. Problem Solving:
6. All User Messages:
7. Pending Tasks:
8. Current Work:
   [Exact state at cutoff — what was just done, what was in progress]
9. Next Step:
   [The single immediate next action, quoted from the conversation if possible]
</summary>

Be exhaustive on sections 6-9: future turns depend on them for continuity.`;

const HARD_LIMIT_RESERVE = 3_000;
const MAX_OUTPUT_TOKENS_RESERVE_CAP = 20_000;
const DEFAULT_RESERVE = 13_000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** How much of the current turn survives a compaction verbatim. */
const SUFFIX_TOKEN_BUDGET = 20_000;
/** What one over-budget text in that turn is cut down to, head and tail kept. */
const SUFFIX_ELISION_CHARS = 2_000;
const SUFFIX_ELISION_MARKER = "\n[... elided to fit the context window ...]\n";
/** How much of the user's own wording the boundary carries verbatim. */
const RETAINED_REQUEST_TOKEN_BUDGET = 20_000;
/** Tool results the summarizer keeps in full when its own request is too large. */
const SUFFIX_KEEP_LAST_TOOL_RESULTS = 3;
/** How many times the summarizer may drop a round and send again. */
const MAX_SUMMARY_OVERFLOW_RETRIES = 3;
const REINJECT_FILE_COUNT = 5;
const REINJECT_CHAR_BUDGET = 50_000;
/** Tool results the cheap rung leaves whole — the ones the current turn is using. */
const TRIM_KEEP_LAST_RESULTS = 3;
/** What each older tool result is cut down to by the cheap rung. */
const TRIM_PER_RESULT_BUDGET = 2_000;
/** Below the point where the reserves fit, compact at this share of the window. */
const MIN_THRESHOLD_FRACTION = 0.6;
/** Growth since the last compaction before another one is worth trying. */
const THRASH_GROWTH_FRACTION = 0.05;

/**
 * When to compact: `contextWindow − min(maxOutputTokens, 20k) − reserve(13k)`.
 *
 * A small window can be smaller than the reserves, and the formula then computes
 * a negative number — a threshold that every request is already past, so
 * compaction runs on the very first turn and again after every turn, at a full
 * summarization call each time. Below the point where the reserves fit, the rule
 * degrades to a share of the window instead.
 *
 * It is also kept strictly under the hard limit. A threshold at or above it
 * would mean the only request the compactor is ever consulted about is one that
 * can no longer be sent at all — the moment compaction could have helped is the
 * moment it is too late.
 */
export function compactionThreshold(config: CompactionConfig): number {
	const outputReserve = Math.min(config.maxOutputTokens, MAX_OUTPUT_TOKENS_RESERVE_CAP);
	const reserved = config.contextWindow - outputReserve - (config.reserveTokens ?? DEFAULT_RESERVE);
	const proportional = Math.floor(config.contextWindow * MIN_THRESHOLD_FRACTION);
	return Math.max(0, Math.min(Math.max(reserved, proportional), hardContextLimit(config) - 1));
}

export function hardContextLimit(config: CompactionConfig): number {
	return config.contextWindow - HARD_LIMIT_RESERVE;
}

/**
 * Input tokens in a request prefix, from one usage record.
 *
 * `input` alone is not that number: on Anthropic it excludes the cached prefix,
 * so a cache-heavy session looks nearly empty and the compaction threshold is
 * never reached.
 */
function promptTokens(usage: Usage): number {
	if (usage.promptTotal !== undefined) return usage.promptTotal;
	// Recorded before adapters reported `promptTotal`. Exact for Anthropic; for
	// an OpenAI-compat model the old `input` already contained the cached prefix,
	// so this over-counts — the safe direction, since it can only compact sooner.
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * Rough token estimate: last known API usage anchors the prefix; later
 * messages estimated at ~4 chars/token.
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
	let anchorTokens = 0;
	let anchorIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && (message.usage.promptTotal !== undefined || message.usage.input > 0)) {
			anchorTokens = promptTokens(message.usage) + message.usage.output;
			anchorIndex = i;
			break;
		}
	}
	if (anchorIndex === -1) {
		return Math.ceil(totalChars(messages) / 4);
	}
	let extraChars = 0;
	for (let i = anchorIndex + 1; i < messages.length; i++) {
		extraChars += messageChars(messages[i]);
	}
	return anchorTokens + Math.ceil(extraChars / 4);
}

/** Plain prose runs about 4 chars/token; JSON schema is denser than prose. */
const CHARS_PER_TOKEN = 4;
const CHARS_PER_TOKEN_JSON = 3;

/**
 * What one request actually carries. The messages are only part of it: the
 * system prompt and the tool schemas ride along on every call, and a session
 * with a large toolset can be over its window while `messages` still looks
 * small. Compacting on the transcript alone is compacting the wrong number.
 */
export function estimateContextUsage(context: Context): number {
	const schemaChars = context.tools?.length ? JSON.stringify(context.tools).length : 0;
	return (
		estimateContextTokens(context.messages) +
		Math.ceil(context.systemPrompt.length / CHARS_PER_TOKEN) +
		Math.ceil(schemaChars / CHARS_PER_TOKEN_JSON)
	);
}

/** What one request's tokens are made of, as far as they can be told apart. */
export interface ContextBreakdown {
	/** Everything the request carries: what the threshold is compared against. */
	usedTokens: number;
	systemPromptTokens: number;
	toolSchemaTokens: number;
	messageTokens: number;
	/** The part of `messageTokens` that came back from tools. */
	toolResultTokens: number;
	toolResultCount: number;
}

/**
 * Break the estimate into the parts a person can act on.
 *
 * The rows add up to {@link estimateContextUsage} by construction: the schema
 * row is the remainder rather than a second parse of the tool definitions,
 * because two estimates of the same thing are two numbers that can disagree,
 * and the number this card is read beside is the one the threshold uses.
 *
 * Tool results are called out because they are the part a session can give back
 * without losing anything — `/trim` replaces them with previews — and the part
 * that grows fastest on a turn that reads a lot of files. Their size is a
 * separate estimate from the characters on the wire, so it is a share and not a
 * slice of the total.
 */
export function contextBreakdown(context: Context): ContextBreakdown {
	const usedTokens = estimateContextUsage(context);
	const messageTokens = estimateContextTokens(context.messages);
	const systemPromptTokens = Math.ceil(context.systemPrompt.length / CHARS_PER_TOKEN);
	let toolResultChars = 0;
	let toolResultCount = 0;
	for (const message of context.messages) {
		if (message.role !== "toolResult") continue;
		toolResultCount++;
		toolResultChars += message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
	}
	return {
		usedTokens,
		systemPromptTokens,
		toolSchemaTokens: Math.max(0, usedTokens - messageTokens - systemPromptTokens),
		messageTokens,
		toolResultTokens: Math.ceil(toolResultChars / CHARS_PER_TOKEN),
		toolResultCount,
	};
}

function totalChars(messages: AgentMessage[]): number {
	return messages.reduce((sum, m) => sum + messageChars(m), 0);
}

function messageChars(message: AgentMessage): number {
	if (message.role === "user") {
		return typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
	}
	if (message.role === "assistant") return JSON.stringify(message.content).length;
	return message.content.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 100), 0);
}

/**
 * The tail a compaction must leave alone: everything from the last user message
 * on.
 *
 * Summarizing it away would lose the request being answered right now — or, mid
 * turn, the tool result the model is still waiting on, which it can only answer
 * by running the tool again. It is also the only cut that is always well-formed:
 * a message list has to start with a user turn, and a tool result without the
 * call that asked for it is not a conversation.
 *
 * Past the budget the tail is made smaller instead of dropped. It used to be
 * dropped, and one large tool result was enough to do it: the request being
 * answered left the context that was supposed to continue it, so the model read
 * a summary of work it could no longer see and answered around the user's
 * question instead of to it. What comes out of here always starts with that last
 * user message, and no message is ever removed from it — only replaced by a
 * preview, or cut front and back around a marker, oldest first, until it fits.
 */
export function keepSuffix(messages: AgentMessage[]): AgentMessage[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			const tail = messages.slice(i);
			return estimateContextTokens(tail) <= SUFFIX_TOKEN_BUDGET ? tail : shrinkTail(tail);
		}
	}
	return [];
}

/**
 * Make a tail fit its budget without losing a message from it.
 *
 * Two rungs, cheapest first: the previews the cheap rung already produces, then
 * eliding the texts still too large to carry. Oldest first, because the newest
 * messages are the ones the model is working from, and the request at index 0 is
 * never touched — a request cut down to its first line is not the request.
 *
 * Nothing here guarantees the result fits: a turn can be large enough that every
 * text in it was already cut and it is still over. That is handed back as it is,
 * and the overflow path deals with it — a second refusal for size is a fact
 * about the turn, and answering it by deleting the turn is how the request got
 * lost in the first place.
 */
function shrinkTail(tail: AgentMessage[]): AgentMessage[] {
	let messages = microcompact(tail);
	if (estimateContextTokens(messages) <= SUFFIX_TOKEN_BUDGET) return messages;
	for (let i = 1; i < messages.length; i++) {
		const message = messages[i];
		if (!message) continue;
		const elided = elideMessage(message);
		if (elided === message) continue;
		messages = messages.map((current, index) => (index === i ? elided : current));
		if (estimateContextTokens(messages) <= SUFFIX_TOKEN_BUDGET) break;
	}
	return messages;
}

/** One message with its over-budget texts cut down; itself when nothing needed cutting. */
function elideMessage(message: AgentMessage): AgentMessage {
	if (message.role === "user") {
		if (typeof message.content === "string") {
			const elided = elideText(message.content);
			return elided === message.content ? message : { ...message, content: elided };
		}
		const content = elideBlocks(message.content);
		return content === message.content ? message : { ...message, content };
	}
	if (message.role === "assistant") {
		const content = elideBlocks(message.content);
		return content === message.content ? message : { ...message, content };
	}
	const content = elideBlocks(message.content);
	return content === message.content ? message : { ...message, content };
}

/**
 * The text blocks of a content array, each cut down to a head and a tail.
 *
 * The array comes back by the same reference when none of its blocks was over
 * budget, which is how a caller tells that this message had nothing to give.
 */
function elideBlocks<T extends { type: string; text?: string }>(blocks: T[]): T[] {
	let changed = false;
	const out = blocks.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		const elided = elideText(block.text);
		if (elided === block.text) return block;
		changed = true;
		return { ...block, text: elided };
	});
	return changed ? out : blocks;
}

/**
 * One text, cut to its first and last halves around a marker.
 *
 * The marker says what happened and why, because a model that finds a text
 * stopping mid-sentence with no explanation reads it as the whole file. Both
 * ends are kept: a tool result says what it is at the top and what it found at
 * the bottom, and a request says what it is about at the top and what it wants
 * done at the bottom.
 */
function elideText(text: string, budget = SUFFIX_ELISION_CHARS): string {
	if (text.length <= budget) return text;
	const room = Math.max(0, budget - SUFFIX_ELISION_MARKER.length);
	const head = Math.ceil(room / 2);
	return `${text.slice(0, head)}${SUFFIX_ELISION_MARKER}${text.slice(text.length - (room - head))}`;
}

/**
 * What every boundary message opens with.
 *
 * Named because two pieces of code have to agree on it: the boundary that is
 * written, and the rule that decides what counts as a user's own request — a
 * boundary is a summary wearing a user's clothes, and retaining one verbatim
 * would put a summary inside a summary.
 */
const COMPACTION_BOUNDARY_LEAD =
	"[Conversation compacted to stay within the context window. The summary below preserves everything important.]";

/**
 * The loop's own words after a response was cut off by the output limit.
 *
 * It is a user message on the wire and the user never typed it. It lives here,
 * rather than at the one call site that sends it, so the retention rule above can
 * recognize it: what it does is ask the model to carry on, and a boundary that
 * quoted it back as one of the user's requests would be quoting the harness.
 */
export const LENGTH_RECOVERY_MESSAGE =
	"Your previous response was cut off by the output limit. Continue exactly where you left off — do not repeat completed work.";

/**
 * The user message that stands in for a summarized prefix. Its wording is the
 * model's only clue that the history above it is a summary rather than the
 * conversation itself, so there is exactly one spelling of it in the codebase —
 * an imported session's boundary has to read like a native one.
 */
export function compactionBoundary(
	summary: string,
	options: { reinjected?: string; retainedRequests?: string[]; timestamp?: number } = {},
): ReturnType<typeof userMessage> {
	const retained = options.retainedRequests?.length
		? `\n\nEarlier requests from the user, kept verbatim:\n\n${options.retainedRequests.join("\n\n---\n\n")}`
		: "";
	const text = `${COMPACTION_BOUNDARY_LEAD}\n\n${summary}${retained}${options.reinjected ?? ""}`;
	return options.timestamp === undefined ? userMessage(text) : userMessage(text, options.timestamp);
}

/**
 * The user's own requests from the part being summarized, verbatim.
 *
 * A summary is the model's account of a conversation, and its account of what
 * was asked is the part that drifts: "be exhaustive" is said about the recent
 * turns, and a stretch of work between the question and the summary is exactly
 * what a retelling leaves out. So the newest requests are carried beside it as
 * they were typed — newest first, to a budget, the one that does not fit
 * truncated rather than dropped, which is the rule Codex's own compaction uses
 * (`COMPACT_USER_MESSAGE_MAX_TOKENS`, newest-first accumulation, `truncate_text`
 * on the message that overruns it, then stop).
 *
 * The budget is what keeps a boundary a summary with an appendix rather than a
 * second copy of the transcript. What is not carried here is not lost: the
 * summary above is what stands in for the rest, and the prompt asks it for the
 * original request by name.
 */
export function retainedRequests(messages: AgentMessage[], budget = RETAINED_REQUEST_TOKEN_BUDGET): string[] {
	const kept: string[] = [];
	let remaining = budget;
	for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
		const request = requestText(messages[i]);
		if (request === null) continue;
		const tokens = Math.ceil(request.length / CHARS_PER_TOKEN);
		if (tokens <= remaining) {
			kept.unshift(request);
			remaining -= tokens;
			continue;
		}
		// The one that overruns is the last one taken: it is older than everything
		// kept so far, and a request cut down to fit still beats an absent one.
		kept.unshift(elideText(request, remaining * CHARS_PER_TOKEN));
		break;
	}
	return kept;
}

/** A user message's own words, or null for the messages that only look like them. */
function requestText(message: AgentMessage | undefined): string | null {
	if (message?.role !== "user") return null;
	const text = userText(message).trim();
	if (text.length === 0) return null;
	if (text.startsWith(COMPACTION_BOUNDARY_LEAD) || text.startsWith(LENGTH_RECOVERY_MESSAGE)) return null;
	return text;
}

function userText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Extract recently-touched file paths from tool calls/results, newest first. */
export function extractRecentFiles(messages: AgentMessage[], limit = REINJECT_FILE_COUNT): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			try {
				const input = JSON.parse(block.arguments) as Record<string, unknown>;
				const path = input.file_path ?? input.path ?? input.notebook_path;
				if (typeof path === "string" && !seen.has(path)) {
					seen.add(path);
					out.push(path);
				}
			} catch {}
		}
	}
	return out;
}

/**
 * What one pass did. Only `compact` is a summarization: it makes a model call
 * and records a boundary. `reduced` replaces old tool results with previews and
 * nothing else, and a caller that could not tell the two apart would report a
 * summary that never happened.
 */
type CompactionPass =
	| { kind: "compact"; context: Context }
	| { kind: "reduced"; context: Context; cleared: TrimmedToolResults };

/**
 * A summarization in flight, and how it ended.
 *
 * A compaction is the one thing a session does that costs a full-price model
 * call, takes as long as a whole turn, and leaves the transcript's shape
 * changed — and until this existed, none of that reached whoever was watching
 * the screen. The three kinds are a lifecycle rather than a log: every `start`
 * ends, with a summary or without one, because a caller that paints a status
 * while the work is in flight needs the second ending as much as the first or
 * the status outlives the attempt.
 *
 * `failed` is not the breaker's news: the breaker counts to three and speaks
 * long after, when the session is stuck. This is one attempt that did not
 * happen, said while the user can still see what caused it.
 */
export type CompactionPhase =
	| { kind: "start" }
	| { kind: "done"; preTokens: number; postTokens: number; trigger: CompactionTrigger }
	| { kind: "failed"; trigger: CompactionTrigger };

export interface CompactionManagerDeps {
	streamFn: StreamFn;
	store?: SessionStore;
	readFile?: (path: string) => string | null;
	/**
	 * The model that writes summaries. The credential and the endpoint are
	 * resolved from it at request time, so it must be a real registry entry —
	 * the session's own model. A synthesized stand-in has an empty `apiKeyEnv`
	 * and an empty `baseUrl`, which is a request that can never be sent.
	 */
	summarizerModel: Model;
	/** Watch a summarization happen. Never consulted for a decision. */
	onPhase?: (phase: CompactionPhase) => void;
}

export class CompactionManager {
	#deps: CompactionManagerDeps;
	#config: CompactionConfig;
	#consecutiveFailures = 0;
	/** Size the context was left at by the last compaction, or null if none ran. */
	#lastPostTokens: number | null = null;

	constructor(config: CompactionConfig, deps: CompactionManagerDeps) {
		this.#config = config;
		this.#deps = deps;
		// Anti-thrash has to outlive the manager, because the manager does not
		// outlive much: `/resume`, `/model` and a restart each build a new one,
		// while the session file is what persists. Without this, reopening a
		// session that was just compacted pays for the same summary again — the
		// transcript it starts from is the compacted one, which is still over the
		// threshold by design. `postTokens` is the size the last pass left behind,
		// and 0 (an imported compaction, which this session never measured) is inert
		// here rather than guarded against: the only thing done with this number is
		// compare it against the growth floor, and a context under that floor is
		// under the threshold too, so it is turned away before the comparison.
		const last = deps.store?.compactions().at(-1);
		if (last) this.#lastPostTokens = last.postTokens;
	}

	get isTripped(): boolean {
		return this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
	}

	/**
	 * The three numbers that describe this session's headroom, as the manager
	 * itself computes them: where it compacts, where a request is refused, and
	 * the window both are derived from. Reported rather than recomputed by the
	 * caller — a card that recomputed them could disagree with the behaviour it
	 * is describing.
	 */
	limits(): { contextWindow: number; threshold: number; hardLimit: number } {
		return {
			contextWindow: this.#config.contextWindow,
			threshold: compactionThreshold(this.#config),
			hardLimit: hardContextLimit(this.#config),
		};
	}

	/**
	 * One decision about one context: nothing, a cheaper context, or a summary.
	 *
	 * The kind is part of the answer rather than narrowed away, because every
	 * caller that acts on this also reports it: a summary and a set of previews
	 * are not the same event to the user, the cache report or the session file.
	 * `check()` is the only shape the loop asks for.
	 */
	async #pass(context: Context, options: { force?: boolean } = {}): Promise<CompactionPass | null> {
		const tokens = estimateContextUsage(context);
		const threshold = compactionThreshold(this.#config);
		if (this.#config.microcompactFirst && tokens >= threshold) {
			// Before the breaker, not after. This rung is not the mechanism the
			// breaker is a statement about, and the state where every summary is
			// failing is exactly the state where a lever that cannot fail is worth
			// having. Below the threshold it is not consulted at all: a trim that
			// removes a preview's worth of text is not a way to get under a limit.
			const reduced = this.trim(context);
			if (reduced && estimateContextUsage(reduced.context) < threshold) {
				// Said now, so the next turn does not measure growth from the size the
				// context had before the trim.
				this.#lastPostTokens = estimateContextUsage(reduced.context);
				return { kind: "reduced", ...reduced };
			}
		}
		// A refusal for size outranks the estimate, and outranks the breaker: this
		// request has already been rejected once, so the only two outcomes left are
		// "send less" and "do not send". Skipping the attempt would leave only the
		// second, and the breaker is a guess about future attempts, not a fact about
		// this one.
		if (!options.force) {
			if (tokens < threshold) return null;
			if (this.isTripped) return null;
			// Anti-thrash. A compaction that has just run on a context this size is
			// not run again for a context that has barely moved: the second pass
			// summarizes nearly the same transcript, costs a full summarization call,
			// and frees nearly the same nothing. Growth is what makes it worth
			// retrying. Below the hard limit only — past it, the choice is a smaller
			// request or none, and "not yet" is not an option.
			if (
				this.#lastPostTokens !== null &&
				tokens < hardContextLimit(this.#config) &&
				tokens - this.#lastPostTokens < this.#thrashGrowth()
			) {
				return null;
			}
		}
		// `force` is the refusal, and only the refusal: the one production caller
		// sets it from a provider that just answered `context_overflow`. So it is
		// also the honest name for why this pass is happening, and it is recorded
		// that way — a reader of the session file can tell a summary the threshold
		// asked for from one a 400 forced.
		return { kind: "compact", context: await this.compact(context, options.force ? { trigger: "overflow" } : {}) };
	}

	/**
	 * The cheap rung on its own: replace the old tool results with previews.
	 *
	 * No model call and no store entry. The previews live in the message list the
	 * session holds, so a resumed session re-derives them from the transcript it
	 * reloads — which is the right shape for a change that is lossy in context and
	 * lossless on disk. Returns null when there was nothing over the per-result
	 * budget to cut, which is also what makes a second pass a no-op.
	 */
	trim(context: Context): { context: Context; cleared: TrimmedToolResults } | null {
		const trimmed = microcompact(context.messages);
		if (trimmed === context.messages) return null;
		let results = 0;
		let chars = 0;
		for (let i = 0; i < trimmed.length; i++) {
			const before = context.messages[i];
			const after = trimmed[i];
			if (before === undefined || after === undefined || before === after) continue;
			const gave = messageChars(before) - messageChars(after);
			if (gave <= 0) continue;
			results++;
			chars += gave;
		}
		if (results === 0) return null;
		return { context: { ...context, messages: trimmed }, cleared: { results, chars } };
	}

	/** How much new context makes another summarization worth its cost. */
	#thrashGrowth(): number {
		return Math.max(1, Math.floor(this.#config.contextWindow * THRASH_GROWTH_FRACTION));
	}

	/**
	 * The loop's decision point: compact when the threshold says so, and refuse
	 * to send at all when the request cannot fit and no space could be freed.
	 *
	 * A refusal matters more than it looks. The provider's 400 arrives as a
	 * generic error, and with a fallback chain configured the same oversized
	 * context is then replayed against the next model — so the run fails
	 * identically on every later prompt, with nothing that says why.
	 */
	async check(context: Context, options: { force?: boolean } = {}): Promise<CompactionCheck | null> {
		const overHard = options.force === true || estimateContextUsage(context) >= hardContextLimit(this.#config);
		try {
			const pass = await this.#pass(context, options);
			if (!pass) return null;
			return pass.kind === "compact"
				? { action: "compact", context: pass.context }
				: { action: "reduced", context: pass.context, cleared: pass.cleared };
		} catch {
			// The failure is already counted in #consecutiveFailures. Below the hard
			// limit the turn goes ahead as it always did — the provider's own error is
			// the report, and it may well fit after all.
			return overHard ? { action: "blocked", message: this.blockedMessage() } : null;
		}
	}

	/** Summarize and rebuild the context. Throws on failure (caller counts). */
	async compact(context: Context, options: { trigger?: CompactionTrigger; focus?: string } = {}): Promise<Context> {
		const trigger = options.trigger ?? "auto";
		try {
			const suffix = keepSuffix(context.messages);
			const prefix = context.messages.slice(0, context.messages.length - suffix.length);
			const preTokens = estimateContextUsage(context);
			// Before the call, not after: this is the last moment at which the wait
			// it announces has not started, and the wait is the whole point of saying
			// it — a summary is a full-prefix request that can take half a minute.
			this.#deps.onPhase?.({ kind: "start" });
			const { summary, model } = await this.#summarize(prefix, options.focus);
			const reinjected = this.#reinjectFiles(prefix);
			const boundary = compactionBoundary(summary, { reinjected, retainedRequests: retainedRequests(prefix) });
			const messages = [boundary, ...suffix];

			// A success clears the count, manual or automatic: the breaker is a
			// statement about this session's compaction working, and it has just been
			// contradicted. This is also what makes /compact the way out of a tripped
			// breaker rather than a command that reports success to no effect.
			this.#consecutiveFailures = 0;
			this.#lastPostTokens = estimateContextUsage({ ...context, messages });
			this.#deps.store?.appendCompaction({
				boundary,
				suffix,
				summary,
				preservedFiles: extractRecentFiles(context.messages),
				preTokens,
				postTokens: this.#lastPostTokens,
				// Which model actually wrote this. The stream may be fallback-wrapped,
				// so the model we asked is not necessarily the one that answered, and
				// a summary no one can attribute is a summary no one can trust.
				model,
				trigger,
			});
			// After the record, so a listener that reads the store's compaction list
			// on this news sees the one being reported rather than the previous one.
			this.#deps.onPhase?.({ kind: "done", preTokens, postTokens: this.#lastPostTokens, trigger });

			return { ...context, messages };
		} catch (error) {
			this.#consecutiveFailures++;
			this.#deps.onPhase?.({ kind: "failed", trigger });
			throw error;
		}
	}

	/**
	 * Why a request that cannot fit is not being sent, and what to do about it.
	 *
	 * The commands it names are ones the app dispatches: advice that ends in
	 * "unknown command" is worse than none, and this is read at the moment the
	 * session is stuck.
	 */
	blockedMessage(): string {
		const cause = this.isTripped
			? `Automatic compaction failed ${MAX_CONSECUTIVE_FAILURES} times and is switched off for this session`
			: "Automatic compaction could not free enough space";
		return (
			`${cause}, and the conversation no longer fits in this model's ${this.#config.contextWindow.toLocaleString()} token window. ` +
			"Run /compact to summarize it now, /trim to drop old tool results for free, " +
			"or exit and start a new session."
		);
	}

	/**
	 * Write the summary.
	 *
	 * The request it sends is the whole conversation minus a little — which is
	 * exactly the size that just overflowed the window. So the summary request is
	 * the one call that is too big by construction, and it is also the only way
	 * out of that state: it must not be able to fail for the reason it exists to
	 * fix. Hence two protections. The old tool results are replaced by a preview
	 * before the first send — they are the bulk of a long transcript and the least
	 * of what a summary needs, since a summary is about what was learned, not the
	 * bytes it was learned from. And if the provider still refuses for size, the
	 * oldest whole round is dropped and the request sent again.
	 */
	async #summarize(messages: AgentMessage[], focus?: string): Promise<{ summary: string; model: string }> {
		const instruction = focus?.trim() ? `${SUMMARY_PROMPT}\n\nFocus especially on: ${focus.trim()}` : SUMMARY_PROMPT;
		let history = microcompact(messages, SUFFIX_KEEP_LAST_TOOL_RESULTS);
		for (let retries = 0; ; retries++) {
			const summarizeRequest: Context = {
				systemPrompt: "You are a precise summarizer. Follow the requested output format exactly.",
				messages: [...history, userMessage(instruction)],
				tools: [],
			};

			const model = this.#deps.summarizerModel;
			let text = "";
			let servedBy = model.id;
			// Whether the provider refused this attempt for size. Anything else that
			// goes wrong is a real failure and keeps its own meaning.
			let tooBig = false;
			for await (const event of this.#deps.streamFn(model, summarizeRequest, { thinkingLevel: "off" })) {
				if (event.type === "text_delta") text += event.delta;
				// The stream may be fallback-wrapped: report whoever answered.
				if (event.type === "done" && event.message.model) servedBy = event.message.model;
				if (event.type === "error") {
					if (event.message.errorKind === "context_overflow") {
						tooBig = true;
						break;
					}
					throw new Error(event.message.errorMessage ?? "compaction stream failed");
				}
			}
			if (!tooBig) {
				if (!text.trim()) throw new Error("compaction produced empty summary");
				return { summary: stripAnalysis(text), model: servedBy };
			}

			// Every retry sends strictly less, so this terminates — at the bound or
			// at the point where only one round is left. Giving up is the honest
			// outcome: the alternative is a summary of a conversation the model was
			// never able to read.
			if (retries >= MAX_SUMMARY_OVERFLOW_RETRIES) break;
			const shorter = dropOldestRound(history);
			if (!shorter) break;
			history = shorter;
		}
		throw new Error(
			"the conversation is too large to summarize: it does not fit the summarizer's window even reduced to its most recent round",
		);
	}

	#reinjectFiles(messages: AgentMessage[]): string {
		const files = extractRecentFiles(messages);
		if (files.length === 0) return "";
		const parts: string[] = ["\n\n---\n\nRecently touched files (re-injected for continuity):"];
		let budget = REINJECT_CHAR_BUDGET;
		for (const path of files) {
			if (budget <= 0) break;
			const content = this.#deps.readFile?.(path);
			if (content === null || content === undefined) continue;
			const slice = content.slice(0, Math.min(budget, 20_000));
			budget -= slice.length;
			parts.push(`\n--- ${path} ---\n${slice}`);
		}
		return parts.join("\n");
	}
}

/** Drop the <analysis> block from summaries — keep the actionable part. */
export function stripAnalysis(summary: string): string {
	const match = summary.match(/<summary>([\s\S]*?)<\/summary>/);
	return match ? match[1].trim() : summary;
}

/**
 * Drop the oldest complete round: the first user message and everything the
 * model did in reply, up to the next user message.
 *
 * The cut is on a user-turn boundary because that is the only one that keeps
 * the list well-formed — a tool result without the call that asked for it is
 * not a conversation, and a summary request that does not start with a user
 * turn is not a valid request. Returns null when only one round is left: there
 * is nothing older to give up, and the caller must stop rather than spin.
 */
export function dropOldestRound(messages: AgentMessage[]): AgentMessage[] | null {
	const first = messages.findIndex((m) => m.role === "user");
	if (first === -1) return null;
	for (let i = first + 1; i < messages.length; i++) {
		if (messages[i]?.role === "user") return messages.slice(i);
	}
	return null;
}

/** Where a tool result was replaced by a preview of itself. */
const MICROCOMPACT_MARKER = "\n[... truncated by microcompact ...]";

/**
 * Microcompact: truncate the OLDEST tool results to a preview so recent
 * context stays intact. Runs before full compaction in the ladder.
 *
 * A preview ends at exactly `perResultBudget`, marker included, so the budget
 * bounds what the preview costs and not merely the text it keeps: a caller that
 * sizes a request by it — the round cap, or anything deciding what fits — can
 * rely on it, and a second pass finds nothing left over to cut.
 */
export function microcompact(
	messages: AgentMessage[],
	keepLastN = TRIM_KEEP_LAST_RESULTS,
	perResultBudget = TRIM_PER_RESULT_BUDGET,
): AgentMessage[] {
	const toolResultIndices: number[] = [];
	messages.forEach((m, i) => {
		if (m.role === "toolResult") toolResultIndices.push(i);
	});
	if (toolResultIndices.length <= keepLastN) return messages;

	const cutoff = new Set(toolResultIndices.slice(-keepLastN));
	const room = Math.max(0, perResultBudget - MICROCOMPACT_MARKER.length);
	return messages.map((message, i) => {
		if (cutoff.has(i) || message.role !== "toolResult") return message;
		const content = message.content.map((block) =>
			block.type === "text" && block.text.length > perResultBudget
				? textContent(`${block.text.slice(0, room)}${MICROCOMPACT_MARKER}`)
				: block,
		);
		return { ...message, content };
	});
}

export type { AssistantMessage };

/**
 * Shown once when the breaker trips. Otherwise the failures are silent: the
 * threshold keeps saying "compact", nothing happens, and the session looks
 * forgetful until a turn ends with a request that cannot be sent.
 *
 * Both ways out it names are commands that exist and that free context without
 * calling a model that just failed: the summaries are the thing that stopped
 * working, so the advice cannot be summaries alone.
 */
export const COMPACTION_DISABLED_NOTICE =
	`Automatic compaction failed ${MAX_CONSECUTIVE_FAILURES} times and is switched off for this session. ` +
	"Run /compact to try it once more (a success re-enables it), or /trim to free space without a summary.";
