/**
 * `binary.ts` — the report, from synthesized bytes only.
 *
 * Every fixture in this file is built here, byte by byte: no executable or
 * object file is ever committed, downloaded, or borrowed from the machine
 * running the tests. The builders reproduce exactly the layouts the tool
 * reads, so a wrong offset in a builder fails a test rather than moving the
 * goalposts. Truncation cases are real truncations of those same buffers, so
 * "cut off" is not simulated but performed — and the assertion is that the
 * report still comes back, naming what is missing, without an error.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createInspectBinaryTool } from "../src/binary.ts";

const roots: string[] = [];
afterEach(() => {
	// maxRetries: a freshly written file's handle can outlive the test on
	// Windows for a beat, and a failure to clean up must not fail the run.
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-inspect-binary-"));
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

function fixture(dir: string, name: string, bytes: Buffer): string {
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return path;
}

async function run(dir: string, name: string) {
	return createInspectBinaryTool(dir).call({ path: name }, ctx(dir));
}

// ---------------------------------------------------------------------------
// Byte-level building blocks
// ---------------------------------------------------------------------------

type Order = "le" | "be";

const u32le = (value: number): Buffer => {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(value >>> 0, 0);
	return b;
};
const u64le = (value: number | bigint): Buffer => {
	const b = Buffer.alloc(8);
	b.writeBigUInt64LE(BigInt(value), 0);
	return b;
};
const u32be = (value: number): Buffer => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(value >>> 0, 0);
	return b;
};
const u64be = (value: number | bigint): Buffer => {
	const b = Buffer.alloc(8);
	b.writeBigUInt64BE(BigInt(value), 0);
	return b;
};
const cat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);
const zeros = (n: number): Buffer => Buffer.alloc(n);
const ascii = (text: string): Buffer => Buffer.from(text, "latin1");
const align = (value: number, to: number): number => Math.ceil(value / to) * to;

/** An unsigned LEB128 value, as WASM and the buildinfo inline form write lengths. */
const leb = (value: number): Buffer => {
	const out: number[] = [];
	let rest = value;
	do {
		const byte = rest & 0x7f;
		rest >>>= 7;
		out.push(rest !== 0 ? byte | 0x80 : byte);
	} while (rest !== 0);
	return Buffer.from(out);
};

// ---------------------------------------------------------------------------
// The Go buildinfo blob, both layouts
// ---------------------------------------------------------------------------

const BUILDINFO_MAGIC = Buffer.from("\xff Go buildinf:", "latin1");

/** The module text wrapper: 16-byte sentinels, the trailing one starting with a newline. */
function frameModule(text: string): Buffer {
	return cat(zeros(16), ascii(text), ascii("\n"), zeros(15));
}

/** The 1.18+ layout: version and module text inline after the header, each length-prefixed. */
function buildInfoInline(version: string, moduleText: string): Buffer {
	const versionBytes = ascii(version);
	const module = frameModule(moduleText);
	return cat(
		BUILDINFO_MAGIC,
		Buffer.from([8, 0x02]),
		zeros(16),
		leb(versionBytes.length),
		versionBytes,
		leb(module.length),
		module,
	);
}

/** The pre-1.18 layout: two pointers to Go string headers, at `address`, in `order`. */
function buildInfoPointer(version: string, moduleText: string, address: number, order: Order): Buffer {
	const w64 = order === "le" ? u64le : u64be;
	const versionBytes = ascii(version);
	const module = frameModule(moduleText);
	const versionData = address + 64;
	// Header: 14-byte magic, the pointer-size and flags bytes (16 total), then
	// the two pointers — which fill the rest of the fixed 32-byte header.
	return cat(
		BUILDINFO_MAGIC,
		Buffer.from([8, order === "be" ? 0x01 : 0x00]),
		w64(address + 32),
		w64(address + 48),
		w64(versionData),
		w64(versionBytes.length),
		w64(versionData + versionBytes.length),
		w64(module.length),
		versionBytes,
		module,
	);
}

const MODULE_TEXT = "path\tprobe\nmod\tprobe\t(devel)\t\nbuild\t-buildmode=exe\nbuild\t-compiler=gc\n";

/** A zlib-deflated cargo-auditable payload, exactly what the extractor writes. */
function depPayload(packages: unknown[]): Buffer {
	return deflateSync(Buffer.from(JSON.stringify({ packages }), "utf8"));
}

// ---------------------------------------------------------------------------
// ELF
// ---------------------------------------------------------------------------

interface ElfSectionSpec {
	name: string;
	type: number;
	flags?: number;
	content?: Buffer;
}

/**
 * A minimal ELF64 with the given sections plus a `.shstrtab`, no program
 * headers. The first content section always lands at file offset 64, which is
 * what makes pointer-form buildinfo fixtures expressible: the test can build
 * section content whose internal pointers are file addresses, because for the
 * first section address == file offset (the builder sets sh_addr = sh_offset).
 */
function buildElf64(sections: ElfSectionSpec[], options: { order?: Order } = {}): Buffer {
	const order = options.order ?? "le";
	const names = cat(Buffer.from([0]), ...sections.map((s) => ascii(`${s.name}\0`)), ascii(".shstrtab\0"));
	const nameOffsets: number[] = [];
	let nameCursor = 1;
	for (const section of sections) {
		nameOffsets.push(nameCursor);
		nameCursor += section.name.length + 1;
	}
	nameOffsets.push(nameCursor);
	const layout: number[] = [];
	let cursor = 64;
	for (const section of sections) {
		cursor = align(cursor, 16);
		layout.push(cursor);
		cursor += (section.content ?? Buffer.alloc(0)).length;
	}
	const strtabOffset = align(cursor, 16);
	const shoff = align(strtabOffset + names.length, 8);
	const shnum = sections.length + 2;
	const shstrndx = sections.length + 1;
	const file = Buffer.alloc(shoff + shnum * 64);
	const put16 = (offset: number, value: number) => {
		if (order === "le") file.writeUInt16LE(value & 0xffff, offset);
		else file.writeUInt16BE(value & 0xffff, offset);
	};
	const put32 = (offset: number, value: number) => {
		if (order === "le") file.writeUInt32LE(value >>> 0, offset);
		else file.writeUInt32BE(value >>> 0, offset);
	};
	const put64 = (offset: number, value: number) => {
		if (order === "le") file.writeBigUInt64LE(BigInt(value), offset);
		else file.writeBigUInt64BE(BigInt(value), offset);
	};
	file[0] = 0x7f;
	ascii("ELF").copy(file, 1);
	file[4] = 2;
	file[5] = order === "le" ? 1 : 2;
	file[6] = 1;
	put16(16, 2);
	put16(18, 0x3e);
	put32(20, 1);
	put64(24, 0x401000);
	put64(40, shoff);
	put16(52, 64);
	put16(58, 64);
	put16(60, shnum);
	put16(62, shstrndx);
	sections.forEach((section, index) => {
		(section.content ?? Buffer.alloc(0)).copy(file, layout[index]);
	});
	names.copy(file, strtabOffset);
	const writeSection = (
		index: number,
		nameOffset: number,
		type: number,
		flags: number,
		offset: number,
		size: number,
	) => {
		const at = shoff + index * 64;
		put32(at, nameOffset);
		put32(at + 4, type);
		put64(at + 8, flags);
		put64(at + 16, offset);
		put64(at + 24, offset);
		put64(at + 32, size);
	};
	sections.forEach((section, index) => {
		writeSection(
			index + 1,
			nameOffsets[index],
			section.type,
			section.flags ?? 0,
			layout[index],
			(section.content ?? Buffer.alloc(0)).length,
		);
	});
	writeSection(shstrndx, nameOffsets[sections.length], 3, 0, strtabOffset, names.length);
	return file;
}

