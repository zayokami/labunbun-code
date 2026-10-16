/**
 * `artifact.ts` — what the reader reports about containers it never unpacks.
 *
 * Every archive in this file is built byte by byte: a zip from its local
 * headers and data, then its central directory records, then its EOCD record
 * (and, where the case needs them, the ZIP64 record and locator before it);
 * an ASAR from its 8-byte pickle, a padded JSON header and some payload
 * bytes. No binary fixture enters the repository and nothing is downloaded,
 * and a builder says exactly which field sits at which offset where a hex
 * blob would leave that to be reverse-engineered.
 *
 * The fixtures are also the measurement of the promise: the source's bytes
 * are held against the bytes after the call and the directory is checked for
 * litter, because "only the directory was read" and "nothing was extracted"
 * are the facts the caller is relying on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createInspectArtifactTool } from "../src/artifact.ts";

const roots: string[] = [];
afterEach(() => {
	// A Windows handle can outlive the call that closed it by a beat, so the
	// removal retries; a directory that still lingers is left to the OS
	// temp cleaner rather than failing a suite whose work is done.
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-inspect-artifact-"));
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

const encoder = new TextEncoder();

function byteArray(values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];

const le32 = (value: number): number[] => [
	value & 0xff,
	(value >>> 8) & 0xff,
	(value >>> 16) & 0xff,
	(value >>> 24) & 0xff,
];

const le64 = (value: number): number[] => le32(value % 0x1_0000_0000).concat(le32(Math.floor(value / 0x1_0000_0000)));

const u32At = (source: Uint8Array, at: number): number =>
	(source[at] | (source[at + 1] << 8) | (source[at + 2] << 16) | (source[at + 3] << 24)) >>> 0;

const crc32 = (data: Uint8Array): number => Bun.hash.crc32(data) >>> 0;

const hex32 = (value: number): string => value.toString(16).padStart(8, "0").toUpperCase();

/** The DOS words for 2024-01-02 03:04:06, the time the zip fixtures carry unless they opt out. */
const DOS_DATE = (44 << 9) | (1 << 5) | 2;
const DOS_TIME = (3 << 11) | (4 << 5) | 3;

interface FixtureEntry {
	name: string;
	data: Uint8Array;
	/** 0 = store, 8 = deflate through node:zlib; the reader decompresses neither. */
	method?: 0 | 8;
	/** Write both sizes as ZIP64 sentinels in the central record, with the real values in a 0x0001 extra field. */
	zip64Sizes?: boolean;
	/** DOS date/time words; 0/0 renders as "no mtime". */
	date?: number;
	time?: number;
}

interface ZipFixture {
	bytes: Uint8Array;
	/** Absolute offset of the EOCD record, for tests that patch its fields. */
	eocdAt: number;
}

/**
 * A zip assembled in file order: each entry's local header and data, the
 * central directory, then the EOCD record. With `zip64` the trailing three
 * records are the ZIP64 EOCD record, its locator, and an EOCD record whose
 * count and directory fields hold the all-ones sentinels — the shape a
 * file bigger than 4 GiB (or one whose writer always uses ZIP64) has.
 */
