/**
 * `sourcemap.ts` — the report, from synthesized maps only.
 *
 * The mappings strings in this file are encoded by hand from the base64 VLQ
 * rules: each character carries five data bits and a continuation bit, the
 * groups accumulate from least significant, and the lowest data bit is the
 * sign. So "A" is 0, "C" is +1, "D" is -1, "E" is +2, "gB" is 16 and "ggC" is
 * 1024 — every expected decode below can be checked by reading the string,
 * rather than by trusting the decoder to agree with itself. The fixtures are
 * written as exact bytes (JSON spelled out, not stringified from an object),
 * so a changed field order would fail a test rather than pass unnoticed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createInspectSourceMapTool,
	decodeBase64,
	decodeMappings,
	decodeSegment,
	findSourceMappingUrl,
	type MappingsDecode,
	type MappingsSummary,
} from "../src/sourcemap.ts";

const roots: string[] = [];
afterEach(() => {
	// maxRetries: a freshly written file's handle can outlive the test on
	// Windows for a beat, and a failure to clean up must not fail the run.
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-sourcemap-"));
	roots.push(dir);
	return dir;
}

const ctx = (cwd: string) => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd,
	sandbox: "workspace-write" as const,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
});

function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { text: string }).text;
}

function fixture(dir: string, name: string, content: string | Buffer): void {
	writeFileSync(join(dir, name), content);
}

async function run(dir: string, name: string) {
	return createInspectSourceMapTool(dir).call({ path: name }, ctx(dir));
}

/** Write the fixture and hand back the tool's report text. */
async function report(dir: string, name: string, content: string | Buffer): Promise<string> {
	fixture(dir, name, content);
	return textOf(await run(dir, name));
}

function summaryOf(decoded: MappingsDecode): MappingsSummary {
	if (!decoded.ok)
		throw new Error(
			`the mappings did not decode: line ${decoded.line}, position ${decoded.position}: ${decoded.reason}`,
		);
	return decoded.summary;
}

function failureOf(decoded: MappingsDecode): { line: number; position: number; reason: string } {
	if (decoded.ok) throw new Error("the mappings were expected to fail to decode and did not");
	return decoded;
}

// ---------------------------------------------------------------------------
// The base64 VLQ decoder
// ---------------------------------------------------------------------------

describe("the base64 VLQ decoder", () => {
	test("one number, by the rules of the encoding", () => {
		const values = (segment: string): readonly number[] => {
			const decoded = decodeSegment(segment);
			if (!decoded.ok) throw new Error(`"${segment}" did not decode: ${decoded.reason}`);
			return decoded.values;
		};

		expect(values("A")).toEqual([0]);
		expect(values("C")).toEqual([1]);
		expect(values("D")).toEqual([-1]);
		expect(values("E")).toEqual([2]);
		// "g" carries a continuation bit and a zero data group; "B" closes the
		// number with one group of 1 shifted up five places: 32, even, +16.
		expect(values("gB")).toEqual([16]);
		// Two continuation characters, then 2 << 10 = 2048, even, +1024.
		expect(values("ggC")).toEqual([1024]);
	});

	test("a segment is numbers back to back", () => {
		expect(decodeSegment("AAAA")).toEqual({ ok: true, values: [0, 0, 0, 0] });
		// 1 (generated column), 0 (source), 0 (line), 1 (column).
		expect(decodeSegment("CAAC")).toEqual({ ok: true, values: [1, 0, 0, 1] });
		expect(decodeSegment("AAAAA")).toEqual({ ok: true, values: [0, 0, 0, 0, 0] });
	});

	test("a number that stops mid-way is located at its start", () => {
		const decoded = decodeSegment("gg");
		expect(decoded.ok).toBe(false);
		if (decoded.ok) throw new Error("unreachable");
		expect(decoded.at).toBe(0);
		expect(decoded.reason).toContain("a VLQ number is cut off");
	});

	test("a character outside the alphabet names itself", () => {
		const decoded = decodeSegment("A!A");
		expect(decoded.ok).toBe(false);
		if (decoded.ok) throw new Error("unreachable");
		expect(decoded.at).toBe(1);
		expect(decoded.reason).toBe('"!" is not a base64 VLQ digit');
	});

	test("a number longer than any field allows is refused", () => {
		const decoded = decodeSegment("gggggggg");
		expect(decoded.ok).toBe(false);
		if (decoded.ok) throw new Error("unreachable");
		expect(decoded.reason).toContain("more than 7 digits");
	});
});

