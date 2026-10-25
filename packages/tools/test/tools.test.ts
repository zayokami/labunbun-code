import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resolveCanonical } from "../src/containment.ts";
import { type FileWalkerOps, GLOB_SKIP_DIRS, walkProjectFiles } from "../src/glob.ts";
import { type GrepMatch, renderGrepResult } from "../src/grep.ts";
import {
	createAllTools,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createTailBuffer,
	createWriteTool,
	defaultOperations,
	detectShell,
	type Operations,
	ReadFileState,
} from "../src/index.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lbb-tools-"));
}

/** Run `body` with those environment variables, and put them all back after. */
function withEnv(values: Record<string, string | undefined>, body: () => void): void {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		body();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const NO_UPDATE = () => {};
const ABORT = new AbortController().signal;
const ctx = (callId = "t1") => ({ callId, signal: ABORT, cwd: process.cwd(), onUpdate: NO_UPDATE });

function toolByName(name: string, operations?: Operations): any {
	const tool = createAllTools(process.cwd(), { operations }).find((t) => t.name === name);
	if (!tool) throw new Error(`missing tool ${name}`);
	return tool;
}

async function call(tool: any, input: unknown) {
	return tool.call(input, ctx());
}

/**
 * Read and Edit over one `ReadFileState`.
 *
 * Edit's first gate is a *recorded read*, so an Edit case that does not go
 * through Read on the same store is testing the gate rather than the edit. This
 * is the shape `createAllTools` builds (`index.ts:100-107`), which is what
 * makes these rows a test of the wiring and not only of the guard.
 */
function readEditPair(dir: string): { edit: any; read: any } {
	const readState = new ReadFileState();
	return {
		edit: createEditTool(dir, defaultOperations(), readState),
		read: createReadTool(dir, defaultOperations(), [], readState),
	};
}

describe("Read tool", () => {
	test("numbers lines and pages", async () => {
		const dir = tempDir();
		const file = join(dir, "sample.txt");
		writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
		const tool = createReadTool(dir, defaultOperations());

		const result = await call(tool, { file_path: file, limit: 10 });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("     1\tline 1");
		expect(text).toContain("    10\tline 10");
		expect(text).toContain("offset=11");

		const page2 = await call(tool, { file_path: file, offset: 11, limit: 10 });
		expect((page2.content[0] as any).text).toContain("    11\tline 11");
	});

	test("missing file is an error result", async () => {
		const tool = createReadTool(tempDir(), defaultOperations());
		const result = await call(tool, { file_path: join(tmpdir(), "definitely-missing-xyz.txt") });
		expect(result.isError).toBe(true);
	});

	test("a result it is cut, not spilt", async () => {
		// Read can be asked for a smaller range, so a spilled copy of a file that
		// is still on disk is a copy nobody asked for.
		const tool = createReadTool(tempDir(), defaultOperations());
		expect(tool.overflow).toBe("truncate");
		expect(Number.isFinite(tool.maxResultSizeChars)).toBe(true);
	});

	test("a read that worked is recorded, and one that did not is not", async () => {
		// The record an edit gate consults, from here rather than from the class's
		// own tests: the tool has to leave it, and an error result must not — a
		// refused read shows the model nothing, and a record claiming otherwise is
		// a licence to edit a file nobody opened.
		const dir = tempDir();
		const file = join(dir, "recorded.txt");
		writeFileSync(file, "one\ntwo\n");
		const state = new ReadFileState();
		const tool = createReadTool(dir, defaultOperations(), [], state);
		// Under the key the gate looks up with: Edit resolves its own path the same
		// way, and on macOS a temp dir has a second canonical spelling.
		const key = resolveCanonical(file, dir);

		const missing = join(dir, "never-existed.txt");
		expect((await call(tool, { file_path: missing })).isError).toBe(true);
		expect(state.getState(resolveCanonical(missing, dir))).toBeUndefined();

		expect((await call(tool, { file_path: file })).isError).toBeUndefined();
		expect(state.getState(key)?.content).toBe("one\ntwo\n");
		expect(state.getState(key)?.fullRead).toBe(true);
	});
});

describe("a Read failure says which failure it was", () => {
	// The three causes the old single message — "File does not exist or cannot be
	// read" — folded together, plus the fallback for anything else. A model's
	// next move differs per cause (fix the path; use LS; stop retrying the same
	// string), so each wording is pinned on its own, and each pins that it does
	// NOT carry the other causes' claims.

	test("a path that is not there is named as missing, and as nothing else", async () => {
		const dir = tempDir();
		const tool = createReadTool(dir, defaultOperations());
		const result = await call(tool, { file_path: join(dir, "never-created.txt") });
		expect(result.isError).toBe(true);
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("File does not exist: ");
		expect(text).not.toContain("cannot be read");
		expect(text).not.toContain("directory");
	});

	test("a directory is named as one, with the tool that lists it", async () => {
		const dir = tempDir();
		const sub = join(dir, "folder");
		mkdirSync(sub);
		const tool = createReadTool(dir, defaultOperations());
		const result = await call(tool, { file_path: sub });
		expect(result.isError).toBe(true);
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("Path is a directory, not a file");
		expect(text).toContain("LS");
		expect(text).not.toContain("does not exist");
	});

	test("a permission refusal is named as one", async () => {
		// The refusal is faked at the operations boundary rather than with a
		// chmod fixture: a read-only bit does not deny reading on Windows, so a
		// real unreadable file is not constructible on every platform this suite
		// runs on. The branch reads the code, so the code is what the fixture
		// supplies — through the same `Operations` seam the app uses.
		const dir = tempDir();
		const file = join(dir, "denied.txt");
		writeFileSync(file, "secret");
		const ops: Operations = {
			...defaultOperations(),
			readTextFile: async () => {
				throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
			},
		};
		const result = await call(createReadTool(dir, ops), { file_path: file });
		expect(result.isError).toBe(true);
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("File exists but cannot be read");
		expect(text).toContain("permission denied");
		expect(text).not.toContain("does not exist");
	});

	test("a failure code the tool does not know claims only what it can see", async () => {
		const dir = tempDir();
		const file = join(dir, "busy.txt");
		writeFileSync(file, "held");
		const ops: Operations = {
			...defaultOperations(),
			readTextFile: async () => {
				throw Object.assign(new Error("EBUSY: resource busy or locked, open"), { code: "EBUSY" });
			},
		};
		const result = await call(createReadTool(dir, ops), { file_path: file });
		expect(result.isError).toBe(true);
		const text = (result.content[0] as any).text as string;
		// The code rides along so the cause survives to the model; existence is
		// not claimed either way, because EBUSY says nothing about it.
		expect(text).toContain("Could not read");
		expect(text).toContain("(EBUSY)");
		expect(text).not.toContain("does not exist");
		expect(text).not.toContain("cannot be read");
	});
});

describe("Read and the spill directory", () => {
	/**
	 * A spilled Bash result lives outside the workspace, and the path in it is a
	 * dead end unless Read is allowed to follow it back. This is that exception,
	 * and what it does not open.
	 */
	function spillFixture() {
		const cwd = tempDir();
		const spill = tempDir();
		const file = join(spill, "Bash-call_1.txt");
		writeFileSync(file, "the full output");
		return { cwd, spill, file };
	}

	test("without the root, a spill path is still outside the workspace", async () => {
		const { cwd, file } = spillFixture();
		const tool = createReadTool(cwd, defaultOperations());
		const result = await call(tool, { file_path: file });
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("outside workspace");
	});

	test("with the root, a spill file reads back", async () => {
		const { cwd, spill, file } = spillFixture();
		const tool = createReadTool(cwd, defaultOperations(), [spill]);
		const result = await call(tool, { file_path: file });
		expect(result.isError).toBeUndefined();
		expect((result.content[0] as any).text).toContain("the full output");
	});

	test("the exception does not widen past the directory it names", async () => {
		const { cwd, spill } = spillFixture();
		const tool = createReadTool(cwd, defaultOperations(), [spill]);
		// A sibling of the spill directory, and its parent: naming a root is not
		// naming everything near it.
		const sibling = join(spill, "..", "elsewhere.txt");
		writeFileSync(join(spill, "..", "elsewhere.txt"), "not yours");
		const result = await call(tool, { file_path: sibling });
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("outside workspace");
	});

	test("Write is not granted the same exception", async () => {
		// The root is a permission to read spilled output and nothing else: the
		// tool that could rewrite it goes through the writable-path guard, which
		// knows nothing about read-only roots.
		const { cwd, spill } = spillFixture();
		const tool = createWriteTool(cwd, defaultOperations());
		const result = await call(tool, { file_path: join(spill, "Bash-call_1.txt"), content: "overwritten" });
		expect(result.isError).toBe(true);
	});
});

describe("Write + Edit tools", () => {
	test("write creates file with parent dirs", async () => {
		const dir = tempDir();
		const tool = createWriteTool(dir, defaultOperations());
		const file = join(dir, "deep", "nested", "hello.txt");
		const result = await call(tool, { file_path: file, content: "hello world" });
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(file).text()).toBe("hello world");
	});

	test("edit replaces unique occurrence; rejects ambiguous", async () => {
		const dir = tempDir();
		const file = join(dir, "code.ts");
		writeFileSync(file, "const a = 1;\nconst b = 2;\nconst a2 = 3;\n");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });

		const ok = await call(edit, { file_path: file, old_string: "const b = 2;", new_string: "const b = 20;" });
		expect(ok.isError).toBeFalsy();
		expect(await Bun.file(file).text()).toContain("const b = 20;");

		const ambiguous = await call(edit, { file_path: file, old_string: "const a", new_string: "x" });
		expect(ambiguous.isError).toBe(true);
		expect((ambiguous.content[0] as any).text).toContain("appears 2 times");

		const missing = await call(edit, { file_path: file, old_string: "nope", new_string: "x" });
		expect(missing.isError).toBe(true);
	});

	// Containment alone allows this — .git/ is inside the workspace. The refusal
	// is about recoverability: history the agent rewrites is history the user
	// cannot get back, so it is not something a permission can grant.
	test("refuses to write inside .git", async () => {
		const dir = tempDir();
		const gitDir = join(dir, ".git");
		mkdirSync(gitDir);
		writeFileSync(join(gitDir, "config"), "[core]\n");

		const write = createWriteTool(dir, defaultOperations());
		const edit = createEditTool(dir, defaultOperations(), new ReadFileState());

		const wrote = await call(write, { file_path: join(gitDir, "config"), content: "[core]\n\tevil = 1\n" });
		expect(wrote.isError).toBe(true);
		expect((wrote.content[0] as any).text).toContain("version-control metadata");

		const edited = await call(edit, { file_path: join(gitDir, "HEAD"), old_string: "a", new_string: "b" });
		expect(edited.isError).toBe(true);

		expect(await Bun.file(join(gitDir, "config")).text()).toBe("[core]\n");
	});

	test("still writes ordinary files beside it", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".git"));
		const write = createWriteTool(dir, defaultOperations());
		const result = await call(write, { file_path: join(dir, ".gitignore"), content: "dist\n" });
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(join(dir, ".gitignore")).text()).toBe("dist\n");
	});

	// The test above would still pass if `write.ts` stopped calling
	// `guardWritablePath`, because `buildSandboxPolicy` derives `<workspace>/.git`
	// into `protected` whether or not a scan found it — so `decideWrite` refuses
	// that path on its own. These two rows are the ones the derived list cannot
	// produce, which makes them the only thing pinning the *call site* rather than
	// the function underneath it. Delete the `guardWritablePath` line from either
	// write.ts or edit.ts and both of these go red.
	describe("the guard the policy cannot supply, reached through a real tool", () => {
		test("a .git nested under node_modules is refused — the scan never walks there", async () => {
			const dir = tempDir();
			// `findProtectedPaths` does not descend into node_modules: measured at
			// 76 ms against 1762 ms for a full walk, per `workspace-policy.ts`.
			// So this repository is absent from `protected` no matter what the scan
			// returns, and the tool-layer guard is the whole of the protection.
			const nested = join(dir, "node_modules", "left-pad", ".git");
			mkdirSync(nested, { recursive: true });
			const config = join(nested, "config");
			writeFileSync(config, "[core]\n");

			const write = createWriteTool(dir, defaultOperations());
			const result = await call(write, { file_path: config, content: "[core]\n\tevil = 1\n" });

			expect(result.isError).toBe(true);
			expect((result.content[0] as any).text).toContain("version-control metadata");
			expect(await Bun.file(config).text()).toBe("[core]\n");

			// The same refusal through Edit, because edit.ts carries its own
			// `guardWritablePath` call and a guard only one of the two tools
			// invokes is not a guard the other one has.
			writeFileSync(config, "[core]\n\tbranch = main\n");
			const edit = createEditTool(dir, defaultOperations(), new ReadFileState());
			const edited = await call(edit, { file_path: config, old_string: "main", new_string: "evil" });
			expect(edited.isError).toBe(true);
			expect(await Bun.file(config).text()).toBe("[core]\n\tbranch = main\n");
		});

		test("a .git spelled with a trailing space is refused — no policy entry can match it", async () => {
			const dir = tempDir();
			// On Windows this is a sibling *directory* named `".git "`, so nothing in
			// the policy can refuse it: `protected` holds `<workspace>/.git`, and
			// containment is a prefix match, so a different directory name is simply
			// a different destination. On a share that strips trailing spaces it is
			// the real repository, which is why refusing it costs nothing anywhere.
			const sibling = join(dir, ".git ");
			mkdirSync(sibling);
			const config = join(sibling, "config");
			writeFileSync(config, "[core]\n");

			const write = createWriteTool(dir, defaultOperations());
			const result = await call(write, { file_path: config, content: "[core]\n\tevil = 1\n" });

			expect(result.isError).toBe(true);
			expect((result.content[0] as any).text).toContain("version-control metadata");
			expect(await Bun.file(config).text()).toBe("[core]\n");
		});

		test("and a directory that merely starts with .git is still writable", async () => {
			// The other direction. A rule that matched on a prefix instead of a path
			// segment would refuse this, and a workspace that cannot write its own
			// `.github/` is not a workspace.
			const dir = tempDir();
			const ok = join(dir, ".github", "workflows");
			mkdirSync(ok, { recursive: true });
			const write = createWriteTool(dir, defaultOperations());
			const result = await call(write, { file_path: join(ok, "ci.yml"), content: "on: push\n" });
			expect(result.isError).toBeFalsy();
		});
	});

	test("replace_all replaces every occurrence", async () => {
		const dir = tempDir();
		const file = join(dir, "r.txt");
		writeFileSync(file, "x x x");
		const { edit, read } = readEditPair(dir);
		await call(read, { file_path: file });
		const result = await call(edit, {
			file_path: file,
			old_string: "x",
			new_string: "y",
			replace_all: true,
		});
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(file).text()).toBe("y y y");
	});
});

