/**
 * OpenClaw → this build: what each of OpenClaw's documents maps to, and what does
 * not.
 *
 * Read `openclaw-read.ts` first — the standing caveats are there. The four
 * decisions that shape everything below:
 *
 *   1. **There is no credential to migrate, and four places a credential hides.**
 *      `mcp.servers[].env` and `.headers` are registered sensitive by the product's
 *      own schema (`zod-schema.mcp-server.ts:20-24,33-37`) so their values are
 *      dropped and their names reported. `models.providers.<id>.apiKey` is a
 *      `SecretInput` (`types.models.ts:64`) — a literal *or* a reference — and
 *      `memory.search.remote.apiKey` is its sibling. **And `mcp.servers[].url` is
 *      the one no key-name scan can see**: it is validated only as http/https
 *      (`:26`), so `https://user:token@host/mcp` is a working server as far as
 *      OpenClaw is concerned. That last one is handled by
 *      {@link urlCredentialProblem} rather than by anything here, and it is the
 *      same guard the fourteen existing sources use.
 *   2. **A whole-file failure is reported as a whole-file failure.** OpenClaw's
 *      MCP schema rejects nine top-level keys and one nested one, and a file
 *      carrying any of them **does not load at all** (`:77-113`). Importing the
 *      surviving servers would report a healthy install where the product refuses
 *      to start, so {@link planOpenClawMcp} refuses the whole map and says which
 *      keys decided it.
 *   3. **Two settings documents, neither merged into the other.** The planner
 *      reads both because a user's model, theme and thinking level may be in
 *      either, and it claims each from the one that actually holds it.
 *   4. **The workspace instruction documents are not state.** `AGENTS.md` is
 *      imported from the *workspace* the caller pointed at; the other five are
 *      named, because "this build has no equivalent" and "we did not look" are
 *      different claims and only one is true.
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
import {
	OPENCLAW_BOOTSTRAP_FILENAMES,
	OPENCLAW_PRIMARY_INSTRUCTION_FILE,
	openclawProfileRejection,
	openclawProfileStateNotice,
} from "./openclaw-home.ts";
import type { RawOpenClaw } from "./openclaw-read.ts";

/**
 * This source's id, spelled once.
 *
 * The union and every table keyed by it live in `migrate-types.ts`; this is a plain
 * literal with no cast. The call lives in `migrate.ts` — see that file's arm for
 * `openclaw`, which is where this planner is actually reached from.
 */
const SOURCE: MigrationSourceId = "openclaw";

/**
 * Top-level keys of `openclaw.json` this planner has an opinion about.
 *
 * **Everything else is named, not imported** — see {@link reportUnhandledKeys}. The
 * document has 46 top-level keys (`types.openclaw.ts:42-144`) and a migration that
 * claimed all of them would be claiming to understand OpenClaw's whole
 * configuration surface. The ones handled here are the ones a migration of *this*
 * shape is about: the MCP map, the hook registry, the agent defaults and the
 * workspace instructions.
 */
const OPENCLAW_HANDLED_KEYS = new Set(["$include", "mcp", "hooks", "agents", "skills", "env", "models", "memory"]);

/**
 * The keys this build's MCP server config can carry, and what each costs.
 *
 * Sixteen of OpenClaw's twenty-two survive the trip with no change beyond the
 * transport rename. The six that do not are named in {@link planOpenClawMcp}.
 */
const OPENCLAW_MCP_KEYS = new Set([
	"enabled",
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"transport",
	"headers",
	"connectionTimeoutMs",
	"requestTimeoutMs",
	"supportsParallelToolCalls",
	"auth",
	"oauth",
	"sslVerify",
	"clientCert",
	"clientKey",
	"toolFilter",
	"codex",
]);

/**
 * OpenClaw's transports, and what this build calls them.
 *
 * `stdio` is spelled the same in both. `sse` and `streamable-http` are both HTTP
 * clients here, so both become `http` with a downgrade line saying so — the same
 * trade `planQoderMcp` makes for Qoder's `sse`.
 */
const OPENCLAW_HTTP_TRANSPORTS = new Set(["sse", "streamable-http"]);

/** Keys `scrubOpenClawCredentials` already removed, so the planner cannot re-report them. */
const OPENCLAW_SCRUBBED_KEYS = new Set([
	"env",
	"headers",
	"apiKey",
	"clientCert",
	"clientKey",
	"tokens",
	"vars",
	"authProfiles",
	"auth",
]);

/**
 * Plan the whole source.
 *
 * **One arm per category, and the shape is Antigravity's** rather than Qoder's:
 * settings and assets are gated separately so a run that asked only for assets
 * still reaches the skills and the workspace instructions without passing through
 * a settings gate that happens to be empty.
 */
export function planOpenClaw(
	raw: RawOpenClaw,
	items: MigrationItem[],
	writes: PlannedWrite[],
	claimModePair: ClaimModePair,
	claimHooks: ClaimHooks,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	if (raw.settings !== null || raw.agentSettings !== null) {
		planOpenClawPermissionMode(raw, items, claimModePair);
		planOpenClawHooks(raw, items, claimHooks);
		planOpenClawMcp(raw, items, mcpServers, markMcpSecret, existingMcpServers, force);
		planOpenClawSettingsLeftovers(raw, items);
		planOpenClawPresets(raw, items);
	}
	planOpenClawAssets(raw, items, writes, force);
	planOpenClawEnvironmentLeftovers(raw, items);
}

