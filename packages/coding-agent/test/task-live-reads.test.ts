/**
 * What the Task tool is built from, when the app's state has moved since.
 *
 * The tool is created once, when the REPL starts, and it used to carry the
 * model, the session store and the permission mode it was built with. `/model`,
 * `/resume` and `/mode` then changed the session and nothing else: a subagent
 * spawned afterwards ran on the old model, compacted against the old window,
 * wrote its sidechain into the file of the conversation the user had left, and
 * was allowed what the mode it was built under allowed — with nothing on screen
 * saying so, because a subagent that answers correctly on the wrong model, or
 * writes when it should have asked, looks exactly like one behaving.
 *
 * Driven through the real `runInteractive` in a subprocess, because what is
 * being tested is whether the *app* hands the tool a live reader: the tool's own
 * handling of one is covered in subagents-skills-plan.test.ts. Each scene is one
 * `/command` and the subagent that follows it. The transport is scripted, so
 * nothing is billed and nothing leaves the machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { userMessage } from "@labunbun/ai";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** A scripted transport, a REPL that records instead of painting, and one scene. */
function sceneScript(
	scene: { steps: string; run: string; pointedAt?: string },
	options: { cwd: string; home: string },
): string {
	return `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const STEPS = ${scene.steps};
		const POINTED_AT = ${JSON.stringify(scene.pointedAt ?? "")};
		const requests = [];
		let call = 0;
		let target = "";
		let switched = false;
		let promptResult = "";
		let inserted = -2;
		let infos = () => [];
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			createDefaultStreamFn: () => async function* (model, context) {
				// The subagent's own system prompt is how its requests are told apart
				// from the parent's — a model id alone cannot say which request ran on
				// the old model if the fixture ever stopped spawning a subagent at all.
				requests.push({ id: model.id, subagent: context.systemPrompt.includes("focused subagent") });
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				const step = STEPS[Math.min(call++, STEPS.length - 1)];
				if (step.task || step.tool) {
					const name = step.tool ? step.tool.name : "Task";
					const args = step.tool
						? JSON.stringify(step.tool.arguments ?? {})
						: JSON.stringify({ description: "look it up", prompt: "find the thing" });
					yield builder.toolCallStart(0, "t1", name);
					yield builder.toolCallDelta(0, args);
					yield builder.toolCallEnd(0);
					yield builder.done("toolUse");
					return;
				}
				yield builder.textStart(0);
				yield builder.textDelta(0, step.text);
				yield builder.textEnd(0);
				yield builder.done("stop");
			}
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: (options) => {
				const { onCommand } = options;
				let state = { entries: [] };
				infos = () => state.entries.filter((entry) => entry.kind === "info").map((entry) => entry.text);
				// The session moves under the app: /resume hands it a different one,
				// and a prompt has to go to whichever is current.
				let session = options.session;
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {}, setModelName() {},
					setSession(next) { session = next; },
					store: { set(update) {
						state = typeof update === "function" ? update(state) : { ...state, ...update };
					} },
					requestPermission: async () => true,
					askUser: async () => null,
					clearPermissionRequest() {}, clearQuestionRequest() {},
					// Answered by what the session says, not by where it sits in the list:
					// the app has a session of its own by the time /resume runs, and the
					// label only starts with the first eight characters of an id — which
					// two sessions created in the same minute share. A scene that planted
					// nothing must not answer a picker at all.
					pickFromList: async (title, items) => {
						inserted =
							POINTED_AT === "" ? -1 : items.findIndex((item) => item.description.includes(POINTED_AT));
						return inserted < 0 ? null : inserted;
					},
					waitUntilExit: async () => {
						${scene.run}
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		await runInteractive(${JSON.stringify({ cwd: options.cwd, home: options.home, theme: "dark" })});
		console.log(JSON.stringify({ requests, target, switched, promptResult, inserted, infos: infos() }));
	`;
}

