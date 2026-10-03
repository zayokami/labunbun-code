/**
 * MiMo Code's configuration in the target's shape: the model, the permission
 * rules, the MCP servers, the skills, the agents, the commands and the memory,
 * and everything the reader saw that this importer will not carry.
 *
 * **The first thing to know about this source is that it has three credential
 * channels that are not key-shaped, and all three are in the MCP block.**
 *
 *   - **`mcp.<name>.url` is validated only as http/https.** `Remote.url` is
 *     `Schema.String` (`config/mcp.ts:52`) with no format, so
 *     `https://user:token@host/mcp` passes with the credential inside the string
 *     every importer treats as a safe identifier. This is the same hole that was
 *     found in Qoder and then fixed across all fourteen sources before this one,
 *     and {@link urlCredentialProblem} is the guard — **this planner uses the
 *     shared one rather than writing a new one**, which is the whole point of it
 *     existing.
 *   - **`mcp.<name>.environment` is a plain string map** (`config/mcp.ts:21-23`),
 *     so `{"MY_TOKEN": "…"}` is a credential the reader drops by name.
 *   - **`mcp.<name>.oauth.clientSecret`** (`config/mcp.ts:39-41`) is dropped by the
 *     reader's walk, since `clientSecret` matches `looksLikeSecretName`.
 *
 * **MiMo Code ships its own redactor and this importer deliberately does not use
 * it.** `config/mcp.ts:82,91-93` lists
 * `authorization, token, api_key, apikey, key, secret, password, credential` and
 * matches with `input.toLowerCase().includes(item)` — a **substring** test, so it
 * flags a server *named* `keyboard-mcp`, a path `monkey` and a header
 * `x-team-keynote`. That list is for *values* (`redactString`, `:170-175`), where
 * over-matching only makes the printed string uglier; applied to *keys* it would
 * delete the user's own servers. The list's words are kept here (they are the
 * spellings a user pastes out of a dashboard) and matched against whole
 * segments instead, with {@link MIMOCODE_ENTRY_MAP_KEYS} stepping over the names
 * the user chose.
 *
 * **Four things are deliberately not migrated, and each is a decision with a
 * reason rather than an omission:**
 *
 *   1. **Provider credentials.** `provider.<id>.options.apiKey` and
 *      `provider.<id>.headers` are dropped by the reader by name. The real keys
 *      are in `<data>/auth.json` and the `account` table, neither of which is
 *      opened — see {@link planMiMoCodeCredentials}.
 *   2. **`{env:VAR}` and `{file:path}` are copied verbatim, never substituted.**
 *      `config/variable.ts:32-45` expands both into the config text *before* it is
 *      parsed. Substituting here would freeze an environment lookup into a literal
 *      secret inside labunbun's `settings.json` — the opposite of what the user
 *      wrote. Where the substitution appears inside an MCP `command` array the
 *      server is refused rather than written, because this build does not expand
 *      it either and the literal would be an argv MiMo Code never ran.
 *   3. **Plugins.** `config/plugin.ts:33-38` turns each `{plugin,plugins}/*.{ts,js}`
 *      hit into a `pathToFileURL(item).href` and the engine **imports** it at
 *      start-up. A plugin is installed code, not prose.
 *   4. **Config-defined `agent` and `mode` entries.** See
 *      {@link planMiMoCodeAgentEntries} for why the name is all that comes across.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import {
	collectFileWrites,
	isRecord,
	planCommands,
	planMemoryAsRule,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
	urlCredentialProblem,
} from "./migrate-core.ts";
import type {
	AddPermissionRules,
	ClaimScalar,
	MigrationItem,
	MigrationSourceId,
	PlannedWrite,
} from "./migrate-types.ts";
import { resolveModelReference } from "./migrate-types.ts";
import {
	MIMOCODE_CREDENTIAL_TABLES,
	MIMOCODE_DERIVED_TABLES,
	MIMOCODE_LEGACY_KEYS,
	MIMOCODE_VENDOR_SKILL_DIRS,
	mimocodeManagedConfigDir,
	mimocodeMemoryPath,
	mimocodeVendoredClaudeMd,
} from "./mimocode-home.ts";
import type { MiMoCodeSettingsSource, RawMiMoCode } from "./mimocode-read.ts";
import { mimocodeSettingsOrigin, mimocodeSettingsSubkeyOrigin } from "./mimocode-read.ts";

/**
 * This source's id, spelled once.
 *
 * The union and every table keyed by it live in `migrate-types.ts`; this is a
 * plain literal with no cast. **The call lives in `migrate.ts`** — see that
 * file's arm for `mimocode-code`, which is where this planner is reached from.
 */
const SOURCE: MigrationSourceId = "mimocode-code";

/**
 * Top-level keys of the settings document this mapper accounts for.
 *
 * Read against the reader's header, not in isolation. `model`, `mcp` and
 * `permission` are the three this planner actually reads. `tui` is here because
 * {@link planMiMoCodeTui} gets a line of its own rather than falling into the
 * catch-all; `agent`/`mode` because {@link planMiMoCodeAgentEntries} does. The
 * rest are named by the closing aggregate item, which is the honest place for a
 * key this importer has no mapping for and no note about.
 */
const MIMOCODE_SETTINGS_HANDLED = new Set([
	"model",
	"small_model",
	"vision_model",
	"model_groups",
	"mcp",
	"permission",
	"tui",
	"agent",
	"mode",
	// The five legacy keys are here because {@link planMiMoCodeLeftovers} gives each
	// of them a **stronger** sentence than the catch-all's — "no longer read by
	// anything, including MiMo Code itself" rather than "this importer has no mapping
	// for". Listing them again in the catch-all would print two sentences about the
	// same key in different words, and the weaker one would be read first.
	...MIMOCODE_LEGACY_KEYS,
]);

/**
 * The report label for a settings key: the file its value came from, plus the
 * layer when that file is not the user's own.
 *
 * **The layer suffix is the point.** `config.json` is the *first* of three global
 * documents and `mimocode.jsonc` the last (see `mimocodeReadRoots`), and a
 * project `.mimocode/mimocode.jsonc` beats both. A report that printed
 * `<config>/config.json → mcp` for a server the project has overridden would send
 * the user to edit a file that no longer decides anything. The `global-*` sources
 * print no suffix — they are all in the user's own `<config>` directory, and a
 * suffix reading "global layer" tells a reader nothing they did not have.
 */
/**
 * The layer a report line names in prose rather than by its enum value.
 *
 * `project` reads as a fragment and `custom-file` reads as a filename with a
 * hyphen in it, so both are given words: the first because a user should be told
 * which file they have to open, and the second because `$MIMOCODE_CONFIG` is the
 * variable that produced it and nothing else would let them find it.
 */
const MIMOCODE_LAYER_LABELS: Partial<Record<MiMoCodeSettingsSource, string>> = {
	project: "project layer",
	"custom-file": "$MIMOCODE_CONFIG",
};

