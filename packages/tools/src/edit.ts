// Edit — exact string replacement, with two gates in front and a miss diagnostic behind.
// Long-form design notes: docs/dev/tools.md
import { type AnyTool, buildTool, type ToolResult } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import { guardWritablePath } from "./containment.ts";
import type { Operations } from "./operations.ts";
import type { ReadFileState, ReadFileStateEntry } from "./read-file-state.ts";
import { decideWrite } from "./sandbox/simulated.ts";
import { workspacePolicy } from "./sandbox/workspace-policy.ts";

// Long-form design notes: docs/dev/tools.md
/** Carries what actually landed on disk: the on-disk newString and the transformations that fired. */
export interface EditToolResult extends ToolResult {
	// Long-form design notes: docs/dev/tools.md
	/** The replacement text as written to disk, after quote restyle and line ending conversion. */
	newString?: string;
	/**
	 * One entry per transformation that changed bytes, empty when none did.
	 * Named rather than counted: a model told "1 transformation" cannot tell
	 * whether its quotes moved.
	 */
	transformations?: string[];
}

/** Quote restyling to match the file's spelling. Only ever non-empty when it changed bytes. */
const TRANSFORM_QUOTES = "quote-style-preserved";
/** Newline style rewritten to the file's own. Only ever non-empty when it changed bytes. */
const TRANSFORM_LINE_ENDINGS = "line-endings-preserved";

// Long-form design notes: docs/dev/tools.md
/** How many differing lines the miss diagnostic names. */
const MAX_REPORTED_DIFFERENCES = 3;

/** Longest anchor line the fallback scan will consider. A "line" longer than this is a minified file. */
const MAX_ANCHOR_CHARS = 400;
/** Shortest shared prefix that counts as "this is the line you meant". */
const MIN_ANCHOR_PREFIX = 8;
/** File lines the fallback scan will read. Bounds the one O(anchors × lines) pass. */
const MAX_SCAN_LINES = 50_000;
/** `old_string` lines the fallback scan will try. */
const MAX_SCAN_ANCHORS = 32;

// Long-form design notes: docs/dev/tools.md
/** Slop between the file's mtime and the read instant, for the comparison used when a record carries no mtime. */
const MTIME_TOLERANCE_MS = 1;

