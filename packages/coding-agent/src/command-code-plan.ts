/**
 * Command Code's configuration in the target's shape.
 *
 * The rule translator is most of this file, because Command Code spells rules
 * its own way — a small vocabulary of tool aliases over a glob dialect that
 * treats `?` as a plain character and refuses to let `*` cross a slash — while
 * the target wants `Tool(specifier)` rules over a different dialect. Turning
 * one into the other is a decision, and decisions belong on the planning side
 * where they can be tested without touching a disk.
 *
 * Two of the source's own behaviours decide the shape of the translation and
 * are quoted where they are used: its deny pass matches aggressively (a
 * field-scoped matcher, a wildcard server, a tool glob all live only there)
 * and its allow pass matches conservatively (none of those match at all), so
 * a rule that can only ever match in the deny pass is refused on the allow
 * side rather than widened.
 *
 * Long-form design notes: docs/dev/migration-sources.md
 */

import { basename } from "node:path";
import type { PermissionMode, SandboxMode } from "@labunbun/agent";
import { McpServerConfigSchema } from "@labunbun/mcp";
import {
	COMMAND_CODE_DEFAULT_CONTEXT_WINDOW,
	COMMAND_CODE_HOOK_DEFAULT_TIMEOUT_MS,
	COMMAND_CODE_HOOK_EVENTS,
	COMMAND_CODE_HOOK_MATCH_ALL,
	COMMAND_CODE_HOOK_MATCHER_LABELS,
	COMMAND_CODE_HOOK_MATCHER_MAX,
	COMMAND_CODE_HOOK_MAX_TIMEOUT_MS,
	COMMAND_CODE_LEGACY_CONFIG_KEYS,
	commandCodeBypassDisabled,
	commandCodeCommandsDir,
	normalizeCommandCodePermissionMode,
} from "./command-code-home.ts";
import type {
	CommandCodeMcp,
	CommandCodeProvider,
	CommandCodeProviderModel,
	RawCommandCode,
} from "./command-code-read.ts";
import { HooksConfigSchema } from "./hooks.ts";
import {
	ASSUMED_MAX_OUTPUT_TOKENS,
	DEFAULT_HOOK_TIMEOUT_MS,
	isRecord,
	mergeProviderSpecs,
	normalizeClaudeHooks,
	planAssetTrees,
	summarizeNames,
	tildePath,
	urlCredentialProblem,
} from "./migrate-core.ts";
import type {
	ClaimHooks,
	ClaimModePair,
	ClaimPermissionList,
	ClaimScalar,
	MigrationItem,
	MigrationSourceId,
	PlannedWrite,
} from "./migrate-types.ts";
import { resolveModelReference } from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";

const SOURCE: MigrationSourceId = "command-code";

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * Command Code's permission modes → this build's two mode axes.
 *
 * `dont-ask` is deliberately absent, for the same class of reason Claude
 * Code's `auto` is absent from its table: it means the session answers "no"
 * to every question, and no mode here does that — `plan` still runs read-only
 * calls the source would have refused, and `ask` is its opposite. Carrying it
 * under either name would be a lie about what the session does.
 */
export const COMMAND_CODE_PERMISSION_MODE_MAP: Readonly<
	Record<string, { mode: PermissionMode; sandbox: SandboxMode }>
> = {
	default: { mode: "ask", sandbox: "workspace-write" },
	"auto-accept": { mode: "ask", sandbox: "workspace-write" },
	plan: { mode: "plan", sandbox: "workspace-write" },
	bypass: { mode: "agent", sandbox: "danger-full-access" },
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** `model` and `theme`, from `settings.json` or the legacy file, and what has no destination in either. */
function planCommandCodeSettings(raw: RawCommandCode, items: MigrationItem[], claimScalar: ClaimScalar): void {
	const settingsLabel = tildePath(raw.home, raw.settingsPath);
	const legacyLabel = tildePath(raw.home, raw.legacyConfigPath);

	const modelValue = raw.settings?.model ?? raw.legacyModel;
	if (modelValue !== undefined) {
		const from = `${raw.settings?.model !== undefined ? settingsLabel : legacyLabel} → model (${JSON.stringify(modelValue)})`;
		const resolved = resolveModelReference(modelValue);
		if (resolved === undefined) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"no model in the registry matches this name. The reference is the source's own name for a model, and guessing which registry row it meant could pin the session " +
					"to the wrong one — set a model reference by hand instead",
				containsSecret: false,
			});
		} else {
			claimScalar(SOURCE, "model", resolved, from, `resolved to ${resolved}`);
		}
	}

	const themeValue = raw.settings?.theme ?? raw.legacyTheme;
	if (themeValue !== undefined) {
		const from = `${raw.settings?.theme !== undefined ? settingsLabel : legacyLabel} → theme (${JSON.stringify(themeValue)})`;
		if (themeValue === "dark" || themeValue === "light") {
			claimScalar(
				SOURCE,
				"theme",
				themeValue,
				from,
				`mapped to this build's "${themeValue}", which is the same two named themes the source has`,
			);
		} else if (themeValue === "auto") {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					'"auto" is a choice, not a missing value: it means "follow the terminal", which is what this build already does by default. Pinning it to a named theme ' +
					"would write an appearance you did not pick — use `/theme` if you want one",
				containsSecret: false,
			});
		} else {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"the source's own reader accepts three themes (dark, light, auto), so a value outside those three did not come from its settings UI — the appearance is left " +
					"as it is",
				containsSecret: false,
			});
		}
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * `permissions.defaultMode` (or the legacy top-level `permissionMode`), with
 * the source's own two exceptions honoured: `disableBypass` makes `bypass`
 * fall back to `default` at runtime, so the fallback is what is imported; and
 * `dont-ask` has no counterpart.
 */
