/**
 * The tool ledger, from the outside: what a real session leaves in its file.
 *
 * The unit tests drive the readers over hand-built entries; this runs the
 * whole app — startup, the agent loop, the Edit and Write tools, `/compact` —
 * in a child process with a scripted transport, and reads back the session file
 * the app actually wrote. That split is the point: the hashes asserted below
 * are computed in this file with `node:crypto`, so a checkpoint written with
 * the wrong string (a constant, the after content in the before slot, the input
 * instead of the file) fails here even if every reader agrees with itself.
 *
 * The second scene is the compaction case, and it needs a session left behind
 * by an earlier process to be real: the entries a pass must re-send are exactly
 * the ones a fresh run would not have. The shell it plants is invented — a
 * `shell_start` in the file, no process behind it — because the re-send pairs
 * by the record, not by the OS, and a test that spawned a real background shell
 * to prove a file line was copied would be paying for something the line does
 * not mean.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { assistantMessage, userMessage } from "@labunbun/ai";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp directory that is cleaned up with the run. */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Every JSONL line of a session file, parsed. */
function fileEntries(
	path: string,
): Array<{ type?: string; kind?: string; id?: string; data?: Record<string, unknown> }> {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { type?: string; kind?: string; id?: string; data?: Record<string, unknown> });
}

/** The session file the run left behind — the newest in the project. */
function sessionFile(cwd: string, home: string): string {
	const sessions = [...SessionStore.listSessions(cwd, home)].sort((a, b) => a.mtimeMs - b.mtimeMs);
	const last = sessions.at(-1);
	if (!last) throw new Error("no session file was written");
	return last.path;
}

interface Step {
	text?: string;
	tool?: { name: string; arguments: Record<string, unknown> };
}

interface Scene {
	steps: Step[];
	/** What the scene does inside `waitUntilExit`, with `session`, `onCommand` and `waitFor` in scope. */
	run: string;
	continueLast?: boolean;
}

