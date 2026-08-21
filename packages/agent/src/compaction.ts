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
 * - Circuit breaker: 3 consecutive failures disable autocompact until the
 *   estimated context drops back under the threshold
 */
import type { AgentMessage, AssistantMessage, Context, StreamFn } from "@labunbun/ai";
import { textContent, userMessage } from "@labunbun/ai";
import type { SessionStore } from "./session-store.ts";

export interface CompactionConfig {
	contextWindow: number;
	maxOutputTokens: number;
	reserveTokens?: number;
}

export const SUMMARY_PROMPT = `You are summarizing a coding-agent conversation so work can continue in a fresh context. Produce a structured summary with EXACTLY these sections:

<analysis>
Let me analyze the conversation chronologically to capture all essential context.
</analysis>

<summary>
1. Primary Request and Intent:
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
const REINJECT_FILE_COUNT = 5;
const REINJECT_CHAR_BUDGET = 50_000;

export function compactionThreshold(config: CompactionConfig): number {
	const outputReserve = Math.min(config.maxOutputTokens, MAX_OUTPUT_TOKENS_RESERVE_CAP);
	return config.contextWindow - outputReserve - (config.reserveTokens ?? DEFAULT_RESERVE);
}

export function hardContextLimit(config: CompactionConfig): number {
	return config.contextWindow - HARD_LIMIT_RESERVE;
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
		if (message.role === "assistant" && message.usage.input > 0) {
			anchorTokens = message.usage.input + message.usage.output;
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

export interface CompactionManagerDeps {
	streamFn: StreamFn;
	store?: SessionStore;
	readFile?: (path: string) => string | null;
}

export class CompactionManager {
	#deps: CompactionManagerDeps;
	#config: CompactionConfig;
	#consecutiveFailures = 0;

	constructor(config: CompactionConfig, deps: CompactionManagerDeps) {
		this.#config = config;
		this.#deps = deps;
	}

	get isTripped(): boolean {
		return this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
	}

	/** Called by the loop each turn via deps.checkCompaction. */
	async maybeCompact(context: Context): Promise<Context | null> {
		const tokens = estimateContextTokens(context.messages);
		if (tokens < compactionThreshold(this.#config)) return null;
		if (this.isTripped) return null;
		return this.compact(context);
	}

	/** Summarize and rebuild the context. Throws on failure (caller counts). */
	async compact(context: Context): Promise<Context> {
		try {
			const summary = await this.#summarize(context.messages);
			const reinjected = this.#reinjectFiles(context.messages);
			const boundaryMessage = userMessage(
				`[Conversation compacted to stay within the context window. The summary below preserves everything important.]\n\n${summary}${reinjected}`,
			);

			this.#consecutiveFailures = 0;
			this.#deps.store?.appendCustom("compaction", {
				summary,
				preTokens: estimateContextTokens(context.messages),
				preservedFiles: extractRecentFiles(context.messages),
			});

			return { ...context, messages: [boundaryMessage] };
		} catch (error) {
			this.#consecutiveFailures++;
			throw error;
		}
	}

	async #summarize(messages: AgentMessage[]): Promise<string> {
		const summarizeRequest: Context = {
			systemPrompt: "You are a precise summarizer. Follow the requested output format exactly.",
			messages: [...messages, userMessage(SUMMARY_PROMPT)],
			tools: [],
		};

		let text = "";
		for await (const event of this.#deps.streamFn(
			{
				id: "compaction",
				name: "Compaction",
				api: "anthropic-messages",
				provider: "internal",
				baseUrl: "",
				apiKeyEnv: "",
				contextWindow: this.#config.contextWindow,
				maxOutputTokens: 16_000,
				reasoning: false,
				input: ["text"],
			},
			summarizeRequest,
			{ thinkingLevel: "off" },
		)) {
			if (event.type === "text_delta") text += event.delta;
			if (event.type === "error") throw new Error(event.message.errorMessage ?? "compaction stream failed");
		}
		if (!text.trim()) throw new Error("compaction produced empty summary");
		return stripAnalysis(text);
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
 * Microcompact: truncate the OLDEST tool results to a preview so recent
 * context stays intact. Runs before full compaction in the ladder.
 */
export function microcompact(messages: AgentMessage[], keepLastN = 3, perResultBudget = 2_000): AgentMessage[] {
	const toolResultIndices: number[] = [];
	messages.forEach((m, i) => {
		if (m.role === "toolResult") toolResultIndices.push(i);
	});
	if (toolResultIndices.length <= keepLastN) return messages;

	const cutoff = new Set(toolResultIndices.slice(-keepLastN));
	return messages.map((message, i) => {
		if (cutoff.has(i) || message.role !== "toolResult") return message;
		const content = message.content.map((block) =>
			block.type === "text" && block.text.length > perResultBudget
				? textContent(`${block.text.slice(0, perResultBudget)}\n[... truncated by microcompact ...]`)
				: block,
		);
		return { ...message, content };
	});
}

export type { AssistantMessage };