/**
 * A tree that exercises each `.gitignore` rule once, with `TOKEN` in every
 * file — so a rule that stops working shows up as an extra or missing path,
 * not as a different-looking line.
 */
function ignoreFixture(): string {
	const dir = tempDir();
	writeFileSync(
		join(dir, ".gitignore"),
		["# build output", "", "*.log", "!keep.log", "build/", "cached/", "/root-only.txt", "src/gen", "logs/**", ""].join(
			"\n",
		),
	);
	writeFileSync(join(dir, "a.log"), "TOKEN in a log\n");
	writeFileSync(join(dir, "keep.log"), "TOKEN in a kept log\n");
	writeFileSync(join(dir, "real.txt"), "TOKEN real\n");
	writeFileSync(join(dir, "root-only.txt"), "TOKEN root only\n");
	writeFileSync(join(dir, "cached"), "TOKEN a file named like a directory rule\n");
	mkdirSync(join(dir, "sub"), { recursive: true });
	writeFileSync(join(dir, "sub", "b.log"), "TOKEN nested log\n");
	writeFileSync(join(dir, "sub", "root-only.txt"), "TOKEN nested root-only\n");
	mkdirSync(join(dir, "build"), { recursive: true });
	writeFileSync(join(dir, "build", "out.txt"), "TOKEN in build\n");
	mkdirSync(join(dir, "src", "gen"), { recursive: true });
	writeFileSync(join(dir, "src", "gen", "z.txt"), "TOKEN generated\n");
	mkdirSync(join(dir, "logs", "deep"), { recursive: true });
	writeFileSync(join(dir, "logs", "deep", "d.txt"), "TOKEN logged\n");
	return dir;
}

