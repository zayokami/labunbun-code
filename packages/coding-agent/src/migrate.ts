/**
 * Import an existing agent-tool setup into labunbun's own configuration.
 *
 * Two source layouts are recognised, both user-scope only:
 *   claude-code  ~/.claude/settings.json, ~/.claude.json, ~/.claude/skills,
 *                ~/.claude/rules
 *   codex        ~/.codex/config.toml, ~/.codex/AGENTS.md, ~/.codex/skills
 *
 * Structure: read (I/O) → plan (pure) → apply (I/O). The planning step is where
 * every mapping decision lives, so the decisions are testable without touching
 * a real home directory, and `--apply` has nothing to decide.
 *
 * Two invariants hold throughout:
 * - Sources are read, never written. A migration cannot damage the setup it is
 *   importing from, so re-running it is always safe.
 * - Nothing is written without `apply: true`. The default run reports what it
 *   would do and returns.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveModel } from "@labunbun/ai";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { mergeSettings, type RawSettingsInput, SettingsSchema } from "./settings.ts";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type MigrationSourceId = "claude-code" | "codex";

export const MIGRATION_SOURCE_IDS: MigrationSourceId[] = ["claude-code", "codex"];

/** Directory that marks a source as present, relative to home. */
const SOURCE_ROOTS: Record<MigrationSourceId, string> = {
	"claude-code": ".claude",
	codex: ".codex",
};

export function detectSources(home: string): MigrationSourceId[] {
	return MIGRATION_SOURCE_IDS.filter((id) => existsSync(join(home, SOURCE_ROOTS[id])));
}

// ---------------------------------------------------------------------------
// Raw source data
// ---------------------------------------------------------------------------

/** A skill or rule file found in a source tree, carried as content. */
export interface RawFile {
	/** Name used to build the target path: skill directory name, or rule filename. */
	name: string;
	sourcePath: string;
	content: string;
}

export interface RawClaudeCode {
	/** ~/.claude/settings.json */
	settings: Record<string, unknown>;
	/** ~/.claude.json — mostly runtime state; only a few keys are migratable. */
	state: Record<string, unknown>;
	skills: RawFile[];
	rules: RawFile[];
	present: boolean;
}

export interface RawCodex {
	/** Parsed ~/.codex/config.toml */
	config: Record<string, unknown>;
	/** ~/.codex/AGENTS.md, when it exists. */
	memory: string | null;
	skills: RawFile[];
	present: boolean;
}

export interface RawSources {
	home: string;
	claudeCode: RawClaudeCode;
	codex: RawCodex;
}

function readJson(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// A malformed source file migrates nothing rather than aborting the run:
		// the other sources are still worth importing.
		return {};
	}
}

function readText(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

/** Skill directories, each contributing its SKILL.md. */
function readSkillDirs(skillsRoot: string): RawFile[] {
	const out: RawFile[] = [];
	try {
		if (!existsSync(skillsRoot)) return out;
		for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(skillsRoot, entry.name, "SKILL.md");
			const content = readText(path);
			if (content !== null) out.push({ name: entry.name, sourcePath: path, content });
		}
	} catch {
		// unreadable skills dir — contributes nothing
	}
	return out;
}

function readMarkdownDir(dir: string): RawFile[] {
	const out: RawFile[] = [];
	try {
		if (!existsSync(dir)) return out;
		for (const name of readdirSync(dir).sort()) {
			if (!name.endsWith(".md")) continue;
			const path = join(dir, name);
			if (!statSync(path).isFile()) continue;
			const content = readText(path);
			if (content !== null) out.push({ name, sourcePath: path, content });
		}
	} catch {
		// unreadable rules dir — contributes nothing
	}
	return out;
}

export function readClaudeCode(home: string): RawClaudeCode {
	const root = join(home, ".claude");
	return {
		settings: readJson(join(root, "settings.json")),
		state: readJson(join(home, ".claude.json")),
		skills: readSkillDirs(join(root, "skills")),
		rules: readMarkdownDir(join(root, "rules")),
		present: existsSync(root),
	};
}