function mimocodeFrom(raw: RawMiMoCode, key: string, subkey?: string): string {
	// **The key goes into the label even with no sub-key.** A bare-key line that
	// printed only the file path sent the user to a settings document with no
	// statement of which setting the sentence was about — and there are 41 of them
	// in that file.
	if (subkey === undefined) return `${mimocodeSettingsOrigin(raw.home, raw, key)} → ${key}`;
	const narrowed = mimocodeSettingsSubkeyOrigin(raw.home, raw, key, subkey);
	const label = MIMOCODE_LAYER_LABELS[narrowed.source];
	const suffix = label === undefined ? "" : ` (${label})`;
	return `${narrowed.path} → ${key}.${subkey}${suffix}`;
}

/**
 * MiMo Code's permission verbs → this build's tool names.
 *
 * **Only exact-name verbs are mapped, and one verb maps to two tools on purpose.**
 *
 *   - `edit` covers MiMo Code's whole edit family, which its own code names
 *     `EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"]`
 *     (`permission/index.ts:614`) — so `edit: "deny"` denies writes as well as
 *     edits, and mapping it to `Edit` alone would narrow a deny into a hole.
 *     `Edit` **and** `Write` is the faithful pair.
 *   - `read` covers `READ_TOOLS = ["read", "view_image"]` (`permission/index.ts:615`);
 *     this build has no `view_image`, so `Read` alone loses nothing.
 *   - `bash` is `Bash` and nothing else. `BashOutput`, `KillBash` and
 *     `TaskUpdate` have no MiMo Code verb: they are this build's own tools, and
 *     giving them a rule MiMo Code never had would be the importer inventing a
 *     decision.
 *
 * **Everything absent from this table is a report line, not a guess.** `task`,
 * `actor`, `codesearch`, `lsp`, `doom_loop`, `skill`, `external_directory` and the
 * `*` wildcard all name things this build either has no tool for or does not mean
 * the same thing by. `"*"` in particular is MiMo Code's *deny-everything*
 * spelling (`config/permission.ts:61-63`: a bare string action becomes
 * `{"*": action}`), and the closest thing here would be a rule that changes what
 * every tool can do — which is a widening a migration must not make on its own
 * judgement.
 */
export const MIMOCODE_PERMISSION_TOOLS: Record<string, readonly string[]> = {
	read: ["Read"],
	edit: ["Edit", "Write"],
	glob: ["Glob"],
	grep: ["Grep"],
	list: ["LS"],
	bash: ["Bash"],
	webfetch: ["WebFetch"],
	websearch: ["WebSearch"],
	question: ["AskUserQuestion"],
};

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * `model` → this build's `model`, when the reference resolves.
 *
 * **The id is a `provider/model` string and the two registries differ**, so the
 * value is resolved rather than copied: `ConfigModelID` is a plain
 * `Schema.String` (`config/model-id.ts:12-14`) carrying whatever models.dev calls
 * it, and a model this build does not carry becomes a reported skip rather than a
 * `model` value in `settings.json` that nothing can resolve.
 *
 * Claimed only when the file states one. An absent key means nothing claimed and
 * nothing said — importing the schema's default would be writing a model on the
 * user's behalf that they never stated.
 */
function planMiMoCodeModel(raw: RawMiMoCode, items: MigrationItem[], claimScalar: ClaimScalar): void {
	if (raw.settings === null) return;
	const value = raw.settings.model;
	if (value === undefined) return;
	const from = mimocodeFrom(raw, "model");
	if (typeof value !== "string" || value.trim() === "") {
		items.push({
			source: SOURCE,
			from: `${from} (${summarizeNames([String(value)])})`,
			to: "—",
			action: "skip",
			detail:
				"not a model reference this build can read — `model` is a plain string in MiMo Code's schema " +
				"(config/model-id.ts:12-14) carrying whatever models.dev calls it, so nothing was claimed and the session " +
				"keeps the model it would start with. Set one with /model",
			containsSecret: false,
		});
		return;
	}
	const resolved = resolveModelReference(value);
	if (resolved === undefined) {
		items.push({
			source: SOURCE,
			from: `${from} (${value})`,
			to: "—",
			action: "skip",
			detail:
				`this build carries no model by that name, so the reference was not copied — writing it would put a \`model\` ` +
				"value in settings.json that nothing resolves. Set one with /model",
			containsSecret: false,
		});
		return;
	}
	claimScalar(
		SOURCE,
		"model",
		resolved,
		`${from} (${value})`,
		resolved === value
			? "copied verbatim — the reference resolves against this build's own registry"
			: `MiMo Code's models.dev id was written as \`${resolved}\`, which is the reference this build resolves`,
	);
}

/**
 * `small_model`, `vision_model` and `model_groups` — named, never claimed.
 *
 * `small_model` is the model MiMo Code uses for background and cheap work and
 * `vision_model` the one it uses for images. This build has exactly one `model`
 * key and a `fallbackModels` list that means "try these when the first fails" —
 * **which is a different decision**, not a smaller one. Importing `small_model`
 * as a fallback would change what happens when the primary model is unavailable,
 * so it is reported instead.
 */
function planMiMoCodeOtherModels(raw: RawMiMoCode, items: MigrationItem[]): void {
	if (raw.settings === null) return;
	for (const key of ["small_model", "vision_model"]) {
		const value = raw.settings[key];
		if (value === undefined) continue;
		items.push({
			source: SOURCE,
			from: `${mimocodeFrom(raw, key)} (${summarizeNames([String(value)])})`,
			to: "—",
			action: "skip",
			detail:
				`\`${key}\` is the model MiMo Code uses for a narrower job than the main one, and this build has one \`model\` ` +
				"key and a `fallbackModels` list that means something else — what to try when the main model is unavailable. " +
				"Mapping one to the other would change what happens on an error rather than reproduce a smaller job, so it was left out",
			containsSecret: false,
		});
	}
	const groups = raw.settings.model_groups;
	if (groups === undefined) return;
	items.push({
		source: SOURCE,
		from: mimocodeFrom(raw, "model_groups"),
		to: "—",
		action: "skip",
		detail:
			`${Object.keys(isRecord(groups) ? groups : {}).length} named model group(s) — a group is a set of models the ` +
			"picker offers together, and this build has no grouped picker, so importing the members would write several models " +
			"where the user chose one",
		containsSecret: false,
	});
}

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

/**
 * `permission` → this build's allow/deny rules, through `fromConfig`'s own shape.
 *
 * `permission/index.ts:596-608` verbatim in effect:
 *
 * ```js
 * for (const [key, value] of Object.entries(permission)) {
 *   if (typeof value === "string") { ruleset.push({ permission: key, action: value, pattern: "*" }); continue }
 *   ruleset.push(...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })))
 * }
 * ```
 *
 * **Three properties of that shape this function reproduces rather than
 * approximates, and each one is a decision about what gets enforced:**
 *
 *   - **Insertion order decides, because `evaluate` uses `findLast`**
 *     (`permission/evaluate.ts:11-14`) and the config's own `permissionPreprocess`
 *     (`config/permission.ts:25-30`) exists purely to preserve it — `evaluate`
 *     `findLast`s over an array, so two rules for the same tool and pattern
 *     resolve to whichever the user wrote *last*. `Object.entries` on a
 *     `JSON.parse` result is that order, so reading the file is enough; a reader
 *     that sorted the keys would silently resolve every such pair the other way.
 *   - **`expand()` is NOT reproduced.** `permission/index.ts:583-589` rewrites a
 *     leading `~/` or `$HOME/` against **`os.homedir()` of the machine that ran
 *     MiMo Code**. Substituting here would rewrite the *importing* machine's home
 *     into a rule that meant the source machine's — silently widening a path
 *     pattern, in the one direction a permission import must not move on its own.
 *     The specifier is copied verbatim and the fact is reported.
 *   - **The default action is `ask`** (`permission/evaluate.ts:14`:
 *     `return match ?? { action: "ask", permission, pattern: "*" }`), so a rule
 *     MiMo Code has is a *narrowing* of an ask-by-default posture. There is no
 *     ask tier here: `ask` rules are **left out of both lists** rather than
 *     turned into an allow, which would run exactly the calls the user meant to be
 *     prompted for. This is `opencode-plan.ts`'s rule and it is the reason that
 *     branch exists.
 */