// ---------------------------------------------------------------------------
// Permission mode
// ---------------------------------------------------------------------------

/**
 * OpenClaw's stated permission posture → this build's two mode axes.
 *
 * **`agents.defaults.permissionMode` is the key, and the mapping is by name
 * rather than by a guessed default.** OpenClaw's own vocabulary is `default`,
 * `ask`/`prompt`, `acceptEdits`, `bypassPermissions`/`yolo` and `plan` — the
 * spellings `planT3RuntimeMode` and `planQoderPermissionMode` already meet on
 * other sources, so this one reuses their conclusions rather than inventing a
 * third.
 *
 * **`default` maps to nothing**, for the reason `planQoderPermissionMode` gives:
 * it is the schema's absence rather than a choice, and writing the strictest
 * posture on the user's behalf is the fail-open failure a migration must not
 * commit. An absent key says nothing at all.
 */
function planOpenClawPermissionMode(raw: RawOpenClaw, items: MigrationItem[], claimModePair: ClaimModePair): void {
	const defaults = readAgentDefaults(raw);
	const value = defaults?.permissionMode;
	if (value === undefined || value === null) return;
	const shown = typeof value === "string" ? value : JSON.stringify(value);
	const from = `${tildePath(raw.home, raw.configPath)} → agents.defaults.permissionMode (${shown})`;
	if (typeof value !== "string") {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				"`agents.defaults.permissionMode` is not a string, and this build's mode is chosen by name — set it with /permissions",
			containsSecret: false,
		});
		return;
	}
	const mapped = mapOpenClawPermissionMode(value);
	if (mapped === null) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				`OpenClaw names it "${value}", which is not one of the postures this build distinguishes. Nothing was written rather than a ` +
				"nearest match chosen for you — a permission setting is the one thing a migration must not widen on its own judgement",
			containsSecret: false,
		});
		return;
	}
	if (mapped === "schema-default") {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				`"${value}" is the schema's own default rather than a choice you made, so importing it would write a posture your file never ` +
				"stated. Leave this build at its own default, or set one with /permissions",
			containsSecret: false,
		});
		return;
	}
	claimModePair(SOURCE, mapped.mode, mapped.sandbox, from, mapped.detail);
}

/** A claimed mode pair, with the sentence the report prints. */
type OpenClawModePair = { mode: PermissionMode; sandbox: SandboxMode; detail: string };

/**
 * OpenClaw's permission vocabulary → this build's two axes.
 *
 * **Two of the names map to nothing, and both absences are deliberate.**
 * `default` is the schema's absence rather than a choice. `plan` has no counterpart
 * here: this build has a plan *mode* that is entered by a command rather than
 * configured, so importing it would write a setting that does not exist.
 */
function mapOpenClawPermissionMode(value: string): OpenClawModePair | "schema-default" | null {
	switch (value) {
		case "default":
			return "schema-default";
		case "ask":
		case "prompt":
			return {
				mode: "ask",
				sandbox: "workspace-write",
				detail: "asked for every action, which is this build's `ask` with its default confinement",
			};
		case "acceptEdits":
			return {
				mode: "ask",
				sandbox: "workspace-write",
				detail:
					"asked for everything, which is **narrower than it says**: this build has no mode that applies edits without asking, so " +
					"every write gets asked like everything else",
			};
		case "bypassPermissions":
		case "yolo":
			// Both halves claimed together, because the single value is doing two
			// jobs — never ask *and* no confinement. Claiming only the mode half
			// would leave a session that auto-approves everything and still enforces
			// a sandbox, a combination no user chose.
			return {
				mode: "agent",
				sandbox: "danger-full-access",
				detail:
					"copied as **no confirmation and no confinement**, because the one OpenClaw setting is doing both jobs; OpenClaw warns " +
					"about this posture itself and so does this line",
			};
		default:
			return null;
	}
}

