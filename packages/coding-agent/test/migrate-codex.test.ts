/**
 * What the Codex importer carries, and what it says about what it does not.
 *
 * The machine this was written against is configured as `model`, `model_provider`
 * and `model_context_window` in one file; a provider entry with no models is
 * therefore not a usable import, and the credential variable comes from the
 * source rather than from a name the importer makes up.
 *
 * TOML tables are position-dependent, so the fixtures say where each line goes:
 * anything after `[model_providers.packyprov]` belongs to that table, and a
 * top-level key written below it would silently not be one.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MigrationItem, type MigrationPlan, planMigration, readSources, runMigration } from "../src/migrate.ts";
import type { RawSettingsInput } from "../src/settings.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

function withHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-codex-"));
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
		body(home);
	} finally {
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
		rmSync(home, { recursive: true, force: true });
	}
}

/** A codex config: top-level keys, then the provider table, then anything else. */
function codexConfig(options: { top?: string[]; provider?: string[]; tail?: string[] } = {}): string {
	return [
		'model = "gpt-5.6-terra"',
		'model_provider = "packyprov"',
		...(options.top ?? []),
		"",
		"[model_providers.packyprov]",
		'base_url = "https://provider.example/v1"',
		'wire_api = "responses"',
		...(options.provider ?? []),
		"",
		...(options.tail ?? []),
	].join("\n");
}

/** The plan for one codex config, with no target settings unless one is passed. */
function plan(home: string, existing: RawSettingsInput = {}, force = false): MigrationPlan {
	return planMigration(readSources(home), existing, { only: ["codex"], force });
}

/** Plan a config on its own, without a tree to lay out. */
function planConfig(config: string, existing?: RawSettingsInput): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome({ ".codex/config.toml": config }, (home) => {
		planned = plan(home, existing);
	});
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/** The settings file the plan would write, parsed. */
function plannedSettings(planned: MigrationPlan): Record<string, unknown> {
	const write = planned.writes.find((w) => w.kind === "settings");
	return JSON.parse(write?.content ?? "{}");
}

/** The MCP config the plan would write, parsed. */
function plannedServers(planned: MigrationPlan): Record<string, Record<string, unknown>> {
	const write = planned.writes.find((w) => w.kind === "mcp");
	return JSON.parse(write?.content ?? '{"mcpServers":{}}').mcpServers;
}

function item(planned: MigrationPlan, from: string): MigrationItem | undefined {
	return planned.items.find((i) => i.from.includes(from));
}

const MCP_SERVERS = [
	"[mcp_servers.files]",
	'command = "npx"',
	'args = ["-y", "files-server"]',
	"",
	"[mcp_servers.files.env]",
	'ROOT = "G:/work"',
	"",
	"[mcp_servers.docs]",
	'url = "https://mcp.example/docs"',
	"",
	"[mcp_servers.docs.http_headers]",
	'Authorization = "Bearer header-token"',
	"",
	"[mcp_servers.off]",
	'command = "never"',
	"enabled = false",
];

describe("codex providers", () => {
	test("the credential variable is the one the source names", () => {
		const planned = planConfig(codexConfig({ provider: ['env_key = "PACKY_KEY"'] }));
		const provider = (plannedSettings(planned).providers as { openaiCompatible: Array<Record<string, unknown>> })
			.openaiCompatible[0];
		expect(provider.apiKeyEnv).toBe("PACKY_KEY");
		// The synthesized name is a fallback, not a replacement for what the source said.
		expect(item(planned, "model_providers.packyprov")?.detail).toContain("PACKY_KEY");
		expect(item(planned, "model_providers.packyprov")?.detail).not.toContain("PACKYPROV_API_KEY");
	});

	test("account sign-in is reported as such, not as a missing API key", () => {
		const detail =
			item(planConfig(codexConfig({ provider: ["requires_openai_auth = true"] })), "model_providers.packyprov")
				?.detail ?? "";
		expect(detail).toContain("requires_openai_auth");
		expect(detail).toContain("API key");
	});

	test("model_context_window makes the provider entry usable and the model reachable", () => {
		const planned = planConfig(codexConfig({ top: ["model_context_window = 1000000"] }));
		const settings = plannedSettings(planned);
		const provider = (settings.providers as { openaiCompatible: Array<Record<string, unknown>> }).openaiCompatible[0];
		expect(provider.models).toEqual([{ id: "gpt-5.6-terra", contextWindow: 1000000, maxOutputTokens: 8192 }]);
		expect(settings.model).toBe("packyprov/gpt-5.6-terra");
		expect(item(planned, 'model ("gpt-5.6-terra")')?.action).toBe("map");
	});

	test("without a context window the model is still only reported", () => {
		// Nothing in the source says how large the model is, and a context window
		// is not a number worth inventing: the skip says what to add by hand.
		const planned = planConfig(codexConfig());
		expect(plannedSettings(planned).model).toBeUndefined();
		const skipped = item(planned, 'model ("gpt-5.6-terra")');
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("packyprov");
	});

	test("a provider the target already defines keeps its own definition, and says so", () => {
		const existing: RawSettingsInput = {
			providers: {
				openaiCompatible: [{ id: "packyprov", baseUrl: "https://mine.example/v1", apiKeyEnv: "MINE_KEY", models: [] }],
			},
		};
		const planned = planConfig(codexConfig({ top: ["model_context_window = 1000000"] }), existing);
		const settings = plannedSettings(planned);
		// The kept provider is not in the patch at all, so the model entry is not
		// written either — the model reference would resolve to nothing.
		expect(settings.providers).toBeUndefined();
		expect(settings.model).toBeUndefined();
		const skipped = item(planned, 'model ("gpt-5.6-terra")');
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain('already defines a "packyprov" provider');
	});

	test("the compaction threshold has no equivalent and is reported", () => {
		const detail =
			item(
				planConfig(codexConfig({ top: ["model_auto_compact_token_limit = 900000"] })),
				"model_auto_compact_token_limit",
			)?.detail ?? "";
		expect(detail).toContain("no equivalent threshold");
	});
});

