/**
 * Permission rule engine (pure — no I/O, no UI).
 *
 * Rule syntax: "Tool" or "Tool(specifier)" e.g.
 *   Bash · Bash(git *) · Bash(npm run *) · Edit(src/**) · Read(~/.ssh/*)
 *   mcp__github · mcp__github__*
 *
 * A rule's behavior used to be one of two values, which could not express the
 * request "run my file edits, but bring me git commits": that is neither an
 * allow of the command nor a denial of it. `ask` is the third value, and the
 * difference from the others is that it decides for the *dialog*, not for the
 * call — a match stops an unattended run and hands the call to a human.
 *
 * Evaluation order, and the order is the security property:
 *
 *   1. deny rules, across every source. No mode and no sandbox setting gets to
 *      reach past them — a rule the user wrote is a floor, not a preference.
 *   2. `plan`'s read-only tool list, which is a deny and so sits above the ask
 *      and allow rules for the same reason step 1 does.
 *   3. the dangerous-command classifier, for Bash. Also above every mode, and
 *      also above `danger-full-access`: turning the sandbox off is not a request
 *      to stop classifying. A match is still terminal here — an ask rule below
 *      it cannot soften a `deny` into a question.
 *   4. ask rules, across every source. A match returns `ask` and nothing below
 *      it (no allow rule, no mode) turns that into a run. This is the step the
 *      third behavior exists for.
 *   5. among allows, the first match decides, and there is deliberately no
 *      precedence between sources — every allow produces the same answer, so
 *      which one matched is not observable. `RULE_SOURCE_ORDER` still fixes the
 *      order rules are *collected* in, because that is what makes a rule's
 *      reported source stable.
 *   6. the mode's own answer to "nothing decided it": `agent` runs it, `ask`
 *      brings it to a person.
 *
 * The two ties, decided rather than left to the loop order:
 *
 *   - deny over ask. Step 1 runs first and returns, so a call matching both is
 *     refused. An ask never lifts a floor.
 *   - ask over allow. A standing allow ("don't ask again", which is the widest
 *     grant a session can hold) is exactly what an ask rule exists to punch
 *     through — ask me every time for git commits is written *because* some
 *     broad grant would otherwise swallow them. If allow won, the ask rule
 *     would work until the first broad grant and then go quiet, which is the
 *     one failure a user cannot see. The dialog keeps its side of the bargain
 *     the other way: an "always allow" answered for a scope replaces the
 *     session's ask rule of that same scope (the app layer does the
 *     replacement), so the button still means what it says.
 *
 * Step 3 is a filter, not a gate, and the difference matters at step 6: a
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
	/**
	 * What a match decides. `allow` runs the call, `deny` refuses it, and `ask`
	 * neither: it forces the question, in every mode, including the ones that
	 * would have run the call unattended. See the evaluation order above for how
	 * the three rank against each other.
	 */
	behavior: "allow" | "deny" | "ask";
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
 * Does a Bash command touch a file that a file-tool rule protects? Returns the
 * offending path so the verdict can name it.
 *
 * Asked of deny rules and of ask rules, and **not** of allow rules: a file deny
 * or ask is a statement about what the user wants held back, and Bash would be
 * an open bypass around either one — the deny case unrefused a whole category
 * of writes, the ask case silently unasked. An allow is one-directional by
 * design (granting a file tool says nothing about the shell), so it is excluded
 * here rather than symmetrically included.
 */
function bashHitsFileRule(rule: PermissionRule, input: unknown, cwd: string): string | null {
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
	/**
	 * The read-only answer for every tool the caller registered, derived from the
	 * tool objects themselves (`collectReadOnlyToolNames`) rather than from
	 * {@link PLAN_MODE_READ_ONLY_TOOLS}.
	 *
	 * The engine is handed names, never tool objects, so a caller that holds the
	 * objects computes this once and hands the answer down; the plan gate then
	 * reads the same source the tools declare from. Absent, the gate falls back
	 * to the static list — callers with no tool objects (tests, embedders) keep
	 * working — and `plan-mode-allowlist.test.ts` holds the two in step.
	 */
	readOnlyToolNames?: ReadonlySet<string>;
}

