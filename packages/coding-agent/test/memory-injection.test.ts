/**
 * Memory files must reach the model on every request, not only the first.
 *
 * LABUNBUN.md / AGENTS.md / `~/.labunbun/MEMORY.md` are the user's standing
 * instructions for a project — the house rules the agent is supposed to be
 * working under. If a conversation stops carrying them, the rules quietly stop
 * applying mid-session, with nothing on screen to say so: the one failure mode
 * the user cannot see and would not think to check.
 *
 * Driven through the real `runInteractive` in a subprocess with a mocked
 * transport, because what is under test is the wiring between the memory
 * loader and the request the session builds — a seam neither module shows on
 * its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { type AgentMessage, assistantMessage, userMessage } from "@labunbun/ai";
import { buildSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../src/system-prompt.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp directory that is cleaned up with the test that made it. */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

interface Request {
	systemPrompt: string;
	messages: AgentMessage[];
}

/**
 * What the provider was handed, per request, from a real REPL run.
 *
 * The transcript is captured as text as well as an array: the question is
 * whether the memory text is in the request at all, wherever the session chose
 * to put it, and a string search answers that without pinning the placement.
 */
async function conversation(options: {
	cwd: string;
	envHome: string;
	home?: string;
	prompts: string[];
	continueLast?: boolean;
}): Promise<Request[]> {
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const requests = [];
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			createDefaultStreamFn: () => async function* (_model, context) {
				requests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
				yield { type: "done", message: ai.assistantMessage({
					content: [{ type: "text", text: "ok" }], stopReason: "stop"
				}) };
			}
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: ({ session }) => ({
				setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
				store: { set() {} },
				waitUntilExit: async () => {
					for (const prompt of ${JSON.stringify(options.prompts)}) await session.prompt(prompt);
				}
			})
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		await runInteractive(${JSON.stringify({
			cwd: options.cwd,
			home: options.home,
			theme: "dark",
			continueLast: options.continueLast ?? false,
		})});
		console.log(JSON.stringify({ requests }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: options.envHome, USERPROFILE: options.envHome },
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
	return (JSON.parse(stdout.trim()) as { requests: Request[] }).requests;
}

/** How many times the memory text appears in one request, system prompt included. */
function timesCarried(request: Request, marker: string): number {
	let count = request.systemPrompt.split(marker).length - 1;
	for (const message of request.messages) {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		count += text.split(marker).length - 1;
	}
	return count;
}

const MARKER = "PROJECT RULE: always indent with tabs";

/** A memory file in the working directory, as a user would write one. */
function writeProjectMemory(cwd: string): void {
	writeFileSync(join(cwd, "LABUNBUN.md"), `# House rules\n\n${MARKER}\n`, "utf8");
}

describe("the system prompt", () => {
	const context = { cwd: "C:/work", platform: "win32", isTTY: true };

	test("carries memory when there is any, and does not mention it otherwise", () => {
		const plain = buildSystemPrompt([], context);
		expect(plain).not.toContain("# Project memory");
		// Whitespace is what an empty file loads as; a heading over nothing would
		// be a section the model is told to read and finds empty.
		expect(buildSystemPrompt([], { ...context, memory: "   \n" })).toBe(plain);
		expect(buildSystemPrompt([], { ...context, memory: MARKER })).toContain(`# Project memory\n${MARKER}`);
	});

	test("puts memory after the boundary that separates the stable part", () => {
		// The boundary is what a cache breakpoint can be hung on: everything above
		// it is the same bytes for every project. Memory differs per directory, so
		// it belongs below — and it goes last, closest to the conversation.
		const prompt = buildSystemPrompt([], { ...context, memory: MARKER });
		expect(prompt.indexOf(MARKER)).toBeGreaterThan(prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY));
		expect(prompt.endsWith(MARKER)).toBe(true);
	});
});

describe("memory reaches the model", () => {
	test("on the first request and on the ones after it", async () => {
		const cwd = tempDir("lbb-mem-cwd-");
		writeProjectMemory(cwd);

		const requests = await conversation({ cwd, envHome: cwd, prompts: ["first question", "second question"] });

		expect(requests).toHaveLength(2);
		// The first request is the easy one — an implementation that injects once
		// passes it. The second is the requirement: a conversation that keeps
		// working under rules it no longer carries is not following them.
		expect(timesCarried(requests[0], MARKER)).toBe(1);
		expect(timesCarried(requests[1], MARKER)).toBe(1);
	});

	test("after resuming a session that was saved before the rules existed", async () => {
		const cwd = tempDir("lbb-mem-resume-");
		const store = SessionStore.startNew(cwd, cwd);
		store.appendMessage(userMessage("an old question"));
		store.appendMessage(assistantMessage({ content: [{ type: "text", text: "an old answer" }], stopReason: "stop" }));
		writeProjectMemory(cwd);

		const requests = await conversation({
			cwd,
			envHome: cwd,
			prompts: ["and now?"],
			continueLast: true,
		});

		expect(requests).toHaveLength(1);
		expect(timesCarried(requests[0], MARKER)).toBe(1);
	});

	test("from the home the caller asked for, not the one the environment names", async () => {
		const cwd = tempDir("lbb-mem-cwd-");
		// Two temp homes: one the process environment points at, one passed as an
		// option. A loader that ignores its `home` argument reads the environment's
		// — in a test run that is the operator's own home directory, which is the
		// reason the argument exists at all.
		const envHome = tempDir("lbb-mem-envhome-");
		const optionHome = tempDir("lbb-mem-optionhome-");
		mkdirSync(join(optionHome, ".labunbun"), { recursive: true });
		writeFileSync(join(optionHome, ".labunbun", "MEMORY.md"), `${MARKER}\n`, "utf8");

		const requests = await conversation({ cwd, envHome, home: optionHome, prompts: ["hello"] });

		expect(requests).toHaveLength(1);
		expect(timesCarried(requests[0], MARKER)).toBe(1);
	});
});
