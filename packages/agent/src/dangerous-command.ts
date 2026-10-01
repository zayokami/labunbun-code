/**
 * Dangerous-command classification.
 *
 * A pure function over a command line: does this command do something that
 * destroys data, and if so which rule matched. It exists because "the user said
 * yes once" and "this specific command is safe" are different claims, and a
 * permission system that only has the first one cannot tell a model that ran
 * `rm -rf /` from one that ran `bun test`.
 *
 * Ported from Codex's `codex-rs/shell-command/src/command_safety/`. The shape
 * is deliberately the same because the reasoning behind it is:
 *
 * - **Wrappers are followed, not trusted.** `sudo rm -rf /`, `env FOO=bar rm -rf`
 *   and `bash -lc 'rm -rf /'` are the same command to the thing that will be
 *   harmed, so each wrapper recurses into what it runs. The same move is made
 *   for the shell Windows comes with: a `powershell -Command "…"` invocation
 *   keeps a whole script in one argument, and that argument is opened up before
 *   the PowerShell rules are read against it.
 * - **Depth is bounded and the bound fails closed.** A command nested deeper
 *   than {@link MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH} is classified `Other`
 *   rather than allowed, because a limit that returns "I don't know" has to
 *   answer the way that does not let it through.
 * - **What cannot be read is not read as safe.** Non-literal commands (`cmd=rm;
 *   $cmd -rf /`) are *not* matched — a substitution is not a string this
 *   function can see — and that gap is why the engine runs this **before** the
 *   allow rules and never lets an allow rule turn a match into a pass.
 *
 * One deliberate divergence from Codex: `execpolicy/src/policy.rs:305-332` lets
 * an explicit `allow` prefix rule return `Skip` and short-circuit the classifier
 * without consulting the approval policy at all. That is not copied here. In
 * this repo a `deny` rule is a floor the user wrote on purpose, and a rule on
 * the other side of the file being able to switch the classifier off is a new
 * way around it.
 */

import { splitShellCommands, tokenizeShell } from "./shell-tokens.ts";

/** Whose command semantics to read the line with. */
export type DangerousCommandPlatform = "posix" | "windows";

/**
 * How deep wrapper-following goes before the classifier gives up.
 *
 * Eight is enough for anything a person writes and shallow enough that the
 * recursion is bounded work. Exceeding it is treated as a match, not a miss.
 */
export const MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH = 8;

export interface DangerousCommandMatch {
	/**
	 * `ForcedRm` is `rm` with a force option; `Other` is any other rule.
	 *
	 * Recursion is *not* part of it. `rm -f notes.txt` matches, and so does
	 * `rm -rf /` — the name says "forced rm", not "forced recursive rm", and
	 * both spellings are the same rule. Nothing branches on this member yet
	 * (`decideDangerous` reads `rule` only); it is carried so the message can
	 * say what it was if a caller ever wants to.
	 */
	kind: "ForcedRm" | "Other";
	/** What matched, for the message the user is shown. */
	rule: string;
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "ksh", "dash"]);

/**
 * Programs whose job is to run the command behind them, in the same sense as
 * `sudo`: the words in front of it are the wrapper's, not the command's.
 *
 * Every one of these was a miss until now, and `command` is the sharpest — it
 * is the POSIX builtin for running a name, so `command rm -rf /` is the delete
 * with a word in front of it that this function has no other reason to know.
 * `doas` and `pkexec` are `sudo` under another name on the systems that have
 * them; `nice` and `nohup` are the ordinary spelling of "run this in the
 * background, lower priority".
 *
 * `su` is not here. Its `-c` carries the command the way `sh -c` does, so it
 * needs the script read out of the flag rather than the words after the
 * options, and it gets its own branch for that.
 */
const COMMAND_PREFIX_PROGRAMS = new Set(["command", "exec", "nohup", "nice", "doas", "pkexec"]);

const POWERSHELL_EXECUTABLES = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const BROWSER_EXECUTABLES = new Set([
	"chrome",
	"chrome.exe",
	"msedge",
	"msedge.exe",
	"firefox",
	"firefox.exe",
	"iexplore",
	"iexplore.exe",
]);

/** The program's own name: no directory, no `.exe`, and on Windows no drive. */
function executableName(raw: string, platform: DangerousCommandPlatform): string | undefined {
	if (platform === "posix") {
		const name = raw.split("/").pop();
		// Lower-cased even though POSIX paths are case-sensitive. `RM -rf` and
		// `sudo RM -rf` are not commands a POSIX shell can run, so this does not
		// change what any real invocation matches; it stops a program that
		// *reached* the shell under a different case from being read as an
		// unrelated name. The Windows branch below has always folded, and the
		// two platforms are not supposed to disagree about a program's name.
		return name ? name.toLowerCase() : undefined;
	}
	const name = raw.split(/[/\\]/).pop();
	if (!name) return undefined;
	const bare = /^[A-Za-z]:/.test(name) ? name.slice(2) : name;
	const lower = bare.toLowerCase();
	for (const suffix of [".exe", ".cmd", ".bat", ".com"]) {
		if (lower.endsWith(suffix)) return lower.slice(0, -suffix.length);
	}
	return lower;
}

/** `rm` deletes without asking when forced, whatever it was pointed at. */
function rmArgsIncludeForce(args: string[]): boolean {
	for (const arg of args) {
		// Everything after `--` is a path, not an option: `rm -- -f` removes a
		// file literally called `-f`, and reading the `-f` as a flag would make
		// an ordinary command look forced.
		if (arg === "--") return false;
		// Case-folded, and only here. A path argument is folded too — `rm
		// /tmp/MyFile` reaches this line with the capitals already lowered —
		// and folding it is harmless because the second comparison below still
		// requires a leading `-`, which a path cannot have gained by folding.
		// That is the whole reason folding is safe, and it is a statement about
		// the leading dash, not about the path never being compared: it is
		// compared, and it loses. (`rm -rf /tmp/MyFile` never gets here at all,
		// because `-rf` returns true one line below first.)
		//
		// GNU and BSD `rm` reject `-F` outright, so `rm -RF` deletes nothing on
		// either — folding it is not a claim about POSIX option syntax, it is
		// this function refusing to depend on the local `rm` being the strict
		// one.
		const lower = arg.toLowerCase();
		if (lower === "--force") return true;
		if (arg.startsWith("-") && !arg.startsWith("--") && lower.slice(1).includes("f")) return true;
	}
	return false;
}

/** `NAME=value` — the assignments `env` consumes before the real command. */
function isAssignment(arg: string): boolean {
	const eq = arg.indexOf("=");
	return eq > 0 && !arg.startsWith("-");
}

/**
 * The assignment prefix of a command line, or the array itself when there is
 * none.
 *
 * Returned by identity rather than by a new array so the caller can ask "did
 * anything change?" with `!==` and know the answer, which is what stops a
 * segment that starts with no assignment from recursing into itself.
 */
function stripLeadingAssignments(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length && isAssignment(tokens[i])) i++;
	return i === 0 ? tokens : tokens.slice(i);
}

/** Extract the script text from a `sh -c '…'` style invocation. */
function wrapperScript(tokens: string[]): string | undefined {
	const program = executableName(tokens[0] ?? "", "posix");
	if (program === undefined || !SHELL_EXECUTABLES.has(program)) return undefined;
	for (let i = 1; i < tokens.length; i++) {
		const arg = tokens[i];
		if (!arg.startsWith("-")) continue;
		// A long option is never the switch that carries the command, and this is
		// the line that stops the substring test below from accepting one.
		// `bash --norc -c 'rm -rf /'` is an ordinary invocation of a script that
		// wants no rc-file; `--norc` contains a `c`, so the loop took it as the
		// switch and returned the *next* token — the literal `-c` — as the script
		// body. The body was never read, and `rm -rf /` inside it was classified
		// as the command `-c`, which is nothing. No shell in `SHELL_EXECUTABLES`
		// has a long option that takes a command: theirs are `--norc`,
		// `--noprofile`, `--posix`, `--rcfile`, `--version`, `--help`.
		if (arg.startsWith("--")) continue;
		// Every spelling of "run this string": -c, -lc, -lic, -e -c.
		if (!arg.includes("c")) continue;
		const next = tokens[i + 1];
		return next === undefined || next === "-" ? undefined : next;
	}
	return undefined;
}

/**
 * PowerShell's own spelling of the same idea: the script lives in one argument.
 *
 * `powershell.exe` matches its own switches by prefix, longest match first, with
 * the documented order breaking a tie — which is why most prefixes of
 * `-EncodedCommand` reach it even though `-ExecutionPolicy` is also an `E`: `-e`
 * and `-en` match both at the same length and `-EncodedCommand` is documented
 * first, while `-ex` diverges at the third character and reaches only
 * `-ExecutionPolicy`, which is what makes it swallow the body below.
 *
 * The set was measured rather than reasoned about, because reasoning about it
 * gets two of the answers wrong. Each spelling below was run against a
 * `powershell.exe` on this machine, on 5.1 and on 7.4, with a base64 body that
 * writes a marker file only the body itself can write:
 *
 * - `-e`, `-en`, `-enco`, `-encod`, `-encode`, `-encoded`, `-encodedc`,
 *   `-encodedco`, `-encodedcom`, `-encodedcomm`, `-encodedcomma`,
 *   `-encodedcomman` and `-encodedcommand` each ran it — thirteen of the
 *   fourteen prefixes, and every one of them but `-enc`.
 * - `-ec` ran it, in any case. It is not a prefix of anything here.
 * - `-enc` did not run it — three runs on each build, every one of them waiting
 *   for input until it was killed — while its immediate neighbours `-en` and
 *   `-enco` both did. `-eco`, `-ecom` and `-econd` did not run it either.
 * - `-ex`, `-exe`, `-exec`, `-execu`, `-executio`, `-executionp` and
 *   `-executionpolicy` each took the body as their own value and ran nothing.
 * - `-nop` takes no value, so the body became the command.
 *
 * So the accepted set is every prefix of the name plus `-ec`, and it is derived
 * from that name rather than written out. The hand-kept list this replaces
 * (`c|co|com|comm|comma|comman|command`) was exactly the prefixes of `command`,
 * so deriving it changes no answer and cannot drift when a switch is spelled
 * differently.
 *
 * One spelling in the accepted set was measured *not* to run the body — `-enc` —
 * and it stays in. Keeping a spelling that does not work costs one prompt too
 * many; dropping one that does work on some build costs a destructive command
 * running unsupervised, and the two mistakes are not the same size. Nothing
 * here explains why `-ec` binds, why `-enc` does not, or why `-enco` does; that
 * is recorded rather than guessed at, because a rule whose comment explains more
 * than was measured is worse than a rule that says what it saw.
 *
 * `shortest` exists for the one prefix-match rule that PowerShell does not apply
 * the same way: a *parameter* name binds only when it is unambiguous, so the
 * prefixes below it have to be left out rather than included. See
 * `FORCE_PARAMETER_SPELLINGS`.
 */
function switchPrefixes(name: string, shortest = 2): ReadonlySet<string> {
	const full = `-${name.toLowerCase()}`;
	const out = new Set<string>();
	for (let n = shortest; n <= full.length; n++) out.add(full.slice(0, n));
	return out;
}

const POWERSHELL_COMMAND_SWITCH = switchPrefixes("command");
const POWERSHELL_ENCODED_SWITCH = new Set([...switchPrefixes("encodedcommand"), "-ec"]);

/**
 * The script text of a `powershell -Command "…"` invocation.
 *
 * `-EncodedCommand` is read here too, and used to be a hole this file documented
 * rather than closed: its body is base64, and the comment claimed a miss was
 * "never treated as safe anywhere upstream". That was wrong, and
 * `permissions.ts:331-333` says the opposite — an unrecognised command becomes an
 * ordinary one, and an ordinary command with no deny rule is allowed in Agent
 * mode. It was arbitrary code execution behind a switch the classifier read as
 * nothing.
 */
function powershellScript(tokens: string[]): string | undefined {
	const program = executableName(tokens[0] ?? "", "windows");
	if (program === undefined || !POWERSHELL_EXECUTABLES.has(program)) return undefined;
	for (let i = 1; i < tokens.length; i++) {
		const arg = tokens[i].toLowerCase();
		if (POWERSHELL_ENCODED_SWITCH.has(arg)) return decodeEncodedCommand(tokens[i + 1]);
		if (!POWERSHELL_COMMAND_SWITCH.has(arg)) continue;
		const next = tokens[i + 1];
		return next === undefined || next === "-" ? undefined : next;
	}
	return undefined;
}

/**
 * How much base64 this will decode. `-EncodedCommand` bodies are a shell
 * command; the largest one anyone writes by hand is a few kilobytes, and a
 * classifier that allocates whatever a number in a command line asks for is a
 * denial of service wearing a rule.
 */
const MAX_ENCODED_COMMAND_CHARS = 64 * 1024;

/**
 * `powershell -EncodedCommand` takes base64 of UTF-16LE, which is what
 * `[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))` produces
 * and what every "here is a one-liner" post on the web copies verbatim.
 *
 * Decoding is the whole point: the body is ordinary PowerShell source, and the
 * rest of this file already knows how to read that. Returning `undefined` for a
 * body it cannot make sense of is the one case that stays a miss, and every one
 * of those misses is a miss about *decoding* rather than about the shape — the
 * host rejects an odd number of bytes, a body outside the base64 alphabet and a
 * body that is not UTF-16LE with the same error and without running anything.
 * Measured: the body runs when its arguments are separated by spaces or by tabs,
 * and does not run when they are separated by newlines, so splitting on any
 * whitespace errs towards flagging rather than towards missing.
 */
