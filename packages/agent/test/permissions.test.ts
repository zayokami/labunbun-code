import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
	evaluatePermissions,
	inputMatchesSpecifier,
	normalizePathSpec,
	type PermissionRule,
	parseRuleList,
	parseRuleText,
	specifierToRegExp,
} from "../src/permissions.ts";
import { PERMISSION_MODES, SANDBOX_MODES } from "../src/types.ts";

/**
 * The confined pairing, spelled once.
 *
 * Every case below is about the *mode* axis, so the sandbox axis is pinned to
 * the confined value rather than left to each case. `danger-full-access` is not
 * interchangeable with it for the rules under test — the deny scan and the
 * classifier both run above it — and the two facts are asserted separately
 * below instead of being assumed by omission.
 */
const SANDBOX = "workspace-write" as const;

/**
 * A workspace root in the spelling *this* platform resolves, and a sibling
 * outside it.
 *
 * These used to be the literals `G:\work\proj` and `G:\other`. On POSIX a
 * backslash is an ordinary filename character, so `resolve` treated the whole
 * thing as one relative name under the cwd — and the matching that followed
 * only came out right by coincidence, because the cwd got appended to itself
 * (`pathMatches` computes `resolve(cwd, cwd)` for the workspace prefix) and
 * happened to produce the same doubled path the test's own input had.
 */
