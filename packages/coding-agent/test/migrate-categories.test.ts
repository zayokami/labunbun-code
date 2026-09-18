import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MigrationCategory } from "../src/migrate.ts";
import {
	categoryOfKind,
	DEFAULT_HISTORY_LIMIT,
	MIGRATION_CATEGORIES,
	parseHistoryLimit,
	parseOnlyOption,
	runMigration,
} from "../src/migrate.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

function withHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-categories-"));
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

/** A Claude Code tree that touches all three categories. */
const FULL_TREE: SourceTree = {
	".claude/settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example/v1" }, model: "opus" }),
	".claude.json": JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://mcp.example/docs" } } }),
	".claude/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n",
	".claude/rules/style.md": "be terse\n",
	".claude/agents/reviewer.md": "---\nname: reviewer\ndescription: reviews\n---\nreview coldly\n",
};

/** Which categories a plan's writes touch. */
function categoriesWritten(result: ReturnType<typeof runMigration>): Set<MigrationCategory> {
	return new Set(result.plan.writes.map((w) => categoryOfKind(w.kind)));
}

describe("migrate: categories", () => {
	test("every writable kind belongs to exactly one category", () => {
		expect(categoryOfKind("settings")).toBe("settings");
		expect(categoryOfKind("mcp")).toBe("settings");
		expect(categoryOfKind("skill")).toBe("assets");
		expect(categoryOfKind("rule")).toBe("assets");
		expect(categoryOfKind("memory")).toBe("assets");
		expect(categoryOfKind("agent")).toBe("assets");
		expect(categoryOfKind("history")).toBe("history");
	});

	test("parseOnlyOption accepts a list, all, and the empty value", () => {
		expect(parseOnlyOption(undefined)).toEqual(MIGRATION_CATEGORIES);
		expect(parseOnlyOption("")).toEqual(MIGRATION_CATEGORIES);
		expect(parseOnlyOption("all")).toEqual(MIGRATION_CATEGORIES);
		expect(parseOnlyOption("settings")).toEqual(["settings"]);
		expect(parseOnlyOption("assets,history")).toEqual(["assets", "history"]);
		expect(parseOnlyOption(" settings , history ")).toEqual(["settings", "history"]);
		// The wizard hands over a list it already resolved.
		expect(parseOnlyOption(["history"] as MigrationCategory[])).toEqual(["history"]);
	});

	test("parseOnlyOption rejects a name it does not know", () => {
		const parsed = parseOnlyOption("settings,plugins");
		expect("error" in parsed && parsed.error).toContain("Unknown category: plugins");
		expect("error" in parsed && parsed.error).toContain("settings, assets, history");
	});

	test("parseHistoryLimit accepts whole numbers, including zero", () => {
		expect(parseHistoryLimit(undefined)).toBe(DEFAULT_HISTORY_LIMIT);
		expect(parseHistoryLimit("5")).toBe(5);
		expect(parseHistoryLimit("0")).toBe(0);
		expect(parseHistoryLimit(3)).toBe(3);
	});

	test("parseHistoryLimit rejects anything that is not a count", () => {
		for (const bad of ["abc", "-1", "1.5", "2x"]) {
			const parsed = parseHistoryLimit(bad);
			expect(typeof parsed === "number").toBe(false);
		}
	});

	test("--only settings writes settings and says what it left out", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home, only: "settings" });
			expect(result.plan.categories).toEqual(["settings"]);
			expect(categoriesWritten(result)).toEqual(new Set(["settings"]));
			expect(result.plan.writes.every((w) => w.path.endsWith("settings.json") || w.path.endsWith(".mcp.json"))).toBe(
				true,
			);

			// One notice per excluded category, not one per skipped file.
			const notices = result.plan.items.filter((i) => i.detail.includes("excluded by the category filter"));
			expect(notices.map((n) => n.from)).toEqual(["every source → assets", "every source → history"]);
			expect(notices.every((n) => n.action === "skip" && n.source === "claude-code")).toBe(true);
			// Assets were not even collected, so nothing about them appears.
			expect(result.plan.items.some((i) => i.from.includes("SKILL.md"))).toBe(false);
		});
	});

	test("--only assets writes files and leaves settings alone", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home, only: ["assets"] });
			expect(result.plan.categories).toEqual(["assets"]);
			expect(categoriesWritten(result)).toEqual(new Set(["assets"]));
			expect(result.plan.writes.some((w) => w.path.endsWith("settings.json"))).toBe(false);
			expect(result.plan.writes.some((w) => w.path.endsWith(".mcp.json"))).toBe(false);
			// No env var from the excluded settings category leaks in.
			expect(result.plan.items.some((i) => i.to.includes("env."))).toBe(false);
		});
	});

	test("an unknown category fails the run without planning any write", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home, only: "nope" });
			expect(result.error).toContain("Unknown category");
			expect(result.plan.writes).toEqual([]);
			expect(result.plan.items).toEqual([]);
			expect(result.report).toBe(result.error ?? "");
		});
	});

	test("an invalid history limit fails the run without planning any write", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home, historyLimit: "abc" });
			expect(result.error).toContain("Invalid history limit");
			expect(result.plan.writes).toEqual([]);
		});
	});

	test("an unknown source still fails before the category filter is consulted", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home, from: "nope", only: "nope" });
			expect(result.error).toContain("Unknown migration source");
		});
	});

	test("without a filter nothing is reported as excluded", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home });
			expect(result.plan.categories).toEqual(MIGRATION_CATEGORIES);
			expect(result.plan.items.some((i) => i.detail.includes("excluded by the category filter"))).toBe(false);
		});
	});

	test("the unfiltered plan for an existing claude-code tree is unchanged", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home, apply: true });
			const written = result.applied?.written
				.map((path) => path.replace(/\\/g, "/").replace(home.replace(/\\/g, "/"), "~"))
				.sort();
			expect(written).toEqual([
				"~/.labunbun/.mcp.json",
				"~/.labunbun/agents/reviewer.md",
				"~/.labunbun/rules/style.md",
				"~/.labunbun/settings.json",
				"~/.labunbun/skills/pdf/SKILL.md",
			]);
			// Adding categories changed the plumbing, not the outcome.
			expect(result.plan.sources).toEqual(["claude-code"]);
		});
	});
});