function planCommandCodeMode(raw: RawCommandCode, items: MigrationItem[], claimModePair: ClaimModePair): void {
	const settingsLabel = tildePath(raw.home, raw.settingsPath);
	const permissions = isRecord(raw.settings?.permissions) ? raw.settings.permissions : undefined;

	if (permissions?.disableBypass !== undefined) {
		items.push({
			source: SOURCE,
			from: `${settingsLabel} → permissions.disableBypass (${JSON.stringify(permissions.disableBypass)})`,
			to: "—",
			action: "downgrade",
			detail:
				"not written to ~/.labunbun/settings.json: this key is honoured only from the policy tier in this build, where the file being restricted cannot lift its own " +
				'restriction — put "disableBypassPermissionsMode": true in ~/.labunbun/managed-settings.json instead',
			containsSecret: false,
		});
	}

	const declared = permissions?.defaultMode ?? raw.settings?.permissionMode;
	if (declared === undefined) return;
	const from =
		permissions?.defaultMode !== undefined
			? `${settingsLabel} → permissions.defaultMode (${JSON.stringify(declared)})`
			: `${settingsLabel} → permissionMode (${JSON.stringify(declared)})`;
	const mode = normalizeCommandCodePermissionMode(declared);
	if (mode === undefined) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				"not one of the source's five modes or one of its aliases. Its own normalizer would get nothing out of this value and the session would start in `default` " +
				"there too — the value is reported rather than guessed at",
			containsSecret: false,
		});
		return;
	}
	if (mode === "dont-ask") {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				'no counterpart: in "dont-ask" the source refuses every call it has no rule for, and no mode here is that posture — the nearest, "plan", still runs ' +
				'read-only calls the source would have refused, and "ask" is the opposite shape. The mode is left as this build\'s default',
			containsSecret: false,
		});
		return;
	}
	if (mode === "bypass" && commandCodeBypassDisabled(permissions?.disableBypass)) {
		const fallback = COMMAND_CODE_PERMISSION_MODE_MAP.default;
		claimModePair(
			SOURCE,
			fallback.mode,
			fallback.sandbox,
			from,
			'its `permissions.disableBypass` is set, so the source refuses to enter bypass mode and starts in "default" instead — the fallback is what was imported, ' +
				"not the value the file states",
		);
		return;
	}
	const mapped = COMMAND_CODE_PERMISSION_MODE_MAP[mode];
	const notes: Record<string, string> = {
		default: 'mapped to "ask": the source asks about a call it has no rule for, and so does this build',
		plan: 'mapped to "plan": reads run and everything else is refused before it runs, which is the posture the source\'s plan mode takes',
		bypass:
			'mapped to "agent": the source\'s bypass means "never ask" and "no confinement" at once; here those are two keys, and both were imported',
		"auto-accept":
			'mapped to "ask": this build has no mode that applies edits without asking, so a write is asked like everything else. Narrower than the mode it replaced, deliberately',
	};
	claimModePair(SOURCE, mapped.mode, mapped.sandbox, from, notes[mode] ?? "");
}

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

/**
 * `splitRule`, as the source spells it: the first unescaped `(`, a closing
 * `)`, an empty token refused, and parenthesis escapes stripped from the
 * specifier. A rule without a paren is its own token.
 */
function splitCommandCodeRule(text: string): { token: string; specifier?: string } | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	let open = -1;
	for (let index = 0; index < trimmed.length; index++) {
		if (trimmed[index] === "(" && trimmed[index - 1] !== "\\") {
			open = index;
			break;
		}
	}
	if (open === -1) return { token: trimmed };
	if (!trimmed.endsWith(")")) return null;
	const token = trimmed.slice(0, open).trim();
	if (token === "") return null;
	return { token, specifier: trimmed.slice(open + 1, -1).replace(/\\([()])/g, "$1") };
}

/**
 * The source's rule vocabulary, verbatim from its alias table: what each
 * spelling covers. The tool lists are the source's own sets — `read` stands
 * for five tools, `edit` for the edit pair.
 */
interface CommandCodeRuleSubject {
	kind: "shell" | "file" | "web" | "agent";
	tools?: readonly string[];
}

const COMMAND_CODE_RULE_ALIASES: Readonly<Record<string, CommandCodeRuleSubject>> = {
	shell: { kind: "shell" },
	bash: { kind: "shell" },
	powershell: { kind: "shell" },
	shell_command: { kind: "shell" },
	monitor_command: { kind: "shell" },
	kill_shell: { kind: "shell" },
	read: { kind: "file", tools: ["read_file", "read_multiple_files", "read_directory", "glob", "grep"] },
	read_file: { kind: "file", tools: ["read_file"] },
	read_multiple_files: { kind: "file", tools: ["read_multiple_files"] },
	read_directory: { kind: "file", tools: ["read_directory"] },
	glob: { kind: "file", tools: ["glob"] },
	grep: { kind: "file", tools: ["grep"] },
	edit: { kind: "file", tools: ["edit_file", "write_file"] },
	write: { kind: "file", tools: ["write_file"] },
	edit_file: { kind: "file", tools: ["edit_file"] },
	write_file: { kind: "file", tools: ["write_file"] },
	// The source's own table gives `notebookedit` the edit pair's tool set —
	// not a notebook tool of its own — so it translates exactly as `edit` does.
	notebookedit: { kind: "file", tools: ["edit_file", "write_file"] },
	webfetch: { kind: "web", tools: ["web_fetch"] },
	web_fetch: { kind: "web", tools: ["web_fetch"] },
	websearch: { kind: "web", tools: ["web_search"] },
	web_search: { kind: "web", tools: ["web_search"] },
	agent: { kind: "agent" },
	task: { kind: "agent" },
};

/** Which target tool each of the source's file tools becomes. */
const COMMAND_CODE_FILE_TOOL_TARGETS: Readonly<Record<string, string>> = {
	read_file: "Read",
	read_multiple_files: "Read",
	read_directory: "Read",
	glob: "Glob",
	grep: "Grep",
	edit_file: "Edit",
	write_file: "Write",
};

/**
 * The field names the source's parameter-scoped matcher refuses to treat as
 * custom (`nC`), and the shape it accepts for the rest (`oC`): a specifier
 * like `branch:main` matches the call's `branch` input field, but only in the
 * aggressive pass — the one deny rules run in.
 */
const COMMAND_CODE_NON_PARAM_PREFIXES = new Set(["command", "file_path", "path", "notebook_path", "url"]);

/** The field name a `field:pattern` specifier scopes to, or null when the specifier is not that shape. */
function commandCodeParamPrefix(specifier: string): string | null {
	const colon = specifier.indexOf(":");
	if (colon <= 0) return null;
	const prefix = specifier.slice(0, colon);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) return null;
	return COMMAND_CODE_NON_PARAM_PREFIXES.has(prefix) ? null : prefix;
}

/** One source rule, translated; a refusal when it could not be carried at all. */
type CommandCodeRuleTranslation = { rules: string[]; loss?: string } | { refusal: string };

