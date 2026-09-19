/**
 * What the Codex execpolicy importer carries, and what it refuses to guess at.
 *
 * A `.rules` file is Starlark, so the reader finds the calls it can follow and
 * counts the rest. The fixtures use shapes the Codex parser accepts: a
 * multi-line `prefix_rule` with a list pattern and a string decision, the
 * `match`/`not_match` examples that usually travel with one, and comments.
 *
 * The translation is deliberately lossy in one direction only: a rule is either
 * carried as the same decision it had (allow → allow, forbidden → deny) or
 * reported. Nothing here may turn a "prompt" into an allow, and nothing may
 * widen a pattern into one that matches more commands than the source did.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MigrationItem, type MigrationPlan, planMigration, readSources, runMigration } from "../src/migrate.ts";
import type { RawSettingsInput } from "../src/settings.ts";

type SourceTree = Record<string, string>;

function withHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-rules-"));
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

/** A codex home whose only interesting file is the execpolicy rules. */
function rulesTree(content: string): SourceTree {
	return { ".codex/config.toml": 'model = "gpt-5-codex"\n', ".codex/rules/default.rules": content };
}

function plan(rules: string, existing: RawSettingsInput = {}): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome(rulesTree(rules), (home) => {
		planned = planMigration(readSources(home), existing, { only: ["codex"] });
	});
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/** The permissions block the plan would write. */
function writtenPermissions(planned: MigrationPlan): Record<string, string[]> {
	const write = planned.writes.find((w) => w.kind === "settings");
	const settings = JSON.parse(write?.content ?? "{}") as { permissions?: Record<string, string[]> };
	return settings.permissions ?? { allow: [], deny: [], additionalDirectories: [] };
}

function item(planned: MigrationPlan, from: string): MigrationItem | undefined {
	return planned.items.find((i) => i.from.includes(from));
}

function ruleItem(planned: MigrationPlan): MigrationItem | undefined {
	return item(planned, "default.rules");
}

describe("codex prefix rules", () => {
	test("an allow rule becomes a command rule, with the difference stated", () => {
		const planned = plan(
			[
				"# rules the user wrote by hand",
				"prefix_rule(",
				'    pattern = ["git", "status"],',
				'    decision = "allow",',
				")",
			].join("\n"),
		);
		expect(writtenPermissions(planned).allow).toEqual(["Bash(git status*)"]);
		const detail = ruleItem(planned)?.detail ?? "";
		// An allow rule here is the whole gate, unlike Codex's sandboxed one.
		expect(detail).toContain("without a prompt");
		expect(detail).toContain("command line");
	});

	test("forbidden is a deny rule, and the older `deny` spelling too", () => {
		const planned = plan(
			[
				'prefix_rule(pattern = ["rm", "-rf"], decision = "forbidden")',
				'prefix_rule(pattern = ["git", "push", "--force"], decision = "deny")',
			].join("\n"),
		);
		expect(writtenPermissions(planned).deny).toEqual(["Bash(rm -rf*)", "Bash(git push --force*)"]);
		expect(ruleItem(planned)?.action).toBe("map");
	});

	test("a prompt rule is not carried: there is no ask tier to carry it to", () => {
		const planned = plan('prefix_rule(pattern = ["curl"], decision = "prompt")');
		expect(writtenPermissions(planned).allow).toEqual([]);
		const detail = ruleItem(planned)?.detail ?? "";
		expect(detail).toContain("Bash(curl*)");
		expect(detail).toContain("prompt");
	});

	test("a rule with no decision is left alone, because silence is not consent", () => {
		// Codex reads a missing decision as allow; that default is exactly the kind
		// of thing an importer should not carry over on the user's behalf.
		const planned = plan('prefix_rule(pattern = ["ls"])');
		expect(writtenPermissions(planned).allow).toEqual([]);
		expect(ruleItem(planned)?.detail).toContain("no decision");
	});

	test("a rule the target cannot express is skipped rather than widened", () => {
		const planned = plan(
			[
				'prefix_rule(pattern = ["git*"], decision = "allow")',
				'prefix_rule(pattern = ["pwsh", "-Command", "Get-Item(foo)"], decision = "allow")',
			].join("\n"),
		);
		expect(writtenPermissions(planned).allow).toEqual([]);
		const detail = ruleItem(planned)?.detail ?? "";
		expect(detail).toContain("2 rule(s) not carried");
		expect(detail).toContain("means something else");
	});

	// A pattern is whatever the user typed on that line; the report ends up in a
	// transcript, so only the head of a long token is quoted back.
	test("a refused pattern is quoted back truncated, not whole", () => {
		const long = `${"x".repeat(200)}(y)`;
		const planned = plan(`prefix_rule(pattern = ["pwsh", "-Command", "${long}"], decision = "allow")`);
		const detail = ruleItem(planned)?.detail ?? "";
		expect(detail).toContain("means something else");
		expect(detail).not.toContain(long);
		expect(detail).toContain(`${"x".repeat(80)}…`);
	});

	test("other rule kinds are named, not translated", () => {
		const planned = plan(
			[
				'network_rule(host = "example.com", protocol = "https", decision = "allow")',
				'host_executable(name = "git", paths = ["/usr/bin/git"])',
			].join("\n"),
		);
		expect(writtenPermissions(planned).allow).toEqual([]);
		const detail = ruleItem(planned)?.detail ?? "";
		expect(detail).toContain("network_rule");
		expect(detail).toContain("host_executable");
	});

	test("examples and comments around a rule do not confuse the reader", () => {
		const planned = plan(
			[
				"# Example: allow reading a package list.",
				"prefix_rule(",
				'    pattern = ["npm", "ls"],',
				'    decision = "allow",',
				'    justification = "read-only",',
				'    match = [["npm", "ls", "--json"]],',
				'    not_match = [["npm", "install"]],',
				")  # trailing comment",
			].join("\n"),
		);
		expect(writtenPermissions(planned).allow).toEqual(["Bash(npm ls*)"]);
		expect(ruleItem(planned)?.action).toBe("map");
	});

	test("a call the reader cannot follow is counted, not silently dropped", () => {
		const planned = plan('prefix_rule(pattern = ["git", "log"], decision = "allow"\n');
		expect(ruleItem(planned)?.detail).toContain("could not follow");
	});

	test("nothing in the file means nothing in the report", () => {
		const planned = plan("# every rule in here is commented out\n");
		expect(planned.items.some((i) => i.from.includes("default.rules"))).toBe(false);
	});
});

