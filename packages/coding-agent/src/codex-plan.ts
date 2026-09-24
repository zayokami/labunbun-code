/**
 * Codex's `config.toml` and `rules/` in the target's shape.
 *
 * The rule parser is most of the file, because Codex spells a rule its own way:
 * shell-style `*`/`+`/`-` globs over tool names, with its own escaping, while
 * the target wants an explicit tool list. Turning one into the other is a
 * decision, and decisions belong on the planning side where they can be tested
 * without touching a disk.
 */

import { resolveModel } from "@labunbun/ai";
import { McpServerConfigSchema } from "@labunbun/mcp";
import type { RawCodex } from "./codex-read.ts";
import type { HookEventName } from "./hooks.ts";
import { HOOK_EVENTS } from "./hooks.ts";
import {
	ASSUMED_MAX_OUTPUT_TOKENS,
	isRecord,
	mergeProviderSpecs,
	placeholderNote,
	reportUnhandledKeys,
	summarizeNames,
} from "./migrate-core.ts";
import type { AddPermissionRules, ClaimScalar, MigrationItem } from "./migrate-types.ts";
import { looksLikeSecretName, resolveModelReference } from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";

/** A `name(args)` call in a `.rules` file, with its arguments as text. */
interface RuleCall {
	name: string;
	args: Record<string, string | string[]>;
}

/** Index just past the string literal starting at `start`, or past the end. */
function skipString(text: string, start: number): number {
	const quote = text[start];
	let index = start + 1;
	while (index < text.length) {
		if (text[index] === "\\") index += 2;
		else if (text[index] === quote) return index + 1;
		else index += 1;
	}
	return text.length;
}

/** Index of the `)` matching the `(` at `open`, or -1 when the call is unterminated. */
function matchParen(text: string, open: number): number {
	let depth = 0;
	let index = open;
	while (index < text.length) {
		const char = text[index];
		if (char === "#") {
			const lineEnd = text.indexOf("\n", index);
			index = lineEnd === -1 ? text.length : lineEnd + 1;
			continue;
		}
		if (char === '"' || char === "'") {
			index = skipString(text, index);
			continue;
		}
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
		index += 1;
	}
	return -1;
}

