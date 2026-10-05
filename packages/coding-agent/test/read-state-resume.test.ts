/**
 * What `/resume` does to the Edit gate's memory of reads.
 *
 * The tool array crosses a session swap unchanged (`interactive.ts:840`), so
 * the Read records crossed it too: the incoming conversation started able to
 * edit a file it was never shown, because the *outgoing* one had read it. The
 * gate's question is "was this file read this session" and a swap is the one
 * event where "this session" changes without a new tool set — so the record has
 * to be cleared with it, not carried.
 *
 * Driven through the real `runInteractive` in a subprocess: the read, the swap,
 * the refusal, and the re-read that makes the edit legal are one story that
 * only the app can tell. The transport is scripted, so nothing is billed and
 * nothing leaves the machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	scene: { steps: string; run: string; pointedAt: string },
	options: { cwd: string; home: string },
): string {
	return `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const STEPS = ${scene.steps};
		const POINTED_AT = ${JSON.stringify(scene.pointedAt)};
		const requests = [];
		const toolResults = [];
		let call = 0;
		let promptResult = "";
		let afterResume = "";
		let inserted = -2;
		let infos = () => [];
		// The swap hands the app a different session, so the watcher is re-armed
		// with each one — a subscription kept on the session being left would go
		// blind exactly at the moment under test.
		const watch = (session) => {
			session.on((event) => {
				if (event.type === "tool_execution_end") {
					toolResults.push({
						name: event.toolName,
						isError: Boolean(event.result.isError),
						text: JSON.stringify(event.result.content),
					});
				}
			});
		};
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			createDefaultStreamFn: () => async function* (model, context) {
				requests.push({ id: model.id });
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				const step = STEPS[Math.min(call++, STEPS.length - 1)];
				if (step.tool) {
					yield builder.toolCallStart(0, "t1", step.tool.name);
					yield builder.toolCallDelta(0, JSON.stringify(step.tool.arguments ?? {}));
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
				let session = options.session;
				watch(session);
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {}, setModelName() {},
					setSession(next) { session = next; watch(next); },
					store: { set(update) {
						state = typeof update === "function" ? update(state) : { ...state, ...update };
					} },
					requestPermission: async () => true,
					askUser: async () => null,
					clearPermissionRequest() {}, clearQuestionRequest() {},
					pickFromList: async (title, items) => {
						inserted = items.findIndex((item) => item.description.includes(POINTED_AT));
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
		console.log(JSON.stringify({ requests, toolResults, promptResult, afterResume, inserted, infos: infos() }));
	`;
}

/** Run a scene in its own process, with its own home: nothing touches the real one. */
async function runScene(
	scene: { steps: string; run: string; pointedAt: string },
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

describe("the edit gate across /resume", () => {
	// Startup, a read, a swap and two edits: past the 5s default.
	test("a read from the session being left does not license an edit in the one arriving", async () => {
		const cwd = tempDir("lbb-readstate-cwd-");
		const home = tempDir("lbb-readstate-home-");
		const target = join(cwd, "target.txt");
		writeFileSync(target, "alpha\nbeta\n");
		// A session to resume into, with something in it: the swap is observed by
		// its transcript arriving, so a scene that resumed nothing cannot pass.
		const planted = SessionStore.startNew(cwd, home);
		planted.appendMessage(userMessage("PLANTED QUESTION"));

		const edit = (old_string: string, new_string: string) => ({
			tool: { name: "Edit", arguments: { file_path: target, old_string, new_string } },
		});
		const outcome = await runScene(
			{
				pointedAt: "PLANTED QUESTION",
				// Read in the first session; then, after the swap, an edit that must be
				// refused, the re-read that makes it legal, and the same edit again.
				steps: JSON.stringify([
					{ tool: { name: "Read", arguments: { file_path: target } } },
					{ text: "read it" },
					edit("alpha", "ALPHA"),
					{ tool: { name: "Read", arguments: { file_path: target } } },
					edit("alpha", "ALPHA"),
					{ text: "edited" },
				]),
				run: `
					promptResult = (await session.prompt("read it")).toString();
					await onCommand("/resume");
					const deadline = Date.now() + 10000;
					while (!session.messages.some((m) => JSON.stringify(m.content).includes("PLANTED QUESTION")) && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					afterResume = (await session.prompt("now edit")).toString();
				`,
			},
			{ cwd, home },
		);

		// The swap really happened, or the refusals below would be about nothing.
		expect(outcome.inserted).toBeGreaterThanOrEqual(0);
		expect((outcome.infos as string[]).join("\n")).toContain("Resumed session");
		expect(outcome.promptResult).toBe("completed");
		expect(outcome.afterResume).toBe("completed");

		const edits = (outcome.toolResults as Array<{ name: string; isError: boolean; text: string }>).filter(
			(result) => result.name === "Edit",
		);
		expect(edits).toHaveLength(2);
		// The first edit was refused for the gate's reason — not for a permission,
		// a mode, or a match failure — and nothing was written.
		expect(edits[0]?.isError).toBe(true);
		expect(edits[0]?.text).toContain("was not read this session");
		// The re-read in the arriving session licensed the same edit, so the
		// refusal was one re-read away from working — the direction the clear()
		// takes deliberately.
		expect(edits[1]?.isError).toBe(false);
		expect(readFileSync(target, "utf8")).toBe("ALPHA\nbeta\n");
	}, 30_000);
});
