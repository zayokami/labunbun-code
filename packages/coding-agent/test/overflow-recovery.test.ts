/**
 * The end of the failure chain this batch exists to break: a provider refuses a
 * request for size, and the session recovers on the next turn instead of failing
 * identically forever.
 *
 * Run through the real `runInteractive`, so what is asserted is the wiring the
 * app has — not a hand-built session that only resembles it. The default stream
 * function is scripted per call, which is the only way to be the provider here:
 * zero network, no real credential, nothing billed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_DISABLED_NOTICE } from "@labunbun/agent";
import type { AgentMessage } from "@labunbun/ai";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Script steps are consumed one per model call, in order. `writeSettings` drops a
 * user settings file into the isolated home; the app reads hooks from there.
 */
async function run(steps: string, options: { writeSettings?: (home: string) => void; prompts?: string[] } = {}) {
	const home = mkdtempSync(join(tmpdir(), "lbb-overflow-"));
	roots.push(home);
	options.writeSettings?.(home);
	const cwd = home;

	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const requests = [];
		const written = [];
		const replies = [];
		const counts = [];
		let infos = [];
		const steps = ${steps};
		let call = 0;
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			// The real default is the adapters wrapped in the retry policy, so the
			// mock stays a mock of the *transport* only: an oversized request throws
			// the way a 400 does, and everything from classification onwards is the
			// production path.
			createDefaultStreamFn: () => ai.withRetry(async function* (model, context) {
				requests.push({ messages: structuredClone(context.messages), model: model.id });
				const step = steps[Math.min(call++, steps.length - 1)];
				if (step.overflow) {
					throw Object.assign(new Error(step.overflow), { status: 400 });
				}
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				// Real deltas: the summarizer accumulates the summary from text_delta
				// events, so a mock that only emits the terminal message would look
				// like an empty summary and fail the compaction for the wrong reason.
				yield builder.textStart(0);
				yield builder.textDelta(0, step.text);
				yield builder.textEnd(0);
				yield builder.done("stop", step.usage);
			}, { baseDelayMs: 1 })
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: ({ session }) => {
				// The app speaks to the user by pushing entries through the handle's
				// store, so this is where a user-visible notice can be observed.
				let state = { entries: [] };
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
					store: { set(update) { state = typeof update === "function" ? update(state) : { ...state, ...update }; } },
					waitUntilExit: async () => {
						for (const text of ${JSON.stringify(options.prompts ?? ["new question", "and again"])}) {
							replies.push(await session.prompt(text));
							counts.push(requests.length);
						}
						infos = state.entries.filter((entry) => entry.kind === "info").map((entry) => entry.text);
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const exitCode = await runInteractive(${JSON.stringify({ cwd, theme: "dark" })});
		console.log(JSON.stringify({ exitCode, requests, written, replies, counts, infos }));
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
	return {
		...(JSON.parse(stdout.trim()) as {
			exitCode: number;
			requests: { messages: AgentMessage[]; model: string }[];
			replies: string[];
			counts: number[];
			infos: string[];
		}),
		stderr,
	};
}

describe("recovering from a refusal for size", () => {
	test("the next turn compacts and sends, instead of failing the same way again", async () => {
		const { requests, replies, counts } = await run(
			JSON.stringify([
				{ overflow: "prompt is too long: 250000 tokens > 200000 maximum" },
				{ text: "<summary>1. Primary Request: keep going</summary>" },
				{ text: "recovered answer" },
				{ text: "second answer" },
			]),
		);

		// The first prompt fails for size — with the provider's refusal, not a
		// fabricated success — and it costs exactly one call: the retry policy
		// recognizes the refusal instead of sending the request again.
		expect(replies[0]).toBe("error");
		// The second turn is the recovery, in two calls: a summarization of what
		// cannot be sent, then the prompt carrying the compacted history. Without the
		// forced check the second prompt would have been the same oversized request
		// again, and every later prompt would fail identically.
		expect(counts).toEqual([1, 3]);
		expect(requests[1]?.messages.at(-1)?.content).toContain("You are summarizing");
		const recovered = requests[2]?.messages ?? [];
		expect(JSON.stringify(recovered)).toContain("Conversation compacted");
		expect(JSON.stringify(recovered)).toContain("keep going");
		expect(replies[1]).toBe("completed");
	});

	test("a vetoing PreCompact hook cannot send the request it just refused", async () => {
		// A hook may defer compaction the estimate asked for. It may not defer one
		// the provider already refused: sending again changes nothing, and the
		// session would fail identically on every later turn.
		const { requests, replies } = await run(
			JSON.stringify([{ overflow: "prompt is too long: 250000 tokens > 200000 maximum" }, { text: "unused" }]),
			{
				writeSettings: (home) => {
					mkdirSync(join(home, ".labunbun"), { recursive: true });
					writeFileSync(
						join(home, ".labunbun", "settings.json"),
						JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: "exit 1" }] }] } }),
					);
				},
			},
		);

		expect(replies[0]).toBe("error");
		expect(replies[1]).toBe("error");
		// One call total: the prompt that was refused. The veto stops the
		// summarization before it is sent, and the refused prompt is not sent again
		// — sending it unchanged is the failure, not the recovery.
		expect(requests).toHaveLength(1);
	});

	test("the breaker announces itself once, and only when it trips", async () => {
		// Silent, a tripped breaker looks like a session that simply stopped
		// managing its context — until the request that cannot be sent arrives,
		// long after the failures that caused it. The user gets one notice, at the
		// moment it happens, and not again on every turn.
		const failure = { overflow: "internal error while summarizing" };
		const { infos, requests, replies } = await run(
			JSON.stringify([
				// A reply big enough that the next turn's estimate crosses the
				// compaction threshold (window 200k → threshold 178,808).
				{ text: "first answer", usage: { input: 185_000, output: 10 } },
				failure,
				{ text: "second answer" },
				failure,
				{ text: "third answer" },
				failure,
				{ text: "fourth answer" },
				{ text: "fifth answer" },
			]),
			{
				writeSettings: (home) => {
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
				},
				prompts: ["one", "two", "three", "four", "five"],
			},
		);

		const summarized = requests.filter((r) => JSON.stringify(r.messages).includes("You are summarizing"));
		// Three attempts, three failures — the count the breaker counts to.
		expect(summarized).toHaveLength(3);
		expect(infos.filter((info) => info === COMPACTION_DISABLED_NOTICE)).toHaveLength(1);
		// The turns themselves still ran: a compaction that fails is a loss of
		// headroom, not a broken session, as long as the request still fits.
		expect(replies).toEqual(["completed", "completed", "completed", "completed", "completed"]);
	});
});
