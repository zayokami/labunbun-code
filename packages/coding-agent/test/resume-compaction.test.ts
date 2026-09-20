/**
 * Resuming a session that has been compacted.
 *
 * The session file keeps the transcript a summary replaced — that is the audit
 * trail — but the summary is what stands in for it. Resuming from the file's
 * whole message list would resurrect the context that was written away, at full
 * price, and then summarize it again on the way back down.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactionBoundary, SessionStore } from "@labunbun/agent";
import { assistantMessage, userMessage } from "@labunbun/ai";
import { loadSessionForResume, resolveContinueTarget } from "../src/session-resume.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "lbb-resume-compact-"));
	roots.push(home);
	return { home, cwd: join(home, "project") };
}

/** A session that ran long enough to be compacted, then carried on. */
function compactedSession(home: string, cwd: string) {
	const store = SessionStore.startNew(cwd, home);
	const older = [
		userMessage("the original request"),
		assistantMessage({ content: [{ type: "text", text: "started it" }], stopReason: "stop" }),
	];
	const tail = [userMessage("the current request")];
	const later = assistantMessage({ content: [{ type: "text", text: "kept going" }], stopReason: "stop" });
	for (const message of [...older, ...tail]) store.appendMessage(message);

	const boundary = compactionBoundary("1. Primary Request: the original request");
	store.appendCompaction({
		boundary,
		suffix: tail,
		summary: "1. Primary Request: the original request",
		preservedFiles: [],
		preTokens: 150_000,
		postTokens: 2_000,
		model: "faux-1",
		trigger: "auto",
	});
	store.appendMessage(later);
	return { store, older, tail, boundary, later };
}

describe("resuming a compacted session", () => {
	test("the summary and what followed it, not the transcript it replaced", () => {
		const { home, cwd } = fixture();
		const { store, older, tail, boundary, later } = compactedSession(home, cwd);

		const resumed = loadSessionForResume(store.path);
		if (!resumed) throw new Error("expected the session to load");

		expect(resumed.messages).toEqual([boundary, tail[0], later]);
		// The replaced turn is in neither what is sent nor what is shown.
		expect(resumed.messages).not.toContain(older[1]);
	});

	test("the store comes back positioned at the leaf, so the turn continues", () => {
		const { home, cwd } = fixture();
		const { store, boundary } = compactedSession(home, cwd);

		const resumed = loadSessionForResume(store.path);
		if (!resumed) throw new Error("expected the session to load");
		resumed.store.appendMessage(userMessage("next question"));

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.contextMessages().at(-1)).toMatchObject({ content: "next question" });
		// And what it continues from is still the boundary — the compaction is not
		// undone by having resumed.
		expect(reloaded.contextMessages()[0]).toEqual(boundary);
		expect(reloaded.contextMessages()).toHaveLength(resumed.messages.length + 1);
	});

	test("a session with nothing compacted in it is resumed whole", () => {
		const { home, cwd } = fixture();
		const store = SessionStore.startNew(cwd, home);
		const messages = [
			userMessage("q"),
			assistantMessage({ content: [{ type: "text", text: "a" }], stopReason: "stop" }),
		];
		for (const message of messages) store.appendMessage(message);

		expect(loadSessionForResume(store.path)?.messages).toEqual(messages);
	});

	test("a compacted session is still something to come back to", () => {
		const { home, cwd } = fixture();
		const { store } = compactedSession(home, cwd);

		const sessionId = store.sessionId;
		if (!sessionId) throw new Error("expected a session id");
		const target = resolveContinueTarget(cwd, home);
		expect(target?.sessionId).toBe(sessionId);
		expect(target?.messageCount).toBeGreaterThan(0);
	});

	test("an empty session resumes empty, a file that is not a session is refused", () => {
		const { home, cwd } = fixture();
		// A header and nothing else: resumable, with nothing in it yet.
		const empty = SessionStore.startNew(cwd, home);
		expect(loadSessionForResume(empty.path)?.messages).toEqual([]);
		expect(loadSessionForResume(join(cwd, "nope.jsonl"))).toBeNull();
	});
});
