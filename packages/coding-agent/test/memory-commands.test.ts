import { afterEach, describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { caseInsensitivePaths } from "@labunbun/tools";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { builtInCommands, completeCommands, findCommand } from "../src/commands.ts";
import {
	type AppCommandContext,
	handleAppCommand,
	lastProjectMemoryFile,
	openInEditor,
	shortenHome,
} from "../src/interactive.ts";
import {
	appendMemoryNoteAt,
	buildTruncationNotice,
	expandIncludes,
	loadMemoryFiles,
	selectMemoryContent,
	userMemoryPath,
	userRulesDir,
	withheldProjectMemoryFiles,
} from "../src/memory.ts";
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

	test("an absolute include path is rejected, in this platform's spelling", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mem-abs-"));
		// The same attack either way — a path that names a location outside the
		// root — written the way the platform spells "somewhere else entirely".
		// A UNC share is the Windows form; on POSIX `\\evil-host\share\file.md`
		// is not absolute at all but one relative filename (backslashes included)
		// that genuinely does sit under the root, so asserting on it there would
		// be asserting that a file which does not exist is not found.
		const outside = process.platform === "win32" ? "\\\\evil-host\\share\\file.md" : "/evil-host/share/file.md";
		const expanded = expandIncludes(`@${outside}`, dir);
		expect(expanded).toContain("include outside allowed directory");
	});

	test("includes within nested subdirectories of the root still resolve", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mem-nested-"));
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "sub", "inner.md"), "INNER CONTENT");
		const expanded = expandIncludes("@sub/inner.md", dir);
		expect(expanded).toContain("INNER CONTENT");
	});

	/**
	 * Case folding is a property of the filesystem, not of the string compare.
	 * On a case-sensitive volume `root` and `ROOT` are two directories, and a
	 * path through the second is outside the containment root however similar
	 * it looks. Windows and macOS cannot stage this fixture (there the two
	 * names are one directory), so the case is skipped there and carried by the
	 * Linux CI job.
	 */
	test.skipIf(caseInsensitivePaths)("a case-variant sibling outside the root is rejected", () => {
		const base = mkdtempSync(join(tmpdir(), "lbb-memcase-"));
		const root = join(base, "root");
		const outside = join(base, "ROOT");
		mkdirSync(root, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.md"), "CASE SECRET");

		const expanded = expandIncludes("@../ROOT/secret.md", root);
		expect(expanded).toContain("include outside allowed directory");
		expect(expanded).not.toContain("CASE SECRET");
	});
});

