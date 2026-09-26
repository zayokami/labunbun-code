/**
 * Cursor's configuration in the target's shape: rules, MCP servers, permission
 * lists, hooks, and everything this importer found and will not carry.
 *
 * Read `cursor-read.ts` and `cursor-home.ts` first — this file is only about
 * *translation*, and every one of its decisions is a statement about the target's
 * grammar rather than about where Cursor keeps things.
 *
 * Four translations, none of them obvious, and all four of them reported:
 *
 *  1. **`.mdc` rules are a downgrade** because this build's `collectRules` is
 *    flat: no recursion, no globs, no frontmatter parsing. The frontmatter is
 *    therefore carried over **byte for byte** at the head of the imported file,
 *    which is strictly better than stripping it — the model reads the globs as
 *    prose, so nothing is destroyed — and what is lost is named: the
 *    *activation*. A rule Cursor attaches to matching files, or attaches only
 *    when the model asks for it, becomes a rule that is always in context.
 *  2. **Flattening collides, and a collision is reported by name.** Two
 *    subdirectories can each hold `style.mdc`; the target's rules directory has
 *    no subdirectories, so one of them would be silently lost. The first is kept
 *    and the second is named, exactly as `mergeProviderSpecs` treats a provider
 *    id — the thing that survives is a choice somebody made, and the thing that
 *    does not is a fact the user is owed.
 *  3. **A specifier this build cannot evaluate is a skip, not a widening.**
 *    `WebFetch(docs.example.com)` is a real rule in Cursor and a rule that can
 *    never match here: `inputMatchesSpecifier` evaluates a specifier only for
 *    `Bash`, the four file tools and `mcp__*`, and answers `false` for
 *    everything else. Importing it as an allow would turn "this one domain" into
 *    "this tool, unconstrained" — the exact opposite of what the file says — so
 *    it is named instead. Bare tool names are carried: a bare rule matches by
 *    name alone, so its shape survives even when this build has no such tool.
 *  4. **The two MCP documents do not share a target.** This run writes one MCP
 *    file, `~/.labunbun/.mcp.json`. Cursor's project document belongs in
 *    `<cwd>/.mcp.json`, which is the repository's own file and is not something
 *    an import should rewrite, so its servers are named with the path to put
 *    them in — the same treatment the `claude-code` source gives its local-scope
 *    servers, for the same reason.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import type { CursorDocument, RawCursor } from "./cursor-read.ts";
import { HooksConfigSchema } from "./hooks.ts";
import {
	isRecord,
	MAX_HOOK_TIMEOUT_MS,
	normalizeClaudeHooks,
	placeholderNote,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
} from "./migrate-core.ts";
import {
	type ClaimHooks,
	type ClaimPermissionList,
	type ClaimScalar,
	looksLikeSecretName,
	type MigrationItem,
	type PlannedWrite,
	resolveModelReference,
} from "./migrate-types.ts";

/** Keys of `hooks.json` this importer accounts for; the rest is named. */
const CURSOR_HOOKS_HANDLED = new Set(["version", "hooks"]);

/**
 * The `version` Cursor writes into `hooks.json`.
 *
 * Read but not trusted: a hooks file for a schema this build does not know how
 * to interpret is named rather than half-applied. `1` is the value the official
 * documentation gives, and it is the only one observed.
 */
const CURSOR_HOOKS_VERSION = 1;

/**
 * The tools whose specifiers this build actually evaluates.
 *
 * Read off `inputMatchesSpecifier`, and the exclusion is the point: its `default:`
 * branch answers `false` for any tool that is neither `Bash`, one of the four
 * file tools, nor an `mcp__` server. A `WebFetch(…)` rule written here would
 * parse, validate, be written to the file and never match — and because the
 * parser accepts it, nothing downstream would ever say so.
 */
