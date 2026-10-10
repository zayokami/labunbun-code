// OpenClaw's user state, as read from a home directory: the configuration after
// `$include` resolution, the agent, MCP, the credential scrub and the workspace.
// Long-form design notes: docs/dev/migration-sources.md

import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, readSkillDirs, readText } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import { looksLikeSecretName } from "./migrate-types.ts";
import {
	OPENCLAW_BOOTSTRAP_FILENAMES,
	OPENCLAW_INCLUDE_KEY,
	OPENCLAW_INCLUDE_MAX_BYTES,
	OPENCLAW_INCLUDE_MAX_DEPTH,
	OPENCLAW_LEGACY_DIR,
	OPENCLAW_LEGACY_MEMORY_FILENAME,
	OPENCLAW_PRIMARY_INSTRUCTION_FILE,
	type OpenClawEnv,
	openclawAgentDir,
	openclawConfigCandidates,
	openclawConfigDir,
	openclawConfigPath,
	openclawSkillDirs,
	openclawStateDir,
} from "./openclaw-home.ts";
import { countOpenClawSessions } from "./openclaw-session.ts";

/**
 * One thing the walk found and did not carry over, with the reason.
 *
 * `name` is a **label, not a resolved path**, the same convention `qoder-read.ts`
 * uses. Nothing here ever holds a value read out of a credential-shaped key.
 */
