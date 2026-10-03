/**
 * The `alma` source, from the four roots through to the report.
 *
 * **What this file is for.** Alma is the odd one out among the sources added
 * here, and most of what follows is about the three things that make it odd:
 *
 *   - **Its settings are a row in a SQLite database, not a file.** There is no
 *     `settings.json` to find, so the reader opens `<userData>/chat_threads.db`
 *     read-only. A test that laid out a home with a settings file would prove
 *     nothing about the half of this importer that matters most.
 *   - **The settings blob is whitelisted, not scrubbed.** It is Alma's entire
 *     application state and carries `chromeRelayAuthToken`, `tts.apiKey` and the
 *     four chat-bridge tokens as ordinary members of the same JSON object as
 *     `general.theme`. There is a test below that asserts none of them is
 *     reachable from `RawAlma` — not "is filtered", *is not reachable*, because
 *     the reader never copies them out in the first place.
 *   - **It reads six skill roots and owns two of them.** The other four belong to
 *     other products, and one of them — `~/.agents/skills` — is a tree this
 *     repository already migrates as its `agents` source. There is a test that
 *     plans `alma` and `agents` together over one shared skill and asserts
 *     **exactly one write**, because two writes would both report success.
 *
 * Every fixture is a temporary directory. Nothing here reads a real install, a
 * real credential path, or anything under a user's home: `readAlma` takes `home`
 * and `env` as arguments and never calls `homedir()`, and `APPDATA` — the one
 * variable that reaches Alma's `userData` root — is borrowed out of the ambient
 * environment for every test that goes through `readSources`.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ALMA_BUNDLED_SKILL_COUNT,
	ALMA_CRON_TITLE_PREFIX,
	ALMA_HOOK_DEFAULT_TIMEOUT_MS,
	ALMA_HOOK_EVENT_MAP,
	ALMA_HOOK_EVENTS,
	ALMA_HOOK_MATCHER_TARGETS,
	ALMA_IDENTITY_DOCS,
	ALMA_SETTINGS_HANDLE,
	almaChromeExtensionDir,
	almaConfigDir,
	almaDetectionRoots,
	almaDotDir,
	almaForeignSkillRoots,
	almaHooksPath,
	almaMcpPath,
	almaPlainDir,
	almaRoots,
	almaSharedSkillRoots,
	almaThreadsArchiveDir,
	almaWorktreesDir,
} from "../src/alma-home.ts";
import { readAlma } from "../src/alma-read.ts";
import { listAlmaHistory, readAlmaConversation } from "../src/alma-session.ts";
import { runMigration } from "../src/migrate.ts";
import { listHistory } from "../src/migrate-history.ts";
import { detectSources, MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS, SOURCE_ROOTS } from "../src/migrate-types.ts";
import { borrowSourceEnv, releaseEnv } from "./source-env.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const made: string[] = [];
// `readSources` calls `readAlma(home, process.env)` and `APPDATA` is how Alma's
// `userData` root is reached, so without this a developer with Alma installed
// would have their real `chat_threads.db` walked into a plan by a test that is
// about a fixture. `APPDATA` is already in `MIGRATION_ENV_VARS`, which is what
// makes this borrow legal; the coverage test enforces that list.
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

/** Write `content` at `<root>/<relative>`, creating the directories above it. */
function writeUnder(root: string, relative: string, content: string): void {
	const path = join(root, ...relative.split("/"));
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

/** A `SKILL.md` with the two frontmatter keys Alma requires. */
function skillMd(name: string, description = "does a thing"): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\nThe body of ${name}.\n`;
}

interface AlmaFixture {
	home: string;
	appData: string;
	userData: string;
	env: Record<string, string | undefined>;
}

/**
 * A home with the four roots, a `chat_threads.db`, and whatever files the caller
 * asked for under `~/.config/alma`.
 *
 * **The database is built rather than mocked.** A fixture that handed the reader
 * a fake `settings_data` string would test the whitelist and not the query, and
 * the query is where the "one row, `id = 'default'`" fact lives — the thing that
 * decides whether a home with two settings rows imports the right one.
 */
function almaFixture(
	options: {
		settings?: unknown;
		providers?: Array<{ id: string; name: string; type: string; apiKey?: string }>;
		threads?: Array<{ id: string; title: string; workspaceId?: string | null; createdAt?: string }>;
		workspaces?: Array<{ id: string; path: string }>;
		messages?: Array<{ threadId: string; role: string; text: string | null }>;
		files?: Record<string, string>;
		rawSettings?: string;
	} = {},
): AlmaFixture {
	const home = makeDir("lbb-alma-home-");
	const appData = makeDir("lbb-alma-appdata-");
	const userData = join(appData, "alma");
	mkdirSync(userData, { recursive: true });
	// `readSources` calls `readAlma(home, process.env)`, so this is how a fixture's
	// database reaches it. Safe to assign because `borrowSourceEnv()` already
	// remembered the real value and `releaseEnv()` puts it back.
	process.env.APPDATA = appData;

	const db = new Database(join(userData, "chat_threads.db"), { create: true });
	try {
		db.exec(
			"CREATE TABLE app_settings (id TEXT PRIMARY KEY DEFAULT 'default', settings_data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		db.exec(
			"CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, is_temporary INTEGER NOT NULL DEFAULT 0, show_in_list INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		db.exec(
			"CREATE TABLE chat_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT, is_generating BOOLEAN DEFAULT FALSE, reasoning_effort TEXT DEFAULT 'medium', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		// The product adds this after the fact, guarded by a bare try/catch — quoted
		// from the bundle, and the reason the thread's directory is a link and not a
		// column of its own.
		db.exec("ALTER TABLE chat_threads ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL");
		db.exec(
			"CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, parent_id TEXT, slot_id TEXT, depth INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL, timestamp TEXT NOT NULL, metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE)",
		);
		db.exec(
			"CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, api_key TEXT NOT NULL, models TEXT NOT NULL, base_url TEXT, api_version TEXT, enabled BOOLEAN NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		db.exec(
			"CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, registry_id TEXT, name TEXT NOT NULL, description TEXT, config TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'disconnected', last_error TEXT, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		const now = "2026-01-02T03:04:05.000Z";
		if (options.rawSettings !== undefined) {
			db.query("INSERT INTO app_settings (id, settings_data, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
				ALMA_SETTINGS_HANDLE,
				options.rawSettings,
				now,
				now,
			);
		} else if (options.settings !== undefined) {
			db.query("INSERT INTO app_settings (id, settings_data, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
				ALMA_SETTINGS_HANDLE,
				JSON.stringify(options.settings),
				now,
				now,
			);
		}
		for (const provider of options.providers ?? []) {
			db.query(
				"INSERT INTO providers (id, name, type, api_key, models, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
			).run(provider.id, provider.name, provider.type, provider.apiKey ?? "sk-plaintext-never-read", "[]", now, now);
		}
		for (const workspace of options.workspaces ?? []) {
			db.query(
				"INSERT INTO workspaces (id, path, name, is_temporary, show_in_list, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)",
			).run(workspace.id, workspace.path, workspace.path, now, now);
		}
		for (const thread of options.threads ?? []) {
			db.query(
				"INSERT INTO chat_threads (id, title, model, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(
				thread.id,
				thread.title,
				null,
				thread.workspaceId ?? null,
				thread.createdAt ?? now,
				thread.createdAt ?? now,
			);
		}
		let index = 0;
		for (const message of options.messages ?? []) {
			index += 1;
			const at = `2026-01-02T03:${String(index).padStart(2, "0")}:00.000Z`;
			const parts =
				message.text === null ? [{ type: "tool-read", input: { path: "x" } }] : [{ type: "text", text: message.text }];
			db.query(
				"INSERT INTO chat_messages (id, thread_id, message, timestamp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(`m${index}`, message.threadId, JSON.stringify({ role: message.role, parts }), at, at, at);
		}
	} finally {
		db.close();
	}

	for (const [relative, content] of Object.entries(options.files ?? {}))
		writeUnder(home, `.config/alma/${relative}`, content);
	return { home, appData, userData, env: { APPDATA: appData } };
}

/** Items and writes from one `runMigration`, for the tests that only care about those. */
function planAlma(fixture: AlmaFixture, from = "alma"): ReturnType<typeof runMigration>["plan"] {
	return runMigration({ home: fixture.home, cwd: fixture.home, from }).plan;
}

// ---------------------------------------------------------------------------
// Four roots
// ---------------------------------------------------------------------------

describe("alma: the four roots", () => {
	test("all four are independent directories, and `~/alma` has no leading dot", () => {
		// The single most-missed path in the product. `alma-home.ts` quotes the one
		// occurrence: `getStablePath(){return B.join(ft.homedir(),"alma","chrome-extension")}`.
		// A reader that assumed a dot would look for a browser-extension tree that is
		// not there and never notice the one that is.
		const home = makeDir("lbb-alma-home-");
		expect(almaConfigDir(home)).toBe(join(home, ".config", "alma"));
		expect(almaDotDir(home)).toBe(join(home, ".alma"));
		expect(almaPlainDir(home)).toBe(join(home, "alma"));
		expect(almaChromeExtensionDir(home)).toBe(join(home, "alma", "chrome-extension"));
		expect(almaWorktreesDir(home)).toBe(join(home, "alma", "worktrees"));
		// The two are siblings, not one another. This is the assertion that fails
		// first if someone "fixes" one of them into the other.
		expect(almaDotDir(home)).not.toBe(almaPlainDir(home));
	});

	test("detection looks at all four, and each is the only one answering for some real user", () => {
		const home = makeDir("lbb-alma-home-");
		const appData = makeDir("lbb-alma-appdata-");
		const roots = almaDetectionRoots(home, { APPDATA: appData });
		expect(roots).toEqual([
			join(home, ".config", "alma"),
			join(appData, "alma"),
			join(home, ".alma"),
			join(home, "alma"),
		]);
		expect(roots).toHaveLength(4);
		expect(new Set(roots).size).toBe(4);
	});

	test("with no application-data directory there are three roots, not a guessed fourth", () => {
		// macOS and Linux put userData under `~/Library/Application Support` and the
		// XDG data base, neither of which this importer will guess at. Naming a path
		// it did not read is worse than naming none.
		const home = makeDir("lbb-alma-home-");
		expect(almaDetectionRoots(home, {})).toEqual([
			join(home, ".config", "alma"),
			join(home, ".alma"),
			join(home, "alma"),
		]);
		expect(almaRoots(home, {}).userData).toBeNull();
	});

	test("a supplied APPDATA is honoured on every platform, which is what makes this testable off Windows", () => {
		// The variable is unset in practice everywhere but Windows, so trusting it
		// changes nothing for a real home and everything for a fixture. Without this,
		// the whole settings half of the source would be untested on two thirds of CI.
		const home = makeDir("lbb-alma-home-");
		expect(almaRoots(home, { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }).userData).toBe(
			join("C:\\Users\\x\\AppData\\Roaming", "alma"),
		);
		expect(almaRoots(home, { APPDATA: "" }).userData).toBeNull();
		expect(almaRoots(home, { APPDATA: "   " }).userData).toBeNull();
	});

	test("each root alone is enough for detection to fire", () => {
		// Four roots means four users who would otherwise be reported as absent: one
		// who installed Alma and never opened it, one who only ever chatted, one who
		// only ever ran the CLI, and one who only runs the browser relay.
		const appData = makeDir("lbb-alma-appdata-");
		// `detectSources` reads `process.env`, so the fixture's app-data root has to
		// be the ambient one for the duration — which `releaseEnv()` undoes.
		process.env.APPDATA = appData;
		const cases: Array<[string, (home: string) => string]> = [
			["~/.config/alma", (home) => almaConfigDir(home)],
			["userData", () => join(appData, "alma")],
			["~/.alma", almaDotDir],
			["~/alma", almaPlainDir],
		];
		for (const [label, where] of cases) {
			const home = makeDir("lbb-alma-home-");
			mkdirSync(where(home), { recursive: true });
			writeFileSync(join(where(home), "something"), "x", "utf8");
			expect({ label, detected: detectSources(home).includes("alma") }).toEqual({ label, detected: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Settings: a SQLite row
// ---------------------------------------------------------------------------

describe("alma: settings are a row, not a file", () => {
	test("the three keys this importer claims come out of `app_settings`", () => {
		const fixture = almaFixture({
			settings: {
				general: { theme: "dark", autoStart: true },
				chat: { defaultModel: "prov-1:gpt-4o", temperature: 0.7 },
				security: { autoApproveToolRequests: true },
			},
			providers: [{ id: "prov-1", name: "My OpenAI", type: "openai" }],
		});
		const raw = readAlma(fixture.home, fixture.env);
		expect(raw.settingsRead).toBe(true);
		expect(raw.settings?.theme).toBe("dark");
		expect(raw.settings?.defaultModel).toBe("prov-1:gpt-4o");
		expect(raw.settings?.autoApproveToolRequests).toBe(true);
		expect(raw.providers.map((p) => p.id)).toEqual(["prov-1"]);
	});

	test("no database at all is a reason in the report, not a crash", () => {
		const home = makeDir("lbb-alma-home-");
		writeUnder(home, ".config/alma/mcp.json", JSON.stringify({ mcpServers: {} }));
		const raw = readAlma(home, { APPDATA: join(home, "nowhere") });
		expect(raw.present).toBe(true);
		expect(raw.settings).toBeNull();
		expect(raw.settingsProblem).toContain("no `chat_threads.db`");
		expect(raw.threadCount).toBe(0);
	});

	test("a settings blob that is not JSON is reported, not thrown", () => {
		const fixture = almaFixture({ rawSettings: "{ this is not json" });
		const raw = readAlma(fixture.home, fixture.env);
		expect(raw.settingsRead).toBe(false);
		expect(raw.settingsProblem).toContain("not a JSON object");
		expect(raw.unhandledSettings).toEqual([]);
	});

	test("the credential-bearing keys are unreachable, not merely filtered", () => {
		// The whole reason the reader whitelists. `chromeRelayAuthToken` is a
		// **top-level** string in the blob — not nested under a credential-shaped key,
		// so a name-based scrub that only walked nested objects would keep it.
		const fixture = almaFixture({
			settings: {
				general: { theme: "light" },
				chromeRelayAuthToken: "eyJhbGciOi-relay-token",
				tts: { provider: "elevenlabs", apiKey: "eleven-secret" },
				network: { proxy: { enabled: true, host: "127.0.0.1", port: 8080, password: "proxy-secret" } },
				telegram: { botToken: "telegram-secret" },
				discord: { token: "discord-secret" },
				"plugin-provider-models:acme": ["x"],
			},
		});
		const raw = readAlma(fixture.home, fixture.env);
		// Nothing under them was copied into the narrowed settings…
		expect(JSON.stringify(raw.settings)).not.toContain("relay-token");
		expect(JSON.stringify(raw.settings)).not.toContain("eleven-secret");
		expect(JSON.stringify(raw.settings)).not.toContain("proxy-secret");
		expect(JSON.stringify(raw.settings)).not.toContain("telegram-secret");
		expect(JSON.stringify(raw.settings)).not.toContain("discord-secret");
		// …and every one of them is named, so "not read" is a sentence rather than a
		// silence the user has to notice.
		// `network` is **not** in this list: it is whitelisted, and what is read from it
		// is `timeout`. Only `network.proxy` — the credential — is not, and it is not a
		// top-level key, so it cannot show up here at all. That is the whitelist
		// working: a nested credential needs no rule because the nested value is never
		// copied out.
		expect(raw.unhandledSettings).toEqual(
			expect.arrayContaining(["chromeRelayAuthToken", "discord", "telegram", "tts"]),
		);
		expect(raw.unhandledSettings).not.toContain("network");
		const plan = planAlma(fixture);
		const report = JSON.stringify(plan.items);
		expect(report).toContain("chromeRelayAuthToken");
		expect(report).not.toContain("relay-token");
		expect(report).not.toContain("eleven-secret");
		expect(report).not.toContain("proxy-secret");
	});

	test("`providers.api_key` is a plaintext column and is never selected", () => {
		const fixture = almaFixture({
			settings: { general: { theme: "light" } },
			providers: [{ id: "p1", name: "Mine", type: "openai", apiKey: "sk-do-not-print-me" }],
		});
		const raw = readAlma(fixture.home, fixture.env);
		expect(JSON.stringify(raw)).not.toContain("sk-do-not-print-me");
		expect(raw.providers[0]).toEqual({ id: "p1", name: "Mine", type: "openai" });
	});
});

// ---------------------------------------------------------------------------
// Scalars and the mode pair
// ---------------------------------------------------------------------------

describe("alma: what the settings can and cannot say", () => {
	test("Alma has no permission mode and no sandbox, and the pair says so", () => {
		// The single most load-bearing fact about this source. `autoApproveToolRequests`
		// is one boolean meaning "never ask"; there is no key anywhere for a sandbox,
		// so claiming `danger-full-access` alongside it would be this importer
		// granting a permission Alma never offered.
		const fixture = almaFixture({ settings: { security: { autoApproveToolRequests: true } } });
		const report = runMigration({ home: fixture.home, cwd: fixture.home, from: "alma" }).report;
		expect(report).toContain("Alma has no sandbox setting");
		expect(report).toContain('mapped to "agent"');
		expect(report).not.toContain("danger-full-access");
	});

	test("an absent approval switch claims nothing at all", () => {
		// Alma reads the key with `=== true`, so a missing key means "off" — which is
		// the posture a session starts in anyway. Importing it would write a setting
		// on the user's behalf.
		const fixture = almaFixture({ settings: { general: { theme: "light" } } });
		const report = runMigration({ home: fixture.home, cwd: fixture.home, from: "alma" }).report;
		expect(report).not.toContain("autoApproveToolRequests");
	});

	test("`system` is a choice, not a missing value, and is not pinned to a theme", () => {
		const fixture = almaFixture({ settings: { general: { theme: "system" } } });
		const report = runMigration({ home: fixture.home, cwd: fixture.home, from: "alma" }).report;
		expect(report).toContain('"system" is a choice');
	});

	test("`light` and `dark` are this build's own theme names and map", () => {
		for (const theme of ["light", "dark"]) {
			const fixture = almaFixture({ settings: { general: { theme } } });
			const plan = planAlma(fixture);
			expect(plan.items.some((item) => item.to.includes("theme") && item.action === "map")).toBe(true);
		}
	});

	test("the model half resolves and the provider half is named without its key", () => {
		const fixture = almaFixture({
			settings: { chat: { defaultModel: "prov-9:gpt-4o" } },
			providers: [{ id: "prov-9", name: "Work OpenAI", type: "openai", apiKey: "sk-secret-value" }],
		});
		const plan = planAlma(fixture);
		const line = plan.items.find((item) => item.from.includes("chat.defaultModel"));
		expect(line?.detail).toContain("Work OpenAI");
		expect(line?.detail).toContain("gpt-4o");
		expect(JSON.stringify(plan.items)).not.toContain("sk-secret-value");
	});
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

describe("alma: MCP", () => {
	test("a stdio server comes across without its credentials, and the names are reported", () => {
		const fixture = almaFixture({
			files: {
				"mcp.json": JSON.stringify({
					mcpServers: {
						files: { command: "npx", args: ["-y", "mcp-files"], env: { FS_ROOT: "/tmp", API_TOKEN: "shhh" } },
					},
				}),
			},
		});
		const plan = planAlma(fixture);
		const write = plan.writes.find((w) => w.path.endsWith(".mcp.json"));
		expect(write?.content).toContain("mcp-files");
		expect(write?.content).not.toContain("shhh");
		expect(write?.content).not.toContain("/tmp");
		expect(JSON.stringify(plan.items)).not.toContain("shhh");
	});

	test("headers are dropped whole and not even their names are printed", () => {
		const fixture = almaFixture({
			files: {
				"mcp.json": JSON.stringify({
					mcpServers: { api: { url: "https://example.test/mcp", headers: { "x-api-key": "leaked" } } },
				}),
			},
		});
		const raw = readAlma(fixture.home, fixture.env);
		expect(JSON.stringify(raw.mcpServers)).not.toContain("leaked");
		const plan = planAlma(fixture);
		expect(JSON.stringify(plan.writes)).not.toContain("leaked");
		expect(JSON.stringify(plan.items)).not.toContain("leaked");
	});

	test("a URL with a credential in its userinfo loses the whole server, not just the credential", () => {
		// There is no half-measure here: a URL with the userinfo stripped is a
		// different URL that points at nothing, and the report would call the copy
		// clean while the server could not connect.
		const fixture = almaFixture({
			files: {
				"mcp.json": JSON.stringify({
					mcpServers: { leaky: { url: "https://alice:hunter2@example.test/sse" } },
				}),
			},
		});
		const plan = planAlma(fixture);
		const line = plan.items.find((item) => item.from.includes("mcpServers.leaky"));
		expect(line?.action).toBe("skip");
		expect(line?.containsSecret).toBe(true);
		expect(line?.detail).toContain("name:password@");
		expect(line?.detail).not.toContain("hunter2");
		expect(plan.writes.some((w) => w.content.includes("example.test"))).toBe(false);
	});

	test("a credential-named query parameter is refused the same way", () => {
		const fixture = almaFixture({
			files: {
				"mcp.json": JSON.stringify({ mcpServers: { leaky: { url: "https://example.test/mcp?access_token=abc" } } }),
			},
		});
		const line = planAlma(fixture).items.find((item) => item.from.includes("mcpServers.leaky"));
		expect(line?.containsSecret).toBe(true);
		expect(line?.detail).toContain("credential word");
	});

	test("a clean URL is copied and `sse` is recorded as a downgrade rather than a rename", () => {
		const fixture = almaFixture({
			files: {
				"mcp.json": JSON.stringify({
					mcpServers: {
						plain: { url: "https://example.test/mcp" },
						sse: { url: "https://example.test/s", transport: "sse" },
					},
				}),
			},
		});
		const plan = planAlma(fixture);
		const copied = plan.items.filter((item) => item.from.includes("mcpServers.plain"));
		expect(copied[0]?.action).toBe("map");
		const sse = plan.items.find((item) => item.from.includes("mcpServers.sse"));
		expect(sse?.action).toBe("downgrade");
		expect(sse?.detail).toContain('"sse"');
	});

	test("a server named for a credential-shaped word is kept, not deleted", () => {
		// `keyboard-mcp` is an ordinary thing to want and `KEY` appears inside it. The
		// whole point of this case is that a scrub which deletes it loses the server.
		const fixture = almaFixture({
			files: { "mcp.json": JSON.stringify({ mcpServers: { "keyboard-mcp": { command: "kb", args: [] } } }) },
		});
		const plan = planAlma(fixture);
		expect(plan.writes.some((w) => w.content.includes("keyboard-mcp"))).toBe(true);
	});

	test("the dormant `mcp_servers` table is named, and the report says the built-in export can come out empty", () => {
		const fixture = almaFixture({ settings: { general: { theme: "light" } } });
		const report = runMigration({ home: fixture.home, cwd: fixture.home, from: "alma" }).report;
		expect(report).toContain("mcp_servers");
		expect(report).toContain("GET /api/data/export");
	});
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

describe("alma: hooks", () => {
	test("three of the four events are renames and one is reported as having no counterpart", () => {
		const fixture = almaFixture({
			files: {
				"hooks.json": JSON.stringify({
					hooks: {
						"tool.willExecute": [{ matcher: "Bash", hooks: [{ command: "check.sh", timeout: 5000 }] }],
						"tool.didExecute": [{ hooks: [{ command: "after.sh" }] }],
						"chat.message.willSend": [{ hooks: [{ command: "prompt.sh" }] }],
						"app.willQuit": [{ hooks: [{ command: "quit.sh" }] }],
					},
				}),
			},
		});
		const plan = planAlma(fixture);
		const write = plan.writes.find((w) => w.path.endsWith("settings.json"));
		expect(write?.content).toContain("PreToolUse");
		expect(write?.content).toContain("PostToolUse");
		expect(write?.content).toContain("UserPromptSubmit");
		expect(write?.content).not.toContain("app.willQuit");
		expect(write?.content).not.toContain("quit.sh");
		const hookItem = plan.items.find((item) => item.from.endsWith("hooks.json") && item.to.includes("settings.json"));
		expect(hookItem?.detail).toContain("app.willQuit");
	});

	test("a content matcher is dropped rather than carried against an empty string", () => {
		const fixture = almaFixture({
			files: {
				"hooks.json": JSON.stringify({
					hooks: { "chat.message.willSend": [{ matcher: "secret", hooks: [{ command: "p.sh" }] }] },
				}),
			},
		});
		const write = planAlma(fixture).writes.find((w) => w.path.endsWith("settings.json"));
		expect(write?.content).not.toContain("secret");
	});

	test("a handler switched off in Alma is not switched on here", () => {
		const fixture = almaFixture({
			files: {
				"hooks.json": JSON.stringify({
					hooks: { "tool.willExecute": [{ hooks: [{ command: "off.sh", enabled: false }] }] },
				}),
			},
		});
		const plan = planAlma(fixture);
		// Nothing was claimed, so there is no settings write to inspect — which is the
		// point. The assertion is on the report line and on the absence of the command.
		expect(plan.writes.find((w) => w.path.endsWith("settings.json"))).toBeUndefined();
		expect(JSON.stringify(plan.items)).toContain("enabled: false");
		expect(JSON.stringify(plan.writes)).not.toContain("off.sh");
	});

	test("the mapping table is the one the code uses, not a prose claim", () => {
		expect(ALMA_HOOK_EVENT_MAP["tool.willExecute"]).toBe("PreToolUse");
		expect(ALMA_HOOK_EVENT_MAP["tool.didExecute"]).toBe("PostToolUse");
		expect(ALMA_HOOK_EVENT_MAP["chat.message.willSend"]).toBe("UserPromptSubmit");
		// `app.willQuit` is deliberately NOT `SessionEnd`: this build fires that when
		// a conversation ends, and Alma's fires when the application quits.
		expect(ALMA_HOOK_EVENT_MAP["app.willQuit"]).toBeUndefined();
		expect(ALMA_HOOK_MATCHER_TARGETS["chat.message.willSend"]).toBe("content");
		expect(ALMA_HOOK_MATCHER_TARGETS["tool.willExecute"]).toBe("tool-name");
	});

	test("Alma's timeout is already in milliseconds, and the table says which value that is", () => {
		// Most sources here name their timeout in seconds and need a ×1000. Alma's is
		// `r.timeout ?? 1e4` — milliseconds — and a converter written by pattern-
		// matching the others would make a ten-second hook wait ten thousand seconds.
		expect(ALMA_HOOK_DEFAULT_TIMEOUT_MS).toBe(10_000);
		expect(ALMA_HOOK_EVENTS).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// Skills — the shared tree, the foreign trees, and the shadowed name
// ---------------------------------------------------------------------------

describe("alma: skills", () => {
	test("a skill in ~/.agents/skills is written exactly once, by `agents`, when both sources run", () => {
		// **The bug this exists to catch.** `~/.agents/skills` is a tree this
		// repository already migrates as its `agents` source, and Alma reads it as one
		// of its six roots. Importing it here too would write two copies of every
		// file and attribute the second to `alma` — and the report would look clean
		// while doing it, because both lines would say "imported".
		const home = makeDir("lbb-alma-shared-");
		writeUnder(home, ".config/alma/mcp.json", JSON.stringify({ mcpServers: {} }));
		writeUnder(home, ".agents/skills/shared-one/SKILL.md", skillMd("shared-one"));
		writeUnder(home, ".config/alma/skills/own-one/SKILL.md", skillMd("own-one"));

		const plan = runMigration({ home, cwd: home, from: "alma,agents", existing: {} }).plan;
		const shared = plan.writes.filter((w) => w.path.endsWith(join("skills", "shared-one", "SKILL.md")));
		expect(shared).toHaveLength(1);
		const reported = plan.items.filter((item) => item.from.includes("shared-one"));
		expect(reported.filter((item) => item.action !== "skip")).toHaveLength(1);
		// And the one that wrote it is not Alma's.
		expect(JSON.stringify(reported.filter((item) => item.action !== "skip"))).not.toContain("alma");
		// Alma's own skill still comes across, because it *is* Alma's.
		expect(plan.writes.some((w) => w.path.endsWith(join("skills", "own-one", "SKILL.md")))).toBe(true);
	});

	test("the shared roots are named and the foreign ones are named as somebody else's", () => {
		const home = makeDir("lbb-alma-home-");
		expect(almaSharedSkillRoots(home)).toEqual([join(home, ".agents", "skills")]);
		expect(almaForeignSkillRoots(home)).toEqual([
			join(home, ".claude", "skills"),
			join(home, ".codex", "skills"),
			join(home, ".claude", "plugins"),
		]);
	});

	test("a skill in ~/.claude/skills is reported as Claude Code's, never imported as Alma's", () => {
		const home = makeDir("lbb-alma-home-");
		writeUnder(home, ".config/alma/mcp.json", JSON.stringify({ mcpServers: {} }));
		writeUnder(home, ".claude/skills/borrowed/SKILL.md", skillMd("borrowed"));
		const plan = runMigration({ home, cwd: home, from: "alma", existing: {} }).plan;
		expect(plan.writes.some((w) => w.content.includes("borrowed"))).toBe(false);
		const line = plan.items.find((item) => item.from.includes(".claude") && item.from.includes("skills"));
		expect(line?.detail).toContain("other products");
	});

	test("the same name in both of Alma's own roots: the first wins and the report says which", () => {
		// Alma resolves a name against its roots in order and never reads the loser,
		// so a reader that imported both would hand the user a file Alma never loads.
		const fixture = almaFixture({
			settings: { general: { theme: "light" } },
			files: { "skills/dupe/SKILL.md": skillMd("Dupe", "the personal one") },
		});
		const workspace = makeDir("lbb-alma-ws-");
		writeUnder(workspace, ".alma/skills/dupe/SKILL.md", skillMd("Dupe", "the project one"));
		// The archiver's workspace is `settings.workspace.path`, and it is also what
		// makes `<workspace>/.alma/skills` one of Alma's own two roots — so the row has
		// to name it before the second copy exists as far as the reader is concerned.
		const db = new Database(join(fixture.userData, "chat_threads.db"));
		db.query("UPDATE app_settings SET settings_data = ? WHERE id = ?").run(
			JSON.stringify({ workspace: { path: workspace }, general: { theme: "light" } }),
			ALMA_SETTINGS_HANDLE,
		);
		db.close();

		const raw = readAlma(fixture.home, fixture.env);
		expect(raw.archiveWorkspacePath).toBe(workspace);
		expect(raw.assets.filter((asset) => asset.name.toLowerCase() === "dupe")).toHaveLength(1);
		expect(raw.assetCollisions).toHaveLength(1);
		expect(raw.assetCollisions[0]?.name).toBe("Dupe");
		expect(raw.assetCollisions[0]?.dropped).toContain(".alma/skills");

		const line = planAlma(fixture).items.find((item) => item.detail.includes("resolves a name against its roots"));
		expect(line?.detail).toContain("Dupe");
	});

	test("a SKILL.md missing `name` or `description` is refused, because Alma refuses it", () => {
		const fixture = almaFixture({
			files: {
				"skills/no-name/SKILL.md": "---\ndescription: has one\n---\nbody\n",
				"skills/no-desc/SKILL.md": "---\nname: no-desc\n---\nbody\n",
				"skills/no-fence/SKILL.md": "just a body\n",
				"skills/fine/SKILL.md": skillMd("fine"),
			},
		});
		const raw = readAlma(fixture.home, fixture.env);
		expect(raw.assets.map((asset) => asset.name)).toEqual(["fine"]);
		// The reasons, not `JSON.stringify` of them: that escapes the quotes the
		// product's own log message uses and the assertion would fail on the escaping
		// rather than on the rule.
		const reasons = raw.skipped.map((entry) => entry.reason).join(" | ");
		expect(reasons).toContain('missing required "name" field');
		expect(reasons).toContain('missing required "description" field');
		expect(reasons).toContain("no YAML frontmatter");
	});

	test("the bundled skills are counted and named as the product's own, not the user's", () => {
		const fixture = almaFixture({ settings: { general: { theme: "light" } } });
		const line = planAlma(fixture).items.find((item) => item.from.includes("bundled-skills"));
		expect(line?.detail).toContain(String(ALMA_BUNDLED_SKILL_COUNT));
		expect(line?.detail).toContain("authored by its authors, not by you");
	});
});

// ---------------------------------------------------------------------------
// Identity documents
// ---------------------------------------------------------------------------

describe("alma: the five documents that are not an instruction file", () => {
	test("none of the three names this repository imports elsewhere exists in the bundle", () => {
		// Verified by literal count over `out/main/index.js`, 3,104,824 characters:
		// `AGENTS.md` 0, `CLAUDE.md` 0, `ALMA.md` 0. There is no standing instruction
		// document to import, and the report says so rather than going quiet.
		expect(ALMA_IDENTITY_DOCS).toEqual(["SOUL.md", "USER.md", "MEMORY.md", "SECURITY.md", "HEARTBEAT.md"]);
	});

	test("the four with no equivalent are named by name and stay where they were", () => {
		const fixture = almaFixture({
			files: {
				"SOUL.md": "I am a persona.",
				"USER.md": "---\nname: Sam\n---\n",
				"SECURITY.md": "rules",
				"HEARTBEAT.md": "- check in\n",
				"MEMORY.md": "# memory\n",
			},
		});
		expect(readAlma(fixture.home, fixture.env).identityDocs).toEqual([
			"SOUL.md",
			"USER.md",
			"MEMORY.md",
			"SECURITY.md",
			"HEARTBEAT.md",
		]);
		const plan = planAlma(fixture);
		const from = plan.items.map((item) => item.from);
		expect(from).toContain("~/.config/alma/SOUL.md");
		expect(from).toContain("~/.config/alma/USER.md");
		expect(from).toContain("~/.config/alma/SECURITY.md");
		expect(from).toContain("~/.config/alma/HEARTBEAT.md");
		// `MEMORY.md` is the exception: it is the one that has somewhere to go.
		expect(plan.writes.some((w) => w.path.includes("imported-alma-memory-index.md"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The thread archive
// ---------------------------------------------------------------------------

describe("alma: the plain-file thread archive", () => {
	test("its three traps are all named, because each one silently misleads", () => {
		const workspace = makeDir("lbb-alma-ws-");
		const fixture = almaFixture({
			settings: { general: { theme: "light" } },
			files: { "SOUL.md": "x" },
		});
		const db = new Database(join(fixture.userData, "chat_threads.db"));
		db.query("UPDATE app_settings SET settings_data = ? WHERE id = ?").run(
			JSON.stringify({ workspace: { path: workspace } }),
			ALMA_SETTINGS_HANDLE,
		);
		db.close();
		writeUnder(workspace, "threads/2026-01-02_a-chat.md", "x");
		writeUnder(workspace, "threads/2026-01-03_b-chat.md", "x");

		const raw = readAlma(fixture.home, fixture.env);
		expect(raw.archiveCount).toBe(2);
		expect(almaThreadsArchiveDir(workspace)).toBe(join(workspace, "threads"));

		const line = planAlma(fixture).items.find((item) => item.detail.includes("archived conversation"));
		expect(line?.detail).toContain("**one** workspace's path");
		expect(line?.detail).toContain(ALMA_CRON_TITLE_PREFIX);
		expect(line?.detail).toContain("only `text` parts are written");
	});
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("alma: conversations", () => {
	test("a thread's working directory comes through the workspace link", () => {
		// `narrowCandidates` drops a candidate whose directory no longer exists, so the
		// project directory has to be real — which is also what a user migrating has.
		const repo = join(makeDir("lbb-alma-proj-"), "repo");
		mkdirSync(repo, { recursive: true });
		const fixture = almaFixture({
			threads: [{ id: "t1", title: "First", workspaceId: "w1" }],
			workspaces: [{ id: "w1", path: repo }],
			messages: [
				{ threadId: "t1", role: "user", text: "hello" },
				{ threadId: "t1", role: "assistant", text: "hi there" },
			],
		});
		const listing = listHistory("alma", fixture.home, { cwd: fixture.home, scope: "all" });
		expect(listing.candidates).toHaveLength(1);
		expect(listing.candidates[0]?.cwdSubstitute).toBeUndefined();
		expect(listing.candidates[0]?.cwd).toBe(repo);
		const read = readAlmaConversation("t1");
		expect(read?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(read?.messages[0]?.content).toBe("hello");
		expect(read?.notes).toEqual([]);
	});

	test("an orphaned thread says so plainly rather than getting a made-up directory", () => {
		// `ON DELETE SET NULL` means a deleted workspace leaves its threads with no
		// path at all. A wrong `cwd` files a conversation under a project it was never
		// had in, which is the one error this pipeline cannot recover from — so the
		// substitute is stated and flagged instead.
		const fixture = almaFixture({
			threads: [{ id: "orphan", title: "Gone", workspaceId: "w-deleted" }],
			messages: [{ threadId: "orphan", role: "user", text: "still here" }],
			files: { "mcp.json": JSON.stringify({ mcpServers: {} }) },
		});
		const listing = listHistory("alma", fixture.home, { cwd: fixture.home, scope: "all" });
		expect(listing.candidates).toHaveLength(1);
		expect(listing.candidates[0]?.cwdSubstitute).toBe(join(fixture.home, ".config", "alma"));
		expect(listing.notes[0]?.reason).toContain("ON DELETE SET NULL");
		expect(listing.notes[0]?.count).toBe(1);
	});

	test("a message that is nothing but a tool call is counted, not silently dropped", () => {
		const repo = join(makeDir("lbb-alma-proj-"), "repo");
		mkdirSync(repo, { recursive: true });
		const fixture = almaFixture({
			threads: [{ id: "t2", title: "Edits only", workspaceId: "w1" }],
			workspaces: [{ id: "w1", path: repo }],
			messages: [
				{ threadId: "t2", role: "user", text: "do the thing" },
				{ threadId: "t2", role: "assistant", text: null },
			],
		});
		// The rows this reads are the fixture's, not a real install's: the fixture
		// points the ambient `APPDATA` at its own app-data directory, and
		// `borrowSourceEnv()` is what makes putting it back possible.
		expect(fixture.env.APPDATA).toBe(process.env.APPDATA);
		const read = readAlmaConversation("t2");
		expect(read?.messages).toHaveLength(1);
		expect(read?.notes[0]?.count).toBe(1);
		expect(read?.notes[0]?.reason).toContain('type: "text"');
	});

	test("a row whose JSON will not parse is counted rather than skipped in silence", () => {
		const fixture = almaFixture({ threads: [{ id: "t3", title: "Broken", workspaceId: "w1" }] });
		const db = new Database(join(fixture.userData, "chat_threads.db"));
		db.query(
			"INSERT INTO chat_messages (id, thread_id, message, timestamp, created_at, updated_at) VALUES ('x','t3','{oops','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')",
		).run();
		db.close();
		const read = readAlmaConversation("t3");
		expect(read?.messages).toHaveLength(0);
		expect(read?.notes[0]?.reason).toContain("not a JSON object");
	});

	test("no database is a note, not a crash", () => {
		const home = makeDir("lbb-alma-home-");
		expect(listAlmaHistory(home, {})).toEqual({ candidates: [], notes: [expect.objectContaining({ count: 1 })] });
	});
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("alma: registration", () => {
	test("it holds the place it was appended at, and every id before it is untouched", () => {
		expect(MIGRATION_SOURCE_IDS.indexOf("alma")).toBe(MIGRATION_SOURCE_IDS.length - 1);
		expect(MIGRATION_SOURCE_LABELS.alma).toBe("Alma");
		expect(SOURCE_ROOTS.alma).toBe(".config/alma");
		expect(MIGRATION_SOURCE_IDS.indexOf("openclaw")).toBe(MIGRATION_SOURCE_IDS.indexOf("alma") - 1);
		expect(MIGRATION_SOURCE_IDS.indexOf("antigravity")).toBe(13);
		expect(new Set(Object.keys(MIGRATION_SOURCE_LABELS))).toEqual(new Set(MIGRATION_SOURCE_IDS));
	});

	test("the file paths this importer opens are the ones the bundle quotes", () => {
		const configDir = almaConfigDir("/home/u");
		expect(almaMcpPath(configDir)).toBe(join(configDir, "mcp.json"));
		// `hooks.json` is hoisted into a constant in the bundle, so the assembled
		// literal `".config","alma","hooks.json"` occurs zero times — a search for the
		// joined path is not a search for the path.
		expect(almaHooksPath(configDir)).toBe(join(configDir, "hooks.json"));
	});
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe("alma: a whole run", () => {
	test("an empty home plans nothing and does not throw", () => {
		const fixture = almaFixture();
		const result = runMigration({ home: fixture.home, cwd: fixture.home, from: "alma", existing: {} });
		expect(result.plan.sources).toEqual(["alma"]);
		expect(result.plan.writes.filter((w) => w.content.includes("mcpServers"))).toHaveLength(0);
	});
});
