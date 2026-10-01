/**
 * The shell reader, tested as a value.
 *
 * Both functions here had no direct test. They were reached only through the
 * classifier and through the permission engine's Bash→file-rule extension, which
 * is enough to keep them *used* and not enough to keep them *right*: a bug in
 * here shows up as a wrong answer somewhere else, attributed to something else,
 * and the shortest route to the cause is a table of inputs.
 *
 * The failure this file was written for is specific and was live in shipped code.
 * `splitShellCommands` split on the separator characters with a regex, so
 * `printf 'a;rm -rf /'` — one command, which prints — became two commands, and
 * the second was classified as a forced recursive delete. A false positive is
 * the expensive direction for this reader: it refuses commands that do nothing,
 * and a user whose `printf` is refused learns to switch the thing off.
 *
 * So the quote and backslash tables below are not edge cases. Each one is a
 * command a person types, and each was one command that this reader used to
 * report as two.
 */
import { describe, expect, test } from "bun:test";
import { classifyDangerousCommand } from "../src/dangerous-command.ts";
import { extractBashFilePaths } from "../src/permissions.ts";
import { splitShellCommands, tokenizeShell } from "../src/shell-tokens.ts";

const posix = (command: string) => classifyDangerousCommand(command, "posix");

describe("splitShellCommands: the separators", () => {
	test.each([
		["echo a; rm -rf /", ["echo a", "rm -rf /"], "semicolon"],
		["echo a && rm -rf /", ["echo a", "rm -rf /"], "and-and, read as one separator"],
		["echo a || rm -rf /", ["echo a", "rm -rf /"], "or-or, read as one separator"],
		["echo a | rm -rf /", ["echo a", "rm -rf /"], "pipe"],
		["echo a & rm -rf /", ["echo a", "rm -rf /"], "single ampersand"],
		["echo a\nrm -rf /", ["echo a", "rm -rf /"], "newline"],
		["  echo a  ;;  rm -rf /  ", ["echo a", "rm -rf /"], "padding and an empty segment between two separators"],
		["echo a", ["echo a"], "no separator at all"],
		["", [], "nothing"],
		[";;;", [], "separators and nothing else"],
	])("%s splits into %j (%s)", (input, expected) => {
		expect(splitShellCommands(input)).toEqual(expected);
	});

	test("an empty segment between two separators does not survive as a command", () => {
		// The shape a table row above covers, asserted on its own because an
		// empty segment reaching the classifier is a different bug from a missing
		// one: it is a command with no program, which is not nothing.
		expect(splitShellCommands("echo a;;echo b")).toEqual(["echo a", "echo b"]);
	});
});

describe("splitShellCommands: quotes", () => {
	test.each([
		['echo "a;b"', ['echo "a;b"'], "semicolon inside double quotes"],
		["echo 'a;b'", ["echo 'a;b'"], "semicolon inside single quotes"],
		['echo "a|b"', ['echo "a|b"'], "pipe inside double quotes"],
		['echo "a && b" && rm -rf /', ['echo "a && b"', "rm -rf /"], "quoted separator, then a real one"],
		["echo 'a\nrm -rf /'", ["echo 'a\nrm -rf /'"], "newline inside single quotes"],
		[
			'echo "unterminated; rm -rf /',
			['echo "unterminated; rm -rf /'],
			"an unterminated quote swallows the rest, which is what a shell does",
		],
		['echo it\'s "a;b"', ['echo it\'s "a;b"'], "an apostrophe inside a double-quoted string does not open a quote"],
	])("%s is read as one segment", (input, expected, note) => {
		expect(splitShellCommands(input)).toEqual(expected);
		expect(note).not.toBe("");
	});

	/**
	 * The same inputs, as classifications.
	 *
	 * The tables above prove the reader returns one segment. This proves that one
	 * segment is the difference between a command that prints and one that is
	 * refused — the segment count is an implementation detail, and this is the
	 * property it exists for. Every one of these was `ForcedRm` before the reader
	 * tracked quotes.
	 */
	test.each([
		'printf "a;rm -rf /"',
		"printf 'a;rm -rf /'",
		'echo "harmless; rm -rf /"',
		"echo 'harmless; rm -rf /'",
		'Write-Host "harmless` + "\n" + `Remove-Item C:\\x -Force"',
	])("%s prints, and printing is not dangerous", (command) => {
		expect(posix(command)).toBeNull();
	});

	test("a real second command after a quoted one is still found", () => {
		// The other direction, and the one that matters most: making the reader
		// quote-blind would fix every false positive above and open this.
		expect(posix('echo "harmless"; rm -rf /')).not.toBeNull();
		expect(posix("echo 'harmless' && rm -rf /")).not.toBeNull();
	});
});

describe("splitShellCommands: backslashes", () => {
	const BS = String.fromCharCode(92);

	test.each([
		[`find . -exec rm {} ${BS};`, "an escaped semicolon is the argument, not a separator"],
		[`echo a${BS};b`, "an escaped separator between two words"],
		[`echo "a${BS}"b"`, "an escaped quote does not close the string"],
		[`echo ${BS}`, "a trailing backslash on its own"],
	])("%s comes back as one segment, unchanged (%s)", (input, note) => {
		// The segment's *text*, not its count. A count of one is also what a reader
		// that dropped the escaped character and then found nothing to split on
		// would produce, so asserting the count alone let a broken reader pass.
		expect(splitShellCommands(input)).toEqual([input]);
		expect(note).not.toBe("");
	});

	test(`a backslash inside single quotes is itself, not an escape`, () => {
		// The one rule here that does not generalise, and the reason this is a
		// scanner rather than a lookbehind. `'a\'` closes at the second quote,
		// so what follows is unquoted — and an implementation that treated the
		// backslash as an escape would carry the quote state the rest of the way.
		expect(splitShellCommands(`echo 'a\\'b; rm -rf /`)).toEqual(["echo 'a\\'b", "rm -rf /"]);
	});
});

describe("the Bash→file-rule extension reads the same way", () => {
	test("a redirect target inside quotes is not read as a segment of its own", () => {
		// `extractBashFilePaths` split with the same regex, so a rule could be
		// extracted from text a command was only printing. The contract is that
		// the result is only ever used to deny, which makes a spurious path a
		// refusal of something harmless — the same direction as the classifier's.
		expect(extractBashFilePaths(`echo "text; rm -rf /"`)).toEqual([]);
	});

	test("a real redirect is still found", () => {
		expect(extractBashFilePaths("echo hi > out.txt")).toEqual(["out.txt"]);
	});
});

describe("tokenizeShell", () => {
	test.each([
		["rm -rf /", ["rm", "-rf", "/"], "the plain case"],
		['rm -rf "/a path"', ["rm", "-rf", "/a path"], "a quoted path with a space stays one token"],
		["echo 'it''s'", ["echo", "its"], "adjacent quoted runs join"],
		["  spaced   out  ", ["spaced", "out"], "runs of whitespace are one break"],
		["", [], "nothing"],
		["''", [""], "an empty quoted string is a token, not an absence"],
	])("%s tokenizes to %j (%s)", (input, expected) => {
		expect(tokenizeShell(input)).toEqual(expected);
	});
});
