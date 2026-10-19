/**
 * InspectSourceMap — what a source map holds, decoded rather than taken on
 * faith.
 *
 * A source map is JSON: a version, the generated file's name, a source root,
 * the source names, a names table for renamed identifiers, and `mappings` —
 * the part that actually says anything. `mappings` is a string of
 * semicolon-separated lines of comma-separated segments, each segment a run of
 * base64 VLQ numbers: the generated column always, then a source index, an
 * original line and column, and optionally a name index. Every number but the
 * first is a delta from the one before it in its own column, and the generated
 * column resets at each semicolon, so the string is unreadable by eye — and a
 * map whose segments do not decode is a map no debugger can use, which is why
 * this reader decodes them instead of counting commas. The base64 VLQ decoder
 * and the mappings parser here are written against the format's own rules: six
 * bits per character, the high one a continuation bit, five data bits per
 * character accumulated least-significant first, and the lowest data bit a
 * sign.
 *
 * The report is the map's own facts — version, file, sourceRoot, sources,
 * names, the mappings decoded into line and segment counts, `sourcesContent`
 * by byte size only, and whether the map is an indexed map of sections — plus
 * one diagnostic line for each way an input can be wrong: not JSON, not an
 * object, no version or the wrong one, a data URI whose base64 or percent
 * encoding is broken, mappings that stop mid-number, carry a character that is
 * not a VLQ digit, or hold a segment of a field count the format does not
 * define. Nothing here throws over a damaged input, and nothing is dumped: the
 * source contents are counted, never printed, because a map's contents are a
 * copy of somebody's source files and a report is not where those get read.
 *
 * Bounds: the file is read into one buffer and refused before the read when it
 * is larger than MAX_FILE_BYTES; the source list, the name list, the per-line
 * mapping summary and the section list are each capped with a line saying what
 * was cut; and the whole report is capped like every other tool's.
 *
 * The line numbers in the mapping summary count the mappings string's
 * semicolon-separated groups from 1 — the first group is "line 1" — while an
 * indexed map's section offsets are printed the way the format writes them,
 * from 0. The reader takes a source map file, and a JavaScript or TypeScript
 * file whose last `//# sourceMappingURL` comment carries an inline
 * `data:application/json` URI, base64 or percent-encoded. A comment naming an
 * external file is reported by name and not followed: this tool reads the file
 * it was pointed at, and no other.
 */
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { type AnyTool, buildTool, formatCutMarker } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";
import { describeFsFailure } from "./path-errors.ts";

/** Whole-report cap; past it the tail is cut with an explicit marker. */
const MAX_REPORT_CHARS = 20_000;

/**
 * Past this the file is refused before it is read: the map is parsed from one
 * buffer. A map already carries the mappings and, when it has them, a copy of
 * every source file as `sourcesContent`, so the real ones are a few megabytes;
 * this bound is far past any map and still far short of what would put the
 * agent process at risk.
 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Source names the report lists before it counts the rest. */
const MAX_LISTED_SOURCES = 20;

/** Name-table entries the report lists before it counts the rest. */
const MAX_LISTED_NAMES = 20;

/** Mappings lines the report summarizes before it counts the rest. */
const MAX_LISTED_MAPPING_LINES = 12;

/** Sections of an indexed map the report lists before it counts the rest. */
const MAX_LISTED_SECTIONS = 8;

/** Characters one source name, name entry or URL is shown with before it is cut. */
const MAX_NAME_CHARS = 200;

/**
 * VLQ digits one number may carry. Each digit holds five data bits, so seven
 * digits hold the 35 bits that cover every 32-bit field the format can mean;
 * eight is a number no encoder wrote, and an unbounded run of them would be a
 * way to make the decoder spin.
 */
const MAX_VLQ_DIGITS = 7;

// ---------------------------------------------------------------------------
// The base64 VLQ decoder
// ---------------------------------------------------------------------------

/** The six-bit value one base64 digit carries, or null when the character is no digit. */
function vlqDigit(code: number): number | null {
	if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z: 0-25
	if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26; // a-z: 26-51
	if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52; // 0-9: 52-61
	if (code === 0x2b) return 62; // +
	if (code === 0x2f) return 63; // /
	return null;
}