/**
 * Rule-based evaluation. Returns allow/deny when rules or modes decide; returns
 * ask when a human decision is needed — an ask rule demanded one, the
 * classifier flagged the command in a mode that asks, or the mode left the call
 * undecided. The caller (app layer) turns remaining asks into a dialog — or,
 * when there is nobody to ask, a deny.
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
			const path = bashHitsFileRule(rule, input, config.cwd);
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
	if (config.mode === "plan" && !isReadOnlyTool(toolName, config.readOnlyToolNames)) {
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

	// 4. Ask rules, across every source, above every allow and above every mode.
	//    A match comes back `ask` — the one verdict no mode resolves by itself:
	//    `agent` would otherwise have run the call, and the dialog is the entire
	//    point of the rule. This is where "file edits go through, but git commits
	//    come to me" is expressed, and it is checked before the allow loop below
	//    for the reason the file header pins down: an ask rule is written to
	//    survive the broad grants that would otherwise swallow it.
	for (const rule of config.rules) {
		if (rule.behavior !== "ask") continue;
		if (ruleMatches(rule, toolName, input, config.cwd)) {
			return { behavior: "ask", message: `Asked by ${rule.source} rule: ${formatRule(rule)}` };
		}
		// The deny loop's Bash cross-check, asked of ask rules too: a file the
		// user wants to be consulted about is one the shell should not reach
		// silently either.
		if (toolName === "Bash") {
			const path = bashHitsFileRule(rule, input, config.cwd);
			if (path !== null) {
				return {
					behavior: "ask",
					message: `Asked by ${rule.source} rule: ${formatRule(rule)} (command accesses "${path}")`,
				};
			}
		}
	}

	// 5. Among allows, the first match decides. Which one that is depends on the
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

	// 6. The mode's own answer to "nothing decided it": `agent` runs it,
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
/**
 * What a classified command becomes, per mode.
 *
 * The `agent` arm's message used to end "No permission mode runs this without
 * an explicit rule naming it", which promises an escape hatch that does not
 * exist: `evaluatePermissions` calls this at step 3, above both the ask loop and
 * the allow loop, so no rule — allow or ask — lifts the refusal. What actually
 * spends a classified command is a person answering the dialog, which only
 * `ask` mode offers, and the message says that instead of pointing at a rule
 * that would not work.
 */
function decideDangerous(match: DangerousCommandMatch, mode: PermissionMode): PermissionResult {
	const why = `Blocked as a dangerous command: ${match.rule}`;
	if (mode === "agent") {
		return {
			behavior: "deny",
			message: `${why}. The refusal is final in this mode: no allow or ask rule lifts it, and only a person — answering the dialog in ask mode — can decide to spend it.`,
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
	"Digest",
	"InspectSqlite",
	"InspectArtifact",
	"InspectBinary",
	"InspectSourceMap",
	"CompareArtifacts",
	"TaskList",
	"TaskGet",
	"Skill",
	"BandMessage",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
];

/**
 * Whether plan mode still permits this tool.
 *
 * A caller-provided set wins: it was derived from the live tool objects, so the
 * declaration on the tool is what decides. Otherwise the static list is the
 * answer — it is also the reference the bilateral test measures every built-in
 * declaration against, so the two readings cannot drift apart.
 */
function isReadOnlyTool(toolName: string, declared?: ReadonlySet<string>): boolean {
	return declared ? declared.has(toolName) : PLAN_MODE_READ_ONLY_TOOLS.includes(toolName);
}

/**
 * The names of the tools whose own declaration says they only read.
 *
 * Presence in the set is the whole answer: `isReadOnly` is asked with an empty
 * input object, which is what every declaration in this build answers from
 * (`() => true` / `() => false`). A declaration that ever wanted the input
 * itself could not be folded into a set — it would have to be asked at the call
 * site — so the empty object is a deliberate, visible limit rather than a
 * hidden one.
 */
export function collectReadOnlyToolNames(
	tools: ReadonlyArray<{ name: string; isReadOnly?: (input: never) => boolean }>,
): ReadonlySet<string> {
	const names = new Set<string>();
	for (const tool of tools) {
		if (tool.isReadOnly?.({} as never)) names.add(tool.name);
	}
	return names;
}

export function formatRule(rule: PermissionRule): string {
	return rule.specifier !== undefined ? `${rule.toolName}(${rule.specifier})` : rule.toolName;
}

/**
 * Parse a settings rule string array — `permissions.allow`, `permissions.deny`,
 * or `permissions.ask`. The behavior is the list's name, not a field of its
 * entries; the syntax inside each string is the same for all three.
 */
export function parseRuleList(
	entries: string[],
	behavior: PermissionRule["behavior"],
	source: RuleSource,
): PermissionRule[] {
	const rules: PermissionRule[] = [];
	for (const entry of entries) {
		const parsed = parseRuleText(entry);
		if (parsed) rules.push({ ...parsed, behavior, source });
	}
	return rules;
}
