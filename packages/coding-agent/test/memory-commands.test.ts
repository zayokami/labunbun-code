import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { builtInCommands, completeCommands, findCommand } from "../src/commands.ts";
import { expandIncludes, loadMemoryFiles } from "../src/memory.ts";

describe("expandIncludes", () => {
	test("expands @path references recursively", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mem-"));
		writeFileSync(join(dir, "main.md"), "# Main\n@sub.md\nend\n");
		writeFileSync(join(dir, "sub.md"), "SUB CONTENT\n@nested.md");
		writeFileSync(join(dir, "nested.md"), "NESTED");

		const expanded = expandIncludes("# Main\n@sub.md\nend\n", dir);
		expect(expanded).toContain("SUB CONTENT");
		expect(expanded).toContain("NESTED");
	});

	test("missing and circular includes degrade gracefully", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mem2-"));
		writeFileSync(join(dir, "a.md"), "@b.md\n@missing.md");
		const expanded = expandIncludes("@b.md\n@missing.md", dir);
		expect(expanded).toContain("include not found: @missing.md".replace("@", ""));
	});

	test("circular include is detected", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mem3-"));
		writeFileSync(join(dir, "x.md"), "@x.md");
		const expanded = expandIncludes("@x.md", dir);
		expect(expanded).toContain("circular include");
	});

	test("traversal outside the root directory is rejected", () => {
		const root = mkdtempSync(join(tmpdir(), "lbb-mem-root-"));
		const secretDir = mkdtempSync(join(tmpdir(), "lbb-mem-secret-"));
		writeFileSync(join(secretDir, "secret.md"), "TOP SECRET");
		const project = join(root, "project");
		mkdirSync(project, { recursive: true });

		const relativePath = relative(project, join(secretDir, "secret.md"));
		const expanded = expandIncludes(`@${relativePath.replace(/\\/g, "/")}`, project);
		expect(expanded).toContain("include outside allowed directory");
		expect(expanded).not.toContain("TOP SECRET");
	});

	test("UNC-style include paths are rejected", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mem-unc-"));
		const expanded = expandIncludes("@\\\\evil-host\\share\\file.md", dir);
		expect(expanded).toContain("include outside allowed directory");
	});

	test("includes within nested subdirectories of the root still resolve", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mem-nested-"));
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "sub", "inner.md"), "INNER CONTENT");
		const expanded = expandIncludes("@sub/inner.md", dir);
		expect(expanded).toContain("INNER CONTENT");
	});
});

describe("loadMemoryFiles", () => {
	test("nearest LABUNBUN.md wins per level; rules dir included", () => {
		const root = mkdtempSync(join(tmpdir(), "lbb-memroot-"));
		const project = join(root, "project");
		const sub = join(project, "sub");
		mkdirSync(sub, { recursive: true });
		mkdirSync(join(project, ".labunbun", "rules"), { recursive: true });

		writeFileSync(join(root, "AGENTS.md"), "ROOT LEVEL");
		writeFileSync(join(project, "LABUNBUN.md"), "PROJECT LEVEL");
		writeFileSync(join(project, ".labunbun", "rules", "style.md"), "STYLE RULE");
		writeFileSync(join(sub, "child.txt"), "not memory");

		const result = loadMemoryFiles(sub, join(root, "fakehome"));
		const combined = result.files.join("|");
		expect(combined).toContain("AGENTS.md"); // root level
		expect(combined).toContain("LABUNBUN.md"); // project level (nearest)
		expect(combined).toContain("style.md");
		expect(result.content).toContain("ROOT LEVEL");
		expect(result.content).toContain("PROJECT LEVEL");
		expect(result.content).toContain("STYLE RULE");
	});

	/**
	 * User-scope rules live at `~/.labunbun/rules`, which the cwd→root walk only
	 * reaches when cwd happens to sit under the home directory. They get their own
	 * read so they apply from any working directory — this is what makes imported
	 * rule files take effect.
	 */
	test("user-scope rules load from any working directory", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-memhome-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-memcwd-"));
		mkdirSync(join(home, ".labunbun", "rules"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "rules", "global.md"), "GLOBAL RULE");

		const result = loadMemoryFiles(cwd, home);
		expect(result.content).toContain("GLOBAL RULE");
		expect(result.files.join("|")).toContain("global.md");
	});

	test("a user-scope rule is not counted twice when cwd sits under home", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-memdup-"));
		const cwd = join(home, "project");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(home, ".labunbun", "rules"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "rules", "once.md"), "ONCE ONLY");

		const result = loadMemoryFiles(cwd, home);
		expect(result.files.filter((p) => p.endsWith("once.md"))).toHaveLength(1);
		expect(result.content.split("ONCE ONLY")).toHaveLength(2);
	});

	test("empty when no memory files exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-memempty-"));
		const result = loadMemoryFiles(dir, join(dir, "home"));
		expect(result.content).toBe("");
		expect(result.files).toHaveLength(0);
	});

	test("oversized memory is truncated at the 40k cap with a notice", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-memcap-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-memcap2-"));
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "MEMORY.md"), "x".repeat(60_000));

		const result = loadMemoryFiles(cwd, home);
		expect(result.truncated).toBe(true);
		expect(result.content.length).toBeLessThanOrEqual(40_000 + 100); // cap + notice line
		expect(result.content).toContain("[memory files truncated");
	});
});

describe("command registry", () => {
	const commands = builtInCommands();

	test("find by name and alias, case-insensitive", () => {
		expect(findCommand(commands, "/compact")?.name).toBe("compact");
		expect(findCommand(commands, "COMPACT")?.name).toBe("compact");
		expect(findCommand(commands, "/nope")).toBeUndefined();
	});

	test("autocomplete prefix and fuzzy matching", () => {
		const names = completeCommands(commands, "co").map((c) => c.name);
		expect(names).toContain("compact");
		const all = completeCommands(commands, "");
		expect(all.length).toBe(commands.length);
	});

	test("prompt commands produce expansion text", () => {
		const explain = findCommand(commands, "explain");
		expect(explain?.type).toBe("prompt");
		if (explain?.type === "prompt") {
			expect(explain.getPrompt("src/index.ts")).toContain("src/index.ts");
		}
	});
});