/** `agents.defaults` from whichever document holds it, or `null`. */
function readAgentDefaults(raw: RawOpenClaw): Record<string, unknown> | null {
	for (const document of [raw.settings, raw.agentSettings]) {
		if (document === null) continue;
		const agents = document.agents;
		if (!isRecord(agents)) continue;
		const defaults = agents.defaults;
		if (isRecord(defaults)) return defaults;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * `hooks` → this build's hook configuration, through the shared normalizer.
 *
 * **Passed through rather than interpreted**, for the reason `qoder-plan.ts` gives
 * in its own words: `normalizeClaudeHooks` is what knows this build's event names,
 * and an event OpenClaw registers under a name this build has no word for becomes
 * a report line rather than a silent loss. The product's hook registry is
 * open-world in the same way its MCP schema is.
 */
function planOpenClawHooks(raw: RawOpenClaw, _items: MigrationItem[], claimHooks: ClaimHooks): void {
	if (raw.settings === null) return;
	const hooks = raw.settings.hooks;
	if (hooks === undefined || !isRecord(hooks)) return;
	// Through the shared normalizer rather than a second implementation: this build
	// does not have a second opinion about what a hook is, and an event it has no
	// word for becomes a `droppedEvents` line rather than a silent loss.
	const normalized = normalizeClaudeHooks(hooks);
	if (Object.keys(normalized.config).length === 0 && normalized.droppedEvents.length === 0) return;
	claimHooks(
		SOURCE,
		normalized.config,
		`${tildePath(raw.home, raw.configPath)} → hooks`,
		normalized.droppedEvents.length > 0
			? `OpenClaw's hook registry is open-world, so ${normalized.droppedEvents.length} event${normalized.droppedEvents.length === 1 ? "" : "s"} this build does not run (${summarizeNames(normalized.droppedEvents, 6)}) ${normalized.droppedEvents.length === 1 ? "was" : "were"} dropped and named rather than copied`
			: "copied; OpenClaw's hook registry is open-world, so any event this build does not run would be named here rather than dropped silently",
	);
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/**
 * `mcp.servers` → this build's `.mcp.json`.
 *
 * **Refused whole when the product would refuse the file.** OpenClaw's schema
 * rejects nine top-level keys and one nested one, and a configuration carrying any
 * of them fails to load *entirely* (`:77-113`) — so an install with three working
 * servers and one retired key has no working servers at all. Importing two thirds
 * of a map OpenClaw cannot load would report a healthy install where the product
 * refuses to start, and the user would have no idea which key to remove.
 */
function planOpenClawMcp(
	raw: RawOpenClaw,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const names = Object.keys(raw.mcpServers);
	const from = `${tildePath(raw.home, raw.configPath)} → mcp.servers`;
	if (names.length === 0) return;

	if (raw.retiredMcpKeys.length > 0) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				`nothing was imported: ${summarizeNames(raw.retiredMcpKeys, 12)} — OpenClaw's own MCP schema rejects ${raw.retiredMcpKeys.length === 1 ? "this key" : "these keys"}, and a configuration carrying ` +
				`${raw.retiredMcpKeys.length === 1 ? "it" : "one"} fails to load in its entirety rather than ignoring ${raw.retiredMcpKeys.length === 1 ? "it" : "them"}. The ${names.length} server${names.length === 1 ? "" : "s"} configured here are ` +
				"therefore named and not copied — remove or rename the key in OpenClaw (or with `openclaw doctor --fix`) and run this again",
			containsSecret: false,
		});
		return;
	}

	for (const name of names) {
		const entry = raw.mcpServers[name];
		const entryFrom = `${from}.${name}`;
		if (!isRecord(entry)) {
			items.push({
				source: SOURCE,
				from: entryFrom,
				to: "—",
				action: "skip",
				detail: "not a server table",
				containsSecret: false,
			});
			continue;
		}

		// `enabled: false` is OpenClaw's own off switch (`zod-schema.mcp-server.ts:17`).
		// Importing it would add a server the user had turned off.
		if (entry.enabled === false) {
			items.push({
				source: SOURCE,
				from: entryFrom,
				to: "—",
				action: "skip",
				detail:
					"OpenClaw has this server switched off (`enabled: false`). Importing it would add a server to the target's configuration " +
					"the user had turned off, so it was left out — add it with /mcp if you want it",
				containsSecret: false,
			});
			continue;
		}

		const command = typeof entry.command === "string" ? entry.command.trim() : "";
		const url = typeof entry.url === "string" ? entry.url.trim() : "";
		const hasCommand = command !== "";

		if (!hasCommand && url === "") {
			items.push({
				source: SOURCE,
				from: entryFrom,
				to: "—",
				action: "skip",
				detail:
					"it names neither a command nor a URL, which are the two ways OpenClaw serves an MCP server — nothing was serving it over " +
					"there either",
				containsSecret: false,
			});
			continue;
		}
		if (hasCommand && url !== "") {
			// OpenClaw's own `superRefine` calls this out for OAuth servers
			// (`:137-142`): a command and a transport that resolves stdio strands
			// the server with no sign-in path. Importing one of the two would be
			// picking for the user.
			items.push({
				source: SOURCE,
				from: entryFrom,
				to: "—",
				action: "skip",
				detail:
					"it names both a command and a URL, which OpenClaw's own validator rejects as an error rather than picking one — so this is " +
					"one OpenClaw would not load, and choosing a transport for it would be choosing for it",
				containsSecret: false,
			});
			continue;
		}

		// **The credential channel no key-name scan can see.** The URL is validated
		// only as http/https, so `https://user:token@host/mcp` is a working server as
		// far as OpenClaw is concerned and the credential is inside the one string
		// every importer treats as a safe identifier. `headers` and `env` are handled
		// by dropping the value and keeping the server; **there is no such half
		// here** — a URL with its userinfo removed is a different URL pointing at
		// nothing. So the server is not carried across, and the reason names the shape
		// without printing any of it.
		if (!hasCommand && url !== "") {
			const problem = urlCredentialProblem(url);
			if (problem !== null) {
				items.push({
					source: SOURCE,
					from: entryFrom,
					to: "—",
					action: "skip",
					detail:
						`left off, because ${problem} — OpenClaw validates a server URL only as http/https, so a credential inside the address is a ` +
						"working server to it; unlike a header or an environment variable there is no way to drop the credential and keep the " +
						"address, so nothing was written. Add the server again here with the credential in your environment instead",
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
			if (entry.args !== undefined && !Array.isArray(entry.args)) {
				downgrades.push("its `args` was not an array, so none was read");
			}
			if (args.length > 256) downgrades.push(`only the first 256 of ${args.length} arguments came across`);
			config.type = "stdio";
			config.command = command;
			config.args = strings.slice(0, 256);
			if (typeof entry.cwd === "string") config.cwd = entry.cwd;
			const transport = typeof entry.transport === "string" ? entry.transport : "";
			if (transport === "sse" || transport === "streamable-http") {
				downgrades.push(
					`it declares the "${transport}" transport, but a \`command\` makes it a stdio server here — OpenClaw reads the command first too`,
				);
			} else if (transport !== "" && transport !== "stdio") {
				downgrades.push(
					`its \`transport\` of ${summarizeNames([transport])} is not one OpenClaw accepts (${summarizeNames(["stdio", "sse", "streamable-http"])}), so it was read as a plain stdio server`,
				);
			}
		} else {
			config.type = "http";
			config.url = url;
			const transport = typeof entry.transport === "string" ? entry.transport : "";
			if (OPENCLAW_HTTP_TRANSPORTS.has(transport)) {
				downgrades.push(
					`OpenClaw spells this transport "${transport}" and this build has one HTTP client, so it connects the same way`,
				);
			} else if (transport !== "" && transport !== "streamable-http") {
				downgrades.push(
					`its \`transport\` of ${summarizeNames([transport])} is not one OpenClaw accepts (${summarizeNames(["stdio", "sse", "streamable-http"])}), so it was read as a plain HTTP server`,
				);
			}
		}

		// The two credential blocks. The reader dropped their **values**, so what
		// arrives here is the *names*, carried separately in
		// `raw.mcpCredentialNames` — reading them off `entry` would find nothing,
		// because the keys are gone, and the server would report as a clean `map`.
		const credentialNames = raw.mcpCredentialNames[name];
		const headerNames = credentialNames?.headers ?? [];
		const envNames = credentialNames?.env ?? [];
		if (headerNames.length > 0) {
			downgrades.push(
				`left off ${summarizeNames(headerNames)} — OpenClaw's own schema registers every header value as sensitive, and a header is an ` +
					"ordinary place for a bearer token, so this importer writes none of them",
			);
		}
		if (envNames.length > 0) {
			downgrades.push(
				`left off ${envNames.length} environment variable${envNames.length === 1 ? "" : "s"} (${summarizeNames(envNames)}) — the names came ` +
					"across in this report, the values did not, so a server that needs a secret has to have it set again here",
			);
		}

		if (!McpServerConfigSchema.safeParse(config).success) {
			items.push({
				source: SOURCE,
				from: entryFrom,
				to: "—",
				action: "skip",
				detail: hasCommand
					? "its command, arguments or working directory are not a stdio server definition this build accepts"
					: "its URL is not an address this build's MCP client accepts",
				containsSecret: false,
			});
			continue;
		}

		// The keys OpenClaw accepts that this build has no field for. `auth`/`oauth`
		// are credential *state* — an OpenAI OAuth login for one MCP server — and
		// there is nothing to carry: the user signs in again here.
		const uncarried = [
			"connectionTimeoutMs",
			"requestTimeoutMs",
			"supportsParallelToolCalls",
			"sslVerify",
			"toolFilter",
			"codex",
			"oauth",
			"auth",
		].filter((key) => entry[key] !== undefined);
		if (uncarried.length > 0) {
			downgrades.push(
				`left off ${summarizeNames(uncarried)} — this build's server config has no field for ${uncarried.length === 1 ? "it" : "them"}` +
					(entry.oauth !== undefined || entry.auth !== undefined
						? ", and an OAuth sign-in is state this build keeps of its own: add the server here and sign in again"
						: ""),
			);
		}
		const extra = Object.keys(entry).filter(
			(key) => !OPENCLAW_MCP_KEYS.has(key) && !OPENCLAW_SCRUBBED_KEYS.has(key) && !uncarried.includes(key),
		);
		if (extra.length > 0) {
			downgrades.push(
				`left off ${summarizeNames(extra)} — OpenClaw's MCP schema is open-world (it ends in a catchall), so unknown keys are accepted ` +
					`there and have no meaning in this build's server configuration`,
			);
		}

		if (name in existingMcpServers && !force) {
			items.push({
				source: SOURCE,
				from: entryFrom,
				to: "—",
				action: "skip",
				detail: "target already defines a server with this name — kept (use --force to overwrite)",
				containsSecret: false,
			});
			continue;
		}

		// Nothing credential-shaped was copied, so this is never true for an entry
		// OpenClaw accepted. It is computed rather than assumed so that a future
		// change which *did* start copying a value has to make this turn true on
		// purpose.
		const secret = false;
		mcpServers[name] = config;
		markMcpSecret(secret);
		items.push({
			source: SOURCE,
			from: entryFrom,
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
// Settings leftovers
// ---------------------------------------------------------------------------

/**
 * The top-level keys this planner claims nothing from, and the documents.
 *
 * **Two settings documents, reported as two.** `<stateDir>/openclaw.json` is the
 * product configuration; `<agentDir>/settings.json` is a forked Claude Code
 * settings manager (`settings-storage.ts:89`) that holds `defaultProvider`,
 * `defaultModel`, `defaultThinkingLevel` and `theme` (`:73-111`). **A user's
 * model, theme and thinking level may live in the second and not the first**, and
 * a report that only read the first would say "no model set" for a user who set
 * one — which is the most common way a migration of this shape goes wrong.
 */
function planOpenClawSettingsLeftovers(raw: RawOpenClaw, items: MigrationItem[]): void {
	// The model / theme / thinking level sentence, worded from what was actually
	// read rather than from what the schema could hold.
	const modelSource = readFirstString([
		[raw.agentSettings, "defaultModel"],
		[raw.settings?.agents, "defaults.model"],
	]);
	if (modelSource === null) {
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, raw.configPath)} + ${
				raw.agentSettingsPath === null ? "no agent settings document" : tildePath(raw.home, raw.agentSettingsPath)
			} → model`,
			to: "—",
			action: "skip",
			detail:
				"no model was taken from either settings document. OpenClaw splits its configuration in two and a model can be in either: " +
				"`openclaw.json` is the product configuration, and `<agentDir>/settings.json` is a separate forked Claude Code settings " +
				"manager holding `defaultProvider`/`defaultModel`/`defaultThinkingLevel`/`theme`. Neither stated one here — set it with /model",
			containsSecret: false,
		});
	} else {
		items.push({
			source: SOURCE,
			from: modelSource.label,
			to: "—",
			action: "skip",
			detail:
				"a model is named in OpenClaw's settings but was not carried across: it is an OpenClaw provider model id from its own catalog " +
				"(or a bare alias for one), and this build resolves model references against its own registry, so an id that does not resolve " +
				"there would leave you with a broken setting rather than a working one. Note it here and pick from /model",
			containsSecret: false,
		});
	}

	// The retired agent-settings keys. Four checks, two of which are not top-level
	// names, and a document carrying one **does not load** (`settings-manager.ts:51-77`).
	if (raw.retiredAgentSettingKeys.length > 0) {
		items.push({
			source: SOURCE,
			from: raw.agentSettingsPath === null ? "<agentDir>/settings.json" : tildePath(raw.home, raw.agentSettingsPath),
			to: "—",
			action: "skip",
			detail:
				`nothing was taken from this document: it carries ${summarizeNames(raw.retiredAgentSettingKeys)}, which OpenClaw's own settings ` +
				"manager rejects outright — a settings file with one of these does not load at all. Fix it in OpenClaw and run this again",
			containsSecret: false,
		});
	}

	// The provider env list, and the one finding that carries out of this module.
	// The names come from the reader rather than from `raw.settings.env`, because
	// the scrub has already removed the values — and with them every name that read
	// as a credential, which is precisely the set this line exists to print.
	const envNames = raw.envNames;
	if (envNames.length > 0) {
		const competitors = envNames.filter((name) => OPENCLAW_COMPETITOR_KEY_RE.test(name));
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, raw.configPath)} → env`,
			to: "—",
			action: "skip",
			detail:
				`left off ${envNames.length} environment variable${envNames.length === 1 ? "" : "s"} (${summarizeNames(envNames)}) — their values did not come across, ` +
				"which is the ordinary case for a key. " +
				(competitors.length > 0
					? `Note that ${summarizeNames(competitors)} ${competitors.length === 1 ? "is" : "are"} in OpenClaw's own provider key list (src/infra/dotenv.ts), so this ` +
						"config file is the place other tools' credentials live; write this build's keys in its own environment rather than in a shared settings file"
					: "Set them in this build's environment rather than in a settings file, so a migration of another tool's config cannot pick them up"),
			containsSecret: false,
		});
	}

	if (raw.settings !== null) {
		reportUnhandledKeys(SOURCE, raw.settings, OPENCLAW_HANDLED_KEYS, tildePath(raw.home, raw.configPath), items);
	}

	// The `$include` graph, and its failures. **A missing include is a hole in the
	// document this report is describing**, and saying so is the difference between
	// "here is everything OpenClaw is running" and "here is what I could read".
	// **Only when there was something to include.** `includeFiles` always holds the
	// root document itself, so a `> 0` test would print "merged 1 configuration
	// file through `$include`" for every install that never used the feature — a
	// line claiming a layering step happened when none did.
	if (raw.includeFiles.length > 1) {
		const layers = raw.includeFiles.map((file) => tildePath(raw.home, file));
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, raw.configPath),
			to: `${tildePath(raw.home, raw.configPath)} (merged)`,
			action: "map",
			detail:
				`merged ${layers.length} configuration files through \`$include\` before anything above was read — ` +
				"OpenClaw layers included files over the root one, so reading the root alone would have imported a document the product is not " +
				`running. Layers: ${summarizeNames(layers, 6)}`,
			containsSecret: false,
		});
	}
	for (const failure of raw.includeFailures) {
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, failure.path),
			to: "—",
			action: "skip",
			detail: `an \`$include\` of the configuration that could not be applied — ${failure.reason}. The keys that did load are still imported, and this line is the gap`,
			containsSecret: false,
		});
	}
}

