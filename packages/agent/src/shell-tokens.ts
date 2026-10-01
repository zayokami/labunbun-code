/**
 * Shell tokenizing, shared by the two places that have to read a command line
 * the way a shell would: the permission engine's Bash→file-rule extension, and
 * the dangerous-command classifier.
 *
 * It was one function living inside `permissions.ts` until the classifier needed
 * the same reading, and a second copy would be a second set of answers to "what
 * are the words in this command" — the failure mode being that a rule or a
 * classification quietly applies to one tokenizer's idea of a command and not
 * the other's.
 */

/**
 * Shell metacharacters that separate one command from the next.
 *
 * `&` and `;` cover backgrounding and sequencing, `|` a pipe, and a newline the
 * same job `;` does. The two-character forms come first in the alternation so
 * `&&` is not read as two `&`.
 *
 * **This does not know about quotes, and splitting a command line with it is
 * wrong in a way that shows up as a false positive rather than a missed match.**
 * `printf 'a;rm -rf /'` is one command that prints; split with this it becomes
 * two, and the second one is classified. Use {@link splitShellCommands}, which
 * tracks quoting and backslash escapes. This stays exported because it also
 * answers "which characters are separators", which is a question about the
 * alphabet rather than about any one command.
 */
export const COMMAND_SEPARATOR_RE = /(?:\|\||&&|[;|&\n])/;

/**
 * Split one shell segment into tokens, honoring quotes so a quoted path with
 * spaces stays one token, and unwrapping the quotes as the shell would.
 *
 * Not a shell: no expansion, no substitution, no escaping. A token it cannot
 * read comes back as literal text, which is the safe direction for both callers —
 * a rule that fails to match costs an approval prompt, and a command the
 * classifier cannot decompose is one whose nested pieces it never got to look at.
 */
export function tokenizeShell(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let started = false;

	for (let i = 0; i < segment.length; i++) {
		const char = segment[i];
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (started) tokens.push(current);
	return tokens;
}

/**
 * Split a command line into the separate commands it runs.
 *
 * The scan tracks two things the regex it replaces did not, and both of them
 * were producing wrong answers rather than merely coarse ones.
 *
 * **Quotes.** `echo "a;rm -rf /"` is one command that prints six words. Split on
 * the separator characters alone it becomes two, and the second is a forced
 * recursive delete — so the classifier refused commands that print text
 * containing a semicolon, which is the sort of false positive a user answers by
 * switching the thing off.
 *
 * **Backslashes.** A backslash quotes the character after it, so `find . -exec
 * cmd \;` is one command whose argument is a semicolon. Split naively, the
 * trailing `\` was dropped and the segment lost its terminator.
 *
 * A backslash inside single quotes is itself rather than an escape, which is the
 * one rule here that does not generalise and is the reason this is a scanner and
 * not a single lookbehind.
 *
 * The quote characters are left in each segment. {@link tokenizeShell} is what
 * unwraps them, and the segments are meant to keep their original text so a
 * caller that shows one to a user shows what was actually typed.
 */
export function splitShellCommands(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (char === "\\" && quote !== "'") {
			const next = command[i + 1];
			if (next === undefined) {
				current += char;
				continue;
			}
			current += char + next;
			i++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		// The two-character forms are read as one. Whether they *have* to be is a
		// question the empty-segment filter answers no: `a && b` split twice still
		// comes out `["a", "b"]`. It is here because the loop advances a cursor and
		// reading one separator at a time would leave it straddling the second `&`
		// for no gain.
		const pair = command.slice(i, i + 2);
		if (pair === "&&" || pair === "||") {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "\n") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);

	return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}
