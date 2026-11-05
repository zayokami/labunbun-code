import { describe, expect, test } from "bun:test";
import { permissionDiff } from "../src/permission-diff.ts";

describe("permissionDiff", () => {
	test("Edit aligns the change and keeps the unchanged lines as context", () => {
		const diff = permissionDiff("Edit", {
			file_path: "src/a.ts",
			old_string: "one\ntwo\nthree",
			new_string: "one\nTWO\nthree",
		});
		expect(diff).toEqual({
			lines: [
				{ kind: "header", text: "--- src/a.ts" },
				{ kind: "header", text: "+++ src/a.ts" },
				{ kind: "context", text: "one" },
				{ kind: "removed", text: "two" },
				{ kind: "added", text: "TWO" },
				{ kind: "context", text: "three" },
			],
		});
	});

	test("an empty old_string is an insertion, not an empty context line", () => {
		const diff = permissionDiff("Edit", { file_path: "a.ts", old_string: "", new_string: "hello" });
		expect(diff?.lines).toEqual([
			{ kind: "header", text: "--- a.ts" },
			{ kind: "header", text: "+++ a.ts" },
			{ kind: "added", text: "hello" },
		]);
	});

	test("Write is all addition, and a trailing newline is not an empty line", () => {
		const diff = permissionDiff("Write", { file_path: "a.ts", content: "first\nsecond\n" });
		expect(diff?.lines).toEqual([
			{ kind: "header", text: "--- a.ts" },
			{ kind: "header", text: "+++ a.ts" },
			{ kind: "added", text: "first" },
			{ kind: "added", text: "second" },
		]);
		expect(diff?.notice).toBeUndefined();
	});

	test("replace_all is said out loud, because the lines alone do not say it", () => {
		const diff = permissionDiff("Edit", {
			file_path: "a.ts",
			old_string: "x",
			new_string: "y",
			replace_all: true,
		});
		expect(diff?.notice).toContain("Every occurrence will be replaced.");
	});

	test("inputs the diff does not understand fall back to the preview", () => {
		expect(permissionDiff("Bash", { command: "ls" })).toBeUndefined();
		expect(permissionDiff("Edit", null)).toBeUndefined();
		expect(permissionDiff("Edit", [])).toBeUndefined();
		expect(permissionDiff("Edit", { old_string: "a", new_string: "b" })).toBeUndefined();
		expect(permissionDiff("Edit", { file_path: "a", old_string: 1, new_string: "b" })).toBeUndefined();
		expect(permissionDiff("Edit", { file_path: "a", old_string: "a", new_string: 2 })).toBeUndefined();
		expect(permissionDiff("Write", { file_path: "a" })).toBeUndefined();
		expect(permissionDiff("Write", { file_path: "a", content: "" })).toBeUndefined();
	});

	test("a paired edit marks only the words that differ", () => {
		const diff = permissionDiff("Edit", {
			file_path: "a.ts",
			old_string: "const answer = 1;",
			new_string: "const answer = 42;",
		});
		const removed = diff?.lines.find((line) => line.kind === "removed");
		const added = diff?.lines.find((line) => line.kind === "added");
		expect(removed?.segments).toEqual([
			{ text: "const answer = ", changed: false },
			{ text: "1", changed: true },
			{ text: ";", changed: false },
		]);
		expect(added?.segments).toEqual([
			{ text: "const answer = ", changed: false },
			{ text: "42", changed: true },
			{ text: ";", changed: false },
		]);
	});

	test("an insertion inside a line marks only the added run", () => {
		const diff = permissionDiff("Edit", {
			file_path: "a.ts",
			old_string: "const x = 1;",
			new_string: "const x = 1 + 2;",
		});
		const removed = diff?.lines.find((line) => line.kind === "removed");
		const added = diff?.lines.find((line) => line.kind === "added");
		// Nothing was removed: the old side has no contrast to draw.
		expect(removed?.segments).toBeUndefined();
		expect(added?.segments).toEqual([
			{ text: "const x = 1", changed: false },
			{ text: " + 2", changed: true },
			{ text: ";", changed: false },
		]);
	});

	test("lines with nothing in common carry no word highlight", () => {
		const diff = permissionDiff("Edit", { file_path: "a.ts", old_string: "two", new_string: "TWO" });
		const removed = diff?.lines.find((line) => line.kind === "removed");
		const added = diff?.lines.find((line) => line.kind === "added");
		expect(removed?.segments).toBeUndefined();
		expect(added?.segments).toBeUndefined();
	});

	test("an unaligned body is not paired line by line", () => {
		const oldText = Array.from({ length: 21 }, (_, i) => `value-${i}`).join("\n");
		const newText = Array.from({ length: 21 }, (_, i) => `value-x-${i}`).join("\n");
		const diff = permissionDiff("Edit", { file_path: "a.ts", old_string: oldText, new_string: newText });
		expect(diff?.lines.every((line) => line.segments === undefined)).toBe(true);
	});

	test("Write is all addition, so it has no pair to compare against", () => {
		const diff = permissionDiff("Write", { file_path: "a.ts", content: "const answer = 42;" });
		expect(diff?.lines.every((line) => line.segments === undefined)).toBe(true);
	});

	test("ANSI escapes are removed whole, and other controls become spaces", () => {
		const diff = permissionDiff("Edit", {
			file_path: "a.ts",
			old_string: "a\u001b[31mred\u001b[0mb\u0007",
			new_string: "clean",
		});
		expect(diff?.lines[2]).toEqual({ kind: "removed", text: "aredb " });
	});

	test("a long line is capped by code points", () => {
		const diff = permissionDiff("Write", { file_path: "a.ts", content: "x".repeat(300) });
		const added = diff?.lines[2];
		expect(added?.kind).toBe("added");
		expect(Array.from(added?.text ?? "").length).toBe(240);
		expect(added?.text.endsWith("…")).toBe(true);
	});

	test("past the alignment bound the whole change is shown unaligned, then capped", () => {
		const oldText = Array.from({ length: 21 }, (_, i) => `old-${i}`).join("\n");
		const newText = Array.from({ length: 21 }, (_, i) => `new-${i}`).join("\n");
		const diff = permissionDiff("Edit", { file_path: "a.ts", old_string: oldText, new_string: newText });
		// Two headers, 21 removals, then as many additions as the 40-line cap leaves.
		expect(diff?.lines).toHaveLength(40);
		expect(diff?.lines.filter((line) => line.kind === "removed")).toHaveLength(21);
		expect(diff?.lines.filter((line) => line.kind === "added")).toHaveLength(17);
		expect(diff?.notice).toContain("Too many lines to align");
		expect(diff?.notice).toContain("4 more lines not shown");
		expect(diff?.notice?.endsWith("ctrl+a for the full input.")).toBe(true);
	});

	test("a Write past the cap says how much is missing and how to see it", () => {
		const content = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
		const diff = permissionDiff("Write", { file_path: "a.ts", content });
		expect(diff?.lines).toHaveLength(40);
		expect(diff?.lines.filter((line) => line.kind === "added")).toHaveLength(38);
		expect(diff?.notice).toBe("12 more lines not shown — ctrl+a for the full input.");
	});

	test("the limits are overridable for callers that know their screen", () => {
		const diff = permissionDiff(
			"Write",
			{ file_path: "a.ts", content: "one\ntwo" },
			{ maxDiffLines: 3, maxLineChars: 2 },
		);
		expect(diff?.lines).toEqual([
			{ kind: "header", text: "--- a.ts" },
			{ kind: "header", text: "+++ a.ts" },
			{ kind: "added", text: "o…" },
		]);
		expect(diff?.notice).toBe("1 more line not shown — ctrl+a for the full input.");
	});
});