/**
 * Competitor credentials in OpenClaw's own provider key list (`src/infra/dotenv.ts`).
 *
 * **This is the finding that outlives the migration.** OpenClaw's provider env
 * allowlist includes `KIMI_API_KEY`, `KIMICODE_API_KEY`, `OPENCODE_API_KEY`,
 * `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY` and `MINIMAX_CODING_API_KEY`
 * (`dotenv.ts:43,61,62,76`), so an `env` block in `openclaw.json` is a place other
 * tools' credentials live. An importer that dumped `env` into this build's settings
 * would hand one tool's key to another file; an importer that copies nothing and
 * *says which names it saw* is what keeps that from being invisible.
 */
const OPENCLAW_COMPETITOR_KEY_RE =
	/^(KIMI|KIMICODE|OPENCODE|DEEPSEEK|MINIMAX|MOONSHOT|QWEN|GLM|ZHIPU|GLM_API)[A-Z0-9_]*_?(API_KEY|TOKEN|KEY)$/;

/**
 * The first `(document, path)` pair that states a non-empty string.
 *
 * `path` is dotted, because the two documents put the model at different depths —
 * `<agentDir>/settings.json` has it at the top level as `defaultModel`, and
 * `openclaw.json` has it under `agents.defaults`. Reading either as a flat key
 * finds nothing, which is the "no model set" answer for a user who set one.
 */
