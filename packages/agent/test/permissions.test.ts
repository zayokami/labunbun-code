import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	collectReadOnlyToolNames,
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
	const rules = (entries: Array<[string, PermissionRule["behavior"]]>): PermissionRule[] =>
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
	 * A file deny rule is extended across the shell (`bashHitsFileRule`), and
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
			//
			// **`plan` is in the deny arm now, and it used to be in the `ask` arm.**
			// This row described observed behaviour rather than intended behaviour,
			// which is how it came to pin a defect: the paragraph above it reasoned
			// about `agent` and `ask` and never said what `plan` should be, so the
			// binary answer absorbed `plan` by default. It was `ask`, because the
			// classifier returned before the plan check and `decideDangerous` only
			// made `agent` terminal — so under `plan` the safe command was denied
			// and the destructive one was offered to a person, in the one mode that
			// promises no shell at all. The plan check now sits above the
			// classifier, so `plan` denies with `agent`, and this row follows.
			expect(result.behavior).toBe(mode === "agent" || mode === "plan" ? "deny" : "ask");
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

	/**
	 * The caller's set, when there is one, *is* the gate — both directions.
	 *
	 * The static list and the live tool objects agreed on every tool this build
	 * registers (that is `plan-mode-allowlist.test.ts`'s job), so a test that only
	 * ran the real set through would pass even if the engine still read the list.
	 * The two rows below are each the *disagreement*: a name the list does not
	 * hold is admitted when declared read-only, and a list member is refused when
	 * the caller's set drops it. Either one silently falling back to the list
	 * fails here.
	 */
	test("a caller-supplied set decides the gate, not the static list", () => {
		const base = { mode: "plan" as const, sandbox: SANDBOX, rules: [], cwd: CWD };
		// Not in `PLAN_MODE_READ_ONLY_TOOLS`; declared read-only, the plan gate steps
		// aside and the empty rule list lands on the mode's own answer.
		const declared = evaluatePermissions("Write", {}, { ...base, readOnlyToolNames: new Set(["Write"]) });
		expect(declared.behavior).toBe("ask");
		// In the static list, but the caller's set does not hold it: denied, with
		// the plan gate's own message rather than some other refusal.
		const dropped = evaluatePermissions("Read", {}, { ...base, readOnlyToolNames: new Set<string>() });
		expect(dropped.behavior).toBe("deny");
		if (dropped.behavior !== "deny") throw new Error("unreachable");
		expect(dropped.message).toContain("Plan mode");
	});

	/**
	 * Presence in the set is the declaration's own answer, and a missing
	 * declaration is the mutating one.
	 *
	 * `buildTool` defaults an absent `isReadOnly` to false, so a tool with no
	 * declaration must land on the deny side of the gate rather than on an
	 * unknown that slips through — and the middle entry proves the set is built
	 * from the answers, not from the mere existence of the method.
	 */
	test("collectReadOnlyToolNames answers from the declarations alone", () => {
		const names = collectReadOnlyToolNames([
			{ name: "Alpha", isReadOnly: () => true },
			{ name: "Beta", isReadOnly: () => false },
			{ name: "Gamma" },
		]);
		expect([...names]).toEqual(["Alpha"]);
	});

	/**
	 * A Bash call the classifier cannot read is refused rather than treated as an
	 * ordinary command.
	 *
	 * Unreachable through the built-in Bash tool — the pipeline schema-validates
	 * before `canUseTool`, so `command` is always a string by then. These rows are
	 * here because the step-2 guarantee depends on that ordering, and the ordering
	 * lives in `pipeline.ts` while the consequence lives here. If the schema were
	 * ever relaxed, "no readable command" would silently become "not dangerous" and
	 * `agent` mode's own answer below would allow it.
	 */
	describe("a Bash call with nothing for the classifier to read", () => {
		// The shapes are table-driven because they take different routes to the
		// same place: a non-string `command` fails the typeof check, a missing one
		// and a non-object input fail the shape check, and all three used to land
		// on the same silent `allow`.
		test.each([
			["a number", { command: 123 }],
			["null", { command: null }],
			["an array", { command: ["rm", "-rf", "/"] }],
			["no command key at all", {}],
			["a bare string", "rm -rf /"],
			["null input", null],
		])("is denied when the command is %s", (_label, input) => {
			const config = { mode: "agent" as const, sandbox: SANDBOX, rules: [], cwd: CWD };
			const decision = evaluatePermissions("Bash", input, config);
			if (decision.behavior !== "deny") throw new Error(`expected deny, got ${decision.behavior}`);
			// A deny with no reason is indistinguishable from a bug, and the reason
			// is what tells a reader this was a refusal to guess rather than a
			// classification.
			expect(decision.message).toContain("no readable string command");
		});

		test("and no allow rule can buy it back", () => {
			// The bare `Bash` allow rule is the broadest thing a user can write, and
			// it matching is exactly the case that would turn this back into a pass
			// if the deny sat below the allow loop.
			//
			// Only an allow rule appears here. An earlier version of this row also
			// listed a `Bash` deny, which made it pass for the wrong reason: step 1
			// would have denied it before step 2 was reached, so the assertion held
			// whether or not this branch existed. The message is what proves which
			// step refused.
			const config = {
				mode: "agent" as const,
				sandbox: SANDBOX,
				rules: rules([["Bash", "allow"]]),
				cwd: CWD,
			};
			const decision = evaluatePermissions("Bash", { command: 123 }, config);
			if (decision.behavior !== "deny") throw new Error(`expected deny, got ${decision.behavior}`);
			expect(decision.message).toContain("no readable string command");
		});

		test("a readable command is unaffected, in both directions", () => {
			// The control for the table above: if the new branch fired on ordinary
			// input, these would go with it.
			const config = { mode: "agent" as const, sandbox: SANDBOX, rules: [], cwd: CWD };
			expect(evaluatePermissions("Bash", { command: "git status" }, config).behavior).toBe("allow");
			expect(evaluatePermissions("Bash", { command: "rm -rf /" }, config).behavior).toBe("deny");
		});

		test("a non-Bash tool with no command is untouched", () => {
			// Only Bash has a command to read. Applying the same refusal to every
			// tool would refuse every call whose input is not shaped like a Bash
			// call, which is all of them.
			const config = { mode: "agent" as const, sandbox: SANDBOX, rules: [], cwd: CWD };
			expect(evaluatePermissions("Read", { file_path: "a.txt" }, config).behavior).toBe("allow");
			expect(evaluatePermissions("Write", { file_path: "a.txt", content: "" }, config).behavior).toBe("allow");
		});
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
		// **`Bash` in the loop above is answered by the unreadable-command branch,
		// not by the plan check.** `{}` has no `command`, so `readBashCommand`
		// returns undefined and the call denies at the fail-closed branch — which
		// now sits *below* the plan check but did not sit above the classifier
		// either. The assertion is real, and it is not the one the test is named
		// for. The test below passes a real command string for exactly this reason.
	});

	test("plan mode denies a dangerous command outright, because it runs no shell at all", () => {
		// **This is the row whose absence let the ordering defect survive.** With
		// `Bash` absent from `PLAN_MODE_READ_ONLY_TOOLS`, the plan check does deny
		// it — but the classifier returned first and `decideDangerous` only made
		// `agent` terminal, so `plan` fell through to `ask`. Measured with the
		// engine called directly, before the check was hoisted above the
		// classifier:
		//
		//     plan  rm -rf /    => ask    Blocked as a dangerous command: `rm` with a force option
		//     plan  git status  => deny   Plan mode: Bash is not allowed (read-only mode)
		//
		// The safe command hard-denied and only the destructive one was offered to
		// a human, in the one mode that promises no shell at all. Answering that
		// dialog ran a shell command in plan mode, and no user rule was needed to
		// reach it — the ordering alone did it.
		const config = { mode: "plan" as const, sandbox: SANDBOX, rules: [], cwd: CWD };
		// Both halves, because either alone would pass against the old ordering
		// for a different reason: the dangerous one used to ask, and the ordinary
		// one is here so this cannot be satisfied by "plan mode denies everything".
		for (const command of ["rm -rf /", "sudo rm -rf /", "git status", "ls"]) {
			const decision = evaluatePermissions("Bash", { command }, config);
			// Narrowed rather than asserted twice: `PermissionResult`'s `allow` arm
			// carries no `message`, so reaching for one before knowing the behaviour
			// would not compile — and the throw says which command regressed.
			if (decision.behavior !== "deny") {
				throw new Error(`expected deny under plan, got ${decision.behavior} for "${command}"`);
			}
			// The reason too: a deny naming the dangerous command would be the
			// other bug, and it is the one this ordering is most likely to drift to.
			expect(decision.message).toContain("Plan mode");
		}

		// The control, and the reason this is a claim about *ordering* rather than
		// about plan mode being strict: the same command still reaches a human
		// under `ask`, where catching it is the classifier's job. If this ever
		// denies, the fix has become "plan mode denies more" and the two have
		// stopped saying anything about each other.
		const asking = { mode: "ask" as const, sandbox: SANDBOX, rules: [], cwd: CWD };
		expect(evaluatePermissions("Bash", { command: "rm -rf /" }, asking).behavior).toBe("ask");
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

	/**
	 * The rule names the file the tool will open, not the spelling the model
	 * chose. `resolveCanonical` used to be lexical, so a link inside the
	 * workspace was enough to step around a deny rule: the permission layer
	 * approved the alias and the tool followed it to the forbidden target.
	 */
	test("a symlink alias cannot launder a deny rule", () => {
		const root = mkdtempSync(join(tmpdir(), "lbb-perm-"));
		try {
			const workspace = realpathSync(root).replace(/^\\\\\?\\/, "");
			mkdirSync(join(workspace, "secrets"));
			writeFileSync(join(workspace, "secrets", "key"), "k");
			symlinkSync(
				join(workspace, "secrets"),
				join(workspace, "alias"),
				process.platform === "win32" ? "junction" : "dir",
			);
			const config = {
				mode: "agent" as const,
				sandbox: SANDBOX,
				rules: rules([["Read(secrets/**)", "deny"]]),
				cwd: workspace,
			};

			expect(evaluatePermissions("Read", { file_path: join(workspace, "alias", "key") }, config).behavior).toBe("deny");
			// The shell cross-check reads the same matcher, so `cat alias/key` is
			// the same bypass one tool over.
			expect(evaluatePermissions("Bash", { command: "cat alias/key" }, config).behavior).toBe("deny");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	/**
	 * Folding one side only was the second half of the same defect: a rule
	 * carrying an upper-case segment never met a call spelled in lower case,
	 * even though both name one file on Windows and default APFS. The relative
	 * spelling is used so the assertion does not depend on a drive existing.
	 */
	test.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
		"a rule and a path spelled in different cases still meet",
		() => {
			expect(inputMatchesSpecifier("Read", "src/SECRET/**", { file_path: "src/secret/key" }, CWD)).toBe(true);
		},
	);

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

	test("parseRuleList carries the ask behavior", () => {
		// All three behaviors travel the same path: the array's name is the
		// behavior, so the `permissions.ask` list reuses the allow/deny parser
		// rather than growing a second one.
		expect(parseRuleList(["Bash(git commit *)"], "ask", "userSettings")).toEqual([
			{ toolName: "Bash", specifier: "git commit *", behavior: "ask", source: "userSettings" },
		]);
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

	/**
	 * The third behavior, `ask`, and the mode it exists for is `agent`.
	 *
	 * In `ask` and `plan` a dialog appears anyway, so a test written there would
	 * pass on the mode's own answer and say nothing about the rule. `agent` is
	 * where an ask rule has to override the mode's promise that everything runs
	 * unattended — and that promise is what such a rule is written against.
	 *
	 * The block pins the two ties the file header decides rather than leaves to
	 * loop order:
	 *
	 *   - deny over ask: step 1 returns before the ask loop, so an ask never
	 *     lifts a floor;
	 *   - ask over allow: step 4 sits above the allow loop, because a standing
	 *     allow is exactly what an ask rule is written to punch through.
	 *
	 * Specificity never enters either one: a match is boolean, and the behaviors
	 * rank, not the patterns. `Bash(git commit *) ask` beats a bare `Bash allow`
	 * not because it is more specific but because ask is consulted first.
	 */
	describe("rules that ask", () => {
		test("an ask rule forces the dialog even in agent mode", () => {
			const config = {
				mode: "agent" as const,
				sandbox: SANDBOX,
				rules: rules([["Bash(git commit *)", "ask"]]),
				cwd: CWD,
			};
			const decision = evaluatePermissions("Bash", { command: "git commit -m x" }, config);
			expect(decision.behavior).toBe("ask");
			if (decision.behavior !== "ask") throw new Error("unreachable");
			// The message names the rule that asked, which is most of what the
			// dialog has to show about why it opened.
			expect(decision.message).toContain("Asked by projectSettings rule: Bash(git commit *)");
			// Control: the specifier bounds the rule, so a sibling git command still
			// runs unattended.
			expect(evaluatePermissions("Bash", { command: "git status" }, config).behavior).toBe("allow");
		});

		test("a bare-tool ask rule reaches every call of its tool, and no other tool", () => {
			const config = { mode: "agent" as const, sandbox: SANDBOX, rules: rules([["Bash", "ask"]]), cwd: CWD };
			expect(evaluatePermissions("Bash", { command: "git status" }, config).behavior).toBe("ask");
			// `Write` is not named, so agent mode still runs it unattended: a rule
			// constrains one tool, not the session.
			expect(evaluatePermissions("Write", { file_path: "a.txt", content: "" }, config).behavior).toBe("allow");
		});

		test("deny beats ask regardless of order", () => {
			// Both orders, because the two behaviors live in separate loops: the
			// outcome has to be a property of the behaviors, not of which loop a
			// future refactor happens to run first. The first order is also the
			// pointed one — the ask rule is the *broader* match and the deny still
			// wins, which is what "an ask never lifts a floor" means.
			const orders: Array<Array<[string, PermissionRule["behavior"]]>> = [
				[
					["Bash(git *)", "ask"],
					["Bash(git commit *)", "deny"],
				],
				[
					["Bash(git commit *)", "deny"],
					["Bash(git *)", "ask"],
				],
			];
			for (const entries of orders) {
				const config = { mode: "agent" as const, sandbox: SANDBOX, rules: rules(entries), cwd: CWD };
				const decision = evaluatePermissions("Bash", { command: "git commit -m x" }, config);
				expect(decision.behavior).toBe("deny");
				if (decision.behavior !== "deny") throw new Error("unreachable");
				// The refusing rule is named too, so the assertion cannot be satisfied
				// by some other refusal happening to fire instead.
				expect(decision.message).toContain("Denied by projectSettings rule: Bash(git commit *)");
			}
		});

		test("an ask rule survives the broad allow that would otherwise swallow it", () => {
			// The shape the behavior exists for: a session-wide "stop asking about
			// Bash" grant, and the one command family the user still wants to see.
			// Were the allow loop consulted first, the commit would run unattended —
			// the one failure a user cannot see, because nothing would be shown.
			const config = {
				mode: "agent" as const,
				sandbox: SANDBOX,
				rules: rules([
					["Bash", "allow"],
					["Bash(git commit *)", "ask"],
				]),
				cwd: CWD,
			};
			expect(evaluatePermissions("Bash", { command: "git commit -m x" }, config).behavior).toBe("ask");
			// Control: the allow rule still does its own job for everything the ask
			// rule does not name.
			expect(evaluatePermissions("Bash", { command: "git status" }, config).behavior).toBe("allow");
		});

		test("the classifier's refusal is not softened into a question by an ask rule", () => {
			// Step 3 above step 4: an ask rule naming `rm` cannot turn agent mode's
			// hard refusal into a dialog, because the classifier returns before the
			// ask loop runs. The message pins *which* step answered — the assertion
			// on "Asked by" would catch a reroute that happened to say deny some
			// other way.
			const config = { mode: "agent" as const, sandbox: SANDBOX, rules: rules([["Bash", "ask"]]), cwd: CWD };
			const decision = evaluatePermissions("Bash", { command: "rm -rf /" }, config);
			expect(decision.behavior).toBe("deny");
			if (decision.behavior !== "deny") throw new Error("unreachable");
			expect(decision.message).toContain("Blocked as a dangerous command");
			expect(decision.message).not.toContain("Asked by");
			// The refusal no longer points at a rule as a way through: no rule lifts
			// this one, and that is the sentence that used to say otherwise.
			expect(decision.message).toContain("no allow or ask rule lifts it");
			// Control, both halves: the same ask rule does reach an ordinary command
			// (so the rule is live), and in `ask` mode the classified command is the
			// classifier's to ask about — its message, not the rule's.
			expect(evaluatePermissions("Bash", { command: "ls" }, config).behavior).toBe("ask");
			const asked = evaluatePermissions("Bash", { command: "rm -rf /" }, { ...config, mode: "ask" as const });
			expect(asked.behavior).toBe("ask");
			if (asked.behavior !== "ask") throw new Error("unreachable");
			expect(asked.message).toContain("Blocked as a dangerous command");
		});

		test("plan's deny outranks an ask rule", () => {
			// Plan is a deny at step 2, above the ask loop for the same reason it is
			// above the allow loop: in a mode that promises no writes, a dialog whose
			// `yes` writes anyway is the promise broken by one keystroke.
			const config = { mode: "plan" as const, sandbox: SANDBOX, rules: rules([["Write", "ask"]]), cwd: CWD };
			const decision = evaluatePermissions("Write", { file_path: "a.txt", content: "" }, config);
			expect(decision.behavior).toBe("deny");
			if (decision.behavior !== "deny") throw new Error("unreachable");
			expect(decision.message).toContain("Plan mode");
			// Control: a read-only tool the plan gate admits does reach the dialog,
			// and the message proves the rule opened it rather than the mode's own
			// undecided fallback (which also answers `ask`, without a message).
			const read = evaluatePermissions("Read", { file_path: "a.txt" }, { ...config, rules: rules([["Read", "ask"]]) });
			expect(read.behavior).toBe("ask");
			if (read.behavior !== "ask") throw new Error("unreachable");
			expect(read.message).toContain("Asked by projectSettings rule: Read");
		});

		test("a file ask rule reaches the shell that touches the same file", () => {
			// The Bash cross-check is asked of ask rules the way it is asked of deny
			// rules, and for the same open-bypass reason: a file the user wants to be
			// consulted about must not be writable silently through the shell.
			const config = {
				mode: "agent" as const,
				sandbox: SANDBOX,
				rules: rules([["Write(secret/**)", "ask"]]),
				cwd: CWD,
			};
			const decision = evaluatePermissions("Bash", { command: "echo x > secret/key" }, config);
			expect(decision.behavior).toBe("ask");
			if (decision.behavior !== "ask") throw new Error("unreachable");
			// The verdict names the path it caught, so the dialog can say why it
			// opened.
			expect(decision.message).toContain('command accesses "secret/key"');
			// Control: the same redirection into an unprotected directory runs
			// unattended in agent mode, and the file tool itself is still asked
			// about.
			expect(evaluatePermissions("Bash", { command: "echo x > public/key" }, config).behavior).toBe("allow");
			expect(evaluatePermissions("Write", { file_path: "secret/key", content: "" }, config).behavior).toBe("ask");
		});

		test("a file-tool allow does not extend to the shell", () => {
			// The extension is deliberately one-directional: a grant written for a
			// file tool says nothing about the shell (see `bashHitsFileRule`), so a
			// `Write` allow does not quietly become a `Bash` allow for a command
			// that writes the same file. `ask` mode is what makes the difference
			// observable: the shell call lands on the mode's own answer rather than
			// on the grant.
			const config = {
				mode: "ask" as const,
				sandbox: SANDBOX,
				rules: rules([["Write(secret/**)", "allow"]]),
				cwd: CWD,
			};
			expect(evaluatePermissions("Write", { file_path: "secret/key", content: "" }, config).behavior).toBe("allow");
			expect(evaluatePermissions("Bash", { command: "echo x > secret/key" }, config).behavior).toBe("ask");
		});
	});
});

describe("normalizePathSpec", () => {
	test("converts backslashes", () => {
		expect(normalizePathSpec("G:\\work\\proj\\src")).toBe("G:/work/proj/src");
	});
});

describe("the read-only sandbox refuses the file tools before anything else", () => {
	const EDIT_TOOLS = ["Write", "Edit"] as const;

	test.each(PERMISSION_MODES.flatMap((mode) => EDIT_TOOLS.map((tool) => [mode, tool] as const)))(
		"%s refuses %s under the read-only sandbox",
		(mode, tool) => {
			const result = evaluatePermissions(
				tool,
				{ file_path: join(CWD, "notes.md"), content: "x" },
				{ mode, sandbox: "read-only", rules: [], cwd: CWD },
			);
			// Plan mode answers first with its own sentence, so the matcher takes either reason; the deny is what matters.
			expect(result).toMatchObject({ behavior: "deny", message: expect.stringMatching(/Read-only sandbox|Plan mode/) });
		},
	);

	test("an allow rule does not buy a write under the read-only sandbox", () => {
		const result = evaluatePermissions(
			"Write",
			{ file_path: join(CWD, "notes.md"), content: "x" },
			{
				mode: "agent",
				sandbox: "read-only",
				rules: [{ toolName: "Write", behavior: "allow", source: "projectSettings" }],
				cwd: CWD,
			},
		);
		expect(result.behavior).toBe("deny");
	});

	test("reads are not decided by the read-only sandbox", () => {
		const result = evaluatePermissions(
			"Read",
			{ file_path: join(CWD, "notes.md") },
			{ mode: "agent", sandbox: "read-only", rules: [], cwd: CWD },
		);
		expect(result.behavior).toBe("allow");
	});
});

describe("an escalated command is asked about, whatever a rule or mode says", () => {
	const escalated = (command: string, extra: Record<string, unknown> = {}) => ({
		command,
		escalate: true,
		justification: "the registry is outside the sandbox's network",
		...extra,
	});

	test.each(["ask", "agent"] as const)("%s mode asks, even with a Bash allow rule", (mode) => {
		const result = evaluatePermissions("Bash", escalated("npm install"), {
			mode,
			sandbox: "workspace-write",
			rules: [{ toolName: "Bash", behavior: "allow", source: "projectSettings" }],
			cwd: CWD,
		});
		expect(result).toMatchObject({ behavior: "ask", message: expect.stringContaining("outside the sandbox") });
	});

	test("plan mode still refuses it, because a shell is not part of the plan", () => {
		const result = evaluatePermissions("Bash", escalated("npm install"), {
			mode: "plan",
			sandbox: "workspace-write",
			rules: [],
			cwd: CWD,
		});
		expect(result.behavior).toBe("deny");
	});

	test("a deny rule still refuses it", () => {
		const result = evaluatePermissions("Bash", escalated("npm install"), {
			mode: "ask",
			sandbox: "workspace-write",
			rules: [{ toolName: "Bash", behavior: "deny", source: "projectSettings" }],
			cwd: CWD,
		});
		expect(result.behavior).toBe("deny");
	});

	test("the classifier still refuses a dangerous escalated command outright in agent mode", () => {
		const result = evaluatePermissions("Bash", escalated("rm -rf /"), {
			mode: "agent",
			sandbox: "workspace-write",
			rules: [],
			cwd: CWD,
		});
		expect(result.behavior).toBe("deny");
	});

	test("an escalation with no justification is refused with no dialog", () => {
		const result = evaluatePermissions(
			"Bash",
			{ command: "npm install", escalate: true, justification: "  " },
			{
				mode: "ask",
				sandbox: "workspace-write",
				rules: [],
				cwd: CWD,
			},
		);
		expect(result).toMatchObject({ behavior: "deny", message: expect.stringContaining("justification") });
	});

	test("a backgrounded escalation is refused with no dialog", () => {
		const result = evaluatePermissions("Bash", escalated("npm run dev", { run_in_background: true }), {
			mode: "ask",
			sandbox: "workspace-write",
			rules: [],
			cwd: CWD,
		});
		expect(result).toMatchObject({ behavior: "deny", message: expect.stringContaining("foreground") });
	});

	test("an ordinary Bash call is not asked about on account of escalation", () => {
		const result = evaluatePermissions(
			"Bash",
			{ command: "git status" },
			{
				mode: "agent",
				sandbox: "workspace-write",
				rules: [],
				cwd: CWD,
			},
		);
		expect(result.behavior).toBe("allow");
	});
});

describe("a glob's directory wildcard", () => {
	test("a double star and slash stands for any number of directories, none included", () => {
		const nested = specifierToRegExp("src/**/*.ts");
		expect(nested.test("src/a.ts")).toBe(true);
		expect(nested.test("src/x/a.ts")).toBe(true);
		expect(nested.test("src/x/y/a.ts")).toBe(true);
		expect(nested.test("lib/a.ts")).toBe(false);
		expect(nested.test("src/a.js")).toBe(false);

		const anywhere = specifierToRegExp("**/.env");
		expect(anywhere.test(".env")).toBe(true);
		expect(anywhere.test("a/b/.env")).toBe(true);
		expect(anywhere.test("a/b/x.env")).toBe(false);
	});

	test("a double star inside a name is not a directory wildcard", () => {
		// Only a segment that *is* the double star gets the zero-directory reading; `foo**/bar` has
		// to keep needing a slash after whatever `foo**` matched.
		expect(specifierToRegExp("foo**/bar").test("foobar")).toBe(false);
		expect(specifierToRegExp("foo**/bar").test("foo/x/bar")).toBe(true);
	});

	test("a deny rule written with it reaches the files directly under the prefix", () => {
		const config = {
			mode: "agent" as const,
			sandbox: SANDBOX,
			rules: parseRuleList(["Edit(src/**/*.ts)"], "deny", "projectSettings"),
			cwd: CWD,
		};
		expect(evaluatePermissions("Edit", { file_path: join(CWD, "src", "a.ts") }, config).behavior).toBe("deny");
		expect(evaluatePermissions("Edit", { file_path: join(CWD, "src", "deep", "a.ts") }, config).behavior).toBe("deny");
		expect(evaluatePermissions("Edit", { file_path: join(CWD, "lib", "a.ts") }, config).behavior).toBe("allow");
	});
});

describe("a Bash specifier is literal text apart from its star", () => {
	test("a question mark in the pattern matches itself, and only itself", () => {
		const url = "curl https://example.test/?a=1";
		expect(inputMatchesSpecifier("Bash", url, { command: url }, CWD)).toBe(true);
		// What an unescaped `?` made of the pattern: an optional slash.
		expect(inputMatchesSpecifier("Bash", url, { command: "curl https://example.test/a=1" }, CWD)).toBe(false);
		expect(inputMatchesSpecifier("Bash", "ls ?", { command: "ls x" }, CWD)).toBe(false);
	});

	test("a deny rule with a question mark refuses its own command", () => {
		const url = "curl https://example.test/?a=1";
		const config = {
			mode: "agent" as const,
			sandbox: SANDBOX,
			rules: parseRuleList([`Bash(${url})`], "deny", "projectSettings"),
			cwd: CWD,
		};
		expect(evaluatePermissions("Bash", { command: url }, config).behavior).toBe("deny");
		expect(evaluatePermissions("Bash", { command: "curl https://example.test/" }, config).behavior).toBe("allow");
	});

	test("a pattern that is only a question mark is a rule, not a thrown error", () => {
		const config = {
			mode: "agent" as const,
			sandbox: SANDBOX,
			rules: parseRuleList(["Bash(?)"], "deny", "projectSettings"),
			cwd: CWD,
		};
		expect(evaluatePermissions("Bash", { command: "?" }, config).behavior).toBe("deny");
		expect(evaluatePermissions("Bash", { command: "ls" }, config).behavior).toBe("allow");
	});
});

describe("Bash rules on a line that chains commands", () => {
	const config = (behavior: PermissionRule["behavior"], specifier: string, mode: "ask" | "agent") => ({
		mode,
		sandbox: SANDBOX,
		rules: parseRuleList([`Bash(${specifier})`], behavior, "projectSettings"),
		cwd: CWD,
	});
	const run = (command: string, cfg: ReturnType<typeof config>) =>
		evaluatePermissions("Bash", { command }, cfg).behavior;

	test.each([
		"echo hi && git push origin main",
		"cd sub; git push origin main",
		"git status | git push origin main",
		"git fetch 2>&1 && git push origin main",
	])("a deny rule for a command refuses %s", (command) => {
		expect(run(command, config("deny", "git push *", "agent"))).toBe("deny");
	});

	test("an ask rule for a command asks when the command is chained behind another", () => {
		const cfg = config("ask", "git commit *", "agent");
		expect(run("git commit -m x", cfg)).toBe("ask");
		expect(run("git add -A && git commit -m x", cfg)).toBe("ask");
		expect(run("git add -A && git status", cfg)).toBe("allow");
	});

	test("an allow rule covers a chained line only when it covers every command in it", () => {
		const cfg = config("allow", "git status*", "ask");
		expect(run("git status", cfg)).toBe("allow");
		expect(run("git status && git status -s", cfg)).toBe("allow");
		// What the prefix used to buy: anything after the first command.
		expect(run("git status; curl https://example.test/x -o x", cfg)).toBe("ask");
		expect(run("git status && echo done > notes.txt", cfg)).toBe("ask");
	});

	test("a specifier that is itself a chain still allows exactly that line", () => {
		const cfg = config("allow", "git status && git log", "ask");
		expect(run("git status && git log", cfg)).toBe("allow");
		expect(run("git status", cfg)).toBe("ask");
	});

	test("a single command is matched as it always was, redirections included", () => {
		const allow = config("allow", "npm test*", "ask");
		expect(run("npm test", allow)).toBe("allow");
		// The `&` in `2>&1` and `&>` is a redirection, not a second command.
		expect(run("npm test 2>&1", allow)).toBe("allow");
		expect(run("npm test &> out.log", allow)).toBe("allow");
		expect(run("npm test 2>&1 | tail -5", allow)).toBe("ask");

		const deny = config("deny", "git push *", "agent");
		expect(run("git push origin main", deny)).toBe("deny");
		expect(run("git status", deny)).toBe("allow");
		expect(run("git status 2>&1", deny)).toBe("allow");
	});
});

describe("a path rule reaches the other tools that open the same files", () => {
	const config = (behavior: PermissionRule["behavior"], rule: string, mode: "ask" | "agent" = "agent") => ({
		mode,
		sandbox: SANDBOX,
		rules: parseRuleList([rule], behavior, "projectSettings"),
		cwd: CWD,
	});
	const verdict = (tool: string, input: unknown, cfg: ReturnType<typeof config>) =>
		evaluatePermissions(tool, input, cfg).behavior;

	test("a Read deny holds the search, listing and inspect tools on the denied path", () => {
		const cfg = config("deny", "Read(secret/**)");
		expect(verdict("Read", { file_path: "secret/key" }, cfg)).toBe("deny");
		expect(verdict("Grep", { pattern: "x", path: "secret/key" }, cfg)).toBe("deny");
		// A directory is named by the rule's tree, not by any one file in it.
		expect(verdict("Grep", { pattern: "x", path: "secret" }, cfg)).toBe("deny");
		expect(verdict("Glob", { pattern: "**/*", path: "secret" }, cfg)).toBe("deny");
		expect(verdict("LS", { path: "secret" }, cfg)).toBe("deny");
		expect(verdict("Digest", { paths: ["public/a", "secret/key"] }, cfg)).toBe("deny");
		expect(verdict("InspectBinary", { path: "secret/key" }, cfg)).toBe("deny");
		expect(verdict("InspectSqlite", { path: "secret/db.sqlite" }, cfg)).toBe("deny");
		expect(verdict("CompareArtifacts", { left: "public/a", right: "secret/key" }, cfg)).toBe("deny");
		expect(verdict("InspectWebCapture", { path: "secret/session.har" }, cfg)).toBe("deny");
	});

	test("the controls: another path, a tool that reads nothing, a rule for a different file", () => {
		const cfg = config("deny", "Read(secret/**)");
		expect(verdict("Grep", { pattern: "x", path: "public" }, cfg)).toBe("allow");
		expect(verdict("Grep", { pattern: "x" }, cfg)).toBe("allow");
		expect(verdict("Digest", { paths: ["public/a"] }, cfg)).toBe("allow");
		expect(verdict("TaskList", { path: "secret/key" }, cfg)).toBe("allow");
		expect(verdict("Grep", { pattern: "x", path: ".env" }, cfg)).toBe("allow");
		expect(verdict("Grep", { pattern: "x", path: ".env" }, config("deny", "Read(.env)"))).toBe("deny");
	});

	test("an ask rule asks for the same tools", () => {
		const cfg = config("ask", "Read(.env)");
		expect(verdict("Grep", { pattern: "x", path: ".env" }, cfg)).toBe("ask");
		expect(verdict("Grep", { pattern: "x", path: "src" }, cfg)).toBe("allow");
	});

	test("an Edit, Write or NotebookEdit deny holds the other two", () => {
		for (const rule of ["Edit(src/**)", "Write(src/**)", "NotebookEdit(src/**)"]) {
			const cfg = config("deny", rule);
			expect(verdict("Edit", { file_path: "src/a.ts" }, cfg)).toBe("deny");
			expect(verdict("Write", { file_path: "src/a.ts", content: "" }, cfg)).toBe("deny");
			expect(verdict("NotebookEdit", { notebook_path: "src/a.ipynb" }, cfg)).toBe("deny");
			expect(verdict("Write", { file_path: "lib/a.ts", content: "" }, cfg)).toBe("allow");
		}
		// A write rule is not a read rule.
		expect(verdict("Read", { file_path: "src/a.ts" }, config("deny", "Edit(src/**)"))).toBe("allow");
		expect(verdict("Grep", { pattern: "x", path: "src/a.ts" }, config("deny", "Edit(src/**)"))).toBe("allow");
	});

	test("an allow rule is not widened across tools", () => {
		// `ask` mode: the rule matching gives `allow`, and nothing deciding gives `ask`, so the two
		// outcomes differ and the control can fail.
		const read = config("allow", "Read(public/**)", "ask");
		expect(verdict("Read", { file_path: "public/a" }, read)).toBe("allow");
		expect(verdict("Grep", { pattern: "x", path: "public/a" }, read)).toBe("ask");
		const edit = config("allow", "Edit(src/**)", "ask");
		expect(verdict("Edit", { file_path: "src/a.ts" }, edit)).toBe("allow");
		expect(verdict("Write", { file_path: "src/a.ts", content: "" }, edit)).toBe("ask");
	});
});