/** Run a scene in its own process, with its own home: nothing touches the real one. */
async function runScene(
	scene: { steps: string; run: string; pointedAt?: string },
	options: { cwd: string; home: string },
): Promise<Record<string, unknown>> {
	const proc = Bun.spawn([process.execPath, "--eval", sceneScript(scene, options)], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: options.home, USERPROFILE: options.home },
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
	return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("a subagent spawned after /model", () => {
	test("runs on the model the session is on now", async () => {
		const cwd = tempDir("lbb-taskmodel-cwd-");
		const home = tempDir("lbb-taskmodel-home-");
		const outcome = await runScene(
			{
				steps: `[{ text: "first answer" }, { task: true }, { text: "SUBAGENT REPORT" }, { text: "done" }]`,
				run: `
					promptResult = (await session.prompt("first")).toString();
					// A model that is not the one in force — picked from the registry at
					// runtime so the test cannot accidentally switch to the model it is
					// already on, whichever that is.
					const current = session.model.id;
					const other = ai.listModels().find((m) => m.id !== current);
					target = other.id;
					switched = await onCommand("/model " + other.provider + "/" + other.id);
					promptResult = await session.prompt("now delegate");
				`,
			},
			{ cwd, home },
		);

		// The switch happened, at a real ref, and the app took it — otherwise the
		// rest of this says nothing about the fix.
		expect(outcome.switched).toBe(true);
		expect(outcome.promptResult).toBe("completed");
		const requests = outcome.requests as Array<{ id: string; subagent: boolean }>;
		const target = outcome.target as string;
		// A subagent ran (exactly one request), and the first request of all was made
		// before the switch, so there is something for the switch to have changed.
		expect(requests.filter((request) => request.subagent).map((request) => request.id)).toEqual([target]);
		expect(requests[0]?.id).not.toBe(target);
		// And the parent's request after the subagent reported is on the new model
		// too, which is the part that always worked — named so a fixture that failed
		// to switch at all cannot pass on the subagent's line alone.
		expect(requests.filter((request) => !request.subagent).at(-1)?.id).toBe(target);
	});
});

describe("a subagent spawned after /resume", () => {
	// Startup, two turns and a resume, in a child process: past the 5s default.
	test("writes its sidechain into the session that is live now", async () => {
		const cwd = tempDir("lbb-taskresume-cwd-");
		const home = tempDir("lbb-taskresume-home-");
		// A session to resume into, with something in it: the swap is observed by its
		// transcript arriving, and its file is where the sidechain has to land.
		const planted = SessionStore.startNew(cwd, home);
		planted.appendMessage(userMessage("PLANTED QUESTION"));

		const outcome = await runScene(
			{
				steps: `[{ text: "first answer" }, { task: true }, { text: "SUBAGENT REPORT" }, { text: "done" }]`,
				pointedAt: "PLANTED QUESTION",
				run: `
					promptResult = (await session.prompt("first")).toString();
					// Fire-and-forget in the app, so the wait is for its effect: the resumed
					// transcript arriving. Without it the next prompt would run against the
					// session the user just left, and this test would pass on a swap that
					// never happened.
					await onCommand("/resume");
					const deadline = Date.now() + 10000;
					while (!session.messages.some((m) => JSON.stringify(m.content).includes("PLANTED QUESTION")) && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					promptResult = await session.prompt("now delegate");
				`,
			},
			{ cwd, home },
		);

		// The picker found the planted session and the app swapped onto it.
		expect(outcome.inserted).toBeGreaterThanOrEqual(0);
		expect((outcome.infos as string[]).join("\n")).toContain("Resumed session");
		expect(outcome.promptResult).toBe("completed");

		const file = readFileSync(planted.path, "utf8");
		expect(file).toContain("subagent_start");
		expect(file).toContain("subagent_end");
		// And only there: the conversation the user left must not grow entries for a
		// subagent that ran after they moved on.
		const dir = dirname(planted.path);
		const withSidechains = readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.filter((name) => readFileSync(join(dir, name), "utf8").includes("subagent_start"));
		expect(withSidechains).toEqual([basename(planted.path)]);
	}, 30_000);
});

/**
 * What each subagent recorded about its own tool calls, oldest session first.
 *
 * Read back from the session files rather than from a value the test planted:
 * the record is written by the subagent's own session inside the child process,
 * and it is the only place the outcome of a tool that a *subagent* ran is
 * written down.
 */
function subagentToolCalls(cwd: string, home: string): string[][] {
	const out: string[][] = [];
	const sessions = [...SessionStore.listSessions(cwd, home)].sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const session of sessions) {
		for (const line of readFileSync(session.path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line) as { type?: string; kind?: string; data?: { toolCalls?: string[] } };
			if (entry.type === "custom" && entry.kind === "subagent_end") out.push(entry.data?.toolCalls ?? []);
		}
	}
	return out;
}

describe("a subagent spawned after /mode acceptEdits", () => {
	// Startup, two turns and a subagent on each: past the 5s default.
	test("runs under the mode the session is in now, not the one the REPL started in", async () => {
		const cwd = tempDir("lbb-taskmode-cwd-");
		const home = tempDir("lbb-taskmode-home-");
		// No permission rules at all, so the mode is the only thing that differs
		// between the two runs: in the startup mode an edit is an unresolved ask
		// and the subagent fails closed (it has no dialog to ask through), and
		// under acceptEdits it is allowed outright. Plan mode is not the mode to
		// reach for here — it denies the Task call itself, and then there is no
		// subagent to observe.
		const write = { name: "Write", arguments: { file_path: "written.txt", content: "hi" } };
		const outcome = await runScene(
			{
				steps: `[
						{ task: true }, { tool: ${JSON.stringify(write)} }, { text: "one" }, { text: "parent one" },
						{ task: true }, { tool: ${JSON.stringify(write)} }, { text: "two" }, { text: "parent two" }
					]`,
				run: `
						promptResult = (await session.prompt("first")).toString();
						await onCommand("/mode acceptEdits");
						promptResult = await session.prompt("second");
					`,
			},
			{ cwd, home },
		);

		expect(outcome.promptResult).toBe("completed");
		// Denied before the switch and allowed after it — the subagent's own
		// record of what its tools did, read back from the session file.
		expect(subagentToolCalls(cwd, home)).toEqual([["Write: error"], ["Write: ok"]]);
	}, 30_000);
});
