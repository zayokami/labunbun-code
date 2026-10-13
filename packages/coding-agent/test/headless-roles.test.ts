/**
 * `settings.roles` in a `-p` run, and the compaction alias it introduces.
 *
 * A scripted run reads the same settings file as the REPL, so the seats have
 * to mean the same thing here: `roles.main` answers when nothing more explicit
 * did, an illegal reference warns and leaves the built-in default in place,
 * and `roles.compaction.model` is the newer spelling of `settings.compaction.
 * model` — it wins where both are set, and it works alone, without a
 * `settings.compaction` block for the model to hide behind.
 *
 * The runs go through the faux provider against a throwaway home: no network,
 * no key. Compaction is forced with `thresholdPercent` against a registered
 * provider with a modest window, and the summarizer is the observable: which
 * model each request went to is the whole question.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCustomModels, clearPricingOverrides, type FauxStep, fauxProvider, type StreamFn } from "@labunbun/ai";
import { runHeadless } from "../src/headless.ts";

const KEY_VAR = "LBB_ROLEPROV_KEY";
let keyBefore: string | undefined;

beforeEach(() => {
	keyBefore = process.env[KEY_VAR];
	process.env[KEY_VAR] = "test-key";
});

afterEach(() => {
	if (keyBefore === undefined) delete process.env[KEY_VAR];
	else process.env[KEY_VAR] = keyBefore;
	// The registries are process-global, and this file is not their only writer.
	clearCustomModels();
	clearPricingOverrides();
});

interface Harness {
	home: string;
	cwd: string;
	settingsPath: string;
}

function makeHarness(): Harness {
	const home = mkdtempSync(join(tmpdir(), "lbb-roles-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-roles-cwd-"));
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	return { home, cwd, settingsPath: join(home, ".labunbun", "settings.json") };
}

/**
 * The provider both seats can point at: one answers, one summarizes.
 *
 * The 24k window is the calibration, not a preference. The default threshold is
 * `max(window − output − 13k, 0.6·window)` — here `max(10k, 14.4k)` = 14.4k
 * tokens — which sits between what this harness carries before the first turn
 * (`~5k`: system prompt, tool schemas, the user prompt) and after one big Read
 * (`~21k`), so compaction fires exactly once, at a measurably reached moment,
 * with no `thresholdPercent` needed. That matters for the roles-only test: the
 * threshold knobs live under `settings.compaction`, and the case under test is
 * the one where that block does not exist.
 */
function roleProvider() {
	return {
		openaiCompatible: [
			{
				id: "roleprov",
				baseUrl: "https://roleprov.invalid/v1",
				apiKeyEnv: KEY_VAR,
				models: [
					{ id: "main", contextWindow: 24_000, maxOutputTokens: 1_000 },
					{ id: "summarizer", contextWindow: 24_000, maxOutputTokens: 1_000 },
				],
			},
		],
	};
}

interface RunResult {
	code: number;
	stdout: string;
	/** What console.error printed — bun's console bypasses process.stderr.write. */
	errors: string[];
	/** The model id of each request, in order. */
	requests: string[];
}

async function runCaptured(
	harness: Harness,
	options: { modelRef?: string; steps: FauxStep[]; prompt?: string },
): Promise<RunResult> {
	const requests: string[] = [];
	const faux = fauxProvider(options.steps);
	const streamFn: StreamFn = async function* (model, context, streamOptions) {
		requests.push(model.id);
		yield* faux.streamFn(model, context, streamOptions);
	};
	const chunks: string[] = [];
	const errors: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	const errWrite = console.error.bind(console);
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	};
	try {
		const code = await runHeadless({
			prompt: options.prompt ?? "hello",
			modelRef: options.modelRef,
			cwd: harness.cwd,
			noSession: true,
			outputFormat: "json",
			streamFn,
			home: harness.home,
		});
		return { code, stdout: chunks.join(""), errors, requests };
	} finally {
		process.stdout.write = write;
		console.error = errWrite;
		rmSync(harness.home, { recursive: true, force: true });
		rmSync(harness.cwd, { recursive: true, force: true });
	}
}

describe("settings.roles in a -p run", () => {
	test("roles.main answers when neither the flag nor settings.model did", async () => {
		const harness = makeHarness();
		writeFileSync(
			harness.settingsPath,
			JSON.stringify({ modelDiscovery: false, providers: roleProvider(), roles: { main: { model: "roleprov/main" } } }),
		);

		const result = await runCaptured(harness, { steps: [{ text: "done" }] });

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).result).toBe("done");
		expect(result.requests).toEqual(["main"]);
	});

	test("an unknown roles.main warns and the built-in default answers", async () => {
		const harness = makeHarness();
		// No providers, no key, no network (modelDiscovery: false): the fail-soft
		// path through to the built-in default, said out loud.
		writeFileSync(
			harness.settingsPath,
			JSON.stringify({ modelDiscovery: false, roles: { main: { model: "no-such-model" } } }),
		);

		const result = await runCaptured(harness, { steps: [{ text: "done" }] });

		expect(result.code).toBe(0);
		expect(result.errors).toContainEqual(
			'Warning: unknown model "no-such-model" for roles.main — the built-in default model will be used.',
		);
		expect(result.requests).toEqual(["claude-sonnet-5"]);
	});

	test("an entry with a provider but no model warns and is ignored", async () => {
		const harness = makeHarness();
		writeFileSync(
			harness.settingsPath,
			JSON.stringify({ modelDiscovery: false, roles: { main: { provider: "roleprov" } } }),
		);

		const result = await runCaptured(harness, { steps: [{ text: "done" }] });

		expect(result.code).toBe(0);
		expect(result.errors).toContainEqual(
			"Warning: roles.main sets no model (only a provider) — ignored; the built-in default model will be used.",
		);
		expect(result.requests).toEqual(["claude-sonnet-5"]);
	});
});

