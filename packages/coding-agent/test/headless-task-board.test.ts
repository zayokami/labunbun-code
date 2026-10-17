/**
 * The task board in a `-p` run.
 *
 * The board tools used to reach only the interactive host, so a scripted run
 * asked to track multi-step work had no way to write the list it was working
 * through — and a resumed run had nothing to read back. What is asserted here is
 * the whole path: the four tools are on the request the model sees, a TaskCreate
 * lands in the session file as the `tasks` snapshot, a resumed run restores it
 * into the tools, and `--no-session` keeps the same board in memory without
 * writing a file.
 *
 * The transport is scripted, so there is no network, no key and nothing billed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { fauxProvider } from "@labunbun/ai";
import { TASK_BOARD_TOOL_NAMES } from "@labunbun/tools";
import { runHeadless } from "../src/headless.ts";
import { readTaskSnapshot } from "../src/task-snapshot.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
	home: string;
	cwd: string;
}

function fixture(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "lbb-headless-board-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-headless-board-cwd-"));
	roots.push(home, cwd);
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	return { home, cwd };
}

interface RunOptions {
	noSession?: boolean;
	resumeSessionId?: string;
}

/** One run with a captured stdout, so the JSON result does not print into the test log. */
async function run(
	f: Fixture,
	streamFn: ReturnType<typeof fauxProvider>["streamFn"],
	options: RunOptions = {},
): Promise<{ code: number; stdout: string }> {
	const chunks: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		const code = await runHeadless({
			prompt: "track the work",
			modelRef: "anthropic/claude-haiku-4-5",
			cwd: f.cwd,
			noSession: options.noSession ?? false,
			resumeSessionId: options.resumeSessionId,
			outputFormat: "json",
			streamFn,
			home: f.home,
		});
		return { code, stdout: chunks.join("") };
	} finally {
		process.stdout.write = write;
	}
}

/** The newest session the run saved. */
function sessionFor(f: Fixture): SessionStore {
	const sessions = SessionStore.listSessions(f.cwd, f.home);
	expect(sessions.length).toBeGreaterThan(0);
	return SessionStore.load(sessions[0]?.path ?? "");
}

describe("a `-p` run's task board", () => {
	test("exposes the four tools, writes the list to the session file, and restores it on resume", async () => {
		const f = fixture();
		const first = fauxProvider([
			{
				toolCalls: [
					{
						id: "call-1",
						name: "TaskCreate",
						arguments: { subject: "Run the suite", description: "bun test before pushing" },
					},
				],
			},
			{ text: "created" },
		]);

		const { code } = await run(f, first.streamFn);
		expect(code).toBe(0);

		// The registry the model was actually sent: not the intent to add tools, but
		// the wire list every board call has to appear in.
		const advertised = (first.receivedContexts[0]?.tools ?? []).map((tool) => tool.name);
		for (const name of TASK_BOARD_TOOL_NAMES) expect(advertised).toContain(name);

		// The list survives the process by living in the session file as a `custom`
		// entry — the same kind the REPL writes, so either host can resume the other.
		const store = sessionFor(f);
		const entries = readFileSync(store.path, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { type?: string; kind?: string; data?: unknown });
		const snapshotEntry = entries.find((entry) => entry.type === "custom" && entry.kind === "tasks");
		expect((snapshotEntry?.data as Array<{ subject?: string }> | undefined)?.[0]?.subject).toBe("Run the suite");
		expect(readTaskSnapshot(store)?.map((task) => task.subject)).toEqual(["Run the suite"]);

		// A resumed run restores that list before the model's first request, so a
		// TaskList call answers from the plan the previous process left behind.
		const second = fauxProvider([
			{ toolCalls: [{ id: "call-2", name: "TaskList", arguments: {} }] },
			{ text: "listed" },
		]);
		const resumed = await run(f, second.streamFn, { resumeSessionId: store.sessionId ?? "" });
		expect(resumed.code).toBe(0);
		const restoredNames = (second.receivedContexts[0]?.tools ?? []).map((tool) => tool.name);
		for (const name of TASK_BOARD_TOOL_NAMES) expect(restoredNames).toContain(name);
		// The result the model was handed, not merely the store: restoration that
		// never reaches the tools is a list nobody can read.
		expect(JSON.stringify(second.receivedContexts.at(-1)?.messages)).toContain("Run the suite");
	}, 30_000);

	test("compaction puts the list back below the boundary a restart reads", async () => {
		// The boundary a pass hangs off the chain's root takes every snapshot above
		// it out of the walk a resume uses — including the one this turn's own
		// TaskCreate wrote. Without the re-save at `done`, the newest session would
		// resume with an empty board.
		const f = fixture();
		const faux = fauxProvider([
			{
				toolCalls: [
					{
						id: "call-1",
						name: "TaskCreate",
						arguments: { subject: "Survive the summary", description: "put back after the boundary" },
					},
				],
			},
			{
				stopReason: "error",
				errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
				errorKind: "context_overflow",
			},
			{ text: "<summary>1. Primary Request: track the work</summary>" },
			{ text: "done" },
		]);

		const { code } = await run(f, faux.streamFn);
		expect(code).toBe(0);

		const store = sessionFor(f);
		expect(readTaskSnapshot(store)?.map((task) => task.subject)).toEqual(["Survive the summary"]);
		// The re-save is appended after the boundary, not merely present somewhere
		// above it: the entry order is what makes the snapshot the active chain's.
		const entries = readFileSync(store.path, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { type?: string; kind?: string });
		const boundary = entries.findIndex((entry) => entry.type === "compaction");
		const lastSnapshot = entries.map((entry) => entry.type === "custom" && entry.kind === "tasks").lastIndexOf(true);
		expect(boundary).toBeGreaterThanOrEqual(0);
		expect(lastSnapshot).toBeGreaterThan(boundary);
	}, 30_000);

	test("`--no-session` keeps the board in memory and writes nothing", async () => {
		const f = fixture();
		const faux = fauxProvider([
			{
				toolCalls: [
					{
						id: "call-1",
						name: "TaskCreate",
						arguments: { subject: "In memory only", description: "there is no file to keep this" },
					},
				],
			},
			{ text: "done" },
		]);

		const { code } = await run(f, faux.streamFn, { noSession: true });
		expect(code).toBe(0);

		// The tools exist without a store; only the persistence is absent.
		const advertised = (faux.receivedContexts[0]?.tools ?? []).map((tool) => tool.name);
		for (const name of TASK_BOARD_TOOL_NAMES) expect(advertised).toContain(name);
		// The call ran and its answer went back to the model, so the board worked.
		expect(JSON.stringify(faux.receivedContexts.at(-1)?.messages)).toContain("Created task #1: In memory only");
		// And nothing was written: no session file exists to resume from.
		expect(SessionStore.listSessions(f.cwd, f.home)).toEqual([]);
	}, 30_000);
});