function readFirstString(pairs: Array<[unknown, string]>): { label: string } | null {
	for (const [document, path] of pairs) {
		if (!isRecord(document)) continue;
		let node: unknown = document;
		for (const segment of path.split(".")) {
			if (!isRecord(node)) {
				node = undefined;
				break;
			}
			node = node[segment];
		}
		if (typeof node === "string" && node.trim() !== "") return { label: `${path} = ${node.trim()}` };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Skills and the workspace instruction document.
 *
 * **The skills come from the configuration directory, not the state directory** —
 * `resolveConfigDir` (`config-dir.ts:7-20`) is the one that manages `skills/` and
 * `plugin-skills/`, and it honours neither a profile nor the `.clawdbot` fallback,
 * so it is frequently a *different path* from {@link RawOpenClaw.stateDir}. That
 * is why the reader keeps both and this planner writes the configuration one.
 */
function planOpenClawAssets(raw: RawOpenClaw, items: MigrationItem[], writes: PlannedWrite[], force: boolean): void {
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
			detail: `a skill named "${collision.name}" is in both the managed tree and the plugin tree; OpenClaw loads the managed one first, so this copy was not read`,
			containsSecret: false,
		});
	}

	if (raw.agentsMd?.trim()) {
		planMemoryAsRule(
			SOURCE,
			`${tildePath(raw.home, raw.workspaceDir ?? "")}/${OPENCLAW_PRIMARY_INSTRUCTION_FILE}`,
			raw.home,
			raw.agentsMd,
			"imported-openclaw-AGENTS.md",
			force,
			items,
			writes,
		);
	}

	// The other five, named. **They live in the workspace, not the state
	// directory** (`workspace-bootstrap-policy.ts:51-57`), so a home that never ran
	// an agent in the directory this was pointed at has them somewhere else
	// entirely — which is why presence is reported rather than assumed.
	const present = raw.otherBootstrapDocs.filter((doc) => doc.present).map((doc) => doc.name);
	if (raw.otherBootstrapDocs.length > 0) {
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, raw.workspaceDir ?? "")} → ${OPENCLAW_BOOTSTRAP_FILENAMES.slice(1).join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				`${present.length === 0 ? "none of these were" : `${present.length} of these were`} found, and none was imported. OpenClaw's workspace ` +
				`has six bootstrap documents (${OPENCLAW_BOOTSTRAP_FILENAMES.join(", ")}) and this build has a counterpart for one of them, AGENTS.md, which came across above. ` +
				"There is nothing here for a persona document (SOUL.md), a device identity (IDENTITY.md), a user profile (USER.md), a first-run script (BOOTSTRAP.md) or a root memory index " +
				`(MEMORY.md) — they were looked for in ${raw.workspaceDir === null ? "no workspace" : "the workspace this run was pointed at"}, so "nothing was imported" here means "this build has no equivalent", not "we did not look"`,
			containsSecret: false,
		});
	}
}

