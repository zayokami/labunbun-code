/**
 * TRAE's configuration in the target's shape: rules, MCP servers, and everything
 * this importer found and will not carry.
 *
 * Smaller than its Cursor counterpart because TRAE exposes less to import, and
 * that is a fact about TRAE rather than a shortcut. There is no portable
 * provider configuration to read (the IDE is subscription-based and its model
 * list is editor state), no CLI permission list, and no hook system this build
 * could rewrite — so this file is rules, MCP, and the report of everything else.
 *
 * Two things here are TRAE-specific and neither is a detail:
 *
 *  1. **The rules are plain `.md` carrying Cursor's frontmatter.** TRAE's own
 *    documentation asserts the compatibility, so a `.trae/rules/project_rules.md`
 *    arrives with `alwaysApply`, `description` and `globs` at the head of it.
 *    The target's rule directory is flat and parses no frontmatter, so this is a
 *    `downgrade` for the same reason and by the same rule as Cursor's `.mdc`:
 *    the text is carried over untouched and the *activation* is what is lost.
 *  2. **A rule from a subdirectory is named, never imported.** TRAE reads a
 *    `.trae/rules` in any subdirectory and applies it to that subtree. A flat
 *    target directory cannot express "this subtree", and importing it anyway
 *    would apply a scoped instruction everywhere — the failure mode is not that
 *    something is missing but that something is *wrong*, which is worse and
 *    harder to notice.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { placeholderNote, summarizeNames, tildePath } from "./migrate-core.ts";
import { looksLikeSecretName, type MigrationItem, type PlannedWrite } from "./migrate-types.ts";
import type { RawTrae } from "./trae-read.ts";

/**
 * The frontmatter TRAE's rules carry, read without a parser.
 *
 * The same three keys Cursor's do, and the same reason for reading them by hand:
 * the frontmatter is carried over byte for byte precisely so that nothing on this
 * side of the migration interprets it, and the three values are read only to
 * decide which sentence the report prints.
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
		globs: globs ? globs[1].trim().replace(/^["']|["']$/g, "") : undefined,
	};
}

/**
 * TRAE's rules become rule files.
 *
 * `alwaysApply: true` is the one activation that survives verbatim — a flat rule
 * directory *is* "always in context" — and it is the only case scored `map`.
 * A name collision inside one source is handled the same way as across sources:
 * the first is kept, the second is named, and neither is silently dropped.
 */
