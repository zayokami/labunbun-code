import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactionBoundary, SessionStore } from "@labunbun/agent";
import { type AgentMessage, assistantMessage, userMessage } from "@labunbun/ai";
import {
	damagedSessionNotice,
	formatMessageCount,
	formatSessionList,
	listSessions,
	loadSessionForResume,
} from "../src/session-resume.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "lbb-continue-startup-"));
	roots.push(home);
	return { home, cwd: home };
}

/** Run the real startup and AgentSession, isolating module mocks from the suite. */
async function startup(
	home: string,
	cwd: string,
	options: { continueLast?: boolean; resumeSessionId?: string },
	env: Record<string, string> = {},
) {
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const requests = [];
		let mountedMessages = null;
		let reason = null;
		const taskCalls = [];
		const catalogCalls = [];
		const entries = [];
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			// Startup asks the providers what they serve. The real one would reach
			// for the network with the key above, which is a thing a test must not do
			// — so it is counted instead, and the count is what says startup asked.
			refreshModelCatalog: async () => { catalogCalls.push("asked"); return JSON.parse(process.env.LBB_STUB_REFRESH ?? "null"); },
			createDefaultStreamFn: () => async function* (_model, context) {
				requests.push(structuredClone(context.messages));
				yield { type: "done", message: ai.assistantMessage({
					content: [{ type: "text", text: "new answer" }], stopReason: "stop"
				}) };
			}
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: ({ session }) => {
				mountedMessages = structuredClone(session.messages);
				return {
					setTasks(tasks) { taskCalls.push(tasks); }, setContextInfo() {}, setBackgroundShells() {},
					store: { set(updater) {
						if (typeof updater !== "function") return;
						for (const entry of updater({ entries: [] }).entries ?? []) entries.push(entry);
					} },
					waitUntilExit: async () => { reason = await session.prompt("new question"); }
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const exitCode = await runInteractive(${JSON.stringify({ ...options, cwd, theme: "dark" })});
		console.log(JSON.stringify({ exitCode, mountedMessages, requests, reason, taskCalls, catalogCalls, entries }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return {
		...(JSON.parse(stdout.trim()) as {
			exitCode: number;
			mountedMessages: AgentMessage[] | null;
			requests: AgentMessage[][];
			reason: string | null;
			taskCalls: Array<Array<{ id: string; subject: string; status: string; activeForm?: string }>>;
			catalogCalls: string[];
			entries: Array<{ kind: string; text?: string }>;
		}),
		stderr,
	};
}

function seed(cwd: string, home: string, label: string) {
	const store = SessionStore.startNew(cwd, home);
	store.appendMessage(userMessage(`${label} question`));
	store.appendMessage(assistantMessage({ content: [{ type: "text", text: `${label} answer` }], stopReason: "stop" }));
	return store;
}

/** Replace one line of a session file with half an entry, the way a partial append would. */
function damageLine(path: string, lineNumber: number): void {
	const lines = readFileSync(path, "utf8").split("\n");
	lines[lineNumber - 1] = '{"id":"half-written","paren';
	writeFileSync(path, lines.join("\n"), "utf8");
}

describe("interactive --continue startup", () => {
	test("restores history before the first provider request and appends to the same store", async () => {
		const { home, cwd } = fixture();
		const store = seed(cwd, home, "old");
		const oldMessages = store.messages();
		const oldLeaf = store.entries.at(-1);
		if (!oldLeaf) throw new Error("expected saved history");

		const result = await startup(home, cwd, { continueLast: true });

		expect(result.exitCode).toBe(0);
		expect(result.reason).toBe("completed");
		expect(result.mountedMessages).toEqual(oldMessages);
		expect(result.requests).toHaveLength(1);
		expect(result.requests[0].slice(0, -1)).toEqual(oldMessages);
		expect(result.requests[0].at(-1)).toMatchObject({ role: "user", content: "new question" });
		const saved = SessionStore.load(store.path);
		expect(SessionStore.listSessions(cwd, home)).toHaveLength(1);
		expect(saved.sessionId).toBe(store.sessionId);
		expect(saved.entries[store.entries.length].parentId).toBe(oldLeaf.id);
		expect(saved.messages().slice(0, -2)).toEqual(oldMessages);
		expect(saved.messages().slice(-2)).toMatchObject([
			{ role: "user", content: "new question" },
			{ role: "assistant", content: [{ type: "text", text: "new answer" }] },
		]);
	}, 30_000);

	test("explicit resume takes priority over the newest session", async () => {
		const { home, cwd } = fixture();
		const chosen = seed(cwd, home, "chosen");
		const newest = seed(cwd, home, "newest");
		utimesSync(chosen.path, 1, 1);
		utimesSync(newest.path, 2, 2);

		const resumeId = chosen.sessionId;
		if (!resumeId) throw new Error("expected a session id");
		const result = await startup(home, cwd, { continueLast: true, resumeSessionId: resumeId });

		expect(result.exitCode).toBe(0);
		expect(result.mountedMessages).toEqual(chosen.messages());
		expect(result.requests).toHaveLength(1);
		expect(result.requests[0].slice(0, -1)).toEqual(chosen.messages());
		expect(SessionStore.load(chosen.path).messages()).toHaveLength(4);
		expect(SessionStore.load(newest.path).messages()).toEqual(newest.messages());
		expect(SessionStore.listSessions(cwd, home)).toHaveLength(2);
	}, 30_000);

	test("with no prior session, starts and persists a fresh conversation", async () => {
		const { home, cwd } = fixture();

		const result = await startup(home, cwd, { continueLast: true });

		expect(result.exitCode).toBe(0);
		expect(result.reason).toBe("completed");
		expect(result.stderr).toContain("No previous session to continue — starting a new one.");
		expect(result.mountedMessages).toEqual([]);
		expect(result.requests).toHaveLength(1);
		expect(result.requests[0]).toMatchObject([{ role: "user", content: "new question" }]);
		const saved = SessionStore.listSessions(cwd, home);
		expect(saved).toHaveLength(1);
		expect(SessionStore.load(saved[0].path).messages()).toHaveLength(2);
	}, 30_000);

	test("continue selects newest in this project and leaves other histories byte-identical", async () => {
		const { home, cwd } = fixture();
		const older = seed(cwd, home, "older");
		const newest = seed(cwd, home, "newest");
		const otherCwd = join(home, "other-project");
		mkdirSync(otherCwd);
		const other = seed(otherCwd, home, "other");
		utimesSync(older.path, 1, 1);
		utimesSync(newest.path, 2, 2);
		utimesSync(other.path, 3, 3);
		const olderBytes = readFileSync(older.path);
		const otherBytes = readFileSync(other.path);
		const result = await startup(home, cwd, { continueLast: true });
		expect(result.exitCode).toBe(0);
		expect(result.mountedMessages).toEqual(newest.messages());
		expect(result.requests[0].slice(0, -1)).toEqual(newest.messages());
		expect(readFileSync(older.path)).toEqual(olderBytes);
		expect(readFileSync(other.path)).toEqual(otherBytes);
		expect(SessionStore.load(newest.path).messages()).toHaveLength(4);
	}, 30_000);

	test("continue restores only the active branch, preserving abandoned entries on disk", async () => {
		const { home, cwd } = fixture();
		const store = seed(cwd, home, "common");
		const fork = store.entries.at(-1);
		if (!fork) throw new Error("missing fork entry");
		store.appendMessage(userMessage("abandoned question"));
		store.appendMessage(assistantMessage({ content: [{ type: "text", text: "abandoned answer" }] }));
		expect(store.branch(fork.id)).toBe(true);
		store.appendMessage(userMessage("active question"));
		store.appendMessage(assistantMessage({ content: [{ type: "text", text: "active answer" }] }));
		store.appendCustom("test-metadata", { marker: "not a model message" });
		const prefix = readFileSync(store.path, "utf8");
		const entries = structuredClone(store.entries);
		const result = await startup(home, cwd, { continueLast: true });
		expect(result.exitCode).toBe(0);
		expect(result.mountedMessages).toEqual(store.messages());
		expect(result.requests[0].slice(0, -1)).toEqual(store.messages());
		expect(JSON.stringify(result.requests)).not.toContain("abandoned");
		expect(JSON.stringify(result.requests)).not.toContain("not a model message");
		const saved = SessionStore.load(store.path);
		expect(saved.entries.slice(0, entries.length)).toEqual(entries);
		expect(readFileSync(store.path, "utf8").startsWith(prefix)).toBe(true);
		expect(saved.entries[entries.length].parentId).toBe(entries[entries.length - 1].id);
	}, 30_000);

	test("continue resumes from the last compaction boundary, not the transcript", async () => {
		const { home, cwd } = fixture();
		const store = seed(cwd, home, "old");
		const suffix = [userMessage("a later question")];
		for (const message of suffix) store.appendMessage(message);
		const boundary = compactionBoundary("1. Primary Request: old question");
		store.appendCompaction({
			boundary,
			suffix,
			summary: "1. Primary Request: old question",
			preservedFiles: [],
			preTokens: 150_000,
			postTokens: 2_000,
			model: "faux-1",
			trigger: "auto",
		});

		const result = await startup(home, cwd, { continueLast: true });

		expect(result.exitCode).toBe(0);
		expect(result.mountedMessages).toEqual([boundary, ...suffix]);
		expect(result.requests[0].slice(0, -1)).toEqual([boundary, ...suffix]);
		// The turn the summary replaced is in the file and in nothing else.
		expect(JSON.stringify(result.requests)).not.toContain("old answer");
		// The new turn lands below the boundary, so the next resume is just as short.
		const saved = SessionStore.load(store.path);
		expect(saved.contextMessages()[0]).toEqual(boundary);
		expect(saved.contextMessages().slice(-2)).toMatchObject([
			{ role: "user", content: "new question" },
			{ role: "assistant", content: [{ type: "text", text: "new answer" }] },
		]);
	}, 30_000);

	test("tool call/result history survives two independent continue startups without duplication", async () => {
		const { home, cwd } = fixture();
		const store = seed(cwd, home, "old");
		store.appendMessage(
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "saved-tool", name: "Read", arguments: '{"file_path":"fixture.txt"}' }],
			}),
		);
		store.appendMessage({
			role: "toolResult",
			toolCallId: "saved-tool",
			toolName: "Read",
			isError: true,
			content: [{ type: "text", text: "file unavailable" }],
			timestamp: 123,
		});
		const first = await startup(home, cwd, { continueLast: true });
		expect(first.exitCode).toBe(0);
		expect(first.requests[0].slice(0, -1)).toEqual(store.messages());
		const once = SessionStore.load(store.path);
		const second = await startup(home, cwd, { continueLast: true });
		expect(second.exitCode).toBe(0);
		expect(second.mountedMessages).toEqual(once.messages());
		expect(second.requests[0].slice(0, -1)).toEqual(once.messages());
		const twice = SessionStore.load(store.path);
		expect(twice.messages()).toHaveLength(store.messages().length + 4);
		expect(twice.messages().filter((m) => m.role === "toolResult")).toHaveLength(1);
		expect(SessionStore.listSessions(cwd, home)).toHaveLength(1);
	}, 30_000);

	test("a header-only latest session is continued rather than replaced", async () => {
		const { home, cwd } = fixture();
		const store = SessionStore.startNew(cwd, home);
		const result = await startup(home, cwd, { continueLast: true });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("No previous session");
		expect(result.mountedMessages).toEqual([]);
		const sessions = SessionStore.listSessions(cwd, home);
		expect(sessions).toHaveLength(1);
		const sessionId = store.sessionId;
		if (!sessionId) throw new Error("expected saved session id");
		expect(sessions[0].sessionId).toBe(sessionId);
		expect(SessionStore.load(store.path).messages()).toHaveLength(2);
	}, 30_000);

	test("ordinary startup does not implicitly continue an existing conversation", async () => {
		const { home, cwd } = fixture();
		const store = seed(cwd, home, "old");
		const before = readFileSync(store.path);
		const result = await startup(home, cwd, {});
		expect(result.exitCode).toBe(0);
		expect(result.mountedMessages).toEqual([]);
		expect(result.requests[0]).toHaveLength(1);
		expect(readFileSync(store.path)).toEqual(before);
		expect(SessionStore.listSessions(cwd, home)).toHaveLength(2);
	}, 30_000);

	test("an unknown explicit resume does not silently continue another session", async () => {
		const { home, cwd } = fixture();
		const existing = seed(cwd, home, "existing");

		const result = await startup(home, cwd, { continueLast: true, resumeSessionId: "missing-session" });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Session not found: missing-session");
		expect(result.mountedMessages).toBeNull();
		expect(result.requests).toEqual([]);
		expect(SessionStore.listSessions(cwd, home)).toHaveLength(1);
		expect(SessionStore.load(existing.path).messages()).toEqual(existing.messages());
	}, 30_000);
});

