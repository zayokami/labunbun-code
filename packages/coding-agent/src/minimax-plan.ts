/**
 * MiniMax Code's configuration in the target's shape: permission modes, the
 * decoded rule list, providers, MCP servers, and the asset trees.
 */

import { join } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import {
	collectFileWrites,
	isRecord,
	mergeProviderSpecs,
	placeholderNote,
	planMemoryAsRule,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
} from "./migrate-core.ts";
import type { AddPermissionRules, ClaimScalar, MigrationItem, PlannedWrite } from "./migrate-types.ts";
import { looksLikeSecretName, resolveModelReference } from "./migrate-types.ts";
import {
	MINIMAX_DATA_DIR_BASENAME,
	MINIMAX_INSTALL_DIR,
	MINIMAX_LEGACY_DATA_DIR_BASENAME,
	MINIMAX_PROJECT_INSTRUCTION_FILES,
	MINIMAX_PROJECT_MCP_FILE,
	minimaxAgentsDir,
	minimaxConfigPath,
	minimaxGlobalInstructionsPath,
	minimaxMcpAliasFile,
	minimaxMcpFile,
	minimaxMemoryDir,
	minimaxPermissionFile,
	minimaxPlansDir,
	minimaxPluginsDir,
	minimaxV2Root,
} from "./minimax-home.ts";
import type { RawMinimaxCode } from "./minimax-read.ts";
import { MINIMAX_BUILTIN_AGENTS_DIR, MINIMAX_BUILTIN_SKILLS_DIR, MINIMAX_MCP_FILE_NAME } from "./minimax-read.ts";
import type { RawSettingsInput } from "./settings.ts";
import { OpenAICompatibleProviderSchema } from "./settings.ts";

/**
 * The top-level keys of MiniMax's `config.yaml` that this run does not import,
 * each with the reason it does not.
 *
 * The list is the whole interface — every key `Config` declares
 * (`config.ts:928-1030`) minus the six that are planned above and the eleven
 * computed paths below — so a key that is *not* here and not planned shows up in
 * the unhandled-key sweep at the end instead of vanishing. MiniMax's own file is
 * allowed to be a partial table, and this build's reader keeps the raw parse, so
 * the sweep sees keys this list has never heard of.
 *
 * Some of these are feature switches the user genuinely set. They are still not
 * imported, because what they switch on has no counterpart here — and saying
 * which is the point: "your `skillEvolve` setting is not here" is information,
 * while silence would read as "you never set one".
 */
const MINIMAX_UNMIGRATED_SECTIONS: Array<[key: string, reason: string]> = [
	["logLevel", "MiniMax's own log verbosity, and this build has no setting for it"],
	["devPort", "the port MiniMax's web/desktop shell listens on — there is no such shell here"],
	[
		"sseErrorPush",
		"whether MiniMax pushes a stream error into its UI history and its event stream — a display decision of its own shell",
	],
	["notifications", "desktop notifications for MiniMax's own shell"],
	[
		"beta",
		"MiniMax's build-variant feature flags, resolved per build rather than set by you — not a preference that travels",
	],
	[
		"agents",
		"per-agent capability overrides for the agents MiniMax defines itself (which tools, built-in skills and features each may use) — there are no per-agent settings here; the agents themselves come across as files",
	],
	[
		"memory",
		"MiniMax's own memory feature switch (whether it keeps long-term notes, and whether it digests them daily) — nothing here reads that layout, and the notes themselves are named separately",
	],
	[
		"skillEvolve",
		"MiniMax's skill self-improvement loop: a background pass that rewrites your skills from signals it collects — a feature of that runtime",
	],
	[
		"sessionRotate",
		"when MiniMax starts a fresh session instead of continuing an old one — how long a session lives is yours to decide here",
	],
	["agentStop", "the debounce and maximum span of MiniMax's stop detector"],
	["asr", "cloud speech-to-text — there is no voice input here"],
	[
		"skills",
		"MiniMax's unified skill-ingestion switches: whether it scans *other tools'* skill trees (`~/.claude`, `~/.codex`, `~/.agents`), how far up a project it walks to find them, and which source wins a name collision — those trees belong to the sources this migrator already has",
	],
	[
		"askUser",
		"MiniMax's switch for its own interactive-question feature — the equivalent here is a tool, and it exists regardless",
	],
	["sessionTitle", "whether MiniMax has a model title your sessions — no titles are generated here"],
	["cli", "whether MiniMax lets an agent spawn its own CLI — a capability of that runtime"],
	["browser", "MiniMax's bundled browser automation — there is no browser tool here"],
	[
		"tui",
		"MiniMax's terminal UI preferences (its status line, tips, notification method) — this build's own UI has its own",
	],
	["telemetry", "usage metrics and diagnostics, off by default — this build has no such switch"],
	[
		"opencode",
		"MiniMax's OpenCode adapter: a data-isolation mode and process keep-alive tuning for a tool it can host",
	],
	[
		"contextManagement",
		"which models skip its system reminder, and how many screenshots its computer-use backend may hold — both count things this build does not have",
	],
	["runawayGuard", "MiniMax's guard against a runaway loop — this build has its own"],
	["agentRuntime", "which agent framework MiniMax runs sessions on — not a preference that transfers"],
	["logRetentionDays", "how long MiniMax keeps its logs, which are not imported either"],
	["cuBackend", "MiniMax's computer-use backend selection — there is no computer use here"],
	["review", "whether MiniMax's code reviewer runs inline or as a subagent — there is no reviewer here"],
	["promptConfig", "whether MiniMax updates its own system prompt automatically"],
	[
		"goal",
		"MiniMax's goal mode: a standing objective it carries across turns with its own evaluator, budget and breaker — nothing here reads that state, and the documents it keeps are named separately",
	],
	[
		"sandbox",
		"MiniMax's sandbox posture (what a command may reach, what is mounted) — a property of that runtime; the equivalent decisions here are permission rules, and those are imported from `permission.json`",
	],
	[
		"goalWarnings",
		"what MiniMax's own parser wrote back about the goal block — an output of the file rather than a key you set",
	],
	["minimaxModelSource", "which of MiniMax's model sources to bill — an account route, not a model choice"],
	["defaultModelVariant", "a variant of the default model — this build has no variant dimension"],
	[
		"defaultModelThinking",
		"the thinking depth MiniMax applies to the default model — thinking is set here when a model is asked for, not in settings",
	],
	[
		"defaultModelContextWindow",
		"a context-window override for the default model — the window comes from the model table here",
	],
	["defaultLightModel", "the model MiniMax uses for cheap background work — this build picks one per call"],
	["minimaxModelContextLimits", "per-model context-window overrides for MiniMax's own catalogue"],
	["nexus", "MiniMax's hub connection: a remote endpoint and the model to use with it"],
	["contentReview", "a content-review endpoint MiniMax can route prompts through"],
	["mcpToolSearch", "how MiniMax narrows a large MCP tool list before the model sees it"],
	[
		"permission",
		"runtime knobs for MiniMax's permission engine — who owns the policy, how long its classifier may take, whether it prompts you. These are not rules: the rules live in `permission.json` and are imported from there",
	],
];