/** The paths a Grep result covers, sorted: the header line is dropped and each `path:N:` line is cut at the colon. */
function pathsOf(text: string): string[] {
	return text
		.trim()
		.split("\n")
		.slice(1)
		.map((line) => line.slice(0, line.indexOf(":")))
		.sort();
}

/** One file of `count` matching lines, numbered so pages can be told apart. */
function numberedMatches(dir: string, count: number, name = "many.txt"): void {
	const lines = Array.from({ length: count }, (_, i) => `TOKEN line ${i + 1}`);
	writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
}

describe("Grep tool", () => {
	test("finds pattern with line numbers, skips node_modules", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "a.ts"), "export const alpha = 1;\nconst beta = 2;\n");
		writeFileSync(join(dir, "b.ts"), "const alphabet = 3;\n");
		writeFileSync(join(dir, "node_modules", "c.ts"), "const alpha = 99;\n");

		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "alpha" });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("a.ts:1:");
		expect(text).toContain("b.ts:1:");
		expect(text).not.toContain("node_modules");
	});

	test("include filter and case_insensitive", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "a.ts"), "HELLO\n");
		writeFileSync(join(dir, "a.md"), "hello\n");
		const tool = createGrepTool(dir, defaultOperations());

		const filtered = await call(tool, { pattern: "hello", include: "*.md" });
		expect((filtered.content[0] as any).text).toContain("a.md:1");

		const ci = await call(tool, { pattern: "hello", include: "*.ts", case_insensitive: true });
		expect((ci.content[0] as any).text).toContain("a.ts:1");
	});

	test("gitignored files are skipped — by each rule — and the kept ones are searched", async () => {
		const dir = ignoreFixture();
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN" });
		// real.txt and keep.log (the `!` re-include) survive; sub/root-only.txt
		// survives because `/root-only.txt` is anchored; `cached` survives because
		// the file is not a directory. Everything else — the plain `*.log`, the
		// directory rule, the path rule and `logs/**` — is out.
		expect(pathsOf((result.content[0] as any).text)).toEqual(["cached", "keep.log", "real.txt", "sub/root-only.txt"]);
	});

	test("a deeper .gitignore overrides the ones above it", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, ".gitignore"), "*.tmp\nonly-here.txt\n");
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "sub", ".gitignore"), "!wanted.tmp\n");
		writeFileSync(join(dir, "sub", "wanted.tmp"), "TOKEN wanted\n");
		writeFileSync(join(dir, "sub", "other.tmp"), "TOKEN other\n");
		writeFileSync(join(dir, "sub", "only-here.txt"), "TOKEN only here\n");
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN" });
		expect(pathsOf((result.content[0] as any).text)).toEqual(["sub/wanted.tmp"]);
	});

	// The walker's own comment says a `.gitignore` it cannot read must not be
	// quietly walked past — and until these two rows existed, the code did
	// exactly that: the read's rejection was mapped to `null`, which the walk
	// reads as "no ignore file here". A real `EACCES` fixture is not portable,
	// so the two sides of the distinction are driven through the ops seam:
	// unreadable (throw) and vanished (ENOENT, the readdir-to-read race).
	describe("walkProjectFiles and an unreadable .gitignore", () => {
		const root = join(tmpdir(), "lbb-walk-unreadable");
		const entries = [
			{ name: ".gitignore", isDirectory: false },
			{ name: "app.ts", isDirectory: false },
		];
		const ops = (readTextFile: FileWalkerOps["readTextFile"]): FileWalkerOps => ({
			readdir: async () => entries,
			stat: async () => ({ mtimeMs: 1 }),
			readTextFile,
		});

		test("a read failure rejects rather than walking past the rules", async () => {
			const failing = Object.assign(new Error("EACCES: permission denied, open '.gitignore'"), { code: "EACCES" });
			await expect(
				walkProjectFiles(
					root,
					ops(async () => {
						throw failing;
					}),
					{ respectGitignore: true },
				),
			).rejects.toThrow(/could not read .*\.gitignore: EACCES/);
		});

		test("a file deleted between the listing and the read (ENOENT) is treated as absent", async () => {
			const paths = await walkProjectFiles(
				root,
				ops(async () => {
					throw Object.assign(new Error("ENOENT: no such file or directory, open '.gitignore'"), { code: "ENOENT" });
				}),
				{ respectGitignore: true },
			);
			// No rules to apply, and no failure either: the file being gone is the
			// same fact as never having been there. Both entries land in the result
			// — the `.gitignore` is itself a walked file, exactly as git sees it;
			// what would be wrong is only the throw.
			expect(paths).toHaveLength(2);
			expect(paths.some((path) => path.endsWith("app.ts"))).toBe(true);
		});
	});

	test("include is matched against the path relative to the search root", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "main.ts"), "NEEDLE at the root\n");
		writeFileSync(join(dir, "src", "main.ts"), "NEEDLE in src\n");
		writeFileSync(join(dir, "src", "main.md"), "NEEDLE in markdown\n");
		const tool = createGrepTool(dir, defaultOperations());

		// The old include matched only the basename, so `src/*.ts` silently
		// matched nothing at all — the pattern could never contain a slash.
		const srcOnly = await call(tool, { pattern: "NEEDLE", include: "src/*.ts" });
		expect(pathsOf((srcOnly.content[0] as any).text)).toEqual(["src/main.ts"]);

		// Glob semantics, as the description says: `*.ts` does not cross a slash.
		const topOnly = await call(tool, { pattern: "NEEDLE", include: "*.ts" });
		expect(pathsOf((topOnly.content[0] as any).text)).toEqual(["main.ts"]);

		const deep = await call(tool, { pattern: "NEEDLE", include: "**/*.ts" });
		expect(pathsOf((deep.content[0] as any).text)).toEqual(["main.ts", "src/main.ts"]);
	});

	test("a CRLF line is matched and quoted without the carriage return", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "crlf.txt"), "first\r\nTOKEN end\r\n");
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "end$" });
		const text = (result.content[0] as any).text as string;
		// `$` anchors at the line's end, not at the `\r`, and the quoted line
		// carries no invisible control character.
		expect(text).toContain("crlf.txt:2: TOKEN end");
		expect(JSON.stringify(text)).not.toContain("\\r");
	});

	test("the quoted line keeps its indentation", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "indented.py"), "def f():\n    return TOKEN\n");
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN" });
		// The old code `.trim()`ed the line: the result quoted a string the file
		// does not contain, so a model copying it back out could never match.
		expect((result.content[0] as any).text).toContain("indented.py:2:     return TOKEN");
	});

	test("an explicitly named file is searched even when a rule ignores it", async () => {
		const dir = ignoreFixture();
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN", path: join(dir, "a.log") });
		expect((result.content[0] as any).text).toContain("a.log:1: TOKEN in a log");
	});

	test("the default head limit shows 250 matches and names the next offset", async () => {
		const dir = tempDir();
		numberedMatches(dir, 300);
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN" });
		const lines = ((result.content[0] as any).text as string).split("\n");
		// The header is the first line and carries the shown count, the total and
		// where the next page starts.
		expect(lines[0]).toBe("250 of 300 match(es) shown; next offset 250:");
		expect(lines).toHaveLength(251);
		expect(lines[1]).toBe("many.txt:1: TOKEN line 1");
		expect(lines[250]).toBe("many.txt:250: TOKEN line 250");
	});

	test("offset pages through the matches without overlap", async () => {
		const dir = tempDir();
		numberedMatches(dir, 300);
		const tool = createGrepTool(dir, defaultOperations());
		const first = ((await call(tool, { pattern: "TOKEN" })).content[0] as any).text as string;
		const second = ((await call(tool, { pattern: "TOKEN", offset: 250 })).content[0] as any).text as string;
		const secondLines = second.split("\n");
		expect(secondLines[0]).toBe("50 of 300 match(es) shown:");
		expect(secondLines).toHaveLength(51);
		expect(secondLines[1]).toBe("many.txt:251: TOKEN line 251");
		expect(secondLines[50]).toBe("many.txt:300: TOKEN line 300");
		const numbered = [...first.split("\n").slice(1), ...secondLines.slice(1)].map((line) =>
			Number(/^many\.txt:(\d+):/.exec(line)?.[1]),
		);
		// Two pages, every match once: no row shown on both pages and none lost.
		expect(numbered).toHaveLength(300);
		expect(new Set(numbered).size).toBe(300);
		expect(Math.min(...numbered)).toBe(1);
		expect(Math.max(...numbered)).toBe(300);
	});

	test("an offset past the last match reports zero shown and the true total", async () => {
		const dir = tempDir();
		numberedMatches(dir, 300);
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN", offset: 500 });
		// A total above zero is worth saying even when the page is empty.
		expect((result.content[0] as any).text).toBe("0 of 300 match(es) shown:");
	});

	test("a search with no matches still says so", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "a.ts"), "nothing here\n");
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN" });
		expect((result.content[0] as any).text).toBe("No matches found.");
	});

	test("head_limit 0 removes the display limit", async () => {
		const dir = tempDir();
		numberedMatches(dir, 300);
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN", head_limit: 0 });
		const lines = ((result.content[0] as any).text as string).split("\n");
		expect(lines[0]).toBe("300 of 300 match(es) shown:");
		expect(lines).toHaveLength(301);
		expect(lines[300]).toBe("many.txt:300: TOKEN line 300");
	});

	test("the safety cap header says the total is not exact, and is not ordinary paging", () => {
		// The cap is 10000 matches, which is not worth a fixture on disk; the
		// rendering takes the collected rows directly, so the capped branch is
		// reachable here with in-memory rows.
		const rows: GrepMatch[] = Array.from({ length: 10_000 }, (_, i) => ({
			path: "big.txt",
			lineNumber: i + 1,
			text: "TOKEN",
		}));
		const page = renderGrepResult(rows, { offset: 9_990, headLimit: 5, maxColumns: 500, safetyCapped: true });
		expect(page.split("\n")[0]).toBe(
			"5 of at least 10000 match(es) shown; search stopped at the 10000-match safety cap, so the total is not exact; next offset 9995:",
		);
		const lastPage = renderGrepResult(rows, { offset: 9_995, headLimit: 5, maxColumns: 500, safetyCapped: true });
		// No next offset once the collected rows are exhausted, but the cap is
		// still named: the search stopped, so more may exist beyond it.
		expect(lastPage.split("\n")[0]).toBe(
			"5 of at least 10000 match(es) shown; search stopped at the 10000-match safety cap, so the total is not exact:",
		);
	});

	test("max_columns cuts the displayed line and counts the omitted characters", async () => {
		const dir = tempDir();
		const long = `TOKEN ${"x".repeat(600)}`; // 606 characters
		const exact = `TOKEN ${"x".repeat(494)}`; // exactly 500
		writeFileSync(join(dir, "long.txt"), `${long}\n`);
		writeFileSync(join(dir, "exact.txt"), `${exact}\n`);
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN" });
		const text = (result.content[0] as any).text as string;
		const kept = long.slice(0, 500);
		// The row keeps its `path:line:` prefix; only the line content is cut, and
		// the placeholder counts the characters it left out. A line exactly at the
		// limit is not cut.
		expect(text).toContain(`long.txt:1: ${kept}… (line truncated, ${long.length - 500} more chars)`);
		expect(text).not.toContain(long);
		expect(text).toContain(`exact.txt:1: ${exact}`);
		// Truncation is display only: the header counts the match once.
		expect(text.split("\n")[0]).toBe("2 of 2 match(es) shown:");
	});

	test("max_columns 0 leaves a long line whole", async () => {
		const dir = tempDir();
		const long = `TOKEN ${"y".repeat(600)}`;
		writeFileSync(join(dir, "long.txt"), `${long}\n`);
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN", max_columns: 0 });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain(`long.txt:1: ${long}`);
		expect(text).not.toContain("line truncated");
	});

	test("a cut CRLF line carries no carriage return", async () => {
		const dir = tempDir();
		const long = `TOKEN ${"z".repeat(600)}`;
		writeFileSync(join(dir, "crlf-long.txt"), `${long}\r\n`);
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN" });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain(`crlf-long.txt:1: ${long.slice(0, 500)}… (line truncated, 106 more chars)`);
		expect(JSON.stringify(text)).not.toContain("\\r");
	});

	test.each([".svn", ".hg", ".bzr", ".jj", ".sl"])("skips the %s directory", async (dirName) => {
		const dir = tempDir();
		mkdirSync(join(dir, dirName), { recursive: true });
		writeFileSync(join(dir, dirName, "hidden.txt"), "TOKEN away\n");
		writeFileSync(join(dir, "kept.txt"), "TOKEN here\n");
		const tool = createGrepTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "TOKEN" });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("kept.txt:1:");
		expect(text).not.toContain(dirName);
	});

	test("the description claims the subset that is implemented, not ripgrep", () => {
		const tool = createGrepTool(process.cwd(), defaultOperations());
		expect(tool.description).toContain(".gitignore");
		expect(tool.description).not.toContain("ripgrep");
		for (const dirName of GLOB_SKIP_DIRS) expect(tool.description).toContain(dirName);
	});
});