function planMiMoCodePermissions(
	raw: RawMiMoCode,
	items: MigrationItem[],
	addPermissionRules: AddPermissionRules,
): void {
	if (raw.settings === null) return;
	const permission = raw.settings.permission;
	if (permission === undefined) return;
	const from = mimocodeFrom(raw, "permission");

	// A bare action — `permission: "deny"` — becomes `{"*": action}` in MiMo Code's
	// own transform (`config/permission.ts:61-63`), so it is normalised here rather
	// than read as "no rules at all".
	const table: unknown = typeof permission === "string" ? { "*": permission } : permission;
	if (!isRecord(table)) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail: "not a rule map and not a single action, so none of its rules were read",
			containsSecret: false,
		});
		return;
	}

	const allow: string[] = [];
	const deny: string[] = [];
	const ask: Array<{ rule: string; verb: string }> = [];
	const unmapped: string[] = [];
	const malformed: string[] = [];
	const expanded: string[] = [];
	for (const [verb, rule] of Object.entries(table)) {
		// `__originalKeys` is metadata the product's own preprocessor adds at parse
		// time; a user who wrote it literally gets the same map the product would.
		if (verb === "__originalKeys") continue;
		const tools = MIMOCODE_PERMISSION_TOOLS[verb];
		if (tools === undefined) {
			unmapped.push(verb);
			continue;
		}
		const take = (pattern: string | undefined, action: unknown): void => {
			if (action !== "allow" && action !== "deny" && action !== "ask") {
				malformed.push(`${verb}${pattern === undefined ? "" : `(${pattern})`}`);
				return;
			}
			if (pattern !== undefined && (pattern.startsWith("~/") || pattern.startsWith("$HOME"))) {
				expanded.push(pattern);
			}
			if (action === "ask") {
				ask.push({ rule: verb, verb: pattern ?? "*" });
				return;
			}
			for (const tool of tools) {
				const formatted = pattern === undefined ? tool : `${tool}(${pattern})`;
				// `findLast`: a later rule for the same tool and pattern wins, and
				// this build's own evaluator resolves deny over allow regardless of
				// order. Both agree on the deny-later case; they disagree on the
				// allow-later one, and the disagreement is reported below rather than
				// resolved silently in either direction.
				const index = allow.indexOf(formatted);
				const denyIndex = deny.indexOf(formatted);
				if (index >= 0) allow.splice(index, 1);
				if (denyIndex >= 0) deny.splice(denyIndex, 1);
				if (action === "allow") allow.push(formatted);
				else deny.push(formatted);
			}
		};
		if (typeof rule === "string") take(undefined, rule);
		else if (isRecord(rule)) {
			for (const [pattern, action] of Object.entries(rule)) take(pattern, action);
		} else {
			malformed.push(verb);
		}
	}

	// A rule both files' evaluators agree on, and two this one does not.
	const overlap = allow.filter((rule) => deny.includes(rule));
	if (overlap.length > 0) {
		items.push({
			source: SOURCE,
			from: `${from} → ${summarizeNames(overlap, 6)}`,
			to: "—",
			action: "downgrade",
			detail:
				`${overlap.length} rule(s) resolve differently here than in MiMo Code: it takes whichever the user wrote ` +
				"last (`evaluate` uses `findLast`, and its own preprocessor exists to preserve your key order), while this build " +
				"resolves deny over allow whatever the order. The deny was kept in both cases, which is the narrower of the two",
			containsSecret: false,
		});
	}

	if (ask.length > 0) {
		items.push({
			source: SOURCE,
			from: `${from} → ${summarizeNames(
				ask.map((one) => one.verb),
				6,
			)}`,
			to: "—",
			action: "skip",
			detail:
				`${ask.length} rule(s) MiMo Code would stop and ask about, and there is no ask tier in a rule list here — writing ` +
				"an allow would run exactly the calls the user meant to be prompted for, so they were left out of both lists. " +
				"MiMo Code's default is `ask` for anything unmatched, which is what a session here falls back to too",
			containsSecret: false,
		});
	}
	if (unmapped.length > 0) {
		items.push({
			source: SOURCE,
			from: `${from} → ${summarizeNames(unmapped, 8)}`,
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(unmapped, 8)} name${unmapped.length === 1 ? "s a" : "s are"} MiMo Code tool verb${unmapped.length === 1 ? "" : "s"} ` +
				"this build has no tool for, or does not mean the same thing by — `task` is its subagent tool and this build's " +
				"`Task*` tools are a todo list, `codesearch` has no counterpart here, `external_directory` is a per-path decision " +
				'with no rule form, and `"*"` is MiMo Code\'s deny-everything spelling, which the closest thing here would change ' +
				"what every tool can do. None was guessed at",
			containsSecret: false,
		});
	}
	if (malformed.length > 0) {
		items.push({
			source: SOURCE,
			from: `${from} → ${summarizeNames(malformed, 8)}`,
			to: "—",
			action: "skip",
			detail:
				`${malformed.length} entr${malformed.length === 1 ? "y" : "ies"} carried an action other than allow, deny or ask — ` +
				"`permission/index.ts:30` makes those three the whole vocabulary, so anything else is a file the product would refuse",
			containsSecret: false,
		});
	}
	if (expanded.length > 0) {
		items.push({
			source: SOURCE,
			from: `${from} → ${summarizeNames(expanded, 6)}`,
			to: "—",
			action: "downgrade",
			detail:
				`${expanded.length} path pattern(s) were copied verbatim rather than expanded: MiMo Code's \`expand()\` ` +
				"(`permission/index.ts:583-589) rewrites a leading `~/` or `$HOME/` against the home of the machine that ran it, " +
				"so substituting here would have written this machine's home into a rule that meant another one — which widens a " +
				"path pattern rather than reproducing one. Rewrite them by hand if the path matters",
			containsSecret: false,
		});
	}
	if (allow.length === 0 && deny.length === 0) return;

	const caveat =
		"an allowed call runs without a prompt here and a deny blocks it whatever else is allowed — review them with /permissions";
	if (allow.length > 0) addPermissionRules(SOURCE, "allow", allow, `${from} → allow`, caveat);
	if (deny.length > 0) addPermissionRules(SOURCE, "deny", deny, `${from} → deny`, caveat);
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/**
 * The keys MiMo Code's own schema accepts on an MCP entry, verbatim.
 *
 * `config/mcp.ts:16-73` — `Local` (`:16-33`) and `Remote` (`:50-68`):
 *
 * ```js
 * Local  = { type: "local",  command: string[], environment?, enabled?, timeout?, sampling? }
 * Remote = { type: "remote", url: string, enabled?, headers?, oauth?, timeout?, sampling? }
 * ```
 *
 * **`command` is an array**, not a command plus an `args` key, and that is the
 * single most load-bearing line on this list: a reader expecting `command: "npx"`
 * and `args: ["-y", "x"]` would read `undefined` here and either drop the server
 * or write an empty command.
 *
 * A **legacy `{enabled: boolean}`** form exists too, and it works only because the
 * config merge is deep rather than replace: a global entry's full definition and a
 * project's `{enabled: false}` fold into one object. {@link planMiMoCodeMcp}
 * recognises it and reports it as what it is.
 */