const CURSOR_SPECIFIER_TOOLS: ReadonlySet<string> = new Set(["Bash", "Read", "Edit", "Write", "NotebookEdit"]);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * What the frontmatter of one rule says, read without a YAML parser.
 *
 * A parser would be the wrong tool here for a reason worth stating: the point of
 * carrying the frontmatter over verbatim is that nothing parses it on the way, and
 * on the way *back* out (a user editing the imported file) a half-correct parse
 * would be a second, disagreeing source of truth. Three keys are read out of the
 * text for the report, and only three, because only three change what the report
 * says.
 */
function readRuleActivation(content: string): { alwaysApply: boolean | undefined; globs: string | undefined } {
	const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!front) return { alwaysApply: undefined, globs: undefined };
	const body = front[1];
	const always = /^[ \t]*alwaysApply[ \t]*:[ \t]*(\S+)/m.exec(body);
	const globs = /^[ \t]*globs[ \t]*:[ \t]*(.+)$/m.exec(body);
	return {
		alwaysApply: always
			? always[1]
					.trim()
					.replace(/^["']|["']$/g, "")
					.toLowerCase() === "true"
			: undefined,
		// Written as a comma-delimited *string* by Cursor, not as a YAML list, which
		// is the detail that makes a naive parse produce a string where an array
		// was expected. Kept as written and quoted in the report.
		globs: globs ? globs[1].trim().replace(/^["']|["']$/g, "") : undefined,
	};
}

/**
 * Cursor's rules become rule files: one write each, and the loss named.
 *
 * `alwaysApply: true` is the one activation that survives verbatim — a flat rule
 * directory *is* "always in context", which is the same statement — and it is the
 * only case scored `map`. Everything else is a `downgrade`, because a rule that
 * Cursor attaches to matching files or holds back until the model asks for it is
 * a rule this build would put in front of the model unconditionally.
 */
function planCursorRules(
	raw: RawCursor,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	const taken = new Set<string>();
	for (const rule of raw.rules) {
		const from = tildePath(home, rule.sourcePath);
		const path = join(home, ".labunbun", "rules", `${rule.name}.md`);
		// A second `style.mdc` under a different subdirectory arrives with the same
		// name as the first. The first is kept and the second is named, because the
		// alternative — writing both and letting the second overwrite the first — is
		// a report that claims two imports and produced one file.
		if (taken.has(rule.name)) {
			items.push({
				source: "cursor",
				from,
				to: "—",
				action: "skip",
				detail: `another rule in this run is already named "${rule.name}", and the rules directory here is flat: cursor's subdirectories have no equivalent, so importing this one would overwrite the other — kept the first`,
				containsSecret: false,
			});
			continue;
		}
		if (existsSync(path) && !force) {
			items.push({
				source: "cursor",
				from,
				to: "—",
				action: "skip",
				detail: "target rule file already exists — kept (use --force to overwrite)",
				containsSecret: false,
			});
			continue;
		}
		taken.add(rule.name);
		const { alwaysApply, globs } = readRuleActivation(rule.content);
		const losses: string[] = [];
		if (globs) {
			losses.push(
				`cursor attaches this only for files matching its globs ("${globs}"), and there is no glob-aware rule directory here — the file text is carried over unchanged, so the model can still read which files it was written for`,
			);
		}
		if (alwaysApply !== true) {
			losses.push(
				alwaysApply === false
					? "cursor holds this back until the model asks for it (alwaysApply: false); here it is loaded with the other rules"
					: "cursor attaches this by its description when the model judges it relevant; here it is loaded with the other rules",
			);
		}
		if (rule.notLoaded) losses.push(rule.notLoaded);
		const scope = rule.scope === "project" ? "the project's rules" : "your user rules";
		writes.push({ path, kind: "rule", content: rule.content, containsSecret: false });
		items.push({
			source: "cursor",
			from,
			to: tildePath(home, path),
			action: losses.length > 0 ? "downgrade" : "map",
			detail:
				losses.length > 0
					? `imported from ${scope} with its frontmatter intact, but ${losses.join("; ")}`
					: `imported from ${scope} with its frontmatter intact; it applies always, which is what it did in cursor too`,
			containsSecret: false,
		});
	}
}

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

/**
 * Cursor's `Bash(cmd:*)` prefix spelling → the anchored wildcard written here.
 *
 * Cursor separates the command word from its arguments with a colon; this build
 * has one anchored wildcard over the whole command line, so `git:*` is `git*`
 * here. Two consequences, both stated in the report rather than left for the
 * user to discover: the match is anchored (so `git*` is the whole line, not a
 * prefix of it), and it is a translation rather than a copy.
 */
function translateCursorPermissionRule(rule: string): { text: string; note?: string } {
	const open = rule.indexOf("(");
	if (!rule.endsWith(")") || open < 0) return { text: rule };
	const tool = rule.slice(0, open).trim();
	const spec = rule.slice(open + 1, -1).trim();
	if (tool !== "Bash" || !spec.includes(":")) return { text: rule };
	const prefix = spec.slice(0, spec.lastIndexOf(":")).trim();
	if (!prefix) return { text: rule };
	return {
		text: `Bash(${prefix}*)`,
		note: `cursor writes command prefixes as "${spec}"; this build matches the whole command line with one wildcard, so it becomes "${prefix}*"`,
	};
}

/** One permission entry, split into the part that survives and the part that does not. */
interface TranslatedPermissions {
	kept: string[];
	/** Rules named with the reason each cannot be expressed here. */
	lost: Array<{ rule: string; reason: string }>;
	/** Notes about rules that came across in another shape. */
	notes: string[];
}

function translateCursorPermissions(rules: string[]): TranslatedPermissions {
	const kept: string[] = [];
	const lost: TranslatedPermissions["lost"] = [];
	const notes: string[] = [];
	for (const rule of rules) {
		const open = rule.indexOf("(");
		const hasSpecifier = rule.endsWith(")") && open >= 0;
		const tool = (hasSpecifier ? rule.slice(0, open) : rule).trim();
		if (hasSpecifier && !CURSOR_SPECIFIER_TOOLS.has(tool) && !tool.startsWith("mcp__")) {
			lost.push({
				rule,
				reason: `a specifier on ${tool} cannot be evaluated here: this build matches a specifier only for Bash, the file tools and mcp servers, and answers "no match" for everything else — carried as a plain allow it would cover the whole tool, which is wider than what cursor said`,
			});
			continue;
		}
		const { text, note } = translateCursorPermissionRule(rule);
		if (note) notes.push(note);
		kept.push(text);
	}
	return { kept, lost, notes };
}

/**
 * `permissions.allow` / `permissions.deny` from one of the CLI's two files.
 *
 * Both files are read and kept apart in the report, because they are not two
 * scopes of one list: the project file is documented as permissions-only, and
 * this build's `additionalDirectories` is the one entry of Cursor's set with no
 * equivalent — it is a session scope, and the session it referred to is not the
 * session these rules land in.
 */
function planCursorPermissions(
	raw: RawCursor,
	home: string,
	items: MigrationItem[],
	claimPermissionList: ClaimPermissionList,
): void {
	const files: Array<[string, CursorDocument, string]> = [
		["~/.cursor/cli-config.json", raw.cli.global, "the CLI's global configuration"],
		[tildePath(home, join(raw.roots.project, "cli.json")), raw.cli.project, "the project's CLI file"],
	];
	for (const [file, doc, what] of files) {
		if (doc.kind !== "document") continue;
		const permissions = doc.value.permissions;
		if (permissions === undefined) continue;
		const from = `${file} → permissions`;
		if (!isRecord(permissions)) {
			items.push({
				source: "cursor",
				from,
				to: "—",
				action: "skip",
				detail: `${what} holds a "permissions" value that is not an object — nothing could be read out of it`,
				containsSecret: false,
			});
			continue;
		}
		for (const behavior of ["allow", "deny"] as const) {
			const list = permissions[behavior];
			if (!Array.isArray(list)) continue;
			const rules = list.filter((rule): rule is string => typeof rule === "string" && rule.trim() !== "");
			if (rules.length === 0) continue;
			const { kept, lost, notes } = translateCursorPermissions(rules);
			if (kept.length > 0) {
				claimPermissionList(
					"cursor",
					behavior,
					kept,
					`${from}.${behavior}`,
					`${kept.length} of ${rules.length} rule(s) copied; a Bash rule matches the whole command line here, so a chained command counts as a match too${
						notes.length > 0 ? `; ${summarizeNames([...new Set(notes)])}` : ""
					}`,
					notes.length > 0 || lost.length > 0 ? "downgrade" : "map",
				);
			} else if (lost.length > 0) {
				// The rule names are in this sentence too, not only in the mixed case
				// below. A list where nothing came across is the case a user most
				// needs to read the rules back from the report against, and a count
				// with a reason and no names does not let them do that.
				items.push({
					source: "cursor",
					from: `${from}.${behavior}`,
					to: "—",
					action: "skip",
					detail: `none of the ${rules.length} rule(s) can be expressed here — ${summarizeNames(
						lost.map((entry) => entry.rule),
					)}: ${lost[0].reason}`,
					containsSecret: false,
				});
			}
			if (lost.length > 0) {
				items.push({
					source: "cursor",
					from: `${from}.${behavior}`,
					to: "—",
					action: "skip",
					detail: `${lost.length} of ${rules.length} rule(s) did not come across: ${summarizeNames(
						lost.map((entry) => entry.rule),
					)} — ${lost[0].reason}`,
					containsSecret: false,
				});
			}
		}
		for (const key of Object.keys(permissions)) {
			if (key === "allow" || key === "deny") continue;
			items.push({
				source: "cursor",
				from: `${from}.${key}`,
				to: "—",
				action: "skip",
				detail:
					key === "additionalDirectories"
						? "extra directories cursor searched: that is a session setting here too, and this import configures the next one, not a session already in progress"
						: `no permission list here has a "${key}" entry — this build's set is allow, deny and additionalDirectories, and the report does not claim a list it did not find`,
				containsSecret: false,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Cursor's flat hook entries → the shape {@link normalizeClaudeHooks} reads.
 *
 * Cursor writes `[{ "command": "…" }]` where the shared schema wants
 * `{ hooks: [{ type: "command", command }] }`, so an adapter is unavoidable and
 * the question is only what happens to an entry it cannot read. Those are
 * counted, not dropped: a hooks file where a third of the entries are
 * unrecognised is a fact about the source, and a migration that silently kept
 * two thirds of it is the defect this repo's report shape exists to prevent.
 */
function cursorHookEntries(value: unknown): {
	hooks: Record<string, unknown> | undefined;
	malformed: number;
	noCommand: number;
} {
	if (!isRecord(value)) return { hooks: undefined, malformed: value === undefined ? 0 : 1, noCommand: 0 };
	const malformed = typeof value.malformed === "number" ? value.malformed : 0;
	if (value.hooks === undefined) return { hooks: undefined, malformed, noCommand: 0 };
	if (!isRecord(value.hooks)) return { hooks: undefined, malformed: malformed + 1, noCommand: 0 };
	const events: Record<string, unknown> = {};
	// A flat entry with no command has nothing to run, and the `flatMap` below
	// throws it away. It used to go uncounted, which is the one thing this
	// function's own comment promises not to do: a hooks file where half the
	// entries are `{ type: "prompt" }` reported as half the file imported, with
	// nothing anywhere saying the other half stayed behind.
	let noCommand = 0;
	for (const [event, entries] of Object.entries(value.hooks)) {
		if (!Array.isArray(entries)) {
			events[event] = [];
			continue;
		}
		events[event] = entries.flatMap((entry) => {
			if (!isRecord(entry) || typeof entry.command !== "string" || entry.command.trim() === "") {
				noCommand += 1;
				return [];
			}
			const handler: Record<string, unknown> = { type: "command", command: entry.command };
			// Cursor writes its timeout in seconds, the same as Claude Code does and
			// for the same reason the seconds conversion lives in the shared
			// normalizer: putting a bare `timeout` here would read 30 as 30 ms.
			if (typeof entry.timeout === "number" && Number.isFinite(entry.timeout)) handler.timeout = entry.timeout;
			return [{ hooks: [handler] }];
		});
	}
	return { hooks: events, malformed, noCommand };
}

function planCursorHooks(raw: RawCursor, home: string, items: MigrationItem[], claimHooks: ClaimHooks): void {
	const files: Array<[string, CursorDocument]> = [
		["~/.cursor/hooks.json", raw.hooks.global],
		[tildePath(home, join(raw.roots.project, "hooks.json")), raw.hooks.project],
	];
	for (const [file, doc] of files) {
		if (doc.kind !== "document") continue;
		const from = `${file} → hooks`;
		if (doc.value.version !== undefined && doc.value.version !== CURSOR_HOOKS_VERSION) {
			items.push({
				source: "cursor",
				from: `${file} → version`,
				to: "—",
				action: "skip",
				detail: `hooks written for a schema version this importer cannot interpret (${JSON.stringify(doc.value.version)}; the documented one is ${CURSOR_HOOKS_VERSION}) — nothing from this file was applied`,
				containsSecret: false,
			});
			continue;
		}
		const { hooks, malformed, noCommand } = cursorHookEntries(doc.value);
		if (hooks === undefined) {
			if (malformed > 0) {
				items.push({
					source: "cursor",
					from,
					to: "—",
					action: "skip",
					detail: 'this file has a "hooks" key this importer could not read, and none of its hooks are applied',
					containsSecret: false,
				});
			}
			reportUnhandledKeys("cursor", doc.value, CURSOR_HOOKS_HANDLED, file, items);
			continue;
		}
		const normalized = normalizeClaudeHooks(hooks);
		const losses: string[] = [];
		if (malformed > 0) losses.push(`${malformed} entr(ies) not in the shape cursor writes hooks in`);
		if (noCommand > 0)
			losses.push(`${noCommand} entr(ies) with no command in them, so there is nothing here that could fire`);
		if (normalized.droppedEvents.length > 0) {
			losses.push(
				`${normalized.droppedEvents.length} cursor event(s) with no event here (${summarizeNames(
					normalized.droppedEvents,
				)}) — a hook under one of those would never fire`,
			);
		}
		if (normalized.droppedHandlers > 0)
			losses.push(`${normalized.droppedHandlers} handler(s) that are not shell commands`);
		if (normalized.droppedMatchers.length > 0) {
			losses.push(`${normalized.droppedMatchers.length} matcher(s) using pattern characters this build escapes`);
		}
		if (normalized.malformed > 0) losses.push(`${normalized.malformed} entr(ies) not in the hook shape`);
		if (normalized.clampedTimeouts > 0) {
			losses.push(
				`${normalized.clampedTimeouts} timeout(s) longer than the ${MAX_HOOK_TIMEOUT_MS / 1000} s this build waits`,
			);
		}
		const events = Object.keys(normalized.config);
		if (events.length === 0) {
			if (losses.length > 0) {
				items.push({
					source: "cursor",
					from,
					to: "—",
					action: "skip",
					detail: `nothing here would run: ${losses.join("; ")}`,
					containsSecret: false,
				});
			} else if (Object.keys(hooks).length === 0) {
				items.push({
					source: "cursor",
					from,
					to: "—",
					action: "skip",
					detail: "an empty hooks block is not a hook file with nothing runnable; it is nothing",
					containsSecret: false,
				});
			}
			continue;
		}
		if (!HooksConfigSchema.safeParse(normalized.config).success) {
			items.push({
				source: "cursor",
				from,
				to: "—",
				action: "skip",
				detail: "hooks are not in a shape this build accepts, even after rewriting",
				containsSecret: false,
			});
			continue;
		}
		const entries = events.reduce((count, event) => count + normalized.config[event].length, 0);
		claimHooks(
			"cursor",
			normalized.config,
			from,
			`${entries} hook(s) over ${events.length} event(s)${
				normalized.convertedTimeouts > 0
					? `; ${normalized.convertedTimeouts} timeout(s) converted from the seconds cursor writes to milliseconds here`
					: ""
			}${losses.length > 0 ? `; not carried: ${losses.join("; ")}` : ""}`,
			losses.length > 0 ? "downgrade" : "map",
		);
		reportUnhandledKeys("cursor", doc.value, CURSOR_HOOKS_HANDLED, file, items);
	}
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

function planCursorMcp(
	raw: RawCursor,
	home: string,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	for (const doc of raw.mcp) {
		const global = doc.path === join(raw.roots.user, "mcp.json");
		const from = `${tildePath(home, doc.path)} → mcpServers`;
		if (doc.unreadable) {
			items.push({
				source: "cursor",
				from: tildePath(home, doc.path),
				to: "—",
				action: "skip",
				detail: "the file is there but is not a JSON object, so no server could be read out of it",
				containsSecret: false,
			});
			continue;
		}
		if (doc.malformed) {
			items.push({
				source: "cursor",
				from: `${tildePath(home, doc.path)} → mcpServers`,
				to: "—",
				action: "skip",
				detail: 'the file parses, but its "mcpServers" is not a table of servers',
				containsSecret: false,
			});
			continue;
		}
		const names = Object.keys(doc.servers);
		if (names.length === 0) continue;
		if (!global) {
			// This run writes one MCP file and it is the global one. A project's
			// servers belong in the repository's own file, which is not something an
			// import should rewrite — so they are named, with the path that would
			// carry them.
			items.push({
				source: "cursor",
				from: `${tildePath(home, doc.path)} → mcpServers`,
				to: "—",
				action: "skip",
				detail: `project-scope server(s) ${summarizeNames(names)}: this import writes the global file only — copy them into <cwd>/.mcp.json to keep them with the repository, or into ~/.labunbun/.mcp.json to have them everywhere`,
				containsSecret: false,
			});
			continue;
		}
		for (const name of names) {
			const config = doc.servers[name];
			const parsed = McpServerConfigSchema.safeParse(config);
			if (!parsed.success) {
				items.push({
					source: "cursor",
					from: `${from}.${name}`,
					to: "—",
					action: "skip",
					detail: "server definition does not match the supported stdio/http shapes",
					containsSecret: false,
				});
				continue;
			}
			if (name in existingMcpServers && !force) {
				items.push({
					source: "cursor",
					from: `${from}.${name}`,
					to: "—",
					action: "skip",
					detail: "target already defines a server with this name — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			const record = config as { headers?: Record<string, string>; env?: Record<string, string> };
			const secret =
				Object.keys(record.headers ?? {}).length > 0 ||
				Object.keys(record.env ?? {}).some((key) => looksLikeSecretName(key));
			// Cursor writes environment references as `${env:NAME}`; the shared
			// placeholder reader only recognises the bare `${NAME}` form, so the
			// colon spelling is named here rather than passed through as text that
			// would be expanded by nothing.
			const envPlaceholders = Object.values(record.env ?? {}).flatMap((value) =>
				[...String(value).matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => `\${env:${match[1]}}`),
			);
			const placeholder = placeholderNote(config as Record<string, unknown>);
			const placeholders = [
				...(placeholder ? [placeholder] : []),
				...(envPlaceholders.length > 0
					? [`${[...new Set(envPlaceholders)].join(", ")} is not expanded here — replace it with the value itself`]
					: []),
			];
			mcpServers[name] = config;
			markMcpSecret(secret);
			const copied = secret ? "copied verbatim, including credential headers" : "copied verbatim";
			items.push({
				source: "cursor",
				from: `${from}.${name}`,
				to: `~/.labunbun/.mcp.json → mcpServers.${name}`,
				action: placeholders.length > 0 ? "downgrade" : "map",
				detail: placeholders.length > 0 ? `${copied} — ${placeholders.join("; ")}` : copied,
				containsSecret: secret,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// What is left behind
// ---------------------------------------------------------------------------

/**
 * Entries the reader found and nothing imports, each with a reason.
 *
 * The well-known ones get their own sentence because the generic one would be
 * useless for them: `permissions.json` is a file a Cursor user is certain is
 * their permission configuration, and it is not — it is the IDE's, and this
 * importer read the CLI's instead. Saying "no mapping for permissions.json"
 * would be technically true and practically misleading.
 */
const CURSOR_OTHER_ENTRY_REASONS: Readonly<Record<string, string>> = {
	"permissions.json":
		"the IDE's permission list, which the cursor CLI neither reads nor applies — the CLI's own permissions were read from cli-config.json instead, and a migration that imported this one would import the list that was never in effect",
	"extensions.json": "installed editor extensions, which are the editor's own and have no equivalent in an agent",
};

function planCursorLeftovers(raw: RawCursor, home: string, items: MigrationItem[]): void {
	for (const [label, entries] of [
		["~/.cursor", raw.otherUserFiles],
		["<project>/.cursor", raw.otherProjectEntries],
	] as const) {
		if (entries.length === 0) continue;
		items.push({
			source: "cursor",
			from: label,
			to: "—",
			action: "skip",
			detail: `${entries.length} entr(ies) this importer reads nothing out of: ${summarizeNames(
				entries.map((name) =>
					CURSOR_OTHER_ENTRY_REASONS[name] ? `${name} (${CURSOR_OTHER_ENTRY_REASONS[name]})` : name,
				),
			)}`,
			containsSecret: false,
		});
	}
	if (raw.ignored.length > 0) {
		const byReason = new Map<string, string[]>();
		for (const file of raw.ignored) {
			const list = byReason.get(file.reason) ?? [];
			list.push(tildePath(home, file.path));
			byReason.set(file.reason, list);
		}
		for (const [reason, paths] of byReason) {
			items.push({
				source: "cursor",
				from: "<project>/.cursor/rules and ~/.cursor/rules",
				to: "—",
				action: "skip",
				detail: `${paths.length} file(s) not imported — ${reason}: ${summarizeNames(paths)}`,
				containsSecret: false,
			});
		}
	}
	// The databases are the one part of a Cursor install a reader might expect to
	// find in a transcript, so the reason is spelled out rather than left as a
	// count. A chat here is an editor state record, not a conversation, and the key
	// it is stored under cannot be recomputed from the folder path.
	if (raw.stateDatabases.length > 0) {
		const workspaces = raw.stateDatabases.filter((db) => db.kind === "workspace").length;
		items.push({
			source: "cursor",
			from: "cursor's editor storage",
			to: "—",
			action: "skip",
			detail: `${raw.stateDatabases.length} state database(s) (${workspaces} workspace, ${raw.stateDatabases.length - workspaces} global) opened by name only, never read: cursor is a vs code fork, so a chat is an editor state record rather than a transcript, and the workspace key it is filed under mixes in the folder's creation time and cannot be recomputed from the path`,
			containsSecret: false,
		});
	}
}

/** Keys of `cli-config.json` this importer accounts for; the rest is named. */
const CURSOR_CLI_CONFIG_HANDLED = new Set([
	"permissions",
	"model",
	"approvalMode",
	"sandbox",
	"network",
	"outputFormat",
	"terminal",
]);

/** Keys of the project `cli.json`; the documented set is permissions only. */
const CURSOR_CLI_PROJECT_HANDLED = new Set(["permissions"]);

/** Cursor's `approvalMode` → this build's permission mode. */
const CURSOR_APPROVAL_MODES: Record<string, string> = {
	// Cursor asks before each tool the rules do not already cover.
	ask: "default",
	// Everything not denied runs. Not `bypassPermissions`: that name would claim
	// the sandbox is off too, and this is a different promise.
	auto: "acceptEdits",
	// Reads run, writes are asked about. `acceptEdits` is the nearest thing here
	// and is narrower than cursor's, which is why this one is scored as a downgrade
	// at the call site below.
	yolo: "bypassPermissions",
};

export function planCursor(
	raw: RawCursor,
	home: string,
	items: MigrationItem[],
	writes: PlannedWrite[],
	claimScalar: ClaimScalar,
	claimPermissionList: ClaimPermissionList,
	claimHooks: ClaimHooks,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	planCursorRules(raw, home, force, items, writes);
	planCursorMcp(raw, home, items, mcpServers, markMcpSecret, existingMcpServers, force);
	planCursorPermissions(raw, home, items, claimPermissionList);
	planCursorHooks(raw, home, items, claimHooks);

	// The model. Cursor's CLI takes a model *name*; whether it is one this build
	// can resolve is checked against the registry rather than copied on the
	// assumption that it can, and an unresolvable name is a skip.
	if (raw.cli.global.kind === "document" && typeof raw.cli.global.value.model === "string") {
		const value = raw.cli.global.value.model.trim();
		if (value) {
			const resolved = resolveModelReference(value);
			if (resolved) {
				claimScalar(
					"cursor",
					"model",
					resolved,
					`~/.cursor/cli-config.json → model ("${value}")`,
					`resolved to ${resolved}`,
				);
			} else {
				items.push({
					source: "cursor",
					from: `~/.cursor/cli-config.json → model ("${value}")`,
					to: "—",
					action: "skip",
					detail: "no model in the registry matches this name — set a model reference manually",
					containsSecret: false,
				});
			}
		}
	}
	if (raw.cli.global.kind === "document" && typeof raw.cli.global.value.approvalMode === "string") {
		const value = raw.cli.global.value.approvalMode.trim();
		const mapped = CURSOR_APPROVAL_MODES[value.toLowerCase()];
		if (mapped) {
			claimScalar(
				"cursor",
				"permissionMode",
				mapped,
				`~/.cursor/cli-config.json → approvalMode ("${value}")`,
				value.toLowerCase() === "auto"
					? `read "${mapped}" as the nearest mode: cursor approves any read and asks about a write, and this build asks about a write without granting the read`
					: `read as "${mapped}"`,
			);
		} else {
			items.push({
				source: "cursor",
				from: `~/.cursor/cli-config.json → approvalMode ("${value}")`,
				to: "—",
				action: "skip",
				detail:
					"no permission mode here corresponds to this value — the session keeps the mode it would otherwise start in",
				containsSecret: false,
			});
		}
	}
	for (const key of ["sandbox", "network"] as const) {
		if (raw.cli.global.kind !== "document" || raw.cli.global.value[key] === undefined) continue;
		items.push({
			source: "cursor",
			from: `~/.cursor/cli-config.json → ${key}`,
			to: "—",
			action: "skip",
			detail: `cursor's ${key} setting decides what its own process may reach; there is no equivalent here, and this build's permission rules govern tool calls rather than the process's own access`,
			containsSecret: false,
		});
	}
	if (raw.cli.global.kind === "document") {
		reportUnhandledKeys("cursor", raw.cli.global.value, CURSOR_CLI_CONFIG_HANDLED, "~/.cursor/cli-config.json", items);
	}
	if (raw.cli.project.kind === "document") {
		reportUnhandledKeys(
			"cursor",
			raw.cli.project.value,
			CURSOR_CLI_PROJECT_HANDLED,
			"<project>/.cursor/cli.json",
			items,
		);
	}
	planCursorLeftovers(raw, home, items);
}
