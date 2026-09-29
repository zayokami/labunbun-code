/**
 * The dangerous-command classifier.
 *
 * Every case is written with an explicit `platform` rather than branching on
 * `process.platform`. A test that skips itself on the machine it runs on is a
 * test that reports green without having checked anything — and this file's
 * whole job is to be checkable from either platform, which is what the
 * `platform` parameter on `classifyDangerousCommand` exists for.
 *
 * The `null` cases matter as much as the matches. A classifier that flags
 * everything gets dismissed, and one that flags nothing protects no one; the
 * controls below are what hold the middle. A window is a command that has
 * every dangerous word in it and does none of the thing: `Remove-Item x;
 * Write-Host -Force` is the one to read the controls next to, because a
 * classifier that flags it is one the user learns to switch off.
 */
import { describe, expect, test } from "bun:test";
import { classifyDangerousCommand, MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH } from "../src/dangerous-command.ts";

const posix = (command: string) => classifyDangerousCommand(command, "posix");
const windows = (command: string) => classifyDangerousCommand(command, "windows");

describe("POSIX: forced recursive delete", () => {
	test.each([
		["rm -rf /", "the plain case"],
		["rm -fr /", "flags in the other order"],
		["rm -r -f /", "flags separated"],
		["rm --force -r /", "the long spelling"],
		["sudo rm -rf /", "through sudo"],
		["env FOO=bar rm -rf /", "through env with an assignment"],
		["env -i rm -rf /", "through env with -i"],
		["sh -c 'rm -rf /'", "through sh -c"],
		["bash -lc 'rm -rf /'", "through bash -lc"],
		[`sh -c "sh -c 'rm -rf /'"`, "through two nested shells"],
		["echo hi && rm -rf /", "after a separator"],
		["rm -rf / # a comment", "with a trailing comment"],
		['echo "$(rm -rf /tmp/x)"', "inside a $() substitution"],
		["echo `rm -rf /tmp/x`", "inside a backtick substitution"],
		["trap 'rm -rf /' EXIT", "as a trap action"],
	])("%s is dangerous — %s", (command) => {
		expect(posix(command)).not.toBeNull();
	});

	test("a forced delete reports ForcedRm, so the message can say what it was", () => {
		expect(posix("rm -rf /")?.kind).toBe("ForcedRm");
		expect(posix("sudo rm -rf /")?.kind).toBe("ForcedRm");
		expect(posix("sh -c 'rm -rf /'")?.kind).toBe("ForcedRm");
	});

	/**
	 * The flag is what makes it dangerous, and the path is not what makes it
	 * dangerous. Both directions are asserted: `rm -rf` on a temporary directory
	 * is the same command, and `rm` without `-f` asks first.
	 */
	test.each(["rm -rf /tmp/build", "rm -rf ./dist"])("%s is still a forced delete", (command) => {
		expect(posix(command)?.kind).toBe("ForcedRm");
	});

	test.each([
		"rm /tmp/x",
		"rm -r /tmp/x",
		"git status",
		"bun test",
		"ls -la",
		// `--` ends the options, so this is a file literally named `-f` being
		// removed without force — reading the `-f` as a flag would cry wolf here.
		"rm -- -f",
		// A program that ends in `rm` is not `rm`.
		"farm -rf x",
	])("%s is not a forced delete", (command) => {
		expect(posix(command)).toBeNull();
	});
});

describe("the depth bound fails closed", () => {
	/**
	 * The bound is the one number in the file that is a policy choice, so it is
	 * tested as one: at the limit the command is classified on its merits, and
	 * one level past it the answer is "dangerous" for the only reason that it
	 * stopped being able to follow.
	 *
	 * A limit that returned "unknown" at depth 9 would let `rm -rf /` run by
	 * being wrapped nine times, which is the whole attack. The cases at the limit
	 * are what make the one past it mean something: without them, "deep nesting
	 * is dangerous" and "nesting is dangerous" are the same claim.
	 *
	 * The nesting is built from `sudo` and `env` rather than from quoted shells,
	 * because the tokenizer has no escapes: `sh -c` nesting stops at two levels
	 * however the quotes are alternated, so a `sh -c` depth table would pass
	 * without ever reaching the bound. A prefix wrapper recurses once per word,
	 * so eight of them is eight levels.
	 */
	test.each(["sudo ", "env -i "])("`%s` nests to the limit and is still classified on its merits", (prefix) => {
		for (let depth = 0; depth <= MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH; depth++) {
			expect(posix(prefix.repeat(depth) + "rm -rf /")?.kind).toBe("ForcedRm");
		}
	});

	test("the bound counts across different wrappers, not per wrapper kind", () => {
		const half = MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH / 2;
		expect(posix("sudo ".repeat(half) + "env -i ".repeat(half) + "rm -rf /")?.kind).toBe("ForcedRm");
		expect(posix("sudo ".repeat(half) + "env -i ".repeat(half + 1) + "rm -rf /")?.kind).toBe("Other");
	});

	test("one wrapper past the limit is refused for the nesting, and says so", () => {
		const match = posix("sudo ".repeat(MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH + 1) + "ls");
		expect(match).not.toBeNull();
		// `Other`, not `ForcedRm`: nothing was actually a forced delete, and the
		// reason the user is shown has to name the real cause or it will read as
		// a false positive on an `ls`.
		expect(match?.kind).toBe("Other");
		expect(match?.rule).toContain(String(MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH));
	});
});

