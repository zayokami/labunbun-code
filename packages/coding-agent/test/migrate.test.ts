import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	detectSources,
	formatMigrationReport,
	planMigration,
	readSources,
	resolveModelReference,
	runMigration,
} from "../src/migrate.ts";
import { loadSettings } from "../src/settings.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

/**
 * Run `body` against a throwaway home seeded with `tree`. USERPROFILE is
 * redirected because the settings and MCP loaders resolve user scope through it.
 */
function withHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-"));
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

/** Every file under `dir`, as `relative path → content`, for snapshot compares. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string): void => {
		if (!existsSync(current)) return;
		for (const name of readdirSync(current).sort()) {
			const full = join(current, name);
			if (statSync(full).isDirectory()) walk(full);
			else out[relative(dir, full).replace(/\\/g, "/")] = readFileSync(full, "utf8");
		}
	};
	walk(dir);
	return out;
}

const CLAUDE_SETTINGS = JSON.stringify({
	env: {
		ANTHROPIC_AUTH_TOKEN: "token-value",
		ANTHROPIC_BASE_URL: "https://proxy.example/v1",
		API_TIMEOUT_MS: "600000",
	},
	model: "opus",
	effortLevel: "xhigh",
	enabledPlugins: { "some-plugin": true },
	permissions: { allow: ["Bash(git *)"], deny: ["Read(**/.env)"], additionalDirectories: [] },
});

const CLAUDE_STATE = JSON.stringify({
	mcpServers: {
		docs: { type: "http", url: "https://mcp.example/docs", headers: { DOCS_API_KEY: "header-token" } },
		local: { type: "stdio", command: "node", args: ["server.js"] },
	},
	projects: { "/some/project": { lastCost: 0.42, lastDuration: 1200 } },
	tipsHistory: { tip: 3 },
});

const CODEX_CONFIG = [
	'model = "gpt-5.6-terra"',
	'model_provider = "packyprov"',
	'model_reasoning_effort = "xhigh"',
	"",
	"[model_providers.packyprov]",
	'base_url = "https://provider.example/v1"',
	'wire_api = "responses"',
	"",
	"[projects.'g:\\\\somewhere']",
	'trust_level = "trusted"',
	"",
	"[windows]",
	'sandbox = "elevated"',
].join("\n");

const FULL_TREE: SourceTree = {
	".claude/settings.json": CLAUDE_SETTINGS,
	".claude.json": CLAUDE_STATE,
	".claude/skills/demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: A demo\n---\n\nDo the thing.\n",
	".claude/rules/house-style.md": "Always use tabs.\n",
	".codex/config.toml": CODEX_CONFIG,
	".codex/AGENTS.md": "Codex memory content.\n",
};

describe("source detection", () => {
	test("reports only the sources that exist", () => {
		withHome({ ".claude/settings.json": "{}" }, (home) => {
			expect(detectSources(home)).toEqual(["claude-code"]);
		});
		withHome(FULL_TREE, (home) => {
			expect(detectSources(home)).toEqual(["claude-code", "codex"]);
		});
	});

	test("an empty home yields an empty plan and a readable report", () => {
		withHome({}, (home) => {
			const result = runMigration({ home });
			expect(result.plan.items).toEqual([]);
			expect(result.plan.writes).toEqual([]);
			expect(result.report).toContain("No source configuration found");
		});
	});

	test("unreadable source files migrate nothing instead of throwing", () => {
		withHome({ ".claude/settings.json": "{ not json", ".codex/config.toml": "= = broken" }, (home) => {
			const result = runMigration({ home });
			expect(result.plan.writes).toEqual([]);
		});
	});
});

describe("model references", () => {
	test.each([
		["opus", "anthropic/claude-opus-5"],
		["sonnet", "anthropic/claude-sonnet-5"],
		["haiku", "anthropic/claude-haiku-4-5"],
		["fable", "anthropic/claude-fable-5"],
		["anthropic/claude-opus-5", "anthropic/claude-opus-5"],
	])("resolves %s", (input, expected) => {
		expect(resolveModelReference(input)).toBe(expected);
	});

	test("an unknown name resolves to nothing rather than a bad reference", () => {
		expect(resolveModelReference("gpt-5.6-terra")).toBeUndefined();
		expect(resolveModelReference("")).toBeUndefined();
	});

	test("an unresolvable model is reported as a skip, not dropped", () => {
		withHome({ ".codex/config.toml": CODEX_CONFIG }, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["codex"] });
			const item = plan.items.find((i) => i.from.includes("model ("));
			expect(item?.action).toBe("skip");
			expect(item?.detail).toContain("packyprov");
		});
	});
});