function buildZip(options: { entries: FixtureEntry[]; comment?: string; zip64?: boolean }): ZipFixture {
	const chunks: Uint8Array[] = [];
	const central: number[] = [];
	let localOffset = 0;
	for (const entry of options.entries) {
		const name = encoder.encode(entry.name);
		const method = entry.method ?? 0;
		const stored = method === 8 ? deflateRawSync(entry.data) : entry.data;
		const crc = crc32(entry.data);
		const date = entry.date ?? DOS_DATE;
		const time = entry.time ?? DOS_TIME;
		const local = [
			...le32(0x04034b50),
			...le16(20),
			...le16(0),
			...le16(method),
			...le16(time),
			...le16(date),
			...le32(crc),
			...le32(stored.length),
			...le32(entry.data.length),
			...le16(name.length),
			...le16(0),
		];
		chunks.push(byteArray(local), name, stored);
		const zip64Extra = entry.zip64Sizes
			? [...le16(0x0001), ...le16(16), ...le64(entry.data.length), ...le64(stored.length)]
			: [];
		central.push(
			...le32(0x02014b50),
			...le16(20),
			...le16(20),
			...le16(0),
			...le16(method),
			...le16(time),
			...le16(date),
			...le32(crc),
			...le32(entry.zip64Sizes ? 0xffffffff : stored.length),
			...le32(entry.zip64Sizes ? 0xffffffff : entry.data.length),
			...le16(name.length),
			...le16(zip64Extra.length),
			...le16(0),
			...le16(0),
			...le16(0),
			...le32(0),
			...le32(localOffset),
			...name,
			...zip64Extra,
		);
		localOffset += local.length + name.length + stored.length;
	}
	const centralBytes = byteArray(central);
	chunks.push(centralBytes);
	const centralOffset = localOffset;
	const comment = encoder.encode(options.comment ?? "");
	const entryCount = options.entries.length;
	let eocd: number[];
	if (options.zip64) {
		const recordOffset = centralOffset + centralBytes.length;
		const record = [
			...le32(0x06064b50),
			...le64(44),
			...le16(45),
			...le16(45),
			...le32(0),
			...le32(0),
			...le64(entryCount),
			...le64(entryCount),
			...le64(centralBytes.length),
			...le64(centralOffset),
		];
		const locator = [...le32(0x07064b50), ...le32(0), ...le64(recordOffset), ...le32(1)];
		chunks.push(byteArray(record), byteArray(locator));
		eocd = [
			...le32(0x06054b50),
			...le16(0),
			...le16(0),
			...le16(0xffff),
			...le16(0xffff),
			...le32(0xffffffff),
			...le32(0xffffffff),
			...le16(comment.length),
		];
	} else {
		eocd = [
			...le32(0x06054b50),
			...le16(0),
			...le16(0),
			...le16(entryCount),
			...le16(entryCount),
			...le32(centralBytes.length),
			...le32(centralOffset),
			...le16(comment.length),
		];
	}
	const eocdAt = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	chunks.push(byteArray(eocd), comment);
	return { bytes: concat(chunks), eocdAt };
}

/** The JSON header's padded byte length, the number the report must print. */
function asarHeaderSize(files: Record<string, unknown>): number {
	const json = encoder.encode(JSON.stringify({ files }));
	return (json.length + 3) & ~3;
}

/** An ASAR: the 8-byte pickle (payload size 4, then the JSON's length), the padded JSON, then payload bytes. */
function buildAsar(files: Record<string, unknown>, payload = new Uint8Array(16)): Uint8Array {
	const json = encoder.encode(JSON.stringify({ files }));
	const size = (json.length + 3) & ~3;
	const header = new Uint8Array(size);
	header.set(json);
	return concat([byteArray([...le32(4), ...le32(size)]), header, payload]);
}

function writeFixture(dir: string, name: string, bytes: Uint8Array): string {
	writeFileSync(join(dir, name), bytes);
	return name;
}

describe("the fixtures themselves", () => {
	test("the CRC-32 the builder writes is the standard one (ISO 3309 check value)", () => {
		// The published check value over "123456789"; if this drifts, every
		// crc32 expectation below would be comparing the reader against itself.
		expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
	});
});