export function readCodex(home: string): RawCodex {
	const root = join(home, ".codex");
	const configText = readText(join(root, "config.toml"));
	let config: Record<string, unknown> = {};
	if (configText !== null) {
		try {
			const parsed = Bun.TOML.parse(configText);
			if (typeof parsed === "object" && parsed !== null) config = parsed as Record<string, unknown>;
		} catch {
			// unparseable TOML migrates nothing from this source
		}
	}
	return {
		config,
		memory: readText(join(root, "AGENTS.md")),
		skills: readSkillDirs(join(root, "skills")),
		present: existsSync(root),
	};
}

export function readSources(home: string): RawSources {
	return { home, claudeCode: readClaudeCode(home), codex: readCodex(home) };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * `map` — carried over as-is.
 * `downgrade` — carried over with a semantic loss, explained in `detail`.
 * `skip` — deliberately not carried over; `detail` says why.
 *
 * Skips are reported rather than dropped silently. A setting that vanishes
 * without explanation reads as a migration bug, and the user cannot tell the
 * difference between "labunbun has no equivalent" and "the importer missed it".
 */
export type MigrationAction = "map" | "downgrade" | "skip";

export interface MigrationItem {
	source: MigrationSourceId;
	/** Human-readable origin, e.g. "~/.claude/settings.json → env.ANTHROPIC_BASE_URL". */
	from: string;
	/** Human-readable destination, or "—" for skips. */
	to: string;
	action: MigrationAction;
	detail: string;
	/** Whether the migrated value is a credential, for the report's secrets notice. */
	containsSecret: boolean;
}

/** File writes the plan would perform, keyed by absolute target path. */
export interface PlannedWrite {
	path: string;
	kind: "settings" | "mcp" | "skill" | "rule" | "memory";
	/** Full file content to write. */
	content: string;
	/** True when `content` embeds a credential. */
	containsSecret: boolean;
}

export interface MigrationPlan {
	home: string;
	sources: MigrationSourceId[];
	items: MigrationItem[];
	writes: PlannedWrite[];
}

export interface PlanOptions {
	/** Which sources to consider; defaults to all detected. */
	only?: MigrationSourceId[];
	/** Overwrite values and files that already exist at the target. */
	force?: boolean;
}

/**
 * Environment variables whose values are credentials rather than configuration.
 * Drives the report's closing notice about which written files hold secrets;
 * matched case-insensitively as a substring so `*_API_KEY` variants are covered.
 */
const SECRET_ENV_MARKERS = ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL"];

export function looksLikeSecretName(name: string): boolean {
	const upper = name.toUpperCase();
	return SECRET_ENV_MARKERS.some((marker) => upper.includes(marker));
}

/**
 * Short model aliases → labunbun model references.
 *
 * Source tools accept a family alias where labunbun wants a `provider/id`
 * reference. Each target is verified against the registry during planning, so an
 * alias pointing at a model this build doesn't carry becomes a reported skip
 * rather than an unusable `model` value written into settings.
 */
const MODEL_ALIASES: Record<string, string> = {
	opus: "anthropic/claude-opus-5",
	sonnet: "anthropic/claude-sonnet-5",
	haiku: "anthropic/claude-haiku-4-5",
	fable: "anthropic/claude-fable-5",
};

/** Resolve a source `model` value to a reference labunbun can actually load. */
export function resolveModelReference(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const alias = MODEL_ALIASES[trimmed.toLowerCase()];
	const candidates = alias ? [alias, trimmed] : [trimmed];
	for (const candidate of candidates) {
		if (resolveModel(candidate)) return candidate;
	}
	return undefined;
}

/** Keys in the source state file that are telemetry or runtime bookkeeping. */
const STATE_TELEMETRY_KEYS = new Set(["projects", "tipsHistory", "promptQueueUseCount", "cachedChangelog"]);

function targetSettingsPath(home: string): string {
	return join(home, ".labunbun", "settings.json");
}

function targetMcpPath(home: string): string {
	return join(home, ".labunbun", ".mcp.json");
}

/**
 * Decide everything the migration would do.
 *
 * `existing` is the current user-scope settings — needed because conflicts
 * default to keeping the value already there. Without it the importer would
 * silently overwrite configuration the user set up deliberately.
 */
export function planMigration(raw: RawSources, existing: RawSettingsInput, options: PlanOptions = {}): MigrationPlan {
	const only = options.only ?? detectSources(raw.home);
	const force = options.force === true;
	const items: MigrationItem[] = [];
	const writes: PlannedWrite[] = [];

	// Settings accumulated across sources, applied as one merge at the end.
	const settingsPatch: Record<string, unknown> = {};
	const env: Record<string, string> = {};
	const mcpServers: Record<string, unknown> = {};
	let mcpHasSecret = false;

	// The MCP config is a separate file from settings, so it gets its own read:
	// the file is rewritten whole, and without the current contents an import
	// would drop every server the user had configured themselves.
	const existingMcp = readJson(targetMcpPath(raw.home));
	const existingMcpServers =
		typeof existingMcp.mcpServers === "object" &&
		existingMcp.mcpServers !== null &&
		!Array.isArray(existingMcp.mcpServers)
			? (existingMcp.mcpServers as Record<string, unknown>)
			: {};

	/** Claim a scalar settings key, respecting an existing value unless forced. */
	const claimScalar = (
		source: MigrationSourceId,
		key: "model" | "theme",
		value: string,
		from: string,
		detail: string,
	): void => {
		const current = (existing as Record<string, unknown>)[key];
		if (current !== undefined && !force) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `target already sets ${key} to "${String(current)}" — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			return;
		}
		settingsPatch[key] = value;
		items.push({ source, from, to: `settings.json → ${key}`, action: "map", detail, containsSecret: false });
	};

	/** Claim one env var, respecting an existing value unless forced. */
	const claimEnv = (source: MigrationSourceId, name: string, value: string, from: string): void => {
		const current = existing.env?.[name];
		const secret = looksLikeSecretName(name);
		if (current !== undefined && current !== value && !force) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `target already sets env.${name} — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			return;
		}
		// Later sources win among themselves; first-wins would make the outcome
		// depend on source ordering in a way the report doesn't show.
		env[name] = value;
		items.push({
			source,
			from,
			to: `settings.json → env.${name}`,
			action: "map",
			detail: secret ? "credential copied verbatim" : "copied verbatim",
			containsSecret: secret,
		});
	};

	if (only.includes("claude-code") && raw.claudeCode.present) {
		planClaudeCode(
			raw.claudeCode,
			items,
			claimEnv,
			claimScalar,
			mcpServers,
			(hasSecret) => {
				mcpHasSecret = mcpHasSecret || hasSecret;
			},
			settingsPatch,
			existing,
			existingMcpServers,
			force,
		);
		collectFileWrites(
			"claude-code",
			raw.claudeCode.skills,
			(name) => join(raw.home, ".labunbun", "skills", name, "SKILL.md"),
			"skill",
			force,
			items,
			writes,
			raw.home,
		);
		collectFileWrites(
			"claude-code",
			raw.claudeCode.rules,
			(name) => join(raw.home, ".labunbun", "rules", name),
			"rule",
			force,
			items,
			writes,
			raw.home,
		);
	}

	if (only.includes("codex") && raw.codex.present) {
		planCodex(raw.codex, items, claimScalar, settingsPatch, existing, force);
		collectFileWrites(
			"codex",
			raw.codex.skills,
			(name) => join(raw.home, ".labunbun", "skills", name, "SKILL.md"),
			"skill",
			force,
			items,
			writes,
			raw.home,
		);
		if (raw.codex.memory?.trim()) {
			planCodexMemory(raw.home, raw.codex.memory, force, items, writes);
		}
	}

	if (Object.keys(env).length > 0) settingsPatch.env = env;

	if (Object.keys(settingsPatch).length > 0) {
		const merged = mergeSettings(existing as Record<string, unknown>, settingsPatch);
		writes.push({
			path: targetSettingsPath(raw.home),
			kind: "settings",
			content: `${JSON.stringify(merged, null, "\t")}\n`,
			containsSecret: Object.keys(env).some(looksLikeSecretName),
		});
	}

	if (Object.keys(mcpServers).length > 0) {
		writes.push({
			path: targetMcpPath(raw.home),
			kind: "mcp",
			// Merged with what's already on disk — imported servers are added
			// alongside the user's own rather than replacing the file.
			content: `${JSON.stringify({ mcpServers: { ...existingMcpServers, ...mcpServers } }, null, "\t")}\n`,
			containsSecret: mcpHasSecret,
		});
	}

	return { home: raw.home, sources: only, items, writes };
}