describe("Windows: PowerShell", () => {
	/**
	 * The quoted form is the one that matters, and it is the one a token-level
	 * reading of the command line gets wrong: `powershell -c "Remove-Item x
	 * -Force"` hands the script over as a *single argument*, so a rule that looks
	 * for the words of PowerShell one token at a time sees one very long word
	 * and finds nothing. That is how a person actually writes it — from
	 * `cmd.exe`, from a tool, from a script — so the gap was the ordinary path,
	 * not an edge case.
	 */
	test.each([
		["Remove-Item C:\\x -Force", "a delete cmdlet with -Force, typed straight in"],
		["Remove-Item C:\\x -Force -Recurse", "recursive"],
		["ri C:\\x -force", "the short alias"],
		["rm C:\\x -Force", "the rm alias"],
		['powershell -Command "Remove-Item C:\\x -Force"', "the same, as a quoted script"],
		['pwsh -c "Remove-Item C:\\x -Force"', "through pwsh"],
		['powershell -co "Remove-Item C:\\x -Force"', "an unambiguous prefix of -Command"],
		['powershell -c "ri C:\\x -force"', "the short alias, in a script"],
		['powershell -c "rm C:\\x -Force"', "the rm alias, in a script"],
		['powershell -c "Remove-Item C:\\x -Force; Write-Host done"', "a forced delete and a benign command"],
		["Start-Process https://example.com", "a URL handed to a launcher"],
		['powershell -c "Start-Process https://example.com"', "the same, in a script"],
		["powershell -c \"Invoke-Item 'https://example.com'\"", "Invoke-Item with a URL, in a script"],
	])("%s is dangerous — %s", (command) => {
		expect(windows(command)).not.toBeNull();
	});

	/**
	 * The crying-wolf control, and the reason the script body is opened up *only*
	 * where a script switch introduces it.
	 *
	 * `Remove-Item x; Write-Host -Force` has both words and deletes nothing. A
	 * classifier that flags it teaches a user to dismiss the flag, and the next
	 * one is the real thing. The last two cases are the same two words in the
	 * two places they can hide: a quoted string that merely mentions the cmdlet,
	 * and a segment that ends before the flag is reached.
	 */
	test.each([
		"Remove-Item C:\\x; Write-Host -Force",
		'powershell -c "Remove-Item C:\\x; Write-Host -Force"',
		'powershell -c "Write-Host -Force"',
		"Write-Host -Force",
		"Get-ChildItem C:\\x",
		'powershell -c "Get-ChildItem C:\\x"',
		"git status",
		// No URL, so the launcher rule cannot apply.
		"Start-Process notepad",
		'powershell -c "Start-Process notepad"',
		// No `-Force`, so the forced-delete rule cannot apply.
		"Remove-Item C:\\x",
		'powershell -c "Remove-Item C:\\x"',
	])("%s is not dangerous", (command) => {
		expect(windows(command)).toBeNull();
	});
});

describe("Windows: CMD", () => {
	/**
	 * Both spellings of the body, and the one that catches people out.
	 *
	 * These rules read the builtins of one shell, so they are read both after an
	 * explicit `cmd /c` and at the top of a Windows line — which is what the line
	 * becomes once a tool hands it to `cmd.exe`. The `&&` case is the reason: the
	 * chain splits into two segments, and only the first of them says `cmd`, so a
	 * reading that insists on seeing the word `cmd` before it will check the
	 * `echo` and skip the `rd`.
	 */
	test.each([
		["cmd /c del /f C:\\x", "a forced delete after an explicit /c"],
		['cmd /c "del /f C:\\x"', "the same, as a quoted body"],
		["del /f C:\\x", "a forced delete in a line CMD will run"],
		["cmd /c rd /s /q C:\\x", "a silent recursive delete"],
		["rd /s /q C:\\x", "the same, without the `cmd`"],
		["cmd /c echo hi && rd /s /q C:\\x", "a chained builtin, in the segment that does not say `cmd`"],
		["cmd /c start https://example.com", "start with a URL"],
		["start https://example.com", "the same, without the `cmd`"],
	])("%s is dangerous — %s", (command) => {
		expect(windows(command)).not.toBeNull();
	});

	/**
	 * `/f` and `/q` are what take the asking away, and the rules are written so
	 * that the spelling which still prompts is not flagged. `rd /s` on its own is
	 * a recursive delete a person would be asked about.
	 */
	test.each(['cmd /c "del C:\\x"', "del C:\\x", "cmd /c rd C:\\x", "rd /s C:\\x", "cmd /c rmdir C:\\x", "cmd /c ver"])(
		"%s is not dangerous",
		(command) => {
			expect(windows(command)).toBeNull();
		},
	);
});