// ---------------------------------------------------------------------------
// Environment leftovers
// ---------------------------------------------------------------------------

/**
 * The roots that disagree, the store, the macOS Keychain, and the competitor path.
 *
 * **Every line here is a fact about what this importer did *not* touch**, and that
 * is the point: the two settings documents above are the whole of what an OpenClaw
 * install's *configuration* is, but a user who leaves OpenClaw installed keeps a
 * great deal else, and a report that said nothing about it would let them believe
 * the migration was complete.
 */
function planOpenClawEnvironmentLeftovers(raw: RawOpenClaw, items: MigrationItem[]): void {
	// The state directory and the configuration directory disagreeing is the
	// headline fact about this source's paths, so it is said whenever it happens.
	if (raw.stateDir !== raw.configDir) {
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, raw.stateDir)} vs ${tildePath(raw.home, raw.configDir)}`,
			to: "—",
			action: "skip",
			detail:
				"OpenClaw's state directory and its configuration directory are different paths on this machine, and that is not a mistake to correct " +
				"here: the state resolver falls back to the pre-rename `~/.clawdbot` while the config resolver does not, and only the config resolver " +
				"honours `OPENCLAW_CONFIG_PATH` (`src/config/state-dir.ts:33-43` against `src/infra/config-dir.ts:7-20`). Both were read; nothing moved",
			containsSecret: false,
		});
	}

	items.push({
		source: SOURCE,
		from: tildePath(raw.home, raw.legacyStateDir),
		to: "—",
		action: "skip",
		detail:
			"`~/.clawdbot` is OpenClaw's predecessor home and is still read by the product when `.openclaw` is absent (`src/config/state-dir.ts:8-10,38-43`) — an " +
			"install that upgraded kept everything here. It was read as one of the roots above when it held content; if you delete OpenClaw, this tree is " +
			"left behind and nothing in this report removed it",
		containsSecret: false,
	});

	// The retired `sessions.json`. Named, not read: `openclaw doctor --fix`
	// migrates it into SQLite, so it is a migration *source* and not a current store.
	items.push({
		source: SOURCE,
		from: raw.legacySessions === null ? "<stateDir>/sessions.json" : raw.legacySessions.path,
		to: "—",
		action: "skip",
		detail:
			raw.legacySessions?.exists === true
				? "found and **not read**. This store is retired — `src/infra/state-migrations.legacy-session-store.ts:1` says so, and `openclaw doctor --fix` migrates it " +
					"into the SQLite database above. Its conversations are in the sessions that were imported; this file is left where it is"
				: "OpenClaw's pre-SQLite `sessions.json`, retired and absent. Named because a home that upgraded from that build has its history in the database above, and a home that has not is a home with nothing to migrate",
		containsSecret: false,
	});

	// The agent store. Existence is the only thing asked of it.
	items.push({
		source: SOURCE,
		from: raw.agentDb === null ? "<agentDir>/openclaw-agent.sqlite" : raw.agentDb.path,
		to: "—",
		action: "skip",
		detail:
			`the agent's session database${raw.sessionCount === 0 ? "" : `, holding ${raw.sessionCount} session${raw.sessionCount === 1 ? "" : "s"}`}. Opened read-only, and ` +
			"only to count and to read transcripts. It also holds `auth_profile_store` and `auth_profile_state`, which carry OAuth and API-key " +
			"metadata for every provider the user has authenticated; none of it was read and none of it can be migrated — this build keeps its own",
		containsSecret: false,
	});

	// **The macOS Keychain.** OpenClaw reads two *foreign* CLI credentials from it,
	// read-only and darwin-only: service `Codex Auth` (`src/agents/cli-credentials.ts:210`)
	// and `Claude Code-credentials[-<8 hex>]`
	// (`src/plugin-sdk/provider-auth-claude-compat.ts:13-18`). Neither is ever
	// written. **A migration that bypasses OpenClaw leaves both behind**, and that
	// is the correct outcome — they belong to Codex and Claude Code — but the user
	// should hear it from the report rather than discover it as a re-login prompt.
	items.push({
		source: SOURCE,
		from: "macOS Keychain",
		to: "—",
		action: "skip",
		detail:
			"if you were on macOS, OpenClaw reads two credentials belonging to *other* tools out of the Keychain — `Codex Auth` and " +
			"`Claude Code-credentials` — and never writes them. Nothing here was read and nothing can be: this build does not read the Keychain. " +
			"Signing in to Codex or Claude Code here is a separate step, and leaving those two entries in place does no harm",
		containsSecret: false,
	});

	// **OpenClaw ships its own importer.** A user who ran `openclaw migrate` had a
	// competing path to the same destination, and the extensions that implement it
	// are named so the two can be compared rather than one silently undoing the other.
	items.push({
		source: SOURCE,
		from: "openclaw migrate",
		to: "—",
		action: "skip",
		detail:
			"**OpenClaw ships its own migration framework and you may have already run it.** `MigrationProviderPlugin` " +
			"(`src/plugins/migration-provider.types.ts:125-142`) is a detect/plan/apply plugin interface, and the shipped providers are " +
			"`extensions/migrate-claude/`, `extensions/codex/src/migration/` and `extensions/migrate-hermes/`. Those import *into* OpenClaw; this " +
			"imports *out of* it. Running both leaves two copies of your sessions, which is harmless but worth knowing",
		containsSecret: false,
	});

	const rejection = openclawProfileRejection(raw.env);
	if (rejection !== null) {
		items.push({
			source: SOURCE,
			from: "OPENCLAW_PROFILE",
			to: "—",
			action: "skip",
			detail:
				`"${raw.env.OPENCLAW_PROFILE ?? ""}" is not a profile name OpenClaw accepts (${"a-z, 0-9, _ and -, starting with a letter or digit, at most 64 characters"}). The ` +
				"product throws on such a name rather than falling back (`src/cli/profile-utils.ts:31-33`), so this is a configuration OpenClaw would " +
				"refuse to start with, and no profile directory was read",
			containsSecret: false,
		});
	}
	items.push({
		source: SOURCE,
		from: openclawProfileStateNotice(raw.env),
		to: "—",
		action: "skip",
		detail:
			"a named CLI profile moves the whole state root to `~/.openclaw-<profile>` (`src/cli/profile-utils.ts:35-37`), and `OPENCLAW_STATE_DIR` moves it anywhere at all. " +
			"Only the root this environment resolves to was read: a profile name is only discoverable from the variable, so a home that ran `openclaw --profile work` " +
			"once without exporting it has a `~/.openclaw-work` this importer never looked at",
		containsSecret: false,
	});

	planOpenClawSharedTree(raw, items);
}