type ClaimEnv = (source: MigrationSourceId, name: string, value: string, from: string) => void;
type ClaimScalar = (
	source: MigrationSourceId,
	key: "model" | "theme",
	value: string,
	from: string,
	detail: string,
) => void;

function planClaudeCode(
	raw: RawClaudeCode,
	items: MigrationItem[],
	claimEnv: ClaimEnv,
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	// env: the settings file first, then the state file. Both hold the same kind
	// of values and either may carry the proxy credentials.
	for (const [file, container] of [
		["~/.claude/settings.json", raw.settings],
		["~/.claude.json", raw.state],
	] as const) {
		const envBlock = container.env;
		if (typeof envBlock !== "object" || envBlock === null || Array.isArray(envBlock)) continue;
		for (const [name, value] of Object.entries(envBlock as Record<string, unknown>)) {
			if (typeof value !== "string") continue;
			claimEnv("claude-code", name, value, `${file} → env.${name}`);
		}
	}

	// model alias
	const modelValue = typeof raw.settings.model === "string" ? raw.settings.model : raw.state.model;
	if (typeof modelValue === "string" && modelValue.trim()) {
		const resolved = resolveModelReference(modelValue);
		if (resolved) {
			claimScalar(
				"claude-code",
				"model",
				resolved,
				`~/.claude/settings.json → model ("${modelValue}")`,
				`resolved to ${resolved}`,
			);
		} else {
			items.push({
				source: "claude-code",
				from: `~/.claude/settings.json → model ("${modelValue}")`,
				to: "—",
				action: "skip",
				detail: "no model in the registry matches this name — set a model reference manually",
				containsSecret: false,
			});
		}
	}

	// MCP servers
	const servers = raw.state.mcpServers;
	if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
		for (const [name, config] of Object.entries(servers as Record<string, unknown>)) {
			const parsed = McpServerConfigSchema.safeParse(config);
			if (!parsed.success) {
				items.push({
					source: "claude-code",
					from: `~/.claude.json → mcpServers.${name}`,
					to: "—",
					action: "skip",
					detail: "server definition does not match the supported stdio/http shapes",
					containsSecret: false,
				});
				continue;
			}
			if (name in existingMcpServers && !force) {
				items.push({
					source: "claude-code",
					from: `~/.claude.json → mcpServers.${name}`,
					to: "—",
					action: "skip",
					detail: "target already defines a server with this name — kept (use --force to overwrite)",
					containsSecret: false,
				});
				continue;
			}
			const record = config as { headers?: Record<string, string>; env?: Record<string, string> };
			const secret =
				Object.keys(record.headers ?? {}).length > 0 ||
				Object.keys(record.env ?? {}).some((key) => looksLikeSecretName(key));
			mcpServers[name] = config;
			markMcpSecret(secret);
			items.push({
				source: "claude-code",
				from: `~/.claude.json → mcpServers.${name}`,
				to: `.mcp.json → mcpServers.${name}`,
				action: "map",
				detail: secret ? "copied verbatim, including credential headers" : "copied verbatim",
				containsSecret: secret,
			});
		}
	}

	// permissions / hooks: same rule grammar and hook shape on both sides, so
	// these carry over structurally when present.
	for (const [key, label] of [
		["permissions", "permissions"],
		["hooks", "hooks"],
	] as const) {
		if (raw.settings[key] === undefined) continue;
		const probe = SettingsSchema.safeParse({ [key]: raw.settings[key] });
		if (!probe.success) {
			items.push({
				source: "claude-code",
				from: `~/.claude/settings.json → ${label}`,
				to: "—",
				action: "skip",
				detail: "shape not accepted by the settings schema",
				containsSecret: false,
			});
			continue;
		}
		if (existing[key] !== undefined && !force) {
			items.push({
				source: "claude-code",
				from: `~/.claude/settings.json → ${label}`,
				to: "—",
				action: "skip",
				detail: `target already defines ${label} — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		settingsPatch[key] = raw.settings[key];
		items.push({
			source: "claude-code",
			from: `~/.claude/settings.json → ${label}`,
			to: `settings.json → ${label}`,
			action: "map",
			detail: "same rule grammar on both sides",
			containsSecret: false,
		});
	}

	if (raw.settings.effortLevel !== undefined) {
		items.push({
			source: "claude-code",
			from: "~/.claude/settings.json → effortLevel",
			to: "—",
			action: "skip",
			detail: "no reasoning-effort setting exists here; thinking level is chosen per request",
			containsSecret: false,
		});
	}
	if (raw.settings.enabledPlugins !== undefined) {
		items.push({
			source: "claude-code",
			from: "~/.claude/settings.json → enabledPlugins",
			to: "—",
			action: "skip",
			detail: "no plugin system here; skills and MCP servers cover the same ground",
			containsSecret: false,
		});
	}
	for (const key of Object.keys(raw.state)) {
		if (!STATE_TELEMETRY_KEYS.has(key)) continue;
		items.push({
			source: "claude-code",
			from: `~/.claude.json → ${key}`,
			to: "—",
			action: "skip",
			detail: "usage statistics and runtime bookkeeping, not configuration",
			containsSecret: false,
		});
	}
}

function planCodex(
	raw: RawCodex,
	items: MigrationItem[],
	claimScalar: ClaimScalar,
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	force: boolean,
): void {
	// Providers. `base_url` maps directly; the wire protocol may not.
	const providers = raw.config.model_providers;
	const openaiCompatible: Array<Record<string, unknown>> = [];
	if (typeof providers === "object" && providers !== null && !Array.isArray(providers)) {
		for (const [name, value] of Object.entries(providers as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			const spec = value as Record<string, unknown>;
			const baseUrl = typeof spec.base_url === "string" ? spec.base_url : undefined;
			if (!baseUrl) {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${name}`,
					to: "—",
					action: "skip",
					detail: "no base_url to point a provider at",
					containsSecret: false,
				});
				continue;
			}
			const apiKeyEnv = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
			// A provider entry with no models is still worth writing: it records the
			// endpoint and credential variable, and models can be added to it later.
			openaiCompatible.push({ id: name, baseUrl, apiKeyEnv, models: [] });
			const wireApi = typeof spec.wire_api === "string" ? spec.wire_api : undefined;
			if (wireApi && wireApi !== "chat" && wireApi !== "completions") {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${name} (wire_api="${wireApi}")`,
					to: `settings.json → providers.openaiCompatible[${name}]`,
					action: "downgrade",
					detail:
						`only the chat-completions and Anthropic messages protocols are supported, so this ` +
						`provider is registered as chat-completions; set ${apiKeyEnv} in your environment`,
					containsSecret: false,
				});
			} else {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${name}`,
					to: `settings.json → providers.openaiCompatible[${name}]`,
					action: "map",
					detail: `base_url carried over; set ${apiKeyEnv} in your environment`,
					containsSecret: false,
				});
			}
		}
	}
	if (openaiCompatible.length > 0) {
		const currentProviders = (existing.providers?.openaiCompatible ?? []) as Array<{ id?: string }>;
		const existingIds = new Set(currentProviders.map((p) => p.id));
		const additions = force ? openaiCompatible : openaiCompatible.filter((p) => !existingIds.has(p.id as string));
		for (const provider of openaiCompatible) {
			if (!force && existingIds.has(provider.id as string)) {
				items.push({
					source: "codex",
					from: `~/.codex/config.toml → model_providers.${provider.id}`,
					to: "—",
					action: "skip",
					detail: "target already defines a provider with this id — kept (use --force to overwrite)",
					containsSecret: false,
				});
			}
		}
		if (additions.length > 0) {
			const kept = force ? currentProviders.filter((p) => !additions.some((a) => a.id === p.id)) : currentProviders;
			settingsPatch.providers = { openaiCompatible: [...kept, ...additions] };
		}
	}

	// model: only meaningful if the registry (built-in or just-added provider)
	// can resolve it. A provider-scoped id needs the provider prefix.
	const model = raw.config.model;
	if (typeof model === "string" && model.trim()) {
		const provider = typeof raw.config.model_provider === "string" ? raw.config.model_provider : undefined;
		const resolved = resolveModelReference(model);
		if (resolved) {
			claimScalar("codex", "model", resolved, `~/.codex/config.toml → model ("${model}")`, `resolved to ${resolved}`);
		} else {
			items.push({
				source: "codex",
				from: `~/.codex/config.toml → model ("${model}")`,
				to: "—",
				action: "skip",
				detail: provider
					? `not in the registry — add it under providers.openaiCompatible[${provider}].models, then set model to "${provider}/${model}"`
					: "no model in the registry matches this name — set a model reference manually",
				containsSecret: false,
			});
		}
	}

	if (raw.config.model_reasoning_effort !== undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → model_reasoning_effort",
			to: "—",
			action: "skip",
			detail: "no reasoning-effort setting exists here; thinking level is chosen per request",
			containsSecret: false,
		});
	}
	if (raw.config.projects !== undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → projects.*.trust_level",
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
			from: "~/.codex/config.toml → windows.sandbox",
			to: "—",
			action: "skip",
			detail: "no OS-level sandbox setting; tool access is governed by permission rules",
			containsSecret: false,
		});
	}
	if (raw.config.tui !== undefined) {
		items.push({
			source: "codex",
			from: "~/.codex/config.toml → tui",
			to: "—",
			action: "skip",
			detail: "interface state, not configuration",
			containsSecret: false,
		});
	}
}

