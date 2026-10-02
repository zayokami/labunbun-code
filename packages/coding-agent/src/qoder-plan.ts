/**
 * Qoder's user state in the target's shape: the permission posture, the MCP
 * servers, the hooks, the skills and the memory, and everything the reader saw
 * that this importer will not carry.
 *
 * **The first thing to know about this source is what it does not have.** A
 * migration from most tools in this repository is mostly three scalars — a
 * model, a theme, a permission mode — and Qoder 0.4.3's `settings.json` carries
 * none of them. That is not a gap in the reading; it is what the bytes say. The
 * desktop app reads its settings field by field, and **every call that names a
 * literal names one of five keys**:
 *
 * ```js
 * readField("hooks", …)   readField("mcpServers", …)   readField("enabledPlugins", …)
 * readField("pluginConfigs", …)   readField("chatSession.builtInBrowserHosts", …)
 * ```
 *
 * There is no field call for a permission mode, a theme or a model anywhere in
 * the bundle. So this planner claims **one** scalar, and the other two are absent
 * rather than unhandled. {@link planQoderAbsentScalars} is the line that says so,
 * and it is the most important line this file writes.
 *
 * **The permission mode is read anyway, because the key is real.** The SDK's
 * settings writer sets `general.defaultPermissionMode`. It occurs **twice** in the
 * SDK bundle, **35 bytes apart inside one expression** — `o !== undefined &&
 * s.defaultPermissionMode === undefined && (s.defaultPermissionMode = o)` at byte
 * 12207 and 12242 — so it is one site, not two: a read followed by a write of the
 * same key. There is no third occurrence, and **none in the desktop bundle**. The
 * one site is the *outbound* direction (this build's `t.defaultMode`, translated by
 * `toQoderDefaultPermissionMode`), which is weaker evidence than it looks: it
 * proves the SDK can *write* the key, and says nothing about where Qoder *reads*
 * it, because no read site is attested anywhere we can see. So the key exists, and
 * a user who installed the CLI side may have one. It is claimed when present and
 * the report says that a desktop-only install will not have it. That is the
 * opposite of the tempting alternative, which is to skip the key because
 * "the desktop doesn't read it" and leave a CLI user's mode behind.
 *
 * **The settings are a merge of three files, and this planner reads the merge.**
 * `~/.qoder/settings.json` is only the **user** layer. The SDK's loader
 * (`settingSources` defaults to `["user","project","local"]`) also reads
 * `<cwd>/.qoder/settings.json` and `<cwd>/.qoder/settings.local.json`, and folds
 * them in with per-path policies — six top-level keys merged **one level deep**,
 * thirteen paths **unioned**, hook event groups **concatenated**, and everything
 * else merged all the way down. `mcpServers` is one of the six: a project's server
 * map unions with the user's, but a server both declare is taken **whole** from the
 * project. So `RawQoder.settings` is the merge, `RawQoder.provenance` says which
 * file last supplied each key, and every label below that names a settings key
 * names that file. Reading the user layer alone would have imported servers with
 * commands and environments the project has replaced. The merge itself is
 * `mergeQoderSettings` in `qoder-read.ts`.
 *
 * **Three things are deliberately not migrated, and each is a decision with a
 * reason rather than an omission:**
 *
 *   1. **MCP `env` values and `headers`.** Both can hold a bearer token, and both
 *      are copied by name only — see {@link planQoderMcp}. Qoder itself refuses a
 *      literal `authorization` or `token`, but `headers: { "x-api-key": … }` is a
 *      shape it accepts, so a value could reach a written file through a key name
 *      no scanner here would recognise as a credential.
 *   2. **BYOK provider credentials.** Not a decision so much as a fact: Qoder
 *      seals the key before it stores it (`{schemaVersion: 1, apiKey}` →
 *      `protectionService.protectString` → `byok_model_credentials.encrypted_payload`),
 *      so there is nothing in `settings.json` to migrate and nothing to re-auth.
 *   3. **Sessions.** Counted, never opened; see `qoder-session.ts`.
 */

import { join } from "node:path";
import type { PermissionMode, SandboxMode } from "@labunbun/agent";
import { McpServerConfigSchema } from "@labunbun/mcp";
import {
	collectFileWrites,
	isRecord,
	normalizeClaudeHooks,
	planMemoryAsRule,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
	urlCredentialProblem,
} from "./migrate-core.ts";
import type { ClaimHooks, ClaimModePair, MigrationItem, MigrationSourceId, PlannedWrite } from "./migrate-types.ts";
import { QODER_HOOK_EVENTS, QODER_MEMORY_INDEX_NAME, qoderMemoryDir, qoderOtherConfigDir } from "./qoder-home.ts";
import type { RawQoder } from "./qoder-read.ts";
import { qoderSettingsOrigin, qoderSettingsSubkeyOrigin } from "./qoder-read.ts";

/**
 * This source's id, spelled once.
 *
 * The union and every table keyed by it live in `migrate-types.ts`; this is a
 * plain literal with no cast, and the only thing it buys is one spelling rather
 * than eleven. **The call lives in `migrate.ts`** — see that file's arm for
 * `qoder`, which is where this planner is actually reached from.
 */
const SOURCE: MigrationSourceId = "qoder";

