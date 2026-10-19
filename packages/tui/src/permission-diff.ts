/**
 * A diff view for the permission dialog.
 *
 * The dialog's one-line preview answers "which file", and Ctrl+A answers "what
 * exactly" with the raw JSON — which for an `Edit` means reading two escaped
 * multi-line strings and aligning them in your head. The question the user is
 * actually being asked is whether the change is acceptable, and a change is
 * easier to judge in the shape it will take on disk.
 *
 * Only the two tools whose input *is* a change get this: `Edit` and `Write`.
 * Everything else keeps the preview the dialog already had, so a new tool
 * cannot accidentally lose its body to a diff renderer that does not
 * understand it.
 */

export type DiffLineKind = "header" | "context" | "added" | "removed";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
}

export interface PermissionDiff {
	lines: DiffLine[];
	/**
	 * What the view had to leave out, or a property of the change that the
	 * lines themselves do not show (a `replace_all` edit applies everywhere).
	 */
	notice?: string;
}

export interface PermissionDiffLimits {
	/** Above this many lines on either side, the change is shown unaligned. */
	maxLinesPerSide?: number;
	/** Longest line kept, in code points. */
	maxLineChars?: number;
	/** Longest body shown, including headers. */
	maxDiffLines?: number;
}

const DEFAULT_LIMITS: Required<PermissionDiffLimits> = {
	maxLinesPerSide: 20,
	maxLineChars: 240,
	maxDiffLines: 40,
};

/**
 * ANSI escapes, OSC strings, and two-character escapes. Removed whole: a test
 * or a generated string can carry colour, and the dialog is the one place the
 * user gets to see the change before it lands. Left in, `\x1b[31m` would take
 * a row of its own rather than colour the row it was meant for.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching raw escape sequences is the purpose of this line
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[ -/]*[@-~])/g;
/** Remaining control and format characters; tab is kept, alignment is its job. */
const CONTROL_RE = /[\p{Cc}\p{Cf}]/gu;

/**
 * Build the diff a permission dialog can render, or undefined when this input
 * has no change to show. Undefined is the safe answer: the caller falls back
 * to the preview it has always rendered.
 */
export function permissionDiff(
	toolName: string,
	input: unknown,
	limits: PermissionDiffLimits = {},
): PermissionDiff | undefined {
	const record =
		typeof input === "object" && input !== null && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: undefined;
	if (!record) return undefined;
	const filePath = typeof record.file_path === "string" ? record.file_path : undefined;
	if (!filePath) return undefined;

	const bounds = { ...DEFAULT_LIMITS, ...limits };
	let oldLines: string[] | undefined;
	let newLines: string[];
	let replaceAll = false;

	if (toolName === "Edit") {
		const oldText = typeof record.old_string === "string" ? record.old_string : undefined;
		const newText = typeof record.new_string === "string" ? record.new_string : undefined;
		if (oldText === undefined || newText === undefined) return undefined;
		// An empty old string is an insertion, not a line of nothing: aligning it
		// against the new side would mark one empty context line in the middle of
		// the addition.
		oldLines = oldText === "" ? [] : splitLines(oldText, bounds.maxLineChars);
		newLines = splitLines(newText, bounds.maxLineChars);
		replaceAll = record.replace_all === true;
	} else if (toolName === "Write") {
		const content = typeof record.content === "string" ? record.content : undefined;
		if (content === undefined || content === "") return undefined;
		newLines = splitLines(content, bounds.maxLineChars);
	} else {
		return undefined;
	}

	// Alignment is quadratic in the two sides, and an Edit can legitimately be a
	// whole file. Past the bound the user still gets every line — just as one
	// removed block followed by one added block, which is the honest shape of a
	// change too large to read line by line anyway.
	const aligned =
		oldLines !== undefined && oldLines.length <= bounds.maxLinesPerSide && newLines.length <= bounds.maxLinesPerSide;
	const body: DiffLine[] = [];
	if (aligned && oldLines) {
		body.push(...lcsDiff(oldLines, newLines));
	} else {
		for (const text of oldLines ?? []) body.push({ kind: "removed", text });
		for (const text of newLines) body.push({ kind: "added", text });
	}

	// The path is capped by its own budget, not the content cap: a caller that
	// narrows the body for a small screen must still be able to read which file
	// the change is in.
	const path = cleanLine(filePath, DEFAULT_LIMITS.maxLineChars);
	const all: DiffLine[] = [{ kind: "header", text: `--- ${path}` }, { kind: "header", text: `+++ ${path}` }, ...body];
	const kept = all.slice(0, Math.max(0, bounds.maxDiffLines));
	const omitted = all.length - kept.length;

	const notices: string[] = [];
	if (replaceAll) notices.push("Every occurrence will be replaced.");
	if (aligned === false && oldLines !== undefined && (oldLines.length > 0 || newLines.length > 0)) {
		notices.push("Too many lines to align — showing the whole change.");
	}
	if (omitted > 0) {
		notices.push(`${omitted} more line${omitted === 1 ? "" : "s"} not shown — ctrl+a for the full input.`);
	}

	return { lines: kept, notice: notices.length > 0 ? notices.join(" ") : undefined };
}

interface BodyLine {
	kind: "context" | "added" | "removed";
	text: string;
}

/**
 * Line-level LCS. Both sides are bounded before this runs, so the table is at
 * most 21×21 — small enough that the straightforward implementation is also
 * the right one.
 */
function lcsDiff(oldLines: string[], newLines: string[]): BodyLine[] {
	const table: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
		new Array<number>(newLines.length + 1).fill(0),
	);
	for (let i = oldLines.length - 1; i >= 0; i--) {
		const row = table[i];
		const nextRow = table[i + 1];
		if (!row || !nextRow) continue;
		for (let j = newLines.length - 1; j >= 0; j--) {
			row[j] = oldLines[i] === newLines[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
		}
	}

	const out: BodyLine[] = [];
	let i = 0;
	let j = 0;
	while (i < oldLines.length && j < newLines.length) {
		const oldLine = oldLines[i] ?? "";
		const newLine = newLines[j] ?? "";
		if (oldLine === newLine) {
			out.push({ kind: "context", text: oldLine });
			i++;
			j++;
			continue;
		}
		// On a tie, take the removal side. Either order is a correct diff; keeping
		// one order means the same edit always renders the same way, which is what
		// makes the test fixture meaningful.
		if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
			out.push({ kind: "removed", text: oldLine });
			i++;
		} else {
			out.push({ kind: "added", text: newLine });
			j++;
		}
	}
	while (i < oldLines.length) {
		out.push({ kind: "removed", text: oldLines[i] ?? "" });
		i++;
	}
	while (j < newLines.length) {
		out.push({ kind: "added", text: newLines[j] ?? "" });
		j++;
	}
	return out;
}

function splitLines(text: string, maxChars: number): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	// A trailing newline terminates the last line; it does not start a new empty
	// one. The file on disk has the same reading.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines.map((line) => cleanLine(line, maxChars));
}

function cleanLine(text: string, maxChars: number): string {
	const clean = text.replace(ANSI_RE, "").replace(CONTROL_RE, (ch) => (ch === "\t" ? "\t" : " "));
	const characters = Array.from(clean);
	if (characters.length <= maxChars) return clean;
	return `${characters.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}