describe("loadMemoryFiles", () => {
	test("nearest LABUNBUN.md wins per level; rules dir included", () => {
		const root = tempDir("lbb-memroot-");
		const project = join(root, "project");
		const sub = join(project, "sub");
		mkdirSync(sub, { recursive: true });
		mkdirSync(join(project, ".labunbun", "rules"), { recursive: true });

		writeFileSync(join(root, "AGENTS.md"), "ROOT LEVEL");
		writeFileSync(join(project, "LABUNBUN.md"), "PROJECT LEVEL");
		writeFileSync(join(project, ".labunbun", "rules", "style.md"), "STYLE RULE");
		writeFileSync(join(sub, "child.txt"), "not memory");
		// The project walk is behind the trust gate; without this the two project
		// files below would be withheld and the test would be asserting the gate,
		// not the walk. The user tier needs no approval.
		approveProjectDefinitions(sub, ["memory"], join(root, "fakehome"));

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

	test("a directory with nothing in it contributes nothing", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-memempty-"));
		const result = loadMemoryFiles(dir, join(dir, "home"));
		// Scoped to the directories this test named, and that is the whole point of
		// the rewrite: it used to assert `result.files` was empty, which is only true
		// on a machine with no memory above the fixture. `loadMemoryFiles` walks cwd
		// to the filesystem root collecting `<dir>/.labunbun` at every level, and
		// `mkdtemp` lives under the user's own directory on Windows — so on any
		// machine that has a `~/.labunbun/rules` the walk collects it, by design (see
		// step 1 of `loadMemoryFiles`), and the old assertion went red for a fact
		// about the machine rather than about the code. There is no fixture placement
		// that avoids it: the walk ends at the drive root.
		//
		// What is left is the claim that actually holds everywhere and is the one
		// worth protecting — a directory with nothing in it yields nothing, and the
		// loader does not invent content to fill the gap. On a machine with nothing
		// above the fixture this is the old assertion, exactly.
		expect(result.files.filter((path) => path.startsWith(dir))).toEqual([]);
		// Still a real reading rather than a vacuous one: whatever the walk did pick
		// up above the fixture, it was not so much of it that the cap engaged.
		expect(result.truncated).toBe(false);
	});

	test("a single oversized file is partial, names itself, and omits nothing", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-memcap-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-memcap2-"));
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "MEMORY.md"), "x".repeat(60_000));

		const result = loadMemoryFiles(cwd, home);
		expect(result.truncated).toBe(true);
		// The cap counts the whole string: separators and the note included.
		expect(result.content.length).toBeLessThanOrEqual(40_000);
		expect(result.content).toContain("source completeness note");
		expect(result.partialFiles).toEqual([userMemoryPath(home)]);
		expect(result.omittedFiles).toEqual([]);
		// Home paths are shown as `~/...`, not as an absolute path.
		expect(result.content).toContain("~/.labunbun/MEMORY.md");
	});

	test("no memory files yields exactly the empty string, with no note", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-memempty2-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-memempty2-cwd-"));
		// The project walk is untrusted with a fresh home, so ancestor fixtures
		// on this machine cannot leak into the answer: the user tier is empty.
		const result = loadMemoryFiles(cwd, home);
		expect(result.content).toBe("");
		expect(result.files).toEqual([]);
		expect(result.truncated).toBe(false);
	});

	test("an untrusted project never appears in the completeness note", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-memgate3-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-memgate3-cwd-"));
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "MEMORY.md"), "x".repeat(60_000));
		writeFileSync(join(cwd, "LABUNBUN.md"), "PROJECT-SECRET");

		const result = loadMemoryFiles(cwd, home);
		expect(result.truncated).toBe(true);
		// The note is built from loaded candidates only; a withheld path stays
		// out of the prompt even as a name.
		expect(result.content).not.toContain("LABUNBUN.md");
		expect(result.content).not.toContain(cwd);
		expect(result.files).not.toContain(join(cwd, "LABUNBUN.md"));
		expect(withheldProjectMemoryFiles(cwd, home)).toContain(join(cwd, "LABUNBUN.md"));
	});
});

/**
 * CLAUDE.md is the third and last spelling of a directory's standing
 * instructions: a checkout imported from a Claude Code setup may have only
 * that file. It is a fallback, not an addition — the three names are
 * alternatives, so exactly one of them is read per level.
 */
