import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeFileSystemOperations } from "../src/operations.ts";
import { InMemoryRepoMapCache, type RepoMapCache } from "../src/repomap.ts";
import { generateRepoMap } from "../src/repomap-generate.ts";
import { cappedReferences, rankRepoMap } from "../src/repomap-rank.ts";
import { estimateTokens, renderRepoMap, repoMapTokenBudget } from "../src/repomap-render.ts";
import { SqliteRepoMapCache } from "../src/repomap-sqlite.ts";
import {
	buildRepoMapTags,
	extractTags,
	type RepoMapFileTags,
	type RepoMapTag,
	tagsInSource,
} from "../src/repomap-tags.ts";

const ops = new NodeFileSystemOperations();
const fixtures = join(import.meta.dir, "fixtures", "repomap");

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lbb-repomap-p1-"));
}

function write(root: string, path: string, text: string): void {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function definition(path: string, name: string, line = 1): RepoMapTag {
	return {
		path,
		name,
		kind: "def",
		line,
		definitionKind: "function",
		snippet: [{ line, text: `function ${name}() {}` }],
	};
}

function reference(path: string, name: string, line = 1): RepoMapTag {
	return { path, name, kind: "ref", line };
}

describe("extractTags", () => {
	test("collects declarations, methods, bound functions, calls, and constructors", async () => {
		const source = [
			"export function alpha() { beta(); }",
			"class Box {",
			"  constructor() {}",
			"  open() { return new Widget(); }",
			"}",
			"const arrow = () => { run(); };",
			"exports.helper = function () { move(); };",
			"interface Shape { draw(): void; }",
		].join("\n");
		const { tags } = await tagsInSource(source, "typescript");

		expect(tags.filter((tag) => tag.kind === "def").map((tag) => `${tag.definitionKind}:${tag.name}`)).toEqual([
			"function:alpha",
			"class:Box",
			"method:open",
			"function:arrow",
			"function:helper",
			"interface:Shape",
			"method:draw",
		]);
		expect(tags.filter((tag) => tag.kind === "ref").map((tag) => tag.name)).toEqual(["beta", "Widget", "run", "move"]);
	});

	test("tags function and class fields, and does not call module.exports a definition", async () => {
		const source = [
			"class Box {",
			"  handler = () => 1;",
			"  Child = class {};",
			"}",
			"module.exports = function () {};",
			"module.exports.render = () => 1;",
		].join("\n");
		const { tags } = await tagsInSource(source, "typescript");

		expect(tags.filter((tag) => tag.kind === "def").map((tag) => `${tag.definitionKind}:${tag.name}`)).toEqual([
			"class:Box",
			"method:handler",
			"class:Child",
			"function:render",
		]);
	});

	test("keeps a function body but drops its closing brace and class bodies", async () => {
		const source = [
			"function greet(name) {",
			"    return name;",
			"}",
			"",
			"class Car {",
			"  drive() { return 1; }",
			"}",
		].join("\n");
		const { tags, lineCount } = await tagsInSource(source, "javascript", { path: "sample.js" });
		const greet = tags.find((tag) => tag.kind === "def" && tag.name === "greet");
		const car = tags.find((tag) => tag.kind === "def" && tag.name === "Car");
		expect(greet?.snippet).toEqual([
			{ line: 1, text: "function greet(name) {" },
			{ line: 2, text: "    return name;" },
		]);
		expect(car?.snippet).toEqual([{ line: 5, text: "class Car {" }]);
		expect(lineCount).toBe(7);
	});

	test("marks a mid-body closing brace but not the definition's own last line", async () => {
		const source = ["function f() {", "  if (x) {", "  }", "  return 1;", "}"].join("\n");
		const { tags } = await tagsInSource(source, "javascript");
		expect(tags[0].snippet?.map((line) => line.text)).toEqual(["function f() {", "  if (x) {", "  }", "  return 1;"]);
	});
});

describe("Aider fixture", () => {
	test("renders Aider's sample.js exactly", async () => {
		const { files } = await buildRepoMapTags(fixtures, ops);
		const ranked = rankRepoMap(files);
		const rendered = renderRepoMap(ranked, { tokenBudget: 4096 });
		const expected = readFileSync(join(fixtures, "sample.js.expected"), "utf8").trimEnd();

		expect(rendered.definitions).toBe(7);
		expect(rendered.text).toBe(expected);
	});
});

describe("rankRepoMap", () => {
	const graph: RepoMapFileTags[] = [
		{
			path: "lib.ts",
			lineCount: 1,
			tags: [definition("lib.ts", "alpha")],
		},
		{
			path: "main.ts",
			lineCount: 3,
			tags: [definition("main.ts", "main", 1), reference("main.ts", "alpha", 2)],
		},
	];

	test("puts a definition that is called by another file before the caller", () => {
		const entries = rankRepoMap(graph);
		expect(entries.map((entry) => (entry.kind === "definition" ? `${entry.path}:${entry.name}` : entry.path))).toEqual([
			"lib.ts:alpha",
			"main.ts:main",
		]);
	});

	test("omits chat files from the rendered order", () => {
		const entries = rankRepoMap(graph, { chatFiles: ["lib.ts"] });
		expect(entries.every((entry) => entry.path !== "lib.ts")).toBe(true);
	});

	test("a mentioned identifier wins a shared caller's rank", () => {
		const shared: RepoMapFileTags[] = [
			{ path: "left.ts", lineCount: 1, tags: [definition("left.ts", "left_helper")] },
			{ path: "right.ts", lineCount: 1, tags: [definition("right.ts", "right_helper")] },
			{
				path: "main.ts",
				lineCount: 2,
				tags: [reference("main.ts", "left_helper", 1), reference("main.ts", "right_helper", 2)],
			},
		];
		const plain = rankRepoMap(shared);
		const mentioned = rankRepoMap(shared, { mentionedIdents: ["left_helper"] });
		expect(plain[0]).toMatchObject({ kind: "definition", path: "right.ts", name: "right_helper" });
		expect(mentioned[0]).toMatchObject({ kind: "definition", path: "left.ts", name: "left_helper" });
	});

	test("keeps files that define and reference nothing as bare entries", () => {
		const entries = rankRepoMap([...graph, { path: "readme.ts", lineCount: 1, tags: [] }]);
		expect(entries.at(-1)).toMatchObject({ kind: "file", path: "readme.ts" });
	});
});

describe("cappedReferences", () => {
	test("keeps every referencer in insertion order under the cap", () => {
		const counts = new Map([
			["a.ts", 1],
			["b.ts", 1],
			["c.ts", 1],
		]);
		expect(cappedReferences(counts, 2, 100)).toEqual([
			["a.ts", 1],
			["b.ts", 1],
			["c.ts", 1],
		]);
	});

	test("keeps the strongest referencers over the cap", () => {
		const counts = new Map([
			["a.ts", 5],
			["b.ts", 3],
			["c.ts", 1],
		]);
		expect(cappedReferences(counts, 2, 2)).toEqual([["a.ts", 5]]);
	});

	test("keeps one referencer even when a single definer alone exceeds the cap", () => {
		const counts = new Map([["a.ts", 1]]);
		expect(cappedReferences(counts, 10, 1)).toEqual([["a.ts", 1]]);
	});
});

describe("renderRepoMap", () => {
	test("fits a smaller map inside a tight budget", async () => {
		const { files } = await buildRepoMapTags(fixtures, ops);
		const ranked = rankRepoMap(files);
		const full = renderRepoMap(ranked, { tokenBudget: 4096 });
		const tight = renderRepoMap(ranked, { tokenBudget: 100 });

		expect(tight.definitions).toBeGreaterThan(0);
		expect(tight.definitions).toBeLessThan(full.definitions);
		expect(tight.tokens).toBeLessThanOrEqual(Math.ceil(100 * 1.15));
		expect(renderRepoMap(ranked, { tokenBudget: 100 })).toEqual(tight);
	});

	test("returns nothing when the budget cannot fit one entry", async () => {
		const { files } = await buildRepoMapTags(fixtures, ops);
		const rendered = renderRepoMap(rankRepoMap(files), { tokenBudget: 0 });
		expect(rendered).toEqual({ text: "", tokens: 0, definitions: 0, files: 0 });
	});

	test("estimates four characters per token", () => {
		expect(estimateTokens("12345678")).toBe(2);
	});

	test("uses Aider's budget shape", () => {
		expect(repoMapTokenBudget()).toBe(1024);
		expect(repoMapTokenBudget({ hasChatFiles: true, maxInputTokens: 200_000 })).toBe(1024);
		expect(repoMapTokenBudget({ maxInputTokens: 200_000 })).toBe(8192);
		expect(repoMapTokenBudget({ maxInputTokens: 6000 })).toBe(1904);
		expect(repoMapTokenBudget({ maxInputTokens: 1024 })).toBe(0);
	});
});

describe("buildRepoMapTags", () => {
	test("reports definitions and references separately", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {}\nexport function beta() { alpha(); }\n");
		const result = await buildRepoMapTags(root, ops);

		expect(result.stats).toMatchObject({ files: 1, parsed: 1, cached: 0, definitions: 2, references: 1 });
	});

	test("honours the shared in-memory cache", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {}\n");
		const cache = new InMemoryRepoMapCache<RepoMapFileTags>();
		const cold = await buildRepoMapTags(root, ops, { cache });
		const hot = await buildRepoMapTags(root, ops, { cache });

		expect(cold.stats.parsed).toBe(1);
		expect(hot.stats.parsed).toBe(0);
		expect(hot.stats.cached).toBe(1);
		expect(hot.files).toEqual(cold.files);
	});

	test("stores the file path once, as the cache key", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {\n\tbeta();\n}\n");
		const stored: unknown[] = [];
		const inner = new InMemoryRepoMapCache<RepoMapFileTags>();
		const cache: RepoMapCache<RepoMapFileTags> = {
			get: (path, mtimeMs, size) => inner.get(path, mtimeMs, size),
			set: (path, mtimeMs, size, data) => {
				stored.push(JSON.parse(JSON.stringify(data)));
				inner.set(path, mtimeMs, size, data);
			},
		};

		const cold = await buildRepoMapTags(root, ops, { cache });
		expect(stored).toHaveLength(1);
		const payload = stored[0] as { path?: string; tags: Array<Record<string, unknown>> };
		expect(payload.path).toBeUndefined();
		expect(payload.tags.length).toBeGreaterThan(0);
		expect(payload.tags.every((tag) => !("path" in tag))).toBe(true);

		const hot = await buildRepoMapTags(root, ops, { cache });
		expect(hot.stats.cached).toBe(1);
		expect(hot.files).toEqual(cold.files);
		expect(hot.files[0]?.tags.every((tag) => tag.path === "a.ts")).toBe(true);
	});
});