/**
 * The one question startup asks the network.
 *
 * It is a background nicety — nothing waits for it, and the catalog works
 * without it — which is exactly why it needs an assertion: a call whose failure
 * is invisible is also a call whose absence is invisible.
 */
describe("the catalog refresh at startup", () => {
	test("startup asks each provider what it serves, once", async () => {
		const { home, cwd } = fixture();

		const result = await startup(home, cwd, {});

		expect(result.exitCode).toBe(0);
		expect(result.catalogCalls).toHaveLength(1);
	}, 30_000);

	test("modelDiscovery: false keeps startup off the network", async () => {
		const { home, cwd } = fixture();
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "settings.json"), JSON.stringify({ modelDiscovery: false }));

		const result = await startup(home, cwd, {});

		expect(result.exitCode).toBe(0);
		expect(result.catalogCalls).toEqual([]);
	}, 30_000);

	test("what the refresh changed is said out loud, once the transcript can hold it", async () => {
		const { home, cwd } = fixture();

		const result = await startup(
			home,
			cwd,
			{},
			{
				LBB_STUB_REFRESH: JSON.stringify({
					checked: ["anthropic"],
					dropped: ["anthropic/claude-fable-5"],
					added: [],
				}),
			},
		);

		expect(result.exitCode).toBe(0);
		// The refresh starts before the REPL exists, and `pushInfo` on no handle is
		// a silent no-op — so the answer has to be held until there is a screen.
		expect(result.entries.map((entry) => entry.text)).toContainEqual(
			"Model catalog refreshed: anthropic/claude-fable-5 not listed by the provider any more — hidden from /model, still usable by name.",
		);
	}, 30_000);
});