export function createEditTool(cwd: string, ops: Operations, readState: ReadFileState): AnyTool {
	return buildTool({
		name: "Edit",
		description:
			"Performs exact string replacement in a file. The file must have been read with Read this " +
			"session (whole file, not a range). `old_string` must match exactly, including whitespace, and be " +
			"unique unless `replace_all` is true.",
		inputSchema: z.object({
			file_path: z.string().describe("Absolute path of the file to edit"),
			old_string: z.string().describe("Exact text to replace"),
			new_string: z.string().describe("Replacement text (empty string deletes)"),
			replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
		}),
		prompt:
			"- Read the file with Read first — Edit refuses a file this session has not read, and a ranged read is not enough.\n" +
			"- `old_string` must be unique in the file — include enough surrounding context, or set replace_all.\n" +
			"- Copy `old_string` out of the file verbatim: its indentation, spacing and line endings are the match.\n" +
			"- On failure the result names the lines that differ and, when the mismatch is only indentation, line endings, or escape sequences spelled out as two characters (`\\n`), an `old_string` you can send back unchanged. Send that one back; if it says the file changed, Read it again first.",
		isConcurrencySafe: () => false,
		validateInput: async (input) => {
			if (input.old_string === input.new_string) {
				return "old_string and new_string are identical — nothing to change";
			}
			// An empty needle is the one input that silently rewrites a file: with
			// `replace_all` it inserts between every character, and without it,
			// `content.replace("", x)` prepends. Neither is what anybody meant.
			if (input.old_string.length === 0) {
				return "old_string is empty — it matches every position in the file";
			}
			return null;
		},
		call: async (input, ctx): Promise<EditToolResult> => {
			let path: string;
			try {
				// Two checks, both of which have to pass, and neither of which can
				// widen what the other allows. See the pair and its honest limits in
				// `write.ts`; Edit is the same composition, and is the stricter of
				// the two in that it is handed no read-only roots, so `decideWrite`
				// here has even less to decide.
				path = guardWritablePath(input.file_path, cwd, "Edit");
				const policy = await workspacePolicy(cwd, { sandbox: ctx.sandbox });
				const decision = decideWrite(policy, path, cwd);
				if (!decision.allowed) throw new Error(`Edit: ${decision.reason}`);
			} catch (error) {
				return errorResult(String(error));
			}

			// Gate 1: this session read the file, and not a page of it.
			// Long-form design notes: docs/dev/tools.md
			const seen = readState.getState(path);
			if (!seen) {
				return errorResult(
					`Edit: ${path} was not read this session. Read it with Read (the whole file, no offset/limit) and try again — Edit will not edit a file whose current content it was never shown.`,
				);
			}
			if (!seen.fullRead) {
				return errorResult(
					`Edit: the last Read of ${path} was a range (offset/limit), so it is not the whole file. Read the whole file and retry — the replacement is applied to the file, not to the page you read.`,
				);
			}

			let content: string;
			try {
				content = await ops.readTextFile(path);
			} catch {
				return errorResult(`File not found: ${path}. Read it first.`);
			}

			// --- Gate 2: it has not changed since. -------------------------------
			const stale = await stalenessOf(path, ops, seen, content);
			if (stale) {
				return errorResult(
					`Edit: ${path} changed since you read it (${stale}). Read it again and re-send this edit; the file on disk no longer matches the text you were shown.`,
				);
			}

			// --- Match. ---------------------------------------------------------
			const plan = findMatches(content, input.old_string);
			if (plan.indices.length === 0) {
				const diagnostic = explainMiss(content, input.old_string);
				return errorResult(renderMiss(path, diagnostic));
			}
			if (plan.indices.length > 1 && !input.replace_all) {
				return errorResult(
					`old_string appears ${plan.indices.length} times in ${path}. Provide more surrounding context to make it unique, or set replace_all=true.\n` +
						`Each occurrence begins with:\n${plan.texts.map((t, i) => `  [${i}] ${firstLine(t)}`).join("\n")}`,
				);
			}

			// --- Transform the replacement, and say so. --------------------------
			//
			// Nothing here is silent. The reference makes three such transformations
			// without saying so and then reports the *pre*-transformation string back
			// to the model, which is how a model ends up believing it wrote one
			// thing while the file holds another. `transformations` names every one
			// that fired and `newString` below is the bytes, not the request.
			const transformations: string[] = [];
			const fileStyle = quoteStyleOf(content);
			const regionStyle = agreeOnQuoteStyle(plan.texts.map((t) => quoteStyleOf(t)));
			// With `replace_all`, every occurrence is rewritten with the *same*
			// string. Restyling by the first region while the second was written in
			// straight quotes would be a second silent edit, so a disagreement falls
			// back to the file's own spelling and, failing that, to no restyle at all.
			const target = regionStyle === "none" ? fileStyle : regionStyle;
			let newString = input.new_string;
			if (target === "curly") {
				const restyled = toCurlyQuotes(newString);
				if (restyled !== newString) {
					newString = restyled;
					transformations.push(TRANSFORM_QUOTES);
				}
			} else if (target === "straight") {
				const straightened = toStraightQuotes(newString);
				if (straightened !== newString) {
					newString = straightened;
					transformations.push(TRANSFORM_QUOTES);
				}
			}

			const eol = detectLineEnding(content);
			const withFileEol = applyLineEndings(newString, eol);
			if (withFileEol !== newString) {
				newString = withFileEol;
				transformations.push(TRANSFORM_LINE_ENDINGS);
			}

			// --- Splice. --------------------------------------------------------
			// Slices come from the original content at the original offsets; a deletion also eats its newline.
			// Long-form design notes: docs/dev/tools.md
			const eatTrailingBreak = input.new_string === "";
			const parts: string[] = [];
			let cursor = 0;
			let firstIndex = -1;
			for (const index of plan.indices) {
				const region = content.slice(index, index + input.old_string.length);
				let end = index + region.length;
				if (eatTrailingBreak) {
					const breakText = eol === "crlf" ? "\r\n" : "\n";
					if (content.startsWith(breakText, end)) end += breakText.length;
				}
				parts.push(content.slice(cursor, index), newString);
				cursor = end;
				if (firstIndex === -1) firstIndex = index;
			}
			parts.push(content.slice(cursor));
			const updated = parts.join("");

			try {
				await ops.writeTextFileAtomic(path, updated);
			} catch (error) {
				return errorResult(`Edit failed to save: ${message(error)}`);
			}

			// --- What actually happened. ----------------------------------------
			//
			// Read the file back and check two things, because they can fail apart:
			// the whole file is what we composed, and the region we claim `newString`
			// is really that string and not a neighbour of it. Cheap — one read of a
			// file already in the OS cache — and it is the only thing that makes
			// "newString is on disk" a fact rather than an intention.
			let onDisk: string;
			try {
				onDisk = await ops.readTextFile(path);
			} catch (error) {
				return errorResult(`Edit wrote the file but could not read it back: ${message(error)}`);
			}
			if (onDisk !== updated) {
				return errorResult(
					`Edit wrote ${path} but the file on disk does not match what was written. Treat the file as changed by something else and re-read it before editing again.`,
				);
			}
			if (onDisk.slice(firstIndex, firstIndex + newString.length) !== newString) {
				return errorResult(
					`Edit wrote ${path} but the replacement text at offset ${firstIndex} does not match the replacement. Re-read the file before editing again.`,
				);
			}

			// The record has to be refreshed or the *second* edit in a conversation
			// fails against the first one's own output — `read-file-state.ts:46-48`
			// says so explicitly, and it is right: we know the new content exactly.
			// The fresh mtime is part of the same refresh — a cut-view record whose
			// baseline predates this write would refuse the next edit as changed.
			let editedAt: number | undefined;
			try {
				editedAt = (await ops.stat(path)).mtimeMs;
			} catch {}
			readState.record(path, { content: onDisk, mtime: editedAt });

			const summary = `Edited ${path}: ${input.replace_all ? plan.indices.length : 1} replacement(s) applied.`;
			const lines: string[] = [summary];
			if (transformations.length > 0) {
				lines.push(
					`Applied ${transformations.length} transformation(s) to new_string: ${transformations.join(", ")}`,
					"The file now contains:",
					newString,
				);
			}
			const diff = miniDiff(content, firstIndex, plan.texts[0], newString);
			if (diff) lines.push(diff);
			return { content: [textContent(lines.join("\n"))], newString, transformations };
		},
	});
}

