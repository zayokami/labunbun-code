/**
 * Permission rule engine (pure — no I/O, no UI).
 *
 * Rule syntax: "Tool" or "Tool(specifier)" e.g.
 *   Bash · Bash(git *) · Bash(npm run *) · Edit(src/**) · Read(~/.ssh/*)
 *   mcp__github · mcp__github__*
 *
 * Evaluation order, and the order is the security property:
 *
 *   1. deny rules, across every source. No mode and no sandbox setting gets to
 *      reach past them — a rule the user wrote is a floor, not a preference.
 *   2. the dangerous-command classifier, for Bash. Also above every mode, and
 *      also above `danger-full-access`: turning the sandbox off is not a request
 *      to stop classifying.
 *   3. `plan`'s read-only tool list, which is a deny and so sits above the
 *      allow rules for the same reason step 1 does.
 *   4. among allows, the first match decides, and there is deliberately no
 *      precedence between sources — every allow produces the same answer, so
 *      which one matched is not observable. `RULE_SOURCE_ORDER` still fixes the
 *      order rules are *collected* in, because that is what makes a rule's
 *      reported source stable.
 *   5. the mode's own answer to "nothing decided it": `agent` runs it, `ask`
 *      brings it to a person.
 *
 * Step 2 is a filter, not a gate, and the difference matters at step 5: a
 * command the classifier does not recognise falls through to `agent` mode and
 * runs. What the classifier buys is that the commands it *does* recognise stop
 * there — it is not a whitelist, and nothing upstream treats its silence as
 * safety.
 *
 * Step 1 used to come after a `bypassPermissions` early return, so that one mode
 * was the only thing in the system that could overrule a user's own `deny`. That
 * line is gone; `deny-scan-first` was already written down as a security
 * invariant in `.labunbun/skills/code-review-security/SKILL.md:8`, and the code
 * was the thing that disagreed with it.
 */
import { resolve } from "node:path";
import {
	classifyDangerousCommand,
	type DangerousCommandMatch,
	type DangerousCommandPlatform,
} from "./dangerous-command.ts";
import { splitShellCommands, tokenizeShell } from "./shell-tokens.ts";
import type { PermissionMode, PermissionResult, SandboxMode } from "./types.ts";

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
export { COMMAND_SEPARATOR_RE, tokenizeShell } from "./shell-tokens.ts";