/**
 * The plan the last run was working from.
 *
 * The task list is the one piece of an agent's state that is neither in the
 * transcript nor in the workspace — restoring the conversation and letting the
 * strip come up empty leaves the model to re-derive what it was in the middle of.
 */
describe("the task list of a continued session", () => {
	test("continue puts the saved tasks back on the strip", async () => {
		const { home, cwd } = fixture();
		const store = seed(cwd, home, "old");
		// Written the way the tools write it — the kind string is on disk, so it is
		// spelled out here rather than imported from the code under test.
		store.appendCustom("tasks", [
			{
				id: "1",
				subject: "Run the suite",
				description: "all of it",
				status: "in_progress",
				blockedBy: [],
				createdAt: 1,
			},
			{
				id: "2",
				subject: "Write it up",
				description: "a summary",
				status: "pending",
				activeForm: "Writing it up",
				blockedBy: ["1"],
				createdAt: 2,
			},
		]);
		const before = readFileSync(store.path);

		const result = await startup(home, cwd, { continueLast: true });

		expect(result.exitCode).toBe(0);
		expect(result.taskCalls.at(-1)).toEqual([
			{ id: "1", subject: "Run the suite", status: "in_progress" },
			{ id: "2", subject: "Write it up", status: "pending", activeForm: "Writing it up" },
		]);
		// Reading the list is not a change to it, so the file does not gain a
		// second copy: what is on disk is still what the previous run wrote.
		expect(readFileSync(store.path).subarray(0, before.length)).toEqual(before);
		expect(SessionStore.load(store.path).entries.filter((e) => e.type === "custom" && e.kind === "tasks")).toHaveLength(
			1,
		);
	}, 30_000);

	test("a session with no tasks starts with an empty strip", async () => {
		const { home, cwd } = fixture();
		seed(cwd, home, "old");

		const result = await startup(home, cwd, { continueLast: true });

		expect(result.exitCode).toBe(0);
		expect(result.taskCalls).toContainEqual([]);
	}, 30_000);
});

