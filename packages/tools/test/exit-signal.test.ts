/**
 * What a signal-ended command reports as its exit code.
 *
 * Node reports `code: null` when a child is ended by a signal, and the exec
 * path used to read that as zero — a segfaulted or SIGTERMed command told the
 * model it had succeeded. A shell reports 128 plus the signal number there; a
 * `close` that never reported either a code or a signal is an ordinary failure,
 * not a success.
 */
import { describe, expect, test } from "bun:test";
import { signalExitCode } from "../src/operations.ts";

describe("signalExitCode", () => {
	test("a signal-ended child reports 128 plus its signal number", () => {
		expect(signalExitCode("SIGTERM")).toBe(143);
		expect(signalExitCode("SIGSEGV")).toBe(139);
		expect(signalExitCode("SIGKILL")).toBe(137);
	});

	test("no code and no signal is an ordinary failure, never success", () => {
		expect(signalExitCode(null)).toBe(1);
	});
});
