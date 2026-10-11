/**
 * Cost tracking: accumulates per-model token usage from assistant messages,
 * computes USD via @labunbun/ai pricing, and persists per-project so /cost
 * and the status line survive resume.
 *
 * Two totals are kept because they answer different questions. The project one
 * is persisted and covers everything this directory has ever spent. The session
 * one is in memory and covers the conversation in front of you: it is seeded
 * from the messages a resume brought back, so `/resume` does not carry the
 * previous conversation's spend into the one just opened. A model the catalog
 * has no price for contributes tokens and no money — `/cost` says which, rather
 * than reporting a total that quietly omits it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeCwd } from "@labunbun/agent";
import { type AgentMessage, computeCost, resolveModel, type Usage } from "@labunbun/ai";

export interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/**
	 * Reasoning tokens, reported beside the others rather than summed into them:
	 * `Usage.reasoning` is a subset of `output` on both wire formats, and a
	 * separate total that absorbed it would double-count every thinking token.
	 */
	reasoningTokens: number;
	costUSD: number;
}

export interface CostState {
	totalCostUSD: number;
	totalDurationMs: number;
	modelsUsage: Record<string, ModelUsage>;
}

export function emptyCostState(): CostState {
	return { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} };
}

/** Fold one usage record into a state, priced by whatever the model resolves to. */
function accumulate(state: CostState, provider: string, modelId: string, usage: Usage, durationMs: number): void {
	const key = `${provider}/${modelId}`;
	const model = resolveModel(`${provider}/${modelId}`);
	const breakdown = computeCost(usage, model?.pricing);
	const existing = state.modelsUsage[key] ?? {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		costUSD: 0,
	};
	existing.inputTokens += usage.input;
	existing.outputTokens += usage.output;
	existing.cacheReadTokens += usage.cacheRead;
	existing.cacheWriteTokens += usage.cacheWrite;
	existing.reasoningTokens += usage.reasoning ?? 0;
	existing.costUSD += breakdown.total;
	state.modelsUsage[key] = existing;
	state.totalCostUSD += breakdown.total;
	state.totalDurationMs += durationMs;
}

/**
 * The cost of one conversation, read back out of its own messages.
 *
 * Usage rides on every assistant message, so a transcript that was resumed or
 * reloaded can be costed again without a separate ledger — and the number that
 * comes out is the one the messages were actually billed at, which is what
 * makes it usable as "this session so far". Durations are not in the messages
 * and come back as zero.
 */
export function costStateFromMessages(messages: AgentMessage[]): CostState {
	const state = emptyCostState();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		accumulate(state, message.provider, message.model, message.usage, 0);
	}
	return state;
}

export class CostTracker {
	#state: CostState = emptyCostState();
	#session: CostState = emptyCostState();
	#path: string | null = null;

	constructor(cwd?: string) {
		if (cwd) {
			this.#path = join(homedir(), ".labunbun", "projects", sanitizeCwd(cwd), "costs.json");
			this.#state = loadCostState(this.#path);
		}
	}

	/** This project, every session, persisted. */
	get state(): CostState {
		return this.#state;
	}

	/** The conversation in front of the user. */
	get sessionState(): CostState {
		return this.#session;
	}

	/**
	 * Start counting a new conversation. Callers pass the messages it is starting
	 * with — a resumed one already spent what its transcript records, and the
	 * total has to include that or `/cost` would under-report the moment a
	 * session is continued.
	 */
	beginSession(messages: AgentMessage[] = []): void {
		this.#session = costStateFromMessages(messages);
	}