describe("the CLAUDE.md fallback", () => {
	/** The four fixtures below share one shape: a throwaway home and cwd. */
	function fixture(prefix: string): { home: string; cwd: string } {
		return { home: tempDir(`${prefix}-home-`), cwd: tempDir(`${prefix}-cwd-`) };
	}

	test("loads when neither LABUNBUN.md nor AGENTS.md exists", () => {
		const { home, cwd } = fixture("lbb-memclaude");
		writeFileSync(join(cwd, "CLAUDE.md"), "CLAUDE-FALLBACK-MARKER\n");
		approveProjectDefinitions(cwd, ["memory"], home);

		const result = loadMemoryFiles(cwd, home);
		expect(result.content).toContain("CLAUDE-FALLBACK-MARKER");
		expect(result.files).toContain(join(cwd, "CLAUDE.md"));
	});

	test("LABUNBUN.md beats CLAUDE.md at the same level", () => {
		const { home, cwd } = fixture("lbb-memclaude-labunbun");
		writeFileSync(join(cwd, "LABUNBUN.md"), "LABUNBUN-WINS\n");
		writeFileSync(join(cwd, "CLAUDE.md"), "CLAUDE-SHOULD-NOT-LOAD\n");
		approveProjectDefinitions(cwd, ["memory"], home);

		const result = loadMemoryFiles(cwd, home);
		expect(result.content).toContain("LABUNBUN-WINS");
		// Never two of the three at one level: the loser is not merely lower, it
		// is absent.
		expect(result.content).not.toContain("CLAUDE-SHOULD-NOT-LOAD");
		expect(result.files).not.toContain(join(cwd, "CLAUDE.md"));
	});

	test("AGENTS.md beats CLAUDE.md at the same level", () => {
		const { home, cwd } = fixture("lbb-memclaude-agents");
		writeFileSync(join(cwd, "AGENTS.md"), "AGENTS-WINS\n");
		writeFileSync(join(cwd, "CLAUDE.md"), "CLAUDE-SHOULD-NOT-LOAD\n");
		approveProjectDefinitions(cwd, ["memory"], home);

		const result = loadMemoryFiles(cwd, home);
		expect(result.content).toContain("AGENTS-WINS");
		expect(result.content).not.toContain("CLAUDE-SHOULD-NOT-LOAD");
		expect(result.files).not.toContain(join(cwd, "CLAUDE.md"));
	});

	test("an untrusted project withholds CLAUDE.md and lists it by path", () => {
		const { home, cwd } = fixture("lbb-memclaude-gate");
		writeFileSync(join(cwd, "CLAUDE.md"), "CLAUDE-PROJECT-SECRET\n");

		// No approval: the whole walk is behind the gate, so the fallback file is
		// neither read into the prompt nor named inside it.
		const result = loadMemoryFiles(cwd, home);
		expect(result.content).not.toContain("CLAUDE-PROJECT-SECRET");
		expect(result.files).not.toContain(join(cwd, "CLAUDE.md"));
		// What an approval would load is still named — by path, contents unread.
		expect(withheldProjectMemoryFiles(cwd, home)).toContain(join(cwd, "CLAUDE.md"));
	});
});

describe("selectMemoryContent", () => {
	test("the separator is charged before the next file, so no empty partial is reported", () => {
		// 5 chars of content, then a 7-char separator leaves exactly 0 for `b`:
		// that is an omitted file, not a partial file with an empty prefix.
		const exact = selectMemoryContent(
			[
				{ path: "a.md", content: "12345" },
				{ path: "b.md", content: "x" },
			],
			12,
		);
		expect(exact.parts.map((part) => part.path)).toEqual(["a.md"]);
		expect(exact.omitted).toEqual(["b.md"]);

		// One more character of budget and the same file is a one-character partial.
		const partial = selectMemoryContent(
			[
				{ path: "a.md", content: "12345" },
				{ path: "b.md", content: "xyz" },
			],
			13,
		);
		expect(partial.parts[1]).toMatchObject({ path: "b.md", content: "x", partial: true });
		expect(partial.omitted).toEqual([]);
	});

	test("a partial file stops the walk; every farther file is omitted", () => {
		const selection = selectMemoryContent(
			[
				{ path: "first.md", content: "0123456789" },
				{ path: "second.md", content: "0123456789" },
				{ path: "third.md", content: "0123456789" },
			],
			18,
		);
		expect(selection.parts).toHaveLength(2);
		expect(selection.parts[1]?.partial).toBe(true);
		expect(selection.omitted).toEqual(["third.md"]);
		expect(selection.length).toBeLessThanOrEqual(18);
	});
});

describe("the completeness note", () => {
	const home = join("users", "me");
	const cwd = join("work", "repo");

	test("names at most eight paths in total and folds the rest into and N more", () => {
		const omitted = Array.from({ length: 12 }, (_, index) => join(cwd, `note-${index}.md`));
		const notice = buildTruncationNotice([], omitted, cwd, home);
		expect(notice.match(/note-\d+\.md/g)).toHaveLength(8);
		expect(notice).toContain("and 4 more");
	});

	test("sanitizes newlines, control characters and brackets, and keeps home/cwd forms", () => {
		const partial = [join(home, ".labunbun", "MEMORY.md")];
		const omitted = [join(cwd, "odd\nname\u0007[evil].md")];
		const notice = buildTruncationNotice(partial, omitted, cwd, home);
		expect(notice).toContain("~/.labunbun/MEMORY.md");
		expect(notice).toContain("odd name (evil).md");
		expect(notice).not.toContain("\n");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is that no control character survived
		expect(/[\u0000-\u001f\u007f-\u009f]/.test(notice)).toBe(false);
	});

	test("is phrased as a source note, not a request to read the files", () => {
		const notice = buildTruncationNotice([], [join(cwd, "AGENTS.md")], cwd, home);
		expect(notice).toContain("source completeness note");
		expect(notice).toContain("not an instruction to read those files");
	});
});

