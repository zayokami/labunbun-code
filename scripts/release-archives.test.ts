import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { buildDeb, buildZip } from "./release-archives.ts";

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
