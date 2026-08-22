/**
 * The parser is tested without a renderer, which is the reason parsing was split
 * out of MessageList in the first place: inline marks nest, and a streamed
 * response can cut off mid-mark, and neither is pleasant to assert against a
 * frame of terminal output.
 */

import { describe, expect, test } from "bun:test";
import {
	type Block,
	type InlineSpan,
	parseBlocks,
	parseInline,
	parseTableDelimiter,
	splitTableRow,
} from "../src/markdown.ts";

/** Collapse spans to `text` only, for cases where the marks are not the point. */
function plain(spans: InlineSpan[]): string {
	return spans.map((s) => s.text).join("");
}

function spansOf(block: Block): InlineSpan[] {
	if (block.kind === "code" || block.kind === "rule" || block.kind === "blank" || block.kind === "table") {
		throw new Error(`block kind ${block.kind} carries no spans`);
	}
	return block.spans;
}

describe("parseInline marks", () => {
	test("bold with ** and __", () => {
		expect(parseInline("a **b** c")).toEqual([{ text: "a " }, { text: "b", bold: true }, { text: " c" }]);
		expect(parseInline("__b__")).toEqual([{ text: "b", bold: true }]);
	});

	test("italic with * and _", () => {
		expect(parseInline("*i*")).toEqual([{ text: "i", italic: true }]);
		expect(parseInline("_i_")).toEqual([{ text: "i", italic: true }]);
	});

	test("strikethrough", () => {
		expect(parseInline("~~gone~~")).toEqual([{ text: "gone", strike: true }]);
	});

	test("inline code", () => {
		expect(parseInline("run `ls -la`")).toEqual([{ text: "run " }, { text: "ls -la", code: true }]);
	});

	// The reported bug: the model answers with `**LaBunbun Code**` and the user
	// sees the asterisks. Bold must reach the renderer as a mark, not as text.
	test("bold text no longer carries its asterisks", () => {
		const spans = parseInline("**LaBunbun Code**");
		expect(spans).toEqual([{ text: "LaBunbun Code", bold: true }]);
		expect(plain(spans)).not.toContain("*");
	});

	test("marks nest, keeping both", () => {
		expect(parseInline("**a _b_**")).toEqual([
			{ text: "a ", bold: true },
			{ text: "b", bold: true, italic: true },
		]);
	});

	test("code contents stay literal", () => {
		// `**not bold**` inside backticks is a thing users write when they mean to
		// show the syntax. Parsing it as bold would destroy the example.
		expect(parseInline("`**not bold**`")).toEqual([{ text: "**not bold**", code: true }]);
	});

	test("a backtick run only closes on a run of equal length", () => {
		expect(parseInline("``a ` b``")).toEqual([{ text: "a ` b", code: true }]);
	});

	test("one leading and trailing space inside code is padding", () => {
		// Per CommonMark, so a literal backtick can be written as `` ` ``.
		expect(parseInline("`` ` ``")).toEqual([{ text: "`", code: true }]);
		// Only one space each side is stripped.
		expect(parseInline("``  x  ``")).toEqual([{ text: " x ", code: true }]);
	});

	test("backslash escapes the next character", () => {
		expect(parseInline("\\*not italic\\*")).toEqual([{ text: "*not italic*" }]);
		expect(parseInline("\\`literal\\`")).toEqual([{ text: "`literal`" }]);
	});

	test("snake_case identifiers are not italic", () => {
		// The single most common false positive in code-heavy transcripts.
		expect(parseInline("some_var_name")).toEqual([{ text: "some_var_name" }]);
		expect(parseInline("MAX_RETRY_COUNT here")).toEqual([{ text: "MAX_RETRY_COUNT here" }]);
	});

	test("a lone asterisk surrounded by spaces is not a mark", () => {
		expect(plain(parseInline("2 * 3 * 4"))).toBe("2 * 3 * 4");
	});

	test("links carry an href and fall back to the url as the label", () => {
		expect(parseInline("[docs](https://example.com)")).toEqual([{ text: "docs", href: "https://example.com" }]);
		expect(parseInline("[](https://example.com)")).toEqual([
			{ text: "https://example.com", href: "https://example.com" },
		]);
	});

	test("a link label keeps its own marks", () => {
		expect(parseInline("[**bold link**](u)")).toEqual([{ text: "bold link", bold: true, href: "u" }]);
	});

	test("unterminated marks survive as literal text", () => {
		// The streaming case: half a mark has arrived. Eating the characters would
		// make the transcript flicker between wrong renderings.
		expect(plain(parseInline("**half"))).toBe("**half");
		expect(plain(parseInline("`open"))).toBe("`open");
		expect(plain(parseInline("~~half"))).toBe("~~half");
	});

	test("empty input yields no spans", () => {
		expect(parseInline("")).toEqual([]);
	});

	test("text is preserved byte for byte across a mixed line", () => {
		const line = "call `fn(a_b)` then **do** [it](x) ~~or not~~";
		expect(plain(parseInline(line))).toBe("call fn(a_b) then do it or not");
	});
});

