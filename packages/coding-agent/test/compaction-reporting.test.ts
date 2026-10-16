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
import { SUMMARY_SECTIONS } from "@labunbun/agent";

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
async function run(steps: unknown[], commands: string[], settleWith: string, options: Record<string, unknown> = {}) {
	const home = mkdtempSync(join(tmpdir(), "lbb-compact-report-"));
	roots.push(home);

	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const infos = [];
		const activity = [];
		const activitySince = [];
		const replies = [];
		let taskSubjects = null;
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
				if (step.toolCalls) {
					// A tool call, delivered the way a provider delivers one: opened,
					// streamed in a fragment, closed, and ended with the stop reason
					// that sends the loop off to execute it.
					let index = 0;
					for (const toolCall of step.toolCalls) {
						yield builder.toolCallStart(index, toolCall.id, toolCall.name);
						yield builder.toolCallDelta(index, JSON.stringify(toolCall.arguments));
						yield builder.toolCallEnd(index);
						index++;
					}
					yield builder.done("toolUse", step.usage);
					return;
				}
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
				let shownSince = state.contextActivitySince;
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
					store: { set(update) {
						state = typeof update === "function" ? update(state) : { ...state, ...update };
						// The stamp is recorded beside the word, as one pair: a change of
						// either is a thing someone watching the row could have seen.
						if (state.contextActivity !== shown || state.contextActivitySince !== shownSince) {
							activity.push(state.contextActivity);
							activitySince.push(state.contextActivitySince ?? null);
							shown = state.contextActivity;
							shownSince = state.contextActivitySince;
						}
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
						// Startup notices that speak about the machine rather than this
						// command stay out: the definitions notice counts the files a trust
						// gate withholds, and its walk crosses everything above the fixture's
						// cwd — on Windows the temp home sits under the real one, so a
						// machine with its own memory files leaks counts in. It is asserted
						// where it belongs (agents-command.test.ts, headless-context.test.ts);
						// this file is about compaction's own lines.
						for (const entry of state.entries) {
							if (entry.kind !== "info") continue;
							if (entry.text.startsWith("This project's definitions are not loaded")) continue;
							infos.push(entry.text);
						}
						// What the run leaves in its session file, read the way a restart
						// reads it: the newest session under this home, walked from its
						// active leaf. Null means no list is on that chain at all.
						const { SessionStore } = await import("@labunbun/agent");
						const { readTaskSnapshot } = await import("./src/task-snapshot.ts");
						const newest = SessionStore.listSessions(${JSON.stringify(home)}, ${JSON.stringify(home)})[0];
						const loaded = newest ? SessionStore.load(newest.path) : null;
						const snapshot = loaded ? readTaskSnapshot(loaded) : undefined;
						taskSubjects = snapshot ? snapshot.map((task) => task.subject) : null;
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const exitCode = await runInteractive(${JSON.stringify({ cwd: home, theme: "dark", ...options })});
		console.log(JSON.stringify({ exitCode, infos, activity, activitySince, replies, taskSubjects }));
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
			activitySince: (number | null)[];
			replies: boolean[];
			/** The task subjects on the saved chain, or null when it holds no list. */
			taskSubjects: string[] | null;
		}),
		stderr,
	};
}

const SUMMARY = { text: "<summary>1. Primary Request: hello</summary>" };