function decodeEncodedCommand(body: string | undefined): string | undefined {
	if (body === undefined) return undefined;
	// Base64 is whitespace-tolerant, and PowerShell tolerates it too, so this
	// does rather than rejecting a body that would have run.
	const compact = body.replace(/\s+/g, "");
	if (compact.length === 0 || compact.length > MAX_ENCODED_COMMAND_CHARS) return undefined;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return undefined;
	const bytes = Buffer.from(compact, "base64");
	// UTF-16LE of nothing is nothing, and a payload whose length is odd was not
	// produced by the encoder above.
	if (bytes.length === 0 || bytes.length % 2 !== 0) return undefined;
	// UTF-8 is the only other encoding anyone reaches for, and PowerShell does not
	// read it here. Measured, because the alternative was a comment promising a
	// catch that does not exist: the same `Remove-Item … -Force` command written as
	// UTF-16LE ran on 5.1 and on 7.4 and wrote its marker file, and the UTF-8
	// spelling of the same command wrote nothing on either. So there is no UTF-8
	// command behind this switch, and reading one would be work on an input that
	// cannot run.
	//
	// The test is on the bytes, not on the decoded text: UTF-16LE of ASCII puts a
	// zero in the high half of every character, while UTF-8 of the same text has
	// no zero bytes at all. A first attempt looked for a NUL in the *decoded*
	// string, which is nearly the same idea and almost never fires — reading
	// UTF-8 as UTF-16LE pairs two non-zero bytes together and produces no NUL,
	// which is how a UTF-8 body slipped past it. The one case this rule gives up
	// is a body with no ASCII in it at all, and a command with no ASCII in it
	// cannot spell a name any rule here matches.
	if (!bytes.includes(0)) return undefined;
	return bytes.toString("utf16le");
}

/**
 * Command substitution: `$( … )` and backtick spans.
 *
 * Found in the raw segment rather than the token list because a substitution's
 * contents are not a token — `echo "$(rm -rf /tmp/x)"` tokenizes to one word
 * with the delete inside it, and a word-by-word reading would never look there.
 */
function substitutionScripts(segment: string): string[] {
	const found: string[] = [];

	for (let i = 0; i < segment.length; i++) {
		if (segment[i] === "`") {
			const end = segment.indexOf("`", i + 1);
			if (end === -1) break;
			found.push(segment.slice(i + 1, end));
			i = end;
			continue;
		}
		if (segment[i] === "$" && segment[i + 1] === "(") {
			let depth = 0;
			for (let j = i + 1; j < segment.length; j++) {
				if (segment[j] === "(") depth++;
				else if (segment[j] === ")") {
					depth--;
					if (depth === 0) {
						found.push(segment.slice(i + 2, j));
						i = j;
						break;
					}
				}
			}
		}
	}
	return found;
}

/**
 * The words that can open a command segment without being the command.
 *
 * `splitShellCommands` splits on `;`, `|`, `&` and newline, so a command
 * segment can still begin with the punctuation of a group or with the keyword
 * that introduces a control structure's body. Every rule below reads
 * `tokens[0]` as the program's name, so without this list the word in front of
 * the command is the word those rules see.
 */
const SHELL_SCAFFOLDING = new Set([
	"(",
	")",
	"{",
	"}",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"in",
	"esac",
	"time",
	"!",
]);

/**
 * The command a segment's leading scaffolding introduces, or `undefined` when
 * the segment opens with the command already.
 *
 * This is not a shell parser and does not try to be one — Codex reads these
 * constructs with a tree-sitter parse, which this repo has no equivalent of.
 * It reads *leading* scaffolding only, which is the narrowest rule that catches
 * the evasions measured for this batch, and narrowing it is what keeps the
 * controls standing: a `{` or a `(` that is not the first character of a
 * segment is inside an argument, a quoted string or a filename, and
 * `echo "{"`, `find . -exec {} \;`, `awk '{print $1}'` and
 * `git log --format='(%h)'` all keep the word they start with.
 *
 * The return is `undefined` — not the same array — so a glued opener like
 * `(rm` can be reported as a change even though stripping it leaves the array
 * the same length.
 */
function stripShellScaffolding(tokens: string[]): string[] | undefined {
	let rest = tokens;
	let stripped = false;
	while (rest.length > 0) {
		const head = rest[0];
		// A group punctuation glued to the word behind it, as in `(rm` and
		// `{echo`: the punctuation goes, the word is looked at next.
		const word = head.replace(/^[{()}]+/, "");
		if (word === "") {
			rest = rest.slice(1);
			stripped = true;
			continue;
		}
		if (word !== head) return [word, ...rest.slice(1)];

		const keyword = head.toLowerCase();
		// Nothing has been consumed yet on the first pass, and returning the
		// array unchanged would be the same tokens the caller already has —
		// which is what `undefined` says, and what stops the caller's recursion.
		if (!SHELL_SCAFFOLDING.has(keyword)) return stripped ? rest : undefined;
		rest = rest.slice(1);
		stripped = true;
		// `case` answers with a pattern list before it answers with a command,
		// so the word after it is the subject being matched and not the program:
		// `case $x in *) rm -rf /` has three words in front of the `rm`. The
		// pattern list ends at the `)` that closes it.
		if (keyword === "case") {
			while (rest.length > 0 && !rest[0].includes(")")) rest = rest.slice(1);
			rest = rest.slice(1);
		}
		// `time` is the only word above that takes options of its own, and it
		// takes exactly two. `-p` is the POSIX spelling and `--` ends the
		// options; both then have the command behind them. Measured on this
		// machine against a real `bash`: `time rm -rf D`, `time -p rm -rf D` and
		// `time -- rm -rf D` all ran the delete, and `time -v`, `time -f x` and
		// `time -o /dev/null` did *not* — the keyword stops at an option it does
		// not know and tries to execute the option as the program, so the `rm` is
		// never reached. Those three are therefore left as nulls on purpose;
		// treating every `-x` after `time` as an option would flag commands that
		// do not run.
		if (keyword === "time") {
			const flag = rest[0]?.toLowerCase();
			if (flag === "-p" || flag === "--") {
				rest = rest.slice(1);
				stripped = true;
			}
		}
	}
	return rest;
}

/** How many times `char` appears in `word`, counted one character at a time. */
function countOf(word: string, char: string): number {
	let n = 0;
	for (const c of word) {
		if (c === char) n++;
	}
	return n;
}

/**
 * The words that say which kind of `if` this is, and so how much condition is
 * between the `if` and the command.
 *
 * Each was run against a real `cmd.exe` on this machine — one `cmd /c <line>`
 * with a `rd /s /q` behind it and a scratch directory to delete. `if exist`,
 * `if not exist`, `if errorlevel 0` and `if cmdextversion 1` each deleted it.
 * `if defined FOO` did not, and `if not defined FOO` did, which is the same
 * fact about the shell from both sides: `defined` is a keyword, and whether
 * the command behind it runs is a question about the variable — which is the
 * thing the rule below is careful not to answer.
 */
const CMD_IF_KEYWORDS = new Set(["exist", "errorlevel", "defined", "cmdextversion"]);

/**
 * The six comparison operators, each measured the same way with a condition
 * that is true: `if 1 equ 1`, `if 1 neq 0`, `if 1 lss 2`, `if 1 leq 1`,
 * `if 1 gtr 0` and `if 1 geq 1` each ran the delete behind them.
 *
 * A seventh spelling, `lsr`, was tried on the same harness with two conditions
 * and did not delete on either, so it is not in this set.
 */
const CMD_IF_COMPARISONS = new Set(["equ", "neq", "lss", "leq", "gtr", "geq"]);

/**
 * The command a Windows control word introduces, or `undefined` when the words
 * do not open with one.
 *
 * `stripShellScaffolding` above reads a control word as one word, which is
 * right for a POSIX `if` and wrong for CMD's: `if` answers with a condition
 * before it answers with a command, and `for` answers with a whole clause.
 * Both hid the command behind them, and every shape measured for this batch came
 * back `null` for it — `if exist C:\x rd /s /q C:\y`, `for %f in (a b) do rd
 * /s /q C:\y`, `cmd /c call rd /s /q C:\y`.
 *
 * It is read from two places and the two are not interchangeable. From
 * `matchTokens`, *before* the assignment and scaffolding strips, it is what
 * lets a `for` be seen whole: `for` is in a platform-independent list, and
 * those strips would take the word off before anything here could read the
 * clause. From `dangerousCmdSegment` it is what reads the control words inside a
 * `cmd /c` body, which neither strip ever sees, because a body is a word array
 * handed straight to the CMD rules.
 *
 * No condition is evaluated and none could be: `if 1 lss 2` is true and
 * `if 1 lss 0` is not, and a classifier that worked that out would be modelling
 * a shell rather than reading a line. The point of flagging is that the person
 * running it may not have meant to, which is true of every condition here.
 *
 * `undefined` — not the same array — for the reason it is the return above:
 * the caller asks "did anything change?" with `!==`. Every pass takes at least
 * one word, so the recursion terminates.
 */
function stripControlWords(tokens: string[]): string[] | undefined {
	let rest = tokens;
	let stripped = false;
	while (rest.length > 0) {
		const keyword = rest[0].toLowerCase();
		let next = 1;

		if (keyword === "if") {
			if (rest[next]?.toLowerCase() === "not") next++;
			const form = rest[next]?.toLowerCase();
			if (form !== undefined && CMD_IF_KEYWORDS.has(form)) {
				// `if exist <path> <cmd>`: the word that names the test, and the
				// one word the test is about. One operand each, measured for all
				// four of them.
				next += 2;
			} else {
				// `if <cond> <cmd>` is one word of condition and `if <a> <op> <b>
				// <cmd>` is three, and the operator is the only thing that tells
				// them apart — so the condition is read one word and then extended
				// only if what follows it is an operator.
				next += 1;
				const operator = rest[next]?.toLowerCase();
				if (operator !== undefined && CMD_IF_COMPARISONS.has(operator)) next += 2;
			}
		} else if (keyword === "for") {
			// `for %v in (set) do <cmd>`, with any number of options between the
			// `for` and the body. The body starts after the `do`, and the `do` that
			// counts is the one outside the parenthesised set: `for %i in (a do b)
			// do rd /s /q C:\x` has a `do` inside the set and one after it, and
			// only the second introduces the command. A `for` with no `do` is not a
			// shape this reads, and a `for` whose clause runs off the end of the
			// line is left exactly as it was.
			let depth = 0;
			while (next < rest.length) {
				if (depth === 0 && rest[next].toLowerCase() === "do") break;
				depth += countOf(rest[next], "(") - countOf(rest[next], ")");
				next++;
			}
			if (next >= rest.length) return stripped ? rest : undefined;
			next++;
		} else if (keyword === "call") {
			// `call` runs the command behind it — measured, `call rd /s /q <dir>`
			// deleted the directory and so did `call del /f <file>`.
			//
			// It is taken off in front of a label as well, which costs nothing:
			// the words after a label are arguments to a subroutine and are not a
			// command — measured the same way against a batch file with a
			// `:cleanup` label, where `call :cleanup rd /s /q <dir>` left the
			// directory alone while a separate `rd` after it deleted it — so the
			// label word becomes the head of the segment and no rule here matches
			// it either way.
		} else {
			return stripped ? rest : undefined;
		}

		rest = rest.slice(next);
		stripped = true;
	}
	return rest;
}

/** `xargs` options that consume the word after them. */
const XARGS_VALUE_OPTIONS = new Set([
	"-a",
	"-d",
	"-e",
	"-E",
	"-I",
	"-i",
	"-L",
	"-n",
	"-P",
	"-s",
	"-S",
	"--arg-file",
	"--delimiter",
	"--eof",
	"--replace",
	"--max-args",
	"--max-chars",
	"--max-lines",
	"--max-procs",
]);

/**
 * Options that consume the word after them, per wrapper.
 *
 * `xargs` had this and the other six wrappers did not, which is the asymmetry
 * that let `env -u PATH rm -rf /` and `nice -n 10 rm -rf /` through: `env`'s
 * own skip knew `-i`, `--ignore-environment` and assignments, so every other
 * real `env` option became the program name.
 *
 * **One set per program rather than one set for all of them**, and the reason is
 * a collision rather than tidiness: `-n` is `nice`'s adjustment *and* `doas`'s
 * "do not prompt", so a shared list would have `doas -n` swallow the command
 * that follows it and turn `doas -n rm -rf /` back into a miss. These are
 * different programs that happen to share a letter.
 *
 * It is a list this function has to be right about rather than one it can ask,
 * because it cannot run any of these. Getting an entry wrong moves the boundary
 * one word either way, and the words on either side of that boundary belong to
 * the wrapper — an option, or the argument of one — so the cost is how often the
 * command behind them is found, not what is found when it is.
 */
