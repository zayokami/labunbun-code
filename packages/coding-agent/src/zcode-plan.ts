/**
 * What ZCode's configuration becomes in the target: models, MCP servers, the
 * allow list, skills, agents and instructions.
 *
 * A pure function of `RawZcode` — it reads nothing and writes nothing, so every
 * decision in it is testable without a home directory.
 */

import { join, resolve } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { HooksConfigSchema } from "./hooks.ts";
import {
	ASSUMED_MAX_OUTPUT_TOKENS,
	DEFAULT_HOOK_TIMEOUT_MS,
	isRecord,
	MAX_HOOK_TIMEOUT_MS,
	mergeProviderSpecs,
	normalizeClaudeHooks,
	planAssetTrees,
	planCommands,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
} from "./migrate-core.ts";
import type {
	ClaimEnv,
	ClaimHooks,
	ClaimPermissionList,
	ClaimScalar,
	MigrationItem,
	PlannedWrite,
	RawCommands,
	RawFile,
} from "./migrate-types.ts";
import { looksLikeSecretName, resolveModelReference } from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";
import { OpenAICompatibleProviderSchema } from "./settings.ts";
import { parseFrontmatter } from "./skills.ts";
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
	claimPermissionList: ClaimPermissionList,
	claimScalar: ClaimScalar,
	claimHooks: ClaimHooks,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	// Every label below names the file the reader actually opened. ZCode has two
	// roots and either can be moved by an environment variable, so the familiar
	// `~/.zcode/...` spelling is only right when neither was.
	const v2Config = tildePath(raw.home, join(raw.root, "v2", "config.json"));
	const cliConfigPath = tildePath(raw.home, raw.cliConfigPath);
	const dbPath = tildePath(raw.home, raw.dbPath);

	// Providers. ZCode's built-in catalogue lists six; only the enabled ones say
	// anything about how this machine is actually configured.
	const disabled: string[] = [];
	const modelNames: string[] = [];
	const openaiCompatible: Array<Record<string, unknown>> = [];
	if (isRecord(raw.config.provider)) {
		for (const [id, value] of Object.entries(raw.config.provider)) {
			if (!isRecord(value)) continue;
			const label = `${v2Config} → provider.${id}`;
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
			from: `${v2Config} → provider.{${disabled.join(", ")}}`,
			to: "—",
			action: "skip",
			detail: "disabled in ZCode — enable the provider there first if you want it here",
			containsSecret: false,
		});
	}
	if (modelNames.length > 0) {
		items.push({
			source: "zcode",
			from: `${v2Config} → provider.*.models`,
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
		(id) => `${v2Config} → provider.${id.replace(/^zcode-/, "")}`,
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
			const label = `${cliConfigPath} → mcp.servers.${name}`;
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
			if (!normalized.ok) {
				items.push({
					source: "zcode",
					from: label,
					to: "—",
					action: "skip",
					detail: normalized.reason,
					containsSecret: false,
				});
				continue;
			}
			if (!McpServerConfigSchema.safeParse(normalized.config).success) {
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
				// "copied verbatim" is a claim about the whole record, so anything
				// the source carried and this build cannot is named in the same
				// breath rather than left for the user to find at connect time. The
				// two clauses that already existed keep their exact wording.
				detail:
					`copied verbatim${secret ? ", including credential headers" : ""}` +
					`${normalized.renamed.length > 0 ? ` (${normalized.renamed.join(", ")})` : ""}` +
					`${
						normalized.dropped.length > 0
							? ` — not carried over: ${normalized.dropped.join(", ")} (this build has no field for it)`
							: ""
					}`,
				containsSecret: secret,
			});
		}
	}

	// The config-level permission block. ZCode keeps its defaults here and its
	// per-project overrides in the database above. Three of its five keys are
	// readable here; the two that describe ZCode's own risk classifier are named
	// below, and a key beyond even that is named with them.
	//
	// The mode is a four-way match rather than a guess, taken from the CLI's own
	// `permission/service.ts`: `yolo` returns `allow` before any rule is
	// consulted, `edit` reaches `checkEditMode` (edits go through, the rest
	// asks), and everything that reaches neither falls to `checkBuildMode`,
	// which asks unless a rule already allowed the tool. `auto` is not a fifth
	// mode at all — that same file returns `deny` with
	// `"Auto mode is reserved but not implemented yet"`.
	const configPermission = isRecord(raw.cliConfig.permission) ? raw.cliConfig.permission : undefined;
	if (configPermission) {
		const permissionFrom = `${cliConfigPath} → permission`;
		const mode = typeof configPermission.mode === "string" ? configPermission.mode.trim() : "";
		if (mode) claimZcodeMode(mode, `${permissionFrom}.mode`, claimScalar, items);
		// The two tool lists, which are not symmetrical and the report says so: a
		// name in `disallowedTools` is refused before anything else is consulted,
		// so it is this build's `deny` list and not a lower-priority allow. Both
		// are matched against `context.toolName` in the CLI's own
		// `permission/service.ts` — a set of bare names, with no argument pattern —
		// and a bare tool name is a rule here too ("Bash" means Bash with any
		// arguments), so both carry across as they are, unscored.
		for (const [key, behavior] of [
			["allowedTools", "allow"],
			["disallowedTools", "deny"],
		] as const) {
			const value = configPermission[key];
			if (!Array.isArray(value)) continue;
			const rules = value.filter((rule): rule is string => typeof rule === "string" && rule.trim() !== "");
			if (rules.length === 0) continue;
			claimPermissionList(
				"zcode",
				behavior,
				rules,
				`${permissionFrom}.${key}`,
				`${rules.length} tool name(s) ZCode matched by name, carried over as ${behavior} rules — check them with /permissions, since a name here means the tool with any arguments`,
			);
		}
		for (const [key, reason] of UNMIGRATED_ZCODE_PERMISSION_KEYS) {
			if (configPermission[key] === undefined) continue;
			items.push({
				source: "zcode",
				from: `${permissionFrom}.${key}`,
				to: "—",
				action: "skip",
				detail: reason,
				containsSecret: false,
			});
		}
		const otherPermissionConfigKeys = Object.keys(configPermission).filter(
			(key) => !ZCODE_PERMISSION_CONFIG_HANDLED.has(key),
		);
		if (otherPermissionConfigKeys.length > 0) {
			items.push({
				source: "zcode",
				from: `${permissionFrom}.{${summarizeNames(otherPermissionConfigKeys)}}`,
				to: "—",
				action: "skip",
				detail:
					`${otherPermissionConfigKeys.length} key(s) beyond the five ZCode's own schema declares, left where they ` +
					"are — `permissionSchema` is a plain `z.object`, not a passthrough one, so ZCode itself discards " +
					"anything it does not recognise; whichever wrote this, it was not doing anything in ZCode either",
				containsSecret: false,
			});
		}
	}

	// The theme, which this build has a setting for. ZCode's `ui` block is two
	// keys: the theme carries across because `auto`, `dark` and `light` all mean
	// the same thing in both, and the locale is named rather than dropped —
	// this build has no language setting to put it in.
	const ui = isRecord(raw.cliConfig.ui) ? raw.cliConfig.ui : undefined;
	if (ui) {
		if (typeof ui.theme === "string" && ui.theme.trim() !== "") {
			claimScalar("zcode", "theme", ui.theme.trim(), `${cliConfigPath} → ui.theme`, "ZCode's ui.theme");
		}
		if (ui.locale !== undefined) {
			items.push({
				source: "zcode",
				from: `${cliConfigPath} → ui.locale`,
				to: "—",
				action: "skip",
				detail:
					"the interface language ZCode starts in; this build has no language setting, and it follows the terminal instead",
				containsSecret: false,
			});
		}
		const otherUiKeys = Object.keys(ui).filter((key) => !ZCODE_UI_CONFIG_HANDLED.has(key));
		if (otherUiKeys.length > 0) {
			items.push({
				source: "zcode",
				from: `${cliConfigPath} → ui.{${summarizeNames(otherUiKeys)}}`,
				to: "—",
				action: "skip",
				detail: `${otherUiKeys.length} key(s) beyond the theme and the locale, which ZCode's own two-key schema would strip — named so a hand-written one does not read as a setting that took effect`,
				containsSecret: false,
			});
		}
	}

	// local_setting rows. Permission entries are recorded per project in ZCode,
	// and a repo-controlled permission decision may not widen what the agent is
	// allowed to do — the same boundary `PROJECT_TIER_KEY_POLICY` draws for
	// project-scope settings files.
	//
	// The table is `(scope, scope_id, namespace, key, value)` with free-text
	// namespace and key, so what arrives is not a fixed set: the two branches
	// that used to `continue` past everything they did not recognise are now
	// collected and named, because a setting ZCode stored and this importer
	// dropped without a word is indistinguishable from one that was never set.
	const otherNamespaces = new Set<string>();
	const otherPermissionKeys = new Set<string>();
	for (const row of raw.settings) {
		const label = `${dbPath} → ${row.namespace}/${row.key} (${row.scope})`;
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
		if (row.namespace !== "permission") {
			otherNamespaces.add(`${row.namespace}/${row.key} (${row.scope})`);
			continue;
		}
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
			// The same vocabulary as the config-level mode above, reached through the
			// database this time: ZCode writes it in both places, and a report that
			// translated one and called the other untranslatable would be talking
			// about itself.
			claimZcodeMode(
				isRecord(row.value) && typeof row.value.mode === "string" ? row.value.mode : "",
				label,
				claimScalar,
				items,
			);
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
			// The same accumulator every other source claims through, so ZCode's
			// rules are merged with the other sources' rather than written over
			// them — and the report item is the one the accumulator writes, not a
			// second copy that can disagree with what was actually kept.
			claimPermissionList(
				"zcode",
				"allow",
				rules,
				label,
				`${rules.length} allow rule(s) rewritten from ZCode's {toolName, ruleContent} form — review them with /permissions`,
				"downgrade",
			);
			continue;
		}
		otherPermissionKeys.add(row.key);
	}
	if (otherPermissionKeys.size > 0) {
		items.push({
			source: "zcode",
			from: `${dbPath} → permission/{${summarizeNames([...otherPermissionKeys])}} (user)`,
			to: "—",
			action: "skip",
			detail:
				`${otherPermissionKeys.size} user-scoped permission key(s) this importer has no reading for — ` +
				"ZCode's own permission keys are mode and ruleset, so these are either from a newer version or " +
				"written by something else; set them here with /permissions",
			containsSecret: false,
		});
	}
	if (otherNamespaces.size > 0) {
		items.push({
			source: "zcode",
			from: `${dbPath} → ${summarizeNames([...otherNamespaces], 8)}`,
			to: "—",
			action: "skip",
			detail:
				`${otherNamespaces.size} settings namespace(s) beyond model and permission, left where they are — ` +
				"ZCode stores them under free-text namespaces, so a newer version may write ones this importer has " +
				"never seen; read them in ZCode if one of them matters here",
			containsSecret: false,
		});
	}

	if (raw.pluginCount > 0) {
		items.push({
			source: "zcode",
			from: tildePath(raw.home, join(raw.cliDir, "plugins", "cache")),
			to: "—",
			action: "skip",
			detail: `${raw.pluginCount} installed plugin(s) — third-party code rather than your own configuration`,
			containsSecret: false,
		});
	}
	if (raw.rolloutCount > 0) {
		items.push({
			source: "zcode",
			from: `${tildePath(raw.home, join(raw.cliDir, "rollout"))}/*.jsonl`,
			to: "—",
			action: "skip",
			detail: `${raw.rolloutCount} raw model I/O log(s), which embed live request Authorization headers — never opened`,
			containsSecret: false,
		});
	}

	// The two trees this importer did not read, named rather than left silent.
	// Both are cases where the report would otherwise claim the whole of a
	// source it only saw half of, which is the failure this section exists for.
	if (!raw.dbPresent) {
		items.push({
			source: "zcode",
			from: dbPath,
			to: "—",
			action: "skip",
			detail:
				"no database here — ZCode's CLI writes it on its first run, and the permission decisions above " +
				"live in it, so a tree that was moved rather than copied leaves them behind",
			containsSecret: false,
		});
	}
	if (raw.betaCliDir !== null) {
		items.push({
			source: "zcode",
			// The whole tree, not a file in it: what a beta install keeps here is the
			// database, the plugin cache and the logs, and its `config.json` is the
			// stable one this importer already read — naming that would point at a
			// file the reader has and pretend the skipped tree has one.
			from: `${tildePath(raw.home, raw.betaCliDir)}/`,
			to: "—",
			action: "skip",
			detail:
				"a beta-channel tree — ZCode picks it from the name of its own binary, which this run cannot " +
				"see; set ZCODE_STORAGE_DIR to that directory and run again to import from it instead",
			containsSecret: false,
		});
	}

	// The keys of the two config files, so that none of them can go missing from
	// the report without saying so. This is the whole point of the section: ZCode
	// grew these files a key at a time and this importer knows a fixed set of
	// them, so silence would read as "nothing there" for a setting the user set.
	for (const [label, container] of [
		[v2Config, raw.config],
		[cliConfigPath, raw.cliConfig],
	] as const) {
		if (container.$schema !== undefined) {
			items.push({
				source: "zcode",
				from: `${label} → $schema`,
				to: "—",
				action: "skip",
				detail: "a JSON-schema pointer for the editor, not a setting — the file it points at is ZCode's own",
				containsSecret: false,
			});
		}
	}
	planZcodeHooks(raw, cliConfigPath, items, claimHooks, existing, force);
	const features = isRecord(raw.cliConfig.features) ? raw.cliConfig.features : undefined;
	if (features) {
		for (const [key, what] of Object.entries(ZCODE_FEATURE_SWITCHES)) {
			if (features[key] === undefined) continue;
			items.push({
				source: "zcode",
				from: `${cliConfigPath} → features.${key}`,
				to: "—",
				action: "skip",
				detail: what,
				containsSecret: false,
			});
		}
		const unknownFeatures = Object.keys(features).filter((key) => key !== "skill" && !ZCODE_FEATURE_SWITCHES[key]);
		if (unknownFeatures.length > 0) {
			items.push({
				source: "zcode",
				from: `${cliConfigPath} → features.{${summarizeNames(unknownFeatures)}}`,
				to: "—",
				action: "skip",
				detail: `${unknownFeatures.length} key(s) beyond the six ZCode declares — ZCode's own schema would have dropped this one`,
				containsSecret: false,
			});
		}
	}
	for (const [key, reason] of UNMIGRATED_ZCODE_CLI_KEYS) {
		if (raw.cliConfig[key] === undefined) continue;
		items.push({
			source: "zcode",
			from: `${cliConfigPath} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	reportUnhandledKeys("zcode", raw.config, ZCODE_V2_HANDLED, v2Config, items);
	reportUnhandledKeys("zcode", raw.cliConfig, ZCODE_CLI_HANDLED, cliConfigPath, items);
}

/**
 * ZCode's `hooks` block onto this build's hook config.
 *
 * The shape is close enough to the other sources' that copying it reads as
 * faithful and is not, in three places — all three found by reading ZCode
 * rather than by looking at what the normalizer would have done with the file:
 *
 * - **Nothing runs unless the block is enabled.** `create-app.ts` reads
 *   `runtimeConfig.hooks?.enabled === true`, and the runner then takes an empty
 *   list of registrations. A block without it is one ZCode never fired, so
 *   importing it as live hooks would switch on what the user had off.
 * - **`timeoutMs` outranks `timeout`.** `resolveWorkspaceHookTimeoutMs` in
 *   `packages/shared/src/workspace-hook-config.ts` takes `timeoutMs` when it is
 *   there and converts `timeout` from seconds otherwise, so a handler that set
 *   only `timeoutMs` must not arrive as untimed.
 * - **A `process` handler is not a command line.** The runner spawns its
 *   `command` as an executable with `args` beside it (`mode: "argv"`); this
 *   build runs hooks through a shell, so importing one would change what the
 *   string means. It is counted and named, not carried.
 *
 * Two of ZCode's seven events — `PermissionRequest` and `PostToolUseFailure` —
 * have no counterpart here, and the normalizer's own list names them rather
 * than this file hard-coding a second copy that could fall behind.
 */
function planZcodeHooks(
	raw: RawZcode,
	cliConfigPath: string,
	items: MigrationItem[],
	claimHooks: ClaimHooks,
	existing: RawSettingsInput,
	force: boolean,
): void {
	const hooks = isRecord(raw.cliConfig.hooks) ? raw.cliConfig.hooks : undefined;
	if (!hooks) return;
	// An empty block is not a hook file with nothing runnable; it is nothing.
	if (Object.keys(hooks).length === 0) return;
	const from = `${cliConfigPath} → hooks`;

	if (hooks.enabled !== true) {
		items.push({
			source: "zcode",
			from,
			to: "—",
			action: "skip",
			detail:
				"ZCode runs no hook from this block: its startup reads `hooks.enabled === true` and this is not it, " +
				"so the block was inert there and importing it as live hooks would switch on something that was off",
			containsSecret: false,
		});
		return;
	}

	// The two defaults that sit beside `events` govern the whole block, and
	// neither has a counterpart here that this code can write. Saying so is the
	// difference between a report that is complete and one that stops at the
	// events and lets the user believe the rest of their file came across.
	if (typeof hooks.timeoutMs === "number" && Number.isFinite(hooks.timeoutMs) && hooks.timeoutMs > 0) {
		const there = hooks.timeoutMs / 1000;
		const here = DEFAULT_HOOK_TIMEOUT_MS / 1000;
		items.push({
			source: "zcode",
			from: `${from}.timeoutMs`,
			to: "—",
			action: "skip",
			detail:
				there === here
					? `the default for every handler in this block that names no timeout of its own — ${here} s, which is what such a handler waits for here too`
					: `the default for every handler in this block that names no timeout of its own: ${there} s there, ${here} s here — a handler that names a timeout of its own keeps it`,
			containsSecret: false,
		});
	}
	if (hooks.maxOutputBytes !== undefined) {
		items.push({
			source: "zcode",
			from: `${from}.maxOutputBytes`,
			to: "—",
			action: "skip",
			detail:
				"a cap on how much of a hook's output is kept — there is no such cap here, so what a hook prints is read in full rather than truncated",
			containsSecret: false,
		});
	}
	reportUnhandledKeys("zcode", hooks, ZCODE_HOOK_ROOT_HANDLED, from, items);

	const { events, processHandlers } = zcodeHookEvents(isRecord(hooks.events) ? hooks.events : {});
	const normalized = normalizeClaudeHooks(events);
	const losses: string[] = [];
	if (normalized.droppedEvents.length > 0) {
		losses.push(
			`${normalized.droppedEvents.length} event(s) with no hook here (${summarizeNames(normalized.droppedEvents)})`,
		);
	}
	if (processHandlers > 0) {
		losses.push(
			`${processHandlers} handler(s) ZCode spawns as an executable with arguments, which this build runs as a shell command instead`,
		);
	}
	if (normalized.droppedMatchers.length > 0) {
		losses.push(
			`${normalized.droppedMatchers.length} matcher(s) using pattern characters this build escapes (${summarizeNames(normalized.droppedMatchers)})`,
		);
	}
	if (normalized.malformed > 0) losses.push(`${normalized.malformed} entr(ies) not in the hook shape`);
	if (normalized.clampedTimeouts > 0) {
		losses.push(
			`${normalized.clampedTimeouts} timeout(s) longer than the ${MAX_HOOK_TIMEOUT_MS / 1000} s this build waits, clamped to it`,
		);
	}

	const carried = Object.keys(normalized.config);
	if (carried.length === 0) {
		items.push({
			source: "zcode",
			from,
			to: "—",
			action: "skip",
			detail:
				losses.length > 0
					? `nothing here would run: ${losses.join("; ")}`
					: "no hook in this block has a command this build could run",
			containsSecret: false,
		});
		return;
	}
	if (!HooksConfigSchema.safeParse(normalized.config).success) {
		items.push({
			source: "zcode",
			from,
			to: "—",
			action: "skip",
			detail: "hooks are not in a shape this build accepts, even after rewriting",
			containsSecret: false,
		});
		return;
	}
	if (existing.hooks !== undefined && !force) {
		items.push({
			source: "zcode",
			from,
			to: "—",
			action: "skip",
			detail: "target already defines hooks — kept (use --force to overwrite)",
			containsSecret: false,
		});
		return;
	}
	// What is left to say is what happens to a handler that named neither a
	// timeout of its own nor one the block defaulted: this build waits a minute,
	// which is ZCode's own default unless the block set one, and a block that did
	// say so has a line of its own above naming what it said.
	const timeouts = [
		normalized.convertedTimeouts > 0
			? `${normalized.convertedTimeouts} timeout(s) converted to milliseconds, whether ZCode wrote them as seconds or as \`timeoutMs\``
			: "",
		normalized.untimedHandlers > 0
			? `a handler that names no timeout runs for ${DEFAULT_HOOK_TIMEOUT_MS / 1000} s here, which is ZCode's default too unless the block set one`
			: "",
	]
		.filter(Boolean)
		.join("; ");
	const entries = carried.reduce((count, event) => count + normalized.config[event].length, 0);
	claimHooks(
		"zcode",
		normalized.config,
		from,
		`${entries} matcher entr(ies) over ${carried.length} event(s) rewritten${timeouts ? `; ${timeouts}` : ""}${losses.length > 0 ? `; not carried: ${losses.join("; ")}` : ""}`,
		losses.length > 0 ? "downgrade" : "map",
	);
}

/**
 * ZCode's `events` map in the form the shared normalizer reads, with the
 * handlers it must not be handed counted on the way past.
 */
function zcodeHookEvents(events: Record<string, unknown>): {
	events: Record<string, unknown>;
	processHandlers: number;
} {
	const out: Record<string, unknown> = {};
	let processHandlers = 0;
	for (const [event, entries] of Object.entries(events)) {
		if (!Array.isArray(entries)) {
			// Left exactly as found: the normalizer counts a non-list as malformed,
			// which is the truer description than anything this could substitute.
			out[event] = entries;
			continue;
		}
		out[event] = entries.map((entry) => {
			if (!isRecord(entry) || !Array.isArray(entry.hooks)) return entry;
			return {
				...entry,
				hooks: entry.hooks
					.filter((handler) => {
						if (!isRecord(handler) || handler.type !== "process") return true;
						processHandlers += 1;
						return false;
					})
					.map((handler) => zcodeHookHandlerWithTimeout(handler)),
			};
		});
	}
	return { events: out, processHandlers };
}

/**
 * One handler with its timeout in the seconds the normalizer reads.
 *
 * `timeoutMs` is the field ZCode reaches for first, so a handler that set both
 * keeps the `timeout` it also wrote and one that set only `timeoutMs` gets the
 * value converted rather than arriving as a hook with no wait of its own.
 */
function zcodeHookHandlerWithTimeout(handler: unknown): unknown {
	if (!isRecord(handler)) return handler;
	const already = handler.timeout;
	if (typeof already === "number" && Number.isFinite(already) && already > 0) return handler;
	const millis = handler.timeoutMs;
	if (typeof millis !== "number" || !Number.isFinite(millis) || millis <= 0) return handler;
	return { ...handler, timeout: millis / 1000 };
}

/**
 * ZCode's per-file on/off maps — `skill` and `command` in its CLI config — as the
 * set of absolute paths it holds off.
 *
 * `collectDisabledPaths` in `bootstrap/src/skill-command-overrides.ts` is three
 * lines long: every key whose `enable` is `false`, and nothing else. There is no
 * `enable: true` to read, because the map is an override of a default-on file
 * rather than a setting of its own, so a `true` there changes nothing and must
 * not be treated as permission to import a file the user switched off.
 */
function zcodeDisabledPaths(overrides: unknown): Set<string> {
	const off = new Set<string>();
	if (!isRecord(overrides)) return off;
	for (const [path, value] of Object.entries(overrides)) {
		if (isRecord(value) && value.enable === false) off.add(resolve(path));
	}
	return off;
}

/**
 * The skills this build should import: the ones ZCode itself would have loaded.
 *
 * Three answers decide that, and all three default to on — which is the opposite
 * of the `hooks` flag next to them, and the reason each is read as `!== false`
 * rather than `=== true`. `create-app.ts` builds the skill adapter only when
 * `config.features.skill && config.skills.enabled`, so either one false means the
 * tree was dormant there; and `skill.<path>.enable = false` removes a single file
 * at discovery. Importing any of them would switch on something the user had off,
 * which is the same failure the `enabled` gate on hooks prevents.
 */
function zcodeLiveSkills(raw: RawZcode, items: MigrationItem[]): RawFile[] {
	const features = isRecord(raw.cliConfig.features) ? raw.cliConfig.features : undefined;
	const skillsConfig = isRecord(raw.cliConfig.skills) ? raw.cliConfig.skills : undefined;
	const treeOff =
		features?.skill === false
			? "ZCode's `features.skill` is off"
			: skillsConfig?.enabled === false
				? "ZCode's `skills.enabled` is off"
				: "";
	const off = zcodeDisabledPaths(raw.cliConfig.skill);
	const kept: RawFile[] = [];
	const offPaths: string[] = [];
	for (const skill of raw.skills) {
		if (treeOff !== "" || off.has(resolve(skill.sourcePath))) offPaths.push(skill.sourcePath);
		else kept.push(skill);
	}
	if (offPaths.length > 0) {
		const reason =
			treeOff !== ""
				? `${treeOff}, so ZCode ran none of them — importing the tree would switch it on`
				: `ZCode's own list holds ${offPaths.length} of them off (\`skill.<path>.enable = false\`), so they did not run there`;
		items.push({
			source: "zcode",
			from: tildePath(raw.home, join(raw.root, "skills")),
			to: "—",
			action: "skip",
			detail: `${offPaths.length} skill(s) not imported — ${reason}`,
			containsSecret: false,
		});
	}
	return kept;
}

/**
 * The name ZCode gives a command file, exactly as `commandNameFromPath` in the
 * CLI's `adapters/src/commands/index.ts` builds it: the path relative to the
 * commands root, the extension off, the separators joined with `:`, trimmed, and
 * lowercased by `normalizeCommandName`.
 *
 * This is not the same function as the skill name the generic reader derives, and
 * the difference is load-bearing. `fix/bugs.md` is `/fix:bugs` to ZCode and
 * `fix-bugs` to a skill, while `fix-bugs.md` is `/fix-bugs` and `fix-bugs` — two
 * commands there, one directory here. Deciding "these are the same command" on
 * the skill name would call that pair a duplicate and drop one of them, which is
 * a file the user could still run. Deciding it on this name cannot: two paths
 * only agree here if they differ in case alone, and two files differing only in
 * case exist on a case-sensitive filesystem and are one file on every other.
 */
function zcodeCommandName(relativePath: string): string {
	return relativePath
		.slice(0, -".md".length)
		.split(/[\\/]+/)
		.join(":")
		.trim()
		.replace(/^\/+/, "")
		.toLowerCase();
}

/** `COMMAND_NAME_PATTERN` in the same file, which `parseCommand` refuses a name that fails. */
const ZCODE_COMMAND_NAME = /^[a-z0-9][a-z0-9_:-]{0,63}$/;

/** What `zcodeReachableCommands` answered about one tree. */
export interface ZcodeReachableCommands {
	/** The files to hand the generic importer, renamed to the skill name ZCode's own name gives. */
	files: RawFile[];
	/** Files the user's own list held off. */
	off: string[];
	/** Files that were a second spelling of a name already reached. */
	shadowed: string[];
	/** Files `parseCommand` returned `null` for, by the reason it gave. */
	rejected: { path: string; reason: string }[];
	/** How many of the reachable ones sat in a subdirectory. */
	nested: number;
}

/**
 * Which of ZCode's command files were reachable to the user, and under what name.
 *
 * The four filters are the four `continue`s in `CustomCommandAdapter.load`, in its
 * own order, and each one is a file ZCode never registered:
 *
 * - a name `COMMAND_NAME_PATTERN` refuses (`-draft.md`, a name over 64 characters)
 *   is an error diagnostic and returns `null` before anything else is read;
 * - a file with no frontmatter `description` *and* nothing in the body — where
 *   "something in the body" is `extractDescription`'s first non-blank line with a
 *   heading or bullet marker stripped, so a command with only `# Fix the build`
 *   in it is a real one and an empty file is not;
 * - a path the user's own list holds off;
 * - a name another file already claimed, which ZCode reports as a duplicate and
 *   drops. The order is the directory's, because `scanMarkdownFiles` iterates
 *   `readdir` as it comes back and sorts nothing — so which of two case-only
 *   spellings survives here is the same question ZCode answered on that machine.
 */
export function zcodeReachableCommands(
	commands: RawCommands,
	commandsRoot: string,
	disabled: Set<string>,
): ZcodeReachableCommands {
	const claimed = new Set<string>();
	const out: ZcodeReachableCommands = { files: [], off: [], shadowed: [], rejected: [], nested: 0 };
	for (const file of commands.files) {
		// The reader builds `sourcePath` by joining onto the root it was handed, so
		// what is left after the root is a path that starts with a separator. It has
		// to come off before the nesting test, or every file looks nested.
		const relativePath = file.sourcePath.slice(commandsRoot.length).replace(/^[\\/]+/, "");
		const name = zcodeCommandName(relativePath);
		if (!ZCODE_COMMAND_NAME.test(name)) {
			out.rejected.push({ path: file.sourcePath, reason: "a name ZCode's own pattern refuses" });
			continue;
		}
		if (disabled.has(resolve(file.sourcePath))) {
			out.off.push(file.sourcePath);
			continue;
		}
		const { data, body } = parseFrontmatter(file.content);
		if ((data.description ?? "").trim() === "" && body.trim() === "") {
			out.rejected.push({ path: file.sourcePath, reason: "no description and an empty body" });
			continue;
		}
		if (claimed.has(name)) {
			out.shadowed.push(file.sourcePath);
			continue;
		}
		claimed.add(name);
		if (/[\\/]/.test(relativePath)) out.nested += 1;
		// The skill is named for what the user typed, which is ZCode's own name with
		// the nesting spelled the only way a directory can: `fix/bugs.md` was
		// `/fix:bugs` there and is the skill `fix-bugs` here, and `Review.md` was
		// `/review` rather than a skill nobody could have invoked by that name.
		out.files.push({ ...file, name: name.replace(/:/g, "-") });
	}
	return out;
}

/**
 * ZCode's own `commands/` tree, as skills.
 *
 * Which files were reachable is {@link zcodeReachableCommands}' answer; this is
 * the reporting and the write. One more rule belongs to neither, and is a naming
 * fact rather than a reachability one: a nested path is one name here, spelled
 * with a `-`, because ZCode's `:` is not a legal character in a directory name
 * on Windows. The report says so whenever a nested command was actually imported.
 */
function planZcodeCommands(
	raw: RawZcode,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	const commandsRoot = join(raw.root, "commands");
	const from = tildePath(raw.home, commandsRoot);
	const reachable = zcodeReachableCommands(raw.commands, commandsRoot, zcodeDisabledPaths(raw.cliConfig.command));
	if (reachable.off.length > 0) {
		items.push({
			source: "zcode",
			from: `${from} (switched off in ${tildePath(raw.home, raw.cliConfigPath)})`,
			to: "—",
			action: "skip",
			detail: `${reachable.off.length} command(s) ZCode's own list holds off (\`command.<path>.enable = false\`) — importing one would switch it on`,
			containsSecret: false,
		});
	}
	if (reachable.shadowed.length > 0) {
		items.push({
			source: "zcode",
			from,
			to: "—",
			action: "skip",
			detail: `${reachable.shadowed.length} command file(s) whose name another file in this tree already claimed — ZCode keeps the first one too, and the rest were unreachable there`,
			containsSecret: false,
		});
	}
	const rejected = new Map<string, string[]>();
	for (const { path, reason } of reachable.rejected) {
		const paths = rejected.get(reason) ?? [];
		paths.push(path);
		rejected.set(reason, paths);
	}
	for (const [reason, paths] of rejected) {
		items.push({
			source: "zcode",
			from,
			to: "—",
			action: "skip",
			detail: `${paths.length} command file(s) with ${reason} — ZCode rejects those rather than registering them, so they were never commands: ${summarizeNames(paths)}`,
			containsSecret: false,
		});
	}
	planCommands("zcode", { files: reachable.files, skips: raw.commands.skips }, from, home, force, items, writes);
	if (reachable.nested > 0) {
		items.push({
			source: "zcode",
			from,
			to: "—",
			action: "downgrade",
			detail: `${reachable.nested} nested command(s) had their name rewritten: ZCode joins a nested path with \`:\` (\`fix/bugs.md\` is \`/fix:bugs\` there) and a skill here is a directory, which cannot hold a \`:\``,
			containsSecret: false,
		});
	}
}

/**
 * ZCode's asset trees, after its own on/off answers have been applied to them.
 *
 * Not {@link planAssetTrees} directly, for the reason that helper's own doc
 * gives for the sources that spell skills differently: this source's skills and
 * commands each have a switch that decides whether ZCode ran them at all, and
 * importing a file the source never loaded would switch it on here.
 */
export function planZcodeAssets(
	raw: RawZcode,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	planAssetTrees(
		"zcode",
		{ ...raw, skills: zcodeLiveSkills(raw, items), commands: undefined },
		home,
		force,
		items,
		writes,
	);
	planZcodeCommands(raw, home, force, items, writes);
}

/**
 * ZCode's `permission.mode` against this build's. Four of ZCode's five values
 * have a counterpart and the fifth is not a mode at all; both facts come from
 * `checkPermission` in the CLI's `core/src/permission/service.ts`, where each
 * branch is a literal rather than a description in a comment.
 */
const ZCODE_PERMISSION_MODES: Record<string, string> = {
	plan: "plan",
	build: "default",
	edit: "acceptEdits",
	yolo: "bypassPermissions",
};

/**
 * Claim one ZCode mode, or name the one that cannot be. ZCode records a mode in
 * two places — `permission.mode` in its config file and a `permission/mode` row
 * in its database — and they are the same vocabulary, so they share this.
 */
function claimZcodeMode(mode: string, from: string, claimScalar: ClaimScalar, items: MigrationItem[]): void {
	const label = mode ? `${from} ("${mode}")` : from;
	const mapped = ZCODE_PERMISSION_MODES[mode];
	if (mapped) {
		claimScalar("zcode", "permissionMode", mapped, label, `mapped to "${mapped}"`);
		return;
	}
	items.push({
		source: "zcode",
		from: label,
		to: "—",
		action: "skip",
		detail: mode
			? mode === "auto"
				? 'ZCode has no working "auto" to copy: its own permission service answers it with a denial that says the mode is reserved and not implemented yet'
				: "no permission mode here corresponds to this value — the session keeps the mode it would otherwise start in; pick one with /permissions"
			: "unrecognised mode value — pick a permission mode with /permissions",
		containsSecret: false,
	});
}

/**
 * The keys of `permission` that the object in the CLI's `config/schema.ts:13`
 * declares and that nothing here reads. Both describe ZCode's own classifier
 * over its own capability table, which this build has no equivalent of.
 */
const UNMIGRATED_ZCODE_PERMISSION_KEYS: Array<[key: string, reason: string]> = [
	[
		"autoApproveHighRisk",
		"ZCode approves some risky calls on its own, per its own table of what counts as risky. There is no " +
			"such table here: what runs without asking is the rule list, and a rule is a tool name you wrote down",
	],
	[
		"allowMediumRiskInAuto",
		"ZCode's second switch for the same classifier, for the tier between safe and risky. It has no meaning " +
			"without `autoApproveHighRisk`, and neither has one here",
	],
];

/** Every key `permissionSchema` declares, so the ones above are the only unread ones. */
const ZCODE_PERMISSION_CONFIG_HANDLED = new Set<string>([
	"mode",
	"allowedTools",
	"disallowedTools",
	...UNMIGRATED_ZCODE_PERMISSION_KEYS.map(([key]) => key),
]);

/** The two keys `uiSchema` declares (`config/schema.ts:212`). */
const ZCODE_UI_CONFIG_HANDLED = new Set<string>(["theme", "locale"]);

/**
 * Keys of the CLI config that are read by nobody here and whose fate is settled.
 *
 * Each reason is why the setting cannot come across as itself, not a summary of
 * what it holds — the report is the only place a user learns their file had
 * something in it. Keys whose fate is still open (hooks, plugins, skills,
 * commands) are deliberately absent: they go to the aggregate until the
 * importer has an answer, which is the one description that cannot go stale.
 */
const UNMIGRATED_ZCODE_CLI_KEYS: Array<[key: string, reason: string]> = [
	[
		"network",
		"proxy, no-proxy and TLS settings. These belong to the process that opens the connection, not to a settings " +
			"file, and are read from the environment here (HTTPS_PROXY, NODE_EXTRA_CA_CERTS and the rest) — set them " +
			"in your shell",
	],
	[
		"modelStream",
		"ZCode's own streaming and retry knobs (idle timeout, keepalive, reconnect limits) for its provider layer; " +
			"requests here carry no equivalent, and the timeouts that do exist are not per-provider",
	],
	[
		"memory",
		"which memory pipeline ZCode runs — the index it builds and the model that summarises it. Nothing here " +
			"generates memories in the background; memory here is the documents the agent reads plus rules",
	],
	[
		"logging",
		"ZCode's log level and destination. This build logs to its own directory and takes the level from the " +
			"environment, and there is no per-source log destination to point at yours",
	],
	[
		"toolConcurrency",
		"per-tool parallel-call limits. This build schedules tools on one budget with no per-tool override, so a " +
			"limit set for ZCode's scheduler has nothing to attach to",
	],
	[
		"modelAnomalyGuard",
		"ZCode's detector for providers behaving oddly (error rates, latency shapes), and what it does when one " +
			"does. This build has no equivalent check to switch off",
	],
];

/**
 * Keys of `~/.zcode/cli/config.json` that this importer reads or explains, so
 * the closing aggregate names only the ones ZCode grew after this list was
 * written. Mirrors the object `ZCodeConfigFileSchema` in the CLI's `schema.ts`,
 * which is `.passthrough()` — every key below is one that file accepts, and the
 * aggregate is what catches the rest.
 */
const ZCODE_CLI_HANDLED = new Set<string>([
	// Read above: the servers, the two paths that decide where the rest of the
	// CLI half lives, and the sub-blocks whose keys are each accounted for
	// elsewhere — `permission` by mode, the two tool lists and a reason for the
	// rest, `ui` by the theme and a reason for the rest, `hooks` by its events,
	// the two block-wide defaults beside them and the flag that decides whether
	// that block ran at all, and `features` by the one key of its six that
	// decides whether the skill tree is live.
	"mcp",
	"storage",
	"permission",
	"ui",
	"hooks",
	"features",
	// The asset switches: the two per-file on/off maps and the whole-tree one.
	"skill",
	"skills",
	"command",
	// Explained by a line of their own.
	"$schema",
	...UNMIGRATED_ZCODE_CLI_KEYS.map(([key]) => key),
]);

/**
 * ZCode's feature flags other than the skill one, and what each of them switches
 * off there.
 *
 * `featuresSchema` is six optional booleans that all default to on. Five of them
 * gate code that does not exist here, so the only thing the report owes is the
 * one thing the user cannot see from a skills directory that is still sitting on
 * disk: that ZCode would not have run it. `skill` is the sixth and is not here —
 * it is read, because it decides whether the skills are imported at all.
 */
const ZCODE_FEATURE_SWITCHES: Record<string, string> = {
	compact: "ZCode's context compaction, which runs no equivalent here — nothing of it carries across",
	rewind: "ZCode's conversation rewind, which has no counterpart here",
	subagent: "ZCode's subagents, which this build spawns on its own terms and takes no flag for",
	memory: "ZCode's own memory pipeline; what is imported here is the documents and rules it was reading",
	mcp: "ZCode's MCP servers, which are imported below whether this flag is set or not",
};

/**
 * Keys of `~/.zcode/v2/config.json`. The desktop file is typed
 * `{ $schema?, provider?, [key: string]: unknown }` in the reader that owns it, so
 * this list is genuinely short: `provider` is the only thing it is read for, and
 * everything else a user put in that file lands in the aggregate.
 */
const ZCODE_V2_HANDLED = new Set<string>(["provider", "$schema"]);

/**
 * The four keys ZCode's own `hooksSchema` declares for a hooks block.
 *
 * It is a `.strict()` object, so a fifth key is one ZCode itself would have
 * rejected at load; naming it still beats leaving the user to wonder whether
 * the block that would not start was the block this importer read.
 */
const ZCODE_HOOK_ROOT_HANDLED = new Set<string>(["enabled", "timeoutMs", "maxOutputBytes", "events"]);

/**
 * Rewrite a ZCode MCP entry into labunbun's config shape.
 *
 * `http_headers` is the one field that must be renamed — leaving it would make
 * the server definition fail the schema, and a server that silently loses its
 * credential headers fails at connect time with an auth error instead of
 * saying what changed.
 */
/**
 * ZCode's MCP server shape → this build's, following ZCode's own
 * `normalizeMcpServerConfigInput` (`schema.ts:331-384`) key for key rather than
 * by guesswork. Where the two disagree, the source wins and the disagreement is
 * named:
 *
 * - `environment` becomes `env` when `env` is absent, and `environment` is
 *   dropped either way. A legacy stdio server that used the old spelling
 *   otherwise arrives with no environment at all, and fails to start on a
 *   variable it plainly had.
 * - `type: "remote"` becomes `http`, and a missing `type` is inferred from
 *   `command` then `url` — which is what the `url`-first order below already
 *   does, so that spelling needs no branch of its own.
 * - `timeout` and `startup_timeout_sec` are accepted and then discarded by
 *   ZCode itself ("ZCode does not migrate those values"), so dropping them here
 *   matches; `oauth`, `protocolVersion` and `timeoutMs` have no field in this
 *   build's schema at all. All five are named in the report rather than dropped
 *   in silence, because the item says the record was copied verbatim.
 * - `enabled` is not in this build's schema and a server with no field to carry
 *   it is one this build will start, so a disabled server is skipped by the
 *   caller rather than migrated-and-running.
 */
function normalizeZcodeMcp(
	entry: Record<string, unknown>,
): { ok: true; config: Record<string, unknown>; renamed: string[]; dropped: string[] } | { ok: false; reason: string } {
	const dropped = ["oauth", "protocolVersion", "timeoutMs", "timeout", "startup_timeout_sec"].filter(
		(key) => entry[key] !== undefined,
	);
	const renamed: string[] = [];
	// `env` wins when both spellings are present — the source's own rule
	// (`if (!("env" in server) && "environment" in server)`), because a config
	// that names the same variable twice is a config whose author already chose.
	const env = isRecord(entry.env) ? entry.env : isRecord(entry.environment) ? entry.environment : undefined;
	if (env !== undefined && !isRecord(entry.env)) renamed.push("environment renamed to env");
	if (entry.type === "sse") {
		// The two transports are different protocols, not two spellings of one:
		// a StreamableHTTP client against an SSE endpoint connects and then
		// fails every call. ZCode runs both; this build runs one, so the honest
		// outcome is a named skip rather than a server that cannot work.
		return {
			ok: false,
			reason:
				"SSE transport — this build speaks stdio and Streamable HTTP only, and the two are different protocols rather than two spellings of one",
		};
	}
	const headers = isRecord(entry.http_headers) ? entry.http_headers : undefined;
	const url = typeof entry.url === "string" && entry.url.trim() ? entry.url : undefined;
	if (url) {
		const out: Record<string, unknown> = { type: "http", url };
		const merged = headers ?? (isRecord(entry.headers) ? entry.headers : undefined);
		if (merged) out.headers = merged;
		if (headers !== undefined && entry.headers === undefined) renamed.unshift("http_headers renamed to headers");
		return { ok: true, config: out, renamed, dropped };
	}
	// The source infers stdio from a command that is not blank, and the trim is
	// its own: a whitespace-only command is not a command, and a server keyed on
	// one produces a spawn error rather than a connection error.
	const command = entry.command;
	if (typeof command === "string" && command.trim()) {
		const out: Record<string, unknown> = {
			type: "stdio",
			command,
			args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [],
		};
		if (env) out.env = env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		return { ok: true, config: out, renamed, dropped };
	}
	if (Array.isArray(command) && typeof command[0] === "string" && command[0].trim()) {
		const out: Record<string, unknown> = {
			type: "stdio",
			command: command[0],
			args: command.slice(1).filter((a): a is string => typeof a === "string"),
		};
		if (env) out.env = env;
		if (typeof entry.cwd === "string") out.cwd = entry.cwd;
		return { ok: true, config: out, renamed, dropped };
	}
	return { ok: false, reason: "server definition does not match the supported stdio/http shapes" };
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