describe("a compaction the user asked for", () => {
	test("is reported once, by the command, not twice by the app", async () => {
		const { infos, activity, activitySince, replies } = await run(
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
		// which is the only place this compaction happens. The changes it went
		// through are the state machine: the pass opens, the request phase names
		// the wait, the reply is validated, the transcript is rebuilt — and then
		// the row is given back to the prompt.
		expect(activity).toEqual([
			"Compacting context…",
			"Summarizing context…",
			"Validating summary…",
			"Rebuilding context…",
			null,
		]);
		// And its clock spans the whole pass, not each phase: stamped with the
		// first word and carried unchanged through every change, so the seconds
		// on the row count the compaction — an unstamped or per-phase stamp would
		// show nothing, or reset to zero four times inside a single wait.
		expect(activitySince[0]).toBeGreaterThan(0);
		expect(new Set(activitySince.slice(0, 4)).size).toBe(1);
		expect(activitySince[4]).toBeNull();
	});

	test("under the line comes the receipt: what the pass could prove about itself", async () => {
		// The command is the one report for a manual pass, so the receipt rides
		// under its headline — the half the token counts cannot tell. The stub
		// reply carries one header of eleven, so the block has to name what the
		// continuation will not have, at the moment the user is reading for what
		// changed.
		const { infos } = await run(
			[{ text: "first answer" }, { text: "second answer" }, SUMMARY],
			["/compact"],
			"Conversation compacted",
		);

		const receipt = infos.find((info) => info.startsWith("Conversation compacted"));
		expect(receipt?.split("\n")).toEqual([
			expect.stringMatching(/^Conversation compacted: ~[\d,]+ tokens freed/),
			// Two prompts were sent and the summary keeps the newest turn: the ask
			// and its answer. Stated in messages, not tokens, because that is what
			// the user can count in the transcript.
			"Summarized 2 messages; the last 2 survive verbatim.",
			expect.stringMatching(/^Warning: the summary is missing 11 of 11 sections \(/),
		]);
	});

	test("a summary that carries every section earns the plain receipt", async () => {
		// The other half of the same contract: with nothing wrong, the receipt
		// says what is true and stops — no warning is invented to fill the block.
		const complete = `<summary>${SUMMARY_SECTIONS.map((header) => `${header}:\n[content]`).join("\n")}</summary>`;
		const { infos } = await run(
			[{ text: "first answer" }, { text: "second answer" }, { text: complete }],
			["/compact"],
			"Conversation compacted",
		);

		const receipt = infos.find((info) => info.startsWith("Conversation compacted"));
		expect(receipt?.split("\n")).toEqual([
			expect.stringMatching(/^Conversation compacted: ~[\d,]+ tokens freed/),
			"Summarized 2 messages; the last 2 survive verbatim.",
			"All 11 summary sections are present.",
		]);
	});

	test("a summary that fails still stops the wait it announced", async () => {
		// The one thing this reporting cannot do is leave the row spinning. The
		// manager's own failure line is not printed here — `/compact` answers for
		// itself, and its answer is the same event told once — but the row has to
		// be cleared either way, or the screen claims work that is over.
		const { infos, activity, activitySince } = await run(
			[{ text: "first answer" }, { text: "second answer" }, { throw: "summarizer down" }],
			["/compact"],
			"/compact failed",
		);

		// The whole transcript, in order: the command's own two lines — that it
		// started, and that it failed — and nothing from the manager about either.
		// (The failure text is the retry policy's wrapper around the provider's
		// error, which is why the middle is matched rather than written out.)
		expect(infos).toEqual(["Compacting conversation…", expect.stringMatching(/^\/compact failed: .*summarizer down$/)]);
		// The request phase was reached — the call had gone out before it failed —
		// and the failure cleared the row it had started, clock and all.
		expect(activity).toEqual(["Compacting context…", "Summarizing context…", null]);
		expect(activitySince[0]).toBe(activitySince[1]);
		expect(activitySince[2]).toBeNull();
	});

	test("the plan survives the pass: the list is carried onto the chain a restart reads", async () => {
		// The chain a compaction leaves is rooted at its boundary, so the task
		// snapshots written above it stop being the session's — including the one
		// this turn's own TaskCreate wrote moments earlier. Without the app putting
		// the list back when the pass ends, `--continue` opens on a conversation
		// whose model is told to work through a list the strip no longer shows.
		//
		// Driven through a real TaskCreate call rather than by touching the store:
		// what has to hold is the path tasks actually arrive through.
		const { taskSubjects } = await run(
			[
				{
					toolCalls: [
						{
							id: "call-1",
							name: "TaskCreate",
							arguments: { subject: "Run the suite", description: "bun test before pushing" },
						},
					],
				},
				{ text: "created" },
				{ text: "second answer" },
				SUMMARY,
			],
			["/compact"],
			"Conversation compacted",
			// A board write is undecided by anything else, so under `ask` this
			// TaskCreate reaches the permission dialog — and a scripted run has no
			// one to answer one: this harness's handle carries no
			// `requestPermission`. The run uses the mode that answers by itself,
			// so the test watches the chain, not a dialog.
			{ permissionMode: "agent" },
		);

		expect(taskSubjects).toEqual(["Run the suite"]);
	});
});
