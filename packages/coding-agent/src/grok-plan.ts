/**
 * Grok Build's configuration in the target's shape.
 *
 * The biggest module left after the split, and the one that borrows the most
 * from `migrate-core.ts` — `isRecord`, `tildePath`, `summarizeNames`,
 * `placeholderNote` and the rest. That is the point of the split rather than a
 * cost of it: what is specific to Grok is what is left here.
 *
 * The permission rules are the bulk of the file. Grok spells them in its own
 * rule language — a compact tool table, verbose forms, a per-server section —
 * and `planGrokPermissions` decides, per form, whether the target can say the
 * same thing and what to report when it cannot.
 */

import { join } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import type { RawGrokBuild } from "./grok-read.ts";
import { GROK_INSTALL_DIR, GROK_PLUGIN_DIR, GROK_PLUGIN_MCP, grokStringList } from "./grok-read.ts";
import {
	ASSUMED_MAX_OUTPUT_TOKENS,
	collectFileWrites,
	isRecord,
	mergeProviderSpecs,
	placeholderNote,
	planCommands,
	planMemoryAsRule,
	positiveInteger,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
} from "./migrate-core.ts";
import type { AddPermissionRules, ClaimScalar, MigrationItem, PlannedWrite } from "./migrate-types.ts";
import { looksLikeSecretName, resolveModelReference } from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";

/**
 * Where the report says grok's `config.toml` lives.
 *
 * Not `~/${SOURCE_ROOTS[id]}/config.toml`: `$GROK_HOME` can point anywhere, and
 * that spelling would name a file the reader never opened.
 */
function grokConfigPath(home: string, root: string): string {
	return tildePath(home, join(root, "config.toml"));
}

/** The first string in a value that may be a string or a list of them (`env_key`). */
function firstGrokString(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (Array.isArray(value))
		return grokStringList(value)
			.find((entry) => entry.trim() !== "")
			?.trim();
	return undefined;
}

/** Context window assumed for an imported endpoint whose source states no `context_window`. */
const GROK_ASSUMED_CONTEXT_WINDOW = 128_000;

/**
 * `[models]` keys this importer reports rather than carries.
 *
 * Each is a decision a user could have made and then gone looking for. They are
 * listed rather than left to the closing aggregate because each has a *reason* —
 * something this build does differently, not merely a key with no mapping — and
 * a refusal that explains itself is worth more than a name in a list.
 */
const GROK_UNMIGRATED_MODEL_KEYS: Array<[key: string, reason: string]> = [
	["default_reasoning_effort", "thinking level is chosen per request here, so there is no session-wide default to set"],
	["allowed_models", "a picker allowlist; the models offered here are the built-in catalogue plus your providers"],
	["hidden_models", "picker visibility only — nothing here hides a model"],
	["disabled_models", "removes rows from grok's own catalogue, which is not the catalogue here"],
	["web_search", "names the model grok's web_search tool runs on; search here is a tool call on the session model"],
	["session_summary", "names the model that writes session titles; titles here come from the session model"],
	["image_description", "names the vision model that transcribes pasted images; images go to the session model here"],
	["prompt_suggestion", "names the model behind next-prompt ghost text, which this build does not have"],
	["agent_type", "an agent-definition type for models that name none; agent definitions here are markdown files"],
	[
		"extra_headers",
		"request headers applied to every model — a provider entry here carries an endpoint and a credential " +
			"variable, not headers, so the gateway has to accept what the endpoint sends",
	],
	["max_retries", "inference retry policy, which lives in the provider adapters here rather than in settings"],
	["inference_idle_timeout_secs", "a streaming idle timeout the adapters set for themselves here"],
	["max_completion_tokens", "a global output cap each model overrides; the output budget here is per model"],
	["temperature", "sampling is not configurable per model here"],
	["top_p", "sampling is not configurable per model here"],
	["stream_tool_calls", "a tool-call streaming request shape some BYOK endpoints need; the wire shape here is fixed"],
	["rate_limit_retry_threshold", "retry behaviour on 429s, which the adapters own here"],
	["subagent_rate_limit_max_attempts", "retry behaviour on 429s in subagents, which the adapters own here"],
];

/**
 * `config.toml` sections that get a line of their own rather than a mapping.
 *
 * Every documented key a user could plausibly have set is here, because the one
 * thing a migration report may not do is leave a setting looking simply missed.
 * The reasons are deliberately not interchangeable: each says what the section
 * holds and what this build does instead.
 */
const GROK_UNMIGRATED_SECTIONS: Array<[key: string, reason: string]> = [
	["agent", "names the agent definition grok loads for the session; agents here are files under ~/.labunbun/agents"],
	[
		"auth_provider",
		"named helpers that mint a bearer token for a model entry; a provider here reads its key from an " +
			"environment variable instead",
	],
	[
		"auto_mode",
		"grok's classifier mode, which approves calls it judges safe — there is no classifier here, and the " +
			"nearest mode, dontAsk, does the opposite",
	],
	["default_auto_mode", "starts sessions in that classifier mode; see [auto_mode]"],
	["announcements", "payloads the deployment publishes, not preferences you wrote"],
	["campaigns", "patches the deployment publishes, not preferences you wrote"],
	[
		"cli",
		"update channel, version pins and worktree preferences — this build has no updater or version pin, and " +
			"its own flags",
	],
	["consent", "consent records for grok's servers; nothing here reports to them"],
	["dashboard", "which panes grok's dashboard shows, which is its own interface state"],
	["disable_web_search", "drops grok's web_search tool; which tools may run here is decided by permission rules"],
	["diagnostics", "the panic-report switch for grok's crash handler"],
	["doom_loop_recovery", "grok's own repeated-call detector"],
	["endpoints", "endpoint overrides for grok's services"],
	["feedback", "where feedback uploads go for grok's servers"],
	["goal", "a standing goal applied to every session; there is no such setting here"],
	["grok_com_config", "sign-in settings for grok.com — the same table as [auth], and named rather than read"],
	["harness", "trace-upload timing for grok's servers"],
	["hints", "which worktree offer a /fork or /new shows, which is grok's own interface behaviour"],
	[
		"hooks",
		"matcher groups with command handlers — close to the shape settings.json → hooks takes, but this " +
			"importer does not translate them, so a hook that guards or annotates a tool call is not in force here " +
			"until it is copied over by hand",
	],
	["managed_mcps", "MCP servers the deployment provisions at startup"],
	["marketplace", "plugin marketplace sources; plugins here are read as files rather than subscribed to"],
	["mcp", "the MCP client's own output cap, which the client here sets for itself"],
	[
		"memory",
		"switches for grok's memory subsystem; memory here is the rule files and MEMORY.md a session reads, with " +
			"no extraction pipeline to enable",
	],
	["memory_v2", "the same subsystem's second-generation switches; see [memory]"],
	[
		"path_not_found_hints",
		"enriches path-not-found errors with suggestions; the tools here report the error as it stands",
	],
	["privacy", "a banner-dismissal timestamp for grok's own interface"],
	["relay", "session relay sync to grok's servers, which has no counterpart here"],
	[
		"sandbox",
		"filesystem sandbox profiles (off/workspace/read-only/strict); the shell here is gated by permission " +
			"rules rather than confined by a sandbox",
	],
	[
		"session",
		"the compaction threshold, which follows the model's context window here, and .envrc injection into " +
			"the shell, which this build does not do",
	],
	[
		"shell_environment_policy",
		"what grok's child shells inherit and are handed; env in settings here is injected into this process, " +
			"which is a different thing",
	],
	["storage", "how long grok keeps idle session folders, which is its own storage"],
	[
		"subagents",
		"concurrency, nesting depth and per-type model overrides; the subagent pool here has its own defaults " +
			"and no per-type model table",
	],
	["telemetry", "OpenTelemetry export to grok's servers"],
	["tools", "gitignore handling, media-generation caps and ZDR switches for grok's tool set"],
	[
		"toolset",
		"timeouts, output limits, the file-edit scheme and web allowlists — the tools here fix their own, and " +
			"none of it is per-source configuration",
	],
	["ui", "grok's interface preferences (theme, density, collapsed edits, contextual hints)"],
	["version_overrides", "CLI version pins"],
	["voice", "dictation settings for grok's interface"],
	["workflows", "named workflows declared in config; workflows here are agent definitions and skills"],
	["worktree", "how grok lays out a session's worktree; the worktrees here are git's own"],
];

/**
 * The tool prefixes a *compact* `[permission]` rule may use.
 *
 * Exactly `tool_name_to_filter` (`permission/rules.rs:244`), which is what the
 * array form's parser consults and what it rejects everything else against. Two
 * things about it are easy to guess wrong from the config reference: the
 * spellings are PascalCase with no lowercase arm at all, and there are **no
 * entries for `Any` or `WebSearch`-as-a-filter** beyond the ones listed — a
 * `bash(...)` or `Any(...)` in that array is an `UnknownToolPrefix` warning and a
 * dropped rule, not a rule in force. Carrying one across as if grok had read it
 * would put a rule in this build's list that the user's grok never had.
 */
