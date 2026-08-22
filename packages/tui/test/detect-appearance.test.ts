/**
 * Terminal-background detection, exercised entirely offline.
 *
 * The real probe needs a TTY, which a test runner does not have, so stdin and
 * stdout are stood in for. That is the point: the interesting cases here are the
 * ones that are painful to reproduce by hand — a terminal that answers with two
 * hex digits per channel, a terminal that answers DA1 and nothing else, and a
 * terminal that never answers at all.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { appearanceFromColorFgBg, detectAppearance, parseBackgroundLuminance } from "../src/detect-appearance.ts";

const ESC = String.fromCharCode(0x1b);

/** Records writes and never blocks, standing in for a TTY stdout. */
function fakeStdout(isTTY = true) {
	const written: string[] = [];
	return {
		isTTY,
		written,
		write(chunk: string) {
			written.push(chunk);
			return true;
		},
	} as unknown as NodeJS.WriteStream & { written: string[] };
}

interface FakeStdin extends NodeJS.ReadStream {
	rawModeCalls: boolean[];
	resumeCalls: number;
	pauseCalls: number;
}

/**
 * Stands in for a TTY stdin. Tracks raw-mode transitions so a test can assert
 * the probe put the stream back the way it found it — a probe that leaves raw
 * mode on takes the keyboard away from the REPL that mounts next.
 */
function fakeStdin(options: { isTTY?: boolean; setRawMode?: boolean; paused?: boolean } = {}): FakeStdin {
	const emitter = new EventEmitter() as unknown as FakeStdin;
	const stream = emitter as unknown as {
		isTTY: boolean | undefined;
		isRaw: boolean;
		rawModeCalls: boolean[];
		resumeCalls: number;
		pauseCalls: number;
		setRawMode?: (mode: boolean) => NodeJS.ReadStream;
		isPaused: () => boolean;
		resume: () => NodeJS.ReadStream;
		pause: () => NodeJS.ReadStream;
	};
	let paused = options.paused ?? false;
	stream.isTTY = options.isTTY ?? true;
	stream.isRaw = false;
	stream.rawModeCalls = [];
	stream.resumeCalls = 0;
	stream.pauseCalls = 0;
	if (options.setRawMode !== false) {
		stream.setRawMode = (mode: boolean) => {
			stream.rawModeCalls.push(mode);
			stream.isRaw = mode;
			return emitter;
		};
	}
	stream.isPaused = () => paused;
	stream.resume = () => {
		stream.resumeCalls += 1;
		paused = false;
		return emitter;
	};
	stream.pause = () => {
		stream.pauseCalls += 1;
		paused = true;
		return emitter;
	};
	return emitter;
}

/** Feed a terminal reply on the next tick, once the probe is listening. */
function reply(stdin: FakeStdin, data: string): void {
	setTimeout(() => stdin.emit("data", Buffer.from(data)), 5);
}

describe("parseBackgroundLuminance", () => {
	test("reads white and black at full four-digit width", () => {
		expect(parseBackgroundLuminance("rgb:ffff/ffff/ffff")).toBeCloseTo(1, 5);
		expect(parseBackgroundLuminance("rgb:0000/0000/0000")).toBeCloseTo(0, 5);
	});

	// Each channel is scaled by its own width. Dividing everything by 0xffff
	// would read two-digit white as almost black.
	test("scales one, two, and three digit channels by their own width", () => {
		expect(parseBackgroundLuminance("rgb:f/f/f")).toBeCloseTo(1, 5);
		expect(parseBackgroundLuminance("rgb:ff/ff/ff")).toBeCloseTo(1, 5);
		expect(parseBackgroundLuminance("rgb:fff/fff/fff")).toBeCloseTo(1, 5);
		expect(parseBackgroundLuminance("rgb:0/0/0")).toBeCloseTo(0, 5);
	});

	test("weights green above red above blue", () => {
		const red = parseBackgroundLuminance("rgb:ffff/0000/0000") ?? 0;
		const green = parseBackgroundLuminance("rgb:0000/ffff/0000") ?? 0;
		const blue = parseBackgroundLuminance("rgb:0000/0000/ffff") ?? 0;
		expect(green).toBeGreaterThan(red);
		expect(red).toBeGreaterThan(blue);
	});

	test("accepts a reply embedded in surrounding escape bytes, and uppercase hex", () => {
		expect(parseBackgroundLuminance(`${ESC}]11;rgb:FFFF/FFFF/FFFF${ESC}\\`)).toBeCloseTo(1, 5);
	});

	test("returns undefined for anything that is not an rgb reply", () => {
		expect(parseBackgroundLuminance("")).toBeUndefined();
		expect(parseBackgroundLuminance(`${ESC}[?62;c`)).toBeUndefined();
		expect(parseBackgroundLuminance("rgb:zz/zz/zz")).toBeUndefined();
	});
});

