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
		expect(repoMapLanguageFor("src/A.java")).toBe("java");
		expect(repoMapLanguageFor("src/A.cs")).toBe("c-sharp");
		expect(repoMapLanguageFor("src/a.cpp")).toBe("cpp");
		expect(repoMapLanguageFor("src/a.cc")).toBe("cpp");
		expect(repoMapLanguageFor("src/a.c")).toBe("cpp");
		expect(repoMapLanguageFor("include/a.hpp")).toBe("cpp");
		expect(repoMapLanguageFor("include/a.h")).toBe("cpp");
		expect(repoMapLanguageFor("lib/a.rb")).toBe("ruby");
		expect(repoMapLanguageFor("web/a.php")).toBe("php");
		expect(repoMapLanguageFor("bin/a.sh")).toBe("bash");
		expect(repoMapLanguageFor("bin/a.ps1")).toBe("powershell");
		expect(repoMapLanguageFor("bin/a.psm1")).toBe("powershell");
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

describe("Java", () => {
	const source = [
		"package demo;",
		"",
		"public class Box {",
		"    public int run() { return helper() + Widget.make(); }",
		"    public Box() {}",
		"}",
		"",
		"interface Shape { double area(); }",
		"",
		"enum Kind { A, B }",
		"",
		"record Point(int x, int y) {}",
	].join("\n");

	test("finds top-level types and skips members inside them", async () => {
		expect(await definitionsInSource(source, "java")).toEqual([
			{ name: "Box", kind: "class", line: 3 },
			{ name: "Shape", kind: "interface", line: 8 },
			{ name: "Kind", kind: "enum", line: 10 },
			{ name: "Point", kind: "class", line: 12 },
		]);
	});

	test("tags methods and reads invocation names", async () => {
		const tags = (await tagsInSource(source, "java", { path: "src/Box.java" })).tags;

		expect(definitions(tags)).toEqual([
			"class:Box",
			"method:run",
			"interface:Shape",
			"method:area",
			"enum:Kind",
			"class:Point",
		]);
		expect(references(tags)).toEqual(["helper", "make"]);
	});
});

describe("C#", () => {
	const source = [
		"namespace Demo {",
		"    public class Box {",
		"        public int Run() { return Helper() + Widget.Make(); }",
		"    }",
		"    public interface Shape { double Area(); }",
		"    public enum Kind { A, B }",
		"    public struct Point { int X; }",
		"    public record Row(int X);",
		"}",
	].join("\n");

	test("descends a namespace and reports its types", async () => {
		expect(await definitionsInSource(source, "c-sharp")).toEqual([
			{ name: "Box", kind: "class", line: 2 },
			{ name: "Shape", kind: "interface", line: 5 },
			{ name: "Kind", kind: "enum", line: 6 },
			{ name: "Point", kind: "class", line: 7 },
			{ name: "Row", kind: "class", line: 8 },
		]);
	});

	test("tags methods and reads invocations and member calls", async () => {
		const tags = (await tagsInSource(source, "c-sharp", { path: "src/Box.cs" })).tags;

		expect(definitions(tags)).toEqual([
			"class:Box",
			"method:Run",
			"method:Area",
			"interface:Shape",
			"enum:Kind",
			"class:Point",
			"class:Row",
		]);
		expect(references(tags)).toEqual(["Helper", "Make"]);
	});
});

describe("C++", () => {
	const source = [
		"namespace demo {",
		"class Box {",
		"public:",
		"    int run() { return helper() + Widget::make(); }",
		"};",
		"",
		"struct Point { int x; };",
		"",
		"enum class Kind { A, B };",
		"",
		"int free_function(int x) { return helper(x); }",
		"}",
	].join("\n");

	test("descends a namespace and names each declaration", async () => {
		expect(await definitionsInSource(source, "cpp")).toEqual([
			{ name: "Box", kind: "class", line: 2 },
			{ name: "Point", kind: "class", line: 7 },
			{ name: "Kind", kind: "enum", line: 9 },
			{ name: "free_function", kind: "function", line: 11 },
		]);
	});

	test("tags methods and reads qualified and field calls", async () => {
		const tags = (await tagsInSource(source, "cpp", { path: "src/box.cpp" })).tags;

		expect(definitions(tags)).toEqual([
			"class:Box",
			"function:run",
			"class:Point",
			"enum:Kind",
			"function:free_function",
		]);
		expect(references(tags)).toEqual(["helper", "make", "helper"]);
	});
});