function planTraeRules(
	raw: RawTrae,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	const taken = new Set<string>();
	for (const rule of raw.rules) {
		const from = tildePath(home, rule.sourcePath);
		const path = join(home, ".labunbun", "rules", `${rule.name}.md`);
		if (taken.has(rule.name)) {
			items.push({
				source: "trae",
				from,
				to: "—",
				action: "skip",
				detail: `another rule in this run is already named "${rule.name}", and the rules directory here is flat — kept the first`,
				containsSecret: false,
			});
			continue;
		}
		if (existsSync(path) && !force) {
			items.push({
				source: "trae",
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
				`trae attaches this only for files matching its globs ("${globs}"), and there is no glob-aware rule directory here — the file text is carried over unchanged, so the model can still read which files it was written for`,
			);
		}
		if (alwaysApply !== true) {
			losses.push(
				alwaysApply === false
					? "trae holds this back until the model asks for it (alwaysApply: false); here it is loaded with the other rules"
					: "trae attaches this by its description when the model judges it relevant; here it is loaded with the other rules",
			);
		}
		const scope = rule.scope === "project" ? "the project's rules" : "your user rules";
		writes.push({ path, kind: "rule", content: rule.content, containsSecret: false });
		items.push({
			source: "trae",
			from,
			to: tildePath(home, path),
			action: losses.length > 0 ? "downgrade" : "map",
			detail:
				losses.length > 0
					? `imported from ${scope} with its frontmatter intact, but ${losses.join("; ")}`
					: `imported from ${scope} with its frontmatter intact; it applies always, which is what it did in trae too`,
			containsSecret: false,
		});
	}
}

/**
 * The two `mcp.json` documents.
 *
 * The global one lands in the file this run writes; the project's does not, for
 * the reason every project's MCP document in this repo does not: the repository's
 * own file is not something an import should rewrite, so its servers are named
 * with the path that would carry them.
 */
function planTraeMcp(
	raw: RawTrae,
	home: string,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	for (const doc of raw.mcp) {
		const from = tildePath(home, doc.path);
		if (doc.unreadable) {
			items.push({
				source: "trae",
				from,
				to: "—",
				action: "skip",
				detail: "the file is there but is not a JSON object, so no server could be read out of it",
				containsSecret: false,
			});
			continue;
		}
		if (doc.malformed) {
			items.push({
				source: "trae",
				from: `${from} → mcpServers`,
				to: "—",
				action: "skip",
				detail: 'the file parses, but its "mcpServers" is not a table of servers',
				containsSecret: false,
			});
			continue;
		}
		const names = Object.keys(doc.servers);
		if (names.length === 0) continue;
		if (doc.scope === "project") {
			items.push({
				source: "trae",
				from: `${from} → mcpServers`,
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
					source: "trae",
					from: `${from} → mcpServers.${name}`,
					to: "—",
					action: "skip",
					detail: "server definition does not match the supported stdio/http shapes",
					containsSecret: false,
				});
				continue;
			}
			if (name in existingMcpServers && !force) {
				items.push({
					source: "trae",
					from: `${from} → mcpServers.${name}`,
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
			// TRAE writes environment references as `${env:NAME}`, which the shared
			// placeholder reader does not recognise — it matches a bare `${NAME}`. The
			// colon spelling is named here so a value that will never be expanded does
			// not arrive in the file as though it would.
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
				source: "trae",
				from: `${from} → mcpServers.${name}`,
				to: `~/.labunbun/.mcp.json → mcpServers.${name}`,
				action: placeholders.length > 0 ? "downgrade" : "map",
				detail: placeholders.length > 0 ? `${copied} — ${placeholders.join("; ")}` : copied,
				containsSecret: secret,
			});
		}
	}
}

/**
 * What was found and will not be carried, each with its reason.
 *
 * The databases are the entry most likely to be misread, so it is written out:
 * a chat in a VS Code fork is an editor state record rather than a transcript,
 * and there is a second, harder reason — the current build's chat payloads in
 * `state.vscdb` are reported to be encrypted, so even a reader willing to open
 * it would find nothing to carry.
 */
function planTraeLeftovers(raw: RawTrae, home: string, items: MigrationItem[]): void {
	const byReason = new Map<string, string[]>();
	for (const entry of raw.notImported) {
		const list = byReason.get(entry.reason) ?? [];
		list.push(tildePath(home, entry.path));
		byReason.set(entry.reason, list);
	}
	for (const [reason, paths] of byReason) {
		items.push({
			source: "trae",
			from: paths.length === 1 ? paths[0] : "trae's project and user trees",
			to: "—",
			action: "skip",
			detail: `${paths.length} entr(ies) not imported — ${reason}${paths.length > 1 ? `: ${summarizeNames(paths)}` : ""}`,
			containsSecret: false,
		});
	}
	if (raw.stateDatabases.length > 0) {
		const workspaces = raw.stateDatabases.filter((db) => db.kind === "workspace").length;
		items.push({
			source: "trae",
			from: "trae's editor storage",
			to: "—",
			action: "skip",
			detail: `${raw.stateDatabases.length} state database(s) (${workspaces} workspace, ${raw.stateDatabases.length - workspaces} global) opened by name only, never read: trae is a vs code fork, so a chat is an editor state record rather than a transcript, and the current build's chat payloads in that file are reported to be encrypted`,
			containsSecret: false,
		});
	}
	if (raw.otherGlobalEntries.length > 0) {
		items.push({
			source: "trae",
			from: tildePath(home, join(raw.roots.global, "..")),
			to: "—",
			action: "skip",
			detail: `${raw.otherGlobalEntries.length} entr(ies) in the global directory this importer reads nothing out of: ${summarizeNames(raw.otherGlobalEntries)}`,
			containsSecret: false,
		});
	}
}

/**
 * The two settings files TRAE documents as its main configuration, neither of
 * which this importer reads.
 *
 * Not speculative: each is named because a user coming from TRAE will look for
 * it, and an importer that says nothing about the file a tool documents as its
 * main configuration reads as having missed it. The statement is about this
 * build, and it is true of both for the same reason — each configures the
 * editor, and this build has no equivalent of the editor.
 *
 * The list comes from the reader ({@link RawTrae.editorSettings}), which is also
 * what makes `present` true for a home whose only trace is one of these: the
 * sentence and the gate have to be looking at the same list.
 */
function planTraeEditorSettings(raw: RawTrae, home: string, items: MigrationItem[]): void {
	for (const { name, path } of raw.editorSettings) {
		items.push({
			source: "trae",
			from: tildePath(home, path),
			to: "—",
			action: "skip",
			detail: `trae's editor ${name === "settings.json" ? "settings" : "key bindings"}: these configure the editor rather than an agent, and the parts that would carry over — the model list, the sandbox, the network — are editor state this importer does not read (see the state databases above)`,
			containsSecret: false,
		});
	}
}

/**
 * Assemble the plan.
 *
 * The signature is deliberately shorter than the other sources': TRAE has no
 * permission list this build could read and no hook system it could rewrite, so
 * there is nothing for `claimScalar`, `claimPermissionList` or `claimHooks` to do
 * here. Taking them and discarding them would read as a gap that a later change
 * might fill by accident; leaving them out of the signature makes the absence the
 * type system's problem to notice.
 */
export function planTrae(
	raw: RawTrae,
	home: string,
	items: MigrationItem[],
	writes: PlannedWrite[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	planTraeRules(raw, home, force, items, writes);
	planTraeMcp(raw, home, items, mcpServers, markMcpSecret, existingMcpServers, force);
	planTraeEditorSettings(raw, home, items);
	planTraeLeftovers(raw, home, items);
}
