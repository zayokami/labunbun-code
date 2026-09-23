import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { detectSources, runMigration } from "../src/migrate.ts";
import { loadSettings } from "../src/settings.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

/**
 * Run `body` against a throwaway home seeded with `tree`. `seed` runs after the
 * files exist, which is where the sqlite fixture is built: a database cannot be
 * expressed as a string in `tree`.
 */
function withHome(tree: SourceTree, body: (home: string) => void, seed?: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-zcode-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		for (const [path, content] of Object.entries(tree)) {
			const full = join(home, path);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, content);
		}
		seed?.(home);
		body(home);
	} finally {
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
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
	const dir = join(home, ".zcode", "cli", "db");
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

	test("a user-scoped permission mode is skipped by name — ZCode's vocabulary does not translate", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			makeZcodeDb(home, [["user", "permission", "mode", { mode: "build" }]]);
			const result = runMigration({ home });
			const item = result.plan.items[0];
			expect(item.action).toBe("skip");
			expect(item.detail).toContain("build");
			expect(item.detail).toContain("/permissions");
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
});

/** Seed the default settings rows and return the database path. */
function seedDb(home: string): string {
	return makeZcodeDb(home, DEFAULT_SETTINGS_ROWS);
}

function settingsWrite(result: ReturnType<typeof runMigration>): { content: string; containsSecret: boolean } {
	const write = result.plan.writes.find((w) => w.path.endsWith("settings.json"));
	if (!write) throw new Error("no settings write in the plan");
	return write;
}
