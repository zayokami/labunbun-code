import { join } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import type { Operations } from "./operations.ts";

/**
 * How many entries a listing shows before it says the rest were cut.
 *
 * The same figure as Glob's, because it answers the same question — how much
 * of a directory listing is worth carrying in a conversation — and the notice
 * is a count with no file, unlike Glob's: what a caller does with a listing of
 * thousands of names is go find something by pattern, and Glob is the tool
 * that finds it.
 */
const MAX_ENTRIES = 200;

/** Directory listing with sizes and type markers. */
export function createLsTool(cwd: string, ops: Operations): AnyTool {
	return buildTool({
		name: "LS",
		description:
			"Lists a directory's contents with entry types and sizes. Use Glob/Grep to find files " +
			"by pattern instead of listing large trees. " +
			"A long listing is cut with a count of the entries not shown.",
		inputSchema: z.object({
			path: z.string().describe("Directory path to list"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			let dir: string;
			try {
				dir = guardPathContainment(input.path, cwd, "LS");
			} catch (error) {
				return { content: [{ type: "text", text: String(error) }], isError: true };
			}
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

			// Sorted before the cut so the shown set is the alphabetical head, not
			// whichever entries readdir happened to return first; only the shown
			// rows are stat'd, so the cap bounds the stat calls too.
			entries.sort((a, b) => a.name.localeCompare(b.name));
			const shown = entries.slice(0, MAX_ENTRIES);
			const rows = await Promise.all(
				shown.map(async (entry) => {
					if (entry.isDirectory) return `${entry.name}/`;
					try {
						const s = await ops.stat(join(dir, entry.name));
						return `${entry.name} (${formatSize(s.size)})`;
					} catch {
						return entry.name;
					}
				}),
			);
			const suffix = entries.length > MAX_ENTRIES ? `\n[+${entries.length - MAX_ENTRIES} more entries]` : "";
			return { content: [{ type: "text", text: `${rows.join("\n")}${suffix}` }] };
		},
	});
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