function errorResult(text: string): EditToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/tools.md
/** Why the recorded read no longer describes the file, or `null` when it does. */
async function stalenessOf(
	path: string,
	ops: Operations,
	seen: ReadFileStateEntry,
	content: string,
): Promise<"content no longer matches what you read" | "mtime no longer matches your read" | null> {
	const comparable = seen.fullRead && !seen.partialView;
	if (comparable) return seen.content === content ? null : "content no longer matches what you read";
	const stat = await ops.stat(path);
	if (seen.mtime !== undefined) return stat.mtimeMs === seen.mtime ? null : "mtime no longer matches your read";
	return stat.mtimeMs > seen.timestamp + MTIME_TOLERANCE_MS ? "mtime no longer matches your read" : null;
}

// ---------------------------------------------------------------------------
// Matching — two strategies, and the reason there are only two
// ---------------------------------------------------------------------------

export interface MatchPlan {
	/** Start offsets into the ORIGINAL content, in order, non-overlapping. */
	indices: number[];
	/** What is actually at each offset — real bytes, not the model's spelling. */
	texts: string[];
	/** Which strategy found them. `quote-normalized` is what makes `transformations` possible. */
	strategy: "exact" | "quote-normalized";
}

const NO_MATCH: MatchPlan = { indices: [], texts: [], strategy: "exact" };

