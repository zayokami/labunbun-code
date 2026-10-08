/**
 * The skill loader, directly.
 *
 * Nothing in this package tested `skills.ts` itself before: the freshness test
 * reads the repo's skills as text, and the dispatch tests hand-build a Skill
 * literal and skip loading altogether. The loader therefore had no witness for
 * the two things this batch added to it, and both of them are repo-controlled
 * strings in a prompt position, which is the class of bug that is invisible
 * until someone clones a repository and the model starts being told things
 * nobody approved:
 *
 * 1. **Name validation.** A skill's `name` and `description` are the metadata
 *    the model matches requests against, so they reach the system prompt of
 *    every session in which the folder loads. A folder named `Foo` or one
 *    whose frontmatter disagrees with its directory is held back and *named*
 *    — a silent skip is the failure mode that matters, because the author
 *    believes it loaded.
 * 2. **The discovery budget.** The block is the public good the skills share
 *    with the system prompt, so the order in which it gives ground (shorten
 *    every description first, then drop from the end, then say how many) is
 *    the contract, not an implementation detail.
 *
 * The bool tests also pin a deliberate asymmetry: an unparseable
 * `disable-model-invocation` value counts as *set*, because the expensive
 * direction to be wrong in is a skill reaching prompts its author did not
 * intend, not one staying hidden.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveProjectDefinitions } from "../src/project-trust.ts";
import {
	loadSkills,
	loadSkillsWithNotes,
	parseFrontmatter,
	SKILL_DISCOVERY_BUDGET_CHARS,
	type Skill,
	skillDiscoveryBlock,
	skillDiscoveryBudgetChars,
} from "../src/skills.ts";

type Tree = Record<string, string>;

function writeTree(root: string, tree: Tree): void {
	for (const [path, content] of Object.entries(tree)) {
		const full = join(root, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

function skillFile(frontmatter: string, body = "Do the thing."): string {
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

function skill(partial: Partial<Skill> & Pick<Skill, "name">): Skill {
	return {
		description: "",
		body: "Body.",
		sourcePath: `/tmp/${partial.name}/SKILL.md`,
		disableModelInvocation: false,
		...partial,
	};
}

function tmpRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("the discovery block", () => {
	test("a skill costs one line until it is invoked", () => {
		const block = skillDiscoveryBlock([skill({ name: "fix-ci", description: "Diagnose and fix a failing CI run." })]);
		expect(block).toContain("- fix-ci — Diagnose and fix a failing CI run.");
		expect(block).not.toContain("Body.");
		expect(block.startsWith("# Skills")).toBe(true);
	});

	test("a command-only skill is absent from the block, and others are not", () => {
		const block = skillDiscoveryBlock([
			skill({ name: "internal", description: "Not for the model.", disableModelInvocation: true }),
			skill({ name: "fix-ci", description: "Diagnose and fix a failing CI run." }),
		]);
		expect(block).toContain("fix-ci");
		expect(block).not.toContain("internal");
	});

	test("descriptions shorten before skills drop", () => {
		const alpha = skill({
			name: "alpha",
			description: "Does the first thing well. It also does a second thing nobody needs.",
		});
		const beta = skill({
			name: "beta",
			description: "Does the second thing well. And a third thing nobody needs either.",
		});
		const block = skillDiscoveryBlock([alpha, beta], 200);
		expect(block).toContain("- alpha — Does the first thing well.");
		expect(block).toContain("- beta — Does the second thing well.");
		expect(block).not.toContain("nobody needs");
		expect(block.length).toBeLessThanOrEqual(200);
	});

	test("what still does not fit drops from the end, and says how many", () => {
		const skills = Array.from({ length: 40 }, (_, index) =>
			skill({ name: `s${String(index).padStart(2, "0")}`, description: `${"x".repeat(40)} number ${index}` }),
		);
		const block = skillDiscoveryBlock(skills, 300);
		expect(block).toContain("- s00");
		expect(block).not.toContain("- s39");
		const listed = block.split("\n").filter((line) => line.startsWith("- ") && !line.includes("not listed")).length;
		const note = block.split("\n").find((line) => line.includes("not listed"));
		expect(note).toBeDefined();
		expect(note).toContain(`and ${40 - listed} more skill`);
		expect(listed).toBeGreaterThan(0);
		expect(block.length).toBeLessThanOrEqual(300);
	});

	test("the last resort before dropping is the name alone", () => {
		// One skill with a paragraph for a description must not empty the list:
		// the model has to know it exists to invoke it, and `- name` is what
		// that costs.
		const block = skillDiscoveryBlock(
			[skill({ name: "wordy", description: `${"A very long description ".repeat(20)}. The rest nobody needs.` })],
			200,
		);
		expect(block).toContain("- wordy");
		expect(block).not.toContain("A very long description");
		expect(block).not.toContain("not listed");
	});

	test("the budget is 8000 characters when the window is unknown", () => {
		expect(SKILL_DISCOVERY_BUDGET_CHARS).toBe(8000);
		expect(skillDiscoveryBudgetChars()).toBe(8000);
		expect(skillDiscoveryBudgetChars(0)).toBe(8000);
		expect(skillDiscoveryBudgetChars(200_000)).toBe(8000);
		expect(skillDiscoveryBudgetChars(1_000)).toBe(80);
	});

	test("no invocable skill produces no block at all", () => {
		expect(skillDiscoveryBlock([])).toBe("");
		expect(skillDiscoveryBlock([skill({ name: "x", disableModelInvocation: true })])).toBe("");
	});
});

describe("what the loader holds back, and says so", () => {
	function loadIn(tree: Tree): { skills: Skill[]; notes: string[] } {
		const home = tmpRoot("lbb-skills-home-");
		const cwd = tmpRoot("lbb-skills-cwd-");
		try {
			writeTree(home, tree);
			writeTree(cwd, { ".labunbun/skills/.keep": "" });
			return loadSkillsWithNotes(cwd, home);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	}

	test("a well-named folder loads", () => {
		const { skills, notes } = loadIn({ ".labunbun/skills/fix-ci/SKILL.md": skillFile("name: fix-ci\ndescription: d") });
		expect(notes).toEqual([]);
		expect(skills.map((found) => found.name)).toEqual(["fix-ci"]);
		expect(skills[0].body).toBe("Do the thing.");
	});

	test("a name outside the shared rules is held back and named", () => {
		for (const dir of ["Fix_CI", "a--b", "-lead", "trail-"]) {
			const { skills, notes } = loadIn({ [`.labunbun/skills/${dir}/SKILL.md`]: skillFile("description: d") });
			expect(skills).toEqual([]);
			expect(notes).toEqual([`skill "${dir}" not loaded: name must be lowercase letters, digits and single hyphens`]);
		}
		const long = "x".repeat(65);
		const { skills, notes } = loadIn({ [`.labunbun/skills/${long}/SKILL.md`]: skillFile("description: d") });
		expect(skills).toEqual([]);
		expect(notes).toEqual([`skill "${long}" not loaded: name is longer than 64 characters`]);
	});

	test("a frontmatter name that disagrees with the directory is held back", () => {
		const { skills, notes } = loadIn({
			".labunbun/skills/fix-ci/SKILL.md": skillFile("name: fix-cix\ndescription: d"),
		});
		expect(skills).toEqual([]);
		expect(notes).toEqual([`skill "fix-ci" not loaded: frontmatter name "fix-cix" must match the directory name`]);
	});

	test("a description past the shared cap is held back", () => {
		const { skills, notes } = loadIn({
			".labunbun/skills/wordy/SKILL.md": skillFile(`description: ${"d".repeat(1025)}`),
		});
		expect(skills).toEqual([]);
		expect(notes).toEqual(['skill "wordy" not loaded: description is longer than 1024 characters']);
	});

	test("disable-model-invocation parses, and an unreadable value counts as set", () => {
		const tree: Tree = {
			".labunbun/skills/off/SKILL.md": skillFile("description: d\ndisable-model-invocation: true"),
			".labunbun/skills/on/SKILL.md": skillFile("description: d\ndisable-model-invocation: false"),
			".labunbun/skills/odd/SKILL.md": skillFile("description: d\ndisable-model-invocation: maybe?"),
			".labunbun/skills/plain/SKILL.md": skillFile("description: d"),
		};
		const { skills, notes } = loadIn(tree);
		expect(notes).toEqual([]);
		const byName = new Map(skills.map((found) => [found.name, found]));
		expect(byName.get("off")?.disableModelInvocation).toBe(true);
		expect(byName.get("on")?.disableModelInvocation).toBe(false);
		expect(byName.get("odd")?.disableModelInvocation).toBe(true);
		expect(byName.get("plain")?.disableModelInvocation).toBe(false);
	});
});

describe("tiers", () => {
	function tierTree(): { home: string; cwd: string } {
		const home = tmpRoot("lbb-skills-tier-home-");
		const cwd = tmpRoot("lbb-skills-tier-cwd-");
		writeTree(home, {
			".labunbun/skills/shared/SKILL.md": skillFile("description: The user tier one."),
			".labunbun/skills/user-only/SKILL.md": skillFile("description: From the user tier."),
		});
		writeTree(cwd, {
			".labunbun/skills/shared/SKILL.md": skillFile("description: The project tier one."),
			".labunbun/skills/project-only/SKILL.md": skillFile("description: From the project tier."),
		});
		return { home, cwd };
	}

	test("a trusted project tier overrides the user tier on a name collision", () => {
		const { home, cwd } = tierTree();
		try {
			approveProjectDefinitions(cwd, ["skills"], home);
			const loaded = loadSkills(cwd, home);
			expect(loaded.map((found) => found.name).sort()).toEqual(["project-only", "shared", "user-only"]);
			expect(loaded.find((found) => found.name === "shared")?.description).toBe("The project tier one.");
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("an untrusted project tier is not loaded at all", () => {
		const { home, cwd } = tierTree();
		try {
			const loaded = loadSkills(cwd, home);
			expect(loaded.map((found) => found.name).sort()).toEqual(["shared", "user-only"]);
			expect(loaded.find((found) => found.name === "shared")?.description).toBe("The user tier one.");
			// And the held-back project folders produce no notes either: the
			// withheld notice counts them, and reporting them twice would make
			// both numbers wrong.
			expect(loadSkillsWithNotes(cwd, home).notes).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("parseFrontmatter", () => {
	test("a block-scalar description keeps the words under the marker", () => {
		const { data, body } = parseFrontmatter(
			"---\nname: x\ndescription: >-\n  One folded line\n  continues here.\n---\n\nBody text.\n",
		);
		expect(data.description).toBe("One folded line continues here.");
		expect(body.trim()).toBe("Body text.");
	});

	test("a literal block scalar keeps its line breaks", () => {
		const { data } = parseFrontmatter("---\ndescription: |\n  line one\n  line two\n---\n");
		expect(data.description).toBe("line one\nline two");
	});

	test("no frontmatter at all leaves the content as the body", () => {
		const { data, body } = parseFrontmatter("Just a body.\n");
		expect(data).toEqual({});
		expect(body).toBe("Just a body.\n");
	});
});
