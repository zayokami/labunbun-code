/**
 * `/think` — the session-wide thinking level, end to end.
 *
 * Three seams have to line up for the command to mean anything: the switch
 * validates the argument and moves the holder, the session reads the holder on
 * every request, and a subagent spawned later reads it through the same seam.
 * Any one of them wired wrong produces the same silence — a command that
 * confirms and a request that ignores it look identical on screen — so the
 * scenes here run the real `runInteractive` in a subprocess, with the transport
 * scripted: nothing is billed, and the assertions are on what would have been
 * sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** A scripted transport that records the thinking level of every request. */
function sceneScript(scene: { steps: string; run: string }, options: { cwd: string; home: string }): string {
	return `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const STEPS = ${scene.steps};
		const requests = [];
		let call = 0;
		let promptResult = "";
		let infos = () => [];
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			createDefaultStreamFn: () => async function* (model, context, options) {
				// The level the request would carry, and which conversation made it —
				// the subagent's own system prompt is what tells its requests apart
				// from the parent's.
				requests.push({
					thinking: options?.thinkingLevel ?? null,
					subagent: context.systemPrompt.includes("focused subagent"),
				});
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				const step = STEPS[Math.min(call++, STEPS.length - 1)];
				if (step.task) {
					yield builder.toolCallStart(0, "t1", "Task");
					yield builder.toolCallDelta(0, JSON.stringify({ description: "look it up", prompt: "find the thing" }));
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
				const session = options.session;
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {}, setModelName() {},
					setSession() {},
					store: { set(update) {
						state = typeof update === "function" ? update(state) : { ...state, ...update };
					} },
					requestPermission: async () => true,
					askUser: async () => null,
					clearPermissionRequest() {}, clearQuestionRequest() {},
					pickFromList: async () => null,
					waitUntilExit: async () => {
						${scene.run}
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		await runInteractive(${JSON.stringify({ cwd: options.cwd, home: options.home, theme: "dark" })});
		console.log(JSON.stringify({ requests, promptResult, infos: infos() }));
	`;
}

/** Run a scene in its own process, with its own home: nothing touches the real one. */
async function runScene(
	scene: { steps: string; run: string },
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

interface Seen {
	thinking: string | null;
	subagent: boolean;
}

describe("/think", () => {
	test("the request after the command carries the new level, and the choice is saved", async () => {
		const cwd = tempDir("lbb-think-cwd-");
		const home = tempDir("lbb-think-home-");
		const outcome = await runScene(
			{
				steps: `[{ text: "first answer" }, { text: "second answer" }]`,
				run: `
					promptResult = (await session.prompt("first")).toString();
					await onCommand("/think");
					await onCommand("/think high");
					await onCommand("/think");
					await onCommand("/think sideways");
					promptResult = (await session.prompt("second")).toString();
				`,
			},
			{ cwd, home },
		);

		expect(outcome.promptResult).toBe("completed");
		const requests = outcome.requests as Seen[];
		// The whole of the contract: nothing before the command, the new level on
		// the very next request. `undefined` on the first request is also the check
		// that an unset level is not invented for the wire.
		expect(requests.map((request) => request.thinking)).toEqual([null, "high"]);
		const infos = (outcome.infos as string[]).join("\n");
		// The question, the acknowledgement, and the refusal — each said in its own
		// words, and the refusal visibly a refusal.
		expect(infos).toContain("Thinking level: unset — each model's own default");
		expect(infos).toContain("Thinking level: high — takes effect on the next request");
		expect(infos).toContain("Usage: /think [off|minimal|low|medium|high]");
		// Saved to the user's own file, where the next run reads it from.
		const saved = JSON.parse(readFileSync(join(home, ".labunbun", "settings.json"), "utf8")) as {
			thinkingLevel?: string;
		};
		expect(saved.thinkingLevel).toBe("high");
	}, 30_000);

	test("a subagent spawned after the command thinks at the session's level", async () => {
		const cwd = tempDir("lbb-thinktask-cwd-");
		const home = tempDir("lbb-thinktask-home-");
		const outcome = await runScene(
			{
				steps: `[{ task: true }, { text: "SUBAGENT REPORT" }, { text: "done" }]`,
				run: `
					await onCommand("/think low");
					promptResult = (await session.prompt("delegate")).toString();
				`,
			},
			{ cwd, home },
		);

		expect(outcome.promptResult).toBe("completed");
		const requests = outcome.requests as Seen[];
		// A subagent ran, and its request inherited the level — not the model's
		// default and not the level the tool was built with.
		expect(requests.filter((request) => request.subagent).map((request) => request.thinking)).toEqual(["low"]);
		// The parent's requests carry it too: one before the Task call, one after
		// the report came back.
		expect(requests.filter((request) => !request.subagent).map((request) => request.thinking)).toEqual(["low", "low"]);
	}, 30_000);
});