/**
 * Keys MiniMax *computes* and overwrites on every read
 * (`config.ts:2073-2083`, where each is `join(dataDir, …)`).
 *
 * A value for one of these in the file is ignored on that side too, which is why
 * they are answered together rather than given a reason each: eleven copies of
 * "MiniMax recomputes this" would drown the sections that carry a decision.
 * `dataDir` itself is the root the others hang off, and it comes from
 * `$MINIMAX_DATA_DIR` rather than from the file.
 */
const MINIMAX_COMPUTED_PATHS: string[] = [
	"dataDir",
	"agentsDir",
	"sessionsDir",
	"memoryDir",
	"skillsDir",
	"builtinSkillsDir",
	"logsDir",
	"pluginsDir",
	"plansDir",
	"harnessesDir",
	"subAgentsDir",
];

/**
 * MiniMax's permission mode names, and what each one means over there.
 *
 * The two mode sets were designed against the same four meanings, so this is
 * nearly one-to-one — but two of MiniMax's six values are not imported, and
 * neither is the one a reader would guess:
 *
 *   - `off` is a second spelling of `bypassPermissions` in MiniMax's own code
 *     rather than a third posture: `modeToAskPolicy` sends both to "always
 *     allow" (`ask-policy.ts:22-36`, where the comment reads "PermissionMode
 *     'bypassPermissions' / 'off'"), and the facade rewrites `off` into
 *     `bypassPermissions` before its engine sees the mode (`facade.ts:563-566`).
 *     It travels as the name this build has for it;
 *   - `auto` stays behind: it is a classifier that approves what it judges safe,
 *     and the nearest mode here — `dontAsk` — means the opposite;
 *   - `acceptEdits` travels, with a note, because MiniMax's own readers disagree
 *     about it. The runtime's reader accepts it (`readLocalPermissionMode`,
 *     `local-runtime/src/api/host-helpers.ts:545-554`) and so does the writer
 *     that persists this key (`LOCAL_PERMISSION_MODES`, `config/update.ts:42-48`),
 *     while the reader the bundled config goes through does not list it at all
 *     and falls back to `auto` (`config.ts:2053-2059`). Its documented meaning
 *     there — "default plus pre-seeded edit/write allow rules" (`ask-policy.ts:44-45`)
 *     — is this build's mode of the same name, so the value is carried as
 *     written and the split is named in the report rather than guessed away;
 *   - `dontAsk` is *not* imported. It is a live session mode in MiniMax, reached
 *     through `setMode` and listed by the permission-scope store
 *     (`plugin-hook-permission-state.ts:76-84,232`), and no reader of *this file*
 *     accepts it anywhere, so a `config.yaml` carrying it runs as `auto` over
 *     there. Writing it here would set a posture the source never had — the same
 *     line the rules below draw for a store MiniMax itself refuses to read.
 */
const MINIMAX_PERMISSION_MODES: Record<string, string> = {
	default: "default",
	bypassPermissions: "bypassPermissions",
	off: "bypassPermissions",
	acceptEdits: "acceptEdits",
};

/** `config.yaml → permissionMode`. */
function planMinimaxPermissionMode(
	raw: RawMinimaxCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
): void {
	const from = `${tildePath(home, minimaxConfigPath(raw.root))} → permissionMode`;
	const mode = typeof raw.config.permissionMode === "string" ? raw.config.permissionMode.trim() : "";
	if (mode === "") return;
	const mapped = MINIMAX_PERMISSION_MODES[mode];
	if (mapped !== undefined) {
		const detail =
			mode === "off"
				? 'mapped to "bypassPermissions", which is what MiniMax itself calls it — its ask policy sends both spellings to "always allow"'
				: mode === "acceptEdits"
					? 'mapped to "acceptEdits"; MiniMax\'s runtime reader accepts this value where the reader its bundled config goes through would run the session as "auto"'
					: `mapped to "${mapped}"`;
		claimScalar("minimax-code", "permissionMode", mapped, `${from} ("${mode}")`, detail);
		return;
	}
	if (mode === "auto") {
		items.push({
			source: "minimax-code",
			from: `${from} ("auto")`,
			to: "—",
			action: "skip",
			detail:
				'"auto" is a classifier that approves the calls it judges safe, and the nearest mode here, dontAsk, does the ' +
				"opposite — anything not explicitly allowed is denied — so the session keeps whatever mode it would otherwise start in",
			containsSecret: false,
		});
		return;
	}
	if (mode === "dontAsk") {
		items.push({
			source: "minimax-code",
			from: `${from} ("dontAsk")`,
			to: "—",
			action: "skip",
			detail:
				"MiniMax has this mode, but none of the readers that open this file accept it — a config.yaml carrying it runs as " +
				'"auto" there, so writing it here would put a stricter posture in force than the one you actually had',
			containsSecret: false,
		});
		return;
	}
	items.push({
		source: "minimax-code",
		from: `${from} ("${mode}")`,
		to: "—",
		action: "skip",
		detail: "not a mode MiniMax reads, so it never decided a session — the permission mode is left as it is",
		containsSecret: false,
	});
}

