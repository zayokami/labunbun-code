// Long-form design notes: docs/dev/command-classifier.md
/** Shell tokenizing, shared by the permission engine and the dangerous-command classifier. */

// Long-form design notes: docs/dev/command-classifier.md
/** Shell metacharacters that separate one command from the next. */
export const COMMAND_SEPARATOR_RE = /(?:\|\||&&|[;|&\n])/;

// Long-form design notes: docs/dev/command-classifier.md
/** Split one shell segment into tokens, honoring quotes and unwrapping them. */
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

/** One command of a command line, together with the separator that ends it. */
export interface ShellSegment {
	/** The command's own text, trimmed, with its quote characters still on it. */
	text: string;
	// Long-form design notes: docs/dev/command-classifier.md
	/** The separator that follows this command: `|`, `&&`, `||`, `;`, `&`, a newline, or `""` when the command ends the line. */
	separator: string;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Split a command line into the separate commands it runs, keeping each one's terminator. */
export function splitShellSegments(command: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
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
			segments.push({ text: current.trim(), separator: pair });
			current = "";
			i++;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "\n") {
			segments.push({ text: current.trim(), separator: char });
			current = "";
			continue;
		}
		current += char;
	}
	segments.push({ text: current.trim(), separator: "" });

	return segments.filter((segment) => segment.text.length > 0);
}

// Long-form design notes: docs/dev/command-classifier.md
/** The commands of a command line, without their separators. */
export function splitShellCommands(command: string): string[] {
	return splitShellSegments(command).map((segment) => segment.text);
}