const GROK_COMPACT_TOOL_NAMES: Record<string, string> = {
	Bash: "bash",
	Read: "read",
	Edit: "edit",
	Write: "edit",
	MCPTool: "mcp",
	Grep: "grep",
	Glob: "grep",
	WebFetch: "webfetch",
	WebSearch: "websearch",
	AgentMessage: "agent_message",
	SendSubagentMessage: "agent_message",
	// The legacy spelling of the same filter, which still parses.
	SendAgentMessage: "agent_message",
};

/**
 * The tool names a *verbose* `[[permission.rules]]` entry may use.
 *
 * A different vocabulary entirely: that field is the serde lowercase name of
 * `ToolFilter`, so `Any` and `Bash` — valid prefixes in the array form — do not
 * deserialize here, and a table holding one costs grok *every* rule in it. The
 * set is narrower than the compact one: `ToolFilter` has no `websearch` variant,
 * so `tool = "websearch"` is one of those table-failing values rather than a
 * search rule, and a name this table does not know is reported as exactly that.
 */
const GROK_VERBOSE_TOOL_NAMES: Record<string, string> = {
	any: "any",
	bash: "bash",
	edit: "edit",
	read: "read",
	grep: "grep",
	mcp: "mcp",
	webfetch: "webfetch",
	agent_message: "agent_message",
	// The `alias` on the same serde field.
	agentmessage: "agent_message",
};

/** Rule prefixes grok itself refuses (`UnsupportedToolPrefix`), with the reason it gives. */
const GROK_UNSUPPORTED_RULE_FORMS = ["EnterWorktree", "NotebookEdit", "NotebookRead"];

/** The `Tool(pattern)` form, split the way grok splits it. */
interface GrokRuleParts {
	tool: string;
	pattern?: string;
	domain: boolean;
}

/**
 * Index of the first `target` at or after `from` that is not backslash-escaped.
 *
 * grok's rule parser is escape-aware (`is_unescaped`), so `Read(a\)b.md)` is one
 * rule with a parenthesis in its pattern rather than a malformed one. `last`
 * selects the search direction grok uses for the closing parenthesis.
 */
function indexOfUnescaped(text: string, target: string, last = false): number {
	const indexes: number[] = [];
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== target) continue;
		let backslashes = 0;
		let back = index;
		while (back > 0 && text[back - 1] === "\\") {
			backslashes += 1;
			back -= 1;
		}
		if (backslashes % 2 === 0) indexes.push(index);
	}
	return last ? (indexes.at(-1) ?? -1) : (indexes[0] ?? -1);
}

/**
 * One compact `[permission]` entry, split the way grok splits it.
 *
 * A mirror of `parse_permission_rule` (`permission/rules.rs:109`) down to the
 * parts this translation needs: the `Tool(...)` prefix and its content, the
 * trailing `:*` that means "the command starts with this" rather than "this
 * glob", the `domain:` marker, and the `.claude` `mcp__<server>[__<tool>]`
 * spelling grok rewrites onto its own qualified names. A prefix grok refuses is
 * refused here too, so the two cannot disagree about which rules exist.
 *
 * The two shapes fail differently on purpose: a bad *compact* entry is warned
 * about and dropped while its neighbours load, but a bad entry in the verbose
 * `rules` array fails the deserialization of the whole table, so grok ends up
 * with **no** rules from it. The caller reproduces both granularities.
 */
function parseGrokRuleText(text: string): GrokRuleParts | { invalid: string } {
	const rule = text.trim();
	if (GROK_UNSUPPORTED_RULE_FORMS.includes(rule)) {
		return { invalid: "grok refuses this tool prefix itself, so no rule was ever in force for it" };
	}
	const open = indexOfUnescaped(rule, "(");
	if (open === -1) {
		// A bare name. grok knows some; the rest fall through to a match-anything
		// rule whose pattern is the literal itself.
		const tool = GROK_COMPACT_TOOL_NAMES[rule];
		if (tool !== undefined) return { tool, domain: false };
		if (rule.startsWith("mcp__")) {
			const rest = rule.slice("mcp__".length);
			if (rest === "") return { tool: "any", pattern: rule, domain: false };
			if (rest === "*") return { tool: "mcp", domain: false };
			// `<server>__<tool>` is already the qualified name; a server alone
			// covers every tool on it.
			return { tool: "mcp", pattern: rest.includes("__") ? rest : `${rest}__*`, domain: false };
		}
		return { tool: "any", pattern: rule === "" ? undefined : rule, domain: false };
	}
	const prefix = rule.slice(0, open).trim();
	if (GROK_UNSUPPORTED_RULE_FORMS.includes(prefix)) {
		return { invalid: "grok refuses this tool prefix itself, so no rule was ever in force for it" };
	}
	// The closing parenthesis is searched for *after* the opening one, as grok
	// does — a `)` before it is part of neither the prefix nor the content.
	const after = rule.slice(open + 1);
	const closeRel = indexOfUnescaped(after, ")", true);
	if (closeRel === -1) return { invalid: "no closing parenthesis — grok drops a rule it cannot parse" };
	const tool = GROK_COMPACT_TOOL_NAMES[prefix];
	if (tool === undefined) {
		return { invalid: `grok does not know the tool prefix "${prefix}" — it warns and drops the rule` };
	}
	// Whatever follows the closing parenthesis is not read at all: grok takes the
	// content up to it and discards the rest, so `Bash(ls) # note` is the rule
	// `Bash(ls)` and is carried as one.
	const content = after.slice(0, closeRel).trim();
	// Empty content and a lone `*` both mean a tool-wide rule in grok. The order
	// of the three strips is grok's: bash colon suffix, then the `domain:` prefix,
	// and only then is an empty pattern read as "no pattern at all".
	let pattern = content === "" || content === "*" ? "" : unescapeGrokRule(content);
	if (tool === "bash") pattern = pattern.endsWith(":*") ? pattern.slice(0, -":*".length) : pattern;
	const domain = pattern.startsWith("domain:");
	const bare = domain ? pattern.slice("domain:".length) : pattern;
	return { tool, pattern: bare === "" ? undefined : bare, domain };
}

