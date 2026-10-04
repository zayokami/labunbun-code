/**
 * The two limits on tool output: the tool's own, and the turn's.
 *
 * What is under test is mostly the honesty of the result afterwards — whether
 * the model can tell that text is missing, whether it can still get at it, and
 * whether a second cut tells it the same truth as the first.
 */
import { describe, expect, test } from "bun:test";
import { textContent, toolResultMessage } from "@labunbun/ai";
import { capRoundResults, cutText, MAX_ROUND_RESULT_CHARS, MIN_ROUND_RESULT_CHARS } from "../src/output-limits.ts";

/** A writer that keeps what it was given, so the spilled text is assertable. */
function keeper() {
	const written: string[] = [];
	const writer = (request: { callId: string; toolName: string; text: string }) => {
		written.push(request.text);
		return `/spill/${request.toolName}-${request.callId}.txt`;
	};
	return { written, writer };
}

const request = { callId: "call_1", toolName: "Bash", text: "" };

/** Output with a first and a last line, so a cut result can be read for both. */
function lines(count: number): string {
	return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

/** What a cut result says is missing, or NaN when it was never cut. */
function omittedOf(text: string): number {
	return Number(/truncated (\d+) chars of output/.exec(text)?.[1]);
}

/** The notice itself, so a budget can be stated net of it. */
function noticeOf(text: string): string {
	return /\.\.\. \[truncated \d+ chars of output\]/.exec(text)?.[0] ?? "";
}

/**
 * What a head-only cut of `text` to `limit` would have reported as missing: it
 * kept `limit` of the body and told the reader the rest was gone. The number the
 * head-and-tail cut has to produce for the same input — keeping the tail is not
 * a reason to tell the reader that less is missing.
 */
function headOnlyMissing(text: string, limit: number): number {
	return text.length - Math.min(limit, text.length);
}

describe("cutText", () => {
	test("keeps both ends of the output and says how much of the middle is missing", () => {
		const full = lines(500);
		const text = cutText(full, 200);
		// The head is what says what was run; the tail is where a build says what
		// went wrong. A cut result with only one of them cannot say which case it is.
		expect(text.startsWith("line 1\n")).toBe(true);
		expect(text.endsWith("line 500")).toBe(true);
		// The middle is what the cut was for.
		expect(text).not.toContain("line 250");
		expect(omittedOf(text)).toBe(headOnlyMissing(full, 200));
	});

	test("the notice stands at the cut, and both halves spend the whole budget", () => {
		const full = lines(500);
		const text = cutText(full, 400);
		const [before, after] = text.split(noticeOf(text));
		// Head, notice, tail — and nothing of the middle in between.
		expect(before).not.toBe("");
		expect(after?.startsWith("\n")).toBe(true);
		expect(text).not.toContain("line 250");
		// What is shown of the output is the budget, all of it, and split so that
		// neither end is a preview of the other. The ratio itself is a decision;
		// what is asserted is that no half is starved, and that they are near equals.
		const headChars = (before?.length ?? 0) - 1;
		const tailChars = (after?.length ?? 0) - 1;
		expect(headChars + tailChars).toBe(400);
		expect(Math.abs(headChars - tailChars)).toBeLessThanOrEqual(1);
	});

	test("the notice is charged on top of the limit, not out of it", () => {
		// A notice whose length depends on the number it reports cannot also be
		// part of the budget that produced it: charging it there would make one
		// output be reported as differently truncated at two budgets.
		for (const limit of [120, 4_000, 30_000]) {
			const text = cutText(lines(500), limit);
			expect(text.length - noticeOf(text).length - 2).toBeLessThanOrEqual(limit);
		}
	});

	test("the missing total is what a head-only cut would have reported", () => {
		// The accounting trap. `missing` is a promise to whoever reads the result,
		// and the round budget adds to it on the second cut. Dropping the middle
		// instead of the tail must not move the number.
		const full = lines(500);
		const limits = [1, 2, 40, 401, 2_000, full.length - 1, full.length, full.length + 1];
		for (const limit of limits) {
			const cut = cutText(full, limit);
			// At or above the body's own length nothing is cut, so there is nothing
			// to be honest about and no notice to give.
			expect(omittedOf(cut)).toBe(limit >= full.length ? NaN : headOnlyMissing(full, limit));
		}
	});

	test("a second cut of a cut result reports one cumulative total", () => {
		// The round budget runs after the tool's own limit, so this is the normal
		// case for a spilled result, not an edge one: the same text is cut twice,
		// and the second cut has to add to the first rather than restate it.
		const full = lines(500);
		const once = cutText(full, 4_000);
		expect(omittedOf(once)).toBe(headOnlyMissing(full, 4_000));

		const twice = cutText(once, 300);
		expect(omittedOf(twice)).toBe(headOnlyMissing(full, 300));
		// One notice, not two: the old one was taken apart, not kept and answered.
		expect(twice.match(/truncated/g)).toHaveLength(1);
		// And the ends still come from the ends of the original.
		expect(twice.startsWith("line 1")).toBe(true);
		expect(twice.endsWith("line 500")).toBe(true);
	});

	test("a cut of a cut result is bounded by the budget it was given", () => {
		const full = lines(500);
		const twice = cutText(cutText(full, 4_000), 300);
		expect(twice.length - noticeOf(twice).length - 2).toBeLessThanOrEqual(300);
	});

	test("a budget too small to divide falls back to the head, in budget and honest", () => {
		const full = lines(500);
		// Nothing to divide: what is shown is the head and nothing else, which is
		// what a cut of this size used to be.
		for (const limit of [0, 1]) {
			const text = cutText(full, limit);
			expect(text.startsWith(full.slice(0, limit))).toBe(true);
			expect(omittedOf(text)).toBe(headOnlyMissing(full, limit));
		}
		// Small enough that a half is one character or two, but a tail exists:
		// the head is never the one that gets emptied.
		for (const limit of [2, 3, 7, 11]) {
			const text = cutText(full, limit);
			expect(text.startsWith(full.slice(0, 1))).toBe(true);
			expect(omittedOf(text)).toBe(headOnlyMissing(full, limit));
			expect(text.length - noticeOf(text).length - 2).toBeLessThanOrEqual(limit);
			expect(text.match(/truncated/g)).toHaveLength(1);
		}
	});

	test("a short body is cut at both of its ends, not through a token", () => {
		const text = cutText("hello world", 5);
		expect(text.startsWith("hel")).toBe(true);
		expect(text.endsWith("ld")).toBe(true);
		expect(text).toContain("... [truncated 6 chars of output]");
		expect(text).not.toContain("o wor");
	});

	test("a body of nothing but whitespace is cut without inventing anything", () => {
		const full = "   \n  \n\t\n ";
		const text = cutText(full, 4);
		expect(text.match(/truncated/g)).toHaveLength(1);
		expect(omittedOf(text)).toBe(headOnlyMissing(full, 4));
		expect(text.length - noticeOf(text).length - 2).toBeLessThanOrEqual(4);
		// Whatever survived is the body's own characters; the cut added no filler.
		expect(text.replace(noticeOf(text), "").replaceAll("\n", "")).toBe("  \n ".replaceAll("\n", ""));
	});

	test("spilled text keeps its full form on disk and a path in the result", () => {
		const { written, writer } = keeper();
		const text = cutText("b".repeat(5_000), 100, writer, request);
		expect(written).toEqual(["b".repeat(5_000)]);
		expect(text.startsWith("[full output: 5000 chars → /spill/Bash-call_1.txt]\n")).toBe(true);
		// What is shown of the output still fits the budget once the pointer is
		// accounted for: the pointer is part of what the model is being given.
		expect(text.length).toBeLessThan(100 + 60);
	});

	test("the pointer is still the first line when both ends are shown", () => {
		const full = lines(500);
		const { writer } = keeper();
		const pointer = `[full output: ${full.length} chars → /spill/Bash-call_1.txt]\n`;
		const text = cutText(full, 2_000, writer, request);
		expect(text.startsWith(pointer)).toBe(true);
		// The head follows the pointer and the tail closes the result — the
		// pointer does not move into the middle to make room for the tail.
		expect(text.slice(pointer.length)).toMatch(/^line 1\n/);
		expect(text.endsWith("line 500")).toBe(true);
		expect(text.length - noticeOf(text).length - 2).toBeLessThanOrEqual(2_000);
	});

	test("a second cut keeps the pointer and counts both of them together", () => {
		// The round budget runs after the tool's own limit, so this is the normal
		// case for a spilled result, not an edge one. A reader of the twice-cut
		// result must not be told the missing part is smaller than it is.
		const { writer } = keeper();
		const once = cutText("c".repeat(5_000), 1_000, writer, request);
		const twice = cutText(once, 200);
		expect(twice).toContain("[full output: 5000 chars → /spill/Bash-call_1.txt]");
		const missing = omittedOf(twice);
		// 5000 written, of which ~200 are shown (less the pointer's own length).
		expect(missing).toBeGreaterThan(4_700);
		expect(missing).toBeLessThan(5_000);
		// The pointer still leads, and the notice is the only one left.
		expect(twice.startsWith("[full output: 5000 chars → /spill/Bash-call_1.txt]\n")).toBe(true);
		expect(twice.match(/truncated/g)).toHaveLength(1);
	});

	test("a writer that fails leaves a cut result, not a failed tool", () => {
		const text = cutText("d".repeat(1_000), 50, () => null, request);
		expect(text).toContain("... [truncated 950 chars of output]");
		expect(text).not.toContain("full output:");
	});

	test("a writer that throws leaves a cut result too", () => {
		const text = cutText(
			"e".repeat(1_000),
			50,
			() => {
				throw new Error("disk is full");
			},
			request,
		);
		expect(text).toContain("... [truncated 950 chars of output]");
	});

	test("text that fits is returned untouched, spill writer or not", () => {
		const { written, writer } = keeper();
		expect(cutText("short", 100, writer, request)).toBe("short");
		expect(written).toEqual([]);
	});

	test("no room for a head still leaves the pointer and the notice", () => {
		const text = cutText("f".repeat(500), 0);
		expect(text).toBe("... [truncated 500 chars of output]");
	});
});

function result(toolName: string, callId: string, chars: number) {
	return toolResultMessage(callId, toolName, [textContent("x".repeat(chars))]);
}

describe("capRoundResults", () => {
	test("a round within its budget is not touched", () => {
		const results = [result("Bash", "a", 500), result("Read", "b", 500)];
		expect(capRoundResults(results)).toBe(results);
	});

	test("a round over its budget is cut down to it", () => {
		const results = [result("Bash", "a", 150_000), result("Read", "b", 150_000)];
		const capped = capRoundResults(results);
		const total = capped.reduce(
			(sum, r) => sum + r.content.reduce((s, b) => s + (b.type === "text" ? b.text.length : 0), 0),
			0,
		);
		// The markers add a few dozen characters each; the cut is to the budget.
		expect(total).toBeLessThan(MAX_ROUND_RESULT_CHARS + 200);
		expect(total).toBeLessThan(300_000);
	});

	test("proportional: the result with more output keeps more of it", () => {
		const results = [result("Bash", "a", 400_000), result("Grep", "b", 100_000)];
		const capped = capRoundResults(results);
		const shown = (r: (typeof results)[number]) => (r.content[0] as { text: string }).text.length;
		expect(shown(capped[0] as (typeof results)[number])).toBeGreaterThan(shown(capped[1] as (typeof results)[number]));
	});

	test("many results keep at least a preview each", () => {
		// 40 results of 20k are 800k together; equal shares would be 5k apiece, and
		// the floor is what stops a share from being useless.
		const results = Array.from({ length: 40 }, (_, i) => result("Grep", `c${i}`, 20_000));
		const capped = capRoundResults(results);
		for (const cappedResult of capped) {
			const text = (cappedResult.content[0] as { text: string }).text;
			expect(text.length).toBeGreaterThanOrEqual(MIN_ROUND_RESULT_CHARS);
			expect(text).toContain("truncated");
		}
	});

	test("a round whose floors alone exceed the budget is still bounded", () => {
		// 200 results cannot each keep 2k out of a 200k budget. The floor gives way
		// — the budget is what the turn costs, and that is not negotiable.
		const results = Array.from({ length: 200 }, (_, i) => result("Grep", `d${i}`, 10_000));
		const capped = capRoundResults(results);
		const total = capped.reduce(
			(sum, r) => sum + r.content.reduce((s, b) => s + (b.type === "text" ? b.text.length : 0), 0),
			0,
		);
		expect(total).toBeLessThanOrEqual(MAX_ROUND_RESULT_CHARS + 200 * 40);
	});

	test("a whole result is spilled rather than thrown away", () => {
		// Nothing had cut it before the round did, so this is the last moment the
		// full output exists anywhere.
		const { written, writer } = keeper();
		const capped = capRoundResults([result("Bash", "e", 300_000)], writer);
		const first = capped[0] as { content: Array<{ text: string }> };
		expect(written).toEqual(["x".repeat(300_000)]);
		expect(first.content[0]?.text).toContain("[full output: 300000 chars →");
	});

	test("a result that already spilled is cut, not spilled again", () => {
		// What is in hand is a preview; writing it out again would produce a file
		// that looks like the full output and is not. The round budget is what asks
		// this question, because that cut is the one that runs after the tool's own
		// — so the fixture is a spilled result large enough for the round to cut
		// again, and the assertion is that it made no second file.
		const { written, writer } = keeper();
		const preview = cutText("y".repeat(900_000), 300_000, writer, request);
		expect(written).toHaveLength(1);

		const capped = capRoundResults([toolResultMessage("call_1", "Bash", [textContent(preview)])], writer, 50_000);
		const text = (capped[0] as { content: Array<{ text?: string }> }).content[0]?.text ?? "";

		expect(written).toHaveLength(1);
		// The pointer is still the first line, and it still names the full output.
		expect(text.startsWith("[full output: 900000 chars → /spill/Bash-call_1.txt]\n")).toBe(true);
		expect(text).toContain("truncated");
		expect(text.length).toBeLessThan(50_100);
	});
});