describe("Glob tool", () => {
	test("recursive pattern match", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "src", "sub"), { recursive: true });
		writeFileSync(join(dir, "src", "a.test.ts"), "");
		writeFileSync(join(dir, "src", "sub", "b.test.ts"), "");
		writeFileSync(join(dir, "src", "c.ts"), "");

		const tool = createGlobTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "**/*.test.ts" });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("a.test.ts");
		expect(text).toContain("b.test.ts");
		expect(text).not.toContain("c.ts");
	});

	test("gitignored files are left out of the listing", async () => {
		const dir = ignoreFixture();
		const tool = createGlobTool(dir, defaultOperations());
		const result = await call(tool, { pattern: "**/*.txt" });
		const prefix = `${dir.split("\\").join("/")}/`;
		const paths = ((result.content[0] as any).text as string)
			.trim()
			.split("\n")
			.map((line: string) => line.slice(prefix.length))
			.sort();
		// Glob and Grep run the same walk, so the same four rules decide what a
		// `.txt` listing contains: the anchored rule spares sub/root-only.txt,
		// the directory and path rules drop build/ and src/gen, and `logs/**`
		// drops the file without pruning its parent.
		expect(paths).toEqual(["real.txt", "sub/root-only.txt"]);
	});
});

describe("LS tool", () => {
	test("lists entries with sizes and dir markers", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "subdir"));
		writeFileSync(join(dir, "file.txt"), "12345");
		const tool = createLsTool(dir, defaultOperations());
		const result = await call(tool, { path: dir });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("subdir/");
		expect(text).toContain("file.txt (5B)");
	});
});