/**
 * `~/.agents/skills` and `<workspace>/.agents/skills` — **the shared tree, named
 * rather than imported.**
 *
 * **OpenClaw reads them, and this importer deliberately does not.** The user-scope
 * one is `join(getHomeDir(), ".agents", "skills")`
 * (`src/agents/sessions/package-manager.ts:873`, with the same relative form at
 * `:242`), and the project-scope one is beside the workspace's own `skills/`
 * (`src/commands/doctor-skill-workshop-relocation.ts:63`).
 *
 * **Why not import them.** This build already has a source that owns `~/.agents` —
 * the `agents` source, whose `SOURCE_ROOTS` entry is `.agents` and whose label says
 * `~/.agents (shared agent home)`. Importing the same tree a second time as
 * OpenClaw's would write **two copies of every file in it**, and the second copy
 * would be attributed to `openclaw` in the report while the identical bytes were
 * already written by `agents`. That is the bug `kimi-read.ts:84-94` hit and fixed
 * with its `KIMI_SHARED_TREE` constant, and this is the same tree.
 *
 * So the skills come from `<configDir>/skills` and `<configDir>/plugin-skills` —
 * the two roots OpenClaw *manages* (`resolveConfigDir`, `infra/config-dir.ts:7-20`)
 * — and the shared ones are named here. Naming them rather than staying silent is
 * the point: a user who expected a skill to arrive would otherwise have no way to
 * tell "OpenClaw does not have that skill" from "it is in the shared tree and one
 * other source already copied it".
 */
