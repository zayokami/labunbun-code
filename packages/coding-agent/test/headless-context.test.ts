/**
 * What a `-p` run puts in front of the model.
 *
 * The REPL has always sent the memory files, expanded a `/skill-x` into the
 * skill's body, and offered the Task tool with the agent definitions it found.
 * A `-p` run sent none of them: the same prompt ran with no project memory, a
 * `/skill-x` reached the model as the literal text `/skill-x`, and a Task call
 * was not a tool the model had. That made the two modes disagree about what the
 * agent *is* — silently, because a run with no memory and a run whose memory is
 * empty look identical from the outside.
 *
 * Each scene runs the real `runHeadless` in a child process, with the transport
 * scripted, and asserts on what the transport was asked for. A child and not
 * this process because every one of these reads the user tier through
 * `homedir()`: the files planted below live in a temp home that the child gets
 * as `HOME`/`USERPROFILE`, and nothing this test sets is left behind for the
 * rest of the suite to trip over. No network, no key, nothing billed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveProjectDefinitions } from "../src/project-trust.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
	home: string;
	cwd: string;
}

function fixture(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "lbb-headless-ctx-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-headless-ctx-cwd-"));
	roots.push(home, cwd);
	return { home, cwd };
}

/** Plant a file inside the temp tree, creating the directories it needs. */
function plant(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

interface Seen {
	code: number;
	/** The system prompt of every request the transport saw, in order. */
	systemPrompts: string[];
	/** Every request's messages, stringified — content shape is not the point here. */
	messages: string[];
	/** The tool names advertised on every request, in order. */
	toolNames: string[][];
	/** Everything the run said on stderr, warnings included. */
	stderr: string;
}

/**
 * One `-p` run, reporting what the model was sent.
 *
 * The run's own stdout is captured inside the child so the single JSON line
 * below is the whole of it: `-p` writes a result object to stdout, and this test
 * is about the requests, not the reporting.
 */
async function runScene(options: { prompt: string; steps: unknown[] }, f: Fixture): Promise<Seen> {
	const script = `
		import { fauxProvider } from "@labunbun/ai";
		import { runHeadless } from "./src/headless.ts";
		const faux = fauxProvider(${JSON.stringify(options.steps)});
		const chunks = [];
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
		let code = -1;
		try {
			code = await runHeadless({
				prompt: ${JSON.stringify(options.prompt)},
				modelRef: "anthropic/claude-haiku-4-5",
				cwd: ${JSON.stringify(f.cwd)},
				noSession: true,
				outputFormat: "json",
				streamFn: faux.streamFn,
			});
		} finally {
			process.stdout.write = write;
		}
		console.log(JSON.stringify({
			code,
			systemPrompts: faux.receivedContexts.map((context) => context.systemPrompt),
			messages: faux.receivedContexts.map((context) => JSON.stringify(context.messages)),
			toolNames: faux.receivedContexts.map((context) => (context.tools ?? []).map((tool) => tool.name)),
		}));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: f.home, USERPROFILE: f.home },
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
	return { ...(JSON.parse(stdout.trim()) as Omit<Seen, "stderr">), stderr };
}

describe("a `-p` run and what the REPL always sent with it", () => {
	test("carries the memory files, project and user", async () => {
		const f = fixture();
		plant(join(f.cwd, "LABUNBUN.md"), "PROJECT-MEMORY-MARKER\n");
		plant(join(f.home, ".labunbun", "MEMORY.md"), "USER-MEMORY-MARKER\n");

		const seen = await runScene({ prompt: "hello", steps: [{ text: "done" }] }, f);

		expect(seen.code).toBe(0);
		// Both tiers, and in the one place memory belongs: the system prompt, where
		// it is stable across the run and so does not cost a cache miss per turn.
		expect(seen.systemPrompts[0]).toContain("PROJECT-MEMORY-MARKER");
		expect(seen.systemPrompts[0]).toContain("USER-MEMORY-MARKER");
	});

	test("expands a skill named on the command line instead of sending the line", async () => {
		const f = fixture();
		plant(
			join(f.home, ".labunbun", "skills", "echo", "SKILL.md"),
			"---\nname: echo\ndescription: says it back\n---\nSKILL-BODY-MARKER for $ARGUMENTS\n",
		);

		const seen = await runScene({ prompt: "/skill-echo the-args", steps: [{ text: "done" }] }, f);

		expect(seen.code).toBe(0);
		expect(seen.messages[0]).toContain("SKILL-BODY-MARKER");
		// The arguments the user typed reach the body, not the model's view of the
		// name — the same expansion the REPL runs for the same line.
		expect(seen.messages[0]).toContain("the-args");
		expect(seen.messages[0]).not.toContain("/skill-echo");
	});

	test("offers the Task tool, and a user-tier definition is what the subagent is told to be", async () => {
		const f = fixture();
		plant(
			join(f.home, ".labunbun", "agents", "helper.md"),
			"---\nname: helper\ndescription: helps with one thing\n---\nAGENT-BODY-MARKER\n",
		);

		const seen = await runScene(
			{
				prompt: "delegate this",
				steps: [
					{
						toolCalls: [
							{
								name: "Task",
								arguments: { description: "look it up", prompt: "SUBAGENT-QUESTION", subagent_type: "helper" },
							},
						],
					},
					{ text: "SUBAGENT-REPORT" },
					{ text: "done" },
				],
			},
			f,
		);

		expect(seen.code).toBe(0);
		// A tool the model cannot see is a tool it cannot call: the Task tool is in
		// the request's own tool list, not merely in this file's intent.
		expect(seen.toolNames[0]).toContain("Task");
		// Three requests: the parent's, the subagent's, and the parent's again
		// carrying the report. The subagent's system prompt is the definition's body
		// — which is the only proof that the definition was loaded *and* used.
		const subagent = seen.systemPrompts.find((prompt) => prompt.includes("AGENT-BODY-MARKER"));
		expect(subagent).toBeDefined();
		const subagentRequest = seen.messages.find((messages) => messages.includes("SUBAGENT-QUESTION"));
		expect(subagentRequest).toBeDefined();
		// And its report came back to the parent as a tool result.
		expect(seen.messages.at(-1)).toContain("SUBAGENT-REPORT");
	}, 30_000);

	test("a project's definitions are not loaded until they are trusted", async () => {
		const f = fixture();
		plant(
			join(f.cwd, ".labunbun", "skills", "echo", "SKILL.md"),
			"---\nname: echo\ndescription: says it back\n---\nPROJECT-SKILL-BODY for $ARGUMENTS\n",
		);
		plant(
			join(f.cwd, ".labunbun", "agents", "helper.md"),
			"---\nname: helper\ndescription: helps\n---\nPROJECT-AGENT-BODY\n",
		);

		const seen = await runScene(
			{
				prompt: "/skill-echo the-args",
				steps: [
					{
						toolCalls: [
							{ name: "Task", arguments: { description: "look it up", prompt: "Q", subagent_type: "helper" } },
						],
					},
					{ text: "done" },
				],
			},
			f,
		);

		expect(seen.code).toBe(0);
		// A `-p` run has no dialog to approve anything with, so the project tier is
		// simply not there: the skill line is sent as the text it was rather than
		// expanded, and the repository's agent type is one the Task tool does not know.
		expect(seen.messages[0]).toContain("/skill-echo the-args");
		expect(seen.messages.join("\n")).not.toContain("PROJECT-SKILL-BODY");
		expect(seen.messages.join("\n")).toContain("Unknown agent type: helper");
		// And it says so, because a scripted run that silently drops a repository's
		// skills is indistinguishable from one whose skills never existed.
		expect(seen.stderr).toContain("this project's definitions are not loaded");
		expect(seen.stderr).toContain("1 agent definition, 1 skill");
	}, 30_000);

	test("an approved project's definitions are loaded, out of the same ledger", async () => {
		const f = fixture();
		plant(
			join(f.cwd, ".labunbun", "skills", "echo", "SKILL.md"),
			"---\nname: echo\ndescription: says it back\n---\nPROJECT-SKILL-BODY for $ARGUMENTS\n",
		);
		plant(
			join(f.cwd, ".labunbun", "agents", "helper.md"),
			"---\nname: helper\ndescription: helps\n---\nPROJECT-AGENT-BODY\n",
		);
		// The same call the REPL's `/agents approve` makes, in-process: this is the
		// `-p` side of the one decision, and it has to read the one record.
		approveProjectDefinitions(f.cwd, ["agents", "skills"], f.home);

		const seen = await runScene(
			{
				prompt: "/skill-echo the-args",
				steps: [
					{
						toolCalls: [
							{ name: "Task", arguments: { description: "look it up", prompt: "Q", subagent_type: "helper" } },
						],
					},
					{ text: "SUBAGENT-REPORT" },
					{ text: "done" },
				],
			},
			f,
		);

		expect(seen.code).toBe(0);
		expect(seen.messages[0]).toContain("PROJECT-SKILL-BODY");
		// The project agent is the subagent's system prompt, exactly as a user-tier
		// one is: the gate decides what loads, not what a loaded definition means.
		expect(seen.systemPrompts.some((prompt) => prompt.includes("PROJECT-AGENT-BODY"))).toBe(true);
		expect(seen.messages.at(-1)).toContain("SUBAGENT-REPORT");
		expect(seen.stderr).not.toContain("not loaded");
	}, 30_000);
});