// Long-form design notes: docs/dev/tools.md
/** Exact match first, then curly-quote normalisation, and nothing else. */
export function findMatches(content: string, oldString: string): MatchPlan {
	const exact = locate(content, oldString);
	if (exact.length > 0)
		return { indices: exact, texts: exact.map((i) => content.slice(i, i + oldString.length)), strategy: "exact" };

	const normalized = normalizeQuotes(content);
	const needle = normalizeQuotes(oldString);
	const fuzzy = locate(normalized, needle);
	if (fuzzy.length === 0) return NO_MATCH;
	// Offsets are shared because the normaliser is length-preserving. If that ever
	// stops being true this is the line that silently breaks; `QUOTE NORMALISATION
	// IS LENGTH-PRESERVING` in the test file is the assertion that says so.
	return {
		indices: fuzzy,
		texts: fuzzy.map((i) => content.slice(i, i + oldString.length)),
		strategy: "quote-normalized",
	};
}

/**
 * Every non-overlapping occurrence, stepping by the needle's own length.
 *
 * Non-overlapping because that is what the replacement does: `"aaa".replaceAll("aa", "b")`
 * is `"ba"`, one occurrence, and counting the overlap at index 1 would report a
 * second replacement that never happens.
 */
function locate(haystack: string, needle: string): number[] {
	// An empty needle matches at every index, so the guard must sit where the loop is.
	// Long-form design notes: docs/dev/tools.md
	if (needle.length === 0) return [];
	const found: number[] = [];
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return found;
		found.push(at);
		from = at + needle.length;
	}
}

// Long-form design notes: docs/dev/tools.md
/** Curly quotation marks to their ASCII equivalents, one code unit to one. */
export function normalizeQuotes(text: string): string {
	return text.replace(/[“”„‟‘’‚‛]/g, (c) => {
		switch (c) {
			case "“":
			case "”":
			case "„":
			case "‟":
				return '"';
			case "‘":
			case "’":
			case "‚":
			case "‛":
				return "'";
			default:
				return c;
		}
	});
}

// ---------------------------------------------------------------------------
// Quote restyling — applied to the replacement only, never to the match
// ---------------------------------------------------------------------------

type QuoteStyle = "curly" | "straight" | "mixed" | "none";

const CURLY_DOUBLE = /[“”„‟]/;
const STRAIGHT_DOUBLE = /"/;
const CURLY_SINGLE = /[‘’‚‛]/;
const STRAIGHT_SINGLE = /'/;

/** How one piece of text spells its quotes. */
function quoteStyleOf(text: string): QuoteStyle {
	const curlyDouble = CURLY_DOUBLE.test(text);
	const straightDouble = STRAIGHT_DOUBLE.test(text);
	const curlySingle = CURLY_SINGLE.test(text);
	const straightSingle = STRAIGHT_SINGLE.test(text);
	if (!curlyDouble && !straightDouble && !curlySingle && !straightSingle) return "none";
	if ((curlyDouble && straightDouble) || (curlySingle && straightSingle)) return "mixed";
	// A kind the text does not use cannot outvote the kind it does: prose with one
	// straight apostrophe in it is straight-quoted text, not mixed.
	const straightOnly = straightDouble || straightSingle;
	const curlyOnly = curlyDouble || curlySingle;
	if (curlyOnly && !straightOnly) return "curly";
	return "straight";
}

// Long-form design notes: docs/dev/tools.md
/** One style for several regions, or `mixed` if they disagree. */
function agreeOnQuoteStyle(styles: QuoteStyle[]): QuoteStyle {
	if (styles.length === 0) return "none";
	const first = styles[0];
	return styles.every((s) => s === first) ? first : "mixed";
}