describe("parseBlocks structure", () => {
	test("headings carry their level", () => {
		const blocks = parseBlocks("# One\n### Three");
		expect(blocks.map((b) => b.kind)).toEqual(["heading", "heading"]);
		expect(blocks[0]).toMatchObject({ level: 1 });
		expect(blocks[1]).toMatchObject({ level: 3 });
		expect(plain(spansOf(blocks[0]))).toBe("One");
	});

	test("more than six hashes is a paragraph, not a heading", () => {
		expect(parseBlocks("####### seven")[0].kind).toBe("paragraph");
	});

	test("bullet lists normalize the marker and halve the indent", () => {
		const blocks = parseBlocks("- top\n  - nested\n    - deeper");
		expect(blocks.every((b) => b.kind === "listItem")).toBe(true);
		expect(blocks.map((b) => (b.kind === "listItem" ? b.indent : -1))).toEqual([0, 1, 2]);
		expect(blocks.map((b) => (b.kind === "listItem" ? b.marker : ""))).toEqual(["•", "•", "•"]);
	});

	test("all three bullet characters are lists", () => {
		for (const marker of ["-", "*", "+"]) {
			expect(parseBlocks(`${marker} item`)[0].kind).toBe("listItem");
		}
	});

	test("ordered lists keep their number as the marker", () => {
		const blocks = parseBlocks("1. first\n2) second");
		expect(blocks.map((b) => (b.kind === "listItem" ? b.marker : ""))).toEqual(["1.", "2."]);
	});

	test("quotes strip the marker", () => {
		const blocks = parseBlocks("> quoted");
		expect(blocks[0].kind).toBe("quote");
		expect(plain(spansOf(blocks[0]))).toBe("quoted");
	});

	test("horizontal rules need three or more markers", () => {
		expect(parseBlocks("---")[0].kind).toBe("rule");
		expect(parseBlocks("***")[0].kind).toBe("rule");
		expect(parseBlocks("- - -")[0].kind).toBe("rule");
		// Two dashes is not a rule; it stays text.
		expect(parseBlocks("--")[0].kind).toBe("paragraph");
	});

	test("blank lines are their own block, so spacing survives", () => {
		expect(parseBlocks("a\n\nb").map((b) => b.kind)).toEqual(["paragraph", "blank", "paragraph"]);
	});

	test("fenced code keeps its language and lines verbatim", () => {
		const blocks = parseBlocks("```ts\nconst a = 1;\n// **not bold**\n```");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toEqual({ kind: "code", language: "ts", lines: ["const a = 1;", "// **not bold**"] });
	});

	test("markdown inside a fence is not parsed", () => {
		const blocks = parseBlocks("```\n# not a heading\n- not a list\n```");
		expect(blocks[0]).toMatchObject({ kind: "code", lines: ["# not a heading", "- not a list"] });
	});

	test("an unterminated fence still renders what arrived", () => {
		// This is every streamed code block, for as long as it is streaming.
		const blocks = parseBlocks("```py\nprint(1)");
		expect(blocks).toEqual([{ kind: "code", language: "py", lines: ["print(1)"] }]);
	});

	test("only a fence of the same character closes the block", () => {
		const blocks = parseBlocks("```\n~~~\nstill code\n```");
		expect(blocks).toEqual([{ kind: "code", language: "", lines: ["~~~", "still code"] }]);
	});

	test("tilde fences work and can contain backticks", () => {
		const blocks = parseBlocks("~~~\n```\n~~~");
		expect(blocks).toEqual([{ kind: "code", language: "", lines: ["```"] }]);
	});

	test("a longer closing fence closes a shorter one", () => {
		expect(parseBlocks("```\nx\n````")).toEqual([{ kind: "code", language: "", lines: ["x"] }]);
	});

	test("empty input yields no blocks", () => {
		expect(parseBlocks("")).toEqual([{ kind: "blank" }]);
	});

	test("a realistic answer parses into the expected block sequence", () => {
		const text = [
			"# Result",
			"",
			"Two things:",
			"",
			"- ran `bun test`",
			"- all **533** passed",
			"",
			"> note this",
		].join("\n");
		expect(parseBlocks(text).map((b) => b.kind)).toEqual([
			"heading",
			"blank",
			"paragraph",
			"blank",
			"listItem",
			"listItem",
			"blank",
			"quote",
		]);
	});
});