/**
 * One shell specifier → the rules that mean the same commands here.
 *
 * The source's forms, verbatim from `matchesShellPattern`: `X:*` and `X *`
 * and a bare `X` all match `X` itself or `X` followed by a space and
 * arguments; anything else with a `*` is a glob over the whole name. This
 * build has one form — a glob over the whole command line — so `X:*` and
 * `X *` and a bare name each become the same two rules, and the pair is the
 * same set of commands. A specifier of `""` or `*` is every command, in both
 * engines.
 */
function translateShellSpecifier(specifier: string, behavior: "allow" | "deny"): CommandCodeRuleTranslation {
	const spec = specifier.trim();
	if (spec === "" || spec === "*") return { rules: ["Bash"] };
	if (spec.includes("?")) {
		return {
			refusal:
				"`?` is a plain character in the source's patterns and a one-character wildcard here, so the rule would not mean the same thing",
		};
	}
	const param = commandCodeParamPrefix(spec);
	if (param !== null) {
		return {
			refusal:
				behavior === "deny"
					? `it matches the \`${param}\` input field of the call rather than the command line, and the source only consults that matcher when denying — this build has no field-scoped rule, and one written without it would not deny what this did`
					: `it matches the \`${param}\` input field of the call, which the source only consults in its aggressive pass — the pass deny rules run in — so this allow never matches there and importing it would not mean the same thing`,
		};
	}
	let rules: string[];
	if (spec.endsWith(":*")) {
		const base = spec.slice(0, -2).trim();
		rules = base === "" ? ["Bash"] : [`Bash(${base})`, `Bash(${base} *)`];
	} else if (spec.endsWith(" *")) {
		const base = spec.slice(0, -2).trim();
		rules = base === "" ? ["Bash"] : [`Bash(${base})`, `Bash(${base} *)`];
	} else if (spec.includes("*")) {
		rules = [`Bash(${spec})`];
	} else {
		rules = [`Bash(${spec})`, `Bash(${spec} *)`];
	}
	const loss = rules.some((rule) => rule.includes("*"))
		? "a `*` in a shell rule crosses line breaks here and does not in the source"
		: undefined;
	return { rules, loss };
}

/**
 * One path specifier → the path patterns that mean the same files here.
 *
 * The source anchors every pattern against the working directory: a leading
 * `/` means "from the workspace root" (a doubled `//` means a real absolute
 * path), a bare name matches at any depth below it, and `**` matches zero or
 * more whole directories. This build's candidates include the workspace
 * relative path as written, so the leading `/` is dropped and `~` is left for
 * the target to expand — the two rules that cannot be written as one are
 * written as two.
 */