const CURLY_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["“", "”"],
	["‘", "’"],
];

// Long-form design notes: docs/dev/tools.md
/** Straight quotes to curly, opening on the first occurrence of each kind and closing on the second. */
function toCurlyQuotes(text: string): string {
	let out = "";
	let doubleIndex = 0;
	let singleIndex = 0;
	for (const char of text) {
		if (char === '"') {
			out += CURLY_PAIRS[0][doubleIndex++ % 2];
		} else if (char === "'") {
			out += CURLY_PAIRS[1][singleIndex++ % 2];
		} else {
			out += char;
		}
	}
	return out;
}

/** Curly quotes to their ASCII equivalents. One to one, like {@link normalizeQuotes}. */
function toStraightQuotes(text: string): string {
	return normalizeQuotes(text);
}

// ---------------------------------------------------------------------------
// Line endings
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/tools.md
/** The file's own newline style, by majority. */
export function detectLineEnding(content: string): "crlf" | "lf" {
	const crlf = countOf(content, "\r\n");
	const lf = countOf(content, "\n");
	// A file with no newline at all is LF: there is nothing to preserve, and the
	// alternative would add a carriage return to a single-line file.
	return crlf * 2 > lf ? "crlf" : "lf";
}

function countOf(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return count;
		count += 1;
		from = at + needle.length;
	}
}

// Long-form design notes: docs/dev/tools.md
/** Rewrite bare newlines to the file's style. A lone `\r` is left alone. */
export function applyLineEndings(text: string, eol: "crlf" | "lf"): string {
	if (eol === "lf") return text.replace(/\r\n/g, "\n");
	return text.replace(/\r\n|\n/g, (match) => (match === "\n" ? "\r\n" : match));
}

// ---------------------------------------------------------------------------
// The not-found diagnostic
// ---------------------------------------------------------------------------

export interface LineDifference {
	/** 1-based, and the same numbering Read printed. */
	line: number;
	expected: string;
	actual: string;
}

export interface MissAnchor {
	/** The line of `old_string` that located the region. */
	text: string;
	/** 1-based line number in the file. */
	line: number;
	how: "first-line" | "last-line" | "common-prefix";
}

export interface MissDiagnostic {
	anchor: MissAnchor | null;
	differences: LineDifference[];
	/** An `old_string` the model can send back verbatim, or `null`. */
	suggestion: string | null;
	/** Why there is no suggestion. Never null when `suggestion` is null. */
	declined: "no-anchor" | "not-indentation-only" | "line-count-differs" | "suggestion-not-unique" | null;
	/** Things the model would otherwise have to work out from the strings themselves. */
	notes: string[];
}

