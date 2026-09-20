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

describe("cutText", () => {
	test("keeps the head and says how much of the output is missing", () => {
		const text = cutText("a".repeat(1_000), 100);
		expect(text.startsWith("a".repeat(100))).toBe(true);
		expect(text).toContain("... [truncated 900 chars of output]");
	});

	test("spilled text keeps its full form on disk and a path in the result", () => {
		const { written, writer } = keeper();
		const text = cutText("b".repeat(5_000), 100, writer, request);
		expect(written).toEqual(["b".repeat(5_000)]);
		expect(text.startsWith("[full output: 5000 chars → /spill/Bash-call_1.txt]\n")).toBe(true);
		// The head still fits the budget once the pointer is accounted for: the
		// pointer is part of what the model is being given.
		expect(text.length).toBeLessThan(100 + 60);
	});

	test("a second cut keeps the pointer and counts both of them together", () => {
		// The round budget runs after the tool's own limit, so this is the normal
		// case for a spilled result, not an edge one. A reader of the twice-cut
		// result must not be told the missing part is smaller than it is.
		const { writer } = keeper();
		const once = cutText("c".repeat(5_000), 1_000, writer, request);
		const twice = cutText(once, 200);
		expect(twice).toContain("[full output: 5000 chars → /spill/Bash-call_1.txt]");
		const missing = Number(/truncated (\d+) chars of output/.exec(twice)?.[1]);
		// 5000 written, of which ~200 are shown (less the pointer's own length).
		expect(missing).toBeGreaterThan(4_700);
		expect(missing).toBeLessThan(5_000);
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
