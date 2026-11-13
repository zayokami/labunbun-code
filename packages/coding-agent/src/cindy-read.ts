// Cindy's local state as far as a migration can read it: the one owner database
// this run opens, the MCP servers and providers in it, and the directories it
// links to but does not own. Read `cindy-home.ts` first for every path claim.
// Long-form design notes: docs/dev/migration-sources.md

import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	CINDY_DEFAULT_DIR,
	type CindyEnv,
	cindyDetectionRoots,
	cindyFirstUserDataDir,
	cindyOwnerDatabases,
	cindyThemeDirs,
	cindyTreeHasContent,
} from "./cindy-home.ts";
import { isRecord, tildePath } from "./migrate-core.ts";

// Long-form design notes: docs/dev/migration-sources.md
/** One thing the reader saw and did not carry, with the reason the report prints. */
export interface CindySkipped {
	name: string;
	reason: string;
}

/** One remote MCP server row, as far as a migration is concerned. */
export interface CindyMcpServer {
	/** `custom_mcp_servers.id` — the slug Cindy also uses as `mcpServers[name]`. */
	id: string;
	/** The user's display name for it. Never a credential. */
	name: string;
	/** `'http'` or `'sse'`; the table holds no stdio servers. */
	transport: string;
	/** The endpoint, which may carry credentials of its own. */
	url: string;
	/**
	 * Extra request headers, when the row holds them as plaintext JSON. `null`
	 * when the column is encrypted or unreadable.
	 */
	headers: Record<string, string> | null;
	/** Whether `headers` was written by Cindy's safeStorage and cannot be decrypted outside Electron. */
	headersEncrypted: boolean;
	/** Why a plaintext `headers` value could not be read, or `null`. */
	headersProblem: string | null;
}

/** One model in a custom provider runtime, as persisted. */
export interface CindyProviderModel {
	id: string;
	name: string;
	/** Present when the preset snapshot carried one; user-typed models often omit it. */
	contextWindow?: number;
	maxOutput?: number;
}

/** One runtime's configuration of a custom provider. Header **names** only: values never enter this record. */
export interface CindyProviderRuntime {
	/** `claude-code`, `codex` or `pi`. */
	agent: string;
	baseUrl: string;
	/** `anthropic-messages`, `openai-responses`, `openai-chat` or `google-generative-ai`, or `null` when the runtime infers it. */
	wireProtocol: string | null;
	models: CindyProviderModel[];
	/** Header names the runtime is configured with, for the report; the values are not read. */
	headerNames: string[];
}

/** One custom provider row, minus every credential. */
export interface CindyProvider {
	id: string;
	name: string;
	/** `apiKey`, `oauth`, `none`, or `null` when the column is absent (historical API-key shape). */
	authMethod: string | null;
	/** Whether the row's auth json describes an OAuth flow rather than a key. */
	oauth: boolean;
	runtimes: CindyProviderRuntime[];
}

/** How much conversation the database holds, for the history gate; no transcript is read here. */
export interface CindySessionCount {
	/** Sessions a user would see: not deleted, not hidden background tasks, not Orca workers. */
	listable: number;
	/** Rows excluded for one of those three reasons. */
	excluded: number;
}

/** Everything Cindy gave up. */
export interface RawCindy {
	/** The home directory every root was resolved against. */
	home: string;
	/** The environment block the roots were resolved from, kept for the report. */
	env: CindyEnv;
	/** Every userData directory considered, whether or not it exists. */
	userDataDirs: string[];
	/** True when any detection root exists and holds something. */
	present: boolean;
	/** The owner database this run reads, or `null`. */
	dbPath: string | null;
	/** Why the database could not be opened, or `null`. */
	dbProblem: string | null;
	/** Owner databases found beyond the one read; they belong to other accounts and are not opened. */
	otherDatabases: number;
	/** Remote MCP servers, in Cindy's own display order. */
	mcpServers: CindyMcpServer[];
	/** Custom model providers, without keys, tokens or header values. */
	providers: CindyProvider[];
	/** How many sessions the database holds, split by whether the user would list them. */
	sessions: CindySessionCount;
	/** Files under the local theme directories. Counted, never read: the formats are unrelated. */
	themeFiles: number;
	/** Skill directories under the shared `~/.agents/skills` home, which the `agents` source owns. */
	sharedSkillCount: number;
	/** Everything seen and passed over, each with its reason. */
	skipped: CindySkipped[];
}

/** The prefix Cindy's safeStorage wrapper writes before the encrypted base64 blob. */
export const CINDY_ENCRYPTED_PREFIX = "safe-storage:v1:";

