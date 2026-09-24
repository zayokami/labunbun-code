/**
 * MiniMax Code's user state: `config.yaml`, `permission.json`, `mcp.json`,
 * `AGENTS.md`, skills, agents, plans, and `v2/sessions`.
 *
 * The rule encoding lives here rather than in the planner because it is a
 * decoding problem, not a decision: MiniMax writes a rule as an escaped string
 * that has to be taken apart before anything can be planned from it.
 */

import type { Dirent } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { countTreeEntries, isRecord, readDirectoryNames, readSkillDirs, readText } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import type { MinimaxRoot } from "./minimax-home.ts";
import {
	MINIMAX_INSTALL_DIR,
	minimaxAgentsDir,
	minimaxConfigPath,
	minimaxDataState,
	minimaxDraftsDir,
	minimaxGlobalInstructionsPath,
	minimaxLegacyChatsDir,
	minimaxLegacyDataDir,
	minimaxMcpAliasFile,
	minimaxMcpFile,
	minimaxMemoryDir,
	minimaxPermissionFile,
	minimaxPlansDir,
	minimaxPluginsDir,
	minimaxRoot,
	minimaxSkillsDir,
} from "./minimax-home.ts";

/**
 * Why one MiniMax rule could not become a rule here.
 *
 * `inert-there` — MiniMax itself never consults it, so leaving it behind costs
 * nothing: the tool name matches no tool it has (`permissionToolMatches`,
 * `local-runtime/src/permissions/rule-match.ts:87-91`) or the matcher speaks
 * about an action the tool does not perform (`:63-67`).
 *
 * `no-specifier-grammar` — MiniMax does consult it, and this engine does not:
 * a specifier is only read for `Bash`, `Read`, `Write`, `Edit` and MCP tool
 * names (`packages/agent/src/permissions.ts:213-245`). This one is a real loss
 * and the direction of the loss depends on the behavior.
 */
export type MinimaxRuleDropReason = "inert-there" | "no-specifier-grammar";

/** One rule that did not come across, with the name it was written under. */
export interface MinimaxRuleDrop {
	/** The rule as the source spells it, e.g. `glob(/etc/**)`. */
	rule: string;
	/** The tool name the source used, so the report can group by it. */
	tool: string;
	behavior: "allow" | "deny";
	reason: MinimaxRuleDropReason;
}

/**
 * `~/.minimax/permission.json`, decoded into rule text this build's engine reads.
 *
 * The file holds the user's allow/deny/ask decisions in one of two generations
 * (`local-runtime/src/permissions/rule-codec.ts`): v1 is a Claude-Code-shaped
 * `{allow, deny, ask}` of `Tool(pattern)` strings, v2 is
 * `{version: 2, allow, deny, ask}` of `{tool_name, matcher}` records whose
 * matcher is `tool`, `command` or `path` — and only the `path` matcher carries
 * an `actions` list, because the other two are already scoped by the tool.
 *
 * The two engines are close relatives: MiniMax's v1 grammar is Claude Code's,
 * and this build's `Tool(specifier)` grammar is the same family, so a rule
 * carries as text with its tool name translated. The exceptions are the ones
 * the two engines do not agree on, and they are named one by one in
 * {@link notCarried} rather than left to be discovered.
 */
export interface MinimaxPermissions {
	allow: string[];
	deny: string[];
	/** `ask` rules, by count: this build's settings hold allow and deny only. */
	askCount: number;
	/** Which generation of the file was read. */
	version: 1 | 2;
	notCarried: MinimaxRuleDrop[];
	/**
	 * Bash rules that ended in `:*` over there, as the source spelled them.
	 *
	 * MiniMax reads that suffix as its own word-boundary command prefix
	 * (`matchesCommandPrefix`, `rule-match.ts:141-148`), a shape this build's
	 * engine does not have: a Bash specifier here is a glob over the whole
	 * command line (`packages/agent/src/permissions.ts:213-222`), so a rule
	 * carried verbatim as `Bash(sed:*)` would match the literal text `sed:` and
	 * nothing else — a dead allow *and* a dead deny. These are carried as
	 * `Bash(sed*)`, the closest one-rule equivalent, and the two ways that is
	 * wider are named in the report rather than left in the code.
	 */
	widened: string[];
}

/**
 * MiniMax Code's user state.
 *
 * One tree, in one of three places: `$MINIMAX_DATA_DIR`, else `$MAVIS_DATA_DIR`,
 * else `<home>/.minimax` — {@link minimaxRoot} owns that rule, including the
 * trim and the refusal to expand `~`. The predecessor tree `<home>/.mavis` is a
 * second question rather than a second source: it is the same tree under its
 * older name, and {@link minimaxLegacyDataDir} answers "separate directory, or
 * a link to the one we already have" the way the vendor answers it.
 */
