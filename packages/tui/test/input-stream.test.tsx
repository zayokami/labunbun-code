/**
 * Ink and the probe on one stream: what `detectAppearance` hands back has to
 * be a stream that still delivers keys.
 *
 * ink-testing-library's fake stdin is a dumb EventEmitter — no pause, no
 * resume, no flow semantics — so every component test stays green while a real
 * stream could come back from a probe attached but no longer read. These tests
 * run the real probe against a PassThrough with real stream semantics, inside
 * a live Ink render, and then press a key through it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render, Text, useInput } from "ink";
import { createElement as h } from "react";
import { detectAppearance } from "../src/detect-appearance.ts";
import { installStdinTrace } from "../src/input-trace.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FakeStdin = PassThrough & {
	isTTY: boolean;
	setRawMode: (mode: boolean) => void;
	ref: () => void;
	unref: () => void;
};

/** A stdin with real flow semantics and just enough tty shape to be probed. */
function makeStdin(): FakeStdin {
	const stdin = new PassThrough() as FakeStdin;
	stdin.isTTY = true;
	stdin.setRawMode = () => {};
	stdin.ref = () => {};
	stdin.unref = () => {};
	return stdin;
}

/** An output sink that looks like a terminal to the probe's gate. */
function makeStdout(): PassThrough & { isTTY: boolean; columns: number; rows: number } {
	const stdout = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
	stdout.isTTY = true;
	stdout.columns = 80;
	stdout.rows = 24;
	return stdout;
}

function Prober({ seen }: { seen: string[] }) {
	useInput((input, key) => {
		seen.push(key.upArrow ? "UP" : key.downArrow ? "DOWN" : JSON.stringify(input));
	});
	return h(Text, null, "listening");
}

/**
 * Render the prober on a fresh pair of streams and hand both to the test, so
 * the probe and Ink are provably on the same stdin. The caller owns nothing:
 * the app is unmounted whatever the test does.
 */
async function withApp(run: (stdin: FakeStdin, seen: string[]) => Promise<void>): Promise<void> {
	const seen: string[] = [];
	const stdin = makeStdin();
	const app = render(h(Prober, { seen }), {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: makeStdout() as unknown as NodeJS.WriteStream,
		exitOnCtrlC: false,
		// ink's default patches console.log into the ink output, which is the
		// last place a diagnostic should land in this file.
		patchConsole: false,
	});
	try {
		await delay(50);
		await run(stdin, seen);
	} finally {
		app.unmount();
	}
}

describe("Ink on a stream the probe has held", () => {
	test("a key reaches the app before any probe (the baseline this file compares against)", async () => {
		await withApp(async (stdin, seen) => {
			stdin.write("\x1b[A");
			await delay(100);
			expect(seen).toEqual(["UP"]);
		});
	});

	test("a key still reaches the app after the probe let the stream go", async () => {
		await withApp(async (stdin, seen) => {
			const answer = await detectAppearance({
				stdin: stdin as unknown as NodeJS.ReadStream,
				// A separate sink: the probe's escape bytes are not this test's
				// subject, and keeping them out of Ink's output pipe keeps the
				// output side exactly as calm as the baseline test left it.
				stdout: makeStdout() as unknown as NodeJS.WriteStream,
				env: {},
				// Nothing will answer — silence is the normal terminal, and what is
				// being tested is the stream after the probe gives up on it.
				timeoutMs: 40,
			});
			expect(answer).toBe("dark");
			// The probe's own listener is gone, and the next key is the readers'.
			expect(stdin.listenerCount("data")).toBe(0);
			stdin.write("\x1b[B");
			await delay(100);
			expect(seen).toEqual(["DOWN"]);
		});
	});
});

/**
 * The instrument itself. A trace that silently declines to wrap — or wraps
 * when nobody asked — is worse than none: the log a user sends back after
 * "keys do nothing" would be missing exactly the lines that answer it, and
 * nothing would say so.
 */
describe("installStdinTrace", () => {
	test("with the switch unset it leaves the stream untouched", () => {
		const stdin = makeStdin();
		installStdinTrace(stdin as unknown as NodeJS.ReadStream);
		expect(Object.hasOwn(stdin, "on")).toBe(false);
		expect(Object.hasOwn(stdin, "read")).toBe(false);
	});

	test("with a trace file it records reads, listener changes, and the state after each", () => {
		const path = join(tmpdir(), `lbb-trace-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		process.env.LBB_INPUT_TRACE = path;
		try {
			const stdin = makeStdin() as unknown as NodeJS.ReadStream;
			installStdinTrace(stdin);
			const listener = () => {};
			stdin.on("data", listener);
			stdin.resume();
			stdin.pause();
			stdin.off("data", listener);
			const log = readFileSync(path, "utf8");
			expect(log).toContain("[stdin.install]");
			expect(log).toContain("[stdin.on]");
			expect(log).toContain("[stdin.resume]");
			expect(log).toContain("[stdin.pause]");
			expect(log).toContain("[stdin.off]");
			// The state after the call is the point: `flowing` flipping from null
			// through the resume and back is what a deaf-stream log has to show.
			expect(log).toContain('"flowing"');
			expect(log).toContain('"event":"data"');
		} finally {
			delete process.env.LBB_INPUT_TRACE;
			rmSync(path, { force: true });
		}
	});
});
