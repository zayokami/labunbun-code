import { afterEach, describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
	expandIncludes,
	loadMemoryFiles,
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

	test("oversized memory is truncated at the 40k cap with a notice", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-memcap-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-memcap2-"));
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "MEMORY.md"), "x".repeat(60_000));

		const result = loadMemoryFiles(cwd, home);
		expect(result.truncated).toBe(true);
		expect(result.content.length).toBeLessThanOrEqual(40_000 + 100); // cap + notice line
		expect(result.content).toContain("[memory files truncated");
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
