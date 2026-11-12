/**
 * Rules that apply only while a matching file is in play.
 *
 * A `.labunbun/rules/*.md` file with a `paths:` frontmatter block is not part
 * of the startup memory: every session would pay for it, and most of them
 * would never open the files it is about. It is attached to a tool result the
 * first time the agent reads, edits or writes a path its globs match, so the
 * rule arrives with the file it governs and stays in the transcript the way
 * any other tool result does.
 *
 * The match is against the file's path relative to the workspace root, with
 * forward slashes, because that is the spelling a rule author writes:
 *
 *     ---
 *     paths:
 *       - src/api/**\/*.ts
 *     ---
 *     Every handler answers with the envelope in `api/respond.ts`.
 *
 * The frontmatter reader is deliberately small — one key, a scalar or a YAML
 * list — rather than a general YAML dependency for a field that has one shape.
 *
 * Long-form design notes: docs/dev/path-rules.md
 */
import { relative, resolve } from "node:path";
import type { AgentMessage, ToolResultMessage } from "@labunbun/ai";
import { textContent } from "@labunbun/ai";
import { caseInsensitivePaths } from "@labunbun/tools";

/** One scoped rule, as the loader read it. */
export interface PathRule {
	/** The rule file's path on disk. */
	file: string;
	/** The globs from the `paths:` frontmatter, in the order written. */
	patterns: string[];
	/** The rule's text, with the frontmatter removed. */
	body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a rule file into its `paths:` globs and the text they scope.
 *
 * A file with no frontmatter, or with frontmatter that names no `paths:`, is
 * an ordinary rule: `patterns` is empty and `body` is the file unchanged, so
 * the caller can put it in the prompt exactly as before.
 */
export function parseRulePaths(content: string): { patterns: string[]; body: string } {
	const match = content.match(FRONTMATTER);
	if (!match) return { patterns: [], body: content };
	const patterns = readPaths(match[1]);
	if (patterns.length === 0) return { patterns: [], body: content };
	return { patterns, body: content.slice(match[0].length) };
}

function readPaths(frontmatter: string): string[] {
	const patterns: string[] = [];
	const lines = frontmatter.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const colon = line.indexOf(":");
		if (colon === -1 || line.slice(0, colon).trim() !== "paths") continue;
		const inline = line.slice(colon + 1).trim();
		if (inline) {
			patterns.push(...splitList(inline));
			continue;
		}
		// `paths:` alone: the globs are the `- item` lines under it. The scan
		// stops at the first line that is not an item, so a key written below the
		// list is not swallowed as one.
		for (let next = index + 1; next < lines.length; next++) {
			const item = lines[next].trim();
			if (!item) continue;
			if (!item.startsWith("-")) break;
			patterns.push(...splitList(item.slice(1)));
			index = next;
		}
	}
	return patterns.filter((pattern) => pattern.length > 0);
}

/**
 * `a, b`, `[a, b]`, or one value — quoted or not.
 *
 * Commas inside a quote or a brace are part of the value, not separators:
 * `src/**\/*.{ts,tsx}` is one glob, and splitting it on the comma would hand
 * `Bun.Glob` two patterns that match nothing.
 */