// Long-form design notes: docs/dev/tools.md
/** The conditions under which a suggested `old_string` is worth sending back unchanged. */
export function explainMiss(content: string, oldString: string): MissDiagnostic {
	const oldLines = oldString.split("\n");
	// The second route is computed up front because it decides the outcome on
	// its own: when it fires, the anchor-and-compare machinery below describes
	// the *escaping*, not the file, and its verdicts are neither use nor truth.
	const escaped = detectEscapedMiss(content, oldString);
	const anchor = locateAnchor(content, oldLines);
	if (!anchor) {
		return {
			anchor: null,
			differences: [],
			suggestion: escaped?.corrected ?? null,
			declined: escaped ? null : "no-anchor",
			notes: escaped ? [escaped.note] : [],
		};
	}

	const eol = detectLineEnding(content);
	const crlf = eol === "crlf";
	const fileLines = content.split("\n");
	// A CRLF file's lines carry a trailing `\r` once split on `\n`. Stripped for
	// comparison *and* for display, so a difference that is only the line ending
	// does not render as two identical-looking strings.
	const window = fileLines
		.slice(anchor.line, anchor.line + oldLines.length)
		.map((l) => (crlf ? l.replace(/\r$/, "") : l));

	const differences: LineDifference[] = [];
	const notes: string[] = [];
	let complete = window.length === oldLines.length;
	let recoverable = complete;
	let anyDiffers = false;
	let crOnly = false;
	let indentOnly = false;

	for (let i = 0; i < oldLines.length; i++) {
		const expected = oldLines[i].replace(/\r$/, "");
		const actual = window[i];
		if (actual === undefined) {
			complete = false;
			recoverable = false;
			differences.push({ line: anchor.line + i + 1, expected, actual: "<end of file>" });
			break;
		}
		// **The line-ending check has to come BEFORE the equality check.** Both sides
		// were stripped on the way in, so a CRLF-only drift arrives here as two equal
		// strings — and a check placed after `if (actual === expected) continue`
		// can never see it. That was the whole bug: the branch written for it was
		// after the `continue`, so it was dead, and a CRLF file drew the same
		// "the lines are byte-identical, but the block is not contiguous" answer
		// as a genuinely wrong block.
		const rawActual = fileLines[anchor.line + i] ?? "";
		const crOnlyHere = rawActual === `${expected}\r`;
		if (crOnlyHere) {
			crOnly = true;
			anyDiffers = true;
			// Not a content difference, so it is named in the notes rather than
			// listed among the differing lines — two identical-looking strings in a
			// differences list is how this hid the first time.
			continue;
		}
		if (actual === expected) continue;
		anyDiffers = true;
		if (differences.length < MAX_REPORTED_DIFFERENCES) {
			differences.push({ line: anchor.line + i + 1, expected, actual });
		}
		const sameIgnoringIndent = stripIndent(expected) === stripIndent(actual);
		if (!sameIgnoringIndent) {
			recoverable = false;
		} else {
			indentOnly = true;
		}
	}

	// Neither note is offered once the block is unrecoverable; the escape note takes precedence.
	// Long-form design notes: docs/dev/tools.md
	if (escaped) {
		notes.push(escaped.note);
	} else if (recoverable && complete) {
		if (crOnly && !indentOnly) {
			notes.push(`the file uses ${eol.toUpperCase()} line endings and your old_string did not`);
		} else if (indentOnly) {
			notes.push("the difference is leading whitespace only");
		}
	}

	let suggestion: string | null = null;
	let declined: MissDiagnostic["declined"] = null;
	if (escaped) {
		// Correct by construction and by check: `detectEscapedMiss` only fires
		// when the respelled block occurs exactly once, verified with the real
		// matcher — the same condition the indentation route below ends with. The
		// anchor window's `complete`/`recoverable` verdicts do not apply, because
		// they were computed against the escaped spelling.
		suggestion = escaped.corrected;
	} else if (!complete) {
		declined = "line-count-differs";
	} else if (!anyDiffers || !recoverable) {
		declined = "not-indentation-only";
	} else {
		// The last condition in {@link explainMiss}'s contract: a suggestion the
		// real matcher cannot place exactly once would cost the model a turn to
		// discover, so it is checked here rather than trusted.
		const candidate = window.join(crlf ? "\r\n" : "\n");
		const hits = findMatches(content, candidate).indices.length;
		if (hits === 1) suggestion = candidate;
		else declined = hits === 0 ? "line-count-differs" : "suggestion-not-unique";
	}

	return { anchor, differences, suggestion, declined, notes };
}

function stripIndent(line: string): string {
	return line.replace(/^[ \t]*/, "");
}

interface EscapedMiss {
	/** The block respelled as the file spells it — a slice of the file, unique in it. */
	corrected: string;
	/** Which way the spelling went, phrased for the model. */
	note: string;
}