describe("codex MCP servers", () => {
	test("stdio and http servers land in .mcp.json, disabled ones do not", () => {
		const planned = planConfig(codexConfig({ tail: MCP_SERVERS }));
		const servers = plannedServers(planned);
		expect(servers.files).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "files-server"],
			env: { ROOT: "G:/work" },
		});
		expect(servers.docs).toEqual({
			type: "http",
			url: "https://mcp.example/docs",
			headers: { Authorization: "Bearer header-token" },
		});
		expect(servers.off).toBeUndefined();
		expect(item(planned, "mcp_servers.off")?.detail).toContain("disabled in Codex");
		expect(item(planned, "mcp_servers.docs")?.containsSecret).toBe(true);
		expect(planned.writes.find((w) => w.kind === "mcp")?.containsSecret).toBe(true);
	});

	test("a variable the source forwarded is named, never guessed", () => {
		const planned = planConfig(
			codexConfig({
				tail: [
					"[mcp_servers.gh]",
					'command = "gh-mcp"',
					'env_vars = ["GH_TOKEN"]',
					"",
					"[mcp_servers.api]",
					'url = "https://mcp.example/api"',
					'bearer_token_env_var = "API_TOKEN"',
				],
			}),
		);
		const gh = item(planned, "mcp_servers.gh");
		expect(gh?.action).toBe("downgrade");
		expect(gh?.detail).toContain("$GH_TOKEN");
		const api = item(planned, "mcp_servers.api");
		expect(api?.action).toBe("downgrade");
		expect(api?.detail).toContain("$API_TOKEN");
		// The server itself is still carried over; only the header is missing.
		expect(plannedServers(planned).api).toEqual({ type: "http", url: "https://mcp.example/api" });
	});

	test("the report never carries a header value from the source", () => {
		withHome({ ".codex/config.toml": codexConfig({ tail: MCP_SERVERS }) }, (home) => {
			const result = runMigration({ home, from: "codex" });
			expect(result.report).not.toContain("header-token");
		});
	});
});

describe("codex surfaces that are reported but not carried", () => {
	test("hooks.json is named when the file is there", () => {
		withHome({ ".codex/config.toml": codexConfig(), ".codex/hooks.json": '{"PreToolUse":[]}' }, (home) => {
			const skipped = item(plan(home), "hooks.json");
			expect(skipped?.action).toBe("skip");
			expect(skipped?.detail).toContain("hooks");
		});
	});

	// `notify` is a top-level key and the rest are tables: a bare key written
	// after a table header belongs to that table, so where it goes is the test.
	test.each([
		["history", { tail: ["[history]", 'persistence = "save-all"'] }],
		["shell_environment_policy", { tail: ["[shell_environment_policy]", 'set = { FOO = "bar" }'] }],
		["profiles", { tail: ["[profiles.fast]", 'model = "gpt-5"'] }],
		["agents", { tail: ["[agents.reviewer]", 'model = "gpt-5"'] }],
		["notify", { top: ['notify = ["pwsh", "-c", "beep"]'] }],
		["oss_provider", { top: ['oss_provider = "ollama"'] }],
	] as Array<[string, { top?: string[]; tail?: string[] }]>)("config %s is skipped with a reason", (key, sections) => {
		const skipped = item(planConfig(codexConfig(sections)), `→ ${key}`);
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail.length).toBeGreaterThan(20);
	});

	test("a config with none of them says nothing about them", () => {
		const report = planConfig(codexConfig())
			.items.map((i) => i.from)
			.join("\n");
		for (const key of ["notify", "shell_environment_policy", "profiles", "oss_provider"]) {
			expect(report).not.toContain(key);
		}
	});

	test("the source file is untouched by an applied run", () => {
		withHome({ ".codex/config.toml": codexConfig({ tail: MCP_SERVERS }) }, (home) => {
			const before = readFileSync(join(home, ".codex", "config.toml"), "utf8");
			runMigration({ home, from: "codex", apply: true });
			expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(before);
		});
	});
});
