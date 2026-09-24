/**
 * What ZCode's configuration becomes in the target: models, MCP servers, the
 * allow list, skills, agents and instructions.
 *
 * A pure function of `RawZcode` — it reads nothing and writes nothing, so every
 * decision in it is testable without a home directory.
 */

import { McpServerConfigSchema } from "@labunbun/mcp";
import { ASSUMED_MAX_OUTPUT_TOKENS, isRecord, mergeProviderSpecs, summarizeNames } from "./migrate-core.ts";
import type { ClaimEnv, MigrationItem } from "./migrate-types.ts";
import { looksLikeSecretName, resolveModelReference } from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";
import { OpenAICompatibleProviderSchema, SettingsSchema } from "./settings.ts";
import type { RawZcode } from "./zcode-read.ts";

/**
 * Model entries for `providers.openaiCompatible`, from ZCode's
 * `models.<name>.limit.context`. ZCode does not record an output limit, so one
 * is assumed rather than omitted — the schema requires it, and a value the user
 * can see beats a provider entry that fails to load.
 */
function zcodeModelEntries(models: unknown): Array<Record<string, unknown>> {
	if (!isRecord(models)) return [];
	const out: Array<Record<string, unknown>> = [];
	for (const [id, spec] of Object.entries(models)) {
		const limit = isRecord(spec) ? spec.limit : undefined;
		const context = isRecord(limit) && typeof limit.context === "number" ? limit.context : undefined;
		out.push({
			id,
			contextWindow: context && context > 0 ? Math.floor(context) : 128_000,
			maxOutputTokens: ASSUMED_MAX_OUTPUT_TOKENS,
		});
	}
	return out;
}

/**
 * ZCode (Z.ai) stores its configuration in two JSON files and its session
 * database in sqlite; `raw.settings` carries the database's `local_setting`
 * rows, read during the I/O pass.
 *
 * Credentials move across as-is, into the variables labunbun's Anthropic
 * provider already reads. They are never named in the report: `claimEnv` marks
 * the write as secret-bearing and the closing notice lists the file, not the
 * value.
 */
