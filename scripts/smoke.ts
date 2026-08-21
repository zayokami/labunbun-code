#!/usr/bin/env bun
/**
 * Live smoke test: stream one prompt from a real provider.
 *
 * Usage: bun run scripts/smoke.ts <provider/model> ["prompt"]
 * Requires the provider's API key in its environment variable
 * (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, ...).
 */
import { createDefaultStreamFn, resolveModel, userMessage } from "../packages/ai/src/index.ts";

const reference = process.argv[2];
if (!reference) {
	console.error("Usage: bun run scripts/smoke.ts <provider/model> [prompt]");
	process.exit(1);
}
const prompt = process.argv[3] ?? "Reply with exactly: smoke ok";

const model = resolveModel(reference);
if (!model) {
	console.error(`Unknown model reference: ${reference}`);
	console.error(`Known: anthropic/claude-sonnet-5, deepseek/deepseek-chat, ...`);
	process.exit(1);
}

const key = process.env[model.apiKeyEnv];
if (!key) {
	console.error(`Missing API key: set ${model.apiKeyEnv}`);
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