/** A hand-written ELF32 header with no sections — the 32-bit half of the class matrix. */
function elf32(order: Order): Buffer {
	const file = Buffer.alloc(52);
	file[0] = 0x7f;
	ascii("ELF").copy(file, 1);
	file[4] = 1;
	file[5] = order === "le" ? 1 : 2;
	file[6] = 1;
	const put16 = (offset: number, value: number) => {
		if (order === "le") file.writeUInt16LE(value & 0xffff, offset);
		else file.writeUInt16BE(value & 0xffff, offset);
	};
	const put32 = (offset: number, value: number) => {
		if (order === "le") file.writeUInt32LE(value >>> 0, offset);
		else file.writeUInt32BE(value >>> 0, offset);
	};
	put16(16, 2);
	put16(18, 0x03);
	put32(20, 1);
	put32(24, 0x08048000);
	put16(40, 52);
	put16(46, 40);
	return file;
}

/** An ELF64 with one named buildinfo section holding an inline-format blob. */
function elfWithInline(version = "go1.22.5", moduleText = MODULE_TEXT): Buffer {
	return buildElf64([
		{ name: ".text", type: 1, flags: 0x6, content: zeros(64) },
		{ name: ".go.buildinfo", type: 1, flags: 0x2, content: buildInfoInline(version, moduleText) },
	]);
}

// ---------------------------------------------------------------------------
// PE
// ---------------------------------------------------------------------------

interface PeSectionSpec {
	name: string;
	virtualAddress: number;
	virtualSize: number;
	rawSize: number;
	characteristics: number;
	content?: Buffer;
}

/**
 * A minimal PE32 or PE32+ image: DOS header, PE signature at 0x40, COFF
 * header, a full-size optional header, a section table, and raw section data
 * at 0x200 alignment. Long section names are written as `/N` and the COFF
 * string table lands after the raw data, with PointerToSymbolTable aimed at
 * it — the only way a name over 8 bytes survives.
 */
function buildPe(
	sections: PeSectionSpec[],
	options: {
		timestamp?: number;
		characteristics?: number;
		dllCharacteristics?: number;
		subsystem?: number;
		pe32?: boolean;
		resource?: { rva: number; size: number };
	} = {},
): Buffer {
	const pe32 = options.pe32 ?? false;
	const optionalSize = pe32 ? 224 : 240;
	const coff = 0x44;
	const sectionTable = coff + 20 + optionalSize;
	const headersSize = align(sectionTable + sections.length * 40, 0x200);
	const layout: number[] = [];
	let cursor = headersSize;
	for (const section of sections) {
		cursor = align(cursor, 0x200);
		layout.push(cursor);
		cursor += section.rawSize;
	}
	const longNames = new Map<string, number>();
	let strtab: Buffer = Buffer.alloc(0);
	let strtabOffset = 0;
	if (sections.some((section) => section.name.length > 8)) {
		strtabOffset = align(cursor, 4);
		const parts: Buffer[] = [];
		let within = 4;
		for (const section of sections) {
			if (section.name.length <= 8) continue;
			longNames.set(section.name, within);
			const bytes = ascii(`${section.name}\0`);
			parts.push(bytes);
			within += bytes.length;
		}
		const body = cat(...parts);
		strtab = cat(u32le(4 + body.length), body);
	}
	const file = Buffer.alloc(strtab.length > 0 ? strtabOffset + strtab.length : cursor);
	ascii("MZ").copy(file, 0);
	file.writeUInt32LE(0x40, 0x3c);
	ascii("PE\0\0").copy(file, 0x40);
	const put16 = (offset: number, value: number) => file.writeUInt16LE(value & 0xffff, offset);
	const put32 = (offset: number, value: number) => file.writeUInt32LE(value >>> 0, offset);
	const put64 = (offset: number, value: number | bigint) => file.writeBigUInt64LE(BigInt(value), offset);
	put16(coff, 0x8664);
	put16(coff + 2, sections.length);
	put32(coff + 4, options.timestamp ?? 1_700_000_000);
	put32(coff + 8, longNames.size > 0 ? strtabOffset : 0);
	put32(coff + 12, 0);
	put16(coff + 16, optionalSize);
	put16(coff + 18, options.characteristics ?? 0x0022);
	const optional = coff + 20;
	put16(optional, pe32 ? 0x10b : 0x20b);
	put32(optional + 16, 0x1000);
	put32(optional + 20, 0x1000);
	if (pe32) put32(optional + 28, 0x400000);
	else put64(optional + 24, 0x140000000);
	put32(optional + 32, 0x1000);
	put32(optional + 36, 0x200);
	put16(optional + 40, 6);
	put16(optional + 48, 6);
	const imageEnd = Math.max(0, ...sections.map((section) => section.virtualAddress + section.virtualSize));
	put32(optional + 56, align(imageEnd, 0x1000));
	put32(optional + 60, headersSize);
	put16(optional + 68, options.subsystem ?? 3);
	put16(optional + 70, options.dllCharacteristics ?? 0x0160);
	if (pe32) {
		put32(optional + 72, 0x100000);
		put32(optional + 76, 0x1000);
		put32(optional + 80, 0x100000);
		put32(optional + 84, 0x1000);
		put32(optional + 92, 16);
	} else {
		put64(optional + 72, 0x100000);
		put64(optional + 80, 0x1000);
		put64(optional + 88, 0x100000);
		put64(optional + 96, 0x1000);
		put32(optional + 108, 16);
	}
	const directories = pe32 ? optional + 96 : optional + 112;
	if (options.resource) {
		put32(directories + 16, options.resource.rva);
		put32(directories + 20, options.resource.size);
	}
	sections.forEach((section, index) => {
		const entry = sectionTable + index * 40;
		const name = section.name.length <= 8 ? section.name : `/${longNames.get(section.name)}`;
		ascii(name).copy(file, entry);
		put32(entry + 8, section.virtualSize);
		put32(entry + 12, section.virtualAddress);
		put32(entry + 16, section.rawSize);
		put32(entry + 20, layout[index]);
		put32(entry + 36, section.characteristics);
		(section.content ?? Buffer.alloc(0)).copy(file, layout[index]);
	});
	strtab.copy(file, strtabOffset);
	return file;
}

