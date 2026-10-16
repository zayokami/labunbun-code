/**
 * `digest.ts` — the hash must be the file's bytes and nothing else.
 *
 * The values below are published SHA-256 vectors (FIPS 180-2): `abc`, the
 * empty string, and the famous one-million-`a` message. The last one is the
 * point — a whole-file read could pass it by accident, but a chunked update
 * can only pass it by being right, which is the streaming claim under test.
 * The error rows are the other half of the tool's contract: a bad path is a
 * bad line, never a failed report, because the moment this tool matters is the
 * moment the caller is diffing two trees and one name is misspelled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDigestTool } from "../src/digest.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-digest-"));
	roots.push(dir);
	return dir;
}

const ctx = (cwd: string) => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd,
	sandbox: "workspace-write" as const,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
});

function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { text: string }).text;
}

describe("Digest hashes file content", () => {
	test("published vectors come back intact, including the streaming path", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "abc.txt"), "abc");
		writeFileSync(join(dir, "empty.txt"), "");
		writeFileSync(join(dir, "million-a.bin"), "a".repeat(1_000_000));

		const result = await createDigestTool(dir).call({ paths: ["abc.txt", "empty.txt", "million-a.bin"] }, ctx(dir));

		expect(textOf(result).split("\n")).toEqual([
			"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  abc.txt",
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.txt",
			"sha256:cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0  million-a.bin",
		]);
		expect(result.isError).toBeFalsy();
	}, 60_000);

	test("the hash follows the content, not the name or the spelling of the path", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "left.txt"), "same bytes");
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "right.txt"), "same bytes");

		const result = await createDigestTool(dir).call(
			{ paths: ["left.txt", "sub/right.txt", join(dir, "left.txt")] },
			ctx(dir),
		);

		const hashes = textOf(result)
			.split("\n")
			.map((line) => /^sha256:([0-9a-f]{64}) {2}/.exec(line)?.[1]);
		expect(hashes[0]).toBeDefined();
		expect(hashes[0]).toBe(hashes[1]);
		expect(hashes[0]).toBe(hashes[2]);
	});

	test("a missing file and a directory cost one line each; the rest still hash", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "real.txt"), "real");
		mkdirSync(join(dir, "a-dir"));

		const result = await createDigestTool(dir).call({ paths: ["missing.txt", "a-dir", "real.txt"] }, ctx(dir));
		const lines = textOf(result).split("\n");

		expect(lines[0]).toBe("Digest: missing.txt: not found");
		expect(lines[1]).toBe("Digest: a-dir: is a directory");
		expect(lines[2]).toMatch(/^sha256:[0-9a-f]{64} {2}real\.txt$/);
		expect(result.isError).toBeFalsy();
	});

	test("a path outside the workspace is refused by name, as its own line", async () => {
		const dir = tempDir();

		const outside = await createDigestTool(dir).call({ paths: ["../outside.txt"] }, ctx(dir));

		expect(textOf(outside)).toContain("resolves outside workspace");
	});

	test("no paths is a schema error, and the tool declares itself read-only", () => {
		const tool = createDigestTool(process.cwd());

		expect(tool.inputSchema.safeParse({ paths: [] }).success).toBe(false);
		expect(tool.inputSchema.safeParse({ paths: ["a.txt"] }).success).toBe(true);
		// The declaration the plan-mode allow-list is held against
		// (plan-mode-allowlist.test.ts walks the live tools).
		expect(tool.isReadOnly?.({ paths: ["a.txt"] })).toBe(true);
	});
});
