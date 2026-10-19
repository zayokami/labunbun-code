/**
 * One vocabulary for filesystem failures.
 *
 * These tools used to answer every failure to reach a path with the same words:
 * a permission refusal, a directory where a file was expected, and a path that
 * never existed all read as "not found". The errno is the part a caller can act
 * on — fix the spelling, ask for access, look somewhere else — so it is read
 * here, in one place, and phrased the same way by every tool that takes a path.
 *
 * Only `stat` is used to probe. The `exists` operation answers a boolean and
 * throws away the errno, which is exactly the information this module exists to
 * keep.
 */
import type { FileStat, FileSystemOperations } from "./operations.ts";

/** The errno code on a rejection, when it carries one. */
export function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" ? code : undefined;
}

/**
 * True when the path is not there. `ENOTDIR` belongs here: a component of the
 * path exists but is not a directory, so the path names nothing — the same fact
 * for the caller as a missing entry.
 */
export function isMissingPathError(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

/** True when the path is there but the process is not allowed to touch it. */
export function isPermissionError(error: unknown): boolean {
	const code = errorCode(error);
	return code === "EACCES" || code === "EPERM";
}

/**
 * What a failed filesystem operation should say.
 *
 * `action` is a verb the tool supplies ("list", "search", "inspect"), used only
 * where the failure says nothing about the path itself. A missing path and a
 * refusal are stated as such, because they are the two cases with a next move.
 */
export function describeFsFailure(error: unknown, path: string, action: string): string {
	if (isMissingPathError(error)) return `Path not found: ${path}`;
	if (isPermissionError(error)) return `Permission denied: ${path}`;
	const detail = error instanceof Error ? error.message : String(error);
	return `Could not ${action} ${path}: ${detail}`;
}

/** What probing a path found: either its metadata, or why it cannot be used. */
export type PathProbe = { ok: true; stat: FileStat } | { ok: false; message: string };

/**
 * Stat a path, keeping the reason when it cannot be stat'd.
 *
 * The bool the old call sites used (`exists`) could not distinguish "there is
 * nothing here" from "this process may not look". Both now reach the caller as
 * a sentence, and the call site only decides whether to show it.
 */
export async function probePath(
	ops: Pick<FileSystemOperations, "stat">,
	path: string,
	action = "read",
): Promise<PathProbe> {
	try {
		return { ok: true, stat: await ops.stat(path) };
	} catch (error) {
		return { ok: false, message: describeFsFailure(error, path, action) };
	}
}
