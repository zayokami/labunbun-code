/**
 * The tokenizer is tested as data rather than through a rendered frame, for the
 * same reason the markdown parser is: a frame carries no color when stdout is
 * not a TTY, which is every test run.
 *
 * The property that matters most is the round trip — concatenating every token's
 * text must reproduce the input exactly. A highlighter that drops or duplicates
 * a character silently corrupts the code the user is reading, which is worse
 * than no highlighting at all.
 */

import { describe, expect, test } from "bun:test";
import { type CodeToken, highlightCode, isSupportedLanguage } from "../src/highlight.ts";

/** Flatten one line's tokens back to text. */
function textOf(tokens: CodeToken[]): string {
	return tokens.map((t) => t.text).join("");
}

/** All tokens of one kind, in order, for asserting what got classified. */
function ofKind(tokens: CodeToken[], kind: CodeToken["kind"]): string[] {
	return tokens.filter((t) => t.kind === kind).map((t) => t.text);
}

const SAMPLES: Array<[string, string[]]> = [
	["ts", ["const a = 1; // trailing", 'let s = "x";', "/* block */", "function f(y) { return y }"]],
	["python", ["def f(x): # comment", '  return "s"', "  # done"]],
	["rust", ["fn main() {", "    let x: u32 = 0; // note", '    println!("hi");', "}"]],
	["go", ["func main() {", '\ts := "x" // note', "}"]],
	["bash", ["# comment", 'if [ -f "$f" ]; then', "  echo 1", "fi"]],
	["sql", ["SELECT a FROM t -- note", "WHERE b = 'x'"]],
	["", ["plain text with ** and `stuff`"]],
	["nope", ["unknown fence tag"]],
];

describe("round trip", () => {
	test("concatenated tokens reproduce every input line exactly", () => {
		for (const [language, lines] of SAMPLES) {
			const out = highlightCode(lines, language);
			expect(out, `${language}: line count`).toHaveLength(lines.length);
			for (const [i, line] of lines.entries()) {
				expect(textOf(out[i]), `${language} line ${i}`).toBe(line);
			}
		}
	});

	test("no token is empty", () => {
		// An empty token renders nothing but still costs an Ink <Text> node.
		for (const [language, lines] of SAMPLES) {
			for (const tokens of highlightCode(lines, language)) {
				for (const token of tokens) expect(token.text, language).not.toBe("");
			}
		}
	});

	test("an empty line yields no tokens, and a blank line survives", () => {
		expect(highlightCode([""], "ts")).toEqual([[]]);
		expect(textOf(highlightCode(["   "], "ts")[0])).toBe("   ");
	});

	test("no lines yields no lines", () => {
		expect(highlightCode([], "ts")).toEqual([]);
	});
});

describe("language support", () => {
	test("known fence tags are recognized", () => {
		for (const tag of ["ts", "tsx", "js", "python", "py", "rust", "rs", "go", "bash", "sh", "sql"]) {
			expect(isSupportedLanguage(tag), tag).toBe(true);
		}
	});

	test("an unknown or absent tag is not claimed", () => {
		expect(isSupportedLanguage("nope")).toBe(false);
		expect(isSupportedLanguage("")).toBe(false);
	});

	test("an unknown language is returned as one plain token", () => {
		// Guessing wrong is worse than not highlighting: keywords from the wrong
		// language would color arbitrary words in prose-like content.
		const [tokens] = highlightCode(["const if while return"], "nope");
		expect(tokens).toEqual([{ text: "const if while return", kind: "plain" }]);
	});
});

describe("classification", () => {
	test("keywords, numbers, strings, and comments each get their kind", () => {
		const [tokens] = highlightCode(['const a = 1; // note "quoted"'], "ts");
		expect(ofKind(tokens, "keyword")).toEqual(["const"]);
		expect(ofKind(tokens, "number")).toEqual(["1"]);
		// The quote inside the comment does not open a string.
		expect(ofKind(tokens, "comment")).toEqual(['// note "quoted"']);
		expect(ofKind(tokens, "string")).toEqual([]);
	});

	test("a keyword inside a string is not a keyword", () => {
		const [tokens] = highlightCode(['s = "const if while"'], "ts");
		expect(ofKind(tokens, "string")).toEqual(['"const if while"']);
		expect(ofKind(tokens, "keyword")).toEqual([]);
	});

	test("a name followed by a paren is a call", () => {
		const [tokens] = highlightCode(["doThing(x)"], "ts");
		expect(ofKind(tokens, "function")).toEqual(["doThing"]);
	});

	test("an identifier containing a keyword is not a keyword", () => {
		// `constant` starts with `const`; matching on a prefix would color it.
		const [tokens] = highlightCode(["constant = iffy"], "ts");
		expect(ofKind(tokens, "keyword")).toEqual([]);
	});

	test("each language uses its own comment syntax", () => {
		expect(ofKind(highlightCode(["# c"], "python")[0], "comment")).toEqual(["# c"]);
		expect(ofKind(highlightCode(["-- c"], "sql")[0], "comment")).toEqual(["-- c"]);
		expect(ofKind(highlightCode(["// c"], "ts")[0], "comment")).toEqual(["// c"]);
		// `#` is not a comment in a C-like language, and `//` is not one in shell.
		expect(ofKind(highlightCode(["# not"], "ts")[0], "comment")).toEqual([]);
		expect(ofKind(highlightCode(["// not"], "bash")[0], "comment")).toEqual([]);
	});
});

describe("state across lines", () => {
	test("a block comment keeps coloring the lines it spans", () => {
		// A per-line tokenizer would show line two as live code, which is the
		// most visible way a highlighter can be wrong.
		const out = highlightCode(["/* one", "two", "three */ live"], "ts");
		expect(ofKind(out[0], "comment")).toEqual(["/* one"]);
		expect(ofKind(out[1], "comment")).toEqual(["two"]);
		expect(ofKind(out[2], "comment")).toEqual(["three */"]);
		expect(ofKind(out[2], "plain")).toContain("live");
	});

	test("a closed block comment does not leak into the next line", () => {
		const out = highlightCode(["/* c */", "const a = 1;"], "ts");
		expect(ofKind(out[1], "keyword")).toEqual(["const"]);
	});

	test("an unterminated string does not bleed into the next line", () => {
		// Deliberate: a lone quote is far more often a typo than a multiline
		// string, and letting it continue would tint the whole rest of the block.
		const out = highlightCode(['s = "oops', "const a = 1;"], "ts");
		expect(ofKind(out[0], "string")).toEqual(['"oops']);
		expect(ofKind(out[1], "keyword")).toEqual(["const"]);
		expect(ofKind(out[1], "string")).toEqual([]);
	});

	test("each call starts clean, so one block cannot affect the next", () => {
		highlightCode(["/* left open"], "ts");
		expect(ofKind(highlightCode(["const a = 1;"], "ts")[0], "comment")).toEqual([]);
	});
});
