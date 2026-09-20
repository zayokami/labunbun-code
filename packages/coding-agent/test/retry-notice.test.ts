/**
 * What a `-p` run says while it is waiting.
 *
 * Two ends of the same defect. A retry ladder that backs off to thirty seconds
 * a step runs for minutes in silence, so a scripted run that is merely slow and
 * a scripted run that is waiting on a credential which does not exist looked
 * identical from outside: nothing on either stream until it gave up. One of
 * those is worth waiting for and the other never recovers, and the difference
 * now reaches stderr in both cases.
 *
 * Throwaway home, faux provider, no key, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@labunbun/ai";
import { clearCustomModels, clearPricingOverrides, fauxProvider, withRetry } from "@labunbun/ai";
import { runHeadless } from "../src/headless.ts";

/** A key name no environment holds, so the missing-key path is the one taken. */
const ABSENT_KEY_ENV = "LBB_TEST_ABSENT_KEY";

afterEach(() => {
	clearCustomModels();
	clearPricingOverrides();
	delete process.env[ABSENT_KEY_ENV];
});

interface Harness {
	home: string;
	cwd: string;
	settingsPath: string;
}

function makeHarness(settings?: unknown): Harness {
	const home = mkdtempSync(join(tmpdir(), "lbb-retry-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-retry-cwd-"));
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	const settingsPath = join(home, ".labunbun", "settings.json");
	if (settings !== undefined) writeFileSync(settingsPath, JSON.stringify(settings));
	return { home, cwd, settingsPath };
}

/**
 * Run with a throwaway home and both output streams captured, and put all
 * three back. stderr is where a wait belongs — a `-p` run's stdout may be
 * piped somewhere that only wants the answer.
 *
 * `console.error` is patched alongside `process.stderr.write` because the two
 * are not the same writer: the notices a run writes for the user go through
 * console, while the retry line goes straight to the stream, and a test that
 * captured only one of them would half-read the run.
 */
async function runCaptured(
	harness: Harness,
	options: { modelRef: string; streamFn?: StreamFn; prompt?: string },
): Promise<{ code: number; stdout: string; stderr: string; elapsedMs: number }> {
	const out: string[] = [];
	const err: string[] = [];
	const writeOut = process.stdout.write.bind(process.stdout);
	const writeErr = process.stderr.write.bind(process.stderr);
	const consoleErr = console.error;
	const prevHome = process.env.HOME;
	const prevProfile = process.env.USERPROFILE;
	process.stdout.write = ((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		err.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	console.error = (...args: unknown[]) => {
		err.push(`${args.map(String).join(" ")}\n`);
	};
	process.env.HOME = harness.home;
	process.env.USERPROFILE = harness.home;
	const startedAt = Date.now();
	try {
		const code = await runHeadless({
			prompt: options.prompt ?? "hello",
			modelRef: options.modelRef,
			cwd: harness.cwd,
			noSession: true,
			streamFn: options.streamFn,
		});
		return { code, stdout: out.join(""), stderr: err.join(""), elapsedMs: Date.now() - startedAt };
	} finally {
		process.stdout.write = writeOut;
		process.stderr.write = writeErr;
		console.error = consoleErr;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevProfile;
		rmSync(harness.home, { recursive: true, force: true });
		rmSync(harness.cwd, { recursive: true, force: true });
	}
}

describe("headless retry reporting", () => {
	test("a retried request is announced on stderr, and the run still finishes", async () => {
		const harness = makeHarness();
		const faux = fauxProvider([{ text: "recovered" }]);
		let calls = 0;
		const flaky: StreamFn = async function* (model, context, options) {
			calls++;
			if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
			yield* faux.streamFn(model, context, options);
		};

		const { code, stdout, stderr } = await runCaptured(harness, {
			modelRef: "anthropic/claude-haiku-4-5",
			// The wrapper the default stream fn would have built, with the wait
			// taken out: the notice is what is under test, not the backoff.
			streamFn: withRetry(flaky, { baseDelayMs: 1, sleep: async () => {} }),
		});

		expect(code).toBe(0);
		expect(calls).toBe(2);
		expect(stdout).toContain("recovered");
		expect(stderr).toContain("Retrying in 1ms (attempt 1 failed): rate limited");
	});

	// The reported failure mode, end to end over production's own stream fn: a
	// scripted run against a model whose key is not set used to spend the whole
	// ladder — 121.5 seconds of backoff — and then report a network error. The
	// bound is loose on purpose; it is here to catch a return to the ladder,
	// not to measure the machine.
	test("a model with no key fails immediately, and names the variable", async () => {
		// Loopback, and nothing is listening there: with the guard in place no
		// request is attempted at all, and a version of this test that lost the
		// guard can only reach its own machine rather than a real endpoint.
		const harness = makeHarness({
			providers: {
				openaiCompatible: [
					{
						id: "stub",
						baseUrl: "http://127.0.0.1:9/v1",
						apiKeyEnv: ABSENT_KEY_ENV,
						models: [{ id: "m1", contextWindow: 128_000, maxOutputTokens: 8_192 }],
					},
				],
			},
		});
		delete process.env[ABSENT_KEY_ENV];

		const { code, stderr, elapsedMs } = await runCaptured(harness, { modelRef: "stub/m1" });

		expect(code).toBe(1);
		expect(stderr).toContain(`Missing API key for stub: set ${ABSENT_KEY_ENV} in your environment.`);
		expect(elapsedMs).toBeLessThan(5000);
	});
});