function unquote(literal: string): string {
	return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** `key = value` pairs inside a call body; values stay strings or string lists. */
function parseRuleArgs(body: string): Record<string, string | string[]> {
	const args: Record<string, string | string[]> = {};
	const pair = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\[[\s\S]*?\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
	for (const match of body.matchAll(pair)) {
		const value = match[2];
		args[match[1]] = value.startsWith("[")
			? [...value.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)].map((item) => unquote(item[0]))
			: unquote(value);
	}
	return args;
}

/**
 * The `name(...)` calls in a `.rules` file, in order.
 *
 * A `.rules` file is Starlark, and this is not a Starlark interpreter: it finds
 * calls, steps over string literals (so a `)` inside a pattern does not end the
 * call early) and comments, and reads `key = value` pairs. Whatever it cannot
 * follow is counted rather than guessed at, and the count reaches the report.
 */
function ruleCalls(content: string): { calls: RuleCall[]; unparsed: number } {
	const calls: RuleCall[] = [];
	let unparsed = 0;
	let index = 0;
	while (index < content.length) {
		const char = content[index];
		if (char === "#") {
			const lineEnd = content.indexOf("\n", index);
			index = lineEnd === -1 ? content.length : lineEnd + 1;
			continue;
		}
		if (char === '"' || char === "'") {
			index = skipString(content, index);
			continue;
		}
		if (!/[A-Za-z_]/.test(char)) {
			index += 1;
			continue;
		}
		const start = index;
		while (index < content.length && /[A-Za-z0-9_]/.test(content[index])) index += 1;
		const name = content.slice(start, index);
		while (index < content.length && /\s/.test(content[index])) index += 1;
		if (content[index] !== "(") continue;
		const end = matchParen(content, index);
		if (end === -1) {
			unparsed += 1;
			break;
		}
		calls.push({ name, args: parseRuleArgs(content.slice(index + 1, end)) });
		index = end + 1;
	}
	return { calls, unparsed };
}

/**
 * `prefix_rule` pattern → a `Bash(...)` rule for this build.
 *
 * Codex matches the pattern against the parsed argv, token by token; this build
 * matches a rule against the command line as text, so the tokens are joined and a
 * trailing `*` lets the arguments match. A token holding a character that means
 * something else here (`*`, `?`, parentheses) is refused rather than translated:
 * widening a permission rule is not something an importer should do quietly.
 */
function codexPatternToSpecifier(tokens: string[]): { specifier: string } | { reason: string } {
	if (tokens.length === 0) return { reason: "its pattern is empty" };
	for (const token of tokens) {
		if (/[*?()[\]]/.test(token)) {
			// Quoted back truncated: a pattern is whatever the user typed there, and
			// the report ends up in a transcript, so only its head travels.
			const shown = token.length > 80 ? `${token.slice(0, 80)}…` : token;
			return { reason: `its pattern token "${shown}" means something else in this build's rule syntax` };
		}
	}
	// The `*` is glued to the last token so the command matches with and without
	// arguments, the way a prefix match does.
	return { specifier: `Bash(${tokens.join(" ")}*)` };
}

/**
 * Carry `prefix_rule` decisions over as permission rules.
 *
 * The source's allow means "run it without a prompt inside a sandbox that still
 * confines it"; an allow rule here is the whole gate, which is why the report
 * says so on every rule it adds. Rules are added, never replaced — the target's
 * own rules and the other source's rules have to survive the import.
 */
export function planCodexRules(
	raw: RawCodex,
	at: (name: string) => string,
	items: MigrationItem[],
	addPermissionRules: AddPermissionRules,
): void {
	for (const file of raw.execpolicy) {
		const { calls, unparsed } = ruleCalls(file.content);
		const from = at(`rules/${file.name}`);
		const allow: string[] = [];
		const deny: string[] = [];
		const skipped: string[] = [];
		for (const call of calls) {
			if (call.name !== "prefix_rule") {
				skipped.push(`a ${call.name} rule — this build only has command rules`);
				continue;
			}
			const pattern = call.args.pattern;
			const tokens = Array.isArray(pattern) ? pattern : typeof pattern === "string" ? [pattern] : undefined;
			if (tokens === undefined) {
				skipped.push("a prefix_rule with no readable pattern");
				continue;
			}
			const translated = codexPatternToSpecifier(tokens);
			if ("reason" in translated) {
				skipped.push(`a prefix_rule — ${translated.reason}`);
				continue;
			}
			const decision = call.args.decision;
			if (decision === "allow") allow.push(translated.specifier);
			else if (decision === "forbidden" || decision === "deny") deny.push(translated.specifier);
			else if (decision === "prompt") {
				skipped.push(`${translated.specifier} — the source prompts before running it, and there is no ask tier here`);
			} else if (decision === undefined) {
				skipped.push(
					`${translated.specifier} — no decision was given, which Codex reads as allow; nothing is allowed implicitly here`,
				);
			} else {
				skipped.push(`${translated.specifier} — unknown decision "${String(decision)}"`);
			}
		}
		if (unparsed > 0) skipped.push(`${unparsed} call(s) the reader could not follow`);

		const caveat =
			"an allowed command runs without a prompt and without Codex's sandbox, and the whole command line is matched, so a chained command that begins the same way matches too";
		if (allow.length > 0) addPermissionRules("codex", "allow", allow, from, caveat);
		if (deny.length > 0) {
			addPermissionRules(
				"codex",
				"deny",
				deny,
				from,
				"a denied command is refused here whether or not another rule allows it",
			);
		}
		if (skipped.length > 0) {
			items.push({
				source: "codex",
				from,
				to: "—",
				action: "skip",
				detail: `${skipped.length} rule(s) not carried: ${summarizeNames(skipped, 3)}`,
				containsSecret: false,
			});
		}
	}
}

export function planCodex(
	raw: RawCodex,
	at: (name: string) => string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	/** The base config, as the report names it: the tree `$CODEX_HOME` decides. */
	const configAt = at("config.toml");
	// Providers. `base_url` maps directly; the wire protocol may not.
	const providers = raw.config.model_providers;
	const openaiCompatible: Array<Record<string, unknown>> = [];
	// `model` and `model_context_window` are top-level keys that describe the one
	// model this machine is set up to run: with both present, the provider entry
	// can carry the model instead of being written model-less and unusable.
	const modelName =
		typeof raw.config.model === "string" && raw.config.model.trim() ? raw.config.model.trim() : undefined;
	const providerName =
		typeof raw.config.model_provider === "string" && raw.config.model_provider.trim()
			? raw.config.model_provider.trim()
			: undefined;
	const modelContextWindow =
		typeof raw.config.model_context_window === "number" && raw.config.model_context_window > 0
			? Math.floor(raw.config.model_context_window)
			: undefined;
	if (typeof providers === "object" && providers !== null && !Array.isArray(providers)) {
		for (const [name, value] of Object.entries(providers as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			const spec = value as Record<string, unknown>;
			const baseUrl = typeof spec.base_url === "string" ? spec.base_url : undefined;
			if (!baseUrl) {
				items.push({
					source: "codex",
					from: `${configAt} → model_providers.${name}`,
					to: "—",
					action: "skip",
					detail: "no base_url to point a provider at",
					containsSecret: false,
				});
				continue;
			}
			// The credential variable is named by the source, not guessed: `env_key`
			// is the only place Codex records which variable holds the key. The
			// synthesized fallback is for entries that expect no key at all.
			const envKey = typeof spec.env_key === "string" && spec.env_key.trim() ? spec.env_key.trim() : undefined;
			const apiKeyEnv = envKey ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
			// `requires_openai_auth` means ChatGPT sign-in rather than a key; telling
			// the user to "set X_API_KEY" for such a provider sends them looking for
			// a credential that the source never used.
			const credentialNote =
				spec.requires_openai_auth === true
					? `the source reached it by signing in to an OpenAI account (requires_openai_auth), which this build ` +
						`cannot do — export ${apiKeyEnv} with an API key to use this endpoint here`
					: `set ${apiKeyEnv} in your environment${envKey ? " (the variable its env_key names)" : ""}`;
			const models: Array<Record<string, unknown>> = [];
			if (name === providerName && modelName && modelContextWindow !== undefined) {
				models.push({
					id: modelName,
					contextWindow: modelContextWindow,
					maxOutputTokens: ASSUMED_MAX_OUTPUT_TOKENS,
				});
			}
			// A provider entry with no models is still worth writing: it records the
			// endpoint and credential variable, and models can be added to it later.
			openaiCompatible.push({ id: name, baseUrl, apiKeyEnv, models });
			const wireApi = typeof spec.wire_api === "string" ? spec.wire_api : undefined;
			if (wireApi && wireApi !== "chat" && wireApi !== "completions") {
				items.push({
					source: "codex",
					from: `${configAt} → model_providers.${name} (wire_api="${wireApi}")`,
					to: `settings.json → providers.openaiCompatible[${name}]`,
					action: "downgrade",
					detail:
						`only the chat-completions and Anthropic messages protocols are supported, so this ` +
						`provider is registered as chat-completions; ${credentialNote}`,
					containsSecret: false,
				});
			} else {
				items.push({
					source: "codex",
					from: `${configAt} → model_providers.${name}`,
					to: `settings.json → providers.openaiCompatible[${name}]`,
					action: "map",
					detail: `base_url carried over; ${credentialNote}`,
					containsSecret: false,
				});
			}
			if (isRecord(spec.http_headers)) {
				items.push({
					source: "codex",
					from: `${configAt} → model_providers.${name}.http_headers`,
					to: "—",
					action: "skip",
					detail:
						"a provider entry here carries an endpoint and a credential variable, not request headers — " +
						"the gateway has to accept what this endpoint sends",
					containsSecret: false,
				});
			}
		}
	}
	mergeProviderSpecs(
		"codex",
		openaiCompatible,
		(id) => `${configAt} → model_providers.${id}`,
		items,
		settingsPatch,
		existing,
		force,
	);

	// model: only meaningful if the registry (built-in or just-added provider)
	// can resolve it. A provider-scoped id needs the provider prefix.
	if (modelName) {
		// Which providers actually made it into the patch — the target may already
		// define one and keep its own definition, in which case the model entry
		// written above is not there either.
		const acceptedProviders = isRecord(settingsPatch.providers) ? settingsPatch.providers.openaiCompatible : undefined;
		const providerAccepted =
			providerName !== undefined &&
			Array.isArray(acceptedProviders) &&
			acceptedProviders.some((entry) => isRecord(entry) && entry.id === providerName);
		if (providerAccepted && modelContextWindow !== undefined && providerName) {
			const reference = `${providerName}/${modelName}`;
			claimScalar(
				"codex",
				"model",
				reference,
				`${configAt} → model ("${modelName}")`,
				`registered under the "${providerName}" provider with the ${modelContextWindow}-token context window the source records — the protocol is spoken as chat-completions`,
			);
		} else {
			const resolved = resolveModelReference(modelName);
			const resolvedProvider = resolved ? resolveModel(resolved)?.provider : undefined;
			// The endpoint is part of what the user configured. When the source said
			// "this model, on that provider", the name must not be quietly re-pointed at
			// a first-party row that happens to share it — the same id on a different
			// host is somebody else's server, and it would bill a different account.
			const scopedElsewhere =
				resolvedProvider !== undefined && providerName !== undefined && resolvedProvider !== providerName;
			if (resolved && !scopedElsewhere) {
				claimScalar("codex", "model", resolved, `${configAt} → model ("${modelName}")`, `resolved to ${resolved}`);
			} else {
				const providerKeptItsOwn =
					providerName !== undefined && modelContextWindow !== undefined
						? `the target already defines a "${providerName}" provider — add "${modelName}" to its models and set model to "${providerName}/${modelName}"`
						: undefined;
				const scopedDetail =
					`the name also exists on the ${resolvedProvider} provider, but the source runs it on ` +
					`"${providerName}" — add it under providers.openaiCompatible[${providerName}].models with its ` +
					`context window, then set model to "${providerName}/${modelName}"`;
				items.push({
					source: "codex",
					from: `${configAt} → model ("${modelName}")`,
					to: "—",
					action: "skip",
					detail:
						providerKeptItsOwn ??
						(scopedElsewhere
							? scopedDetail
							: providerName
								? `not in the registry — add it under providers.openaiCompatible[${providerName}].models, then set model to "${providerName}/${modelName}"`
								: "no model in the registry matches this name — set a model reference manually"),
					containsSecret: false,
				});
			}
		}
	}
	if (raw.config.model_context_window !== undefined && modelContextWindow === undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → model_context_window`,
			to: "—",
			action: "skip",
			detail: "not a positive number of tokens, so no model entry could be built from it",
			containsSecret: false,
		});
	}
	if (raw.config.model_auto_compact_token_limit !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → model_auto_compact_token_limit`,
			to: "—",
			action: "skip",
			detail:
				"no equivalent threshold — compaction starts at the context-window threshold here, and the model's " +
				"context window is what decides it",
			containsSecret: false,
		});
	}
	if (raw.config.disable_response_storage !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → disable_response_storage`,
			to: "—",
			action: "skip",
			detail: "server-side response storage is a request field of that API; nothing here sends it either way",
			containsSecret: false,
		});
	}

	// MCP servers. Codex keeps them in the same TOML file as the model settings,
	// in a shape that maps onto ours except for the two ways it supplies a
	// credential without storing one: `env_vars` names variables to forward from
	// the shell, and `bearer_token_env_var` does the same for a header.
	const servers = raw.config.mcp_servers;
	if (isRecord(servers)) {
		for (const [name, value] of Object.entries(servers)) {
			const label = `${configAt} → mcp_servers.${name}`;
			if (!isRecord(value)) continue;
			if (value.enabled === false) {
				items.push({
					source: "codex",
					from: label,
					to: "—",
					action: "skip",
					detail: "disabled in Codex",
					containsSecret: false,
				});
				continue;
			}
			const normalized = normalizeCodexMcp(value);
			if (normalized === null || !McpServerConfigSchema.safeParse(normalized.config).success) {
				items.push({
					source: "codex",
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
					source: "codex",
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
				Object.keys(isRecord(normalized.config.env) ? normalized.config.env : {}).some((key) =>
					looksLikeSecretName(key),
				);
			mcpServers[name] = normalized.config;
			markMcpSecret(secret);
			const copied = secret ? "copied verbatim, including credential headers" : "copied verbatim";
			items.push({
				source: "codex",
				from: label,
				to: `.mcp.json → mcpServers.${name}`,
				action: normalized.downgrades.length > 0 ? "downgrade" : "map",
				detail: normalized.downgrades.length > 0 ? `${copied} — ${normalized.downgrades.join("; ")}` : copied,
				containsSecret: secret,
			});
		}
	}

	if (raw.config.model_reasoning_effort !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → model_reasoning_effort`,
			to: "—",
			action: "skip",
			detail: "no reasoning-effort setting exists here; thinking level is chosen per request",
			containsSecret: false,
		});
	}
	if (raw.config.projects !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → projects.*.trust_level`,
			to: "—",
			action: "skip",
			detail:
				"directory trust has no equivalent — permission rules are per-tool and MCP servers are approved " +
				"individually per project, so trusting a directory would not translate faithfully",
			containsSecret: false,
		});
	}
	if (raw.config.windows !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → windows.sandbox`,
			to: "—",
			action: "skip",
			detail: "no OS-level sandbox setting; tool access is governed by permission rules",
			containsSecret: false,
		});
	}
	if (raw.config.tui !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → tui`,
			to: "—",
			action: "skip",
			detail: "interface state, not configuration",
			containsSecret: false,
		});
	}
	// ── the posture that decides what may run, and the prose this build has no
	// slot for ──────────────────────────────────────────────────────────────
	// Each of these is one decision in the source and a silent change in what the
	// agent may do here, so each gets a sentence of its own rather than the
	// catch-all line at the end: a user who set `sandbox_mode` is entitled to know
	// which of the two builds is the permissive one.
	if (
		raw.config.approval_policy !== undefined ||
		raw.config.sandbox_mode !== undefined ||
		raw.config.sandbox_workspace_write !== undefined
	) {
		items.push({
			source: "codex",
			from: `${configAt} → approval_policy, sandbox_mode, sandbox_workspace_write`,
			to: "—",
			action: "skip",
			detail:
				"how Codex decides whether a command runs, asks first or is refused, and the sandbox it runs under — " +
				"this build has no OS-level sandbox and no per-command policy: a tool call is allowed or denied by permission " +
				"rules, which decide per tool rather than per command, so the rules here are what decides",
			containsSecret: false,
		});
	}
	if (raw.config.default_permissions !== undefined || raw.config.permissions !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → default_permissions, permissions`,
			to: "—",
			action: "skip",
			detail:
				"named permission profiles — filesystem and network policy, workspace roots, and which profile is applied by " +
				"default — permission rules here are one flat list of allow/deny per tool, with neither profiles nor a " +
				"network policy to put them in",
			containsSecret: false,
		});
	}
	if (
		raw.config.instructions !== undefined ||
		raw.config.developer_instructions !== undefined ||
		raw.config.model_instructions_file !== undefined
	) {
		items.push({
			source: "codex",
			from: `${configAt} → instructions, developer_instructions, model_instructions_file`,
			to: "—",
			action: "skip",
			detail:
				"text Codex puts into the model's system prompt — the system prompt here is not configurable from settings; " +
				"the memory documents and ~/.labunbun/rules/*.md are what reaches the model in your own words",
			containsSecret: false,
		});
	}
	if (raw.config.hooks !== undefined) {
		const hookTable = isRecord(raw.config.hooks) ? raw.config.hooks : undefined;
		const hookEvents = hookTable === undefined ? [] : Object.keys(hookTable).filter((key) => key !== "state");
		const unmatchedEvents = hookEvents.filter((event) => !HOOK_EVENTS.includes(event as HookEventName));
		items.push({
			source: "codex",
			from: `${configAt} → hooks`,
			to: "—",
			action: "skip",
			detail:
				hookTable === undefined
					? "not a table, so Codex reads no hooks here and neither does this importer"
					: `${hookEvents.length} hook event(s) declared in this file` +
						(unmatchedEvents.length > 0 ? `, and ${summarizeNames(unmatchedEvents)} of them have no event here` : "") +
						" — hooks here are command hooks written by hand in settings.json → hooks, and these handlers were not " +
						"translated; a timeout on one of them is seconds there against milliseconds here",
			containsSecret: false,
		});
	}
	if (raw.config.skills !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → skills`,
			to: "—",
			action: "skip",
			detail:
				"the skill entries and the catalog around them — an entry can switch one skill off with enabled = false, and " +
				"that switch is not applied here, so a skill turned off in Codex arrives as one this build loads; the catalog " +
				"settings beside them (bundled skills, the instructions block, its token budget) have no counterpart here, " +
				"where every skill under ~/.labunbun/skills is offered",
			containsSecret: false,
		});
	}
	if (raw.config.memories !== undefined) {
		items.push({
			source: "codex",
			from: `${configAt} → memories`,
			to: "—",
			action: "skip",
			detail:
				"Codex's own memory pipeline — which memory version it runs, how far back it reads threads and which model " +
				"summarises them; nothing here generates memories in the background, memory being the documents it reads " +
				"plus rules",
			containsSecret: false,
		});
	}
	if (raw.config.profile !== undefined) {
		items.push({
			source: "codex",
			from:
				typeof raw.config.profile === "string"
					? `${configAt} → profile ("${raw.config.profile.trim()}")`
					: `${configAt} → profile`,
			to: "—",
			action: "skip",
			detail:
				"a key Codex itself now rejects: a config that sets it does not load, its error pointing at --profile <name> " +
				"with <name>.config.toml instead — so this file was never in force there, and the overlay it names is not " +
				"what the source was running",
			containsSecret: false,
		});
	}
	if (raw.profileArchives.length > 0) {
		items.push({
			source: "codex",
			from: at("*.config.toml"),
			to: "—",
			action: "skip",
			detail:
				`${raw.profileArchives.length} profile file(s) (${summarizeNames(raw.profileArchives)}): each is a whole ` +
				"config.toml layered over the base file when Codex is started with --profile <name>, and only in those " +
				"sessions — this import reads the base file, so a key that lives only in one of these is not among the " +
				"settings written here",
			containsSecret: false,
		});
	}
	for (const [key, reason] of UNMIGRATED_CODEX_KEYS) {
		if (raw.config[key] === undefined) continue;
		items.push({
			source: "codex",
			from: `${configAt} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	// Whatever is left, by name. Codex's config grows a key at a time and this
	// importer knows a fixed set of them; the rest are the user's own settings,
	// and a report that simply omits them reads as if they had never been set.
	reportUnhandledKeys("codex", raw.config, CODEX_CONFIG_HANDLED, configAt, items);
	if (raw.hooksPresent) {
		items.push({
			source: "codex",
			from: at("hooks.json"),
			to: "—",
			action: "skip",
			detail:
				"event handlers in a shape this build does not read — hooks here are command hooks in " +
				"settings.json → hooks, written by hand rather than translated",
			containsSecret: false,
		});
	}
	if (raw.agentTomlCount > 0) {
		items.push({
			source: "codex",
			from: at("agents/*.toml"),
			to: "—",
			action: "skip",
			detail: `${raw.agentTomlCount} agent definition(s) in Codex's TOML shape; agents here are markdown files with frontmatter`,
			containsSecret: false,
		});
	}
}