/**
 * The compaction alias, run for real: one tool result big enough to cross the
 * 24k window's default threshold, one summary, one resumed turn — and the
 * model each of those requests went to. `[main, summarizer, main]` says the
 * middle request was a summary written by the summarizer seat; a run where the
 * seat was ignored reads `[main, main, main]`, because the manager falls back
 * to the session's model.
 */
function compactingScenario(harness: Harness, roles: unknown, compaction: unknown) {
	writeFileSync(
		harness.settingsPath,
		JSON.stringify({
			modelDiscovery: false,
			// No cheap rung: the test is about the summarization it would otherwise
			// have replaced the tool result with.
			trimOldToolResults: false,
			providers: roleProvider(),
			...(roles === undefined ? {} : { roles }),
			...(compaction === undefined ? {} : { compaction }),
		}),
	);
	// 600 lines of 100 characters: ~15k tokens of tool result, one complete Read.
	writeFileSync(join(harness.cwd, "big.txt"), Array.from({ length: 600 }, () => "x".repeat(100)).join("\n"));
	return runCaptured(harness, {
		modelRef: "roleprov/main",
		steps: [
			{ toolCalls: [{ name: "Read", arguments: { file_path: join(harness.cwd, "big.txt") } }] },
			{ text: "<summary>Primary Request: read the file. Next Step: done.</summary>" },
			{ text: "done" },
		],
	});
}

describe("the compaction seat", () => {
	test("roles.compaction.model alone is the summarizer — no settings.compaction needed", async () => {
		const harness = makeHarness();

		const result = await compactingScenario(harness, { compaction: { model: "roleprov/summarizer" } }, undefined);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).result).toBe("done");
		// The middle request is the summary: the seat answered, not the session
		// model — which is the difference a tuning struct built only for the old
		// key would have erased.
		expect(result.requests).toEqual(["main", "summarizer", "main"]);
	});

	test("roles.compaction.model wins over settings.compaction.model", async () => {
		const harness = makeHarness();

		// The old key names the session model: with the precedence reversed, the
		// summary would go to `main` and the sequence below would read so.
		const result = await compactingScenario(
			harness,
			{ compaction: { model: "roleprov/summarizer" } },
			{ model: "roleprov/main" },
		);

		expect(result.code).toBe(0);
		expect(result.requests).toEqual(["main", "summarizer", "main"]);
	});

	test("settings.compaction.model alone keeps working, exactly as before roles", async () => {
		const harness = makeHarness();

		const result = await compactingScenario(harness, undefined, { model: "roleprov/summarizer" });

		expect(result.code).toBe(0);
		expect(result.requests).toEqual(["main", "summarizer", "main"]);
	});
});

/**
 * The subagent booking, end to end: a `-p` run that fans out must bill what
 * its subagent spent. The subagent's conversation never enters the transcript
 * `cost_usd` is computed from, so before the booking existed this run would
 * report $0 for the one paid request it made. The light seat is the subagent's
 * model here, which puts the seat's name on the booking's middle request.
 */
describe("subagent spend in a -p run", () => {
	test("the subagent's spend is included in cost_usd and named in subagent_cost_usd", async () => {
		const harness = makeHarness();
		writeFileSync(
			harness.settingsPath,
			JSON.stringify({
				modelDiscovery: false,
				providers: roleProvider(),
				roles: { light: { model: "roleprov/summarizer" } },
				// $1/$1 per Mtok on both rows, so the arithmetic below is nothing
				// but the recorded usage times a price the settings file names.
				pricing: {
					"roleprov/main": { input: 1, output: 1 },
					"roleprov/summarizer": { input: 1, output: 1 },
				},
			}),
		);

		const result = await runCaptured(harness, {
			modelRef: "roleprov/main",
			steps: [
				{
					toolCalls: [{ name: "Task", arguments: { description: "read the file", prompt: "read big.txt and report" } }],
				},
				{ text: "sub report", usage: { input: 1_000_000, output: 1_000_000 } },
				{ text: "done" },
			],
		});

		expect(result.code).toBe(0);
		// The middle request went to the light seat — the subagent's own model —
		// and its usage is the only spend in this run.
		expect(result.requests).toEqual(["main", "summarizer", "main"]);
		const json = JSON.parse(result.stdout);
		expect(json.subagent_cost_usd).toBeCloseTo(2, 10);
		// And the bill includes it rather than reporting it twice or not at all:
		// the session's own turns carried no usage.
		expect(json.cost_usd).toBeCloseTo(2, 10);
		expect(json.result).toBe("done");
	});
});
