/**
 * The `.gitignore` subset at the unit level — one rule per test, named by the
 * rule, so a failure says which rule broke rather than which fixture drifted.
 * The end-to-end story (a real tree through the real Grep and Glob tools) is
 * in `tools.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { isIgnored, parseGitignore } from "../src/ignore.ts";

function set(base: string, lines: string[]) {
	return { base, rules: parseGitignore(lines.join("\n")) };
}

describe("parseGitignore", () => {
	test("comments, blank lines and markers with nothing behind them are dropped", () => {
		const rules = parseGitignore("# comment\n\n!\n/\n!/\nkeep me \n");
		expect(rules).toHaveLength(1);
		// Trailing spaces are part of the pattern — nothing here trims, because
		// a trim would make `foo ` and `foo` the same rule and git says they are
		// not.
		expect(rules[0]).toMatchObject({ negated: false, dirOnly: false, pathType: false, pattern: "keep me " });
	});

	test("each marker is read: !, trailing /, leading /, an inner slash", () => {
		const rules = parseGitignore("!keep.log\nbuild/\n/root.txt\nsrc/gen\nplain\n");
		expect(rules.map((rule) => [rule.negated, rule.dirOnly, rule.pathType, rule.pattern])).toEqual([
			[true, false, false, "keep.log"],
			[false, true, false, "build"],
			[false, false, true, "root.txt"],
			[false, false, true, "src/gen"],
			[false, false, false, "plain"],
		]);
	});

	test("a CRLF .gitignore parses the same as an LF one", () => {
		expect(parseGitignore("*.log\r\n!keep.log\r\n")).toEqual(parseGitignore("*.log\n!keep.log\n"));
	});
});

describe("isIgnored", () => {
	test("a name pattern matches at any depth, and only by name", () => {
		const chain = [set("/repo", ["*.log"])];
		expect(isIgnored(chain, "/repo/a.log", false)).toBe(true);
		expect(isIgnored(chain, "/repo/sub/b.log", false)).toBe(true);
		expect(isIgnored(chain, "/repo/a.txt", false)).toBe(false);
		// The star spans the name, not the path.
		expect(isIgnored(chain, "/repo/sub/a.log.txt", false)).toBe(false);
	});

	test("a directory-only rule does not touch a file of the same name", () => {
		const chain = [set("/repo", ["cached/"])];
		expect(isIgnored(chain, "/repo/cached", true)).toBe(true);
		expect(isIgnored(chain, "/repo/cached", false)).toBe(false);
		expect(isIgnored(chain, "/repo/sub/cached", true)).toBe(true);
	});

	test("a leading slash anchors to the .gitignore's own directory", () => {
		const chain = [set("/repo", ["/root-only.txt"])];
		expect(isIgnored(chain, "/repo/root-only.txt", false)).toBe(true);
		expect(isIgnored(chain, "/repo/sub/root-only.txt", false)).toBe(false);
	});

	test("an inner slash anchors too, and segments match whole", () => {
		const chain = [set("/repo", ["src/gen"])];
		expect(isIgnored(chain, "/repo/src/gen", true)).toBe(true);
		expect(isIgnored(chain, "/repo/src/gen.txt", false)).toBe(false);
		expect(isIgnored(chain, "/repo/sub/src/gen", true)).toBe(false);
	});

	test("the last matching rule wins, so a negation re-includes", () => {
		const chain = [set("/repo", ["*.log", "!keep.log"])];
		expect(isIgnored(chain, "/repo/keep.log", false)).toBe(false);
		expect(isIgnored(chain, "/repo/other.log", false)).toBe(true);
	});

	test("a deeper set is evaluated later and overrides the ones above", () => {
		const chain = [set("/repo", ["*.tmp", "only-here.txt"]), set("/repo/sub", ["!wanted.tmp"])];
		expect(isIgnored(chain, "/repo/sub/wanted.tmp", false)).toBe(false); // re-included from below
		expect(isIgnored(chain, "/repo/sub/other.tmp", false)).toBe(true); // still ignored from above
		expect(isIgnored(chain, "/repo/sub/only-here.txt", false)).toBe(true); // added from above
		expect(isIgnored(chain, "/repo/only-here.txt", false)).toBe(true);
	});

	test("a set only judges paths under its own directory", () => {
		const chain = [set("/repo/sub", ["*.txt"])];
		expect(isIgnored(chain, "/repo/other.txt", false)).toBe(false);
		expect(isIgnored(chain, "/repo/sub/x.txt", false)).toBe(true);
	});

	test("matching is case-sensitive", () => {
		const chain = [set("/repo", ["*.log"])];
		expect(isIgnored(chain, "/repo/A.LOG", false)).toBe(false);
	});
});