/**
 * Codex configuration this importer reports but does not carry.
 *
 * Each names something a user could have set and then gone looking for after the
 * migration. `[projects]`, `[windows]` and `[tui]` are reported by their own code
 * above because their wording is pinned by tests; these are the rest.
 */
const UNMIGRATED_CODEX_KEYS: Array<[key: string, reason: string]> = [
	[
		"notify",
		"an external program Codex runs on events; the equivalent here is a command hook " +
			"(settings.json → hooks), which is not derived from this argv",
	],
	["history", "Codex's own transcript-persistence settings; prompt history here is one file with its own limit"],
	[
		"shell_environment_policy",
		"controls what Codex's child processes inherit; settings env injects variables into this process " +
			"instead, which is a different thing",
	],
	["profiles", "named overlays selected with --profile; there is no profile switch here"],
	["features", "feature flags for Codex's own runtime"],
	["agents", "per-agent overrides for Codex's built-in agents"],
	["oss_provider", "which provider Codex's local OSS model would use"],
];

/**
 * Keys of `config.toml` that are either imported above or named by a line of
 * their own — the ones a report about this file may pass over in silence.
 *
 * Everything else reaches the report through {@link reportUnhandledKeys}. Codex
 * reads around sixty top-level keys, and the half of them this importer knows
 * nothing about (`web_search`, `tools`, `features`, `otel`, `apps`, the realtime
 * block) are exactly the ones a user is most likely to have set by hand.
 */