function translatePathSpecifier(specifier: string): { specifiers: string[] } | { refusal: string } {
	let spec = specifier.trim();
	if (spec === "" || spec === "*") return { specifiers: [""] };
	if (spec.includes("?")) {
		return {
			refusal:
				"`?` is a plain character in the source's patterns and a one-character wildcard here, so the rule would not mean the same thing",
		};
	}
	if (spec.startsWith("//")) {
		spec = spec.slice(1);
	} else if (!spec.startsWith("~/")) {
		if (spec.startsWith("/")) spec = spec.slice(1);
		else if (spec.startsWith("./")) spec = spec.slice(2);
	}
	if (spec === "" || spec === "*") return { specifiers: [""] };
	if (spec.endsWith("/**")) {
		const base = spec.slice(0, -3).replace(/\/+$/, "");
		if (base !== "" && !base.includes("*")) return { specifiers: [base, spec] };
	}
	if (spec.startsWith("**/")) {
		const rest = spec.slice(3);
		if (rest !== "") return { specifiers: [rest, `**/${rest}`] };
	}
	if (!spec.includes("/") && !spec.includes("*")) return { specifiers: [spec, `**/${spec}`] };
	if (spec.includes("**/")) {
		return { specifiers: [spec.replace(/\*\*\//g, "**")] };
	}
	return { specifiers: [spec] };
}

/** One mcp token (`mcp__server__tool`), translated the way the source parses it. */
function translateMcpToken(rest: string, behavior: "allow" | "deny"): CommandCodeRuleTranslation {
	if (rest === "") return { refusal: "an `mcp__` rule with no server name after it" };
	const cut = rest.indexOf("__");
	const server = cut === -1 ? rest : rest.slice(0, cut);
	const tool = cut === -1 ? undefined : rest.slice(cut + 2);
	if (server === "*") {
		// `"*" === server` is checked only in the aggressive pass — the deny pass.
		if (behavior === "deny") {
			return {
				rules: ["mcp__*"],
				loss: "a whole-server wildcard is matched only in the source's aggressive pass, which is the pass deny rules run in — here it is a deny over every MCP tool, as it is there",
			};
		}
		return {
			refusal:
				"a whole-server wildcard — the source matches it only in its aggressive pass, never in the pass allow rules run in, so importing it as an allow would widen",
		};
	}
	if (server.includes("?") || tool?.includes("?")) {
		return {
			refusal:
				"`?` is a plain character in the source's patterns and a one-character wildcard here, so the rule would not mean the same thing",
		};
	}
	// A server-wide rule (`mcp__server` or `mcp__server__*`) and a tool-name
	// glob (`mcp__server__get*`, matched in both passes there) are the same
	// spelling in this build: the rule matches the tool segment inside the
	// server either way.
	if (tool === undefined || tool === "") return { rules: [`mcp__${server}`] };
	return { rules: [`mcp__${server}__${tool}`] };
}

/**
 * One rule from either list, in the target's spelling.
 *
 * The deny list is what the source matches aggressively; the allow list is
 * what it matches conservatively. The difference is load-bearing here: a rule
 * that can only match in the aggressive pass (a field-scoped specifier, a
 * tool-name glob, a wildcard server) is refused on the allow side, because
 * carrying it would grant what the source never granted; on the deny side it
 * is carried only where the target's matching really covers the same calls.
 */
function translateCommandCodeRule(text: string, behavior: "allow" | "deny"): CommandCodeRuleTranslation {
	const split = splitCommandCodeRule(text);
	if (split === null) {
		return { refusal: "not in the `Token(specifier)` or bare-token form the source's own parser accepts" };
	}
	const { token } = split;
	const specifier =
		split.specifier === undefined || split.specifier === "" || split.specifier === "*" ? undefined : split.specifier;
	if (token.startsWith("mcp__")) return translateMcpToken(token.slice("mcp__".length), behavior);
	const alias = COMMAND_CODE_RULE_ALIASES[token.toLowerCase()];
	if (alias === undefined) {
		// A token with a `*` and no specifier is a glob over tool names, and the
		// source matches it only in the aggressive pass.
		if (specifier === undefined && token.includes("*")) {
			if (token === "*" && behavior === "deny") {
				return {
					rules: ["*"],
					loss: "a wildcard over tool names is matched only in the source's aggressive pass, which is the pass deny rules run in — here it denies every call, as it does there",
				};
			}
			return {
				refusal:
					"a wildcard over tool names — the source matches it only in its aggressive pass, never in the pass allow rules run in. Write one rule per tool instead",
			};
		}
		return { refusal: `\`${token}\` does not name a tool this build has` };
	}
	if (alias.kind === "shell") {
		if (specifier === undefined) return { rules: ["Bash"] };
		return translateShellSpecifier(specifier, behavior);
	}
	if (alias.kind === "agent") {
		if (specifier === undefined) return { rules: ["Task"] };
		return {
			refusal:
				"a subagent-type pattern — this build's Task rule cannot be scoped by subagent type, so the rule would never match; write it unscoped for the same effect as allowing the tool",
		};
	}
	if (alias.kind === "web") {
		const isFetch = alias.tools?.[0] === "web_fetch";
		if (specifier === undefined) return { rules: [isFetch ? "WebFetch" : "WebSearch"] };
		return {
			refusal: isFetch
				? "a URL or `domain:` pattern — this build cannot scope WebFetch by address, so the rule would never match; write it unscoped for the same effect as allowing the tool"
				: "a query pattern — this build cannot scope WebSearch, so the rule would never match; write it unscoped for the same effect as allowing the tool",
		};
	}
	const targets = [...new Set((alias.tools ?? []).map((tool) => COMMAND_CODE_FILE_TOOL_TARGETS[tool]))];
	if (specifier === undefined) return { rules: targets };
	const pathResult = translatePathSpecifier(specifier);
	if ("refusal" in pathResult) return { refusal: pathResult.refusal };
	// Glob and Grep rules cannot carry a specifier in this build — a scoped rule
	// there is a rule that never matches — so those sides are dropped and said.
	const scopedTargets = targets.filter((target) => target !== "Glob" && target !== "Grep");
	const unscopable = targets.filter((target) => target === "Glob" || target === "Grep");
	const rules = scopedTargets.flatMap((target) =>
		pathResult.specifiers.map((spec) => (spec === "" ? target : `${target}(${spec})`)),
	);
	if (rules.length === 0) {
		return {
			refusal:
				"it scopes a rule whose only target here is Glob or Grep, and this build's Glob and Grep rules cannot carry a specifier — the rule would never match",
		};
	}
	const losses: string[] = [];
	if (unscopable.length > 0) {
		losses.push(
			`the source's \`${token}\` also covers tool${unscopable.length === 1 ? "" : "s"} this build spells ${unscopable.join("/")}, and rules for ${unscopable.length === 1 ? "it" : "them"} cannot carry a specifier — that side was left out`,
		);
	}
	if (specifier.includes("**/") && !specifier.startsWith("**/")) {
		losses.push(
			"a `**/` between path segments means zero or more directories in the source; written as `**` here, which crosses the slash on its own",
		);
	}
	if (specifier.endsWith("/**")) {
		const base = specifier.slice(0, -3).replace(/\/+$/, "");
		if (base.includes("*")) {
			losses.push(
				"a `/**` whose base itself contains `*` was carried as written, and the source also matched the directory itself",
			);
		}
	}
	return { rules, loss: losses.length > 0 ? losses.join("; ") : undefined };
}

// Long-form design notes: docs/dev/migration-sources.md
/** One of the two rule lists, translated and claimed; refusals reported, not swallowed. */
function planCommandCodeRuleList(
	raw: RawCommandCode,
	behavior: "allow" | "deny",
	items: MigrationItem[],
	claimPermissionList: ClaimPermissionList,
): void {
	const permissions = isRecord(raw.settings?.permissions) ? raw.settings.permissions : undefined;
	const list = permissions?.[behavior];
	if (list === undefined) return;
	const settingsLabel = tildePath(raw.home, raw.settingsPath);
	const from = `${settingsLabel} → permissions.${behavior}`;
	if (!Array.isArray(list)) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail: "not an array — the source's own reader falls back to no rules when it is not, and so does this one",
			containsSecret: false,
		});
		return;
	}
	const texts = list.filter((entry): entry is string => typeof entry === "string");
	const nonStrings = list.length - texts.length;
	if (texts.length === 0) {
		if (nonStrings > 0) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: `${nonStrings} entr${nonStrings === 1 ? "y" : "ies"} that ${nonStrings === 1 ? "is" : "are"} not ${nonStrings === 1 ? "a string" : "strings"} — a rule has to be one, and none was carried`,
				containsSecret: false,
			});
		}
		return;
	}
	const translated: string[] = [];
	const refusals: string[] = [];
	const notes = new Set<string>();
	let rewritten = 0;
	for (const text of texts) {
		const result = translateCommandCodeRule(text, behavior);
		if ("refusal" in result) {
			refusals.push(`\`${text}\` — ${result.refusal}`);
			continue;
		}
		if (result.rules.length > 1) rewritten += 1;
		if (result.loss !== undefined) for (const note of result.loss.split("; ")) notes.add(note);
		translated.push(...result.rules);
	}
	if (nonStrings > 0) {
		notes.add(
			`${nonStrings} entr${nonStrings === 1 ? "y was" : "ies were"} not strings and ${nonStrings === 1 ? "was" : "were"} left out`,
		);
	}
	if (refusals.length > 0) {
		const shown = refusals.slice(0, 3).join("; ");
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail: `${refusals.length} rule(s) not carried: ${shown}${refusals.length > 3 ? `; and ${refusals.length - 3} more` : ""}`,
			containsSecret: false,
		});
	}
	if (translated.length === 0) return;
	const parts: string[] = [
		`${translated.length} ${behavior} rule(s) translated from Command Code's grammar${rewritten > 0 ? ` (${rewritten} written as two rules here)` : ""}`,
	];
	parts.push(
		behavior === "allow"
			? "the source's allow pass requires every segment of a chained command to match one; here a rule matches the whole command line, so a chained command that starts the same way counts as a match too"
			: "the source denies a chained command when any part of it matches; here the whole command line has to match, so a chain can get past a deny it would have been caught by",
	);
	parts.push("path matching here resolves no symlinks — the path as written is what a path rule is matched against");
	for (const note of [...notes].sort()) parts.push(note);
	claimPermissionList(
		SOURCE,
		behavior,
		translated,
		from,
		`${parts.join(". ")}.`,
		refusals.length > 0 ? "downgrade" : "map",
	);
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * The `ask` list and `additionalDirectories`.
 *
 * The ask list is not carried: the migration pipeline writes the allow, deny
 * and additionalDirectories tiers, and no source before this one had an ask
 * tier to carry. This build does have one — `permissions.ask` is a real key
 * in its settings file — so the list is reported for a by-hand move rather
 * than dropped in silence. `additionalDirectories` is the same key name with
 * the same meaning on both sides, so it is copied verbatim.
 */
