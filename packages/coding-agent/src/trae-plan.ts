/**
 * TRAE's configuration in the target's shape: rules, MCP servers, and everything
 * this importer found and will not carry.
 *
 * Smaller than its Cursor counterpart because TRAE exposes less to import *to
 * this file*, and that is a statement about the wiring rather than about TRAE.
 * There is no portable provider configuration to read (the IDE is
 * subscription-based and its model list is editor state) and no CLI permission
 * list — so this file is rules, MCP, and the report of everything else.
 *
 * **The previous draft of this header said there was "no hook system this build
 * could rewrite". That was wrong about TRAE, and it was checked.** TRAE shipped
 * hooks in v3.5.66 on 2026-06-10 — the vendor changelog entry reads "Supported
 * hooks. Hooks are user-defined shell commands that run at specific stages of
 * TRAE's lifecycle", and `docs.trae.ai/ide/automate-actions-with-hooks` plus
 * `docs.trae.ai/ide/hook-configuration-reference` (both read 2026-09-29) document
 * six events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
 * `Stop`, `Notification`), the `hooks.json` locations — `~/.trae/hooks.json` and
 * `$PROJECT_FOLDER/.trae/hooks.json` — and the fact that TRAE can import Claude
 * Code's own hook configuration. A page probe over the documentation site found
 * no `ide/hooks` slug, which is presumably where the earlier reading came from.
 *
 * So the sentence that was there has been replaced with a true one: the hooks are
 * found and **named** (`~/.trae/hooks.json`, `<project>/.trae/hooks.json`, see
 * `trae-read.ts`), and the reason says plainly that they are executable code on
 * a lifecycle this build does not have. `claimHooks` and the hook writer live in
 * the shared planner, not here, and TRAE's event set is not this build's, so
 * carrying them is a decision to make once rather than a line to add. What would
 * have been wrong is the silence.
 *
 * Two more things here are TRAE-specific and neither is a detail:
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
 *  3. **A rule whose only activation is `scene: git_message` is named, never
 *    imported**, for the same reason as 2 and by the same reasoning: it is a
 *    rule about one moment, and a flat directory would make it every moment.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { placeholderNote, summarizeNames, tildePath, urlCredentialProblem } from "./migrate-core.ts";
import { looksLikeSecretName, type MigrationItem, type PlannedWrite } from "./migrate-types.ts";
import type { RawTrae } from "./trae-read.ts";

/**
 * The frontmatter TRAE's rules carry, read without a parser.
 *
 * The same three keys Cursor's do, and the same reason for reading them by hand:
 * the frontmatter is carried over byte for byte precisely so that nothing on this
 * side of the migration interprets it, and the three values are read only to
 * decide which sentence the report prints.
 *
 * A fourth key came out of the 2026-09-29 re-check and changes the shape of the
 * decision rather than just adding a message. `scene: git_message`
 * (`docs.trae.ai/ide/rules`, "Set rules for Git commit messages", and the
 * changelog entry for v3.5.44 on 2026-04-02) is a *fourth application mode* the
 * other three do not cover: the page says it is "compatible with existing fields
 * such as `alwaysApply`, `description` and `globs`" and that "as long as the rule
 * file contains this field, **regardless of how other fields are configured**,
 * the AI will follow the rule" when generating a commit message. So it *adds* an
 * activation rather than replacing one, and the two cases below are different
 * problems:
 *
 *   - **The file declares `scene` and nothing else.** This is the shape TRAE
 *     itself writes: the docs' own example frontmatter is `scene: git_message`
 *     alone, and the Source Control menu's "Configure Commit Message Generation
 *     Rules" generates a `.trae/rules/git-commit-message.md` containing exactly
 *     that. There is no general binding to lose, so the file is a commit-message
 *     rule and nothing else. It is named, never imported.
 *   - **The file declares `scene` *and* a general binding.** Then it is a real
 *     rule that also constrains commit messages, and refusing it would lose the
 *     general part. It is imported and the report names the commit-message
 *     binding as a loss, exactly as it names `globs` today.
 *
 * The line between the two is "does the frontmatter declare any of the three
 * general keys at all", not "is `alwaysApply` true": the rules page's fourth
 * documented application mode is manual activation via `#Rule`, which sets
 * `alwaysApply: false` and carries neither `description` nor `globs`. Treating
 * that as "no binding" and refusing it would silently drop a rule the user
 * wrote on purpose.
 */
