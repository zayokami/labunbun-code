/**
 * What the approval dialog offers, and how wide each answer really is.
 *
 * "Don't ask again" used to grant the whole tool: approving `git status` allowed
 * every later Bash call for the rest of the session. The fix is a specifier
 * scoped to what the user was actually looking at, which means the label and the
 * specifier have to agree — a label promising `git ` while the rule grants `*`
 * would be worse than the vague wording it replaced. That agreement is what
 * these tests check.
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { alwaysAllowLabel, permissionOptions, ruleSpecifierFor } from "../src/permission-options.ts";

/**
 * A workspace root in the spelling *this* platform resolves. A literal
 * `C:\work\proj` is not a Windows path that happens to be written with
 * backslashes — on POSIX it is one filename, backslashes included, and
 * `resolve` hands it back under the cwd. So the root, and every path below
 * that is supposed to sit inside it, are built from the platform's own
 * `join`/`resolve` and the assertions are about the rule rather than about
 * which separators this machine happens to use.
 */
const CWD = process.platform === "win32" ? "C:/work/proj" : "/work/proj";

describe("ruleSpecifierFor", () => {
	test("a command becomes a prefix rule, never a glob that swallows its siblings", () => {
		expect(ruleSpecifierFor("Bash", { command: "git status" }, CWD)).toBe("git *");
		expect(ruleSpecifierFor("Bash", { command: "  git   status  " }, CWD)).toBe("git *");
		// `git*` would also cover `gitk`; the space is what makes it a word.
		expect(ruleSpecifierFor("Bash", { command: "git" }, CWD)).toBe("git");
	});

	test("a file becomes the directory it lives in", () => {
		expect(ruleSpecifierFor("Edit", { file_path: "src/tui/app.tsx" }, CWD)).toBe("src/tui/**");
		// The absolute spelling a tool call carries, which has to land on the
		// same specifier as the relative one.
		expect(ruleSpecifierFor("Read", { file_path: join(CWD, "src", "a.ts") }, CWD)).toBe("src/**");
	});

	test("nothing to scope to falls back to the bare tool", () => {
		// A file at the workspace root has no directory; a path outside the
		// workspace has one that would be a lie.
		expect(ruleSpecifierFor("Edit", { file_path: "notes.md" }, CWD)).toBeUndefined();
		expect(ruleSpecifierFor("Edit", { file_path: resolve(CWD, "..", "other", "a.ts") }, CWD)).toBeUndefined();
		expect(ruleSpecifierFor("Edit", { file_path: "src/a.ts" }, undefined)).toBeUndefined();
		expect(ruleSpecifierFor("Bash", { command: "   " }, CWD)).toBeUndefined();
		expect(ruleSpecifierFor("WebFetch", { url: "https://example.com" }, CWD)).toBeUndefined();
		expect(ruleSpecifierFor("Bash", null, CWD)).toBeUndefined();
	});
});

describe("alwaysAllowLabel", () => {
	test("names the scope the specifier grants", () => {
		expect(alwaysAllowLabel("Bash", { command: "git status" }, CWD)).toBe(
			"Yes, and don't ask again for commands starting with `git ` (this session)",
		);
		expect(alwaysAllowLabel("Bash", { command: "make" }, CWD)).toBe(
			"Yes, and don't ask again for `make` (this session)",
		);
		expect(alwaysAllowLabel("Edit", { file_path: "src/a.ts" }, CWD)).toBe(
			"Yes, and don't ask again for files under `src/` (this session)",
		);
	});

	test("says the session, because the rule is not written to any file", () => {
		for (const label of [
			alwaysAllowLabel("Bash", { command: "git status" }, CWD),
			alwaysAllowLabel("Edit", { file_path: "src/a.ts" }, CWD),
			alwaysAllowLabel("WebFetch", { url: "u" }, CWD),
		]) {
			expect(label).toContain("(this session)");
		}
	});

	test("an unscoped tool says the tool by name", () => {
		expect(alwaysAllowLabel("WebFetch", { url: "u" }, CWD)).toBe(
			"Yes, and don't ask again for WebFetch (this session)",
		);
	});
});

describe("permissionOptions", () => {
	test("three answers, ordered once / always / no", () => {
		const options = permissionOptions("Bash", { command: "git status" }, CWD);
		expect(options).toHaveLength(3);
		expect(options[0]).toEqual({ label: "Yes, just this once", allow: true, alwaysAllow: false });
		expect(options[1].label).toBe(alwaysAllowLabel("Bash", { command: "git status" }, CWD));
		expect(options[1].allow).toBe(true);
		expect(options[1].alwaysAllow).toBe(true);
		expect(options[2].allow).toBe(false);
		expect(options[2].alwaysAllow).toBe(false);
		expect(options[2].label).toContain("tell the model");
	});
});