/**
 * Codex memory becomes a rule file rather than `MEMORY.md`.
 *
 * `MEMORY.md` is a file the user curates and may already have; dropping an
 * imported document on top of it would destroy their own notes. `rules/` is
 * additive by design and loaded with the same weight.
 */
function planCodexMemory(
	home: string,
	memory: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	const path = join(home, ".labunbun", "rules", "imported-codex.md");
	if (existsSync(path) && !force) {
		items.push({
			source: "codex",
			from: "~/.codex/AGENTS.md",
			to: "—",
			action: "skip",
			detail: "target rule file already exists — kept (use --force to overwrite)",
			containsSecret: false,
		});
		return;
	}
	writes.push({ path, kind: "rule", content: memory, containsSecret: false });
	items.push({
		source: "codex",
		from: "~/.codex/AGENTS.md",
		to: tildePath(home, path),
		action: "map",
		detail: "imported as a rule file so it merges with existing memory instead of replacing it",
		containsSecret: false,
	});
}

/**
 * Render a path the way the rest of the report does: under home with a leading
 * `~`, so an item's source and target read at the same scale. Paths outside
 * home are left alone rather than mangled into a misleading relative form.
 */
function tildePath(home: string, path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const base = home.replace(/\\/g, "/").replace(/\/+$/, "");
	return base && normalized.startsWith(`${base}/`) ? `~/${normalized.slice(base.length + 1)}` : normalized;
}

