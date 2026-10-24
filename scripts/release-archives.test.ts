import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { buildAppImage, buildDeb, buildRpm, buildZip } from "./release-archives.ts";

type ArMember = { name: string; data: Buffer };

function parseAr(data: Buffer): ArMember[] {
	expect(data.subarray(0, 8).toString("ascii")).toBe("!<arch>\n");
	const members: ArMember[] = [];
	let offset = 8;
	while (offset + 60 <= data.length) {
		const header = data.subarray(offset, offset + 60);
		const name = header.subarray(0, 16).toString("ascii").trim().replace(/\/$/, "");
		const size = Number(header.subarray(48, 58).toString("ascii").trim());
		const start = offset + 60;
		members.push({ name, data: data.subarray(start, start + size) });
		offset = start + size + (size % 2);
	}
	return members;
}

type TarEntry = { name: string; mode: number; type: string; data: Buffer };

function parseTar(data: Buffer): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	while (offset + 512 <= data.length) {
		const header = data.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
		const mode = Number.parseInt(header.subarray(100, 108).toString("ascii").replace(/\0.*$/, ""), 8);
		const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, ""), 8);
		const type = header.subarray(156, 157).toString("ascii");
		const expected = Number.parseInt(header.subarray(148, 154).toString("ascii"), 8);
		const copy = Buffer.from(header);
		copy.fill(0x20, 148, 156);
		let checksum = 0;
		for (const byte of copy) checksum += byte;
		expect(checksum).toBe(expected);
		const start = offset + 512;
		entries.push({ name, mode, type, data: data.subarray(start, start + size) });
		offset = start + Math.ceil(size / 512) * 512;
	}
	return entries;
}

type ZipEntry = { name: string; method: number; crc: number; external: number; content: Buffer };

function parseZip(data: Buffer): ZipEntry[] {
	const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	expect(end).toBeGreaterThan(0);
	const count = data.readUInt16LE(end + 10);
	let cursor = data.readUInt32LE(end + 16);
	const entries: ZipEntry[] = [];
	for (let index = 0; index < count; index += 1) {
		expect(data.readUInt32LE(cursor)).toBe(0x02014b50);
		const method = data.readUInt16LE(cursor + 10);
		const crc = data.readUInt32LE(cursor + 16);
		const compressedSize = data.readUInt32LE(cursor + 20);
		const nameLength = data.readUInt16LE(cursor + 28);
		const extra = data.readUInt16LE(cursor + 30);
		const comment = data.readUInt16LE(cursor + 32);
		const external = data.readUInt32LE(cursor + 38);
		const localOffset = data.readUInt32LE(cursor + 42);
		const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		const localExtra = data.readUInt16LE(localOffset + 28);
		const localName = data.readUInt16LE(localOffset + 26);
		const start = localOffset + 30 + localName + localExtra;
		const compressed = data.subarray(start, start + compressedSize);
		entries.push({
			name,
			method,
			crc,
			external,
			content: method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed),
		});
		cursor += 46 + nameLength + extra + comment;
	}
	return entries;
}