/**
 * What the picker pays to draw itself.
 *
 * A row needs a label and a rough size, and the label is in the first user
 * message, which is at the top of the file. Reading whole transcripts to find
 * that out costs the entire project every time the picker opens — and the price
 * grows with the sessions that have the least to do with the one being resumed.
 */
describe("what the picker reads out of a session file", () => {
	test("a session small enough to read whole is counted exactly", () => {
		const { home, cwd } = fixture();
		seed(cwd, home, "old");

		const [summary] = listSessions(cwd, home);
		if (!summary) throw new Error("expected a session");

		expect(summary.firstUserText).toBe("old question");
		expect(summary.truncated).toBe(false);
		expect(formatMessageCount(summary)).toBe("2");
		const listed = formatSessionList(listSessions(cwd, home));
		expect(listed).toContain("(2 msgs)");
		expect(listed).toContain("old question");
	});

	test("a transcript too long to read for a label is counted as a floor", () => {
		const { home, cwd } = fixture();
		const store = SessionStore.startNew(cwd, home);
		store.appendMessage(userMessage("fix the parser"));
		store.appendMessage(
			assistantMessage({ content: [{ type: "text", text: "y".repeat(400_000) }], stopReason: "stop" }),
		);

		const [summary] = listSessions(cwd, home);
		if (!summary) throw new Error("expected a session");

		// The label is the reason to read the head at all, and it is there.
		expect(summary.firstUserText).toBe("fix the parser");
		expect(summary.truncated).toBe(true);
		// The count is what the head holds — the reply is past the cap — so it is
		// marked as a floor rather than passed off as a total.
		expect(summary.messageCount).toBe(1);
		expect(formatMessageCount(summary)).toBe("1+");
		expect(formatSessionList([summary])).toContain("(1+ msgs)");
	});
});

