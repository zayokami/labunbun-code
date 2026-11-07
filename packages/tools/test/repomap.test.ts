import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeFileSystemOperations } from "../src/operations.ts";
import { buildRepoMap, definitionsInSource, InMemoryRepoMapCache, repoMapLanguageFor } from "../src/repomap.ts";

const ops = new NodeFileSystemOperations();

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lbb-repomap-"));
}

function write(root: string, path: string, text: string): void {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

describe("definitionsInSource", () => {
	test("reads top-level declarations and skips local ones", async () => {
		const source = [
			"export function alpha(x: number): number { return x; }",
			"class Beta { method() { return 1; } }",
			"export interface Gamma { g: string }",
			"export type Delta = number;",
			"export enum Epsilon { A, B }",
			"const zeta = () => 1;",
			"export const eta = function () {};",
			"export const theta = 3;",
			"function outer() { function nested() {} return nested; }",
		].join("\n");

		expect(await definitionsInSource(source, "typescript")).toEqual([
			{ name: "alpha", kind: "function", line: 1 },
			{ name: "Beta", kind: "class", line: 2 },
			{ name: "Gamma", kind: "interface", line: 3 },
			{ name: "Delta", kind: "type", line: 4 },
			{ name: "Epsilon", kind: "enum", line: 5 },
			{ name: "zeta", kind: "function", line: 6 },
			{ name: "eta", kind: "function", line: 7 },
			{ name: "outer", kind: "function", line: 9 },
		]);
	});

	test("unwraps ambient declarations, namespaces, and class expressions", async () => {
		const source = [
			"declare function ambient(): void;",
			"namespace Box { export function inner() {} }",
			"const Shape = class {};",
		].join("\n");

		expect(await definitionsInSource(source, "typescript")).toEqual([
			{ name: "ambient", kind: "function", line: 1 },
			{ name: "inner", kind: "function", line: 2 },
			{ name: "Shape", kind: "class", line: 3 },
		]);
	});

	test("parses JSX with the TSX grammar", async () => {
		const source = [
			"export const App = () => <main>hi</main>;",
			"export function Layout(props: { children: unknown }) { return <div>{props.children}</div>; }",
		].join("\n");

		expect(await definitionsInSource(source, "tsx")).toEqual([
			{ name: "App", kind: "function", line: 1 },
			{ name: "Layout", kind: "function", line: 2 },
		]);
	});
});

describe("repoMapLanguageFor", () => {
	test("maps the extensions the walk considers", () => {
		expect(repoMapLanguageFor("src/a.ts")).toBe("typescript");
		expect(repoMapLanguageFor("src/a.d.ts")).toBe("typescript");
		expect(repoMapLanguageFor("src/a.tsx")).toBe("tsx");
		expect(repoMapLanguageFor("src/a.js")).toBe("javascript");
		expect(repoMapLanguageFor("src/a.cjs")).toBe("javascript");
		expect(repoMapLanguageFor("README.md")).toBeNull();
		expect(repoMapLanguageFor("Makefile")).toBeNull();
	});
});

describe("buildRepoMap", () => {
	test("walks code files, honours .gitignore, and renders definitions", async () => {
		const root = tempDir();
		write(root, ".gitignore", "ignored.ts\nvendor/\n");
		write(root, "src/a.ts", "export function alpha() {}\n");
		write(root, "src/ignored.ts", "export function hidden() {}\n");
		write(root, "src/vendor/skip.ts", "export function vendored() {}\n");
		write(root, "src/b.tsx", "export const B = () => <div />;\n");
		write(root, "README.md", "# not code\n");
		write(root, "node_modules/dep.ts", "export function dependency() {}\n");

		const result = await buildRepoMap(root, ops);

		expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.tsx"]);
		expect(result.text).toBe("src/a.ts:\n  function alpha\nsrc/b.tsx:\n  function B");
		expect(result.stats).toMatchObject({
			files: 2,
			parsed: 2,
			cached: 0,
			skipped: 0,
			definitions: 2,
		});
	});

	test("serves unchanged files from the cache and re-parses only what changed", async () => {
		const root = tempDir();
		write(root, "src/a.ts", "export function alpha() {}\n");
		write(root, "src/b.ts", "export function beta() {}\n");
		const cache = new InMemoryRepoMapCache();

		const cold = await buildRepoMap(root, ops, { cache });
		expect(cold.stats.parsed).toBe(2);
		expect(cold.stats.cached).toBe(0);

		const hot = await buildRepoMap(root, ops, { cache });
		expect(hot.stats.parsed).toBe(0);
		expect(hot.stats.cached).toBe(2);
		expect(hot.text).toBe(cold.text);

		// A different size guarantees the mtime-and-size key misses even when the
		// timestamp has not moved.
		write(root, "src/a.ts", "export function alpha() {}\nexport function gamma() {}\n");
		const warm = await buildRepoMap(root, ops, { cache });
		expect(warm.stats.parsed).toBe(1);
		expect(warm.stats.cached).toBe(1);
		expect(warm.text).toBe("src/a.ts:\n  function alpha\n  function gamma\nsrc/b.ts:\n  function beta");
		expect(cache.size).toBe(2);
	});

	test("skips files above maxFileBytes without reading them", async () => {
		const root = tempDir();
		write(root, "src/small.ts", "export function small() {}\n");
		write(root, "src/large.ts", `export function large() {}\n${"// filler\n".repeat(40)}`);

		const result = await buildRepoMap(root, ops, { maxFileBytes: 100 });

		expect(result.files.map((file) => file.path)).toEqual(["src/small.ts"]);
		expect(result.stats.skipped).toBe(1);
	});
});