/** A shallow resource directory: one named type with two entries, one id type with one, one leaf. */
function buildResourceBlob(): Buffer {
	const body = Buffer.alloc(0xa0);
	const put16 = (offset: number, value: number) => body.writeUInt16LE(value & 0xffff, offset);
	const put32 = (offset: number, value: number) => body.writeUInt32LE(value >>> 0, offset);
	put16(12, 1);
	put16(14, 2);
	put32(0x10, 0x80000000 | 0x40);
	put32(0x14, 0x80000000 | 0x60);
	put32(0x18, 3);
	put32(0x1c, 0x80000000 | 0x80);
	put32(0x20, 24);
	put32(0x24, 0x90);
	put16(0x40, 5);
	Buffer.from("MYRES", "utf16le").copy(body, 0x42);
	put16(0x60 + 12, 0);
	put16(0x60 + 14, 2);
	put16(0x80 + 12, 0);
	put16(0x80 + 14, 1);
	return body;
}

/** A realistic PE32+ whose `.data` (first writable section) holds the buildinfo blob. */
function buildPeMain(): Buffer {
	return buildPe(
		[
			{
				name: ".text",
				virtualAddress: 0x1000,
				virtualSize: 0x100,
				rawSize: 0x200,
				characteristics: 0x60000020,
				content: zeros(16),
			},
			{
				name: ".data",
				virtualAddress: 0x2000,
				virtualSize: 0x200,
				rawSize: 0x200,
				characteristics: 0xc0000040,
				content: buildInfoInline("go1.22.5", MODULE_TEXT),
			},
			{
				name: ".rsrc",
				virtualAddress: 0x3000,
				virtualSize: 0xa0,
				rawSize: 0x200,
				characteristics: 0x40000040,
				content: buildResourceBlob(),
			},
		],
		{ resource: { rva: 0x3000, size: 0xa0 } },
	);
}

// ---------------------------------------------------------------------------
// Mach-O
// ---------------------------------------------------------------------------

interface MachoSectionSpec {
	name: string;
	content: Buffer;
	flags?: number;
}

/**
 * A thin 64-bit little-endian Mach-O with one `LC_SEGMENT_64 __DATA` (which
 * covers the whole file, addresses at 0x100000000 + file offset) and one
 * `LC_UUID` after it.
 */
function buildMacho64(
	sections: MachoSectionSpec[],
	options: { cputype?: number; filetype?: number; flags?: number } = {},
): Buffer {
	const segmentSize = 72 + sections.length * 80;
	const commandBytes = segmentSize + 24;
	const contentBase = align(32 + commandBytes, 16);
	const layout: number[] = [];
	let cursor = contentBase;
	for (const section of sections) {
		cursor = align(cursor, 16);
		layout.push(cursor);
		cursor += section.content.length;
	}
	const file = Buffer.alloc(cursor);
	const put32 = (offset: number, value: number) => file.writeUInt32LE(value >>> 0, offset);
	const put64 = (offset: number, value: number | bigint) => file.writeBigUInt64LE(BigInt(value), offset);
	// The magic constant is the big-endian read of the first four bytes; the
	// file's bytes for a little-endian 64-bit image are CF FA ED FE.
	file.writeUInt32BE(0xcffaedfe, 0);
	put32(4, options.cputype ?? 0x0100000c);
	put32(8, 0);
	put32(12, options.filetype ?? 2);
	put32(16, 2);
	put32(20, commandBytes);
	put32(24, options.flags ?? 0x200000);
	put32(28, 0);
	put32(32, 0x19);
	put32(36, segmentSize);
	ascii("__DATA").copy(file, 40);
	put64(32 + 24, 0x100000000);
	put64(32 + 32, file.length);
	put64(32 + 40, 0);
	put64(32 + 48, file.length);
	put32(32 + 56, 3);
	put32(32 + 60, 3);
	put32(32 + 64, sections.length);
	put32(32 + 68, 0);
	sections.forEach((section, index) => {
		const at = 32 + 72 + index * 80;
		ascii(section.name).copy(file, at);
		ascii("__DATA").copy(file, at + 16);
		put64(at + 32, 0x100000000 + layout[index]);
		put64(at + 40, section.content.length);
		put32(at + 48, layout[index]);
		put32(at + 52, 4);
		put32(at + 64, section.flags ?? 0);
		section.content.copy(file, layout[index]);
	});
	put32(32 + segmentSize, 0x1b);
	put32(32 + segmentSize + 4, 24);
	return file;
}

/**
 * A thin 32-bit little-endian Mach-O with one `LC_SEGMENT __DATA` covering
 * the whole file and one `LC_UUID` after it — the 32-bit counterpart of
 * `buildMacho64`, different exactly where it matters most: the protection
 * fields sit at 40 and 44 (after the 16 bytes of 4-byte vmaddr / vmsize /
 * fileoff / filesize), not at the 64-bit layout's 56 and 60. They are options
 * so a test can hand the reader a segment that is writable, or one that is
 * not.
 */
function buildMacho32(options: { maxprot?: number; initprot?: number } = {}): Buffer {
	const maxprot = options.maxprot ?? 3;
	const initprot = options.initprot ?? 3;
	const commandBytes = 56 + 24;
	const contentBase = align(28 + commandBytes, 16);
	const file = Buffer.alloc(contentBase + 16);
	const put32 = (offset: number, value: number) => file.writeUInt32LE(value >>> 0, offset);
	// The magic constant is the big-endian read of the first four bytes; the
	// file's bytes for a little-endian 32-bit image are CE FA ED FE.
	file.writeUInt32BE(0xcefaedfe, 0);
	put32(4, 7); // x86
	put32(8, 3);
	put32(12, 2); // MH_EXECUTE
	put32(16, 2); // the segment and the UUID
	put32(20, commandBytes);
	put32(24, 0);
	// LC_SEGMENT at 28: cmd, cmdsize, segname, vmaddr, vmsize, fileoff,
	// filesize, maxprot (at 40), initprot (at 44), nsects (at 48), flags.
	put32(28, 0x1);
	put32(32, 56);
	ascii("__DATA").copy(file, 36);
	put32(28 + 24, 0x1000); // vmaddr
	put32(28 + 28, 0x1000); // vmsize
	put32(28 + 32, 0); // fileoff — the segment covers the whole file
	put32(28 + 36, file.length); // filesize
	put32(28 + 40, maxprot);
	put32(28 + 44, initprot);
	put32(28 + 48, 0); // nsects
	put32(28 + 52, 0); // flags
	put32(28 + 56, 0x1b); // LC_UUID
	put32(28 + 60, 24);
	return file;
}