describe("Bash tool", () => {
	test("fake exec backend captures output and exit code", async () => {
		const fakeOps: Operations = {
			...defaultOperations(),
			exec: async (options) => {
				options.onOutput?.("hello from fake\n");
				return { stdout: "hello from fake\n", stderr: "", exitCode: 0, killed: false };
			},
		};
		const _dir = tempDir();
		const tool = toolByName("Bash", fakeOps);
		const result = await call(tool, { command: "echo hello" });
		expect(result.isError).toBeFalsy();
		expect((result.content[0] as any).text).toContain("hello from fake");
		expect((result.content[0] as any).text).toContain("[exit code: 0]");
	});

	test("non-zero exit marks isError", async () => {
		const fakeOps: Operations = {
			...defaultOperations(),
			exec: async () => ({ stdout: "", stderr: "boom", exitCode: 2, killed: false }),
		};
		const _dir = tempDir();
		const tool = toolByName("Bash", fakeOps);
		const result = await call(tool, { command: "false" });
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("boom");
	});

	test("streams partial output via onUpdate", async () => {
		const updates: unknown[] = [];
		const fakeOps: Operations = {
			...defaultOperations(),
			exec: async (options) => {
				options.onOutput?.("chunk1 ");
				options.onOutput?.("chunk2");
				return { stdout: "chunk1 chunk2", stderr: "", exitCode: 0, killed: false };
			},
		};
		const dir = tempDir();
		const tool = toolByName("Bash", fakeOps);
		await tool.call(
			{ command: "x" },
			{ callId: "t", signal: ABORT, cwd: dir, onUpdate: (p: unknown) => updates.push(p) },
		);
		expect(updates.length).toBeGreaterThan(0);
	});

	test("a chatty command does not become a chatty stream of updates", async () => {
		const updates: Array<{ partialOutput?: string }> = [];
		const fakeOps: Operations = {
			...defaultOperations(),
			exec: async (options) => {
				// A build tool with unbuffered stdout: thousands of chunks, all in
				// one synchronous burst. Before the throttle this was one store
				// update per chunk, each one rejoining the whole output.
				for (let i = 0; i < 2000; i++) options.onOutput?.(`line ${i}\n`);
				return { stdout: "", stderr: "", exitCode: 0, killed: false };
			},
		};
		const dir = tempDir();
		const tool = toolByName("Bash", fakeOps);
		await tool.call(
			{ command: "x" },
			{ callId: "t", signal: ABORT, cwd: dir, onUpdate: (p: unknown) => updates.push(p as { partialOutput?: string }) },
		);
		expect(updates.length).toBeLessThanOrEqual(3);
		for (const update of updates) {
			expect((update.partialOutput ?? "").length).toBeLessThanOrEqual(30_000);
		}
	});

	test("the whole output is handed over, not a head the spill file would only repeat", async () => {
		// `overflow: "spill"` promises that what does not fit is written out in full
		// and pointed at, which is a promise only if the text arriving at the
		// pipeline is longer than the pipeline's limit for this tool. Cutting here
		// first — to that same limit — made the spilled file a copy of what the
		// model could already read, and lost the end of the output for good.
		const full = Array.from({ length: 2_000 }, (_, i) => `line ${i + 1} ${"y".repeat(20)}`).join("\n");
		const fakeOps: Operations = {
			...defaultOperations(),
			exec: async () => ({ stdout: full, stderr: "", exitCode: 0, killed: false }),
		};
		const tool = toolByName("Bash", fakeOps);
		const result = await call(tool, { command: "build" });
		const text = (result.content[0] as any).text as string;

		expect(full.length).toBeGreaterThan(tool.maxResultSizeChars);
		// Substantially more, not a few characters over: a cut at the limit used to
		// leave the result just past it, on the strength of the exit code alone.
		expect(text.length).toBeGreaterThan(tool.maxResultSizeChars * 1.5);
		// The last line is where a build says what went wrong.
		expect(text).toContain(`line 2000 ${"y".repeat(20)}`);
	});

	test("the exit code leads the result, where no cut can reach it", async () => {
		const fakeOps: Operations = {
			...defaultOperations(),
			exec: async () => ({ stdout: "x".repeat(40_000), stderr: "", exitCode: 0, killed: false }),
		};
		const tool = toolByName("Bash", fakeOps);
		const result = await call(tool, { command: "build" });
		expect(((result.content[0] as any).text as string).startsWith("[exit code: 0]\n")).toBe(true);
	});

	test("a timed-out command says so on the line after the code", async () => {
		const fakeOps: Operations = {
			...defaultOperations(),
			exec: async () => ({ stdout: "partial", stderr: "", exitCode: 124, killed: true }),
		};
		const tool = toolByName("Bash", fakeOps);
		const result = await call(tool, { command: "sleep 999" });
		expect(
			((result.content[0] as any).text as string).startsWith("[exit code: 124]\n[command timed out or was killed]\n"),
		).toBe(true);
		expect(result.isError).toBe(true);
	});
});