function planCommandCodeOtherPermissions(
	raw: RawCommandCode,
	items: MigrationItem[],
	claimPermissionList: ClaimPermissionList,
): void {
	const permissions = isRecord(raw.settings?.permissions) ? raw.settings.permissions : undefined;
	if (permissions === undefined) return;
	const settingsLabel = tildePath(raw.home, raw.settingsPath);
	if (permissions.ask !== undefined) {
		const count = Array.isArray(permissions.ask) ? permissions.ask.length : 0;
		items.push({
			source: SOURCE,
			from: `${settingsLabel} → permissions.ask`,
			to: "—",
			action: "skip",
			detail:
				`${count} rule(s) the migration pipeline does not carry: it writes allow, deny and additionalDirectories, and this tier predates it. This build *does* have an ask tier — ` +
				"`permissions.ask` in ~/.labunbun/settings.json means what it means here — so the list can be moved by hand, and copied as-is it keeps its meaning",
			containsSecret: false,
		});
	}
	const directories = permissions.additionalDirectories;
	if (!Array.isArray(directories)) return;
	const paths = directories.filter((entry): entry is string => typeof entry === "string");
	if (paths.length === 0) return;
	claimPermissionList(
		SOURCE,
		"additionalDirectories",
		paths,
		`${settingsLabel} → permissions.additionalDirectories`,
		`${paths.length} extra director${paths.length === 1 ? "y" : "ies"} the session may read without asking — the same key name and the same meaning on both sides`,
	);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** One source hook group, after the matcher translation; the handlers with no counterpart are counted away. */
interface TranslatedHookGroup {
	matcher?: string;
	hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Command Code's hooks → this build's.
 *
 * The matcher difference is the one that has to be stated: the source tests
 * its matcher, case-insensitive, against the tool's *display label* (`SHELL`,
 * `READ`), and this build tests a matcher against the tool's name (`Bash`,
 * `Read`). The label table lives in the home module; a matcher naming a label
 * whose tool has no counterpart here drops its whole group, because a group
 * that fires on nothing is worse than one that is reported. The source's JSON
 * output vocabulary differs in both directions — its `permissionDecision:
 * "deny"` under `hookSpecificOutput` is not read here, and a non-zero exit
 * blocks here where the source only blocks on exit 2 unless the handler was
 * marked failClosed.
 */
function planCommandCodeHooks(
	raw: RawCommandCode,
	items: MigrationItem[],
	claimHooks: ClaimHooks,
	existing: RawSettingsInput,
	force: boolean,
): void {
	const hooksValue = raw.settings?.hooks;
	if (hooksValue === undefined) return;
	const settingsLabel = tildePath(raw.home, raw.settingsPath);
	const from = `${settingsLabel} → hooks`;
	if (!isRecord(hooksValue) || Object.keys(hooksValue).length === 0) return;

	if (existing.hooks !== undefined && !force) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail: "target already defines hooks — kept (use --force to overwrite)",
			containsSecret: false,
		});
		return;
	}

	const translated: Record<string, TranslatedHookGroup[]> = {};
	const reasons: string[] = [];
	const unknownEvents: string[] = [];
	let handlerDrops = 0;
	let flagNotes = 0;
	let malformed = 0;
	for (const [event, entries] of Object.entries(hooksValue)) {
		if (!COMMAND_CODE_HOOK_EVENTS.includes(event)) {
			unknownEvents.push(event);
			continue;
		}
		if (!Array.isArray(entries)) {
			malformed += 1;
			continue;
		}
		const kept: TranslatedHookGroup[] = [];
		for (const entry of entries) {
			if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
				malformed += 1;
				continue;
			}
			let matcher: string | undefined;
			const declared = entry.matcher;
			if (typeof declared === "string" && !COMMAND_CODE_HOOK_MATCH_ALL.includes(declared)) {
				if (declared.length > COMMAND_CODE_HOOK_MATCHER_MAX) {
					reasons.push(`a matcher longer than ${COMMAND_CODE_HOOK_MATCHER_MAX} characters (the source skips it too)`);
					continue;
				}
				if (event === "Stop" || event === "SessionStart") {
					reasons.push(`a matcher on ${event}, which the source tests against an empty tool name and so never runs`);
					continue;
				}
				const names: string[] = [];
				let unusable = false;
				for (const segment of declared.split("|")) {
					const label = segment.trim().toUpperCase();
					const name = COMMAND_CODE_HOOK_MATCHER_LABELS[label];
					if (name === undefined) {
						unusable = true;
						break;
					}
					names.push(name);
				}
				if (unusable) {
					reasons.push(
						`a matcher this build cannot translate (${JSON.stringify(declared)}) — the source tests it as a case-insensitive regular expression against its display labels, ` +
							"and a matcher here is an alternation of tool names; only exact label names (SHELL, READ, EDIT, …) carry over",
					);
					continue;
				}
				matcher = names.join("|");
			}
			const handlers: TranslatedHookGroup["hooks"] = [];
			for (const handler of entry.hooks) {
				if (
					!isRecord(handler) ||
					handler.type !== "command" ||
					typeof handler.command !== "string" ||
					handler.command.trim() === ""
				) {
					handlerDrops += 1;
					continue;
				}
				if (handler.async || handler.failClosed) flagNotes += 1;
				let timeout: number | undefined;
				if (handler.timeout !== undefined) {
					const seconds = handler.timeout;
					if (typeof seconds !== "number" || !(seconds > 0) || seconds > COMMAND_CODE_HOOK_MAX_TIMEOUT_MS / 1000) {
						handlerDrops += 1;
						continue;
					}
					timeout = seconds;
				}
				handlers.push({ type: "command", command: handler.command, ...(timeout !== undefined ? { timeout } : {}) });
			}
			if (handlers.length > 0) kept.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: handlers });
		}
		if (kept.length > 0) translated[event] = kept;
	}

	const normalized = normalizeClaudeHooks(translated);
	const losses: string[] = [];
	if (reasons.length > 0) {
		const unique = [...new Set(reasons)];
		losses.push(`${reasons.length} hook group(s) not carried (${summarizeNames(unique, 3)})`);
	}
	if (handlerDrops > 0) {
		losses.push(`${handlerDrops} handler(s) that were not shell commands or did not name one the source would run`);
	}
	if (malformed > 0) losses.push(`${malformed} entr(ies) not in the hook shape at all`);
	if (unknownEvents.length > 0) {
		losses.push(`${summarizeNames([...new Set(unknownEvents)], 3)} — event name(s) the source's own loader ignores`);
	}
	if (normalized.convertedTimeouts > 0)
		losses.push("named timeouts are seconds in the source and were converted to milliseconds");
	if (normalized.untimedHandlers > 0) {
		losses.push(
			`a handler that names no timeout runs for ${DEFAULT_HOOK_TIMEOUT_MS / 1000} s here, where the source stops it at ${COMMAND_CODE_HOOK_DEFAULT_TIMEOUT_MS / 1000} s — set a timeout to keep the shorter one`,
		);
	}
	if (flagNotes > 0) {
		losses.push(
			`${flagNotes} handler(s) carried \`async\` or \`failClosed\`, and neither has a field here — every hook runs blocking, and a non-zero exit blocks here where the source only blocks on exit 2 unless the handler was failClosed`,
		);
	} else {
		losses.push("a non-zero exit blocks here where the source only blocks on exit 2");
	}
	losses.push(
		'the source can deny a call from its JSON output (`hookSpecificOutput.permissionDecision: "deny"`); this build reads a top-level `decision: "block"`, so that form is not read here',
	);

	if (Object.keys(normalized.config).length === 0) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail: `no hook survived the translation — ${summarizeNames(losses, 3)}`,
			containsSecret: false,
		});
		return;
	}
	if (!HooksConfigSchema.safeParse(normalized.config).success) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				"the translated hooks did not survive this build's own validation — nothing was written rather than something partial",
			containsSecret: false,
		});
		return;
	}
	claimHooks(SOURCE, normalized.config, from, losses.join("; "), losses.length > 0 ? "downgrade" : "map");
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The two MCP files, entry by entry, with every credential channel stated and left. */
function planCommandCodeMcp(
	raw: RawCommandCode,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	for (const collision of raw.mcpCollisions) {
		items.push({
			source: SOURCE,
			from: `${collision.kept} → ${collision.name}`,
			to: `~/.labunbun/.mcp.json → mcpServers.${collision.name}`,
			action: "map",
			detail: `a later file defines this name over the earlier one (${collision.dropped}) — later wins in Command Code, later is what was imported, and the earlier copy was not`,
			containsSecret: false,
		});
	}
	for (const server of raw.mcpServers) {
		planOneCommandCodeMcp(server, items, mcpServers, markMcpSecret, existingMcpServers, force);
	}
}