export function planZcode(
	raw: RawZcode,
	items: MigrationItem[],
	claimEnv: ClaimEnv,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	// Providers. ZCode's built-in catalogue lists six; only the enabled ones say
	// anything about how this machine is actually configured.
	const disabled: string[] = [];
	const modelNames: string[] = [];
	const openaiCompatible: Array<Record<string, unknown>> = [];
	if (isRecord(raw.config.provider)) {
		for (const [id, value] of Object.entries(raw.config.provider)) {
			if (!isRecord(value)) continue;
			const label = `~/.zcode/v2/config.json → provider.${id}`;
			if (value.enabled !== true) {
				disabled.push(id);
				continue;
			}
			// A name this build can already resolve needs no report — the point of
			// the list below is the models that would silently not work.
			if (isRecord(value.models)) {
				modelNames.push(...Object.keys(value.models).filter((name) => !resolveModelReference(name)));
			}
			const options = isRecord(value.options) ? value.options : {};
			const kind = typeof value.kind === "string" ? value.kind : "";
			const baseUrl = typeof options.baseURL === "string" ? options.baseURL.trim() : "";
			const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
			if (kind === "anthropic") {
				if (baseUrl) claimEnv("zcode", "ANTHROPIC_BASE_URL", baseUrl, `${label}.options.baseURL`);
				if (apiKey) {
					// The same variable labunbun's Anthropic provider falls back to, so
					// an imported provider works without the user copying anything by hand.
					claimEnv("zcode", "ANTHROPIC_AUTH_TOKEN", apiKey, `${label}.options.apiKey`);
				} else {
					items.push({
						source: "zcode",
						from: `${label}.options.apiKey`,
						to: "—",
						action: "skip",
						detail:
							"no key stored in this file — ZCode keeps credentials in its own store, which the importer " +
							"does not read; set ANTHROPIC_AUTH_TOKEN yourself to use this provider",
						containsSecret: false,
					});
				}
				continue;
			}
			// A non-Anthropic protocol is registered as a chat-completions provider.
			// The id is prefixed because model references resolve first-match, so a
			// bare id colliding with a built-in would silently resolve elsewhere.
			const providerId = `zcode-${id}`;
			if (!baseUrl) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "no baseURL to point a provider at",
					containsSecret: false,
				});
				continue;
			}
			const apiKeyEnv = `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
			const spec = { id: providerId, baseUrl, apiKeyEnv, models: zcodeModelEntries(value.models) };
			if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "baseURL is not a usable URL for a provider entry",
					containsSecret: false,
				});
				continue;
			}
			openaiCompatible.push(spec);
			items.push({
				source: "zcode",
				from: `${label} (kind="${kind}")`,
				to: `settings.json → providers.openaiCompatible[${providerId}]`,
				action: "downgrade",
				detail:
					"only the chat-completions and Anthropic messages protocols are supported here, and ZCode " +
					`records no output limit, so models carry maxOutputTokens=${ASSUMED_MAX_OUTPUT_TOKENS}; set ` +
					`${apiKeyEnv} in your environment`,
				containsSecret: false,
			});
			if (apiKey) claimEnv("zcode", apiKeyEnv, apiKey, `${label}.options.apiKey`);
		}
	}
	if (disabled.length > 0) {
		items.push({
			source: "zcode",
			from: `~/.zcode/v2/config.json → provider.{${disabled.join(", ")}}`,
			to: "—",
			action: "skip",
			detail: "disabled in ZCode — enable the provider there first if you want it here",
			containsSecret: false,
		});
	}
	if (modelNames.length > 0) {
		items.push({
			source: "zcode",
			from: "~/.zcode/v2/config.json → provider.*.models",
			to: "—",
			action: "skip",
			detail:
				`not in this build's model registry (${summarizeNames(modelNames)}) — register a matching ` +
				'providers.openaiCompatible[].models entry, then reference it as "<provider>/<model>"',
			containsSecret: false,
		});
	}
	mergeProviderSpecs(
		"zcode",
		openaiCompatible,
		(id) => `~/.zcode/v2/config.json → provider.${id.replace(/^zcode-/, "")}`,
		items,
		settingsPatch,
		existing,
		force,
	);

	// MCP servers live in the CLI-side config, in a shape that is close to ours
	// but not identical: `http_headers` has to become `headers`, and a stdio
	// server's argv arrives joined in `command`.
	const servers = isRecord(raw.cliConfig.mcp) ? raw.cliConfig.mcp.servers : undefined;
	if (isRecord(servers)) {
		for (const [name, value] of Object.entries(servers)) {
			const label = `~/.zcode/cli/config.json → mcp.servers.${name}`;
			if (!isRecord(value)) continue;
			if (value.enabled === false || value.enable === false) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "disabled in ZCode",
					containsSecret: false,
				});
				continue;
			}
			const normalized = normalizeZcodeMcp(value);
			if (normalized === null || !McpServerConfigSchema.safeParse(normalized.config).success) {
				items.push({
					source: "zcode",
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
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "target already defines a server with this name — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			const record = normalized.config;
			const secret =
				Object.keys(isRecord(record.headers) ? record.headers : {}).length > 0 ||
				Object.keys(isRecord(record.env) ? record.env : {}).some((key) => looksLikeSecretName(key));
			mcpServers[name] = normalized.config;
			markMcpSecret(secret);
			items.push({
				source: "zcode",
				from: label,
				to: `.mcp.json → mcpServers.${name}`,
				action: "map",
				detail: secret
					? normalized.renamed
						? "copied verbatim, including credential headers (http_headers renamed to headers)"
						: "copied verbatim, including credential headers"
					: normalized.renamed
						? "copied verbatim (http_headers renamed to headers)"
						: "copied verbatim",
				containsSecret: secret,
			});
		}
	}

	// local_setting rows. Permission entries are recorded per project in ZCode,
	// and a repo-controlled permission decision may not widen what the agent is
	// allowed to do — the same boundary `PROJECT_TIER_KEY_POLICY` draws for
	// project-scope settings files.
	for (const row of raw.settings) {
		const label = `~/.zcode/cli/db/db.sqlite → ${row.namespace}/${row.key} (${row.scope})`;
		if (row.namespace === "model" && row.key === "reasoningLevel") {
			items.push({
				source: "zcode",
				from: label,
				to: "—",
				action: "skip",
				detail: "no reasoning-effort setting exists here; thinking level is chosen per request",
				containsSecret: false,
			});
			continue;
		}
		if (row.namespace !== "permission") continue;
		if (row.scope !== "user") {
			items.push({
				source: "zcode",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"recorded per project rather than for you as a user, and a decision that travels with a " +
					"repository may not widen permissions — set it here with /permissions instead",
				containsSecret: false,
			});
			continue;
		}
		if (row.key === "mode") {
			const mode = isRecord(row.value) && typeof row.value.mode === "string" ? row.value.mode : "";
			items.push({
				source: "zcode",
				from: label,
				to: "—",
				action: "skip",
				detail: mode
					? `"${mode}" is ZCode's own mode vocabulary and has no faithful equivalent here — pick one with /permissions`
					: "unrecognised mode value — pick a permission mode with /permissions",
				containsSecret: false,
			});
			continue;
		}
		if (row.key === "ruleset") {
			const rules = zcodeAllowRules(row.value);
			if (rules.length === 0) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "no allow rules recorded",
					containsSecret: false,
				});
				continue;
			}
			const current = existing.permissions?.allow;
			if (current !== undefined && current.length > 0 && !force) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "target already defines permissions.allow — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			const probe = SettingsSchema.safeParse({ permissions: { allow: rules } });
			if (!probe.success) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: "rule list not accepted by the settings schema",
					containsSecret: false,
				});
				continue;
			}
			settingsPatch.permissions = { allow: rules };
			items.push({
				source: "zcode",
				from: label,
				to: "settings.json → permissions.allow",
				action: "downgrade",
				detail: `${rules.length} allow rule(s) rewritten from ZCode's {toolName, ruleContent} form — review them with /permissions`,
				containsSecret: false,
			});
		}
	}

	if (raw.pluginCount > 0) {
		items.push({
			source: "zcode",
			from: "~/.zcode/cli/plugins/cache",
			to: "—",
			action: "skip",
			detail: `${raw.pluginCount} installed plugin(s) — third-party code rather than your own configuration`,
			containsSecret: false,
		});
	}
	if (raw.rolloutCount > 0) {
		items.push({
			source: "zcode",
			from: "~/.zcode/cli/rollout/*.jsonl",
			to: "—",
			action: "skip",
			detail: `${raw.rolloutCount} raw model I/O log(s), which embed live request Authorization headers — never opened`,
			containsSecret: false,
		});
	}
}

