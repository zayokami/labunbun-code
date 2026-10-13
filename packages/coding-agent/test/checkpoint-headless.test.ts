/**
 * The tool ledger and the recovery protocol in `-p` runs, through the real CLI.
 *
 * Batch B wired the ledger's write points in the REPL only: the events existed
 * on both sides, and a `-p` run left no record of what it did. Unit-testing the
 * shared writer cannot catch a call site that was never attached — the gap this
 * file covers is a fact about the process, so it is asserted from outside one,
 * the way `hook-wiring.test.ts` asserts its events.
 *
 * Two fixtures, deliberately small:
 *
 *   - **the write point** needs a tool to really run, so its model is the local
 *     stub (`startCacheStub`) and the tool is a real `bun test` over a real
 *     failing test file — the failing-test names asserted below are the runner's
 *     own words, not a string this test wrote into a fake result.
 *   - **the recovery line** needs no model at all: a blocking `UserPromptSubmit`
 *     hook stops the run before the first request, so the only credentials in
 *     play are the fake key the stub fixture names and none at all in the rest.
 *     The home is a temp directory either way; the real one is never read.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { assistantMessage, userMessage } from "@labunbun/ai";
import { type StubStep, startCacheStub } from "../../ai/test/cache-stub-server.ts";

const CLI = join(import.meta.dir, "..", "bin", "labunbun.ts");

const roots: string[] = [];
const stubs: Array<ReturnType<typeof startCacheStub>> = [];

afterAll(() => {
	for (const stub of stubs.splice(0)) stub.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp directory that is cleaned up with the run. */
function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** A home whose settings point the child at the stub: loopback only, fake key only. */
function stubHome(home: string, stub: ReturnType<typeof startCacheStub>): void {
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(
		join(home, ".labunbun", "settings.json"),
		JSON.stringify({
			model: "stub/stub-model",
			providers: {
				openaiCompatible: [
					{
						id: "stub",
						baseUrl: stub.openAIBaseUrl,
						apiKeyEnv: "STUB_KEY",
						models: [{ id: "stub-model", contextWindow: 200_000, maxOutputTokens: 8_192 }],
					},
				],
			},
		}),
	);
}

/** A home whose UserPromptSubmit hook blocks, so the run never reaches a model. */
function blockingHome(home: string, scriptDir: string, reason: string): void {
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	const script = join(scriptDir, "block.mjs");
	writeFileSync(script, `console.log(JSON.stringify({ decision: "block", reason: ${JSON.stringify(reason)} }));\n`);
	writeFileSync(
		join(home, ".labunbun", "settings.json"),
		JSON.stringify({
			hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] },
		}),
	);
}

async function runCli(
	dir: string,
	args: string[],
	home: string,
	extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: dir,
		// Both names: homedir() reads USERPROFILE on Windows and HOME elsewhere.
		env: { ...process.env, USERPROFILE: home, HOME: home, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { exitCode: await proc.exited, stdout, stderr };
}

/** The session file the run left behind — the newest in the project. */
function newestSessionPath(cwd: string, home: string): string {
	const sessions = [...SessionStore.listSessions(cwd, home)].sort((a, b) => a.mtimeMs - b.mtimeMs);
	const last = sessions.at(-1);
	if (!last) throw new Error("no session file was written");
	return last.path;
}

/** Every JSONL line of a session file, parsed. */
function fileEntries(path: string): Array<{ type?: string; kind?: string; data?: Record<string, unknown> }> {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { type?: string; kind?: string; data?: Record<string, unknown> });
}