const COMMAND_PREFIX_VALUE_OPTIONS = new Map<string, ReadonlySet<string>>([
	// `command -p PATH` searches a PATH instead of the inherited one.
	["command", new Set(["-p"])],
	// `exec -a NAME` runs the command under a different argv[0].
	["exec", new Set(["-a"])],
	// `nice -n ADJUSTMENT`. Nothing else in this map reads `-n` as a value.
	["nice", new Set(["-n", "--adjustment"])],
	// `nohup` has options and none of them take a value.
	["nohup", new Set()],
	// `doas -u USER`. Its `-n`/`-s`/`-C` take nothing, and treating them as
	// value options is the mistake the note above is about.
	["doas", new Set(["-u", "--user"])],
	["pkexec", new Set(["-u", "--user"])],
	// `env -u NAME`, `-C DIR`, `-S STRING`, `--argv0 NAME`. `-i` and
	// `--ignore-environment` are deliberately absent: they take no value.
	["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "--argv0"])],
	// `sudo -u USER`, `-g GROUP`, `-p PROMPT`, `-C NUM`, `-D DIR`, `-U USER`,
	// `-h HOST`, `-r ROLE`, `-t TYPE`. Its `-n`, `-E`, `-b`, `-S`, `-k`, `-i`,
	// `-A` and `-s` all take nothing, and listing `-n` here would be the exact
	// mistake the note above describes: `sudo -n rm -rf /` is a non-interactive
	// delete, not a command called `rm` with `-n` as its adjustment.
	[
		"sudo",
		new Set([
			"-u",
			"--user",
			"-g",
			"--group",
			"-p",
			"--prompt",
			"-C",
			"--close-from",
			"-D",
			"--chdir",
			"-U",
			"--other-user",
			"-h",
			"--host",
			"-r",
			"--role",
			"-t",
			"--type",
		]),
	],
]);

const EMPTY_VALUE_OPTIONS: ReadonlySet<string> = new Set();

/** The value options for one program; a program absent from the map has none. */
function valueOptionsFor(program: string): ReadonlySet<string> {
	return COMMAND_PREFIX_VALUE_OPTIONS.get(program) ?? EMPTY_VALUE_OPTIONS;
}

/**
 * Options that print and exit, so no command follows them.
 *
 * `command -v rm` is a lookup and `nohup --help` is help. Reading the word
 * after one of these as the command would invent a match out of a question.
 */
const COMMAND_PREFIX_QUERY_OPTIONS = new Set(["-v", "-V", "--help", "--version"]);

/**
 * The command a wrapper will run: the first word that is not one of its
 * options, the argument of one, or an assignment.
 *
 * `--` ends the options, which is what makes `env -- rm -rf /` and
 * `xargs -- rm -rf /` the same command rather than one wrapped in a flag.
 */
function commandAfterOptions(
	args: string[],
	valueOptions: ReadonlySet<string>,
	queryOptions: ReadonlySet<string> = COMMAND_PREFIX_QUERY_OPTIONS,
): string[] {
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		// `--` ends the options. The branch is not load-bearing for any command
		// anyone writes — the generic flag-skip below reaches the same answer,
		// because the word after `--` is a program name and a program name does
		// not begin with a dash — and a mutation that deletes this block does
		// leave every test green. It is here for the one reading the fallthrough
		// gets wrong: after `--`, a word *can* begin with a dash, and then it is
		// the program's name rather than an option of the wrapper's.
		if (arg === "--") {
			i++;
			break;
		}
		if (queryOptions.has(arg)) return [];
		if (valueOptions.has(arg)) {
			i += 2;
			continue;
		}
		if (isAssignment(arg)) {
			i++;
			continue;
		}
		if (!arg.startsWith("-")) break;
		i++;
	}
	return args.slice(i);
}

