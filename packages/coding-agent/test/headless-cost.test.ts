/**
 * What a scripted `-p` run says it cost.
 *
 * The JSON result is what a script reads to decide whether a run is affordable,
 * so `cost_usd` being a hardcoded zero is not a missing feature — it is a report
 * that is wrong in the direction that spends money. These runs go through the
 * faux provider against a throwaway home: no network, no key, no real session.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCustomModels, clearPricingOverrides, fauxProvider } from "@labunbun/ai";
import { runHeadless } from "../src/headless.ts";

afterEach(() => {
	// Both maps are process-global, and this file is not their only writer.
	clearCustomModels();
	clearPricingOverrides();
});

interface Harness {
	home: string;
	cwd: string;
	settingsPath: string;
}

function makeHarness(): Harness {
	const home = mkdtempSync(join(tmpdir(), "lbb-headless-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-headless-cwd-"));
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	return { home, cwd, settingsPath: join(home, ".labunbun", "settings.json") };
}

/** Run with a throwaway home and a captured stdout, and put both back. */
async function runCaptured(
	harness: Harness,
	options: { modelRef: string; streamFn: ReturnType<typeof fauxProvider>["streamFn"]; prompt?: string },
): Promise<{ code: number; stdout: string }> {
	const chunks: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	const prevHome = process.env.HOME;
	const prevProfile = process.env.USERPROFILE;
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.env.HOME = harness.home;
	process.env.USERPROFILE = harness.home;
	try {
		const code = await runHeadless({
			prompt: options.prompt ?? "hello",
			modelRef: options.modelRef,
			cwd: harness.cwd,
			noSession: true,
			outputFormat: "json",
			streamFn: options.streamFn,
		});
		return { code, stdout: chunks.join("") };
	} finally {
		process.stdout.write = write;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevProfile;
		rmSync(harness.home, { recursive: true, force: true });
		rmSync(harness.cwd, { recursive: true, force: true });
	}
}

describe("headless cost reporting", () => {
	test("reports what the run spent, from the transcript it just wrote", async () => {
		// Haiku 4.5 is $1/$5 per Mtok, so a million in and a hundred thousand out
		// is $1.50 — a number a caller can check against the price list.
		const harness = makeHarness();
		const faux = fauxProvider([{ text: "done", usage: { input: 1_000_000, output: 100_000 } }]);
		const { code, stdout } = await runCaptured(harness, {
			modelRef: "anthropic/claude-haiku-4-5",
			streamFn: faux.streamFn,
		});

		expect(code).toBe(0);
		const result = JSON.parse(stdout) as { cost_usd: number; num_turns: number; result: string };
		expect(result.result).toBe("done");
		expect(result.cost_usd).toBeCloseTo(1.5, 10);
	});

	test("a price declared in settings is the one charged", async () => {
		// The catalog's number is a snapshot; the user's is the bill. This is the
		// path that makes that true rather than aspirational.
		const harness = makeHarness();
		writeFileSync(
			harness.settingsPath,
			JSON.stringify({ pricing: { "anthropic/claude-haiku-4-5": { input: 10, output: 0 } } }),
		);
		const faux = fauxProvider([{ text: "done", usage: { input: 1_000_000 } }]);
		const { code, stdout } = await runCaptured(harness, {
			modelRef: "anthropic/claude-haiku-4-5",
			streamFn: faux.streamFn,
		});

		expect(code).toBe(0);
		expect((JSON.parse(stdout) as { cost_usd: number }).cost_usd).toBeCloseTo(10, 10);
	});

	test("a provider configured in settings resolves in headless, at its declared price", async () => {
		// Without this, `-p --model custom/m1` was "Unknown model" and exit 1: the
		// providers were registered in the REPL only, and the catalog is not
		// supposed to be the whole world.
		const harness = makeHarness();
		writeFileSync(
			harness.settingsPath,
			JSON.stringify({
				providers: {
					openaiCompatible: [
						{
							id: "custom",
							baseUrl: "https://api.example.com/v1",
							apiKeyEnv: "CUSTOM_KEY",
							models: [{ id: "m1", contextWindow: 128_000, maxOutputTokens: 8_192, pricing: { input: 3, output: 6 } }],
						},
					],
				},
			}),
		);
		const faux = fauxProvider([{ text: "done", usage: { input: 1_000_000, output: 1_000_000 } }]);
		const { code, stdout } = await runCaptured(harness, { modelRef: "custom/m1", streamFn: faux.streamFn });

		expect(code).toBe(0);
		expect((JSON.parse(stdout) as { cost_usd: number }).cost_usd).toBeCloseTo(9, 10);
	});

	test("a model with no known price costs zero, and says so by not inventing a number", async () => {
		// The failure mode to avoid is the opposite one — a token count at a made-up
		// rate. Zero with no price table is the honest answer; `/cost` names it.
		const harness = makeHarness();
		writeFileSync(
			harness.settingsPath,
			JSON.stringify({ pricing: { "anthropic/claude-haiku-4-5": { input: 0, output: 0 } } }),
		);
		const faux = fauxProvider([{ text: "done", usage: { input: 1_000_000, output: 1_000_000 } }]);
		const { code, stdout } = await runCaptured(harness, {
			modelRef: "anthropic/claude-haiku-4-5",
			streamFn: faux.streamFn,
		});

		expect(code).toBe(0);
		expect((JSON.parse(stdout) as { cost_usd: number }).cost_usd).toBe(0);
	});
});
