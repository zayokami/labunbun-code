/**
 * What the app says to the user about a compaction it ran on request.
 *
 * The automatic path is covered in `overflow-recovery.test.ts`, which is about
 * making room after a refusal. This file is about the other caller — `/compact`,
 * typed at a prompt — and the one decision that belongs to the app rather than
 * the manager: a manual compaction prints its own summary of what it freed, so
 * the manager's report of the same event must not be printed on top of it. Two
 * lines of numbers for one summary is the app talking over itself, at the exact
 * moment the user is reading for what changed.
 *
 * The status row is the other half. A summary is a full-prefix call the user is
 * paying for and cannot otherwise see, and `/compact` runs at a prompt where no
 * turn is on screen to say the session is busy — so the row has to be told by
 * hand, and it has to be told when the wait is over even if the summary failed.
 *
 * Run through the real `runInteractive`, so what is asserted is the wiring the
 * app has. The transport is scripted: no network, no key, nothing billed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Steps are consumed one per model call, in order; one with `throw` fails the
 * call the way a provider rejects a request (a status, so the retry ladder
 * recognizes it instead of sleeping through its whole span).
 *
 * `settleWith` is the line whose arrival means the command has finished its
 * work: `/compact` is dispatched fire-and-forget, so the answer is read out of
 * the store rather than returned.
 */
async function run(steps: unknown[], commands: string[], settleWith: string) {
	const home = mkdtempSync(join(tmpdir(), "lbb-compact-report-"));
	roots.push(home);

	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const infos = [];
		const activity = [];
		const replies = [];
		const steps = ${JSON.stringify(steps)};
		let call = 0;
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			createDefaultStreamFn: () => ai.withRetry(async function* (model, context) {
				const step = steps[Math.min(call++, steps.length - 1)];
				if (step.throw) throw Object.assign(new Error(step.throw), { status: 400 });
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				yield builder.textStart(0);
				yield builder.textDelta(0, step.text);
				yield builder.textEnd(0);
				yield builder.done("stop", step.usage);
			}, { baseDelayMs: 1 })
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: ({ session, onCommand }) => {
				// The app speaks to the user through the handle's store, so this is
				// where both of the things under test are observable: the transcript
				// lines, and the status row's word for a summary in flight.
				let state = { entries: [] };
				let shown = state.contextActivity;
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
					store: { set(update) {
						state = typeof update === "function" ? update(state) : { ...state, ...update };
						if (state.contextActivity !== shown) { activity.push(state.contextActivity); shown = state.contextActivity; }
					} },
					waitUntilExit: async () => {
						await session.prompt("hello");
						await session.prompt("and again");
						for (const text of ${JSON.stringify(commands)}) replies.push(await onCommand(text));
						// The command resolves before the summary it started does.
						const wanted = ${JSON.stringify(settleWith)};
						const deadline = Date.now() + 2000;
						while (!state.entries.some((e) => e.kind === "info" && e.text.includes(wanted)) && Date.now() < deadline) {
							await new Promise((resolve) => setTimeout(resolve, 5));
						}
						for (const entry of state.entries) if (entry.kind === "info") infos.push(entry.text);
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const exitCode = await runInteractive(${JSON.stringify({ cwd: home, theme: "dark" })});
		console.log(JSON.stringify({ exitCode, infos, activity, replies }));
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
			infos: string[];
			// "cleared" crosses the process boundary as null: the field is set back
			// to undefined, which JSON has no word for.
			activity: (string | null)[];
			replies: boolean[];
		}),
		stderr,
	};
}

const SUMMARY = { text: "<summary>1. Primary Request: hello</summary>" };

describe("a compaction the user asked for", () => {
	test("is reported once, by the command, not twice by the app", async () => {
		const { infos, activity, replies } = await run(
			[{ text: "first answer" }, { text: "second answer" }, SUMMARY],
			["/compact"],
			"Conversation compacted",
		);

		// The command ran, and it is the one that says what it cost: its own line is
		// the only line about this compaction in the transcript.
		expect(replies).toEqual([true]);
		expect(infos.filter((info) => /^Conversation compacted: ~[\d,]+ tokens freed/.test(info))).toHaveLength(1);
		expect(infos.filter((info) => info.startsWith("Context compacted (manual)"))).toEqual([]);
		// The manager's own line, named for contrast: it is what an automatic
		// compaction leaves behind (see overflow-recovery.test.ts).
		expect(infos.some((info) => info.startsWith("Context compacted (auto)"))).toBe(false);

		// And while it ran, the row said so — at a prompt where no turn is running,
		// which is the only place this compaction happens.
		expect(activity).toEqual(["Compacting context…", null]);
	});

	test("a summary that fails still stops the wait it announced", async () => {
		// The one thing this reporting cannot do is leave the row spinning. The
		// manager's own failure line is not printed here — `/compact` answers for
		// itself, and its answer is the same event told once — but the row has to
		// be cleared either way, or the screen claims work that is over.
		const { infos, activity } = await run(
			[{ text: "first answer" }, { text: "second answer" }, { throw: "summarizer down" }],
			["/compact"],
			"/compact failed",
		);

		// The whole transcript, in order: the command's own two lines — that it
		// started, and that it failed — and nothing from the manager about either.
		// (The failure text is the retry policy's wrapper around the provider's
		// error, which is why the middle is matched rather than written out.)
		expect(infos).toEqual(["Compacting conversation…", expect.stringMatching(/^\/compact failed: .*summarizer down$/)]);
		expect(activity).toEqual(["Compacting context…", null]);
	});
});