function matchTokens(
	tokens: string[],
	depth: number,
	platform: DangerousCommandPlatform,
	segment: string,
): DangerousCommandMatch | null {
	// Before anything else: a command this deep is one whose nesting this
	// function has stopped being able to follow, and the only safe reading of
	// that is that it is dangerous.
	if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) {
		return { kind: "Other", rule: `nested deeper than ${MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH} wrappers` };
	}
	if (tokens.length === 0) return null;

	// Before both strips below, and on Windows only. They read `if` and `for` as
	// one word each, which is right for a POSIX shell and wrong for CMD's, where
	// `for` answers with a whole clause before it answers with a command. Order
	// is the other half of it: run this second and `if 1==1 del /f C:\x` stops
	// matching, because the assignment strip would take `1==1` first and leave
	// `if del /f C:\x`, whose condition is then read as the program.
	if (platform === "windows") {
		const controlled = stripControlWords(tokens);
		if (controlled !== undefined) return matchTokens(controlled, depth, platform, segment);
	}

	// `LC_ALL=C rm -rf /` sets an environment variable and then runs a command.
	// A POSIX shell reads the assignment prefix as part of the command line, not
	// as a program, so the program is the first word that is not an assignment.
	// `isAssignment` was already here and already consulted — but only *inside*
	// `commandAfterOptions`, which is to say only after a wrapper had been
	// recognised. At the top level it was unreachable.
	//
	// The recursion is safe because the array strictly shrinks: every pass removes
	// at least the word it found, and `commandAfterOptions` below terminates for
	// the same reason. `depth` is deliberately not raised — an assignment is not a
	// wrapper, and counting it as one would spend the depth budget on a word that
	// runs nothing.
	const assigned = stripLeadingAssignments(tokens);
	if (assigned !== tokens) return matchTokens(assigned, depth, platform, segment);

	const command = stripShellScaffolding(tokens);
	if (command !== undefined) return matchTokens(command, depth, platform, segment);

	const program = executableName(tokens[0], platform);
	// Consulted here rather than in `matchScript`, and the difference is not
	// cosmetic. `matchScript` sees each segment exactly once, before any wrapper
	// on it has been stepped over, so anything it consults never sees the command
	// a wrapper was standing in front of. Measured before this was moved here:
	// `sudo git clean -fdx`, `bash -c "git push --force"` and
	// `powershell -Command "docker system prune -a"` each classified as nothing,
	// while the same three commands with the wrapper removed were caught — and the
	// test that found it is the one asserting a wrapper does not hide a command.
	// `git` and the rest are never wrappers themselves, so nothing below here can
	// be reached by unwrapping past them.
	const tool = developmentToolRules(tokens, platform);
	if (tool) return tool;
	if (program === "rm" && rmArgsIncludeForce(tokens.slice(1))) {
		return { kind: "ForcedRm", rule: "`rm` with a force option" };
	}
	// `sudo <cmd>` is `<cmd>`, run as someone else.
	//
	// Options go through the shared skipper, which is the whole fix: this used to
	// hand `tokens.slice(1)` straight back, so every option in front of the command
	// was left where the program name is read. `sudo -u root rm -rf /` — the
	// everyday spelling, and the one a user types rather than the one a test
	// thinks of — classified as nothing.
	if (program === "sudo") {
		return matchTokens(commandAfterOptions(tokens.slice(1), valueOptionsFor("sudo")), depth + 1, platform, segment);
	}
	// `eval "rm -rf /"` is `rm -rf /`, reached through a string instead of
	// through the command line.
	//
	// It is not in Codex's table, and it is here anyway because it was measured:
	// against a real `bash`, `eval "rm -rf D"`, `eval 'rm -rf D'` and
	// `eval rm -rf /` all deleted the directory, and `eval "echo hi"` did not.
	//
	// The string is the script, so the readable case is a script read rather than
	// a shape matched — the same treatment `su -c` and `sh -c` get — and
	// `tokenizeShell` has already unwrapped the quotes, so the script is the
	// words after `eval` rejoined.
	//
	// The unreadable case is the one worth being loud about. `$(...)` and a
	// backtick are filled in when the shell gets there, so `eval "$(cat x.sh)"`
	// runs whatever the file says and there is nothing here to classify. All
	// three of those were measured to run. Reporting them as a match is the same
	// trade this file already makes for `-enc`: one prompt too many is cheaper
	// than a string nobody read running unsupervised.
	if (program === "eval") {
		const script = tokens.slice(1).join(" ");
		if (script === "") return null;
		if (/\$\(|`|\\\$\(/.test(script)) {
			return { kind: "Other", rule: "`eval` on a string the shell fills in at run time" };
		}
		return matchScript(script, depth + 1, platform);
	}
	if (program === "env") {
		// `env -S 'rm -rf /'` does not take a command after the options: it takes
		// a *string*, splits it the way a shell would, and runs the pieces. The
		// words after `-S` are that string, so the shared skipper would step over
		// the command and hand back nothing. Expanding it in place is what keeps
		// this to one skipper for seven wrappers rather than seven near-copies.
		let args = tokens.slice(1);
		const at = args.findIndex((arg) => arg === "-S" || arg === "--split-string");
		const split = at === -1 ? undefined : args[at + 1];
		if (split !== undefined && split !== "-") {
			args = [...args.slice(0, at), ...tokenizeShell(split), ...args.slice(at + 2)];
		}
		return matchTokens(commandAfterOptions(args, valueOptionsFor("env")), depth + 1, platform, segment);
	}
	// `su -c 'rm -rf /'` is `sh -c` under another name — the flag carries the
	// command, so this is a script read rather than options stepped over, and it
	// gets its own branch for that reason rather than joining the list below.
	// `su` also takes a user *before* the flag (`su root -c …`), which is why the
	// flag is looked for anywhere rather than at a fixed offset. `su` with no
	// `-c` starts an interactive login shell, which runs nothing of its own.
	if (program === "su") {
		const at = tokens.indexOf("-c");
		const script = at === -1 ? undefined : tokens[at + 1];
		if (script === undefined || script === "-") return null;
		return matchTokens(["sh", "-c", script], depth + 1, platform, script);
	}
	// `xargs rm -rf` is `rm -rf` once per line of input: a wrapper in exactly
	// the sense `sudo` and `env` are, and the reason `find … | xargs rm -rf` is
	// the ordinary spelling of the delete this file exists to catch.
	if (program === "xargs") {
		return matchTokens(commandAfterOptions(tokens.slice(1), XARGS_VALUE_OPTIONS), depth + 1, platform, segment);
	}
	// Programs that exist to run the command behind them, in the same sense as
	// `sudo`. `command` and `exec` are the sharpest of these: they are POSIX
	// builtins whose entire purpose is to run a name this function would not
	// otherwise recognise, so `command rm -rf /` was classified as nothing at all.
	if (program !== undefined && COMMAND_PREFIX_PROGRAMS.has(program)) {
		return matchTokens(commandAfterOptions(tokens.slice(1), valueOptionsFor(program)), depth + 1, platform, segment);
	}
	// A trap's action is shell source sitting in the first operand.
	if (program === "trap") {
		let i = 1;
		if (tokens[i] === "--") i++;
		const action = tokens[i];
		if (action !== undefined && !action.startsWith("-")) {
			return matchTokens(["sh", "-c", action], depth + 1, platform, action);
		}
		return null;
	}

	// Follow every wrapper this segment contains, each one a level deeper.
	const scripts = [wrapperScript(tokens), powershellScript(tokens), ...substitutionScripts(segment)].filter(
		(script): script is string => script !== undefined,
	);
	for (const script of scripts) {
		for (const inner of splitShellCommands(script)) {
			const match = matchTokens(tokenizeShell(inner), depth + 1, platform, inner);
			if (match) return match;
		}
	}

	if (platform === "windows") {
		return matchWindows(tokens);
	}
	return (
		posixDiskRules(tokens, segment) ??
		posixPermissionRules(tokens) ??
		posixFindRules(tokens) ??
		posixProcessRules(tokens)
	);
}

// ---------------------------------------------------------------------------
// POSIX: destroying a disk
// ---------------------------------------------------------------------------

/**
 * A path that names a whole disk rather than one of the character devices.
 *
 * The point of listing the disk prefixes instead of saying "anything under
 * `/dev`" is that `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/std*` and
 * `/dev/tty` are written to constantly — `> /dev/null` is on the end of a
 * healthy command — and a rule that fired on those would be switched off within
 * a day. The partitions are in here too (`/dev/sda1`, `/dev/nvme0n1p2`), because
 * a redirect onto a partition destroys a filesystem just as completely as one
 * onto the whole disk.
 *
 * NOT MEASURED ON THIS MACHINE, and the comment has to say so: none of these
 * paths exists here. Windows has a `/dev` only through MSYS, and its `sda*`
 * names are a directory listing rather than disks — a `dd of=/dev/sda` run on
 * this box would be writing to a regular file. What *was* measured is that
 * these are the Linux spellings, by name, from the kernel's own device naming
 * (`sd*` SCSI/SATA, `nvme*n*` NVMe, `hd*` IDE, `vd*` virtio, `md*` RAID,
 * `mmcblk*` SD, `mapper/*` LVM and `cryptsetup`). A rule that cannot be run here
 * is still a rule worth having, but it has to be labelled as one rather than
 * dressed up as a measurement.
 *
 * The pattern is anchored at the end, and that is load-bearing in a way that is
 * easy to get wrong: without the anchor the `\d*` after `sd[a-z]+` does nothing
 * at all, because `sd[a-z]+` already matches the `sda` of `/dev/sda1` and stops
 * there. The falsification driver found exactly that — three mutations each
 * narrowing the device list, and not one of them failing a single test — so the
 * trailing `\/?$` is what turns the partition names from decoration into the
 * thing actually being matched.
 */
const BLOCK_DEVICE_PATH =
	/^\/dev\/(?:sd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|hd[a-z]+\d*|vd[a-z]+\d*|xvd[a-z]+\d*|disk\d+|rdisk\d+|md\d+|mmcblk\d+|mapper\/[\w.-]+)\/?$/;

/**
 * Programs whose job is to write a fresh filesystem or a fresh partition table
 * over whatever is already there.
 *
 * `mke2fs` is here as well as `mkfs.ext4` because that is the program's real
 * name — `mkfs.ext4` is a symlink to it — and a table keyed only on the `mkfs`
 * prefix would miss somebody calling the target directly.
 *
 * Also NOT all measurable here, and the split is worth being exact about.
 * `command -v` on this machine finds `shred` and `dd` in `/usr/bin`, and finds
 * an `mke2fs` at `/d/AndroidSDK/platform-tools/mke2fs` — the Android SDK's copy,
 * not a system tool. It finds nothing at all for `mkfs`, `mkfs.ext4`, `mkswap`,
 * `wipefs`, `fdisk`, `sfdisk`, `cfdisk`, `sgdisk` or `parted`, and
 * `ls /usr/bin | grep -E '^(mkfs|mkswap|wipefs|fdisk|parted|sgdisk)'` returns
 * only `shred`. So the `mkfs*`, `wipefs` and partition-table rules below are
 * written from the names and were not run here; the `shred` and `dd` spellings
 * were.
 */
const DISK_WRITING_PROGRAMS: ReadonlySet<string> = new Set([
	"mkfs",
	"mke2fs",
	"mkswap",
	"wipefs",
	"fdisk",
	"sfdisk",
	"cfdisk",
	"gdisk",
	"sgdisk",
	"parted",
	"gparted",
	"partprobe",
	"shred",
]);

/** `mke2fs -t ext4 /dev/sda1` and `mkfs -t xfs /dev/sda1`, which end in a name. */
function mkfsVariant(program: string): boolean {
	return program === "mkfs" || program.startsWith("mkfs.") || program === "mke2fs";
}

/**
 * The read-only spellings of the partition tools, which print a table and change
 * nothing. `--print` is `sgdisk`'s and is here for that reason alone; the other
 * three are shared. None of them is also a way to write: `fdisk`, `sfdisk` and
 * `sgdisk` write through commands (`w`, `mklabel`, `--zap-all`) rather than
 * through a flag that collides with these.
 */
const DISK_LIST_FLAGS: ReadonlySet<string> = new Set(["-l", "--list", "print", "--print"]);

/**
 * Destroying a disk, on the two shapes it comes in.
 *
 * One is a program that writes a filesystem; the other is a shell redirect
 * aimed at a block device, which needs no program at all — `> /dev/sda` after
 * `echo` is enough, and so is `echo x >/dev/sda` with no space at all. That
 * second spelling is why this rule reads the segment as text rather than
 * treating the redirect operator and its target as two separate words: they do
 * not have to be two words, and a rule that assumed they were would miss the
 * shorter of the two spellings.
 *
 * `dd` is neither, and is handled by its output option instead: `dd` is used
 * legitimately all day (`dd if=/dev/zero of=image.img bs=1M count=64`), so a
 * rule that caught the program would catch a disk image being built. Only the
 * `of=` naming a block device is a disk. `of=` is written glued — `of=/dev/sda`
 * — because that is the spelling everybody uses, and no other `dd` option
 * contains the two characters, so looking for them anywhere in the token is
 * unambiguous. The harmless half was run here to fix the spelling: `dd
 * if=/dev/zero of=/dev/null bs=1M count=1` printed `1+0 records out` and wrote
 * nothing anywhere.
 */
function posixDiskRules(tokens: string[], segment: string): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;

	// A redirect is matched on the text and the target is matched by the device
	// shape, which is what keeps this narrow. `2>&1` yields no target because
	// nothing after the `>` begins with a slash, and `> /dev/null` yields one
	// that is not a disk.
	for (const match of segment.matchAll(/>{1,2}\s*(\/[^\s;|&]+)/g)) {
		if (BLOCK_DEVICE_PATH.test(match[1])) {
			return { kind: "Other", rule: `output redirected onto \`${match[1]}\`, which is a whole disk` };
		}
	}

	if (program === "dd") {
		for (const token of tokens.slice(1)) {
			const at = token.indexOf("of=");
			if (at === -1) continue;
			const target = token.slice(at + 3);
			if (BLOCK_DEVICE_PATH.test(target)) {
				return { kind: "Other", rule: `\`dd\` writing to \`${target}\`, which is a whole disk` };
			}
		}
		return null;
	}

	if (!mkfsVariant(program) && !DISK_WRITING_PROGRAMS.has(program)) return null;

	// `shred` is not asked anything: it overwrites a file until nothing of it is
	// left and then deletes it, which is the whole of its purpose and is why it
	// has no read-only spelling worth naming. Both halves of that were run here,
	// on a file this script created: `shred -u -n 1 -z <tempfile>` exited 0 and
	// the file was gone.
	if (program === "shred") {
		return { kind: "Other", rule: "`shred`, which overwrites a file until nothing of it is left" };
	}

	// A filesystem tool needs a device to be pointed at, and a partition tool
	// has a read-only spelling that prints a table and exits. `-l`, `--list` and
	// a bare `print` are those, whether or not a device is named — `fdisk -l
	// /dev/sda` prints and changes nothing, and flagging that would teach people
	// to switch the rule off rather than to read it.
	if (tokens.slice(1).some((arg) => DISK_LIST_FLAGS.has(arg.toLowerCase()))) return null;
	if (tokens.slice(1).some((arg) => BLOCK_DEVICE_PATH.test(arg))) {
		return { kind: "Other", rule: `\`${program}\` pointed at a disk, which overwrites what is on it` };
	}
	// Nothing to point at: `fdisk` on its own opens the first device it can find
	// and waits at a prompt where `w` writes a table. An error, otherwise.
	if (tokens.length === 1) {
		return { kind: "Other", rule: `\`${program}\` with no device named, which opens the first one it finds` };
	}
	return null;
}

/**
 * The directories whose permissions belong to the machine rather than to a
 * project.
 *
 * `/home` and `/Users` are deliberately *not* here. `chmod -R 755 ~/project` and
 * `chown -R me ~/project` are two of the most ordinary commands in software
 * work, and a rule that caught them would be caught by everything. The paths
 * listed are the ones holding the binaries, the configuration and the devices,
 * where a recursive change breaks the machine rather than a checkout.
 *
 * The macOS entries are here because the POSIX half of this file is not
 * Linux-only; `classifyDangerousCommand` takes a `posix` platform rather than
 * distinguishing the two.
 */
const SYSTEM_ROOTS: ReadonlySet<string> = new Set([
	"/",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/usr/bin",
	"/usr/lib",
	"/usr/sbin",
	"/usr/include",
	"/etc",
	"/boot",
	"/dev",
	"/proc",
	"/sys",
	"/root",
	"/System",
	"/Library",
]);

/**
 * The first system root among these arguments, if any.
 *
 * The comparison is on a path *boundary*, not on the letters: `/etc` and
 * `/etc/ssh` are the machine's, `/etcetera` is not. A prefix match without the
 * slash would flag a project directory that happens to start with a system's
 * name, which is a false positive of exactly the kind that makes people stop
 * reading the rule.
 */
function touchesSystemRoot(tokens: string[]): string | undefined {
	for (const token of tokens) {
		// `/` must not be stripped down to the empty string, or the root itself
		// stops matching — which is what the probe caught, with
		// `chown -R root:root /` coming back as nothing at all.
		const path = token.length > 1 ? token.replace(/\/+$/, "") : token;
		if (!path.startsWith("/")) continue;
		if (SYSTEM_ROOTS.has(path)) return path;
		for (const root of SYSTEM_ROOTS) {
			if (root !== "/" && (path === root || path.startsWith(`${root}/`))) return root;
		}
	}
	return undefined;
}

/**
 * A symbolic `chmod` operand: one or more clauses of who, a sign, and what.
 *
 * `u+s`, `ug+s`, `a+rwxs`, `u+s,g-s` are all this shape; `notes+s.txt` and
 * `755` and `/usr/bin/sudo` are not.
 */
const MODE_SYMBOLIC = /^[ugoa]*[-+=][rwxXstugoa]*(?:,[ugoa]*[-+=][rwxXstugoa]*)*$/;

/**
 * Does this argument make a file run as somebody other than its owner?
 *
 * Two spellings and both are real. `chmod 4755 f` puts the setuid bit in the
 * *first* octal digit — a three-digit mode like `755` has no special digit at
 * all, which is why the test is on the length and not on the value — and
 * `chmod u+s f` says the same thing symbolically.
 *
 * MEASURED, and only partly: this machine's GNU coreutils 8.32 accepts
 * `-R, --recursive`, `OCTAL-MODE`, `a+rwx`, `u+s`, `g+s`, `o+w`, `4755`, `2755`
 * and `666`, all with exit 0 and `chmod --help` naming `-R, --recursive`. What
 * could **not** be measured is whether any of them did anything: this is NTFS
 * through MSYS, which has no POSIX mode bits, so `stat -c %a` reported `644`
 * for `4755`, `2755` and `666` alike. The spellings are checked; the effects
 * are taken from the POSIX definition and are not a claim about this machine.
 */
function hasSetIdBit(tokens: string[]): boolean {
	// An argument is only read as a *mode* when it is shaped like one: three or
	// four octal digits, or clauses of `[ugoa]` and a sign and permissions.
	// Checking for a literal `+s` instead is how the probe caught a false
	// positive — `notes+s.txt` is a perfectly good filename, and the earlier
	// "no mode contains a `/`" guard did not rule it out, because that filename
	// has no slash either. The shape test rules it out: there is no `.` in it.
	for (const token of tokens.slice(1)) {
		if (MODE_SYMBOLIC.test(token)) {
			// Only a `+` sets a bit. `chmod -s f` takes the set-user-ID bit *away*,
			// which is the one thing this rule exists to catch nobody doing.
			if (/\+[rwxXstugoa]*s/.test(token)) return true;
			continue;
		}
		if (/^[0-7]{4,}$/.test(token) && (Number(token[0]) & 6) !== 0) return true;
	}
	return false;
}

/**
 * Permissions and ownership, recursively, over the machine.
 *
 * The shape is two conditions and both are needed. A recursive change is
 * ordinary — `chmod -R 755 build/` is in a thousand build scripts — and so is a
 * change to one of these paths — `chmod 755 /etc/nginx.conf` is an admin's
 * afternoon. What is neither is the two together, because that is the command
 * that leaves a machine with nobody able to log into it.
 *
 * The recursion flag may come either side of the mode (`chmod -R 755 /etc` and
 * `chmod 755 -R /etc` are both valid), so it is looked for anywhere rather than
 * at a fixed offset — which is the same reason `dangerousWindowsAdmin` scans
 * every argument rather than the first.
 */
function posixPermissionRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;
	const recursive = tokens
		.slice(1)
		.some((arg) => arg === "-R" || arg === "--recursive" || arg === "-r" || /^--recursive=/.test(arg));

	if (program === "chmod" && hasSetIdBit(tokens)) {
		return { kind: "Other", rule: "`chmod` setting the set-user-ID or set-group-ID bit" };
	}
	if (program !== "chmod" && program !== "chown" && program !== "chgrp") return null;
	if (!recursive) return null;
	const root = touchesSystemRoot(tokens.slice(1));
	if (root === undefined) return null;
	return {
		kind: "Other",
		rule: `\`${program}\` applied recursively to \`${root}\`, which is the machine's`,
	};
}

/** The `find` predicates that run a command on everything they match. */
const FIND_EXEC_PREDICATES: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Commands that destroy a file when `find` hands them one. */
const DELETING_COMMANDS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred"]);

/**
 * Deleting what a search found, without ever naming `rm`.
 *
 * MEASURED on this machine, in a directory this session created: `find . -type
 * f -delete` and `find . -name '*.txt' -exec rm {} +` both removed the files
 * and exited 0, and `find . -delete` took the directory with them.
 *
 * This is the same shape as the `rm -rf` case and it had the same hole. `find`
 * is not in `COMMAND_PREFIX_PROGRAMS`, so nothing unwrapped the `rm` inside
 * `-exec` and every one of these classified as nothing — which is the worst
 * shape a gap can have, because the result is indistinguishable from the
 * ordinary `find . -print` sitting next to it in the transcript.
 *
 * Only the deleting commands are named, never the predicate: `find . -name
 * '*.ts' -exec grep -l todo {} +` is how a codebase is searched and must stay
 * quiet, and a rule that flagged `-exec` would be switched off within a day.
 * `-ok` and `-okdir` are included even though they ask first — the answer to
 * that question is `y` far more often than anyone types `n`.
 *
 * `find … | xargs rm -rf` needs none of this. `xargs` is already unwrapped as
 * a wrapper program further up, and this function deliberately does *not*
 * repeat it: a second, unreachable copy of a rule that already exists is the
 * kind of thing that reads as coverage and measures as nothing.
 */
function posixFindRules(tokens: string[]): DangerousCommandMatch | null {
	if (executableName(tokens[0], "posix") !== "find") return null;
	if (tokens.slice(1).includes("-delete")) {
		return { kind: "Other", rule: "`find -delete`, which removes everything it matches" };
	}
	for (let i = 1; i < tokens.length; i++) {
		if (!FIND_EXEC_PREDICATES.has(tokens[i])) continue;
		const verb = executableName(tokens[i + 1] ?? "", "posix");
		if (verb !== undefined && DELETING_COMMANDS.has(verb)) {
			return { kind: "Other", rule: `\`find\` running \`${verb}\` on everything it matches` };
		}
	}
	return null;
}

/** Signals that leave a process no chance to save anything. */
const FORCED_SIGNALS: ReadonlySet<string> = new Set(["9", "kill", "sigkill", "k"]);

/**
 * Does this argument name the signal `-s`/`--signal` was given, or is it itself
 * the signal?
 *
 * Both spellings exist and both were measured: `kill -9 <pid>`, `kill -KILL
 * <pid>`, `kill -s KILL <pid>`, and `kill -l` on this box's bash builtin answers
 * `KILL  9`, so the two names really are the same signal under two spellings.
 */
function namesForcedSignal(arg: string): boolean {
	// Both spellings are in the set rather than one being derived from the other:
	// `KILL` and `SIGKILL` are two names for signal 9, and `kill -l` on this
	// box's bash answers `KILL  9` for both. Stripping a `sig` prefix would have
	// been the tidier way to say that, and a mutation driver caught that it
	// changes nothing — so the set says both and the strip is not there.
	const bare = arg.replace(/^-+/, "").toLowerCase();
	return FORCED_SIGNALS.has(bare);
}

/**
 * Ending processes, stopping services, and putting the machine away.
 *
 * Three families, and the reason each one is drawn where it is comes from a
 * measurement rather than from an analogy:
 *
 * `kill -9 -1` — MEASURED, safely: signal 0 delivers nothing and exists only to
 * ask "could I signal this", so `kill -0 -1` on this box exited 0, which proves
 * `-1` is parsed as a PID and that it addresses processes this user can reach.
 * A single `kill -9 <pid>` is NOT flagged, and the reason is worth writing down:
 * `trap 'kill $child' TERM` is in every shell script ever written, and a rule
 * that fires on the shape of that is a rule nobody can keep switched on.
 *
 * `pkill`/`killall` — this is the analogue of the Windows `Stop-Process` rule
 * above, which is why the forced form is the one caught and the polite form
 * (`pkill node`, a plain SIGTERM to a dev server) is not. `pkill` is not a
 * binary on this box — `type -a pkill` reports a shell *function* from the
 * Claude Code wrapper, which is exactly the kind of thing worth recording
 * rather than assuming, so the rule is written from POSIX spelling and not from
 * what this machine happens to have.
 *
 * `systemctl`/`launchctl`/`service` — the verbs that *persist* are caught
 * (stop, disable, mask, kill, unload, bootout) and `restart` is not: a service
 * that comes back in five seconds is a disruption, and a service that has been
 * disabled across reboots is a decision nobody made deliberately.
 */
const SERVICE_STOP_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["systemctl", new Set(["stop", "disable", "mask", "kill"])],
	["launchctl", new Set(["unload", "disable", "bootout"])],
	["service", new Set(["stop"])],
]);