/**
 * Qoder's permission modes → this build's two mode axes.
 *
 * **The vocabulary is the SDK's own**, and it is worth being precise about where
 * it comes from, because it is easy to mistake for a guess. `toQoderDefaultPermissionMode`
 * is the SDK translating *this build's* mode names into the strings it passes to
 * Qoder's CLI:

 * ```js
 * case "acceptEdits":        return "accept_edits";
 * case "bypassPermissions":
 * case "yolo":               return "bypass_permissions";
 * case "dontAsk":            return "dont_ask";
 * case "default": case "accept_edits": case "bypass_permissions":
 * case "dont_ask": case "plan": case "auto": return e;
 * ```

 * The right-hand column of that switch is Qoder's vocabulary, and the pass-through
 * cases are the whole of it: `default`, `accept_edits`, `bypass_permissions`,
 * `dont_ask`, `plan`, `auto`.
 *
 * **Two map and four do not.**
 *
 * - `accept_edits` → `ask`, which is **narrower than it says.** This build has no
 *   mode that applies edits without asking, so every write gets asked like
 *   everything else. Widening a permission setting is the direction a migration
 *   must not move in on its own, and the report line says so in those words
 *   rather than calling it a rename.
 * - `bypass_permissions` → `agent` + `danger-full-access`, and both halves are
 *   claimed together because that single value is doing two jobs — never ask
 *   *and* no confinement. Claiming only the mode half would leave a session that
 *   auto-approves everything and still enforces a sandbox, which is a combination
 *   no user chose.
 * - `default` → **nothing**, because it is the schema's absence rather than a
 *   choice. Writing the strictest posture on the user's behalf "because their
 *   schema would have supplied it" is the fail-open failure `t3-plan.ts` argues at
 *   length; omitting it leaves the session at this build's own default.
 * - `auto`, `dont_ask` and `plan` → nothing, each for its own reason below.
 *
 * Exported for the row count, not for the values: a row added here without a line
 * in the mapper test's table is an import whose claim nobody has checked.
 */
export const QODER_PERMISSION_MODES: Record<string, { mode: PermissionMode; sandbox: SandboxMode } | undefined> = {
	accept_edits: { mode: "ask", sandbox: "workspace-write" },
	bypass_permissions: { mode: "agent", sandbox: "danger-full-access" },
	default: undefined,
	auto: undefined,
	dont_ask: undefined,
	plan: undefined,
};

/**
 * Top-level keys of `settings.json` this mapper accounts for.
 *
 * Read as the *whole* list, and read against the reader's header. `mcpServers`
 * and `hooks` are the two this planner actually reads; `general` is here because
 * `planQoderPermissionMode` handles exactly one key under it and reports the
 * rest; the last three get a line of their own from
 * {@link planQoderPlugins} or from {@link planQoderAbsentScalars} and so are not
 * the unhandled-key catch-all's business.
 */
const QODER_SETTINGS_HANDLED = new Set([
	"mcpServers",
	"hooks",
	"general",
	"enabledPlugins",
	"pluginConfigs",
	"chatSession",
]);

/** The keys under `general` this mapper accounts for. See {@link QODER_PERMISSION_MODES}. */
const QODER_GENERAL_HANDLED = new Set(["defaultPermissionMode"]);

/**
 * The keys Qoder's own settings reader recognises on one MCP entry, verbatim.
 *
 * Two sets exist in the bundle and **they are not the same set**, which is the
 * kind of detail that produces a wrong report if the wrong one is quoted. This is
 * the **live** one — the set the settings editor checks an edited entry against
 * before it will save it:
 *
 * ```js
 * new Set(["displayName","command","args","cwd","env","environment","url","qoder_url",
 *          "type","authType","legacySseFallback","headers","timeout"])
 * ```
 *
 * The other one — a 12-name array including `disabled` and excluding
 * `displayName` and `qoder_url` — belongs to the **QoderWork importer**, which
 * reads a *foreign* product's file and is not what wrote this one. The difference
 * is why `disabled` gets its own sentence below rather than being treated as
 * ordinary: it is written by the product (`setEntryDisabled` sets and deletes it)
 * and read by the live normalizer, but it is absent from the editor's own key set.
 */
const QODER_MCP_KEYS = new Set([
	"displayName",
	"command",
	"args",
	"cwd",
	"env",
	"environment",
	"url",
	"qoder_url",
	"type",
	"authType",
	"legacySseFallback",
	"headers",
	"timeout",
]);

/**
 * The report label for a settings key: the file its value came from, plus the
 * layer when that file is not the user's own.
 *
 * **The layer suffix is the point.** A project or local `settings.json` supplies
 * any of the six {@link QODER_MERGE_SHALLOW} keys in whole — a server entry, a
 * plugin's configuration, one provider — so a report that printed
 * `~/.qoder/settings.json → mcpServers` for a server that in fact came from
 * `<project>/.qoder/settings.json` would send the user to edit the wrong file and
 * find nothing there. The `user` layer prints no suffix: it is where
 * these labels have always pointed, and a report line reading "the user layer"
 * tells a reader nothing they did not have.
 *
 * `subkey` narrows the file as well as the label. The SDK's provenance is keyed by
 * top-level name, so `mcpServers` — carried by every layer that has any server at
 * all — would attribute a server the *project* never mentioned to the project
 * file. {@link qoderSettingsSubkeyOrigin} asks the question at the granularity the
 * label is printed at, and the suffix is appended **after** the subkey so the
 * result reads `… → mcpServers.demo (project layer)` rather than
 * `… → mcpServers (project layer).demo`.
 */