export type VlqDecode =
	| { readonly ok: true; readonly values: readonly number[] }
	| { readonly ok: false; readonly at: number; readonly reason: string };

/**
 * Decode one segment: the base64 VLQ numbers it holds, back to back, until the
 * segment ends. `at` on a failure is the segment-relative index the reader
 * stopped at.
 */
export function decodeSegment(segment: string): VlqDecode {
	const values: number[] = [];
	let index = 0;
	while (index < segment.length) {
		const start = index;
		let encoded = 0;
		let shift = 0;
		let digits = 0;
		for (;;) {
			if (index >= segment.length) {
				return { ok: false, at: start, reason: "a VLQ number is cut off (its last digit's continuation bit is set)" };
			}
			const digit = vlqDigit(segment.charCodeAt(index));
			if (digit === null) return { ok: false, at: index, reason: `"${segment[index]}" is not a base64 VLQ digit` };
			digits++;
			if (digits > MAX_VLQ_DIGITS) {
				return {
					ok: false,
					at: start,
					reason: `a VLQ number carries more than ${MAX_VLQ_DIGITS} digits, past what any field of this format holds`,
				};
			}
			// Arithmetic, not `|`: the shifts past bit 30 would wrap in 32-bit
			// bitwise operators and turn an over-long number into a plausible one.
			encoded += (digit & 31) * 2 ** shift;
			shift += 5;
			index++;
			if ((digit & 32) === 0) break;
		}
		const negative = encoded % 2 === 1;
		const magnitude = (encoded - (encoded % 2)) / 2;
		values.push(negative ? -magnitude : magnitude);
	}
	return { ok: true, values };
}

// ---------------------------------------------------------------------------
// The mappings parser
// ---------------------------------------------------------------------------

export interface MappingsSummary {
	/** Semicolon-separated groups: the mappings' lines, empty ones included. */
	readonly lines: number;
	readonly segments: number;
	/** Segments by shape: the generated column alone, with a source, with a name. */
	readonly columnOnly: number;
	readonly withSource: number;
	readonly withName: number;
	/** Segment counts of the first MAX_LISTED_MAPPING_LINES lines, in order. */
	readonly firstLines: readonly number[];
}

export type MappingsDecode =
	| { readonly ok: true; readonly summary: MappingsSummary }
	| { readonly ok: false; readonly line: number; readonly position: number; readonly reason: string };

/**
 * Walk a `mappings` string: split into lines at `;`, segments at `,`, and
 * decode each segment. The counts are totals; only the first lines keep their
 * per-line counts, because a mappings string may hold millions of lines and
 * the report shows a summary, not the string.
 *
 * The format defines segments of one field (a generated column), four (plus a
 * source index, original line and original column) and five (plus a name
 * index); any other count is reported as the malformation it is rather than
 * guessed at. A line with no segments — an empty group, which a trailing or
 * doubled `;` produces — is legal and counts as a line, while an empty
 * *segment* (a doubled or trailing `,`) is not.
 */
export function decodeMappings(mappings: string): MappingsDecode {
	const firstLines: number[] = [];
	let lines = 0;
	let segments = 0;
	let columnOnly = 0;
	let withSource = 0;
	let withName = 0;
	if (mappings.length > 0) {
		const groups = mappings.split(";");
		lines = groups.length;
		for (let line = 0; line < groups.length; line++) {
			const parts = groups[line] === "" ? [] : groups[line].split(",");
			segments += parts.length;
			if (line < MAX_LISTED_MAPPING_LINES) firstLines.push(parts.length);
			let at = 0;
			for (const part of parts) {
				const start = at;
				at += part.length + 1;
				if (part === "") {
					return {
						ok: false,
						line: line + 1,
						position: start + 1,
						reason: "a segment is empty (two commas in a row, or a trailing comma)",
					};
				}
				const decoded = decodeSegment(part);
				if (!decoded.ok) {
					return { ok: false, line: line + 1, position: start + decoded.at + 1, reason: decoded.reason };
				}
				const fields = decoded.values.length;
				if (fields === 1) columnOnly++;
				else if (fields === 4) withSource++;
				else if (fields === 5) withName++;
				else {
					return {
						ok: false,
						line: line + 1,
						position: start + 1,
						reason: `a segment carries ${fields} field(s); the format defines segments of 1, 4 and 5`,
					};
				}
			}
		}
	}
	return { ok: true, summary: { lines, segments, columnOnly, withSource, withName, firstLines } };
}