function collectFileWrites(
	source: MigrationSourceId,
	files: RawFile[],
	targetFor: (name: string) => string,
	kind: PlannedWrite["kind"],
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
	home: string,
): void {
	for (const file of files) {
		const path = targetFor(file.name);
		const from = tildePath(home, file.sourcePath);
		// An earlier source may already have claimed this exact path — two sources
		// can hold a skill of the same name. `existsSync` can't see that, since
		// nothing has been written yet during planning.
		if (writes.some((w) => w.path === path)) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `another source already provides this ${kind} — kept the first one`,
				containsSecret: false,
			});
			continue;
		}
		if (existsSync(path) && !force) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `target ${kind} already exists — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		writes.push({ path, kind, content: file.content, containsSecret: false });
		items.push({
			source,
			from,
			to: tildePath(home, path),
			action: "map",
			detail: `${kind} copied verbatim`,
			containsSecret: false,
		});
	}
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface AppliedResult {
	written: string[];
	failed: Array<{ path: string; error: string }>;
}

/**
 * Perform the plan's writes. Only reached when the caller passed `--apply`;
 * every decision was already made during planning.
 */
export function applyMigration(plan: MigrationPlan): AppliedResult {
	const written: string[] = [];
	const failed: Array<{ path: string; error: string }> = [];
	for (const write of plan.writes) {
		try {
			mkdirSync(join(write.path, ".."), { recursive: true });
			writeFileSync(write.path, write.content, "utf8");
			written.push(write.path);
		} catch (error) {
			failed.push({ path: write.path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { written, failed };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ACTION_ICON: Record<MigrationAction, string> = { map: "✓", downgrade: "!", skip: "·" };

/**
 * Render the plan for a human to check before committing to it.
 *
 * Grouped by source so the output lines up with the files the user recognises,
 * and closing with the credential-bearing targets: the values are copied
 * verbatim by design, so the user should know which files now hold them.
 */
export function formatMigrationReport(plan: MigrationPlan, applied?: AppliedResult): string {
	const lines: string[] = [];

	if (plan.sources.length === 0) {
		return "No source configuration found. Nothing to import.";
	}
	if (plan.items.length === 0) {
		return `Found ${plan.sources.join(", ")} but nothing migratable in it.`;
	}

	for (const source of plan.sources) {
		const items = plan.items.filter((item) => item.source === source);
		if (items.length === 0) continue;
		lines.push(`${source}:`);
		for (const item of items) {
			const arrow = item.action === "skip" ? "" : ` → ${item.to}`;
			lines.push(`  ${ACTION_ICON[item.action]} ${item.from}${arrow}`);
			lines.push(`      ${item.detail}`);
		}
		lines.push("");
	}

	const counts = {
		map: plan.items.filter((i) => i.action === "map").length,
		downgrade: plan.items.filter((i) => i.action === "downgrade").length,
		skip: plan.items.filter((i) => i.action === "skip").length,
	};
	lines.push(`${counts.map} mapped, ${counts.downgrade} downgraded, ${counts.skip} skipped.`);

	if (applied) {
		lines.push("");
		lines.push(applied.written.length > 0 ? `Wrote ${applied.written.length} file(s):` : "No files written.");
		for (const path of applied.written) lines.push(`  ${tildePath(plan.home, path)}`);
		for (const failure of applied.failed) {
			lines.push(`  ✗ ${tildePath(plan.home, failure.path)}: ${failure.error}`);
		}
	} else {
		lines.push("");
		lines.push(
			plan.writes.length > 0
				? `Dry run — nothing written. ${plan.writes.length} file(s) would change:`
				: "Dry run — nothing to write.",
		);
		for (const write of plan.writes) lines.push(`  ${tildePath(plan.home, write.path)}`);
		if (plan.writes.length > 0) lines.push("Re-run with --apply to write these files.");
	}

	const secretPaths = plan.writes.filter((w) => w.containsSecret).map((w) => tildePath(plan.home, w.path));
	if (secretPaths.length > 0) {
		lines.push("");
		lines.push(
			`Credentials are copied verbatim. ${applied ? "These files now contain" : "These files would contain"} secrets:`,
		);
		for (const path of secretPaths) lines.push(`  ${path}`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point shared by the CLI subcommand and the REPL command
// ---------------------------------------------------------------------------

export interface RunMigrationOptions {
	from?: string;
	apply?: boolean;
	force?: boolean;
	home?: string;
	/** Existing user-scope settings; read from disk when omitted. */
	existing?: RawSettingsInput;
}

export interface RunMigrationResult {
	report: string;
	plan: MigrationPlan;
	applied?: AppliedResult;
	/** Set when the request itself was invalid, e.g. an unknown --from value. */
	error?: string;
}

/** Resolve `--from` to a source list; `undefined`/`all` means every detected source. */
export function parseFromOption(value: string | undefined, home: string): MigrationSourceId[] | { error: string } {
	if (value === undefined || value.trim() === "" || value === "all") return detectSources(home);
	const requested = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const unknown = requested.filter((part) => !MIGRATION_SOURCE_IDS.includes(part as MigrationSourceId));
	if (unknown.length > 0) {
		return {
			error: `Unknown migration source: ${unknown.join(", ")} (expected ${MIGRATION_SOURCE_IDS.join(", ")}, all)`,
		};
	}
	return requested as MigrationSourceId[];
}

export function runMigration(options: RunMigrationOptions = {}): RunMigrationResult {
	const home = options.home ?? homedir();
	const only = parseFromOption(options.from, home);
	if ("error" in only) {
		const plan: MigrationPlan = { home, sources: [], items: [], writes: [] };
		return { report: only.error, plan, error: only.error };
	}

	const raw = readSources(home);
	const existing = options.existing ?? (readJson(targetSettingsPath(home)) as RawSettingsInput);
	const plan = planMigration(raw, existing, { only, force: options.force });

	if (!options.apply) {
		return { report: formatMigrationReport(plan), plan };
	}
	const applied = applyMigration(plan);
	return { report: formatMigrationReport(plan, applied), plan, applied };
}
