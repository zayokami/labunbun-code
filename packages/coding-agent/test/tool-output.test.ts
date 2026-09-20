/**
 * Spilled tool output: the file a cut result points at, and the policy that
 * stops those files accumulating forever.
 *
 * Every path here comes from a temp home. A test that forgot one would leave
 * tool-output directories in the operator's own `~/.labunbun/projects`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutText } from "@labunbun/agent";
import { createAllTools, defaultOperations } from "@labunbun/tools";
import { pruneToolOutput, toolOutputDir, toolOutputRoot, writeToolOutput } from "../src/tool-output.ts";

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "lbb-spill-home-"));
}

const REQUEST = { callId: "call_1", toolName: "Bash", text: "the whole build log" };

describe("writeToolOutput", () => {
	test("writes the text under the project, the session, and the call", () => {
		const home = tempHome();
		const path = writeToolOutput(REQUEST, { cwd: "/work/project", sessionId: "s1", home });
		expect(path).toBe(join(toolOutputDir("/work/project", "s1", home), "Bash-call_1.txt"));
		expect(readFileSync(path as string, "utf8")).toBe("the whole build log");
	});

	test("a run with no session still has somewhere to put it", () => {
		const home = tempHome();
		const path = writeToolOutput(REQUEST, { cwd: "/work/project", sessionId: undefined, home });
		expect(path).toContain(join("tool-output", "unassigned"));
		expect(existsSync(path as string)).toBe(true);
	});

	test("a call id that is not a file name cannot escape the directory", () => {
		const home = tempHome();
		const path = writeToolOutput(
			{ ...REQUEST, callId: "../../../etc/passwd" },
			{ cwd: "/work/project", sessionId: "s1", home },
		);
		expect(path?.startsWith(toolOutputDir("/work/project", "s1", home))).toBe(true);
		expect(path).not.toContain("..");
	});

	test("an unwritable destination returns null instead of throwing", () => {
		// The contract the agent's cutText relies on: a failed spill costs the
		// full text, and never the tool call it belonged to.
		const home = tempHome();
		const blocked = toolOutputRoot("/work/project", home);
		mkdirSync(blocked, { recursive: true });
		// A *file* where the session directory goes: mkdir must fail.
		writeFileSync(join(blocked, "s1"), "in the way");
		expect(writeToolOutput(REQUEST, { cwd: "/work/project", sessionId: "s1", home })).toBeNull();
	});
});

describe("pruneToolOutput", () => {
	function spillAged(home: string, sessionId: string, name: string, ageMs: number): string {
		const path = writeToolOutput({ ...REQUEST, callId: name }, { cwd: "/work/project", sessionId, home });
		if (!path) throw new Error("fixture failed to spill");
		const when = new Date(Date.now() - ageMs);
		utimesSync(path, when, when);
		return path;
	}

	const DAY = 24 * 60 * 60 * 1000;

	test("removes files past the retention window and keeps the rest", () => {
		const home = tempHome();
		const old = spillAged(home, "s1", "old", 8 * DAY);
		const fresh = spillAged(home, "s1", "fresh", 1 * DAY);

		const removed = pruneToolOutput("/work/project", { home });

		expect(removed).toEqual([old]);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	test("another project's output is not this project's business", () => {
		const home = tempHome();
		const theirs = spillAged(home, "s1", "old", 8 * DAY);
		// Same home, different workspace.
		const other = writeToolOutput(REQUEST, { cwd: "/work/elsewhere", sessionId: "s1", home });
		if (!other) throw new Error("fixture failed to spill");
		utimesSync(other, new Date(Date.now() - 8 * DAY), new Date(Date.now() - 8 * DAY));

		// A different cwd prunes a different directory, and its own files only.
		expect(pruneToolOutput("/work/elsewhere", { home })).toEqual([other]);
		expect(existsSync(other)).toBe(false);
		// The pruning above only ran for /work/project, so this one is untouched —
		// which is also what says the two do not share a directory.
		expect(existsSync(theirs)).toBe(true);
	});

	test("an emptied session directory goes with its files", () => {
		const home = tempHome();
		const dir = toolOutputDir("/work/project", "s1", home);
		spillAged(home, "s1", "old", 8 * DAY);
		pruneToolOutput("/work/project", { home });
		expect(existsSync(dir)).toBe(false);
	});

	test("nothing to prune is not an error", () => {
		expect(pruneToolOutput("/work/never-used", { home: tempHome() })).toEqual([]);
	});
});

describe("a spilled result, end to end through the real tools", () => {
	test("Bash output too large to show is readable at the path the result names", async () => {
		// The whole point of spilling: the model gets a cut result, and following
		// the path in it has to work — through the containment guard, with the
		// same tools the app builds.
		const cwd = mkdtempSync(join(tmpdir(), "lbb-spill-cwd-"));
		const home = tempHome();
		const dir = toolOutputDir(cwd, "s1", home);
		rmSync(dir, { recursive: true, force: true });
		const tools = createAllTools(cwd, {
			operations: defaultOperations(),
			readOnlyRoots: [toolOutputRoot(cwd, home)],
		});

		// Long enough that a head-only cut would lose the last line, which is where
		// a build says what went wrong.
		const full = Array.from({ length: 4_000 }, (_, i) => `line ${i + 1} ${"y".repeat(20)}`).join("\n");
		const request = { callId: "call_1", toolName: "Bash", text: "" };
		const cut = cutText(full, 30_000, (r) => writeToolOutput(r, { cwd, sessionId: "s1", home }), request);
		const path = /\[full output: \d+ chars → ([^\]]+)\]/.exec(cut)?.[1];
		expect(path).toBeTruthy();
		expect(cut).toContain("truncated");
		expect(cut.length).toBeLessThan(31_000);
		// What the model sees stops early...
		expect(cut).not.toContain("line 4000");

		const read = tools.find((tool) => tool.name === "Read");
		const readFrom = (input: unknown) =>
			read?.call(input, { callId: "call_2", signal: new AbortController().signal, cwd, onUpdate: () => {} });

		// ...and the last line is still there to be asked for, through the guard
		// that would otherwise refuse a path outside the workspace.
		const tail = await readFrom({ file_path: path, offset: 3_900 });
		const text = (tail?.content[0] as { text?: string } | undefined)?.text ?? "";
		expect(tail?.isError).toBeUndefined();
		expect(text).toContain("line 4000");
	});

	test("a real command's output is cut by the pipeline, and the file holds what it cut", async () => {
		// The test above hands `cutText` the text it wants to see cut. This one runs
		// a command that really prints more than the model may read, through the
		// shell the app itself resolves, and follows the path the result names.
		const cwd = mkdtempSync(join(tmpdir(), "lbb-spill-cwd-"));
		const home = tempHome();
		const tools = createAllTools(cwd, {
			operations: defaultOperations(),
			readOnlyRoots: [toolOutputRoot(cwd, home)],
		});
		const bash = tools.find((tool) => tool.name === "Bash");
		if (!bash) throw new Error("the default tool set has no Bash tool");

		// Where a build says what went wrong: the end. A tool that had cut its own
		// output to the pipeline's limit would have thrown this line away before
		// anything could spill it.
		const last = "FAILED: expected 2, got 3";
		const script = join(cwd, "noisy.js");
		writeFileSync(
			script,
			`const line = "x".repeat(120);\n` +
				`for (let i = 1; i <= 400; i++) console.log("line " + i + " " + line);\n` +
				`console.log(${JSON.stringify(last)});\n`,
		);
		// Slashes forward, script relative: the same line has to survive whichever
		// shell this machine resolves, and a POSIX one eats the backslashes of a
		// Windows path before the command it belongs to ever runs.
		const result = await bash.call(
			{ command: `${process.execPath.replace(/\\/g, "/")} noisy.js` },
			{ callId: "call_1", signal: new AbortController().signal, cwd, onUpdate: () => {} },
		);
		const shown = (result.content[0] as { text: string }).text;

		const limit = bash.maxResultSizeChars ?? 0;
		expect(limit).toBeGreaterThan(0);
		// The tool hands the whole log on...
		expect(shown.length).toBeGreaterThan(limit * 1.5);
		expect(shown).toContain(last);
		expect(shown.startsWith("[exit code: 0]\n")).toBe(true);

		// ...and what the conversation gets is the pipeline's cut of it, written out
		// in full first. Same call the pipeline makes for a tool that declared
		// `overflow: "spill"` (agent/src/pipeline.ts, `bound`).
		const bounded = cutText(shown, limit, (request) => writeToolOutput(request, { cwd, sessionId: "s1", home }), {
			callId: "call_1",
			toolName: "Bash",
			text: "",
		});
		expect(bounded.length).toBeLessThan(limit + 100);
		expect(bounded).not.toContain(last);
		const path = /\[full output: \d+ chars → ([^\]]+)\]/.exec(bounded)?.[1];
		expect(path).toBeTruthy();
		expect(readFileSync(path as string, "utf8")).toContain(last);
		expect(readFileSync(path as string, "utf8")).toContain("line 400 ");

		// And the tail of it is reachable through the tools the model is given.
		const read = tools.find((tool) => tool.name === "Read");
		const tail = await read?.call(
			{ file_path: path, offset: 401 },
			{ callId: "call_2", signal: new AbortController().signal, cwd, onUpdate: () => {} },
		);
		expect((tail?.content[0] as { text?: string } | undefined)?.text).toContain(last);
	}, 30_000);
});
