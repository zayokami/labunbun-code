#!/usr/bin/env bun
/**
 * Demo: the checkpoint ledger, and the line a resumed run prints.
 *
 * Two halves, each mirroring a test in
 * `packages/coding-agent/test/checkpoint-headless.test.ts`:
 *
 *   1. a real `-p` run against a local stub model — the stub asks for one Bash
 *      call, a real failing test runs, and the checkpoint entry the finished
 *      call left in the session file is printed.
 *   2. a planted session and a blocking `UserPromptSubmit` hook — the resumed
 *      run cannot reach a model at all, and the recovery line it prints about
 *      the ledger is the second half's output.
 *
 * No network beyond loopback and no real keys: the model is a stub the
 * settings point at (`127.0.0.1`), the key is a fake literal, and every home
 * is a temp directory. The real home is never read.
 *
 * Usage: bun run scripts/checkpoint-demo.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../packages/agent/src/index.ts";
import { assistantMessage, userMessage } from "../packages/ai/src/index.ts";
import { type StubStep, startCacheStub } from "../packages/ai/test/cache-stub-server.ts";

const CLI = join(import.meta.dir, "..", "packages", "coding-agent", "bin", "labunbun.ts");

const roots: string[] = [];
const stubs: Array<ReturnType<typeof startCacheStub>> = [];

function cleanup(): void {
	for (const stub of stubs.splice(0)) stub.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/**
 * A temp directory, physically spelled: on macOS `tmpdir()` is a symlink and
 * the child keys its session store by its own physical `process.cwd()`, while
 * this process would keep the symbolic spelling — two sizes of the same path.
 */
function scratch(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(dir);
	return dir;
}

/** A home whose settings point the child at the stub: loopback only, fake key only. */
function writeStubHome(home: string, stub: ReturnType<typeof startCacheStub>): void {
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

async function main(): Promise<void> {
	console.log("# checkpoint demo — local stub model, temp home, loopback only");

	// --- 1. a real run writes its ledger ---------------------------------

	const stubHome = scratch("lbb-demo-cp-a-home-");
	const stubProject = scratch("lbb-demo-cp-a-proj-");
	const fails = join(stubProject, "fails.test.ts");
	writeFileSync(
		fails,
		'import { test, expect } from "bun:test";\ntest("demo sees me fail", () => {\n\texpect(1).toBe(2);\n});\n',
	);
	// The repo's own invocation shape: quoted, path-qualified, forward slashes
	// so the shell that runs it does not read the backslashes as escapes.
	const command = `"${process.execPath.replace(/\\/g, "/")}" test "${fails.replace(/\\/g, "/")}"`;
	const steps: StubStep[] = [{ tool: { name: "Bash", input: { command } } }, { text: "the suite is red" }];
	const stub = startCacheStub({ steps, modelId: "stub-model" });
	stubs.push(stub);
	writeStubHome(stubHome, stub);

	console.log("\n# 1. a real -p run: the stub asks for one Bash call, and a real test runs");
	const first = await runCli(stubProject, ["-p", "run the failing suite"], stubHome, { STUB_KEY: "stub-key-for-demo" });
	console.log(`  child exit: ${first.exitCode}`);
	console.log(`  child answer: ${first.stdout.trim()}`);

	const sessionPath = newestSessionPath(stubProject, stubHome);
	const checkpoints = fileEntries(sessionPath).filter(
		(entry) => entry.type === "custom" && entry.kind === "checkpoint",
	);
	console.log(`  session file: ${sessionPath}`);
	for (const checkpoint of checkpoints) {
		console.log(`  checkpoint entry: ${JSON.stringify(checkpoint.data)}`);
	}
	if (first.exitCode !== 0 || checkpoints.length !== 1) {
		throw new Error("the stub run did not leave exactly one checkpoint — the demo cannot continue");
	}

	// --- 2. a planted session says what it holds, on resume ---------------

	const plantedHome = scratch("lbb-demo-cp-b-home-");
	const plantedProject = scratch("lbb-demo-cp-b-proj-");
	const notes = join(plantedProject, "notes.txt");

	const planted = SessionStore.startNew(plantedProject, plantedHome);
	planted.appendCustom("checkpoint", {
		at: Date.now() - 60_000,
		callId: "c1",
		toolName: "Write",
		isError: false,
		filesTouched: [{ path: notes, beforeHash: null, afterHash: "aa" }],
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
	planted.appendMessage(assistantMessage({ content: [{ type: "text", text: "PLANTED ANSWER" }], stopReason: "stop" }));

	const blockScript = join(plantedProject, "block.mjs");
	writeFileSync(blockScript, `console.log(JSON.stringify({ decision: "block", reason: "stop here" }));\n`);
	mkdirSync(join(plantedHome, ".labunbun"), { recursive: true });
	writeFileSync(
		join(plantedHome, ".labunbun", "settings.json"),
		JSON.stringify({
			hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${process.execPath} ${blockScript}` }] }] },
		}),
	);

	const sessionId = planted.sessionId;
	if (!sessionId) throw new Error("the planted session has no id");

	console.log("\n# 2. a planted session + a blocking hook: the resume never reaches a model");
	const second = await runCli(plantedProject, ["-p", "carry on", "--resume", sessionId], plantedHome);
	console.log(`  child exit: ${second.exitCode}`);
	for (const line of second.stderr.split("\n")) {
		if (line.trim().length > 0) console.log(`  child stderr: ${line.trim()}`);
	}
	if (second.exitCode !== 1 || !second.stderr.includes("Resumed:")) {
		throw new Error("the resumed run did not print a recovery line");
	}
}

try {
	await main();
} finally {
	cleanup();
}