function qoderFrom(raw: RawQoder, key: string, subkey?: string): string {
	const top = raw.provenance[key];
	const file = qoderSettingsOrigin(raw.home, raw.provenance, key, raw.settingsPath);
	const source = top?.source ?? "user";
	// Without a subkey the file and the layer come from the same record, so there
	// is nothing to narrow. With one, both come from the layer that actually holds
	// that key — the suffix has to agree with the file printed beside it.
	const narrowed =
		subkey === undefined
			? undefined
			: qoderSettingsSubkeyOrigin(raw.home, raw.settingsLayers, key, subkey, file, source);
	const shown = narrowed ?? { path: file, source };
	const suffix = shown.source !== "user" ? ` (${shown.source} layer)` : "";
	const label = subkey === undefined ? key : `${key}.${subkey}`;
	return `${shown.path} → ${label}${suffix}`;
}

/**
 * The three scalars every other source here maps, and the one line that explains
 * their absence from Qoder.
 *
 * This is the sentence a user who ran `/model` in Qoder and expects to find it
 * here is owed. It is not an apology — it is a fact with a citation, and stating
 * it is what stops a report that lists four settings from looking like four
 * settings were quietly dropped.
 */
function planQoderAbsentScalars(raw: RawQoder, items: MigrationItem[]): void {
	if (raw.settings === null) return;
	items.push({
		source: SOURCE,
		from: raw.settingsLayers.map((layer) => tildePath(raw.home, layer.path)).join(", "),
		to: "—",
		action: "skip",
		detail:
			`no model and no theme were taken from any of the ${raw.settingsLayers.length} settings file${raw.settingsLayers.length === 1 ? "" : "s"} read, ` +
			"and neither is in any of them: Qoder's desktop reads its settings field by field, " +
			"and the only field names it reads are hooks, mcpServers, enabledPlugins, pluginConfigs and " +
			"chatSession.builtInBrowserHosts. There is no settings field for either, in this build — the model picker and the " +
			"appearance setting both live in the application's own state rather than in settings.json. Set them with /model and /theme",
		containsSecret: false,
	});
}

/**
 * `general.defaultPermissionMode` → this build's two mode axes, when the file
 * states one.
 *
 * **The key is claimed only when present, and that is the whole argument.** See
 * the header for why it is read at all when no code in the shipped desktop reads
 * it: the SDK writes it, so a CLI-side install can have one, and "the desktop
 * doesn't read it" is not a reason to leave a user's stated posture behind.
 *
 * An absent key means nothing claimed and nothing said — the same call
 * `planT3RuntimeMode` makes for an absent `defaultRuntimeMode`, and for the same
 * reason. Importing the schema's default would be writing `agent` +
 * `danger-full-access` for a user whose file said nothing.
 */
function planQoderPermissionMode(raw: RawQoder, items: MigrationItem[], claimModePair: ClaimModePair): void {
	if (raw.settings === null) return;
	const general = raw.settings.general;
	if (!isRecord(general)) return;
	const value = general.defaultPermissionMode;
	if (value === undefined || value === null) return;
	const shown = typeof value === "string" ? value : JSON.stringify(value);
	const from = `${qoderFrom(raw, "general", "defaultPermissionMode")} (${shown})`;
	if (typeof value !== "string") {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				"not a string, so it is not one of Qoder's permission modes; the session keeps the mode it would start in",
			containsSecret: false,
		});
		return;
	}
	const mapped = QODER_PERMISSION_MODES[value];
	if (mapped !== undefined) {
		claimModePair(
			SOURCE,
			mapped.mode,
			mapped.sandbox,
			from,
			value === "accept_edits"
				? 'mapped to "ask": this build has no mode that applies edits without asking, so a write is asked like everything else. Narrower than the mode it replaced, deliberately'
				: 'mapped to "agent" with the sandbox unconfined, because Qoder\'s one value is doing both jobs — never ask and no confinement — and claiming only the mode half would leave a session that auto-approves everything inside a sandbox nobody chose',
		);
		return;
	}
	items.push({
		source: SOURCE,
		from,
		to: "—",
		action: "skip",
		detail:
			value === "default"
				? '"default" is the absence of a choice rather than one: it is the value a file carries when nobody picked anything, so ' +
					"importing it would write a posture on the user's behalf that they never stated. The session starts as it otherwise would"
				: value === "auto"
					? '"auto" is a classifier that approves the calls it judges routine, and no mode here does that: "ask" puts a person ' +
						'in the loop instead of a classifier and "agent" runs everything instead of judging. Either would change the posture ' +
						"the mode names, so the session keeps whatever it would otherwise start in"
					: value === "dont_ask"
						? '"dont_ask" is the far end of Qoder\'s range and this build\'s nearest is "agent" with no sandbox — which is not the ' +
							"same decision, because what it declines to ask about is not written down anywhere in either bundle. Guessing here " +
							"would widen a permission setting rather than narrow one, so nothing was claimed — set the posture yourself with /mode"
						: value === "plan"
							? '"plan" is a planning posture rather than a permission one — it is about what the model may propose, not what it may ' +
								"do — so there is no permission mode here that corresponds to it, and claiming one would set a sandbox the mode " +
								"never described"
							: "not a permission mode Qoder defines, so it never decided a session — the permission mode is left as it is",
		containsSecret: false,
	});
}