function splitList(value: string): string[] {
	const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
	const entries: string[] = [];
	let current = "";
	let quote: string | undefined;
	let braces = 0;
	for (const char of inner) {
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "{") braces++;
		if (char === "}" && braces > 0) braces--;
		if (char === "," && braces === 0) {
			entries.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	entries.push(current);
	return entries.map((entry) => unquote(entry)).filter((entry) => entry.length > 0);
}

function unquote(value: string): string {
	const trimmed = value.trim();
	const quote = trimmed[0];
	if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

/** Compiled globs, keyed by pattern: a session may match the same rule many times. */
const globs = new Map<string, Bun.Glob>();

function globFor(pattern: string): Bun.Glob {
	const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
	let glob = globs.get(normalized);
	if (!glob) {
		glob = new Bun.Glob(normalized);
		globs.set(normalized, glob);
	}
	return glob;
}

/**
 * Does `relativePath` (forward slashes, from the workspace root) match one of
 * a rule's globs?
 *
 * A trailing slash means "everything under this directory" — the shape a
 * person writes when they mean a whole tree — and is read as `dir/**`.
 */
export function ruleMatches(pattern: string, relativePath: string): boolean {
	const normalized = relativePath.replace(/\\/g, "/");
	const base = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
	return globFor(base.endsWith("/") ? `${base}**` : base).match(normalized);
}

/** The tools whose arguments name one file. A glob or a search has no single subject. */
const FILE_TOOLS = new Set(["Read", "Edit", "Write"]);

function filePathOf(toolName: string, input: unknown): string | undefined {
	if (!FILE_TOOLS.has(toolName)) return undefined;
	if (typeof input !== "object" || input === null) return undefined;
	const filePath = (input as { file_path?: unknown }).file_path;
	return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

export interface PathRuleInjector {
	/**
	 * The result to hand back, or `undefined` when this call matched no rule
	 * that has not already been attached.
	 */
	apply(toolName: string, input: unknown, result: ToolResultMessage): ToolResultMessage | undefined;
	/**
	 * Forget what has been attached. A compaction replaces the transcript that
	 * carried the rule; the next matching read attaches it again, rather than
	 * leaving the session working under a rule it no longer has.
	 */
	reset(): void;
	/**
	 * Mark as attached the rules a loaded transcript already carries.
	 *
	 * A resumed session arrives with the tool results a previous process
	 * produced, the attached rule text among them. Starting with an empty set
	 * would paste a rule the model can already read a second time on the next
	 * matching call — and a hot swap would do the same against a conversation
	 * whose rules differ. Read from the text the injector itself wrote.
	 */
	seed(messages: readonly AgentMessage[]): void;
}

export interface PathRuleInjectorOptions {
	cwd: string;
	rules: readonly PathRule[];
	/** Only used to shorten a rule's path in the attached text. */
	home?: string;
}

export function createPathRuleInjector(options: PathRuleInjectorOptions): PathRuleInjector {
	const { cwd, rules, home } = options;
	const attached = new Set<string>();

	const shownFile = (file: string): string => {
		if (isWithin(file, cwd)) {
			const rel = relative(cwd, file);
			return rel ? slashed(rel) : slashed(file);
		}
		if (home && isWithin(file, home)) {
			const rel = relative(home, file);
			return rel ? `~/${slashed(rel)}` : "~";
		}
		return slashed(file);
	};

	// The header is the marker seed() looks for in a loaded transcript. It is
	// built in one place so the two meanings cannot drift.
	const headerFor = (rule: PathRule): string => `[path rule — ${oneLine(shownFile(rule.file))} (`;

	const blockFor = (rule: PathRule): string =>
		`${headerFor(rule)}${rule.patterns.map(oneLine).join(", ")})]\n${rule.body.trim()}\n[end of path rule]`;

	return {
		apply(toolName, input, result) {
			const filePath = filePathOf(toolName, input);
			if (!filePath) return undefined;
			const target = resolve(cwd, filePath);
			if (!isWithin(target, cwd)) return undefined;
			const rel = relative(cwd, target);
			if (!rel) return undefined;

			const matched = rules.filter(
				(rule) => !attached.has(rule.file) && rule.patterns.some((pattern) => ruleMatches(pattern, rel)),
			);
			if (matched.length === 0) return undefined;
			for (const rule of matched) attached.add(rule.file);
			return { ...result, content: [...result.content, textContent(matched.map(blockFor).join("\n\n"))] };
		},
		reset() {
			attached.clear();
		},
		seed(messages) {
			for (const rule of rules) {
				if (attached.has(rule.file)) continue;
				const header = headerFor(rule);
				const carried = messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.content.some((block) => block.type === "text" && block.text.includes(header)),
				);
				if (carried) attached.add(rule.file);
			}
		},
	};
}

function slashed(path: string): string {
	return path.replace(/\\/g, "/");
}

function isWithin(target: string, root: string): boolean {
	const fold = (value: string): string => (caseInsensitivePaths ? value.toLowerCase() : value);
	const normalizedTarget = fold(slashed(resolve(target)));
	const normalizedRoot = fold(slashed(resolve(root))).replace(/\/$/, "");
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

/**
 * A rule file's path and glob are data written by an author, and they are
 * being embedded in prompt text: a newline in either would end the line the
 * reader is supposed to see as one.
 */
function oneLine(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: flattening them is the point
			.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}
