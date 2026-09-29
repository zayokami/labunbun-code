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

/** Split a command line into the separate commands it runs. */
export function splitShellCommands(command: string): string[] {
	return command
		.split(COMMAND_SEPARATOR_RE)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}