export interface RawMinimaxCode {
	/** The tree that was read — see {@link legacyRead} for which one that is. */
	root: string;
	/** Which rule named {@link root}: an override, the older override, or the default. */
	origin: MinimaxRoot["origin"];
	present: boolean;
	/**
	 * `~/.mavis` (or `$MAVIS_DATA_DIR`) when it is a genuinely separate tree, so
	 * the report can say whether this run read it.
	 */
	legacyRoot: string | null;
	/**
	 * True when the rules above produced {@link root} — the vendor renames that
	 * tree into `.minimax` on its next start, so on a machine that has not run a
	 * current build it is the only tree there is.
	 */
	legacyRead: boolean;
	/** `<root>/config.yaml` — the one global settings document. */
	config: Record<string, unknown>;
	/** Why `config.yaml` contributed nothing, when it was there but unreadable. */
	configError?: string;
	permissions: MinimaxPermissions;
	/**
	 * Why `permission.json` contributed nothing.
	 *
	 * Set for every way the file can be unusable, because MiniMax treats them the
	 * same way: one malformed entry, one unknown version, a corrupt document or a
	 * shape that is not an object all raise `LocalPermissionStoreUnhealthyError`
	 * (`local-runtime/src/permissions/rules.ts:214-262`), which its callers turn
	 * into "ask about everything" rather than "allow everything". Rules out of a
	 * store the source itself refuses are intentions currently in force nowhere,
	 * so none of them is imported.
	 */
	permissionError?: string;
	/** `<root>/mcp.json` — a `{"mcpServers": {…}}` wrapper, as this build's own file. */
	mcp: Record<string, unknown>;
	/**
	 * `<root>/mcp/mcp.json` — the older spelling of the same document, read
	 * whatever the first file holds, because a name in it that the first file
	 * does not define is a server the user wrote and never sees again.
	 */
	mcpAlias: Record<string, unknown>;
	/** Why a file contributed nothing, when it was there but unreadable, each named. */
	mcpErrors: string[];
	/** `<root>/AGENTS.md` — the user-global instruction document. */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
	/** Agent directories with no `agent.md`, by name: MiniMax keeps no roster entry for them either. */
	agentSkips: Array<{ name: string; reason: string }>;
	/** The agent copies MiniMax ships under `agents/.builtin`, by name. Counted; never read. */
	builtinAgentNames: string[];
	/**
	 * Skill trees under `agents/<name>/skills`, by agent, with their entry
	 * counts. Scoped to one agent over there, global here — named, not imported.
	 */
	agentSkillTrees: Array<{ name: string; count: number }>;
	/** The vendor's own skills under `<root>/.builtin-skills`. Counted; never read. */
	builtinSkillNames: string[];
	/** Plugin directories under `<root>/plugins`, by name. Counted; never walked. */
	pluginNames: string[];
	/** Plan documents under `<root>/plans`, by name. Counted; never read. */
	planNames: string[];
	/**
	 * `<root>/review-rules`, by name — the user's own instructions for the code
	 * reviewer, which MiniMax splices into a review prompt as
	 * `<user-review-rules>` (`local-runtime/src/review/preparation.ts:80-82`).
	 * Named rather than imported: a rule here is read in every session, and this
	 * one was written for a review turn.
	 */
	reviewRules: string[];
	/** `<root>/memory` entries, by name. Counted; never read. */
	memoryNames: string[];
	/**
	 * `v2/` subdirectories this importer reads nothing out of, by name.
	 *
	 * `chats` holds the pre-`v2` session ledgers and `mcode/drafts` the composer
	 * text a user typed and never sent. Both are the user's own writing and
	 * neither is a settings document, so they are named and left.
	 */
	unreadV2Dirs: string[];
	/**
	 * Entry names under the root that look like credentials — `auth`,
	 * `credentials`, `cli-auth` and anything else matching the same pattern.
	 * Reported by name; never opened.
	 */
	credentialEntries: string[];
	/** Directories under the root this importer has no mapping for, with entry counts. */
	otherDirs: Array<{ name: string; count: number }>;
	/** `~/.minimax-code`, the installer's own directory. Named when it exists; never read. */
	installDirPresent: boolean;
	/**
	 * Trees other sources own that MiniMax reads by borrowing them: the `agents`
	 * source's `~/.agents/skills`, and Claude Code's and Codex's skill
	 * directories, which MiniMax lists as skill sources of its own.
	 */
	borrowedTrees: string[];
}

