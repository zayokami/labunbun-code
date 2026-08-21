import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import type { Operations } from "./operations.ts";

const MAX_OUTPUT_CHARS = 30_000;

export function createBashTool(cwd: string, ops: Operations): AnyTool {
	return buildTool({
		name: "Bash",
		description:
			"Executes a shell command and returns stdout/stderr with the exit code. " +
			"Output streams live while the command runs. Commands run through a POSIX-compatible " +
			"shell when available (Git Bash on Windows), otherwise cmd.exe. " +
			"Use for git, builds, test runners, and other CLI work.",
		inputSchema: z.object({
			command: z.string().describe("The shell command to run"),
			timeout: z.number().int().min(1).max(600_000).optional().describe("Timeout in ms (default 120000, max 600000)"),
			description: z.string().optional().describe("One-line description of what this does"),
		}),
		prompt:
			"- Prefer dedicated tools over shell where they exist (Read/Grep/Glob instead of cat/grep/find).\n" +
			"- Chain dependent steps with && ; avoid interactive commands.\n" +
			"- Provide a short `description` so the user can follow along.",
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		call: async (input, ctx) => {
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