describe("appearanceFromColorFgBg", () => {
	test("reads the background from the last field", () => {
		expect(appearanceFromColorFgBg("15;0")).toBe("dark");
		expect(appearanceFromColorFgBg("0;15")).toBe("light");
	});

	test("treats palette indexes 0-6 as dark and 7-15 as light", () => {
		for (let i = 0; i <= 6; i++) expect(appearanceFromColorFgBg(`7;${i}`)).toBe("dark");
		for (let i = 7; i <= 15; i++) expect(appearanceFromColorFgBg(`0;${i}`)).toBe("light");
	});

	test("handles the three-field form some terminals set", () => {
		expect(appearanceFromColorFgBg("15;default;0")).toBe("dark");
	});

	test("returns undefined when unset or out of range", () => {
		expect(appearanceFromColorFgBg(undefined)).toBeUndefined();
		expect(appearanceFromColorFgBg("")).toBeUndefined();
		expect(appearanceFromColorFgBg("15;default")).toBeUndefined();
		expect(appearanceFromColorFgBg("0;99")).toBeUndefined();
	});
});

describe("detectAppearance without a usable terminal", () => {
	test("writes nothing at all when CI is set", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		expect(await detectAppearance({ stdin, stdout, env: { CI: "1" } })).toBe("dark");
		expect(stdout.written).toEqual([]);
		expect(stdin.rawModeCalls).toEqual([]);
	});

	test("writes nothing at all when NO_COLOR is set", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		expect(await detectAppearance({ stdin, stdout, env: { NO_COLOR: "1" } })).toBe("dark");
		expect(stdout.written).toEqual([]);
	});

	test("writes nothing when stdin or stdout is not a TTY", async () => {
		const noStdin = fakeStdout();
		expect(await detectAppearance({ stdin: fakeStdin({ isTTY: false }), stdout: noStdin, env: {} })).toBe("dark");
		expect(noStdin.written).toEqual([]);

		const noStdout = fakeStdout(false);
		expect(await detectAppearance({ stdin: fakeStdin(), stdout: noStdout, env: {} })).toBe("dark");
		expect(noStdout.written).toEqual([]);
	});

	test("writes nothing when the stream cannot enter raw mode", async () => {
		const stdout = fakeStdout();
		const stdin = fakeStdin({ setRawMode: false });
		expect(await detectAppearance({ stdin, stdout, env: {} })).toBe("dark");
		expect(stdout.written).toEqual([]);
	});

	test("still consults COLORFGBG when it cannot probe", async () => {
		const stdin = fakeStdin({ isTTY: false });
		const stdout = fakeStdout();
		expect(await detectAppearance({ stdin, stdout, env: { CI: "1", COLORFGBG: "0;15" } })).toBe("light");
		expect(stdout.written).toEqual([]);
	});
});

