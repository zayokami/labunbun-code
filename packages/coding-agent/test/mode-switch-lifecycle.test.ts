/**
 * What happens to a permission answer when the mode changes while it waits.
 *
 * The dialog is a blocking wait, and it is not the only thing running. A turn's
 * concurrency-safe tools start in parallel, and `EnterPlanMode` is one of them —
 * so a `Write` can raise its dialog, and a sibling in the same batch can then
 * switch the session to plan mode before the human answers. The answer the user
 * gives is real, and it is about a promise the screen stopped making.
 *
 * This is the same defect Claude Code's changelog records as "switching modes
 * while a check is pending reliably prompts instead of applying the stale
 * result" (`CHANGELOG.md:430`). The phrasing matters: the fix is not "refuse
 * everything that raced", it is that the verdict is re-decided, and only a fresh
 * refusal overrides a human's yes.
 *
 * Driven through the real `runInteractive` in a subprocess with a scripted
 * transport and a stub TUI, because the code under test is `canUseTool` — the
 * app's own resolver, which nothing below the app can reach. No network, no key,
 * nothing billed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
	prompt: string;
	/** Every permission dialog the app raised, in order. */
	dialogs: Array<{ name: string; input: unknown }>;
	/** True when the human's "yes" was given. */
	answered: boolean;
	results: Array<{ name: string; isError: boolean; text: string }>;
	/** The file the turn tried to write, and whether it reached disk. */
	wrote: boolean;
	mode: string;
}

/**
 * One turn, with the transport and the dialog under the test's control.
 *
 * The ordering is the subject, so it is pinned rather than raced: the stub holds
 * the answer until the session reports plan mode. Whichever way the two
 * concurrency-safe calls interleave on the machine running this, the answer lands
 * after the switch — which is the interleaving being guarded against, and the one
 * a plain sleep would only hit sometimes.
 */