const CODEX_CONFIG_HANDLED = new Set<string>([
	"model",
	"model_provider",
	"model_providers",
	"model_context_window",
	"model_auto_compact_token_limit",
	"disable_response_storage",
	"mcp_servers",
	"model_reasoning_effort",
	"projects",
	"windows",
	"tui",
	"approval_policy",
	"sandbox_mode",
	"sandbox_workspace_write",
	"default_permissions",
	"permissions",
	"instructions",
	"developer_instructions",
	"model_instructions_file",
	"profile",
	"hooks",
	"skills",
	"memories",
	...UNMIGRATED_CODEX_KEYS.map(([key]) => key),
]);

function normalizeCodexMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const url = typeof entry.url === "string" ? entry.url : undefined;
	if (url) {
		const out: Record<string, unknown> = { type: "http", url };
		if (isRecord(entry.http_headers)) out.headers = entry.http_headers;
		if (typeof entry.bearer_token_env_var === "string") {
			downgrades.push(`its Authorization header came from $${entry.bearer_token_env_var}, which is not expanded here`);
		}
		if (isRecord(entry.env_http_headers)) {
			const names = Object.values(entry.env_http_headers).filter((value) => typeof value === "string");
			if (names.length > 0) {
				downgrades.push(
					`header values came from ${names.map((name) => `$${name}`).join(", ")}, which are not expanded here`,
				);
			}
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	const command = entry.command;
	if (typeof command === "string" && command) {
		const out: Record<string, unknown> = {
			type: "stdio",
			command,
			args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [],
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		const forwarded = Array.isArray(entry.env_vars)
			? entry.env_vars.filter((name): name is string => typeof name === "string")
			: [];
		if (forwarded.length > 0) {
			downgrades.push(
				`it expected ${summarizeNames(forwarded.map((name) => `$${name}`))} forwarded from your shell environment — ` +
					"set them under env here if it needs them",
			);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	return null;
}