describe("a -p run", () => {
	test("leaves the ledger its finished calls wrote, failing tests included", async () => {
		const home = scratch("lbb-cphl-a-home-");
		const cwd = scratch("lbb-cphl-a-proj-");
		const fails = join(cwd, "fails.test.ts");
		writeFileSync(
			fails,
			'import { test, expect } from "bun:test";\ntest("ledger sees me fail", () => {\n\texpect(1).toBe(2);\n});\n',
		);
		// The repo's own invocation shape: quoted, path-qualified, forward slashes
		// so the shell that runs it does not read the backslashes as escapes.
		const command = `"${process.execPath.replace(/\\/g, "/")}" test "${fails.replace(/\\/g, "/")}"`;
		const steps: StubStep[] = [{ tool: { name: "Bash", input: { command } } }, { text: "the suite is red" }];
		const stub = startCacheStub({ steps, modelId: "stub-model" });
		stubs.push(stub);
		stubHome(home, stub);

		const result = await runCli(cwd, ["-p", "run the failing suite"], home, { STUB_KEY: "stub-key-for-tests" });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("the suite is red");

		const entries = fileEntries(newestSessionPath(cwd, home));
		const checkpoints = entries.filter((entry) => entry.type === "custom" && entry.kind === "checkpoint");
		expect(checkpoints).toHaveLength(1);
		const record = checkpoints[0]?.data ?? {};
		expect(record.toolName).toBe("Bash");
		expect(record.isError).toBe(true);
		// The runner's own words: `bun test` printed this name for a real failing
		// test, and the write point read it out of the real result.
		expect(record.failedTests).toEqual(["ledger sees me fail"]);
		expect(typeof record.at).toBe("number");
	}, 60_000);

	test("a resumed run says what the ledger holds, on stderr, before stopping", async () => {
		const home = scratch("lbb-cphl-b-home-");
		const cwd = scratch("lbb-cphl-b-proj-");
		const target = join(cwd, "notes.txt");

		// The session a previous run left: a conversation, and the ledger whose
		// clauses the one line has to carry.
		const planted = SessionStore.startNew(cwd, home);
		planted.appendCustom("checkpoint", {
			at: Date.now() - 60_000,
			callId: "c1",
			toolName: "Write",
			isError: false,
			filesTouched: [{ path: target, beforeHash: null, afterHash: "aa" }],
			inputSummary: "notes.txt",
		});
		planted.appendCustom("checkpoint", {
			at: Date.now() - 30_000,
			callId: "c2",
			toolName: "Bash",
			isError: true,
			inputSummary: "bun test",
			failedTests: ["parser > rejects empty"],
			nextStep: "Fixing the parser",
		});
		planted.appendMessage(userMessage("PLANTED QUESTION"));
		planted.appendMessage(
			assistantMessage({ content: [{ type: "text", text: "PLANTED ANSWER" }], stopReason: "stop" }),
		);
		blockingHome(home, cwd, "stop here");

		const sessionId = planted.sessionId;
		if (!sessionId) throw new Error("expected a session id");
		const result = await runCli(cwd, ["-p", "carry on", "--resume", sessionId], home);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Resumed: last Bash failed at ");
		expect(result.stderr).toContain("2 tool calls recorded");
		expect(result.stderr).toContain("1 file touched");
		expect(result.stderr).toContain("1 failing test");
		expect(result.stderr).toContain("Next: Fixing the parser.");
		expect(result.stderr).toContain("stop here");
		// Startup notice first, then the block: the line is what the run said
		// before it was stopped, not a side effect of stopping.
		expect(result.stderr.indexOf("Resumed:")).toBeLessThan(result.stderr.indexOf("stop here"));
		// stderr, not stdout: `-p`'s stdout is the answer stream, and this run
		// produced no answer for a startup notice to hide in.
		expect(result.stdout).not.toContain("Resumed");
	}, 60_000);

	test("-c continues the most recent session through the same loadout", async () => {
		const home = scratch("lbb-cphl-c-home-");
		const cwd = scratch("lbb-cphl-c-proj-");
		const planted = SessionStore.startNew(cwd, home);
		planted.appendCustom("checkpoint", {
			at: Date.now() - 30_000,
			callId: "c1",
			toolName: "Bash",
			isError: false,
			nextStep: "Ship the fix",
		});
		planted.appendMessage(userMessage("PLANTED QUESTION"));
		blockingHome(home, cwd, "stop here");

		const result = await runCli(cwd, ["-p", "carry on", "-c"], home);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Resumed: last Bash ok at ");
		expect(result.stderr).toContain("Next: Ship the fix.");
	}, 60_000);

	test("a fresh session prints no recovery line", async () => {
		const home = scratch("lbb-cphl-d-home-");
		const cwd = scratch("lbb-cphl-d-proj-");
		blockingHome(home, cwd, "stop here");

		const result = await runCli(cwd, ["-p", "hello"], home);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("stop here");
		expect(result.stderr).not.toContain("Resumed:");
	}, 60_000);

	test("--no-session with a resume target is refused, not half-honored", async () => {
		const home = scratch("lbb-cphl-e-home-");
		const cwd = scratch("lbb-cphl-e-proj-");

		const result = await runCli(cwd, ["-p", "x", "--no-session", "--resume", "abc"], home);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("--no-session cannot be combined with --resume");
	}, 60_000);
});
