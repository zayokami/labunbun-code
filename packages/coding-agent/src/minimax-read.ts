// MiniMax Code's user state: `config.yaml`, `permission.json`, `mcp.json`, `AGENTS.md`,
// skills, agents, plans, and `v2/sessions`.
// Long-form design notes: docs/dev/migration-sources.md

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

// Long-form design notes: docs/dev/migration-sources.md
/** Why one MiniMax rule could not become a rule here. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.minimax/permission.json`, decoded into rule text this build's engine reads. */
export interface MinimaxPermissions {
	allow: string[];
	deny: string[];
	/** `ask` rules, by count: this build's settings hold allow and deny only. */
	askCount: number;
	/** Which generation of the file was read. */
	version: 1 | 2;
	notCarried: MinimaxRuleDrop[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** Bash rules that ended in `:*` over there, as the source spelled them. */
	widened: string[];
}

// Long-form design notes: docs/dev/migration-sources.md
/** MiniMax Code's user state. */
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
	// Long-form design notes: docs/dev/migration-sources.md
	/** Why `permission.json` contributed nothing. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The directories MiniMax reads by borrowing another agent's tree, and the config key that turns each one off. */
const MINIMAX_BORROWED_TREES: Array<{ key: string; legacyKey?: string; path: string }> = [
	{ key: "user-cc", legacyKey: "user-claude", path: join(".claude", "skills") },
	{ key: "user-codex", path: join(".codex", "skills") },
	{ key: "user-agents", path: join(".agents", "skills") },
];

/** Directories under `<root>/agents` that are not one user's agent. */
export const MINIMAX_BUILTIN_AGENTS_DIR = ".builtin";

/** The file MiniMax connects MCP servers from, named as the report spells it. */
export const MINIMAX_MCP_FILE_NAME = "mcp.json";

// Long-form design notes: docs/dev/migration-sources.md
/** A tool name in a MiniMax permission rule, and the name this build's engine knows for the same tool. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The tool names whose specifier this build's engine actually consults. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** One entry of either generation, decoded into this build's rule text. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `permission.json`, decoded — or nothing at all, when MiniMax would read nothing from it either. */
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
			// Long-form design notes: docs/dev/migration-sources.md
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

// Long-form design notes: docs/dev/migration-sources.md
/** `mcp.json` (and the `mcp/mcp.json` MiniMax also looks in), parsed. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The user's agents, one directory each. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The trees MiniMax reads out of other agents' homes, and whether it still does. */
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
	// Long-form design notes: docs/dev/migration-sources.md
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