/**
 * `permission.json`, as rules this build's engine will consult.
 *
 * Nothing is taken out of a file MiniMax refuses — {@link readMinimaxPermissions}
 * has already answered that question, and a refusal here is a report line rather
 * than an empty rule list.
 *
 * The caveat is the one every source with a command grammar needs, and the
 * `:*` rewrites are the part of it that cannot be expressed as a caveat: see
 * {@link MinimaxPermissions.widened}.
 */
function planMinimaxPermissions(
	raw: RawMinimaxCode,
	home: string,
	items: MigrationItem[],
	addPermissionRules: AddPermissionRules,
): void {
	const from = tildePath(home, minimaxPermissionFile(raw.root));
	if (raw.permissionError !== undefined) {
		items.push({
			source: "minimax-code",
			from,
			to: "—",
			action: "skip",
			detail: `${raw.permissionError}`,
			containsSecret: false,
		});
		return;
	}
	const { allow, deny, askCount, version, notCarried, widened } = raw.permissions;
	const caveat =
		`permission.json v${version}: a command pattern matches a word-boundary prefix in MiniMax and is refused there for any ` +
		"command that chains (`;`, `&&`, `|`, a substitution), where this build matches the whole command line as a glob — so a " +
		"chained command counts as a match here";
	if (allow.length > 0) addPermissionRules("minimax-code", "allow", allow, `${from} → allow`, caveat);
	if (deny.length > 0) addPermissionRules("minimax-code", "deny", deny, `${from} → deny`, caveat);
	if (askCount > 0) {
		items.push({
			source: "minimax-code",
			from: `${from} → ask`,
			to: "—",
			action: "skip",
			detail: `${askCount} rule(s) that ask rather than decide; this build's settings hold allow and deny only, and a rule turned into an allow would decide what you asked to be asked about`,
			containsSecret: false,
		});
	}
	if (widened.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${from} → ${summarizeNames(widened, 6)}`,
			to: "settings.json → permissions",
			action: "downgrade",
			detail:
				`${widened.length} command rule(s) ended in ":*", MiniMax's "this command or its arguments" suffix. Written as-is ` +
				"they would match the literal text `:*` here and decide nothing, so they are written as a `*` glob instead: that also " +
				"matches a longer first word (`sed*` covers `sedx`) and a command that chains commands",
			containsSecret: false,
		});
	}
	if (notCarried.length > 0) {
		for (const reason of ["inert-there", "no-specifier-grammar"] as const) {
			const group = notCarried.filter((drop) => drop.reason === reason);
			if (group.length === 0) continue;
			items.push({
				source: "minimax-code",
				from: `${from} → ${summarizeNames(
					group.map((drop) => `${drop.rule} (${drop.behavior})`),
					6,
				)}`,
				to: "—",
				action: "skip",
				detail:
					reason === "inert-there"
						? `${group.length} rule(s) naming a tool MiniMax does not have, so they decide nothing there either`
						: `${group.length} rule(s) whose pattern only MiniMax's own engine reads: this build consults a specifier for ` +
							"a command, a file path and the MCP family, so a pattern on any other tool would sit in the file unread",
				containsSecret: false,
			});
		}
	}
}

/**
 * Model entries for one provider, from MiniMax's own model table.
 *
 * Both limits come from the model's own entry where it states them
 * (`ModelConfig.limit`, `config.ts:1053-1057`: `{context, input?, output}`).
 * Where it states none, MiniMax's own fallback for a user-created provider is
 * used rather than one of this importer's — 200k context and 16 384 output
 * tokens (`BYOK_FALLBACK_MODEL_LIMITS`,
 * `local-runtime/src/runtime/model-resolver-byok.ts:27-30`), and the schema here
 * requires an output limit, so "assume nothing" is not an option a report can
 * offer.
 *
 * Prices are not carried, and the reason is not that the key is missing: it is
 * that MiniMax's own runtime never reads it. Its cost reporting comes from the
 * provider's usage payload (`usage.cost.total`, `usage/api.ts:250-252`); the
 * `cost` block a model may carry in `config.yaml` prices nothing over there, so
 * there is no scale to carry it at.
 */
function minimaxModelEntries(models: unknown): {
	entries: Array<Record<string, unknown>>;
	disabled: string[];
	priced: string[];
} {
	const entries: Array<Record<string, unknown>> = [];
	const disabled: string[] = [];
	const priced: string[] = [];
	if (!isRecord(models)) return { entries, disabled, priced };
	for (const [id, spec] of Object.entries(models)) {
		if (!isRecord(spec)) continue;
		if (spec.enabled === false) {
			disabled.push(id);
			continue;
		}
		if (isRecord(spec.cost)) priced.push(id);
		const limit = isRecord(spec.limit) ? spec.limit : {};
		const context = typeof limit.context === "number" && limit.context > 0 ? Math.floor(limit.context) : 200_000;
		const output = typeof limit.output === "number" && limit.output > 0 ? Math.floor(limit.output) : 16_384;
		entries.push({
			id,
			...(typeof spec.name === "string" && spec.name.trim() !== "" ? { name: spec.name.trim() } : {}),
			contextWindow: context,
			maxOutputTokens: output,
			...(spec.reasoning === true ? { reasoning: true } : {}),
		});
	}
	return { entries, disabled, priced };
}

