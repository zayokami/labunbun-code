import { join } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import type { DirentInfo, Operations } from "./operations.ts";
import { describeFsFailure, probePath } from "./path-errors.ts";

// Long-form design notes: docs/dev/tools.md
/** How many entries a listing shows before it says the rest were cut. */
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
			const probe = await probePath(ops, dir, "list");
			if (!probe.ok) {
				return { content: [{ type: "text", text: probe.message }], isError: true };
			}
			if (!probe.stat.isDirectory) {
				return { content: [{ type: "text", text: `${dir} is a file, not a directory.` }], isError: true };
			}

			let entries: DirentInfo[];
			try {
				entries = await ops.readdir(dir);
			} catch (error) {
				// The directory may be stat-able and still refuse a listing (execute
				// without read on POSIX). The refusal says which operation failed.
				return { content: [{ type: "text", text: describeFsFailure(error, dir, "list") }], isError: true };
			}
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
