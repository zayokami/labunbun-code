/**
 * Permission rule engine (pure — no I/O, no UI).
 *
 * Rule syntax: "Tool" or "Tool(specifier)" e.g.
 *   Bash · Bash(git *) · Bash(npm run *) · Edit(src/**) · Read(~/.ssh/*)
 *   mcp__github · mcp__github__*
 *
 * Evaluation: deny rules always win across all sources; among allows, later
 * sources override earlier (user → project → local → policy → cliArg →
 * session). Mode shortcuts: bypassPermissions skips the engine; acceptEdits
 * auto-allows Edit/Write in the workspace; plan denies mutating tools;
 * dontAsk turns unresolved asks into denies (handled by the caller).
 */
import { resolve } from "node:path";
import type { PermissionContext, PermissionMode, PermissionResult } from "./types.ts";

export type RuleSource = "userSettings" | "projectSettings" | "localSettings" | "policy" | "cliArg" | "session";

export const RULE_SOURCE_ORDER: RuleSource[] = [
	"userSettings",
	"projectSettings",
	"localSettings",
	"policy",
	"cliArg",
	"session",
];

export interface PermissionRule {
	toolName: string;
	/** Raw specifier inside Tool(...); absent = bare tool rule. */
	specifier?: string;
	behavior: "allow" | "deny";
	source: RuleSource;
}

/** Parse "Tool" or "Tool(specifier)" into its parts; null when malformed. */
export function parseRuleText(text: string): { toolName: string; specifier?: string } | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const open = trimmed.indexOf("(");
	if (open === -1) {
		if (trimmed.includes(")")) return null;
		return { toolName: trimmed };
	}
	if (!trimmed.endsWith(")")) return null;
	const toolName = trimmed.slice(0, open).trim();
	const specifier = trimmed.slice(open + 1, -1);
	if (!toolName) return null;
	return { toolName, specifier };
}

/** Convert Windows paths to POSIX style for specifier matching. */
export function normalizePathSpec(specifier: string): string {
	return specifier.replace(/\\/g, "/");
}