const MIMOCODE_MCP_KEYS = new Set([
	"type",
	"command",
	"environment",
	"enabled",
	"timeout",
	"sampling",
	"url",
	"headers",
	"oauth",
]);

/**
 * `{env:VAR}` and `{file:path}` in a value, verbatim from `config/variable.ts:32-45`.
 *
 * **Detected, never substituted.** `ConfigVariable.substitute` expands both into
 * the config text before it is parsed, so by the time a settings file is *read*
 * the placeholders are already gone — a file that still contains one was written
 * by something other than the product, or the substitution failed, and either way
 * this build does not expand it. Copying it verbatim into `settings.json` would
 * preserve the user's text; **expanding it here would freeze an environment
 * lookup into a literal secret**, which is the failure the whole
 * `scrubMiMoCodeCredentials` guard exists to prevent.
 */
const MIMOCODE_PLACEHOLDER = /\{(?:env|file):[^}]+\}/;

/** Whether this build would expand a `{env:…}` or `{file:…}` at all. It would not. */
function placeholderIn(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = MIMOCODE_PLACEHOLDER.exec(value);
	return match === null ? null : match[0];
}

/**
 * One MCP server from `settings.mcp` → this build's server shape.
 *
 * **Three credential channels are handled and they are handled differently, on
 * purpose.**
 *
 *   - **`headers` are dropped whole.** MiMo Code ships a redactor for them
 *     (`config/mcp.ts:170-182`), so it agrees they hold bearer tokens; a header
 *     value is an ordinary place for one, and a header *name* is not a credential
 *     so the reader's key-based scrub does not see them at all. Dropping the block
 *     loses the server's authentication, which the report says, and that is the
 *     right trade.
 *   - **`environment` values are not copied; the names are.** Same reasoning, for
 *     the process environment of a spawned server. Any name matching
 *     `looksLikeSecretName` was already deleted by the reader with a `skipped`
 *     line carrying its full path, so what is left are names the user chose.
 *   - **`url` cannot be half-dropped.** A URL with its userinfo or its
 *     `?access_token=` removed is a *different URL that points at nothing*, and
 *     writing one would trade a credential on disk for a server that fails at
 *     connect time while the report calls the copy a clean `map`. So the server is
 *     not carried across at all. `containsSecret` is `true` on that line although
 *     nothing was written: the value that line is about *is* one.
 */
