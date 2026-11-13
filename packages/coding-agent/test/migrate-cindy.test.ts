/**
 * The `cindy` source: an Electron `userData` tree whose configuration is rows in
 * a per-account SQLite database, not files.
 *
 * **What this file is for.** Cindy is the first source here whose settings and
 * credentials are separated by a process boundary: the database holds MCP
 * servers and providers, while keys, bearer tokens and appearance preferences
 * live in safeStorage and the renderer's localStorage. The tests below assert
 * both halves of that — what is imported, and what the reader never opens — plus
 * the four session states (deleted, hidden, worker, rewound) that a naive
 * listing would import as ordinary conversation.
 *
 * Every fixture is a temporary directory. `APPDATA` is borrowed through
 * `source-env.ts` because `readSources` reaches Cindy's `userData` root that way;
 * nothing here reads a real installation.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import {
	CINDY_DEFAULT_DIR,
	cindyDetectionRoots,
	cindyOwnerDatabases,
	cindyThemeDirs,
	cindyUserDataBases,
	cindyUserDataDirs,
} from "../src/cindy-home.ts";
import { readCindy } from "../src/cindy-read.ts";
import { listCindyHistory, readCindyHistory } from "../src/cindy-session.ts";
import { runMigration } from "../src/migrate.ts";
import { detectSources, MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS, SOURCE_ROOTS } from "../src/migrate-types.ts";
import { borrowSourceEnv, releaseEnv } from "./source-env.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const made: string[] = [];

beforeEach(() => {
	borrowSourceEnv();
});
afterEach(() => {
	releaseEnv();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

function writeUnder(root: string, relative: string, content: string): void {
	const path = join(root, ...relative.split("/"));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

interface CindyMcpRow {
	id: string;
	name: string;
	transport: string;
	url: string;
	headers?: string;
}

interface CindyProviderRow {
	id: string;
	name: string;
	runtimes: unknown;
	auth?: unknown;
}

interface CindySessionRow {
	id: string;
	title: string;
	workingDir?: string | null;
	status?: string;
	createdAt?: number;
	hiddenAt?: number | null;
	orcaRole?: string | null;
	remoteHostId?: string | null;
	agentDeviceId?: string | null;
}

interface CindyMessageRow {
	id: string;
	sessionId: string;
	role: string;
	content: string;
	toolUseId?: string | null;
	createdAt?: number;
	rewindAt?: number | null;
}

interface CindyFixture {
	home: string;
	appData: string;
	userData: string;
	dbPath: string;
	env: Record<string, string | undefined>;
}

/**
 * Build a `CindyGlobal` userData directory with the four tables this importer
 * reads. The database is real rather than mocked: the queries, the column
 * degradation and the read-only open are exactly what is under test.
 */