// ---------------------------------------------------------------------------
// MiniMax Code
// ---------------------------------------------------------------------------

/** The vendor's own skills root (`packages/config/src/config.ts:2078`, `builtinSkillsDir`). */
export const MINIMAX_BUILTIN_SKILLS_DIR = ".builtin-skills";

/** Top-level entries under the data dir this reader accounts for by name. */
const MINIMAX_KNOWN_DIRS = new Set([
	"v2",
	"agents",
	"skills",
	MINIMAX_BUILTIN_SKILLS_DIR,
	"plugins",
	"plans",
	"memory",
	"mcp",
	"credentials",
	"review-rules",
]);

/**
 * The directories MiniMax reads by borrowing another agent's tree, and the
 * config key that turns each one off.
 *
 * `readExternalUserSkillRoots` (`local-runtime/src/skills/roots.ts:129-137`)
 * adds Claude Code's, Codex's and the shared agents home's skill directories to
 * MiniMax's own skill search, and `DEFAULT_SKILLS_CONFIG`
 * (`packages/config/src/skills-config.ts:62-76`) has all three on. That makes
 * them borrowed rather than MiniMax's: the `claude-code`, `codex` and `agents`
 * sources each own one of them, and importing them here as well would put every
 * skill in the collection twice.
 *
 * The project-level half of the same list (`<workspace>/.minimax/skills`,
 * `<workspace>/.claude/skills`, `<workspace>/.agents/skills`, with a walk up to
 * the repository root when `walkUp` is on) is about a working directory, not
 * about this tree, so it is named in the plan rather than looked for.
 */
const MINIMAX_BORROWED_TREES: Array<{ key: string; legacyKey?: string; path: string }> = [
	{ key: "user-cc", legacyKey: "user-claude", path: join(".claude", "skills") },
	{ key: "user-codex", path: join(".codex", "skills") },
	{ key: "user-agents", path: join(".agents", "skills") },
];

/** Directories under `<root>/agents` that are not one user's agent. */
export const MINIMAX_BUILTIN_AGENTS_DIR = ".builtin";

/** The file MiniMax connects MCP servers from, named as the report spells it. */
export const MINIMAX_MCP_FILE_NAME = "mcp.json";

/**
 * A tool name in a MiniMax permission rule, and the name this build's engine
 * knows for the same tool.
 *
 * The two engines are relatives — MiniMax's rule strings are Claude Code's
 * syntax (`parseRuleString`, `local-runtime/src/permissions/rule-codec.ts:166-181`)
 * and this build's `Tool(specifier)` is the same shape — but their tool names
 * are not the same strings: MiniMax's are lower case and this build's are not,
 * and a rule naming a tool that does not exist where it is read is a rule that
 * silently does nothing.
 *
 * `action` is the capability MiniMax says this tool performs
 * (`permissionInputAction`, `local-runtime/src/permissions/rule-match.ts:78-85`);
 * it is read only for `path` matchers, the one matcher kind that carries its own
 * `actions` list. `fs` is the umbrella name MiniMax puts over the file tools, so
 * it expands to every one of them whose action the rule asks for.
 */
const MINIMAX_TOOL_NAMES: Record<string, Array<{ name: string; action: MinimaxAction }>> = {
	read: [{ name: "Read", action: "read" }],
	write: [{ name: "Write", action: "write" }],
	edit: [{ name: "Edit", action: "write" }],
	apply_patch: [{ name: "Edit", action: "write" }],
	glob: [{ name: "Glob", action: "read" }],
	grep: [{ name: "Grep", action: "read" }],
	list: [{ name: "LS", action: "read" }],
	web_fetch: [{ name: "WebFetch", action: "network" }],
	web_search: [{ name: "WebSearch", action: "network" }],
	bash: [{ name: "Bash", action: "execute" }],
	fs: [
		{ name: "Read", action: "read" },
		{ name: "Write", action: "write" },
		{ name: "Edit", action: "write" },
	],
};

/** The capabilities a MiniMax rule can be scoped to (`rule-codec.ts:44-51`). */
type MinimaxAction = "read" | "write" | "delete" | "execute" | "network";

/**
 * The tool names whose specifier this build's engine actually consults.
 *
 * `inputMatchesSpecifier` (`packages/agent/src/permissions.ts:213-245`) has a
 * case for `Bash`, one for the file tools, one for `mcp__…`, and a default that
 * answers `false`. A rule for any other name in that position is written to no
 * effect — the file holds it, nothing reads it — which is the one outcome a
 * migration must not produce quietly.
 */
const MINIMAX_SPECIFIER_TOOLS = new Set(["Bash", "Read", "Write", "Edit"]);

