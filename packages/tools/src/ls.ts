import { isAbsolute, join, resolve } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import type { Operations } from "./operations.ts";

/** Directory listing with sizes and type markers. */
export function createLsTool(cwd: string, ops: Operations): AnyTool {
	return buildTool({
		name: "LS",
		description:
			"Lists a directory's contents with entry types and sizes. Use Glob/Grep to find files " +
			"by pattern instead of listing large trees.",
		inputSchema: z.object({
			path: z.string().describe("Directory path to list"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			const dir = isAbsolute(input.path) ? input.path : resolve(cwd, input.path);
			if (!(await ops.exists(dir))) {
				return { content: [{ type: "text", text: `Path not found: ${dir}` }], isError: true };
			}
			const stat = await ops.stat(dir);
			if (!stat.isDirectory) {
				return { content: [{ type: "text", text: `${dir} is a file, not a directory.` }], isError: true };
			}

			const entries = await ops.readdir(dir);
			if (entries.length === 0) {
				return { content: [{ type: "text", text: "(empty directory)" }] };
			}

			const rows = await Promise.all(
				entries
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(async (entry) => {
						if (entry.isDirectory) return `${entry.name}/`;
						try {
							const s = await ops.stat(join(dir, entry.name));
							return `${entry.name} (${formatSize(s.size)})`;
						} catch {
							return entry.name;
						}
					}),
			);
			return { content: [{ type: "text", text: rows.join("\n") }] };
		},
	});
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
