import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { detectSources, runMigration } from "../src/migrate.ts";
import { loadSettings } from "../src/settings.ts";
import {
	ZCODE_BETA_DIR,
	ZCODE_DEFAULT_DIR,
	zcodeBetaDir,
	zcodeCliConfigDir,
	zcodeCliDir,
	zcodeDbPath,
	zcodeRoot,
	zcodeStorageDir,
} from "../src/zcode-home.ts";
import { zcodeReachableCommands } from "../src/zcode-plan.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

/**
 * Run `body` against a throwaway home seeded with `tree`. `seed` runs after the
 * files exist, which is where the sqlite fixture is built: a database cannot be
 * expressed as a string in `tree`.
 */
function withHome(tree: SourceTree, body: (home: string) => void, seed?: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-zcode-"));
	// ZCode's two roots are answered by environment variables, so a test must not
	// inherit whatever the developer's shell holds: every fixture below plants its
	// tree under `~/.zcode`, and a set `ZCODE_DATA_BASE_DIR` or `ZCODE_STORAGE_DIR`
	// would move that tree out from under the whole file. A test that wants one
	// sets it itself, and this restores whatever was there before.
	const borrowed = new Map<string, string | undefined>(
		["USERPROFILE", "HOME", "ZCODE_DATA_BASE_DIR", "ZCODE_STORAGE_DIR"].map((name) => [name, process.env[name]]),
	);
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		delete process.env.ZCODE_DATA_BASE_DIR;
		delete process.env.ZCODE_STORAGE_DIR;
		for (const [path, content] of Object.entries(tree)) {
			const full = join(home, path);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, content);
		}
		seed?.(home);
		body(home);
	} finally {
		for (const [name, value] of borrowed) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(home, { recursive: true, force: true });
	}
}

const ZCODE_CONFIG = JSON.stringify({
	provider: {
		anthropic: {
			name: "Anthropic",
			kind: "anthropic",
			enabled: true,
			options: { apiKey: "sk-ant-imported", baseURL: "https://z.ai/api/v1", apiKeyRequired: true },
			models: { "claude-opus-5": { limit: { context: 200000 } } },
		},
		glm: {
			name: "GLM",
			kind: "anthropic",
			enabled: false,
			options: { apiKey: "", baseURL: "https://open.bigmodel.cn/api/anthropic" },
			models: { "GLM-5.2": { limit: { context: 204800 } } },
		},
		local: {
			name: "Local llama.cpp",
			kind: "openai",
			enabled: true,
			options: { apiKey: "local-key", baseURL: "http://127.0.0.1:8080/v1" },
			models: { "qwen3-coder": { limit: { context: 65536 } } },
		},
	},
});

const ZCODE_CLI_CONFIG = JSON.stringify({
	mcp: {
		servers: {
			context7: {
				type: "http",
				url: "https://mcp.context7.com/mcp",
				http_headers: { CONTEXT7_API_KEY: "header-token" },
			},
			files: { type: "stdio", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
		},
	},
});

/** Build a ZCode-shaped database with just the tables the importer reads. */
function makeZcodeDb(home: string, settings: Array<[string, string, string, unknown]>): string {
	return makeZcodeDbIn(join(home, ".zcode", "cli", "db"), settings);
}

/** The same, in a `db/` directory of the caller's choosing — for a moved tree. */
function makeZcodeDbIn(dir: string, settings: Array<[string, string, string, unknown]>): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "db.sqlite");
	const db = new Database(path);
	db.run(
		"create table session (id text primary key, parent_id text, directory text, title text, time_created integer)",
	);
	db.run("create table message (id text primary key, session_id text, time_created integer, data text)");
	db.run("create table part (id text primary key, message_id text, session_id text, time_created integer, data text)");
	db.run(
		"create table local_setting (scope text, scope_id text, namespace text, key text, value text, primary key(scope, scope_id, namespace, key))",
	);
	for (const [scope, namespace, key, value] of settings) {
		db.run("insert into local_setting (scope, scope_id, namespace, key, value) values (?, ?, ?, ?, ?)", [
			scope,
			scope === "user" ? "user" : "/some/repo",
			namespace,
			key,
			JSON.stringify(value),
		]);
	}
	db.close();
	return path;
}

const DEFAULT_SETTINGS_ROWS: Array<[string, string, string, unknown]> = [
	["user", "model", "reasoningLevel", { level: "enabled" }],
	["project", "permission", "mode", { mode: "yolo" }],
	["project", "permission", "ruleset", { version: 1, allow: [{ toolName: "Bash", ruleContent: "npm test" }] }],
];

/**
 * The same, with the ruleset recorded for the user rather than for a project —
 * the only form this importer carries over, so a test that wants to watch a rule
 * arrive in `settings.json` has to plant this one.
 */
const USER_RULESET_ROWS: Array<[string, string, string, unknown]> = [
	["user", "model", "reasoningLevel", { level: "enabled" }],
	["user", "permission", "ruleset", { version: 1, allow: [{ toolName: "Bash", ruleContent: "npm test" }] }],
];

