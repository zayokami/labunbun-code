/**
 * Where output goes when it outgrows the conversation.
 *
 * Real shells and real files: the claims are that a command's whole output is
 * on disk when the result stops carrying it, that the result itself is a head,
 * a tail, and an honest count, and that output inside the bound leaves no
 * trace behind. A pointer no test ever follows is how a tool ends up promising
 * a file that is not there.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BackgroundShellManager,
	ChildProcessExecOperations,
	createBashTool,
	createGlobTool,
	createLsTool,
	defaultOperations,
} from "../src/index.ts";

const BIG = 100_000;

/** A one-liner that prints `BIG` characters of `x` to one stream, via this runtime. */
const bigOutput = (stream: "stdout" | "stderr") =>
	`"${process.execPath}" -e "process.${stream}.write('x'.repeat(${BIG}))"`;

/** The same, and then outlives any wait a test gives it. */
const bigOutputThenWait = `"${process.execPath}" -e "process.stdout.write('x'.repeat(${BIG})); setTimeout(() => {}, 60000)"`;

/** A flat directory of `n` files, named so alphabetical order is numeric order. */
function fillFlat(dir: string, n: number): void {
	for (let i = 0; i < n; i++) writeFileSync(join(dir, `file-${String(i).padStart(3, "0")}.txt`), "");
}

function tempDir(tag: string): string {
	return mkdtempSync(join(tmpdir(), `lbb-${tag}-`));
}

/**
 * One context for every call here: `danger-full-access` keeps each platform's
 * spawn the bare shell with no wrapper between the test and it, and Glob and
 * LS read two of these fields and ignore the rest.
 */
const toolCtx = (cwd: string) => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd,
	sandbox: "danger-full-access" as const,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
});

function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { text: string }).text;
}

describe("exec capture", () => {
	test("output past the bound is on disk in full, and the result is a window plus a count", async () => {
		const dir = tempDir("spill");
		const spillDir = join(dir, "spill");
		const ops = new ChildProcessExecOperations();

		const result = await ops.exec({ command: bigOutput("stdout"), cwd: dir, timeoutMs: 60_000, spillDir });

		if (!result.spill) throw new Error("no spill was reported for an output past the bound");
		expect(result.spill.chars).toBe(BIG);
		expect(result.spill.path.startsWith(spillDir)).toBe(true);
		// Everything the command printed, in the order it printed it — for one
		// stream that order is the stream itself.
		expect(readFileSync(result.spill.path, "utf8")).toBe("x".repeat(BIG));

		expect(result.stdout.startsWith("x".repeat(30_000))).toBe(true);
		expect(result.stdout.endsWith("x".repeat(30_000))).toBe(true);
		expect(result.stdout).toContain("... [truncated 40000 chars of output]");
	}, 60_000);

	test("a second stream crosses its own bound the same way", async () => {
		const dir = tempDir("spill");
		const spillDir = join(dir, "spill");
		const ops = new ChildProcessExecOperations();

		const result = await ops.exec({ command: bigOutput("stderr"), cwd: dir, timeoutMs: 60_000, spillDir });

		if (!result.spill) throw new Error("no spill was reported for an output past the bound");
		expect(readFileSync(result.spill.path, "utf8")).toBe("x".repeat(BIG));
		expect(result.stderr).toContain("... [truncated 40000 chars of output]");
		expect(result.stdout).toBe("");
	}, 60_000);

	test("both streams fitting their windows leaves no file behind", async () => {
		const dir = tempDir("spill");
		const spillDir = join(dir, "spill");
		// 40k + 40k: past the combined capture's bound, inside each stream's own —
		// the text is whole, so a file for it would be an orphan nobody asked for.
		const command = `"${process.execPath}" -e "process.stdout.write('a'.repeat(40000)); process.stderr.write('b'.repeat(40000))"`;

		const result = await new ChildProcessExecOperations().exec({ command, cwd: dir, timeoutMs: 60_000, spillDir });

		expect(result.spill).toBeUndefined();
		expect(result.stdout).toBe("a".repeat(40_000));
		expect(result.stderr).toBe("b".repeat(40_000));
		expect(existsSync(spillDir) ? readdirSync(spillDir) : []).toEqual([]);
	}, 60_000);

	test("output inside the bound writes nothing at all, not even the directory", async () => {
		const dir = tempDir("spill");
		const spillDir = join(dir, "spill");

		const result = await new ChildProcessExecOperations().exec({
			command: "echo small",
			cwd: dir,
			timeoutMs: 60_000,
			spillDir,
		});

		expect(result.spill).toBeUndefined();
		expect(result.stdout).toContain("small");
		expect(existsSync(spillDir)).toBe(false);
	}, 60_000);

	test("a command killed at its timeout still gets its output written out", async () => {
		const dir = tempDir("spill");
		const spillDir = join(dir, "spill");

		// The budget is deliberately much larger than the print needs: the claim is
		// about a killed command's output being on disk, and a budget that raced the
		// print would fail for bun's startup time instead.
		const result = await new ChildProcessExecOperations().exec({
			command: bigOutputThenWait,
			cwd: dir,
			timeoutMs: 3_000,
			spillDir,
		});

		expect(result.killed).toBe(true);
		expect(result.exitCode).toBe(124);
		if (!result.spill) throw new Error("a killed command's output was not written out");
		expect(readFileSync(result.spill.path, "utf8").length).toBe(BIG);
	}, 60_000);
});