describe("mapping", () => {
	test("env, model, and MCP servers carry over", () => {
		withHome(FULL_TREE, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			const settings = plan.writes.find((w) => w.kind === "settings");
			const parsed = JSON.parse(settings?.content ?? "{}");
			expect(parsed.model).toBe("anthropic/claude-opus-5");
			expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://proxy.example/v1");
			expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("token-value");
			expect(parsed.permissions.allow).toEqual(["Bash(git *)"]);

			const mcp = plan.writes.find((w) => w.kind === "mcp");
			const servers = JSON.parse(mcp?.content ?? "{}").mcpServers;
			expect(Object.keys(servers).sort()).toEqual(["docs", "local"]);
		});
	});

	test("credentials are flagged so the report can name their target files", () => {
		withHome(FULL_TREE, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			const tokenItem = plan.items.find((i) => i.from.includes("ANTHROPIC_AUTH_TOKEN"));
			expect(tokenItem?.containsSecret).toBe(true);
			// A plain endpoint is configuration, not a credential.
			expect(plan.items.find((i) => i.from.includes("ANTHROPIC_BASE_URL"))?.containsSecret).toBe(false);
			// Header-bearing MCP servers count as secret-carrying.
			expect(plan.items.find((i) => i.from.includes("mcpServers.docs"))?.containsSecret).toBe(true);
			expect(plan.items.find((i) => i.from.includes("mcpServers.local"))?.containsSecret).toBe(false);

			const report = formatMigrationReport(plan);
			expect(report).toContain("would contain");
			// Paths are shown home-relative, the same way source paths are.
			for (const write of plan.writes.filter((w) => w.containsSecret)) {
				const shown = `~/${relative(home, write.path).replace(/\\/g, "/")}`;
				expect(report).toContain(shown);
			}
			// The report names files, never the credential values themselves.
			expect(report).not.toContain("token-value");
			expect(report).not.toContain("header-token");
		});
	});

	test("skills and rules become files at their labunbun locations", () => {
		withHome(FULL_TREE, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			const paths = plan.writes.map((w) => w.path.replace(/\\/g, "/"));
			expect(paths).toContain(join(home, ".labunbun/skills/demo-skill/SKILL.md").replace(/\\/g, "/"));
			expect(paths).toContain(join(home, ".labunbun/rules/house-style.md").replace(/\\/g, "/"));
		});
	});

	test("the report shows paths home-relative on both sides of the arrow", () => {
		withHome(FULL_TREE, (home) => {
			const report = formatMigrationReport(planMigration(readSources(home), {}, { only: ["claude-code"] }));
			expect(report).toContain("~/.claude/skills/demo-skill/SKILL.md → ~/.labunbun/skills/demo-skill/SKILL.md");
			// The home prefix itself never appears, so the output stays readable
			// and does not depend on where home happens to be.
			expect(report).not.toContain(home.replace(/\\/g, "/"));
		});
	});

	test("an unsupported provider protocol downgrades with an explanation", () => {
		withHome({ ".codex/config.toml": CODEX_CONFIG }, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["codex"] });
			const item = plan.items.find((i) => i.from.includes("model_providers.packyprov"));
			expect(item?.action).toBe("downgrade");
			expect(item?.detail).toContain("chat-completions");
			expect(item?.detail).toContain("PACKYPROV_API_KEY");

			const settings = JSON.parse(plan.writes.find((w) => w.kind === "settings")?.content ?? "{}");
			expect(settings.providers.openaiCompatible[0]).toMatchObject({
				id: "packyprov",
				baseUrl: "https://provider.example/v1",
				apiKeyEnv: "PACKYPROV_API_KEY",
			});
		});
	});

	test("source memory becomes a rule file so it merges with existing memory", () => {
		withHome(FULL_TREE, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["codex"] });
			const write = plan.writes.find((w) => w.path.includes("imported-codex.md"));
			expect(write?.content).toBe("Codex memory content.\n");
			// MEMORY.md is user-curated; the import must not land on top of it.
			expect(plan.writes.some((w) => w.path.endsWith("MEMORY.md"))).toBe(false);
		});
	});

	test.each([
		["effortLevel", "reasoning-effort"],
		["enabledPlugins", "plugin system"],
		["projects", "usage statistics"],
		["tipsHistory", "usage statistics"],
	])("%s is skipped with a stated reason", (key, reason) => {
		withHome(FULL_TREE, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			const item = plan.items.find((i) => i.from.includes(key));
			expect(item?.action).toBe("skip");
			expect(item?.detail).toContain(reason);
		});
	});

	test.each([
		["model_reasoning_effort", "reasoning-effort"],
		["trust_level", "directory trust"],
		["windows.sandbox", "sandbox"],
	])("codex %s is skipped with a stated reason", (key, reason) => {
		withHome(FULL_TREE, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["codex"] });
			const item = plan.items.find((i) => i.from.includes(key));
			expect(item?.action).toBe("skip");
			expect(item?.detail).toContain(reason);
		});
	});

	test("--from selects a single source", () => {
		withHome(FULL_TREE, (home) => {
			const claudeOnly = runMigration({ home, from: "claude-code" });
			expect(claudeOnly.plan.items.every((i) => i.source === "claude-code")).toBe(true);
			const codexOnly = runMigration({ home, from: "codex" });
			expect(codexOnly.plan.items.every((i) => i.source === "codex")).toBe(true);
		});
	});

	test("an unknown --from value is an error, not a silent empty run", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home, from: "nonexistent-tool" });
			expect(result.error).toContain("Unknown migration source");
			expect(result.plan.writes).toEqual([]);
		});
	});
});

