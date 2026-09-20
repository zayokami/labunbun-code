/**
 * The context indicator, measured on the real app.
 *
 * It exists to answer one question — how much room is left before this session
 * changes shape — and for a long time it answered a different one, about the
 * transcript alone, against the raw window. A session with a large toolset
 * carries thousands of tokens before the user types anything, so that reading
 * called a session nearly empty right up until the moment it did not.
 *
 * Run through `runInteractive` with the provider scripted: the number asserted
 * here is the number the app publishes to its own status row.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactionThreshold } from "@labunbun/agent";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Reported {
	usedTokens: number;
	threshold: number;
}

interface Sent {
	systemPrompt: number;
	schemaChars: number;
	messageChars: number;
}

/** One scripted reply: the text, and what the provider reports it cost. */
interface Step {
	text: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Scripted replies, one per model call, and the prompts that provoke them. The
 * model is a 200k-window entry in an isolated settings file, so both the
 * threshold and the answer are the app's own arithmetic.
 */
async function run(options: { writeSettings?: (home: string) => void; steps?: Step[]; prompts?: string[] } = {}) {
	const steps = options.steps ?? [{ text: "noted" }];
	const prompts = options.prompts ?? ["hello"];
	const home = mkdtempSync(join(tmpdir(), "lbb-context-"));
	roots.push(home);
	options.writeSettings?.(home);
	// The project is a directory inside the isolated home, not the home itself:
	// settings written for the user tier must not be read back as project-tier
	// ones, which are denied the keys that choose a model.
	const cwd = join(home, "project");
	mkdirSync(cwd, { recursive: true });

	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const requests = [];
		const reported = [];
		const infos = [];
		const replies = [];
		const steps = ${JSON.stringify(steps)};
		const prompts = ${JSON.stringify(prompts)};
		let call = 0;
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			createDefaultStreamFn: () => async function* (model, context) {
				// What the model is actually sent: the indicator is meant to count
				// this, so the test measures it from the request itself.
				requests.push({
					systemPrompt: context.systemPrompt.length,
					schemaChars: context.tools?.length ? JSON.stringify(context.tools).length : 0,
					messageChars: JSON.stringify(context.messages).length,
				});
				const step = steps[Math.min(call++, steps.length - 1)];
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				yield builder.textStart(0);
				yield builder.textDelta(0, step.text);
				yield builder.textEnd(0);
				yield builder.done("stop", step.usage);
			}
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: ({ session }) => {
				let state = { entries: [] };
				return {
					setTasks() {}, setBackgroundShells() {}, setStatusCard() {},
					setContextInfo(info) { reported.push(info); },
					store: { set(update) { state = typeof update === "function" ? update(state) : { ...state, ...update }; } },
					waitUntilExit: async () => {
						// Only what each turn added: the entries accumulate, and a warning
						// counted twice from two readings is not two warnings.
						let seen = 0;
						for (const prompt of prompts) {
							replies.push(await session.prompt(prompt));
							const all = state.entries.filter((e) => e.kind === "info").map((e) => e.text);
							infos.push(...all.slice(seen));
							seen = all.length;
						}
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const exitCode = await runInteractive({ cwd: ${JSON.stringify(cwd)}, theme: "dark" });
		console.log(JSON.stringify({ exitCode, requests, reported, infos, replies }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: home, USERPROFILE: home },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout.trim()) as {
		exitCode: number;
		requests: Sent[];
		reported: Reported[];
		infos: string[];
		replies: string[];
	};
}

/** The 200k-window model the scripted runs select, in an isolated settings file. */
function writeSettings(home: string): void {
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(
		join(home, ".labunbun", "settings.json"),
		JSON.stringify({
			model: "test/small",
			providers: {
				openaiCompatible: [
					{
						id: "test",
						baseUrl: "https://example.invalid/v1",
						apiKeyEnv: "TEST_KEY",
						models: [{ id: "small", contextWindow: 200_000, maxOutputTokens: 8_192 }],
					},
				],
			},
		}),
	);
}

const withSettings = () => run({ writeSettings });

describe("the context indicator", () => {
	test("counts the system prompt and the tool schemas, not only the transcript", async () => {
		const { requests, reported } = await withSettings();

		const sent = requests[0];
		expect(sent).toBeDefined();
		// A real toolset is not a rounding error: this is the difference between an
		// indicator that reads "empty" and one that reads "a few thousand tokens".
		expect(sent?.systemPrompt ?? 0).toBeGreaterThan(1_000);
		expect(sent?.schemaChars ?? 0).toBeGreaterThan(10_000);

		const last = reported.at(-1);
		expect(last?.usedTokens ?? 0).toBeGreaterThanOrEqual(
			Math.ceil((sent?.systemPrompt ?? 0) / 4) + Math.ceil((sent?.schemaChars ?? 0) / 3),
		);
		// And it is measured against the point where the session compacts, not
		// against the window: the two differ by the output reserve.
		expect(last?.threshold).toBe(compactionThreshold({ contextWindow: 200_000, maxOutputTokens: 8_192 }));
	});

	test("is published before the first turn, not only after one", async () => {
		// A session that has not spoken yet still has a system prompt and a
		// toolset, and the idle line is where the user reads them.
		const { reported } = await withSettings();
		expect(reported.length).toBeGreaterThan(1);
		expect(reported[0]?.usedTokens).toBeGreaterThan(0);
	});
});

/** The window this run selects: 200k, so the warning line is 80% of 178,808. */
const WARN_LINE_TOKENS = compactionThreshold({ contextWindow: 200_000, maxOutputTokens: 8_192 }) * 0.8;

/** A reply that leaves the context far past the warning line but under it. */
const nearFull = { input: 150_000, output: 10, cacheRead: 0, cacheWrite: 0 };

const warnings = (infos: string[]) => infos.filter((info) => info.startsWith("Context is "));

describe("the low-context warning", () => {
	test("fires once when the context crosses the line, not once per turn", async () => {
		expect(WARN_LINE_TOKENS).toBeLessThan(150_000);
		const { infos, replies } = await run({
			writeSettings,
			steps: [
				{ text: "first answer", usage: nearFull },
				{ text: "second answer", usage: nearFull },
			],
			prompts: ["one", "two"],
		});

		// Both turns ran, both were far past the line, and the user was told once:
		// a warning repeated every turn is a warning nobody reads.
		expect(replies).toEqual(["completed", "completed"]);
		expect(warnings(infos)).toHaveLength(1);
		expect(warnings(infos)[0]).toContain("/trim");
	});

	test("arms again after the context drops back below the line", async () => {
		// The point of an edge is that the next crossing is news too: a session
		// that compacts or trims and then grows again is a session where the same
		// advice is worth repeating.
		const { infos } = await run({
			writeSettings,
			steps: [
				{ text: "first answer", usage: nearFull },
				{ text: "small answer", usage: { input: 1_000, output: 10, cacheRead: 0, cacheWrite: 0 } },
				{ text: "third answer", usage: nearFull },
			],
			prompts: ["one", "two", "three"],
		});
		expect(warnings(infos)).toHaveLength(2);
	});

	test("a comfortable session is never warned about", async () => {
		const { infos } = await withSettings();
		expect(warnings(infos)).toEqual([]);
	});
});
