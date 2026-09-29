import { dirname } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardWritablePath } from "./containment.ts";
import type { Operations } from "./operations.ts";
import { decideWrite } from "./sandbox/simulated.ts";
import { workspacePolicy } from "./sandbox/workspace-policy.ts";

export function createWriteTool(cwd: string, ops: Operations, readOnlyRoots: string[] = []): AnyTool {
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
				// Today it refuses only for a read-only root that sits *inside* the
				// workspace, because the guard has already refused everything
				// outside it. That is not the same as it never firing, and the
				// reachability is asserted from a real Write call in
				// `sandbox-wiring.test.ts` — but the app currently builds no such
				// root, so on the roots it does build this check is the second of two
				// guards rather than the one doing the work.
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
