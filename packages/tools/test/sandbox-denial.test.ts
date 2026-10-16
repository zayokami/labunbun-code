/**
 * The denial read is a heuristic, so the rows are about the shape it agrees
 * to and the guesses it refuses to make: only a run a kernel backend confined
 * can be refused *by* the sandbox, a clean exit is never a denial, and the
 * keywords are read from either stream without regard to case.
 */
import { describe, expect, test } from "bun:test";
import { likelySandboxDenied } from "../src/sandbox-denial.ts";

const facts = (exitCode: number | null, stdout = "", stderr = "") => ({ exitCode, stdout, stderr });

describe("likelySandboxDenied", () => {
	test("a run no kernel backend confined is never a sandbox denial", () => {
		expect(likelySandboxDenied(facts(1, "", "Permission denied"), undefined)).toBe(false);
		expect(likelySandboxDenied(facts(1, "", "Permission denied"), "simulated")).toBe(false);
		expect(likelySandboxDenied(facts(1, "", "Permission denied"), "unavailable")).toBe(false);
	});

	test("a clean exit is never a denial, whatever the output says", () => {
		expect(likelySandboxDenied(facts(0, "", "Operation not permitted"), "native")).toBe(false);
		expect(likelySandboxDenied(facts(0, "the sandbox tests passed"), "appcontainer")).toBe(false);
	});

	test("a command that never ended is never a denial", () => {
		expect(likelySandboxDenied(facts(null, "", "permission denied"), "native")).toBe(false);
	});

	const keywords = [
		"touch: cannot touch 'x': Operation not permitted",
		"bash: /etc/x: Permission denied",
		"mkdir: cannot create directory: Read-only file system",
		"the seccomp filter refused the call",
		"the sandbox said no",
		"landlock: access denied",
		"failed to write file: x.txt",
		"Access is denied.",
	];
	for (const text of keywords) {
		test(`"${text}" counts in either stream`, () => {
			expect(likelySandboxDenied(facts(1, "", text), "native")).toBe(true);
			expect(likelySandboxDenied(facts(1, text, ""), "appcontainer")).toBe(true);
		});
	}

	test("case does not matter", () => {
		expect(likelySandboxDenied(facts(1, "", "PERMISSION DENIED"), "native")).toBe(true);
	});

	test("a bare quick-reject code stays a shell fact, not a denial", () => {
		expect(likelySandboxDenied(facts(127, "", "bash: foo: command not found"), "native")).toBe(false);
		expect(likelySandboxDenied(facts(126, "", "bash: ./x: cannot execute"), "native")).toBe(false);
		expect(likelySandboxDenied(facts(2, "", "bash: -c: option requires an argument"), "native")).toBe(false);
	});

	test("a quick-reject code carrying a refusal word counts", () => {
		expect(likelySandboxDenied(facts(126, "", "bash: /usr/bin/x: Permission denied"), "native")).toBe(true);
	});

	test("SIGSYS is read per platform, because the number is the platform's", () => {
		// 159 is 128+31: SIGSYS on Linux. 140 is 128+12: SIGSYS on macOS, and
		// SIGUSR2 on Linux — the mirror image holds for 159 on macOS. Only the
		// platform's own spelling of the signal counts.
		expect(likelySandboxDenied(facts(159), "native", "linux")).toBe(true);
		expect(likelySandboxDenied(facts(140), "native", "darwin")).toBe(true);
		expect(likelySandboxDenied(facts(140), "native", "linux")).toBe(false);
		expect(likelySandboxDenied(facts(159), "native", "darwin")).toBe(false);
		expect(likelySandboxDenied(facts(159), "appcontainer", "win32")).toBe(false);
	});

	test("unrelated failure text stays unrelated", () => {
		expect(likelySandboxDenied(facts(1, "3 tests failed", "AssertionError: expected 1 to be 2"), "native")).toBe(false);
	});
});
