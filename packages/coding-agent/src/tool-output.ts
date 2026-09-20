/**
 * Where tool results too large for the context are kept in full.
 *
 * A spilled result is one the model has to be able to read back, so the file is
 * not a log: it is addressed by the tool call that made it, written once, and
 * never rewritten. That shape is what makes the retention policy safe — a file
 * older than the retention window belongs to a session nobody is reading any
 * more, and deleting it cannot strand a path the current context still points
 * at.
 *
 * Everything here is best effort. A tool that cannot spill has a truncated
 * result, which is exactly what it would have had before spilling existed; a
 * tool that fails because the disk is full would be a much worse trade.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SpillRequest, type SpillWriter, sanitizeCwd, sessionsRoot } from "@labunbun/agent";

/** How long a spilled result stays readable. */
export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * This project's spill directory, one subdirectory per session.
 *
 * The root rather than the session directory, because it is also what Read is
 * allowed to open: a session that is swapped mid-run (`/resume`) keeps writing
 * to a directory the Read tool already trusts.
 */
export function toolOutputRoot(cwd: string, home?: string): string {
	return join(sessionsRoot(home), sanitizeCwd(cwd), "tool-output");
}

/**
 * One directory per session, so a session's spill files expire together. A run
 * that keeps nothing (`--no-session`) still gets one — its output is no less
 * worth keeping than a session's, and the alternative is not spilling at all.
 */
export function toolOutputDir(cwd: string, sessionId: string | undefined, home?: string): string {
	return join(toolOutputRoot(cwd, home), sessionId ?? "unassigned");
}

/**
 * Strip the separators a call id must not put into a file name. Ids are
 * provider-generated (`call_abc123`, `toolu_01…`), so this is a guard against
 * one that is not, rather than a transformation of the ones that are. Dots go
 * too: a name component that is exactly `..` is a directory, and one that ends
 * in a dot is not a name Windows will write.
 */
function fileNameFor(request: SpillRequest): string {
	const safe = request.callId.replace(/[^\w-]/g, "_").slice(0, 100);
	const tool = request.toolName.replace(/[^\w-]/g, "").slice(0, 20) || "tool";
	return `${tool}-${safe}.txt`;
}

export interface SpillWriterOptions {
	cwd: string;
	sessionId: string | undefined;
	home?: string;
}

/**
 * Write one result out and return the path to show the model: absolute,
 * because that is what Read will be handed back, and not home-shortened,
 * because a `~` is a thing a shell expands and this is never a string a shell
 * sees.
 */
export function writeToolOutput(request: SpillRequest, options: SpillWriterOptions): string | null {
	try {
		const dir = toolOutputDir(options.cwd, options.sessionId, options.home);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, fileNameFor(request));
		writeFileSync(path, request.text, "utf8");
		return path;
	} catch {
		// A missing convenience, not a failed tool: the result is cut instead.
		return null;
	}
}

/** {@link writeToolOutput} bound to one session, for callers that have one. */
export function createSpillWriter(options: SpillWriterOptions): SpillWriter {
	return (request) => writeToolOutput(request, options);
}

/**
 * Delete spilled results older than the retention window.
 *
 * Files only — never the session directory a `--resume` might still write into
 * — and only inside `tool-output/`, so a project directory that also holds
 * session transcripts cannot lose one to this.
 */
export function pruneToolOutput(
	cwd: string,
	options: { home?: string; now?: () => number; retentionMs?: number } = {},
): string[] {
	const retention = options.retentionMs ?? TOOL_OUTPUT_RETENTION_MS;
	const now = options.now?.() ?? Date.now();
	const root = toolOutputRoot(cwd, options.home);
	const removed: string[] = [];
	let sessions: string[];
	try {
		sessions = readdirSync(root);
	} catch {
		return removed; // nothing has ever spilled in this project
	}
	for (const session of sessions) {
		const dir = join(root, session);
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		let remaining = 0;
		for (const file of files) {
			const path = join(dir, file);
			try {
				if (now - statSync(path).mtimeMs > retention) {
					rmSync(path, { force: true });
					removed.push(path);
					continue;
				}
			} catch {
				continue; // vanished under us, or not statable: leave it
			}
			remaining++;
		}
		// An empty session directory is vacancy, not history.
		if (remaining === 0) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Another process is writing there; it will be pruned next time.
			}
		}
	}
	return removed;
}
