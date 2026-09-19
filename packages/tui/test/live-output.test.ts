/**
 * The live window under a running tool.
 *
 * Everything here is about staying small and honest: the window shows the tail
 * (what a running command is printing now), it never grows past its line budget
 * however much a command talks, and when it drops lines it says so rather than
 * silently starting mid-sentence.
 */
import { describe, expect, test } from "bun:test";
import { LIVE_LINE_CHARS, LIVE_OUTPUT_LINES, liveOutputLines, livePreviewTargets } from "../src/live-output.ts";
import type { PendingTool } from "../src/ui-state.ts";

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("liveOutputLines", () => {
	test("shows everything when it fits", () => {
		expect(liveOutputLines("a\nb\nc", 6)).toEqual(["a", "b", "c"]);
	});

	test("keeps the tail and counts what it dropped", () => {
		const shown = liveOutputLines(lines(200), LIVE_OUTPUT_LINES);
		expect(shown).toHaveLength(LIVE_OUTPUT_LINES);
		expect(shown[0]).toBe(`… ${200 - (LIVE_OUTPUT_LINES - 1)} lines omitted`);
		expect(shown[shown.length - 1]).toBe("line 200");
	});

	test("a stream that ends mid-line has not printed a blank last line", () => {
		expect(liveOutputLines("a\nb\n", 6)).toEqual(["a", "b"]);
		// A genuinely blank line in the middle is still shown.
		expect(liveOutputLines("a\n\nb", 6)).toEqual(["a", "", "b"]);
	});

	test("an overlong line keeps both ends and loses the middle", () => {
		const [line] = liveOutputLines("x".repeat(5000), 6);
		expect(line.length).toBeLessThanOrEqual(LIVE_LINE_CHARS);
		expect(line).toContain("…");
		expect(line.startsWith("xxx")).toBe(true);
		expect(line.endsWith("xxx")).toBe(true);
	});

	test("a progress bar redrawn with carriage returns does not collapse into one line", () => {
		expect(liveOutputLines("10%\r55%\r100%", 6)).toEqual(["10%", "55%", "100%"]);
	});

	test("a one-line window still shows the newest line", () => {
		expect(liveOutputLines(lines(50), 1)).toEqual(["line 50"]);
	});

	test("no window at all is empty, not an error", () => {
		expect(liveOutputLines("anything", 0)).toEqual([]);
	});
});

describe("livePreviewTargets", () => {
	const pending = (...ids: string[]): PendingTool[] => ids.map((callId) => ({ callId, toolName: "Bash" }));

	test("only tools that have printed something", () => {
		expect(livePreviewTargets(pending("a", "b"), { b: "out" }).map((t) => t.callId)).toEqual(["b"]);
	});

	test("capped at the most recently started, oldest of those first", () => {
		const targets = livePreviewTargets(pending("a", "b", "c"), { a: "1", b: "2", c: "3" });
		expect(targets.map((t) => t.callId)).toEqual(["b", "c"]);
		expect(targets.map((t) => t.text)).toEqual(["2", "3"]);
	});
});