describe("migrate: ZCode source", () => {
	test("detects zcode and ~/.agents alongside the older sources", () => {
		withHome({ ".zcode/v2/config.json": "{}", ".agents/AGENTS.md": "shared rules" }, (home) => {
			expect(detectSources(home)).toEqual(["zcode", "agents"]);
		});
	});

	test("a home without ZCode contributes nothing and does not fail", () => {
		withHome({}, (home) => {
			const result = runMigration({ home });
			expect(result.error).toBeUndefined();
			expect(result.plan.sources).toEqual([]);
			expect(result.plan.writes).toEqual([]);
			expect(result.report).toContain("Nothing to import.");
		});
	});

	test("an enabled Anthropic provider moves its base URL and key into the variables the provider reads", () => {
		withHome({ ".zcode/v2/config.json": ZCODE_CONFIG }, (home) => {
			seedDb(home);
			const result = runMigration({ home });
			expect(result.plan.sources).toEqual(["zcode"]);

			const settings = settingsWrite(result);
			const parsed = JSON.parse(settings.content) as { env: Record<string, string> };
			expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://z.ai/api/v1");
			expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-imported");
			expect(settings.containsSecret).toBe(true);

			const item = result.plan.items.find((i) => i.from.endsWith("options.apiKey") && i.source === "zcode");
			expect(item?.action).toBe("map");
			expect(item?.containsSecret).toBe(true);
		});
	});

	test("the key never reaches the report or an item's text — only the settings file", () => {
		withHome({ ".zcode/v2/config.json": ZCODE_CONFIG }, (home) => {
			seedDb(home);
			const result = runMigration({ home, apply: true });
			expect(result.report).not.toContain("sk-ant-imported");
			expect(result.report).not.toContain("local-key");
			expect(JSON.stringify(result.plan.items)).not.toContain("sk-ant-imported");
			// The report names the file that now holds a credential, not the value.
			expect(result.report).toContain("These files now contain secrets");
			expect(result.report).toContain("settings.json");

			const otherWrites = result.plan.writes.filter((w) => !w.path.endsWith("settings.json"));
			for (const write of otherWrites) expect(write.content).not.toContain("sk-ant-imported");
		});
	});

	test("a provider with no key in the file is reported rather than silently dropped", () => {
		const config = JSON.stringify({
			provider: {
				anthropic: {
					name: "Anthropic",
					kind: "anthropic",
					enabled: true,
					options: { apiKey: "", baseURL: "https://z.ai/api/v1" },
					models: {},
				},
			},
		});
		withHome({ ".zcode/v2/config.json": config }, (home) => {
			const result = runMigration({ home });
			const skip = result.plan.items.find((i) => i.from.endsWith("options.apiKey"));
			expect(skip?.action).toBe("skip");
			expect(skip?.detail).toContain("ANTHROPIC_AUTH_TOKEN");
			expect(JSON.parse(settingsWrite(result).content).env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		});
	});

	test("disabled providers and unknown model names are each one aggregate skip", () => {
		withHome({ ".zcode/v2/config.json": ZCODE_CONFIG }, (home) => {
			const result = runMigration({ home });
			const disabled = result.plan.items.find((i) => i.from.includes("provider.{"));
			expect(disabled?.detail).toContain("disabled in ZCode");
			expect(disabled?.from).toContain("glm");

			// Models of an enabled provider that this build cannot resolve are
			// listed; `claude-opus-5` is not, because the registry already has it.
			const models = result.plan.items.find((i) => i.from.endsWith("provider.*.models"));
			expect(models?.detail).toContain("qwen3-coder");
			expect(models?.detail).not.toContain("claude-opus-5");
			expect(models?.detail).not.toContain("GLM-5.2");
		});
	});

	test("a non-Anthropic provider is registered under a prefixed id so it cannot shadow a built-in", () => {
		withHome({ ".zcode/v2/config.json": ZCODE_CONFIG }, (home) => {
			const result = runMigration({ home });
			const parsed = JSON.parse(settingsWrite(result).content) as {
				providers: { openaiCompatible: Array<Record<string, unknown>> };
				env: Record<string, string>;
			};
			const provider = parsed.providers.openaiCompatible.find((p) => p.id === "zcode-local");
			expect(provider?.baseUrl).toBe("http://127.0.0.1:8080/v1");
			expect(provider?.apiKeyEnv).toBe("LOCAL_API_KEY");
			expect(provider?.models).toEqual([{ id: "qwen3-coder", contextWindow: 65536, maxOutputTokens: 8192 }]);
			expect(parsed.env.LOCAL_API_KEY).toBe("local-key");

			const item = result.plan.items.find((i) => i.to.includes("providers.openaiCompatible[zcode-local]"));
			expect(item?.action).toBe("downgrade");
			expect(item?.detail).toContain("maxOutputTokens=8192");
		});
	});

	test("a provider whose baseURL is not a URL is skipped instead of written into settings", () => {
		const config = JSON.stringify({
			provider: {
				broken: { name: "Broken", kind: "openai", enabled: true, options: { baseURL: "not a url" }, models: {} },
			},
		});
		withHome({ ".zcode/v2/config.json": config }, (home) => {
			const result = runMigration({ home });
			expect(result.plan.items[0]?.action).toBe("skip");
			expect(result.plan.items[0]?.detail).toContain("not a usable URL");
			expect(result.plan.writes).toEqual([]);
		});
	});

	test("MCP servers are renamed into the supported shape", () => {
		withHome({ ".zcode/cli/config.json": ZCODE_CLI_CONFIG }, (home) => {
			const result = runMigration({ home });
			const mcp = result.plan.writes.find((w) => w.path.endsWith(".mcp.json"));
			const parsed = JSON.parse(mcp?.content ?? "{}") as { mcpServers: Record<string, unknown> };

			const http = McpServerConfigSchema.safeParse(parsed.mcpServers.context7);
			expect(http.success).toBe(true);
			expect(http.data).toEqual({
				type: "http",
				url: "https://mcp.context7.com/mcp",
				headers: { CONTEXT7_API_KEY: "header-token" },
			});
			// http_headers is gone rather than copied alongside headers.
			expect(JSON.stringify(parsed.mcpServers.context7)).not.toContain("http_headers");
			expect(mcp?.containsSecret).toBe(true);

			const stdio = McpServerConfigSchema.safeParse(parsed.mcpServers.files);
			expect(stdio.success).toBe(true);
			expect(stdio.data).toEqual({
				type: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
			});

			// Header values stay out of the report; the item says headers were copied.
			expect(result.report).not.toContain("header-token");
			const item = result.plan.items.find((i) => i.from.endsWith("mcp.servers.context7"));
			expect(item?.detail).toContain("credential headers");
			expect(item?.detail).toContain("http_headers renamed to headers");
		});
	});

	// ZCode normalizes these spellings itself, in `normalizeMcpServerConfigInput`
	// (`schema.ts:331-384`), and the source is the authority rather than a guess:
	// each of these loses something real when the old spelling is read as a key
	// this build does not have.
	describe("MCP legacy spellings, read the way ZCode reads them", () => {
		const withServers = (servers: Record<string, unknown>, run: (home: string) => void): void => {
			withHome({ ".zcode/cli/config.json": JSON.stringify({ mcp: { servers } }) }, run);
		};
		const serversIn = (result: ReturnType<typeof runMigration>): Record<string, Record<string, unknown>> => {
			const write = result.plan.writes.find((w) => w.path.endsWith(".mcp.json"));
			return (
				(JSON.parse(write?.content ?? "{}") as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers ??
				{}
			);
		};

		test("a stdio server's `environment` arrives as `env`", () => {
			// The old spelling is the one `http_headers` used to be, and it is why
			// that rename was already here: read as an unknown key, a legacy server
			// migrates with no environment at all and dies on the first variable it
			// plainly had.
			withServers({ legacy: { type: "stdio", command: "npx", environment: { CACHE_DIR: "/tmp" } } }, (home) => {
				const result = runMigration({ home });
				expect(serversIn(result).legacy?.env).toEqual({ CACHE_DIR: "/tmp" });
				expect(JSON.stringify(serversIn(result).legacy)).not.toContain("environment");
				const item = result.plan.items.find((i) => i.from.endsWith("mcp.servers.legacy"));
				expect(item?.detail).toContain("environment renamed to env");
			});
		});

		test("a server naming both spellings keeps `env`", () => {
			// The source's rule is `if (!("env" in server) && "environment" in server)`:
			// a config that names the same variable twice is one whose author has
			// already chosen, and this build's key is the one it chose last.
			withServers({ both: { type: "stdio", command: "npx", env: { A: "1" }, environment: { A: "2" } } }, (home) => {
				const result = runMigration({ home });
				expect(serversIn(result).both?.env).toEqual({ A: "1" });
				const item = result.plan.items.find((i) => i.from.endsWith("mcp.servers.both"));
				expect(item?.detail).not.toContain("environment renamed");
			});
		});

		test("an SSE server is named and skipped, not rewritten as an HTTP one", () => {
			// The two are different protocols, not two spellings of one, so a
			// StreamableHTTP client against an SSE endpoint connects and then fails
			// every call. ZCode runs both; this build runs one.
			withServers({ evt: { type: "sse", url: "https://events.example/mcp" } }, (home) => {
				const result = runMigration({ home });
				const item = result.plan.items.find((i) => i.from.endsWith("mcp.servers.evt"));
				expect(item?.action).toBe("skip");
				expect(item?.detail).toContain("SSE");
				expect(serversIn(result).evt).toBeUndefined();
			});
		});

		test("keys ZCode accepts and this build has no field for are named", () => {
			withServers(
				{
					rich: {
						type: "http",
						url: "https://mcp.example/mcp",
						timeout: 30,
						startup_timeout_sec: 5,
						protocolVersion: "2026-07-28",
						timeoutMs: 1000,
						oauth: { type: "client_credentials", clientId: "id", clientSecret: "shh" },
					},
				},
				(home) => {
					const result = runMigration({ home });
					const item = result.plan.items.find((i) => i.from.endsWith("mcp.servers.rich"));
					// `timeout`/`startup_timeout_sec` are ones ZCode itself accepts and
					// then discards; the other three have no field in this build's
					// schema. All five are named rather than dropped under a "copied
					// verbatim" that would no longer be true.
					expect(item?.detail).toContain(
						"not carried over: oauth, protocolVersion, timeoutMs, timeout, startup_timeout_sec",
					);
					const written = JSON.stringify(serversIn(result).rich);
					for (const key of ["timeout", "startup_timeout_sec", "protocolVersion", "timeoutMs", "oauth"]) {
						expect(written).not.toContain(key);
					}
				},
			);
		});

		test("a server whose command is blank is not migrated into a spawn error", () => {
			// The source's own inference trims before deciding (`command.trim()`), so
			// a whitespace-only command is not a command there either.
			withServers({ blank: { type: "stdio", command: "   " } }, (home) => {
				const result = runMigration({ home });
				const item = result.plan.items.find((i) => i.from.endsWith("mcp.servers.blank"));
				expect(item?.action).toBe("skip");
				expect(serversIn(result).blank).toBeUndefined();
			});
		});

		test("a server with nothing renamed and nothing dropped still reads `copied verbatim`", () => {
			// The clause is a claim about the record, so the plain case has to stay
			// plain — otherwise every honest server grows a caveat it does not have.
			withServers({ plain: { type: "stdio", command: "npx" } }, (home) => {
				const result = runMigration({ home });
				const item = result.plan.items.find((i) => i.from.endsWith("mcp.servers.plain"));
				expect(item?.detail).toBe("copied verbatim");
			});
		});
	});

	test("an MCP server the target already defines is kept unless forced", () => {
		withHome(
			{
				".zcode/cli/config.json": ZCODE_CLI_CONFIG,
				".labunbun/.mcp.json": JSON.stringify({
					mcpServers: { context7: { type: "http", url: "https://mine.example/mcp" } },
				}),
			},
			(home) => {
				const kept = runMigration({ home });
				const skip = kept.plan.items.find((i) => i.from.endsWith("mcp.servers.context7"));
				expect(skip?.action).toBe("skip");
				expect(skip?.detail).toContain("--force");
				const parsed = JSON.parse(kept.plan.writes.find((w) => w.path.endsWith(".mcp.json"))?.content ?? "{}");
				expect(parsed.mcpServers.context7.url).toBe("https://mine.example/mcp");
				expect(parsed.mcpServers.files).toBeDefined();
			},
		);

		withHome(
			{
				".zcode/cli/config.json": ZCODE_CLI_CONFIG,
				".labunbun/.mcp.json": JSON.stringify({
					mcpServers: { context7: { type: "http", url: "https://mine.example/mcp" } },
				}),
			},
			(home) => {
				const forced = runMigration({ home, force: true });
				const parsed = JSON.parse(forced.plan.writes.find((w) => w.path.endsWith(".mcp.json"))?.content ?? "{}");
				expect(parsed.mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
			},
		);
	});

	test("a disabled MCP server is reported as such", () => {
		const config = JSON.stringify({
			mcp: { servers: { off: { type: "http", url: "https://off.example/mcp", enabled: false } } },
		});
		withHome({ ".zcode/cli/config.json": config }, (home) => {
			const result = runMigration({ home });
			expect(result.plan.items[0]?.action).toBe("skip");
			expect(result.plan.items[0]?.detail).toBe("disabled in ZCode");
			expect(result.plan.writes).toEqual([]);
		});
	});

	test("permission rows recorded per project are never carried over", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			seedDb(home);
			const result = runMigration({ home });
			const mode = result.plan.items.find((i) => i.from.includes("permission/mode"));
			expect(mode?.action).toBe("skip");
			expect(mode?.detail).toContain("may not widen permissions");
			const ruleset = result.plan.items.find((i) => i.from.includes("permission/ruleset"));
			expect(ruleset?.action).toBe("skip");
			// No allow rule from a repository-scoped row reaches the settings patch.
			expect(result.plan.writes).toEqual([]);
		});
	});

	test("a user-scoped ruleset downgrades to rule strings and is called out for review", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			makeZcodeDb(home, [
				[
					"user",
					"permission",
					"ruleset",
					{ version: 1, allow: [{ toolName: "Bash", ruleContent: "npm test" }, { toolName: "Read" }] },
				],
			]);
			const result = runMigration({ home });
			const parsed = JSON.parse(settingsWrite(result).content) as {
				permissions: { allow: string[]; deny: string[]; additionalDirectories: string[] };
			};
			expect(parsed.permissions.allow).toEqual(["Bash(npm test)", "Read"]);
			const item = result.plan.items.find((i) => i.to === "settings.json → permissions.allow");
			expect(item?.action).toBe("downgrade");
			expect(item?.detail).toContain("2 allow rule(s)");
		});
	});

	test("ZCode's rules survive alongside another source's, on the default path", () => {
		// `--from` defaults to every source present, so two sources claiming
		// `permissions.allow` is what an ordinary `labunbun yoshi` does. Each
		// source's report item promises its rules were written, so both lists
		// have to be in the file — one replacing the other is a silent loss the
		// report calls a success.
		withHome(
			{
				".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }),
				".zcode/v2/config.json": "{}",
			},
			(home) => {
				makeZcodeDb(home, [
					["user", "permission", "ruleset", { version: 1, allow: [{ toolName: "Bash", ruleContent: "npm test" }] }],
				]);
				const result = runMigration({ home });
				const parsed = JSON.parse(settingsWrite(result).content) as { permissions: { allow: string[] } };
				expect(parsed.permissions.allow).toEqual(["Bash(git status)", "Bash(npm test)"]);
				// Both claims are in the report, each scored for what happened to
				// its rules on the way: Claude Code's arrive intact, ZCode's were
				// rewritten from another form.
				expect(
					result.plan.items
						.filter((i) => i.to === "settings.json → permissions.allow")
						.map((i) => [i.source, i.action]),
				).toEqual([
					["claude-code", "map"],
					["zcode", "downgrade"],
				]);
			},
		);
	});

	test("a ruleset the target already has a list for is kept whole, and only --force replaces it", () => {
		const existing = JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2);
		withHome({ ".zcode/v2/config.json": "{}", ".labunbun/settings.json": existing }, (home) => {
			makeZcodeDb(home, [
				["user", "permission", "ruleset", { version: 1, allow: [{ toolName: "Bash", ruleContent: "npm test" }] }],
			]);
			const kept = runMigration({ home, apply: true });
			// Byte-identical: the decision the target already held is not rewritten
			// just because another tool disagreed with it.
			expect(readFileSync(join(home, ".labunbun", "settings.json"), "utf8")).toBe(existing);
			const skip = kept.plan.items.find((i) => i.source === "zcode" && i.from.includes("permission/ruleset"));
			expect(skip?.action).toBe("skip");
			expect(skip?.detail).toContain("--force");

			const forced = runMigration({ home, apply: true, force: true });
			const parsed = JSON.parse(forced.plan.writes.find((w) => w.path.endsWith("settings.json"))?.content ?? "{}");
			expect(parsed.permissions.allow).toEqual(["Bash(npm test)"]);
		});
	});

	test("a ruleset written as bare strings keeps what parses and names the rule that does not", () => {
		// ZCode also accepts a plain string list, and one that arrived hand-edited
		// carries a rule this build cannot read. Losing the whole list over one bad
		// entry was the old behaviour; the accumulator drops one rule and says so.
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			makeZcodeDb(home, [
				["user", "permission", "ruleset", { version: 1, allow: ["Bash(git status)", "Bash(git status"] }],
			]);
			const result = runMigration({ home });
			const parsed = JSON.parse(settingsWrite(result).content) as { permissions: { allow: string[] } };
			expect(parsed.permissions.allow).toEqual(["Bash(git status)"]);
			const dropped = result.plan.items.find((i) => i.action === "skip" && i.detail.includes("1 of 2"));
			expect(dropped?.source).toBe("zcode");
		});
	});

	test.each([
		["plan", "plan"],
		["build", "default"],
		["edit", "acceptEdits"],
		["yolo", "bypassPermissions"],
	])("a user-scoped %s in the database maps to %s, as the mode it names", (zcodeMode, ours) => {
		// This assertion used to pin the opposite claim — that ZCode's mode
		// vocabulary "has no faithful equivalent here" — which was an admission
		// that nobody had read the CLI's `permission/service.ts`, where each mode
		// is a literal branch. The map is walked in full, because a match that
		// three of four tests exercise is three of four ways to be wrong.
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			makeZcodeDb(home, [["user", "permission", "mode", { mode: zcodeMode }]]);
			const result = runMigration({ home });
			const item = result.plan.items[0];
			expect(item.action).toBe("map");
			expect(item.to).toBe("settings.json → permissionMode");
			expect(item.from).toBe(`~/.zcode/cli/db/db.sqlite → permission/mode (user) ("${zcodeMode}")`);
			expect(item.detail).toBe(`mapped to "${ours}"`);
			const parsed = JSON.parse(settingsWrite(result).content) as { permissionMode: string };
			expect(parsed.permissionMode).toBe(ours);
		});
	});

	test.each([
		["plan", "plan"],
		["build", "default"],
		["edit", "acceptEdits"],
		["yolo", "bypassPermissions"],
	])("the config-level %s maps to the same %s the database row does", (zcodeMode, ours) => {
		// ZCode records a mode in two places, so a test that walks one of them
		// leaves the other free to drift; the two labels are the only difference.
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({ permission: { mode: zcodeMode } }),
			},
			(home) => {
				const result = runMigration({ home });
				const item = result.plan.items[0];
				expect(item.action).toBe("map");
				expect(item.to).toBe("settings.json → permissionMode");
				expect(item.from).toBe(`~/.zcode/cli/config.json → permission.mode ("${zcodeMode}")`);
				expect(item.detail).toBe(`mapped to "${ours}"`);
			},
		);
	});

	test("a `permission` block with answers of its own is not also named in the aggregate", () => {
		// The aggregate is a statement about top-level keys, so a sub-block it
		// cannot see is either silently swallowed or named as though nothing read
		// it. This is the half of that a test can catch from the outside: the
		// block is present, it has a key this importer translates, and the
		// aggregate still says nothing about it.
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({ permission: { mode: "plan" }, fromTheFuture: 1 }),
			},
			(home) => {
				const result = runMigration({ home });
				const aggregate = result.plan.items.find((i) => i.detail.includes("no mapping for"));
				expect(aggregate?.from).toBe("~/.zcode/cli/config.json → fromTheFuture");
				expect(aggregate?.detail).toContain("1 key(s)");
			},
		);
	});

	test("a mode ZCode itself never implemented is named, not mapped to a guess", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			makeZcodeDb(home, [["user", "permission", "mode", { mode: "auto" }]]);
			const result = runMigration({ home });
			const item = result.plan.items[0];
			expect(item.action).toBe("skip");
			expect(item.detail).toContain("reserved and not implemented");
			expect(result.plan.writes).toEqual([]);
		});
	});

	test("the reasoning level is skipped: it is chosen per request here", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			seedDb(home);
			const item = runMigration({ home }).plan.items.find((i) => i.from.includes("reasoningLevel"));
			expect(item?.detail).toContain("chosen per request");
		});
	});

	test("AGENTS.md becomes a rule file, never MEMORY.md", () => {
		withHome({ ".zcode/AGENTS.md": "# house rules\nbe terse\n" }, (home) => {
			runMigration({ home, apply: true });
			expect(existsSync(join(home, ".labunbun", "rules", "imported-zcode.md"))).toBe(true);
			expect(existsSync(join(home, ".labunbun", "MEMORY.md"))).toBe(false);
			expect(readFileSync(join(home, ".labunbun", "rules", "imported-zcode.md"), "utf8")).toBe(
				"# house rules\nbe terse\n",
			);
		});
	});

	test("skills, agent definitions and the shared ~/.agents memory all land in the home directory", () => {
		withHome(
			{
				".zcode/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: fill forms\n---\nopen it\n",
				".zcode/agents/reviewer.md":
					"---\nname: reviewer\ndescription: reviews diffs\nmodel: GLM-5.2\n---\nYou review diffs coldly.\n",
				".agents/AGENTS.md": "shared across tools\n",
				".agents/agents/scout.md": "no frontmatter here\n",
			},
			(home) => {
				const result = runMigration({ home, apply: true });
				expect(result.plan.sources).toEqual(["zcode", "agents"]);

				expect(readFileSync(join(home, ".labunbun", "skills", "pdf", "SKILL.md"), "utf8")).toContain("fill forms");
				expect(readFileSync(join(home, ".labunbun", "agents", "reviewer.md"), "utf8")).toContain(
					"You review diffs coldly.",
				);
				expect(readFileSync(join(home, ".labunbun", "agents", "scout.md"), "utf8")).toBe("no frontmatter here\n");
				expect(readFileSync(join(home, ".labunbun", "rules", "imported-agents.md"), "utf8")).toBe(
					"shared across tools\n",
				);

				const agent = result.plan.items.find((i) => i.from.endsWith("agents/reviewer.md"));
				expect(agent?.action).toBe("map");
				expect(agent?.detail).toContain('"model: GLM-5.2"');
				expect(agent?.detail).toContain("resolved when a subagent starts");
			},
		);
	});

	test("an existing agent file is kept unless forced", () => {
		withHome({ ".zcode/agents/reviewer.md": "imported\n", ".labunbun/agents/reviewer.md": "mine\n" }, (home) => {
			const kept = runMigration({ home, apply: true });
			expect(readFileSync(join(home, ".labunbun", "agents", "reviewer.md"), "utf8")).toBe("mine\n");
			const skip = kept.plan.items.find((i) => i.from.endsWith("agents/reviewer.md"));
			expect(skip?.action).toBe("skip");
			expect(skip?.detail).toContain("already exists");

			runMigration({ home, apply: true, force: true });
			expect(readFileSync(join(home, ".labunbun", "agents", "reviewer.md"), "utf8")).toBe("imported\n");
		});
	});

	test("installed plugins and the raw model-I/O logs are reported, and never read", () => {
		const rollout = JSON.stringify({
			request: { headers: { Authorization: "Bearer rollout-canary-token" } },
			response: { id: "gen-1" },
		});
		withHome(
			{
				".zcode/cli/plugins/cache/official/theme-pack/plugin.json": "{}",
				".zcode/cli/plugins/cache/official/lint-pack/plugin.json": "{}",
				".zcode/cli/rollout/model-io-1.jsonl": rollout,
			},
			(home) => {
				const rolloutPath = join(home, ".zcode", "cli", "rollout", "model-io-1.jsonl");
				const before = statSync(rolloutPath);
				const result = runMigration({ home, apply: true });

				const plugins = result.plan.items.find((i) => i.from.endsWith("plugins/cache"));
				expect(plugins?.detail).toContain("2 installed plugin(s)");
				const logs = result.plan.items.find((i) => i.from.endsWith("rollout/*.jsonl"));
				expect(logs?.detail).toContain("1 raw model I/O log(s)");
				expect(logs?.detail).toContain("never opened");

				expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
				expect(statSync(rolloutPath).mtimeMs).toBe(before.mtimeMs);
				expect(result.report).not.toContain("rollout-canary-token");
				for (const write of result.plan.writes) expect(write.content).not.toContain("rollout-canary-token");
			},
		);
	});

	test("the source database is opened read-only and left byte-identical", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			const dbPath = seedDb(home);
			const before = readFileSync(dbPath);
			const beforeStat = statSync(dbPath);
			runMigration({ home, apply: true });
			expect(readFileSync(dbPath).equals(before)).toBe(true);
			expect(statSync(dbPath).mtimeMs).toBe(beforeStat.mtimeMs);
		});
	});

	test("a missing database is not created by looking for one", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
			expect(existsSync(dbPath)).toBe(false);
			const result = runMigration({ home, apply: true });
			expect(existsSync(dbPath)).toBe(false);
			expect(result.error).toBeUndefined();
			// Without the database the source still contributes its config.
			expect(result.plan.sources).toEqual(["zcode"]);
		});
	});

	test("the applied settings file loads", () => {
		withHome({ ".zcode/v2/config.json": ZCODE_CONFIG }, (home) => {
			runMigration({ home, apply: true });
			const loaded = loadSettings(home);
			expect(loaded.settings.env?.ANTHROPIC_BASE_URL).toBe("https://z.ai/api/v1");
			expect(loaded.settings.providers?.openaiCompatible.some((p) => p.id === "zcode-local")).toBe(true);
		});
	});

	// The four tests below are the moved-tree cases. Each one sets a variable the
	// reader consults, so a regression that ignored the variable would leave the
	// tree at its default path unread — and every assertion here is about *which
	// path was opened*, not about what was read, so the report's own labels are
	// what get pinned.

	test("a data root moved by the environment is the tree that is detected, read and named", () => {
		withHome({}, (home) => {
			const base = join(home, "elsewhere");
			mkdirSync(join(base, ".zcode", "v2"), { recursive: true });
			writeFileSync(join(base, ".zcode", "v2", "config.json"), ZCODE_CONFIG);
			// A decoy at the default path: if it were read instead, the labels below
			// would say so and the base URL would be the decoy's.
			mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
			writeFileSync(join(home, ".zcode", "v2", "config.json"), "{}");

			process.env.ZCODE_DATA_BASE_DIR = base;
			try {
				expect(detectSources(home)).toContain("zcode");
				const result = runMigration({ home, apply: true });
				const loaded = loadSettings(home);
				expect(loaded.settings.env?.ANTHROPIC_BASE_URL).toBe("https://z.ai/api/v1");

				// Report labels are rendered with `~/` and forward slashes whatever the
				// platform — `tildePath` normalizes both — so these are compared as
				// report text rather than as paths.
				const labels = result.plan.items.map((i) => i.from);
				expect(labels).toContain("~/elsewhere/.zcode/v2/config.json → provider.anthropic.options.baseURL");
				for (const label of labels) expect(label).not.toContain("~/.zcode/v2/config.json");
			} finally {
				delete process.env.ZCODE_DATA_BASE_DIR;
			}
		});
	});

	test("moving the data root does not move the CLI half, and the report says where the database is", () => {
		// The two halves have independent defaults in ZCode itself, so a user who
		// moved only the desktop tree still has their `cli/` under the home. Reading
		// the CLI half from the data base would find an empty tree and report the
		// user's permission rules as absent.
		withHome({ ".zcode/cli/config.json": ZCODE_CLI_CONFIG }, (home) => {
			const base = join(home, "elsewhere");
			mkdirSync(join(base, ".zcode", "v2"), { recursive: true });
			writeFileSync(join(base, ".zcode", "v2", "config.json"), "{}");
			makeZcodeDb(home, USER_RULESET_ROWS);

			process.env.ZCODE_DATA_BASE_DIR = base;
			try {
				const result = runMigration({ home, apply: true });
				const settings = JSON.parse(settingsWrite(result).content);
				expect(settings.permissions.allow).toContain("Bash(npm test)");
				expect(result.plan.items.some((i) => i.detail.includes("no database here"))).toBe(false);
				const server = result.plan.items.find((i) => i.from.includes("mcp.servers.context7"));
				expect(server?.from).toBe("~/.zcode/cli/config.json → mcp.servers.context7");
			} finally {
				delete process.env.ZCODE_DATA_BASE_DIR;
			}
		});
	});

	test("a moved storage directory carries the plugins and the logs but not the database", () => {
		// The two answers are separate in ZCode and have to be separate here: read the
		// database out of the storage tree, this user's permission rules come back
		// empty while the plugin count above them is right.
		withHome({ ".zcode/v2/config.json": "{}", ".zcode/cli/config.json": ZCODE_CLI_CONFIG }, (home) => {
			const moved = join(home, "moved-cli");
			mkdirSync(join(moved, "cli", "plugins", "cache", "official", "theme-pack"), { recursive: true });

			process.env.ZCODE_STORAGE_DIR = moved;
			try {
				const result = runMigration({ home, apply: true });
				const plugins = result.plan.items.find((i) => i.from.endsWith("plugins/cache"));
				expect(plugins?.from).toBe("~/moved-cli/cli/plugins/cache");
				expect(plugins?.detail).toContain("1 installed plugin(s)");

				const missing = result.plan.items.find((i) => i.detail.includes("no database here"));
				expect(missing?.from).toBe("~/.zcode/cli/db/db.sqlite");
				expect(result.error).toBeUndefined();
			} finally {
				delete process.env.ZCODE_STORAGE_DIR;
			}
		});
	});

	test("the database is read from wherever `sessionDbPath` says, and its rules still land", () => {
		withHome({ ".zcode/v2/config.json": "{}", ".zcode/cli/config.json": ZCODE_CLI_CONFIG }, (home) => {
			// A decoy at the default path, so a reader that ignored the setting would
			// import the decoy's rules instead of reporting them absent.
			makeZcodeDb(home, [["user", "permission", "ruleset", { allow: ["Bash(git status)"] }]]);
			makeZcodeDbIn(join(home, "elsewhere", "db"), USER_RULESET_ROWS);

			const configPath = join(home, ".zcode", "cli", "config.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					...JSON.parse(ZCODE_CLI_CONFIG),
					storage: { sessionDbPath: "~/elsewhere/db/db.sqlite" },
				}),
			);

			const result = runMigration({ home, apply: true });
			const settings = JSON.parse(settingsWrite(result).content);
			expect(settings.permissions.allow).toEqual(["Bash(npm test)"]);
			expect(result.plan.items.some((i) => i.detail.includes("no database here"))).toBe(false);
		});
	});

	test("a config file that moved its own tree with `storage.dir` is followed, `~/` and all", () => {
		withHome({ ".zcode/cli/config.json": ZCODE_CLI_CONFIG }, (home) => {
			// `storage.dir` is the only way to move the plugin tree and the logs that a
			// portable config can carry: the value is read out of the file that stays
			// behind, which is why that one file is read before anything else.
			const configPath = join(home, ".zcode", "cli", "config.json");
			writeFileSync(configPath, JSON.stringify({ ...JSON.parse(ZCODE_CLI_CONFIG), storage: { dir: "~/moved-cli" } }));
			mkdirSync(join(home, "moved-cli", "cli", "plugins", "cache", "official", "theme-pack"), {
				recursive: true,
			});

			const result = runMigration({ home, apply: true });
			const plugins = result.plan.items.find((i) => i.from.endsWith("plugins/cache"));
			expect(plugins?.from).toBe("~/moved-cli/cli/plugins/cache");
			// The config file is the one path no variable and no setting moves, so its
			// own label is the default one even though what it decided is elsewhere.
			const server = result.plan.items.find((i) => i.from.includes("mcp.servers.context7"));
			expect(server?.from).toBe("~/.zcode/cli/config.json → mcp.servers.context7");
		});
	});

	test("the beta tree is named as the tree it is — a directory, not a config file that is not in it", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			mkdirSync(join(home, ".zcode-beta", "cli", "db"), { recursive: true });
			const result = runMigration({ home, apply: true });
			const beta = result.plan.items.find((i) => i.detail.includes("beta-channel tree"));
			expect(beta?.from).toBe("~/.zcode-beta/cli/");
			// The CLI config is the stable one this importer already read, so a label
			// pointing at a copy of it inside the beta tree names a file that cannot
			// exist there.
			expect(beta?.from).not.toContain("config.json");
			expect(beta?.detail).toContain("ZCODE_STORAGE_DIR");
		});
	});

	// -----------------------------------------------------------------------
	// Nothing disappears quietly. ZCode grew both config files a key at a time
	// and this importer knows a fixed set of them, so every key is either read,
	// explained on a line of its own, or named in the closing aggregate.
	// -----------------------------------------------------------------------

	test("a `$schema` pointer in either file is named as the editor hint it is", () => {
		withHome(
			{
				".zcode/v2/config.json": JSON.stringify({ $schema: "https://zcode.dev/schema.json", provider: {} }),
				".zcode/cli/config.json": JSON.stringify({ $schema: "https://zcode.dev/cli.json" }),
			},
			(home) => {
				const result = runMigration({ home, apply: true });
				const notes = result.plan.items.filter((i) => i.from.endsWith("→ $schema"));
				expect(notes.map((i) => i.from)).toEqual([
					"~/.zcode/v2/config.json → $schema",
					"~/.zcode/cli/config.json → $schema",
				]);
				for (const note of notes) expect(note.detail).toContain("JSON-schema pointer");
			},
		);
	});

	test("a CLI config key whose fate is settled is explained on a line of its own", () => {
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({
					network: { httpProxy: "http://proxy:8080" },
					logging: { level: "debug" },
				}),
			},
			(home) => {
				const result = runMigration({ home, apply: true });
				const proxy = result.plan.items.find((i) => i.from.endsWith("→ network"));
				expect(proxy?.detail).toContain("proxy, no-proxy and TLS settings");
				// The value is the user's and may name a host; only the key is reported.
				expect(JSON.stringify(result.plan.items)).not.toContain("proxy:8080");
				const logging = result.plan.items.find((i) => i.from.endsWith("→ logging"));
				expect(logging?.detail).toContain("log level and destination");
				// Both are explained, so neither belongs in the aggregate as unknown.
				expect(result.plan.items.some((i) => i.from.includes("no mapping for"))).toBe(false);
			},
		);
	});

	test("a key whose fate is still open is named in the aggregate rather than left out", () => {
		// `plugins` is the one real ZCode key left in this list without an answer.
		// The aggregate is the one description that stays true while that is the
		// case. `ui` used to be here and left when the theme and the locale got
		// answers of their own; `hooks` left for the same reason when its events got
		// theirs; `skill`, `skills` and `command` left when the three asset switches
		// got answers of their own. The fixture keeps a `hooks` block and the three
		// switch keys so that leaving the aggregate is shown to be this importer's
		// decision and not the fixture's: none of them is set to anything here, so
		// each is still named — on a line of its own, or not at all.
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({
					hooks: { events: {} },
					plugins: { enabled: ["a"] },
					skills: ["s"],
					skill: {},
					command: {},
					features: {},
					ui: { theme: "dark", locale: "zh-CN" },
					fromTheFuture: { anything: 1 },
				}),
			},
			(home) => {
				const result = runMigration({ home, apply: true });
				const aggregate = result.plan.items.find((i) => i.detail.includes("no mapping for"));
				expect(aggregate?.from).toBe("~/.zcode/cli/config.json → plugins, fromTheFuture");
				expect(aggregate?.detail).toContain("2 key(s)");
				// The keys it names, and nothing it does not: `mcp`, `storage`, `ui`,
				// `hooks` and the three asset switches are read, and the keys explained
				// above have their own lines.
				for (const handled of ["mcp", "storage", "ui", "hooks", "skills", "skill", "command", "features"]) {
					expect(aggregate?.from).not.toContain(handled);
				}
				const hooks = result.plan.items.find((i) => i.from.endsWith("config.json → hooks"));
				expect(hooks?.action).toBe("skip");
				expect(hooks?.detail).toContain("hooks.enabled === true");
			},
		);
	});

	test("an unknown key in the desktop file is named too, and not confused with the CLI file's", () => {
		withHome(
			{
				".zcode/v2/config.json": JSON.stringify({ provider: {}, theme: "dark", somethingNew: [1, 2] }),
				".zcode/cli/config.json": "{}",
			},
			(home) => {
				const result = runMigration({ home, apply: true });
				const aggregate = result.plan.items.find((i) => i.detail.includes("no mapping for"));
				expect(aggregate?.from).toBe("~/.zcode/v2/config.json → theme, somethingNew");
				expect(aggregate?.detail).toContain("2 key(s)");
			},
		);
	});

	test("a config file with nothing but handled keys gets no aggregate item at all", () => {
		withHome(
			{
				".zcode/v2/config.json": JSON.stringify({ provider: {} }),
				".zcode/cli/config.json": JSON.stringify({ mcp: { servers: {} }, storage: { dir: "~/.zcode" } }),
			},
			(home) => {
				const result = runMigration({ home, apply: true });
				expect(result.plan.items.some((i) => i.from.includes("no mapping for"))).toBe(false);
				expect(result.plan.items.some((i) => i.from.endsWith("→ $schema"))).toBe(false);
			},
		);
	});

	test("a settings namespace this importer does not know is named, not dropped", () => {
		// `local_setting` has free-text namespace and key columns, so what arrives is
		// not a fixed set. The old `continue` made every one of these invisible.
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			makeZcodeDb(home, [
				["user", "editor", "fontSize", 14],
				["user", "editor", "fontFamily", "iosevka-nerd-font-marker"],
				["user", "telemetry", "enabled", true],
			]);
			const result = runMigration({ home, apply: true });
			const item = result.plan.items.find((i) => i.from.includes("editor/fontSize"));
			expect(item?.from).toBe(
				"~/.zcode/cli/db/db.sqlite → editor/fontSize (user), editor/fontFamily (user), telemetry/enabled (user)",
			);
			expect(item?.detail).toContain("3 settings namespace(s)");
			// Names, not values: a setting's own content is the user's, and the
			// report says which keys exist without saying what they are set to.
			expect(result.report).toContain("editor/fontFamily");
			expect(result.report).not.toContain("iosevka-nerd-font-marker");
		});
	});

	test("a permission key other than mode and ruleset is named rather than falling off the end", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			makeZcodeDb(home, [
				["user", "permission", "autoApproveHighRisk", { tools: ["Bash"] }],
				["user", "permission", "allowedTools", ["Bash"]],
			]);
			const result = runMigration({ home, apply: true });
			const item = result.plan.items.find((i) => i.from.includes("permission/{"));
			expect(item?.from).toBe("~/.zcode/cli/db/db.sqlite → permission/{autoApproveHighRisk, allowedTools} (user)");
			expect(item?.detail).toContain("2 user-scoped permission key(s)");
		});
	});

	// The config-level `permission` block, the other half of ZCode's permission
	// story: the database above holds the per-scope records, this is the
	// machine-wide default the CLI reads before it consults them.
	test("the config-level tool lists become rules — allow and deny in the two directions they are read", () => {
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({
					permission: { allowedTools: ["Read", "Glob"], disallowedTools: ["Bash"] },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				const parsed = JSON.parse(settingsWrite(result).content) as {
					permissions: { allow: string[]; deny: string[] };
				};
				// ZCode matched these against `context.toolName` and nothing else, so
				// a bare name is the whole rule. `disallowedTools` is checked before
				// any allow list, which is why it is this build's `deny`.
				expect(parsed.permissions.allow).toEqual(["Read", "Glob"]);
				expect(parsed.permissions.deny).toEqual(["Bash"]);
				const labels = result.plan.items
					.filter((i) => i.source === "zcode" && i.from.includes("config.json → permission."))
					.map((i) => [i.from, i.action]);
				expect(labels).toEqual([
					["~/.zcode/cli/config.json → permission.allowedTools", "map"],
					["~/.zcode/cli/config.json → permission.disallowedTools", "map"],
				]);
			},
		);
	});

	test("config-level tool names merge with the database's rules rather than replacing them", () => {
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({ permission: { disallowedTools: ["WebFetch"] } }),
			},
			(home) => {
				makeZcodeDb(home, [
					["user", "permission", "ruleset", { version: 1, allow: [{ toolName: "Bash", ruleContent: "npm test" }] }],
				]);
				const result = runMigration({ home });
				const parsed = JSON.parse(settingsWrite(result).content) as {
					permissions: { allow: string[]; deny: string[] };
				};
				expect(parsed.permissions.allow).toEqual(["Bash(npm test)"]);
				expect(parsed.permissions.deny).toEqual(["WebFetch"]);
			},
		);
	});

	test("a tool list ZCode left empty or holding a non-string writes nothing and is not reported as read", () => {
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({ permission: { allowedTools: [], disallowedTools: ["  ", 7] } }),
			},
			(home) => {
				const result = runMigration({ home });
				expect(result.plan.items.some((i) => i.from.includes("allowedTools"))).toBe(false);
				expect(result.plan.items.some((i) => i.from.includes("disallowedTools"))).toBe(false);
				expect(result.plan.writes).toEqual([]);
			},
		);
	});

	test("ZCode's two risk-classifier switches are named rather than claimed", () => {
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({
					permission: { autoApproveHighRisk: true, allowMediumRiskInAuto: false },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				const named = result.plan.items.filter((i) => i.from.startsWith("~/.zcode/cli/config.json → permission."));
				expect(named.map((i) => i.from)).toEqual([
					"~/.zcode/cli/config.json → permission.autoApproveHighRisk",
					"~/.zcode/cli/config.json → permission.allowMediumRiskInAuto",
				]);
				for (const item of named) {
					expect(item.action).toBe("skip");
					// Each names the tier it is about, so the two lines do not read as
					// two copies of one excuse.
					expect(item.detail).toContain("risky");
				}
				expect(result.plan.writes).toEqual([]);
			},
		);
	});

	test("a permission key beyond the five ZCode declares is named, not swallowed by the two above", () => {
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({ permission: { autoApproveHighRisk: true, fromTheFuture: 1 } }),
			},
			(home) => {
				const result = runMigration({ home });
				// The known-unread key keeps its own line; the unknown one is named
				// apart, so "ZCode grew a key" and "this importer has no reading
				// for a key ZCode declares" stay two different statements.
				expect(
					result.plan.items
						.filter((i) => i.from.startsWith("~/.zcode/cli/config.json → permission."))
						.map((i) => i.from),
				).toEqual([
					"~/.zcode/cli/config.json → permission.autoApproveHighRisk",
					"~/.zcode/cli/config.json → permission.{fromTheFuture}",
				]);
			},
		);
	});

	test("the theme carries across and the locale beside it is named", () => {
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({ ui: { theme: "dark", locale: "zh-CN" } }),
			},
			(home) => {
				const result = runMigration({ home });
				const parsed = JSON.parse(settingsWrite(result).content) as { theme: string };
				expect(parsed.theme).toBe("dark");
				const claimed = result.plan.items.find((i) => i.to === "settings.json → theme");
				expect(claimed?.from).toBe("~/.zcode/cli/config.json → ui.theme");
				expect(claimed?.action).toBe("map");
				const locale = result.plan.items.find((i) => i.from.endsWith("ui.locale"));
				expect(locale?.action).toBe("skip");
				expect(locale?.detail).toContain("no language setting");
			},
		);
	});

	test("a `ui` block with a key beyond the theme and the locale names the leftover", () => {
		withHome(
			{
				".zcode/v2/config.json": "{}",
				".zcode/cli/config.json": JSON.stringify({ ui: { theme: "light", fontSize: 14 } }),
			},
			(home) => {
				const result = runMigration({ home });
				// A key name is worth naming; the number it held is not, and ZCode
				// itself would have stripped it — `uiSchema` is a plain
				// `z.object`, not a `.passthrough()`.
				const leftover = result.plan.items.find((i) => i.from.includes("ui.{"));
				expect(leftover?.from).toBe("~/.zcode/cli/config.json → ui.{fontSize}");
				expect(leftover?.detail).toContain("1 key(s)");
				expect(result.report).not.toContain("14");
			},
		);
	});

	describe("hooks", () => {
		test("a hooks block ZCode itself never turned on is not switched on here either", () => {
			// ZCode's startup reads `hooks.enabled === true` and hands its runner
			// nothing otherwise, so a block without it is one that never fired.
			// Importing it as live hooks would start running commands the user had
			// deliberately left off — the only thing in this importer that could
			// make something of theirs run.
			withHome(
				{
					".zcode/v2/config.json": "{}",
					".zcode/cli/config.json": JSON.stringify({
						hooks: { events: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] } },
					}),
				},
				(home) => {
					const result = runMigration({ home });
					const item = result.plan.items.find((i) => i.from.includes("config.json → hooks"));
					expect(item?.action).toBe("skip");
					expect(item?.detail).toContain("hooks.enabled === true");
					expect(result.plan.writes).toEqual([]);
				},
			);
		});

		test("the five events the two tools spell alike are carried, and the two ZCode adds are named", () => {
			withHome(
				{
					".zcode/v2/config.json": "{}",
					".zcode/cli/config.json": JSON.stringify({
						hooks: {
							enabled: true,
							events: {
								SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
								UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo prompt" }] }],
								PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo before" }] }],
								PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo after" }] }],
								Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }],
								PermissionRequest: [{ hooks: [{ type: "command", command: "echo ask" }] }],
								PostToolUseFailure: [{ hooks: [{ type: "command", command: "echo failed" }] }],
							},
						},
					}),
				},
				(home) => {
					const result = runMigration({ home });
					const parsed = JSON.parse(settingsWrite(result).content) as {
						hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
					};
					expect(Object.keys(parsed.hooks).sort()).toEqual([
						"PostToolUse",
						"PreToolUse",
						"SessionStart",
						"Stop",
						"UserPromptSubmit",
					]);
					expect(parsed.hooks.PreToolUse[0].matcher).toBe("Bash");
					const item = result.plan.items.find((i) => i.to === "settings.json → hooks");
					expect(item?.detail).toContain("5 matcher entr(ies) over 5 event(s)");
					// ZCode asks a hook when a tool needs permission and another when a
					// tool fails; neither has a counterpart here, and naming them is
					// what keeps the five that did come across from reading as all seven.
					expect(item?.action).toBe("downgrade");
					expect(item?.detail).toContain("2 event(s) with no hook here (PermissionRequest, PostToolUseFailure)");
				},
			);
		});

		test("a `process` handler is counted rather than imported as a shell line", () => {
			withHome(
				{
					".zcode/v2/config.json": "{}",
					".zcode/cli/config.json": JSON.stringify({
						hooks: {
							enabled: true,
							events: {
								Stop: [
									{
										hooks: [
											{ type: "process", command: "/usr/bin/notify-send", args: ["Stop"] },
											{ type: "command", command: "echo bye" },
										],
									},
								],
							},
						},
					}),
				},
				(home) => {
					const result = runMigration({ home });
					const parsed = JSON.parse(settingsWrite(result).content) as {
						hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
					};
					// ZCode spawns that one as an executable with its arguments beside
					// it; this build runs every handler through a shell, so the same
					// string would mean something else entirely.
					expect(parsed.hooks.Stop[0].hooks.map((hook) => hook.command)).toEqual(["echo bye"]);
					const item = result.plan.items.find((i) => i.to === "settings.json → hooks");
					expect(item?.action).toBe("downgrade");
					expect(item?.detail).toContain("1 handler(s) ZCode spawns as an executable with arguments");
				},
			);
		});

		test("`timeoutMs` becomes the wait the handler runs for, and `timeout` outranks it", () => {
			withHome(
				{
					".zcode/v2/config.json": "{}",
					".zcode/cli/config.json": JSON.stringify({
						hooks: {
							enabled: true,
							events: {
								Stop: [
									{
										hooks: [
											{ type: "command", command: "echo ms", timeoutMs: 45_000 },
											{ type: "command", command: "echo both", timeout: 5, timeoutMs: 90_000 },
											{ type: "command", command: "echo none" },
										],
									},
								],
							},
						},
					}),
				},
				(home) => {
					const result = runMigration({ home });
					const parsed = JSON.parse(settingsWrite(result).content) as {
						hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
					};
					const byCommand = new Map(parsed.hooks.Stop[0].hooks.map((hook) => [hook.command, hook.timeout] as const));
					expect(byCommand.get("echo ms")).toBe(45_000);
					expect(byCommand.get("echo both")).toBe(5_000);
					expect(byCommand.get("echo none")).toBeUndefined();
					const item = result.plan.items.find((i) => i.to === "settings.json → hooks");
					expect(item?.action).toBe("map");
					expect(item?.detail).toContain("2 timeout(s) converted");
					expect(item?.detail).toContain("a handler that names no timeout runs for 60 s here");
				},
			);
		});

		test("the block's own default wait and its output cap are named, not dropped", () => {
			// Both numbers are the user's own settings, so both are worth printing
			// here: the first is the only place the difference between the two
			// tools' defaults can be stated, and the second is a cap that has no
			// counterpart to be carried into.
			withHome(
				{
					".zcode/v2/config.json": "{}",
					".zcode/cli/config.json": JSON.stringify({
						hooks: {
							enabled: true,
							timeoutMs: 120_000,
							maxOutputBytes: 4096,
							events: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] },
						},
					}),
				},
				(home) => {
					const result = runMigration({ home });
					const wait = result.plan.items.find((i) => i.from.endsWith("hooks.timeoutMs"));
					expect(wait?.action).toBe("skip");
					expect(wait?.detail).toContain("120 s there, 60 s here");
					const cap = result.plan.items.find((i) => i.from.endsWith("hooks.maxOutputBytes"));
					expect(cap?.action).toBe("skip");
					expect(cap?.detail).toContain("no such cap here");
				},
			);
		});

		test("a block default equal to this build's is said to be the same, not printed as a difference", () => {
			withHome(
				{
					".zcode/v2/config.json": "{}",
					".zcode/cli/config.json": JSON.stringify({
						hooks: {
							enabled: true,
							timeoutMs: 60_000,
							events: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] },
						},
					}),
				},
				(home) => {
					const result = runMigration({ home });
					const wait = result.plan.items.find((i) => i.from.endsWith("hooks.timeoutMs"));
					// A report that says "120 s there, 60 s here" for two settings
					// that already agree teaches the user to stop reading the line.
					expect(wait?.detail).toContain("which is what such a handler waits for here too");
					expect(wait?.detail).not.toContain("there");
				},
			);
		});

		test("a hooks block the target already has is kept whole, and only --force replaces it", () => {
			const existing = JSON.stringify({
				hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
			});
			withHome(
				{
					".zcode/v2/config.json": "{}",
					".zcode/cli/config.json": JSON.stringify({
						hooks: {
							enabled: true,
							events: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
						},
					}),
					".labunbun/settings.json": existing,
				},
				(home) => {
					const kept = runMigration({ home, apply: true });
					expect(readFileSync(join(home, ".labunbun", "settings.json"), "utf8")).toBe(existing);
					const skip = kept.plan.items.find(
						(i) => i.source === "zcode" && i.action === "skip" && i.from.includes("config.json → hooks"),
					);
					expect(skip?.detail).toContain("--force");
					const forced = runMigration({ home, apply: true, force: true });
					const parsed = JSON.parse(
						forced.plan.writes.find((w) => w.path.endsWith("settings.json"))?.content ?? "{}",
					) as { hooks: Record<string, unknown> };
					expect(Object.keys(parsed.hooks)).toEqual(["PreToolUse"]);
				},
			);
		});

		test("ZCode's hooks and Claude Code's are one configuration, not one erasing the other", () => {
			withHome(
				{
					".claude/settings.json": JSON.stringify({
						hooks: { Stop: [{ hooks: [{ type: "command", command: "echo claude" }] }] },
					}),
					".zcode/v2/config.json": "{}",
					".zcode/cli/config.json": JSON.stringify({
						hooks: {
							enabled: true,
							events: { PreToolUse: [{ hooks: [{ type: "command", command: "echo zcode" }] }] },
						},
					}),
				},
				(home) => {
					const result = runMigration({ home });
					const parsed = JSON.parse(settingsWrite(result).content) as {
						hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
					};
					expect(Object.keys(parsed.hooks).sort()).toEqual(["PreToolUse", "Stop"]);
					expect(result.plan.items.filter((i) => i.to === "settings.json → hooks").map((i) => i.source)).toEqual([
						"claude-code",
						"zcode",
					]);
				},
			);
		});

		test("a key inside the hooks block beyond the four ZCode declares is named", () => {
			withHome(
				{
					".zcode/v2/config.json": "{}",
					".zcode/cli/config.json": JSON.stringify({
						hooks: {
							enabled: true,
							fromTheFuture: { retries: 3 },
							events: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] },
						},
					}),
				},
				(home) => {
					const result = runMigration({ home });
					// ZCode's own `hooksSchema` is a `.strict()` object, so this key is
					// one it would have refused to load. It is in the file all the same,
					// and a report that skips it is the same silence this importer
					// stopped doing for the config files a layer up.
					const leftover = result.plan.items.find((i) => i.from.includes("hooks → "));
					expect(leftover?.from).toBe("~/.zcode/cli/config.json → hooks → fromTheFuture");
					expect(leftover?.detail).toContain("1 key(s)");
					expect(result.report).not.toContain("retries");
				},
			);
		});

		describe("commands and the asset switches", () => {
			test("a command becomes a skill under the name the user actually typed", () => {
				withHome(
					{
						".zcode/v2/config.json": "{}",
						".zcode/commands/Review.md": "---\ndescription: Review a diff\n---\nReview $ARGUMENTS.\n",
					},
					(home) => {
						const result = runMigration({ home, apply: true });
						// ZCode lowercases the name in `normalizeCommandName`, so `Review.md`
						// was `/review` there; a skill called `Review` would answer to a
						// name the user never typed.
						const skill = readFileSync(join(home, ".labunbun", "skills", "review", "SKILL.md"), "utf8");
						expect(skill).toBe("---\nname: review\ndescription: Review a diff\n---\nReview $ARGUMENTS.\n");
						expect(result.plan.items.find((i) => i.from.endsWith("commands/Review.md"))?.action).toBe("map");
						// A file directly in the root is not nested, and the nesting test
						// runs on the path *relative* to the commands root — the separator
						// between the root and the file is not a level of its own, and
						// counting it would put a rewrite note in front of every user.
						expect(result.plan.items.some((i) => i.detail.includes("nested command"))).toBe(false);
					},
				);
			});

			test("a nested command keeps one name, and the rewrite that cost it is named", () => {
				withHome(
					{
						".zcode/v2/config.json": "{}",
						".zcode/commands/fix/bugs.md": "---\ndescription: Fix a failing test\n---\nFix it.\n",
					},
					(home) => {
						const result = runMigration({ home, apply: true });
						// `fix/bugs.md` was `/fix:bugs` in ZCode. A skill here is a directory,
						// and `:` is not a legal character in one on Windows, so the name
						// arrives spelled with a `-` — which the report has to say out loud,
						// since the user typed the other one.
						expect(result.plan.writes.some((w) => w.path.endsWith(join("skills", "fix-bugs", "SKILL.md")))).toBe(true);
						const item = result.plan.items.find((i) => i.detail.includes("nested command"));
						expect(item?.action).toBe("downgrade");
						expect(item?.detail).toContain("/fix:bugs");
						expect(item?.detail).toContain("cannot hold a `:`");
					},
				);
			});

			test("a command the source's own list holds off is not imported", () => {
				withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
					const slow = join(home, ".zcode", "commands", "slow.md");
					const fast = join(home, ".zcode", "commands", "fast.md");
					mkdirSync(join(home, ".zcode", "commands"), { recursive: true });
					mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
					writeFileSync(slow, "---\ndescription: Take your time\n---\nWait.\n");
					writeFileSync(fast, "---\ndescription: Hurry\n---\nGo.\n");
					writeFileSync(
						join(home, ".zcode", "cli", "config.json"),
						JSON.stringify({ command: { [slow]: { enable: false }, [fast]: { enable: true } } }),
					);
					const result = runMigration({ home, apply: true });
					// Only `enable: false` is a switch, per `collectDisabledPaths`: the map
					// overrides a default-on file rather than carrying a state of its own,
					// so an `enable: true` beside it changes nothing and is not permission
					// to import a file the user had turned off.
					expect(existsSync(join(home, ".labunbun", "skills", "fast", "SKILL.md"))).toBe(true);
					expect(existsSync(join(home, ".labunbun", "skills", "slow", "SKILL.md"))).toBe(false);
					const item = result.plan.items.find((i) => i.detail.includes("command.<path>.enable"));
					expect(item?.from).toContain("switched off in");
					expect(item?.detail).toContain("1 command(s)");
				});
			});

			test("a command with no description and an empty body is not a command", () => {
				withHome(
					{
						".zcode/v2/config.json": "{}",
						".zcode/commands/blank.md": "---\nargument-hint: <file>\n---\n",
						".zcode/commands/real.md": "---\ndescription: Real\n---\nBody.\n",
					},
					(home) => {
						const result = runMigration({ home, apply: true });
						// ZCode rejects this one as an error rather than registering it, so
						// it was never a command; an empty skill is a file that matches
						// nothing and would be listed as one the user wrote.
						expect(existsSync(join(home, ".labunbun", "skills", "blank", "SKILL.md"))).toBe(false);
						expect(existsSync(join(home, ".labunbun", "skills", "real", "SKILL.md"))).toBe(true);
						expect(
							result.plan.items.find((i) => i.detail.includes("no description and an empty body"))?.detail,
						).toContain("1 command file(s)");
					},
				);
			});

			test("two files reaching one name keep the first, as the source's own resolution did", () => {
				// Two paths that differ only in case are one file on NTFS and on APFS, so
				// this pair cannot be planted in a fake home — the rule is exercised where
				// it lives instead, and the end-to-end half is the item built from it.
				const commandsRoot = join("/zcode-root", "commands");
				const reachable = zcodeReachableCommands(
					{
						files: [
							{
								name: "review",
								sourcePath: join(commandsRoot, "review.md"),
								content: "---\ndescription: lower\n---\nLower.\n",
							},
							{
								name: "Review",
								sourcePath: join(commandsRoot, "Review.md"),
								content: "---\ndescription: upper\n---\nUpper.\n",
							},
						],
						skips: [],
					},
					commandsRoot,
					new Set(),
				);
				// ZCode lowercases the name before the collision test
				// (`normalizeCommandName`, then `selected.has(parsed.name)`), so these two
				// are one command there, not two — and the first is the one that ran.
				expect(reachable.files.map((f) => f.sourcePath)).toEqual([join(commandsRoot, "review.md")]);
				expect(reachable.shadowed).toEqual([join(commandsRoot, "Review.md")]);
				expect(reachable.nested).toBe(0);
			});

			test("a nested path and a flat one are two commands there, and both are imported", () => {
				withHome(
					{
						".zcode/v2/config.json": "{}",
						".zcode/commands/fix/bugs.md": "---\ndescription: Fix a failing test\n---\nFix it.\n",
						".zcode/commands/fix-bugs.md": "---\ndescription: The flat one\n---\nFlat.\n",
					},
					(home) => {
						const result = runMigration({ home, apply: true });
						// `/fix:bugs` and `/fix-bugs` are different names in ZCode, so both
						// were reachable there. They are one directory here, and which one
						// is kept is `collectFileWrites`' own collision report saying so —
						// the ZCode-side rule must not call a file unreachable that the user
						// could still run.
						expect(result.plan.items.find((i) => i.detail.includes("another file in this tree"))).toBeUndefined();
						const skills = result.plan.writes.filter((w) => w.path.endsWith(join("skills", "fix-bugs", "SKILL.md")));
						expect(skills.length).toBe(1);
						const kept = result.plan.items.find((i) => i.from.endsWith("commands/fix-bugs.md"));
						expect(kept?.detail).toContain("kept the first one");
					},
				);
			});

			test("a name ZCode's own pattern refuses was never a command", () => {
				withHome(
					{
						".zcode/v2/config.json": "{}",
						".zcode/commands/-draft.md": "---\ndescription: A draft\n---\nDraft.\n",
						".zcode/commands/real.md": "---\ndescription: Real\n---\nBody.\n",
					},
					(home) => {
						const result = runMigration({ home, apply: true });
						// `COMMAND_NAME_PATTERN` wants a name to start with a letter or a
						// digit, so this one is an error diagnostic in ZCode and never
						// registered — while a skill directory is happy to hold `-draft`,
						// and a skill answering to a name ZCode rejected would be a command
						// the user cannot type there.
						expect(existsSync(join(home, ".labunbun", "skills", "-draft", "SKILL.md"))).toBe(false);
						expect(existsSync(join(home, ".labunbun", "skills", "real", "SKILL.md"))).toBe(true);
						const item = result.plan.items.find((i) => i.detail.includes("ZCode's own pattern refuses"));
						expect(item?.detail).toContain("1 command file(s)");
						expect(item?.detail).toContain("-draft.md");
					},
				);
			});

			test("the frontmatter keys ZCode honours and this build does not are named", () => {
				withHome(
					{
						".zcode/v2/config.json": "{}",
						".zcode/commands/strict.md": [
							"---",
							"description: A command with rules",
							"disable-noninteractive: true",
							"skills: [pdf]",
							"---",
							"Body.",
						].join("\n"),
					},
					(home) => {
						const result = runMigration({ home });
						const detail = result.plan.items.find((i) => i.from.endsWith("commands/strict.md"))?.detail ?? "";
						// `SAFE_FRONTMATTER_KEYS` names six; these two are the ones that do
						// nothing once the file is a skill, and a key the source honours and
						// this one silently drops is the one a user is likeliest to believe
						// is still in force.
						expect(detail).toContain("disable-noninteractive");
						expect(detail).toContain("skills");
					},
				);
			});

			test.each([
				["features.skill", { features: { skill: false } }],
				["skills.enabled", { skills: { enabled: false } }],
			])("a skills tree %s switched off is not imported", (_which, config) => {
				withHome(
					{
						".zcode/v2/config.json": "{}",
						".zcode/cli/config.json": JSON.stringify(config),
						".zcode/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: fill forms\n---\nopen it\n",
					},
					(home) => {
						const result = runMigration({ home, apply: true });
						// Both default to on in ZCode's own config — `features.skill` and
						// `skills.enabled` are `?? true` in `ConfigService` — and both gate
						// the adapter at `create-app.ts`, so a false means the tree was
						// dormant. Importing it would switch on what the user had off.
						expect(existsSync(join(home, ".labunbun", "skills", "pdf", "SKILL.md"))).toBe(false);
						const item = result.plan.items.find((i) => i.detail.includes("skill(s) not imported"));
						expect(item?.action).toBe("skip");
						expect(item?.detail).toContain("would switch it on");
					},
				);
			});

			test("a skill the source holds off on its own is not imported, and its neighbours are", () => {
				withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
					const off = join(home, ".zcode", "skills", "old", "SKILL.md");
					mkdirSync(join(home, ".zcode", "skills", "old"), { recursive: true });
					mkdirSync(join(home, ".zcode", "skills", "new"), { recursive: true });
					mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
					writeFileSync(off, "---\nname: old\ndescription: an old one\n---\nbody\n");
					writeFileSync(
						join(home, ".zcode", "skills", "new", "SKILL.md"),
						"---\nname: new\ndescription: a new one\n---\nbody\n",
					);
					writeFileSync(
						join(home, ".zcode", "cli", "config.json"),
						JSON.stringify({ skill: { [off]: { enable: false } } }),
					);
					const result = runMigration({ home, apply: true });
					expect(existsSync(join(home, ".labunbun", "skills", "old", "SKILL.md"))).toBe(false);
					expect(existsSync(join(home, ".labunbun", "skills", "new", "SKILL.md"))).toBe(true);
					expect(result.plan.items.find((i) => i.detail.includes("skill.<path>.enable"))?.detail).toContain(
						"1 skill(s) not imported",
					);
				});
			});

			test("the five feature flags with no counterpart are named, and `skill` is not among them", () => {
				withHome(
					{
						".zcode/v2/config.json": "{}",
						".zcode/cli/config.json": JSON.stringify({
							features: { skill: true, mcp: false, memory: false, rewind: false, subagent: false, compact: false },
						}),
					},
					(home) => {
						const result = runMigration({ home });
						const named = result.plan.items.filter((i) => i.from.includes("config.json → features."));
						expect(named.map((i) => i.from.split("features.")[1])).toEqual([
							"compact",
							"rewind",
							"subagent",
							"memory",
							"mcp",
						]);
						// `mcp: false` is the one a user could otherwise not see: the servers
						// are still in the file and this importer still brings them across.
						const mcp = named.find((i) => i.from.endsWith("features.mcp"));
						expect(mcp?.detail).toContain("imported below whether this flag is set or not");
					},
				);
			});
		});

		describe("hooks", () => {
			withHome({ ".zcode/v2/config.json": "{}", ".zcode/cli/config.json": JSON.stringify({ hooks: {} }) }, (home) => {
				const result = runMigration({ home });
				// What a user writes before filling the block in. A line about it on
				// every run would be noise about a file that has said nothing —
				// and it would be noise about a key that *is* read, so silence here
				// is not the same as the silence this importer had to stop doing.
				expect(result.plan.items.some((i) => i.from.includes("hooks"))).toBe(false);
				expect(result.plan.writes).toEqual([]);
			});
		});
	});
});
function seedDb(home: string): string {
	return makeZcodeDb(home, DEFAULT_SETTINGS_ROWS);
}

