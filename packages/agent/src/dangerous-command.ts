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
	/** `ForcedRm` is a forced recursive delete; `Other` is any other rule. */
	kind: "ForcedRm" | "Other";
	/** What matched, for the message the user is shown. */
	rule: string;
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "ksh", "dash"]);
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
		// Case-folded, and only here: a path argument never starts with `-`, so
		// the two comparisons below cannot be reached by `rm -rf /tmp/MyFile` and
		// its capital letters are never compared against anything. GNU and BSD
		// `rm` reject `-F` outright, so `rm -RF` deletes nothing on either —
		// folding it is not a claim about POSIX option syntax, it is this
		// function refusing to depend on the local `rm` being the strict one.
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

/** Extract the script text from a `sh -c '…'` style invocation. */
function wrapperScript(tokens: string[]): string | undefined {
	const program = executableName(tokens[0] ?? "", "posix");
	if (program === undefined || !SHELL_EXECUTABLES.has(program)) return undefined;
	for (let i = 1; i < tokens.length; i++) {
		const arg = tokens[i];
		if (!arg.startsWith("-")) continue;
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
 * `-Command` takes every unambiguous prefix, so `-c`, `-co` and `-Command` are
 * one switch. `-EncodedCommand` is deliberately not among them: its body is
 * base64, and reading it is not something this function does — which is a real
 * limit, and is why a miss here is never treated as "safe" anywhere upstream.
 */
const POWERSHELL_COMMAND_SWITCH = /^-(?:c|co|com|comm|comma|comman|command)$/;

/** The script text of a `powershell -Command "…"` invocation. */
function powershellScript(tokens: string[]): string | undefined {
	const program = executableName(tokens[0] ?? "", "windows");
	if (program === undefined || !POWERSHELL_EXECUTABLES.has(program)) return undefined;
	for (let i = 1; i < tokens.length; i++) {
		if (!POWERSHELL_COMMAND_SWITCH.test(tokens[i].toLowerCase())) continue;
		const next = tokens[i + 1];
		return next === undefined || next === "-" ? undefined : next;
	}
	return undefined;
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
 * The command `xargs` will run, which is the first word that is not one of its
 * options.
 *
 * This function cannot run `xargs`, so the list of options that consume the
 * word after them is a list it has to be right about rather than one it can
 * ask. Getting it wrong moves the boundary one word either way, and the words
 * on either side of the boundary belong to `xargs` — an option, or the
 * argument of one — so the effect is on how often the command behind them is
 * found, not on what is found.
 */
function xargsCommand(args: string[]): string[] {
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "--") {
			i++;
			break;
		}
		if (!arg.startsWith("-")) break;
		i += XARGS_VALUE_OPTIONS.has(arg) ? 2 : 1;
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

	const command = stripShellScaffolding(tokens);
	if (command !== undefined) return matchTokens(command, depth, platform, segment);

	const program = executableName(tokens[0], platform);
	if (program === "rm" && rmArgsIncludeForce(tokens.slice(1))) {
		return { kind: "ForcedRm", rule: "`rm` with a force option" };
	}
	// `sudo <cmd>` is `<cmd>`, run as someone else.
	if (program === "sudo") {
		return matchTokens(tokens.slice(1), depth + 1, platform, segment);
	}
	if (program === "env") {
		let i = 1;
		while (i < tokens.length) {
			const arg = tokens[i];
			if (arg === "--") {
				i++;
				break;
			}
			if (arg === "-i" || arg === "--ignore-environment" || isAssignment(arg)) {
				i++;
				continue;
			}
			break;
		}
		return matchTokens(tokens.slice(i), depth + 1, platform, segment);
	}
	// `xargs rm -rf` is `rm -rf` once per line of input: a wrapper in exactly
	// the sense `sudo` and `env` are, and the reason `find … | xargs rm -rf` is
	// the ordinary spelling of the delete this file exists to catch.
	if (program === "xargs") {
		return matchTokens(xargsCommand(tokens.slice(1)), depth + 1, platform, segment);
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
function hasForceDeleteCmdlet(tokens: string[]): boolean {
	return windowsSegments(tokens).some((segment) => {
		let hasDelete = false;
		let hasForce = false;
		for (const word of segment) {
			if (DELETE_CMDLETS.has(word.toLowerCase())) hasDelete = true;
			const lower = word.toLowerCase();
			if (lower === "-force" || lower.startsWith("-force:")) hasForce = true;
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
	return powershellExecutionRules(lower);
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

function dangerousCmd(tokens: string[]): DangerousCommandMatch | null {
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
 */
function powershellWords(tokens: string[]): string[] {
	const words: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		const arg = tokens[i];
		if (POWERSHELL_COMMAND_SWITCH.test(arg.toLowerCase()) && i + 1 < tokens.length) {
			words.push(...tokens[i + 1].split(/\s+/).filter(Boolean));
			i++;
			continue;
		}
		words.push(arg);
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
		dangerousCmd(tokens) ?? dangerousCmdBody(tokens) ?? dangerousPowershellWords(tokens) ?? directGuiLaunch(tokens)
	);
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
	for (const segment of splitShellCommands(command)) {
		const match = matchTokens(tokenizeShell(segment), 0, platform, segment);
		if (match) return match;
	}
	return null;
}
