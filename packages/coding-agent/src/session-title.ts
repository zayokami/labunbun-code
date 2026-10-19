/**
 * A user-chosen name for a session.
 *
 * The title lives in a sidecar next to the transcript (`<session>.title.json`)
 * rather than as an entry in it. `listSessions` reads only the head of each
 * transcript to build its rows, so an entry written at the tail would be
 * invisible to the picker that needs it; and the transcript is append-only, so
 * a rename that edited an earlier line would break the one property the file's
 * recovery depends on. The sidecar is small, replaceable, and optional: a
 * missing one means "untitled", not "damaged".
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Longest title kept, by code point. A window title beyond this is unreadable. */
export const SESSION_TITLE_MAX_CHARS = 80;

/** The file a session's title lives in. */
export function sessionTitlePath(sessionPath: string): string {
	return `${sessionPath}.title.json`;
}

/**
 * Make a title safe to put on a row and in the terminal's title bar: control
 * and format characters become spaces, whitespace runs collapse, one matching
 * pair of quotes is dropped (people type `"my title"`), and the result is cut
 * to the cap rather than ellipsised — the ellipsis would be one of the
 * characters the cap was counting.
 *
 * An empty result means "clear it". That is the one value the caller cannot
 * write, and the writer turns it into a deletion.
 */
export function normalizeSessionTitle(raw: string): string {
	const stripped = raw
		// ANSI escapes whole, not just their leading control byte: a title copied
		// from a coloured log would otherwise keep the `[31m` the terminal never
		// showed.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching raw escape sequences is the purpose of this line
		.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[ -/]*[@-~])/g, "")
		.replace(/[\p{Cc}\p{Cf}]/gu, " ");
	const collapsed = stripped.replace(/\s+/g, " ").trim();
	const first = collapsed[0];
	const last = collapsed[collapsed.length - 1];
	const unquoted =
		collapsed.length >= 2 && (first === '"' || first === "'") && last === first
			? collapsed.slice(1, -1).trim()
			: collapsed;
	const characters = Array.from(unquoted);
	return characters.length > SESSION_TITLE_MAX_CHARS ? characters.slice(0, SESSION_TITLE_MAX_CHARS).join("") : unquoted;
}

/**
 * The title this session was given, or undefined. A missing, unreadable, or
 * future-shaped sidecar is untitled rather than an error — the transcript is
 * still perfectly resumable, and a resume must not fail over a label.
 */
export function readSessionTitle(sessionPath: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(sessionTitlePath(sessionPath), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as { version?: unknown; title?: unknown };
	if (record.version !== 1 || typeof record.title !== "string") return undefined;
	const title = normalizeSessionTitle(record.title);
	return title || undefined;
}

/**
 * Set or clear the title. Written to a temporary file and renamed into place,
 * so a process that dies mid-write leaves the previous title rather than half
 * of two; an empty (or cleared) title deletes the sidecar.
 */
export function writeSessionTitle(sessionPath: string, title: string | undefined): void {
	const path = sessionTitlePath(sessionPath);
	const clean = title === undefined ? "" : normalizeSessionTitle(title);
	if (!clean) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	const payload = `${JSON.stringify({ version: 1, title: clean, updatedAt: Date.now() })}\n`;
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, payload, "utf8");
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
