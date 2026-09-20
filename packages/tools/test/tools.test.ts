import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
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
		const tool = createEditTool(dir, defaultOperations());

		const ok = await call(tool, { file_path: file, old_string: "const b = 2;", new_string: "const b = 20;" });
		expect(ok.isError).toBeFalsy();
		expect(await Bun.file(file).text()).toContain("const b = 20;");

		const ambiguous = await call(tool, { file_path: file, old_string: "const a", new_string: "x" });
		expect(ambiguous.isError).toBe(true);
		expect((ambiguous.content[0] as any).text).toContain("appears 2 times");

		const missing = await call(tool, { file_path: file, old_string: "nope", new_string: "x" });
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
		const edit = createEditTool(dir, defaultOperations());

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

	test("replace_all replaces every occurrence", async () => {
		const dir = tempDir();
		const file = join(dir, "r.txt");
		writeFileSync(file, "x x x");
		const tool = createEditTool(dir, defaultOperations());
		const result = await call(tool, {
			file_path: file,
			old_string: "x",
			new_string: "y",
			replace_all: true,
		});
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(file).text()).toBe("y y y");
	});
});

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
	// One machine's install could sit anywhere; these tests move PATH instead of
	// assuming where it is. The two probes the code tries first are hardcoded
	// (deliberately — that install is the one the user chose), so a machine that
	// has it answers with it whatever PATH says, and the PATH test steps aside.
	const realGit = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"];
	const hasRealGit = realGit.some((path) => existsSync(path));

	test("a bash.exe on PATH is found, not only one in the conventional places", () => {
		if (process.platform !== "win32" || hasRealGit) return;
		// Git on another drive, or bash from scoop or chocolatey: a machine where
		// no hardcoded probe hits, and every POSIX-shaped command used to come back
		// as a cmd.exe error until PATH was consulted too.
		const dir = tempDir();
		writeFileSync(join(dir, "bash.exe"), "");

		withEnv({ PATH: dir, LBB_BASH_PATH: undefined, USERPROFILE: tempDir() }, () => {
			const shell = detectShell();
			expect(shell.command).toBe(join(dir, "bash.exe"));
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

		withEnv(
			{
				PATH: [system32, windowsApps].join(";"),
				SystemRoot: root,
				windir: root,
				LBB_BASH_PATH: undefined,
				USERPROFILE: tempDir(),
			},
			() => {
				expect(detectShell().command).toBe("cmd.exe");
			},
		);

		// ...but a path the user names outright is theirs to name, launcher or not.
		withEnv({ LBB_BASH_PATH: join(system32, "bash.exe"), PATH: tempDir() }, () => {
			expect(detectShell().command).toBe(join(system32, "bash.exe"));
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
	test("default set: core tools, background shell pair, and web tools", () => {
		const names = createAllTools(process.cwd(), { webTools: false }).map((t) => t.name);
		expect(names).toEqual(["Bash", "Edit", "Glob", "Grep", "LS", "Read", "Write", "BashOutput", "KillBash"]);
	});

	test("every tool contributes wire-safe JSON schema", () => {
		for (const tool of createAllTools(process.cwd())) {
			const schema = z.toJSONSchema(tool.inputSchema) as any;
			expect(schema.type).toBe("object");
			expect(typeof tool.description).toBe("string");
		}
	});
});
