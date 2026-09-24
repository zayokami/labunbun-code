/**
 * Step Code's configuration in the target's shape: the approval mode and
 * permission preset, providers, MCP servers, and the asset trees.
 */

import { join } from "node:path";
import { BUILT_IN_THEME_NAMES } from "@labunbun/tui";
import {
	collectFileWrites,
	isRecord,
	leafName,
	mergeProviderSpecs,
	placeholderNote,
	planCommands,
	planMemoryAsRule,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
} from "./migrate-core.ts";
import type { ClaimScalar, MigrationItem, PlannedWrite } from "./migrate-types.ts";
import { looksLikeSecretName, resolveModelReference } from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";
import { OpenAICompatibleProviderSchema } from "./settings.ts";
import { stepConfigDirName } from "./step-home.ts";
import type { RawStepCode } from "./step-read.ts";
import { STEP_STATE_FILES, stepConfigPath } from "./step-read.ts";

// ---------------------------------------------------------------------------
// Step Code
// ---------------------------------------------------------------------------

/**
 * Step's three approval modes, as the permission modes this build has for them.
 *
 * The vendor's own tables, in the order the resolution below follows them:
 *
 *   - `step/permissions.ts:22-70` — the four presets and the triple each one
 *     stands for: `ask` → {confirm, deny, false}, `read-only` → {strict, deny,
 *     false}, `bypass` → {auto, allow, false}, `autopilot` → {auto, allow, true};
 *   - `:155-173` — a *preset* name is normalized through an older vocabulary
 *     (`confirm`→ask, `readonly`/`strict`→read-only, `auto`/`bypasspermissions`
 *     →bypass); `:176-195` — a *mode* name through another, one level lower
 *     (`ask`/`default`/`acceptedits`→confirm, `read-only`/`readonly`/`plan`
 *     →strict, `bypass`/`bypasspermissions`→auto);
 *   - `:286-324` — `effectiveMode = approvalMode ?? preset.mode`;
 *   - `:331-418` — `decideStepToolCall`: a read-only tool runs, a mutating tool
 *     is put to the user in `confirm`, denied in `strict`, and runs in `auto`
 *     unless Step's command analyser calls the command dangerous.
 */
const STEP_APPROVAL_MODES: Record<string, { mode: string; detail: string }> = {
	confirm: {
		mode: "default",
		detail:
			'mapped to "default": a mutating call is put to you before it runs, which is what Step\'s confirm mode does',
	},
	strict: {
		mode: "plan",
		detail:
			'mapped to "plan", which denies every mutating tool the way Step\'s read-only mode does — the difference worth knowing is ' +
			"that leaving plan mode here is itself an approval, where read-only is a standing answer",
	},
	auto: {
		mode: "bypassPermissions",
		detail:
			'mapped to "bypassPermissions", the nearest posture and a wider one: Step\'s auto mode still asks before a command its ' +
			"command analyser calls dangerous (`rm -rf` above all — it needs confirming for every target there), and nothing here asks",
	},
};

/** A setting at one of the spellings a live `config.toml` may carry it under. */
type StepCandidate = [key: string, value: unknown];

/** The first candidate the normalizer recognizes, with the key it came from. */
function stepFirstRecognized<T>(
	candidates: StepCandidate[],
	normalize: (value: string | undefined) => T | undefined,
): { key: string; value: T } | undefined {
	for (const [key, value] of candidates) {
		if (typeof value !== "string") continue;
		const normalized = normalize(value);
		if (normalized !== undefined) return { key, value: normalized };
	}
	return undefined;
}

/** The first candidate that is a boolean, with the key it came from. */
function stepFirstBoolean(candidates: StepCandidate[]): { key: string; value: boolean } | undefined {
	for (const [key, value] of candidates) {
		if (typeof value === "boolean") return { key, value };
	}
	return undefined;
}

/** A preset name as `{preset, mode}` — what the preset is called and the mode it stands for. */
function resolveStepPreset(value: string | undefined): { preset: string; mode: string } | undefined {
	switch (value?.trim().toLowerCase()) {
		case "ask":
		case "confirm":
			return { preset: "ask", mode: "confirm" };
		case "read-only":
		case "readonly":
		case "strict":
			return { preset: "read-only", mode: "strict" };
		case "bypass":
		case "auto":
		case "bypasspermissions":
			return { preset: "bypass", mode: "auto" };
		case "autopilot":
			return { preset: "autopilot", mode: "auto" };
		default:
			return undefined;
	}
}

/** A low-level approval mode name, normalized to the one of the three it means. */
function resolveStepApprovalMode(value: string | undefined): string | undefined {
	switch (value?.trim().toLowerCase()) {
		case "confirm":
		case "ask":
		case "default":
		case "acceptedits":
			return "confirm";
		case "strict":
		case "read-only":
		case "readonly":
		case "plan":
			return "strict";
		case "auto":
		case "bypass":
		case "bypasspermissions":
			return "auto";
		default:
			return undefined;
	}
}

/**
 * The starting permission posture, from the live `config.toml`.
 *
 * The resolution is the vendor's own, key for key and in its order: a mode first
 * (`step/settings-manager.ts:149-157`, `[approvalMode, approval.mode,
 * tools.approval.mode]`), then a preset (`:141-148`, `[permissionPreset,
 * permissionMode, approval.preset, tools.approval.preset]`), then
 * `effectiveMode = approvalMode ?? preset.mode`. A value the vendor's tables do
 * not recognize does not decide anything there either — the loop moves to the
 * next candidate — so this does the same, and says so when nothing at the end of
 * that chain was recognized.
 *
 * `autoResume`, `nonInteractiveApproval` and `feedbackEnabled` are resolved too,
 * but only so their report lines can name what they were: none of the three has
 * a counterpart here.
 */