/**
 * One MCP server from `settings.mcpServers` → this build's server shape.
 *
 * **The transport is decided by Qoder's own live normalizer, and its rules are
 * not the ones a reader would guess.** From the code that validates an entry
 * before the settings editor will save it:
 *
 * ```js
 * const hasCommand = typeof e.command === "string",
 *       hasUrl     = typeof e.url     === "string";
 * if (!trustedGateway && !hasCommand && !hasUrl) $A("MCP_CONFIG_TRANSPORT_REQUIRED", …);
 * if (!trustedGateway && hasCommand && hasUrl)      $A("MCP_CONFIG_TRANSPORT_AMBIGUOUS", …);
 * ```
 *
 * So: an **empty** `command` string still selects stdio, `command` and `url`
 * together is an **error rather than "command wins"**, and a third transport
 * exists — a `qoder_url` pointing at Qoder's own managed gateway, which is only
 * accepted when the URL passes a region-and-trusted-domain check against an
 * environment this build does not have. Each of those three becomes its own
 * outcome below.
 *
 * **Two credential paths are stripped, and neither is a guess about the user's
 * intentions.**
 *
 *   - **`headers`** are dropped whole. Qoder's stdio normalizer keeps an
 *     `environment` block and its URL branch keeps `headers`, and a header value
 *     is an ordinary place for a bearer token — `headers: {"x-api-key": …}` is a
 *     shape Qoder accepts and a shape no name-based credential scan here would
 *     flag. Dropping the block loses the server's authentication, which the
 *     report says, and that is the right trade: a server that asks for its
 *     credentials again is a nuisance, and a token written into a file the user
 *     then shares is not.
 *   - **`env` values are not copied; the names are.** Same reasoning, applied to
 *     the stdio branch, where the values are the process environment of a spawned
 *     server. The names come across in the report and the user can fill them in.
 *     A name that reads as a credential was already gone before this function ran:
 *     `readQoder` deletes every key matching `looksLikeSecretName` — and more than
 *     that, `QODER_SECRET_KEY` — at every depth, and records one `skipped` line
 *     per deletion naming the exact path. So `entry.env` holds only names that did
 *     **not** read as credentials, which is why this function counts them without
 *     re-sorting them.
 */
