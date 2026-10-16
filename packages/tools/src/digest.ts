/**
 * Digest — content identity for files: `sha256:<hex>  <path>`, one line each.
 *
 * Names and timestamps are claims *about* a file; the bytes are the file. Two
 * checkouts that should match, a copy that should be byte-identical, a file
 * that should be the same one seen an hour ago — each question is answered by
 * one hash of the content, and by nothing else. The hasher is fed chunk by
 * chunk rather than from a whole-file read, because the files this matters for
 * are exactly the ones too large to want in memory.
 *
 * One bad path is one bad line: a missing file or a directory beside real
 * files costs its own line, and the other paths still hash. A digest that gave
 * up on all of them because one was misspelled would be the least useful thing
 * to hand back at exactly the moment the caller is diffing two trees.
 */
import { stat } from "node:fs/promises";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";

/** SHA-256 of a file's bytes, in hex; the file is streamed, never read whole. */
export async function hashFile(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

/** SHA-256 over one or more files, one output line per path. */
export function createDigestTool(cwd: string): AnyTool {
	return buildTool({
		name: "Digest",
		description:
			"Prints the SHA-256 of each named file's bytes, one `sha256:<hex>  <path>` line per file. " +
			"Use it when a decision turns on whether files hold the same content — a name or a timestamp " +
			"is not content. A path that cannot be hashed (missing, a directory) gets an error line of " +
			"its own; the other files still hash.",
		inputSchema: z.object({
			paths: z
				.array(z.string())
				.min(1)
				.describe("One or more file paths to hash (workspace-relative, or absolute paths inside the workspace)"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			const lines: string[] = [];
			for (const requested of input.paths) {
				let path: string;
				try {
					path = guardPathContainment(requested, cwd, "Digest");
				} catch (error) {
					lines.push(message(error));
					continue;
				}
				let info: Awaited<ReturnType<typeof stat>>;
				try {
					info = await stat(path);
				} catch (error) {
					const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : message(error);
					lines.push(`Digest: ${requested}: ${reason}`);
					continue;
				}
				if (info.isDirectory()) {
					lines.push(`Digest: ${requested}: is a directory`);
					continue;
				}
				if (!info.isFile()) {
					lines.push(`Digest: ${requested}: not a regular file`);
					continue;
				}
				try {
					// The requested spelling, not the resolved one: the caller is
					// holding two names against each other, and one of them being
					// canonicalised would quietly rename it in the comparison.
					lines.push(`sha256:${await hashFile(path)}  ${requested}`);
				} catch (error) {
					lines.push(`Digest: ${requested}: ${message(error)}`);
				}
			}
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
