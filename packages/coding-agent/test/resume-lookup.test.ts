/**
 * The token in "To resume: ... --resume <token>" has to come back to the
 * session it names.
 *
 * Real session ids start with an ISO timestamp, so the leading eight
 * characters are the year and month — identical for every session started in
 * the same month. The exit banner printed exactly those, and the lookup found
 * matches by substring: `--resume 2026-10-` resolved to whichever October
 * session was touched most recently, which on a machine where a process had
 * just been launched and exited is an empty header-only session. The printed
 * conversation was not the one that came back. The token is the random suffix
 * now; this file pins the round trip and the lookup it depends on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { userMessage } from "@labunbun/ai";
import { exitSummaryLine, findSession, listSessions, shortSessionId } from "../src/session-resume.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTemp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function resumeToken(line: string): string {
	const match = /--resume (\S+)$/.exec(line);
	if (!match?.[1]) throw new Error(`no resume token in: ${line}`);
	return match[1];
}

describe("the printed --resume token", () => {
	test("round-trips to the session it names even when a newer empty session shares the date prefix", () => {
		const home = makeTemp("lbb-resume-lookup-home-");
		const cwd = makeTemp("lbb-resume-lookup-cwd-");
		const conversation = SessionStore.startNew(cwd, home);
		conversation.appendMessage(userMessage("the conversation worth resuming"));
		const conversationId = conversation.sessionId;
		if (!conversationId) throw new Error("expected a session id");
		// The one that used to win: started later, never spoken in.
		const empty = SessionStore.startNew(cwd, home);
		const now = Date.now() / 1000;
		utimesSync(conversation.path, now - 60, now - 60);
		utimesSync(empty.path, now, now);

		const line = exitSummaryLine({ sessionId: conversationId, messageCount: 3, cliName: "labunbun" });
		if (!line) throw new Error("expected a resume line");
		const token = resumeToken(line);
		expect(token).toBe(shortSessionId(conversationId));

		expect(findSession(listSessions(cwd, home), token)?.sessionId).toBe(conversationId);
	});
});

describe("findSession", () => {
	test("an exact id beats a substring match on an earlier entry", () => {
		// The lookup is exact-then-substring, in that order, and both matches
		// exist here: a bare includes() would take the first row.
		const sessions = [{ sessionId: "2026-10-09T00-00-00-000Z_941f8ca1" }, { sessionId: "941f8ca1" }];
		expect(findSession(sessions, "941f8ca1")?.sessionId).toBe("941f8ca1");
	});

	test("a prefix still resolves by substring", () => {
		const sessions = [{ sessionId: "2026-10-09T00-00-00-000Z_941f8ca1" }];
		expect(findSession(sessions, "2026-10-09")?.sessionId).toBe("2026-10-09T00-00-00-000Z_941f8ca1");
	});

	test("an empty token finds nothing rather than everything", () => {
		// includes("") is true for every session, so an empty --resume value
		// would otherwise resume the newest file and call it a match.
		expect(findSession([{ sessionId: "abc" }], "")).toBeUndefined();
	});

	test("no match is undefined", () => {
		expect(findSession([{ sessionId: "abc" }], "zzz")).toBeUndefined();
	});
});
