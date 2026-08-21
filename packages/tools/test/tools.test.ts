import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
	createWriteTool,
	defaultOperations,
	type Operations,
} from "../src/index.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lbb-tools-"));
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
