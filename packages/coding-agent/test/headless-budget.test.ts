/**
 * The budget gate in a `-p` run: a conversation that was already billed is
 * refused before the first request of the run that continues it.
 *
 * A resumed session's spend lives in its transcript — every assistant message
 * records usage, and the gate re-costs those records against the catalog's
 * prices — so a seat whose `roles.main.budgetUSD` sits below what the
 * conversation already spent must refuse before any new request exists. These
 * tests drive that across two real runs: the first accrues the spend on the
 * seat's own real-priced model (Haiku 4.5, $1/$5 per Mtok — $2.50 for the turn
 * scripted below), the second resumes it with a transport that would record
 * any call. "Not a single request" is asserted where it can be counted, per
 * model id, rather than inferred from the ending.
 *
 * The seeded spend is booked in output tokens on purpose. The context estimate
 * reads the prompt side of a usage record (input, cache read, cache write), so
 * a million-token prompt would present as a million-token conversation and
 * send the resumed run into auto-compaction — a summary request that has
 * nothing to do with the budget and would drown the count this file is about.
 * A long answer is spend without being context.
 *
 * Nothing is sent and nothing is billed: the transport is scripted, and the
 * one key involved is a value set in this process's environment so the role
 * resolves at all — `resolveRoles` drops a seat whose key the environment
 * does not hold, and a dropped seat is a test about nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { type FauxStep, fauxProvider, type StreamFn } from "@labunbun/ai";
import { runHeadless } from "../src/headless.ts";

/** Haiku 4.5's catalog price source: the seat has to be real-priced for a real total. */
const MODEL = "anthropic/claude-haiku-4-5";
const KEY_VAR = "ANTHROPIC_API_KEY";
let keyBefore: string | undefined;

beforeEach(() => {
	keyBefore = process.env[KEY_VAR];
	process.env[KEY_VAR] = "test-key";
});

afterEach(() => {
	if (keyBefore === undefined) delete process.env[KEY_VAR];
	else process.env[KEY_VAR] = keyBefore;
});

interface Harness {
	home: string;
	cwd: string;
	settingsPath: string;
}

const roots: string[] = [];

function makeHarness(): Harness {
	const home = mkdtempSync(join(tmpdir(), "lbb-budget-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-budget-cwd-"));
	roots.push(home, cwd);
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	return { home, cwd, settingsPath: join(home, ".labunbun", "settings.json") };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface RunResult {
	code: number;
	stdout: string;
	/** What console.error printed — bun's console bypasses process.stderr.write. */
	errors: string[];
	/** The model id of each request, in order. Empty means nothing was sent. */
	requests: string[];
}

/**
 * Run with a throwaway home and both output streams captured, and put the
 * streams back afterwards. The first run's spend lands in the home if
 * `noSession` is false; the second run reads it back through `resumeSessionId`.
 */
async function runCaptured(
	harness: Harness,
	options: { steps: FauxStep[]; format?: "text" | "json"; noSession?: boolean; resumeSessionId?: string },
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
			prompt: "hello",
			cwd: harness.cwd,
			noSession: options.noSession,
			resumeSessionId: options.resumeSessionId,
			outputFormat: options.format ?? "json",
			streamFn,
			home: harness.home,
		});
		return { code, stdout: chunks.join(""), errors, requests };
	} finally {
		process.stdout.write = write;
		console.error = errWrite;
	}
}

/** One run's scenario: the seat's ceiling, and the session the first run leaves behind. */
async function spentSession(harness: Harness, budgetUSD: number): Promise<string> {
	writeFileSync(
		harness.settingsPath,
		JSON.stringify({ modelDiscovery: false, roles: { main: { model: MODEL, budgetUSD } } }),
	);
	const first = await runCaptured(harness, {
		// Half a million output tokens at $5 per Mtok: $2.50, a number a caller
		// can check against the price list — and a spend the context does not
		// read (see the header).
		steps: [{ text: "done", usage: { output: 500_000 } }],
		noSession: false,
	});
	expect(first.code, first.errors.join("\n")).toBe(0);
	expect(first.requests).toEqual(["claude-haiku-4-5"]);
	expect((JSON.parse(first.stdout) as { cost_usd: number }).cost_usd).toBeCloseTo(2.5, 10);
	const [session] = SessionStore.listSessions(harness.cwd, harness.home);
	expect(session).toBeDefined();
	return session?.sessionId ?? "";
}

describe("a `-p` run resumed past its seat's budget", () => {
	test("sends nothing, and says the run was an error", async () => {
		const harness = makeHarness();
		const sessionId = await spentSession(harness, 0.5);

		const second = await runCaptured(harness, {
			steps: [{ text: "should not run" }],
			resumeSessionId: sessionId,
		});

		// The refusal precedes the request: no model was called, not even for a
		// summary — the check runs before the compaction decision.
		expect(second.requests).toEqual([]);
		expect(second.code).toBe(1);
		const result = JSON.parse(second.stdout) as { subtype: string; num_turns: number; cost_usd: number };
		expect(result.subtype).toBe("error_during_execution");
		expect(result.num_turns).toBe(0);
		// The report still carries what the conversation spent: the gate refuses
		// further spending, it does not forget the bill.
		expect(result.cost_usd).toBeCloseTo(2.5, 10);
	});

	test("names the spend, the ceiling and the setting to raise", async () => {
		const harness = makeHarness();
		const sessionId = await spentSession(harness, 0.5);

		const second = await runCaptured(harness, {
			steps: [{ text: "should not run" }],
			resumeSessionId: sessionId,
			format: "text",
		});

		expect(second.requests).toEqual([]);
		expect(second.code).toBe(1);
		// The whole sentence, exactly: how much, against which ceiling, and which
		// setting edits it — a script's stderr is the only surface this run has.
		expect(second.errors.join("\n")).toContain(
			"[session ended: error — Budget reached: $2.5000 spent of the $0.5000 budget for roles.main. " +
				"Raise roles.main.budgetUSD or switch models.]",
		);
	});

	test("a ceiling above what was spent is not a refusal", async () => {
		// The negative control, through the same two-run machinery: three dollars
		// against the $2.50 already on the transcript lets the run answer — and
		// the answer's own spend then lands on top of the historical one.
		const harness = makeHarness();
		const sessionId = await spentSession(harness, 3);

		const second = await runCaptured(harness, {
			steps: [{ text: "answered", usage: { input: 100_000, output: 20_000 } }],
			resumeSessionId: sessionId,
		});

		expect(second.requests).toEqual(["claude-haiku-4-5"]);
		expect(second.code).toBe(0);
		const result = JSON.parse(second.stdout) as { subtype: string; cost_usd: number; result: string };
		expect(result.subtype).toBe("success");
		expect(result.result).toBe("answered");
		// $2.50 resumed plus $0.10 in and $0.10 out for the new turn.
		expect(result.cost_usd).toBeCloseTo(2.7, 10);
	});
});
