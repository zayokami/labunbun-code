/**
 * The console family's write rules, without a console.
 *
 * Which hosts count, where a chunk may cut, and what the installed writer
 * does with small writes, trailing arguments, a second install and the
 * scrollback erase — each is a pure decision, so each is pinned here; the
 * reprint that actually trips the budget is measured in repl-clear-screen.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	chunkForConPTY,
	chunkWritesForConPTY,
	isConPTYHost,
	MAX_CONPTY_WRITE,
	stripScrollbackErase,
} from "../src/conpty.ts";

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

describe("stripScrollbackErase", () => {
	// ink's fullscreen clear, exactly as ansi-escapes spells it.
	const clearTerminal = "\x1b[2J\x1b[3J\x1b[H";

	test("the 3J goes, everything around it stays", () => {
		expect(stripScrollbackErase(clearTerminal)).toBe("\x1b[2J\x1b[H");
		expect(stripScrollbackErase(`head${clearTerminal}body\x1b[3J`)).toBe("head\x1b[2J\x1b[Hbody");
	});

	test("a write with no 3J is untouched", () => {
		expect(stripScrollbackErase("\x1b[2J\x1b[Hplain")).toBe("\x1b[2J\x1b[Hplain");
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

	test("the scrollback erase is dropped on the way out", () => {
		const { stream, calls } = fakeStream();
		chunkWritesForConPTY(stream);

		// ink's fullscreen clear, followed by the frame it prints onto it.
		stream.write("\x1b[2J\x1b[3J\x1b[Hnext frame");

		expect(calls).toEqual([["\x1b[2J\x1b[Hnext frame"]]);
	});

	test("the pure subpaths stay pure", () => {
		// The startup paths that only need these files import them through their
		// own exports so they never execute the barrel's ink/react graph. Two
		// regressions are cheap to make and invisible here until startup slows
		// again: a value import added to a pure file (which then needs the
		// module graph on a path that only wanted string helpers), and an
		// export re-pointed at ./src/index.ts. `import type` is allowed because
		// it is erased; any other import, a dynamic import or a require is not.
		for (const file of ["conpty.ts", "format.ts"]) {
			const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			const imports = source.match(/^\s*import\b.*$/gm) ?? [];
			const valueImports = imports
				.filter((line) => !/^\s*import\s+type\b/.test(line))
				.map((line) => `${file}: ${line}`);
			expect(valueImports).toEqual([]);
			expect(source).not.toMatch(/\bimport\s*\(/);
			expect(source).not.toMatch(/\brequire\s*\(/);
		}

		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, string>;
		};
		expect(manifest.exports).toMatchObject({
			".": "./src/index.ts",
			"./conpty": "./src/conpty.ts",
			"./format": "./src/format.ts",
			"./permission-options": "./src/permission-options.ts",
		});
	});

	test("stripping happens before the cut: an erase that straddles the budget is still removed", () => {
		// No newline anywhere, so the cut can only fall at the budget, and the
		// erase is placed so that a cut made first would land inside it: `\x1b[`
		// ends the first piece and `3J` starts the second. Stripped after the cut,
		// neither half is the sequence and both would go out, rejoining on the
		// console as the very erase this exists to keep off it.
		const { stream, calls } = fakeStream();
		chunkWritesForConPTY(stream);
		const data = `${"y".repeat(MAX_CONPTY_WRITE - 2)}\x1b[3J${"z".repeat(100)}`;

		stream.write(data);

		const sent = calls.map(([chunk]) => chunk as string);
		expect(sent.join("")).toBe(stripScrollbackErase(data));
		expect(sent.join("")).not.toContain("\x1b[3J");
		expect(sent.join("")).not.toContain("\x1b");
		// Cut at the budget of what actually goes out, not of what came in.
		expect(sent.map((chunk) => chunk.length)).toEqual([MAX_CONPTY_WRITE, 98]);
	});

	test("an erase on every line is stripped, and the pieces still cut at newlines", () => {
		const { stream, calls } = fakeStream();
		chunkWritesForConPTY(stream);
		const data = `\x1b[3J${"y".repeat(200)}\n`.repeat(100); // ~20 KB

		stream.write(data);

		expect(calls.length).toBeGreaterThan(1);
		for (const [chunk] of calls) expect((chunk as string).length).toBeLessThanOrEqual(MAX_CONPTY_WRITE);
		expect(calls.map(([chunk]) => chunk).join("")).toBe(stripScrollbackErase(data));
	});
});