function planMiMoCodeMcp(
	raw: RawMiMoCode,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	for (const [name, entry] of Object.entries(raw.mcpServers)) {
		const from = mimocodeFrom(raw, "mcp", name);

		// **The legacy disable-only form**, which reaches here because the config
		// merge is deep: `{enabled: false}` merged over a global `Local` is one
		// object, and read alone it looks like a server with nothing to run. It is
		// not one this importer can carry — there is no full definition here.
		if (!isRecord(entry)) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: "not a server table",
				containsSecret: false,
			});
			continue;
		}
		const keys = Object.keys(entry);
		if (keys.every((key) => key === "enabled")) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					`only \`enabled: ${JSON.stringify(entry.enabled)}\` — this is MiMo Code's legacy disable-only form, which works ` +
					"because its config merge is deep, so a project's `{enabled: false}` folds into a server the global file " +
					"defined. The definition is in another layer and this entry is not it, so nothing was written; copy the server " +
					"over by hand and switch it off here with /mcp",
				containsSecret: false,
			});
			continue;
		}

		if (entry.enabled === false) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"MiMo Code has this server switched off (`enabled: false`). Importing it would add a server to the target's " +
					"configuration that the user had turned off there, so it was left out — turn it on here with /mcp if you want it",
				containsSecret: false,
			});
			continue;
		}

		const kind = entry.type;
		const downgrades: string[] = [];
		const config: Record<string, unknown> = {};

		if (kind === "local") {
			const command = entry.command;
			if (!Array.isArray(command) || command.length === 0) {
				items.push({
					source: SOURCE,
					from,
					to: "—",
					action: "skip",
					detail:
						"`type` is `local` but `command` is not a non-empty array of strings — MiMo Code's `Local.command` is " +
						"`Schema.mutable(Schema.Array(Schema.String))` (config/mcp.ts:18-20), so a plain string or an empty list is " +
						"not a server it could have started",
					containsSecret: false,
				});
				continue;
			}
			const strings = command.filter((part): part is string => typeof part === "string");
			if (strings.length !== command.length) {
				items.push({
					source: SOURCE,
					from,
					to: "—",
					action: "skip",
					detail:
						"`command` carries an element that is not a string. MiMo Code's schema is an array of strings " +
						"(config/mcp.ts:18-20), so this file is one the product would refuse",
					containsSecret: false,
				});
				continue;
			}
			// A placeholder anywhere in the argv would be a literal here and a
			// resolved path there, so the argv MiMo Code ran is not the one written.
			// **The `?? null` is load-bearing and was a real bug once.** `Array.find`
			// answers `undefined` when nothing matched, and `undefined !== null` is
			// true — so the guard below fired for every server, refused all of them,
			// and wrote no `.mcp.json` at all while a test that only checked a
			// placeholder passed. A missing value is normalised here rather than
			// compared against the wrong sentinel.
			const placeholder = strings.map(placeholderIn).find((one) => one !== null) ?? null;
			if (placeholder !== null) {
				items.push({
					source: SOURCE,
					from: `${from} (${placeholder})`,
					to: "—",
					action: "skip",
					detail:
						"the command array carries a `{env:VAR}` or `{file:path}` placeholder. MiMo Code expands both before " +
						"parsing the config (config/variable.ts:32-45) and this build expands neither, so the argv written here " +
						"would be a literal MiMo Code never ran. Set the server's environment again here with /mcp",
					containsSecret: false,
				});
				continue;
			}
			// `[0]` is the program and the rest are its arguments — the array *is*
			// the two fields this build keeps apart.
			config.type = "stdio";
			config.command = strings[0] as string;
			if (strings.length > 1) config.args = strings.slice(1);
			if (entry.environment !== undefined && !isRecord(entry.environment)) {
				downgrades.push("its `environment` was not an object, so none of it was read");
			}
		} else if (kind === "remote") {
			const url = typeof entry.url === "string" ? entry.url.trim() : "";
			if (url === "") {
				items.push({
					source: SOURCE,
					from,
					to: "—",
					action: "skip",
					detail:
						"`type` is `remote` but there is no `url` — MiMo Code's `Remote.url` is a required `Schema.String` " +
						"(config/mcp.ts:52), so this file is one the product would refuse",
					containsSecret: false,
				});
				continue;
			}
			// The one credential channel no name-based scan can see. `Remote.url` has
			// no format in the schema, so `https://user:token@host/mcp` passes
			// validation with the credential inside the one string every importer
			// treats as a safe identifier. **The shared guard is used, not a new
			// one** — `urlCredentialProblem` parses by hand precisely because it
			// cannot be trusted to a URL parser on a pasted credential URL.
			const problem = urlCredentialProblem(url);
			if (problem !== null) {
				items.push({
					source: SOURCE,
					from,
					to: "—",
					action: "skip",
					detail:
						`left off, because ${problem} — unlike a header or an environment variable there is no way to drop the ` +
						"credential and keep the address, so nothing was written; add the server again here with the credential in " +
						"your environment instead",
					containsSecret: true,
				});
				continue;
			}
			config.type = "http";
			config.url = url;
		} else {
			items.push({
				source: SOURCE,
				from: `${from} (${summarizeNames([String(kind)])})`,
				to: "—",
				action: "skip",
				detail:
					"`type` is not `local` or `remote`, which are the only two shapes `ConfigMCP.Info` accepts " +
					"(config/mcp.ts:70-72, a discriminated union on `type`). Choosing one for it would be choosing for MiMo Code",
				containsSecret: false,
			});
			continue;
		}

		// `sampling` is a policy for `sampling/createMessage` from this server —
		// deny, ask or allow (config/mcp.ts:6-14). This build's MCP client has no
		// such switch, so the fact that the user set one is the report line.
		if (entry.sampling !== undefined) {
			downgrades.push(
				`its \`sampling\` policy of ${summarizeNames([JSON.stringify(entry.sampling)])} was left off — this build's MCP ` +
					"client has no switch for whether a server may ask the model a question",
			);
		}
		// `timeout` is milliseconds here and `DEFAULT_TIMEOUT` is 30 000
		// (`mcp/index.ts:42`), resolved as `entry.timeout ?? cfg.experimental?.mcp_timeout`
		// (`mcp/index.ts:1178` and `:1156`). **The schema's own description says
		// "Defaults to 5000"** (`mcp.ts:28` and `:63`) and the code says 30 000; the
		// code is what runs, and the stale sentence is quoted here so a reader who
		// finds it in the source knows why this line says 30000.
		if (entry.timeout !== undefined) {
			downgrades.push(
				`its timeout of ${summarizeNames([String(entry.timeout)])} ms was left off — MiMo Code's code default is 30000 ` +
					"(mcp/index.ts:42) even though its schema description says 5000, and this build's server config has no field for it",
			);
		}

		// The two credential blocks. Both are named, never copied.
		if (isRecord(entry.headers)) {
			const names = Object.keys(entry.headers);
			if (names.length > 0) {
				downgrades.push(
					`left off ${summarizeNames(names)} — a header value is an ordinary place for a bearer token, and this importer ` +
						"writes none of them; set the server's headers again here if it needs them",
				);
			}
		}
		// `oauth` is a union of the record and the literal `false` (`config/mcp.ts:59-61`,
		// where `false` means "do not auto-detect"), so the guard tests the record first.
		if (isRecord(entry.oauth)) {
			const fields = Object.keys(entry.oauth).filter(
				(key) => key === "clientId" || key === "clientSecret" || key === "scope" || key === "redirectUri",
			);
			downgrades.push(
				`left off its OAuth configuration (${summarizeNames(fields, 4)}) — a client secret is a credential and the rest ` +
					"describes a flow against an authorization server that has not happened here; authorise the server again with /mcp",
			);
		}
		const envNames = isRecord(entry.environment) ? Object.keys(entry.environment) : [];
		if (envNames.length > 0) {
			downgrades.push(
				`left off ${envNames.length} environment variable${envNames.length === 1 ? "" : "s"} (${summarizeNames(envNames)}) — ` +
					"the names came across in this report, the values did not, so a server that needs a secret has to have it set again here",
			);
		}

		if (!McpServerConfigSchema.safeParse(config).success) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					kind === "local"
						? "its command or arguments are not a stdio server definition this build accepts"
						: "its URL is not an address this build's MCP client accepts",
				containsSecret: false,
			});
			continue;
		}

		const extra = Object.keys(entry).filter((key) => !MIMOCODE_MCP_KEYS.has(key));
		if (extra.length > 0) {
			downgrades.push(
				`left off ${summarizeNames(extra)} — not one of the ${MIMOCODE_MCP_KEYS.size} keys MiMo Code's own MCP schema ` +
					"recognises on an entry (config/mcp.ts:16-73)",
			);
		}

		if (name in existingMcpServers && !force) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: "target already defines a server with this name — kept (use --force to overwrite)",
				containsSecret: false,
			});
			continue;
		}

		// Nothing credential-shaped was copied, so this is never true for an entry
		// accepted above. It is computed rather than assumed so that a future change
		// which *did* start copying a value has to make this turn true on purpose.
		const secret = false;
		mcpServers[name] = config;
		markMcpSecret(secret);
		items.push({
			source: SOURCE,
			from,
			to: `~/.labunbun/.mcp.json → mcpServers.${name}`,
			action: downgrades.length > 0 ? "downgrade" : "map",
			detail:
				downgrades.length > 0
					? `copied without its credentials — ${downgrades.join("; ")}`
					: "copied without its credentials",
			containsSecret: secret,
		});
	}
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Skills, agents and commands.
 *
 * **A skill is copied verbatim because the two shapes are the same** — a
 * directory with a `SKILL.md` in it — so there is no rewrite to explain. An agent
 * is a `.md` file in either case, and its nesting is kept: MiMo Code names
 * `agents/team/reviewer.md` as **`team/reviewer`** (`config/entry-name.ts:12-16`),
 * so a nested agent becomes a nested path here rather than a flattened name that
 * two teams could collide on.
 *
 * **A command is prose the user wrote and becomes a skill**, which is the same
 * rewrite `planCommands` does for every other source.
 */
function planMiMoCodeAssets(raw: RawMiMoCode, force: boolean, items: MigrationItem[], writes: PlannedWrite[]): void {
	collectFileWrites(
		SOURCE,
		raw.assets,
		(name) => join(raw.home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		raw.home,
	);
	for (const collision of raw.assetCollisions) {
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, collision.dropped),
			to: "—",
			action: "skip",
			detail:
				`a skill named "${collision.name}" is in both ${collision.kept} and here; MiMo Code merges its asset roots in ` +
				"this order so the later one overwrites, and that is the one kept — the other was not read",
			containsSecret: false,
		});
	}

	collectFileWrites(
		SOURCE,
		raw.agents,
		(name) => join(raw.home, ".labunbun", "agents", `${name}.md`),
		"agent",
		force,
		items,
		writes,
		raw.home,
	);
	planCommands(SOURCE, raw.commands, "MiMo Code's command files", raw.home, force, items, writes);

	// Memory, one rule file per document, with the scope in the name.
	const used = new Set<string>();
	for (const document of raw.memory) {
		const parsed = mimocodeMemoryPath(document.sourcePath);
		if (parsed === null) continue;
		// The three scopes are different documents and only the file name separates
		// them here, so the scope goes into the name. A `global` entry and a
		// `projects/<slug>` entry of the same key are otherwise two writes to one
		// path, and the second would be reported as a collision it never was.
		const stem = parsed.key.replace(/\.md$/, "").replace(/[\\/]/g, "-");
		let name = `imported-mimocode-${parsed.scope}-${stem}.md`;
		let counter = 2;
		while (used.has(name)) {
			name = `imported-mimocode-${parsed.scope}-${parsed.scopeId ? `${parsed.scopeId}-` : ""}${stem}-${counter}.md`;
			counter += 1;
		}
		used.add(name);
		planMemoryAsRule(
			SOURCE,
			tildePath(raw.home, document.sourcePath),
			raw.home,
			document.content,
			name,
			force,
			items,
			writes,
		);
	}

	// The standing instruction document, as a rule file.
	//
	// **A rule file and not a memory entry**, for the reason
	// `planMemoryAsRule`'s own detail line already states: this build merges rule
	// files with the memory it has instead of replacing it, which is what a
	// document the agent re-reads at the top of every session wants.
	//
	// **No report line when there is no document**, which is the same contract the
	// other importers keep: a `null` here is not a failure and is not worth a row.
	if (raw.agentsMd?.trim() && raw.agentsMdPath !== null) {
		planMemoryAsRule(
			SOURCE,
			tildePath(raw.home, raw.agentsMdPath),
			raw.home,
			raw.agentsMd,
			"imported-mimocode-agents.md",
			force,
			items,
			writes,
		);
	}
}