describe("InspectArtifact reads a zip's central directory", () => {
	test("reports entries, sizes, CRCs, times and totals, and leaves the file alone", async () => {
		const dir = tempDir();
		const hello = encoder.encode("hello world");
		const weird = encoder.encode("hi");
		const fixture = buildZip({
			entries: [
				{ name: "hello.txt", data: hello },
				{ name: "weird\nname.txt", data: weird, date: 0, time: 0 },
			],
		});
		writeFixture(dir, "hello.zip", fixture.bytes);

		const result = await createInspectArtifactTool(dir).call({ path: "hello.zip" }, ctx(dir));
		const text = textOf(result);

		expect(result.isError).toBeFalsy();
		expect(text).toContain("InspectArtifact report for hello.zip");
		expect(text).toContain("container: zip");
		expect(text).toContain("entries: 2");
		expect(text).toContain("compressed total: 13 bytes");
		expect(text).toContain("uncompressed total: 13 bytes");
		expect(text).toContain("ZIP64: no (no ZIP64 end-of-central-directory record)");
		expect(text).toContain("EOCD comment: none");
		expect(text).toMatch(/central directory: \d+ bytes at offset \d+/);
		expect(text).toContain("read scope: the end-of-central-directory record and the central directory");
		// Everything on the line comes from the central directory's own fields,
		// and each of them is held to the value the builder wrote.
		expect(text).toContain(
			`  1. hello.txt (store) 11 -> 11 bytes, crc32 0x${hex32(crc32(hello))}, mtime 2024-01-02T03:04:06`,
		);
		// A name is bytes in a file, so a newline inside one is escaped, not
		// allowed to break the line it is printed on.
		expect(text).toContain(`  2. weird\\x0aname.txt (store) 2 -> 2 bytes, crc32 0x${hex32(crc32(weird))}, no mtime`);

		expect(readFileSync(join(dir, "hello.zip")).equals(Buffer.from(fixture.bytes))).toBe(true);
		expect(readdirSync(dir)).toEqual(["hello.zip"]);
	});

	test("names the compression method and reports a deflate entry's stored sizes", async () => {
		const dir = tempDir();
		const raw = encoder.encode("zip ".repeat(400));
		const stored = deflateRawSync(raw);
		expect(stored.length).toBeLessThan(raw.length);
		writeFixture(dir, "packed.zip", buildZip({ entries: [{ name: "big.txt", data: raw, method: 8 }] }).bytes);

		const text = textOf(await createInspectArtifactTool(dir).call({ path: "packed.zip" }, ctx(dir)));

		expect(text).toContain(
			`  1. big.txt (deflate) ${stored.length} -> ${raw.length} bytes, crc32 0x${hex32(crc32(raw))}, mtime 2024-01-02T03:04:06`,
		);
		expect(text).toContain(`compressed total: ${stored.length} bytes`);
		expect(text).toContain(`uncompressed total: ${raw.length} bytes`);
	});

	test("finds the EOCD record past a comment, even one holding the record's own signature bytes", async () => {
		const dir = tempDir();
		const comment = "made by a fixture, not a binary";
		writeFixture(
			dir,
			"commented.zip",
			buildZip({ entries: [{ name: "a.txt", data: encoder.encode("hi") }], comment }).bytes,
		);

		const text = textOf(await createInspectArtifactTool(dir).call({ path: "commented.zip" }, ctx(dir)));
		expect(text).toContain(`EOCD comment: present (${comment.length} bytes)`);
		expect(text).toContain("entries: 1");
		expect(text).toContain("a.txt (store) 2 -> 2 bytes");

		// The trap: the comment holds the bytes `PK\x05\x06` themselves, so a
		// scan that took the last signature-looking run would read the comment
		// as a record. The comment-length identity is what tells them apart.
		const evil = "PK\u0005\u0006 then words so the run sits inside the scan window";
		writeFixture(
			dir,
			"evil-comment.zip",
			buildZip({ entries: [{ name: "b.txt", data: encoder.encode("hi") }], comment: evil }).bytes,
		);

		const evilText = textOf(await createInspectArtifactTool(dir).call({ path: "evil-comment.zip" }, ctx(dir)));
		expect(evilText).toContain(`EOCD comment: present (${evil.length} bytes)`);
		expect(evilText).toContain("entries: 1");
		expect(evilText).toContain("b.txt (store) 2 -> 2 bytes");
	});

	test("reads ZIP64: the EOCD record's sentinels, the locator, and a per-entry 0x0001 extra field", async () => {
		const dir = tempDir();
		const payload = encoder.encode("tiny payload");
		writeFixture(
			dir,
			"small-but-zip64.zip",
			buildZip({ entries: [{ name: "big.bin", data: payload, zip64Sizes: true }], zip64: true }).bytes,
		);

		const text = textOf(await createInspectArtifactTool(dir).call({ path: "small-but-zip64.zip" }, ctx(dir)));

		expect(text).toMatch(/ZIP64: yes \(end-of-central-directory record at offset \d+\)/);
		// The counts come from the ZIP64 record, not from the EOCD record's
		// 0xFFFF sentinels, and the sizes come from the extra field, not from
		// the 0xFFFFFFFF slots.
		expect(text).toContain("entries: 1");
		expect(text).toContain(
			`  1. big.bin (store) 12 -> 12 bytes [zip64 extra], crc32 0x${hex32(crc32(payload))}, mtime 2024-01-02T03:04:06`,
		);
		expect(text).toContain("compressed total: 12 bytes");
		expect(text).toContain("uncompressed total: 12 bytes");
		expect(text).not.toContain("4294967295");
	});

	test("stops the entry list at 200 and says how many were left", async () => {
		const dir = tempDir();
		const entries: FixtureEntry[] = [];
		for (let i = 0; i < 250; i++) {
			entries.push({ name: `f${String(i).padStart(3, "0")}.txt`, data: byteArray([0x78]), date: 0, time: 0 });
		}
		writeFixture(dir, "many.zip", buildZip({ entries }).bytes);

		const text = textOf(await createInspectArtifactTool(dir).call({ path: "many.zip" }, ctx(dir)));

		expect(text).toContain("entries: 250");
		expect(text).toContain("  200. f199.txt");
		expect(text).not.toContain("f200.txt");
		expect(text).toContain("... 50 more entries not listed (the list stops at 200)");
		// The count of what is missing has to survive the report's own cap, or
		// the reader is told the listing ended at 200 with no hint there was
		// anything past it.
		expect(text).not.toContain("[truncated");
	});

	test("caps the whole report and marks what it cut", async () => {
		const dir = tempDir();
		const longName = `entry-${"x".repeat(120)}.txt`;
		const entries: FixtureEntry[] = [];
		for (let i = 0; i < 200; i++) entries.push({ name: longName, data: new Uint8Array(0) });
		writeFixture(dir, "wide.zip", buildZip({ entries }).bytes);

		const text = textOf(await createInspectArtifactTool(dir).call({ path: "wide.zip" }, ctx(dir)));

		expect(text).toContain("container: zip");
		expect(text).toContain("entries: 200");
		expect(text).toMatch(/\.\.\. \[truncated \d+ chars of output\]$/);
		expect(text.length).toBeLessThan(21_000);
	});

	test("refuses an archive that ends early, and a directory that runs past the file", async () => {
		const dir = tempDir();
		const tool = createInspectArtifactTool(dir);
		const fixture = buildZip({ entries: [{ name: "a.txt", data: encoder.encode("hi") }] });

		// The EOCD record cut off: nothing after the central directory.
		writeFixture(dir, "headless.zip", fixture.bytes.subarray(0, fixture.bytes.length - 22));
		const headless = await tool.call({ path: "headless.zip" }, ctx(dir));
		expect(headless.isError).toBe(true);
		expect(textOf(headless)).toContain("no end-of-central-directory record");

		// The EOCD record's own directory size inflated: the bounds no longer
		// match the file it sits in.
		const overrun = Uint8Array.from(fixture.bytes);
		overrun.set(byteArray(le32(0x0000f000)), fixture.eocdAt + 12);
		writeFixture(dir, "overrun.zip", overrun);
		const overrunResult = await tool.call({ path: "overrun.zip" }, ctx(dir));
		expect(overrunResult.isError).toBe(true);
		expect(textOf(overrunResult)).toContain("runs past the end of the");

		// The directory's first record loses its signature.
		const corrupt = Uint8Array.from(fixture.bytes);
		corrupt[u32At(fixture.bytes, fixture.eocdAt + 16)] = 0x00;
		writeFixture(dir, "corrupt.zip", corrupt);
		const corruptResult = await tool.call({ path: "corrupt.zip" }, ctx(dir));
		expect(corruptResult.isError).toBe(true);
		expect(textOf(corruptResult)).toContain("does not start with the entry signature");

		// ZIP64 sentinels with no ZIP64 record to resolve them.
		const sentinel = Uint8Array.from(fixture.bytes);
		sentinel.set(byteArray(le32(0xffffffff)), fixture.eocdAt + 16);
		writeFixture(dir, "sentinel.zip", sentinel);
		const sentinelResult = await tool.call({ path: "sentinel.zip" }, ctx(dir));
		expect(sentinelResult.isError).toBe(true);
		expect(textOf(sentinelResult)).toContain("no ZIP64 EOCD locator follows the record");

		// A size left as the sentinel with the extra field it needs removed.
		const bare = Uint8Array.from(fixture.bytes);
		const recordAt = u32At(fixture.bytes, fixture.eocdAt + 16);
		bare.set(byteArray(le32(0xffffffff)), recordAt + 20);
		writeFixture(dir, "bare.zip", bare);
		const bareResult = await tool.call({ path: "bare.zip" }, ctx(dir));
		expect(bareResult.isError).toBe(true);
		expect(textOf(bareResult)).toContain("no ZIP64 extra field is present");
	});

	test("a compression method with no APPNOTE name keeps its number", async () => {
		const dir = tempDir();
		const fixture = buildZip({ entries: [{ name: "odd.bin", data: encoder.encode("x") }] });
		// 0 reads as store and 8 as deflate; 16 has no name and must not be
		// invented into one.
		const patched = Uint8Array.from(fixture.bytes);
		patched.set(byteArray(le16(16)), u32At(fixture.bytes, fixture.eocdAt + 16) + 10);
		writeFixture(dir, "odd.zip", patched);

		const text = textOf(await createInspectArtifactTool(dir).call({ path: "odd.zip" }, ctx(dir)));

		expect(text).toContain("odd.bin (method 16)");
	});

	test("refuses a file that starts like a zip but is too short to hold one", async () => {
		const dir = tempDir();
		writeFixture(dir, "tiny.zip", byteArray([0x50, 0x4b, 0x03, 0x04]));

		const result = await createInspectArtifactTool(dir).call({ path: "tiny.zip" }, ctx(dir));

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("too small to be a zip");
	});
});

