/**
 * The console family's write rules, without a console.
 *
 * Which hosts count, where a chunk may cut, and what the installed writer
 * does with small writes, trailing arguments and a second install — each is a
 * pure decision, so each is pinned here; the reprint that actually trips the
 * budget is measured in repl-clear-screen.
 */
import { describe, expect, test } from "bun:test";
import { chunkForConPTY, chunkWritesForConPTY, isConPTYHost, MAX_CONPTY_WRITE } from "../src/conpty.ts";

describe("isConPTYHost", () => {
	test("windows itself", () => {
		expect(isConPTYHost("win32", {})).toBe(true);
	});

	test("a WSL shell, because the host terminal is a Windows one", () => {
		expect(isConPTYHost("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
		expect(isConPTYHost("linux", { WSL_INTEROP: "/run/WSL/1_interop" })).toBe(true);
	});

	test("nothing else", () => {
		expect(isConPTYHost("linux", {})).toBe(false);
		expect(isConPTYHost("darwin", {})).toBe(false);
	});
});

describe("chunkForConPTY", () => {
	test("data that fits is one chunk, untouched", () => {
		expect(chunkForConPTY("hello\nworld")).toEqual(["hello\nworld"]);
	});

	test("empty data is no chunk at all", () => {
		expect(chunkForConPTY("")).toEqual([]);
	});

	test("a long transcript cuts at newlines, every piece within the budget", () => {
		const line = `${"x".repeat(120)}\n`;
		const data = line.repeat(700); // ~85 KB
		const chunks = chunkForConPTY(data);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join("")).toBe(data);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CONPTY_WRITE);
		// Every cut sits on a newline, so no escape sequence can straddle one.
		for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith("\n")).toBe(true);
	});

	test("a sequence right after the window's last newline stays whole", () => {
		// One newline in the first window, at 8180, so the cut lands exactly
		// there and the escape sequence that follows starts the next chunk.
		const data = `${"a".repeat(8180)}\n\x1b[31mred${"b".repeat(600)}`;
		const chunks = chunkForConPTY(data);

		expect(chunks[0].endsWith("\n")).toBe(true);
		expect(chunks[1].startsWith("\x1b[31m")).toBe(true);
		expect(chunks.join("")).toBe(data);
	});

	test("one giant line cuts at the budget anyway: progress beats alignment", () => {
		const data = "y".repeat(20000);
		const chunks = chunkForConPTY(data);

		expect(chunks.map((chunk) => chunk.length)).toEqual([8192, 8192, 3616]);
		expect(chunks.join("")).toBe(data);
	});

	test("a newline at the window's very start still advances", () => {
		const data = `\n${"y".repeat(20000)}`;
		const chunks = chunkForConPTY(data);

		expect(chunks[0]).toBe("\n");
		expect(chunks.join("")).toBe(data);
	});
});

describe("chunkWritesForConPTY", () => {
	function fakeStream() {
		const calls: unknown[][] = [];
		const stream = {
			write: (...args: unknown[]) => {
				calls.push(args);
				return true;
			},
		};
		return { stream, calls };
	}

	test("a write that fits passes through as one call", () => {
		const { stream, calls } = fakeStream();
		chunkWritesForConPTY(stream);

		stream.write("small\n");

		expect(calls).toEqual([["small\n"]]);
	});

	test("an oversized write leaves as capped pieces that still join up", () => {
		const { stream, calls } = fakeStream();
		chunkWritesForConPTY(stream);
		const data = `${"z".repeat(200)}\n`.repeat(100); // ~20 KB

		stream.write(data);

		expect(calls.length).toBeGreaterThan(1);
		for (const [chunk] of calls) expect((chunk as string).length).toBeLessThanOrEqual(MAX_CONPTY_WRITE);
		expect(calls.map(([chunk]) => chunk).join("")).toBe(data);
	});

	test("a write carrying trailing arguments is not split — nothing here sends one", () => {
		const { stream, calls } = fakeStream();
		chunkWritesForConPTY(stream);
		const data = "w".repeat(20000);
		const callback = () => {};

		stream.write(data, callback);

		expect(calls).toEqual([[data, callback]]);
	});

	test("installing twice does not chunk the chunks", () => {
		const { stream, calls } = fakeStream();
		chunkWritesForConPTY(stream);
		chunkWritesForConPTY(stream);
		const data = `${"q".repeat(4000)}\n`.repeat(4); // ~16 KB

		stream.write(data);

		const once = chunkForConPTY(data);
		expect(calls.map(([chunk]) => chunk)).toEqual(once);
	});
});