function planStepPermissionMode(
	raw: RawStepCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
): void {
	const config = raw.config;
	const from = tildePath(home, stepConfigPath(raw.root));
	const approval = isRecord(config.approval) ? config.approval : {};
	const tools = isRecord(config.tools) ? config.tools : {};
	const toolsApproval = isRecord(tools.approval) ? tools.approval : {};

	const mode = stepFirstRecognized(
		[
			["approvalMode", config.approvalMode],
			["approval.mode", approval.mode],
			["tools.approval.mode", toolsApproval.mode],
		],
		resolveStepApprovalMode,
	);
	const preset = stepFirstRecognized(
		[
			["permissionPreset", config.permissionPreset],
			["permissionMode", config.permissionMode],
			["approval.preset", approval.preset],
			["tools.approval.preset", toolsApproval.preset],
		],
		resolveStepPreset,
	);
	const effectiveMode = mode?.value ?? preset?.value.mode;

	if (effectiveMode !== undefined) {
		const mapped = STEP_APPROVAL_MODES[effectiveMode];
		const source = mode !== undefined ? `${from} → ${mode.key}` : `${from} → ${preset?.key}`;
		if (mapped !== undefined) {
			// A preset is named as well as applied: `autopilot` is two settings in one,
			// and the half that has no counterpart here is reported below.
			const provenance =
				preset === undefined
					? ""
					: preset.value.mode === effectiveMode
						? `; the preset beside it, "${preset.value.preset}", resolves to the same mode`
						: `; the preset beside it is "${preset.value.preset}", whose mode "${preset.value.mode}" the explicit mode overrides`;
			claimScalar("step-code", "permissionMode", mapped.mode, source, `${mapped.detail}${provenance}`);
		}
	} else {
		// Nothing in the chain was recognized. Only worth a line when something was
		// there to recognize — otherwise the file simply says nothing about it.
		const spelled = [
			["permissionPreset", config.permissionPreset],
			["permissionMode", config.permissionMode],
			["approvalMode", config.approvalMode],
			["approval.preset", approval.preset],
			["approval.mode", approval.mode],
			["tools.approval.preset", toolsApproval.preset],
			["tools.approval.mode", toolsApproval.mode],
		].filter(([, value]) => typeof value === "string" && value.trim() !== "") as Array<[string, string]>;
		if (spelled.length > 0) {
			items.push({
				source: "step-code",
				from: spelled.map(([key, value]) => `${from} → ${key} ("${value}")`).join(", "),
				to: "—",
				action: "skip",
				detail:
					"not a preset or mode Step reads, so it never decided a session there either — the permission mode is left as it is",
				containsSecret: false,
			});
		}
	}

	// ── autoResume / nonInteractiveApproval / feedbackEnabled ────────────────
	const autoResume = stepFirstBoolean([
		["autoResume", config.autoResume],
		["autopilot", config.autopilot],
		["approval.autoResume", approval.autoResume],
		["approval.autopilot", approval.autopilot],
		["tools.approval.autoResume", toolsApproval.autoResume],
		["tools.approval.autopilot", toolsApproval.autopilot],
	]);
	const fromPreset = preset?.value.preset === "autopilot";
	const resumeValue = autoResume?.value ?? (fromPreset ? true : undefined);
	if (resumeValue !== undefined) {
		// `normalizeAutoResume` (`permissions.ts:271-281`) only lets the flag count
		// when the mode is auto *and* the non-interactive fallback allows, which the
		// two auto presets both give it.
		const active = resumeValue && effectiveMode === "auto";
		items.push({
			source: "step-code",
			from: autoResume === undefined ? `${from} → permissionPreset ("autopilot")` : `${from} → ${autoResume.key}`,
			to: "—",
			action: "skip",
			detail:
				(resumeValue ? "" : "set to false, and ") +
				"a continuation ladder for transient model errors, which this build does not have — " +
				(active
					? "it was in force over there, so a run that would have carried on after a transient failure stops here"
					: "it was not in force over there either"),
			containsSecret: false,
		});
	}
	const nonInteractive = stepFirstRecognized(
		[
			["nonInteractiveApproval", config.nonInteractiveApproval],
			["noninteractiveApproval", config.noninteractiveApproval],
			["approval.nonInteractive", approval.nonInteractive],
			["approval.noninteractive", approval.noninteractive],
			["tools.approval.nonInteractive", toolsApproval.nonInteractive],
			["tools.approval.noninteractive", toolsApproval.noninteractive],
		],
		(value) => {
			const normalized = value?.trim().toLowerCase();
			return normalized === "allow" || normalized === "deny" ? normalized : undefined;
		},
	);
	if (nonInteractive !== undefined) {
		items.push({
			source: "step-code",
			from: `${from} → ${nonInteractive.key} ("${nonInteractive.value}")`,
			to: "—",
			action: "skip",
			detail:
				'what an unattended run does with an approval request: Step\'s "allow" runs the call, its "deny" refuses it. This build ' +
				"has one answer for that, so the value is named rather than carried — the preset above already sets the posture an " +
				"attended session asks from",
			containsSecret: false,
		});
	}
	const feedback = stepFirstBoolean([
		["feedbackEnabled", config.feedbackEnabled],
		["feedback.enabled", isRecord(config.feedback) ? config.feedback.enabled : undefined],
	]);
	if (feedback !== undefined) {
		items.push({
			source: "step-code",
			from: `${from} → ${feedback.key} (${JSON.stringify(feedback.value)})`,
			to: "—",
			action: "skip",
			detail:
				"whether Step submits your feedback to the vendor — a switch about their service, with nothing to switch here",
			containsSecret: false,
		});
	}
}