// ---------------------------------------------------------------------------
// Everything named and not carried
// ---------------------------------------------------------------------------

/**
 * Config-defined `agent` and `mode` entries, plus their markdown counterparts.
 *
 * **The name is all that comes across, and the reason is the shape rather than
 * the topic.** `agent` is a `Record<name, AgentConfig>` whose entry carries a
 * `prompt` — the agent's whole system prompt — alongside `model`, `temperature`,
 * `steps`, `permission` and a free-form `options` (`config/agent.ts:115-125`).
 * A subagent file here carries `name`, `description`, `model` and a body, and has
 * no field for `steps`, `permission` or `options`. Writing the prompt and
 * dropping the rest would import an agent that silently stops being the one the
 * user tuned, so the name is printed instead.
 *
 * **`mode` is deprecated in the product's own words** — `config/config.ts:181-189`
 * carries `@deprecated Use \`agent\` field instead` — and it is the same shape:
 * `{build: AgentRef, plan: AgentRef}`, which agent handles which posture. There
 * is no permission meaning in it at all.
 *
 * **`{mode,modes}/*.md`** (`config/agent.ts:166`) are the same idea as files. A
 * mode is a posture rather than a persona, and a subagent file has nowhere to put
 * one.
 */
function planMiMoCodeAgentEntries(raw: RawMiMoCode, items: MigrationItem[]): void {
	if (raw.settings === null) return;
	for (const key of ["agent", "mode"]) {
		const value = raw.settings[key];
		if (value === undefined) continue;
		const names = Object.keys(isRecord(value) ? value : {});
		items.push({
			source: SOURCE,
			from: mimocodeFrom(raw, key),
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(names, 8)} — a MiMo Code ${key} entry is a record whose \`prompt\` is the agent's whole system ` +
				"prompt alongside model, temperature, steps, permission and a free-form options block, and a subagent file here " +
				"carries a name, a description, a model and a body with no field for the rest. Copying the prompt and dropping " +
				"the settings would import an agent that is silently not the one you tuned, so only the names are held here" +
				(key === "mode"
					? ". `mode` is deprecated in MiMo Code's own schema in favour of `agent` (config/config.ts:186)"
					: ""),
			containsSecret: false,
		});
	}
	// `{mode,modes}/*.md` (config/agent.ts:166) — the same idea as files, and
	// named rather than read: a mode is the agent that handles a posture, and a
	// subagent file has nowhere to put one.
	if (raw.modes.length > 0) {
		items.push({
			source: SOURCE,
			from: "MiMo Code's mode files",
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(raw.modes, 8)} — \`{mode,modes}/*.md\` (config/agent.ts:166) is the same idea as \`agent\`, but a ` +
				"mode is the agent that handles a posture rather than a persona, and a subagent file here has no field for a " +
				"posture. They were named and not read",
			containsSecret: false,
		});
	}
}

/**
 * Plugins, and the two directories whose names still say `opencode`.
 *
 * **A plugin is installed code, not a setting.** `config/plugin.ts:33-38` globs
 * `{plugin,plugins}` for `*.ts` and `*.js` and turns each hit into a
 * `pathToFileURL(item).href`, which the engine **imports at start-up**. Copying
 * the path into `settings.json` would import a server or an agent that does not
 * exist here; copying the contents would be running another product's program
 * against this one's configuration. The name is the whole of what is carried.
 *
 * **The managed-config directories are still named `opencode`** —
 * `/etc/opencode`, `/Library/Application Support/opencode`,
 * `%ProgramData%\opencode` (`config/managed.ts:23-36`) — because the rename to
 * MiMo Code did not reach that function. Grepping the tree for `mimocode` misses
 * all three. They belong to whoever deployed the machine and are overwritten on
 * the next policy push, so they are named here and never read: MDM territory.
 */
function planMiMoCodePlugins(raw: RawMiMoCode, items: MigrationItem[]): void {
	if (raw.plugins.length === 0) return;
	items.push({
		source: SOURCE,
		from: "MiMo Code's plugin directories",
		to: "—",
		action: "skip",
		detail:
			`${summarizeNames(raw.plugins, 8)} — a MiMo Code plugin is an installed module: config/plugin.ts:33-38 globs ` +
			"`{plugin,plugins}` for `*.ts` and `*.js` and turns each hit into a file URL the engine imports at start-up, so its " +
			"skills, agents, hooks and MCP servers live inside it rather than beside it. Copying the name would import a server " +
			"or an agent that does not exist here, and the files were not read either. Install them here by hand",
		containsSecret: false,
	});
}

/**
 * The MDM directories, named **unconditionally**.
 *
 * **Split out of {@link planMiMoCodePlugins} because it is not conditional on
 * anything.** An earlier version of this line sat inside the
 * `plugins.length > 0` guard, so a MiMo Code with no plugin directory and an
 * administrator pushing managed configuration printed nothing about it — and
 * "the report said nothing" is the state this line exists to prevent, since the
 * directory's name is the only evidence there is.
 */
function planMiMoCodeManagedConfig(items: MigrationItem[]): void {
	items.push({
		source: SOURCE,
		from: mimocodeManagedConfigDir("linux", undefined),
		to: "—",
		action: "skip",
		detail:
			"the managed-configuration directories are still named `opencode` — `/etc/opencode`, " +
			"`/Library/Application Support/opencode` and `%ProgramData%\\opencode` (config/managed.ts:23-36) — because the rename " +
			"to MiMo Code did not reach that function, so grepping the tree for `mimocode` misses all three. They are " +
			"machine-managed state that belongs to whoever deployed this machine and is overwritten on the next policy push, so " +
			"they are named and never read",
		containsSecret: false,
	});
}

