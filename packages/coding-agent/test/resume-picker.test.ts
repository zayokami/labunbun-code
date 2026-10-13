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
function sceneScript(options: { cwd: string; after?: string }): string {
	return `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const pickerItems = [];
		let pickedIndex = null;
		let resumed = false;
		let infos = () => [];
		let probeRows = [];
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
						${options.after ?? ""}
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		await runInteractive(${JSON.stringify({ cwd: options.cwd, theme: "dark" })});
		console.log(JSON.stringify({ pickerItems, pickedIndex, infos: infos(), resumed, probeRows }));
	`;
}

async function runScene(
	options: { cwd: string; home: string },
	env: Record<string, string> = {},
	after?: string,
): Promise<{
	pickerItems: Array<{ label: string; description: string }>;
	pickedIndex: number | null;
	infos: string[];
	resumed: boolean;
	probeRows: string[];
}> {
	const proc = Bun.spawn([process.execPath, "--eval", sceneScript({ cwd: options.cwd, after })], {
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

	test("a resumed session's shell ledger is read at the swap — /ps lists what it left", async () => {
		const home = tempDir("lbb-resume-picker-home-");
		const cwd = tempDir("lbb-resume-picker-cwd-");
		const planted = SessionStore.startNew(cwd, home);
		planted.appendMessage(userMessage("PLANTED QUESTION"));
		// A shell the planted session's previous run left running. This test
		// process's own pid, alive by construction while the scene probes it —
		// the read, not the process, is what is under test.
		planted.appendCustom("shell_start", {
			shellId: "shell_1",
			pid: process.pid,
			command: "npm run dev",
			cwd,
			startedAt: Date.now(),
			outputFile: join(cwd, "dev.log"),
		});

		const outcome = await runScene(
			{ cwd, home },
			{},
			`await onCommand("/ps");
			const psDeadline = Date.now() + 8000;
			while (!pickerItems.some((item) => item.label.startsWith("pid-")) && Date.now() < psDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}`,
		);

		expect(outcome.resumed).toBe(true);
		// The row came from the ledger read at the swap: startup read the empty
		// session this process began in, so without a re-read the picker has no
		// pid to offer and /stop has nothing to end.
		const labels = outcome.pickerItems.map((item) => item.label);
		expect(labels.some((label) => label.startsWith(`pid-${process.pid}`))).toBe(true);
		// And the swap says so, in the voice startup uses for the same fact.
		expect(outcome.infos.join("\n")).toContain("1 background shell from a previous run is still running");
	}, 30_000);

	test("a resumed shell seen to die stops claiming running, and its age freezes there", async () => {
		const home = tempDir("lbb-resume-picker-home-");
		const cwd = tempDir("lbb-resume-picker-cwd-");
		const planted = SessionStore.startNew(cwd, home);
		planted.appendMessage(userMessage("PLANTED QUESTION"));
		// The process the planted ledger points at, owned by this test: it lives
		// far longer than the scene needs, and the scene ends it at a moment the
		// scene itself chooses — never on a race with the child's own exit.
		const shellProc = Bun.spawn([process.execPath, "--eval", "setTimeout(() => process.exit(0), 60_000)"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		const pid = shellProc.pid;
		try {
			planted.appendCustom("shell_start", {
				shellId: "shell_1",
				pid,
				command: "npm run dev",
				cwd,
				startedAt: Date.now(),
				outputFile: join(cwd, "dev.log"),
			});

			const outcome = await runScene(
				{ cwd, home },
				{},
				`
				const nextRow = async () => {
					const seenBefore = pickerItems.length;
					await onCommand("/ps");
					const deadline = Date.now() + 8000;
					while (Date.now() < deadline) {
						const fresh = pickerItems.slice(seenBefore).find((item) => item.label.startsWith("pid-"));
						if (fresh) return fresh.description;
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					return "";
				};
				probeRows.push(await nextRow());
				process.kill(${pid}, "SIGKILL");
				const goneDeadline = Date.now() + 8000;
				for (;;) {
					try {
						process.kill(${pid}, 0);
					} catch {
						break;
					}
					if (Date.now() > goneDeadline) break;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				probeRows.push(await nextRow());
				await new Promise((resolve) => setTimeout(resolve, 1500));
				probeRows.push(await nextRow());
				`,
			);

			// The first look found it alive, as the OS still did.
			expect(outcome.probeRows[0]?.startsWith("running")).toBe(true);
			// The second look asked again: the process is killed and gone, so the
			// row switches to the terminal word instead of repeating the read-time
			// verdict — this is the lazy observation, end to end.
			expect(outcome.probeRows[1]?.startsWith("ended")).toBe(true);
			// And once ended the age stops moving: a later screen shows the same
			// number, not one counting this program's watch.
			expect(outcome.probeRows[2]).toBe(outcome.probeRows[1]);
		} finally {
			if (shellProc.exitCode === null) shellProc.kill("SIGKILL");
			await shellProc.exited;
		}
	}, 30_000);
});