/** Glob → RegExp: ** crosses directories, * stays within a segment. */
export function specifierToRegExp(specifier: string): RegExp {
	let pattern = "";
	for (let i = 0; i < specifier.length; i++) {
		const char = specifier[i];
		if (char === "*") {
			if (specifier[i + 1] === "*") {
				pattern += ".*";
				i++;
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += "[^/]";
		} else {
			pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${pattern}$`);
}

/**
 * Programs whose positional arguments are files they read. Used to extend
 * file deny rules across the shell (see extractBashFilePaths).
 */
const FILE_READING_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"type",
	"strings",
	"od",
	"xxd",
	"hexdump",
	"base64",
	"nl",
	"tac",
	"cp",
	"install",
]);

/** Shell metacharacters that separate one command from the next. */
const COMMAND_SEPARATOR_RE = /(?:\|\||&&|[;|&\n])/;

/**
 * Best-effort extraction of file paths a shell command would read or write.
 *
 * This exists so that a deny rule like `Read(**\/.env)` also covers
 * `Bash(cat .env)` — without it the shell is an open bypass around every file
 * deny rule the user configured.
 *
 * Deliberately defense-in-depth, NOT a sandbox: a shell can express file
 * access in unbounded ways (`$(printf ...)`, variable indirection, `bash -c`,
 * `eval`), so static extraction can always be evaded by someone trying. The
 * contract that keeps this safe to rely on is directional — callers use the
 * result only to *deny*, never to allow. Failing to extract a path leaves the
 * original decision untouched rather than widening it.
 */
export function extractBashFilePaths(command: string): string[] {
	const found: string[] = [];

	for (const segment of command.split(COMMAND_SEPARATOR_RE)) {
		const tokens = tokenizeShell(segment);
		if (tokens.length === 0) continue;

		// Redirections apply regardless of which program runs: `> f`, `>> f`,
		// `< f`, `2> f`, and the attached forms (`>f`).
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const redirect = token.match(/^\d*(?:>>|>|<)(.*)$/);
			if (!redirect) continue;
			const attached = redirect[1];
			const target = attached !== "" ? attached : tokens[i + 1];
			if (target && !target.startsWith("&")) found.push(target);
		}

		// Positional arguments of known file-reading programs. Strip a leading
		// path so `/bin/cat` and `cat` are treated alike.
		const program = (tokens[0].split("/").pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
		if (!FILE_READING_COMMANDS.has(program)) continue;
		for (const token of tokens.slice(1)) {
			if (token.startsWith("-")) continue; // flag
			if (/^\d*(?:>>|>|<)/.test(token)) continue; // redirection, handled above
			if (/^\d+$/.test(token)) continue; // bare count, e.g. `head -n 5`
			found.push(token);
		}
	}

	return found.filter((path) => path.length > 0);
}

/**
 * Split a shell segment into tokens, honoring quotes so a quoted path with
 * spaces stays one token, and unwrapping the quotes as the shell would.
 */
function tokenizeShell(segment: string): string[] {
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

/** Tools whose file deny rules a Bash command should also be held to. */
const FILE_TOOL_NAMES = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

/**
 * Does a Bash command touch a file that a file-tool deny rule protects?
 * Returns the offending path so the denial can name it.
 */
function bashHitsFileDenyRule(rule: PermissionRule, input: unknown, cwd: string): string | null {
	if (!FILE_TOOL_NAMES.has(rule.toolName) || rule.specifier === undefined) return null;
	if (typeof input !== "object" || input === null) return null;
	const command = (input as Record<string, unknown>).command;
	if (typeof command !== "string") return null;
	for (const path of extractBashFilePaths(command)) {
		if (pathMatches(path, rule.specifier, cwd)) return path;
	}
	return null;
}

/** Does a tool input match a specifier, per that tool's matching grammar? */
export function inputMatchesSpecifier(toolName: string, specifier: string, input: unknown, cwd: string): boolean {
	if (typeof input !== "object" || input === null) return false;
	const record = input as Record<string, unknown>;

	switch (toolName) {
		case "Bash": {
			// Wildcard matching over the whole command line: "git *" matches any
			// git invocation, "git push*" matches prefixed forms, plain text is
			// an exact match.
			const command = String(record.command ?? "").trim();
			const pattern = specifier.trim();
			if (pattern === "*" || pattern === "") return true;
			const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
			return new RegExp(`^${escaped}$`).test(command);
		}
		case "Edit":
		case "Write":
		case "Read":
		case "NotebookEdit": {
			const filePath = String(record.file_path ?? record.notebook_path ?? "");
			if (!filePath) return false;
			return pathMatches(filePath, specifier, cwd);
		}
		default: {
			// MCP tools and unknown tools: match against the raw string form.
			if (toolName.startsWith("mcp__")) {
				if (specifier === "*") return true;
				return toolName === specifier || toolName.startsWith(`${specifier}__`);
			}
			return false;
		}
	}
}

/** Resolve a path against cwd, collapsing `..`/`.` segments so traversal
 *  sequences can't defeat the string-prefix containment checks below. */
function resolveCanonical(filePath: string, cwd: string): string {
	return normalizePathSpec(resolve(cwd, filePath));
}

function pathMatches(filePath: string, specifier: string, cwd: string): boolean {
	const file = resolveCanonical(filePath, cwd);
	const spec = normalizePathSpec(specifier);
	const candidates = new Set([file, file.toLowerCase()]);

	// Workspace-relative form.
	const normalizedCwd = `${resolveCanonical(cwd, cwd).replace(/\/$/, "")}/`;
	if (file.toLowerCase().startsWith(normalizedCwd.toLowerCase())) {
		candidates.add(file.slice(normalizedCwd.length));
	}
	// ~ expansion.
	const home = normalizePathSpec(process.env.USERPROFILE ?? process.env.HOME ?? "");
	if (home && file.toLowerCase().startsWith(`${home.toLowerCase()}/`)) {
		candidates.add(`~${file.slice(home.length)}`);
	}

	const regex = specifierToRegExp(spec);
	for (const candidate of candidates) {
		if (regex.test(candidate)) return true;
	}
	return false;
}

export interface PermissionEngineConfig {
	mode: PermissionMode;
	rules: PermissionRule[];
	cwd: string;
	/** Workspace roots acceptEdits applies to (defaults to cwd). */
	workspaceRoots?: string[];
}

/**
 * Rule-based evaluation. Returns allow/deny when rules or modes decide;
 * returns ask when a human decision is needed. The caller (app layer) turns
 * remaining asks into a dialog or, in dontAsk mode, a deny.
 */
export function evaluatePermissions(
	toolName: string,
	input: unknown,
	config: PermissionEngineConfig,
): PermissionResult {
	if (config.mode === "bypassPermissions") return { behavior: "allow" };

	// Deny rules win across every source (check before mode shortcuts).
	for (const rule of config.rules) {
		if (rule.behavior !== "deny") continue;
		if (ruleMatches(rule, toolName, input, config.cwd)) {
			return { behavior: "deny", message: `Denied by ${rule.source} rule: ${formatRule(rule)}` };
		}
		// A file deny rule also covers shell commands that read that file —
		// otherwise Bash is an open bypass around every file deny rule.
		if (toolName === "Bash") {
			const path = bashHitsFileDenyRule(rule, input, config.cwd);
			if (path !== null) {
				return {
					behavior: "deny",
					message: `Denied by ${rule.source} rule: ${formatRule(rule)} (command accesses "${path}")`,
				};
			}
		}
	}

	// Mode shortcuts after deny rules (so explicit denies can override mode shortcuts).
	if (config.mode === "plan" && !isReadOnlyTool(toolName)) {
		return { behavior: "deny", message: `Plan mode: ${toolName} is not allowed (read-only mode)` };
	}
	if (config.mode === "acceptEdits" && isWorkspaceEdit(toolName, input, config)) {
		return { behavior: "allow" };
	}

	// Among allows, later sources win — any match is enough since denies lost.
	for (const rule of config.rules) {
		if (rule.behavior !== "allow") continue;
		if (ruleMatches(rule, toolName, input, config.cwd)) {
			return { behavior: "allow" };
		}
	}

	return { behavior: "ask" };
}

function ruleMatches(rule: PermissionRule, toolName: string, input: unknown, cwd: string): boolean {
	if (rule.toolName !== toolName && rule.toolName !== "*") return false;
	if (rule.specifier === undefined) return true; // bare tool rule
	return inputMatchesSpecifier(toolName, rule.specifier, input, cwd);
}

function isReadOnlyTool(toolName: string): boolean {
	return ["Read", "Grep", "Glob", "LS", "TodoWrite", "TaskList", "TaskGet"].includes(toolName);
}

function isWorkspaceEdit(toolName: string, input: unknown, config: PermissionEngineConfig): boolean {
	if (toolName !== "Edit" && toolName !== "Write") return false;
	if (typeof input !== "object" || input === null) return false;
	const filePath = String((input as Record<string, unknown>).file_path ?? "");
	if (!filePath) return false;
	const resolved = resolveCanonical(filePath, config.cwd);
	const roots = config.workspaceRoots ?? [config.cwd];
	return roots.some((root) => {
		const normalizedRoot = `${resolveCanonical(root, config.cwd).replace(/\/$/, "")}/`;
		return resolved.toLowerCase().startsWith(normalizedRoot.toLowerCase());
	});
}

export function formatRule(rule: PermissionRule): string {
	return rule.specifier !== undefined ? `${rule.toolName}(${rule.specifier})` : rule.toolName;
}

/** Parse a settings `permissions.allow` / `permissions.deny` string array. */
export function parseRuleList(entries: string[], behavior: "allow" | "deny", source: RuleSource): PermissionRule[] {
	const rules: PermissionRule[] = [];
	for (const entry of entries) {
		const parsed = parseRuleText(entry);
		if (parsed) rules.push({ ...parsed, behavior, source });
	}
	return rules;
}