/** Programs that stop the machine or the session, with no way to argue. */
const POWER_PROGRAMS: ReadonlySet<string> = new Set(["reboot", "halt", "poweroff"]);

/**
 * `shutdown` switches that put a POSIX machine away.
 *
 * `-c` is not in it and never could be: it *cancels* a pending shutdown.
 */
const POSIX_SHUTDOWN_SWITCHES: ReadonlySet<string> = new Set(["-h", "-r", "-p", "--halt", "--reboot", "--poweroff"]);

function posixProcessRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;
	const args = tokens.slice(1);

	if (program === "kill") {
		// `--` gets no special handling, and that is a decision rather than an
		// oversight: a mutation that stopped reading past it turned out to change
		// nothing at all, because `-1` is a PID and never a flag or a signal, so
		// it is found wherever it sits. Code that cannot be distinguished from its
		// own deletion is not coverage.
		if (!args.includes("-1")) return null;
		return {
			kind: "Other",
			rule: "`kill` sent to `-1`, which is every process the user owns",
		};
	}

	if (program === "pkill" || program === "killall") {
		if (!args.some(namesForcedSignal)) return null;
		return {
			kind: "Other",
			rule: `\`${program}\` with an unignorable signal, which ends every process it names`,
		};
	}

	const verbs = SERVICE_STOP_VERBS.get(program);
	if (verbs !== undefined) {
		for (const token of args) {
			if (!token.startsWith("-") && verbs.has(token.toLowerCase())) {
				return { kind: "Other", rule: `\`${program} ${token}\`, which stops a service` };
			}
		}
		return null;
	}

	// `shutdown` is Windows' program on this machine — `type -a shutdown`
	// resolves it to `C:\Windows\system32\sutdown` — so its POSIX switches are
	// taken from POSIX, not from what running it here would do.
	if (program === "shutdown") {
		if (!args.some((arg) => POSIX_SHUTDOWN_SWITCHES.has(arg))) {
			return null;
		}
		return { kind: "Other", rule: "`shutdown`, which powers the machine off or restarts it" };
	}

	// `init 0` and `telinit 0` are the SysV spellings: the runlevel is the
	// argument and 0 is halt.
	if (program === "init" || program === "telinit") {
		if (!args.some((arg) => arg === "0" || arg === "6")) return null;
		return { kind: "Other", rule: `\`${program} ${args[0]}\`, which halts the machine` };
	}

	if (POWER_PROGRAMS.has(program)) {
		return { kind: "Other", rule: `\`${program}\`, which powers the machine off or restarts it` };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Windows: PowerShell cmdlets, CMD builtins, and ShellExecute-style launches
// ---------------------------------------------------------------------------

/** Strip the punctuation PowerShell glues around a bareword. */
function bareWord(token: string): string {
	return token
		.replace(/^['"]+/, "")
		.replace(/['"]+$/, "")
		.toLowerCase();
}

const URL_SHAPE_RE = /^[ "'(\s]*([^\s"');]+)[\s;)]*$/;

/**
 * Does this argument name a web address?
 *
 * The URL may be glued to other text (`Start-Process('https://…')`), so the
 * search starts at the scheme rather than at the beginning of the token. What
 * matters is the destination, not the spelling: these are the launches where
 * the *point* of the command is to hand a URL to something that will fetch or
 * render it, which is the shape a prompt injection takes.
 */
function looksLikeUrl(token: string): string | undefined {
	const lower = token.toLowerCase();
	const at = lower.indexOf("https://");
	const from = at === -1 ? lower.indexOf("http://") : at;
	const candidate = from === -1 ? token : token.slice(from);
	const shaped = URL_SHAPE_RE.exec(candidate);
	const url = shaped ? shaped[1] : candidate;
	if (!/^https?:\/\//i.test(url)) return undefined;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

function argsHaveUrl(args: string[]): boolean {
	return args.some((arg) => looksLikeUrl(arg) !== undefined);
}

/** `Remove-Item -Force` and the aliases that mean the same thing. */
const DELETE_CMDLETS = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
const SEGMENT_SEPARATORS = /[;|&\n\r\t]/;
const SOFT_SEPARATORS = /[{}()[\],;]/;

/**
 * The command segments of a Windows invocation, with the punctuation that can
 * glue a word to its neighbours split off.
 *
 * The tokenizer has already separated words on whitespace, so only the soft
 * separators are split here: these are the places where a cmdlet and its
 * arguments can arrive as one token, and a rule that compared whole tokens
 * would not see the cmdlet in `Invoke-Expression(Invoke-WebRequest https://…)`.
 */
function windowsSegments(tokens: string[]): string[][] {
	const segments: string[][] = [[]];
	for (const token of tokens) {
		const pieces = token.split(SEGMENT_SEPARATORS);
		for (let i = 0; i < pieces.length; i++) {
			const piece = pieces[i].trim();
			if (i < pieces.length - 1) {
				if (piece) segments[segments.length - 1].push(piece);
				segments.push([]);
			} else if (piece) {
				segments[segments.length - 1].push(piece);
			}
		}
	}

	return segments.map((segment) =>
		segment.flatMap((token) => token.split(SOFT_SEPARATORS).map((word) => word.trim())).filter(Boolean),
	);
}

/**
 * A delete cmdlet and a force flag in the *same* command segment.
 *
 * The segmenting is the point: `Remove-Item x; Write-Host -Force` has both
 * words and deletes nothing, and flagging it would be the classifier crying
 * wolf often enough that a user learns to dismiss it.
 */
/**
 * The spellings of `-Force` that PowerShell actually binds.
 *
 * Measured on all seven names in `DELETE_CMDLETS` — they are aliases of one
 * cmdlet, and each one was run rather than assumed, against a directory this
 * repository created for the purpose: `-Force`, `-Forc`, `-For` and `-Fo` each
 * deleted it, `-Force:$true` and `-fo:$true` each deleted it, `-F` failed with
 * `AmbiguousParameter` (`-Filter` is also an `F`), and `-foo` failed with
 * `NamedParameterNotFound`.
 *
 * That pair is the reason this is the set PowerShell accepts rather than a
 * `startsWith("-fo")`: the shorter rule would flag commands that fail to parse,
 * and `-F` — the spelling a person reaches for first — has to stay out, because
 * including it would mean this file claims a delete that PowerShell refuses to
 * perform. The two-character prefix is what `shortest` leaves off.
 */
const FORCE_PARAMETER_SPELLINGS = switchPrefixes("force", 3);

/** `-Force` in any spelling PowerShell binds, with or without a value. */
function isForceParameter(word: string): boolean {
	// `-Force:$true` binds the way `-Force` does, and `-F:$true` is exactly as
	// ambiguous as `-F`, so the value is split off before the spelling is read.
	return FORCE_PARAMETER_SPELLINGS.has(word.toLowerCase().split(":", 1)[0]);
}

function hasForceDeleteCmdlet(tokens: string[]): boolean {
	return windowsSegments(tokens).some((segment) => {
		let hasDelete = false;
		let hasForce = false;
		for (const word of segment) {
			if (DELETE_CMDLETS.has(word.toLowerCase())) hasDelete = true;
			if (isForceParameter(word)) hasForce = true;
		}
		return hasDelete && hasForce;
	});
}

/**
 * The spellings this function reads as running a string as PowerShell code.
 *
 * `iex` is the documented alias of `Invoke-Expression`. `Invoke-Expr` is not a
 * name PowerShell defines, and is here because a word that is nearly the
 * dangerous one is worth a question rather than a run.
 */
const EVAL_CMDLETS = new Set(["invoke-expression", "invoke-expr", "iex"]);

/**
 * The names this function reads a download under. None of them is a rule on
 * its own — reading a web address is ordinary work, and a rule that flagged
 * every fetch would be the classifier crying wolf. Every entry is read in
 * exactly one place, inside a segment whose command has already been found to
 * be an eval cmdlet, so a name here can change which reason is reported and
 * cannot add a match on its own. `curl` and `wget` are here for the case where
 * an eval cmdlet is handed one of those instead of a PowerShell cmdlet.
 */
const FETCH_CMDLETS = new Set([
	"invoke-webrequest",
	"iwr",
	"invoke-restmethod",
	"irm",
	"start-bitstransfer",
	"curl",
	"wget",
]);

/**
 * Code that was written somewhere else being run here.
 *
 * Three shapes, in the order they are reported:
 *
 * - **Fetch into eval.** A fetch cmdlet, a URL and an eval cmdlet in one
 *   segment is the download-and-execute idiom, and the pair is what makes it
 *   one. Either half alone is ordinary, so neither half is a rule. In
 *   `iwr https://… | iex` the `|` splits the line first, so this shape is the
 *   one that arrives glued instead — `iex (iwr https://…)`.
 * - **Eval on its own.** `Invoke-Expression` runs a string as code, which is
 *   `eval` with a different spelling, and it is a rule on its own because
 *   there is no argument that makes it safe. It is also what catches the
 *   `iex` at the end of a `| iex` pipeline, which the pair rule above never
 *   sees because the `|` has already put the two halves in different
 *   segments.
 * - **Dot-sourcing.** `. .\setup.ps1` runs a file's contents as code. The
 *   token has to be *only* a dot: `./setup.ps1`, `.\setup.ps1`, `..` and `.5`
 *   all begin with one and are not it.
 *
 * Each is read at the *head* of a segment and by whole word, so neither
 * `Write-Output iex` nor `Select-String iwr` matches: an alias that is an
 * argument is a pattern or a message, not a command.
 *
 * Codex's `windows_dangerous_commands.rs` has no rules for any of these three
 * — its PowerShell rules are the URL/launcher rules and the forced delete, and
 * nothing else — so this is a divergence from the file this is ported from,
 * not a port of it.
 */
/**
 * The execution policies that stop checking whether a script should run.
 *
 * Measured on this machine, from
 * `[Enum]::GetNames([Microsoft.PowerShell.ExecutionPolicy])`:
 * `Unrestricted, RemoteSigned, AllSigned, Restricted, Default, Bypass, Undefined`.
 * Only three of the seven belong here. `Restricted` refuses to run any script
 * that is not signed, `AllSigned` requires all of them to be, `RemoteSigned`
 * requires local ones to be, and `Default` means "whatever the machine is set
 * to" — flagging any of those would flag a machine being made *safer*.
 */
const WEAK_EXECUTION_POLICIES = new Set(["unrestricted", "bypass", "undefined"]);

/**
 * A registry path that runs something every time the machine starts.
 *
 * `Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'` is true on
 * this machine, so the key is where it has always been. `RunOnce` is the same
 * idea for one boot. Installers do write to both, and a user setting something
 * to launch on login is not doing anything wrong either — which is why this
 * matches the *path* and not the program: `Set-ItemProperty` and `reg add` are
 * how the rest of the registry gets configured, and a rule that caught them all
 * would catch a machine being set up.
 */
function isRunKeyPath(token: string): boolean {
	return /\\currentversion\\run(once)?\b/i.test(token);
}

/**
 * The value that decides whether UAC prompts at all.
 *
 * Both spellings, because both are real: post-Vista it is `EnableLUA` and the
 * prompt is off when it is `0`; pre-Vista it is `DisableLUA` and the prompt is
 * off when it is `1`. The leading `[:.-]` is so a parameter written the way
 * PowerShell accepts it — `-Name:EnableLUA` — is still recognised, and the `\b`
 * is what keeps `EnableLUAOld` from reading as this one.
 */
function isUacValueName(token: string): boolean {
	return /(?:^|[:.-])(?:enable|disable)lua\b/i.test(token);
}

/**
 * Cmdlets that turn a protection off, and nothing else.
 *
 * Not in Codex's table. Every name and parameter here was read off this
 * machine's own PowerShell 5.1 rather than recalled, because a rule written
 * against a parameter that does not exist guards nothing:
 *
 *   * `Set-MpPreference` has thirty-four parameters beginning `Disable`, from
 *     `DisableRealtimeMonitoring` through `DisableTamperProtection`. They are
 *     matched by that prefix rather than listed, so a Windows update that adds
 *     one is covered by the rule already rather than by a second edit.
 *   * `Add-MpPreference` takes `ExclusionPath`, `ExclusionExtension`,
 *     `ExclusionProcess` and `ExclusionIpAddress` — a path excluded from
 *     scanning is a path nothing will ever find malware on.
 *   * `Disable-LocalUser` and `Unblock-File` both exist.
 *
 * The UAC spelling is worth naming because the obvious one is wrong: the live
 * key is `HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`
 * `EnableLUA`, which is `1` on this machine. `...\Control\LSA\DisableLUA` is the
 * pre-Vista spelling and does not exist here.
 */
function powershellWeakeningRules(lower: string[]): DangerousCommandMatch | null {
	for (const segment of windowsSegments(lower)) {
		const head = segment[0];
		if (head === undefined) continue;

		if (head === "set-executionpolicy" && segment.some((w) => WEAK_EXECUTION_POLICIES.has(w))) {
			return { kind: "Other", rule: "PowerShell `Set-ExecutionPolicy` turning script checking off" };
		}
		if (head === "set-mppreference" && segment.some((w) => w.startsWith("-disable"))) {
			// The parameter is flagged whatever its value is, and that includes
			// `-DisableRealtimeMonitoring $false`, which turns Defender back on.
			// Telling those apart means reading the value, and the value may be
			// glued (`-DisableX:$false`), separate (`-DisableX $false`) or absent —
			// and absent means "use the default", which for a `Disable*` parameter
			// is the disabling one. A rule that guessed would be wrong in the
			// direction that matters: skipping the absent case is a hole.
			return { kind: "Other", rule: "PowerShell `Set-MpPreference` on a `Disable*` setting" };
		}
		if (head === "add-mppreference" && segment.some((w) => w.startsWith("-exclusion"))) {
			return { kind: "Other", rule: "PowerShell `Add-MpPreference` excluding a path from scanning" };
		}
		if (head === "disable-localuser") {
			return { kind: "Other", rule: "PowerShell `Disable-LocalUser`, which locks an account out" };
		}
		// Two independent things, checked apart rather than as one conjunction:
		// writing a value under the startup key does not mention UAC, and turning
		// UAC off does not live under the startup key.
		if (head === "set-itemproperty" || head === "new-itemproperty") {
			if (segment.some(isRunKeyPath)) {
				return { kind: "Other", rule: "PowerShell writing a value to a key that runs at startup" };
			}
			if (segment.some((w) => /\\policies\\system\b/.test(w)) && segment.some(isUacValueName)) {
				return { kind: "Other", rule: "PowerShell writing `EnableLUA`, the value the UAC prompt reads" };
			}
		}
	}
	return null;
}

/**
 * Ending a process.
 *
 * This is *not* the `taskkill /f` rule wearing a different name, and the
 * difference was measured rather than assumed, because assuming it by analogy
 * would have put a `-Force` on the rule and left the common form uncovered.
 *
 * `taskkill` without `/f` asks a window to close. `Stop-Process` without
 * `-Force` terminated a process just the same, on this machine: a sleeper
 * started with `Start-Process -PassThru` read ALIVE, then `Stop-Process -Id
 * <pid>` with no switch at all, then GONE — identical to the `-Force` run on a
 * second sleeper. The control is what makes that reading mean something:
 * `Get-Process -Id` on a pid nothing owns also prints GONE, without anything
 * having been stopped, so "GONE after" proves nothing on its own. "ALIVE
 * before" is the half that carries it.
 */
function powershellTerminationRules(lower: string[]): DangerousCommandMatch | null {
	for (const segment of windowsSegments(lower)) {
		// MEASURED by `Get-Command` on this machine, which is why the list is
		// four and not five: `Stop-Service`, `Stop-Computer`, `Restart-Computer`
		// and `Stop-Process` all resolve to a Cmdlet in
		// Microsoft.PowerShell.Management, and `Suspend-Computer` does not exist
		// at all — the check that fails is the one that makes the list mean
		// something.
		//
		// `Stop-Job` is deliberately absent: a job is something this session
		// started, and ending it discards that work and nothing else.
		//
		// `Stop-Service` is here, and it used not to be. The earlier reasoning —
		// stopping a service is what a service is for — is sound, but it is the
		// same reasoning that would excuse POSIX `systemctl stop sshd`, which
		// IS a rule. Flagging one and not the other would mean the same act
		// judged by different standards on different platforms, so both are in.
		if (segment[0] === "stop-process") {
			return { kind: "Other", rule: "PowerShell `Stop-Process`, which ends a process" };
		}
		if (segment[0] === "stop-service") {
			return { kind: "Other", rule: "PowerShell `Stop-Service`, which stops a system service" };
		}
		if (segment[0] === "stop-computer" || segment[0] === "restart-computer") {
			return { kind: "Other", rule: `PowerShell \`${segment[0]}\`, which powers the machine off or restarts it` };
		}
	}
	return null;
}

function powershellExecutionRules(lower: string[]): DangerousCommandMatch | null {
	for (const segment of windowsSegments(lower)) {
		const head = segment[0];
		if (head === undefined) continue;
		if (head === ".") {
			return { kind: "Other", rule: "PowerShell dot-sourcing a script with `.`" };
		}
		if (!EVAL_CMDLETS.has(head)) continue;
		if (segment.some((word) => FETCH_CMDLETS.has(word)) && segment.some((word) => looksLikeUrl(word) !== undefined)) {
			return { kind: "Other", rule: "PowerShell fetching a URL and running it" };
		}
		return { kind: "Other", rule: "PowerShell `Invoke-Expression` running a string as code" };
	}
	return null;
}

function dangerousPowershellWords(words: string[]): DangerousCommandMatch | null {
	const lower = words.map(bareWord);
	const hasUrl = argsHaveUrl(words);

	const launcher = lower.some(
		(t) =>
			t === "start-process" ||
			t === "start" ||
			t === "saps" ||
			t === "invoke-item" ||
			t === "ii" ||
			t.includes("start-process") ||
			t.includes("invoke-item"),
	);
	if (hasUrl && launcher) {
		return { kind: "Other", rule: "PowerShell handing a URL to a launcher (`Start-Process`/`Invoke-Item`)" };
	}

	if (hasUrl && lower.some((t) => t.includes("shellexecute") || t.includes("shell.application"))) {
		return { kind: "Other", rule: "PowerShell reaching `ShellExecute` with a URL" };
	}

	const first = lower[0];
	if (first !== undefined) {
		if (first === "rundll32" && lower.some((t) => t.includes("url.dll,fileprotocolhandler")) && hasUrl) {
			return { kind: "Other", rule: "`rundll32 url.dll,FileProtocolHandler` with a URL" };
		}
		if (first === "mshta" && hasUrl) {
			return { kind: "Other", rule: "`mshta` with a URL" };
		}
		if (BROWSER_EXECUTABLES.has(first) && hasUrl) {
			return { kind: "Other", rule: "a browser executable invoked with a URL" };
		}
		if ((first === "explorer" || first === "explorer.exe") && hasUrl) {
			return { kind: "Other", rule: "`explorer` with a URL" };
		}
	}

	if (hasForceDeleteCmdlet(lower)) {
		return { kind: "Other", rule: "a delete cmdlet with `-Force`" };
	}
	return powershellExecutionRules(lower) ?? powershellWeakeningRules(lower) ?? powershellTerminationRules(lower);
}

/** Split a CMD token on the operators that can be written inside one word. */
function splitCmdOperators(token: string): string[] {
	return token.split(/(&&|\|\||[&|])/).filter((part) => part.trim().length > 0);
}

const CMD_SEPARATORS = new Set(["&", "&&", "|", "||"]);

/**
 * The switches that introduce a CMD body, and that a body may itself open with.
 *
 * `/k` is here and not in Codex's list at
 * `windows_dangerous_commands.rs:105`. `/k` does not run the body and leave; it
 * runs the body and *then* leaves a prompt open, so everything `/c` would have
 * run, it runs first.
 */
const CMD_BODY_SWITCHES = new Set(["/c", "/k", "/r", "-c"]);

function dangerousCmd(tokens: string[], depth = 0): DangerousCommandMatch | null {
	// A body may open with another `cmd`, and each one runs whatever comes after
	// it: measured, `cmd /c cmd /c rd /s /q C:\x` and `cmd /c cmd /k rd /s /q
	// C:\x` both deleted, and so did the quoted form `cmd /c "cmd /c rd /s /q
	// C:\x"` — which is why this re-enters rather than being a second reading of
	// the same words. The body has already been split above, so the words reaching
	// here are the ones the next shell would see.
	if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) {
		return { kind: "Other", rule: `nested deeper than ${MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH} wrappers` };
	}
	if (tokens.length === 0) return null;
	const program = executableName(tokens[0], "windows");
	if (program !== "cmd" && program !== "cmd.exe") return null;

	// Skip the switches up to `/c`; an unrecognized word before the body means
	// this is not the shape this reads.
	const rest = tokens.slice(1);
	let i = 0;
	for (; i < rest.length; i++) {
		const lower = rest[i].toLowerCase();
		if (CMD_BODY_SWITCHES.has(lower)) break;
		if (lower.startsWith("/")) continue;
		return null;
	}
	// One switch does not end the switches. `cmd /k /c rd /s /q C:\x` runs the
	// delete through the inner `/c` and then leaves a prompt open, so a second
	// switch between the one that was found and the body is the same body
	// starting one word later. Only these switches are skipped; an unrecognized
	// `/x` still falls through to the word after it and ends the shape, which
	// is what the loop above decides.
	let start = i + 1;
	while (start < rest.length && CMD_BODY_SWITCHES.has(rest[start].toLowerCase())) start++;
	const body = rest.slice(start);
	if (body.length === 0) return null;

	const words = (body.length === 1 ? (body[0].split(/\s+/).filter(Boolean) as string[]) : body).flatMap(
		splitCmdOperators,
	);
	// The body is read against PowerShell's words as well as CMD's. The body of
	// a `/c` arrives as *one* argument — a quoted `"Remove-Item C:\x -Force"`
	// is a single token until it is split, and until it is split every word
	// rule sees is one long word that matches nothing. This is the same move
	// `powershellScript` makes for `-Command`, and the same reason: an
	// unrecognised shape is read against the rules of every shell that could be
	// the one running it, never as "nothing here".
	//
	// A body that opens with `cmd` is the one shape this function could not read
	// before: nothing below re-enters, so `cmd /c cmd /c del /f C:\x` was read
	// as the word `cmd` and stopped. The depth is the same bound the wrappers
	// use, because a body of `cmd`s is nesting of the same kind.
	const nested = words.length > 0 ? executableName(words[0], "windows") : undefined;
	if (nested === "cmd" || nested === "cmd.exe") {
		const match = dangerousCmd(words, depth + 1);
		if (match) return match;
	}
	// A body is not only builtins. `cmd /c "git clean -fdx"` and `cmd /c "docker
	// system prune -a"` are ordinary ways to type the two commands those tables
	// do not contain, and both are spelled with the `cmd` in front so that
	// whatever launches the line does not have to know what `git` is. Consulted
	// last so that a builtin still gets to name itself; the reason it is
	// consulted at all is the one in the comment above — a body is read against
	// every shell that could be the one running it, never as "nothing here".
	const tool = developmentToolRules(words, "windows");
	if (tool) return tool;
	return dangerousCmdBody(words) ?? dangerousPowershellWords(words);
}

/**
 * The CMD builtins, read over one command's words.
 *
 * These are the builtins of a single shell, so they are read wherever CMD could
 * be the thing running them: after a `cmd /c`, and at the top level of a
 * Windows line, because that is what the line becomes once a tool hands it to
 * `cmd.exe`. A chain spelled `cmd /c echo hi && rd /s /q C:\x` splits into two
 * segments and only the first of them says `cmd` — the second is a CMD body all
 * the same, and reading it as anything else is a miss.
 *
 * Neither rule fires without the flag that takes the asking away. `rd /s` still
 * prompts, `rd /s /q` does not, and a rule that could not tell those apart would
 * be crying wolf on the ordinary spelling of a recursive delete.
 */
function dangerousCmdBody(words: string[]): DangerousCommandMatch | null {
	let segment: string[] = [];
	for (const word of words) {
		if (CMD_SEPARATORS.has(word)) {
			const match = dangerousCmdSegment(segment);
			if (match) return match;
			segment = [];
			continue;
		}
		segment.push(word);
	}
	// The words after the last `&`/`|` are a segment no separator ever closes, and
	// `cmd /c del /f C:\x` is nothing *but* that segment — so it is checked here
	// rather than by a sentinel appended to the word list. It was a sentinel until
	// now, and the sentinel was a NUL byte, which is a value no word can be
	// *and* a value that makes the whole file binary: `file` reported `data`, and
	// `grep` stopped reporting lines from it, so the file the classifier lives in
	// became the one file nobody could search. A separate call for the tail needs
	// no such value to exist.
	return dangerousCmdSegment(segment);
}

/** What one CMD segment's words match, or `null` for the ordinary ones. */
function dangerousCmdSegment(segment: string[]): DangerousCommandMatch | null {
	// A `cmd /c` body arrives here as a word array that the strips in
	// `matchTokens` never touched, so a control word inside one is still sitting
	// at the head of its segment: `cmd /c if exist C:\x rd /s /q C:\y` and
	// `cmd /c for /f %i in (x) do del /f C:\y` both measured as running the
	// delete, and both were read as the word `if` and the word `for`.
	const controlled = stripControlWords(segment);
	if (controlled !== undefined) return dangerousCmdSegment(controlled);

	const head = segment[0]?.toLowerCase();
	if (head === undefined) return null;
	if (head === "start" && argsHaveUrl(segment)) {
		return { kind: "Other", rule: "`start` with a URL" };
	}
	const hasFlag = (flag: string) => segment.some((t) => t.toLowerCase() === flag);
	if ((head === "del" || head === "erase") && hasFlag("/f")) {
		return { kind: "Other", rule: "`del /f` (forced delete)" };
	}
	if ((head === "rd" || head === "rmdir") && hasFlag("/s") && hasFlag("/q")) {
		return { kind: "Other", rule: "`rd /s /q` (silent recursive delete)" };
	}
	return null;
}

/** A GUI app or protocol handler launched directly with a URL in its argv. */
function directGuiLaunch(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "windows");
	if (program === undefined) return null;
	const rest = tokens.slice(1);
	const hasUrl = argsHaveUrl(rest);

	if ((program === "explorer" || program === "explorer.exe") && hasUrl) {
		return { kind: "Other", rule: "`explorer` with a URL" };
	}
	if ((program === "mshta" || program === "mshta.exe") && hasUrl) {
		return { kind: "Other", rule: "`mshta` with a URL" };
	}
	if (
		(program === "rundll32" || program === "rundll32.exe") &&
		rest.some((t) => t.toLowerCase().includes("url.dll,fileprotocolhandler")) &&
		hasUrl
	) {
		return { kind: "Other", rule: "`rundll32 url.dll,FileProtocolHandler` with a URL" };
	}
	if (BROWSER_EXECUTABLES.has(program) && hasUrl) {
		return { kind: "Other", rule: "a browser executable invoked with a URL" };
	}
	return null;
}

/**
 * Windows-only checks.
 *
 * Codex reaches its PowerShell rules through a tree-sitter parse of the script
 * (`powershell_tree_sitter.rs`) and keeps the token scan below as the fallback
 * for a line that will not parse. There is no tree-sitter here, so this is the
 * fallback shape on its own — which is why the PowerShell entry point is
 * reached by tokenizing the whole invocation rather than parsing a script
 * body. A constructed cmdlet (`& ("Remove-" + "Item") -Force`) is invisible to
 * it. That gap is a real limit of this function, not a bug in it, and it is
 * why the engine treats a match as something to stop and a non-match as only
 * ever "nothing was recognized", never "this is safe".
 */
/**
 * The argument words of a PowerShell invocation, with a script body opened up.
 *
 * The body of `-Command "…"` arrives as one token — correctly, since it *is* one
 * argument — but every rule above is a word rule, so a quoted script has to be
 * read as the sequence of words it is before a cmdlet and a flag can be found in
 * the same segment. Only the body is expanded. Every other argument is left
 * whole, because a quoted string that merely *mentions* `Remove-Item` is not a
 * command, and a classifier that reads it as one is one the user learns to
 * dismiss.
 *
 * `-EncodedCommand` is *not* expanded here, and that is a measured decision
 * rather than an oversight. `powershellScript` already reads an encoded body —
 * into the full rule set, which strictly includes the word rules below — and it
 * reaches the first script switch on the line, which is the one the host uses.
 * The only inputs this function could add are ones where an earlier switch has
 * already claimed the script slot and the encoded body therefore never runs.
 * Expanding it here would mean flagging `powershell -c "Get-Process" -enc <body>`
 * as dangerous, and PowerShell hands that `<body>` to `Get-Process` as an
 * argument rather than executing it.
 */
function powershellWords(tokens: string[]): string[] {
	const words: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		const lower = tokens[i].toLowerCase();
		if (POWERSHELL_COMMAND_SWITCH.has(lower) && i + 1 < tokens.length) {
			words.push(...tokens[i + 1].split(/\s+/).filter(Boolean));
			i++;
			continue;
		}
		words.push(tokens[i]);
	}
	return words;
}

function matchWindows(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "windows");
	if (program !== undefined && POWERSHELL_EXECUTABLES.has(program)) {
		const match = dangerousPowershellWords(powershellWords(tokens));
		if (match) return match;
	}
	// A Windows line is a line for whichever shell the tool layer picks, and this
	// function is not told which — so below the explicit `cmd`/`powershell` case
	// both vocabularies are read against the line as it stands. Each rule is
	// still its own shell's: a line that says `Remove-Item` and `-Force` is
	// PowerShell's to run and PowerShell's to answer for, and a line that says
	// `del /f` is CMD's whichever shell ends up reading it. What this cannot be
	// is a way to run a line in a shell whose vocabulary is *neither*, and no
	// such vocabulary has these words in it.
	return (
		dangerousCmd(tokens) ??
		dangerousCmdBody(tokens) ??
		dangerousPowershellWords(tokens) ??
		directGuiLaunch(tokens) ??
		dangerousWindowsAdmin(tokens)
	);
}

/**
 * Windows administrative programs, and the verbs that make them destructive.
 *
 * These are not in Codex's table at all — Codex flags a forced `rm` and a URL
 * being launched, and nothing here. They are here because each one is a thing
 * that destroys a machine's state and can be undone by nothing the user has.
 *
 * Almost none of them is dangerous in *every* form, which is why this is a
 * program and a verb rather than a program. `wevtutil el` lists the event log
 * channels, `sc query` reads a service, `cipher /c` reports encryption, `bcdedit
 * /enum` reads the boot configuration, `schtasks /query` lists tasks, `netsh
 * advfirewall show` prints the firewall state, and `net user` with no password
 * prints an account. A rule that fired on the program alone would be a rule that
 * fires on six read-only commands a person runs to *look* at the machine, and a
 * classifier like that gets switched off.
 *
 * Measured: every program named here exists on this machine under the spelling
 * the rule matches, and accepts the switch form written against it —
 * `format` (which answered "Required parameter missing" rather than "not
 * recognized"), `diskpart`, `reg`, `taskkill`, `vssadmin`, `bcdedit`,
 * `schtasks`, `net`, `sc`, `cipher`, `takeown`, `icacls`, `wevtutil`,
 * `bitsadmin`, `netsh`. They live in `C:\Windows\System32` with an `.exe`
 * extension, `format` excepted — it is a `.com`, which `executableName` already
 * strips alongside the others.
 *
 * Not measured, deliberately: that any of them actually destroys anything. None
 * was run in its destructive form. `format C:` was not run because it would
 * erase the volume, `vssadmin delete shadows /all` and `cipher /w:` were not run
 * for the same reason, and `icacls /grant` and `takeown /f` were not run because
 * they change a real file's ACLs and owner. What a rule needs from a measurement
 * is that the program and the switch are spelled the way the rule expects, and
 * that is what was measured.
 */
const WINDOWS_ADMIN_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	// `reg import` is left out on purpose: `import` is also `bcdedit import`, and a
	// verb set is per-program here, so nothing would go wrong -- but `reg import`
	// of a key is closer to `reg export` in shape than to `reg delete`, and
	// leaving it out is the smaller claim.
	["reg", new Set(["delete"])],
	["schtasks", new Set(["/delete", "/create", "/change", "/run"])],
	["sc", new Set(["config", "stop", "delete", "create"])],
	["vssadmin", new Set(["delete", "resize"])],
	["bcdedit", new Set(["/delete", "/set", "/import", "/create"])],
	["wevtutil", new Set(["cl", "del"])],
	["cipher", new Set(["/w"])],
	["bitsadmin", new Set(["/transfer", "/create", "/addfile"])],
	["netsh", new Set(["set", "delete", "add"])],
	["taskkill", new Set(["/f"])],
	// `net user` on its own prints every account on the machine, and
	// `net user <name>` prints one -- both measured as the listing commands they
	// are. What is not a listing is `/add`, which creates an account or a group,
	// and a bare `net user <name> <password>`, which resets one. The second shape
	// is caught by count rather than by a verb because the password is just a
	// word; see `dangerousWindowsAdmin`.
	["net", new Set(["/add"])],
	["icacls", new Set(["/grant", "/deny", "/remove", "/setowner", "/reset"])],
	// The pre-2021 spelling of what `Stop-Process` does, and the other half of
	// the same batch: `wmic process where "name='x'" delete` ends a process the
	// same way, and `wmic process call terminate` reaches WMI's own method for
	// it. `terminate` has to be in the set because it arrives *after* `call`, so
	// reading the first argument would never see it.
	//
	// Not measured: `wmic.exe` is not on this machine's disk. A `existsSync` over
	// `C:\Windows\System32`, `C:\Windows\SysWOW64` and `C:\Windows` finds no
	// `wmic.exe` in any of them — Windows 11 removed it. The rule is kept
	// because older builds and a great many scripts still use it, and "not
	// installed here" is a fact about this machine rather than a reason to leave
	// the act uncovered.
	["wmic", new Set(["delete", "terminate"])],
]);

/**
 * Windows administrative programs where the program name is the whole story.
 *
 * `format` reformats a volume whatever it is told, `diskpart` is a disk
 * partitioning tool whatever it is pointed at, and `takeown` hands ownership to
 * whoever runs it. There is no read-only spelling of any of the three.
 */
const WINDOWS_ADMIN_ALWAYS: ReadonlyMap<string, string> = new Map([
	["format", "reformats a volume, which cannot be undone"],
	["diskpart", "runs a disk partitioning script, which can erase a volume"],
	["takeown", "takes ownership of files away from whoever had it"],
]);

/**
 * Does an argument name this verb?
 *
 * Exact for a bare word, and prefix-with-a-boundary for a switch: `cipher /w:C`
 * is `/w` with a volume attached, but `bcdedit /setup` is not `/set`. The
 * boundary is what tells those apart — a switch matches when the rest is empty
 * or does not start with a letter or a digit.
 */
function verbMatches(token: string, known: string): boolean {
	const lower = token.toLowerCase();
	if (lower === known) return true;
	if (!known.startsWith("/") && !known.startsWith("-")) return false;
	if (!lower.startsWith(known)) return false;
	const rest = lower.slice(known.length);
	return rest === "" || !/^[A-Za-z0-9]/.test(rest);
}

/**
 * `shutdown.exe` switches that put the machine away.
 *
 * Read out of `shutdown /?` on this box: `/s` and `/sg` and `/g` shut it down,
 * `/r` restarts it, `/p` and `/h` power it off and hibernate it, `/hybrid`
 * closes the lid's way and `/fw` boots straight into firmware. `/i`, `/l`, `/a`,
 * `/e`, `/o` and `/?` are left out, and `/a` most of all — it is the undo.
 */
const WINDOWS_SHUTDOWN_SWITCHES: readonly string[] = ["/s", "/sg", "/g", "/r", "/p", "/h", "/hybrid", "/fw"];

/** The Windows administrative rules, applied to one command line. */
function dangerousWindowsAdmin(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "windows");
	if (program === undefined) return null;

	const always = WINDOWS_ADMIN_ALWAYS.get(program);
	if (always !== undefined) {
		return { kind: "Other", rule: `\`${program}\` — ${always}` };
	}

	// `shutdown` powers the machine off. Its switches are the whole grammar, and
	// `shutdown /?` on this box printed them (the prose around them came back in
	// the console's own code page and was unreadable, which does not matter: the
	// switch names are ASCII and those are all this rule reads).
	//
	// `/a` is deliberately not here — it *cancels* a pending shutdown, and a rule
	// that flagged it would flag the recovery. `/l` is not here either: logging off
	// ends the session but the machine is still up and the user logs straight
	// back in, which is a different act from putting the machine away.
	//
	// This sits above the verb lookup rather than below it: `shutdown` has no
	// entry in `WINDOWS_ADMIN_VERBS`, and the `return null` there would have
	// taken the whole branch out of reach. The probe is what found that — four
	// rows reading NULL against a rule that was plainly in the file.
	if (program === "shutdown") {
		for (const token of tokens.slice(1)) {
			for (const known of WINDOWS_SHUTDOWN_SWITCHES) {
				if (verbMatches(token, known)) {
					return { kind: "Other", rule: `\`shutdown ${known}\`, which powers the machine away` };
				}
			}
		}
	}

	const verbs = WINDOWS_ADMIN_VERBS.get(program);
	if (verbs === undefined) return null;

	// Every argument is looked at, not only the first. `sc config` puts its verb
	// first and `netsh advfirewall set allprofiles state off` puts it third, and
	// these programs have no shared shape to read the verb out of.
	for (const token of tokens.slice(1)) {
		for (const known of verbs) {
			if (verbMatches(token, known)) {
				return { kind: "Other", rule: `\`${program} ${known}\`, which destroys machine state` };
			}
		}
	}

	// `net user <name> <password>` resets a password and carries no `/add` to
	// recognise it by. It is exactly four words -- `net`, `user`, the name, the
	// password -- and the two listings beside it are two and three.
	if (program === "net" && tokens.length === 4 && tokens[1].toLowerCase() === "user") {
		return { kind: "Other", rule: "`net user <name> <password>`, which resets a password" };
	}

	// `reg add` is the other way to get a program to run at every startup, and it
	// is the same shape of act as writing the value with PowerShell -- but unlike
	// the PowerShell rule it has to be narrow, because `reg add` is ordinary
	// maintenance for the whole rest of the registry and a rule that caught all of
	// it would catch a machine being configured. Only the Run key is flagged.
	if (program === "reg" && tokens[1]?.toLowerCase() === "add" && tokens.slice(1).some(isRunKeyPath)) {
		return { kind: "Other", rule: "`reg add` writing to a key that runs at startup" };
	}
	return null;
}

/**
 * Programs that download something over the network.
 *
 * Only these. The point of the rule below is a program text that arrived from
 * somewhere else and was handed straight to an interpreter, so a *local*
 * producer is not the shape — `cat notes.txt | grep x` and `cat x | sh` are both
 * ordinary, and flagging the second because it shares a pipe with the first is
 * how a classifier teaches a user to switch it off.
 */
const NETWORK_FETCH_PROGRAMS = new Set(["curl", "wget"]);

/**
 * Programs that run the program text handed to them.
 *
 * `sh`, `bash`, `dash`, `python`, `python3`, `node` and `perl` were each piped a
 * script on this machine and each one read and ran it. `zsh` and `ksh` are here
 * on the same grounds — they are shells, and `zsh` is the default login shell on
 * macOS, so leaving it out would leave a hole on the platform where it matters
 * most — but neither is installed here and so neither was measured. `ruby` was
 * not measured either and is left out rather than assumed.
 */
const SCRIPT_INTERPRETERS = new Set(["sh", "bash", "dash", "ksh", "zsh", "python", "python3", "node", "perl"]);

/** The program a segment actually runs, past its scaffolding and its wrappers. */
function segmentProgram(segment: string): string | undefined {
	let tokens = tokenizeShell(segment);
	const scaffolded = stripShellScaffolding(tokens);
	if (scaffolded !== undefined) tokens = scaffolded;
	// `curl … | sudo bash` puts a wrapper on the right-hand side of the pipe, and
	// `sudo bash` still reads stdin — so the program that receives the download
	// is `bash`, not `sudo`. The wrapper set and the option skipper are the ones
	// the rest of this file already uses, rather than a second copy of both.
	// `sudo` is named here separately because it is not in that set: it is a
	// wrapper, but it has a branch of its own in `matchTokens` rather than being
	// on the list, so a loop that only consults the list walks straight past it.
	for (let hops = 0; hops < MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH; hops++) {
		if (tokens.length === 0) return undefined;
		const name = executableName(tokens[0], "posix");
		if (name === undefined) return undefined;
		if (name !== "sudo" && !COMMAND_PREFIX_PROGRAMS.has(name)) return name;
		tokens = commandAfterOptions(tokens.slice(1), valueOptionsFor(name));
	}
	return undefined;
}

/**
 * A download piped straight into an interpreter.
 *
 * This one is about the pipe rather than about either end: neither `curl` nor
 * `sh` is dangerous on its own, and a rule for each of them separately would be
 * two rules that fire on ordinary commands. What makes this one worth a prompt
 * is that the text was never on the command line, so there is nothing else in
 * the repository that can read it — and the interpreter will run it before any
 * file is written where a user could look at it.
 *
 * Measured on this machine: `cat payload.sh | sh` and `| bash` both ran the
 * script, and so did piping into each interpreter named above.
 */
function fetchPipedIntoInterpreter(segments: string[]): DangerousCommandMatch | null {
	for (let i = 0; i + 1 < segments.length; i++) {
		const left = segmentProgram(segments[i]);
		const right = segmentProgram(segments[i + 1]);
		if (left === undefined || right === undefined) continue;
		if (!NETWORK_FETCH_PROGRAMS.has(left)) continue;
		if (!SCRIPT_INTERPRETERS.has(right)) continue;
		return {
			kind: "Other",
			rule: `\`${left}\` piped into \`${right}\`, which runs a script nobody has read`,
		};
	}
	return null;
}

/**
 * Classify a whole command line, one segment at a time.
 *
 * Shared with the `eval` branch above rather than written twice. It has to be
 * this function and not `matchTokens`, because a string read out of a wrapper
 * can hold a chain of its own: `eval "echo hi && rm -rf /"` is two commands, and
 * calling `matchTokens` on the whole thing reads the program as `echo` and stops
 * there.
 */
function matchScript(script: string, depth: number, platform: DangerousCommandPlatform): DangerousCommandMatch | null {
	const segments = splitShellCommands(script);
	// Only POSIX spells a pipe this way between two commands that are each
	// ordinary on their own. Windows reads the same characters, but there the
	// dangerous end of the pipe is already a rule of its own.
	if (platform === "posix") {
		const piped = fetchPipedIntoInterpreter(segments);
		if (piped) return piped;
	}
	for (const segment of segments) {
		const tokens = tokenizeShell(segment);
		const match = matchTokens(tokens, depth, platform, segment);
		if (match) return match;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tools that reach outside the machine: version control, containers, clusters,
// registries and forges
// ---------------------------------------------------------------------------

/**
 * These are answered the same on both platforms, deliberately.
 *
 * `docker rm -f web` is a forced container removal whether it was typed into
 * PowerShell or into bash, and the five programs below are spelled identically
 * in both. Putting the table behind a `platform` check would mean one of the
 * two silently loses it, which is the kind of gap that reads as a deliberate
 * decision later.
 */

/** `git push` flags that overwrite what is on the other end. */
const GIT_FORCE_PUSH_FLAGS: readonly string[] = ["--force", "-f", "--force-with-lease", "--force-if-includes"];

/**
 * Whether the arguments ask for a run that prints instead of acting.
 *
 * The short `-n` is read as a *cluster* rather than as a token. Short flags
 * combine, and `-fn` is the everyday spelling of "show me what a forced clean
 * would take" — an exact match against `-n` misses it because neither token in
 * `-fn` is `-n`. Measured, because the reading is not obvious: against a real
 * repo, `-fn`, `-fnx` and `-nf` each exited 0, each printed a line beginning
 * `Would remove`, and each left the untracked file, the ignored file and the
 * untracked directory on disk.
 *
 * Reading the cluster is only safe because no flag of either caller carries the
 * letter `n` and no long option can reach here. `git clean` takes
 * `-f -d -x -X -q -e` and the long `--exclude`/`--dry-run`, and
 * `npm publish --help` / `npm unpublish --help` on
 * this machine list `--tag --access --otp --dry-run --provenance -w -ws` and
 * `--dry-run -f -w -ws` respectively — every short one of those is `-w`, `-ws`
 * or `-f`. The `--` exclusion is load-bearing rather than tidiness, and not
 * only for those two callers: `git clean -f --exclude=node_modules` has an `n`
 * in it and still deletes everything it did not exclude, measured.
 */
function isDryRun(args: string[]): boolean {
	if (args.includes("--dry-run")) return true;
	return args.some((arg) => arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("n"));
}

/**
 * Note what is NOT folded here: git's flags are case-sensitive, and `git branch
 * -d` refuses to delete an unmerged branch while `git branch -D` does it. A
 * lower-casing pass over the arguments would merge the two and make the safe
 * spelling the dangerous one.
 */
function gitRules(tokens: string[], platform: DangerousCommandPlatform): DangerousCommandMatch | null {
	if (executableName(tokens[0], platform) !== "git") return null;
	const [subcommand, ...args] = tokens.slice(1);
	if (subcommand === undefined) return null;

	if (subcommand === "clean") {
		// MEASURED, one flag at a time, in a throwaway repo: `-n` and `--dry-run`
		// print and remove nothing; `-f` takes untracked files; `-fd` takes
		// directories too; `-x` adds ignored files; `-ffdx` is the whole lot. The
		// dry-run exemption is checked first so `-f --dry-run` is not flagged for
		// the flag it is about to be stopped from using.
		if (isDryRun(args)) return null;
		if (!args.some((arg) => arg.startsWith("-f") || arg === "--force")) return null;
		return { kind: "Other", rule: "`git clean` with a force flag, which deletes files with no undo" };
	}

	if (subcommand === "reset") {
		// MEASURED: `--hard` put a tracked file back to its committed contents and
		// dropped a staged new file, with no commit-ish argument needed. `--soft`,
		// `--mixed` and a bare `git reset` all left the working copy alone.
		if (!args.includes("--hard")) return null;
		return { kind: "Other", rule: "`git reset --hard`, which throws away uncommitted work" };
	}

	if (subcommand === "checkout") {
		// The `--` is the whole signal: it is what separates "restore this path
		// from the index" from "switch to this branch", which is why
		// `git checkout main` and `git checkout -b feature` are left alone.
		if (!args.includes("--")) return null;
		return { kind: "Other", rule: "`git checkout --`, which discards working-copy changes" };
	}

	if (subcommand === "restore") {
		// `--staged` on its own moves a file out of the index and leaves the file
		// alone; adding `--worktree` is what makes it throw the file away.
		if (args.includes("--staged") && !args.includes("--worktree")) return null;
		return { kind: "Other", rule: "`git restore`, which discards working-copy changes" };
	}

	if (subcommand === "branch") {
		// MEASURED: `git branch -d doomed` on an unmerged branch exited 1 with
		// "error: the branch 'doomed' is not fully merged"; `-D` deleted it.
		if (!args.includes("-D") && !args.includes("--force")) return null;
		return { kind: "Other", rule: "`git branch -D`, which deletes a branch and its commits" };
	}

	if (subcommand === "stash") {
		// MEASURED: both emptied `git stash list`. `push`, `pop` and `list` do not.
		const verb = args[0];
		if (verb !== "drop" && verb !== "clear") return null;
		return { kind: "Other", rule: `\`git stash ${verb}\`, which throws stashed work away` };
	}

	if (subcommand === "push") {
		// NOT EXECUTED against any remote, ever. The spellings come from
		// `git push -h` (`-f, --force`, `--force-with-lease[=<refname>:<expect>]`,
		// `--force-if-includes`) and from git-push.adoc on this box, which gives
		// the refspec format as `[+]<src>[:<dst>]` and states that "the `+` is
		// optional and does the same thing as `--force" -- which is why an
		// argument beginning with `+` counts even though no flag was typed.
		// `--force-with-lease` takes a value and is written
		// `--force-with-lease=<refname>:<expect>`, so an exact match against the
		// bare name misses the form that actually carries a ref.
		const forced = GIT_FORCE_PUSH_FLAGS.some((flag) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)));
		const refspecForced = args.some((arg) => arg.startsWith("+"));
		if (!forced && !refspecForced) return null;
		return { kind: "Other", rule: "`git push` with a force, which overwrites the other end" };
	}

	return null;
}

/**
 * Container, cluster, registry and forge tools, read off their own help output.
 *
 * `docker system prune --help` prints `-a, --all`, `-f, --force` and
 * `--volumes`; `docker rm --help` and `docker volume rm --help` both print
 * `-f, --force`; `docker compose down --help` prints `-v, --volumes` and
 * `--rmi string`, the latter documented as `Remove images used by services.
 * "local" remove only images that don't have a custom tag ("local"|"all")`.
 * `kubectl delete --help` prints `--all=false:`, `-A, --all-namespaces=false:`,
 * `--force=false:` and `--now`. `gh repo delete --help` names a bare `--yes`
 * with no short form, while `gh repo archive --help` has `-y, --yes`.
 *
 * Nothing here was run against a daemon or a cluster, and nothing could have
 * been: `docker version` on this machine fails with "error during connect ...
 * open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file
 * specified", and `kubectl config current-context` answers "error:
 * current-context is not set".
 */
function containerToolRules(tokens: string[], platform: DangerousCommandPlatform): DangerousCommandMatch | null {
	const program = executableName(tokens[0], platform);
	const lower = tokens.slice(1).map((arg) => arg.toLowerCase());

	if (program === "docker") {
		const [group, verb] = lower;
		// `docker prune` is not a subcommand — `docker prune --help` prints the
		// whole root usage and exits 0 — so only the spelled-out forms count.
		if (verb === "prune" && ["system", "image", "container", "network", "volume"].includes(group)) {
			return { kind: "Other", rule: `\`docker ${group} prune\`, which deletes everything unused` };
		}
		if ((group === "rm" || group === "rmi") && (lower.includes("-f") || lower.includes("--force"))) {
			return { kind: "Other", rule: `\`docker ${group} -f\`, which kills and deletes a running one` };
		}
		if (group === "volume" && verb === "rm") {
			// No force flag required, which looks like an oversight beside the
			// `docker rm -f` above and is not one. `-f` on `docker volume rm` is
			// `docker rm -f`'s meaning inverted: it is what lets the removal go ahead
			// on a volume that is still in use, so a plain `docker volume rm`
			// deletes the data of any volume nothing else is holding. The flag is
			// the risk when it is absent, not when it is present.
			return { kind: "Other", rule: "`docker volume rm`, which deletes the data on a volume" };
		}
		if (group === "compose") {
			// `down` alone stops containers and keeps the volumes; `-v` is what
			// takes the database with it.
			if (verb !== "down") return null;
			if (lower.includes("-v") || lower.includes("--volumes")) {
				return { kind: "Other", rule: "`docker compose down -v`, which deletes the volumes' data" };
			}
			// `--rmi` takes a value and the two values are not the same act, which
			// `docker compose down --help` spells out: `"local" remove only images
			// that don't have a custom tag`, `"all"` removes every image the
			// services use. Only the second is caught here, because only the
			// second reaches an image somebody tagged and published. The value may
			// be attached with `=` or given as the next word, and both are read
			// because the flag with no value is rejected by the tool rather than
			// defaulting to either — so a bare `--rmi` is left alone on purpose.
			const rmi = lower.findIndex((arg) => arg === "--rmi" || arg.startsWith("--rmi="));
			if (rmi !== -1) {
				const value = lower[rmi].includes("=") ? lower[rmi].split("=")[1] : lower[rmi + 1];
				if (value === "all") {
					return { kind: "Other", rule: "`docker compose down --rmi all`, which deletes the service's images" };
				}
			}
			return null;
		}
		return null;
	}

	if (program === "kubectl") {
		const [verb, ...rest] = lower;
		if (verb === "drain") {
			return { kind: "Other", rule: "`kubectl drain`, which evicts everything running on a node" };
		}
		if (verb !== "delete") return null;
		if (rest.includes("namespace")) {
			return { kind: "Other", rule: "`kubectl delete namespace`, which takes a namespace and its contents" };
		}
		// `kubectl delete pod web-1` is an ordinary ops command and stays quiet;
		// what is caught is the spelling that means "all of them".
		const sweeping = ["--all", "-a", "--all-namespaces", "--force", "--now"].some((flag) => rest.includes(flag));
		if (!sweeping) return null;
		return { kind: "Other", rule: "`kubectl delete` over a whole set rather than one object" };
	}

	if (program === "npm" || program === "pnpm" || program === "yarn") {
		// `yarn publish` and `yarn npm publish` both exist; the second is how the
		// modern yarn spells it, and the indirection is why this reads `lower[1]`
		// for one program and `lower[0]` for the others rather than unifying them.
		// None of the three is installed on this machine, so unlike the git rows
		// above these spellings were read from each tool's documented usage rather
		// than measured by running it.
		const verb = program === "yarn" && lower[0] === "npm" ? lower[1] : lower[0];
		// `npm publish --dry-run` and `npm unpublish --dry-run` both exist and
		// both print instead of sending, so the dry run is the exemption.
		if (verb === "publish" || verb === "unpublish") {
			if (isDryRun(lower)) return null;
			return { kind: "Other", rule: `\`${program} ${verb}\`, which changes a published package` };
		}
		if (verb === "deprecate") {
			return { kind: "Other", rule: `\`${program} deprecate\`, which changes what every install gets` };
		}
		if (verb === "dist-tag" && lower[1] === "rm") {
			return { kind: "Other", rule: `\`${program} dist-tag rm\`, which moves a published version out of reach` };
		}
		return null;
	}

	if (program === "gh") {
		// `gh repo archive` is deliberately not here: a repository can be
		// unarchived, so it is a different act from deleting one. `gh run delete`
		// is not here either — it removes a CI log, which is a build record and
		// not the user's own work.
		if (lower[0] === "repo" && lower[1] === "delete") {
			return { kind: "Other", rule: "`gh repo delete`, which deletes a repository" };
		}
		if (lower[0] === "secret" && lower[1] === "delete") {
			return { kind: "Other", rule: "`gh secret delete`, which removes a credential from a repository" };
		}
		return null;
	}

	return null;
}

function developmentToolRules(tokens: string[], platform: DangerousCommandPlatform): DangerousCommandMatch | null {
	return gitRules(tokens, platform) ?? containerToolRules(tokens, platform);
}

/**
 * Classify a command line, or `null` when no rule matched.
 *
 * `null` means "nothing here was recognized as dangerous" — it is not a claim
 * that the command is safe, and the engine never widens access on it.
 */
export function classifyDangerousCommand(
	command: string,
	platform: DangerousCommandPlatform = process.platform === "win32" ? "windows" : "posix",
): DangerousCommandMatch | null {
	return matchScript(command, 0, platform);
}
