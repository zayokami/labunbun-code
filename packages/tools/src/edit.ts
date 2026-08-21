import { isAbsolute, resolve } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import type { Operations } from "./operations.ts";

export function createEditTool(cwd: string, ops: Operations): AnyTool {
	return buildTool({
		name: "Edit",
		description:
			"Performs exact string replacement in a file. `old_string` must match the file content " +
			"exactly (including whitespace) and be unique unless `replace_all` is true.",
		inputSchema: z.object({
			file_path: z.string().describe("Absolute path of the file to edit"),
			old_string: z.string().describe("Exact text to replace"),
			new_string: z.string().describe("Replacement text (empty string deletes)"),
			replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
		}),
		prompt:
			"- Read the file with Read before editing.\n" +
			"- `old_string` must be unique in the file — include enough surrounding context.\n" +
			"- Preserve the file's existing indentation style exactly.",
		isConcurrencySafe: () => false,
		checkPermissions: async (input, ctx) => {
			if (ctx.mode === "acceptEdits") return { behavior: "allow" };
			return { behavior: "ask", message: `Allow editing ${input.file_path}?` };
		},
		validateInput: async (input) => {
			if (input.old_string === input.new_string) {
				return "old_string and new_string are identical — nothing to change";
			}
			return null;
		},
		call: async (input) => {
			const path = isAbsolute(input.file_path) ? input.file_path : resolve(cwd, input.file_path);
			let content: string;
			try {
				content = await ops.readTextFile(path);
			} catch {
				return {
					content: [{ type: "text", text: `File not found: ${path}. Read it first.` }],
					isError: true,
				};
			}

			const occurrences = content.split(input.old_string).length - 1;
			if (occurrences === 0) {
				return {
					content: [
						{
							type: "text",
							text: `old_string not found in ${path}. The file may have changed since you read it — re-read and retry.`,
						},
					],
					isError: true,
				};
			}
			if (occurrences > 1 && !input.replace_all) {
				return {
					content: [
						{
							type: "text",
							text: `old_string appears ${occurrences} times in ${path}. Provide more surrounding context to make it unique, or set replace_all=true.`,
						},
					],
					isError: true,
				};
			}

			const updated = input.replace_all
				? content.split(input.old_string).join(input.new_string)
				: content.replace(input.old_string, input.new_string);

			try {
				await ops.writeTextFileAtomic(path, updated);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Edit failed to save: ${message(error)}` }],
					isError: true,
				};
			}

			const diff = miniDiff(content, input.old_string, input.new_string);
			const summary = `Edited ${path}: ${input.replace_all ? occurrences : 1} replacement(s) applied.`;
			return {
				content: [textContent(diff ? `${summary}\n${diff}` : summary)],
			};
		},
	});
}

const DIFF_CONTEXT_LINES = 2;

/**
 * Unified-style hunk around the first replacement — enough for the UI to show
 * what changed without a full diff engine.
 */
export function miniDiff(oldContent: string, oldString: string, newString: string): string {
	const oldLines = oldContent.split("\n");
	const start = oldContent.indexOf(oldString);
	if (start === -1) return "";
	const before = oldContent.slice(0, start);
	const lineIndex = before.split("\n").length - 1;
	const removedLines = oldString.split("\n");
	const addedLines = newString.split("\n");

	const contextStart = Math.max(0, lineIndex - DIFF_CONTEXT_LINES);
	const contextBefore = oldLines.slice(contextStart, lineIndex);
	const contextAfter = oldLines.slice(
		lineIndex + removedLines.length,
		lineIndex + removedLines.length + DIFF_CONTEXT_LINES,
	);

	const hunk: string[] = [];
	hunk.push(`@@ -${lineIndex + 1},${removedLines.length} +${lineIndex + 1},${addedLines.length} @@`);
	for (const line of contextBefore) hunk.push(`  ${line}`);
	for (const line of removedLines) hunk.push(`- ${line}`);
	for (const line of addedLines) hunk.push(`+ ${line}`);
	for (const line of contextAfter) hunk.push(`  ${line}`);
	return hunk.join("\n");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
