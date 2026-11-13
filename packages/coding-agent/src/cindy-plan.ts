// Cindy's configuration in the target's shape: remote MCP servers, custom model
// providers, and everything this importer found and will not carry.
// Long-form design notes: docs/dev/migration-sources.md

import { join } from "node:path";
import type { CustomProviderApiId } from "@labunbun/ai";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { cindyThemeDirs } from "./cindy-home.ts";
import type { CindyProvider, CindyProviderRuntime, RawCindy } from "./cindy-read.ts";
import {
	ASSUMED_MAX_OUTPUT_TOKENS,
	mergeProviderSpecs,
	summarizeNames,
	tildePath,
	urlCredentialProblem,
} from "./migrate-core.ts";
import type { MigrationItem, MigrationSourceId } from "./migrate-types.ts";
import { OpenAICompatibleProviderSchema, type RawSettingsInput } from "./settings.ts";

const SOURCE: MigrationSourceId = "cindy";

/** How every origin line names the database: its path is one file behind many rows, and the row key follows it. */
const CINDY_DB_LABEL = "Cindy database";

// Long-form design notes: docs/dev/migration-sources.md
/**
 * The window assumed for a model Cindy's row does not size. Cindy fills a
 * conservative default in its own catalog when a user types a model id without
 * metadata (`buildUserProvider`), and the persisted row carries only what the
 * user entered, so a migration sees the same gap and has to choose a number.
 * 200K is the value Cindy itself uses for that fallback.
 */
export const CINDY_ASSUMED_CONTEXT_WINDOW = 200_000;

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Cindy's four wire protocols mapped to this build's three.
 *
 * `google-generative-ai` has no entry: this build's provider entries speak one
 * of the three OpenAI/Anthropic wires, and a Gemini endpoint is not one of them.
 */
export const CINDY_WIRE_TO_API: Readonly<Record<string, CustomProviderApiId | undefined>> = {
	"openai-chat": "openai-completions",
	"openai-responses": "openai-responses",
	"anthropic-messages": "anthropic-messages",
	"google-generative-ai": undefined,
};

// Long-form design notes: docs/dev/migration-sources.md
/**
 * What a runtime speaks when its row names no protocol.
 *
 * Cindy derives the wire from the harness: Claude Code talks Anthropic messages
 * and Codex talks OpenAI Responses. `pi` is a harness that can drive either,
 * and a row without an explicit protocol does not say which — guessing there
 * would produce a provider that fails at the first request.
 */
const CINDY_AGENT_DEFAULT_API: Readonly<Record<string, CustomProviderApiId | undefined>> = {
	"claude-code": "anthropic-messages",
	codex: "openai-responses",
	pi: undefined,
};

/** The API id a runtime speaks, or `undefined` when this build cannot carry it. */
export function cindyRuntimeApi(runtime: CindyProviderRuntime): CustomProviderApiId | undefined {
	if (runtime.wireProtocol !== null) return CINDY_WIRE_TO_API[runtime.wireProtocol];
	return CINDY_AGENT_DEFAULT_API[runtime.agent];
}

/** Whether a runtime was configured with an explicit protocol rather than inferred by its harness. */
function cindyRuntimeExplicit(runtime: CindyProviderRuntime): boolean {
	return runtime.wireProtocol !== null;
}