function planQoderMcp(
	raw: RawQoder,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	for (const [name, entry] of Object.entries(raw.mcpServers)) {
		const from = qoderFrom(raw, "mcpServers", name);
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

		// `enabled` is a key Qoder's own normalizer **throws** on
		// (`MCP_CONFIG_ENABLED_UNSUPPORTED`). A file carrying one is a file Qoder
		// would refuse to save, so the entry is not a working server here either
		// and the reason worth printing is the product's.
		if ("enabled" in entry) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"this entry carries `enabled`, which Qoder's own MCP normalizer rejects (MCP_CONFIG_ENABLED_UNSUPPORTED) — Qoder keeps " +
					"whether a server runs in `disabled` instead, and accepts nothing here that would import cleanly",
				containsSecret: false,
			});
			continue;
		}

		const isDisabled = entry.disabled ?? false;
		if (typeof isDisabled !== "boolean") {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: "`disabled` is not a boolean, which is the one type Qoder requires of it (MCP_CONFIG_DISABLED_INVALID)",
				containsSecret: false,
			});
			continue;
		}
		if (isDisabled) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"Qoder has this server switched off (`disabled: true`). Importing it would add a server to the target's configuration " +
					"that the user had turned off in Qoder, so it was left out — turn it on here with /mcp if you want it",
				containsSecret: false,
			});
			continue;
		}

		// `env` wins over `environment` in Qoder's own normalizer
		// (`const a = t.env ?? t.environment ?? {}`), and both are deleted
		// afterwards. Which one this importer read matters, because a file carrying
		// both would otherwise silently take the wrong values.
		const hasEnvironment = isRecord(entry.env);
		const hasLegacyEnvironment = isRecord(entry.environment);

		const command = typeof entry.command === "string" ? entry.command.trim() : "";
		const url = typeof entry.url === "string" ? entry.url.trim() : "";
		const isGateway = typeof entry.qoder_url === "string" && entry.qoder_url.trim() !== "";

		if (isGateway) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"this is a Qoder managed-gateway connector (`qoder_url`), and Qoder only accepts one when the URL passes a region and " +
					"trusted-domain check against its own managed MCP environment. That environment does not exist here, so there is no " +
					"address to connect to and nothing was imported — the connector is named, never opened",
				containsSecret: false,
			});
			continue;
		}

		// `command` counts as present on `typeof === "string"`, so an empty string
		// is still a stdio server to Qoder. Reading `command` as "absent when
		// empty" would reclassify a malformed entry as an ambiguous one and give
		// the wrong reason in the report, so the test below is Qoder's.
		const hasCommand = typeof entry.command === "string";
		if (!hasCommand && url === "") {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"it names neither a command nor a URL, which are the two transports Qoder's own normalizer accepts " +
					"(MCP_CONFIG_TRANSPORT_REQUIRED) — nothing was serving it over there either",
				containsSecret: false,
			});
			continue;
		}
		if (hasCommand && url !== "") {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"it names both a command and a URL, which Qoder's own normalizer treats as an error rather than picking one " +
					"(MCP_CONFIG_TRANSPORT_AMBIGUOUS) — so this entry is one Qoder would not save, and choosing a transport for it would " +
					"be picking for it",
				containsSecret: false,
			});
			continue;
		}

		// The URL is the one credential channel no name-based scan can see: the
		// token is not under a secret-shaped key, it is inside the one string every
		// importer treats as a safe identifier. `headers` and `env` are handled by
		// dropping the credential and keeping the server; **there is no such half
		// here** — a URL with its userinfo or its `?access_token=` removed is a
		// different URL that points at nothing, and writing one would trade a
		// credential on disk for a server that fails at connect time while the
		// report calls the copy a clean `map`. So the server is not carried across,
		// and the reason says which shape was found without printing any of it.
		//
		// `containsSecret` is `true` here although nothing was written. The flag is
		// documented as "whether the migrated value is a credential" and the value
		// this line is about *is* one — nothing reads it today, but a future reader
		// filtering items for "was anything here a secret?" should not have to
		// re-derive this from the prose above.
		if (!hasCommand && url !== "") {
			const problem = urlCredentialProblem(url);
			if (problem !== null) {
				items.push({
					source: SOURCE,
					from,
					to: "—",
					action: "skip",
					detail:
						`left off, because ${problem} — unlike a header or an environment variable there is no way to drop the credential and keep the address, so nothing was written; ` +
						"add the server again here with the credential in your environment instead",
					containsSecret: true,
				});
				continue;
			}
		}

		const downgrades: string[] = [];
		const config: Record<string, unknown> = {};
		if (hasCommand) {
			const args = Array.isArray(entry.args) ? entry.args : [];
			const strings = args.filter((arg): arg is string => typeof arg === "string");
			if (strings.length !== args.length) {
				downgrades.push(`${args.length - strings.length} argument(s) that were not strings, dropped`);
			}
			if (typeof entry.args !== "undefined" && !Array.isArray(entry.args)) {
				downgrades.push("its `args` was not an array, so none was read");
			}
			if (args.length > 256)
				downgrades.push(`only the first 256 of ${args.length} arguments came across — the product's own limit`);
			config.type = "stdio";
			config.command = command;
			config.args = strings.slice(0, 256);
			if (typeof entry.cwd === "string") {
				// Qoder requires an **absolute** cwd in the user scope
				// (MCP_CONFIG_CWD_ABSOLUTE_REQUIRED) and refuses one that escapes the
				// project root in the project scope. A relative path in a file the user
				// edited by hand is therefore one Qoder has not validated, and it would
				// mean something different from this machine than from the one Qoder ran
				// on — so it is named rather than written.
				if (isAbsolutePath(entry.cwd)) config.cwd = entry.cwd;
				else
					downgrades.push(
						`its relative cwd was left off — ${summarizeNames([entry.cwd])} means a different directory on each machine, and Qoder requires an absolute one here`,
					);
			}
		} else {
			config.type = "http";
			config.url = url;
			const type = typeof entry.type === "string" ? entry.type : "";
			if (type === "sse") {
				downgrades.push(
					'Qoder spells this transport "sse" and this build has one HTTP client, so it connects the same way',
				);
			} else if (type !== "" && type !== "http" && type !== "streamableHttp" && type !== "streamable-http") {
				downgrades.push(
					`its \`type\` of ${summarizeNames([type])} is not one Qoder's normalizer accepts (${summarizeNames(["http", "streamableHttp", "streamable-http", "sse"])}), so it was read as a plain HTTP server`,
				);
			}
			// `timeout` is in milliseconds here and is bounded at both ends: Qoder
			// drops a value below 1000 ms silently and caps at 2^31-1. This build has
			// no per-server timeout field at all, so there is nowhere for it to go.
			if (typeof entry.timeout === "number") {
				downgrades.push(
					`its timeout of ${entry.timeout} ms was left off — Qoder bounds this at 1000 ms and ${2_147_483_647} ms, and this build's server config has no field for it`,
				);
			}
		}

		// The two credential blocks. Both are named, never copied.
		if (isRecord(entry.headers)) {
			const names = Object.keys(entry.headers);
			if (names.length > 0) {
				downgrades.push(
					`left off ${summarizeNames(names)} — a header value is an ordinary place for a bearer token, and this importer writes none of them; ` +
						"set the server's headers again here if it needs them",
				);
			}
		}
		// `isRecord` is repeated here instead of reusing `hasEnvironment` /
		// `hasLegacyEnvironment` above: those are booleans, and a boolean does not
		// narrow `entry.env` back into something `Object.keys` accepts. The product
		// reads `env ?? environment` in one expression, and so does this.
		const envNames = isRecord(entry.env)
			? Object.keys(entry.env)
			: isRecord(entry.environment)
				? Object.keys(entry.environment)
				: [];
		if (hasEnvironment && hasLegacyEnvironment) {
			downgrades.push(
				"it carried both `env` and `environment`; Qoder's normalizer reads `env` and deletes both, so the names below are the `env` ones",
			);
		}
		if (envNames.length > 0) {
			// No credential re-check here, and the absence is deliberate: `readQoder`
			// deleted every `looksLikeSecretName` match from `env` before this function
			// saw the entry, so such a name cannot be in `envNames`. An earlier draft
			// filtered `envNames` for credential-shaped names and appended a sentence
			// about them — a branch no input could reach, printing a claim about a
			// credential the reader had already reported by full path.
			downgrades.push(
				`left off ${envNames.length} environment variable${envNames.length === 1 ? "" : "s"} (${summarizeNames(envNames)}) — the names came across in this report, the values did not, so a server that needs a secret has to have it set again here`,
			);
		}

		if (!McpServerConfigSchema.safeParse(config).success) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: hasCommand
					? "its command, arguments or working directory are not a stdio server definition this build accepts"
					: "its URL is not an address this build's MCP client accepts",
				containsSecret: false,
			});
			continue;
		}

		const extra = Object.keys(entry).filter((key) => !QODER_MCP_KEYS.has(key));
		if (extra.length > 0) {
			downgrades.push(
				`left off ${summarizeNames(extra)} — not one of the ${QODER_MCP_KEYS.size} keys Qoder's own settings editor recognises on an MCP entry`,
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
		// Qoder accepted. It is computed rather than assumed so that a future change
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

/**
 * `settings.hooks` → this build's hook config, through the shared normalizer.
 *
 * **The shape is Qoder's own and the event names are checkable against a list.**
 * `hGr` validates the block and is not zod: each key of `hooks` is an event name
 * it takes verbatim, each event's value is an array of groups, and each group is
 * `{ matcher?, hooks: [...] }`. The reader's output record carries
 * `{id, event, matcher, condition, hookType, summary, async, asyncRewake, once, groupIndex, hookIndex}`.
 *
 * Two things follow from that record and both cost something if dropped silently:
 *
 *   - **There is no timeout.** Not "the unit is unknown" — the reader has no
 *     timeout field at all, so there is nothing on disk for a timeout to come
 *     from. Handlers are written untimed and this build's default applies.
 *   - **`if`, `async`, `asyncRewake` and `once` have no equivalent here.** `if` is
 *     a condition Qoder evaluates before running; this build's hook entry has no
 *     condition field, so a conditional hook would run unconditionally — which is
 *     why the *conditional* ones are skipped rather than widened. `once` means
 *     "run this one time" and dropping it would make the hook run on every event
 *     instead, so those are skipped too. `async` runs the hook without blocking
 *     the turn; dropping it makes the hook synchronous, which is the *stricter*
 *     direction and the one safe default.
 *
 * The event list is the other half of the decision and it is in the SDK:
 * {@link QODER_HOOK_EVENTS}, eighteen names. Seven of them are events this build
 * runs; the rest are reported through `droppedEvents`, which is what
 * `normalizeClaudeHooks` collects precisely so an event nobody has a word for
 * becomes a sentence rather than a silence.
 */
function planQoderHooks(raw: RawQoder, items: MigrationItem[], claimHooks: ClaimHooks): void {
	if (raw.hooks === undefined) return;
	const from = qoderFrom(raw, "hooks");

	// The three fields this build's hook entry has no room for. `if` and `once`
	// change *whether* a hook runs, so widening it is the direction that must not
	// happen on a migration's own judgement; `asyncRewake` has no analogue at all.
	const conditional = QoderHookCount(raw.hooks, (entry) => typeof entry.if === "string" && entry.if.trim() !== "");
	const once = QoderHookCount(raw.hooks, (entry) => entry.once === true);
	const asyncRewake = QoderHookCount(raw.hooks, (entry) => entry.asyncRewake === true);

	// A hook that is `http` rather than `command` has no analogue here at all:
	// this build runs shell commands and nothing else. `normalizeClaudeHandler`
	// drops it and counts it, so the count reaches the report through the same
	// path as everything else.
	const normalized = normalizeClaudeHooks(raw.hooks);

	const downgrades: string[] = [];
	if (conditional > 0)
		downgrades.push(
			`${conditional} handler(s) carried an \`if\` condition and were not imported — this build's hook has no condition field, so importing one would run it every time instead of only when the condition held`,
		);
	if (once > 0)
		downgrades.push(
			`${once} handler(s) were marked \`once\` and were not imported — dropping the flag would make them run on every event rather than one`,
		);
	if (asyncRewake > 0) downgrades.push(`${asyncRewake} handler(s) asked for asyncRewake, which has no analogue here`);
	if (normalized.droppedHandlers > 0) {
		downgrades.push(
			`${normalized.droppedHandlers} handler(s) were not shell commands (Qoder also has \`http\` hooks) and were dropped`,
		);
	}
	if (normalized.malformed > 0)
		downgrades.push(
			`${normalized.malformed} entr${normalized.malformed === 1 ? "y was" : "ies were"} malformed or carried no usable command`,
		);
	if (normalized.clampedTimeouts > 0)
		downgrades.push(`${normalized.clampedTimeouts} timeout(s) were clamped to the longest this build waits`);

	const eventCount = Object.keys(normalized.config).length;
	if (eventCount === 0) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				`none of the ${Object.keys(isRecord(raw.hooks) ? raw.hooks : {}).length} event(s) Qoder declares here produced a hook this build can run` +
				(normalized.droppedEvents.length > 0
					? `: ${summarizeNames(normalized.droppedEvents)} ${normalized.droppedEvents.length === 1 ? "is an event" : "are events"} Qoder has and this build does not`
					: ""),
			containsSecret: false,
		});
		return;
	}

	claimHooks(
		SOURCE,
		normalized.config,
		from,
		downgrades.length > 0
			? `${eventCount} event(s) imported — ${downgrades.join("; ")}`
			: `${eventCount} event(s) imported verbatim; every handler is a shell command, as this build's hooks are`,
		downgrades.length > 0 ? "downgrade" : "map",
	);
	if (normalized.droppedEvents.length > 0) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail: `${normalized.droppedEvents.length} of Qoder's event name(s) ${summarizeNames(normalized.droppedEvents)} ${normalized.droppedEvents.length === 1 ? "is an event" : "are events"} this build has no hook for, and the ${normalized.droppedEvents.length === 1 ? "hook" : "hooks"} under ${normalized.droppedEvents.length === 1 ? "it" : "them"} would never fire — Qoder declares ${QODER_HOOK_EVENTS.length} events in total`,
			containsSecret: false,
		});
	}
	if (normalized.droppedMatchers.length > 0) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "downgrade",
			detail: `${normalized.droppedMatchers.length} matcher(s) left off — this build escapes a matcher's pattern characters, so the one carried would have matched a literal rather than the tool ${summarizeNames(normalized.droppedMatchers)}`,
			containsSecret: false,
		});
	}
}