describe("InspectArtifact reads an ASAR header", () => {
	test("reports the header's size, the counts, the top level and the file list", async () => {
		const dir = tempDir();
		const files = {
			"main.js": { size: 12, offset: "4096" },
			assets: { files: { "a.txt": { size: 3, offset: "4108" }, "native.node": { size: 100, unpacked: true } } },
			"link.js": { link: "main.js" },
			"bogus.txt": "a string where a node should be",
		};
		const asar = buildAsar(files);
		writeFixture(dir, "app.asar", asar);

		const result = await createInspectArtifactTool(dir).call({ path: "app.asar" }, ctx(dir));
		const text = textOf(result);
		const headerSize = asarHeaderSize(files);

		expect(result.isError).toBeFalsy();
		expect(text).toContain("InspectArtifact report for app.asar");
		expect(text).toContain("container: asar (Electron archive)");
		expect(text).toContain(`JSON header: ${headerSize} bytes (file data begins at byte ${8 + headerSize})`);
		expect(text).toContain("files: 4, directories: 1");
		expect(text).toContain("unpacked files: 1");
		expect(text).toContain("read scope: the JSON header; no file data was read, decompressed, or written");
		expect(text).toContain("top level:");
		expect(text).toContain("  main.js (12 bytes)");
		expect(text).toContain("  assets/ (directory, 2 entries)");
		expect(text).toContain("  link.js -> main.js (link)");
		expect(text).toContain("  1. main.js 12 bytes at offset 4096");
		expect(text).toContain("  2. assets/a.txt 3 bytes at offset 4108");
		expect(text).toContain(
			"  3. assets/native.node 100 bytes, unpacked (its bytes sit in the .unpacked directory beside the archive)",
		);
		expect(text).toContain("  4. link.js -> main.js (link)");
		// The node that is neither a file, a directory nor a link is counted
		// and reported, not printed as if it were one of them.
		expect(text).toContain("note: 1 node(s) in the header tree are neither a file, a directory, nor a link");
		expect(text).not.toContain("bogus.txt");

		expect(readFileSync(join(dir, "app.asar")).equals(Buffer.from(asar))).toBe(true);
		expect(readdirSync(dir)).toEqual(["app.asar"]);
	});

	test("stops the entry list at 200 and says how many were left", async () => {
		const dir = tempDir();
		const files: Record<string, unknown> = {};
		for (let i = 0; i < 230; i++) files[`f${String(i).padStart(3, "0")}.txt`] = { size: 2, offset: "0" };
		writeFixture(dir, "many.asar", buildAsar(files));

		const text = textOf(await createInspectArtifactTool(dir).call({ path: "many.asar" }, ctx(dir)));

		expect(text).toContain("files: 230, directories: 0");
		expect(text).toContain("  200. f199.txt 2 bytes at offset 0");
		expect(text).not.toContain("f200.txt");
		expect(text).toContain("... 30 more entries not listed (the list stops at 200)");
		// The top-level section is a listing too, and a package with 230 files
		// at its root would otherwise print them twice past the cap.
		expect(text).toContain("... 30 more top-level entries not listed (the list stops at 200)");
		expect(text).not.toContain("[truncated");
	});

	test("refuses a header whose JSON does not parse, and one without a files map", async () => {
		const dir = tempDir();
		const tool = createInspectArtifactTool(dir);

		writeFixture(
			dir,
			"broken.asar",
			concat([byteArray([...le32(4), ...le32(12)]), encoder.encode("{broken json"), new Uint8Array(8)]),
		);
		const broken = await tool.call({ path: "broken.asar" }, ctx(dir));
		expect(broken.isError).toBe(true);
		expect(textOf(broken)).toContain("the JSON header did not parse");

		const json = encoder.encode('{"a":1}');
		const header = new Uint8Array(8);
		header.set(json);
		writeFixture(dir, "no-files.asar", concat([byteArray([...le32(4), ...le32(8)]), header, new Uint8Array(8)]));
		const noFiles = await tool.call({ path: "no-files.asar" }, ctx(dir));
		expect(noFiles.isError).toBe(true);
		expect(textOf(noFiles)).toContain('has no "files" map');
	});
});

