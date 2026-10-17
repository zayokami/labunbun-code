import { dirname } from "node:path";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardWritablePath } from "./containment.ts";
import { stalenessOf } from "./edit.ts";
import type { FileStat, Operations } from "./operations.ts";
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
			"- An existing file must have been read in full with Read this session — Write refuses to overwrite content you were not shown. New files need no read.\n" +
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
				// (`sandbox-policy.ts:157-180`) whether or not a scan found it. So
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

			// The read gate. It runs before `mkdir` and before any bytes move, so
			// a refusal leaves the filesystem exactly as it was. `readState` is
			// optional: an embedder that builds this tool without one keeps the
			// previous behavior, and `createAllTools` always passes the store that
			// Read writes and Edit reads.
			// Long-form design notes: docs/dev/tools.md
			if (readState) {
				const refusal = await readGate(path, ops, readState);
				if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
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

/**
 * The read gate in front of a write over an existing file: why this write must
 * be refused, or `null` when it may proceed.
 *
 * An absent target is created without a read — there is no content that could
 * have been shown to the model. A target that is not a regular file is left to
 * the write below, which fails with the backend's own error as before. Every
 * other answer from `stat` means the read record decides.
 *
 * The staleness half is Edit's `stalenessOf`, not a copy, so the two tools
 * cannot drift. A record that reached that call passed the full-read and
 * partial-view checks, which is the branch where the comparison is by content;
 * an mtime-only touch with byte-identical content passes exactly as it does for
 * Edit (the Windows file-watcher carve-out that function documents).
 */
async function readGate(path: string, ops: Operations, readState: ReadFileState): Promise<string | null> {
	let stat: FileStat;
	try {
		stat = await ops.stat(path);
	} catch (error) {
		// Only "this path does not exist" lets a write create it. Any other
		// failure cannot say the file is absent, and treating it as absent would
		// let this write replace a file nobody was shown.
		if (isMissing(error)) return null;
		return `Write: could not check whether ${path} exists (${message(error)}). Nothing was written — read it first or check the path and retry.`;
	}
	// A directory or another non-file is not content this gate can protect; the
	// write below fails with the backend's own error, as it did before.
	if (!stat.isFile) return null;

	const seen = readState.getState(path);
	if (!seen) {
		return `Write: ${path} was not read this session. Read it with Read (the whole file, no offset/limit) and try again — Write replaces the whole file, and it will not overwrite content it was never shown.`;
	}
	if (!seen.fullRead) {
		return `Write: the last Read of ${path} was a range (offset/limit), so it is not the whole file. Read the whole file and retry — this write replaces every line, not just the page you read.`;
	}
	if (seen.partialView) {
		return `Write: the last Read of ${path} was a partial view — the file was cut before you saw all of it (a long line, a file over the read window, or a result over the size limit). Read the whole file and retry — Write would replace content you were never shown.`;
	}

	let content: string;
	try {
		content = await ops.readTextFile(path);
	} catch (error) {
		// It vanished between the stat and the read: the create case again.
		if (isMissing(error)) return null;
		return `Write: could not read ${path} to confirm it is unchanged since your read (${message(error)}). Nothing was written; read it again and retry.`;
	}
	const stale = await stalenessOf(path, ops, seen, content);
	if (stale) {
		return `Write: ${path} changed since you read it (${stale}). Read it again and retry — Write will not overwrite content that no longer matches what you were shown.`;
	}
	return null;
}

/** Whether a stat/read failure means the path is absent, rather than "cannot tell". */
function isMissing(error: unknown): boolean {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