function cindyFixture(
	options: {
		mcpServers?: CindyMcpRow[];
		providers?: CindyProviderRow[];
		sessions?: CindySessionRow[];
		messages?: CindyMessageRow[];
	} = {},
): CindyFixture {
	const home = makeDir("lbb-cindy-home-");
	const appData = makeDir("lbb-cindy-appdata-");
	const userData = join(appData, "CindyGlobal");
	mkdirSync(userData, { recursive: true });
	// `readSources` calls `readCindy(home, process.env)`, so this is how a
	// fixture's database reaches a `runMigration` call; `releaseEnv()` restores it.
	process.env.APPDATA = appData;
	const dbPath = join(userData, "cindy-owner1.db");
	const db = new Database(dbPath, { create: true });
	try {
		db.exec(
			"CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, working_dir TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, hidden_at INTEGER, orca_role TEXT, remote_host_id TEXT, agent_device_id TEXT)",
		);
		db.exec(
			"CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_use_id TEXT, created_at INTEGER NOT NULL, rewind_at INTEGER)",
		);
		db.exec(
			"CREATE TABLE custom_mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL, url TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		);
		db.exec(
			"CREATE TABLE custom_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, runtimes TEXT NOT NULL DEFAULT '{}', auth TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		);
		for (const server of options.mcpServers ?? []) {
			db.query(
				"INSERT INTO custom_mcp_servers (id, name, transport, url, headers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
			).run(server.id, server.name, server.transport, server.url, server.headers ?? "{}");
		}
		for (const provider of options.providers ?? []) {
			db.query(
				"INSERT INTO custom_providers (id, name, runtimes, auth, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
			).run(
				provider.id,
				provider.name,
				JSON.stringify(provider.runtimes),
				provider.auth === undefined ? null : JSON.stringify(provider.auth),
			);
		}
		for (const session of options.sessions ?? []) {
			db.query(
				"INSERT INTO sessions (id, title, working_dir, status, created_at, hidden_at, orca_role, remote_host_id, agent_device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				session.id,
				session.title,
				session.workingDir ?? null,
				session.status ?? "active",
				session.createdAt ?? 1_700_000_000_000,
				session.hiddenAt ?? null,
				session.orcaRole ?? null,
				session.remoteHostId ?? null,
				session.agentDeviceId ?? null,
			);
		}
		for (const message of options.messages ?? []) {
			db.query(
				"INSERT INTO messages (id, session_id, role, content, tool_use_id, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(
				message.id,
				message.sessionId,
				message.role,
				message.content,
				message.toolUseId ?? null,
				message.createdAt ?? 1_700_000_000_000,
				message.rewindAt ?? null,
			);
		}
	} finally {
		db.close();
	}
	return { home, appData, userData, dbPath, env: { APPDATA: appData } };
}

/** A project directory that exists, so `narrowCandidates` keeps the session. */
function repoDir(): string {
	const repo = join(makeDir("lbb-cindy-repo-"), "repo");
	mkdirSync(repo, { recursive: true });
	return repo;
}

// ---------------------------------------------------------------------------
// Registration and roots
// ---------------------------------------------------------------------------

describe("cindy: registration", () => {
	test("it is appended last, so every earlier source id keeps its position", () => {
		expect(MIGRATION_SOURCE_IDS.at(-1)).toBe("cindy");
		expect(MIGRATION_SOURCE_IDS.at(-2)).toBe("command-code");
		expect(MIGRATION_SOURCE_LABELS.cindy).toBe("Cindy");
		// The table entry is the fallback label, not the read tree: Cindy's state is
		// in Electron's userData directory, and `sourceRoot` resolves that.
		expect(SOURCE_ROOTS.cindy).toBe(CINDY_DEFAULT_DIR);
		expect(new Set(Object.keys(MIGRATION_SOURCE_LABELS))).toEqual(new Set(MIGRATION_SOURCE_IDS));
	});

	test("a userData tree with something in it detects the source", () => {
		const fixture = cindyFixture();
		expect(cindyDetectionRoots(fixture.home, fixture.env)).toContain(fixture.userData);
		expect(detectSources(fixture.home)).toContain("cindy");
	});

	test("~/.cindy alone is enough, because themes and lock files live there", () => {
		const home = makeDir("lbb-cindy-home-");
		writeUnder(home, ".cindy/themes/flat.json", "{}");
		expect(detectSources(home)).toContain("cindy");
	});
});

describe("cindy: userData roots", () => {
	test("the four platform bases are deduplicated and the install names are appended", () => {
		const home = makeDir("lbb-cindy-home-");
		const appData = join(home, "roaming");
		const bases = cindyUserDataBases(home, { APPDATA: appData, XDG_CONFIG_HOME: join(home, ".config") });
		expect(bases).toContain(appData);
		expect(bases).toContain(join(home, "AppData", "Roaming"));
		expect(bases).toContain(join(home, "Library", "Application Support"));
		expect(bases).toContain(join(home, ".config"));
		expect(new Set(bases).size).toBe(bases.length);
		const dirs = cindyUserDataDirs(home, { APPDATA: appData, XDG_CONFIG_HOME: join(home, ".config") });
		expect(dirs).toContain(join(appData, "CindyGlobal"));
		expect(dirs).toContain(join(appData, "Cindy"));
		expect(dirs).toContain(join(appData, "CindyDev"));
		expect(dirs).toContain(join(appData, "xdt-maker"));
	});

	test("only `<prefix>-<owner>.db` is a database; sidecars and unrelated files are not", () => {
		const home = makeDir("lbb-cindy-home-");
		const appData = join(home, "roaming");
		const userData = join(appData, "CindyGlobal");
		mkdirSync(userData, { recursive: true });
		writeFileSync(join(userData, "cindy-owner.db"), "x");
		writeFileSync(join(userData, "cindy-owner.db-wal"), "x");
		writeFileSync(join(userData, "xdt-maker-legacy.db"), "x");
		writeFileSync(join(userData, "notes.db"), "x");
		const found = cindyOwnerDatabases(home, { APPDATA: appData, XDG_CONFIG_HOME: join(home, ".config") });
		expect(found.map((file) => file.path).sort()).toEqual(
			[join(userData, "cindy-owner.db"), join(userData, "xdt-maker-legacy.db")].sort(),
		);
		expect(found.find((file) => file.path.endsWith("xdt-maker-legacy.db"))?.prefix).toBe("xdt-maker");
	});

	test("the most recently written database is the one read; the other account is counted", () => {
		const home = makeDir("lbb-cindy-home-");
		const appData = join(home, "roaming");
		const global = join(appData, "CindyGlobal");
		const cn = join(appData, "Cindy");
		mkdirSync(global, { recursive: true });
		mkdirSync(cn, { recursive: true });
		const older = join(global, "cindy-a.db");
		const newer = join(cn, "cindy-b.db");
		writeFileSync(older, "x");
		writeFileSync(newer, "x");
		utimesSync(older, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
		utimesSync(newer, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
		const raw = readCindy(home, { APPDATA: appData, XDG_CONFIG_HOME: join(home, ".config") });
		expect(raw.dbPath).toBe(newer);
		expect(raw.otherDatabases).toBe(1);
		expect(raw.skipped.some((entry) => entry.reason.includes("one database per signed-in account"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

describe("cindy: MCP servers", () => {
	test("an HTTP server with plaintext headers is copied, and the write is marked as holding a secret", () => {
		const fixture = cindyFixture({
			mcpServers: [
				{
					id: "mcp-one",
					name: "One",
					transport: "http",
					url: "https://mcp.example.test/mcp",
					headers: JSON.stringify({ "X-Region": "eu" }),
				},
			],
		});
		const plan = runMigration({ home: fixture.home, cwd: fixture.home, from: "cindy", existing: {} }).plan;
		const item = plan.items.find((entry) => entry.from.includes("custom_mcp_servers.mcp-one"));
		expect(item?.action).toBe("map");
		expect(item?.containsSecret).toBe(true);
		const write = plan.writes.find((entry) => entry.kind === "mcp");
		expect(write?.containsSecret).toBe(true);
		const parsed = JSON.parse(write?.content ?? "{}") as {
			mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
		};
		expect(parsed.mcpServers["mcp-one"]).toEqual({
			type: "http",
			url: "https://mcp.example.test/mcp",
			headers: { "X-Region": "eu" },
		});
	});

	test("safeStorage-encrypted headers are dropped with a downgrade, not half-copied", () => {
		const fixture = cindyFixture({
			mcpServers: [
				{
					id: "locked",
					name: "Locked",
					transport: "http",
					url: "https://mcp.example.test/locked",
					headers: "safe-storage:v1:AAAA",
				},
			],
		});
		const plan = runMigration({ home: fixture.home, cwd: fixture.home, from: "cindy", existing: {} }).plan;
		const item = plan.items.find((entry) => entry.from.includes("custom_mcp_servers.locked"));
		expect(item?.action).toBe("downgrade");
		expect(item?.containsSecret).toBe(false);
		expect(item?.detail).toContain("OS keyring");
		const write = plan.writes.find((entry) => entry.kind === "mcp");
		expect(write?.containsSecret).toBe(false);
		expect(write?.content).toContain("https://mcp.example.test/locked");
		expect(write?.content).not.toContain("safe-storage:v1:");
		expect(write?.content).not.toContain("headers");
	});

	test("the legacy SSE transport is refused rather than renamed to HTTP", () => {
		const fixture = cindyFixture({
			mcpServers: [{ id: "sse-one", name: "SSE", transport: "sse", url: "https://mcp.example.test/sse" }],
		});
		const plan = runMigration({ home: fixture.home, cwd: fixture.home, from: "cindy", existing: {} }).plan;
		const item = plan.items.find((entry) => entry.from.includes("custom_mcp_servers.sse-one"));
		expect(item?.action).toBe("skip");
		expect(item?.detail).toContain("streamable HTTP only");
		expect(plan.writes.find((entry) => entry.kind === "mcp")).toBeUndefined();
	});

	test("a credential in the URL loses the whole server, and the credential is not printed", () => {
		const fixture = cindyFixture({
			mcpServers: [
				{
					id: "leaky",
					name: "Leaky",
					transport: "http",
					url: "https://alice:hunter2@mcp.example.test/mcp",
				},
			],
		});
		const plan = runMigration({ home: fixture.home, cwd: fixture.home, from: "cindy", existing: {} }).plan;
		const item = plan.items.find((entry) => entry.from.includes("custom_mcp_servers.leaky"));
		expect(item?.action).toBe("skip");
		expect(item?.containsSecret).toBe(true);
		expect(item?.detail).toContain("name:password@");
		expect(JSON.stringify(plan.items)).not.toContain("hunter2");
		expect(JSON.stringify(plan.writes)).not.toContain("hunter2");
	});

	test("a name the target already defines is kept unless --force is passed", () => {
		const fixture = cindyFixture({
			mcpServers: [{ id: "taken", name: "Taken", transport: "http", url: "https://mcp.example.test/new" }],
		});
		writeUnder(
			fixture.home,
			".labunbun/.mcp.json",
			JSON.stringify({ mcpServers: { taken: { type: "http", url: "https://mcp.example.test/old" } } }),
		);
		const kept = runMigration({ home: fixture.home, cwd: fixture.home, from: "cindy", existing: {} }).plan;
		expect(kept.items.find((entry) => entry.from.includes("custom_mcp_servers.taken"))?.action).toBe("skip");
		expect(kept.writes.find((entry) => entry.kind === "mcp")).toBeUndefined();

		const forced = runMigration({
			home: fixture.home,
			cwd: fixture.home,
			from: "cindy",
			existing: {},
			force: true,
		}).plan;
		const write = forced.writes.find((entry) => entry.kind === "mcp");
		expect(write?.content).toContain("https://mcp.example.test/new");
		expect(write?.content).not.toContain("https://mcp.example.test/old");
	});
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

describe("cindy: providers", () => {
	test("an explicit openai-chat runtime becomes an openai-completions entry with an env-var key", () => {
		const fixture = cindyFixture({
			providers: [
				{
					id: "acme",
					name: "Acme",
					runtimes: {
						"claude-code": {
							baseUrl: "https://api.acme.test/v1",
							wireProtocol: "openai-chat",
							models: [{ id: "acme-1", name: "Acme One" }],
						},
					},
					auth: { method: "apiKey" },
				},
			],
		});
		const plan = runMigration({ home: fixture.home, cwd: fixture.home, from: "cindy", existing: {} }).plan;
		const item = plan.items.find((entry) => entry.from.includes("custom_providers.acme"));
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("ACME_API_KEY");
		const write = plan.writes.find((entry) => entry.kind === "settings");
		const settings = JSON.parse(write?.content ?? "{}") as {
			providers: {
				openaiCompatible: Array<{
					id: string;
					baseUrl: string;
					apiKeyEnv: string;
					api: string;
					models: Array<{ id: string; name?: string; contextWindow: number; maxOutputTokens: number }>;
				}>;
			};
		};
		expect(settings.providers.openaiCompatible).toHaveLength(1);
		expect(settings.providers.openaiCompatible[0]).toMatchObject({
			id: "acme",
			baseUrl: "https://api.acme.test/v1",
			apiKeyEnv: "ACME_API_KEY",
			api: "openai-completions",
		});
		expect(settings.providers.openaiCompatible[0]?.models[0]).toMatchObject({
			id: "acme-1",
			name: "Acme One",
			contextWindow: 200_000,
			maxOutputTokens: 8192,
		});
	});

	test("an OAuth provider is skipped, because the target authenticates with an environment variable", () => {
		const fixture = cindyFixture({
			providers: [
				{
					id: "oauth-one",
					name: "OAuth",
					runtimes: {
						"claude-code": {
							baseUrl: "https://api.oauth.test",
							wireProtocol: "anthropic-messages",
							models: [{ id: "m1", name: "M1" }],
						},
					},
					auth: { method: "oauth" },
				},
			],
		});
		const plan = runMigration({ home: fixture.home, cwd: fixture.home, from: "cindy", existing: {} }).plan;
		const item = plan.items.find((entry) => entry.from.includes("custom_providers.oauth-one"));
		expect(item?.action).toBe("skip");
		expect(item?.containsSecret).toBe(true);
		expect(item?.detail).toContain("OAuth");
		expect(plan.writes.find((entry) => entry.kind === "settings")).toBeUndefined();
	});

	test("a Gemini-only runtime has no counterpart and says so", () => {
		const fixture = cindyFixture({
			providers: [
				{
					id: "gemini",
					name: "Gemini",
					runtimes: {
						pi: {
							baseUrl: "https://generativelanguage.test",
							wireProtocol: "google-generative-ai",
							models: [{ id: "g1", name: "G1" }],
						},
					},
				},
			],
		});
		const plan = runMigration({ home: fixture.home, cwd: fixture.home, from: "cindy", existing: {} }).plan;
		const item = plan.items.find((entry) => entry.from.includes("custom_providers.gemini"));
		expect(item?.action).toBe("skip");
		expect(item?.detail).toContain("google-generative-ai");
	});
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("cindy: conversation listing", () => {
	test("deleted, hidden and Orca worker sessions are counted and left out", () => {
		const repo = repoDir();
		const fixture = cindyFixture({
			sessions: [
				{ id: "live", title: "Live", workingDir: repo },
				{ id: "arch", title: "Archived", workingDir: repo, status: "archived" },
				{ id: "gone", title: "Deleted", workingDir: repo, status: "deleted" },
				{ id: "bg", title: "Hidden", workingDir: repo, hiddenAt: 5 },
				{ id: "worker", title: "Worker", workingDir: repo, orcaRole: "worker" },
				{ id: "remote", title: "Remote", workingDir: "/srv/project", remoteHostId: "box" },
				{ id: "nocwd", title: "No cwd", workingDir: null },
			],
		});
		const listing = listCindyHistory(fixture.home, fixture.env);
		expect(listing.candidates.map((candidate) => candidate.sourceId).sort()).toEqual([
			"arch",
			"live",
			"nocwd",
			"remote",
		]);
		expect(listing.candidates.find((candidate) => candidate.sourceId === "arch")?.archived).toBe(true);
		// Both the remote path and the missing one are filed under the database's
		// own directory, which exists; a substitute that did not exist would be
		// dropped by `narrowCandidates` and the session silently lost.
		for (const id of ["remote", "nocwd"]) {
			const candidate = listing.candidates.find((entry) => entry.sourceId === id);
			expect(candidate?.cwd).toBe(fixture.userData);
			expect(candidate?.cwdSubstitute).toBe(fixture.userData);
		}
		const reasons = listing.notes.map((note) => note.reason).join(" | ");
		expect(reasons).toContain("deleted session");
		expect(reasons).toContain("hidden background task");
		expect(reasons).toContain("Orca worker session");
		expect(reasons).toContain("another machine");
		for (const fragment of ["deleted session", "hidden background task", "Orca worker session", "another machine"]) {
			expect(listing.notes.find((note) => note.reason.includes(fragment))?.count).toBe(1);
		}
	});

	test("a rewound row is hidden and counted, and a tool call keeps its arguments and result", () => {
		const fixture = cindyFixture({
			sessions: [{ id: "s1", title: "One", workingDir: repoDir() }],
			messages: [
				{ id: "m1", sessionId: "s1", role: "user", content: JSON.stringify({ text: "hello" }), createdAt: 1 },
				{ id: "m2", sessionId: "s1", role: "thinking", content: JSON.stringify({ text: "pondering" }), createdAt: 2 },
				{ id: "m3", sessionId: "s1", role: "assistant", content: JSON.stringify("hi there"), createdAt: 3 },
				{
					id: "m4",
					sessionId: "s1",
					role: "tool_use",
					content: JSON.stringify({ toolUseId: "call-1", toolName: "Read", input: { path: "a.txt" } }),
					toolUseId: "call-1",
					createdAt: 4,
				},
				{
					id: "m5",
					sessionId: "s1",
					role: "tool_result",
					content: JSON.stringify("contents"),
					toolUseId: "call-1",
					createdAt: 5,
				},
				{
					id: "m6",
					sessionId: "s1",
					role: "user",
					content: JSON.stringify({ text: "old attempt" }),
					createdAt: 6,
					rewindAt: 7,
				},
			],
		});
		const candidate = listCindyHistory(fixture.home, fixture.env).candidates[0];
		if (candidate === undefined) throw new Error("expected the fixture's session to be listed");
		const read = readCindyHistory(candidate);
		expect(read.entries).toHaveLength(5);
		const messages = read.entries
			.filter((entry): entry is { kind: "message"; message: AgentMessage } => entry.kind === "message")
			.map((entry) => entry.message);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"assistant",
			"assistant",
			"toolResult",
		]);
		const toolCall = messages[3]?.content;
		expect(Array.isArray(toolCall) ? toolCall[0] : undefined).toEqual({
			type: "toolCall",
			id: "call-1",
			name: "Read",
			arguments: JSON.stringify({ path: "a.txt" }),
		});
		expect(JSON.stringify(read.entries)).not.toContain("old attempt");
		expect(read.notes.some((note) => note.reason.includes("rewound") && note.count === 1)).toBe(true);
	});

	test("a missing database is a note, not an exception", () => {
		const home = makeDir("lbb-cindy-home-");
		expect(listCindyHistory(home, {})).toEqual({ candidates: [], notes: [expect.objectContaining({ count: 1 })] });
	});
});

describe("cindy: a whole run", () => {
	test("settings, MCP and history land in one plan, and no keyring material is in it", () => {
		const repo = repoDir();
		const fixture = cindyFixture({
			mcpServers: [{ id: "docs", name: "Docs", transport: "http", url: "https://mcp.example.test/docs" }],
			providers: [
				{
					id: "acme",
					name: "Acme",
					runtimes: {
						codex: {
							baseUrl: "https://api.acme.test/v1",
							wireProtocol: "openai-responses",
							models: [{ id: "acme-1", name: "Acme One" }],
						},
					},
				},
			],
			sessions: [{ id: "s1", title: "First task", workingDir: repo }],
			messages: [
				{ id: "m1", sessionId: "s1", role: "user", content: JSON.stringify({ text: "hello" }) },
				{ id: "m2", sessionId: "s1", role: "assistant", content: JSON.stringify("hi there") },
			],
		});
		const result = runMigration({
			home: fixture.home,
			cwd: repo,
			from: "cindy",
			existing: {},
			historyScope: "all",
		});
		expect(result.error).toBeUndefined();
		const kinds = result.plan.writes.map((write) => write.kind);
		expect(kinds).toContain("settings");
		expect(kinds).toContain("mcp");
		expect(kinds).toContain("history");
		const history = result.plan.writes.find((write) => write.kind === "history");
		expect(history?.content).toContain("hello");
		expect(history?.content).toContain("hi there");
		expect(result.report).toContain("First task");
		// The report names the safeStorage boundary rather than implying the keys
		// moved; and the encrypted prefix never becomes a claim about this build.
		expect(result.report).toContain("OS keyring");
		expect(result.report).toContain("localStorage");
		expect(JSON.stringify(result.plan.writes)).not.toContain("safe-storage:v1:");
	});
});

// ---------------------------------------------------------------------------
// Theme directories
// ---------------------------------------------------------------------------

describe("cindy: local themes", () => {
	test("both spellings are counted, and neither is translated into a theme file", () => {
		const fixture = cindyFixture();
		writeUnder(fixture.home, ".cindy/themes/one.json", "{}");
		writeUnder(fixture.home, ".xdmaker/themes/two.json", "{}");
		expect(cindyThemeDirs(fixture.home)).toEqual([
			join(fixture.home, ".cindy", "themes"),
			join(fixture.home, ".xdmaker", "themes"),
		]);
		const raw = readCindy(fixture.home, fixture.env);
		expect(raw.themeFiles).toBe(2);
		const plan = runMigration({ home: fixture.home, cwd: fixture.home, from: "cindy", existing: {} }).plan;
		const item = plan.items.find((entry) => entry.from.includes("themes"));
		expect(item?.action).toBe("skip");
		expect(item?.detail).toContain("Electron CSS token sets");
		expect(plan.writes.some((write) => write.path.includes("themes"))).toBe(false);
	});
});