describe("dry run", () => {
	test("writes nothing", () => {
		withHome(FULL_TREE, (home) => {
			const before = snapshot(home);
			const result = runMigration({ home, from: "all" });
			expect(result.plan.writes.length).toBeGreaterThan(0);
			expect(result.applied).toBeUndefined();
			expect(snapshot(home)).toEqual(before);
			expect(result.report).toContain("Dry run");
		});
	});

	test("leaves the source tree untouched even when applying", () => {
		withHome(FULL_TREE, (home) => {
			const sourcesBefore = { ...snapshot(join(home, ".claude")), ...snapshot(join(home, ".codex")) };
			const stateBefore = readFileSync(join(home, ".claude.json"), "utf8");
			runMigration({ home, from: "all", apply: true });
			expect({ ...snapshot(join(home, ".claude")), ...snapshot(join(home, ".codex")) }).toEqual(sourcesBefore);
			expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(stateBefore);
		});
	});
});

describe("apply", () => {
	test("imported values load back through the settings loader", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home, from: "all", apply: true });
			expect(result.applied?.failed).toEqual([]);
			const cwd = mkdtempSync(join(tmpdir(), "lbb-proj-"));
			try {
				const loaded = loadSettings(cwd);
				expect(loaded.settings.model).toBe("anthropic/claude-opus-5");
				expect(loaded.settings.env?.ANTHROPIC_BASE_URL).toBe("https://proxy.example/v1");
				expect(loaded.settings.permissions.deny).toEqual(["Read(**/.env)"]);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	test("existing values are kept, not overwritten", () => {
		withHome(
			{ ...FULL_TREE, ".labunbun/settings.json": JSON.stringify({ model: "anthropic/claude-sonnet-5" }) },
			(home) => {
				const result = runMigration({ home, from: "claude-code", apply: true });
				const settings = JSON.parse(readFileSync(join(home, ".labunbun", "settings.json"), "utf8"));
				expect(settings.model).toBe("anthropic/claude-sonnet-5");
				const item = result.plan.items.find((i) => i.from.includes("model ("));
				expect(item?.action).toBe("skip");
				expect(item?.detail).toContain("--force");
			},
		);
	});

	test("--force overwrites the existing value", () => {
		withHome(
			{ ...FULL_TREE, ".labunbun/settings.json": JSON.stringify({ model: "anthropic/claude-sonnet-5" }) },
			(home) => {
				runMigration({ home, from: "claude-code", apply: true, force: true });
				const settings = JSON.parse(readFileSync(join(home, ".labunbun", "settings.json"), "utf8"));
				expect(settings.model).toBe("anthropic/claude-opus-5");
			},
		);
	});

	test("an existing MCP config is merged, not replaced", () => {
		withHome(
			{
				...FULL_TREE,
				".labunbun/.mcp.json": JSON.stringify({
					mcpServers: {
						mine: { type: "stdio", command: "keep-me" },
						docs: { type: "stdio", command: "my-own-docs" },
					},
				}),
			},
			(home) => {
				const result = runMigration({ home, from: "claude-code", apply: true });
				const servers = JSON.parse(readFileSync(join(home, ".labunbun", ".mcp.json"), "utf8")).mcpServers;
				// The user's own server survives an import that never mentions it.
				expect(servers.mine.command).toBe("keep-me");
				// A name collision keeps the user's definition and says so.
				expect(servers.docs.command).toBe("my-own-docs");
				expect(result.plan.items.find((i) => i.from.includes("mcpServers.docs"))?.action).toBe("skip");
				// A genuinely new server is still added.
				expect(servers.local.command).toBe("node");
			},
		);
	});

	test("--force replaces a colliding MCP server but keeps unrelated ones", () => {
		withHome(
			{
				...FULL_TREE,
				".labunbun/.mcp.json": JSON.stringify({
					mcpServers: {
						mine: { type: "stdio", command: "keep-me" },
						docs: { type: "stdio", command: "my-own-docs" },
					},
				}),
			},
			(home) => {
				runMigration({ home, from: "claude-code", apply: true, force: true });
				const servers = JSON.parse(readFileSync(join(home, ".labunbun", ".mcp.json"), "utf8")).mcpServers;
				expect(servers.docs.url).toBe("https://mcp.example/docs");
				expect(servers.mine.command).toBe("keep-me");
			},
		);
	});

	test("two sources offering the same skill name resolve to one file, reported", () => {
		withHome(
			{
				".claude/skills/shared/SKILL.md": "FROM THE FIRST SOURCE\n",
				".codex/skills/shared/SKILL.md": "FROM THE SECOND SOURCE\n",
			},
			(home) => {
				const result = runMigration({ home, from: "all", apply: true });
				const written = readFileSync(join(home, ".labunbun", "skills", "shared", "SKILL.md"), "utf8");
				expect(written).toBe("FROM THE FIRST SOURCE\n");
				// The loser is reported rather than silently discarded.
				const skipped = result.plan.items.find((i) => i.detail.includes("another source"));
				expect(skipped?.action).toBe("skip");
				expect(skipped?.source).toBe("codex");
				// One target path means one write, not two racing to the same file.
				expect(result.plan.writes.filter((w) => w.path.includes("shared")).length).toBe(1);
			},
		);
	});

	test("unrelated existing settings survive the merge", () => {
		withHome({ ...FULL_TREE, ".labunbun/settings.json": JSON.stringify({ theme: "light", vimMode: true }) }, (home) => {
			runMigration({ home, from: "all", apply: true });
			const settings = JSON.parse(readFileSync(join(home, ".labunbun", "settings.json"), "utf8"));
			expect(settings.theme).toBe("light");
			expect(settings.vimMode).toBe(true);
			expect(settings.model).toBe("anthropic/claude-opus-5");
		});
	});

	test("re-running does not clobber what the first run wrote", () => {
		withHome(FULL_TREE, (home) => {
			runMigration({ home, from: "all", apply: true });
			const afterFirst = snapshot(join(home, ".labunbun"));
			writeFileSync(join(home, ".labunbun", "rules", "house-style.md"), "edited by hand\n");
			const second = runMigration({ home, from: "all", apply: true });
			expect(readFileSync(join(home, ".labunbun", "rules", "house-style.md"), "utf8")).toBe("edited by hand\n");
			expect(second.plan.items.some((i) => i.action === "skip" && i.detail.includes("already exists"))).toBe(true);
			expect(Object.keys(snapshot(join(home, ".labunbun"))).sort()).toEqual(Object.keys(afterFirst).sort());
		});
	});

	test("the report lists what was written", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home, from: "all", apply: true });
			expect(result.report).toContain("Wrote");
			expect(result.report).toContain("now contain");
			for (const path of result.applied?.written ?? []) {
				expect(existsSync(path)).toBe(true);
			}
		});
	});
});