// Long-form design notes: docs/dev/command-classifier.md
/** Best-effort extraction of file paths a shell command would read or write. */
export function extractBashFilePaths(command: string): string[] {
	const found: string[] = [];

	for (const segment of splitShellCommands(command)) {
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

// Long-form design notes: docs/dev/command-classifier.md
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
	/**
	 * The other axis. Read here so the engine can refuse to widen access, not to
	 * decide anything: `danger-full-access` does not skip the classifier and does
	 * not skip the deny rules, and the one thing it does is tell the caller which
	 * policy to hand the process.
	 */
	sandbox: SandboxMode;
	rules: PermissionRule[];
	cwd: string;
	/**
	 * Whose command semantics the dangerous-command classifier reads a Bash line
	 * with. Defaults to the running platform; overridable so both sets of rules
	 * are testable from one machine rather than one of them being skipped.
	 */
	platform?: DangerousCommandPlatform;
}

/**
 * Rule-based evaluation. Returns allow/deny when rules or modes decide;
 * returns ask when a human decision is needed. The caller (app layer) turns
 * remaining asks into a dialog — or, when there is nobody to ask, a deny.
 */
export function evaluatePermissions(
	toolName: string,
	input: unknown,
	config: PermissionEngineConfig,
): PermissionResult {
	// 1. Deny rules, across every source. First, and with no mode above it.
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

	// 2. `plan` is a deny, and it sits ABOVE the classifier as well as above the
	//    allow rules, for the same reason step 1 does: an allow rule must not buy
	//    a write in a mode whose whole promise is that there are none.
	//
	//    **Above the classifier is the half that was missing, and it had the mode
	//    backwards.** `Bash` is not in `PLAN_MODE_READ_ONLY_TOOLS`, so this check
	//    denies every shell command under `plan` — but the classifier returned
	//    first, and `decideDangerous` only made `agent` terminal, so `plan` fell
	//    through to `ask`. Measured with the engine called directly, before this
	//    move:
	//
	//        plan  rm -rf /     => ask    Blocked as a dangerous command: `rm` with a force option
	//        plan  git status   => deny   Plan mode: Bash is not allowed (read-only mode)
	//
	//    The safe command was hard-denied and only the destructive one reached a
	//    human, in the one mode whose promise is no shell at all. Answering that
	//    dialog let a shell command run while the session was in plan mode, and it
	//    took no user rule to reach — the ordering alone did it.
	//
	//    Hoisting changes nothing else, and that is checked rather than hoped: the
	//    classifier is gated on `toolName === "Bash"`, and `Bash` is exactly what
	//    this check denies, so every other tool already arrived here with the same
	//    answer it gets now.
	if (config.mode === "plan" && !isReadOnlyTool(toolName)) {
		return { behavior: "deny", message: `Plan mode: ${toolName} is not allowed (read-only mode)` };
	}

	// 3. The dangerous-command classifier, above every mode still standing and
	//    above the sandbox setting both ways. A match is terminal: it returns here,
	//    so no allow rule below can turn it into a pass. A non-match grants nothing
	//    on its own — it has no opinion — and the decision carries on below, where
	//    an allow rule or `agent` mode may still say yes. That is the limit worth
	//    stating: what this classifier does not recognise becomes an ordinary
	//    command, and the rules below are what an ordinary command gets.
	if (toolName === "Bash") {
		const command = readBashCommand(input);
		if (command === undefined) {
			// Long-form design notes: docs/dev/command-classifier.md
			return {
				behavior: "deny",
				message: `Bash: the call carries no readable string command, so nothing can be classified. Refused rather than treated as safe — a call that is not shaped like a Bash call should have failed schema validation first.`,
			};
		}
		const match = classifyDangerousCommand(command, config.platform);
		if (match) return decideDangerous(match, config.mode);
	}

	// 4. Among allows, the first match decides. Which one that is depends on the
	//    order `config.rules` arrives in, so there is deliberately no precedence
	//    between sources here: every allow produces the same answer, and a rule
	//    that only *looked* stronger because it was later would be an ordering
	//    nobody chose. Denies already ran in step 1, so nothing below this can
	//    widen past one.
	for (const rule of config.rules) {
		if (rule.behavior !== "allow") continue;
		if (ruleMatches(rule, toolName, input, config.cwd)) {
			return { behavior: "allow" };
		}
	}

	// 5. The mode's own answer to "nothing decided it": `agent` runs it,
	//    `ask` brings it to a person.
	return { behavior: config.mode === "agent" ? "allow" : "ask" };
}

/** The Bash tool's `command` field, when this call really is a Bash call. */
function readBashCommand(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const command = (input as Record<string, unknown>).command;
	return typeof command === "string" ? command : undefined;
}

// Long-form design notes: docs/dev/command-classifier.md
/** What a classified command becomes, per mode. */
function decideDangerous(match: DangerousCommandMatch, mode: PermissionMode): PermissionResult {
	const why = `Blocked as a dangerous command: ${match.rule}`;
	if (mode === "agent") {
		return {
			behavior: "deny",
			message: `${why}. No permission mode runs this without an explicit rule naming it.`,
		};
	}
	return { behavior: "ask", message: why };
}

// Long-form design notes: docs/dev/command-classifier.md
/** Does a bare (specifier-less) MCP rule cover this tool? */
function mcpRuleMatches(ruleToolName: string, toolName: string): boolean {
	if (ruleToolName === toolName) return true;
	if (ruleToolName.includes("*")) return specifierToRegExp(ruleToolName).test(toolName);
	// Server-wide form: `mcp__github` covers every tool that server exposes.
	return toolName.startsWith(`${ruleToolName}__`);
}

function ruleMatches(rule: PermissionRule, toolName: string, input: unknown, cwd: string): boolean {
	if (rule.specifier === undefined && rule.toolName.startsWith("mcp__")) {
		return mcpRuleMatches(rule.toolName, toolName);
	}
	if (rule.toolName !== toolName && rule.toolName !== "*") return false;
	if (rule.specifier === undefined) return true; // bare tool rule
	return inputMatchesSpecifier(toolName, rule.specifier, input, cwd);
}

// Long-form design notes: docs/dev/command-classifier.md
/** What plan mode still permits: the tools that only look at the world, and the one that only asks about it. */
export const PLAN_MODE_READ_ONLY_TOOLS: readonly string[] = [
	"Read",
	"Grep",
	"Glob",
	"LS",
	"BashOutput",
	"WebFetch",
	"WebSearch",
	"TaskList",
	"TaskGet",
	"BandMessage",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
];

function isReadOnlyTool(toolName: string): boolean {
	return PLAN_MODE_READ_ONLY_TOOLS.includes(toolName);
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
