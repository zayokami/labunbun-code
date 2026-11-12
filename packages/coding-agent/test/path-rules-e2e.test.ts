/**
 * A path-scoped rule, seen from the request the model receives.
 *
 * The unit tests cover the reader and the matcher; what only a run of the whole
 * app can show is the seam: the rule is not in the startup prompt (a rule every
 * session pays for is the problem this feature exists to remove), and it is in
 * the request after the agent reads a file its globs match. Read through the
 * real `runInteractive` in a child process with a scripted transport, the same
 * shape `memory-injection.test.ts` uses for the startup half.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import { approveProjectDefinitions } from "../src/project-trust.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

interface Request {
	systemPrompt: string;
	messages: AgentMessage[];
}

function textOf(messages: AgentMessage[]): string {
	return JSON.stringify(messages);
}

/** Every request's system prompt and transcript, as text, in order. */
async function sceneRequests(scene: {
	cwd: string;
	home: string;
	tools: Array<{ name: string; arguments: Record<string, unknown> }>;
	prompts: string[];
}): Promise<Request[]> {
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const TOOLS = ${JSON.stringify(scene.tools)};
		const requests = [];
		let call = 0;
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			refreshModelCatalog: async () => null,
			createDefaultStreamFn: () => async function* (model, context) {
				requests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				const index = call++;
				const tool = TOOLS[index];
				if (tool) {
					yield builder.toolCallStart(0, "call-" + index, tool.name);
					yield builder.toolCallDelta(0, JSON.stringify(tool.arguments));
					yield builder.toolCallEnd(0);
					yield builder.done("toolUse");
					return;
				}
				yield builder.textStart(0);
				yield builder.textDelta(0, "ok");
				yield builder.textEnd(0);
				yield builder.done("stop");
			}
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: ({ session }) => ({
				setTasks() {}, setContextInfo() {}, setBackgroundShells() {}, setModelName() {},
				store: { set() {} },
				requestPermission: async () => true,
				askUser: async () => null,
				clearPermissionRequest() {}, clearQuestionRequest() {},
				waitUntilExit: async () => {
					for (const prompt of ${JSON.stringify(scene.prompts)}) await session.prompt(prompt);
				}
			})
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const code = await runInteractive(${JSON.stringify({ cwd: scene.cwd, home: scene.home, theme: "dark" })});
		console.log(JSON.stringify({ code, requests }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: scene.home, USERPROFILE: scene.home },
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

const MARKER = "SCOPED RULE: every handler answers with the envelope";

describe("a path-scoped rule in a live session", () => {
	test("is absent from the prompt and arrives with the matching read", async () => {
		const cwd = tempDir("lbb-path-e2e-cwd-");
		const home = tempDir("lbb-path-e2e-home-");
		mkdirSync(join(cwd, "src", "api"), { recursive: true });
		writeFileSync(join(cwd, "src", "api", "handler.ts"), "export const handler = 1;\n", "utf8");
		writeFileSync(join(cwd, "README.md"), "# notes\n", "utf8");
		mkdirSync(join(cwd, ".labunbun", "rules"), { recursive: true });
		writeFileSync(join(cwd, ".labunbun", "rules", "api.md"), `---\npaths:\n  - src/api/**\n---\n${MARKER}\n`, "utf8");
		approveProjectDefinitions(cwd, ["memory"], home);

		const requests = await sceneRequests({
			cwd,
			home,
			// The first read does not match the glob; the second does.
			tools: [
				{ name: "Read", arguments: { file_path: join(cwd, "README.md") } },
				{ name: "Read", arguments: { file_path: join(cwd, "src", "api", "handler.ts") } },
			],
			prompts: ["look at the readme", "now the handler"],
		});

		expect(requests).toHaveLength(4);
		// Startup never carried it, and neither did the request after the miss.
		expect(requests[0].systemPrompt).not.toContain(MARKER);
		expect(textOf(requests[1].messages)).not.toContain(MARKER);
		// The matching read attached it to its own tool result, so the next request
		// carries it — and it stays, like any other tool result would.
		expect(textOf(requests[2].messages)).toContain(MARKER);
		expect(textOf(requests[2].messages)).toContain("[path rule");
		expect(textOf(requests[3].messages)).toContain(MARKER);
	});
});
