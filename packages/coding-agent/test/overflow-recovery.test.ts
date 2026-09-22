/**
 * The end of the failure chain this batch exists to break: a provider refuses a
 * request for size, and the session makes room and sends it again instead of
 * failing identically forever.
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
		// The status row's word for a compaction in flight, recorded as the changes
		// it went through: the store is written on every event the app reports, and
		// only a *change* is a thing someone looking at the screen could have seen.
		const activity = [];
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
				let shown = state.contextActivity;
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
					store: { set(update) {
						state = typeof update === "function" ? update(state) : { ...state, ...update };
						if (state.contextActivity !== shown) { activity.push(state.contextActivity); shown = state.contextActivity; }
					} },
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
		console.log(JSON.stringify({ exitCode, requests, written, replies, counts, infos, activity }));
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
			// "cleared" crosses the process boundary as null: the field is set back
			// to undefined, which JSON has no word for.
			activity: (string | null)[];
		}),
		stderr,
	};
}

describe("recovering from a refusal for size", () => {
	test("the refused prompt is compacted and sent again, without being asked twice", async () => {
		const { requests, replies, counts, infos, activity } = await run(
			JSON.stringify([
				{ overflow: "prompt is too long: 250000 tokens > 200000 maximum" },
				{ text: "<summary>1. Primary Request: keep going</summary>" },
				{ text: "recovered answer" },
				{ text: "second answer" },
			]),
		);

		// The prompt is refused for size — with the provider's refusal, not a
		// fabricated success — and one prompt later it has been answered: the
		// summarization the refusal forced, then the prompt carrying the compacted
		// history. The refusal itself cost exactly one call: the retry policy
		// recognizes it instead of sending the request again.
		expect(replies[0]).toBe("completed");
		expect(requests[1]?.messages.at(-1)?.content).toContain("You are summarizing");
		const recovered = requests[2]?.messages ?? [];
		expect(JSON.stringify(recovered)).toContain("Conversation compacted");
		expect(JSON.stringify(recovered)).toContain("keep going");
		// Both prompts are answered, three calls for the first and one for the rest.
		expect(replies[1]).toBe("completed");
		expect(counts).toEqual([3, 4]);

		// The wait had a name while it lasted, and the transcript kept the line
		// that outlives it: a summary is a full-prefix call the user is paying for
		// and cannot otherwise see. The row is the app's, not the manager's — the
		// phase is routed through the interactive handle's store — and it is set
		// back the moment the summary lands.
		expect(activity).toEqual(["Compacting context…", null]);
		expect(
			infos.filter((info) => /^Context compacted \(overflow\): [\d.]+k → [\d.]+k tokens\.$/.test(info)),
		).toHaveLength(1);
	});

	test("a vetoing PreCompact hook cannot send the request it just refused", async () => {
		// A hook may defer compaction the estimate asked for. It may not defer one
		// the provider already refused: sending again changes nothing, and the
		// session would fail identically on every later turn.
		const { requests, replies, activity } = await run(
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
		// And the status row never claimed a summary was running, because none was:
		// the veto is answered before the manager is asked anything at all.
		expect(activity).toEqual([]);
	});

	test("the breaker announces itself once, and only when it trips", async () => {
		// Silent, a tripped breaker looks like a session that simply stopped
		// managing its context — until the request that cannot be sent arrives,
		// long after the failures that caused it. The user gets one notice, at the
		// moment it happens, and not again on every turn.
		const failure = { overflow: "internal error while summarizing" };
		const { infos, requests, replies, activity } = await run(
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
		// Every attempt said it had started and then said it had failed, in that
		// order: a row that kept spinning after the failure would be the one lie
		// this reporting must not tell, because the spinner is the only thing on
		// screen while it is up.
		expect(infos.filter((info) => info.startsWith("Compaction failed (auto):"))).toHaveLength(3);
		expect(activity).toEqual(["Compacting context…", null, "Compacting context…", null, "Compacting context…", null]);
		// The turns themselves still ran: a compaction that fails is a loss of
		// headroom, not a broken session, as long as the request still fits.
		expect(replies).toEqual(["completed", "completed", "completed", "completed", "completed"]);
	});
});
