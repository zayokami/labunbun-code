/**
 * @-mention completion, asserted as data: word extraction, ranking, and the
 * buffer rewrite are pure functions — a frame could only show their end state.
 */

import { describe, expect, test } from "bun:test";
import { applyFileCompletion, currentAtWord, filterFiles } from "../src/prompt-files.ts";

const FILES = [
	"src/components/PromptInput.tsx",
	"src/components/MessageList.tsx",
	"src/hooks/useTextInput.ts",
	"src/markdown.ts",
	"test/markdown.test.ts",
	"README.md",
];

describe("currentAtWord", () => {
	test("extracts the query after @", () => {
		expect(currentAtWord("look at @src/ma", 15)).toBe("src/ma");
	});

	test("a bare @ is an empty query", () => {
		expect(currentAtWord("look at @", 9)).toBe("");
	});

	test("no active word without an @", () => {
		expect(currentAtWord("plain words here", 16)).toBeNull();
		expect(currentAtWord("email user@example.com", 22)).toBeNull();
	});

	test("an @ earlier in the sentence is not active", () => {
		// The word under the cursor is "done" — the mention was completed long ago.
		expect(currentAtWord("see @README.md and be done", 26)).toBeNull();
	});

	test("the caret must be inside the word", () => {
		expect(currentAtWord("@read", 0)).toBeNull();
		expect(currentAtWord("@read", 5)).toBe("read");
	});

	test("multiline: the word boundary is the line break too", () => {
		expect(currentAtWord("first\n@src/m", 12)).toBe("src/m");
	});
});

describe("filterFiles", () => {
	test("segment prefix beats plain substring beats subsequence", () => {
		const ranked = filterFiles(["a/xxread.md", "readme/x.md", "xx/reaxd.md"], "read", 10);
		// "readme/x.md" has a segment starting with "read"; "a/xxread.md" contains
		// it mid-segment; "xx/reaxd.md" is only a subsequence.
		expect(ranked[0]).toBe("readme/x.md");
		expect(ranked).toContain("a/xxread.md");
		expect(ranked).toContain("xx/reaxd.md");
	});

	test("empty query keeps input order and caps", () => {
		expect(filterFiles(["b", "a", "c"], "", 2)).toEqual(["b", "a"]);
	});

	test("no match yields nothing", () => {
		expect(filterFiles(FILES, "zzz-nothing", 8)).toEqual([]);
	});

	test("matching is case-insensitive", () => {
		expect(filterFiles(FILES, "readme", 8)).toContain("README.md");
	});
});

describe("applyFileCompletion", () => {
	test("replaces the partial mention with the path plus a trailing space", () => {
		expect(applyFileCompletion("check @src/m now", 12, "src/markdown.ts")).toEqual({
			text: "check src/markdown.ts  now",
			cursor: 22,
		});
	});

	test("paths with spaces are double-quoted and get no extra space", () => {
		// Quoting matters because the space would otherwise end the word on the
		// next edit; a real partial type can only ever reach "@my".
		const out = applyFileCompletion("see @my", 7, "my file.txt");
		expect(out.text).toBe('see "my file.txt"');
		expect(out.cursor).toBe(17);
	});

	test("a mention at buffer start works", () => {
		expect(applyFileCompletion("@rea", 4, "README.md").text).toBe("README.md ");
	});

	test("text after the caret is preserved", () => {
		const out = applyFileCompletion("@rea -> go", 4, "README.md");
		expect(out.text).toBe("README.md  -> go");
	});
});