/** `Tool(pattern)`, `Tool`, or a bare name; the same split MiniMax's reader makes. */
function splitMinimaxRuleString(raw: string): { toolName: string; pattern?: string } {
	const open = raw.indexOf("(");
	if (open <= 0 || raw[open - 1] === "\\") return { toolName: raw };
	const close = raw.lastIndexOf(")");
	if (close <= open) return { toolName: raw };
	const toolName = raw.slice(0, open);
	const pattern = raw.slice(open + 1, close);
	return pattern ? { toolName, pattern } : { toolName };
}

/** The rule as the source spells it, for the record of what did not come across. */
function formatMinimaxRule(toolName: string, pattern?: string): string {
	return pattern === undefined ? toolName : `${toolName}(${pattern})`;
}

/**
 * One entry of either generation, decoded into this build's rule text.
 *
 * The three things that can happen, and why each is the one that is right:
 *
 *   - the rule carries. Its tool name is translated and its pattern is kept as
 *     written, because the two grammars agree on the shapes that matter: a
 *     `/**` subtree, an exact path, a `*`-suffixed command prefix — with one
 *     exception, the `:*` suffix below. A rule whose meaning would change under
 *     the translation is not carried — that is the next two cases;
 *   - it is left behind because MiniMax does not consult it either, and then
 *     nothing is lost: a name no MiniMax tool has (`permissionToolMatches`,
 *     `rule-match.ts:87-91`, is an exact comparison) or a `path` matcher whose
 *     `actions` exclude the only action its tool performs (`:63-67`);
 *   - it is left behind though MiniMax does consult it, and then something is:
 *     this engine reads a specifier for four tool names and the MCP family, so
 *     `glob(/etc/**)` — live in MiniMax, where a glob's target is the pattern it
 *     was given — is a rule that would sit in the file unread here.
 *
 * The exception is a Bash pattern ending in `:*`. Keeping it as written would
 * be keeping a rule that does nothing here, and *that* is the one outcome worse
 * than a rule that means something slightly different: `Bash(sed:*)` reads as
 * `sed:*` as a glob, which matches no command a user ever runs, so a deny
 * written that way protects nothing after the migration. It is rewritten to the
 * glob the two engines both understand and the rewrite is recorded in
 * {@link widened}, where the report picks it up.
 *
 * What this does not try to reproduce: which *matcher kind* a v1 entry has is
 * inferred over there from the shape of its pattern — a leading `/`, `~/`, `./`
 * or a drive letter makes it a path matcher and anything else a command matcher
 * (`inferLegacyMatcher`, `rule-codec.ts:276-292`). The two kinds read the
 * pattern differently, and reproducing the guess here would mean this build
 * deciding what the user meant by a pattern MiniMax was already guessing at. The
 * pattern travels as written, and the caveat the caller writes for the rules it
 * does carry says the two grammars differ.
 */
function decodeMinimaxRule(
	entry: { toolName: string; pattern?: string; actions?: readonly MinimaxAction[] },
	behavior: "allow" | "deny",
	widened: string[] = [],
): { rules: string[]; drops: MinimaxRuleDrop[] } {
	const rules: string[] = [];
	const drops: MinimaxRuleDrop[] = [];
	const mapped = MINIMAX_TOOL_NAMES[entry.toolName];
	if (mapped === undefined) {
		drops.push({
			rule: formatMinimaxRule(entry.toolName, entry.pattern),
			tool: entry.toolName,
			behavior,
			reason: "inert-there",
		});
		return { rules, drops };
	}
	// A rule with no pattern is a bare tool rule in both engines: it matches the
	// tool whatever it is asked to do, which is what a name alone means.
	if (entry.pattern === undefined) {
		for (const target of mapped) rules.push(target.name);
		return { rules, drops };
	}
	for (const target of mapped) {
		// A `path` matcher carries its own actions; the other kinds are already
		// scoped by the tool. A rule whose actions exclude what the tool does is
		// one MiniMax never consults, so leaving it behind costs nothing.
		if (entry.actions !== undefined && !entry.actions.includes(target.action)) continue;
		if (!MINIMAX_SPECIFIER_TOOLS.has(target.name)) {
			drops.push({
				rule: formatMinimaxRule(entry.toolName, entry.pattern),
				tool: target.name,
				behavior,
				reason: "no-specifier-grammar",
			});
			continue;
		}
		if (target.name === "Bash" && entry.pattern.endsWith(":*")) {
			widened.push(formatMinimaxRule(target.name, entry.pattern));
			rules.push(formatMinimaxRule(target.name, `${entry.pattern.slice(0, -2)}*`));
			continue;
		}
		rules.push(formatMinimaxRule(target.name, entry.pattern));
	}
	return { rules, drops };
}