describe("the tail buffer behind live Bash output", () => {
	test("keeps the end of the stream, not the beginning", () => {
		const buffer = createTailBuffer(10);
		buffer.push("aaaaaaaaaa");
		buffer.push("bbbbbbbbbb");
		expect(buffer.read()).toBe("bbbbbbbbbb");
	});

	test("retained chunks stay near the cap however long the command runs", () => {
		const buffer = createTailBuffer(100);
		for (let i = 0; i < 5000; i++) buffer.push("0123456789");
		const text = buffer.read();
		expect(text).toHaveLength(100);
		expect(text).toBe("0123456789".repeat(10));
	});

	test("a single oversized chunk is trimmed at read time", () => {
		const buffer = createTailBuffer(5);
		buffer.push("abcdefghij");
		expect(buffer.read()).toBe("fghij");
	});

	test("empty chunks are ignored rather than banked", () => {
		const buffer = createTailBuffer(4);
		buffer.push("");
		buffer.push("ab");
		expect(buffer.read()).toBe("ab");
	});
});

describe("shell resolution", () => {
	/**
	 * The environment a machine with no PowerShell and no conventional Git
	 * presents: every derived location points into an empty temporary tree.
	 * `SystemRoot` matters twice — the PowerShell fallback and the WSL check
	 * both read it — so a test that stages System32 passes its own root.
	 */
	function noPowerShellEnv(pathValue: string, systemRoot: string = tempDir()): Record<string, string | undefined> {
		return {
			PATH: pathValue,
			SystemRoot: systemRoot,
			windir: systemRoot,
			ProgramFiles: tempDir(),
			"ProgramFiles(x86)": tempDir(),
			LOCALAPPDATA: tempDir(),
			USERPROFILE: tempDir(),
			LBB_SHELL_PATH: undefined,
			LBB_BASH_PATH: undefined,
		};
	}

	test("Windows PowerShell is the default, and the command is the one -Command carries", () => {
		if (process.platform !== "win32") return;
		withEnv({ LBB_SHELL_PATH: undefined, LBB_BASH_PATH: undefined }, () => {
			const shell = detectShell();
			expect(shell.kind).toBe("powershell");
			expect(shell.command.toLowerCase()).toContain("powershell");
			const args = shell.args("Write-Output hi");
			expect(args).toContain("-Command");
			expect(args[args.length - 1]).toContain("Write-Output hi");
			expect(shell.cmdExe).toBeUndefined();
		});
	});

	test("a machine with no PowerShell falls back to a bash.exe on PATH", () => {
		if (process.platform !== "win32") return;
		// Git on another drive, or bash from scoop or chocolatey: a machine where
		// no conventional location answers and no PowerShell is installed.
		const dir = tempDir();
		writeFileSync(join(dir, "bash.exe"), "");

		withEnv(noPowerShellEnv(dir), () => {
			const shell = detectShell();
			expect(shell.command).toBe(join(dir, "bash.exe"));
			expect(shell.kind).toBe("bash");
			// Still a login shell: PATH lookup was the fix, not the flags.
			expect(shell.args("echo hi")).toEqual(["-lc", "echo hi"]);
		});
	});

	test("Windows' own bash.exe is the WSL launcher, not a shell for these commands", () => {
		if (process.platform !== "win32") return;
		// It answers to the same name and is on every PATH, but it starts a Linux
		// VM: every path this tool hands it would mean something else there. A
		// PATH that offers only that one offers cmd.exe.
		const root = tempDir();
		const system32 = join(root, "System32");
		mkdirSync(system32, { recursive: true });
		writeFileSync(join(system32, "bash.exe"), "");
		const windowsApps = join(root, "Microsoft", "WindowsApps");
		mkdirSync(windowsApps, { recursive: true });
		writeFileSync(join(windowsApps, "bash.exe"), "");

		withEnv(noPowerShellEnv([system32, windowsApps].join(";"), root), () => {
			const shell = detectShell();
			// The rule: a launcher on PATH is never the answer, and with nothing
			// else on the machine the last answer is cmd.exe.
			expect([join(system32, "bash.exe"), join(windowsApps, "bash.exe")]).not.toContain(shell.command);
			expect(shell.command).toBe("cmd.exe");
			expect(shell.kind).toBe("cmd");
			expect(shell.cmdExe).toBe(true);
		});

		// ...but a path the user names outright is theirs to name, launcher or not.
		withEnv({ ...noPowerShellEnv(tempDir(), root), LBB_BASH_PATH: join(system32, "bash.exe") }, () => {
			expect(detectShell().command).toBe(join(system32, "bash.exe"));
		});
	});

	test("LBB_SHELL_PATH outranks the old LBB_BASH_PATH name", () => {
		if (process.platform !== "win32") return;
		const first = join(tempDir(), "bash.exe");
		const second = join(tempDir(), "bash.exe");
		writeFileSync(first, "");
		writeFileSync(second, "");
		withEnv({ LBB_SHELL_PATH: first, LBB_BASH_PATH: second }, () => {
			const shell = detectShell();
			expect(shell.command).toBe(first);
			expect(shell.kind).toBe("bash");
		});
	});

	test("whatever this machine resolves, it is never the WSL launcher", () => {
		if (process.platform !== "win32") return;
		// The machine's real environment, not a staged one: the exclusion above is
		// only worth anything if the installs actually present here go around it.
		const shell = detectShell();
		expect(/\\microsoft\\windowsapps\\/i.test(shell.command)).toBe(false);
		expect(/\\system32\\bash\.exe$/i.test(shell.command)).toBe(false);
	});
});

