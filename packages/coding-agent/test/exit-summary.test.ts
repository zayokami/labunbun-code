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
		expect(exitSummaryLine({ sessionId: "abcdef1234567890", messageCount: 4, cliName })).toBe(
			"To resume: labunbun --resume abcdef12",
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
