/**
 * `compare-artifacts.ts` — membership and content across two packages.
 *
 * The tests are built from the same byte-level zip and ASAR fixtures the
 * artifact reader uses, plus directories written file by file, so a case can
 * say exactly which container shape it is testing. Each comparison is checked
 * against the facts the report claims — counts, status, the paths listed — and
 * the sources are read before and after the call to show that comparing two
 * packages did not change either one or extract anything beside them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCompareArtifactsTool } from "../src/compare-artifacts.ts";
import { buildAsar, buildZip, encoder, writeFixture } from "./archive-fixtures.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-compare-artifacts-"));
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

function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
	for (const [name, data] of Object.entries(files)) {
		const full = join(root, name);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, data);
	}
}

async function compare(cwd: string, left: string, right: string) {
	const result = await createCompareArtifactsTool(cwd).call({ left, right }, ctx(cwd));
	return { result, text: textOf(result) };
}

function contentDigests(text: string): string[] {
	return [...text.matchAll(/content digest sha256:([0-9a-f]{64})/g)].map((match) => match[1] as string);
}

describe("CompareArtifacts compares directories", () => {
	test("two identical trees are unchanged, with equal aggregate digests and no litter", async () => {
		const dir = tempDir();
		const files = { "a.txt": "alpha", "sub/b.bin": Uint8Array.from([0, 1, 2, 255]) };
		writeTree(join(dir, "left"), files);
		writeTree(join(dir, "right"), files);
		const beforeLeft = readFileSync(join(dir, "left", "a.txt"));
		const beforeRight = readFileSync(join(dir, "right", "sub/b.bin"));

		const { result, text } = await compare(dir, "left", "right");

		expect(result.isError).toBeFalsy();
		expect(text).toContain("left: left (directory, 2 file(s), content digest sha256:");
		expect(text).toContain("right: right (directory, 2 file(s), content digest sha256:");
		expect(text).toContain("compared paths: 2");
		expect(text).toContain("unchanged: 2");
		expect(text).toContain("added: 0");
		expect(text).toContain("removed: 0");
		expect(text).toContain("changed: 0");
		expect(text).toContain("unknown: 0");
		expect(text).toContain("status: unchanged");
		expect(text).toContain("changes: none");
		const digests = contentDigests(text);
		expect(digests).toHaveLength(2);
		expect(digests[0]).toBe(digests[1]);
		expect(readFileSync(join(dir, "left", "a.txt")).equals(beforeLeft)).toBe(true);
		expect(readFileSync(join(dir, "right", "sub/b.bin")).equals(beforeRight)).toBe(true);
		expect(readdirSync(join(dir, "left")).sort()).toEqual(["a.txt", "sub"]);
		expect(readdirSync(join(dir, "right")).sort()).toEqual(["a.txt", "sub"]);
	});

	test("changed, added and removed paths are counted and listed in sorted order", async () => {
		const dir = tempDir();
		writeTree(join(dir, "left"), { "a.txt": "same", "b.txt": "left", "gone.txt": "old" });
		writeTree(join(dir, "right"), { "a.txt": "same", "b.txt": "right", "new.txt": "new" });

		const { text } = await compare(dir, "left", "right");

		expect(text).toContain("unchanged: 1");
		expect(text).toContain("added: 1");
		expect(text).toContain("removed: 1");
		expect(text).toContain("changed: 1");
		expect(text).toContain("status: changed");
		expect(text).toContain("~ b.txt: size 4 -> 5; sha256:");
		expect(text).toContain("- gone.txt");
		expect(text).toContain("+ new.txt");
		expect(text.indexOf("~ b.txt")).toBeLessThan(text.indexOf("- gone.txt"));
		expect(text.indexOf("- gone.txt")).toBeLessThan(text.indexOf("+ new.txt"));
	});

	test("two plain files are compared by base name and bytes", async () => {
		const dir = tempDir();
		writeTree(join(dir, "left"), { "one.bin": Uint8Array.from([1, 2, 3]) });
		writeTree(join(dir, "right"), { "one.bin": Uint8Array.from([1, 2, 3]) });

		const same = await compare(dir, "left/one.bin", "right/one.bin");
		expect(same.text).toContain("left/one.bin (file, 1 file(s)");
		expect(same.text).toContain("status: unchanged");

		writeTree(join(dir, "right"), { "one.bin": Uint8Array.from([1, 2, 4]) });
		const changed = await compare(dir, "left/one.bin", "right/one.bin");
		expect(changed.text).toContain("~ one.bin: sha256:");
		expect(changed.text).toContain("status: changed");
	});
});

describe("CompareArtifacts reads archives without extracting them", () => {
	test("a directory and a deflated zip with the same files are unchanged", async () => {
		const dir = tempDir();
		writeTree(join(dir, "left"), { "a.txt": "hello", "sub/b.txt": "world" });
		const zip = buildZip({
			entries: [
				{ name: "a.txt", data: encoder.encode("hello") },
				{ name: "sub\\b.txt", data: encoder.encode("world"), method: 8 },
			],
		});
		writeFixture(dir, "right.zip", zip.bytes);
		const before = readFileSync(join(dir, "right.zip"));

		const { text } = await compare(dir, "left", "right.zip");

		expect(text).toContain("left: left (directory, 2 file(s)");
		expect(text).toContain("right: right.zip (zip, 2 file(s)");
		expect(text).toContain("unchanged: 2");
		expect(text).toContain("status: unchanged");
		const digests = contentDigests(text);
		expect(digests).toHaveLength(2);
		expect(digests[0]).toBe(digests[1]);
		expect(readFileSync(join(dir, "right.zip")).equals(before)).toBe(true);
	});

	test("a zip and an ASAR with the same member are unchanged", async () => {
		const dir = tempDir();
		const zip = buildZip({ entries: [{ name: "a.txt", data: encoder.encode("hello") }] });
		writeFixture(dir, "left.zip", zip.bytes);
		writeFileSync(join(dir, "right.asar"), buildAsar({ "a.txt": { size: 5, offset: 0 } }, encoder.encode("hello")));

		const { text } = await compare(dir, "left.zip", "right.asar");

		expect(text).toContain("left: left.zip (zip, 1 file(s)");
		expect(text).toContain("right: right.asar (asar, 1 file(s)");
		expect(text).toContain("unchanged: 1");
		expect(text).toContain("status: unchanged");
		expect(contentDigests(text)[0]).toBe(contentDigests(text)[1]);
	});

	test("ASAR links compare by target and unpacked entries stay unknown", async () => {
		const dir = tempDir();
		const files = {
			"a.txt": { size: 1, offset: 0 },
			ln: { link: "a.txt" },
			"u.bin": { size: 1, unpacked: true },
		};
		writeFileSync(join(dir, "left.asar"), buildAsar(files, encoder.encode("x")));
		writeFileSync(join(dir, "right.asar"), buildAsar(files, encoder.encode("x")));

		const { text } = await compare(dir, "left.asar", "right.asar");

		expect(text).toContain("unchanged: 2");
		expect(text).toContain("unknown: 1");
		expect(text).toContain("status: partial");
		expect(text).toContain("? u.bin: the entry is unpacked outside the archive");
		expect(text).toContain("could not be hashed");
	});

	test("an ASAR compared with itself is unchanged", async () => {
		const dir = tempDir();
		const files = { "a.txt": { size: 1, offset: 0 } };
		writeFileSync(join(dir, "a.asar"), buildAsar(files, encoder.encode("x")));
		const { text } = await compare(dir, "a.asar", "a.asar");
		expect(text).toContain("unchanged: 1");
	});
});

describe("CompareArtifacts refuses to guess", () => {
	test("an encrypted entry is unknown, not equal to a plain file", async () => {
		const dir = tempDir();
		const zip = buildZip({ entries: [{ name: "a.txt", data: encoder.encode("hello"), flags: 1 }] });
		writeFixture(dir, "left.zip", zip.bytes);
		writeTree(join(dir, "right"), { "a.txt": "hello" });

		const { text } = await compare(dir, "left.zip", "right");

		expect(text).toContain("unknown: 1");
		expect(text).toContain("status: unknown");
		expect(text).toContain("? a.txt: the entry is encrypted");
		expect(text).toContain("content digest not computed");
	});

	test("an unsupported compression method is unknown", async () => {
		const dir = tempDir();
		const zip = buildZip({ entries: [{ name: "a.txt", data: encoder.encode("hello"), method: 12 }] });
		writeFixture(dir, "left.zip", zip.bytes);
		writeTree(join(dir, "right"), { "a.txt": "hello" });

		const { text } = await compare(dir, "left.zip", "right");
		expect(text).toContain("? a.txt: compression method 12 is not supported");
		expect(text).toContain("status: unknown");
	});

	test("a name used twice in one archive is unknown rather than merged", async () => {
		const dir = tempDir();
		const zip = buildZip({
			entries: [
				{ name: "a.txt", data: encoder.encode("one") },
				{ name: "a.txt", data: encoder.encode("two") },
			],
		});
		writeFixture(dir, "dup.zip", zip.bytes);

		const { text } = await compare(dir, "dup.zip", "dup.zip");

		expect(text).toContain("compared paths: 1");
		expect(text).toContain("unknown: 1");
		expect(text).toContain("status: unknown");
		expect(text).toContain("more than once");
	});

	test("two entries that normalize to one path are unknown", async () => {
		const dir = tempDir();
		const zip = buildZip({
			entries: [
				{ name: "a\\b.txt", data: encoder.encode("one") },
				{ name: "a/b.txt", data: encoder.encode("two") },
			],
		});
		writeFixture(dir, "collision.zip", zip.bytes);

		const { text } = await compare(dir, "collision.zip", "collision.zip");
		expect(text).toContain("compared paths: 1");
		expect(text).toContain("status: unknown");
		expect(text).toContain("two archive entries normalize to this path");
	});

	test("a symlink is compared by target and is not followed", async () => {
		if (process.platform === "win32") return;
		const dir = tempDir();
		for (const side of ["left", "right"]) {
			writeTree(join(dir, side), { "real.txt": "same", "other.txt": "other" });
			symlinkSync("real.txt", join(dir, side, "link.txt"));
		}

		const same = await compare(dir, "left", "right");
		expect(same.text).toContain("unchanged: 3");
		expect(same.text).toContain("status: unchanged");

		rmSync(join(dir, "right", "link.txt"));
		symlinkSync("other.txt", join(dir, "right", "link.txt"));
		const changed = await compare(dir, "left", "right");
		expect(changed.text).toContain("~ link.txt: size 8 -> 9");
		expect(changed.text).toContain("status: changed");
	});
});

describe("CompareArtifacts is bounded and honest about paths", () => {
	test("only 200 changes are listed and the rest are counted", async () => {
		const dir = tempDir();
		const left: Record<string, string> = {};
		const right: Record<string, string> = {};
		for (let index = 0; index < 205; index += 1) {
			const name = `f${String(index).padStart(3, "0")}.txt`;
			left[name] = "a";
			right[name] = "bb";
		}
		writeTree(join(dir, "left"), left);
		writeTree(join(dir, "right"), right);

		const { text } = await compare(dir, "left", "right");

		expect(text).toContain("changed: 205");
		expect(text).toContain("... 5 more change(s) not listed (the list stops at 200)");
		expect(text.split("\n").filter((line) => line.startsWith("  ~ "))).toHaveLength(200);
	});

	test("a path outside the workspace and a missing path are errors", async () => {
		const dir = tempDir();
		writeTree(join(dir, "right"), { "a.txt": "x" });

		const outside = await compare(dir, "../outside.txt", "right");
		expect(outside.result.isError).toBe(true);
		expect(outside.text).toContain("outside workspace");

		const missing = await compare(dir, "nope", "right");
		expect(missing.result.isError).toBe(true);
		expect(missing.text).toContain("Path not found");
	});

	test("a malformed archive is an error, not a comparison", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "broken.zip"), Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
		writeTree(join(dir, "right"), { "a.txt": "x" });

		const { result, text } = await compare(dir, "broken.zip", "right");
		expect(result.isError).toBe(true);
		expect(text).toContain("CompareArtifacts:");
		expect(text).toContain("too small to be a zip");
	});
});
