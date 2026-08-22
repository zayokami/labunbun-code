import { describe, expect, test } from "bun:test";
import {
	evaluatePermissions,
	inputMatchesSpecifier,
	normalizePathSpec,
	type PermissionRule,
	parseRuleList,
	parseRuleText,
	specifierToRegExp,
} from "../src/permissions.ts";

const CWD = "G:\\work\\proj";

describe("parseRuleText", () => {
	test("bare tool and specifier forms", () => {
		expect(parseRuleText("Bash")).toEqual({ toolName: "Bash" });
		expect(parseRuleText("Bash(git *)")).toEqual({ toolName: "Bash", specifier: "git *" });
		expect(parseRuleText("mcp__github__*")).toEqual({ toolName: "mcp__github__*" });
		expect(parseRuleText("Tool(unterminated")).toBeNull();
		expect(parseRuleText("")).toBeNull();
	});
});

describe("specifierToRegExp", () => {
	test("** crosses segments, * stays within", () => {
		const re = specifierToRegExp("src/**");
		expect(re.test("src/a/b.ts")).toBe(true);
		expect(re.test("src/a.ts")).toBe(true);
		expect(re.test("lib/a.ts")).toBe(false);

		const single = specifierToRegExp("*.ts");
		expect(single.test("a.ts")).toBe(true);
		expect(single.test("dir/a.ts")).toBe(false);
	});
});

describe("inputMatchesSpecifier", () => {
	test("Bash prefix-word matching", () => {
		expect(inputMatchesSpecifier("Bash", "git *", { command: "git status --short" }, CWD)).toBe(true);
		expect(inputMatchesSpecifier("Bash", "git status", { command: "git status" }, CWD)).toBe(true);
		expect(inputMatchesSpecifier("Bash", "git status", { command: "git push" }, CWD)).toBe(false);
		expect(inputMatchesSpecifier("Bash", "*", { command: "anything" }, CWD)).toBe(true);
	});

	test("file tools match workspace-relative and absolute paths (Windows)", () => {
		expect(inputMatchesSpecifier("Edit", "src/**", { file_path: "G:\\work\\proj\\src\\a.ts" }, CWD)).toBe(true);
		expect(inputMatchesSpecifier("Edit", "src/**", { file_path: "G:/work/proj/src/deep/b.ts" }, CWD)).toBe(true);
		expect(inputMatchesSpecifier("Edit", "src/**", { file_path: "G:\\other\\src\\a.ts" }, CWD)).toBe(false);

		const home = (process.env.USERPROFILE ?? process.env.HOME ?? "").replace(/\\/g, "/");
		if (home) {
			expect(inputMatchesSpecifier("Read", "~/.ssh/*", { file_path: `${home}/.ssh/id_rsa` }, "G:\\x")).toBe(true);
		}
	});

	test("mcp rules match by server or server__tool", () => {
		expect(inputMatchesSpecifier("mcp__github", "*", {}, CWD)).toBe(true);
		expect(inputMatchesSpecifier("mcp__github__create_issue", "mcp__github", {}, CWD)).toBe(true);
		expect(inputMatchesSpecifier("mcp__gitlab__push", "mcp__github", {}, CWD)).toBe(false);
	});
});

describe("evaluatePermissions", () => {
	const rules = (entries: Array<[string, "allow" | "deny"]>): PermissionRule[] =>
		entries.map(([text, behavior]) => {
			const parsed = parseRuleText(text);
			if (!parsed) throw new Error(`invalid rule text in test fixture: ${text}`);
			return { ...parsed, behavior, source: "projectSettings" as const };
		});

	test("bypassPermissions allows everything without consulting rules", () => {
		const result = evaluatePermissions(
			"Bash",
			{ command: "rm -rf /" },
			{
				mode: "bypassPermissions",
				rules: rules([["Bash", "deny"]]),
				cwd: CWD,
			},
		);
		expect(result.behavior).toBe("allow");
	});

	test("plan mode denies mutating tools, allows read-only", () => {
		const config = { mode: "plan" as const, rules: [], cwd: CWD };
		expect(evaluatePermissions("Write", { file_path: "a.txt", content: "" }, config).behavior).toBe("deny");
		expect(evaluatePermissions("Read", { file_path: "a.txt" }, config).behavior).toBe("ask");
	});

	test("acceptEdits auto-allows workspace edits only", () => {
		const config = { mode: "acceptEdits" as const, rules: [], cwd: CWD };
		expect(
			evaluatePermissions("Edit", { file_path: `${CWD}\\a.ts`, old_string: "a", new_string: "b" }, config).behavior,
		).toBe("allow");
		expect(evaluatePermissions("Bash", { command: "ls" }, config).behavior).toBe("ask");
	});

	test("deny wins over allow regardless of order", () => {
		const config = {
			mode: "default" as const,
			rules: rules([
				["Bash(git *)", "allow"],
				["Bash(git push*)", "deny"],
			]),
			cwd: CWD,
		};
		expect(evaluatePermissions("Bash", { command: "git status" }, config).behavior).toBe("allow");
		expect(evaluatePermissions("Bash", { command: "git push origin main" }, config).behavior).toBe("deny");
	});

	test("bare deny blocks the whole tool before the model sees matching input", () => {
		const config = { mode: "default" as const, rules: rules([["WebFetch", "deny"]]), cwd: CWD };
		expect(evaluatePermissions("WebFetch", { url: "https://x" }, config).behavior).toBe("deny");
	});

	test("no matching rule → ask", () => {
		const config = { mode: "default" as const, rules: [], cwd: CWD };
		expect(evaluatePermissions("Bash", { command: "ls" }, config).behavior).toBe("ask");
	});

	test("parseRuleList skips malformed entries", () => {
		const parsed = parseRuleList(["Bash", "bad(rule", ""], "allow", "session");
		expect(parsed).toHaveLength(1);
	});
});

describe("normalizePathSpec", () => {
	test("converts backslashes", () => {
		expect(normalizePathSpec("G:\\work\\proj\\src")).toBe("G:/work/proj/src");
	});
});