/** One server, from its transcribed entry to the claimed target config. */
function planOneCommandCodeMcp(
	server: CommandCodeMcp,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const { name, config } = server;
	const from = `${server.from} → ${name}`;
	const skip = (detail: string, containsSecret = false): void => {
		items.push({ source: SOURCE, from, to: "—", action: "skip", detail, containsSecret });
	};
	if (config.enabled === false) {
		skip(
			"switched off there (`enabled: false`) — a server that was off would come back on here, and this build's MCP file has no per-server switch to turn it back off",
		);
		return;
	}
	const downgrades: string[] = [];
	const out: Record<string, unknown> = {};
	if (config.transport === "stdio") {
		const command = typeof config.command === "string" ? config.command.trim() : "";
		if (command === "") {
			skip(
				"its transport is stdio and its command is not a usable string — a server the source's own parser would refuse as well",
			);
			return;
		}
		out.type = "stdio";
		out.command = command;
		if (config.args !== undefined && !Array.isArray(config.args)) {
			downgrades.push("its `args` was not an array, so none was carried");
		}
		const args = Array.isArray(config.args) ? config.args : [];
		const strings = args.filter((entry): entry is string => typeof entry === "string");
		if (strings.length < args.length) {
			downgrades.push(`${args.length - strings.length} argument(s) that were not strings, dropped`);
		}
		out.args = strings;
	} else {
		const url = typeof config.url === "string" ? config.url.trim() : "";
		if (url === "") {
			skip(
				`its transport is ${String(config.transport)} and its URL is not a usable string — a server the source's own parser would refuse as well`,
			);
			return;
		}
		const problem = urlCredentialProblem(url);
		if (problem !== null) {
			skip(
				`its URL carries a credential (${problem}) — the URL itself was not imported. Put the credential in the environment and reference it from the server config by hand`,
				true,
			);
			return;
		}
		out.type = "http";
		out.url = url;
		if (config.transport === "sse") {
			downgrades.push(
				'the source spells this transport "sse" and this build has one HTTP client, so it connects the same way',
			);
		}
	}
	if (Array.isArray(config.envNames) && config.envNames.length > 0) {
		const names = config.envNames.filter((entry): entry is string => typeof entry === "string");
		if (names.length > 0) {
			downgrades.push(
				`left off ${names.length} environment variable(s) (${summarizeNames(names)}) — the names are in this report, the values were not read, so an ` +
					"environment block it needed has to be set up again here",
			);
		}
	}
	if (config.hasHeaders === true) {
		downgrades.push(
			"left off its header block — header names and values were not read, so a header it needed has to be set again here",
		);
	}
	if (config.hasOAuth === true) {
		downgrades.push(
			"left off its OAuth block — the client secret, if it had one, was not read, and this build's MCP client has no OAuth configuration to put the rest into",
		);
	}
	if (!McpServerConfigSchema.safeParse(out).success) {
		skip(
			"the part of its shape that could be carried did not survive this build's own validation — nothing was written rather than something partial",
		);
		return;
	}
	if (name in existingMcpServers && !force) {
		skip("target already defines a server with this name — kept (use --force to overwrite)");
		return;
	}
	mcpServers[name] = out;
	markMcpSecret(false);
	items.push({
		source: SOURCE,
		from,
		to: `~/.labunbun/.mcp.json → mcpServers.${name}`,
		action: downgrades.length > 0 ? "downgrade" : "map",
		detail:
			downgrades.length > 0
				? `copied without its credentials — ${downgrades.join("; ")}`
				: "copied without its credentials (it declared none this importer could see)",
		containsSecret: false,
	});
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** One model entry in the target's shape, with the source's defaults made explicit. */
function commandCodeModelSpec(model: CommandCodeProviderModel): Record<string, unknown> {
	const spec: Record<string, unknown> = {
		id: model.id,
		contextWindow: model.contextWindow ?? COMMAND_CODE_DEFAULT_CONTEXT_WINDOW,
		maxOutputTokens: model.maxOutput ?? ASSUMED_MAX_OUTPUT_TOKENS,
	};
	if (model.name !== undefined) spec.name = model.name;
	if (model.reasoning === true) spec.reasoning = true;
	const cost = model.cost;
	if (cost !== undefined && typeof cost.input === "number" && typeof cost.output === "number") {
		spec.pricing = {
			input: cost.input,
			output: cost.output,
			...(typeof cost.cacheRead === "number" ? { cacheRead: cost.cacheRead } : {}),
			...(typeof cost.cacheWrite === "number" ? { cacheWrite: cost.cacheWrite } : {}),
		};
	}
	return spec;
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * `providers.json` → `providers.openaiCompatible`.
 *
 * The key is the hard part, and every refusal here is about it: the target's
 * entry requires the *name* of an environment variable, and the source's key
 * field can hold a `$VAR` reference (the only form that translates), a
 * `{env:VAR}` template (a substitution this build does not perform), or a
 * command to run (which this build will not run). A plaintext key never
 * reaches this function — the reader drops it the way the source does — and
 * a keyless provider has no representation, because `apiKeyEnv` is required
 * and there is no value of it that means "no key".
 */
function planCommandCodeProviders(
	raw: RawCommandCode,
	items: MigrationItem[],
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	force: boolean,
): void {
	const providersLabel = tildePath(raw.home, raw.providersPath);
	const skip = (provider: CommandCodeProvider, detail: string, containsSecret = false): void => {
		items.push({
			source: SOURCE,
			from: `${providersLabel} → ${provider.id}`,
			to: "—",
			action: "skip",
			detail,
			containsSecret,
		});
	};
	if (raw.providersProblem !== null) {
		items.push({
			source: SOURCE,
			from: providersLabel,
			to: "—",
			action: "skip",
			detail: raw.providersProblem,
			containsSecret: false,
		});
	}
	if (raw.disabledProviderIds.length > 0) {
		items.push({
			source: SOURCE,
			from: `${providersLabel} → disabled`,
			to: "—",
			action: "skip",
			detail:
				`${raw.disabledProviderIds.length} id(s) are recorded as disabled (${summarizeNames(raw.disabledProviderIds)}) — a tombstone keeps the id from being registered ` +
				"again there, and there is nothing underneath one to import",
			containsSecret: false,
		});
	}
	const openaiCompatible: Array<Record<string, unknown>> = [];
	for (const provider of raw.providers) {
		if (provider.rawApiKeyDropped) {
			skip(
				provider,
				"its `apiKey` held a plaintext key. The source itself refuses that shape and drops the entry; this report does the same, and the value was never copied out of the " +
					"file — store the key in an environment variable and register the provider by hand",
				true,
			);
			continue;
		}
		if (provider.keyless) {
			skip(
				provider,
				"marked keyless (`apiKey: false`). This build's provider entry requires an environment variable name for the key, and there is no value of that field that means " +
					'"no key" — register it by hand if the endpoint really takes none',
			);
			continue;
		}
		const apiKey = provider.apiKey;
		let apiKeyEnv: string;
		if (apiKey !== undefined && apiKey.kind === "env" && apiKey.variable !== undefined) {
			apiKeyEnv = apiKey.variable;
		} else if (apiKey !== undefined && apiKey.kind === "command") {
			apiKeyEnv = `${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		} else if (apiKey !== undefined && apiKey.kind === "template") {
			const variables = apiKey.variables ?? [];
			skip(
				provider,
				`its key reference is a template (${summarizeNames(variables) === "" ? "no variable names" : `using ${summarizeNames(variables)}`}) — the substitution is the source's own, ` +
					"and this build's entry holds one environment variable name, not a pattern — set the key up by hand",
			);
			continue;
		} else {
			skip(
				provider,
				"no key reference this build can carry — its sign-in lanes are not read here, and an entry with no readable key reference would be registered without one and fail " +
					"at first use",
			);
			continue;
		}
		const problem = urlCredentialProblem(provider.baseURL);
		if (problem !== null) {
			skip(
				provider,
				`its base URL carries a credential (${problem}) — the URL was not imported. Put the credential in the environment and register the provider by hand`,
				true,
			);
			continue;
		}
		const notes: string[] = [];
		if (apiKey?.kind === "command") {
			notes.push(
				`its key comes from a command, which this build does not run to resolve a credential — the variable name ${apiKeyEnv} was synthesized, and the key has to be put into ` +
					"the environment under it before the provider works",
			);
		}
		if (provider.api === "openai-responses" || provider.api === "anthropic-messages") {
			notes.push(
				`its wire protocol is \`${provider.api}\`, and this build's openaiCompatible providers speak chat completions — the entry was registered as one, so a server that only ` +
					"speaks the other protocol will fail at first use",
			);
		}
		if (provider.apiSource === "npm") {
			notes.push(
				`the wire protocol was decided by its \`npm\` package (${provider.npm ?? "an unnamed one"}), which this build does not install — only the protocol it stood for was read`,
			);
		}
		if (provider.hasHeaders === true) {
			notes.push("its header block was not carried — header names and values were not read");
		}
		let modelNotes = 0;
		for (const model of provider.models) {
			if (model.reasoningEfforts !== undefined && model.reasoningEfforts.length > 0) modelNotes += 1;
			if ((model.droppedReasoningEfforts ?? 0) > 0) modelNotes += 1;
			if (model.hasOptions === true) modelNotes += 1;
			if (model.api !== undefined || model.baseURL !== undefined) modelNotes += 1;
			if (model.cost !== undefined && !(typeof model.cost.input === "number" && typeof model.cost.output === "number"))
				modelNotes += 1;
		}
		if (modelNotes > 0) {
			notes.push(
				`${modelNotes} model field(s) had no destination (a reasoning-effort list, per-model options, a per-model endpoint or a partial price) — the models were registered ` +
					"without them",
			);
		}
		openaiCompatible.push({
			id: provider.id,
			baseUrl: provider.baseURL,
			apiKeyEnv,
			models: provider.models.map((model) => commandCodeModelSpec(model)),
		});
		items.push({
			source: SOURCE,
			from: `${providersLabel} → ${provider.id}`,
			to: `settings.json → providers.openaiCompatible[${provider.id}]`,
			action: notes.length > 0 ? "downgrade" : "map",
			detail:
				notes.length > 0
					? `${provider.models.length} model(s) registered — ${notes.join("; ")}`
					: `${provider.models.length} model(s) registered, the key read as the environment variable name it was`,
			containsSecret: false,
		});
	}
	// One call for the whole set: the merge reads what the target already has and
	// writes the accumulated list in one assignment, so a per-provider call would
	// overwrite the previous provider's contribution.
	mergeProviderSpecs(
		SOURCE,
		openaiCompatible,
		(id) => `${providersLabel} → ${id}`,
		items,
		settingsPatch,
		existing,
		force,
	);
}

// ---------------------------------------------------------------------------
// Assets and leftovers
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Skills, agents, commands and the memory file, through the shared tree planner. */
function planCommandCodeAssets(
	raw: RawCommandCode,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	planAssetTrees(
		SOURCE,
		{ skills: raw.assets, agents: raw.agents, memory: raw.memory, commands: raw.commands },
		raw.home,
		force,
		items,
		writes,
	);
	const renamed = raw.commands.files.filter(
		(file) => file.name !== basename(file.sourcePath).replace(/\.[^.]*$/, ""),
	).length;
	if (renamed > 0) {
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, commandCodeCommandsDir(raw.root)),
			to: "—",
			action: "map",
			detail:
				`${renamed} command(s) land under a different name than their file name: a command file inside a directory becomes one skill whose name joins the directories with ` +
				"dashes (`git/commit.md` becomes `git-commit`)",
			containsSecret: false,
		});
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Everything the reader saw and this importer will not carry, each with the reason the user is owed. */
function planCommandCodeLeftovers(raw: RawCommandCode, items: MigrationItem[]): void {
	const settingsLabel = tildePath(raw.home, raw.settingsPath);
	const legacyLabel = tildePath(raw.home, raw.legacyConfigPath);
	if (raw.settingsProblem !== null) {
		items.push({
			source: SOURCE,
			from: settingsLabel,
			to: "—",
			action: "skip",
			detail: raw.settingsProblem,
			containsSecret: false,
		});
	}
	if (raw.legacyProblem !== null) {
		items.push({
			source: SOURCE,
			from: legacyLabel,
			to: "—",
			action: "skip",
			detail: raw.legacyProblem,
			containsSecret: false,
		});
	}
	const recognizedLegacy = COMMAND_CODE_LEGACY_CONFIG_KEYS.filter(
		(key) => raw.legacyKeys.includes(key) && key !== "model" && key !== "theme",
	);
	if (recognizedLegacy.length > 0) {
		items.push({
			source: SOURCE,
			from: `${legacyLabel} → ${summarizeNames(recognizedLegacy)}`,
			to: "—",
			action: "skip",
			detail:
				`${recognizedLegacy.length} key(s) the source's own reader passes on that have no destination here — \`model\` and \`theme\` are the two of its eight that this importer ` +
				"can carry, and the rest were read and left",
			containsSecret: false,
		});
	}
	if (raw.legacyUnhandledKeys.length > 0) {
		items.push({
			source: SOURCE,
			from: `${legacyLabel} → ${summarizeNames(raw.legacyUnhandledKeys, 8)}`,
			to: "—",
			action: "skip",
			detail:
				`${raw.legacyUnhandledKeys.length} key(s) of the legacy file outside the eight its own reader recognizes were not read. The names are the report; nothing under them ` +
				"was opened",
			containsSecret: false,
		});
	}
	if (raw.unhandledSettings.length > 0) {
		items.push({
			source: SOURCE,
			from: settingsLabel,
			to: "—",
			action: "skip",
			detail:
				`${raw.unhandledSettings.length} top-level key(s) of settings.json were not read (${summarizeNames(raw.unhandledSettings, 8)}). The names are the report; nothing under ` +
				"them was opened, and a key holding a credential is named here, not copied",
			containsSecret: false,
		});
	}
	if (raw.passedOverSettings.length > 0) {
		items.push({
			source: SOURCE,
			from: settingsLabel,
			to: "—",
			action: "skip",
			detail:
				`${raw.passedOverSettings.length} setting(s) this importer recognizes and deliberately leaves: ${summarizeNames(raw.passedOverSettings, 10)}. Skill behaviour, ` +
				"compact-mode and taste preferences, per-task model overrides — each is named so the report says they were understood, not missed",
			containsSecret: false,
		});
	}
	if (raw.otherChannelConfigs.length > 0) {
		items.push({
			source: SOURCE,
			from: summarizeNames([...raw.otherChannelConfigs], 8),
			to: "—",
			action: "skip",
			detail:
				"configuration files for release channels other than the released one. Named, not read: a released build reads config.json and never these",
			containsSecret: false,
		});
	}
	if (raw.credentialFiles.length > 0) {
		items.push({
			source: SOURCE,
			from: `~/.commandcode → ${summarizeNames([...raw.credentialFiles], 8)}`,
			to: "—",
			action: "skip",
			detail:
				"credential store(s) that are on disk, by name only — this importer checked that the files are there and never opened them, so no token, key or account was read. " +
				"The account those keys belong to was not read either",
			containsSecret: false,
		});
	}
	for (const entry of raw.skipped) {
		items.push({
			source: SOURCE,
			from: entry.name,
			to: "—",
			action: "skip",
			detail: entry.reason,
			containsSecret: false,
		});
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Assemble the plan. There is no `claimEnv`: every configuration value the source holds with a credential is a reference, and references are read, not moved. */
export function planCommandCode(
	raw: RawCommandCode,
	items: MigrationItem[],
	writes: PlannedWrite[],
	claimScalar: ClaimScalar,
	claimModePair: ClaimModePair,
	claimPermissionList: ClaimPermissionList,
	claimHooks: ClaimHooks,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	force: boolean,
): void {
	planCommandCodeSettings(raw, items, claimScalar);
	planCommandCodeMode(raw, items, claimModePair);
	planCommandCodeRuleList(raw, "allow", items, claimPermissionList);
	planCommandCodeRuleList(raw, "deny", items, claimPermissionList);
	planCommandCodeOtherPermissions(raw, items, claimPermissionList);
	planCommandCodeHooks(raw, items, claimHooks, existing, force);
	planCommandCodeMcp(raw, items, mcpServers, markMcpSecret, existingMcpServers, force);
	planCommandCodeProviders(raw, items, settingsPatch, existing, force);
	planCommandCodeAssets(raw, force, items, writes);
	planCommandCodeLeftovers(raw, items);
}