describe("debian packages", () => {
	const binary = Buffer.from("binary payload");
	const readme = Buffer.from("readme text");
	const deb = buildDeb({
		packageName: "labunbun",
		version: "0.1.0~alpha1",
		architecture: "amd64",
		maintainer: "zayokami <labunbun@zayoka.com>",
		homepage: "https://example.invalid/labunbun",
		description: ["terminal coding agent", "Second line."],
		files: [
			{ path: "usr/bin/labunbun", mode: 0o755, data: binary },
			{ path: "usr/share/doc/labunbun/README.md", mode: 0o644, data: readme },
		],
		mtime: 1_700_000_000,
	});

	test("ar members are ordered the way dpkg expects", () => {
		const members = parseAr(deb);
		expect(members.map((member) => member.name)).toEqual(["debian-binary", "control.tar.gz", "data.tar.gz"]);
		expect(members[0].data.toString("ascii")).toBe("2.0\n");
	});

	test("control names the package, architecture, and dependency", () => {
		const control = parseTar(gunzipSync(parseAr(deb)[1].data)).find((entry) => entry.name === "./control");
		expect(control).toBeDefined();
		const text = control?.data.toString("utf8") ?? "";
		expect(text).toContain("Package: labunbun\n");
		expect(text).toContain("Version: 0.1.0~alpha1\n");
		expect(text).toContain("Architecture: amd64\n");
		expect(text).toContain("Depends: libc6 (>= 2.17)\n");
		expect(text).toContain("Description: terminal coding agent\n Second line.\n");
	});

	test("md5sums cover every data file", () => {
		const sums = parseTar(gunzipSync(parseAr(deb)[1].data)).find((entry) => entry.name === "./md5sums");
		const md5 = (data: Buffer) => createHash("md5").update(data).digest("hex");
		expect(sums?.data.toString("utf8")).toBe(
			`${md5(binary)}  usr/bin/labunbun\n${md5(readme)}  usr/share/doc/labunbun/README.md\n`,
		);
	});

	test("data members keep their modes and bytes", () => {
		const entries = parseTar(gunzipSync(parseAr(deb)[2].data));
		const main = entries.find((entry) => entry.name === "./usr/bin/labunbun");
		expect(main?.mode).toBe(0o755);
		expect(main?.data.equals(binary)).toBe(true);
		const documentation = entries.find((entry) => entry.name === "./usr/share/doc/labunbun/README.md");
		expect(documentation?.mode).toBe(0o644);
		expect(documentation?.data.equals(readme)).toBe(true);
		expect(entries.find((entry) => entry.name === "./usr/bin/")?.type).toBe("5");
	});
});

describe("darwin archives", () => {
	const binary = Buffer.from("mach-o stand-in");
	const zip = buildZip(
		[
			{ name: "root/", mode: 0o755, data: Buffer.alloc(0), directory: true },
			{ name: "root/labunbun", mode: 0o755, data: binary },
			{ name: "root/README.md", mode: 0o644, data: Buffer.from("readme") },
		],
		new Date(1_700_000_000_000),
	);

	test("the executable carries the Unix execute bit and its bytes", () => {
		const entries = parseZip(zip);
		const main = entries.find((entry) => entry.name === "root/labunbun");
		expect(main?.external).toBe((0o100755 << 16) >>> 0);
		expect(main?.content.equals(binary)).toBe(true);
		expect(main?.crc).toBe(Bun.hash.crc32(binary) >>> 0);
		expect(main?.method).toBe(8);
	});

	test("directories are marked as directories", () => {
		const directory = parseZip(zip).find((entry) => entry.name === "root/");
		expect(directory?.external).toBe(((0o040755 << 16) | 0x10) >>> 0);
	});
});

type RpmHeader = {
	end: number;
	entries: Map<number, { type: number; offset: number; count: number; store: Buffer }>;
};

function parseRpmHeader(data: Buffer, offset: number): RpmHeader {
	expect(data.subarray(offset, offset + 3).toString("hex")).toBe("8eade8");
	expect(data[offset + 3]).toBe(1);
	const count = data.readUInt32BE(offset + 8);
	const size = data.readUInt32BE(offset + 12);
	const store = offset + 16 + 16 * count;
	const entries: RpmHeader["entries"] = new Map();
	for (let index = 0; index < count; index += 1) {
		const at = offset + 16 + index * 16;
		expect(entries.has(data.readUInt32BE(at))).toBe(false);
		entries.set(data.readUInt32BE(at), {
			type: data.readUInt32BE(at + 4),
			offset: data.readUInt32BE(at + 8),
			count: data.readUInt32BE(at + 12),
			store: data.subarray(store, store + size),
		});
	}
	return { end: store + size, entries };
}

function rpmString(header: RpmHeader, tag: number): string {
	const entry = header.entries.get(tag);
	expect(entry).toBeDefined();
	return (entry?.store.subarray(entry.offset).toString("utf8") ?? "").split("\0")[0];
}

function rpmStrings(header: RpmHeader, tag: number): string[] {
	const entry = header.entries.get(tag);
	expect(entry).toBeDefined();
	return (entry?.store.subarray(entry.offset).toString("utf8") ?? "").split("\0").slice(0, entry?.count ?? 0);
}

