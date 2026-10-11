#!/usr/bin/env bun
/**
 * Live smoke test: stream one prompt from a real provider.
 *
 * Usage: bun run scripts/smoke.ts <provider/model> ["prompt"]
 * Requires the provider's API key in its environment variable
 * (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, ...). Models that take no key
 * (the local Ollama daemon) stream without one.
 */
import {
	createDefaultStreamFn,
	missingApiKey,
	refreshModelCatalog,
	resolveModel,
	userMessage,
} from "../packages/ai/src/index.ts";

const reference = process.argv[2];
if (!reference) {
	console.error("Usage: bun run scripts/smoke.ts <provider/model> [prompt]");
	process.exit(1);
}
const prompt = process.argv[3] ?? "Reply with exactly: smoke ok";

let model = resolveModel(reference);
if (!model) {
	// A ref only a listing can name — what an Ollama daemon happens to serve —
	// is not in the static table yet: ask the providers once, then resolve again.
	await refreshModelCatalog();
	model = resolveModel(reference);
}
if (!model) {
	console.error(`Unknown model reference: ${reference}`);
	console.error(`Known: anthropic/claude-sonnet-5, deepseek/deepseek-flash, ...`);
	process.exit(1);
}

// Keyless models exist now (the local Ollama daemon): `missingApiKey` is the one
// question that covers both, and it names the variable when there is one to set.
const missingKey = missingApiKey(model);
if (missingKey) {
	console.error(`${missingKey.message}\nExample: export ${missingKey.envNames[0]}=...`);
	process.exit(1);
}

console.error(`Streaming from ${model.provider}/${model.id} (${model.api})...`);
const stream = createDefaultStreamFn();
const started = performance.now();

for await (const event of stream(model, {
	systemPrompt: "You are a terse assistant.",
	messages: [userMessage(prompt)],
})) {
	switch (event.type) {
		case "text_delta":
			process.stdout.write(event.delta);
			break;
		case "thinking_delta":
			process.stdout.write(`[think] ${event.delta}`);
			break;
		case "done":
			console.log(
				`\n--- done: stop=${event.message.stopReason} usage=${JSON.stringify(event.message.usage)} ` +
					`${((performance.now() - started) / 1000).toFixed(1)}s`,
			);
			break;
		case "error":
			console.error(`\n--- ERROR: ${event.message.errorMessage}`);
			process.exit(1);
			break;
		default:
			break;
	}
}