describe("tool registry shape", () => {
	test("default set: core tools, background shell pair, and the read-only probes", () => {
		const names = createAllTools(process.cwd(), { webTools: false }).map((t) => t.name);
		expect(names).toEqual([
			"Bash",
			"Edit",
			"Glob",
			"Grep",
			"LS",
			"Read",
			"Write",
			"BashOutput",
			"KillBash",
			"Digest",
			"InspectSqlite",
			"InspectArtifact",
			"InspectBinary",
			"InspectSourceMap",
			"CompareArtifacts",
			"InspectWebCapture",
		]);
	});

	test("every tool contributes wire-safe JSON schema", () => {
		for (const tool of createAllTools(process.cwd())) {
			const schema = z.toJSONSchema(tool.inputSchema) as any;
			expect(schema.type).toBe("object");
			expect(typeof tool.description).toBe("string");
		}
	});

	test("the search prompt, and every prompt, key off the world rather than the model's memory", () => {
		const tools = createAllTools(process.cwd());
		const search = tools.find((t) => t.name === "WebSearch");
		if (!search) throw new Error("WebSearch is not in the default tool set");

		// The old wording was "beyond your knowledge", which hands the decision to
		// search to the model's self-assessment — and a model that believes it knows
		// a library's version is precisely the one that will not go and check. The
		// replacement keys the decision to a fact about the world having moved.
		expect(search.prompt).toContain("could have changed since your training data");

		// Read across every tool rather than only this one. The same weak phrasing
		// in a second tool's prompt would be just as inert, and a single assertion
		// on WebSearch walks straight past it.
		for (const tool of tools) {
			expect(tool.prompt ?? "", `${tool.name} still hands the decision to the model`).not.toContain(
				"beyond your knowledge",
			);
		}
	});
});
