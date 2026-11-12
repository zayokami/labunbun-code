/**
 * Path-scoped rules: the frontmatter reader, the glob match, and the injector
 * that attaches a rule to the first tool result about a file it governs.
 *
 * The end-to-end half — that the rule is absent from the prompt and present in
 * the request after the read — lives next door in `path-rules-e2e.test.ts`,
 * because that is a child-process run of the whole app.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolResultMessage } from "@labunbun/ai";
import { loadMemoryFiles, loadPathRules } from "../src/memory.ts";
import { approveProjectDefinitions } from "../src/project-trust.ts";
import { createPathRuleInjector, parseRulePaths, ruleMatches } from "../src/rule-paths.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function writeRule(dir: string, name: string, content: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, content, "utf8");
	return path;
}

const result = () => toolResultMessage("call-1", "Read", [{ type: "text", text: "file contents" }]);

describe("parseRulePaths", () => {
	test("reads a YAML list", () => {
		const parsed = parseRulePaths("---\npaths:\n  - src/api/**/*.ts\n  - docs/**\n---\nBODY\n");
		expect(parsed.patterns).toEqual(["src/api/**/*.ts", "docs/**"]);
		expect(parsed.body).toBe("BODY\n");
	});

	test("reads an inline scalar, an inline list, and quoted entries", () => {
		expect(parseRulePaths("---\npaths: src/api/**\n---\nBODY").patterns).toEqual(["src/api/**"]);
		expect(parseRulePaths("---\npaths: [\"a/*.ts\", 'b/*.md']\n---\nBODY").patterns).toEqual(["a/*.ts", "b/*.md"]);
		expect(parseRulePaths('---\npaths: "src/**"\n---\nBODY').patterns).toEqual(["src/**"]);
	});

	test("stops the list at the first non-item line", () => {
		const parsed = parseRulePaths("---\npaths:\n  - a/**\nother: key\n  - not-a-path\n---\nBODY");
		expect(parsed.patterns).toEqual(["a/**"]);
	});

	test("a file without paths is an ordinary rule, body unchanged", () => {
		const plain = "---\ndescription: x\n---\nBODY";
		expect(parseRulePaths(plain)).toEqual({ patterns: [], body: plain });
		expect(parseRulePaths("BODY")).toEqual({ patterns: [], body: "BODY" });
	});

	test("a frontmatter block with no paths is left in the body", () => {
		// Nothing scopes it, so it is a startup rule and its text is the file.
		const content = "---\ndescription: x\n---\nBODY";
		expect(parseRulePaths(content).body).toBe(content);
	});
});

describe("ruleMatches", () => {
	test("matches relative paths with forward slashes", () => {
		expect(ruleMatches("src/**/*.ts", "src/app.ts")).toBe(true);
		expect(ruleMatches("src/**/*.ts", "src/api/handler.ts")).toBe(true);
		expect(ruleMatches("src/**/*.ts", "test/app.ts")).toBe(false);
		expect(ruleMatches("src/api/**", "src/api/handler.ts")).toBe(true);
		expect(ruleMatches("*.md", "README.md")).toBe(true);
		expect(ruleMatches("*.md", "docs/README.md")).toBe(false);
	});

	test("a trailing slash means the whole tree", () => {
		expect(ruleMatches("src/api/", "src/api/handler.ts")).toBe(true);
		expect(ruleMatches("src/api/", "src/api/deep/nested/file.ts")).toBe(true);
	});

	test("an absolute-looking or backslashed pattern is normalized", () => {
		expect(ruleMatches("./src/**", "src/app.ts")).toBe(true);
		expect(ruleMatches("src\\api\\**", "src/api/handler.ts")).toBe(true);
	});
});

