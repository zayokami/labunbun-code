/**
 * The prefix the interactive app actually sends, and what it says when it
 * changes one on purpose.
 *
 * Two facts, both of which are only visible from inside the running app:
 *
 * - A hook's contribution is part of the user message it was composed into, so
 *   the second request of a conversation extends the first instead of rewriting
 *   it. Nothing outside the app can see this, because it is a property of the
 *   relation between two requests, not of either one.
 * - A rewrite the app made deliberately is named in `/cache`. From the wire a
 *   deliberate rewrite and an unexplained one are the same bytes; the
 *   difference lives in the code that made the change, so it has to be *told*
 *   to the tracker, and this is the test that says it was.
 *
 * Run through the real `runInteractive` with the transport and the REPL mocked —
 * the convention this repo uses for module mocks (see `continue.test.ts`): a
 * child process, because `mock.module` outlives the file that called it and
 * there is no API to undo it. Zero network, no credential, nothing billed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONTEXT = "the build runs via make, and tests via bun test";

const roots: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-cache-app-"));
	roots.push(dir);
	return dir;
}

afterAll(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Step {
	text: string;
	usage?: { input?: number; output?: number };
}

interface Op {
	submit?: string;
	command?: string;
	/** Wait for an info line containing this text before carrying on. */
	waitFor?: string;
	/** Keep everything the app said up to here, under this key. */
	capture?: string;
}

interface AppRun {
	exitCode: number;
	stderr: string;
	/** Request message arrays, serialized as they were sent. */
	requests: string[];
	reports: Record<string, string>;
}

/**
 * Run the app once per plan, in one project directory.
 *
 * More than one run happens only for `/resume`, which needs a session that was
 * left behind by an earlier process to swap into. Both runs share the same
 * `cwd`, because that is what makes them the same project.
 *
 * `settings` is written into the isolated home — the only tier hooks are
 * honoured from — and `cwd` is the directory the app is told it is running in.
 */
async function runApp(options: {
	steps: Step[];
	plans: Op[][];
	settings?: Record<string, unknown>;
	hookScript?: { event: string; text: string };
}): Promise<AppRun> {
	const dir = scratch();
	const home = scratch();
	mkdirSync(join(home, ".labunbun"), { recursive: true });

	let settings: Record<string, unknown> = options.settings ?? {};
	if (options.hookScript) {
		const script = join(dir, "hook.mjs");
		writeFileSync(
			script,
			`console.log(${JSON.stringify(JSON.stringify({ addedContext: options.hookScript.text }))});\n`,
		);
		settings = {
			...settings,
			hooks: {
				[options.hookScript.event]: [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }],
			},
		};
	}
	writeFileSync(join(home, ".labunbun", "settings.json"), JSON.stringify(settings));

	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const steps = ${JSON.stringify(options.steps)};
		const plans = ${JSON.stringify(options.plans)};
		const requests = [];
		const reports = {};
		let call = 0;
		let run = 0;
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			// The real default is the adapters wrapped in the retry policy, so the
			// mock replaces the *transport* only: everything from the cache tracker
			// and the compaction ladder onwards is the production path.
			createDefaultStreamFn: () => ai.withRetry(async function* (model, context) {
				// Serialized here, at the moment of the call: the session hands out
				// its live message array, so a snapshot taken after the run would be
				// the same array for every request.
				requests.push(JSON.stringify(context.messages));
				const step = steps[Math.min(call++, steps.length - 1)];
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				yield builder.textStart(0);
				yield builder.textDelta(0, step.text);
				yield builder.textEnd(0);
				yield builder.done("stop", step.usage);
			}, { baseDelayMs: 1 }),
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: (options) => {
				let state = { entries: [] };
				// The session moves under the harness: /resume hands the app a
				// different one, and a prompt has to go to whichever is current.
				let session = options.session;
				const plan = plans[run];
				const infos = () => state.entries.filter((entry) => entry.kind === "info").map((entry) => entry.text);
				const waitFor = async (predicate, ms = 10000) => {
					const deadline = Date.now() + ms;
					while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
				};
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
					setSession(next) { session = next; },
					// /resume asks which session; the harness answers by description so
					// the choice does not depend on the order the list comes back in. A
					// miss returns null — -1 would index nothing and take the app down
					// a path no user can reach.
					pickFromList: async (_title, items) => {
						const index = items.findIndex((item) => item.description.includes("one"));
						return index < 0 ? null : index;
					},
					store: {
						set(update) { state = typeof update === "function" ? update(state) : { ...state, ...update }; },
					},
					waitUntilExit: async () => {
						for (const op of plan) {
							// What the REPL does with a submitted line: the gate first
							// (UserPromptSubmit hooks shell out), then the prompt.
							if (op.submit !== undefined) {
								await options.onSubmitText?.(op.submit);
								await session.prompt(op.submit);
							}
							if (op.command !== undefined) {
								options.onCommand?.(op.command);
								await new Promise((r) => setTimeout(r, 50));
							}
							if (op.waitFor !== undefined) await waitFor(() => infos().some((t) => t.includes(op.waitFor)));
							if (op.capture !== undefined) reports[op.capture] = infos().join("\\n");
						}
					},
				};
			},
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const codes = [];
		for (run = 0; run < plans.length; run++) codes.push(await runInteractive({ cwd: ${JSON.stringify(dir)}, theme: "dark" }));
		console.log(JSON.stringify({ exitCode: codes[codes.length - 1], codes, requests, reports }));
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
	const parsed = JSON.parse(stdout.trim()) as Omit<AppRun, "stderr">;
	return { ...parsed, stderr };
}