	/** Feed one assistant message's usage into both totals. */
	recordUsage(provider: string, modelId: string, usage: Usage, durationMs = 0): void {
		accumulate(this.#state, provider, modelId, usage, durationMs);
		accumulate(this.#session, provider, modelId, usage, durationMs);
	}

	persist(): void {
		if (!this.#path) return;
		try {
			mkdirSync(dirname(this.#path), { recursive: true });
			writeFileSync(this.#path, JSON.stringify(this.#state, null, 2), "utf8");
		} catch {
			// best-effort persistence
		}
	}
}

export function loadCostState(path: string): CostState {
	if (!existsSync(path)) return emptyCostState();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CostState>;
		const modelsUsage = Object.fromEntries(
			Object.entries(parsed.modelsUsage ?? {}).map(([key, usage]) => [
				key,
				// `reasoningTokens` arrived with the field; an entry persisted before
				// it backfills to zero rather than reading as `undefined` in sums.
				{ ...usage, reasoningTokens: usage.reasoningTokens ?? 0 },
			]),
		);
		return {
			totalCostUSD: parsed.totalCostUSD ?? 0,
			totalDurationMs: parsed.totalDurationMs ?? 0,
			modelsUsage,
		};
	} catch (error) {
		// This file is read-modify-written on every persist: continuing with an
		// empty state would rewrite the ledger holding only this session, dropping
		// the directory's whole cost history in silence. The corrupt file moves
		// aside (best effort) and the warning names where it went, so the history
		// is visibly gone from /cost rather than invisibly gone from the disk.
		const backup = `${path}.corrupt-${Date.now()}`;
		let moved: string | null = null;
		try {
			renameSync(path, backup);
			moved = backup;
		} catch {}
		console.error(
			`Warning: ${path} could not be read (${error instanceof Error ? error.message : String(error)}); ` +
				(moved ? `moved to ${moved}.` : "could not be moved aside.") +
				" This project's earlier cost history is not in effect.",
		);
		return emptyCostState();
	}
}

const totalTokens = (usage: ModelUsage): number =>
	usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

/**
 * The cache channels behind one model's token count.
 *
 * `/cost` has always summed four channels into a single number, and that single
 * number cannot show whether the cache worked: a hundred thousand tokens read
 * from cache and a hundred thousand tokens at full price are the same total.
 * Splitting them, with the read share beside it, is the difference between
 * seeing the bill and seeing what caused it.
 */
function cacheChannels(usage: ModelUsage): string {
	const prompt = usage.cacheReadTokens + usage.cacheWriteTokens + usage.inputTokens;
	if (prompt === 0) return "cache: no prompt tokens recorded";
	const rate = usage.cacheReadTokens / prompt;
	return (
		`cache: ${usage.cacheReadTokens.toLocaleString()} read (${(rate * 100).toFixed(1)}%) · ` +
		`${usage.cacheWriteTokens.toLocaleString()} written · ${usage.inputTokens.toLocaleString()} full price`
	);
}

/**
 * One total, with the models under it. The label is required because "Total"
 * on its own is the ambiguity this module exists to remove: a number that could
 * be a conversation or a directory reads as whichever the user assumed.
 */
export function formatCostState(state: CostState, label: string): string {
	const lines = [`${label}: $${state.totalCostUSD.toFixed(4)}`];
	for (const [key, usage] of Object.entries(state.modelsUsage)) {
		// The reasoning share rides the token count rather than getting a line of
		// its own: it is a subset of that count, and a line beside it would read
		// as a second, additive total. Models that never report it show nothing.
		const reasoning = usage.reasoningTokens > 0 ? ` (${usage.reasoningTokens.toLocaleString()} reasoning)` : "";
		lines.push(`  ${key}: ${totalTokens(usage)} tokens${reasoning}, $${usage.costUSD.toFixed(4)}`);
		lines.push(`    ${cacheChannels(usage)}`);
	}
	return lines.join("\n");
}

/** What `/cost` prints: the conversation, then the project it belongs to. */
export function formatCostReport(session: CostState, project: CostState): string {
	const lines = [formatCostState(session, "This session"), formatCostState(project, "This project, all sessions")];
	const unpriced = [...new Set([...Object.keys(session.modelsUsage), ...Object.keys(project.modelsUsage)])].filter(
		(key) => !resolveModel(key)?.pricing,
	);
	if (unpriced.length > 0) {
		// Tokens without a price are counted and shown as $0. Saying so on the same
		// screen is the difference between "this was free" and "this was not costed".
		lines.push(
			`No price is known for ${unpriced.join(", ")} — their tokens are counted but not costed. ` +
				'Set "pricing" in settings.json to cost them.',
		);
	}
	return lines.join("\n");
}