// Long-form design notes: docs/dev/tools.md
/** The miss that is a spelling of line breaks and tabs. */
function detectEscapedMiss(content: string, oldString: string): EscapedMiss | null {
	if (/\\[nrt]/.test(oldString)) {
		const real = oldString.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
		const corrected = uniqueSlice(content, real);
		if (corrected !== null) {
			return {
				corrected,
				note: "your old_string spells line breaks or tabs as the two-character escape sequences (`\\n`, `\\t`); the file has the real characters there",
			};
		}
	}
	if (/[\n\r\t]/.test(oldString)) {
		const written = oldString.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		const corrected = uniqueSlice(content, written);
		if (corrected !== null) {
			return {
				corrected,
				note: "the file spells line breaks or tabs as the two-character escape sequences (`\\n`, `\\t`); your old_string has the real characters there",
			};
		}
	}
	return null;
}

/** The file's own text for `needle` when it occurs exactly once, else `null`. */
function uniqueSlice(content: string, needle: string): string | null {
	const plan = findMatches(content, needle);
	if (plan.indices.length !== 1) return null;
	// The suggestion contract's last condition, on the slice itself: sending a
	// string the matcher finds twice back would be refused by Edit's own
	// uniqueness rule, so it is not offered here either.
	return findMatches(content, plan.texts[0]).indices.length === 1 ? plan.texts[0] : null;
}

// Long-form design notes: docs/dev/tools.md
/** Find the line the model was looking at: its first line, its last line, then a common-prefix scan. */
function locateAnchor(content: string, oldLines: string[]): MissAnchor | null {
	const fileLines = content.split("\n");
	const wanted = oldLines.filter((l) => l.trim().length > 0 && l.trim().length <= MAX_ANCHOR_CHARS);
	if (wanted.length === 0) return null;

	const first = wanted[0];
	const last = wanted[wanted.length - 1];

	for (const [how, candidate] of [
		["first-line", first],
		["last-line", last],
	] as const) {
		// Exact, then with the leading indentation dropped: a block whose first
		// line is indented differently from the file is the commonest case there is.
		for (const text of candidate === candidate.trimStart() ? [candidate] : [candidate, candidate.trimStart()]) {
			const at = uniqueIndexOfLine(fileLines, text);
			if (at !== -1) return { text, line: at, how };
		}
	}

	// Last resort: the pair (old line, file line) with the longest shared prefix.
	// Bounded on both axes, because this is the only quadratic pass in the file
	// and it runs on the failure path of every miss.
	const anchors = wanted.slice(0, MAX_SCAN_ANCHORS);
	const limit = Math.min(fileLines.length, MAX_SCAN_LINES);
	let best: { text: string; line: number; score: number } | null = null;
	for (let f = 0; f < limit; f++) {
		const file = fileLines[f];
		if (file.trim().length === 0) continue;
		for (const anchor of anchors) {
			const score = commonPrefixLength(anchor, file);
			if (score < MIN_ANCHOR_PREFIX) continue;
			if (best && score <= best.score) continue;
			best = { text: anchor, line: f, score };
		}
	}
	if (best) return { text: best.text, line: best.line, how: "common-prefix" };
	return null;
}

/** The 0-based index of the only line equal to `text`, or -1 if absent or repeated. */
function uniqueIndexOfLine(fileLines: string[], text: string): number {
	let found = -1;
	for (let i = 0; i < fileLines.length; i++) {
		if (fileLines[i].replace(/\r$/, "") !== text.replace(/\r$/, "")) continue;
		if (found !== -1) return -1;
		found = i;
	}
	return found;
}

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) i += 1;
	return i;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The not-found message, with the three things the reference omits: a line
 * number, the file's own text at that line, and — when it can be trusted — an
 * `old_string` to send back.
 */