/** A bare thin Mach-O header with no load commands — for the magic matrix. */
function machoThinHeader(magic: number, order: Order): Buffer {
	const file = Buffer.alloc(32);
	const put32 = (offset: number, value: number) => {
		if (order === "le") file.writeUInt32LE(value >>> 0, offset);
		else file.writeUInt32BE(value >>> 0, offset);
	};
	// Written big-endian always: `magic` is the BE read of those four bytes.
	file.writeUInt32BE(magic >>> 0, 0);
	put32(4, 12);
	put32(8, 0);
	put32(12, 2);
	put32(16, 0);
	put32(20, 0);
	put32(24, 0);
	put32(28, 0);
	return file;
}

/** A fat Mach-O wrapping the given thin slices. */
function buildFatSlices(slices: Buffer[], options: { order?: Order; wide?: boolean } = {}): Buffer {
	const order = options.order ?? "be";
	const wide = options.wide ?? false;
	const w32 = order === "be" ? u32be : u32le;
	const w64 = order === "be" ? u64be : u64le;
	const entrySize = wide ? 32 : 20;
	const layout: number[] = [];
	let cursor = align(8 + entrySize * slices.length, 16);
	for (const slice of slices) {
		cursor = align(cursor, 16);
		layout.push(cursor);
		cursor += slice.length;
	}
	const file = Buffer.alloc(cursor);
	w32(0xcafebabe + (wide ? 1 : 0)).copy(file, 0);
	w32(slices.length).copy(file, 4);
	slices.forEach((slice, index) => {
		const at = 8 + index * entrySize;
		w32(0x0100000c).copy(file, at);
		if (wide) {
			w64(layout[index]).copy(file, at + 8);
			w64(slice.length).copy(file, at + 16);
			w32(12).copy(file, at + 24);
		} else {
			w32(layout[index]).copy(file, at + 8);
			w32(slice.length).copy(file, at + 12);
			w32(12).copy(file, at + 16);
		}
		slice.copy(file, layout[index]);
	});
	return file;
}

/** A thin Mach-O carrying both metadata blocks in `__DATA`. */
function buildMachoWithMetadata(): Buffer {
	return buildMacho64([
		{ name: "__go_buildinfo", content: buildInfoInline("go1.22.5", "path\tmacho\nmod\tmacho\t(devel)\t\n") },
		{
			name: ".dep-v0",
			content: depPayload([
				{ name: "leftpad", version: "1.0.0", kind: "runtime", dependencies: [] },
				{ name: "serde", version: "1.0.203", kind: "normal", dependencies: [] },
			]),
		},
	]);
}

// ---------------------------------------------------------------------------
// WASM
// ---------------------------------------------------------------------------