const CWD = process.platform === "win32" ? "G:/work/proj" : "/work/proj";
const OUTSIDE = resolve(CWD, "..", "other");

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

	test("file tools match workspace-relative and absolute paths, in either spelling", () => {
		// `join` gives the platform's native separator and the template gives the
		// other one, so on Windows the same file is checked twice under both
		// spellings and `normalizePathSpec` is what has to carry it. On POSIX
		// there is only the one spelling, and these are the same string.
		expect(inputMatchesSpecifier("Edit", "src/**", { file_path: join(CWD, "src", "a.ts") }, CWD)).toBe(true);
		expect(inputMatchesSpecifier("Edit", "src/**", { file_path: `${CWD}/src/deep/b.ts` }, CWD)).toBe(true);
		expect(inputMatchesSpecifier("Edit", "src/**", { file_path: join(OUTSIDE, "src", "a.ts") }, CWD)).toBe(false);

		// The same lookup the source does, so the value does not matter — what is
		// under test is that `~` expands at all. That is only true if there *is* a
		// home to expand, so the emptiness is asserted rather than branched on: a
		// guard like `if (home)` turns a machine that happens to set neither
		// variable into a test that checks nothing and reports green.
		const home = (process.env.USERPROFILE ?? process.env.HOME ?? "").replace(/\\/g, "/");
		expect(home).not.toBe("");
		expect(inputMatchesSpecifier("Read", "~/.ssh/*", { file_path: `${home}/.ssh/id_rsa` }, "G:\\x")).toBe(true);
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

	/**
	 * The reverse of a test that used to be here.
	 *
	 * It read: "bypassPermissions allows everything without consulting rules" —
	 * a `Bash` deny rule in the config, `rm -rf /` at the tool, and `allow`. That
	 * was a true statement about the code, and it was the only place in the build
	 * where a permission mode could overrule a rule the user had written
	 * themselves. `deny-scan-first` is written down as a security invariant in
	 * `.labunbun/skills/code-review-security/SKILL.md:8`, and the code was the
	 * thing that disagreed with it.
	 *
	 * So the assertion is inverted rather than the test deleted: the same three
	 * facts, the same command, the answer is now `deny`. Deleting it would have
	 * left the rewrite with nothing to point at — a test that only ever checked
	 * the mode the *old* system got right cannot tell the new one apart from the
	 * old one.
	 *
	 * `test.each` over both axes rather than a single case, because "no mode and
	 * no sandbox setting reaches past a deny rule" is a claim about the whole
	 * product, and a claim about six values tested on one of them is a claim
	 * about one value.
	 */
	test.each(PERMISSION_MODES.flatMap((mode) => SANDBOX_MODES.map((sandbox) => [mode, sandbox] as const)))(
		"a deny rule beats %s with sandbox %s",
		(mode, sandbox) => {
			const result = evaluatePermissions(
				"Bash",
				{ command: "rm -rf /" },
				{
					mode,
					sandbox,
					rules: rules([["Bash", "deny"]]),
					cwd: CWD,
				},
			);
			expect(result.behavior).toBe("deny");
		},
	);

	/**
	 * The same property on the other deny path.
	 *
	 * A file deny rule is extended across the shell (`bashHitsFileDenyRule`), and
	 * that extension is a *second* place a mode could have short-circuited. It is
	 * a different branch of `evaluatePermissions` from the bare-tool match above,
	 * so a test on the bare-tool branch says nothing about it — the deny scan
	 * "passes" and the extension below it does not.
	 */
	test.each([...PERMISSION_MODES])("a file deny rule reaches the shell in %s too", (mode) => {
		const config = { mode, sandbox: SANDBOX, rules: rules([["Read(secret/**)", "deny"]]), cwd: CWD };
		expect(evaluatePermissions("Bash", { command: "cat secret/key" }, config).behavior).toBe("deny");
	});

	/**
	 * The classifier is above the allow rules, and this is the test that holds it
	 * there. It exists because a falsification run found the gap rather than
	 * because the property was thought of: moving the classifier block from step 2
	 * to below the allow loop left the whole suite green — 4202 pass, 0 fail —
	 * while silently undoing the sentence in the comment above it ("a match is
	 * never turned into a pass by an allow rule").
	 *
	 * That gap was live for the whole batch. An allow rule is the *ordinary* way a
	 * user grants a standing permission (`Bash(git *)` so the agent stops asking
	 * about git), so the case is not exotic: a user who allows `Bash` broadly and
	 * then runs `rm -rf /` would have got `allow` from the allow loop and never
	 * reached the classifier at all.
	 *
	 * The decision not to let an `allow` prefix rule short-circuit the classifier
	 * is one the plan states in writing. A decision that only exists in a comment
	 * is not a decision, and this is the line that makes it one.
	 */
	test.each(PERMISSION_MODES.flatMap((mode) => SANDBOX_MODES.map((sandbox) => [mode, sandbox] as const)))(
		"an allow rule does not buy %s with sandbox %s a dangerous command",
		(mode, sandbox) => {
			const result = evaluatePermissions(
				"Bash",
				{ command: "rm -rf /" },
				{ mode, sandbox, rules: rules([["Bash", "allow"]]), cwd: CWD },
			);
			// `agent` has nobody to ask, so a classified command is refused outright;
			// `ask` still reaches a person. Neither answer is `allow`, and which one
			// it is matters: a test that only asserted "not allow" would pass on a
			// build that had quietly turned every dangerous command into a prompt.
			expect(result.behavior).toBe(mode === "agent" ? "deny" : "ask");
		},
	);

	/**
	 * A *specifier* allow rule, not just the bare-tool one above, because a
	 * specifier is the form users actually write and it is matched by a different
	 * branch of `ruleMatches`. `Bash(rm *)` is also the more pointed case: it is
	 * the rule someone writes precisely so the agent can delete things without
	 * asking, and it must still not be able to delete everything.
	 */
	test("a specifier allow rule covering rm does not reach a forced delete", () => {
		const config = { mode: "agent" as const, sandbox: SANDBOX, rules: rules([["Bash(rm *)", "allow"]]), cwd: CWD };
		expect(evaluatePermissions("Bash", { command: "rm -rf /" }, config).behavior).toBe("deny");
		// The control half, and it is in `ask` mode on purpose. In `agent` mode
		// step 5 answers `allow` to anything nothing else decided, so the same
		// assertion there would pass whether or not the rule matched at all — a
		// control that cannot fail is not a control. In `ask` mode the two
		// outcomes differ: the rule matching gives `allow`, and nothing deciding
		// gives `ask`.
		const askConfig = { ...config, mode: "ask" as const };
		expect(evaluatePermissions("Bash", { command: "rm build/out.txt" }, askConfig).behavior).toBe("allow");
		expect(evaluatePermissions("Bash", { command: "git status" }, askConfig).behavior).toBe("ask");
	});

	test("plan mode denies mutating tools, allows read-only", () => {
		const config = { mode: "plan" as const, sandbox: SANDBOX, rules: [], cwd: CWD };
		expect(evaluatePermissions("Write", { file_path: "a.txt", content: "" }, config).behavior).toBe("deny");
		expect(evaluatePermissions("Read", { file_path: "a.txt" }, config).behavior).toBe("ask");
	});

	test.each(["EnterPlanMode", "ExitPlanMode"])(
		"plan mode permits %s to reach approval without bypassing denies",
		(toolName) => {
			const config = { mode: "plan" as const, sandbox: SANDBOX, rules: [], cwd: CWD };
			expect(evaluatePermissions(toolName, { plan: "proposal" }, config).behavior).toBe("ask");
			expect(evaluatePermissions(toolName, {}, { ...config, rules: rules([[toolName, "allow"]]) }).behavior).toBe(
				"allow",
			);
			expect(
				evaluatePermissions(
					toolName,
					{},
					{
						...config,
						rules: rules([
							[toolName, "allow"],
							[toolName, "deny"],
						]),
					},
				).behavior,
			).toBe("deny");
		},
	);

	test("plan control exceptions do not permit mutation even with allow rules", () => {
		const config = { mode: "plan" as const, sandbox: SANDBOX, rules: rules([["*", "allow"]]), cwd: CWD };
		for (const toolName of ["Write", "Edit", "Bash", "NotebookEdit", "mcp__server__mutate"]) {
			expect(evaluatePermissions(toolName, {}, config).behavior).toBe("deny");
		}
	});

	test("deny wins over allow regardless of order", () => {
		const config = {
			mode: "ask" as const,
			sandbox: SANDBOX,
			rules: rules([
				["Bash(git *)", "allow"],
				["Bash(git push*)", "deny"],
			]),
			cwd: CWD,
		};
		expect(evaluatePermissions("Bash", { command: "git status" }, config).behavior).toBe("allow");
		expect(evaluatePermissions("Bash", { command: "git push origin main" }, config).behavior).toBe("deny");
	});

	/**
	 * The cross-tool case, which is a different mechanism from the one above and
	 * was the actual bypass this guards: a rule written for one tool has to reach
	 * a shell command that reads the same file, because otherwise `Read(...)`
	 * deny is no more than a request to be polite. `extractBashFilePaths` is the
	 * whole of that mechanism.
	 *
	 * The control matters as much as the assertion. Without it, "deny every
	 * Bash call" would satisfy this test, so the second case pins that a command
	 * touching a *different* path is untouched — that is what distinguishes the
	 * extension from a blanket denial.
	 */
	test("a file deny rule reaches the shell that reads the same file", () => {
		const config = { mode: "ask" as const, rules: rules([["Read(secret/**)", "deny"]]), sandbox: SANDBOX, cwd: CWD };

		// The same file, through each tool that can read it.
		expect(evaluatePermissions("Read", { file_path: join(CWD, "secret", "key") }, config).behavior).toBe("deny");
		expect(evaluatePermissions("Bash", { command: "cat secret/key" }, config).behavior).toBe("deny");
		expect(evaluatePermissions("Bash", { command: "head -n1 secret/key" }, config).behavior).toBe("deny");
		// Hidden behind a pipe, which is the shape that made this worth extracting
		// a tokenizer for: the deny has to be found in the second segment.
		expect(evaluatePermissions("Bash", { command: "echo hi | cat secret/key" }, config).behavior).toBe("deny");

		// Controls: a different file is not denied, and a non-reading command is
		// not turned into a denial by association with the word `cat`.
		expect(evaluatePermissions("Bash", { command: "cat public/key" }, config).behavior).toBe("ask");
		expect(evaluatePermissions("Bash", { command: "echo secret/key" }, config).behavior).toBe("ask");
		expect(evaluatePermissions("Bash", { command: "git status" }, config).behavior).toBe("ask");
	});

	test("bare deny blocks the whole tool before the model sees matching input", () => {
		const config = { mode: "ask" as const, rules: rules([["WebFetch", "deny"]]), sandbox: SANDBOX, cwd: CWD };
		expect(evaluatePermissions("WebFetch", { url: "https://x" }, config).behavior).toBe("deny");
	});

	test("no matching rule → ask", () => {
		const config = { mode: "ask" as const, rules: [], sandbox: SANDBOX, cwd: CWD };
		expect(evaluatePermissions("Bash", { command: "ls" }, config).behavior).toBe("ask");
	});

	test("parseRuleList skips malformed entries", () => {
		const parsed = parseRuleList(["Bash", "bad(rule", ""], "allow", "session");
		expect(parsed).toHaveLength(1);
	});

	/**
	 * MCP rules are written as bare tool names (`mcp__github`), not in
	 * `Tool(specifier)` form, so they need their own matching. Both directions are
	 * asserted: the server-wide form has to cover the server's tools, and it must
	 * not reach past that server — a rule that over-matches on the deny side
	 * blocks unrelated tools, and on the allow side grants them.
	 */
	describe.each([["allow", "allow", "ask"] as const, ["deny", "deny", "ask"] as const])(
		"bare MCP rules in the %s direction",
		(behavior, onMatch, onMiss) => {
			test.each([
				["mcp__github__*", "mcp__github__create_issue", true],
				["mcp__github", "mcp__github__create_issue", true],
				["mcp__github", "mcp__github", true],
				["mcp__github__create_issue", "mcp__github__create_issue", true],
				["mcp__github__create_*", "mcp__github__create_issue", true],
				["mcp__github__create_*", "mcp__github__delete_repo", false],
				["mcp__github", "mcp__gitlab__create_issue", false],
				["mcp__github__*", "mcp__gitlab__anything", false],
				// A server whose name merely starts with another's must not be covered.
				["mcp__github", "mcp__githubby__whatever", false],
				["mcp__github", "Read", false],
			])("%s vs %s", (ruleText, toolName, shouldMatch) => {
				const config = { mode: "ask" as const, rules: rules([[ruleText, behavior]]), sandbox: SANDBOX, cwd: CWD };
				expect(evaluatePermissions(toolName, {}, config).behavior).toBe(shouldMatch ? onMatch : onMiss);
			});
		},
	);

	test("a non-MCP rule is unaffected by MCP matching", () => {
		const config = { mode: "ask" as const, rules: rules([["Read", "allow"]]), sandbox: SANDBOX, cwd: CWD };
		expect(evaluatePermissions("Read", { file_path: "a.ts" }, config).behavior).toBe("allow");
		expect(evaluatePermissions("Write", { file_path: "a.ts" }, config).behavior).toBe("ask");
		// `*` still matches everything, including MCP tools.
		const wildcard = { mode: "ask" as const, rules: rules([["*", "allow"]]), sandbox: SANDBOX, cwd: CWD };
		expect(evaluatePermissions("mcp__github__x", {}, wildcard).behavior).toBe("allow");
	});

	test("an MCP deny beats an MCP allow for the same server", () => {
		const config = {
			mode: "ask" as const,
			rules: rules([
				["mcp__github", "allow"],
				["mcp__github__delete_repo", "deny"],
			]),
			sandbox: SANDBOX,
			cwd: CWD,
		};
		expect(evaluatePermissions("mcp__github__create_issue", {}, config).behavior).toBe("allow");
		expect(evaluatePermissions("mcp__github__delete_repo", {}, config).behavior).toBe("deny");
	});
});

describe("normalizePathSpec", () => {
	test("converts backslashes", () => {
		expect(normalizePathSpec("G:\\work\\proj\\src")).toBe("G:/work/proj/src");
	});
});