/**
 * The four skill trees MiMo Code borrows, each named and **none imported**.
 *
 * `skill/index.ts:26` is `[".claude", ".codex", ".opencode", ".agents"]`, scanned
 * at `<home>/<dir>/skills` (`:232-235`) and at every `<dir>` walking **up** from
 * the working directory (`:257-261`), so a MiMo Code install sees three other
 * products' skills with nothing configured. `:34-42` keeps `.agents` on unless
 * `MIMOCODE_DISABLE_AGENTS_SKILLS` is set and gates the other three behind
 * `MIMOCODE_ENABLE_{CLAUDE_CODE,CODEX,OPENCODE}_SKILLS`.
 *
 * **This importer reads none of them, and `.agents` is the reason that is a rule
 * rather than an accident.** `~/.agents` is a tree this repository **already
 * migrates**, as its `agents` source. Importing it here as well would write every
 * one of the user's skills twice — once attributed to `agents` and once to
 * `mimocode-code` — and both report lines would say they were imported. That is
 * the same bug `KIMI_SHARED_TREE` in `kimi-read.ts` exists to prevent, reached the
 * same way by a product that harvests the shared tree.
 *
 * **The other three are named rather than imported for a second reason:** they are
 * other products' files, and two of them (`claude-code`, `codex`) are sources this
 * repository already migrates — so importing them here would file them under the
 * wrong product's name *as well as* double-importing them. `.opencode` is the one
 * with no importer of its own (`opencode-read.ts` harvests that tree for its
 * inventory and imports providers, MCP and `AGENTS.md`, not `skills/`), and the
 * line says "by hand" for it rather than pointing at a source that will not do it.
 *
 * **A line per tree per root, and only when the tree exists.** `existsSync` and
 * nothing more: the point is to name a directory the user can go and look at, and
 * a directory that is not there is not worth a row.
 */
function planMiMoCodeVendorSkills(raw: RawMiMoCode, items: MigrationItem[]): void {
	const roots = raw.cwd === null ? [raw.home] : [raw.home, raw.cwd];
	for (const vendor of MIMOCODE_VENDOR_SKILL_DIRS) {
		for (const root of roots) {
			const dir = join(root, vendor.dir, "skills");
			if (!existsSync(dir)) continue;
			const flag = vendor.onByDefault ? vendor.disableEnv : vendor.enableEnv;
			const overridden = flag !== null && raw.env[flag] !== undefined && raw.env[flag] !== "";
			const where = vendor.onByDefault ? "and it is on unless you set" : "and it is off unless you set";
			items.push({
				source: SOURCE,
				from: tildePath(raw.home, dir),
				to: "—",
				action: "skip",
				detail:
					`${vendor.dir}/skills is ${vendor.owner}'s, not MiMo Code's — \`skill/index.ts:26\` lists it among the four ` +
					`trees it harvests for cross-tool portability (${MIMOCODE_VENDOR_SKILL_DIRS.map((one) => one.dir).join(", ")}), ` +
					`${where} \`${flag}\`. ` +
					(vendor.labunbunSource === null
						? "No source in this repository imports that tree, so nothing came across from it — copy the folders over by hand"
						: `This repository already imports it as \`${vendor.labunbunSource}\`, so importing it here as well would write ` +
							"every one of them twice under two different product names while both report lines claimed the copy") +
					(overridden ? ` — and \`${flag}\` is set in this run, so MiMo Code is not reading it either` : ""),
				containsSecret: false,
			});
		}
	}
}

/**
 * The TUI layer, the two other instruction documents, and the credential files.
 *
 * **The `tui.json` sentence is the one a user is most likely to need**, because
 * this build has no keybinds at all and a report that said nothing would read as
 * "there was no TUI configuration".
 *
 * **The other two instruction documents are named rather than read, and for two
 * different reasons.** `CLAUDE.md` is *also* MiMo Code's own
 * (`session/instruction.ts:19`), but the one this importer names is
 * `~/.claude/CLAUDE.md` — a **fourth source's file**, which this repository
 * already migrates as `claude-code`. Importing it here would land a second copy of
 * the same instructions under a different product's name. `CONTEXT.md` is the
 * third entry in the same array and the source's own comment calls it deprecated.
 */
function planMiMoCodeTui(raw: RawMiMoCode, items: MigrationItem[]): void {
	if (raw.tui === null) return;
	items.push({
		source: SOURCE,
		from: tildePath(raw.home, raw.tui.path),
		to: "—",
		action: "skip",
		detail:
			`${raw.tui.keys} key(s) of TUI configuration — keybinds and presentation, and this build has no analogue for ` +
			'either, so nothing came across. It is read because "there is a tui.json and none of it applies here" is a ' +
			'sentence a user is owed and "nothing was found" is not',
		containsSecret: false,
	});
	if (raw.tuiConfigEnvPath !== null) {
		items.push({
			source: SOURCE,
			from: raw.tuiConfigEnvPath,
			to: "—",
			action: "skip",
			detail:
				"$MIMOCODE_TUI_CONFIG, named and not read. It is merged *after* `<config>/tui.json(c)` and *before* the project " +
				"files (cli/cmd/tui/config/tui.ts:110-115), so a line about the TUI document above describes the wrong file for " +
				"every key this one sets. Its contents are TUI configuration on either side of that boundary, so nothing was lost",
			containsSecret: false,
		});
	}
	items.push({
		source: SOURCE,
		from: mimocodeVendoredClaudeMd(raw.home),
		to: "—",
		action: "skip",
		detail:
			"named and not read, and it is **another source's file**: `~/.claude/CLAUDE.md` is on MiMo Code's global instruction " +
			"list (session/instruction.ts:28-36) and this repository already migrates `~/.claude` as `claude-code`. Importing it " +
			"here would land a second copy of the same instructions under a different product's name",
		containsSecret: false,
	});
	items.push({
		source: SOURCE,
		from: "CONTEXT.md",
		to: "—",
		action: "skip",
		detail:
			"`CONTEXT.md` is the third name in MiMo Code's instruction list and its own source marks it `// deprecated` " +
			"(session/instruction.ts:21), so it was not read as an instruction document. A file by that name next to your code is " +
			"read by MiMo Code — copy it over by hand if it holds instructions you want",
		containsSecret: false,
	});
}

/**
 * The credential-bearing files and tables, named.
 *
 * **Nothing here is opened, and the sentence says so rather than implying the
 * importer checked.** `auth.json` holds every provider key and OAuth refresh token
 * in the install and is written with mode `0o600` (`auth/index.ts:9,96-98`);
 * `mcp-auth.json` holds per-server OAuth entries (`mcp/auth.ts:32`); the `account`
 * table holds `email`, `url`, `access_token` and `refresh_token`
 * (`account/account.sql.ts:6-17`); `session_share` holds `id`, `secret` and `url`
 * (`share/share.sql.ts:5-12`), and that `secret` is the bearer half of a share
 * link.
 *
 * **Re-authenticate by hand rather than importing these.** A migration that
 * copied an access token would also have to explain why it is in two files now.
 */