/**
 * `permission.json`, decoded — or nothing at all, when MiniMax would read
 * nothing from it either.
 *
 * Every way this file can be unusable is a *refusal* over there, not a partial
 * read: a corrupt document, a root that is not an object, one malformed v2
 * entry and any *explicit* `version` other than 2 all raise
 * `LocalPermissionStoreUnhealthyError` (`local-runtime/src/permissions/rules.ts:214-262`). "v1" is the shape *without* a `version` key rather than the
 * shape that spells `1` (`record.version === 2` picks the v2 decoder, `!==
 * undefined` is the refusal, and what is left is v1), so a file that writes
 * `version: 1` is refused over there as well — the distinction a hand-edited file
 * gets wrong. The comment at the first of those refusals says what its callers do
 * with it —
 * "Treating it as an empty rule set could drop a persisted deny and silently
 * authorize a command", so the store is treated as unhealthy and the user is
 * asked. A rule out of such a file is a decision that is in force nowhere, and
 * importing the allows out of it would put a set of permissions into effect
 * that the user's own tool is currently refusing to honour.
 */
function readMinimaxPermissions(root: string): Pick<RawMinimaxCode, "permissions" | "permissionError"> {
	const empty: MinimaxPermissions = { allow: [], deny: [], askCount: 0, version: 1, notCarried: [], widened: [] };
	const text = readText(minimaxPermissionFile(root));
	if (text === null) return { permissions: empty };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			permissions: empty,
			permissionError:
				"holds a document that is not JSON, which MiniMax itself refuses to read (it asks about every call instead) — no rule was taken from it",
		};
	}
	if (!isRecord(parsed)) {
		return {
			permissions: empty,
			permissionError: "does not hold an object, which MiniMax itself refuses to read — no rule was taken from it",
		};
	}
	if (parsed.version !== undefined && parsed.version !== 2) {
		return {
			permissions: empty,
			permissionError: `declares version ${JSON.stringify(parsed.version)}, which MiniMax itself refuses to read — no rule was taken from it`,
		};
	}
	const version: 1 | 2 = parsed.version === 2 ? 2 : 1;
	const allow: string[] = [];
	const deny: string[] = [];
	const notCarried: MinimaxRuleDrop[] = [];
	const widened: string[] = [];
	let askCount = 0;
	for (const behavior of ["allow", "deny", "ask"] as const) {
		const list = parsed[behavior];
		// A value that is not a list is an empty one, which is how MiniMax reads it
		// too (`readRuleStringArray`, `rule-codec.ts:121-126`).
		if (!Array.isArray(list)) continue;
		for (const raw of list) {
			if (version === 1) {
				if (typeof raw !== "string" || raw.trim() === "") continue;
				const entry = splitMinimaxRuleString(raw);
				if (behavior === "ask") {
					askCount += 1;
					continue;
				}
				const decoded = decodeMinimaxRule(entry, behavior, widened);
				(behavior === "allow" ? allow : deny).push(...decoded.rules);
				notCarried.push(...decoded.drops);
				continue;
			}
			// v2: `{tool_name, matcher}`. A bad entry here is not skipped — it is the
			// reason the whole file is unreadable, in MiniMax as well as here.
			//
			// `ask` is validated before it is counted, because that is what the
			// source does: `configV2ToRules` maps all three behaviors through the
			// same reader (`rule-codec.ts:143-153`), so a malformed `ask` entry
			// makes MiniMax refuse the store exactly as a malformed `allow` one
			// does. Counting it first would report "N ask rules here have no
			// equivalent" for a store the source reads as empty.
			if (!isRecord(raw) || typeof raw.tool_name !== "string" || raw.tool_name.trim() === "") {
				return {
					permissions: empty,
					permissionError:
						"holds an entry with no tool name, which makes MiniMax refuse the whole store — no rule was taken from it",
				};
			}
			const matcher = raw.matcher;
			if (!isRecord(matcher) || typeof matcher.kind !== "string") {
				return {
					permissions: empty,
					permissionError:
						"holds an entry with no matcher, which makes MiniMax refuse the whole store — no rule was taken from it",
				};
			}
			if (matcher.kind !== "command" && matcher.kind !== "path" && matcher.kind !== "tool") {
				return {
					permissions: empty,
					permissionError: `holds an entry whose matcher kind is ${JSON.stringify(matcher.kind)}, which MiniMax refuses — no rule was taken from it`,
				};
			}
			if (matcher.kind !== "tool" && (typeof matcher.pattern !== "string" || matcher.pattern.trim() === "")) {
				return {
					permissions: empty,
					permissionError:
						"holds a matcher with no pattern, which makes MiniMax refuse the whole store — no rule was taken from it",
				};
			}
			let actions: MinimaxAction[] | undefined;
			if (matcher.kind === "path") {
				if (!Array.isArray(matcher.actions) || matcher.actions.length === 0) {
					return {
						permissions: empty,
						permissionError:
							"holds a path matcher with no actions, which makes MiniMax refuse the whole store — no rule was taken from it",
					};
				}
				actions = matcher.actions.filter((action): action is MinimaxAction =>
					MINIMAX_ACTIONS.has(action as MinimaxAction),
				);
				if (actions.length !== matcher.actions.length) {
					return {
						permissions: empty,
						permissionError:
							"holds a path matcher naming an action MiniMax does not know, which makes it refuse the whole store — no rule was taken from it",
					};
				}
			}
			if (behavior === "ask") {
				askCount += 1;
				continue;
			}
			const value =
				matcher.kind === "tool"
					? { toolName: raw.tool_name }
					: actions === undefined
						? { toolName: raw.tool_name, pattern: matcher.pattern as string }
						: { toolName: raw.tool_name, pattern: matcher.pattern as string, actions };
			const decoded = decodeMinimaxRule(value, behavior, widened);
			const bucket = behavior === "allow" ? allow : deny;
			bucket.push(...decoded.rules);
			notCarried.push(...decoded.drops);
		}
	}
	return { permissions: { allow, deny, askCount, version, notCarried, widened } };
}

