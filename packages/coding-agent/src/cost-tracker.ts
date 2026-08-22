/**
 * Cost tracking: accumulates per-model token usage from assistant messages,
 * computes USD via @labunbun/ai pricing, and persists per-project so /cost
 * and the status line survive resume.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeCwd } from "@labunbun/agent";
import { computeCost, resolveModel, type Usage } from "@labunbun/ai";

export interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
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

export class CostTracker {
	#state: CostState = emptyCostState();
	#path: string | null = null;

	constructor(cwd?: string) {
		if (cwd) {
			this.#path = join(homedir(), ".labunbun", "projects", sanitizeCwd(cwd), "costs.json");
			this.#state = loadCostState(this.#path);
		}
	}

	get state(): CostState {
		return this.#state;
	}

	/** Feed one assistant message's usage into the totals. */
	recordUsage(provider: string, modelId: string, usage: Usage, durationMs = 0): void {
		const key = `${provider}/${modelId}`;
		const model = resolveModel(`${provider}/${modelId}`);
		const breakdown = computeCost(usage, model?.pricing);
		const existing = this.#state.modelsUsage[key] ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUSD: 0,
		};
		existing.inputTokens += usage.input;
		existing.outputTokens += usage.output;
		existing.cacheReadTokens += usage.cacheRead;
		existing.cacheWriteTokens += usage.cacheWrite;
		existing.costUSD += breakdown.total;
		this.#state.modelsUsage[key] = existing;
		this.#state.totalCostUSD += breakdown.total;
		this.#state.totalDurationMs += durationMs;
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
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CostState;
		return {
			totalCostUSD: parsed.totalCostUSD ?? 0,
			totalDurationMs: parsed.totalDurationMs ?? 0,
			modelsUsage: parsed.modelsUsage ?? {},
		};
	} catch {
		return emptyCostState();
	}
}

export function formatCostState(state: CostState): string {
	const lines = [`Total cost: $${state.totalCostUSD.toFixed(4)}`];
	for (const [key, usage] of Object.entries(state.modelsUsage)) {
		lines.push(
			`  ${key}: ${usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens} tokens, $${usage.costUSD.toFixed(4)}`,
		);
	}
	return lines.join("\n");
}