/** The environment variable name a provider's key would be read from. */
function cindyApiKeyEnv(id: string): string {
	return `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** The runtime whose endpoint this importer carries, or `null`. Explicit protocols win, then harness order. */
function cindyChosenRuntime(provider: CindyProvider): CindyProviderRuntime | null {
	const order = ["claude-code", "codex", "pi"];
	const candidates = provider.runtimes
		.filter((runtime) => cindyRuntimeApi(runtime) !== undefined)
		.sort((a, b) => {
			if (cindyRuntimeExplicit(a) !== cindyRuntimeExplicit(b)) return cindyRuntimeExplicit(a) ? -1 : 1;
			return order.indexOf(a.agent) - order.indexOf(b.agent);
		});
	return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** One remote server, written only when nothing it carries is a credential this build cannot store. */
function planCindyMcpServer(
	server: RawCindy["mcpServers"][number],
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const label = `${CINDY_DB_LABEL} → custom_mcp_servers.${server.id || server.name}`;
	const name = server.id.trim() !== "" ? server.id : server.name.trim();
	if (name === "") {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail: "the row names neither an id nor a display name, so there is no key to write it under",
			containsSecret: false,
		});
		return;
	}
	if (server.transport !== "http") {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail:
				server.transport === "sse"
					? "Cindy records this server as the legacy SSE transport, and this build's remote MCP entries support streamable HTTP only. " +
						"Importing it as HTTP would be a different endpoint contract, so nothing was written; add it again here if the server also serves HTTP"
					: `transport "${server.transport || "(empty)"}" is neither http nor sse, so this importer has no shape for it`,
			containsSecret: false,
		});
		return;
	}
	if (server.url.trim() === "") {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail: "the row records no URL, so there is no endpoint to connect to",
			containsSecret: false,
		});
		return;
	}
	// `url` is the one credential channel a name-based scan cannot reach: a token
	// can sit in its userinfo or a query parameter, and the same address with the
	// credential stripped is a different address. Nothing is written.
	const problem = urlCredentialProblem(server.url);
	if (problem !== null) {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail:
				`left off, because its url ${problem} — unlike a header there is no way to drop the credential and keep the address, ` +
				"so nothing was written; add the server again here with the credential in your environment instead",
			containsSecret: true,
		});
		return;
	}
	if (name in existingMcpServers && !force) {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail: "target already defines a server with this name — kept (use --force to overwrite)",
			containsSecret: false,
		});
		return;
	}

	const headers = server.headers;
	const config: Record<string, unknown> = { type: "http", url: server.url };
	if (headers !== null && Object.keys(headers).length > 0) config.headers = headers;
	if (!McpServerConfigSchema.safeParse(config).success) {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail: "the imported endpoint does not match this build's http server shape, so nothing was written",
			containsSecret: false,
		});
		return;
	}
	const secret = headers !== null && Object.keys(headers).length > 0;
	const dropped = server.headersEncrypted
		? "Cindy encrypts the headers column with the OS keyring (`safe-storage:v1:`) and the value cannot be decrypted outside the app, so the headers were not carried — add them again here if the server needs them"
		: server.headersProblem;
	mcpServers[name] = config;
	markMcpSecret(secret);
	items.push({
		source: SOURCE,
		from: label,
		to: `.mcp.json → mcpServers.${name}`,
		action: dropped !== null ? "downgrade" : "map",
		detail:
			dropped !== null
				? `copied without its headers — ${dropped}`
				: secret
					? "copied verbatim, including its request headers"
					: "copied verbatim",
		containsSecret: secret,
	});
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** One provider, folded into an `openaiCompatible` entry when its wire and models can be carried. */
function planCindyProvider(
	provider: CindyProvider,
	items: MigrationItem[],
	additions: Array<Record<string, unknown>>,
): void {
	const label = `${CINDY_DB_LABEL} → custom_providers.${provider.id || provider.name}`;
	if (provider.id.trim() === "") {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail: "the row has no id, so there is no key a provider entry could be written under",
			containsSecret: false,
		});
		return;
	}
	if (provider.oauth) {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail:
				"Cindy signs in to this provider through OAuth and keeps the token in the OS keyring; this build's provider entries " +
				"authenticate with an API-key environment variable, so importing the endpoint alone would produce a provider that cannot " +
				"authenticate. Add it here with an API key if the endpoint offers one",
			containsSecret: true,
		});
		return;
	}
	const runtime = cindyChosenRuntime(provider);
	if (runtime === null) {
		const wires = provider.runtimes
			.map((entry) => entry.wireProtocol ?? `(inferred: ${entry.agent})`)
			.filter((wire, index, all) => all.indexOf(wire) === index);
		const configured =
			provider.runtimes.length === 0
				? "it has no runtime configuration"
				: `its ${summarizeNames(provider.runtimes.map((entry) => entry.agent))} configuration`;
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail:
				`${configured} speaks a wire this build's provider entries cannot carry ` +
				`(${wires.length === 0 ? "no protocol recorded" : summarizeNames(wires)})`,
			containsSecret: false,
		});
		return;
	}
	const api = cindyRuntimeApi(runtime);
	if (api === undefined) {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail: "the chosen runtime's protocol has no counterpart in this build, so nothing was written",
			containsSecret: false,
		});
		return;
	}
	if (runtime.baseUrl.trim() === "") {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail: `the "${runtime.agent}" runtime records no base URL, so there is no endpoint to copy`,
			containsSecret: false,
		});
		return;
	}
	if (runtime.models.length === 0) {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail: `the "${runtime.agent}" runtime lists no models, and a provider entry with an empty model list has nothing to offer`,
			containsSecret: false,
		});
		return;
	}

	const apiKeyEnv = cindyApiKeyEnv(provider.id);
	const models = runtime.models.map((model) => ({
		id: model.id,
		name: model.name.trim() === "" ? undefined : model.name,
		contextWindow: model.contextWindow ?? CINDY_ASSUMED_CONTEXT_WINDOW,
		maxOutputTokens: model.maxOutput ?? ASSUMED_MAX_OUTPUT_TOKENS,
	}));
	const spec = { id: provider.id, baseUrl: runtime.baseUrl, apiKeyEnv, api, models };
	if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
		items.push({
			source: SOURCE,
			from: label,
			to: "—",
			action: "skip",
			detail: "the imported endpoint or model list does not match this build's provider shape, so nothing was written",
			containsSecret: false,
		});
		return;
	}
	additions.push(spec);

	const otherRuntimes = provider.runtimes.filter((entry) => entry !== runtime);
	const notes: string[] = [];
	if (runtime.wireProtocol === null) {
		notes.push(
			`Cindy's "${runtime.agent}" runtime names no protocol, so it was carried as ${api} — the wire that harness implies`,
		);
	}
	if (otherRuntimes.length > 0) {
		notes.push(
			`the target's provider entry has one endpoint, so the ${summarizeNames(otherRuntimes.map((entry) => entry.agent))} ` +
				"runtime configuration was not carried",
		);
	}
	if (runtime.headerNames.length > 0) {
		notes.push(
			`its ${runtime.headerNames.length} configured header(s) are not carried — this build's provider entries have no header field`,
		);
	}
	const missingWindows = runtime.models.some((model) => model.contextWindow === undefined);
	items.push({
		source: SOURCE,
		from: `${label} → runtimes.${runtime.agent}`,
		to: `settings.json → providers.openaiCompatible[${provider.id}]`,
		action: "downgrade",
		detail:
			`endpoint and models copied as ${api}; Cindy keeps the API key in the OS keyring, so set ${apiKeyEnv} in your environment` +
			`${provider.authMethod === "none" ? " (Cindy records no authentication for this provider, so the variable may be left unset)" : ""}` +
			`${missingWindows ? `; models without a recorded window carry ${CINDY_ASSUMED_CONTEXT_WINDOW} context / ${ASSUMED_MAX_OUTPUT_TOKENS} output tokens` : ""}` +
			`${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`,
		containsSecret: false,
	});
}