interface TraeRuleActivation {
	alwaysApply: boolean | undefined;
	globs: string | undefined;
	/** `true` when the frontmatter declares `scene: git_message`. */
	gitMessage: boolean;
	/** `true` when the frontmatter declares any of the three general keys. */
	hasGeneralBinding: boolean;
}

function readRuleActivation(content: string): TraeRuleActivation {
	const none: TraeRuleActivation = {
		alwaysApply: undefined,
		globs: undefined,
		gitMessage: false,
		hasGeneralBinding: false,
	};
	const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!front) return none;
	const body = front[1];
	const always = /^[ \t]*alwaysApply[ \t]*:[ \t]*(\S+)/m.exec(body);
	const globs = /^[ \t]*globs[ \t]*:[ \t]*(.+)$/m.exec(body);
	const description = /^[ \t]*description[ \t]*:/m.exec(body);
	const scene = /^[ \t]*scene[ \t]*:[ \t]*["']?git_message["']?[ \t]*$/m.exec(body);
	return {
		alwaysApply: always
			? always[1]
					.trim()
					.replace(/^["']|["']$/g, "")
					.toLowerCase() === "true"
			: undefined,
		globs: globs ? globs[1].trim().replace(/^["']|["']$/g, "") : undefined,
		gitMessage: scene !== null,
		hasGeneralBinding: always !== null || globs !== null || description !== null,
	};
}

/**
 * The sentence for a rule TRAE binds to one moment and this build cannot.
 *
 * Exported for the reason {@link TRAE_USER_RULES_FILE} is: a test that retypes a
 * report string stops being an assertion the day somebody rewords it.
 */
export const TRAE_GIT_MESSAGE_RULE =
	"a trae rule bound to the git-message scene (scene: git_message) and to nothing else, which is the shape trae itself writes into .trae/rules/git-commit-message.md; the rules directory here is flat, so importing it would make a commit-message template apply to every conversation";

/**
 * TRAE's rules become rule files.
 *
 * `alwaysApply: true` is the one activation that survives verbatim — a flat rule
 * directory *is* "always in context" — and it is the only case scored `map`.
 * A name collision inside one source is handled the same way as across sources:
 * the first is kept, the second is named, and neither is silently dropped.
 *
 * The one rule that never reaches the collision check at all is a commit-message
 * rule: see {@link TRAE_GIT_MESSAGE_RULE} and the two cases in
 * {@link readRuleActivation}. It is tested *before* `taken` and before
 * `existsSync`, so a skipped rule neither occupies a name nor is "kept over" by
 * one — a rule that was never going to be written has no claim on the target
 * path, and pretending otherwise would make the collision sentence lie.
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
		const { alwaysApply, globs, gitMessage, hasGeneralBinding } = readRuleActivation(rule.content);
		// A commit-message rule with no general binding is named before the
		// collision and exists checks, because it never becomes a file at all: the
		// name is not taken and the target is not consulted, so a later rule that
		// flattens to the same name is not "kept over" something that was skipped.
		if (gitMessage && !hasGeneralBinding) {
			items.push({
				source: "trae",
				from,
				to: "—",
				action: "skip",
				detail: TRAE_GIT_MESSAGE_RULE,
				containsSecret: false,
			});
			continue;
		}
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
		const losses: string[] = [];
		if (globs) {
			losses.push(
				`trae attaches this only for files matching its globs ("${globs}"), and there is no glob-aware rule directory here — the file text is carried over unchanged, so the model can still read which files it was written for`,
			);
		}
		if (gitMessage) {
			// Reached only when there is also a general binding, so this is a real
			// loss and not a restatement of the skip above.
			losses.push(
				"trae also applies this whenever it writes a commit message, which the rules directory here has no moment to bind to — the text is carried over and applies to every conversation instead",
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
			const record = config as { headers?: Record<string, string>; env?: Record<string, string>; url?: unknown };
			// The record is copied below exactly as it was read, `url` included, and a
			// URL is the one credential channel a name-based scan cannot reach: the
			// token is inside the one string every importer treats as a safe
			// identifier, not under a secret-shaped key. `headers` and `env` can be
			// dropped whole and leave a working server; a URL cannot — the same
			// address with its userinfo or its `?access_token=` stripped is a
			// different address pointing at nothing — so nothing is written.
			// `containsSecret` is `true` even so, because the value this line is about
			// was one, and no `markMcpSecret` runs because no file receives it.
			if (typeof record.url === "string") {
				const problem = urlCredentialProblem(record.url);
				if (problem !== null) {
					items.push({
						source: "trae",
						from: `${from} → mcpServers.${name}`,
						to: "—",
						action: "skip",
						detail:
							`left off, because its url ${problem} — unlike a header or an environment variable there is no way to drop ` +
							"the credential and keep the address, so nothing was written; add the server again here with the credential " +
							"in your environment instead",
						containsSecret: true,
					});
					continue;
				}
			}
			const secret =
				Object.keys(record.headers ?? {}).length > 0 ||
				Object.keys(record.env ?? {}).some((key) => looksLikeSecretName(key));
			// Two placeholder spellings, and the second one is the vendor's.
			//
			// `${env:NAME}` is VS Code's, inherited with the rest of the MCP
			// handling. `docs.trae.ai/ide/add-mcp-servers` (read 2026-09-29) does
			// **not** mention it; under "Variable reference" it says "Currently,
			// only `${workspaceFolder}` is supported" and describes that one being
			// replaced with the project root when the server starts. So the
			// documented variable was the one being missed, and a server whose
			// `args` is `["${workspaceFolder}/plugins/mcp.js"]` was arriving in
			// `~/.labunbun/.mcp.json` — a file that is global, has no workspace
			// folder, and will not expand it — under a "copied verbatim" line with
			// no warning at all. That is the same failure the `${env:}` handling
			// below was written for, and it was one variable short.
			// biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal TRAE writes into the file, and finding it is the whole point
			const workspaceFolder = JSON.stringify(config).includes("${workspaceFolder}");
			// TRAE's own environment references, which the shared placeholder reader
			// does not recognise — it matches a bare `${NAME}`. Kept because the
			// spelling is plausible in a VS Code-derived build and the handling is
			// the same either way, but the claim that TRAE writes it is inference
			// from the fork rather than something the MCP page says.
			const envPlaceholders = [
				...new Set(
					Object.values(record.env ?? {}).flatMap((value) =>
						[...String(value).matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => `\${env:${match[1]}}`),
					),
				),
			];
			const placeholder = placeholderNote(config as Record<string, unknown>);
			const placeholders = [
				...(placeholder ? [placeholder] : []),
				...(envPlaceholders.length > 0
					? [`${envPlaceholders.join(", ")} is not expanded here — replace it with the value itself`]
					: []),
				...(workspaceFolder
					? [
							`\${workspaceFolder} is not expanded here — trae replaces it with the project root when the server starts, and this file is global, so spell the path out`,
						]
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
 * permission list this build could read, so there is nothing for `claimScalar` or
 * `claimPermissionList` to do here. Taking them and discarding them would read as
 * a gap that a later change might fill by accident; leaving them out of the
 * signature makes the absence the type system's problem to notice.
 *
 * `claimHooks` is in the same sentence for a different reason and the reason
 * changed on 2026-09-29. This module used to say TRAE has no hook system, which
 * was wrong: v3.5.66 (2026-06-10) added one and the vendor documents its file and
 * its six events. The hooks are found and named in `trae-read.ts` rather than
 * claimed here, and that is a decision to revisit rather than a fact about the
 * product — TRAE's `PreToolUse`/`PostToolUse` events are not this build's events,
 * and carrying a hook means carrying *where it runs*, not just its JSON. What
 * would have been wrong, and what the old comment did, is calling the absence a
 * property of TRAE.
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
