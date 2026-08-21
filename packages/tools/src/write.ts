import { dirname } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import type { Operations } from "./operations.ts";

export function createWriteTool(cwd: string, ops: Operations): AnyTool {
	return buildTool({
		name: "Write",
		description:
			"Writes a file to the local filesystem, overwriting it if it exists and creating parent " +
			"directories as needed. Prefer Edit for modifying existing files.",
		inputSchema: z.object({
			file_path: z.string().describe("Absolute path of the file to write"),
			content: z.string().describe("Full content to write"),
		}),
		prompt:
			"- Prefer Edit over Write when changing existing files.\n" +
			"- Write the COMPLETE intended content — this replaces the whole file.\n" +
			"- Use absolute paths.",
		isConcurrencySafe: () => false,
		checkPermissions: async (input, ctx) => {
			if (ctx.mode === "acceptEdits") return { behavior: "allow" };
			return { behavior: "ask", message: `Allow writing ${input.file_path}?` };
		},
		call: async (input) => {
			let path: string;
			try {
				path = guardPathContainment(input.file_path, cwd, "Write");
			} catch (error) {
				return { content: [{ type: "text", text: String(error) }], isError: true };
			}
			try {
				await ops.mkdir(dirname(path));
				await ops.writeTextFileAtomic(path, input.content);
				return {
					content: [{ type: "text", text: `Wrote ${input.content.length} chars to ${path}` }],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Write failed: ${message(error)}` }],
					isError: true,
				};
			}
		},
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