/** The five capabilities a v2 `path` matcher may name (`rule-codec.ts:44-51`). */
const MINIMAX_ACTIONS = new Set<MinimaxAction>(["read", "write", "delete", "execute", "network"]);

/** `config.yaml`, parsed, with the reason it contributed nothing when it could not be. */
function readMinimaxConfig(root: string): Pick<RawMinimaxCode, "config" | "configError"> {
	const text = readText(minimaxConfigPath(root));
	if (text === null) return { config: {} };
	try {
		const parsed: unknown = Bun.YAML.parse(text);
		if (isRecord(parsed)) return { config: parsed };
		return { config: {}, configError: "config.yaml holds something other than a table" };
	} catch {
		// A fixed phrase rather than the parser's message, which can quote the line
		// it choked on — and that line is often `apiKey`. The same reason, and the
		// same wording, as the harness reader's.
		return { config: {}, configError: "config.yaml is not parseable as YAML" };
	}
}

/**
 * `mcp.json` (and the `mcp/mcp.json` MiniMax also looks in), parsed.
 *
 * Unlike kimi's bare `{name: server}` map both files are the same
 * `{"mcpServers": {…}}` wrapper this build's own `.mcp.json` uses, so the values
 * travel as they stand.
 *
 * Both are read, and each one's parse failure is reported against its own path:
 * a report that named `mcp.json` for a broken `mcp/mcp.json` would send the user
 * to a file this run never opened. Which of the two *answers* is the planner's
 * decision, because it depends on what MiniMax does with each — see the note at
 * the top of its MCP section.
 */
function readMinimaxMcp(root: string): Pick<RawMinimaxCode, "mcp" | "mcpAlias" | "mcpErrors"> {
	const read = (path: string): { servers: Record<string, unknown> } | { error: string } | null => {
		const text = readText(path);
		if (text === null) return null;
		try {
			const parsed = JSON.parse(text);
			if (!isRecord(parsed)) return { error: "holds something other than an object" };
			const servers = parsed.mcpServers;
			if (!isRecord(servers)) return { servers: {} };
			return { servers };
		} catch {
			return { error: "is not parseable as JSON" };
		}
	};
	const primary = read(minimaxMcpFile(root));
	const alias = read(minimaxMcpAliasFile(root));
	const mcpErrors: string[] = [];
	if (primary !== null && "error" in primary) mcpErrors.push(`mcp.json ${primary.error}`);
	if (alias !== null && "error" in alias) mcpErrors.push(`mcp/mcp.json ${alias.error}`);
	return {
		mcp: primary !== null && "servers" in primary ? primary.servers : {},
		mcpAlias: alias !== null && "servers" in alias ? alias.servers : {},
		mcpErrors,
	};
}

