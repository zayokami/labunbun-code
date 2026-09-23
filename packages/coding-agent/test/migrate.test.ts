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
	type MigrationItem,
	type MigrationPlan,
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

/**
 * Detection is the only place `$DSH_HOME` matters — every other tree in this
 * file lives under `~`, where the variable is not consulted — so it is cleared
 * here rather than in `withHome`, which the rest of the file shares.
 */
function withoutDshHome(body: () => void): void {
	const prev = process.env.DSH_HOME;
	try {
		delete process.env.DSH_HOME;
		body();
	} finally {
		if (prev !== undefined) process.env.DSH_HOME = prev;
	}
}

/** A harness home, marked present by the settings document every one has. */
const DSH_TREE: SourceTree = {
	".dsh/settings.yaml": "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\n",
};

describe("source detection", () => {
	test("reports only the sources that exist", () => {
		withoutDshHome(() => {
			withHome({ ".claude/settings.json": "{}" }, (home) => {
				expect(detectSources(home)).toEqual(["claude-code"]);
			});
			withHome(FULL_TREE, (home) => {
				expect(detectSources(home)).toEqual(["claude-code", "codex"]);
			});
			withHome(DSH_TREE, (home) => {
				expect(detectSources(home)).toEqual(["deepseek-harness"]);
			});
		});
	});

	test("a fifth source is appended, so it never displaces an earlier one", () => {
		withoutDshHome(() => {
			withHome({ ".claude/settings.json": "{}", ...DSH_TREE }, (home) => {
				expect(detectSources(home)).toEqual(["claude-code", "deepseek-harness"]);
			});
		});
	});

	test("a source directory holding nothing is not a source", () => {
		withoutDshHome(() => {
			withHome({ ".claude/settings.json": "{}" }, (home) => {
				// `~/.agents` and `~/.dsh` are shared directories other tools create;
				// on their own they offer nothing to import, so they are not worth a
				// question either.
				mkdirSync(join(home, ".agents"), { recursive: true });
				mkdirSync(join(home, ".dsh"), { recursive: true });
				expect(detectSources(home)).toEqual(["claude-code"]);
			});
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
		["fable", "anthropic/claude-fable-5-1"],
		["anthropic/claude-opus-5", "anthropic/claude-opus-5"],
	])("resolves %s", (input, expected) => {
		expect(resolveModelReference(input)).toBe(expected);
	});

	test("an unknown name resolves to nothing rather than a bad reference", () => {
		expect(resolveModelReference("gpt-9-ultra")).toBeUndefined();
		expect(resolveModelReference("")).toBeUndefined();
	});

	test("a name the registry carries resolves, whichever vendor brought it", () => {
		// The OpenAI and Gemini rows are ordinary built-ins: a source that named one
		// imports as a working reference, not as a skip.
		expect(resolveModelReference("gpt-5.6-terra")).toBe("gpt-5.6-terra");
		expect(resolveModelReference("gemini-3.8-flash")).toBe("gemini-3.8-flash");
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

	test("the user's global memory document is imported as a rule too", () => {
		withHome({ ".claude/settings.json": "{}", ".claude/CLAUDE.md": "Always answer in Chinese.\n" }, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			const write = plan.writes.find((w) => w.path.includes("imported-claude-code.md"));
			expect(write?.content).toBe("Always answer in Chinese.\n");
			const item = plannedItem(plan, "~/.claude/CLAUDE.md");
			expect(item?.action).toBe("map");
			expect(item?.to).toContain("imported-claude-code.md");
			// The user's own MEMORY.md is not a destination for an import.
			expect(plan.writes.some((w) => w.path.endsWith("MEMORY.md"))).toBe(false);
		});
	});

	test("a source with no memory document says nothing about one", () => {
		withHome({ ".claude/settings.json": "{}" }, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			expect(plan.writes.some((w) => w.path.includes("imported-claude-code.md"))).toBe(false);
			// Silence is the failure mode this import is full of lines to avoid: no
			// document, no claim that one came across.
			expect(plan.items.some((i) => i.from.includes("CLAUDE.md"))).toBe(false);
		});
	});

	test.each([
		["effortLevel", "reasoning-effort"],
		["enabledPlugins", "plugin system"],
		// Named change: `projects` used to be reported as "usage statistics …
		// not configuration" beside the telemetry keys. It holds each project's
		// local-scope MCP servers, so it is bookkeeping *and* configuration now.
		["projects", "none of it configuration this build reads"],
		["tipsHistory", "usage statistics"],
	])("%s is skipped with a stated reason", (key, reason) => {
		withHome(FULL_TREE, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			const item = plan.items.find((i) => i.from.includes(key));
			expect(item?.action).toBe("skip");
			expect(item?.detail).toContain(reason);
		});
	});

	test("a local-scope MCP server keeps its project's name and is not carried", () => {
		const state = JSON.stringify({
			mcpServers: { docs: { type: "http", url: "https://mcp.example/docs" } },
			projects: {
				"/some/project": {
					mcpServers: { scratchpad: { type: "stdio", command: "node", args: ["pad.js"] } },
					lastCost: 0.42,
				},
			},
		});
		withHome({ ".claude/settings.json": "{}", ".claude.json": state }, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			const local = plannedItem(plan, 'projects["/some/project"].mcpServers.scratchpad');
			expect(local?.action).toBe("skip");
			expect(local?.detail).toContain("local-scope server");
			expect(local?.detail).toContain("<cwd>/.mcp.json");
			// The user-scope server in the same file still comes across: this names
			// the scope with no counterpart here, it does not turn the file away.
			expect(plannedItem(plan, "~/.claude.json → mcpServers.docs")?.to).toBe(".mcp.json → mcpServers.docs");
			// The map itself, exactly: `includes` would find the server line above.
			// One line about it, and not the telemetry sentence it used to carry.
			const map = plan.items.filter((i) => i.from === "~/.claude.json → projects");
			expect(map.length).toBe(1);
			expect(map[0]?.detail).toContain("bookkeeping");
		});
	});

	test("the plugin line names what is enabled instead of claiming coverage", () => {
		const settings = JSON.stringify({ enabledPlugins: { "some-plugin": true, "off-plugin": false } });
		withHome({ ".claude/settings.json": settings }, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			const item = plannedItem(plan, "enabledPlugins");
			expect(item?.action).toBe("skip");
			expect(item?.detail).toContain("some-plugin");
			expect(item?.detail).not.toContain("off-plugin");
			// The sentence that used to be here said skills and MCP servers covered
			// the same ground, which is exactly what a plugin is made of.
			expect(item?.detail).not.toContain("cover the same ground");
		});
	});

	test("a plugin list with nothing enabled says that, rather than naming nobody", () => {
		const settings = JSON.stringify({ enabledPlugins: { "off-plugin": false } });
		withHome({ ".claude/settings.json": settings }, (home) => {
			const plan = planMigration(readSources(home), {}, { only: ["claude-code"] });
			expect(plannedItem(plan, "enabledPlugins")?.detail).toContain("none of them is enabled in the source");
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
				const skipped = result.plan.items.find((i) => i.detail.includes("kept the first one"));
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

/** A claude settings file holding just `permissions`, planned on its own. */
function planPermissions(permissions: Record<string, unknown>): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome({ ".claude/settings.json": JSON.stringify({ permissions }) }, (home) => {
		planned = planMigration(readSources(home), {}, { only: ["claude-code"] });
	});
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/** The settings file a plan would write, parsed. */
function writtenSettings(planned: MigrationPlan): Record<string, unknown> {
	return JSON.parse(planned.writes.find((w) => w.kind === "settings")?.content ?? "{}");
}

function plannedItem(planned: MigrationPlan, from: string): MigrationItem | undefined {
	return planned.items.find((i) => i.from.includes(from));
}

describe("claude code permissions", () => {
	test.each([
		["default", "default"],
		["manual", "default"],
		["plan", "plan"],
		["acceptEdits", "acceptEdits"],
		["bypassPermissions", "bypassPermissions"],
	] as Array<[string, string]>)("defaultMode %s becomes permissionMode %s", (mode, expected) => {
		expect(writtenSettings(planPermissions({ defaultMode: mode })).permissionMode).toBe(expected);
	});

	test("the classifier mode is skipped, because the nearest mode means the opposite", () => {
		const planned = planPermissions({ defaultMode: "auto" });
		expect(writtenSettings(planned).permissionMode).toBeUndefined();
		const skipped = plannedItem(planned, '"auto"');
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("classifier");
		expect(skipped?.detail).toContain("dontAsk");
	});

	test("the ask list is skipped with what its absence means", () => {
		const planned = planPermissions({ ask: ["Bash(rm *)", "WebFetch"] });
		const skipped = plannedItem(planned, "permissions.ask");
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("2 rule(s)");
		// A call that the source would have asked about now just runs; the report
		// points at the one place that can still gate it.
		expect(skipped?.detail).toContain("deny");
	});

	test("allow, deny and additionalDirectories are carried, each reported", () => {
		const planned = planPermissions({
			allow: ["Bash(git *)"],
			deny: ["Read(**/.env)"],
			additionalDirectories: ["G:/work"],
		});
		expect(writtenSettings(planned).permissions).toEqual({
			allow: ["Bash(git *)"],
			deny: ["Read(**/.env)"],
			additionalDirectories: ["G:/work"],
		});
		expect(plannedItem(planned, "permissions.allow")?.action).toBe("map");
		expect(plannedItem(planned, "permissions.deny")?.action).toBe("map");
		expect(plannedItem(planned, "permissions.additionalDirectories")?.action).toBe("map");
	});

	test("a rule the target cannot parse is dropped with a count, not in silence", () => {
		const planned = planPermissions({ allow: ["Bash(git *)", "Bash(git *"] });
		expect(writtenSettings(planned).permissions).toEqual({
			allow: ["Bash(git *)"],
			deny: [],
			additionalDirectories: [],
		});
		expect(planned.items.find((i) => i.detail.includes("1 of 2"))?.action).toBe("skip");
	});

	test("a lockdown that only the policy tier honours is a downgrade, not a write", () => {
		const planned = planPermissions({ disableBypassPermissionsMode: "disable" });
		expect(JSON.stringify(writtenSettings(planned))).not.toContain("disableBypassPermissionsMode");
		const item = plannedItem(planned, "disableBypassPermissionsMode");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("managed-settings.json");
	});

	test("an existing target list is kept, and the other list still comes across", () => {
		const existing = {
			permissions: { allow: ["Bash(ls)"], deny: [], additionalDirectories: [] },
		};
		let planned: MigrationPlan | undefined;
		withHome(
			{
				".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(git *)"], deny: ["Read(**/.env)"] } }),
				".labunbun/settings.json": JSON.stringify(existing),
			},
			(home) => {
				planned = planMigration(readSources(home), existing, { only: ["claude-code"] });
			},
		);
		if (!planned) throw new Error("the fake home did not survive");
		expect(plannedItem(planned, "permissions.allow")?.detail).toContain("--force");
		expect(plannedItem(planned, "permissions.deny")?.action).toBe("map");
		// The rule the user already had is not lost to the one that was imported.
		expect(writtenSettings(planned).permissions).toEqual({
			allow: ["Bash(ls)"],
			deny: ["Read(**/.env)"],
			additionalDirectories: [],
		});
	});
});

/** A claude settings file holding just `hooks`, planned on its own. */
function planHooks(hooks: unknown, existing: Record<string, unknown> = {}): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome(
		{ ".claude/settings.json": JSON.stringify({ hooks }), ".labunbun/settings.json": JSON.stringify(existing) },
		(home) => {
			planned = planMigration(readSources(home), existing, { only: ["claude-code"] });
		},
	);
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

describe("claude code hooks", () => {
	// Named change: this test pinned `timeout: 5000` coming across unchanged, which
	// is 5000 seconds read as 5000 milliseconds — the unit bug itself, held in
	// place by an assertion. The wait is thirty seconds, and thirty seconds is
	// what the target gets.
	test("a command handler for a known event is rewritten as-is", () => {
		const planned = planHooks({
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh", timeout: 30 }] }],
		});
		expect(writtenSettings(planned).hooks).toEqual({
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh", timeout: 30_000 }] }],
		});
		expect(plannedItem(planned, "hooks")?.action).toBe("map");
	});

	test("a handler's timeout is seconds in the source and milliseconds here", () => {
		const planned = planHooks({ Stop: [{ hooks: [{ type: "command", command: "wait.sh", timeout: 45 }] }] });
		expect(writtenSettings(planned).hooks).toEqual({
			Stop: [{ hooks: [{ type: "command", command: "wait.sh", timeout: 45_000 }] }],
		});
		const detail = plannedItem(planned, "→ hooks")?.detail ?? "";
		expect(detail).toContain("converted from the seconds");
		// Converting the unit is not a loss: the wait is the one the source asked for.
		expect(plannedItem(planned, "→ hooks")?.action).toBe("map");
	});

	test("a timeout longer than this build waits is clamped to it, and counted", () => {
		const planned = planHooks({ Stop: [{ hooks: [{ type: "command", command: "wait.sh", timeout: 900 }] }] });
		expect(writtenSettings(planned).hooks).toEqual({
			Stop: [{ hooks: [{ type: "command", command: "wait.sh", timeout: 600_000 }] }],
		});
		// An oversized value would fail the schema and take every hook with it, so
		// the entry still exists — and the report does not call that a map.
		expect(plannedItem(planned, "→ hooks")?.action).toBe("downgrade");
		expect(plannedItem(planned, "→ hooks")?.detail).toContain("clamped");
	});

	test("a handler with no timeout keeps none, and the shorter default is said out loud", () => {
		const planned = planHooks({ Stop: [{ hooks: [{ type: "command", command: "quick.sh" }] }] });
		expect(writtenSettings(planned).hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "quick.sh" }] }] });
		expect(plannedItem(planned, "→ hooks")?.detail).toContain("where the source allowed 10 minutes");
	});

	test("an event this build has no hook for is dropped and counted", () => {
		const planned = planHooks({
			PreToolUse: [{ hooks: [{ type: "command", command: "keep.sh" }] }],
			PostToolUseFailure: [{ hooks: [{ type: "command", command: "gone.sh" }] }],
		});
		const written = writtenSettings(planned).hooks as Record<string, unknown>;
		expect(Object.keys(written)).toEqual(["PreToolUse"]);
		const item = plannedItem(planned, "→ hooks");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("PostToolUseFailure");
		expect(item?.detail).toContain("no hook here");
	});

	test("a handler that is not a shell command is dropped, keeping the ones that are", () => {
		const planned = planHooks({
			Stop: [
				{
					hooks: [
						{ type: "prompt", prompt: "did you finish?" },
						{ type: "command", command: "done.sh" },
					],
				},
			],
		});
		expect(writtenSettings(planned).hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "done.sh" }] }] });
		expect(plannedItem(planned, "→ hooks")?.detail).toContain("not shell commands");
	});

	test("A|B is one matcher per name, because it is not an alternation here", () => {
		const planned = planHooks({
			PostToolUse: [{ matcher: "Bash|Edit", hooks: [{ type: "command", command: "after.sh" }] }],
		});
		expect(writtenSettings(planned).hooks).toEqual({
			PostToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: "after.sh" }] },
				{ matcher: "Edit", hooks: [{ type: "command", command: "after.sh" }] },
			],
		});
		const detail = plannedItem(planned, "→ hooks")?.detail ?? "";
		expect(detail).toContain("Bash|Edit");
		expect(detail).toContain("one entry per name");
	});

	test("a matcher written as a regular expression is dropped with the reason", () => {
		const planned = planHooks({
			PreToolUse: [{ matcher: "mcp__.*__delete.*", hooks: [{ type: "command", command: "guard.sh" }] }],
		});
		expect(writtenSettings(planned).hooks).toBeUndefined();
		const skipped = plannedItem(planned, "→ hooks");
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("escapes");
	});

	test("hooks the target already defines are kept", () => {
		const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine.sh" }] }] } };
		const planned = planHooks({ Stop: [{ hooks: [{ type: "command", command: "theirs.sh" }] }] }, existing);
		const item = plannedItem(planned, "→ hooks");
		expect(item?.action).toBe("skip");
		expect(item?.detail).toContain("--force");
		// Nothing is written at all, so the file on disk keeps its own hooks.
		expect(planned.writes.some((w) => w.kind === "settings")).toBe(false);
	});

	test("a hook file with nothing runnable says so instead of writing an empty block", () => {
		const planned = planHooks({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "think" }] }] });
		expect(planned.writes.some((w) => w.kind === "settings")).toBe(false);
		expect(plannedItem(planned, "→ hooks")?.detail).toContain("nothing here would run");
	});
});