function planOpenClawSharedTree(raw: RawOpenClaw, items: MigrationItem[]): void {
	items.push({
		source: SOURCE,
		from: `~/.agents/skills + ${tildePath(raw.home, raw.workspaceDir ?? "")}/.agents/skills`,
		to: "—",
		action: "skip",
		detail:
			'the **shared** skill tree, not read. OpenClaw does load it — `join(getHomeDir(), ".agents", "skills")` at ' +
			"`src/agents/sessions/package-manager.ts:873`, and the project-scope twin beside the workspace's own `skills/` at " +
			"`src/commands/doctor-skill-workshop-relocation.ts:63` — but this build has a source that owns it outright (`~/.agents (shared agent home)`), " +
			"so importing it here as well would write two copies of every file in it and attribute the second to OpenClaw. Anything in there arrives with that source, once",
		containsSecret: false,
	});
}

/**
 * `hooks.presets` and the agent-team role presets — **named, not merged with
 * anything.**
 *
 * Both are real and both are easy to mistake for a settings value:
 *
 *   - `hooks.presets` is a list of named hook bundles the product composes
 *     (`src/hooks/gmail-ops.ts:197`, `mergeHookPresets(baseConfig.hooks?.presets,
 *     "gmail")`). It is **not** a hook entry: `normalizeClaudeHooks` takes an event
 *     name as a key and would read `presets` as an event called "presets" and drop
 *     it. The hooks themselves are composed by the product, so the honest report is
 *     the preset's name.
 *   - The agent-team presets are `{schemaVersion: 1, coordinator, specialists[]}`
 *     documents (`src/agents/agent-roles.ts:30-32`) whose roles are drawn from
 *     `["coordinator", "researcher", "writer", "reviewer"]` (`:9`). **They are not
 *     `tools.profile` and not `agents.defaults.permissionMode`**, and merging them
 *     into either would be inventing a mapping the product does not make.
 *
 * Named rather than imported because none of the three has an equivalent here.
 */
function planOpenClawPresets(raw: RawOpenClaw, items: MigrationItem[]): void {
	const hooks = raw.settings?.hooks;
	if (!isRecord(hooks)) return;
	const presets = hooks.presets;
	const names = Array.isArray(presets) ? presets.filter((entry): entry is string => typeof entry === "string") : [];
	if (names.length === 0) return;
	items.push({
		source: SOURCE,
		from: `${tildePath(raw.home, raw.configPath)} → hooks.presets`,
		to: "—",
		action: "skip",
		detail:
			`left off ${summarizeNames(names)} — OpenClaw composes these named hook bundles itself (\`mergeHookPresets(baseConfig.hooks?.presets, …)\`, ` +
			"src/hooks/gmail-ops.ts:197) rather than storing hook entries under them, so there is nothing here to copy and nothing to merge with `tools.profile`. " +
			"Set the equivalent hooks here by hand if you want them",
		containsSecret: false,
	});

	const agents = raw.settings?.agents;
	if (!isRecord(agents)) return;
	const teams = agents.teams ?? agents.teamPresets;
	const teamNames = isRecord(teams)
		? Object.keys(teams)
		: Array.isArray(teams)
			? teams.filter((e) => typeof e === "string")
			: [];
	if (teamNames.length === 0) return;
	items.push({
		source: SOURCE,
		from: `${tildePath(raw.home, raw.configPath)} → agents.teams`,
		to: "—",
		action: "skip",
		detail:
			`left off ${summarizeNames(teamNames)} — an agent-team preset is a \`{schemaVersion, coordinator, specialists[]}\` document whose roles are drawn from ` +
			"`coordinator | researcher | writer | reviewer` (src/agents/agent-roles.ts:9,30-32). This build has no team-preset concept, and these are **not** a tool " +
			"profile and **not** a permission mode, so nothing was mapped from them",
		containsSecret: false,
	});
}
