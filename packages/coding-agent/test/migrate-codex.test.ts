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
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRoot } from "../src/codex-home.ts";
import {
	detectSources,
	type MigrationItem,
	type MigrationPlan,
	planMigration,
	readSources,
	runMigration,
} from "../src/migrate.ts";
import type { RawSettingsInput } from "../src/settings.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

/**
 * Environment variables a test borrowed, restored after it.
 *
 * `$CODEX_HOME` is read at every call rather than snapshotted, so a developer
 * machine that has one set would otherwise decide what these tests read — the
 * fixtures live in a temp home, and the variable has to be out of the way for
 * that to be true.
 */
const borrowed = new Map<string, string | undefined>();
afterEach(() => {
	for (const [name, value] of borrowed) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	borrowed.clear();
});

function setEnv(name: string, value: string | undefined): void {
	if (!borrowed.has(name)) borrowed.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Temp directories, swept with the test that asked for them. */
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function withHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-codex-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	const prevCodexHome = process.env.CODEX_HOME;
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		delete process.env.CODEX_HOME;
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
		if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = prevCodexHome;
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

describe("codex global instructions", () => {
	/** The rule file the plan would write for the memory document. */
	function ruleContent(planned: MigrationPlan): string {
		return planned.writes.find((w) => w.kind === "rule")?.content ?? "";
	}

	test("AGENTS.override.md is the document Codex reads, so it is the one imported", () => {
		withHome(
			{
				".codex/AGENTS.md": "the document that is not in force\n",
				".codex/AGENTS.override.md": "the document Codex reads\n",
			},
			(home) => {
				const planned = plan(home);
				expect(ruleContent(planned)).toContain("the document Codex reads");
				expect(ruleContent(planned)).not.toContain("not in force");
				const imported = item(planned, "AGENTS.override.md");
				expect(imported?.action).toBe("map");
				// Codex reads one of the two and this is the one it does not: the user
				// wrote it believing otherwise, so it is named rather than dropped.
				const shadowed = planned.items.find((i) => i.detail.includes("not the ones in force"));
				expect(shadowed?.from).toContain("AGENTS.md");
				expect(shadowed?.from).not.toContain("override");
			},
		);
	});

	test("an override holding only whitespace falls through to AGENTS.md", () => {
		withHome({ ".codex/AGENTS.md": "the document in force\n", ".codex/AGENTS.override.md": "  \n" }, (home) => {
			const planned = plan(home);
			expect(ruleContent(planned)).toContain("the document in force");
			expect(planned.items.some((i) => i.detail.includes("not the ones in force"))).toBe(false);
		});
	});

	test("AGENTS.md alone is imported without a word about an override", () => {
		withHome({ ".codex/AGENTS.md": "memory\n" }, (home) => {
			const planned = plan(home);
			expect(ruleContent(planned)).toContain("memory");
			expect(planned.items.some((i) => i.from.includes("override"))).toBe(false);
		});
	});
});

describe("$CODEX_HOME", () => {
	test("the root is the variable as written, and only an empty one falls back", () => {
		const home = tempDir("lbb-codex-root-");
		setEnv("CODEX_HOME", undefined);
		expect(codexRoot(home)).toBe(join(home, ".codex"));
		setEnv("CODEX_HOME", "");
		expect(codexRoot(home)).toBe(join(home, ".codex"));
		// Codex filters on `is_empty`, not on `trim`, so a whitespace-only value
		// names a directory: reading it as unset would import a tree Codex is not
		// writing to, and every report line would name the wrong path.
		setEnv("CODEX_HOME", " ");
		expect(codexRoot(home)).toBe(" ");
		// No `~` expansion and no resolution, unlike the harness — the value is a
		// path as written, which is what Codex does with it.
		setEnv("CODEX_HOME", "~/codex-alt");
		expect(codexRoot(home)).toBe("~/codex-alt");
		const elsewhere = join(home, "elsewhere");
		setEnv("CODEX_HOME", elsewhere);
		expect(codexRoot(home)).toBe(elsewhere);
	});

	test("the tree the variable names is the one read, and the labels say so", () => {
		const home = tempDir("lbb-codex-home-");
		const elsewhere = tempDir("lbb-codex-elsewhere-");
		// A tree under ~ that Codex is not using: importing from it would carry the
		// wrong documents across, so the fixture makes both trees different.
		mkdirSync(join(home, ".codex"), { recursive: true });
		writeFileSync(join(home, ".codex", "AGENTS.md"), "the tree Codex is not using\n");
		writeFileSync(join(elsewhere, "AGENTS.md"), "the tree Codex reads\n");
		writeFileSync(join(elsewhere, "config.toml"), codexConfig({ top: ["model_context_window = 1000000"] }));

		setEnv("HOME", home);
		setEnv("USERPROFILE", home);
		setEnv("CODEX_HOME", elsewhere);
		expect(detectSources(home)).toContain("codex");
		const planned = plan(home);
		expect(planned.writes.find((w) => w.kind === "rule")?.content).toContain("the tree Codex reads");
		// The label names the file the reader opened, not a path under ~ that holds
		// nothing: `$CODEX_HOME` can be anywhere, and the report has to say where.
		expect(item(planned, "AGENTS.md")?.from).toBe(join(elsewhere, "AGENTS.md").replace(/\\/g, "/"));
	});

	test("a tree the variable places under home is still labelled from the root", () => {
		const home = tempDir("lbb-codex-home-");
		const under = join(home, "codex-alt");
		mkdirSync(under, { recursive: true });
		writeFileSync(join(under, "AGENTS.md"), "memory\n");
		setEnv("HOME", home);
		setEnv("USERPROFILE", home);
		setEnv("CODEX_HOME", under);
		const planned = plan(home);
		expect(item(planned, "AGENTS.md")?.from).toBe("~/codex-alt/AGENTS.md");
	});

	test("a tree under ~ is not read when the variable points elsewhere", () => {
		const home = tempDir("lbb-codex-home-");
		const empty = tempDir("lbb-codex-empty-");
		mkdirSync(join(home, ".codex"), { recursive: true });
		writeFileSync(join(home, ".codex", "config.toml"), codexConfig());
		setEnv("HOME", home);
		setEnv("USERPROFILE", home);
		setEnv("CODEX_HOME", empty);
		// Detection looks at the same root the reader reads, so a source whose tree
		// is empty under the variable is a source that is not there.
		expect(detectSources(home)).not.toContain("codex");
	});
});

describe("codex keys that are reported rather than carried", () => {
	test("the permission posture is one line rather than silence", () => {
		const planned = planConfig(codexConfig({ top: ['approval_policy = "on-request"', 'sandbox_mode = "read-only"'] }));
		const posture = item(planned, "approval_policy");
		expect(posture?.action).toBe("skip");
		expect(posture?.from).toContain("sandbox_workspace_write");
		expect(posture?.detail).toContain("no OS-level sandbox");
	});

	test("named permission profiles are named", () => {
		const planned = planConfig(
			codexConfig({
				top: ['default_permissions = "strict"'],
				tail: ["[permissions.strict]", 'workspace_roots = ["C:/work"]'],
			}),
		);
		expect(item(planned, "default_permissions")?.detail).toContain("named permission profiles");
		// The table under it is part of the same line, so it must not also fall
		// through to the by-name list: one key of the config, one line about it.
		expect(planned.items.some((i) => i.detail.includes("no mapping for and no note about"))).toBe(false);
	});

	test("system instructions are named, with what stands in for them", () => {
		const detail =
			item(
				planConfig(codexConfig({ top: ['developer_instructions = "always answer in Welsh"'] })),
				"developer_instructions",
			)?.detail ?? "";
		expect(detail).toContain("system prompt");
		expect(detail).toContain("rules");
	});

	test("hooks declared in the file name the events with no counterpart here", () => {
		const detail =
			item(
				planConfig(
					codexConfig({
						tail: [
							"[[hooks.PreToolUse]]",
							'matcher = "Bash"',
							"[[hooks.PreToolUse.hooks]]",
							'command = "./check.sh"',
							"",
							"[[hooks.Interrupt]]",
						],
					}),
				),
				"→ hooks",
			)?.detail ?? "";
		// `PreToolUse` is an event this build has; `Interrupt` is one it does not,
		// and that is the part a user cannot work out from the key's name alone.
		expect(detail).toContain("Interrupt");
		expect(detail).toContain("2 hook event(s)");
		expect(detail).not.toContain("PreToolUse");
		expect(detail).toContain("seconds");
	});

	test("skill switches are named as switches this importer does not apply", () => {
		const detail =
			item(planConfig(codexConfig({ tail: ["[[skills.config]]", 'name = "pdf"', "enabled = false"] })), "→ skills")
				?.detail ?? "";
		expect(detail).toContain("enabled = false");
		expect(detail).toContain("not applied");
	});

	test("the memory pipeline is named", () => {
		const detail =
			item(planConfig(codexConfig({ tail: ["[memories]", "use_memories = false"] })), "→ memories")?.detail ?? "";
		expect(detail).toContain("memory pipeline");
	});

	test("the legacy profile key is reported as one Codex rejects", () => {
		const planned = planConfig(codexConfig({ top: ['profile = "work"'] }));
		const legacy = item(planned, 'profile ("work")');
		expect(legacy?.action).toBe("skip");
		expect(legacy?.detail).toContain("--profile");
		expect(legacy?.detail).toContain("does not load");
	});

	test("profile files are named, with what they are for", () => {
		const planned = planConfig(codexConfig({ top: ['profile = "work"'] }));
		const archives = item(planned, "*.config.toml");
		// The fixture has no profile files, so the line must not be there.
		expect(archives).toBeUndefined();
		withHome({ ".codex/config.toml": codexConfig(), ".codex/work.config.toml": 'model = "gpt-5.6-terra"' }, (home) => {
			const planned2 = plan(home);
			const named = item(planned2, "*.config.toml");
			expect(named?.detail).toContain("work");
			expect(named?.detail).toContain("layered over the base file");
		});
	});

	test("a key with no mapping of its own reaches the report by name", () => {
		const planned = planConfig(codexConfig({ top: ['web_search = "live"'] }));
		const fallback = planned.items.find((i) => i.detail.includes("no mapping for and no note about"));
		expect(fallback?.from).toContain("web_search");
	});

	test("a key that has a line of its own is not reported twice", () => {
		const planned = planConfig(codexConfig({ top: ["tui = { animations = false }"] }));
		expect(planned.items.filter((i) => i.from.includes("→ tui")).length).toBe(1);
		expect(planned.items.some((i) => i.detail.includes("no mapping for and no note about"))).toBe(false);
	});

	test("a config this importer fully understands says nothing about unhandled keys", () => {
		const planned = planConfig(codexConfig({ tail: MCP_SERVERS }));
		expect(planned.items.some((i) => i.detail.includes("no mapping for and no note about"))).toBe(false);
	});
});
