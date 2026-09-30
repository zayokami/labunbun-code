/**
 * "Don't ask again", end to end, through the rules it actually reads.
 *
 * The queue test next door pins the cascade with a policy hook it supplies
 * itself, which leaves one thing unproven: that the app layer's hook sees the
 * grant it is being asked about. `onAlwaysAllow` pushes into `sessionRules` and
 * `canAutoResolve` reads them, one statement later — a snapshot taken before the
 * push would leave every lookup answered "still needs a human", which is safe at
 * every step and a feature that does nothing. No fake-gate test can see that,
 * because the fake gate is not the thing holding the array.
 *
 * So this drives the real `runInteractive`, the real `mountRepl` and the real
 * queue, and only replaces ink's `render` — the screen itself is the real store,
 * and the test presses the dialog by calling the same `resolve` the buttons
 * call. Two `Read`s in one batch are the shape that reaches the cascade at all:
 * both are concurrency-safe, so both raise a dialog while the first is still
 * waiting, and a file rule granted from the first has to answer the second.
 * (`Write` and `Edit` are not concurrency-safe, so two of them in a batch never
 * sit in the queue together — the cascade is unreachable for them.)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

interface Cascade {
	/** How many permission dialogs were put on screen, in order. */
	dialogs: Array<{ toolName: string; preview: string }>;
	/** What the turn ended up with, one entry per tool result. */
	results: Array<{ isError: boolean; text: string }>;
	prompt: string;
}

/**
 * One turn of two reads, with the first answer chosen by the test.
 *
 * The first read is answered as soon as its dialog is up and the second is left
 * to whatever the cascade decides, because the count of dialogs that reach the
 * screen is the whole claim: one means the grant answered it, two means it was
 * asked again.
 */
async function cascade(alwaysAllow: boolean): Promise<Cascade> {
	const cwd = tempDir("lbb-cascade-cwd-");
	const home = tempDir("lbb-cascade-home-");
	const first = join(cwd, "first.txt");
	const second = join(cwd, "second.txt");
	writeFileSync(first, "one");
	writeFileSync(second, "two");
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import { createRequire } from "node:module";
		import { pathToFileURL } from "node:url";
		// ink belongs to the TUI package, not this one, so it resolves from there
		// rather than from the working directory of this script.
		const ink = await import(pathToFileURL(
			createRequire(${JSON.stringify(join(import.meta.dir, "..", "..", "tui", "src", "probe.cjs"))}).resolve("ink"),
		).href);
		const FIRST = ${JSON.stringify(first)};
		const SECOND = ${JSON.stringify(second)};
		const ALWAYS = ${JSON.stringify(alwaysAllow)};
		const dialogs = [];
		const results = [];
		let prompt = "no prompt ran";
		let handle = null;
		let session = null;
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const steps = [
			{
				toolCalls: [
					{ name: "Read", arguments: { file_path: FIRST } },
					{ name: "Read", arguments: { file_path: SECOND } },
				],
			},
			{ text: "done" },
		];
		let call = 0;
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
					yield builder.toolCallStart(index, "call_" + index, spec.name);
					yield builder.toolCallDelta(index, JSON.stringify(spec.arguments ?? {}));
					yield builder.toolCallEnd(index);
					index++;
				}
				yield builder.done((step.toolCalls ?? []).length > 0 ? "toolUse" : "stop");
			},
		}));
		// The screen is replaced and nothing else: mountRepl builds the real store
		// and the real queue, so the dialog the test presses is the dialog a user
		// would be looking at.
		mock.module("ink", () => ({
			...ink,
			render: () => ({ waitUntilExit: drive, unmount() {} }),
		}));
		const tui = await import("@labunbun/tui");
		// Copied before the mock goes in: the namespace object is re-linked by the
		// mock, so a later read of tui.mountRepl is the wrapper calling itself.
		const realMountRepl = tui.mountRepl;
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: (options) => {
				session = options.session;
				handle = realMountRepl(options);
				return handle;
			},
		}));
		async function drive() {
			const shown = [];
			const answered = new Set();
			handle.store.subscribe(() => {
				const dialog = handle.store.get().dialog;
				if (dialog) shown.push(dialog);
			});
			// A request, not a redraw. The queue re-runs its show on every arrival, so a
			// second request landing while the first dialog is up puts a new dialog
			// object on screen holding the *first* request's text; the two reads are
			// different files, so the preview identifies the request and the newest
			// object carrying a preview is the live button for it.
			const answer = (preview, allow, always) => {
				if (answered.has(preview)) return false;
				const live = [...shown].reverse().find((d) => d.inputPreview === preview);
				if (!live) return false;
				answered.add(preview);
				live.resolve(allow, always);
				return true;
			};
			const run = session.prompt("go");
			let settled = false;
			let outcome = null;
			run.then(
				(value) => { settled = true; outcome = value; },
				(error) => { settled = true; outcome = "rejected: " + (error?.message ?? String(error)); },
			);
			const deadline = Date.now() + 15_000;
			while (!answer(FIRST, true, ALWAYS) && !settled && Date.now() < deadline) await sleep(5);
			// Everything after this is bookkeeping: any dialog still to come is one the
			// cascade declined, and it has to be answered for the turn to finish and the
			// count below to mean what it says.
			while (!settled && Date.now() < deadline) {
				for (const dialog of shown) answer(dialog.inputPreview, true, true);
				await sleep(5);
			}
			for (const dialog of shown) {
				if (dialogs.some((d) => d.preview === dialog.inputPreview)) continue;
				dialogs.push({ toolName: dialog.toolName, preview: dialog.inputPreview });
			}
			prompt = outcome ?? "timeout";
			for (const message of session.messages) {
				if (message.role !== "toolResult") continue;
				results.push({
					isError: message.isError === true,
					text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\\n"),
				});
			}
		}
		const { runInteractive } = await import("./src/interactive.ts");
		await runInteractive(${JSON.stringify({ cwd, home, theme: "dark" })});
		console.log(JSON.stringify({ dialogs, prompt, results }));
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
	return JSON.parse(stdout.trim()) as Cascade;
}

