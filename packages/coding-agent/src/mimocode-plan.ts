// MiMo Code's configuration in the target's shape: the model, the permission rules,
// the MCP servers, the skills, the agents, the commands and the memory.
// Long-form design notes: docs/dev/migration-sources.md

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

// Long-form design notes: docs/dev/migration-sources.md
/** Top-level keys of the settings document this mapper accounts for. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The layer a report line names in prose rather than by its enum value. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** MiMo Code's permission verbs → this build's tool names. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `model` → this build's `model`, when the reference resolves. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `small_model`, `vision_model` and `model_groups` — named, never claimed. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `permission` → this build's allow/deny rules, through `fromConfig`'s own shape. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The keys MiMo Code's own schema accepts on an MCP entry, verbatim. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `{env:VAR}` and `{file:path}` in a value, verbatim from `config/variable.ts:32-45`. */
const MIMOCODE_PLACEHOLDER = /\{(?:env|file):[^}]+\}/;

/** Whether this build would expand a `{env:…}` or `{file:…}` at all. It would not. */
function placeholderIn(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = MIMOCODE_PLACEHOLDER.exec(value);
	return match === null ? null : match[0];
}

// Long-form design notes: docs/dev/migration-sources.md
/** One MCP server from `settings.mcp` → this build's server shape. */
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
			// Long-form design notes: docs/dev/migration-sources.md
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

// Long-form design notes: docs/dev/migration-sources.md
/** Skills, agents and commands. */
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

	// Long-form design notes: docs/dev/migration-sources.md
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

// Long-form design notes: docs/dev/migration-sources.md
/** Plugins, and the two directories whose names still say `opencode`. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The MDM directories, named **unconditionally**. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The four skill trees MiMo Code borrows, each named and **none imported**. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The TUI layer, the two other instruction documents, and the credential files. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The credential-bearing files and tables, named. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The legacy keys, the inline-config channels, and the database. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Assemble the plan. */
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