function planMiMoCodeCredentials(raw: RawMiMoCode, items: MigrationItem[]): void {
	for (const entry of raw.credentials) {
		if (!entry.exists) continue;
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, entry.path),
			to: "—",
			action: "skip",
			detail:
				`not opened — it holds ${entry.holds}. A migration report is something a user may paste into an issue, so the ` +
				"name is the whole of what is carried here; sign in again here and the credentials arrive through the product's " +
				"own login rather than through a file this importer wrote",
			containsSecret: false,
		});
	}
	items.push({
		source: SOURCE,
		from: `<database> → ${MIMOCODE_CREDENTIAL_TABLES.join(", ")}`,
		to: "—",
		action: "skip",
		detail:
			"tables inside the session database that hold credentials and were not read: `account` carries email, url, " +
			"`access_token` and `refresh_token` (account/account.sql.ts:6-17) and `session_share` carries `id`, `secret` and `url` " +
			"(share/share.sql.ts:5-12), where the secret is the bearer half of a share link",
		containsSecret: false,
	});
}

/**
 * The legacy keys, the inline-config channels, and the database.
 *
 * **The legacy-key line is the one that earns its place.** `history`,
 * `auto_worktree`, `theme`, `keybinds` and `tui` are deleted from every loaded
 * document before `Info` — which is `.strict()` — ever sees it
 * (`config/config.ts:61-75` and `:500`). So a user who wrote `theme` is looking
 * at a key **nothing reads**, including MiMo Code itself, and the migration is
 * the moment to say so. Reporting it as an "unhandled key" would be a weaker and
 * vaguer sentence about the same fact.
 *
 * **`MIMOCODE_CONFIG_CONTENT` and `MIMOCODE_CONFIG_DEFAULTS` are not read**, and
 * the reason is worth one line: they are inline JSON **in the environment**, so
 * reading them would mean parsing an arbitrary value a parent process chose to
 * export, and a report cannot attribute a document to a file. Same for
 * `MIMOCODE_AUTH_CONTENT`, which `auth/index.ts:76` still reads as a fallback —
 * though `util/credential-env.ts:15` deliberately strips it from the environment of
 * every child the engine spawns, on the grounds that any child could otherwise
 * read the whole `auth.json` out of it.
 */
function planMiMoCodeLeftovers(raw: RawMiMoCode, items: MigrationItem[]): void {
	if (raw.rejectedHome !== null) {
		items.push({
			source: SOURCE,
			from: "MIMOCODE_HOME",
			to: "—",
			action: "skip",
			detail: raw.rejectedHome,
			containsSecret: false,
		});
	}

	for (const entry of raw.legacyKeys) {
		items.push({
			source: SOURCE,
			from: `${entry.path} → ${entry.key}`,
			to: "—",
			action: "skip",
			detail:
				`no longer read by anything, including MiMo Code itself: \`${entry.key}\` is one of the five keys \`normalizeLoadedConfig\` ` +
				"deletes from every document before the schema validates it (config/config.ts:61-75), and `Info` is `.strict()` " +
				"(config.ts:500) so a file carrying it would otherwise be refused outright" +
				(entry.key === "theme" || entry.key === "keybinds" || entry.key === "tui"
					? entry.key === "tui"
						? ". This document is that document, so reading it changes nothing about what is in force here"
						: `. The ${entry.key} settings moved to \`tui.json\``
					: ""),
			containsSecret: false,
		});
	}

	for (const name of ["MIMOCODE_CONFIG_CONTENT", "MIMOCODE_CONFIG_DEFAULTS", "MIMOCODE_AUTH_CONTENT"]) {
		const value = raw.env[name];
		if (value === undefined || value === "") continue;
		items.push({
			source: SOURCE,
			from: name,
			to: "—",
			action: "skip",
			detail:
				"set, and not read — it is inline JSON **in the environment** rather than a file, so a report cannot attribute a " +
				"document to a location and any value here was chosen by whatever process exported it. Copy anything you need out " +
				"of it by hand; the settings it holds are the same keys the other files carry",
			containsSecret: false,
		});
	}

	if (raw.database === null) {
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, raw.roots.data)}/mimocode.db`,
			to: "—",
			action: "skip",
			detail:
				"no session database was found at the name MiMo Code uses. `storage/db.ts:33-45` writes `mimocode.db` for the " +
				"latest, beta and prod channels and `mimocode-<channel>.db` for anything else, and a build installed from a nightly " +
				"has a channel name no reader can know — so the data root was listed and matched instead. If $MIMOCODE_DB is set to " +
				"`:memory:` there is no file to read at all, and nothing is kept between runs",
			containsSecret: false,
		});
	} else {
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, raw.database.path),
			to: "—",
			action: "skip",
			detail: raw.database.exists
				? `the session database, named and not read here — it is a SQLite file MiMo Code writes in WAL mode (storage/db.ts:93, so \`${raw.database.sidecars
						.map((one) => one.split(/[\\/]/).pop())
						.filter(Boolean)
						.join(
							"` and `",
						)}\` sit beside it), and its conversations are imported through the history path when history is in scope`
				: "the name MiMo Code would use for its session database, and it is not there",
			containsSecret: false,
		});
	}

	const derived = MIMOCODE_DERIVED_TABLES.join(", ");
	items.push({
		source: SOURCE,
		from: `<database> → ${derived}`,
		to: "—",
		action: "skip",
		detail:
			`\`${derived}\` inside the session database and not read as content. \`history_fts\` is SQLite's full-text shadow ` +
			"over the message bodies — the text in it is a copy of what `message.data` already says, so reading it would duplicate " +
			"every turn and present the duplicates as separate messages. `external_import` is a record of what a past import did",
		containsSecret: false,
	});

	// Unhandled keys are reported **per layer**, not over the merged document: the
	// merged document's top-level keys are the union of every file's, so one line
	// over it would name each file's unhandled keys against whichever file the user
	// reads first.
	for (const layer of raw.settingsLayers) {
		reportUnhandledKeys(SOURCE, layer.settings, MIMOCODE_SETTINGS_HANDLED, tildePath(raw.home, layer.path), items);
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

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

/**
 * Assemble the plan.
 *
 * Every parameter is one something below uses: `claimScalar` for the one model,
 * `addPermissionRules` for the allow/deny pairs, and
 * `mcpServers`/`markMcpSecret`/`existingMcpServers`/`force` for the one place a
 * credential could still reach a written file.
 *
 * **There is no `claimModePair` and no `claimEnv`, and both absences are
 * load-bearing.** MiMo Code has no permission *mode* at all — `permission` is a
 * rule map whose unmatched default is `ask` (`permission/evaluate.ts:14`) — so
 * there is no mode+sandbox pair to claim and importing one would write a posture
 * the user never stated. And the 41-key document has no `env` block, so there is
 * nothing to carry into `settings.env`.
 */
export function planMiMoCode(
	raw: RawMiMoCode,
	items: MigrationItem[],
	writes: PlannedWrite[],
	claimScalar: ClaimScalar,
	addPermissionRules: AddPermissionRules,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	planMiMoCodeModel(raw, items, claimScalar);
	planMiMoCodeOtherModels(raw, items);
	planMiMoCodePermissions(raw, items, addPermissionRules);
	planMiMoCodeMcp(raw, items, mcpServers, markMcpSecret, existingMcpServers, force);
	planMiMoCodeAssets(raw, force, items, writes);
	planMiMoCodeAgentEntries(raw, items);
	planMiMoCodePlugins(raw, items);
	planMiMoCodeManagedConfig(items);
	planMiMoCodeVendorSkills(raw, items);
	planMiMoCodeTui(raw, items);
	planMiMoCodeCredentials(raw, items);
	planMiMoCodeLeftovers(raw, items);
}