/**
 * `custom_provider.<key>` as `providers.openaiCompatible` entries.
 *
 * Only the user's own tree is imported, and the distinction is the reason.
 * `provider.*` is seeded by MiniMax's installer from a preset — endpoint plus
 * the vendor's model catalogue (`config.ts:1677-1706`) — and what makes it work
 * is the account's route to MiniMax's own service, which this build has no
 * equivalent of; importing it would register an endpoint the user never typed.
 * A custom provider is a table the user created in MiniMax's settings, which is
 * exactly the thing that has to move.
 *
 * No key value is read. MiniMax names the variables a provider's key may come
 * from in `env[]`, and that list is what is carried; when it names none, the
 * variable this build would read is derived from the provider key and spelled
 * out in the report so the user knows what to export.
 */
function planMinimaxProviders(
	raw: RawMinimaxCode,
	from: string,
	newIds: Map<string, string>,
	existing: RawSettingsInput,
	force: boolean,
): { specs: Array<Record<string, unknown>>; items: MigrationItem[] } {
	const items: MigrationItem[] = [];
	const specs: Array<Record<string, unknown>> = [];
	// The id a source provider lands under is derived, so a collision with a
	// provider the user already has is possible and has to be decided *here*
	// rather than left to the merge: a default model that names this provider is
	// rewritten to the derived id, and rewriting it to an id that was never
	// registered would leave settings.json pointing at whatever was already there
	// — a different endpoint answering under the same name.
	const existingIds = new Set(
		((existing.providers?.openaiCompatible ?? []) as Array<{ id?: string }>).map((provider) => provider.id),
	);
	const custom = isRecord(raw.config.custom_provider) ? raw.config.custom_provider : {};
	for (const [key, value] of Object.entries(custom)) {
		const label = `${from} → custom_provider.${key}`;
		if (!isRecord(value)) continue;
		if (value.enabled === false) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "disabled in MiniMax — enable it there first if you want it here",
				containsSecret: false,
			});
			continue;
		}
		const options = isRecord(value.options) ? value.options : {};
		const baseUrl = typeof options.baseURL === "string" ? options.baseURL.trim() : "";
		if (baseUrl === "") {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "no endpoint in its options, so there is nothing here to point a provider at",
				containsSecret: false,
			});
			continue;
		}
		const id = `minimax-${key}`;
		// `env[]` holds variable *names*, so this is a name to read and not a value
		// to copy. The fallback is this build's convention for a provider whose key
		// has no variable yet, and the report says which one it landed on.
		const named = Array.isArray(value.env)
			? value.env.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
			: [];
		const apiKeyEnv = named.length > 0 ? named[0].trim() : `${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		const models = minimaxModelEntries(value.models);
		const spec = { id, baseUrl, apiKeyEnv, models: models.entries };
		if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "its endpoint is not a usable URL for a provider entry",
				containsSecret: false,
			});
			continue;
		}
		const replacing = existingIds.has(id);
		if (replacing && !force) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: `settings.json already defines a provider with the id this would take (${id}) — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		const extras: string[] = [];
		if (replacing) extras.push(`it replaces the provider already registered as ${id}`);
		if (options.apiKey !== undefined) {
			extras.push("the key stored in its options was not read, so export it under the name below");
		}
		if (named.length === 0) extras.push(`it names no api key variable, so this build reads $${apiKeyEnv}`);
		else if (named.length > 1)
			extras.push(`it names ${named.length} variables and this build reads one, $${apiKeyEnv}`);
		if (isRecord(options.headers) && Object.keys(options.headers).length > 0) {
			extras.push("its header table has no counterpart here, so a gateway that needs one needs it by another route");
		}
		if (models.disabled.length > 0) {
			extras.push(
				`${models.disabled.length} model(s) it disables were left out (${summarizeNames(models.disabled, 4)})`,
			);
		}
		if (models.priced.length > 0) {
			extras.push(
				`${models.priced.length} model(s) declare prices, which are not carried: MiniMax itself prices a call from the ` +
					"provider's usage payload rather than from this block, so there is no scale to copy them at",
			);
		}
		specs.push(spec);
		newIds.set(`custom_provider:${key}`, id);
		items.push({
			source: "minimax-code",
			from: label,
			to: `settings.json → providers.openaiCompatible[${id}] (${models.entries.length} model(s))`,
			action: "map",
			detail: extras.length > 0 ? extras.join("; ") : "its endpoint and model list copied",
			containsSecret: false,
		});
	}
	return { specs, items };
}

/**
 * `mcp.json`'s server shape → this build's.
 *
 * The two are close: the wrapper is the same `{"mcpServers": {…}}`, `stdio`
 * means the same two fields, and `streamable-http` is what this build calls
 * `http`. What does not come across is named per server rather than dropped,
 * because every one of them is a key the user set:
 *
 *   - `auth` holds credentials for a remote server. It is never opened; a server
 *     that authenticates by having one was authorised there and has to be
 *     authorised here again;
 *   - `timeout`, `description`, `metadata` and `tools` are MiniMax's own
 *     bookkeeping for the server, and a `tools` list that narrows what the
 *     server may expose is a real decision this build cannot make;
 *   - `cwd` is not a field MiniMax reads at all, so carrying it would import a
 *     value the source itself ignores.
 */
function normalizeMinimaxMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const type = typeof entry.type === "string" ? entry.type : "";
	const command = typeof entry.command === "string" ? entry.command.trim() : "";
	const url = typeof entry.url === "string" ? entry.url.trim() : "";
	const extras: string[] = [];
	for (const key of ["timeout", "description", "metadata", "tools"]) {
		if (entry[key] !== undefined) extras.push(key);
	}
	if (isRecord(entry.auth) && Object.keys(entry.auth).length > 0) {
		downgrades.push("it authenticates with credentials that are neither read nor carried — authorise it again here");
	}
	const out: Record<string, unknown> =
		type === "stdio" || (type === "" && command !== "") ? { type: "stdio", command } : { type: "http", url };
	if (type === "stdio" || (type === "" && command !== "")) {
		if (command === "") return null;
		out.args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
		if (isRecord(entry.env)) out.env = entry.env;
		if (entry.cwd !== undefined)
			downgrades.push("its `cwd` is not a field MiniMax reads either, so it was not carried");
		if (entry.headers !== undefined) {
			downgrades.push("headers on a stdio server have no meaning here and were not carried");
		}
	} else {
		if (url === "") return null;
		if (type === "sse") {
			downgrades.push("it is an SSE server, and the MCP client here connects over stdio or StreamableHTTP only");
		}
		if (isRecord(entry.headers)) out.headers = entry.headers;
		if (entry.env !== undefined) {
			downgrades.push("an env table on a remote server is not read by MiniMax either, so it was not carried");
		}
	}
	if (extras.length > 0) {
		downgrades.push(`MiniMax's own ${summarizeNames(extras)} setting(s) for it have no counterpart here`);
	}
	const placeholder = placeholderNote(out);
	if (placeholder) downgrades.push(placeholder);
	return { config: out, downgrades };
}

/**
 * `config.yaml`, its MCP file and the permission posture.
 *
 * The order of the sections follows the file, so a reader comparing the report
 * with their own `config.yaml` finds the keys in the same order. The provider
 * table is built before the default model is resolved but reported after it,
 * for the same reason: the default model can point *into* a provider that is
 * being imported, and the id it has to be rewritten to only exists once that
 * provider has been read.
 *
 * `permission.json` is a separate file but not a separate section of the report:
 * the mode from `config.yaml` and the rules from `permission.json` are one
 * posture, and they are read in that order for the same reason MiniMax is — the
 * mode decides what happens to a call no rule covers, so the rules mean nothing
 * until it is known.
 */