/**
 * A session file that came back shorter than it was written.
 *
 * Reading one is the moment the damage is discovered, and the moment it is most
 * tempting to say nothing: a conversation that is simply shorter looks like a
 * conversation the user is remembering wrong.
 */
describe("a session file that lost a line", () => {
	const conversation = (cwd: string, home: string) => {
		const store = SessionStore.startNew(cwd, home);
		const messages = [
			userMessage("first"),
			assistantMessage({ content: [{ type: "text", text: "first answer" }], stopReason: "stop" }),
			userMessage("second"),
			assistantMessage({ content: [{ type: "text", text: "second answer" }], stopReason: "stop" }),
		];
		for (const message of messages) store.appendMessage(message);
		return { store, messages };
	};

	test("resumes with the messages on both sides of the damage, and says so", () => {
		const { home, cwd } = fixture();
		const { store, messages } = conversation(cwd, home);
		damageLine(store.path, 4); // line 1 is the header

		const loaded = loadSessionForResume(store.path);
		if (!loaded) throw new Error("expected the session to load");

		expect(loaded.messages).toEqual([messages[0], messages[1], messages[3]]);
		// A damaged line costs a message, and nothing was removed on top of it.
		expect(loaded.removed).toBe(0);
		const notice = damagedSessionNotice(loaded.store, loaded.removed);
		expect(notice).toContain("Session file damaged: 1 damaged line");
		expect(notice).toContain(store.path);
		expect(notice).toContain("The rest of the conversation is intact.");
	});

	test("a tool call whose result went with the damaged line is dropped, not sent", () => {
		const { home, cwd } = fixture();
		const store = SessionStore.startNew(cwd, home);
		const request = userMessage("run it");
		store.appendMessage(request);
		store.appendMessage(
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "t1", name: "Read", arguments: '{"file_path":"a.txt"}' }],
			}),
		);
		store.appendMessage({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "Read",
			isError: false,
			content: [{ type: "text", text: "contents" }],
			timestamp: 1,
		});
		damageLine(store.path, 4); // the result's line

		const loaded = loadSessionForResume(store.path);
		if (!loaded) throw new Error("expected the session to load");

		// The call that lost its result is a request the provider rejects, so both
		// halves go — and the message that held it is a message the conversation
		// no longer has.
		expect(loaded.messages).toEqual([request]);
		expect(loaded.removed).toBe(1);
		const notice = damagedSessionNotice(loaded.store, loaded.removed);
		expect(notice).toContain("1 damaged line and 1 message removed with its tool call");
	});

	test("says nothing about a session that came back whole", () => {
		const { home, cwd } = fixture();
		const { store } = conversation(cwd, home);

		const loaded = loadSessionForResume(store.path);
		if (!loaded) throw new Error("expected the session to load");

		expect(loaded.removed).toBe(0);
		expect(damagedSessionNotice(loaded.store, loaded.removed)).toBeUndefined();
		// And a session with no removal is not reported just because it was read
		// through a cap: a fragment is not damage.
		const capped = SessionStore.load(store.path, { maxBytes: 8 });
		expect(damagedSessionNotice(capped, 0)).toBeUndefined();
	});

	test("continue on a damaged file keeps the newest turn and warns", async () => {
		const { home, cwd } = fixture();
		const store = SessionStore.startNew(cwd, home);
		const first = userMessage("old question");
		const newest = userMessage("the newest question");
		store.appendMessage(first);
		store.appendMessage(assistantMessage({ content: [{ type: "text", text: "old answer" }], stopReason: "stop" }));
		store.appendMessage(newest);
		damageLine(store.path, 3); // the answer's line

		const result = await startup(home, cwd, { continueLast: true });

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Session file damaged: 1 damaged line");
		// A reader that stopped at the damaged line would resume with the first
		// question alone; the newest thing the user wrote is still here.
		expect(result.mountedMessages).toEqual([first, newest]);
		expect(result.requests[0]).toEqual([
			first,
			newest,
			{ role: "user", content: "new question", timestamp: expect.any(Number) },
		]);
	}, 30_000);
});
