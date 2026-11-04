/**
 * The skills that ship inside the binary.
 *
 * A one-file release has no sibling directory to read, so the skills are
 * embedded at build time and written to a versioned cache under
 * `~/.labunbun/bundled-skills/<version>/` the first time a session asks for
 * them. Three things are worth pinning, and each one has a failure mode that
 * looks fine in source:
 *
 * 1. **The generated import list is current.** A skill added to
 *    `.labunbun/skills` without rerunning the generator is invisible in the
 *    release while working perfectly in this checkout, because the project tier
 *    reads the directory directly.
 * 2. **The files land where the loader can read them.** A SKILL.md without its
 *    `references/` is a skill whose body tells the model to open files that are
 *    not there.
 * 3. **Precedence.** The built-in is the tier the user cannot delete, so a user
 *    skill with the same name must replace it rather than sit underneath it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBundledSkillsModule } from "../../../scripts/bundle-skills.ts";
import { bundledSkillsRoot, materializeBundledSkills } from "../src/bundled-skills.ts";
import { loadSkills, loadSkillsWithNotes } from "../src/skills.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const GENERATED = join(REPO, "packages", "coding-agent", "src", "bundled-skills.generated.ts");

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "labunbun-bundled-"));
}

function writeSkill(root: string, name: string, body: string): void {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`);
}

describe("the generated module", () => {
	test("matches the skills tree", () => {
		// A stale module is the one failure that passes every behavioural test in
		// this file and still ships the wrong list.
		expect(readFileSync(GENERATED, "utf8")).toBe(renderBundledSkillsModule(REPO));
	});
});

describe("materializing the built-in skills", () => {
	test("writes SKILL.md and its references under the versioned root", () => {
		const home = tempHome();
		try {
			const result = materializeBundledSkills(home);
			const root = result.root;
			if (root === null) throw new Error(`built-in skills were not written: ${result.note ?? "no note"}`);
			expect(root).toBe(bundledSkillsRoot(home));
			expect(readFileSync(join(root, "code-review", "SKILL.md"), "utf8")).toContain("name: code-review");
			// The investigation skill is the one whose body depends on a sibling
			// directory; a skill file alone would be a promise with no files behind it.
			expect(existsSync(join(root, "artifact-investigation", "references", "evidence-ledger.md"))).toBe(true);
			expect(existsSync(join(root, ".manifest"))).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a second call reuses the materialized copy", () => {
		const home = tempHome();
		try {
			const first = materializeBundledSkills(home);
			const second = materializeBundledSkills(home);
			expect(second.root).toBe(first.root);
			expect(second.note).toBeUndefined();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("bundled skills in the loader", () => {
	test("the product option adds them; the plain loader does not", () => {
		const home = tempHome();
		const cwd = mkdtempSync(join(tmpdir(), "labunbun-cwd-"));
		try {
			expect(loadSkills(cwd, home).map((skill) => skill.name)).toEqual([]);

			const loaded = loadSkillsWithNotes(cwd, home, { bundled: true });
			const names = loaded.skills.map((skill) => skill.name);
			expect(names).toContain("code-review");
			expect(names).toContain("artifact-investigation");
			// The sourcePath is the materialized copy, not the embedded `B:/~BUN`
			// path: the Skill tool hands this string to the model, and a reference
			// beside the skill has to be openable from it.
			const review = loaded.skills.find((skill) => skill.name === "code-review");
			expect(review?.sourcePath.startsWith(bundledSkillsRoot(home))).toBe(true);
			expect(loaded.notes).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a user skill with the same name replaces the built-in one", () => {
		const home = tempHome();
		const cwd = mkdtempSync(join(tmpdir(), "labunbun-cwd-"));
		try {
			writeSkill(join(home, ".labunbun", "skills"), "code-review", "USER-COPY");
			const loaded = loadSkillsWithNotes(cwd, home, { bundled: true });
			const review = loaded.skills.find((skill) => skill.name === "code-review");
			expect(review?.body.trim()).toBe("USER-COPY");
			// And the rest of the built-ins are still there: the precedence is per
			// name, not an all-or-nothing switch.
			expect(loaded.skills.map((skill) => skill.name)).toContain("commit");
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