/**
 * Count the hook entries matching a predicate, without reading anything else.
 *
 * Walks the same three levels `hGr` does — event → group → handler — and treats
 * anything that is not the shape as not matching, which is the same tolerance
 * `normalizeClaudeHooks` applies. It exists so the report can say "3 handlers were
 * left off" from the file rather than from a guess about how many were there.
 */
function QoderHookCount(hooks: unknown, predicate: (entry: Record<string, unknown>) => boolean): number {
	if (!isRecord(hooks)) return 0;
	let count = 0;
	for (const groups of Object.values(hooks)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
			for (const entry of group.hooks) {
				if (isRecord(entry) && predicate(entry)) count += 1;
			}
		}
	}
	return count;
}

/**
 * Whether a path is absolute, without pulling `node:path`'s platform behaviour in.
 *
 * Qoder's own check is `path.isAbsolute`, which is platform-dependent — and this
 * reader has to decide about a *file written on another machine*, so it tests both
 * spellings rather than the one this process would use. A Windows path read on
 * Linux is absolute in every sense that matters here, and dropping it because the
 * importing machine is not Windows would lose a working server.
 */
function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** The plugin keys, named. Installing a plugin is an install, not a copy. */
function planQoderPlugins(raw: RawQoder, items: MigrationItem[]): void {
	if (raw.settings === null) return;
	for (const key of ["enabledPlugins", "pluginConfigs"]) {
		const value = raw.settings[key];
		if (value === undefined) continue;
		items.push({
			source: SOURCE,
			from: qoderFrom(raw, key),
			to: "—",
			action: "skip",
			detail:
				`${summarizeNames(Object.keys(isRecord(value) ? value : {}))} — a Qoder plugin is an installed directory with a plugin.json, a ` +
				"skills/, agents/, hooks/hooks.json and its own mcp.json inside it, so the name is all this file holds. Copying the name " +
				"would import a server or an agent that does not exist here; the plugin's own files were not read either",
			containsSecret: false,
		});
	}
}

