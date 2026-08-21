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

function pathMatches(filePath: string, specifier: string, cwd: string): boolean {
	const file = normalizePathSpec(filePath);
	const spec = normalizePathSpec(specifier);
	const candidates = new Set([file, file.toLowerCase()]);

	// Workspace-relative form.
	const normalizedCwd = `${normalizePathSpec(cwd).replace(/\/$/, "")}/`;
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

	// Mode shortcuts first.
	if (config.mode === "plan" && !isReadOnlyTool(toolName)) {
		return { behavior: "deny", message: `Plan mode: ${toolName} is not allowed (read-only mode)` };
	}
	if (config.mode === "acceptEdits" && isWorkspaceEdit(toolName, input, config)) {
		return { behavior: "allow" };
	}

	// Deny rules win across every source.
	for (const rule of config.rules) {
		if (rule.behavior !== "deny") continue;
		if (ruleMatches(rule, toolName, input, config.cwd)) {
			return { behavior: "deny", message: `Denied by ${rule.source} rule: ${formatRule(rule)}` };
		}
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
	const roots = config.workspaceRoots ?? [config.cwd];
	return roots.some((root) => {
		const normalizedRoot = `${normalizePathSpec(root).replace(/\/$/, "")}/`;
		return normalizePathSpec(filePath).toLowerCase().startsWith(normalizedRoot.toLowerCase());
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
