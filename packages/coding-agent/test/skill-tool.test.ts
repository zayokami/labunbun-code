/**
 * The Skill tool: the model's own door to the skill bodies a user reaches
 * through `/skill-<name>`.
 *
 * Two claims, with the first holding the second honest:
 *
 * 1. **One rendering.** The tool and the slash command expand a body through
 *    the same `renderSkillPrompt`, and this file asserts the two outputs are
 *    equal for the same skill and arguments — not merely similar. A skill whose
 *    `$ARGUMENTS` means one thing to the user who typed it and another thing to
 *    the model that called the tool is exactly the drift the shared function
 *    exists to prevent, and an assertion of a substring would not catch it.
 * 2. **Both tool tables.** The tool has to be in the list the session is born
 *    with and in the list a subagent is spawned with — the two closures
 *    `interactive.ts` builds. They are closure state, so the second half of
 *    this file runs the real REPL in a subprocess with the transport and the
 *    TUI mocked (the pattern the other REPL tests use) and reads the tool names
 *    the model was handed off every request, the subagent's included.
 *
 * The fixtures build their own skills in temp directories: the repository's own
 * `.labunbun/skills` grows and renames over time, and a test that hardcodes one
 * of its names is a test about the checkout, not about the loader.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillTool } from "../src/skill-tool.ts";
import { loadSkills, type Skill, skillsAsCommands } from "../src/skills.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** The skills a fresh `{ home, cwd }` pair loads from the user tier. */
function fixture(files: Record<string, string>): { home: string; cwd: string; skills: Skill[] } {
	const home = tempDir("lbb-skill-tool-home-");
	const cwd = tempDir("lbb-skill-tool-cwd-");
	for (const [path, content] of Object.entries(files)) {
		const full = join(home, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return { home, cwd, skills: loadSkills(cwd, home) };
}

function skillFile(frontmatter: string, body: string): string {
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

const CTX = {
	callId: "skill-test",
	signal: new AbortController().signal,
	cwd: process.cwd(),
	sandbox: "workspace-write" as const,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

describe("invoking a skill through the tool", () => {
	test("a known name returns the body, rendered exactly as the slash command renders it", async () => {
		const { skills } = fixture({
			".labunbun/skills/echo/SKILL.md": skillFile("description: says it back", "ECHO-BODY for $ARGUMENTS"),
		});
		const tool = createSkillTool(skills);
		const result = await tool.call({ name: "echo", args: "the-args" }, CTX);

		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toContain("ECHO-BODY for the-args");
		// The equality is the point: the two paths share `renderSkillPrompt`, and
		// this is what keeps a later edit from forking it quietly.
		const [command] = skillsAsCommands(skills);
		if (command.type !== "prompt") throw new Error("skills are prompt commands");
		expect(textOf(result)).toBe(command.getPrompt("the-args"));
	});

	test("an invocation with no arguments renders the bare command's expansion", async () => {
		const { skills } = fixture({
			".labunbun/skills/plain/SKILL.md": skillFile("description: no placeholders", "Deploy the checklist."),
		});
		const tool = createSkillTool(skills);
		const result = await tool.call({ name: "plain" }, CTX);

		const [command] = skillsAsCommands(skills);
		if (command.type !== "prompt") throw new Error("skills are prompt commands");
		expect(textOf(result)).toBe(command.getPrompt(""));
		// The appended tail is empty rather than a trailing blank: the body's own
		// text is the whole result.
		expect(textOf(result).endsWith("</skill>")).toBe(true);
	});

	test("a body with no placeholder still receives the arguments, as the slash path delivers them", async () => {
		const { skills } = fixture({
			".labunbun/skills/plain/SKILL.md": skillFile("description: no placeholders", "Deploy the checklist."),
		});
		const tool = createSkillTool(skills);
		const result = await tool.call({ name: "plain", args: "to staging" }, CTX);

		const [command] = skillsAsCommands(skills);
		if (command.type !== "prompt") throw new Error("skills are prompt commands");
		expect(textOf(result)).toBe(command.getPrompt("to staging"));
		// Appended, not substituted: there was no placeholder to substitute into.
		expect(textOf(result).endsWith("\n\nto staging")).toBe(true);
	});

	test("an unknown name is an error, and the error lists what is available", async () => {
		const { skills } = fixture({
			".labunbun/skills/alpha/SKILL.md": skillFile("description: one", "Body one."),
			".labunbun/skills/beta/SKILL.md": skillFile("description: two", "Body two."),
		});
		const result = await createSkillTool(skills).call({ name: "gamma" }, CTX);

		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain('Unknown skill "gamma"');
		expect(text).toContain("alpha");
		expect(text).toContain("beta");
	});

	test("a command-only skill is refused, and is not offered as an alternative", async () => {
		const { skills } = fixture({
			".labunbun/skills/internal/SKILL.md": skillFile(
				"description: not for the model\ndisable-model-invocation: true",
				"Internal body.",
			),
			".labunbun/skills/public/SKILL.md": skillFile("description: for anyone", "Public body."),
		});
		const tool = createSkillTool(skills);

		const refused = await tool.call({ name: "internal" }, CTX);
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("manual invocation");
		// The body is the thing the flag withholds; an error that carried it would
		// be the flag failing at its one job.
		expect(textOf(refused)).not.toContain("Internal body.");

		// The unknown-name list is what the model may retry with, so the
		// command-only skill is not in it — naming one would invite a refused call.
		const unknown = await tool.call({ name: "nope" }, CTX);
		expect(textOf(unknown)).toContain("public");
		expect(textOf(unknown)).not.toContain("internal");
	});

	test("a session with no skills says so instead of listing nothing", async () => {
		const result = await createSkillTool([]).call({ name: "anything" }, CTX);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("No skills are available");
	});

	test("the tool declares itself read-only and concurrency-safe", () => {
		const tool = createSkillTool([]);
		expect(tool.name).toBe("Skill");
		// Read-only is the declaration plan mode's gate reads — the allow-list
		// test walks it against the mode's name list — and concurrency-safe is
		// what lets a batch invoke several skills at once.
		expect(tool.isReadOnly?.({} as never)).toBe(true);
		expect(tool.isConcurrencySafe?.({} as never)).toBe(true);
	});
});

/**
 * One REPL run that delegates through Task, reporting the tool names on every
 * request the transport saw — the parent's, the subagent's and the parent's
 * again. The dialogs are recorded rather than asserted away: the default mode
 * is `ask`, so the Task call has to be approved, and a scene that silently
 * never raised one would be reporting on a run that went nowhere.
 */
interface Scene {
	requests: Array<{ tools: string[]; systemPrompt: string; messages: string }>;
	dialogs: string[];
}

async function replScene(): Promise<Scene> {
	const home = tempDir("lbb-skill-tool-repl-home-");
	const cwd = tempDir("lbb-skill-tool-repl-cwd-");
	mkdirSync(join(home, ".labunbun", "skills", "echo"), { recursive: true });
	writeFileSync(
		join(home, ".labunbun", "skills", "echo", "SKILL.md"),
		skillFile("description: says it back", "ECHO-BODY for $ARGUMENTS"),
	);
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const requests = [];
		const dialogs = [];
		let call = 0;
		const steps = [
			{ toolCalls: [{ name: "Task", arguments: { description: "look it up", prompt: "SUBAGENT-QUESTION" } }] },
			{ text: "SUBAGENT-REPORT" },
			{ text: "done" },
		];
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			refreshModelCatalog: async () => null,
			createDefaultStreamFn: () => async function* (model, context) {
				requests.push({
					tools: (context.tools ?? []).map((tool) => tool.name),
					systemPrompt: context.systemPrompt,
					messages: JSON.stringify(context.messages),
				});
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
					const args = JSON.stringify(spec.arguments ?? {});
					yield builder.toolCallStart(index, "call_" + index, spec.name);
					yield builder.toolCallDelta(index, args);
					yield builder.toolCallEnd(index);
					index++;
				}
				yield builder.done((step.toolCalls ?? []).length > 0 ? "toolUse" : "stop");
			}
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: ({ session }) => ({
				setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
				store: { set() {} },
				requestPermission: (name) => {
					dialogs.push(name);
					return Promise.resolve(true);
				},
				askUser: () => new Promise(() => {}),
				clearPermissionRequest() {},
				clearQuestionRequest() {},
				waitUntilExit: async () => {
					await session.prompt("delegate this");
				}
			})
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		await runInteractive({ cwd: ${JSON.stringify(cwd)}, home: ${JSON.stringify(home)}, theme: "dark" });
		console.log(JSON.stringify({ requests, dialogs }));
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
	return JSON.parse(stdout.trim()) as Scene;
}

describe("the tool tables the REPL builds", () => {
	test("Skill is in the session's list and in the list a subagent is spawned with", async () => {
		const { requests, dialogs } = await replScene();

		expect(dialogs).toEqual(["Task"]);
		expect(requests.length).toBeGreaterThanOrEqual(3);
		// The session's own list, and the control that the scene ran at all: the
		// parent request carries the tools the app merged at startup.
		expect(requests[0].tools).toContain("Skill");
		expect(requests[0].tools).toContain("Task");
		// The subagent's request is the one that does not carry the parent's first
		// user message — the Task prompt is the whole of its conversation.
		const subagent = requests.find((request) => !request.messages.includes("delegate this"));
		expect(subagent).toBeDefined();
		expect(subagent?.tools).toContain("Skill");
		// And the subagent's report came back, so the request above was a real run
		// rather than a request that never finished.
		expect(requests.at(-1)?.messages).toContain("SUBAGENT-REPORT");
	}, 30_000);
});