/**
 * The user's agents, one directory each.
 *
 * A MiniMax agent is a *directory* — `agents/<name>/` holding `agent.md` (the
 * system prompt), `config.yaml` (its model selection), and optionally
 * `PERSONA.md`, `skills/`, `memory/`, `crons/` and `daily/`. This build's
 * subagent is a single markdown file, so `agent.md` is what travels.
 *
 * `PERSONA.md` is deliberately not folded into it. The two are separate prompt
 * assets over there (`getPersona` and `getSystemPrompt`, `agent-files.ts:866,906`),
 * and for a *custom* agent — which is what a user's own directory is — only the
 * system prompt becomes `agentSystemPrompt` (`agent-profile.ts:502`), while the
 * persona travels beside it as its own field. Concatenating them here would
 * invent a document that neither tool has, so the persona is named in the
 * agent's note instead and the user can paste it in if they want it inline.
 *
 * `skills/` under an agent is a skill tree scoped to that agent alone
 * (`resolveConfiguredSkillRoots`, `local-runtime/src/skills/roots.ts:40-50`
 * gives every agent its own root). A skill here is global — loaded into every
 * session — so those trees are counted and named rather than imported, the same
 * line the grok source draws at its per-workspace memory.
 */
function readMinimaxAgents(
	root: string,
): Pick<RawMinimaxCode, "agents" | "agentSkips" | "builtinAgentNames" | "agentSkillTrees"> {
	const dir = minimaxAgentsDir(root);
	const agents: RawFile[] = [];
	const agentSkips: Array<{ name: string; reason: string }> = [];
	const builtinAgentNames: string[] = [];
	const agentSkillTrees: Array<{ name: string; count: number }> = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { agents, agentSkips, builtinAgentNames, agentSkillTrees };
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name === MINIMAX_BUILTIN_AGENTS_DIR) {
			// The copies MiniMax ships. Vendor-written, and the source's own updates
			// are what keeps them current.
			builtinAgentNames.push(
				...readdirSync(join(dir, entry.name), { withFileTypes: true })
					.filter((child) => child.isDirectory())
					.map((child) => child.name)
					.sort(),
			);
			continue;
		}
		if (entry.name.startsWith(".")) continue;
		const agentDir = join(dir, entry.name);
		const skills = countTreeEntries(join(agentDir, "skills"));
		if (skills > 0) agentSkillTrees.push({ name: entry.name, count: skills });
		const body = readText(join(agentDir, "agent.md"));
		if (body === null || body.trim() === "") {
			// MiniMax's own roster skips a directory without a readable `agent.md`
			// (`inspectCanonicalCustomAgent`, `agent-files.ts:167-186`), so there is
			// nothing here that would run over there either.
			agentSkips.push({
				name: entry.name,
				reason: "no agent.md, so MiniMax lists no agent of that name either",
			});
			continue;
		}
		const notes: string[] = [];
		if (existsSync(join(agentDir, "PERSONA.md"))) {
			notes.push(
				"PERSONA.md sits beside it and was not folded in: it is this agent's persona, a separate prompt asset in MiniMax, and a subagent here is one document",
			);
		}
		if (existsSync(join(agentDir, "config.yaml"))) {
			notes.push("its config.yaml (the agent's own model selection) was not carried");
		}
		agents.push({
			name: entry.name,
			sourcePath: join(agentDir, "agent.md"),
			content: body,
			...(notes.length > 0 ? { detail: notes.join("; ") } : {}),
		});
	}
	return { agents, agentSkips, builtinAgentNames, agentSkillTrees };
}

/**
 * The trees MiniMax reads out of other agents' homes, and whether it still does.
 *
 * `skills.external` is on by default and so is each of its sources, so on a
 * default install MiniMax is already showing the user Claude Code's, Codex's
 * and `~/.agents`' skills. Turning a source off in `config.yaml` is a user
 * decision this reader honours: naming a tree as borrowed when the user has
 * switched it off would be telling them something about their own config that
 * is not true.
 *
 * A source is named by its current key or by the spelling it had before the
 * rename, and the current one wins when both are written — `parseSkillsConfig`
 * looks for `user-cc` first and falls back to `user-claude`
 * (`LEGACY_SOURCE_KEY_BY_KIND`, `skills-config.ts:41-46, 110-121`). Missing the
 * legacy spelling would be the exact mistake this function exists to avoid: a
 * user who switched the source off under the old name would be told it is on.
 *
 * A value that is not a table leaves the default in place, which is how the
 * source reads it (`parseSource`, `skills-config.ts:96-101`).
 */