// ---------------------------------------------------------------------------
// The mappings parser
// ---------------------------------------------------------------------------

describe("the mappings parser", () => {
	test("an empty string is no lines and no segments", () => {
		expect(summaryOf(decodeMappings(""))).toEqual({
			lines: 0,
			segments: 0,
			columnOnly: 0,
			withSource: 0,
			withName: 0,
			firstLines: [],
		});
	});

	test("segments split at commas and lines at semicolons", () => {
		const oneLine = summaryOf(decodeMappings("AAAA,CAAC"));
		expect(oneLine.lines).toBe(1);
		expect(oneLine.segments).toBe(2);
		expect(oneLine.firstLines).toEqual([2]);

		expect(summaryOf(decodeMappings("AACA;AACA"))).toEqual({
			lines: 2,
			segments: 2,
			columnOnly: 0,
			withSource: 2,
			withName: 0,
			firstLines: [1, 1],
		});
	});

	test("an empty line is a line; an empty segment is a malformation", () => {
		// A trailing semicolon opens a line nothing was mapped into; that is
		// legal, and it still counts as a line.
		const trailing = summaryOf(decodeMappings("AAAA;"));
		expect(trailing.lines).toBe(2);
		expect(trailing.segments).toBe(1);
		expect(trailing.firstLines).toEqual([1, 0]);

		// "AAAA,,CAAC": the empty segment starts after the second comma, at the
		// sixth character of the line.
		const empty = failureOf(decodeMappings("AAAA,,CAAC"));
		expect(empty.line).toBe(1);
		expect(empty.position).toBe(6);
		expect(empty.reason).toContain("a segment is empty (two commas in a row, or a trailing comma)");
	});

	test("segment shapes are counted, and one the format does not define is refused", () => {
		expect(summaryOf(decodeMappings("A,AAAA,AAAAA"))).toEqual({
			lines: 1,
			segments: 3,
			columnOnly: 1,
			withSource: 1,
			withName: 1,
			firstLines: [3],
		});

		const twoFields = failureOf(decodeMappings("AA"));
		expect(twoFields.line).toBe(1);
		expect(twoFields.position).toBe(1);
		expect(twoFields.reason).toBe("a segment carries 2 field(s); the format defines segments of 1, 4 and 5");
	});

	test("a failure is located within its own line", () => {
		const decoded = failureOf(decodeMappings("AAAA;A!A"));
		expect(decoded.line).toBe(2);
		expect(decoded.position).toBe(2);
	});

	test("only the first twelve lines keep their per-line counts", () => {
		const decoded = summaryOf(decodeMappings(Array.from({ length: 15 }, () => "AAAA").join(";")));
		expect(decoded.lines).toBe(15);
		expect(decoded.segments).toBe(15);
		expect(decoded.firstLines).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
	});
});

// ---------------------------------------------------------------------------
// base64 and the sourceMappingURL comment
// ---------------------------------------------------------------------------

describe("base64", () => {
	test("valid payloads decode, with and without padding", () => {
		expect(decodeBase64("AQ==")).toEqual(Buffer.from([1]));
		expect(decodeBase64("AQ")).toEqual(Buffer.from([1]));
		expect(decodeBase64("")).toEqual(Buffer.alloc(0));
	});

	test("a stray character and a length one short of a block are refused", () => {
		expect(decodeBase64("!!!!")).toBeNull();
		expect(decodeBase64("AQ=A")).toBeNull();
		expect(decodeBase64("AAAAA")).toBeNull();
	});

	test("leftover bits from a non-canonical encoding are refused", () => {
		// "AAB" decodes to two zero bytes, but the two spare bits the third
		// character carries are set; re-encoding gives "AAA", not what came in.
		expect(decodeBase64("AAB")).toBeNull();
	});
});