function buildWasm(sections: Array<{ id: number; payload: Buffer }>): Buffer {
	return cat(
		ascii("\0asm"),
		u32le(1),
		...sections.flatMap((s) => [Buffer.from([s.id]), leb(s.payload.length), s.payload]),
	);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("InspectBinary classifies by magic bytes", () => {
	test("ELF class and endianness come from the header, not from anything else", async () => {
		const dir = tempDir();
		fixture(dir, "elf64le.bin", buildElf64([{ name: ".text", type: 1, flags: 0x6 }]));
		fixture(dir, "elf64be.bin", buildElf64([{ name: ".text", type: 1, flags: 0x6 }], { order: "be" }));
		fixture(dir, "elf32le.bin", elf32("le"));
		fixture(dir, "elf32be.bin", elf32("be"));

		const elf64le = textOf(await run(dir, "elf64le.bin"));
		expect(elf64le).toContain("format: ELF (64-bit, little-endian)");
		expect(elf64le).toContain("ELF header: type ET_EXEC (executable), machine x86-64 (0x3e), entry 0x401000");
		expect(elf64le).toContain("section headers: 3");
		expect(elf64le).toContain("  [1] .text  PROGBITS  size 0 bytes");

		expect(textOf(await run(dir, "elf64be.bin"))).toContain("format: ELF (64-bit, big-endian)");
		const elf32le = textOf(await run(dir, "elf32le.bin"));
		expect(elf32le).toContain("format: ELF (32-bit, little-endian)");
		expect(elf32le).toContain("machine x86 (0x3)");
		expect(elf32le).toContain("section headers: none");
		expect(textOf(await run(dir, "elf32be.bin"))).toContain("format: ELF (32-bit, big-endian)");
	});

	test("the extension is ignored: the same bytes are an ELF under any name", async () => {
		const dir = tempDir();
		fixture(dir, "payload.txt", buildElf64([{ name: ".text", type: 1, flags: 0x6 }]));

		const text = textOf(await run(dir, "payload.txt"));

		expect(text).toContain("format: ELF (64-bit, little-endian)");
		expect(text).toContain("InspectBinary report for payload.txt");
	});

	test("all four thin Mach-O magics are recognized, with their own endianness", async () => {
		const dir = tempDir();
		fixture(dir, "thin32be.bin", machoThinHeader(0xfeedface, "be"));
		fixture(dir, "thin64be.bin", machoThinHeader(0xfeedfacf, "be"));
		fixture(dir, "thin32le.bin", machoThinHeader(0xcefaedfe, "le"));
		fixture(dir, "thin64le.bin", machoThinHeader(0xcffaedfe, "le"));

		expect(textOf(await run(dir, "thin32be.bin"))).toContain("format: Mach-O (thin, 32-bit, big-endian)");
		expect(textOf(await run(dir, "thin64be.bin"))).toContain("format: Mach-O (thin, 64-bit, big-endian)");
		const thin32le = textOf(await run(dir, "thin32le.bin"));
		expect(thin32le).toContain("format: Mach-O (thin, 32-bit, little-endian)");
		expect(thin32le).toContain("Mach-O header: cputype ARM (0xc), filetype MH_EXECUTE, flags none");
		expect(thin32le).toContain("load commands: 0 declared (0 bytes)");
		expect(textOf(await run(dir, "thin64le.bin"))).toContain("format: Mach-O (thin, 64-bit, little-endian)");
	});

	test("PE needs the DOS header and the PE signature to agree", async () => {
		const dir = tempDir();
		fixture(dir, "app.exe", buildPeMain());
		// MZ, and an e_lfanew pointing past the end of the file: the claim without the format.
		fixture(dir, "stray-mz.bin", cat(ascii("MZ"), zeros(0x3a), u32le(0x100)));

		const pe = textOf(await run(dir, "app.exe"));
		expect(pe).toContain("format: PE (PE signature at 0x40)");
		expect(textOf(await run(dir, "stray-mz.bin"))).toContain("format: unrecognized");
	});

	test("WASM: header version and the section directory", async () => {
		const dir = tempDir();
		fixture(
			dir,
			"module.wasm",
			buildWasm([
				{ id: 7, payload: zeros(3) },
				{ id: 10, payload: zeros(8) },
			]),
		);

		const text = textOf(await run(dir, "module.wasm"));

		expect(text).toContain("format: WASM");
		expect(text).toContain("WASM header: version 1");
		expect(text).toContain("sections: 2");
		expect(text).toContain("  section 7 (export) at 0xa, 3 bytes");
		expect(text).toContain("  section 10 (code) at 0xf, 8 bytes");
		// WASM has no place to embed either metadata block; the report says so
		// rather than leaving a reader to wonder whether it looked.
		expect(text).toContain("go build info: no Go build info found (only ELF, PE and Mach-O containers are searched)");
		expect(text).toContain("cargo-auditable: no .dep-v0 section (only ELF, PE and Mach-O containers are searched)");
	});

	test("unknown bytes are reported as hex, which is an answer too", async () => {
		const dir = tempDir();
		fixture(dir, "notes.dat", ascii("hello, this is text, not a binary"));

		const text = textOf(await run(dir, "notes.dat"));

		expect(text).toContain("format: unrecognized");
		expect(text).toContain("first 16 bytes: 68 65 6c 6c 6f 2c 20 74 68 69 73 20 69 73 20 74");
	});

	test("an empty file says so", async () => {
		const dir = tempDir();
		fixture(dir, "empty.bin", zeros(0));

		const text = textOf(await run(dir, "empty.bin"));

		expect(text).toContain("size: 0 byte(s)");
		expect(text).toContain("format: unrecognized");
		expect(text).toContain("the file is empty");
	});
});

// ---------------------------------------------------------------------------
// PE structure
// ---------------------------------------------------------------------------

describe("PE structure", () => {
	test("COFF header, optional header, section table and resource types", async () => {
		const dir = tempDir();
		fixture(dir, "app.exe", buildPeMain());

		const text = textOf(await run(dir, "app.exe"));

		expect(text).toContain(
			"COFF header: machine x86-64 (0x8664), 3 sections, timestamp 1700000000 (2023-11-14T22:13:20.000Z)",
		);
		expect(text).toContain("  characteristics: executable image, large address aware");
		expect(text).toContain("optional header: PE32+ (magic 0x20b), subsystem windows console (3)");
		expect(text).toContain("  dll characteristics: high entropy va, dynamic base, nx compat");
		expect(text).toContain("sections (3):");
		expect(text).toContain("  .text  virtual 256 bytes, raw 512 bytes  [code, execute, read]");
		expect(text).toContain("  .data  virtual 512 bytes, raw 512 bytes  [initialized data, read, write]");
		expect(text).toContain("  .rsrc  virtual 160 bytes, raw 512 bytes  [initialized data, read]");
		expect(text).toContain("pe resources: resource directory at RVA 0x3000 (section .rsrc), 3 top-level types");
		expect(text).toContain('  type "MYRES": 2 entries');
		expect(text).toContain("  type RT_ICON (3): 1 entry");
		expect(text).toContain("  type RT_MANIFEST (24): a data entry");
	});

	test("the buildinfo blob is found in .data, which is what real Go PE files carry", async () => {
		const dir = tempDir();
		fixture(dir, "app.exe", buildPeMain());

		const text = textOf(await run(dir, "app.exe"));

		expect(text).toContain(
			"go build info: buildinfo magic at 0x400 in section .data (the first writable data section)",
		);
		expect(text).toContain("  go version: go1.22.5");
		expect(text).toContain("    path\tprobe");
	});

	test("a PE32 file reads the offsets PE32 actually has", async () => {
		const dir = tempDir();
		fixture(
			dir,
			"legacy.exe",
			buildPe(
				[
					{
						name: ".text",
						virtualAddress: 0x1000,
						virtualSize: 0x10,
						rawSize: 0x200,
						characteristics: 0x60000020,
						content: zeros(4),
					},
				],
				{ pe32: true },
			),
		);

		const text = textOf(await run(dir, "legacy.exe"));

		expect(text).toContain("format: PE (PE signature at 0x40)");
		expect(text).toContain("optional header: PE32 (magic 0x10b), subsystem windows console (3)");
		// In PE32 the data directories sit 16 bytes earlier than in PE32+; this
		// line only appears with an entry present and empty, so it proves the
		// directory was read at the PE32 offset.
		expect(text).toContain("pe resources: no resource directory (the resource data directory entry is empty)");
	});

	test("a section name longer than 8 bytes is resolved through the COFF string table", async () => {
		const dir = tempDir();
		fixture(
			dir,
			"named.exe",
			buildPe([
				{
					name: ".text",
					virtualAddress: 0x1000,
					virtualSize: 0x10,
					rawSize: 0x200,
					characteristics: 0x60000020,
					content: zeros(4),
				},
				{
					name: ".go.buildinfo",
					virtualAddress: 0x2000,
					virtualSize: 0x100,
					rawSize: 0x200,
					characteristics: 0x42000040,
					content: buildInfoInline("go1.21.0", "path\tnamed\nmod\tnamed\t(devel)\t\n"),
				},
			]),
		);

		const text = textOf(await run(dir, "named.exe"));

		expect(text).toContain("  .go.buildinfo  virtual 256 bytes, raw 512 bytes  [initialized data, discardable, read]");
		expect(text).not.toContain("/4  virtual");
		expect(text).toContain("go build info: buildinfo magic at 0x400 in section .go.buildinfo");
		expect(text).toContain("  go version: go1.21.0");
	});

	test("a truncated PE reports the readable part and names the cut, without an error", async () => {
		const dir = tempDir();
		fixture(dir, "cut.exe", buildPeMain().subarray(0, 0x150));

		const result = await run(dir, "cut.exe");
		const text = textOf(result);

		expect(result.isError).toBeFalsy();
		expect(text).toContain("COFF header: machine x86-64 (0x8664), 3 sections");
		expect(text).toContain("(the file ends inside the section table: 3 declared, 0 readable)");
		expect(text).toContain("pe resources: the resource directory RVA 0x3000 is not inside any section's raw data");
		expect(text).toContain("go build info: no Go build info found");
	});
});

// ---------------------------------------------------------------------------
// Go build info
// ---------------------------------------------------------------------------

describe("Go build info", () => {
	test("inline layout (Go 1.18+) in a named ELF section", async () => {
		const dir = tempDir();
		fixture(dir, "app.elf", elfWithInline());

		const text = textOf(await run(dir, "app.elf"));

		expect(text).toContain("buildinfo magic at 0x80 in section .go.buildinfo");
		expect(text).toContain("  go version: go1.22.5");
		expect(text).toContain("  module info:");
		expect(text).toContain("    path\tprobe");
		expect(text).toContain("    mod\tprobe\t(devel)\t");
		expect(text).toContain("    build\t-buildmode=exe");
		expect(text).toContain("    build\t-compiler=gc");
	});

	test("pointer layout (pre-1.18), including a big-endian ELF", async () => {
		const dir = tempDir();
		// The fixture's first content section lands at file offset 64 and its
		// address is set to match, so the blob's string pointers can be file
		// addresses. The report line below pins that 0x40 down.
		fixture(
			dir,
			"old.elf",
			buildElf64(
				[
					{
						name: ".go.buildinfo",
						type: 1,
						flags: 0x2,
						content: buildInfoPointer("go1.17.13", "path\told\nmod\told\t(devel)\t\nbuild\t-buildmode=exe\n", 64, "be"),
					},
				],
				{ order: "be" },
			),
		);

		const text = textOf(await run(dir, "old.elf"));

		expect(text).toContain("format: ELF (64-bit, big-endian)");
		expect(text).toContain("buildinfo magic at 0x40 in section .go.buildinfo");
		expect(text).toContain("  go version: go1.17.13");
		expect(text).toContain("    path\told");
		expect(text).toContain("    mod\told\t(devel)\t");
	});

	test("no named section: the first writable ELF section is the fallback", async () => {
		const dir = tempDir();
		fixture(
			dir,
			"fallback.elf",
			buildElf64([
				{ name: ".text", type: 1, flags: 0x6, content: zeros(16) },
				{
					name: ".data",
					type: 1,
					flags: 0x3,
					content: buildInfoInline("go1.20.1", "path\tlegacy\nmod\tlegacy\t(devel)\t\n"),
				},
			]),
		);

		const text = textOf(await run(dir, "fallback.elf"));

		expect(text).toContain("buildinfo magic at 0x50 in section .data (a writable data section)");
		expect(text).toContain("  go version: go1.20.1");
	});

	test("no blob anywhere: one line, and it says where was searched", async () => {
		const dir = tempDir();
		fixture(
			dir,
			"empty.elf",
			buildElf64([{ name: ".go.buildinfo", type: 1, flags: 0x2, content: ascii("nothing to see here") }]),
		);

		const text = textOf(await run(dir, "empty.elf"));

		expect(text).toContain("go build info: no Go build info found (looked in section .go.buildinfo)");
		expect(text).toContain("cargo-auditable: no .dep-v0 section");
	});

	test("a malformed blob is named as unreadable, with the reason", async () => {
		const dir = tempDir();
		const blobIn = (content: Buffer) => buildElf64([{ name: ".go.buildinfo", type: 1, flags: 0x2, content }]);
		// A varint length of 0x7f says 127 bytes where the section has none left.
		fixture(dir, "varint.elf", blobIn(cat(BUILDINFO_MAGIC, Buffer.from([8, 0x02]), zeros(16), Buffer.from([0x7f]))));
		fixture(dir, "noversion.elf", blobIn(buildInfoInline("", "path\tx\n")));
		fixture(dir, "badptr.elf", blobIn(cat(BUILDINFO_MAGIC, Buffer.from([5, 0x00]), zeros(32))));

		expect(textOf(await run(dir, "varint.elf"))).toContain(
			"but the blob is not readable (its version string is not a readable varint-prefixed string)",
		);
		expect(textOf(await run(dir, "noversion.elf"))).toContain(
			"but the blob is not readable (its version string is empty)",
		);
		expect(textOf(await run(dir, "badptr.elf"))).toContain(
			"but the blob is not readable (its pointer-size byte is 5, not 4 or 8)",
		);
	});

	test("module text: dep lines stop at 30 with a count, and long lines are cut with one", async () => {
		const dir = tempDir();
		const lines = ["path\tdemo", "mod\tdemo\t(devel)\t", `build\t${"x".repeat(600)}`];
		for (let i = 0; i < 40; i++) {
			lines.push(`dep\tmod${i}\tv1.0.${i}\th1\th2`);
			lines.push(`=>\tmod${i}\tv1.0.${i + 1}\th1\th2`);
		}
		fixture(
			dir,
			"deps.elf",
			buildElf64([
				{ name: ".go.buildinfo", type: 1, flags: 0x2, content: buildInfoInline("go1.22.5", `${lines.join("\n")}\n`) },
			]),
		);

		const text = textOf(await run(dir, "deps.elf"));

		expect(text).toContain("    dep\tmod29\tv1.0.29\th1\th2");
		expect(text).toContain("    =>\tmod29\tv1.0.30\th1\th2");
		expect(text).not.toContain("dep\tmod30");
		// The replacement line of a dropped dep line is dropped with it: a
		// `=>` without its target reads as a replacement of nothing.
		expect(text).not.toContain("=>\tmod30");
		expect(text).toContain("    ... and 10 more dep line(s)");
		// "build\t" + 600 x's is 606 characters; 500 are kept.
		expect(text).toContain("… [106 more chars]");
	});

	test("an ELF truncated before its section header table still reports its header", async () => {
		const dir = tempDir();
		fixture(dir, "cut.elf", elfWithInline().subarray(0, 200));

		const result = await run(dir, "cut.elf");
		const text = textOf(result);

		expect(result.isError).toBeFalsy();
		expect(text).toContain("ELF header: type ET_EXEC (executable), machine x86-64 (0x3e), entry 0x401000");
		expect(text).toMatch(
			/section headers: the section header table at 0x[0-9a-f]+ is past the end of the file \(200 bytes\)/,
		);
		expect(text).toContain("go build info: no Go build info found");
	});
});

// ---------------------------------------------------------------------------
// cargo-auditable
// ---------------------------------------------------------------------------

describe("cargo-auditable", () => {
	test("the .dep-v0 section is inflated and its packages listed", async () => {
		const dir = tempDir();
		fixture(
			dir,
			"crate.elf",
			buildElf64([
				{ name: ".text", type: 1, flags: 0x6, content: zeros(16) },
				{
					name: ".dep-v0",
					type: 1,
					flags: 0x2,
					content: depPayload([
						{ name: "libc", version: "0.2.155", kind: "runtime", dependencies: [] },
						{
							name: "serde",
							version: "1.0.203",
							kind: "normal",
							dependencies: [{ name: "serde_derive", req: "=1.0.203" }],
						},
						{ name: "proc-macro2", version: "1.0.85", kind: "build", dependencies: [] },
					]),
				},
			]),
		);

		const text = textOf(await run(dir, "crate.elf"));

		expect(text).toContain("cargo-auditable: section .dep-v0 holds 3 packages");
		expect(text).toContain("  libc@0.2.155 (runtime)");
		expect(text).toContain("  serde@1.0.203 (normal)");
		expect(text).toContain("  proc-macro2@1.0.85 (build)");
		// The .dep-v0 section carries no Go build info, but the search still says
		// it looked.
		expect(text).toContain("go build info: no Go build info found");
	});

	test("package rows stop at 30 and count the rest", async () => {
		const dir = tempDir();
		const packages = Array.from({ length: 40 }, (_, i) => ({
			name: `pkg${i}`,
			version: `1.0.${i}`,
			kind: "normal",
			dependencies: [],
		}));
		fixture(dir, "many.elf", buildElf64([{ name: ".dep-v0", type: 1, flags: 0x2, content: depPayload(packages) }]));

		const text = textOf(await run(dir, "many.elf"));

		expect(text).toContain("cargo-auditable: section .dep-v0 holds 40 packages");
		expect(text).toContain("  pkg0@1.0.0 (normal)");
		expect(text).toContain("  pkg29@1.0.29 (normal)");
		expect(text).not.toContain("pkg39");
		expect(text).toContain("  ... and 10 more package(s)");
	});

	test("what does not inflate, and what inflates to non-JSON, are each named", async () => {
		const dir = tempDir();
		fixture(
			dir,
			"broken.elf",
			buildElf64([{ name: ".dep-v0", type: 1, flags: 0x2, content: ascii("this is not zlib data at all") }]),
		);
		fixture(
			dir,
			"text.elf",
			buildElf64([{ name: ".dep-v0", type: 1, flags: 0x2, content: deflateSync(ascii("plain text, not json")) }]),
		);

		expect(textOf(await run(dir, "broken.elf"))).toContain("does not inflate as zlib within");
		expect(textOf(await run(dir, "text.elf"))).toContain("inflates, but is not JSON");
	});

	test("JSON without a packages array is named as such", async () => {
		const dir = tempDir();
		fixture(
			dir,
			"shape.elf",
			buildElf64([{ name: ".dep-v0", type: 1, flags: 0x2, content: deflateSync(ascii('{"lockfile": 1}')) }]),
		);

		expect(textOf(await run(dir, "shape.elf"))).toContain("holds JSON without a packages array");
	});
});

// ---------------------------------------------------------------------------
// Mach-O structure
// ---------------------------------------------------------------------------

describe("Mach-O structure", () => {
	test("header, load commands, segment and section lines", async () => {
		const dir = tempDir();
		const file = buildMachoWithMetadata();
		fixture(dir, "app.macho", file);

		const text = textOf(await run(dir, "app.macho"));

		expect(text).toContain("format: Mach-O (thin, 64-bit, little-endian)");
		expect(text).toContain("Mach-O header: cputype ARM64 (0x100000c), filetype MH_EXECUTE, flags pie");
		expect(text).toContain("load commands: 2 declared (256 bytes)");
		expect(text).toContain(`  LC_SEGMENT_64 __DATA: vmaddr 0x100000000, file size ${file.length} bytes, 2 sections`);
		expect(text).toContain("    __go_buildinfo: at 0x100000120,");
		expect(text).toContain("  LC_UUID, 24 bytes");
	});

	test("__go_buildinfo and .dep-v0 in __DATA are both read", async () => {
		const dir = tempDir();
		fixture(dir, "app.macho", buildMachoWithMetadata());

		const text = textOf(await run(dir, "app.macho"));

		expect(text).toContain("go build info: buildinfo magic at 0x120 in section __go_buildinfo (segment __DATA)");
		expect(text).toContain("  go version: go1.22.5");
		expect(text).toContain("    path\tmacho");
		expect(text).toContain("cargo-auditable: section .dep-v0 (segment __DATA) holds 2 packages");
		expect(text).toContain("  leftpad@1.0.0 (runtime)");
		expect(text).toContain("  serde@1.0.203 (normal)");
	});

	test("with no named section, the first writable segment is the fallback", async () => {
		const dir = tempDir();
		fixture(dir, "fallback.macho", buildMacho64([{ name: ".dep-v0", content: zeros(32) }]));

		const text = textOf(await run(dir, "fallback.macho"));

		expect(text).toContain(
			"go build info: no Go build info found (looked in segment __DATA (the first writable segment))",
		);
	});

	test("a 32-bit segment's protection is read from the 32-bit layout", async () => {
		const dir = tempDir();
		// maxprot/initprot = 3/3 at the layout's own offsets, 40 and 44. A
		// reader reusing the 64-bit offsets lands on the fields after them —
		// initprot would be read as the section count — and the fallback would
		// silently never fire on a real 32-bit image.
		fixture(dir, "fallback32.macho", buildMacho32());

		const text = textOf(await run(dir, "fallback32.macho"));

		expect(text).toContain("format: Mach-O (thin, 32-bit, little-endian)");
		expect(text).toContain("LC_SEGMENT __DATA");
		expect(text).toContain(
			"go build info: no Go build info found (looked in segment __DATA (the first writable segment))",
		);
	});

	test("a read-only 32-bit segment is not the buildinfo fallback", async () => {
		const dir = tempDir();
		fixture(dir, "readonly32.macho", buildMacho32({ maxprot: 1, initprot: 1 }));

		const text = textOf(await run(dir, "readonly32.macho"));

		// r-- is not read-write, so the segment must not be offered as a place
		// the linker could have put the blob, and the report says no candidate
		// was found rather than naming one.
		expect(text).toContain("go build info: no Go build info found");
		expect(text).not.toContain("looked in");
	});

	test("a fat binary reports each slice, and searches each slice's metadata", async () => {
		const dir = tempDir();
		const thin = buildMachoWithMetadata();
		fixture(dir, "fat.bin", buildFatSlices([thin]));

		const text = textOf(await run(dir, "fat.bin"));

		expect(text).toContain("format: Mach-O (fat)");
		expect(text).toContain("fat header: 1 slice");
		expect(text).toContain(`slice 0: ARM64 (0x100000c) at 0x20, ${thin.length} bytes`);
		expect(text).toContain("    format: Mach-O (thin, 64-bit, little-endian)");
		expect(text).toContain("go version: go1.22.5");
		expect(text).toContain("cargo-auditable: section .dep-v0 (segment __DATA) holds 2 packages");
	});

	test("64-bit fat entries and little-endian fat headers both parse", async () => {
		const dir = tempDir();
		fixture(dir, "fat64.bin", buildFatSlices([buildMachoWithMetadata()], { wide: true }));
		fixture(dir, "fatle.bin", buildFatSlices([buildMachoWithMetadata()], { order: "le" }));

		const fat64 = textOf(await run(dir, "fat64.bin"));
		expect(fat64).toContain("format: Mach-O (fat, 64-bit entries)");
		expect(fat64).toContain("slice 0: ARM64 (0x100000c)");
		expect(fat64).toContain("go version: go1.22.5");

		expect(textOf(await run(dir, "fatle.bin"))).toContain("slice 0: ARM64 (0x100000c)");
	});

	test("a broken slice is named, and the other slice still reports", async () => {
		const dir = tempDir();
		const thin = buildMachoWithMetadata();
		const garbage = buildFatSlices([ascii("nope"), thin]);
		fixture(dir, "garbage.bin", garbage);
		// A slice offset past the end of the file: the entry is there, the bytes are not.
		const beyond = buildFatSlices([thin]);
		beyond.writeUInt32LE(0x100000, 0x10);
		fixture(dir, "beyond.bin", beyond);

		const garbageText = textOf(await run(dir, "garbage.bin"));
		expect(garbageText).toContain("    (this slice does not begin with a thin Mach-O magic)");
		expect(garbageText).toContain("go version: go1.22.5");

		expect(textOf(await run(dir, "beyond.bin"))).toContain("    (the slice has no bytes in this file)");
	});
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("truncated containers", () => {
	test("a WASM section whose size runs past the end is named, not crashed", async () => {
		const dir = tempDir();
		const full = buildWasm([
			{ id: 7, payload: zeros(3) },
			{ id: 10, payload: zeros(8) },
		]);
		fixture(dir, "cut.wasm", full.subarray(0, 12));

		const result = await run(dir, "cut.wasm");
		const text = textOf(result);

		expect(result.isError).toBeFalsy();
		expect(text).toContain("WASM header: version 1");
		expect(text).toContain("(section 7 at 0x8 claims 3 bytes, past the end of the file)");
	});

	test("a Mach-O cut inside a load command names the command", async () => {
		const dir = tempDir();
		fixture(dir, "cut.macho", buildMachoWithMetadata().subarray(0, 40));

		const result = await run(dir, "cut.macho");
		const text = textOf(result);

		expect(result.isError).toBeFalsy();
		expect(text).toContain("Mach-O header: cputype ARM64 (0x100000c)");
		expect(text).toContain("(the file ends inside the LC_SEGMENT_64 command at 0x20)");
	});
});

// ---------------------------------------------------------------------------
// Runaway listings
// ---------------------------------------------------------------------------

describe("runaway listings", () => {
	test("a Mach-O declaring thousands of load commands stops the listing and says so", async () => {
		const dir = tempDir();
		// 2,500 commands of 8 bytes each: enough to flood the line list six
		// times over if nothing bounded it. Each is shaped like an LC_UUID the
		// reader only has to name and step past.
		const commands = 2_500;
		const file = Buffer.alloc(28 + commands * 8);
		file.writeUInt32BE(0xcefaedfe, 0);
		file.writeUInt32LE(7, 4);
		file.writeUInt32LE(2, 12);
		file.writeUInt32LE(commands, 16);
		file.writeUInt32LE(commands * 8, 20);
		for (let i = 0; i < commands; i++) {
			file.writeUInt32LE(0x1b, 28 + i * 8);
			file.writeUInt32LE(8, 28 + i * 8 + 4);
		}
		fixture(dir, "commands.macho", file);

		const text = textOf(await run(dir, "commands.macho"));

		expect(text).toContain(`load commands: ${commands} declared`);
		expect(text).toContain("(the load command listing is stopped at 400 lines)");
	});

	test("a WASM whose every two bytes is an empty section stops the listing", async () => {
		const dir = tempDir();
		// 2,500 empty custom sections, two bytes each. The walk advances two
		// bytes per line, so without the bound this small file would build
		// thousands of listing lines that the report cap then throws away.
		const file = Buffer.alloc(8 + 2 * 2_500);
		file.writeUInt32LE(0x6d736100, 0); // \0asm
		file.writeUInt32LE(1, 4);
		fixture(dir, "sections.wasm", file);

		const text = textOf(await run(dir, "sections.wasm"));

		expect(text).toContain("section 0 (custom) at 0xa, 0 bytes");
		expect(text).toContain("(the section listing is stopped at 400 lines)");
	});
});

// ---------------------------------------------------------------------------
// The tool's edges
// ---------------------------------------------------------------------------

describe("the tool's edges", () => {
	test("a missing path, a directory, and a path outside the workspace are each refused", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "a-dir"));
		const tool = createInspectBinaryTool(dir);

		const missing = await tool.call({ path: "gone.bin" }, ctx(dir));
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("Path not found: gone.bin");

		const asDir = await tool.call({ path: "a-dir" }, ctx(dir));
		expect(asDir.isError).toBe(true);
		expect(textOf(asDir)).toContain("is a directory, not a binary file");

		const outside = await tool.call({ path: "../outside.bin" }, ctx(dir));
		expect(outside.isError).toBe(true);
		expect(textOf(outside)).toContain("resolves outside workspace");
	});

	test("a file past the size guard is refused before it is read", async () => {
		const dir = tempDir();
		const path = join(dir, "huge.bin");
		// Sparse: 300 MiB of logical size for a file that occupies almost nothing.
		const fd = openSync(path, "w");
		ftruncateSync(fd, 300 * 1024 * 1024);
		closeSync(fd);

		const result = await run(dir, "huge.bin");

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("past the 268435456 this inspection reads into memory");
	});

	test("a report past the cap is cut with an explicit marker", async () => {
		const dir = tempDir();
		const sections: ElfSectionSpec[] = [];
		for (let i = 0; i < 800; i++) sections.push({ name: `.s${i}`, type: 1, flags: 0 });
		fixture(dir, "many.elf", buildElf64(sections));

		const text = textOf(await run(dir, "many.elf"));

		expect(text).toContain("section headers: 802");
		expect(text).toMatch(/\.\.\. \[truncated \d+ chars of output\]$/);
		expect(text.length).toBeLessThan(21_000);
	});

	test("the tool declares itself read-only, concurrency-safe, and honest about scope", () => {
		const tool = createInspectBinaryTool(tempDir());

		expect(tool.name).toBe("InspectBinary");
		expect(tool.isReadOnly?.({ path: "x" })).toBe(true);
		expect(tool.isConcurrencySafe?.({ path: "x" })).toBe(true);
		expect(tool.description).toContain("does not disassemble or decompile");
	});
});