describe("detectAppearance probing a terminal", () => {
	test("a white background reply resolves light", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, `${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\`);
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 })).toBe("light");
	});

	test("a black background reply resolves dark", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, `${ESC}]11;rgb:0000/0000/0000${ESC}\\`);
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 })).toBe("dark");
	});

	test("a two-digit-per-channel white reply resolves light, not near-black", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, `${ESC}]11;rgb:ff/ff/ff${ESC}\\`);
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 })).toBe("light");
	});

	test("a one-digit-per-channel white reply resolves light", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, `${ESC}]11;rgb:f/f/f${ESC}\\`);
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 })).toBe("light");
	});

	test("a reply arriving in fragments is reassembled", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		setTimeout(() => stdin.emit("data", Buffer.from(`${ESC}]11;rgb:ff`)), 5);
		setTimeout(() => stdin.emit("data", Buffer.from(`ff/ffff/ffff${ESC}\\`)), 15);
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 })).toBe("light");
	});

	test("sends both the background query and the DA1 tripwire", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, `${ESC}]11;rgb:0000/0000/0000${ESC}\\`);
		await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 });
		const sent = stdout.written.join("");
		expect(sent).toContain(`${ESC}]11;?`);
		expect(sent).toContain(`${ESC}[c`);
	});

	test("restores raw mode and detaches the listener on success", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, `${ESC}]11;rgb:0000/0000/0000${ESC}\\`);
		await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 });
		expect(stdin.rawModeCalls).toEqual([true, false]);
		expect(stdin.isRaw).toBe(false);
		expect(stdin.listenerCount("data")).toBe(0);
	});

	test("leaves a stream it resumed paused again if it started paused", async () => {
		const stdin = fakeStdin({ paused: true });
		const stdout = fakeStdout();
		reply(stdin, `${ESC}]11;rgb:0000/0000/0000${ESC}\\`);
		await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 });
		expect(stdin.pauseCalls).toBeGreaterThan(0);
		expect(stdin.isPaused()).toBe(true);
	});

	// The whole reason DA1 is sent: a terminal that answers it but not OSC 11 has
	// told us it does not support the query, so there is nothing left to wait for.
	test("a DA1-only reply falls back immediately instead of waiting out the timeout", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, `${ESC}[?62;1;6;9;15c`);
		const started = performance.now();
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 2000 })).toBe("dark");
		expect(performance.now() - started).toBeLessThan(1000);
		expect(stdin.rawModeCalls).toEqual([true, false]);
		expect(stdin.listenerCount("data")).toBe(0);
	});

	test("a DA1-only reply still honours COLORFGBG", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, `${ESC}[?62;c`);
		expect(await detectAppearance({ stdin, stdout, env: { COLORFGBG: "0;15" }, timeoutMs: 2000 })).toBe("light");
	});

	test("silence falls back after the timeout, leaving the stream as it was", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 30 })).toBe("dark");
		expect(stdin.rawModeCalls).toEqual([true, false]);
		expect(stdin.isRaw).toBe(false);
		expect(stdin.listenerCount("data")).toBe(0);
	});

	test("silence falls back to COLORFGBG when it is set", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		expect(await detectAppearance({ stdin, stdout, env: { COLORFGBG: "0;15" }, timeoutMs: 30 })).toBe("light");
	});

	test("unrelated input does not resolve the probe early", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, "hello there");
		const started = performance.now();
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 80 })).toBe("dark");
		expect(performance.now() - started).toBeGreaterThanOrEqual(60);
	});

	test("a late second reply after settling does not throw", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		reply(stdin, `${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\`);
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 })).toBe("light");
		stdin.emit("data", Buffer.from(`${ESC}]11;rgb:0000/0000/0000${ESC}\\`));
	});

	// `/theme auto` runs while Ink is reading stdin. The reply is escape bytes, so
	// a key handler that sees them types them into the prompt.
	test("holds off other stdin readers during the probe and restores them after", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		const seen: string[] = [];
		const other = (data: string | Buffer) => {
			seen.push(data.toString());
		};
		stdin.on("data", other);

		reply(stdin, `${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\`);
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 })).toBe("light");
		expect(seen).toEqual([]);

		expect(stdin.listeners("data")).toEqual([other]);
		stdin.emit("data", Buffer.from("x"));
		expect(seen).toEqual(["x"]);
	});

	test("restores other readers when the terminal never answers", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		const other = () => {};
		stdin.on("data", other);
		await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 30 });
		expect(stdin.listeners("data")).toEqual([other]);
	});

	test("restores other readers when raw mode cannot be entered", async () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		const other = () => {};
		stdin.on("data", other);
		(stdin as unknown as { setRawMode: (mode: boolean) => never }).setRawMode = () => {
			throw new Error("no tty");
		};
		expect(await detectAppearance({ stdin, stdout, env: {}, timeoutMs: 500 })).toBe("dark");
		expect(stdin.listeners("data")).toEqual([other]);
	});
});
