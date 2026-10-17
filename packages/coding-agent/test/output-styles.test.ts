/**
 * Output styles: where they load from, and which one wins.
 *
 * Two tiers, one gate. The user tier (`~/.labunbun/output-styles`) always
 * loads; the project tier loads only after the directory is trusted, the same
 * one-time decision agents, skills and memory sit behind — a repository that
 * could ship a style and have it active at session start would be writing a
 * prompt section the user never saw. On a name collision the project wins,
 * which is what makes a project style useful at all; the merge is by name, the
 * same shape skills use.
 *
 * `settings.outputStyle` selects *one* of the loaded styles. The loader does
 * not read the setting and the resolver does not read files — splitting it that
 * way is what makes the unresolved-name case a property the resolver can be
 * tested for on its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOutputStyles, resolveOutputStyle, withheldProjectOutputStyles } from "../src/output-styles.ts";
import { approveProjectDefinitions } from "../src/project-trust.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** Plant `<dir>/<name>.md`, creating the directory. */
function plantStyle(dir: string, name: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), content, "utf8");
}

describe("loadOutputStyles", () => {
	test("user styles load from any cwd, no trust needed", () => {
		const home = tempDir("lbb-styles-home-");
		const cwd = tempDir("lbb-styles-cwd-");
		plantStyle(join(home, ".labunbun", "output-styles"), "concise", "USER-CONCISE");

		const styles = loadOutputStyles(cwd, home);
		expect(styles.map((style) => style.name)).toEqual(["concise"]);
		expect(styles[0]?.content).toBe("USER-CONCISE");
		expect(styles[0]?.source).toBe("user");
	});

	test("project styles stay out until the directory is trusted", () => {
		const home = tempDir("lbb-styles2-home-");
		const cwd = tempDir("lbb-styles2-cwd-");
		plantStyle(join(cwd, ".labunbun", "output-styles"), "loud", "PROJECT-LOUD");

		expect(loadOutputStyles(cwd, home)).toEqual([]);

		approveProjectDefinitions(cwd, ["styles"], home);

		const styles = loadOutputStyles(cwd, home);
		expect(styles.map((style) => style.name)).toEqual(["loud"]);
		expect(styles[0]?.content).toBe("PROJECT-LOUD");
		expect(styles[0]?.source).toBe("project");
	});

	test("approving another kind does not open this one", () => {
		const home = tempDir("lbb-styles3-home-");
		const cwd = tempDir("lbb-styles3-cwd-");
		plantStyle(join(cwd, ".labunbun", "output-styles"), "loud", "PROJECT-LOUD");

		approveProjectDefinitions(cwd, ["memory"], home);

		expect(loadOutputStyles(cwd, home)).toEqual([]);
	});

	test("a project style wins over the user's style of the same name", () => {
		const home = tempDir("lbb-styles4-home-");
		const cwd = tempDir("lbb-styles4-cwd-");
		plantStyle(join(home, ".labunbun", "output-styles"), "concise", "USER-CONCISE");
		plantStyle(join(cwd, ".labunbun", "output-styles"), "concise", "PROJECT-CONCISE");
		plantStyle(join(cwd, ".labunbun", "output-styles"), "extra", "PROJECT-EXTRA");
		approveProjectDefinitions(cwd, ["styles"], home);

		const styles = loadOutputStyles(cwd, home);
		expect(styles.map((style) => style.name).sort()).toEqual(["concise", "extra"]);
		const concise = styles.find((style) => style.name === "concise");
		expect(concise?.content).toBe("PROJECT-CONCISE");
		// The winning row also reports its tier, so a listing can say where the
		// active style came from.
		expect(concise?.source).toBe("project");
	});

	test("only `*.md` files are styles, and the name is the file name minus the extension", () => {
		const home = tempDir("lbb-styles5-home-");
		const cwd = tempDir("lbb-styles5-cwd-");
		plantStyle(join(home, ".labunbun", "output-styles"), "ok", "OK STYLE");
		writeFileSync(join(home, ".labunbun", "output-styles", "notes.txt"), "not a style", "utf8");

		expect(loadOutputStyles(cwd, home).map((style) => style.name)).toEqual(["ok"]);
	});

	test("no directories at all is no styles, not an error", () => {
		const home = tempDir("lbb-styles6-home-");
		const cwd = tempDir("lbb-styles6-cwd-");
		expect(loadOutputStyles(cwd, home)).toEqual([]);
	});
});

describe("withheldProjectOutputStyles", () => {
	test("names the project styles the gate is holding back, without reading them", () => {
		const home = tempDir("lbb-styles7-home-");
		const cwd = tempDir("lbb-styles7-cwd-");
		const dir = join(cwd, ".labunbun", "output-styles");
		plantStyle(dir, "loud", "PROJECT-LOUD");
		plantStyle(dir, "brief", "PROJECT-BRIEF");
		writeFileSync(join(dir, "notes.txt"), "not a style", "utf8");

		expect(withheldProjectOutputStyles(cwd, home)).toEqual([join(dir, "brief.md"), join(dir, "loud.md")]);

		approveProjectDefinitions(cwd, ["styles"], home);
		expect(withheldProjectOutputStyles(cwd, home)).toEqual([]);
	});

	test("another kind's approval does not clear the list", () => {
		const home = tempDir("lbb-styles8-home-");
		const cwd = tempDir("lbb-styles8-cwd-");
		plantStyle(join(cwd, ".labunbun", "output-styles"), "loud", "PROJECT-LOUD");

		approveProjectDefinitions(cwd, ["memory"], home);

		expect(withheldProjectOutputStyles(cwd, home)).toHaveLength(1);
	});

	test("no project directory is no withheld styles", () => {
		const home = tempDir("lbb-styles9-home-");
		const cwd = tempDir("lbb-styles9-cwd-");
		expect(withheldProjectOutputStyles(cwd, home)).toEqual([]);
	});
});

describe("resolveOutputStyle", () => {
	const styles = [
		{ name: "a", content: "A", sourcePath: join("x", "a.md"), source: "user" as const },
		{ name: "b", content: "B", sourcePath: join("x", "b.md"), source: "user" as const },
	];

	test("picks the named style", () => {
		expect(resolveOutputStyle("b", styles)?.content).toBe("B");
	});

	test("an unset or unknown name decides nothing rather than failing", () => {
		// The fail-soft an unknown theme name gets: an unresolved name is a thing
		// `/doctor` can report, not a reason a session refuses to start.
		expect(resolveOutputStyle(undefined, styles)).toBeUndefined();
		expect(resolveOutputStyle("nope", styles)).toBeUndefined();
	});
});
