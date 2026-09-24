/**
 * --continue target resolution and /export serialization — both pure over
 * temp dirs / message arrays.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import type { AgentMessage } from "@labunbun/ai";
import { assistantMessage, userMessage } from "@labunbun/ai";
import { sessionToMarkdown } from "../src/export-session.ts";
import { resolveContinueTarget } from "../src/session-resume.ts";

let home: string;
let cwd: string;

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "lbb-continue-home-"));
	cwd = mkdtempSync(join(tmpdir(), "lbb-continue-cwd-"));
});

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("resolveContinueTarget", () => {
	test("returns null when nothing was ever saved", () => {
		expect(resolveContinueTarget(cwd, home)).toBeNull();
	});

	test("picks the most recently touched session", () => {
		const oldStore = SessionStore.startNew(cwd, home);
		oldStore.appendMessage(userMessage("oldest session"));
		const newStore = SessionStore.startNew(cwd, home);
		newStore.appendMessage(userMessage("newest session"));

		// The two files are written back to back, and the sort that picks the
		// newest is a plain `b.mtimeMs - a.mtimeMs` — so on a filesystem whose
		// clock does not tick between the two writes they tie, and a stable sort
		// hands the decision to `readdirSync`, whose order is not specified. That
		// made this a coin flip rather than a test. Pin the mtimes so the ordering
		// the assertion is about is the ordering that is actually there. (The
		// assertion itself is unchanged; only the fixture it reads is.)
		//
		// The tie itself is deliberately not pinned: whichever file the directory
		// happens to enumerate first wins it, and a test that recorded that would
		// be recording the filesystem rather than the program.
		const now = Date.now() / 1000;
		utimesSync(oldStore.path, now - 120, now - 120);
		utimesSync(newStore.path, now, now);

		const target = resolveContinueTarget(cwd, home);
		if (!target) throw new Error("expected a continue target");
		expect(target.firstUserText).toBe("newest session");
	});

	test("sessions from other projects are invisible", () => {
		const otherCwd = join(cwd, "elsewhere");
		expect(resolveContinueTarget(otherCwd, home)).toBeNull();
	});
});

describe("sessionToMarkdown", () => {
	test("renders user and assistant sections without markup noise", () => {
		const messages: AgentMessage[] = [
			userMessage("fix the bug"),
			assistantMessage({ content: [{ type: "text", text: "Fixed it." }], stopReason: "stop" }),
		];
		const md = sessionToMarkdown(messages);
		expect(md).toContain("## user");
		expect(md).toContain("fix the bug");
		expect(md).toContain("## assistant");
		expect(md).toContain("Fixed it.");
	});

	test("tool calls render as fenced json; results carry the tool name", () => {
		const messages: AgentMessage[] = [
			assistantMessage({
				content: [{ type: "toolCall", id: "c1", name: "Bash", arguments: '{"command":"ls"}' }],
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "Bash",
				content: [{ type: "text", text: "file.txt" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const md = sessionToMarkdown(messages);
		expect(md).toContain("**Tool call: Bash**");
		expect(md).toContain('"command":"ls"');
		expect(md).toContain("## tool result (Bash)");
		expect(md).toContain("file.txt");
	});

	test("an oversized tool result is truncated with a marker", () => {
		const messages: AgentMessage[] = [
			{
				role: "toolResult",
				toolCallId: "c2",
				toolName: "Read",
				content: [{ type: "text", text: "x".repeat(10_000) }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const md = sessionToMarkdown(messages);
		expect(md.length).toBeLessThan(6000);
		expect(md).toContain("[...truncated]");
	});
});