function rpmInts(header: RpmHeader, tag: number): number[] {
	const entry = header.entries.get(tag);
	expect(entry).toBeDefined();
	const values: number[] = [];
	for (let index = 0; index < (entry?.count ?? 0); index += 1)
		values.push(entry?.store.readUInt32BE(entry.offset + index * 4) ?? -1);
	return values;
}

type CpioEntry = { name: string; mode: number; data: Buffer };

function parseCpio(data: Buffer): CpioEntry[] {
	const entries: CpioEntry[] = [];
	let offset = 0;
	while (offset + 110 <= data.length) {
		expect(data.subarray(offset, offset + 6).toString("ascii")).toBe("070701");
		const field = (index: number): number =>
			Number.parseInt(data.subarray(offset + 6 + index * 8, offset + 14 + index * 8).toString("ascii"), 16);
		const mode = field(1);
		const size = field(6);
		const nameSize = field(11);
		const nameStart = offset + 110;
		const name = data.subarray(nameStart, nameStart + nameSize - 1).toString("utf8");
		const contentStart = nameStart + nameSize + ((4 - ((110 + nameSize) % 4)) % 4);
		const next = contentStart + size + ((4 - (size % 4)) % 4);
		if (name === "TRAILER!!!") break;
		entries.push({ name, mode, data: Buffer.from(data.subarray(contentStart, contentStart + size)) });
		offset = next;
	}
	return entries;
}

describe("rpm packages", () => {
	const binary = Buffer.from("binary payload");
	const readme = Buffer.from("readme text");
	const rpm = buildRpm({
		packageName: "labunbun",
		version: "0.1.0.1",
		release: "alpha1",
		architecture: "x86_64",
		summary: "terminal coding agent",
		description: ["terminal coding agent", "Second line."],
		license: "MIT",
		maintainer: "zayokami <labunbun@zayoka.com>",
		homepage: "https://example.invalid/labunbun",
		mtime: 1_700_000_000,
		files: [
			{ path: "usr/bin/labunbun", mode: 0o755, data: binary },
			{ path: "usr/share/doc/labunbun/README.md", mode: 0o644, data: readme },
		],
	});

	test("the lead names the package and the signature covers the rest", () => {
		expect(rpm.subarray(0, 4).toString("hex")).toBe("edabeedb");
		expect(rpm.subarray(10, 75).toString("ascii").replace(/\0.*$/, "")).toBe("labunbun-0.1.0.1-alpha1.x86_64");
		const signature = parseRpmHeader(rpm, 96);
		const mainStart = (signature.end + 7) & ~7;
		const main = parseRpmHeader(rpm, mainStart);
		expect(rpmInts(signature, 1000)[0]).toBe(rpm.length - mainStart);
		const md5 = createHash("md5").update(rpm.subarray(mainStart)).digest("hex");
		const signatureMd5 = signature.entries.get(1004);
		expect(signatureMd5?.store.subarray(signatureMd5.offset, signatureMd5.offset + 16).toString("hex")).toBe(md5);
		const sha256 = createHash("sha256").update(rpm.subarray(mainStart, main.end)).digest("hex");
		expect(rpmString(signature, 273)).toBe(sha256);
		expect(rpmInts(signature, 1007)[0]).toBe(gunzipSync(rpm.subarray(main.end)).length);
	});

	test("the main header names the files and their metadata", () => {
		const signature = parseRpmHeader(rpm, 96);
		const main = parseRpmHeader(rpm, (signature.end + 7) & ~7);
		expect(rpmString(main, 1000)).toBe("labunbun");
		expect(rpmString(main, 1001)).toBe("0.1.0.1");
		expect(rpmString(main, 1002)).toBe("alpha1");
		expect(rpmString(main, 1022)).toBe("x86_64");
		expect(rpmString(main, 1124)).toBe("cpio");
		expect(rpmString(main, 1125)).toBe("gzip");
		expect(rpmStrings(main, 1117)).toEqual(["labunbun", "README.md"]);
		expect(rpmStrings(main, 1118)).toEqual(["/usr/bin/", "/usr/share/doc/labunbun/"]);
		expect(rpmInts(main, 1116)).toEqual([0, 1]);
		expect(rpmInts(main, 1028)).toEqual([binary.length, readme.length]);
		expect(rpmInts(main, 1048)).toEqual([0x0c]);
		expect(rpmStrings(main, 1049)).toEqual(["glibc"]);
		expect(rpmStrings(main, 1035)).toEqual([
			createHash("sha256").update(binary).digest("hex"),
			createHash("sha256").update(readme).digest("hex"),
		]);
	});

	test("the payload is a cpio archive with the files and their bytes", () => {
		const signature = parseRpmHeader(rpm, 96);
		const main = parseRpmHeader(rpm, (signature.end + 7) & ~7);
		const entries = parseCpio(gunzipSync(rpm.subarray(main.end)));
		expect(entries.map((entry) => entry.name)).toEqual([
			"./usr",
			"./usr/bin",
			"./usr/share",
			"./usr/share/doc",
			"./usr/share/doc/labunbun",
			"./usr/bin/labunbun",
			"./usr/share/doc/labunbun/README.md",
		]);
		expect(entries[5].mode).toBe(0o100755);
		expect(entries[5].data.equals(binary)).toBe(true);
		expect(entries[6].data.equals(readme)).toBe(true);
	});
});