/**
 * One provider from `models.json`, as an entry this build can register.
 *
 * `models.json` is a *strict* document — a TypeBox schema the vendor compiles
 * (`core/model-config.ts:209-213`), so a provider that loads there is
 * well-formed by construction — and it holds two different things under one
 * key: the credentials half (`apiKey`, never read) and the endpoint half.
 *
 * Three dispositions, because the two protocols this build cannot speak are not
 * the same kind of thing as a missing endpoint:
 *
 *   - a model whose protocol is `openai-completions` travels;
 *   - a model speaking `anthropic-messages` or `openai-responses` does not —
 *     `providers.openaiCompatible` here is one chat-completions endpoint for
 *     the whole provider (`settings.ts:39-53`), and there is no per-model
 *     protocol to say otherwise;
 *   - a model with no protocol at all travels nowhere: the vendor's own
 *     composer throws for it (`provider-composer.ts:141-145`, "no \"api\"
 *     specified"), so nothing was serving it there either.
 *
 * The limits use the vendor's own fallbacks rather than this importer's — 128k
 * context and 16 384 output tokens (`provider-composer.ts:165-166`) — because
 * those are the numbers a session over there was actually running under, and
 * the schema here requires both.
 */
function stepModelEntries(
	provider: Record<string, unknown>,
	providerApi: unknown,
): {
	entries: Array<Record<string, unknown>>;
	/** The endpoint behind each carried model, so the caller can tell whether one provider holds several. */
	endpoints: string[];
	foreign: string[];
	silent: string[];
	noEndpoint: string[];
	unapplied: string[];
} {
	const entries: Array<Record<string, unknown>> = [];
	const endpoints: string[] = [];
	const foreign: string[] = [];
	const silent: string[] = [];
	const noEndpoint: string[] = [];
	const unapplied: string[] = [];
	const models = Array.isArray(provider.models) ? provider.models : [];
	const overrides = isRecord(provider.modelOverrides) ? provider.modelOverrides : {};
	const providerBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
	for (const value of models) {
		if (!isRecord(value)) continue;
		const id = typeof value.id === "string" ? value.id.trim() : "";
		if (id === "") continue;
		const override = isRecord(overrides[id]) ? (overrides[id] as Record<string, unknown>) : {};
		const api = value.api ?? providerApi;
		if (typeof api !== "string" || api === "") {
			silent.push(id);
			continue;
		}
		if (api !== "openai-completions") {
			foreign.push(`${id} (${api})`);
			continue;
		}
		const modelBaseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
		const baseUrl = modelBaseUrl || providerBaseUrl;
		if (baseUrl === "") {
			noEndpoint.push(id);
			continue;
		}
		endpoints.push(baseUrl);
		const context = [override.contextWindow, value.contextWindow].find(
			(candidate): candidate is number => typeof candidate === "number" && candidate > 0,
		);
		const output = [override.maxTokens, value.maxTokens].find(
			(candidate): candidate is number => typeof candidate === "number" && candidate > 0,
		);
		const name = [override.name, value.name].find(
			(candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
		);
		const reasoning = [override.reasoning, value.reasoning].find(
			(candidate): candidate is boolean => typeof candidate === "boolean",
		);
		const cost = isRecord(override.cost) ? override.cost : isRecord(value.cost) ? value.cost : undefined;
		// Every cost block Step's schema accepts is complete (`core/model-config.ts:144-151`),
		// so the four rates are read as given; `tiers` is the one part with no
		// counterpart in `ModelPricingSchema`, and it is named rather than dropped.
		const pricing =
			cost === undefined
				? undefined
				: {
						input: typeof cost.input === "number" ? cost.input : 0,
						output: typeof cost.output === "number" ? cost.output : 0,
						cacheRead: typeof cost.cacheRead === "number" ? cost.cacheRead : 0,
						cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : 0,
					};
		if (isRecord(cost) && Array.isArray(cost.tiers) && cost.tiers.length > 0) {
			unapplied.push(`${id}: ${cost.tiers.length} cost tier(s)`);
		}
		// The per-model keys this build's provider shape has nowhere to put.
		for (const [key, what] of [
			["thinkingLevelMap", "a thinking-level map"],
			["samplingParams", "sampling parameters"],
			["headers", "its own headers"],
			["compat", "a protocol-compat block"],
			["input", "an input-modality list"],
		] as const) {
			if (value[key] !== undefined || override[key] !== undefined) unapplied.push(`${id}: ${what}`);
		}
		entries.push({
			id,
			...(name === undefined ? {} : { name }),
			contextWindow: Math.floor(context ?? 128_000),
			maxOutputTokens: Math.floor(output ?? 16_384),
			...(reasoning === true ? { reasoning: true } : {}),
			...(pricing === undefined ? {} : { pricing }),
		});
	}
	const carried = new Set(entries.map((entry) => entry.id));
	for (const id of Object.keys(overrides)) {
		if (!carried.has(id)) unapplied.push(`${id}: an override for a model this provider does not define`);
	}
	return { entries, endpoints, foreign, silent, noEndpoint, unapplied };
}

/**
 * What a Step provider's `apiKey` field says, without reading the key.
 *
 * The field is a small language, not a value (`models.json` documents it as a
 * literal, `$VAR`, `${VAR}` or `!command`), and only the two variable spellings
 * name something this build can read at start-up. A literal key is a secret
 * that must not be copied into a plan; `!command` is a program this importer
 * will not run. Both are reported by shape, never by content.
 */
function stepApiKeyName(value: unknown, fallback: string): { name: string; note?: string } {
	if (typeof value !== "string" || value.trim() === "") {
		return { name: fallback, note: `it names no api key variable, so this build reads $${fallback}` };
	}
	const trimmed = value.trim();
	const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed);
	if (braced) return { name: braced[1] };
	if (trimmed.startsWith("$") && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return { name: trimmed.slice(1) };
	if (trimmed.startsWith("!")) {
		return {
			name: fallback,
			note: `its key is produced by a shell command, which was neither read nor run — export the key yourself under $${fallback}`,
		};
	}
	return {
		name: fallback,
		note: `the key written in its apiKey was not read (a report carries names, not values) — export it under $${fallback}`,
	};
}

/** `models.json`'s provider table → `providers.openaiCompatible` entries. */
function planStepProviders(
	raw: RawStepCode,
	from: string,
	newIds: Map<string, string>,
	existing: RawSettingsInput,
	force: boolean,
): { specs: Array<Record<string, unknown>>; items: MigrationItem[] } {
	const items: MigrationItem[] = [];
	const specs: Array<Record<string, unknown>> = [];
	// The id a provider lands under is derived, so a collision with one the user
	// already has is possible and has to be decided here: a default model that
	// names it is rewritten to the derived id, and rewriting it to an id that was
	// never registered would leave settings.json pointing at another endpoint.
	const existingIds = new Set(
		((existing.providers?.openaiCompatible ?? []) as Array<{ id?: string }>).map((provider) => provider.id),
	);
	for (const [key, value] of Object.entries(raw.providers)) {
		const label = `${from}.${key}`;
		if (!isRecord(value)) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a provider table, so there is nothing here to register",
				containsSecret: false,
			});
			continue;
		}
		const models = stepModelEntries(value, value.api);
		// The endpoints a model carries are the ones that decide whether anything is
		// left to register; a provider whose own `baseUrl` is empty is not a skip in
		// itself, since every model may carry one of its own.
		const distinct = new Set(models.endpoints);
		if (models.entries.length === 0) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					models.foreign.length > 0
						? `no model this build can serve: ${summarizeNames(models.foreign)} speak a protocol other than openai-completions, ` +
							"and a provider entry here is one chat-completions endpoint"
						: models.silent.length > 0
							? `${models.silent.length} model(s) name no protocol at all, which Step's own composer refuses as well ("no "api" specified")`
							: models.noEndpoint.length > 0
								? `${models.noEndpoint.length} model(s) name neither an endpoint of their own nor a provider one`
								: "it defines no model this importer can read, so there is nothing to point a provider at",
				containsSecret: false,
			});
			continue;
		}
		if (distinct.size > 1) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					`its ${models.entries.length} openai-completions model(s) answer at ${distinct.size} different endpoints, and a ` +
					"provider entry here has one — split them into a provider each and import them by hand",
				containsSecret: false,
			});
			continue;
		}
		const endpoint = [...distinct][0] ?? "";
		const id = `step-${key}`;
		const { name: apiKeyEnv, note } = stepApiKeyName(
			value.apiKey,
			`${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
		);
		const spec = { id, baseUrl: endpoint, apiKeyEnv, models: models.entries };
		if (!OpenAICompatibleProviderSchema.safeParse(spec).success) {
			items.push({
				source: "step-code",
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
				source: "step-code",
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
		if (note !== undefined) extras.push(note);
		if (models.foreign.length > 0) {
			extras.push(
				`${models.foreign.length} model(s) were left out for speaking another protocol — ${summarizeNames(models.foreign, 4)}`,
			);
		}
		if (models.silent.length > 0) {
			extras.push(
				`${models.silent.length} model(s) name no protocol and were left out — ${summarizeNames(models.silent, 4)}`,
			);
		}
		if (models.unapplied.length > 0) {
			extras.push(`not carried: ${summarizeNames(models.unapplied, 4)}`);
		}
		if (typeof value.name === "string" && value.name.trim() !== "") {
			extras.push(`its display name "${value.name.trim()}" has no field here, where a provider is named by its id`);
		}
		if (value.headers !== undefined || value.compat !== undefined || value.authHeader !== undefined) {
			extras.push("its own headers, protocol-compat block or auth-header switch have no counterpart here");
		}
		specs.push(spec);
		newIds.set(key, id);
		items.push({
			source: "step-code",
			from: label,
			to: `settings.json → providers.openaiCompatible[${id}] (${models.entries.length} model(s))`,
			action: "map",
			detail: extras.length > 0 ? extras.join("; ") : "its endpoint and model list copied",
			containsSecret: false,
		});
	}
	return { specs, items };
}

/** Keys of one `[mcp_servers.<name>]` table this build's server shape can hold. */
const STEP_MCP_CARRIED = new Set([
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"http_headers",
	"bearer_token_env_var",
	"env_http_headers",
	"enabled",
	"startup_timeout_sec",
	"tool_timeout_sec",
	"enabled_tools",
	"disabled_tools",
	"oauth",
]);

/**
 * One `[mcp_servers.<name>]` table → this build's server shape.
 *
 * Step picks the transport the way Codex does — `command` first, and `url`
 * second (`mcp.ts:277-299`) — and its table is wider than the two shapes here.
 * Everything that does not fit is a named downgrade rather than a silent drop:
 *
 *   - `bearer_token_env_var` and `env_http_headers` name *variables* whose
 *     values Step expands into a header; a header value here is the literal
 *     text, so neither can be carried. Names only: no value is read.
 *   - `startup_timeout_sec` and `tool_timeout_sec`: this build has one connect
 *     timeout and no per-call one.
 *   - `enabled_tools` / `disabled_tools`: a filter Step applies to the tools a
 *     server advertises. Here a server's tools are all of them.
 *   - `oauth`: a client registration Step keeps in its own credential store.
 *   - a stdio field on an http server, or the reverse.
 *
 * `enabled = false` is not a downgrade but a refusal: this build has no way to
 * keep a definition while it is switched off, and writing the server anyway
 * would connect the next session to something the user had turned off.
 */
function normalizeStepMcp(
	entry: Record<string, unknown>,
): { config: Record<string, unknown>; downgrades: string[] } | null {
	const downgrades: string[] = [];
	const url = typeof entry.url === "string" ? entry.url.trim() : "";
	if (typeof entry.command === "string" && entry.command.trim() !== "") {
		const out: Record<string, unknown> = {
			type: "stdio",
			command: entry.command,
			args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [],
		};
		if (isRecord(entry.env)) out.env = entry.env;
		if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") out.cwd = entry.cwd;
		for (const key of ["url", "http_headers", "bearer_token_env_var", "env_http_headers"] as const) {
			if (entry[key] !== undefined) downgrades.push(`it also carries ${key}, which only an http server uses`);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	if (url !== "") {
		const out: Record<string, unknown> = { type: "http", url };
		if (isRecord(entry.http_headers)) out.headers = entry.http_headers;
		for (const key of ["command", "args", "env", "cwd"] as const) {
			if (entry[key] !== undefined) downgrades.push(`it also carries ${key}, which only a stdio server uses`);
		}
		if (typeof entry.bearer_token_env_var === "string" && entry.bearer_token_env_var.trim() !== "") {
			downgrades.push(
				`it authenticates with a bearer token read from $${entry.bearer_token_env_var.trim()} — a header value here is the ` +
					"literal text, so the Authorization header was not copied; set it yourself once the token is in place",
			);
		}
		const envHeaders = isRecord(entry.env_http_headers) ? Object.keys(entry.env_http_headers) : [];
		if (envHeaders.length > 0) {
			downgrades.push(
				`${summarizeNames(envHeaders)} would be filled from ${summarizeNames(
					Object.values(entry.env_http_headers as Record<string, unknown>).map((name) => `$${String(name)}`),
				)} over there, and a header here is the literal text — set them yourself`,
			);
		}
		const placeholder = placeholderNote(out);
		if (placeholder) downgrades.push(placeholder);
		return { config: out, downgrades };
	}
	return null;
}

/**
 * The `[mcp_servers.<name>]` keys with nowhere to go, named once for the server.
 *
 * A table this build can carry as-is is a plain copy; the keys below are the
 * ones whose absence changes what the server does, so each is named rather than
 * left to the reader to notice.
 */
function stepMcpNotes(entry: Record<string, unknown>, downgrades: string[]): void {
	if (typeof entry.startup_timeout_sec === "number") {
		downgrades.push(
			`it is given ${entry.startup_timeout_sec}s to start, and this build has one connect timeout for every server`,
		);
	}
	if (typeof entry.tool_timeout_sec === "number") {
		downgrades.push(`it is given ${entry.tool_timeout_sec}s per tool call, and this build has no per-call timeout`);
	}
	const enabled = Array.isArray(entry.enabled_tools) ? entry.enabled_tools.length : 0;
	const disabled = Array.isArray(entry.disabled_tools) ? entry.disabled_tools.length : 0;
	if (enabled > 0 || disabled > 0) {
		downgrades.push(
			`it filters its own tools (${[enabled > 0 ? `${enabled} enabled` : "", disabled > 0 ? `${disabled} disabled` : ""]
				.filter(Boolean)
				.join(", ")}), and every tool a server advertises is available here`,
		);
	}
	if (isRecord(entry.oauth)) {
		downgrades.push(
			"it registers an OAuth client, which this build has no store for — you will have to authorize it there",
		);
	}
	const extra = Object.keys(entry).filter((key) => !STEP_MCP_CARRIED.has(key));
	if (extra.length > 0) {
		downgrades.push(`${summarizeNames(extra)} has no counterpart here`);
	}
}

/** Text the CLI and the report use for a source whose settings document is one TOML file. */
const STEP_UNMIGRATED_KEYS: Array<[key: string, reason: string]> = [
	["defaultThinkingLevel", "a thinking level this build has no setting for"],
	["transport", "which transport the model client uses; this build picks its own"],
	["compat", "a Pi compatibility block for extensions this build does not load"],
	["extensions", "Pi extensions, which this build has no loader for"],
	["packages", "Pi packages, the same"],
	["enabledModels", "a model-picker allow-list, which this build has no picker setting for"],
	["defaultTools", "a default tool set, which this build's sessions decide for themselves"],
];

/**
 * `config.toml` — the live settings document — and `models.json`.
 *
 * The order follows the file where it can: the provider table is built first so
 * a default model naming one can be rewritten to the id that provider is
 * registered under, and reported after the model for the same reason MiniMax's
 * planner reports it that way.
 *
 * Two documents are named and not read. `settings.json` is the retired Pi
 * settings file (`docs/step-configuration.md:13-15`) and `step-settings.json`
 * its sibling; a key that lives only in either is a key this Step build no
 * longer honours, which is exactly why they get a line rather than silence.
 */
export function planStepCode(
	raw: RawStepCode,
	home: string,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	const from = tildePath(home, stepConfigPath(raw.root));
	const config = raw.config;
	if (raw.configError !== undefined) {
		items.push({
			source: "step-code",
			from,
			to: "—",
			action: "skip",
			detail: `${raw.configError} — nothing in this file was read, so this report is missing whatever it held`,
			containsSecret: false,
		});
	}
	// A key path this parser had to requote to read the document at all (a model
	// id with a dot in it, written bare) is named: the file on disk still holds
	// the unquoted spelling, which is what the user will go looking for.
	if (raw.configDottedKeys.length > 0) {
		items.push({
			source: "step-code",
			from: `${from} → ${summarizeNames(raw.configDottedKeys, 6)}`,
			to: "—",
			action: "skip",
			detail:
				"key paths whose dotted segments had to be requoted to parse this document, as the grok reader does with its own — " +
				"the file keeps the spelling it was written in",
			containsSecret: false,
		});
	}

	// ── models.json ──────────────────────────────────────────────────────────
	const modelsFrom =
		raw.modelsPath === null ? `${tildePath(home, raw.root)} → models.json` : tildePath(home, raw.modelsPath);
	if (raw.modelsError !== undefined) {
		items.push({
			source: "step-code",
			from: modelsFrom,
			to: "—",
			action: "skip",
			detail: `${raw.modelsError} — no provider in it was registered`,
			containsSecret: false,
		});
	}
	if (raw.otherModelsPath !== null) {
		items.push({
			source: "step-code",
			from: tildePath(home, raw.otherModelsPath),
			to: "—",
			action: "skip",
			detail:
				"the agent directory's own models.json, which is Step's older location for the file beside config.toml — the document " +
				"this build reads is the one its CLI hands its model registry, and a second table of providers would register " +
				"endpoints from a file that may no longer be read",
			containsSecret: false,
		});
	}
	const newIds = new Map<string, string>();
	const providers = planStepProviders(raw, `${modelsFrom} → providers`, newIds, existing, force);

	// ── defaultProvider / defaultModel ───────────────────────────────────────
	const providerName = typeof config.defaultProvider === "string" ? config.defaultProvider.trim() : "";
	const modelName = typeof config.defaultModel === "string" ? config.defaultModel.trim() : "";
	if (modelName !== "") {
		const label =
			providerName === ""
				? `${from} → defaultModel ("${modelName}")`
				: `${from} → defaultModel ("${modelName}") with defaultProvider ("${providerName}")`;
		// Step keeps the provider and the model as two settings, where a reference
		// here is one string. A provider this run imported is rewritten to the id it
		// lands under; a provider it did not is not resolved through the registry —
		// the registry answers for labunbun's own models, not for a name only Step
		// knows.
		const renamed = providerName === "" ? undefined : newIds.get(providerName);
		const known =
			renamed === undefined
				? undefined
				: (providers.specs.find((spec) => spec.id === renamed)?.models as Array<{ id?: string }> | undefined)?.some(
						(model) => model.id === modelName,
					);
		if (renamed !== undefined && known === true) {
			claimScalar(
				"step-code",
				"model",
				`${renamed}/${modelName}`,
				label,
				`mapped to "${renamed}/${modelName}", the same model under the id your provider is imported as`,
			);
		} else if (renamed !== undefined && known === false) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: `your provider "${providerName}" does not list a model called "${modelName}", so the reference would point at nothing here`,
				containsSecret: false,
			});
		} else if (providerName !== "" && Object.hasOwn(raw.providers, providerName)) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: `it names your provider "${providerName}", which this run did not import — see its own line above`,
				containsSecret: false,
			});
		} else if (providerName !== "") {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: `it names a provider that is not in models.json, so the model it selects was served by something else — ${JSON.stringify(
					providerName,
				)} is not a provider this build registers`,
				containsSecret: false,
			});
		} else {
			// No provider named: this build's registry is the right question after all.
			const resolved = resolveModelReference(modelName);
			if (resolved !== undefined) {
				claimScalar("step-code", "model", resolved, label, `mapped to "${resolved}"`);
			} else {
				items.push({
					source: "step-code",
					from: label,
					to: "—",
					action: "skip",
					detail: "no model of that name exists here, so importing it would leave settings.json pointing at nothing",
					containsSecret: false,
				});
			}
		}
	} else if (providerName !== "") {
		items.push({
			source: "step-code",
			from: `${from} → defaultProvider ("${providerName}")`,
			to: "—",
			action: "skip",
			detail:
				"a provider with no model chosen for it — this build's model setting names a model, and the provider is the part " +
				"before the slash, so there is nothing here to write a reference out of",
			containsSecret: false,
		});
	}

	// ── permission posture, theme ────────────────────────────────────────────
	planStepPermissionMode(raw, home, items, claimScalar);

	const theme = typeof config.theme === "string" ? config.theme.trim() : "";
	if (theme !== "") {
		const label = `${from} → theme ("${theme}")`;
		if (raw.themeNames.includes(theme)) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"it names a theme file of your own under the agent directory — Step's themes are a `vars`/`colors` palette " +
					"and this build's are semantic tokens, so the file was not converted and the name would not resolve here",
				containsSecret: false,
			});
		} else if (BUILT_IN_THEME_NAMES.includes(theme)) {
			claimScalar("step-code", "theme", theme, label, `mapped to the built-in theme of the same name`);
		} else {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					`no built-in theme here has that name — this build ships ${summarizeNames([...BUILT_IN_THEME_NAMES], 8)} — and no ` +
					`theme file under your agent directory is named that either: a theme of your own is named by the "name" inside the ` +
					"file rather than by the file's own name",
				containsSecret: false,
			});
		}
	}

	// ── mcp_servers ──────────────────────────────────────────────────────────
	const servers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
	for (const [name, value] of Object.entries(servers)) {
		const label = `${from} → mcp_servers.${name}`;
		if (!isRecord(value)) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "not a server table",
				containsSecret: false,
			});
			continue;
		}
		if (value.enabled === false) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail:
					"switched off in config.toml, and this build has no way to keep a server's definition while it is disabled — " +
					"importing it would connect every later session to a server you had turned off",
				containsSecret: false,
			});
			continue;
		}
		const normalized = normalizeStepMcp(value);
		if (normalized === null) {
			items.push({
				source: "step-code",
				from: label,
				to: "—",
				action: "skip",
				detail: "it names neither a command nor a url, so Step has nothing to connect either",
				containsSecret: false,
			});
			continue;
		}
		stepMcpNotes(value, normalized.downgrades);
		if (name in existingMcpServers && !force) {
			items.push({
				source: "step-code",
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
			source: "step-code",
			from: label,
			to: `.mcp.json → mcpServers.${name}`,
			action: normalized.downgrades.length > 0 ? "downgrade" : "map",
			detail: normalized.downgrades.length > 0 ? `${copied} — ${normalized.downgrades.join("; ")}` : copied,
			containsSecret: secret,
		});
	}

	// ── the retired documents ────────────────────────────────────────────────
	if (raw.settingsError !== undefined) {
		items.push({
			source: "step-code",
			from: tildePath(home, join(raw.agentDir, "settings.json")),
			to: "—",
			action: "skip",
			detail: `${raw.settingsError} — and the file is retired in any case, so nothing in it decided anything`,
			containsSecret: false,
		});
	} else if (Object.keys(raw.settings).length > 0) {
		items.push({
			source: "step-code",
			from: tildePath(home, join(raw.agentDir, "settings.json")),
			to: "—",
			action: "skip",
			detail:
				`retired: this Step build no longer reads it (${Object.keys(raw.settings).length} key(s), ` +
				`${summarizeNames(Object.keys(raw.settings), 6)}) — the settings document it uses is config.toml, and its own notes say ` +
				"to move what matters there",
			containsSecret: false,
		});
	}
	if (raw.stepSettingsPresent) {
		items.push({
			source: "step-code",
			from: tildePath(home, join(raw.agentDir, "step-settings.json")),
			to: "—",
			action: "skip",
			detail: "retired in the same sentence as settings.json, and not read here either",
			containsSecret: false,
		});
	}

	// ── sections with no counterpart ─────────────────────────────────────────
	for (const [key, reason] of STEP_UNMIGRATED_KEYS) {
		if (config[key] === undefined) continue;
		items.push({
			source: "step-code",
			from: `${from} → ${key}`,
			to: "—",
			action: "skip",
			detail: reason,
			containsSecret: false,
		});
	}
	if (config.telemetry !== undefined) {
		items.push({
			source: "step-code",
			from: `${from} → telemetry`,
			to: "—",
			action: "skip",
			detail:
				"where Step sends its own usage reports — a switch about the vendor's service, not a preference of this build",
			containsSecret: false,
		});
	}
	const tools = isRecord(config.tools) ? config.tools : {};
	reportUnhandledKeys("step-code", tools, new Set(["approval"]), `${from} → tools`, items);

	mergeProviderSpecs(
		"step-code",
		providers.specs,
		(id) => `${modelsFrom} → providers.${id.replace(/^step-/, "")}`,
		items,
		settingsPatch,
		existing,
		force,
	);
	for (const item of providers.items) items.push(item);

	reportUnhandledKeys(
		"step-code",
		config,
		new Set<string>([
			"mcp_servers",
			"permissionPreset",
			"permissionMode",
			"approvalMode",
			"approval",
			"tools",
			"autoResume",
			"autopilot",
			"nonInteractiveApproval",
			"noninteractiveApproval",
			"feedbackEnabled",
			"feedback",
			"defaultProvider",
			"defaultModel",
			"theme",
			...STEP_UNMIGRATED_KEYS.map(([key]) => key),
		]),
		from,
		items,
	);
}

/**
 * Step's assets: skills, agents, prompts, the two system-prompt documents, and
 * everything under the tree that this importer names rather than reads.
 *
 * The plugins' own resources travel with the user's, each carrying the plugin
 * it came from (`withStepPluginOrigin`, set at read time) — Step loads a plugin
 * by giving its declared directories to the same resource loader the user's own
 * directories go through (`core/package-manager.ts`), so on that side they are
 * one set of skills and one set of agents, not two tiers.
 */
export function planStepAssets(
	raw: RawStepCode,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	/** A path under the tree or the agent directory, rendered the way the report renders paths. */
	const at = (path: string): string => tildePath(home, path);
	const agentAt = (name: string): string => at(join(raw.agentDir, name));

	if (raw.legacy) {
		items.push({
			source: "step-code",
			from: at(raw.root),
			to: "—",
			action: "skip",
			detail:
				"the tree this run read, under the name Step Code used before its rename: Step itself reaches it in two narrow places " +
				"(importing a credential, and copying a session into the canonical tree), so a user who never launched the renamed " +
				"build keeps everything here — which is why it was read rather than skipped",
			containsSecret: false,
		});
	}

	collectFileWrites(
		"step-code",
		[...raw.skills, ...raw.pluginSkills],
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		"step-code",
		[...raw.agents, ...raw.pluginAgents],
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	const promptFiles = [...raw.prompts.files, ...raw.pluginPrompts.flatMap((prompts) => prompts.files)];
	const promptSkips = [...raw.prompts.skips, ...raw.pluginPrompts.flatMap((prompts) => prompts.skips)];
	planCommands(
		"step-code",
		{ files: promptFiles, skips: promptSkips },
		raw.pluginPrompts.length > 0 ? `${agentAt("prompts")} (and each plugin's commands/)` : `${agentAt("prompts")}`,
		home,
		force,
		items,
		writes,
	);

	// ── the system prompt documents ──────────────────────────────────────────
	// Step prepends `<agentDir>/SYSTEM.md` to the system prompt and appends
	// `APPEND_SYSTEM.md` to it. Here both become rule files, which are loaded as
	// a section of the system prompt: the text is the user's either way, and the
	// half worth stating is which of the two roles it plays.
	if (raw.systemPrompt?.trim()) {
		planMemoryAsRule(
			"step-code",
			agentAt("SYSTEM.md"),
			home,
			raw.systemPrompt,
			"imported-step-code.md",
			force,
			items,
			writes,
		);
	}
	if (raw.appendSystemPrompt?.trim()) {
		planMemoryAsRule(
			"step-code",
			agentAt("APPEND_SYSTEM.md"),
			home,
			raw.appendSystemPrompt,
			"imported-step-code-append.md",
			force,
			items,
			writes,
		);
	}
	// Only when something was actually imported: the sentence is about where the
	// text landed, and a file holding nothing but whitespace has no text to land.
	if (raw.systemPrompt?.trim() || raw.appendSystemPrompt?.trim()) {
		items.push({
			source: "step-code",
			from: `${agentAt("SYSTEM.md")} + ${agentAt("APPEND_SYSTEM.md")}`,
			to: "—",
			action: "skip",
			detail:
				"the text of both was imported; what differs is where it lands — Step splices the first into its own system prompt and " +
				"appends the second, where a rule file here is a memory section of the system prompt, loaded alongside the project's " +
				"own files rather than in place of them",
			containsSecret: false,
		});
	}

	// ── themes ───────────────────────────────────────────────────────────────
	if (raw.themeFiles.length > 0 || raw.extraThemePaths.length > 0) {
		items.push({
			source: "step-code",
			from: [
				raw.themeFiles.length > 0 ? `${agentAt("themes")} (${summarizeNames(raw.themeFiles, 6)})` : "",
				...raw.extraThemePaths.map((path) => at(path)),
			]
				.filter(Boolean)
				.join(", "),
			to: "—",
			action: "skip",
			detail:
				`${raw.themeFiles.length + raw.extraThemePaths.length} theme file(s), not converted: a Step theme is a table of named ` +
				"`vars` plus a `colors` map from that vocabulary onto the terminal's, where a theme file here is a flat `tokens` table " +
				"validated against this build's own token names — the two overlap (text, muted, success, warning, error, accent, " +
				"border, toolOutput, diff colours) and diverge everywhere else, so a conversion would drop the rest without a line " +
				"each. Copy the colours across into `~/.labunbun/themes/<name>.json` if you want the theme back",
			containsSecret: false,
		});
	}

	// ── entries with no directory to read ────────────────────────────────────
	if (raw.extraPatterns.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(stepConfigPath(raw.root))} → ${summarizeNames(raw.extraPatterns, 6)}`,
			to: "—",
			action: "skip",
			detail:
				"glob entries among the resource paths (`!`/`+`/`-` prefixed, or holding `*`/`?`): they select among files Step " +
				"collected from the directories above, and a selection rule over a set that does not exist here has nothing to select",
			containsSecret: false,
		});
	}
	if (raw.pluginNames.length > 0) {
		const extras: string[] = [];
		if (raw.pluginMcp.length > 0) {
			extras.push(`declaring MCP servers (${summarizeNames(raw.pluginMcp)})`);
		}
		if (raw.pluginCode.length > 0) {
			extras.push(`shipping code (${summarizeNames(raw.pluginCode)})`);
		}
		items.push({
			source: "step-code",
			from: `${at(join(raw.root, "plugins"))} (${summarizeNames(raw.pluginNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				`${raw.pluginNames.length} installed plugin(s): their skills, agents and commands were imported above, and what is ` +
				`left behind is the part that has no equivalent here — ${
					extras.length > 0 ? extras.join(", and ") : "their manifests"
				}; a plugin's code runs inside Step, and this build has no plugin host to run it in`,
			containsSecret: false,
		});
	}
	if (raw.pluginErrors.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(join(raw.root, "plugins"))} (${summarizeNames(raw.pluginErrors)})`,
			to: "—",
			action: "skip",
			detail: "plugin manifests that could not be read as JSON, so nothing they declare was taken",
			containsSecret: false,
		});
	}
	if (raw.marketplaceNames.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(join(raw.root, "marketplaces"))} (${summarizeNames(raw.marketplaceNames, 8)})`,
			to: "—",
			action: "skip",
			detail:
				"marketplace checkouts — a local copy of each catalogue you browsed, kept current by Step's own updater; the plugins " +
				"installed *from* them were read above",
			containsSecret: false,
		});
	}

	// ── state, credentials, and the rest of the tree ─────────────────────────
	if (raw.stateFiles.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(raw.root)}/${raw.stateFiles.join(", ")}`,
			to: "—",
			action: "skip",
			detail: raw.stateFiles
				.map((name) => STEP_STATE_FILES[leafName(name)])
				.filter((reason) => reason !== undefined)
				.join("; "),
			containsSecret: false,
		});
	}
	if (raw.credentialFiles.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(raw.root)}/${raw.credentialFiles.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				"credential-shaped entries reported by name and never opened — no value in them was read, and none is carried",
			containsSecret: false,
		});
	}
	if (raw.otherDirs.length > 0) {
		items.push({
			source: "step-code",
			from: raw.otherDirs.map((entry) => `${at(join(raw.root, entry.name))} (${entry.count})`).join(", "),
			to: "—",
			action: "skip",
			detail: "no mapping here for these, so they were left where they are",
			containsSecret: false,
		});
	}
	if (raw.agentOtherDirs.length > 0) {
		items.push({
			source: "step-code",
			from: raw.agentOtherDirs.map((entry) => `${at(join(raw.agentDir, entry.name))} (${entry.count})`).join(", "),
			to: "—",
			action: "skip",
			detail:
				"directories under the agent directory this importer reads nothing out of: `extensions` and `tools` are code Step " +
				"loads at startup, and the rest are its own working state",
			containsSecret: false,
		});
	}
	if (raw.otherFiles.length > 0) {
		items.push({
			source: "step-code",
			from: `${at(raw.root)}/${raw.otherFiles.join(", ")}`,
			to: "—",
			action: "skip",
			detail:
				"files at the tree's root that are neither settings, state nor credentials — no mapping here for them, so they were " +
				"left where they are",
			containsSecret: false,
		});
	}

	// A working directory's own Step resources are outside this planner's reach,
	// and saying so is the point: `.stepcode/skills` and `.stepcode/agents` look
	// like this source's, so a user who does not find them mentioned reads the
	// silence as a bug. `findNearestProjectAgentsDir` walks up from the working
	// directory, which is a rule about a repository rather than about this tree.
	items.push({
		source: "step-code",
		from: `each working directory's own ${stepConfigDirName()}/{skills,prompts,themes,agents}`,
		to: "—",
		action: "skip",
		detail:
			"a project's resources live beside the project rather than under this tree, so this importer neither reads nor moves " +
			"them — Step finds them by walking up from the working directory, and the project that owns them travels with them",
		containsSecret: false,
	});
}