describe("codex rules meet the target's own rules", () => {
	test("they are added to what is there, never in place of it", () => {
		const existing: RawSettingsInput = {
			permissions: { allow: ["Bash(ls)"], deny: ["Read(**/.env)"], additionalDirectories: [] },
		};
		const planned = plan('prefix_rule(pattern = ["git", "status"], decision = "allow")', existing);
		expect(writtenPermissions(planned).allow).toEqual(["Bash(ls)", "Bash(git status*)"]);
		expect(writtenPermissions(planned).deny).toEqual(["Read(**/.env)"]);
	});

	test("a rule the target already has is counted, not written twice", () => {
		const existing: RawSettingsInput = {
			permissions: { allow: ["Bash(git status*)"], deny: [], additionalDirectories: [] },
		};
		const planned = plan('prefix_rule(pattern = ["git", "status"], decision = "allow")', existing);
		const skip = planned.items.find((i) => i.detail.includes("already defined here"));
		expect(skip?.action).toBe("skip");
		// Nothing to add means nothing to write: the file keeps the rule it has.
		expect(planned.writes.some((w) => w.kind === "settings")).toBe(false);
	});

	test("the same rule twice in one file lands once", () => {
		const planned = plan(
			[
				'prefix_rule(pattern = ["git", "status"], decision = "allow")',
				'prefix_rule(pattern = ["git", "status"], decision = "allow")',
			].join("\n"),
		);
		expect(writtenPermissions(planned).allow).toEqual(["Bash(git status*)"]);
	});

	test("two files both contribute", () => {
		let planned: MigrationPlan | undefined;
		withHome(
			{
				".codex/config.toml": 'model = "gpt-5-codex"\n',
				".codex/rules/default.rules": 'prefix_rule(pattern = ["git", "status"], decision = "allow")',
				".codex/rules/extra.rules": 'prefix_rule(pattern = ["cargo", "test"], decision = "allow")',
			},
			(home) => {
				planned = planMigration(readSources(home), {}, { only: ["codex"] });
			},
		);
		if (!planned) throw new Error("the fake home did not survive");
		expect(writtenPermissions(planned).allow).toEqual(["Bash(git status*)", "Bash(cargo test*)"]);
		expect(item(planned, "rules/extra.rules")?.action).toBe("map");
	});

	test("an applied run leaves the rules file byte for byte as it was", () => {
		const content = '# mine\nprefix_rule(pattern = ["git", "status"], decision = "allow")\n';
		withHome(rulesTree(content), (home) => {
			runMigration({ home, from: "codex", apply: true });
			expect(readFileSync(join(home, ".codex", "rules", "default.rules"), "utf8")).toBe(content);
		});
	});
});