describe("keys with no mapping", () => {
	test("are named once per file, and their values never printed", () => {
		let planned: MigrationPlan | undefined;
		withHome(
			{
				".claude/settings.json": JSON.stringify({
					modelSettings: { value: "SHOULD-NOT-APPEAR" },
					skipWorkflowUsageWarning: true,
					somethingElse: 3,
				}),
				".claude.json": JSON.stringify({ oauthAccount: { emailAddress: "NOT-THIS-EITHER" }, model: "opus" }),
			},
			(home) => {
				planned = planMigration(readSources(home), {}, { only: ["claude-code"] });
			},
		);
		if (!planned) throw new Error("the fake home did not survive");
		const settingsItem = planned.items.find((i) => i.from.includes("modelSettings"));
		expect(settingsItem?.action).toBe("skip");
		expect(settingsItem?.detail).toContain("3 key(s)");
		// A key that is accounted for is not part of the leftover list.
		expect(settingsItem?.from).not.toContain("effortLevel");
		expect(planned.items.find((i) => i.from.includes("oauthAccount"))?.action).toBe("skip");
		// Names, not contents: the report is read by a model and pasted into issues.
		const report = formatMigrationReport(planned);
		expect(report).not.toContain("SHOULD-NOT-APPEAR");
		expect(report).not.toContain("NOT-THIS-EITHER");
	});

	test("a file with nothing left over says nothing", () => {
		const planned = planPermissions({ allow: ["Bash(git *)"] });
		expect(planned.items.some((i) => i.from.includes("key(s)") || i.detail.includes("no mapping"))).toBe(false);
	});
});

