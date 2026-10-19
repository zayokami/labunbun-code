/**
 * What the path-taking tools say when they cannot look.
 *
 * The failure these tests exist for is a permission refusal being reported as
 * "Path not found" — a sentence that sends the model to fix a spelling that is
 * already right. The errno is read at the same seam every tool uses, so these
 * tests exercise the vocabulary directly and then through LS, Grep and Glob.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext } from "@labunbun/agent";
import {
	createGlobTool,
	createGrepTool,
	createLsTool,
	defaultOperations,
	describeFsFailure,
	isMissingPathError,
	isPermissionError,
	type Operations,
	probePath,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	// macOS answers /var/... for tmpdir but the tools resolve it to
	// /private/var/..., so a comparison against the unsettled spelling would
	// test the symlink instead of the behavior.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "lbb-path-errors-")));
	roots.push(dir);
	return dir;
}

function refusal(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: permission denied, open`), { code });
}

/** The walker hands paths to ops in this shape on every platform. */
function normalized(path: string): string {
	return path.split("\\").join("/");
}

const ctx = (): ToolCallContext => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd: process.cwd(),
	sandbox: "workspace-write",
	network: { access: "enabled", domains: [] },
	onUpdate: () => {},
});

async function textOf(tool: ReturnType<typeof createLsTool>, input: unknown): Promise<string> {
	const result = await tool.call(input, ctx());
	return (result.content[0] as { text: string }).text;
}

describe("filesystem failure vocabulary", () => {
	test("a missing path and a refusal are different facts", () => {
		expect(isMissingPathError(refusal("ENOENT"))).toBe(true);
		expect(isMissingPathError(refusal("ENOTDIR"))).toBe(true);
		expect(isMissingPathError(refusal("EACCES"))).toBe(false);
		expect(isMissingPathError(new Error("no code"))).toBe(false);

		expect(isPermissionError(refusal("EACCES"))).toBe(true);
		expect(isPermissionError(refusal("EPERM"))).toBe(true);
		expect(isPermissionError(refusal("ENOENT"))).toBe(false);
		expect(isPermissionError(undefined)).toBe(false);
	});

	test("each failure keeps the sentence that gives the caller a next move", () => {
		expect(describeFsFailure(refusal("ENOENT"), "/x", "read")).toBe("Path not found: /x");
		expect(describeFsFailure(refusal("EACCES"), "/x", "read")).toBe("Permission denied: /x");
		// A code the vocabulary does not know claims nothing beyond the failure,
		// and carries the underlying message so the cause survives.
		expect(describeFsFailure(refusal("EIO"), "/x", "list")).toBe("Could not list /x: EIO: permission denied, open");
		// A rejection that is not an Error is still a value worth printing.
		expect(describeFsFailure("gone", "/x", "read")).toBe("Could not read /x: gone");
	});

	test("probing returns metadata, or the reason there is none", async () => {
		const dir = tempDir();
		const file = join(dir, "present.txt");
		writeFileSync(file, "here");
		const ops = defaultOperations();

		const present = await probePath(ops, file);
		expect(present.ok).toBe(true);
		if (present.ok) expect(present.stat.isFile).toBe(true);

		const missing = await probePath(ops, join(dir, "absent.txt"));
		expect(missing).toEqual({ ok: false, message: `Path not found: ${join(dir, "absent.txt")}` });

		const denied = await probePath({ stat: async () => Promise.reject(refusal("EACCES")) }, file, "inspect");
		expect(denied).toEqual({ ok: false, message: `Permission denied: ${file}` });
	});
});

describe("the tools say why a path cannot be used", () => {
	test("LS does not call a refused directory missing", async () => {
		const dir = tempDir();
		const ops: Operations = {
			...defaultOperations(),
			stat: async () => Promise.reject(refusal("EACCES")),
		};

		const text = await textOf(createLsTool(dir, ops), { path: dir });

		expect(text).toBe(`Permission denied: ${normalized(dir)}`);
		expect(text).not.toContain("not found");
	});

	test("LS names a listing refusal, not a missing directory", async () => {
		const dir = tempDir();
		const base = defaultOperations();
		const ops: Operations = {
			...base,
			readdir: async () => Promise.reject(refusal("EACCES")),
		};

		const text = await textOf(createLsTool(dir, ops), { path: dir });

		expect(text).toBe(`Permission denied: ${normalized(dir)}`);
	});

	test("Grep counts the files it could not open instead of saying no matches", async () => {
		const dir = tempDir();
		const open = join(dir, "open.txt");
		const locked = join(dir, "locked.txt");
		writeFileSync(open, "needle here\n");
		writeFileSync(locked, "needle there\n");
		const base = defaultOperations();
		const ops: Operations = {
			...base,
			readTextFile: async (path) => {
				if (normalized(path) === normalized(locked)) throw refusal("EACCES");
				return base.readTextFile(path);
			},
		};

		const result = await createGrepTool(dir, ops).call({ pattern: "needle", path: dir }, ctx());
		const text = (result.content[0] as { text: string }).text;

		expect(text).toContain("open.txt:1: needle here");
		// The header ends in `:`, and the count sits before it.
		expect(text.split("\n")[0]).toContain("1 unreadable file(s) skipped");
	});

	test("Glob says a directory it could not walk was skipped", async () => {
		const dir = tempDir();
		const open = join(dir, "open");
		const locked = join(dir, "locked");
		mkdirSync(open);
		mkdirSync(locked);
		writeFileSync(join(open, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(locked, "b.ts"), "export const b = 2;\n");
		const base = defaultOperations();
		const ops: Operations = {
			...base,
			readdir: async (path) => {
				if (normalized(path) === normalized(locked)) throw refusal("EACCES");
				return base.readdir(path);
			},
		};

		const result = await createGlobTool(dir, ops).call({ pattern: "**/*.ts", path: dir }, ctx());
		const text = (result.content[0] as { text: string }).text;

		expect(text).toContain(normalized(join(open, "a.ts")));
		expect(text).not.toContain("b.ts");
		expect(text).toContain("[skipped 1 unreadable directory]");
	});

	test("a directory that vanished mid-walk is not reported as unreadable", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "gone"));
		const base = defaultOperations();
		const ops: Operations = {
			...base,
			readdir: async (path) => {
				if (normalized(path) === normalized(join(dir, "gone"))) throw refusal("ENOENT");
				return base.readdir(path);
			},
		};

		const result = await createGlobTool(dir, ops).call({ pattern: "**/*.ts", path: dir }, ctx());
		const text = (result.content[0] as { text: string }).text;

		expect(text).toBe("No files matched.");
	});
});