describe("appendMemoryNoteAt", () => {
	test("creates the directory on first use and appends the same bytes each time", () => {
		const home = tempDir("lbb-memnote-");
		appendMemoryNoteAt(home, "first note");
		appendMemoryNoteAt(home, "second note");
		expect(readFileSync(userMemoryPath(home), "utf8")).toBe("- first note\n- second note\n");
	});

	test("refuses a .labunbun path that is not a directory", () => {
		const home = tempDir("lbb-memnote2-");
		writeFileSync(join(home, ".labunbun"), "not a directory");
		expect(() => appendMemoryNoteAt(home, "note")).toThrow(/not a directory/);
	});

	test("the note is visible to the next load, which is what the prompt refresh reads", () => {
		const home = tempDir("lbb-memnote3-");
		const cwd = tempDir("lbb-memnote3-cwd-");
		appendMemoryNoteAt(home, "live note");

		const result = loadMemoryFiles(cwd, home);
		expect(result.content).toContain("- live note");
		expect(result.files).toContain(userMemoryPath(home));
	});

	test("the # shortcut writes through the injected home and refreshes the live prompt", () => {
		// The write core is covered above; this is the wiring the unit tests
		// cannot see — the REPL passes the home the session was given, and the
		// same handler hands a freshly loaded memory block to the live session.
		//
		// A source check is acceptable here: the handler is a closure inside the
		// REPL component, and the pieces it touches (writer, gated loader,
		// session) have no shared runtime object a test could call. Slicing from
		// the handler's option name to the next option keeps the assertions about
		// that handler rather than about the file at large.
		const source = readFileSync(join(import.meta.dir, "..", "src", "interactive.ts"), "utf8");
		expect(source).toContain("appendMemoryNoteAt(home, note)");
		expect(source).not.toContain('join(homedir(), ".labunbun", "MEMORY.md")');

		const start = source.indexOf("onMemoryShortcut:");
		const end = source.indexOf("onCommand:", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const handler = source.slice(start, end);
		const appendAt = handler.indexOf("appendMemoryNoteAt(home, note)");
		const loadAt = handler.indexOf("loadMemoryFiles(cwd, home).content");
		const setAt = handler.indexOf("setSystemPrompt(buildPrompt(");
		const sayAt = handler.indexOf("Remembered:");
		expect(appendAt).toBeGreaterThan(-1);
		// The note is re-read through the same gated loader startup used and put
		// on the live session's prompt before the user is told it was remembered:
		// a note that waits for the next process is not what "Remembered" says.
		expect(loadAt).toBeGreaterThan(appendAt);
		expect(setAt).toBeGreaterThan(loadAt);
		expect(sayAt).toBeGreaterThan(setAt);
	});
});

describe("loadMemoryFiles, continued", () => {
	/**
	 * The budget is allocated nearest-first even though the prompt renders
	 * farthest-first: a root-level guide that does not fit must not evict the
	 * file from the directory the session is actually working in. The rendered
	 * order is unchanged — root before cwd, nearest last — so the check is both
	 * "the near file survived" and "it still comes last".
	 */
	test("a nearest project file keeps its budget when a farther file is oversized", () => {
		const base = tempDir("lbb-memprio-");
		const home = join(base, "home");
		const project = join(base, "project");
		const cwd = join(project, "pkg");
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(home, ".labunbun", "MEMORY.md"), "USER-LAYER");
		writeFileSync(join(project, "AGENTS.md"), `ROOT-BIG-MARKER\n${"R".repeat(50_000)}`);
		writeFileSync(join(cwd, "LABUNBUN.md"), "NEAR-CWD-MARKER");
		approveProjectDefinitions(cwd, ["memory"], home);

		const result = loadMemoryFiles(cwd, home);
		expect(result.content).toContain("NEAR-CWD-MARKER");
		expect(result.files).toContain(join(cwd, "LABUNBUN.md"));
		// Farther file is the one that gives way.
		expect(result.content).toContain("ROOT-BIG-MARKER");
		// Render order is untouched: root first, cwd last.
		expect(result.content.indexOf("ROOT-BIG-MARKER")).toBeLessThan(result.content.indexOf("NEAR-CWD-MARKER"));
		// The cap counts the whole string, separators and notice included.
		expect(result.content.length).toBeLessThanOrEqual(40_000);
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

describe("the memory trust gate", () => {
	test("a project file is withheld until the directory is trusted, and the user tier still loads", () => {
		const home = tempDir("lbb-memgate-home-");
		const cwd = tempDir("lbb-memgate-cwd-");
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "MEMORY.md"), "USER-MEMORY-MARKER\n");
		writeFileSync(join(cwd, "LABUNBUN.md"), "PROJECT-MEMORY-MARKER\n");

		const untrusted = loadMemoryFiles(cwd, home);
		// The two halves have to be read together: the project bytes are absent,
		// and the user's own file — the one the gate never covers — is present.
		// An empty load is also what a broken reader looks like.
		expect(untrusted.content).not.toContain("PROJECT-MEMORY-MARKER");
		expect(untrusted.content).toContain("USER-MEMORY-MARKER");
		expect(untrusted.files).not.toContain(join(cwd, "LABUNBUN.md"));
		// What an approval would load is still named — by path, contents unread.
		expect(withheldProjectMemoryFiles(cwd, home)).toContain(join(cwd, "LABUNBUN.md"));

		approveProjectDefinitions(cwd, ["memory"], home);

		const approved = loadMemoryFiles(cwd, home);
		expect(approved.content).toContain("PROJECT-MEMORY-MARKER");
		expect(approved.files).toContain(join(cwd, "LABUNBUN.md"));
		expect(withheldProjectMemoryFiles(cwd, home)).toEqual([]);
	});

	test("the user's own files are never listed as withheld — they are in the prompt", () => {
		const home = tempDir("lbb-memgate2-home-");
		// cwd under home, so the un-gated walk (what the withheld list reads) would
		// revisit the user tier. Those files load from step 1 from any cwd; a file
		// that is in the prompt must not be reported as held back.
		const cwd = join(home, "project");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(home, ".labunbun", "rules"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "rules", "global.md"), "GLOBAL RULE\n");

		expect(withheldProjectMemoryFiles(cwd, home)).not.toContain(join(home, ".labunbun", "rules", "global.md"));
	});
});

describe("the user-tier path helpers", () => {
	test("spell the user memory file and rules directory exactly as the loader reads them", () => {
		// Exported for `/memory`, which has to name the same file `loadMemoryFiles`
		// reads — two independently spelled paths is how the command and the loader
		// drift apart.
		const home = join("somewhere", "home");
		expect(userMemoryPath(home)).toBe(join(home, ".labunbun", "MEMORY.md"));
		expect(userRulesDir(home)).toBe(join(home, ".labunbun", "rules"));
	});
});

describe("lastProjectMemoryFile", () => {
	const home = join("somewhere", "home");
	const userFile = userMemoryPath(home);
	const userRule = join(userRulesDir(home), "global.md");
	const rootFile = join("somewhere", "repo", "AGENTS.md");
	const nearFile = join("somewhere", "repo", "pkg", "LABUNBUN.md");

	test("skips the user tier and answers with the nearest project file, which is last", () => {
		expect(lastProjectMemoryFile([userFile, userRule, rootFile, nearFile], home)).toBe(nearFile);
	});

	test("nothing but the user tier, or nothing at all, answers nothing", () => {
		expect(lastProjectMemoryFile([userFile, userRule], home)).toBeUndefined();
		expect(lastProjectMemoryFile([], home)).toBeUndefined();
	});
});

/** The spawn stub's record of what would have been launched. */
interface SpawnCall {
	command: string;
	args: string[];
}

function recordingSpawn(calls: SpawnCall[]): typeof spawn {
	return ((command: string, args: string[]) => {
		calls.push({ command, args });
		return { on: () => {}, unref: () => {} };
	}) as unknown as typeof spawn;
}

describe("openInEditor", () => {
	test("a missing file is created with its header, and the editor is given the path", () => {
		const dir = tempDir("lbb-open-");
		const target = join(dir, "nested", "MEMORY.md");
		const calls: SpawnCall[] = [];

		// `EDITOR` with an argument, the shape the shell convention allows: the
		// string splits, and the file is appended after the editor's own flags.
		expect(
			openInEditor(target, {
				fileHeader: "# Memory",
				spawnFn: recordingSpawn(calls),
				env: { EDITOR: "myedit --wait" },
			}),
		).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("# Memory\n");
		expect(calls).toEqual([{ command: "myedit", args: ["--wait", target] }]);
	});

	test("with no editor variable, nothing is created and nothing is spawned", () => {
		const dir = tempDir("lbb-open2-");
		const target = join(dir, "MEMORY.md");
		const calls: SpawnCall[] = [];

		// The whole point of resolving the editor first: a machine that cannot open
		// anything must not leave a file behind, or a typo in the variable would.
		expect(openInEditor(target, { fileHeader: "# Memory", spawnFn: recordingSpawn(calls), env: {} })).toBe(false);
		expect(existsSync(target)).toBe(false);
		expect(calls).toEqual([]);
	});

	test("$VISUAL wins over $EDITOR", () => {
		const dir = tempDir("lbb-open3-");
		const target = join(dir, "MEMORY.md");
		writeFileSync(target, "existing\n", "utf8");
		const calls: SpawnCall[] = [];

		expect(openInEditor(target, { spawnFn: recordingSpawn(calls), env: { VISUAL: "visual-ed", EDITOR: "ed" } })).toBe(
			true,
		);
		expect(calls[0]?.command).toBe("visual-ed");
		// An existing file is opened as it is — the header is for creating, not for
		// rewriting what the user has.
		expect(readFileSync(target, "utf8")).toBe("existing\n");
	});

	test("createDir makes the rules directory itself, and the editor opens the directory", () => {
		const dir = tempDir("lbb-open4-");
		const target = join(dir, ".labunbun", "rules");
		const calls: SpawnCall[] = [];

		expect(openInEditor(target, { createDir: true, spawnFn: recordingSpawn(calls), env: { EDITOR: "myedit" } })).toBe(
			true,
		);
		expect(statSync(target).isDirectory()).toBe(true);
		expect(calls).toEqual([{ command: "myedit", args: [target] }]);
	});
});

/** A context with only the fields `/memory` reads, and an editor that records calls. */
interface OpenedCall {
	target: string;
	options?: { fileHeader?: string; createDir?: boolean };
}

function memoryCtx(
	home: string,
	opened: OpenedCall[],
	editorFound = true,
): { ctx: AppCommandContext; lines: () => string } {
	const store = createStore<UiState>({ ...initialUiState() });
	const ctx = {
		getSession: () => null,
		handle: { store },
		home,
		openEditor: (target: string, options?: { fileHeader?: string; createDir?: boolean }) => {
			opened.push({ target, options });
			return editorFound;
		},
	} as unknown as AppCommandContext;
	return {
		ctx,
		lines: () =>
			store
				.get()
				.entries.filter((entry) => entry.kind === "info")
				.map((entry) => (entry as { text: string }).text)
				.join("\n"),
	};
}

describe("/memory", () => {
	test("opens the user's memory file, and says it was created on first use", () => {
		const home = tempDir("lbb-memcmd-home-");
		const opened: OpenedCall[] = [];
		const h = memoryCtx(home, opened);

		expect(handleAppCommand("/memory", h.ctx)).toBe(true);

		// The command's half of the contract: which file, and that it asked for the
		// header. Whether the file lands is `openInEditor`'s test.
		expect(opened).toEqual([{ target: userMemoryPath(home), options: { fileHeader: "# Memory" } }]);
		expect(h.lines()).toContain(`Opening ${shortenHome(userMemoryPath(home), home)} in your editor. Created it.`);
		// Memory is read once at startup, so every success says how edits arrive.
		expect(h.lines()).toContain("Memory is read at startup — restart to apply edits.");
	});

	test("rules asks for the directory itself, which may not exist yet", () => {
		const home = tempDir("lbb-memcmd2-home-");
		const opened: OpenedCall[] = [];
		const h = memoryCtx(home, opened);

		expect(handleAppCommand("/memory rules", h.ctx)).toBe(true);

		expect(opened).toEqual([{ target: userRulesDir(home), options: { createDir: true } }]);
	});

	test("project opens the nearest project file this session loaded, and creates nothing", () => {
		const home = tempDir("lbb-memcmd3-home-");
		const opened: OpenedCall[] = [];
		const h = memoryCtx(home, opened);
		const projectFile = join("somewhere", "repo", "pkg", "LABUNBUN.md");
		h.ctx.memoryFiles = [userMemoryPath(home), join("somewhere", "repo", "AGENTS.md"), projectFile];

		expect(handleAppCommand("/memory project", h.ctx)).toBe(true);

		expect(opened).toEqual([{ target: projectFile, options: {} }]);
		// Project memory is edited where it exists: planting a LABUNBUN.md in a
		// checkout is /init's job, not a side effect of reading what is loaded.
		expect(h.lines()).not.toContain("Created it.");
	});

	test("project with nothing loaded names the gate when that is what stands in the way", () => {
		const home = tempDir("lbb-memcmd4-home-");
		const opened: OpenedCall[] = [];
		const h = memoryCtx(home, opened);
		h.ctx.memoryFiles = [userMemoryPath(home)];
		h.ctx.withheldMemory = [join("somewhere", "repo", "LABUNBUN.md")];

		expect(handleAppCommand("/memory project", h.ctx)).toBe(true);

		expect(opened).toEqual([]);
		expect(h.lines()).toContain("held back by the trust gate");
		expect(h.lines()).toContain("/agents approve");
	});

	test("project with nothing loaded and nothing withheld says nothing was found", () => {
		const home = tempDir("lbb-memcmd5-home-");
		const opened: OpenedCall[] = [];
		const h = memoryCtx(home, opened);
		h.ctx.memoryFiles = [];
		h.ctx.withheldMemory = [];

		expect(handleAppCommand("/memory project", h.ctx)).toBe(true);

		expect(opened).toEqual([]);
		expect(h.lines()).toContain("No project memory file found");
		expect(h.lines()).toContain("/init");
	});

	test("with no editor, nothing opens and the loaded files are listed instead", () => {
		const home = tempDir("lbb-memcmd6-home-");
		const opened: OpenedCall[] = [];
		const h = memoryCtx(home, opened, false);
		const projectFile = join("somewhere", "repo", "AGENTS.md");
		h.ctx.memoryFiles = [userMemoryPath(home), projectFile];

		expect(handleAppCommand("/memory", h.ctx)).toBe(true);

		// The attempt happened — there was simply nothing to launch — and the
		// answer falls back to what the command can always say: the path, the
		// variable to set, and which files are actually in the prompt.
		expect(opened).toHaveLength(1);
		expect(h.lines()).toContain("set $VISUAL or $EDITOR");
		expect(h.lines()).toContain(shortenHome(userMemoryPath(home), home));
		expect(h.lines()).toContain(projectFile);
	});

	test("an unknown argument is a usage error and opens nothing", () => {
		const home = tempDir("lbb-memcmd7-home-");
		const opened: OpenedCall[] = [];
		const h = memoryCtx(home, opened);

		expect(handleAppCommand("/memory sideways", h.ctx)).toBe(true);

		expect(opened).toEqual([]);
		expect(h.lines()).toContain("Usage: /memory [rules|project]");
	});
});
