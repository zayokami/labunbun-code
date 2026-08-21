import { type AnyTool, buildTool } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import type { BackgroundShellManager } from "./background.ts";
import type { Operations } from "./operations.ts";

const MAX_OUTPUT_CHARS = 30_000;

export function createBashTool(cwd: string, ops: Operations, background?: BackgroundShellManager): AnyTool {
	return buildTool({
		name: "Bash",
		description:
			"Executes a shell command and returns stdout/stderr with the exit code. " +
			"Output streams live while the command runs. Commands run through a POSIX-compatible " +
			"shell when available (Git Bash on Windows), otherwise cmd.exe. " +
			"Use for git, builds, test runners, and other CLI work. " +
			"Set run_in_background for long-running processes (dev servers, watchers) — you get a " +
			"shell id immediately and can read output later with BashOutput.",
		inputSchema: z.object({
			command: z.string().describe("The shell command to run"),
			timeout: z.number().int().min(1).max(600_000).optional().describe("Timeout in ms (default 120000, max 600000)"),
			description: z.string().optional().describe("One-line description of what this does"),
			run_in_background: z.boolean().optional().describe("Start without waiting; poll via BashOutput"),
		}),
		prompt:
			"- Prefer dedicated tools over shell where they exist (Read/Grep/Glob instead of cat/grep/find).\n" +
			"- Chain dependent steps with && ; avoid interactive commands.\n" +
			"- Provide a short `description` so the user can follow along.\n" +
			"- Use run_in_background for servers/watchers; check with BashOutput.",
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		call: async (input, ctx) => {
			if (input.run_in_background) {
				if (!background) {
					return {
						content: [textContent("Background execution is not available in this session.")],
						isError: true,
					};
				}
				const shell = background.start(input.command, cwd);
				return {
					content: [
						textContent(
							`Started in background as ${shell.id}.\nCommand: ${input.command}\nOutput file: ${shell.outputFile}\nPoll with BashOutput(shell_id="${shell.id}"); stop with KillBash.`,
						),
					],
					details: { backgroundShellId: shell.id },
				};
			}

			const chunks: string[] = [];
			const result = await ops.exec({
				command: input.command,
				cwd,
				timeoutMs: input.timeout ?? 120_000,
				signal: ctx.signal,
				onOutput: (chunk) => {
					chunks.push(chunk);
					ctx.onUpdate({ partialOutput: chunks.join("").slice(-MAX_OUTPUT_CHARS) });
				},
			});

			const output = [result.stdout, result.stderr]
				.filter((s) => s.length > 0)
				.join("\n--- stderr ---\n")
				.slice(0, MAX_OUTPUT_CHARS);

			const suffix = result.killed ? "\n[command timed out or was killed]" : "";
			const text = `${output}${suffix}\n[exit code: ${result.exitCode}]`;
			return { content: [{ type: "text", text }], isError: result.exitCode !== 0 };
		},
	});
}

export function createBashOutputTool(background: BackgroundShellManager): AnyTool {
	return buildTool({
		name: "BashOutput",
		description:
			"Reads the accumulated output of a background shell started with Bash(run_in_background). " +
			"Safe to call repeatedly to tail progress.",
		inputSchema: z.object({
			shell_id: z.string().describe("The background shell id, e.g. 'shell_1'"),
		}),
		prompt: "- Poll BashOutput instead of re-running blocking commands to check on servers.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			const shell = background.get(input.shell_id);
			if (!shell) {
				return { content: [textContent(`Unknown shell id: ${input.shell_id}`)], isError: true };
			}
			const output = background.output(input.shell_id);
			const statusLine =
				shell.status === "running"
					? `[${shell.id}: still running, ${Math.round((Date.now() - shell.startTime) / 1000)}s]`
					: `[${shell.id}: ${shell.status}, exit code ${shell.exitCode}]`;
			return {
				content: [textContent(`${statusLine}\n${output || "(no output yet)"}`)],
			};
		},
	});
}

export function createKillBashTool(background: BackgroundShellManager): AnyTool {
	return buildTool({
		name: "KillBash",
		description: "Terminates a running background shell (kills the whole process tree).",
		inputSchema: z.object({
			shell_id: z.string().describe("The background shell id to kill"),
		}),
		isConcurrencySafe: () => false,
		call: async (input) => {
			const killed = background.kill(input.shell_id);
			if (!killed) {
				return {
					content: [textContent(`Could not kill ${input.shell_id}: not found or not running.`)],
					isError: true,
				};
			}
			return { content: [textContent(`Killed ${input.shell_id}.`)] };
		},
	});
}