describe("fallbackModel", () => {
	test("resolves like the primary model", () => {
		let planned: MigrationPlan | undefined;
		withHome({ ".claude/settings.json": JSON.stringify({ fallbackModel: "sonnet" }) }, (home) => {
			planned = planMigration(readSources(home), {}, { only: ["claude-code"] });
		});
		if (!planned) throw new Error("the fake home did not survive");
		expect(writtenSettings(planned).fallbackModels).toEqual(["anthropic/claude-sonnet-5"]);
	});

	test("an unresolvable fallback is reported, not written as a broken reference", () => {
		let planned: MigrationPlan | undefined;
		withHome({ ".claude/settings.json": JSON.stringify({ fallbackModel: "gpt-9-ultra" }) }, (home) => {
			planned = planMigration(readSources(home), {}, { only: ["claude-code"] });
		});
		if (!planned) throw new Error("the fake home did not survive");
		expect(writtenSettings(planned).fallbackModels).toBeUndefined();
		expect(plannedItem(planned, "fallbackModel")?.action).toBe("skip");
	});
});

describe("a skill's supporting files", () => {
	const SKILL_TREE: SourceTree = {
		".claude/skills/unity/SKILL.md": "---\nname: unity\n---\nRead references/api.md first.\n",
		".claude/skills/unity/references/api.md": "# API\n\nCall it like this.\n",
		".claude/skills/unity/scripts/run.sh": "#!/bin/sh\necho hi\n",
		".claude/skills/unity/assets/logo.png": "\u0000\u0001binary-ish",
		".claude/skills/unity/node_modules/dep/index.js": "module.exports = 1;\n",
	};

	test("come along, so the links in the body still point at something", () => {
		withHome(SKILL_TREE, (home) => {
			runMigration({ home, from: "claude-code", apply: true });
			const skillDir = join(home, ".labunbun", "skills", "unity");
			expect(readFileSync(join(skillDir, "references", "api.md"), "utf8")).toBe("# API\n\nCall it like this.\n");
			expect(readFileSync(join(skillDir, "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
		});
	});

	test("a binary or an installed dependency is reported, not written as text", () => {
		withHome(SKILL_TREE, (home) => {
			const result = runMigration({ home, from: "claude-code", apply: true });
			const skillDir = join(home, ".labunbun", "skills", "unity");
			expect(existsSync(join(skillDir, "assets", "logo.png"))).toBe(false);
			expect(existsSync(join(skillDir, "node_modules"))).toBe(false);

			const item = result.plan.items.find((i) => i.from.includes("skills/unity/SKILL.md") && i.to.includes("SKILL.md"));
			expect(item?.detail).toContain("2 supporting file(s)");
			const skipped = result.plan.items.find((i) => i.detail.includes("supporting file(s) not copied"));
			expect(skipped?.detail).toContain("logo.png (binary file)");
			expect(skipped?.detail).toContain("node_modules");
		});
	});

	test("a supporting file the user already edited is kept", () => {
		withHome(
			{
				...SKILL_TREE,
				".labunbun/skills/unity/references/api.md": "edited by hand\n",
			},
			(home) => {
				const result = runMigration({ home, from: "claude-code", apply: true });
				expect(readFileSync(join(home, ".labunbun", "skills", "unity", "references", "api.md"), "utf8")).toBe(
					"edited by hand\n",
				);
				const skip = result.plan.items.find((i) => i.detail.includes("supporting skill file already exists"));
				expect(skip?.action).toBe("skip");
			},
		);
	});

	test("a skill with nothing beside it is still one file", () => {
		withHome({ ".claude/skills/plain/SKILL.md": "---\nname: plain\n---\nNothing else.\n" }, (home) => {
			const result = runMigration({ home, from: "claude-code", apply: true });
			expect(result.plan.writes.filter((w) => w.kind === "skill").length).toBe(1);
			const item = result.plan.items.find((i) => i.from.includes("skills/plain"));
			expect(item?.detail).toBe("skill copied verbatim");
		});
	});
});

/** `${VAR}` built in pieces so a linter does not read it as a lost interpolation. */
function placeholder(name: string): string {
	return `\${${name}}`;
}

describe("MCP values that hold a variable placeholder", () => {
	test("are copied but flagged, because nothing here expands them", () => {
		let withPlaceholder: MigrationPlan | undefined;
		withHome(
			{
				".claude/settings.json": "{}",
				".claude.json": JSON.stringify({
					mcpServers: {
						hosted: {
							type: "http",
							url: "https://mcp.example/api",
							headers: { Authorization: `Bearer ${placeholder("API_TOKEN")}` },
						},
					},
				}),
			},
			(home) => {
				withPlaceholder = planMigration(readSources(home), {}, { only: ["claude-code"] });
			},
		);
		if (!withPlaceholder) throw new Error("the fake home did not survive");
		const item = plannedItem(withPlaceholder, "mcpServers.hosted");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain(placeholder("API_TOKEN"));
		expect(item?.detail).toContain("not expanded");
		// The name is named; the value it would have come from is not invented.
		const servers = JSON.parse(withPlaceholder.writes.find((w) => w.kind === "mcp")?.content ?? "{}").mcpServers;
		expect(servers.hosted.headers.Authorization).toBe(`Bearer ${placeholder("API_TOKEN")}`);
	});

	test("a server without one is a plain copy", () => {
		let planned: MigrationPlan | undefined;
		withHome(
			{
				".claude/settings.json": "{}",
				".claude.json": JSON.stringify({ mcpServers: { plain: { type: "stdio", command: "node", args: ["x.js"] } } }),
			},
			(home) => {
				planned = planMigration(readSources(home), {}, { only: ["claude-code"] });
			},
		);
		if (!planned) throw new Error("the fake home did not survive");
		expect(plannedItem(planned, "mcpServers.plain")?.action).toBe("map");
	});
});
