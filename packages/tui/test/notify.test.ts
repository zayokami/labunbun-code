/**
 * Desktop notifications.
 *
 * Only the pure half is testable: the write goes to the global `process.stdout`,
 * which under a test runner is not a TTY and is not the stream Ink renders to
 * anyway. So what is pinned here is the escape sequence (which terminal gets
 * OSC 9 and which gets a bell) and the coalescing rule that keeps a completion
 * from burying the approval request it followed.
 */
import { describe, expect, test } from "bun:test";
import { BEL, NOTIFY_COALESCE_MS, notificationSequence, OSC9_TERMINALS, shouldNotify } from "../src/notify.ts";

const env = (term: string | undefined): NodeJS.ProcessEnv => (term === undefined ? {} : { TERM_PROGRAM: term });

describe("notificationSequence", () => {
	test("OSC 9 for the terminals that show it as a notification", () => {
		for (const term of OSC9_TERMINALS) {
			expect(notificationSequence("Done", env(term))).toBe("\x1b]9;Done\x07");
		}
	});

	test("a bare bell everywhere else", () => {
		expect(notificationSequence("Done", env("xterm"))).toBe(BEL);
		expect(notificationSequence("Done", env(undefined))).toBe(BEL);
	});

	test("a message cannot end the sequence early and forge a second one", () => {
		const sequence = notificationSequence("Done\x07\x1b]0;pwned", env("Ghostty"));
		// Exactly one terminator, ours — the BEL the message carried is gone.
		expect(sequence.split(BEL)).toHaveLength(2);
		expect(sequence).toBe("\x1b]9;Done ]0;pwned\x07");
	});

	test("nothing to say means nothing sent", () => {
		expect(notificationSequence("\x07\x07", env("Ghostty"))).toBe("");
	});
});

describe("shouldNotify", () => {
	const action = (at: number) => ({ kind: "action" as const, at });
	const complete = (at: number) => ({ kind: "complete" as const, at });

	test("the first notification of a session always goes out", () => {
		expect(shouldNotify("complete", null, 1000)).toBe(true);
	});

	test("a completion right after an approval must not bury it", () => {
		expect(shouldNotify("complete", action(1000), 1100)).toBe(false);
	});

	test("a second approval in the same window is the same alert", () => {
		// The dialog is already on screen and the terminal already rang once;
		// ringing again a second later is noise, not news.
		expect(shouldNotify("action", action(1000), 1100)).toBe(false);
	});

	test("an approval always outranks a completion", () => {
		expect(shouldNotify("action", complete(1000), 1100)).toBe(true);
	});

	test("a second completion in the same window is the same news", () => {
		expect(shouldNotify("complete", complete(1000), 1100)).toBe(false);
	});

	test("past the window everything passes again", () => {
		const after = 1000 + NOTIFY_COALESCE_MS + 1;
		expect(shouldNotify("complete", complete(1000), after)).toBe(true);
		expect(shouldNotify("complete", action(1000), after)).toBe(true);
	});
});
