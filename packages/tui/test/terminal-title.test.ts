/**
 * The window title.
 *
 * The title is built by composing an OSC sequence around text we did not type:
 * the session directory's basename. A directory named `x<BEL><ESC>]0;whatever`
 * would otherwise end our sequence and start its own, so what is pinned here is
 * that nothing reaching the sequence can carry a control or an invisible
 * character out with it.
 *
 * The write itself cannot be asserted: it goes to the global stdout, which is
 * not the stream Ink renders to and is not a TTY under a test runner.
 */
import { describe, expect, test } from "bun:test";
import { FRAMES } from "../src/components/StatusLine.tsx";
import {
	actionTitle,
	sanitizeTitle,
	TITLE_MAX_CHARS,
	terminalTitle,
	windowTitle,
} from "../src/components/TerminalTitle.tsx";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const C1_CSI = String.fromCharCode(0x9b);

describe("sanitizeTitle", () => {
	test("a title cannot be ended early and a second one forged", () => {
		expect(sanitizeTitle(`proj${BEL}${ESC}]0;pwned`)).toBe("proj ]0;pwned");
	});

	test("escape and C1 introducers never survive", () => {
		const cleaned = sanitizeTitle(`${ESC}[31mred${C1_CSI}2J`);
		expect(cleaned).not.toContain(ESC);
		expect(cleaned).not.toContain(C1_CSI);
	});

	test("invisible characters that rewrite what the title reads as are dropped", () => {
		expect(sanitizeTitle(`a${RIGHT_TO_LEFT_OVERRIDE}b${ZERO_WIDTH_SPACE}c`)).toBe("a b c");
	});

	test("whitespace collapses and the ends are trimmed", () => {
		expect(sanitizeTitle("  my\n\tdir  ")).toBe("my dir");
	});

	test("an overlong directory name is cut to a readable length", () => {
		expect(sanitizeTitle("x".repeat(500))).toHaveLength(TITLE_MAX_CHARS);
	});
});

describe("terminalTitle", () => {
	test("wraps the title in the OSC-0 sequence", () => {
		expect(terminalTitle("labunbun — proj")).toBe(`${ESC}]0;labunbun — proj${BEL}`);
	});
});

describe("actionTitle", () => {
	test("blinks between two fixed forms, both naming what is wanted", () => {
		expect(actionTitle(true)).toBe("[ ! ] Action Required");
		expect(actionTitle(false)).toBe("[ . ] Action Required");
	});
});

describe("windowTitle", () => {
	const title = (over: Partial<Parameters<typeof windowTitle>[0]> = {}) =>
		windowTitle({ phase: "tools", dirName: "proj", actionRequired: false, frame: 0, blinkOn: true, ...over });

	test("an idle session names the directory and nothing else", () => {
		expect(title({ phase: "idle" })).toBe("labunbun — proj");
	});

	test("a busy session shows the spinner frame next to the phase", () => {
		expect(title({ frame: 0 })).toContain("⠋ running tools");
		expect(title({ frame: 1 })).toContain("⠙ running tools");
		// The frame counter wraps: it runs for as long as the turn does.
		expect(title({ frame: FRAMES.length })).toContain("⠋ running tools");
	});

	test("a blocked session says so, and outranks the spinner", () => {
		const blocked = title({ actionRequired: true, blinkOn: true });
		expect(blocked).toContain("[ ! ] Action Required");
		expect(blocked).not.toContain("running tools");
		expect(title({ actionRequired: true, blinkOn: false })).toContain("[ . ] Action Required");
	});

	// The directory name is the one part of the title nobody typed into this
	// program, and the assembled title is the single place it is cleaned.
	test("a directory name cannot forge a second title", () => {
		const forged = title({ dirName: `x${BEL}${ESC}]0;pwned`, phase: "idle" });
		expect(forged).not.toContain(BEL);
		expect(forged).not.toContain(ESC);
	});

	test("an absurd directory name is cut to a readable title", () => {
		expect(title({ dirName: "x".repeat(500) })).toHaveLength(TITLE_MAX_CHARS);
	});
});