/** grok's own reverse of its rule escaping. */
function unescapeGrokRule(text: string): string {
	if (!text.includes("\\")) return text;
	return text.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

/**
 * One grok rule as this build's rule text, or the reason it cannot become one.
 *
 * Three differences between the two engines drive this, and every one of them
 * would be silent if the pattern were copied across:
 *
 *   - grok matches a `Bash` pattern against a command that *starts with* it as
 *     well as against one it globs, while a rule here is either an exact string
 *     or a glob. So a pattern carrying no wildcard gets a trailing `*`, which is
 *     exactly the prefix match and nothing wider (`Bash(sed:*)` in grok blocks
 *     `sed-custom`, and `Bash(sed*)` here does too).
 *   - grok's `edit` covers writes, and `Edit(...)` here does not match the
 *     `Write` tool — so one source rule becomes two. A file protection that
 *     covers half of what it did is not something to let a user discover.
 *   - grok spells MCP tools `server__tool`, this build spells them
 *     `mcp__server__tool`, and a rule written in the source's own `.claude`
 *     spelling is rewritten by grok before it is ever matched.
 *
 * `Any` is refused in both of its forms: bare it is a catch-all (grok drops
 * exactly these from `--allow`), and patterned it matches whatever text the call
 * happens to carry, which a rule here has no form for.
 */
function grokRuleText(
	tool: string,
	pattern: string | undefined,
	domain: boolean,
): { texts: string[]; note?: string } | { reason: string } {
	if (tool === "any") {
		if (pattern === undefined || pattern === "") {
			return {
				reason:
					"a catch-all rule — grok drops exactly these from its own --allow, and one here would allow or " +
					"deny every tool at once",
			};
		}
		return {
			reason: `matched against whatever text the call carries ("${clipped(pattern)}") — a rule here names a tool, so this one would be stored and never read`,
		};
	}
	if (tool === "grep" || tool === "webfetch" || tool === "websearch") {
		return {
			reason:
				`a ${tool} rule — the engine here consults rules for Bash, Read/Edit/Write and MCP tools, so this ` +
				"one would be stored and never read" +
				(domain ? "; and `domain:` means nothing to a rule nothing consults" : ""),
		};
	}
	if (tool === "agent_message") {
		return { reason: "grok's message-a-subagent tool has no counterpart here, so there is nothing for it to gate" };
	}
	if (tool === "mcp") {
		// grok's qualified name is `server__tool` (or `server__*`); the bare-tool
		// form is how a rule for one is written here.
		if (pattern === undefined || pattern === "") return { texts: ["mcp__*"] };
		return { texts: [`mcp__${pattern}`] };
	}
	const spec = pattern ?? "";
	if (tool === "bash") {
		const globbed = spec === "" || /[*?[\]]/.test(spec) ? spec : `${spec}*`;
		return { texts: [globbed === "" ? "Bash" : `Bash(${globbed})`] };
	}
	if (tool === "read") return { texts: [spec === "" ? "Read" : `Read(${spec})`] };
	if (tool === "edit") {
		return {
			texts: [spec === "" ? "Edit" : `Edit(${spec})`, spec === "" ? "Write" : `Write(${spec})`],
			note: "two rules here, because grok's `edit` covers writes and a rule here names one tool",
		};
	}
	return { reason: `a rule for "${tool}", which has no counterpart here` };
}

/** A pattern echoed into a report line, kept short because the report is read in a transcript. */
function clipped(text: string): string {
	return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * `[permission]` in grok's `config.toml`, carried over as this build's rules.
 *
 * The two shapes grok accepts do not merge, and the difference is worth getting
 * right: when any of the compact `allow` / `deny` / `ask` keys holds an array,
 * `parse_toml_permission_section` returns those and **never looks at
 * `[[permission.rules]]`**. A file with both is therefore reported as the one
 * grok reads rather than as their union — importing the other half would put
 * rules in force here that were never in force there.
 *
 * The verbose shape carries its own trap, and it is not the one the config
 * reference implies: an entry with no `action` does not default to deny, it fails
 * the parse and takes the whole table with it (see {@link readGrokVerboseRules}).
 * That is what the report says, rather than a rule-by-rule account of rules
 * nothing ever loaded.
 *
 * `ask` has no tier here, exactly as Codex's `prompt` decision does not: the
 * rules that carry it are named rather than turned into an allow or a deny.
 */
export function planGrokPermissions(
	raw: RawGrokBuild,
	home: string,
	items: MigrationItem[],
	addPermissionRules: AddPermissionRules,
): void {
	const permission = isRecord(raw.config.permission) ? raw.config.permission : undefined;
	if (!permission) return;
	const from = `${grokConfigPath(home, raw.root)} → [permission]`;
	const allow: string[] = [];
	const deny: string[] = [];
	const notes: string[] = [];
	const refused: string[] = [];
	const askCount = { value: 0 };

	/**
	 * Translate one rule and file it under its action.
	 *
	 * `action` is "ask" for grok's middle tier, which lands in `refused`: there is
	 * no ask tier here, and the source's own wording for that is in the count.
	 */
	const take = (action: string, tool: string, pattern: string | undefined, domain: boolean, where: string): void => {
		if (action === "ask") {
			askCount.value += 1;
			return;
		}
		if (action !== "allow" && action !== "deny") {
			refused.push(`${where} — unknown action "${action}"`);
			return;
		}
		const translated = grokRuleText(tool, pattern, domain);
		if ("reason" in translated) {
			refused.push(`${where} — ${translated.reason}`);
			return;
		}
		if (translated.note) notes.push(translated.note);
		(action === "allow" ? allow : deny).push(...translated.texts);
	};

	/** The compact keys grok reads first, in the order it reads them. */
	let compact = false;
	for (const [action, key] of GROK_COMPACT_KEYS) {
		const value = permission[key];
		if (value === undefined) continue;
		if (!Array.isArray(value)) {
			// grok warns and falls through to the verbose table rather than failing.
			items.push({
				source: "grok-build",
				from: `${from} → ${key}`,
				to: "—",
				action: "skip",
				detail: `not an array of rule strings, so grok warns about it and reads the rules below instead; its ${describeGrokValue(value)} is left where it is`,
				containsSecret: false,
			});
			continue;
		}
		compact = true;
		value.forEach((entry, index) => {
			const where = `${key}[${index}]`;
			if (typeof entry !== "string") {
				refused.push(`${where} — not a rule string`);
				return;
			}
			const parsed = parseGrokRuleText(entry);
			if ("invalid" in parsed) {
				refused.push(`${where} ("${clipped(entry)}") — ${parsed.invalid}`);
				return;
			}
			take(action, parsed.tool, parsed.pattern, parsed.domain, where);
		});
	}

	if (!compact && permission.rules !== undefined) {
		planGrokVerboseRules(permission, from, items, take);
	} else if (compact && permission.rules !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → rules`,
			to: "—",
			action: "skip",
			detail:
				"grok reads the compact allow/deny/ask arrays and never opens this table when they are present, so " +
				"its rules are not in force there and are not imported here either",
			containsSecret: false,
		});
	}

	// Named rather than imported: see {@link GROK_PROMPT_POLICY_REASON}. It sits
	// with the rules because this is the table it was written in, and a user who
	// set a policy here is owed the news that grok never read it.
	if (permission.prompt_policy !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → prompt_policy`,
			to: "—",
			action: "skip",
			detail: GROK_PROMPT_POLICY_REASON,
			containsSecret: false,
		});
	}

	if (askCount.value > 0) {
		refused.push(
			`${askCount.value} rule(s) the source asks about — there is no ask tier here, and turning a question ` +
				"into an allow would be the wrong half of it",
		);
	}
	const overlap = allow.filter((rule) => deny.includes(rule));
	if (overlap.length > 0) {
		notes.push(
			`${overlap.length} rule(s) appear as both an allow and a deny; deny wins here as it does in grok, and ` +
				"the allow is left in place so the file still reads like the decision that was made",
		);
	}

	const caveat =
		"an allowed command runs without a prompt here, and a deny blocks it whatever else is allowed" +
		(notes.length > 0 ? ` — ${[...new Set(notes)].join("; ")}` : "");
	if (allow.length > 0) addPermissionRules("grok-build", "allow", allow, `${from} → allow`, caveat);
	if (deny.length > 0) addPermissionRules("grok-build", "deny", deny, `${from} → deny`, caveat);
	if (refused.length > 0) {
		items.push({
			source: "grok-build",
			from,
			to: "—",
			action: "skip",
			detail: `${refused.length} rule(s) not carried: ${summarizeNames(refused, 3)}`,
			containsSecret: false,
		});
	}
	reportUnhandledKeys("grok-build", permission, GROK_PERMISSION_HANDLED, from, items);
}

