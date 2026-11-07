import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolCallContext } from "@labunbun/agent";
import { NodeFileSystemOperations } from "../src/operations.ts";
import { InMemoryRepoMapCache, type RepoMapCache } from "../src/repomap.ts";
import { REPO_MAP_MIN_TOKENS, RepoMapService } from "../src/repomap-service.ts";
import type { RepoMapFileTags } from "../src/repomap-tags.ts";
import { createRepoMapTool, formatRepoMapResult } from "../src/repomap-tool.ts";

const ops = new NodeFileSystemOperations();
const fixtures = join(import.meta.dir, "fixtures", "repomap");

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lbb-repomap-p2-"));
}

function write(root: string, path: string, text: string): void {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

const ctx = (): ToolCallContext => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd: process.cwd(),
	sandbox: "workspace-write",
	network: { access: "enabled", domains: [] },
	onUpdate: () => {},
});

/** Counts what the service asks of the cache, so a refresh is observable. */
class CountingCache implements RepoMapCache<RepoMapFileTags> {
	gets = 0;
	sets = 0;
	clears = 0;
	readonly #inner = new InMemoryRepoMapCache<RepoMapFileTags>();

	get(path: string, mtimeMs: number, size: number): RepoMapFileTags | undefined {
		this.gets++;
		return this.#inner.get(path, mtimeMs, size);
	}

	set(path: string, mtimeMs: number, size: number, data: RepoMapFileTags): void {
		this.sets++;
		this.#inner.set(path, mtimeMs, size, data);
	}

	clear(): void {
		this.clears++;
		this.#inner.clear();
	}
}

describe("RepoMapService", () => {
	test("maps a small repository and reports complete coverage", async () => {
		const summary = await new RepoMapService({ root: fixtures, ops }).map({ maxTokens: 4096 });

		expect(summary.definitions).toBe(7);
		expect(summary.totalDefinitions).toBe(7);
		expect(summary.partial).toBe(false);
		expect(summary.files).toBe(1);
		expect(summary.text).toContain("sample.js:");
		expect(summary.tokens).toBeGreaterThan(0);
	});

	test("maps a subdirectory relative to that directory", async () => {
		const root = tempDir();
		write(root, "src/a.ts", "export function alpha() {}\n");
		write(root, "other/b.ts", "export function beta() {}\n");

		const summary = await new RepoMapService({ root, ops }).map({ path: "src", maxTokens: 1024 });

		expect(summary.text).toContain("a.ts:");
		expect(summary.text).not.toContain("b.ts");
		expect(summary.root.endsWith("/src")).toBe(true);
	});

	test("refuses a path outside the workspace", async () => {
		const service = new RepoMapService({ root: tempDir(), ops });
		await expect(service.map({ path: "../elsewhere" })).rejects.toThrow(/outside workspace/);
	});

	test("names a directory it cannot read", async () => {
		const service = new RepoMapService({ root: tempDir(), ops });
		await expect(service.map({ path: "missing-directory" })).rejects.toThrow(/RepoMap: cannot read/);
	});

	test("refresh clears the cache and re-reads every file", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {}\n");
		const cache = new CountingCache();
		const service = new RepoMapService({ root, ops, cache });

		await service.map({ maxTokens: 1024 });
		const coldSets = cache.sets;
		await service.map({ maxTokens: 1024 });
		expect(cache.sets).toBe(coldSets);

		await service.map({ maxTokens: 1024, refresh: true });
		expect(cache.clears).toBe(1);
		expect(cache.sets).toBe(coldSets + 1);
	});

	test("persists its cache at the path it was given", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {}\n");
		const cachePath = join(tempDir(), "nested", "repomap.sqlite");

		const first = new RepoMapService({ root, ops, cachePath });
		const cold = await first.map({ maxTokens: 1024 });
		first.close();
		expect(existsSync(cachePath)).toBe(true);

		const second = new RepoMapService({ root, ops, cachePath });
		const hot = await second.map({ maxTokens: 1024 });
		second.close();
		expect(hot.text).toBe(cold.text);
	});

	test("holds no database handle once the map finishes", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {}\n");
		const cacheDir = tempDir();
		const service = new RepoMapService({ root, ops, cachePath: join(cacheDir, "repomap.sqlite") });

		await service.map({ maxTokens: 1024 });

		// Windows refuses to remove a directory holding an open SQLite file (and
		// its WAL sidecar) with EBUSY; this is the platform where the assertion
		// bites. The rows are on disk before the close, which is why the cache
		// still survives into the next map.
		expect(() => rmSync(cacheDir, { recursive: true, force: true })).not.toThrow();
	});

	test("falls back to memory when the cache path cannot be opened", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {}\n");
		const blocker = join(tempDir(), "not-a-directory");
		writeFileSync(blocker, "x");

		const service = new RepoMapService({ root, ops, cachePath: join(blocker, "repomap.sqlite") });

		expect((await service.map({ maxTokens: 1024 })).text).toContain("a.ts:");
	});
});

