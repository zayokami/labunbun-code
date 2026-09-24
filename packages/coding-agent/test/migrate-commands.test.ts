/**
 * What happens to another tool's slash commands.
 *
 * A command is a named prompt, and a skill here is the same thing with a
 * directory around it — so the import is a rewrite of the header, not a
 * translation. The body has to survive byte for byte, because that is the part
 * the user wrote, and anything the source understood but this build does not
 * (`allowed-tools`, `model`, `$1`-`$9`) has to be named in the report rather
 * than left in a file that looks like it honours it.
 *
 * The last block goes the other way: it loads a migrated skill through the real
 * loader and invokes it, because a skill that cannot be expanded is not
 * migrated no matter what the file on disk says.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MigrationPlan, planMigration, readSources, runMigration } from "../src/migrate.ts";
import { loadSkills, skillsAsCommands } from "../src/skills.ts";

type SourceTree = Record<string, string>;

function withHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-commands-"));
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

function plan(tree: SourceTree, only: "claude-code" | "codex" = "claude-code"): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome(tree, (home) => {
		planned = planMigration(readSources(home), {}, { only: [only] });
	});
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/** The skill write whose path ends in this name. */
function written(planned: MigrationPlan, name: string) {
	return planned.writes.find((w) => w.path.endsWith(join("skills", name, "SKILL.md")));
}

/** The one item that names a command file, whatever its action. */
function commandItem(planned: MigrationPlan, file: string) {
	return planned.items.find((i) => i.from.includes(file));
}

describe("slash commands become skills", () => {
	test("the file lands as a skill, with the header rewritten and the body intact", () => {
		const planned = plan({
			".claude/commands/fix-bugs.md": [
				"---",
				"description: Fix a failing test",
				"allowed-tools: Bash(git diff:*)",
				"---",
				"",
				"Fix: $ARGUMENTS",
				"",
			].join("\n"),
		});
		const write = written(planned, "fix-bugs");
		expect(write?.content).toBe("---\nname: fix-bugs\ndescription: Fix a failing test\n---\n\nFix: $ARGUMENTS\n");
		expect(write?.kind).toBe("skill");
		expect(commandItem(planned, "commands/fix-bugs.md")?.action).toBe("map");
	});

	test("what the source understood and this build does not is spelled out", () => {
		const planned = plan({
			".claude/commands/check.md": [
				"---",
				"description: Check something",
				"allowed-tools: Bash",
				"model: opus",
				"argument-hint: <file>",
				"---",
				"Body.",
			].join("\n"),
		});
		const detail = commandItem(planned, "commands/check.md")?.detail ?? "";
		expect(detail).toContain("allowed-tools");
		expect(detail).toContain("model");
		expect(detail).toContain("argument-hint");
		expect(detail).toContain("$ARGUMENTS");
		expect(detail).toContain("$1..$9");
	});

	test("a command with no header at all still gets one", () => {
		const planned = plan({ ".claude/commands/bare.md": "Just do the thing.\n" });
		const write = written(planned, "bare");
		expect(write?.content).toBe("---\nname: bare\n---\nJust do the thing.\n");
		expect(commandItem(planned, "commands/bare.md")?.detail).toContain("no description");
	});

	test("a description written as a block scalar is folded onto one line", () => {
		// A second line under `description:` would otherwise be written back out
		// as a header the loader reads as an empty description — the trigger text
		// would be gone from the skill the model sees.
		const planned = plan({
			".claude/commands/docs.md": [
				"---",
				"description: >-",
				"  Answer questions from the live documentation.",
				"  Use it whenever the answer must be current.",
				"---",
				"Body.",
			].join("\n"),
		});
		expect(written(planned, "docs")?.content).toBe(
			"---\nname: docs\ndescription: Answer questions from the live documentation. " +
				"Use it whenever the answer must be current.\n---\nBody.",
		);
	});

	test("a namespaced command is flattened into its name", () => {
		const planned = plan({ ".claude/commands/review/security.md": "Look for holes.\n" });
		expect(written(planned, "review-security")).toBeDefined();
		expect(commandItem(planned, "commands/review/security.md")?.action).toBe("map");
	});

	test("a README is not a command, and says so", () => {
		const planned = plan({
			".claude/commands/README.md": "How to write a command here.\n",
			".claude/commands/real.md": "Do the thing.\n",
		});
		expect(written(planned, "readme")).toBeUndefined();
		const skip = planned.items.find((i) => i.detail.includes("not imported"));
		expect(skip?.detail).toContain("README.md");
		expect(skip?.detail).toContain("not a command");
	});

	test("a name too long to be a directory here is refused, not truncated", () => {
		const long = "a".repeat(70);
		const planned = plan({ [`.claude/commands/${long}.md`]: "Body.\n" });
		expect(planned.writes.some((w) => w.kind === "skill")).toBe(false);
		expect(planned.items.find((i) => i.detail.includes("not imported"))?.detail).toContain("longer than 64 characters");
	});

	test("a skill of the same name already here is kept", () => {
		withHome(
			{
				".claude/commands/mine.md": "NEW BODY\n",
				".labunbun/skills/mine/SKILL.md": "OLD BODY\n",
			},
			(home) => {
				const planned = planMigration(readSources(home), {}, { only: ["claude-code"] });
				expect(planned.writes.some((w) => w.kind === "skill")).toBe(false);
				expect(commandItem(planned, "commands/mine.md")?.detail).toContain("already exists");
			},
		);
	});

	test("a command colliding with a migrated skill of the same name is reported once", () => {
		const planned = plan({
			".claude/skills/twin/SKILL.md": "FROM THE SKILL\n",
			".claude/commands/twin.md": "FROM THE COMMAND\n",
		});
		const skills = planned.writes.filter((w) => w.path.endsWith(join("skills", "twin", "SKILL.md")));
		expect(skills.length).toBe(1);
		expect(skills[0].content).toContain("FROM THE SKILL");
		expect(commandItem(planned, "commands/twin.md")?.detail).toContain("kept the first one");
	});

	test("commands belong to the assets category, like any other file", () => {
		let planned: MigrationPlan | undefined;
		withHome({ ".claude/commands/one.md": "Body.\n" }, (home) => {
			planned = planMigration(readSources(home), {}, { only: ["claude-code"], categories: ["settings"] });
		});
		expect(planned?.writes.some((w) => w.kind === "skill")).toBe(false);
	});

	test("codex prompts, if that directory ever appears, become skills too", () => {
		const planned = plan({ ".codex/prompts/summarize.md": "Summarize: $ARGUMENTS\n" }, "codex");
		expect(written(planned, "summarize")?.content).toBe("---\nname: summarize\n---\nSummarize: $ARGUMENTS\n");
	});

	test("an applied run leaves the command file byte for byte as it was", () => {
		const content = "---\ndescription: Leave me alone\n---\nBody.\n";
		withHome({ ".claude/commands/keep.md": content }, (home) => {
			runMigration({ home, from: "claude-code", apply: true });
			expect(readFileSync(join(home, ".claude", "commands", "keep.md"), "utf8")).toBe(content);
		});
	});

	test("the imported command is usable: it loads and expands through the real path", () => {
		withHome(
			{
				".claude/commands/fix.md": "---\ndescription: Fix a failure\n---\n\nFix: $ARGUMENTS\n",
			},
			(home) => {
				runMigration({ home, from: "claude-code", apply: true });
				const skills = loadSkills(home, home);
				const skill = skills.find((s) => s.name === "fix");
				expect(skill?.description).toBe("Fix a failure");
				const command = skillsAsCommands(skills).find((c) => c.name === "skill-fix");
				if (command?.type !== "prompt") throw new Error("a migrated command did not become a prompt command");
				expect(command.getPrompt("the flaky login test")).toContain("Fix: the flaky login test");
			},
		);
	});

	test("the shared `~/.agents/commands` tree is imported once, by the source that owns it", () => {
		// ZCode reads `~/.agents/commands` beside its own, and so do the other tools
		// that adopted the convention. One directory imported by two sources is two
		// writes to one path, and the second would be reported as a collision the
		// user never had — so the shared home's own source takes it.
		withHome({ ".agents/commands/ship.md": "---\ndescription: Ship it\n---\nShip $ARGUMENTS.\n" }, (home) => {
			const planned = planMigration(readSources(home), {}, { only: ["zcode", "agents"] });
			const skills = planned.writes.filter((w) => w.path.endsWith(join("skills", "ship", "SKILL.md")));
			expect(skills.length).toBe(1);
			expect(skills[0]?.content).toBe("---\nname: ship\ndescription: Ship it\n---\nShip $ARGUMENTS.\n");
			expect(planned.items.filter((i) => i.from.includes(".agents/commands/ship.md")).map((i) => i.source)).toEqual([
				"agents",
			]);
		});
	});
});