/** What a value is, for a report line that may not print it. */
function describeGrokValue(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

/** One verbose `[[permission.rules]]` entry, as this translation needs it. */
interface GrokVerboseRule {
	action: string;
	tool: string;
	pattern?: string;
	domain: boolean;
}

/**
 * Read the verbose `[permission]` table the way serde reads it, reporting nothing.
 *
 * **`action` is required**, and that is the trap in this shape: `RuleAction`
 * carries `#[default] Deny` (CWE-1188) and `PermissionRule.tool` and
 * `pattern_mode` carry field-level `#[serde(default)]` — but the action field
 * carries none, and the struct has no container-level default either. So the
 * `Deny` default is what *Rust* code gets when it constructs a rule, not what a
 * missing key deserializes to: an entry with no `action` fails the parse, and
 * because `try_into::<PermissionConfig>()` is all-or-nothing, grok then holds
 * **none** of the table's rules. Reading that entry as a deny would put a refusal
 * in force here that was never in force there.
 *
 * Pure, and called from two places on purpose: the rule translator needs the
 * rules, and the policy reader needs to know whether this section loaded at all
 * (a failed table leaves the policy at its type default too). One reader, so the
 * two cannot disagree about whether the user's rules ever applied.
 */
function readGrokVerboseRules(permission: Record<string, unknown>): { rules: GrokVerboseRule[]; omitted: string[] } {
	const rules = permission.rules;
	// A missing `rules` key is the container's own `#[serde(default)]`: an absent
	// table is simply no rules.
	if (rules === undefined) return { rules: [], omitted: [] };
	if (!Array.isArray(rules)) return { rules: [], omitted: ["`rules` is not an array of tables"] };
	/** A string field as serde reads it, or `undefined` when its shape fails the table. */
	const textField = (entry: Record<string, unknown>, name: string, fallback: string): string | undefined => {
		const value = entry[name];
		if (value === undefined) return fallback;
		return typeof value === "string" ? value : undefined;
	};
	const parsed: GrokVerboseRule[] = [];
	for (const [index, entry] of rules.entries()) {
		const where = `rules[${index}]`;
		// The first failure is the one serde reports, so it is the one carried.
		const fail = (detail: string): { rules: GrokVerboseRule[]; omitted: string[] } => ({
			rules: [],
			omitted: [`${where} ${detail}`],
		});
		if (!isRecord(entry)) return fail("is not a table");
		if (entry.action === undefined) return fail("has no action, which this shape requires");
		const action = textField(entry, "action", "deny");
		if (action !== "allow" && action !== "deny" && action !== "ask") {
			return fail(
				`has an action that is ${action === undefined ? "not a string" : `not one grok knows ("${action}")`}`,
			);
		}
		const toolName = textField(entry, "tool", "any");
		const tool = toolName === undefined ? undefined : GROK_VERBOSE_TOOL_NAMES[toolName];
		if (tool === undefined) {
			return fail(
				`names a tool that is ${toolName === undefined ? "not a string" : `not one this shape knows ("${toolName}")`}`,
			);
		}
		const mode = textField(entry, "pattern_mode", "glob");
		if (mode !== "glob" && mode !== "domain") {
			return fail(
				`has a pattern_mode that is ${mode === undefined ? "not a string" : `not one grok knows ("${mode}")`}`,
			);
		}
		if (entry.pattern !== undefined && typeof entry.pattern !== "string")
			return fail("has a pattern that is not a string");
		parsed.push({
			action,
			tool,
			pattern: typeof entry.pattern === "string" ? entry.pattern : undefined,
			domain: mode === "domain",
		});
	}
	return { rules: parsed, omitted: [] };
}

/**
 * The verbose `[[permission.rules]]` table, translated.
 *
 * The granularity is the point: one entry grok cannot deserialize costs it every
 * rule in the table, so the report says that rather than handing over rules grok
 * never loaded.
 */
function planGrokVerboseRules(
	permission: Record<string, unknown>,
	from: string,
	items: MigrationItem[],
	take: (action: string, tool: string, pattern: string | undefined, domain: boolean, where: string) => void,
): void {
	const read = readGrokVerboseRules(permission);
	if (read.omitted.length > 0) {
		unloadedTable(from, items, read.omitted);
		return;
	}
	for (const [index, rule] of read.rules.entries()) {
		take(rule.action, rule.tool, rule.pattern, rule.domain, `rules[${index}]`);
	}
}

/**
 * `[permission] prompt_policy`, which grok does not read from here.
 *
 * The key is real — a session's permission config does carry a `prompt_policy`,
 * and its `Deny` is grok's own dontAsk (`manager/mod.rs` logs
 * `always-approve is active while prompt_policy is dontAsk (Deny)`) — but it does
 * not come from this file. The `config.toml` loader keeps only the rule tables
 * (`extract_toml_permissions` → `parse_toml_permission_section` → a
 * `PermissionConfig` whose sole field is `rules`), and the shell's own test
 * `permission_prompt_policy_warns_as_unconsumed` pins that a `prompt_policy`
 * written in `[permission]` is reported to the user as an unrecognized key. The
 * policy the session actually runs with arrives from the Claude compat layer
 * instead: `DefaultPermissionMode::effects` maps a `.claude` settings
 * `permissions.defaultMode` of `dontAsk` to `Deny` and `auto` to `Auto`.
 *
 * So this is a line and not a mapping: carrying the value over would tell a user
 * that a policy grok warned about and ignored is now in force under another name,
 * and the mode it would have to become is precisely the one this migration may not
 * invent on the user's behalf.
 */
const GROK_PROMPT_POLICY_REASON =
	"grok does not read this key: its config.toml loader keeps only the rule tables and reports prompt_policy as " +
	"an unrecognized key, so nothing written here was ever in force — the policy a session runs with comes from the " +
	"Claude compat layer's permissions.defaultMode, which the claude-code source imports";

/** Keys of `[permission]` that this planner reads or names; the rest reach {@link reportUnhandledKeys}. */
const GROK_PERMISSION_HANDLED = new Set<string>(["rules", "allow", "deny", "ask", "prompt_policy"]);

/**
 * Keys of a `[model.<id>]` entry that this planner reads.
 *
 * The rest of such a table is a list of retunings — `reasoning_effort`,
 * `temperature`, `max_retries` — and each of them is reported rather than
 * dropped, for the same reason the `[models]` keys are: the entry itself may be
 * carried over, and a user reading that line would otherwise take it for a table
 * that came across whole.
 */
const GROK_MODEL_ENTRY_HANDLED = new Set<string>([
	"base_url",
	"api_base_url",
	"model",
	"context_window",
	"max_completion_tokens",
	"env_key",
	"api_key",
	"api_backend",
	// Read as of the provider table below: an entry that names one takes its
	// endpoint from it, which is how grok resolves such a model.
	"model_provider",
	// Read for presence, like `api_key`: a model that names a helper has a
	// credential of its own, so it inherits none of its provider's
	// (`with_provider_defaults`, `model_providers.rs:205-215`).
	"auth_provider",
]);

/**
 * Keys of a `[model_providers.<id>]` entry that this planner reads or names.
 *
 * The three header-shaped tables are named in one line rather than read: a
 * provider entry here carries an endpoint, a credential variable and models, so
 * there is nowhere for request headers or URL query parameters to go. `auth` and
 * `auth_provider` are likewise named: grok runs a command to mint the endpoint's
 * token, which is a mechanism this build does not have.
 */
const GROK_PROVIDER_ENTRY_HANDLED = new Set<string>([
	"base_url",
	"api_base_url",
	"context_window",
	"env_key",
	"api_key",
	"api_backend",
	"extra_headers",
	"query_params",
	"env_http_headers",
	"auth",
	"auth_provider",
]);

/** The compact `[permission]` keys, with the action each carries. */
const GROK_COMPACT_KEYS: Array<[action: "deny" | "allow" | "ask", key: string]> = [
	["deny", "deny"],
	["allow", "allow"],
	["ask", "ask"],
];

/**
 * One line for a `[[permission.rules]]` table grok could not read at all.
 *
 * The all-or-nothing part is the whole reason this is one line rather than a
 * per-entry account: `try_into::<PermissionConfig>()` either produces the table's
 * rules or produces none of them, so there is no shorter list to hand over.
 */
function unloadedTable(from: string, items: MigrationItem[], reasons: string[]): void {
	items.push({
		source: "grok-build",
		from: `${from} → rules`,
		to: "—",
		action: "skip",
		detail:
			`grok reads this section in one deserialization: ${reasons.join("; ")}. An entry it cannot read costs it ` +
			"every rule in the table, so none of them were in force there and none are imported here",
		containsSecret: false,
	});
}

/**
 * Rewrite one `[mcp_servers.<name>]` entry into this build's MCP shape.
 *
 * The transport is the same two shapes Codex uses, and grok reads its table
 * untagged — `Stdio` first — so an entry with both a `command` and a `url` is a
 * stdio server with an unused URL, exactly as it is there.
 *
 * Everything this refuses is a credential grok does not store: `bearer_token_env_var`,
 * `oauth_client_secret_env_var` and `env_http_headers` all name variables in the
 * user's environment. The server is copied and the report says which variables it
 * used to read — reading them here, or inventing an empty value, would turn a
 * working server into one that fails at connect time.
 */
function normalizeGrokMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const extras: string[] = [];
	for (const key of [
		"oauth",
		"setup",
		"startup_timeout_sec",
		"tool_timeout_sec",
		"tool_timeouts",
		"expose_image_base64",
	]) {
		if (entry[key] !== undefined) extras.push(key);
	}
	if (extras.length > 0) {
		downgrades.push(`the source's own ${summarizeNames(extras)} settings have no counterpart here`);
	}
	const url = typeof entry.url === "string" && entry.url.trim() ? entry.url : undefined;
	if (url !== undefined && typeof entry.command !== "string") {
		const out: Record<string, unknown> = { type: "http", url };
		if (isRecord(entry.headers)) out.headers = entry.headers;
		if (typeof entry.bearer_token_env_var === "string") {
			downgrades.push(`its Authorization header came from $${entry.bearer_token_env_var}, which is not expanded here`);
		}
		if (typeof entry.oauth_client_secret_env_var === "string") {
			downgrades.push(
				`its OAuth client secret came from $${entry.oauth_client_secret_env_var}, which is not expanded here`,
			);
		}
		if (isRecord(entry.env_http_headers)) {
			const names = Object.values(entry.env_http_headers).filter((value) => typeof value === "string");
			if (names.length > 0) {
				downgrades.push(
					`header values came from ${names.map((name) => `$${name}`).join(", ")}, which are not expanded here`,
				);
			}
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	const command = entry.command;
	if (typeof command === "string" && command) {
		const out: Record<string, unknown> = {
			type: "stdio",
			command,
			args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [],
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		if (typeof entry.bearer_token_env_var === "string") {
			downgrades.push(
				`it read $${entry.bearer_token_env_var} for a bearer token in its environment, which is not expanded here`,
			);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	return null;
}

/**
 * `[models]`, `[model.<id>]`, `[model_providers.<id>]`, `[permission]`,
 * `[mcp_servers.*]` and the rest of grok's `config.toml`.
 *
 * `[model.<id>]` is grok's per-model override table. An entry becomes a provider
 * here when something gives it an endpoint: its own `base_url`/`api_base_url`, or
 * a `model_provider` naming a `[model_providers.<id>]` entry that has one. The
 * second spelling is easy to miss and was missed here: grok's own table sits one
 * level over from Codex's, and a model reaching through it has an endpoint while
 * its own table shows none. An entry with neither only retunes a row of grok's
 * own catalogue and stays behind.
 *
 * The credential rule shapes this function. grok accepts an inline `api_key`
 * there and this importer **does not read its value**: the settings schema here
 * holds a variable *name* and has nowhere to put a literal. So such an endpoint
 * is registered with the variable named after it, and the report says the key is
 * still in `config.toml` and has to be exported. Copying it into `settings.json`
 * would put a live credential in a second file, which is the one thing this
 * importer never does.
 */
export function planGrokBuild(
	raw: RawGrokBuild,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const from = grokConfigPath(home, raw.root);
	if (raw.configError !== undefined) {
		items.push({
			source: "grok-build",
			from,
			to: "—",
			action: "skip",
			detail: `${raw.configError} — its settings, permission rules and MCP servers were not read`,
			containsSecret: false,
		});
	}

	// Key paths this parser can only read once a digits-only segment is quoted.
	// TOML spells a dot in a bare key as a path separator, so `[model.grok-4.6]` is
	// a table named `grok-4.6` to nobody: grok reads `grok-4` → `6`, and so does the
	// reader above. The user who wrote it meant a model by that name, which is a
	// different override and is not what either parser has — so the path is named
	// rather than imported as what it looks like.
	for (const path of raw.configDottedKeys) {
		const segments = path.split(".");
		const leaf = segments.at(-1) ?? "";
		const parent = segments.slice(0, -1).join(".");
		items.push({
			source: "grok-build",
			from: `${from} → ${path}`,
			to: "—",
			action: "skip",
			detail:
				"a bare digits-only segment after a dot is a key path, not part of a name: grok reads this as a table " +
				`named "${leaf}" inside "${parent}", and so does this importer. Quote the segment ` +
				`([${parent}."${leaf}"]) if you meant one key; nothing written under this path is imported either way`,
			containsSecret: false,
		});
	}

	// ── model_providers: the endpoint table a model inherits from ─────────────
	// grok resolves a model's connection through `with_provider_defaults`
	// (`agent/model_providers.rs:170`): the model's own fields win, and a model
	// that sets none of them inherits the provider's `base_url` / `api_base_url`,
	// `api_backend` and `context_window`, plus the provider's `env_key` / `api_key`
	// / credential helper when it has no credential of its own. So
	// `[model.<id>] model_provider = "gateway"` is an endpoint definition whose
	// endpoint is one table over, and reading only `[model.<id>]` reports "no
	// endpoint of its own" about a model that has one.
	const providerTable = isRecord(raw.config.model_providers) ? raw.config.model_providers : {};
	/** What a model entry can inherit from the provider it names. */
	const providers = new Map<
		string,
		{
			endpoint: string | undefined;
			contextWindow: number | undefined;
			envKey: string | undefined;
			inlineKey: boolean;
			apiBackend: string | undefined;
			authHelper: boolean;
		}
	>();
	/** Provider ids a model entry actually names; the rest are named as unread. */
	const namedProviders = new Set<string>();
	for (const [id, value] of Object.entries(providerTable)) {
		const label = `${from} → model_providers.${id}`;
		if (!isRecord(value)) {
			items.push({
				source: "grok-build",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a table, so grok reads no provider here and neither does this importer",
				containsSecret: false,
			});
			continue;
		}
		reportUnhandledKeys("grok-build", value, GROK_PROVIDER_ENTRY_HANDLED, label, items);
		const headers = ["extra_headers", "query_params", "env_http_headers"].filter((key) => isRecord(value[key]));
		if (headers.length > 0) {
			items.push({
				source: "grok-build",
				from: `${label} → ${summarizeNames(headers)}`,
				to: "—",
				action: "skip",
				detail:
					"folded into every request by grok, and inherited by the models that name this provider — request " +
					"headers, URL query parameters and header-to-variable mappings. A provider entry here carries an " +
					"endpoint, a credential variable and models, so there is nowhere to put them: an endpoint that " +
					"requires them will not answer the same way",
				containsSecret: false,
			});
		}
		const authNames = [
			value.auth !== undefined ? "auth" : null,
			firstGrokString(value.auth_provider) !== undefined ? "auth_provider" : null,
		].filter((name): name is string => name !== null);
		if (authNames.length > 0) {
			items.push({
				source: "grok-build",
				from: `${label} → ${authNames.join(", ")}`,
				to: "—",
				action: "skip",
				detail:
					"a credential helper grok runs to mint this endpoint's bearer token; this build reads a variable " +
					"name instead and runs nothing, so the helper's command is not carried across",
				containsSecret: false,
			});
		}
		providers.set(id, {
			endpoint: firstGrokString(value.base_url) ?? firstGrokString(value.api_base_url),
			contextWindow: positiveInteger(value.context_window),
			envKey: firstGrokString(value.env_key),
			inlineKey: firstGrokString(value.api_key) !== undefined,
			apiBackend: firstGrokString(value.api_backend),
			authHelper: authNames.length > 0,
		});
	}

	// ── models: the session model, and any endpoint the source defines ────────
	const models = isRecord(raw.config.models) ? raw.config.models : {};
	const table = isRecord(raw.config.model) ? raw.config.model : {};
	const specs: Array<Record<string, unknown>> = [];
	/** The endpoints offered this run, by the table key that named them. */
	const endpoints = new Map<string, { wireId: string; contextWindow: number; notes: string[] }>();
	/**
	 * Aliases that exist only because a dotted key path was repaired: `[model.grok-4.6]`
	 * leaves a table called `grok-4` holding one key. Its own line above says what
	 * it is, and this loop has nothing true to add — "an override of a model grok
	 * already knows" is not what the user wrote. An alias that a real `[model.grok-4]`
	 * table also contributes to has an endpoint and is planned as usual.
	 */
	const repairedAliases = new Set(
		raw.configDottedKeys
			.map((path) => path.split("."))
			.filter((segments) => segments[0] === "model" && segments.length > 2)
			.map((segments) => segments.slice(1, -1).join(".")),
	);
	for (const [alias, value] of Object.entries(table)) {
		if (!isRecord(value)) continue;
		const label = `${from} → model.${alias}`;
		const baseUrl = firstGrokString(value.base_url);
		const altBase = firstGrokString(value.api_base_url);
		const ownEndpoint = baseUrl ?? altBase;
		const providerId = firstGrokString(value.model_provider);
		const provider = providerId !== undefined ? providers.get(providerId) : undefined;
		if (providerId !== undefined) namedProviders.add(providerId);
		const endpoint = ownEndpoint ?? provider?.endpoint;
		if (repairedAliases.has(alias) && endpoint === undefined) continue;
		// Named before the endpoint test, because the entries that carry no endpoint
		// are exactly the ones most likely to carry something else — an override for
		// a model grok already knows is a table of retunings, and a key left out of
		// the report would read as a setting this importer forgot.
		reportUnhandledKeys("grok-build", value, GROK_MODEL_ENTRY_HANDLED, label, items);
		if (endpoint === undefined) {
			items.push({
				source: "grok-build",
				from: label,
				to: "—",
				action: "skip",
				detail:
					providerId !== undefined
						? `it names model_providers.${providerId}, which ${
								providers.has(providerId) ? "defines neither base_url nor api_base_url" : "this config does not define"
							} — grok resolves this model with no endpoint of its own, and so does this importer`
						: "an override of a model grok already knows; it names no endpoint of its own to register here",
				containsSecret: false,
			});
			continue;
		}
		const wireId = firstGrokString(value.model) ?? alias;
		// The provider's values apply only where the model states none. That is
		// grok's own merge: `or_else` for the connection fields, and all-or-nothing
		// for the credential — a model with any credential of its own takes none of
		// the provider's (`with_provider_defaults`, `model_providers.rs:205-218`).
		const ownEnvKey = firstGrokString(value.env_key);
		// Presence only. The value is never read, and never reaches a report.
		const ownInlineKey = firstGrokString(value.api_key) !== undefined;
		const ownAuthHelper = firstGrokString(value.auth_provider) !== undefined;
		const ownCredential = ownEnvKey !== undefined || ownInlineKey || ownAuthHelper;
		const envKey = ownCredential ? ownEnvKey : provider?.envKey;
		const inlineKey = ownCredential ? ownInlineKey : (provider?.inlineKey ?? false);
		const contextWindow =
			positiveInteger(value.context_window) ?? provider?.contextWindow ?? GROK_ASSUMED_CONTEXT_WINDOW;
		const maxOutputTokens = positiveInteger(value.max_completion_tokens) ?? ASSUMED_MAX_OUTPUT_TOKENS;
		const apiKeyEnv = envKey ?? `${alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		specs.push({ id: alias, baseUrl: endpoint, apiKeyEnv, models: [{ id: wireId, contextWindow, maxOutputTokens }] });
		const notes: string[] = [];
		if (ownEndpoint === undefined) {
			notes.push(`the endpoint is the one model_providers.${providerId} defines`);
		} else if (baseUrl === undefined) {
			notes.push("the endpoint is the one api_base_url names");
		}
		const backend = firstGrokString(value.api_backend) ?? provider?.apiBackend;
		if (backend !== undefined && backend !== "chat_completions") {
			notes.push(`api_backend is "${backend}", and an imported provider here speaks chat-completions`);
		}
		if (ownCredential) {
			if (inlineKey && envKey === undefined) {
				notes.push(
					`its key is written inline in config.toml (api_key) and was not read — export ${apiKeyEnv} with the same key, or the endpoint cannot authenticate`,
				);
			} else if (inlineKey) {
				notes.push(
					`an inline api_key is present as well and was not read; ${envKey} is the variable a provider here reads`,
				);
			} else if (envKey !== undefined) {
				notes.push(
					ownAuthHelper
						? `the credential is read from ${envKey}; auth_provider names a helper that mints one when that variable ` +
								`does not resolve, and it is not carried across`
						: `the credential is read from ${envKey}`,
				);
			} else {
				// The model names a helper and no variable. Without this branch the line
				// below would read "the credential is read from undefined" — a report
				// that names a variable which is not a variable.
				notes.push(
					`this model's token is minted by the credential helper auth_provider names, which is not carried across — ` +
						`export ${apiKeyEnv} with a key for that endpoint`,
				);
			}
		} else if (provider?.inlineKey) {
			notes.push(
				`the key for it is written inline in config.toml (api_key on model_providers.${providerId}) and was not ` +
					`read — export ${apiKeyEnv} with the same key, or the endpoint cannot authenticate`,
			);
		} else if (envKey !== undefined) {
			notes.push(`the credential comes from ${envKey}, the variable its provider's env_key names`);
		} else if (provider?.authHelper) {
			notes.push(
				`model_providers.${providerId} mints its token with a credential helper, which is not carried across — ` +
					`export ${apiKeyEnv} with a key for that endpoint`,
			);
		} else {
			notes.push(
				`no env_key is recorded, so the provider is registered against ${apiKeyEnv} — set it if the endpoint needs a key`,
			);
		}
		endpoints.set(alias, { wireId, contextWindow, notes });
	}

	// A provider no model resolves through is inert in grok — `model_providers` is
	// consulted per model override and nowhere else — so it is named rather than
	// imported as an endpoint the user would find in the target and wonder about.
	for (const id of Object.keys(providerTable)) {
		if (namedProviders.has(id)) continue;
		items.push({
			source: "grok-build",
			from: `${from} → model_providers.${id}`,
			to: "—",
			action: "skip",
			detail:
				"no model in this config names it, and grok reaches a provider only through the model that names it — " +
				"nothing here is resolved through this table, so no endpoint is registered for it",
			containsSecret: false,
		});
	}
	// The endpoints that actually reached the patch, as reported by the merge
	// itself: an entry the target already defines is kept, and a "map" line for it
	// would say an endpoint moved when it did not.
	const acceptedProviders = new Set(
		mergeProviderSpecs("grok-build", specs, (id) => `${from} → model.${id}`, items, settingsPatch, existing, force),
	);
	for (const [alias, spec] of endpoints) {
		if (!acceptedProviders.has(alias)) continue;
		items.push({
			source: "grok-build",
			from: `${from} → model.${alias}`,
			to: `settings.json → providers.openaiCompatible[${alias}]`,
			action: "map",
			detail: `endpoint carried over for "${spec.wireId}" with a ${spec.contextWindow}-token context window; ${spec.notes.join("; ")}`,
			containsSecret: false,
		});
	}

	const defaultModel = firstGrokString(models.default);
	if (defaultModel !== undefined) {
		const label = `${from} → models.default ("${defaultModel}")`;
		const own = endpoints.get(defaultModel);
		if (own !== undefined && acceptedProviders.has(defaultModel)) {
			claimScalar(
				"grok-build",
				"model",
				`${defaultModel}/${own.wireId}`,
				label,
				`registered under the "${defaultModel}" provider the source defines`,
			);
		} else {
			const resolved = resolveModelReference(defaultModel);
			if (resolved) {
				claimScalar("grok-build", "model", resolved, label, `resolved to ${resolved}`);
			} else {
				items.push({
					source: "grok-build",
					from: label,
					to: "—",
					action: "skip",
					detail:
						"no model here answers to that name — register the endpoint that serves it, then set the " +
						"model reference by hand",
					containsSecret: false,
				});
			}
		}
	}
	for (const [key, reason] of GROK_UNMIGRATED_MODEL_KEYS) {
		if (models[key] === undefined) continue;
		items.push({
			source: "grok-build",
			from: `${from} → models.${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}

	// ── permission: the mode here, the rules in the dispatch ─────────────────
	// The rules are planned from `planGrokPermissions` beside this call rather
	// than inside it, the way Codex's are: the list they append to is built in the
	// dispatch, and a planner that reached for it would take the whole accumulator
	// as a parameter.
	planGrokPermissionMode(raw, home, items, claimScalar);

	// The policy files beside `config.toml` are not a second copy of the user's
	// preferences: `requirements.toml` is where `disable_bypass_permissions_mode`
	// lives and `managed_config.toml` is pushed by an administrator. Carrying one
	// over would put an admin's requirement in the user's own settings file, where
	// it stays in force as the user's own choice after the machine stops being
	// administered — and the user never chose it. See {@link GROK_MACHINE_POLICY}.
	if (raw.machinePolicy.length > 0) {
		items.push({
			source: "grok-build",
			from: `${grokConfigPath(home, raw.root)} → ${raw.machinePolicy.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				"machine or organization policy rather than your own setting, so it is left where it is — a requirement " +
				"copied into your settings would outlive the policy that imposed it",
			containsSecret: false,
		});
	}

	// ── mcp_servers ──────────────────────────────────────────────────────────
	const servers = raw.config.mcp_servers;
	if (isRecord(servers)) {
		for (const [name, value] of Object.entries(servers)) {
			const label = `${from} → mcp_servers.${name}`;
			if (!isRecord(value)) continue;
			if (value.enabled === false) {
				items.push({
					source: "grok-build",
					from: label,
					to: "—",
					action: "skip",
					detail: "disabled in grok — there is no way to keep a server defined and switched off here",
					containsSecret: false,
				});
				continue;
			}
			const normalized = normalizeGrokMcp(value);
			if (normalized === null || !McpServerConfigSchema.safeParse(normalized.config).success) {
				items.push({
					source: "grok-build",
					from: label,
					to: "—",
					action: "skip",
					detail: "server definition does not match the supported stdio/http shapes",
					containsSecret: false,
				});
				continue;
			}
			if (name in existingMcpServers && !force) {
				items.push({
					source: "grok-build",
					from: label,
					to: "—",
					action: "skip",
					detail: "target already defines a server with this name — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			const secret =
				Object.keys(isRecord(normalized.config.headers) ? normalized.config.headers : {}).length > 0 ||
				Object.keys(isRecord(normalized.config.env) ? normalized.config.env : {}).some((key) =>
					looksLikeSecretName(key),
				);
			mcpServers[name] = normalized.config;
			markMcpSecret(secret);
			const copied = secret ? "copied verbatim, including credential headers" : "copied verbatim";
			items.push({
				source: "grok-build",
				from: label,
				to: `.mcp.json → mcpServers.${name}`,
				action: normalized.downgrades.length > 0 ? "downgrade" : "map",
				detail: normalized.downgrades.length > 0 ? `${copied} — ${normalized.downgrades.join("; ")}` : copied,
				containsSecret: secret,
			});
		}
	}
	if (raw.config.disabled_mcp_servers !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → disabled_mcp_servers`,
			to: "—",
			action: "skip",
			detail:
				"servers grok knows about but does not start; there is no way to keep one defined and switched off " +
				"here, so importing it would start it",
			containsSecret: false,
		});
	}
	if (raw.config.disabled_mcp_tools !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → disabled_mcp_tools`,
			to: "—",
			action: "skip",
			detail: "tools hidden from the model on a server here are approved per project rather than listed in a file",
			containsSecret: false,
		});
	}

	// ── skills and paths ─────────────────────────────────────────────────────
	const skills = isRecord(raw.config.skills) ? raw.config.skills : {};
	if (raw.skillPaths.length > 0) {
		items.push({
			source: "grok-build",
			from: `${from} → skills.paths`,
			to: "—",
			action: "skip",
			detail: `${raw.skillPaths.length} extra skill directory/directories — read by this importer, and the skills under them are listed with the rest`,
			containsSecret: false,
		});
	}
	if (raw.serverSkillDirCount > 0 || raw.bundledSkillDirCount > 0) {
		items.push({
			source: "grok-build",
			from: `${from} → skills.server_skill_dirs, skills.bundled_skill_dirs`,
			to: "—",
			action: "skip",
			detail:
				`${raw.serverSkillDirCount + raw.bundledSkillDirCount} directory/directories the launcher and the ` +
				"release itself inject — counted, never walked, because they are not yours to carry",
			containsSecret: false,
		});
	}
	const paths = isRecord(raw.config.paths) ? raw.config.paths : {};
	if (paths.extra_skill_dirs !== undefined || paths.extra_rule_dirs !== undefined) {
		const named = [...grokStringList(paths.extra_skill_dirs), ...grokStringList(paths.extra_rule_dirs)];
		items.push({
			source: "grok-build",
			from: `${from} → paths.extra_skill_dirs, paths.extra_rule_dirs`,
			to: "—",
			action: "skip",
			detail:
				`${named.length} director${named.length === 1 ? "y" : "ies"} the Claude importer inside grok wrote, which ` +
				"point at ~/.claude and ~/.agents — other sources' trees, already covered by the claude-code and agents " +
				"sources; importing them here too would land a second copy of every skill",
			containsSecret: false,
		});
	}
	if (isRecord(raw.config.compat) || raw.vendorTrees.length > 0) {
		items.push({
			source: "grok-build",
			from: `${from} → compat`,
			to: "—",
			action: "skip",
			detail:
				`grok's compatibility scanning (its toggles here, and the trees it found: ${summarizeNames(raw.vendorTrees)}); ` +
				"those belong to the tools that own them, and grok's own claude_import_state shows it has already read them once",
			containsSecret: false,
		});
	}
	const plugins = isRecord(raw.config.plugins) ? raw.config.plugins : {};
	if (skills.disabled !== undefined || skills.ignore !== undefined) {
		items.push({
			source: "grok-build",
			from: `${from} → skills.disabled, skills.ignore`,
			to: "—",
			action: "skip",
			detail: "applied — the skills these switch off are listed with the skills, each with the key that removed it",
			containsSecret: false,
		});
	}
	for (const [key, detail] of [
		[
			"disabled",
			"entries are plugin ids of the form `<scope>/<hash>/<name>`, and this importer cannot recompute the hash " +
				"from a directory — so a plugin you had switched off there is still read and imported as your own files",
		],
		[
			"enabled",
			"the same id form, naming project-scope plugins that default off; the plugin roots read here are the two " +
				"under $GROK_HOME",
		],
		[
			"paths",
			"extra plugin directories, which this importer does not walk: only the two roots under $GROK_HOME are read",
		],
	] as Array<[string, string]>) {
		if (plugins[key] === undefined) continue;
		items.push({
			source: "grok-build",
			from: `${from} → plugins.${key}`,
			to: "—",
			action: "skip",
			detail,
			containsSecret: false,
		});
	}

	// ── the sections with no landing place, then whatever is left ────────────
	for (const [key, reason] of GROK_UNMIGRATED_SECTIONS) {
		if (raw.config[key] === undefined) continue;
		items.push({
			source: "grok-build",
			from: `${from} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	reportUnhandledKeys("grok-build", raw.config, GROK_CONFIG_HANDLED, from, items);
}

/**
 * The asset face of `$GROK_HOME`: the files the user wrote, then the things this
 * importer walks past and names.
 *
 * Not {@link planAssetTrees}, for the reason that helper's own doc gives in
 * reverse: it renders the memory label from `SOURCE_ROOTS[source]`, which is a
 * guess at a directory *under home* — and `$GROK_HOME` can be anywhere. Every
 * path here is built from the resolved root, so a label always names a file the
 * reader actually opened. {@link planDeepSeekAssets} was split off for the same
 * reason.
 *
 * The second half matters as much as the first. A tree the importer walked past
 * without a word reads as an oversight, and the user's next move is to look for
 * it in the target and conclude the migration was broken — so every tree that
 * holds something and has no landing place here gets a line, and the two
 * credential files get one each that says outright that they were not opened.
 */
export function planGrokAssets(
	raw: RawGrokBuild,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	/** A path under the resolved root, rendered the way the report renders paths. */
	const at = (name: string): string => tildePath(home, join(raw.root, name));

	collectFileWrites(
		"grok-build",
		[...raw.skills, ...raw.pluginSkills],
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	if (raw.skillSkips.length > 0) {
		// The config section gets its own line in `planGrokBuild` saying the switches
		// were applied; this is the half that says *which* skills they removed, which
		// is what a user who forgot about them needs.
		items.push({
			source: "grok-build",
			from: `${at("skills")} → skills.disabled, skills.ignore`,
			to: "—",
			action: "skip",
			detail: `${raw.skillSkips.length} skill(s) grok itself does not load — ${summarizeNames(
				raw.skillSkips.map((skip) => `${skip.name} (${skip.reason})`),
			)}`,
			containsSecret: false,
		});
	}
	// Original file names, as `planClaudeCode` does: a rule is a document the user
	// named, and `grok-` prefixes would put it in a different sort order than where
	// they left it.
	collectFileWrites(
		"grok-build",
		raw.rules,
		(name) => join(home, ".labunbun", "rules", name),
		"rule",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		"grok-build",
		[...raw.agents, ...raw.pluginAgents],
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	planCommands(
		"grok-build",
		raw.commands,
		raw.pluginCount > 0 ? `${at("commands")} (and each plugin's commands/)` : at("commands"),
		home,
		force,
		items,
		writes,
	);

	// ── memory ───────────────────────────────────────────────────────────────
	// Every spelling of the instruction file is read and joined into one document
	// (`GROK_INSTRUCTION_FILES`), so the label names one and says so rather than
	// claiming the others are not there.
	if (raw.memory?.trim()) {
		planMemoryAsRule(
			"grok-build",
			`${at("AGENTS.md")} (grok reads Agents.md and AGENT.md too, and joins whichever exist)`,
			home,
			raw.memory,
			"imported-grok-build.md",
			force,
			items,
			writes,
		);
	}
	/** The global memory document in force, as a path under the root. */
	const globalMemoryPath =
		raw.globalMemorySource.generation === "v2" ? join("memory-v2", "global", "MEMORY.md") : join("memory", "MEMORY.md");
	if (raw.globalMemory?.trim()) {
		planMemoryAsRule(
			"grok-build",
			at(globalMemoryPath),
			home,
			raw.globalMemory,
			"imported-grok-build-memory.md",
			force,
			items,
			writes,
		);
	}
	// The document in the other tree is named: grok's two memory generations are
	// isolated, so exactly one is in force and a user with both is about to keep
	// one of them. Which one is decided by grok's own switch, and that decision is
	// what the line states — an importer that read the wrong tree silently is how
	// this branch came to exist.
	if (raw.globalMemorySource.other !== null) {
		const v2Selected = raw.globalMemorySource.generation === "v2";
		items.push({
			source: "grok-build",
			from: at(v2Selected ? join("memory", "MEMORY.md") : join("memory-v2", "global", "MEMORY.md")),
			to: "—",
			action: "skip",
			detail: v2Selected
				? "a document under the legacy memory root, which grok stopped reading when [memory_v2] enabled was set — v2 " +
					"runs in its own tree and cannot see the legacy one, so this is not the global memory in force there"
				: "a document under memory-v2, which grok reads only when [memory_v2] enabled is true — that switch is not set " +
					"in this config.toml, so the legacy memory tree is the one in force; a v2 enablement arriving from the " +
					"server, which this importer cannot read, would make this the live document instead",
			containsSecret: false,
		});
	}
	if (raw.memoryWorkspaceCount > 0) {
		// A rule file is loaded in every workspace, and these documents are keyed to
		// the repository grok saw them in. Importing one would not move a note, it
		// would widen its scope — which is a decision for the user, not for this
		// importer.
		items.push({
			source: "grok-build",
			from: `${at("memory")} (and memory-v2/, excluding the global document)`,
			to: "—",
			action: "skip",
			detail:
				`${raw.memoryWorkspaceCount} workspace-scoped memory document(s) — each is keyed to one repository, and a rule ` +
				"file here is loaded in every workspace, so carrying one would turn one project's notes into a global instruction",
			containsSecret: false,
		});
	}

	// ── plugins: what came out of them, and what did not ─────────────────────
	if (raw.pluginCount > 0) {
		items.push({
			source: "grok-build",
			from: `${at(GROK_PLUGIN_DIR)}, ${at(GROK_INSTALL_DIR)} (or [plugins].install_dir)`,
			to: "—",
			action: "skip",
			detail:
				`${raw.pluginCount} plugin(s) — grok enables one as a unit and this build has no such unit, so the skills, ` +
				"commands and agents above are now plain files of yours that load whenever skills do; each line names the " +
				"plugin it came from",
			containsSecret: false,
		});
	}
	if (raw.pluginMcpCount > 0 || raw.pluginHookCount > 0) {
		items.push({
			source: "grok-build",
			from: `${at(GROK_PLUGIN_DIR)}/*/{${GROK_PLUGIN_MCP}, hooks/hooks.json}`,
			to: "—",
			action: "skip",
			detail:
				`${raw.pluginMcpCount} plugin MCP declaration(s) and ${raw.pluginHookCount} hook file(s) — counted, never read: ` +
				"they change what a session does rather than what it knows, and a third-party plugin's hooks should not enter " +
				"your configuration without your having seen them",
			containsSecret: false,
		});
	}

	// ── trees grok keeps that are not the user's writing ─────────────────────
	if (raw.bundledPresent || raw.marketplaceCachePresent) {
		const named = [
			raw.bundledPresent ? at("bundled") : null,
			raw.marketplaceCachePresent ? at("marketplace-cache") : null,
		];
		items.push({
			source: "grok-build",
			from: named.filter((name): name is string => name !== null).join(", "),
			to: "—",
			action: "skip",
			detail: "grok's own shipped content and its download cache — neither is yours to carry, so both are named only",
			containsSecret: false,
		});
	}
	if (raw.lspPresent) {
		items.push({
			source: "grok-build",
			from: at("lsp.json"),
			to: "—",
			action: "skip",
			detail: "the language servers grok starts — named only; nothing here registers a server for this build",
			containsSecret: false,
		});
	}
	if (raw.pagerPresent) {
		items.push({
			source: "grok-build",
			from: at("pager.toml"),
			to: "—",
			action: "skip",
			detail: "preferences for grok's own screen — named only; this build's interface is not configured from a file",
			containsSecret: false,
		});
	}
	if (raw.claudeImportStatePresent) {
		items.push({
			source: "grok-build",
			from: at("claude_import_state.json"),
			to: "—",
			action: "skip",
			detail:
				"grok's own record of a completed ~/.claude import — read for its existence alone, and it is the plainest " +
				"evidence that those trees have been carried across once already, which is why this importer leaves them to " +
				"the claude-code and agents sources",
			containsSecret: false,
		});
	}

	// ── what is left under the home ──────────────────────────────────────────
	if (raw.unimported.length > 0) {
		items.push({
			source: "grok-build",
			from: raw.unimported.map((entry) => `${at(entry.name)} (${entry.count})`).join(", "),
			to: "—",
			action: "skip",
			detail:
				"trees grok reads that have no counterpart here — its own prompt machinery, memory its agents wrote, and the " +
				"scripts it runs around a session — counted so their absence from this report reads as a decision",
			containsSecret: false,
		});
	}
	if (raw.runtimePresent.length > 0) {
		items.push({
			source: "grok-build",
			from: raw.runtimePresent.map((name) => at(name)).join(", "),
			to: "—",
			action: "skip",
			detail: "not configuration at all: logs, caches, downloads and machine state grok writes as it runs",
			containsSecret: false,
		});
	}
	// The two credential files, each by name. `existsSync` is the only thing either
	// one is ever subjected to, and these two lines are the whole of what the report
	// may say about them — no size, no mtime, no content.
	if (raw.authPresent) {
		items.push({
			source: "grok-build",
			from: at("auth.json"),
			to: "—",
			action: "skip",
			detail: "the account's tokens — named, never opened",
			containsSecret: false,
		});
	}
	if (raw.mcpCredentialsPresent) {
		items.push({
			source: "grok-build",
			from: at("mcp_credentials.json"),
			to: "—",
			action: "skip",
			detail: "MCP OAuth tokens — named, never opened",
			containsSecret: false,
		});
	}
	// A repository's own `.grok/` is deliberately outside this planner's reach.
	// Saying so is the point: the tree looks like this source's, so a user who does
	// not find it mentioned will read the silence as a bug. The permission rules in
	// its `config.toml` are the part most worth naming, since they are the one
	// thing in there that would be dangerous to move even if it could be read.
	items.push({
		source: "grok-build",
		from: "each repository's own .grok/ (.grok/skills, .grok/agents, .grok/rules, .grok/plugins)",
		to: "—",
		action: "skip",
		detail:
			"a repository's grok configuration — including the [permission] rules its .grok/config.toml carries, which grok " +
			"applies only once the repository is trusted — lives with the repository rather than under $GROK_HOME, so this " +
			"importer neither reads nor moves it",
		containsSecret: false,
	});
}

/**
 * `[ui] permission_mode`, and the two keys that spell the same decision.
 *
 * The mapping is short because grok's own is: `parse_permission_mode_canonical`
 * knows `always-approve`, `auto` and `ask`, treats `default` as a spelling of ask
 * and sends **everything else** there too. So a user who wrote
 * `permission_mode = "plan"` in `[ui]`, expecting the Claude Code vocabulary, has
 * been running with a mode that never auto-approves — and carrying the *name*
 * they wrote across would hand them a mode grok never applied. This planner
 * imports the mode grok resolved and names the string it resolved it from, which
 * is the only reading that cannot be a lie in either direction.
 *
 * Two details of `permission_mode_from_ui_if_set` are load-bearing. The
 * precedence is **type-gated**: `permission_mode` counts only as a string,
 * `approval_mode` only as a string, `yolo` only as `true`, so a key present in a
 * shape grok does not read falls through to the next instead of deciding. And
 * the presence of *any* of the three pins the answer — an explicit
 * `yolo = false` resolves to ask rather than to "unset", so an account default
 * cannot win — which is why a reading of ask is claimed as an explicit
 * `default` here rather than left out as if nothing had been said.
 */
function planGrokPermissionMode(
	raw: RawGrokBuild,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
): void {
	const ui = isRecord(raw.config.ui) ? raw.config.ui : {};
	const from = `${grokConfigPath(home, raw.root)} → ui`;
	const keys = ["permission_mode", "approval_mode", "yolo"] as const;
	const present = keys.filter((key) => ui[key] !== undefined);
	if (present.length === 0) return;

	/** What one key resolves to on its own, or `undefined` when grok would not read it. */
	const resolveKey = (name: (typeof keys)[number]): "always-approve" | "auto" | "ask" | undefined => {
		const value = ui[name];
		if (value === undefined) return undefined;
		if (name === "yolo") return value === true ? "always-approve" : undefined;
		if (typeof value !== "string") return undefined;
		if (name === "approval_mode") return value === "always-approve" ? "always-approve" : "ask";
		return value === "always-approve" ? "always-approve" : value === "auto" ? "auto" : "ask";
	};
	// grok's precedence, applied to the keys it actually reads. With none of them
	// readable the earlier presence check has still pinned the mode, to ask.
	const readable = keys
		.map((name) => [name, resolveKey(name)] as const)
		.filter(
			(entry): entry is readonly [(typeof keys)[number], "always-approve" | "auto" | "ask"] => entry[1] !== undefined,
		);
	const decidedBy = readable[0]?.[0] ?? present[0];
	const reads = readable[0]?.[1] ?? "ask";
	const written = typeof ui[decidedBy] === "string" ? ui[decidedBy] : undefined;
	const label =
		readable.length > 0 ? `${from}.${decidedBy} (${JSON.stringify(ui[decidedBy])})` : `${from}.${present.join(", ")}`;

	const mode = reads === "always-approve" ? "bypassPermissions" : reads === "ask" ? "default" : undefined;
	if (mode !== undefined) {
		// A name grok does not know is the case worth spelling out: the file says
		// one thing and the session did another, and the user is the only one who
		// can say which of the two they want from here on.
		const surprising = written !== undefined && !GROK_PERMISSION_MODE_NAMES.has(written);
		claimScalar(
			"grok-build",
			"permissionMode",
			mode,
			label,
			surprising
				? `mapped to "${mode}" — grok resolves "${written}" to "${reads}", so the name written there is not the mode it ran`
				: `mapped to "${mode}"`,
		);
	} else {
		items.push({
			source: "grok-build",
			from: label,
			to: "—",
			action: "skip",
			detail:
				'"auto" is a classifier that approves the calls it judges safe, and the nearest mode here, dontAsk, ' +
				"does the opposite — anything not explicitly allowed is denied — so the session keeps whatever mode " +
				"it would otherwise start in",
			containsSecret: false,
		});
	}

	// The other spellings grok reads past. Named only when one of them would have
	// decided differently: a second key saying the same thing is not worth a line.
	for (const name of present) {
		if (name === decidedBy) continue;
		const own = resolveKey(name);
		if (own !== undefined && own === reads) continue;
		items.push({
			source: "grok-build",
			from: `${from}.${name} (${JSON.stringify(ui[name])})`,
			to: "—",
			action: "skip",
			detail:
				own !== undefined
					? `grok reads "${decidedBy}" first and stops there, so this spelling of the same decision is not in force; on its own it would have meant "${own}"`
					: `grok reads this key only as ${name === "yolo" ? "the boolean true" : "a string"}, so a value in this shape falls through to the next key rather than deciding`,
			containsSecret: false,
		});
	}
}

/** The mode names grok's `[ui] permission_mode` recognises, `default` as an alias of ask included. */
const GROK_PERMISSION_MODE_NAMES = new Set(["always-approve", "auto", "ask", "default"]);

/**
 * Keys of grok's `config.toml` that are either imported above or named by a line
 * of their own. Anything else reaches the report through {@link reportUnhandledKeys},
 * so a key the user set is never simply missing from it.
 */
const GROK_CONFIG_HANDLED = new Set<string>([
	"model",
	"models",
	"model_providers",
	"permission",
	"mcp_servers",
	"disabled_mcp_servers",
	"disabled_mcp_tools",
	"skills",
	"paths",
	"compat",
	"plugins",
	"ui",
	...GROK_UNMIGRATED_SECTIONS.map(([key]) => key),
]);