describe("RepoMapService.promptSection", () => {
	test("offers the whole map for a small repository", async () => {
		const section = await new RepoMapService({ root: fixtures, ops }).promptSection();

		expect(section?.definitions).toBe(7);
		expect(section?.text).toContain("sample.js:");
	});

	test("declines when the repository has too many files", async () => {
		const root = tempDir();
		write(root, "a.ts", "export function alpha() {}\n");
		write(root, "b.ts", "export function beta() {}\n");

		const section = await new RepoMapService({ root, ops }).promptSection({ maxFiles: 1 });

		expect(section).toBeUndefined();
	});

	test("declines when the repository is too large in bytes", async () => {
		const root = tempDir();
		write(root, "a.ts", `export function alpha() {}\n${"// filler\n".repeat(200)}`);

		const section = await new RepoMapService({ root, ops }).promptSection({ maxBytes: 100 });

		expect(section).toBeUndefined();
	});

	test("declines a map the budget cannot finish", async () => {
		const section = await new RepoMapService({ root: fixtures, ops }).promptSection({
			maxTokens: REPO_MAP_MIN_TOKENS,
		});

		expect(section).toBeUndefined();
	});

	test("declines a repository with nothing to map", async () => {
		const root = tempDir();
		write(root, "a.ts", "const answer = 42;\n");

		expect(await new RepoMapService({ root, ops }).promptSection()).toBeUndefined();
	});
});

async function textOf(tool: ReturnType<typeof createRepoMapTool>, input: unknown): Promise<string> {
	const result = await tool.call(input, ctx());
	return (result.content[0] as { text: string }).text;
}

describe("createRepoMapTool", () => {
	test("returns the map and a completeness footer", async () => {
		const text = await textOf(createRepoMapTool(fixtures, { operations: ops }), { maxTokens: 4096 });

		expect(text).toContain("sample.js:");
		expect(text).toContain("Repo map: 7 definitions in 1 file,");
	});

	test("reports an outside path as a result rather than throwing", async () => {
		const text = await textOf(createRepoMapTool(tempDir(), { operations: ops }), { path: "../elsewhere" });

		expect(text).toContain("outside workspace");
	});

	test("is read-only and safe to run beside other reads", () => {
		const tool = createRepoMapTool(fixtures, { operations: ops });

		expect(tool.isReadOnly?.({})).toBe(true);
		expect(tool.isConcurrencySafe?.({})).toBe(true);
	});

	test("says so when there is nothing to map", () => {
		const root = tempDir();
		// A file with no definitions still appears as a bare path; an empty
		// repository has nothing to render at all.
		write(root, "README.md", "# nothing to see\n");
		return textOf(createRepoMapTool(root, { operations: ops }), {}).then((text) => {
			expect(text).toContain("no functions, classes or methods found");
		});
	});
});

describe("formatRepoMapResult", () => {
	test("an empty map names the directory it looked at", () => {
		const text = formatRepoMapResult({
			root: "G:/repo",
			text: "",
			tokens: 0,
			definitions: 0,
			files: 0,
			totalDefinitions: 0,
			totalFiles: 0,
			partial: false,
			elapsedMs: 1,
		});

		expect(text).toBe("RepoMap: no functions, classes or methods found under G:/repo.");
	});
});
