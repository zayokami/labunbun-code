/**
 * The line printed after the TUI unmounts.
 *
 * It is the only thing left on screen once the session ends, so it has to be
 * either useful or absent: telling someone to resume a session that saved
 * nothing would send them to an error message.
 */
import { describe, expect, test } from "bun:test";
import { exitSummaryLine } from "../src/session-resume.ts";

const cliName = "labunbun";

describe("exitSummaryLine", () => {
	test("names the command that brings the session back", () => {
		// Real ids are an ISO timestamp plus a random suffix. The leading
		// characters are "2026-10-" for every session this month, and the
		// printed command is fed back to a substring lookup — so slicing the
		// front off put the wrong session (or an empty one) behind the token
		// the banner promised. The suffix is the part that names this session.
		expect(exitSummaryLine({ sessionId: "2026-10-09T03-09-00-707Z_941f8ca1", messageCount: 4, cliName })).toBe(
			"To resume: labunbun --resume 941f8ca1",
		);
	});

	test("a short id is printed whole rather than sliced to nothing", () => {
		expect(exitSummaryLine({ sessionId: "abc", messageCount: 1, cliName })).toBe("To resume: labunbun --resume abc");
	});

	test("nothing worth resuming means nothing said", () => {
		expect(exitSummaryLine({ sessionId: undefined, messageCount: 4, cliName })).toBeNull();
		expect(exitSummaryLine({ sessionId: "abc", messageCount: 0, cliName })).toBeNull();
	});
});