/** `void` on any failure: a database the app holds locked is a database to skip. */
function withDatabase<T>(dbPath: string, work: (db: Database) => T): T | null {
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		return work(db);
	} catch {
		return null;
	} finally {
		try {
			db?.close();
		} catch {
			// best-effort; the caller already has its answer
		}
	}
}

function tableExists(db: Database, name: string): boolean {
	try {
		const row = db.query("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name);
		return row !== null;
	} catch {
		return false;
	}
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

/** Parse the `headers` column: plaintext JSON, an encrypted blob, or a problem. */
export function cindyHeaders(raw: string): Pick<CindyMcpServer, "headers" | "headersEncrypted" | "headersProblem"> {
	if (raw.startsWith(CINDY_ENCRYPTED_PREFIX)) {
		return { headers: null, headersEncrypted: true, headersProblem: null };
	}
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed === "{}") return { headers: {}, headersEncrypted: false, headersProblem: null };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return {
			headers: null,
			headersEncrypted: false,
			headersProblem: "the row's `headers` value is not JSON, so no header could be carried",
		};
	}
	if (!isRecord(parsed)) {
		return {
			headers: null,
			headersEncrypted: false,
			headersProblem: "the row's `headers` value is not a JSON object, so no header could be carried",
		};
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "string") {
			return {
				headers: null,
				headersEncrypted: false,
				headersProblem:
					"the row's `headers` value holds a non-string entry, so no header was carried rather than part of one",
			};
		}
		if (key.trim() !== "") headers[key] = value;
	}
	return { headers, headersEncrypted: false, headersProblem: null };
}

/** Read `custom_mcp_servers`, or an empty list when the table is absent. */
export function readCindyMcpServers(db: Database): CindyMcpServer[] {
	if (!tableExists(db, "custom_mcp_servers")) return [];
	const rows = db
		.query("SELECT id, name, transport, url, headers FROM custom_mcp_servers ORDER BY sort_order ASC, id ASC")
		.all();
	return rows.map((row) => {
		const record = row as { id?: unknown; name?: unknown; transport?: unknown; url?: unknown; headers?: unknown };
		return {
			id: text(record.id),
			name: text(record.name),
			transport: text(record.transport),
			url: text(record.url),
			...cindyHeaders(text(record.headers)),
		};
	});
}

/** Read one provider runtime's models and endpoint, without header values. */
function cindyProviderRuntime(agent: string, value: unknown): CindyProviderRuntime | null {
	if (!isRecord(value)) return null;
	const baseUrl = text(value.baseUrl);
	const models: CindyProviderModel[] = [];
	if (Array.isArray(value.models)) {
		for (const entry of value.models) {
			if (!isRecord(entry)) continue;
			const id = text(entry.id);
			if (id === "") continue;
			const model: CindyProviderModel = { id, name: text(entry.name) };
			const contextWindow = positiveInteger(entry.contextWindow);
			const maxOutput = positiveInteger(entry.maxOutput);
			if (contextWindow !== undefined) model.contextWindow = contextWindow;
			if (maxOutput !== undefined) model.maxOutput = maxOutput;
			models.push(model);
		}
	}
	const headerNames = isRecord(value.headers) ? Object.keys(value.headers).filter((key) => key.trim() !== "") : [];
	return {
		agent,
		baseUrl,
		wireProtocol:
			typeof value.wireProtocol === "string" && value.wireProtocol.trim() !== "" ? value.wireProtocol : null,
		models,
		headerNames,
	};
}

/** Read `custom_providers`, or an empty list when the table is absent. */
export function readCindyProviders(db: Database): CindyProvider[] {
	if (!tableExists(db, "custom_providers")) return [];
	const rows = db.query("SELECT id, name, runtimes, auth FROM custom_providers ORDER BY sort_order ASC, id ASC").all();
	return rows.map((row) => {
		const record = row as { id?: unknown; name?: unknown; runtimes?: unknown; auth?: unknown };
		let runtimes: unknown = {};
		try {
			runtimes = JSON.parse(text(record.runtimes));
		} catch {
			runtimes = {};
		}
		const parsedRuntimes: CindyProviderRuntime[] = [];
		if (isRecord(runtimes)) {
			for (const [agent, value] of Object.entries(runtimes)) {
				const runtime = cindyProviderRuntime(agent, value);
				if (runtime !== null) parsedRuntimes.push(runtime);
			}
		}
		let authMethod: string | null = null;
		try {
			const auth = JSON.parse(text(record.auth));
			if (isRecord(auth)) authMethod = typeof auth.method === "string" ? auth.method : null;
		} catch {
			authMethod = null;
		}
		return {
			id: text(record.id),
			name: text(record.name),
			authMethod,
			oauth: authMethod === "oauth",
			runtimes: parsedRuntimes,
		};
	});
}