/**
 * Rewrite a ZCode MCP entry into labunbun's config shape.
 *
 * `http_headers` is the one field that must be renamed — leaving it would make
 * the server definition fail the schema, and a server that silently loses its
 * credential headers fails at connect time with an auth error instead of
 * saying what changed.
 */
function normalizeZcodeMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; renamed: boolean } | null {
	const headers = isRecord(entry.http_headers) ? entry.http_headers : undefined;
	const url = typeof entry.url === "string" ? entry.url : undefined;
	if (url) {
		const out: Record<string, unknown> = { type: "http", url };
		const merged = headers ?? (isRecord(entry.headers) ? entry.headers : undefined);
		if (merged) out.headers = merged;
		return { config: out, renamed: headers !== undefined && entry.headers === undefined };
	}
	const command = entry.command;
	if (typeof command === "string" && command) {
		const out: Record<string, unknown> = {
			type: "stdio",
			command,
			args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [],
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		return { config: out, renamed: false };
	}
	if (Array.isArray(command) && typeof command[0] === "string") {
		const out: Record<string, unknown> = {
			type: "stdio",
			command: command[0],
			args: command.slice(1).filter((a): a is string => typeof a === "string"),
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		return { config: out, renamed: false };
	}
	return null;
}

/** ZCode's `{version, allow: [{toolName, ruleContent}]}` → this build's rule strings. */
function zcodeAllowRules(value: unknown): string[] {
	if (!isRecord(value) || !Array.isArray(value.allow)) return [];
	const rules: string[] = [];
	for (const entry of value.allow) {
		if (typeof entry === "string") {
			rules.push(entry);
			continue;
		}
		if (!isRecord(entry)) continue;
		const tool = typeof entry.toolName === "string" ? entry.toolName.trim() : "";
		if (!tool) continue;
		const content = typeof entry.ruleContent === "string" ? entry.ruleContent.trim() : "";
		rules.push(content ? `${tool}(${content})` : tool);
	}
	return rules;
}