describe("a grant made while another request is queued", () => {
	/**
	 * The user answered "yes, and don't ask again for reads", and a second read was
	 * already on the queue behind the one they were looking at. Asking again would
	 * read as the option being ignored — which is exactly what the queue test next
	 * door pins, and the reason this one exists is the *other* half: that the answer
	 * the queue acted on was one the app layer could see.
	 */
	test("a read queued behind an always-allow is answered from the rule", async () => {
		const outcome = await cascade(true);

		// One dialog: the second read was answered from the rule the first answer
		// granted, so it never reached the screen.
		expect(outcome.dialogs).toHaveLength(1);
		expect(outcome.dialogs[0].toolName).toBe("Read");
		expect(outcome.prompt).toBe("completed");
		// Both reads ran. The cascade resolving the second promise is the tool
		// executing; a cascade that dropped the request instead would also have left
		// one dialog, and nothing would have been read.
		expect(outcome.results).toHaveLength(2);
		expect(outcome.results.map((r) => r.isError)).toEqual([false, false]);
	}, 40_000);

	/**
	 * The control, and the reason the test above is worth anything: the same turn,
	 * the same two dialogs, the same "yes" — but granted for this once, so there is
	 * no rule to answer the sibling and it asks. A queue that cascaded on any yes
	 * would pass the test above and fail this one.
	 */
	test("a read queued behind a one-off answer still asks", async () => {
		const outcome = await cascade(false);

		expect(outcome.dialogs).toHaveLength(2);
		expect(outcome.dialogs.every((d) => d.toolName === "Read")).toBe(true);
		// The two are different files: a second dialog for the same request would
		// mean the answer was taken twice, not that the sibling asked.
		expect(outcome.dialogs[0].preview).not.toBe(outcome.dialogs[1].preview);
		expect(outcome.prompt).toBe("completed");
		expect(outcome.results).toHaveLength(2);
		expect(outcome.results.map((r) => r.isError)).toEqual([false, false]);
	}, 40_000);
});
