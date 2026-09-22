/**
 * A dialog on screen when the run ends.
 *
 * The permission dialog has always taken part in the abort: `clearPermissionRequest`
 * denies what is pending and takes it down, because the tool batch is awaiting
 * those answers and an aborted run must not leave it waiting. The other two
 * dialogs — AskUserQuestion's and the plan approval — had no such ending. Their
 * only way out was the user answering them, so a run aborted with one on screen
 * (Ctrl+C does not check for a dialog before aborting) left the tool call
 * pending, the turn unfinished behind it, and nothing left to press.
 *
 * One window is narrower than the rest and covered on its own: the permission
 * callback awaits the Notification hook before it raises the dialog, so an
 * abort that lands while that hook runs arrives *before* the race is set up —
 * and a listener added to an already-aborted signal never fires. The last test
 * holds the hook open on purpose to stand in that window.
 *
 * The second half is the plan approval's opening act. ExitPlanMode asks nothing
 * of the permission system — its own call puts the plan up for approve/reject
 * and returns that answer — so the permission dialog the default rules raise
 * ahead of it is the same question twice, and the user has to answer the
 * meaningless one before reaching the real one.
 *
 * Run through the real `runInteractive` in a subprocess with a scripted
 * transport and a stub TUI: this is wiring between the session, the tool and the
 * app's own permission callback, and nothing below the app shows it. No network,
 * no key, nothing billed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

interface Scene {
	/** The prompt's own answer: "completed", "aborted" — or "timeout" if it never came. */
	prompt: string;
	/** How many times the question dialog was asked to appear. */
	asked: number;
	/** How many times the app cleared a question as aborted. */
	cleared: number;
	/** How many times the app cleared a permission dialog as aborted. */
	permissionCleared: number;
	/** Every permission dialog the app raised, in order. */
	dialogs: Array<{ name: string; input: unknown }>;
	results: Array<{ isError: boolean; text: string }>;
}

/**
 * One prompt, with the transport and the dialogs under the test's control.
 *
 * The abort is driven from the test side rather than by a keypress: what is
 * under test is that an abort *anywhere* reaches a dialog that is already up,
 * which is exactly the case the REPL's own Esc handler never covered.
 *
 * The prompt is raced against a deadline because the failure being guarded
 * against is a hang — a child process that never finishes, and a test that
 * would otherwise sit until the runner's own timeout with nothing to say.
 */