function renderMiss(path: string, diagnostic: MissDiagnostic): string {
	const lines: string[] = [`old_string not found in ${path}.`];

	// Without an anchor there is no region to point at and the generic advice is
	// the whole message — unless the escape diagnostic respelled the block, in
	// which case that corrected text is the useful part and the advice would be
	// wrong about it ("no line resembles the file": one does, once the escapes
	// are read as the file spells them).
	if (!diagnostic.anchor && diagnostic.suggestion === null) {
		lines.push(
			"",
			"No line of old_string resembles anything in the file. Either the code changed since you read it,",
			"or old_string is not what you think it is — read the file again and copy the exact text out of it.",
		);
		return lines.join("\n");
	}

	const { anchor } = diagnostic;
	if (anchor) {
		lines.push(
			"",
			`Closest region: ${path}:${anchor.line}, located by ${HOW[anchor.how]}: ${quoteForDisplay(anchor.text.trim())}`,
		);
	}
	for (const note of diagnostic.notes) lines.push(`  ${note}`);

	if (anchor) {
		if (diagnostic.differences.length > 0) {
			lines.push("", "These lines differ:");
			for (const d of diagnostic.differences) {
				lines.push(`  line ${d.line}`);
				lines.push(`    expected: ${quoteForDisplay(d.expected)}`);
				lines.push(`    actual:   ${quoteForDisplay(d.actual)}`);
			}
		} else {
			lines.push("", "The lines at that offset are byte-identical; the block around them is not contiguous.");
		}
	}

	if (diagnostic.suggestion !== null) {
		lines.push(
			"",
			"Send this old_string back unchanged — it is the file's own text and it occurs exactly once:",
			quoteForDisplay(diagnostic.suggestion),
		);
	} else {
		// `declined` is non-null whenever `suggestion` is (`explainMiss` returns the
		// pair together); the fallback is here so a future branch cannot render
		// "undefined" into a message the model is being asked to act on.
		const why = diagnostic.declined === null ? "no reason recorded" : DECLINED[diagnostic.declined];
		lines.push("", `No corrected old_string is offered (${why}).`);
		lines.push("Re-read the file and send the exact text of the lines above.");
	}
	return lines.join("\n");
}

const HOW: Record<MissAnchor["how"], string> = {
	"first-line": "its first line",
	"last-line": "its last line",
	"common-prefix": "its longest matching line",
};

const DECLINED: Record<Exclude<MissDiagnostic["declined"], null>, string> = {
	"no-anchor": "no line of old_string resembles anything in the file",
	"not-indentation-only": "the lines differ by more than indentation and line endings",
	"line-count-differs": "the block runs past the end of the file",
	"suggestion-not-unique": "the corrected text would not be unique in the file",
};

/** A one-line, escaped rendering. A model has to be able to see a trailing space to fix one. */
function quoteForDisplay(text: string): string {
	return `"${text.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

function firstLine(text: string): string {
	const line = text.split("\n", 1)[0];
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const DIFF_CONTEXT_LINES = 2;

// Long-form design notes: docs/dev/tools.md
/** Unified-style hunk around the first replacement, enough for the UI to show what changed. */
export function miniDiff(oldContent: string, index: number, removed: string, added: string): string {
	if (index < 0 || index > oldContent.length) return "";
	const crlf = detectLineEnding(oldContent) === "crlf";
	const show = (line: string): string => (crlf ? line.replace(/\r$/, "") : line);

	const oldLines = oldContent.split("\n").map(show);
	const start = oldContent.slice(0, index).split("\n").length - 1;
	const removedLines = removed.split("\n").map(show);
	const addedLines = added.split("\n").map(show);

	const contextStart = Math.max(0, start - DIFF_CONTEXT_LINES);
	const contextBefore = oldLines.slice(contextStart, start);
	const contextAfter = oldLines.slice(start + removedLines.length, start + removedLines.length + DIFF_CONTEXT_LINES);

	const hunk: string[] = [];
	hunk.push(`@@ -${start + 1},${removedLines.length} +${start + 1},${addedLines.length} @@`);
	for (const line of contextBefore) hunk.push(`  ${line}`);
	for (const line of removedLines) hunk.push(`- ${line}`);
	for (const line of addedLines) hunk.push(`+ ${line}`);
	for (const line of contextAfter) hunk.push(`  ${line}`);
	return hunk.join("\n");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