describe("Ruby", () => {
	const source = [
		"class Box",
		"  def initialize(value)",
		"    @value = value",
		"  end",
		"",
		"  def run",
		"    helper()",
		"    Widget.make",
		"  end",
		"end",
		"",
		"module Demo",
		"  def self.build",
		"    Box.new",
		"  end",
		"end",
		"",
		"def free_function",
		"  helper",
		"end",
	].join("\n");

	test("finds classes, modules and top-level methods", async () => {
		expect(await definitionsInSource(source, "ruby")).toEqual([
			{ name: "Box", kind: "class", line: 1 },
			{ name: "Demo", kind: "class", line: 12 },
			{ name: "free_function", kind: "function", line: 18 },
		]);
	});

	test("tags methods, singleton methods and calls", async () => {
		const tags = (await tagsInSource(source, "ruby", { path: "lib/box.rb" })).tags;

		expect(definitions(tags)).toEqual([
			"class:Box",
			"method:initialize",
			"method:run",
			"class:Demo",
			"method:build",
			"method:free_function",
		]);
		expect(references(tags)).toEqual(["helper", "make", "new"]);
	});
});

describe("PHP", () => {
	const source = [
		"<?php",
		"namespace Demo;",
		"",
		"class Box {",
		"    public function run() { return helper() + Widget::make(); }",
		"    public function __construct() {}",
		"}",
		"",
		"interface Shape {",
		"    public function area();",
		"}",
		"",
		"function free_function() { return helper(); }",
	].join("\n");

	test("finds classes, interfaces and functions", async () => {
		expect(await definitionsInSource(source, "php")).toEqual([
			{ name: "Box", kind: "class", line: 4 },
			{ name: "Shape", kind: "interface", line: 9 },
			{ name: "free_function", kind: "function", line: 13 },
		]);
	});

	test("tags methods, skips the constructor, and reads calls", async () => {
		const tags = (await tagsInSource(source, "php", { path: "web/box.php" })).tags;

		expect(definitions(tags)).toEqual([
			"class:Box",
			"method:run",
			"interface:Shape",
			"method:area",
			"function:free_function",
		]);
		expect(references(tags)).toEqual(["helper", "make", "helper"]);
	});
});

describe("Bash", () => {
	const source = [
		"#!/usr/bin/env bash",
		"",
		"alpha() {",
		"  beta",
		'  echo "hi"',
		"}",
		"",
		"function gamma {",
		"  alpha",
		"}",
	].join("\n");

	test("finds both function syntaxes", async () => {
		expect(await definitionsInSource(source, "bash")).toEqual([
			{ name: "alpha", kind: "function", line: 3 },
			{ name: "gamma", kind: "function", line: 8 },
		]);
	});

	test("treats every command as a potential reference", async () => {
		const tags = (await tagsInSource(source, "bash", { path: "bin/run.sh" })).tags;

		expect(definitions(tags)).toEqual(["function:alpha", "function:gamma"]);
		expect(references(tags)).toEqual(["beta", "echo", "alpha"]);
	});
});

describe("PowerShell", () => {
	const source = ["function Alpha {", "  Beta", '  Write-Host "hi"', "}", "", "function Gamma {", "  Alpha", "}"].join(
		"\n",
	);

	test("finds function statements", async () => {
		expect(await definitionsInSource(source, "powershell")).toEqual([
			{ name: "Alpha", kind: "function", line: 1 },
			{ name: "Gamma", kind: "function", line: 6 },
		]);
	});

	test("reads command names as references", async () => {
		const tags = (await tagsInSource(source, "powershell", { path: "bin/run.ps1" })).tags;

		expect(definitions(tags)).toEqual(["function:Alpha", "function:Gamma"]);
		expect(references(tags)).toEqual(["Beta", "Write-Host", "Alpha"]);
	});
});

describe("mixed repository", () => {
	test("maps every grammar it finds and reports its definitions", async () => {
		const root = tempDir();
		write(root, "src/a.ts", "export function alpha() { beta(); }\n");
		write(root, "src/b.py", "def gamma():\n    pass\n");
		write(root, "cmd/c.go", "package main\n\nfunc delta() {}\n");
		write(root, "src/d.rs", "fn epsilon() {}\n");
		write(root, "cmd/e.sh", "zeta() {\n  alpha\n}\n");
		write(root, "README.md", "# notes\n");

		const map = await buildRepoMap(root, ops);

		expect(map.files.map((file) => file.path)).toEqual([
			"cmd/c.go",
			"cmd/e.sh",
			"src/a.ts",
			"src/b.py",
			"src/d.rs",
		]);
		expect(map.stats.definitions).toBe(5);
		expect(map.text).toContain("gamma");
		expect(map.text).toContain("epsilon");
		expect(map.text).toContain("zeta");
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
