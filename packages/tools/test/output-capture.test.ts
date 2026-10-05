/**
 * The bounded capture behind a command's output — the windows, the notice,
 * and the spill path.
 *
 * Hand-fed chunks at small numbers: a head of four characters over chunks of
 * three reproduces every boundary a 30k window has, without a test that writes
 * thirty thousand characters to observe arithmetic. The exec-level rows in
 * `output-spill.test.ts` pin the same shapes at full size through a real shell;
 * this file pins the arithmetic they rest on.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cutText } from "@labunbun/agent";
import { createStreamCapture, nextSpillPath } from "../src/index.ts";

describe("stream capture", () => {
	test("under the bound, the text is the whole stream and nothing is dropped", () => {
		const capture = createStreamCapture(10, 10);
		capture.push("hello ");
		capture.push("world");
		const { text, dropped, total } = capture.finish();
		expect(text).toBe("hello world");
		expect(dropped).toBe(0);
		expect(total).toBe(11);
	});

	test("the bound is 'more than', not 'at least': an exact fit crosses nothing", () => {
		const seen: string[] = [];
		const capture = createStreamCapture(4, 4, {
			overflow: (prefix) => seen.push(`seed:${prefix}`),
			chunk: (chunk) => seen.push(`chunk:${chunk}`),
		});
		capture.push("a".repeat(8));
		expect(seen).toEqual([]);
		const { text, dropped } = capture.finish();
		expect(text).toBe("a".repeat(8));
		expect(dropped).toBe(0);
	});

	test("the sink is handed a lossless seed at the crossing, then every chunk after", () => {
		const seen: string[] = [];
		const capture = createStreamCapture(4, 4, {
			overflow: (prefix) => seen.push(`seed:${prefix}`),
			chunk: (chunk) => seen.push(`chunk:${chunk}`),
		});
		capture.push("aaa");
		capture.push("bbb"); // six characters: inside the bound, nothing dropped yet
		expect(seen).toEqual([]);
		capture.push("ccc"); // nine: the crossing chunk seeds and then lands itself
		capture.push("ddd");
		expect(seen).toEqual(["seed:aaabbb", "chunk:ccc", "chunk:ddd"]);
	});

	test("the notice carries the exact missing count and the identity holds", () => {
		const capture = createStreamCapture(10, 10);
		capture.push("a".repeat(15));
		capture.push("b".repeat(15));
		const { text, dropped, total } = capture.finish();
		expect(total).toBe(30);
		expect(dropped).toBe(10);
		expect(text).toBe(`${"a".repeat(10)}\n... [truncated 10 chars of output]\n${"b".repeat(10)}`);
		// The identity the pipeline's own cuts keep: what is shown plus what the
		// notice counts is the whole stream. The two line breaks around the notice
		// belong to the serialization, not to the stream, so they come off first.
		const shown = text.length - "... [truncated 10 chars of output]".length - 2;
		expect(shown).toBe(total - dropped);
	});

	test("a stream ending exactly at the head's edge is not doubled", () => {
		// `slice(-0)` is the whole string, which is why the join has a guard rather
		// than a bare negative slice.
		const capture = createStreamCapture(5, 5);
		capture.push("abcde");
		expect(capture.finish().text).toBe("abcde");
	});

	test("windows that overlap at the seam join into the exact stream", () => {
		const capture = createStreamCapture(5, 5);
		capture.push("abcdef"); // head holds five, the tail's last character is the sixth
		expect(capture.finish().text).toBe("abcdef");
	});

	test("no sink, same bounds: the text is bounded and the count is honest", () => {
		const capture = createStreamCapture(3, 3);
		capture.push("aaaaaaaaaa");
		const { text, dropped, total } = capture.finish();
		expect(total).toBe(10);
		expect(dropped).toBe(4);
		expect(text).toBe("aaa\n... [truncated 4 chars of output]\naaa");
	});

	test("many chunks past the crossing produce one notice, not one per chunk", () => {
		const capture = createStreamCapture(3, 3);
		for (let i = 0; i < 10; i++) capture.push("ab");
		const { text, dropped, total } = capture.finish();
		expect(total).toBe(20);
		expect(dropped).toBe(14);
		expect(text.split("truncated")).toHaveLength(2);
		expect(text).toContain("... [truncated 14 chars of output]");
	});

	test("empty chunks are ignored", () => {
		const capture = createStreamCapture(2, 2);
		capture.push("");
		const { text, total } = capture.finish();
		expect(total).toBe(0);
		expect(text).toBe("");
	});

	test("the pipeline's next cut reads this capture's notice as its own", () => {
		// The reason the notice format is shared: a capture that dropped a middle
		// and a pipeline cut that drops another must leave the reader with one
		// cumulative number over the stream, not a count that restarts.
		const capture = createStreamCapture(10, 10);
		capture.push("a".repeat(40));
		const { text, total } = capture.finish();
		const cut = cutText(text, 30);
		const shown = cut.match(/^a+/)?.[0].length ?? 0;
		const missing = Number(/truncated (\d+) chars/.exec(cut)?.[1]);
		expect(shown + missing).toBe(total);
		expect(cut).toContain("... [truncated 20 chars of output]");
	});
});

describe("nextSpillPath", () => {
	test("labelled, inside the directory, and unique across calls in one tick", () => {
		const dir = join("some", "where");
		const a = nextSpillPath(dir, "exec");
		const b = nextSpillPath(dir, "exec");
		expect(a).not.toBe(b);
		expect(a.startsWith(join(dir, "exec-"))).toBe(true);
		expect(a.endsWith(".txt")).toBe(true);
		expect(nextSpillPath(dir, "glob").startsWith(join(dir, "glob-"))).toBe(true);
	});
});
