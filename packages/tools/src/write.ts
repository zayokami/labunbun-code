import { dirname } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardWritablePath } from "./containment.ts";
import type { Operations } from "./operations.ts";
import type { ReadFileState } from "./read-file-state.ts";
import { decideWrite } from "./sandbox/simulated.ts";
import { workspacePolicy } from "./sandbox/workspace-policy.ts";

export function createWriteTool(
	cwd: string,
	ops: Operations,
	readOnlyRoots: string[] = [],
	readState?: ReadFileState,
): AnyTool {
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
		call: async (input, ctx) => {
			let path: string;
			try {
				// Both checks, and both have to pass. Neither can widen what the other
				// allows: each one can only refuse.
				//
				// `guardWritablePath` is unconditional. It refuses version-control
				// metadata whatever the mode says, it refuses anything outside the
				// workspace whatever the mode says, and it matches on the *path* — so
				// it catches a `.git` at any depth, including one reached through a
				// link, without a scan having to find it first.
				//
				// `decideWrite` then asks the session's policy which *roots* may be
				// written, which is the question the guard has no way to know about
				// and the one a shell wrapped in seatbelt or bwrap would enforce.
				// It is **not** only a read-only-root check: it refuses every path in
				// `policy.protected`, and `buildSandboxPolicy` puts `<workspace>/.git`
				// there for every writable root unconditionally
				// (`sandbox-policy.ts:307-313`) whether or not a scan found it. So
				// this tool's `.git/config` refusal is over-determined, and
				// `sandbox-simulated.test.ts` asserts the policy half of that on its
				// own, with no guard in front of it.
				//
				// What it does *not* cover is the rest of the guard's rule, and the
				// gap is a list against a path match: `.git` under `node_modules`,
				// deeper than the scan's four segments, or spelled `".git "` /
				// `".git."` is not in `protected`, so `decideWrite` allows it and the
				// line above is the whole of the protection. Those are exactly the
				// cases `tools.test.ts` drives through a real Write and Edit, because
				// a case `decideWrite` also refuses would keep passing if this line
				// were deleted.
				path = guardWritablePath(input.file_path, cwd, "Write");
				const policy = await workspacePolicy(cwd, { sandbox: ctx.sandbox, readOnlyRoots });
				const decision = decideWrite(policy, path, cwd);
				if (!decision.allowed) throw new Error(`Write: ${decision.reason}`);
			} catch (error) {
				return { content: [{ type: "text", text: String(error) }], isError: true };
			}
			try {
				await ops.mkdir(dirname(path));
				await ops.writeTextFileAtomic(path, input.content);
				// Recorded so the edit gate accepts the next edit to the file the
				// session just created.
				// Long-form design notes: docs/dev/tools.md
				let writtenAt: number | undefined;
				try {
					writtenAt = (await ops.stat(path)).mtimeMs;
				} catch {}
				readState?.record(path, { content: input.content, mtime: writtenAt });
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
