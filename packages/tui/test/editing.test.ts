/**
 * Pure editor and paste primitives. These live outside the components so they
 * can be asserted as data — a rendered frame cannot show a kill ring or an
 * expansion map, only their final text.
 */

import { describe, expect, test } from "bun:test";
import { killWordBack, killWordForward } from "../src/hooks/useTextInput.ts";
import {
	expandPasteTokens,
	makePasteToken,
	normalizePaste,
	PASTE_PLACEHOLDER_THRESHOLD,
	PASTE_TOKEN_RE,
	shouldPlaceholderize,
} from "../src/paste.ts";

describe("killWordBack", () => {
	test("removes one word under the cursor", () => {
		expect(killWordBack("hello world", 11)).toEqual({ text: "hello ", cursor: 6, killed: "world" });
	});

	test("kills one word; earlier whitespace waits for the next kill", () => {
		// Matches moveWordLeft: from inside a word the boundary is the word's
		// own start — bash's backward-kill-word behaves the same way.
		expect(killWordBack("a   b", 5)).toEqual({ text: "a   ", cursor: 4, killed: "b" });
	});

	test("a kill that starts on whitespace takes the spaces with it", () => {
		expect(killWordBack("a   ", 4)).toEqual({ text: "", cursor: 0, killed: "a   " });
	});

	test("at the line start it kills nothing", () => {
		expect(killWordBack("abc", 0)).toEqual({ text: "abc", cursor: 0, killed: "" });
	});

	test("respects the cursor position, not the line end", () => {
		expect(killWordBack("one two three", 7)).toEqual({ text: "one  three", cursor: 4, killed: "two" });
	});
});

describe("killWordForward", () => {
	test("removes one word ahead of the cursor", () => {
		expect(killWordForward("one two three", 0)).toEqual({ text: "two three", cursor: 0, killed: "one " });
	});

	test("at the end it kills nothing", () => {
		expect(killWordForward("abc", 3)).toEqual({ text: "abc", cursor: 3, killed: "" });
	});

	test("mid-word starts at the cursor", () => {
		expect(killWordForward("abcdef", 3)).toEqual({ text: "abc", cursor: 3, killed: "def" });
	});
});

describe("paste placeholders", () => {
	test("threshold is length-based; newlines qualify on their own", () => {
		expect(shouldPlaceholderize("x".repeat(PASTE_PLACEHOLDER_THRESHOLD))).toBe(false);
		expect(shouldPlaceholderize("x".repeat(PASTE_PLACEHOLDER_THRESHOLD + 1))).toBe(true);
		expect(shouldPlaceholderize("two\nlines")).toBe(true);
		expect(shouldPlaceholderize("single line")).toBe(false);
	});

	test("tokens are distinct per sequence number and carry the size", () => {
		expect(makePasteToken(1, 800)).toBe("[Pasted 800 chars #1]");
		expect(makePasteToken(2, 12)).not.toBe(makePasteToken(1, 12));
	});

	test("expansion round-trips through the map", () => {
		const payload = "line one\nline two";
		const token = makePasteToken(3, payload.length);
		const map = new Map([[token, payload]]);
		const text = `run this: ${token} thanks`;
		expect(expandPasteTokens(text, map)).toBe(`run this: ${payload} thanks`);
	});

	test("unknown tokens stay literal instead of corrupting text", () => {
		// A half-deleted token must not eat its surroundings.
		const orphan = "[Pasted 999 chars #99]";
		expect(expandPasteTokens(`keep ${orphan} intact`, new Map())).toBe(`keep ${orphan} intact`);
	});

	test("every generated token matches the expander's pattern", () => {
		for (const seq of [1, 2, 10_000]) {
			expect(PASTE_TOKEN_RE.test(makePasteToken(seq, 1))).toBe(true);
			PASTE_TOKEN_RE.lastIndex = 0;
		}
	});

	test("normalizePaste folds CRLF and lone CR into LF", () => {
		expect(normalizePaste("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
		expect(normalizePaste("plain")).toBe("plain");
	});
});