export function planMinimaxCode(
	raw: RawMinimaxCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
	addPermissionRules: AddPermissionRules,
): void {
	const from = tildePath(home, minimaxConfigPath(raw.root));
	if (raw.configError !== undefined) {
		items.push({
			source: "minimax-code",
			from,
			to: "—",
			action: "skip",
			detail: `${raw.configError} — nothing in this file was read, so this report is missing whatever it held`,
			containsSecret: false,
		});
	}
	const config = raw.config;

	// Providers are read first so a default model naming one can be resolved to
	// the id this build will register. Their report lines are emitted in file
	// order, below the default model.
	const newIds = new Map<string, string>();
	const providers = planMinimaxProviders(raw, from, newIds, existing, force);

	// ── defaultModel ─────────────────────────────────────────────────────────
	if (config.defaultModel !== undefined) {
		const raw_model = typeof config.defaultModel === "string" ? config.defaultModel.trim() : "";
		const label = `${from} → defaultModel (${JSON.stringify(config.defaultModel)})`;
		// MiniMax spells a reference `providerID/modelID` (`parseSourceQualifiedModelKey`,
		// `local-runtime/src/config/model-key.ts:46-55`, splits on the first slash), and
		// for a user-created provider the provider id is the qualified form
		// `custom_provider:<key>` (:38-42). So a reference into a provider being
		// imported has to be rewritten to the id that provider is registered under.
		//
		// The rewritten reference is deliberately *not* run through the model
		// registry: a provider from settings is registered when the app starts
		// (`applyCatalogSettings`), not while this plan is being built, so the
		// registry would answer "no such model" for a reference that is in fact
		// about to resolve. What is checked instead is that the model is one the
		// provider itself lists.
		const slash = raw_model.indexOf("/");
		const providerId = slash > 0 ? raw_model.slice(0, slash) : "";
		const modelId = slash > 0 ? raw_model.slice(slash + 1) : "";
		const renamed = newIds.get(providerId);
		const custom = isRecord(config.custom_provider) ? config.custom_provider : {};
		const registered = renamed === undefined ? undefined : providers.specs.find((spec) => spec.id === renamed);
		if (raw_model === "") {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a model reference",
				containsSecret: false,
			});
		} else if (renamed !== undefined && registered !== undefined && modelId === "") {
			// A trailing slash: MiniMax's own parser refuses the whole key
			// (`slash === raw.length - 1`, `model-key.ts:51`), so no model was in
			// force there either.
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "it names a provider with no model after the slash, which MiniMax's own reader refuses",
				containsSecret: false,
			});
		} else if (renamed !== undefined && registered !== undefined) {
			const known = (registered.models as Array<{ id?: string }>).some((model) => model.id === modelId);
			if (known) {
				claimScalar(
					"minimax-code",
					"model",
					`${renamed}/${modelId}`,
					label,
					`mapped to "${renamed}/${modelId}", the same model under the id your provider is imported as`,
				);
			} else {
				items.push({
					source: "minimax-code",
					from: label,
					to: "—",
					action: "skip",
					detail: `it names a model your custom provider "${providerId}" does not list, so the reference would point at nothing here`,
					containsSecret: false,
				});
			}
		} else if (providerId.startsWith("custom_provider:") && renamed === undefined) {
			const key = providerId.slice("custom_provider:".length);
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: Object.hasOwn(custom, key)
					? `it names your custom provider "${key}", which this run did not import — see its own line above`
					: `it names your custom provider "${key}", which is not in config.yaml — a reference to a provider that is not there points at nothing`,
				containsSecret: false,
			});
		} else if (providerId === "minimax_api") {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"it names MiniMax's reserved `minimax_api` route — your own MiniMax API key, whose value was not read and is " +
					"not carried; register a provider of your own here and export the key under its name",
				containsSecret: false,
			});
		} else if (providerId !== "") {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					`it names MiniMax's own "${providerId}" catalogue, which is seeded by its installer and served through your ` +
					"account route — not imported, so this reference would point at nothing here",
				containsSecret: false,
			});
		} else {
			// A bare name with no provider: this build's registry is the right
			// question for it after all, since nothing here registers it.
			const resolved = resolveModelReference(raw_model);
			if (resolved !== undefined) {
				claimScalar("minimax-code", "model", resolved, label, `mapped to "${resolved}"`);
			} else {
				items.push({
					source: "minimax-code",
					from: label,
					to: "—",
					action: "skip",
					detail: "no model of that name exists here, so importing it would leave settings.json pointing at nothing",
					containsSecret: false,
				});
			}
		}
	}

	planMinimaxPermissionMode(raw, home, items, claimScalar);
	planMinimaxPermissions(raw, home, items, addPermissionRules);

	// ── custom_provider / provider / minimax_api ─────────────────────────────
	for (const item of providers.items) items.push(item);
	mergeProviderSpecs(
		"minimax-code",
		providers.specs,
		(id) => `${from} → custom_provider.${id.replace(/^minimax-/, "")}`,
		items,
		settingsPatch,
		existing,
		force,
	);
	if (isRecord(config.provider) && Object.keys(config.provider).length > 0) {
		items.push({
			source: "minimax-code",
			from: `${from} → provider (${summarizeNames(Object.keys(config.provider), 6)})`,
			to: "—",
			action: "skip",
			detail:
				"MiniMax's own model routes, seeded by its installer from a preset: the endpoint and model list are the vendor's, " +
				"and the credentials behind them are your account's — none of it is a table you wrote, so none of it is imported",
			containsSecret: false,
		});
	}
	if (isRecord(config.minimax_api)) {
		items.push({
			source: "minimax-code",
			from: `${from} → minimax_api`,
			to: "—",
			action: "skip",
			detail:
				"your own MiniMax API key and an optional endpoint override — the key was not read, and no value of it appears here; " +
				"point a provider entry at MiniMax's API yourself and export the key under its name",
			containsSecret: false,
		});
	}

	// ── toolResultCompaction ─────────────────────────────────────────────────
	if (isRecord(config.toolResultCompaction)) {
		const compaction = config.toolResultCompaction;
		const label = `${from} → toolResultCompaction`;
		if (compaction.enabled === false) {
			// `enabled: false` there means "go straight to the summary"; this build's
			// switch for the same decision is `trimOldToolResults: false`.
			const current = existing.trimOldToolResults;
			if (current !== undefined && !force) {
				items.push({
					source: "minimax-code",
					from: `${label}.enabled (false)`,
					to: "—",
					action: "skip",
					detail: `target already sets trimOldToolResults to ${JSON.stringify(current)} — kept (use --force to overwrite)`,
					containsSecret: false,
				});
			} else {
				settingsPatch.trimOldToolResults = false;
				items.push({
					source: "minimax-code",
					from: `${label}.enabled (false)`,
					to: "settings.json → trimOldToolResults",
					action: "map",
					detail:
						"MiniMax is set to summarise rather than trim old tool results first, which is what this switch means here",
					containsSecret: false,
				});
			}
		}
		const tuning = [
			"maxInlineKiB",
			"mcpDetailsMaxInlineKiB",
			"watermarkKiB",
			"minSavingsKiB",
			"minCandidateKiB",
			"keepRecentRounds",
		].filter((key) => compaction[key] !== undefined);
		if (tuning.length > 0) {
			items.push({
				source: "minimax-code",
				from: `${label} (${summarizeNames(tuning, 6)})`,
				to: "—",
				action: "skip",
				detail:
					"the watermarks its own compaction works to (inline limits, savings thresholds, how many recent tool rounds are " +
					"protected) — this build's rung has its own thresholds and no settings for them",
				containsSecret: false,
			});
		}
	}

	for (const [key, reason] of MINIMAX_UNMIGRATED_SECTIONS) {
		if (config[key] === undefined) continue;
		items.push({
			source: "minimax-code",
			from: `${from} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	const computedPaths = MINIMAX_COMPUTED_PATHS.filter((key) => config[key] !== undefined);
	if (computedPaths.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${from} → ${summarizeNames(computedPaths, 6)}`,
			to: "—",
			action: "skip",
			detail:
				"paths MiniMax computes from its data directory; a value in the file is ignored there as well, and this build " +
				"keeps its own data under ~/.labunbun",
			containsSecret: false,
		});
	}

	// ── mcp.json, and the older spelling beside it ───────────────────────────
	//
	// Two files, and MiniMax does not read them as one document: its runtime
	// connects servers out of `mcp.json` alone (`filePath`,
	// `mcp/runtime/local-mcp.service.ts:1027`), and reads `mcp/mcp.json` only
	// into the set of names that keep skill references resolvable
	// (`readConfiguredMcpServerNames`, `mcp/runtime/config-file.ts:6-11`). So a
	// server defined there and nowhere else is running in neither tool, and
	// importing it silently would hand the user a working server the source
	// never had. Which file answers is the content test the data-directory pair
	// uses: the older one answers when the current one holds no servers at all,
	// and then what it held is imported because that is the only place those
	// servers are written down.
	const mcpFrom = tildePath(home, minimaxMcpFile(raw.root));
	const aliasFrom = tildePath(home, minimaxMcpAliasFile(raw.root));
	for (const error of raw.mcpErrors) {
		items.push({
			source: "minimax-code",
			from: error.startsWith("mcp/mcp.json") ? aliasFrom : mcpFrom,
			to: "—",
			action: "skip",
			detail: `${error} — no server in it was read`,
			containsSecret: false,
		});
	}
	const aliasNames = Object.keys(raw.mcpAlias).sort();
	const primaryNames = Object.keys(raw.mcp);
	const aliasAnswers = primaryNames.length === 0 && aliasNames.length > 0;
	if (aliasNames.length > 0) {
		const both = aliasNames.filter((name) => name in raw.mcp);
		const only = aliasNames.filter((name) => !(name in raw.mcp));
		items.push({
			source: "minimax-code",
			from: aliasFrom,
			to: "—",
			action: "skip",
			detail: aliasAnswers
				? `the older spelling of the same document, and the only place these servers are written down — MiniMax's own runtime connects servers out of \`${MINIMAX_MCP_FILE_NAME}\` only and reads this file just to keep their names resolvable for skills, so they are imported here anyway${
						both.length > 0
							? `; ${summarizeNames(both, 6)} is defined in both files and came across from \`${MINIMAX_MCP_FILE_NAME}\``
							: ""
					}`
				: `the older spelling of the same document, which MiniMax no longer connects from: its runtime reads servers out of \`${MINIMAX_MCP_FILE_NAME}\` only and keeps this file to resolve names for skills, and the servers in it were not imported — ${
						only.length > 0
							? `${summarizeNames(only, 6)} ${only.length === 1 ? "is" : "are"} defined there and nowhere in \`${MINIMAX_MCP_FILE_NAME}\``
							: "every name in it is also defined there"
					}${both.length > 0 ? `, and ${summarizeNames(both, 6)} came across from \`${MINIMAX_MCP_FILE_NAME}\`` : ""}`,
			containsSecret: false,
		});
	}
	const mcpSource = aliasAnswers ? aliasFrom : mcpFrom;
	for (const [name, value] of Object.entries(aliasAnswers ? raw.mcpAlias : raw.mcp)) {
		const label = `${mcpSource} → ${name}`;
		if (!isRecord(value)) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "entry is not a server definition",
				containsSecret: false,
			});
			continue;
		}
		if (value.builtin === true) {
			// MiniMax's own bundled server: its command is a path inside MiniMax's
			// installation, and its arguments point at that installation's files.
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"a server MiniMax ships with itself — its command runs MiniMax's own bundled program, not something of yours",
				containsSecret: false,
			});
			continue;
		}
		if (value.configured === false) {
			// `isUserConfiguredServer` (`settings-config.ts:33-35`) reads this flag the
			// same way: an entry it is false on is not one of the user's servers, and
			// MiniMax's own settings API refuses to hand it back.
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"an entry MiniMax marks as not configured by you — its own settings refuse to read it back, so it is not imported",
				containsSecret: false,
			});
			continue;
		}
		if (value.enabled === false) {
			items.push({
				source: "minimax-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "disabled in MiniMax — there is no way to keep a server defined and switched off here",
				containsSecret: false,
			});
			continue;
		}
		const normalized = normalizeMinimaxMcp(value);
		if (normalized === null || !McpServerConfigSchema.safeParse(normalized.config).success) {
			items.push({
				source: "minimax-code",
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
				source: "minimax-code",
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
			Object.keys(isRecord(normalized.config.env) ? normalized.config.env : {}).some((key) => looksLikeSecretName(key));
		mcpServers[name] = normalized.config;
		markMcpSecret(secret);
		const copied = secret ? "copied verbatim, including credential headers" : "copied verbatim";
		items.push({
			source: "minimax-code",
			from: label,
			to: `.mcp.json → mcpServers.${name}`,
			action: normalized.downgrades.length > 0 ? "downgrade" : "map",
			detail: normalized.downgrades.length > 0 ? `${copied} — ${normalized.downgrades.join("; ")}` : copied,
			containsSecret: secret,
		});
	}

	reportUnhandledKeys(
		"minimax-code",
		config,
		new Set<string>([
			"defaultModel",
			"permissionMode",
			"custom_provider",
			"provider",
			"minimax_api",
			"toolResultCompaction",
			...MINIMAX_UNMIGRATED_SECTIONS.map(([key]) => key),
			...MINIMAX_COMPUTED_PATHS,
		]),
		from,
		items,
	);
}

/** MiniMax's assets: `AGENTS.md`, skills, agents, and the trees it reads but does not own. */
export function planMinimaxAssets(
	raw: RawMinimaxCode,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	collectFileWrites(
		"minimax-code",
		raw.skills,
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		"minimax-code",
		raw.agents,
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	if (raw.memory?.trim()) {
		// The document MiniMax injects in every project it runs in — the same
		// standing as `~/.claude/CLAUDE.md` and grok's `AGENTS.md` — so it lands as
		// a rule file that merges with existing memory rather than replacing it.
		planMemoryAsRule(
			"minimax-code",
			tildePath(home, minimaxGlobalInstructionsPath(raw.root)),
			home,
			raw.memory,
			"imported-minimax-code.md",
			force,
			items,
			writes,
		);
	}
	if (raw.agentSkips.length > 0) {
		items.push({
			source: "minimax-code",
			from: raw.agentSkips
				.map((skip) => `${tildePath(home, join(minimaxAgentsDir(raw.root), skip.name))} (${skip.reason})`)
				.join(", "),
			to: "—",
			action: "skip",
			detail: "no agent was taken from these directories, and MiniMax lists no agent for them either",
			containsSecret: false,
		});
	}
	if (raw.agentSkillTrees.length > 0) {
		items.push({
			source: "minimax-code",
			from: raw.agentSkillTrees
				.map((tree) => `${tildePath(home, join(minimaxAgentsDir(raw.root), tree.name, "skills"))} (${tree.count})`)
				.join(", "),
			to: "—",
			action: "skip",
			detail:
				"skills belonging to one agent over there: every skill here is loaded into every session, so importing these would " +
				"hand the whole session the instructions you wrote for a single agent",
			containsSecret: false,
		});
	}
	if (raw.builtinSkillNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, join(raw.root, MINIMAX_BUILTIN_SKILLS_DIR))} (${summarizeNames(raw.builtinSkillNames, 8)})`,
			to: "—",
			action: "skip",
			detail: `${raw.builtinSkillNames.length} skill(s) MiniMax ships with itself, kept current by its own updates rather than by this run`,
			containsSecret: false,
		});
	}
	if (raw.builtinAgentNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, join(minimaxAgentsDir(raw.root), MINIMAX_BUILTIN_AGENTS_DIR))} (${summarizeNames(raw.builtinAgentNames, 8)})`,
			to: "—",
			action: "skip",
			detail: `${raw.builtinAgentNames.length} agent(s) MiniMax ships with itself, on the same footing as its built-in skills`,
			containsSecret: false,
		});
	}
	if (raw.pluginNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, minimaxPluginsDir(raw.root))} (${summarizeNames(raw.pluginNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				`${raw.pluginNames.length} installed plugin(s): their skills and agents ship with the plugin and are updated with it, ` +
				"and this build has no plugin system to track that — the names are here so you can tell what is not",
			containsSecret: false,
		});
	}
	if (raw.reviewRules.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, join(raw.root, "review-rules"))} (${summarizeNames(raw.reviewRules, 8)})`,
			to: "—",
			action: "skip",
			detail:
				"your own instructions for MiniMax's code reviewer, which it splices into a review prompt — a rule here is read in " +
				"every session of every project, so the review rules are named rather than turned into standing instructions",
			containsSecret: false,
		});
	}
	if (raw.planNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, minimaxPlansDir(raw.root))} (${summarizeNames(raw.planNames, 8)})`,
			to: "—",
			action: "skip",
			detail: `${raw.planNames.length} plan document(s) you approved and kept — a document about one piece of work, not an instruction for every session`,
			containsSecret: false,
		});
	}
	if (raw.memoryNames.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, minimaxMemoryDir(raw.root))} (${summarizeNames(raw.memoryNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				"MiniMax's long-term notes, which its own memory feature reads and writes per topic; nothing here reads that layout, " +
				"and copying the files without the feature would leave notes that nothing maintains",
			containsSecret: false,
		});
	}
	if (raw.unreadV2Dirs.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, minimaxV2Root(raw.root))} (${summarizeNames(raw.unreadV2Dirs, 8)})`,
			to: "—",
			action: "skip",
			detail:
				"`v2/chats` holds the ledgers of MiniMax's older layout and `v2/mcode/drafts` the composer text you typed and never " +
				"sent — neither is a settings document, and a draft is not something you asked to send",
			containsSecret: false,
		});
	}
	if (raw.borrowedTrees.length > 0) {
		items.push({
			source: "minimax-code",
			from: raw.borrowedTrees.map((tree) => `~/${tree}`).join(", "),
			to: "—",
			action: "skip",
			detail:
				"trees MiniMax reads because they belong to other tools (Claude Code's, Codex's and the shared `~/.agents` one): the " +
				"sources that own them import them, and taking them here as well would land two copies of every skill",
			containsSecret: false,
		});
	}
	if (raw.credentialEntries.length > 0) {
		items.push({
			source: "minimax-code",
			from: `${tildePath(home, raw.root)}/${raw.credentialEntries.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				"credential-shaped entries reported by name and never opened — no value in them was read, and none is carried",
			containsSecret: false,
		});
	}
	if (raw.legacyRoot !== null) {
		items.push({
			source: "minimax-code",
			from: tildePath(home, raw.legacyRoot),
			to: "—",
			action: "skip",
			detail: raw.legacyRead
				? `the tree under MiniMax's older name (\`${MINIMAX_LEGACY_DATA_DIR_BASENAME}\`), which it renames into \`${MINIMAX_DATA_DIR_BASENAME}\` the next time it starts: this run read it, because the directory under the current name holds nothing on this machine — absent, or there but empty, which is the state MiniMax moves the old one over`
				: `the tree under MiniMax's older name (\`${MINIMAX_LEGACY_DATA_DIR_BASENAME}\`), which this run did not read: MiniMax uses the tree under the current name where that tree holds anything, and where the two hold nothing at all it is the current name it keeps — its own move of the old one is a rename rather than a merge`,
			containsSecret: false,
		});
	}
	if (raw.installDirPresent) {
		items.push({
			source: "minimax-code",
			from: `~/${MINIMAX_INSTALL_DIR}`,
			to: "—",
			action: "skip",
			detail:
				"the installer's own directory (and the data directory of older source builds) — program files, not your state",
			containsSecret: false,
		});
	}
	if (raw.otherDirs.length > 0) {
		items.push({
			source: "minimax-code",
			from: raw.otherDirs.map((entry) => `${tildePath(home, join(raw.root, entry.name))} (${entry.count})`).join(", "),
			to: "—",
			action: "skip",
			detail: "no mapping here for these, so they were left where they are",
			containsSecret: false,
		});
	}
	// A working directory's own MiniMax files are outside this planner's reach,
	// and saying so is the point: `.mcp.json` and `CLAUDE.md` look like this
	// source's, so a user who does not find them mentioned reads the silence as a
	// bug. This importer works from a home, and a repository's files belong to the
	// repository — the same reason grok's own planner gives for `.grok/`.
	items.push({
		source: "minimax-code",
		from: `each working directory's own ${MINIMAX_PROJECT_MCP_FILE} and ${MINIMAX_PROJECT_INSTRUCTION_FILES.join("/")}`,
		to: "—",
		action: "skip",
		detail:
			`a project's MCP servers and instruction document live beside the project rather than under \`${MINIMAX_DATA_DIR_BASENAME}\`, ` +
			"so this importer neither reads nor moves them — MiniMax reads the document under the first of those names that exists",
		containsSecret: false,
	});
}