describe("Windows: ShellExecute-shaped launches", () => {
	test.each([
		["mshta https://example.com/x.html", "mshta with a URL"],
		["explorer https://example.com", "explorer with a URL"],
		["chrome https://example.com", "a browser executable with a URL"],
		["firefox.exe https://example.com", "the `.exe` spelling"],
		["rundll32 url.dll,FileProtocolHandler https://example.com", "a protocol handler with a URL"],
	])("%s is dangerous — %s", (command) => {
		expect(windows(command)).not.toBeNull();
	});

	test.each([
		"explorer C:\\x",
		"mshta C:\\x\\x.hta",
		"notepad C:\\x",
		// A browser opened on a local page is a browser opened on a page.
		"chrome C:\\x\\index.html",
	])("%s is not dangerous", (command) => {
		expect(windows(command)).toBeNull();
	});
});

describe("the two platforms are not the same rules", () => {
	/**
	 * A Windows-only rule must not fire on a POSIX line and vice versa. If the
	 * platform argument were ignored, both of these would pass for the wrong
	 * reason and the parameter would be decorative.
	 */
	test("a PowerShell delete is not read as one on POSIX", () => {
		expect(posix("Remove-Item C:\\x -Force")).toBeNull();
		expect(posix('powershell -c "Remove-Item C:\\x -Force"')).toBeNull();
	});

	test("a CMD builtin is not read as one on POSIX", () => {
		expect(posix("del /f C:\\x")).toBeNull();
		expect(posix("rd /s /q C:\\x")).toBeNull();
	});

	/**
	 * `rm -rf` is the one rule both platforms share, and on Windows it is right
	 * to share it: `rm` in PowerShell is an alias for `Remove-Item` and `-rf`
	 * abbreviates `-Recurse -Force`, so the same characters are the same
	 * unprompted recursive delete. The case below is here so that this stays a
	 * decision rather than becoming an accident — if a future change made the
	 * generic check platform-specific, the two halves would disagree and this
	 * would say so.
	 */
	test("`rm -rf` classifies on both platforms, for the same reason on each", () => {
		expect(posix("rm -rf /")?.kind).toBe("ForcedRm");
		expect(windows("rm -rf C:\\x")?.kind).toBe("ForcedRm");
		expect(windows('powershell -c "rm -rf C:\\x"')?.kind).toBe("ForcedRm");
	});

	/**
	 * A POSIX shell on a Windows box still runs the POSIX rules. `pwsh` is a
	 * real program there, and following into its script is following a wrapper
	 * like any other — the alternative is a rule that only works on the machine
	 * whose default shell happens to match.
	 */
	test("a PowerShell script is followed on POSIX too, but its own vocabulary is not", () => {
		expect(posix('pwsh -c "rm -rf /"')?.kind).toBe("ForcedRm");
		expect(posix('pwsh -c "Remove-Item C:\\x -Force"')).toBeNull();
	});
});

describe("what a null does and does not mean", () => {
	/**
	 * The classifier cannot see a command built at runtime, and cannot read a
	 * script it is handed as base64. Both gaps are real, the module says so, and
	 * this pins them — a null is "nothing was recognized", never "this is safe",
	 * and the engine only ever narrows access on a match. If a future change made
	 * either of these classify, that is a change to this test, not a silent win.
	 */
	test.each([
		["cmd=rm; $cmd -rf /", "a command name held in a variable"],
		["eval 'rm -rf /'", "a string handed to `eval`"],
		["powershell -EncodedCommand SQBuAHYALQBmAHMAXQAtAE8AYgBqAGUAYwB0AA==", "a base64 script body"],
		['bash -c "$CMD -rf /"', "a variable inside a shell script"],
	])("%s is not matched — %s", (command) => {
		expect(posix(command)).toBeNull();
	});
});