describe("splitTableRow", () => {
	test("leading and trailing pipes are optional", () => {
		expect(splitTableRow("| a | b |")).toEqual(["a", "b"]);
		expect(splitTableRow("a | b")).toEqual(["a", "b"]);
	});

	test("an escaped pipe stays inside its cell", () => {
		// The backslash survives the split: unescaping is parseInline's job, and
		// doing it here too would turn `\\|` into a separator again.
		expect(splitTableRow("| a \\| b | c |")).toEqual(["a \\| b", "c"]);
		expect(plain(parseInline("a \\| b"))).toBe("a | b");
	});

	test("a pipe inside inline code is not a separator", () => {
		// Two cells, not three: the table would otherwise split every shell
		// pipeline a model puts in a cell.
		expect(splitTableRow("| a | `b|c` |")).toEqual(["a", "`b|c`"]);
	});

	test("an empty interior cell is kept", () => {
		expect(splitTableRow("| a |  | c |")).toEqual(["a", "", "c"]);
	});
});

describe("parseTableDelimiter", () => {
	test("reads alignment off each cell", () => {
		expect(parseTableDelimiter("|---|:---|:---:|---:|")).toEqual(["left", "left", "center", "right"]);
	});

	test("a paragraph containing pipes is not a delimiter row", () => {
		// This null is the whole reason prose with pipes stays prose.
		expect(parseTableDelimiter("| not a delimiter |")).toBeNull();
		expect(parseTableDelimiter("a | b")).toBeNull();
		expect(parseTableDelimiter("")).toBeNull();
		expect(parseTableDelimiter("-----")).toBeNull();
	});
});

describe("parseBlocks tables", () => {
	function tableOf(text: string): Extract<Block, { kind: "table" }> {
		const block = parseBlocks(text)[0];
		if (block.kind !== "table") throw new Error(`expected a table, got ${block.kind}`);
		return block;
	}

	test("headers, alignment, and rows all land", () => {
		const table = tableOf("| Name | Size |\n|:-----|-----:|\n| a | 1 |\n| b | 2 |");
		expect(table.headers.map(plain)).toEqual(["Name", "Size"]);
		expect(table.align).toEqual(["left", "right"]);
		expect(table.rows.map((row) => row.map(plain))).toEqual([
			["a", "1"],
			["b", "2"],
		]);
	});

	test("cells keep their inline marks", () => {
		const table = tableOf("| a | b |\n|---|---|\n| **bold** | `code` |");
		expect(table.rows[0][0]).toEqual([{ text: "bold", bold: true }]);
		expect(table.rows[0][1]).toEqual([{ text: "code", code: true }]);
	});

	test("a ragged row is kept rather than dropped", () => {
		// Models emit these routinely; dropping the row would lose real content.
		const table = tableOf("| a | b | c |\n|---|---|---|\n| 1 | 2 |");
		expect(table.rows).toHaveLength(1);
		expect(table.rows[0].map(plain)).toEqual(["1", "2"]);
	});

	test("the table ends at the first blank line", () => {
		const blocks = parseBlocks("| a |\n|---|\n| 1 |\n\nafter");
		expect(blocks.map((b) => b.kind)).toEqual(["table", "blank", "paragraph"]);
	});

	test("a header with no rows is still a table", () => {
		expect(tableOf("| a | b |\n|---|---|").rows).toEqual([]);
	});

	test("pipes without a delimiter row stay a paragraph", () => {
		expect(parseBlocks("| a | b |\njust text")[0].kind).toBe("paragraph");
		expect(parseBlocks("run a | b to pipe")[0].kind).toBe("paragraph");
	});

	test("a table inside a fence is code, not a table", () => {
		expect(parseBlocks("```\n| a |\n|---|\n```")[0].kind).toBe("code");
	});
});