function readMinimaxBorrowedTrees(home: string, config: Record<string, unknown>): string[] {
	const skills = isRecord(config.skills) ? config.skills : {};
	const external = isRecord(skills.external) ? skills.external : {};
	if (external.enabled === false) return [];
	const sources = isRecord(external.sources) ? external.sources : {};
	return MINIMAX_BORROWED_TREES.filter((tree) => {
		const source = Object.hasOwn(sources, tree.key)
			? sources[tree.key]
			: tree.legacyKey !== undefined && Object.hasOwn(sources, tree.legacyKey)
				? sources[tree.legacyKey]
				: undefined;
		if (isRecord(source) && source.enabled === false) return false;
		return existsSync(join(home, tree.path));
	}).map((tree) => tree.path);
}

/** Entry names under the root that look like credentials — files or directories. */
const MINIMAX_CREDENTIAL_NAME = /(credential|secret|token|auth|\.env$)/i;

/** Directories under the root with no mapping here, each with its entry count. */
function readMinimaxOtherDirs(root: string, accounted: Set<string>): Array<{ name: string; count: number }> {
	const out: Array<{ name: string; count: number }> = [];
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || MINIMAX_KNOWN_DIRS.has(entry.name) || accounted.has(entry.name)) continue;
			out.push({ name: entry.name, count: countTreeEntries(join(root, entry.name)) });
		}
	} catch {
		// unreadable root — contributes nothing
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readMinimaxCode(home: string): RawMinimaxCode {
	const primary = minimaxRoot(home);
	const legacyRoot = minimaxLegacyDataDir(home);
	// Which tree the vendor would end up reading, walked the way its own resolution
	// walks it (`resolveDataDirPair`, `packages/config/src/data-dir.ts:286-382`) —
	// because its move of the legacy tree is a rename, never a merge, so two trees
	// on one machine are one tree's worth of decisions plus a backup of the other.
	// What decides is the *content* test and not an existence test: an `.minimax`
	// that is there but empty is exactly the state it moves `.mavis` over
	// (`:310-330`), so an existence test here would report the source as having
	// nothing while its data sits under the older name. Three corners are copied
	// from that function rather than guessed at: a legacy tree answers only when it
	// is a directory (or a link to one) — a plain file at `.mavis` is never read,
	// it is only renamed onto (`:306-308`, `:342`) — a primary directory this
	// process cannot list is *not* empty and does not fall back (`:311-315`), and
	// the one pair that falls back to nothing at all is "empty here, empty there",
	// where the vendor keeps the current name (`:318-321`). An explicit
	// `$MINIMAX_DATA_DIR` skips the pair entirely, which is why the fallback is only
	// open to the default path.
	const primaryState = minimaxDataState(primary.root);
	const legacyState = legacyRoot === null ? "missing" : minimaxDataState(legacyRoot);
	const legacyRead =
		primary.origin === "default" &&
		primaryState !== "hasData" &&
		primaryState !== "unknown" &&
		legacyState !== "missing" &&
		legacyState !== "other" &&
		!(primaryState === "empty" && legacyState === "empty");
	const root = legacyRead && legacyRoot !== null ? legacyRoot : primary.root;
	const config = readMinimaxConfig(root);
	const credentialEntries = readMinimaxCredentialEntries(root);
	return {
		root,
		origin: primary.origin,
		present: existsSync(root),
		legacyRoot,
		legacyRead,
		...config,
		...readMinimaxPermissions(root),
		...readMinimaxMcp(root),
		memory: readText(minimaxGlobalInstructionsPath(root)),
		skills: readSkillDirs(minimaxSkillsDir(root)),
		...readMinimaxAgents(root),
		builtinSkillNames: readDirectoryNames(join(root, MINIMAX_BUILTIN_SKILLS_DIR)),
		pluginNames: readDirectoryNames(minimaxPluginsDir(root)),
		planNames: readDirectoryNames(minimaxPlansDir(root)),
		memoryNames: readDirectoryNames(minimaxMemoryDir(root)),
		unreadV2Dirs: [
			...readDirectoryNames(minimaxLegacyChatsDir(root)).map((name) => join("v2", "chats", name)),
			...readDirectoryNames(minimaxDraftsDir(root)).map((name) => join("v2", "mcode", "drafts", name)),
		],
		credentialEntries,
		otherDirs: readMinimaxOtherDirs(root, new Set(credentialEntries)),
		installDirPresent: existsSync(join(home, MINIMAX_INSTALL_DIR)),
		reviewRules: readDirectoryNames(join(root, "review-rules")),
		borrowedTrees: readMinimaxBorrowedTrees(home, config.config),
	};
}

/** Entry names under the root that look like credentials. Reported; never opened. */
function readMinimaxCredentialEntries(root: string): string[] {
	try {
		return readdirSync(root)
			.filter((name) => MINIMAX_CREDENTIAL_NAME.test(name))
			.sort();
	} catch {
		return [];
	}
}