/** Count sessions without reading a single message. Missing columns degrade to the simpler query. */
export function readCindySessionCount(db: Database): CindySessionCount {
	if (!tableExists(db, "sessions")) return { listable: 0, excluded: 0 };
	const count = (sql: string): number | null => {
		try {
			const row = db.query(sql).get() as { n?: unknown } | null;
			return typeof row?.n === "number" ? row.n : null;
		} catch {
			return null;
		}
	};
	const total = count("SELECT COUNT(*) AS n FROM sessions WHERE status <> 'deleted'") ?? 0;
	const listable = count(
		"SELECT COUNT(*) AS n FROM sessions WHERE status <> 'deleted' AND hidden_at IS NULL AND (orca_role IS NULL OR orca_role <> 'worker')",
	);
	// A schema that predates `hidden_at` or `orca_role` cannot answer the narrower
	// question. Falling back to the total is the honest answer: nothing can be
	// called excluded by columns this database does not have.
	if (listable === null) return { listable: total, excluded: 0 };
	return { listable, excluded: Math.max(0, total - listable) };
}

/** How many directories a skills root holds; unreadable or absent contributes none. */
function cindySkillDirCount(root: string): number {
	try {
		return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

/** Theme files under both local theme directories, counted without opening one. */
function cindyThemeFileCount(home: string): number {
	let files = 0;
	for (const dir of cindyThemeDirs(home)) {
		try {
			files += readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
		} catch {
			// absent directory: nothing to count
		}
	}
	return files;
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Read a Cindy installation.
 *
 * The database is the only file opened. Cindy's appearance preferences, its
 * API keys and its bearer tokens are not in it — they live in the renderer's
 * localStorage and in safeStorage — and this reader neither looks for them nor
 * pretends it could.
 */
export function readCindy(home: string, env: CindyEnv = process.env): RawCindy {
	const skipped: CindySkipped[] = [];
	const present = cindyDetectionRoots(home, env).some(cindyTreeHasContent);
	const databases = cindyOwnerDatabases(home, env);
	const dbPath = databases[0]?.path ?? null;
	const otherDatabases = Math.max(0, databases.length - 1);
	let dbProblem: string | null = null;
	let mcpServers: CindyMcpServer[] = [];
	let providers: CindyProvider[] = [];
	let sessions: CindySessionCount = { listable: 0, excluded: 0 };

	if (dbPath === null) {
		const userData = cindyFirstUserDataDir(home, env);
		skipped.push({
			name: userData === null ? tildePath(home, join(home, CINDY_DEFAULT_DIR)) : tildePath(home, userData),
			reason:
				"no owner database (`<userData>/cindy-<ownerId>.db`) — Cindy creates it when an account first signs in, " +
				"so an installation that was never used has no configuration to bring",
		});
	} else if (!existsSync(dbPath)) {
		dbProblem = "the database disappeared between discovery and opening";
	} else {
		const read = withDatabase(dbPath, (db) => ({
			mcpServers: readCindyMcpServers(db),
			providers: readCindyProviders(db),
			sessions: readCindySessionCount(db),
		}));
		if (read === null) {
			dbProblem =
				"the database could not be opened read-only — it may be locked by a running Cindy, or its schema may predate this importer";
		} else {
			mcpServers = read.mcpServers;
			providers = read.providers;
			sessions = read.sessions;
		}
	}

	if (otherDatabases > 0) {
		skipped.push({
			name: `${otherDatabases} other owner database${otherDatabases === 1 ? "" : "s"}`,
			reason:
				"Cindy keeps one database per signed-in account, and this importer reads only the most recently written one: " +
				"merging two accounts' servers and providers would undo the isolation Cindy's per-owner files exist to provide. " +
				"Sign in to the other account in Cindy and run the migration again to import it",
		});
	}
	if (dbProblem !== null) {
		skipped.push({ name: dbPath === null ? "owner database" : tildePath(home, dbPath), reason: dbProblem });
	}

	return {
		home,
		env,
		userDataDirs: cindyDetectionRoots(home, env),
		present,
		dbPath,
		dbProblem,
		otherDatabases,
		mcpServers,
		providers,
		sessions,
		themeFiles: cindyThemeFileCount(home),
		sharedSkillCount: cindySkillDirCount(join(home, ".agents", "skills")),
		skipped,
	};
}