export interface OpenClawSkipped {
	name: string;
	reason: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** A configuration document: its parsed value, or why it could not be read. */
type OpenClawJson =
	| { kind: "object"; value: Record<string, unknown>; recovered: boolean }
	| { kind: "absent" }
	| { kind: "invalid"; reason: string };

/**
 * OpenClaw's user state, as one read of one home.
 *
 * Every field is a value read out of a file, a *count* of something, or a line
 * saying why neither happened. No field holds a credential and no field holds a
 * conversation.
 */
export interface RawOpenClaw {
	/** The home directory every root was resolved against. */
	home: string;
	/** The environment block the roots were resolved from, kept for the report. */
	env: OpenClawEnv;
	/** The state directory the product's own resolver selected. Always a path. */
	stateDir: string;
	/** `~/.clawdbot` — the pre-rename state directory, named whether or not it exists. */
	legacyStateDir: string;
	/** The configuration directory, which is **not** always {@link RawOpenClaw.stateDir}. */
	configDir: string;
	/** True when a resolved root exists and holds something. */
	present: boolean;
	/**
	 * Which configuration file the product would load, and every candidate it
	 * would have chosen between.
	 *
	 * The candidates are reported because the choice is not obvious: an install can
	 * hold both spellings, and the modern one wins (`paths.ts:38-44`).
	 */
	configPath: string;
	configCandidates: string[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** The configuration after `$include` resolution, or `null` when nothing was readable. */
	settings: Record<string, unknown> | null;
	/** The files an `$include` pulled in, in the order they were merged. */
	includeFiles: string[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** Includes that could not be read, and why. */
	includeFailures: Array<{ path: string; reason: string }>;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Top-level keys the product would refuse to load, named rather than counted. */
	retiredMcpKeys: string[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** `mcp.servers`, with every credential value removed. */
	mcpServers: Record<string, unknown>;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The names of the credential values `mcpServers` had removed, keyed by server name. */
	mcpCredentialNames: Record<string, { env?: string[]; headers?: string[] }>;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The names under `env`, never a value. */
	envNames: string[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** `<agentDir>/settings.json`, read separately from the product configuration. */
	agentSettings: Record<string, unknown> | null;
	/** Where {@link RawOpenClaw.agentSettings} came from, or `null` beside it. */
	agentSettingsPath: string | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Retired keys carried by `agentSettings`. */
	retiredAgentSettingKeys: string[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** `<workspace>/AGENTS.md`, or `null`. */
	agentsMd: string | null;
	/** The workspace the bootstrap documents were looked for in. */
	workspaceDir: string | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The other five bootstrap documents, by name. */
	otherBootstrapDocs: Array<{ name: string; present: boolean }>;
	/** Managed and plugin skills, de-duplicated by folder name, managed first. */
	assets: RawFile[];
	/** A folder name answered by both skill roots; the second was not read. */
	assetCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/** The agent directory the configuration selects, and the default one beside it. */
	agentDir: string;
	agentId: string;
	/**
	 * The agent's SQLite store, **existence-checked only**, or `null` when absent.
	 *
	 * The *name* is what a report may print. Nothing in this importer opens it;
	 * `openclaw-session.ts` does, under its own guarded reader.
	 */
	agentDb: { path: string; exists: boolean } | null;
	/** How many session transcripts the store holds, none of them read here. */
	sessionCount: number;
	/**
	 * The retired `sessions.json`, **existence-checked only**, or `null`.
	 *
	 * `state-migrations.legacy-session-store.ts:1` declares it retired and
	 * `openclaw doctor --fix` migrates it into SQLite. Reading it is a migration
	 * *source*, not a current store, so it is named here rather than parsed.
	 */
	legacySessions: { path: string; exists: boolean } | null;
	/** Everything seen and not carried over, each with the reason. Sorted by name. */
	skipped: OpenClawSkipped[];
}

/** The agent OpenClaw uses when the configuration names none. */
const DEFAULT_AGENT_ID = "main";

/** How deep a credential-shaped key is looked for. See the note in `qoder-read.ts`. */
const MAX_CREDENTIAL_SCAN_DEPTH = 8;

// Long-form design notes: docs/dev/migration-sources.md
/** Keys whose value is dropped whole, contents and all. */
const OPENCLAW_CREDENTIAL_SLOTS = new Set([
	"headers",
	"apiKey",
	"clientCert",
	"clientKey",
	"tokens",
	"vars",
	"authProfiles",
]);

// Long-form design notes: docs/dev/migration-sources.md
/** Keys whose value is a map the user keys by hand, so its child keys are names. */
const OPENCLAW_NAME_MAP_KEYS = new Set(["servers", "providers", "entries", "surfaces", "accessGroups"]);

// Long-form design notes: docs/dev/migration-sources.md
/** The keys OpenClaw's own MCP schema hard-rejects. */
const OPENCLAW_RETIRED_MCP_KEYS = new Set([
	"connectTimeout",
	"connect_timeout",
	"timeout",
	"workingDirectory",
	"supports_parallel_tool_calls",
	"ssl_verify",
	"client_cert",
	"client_key",
	"disabled",
]);

/** The nested retired key, under `codex` (`zod-schema.mcp-server.ts:95-104`). */
const OPENCLAW_RETIRED_MCP_CODEX_KEY = "default_tools_approval_mode";

// Long-form design notes: docs/dev/migration-sources.md
/** Read OpenClaw's state from `home`; `cwd` and `env` have no default. */
export function readOpenClaw(home: string, cwd: string, env: OpenClawEnv): RawOpenClaw {
	const skipped: OpenClawSkipped[] = [];
	const stateDir = openclawStateDir(home, env);
	const configDir = openclawConfigDir(home, env);
	const configCandidates = openclawConfigCandidates(home, env);
	const configPath = openclawConfigPath(home, env);

	const merged = resolveOpenClawConfig(home, configPath, skipped);

	const agentId = readAgentId(merged.value);
	const agentDir = openclawAgentDir(stateDir, agentId, readConfiguredAgentDir(merged.value, agentId));
	const agentDbPath = join(agentDir, "openclaw-agent.sqlite");

	const agentSettingsDoc = readJsonFile(join(agentDir, "settings.json"));
	const agentSettings =
		agentSettingsDoc.kind === "object" ? scrubOpenClawCredentials(agentSettingsDoc.value).value : null;
	if (agentSettingsDoc.kind === "invalid")
		skipped.push({ name: "<agentDir>/settings.json", reason: `not usable: ${agentSettingsDoc.reason}` });

	const retiredMcpKeys = collectRetiredMcpKeys(merged.raw);
	const mcp = readMcpServers(merged.value, merged.raw);

	const workspace = readWorkspace(cwd, skipped);
	const { assets, assetCollisions } = readSkillRoots(configDir);

	const legacySessionsPath = join(stateDir, "sessions.json");

	return {
		home,
		env,
		stateDir,
		legacyStateDir: join(home, OPENCLAW_LEGACY_DIR),
		configDir,
		present: existsSync(stateDir) || existsSync(configDir),
		configPath,
		configCandidates,
		settings: merged.value,
		includeFiles: merged.files,
		includeFailures: merged.failures,
		retiredMcpKeys,
		mcpServers: mcp.servers,
		mcpCredentialNames: mcp.names,
		envNames: readOpenClawEnvNames(merged.raw),
		agentSettings,
		agentSettingsPath: agentSettings === null ? null : join(agentDir, "settings.json"),
		retiredAgentSettingKeys: collectRetiredAgentSettingKeys(agentSettings),
		agentsMd: workspace.agentsMd,
		workspaceDir: cwd,
		otherBootstrapDocs: workspace.others,
		assets,
		assetCollisions,
		agentDir,
		agentId,
		agentDb: { path: agentDbPath, exists: existsSync(agentDbPath) },
		sessionCount: countOpenClawSessions(agentDbPath),
		legacySessions: { path: legacySessionsPath, exists: existsSync(legacySessionsPath) },
		skipped: skipped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
	};
}

// ---------------------------------------------------------------------------
// Configuration: strict JSON, JSON5, and `$include`
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Parse one configuration document: strict JSON first, JSON5 second. */
function parseConfigText(raw: string): OpenClawJson {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return { kind: "invalid", reason: "the document is not a JSON object" };
		return { kind: "object", value: parsed, recovered: false };
	} catch {
		// fall through to the JSON5 arm
	}
	const stripped = stripJson5Comments(raw);
	try {
		const parsed: unknown = JSON.parse(stripped);
		if (!isRecord(parsed)) return { kind: "invalid", reason: "the document is not a JSON object" };
		return { kind: "object", value: parsed, recovered: true };
	} catch {
		return { kind: "invalid", reason: "not parseable as JSON and not parseable once JSON5 comments are stripped" };
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Remove `//` and block comments, and a comma at the end of a container, outside a string. */
function stripJson5Comments(raw: string): string {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		const next = raw[i + 1];
		if (inLine) {
			if (ch === "\n") {
				inLine = false;
				out += ch;
			}
			continue;
		}
		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			out += ch;
			if (ch === "\\") {
				if (next !== undefined) {
					out += next;
					i += 1;
				}
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLine = true;
			i += 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlock = true;
			i += 1;
			continue;
		}
		if (ch === ",") {
			// Look ahead past whitespace: a comma immediately followed by `}` or `]`
			// is a trailing one. Anything else is a real separator and is kept.
			let j = i + 1;
			while (j < raw.length && /\s/.test(raw[j] ?? "")) j += 1;
			const following = raw[j];
			if (following === "}" || following === "]") continue;
		}
		out += ch;
	}
	return out;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The merged configuration: `configPath` plus every `$include`, in merge order. */
function resolveOpenClawConfig(
	home: string,
	configPath: string,
	skipped: OpenClawSkipped[],
): {
	value: Record<string, unknown> | null;
	/** The **unsanitized** merge, read only for key *names*. See {@link readMcpServers}. */
	raw: Record<string, unknown> | null;
	files: string[];
	failures: Array<{ path: string; reason: string }>;
} {
	const files: string[] = [];
	const failures: Array<{ path: string; reason: string }> = [];
	const root = readJsonFile(configPath);
	if (root.kind === "absent") return { value: null, raw: null, files, failures };
	if (root.kind === "invalid") {
		skipped.push({ name: configPath, reason: root.reason });
		return { value: null, raw: null, files, failures };
	}
	if (root.recovered)
		skipped.push({
			name: configPath,
			reason:
				"read as JSON5 (it has comments or trailing commas); OpenClaw's own writer strips JSON5 comments on save, so nothing here was written back",
		});

	// The root document is first in the list, so `includeFiles.length > 1` is the
	// test for "an `$include` actually pulled anything in" — which is why the
	// planner's report line uses that and not `> 0`.
	files.push(configPath);
	const merged = resolveIncludes(root.value, configPath, home, 1, new Set([configPath]), files, failures);
	for (const failure of failures)
		skipped.push({ name: failure.path, reason: `its $include could not be applied — ${failure.reason}` });
	return { value: scrubOpenClawCredentials(merged).value, raw: merged, files, failures };
}

// Long-form design notes: docs/dev/migration-sources.md
/** Resolve one document's `$include` chain, with the document's own keys as the source. */
function resolveIncludes(
	document: Record<string, unknown>,
	basePath: string,
	home: string,
	depth: number,
	visited: Set<string>,
	files: string[],
	failures: Array<{ path: string; reason: string }>,
): Record<string, unknown> {
	if (depth > OPENCLAW_INCLUDE_MAX_DEPTH) {
		failures.push({
			path: basePath,
			reason: `the $include chain is deeper than the product's own limit of ${OPENCLAW_INCLUDE_MAX_DEPTH}`,
		});
		return { ...document };
	}
	const declared = document[OPENCLAW_INCLUDE_KEY];
	if (declared === undefined) return { ...document };
	// A string or an array of strings (`includes.ts:25`); anything else is a shape
	// the product would reject and this importer reports rather than guesses at.
	const list = Array.isArray(declared) ? declared : [declared];
	const included: Record<string, unknown> = {};
	let resolvedAny = false;
	for (const entry of list) {
		if (typeof entry !== "string" || entry.trim() === "") {
			failures.push({ path: basePath, reason: `\`${OPENCLAW_INCLUDE_KEY}\` holds an entry that is not a file path` });
			continue;
		}
		const resolved = resolveIncludePath(entry, basePath, home);
		if (visited.has(resolved)) {
			failures.push({
				path: resolved,
				reason: "already included by this document — the product detects the cycle and stops",
			});
			continue;
		}
		const loaded = readJsonFile(resolved);
		if (loaded.kind === "absent") {
			failures.push({ path: resolved, reason: "named by $include but not on disk" });
			continue;
		}
		if (loaded.kind === "invalid") {
			failures.push({ path: resolved, reason: loaded.reason });
			continue;
		}
		if (readByteLength(resolved) > OPENCLAW_INCLUDE_MAX_BYTES) {
			failures.push({
				path: resolved,
				reason: `larger than the product's own ${OPENCLAW_INCLUDE_MAX_BYTES}-byte limit for an included file`,
			});
			continue;
		}
		visited.add(resolved);
		files.push(resolved);
		// The included document's own includes resolve against *its* directory and
		// merge into it before it merges here.
		const nested = resolveIncludes(loaded.value, resolved, home, depth + 1, visited, files, failures);
		// Later entries are the source, so a later include wins (`:336`).
		mergeInto(included, nested);
		resolvedAny = true;
	}
	if (!resolvedAny) return { ...document };
	// The document's own keys are the source and therefore win (`:368`).
	const own = { ...document };
	delete own[OPENCLAW_INCLUDE_KEY];
	mergeInto(included, own);
	return included;
}

/** The `$include` path, relative to the including file (`includes.ts:415-418`). */
function resolveIncludePath(includePath: string, basePath: string, home: string): string {
	const dir = basePath.replace(/[\\/][^\\/]*$/, "");
	if (includePath.startsWith("~")) {
		const rest = includePath.slice(1).replace(/^[\\/]+/, "");
		return rest === "" ? home : join(home, ...rest.split(/[\\/]/));
	}
	return join(dir === "" ? "." : dir, ...includePath.split(/[\\/]/));
}

/**
 * `target = merge(target, source)` — arrays concatenate, objects recurse, and a
 * primitive takes the source (`includes.ts:204-207`).
 */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const existing = target[key];
		if (Array.isArray(existing) && Array.isArray(value)) {
			target[key] = [...existing, ...value];
			continue;
		}
		if (isRecord(existing) && isRecord(value)) {
			mergeInto(existing, value);
			continue;
		}
		target[key] = value;
	}
}

function readByteLength(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** One configuration file, as the three states it can be in. */
function readJsonFile(path: string): OpenClawJson {
	const raw = readText(path);
	if (raw === null) return { kind: "absent" };
	return parseConfigText(raw);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The agent whose state is read: the first configured one, or `main`. */
function readAgentId(settings: Record<string, unknown> | null): string {
	const agents = settings?.agents;
	if (isRecord(agents) && typeof agents.default === "string" && agents.default.trim() !== "") {
		return agents.default.trim();
	}
	if (Array.isArray(agents)) {
		for (const entry of agents) {
			if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim() !== "") return entry.id.trim();
		}
	}
	return DEFAULT_AGENT_ID;
}

/** `agents[].agentDir` for the agent whose state is read, when the file states one. */
function readConfiguredAgentDir(settings: Record<string, unknown> | null, agentId: string): string | undefined {
	const agents = settings?.agents;
	const entries = Array.isArray(agents)
		? agents
		: isRecord(agents) && Array.isArray(agents.list)
			? agents.list
			: isRecord(agents)
				? Object.values(agents).filter(isRecord)
				: [];
	for (const entry of entries) {
		if (isRecord(entry) && entry.id === agentId && typeof entry.agentDir === "string") return entry.agentDir;
	}
	return undefined;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The retired keys carried by an agent settings document. */
export function collectRetiredAgentSettingKeys(settings: Record<string, unknown> | null): string[] {
	if (settings === null) return [];
	const found: string[] = [];
	if (Object.hasOwn(settings, "queueMode")) found.push("queueMode");
	if (Object.hasOwn(settings, "websockets")) found.push("websockets");
	if (isRecord(settings.skills)) found.push("skills (as an object)");
	if (isRecord(settings.retry) && Object.hasOwn(settings.retry, "maxDelayMs")) found.push("retry.maxDelayMs");
	return found;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The retired keys across every configured server, sorted and de-duplicated. */
function collectRetiredMcpKeys(raw: Record<string, unknown> | null): string[] {
	if (raw === null) return [];
	const mcp = raw.mcp;
	if (!isRecord(mcp)) return [];
	const servers = mcp.servers;
	if (!isRecord(servers)) return [];
	const found = new Set<string>();
	for (const entry of Object.values(servers)) {
		if (!isRecord(entry)) continue;
		for (const key of Object.keys(entry)) {
			if (OPENCLAW_RETIRED_MCP_KEYS.has(key)) found.add(key);
		}
		if (isRecord(entry.codex) && Object.hasOwn(entry.codex, OPENCLAW_RETIRED_MCP_CODEX_KEY)) {
			found.add(`codex.${OPENCLAW_RETIRED_MCP_CODEX_KEY}`);
		}
	}
	return [...found].sort();
}

// Long-form design notes: docs/dev/migration-sources.md
/** `mcp.servers`, copied with every credential value removed, plus the names. */
function readMcpServers(
	settings: Record<string, unknown> | null,
	raw: Record<string, unknown> | null,
): {
	servers: Record<string, unknown>;
	names: Record<string, { env?: string[]; headers?: string[] }>;
} {
	const empty = {
		servers: {} as Record<string, unknown>,
		names: {} as Record<string, { env?: string[]; headers?: string[] }>,
	};
	const mcp = settings?.mcp;
	if (!isRecord(mcp)) return empty;
	const servers = mcp.servers;
	if (!isRecord(servers)) return empty;
	// The names come from the **unsanitized** merge. Reading them from `servers`
	// finds only the keys the scrub kept, so a credential-shaped name — `MY_TOKEN`,
	// `authorization` — would be *absent from the report that exists to name it*,
	// which is the exact silence these names are here to prevent.
	const rawMcp = raw?.mcp;
	const rawServers = isRecord(rawMcp) && isRecord(rawMcp.servers) ? rawMcp.servers : {};
	const out: Record<string, unknown> = {};
	const names: Record<string, { env?: string[]; headers?: string[] }> = {};
	for (const [name, entry] of Object.entries(servers)) {
		if (!isRecord(entry)) {
			out[name] = entry;
			continue;
		}
		const source = isRecord(rawServers[name]) ? rawServers[name] : entry;
		const record: { env?: string[]; headers?: string[] } = {};
		if (isRecord(source.headers)) record.headers = Object.keys(source.headers);
		if (isRecord(source.env)) record.env = Object.keys(source.env);
		if (record.env !== undefined || record.headers !== undefined) names[name] = record;
		out[name] = entry;
	}
	return { servers: out, names };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Remove every credential value from a document, keeping the structure. */
export function scrubOpenClawCredentials<T>(value: T): { value: T; removed: string[] } {
	const removed: string[] = [];
	const walk = (node: unknown, path: string, level: number): unknown => {
		if (level > MAX_CREDENTIAL_SCAN_DEPTH) return node;
		if (Array.isArray(node)) return node.map((entry, index) => walk(entry, `${path}[${index}]`, level + 1));
		if (!isRecord(node)) return node;
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(node)) {
			const here = path === "" ? key : `${path}.${key}`;
			// A user-keyed map: recurse **through** every entry and keep them all,
			// whatever they are named. This is the branch that saves a server called
			// `keyboard-mcp` from `looksLikeSecretName`'s `KEY` substring — see
			// {@link OPENCLAW_NAME_MAP_KEYS} for why that is a real failure and not a
			// hypothetical one.
			if (OPENCLAW_NAME_MAP_KEYS.has(key) && isRecord(child)) {
				const entries: Record<string, unknown> = {};
				for (const [name, entry] of Object.entries(child)) {
					const entryPath = `${here}.${name}`;
					entries[name] = isRecord(entry) ? walk(entry, entryPath, level + 1) : entry;
				}
				out[key] = entries;
				continue;
			}
			// A *slot* is removed; a *name* is not walked as a slot.
			if (looksLikeSecretName(key) || OPENCLAW_CREDENTIAL_SLOTS.has(key)) {
				removed.push(here);
				continue;
			}
			if (key === "url" && typeof child === "string") {
				// Kept, and the planner decides: `urlCredentialProblem` is the only
				// thing that can tell a credential inside a URL from an ordinary one,
				// and it needs the string.
				out[key] = child;
				continue;
			}
			out[key] = walk(child, here, level + 1);
		}
		return out;
	};
	return { value: walk(value, "", 0) as T, removed };
}

// Long-form design notes: docs/dev/migration-sources.md
/** The names under `env`, read from the unsanitized merge. */
function readOpenClawEnvNames(raw: Record<string, unknown> | null): string[] {
	const env = raw?.env;
	if (!isRecord(env)) return [];
	const names = new Set<string>();
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") names.add(key);
		else if (isRecord(value)) for (const inner of Object.keys(value)) names.add(inner);
	}
	return [...names].sort();
}

// ---------------------------------------------------------------------------
// Workspace bootstrap documents
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The workspace documents: `AGENTS.md` read, the other five named. */
function readWorkspace(
	cwd: string,
	skipped: OpenClawSkipped[],
): { agentsMd: string | null; others: OpenClawBootstrapDoc[] } {
	const others: OpenClawBootstrapDoc[] = [];
	let agentsMd: string | null = null;
	for (const name of OPENCLAW_BOOTSTRAP_FILENAMES) {
		const path = join(cwd, ...name.split("/"));
		if (name === OPENCLAW_PRIMARY_INSTRUCTION_FILE) {
			agentsMd = readText(path);
			continue;
		}
		// `MEMORY.md` is resolved by the product only when it is a **real file and
		// not a symlink** (`root-memory-files.ts:41-52`); the legacy spelling is
		// skipped outright (`:72`). Both facts change the answer, so both are
		// reported rather than reduced to "not present".
		if (name === "MEMORY.md" && agentsMd === null) {
			const real = readRealFileOnly(path);
			const legacy = readRealFileOnly(join(cwd, OPENCLAW_LEGACY_MEMORY_FILENAME));
			others.push({
				name,
				present: real !== null,
				...(legacy !== null && real === null ? { legacySpelling: true } : {}),
			});
			continue;
		}
		others.push({ name, present: existsSync(path) });
	}
	if (agentsMd === null)
		skipped.push({
			name: join(cwd, OPENCLAW_PRIMARY_INSTRUCTION_FILE),
			reason: `not present in this workspace — OpenClaw reads its bootstrap documents from the directory the agent runs in, not from the state directory, so a home whose sessions ran elsewhere has its instructions somewhere this importer was not pointed at`,
		});
	return { agentsMd, others };
}

/** A bootstrap document this build has no counterpart for, and whether it was there. */
export interface OpenClawBootstrapDoc {
	name: string;
	present: boolean;
	/** Set for a `MEMORY.md` found only under the legacy `memory.md` spelling. */
	legacySpelling?: boolean;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `path`'s contents when it is a regular file and not a symlink. */
function readRealFileOnly(path: string): string | null {
	try {
		if (lstatSync(path).isSymbolicLink()) return null;
	} catch {
		return null;
	}
	return readText(path);
}

// ---------------------------------------------------------------------------
// Assets and session counts
// ---------------------------------------------------------------------------

/** Skills from both managed roots, de-duplicated by folder name, managed first. */
function readSkillRoots(configDir: string): {
	assets: RawFile[];
	assetCollisions: Array<{ name: string; kept: string; dropped: string }>;
} {
	const assets: RawFile[] = [];
	const collisions: Array<{ name: string; kept: string; dropped: string }> = [];
	const seen = new Set<string>();
	for (const root of openclawSkillDirs(configDir)) {
		for (const file of readSkillDirs(root)) {
			if (seen.has(file.name)) {
				collisions.push({
					name: file.name,
					kept: assets.find((a) => a.name === file.name)?.sourcePath ?? root,
					dropped: file.sourcePath,
				});
				continue;
			}
			seen.add(file.name);
			assets.push(file);
		}
	}
	return { assets, assetCollisions: collisions };
}

/** Directories that exist under `root`, sorted; unreadable is empty. */
export function openclawDirNames(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}