describe("the Bash tool's pointer", () => {
	test("a long result opens with the pointer, the verdict right behind it", async () => {
		const cwd = tempDir("spill");
		const spillDir = join(cwd, "out", "spill"); // nested: created on the first spill
		const tool = createBashTool(cwd, defaultOperations(), undefined, { spillDir });

		const result = await tool.call({ command: bigOutput("stdout") }, toolCtx(cwd));
		const text = textOf(result);

		const header = /^\[full output: (\d+) chars → (.+)\]\n/.exec(text);
		const path = header?.[2];
		if (!header || !path) throw new Error(`no spill header leads the result: ${text.slice(0, 300)}`);
		expect(Number(header[1])).toBe(BIG);
		expect(readFileSync(path, "utf8")).toBe("x".repeat(BIG));
		expect(text).toContain("\n[exit code: 0]\n");
		expect(text).toContain("... [truncated 40000 chars of output]");
	}, 60_000);

	test("a result inside the bound carries no pointer", async () => {
		const cwd = tempDir("spill");
		const spillDir = join(cwd, "spill");
		const tool = createBashTool(cwd, defaultOperations(), undefined, { spillDir });

		const result = await tool.call({ command: "echo small" }, toolCtx(cwd));
		const text = textOf(result);

		expect(text.startsWith("[exit code: 0]\n")).toBe(true);
		expect(text).not.toContain("full output:");
		expect(existsSync(spillDir)).toBe(false);
	}, 60_000);

	test("a command handed to the background names the file its output already went to", async () => {
		const cwd = tempDir("spill");
		const spillDir = join(cwd, "spill");
		const manager = new BackgroundShellManager();
		const tool = createBashTool(cwd, defaultOperations(), manager, { spillDir });

		const result = await tool.call({ command: bigOutputThenWait, timeout: 3_000 }, toolCtx(cwd));
		const text = textOf(result);
		expect(text).toContain("moved to the background");

		const path = /Output before the handoff: (.+)\n/.exec(text)?.[1];
		if (!path) throw new Error(`the handoff names no file: ${text.slice(0, 300)}`);
		expect(readFileSync(path, "utf8").length).toBe(BIG);

		// The adopter's log opens with the bounded capture, so the log holds a
		// window and a pointer, not the whole stream — a background shell must not
		// be the way around the bound.
		const id = /shell_\d+/.exec(text)?.[0];
		if (!id) throw new Error(`the result names no shell id: ${text.slice(0, 300)}`);
		const log = manager.output(id);
		expect(log).toContain("[log tail:");
		const bytes = Number(/of (\d+) bytes/.exec(log)?.[1]);
		expect(bytes).toBeGreaterThan(60_000);
		expect(bytes).toBeLessThan(BIG);

		manager.kill(id);
	}, 60_000);
});

describe("the Glob list past its cap", () => {
	test("the cut list is on disk, and the last line points at it", async () => {
		const dir = tempDir("globcap");
		fillFlat(dir, 250);
		const spillDir = join(dir, ".spill");
		const tool = createGlobTool(dir, defaultOperations(), { spillDir });

		const result = await tool.call({ pattern: "*.txt" }, toolCtx(dir));
		const text = textOf(result);

		const pointer = /\[\+50 more → (.+)\]$/.exec(text)?.[1];
		if (!pointer) throw new Error(`no pointer at the end of the list: ${text.slice(-300)}`);
		expect(text.split("\n")).toHaveLength(201); // 200 shown, then the pointer line
		const listed = readFileSync(pointer, "utf8").split("\n");
		expect(listed).toHaveLength(250);
		for (const line of listed) expect(line.endsWith(".txt")).toBe(true);
	}, 60_000);

	test("with nowhere to spill, the count stands alone", async () => {
		const dir = tempDir("globcap");
		fillFlat(dir, 250);
		const tool = createGlobTool(dir, defaultOperations());

		const result = await tool.call({ pattern: "*.txt" }, toolCtx(dir));
		const text = textOf(result);

		expect(text.endsWith("\n[+50 more]")).toBe(true);
		expect(text).not.toContain("more →");
	}, 60_000);
});

describe("the LS listing past its cap", () => {
	test("a listing past the cap shows the alphabetical head and counts the rest", async () => {
		const dir = tempDir("lscap");
		fillFlat(dir, 250);
		const tool = createLsTool(dir, defaultOperations());

		const result = await tool.call({ path: dir }, toolCtx(dir));
		const text = textOf(result);

		expect(text.endsWith("\n[+50 more entries]")).toBe(true);
		expect(text.split("\n")).toHaveLength(201);
		expect(text).toContain("file-000.txt");
		expect(text).toContain("file-199.txt");
		expect(text).not.toContain("file-200.txt");
	}, 60_000);

	test("a listing that fits carries no notice", async () => {
		const dir = tempDir("lscap");
		fillFlat(dir, 3);
		const tool = createLsTool(dir, defaultOperations());

		const result = await tool.call({ path: dir }, toolCtx(dir));
		expect(textOf(result)).not.toContain("more entries");
	}, 60_000);
});