describe("$ARGUMENTS in a skill body", () => {
	function promptFor(body: string, args: string): string {
		const command = skillsAsCommands([
			{ name: "demo", description: "d", body, sourcePath: "~/.labunbun/skills/demo/SKILL.md" },
		])[0];
		if (command.type !== "prompt") throw new Error("skills are prompt commands");
		return command.getPrompt(args);
	}

	test("a body that names its arguments gets them in place, and not a second helping", () => {
		const expanded = promptFor("Fix: $ARGUMENTS", "the build");
		expect(expanded).toContain("Fix: the build");
		expect(expanded.split("the build").length - 1).toBe(1);
	});

	test("every placeholder in the body is filled", () => {
		expect(promptFor("Use $ARGUMENTS here, then $ARGUMENTS again", "x")).toContain("Use x here, then x again");
	});

	test("a body with no placeholder is untouched, and the arguments still arrive", () => {
		// Byte for byte what this built before: the tail is how a skill that never
		// mentions its arguments has always received them.
		expect(promptFor("Deploy the checklist.", "to staging")).toBe(
			'<skill name="demo" source="~/.labunbun/skills/demo/SKILL.md">\nDeploy the checklist.\n</skill>\n\nto staging',
		);
	});

	test("a placeholder with nothing typed leaves the sentence, not the word", () => {
		// `/skill-fix` with no arguments: the body is what the user wrote bar the
		// placeholder itself, rather than the literal text `$ARGUMENTS`.
		expect(promptFor("Fix: $ARGUMENTS", "")).toBe(
			'<skill name="demo" source="~/.labunbun/skills/demo/SKILL.md">\nFix: \n</skill>',
		);
	});
});