async function scene(options: {
	steps: unknown[];
	deny?: string;
	/** A Notification hook that holds for this long, writing `hookMarker` first. */
	hookHoldMs?: number;
	abortWhenAsked?: boolean;
	abortWhenPended?: boolean;
	abortWhenHookUp?: boolean;
}): Promise<Scene> {
	const cwd = tempDir("lbb-dialog-cwd-");
	const home = tempDir("lbb-dialog-home-");
	const settings: Record<string, unknown> = {};
	if (options.deny) settings.permissions = { deny: [options.deny] };
	// The marker is what the scene synchronizes on: the hook writes it and then
	// keeps running, so the abort is guaranteed to land inside the hook rather
	// than at some moment the test cannot name.
	const hookMarker = join(home, "hook-ran");
	if (options.hookHoldMs !== undefined) {
		const hookScript = join(home, "hook.cjs");
		writeFileSync(
			hookScript,
			`require("node:fs").writeFileSync(${JSON.stringify(hookMarker)}, "up");\n` +
				`Bun.sleepSync(${options.hookHoldMs});\n`,
			"utf8",
		);
		// No shell quoting: both paths are temp-dir paths, and neither holds a space.
		settings.hooks = {
			Notification: [{ hooks: [{ type: "command", command: `${process.execPath} ${hookScript}` }] }],
		};
	}
	if (Object.keys(settings).length > 0) {
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "settings.json"), JSON.stringify(settings), "utf8");
	}

	const script = `
		import { mock } from "bun:test";
		import { existsSync } from "node:fs";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const steps = ${JSON.stringify(options.steps)};
		const HOOK_MARKER = ${JSON.stringify(hookMarker)};
		const dialogs = [];
		const results = [];
		const pends = ${options.abortWhenPended === true};
		let asked = 0;
		let cleared = 0;
		let permissionCleared = 0;
		let pendingPermission = null;
		let call = 0;
		let prompt = "no prompt ran";
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			createDefaultStreamFn: () => async function* (model) {
				const step = steps[Math.min(call++, steps.length - 1)];
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				if (step.text) {
					yield builder.textStart(0);
					yield builder.textDelta(0, step.text);
					yield builder.textEnd(0);
				}
				let index = step.text ? 1 : 0;
				for (const spec of step.toolCalls ?? []) {
					const args = JSON.stringify(spec.arguments ?? {});
					yield builder.toolCallStart(index, "call_" + index, spec.name);
					yield builder.toolCallDelta(index, args);
					yield builder.toolCallEnd(index);
					index++;
				}
				yield builder.done((step.toolCalls ?? []).length > 0 ? "toolUse" : "stop", step.usage);
			}
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: ({ session }) => {
				let state = { entries: [] };
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
					store: { set(update) {
						state = typeof update === "function" ? update(state) : { ...state, ...update };
					} },
					requestPermission: (name, input) => {
						dialogs.push({ name, input });
						// A dialog nobody answers until something takes it down — the app's
						// own permission queue settles what it clears, so a stub that only
						// counted would leave the awaited promise hanging forever and turn
						// every scene into the failure it is supposed to detect.
						if (!pends) return true;
						return new Promise((resolve) => { pendingPermission = resolve; });
					},
					// The dialog nobody answers: the promise the abort has to settle.
					askUser: () => { asked++; return new Promise(() => {}); },
					clearPermissionRequest() {
						permissionCleared++;
						if (pendingPermission) {
							const resolve = pendingPermission;
							pendingPermission = null;
							resolve(false);
						}
					},
					clearQuestionRequest() { cleared++; },
					waitUntilExit: async () => {
						const run = session.prompt("go");
						// The abort goes out once the dialog is up, which is the moment under
						// test. The deadline is generous because the app's own startup (MCP,
						// hooks, settings) happens first and varies by machine; the race below
						// is what is timed, and it starts after the dialog was actually asked.
						if (${options.abortWhenAsked === true}) {
							const deadline = Date.now() + 10_000;
							while (asked === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
							session.abort();
						}
						if (${options.abortWhenHookUp === true}) {
							const deadline = Date.now() + 10_000;
							while (!existsSync(HOOK_MARKER) && Date.now() < deadline) {
								await new Promise((r) => setTimeout(r, 5));
							}
							session.abort();
						}
						if (pends) {
							const deadline = Date.now() + 10_000;
							while (dialogs.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
							session.abort();
						}
						prompt = await Promise.race([
							run,
							new Promise((resolve) => setTimeout(() => resolve("timeout"), 1500)),
						]);
						for (const message of session.messages) {
							if (message.role !== "toolResult") continue;
							results.push({
								isError: message.isError === true,
								text: message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\\n"),
							});
						}
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		await runInteractive(${JSON.stringify({ cwd, home: home, theme: "dark" })});
		console.log(JSON.stringify({ prompt, asked, cleared, permissionCleared, dialogs, results }));
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
	return JSON.parse(stdout.trim()) as Scene;
}

const ASK: unknown = {
	toolCalls: [
		{
			name: "AskUserQuestion",
			arguments: {
				questions: [{ question: "Which one?", header: "Pick", options: [{ label: "a" }, { label: "b" }] }],
			},
		},
	],
};

describe("a dialog and an abort", () => {
	test("a question still on screen is settled by the abort, not left holding the turn", async () => {
		const outcome = await scene({ steps: [ASK, { text: "done" }], abortWhenAsked: true });

		// The whole point: the turn ended. "timeout" here is the hang this test
		// exists for — the tool call waiting on a question with no one to answer it.
		expect(outcome.prompt).toBe("aborted");
		expect(outcome.asked).toBe(1);
		expect(outcome.cleared).toBeGreaterThanOrEqual(1);
		// Settled as dismissed rather than with an answer nobody gave.
		expect(outcome.results[0]?.text).toContain("dismissed");
	}, 20_000);

	test("the plan approval is the only dialog ExitPlanMode raises", async () => {
		// Two dialogs for one tool call was the shape before: the permission ask
		// (default rules have no allow for it) followed by the plan approval, both
		// with the same input, the first carrying no decision the second does not.
		const outcome = await scene({
			steps: [{ toolCalls: [{ name: "ExitPlanMode", arguments: { plan: "do it" } }] }, { text: "done" }],
		});

		expect(outcome.prompt).toBe("completed");
		expect(outcome.dialogs).toEqual([{ name: "ExitPlanMode", input: { plan: "do it" } }]);
		expect(outcome.results[0]?.isError).toBe(false);
		expect(outcome.results[0]?.text).toContain("Plan approved");
	}, 20_000);

	test("a plan waiting for an answer is taken down by the abort", async () => {
		// The approval dialog is the plan-mode half of the same hole: nothing
		// answers it but the user, so Esc while it is up used to leave it on
		// screen and the turn waiting behind it.
		const outcome = await scene({
			abortWhenPended: true,
			steps: [{ toolCalls: [{ name: "ExitPlanMode", arguments: { plan: "do it" } }] }, { text: "done" }],
		});

		expect(outcome.prompt).toBe("aborted");
		// Taken off the screen — the promise the run is waiting on settles with it.
		expect(outcome.permissionCleared).toBeGreaterThanOrEqual(1);
		// One dialog, the approval itself, and the plan was not approved by an
		// abort: the answer the model reads is a rejection.
		expect(outcome.dialogs).toEqual([{ name: "ExitPlanMode", input: { plan: "do it" } }]);
		expect(outcome.results[0]?.text).toContain("Plan rejected");
		expect(outcome.results[0]?.text).not.toContain("Plan approved");
	}, 20_000);

	test("a deny rule still decides it, with no dialog at all", async () => {
		// The arm that skips the permission dialog sits where an "ask" arrives, so
		// it cannot reach past a rule: a user who denied ExitPlanMode still gets a
		// denial, and the plan never goes up.
		const outcome = await scene({
			deny: "ExitPlanMode",
			steps: [{ toolCalls: [{ name: "ExitPlanMode", arguments: { plan: "do it" } }] }, { text: "done" }],
		});

		expect(outcome.dialogs).toEqual([]);
		expect(outcome.results[0]?.isError).toBe(true);
	}, 20_000);

	test("an abort that lands while the app is preparing the dialog withdraws it", async () => {
		// The entry-time window: `canUseTool` awaits the Notification hook before
		// it raises the permission dialog, and the hook is held open here until
		// the abort has landed. Without the entry check the dialog stays on screen
		// — raised, never answered — and the turn waits behind it forever, because
		// the abort listener is attached after the signal already fired.
		const outcome = await scene({
			hookHoldMs: 600,
			abortWhenHookUp: true,
			steps: [
				{ toolCalls: [{ name: "Write", arguments: { file_path: "written.txt", content: "hi" } }] },
				{ text: "done" },
			],
		});

		// The turn ended — "timeout" here is the hang this test exists for.
		expect(outcome.prompt).toBe("aborted");
		// Raised (the hook ran before it) and taken back down.
		expect(outcome.dialogs.map((dialog) => dialog.name)).toEqual(["Write"]);
		expect(outcome.permissionCleared).toBeGreaterThanOrEqual(1);
		// Denied, not left unresolved: the batch gets a paired result either way,
		// but only one of them says the user's interrupt decided it.
		expect(outcome.results[0]?.isError).toBe(true);
		expect(outcome.results[0]?.text).toContain("denied");
	}, 20_000);
});