describe("InspectArtifact refuses what it cannot recognize", () => {
	test("a text file is refused with its first bytes in hex", async () => {
		const dir = tempDir();
		writeFixture(dir, "notes.txt", encoder.encode("just some text"));

		const result = await createInspectArtifactTool(dir).call({ path: "notes.txt" }, ctx(dir));

		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("unrecognized container");
		// "just some text" as the 14 bytes the probe read.
		expect(text).toContain("6A 75 73 74 20 73 6F 6D 65 20 74 65 78 74");
	});

	test("an empty file is refused the same way, without a hex dump of nothing", async () => {
		const dir = tempDir();
		writeFixture(dir, "empty.bin", new Uint8Array(0));

		const result = await createInspectArtifactTool(dir).call({ path: "empty.bin" }, ctx(dir));

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("(empty file)");
	});

	test("a missing path and a directory are each refused before any read", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "a-dir"));
		const tool = createInspectArtifactTool(dir);

		const missing = await tool.call({ path: "gone.zip" }, ctx(dir));
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("Path not found: gone.zip");

		const asDirectory = await tool.call({ path: "a-dir" }, ctx(dir));
		expect(asDirectory.isError).toBe(true);
		expect(textOf(asDirectory)).toContain("is a directory, not an archive file");
	});
});