describe("appimages", () => {
	const runtime = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2, 0]);
	const image = buildAppImage(
		runtime,
		[
			{ path: "AppRun", mode: 0o755, symlink: "usr/bin/labunbun" },
			{ path: "labunbun.desktop", mode: 0o644, data: Buffer.from("desktop") },
			{ path: "usr/bin/labunbun", mode: 0o755, data: Buffer.from("binary payload") },
			{ path: "usr/share/doc/labunbun/README.md", mode: 0o644, data: Buffer.from("readme") },
		],
		1_700_000_000,
	);
	const filesystem = image.subarray(runtime.length);

	function metadataBlock(offset: number): Buffer {
		const header = filesystem.readUInt16LE(offset);
		const size = header & 0x7fff;
		const data = filesystem.subarray(offset + 2, offset + 2 + size);
		return (header & 0x8000) !== 0 ? Buffer.from(data) : inflateSync(data);
	}

	test("the runtime prefix is untouched and the squashfs follows it", () => {
		expect(image.subarray(0, runtime.length).equals(runtime)).toBe(true);
		expect(filesystem.subarray(0, 4).toString("ascii")).toBe("hsqs");
		expect(filesystem.readUInt16LE(20)).toBe(1);
		expect(filesystem.readUInt16LE(22)).toBe(17);
		expect(filesystem.readUInt32LE(4)).toBe(10);
		expect(Number(filesystem.readBigUInt64LE(40))).toBe(filesystem.length);
		expect(filesystem.readBigUInt64LE(56)).toBe(0xffffffffffffffffn);
		expect(filesystem.readBigUInt64LE(88)).toBe(0xffffffffffffffffn);
	});

	test("the root directory lists the appimage entries", () => {
		const inodes = metadataBlock(Number(filesystem.readBigUInt64LE(64)));
		const directories = metadataBlock(Number(filesystem.readBigUInt64LE(72)));
		const root = Number(filesystem.readBigUInt64LE(32));
		expect(inodes.readUInt16LE(root)).toBe(1);
		expect(inodes.readUInt32LE(root + 12)).toBe(10);
		const start = inodes.readUInt16LE(root + 26);
		const count = directories.readUInt32LE(start) + 1;
		const names: string[] = [];
		let cursor = start + 12;
		for (let index = 0; index < count; index += 1) {
			const length = directories.readUInt16LE(cursor + 6) + 1;
			names.push(directories.subarray(cursor + 8, cursor + 8 + length).toString("utf8"));
			cursor += 8 + length;
		}
		expect(names).toEqual(["AppRun", "labunbun.desktop", "usr"]);
		expect(directories.readUInt16LE(start + 12 + 4)).toBe(3);
	});
});