/**
 * Skills and memory.
 *
 * **A skill is copied verbatim because the two shapes are the same** — a
 * directory with a `SKILL.md` in it, carrying `name` and `description` — so there
 * is no rewrite to explain. The two memory documents are told apart by name:
 * `MEMORY.md` is Qoder's index and a dated file is an entry, and both become rule
 * files with distinct names because collapsing them would assert that an index is
 * an entry.
 */
function planQoderAssets(raw: RawQoder, force: boolean, items: MigrationItem[], writes: PlannedWrite[]): void {
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
			detail: `a skill named "${collision.name}" is in both ${collision.kept} and here; Qoder reads the first, so the second was not read`,
			containsSecret: false,
		});
	}

	const basenames = new Map<string, number>();
	for (const document of raw.memory) {
		const stem = document.name.replace(/\.[^.]*$/, "").toLowerCase();
		basenames.set(stem, (basenames.get(stem) ?? 0) + 1);
	}
	for (const document of raw.memory) {
		const isIndex = document.name.toLowerCase() === QODER_MEMORY_INDEX_NAME.toLowerCase();
		// The index and the entries would otherwise both want `memory.md` if a user
		// had only one of them, and two documents wanting one target path is the
		// case `planAntigravityAssets` guards against by folding the path in.
		const fileName = isIndex
			? `imported-qoder-${QODER_MEMORY_INDEX_NAME.replace(/\.[^.]*$/, "")}.md`
			: `imported-qoder-${document.name.replace(/\.[^.]*$/, "")}.md`;
		planMemoryAsRule(
			SOURCE,
			tildePath(raw.home, document.sourcePath),
			raw.home,
			document.content,
			fileName,
			force,
			items,
			writes,
		);
	}
	if (basenames.size > 1) {
		items.push({
			source: SOURCE,
			// The memory directory, not `settings.json`: memory is not a settings
			// field at all — it is a directory beside the settings document — and a
			// report line pointing a user at the settings file to look for their
			// memory would send them somewhere with none in it.
			from: tildePath(raw.home, qoderMemoryDir(raw.configDir)),
			to: "—",
			action: "downgrade",
			detail:
				"Qoder's memory came across as one rule file per document — its index plus each dated entry — because this build has no " +
				"memory directory and no index format to keep, so what pointed at what is now the file names",
			containsSecret: false,
		});
	}
}