describe("the sourceMappingURL comment", () => {
	test("the forms are told apart", () => {
		expect(findSourceMappingUrl("//# sourceMappingURL=data:application/json;base64,QUFB")).toEqual({
			kind: "base64",
			payload: "QUFB",
		});
		expect(findSourceMappingUrl("//# sourceMappingURL=data:application/json;charset=utf-8,%7B%7D")).toEqual({
			kind: "percent",
			payload: "%7B%7D",
		});
		expect(findSourceMappingUrl("//# sourceMappingURL=data:application/json,%7B%7D")).toEqual({
			kind: "percent",
			payload: "%7B%7D",
		});
		expect(findSourceMappingUrl("//# sourceMappingURL=out.js.map")).toEqual({ kind: "external", url: "out.js.map" });
	});

	test("the legacy //@ marker and spaces around the equals sign are accepted", () => {
		expect(findSourceMappingUrl("//@ sourceMappingURL = out.js.map")).toEqual({ kind: "external", url: "out.js.map" });
	});

	test("the last comment wins, as the format says", () => {
		const text = "a();\n//# sourceMappingURL=data:application/json;base64,QUFB\n//# sourceMappingURL=out.js.map\n";
		expect(findSourceMappingUrl(text)).toEqual({ kind: "external", url: "out.js.map" });
	});

	test("a file with no comment has none", () => {
		expect(findSourceMappingUrl("console.log(1);\n")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const SIMPLE = `{"version":3,"file":"out.js","sourceRoot":"../src","sources":["a.ts"],"names":["foo"],"mappings":"AAAA,CAAC;AACA"}`;

describe("the report", () => {
	test("a plain map reports its fields and its decoded mappings", async () => {
		const dir = tempDir();
		const text = await report(dir, "simple.map", SIMPLE);

		expect(text).toBe(
			[
				"InspectSourceMap report for simple.map",
				`json: well-formed (${SIMPLE.length} bytes)`,
				"version: 3",
				"file: out.js",
				"sourceRoot: ../src",
				"sources: 1",
				"  a.ts",
				"names: 1",
				"  foo",
				"mappings: 2 lines, 3 segments (0 column-only, 3 with a source, 0 with a name)",
				"  line 1: 2 segments",
				"  line 2: 1 segment",
				"sourcesContent: absent",
				"sections: none",
			].join("\n"),
		);
	});

	test("segment shapes split by field count", async () => {
		const dir = tempDir();
		const text = await report(dir, "shapes.map", `{"version":3,"sources":[],"names":[],"mappings":"A,AAAA,AAAAA"}`);

		expect(text).toContain("mappings: 1 line, 3 segments (1 column-only, 1 with a source, 1 with a name)");
		expect(text).toContain("  line 1: 3 segments");
	});

	test("the per-line summary stops at twelve lines and counts the rest", async () => {
		const dir = tempDir();
		const mappings = Array.from({ length: 15 }, () => "AAAA").join(";");
		const text = await report(dir, "lines.map", `{"version":3,"sources":[],"names":[],"mappings":"${mappings}"}`);

		expect(text).toContain("mappings: 15 lines, 15 segments");
		expect(text).toContain("  line 12: 1 segment");
		expect(text).not.toContain("  line 13:");
		expect(text).toContain("  ... and 3 more lines");
	});

	test("source names and name entries are bounded", async () => {
		const dir = tempDir();
		const sources = Array.from({ length: 25 }, (_, i) => `"s${i}.ts"`).join(",");
		const names = Array.from({ length: 25 }, (_, i) => `"n${i}"`).join(",");
		const text = await report(
			dir,
			"many.map",
			`{"version":3,"sources":[${sources}],"names":[${names}],"mappings":"AAAA"}`,
		);

		expect(text).toContain("sources: 25");
		expect(text).toContain("  s19.ts");
		expect(text).not.toContain("  s20.ts");
		expect(text).toContain("names: 25");
		expect(text).toContain("  n19");
		expect(text).not.toContain("  n20");
		expect(text.match(/\.\.\. and 5 more/g)?.length).toBe(2);
	});

	test("a long source name is cut, with the count of what was cut kept", async () => {
		const dir = tempDir();
		const long = "x".repeat(250);
		const text = await report(dir, "long.map", `{"version":3,"sources":["${long}"],"mappings":"AAAA"}`);

		expect(text).toContain(`  ${"x".repeat(200)}… [50 more characters]`);
	});

	test("a source name with a newline is escaped to one line", async () => {
		const dir = tempDir();
		const text = await report(dir, "escape.map", `{"version":3,"sources":["a\\nb.ts"],"mappings":"AAAA"}`);

		expect(text).toContain("  a\\x0ab.ts");
	});

	test("sourcesContent is reported by size and never by content", async () => {
		const dir = tempDir();
		const text = await report(
			dir,
			"content.map",
			`{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA","sourcesContent":["SECRET-aaaa","bb"]}`,
		);

		const bytes = Buffer.byteLength("SECRET-aaaa", "utf8") + Buffer.byteLength("bb", "utf8");
		expect(text).toContain(`sourcesContent: 2 entries, ${bytes} bytes`);
		expect(text).not.toContain("SECRET");
	});

	test("a null sourcesContent entry counts as zero bytes and is noted", async () => {
		const dir = tempDir();
		const text = await report(dir, "null.map", `{"version":3,"sources":[],"mappings":"","sourcesContent":[null,"xy"]}`);

		expect(text).toContain("sourcesContent: 2 entries, 2 bytes (1 entry not a string)");
		expect(text).toContain("mappings: 0 lines, 0 segments (0 column-only, 0 with a source, 0 with a name)");
	});

	test("an indexed map lists its sections and summarizes the maps inside them", async () => {
		const dir = tempDir();
		const inner = `{"version":3,"sources":["a.ts"],"mappings":"AAAA;AACA"}`;
		const text = await report(
			dir,
			"indexed.map",
			`{"version":3,"sections":[{"offset":{"line":0,"column":0},"map":${inner}},` +
				`{"offset":{"line":10,"column":5},"url":"chunk.map"}]}`,
		);

		expect(text).toContain("sources: (absent)");
		expect(text).toContain("sections: 2");
		expect(text).toContain(
			"  section 1: generated line 0, column 0 — map: version 3, 1 source, 2 lines of mappings, 2 segments",
		);
		expect(text).toContain('  section 2: generated line 10, column 5 — url "chunk.map" (not followed)');
		// An indexed map has no top-level mappings, and their absence is not a
		// fault to report.
		expect(text).not.toContain("\nmappings:");
	});

	test("a nested indexed map is counted, not descended into", async () => {
		const dir = tempDir();
		const inner = `{"version":3,"sections":[{"offset":{"line":0,"column":0},"url":"a.map"}]}`;
		const text = await report(
			dir,
			"nested.map",
			`{"version":3,"sections":[{"offset":{"line":0,"column":0},"map":${inner}}]}`,
		);

		expect(text).toContain("— map: version 3, 1 nested section");
	});

	test("sections that are not objects, offsets that are not positions, and a map without either field", async () => {
		const dir = tempDir();
		const text = await report(
			dir,
			"odd-sections.map",
			`{"version":3,"sections":[7,{"offset":{"line":1}},{"offset":{"line":2,"column":3},"map":{"version":2}}]}`,
		);

		expect(text).toContain("sections: 3");
		expect(text).toContain("  section 1: (a number, not an object)");
		expect(text).toContain("  section 2: offset: (not a {line, column} object) — neither a map nor a url");
		expect(text).toContain("  section 3: generated line 2, column 3 — map: version 2");
	});

	test("the section list stops at eight and counts the rest", async () => {
		const dir = tempDir();
		const sections = Array.from({ length: 10 }, (_, i) => `{"offset":{"line":${i},"column":0},"url":"s${i}.map"}`).join(
			",",
		);
		const text = await report(dir, "ten-sections.map", `{"version":3,"sections":[${sections}]}`);

		expect(text).toContain("sections: 10");
		expect(text).toContain('  section 8: generated line 7, column 0 — url "s7.map" (not followed)');
		expect(text).not.toContain("  section 9:");
		expect(text).toContain("  ... and 2 more");
	});

	test("a map with neither mappings nor sections says so", async () => {
		const dir = tempDir();
		const text = await report(dir, "hollow.map", `{"version":3,"sources":[]}`);

		expect(text).toContain("mappings: (absent, and there are no sections — the map has nothing to decode)");
	});
});

// ---------------------------------------------------------------------------
// Inline maps
// ---------------------------------------------------------------------------

const INLINE = `{"version":3,"file":"inline.js","sources":["x.ts"],"names":[],"mappings":"AAAA"}`;

describe("inline maps", () => {
	test("a base64 data URI in a JS file is decoded and read", async () => {
		const dir = tempDir();
		const base64 = Buffer.from(INLINE, "utf8").toString("base64");
		const text = await report(
			dir,
			"bundle.js",
			`console.log(1);\n//# sourceMappingURL=data:application/json;base64,${base64}\n`,
		);

		expect(text).toContain(
			`map source: inline data URI (base64, ${base64.length} characters, ${INLINE.length} bytes decoded)`,
		);
		expect(text).toContain(`json: well-formed (${INLINE.length} bytes)`);
		expect(text).toContain("file: inline.js");
		expect(text).toContain("sources: 1");
		expect(text).toContain("  x.ts");
		expect(text).toContain("mappings: 1 line, 1 segment");
	});

	test("a percent-encoded data URI is decoded too, through the legacy marker", async () => {
		const dir = tempDir();
		const text = await report(
			dir,
			"bundle.ts",
			`console.log(1);\n//@ sourceMappingURL=data:application/json;charset=utf-8,${encodeURIComponent(INLINE)}\n`,
		);

		expect(text).toContain(`map source: inline data URI (percent-encoded, ${INLINE.length} bytes)`);
		expect(text).toContain("file: inline.js");
	});

	test("the last sourceMappingURL comment is the one that is read", async () => {
		const dir = tempDir();
		const first = Buffer.from(`{"version":3,"file":"first.js","mappings":"AAAA"}`, "utf8").toString("base64");
		const second = Buffer.from(`{"version":3,"file":"second.js","mappings":"AAAA"}`, "utf8").toString("base64");
		const text = await report(
			dir,
			"twice.js",
			`//# sourceMappingURL=data:application/json;base64,${first}\n` +
				`//# sourceMappingURL=data:application/json;base64,${second}\n`,
		);

		expect(text).toContain("file: second.js");
		expect(text).not.toContain("first.js");
	});

	test("a comment naming an external file is reported and not followed", async () => {
		const dir = tempDir();
		const text = await report(dir, "external.js", "console.log(1);\n//# sourceMappingURL=out.js.map\n");

		expect(text).toContain('the file\'s //# sourceMappingURL points at an external map ("out.js.map")');
		expect(text).toContain("pass that file instead");
		expect(text).not.toContain("version: 3");
	});
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

describe("malformed input", () => {
	test("bad JSON is named as bad JSON", async () => {
		const dir = tempDir();
		const text = await report(dir, "broken.map", `{"version":3,"sources":[`);

		expect(text).toContain("InspectSourceMap report for broken.map");
		expect(text).toContain("the file's JSON is not well-formed (");
		expect(text).not.toContain("version: 3");
	});

	test("an absent version, a version that is not 3, and a version that is not a number", async () => {
		const dir = tempDir();

		expect(await report(dir, "no-version.map", `{"sources":[],"mappings":"AAAA"}`)).toContain(
			"version: (absent; the format defines version 3)",
		);
		expect(await report(dir, "v2.map", `{"version":2,"sources":[],"mappings":"AAAA"}`)).toContain(
			"version: 2 (the format defines version 3)",
		);
		expect(await report(dir, "v3-string.map", `{"version":"3","sources":[],"mappings":"AAAA"}`)).toContain(
			'version: "3" (the format defines version 3)',
		);
	});

	test("the JSON top level must be an object", async () => {
		const dir = tempDir();
		const text = await report(dir, "list.map", "[1,2,3]");

		expect(text).toContain("the JSON top level is a list, not a source map object");
	});

	test("a file that is neither JSON nor a mapped file says so", async () => {
		const dir = tempDir();
		const text = await report(dir, "notes.txt", "just some text\n");

		expect(text).toContain(
			"the file is neither a JSON source map object nor a file carrying a //# sourceMappingURL comment",
		);
	});

	test("bad base64 in an inline map is named before anything is parsed", async () => {
		const dir = tempDir();
		const text = await report(dir, "bad64.js", "//# sourceMappingURL=data:application/json;base64,!!!!\n");

		expect(text).toContain("the inline map's base64 payload is not valid base64 (4 characters)");
	});

	test("base64 that decodes but is not canonical is refused too", async () => {
		const dir = tempDir();
		const text = await report(dir, "non-canonical.js", "//# sourceMappingURL=data:application/json;base64,AAB\n");

		expect(text).toContain("the inline map's base64 payload is not valid base64");
	});

	test("malformed percent-encoding is named", async () => {
		const dir = tempDir();
		const text = await report(dir, "bad-percent.js", "//# sourceMappingURL=data:application/json,%zz\n");

		expect(text).toContain("the inline map's percent-encoding is malformed (");
	});

	test("an inline map that is not JSON is named after its encoding is accepted", async () => {
		const dir = tempDir();
		const base64 = Buffer.from("{oops", "utf8").toString("base64");
		const text = await report(dir, "bad-inline.js", `//# sourceMappingURL=data:application/json;base64,${base64}\n`);

		expect(text).toContain("map source: inline data URI (base64,");
		expect(text).toContain("the inline map is not well-formed JSON (");
	});

	test("mappings that stop mid-number are located", async () => {
		const dir = tempDir();
		const text = await report(dir, "cut.map", `{"version":3,"sources":[],"mappings":"gg"}`);

		expect(text).toContain("mappings line 1, position 1: a VLQ number is cut off");
	});

	test("an illegal mappings character is quoted with its position", async () => {
		const dir = tempDir();
		const text = await report(dir, "illegal.map", `{"version":3,"sources":[],"mappings":"AAAA;A!A"}`);

		expect(text).toContain('mappings line 2, position 2: "!" is not a base64 VLQ digit');
	});

	test("a segment with a field count the format does not define is refused", async () => {
		const dir = tempDir();
		const text = await report(dir, "fields.map", `{"version":3,"sources":[],"mappings":"AA"}`);

		expect(text).toContain(
			"mappings line 1, position 1: a segment carries 2 field(s); the format defines segments of 1, 4 and 5",
		);
	});

	test("an empty segment is refused, and the facts before it survive", async () => {
		const dir = tempDir();
		const text = await report(dir, "empty.map", `{"version":3,"sources":["a.ts"],"mappings":"AAAA,,CAAC"}`);

		expect(text).toContain("  a.ts");
		expect(text).toContain(
			"mappings line 1, position 6: a segment is empty (two commas in a row, or a trailing comma)",
		);
	});

	test("a mappings field that is not a string, and a sections field that is not a list", async () => {
		const dir = tempDir();

		expect(await report(dir, "mappings-number.map", `{"version":3,"sources":[],"mappings":5}`)).toContain(
			"mappings: (a number, not a string)",
		);
		const text = await report(dir, "sections-string.map", `{"version":3,"sources":[],"sections":"x"}`);
		expect(text).toContain("sections: (a string, not a list)");
		expect(text).toContain("mappings: (absent, and there are no sections — the map has nothing to decode)");
	});

	test("sources, names and file of the wrong type are each described", async () => {
		const dir = tempDir();
		const text = await report(
			dir,
			"odd-types.map",
			`{"version":3,"file":7,"sources":{"a":1},"names":[3],"mappings":"AAAA"}`,
		);

		expect(text).toContain("file: (a number, not a string)");
		expect(text).toContain("sources: (an object, not a list)");
		expect(text).toContain("names: 1");
		expect(text).toContain("  (a number, not a string)");
	});
});

// ---------------------------------------------------------------------------
// The tool's edges
// ---------------------------------------------------------------------------

describe("the tool's edges", () => {
	test("a missing path, a directory, and a path outside the workspace are each refused", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "a-dir"));
		const tool = createInspectSourceMapTool(dir);

		const missing = await tool.call({ path: "gone.map" }, ctx(dir));
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("Path not found: gone.map");

		const asDir = await tool.call({ path: "a-dir" }, ctx(dir));
		expect(asDir.isError).toBe(true);
		expect(textOf(asDir)).toContain("is a directory, not a source map file");

		const outside = await tool.call({ path: "../outside.map" }, ctx(dir));
		expect(outside.isError).toBe(true);
		expect(textOf(outside)).toContain("resolves outside workspace");
	});

	test("a file past the size guard is refused before it is read", async () => {
		const dir = tempDir();
		const path = join(dir, "huge.map");
		// Sparse: 70 MiB of logical size for a file that occupies almost nothing.
		const fd = openSync(path, "w");
		ftruncateSync(fd, 70 * 1024 * 1024);
		closeSync(fd);

		const result = await run(dir, "huge.map");

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("past the 67108864 this inspection reads into memory");
	});

	test("the tool declares itself read-only, concurrency-safe, and honest about scope", () => {
		const tool = createInspectSourceMapTool(tempDir());

		expect(tool.name).toBe("InspectSourceMap");
		expect(tool.isReadOnly?.({ path: "x" })).toBe(true);
		expect(tool.isConcurrencySafe?.({ path: "x" })).toBe(true);
		expect(tool.description).toContain("does not resolve the source names");
	});
});
