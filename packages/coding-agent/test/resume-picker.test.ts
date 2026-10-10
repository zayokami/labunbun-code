/**
 * The /resume picker, driven through the real runInteractive.
 *
 * Two failures it used to have, both about what Enter does. The list included
 * the session already running — newest mtime, so the preselected first row —
 * and Enter on it "resumed" the empty session the user was already in,
 * clearing the screen in exchange for nothing. And a swap that threw mid-flight
 * was an unhandled rejection: the picker closed and neither a resume nor a
 * message happened. What is under test is the row the picker offers and the
 * error it reports, observed where the app builds them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

/** A REPL that records instead of painting; Enter picks the first row. */
function sceneScript(options: { cwd: string }): string {
	return `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const pickerItems = [];
		let pickedIndex = null;
		let resumed = false;
		let infos = () => [];
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			refreshModelCatalog: async () => null,
			createDefaultStreamFn: () => async function* () { throw new Error("no prompt is issued in this scene"); }
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: (options) => {
				const { onCommand } = options;
				let state = { entries: [] };
				infos = () => state.entries.filter((entry) => entry.kind === "info").map((entry) => entry.text);
				let session = options.session;
				const THROW_ON_SWAP = process.env.LBB_THROW_ON_SWAP === "1";
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {}, setModelName() {},
					setSession(next) {
						if (THROW_ON_SWAP) throw new Error("swap wiring exploded");
						session = next;
					},
					store: { set(update) {
						state = typeof update === "function" ? update(state) : { ...state, ...update };
					} },
					requestPermission: async () => true,
					askUser: async () => null,
					clearPermissionRequest() {}, clearQuestionRequest() {},
					pickFromList: async (title, items) => {
						pickerItems.push(...items);
						pickedIndex = items.length > 0 ? 0 : null;
						return pickedIndex;
					},
					waitUntilExit: async () => {
						await onCommand("/resume");
						const deadline = Date.now() + 8000;
						const done = () =>
							THROW_ON_SWAP
								? infos().some((text) => text.includes("Resume failed"))
								: session.messages.some((m) => JSON.stringify(m.content).includes("PLANTED QUESTION"));
						while (!done() && Date.now() < deadline) {
							await new Promise((resolve) => setTimeout(resolve, 10));
						}
						resumed = session.messages.some((m) => JSON.stringify(m.content).includes("PLANTED QUESTION"));
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		await runInteractive(${JSON.stringify({ cwd: options.cwd, theme: "dark" })});
		console.log(JSON.stringify({ pickerItems, pickedIndex, infos: infos(), resumed }));
	`;
}

async function runScene(
	options: { cwd: string; home: string },
	env: Record<string, string> = {},
): Promise<{
	pickerItems: Array<{ label: string; description: string }>;
	pickedIndex: number | null;
	infos: string[];
	resumed: boolean;
}> {
	const proc = Bun.spawn([process.execPath, "--eval", sceneScript(options)], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: options.home, USERPROFILE: options.home, ...env },
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
	return JSON.parse(stdout.trim());
}

describe("the /resume picker", () => {
	test("the running session is not in its own list, and Enter takes the newest other one", async () => {
		const home = tempDir("lbb-resume-picker-home-");
		const cwd = tempDir("lbb-resume-picker-cwd-");
		const planted = SessionStore.startNew(cwd, home);
		planted.appendMessage(userMessage("PLANTED QUESTION"));
		const plantedId = planted.sessionId;
		if (!plantedId) throw new Error("expected a session id");

		const outcome = await runScene({ cwd, home });

		// One row: the planted conversation. The session this process started is
		// the newest file and used to be row 0 — Enter on it was a no-op that
		// looked like a wipe.
		expect(outcome.pickerItems).toHaveLength(1);
		// And the row names the session by its random suffix, not the month.
		expect(outcome.pickerItems[0]?.label.startsWith(plantedId.slice(-8))).toBe(true);
		expect(outcome.pickerItems[0]?.description).toContain("PLANTED QUESTION");
		expect(outcome.pickedIndex).toBe(0);
		expect(outcome.resumed).toBe(true);
		// And the swap says which session it resumed, by the same suffix the row
		// used — not the month prefix every session in it shares.
		expect(outcome.infos.join("\n")).toContain(`Resumed session ${plantedId.slice(-8)}`);
	}, 30_000);

	test("a swap that throws says so instead of closing onto nothing", async () => {
		const home = tempDir("lbb-resume-picker-home-");
		const cwd = tempDir("lbb-resume-picker-cwd-");
		const planted = SessionStore.startNew(cwd, home);
		planted.appendMessage(userMessage("PLANTED QUESTION"));

		const outcome = await runScene({ cwd, home }, { LBB_THROW_ON_SWAP: "1" });

		expect(outcome.infos.join("\n")).toContain("Resume failed: swap wiring exploded");
	}, 30_000);
});