async function scene(options: {
	/**
	 * What the mode becomes while the dialog is up.
	 *
	 * `"plan"` is the real thing: `EnterPlanMode` in the same batch, which is
	 * concurrency-safe and so switches the mode with the Write's dialog on screen.
	 * The others are driven from the test side, which is legitimate because what
	 * is under test is the re-decision and not how the mode came to change — a
	 * route the real batch does not happen to contain is a different claim, and the
	 * reachability of a mode change at all is what `"plan"` establishes.
	 */
	switch: "plan" | "agent" | "none";
}): Promise<Scene> {
	const cwd = tempDir("lbb-lifecycle-cwd-");
	const home = tempDir("lbb-lifecycle-home-");
	const target = join(cwd, "written.txt");
	const interactiveOptions = { cwd, home, theme: "dark" };
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const TARGET = ${JSON.stringify(target)};
		const SWITCH = ${JSON.stringify(options.switch)};
		const dialogs = [];
		const results = [];
		let answered = false;
		const pending = [];
		let call = 0;
		let prompt = "no prompt ran";
		// The session only exists inside the mock below, so the mode the turn ended
		// in is carried out through here.
		let finalMode = "";
		const WRITE = { name: "Write", arguments: { file_path: TARGET, content: "should not land" } };
		// The plan case runs the switch and the write in one batch, which is the whole
		// point: EnterPlanMode is concurrency-safe, so it flips the mode while the
		// Write's dialog is still up. The other cases drop it, because a control that
		// also switched the mode would be testing the same thing twice.
		const steps = SWITCH === "plan"
			? [
				{ toolCalls: [{ name: "EnterPlanMode", arguments: {} }, WRITE] },
				{ text: "done" },
			]
			: [{ toolCalls: [WRITE] }, { text: "done" }];
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
				yield builder.done((step.toolCalls ?? []).length > 0 ? "toolUse" : "stop");
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
					// Dialogs are raised and left up; what happens next is driven from
					// below, so each answer lands at a moment this file names. More than
					// one can be outstanding — the whole batch is concurrency-safe — so
					// they are held in a list rather than one slot, which would drop all
					// but the last and leave the turn waiting on an answer nobody can give.
					requestPermission: (name, input) => {
						dialogs.push({ name, input });
						return new Promise((resolve) => pending.push({ name, resolve }));
					},
					askUser: () => new Promise(() => {}),
					clearPermissionRequest() {},
					clearQuestionRequest() {},
					waitUntilExit: async () => {
						const run = session.prompt("go");
						const deadline = Date.now() + 15_000;
						const answer = (name) => {
							const at = pending.findIndex((p) => p.name === name);
							if (at < 0) return false;
							const [held] = pending.splice(at, 1);
							answered = true;
							held.resolve(true);
							return true;
						};
						// EnterPlanMode asks for itself before it switches anything, so
						// the switch cannot happen until its own dialog is answered.
						// Answering that one while holding the Write's is the ordering
						// under test: the mode flips while a sibling's question is on
						// screen and unanswered.
						if (SWITCH === "plan") {
							while (session.permissionMode !== "plan" && Date.now() < deadline) {
								answer("EnterPlanMode");
								await new Promise((r) => setTimeout(r, 5));
							}
						} else if (SWITCH === "agent") {
							// No in-batch switcher widens a mode — /mode and Shift+Tab both
							// need the prompt, and the prompt is disabled while a dialog is
							// up. So this stands in for the change rather than racing one.
							while (dialogs.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
							session.setMode("agent", "workspace-write");
						}
						while (!answer("Write") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
						prompt = await Promise.race([
							run,
							new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
						]);
						for (const message of session.messages) {
							if (message.role !== "toolResult") continue;
							results.push({
								name: message.toolCallId,
								isError: message.isError === true,
								text: message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\\n"),
							});
						}
						finalMode = session.permissionMode;
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		await runInteractive(${JSON.stringify(interactiveOptions)});
		const { existsSync } = await import("node:fs");
		console.log(JSON.stringify({ prompt, dialogs, answered, results, wrote: existsSync(TARGET), mode: finalMode }));
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

describe("a mode switch while a permission check is pending", () => {
	test("a yes given under the old mode does not carry a call the new mode refuses", async () => {
		const outcome = await scene({ switch: "plan" });

		// The dialog was raised, and the human did say yes — the answer is not being
		// discarded, it is being re-decided.
		expect(outcome.dialogs.map((d) => d.name)).toContain("Write");
		expect(outcome.answered).toBe(true);
		expect(outcome.prompt).toBe("completed");
		// The file never reached disk. This is the assertion that cannot be argued
		// with: a plan-mode session that wrote a file is a plan-mode session that
		// broke its one promise, whatever the transcript says.
		expect(outcome.wrote).toBe(false);
		// The refusal is the mode's own, and it is the *only* one. Searching for
		// "Plan mode" would find EnterPlanMode's success message first — it opens with
		// those two words too — so the results are narrowed to the failures and then
		// asked what they say. One failure, naming the tool and the mode.
		const failures = outcome.results.filter((r) => r.isError);
		expect(failures).toHaveLength(1);
		expect(failures[0].text).toBe("Plan mode: Write is not allowed (read-only mode)");
		expect(outcome.mode).toBe("plan");
	}, 40_000);

	/**
	 * The other half of the rule, and the one a reader is most likely to get wrong
	 * in the other direction: only a fresh *refusal* overrides the answer.
	 *
	 * A switch to `agent` makes the same call need no permission at all, and the
	 * human has just said yes — so the call runs. Refusing it would be safe and
	 * wrong: it would mean any mode change turned into a "something changed, try
	 * again", and a user pressing Shift+Tab mid-turn would find their answers
	 * coming back as failures. A fix that re-decides by refusing on *any* change
	 * passes the test above and fails this one.
	 */
	test("a switch that widens the mode leaves the answer standing", async () => {
		const outcome = await scene({ switch: "agent" });

		expect(outcome.dialogs.map((d) => d.name)).toContain("Write");
		expect(outcome.answered).toBe(true);
		expect(outcome.prompt).toBe("completed");
		expect(outcome.mode).toBe("agent");
		expect(outcome.wrote).toBe(true);
		expect(outcome.results.filter((r) => r.isError)).toEqual([]);
	}, 40_000);

	/**
	 * The control, and the reason the test above is worth anything: same dialog,
	 * same "yes" — but nothing switched the mode, so the answer is the final word
	 * and the file lands.
	 */
	test("with no switch in between the same answer writes the file", async () => {
		const outcome = await scene({ switch: "none" });

		expect(outcome.dialogs.map((d) => d.name)).toContain("Write");
		expect(outcome.answered).toBe(true);
		expect(outcome.prompt).toBe("completed");
		expect(outcome.wrote).toBe(true);
	}, 40_000);
});
