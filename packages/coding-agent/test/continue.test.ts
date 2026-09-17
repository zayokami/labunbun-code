import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { type AgentMessage, assistantMessage, userMessage } from "@labunbun/ai";

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
async function startup(home: string, cwd: string, options: { continueLast?: boolean; resumeSessionId?: string }) {
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const requests = [];
		let mountedMessages = null;
		let reason = null;
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
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
					setTasks() {}, setContextInfo() {},
					store: { set() {} },
					waitUntilExit: async () => { reason = await session.prompt("new question"); }
				};
			}
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const exitCode = await runInteractive(${JSON.stringify({ ...options, cwd, theme: "dark" })});
		console.log(JSON.stringify({ exitCode, mountedMessages, requests, reason }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: home, USERPROFILE: home },
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