// ---------------------------------------------------------------------------
// Settings and directories with no destination
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Appearance lives in the renderer, not on disk; themes and skills are named so they do not read as forgotten. */
function planCindyUnportable(raw: RawCindy, home: string, items: MigrationItem[]): void {
	items.push({
		source: SOURCE,
		from: `${CINDY_DB_LABEL} → app preferences`,
		to: "—",
		action: "skip",
		detail:
			"Cindy persists theme, theme family, language, notification and appearance preferences in its renderer's localStorage, " +
			"which is not a file this importer can read outside the app. Nothing was carried; choose a theme here with /theme",
		containsSecret: false,
	});
	if (raw.themeFiles > 0) {
		items.push({
			source: SOURCE,
			from: tildePath(home, cindyThemeDirs(home)[0]),
			to: "—",
			action: "skip",
			detail:
				`${raw.themeFiles} local theme file(s). Cindy themes are Electron CSS token sets and this build's themes are ` +
				"`~/.labunbun/themes/*.json` in a different schema; the colours would have to be translated by hand, so none was copied",
			containsSecret: false,
		});
	}
	items.push({
		source: SOURCE,
		from: tildePath(home, join(home, ".agents", "skills")),
		to: "—",
		action: "skip",
		detail:
			raw.sharedSkillCount > 0
				? `${raw.sharedSkillCount} skill(s) in the shared agent home. Cindy reads the same \`~/.agents/skills\` tree other ` +
					"agents use, so they are not this source's own; select the `agents` source to import them without copying the same " +
					"skills twice"
				: "Cindy's skills are the shared `~/.agents/skills` tree, not a directory of its own, and that tree is empty — there is nothing to import from this source",
		containsSecret: false,
	});
}

/** The reader's own reasons, replayed as report lines. */
function planCindySkipped(raw: RawCindy, items: MigrationItem[]): void {
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

/** Assemble the plan. */
export function planCindy(
	raw: RawCindy,
	home: string,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	force: boolean,
): void {
	for (const server of raw.mcpServers) {
		planCindyMcpServer(server, items, mcpServers, markMcpSecret, existingMcpServers, force);
	}

	const additions: Array<Record<string, unknown>> = [];
	for (const provider of raw.providers) planCindyProvider(provider, items, additions);
	mergeProviderSpecs(
		SOURCE,
		additions,
		(id) => `${CINDY_DB_LABEL} → custom_providers.${id}`,
		items,
		settingsPatch,
		existing,
		force,
	);

	planCindyUnportable(raw, home, items);
	planCindySkipped(raw, items);
}
