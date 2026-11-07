import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { walkProjectFiles } from "../src/glob.ts";
import { NodeFileSystemOperations } from "../src/operations.ts";
import { buildRepoMap, definitionsInSource, repoMapLanguageFor } from "../src/repomap.ts";
import { RepoMapService } from "../src/repomap-service.ts";
import { buildRepoMapTags, tagsInSource } from "../src/repomap-tags.ts";
import { formatRepoMapResult } from "../src/repomap-tool.ts";

const ops = new NodeFileSystemOperations();

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lbb-repomap-p3-"));
}

function write(root: string, path: string, text: string): void {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

const definitions = (tags: { kind: string; name: string; definitionKind?: string }[]) =>
	tags.filter((tag) => tag.kind === "def").map((tag) => `${tag.definitionKind}:${tag.name}`);

const references = (tags: { kind: string; name: string }[]) =>
	tags.filter((tag) => tag.kind === "ref").map((tag) => tag.name);

describe("repoMapLanguageFor", () => {
	test("maps every extension a map parses", () => {
		expect(repoMapLanguageFor("src/a.ts")).toBe("typescript");
		expect(repoMapLanguageFor("src/a.mts")).toBe("typescript");
		expect(repoMapLanguageFor("src/a.tsx")).toBe("tsx");
		expect(repoMapLanguageFor("src/a.jsx")).toBe("javascript");
		expect(repoMapLanguageFor("src/a.py")).toBe("python");
		expect(repoMapLanguageFor("cmd/a.go")).toBe("go");
		expect(repoMapLanguageFor("src/a.rs")).toBe("rust");
	});

	test("is case-insensitive and declines what it cannot parse", () => {
		expect(repoMapLanguageFor("A.PY")).toBe("python");
		expect(repoMapLanguageFor("README.md")).toBeNull();
		expect(repoMapLanguageFor("Makefile")).toBeNull();
	});
});

describe("Python", () => {
	const source = [
		"def alpha(x):",
		"    return beta(x)",
		"",
		"class Box:",
		"    def run(self):",
		"        self.helper()",
		"",
		"@decorator",
		"def decorated():",
		"    pass",
	].join("\n");

	test("finds top-level functions and classes, methods stay with their class", async () => {
		expect(await definitionsInSource(source, "python")).toEqual([
			{ name: "alpha", kind: "function", line: 1 },
			{ name: "Box", kind: "class", line: 4 },
			{ name: "decorated", kind: "function", line: 9 },
		]);
	});

	test("takes the last segment of an attribute call as the reference", async () => {
		const tags = (await tagsInSource(source, "python", { path: "sample.py" })).tags;

		expect(definitions(tags)).toEqual(["function:alpha", "class:Box", "function:run", "function:decorated"]);
		expect(references(tags).sort()).toEqual(["beta", "helper"]);
	});
});

describe("Go", () => {
	const source = [
		"package main",
		"",
		"func alpha(x int) int { return beta(x) }",
		"",
		"type Box struct { value int }",
		"",
		"func (b *Box) Run() { b.helper(); fmt.Println(gamma()) }",
	].join("\n");

	test("finds functions, methods and type specs", async () => {
		expect(await definitionsInSource(source, "go")).toEqual([
			{ name: "alpha", kind: "function", line: 3 },
			{ name: "Box", kind: "class", line: 5 },
			{ name: "Run", kind: "function", line: 7 },
		]);
	});

	test("keeps method definitions and reads selector calls", async () => {
		const tags = (await tagsInSource(source, "go", { path: "cmd/main.go" })).tags;

		expect(definitions(tags)).toEqual(["function:alpha", "class:Box", "method:Run"]);
		expect(references(tags).sort()).toEqual(["Println", "beta", "gamma", "helper"]);
	});
});

describe("Rust", () => {
	const source = [
		"fn alpha(x: i32) -> i32 { beta(x) }",
		"",
		"struct Box { value: i32 }",
		"",
		'impl Box { fn run(&self) { self.helper(); println!("{}", gamma()); } }',
		"",
		"trait Shape { fn area(&self) -> f64; }",
		"",
		"type Alias = Box;",
	].join("\n");

	test("finds top-level functions, structs, traits and aliases", async () => {
		expect(await definitionsInSource(source, "rust")).toEqual([
			{ name: "alpha", kind: "function", line: 1 },
			{ name: "Box", kind: "class", line: 3 },
			{ name: "Shape", kind: "interface", line: 7 },
			{ name: "Alias", kind: "type", line: 9 },
		]);
	});

	test("reads method and free calls, and ignores macros", async () => {
		const tags = (await tagsInSource(source, "rust", { path: "src/lib.rs" })).tags;

		expect(definitions(tags)).toEqual([
			"function:alpha",
			"class:Box",
			"function:run",
			"interface:Shape",
			"method:area",
			"type:Alias",
		]);
		// `gamma()` sits inside `println!`, whose arguments are raw tokens rather
		// than parsed calls, so the macro body is not a reference.
		expect(references(tags).sort()).toEqual(["beta", "helper"]);
	});
});

describe("mixed repository", () => {
	test("maps every grammar it finds and reports its definitions", async () => {
		const root = tempDir();
		write(root, "src/a.ts", "export function alpha() { beta(); }\n");
		write(root, "src/b.py", "def gamma():\n    pass\n");
		write(root, "cmd/c.go", "package main\n\nfunc delta() {}\n");
		write(root, "src/d.rs", "fn epsilon() {}\n");
		write(root, "README.md", "# notes\n");

		const map = await buildRepoMap(root, ops);

		expect(map.files.map((file) => file.path)).toEqual(["cmd/c.go", "src/a.ts", "src/b.py", "src/d.rs"]);
		expect(map.stats.definitions).toBe(4);
		expect(map.text).toContain("gamma");
		expect(map.text).toContain("epsilon");
	});

	test("buildRepoMapTags gathers tags across grammars", async () => {
		const root = tempDir();
		write(root, "a.py", "def alpha():\n    beta()\n");
		write(root, "b.rs", "fn gamma() {}\n");

		const result = await buildRepoMapTags(root, ops);

		expect(result.stats).toMatchObject({ files: 2, parsed: 2, definitions: 2, references: 1 });
		expect(result.files.map((file) => file.path)).toEqual(["a.py", "b.rs"]);
	});
});

describe("a repository past the file ceiling", () => {
	test("the walk stops at maxFiles and reports it once", async () => {
		const root = tempDir();
		for (const name of ["a.ts", "b.ts", "c.ts"]) write(root, name, "export function f() {}\n");
		const reported: number[] = [];

		const paths = await walkProjectFiles(root, ops, {
			maxFiles: 2,
			onTruncated: (limit) => reported.push(limit),
		});

		expect(paths).toHaveLength(2);
		expect(reported).toEqual([2]);
	});

	test("a map that hits the ceiling says the tree is partial", async () => {
		const root = tempDir();
		for (const name of ["a.ts", "b.ts", "c.ts"]) write(root, name, `export function ${name[0]}() {}\n`);

		const summary = await new RepoMapService({ root, ops, maxFiles: 2 }).map({ maxTokens: 4096 });

		expect(summary.truncated).toBe(true);
	});

	test("a map that sees the whole tree is not truncated", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {}\n");

		expect((await new RepoMapService({ root, ops }).map({ maxTokens: 1024 })).truncated).toBe(false);
	});

	test("the tool's footer distinguishes a truncated scan from a tight budget", () => {
		const text = formatRepoMapResult({
			root: "G:/repo",
			text: "src/a.ts:\n  function alpha",
			tokens: 10,
			definitions: 1,
			files: 1,
			totalDefinitions: 1,
			totalFiles: 1,
			partial: false,
			truncated: true,
			elapsedMs: 1,
		});

		expect(text).toContain("The scan stopped at its file ceiling");
		expect(text).not.toContain("Raise maxTokens");
	});
});