describe("createPathRuleInjector", () => {
	function setup() {
		const cwd = tempDir("lbb-path-inject-");
		const ruleFile = join(cwd, ".labunbun", "rules", "api.md");
		const rules = [{ file: ruleFile, patterns: ["src/api/**"], body: "RULE: use the envelope" }];
		return { cwd, rules };
	}

	test("attaches a matching rule once, with its header", () => {
		const { cwd, rules } = setup();
		const injector = createPathRuleInjector({ cwd, rules });

		const applied = injector.apply("Read", { file_path: "src/api/handler.ts" }, result());
		expect(applied).toBeDefined();
		const text = applied?.content.at(-1);
		expect(text?.type).toBe("text");
		const block = text?.type === "text" ? text.text : "";
		expect(block).toContain("RULE: use the envelope");
		expect(block).toContain("[path rule — .labunbun/rules/api.md (src/api/**)]");
		expect(block).toContain("[end of path rule]");
		// The original content survives in front of it.
		expect(applied?.content[0]).toEqual({ type: "text", text: "file contents" });

		// A second matching call has nothing new to say.
		expect(injector.apply("Edit", { file_path: "src/api/handler.ts" }, result())).toBeUndefined();
		// Reset makes the next matching call carry it again.
		injector.reset();
		expect(injector.apply("Read", { file_path: "src/api/handler.ts" }, result())).toBeDefined();
	});

	test("leaves a non-matching file, a wildcard tool, and a path outside the workspace alone", () => {
		const { cwd, rules } = setup();
		const injector = createPathRuleInjector({ cwd, rules });

		expect(injector.apply("Read", { file_path: "src/other.ts" }, result())).toBeUndefined();
		expect(injector.apply("Glob", { pattern: "src/api/**" }, result())).toBeUndefined();
		expect(injector.apply("Read", { file_path: "../outside.ts" }, result())).toBeUndefined();
		// None of those attached it, so the matching read still gets it.
		expect(injector.apply("Read", { file_path: join(cwd, "src", "api", "x.ts") }, result())).toBeDefined();
	});

	test("names a rule under the user's home with a tilde", () => {
		const cwd = tempDir("lbb-path-home-cwd-");
		const home = tempDir("lbb-path-home-");
		const ruleFile = writeRule(join(home, ".labunbun", "rules"), "own.md", "---\npaths: src/**\n---\nRULE\n");
		const injector = createPathRuleInjector({
			cwd,
			home,
			rules: [{ file: ruleFile, patterns: ["src/**"], body: "RULE" }],
		});
		const text = injector.apply("Read", { file_path: "src/app.ts" }, result())?.content.at(-1);
		expect(text?.type === "text" ? text.text : "").toContain("~/.labunbun/rules/own.md");
	});
});

describe("the startup memory and the scoped rules", () => {
	test("a rule with paths loads only when a file matches, in both tiers", () => {
		const cwd = tempDir("lbb-path-memory-cwd-");
		const home = tempDir("lbb-path-memory-home-");
		const projectRules = join(cwd, ".labunbun", "rules");
		writeRule(projectRules, "plain.md", "PLAIN PROJECT RULE\n");
		writeRule(projectRules, "scoped.md", "---\npaths:\n  - src/api/**\n---\nSCOPED PROJECT RULE\n");
		writeRule(join(home, ".labunbun", "rules"), "scoped.md", "---\npaths: docs/**\n---\nSCOPED USER RULE\n");
		approveProjectDefinitions(cwd, ["memory"], home);

		const memory = loadMemoryFiles(cwd, home);
		expect(memory.content).toContain("PLAIN PROJECT RULE");
		expect(memory.content).not.toContain("SCOPED PROJECT RULE");
		expect(memory.content).not.toContain("SCOPED USER RULE");

		const rules = loadPathRules(cwd, home);
		expect(rules).toHaveLength(2);
		expect(rules.map((rule) => rule.body).sort()).toEqual(["SCOPED PROJECT RULE", "SCOPED USER RULE"]);
		expect(rules.every((rule) => rule.patterns.length === 1)).toBe(true);
	});

	test("the project tier stays behind the trust gate", () => {
		const cwd = tempDir("lbb-path-untrusted-cwd-");
		const home = tempDir("lbb-path-untrusted-home-");
		writeRule(join(cwd, ".labunbun", "rules"), "scoped.md", "---\npaths: src/**\n---\nUNTRUSTED RULE\n");

		expect(loadPathRules(cwd, home)).toEqual([]);
	});
});