function settingsWrite(result: ReturnType<typeof runMigration>): { content: string; containsSecret: boolean } {
	const write = result.plan.writes.find((w) => w.path.endsWith("settings.json"));
	if (!write) throw new Error("no settings write in the plan");
	return write;
}

/**
 * The two root answers, borrowed and set for the duration of `body`.
 *
 * These functions read `process.env` on every call rather than at import, so a
 * test that did not clear the variables would silently read the developer's own
 * ZCode install — and a developer who has set either one would see these fail
 * while the default-path tests above still pass.
 */
function withZcodeEnv(vars: Record<string, string | null>, body: () => void): void {
	const names = ["ZCODE_DATA_BASE_DIR", "ZCODE_STORAGE_DIR", "ZCODE_SESSION_DB_PATH", "ZCODE_SESSION_DB"];
	const borrowed = new Map<string, string | undefined>(names.map((name) => [name, process.env[name]]));
	try {
		for (const name of names) {
			const value = vars[name];
			if (value === null || value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		body();
	} finally {
		for (const [name, value] of borrowed) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe("the ZCode roots", () => {
	// An absolute path under the temp root that is never created: these are path
	// joins, not filesystem reads. It has to be absolute because `storage.dir` is
	// resolved the way ZCode resolves it, and resolving a relative one would hang
	// the expectation on the working directory the test happens to run in.
	const home = join(tmpdir(), "lbb-zcode-roots-home");

	test("the data root is the home's own directory when no variable names one", () => {
		withZcodeEnv({}, () => {
			expect(zcodeRoot(home)).toBe(join(home, ZCODE_DEFAULT_DIR));
		});
	});

	test("a whitespace-only data base is no value at all, not a directory named a space", () => {
		withZcodeEnv({ ZCODE_DATA_BASE_DIR: "  \t " }, () => {
			expect(zcodeRoot(home)).toBe(join(home, ZCODE_DEFAULT_DIR));
		});
	});

	test("the data base is joined onto as written — a `~` in it is a directory called `~`", () => {
		// ZCode's own reader does `getDataBaseDir()?.trim()` and nothing else, so it
		// would open a directory literally named `~` under the working directory.
		// Expanding it here would point the importer at a tree ZCode never reads.
		withZcodeEnv({ ZCODE_DATA_BASE_DIR: "  ~/elsewhere  " }, () => {
			expect(zcodeRoot(home)).toBe(join("~/elsewhere", ZCODE_DEFAULT_DIR));
			expect(zcodeRoot(home).startsWith(home)).toBe(false);
		});
	});

	test("the CLI config file stays under the home even when every variable is set", () => {
		// `getDefaultConfigPath()` consults no environment at all, so this is the one
		// file in this source that cannot be anywhere else — and the file that records
		// a `storage` move, which is why it is read before the rest.
		withZcodeEnv(
			{
				ZCODE_DATA_BASE_DIR: join(home, "elsewhere"),
				ZCODE_STORAGE_DIR: join(home, "moved"),
				ZCODE_SESSION_DB_PATH: join(home, "elsewhere", "db.sqlite"),
			},
			() => {
				expect(zcodeCliConfigDir(home)).toBe(join(home, ZCODE_DEFAULT_DIR, "cli"));
			},
		);
	});

	test("the storage directory is the home's own unless something names one", () => {
		withZcodeEnv({}, () => {
			expect(zcodeStorageDir(home, {})).toBe(join(home, ZCODE_DEFAULT_DIR));
		});
	});

	test("the variable outranks `storage.dir`, and takes its value raw", () => {
		// The env adapter's `STORAGE_DIR` branch is a bare assignment with no trim,
		// and `createConfig` ranks `ZCODE_*` above the user config file — so a blank
		// variable is a value, not an absence. Reading it as a path, ZCode would look
		// under the working directory; treating it as unset would read the user's real
		// tree, which is a different answer to a different question.
		const config = { storage: { dir: join(home, "from-config") } };
		withZcodeEnv({ ZCODE_STORAGE_DIR: join(home, "from-env") }, () => {
			expect(zcodeStorageDir(home, config)).toBe(join(home, "from-env"));
		});
		withZcodeEnv({ ZCODE_STORAGE_DIR: "   " }, () => {
			expect(zcodeStorageDir(home, config)).toBe(resolve("   "));
		});
		withZcodeEnv({ ZCODE_STORAGE_DIR: "" }, () => {
			expect(zcodeStorageDir(home, config)).toBe(resolve(""));
		});
	});

	test("`storage.dir` is expanded the way ZCode expands it — unlike the data base", () => {
		withZcodeEnv({}, () => {
			expect(zcodeStorageDir(home, { storage: { dir: "~/moved" } })).toBe(join(home, "moved"));
			expect(zcodeStorageDir(home, { storage: { dir: join(home, "moved") } })).toBe(join(home, "moved"));
		});
	});

	test("a `storage.dir` the file's schema would have rejected is no value, but whitespace is", () => {
		// `storageSchema` is `z.string().min(1).optional()`, so an empty string never
		// reaches the config; a space does, and `resolvePath` would send ZCode to the
		// working directory just the same.
		withZcodeEnv({}, () => {
			for (const storage of [{}, { dir: "" }, { dir: 7 }, { dir: null }]) {
				expect(zcodeStorageDir(home, { storage })).toBe(join(home, ZCODE_DEFAULT_DIR));
			}
			expect(zcodeStorageDir(home, { storage: "elsewhere" })).toBe(join(home, ZCODE_DEFAULT_DIR));
			expect(zcodeStorageDir(home, { storage: null })).toBe(join(home, ZCODE_DEFAULT_DIR));
			expect(zcodeStorageDir(home, { storage: { dir: "   " } })).toBe(resolve("   "));
		});
	});

	test("`cli` is not doubled when the storage directory is already named `cli`", () => {
		const at = join(home, "already");
		withZcodeEnv({ ZCODE_STORAGE_DIR: join(at, "cli") }, () => {
			expect(zcodeCliDir(home, {})).toBe(join(at, "cli"));
			expect(zcodeCliDir(home, {}).match(/cli.*cli/)).toBeNull();
		});
		withZcodeEnv({ ZCODE_STORAGE_DIR: at }, () => {
			expect(zcodeCliDir(home, {})).toBe(join(at, "cli"));
		});
	});

	test("the database is under the home and does not follow the storage directory", () => {
		// The one that is easy to get wrong: `storage.dir` moves the plugin cache and
		// the logs, and `getSessionDbPath` never looks at it. A user who moved it has
		// their transcripts and permission rules still in the default tree, so reading
		// the database out of `zcodeCliDir` finds nothing and reports every rule as
		// absent.
		withZcodeEnv({}, () => {
			expect(zcodeDbPath(home, {})).toBe(join(home, ZCODE_DEFAULT_DIR, "cli", "db", "db.sqlite"));
		});
		withZcodeEnv({ ZCODE_STORAGE_DIR: join(home, "moved") }, () => {
			expect(zcodeDbPath(home, {})).toBe(join(home, ZCODE_DEFAULT_DIR, "cli", "db", "db.sqlite"));
		});
		withZcodeEnv({}, () => {
			expect(zcodeDbPath(home, { storage: { dir: join(home, "moved") } })).toBe(
				join(home, ZCODE_DEFAULT_DIR, "cli", "db", "db.sqlite"),
			);
		});
	});

	test("either spelling of the database variable moves the database, the longer one first", () => {
		const config = { storage: { sessionDbPath: join(home, "from-config", "db.sqlite") } };
		withZcodeEnv({ ZCODE_SESSION_DB_PATH: join(home, "long", "db.sqlite") }, () => {
			expect(zcodeDbPath(home, config)).toBe(join(home, "long", "db.sqlite"));
		});
		withZcodeEnv({ ZCODE_SESSION_DB: join(home, "short", "db.sqlite") }, () => {
			expect(zcodeDbPath(home, config)).toBe(join(home, "short", "db.sqlite"));
		});
		withZcodeEnv(
			{ ZCODE_SESSION_DB_PATH: join(home, "long", "db.sqlite"), ZCODE_SESSION_DB: join(home, "short", "x") },
			() => {
				expect(zcodeDbPath(home, config)).toBe(join(home, "long", "db.sqlite"));
			},
		);
		withZcodeEnv({}, () => {
			expect(zcodeDbPath(home, config)).toBe(join(home, "from-config", "db.sqlite"));
		});
	});

	test("a `storage.sessionDbPath` is expanded like every other path the file can name", () => {
		withZcodeEnv({}, () => {
			expect(zcodeDbPath(home, { storage: { sessionDbPath: "~/elsewhere/db.sqlite" } })).toBe(
				join(home, "elsewhere", "db.sqlite"),
			);
		});
	});

	test("the beta tree is a sibling of the default one and never follows a variable", () => {
		withZcodeEnv({ ZCODE_DATA_BASE_DIR: join(home, "elsewhere"), ZCODE_STORAGE_DIR: join(home, "moved") }, () => {
			expect(zcodeBetaDir(home)).toBe(join(home, ZCODE_BETA_DIR));
			// A child of the default tree would be the wrong shape entirely: ZCode
			// writes it beside `~/.zcode`, and a data base that moved the desktop
			// half does not carry it along.
			expect(zcodeBetaDir(home).startsWith(`${zcodeRoot(home)}/`)).toBe(false);
		});
	});
});