/** Whether `later` sent `earlier`'s messages and then some. */
function isExtensionOf(earlier: string | undefined, later: string | undefined): boolean {
	if (!earlier || !later) return false;
	return later.startsWith(earlier.slice(0, -1)); // `]` is the only byte an append may change
}

describe("hook context in the interactive app", () => {
	test("a contributed prompt keeps its bytes when the next request is made", async () => {
		const run = await runApp({
			steps: [{ text: "first answer" }, { text: "second answer" }],
			plans: [[{ submit: "one" }, { submit: "two" }]],
			hookScript: { event: "UserPromptSubmit", text: CONTEXT },
		});

		expect(run.requests).toHaveLength(2);
		expect(run.requests[0]).toContain(CONTEXT);
		// The message is in the transcript, so the second request replays it as it
		// was stored. When the context was attached to a request instead, this is
		// where it went missing — and everything after that message was paid for
		// again at full price.
		expect(run.requests[1]).toContain(CONTEXT);
		expect(isExtensionOf(run.requests[0], run.requests[1])).toBe(true);
	}, 60_000);

	test("a SessionStart contribution is part of the first message for the whole run", async () => {
		const run = await runApp({
			steps: [{ text: "first answer" }, { text: "second answer" }],
			plans: [[{ submit: "one" }, { submit: "two" }]],
			hookScript: { event: "SessionStart", text: CONTEXT },
		});

		expect(run.requests).toHaveLength(2);
		expect(run.requests[0]).toContain(CONTEXT);
		expect(run.requests[1]).toContain(CONTEXT);
		expect(isExtensionOf(run.requests[0], run.requests[1])).toBe(true);
	}, 60_000);
});

describe("rewrites the app declares", () => {
	// A model with a window small enough that a large first answer crosses the
	// compaction threshold (178,808 of 200,000), so the ladder decides on its own.
	const SMALL_MODEL = {
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
	};

	test("/compact names the rewrite it made", async () => {
		const run = await runApp({
			steps: [{ text: "first answer" }, { text: "<summary>what happened so far</summary>" }, { text: "second answer" }],
			plans: [
				[
					{ submit: "one" },
					{ command: "/compact", waitFor: "Conversation compacted" },
					{ submit: "two" },
					{ command: "/cache", capture: "after" },
				],
			],
		});

		// Three requests: the conversation's first turn, the summary, and the turn
		// after it — the rewound one.
		expect(run.requests).toHaveLength(3);
		const report = run.reports.after ?? "";
		expect(report).toMatch(/rewind\s+turn \d+: .*· compaction/);
		expect(report).not.toContain("UNREGISTERED");
		// And the summary really was written: the rewound request carries it.
		expect(run.requests[2]).toContain("what happened so far");
	}, 60_000);

	test("the ladder names the rewrite it decided on by itself", async () => {
		// Nobody asked for this one. An unregistered rewrite is what `/cache` is
		// built to catch, so the automatic path registering itself is the whole
		// difference between a report that explains the session and one that
		// accuses it.
		const run = await runApp({
			settings: SMALL_MODEL,
			steps: [
				{ text: "first answer", usage: { input: 185_000, output: 10 } },
				{ text: "<summary>what happened so far</summary>" },
				{ text: "second answer" },
			],
			plans: [
				[
					{ submit: "one" },
					// The second prompt's turn is where the ladder decides; `prompt` does
					// not return until the request it decided about has been sent.
					{ submit: "two" },
					{ command: "/cache", capture: "after" },
				],
			],
		});

		expect(run.requests).toHaveLength(3);
		const report = run.reports.after ?? "";
		expect(report).toMatch(/rewind\s+turn \d+: .*· compaction/);
		expect(report).not.toContain("UNREGISTERED");
	}, 60_000);

	test("/resume starts the cache history over with the conversation", async () => {
		// The prefix in the incoming session has nothing to do with the one being
		// left, and the family key does not know that — same model, same tools, same
		// system prompt. Without the reset the swap would be reported as a rewind
		// from message 0 of a conversation that never existed, and the numbers above
		// it would mix two sessions' prompts into one ceiling.
		//
		// Two runs in one project, because that is what a resume is: a session left
		// behind by an earlier process, picked up by a later one.
		const run = await runApp({
			steps: [{ text: "first answer" }, { text: "second answer" }, { text: "third answer" }],
			plans: [
				[{ submit: "one" }],
				[
					{ submit: "beta" },
					{ command: "/resume", waitFor: "Resumed session" },
					{ submit: "gamma" },
					{ command: "/cache", capture: "after" },
				],
			],
		});

		// The swap happened: the last request carries the resumed conversation, not
		// the one that was open when `/resume` was typed.
		expect(run.requests).toHaveLength(3);
		expect(run.requests[2]).toContain("one");
		expect(run.requests[2]).not.toContain("beta");

		// And the cache history restarted with it. Two requests are missing from the
		// report — the one from the earlier process and the one made before the swap —
		// because they describe prefixes nothing is going to send again; what is left
		// is the request after the swap, which is a cold start rather than a rewind.
		const report = run.reports.after ?? "";
		expect(report).toContain("1 request");
		expect(report).toContain("1 cold start");
		expect(report).toContain("0 rewinds");
		expect(report).not.toContain("UNREGISTERED");
	}, 60_000);
});