/**
 * Everything the reader saw and this importer will not carry.
 *
 * **The session count is the point of this function.** A report that says "7
 * sessions left behind" is worth writing even though the migration does not move
 * them: it is the difference between a user who expected their history to come
 * across and being told, and a user who never had any.
 */
function planQoderLeftovers(raw: RawQoder, items: MigrationItem[]): void {
	if (raw.projectMcpPath !== null) {
		items.push({
			source: SOURCE,
			from: raw.projectMcpPath,
			to: "—",
			action: "skip",
			detail:
				"the project's own MCP file, named whether or not it is there and not read either way. It is a separate location from " +
				"settings.json, so the three-layer settings merge does not reach it, and nothing in either bundle says how the two combine " +
				"— so reading this one and merging it with the settings servers would be a guess with a report attached to it. Copy its " +
				"servers over by hand if the project has any",
			containsSecret: false,
		});
	}
	if (raw.sessionCount > 0) {
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, raw.configDir)}/projects (${raw.sessionCount} transcript${raw.sessionCount === 1 ? "" : "s"} across ${raw.projectCount} project${raw.projectCount === 1 ? "" : "s"})`,
			to: "—",
			action: "skip",
			detail:
				`${raw.sessionCount} session transcript(s) in ${raw.projectCount} project director${raw.projectCount === 1 ? "y" : "ies"}, each named and measured and none read. ` +
				"The layout is Qoder's own — one directory per working directory, one <sessionId>.jsonl per session — but what is inside a " +
				"transcript is not established: the file's writer is the native qoder-runtime-host binary, which is in none of the three " +
				"JavaScript bundles Qoder ships. Copying them on a guessed record shape would produce histories that look right and are not",
			containsSecret: false,
		});
	}

	const other = qoderOtherConfigDir(raw.home, raw.configDir);
	items.push({
		source: SOURCE,
		from: tildePath(raw.home, other),
		to: "—",
		action: "skip",
		detail:
			"the other Qoder build's configuration home, not read: Qoder resolves one home per process and picks the build at start-up, so a " +
			"machine holding both `.qoder` and `.qoder-cn` has two *installs* rather than two halves of one. Anything only that tree holds " +
			"stayed there",
		containsSecret: false,
	});

	if (raw.rejectedDirName !== null) {
		items.push({
			source: SOURCE,
			from: "QODER_CONFIG_DIR_NAME",
			to: "—",
			action: "skip",
			detail: raw.rejectedDirName,
			containsSecret: false,
		});
	}

	// The desktop store. Existence is the only thing asked of it, and the *name* is
	// what a report may print: it holds encrypted BYOK and OAuth credentials
	// alongside the conversations, and neither is something a migration should read
	// from a live database the app is writing to.
	items.push({
		source: SOURCE,
		from: raw.desktopStore === null ? "%APPDATA% (not supplied to this run)" : raw.desktopStore.path,
		to: "—",
		action: "skip",
		detail:
			"Qoder's desktop application keeps its conversations and its account state in a SQLite store under the platform app-data " +
			"directory, opened in WAL mode and written while the app runs. It was not opened by this import: two of its tables hold " +
			"encrypted credentials, and the conversation rows are a separate piece of work from the ones in ~/.qoder",
		containsSecret: false,
	});

	// Unhandled keys are reported **per layer**, not over the merged document. The
	// merged document's top-level keys are the union of the three files', so one
	// line over it would name every file's unhandled keys against whichever file
	// the user reads first — and a key a project layer carried that the merge then
	// dropped would be reported as if it were live. One line per file is also the
	// more useful answer: it says *which* file holds the thing with no mapping.
	for (const layer of raw.settingsLayers) {
		const file = tildePath(raw.home, layer.path);
		reportUnhandledKeys(SOURCE, layer.settings, QODER_SETTINGS_HANDLED, file, items);
		const general = layer.settings.general;
		if (isRecord(general)) {
			reportUnhandledKeys(SOURCE, general, QODER_GENERAL_HANDLED, `${file} → general`, items);
		}
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

/**
 * Assemble the plan.
 *
 * Every parameter is one something below uses: `claimModePair` for the one
 * scalar, `claimHooks` for the hook block, `mcpServers`/`markMcpSecret` for the
 * one place a credential could still reach a written file, and
 * `existingMcpServers`/`force` for a server the user already has. There is **no
 * `claimEnv` and no `claimScalar`**, and both absences are load-bearing rather
 * than oversights: this build has one variable Qoder stores a value under — an
 * MCP server's `env` — and the instruction on this source is that those values
 * do not come across, and there is no theme or model to claim at all. See the
 * header for why.
 */
export function planQoder(
	raw: RawQoder,
	items: MigrationItem[],
	writes: PlannedWrite[],
	claimModePair: ClaimModePair,
	claimHooks: ClaimHooks,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	planQoderAbsentScalars(raw, items);
	planQoderPermissionMode(raw, items, claimModePair);
	planQoderMcp(raw, items, mcpServers, markMcpSecret, existingMcpServers, force);
	planQoderHooks(raw, items, claimHooks);
	planQoderPlugins(raw, items);
	planQoderAssets(raw, force, items, writes);
	planQoderLeftovers(raw, items);
}