/** The whole app in a child process: scripted transport, recording REPL, one scene. */
async function runScene(
	scene: Scene,
	options: { cwd: string; home: string },
): Promise<{ code: number; infos: string[] }> {
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const STEPS = ${JSON.stringify(scene.steps)};
		let call = 0;
		let infos = () => [];
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			// Startup would otherwise ask the providers what they serve, over the
			// network. There is nothing to serve to a scripted run.
			refreshModelCatalog: async () => null,
			createDefaultStreamFn: () => async function* (model) {
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				const step = STEPS[Math.min(call++, STEPS.length - 1)];
				if (step.tool) {
					yield builder.toolCallStart(0, "call-" + call, step.tool.name);
					yield builder.toolCallDelta(0, JSON.stringify(step.tool.arguments ?? {}));
					yield builder.toolCallEnd(0);
					yield builder.done("toolUse");
					return;
				}
				yield builder.textStart(0);
				yield builder.textDelta(0, step.text ?? "");
				yield builder.textEnd(0);
				yield builder.done("stop");
			}
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: (options) => {
				const { onCommand } = options;
				let state = { entries: [] };
				let session = options.session;
				infos = () => state.entries.filter((entry) => entry.kind === "info").map((entry) => entry.text);
				const waitFor = async (text, ms = 20000) => {
					const deadline = Date.now() + ms;
					while (!infos().some((line) => line.includes(text)) && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
				};
				return {
					setTasks() {}, setContextInfo() {}, setBackgroundShells() {}, setModelName() {},
					setSession(next) { session = next; },
					store: { set(update) { state = typeof update === "function" ? update(state) : { ...state, ...update }; } },
					// The scene's user allows every tool: what is under test is the
					// record a permitted call leaves, not the permission path.
					requestPermission: async () => true,
					askUser: async () => null,
					clearPermissionRequest() {}, clearQuestionRequest() {},
					waitUntilExit: async () => {
						${scene.run}
					}
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const code = await runInteractive(${JSON.stringify({
			cwd: options.cwd,
			home: options.home,
			theme: "dark",
			continueLast: scene.continueLast === true,
		})});
		console.log(JSON.stringify({ code, infos: infos() }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
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
	return JSON.parse(stdout.trim()) as { code: number; infos: string[] };
}

describe("a session's finished tool calls", () => {
	test("leave one checkpoint each, with the file's real sha256 on both sides", async () => {
		const cwd = tempDir("lbb-cpe2e-a-cwd-");
		const home = tempDir("lbb-cpe2e-a-home-");
		const target = join(cwd, "notes.txt");

		const outcome = await runScene(
			{
				steps: [
					{ tool: { name: "Write", arguments: { file_path: target, content: "v1\n" } } },
					{ tool: { name: "Edit", arguments: { file_path: target, old_string: "v1", new_string: "v2" } } },
					// A third call that fails: the needle is not in the file, so the
					// edit refuses. Its entry is where the null-after semantics is
					// pinned — failed must read as "no fingerprint", not as a hash of
					// whatever the file happens to hold.
					{ tool: { name: "Edit", arguments: { file_path: target, old_string: "nope", new_string: "v3" } } },
					{ text: "done" },
				],
				run: `await session.prompt("do the work");`,
			},
			{ cwd, home },
		);

		expect(outcome.code).toBe(0);
		// The tools ran for real: the file exists with the edited content, and the
		// hashes below are of the strings that make that file.
		expect(readFileSync(target, "utf8")).toBe("v2\n");

		const entries = fileEntries(sessionFile(cwd, home));
		const checkpoints = entries.filter((entry) => entry.type === "custom" && entry.kind === "checkpoint");
		expect(checkpoints).toHaveLength(3);
		const write = checkpoints[0]?.data ?? {};
		const edit = checkpoints[1]?.data ?? {};
		const refused = checkpoints[2]?.data ?? {};

		expect(write.toolName).toBe("Write");
		expect(write.isError).toBe(false);
		expect(write.filesTouched).toEqual([{ path: target, beforeHash: null, afterHash: sha256("v1\n") }]);
		expect(write.inputSummary).toBe(target);
		expect(write.truncated).toBeUndefined();
		expect(typeof write.at).toBe("number");

		expect(edit.toolName).toBe("Edit");
		expect(edit.isError).toBe(false);
		// The before side is v1 — the same read that fed /rewind — not a second
		// look at a file the edit was about to change.
		expect(edit.filesTouched).toEqual([{ path: target, beforeHash: sha256("v1\n"), afterHash: sha256("v2\n") }]);

		expect(refused.toolName).toBe("Edit");
		expect(refused.isError).toBe(true);
		expect(refused.filesTouched).toEqual([{ path: target, beforeHash: sha256("v2\n"), afterHash: null }]);

		// One call, one identity: the entries are three calls, not one recorded thrice.
		expect(write.callId).toBeTruthy();
		expect(edit.callId).toBeTruthy();
		expect(refused.callId).toBeTruthy();
		expect(new Set([write.callId, edit.callId, refused.callId]).size).toBe(3);

		// Each Edit's before side left the /rewind payload it is about — including
		// the refused one, which snapshotted v2 before finding nothing to change.
		const fileCheckpoints = entries.filter((entry) => entry.type === "custom" && entry.kind === "file_checkpoint");
		expect(fileCheckpoints.map((entry) => (entry.data as { content?: string }).content)).toEqual(["v1\n", "v2\n"]);
	}, 30_000);
});

describe("a compaction pass", () => {
	test("re-sends the latest file checkpoint and the open shell starts, onto the new chain", async () => {
		const cwd = tempDir("lbb-cpe2e-b-cwd-");
		const home = tempDir("lbb-cpe2e-b-home-");
		const target = join(cwd, "notes.txt");
		// A pid no process has: the re-send copies the record, and nothing in this
		// scene asks the OS about it.
		const plantedPid = 9_000_001;

		// The session a previous run left behind: something to compact, and one
		// shell whose start never met an end.
		const planted = SessionStore.startNew(cwd, home);
		planted.appendCustom("shell_start", {
			shellId: "sh-planted",
			pid: plantedPid,
			command: "sleep 999",
			cwd,
			startedAt: Date.now(),
			outputFile: join(cwd, "sh.log"),
		});
		planted.appendMessage(userMessage("PLANTED QUESTION"));
		planted.appendMessage(
			assistantMessage({ content: [{ type: "text", text: "PLANTED ANSWER" }], stopReason: "stop" }),
		);

		const outcome = await runScene(
			{
				continueLast: true,
				steps: [
					{ tool: { name: "Write", arguments: { file_path: target, content: "v1\n" } } },
					{ tool: { name: "Edit", arguments: { file_path: target, old_string: "v1", new_string: "v2" } } },
					{ text: "done" },
					{ text: "<summary>what happened so far</summary>" },
				],
				run: `
					await session.prompt("do the work");
					await onCommand("/compact");
					await waitFor("Conversation compacted");
				`,
			},
			{ cwd, home },
		);

		expect(outcome.code).toBe(0);
		expect(outcome.infos.join("\n")).toContain("Conversation compacted");

		const entries = fileEntries(planted.path);
		const lastCompaction = entries.map((entry) => entry.type).lastIndexOf("compaction");
		expect(lastCompaction).toBeGreaterThanOrEqual(0);

		// Each entry exists twice: what the call wrote, and the copy the pass made
		// when it re-rooted the chain. Destructured rather than indexed, so a
		// missing entry is a plain test failure and not an undefined dereference.
		const fileCheckpoints = entries.filter((entry) => entry.type === "custom" && entry.kind === "file_checkpoint");
		expect(fileCheckpoints).toHaveLength(2);
		const [firstCheckpoint, copiedCheckpoint] = fileCheckpoints;
		expect(copiedCheckpoint?.data).toEqual(firstCheckpoint?.data);
		const copiedCheckpointIndex = copiedCheckpoint === undefined ? -1 : entries.indexOf(copiedCheckpoint);
		expect(copiedCheckpointIndex).toBeGreaterThan(lastCompaction);

		const shellStarts = entries.filter((entry) => entry.type === "custom" && entry.kind === "shell_start");
		expect(shellStarts).toHaveLength(2);
		const [firstShell, copiedShell] = shellStarts;
		expect(copiedShell?.data).toEqual(firstShell?.data);
		expect((copiedShell?.data as { pid?: number } | undefined)?.pid).toBe(plantedPid);
		const copiedShellIndex = copiedShell === undefined ? -1 : entries.indexOf(copiedShell);
		expect(copiedShellIndex).toBeGreaterThan(lastCompaction);

		// And the copies are on the active chain while the originals are not — the
		// one contrast that makes the re-send the reason this test exists. Reading
		// the file back the way a resume does, from its last entry to its root.
		const loaded = SessionStore.load(planted.path);
		const linear = loaded.linearEntries();
		const chainCheckpoints = linear.filter((entry) => entry.type === "custom" && entry.kind === "file_checkpoint");
		expect(chainCheckpoints).toHaveLength(1);
		expect(chainCheckpoints[0]?.id === copiedCheckpoint?.id).toBe(true);
		const chainShells = linear.filter((entry) => entry.type === "custom" && entry.kind === "shell_start");
		expect(chainShells).toHaveLength(1);
		expect(chainShells[0]?.id === copiedShell?.id).toBe(true);
	}, 30_000);
});