// ---------------------------------------------------------------------------
// Inline maps: the sourceMappingURL comment
// ---------------------------------------------------------------------------

export type InlineMap =
	| { readonly kind: "base64"; readonly payload: string }
	| { readonly kind: "percent"; readonly payload: string }
	| { readonly kind: "external"; readonly url: string };

/**
 * The comment's URL, when the text carries one. The generation of a file may
 * append several `//# sourceMappingURL` comments; the format says the last one
 * is the one that counts, so this keeps reading and returns the last match
 * rather than the first.
 */
const SOURCE_MAPPING_URL = /\/\/[#@][ \t]*sourceMappingURL[ \t]*=[ \t]*(\S+)/g;

/** The data URI prefix an inline source map must carry. */
const INLINE_JSON_TYPE = "data:application/json";

export function findSourceMappingUrl(text: string): InlineMap | null {
	let last: RegExpMatchArray | null = null;
	for (const match of text.matchAll(SOURCE_MAPPING_URL)) last = match;
	if (last === null) return null;
	const url = last[1];
	if (!url.startsWith(INLINE_JSON_TYPE)) return { kind: "external", url };
	const comma = url.indexOf(",");
	if (comma === -1) return { kind: "external", url };
	const header = url.slice(0, comma);
	const payload = url.slice(comma + 1);
	return /;base64$/i.test(header) ? { kind: "base64", payload } : { kind: "percent", payload };
}

/**
 * The bytes a base64 payload decodes to, or null when it is not base64.
 *
 * `Buffer.from(text, "base64")` cannot be trusted alone: it skips characters
 * it does not recognise and keeps whatever it read, so a payload with garbage
 * in it decodes to *some* bytes and the map after it fails in a place that
 * blames the JSON. This checks the shape first — the alphabet, the padding,
 * and a length that is not one short of a block — and then the round trip,
 * which also catches a payload whose final bits are not zero-padded the way
 * the encoding requires.
 */
export function decodeBase64(text: string): Buffer | null {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
	if (text.length % 4 === 1) return null;
	const bytes = Buffer.from(text, "base64");
	const canonical = bytes.toString("base64").replace(/=+$/, "");
	return canonical === text.replace(/=+$/, "") ? bytes : null;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** The report lines for one file: what the map says, or what is wrong with it. */
export function sourceMapLines(displayPath: string, data: Buffer): string[] {
	const lines = [`InspectSourceMap report for ${displayPath}`];
	const text = data.toString("utf8").replace(/^\uFEFF/, "");
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		// It opens like JSON, and that is the reading it asked for. A JavaScript
		// file whose first statement is an object literal is the one case this
		// gets wrong, so a parse that fails gets a second look for an inline map
		// before the failure is reported.
		const parsed = parseJson(trimmed);
		if (parsed.ok) {
			if (!isRecord(parsed.value)) {
				lines.push(`the JSON top level is ${describeType(parsed.value)}, not a source map object`);
				return lines;
			}
			lines.push(`json: well-formed (${count(Buffer.byteLength(trimmed), "byte", "bytes")})`);
			lines.push(...mapLines(parsed.value));
			return lines;
		}
		const inline = findSourceMappingUrl(text);
		if (inline !== null && inline.kind !== "external") return [...lines, ...inlineMapLines(inline)];
		lines.push(`the file's JSON is not well-formed (${parsed.error})`);
		return lines;
	}

	const inline = findSourceMappingUrl(text);
	if (inline === null) {
		lines.push("the file is neither a JSON source map object nor a file carrying a //# sourceMappingURL comment");
		return lines;
	}
	if (inline.kind === "external") {
		lines.push(
			`the file's //# sourceMappingURL points at an external map ("${printable(inline.url, MAX_NAME_CHARS)}") — ` +
				"this tool reads a map from the file it is pointed at, so pass that file instead",
		);
		return lines;
	}
	return [...lines, ...inlineMapLines(inline)];
}

/** The decoded inline map's lines, after its own encoding gets its say first. */
function inlineMapLines(inline: InlineMap & { kind: "base64" | "percent" }): string[] {
	const lines: string[] = [];
	let bytes: Buffer;
	if (inline.kind === "base64") {
		const decoded = decodeBase64(inline.payload);
		if (decoded === null) {
			return [
				`the inline map's base64 payload is not valid base64 (${count(inline.payload.length, "character", "characters")})`,
			];
		}
		bytes = decoded;
		lines.push(
			`map source: inline data URI (base64, ${count(inline.payload.length, "character", "characters")}, ` +
				`${count(bytes.length, "byte", "bytes")} decoded)`,
		);
	} else {
		let decoded: string;
		try {
			decoded = decodeURIComponent(inline.payload);
		} catch (error) {
			return [`the inline map's percent-encoding is malformed (${message(error)})`];
		}
		bytes = Buffer.from(decoded, "utf8");
		lines.push(`map source: inline data URI (percent-encoded, ${count(bytes.length, "byte", "bytes")})`);
	}

	const text = bytes
		.toString("utf8")
		.replace(/^\uFEFF/, "")
		.trim();
	const parsed = parseJson(text);
	if (!parsed.ok) {
		lines.push(`the inline map is not well-formed JSON (${parsed.error})`);
		return lines;
	}
	if (!isRecord(parsed.value)) {
		lines.push(`the inline map's JSON top level is ${describeType(parsed.value)}, not a source map object`);
		return lines;
	}
	lines.push(`json: well-formed (${count(Buffer.byteLength(text), "byte", "bytes")})`);
	lines.push(...mapLines(parsed.value));
	return lines;
}

/** One map object's facts, in the order a reader asks for them. */
function mapLines(map: Record<string, unknown>): string[] {
	const lines = [versionLine(map.version)];
	const file = stringField("file", map.file);
	if (file !== null) lines.push(file);
	const sourceRoot = stringField("sourceRoot", map.sourceRoot);
	if (sourceRoot !== null) lines.push(sourceRoot);
	lines.push(...sourcesLines(map.sources));
	lines.push(...namesLines(map.names));
	lines.push(...mappingsLines(map));
	lines.push(...sourcesContentLines(map.sourcesContent));
	lines.push(...sectionsLines(map.sections));
	return lines;
}

function versionLine(value: unknown): string {
	if (value === undefined) return "version: (absent; the format defines version 3)";
	if (value === 3) return "version: 3";
	return `version: ${shortValue(value)} (the format defines version 3)`;
}

/** A field shown only when the map carries it as a string; a wrong type says so. */
function stringField(name: string, value: unknown): string | null {
	if (value === undefined) return null;
	if (typeof value !== "string") return `${name}: (${describeType(value)}, not a string)`;
	return `${name}: ${printable(value, MAX_NAME_CHARS)}`;
}

function sourcesLines(value: unknown): string[] {
	if (value === undefined) return ["sources: (absent)"];
	if (!Array.isArray(value)) return [`sources: (${describeType(value)}, not a list)`];
	const lines = [`sources: ${value.length}`];
	const listed = Math.min(value.length, MAX_LISTED_SOURCES);
	for (let index = 0; index < listed; index++) lines.push(`  ${sourceName(value[index])}`);
	if (value.length > listed) lines.push(`  ... and ${value.length - listed} more`);
	return lines;
}

function sourceName(entry: unknown): string {
	return typeof entry === "string" ? printable(entry, MAX_NAME_CHARS) : `(${describeType(entry)}, not a string)`;
}

function namesLines(value: unknown): string[] {
	if (value === undefined) return ["names: (absent)"];
	if (!Array.isArray(value)) return [`names: (${describeType(value)}, not a list)`];
	const lines = [`names: ${value.length}`];
	const listed = Math.min(value.length, MAX_LISTED_NAMES);
	for (let index = 0; index < listed; index++) lines.push(`  ${sourceName(value[index])}`);
	if (value.length > listed) lines.push(`  ... and ${value.length - listed} more`);
	return lines;
}

/**
 * The mappings, decoded. A map with sections has no top-level mappings and
 * says nothing about their absence; a map with neither is named as the empty
 * shell it is.
 */
function mappingsLines(map: Record<string, unknown>): string[] {
	const value = map.mappings;
	if (value === undefined) {
		if (Array.isArray(map.sections) && map.sections.length > 0) return [];
		return ["mappings: (absent, and there are no sections — the map has nothing to decode)"];
	}
	if (typeof value !== "string") return [`mappings: (${describeType(value)}, not a string)`];
	const decoded = decodeMappings(value);
	if (!decoded.ok) return [`mappings line ${decoded.line}, position ${decoded.position}: ${decoded.reason}`];
	const { summary } = decoded;
	const lines = [
		`mappings: ${count(summary.lines, "line", "lines")}, ${count(summary.segments, "segment", "segments")} ` +
			`(${summary.columnOnly} column-only, ${summary.withSource} with a source, ${summary.withName} with a name)`,
	];
	for (let index = 0; index < summary.firstLines.length; index++) {
		lines.push(`  line ${index + 1}: ${count(summary.firstLines[index], "segment", "segments")}`);
	}
	if (summary.lines > summary.firstLines.length) {
		lines.push(`  ... and ${count(summary.lines - summary.firstLines.length, "more line", "more lines")}`);
	}
	return lines;
}

/**
 * `sourcesContent` by size, never by content: the entries are copies of
 * somebody's source files, and a report is not where those get read. Nulls are
 * legal in the field (a source with no content to embed) and count as zero
 * bytes; so does anything else that is not a string, which is also counted.
 */
function sourcesContentLines(value: unknown): string[] {
	if (value === undefined) return ["sourcesContent: absent"];
	if (!Array.isArray(value)) return [`sourcesContent: (${describeType(value)}, not a list)`];
	let bytes = 0;
	let notStrings = 0;
	for (const entry of value) {
		if (typeof entry === "string") bytes += Buffer.byteLength(entry, "utf8");
		else notStrings++;
	}
	const note = notStrings > 0 ? ` (${count(notStrings, "entry", "entries")} not a string)` : "";
	return [`sourcesContent: ${count(value.length, "entry", "entries")}, ${count(bytes, "byte", "bytes")}${note}`];
}

/**
 * An indexed map's sections: each one an offset into the generated file and
 * either a map of its own or a url to one. The nested map is summarized, not
 * descended into — it would multiply the report by the section count for a
 * shape that is already one level of nesting deep.
 */
function sectionsLines(value: unknown): string[] {
	if (value === undefined) return ["sections: none"];
	if (!Array.isArray(value)) return [`sections: (${describeType(value)}, not a list)`];
	const lines = [`sections: ${value.length}`];
	const listed = Math.min(value.length, MAX_LISTED_SECTIONS);
	for (let index = 0; index < listed; index++) lines.push(sectionLine(value[index], index));
	if (value.length > listed) lines.push(`  ... and ${value.length - listed} more`);
	return lines;
}

function sectionLine(section: unknown, index: number): string {
	if (!isRecord(section)) return `  section ${index + 1}: (${describeType(section)}, not an object)`;
	const { offset } = section;
	const at =
		isRecord(offset) && typeof offset.line === "number" && typeof offset.column === "number"
			? `generated line ${offset.line}, column ${offset.column}`
			: "offset: (not a {line, column} object)";
	if (isRecord(section.map)) return `  section ${index + 1}: ${at} — map: ${sectionMapSummary(section.map)}`;
	if (typeof section.url === "string") {
		return `  section ${index + 1}: ${at} — url "${printable(section.url, MAX_NAME_CHARS)}" (not followed)`;
	}
	return `  section ${index + 1}: ${at} — neither a map nor a url`;
}

/** One nested section map in a clause: what it is, how big, and whether it decodes. */
function sectionMapSummary(map: Record<string, unknown>): string {
	const version = map.version === undefined ? "(absent)" : shortValue(map.version);
	const parts = [map.version === 3 ? "version 3" : `version ${version}`];
	if (Array.isArray(map.sources)) parts.push(count(map.sources.length, "source", "sources"));
	if (Array.isArray(map.sections) && map.sections.length > 0) {
		parts.push(count(map.sections.length, "nested section", "nested sections"));
	}
	if (typeof map.mappings === "string") {
		const decoded = decodeMappings(map.mappings);
		if (decoded.ok) {
			parts.push(
				`${count(decoded.summary.lines, "line", "lines")} of mappings, ` +
					`${count(decoded.summary.segments, "segment", "segments")}`,
			);
		} else {
			parts.push(`mappings do not decode (line ${decoded.line}, position ${decoded.position}: ${decoded.reason})`);
		}
	}
	return parts.join(", ");
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** What a source map file holds, and whether its mappings decode. */
export function createInspectSourceMapTool(cwd: string): AnyTool {
	return buildTool({
		name: "InspectSourceMap",
		description:
			"Reports what a source map file holds and whether its mappings decode: the JSON's well-formedness, " +
			"the map version, file, sourceRoot, the source names and count, the names table, the decoded mappings " +
			"(line and segment counts, the mix of segment shapes, and the first lines' segment counts), the " +
			"sourcesContent entry count and byte sizes (the contents themselves are never printed), and whether " +
			"the map is an indexed map of sections. It also reads a JavaScript or TypeScript file whose last " +
			"//# sourceMappingURL comment is an inline data:application/json URI, base64 or percent-encoded. " +
			"Damaged input — bad JSON, a wrong or absent version, bad base64, a truncated VLQ, an illegal " +
			"mappings character — comes back as diagnostic lines, never as an exception. The tool does not " +
			"resolve the source names, print the source contents, or check the mapping against the generated " +
			"file. Use it to answer whether a map is intact and what it covers.",
		inputSchema: z.object({
			path: z.string().describe("Path to the source map file (.map), or to a JS/TS file with an inline map"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			let source: string;
			try {
				source = guardPathContainment(input.path, cwd, "InspectSourceMap");
			} catch (error) {
				return { content: [{ type: "text", text: message(error) }], isError: true };
			}
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await stat(source);
			} catch (error) {
				return {
					content: [{ type: "text", text: describeFsFailure(error, input.path, "inspect") }],
					isError: true,
				};
			}
			if (info.isDirectory()) {
				return {
					content: [{ type: "text", text: `${input.path} is a directory, not a source map file.` }],
					isError: true,
				};
			}
			if (!info.isFile()) {
				return { content: [{ type: "text", text: `${input.path} is not a regular file.` }], isError: true };
			}
			// Refused before the read, not after an out-of-memory: the map is
			// parsed from one buffer, and a file this large is not a map.
			if (info.size > MAX_FILE_BYTES) {
				return {
					content: [
						{
							type: "text",
							text:
								`InspectSourceMap: ${input.path}: the file is ${info.size} bytes, past the ` +
								`${MAX_FILE_BYTES} this inspection reads into memory.`,
						},
					],
					isError: true,
				};
			}
			let data: Buffer;
			try {
				data = readFileSync(source);
			} catch (error) {
				return {
					content: [{ type: "text", text: `InspectSourceMap: ${input.path}: could not be read (${message(error)})` }],
					isError: true,
				};
			}
			let report: string;
			try {
				report = sourceMapLines(input.path, data).join("\n");
			} catch (error) {
				return {
					content: [
						{ type: "text", text: `InspectSourceMap: ${input.path}: could not be inspected (${message(error)})` },
					],
					isError: true,
				};
			}
			return { content: [{ type: "text", text: capReport(report) }] };
		},
	});
}

/** The report up to `MAX_REPORT_CHARS`, with the usual marker naming what was cut. */
function capReport(report: string): string {
	if (report.length <= MAX_REPORT_CHARS) return report;
	return `${report.slice(0, MAX_REPORT_CHARS)}\n${formatCutMarker(report.length - MAX_REPORT_CHARS)}`;
}

// ---------------------------------------------------------------------------
// Small shared forms
// ---------------------------------------------------------------------------

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, error: message(error) };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "a list";
	if (typeof value === "string") return "a string";
	if (typeof value === "number") return "a number";
	if (typeof value === "boolean") return "a boolean";
	return "an object";
}

/** A value as JSON spells it, capped: how a wrong version or offset is shown. */
function shortValue(value: unknown): string {
	return printable(JSON.stringify(value) ?? String(value), 100);
}

/** Text as one line, control characters escaped, capped with the count kept. */
function printable(text: string, max: number): string {
	let out = "";
	let shown = 0;
	let total = 0;
	for (const character of text) {
		total++;
		if (shown >= max) continue;
		shown++;
		const code = character.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : character;
	}
	return total > shown ? `${out}… [${count(total - shown, "more character", "more characters")}]` : out;
}

function count(n: number, singular: string, plural: string): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
