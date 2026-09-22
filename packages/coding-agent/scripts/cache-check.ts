#!/usr/bin/env bun
/**
 * Live cache check: measure the real hit rate of a real multi-turn session.
 *
 * Usage: bun run packages/coding-agent/scripts/cache-check.ts <provider/model> [turns] [--ttl 1h|5m|auto]
 *        e.g. bun run packages/coding-agent/scripts/cache-check.ts anthropic/claude-opus-5 6
 *
 * **This spends money.** It makes two requests per turn (a tool round and the
 * answer after it) against a real provider, which is the only way to read a real
 * number: everything else in this repository measures the machinery against an
 * endpoint that simulates the documented rules, and a simulated vendor cannot
 * tell you what a real one charged.
 *
 * What it answers, in the order the questions come up:
 *
 * - Did the provider accept the long TTL? A refusal shows as a `ttl-downgrade`
 *   notice naming the provider's own words, and every request after it runs on
 *   the short one.
 * - Does a tool round survive a real API? The tool it calls is real, so the
 *   request carrying `tool_use` arguments has to be one the provider accepts.
 * - What was the hit rate, against the ceiling this conversation could reach?
 *   The ceiling is arithmetic (`sum(P[t-1]) / sum(P[t])`), so the pair is the
 *   whole answer: at the ceiling, nothing was lost; below it, something was.
 *
 * Requires the provider's API key in its own environment variable
 * (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, ...). The key is read by the same code
 * the app uses and is never printed.
 */
import { AgentSession, buildTool } from "@labunbun/agent";
import {
	cacheCeiling,
	cacheTotals,
	createTrackedStreamFn,
	type Model,
	promptTotalsOf,
	resolveApiKey,
	resolveModel,
	totalsHitRate,
} from "@labunbun/ai";
import { z } from "zod";

const reference = process.argv[2];
if (!reference) {
	console.error(
		"Usage: bun run packages/coding-agent/scripts/cache-check.ts <provider/model> [turns] [--ttl 1h|5m|auto]",
	);
	console.error("       bun run packages/coding-agent/scripts/cache-check.ts anthropic/claude-opus-5 6");
	process.exit(1);
}

const turnsArg = process.argv[3];
const turns = turnsArg && !turnsArg.startsWith("--") ? Number(turnsArg) : 4;
if (!Number.isInteger(turns) || turns < 2) {
	console.error(`turns must be an integer of at least 2 (the second request is the first one that can hit)`);
	process.exit(1);
}

const ttlIndex = process.argv.indexOf("--ttl");
const ttl = (ttlIndex >= 0 ? process.argv[ttlIndex + 1] : undefined) as "1h" | "5m" | "auto" | undefined;
if (ttl !== undefined && ttl !== "1h" && ttl !== "5m" && ttl !== "auto") {
	console.error(`--ttl takes 1h, 5m or auto, not ${ttl}`);
	process.exit(1);
}

const model: Model | undefined = resolveModel(reference);
if (!model) {
	console.error(`Unknown model reference: ${reference}`);
	console.error("Known: anthropic/claude-opus-5, deepseek/deepseek-chat, ...");
	process.exit(1);
}
if (!resolveApiKey(model)) {
	console.error(`Missing API key: set ${model.apiKeyEnv}`);
	process.exit(1);
}

/**
 * A tool that does nothing, so a turn has a tool round in it.
 *
 * The point is the *shape* of the conversation — an assistant message with
 * tool calls, then a user message carrying the results — because that is where
 * the prefix grows in blocks rather than in lines, and it is the shape a cache
 * breakpoint has to survive. It reads and writes nothing.
 */
const noop = buildTool({
	name: "record_step",
	description: "Record that a step happened. Call this once, then answer with text.",
	inputSchema: z.object({ step: z.number() }),
	isReadOnly: () => true,
	call: async (input) => ({ content: [{ type: "text", text: `recorded step ${input.step}` }] }),
});

const notices: string[] = [];
const tracked = createTrackedStreamFn({
	policy: ttl === undefined ? undefined : { ttl },
	onCacheNotice: (notice) => notices.push(`${notice.from} -> ${notice.to}: ${notice.reason}`),
});

const session = new AgentSession({
	model,
	// Long enough to clear the model's documented minimum on its own, which is
	// what makes a breakpoint on it worth placing.
	systemPrompt: [
		"You are a terse assistant with one tool.",
		...Array.from(
			{ length: 200 },
			(_, i) => `House rule ${i}: keep the transcript byte-stable; never rewrite a message already sent.`,
		),
	].join("\n"),
	tools: [noop],
	deps: { streamFn: tracked.streamFn },
});

console.error(`Running ${turns} turns (about ${turns * 2} requests) against ${model.provider}/${model.id}...`);
console.error("This costs money.\n");

for (let turn = 0; turn < turns; turn++) {
	await session.prompt(`Turn ${turn}: record the step and answer in one short sentence.`);
}

let index = 0;
for (const message of session.messages) {
	if (message.role !== "assistant") continue;
	const usage = message.usage;
	index++;
	console.log(
		`#${String(index).padStart(2)}  prompt ${String(usage.promptTotal ?? 0).padStart(7)}  ` +
			`read ${String(usage.cacheRead).padStart(7)}  write ${String(usage.cacheWrite).padStart(6)}  ` +
			`full ${String(usage.input).padStart(6)}  out ${String(usage.output).padStart(5)}`,
	);
}

const totals = cacheTotals(session.messages);
const rate = totalsHitRate(totals);
const ceiling = cacheCeiling(promptTotalsOf(session.messages));
const percent = (value: number | undefined): string => (value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);

console.log(
	`\n${totals.requests} request(s) · ${totals.read} read · ${totals.write} written · ${totals.input} full price`,
);
console.log(`hit rate ${percent(rate)} · ceiling ${percent(ceiling)} for this shape`);
if (rate !== undefined && ceiling !== undefined && ceiling > 0) {
	console.log(`of what was reachable: ${((rate / ceiling) * 100).toFixed(1)}%`);
}

const records = tracked.tracker.records();
const rewinds = records.filter((record) => record.kind === "rewind");
console.log(
	`prefix: ${records.filter((record) => record.kind === "extension").length} extension(s) · ` +
		`${records.filter((record) => record.kind === "first").length} cold start(s) · ${rewinds.length} rewind(s)`,
);
for (const rewind of rewinds) {
	const where = rewind.divergence?.messageIndex;
	console.log(
		`  rewind at turn ${rewind.turn}${where === undefined ? "" : `, message ${where}`}: ` +
			`${rewind.causes.join(" + ") || "UNREGISTERED — nothing declared this rewrite"}`,
	);
}

// The two questions this script exists to answer that a simulated endpoint
// cannot: whether the long TTL survived contact with the real API, and whether
// the number the provider reported is anywhere near what the shape allows.
if (notices.length === 0) {
	console.log(`\nno cache setting was refused${ttl === "auto" || ttl === "1h" ? " — the long TTL was accepted" : ""}`);
} else {
	for (const notice of notices) console.log(`\nrefused: ${notice}`);
}