describe("SqliteRepoMapCache", () => {
	test("persists tags across instances and validates mtime and size", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {}\n");
		const path = join(tempDir(), "cache.sqlite");

		const first = new SqliteRepoMapCache<RepoMapFileTags>(path);
		const cold = await buildRepoMapTags(root, ops, { cache: first });
		expect(cold.stats.parsed).toBe(1);
		expect(first.size).toBe(1);
		first.close();

		const second = new SqliteRepoMapCache<RepoMapFileTags>(path);
		const hot = await buildRepoMapTags(root, ops, { cache: second });
		expect(hot.stats.parsed).toBe(0);
		expect(hot.stats.cached).toBe(1);
		expect(hot.files).toEqual(cold.files);
		second.close();
	});

	test("treats a mismatched key as a miss", () => {
		const cache = new SqliteRepoMapCache<string>(":memory:");
		cache.set("/a.ts", 1, 2, "payload");
		expect(cache.get("/a.ts", 1, 2)).toBe("payload");
		expect(cache.get("/a.ts", 2, 2)).toBeUndefined();
		expect(cache.get("/a.ts", 1, 3)).toBeUndefined();
		expect(cache.get("/b.ts", 1, 2)).toBeUndefined();
		cache.clear();
		expect(cache.size).toBe(0);
		cache.close();
	});
});

describe("generateRepoMap", () => {
	test("runs the pipeline end to end", async () => {
		const generated = await generateRepoMap(fixtures, ops, { render: { tokenBudget: 4096 } });
		expect(generated.stats.definitions).toBe(7);
		expect(generated.rendered.definitions).toBe(7);
		expect(generated.rendered.text).toContain("sample.js:");
	});
});

describe("extractTags from a parsed tree", () => {
	test("can be called with a tree built elsewhere", async () => {
		const source = "function solo() {}";
		const { loadRepoMapLanguages } = await import("../src/repomap.ts");
		const { Parser } = await import("web-tree-sitter");
		const languages = await loadRepoMapLanguages();
		const parser = new Parser();
		try {
			parser.setLanguage(languages.javascript);
			const tree = parser.parse(source);
			if (!tree) throw new Error("parse failed");
			try {
				expect(extractTags(tree, source, "solo.js").tags.map((tag) => tag.name)).toEqual(["solo"]);
			} finally {
				tree.delete();
			}
		} finally {
			parser.delete();
		}
	});
});
