/**
 * `dotnet.ts` — the managed metadata report, from synthesized bytes only.
 *
 * The fixtures here are whole PE images with a metadata root inside them,
 * built byte by byte like the ones in binary.test.ts: no assembly is ever
 * committed or borrowed from the machine. The builders write each table row
 * at its spec width, so a wrong width in the reader misreads a name rather
 * than agreeing with a wrong fixture. One test reads the real mscorlib.dll
 * from the machine when there is one — a second opinion from bytes no
 * builder here wrote.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInspectBinaryTool } from "../src/binary.ts";
import { dotnetManagedLines } from "../src/dotnet.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------------------------------------------------------------------------
// Byte-level building blocks, PE32+ with one .text section
// ---------------------------------------------------------------------------

const u16le = (value: number): Buffer => {
	const b = Buffer.alloc(2);
	b.writeUInt16LE(value & 0xffff, 0);
	return b;
};
const u32le = (value: number): Buffer => {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(value >>> 0, 0);
	return b;
};
const cat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);
const zeros = (n: number): Buffer => Buffer.alloc(n);
const ascii = (text: string): Buffer => Buffer.from(text, "latin1");
const align = (value: number, to: number): number => Math.ceil(value / to) * to;
const u64le = (value: bigint): Buffer => {
	const b = Buffer.alloc(8);
	b.writeBigUInt64LE(value, 0);
	return b;
};

/** A PE32+ image with one `.text` section at RVA 0x1000 holding `content`. */
function peWith(content: Buffer, cli?: { rva: number; size: number }): Buffer {
	const coff = 0x44;
	const optionalSize = 240;
	const optional = coff + 20;
	const directories = optional + 112;
	const sectionTable = optional + optionalSize;
	const rawOffset = align(sectionTable + 40, 0x200);
	const file = Buffer.alloc(rawOffset + content.length);
	ascii("MZ").copy(file, 0);
	file.writeUInt32LE(0x40, 0x3c);
	ascii("PE\0\0").copy(file, 0x40);
	file.writeUInt16LE(0x8664, coff);
	file.writeUInt16LE(1, coff + 2);
	file.writeUInt16LE(optionalSize, coff + 16);
	file.writeUInt16LE(0x20b, optional);
	if (cli !== undefined) {
		file.writeUInt32LE(cli.rva, directories + 14 * 8);
		file.writeUInt32LE(cli.size, directories + 14 * 8 + 4);
	}
	ascii(".text").copy(file, sectionTable);
	file.writeUInt32LE(content.length, sectionTable + 8);
	file.writeUInt32LE(0x1000, sectionTable + 12);
	file.writeUInt32LE(content.length, sectionTable + 16);
	file.writeUInt32LE(rawOffset, sectionTable + 20);
	file.writeUInt32LE(0x60000020, sectionTable + 36);
	content.copy(file, rawOffset);
	return file;
}

/** A managed image: a CLI header at RVA 0x1000, then the metadata root. */
function managedImage(
	root: Buffer,
	options: {
		runtime?: [number, number];
		flags?: number;
		entry?: number;
		cliSize?: number;
		cliRva?: number;
		code?: Buffer;
		nativeHeader?: Buffer;
	} = {},
): Buffer {
	const cliSize = options.cliSize ?? 72;
	const cli = Buffer.alloc(Math.max(cliSize, 8));
	cli.writeUInt32LE(cliSize, 0);
	const [major, minor] = options.runtime ?? [2, 5];
	cli.writeUInt16LE(major, 4);
	cli.writeUInt16LE(minor, 6);
	cli.writeUInt32LE(0x1000 + cliSize, 8);
	cli.writeUInt32LE(root.length, 12);
	cli.writeUInt32LE(options.flags ?? 0x00000001, 16);
	cli.writeUInt32LE(options.entry ?? 0, 20);
	const code = options.code ?? Buffer.alloc(0);
	const native = options.nativeHeader;
	if (native !== undefined) {
		cli.writeUInt32LE(0x1000 + cliSize + root.length + code.length, 64);
		cli.writeUInt32LE(native.length, 68);
	}
	const content = cat(cli, root, code, native ?? Buffer.alloc(0));
	return peWith(content, { rva: options.cliRva ?? 0x1000, size: cliSize });
}

/** A metadata root with its version string and named streams. */
function metadataRoot(version: string, streams: { name: string; bytes: Buffer; sizeOverride?: number }[]): Buffer {
	const versionBytes = ascii(`${version}\0`);
	const headerSize = 16 + align(versionBytes.length, 4) + 4;
	const streamHeaders = streams.map((stream) => Buffer.alloc(8 + align(stream.name.length + 1, 4)));
	let offset = headerSize + streamHeaders.reduce((sum, header) => sum + header.length, 0);
	const data: Buffer[] = [];
	streams.forEach((stream, i) => {
		const header = streamHeaders[i];
		header.writeUInt32LE(offset, 0);
		header.writeUInt32LE(stream.sizeOverride ?? stream.bytes.length, 4);
		ascii(stream.name).copy(header, 8);
		offset += stream.bytes.length;
		data.push(stream.bytes);
	});
	const head = cat(
		u32le(0x424a5342),
		u16le(1),
		u16le(1),
		u32le(0),
		u32le(versionBytes.length),
		versionBytes,
		zeros(align(versionBytes.length, 4) - versionBytes.length),
		u16le(0),
		u16le(streams.length),
	);
	return cat(head, ...streamHeaders, ...data);
}

/** A #~ stream: the header, the row counts in ascending table order, then the rows. */
function tablesStream(tables: { id: number; rows: Buffer[] }[]): Buffer {
	const sorted = [...tables].sort((a, b) => a.id - b.id);
	let valid = 0n;
	for (const table of sorted) valid |= 1n << BigInt(table.id);
	const head = Buffer.alloc(24);
	head.writeUInt8(2, 4);
	head.writeUInt8(0, 5);
	head.writeUInt8(0, 6); // heapSizes: every heap index is two bytes
	head.writeUInt8(1, 7);
	u64le(valid).copy(head, 8);
	return cat(head, ...sorted.map((table) => u32le(table.rows.length)), ...sorted.flatMap((table) => table.rows));
}

/** A string heap and the index of each entry it was built from. */
function stringsOf(...entries: string[]): { bytes: Buffer; at: number[] } {
	let bytes: Buffer = Buffer.from([0]);
	const at: number[] = [];
	for (const entry of entries) {
		at.push(bytes.length);
		bytes = cat(bytes, ascii(`${entry}\0`));
	}
	return { bytes, at };
}

/** A blob heap and the index of each entry it was built from. */
function blobsOf(...entries: Buffer[]): { bytes: Buffer; at: number[] } {
	let bytes: Buffer = Buffer.from([0]);
	const at: number[] = [];
	for (const entry of entries) {
		at.push(bytes.length);
		bytes = cat(bytes, Buffer.from([entry.length]), entry);
	}
	return { bytes, at };
}

/** A one-byte compressed length; every fixture string is short. */
const compressed = (value: number): Buffer => Buffer.from([value]);

/** A #US heap: UTF-16LE text plus the trailing flag byte a user-string entry carries. */
function userStringsOf(...entries: string[]): { bytes: Buffer; at: number[] } {
	let bytes: Buffer = Buffer.from([0]);
	const at: number[] = [];
	for (const entry of entries) {
		at.push(bytes.length);
		const payload = cat(Buffer.from(entry, "utf16le"), Buffer.from([1]));
		bytes = cat(bytes, compressed(payload.length), payload);
	}
	return { bytes, at };
}

// Table rows, at the widths a fixture with two-byte heap and table indexes
// has. MemberRefParent tag 0 is TypeDef and tag 1 is TypeRef; both carry the
// row number in the upper bits.

const typeRefRow = (scope: number, nameAt: number, namespaceAt: number): Buffer =>
	cat(u16le(scope), u16le(nameAt), u16le(namespaceAt));
const typeDefRow = (
	nameAt: number,
	namespaceAt: number,
	fieldList: number,
	methodList: number,
	options: { flags?: number; extends?: number } = {},
): Buffer =>
	cat(
		u32le(options.flags ?? 0),
		u16le(nameAt),
		u16le(namespaceAt),
		u16le(options.extends ?? 0),
		u16le(fieldList),
		u16le(methodList),
	);
const fieldRow = (nameAt: number): Buffer => cat(u16le(0), u16le(nameAt), u16le(0));
const methodDefRow = (rva: number, nameAt: number): Buffer =>
	cat(u32le(rva), u16le(0), u16le(0), u16le(nameAt), u16le(0), u16le(1));
const memberRefRow = (parent: number, nameAt: number): Buffer => cat(u16le(parent), u16le(nameAt), u16le(0));

/** The CLI header and metadata root occupy the start of the `.text` content. */
const codeRva = (root: Buffer, cliSize = 72): number => 0x1000 + cliSize + root.length;

/** A tiny method body: one header byte whose upper six bits are the code length. */
const tinyBody = (il: Buffer): Buffer => cat(Buffer.from([(il.length << 2) | 2]), il);

/** A fat method body: a 12-byte header, then the code. */
const fatBody = (il: Buffer, options: { headerSize?: number; maxStack?: number } = {}): Buffer => {
	const headerSize = options.headerSize ?? 12;
	const head = Buffer.alloc(headerSize);
	head.writeUInt16LE(((headerSize / 4) << 12) | 3, 0);
	head.writeUInt16LE(options.maxStack ?? 8, 2);
	head.writeUInt32LE(il.length, 4);
	return cat(head, il);
};

// IL fragments. Token operands are little-endian four-byte table tokens.
const ilNop = Buffer.from([0x00]);
const ilRet = Buffer.from([0x2a]);
const ilCall = (token: number): Buffer => cat(Buffer.from([0x28]), u32le(token));
const ilCallvirt = (token: number): Buffer => cat(Buffer.from([0x6f]), u32le(token));
const ilNewobj = (token: number): Buffer => cat(Buffer.from([0x73]), u32le(token));
const ilLdftn = (token: number): Buffer => cat(Buffer.from([0xfe, 0x06]), u32le(token));
const ilLdvirtftn = (token: number): Buffer => cat(Buffer.from([0xfe, 0x07]), u32le(token));
const ilLdstr = (token: number): Buffer => cat(Buffer.from([0x72]), u32le(token));
const ilLdfld = (token: number): Buffer => cat(Buffer.from([0x7b]), u32le(token));
const ilStfld = (token: number): Buffer => cat(Buffer.from([0x7d]), u32le(token));
const ilLdsfld = (token: number): Buffer => cat(Buffer.from([0x7e]), u32le(token));

/** The 16 bytes of the one GUID every fixture heap carries. */
const GUID_BYTES = Buffer.from([
	0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);
const GUID_TEXT = "14131211-1615-1817-191a-1b1c1d1e1f20";

const moduleRow = (nameAt: number): Buffer => cat(u16le(0), u16le(nameAt), u16le(1), u16le(0), u16le(0));
const assemblyRow = (
	nameAt: number,
	options: { hash?: number; flags?: number; version?: [number, number, number, number] } = {},
): Buffer =>
	cat(
		u32le(options.hash ?? 0x8004),
		...(options.version ?? [1, 2, 3, 4]).map(u16le),
		u32le(options.flags ?? 0x0001),
		u16le(0),
		u16le(nameAt),
		u16le(0),
	);
const assemblyRefRow = (nameAt: number, version: [number, number, number, number] = [4, 0, 0, 0]): Buffer =>
	cat(...version.map(u16le), u32le(0), u16le(0), u16le(nameAt), u16le(0), u16le(0));

const text = (root: Buffer, options?: Parameters<typeof managedImage>[1]): string =>
	dotnetManagedLines(managedImage(root, options)).join("\n");

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe("managed metadata", () => {
	test("a managed image reports its module, assembly and references", () => {
		const strings = stringsOf("Test.dll", "Test", "System.Runtime", "Other");
		const root = metadataRoot("v4.0.30319", [
			{
				name: "#~",
				bytes: tablesStream([
					{ id: 0x00, rows: [moduleRow(strings.at[0])] },
					{ id: 0x20, rows: [assemblyRow(strings.at[1])] },
					{ id: 0x23, rows: [assemblyRefRow(strings.at[2]), assemblyRefRow(strings.at[3])] },
				]),
			},
			{ name: "#Strings", bytes: strings.bytes },
			{ name: "#GUID", bytes: GUID_BYTES },
			{ name: "#Blob", bytes: Buffer.from([0]) },
		]);

		const report = text(root);

		expect(report).toContain("managed metadata: CLI header 72 bytes at 0x200");
		expect(report).toContain("  runtime version: 2.5");
		expect(report).toContain("  flags: IL only");
		expect(report).not.toContain("entry point");
		expect(report).toContain('  metadata version: "v4.0.30319"');
		expect(report).toContain("  streams (4):");
		expect(report).toContain(`    #Strings ${strings.bytes.length} bytes`);
		expect(report).toContain("  tables (3):");
		expect(report).toContain("    Module: 1 row");
		expect(report).toContain("    Assembly: 1 row");
		expect(report).toContain("    AssemblyRef: 2 rows");
		expect(report).toContain(`  module: Test.dll (MVID ${GUID_TEXT})`);
		expect(report).toContain("  assembly: Test, version 1.2.3.4");
		expect(report).toContain("    culture: neutral");
		expect(report).toContain("    hash algorithm: SHA-1");
		expect(report).toContain("    flags: public key");
		expect(report).toContain("  assembly references (2):");
		expect(report).toContain("    System.Runtime, version 4.0.0.0");
		expect(report).toContain("    Other, version 4.0.0.0");
	});

	test("entry point and flag words come from the CLI header", () => {
		const strings = stringsOf("Test.dll");
		const root = metadataRoot("v2.0.50727", [
			{ name: "#~", bytes: tablesStream([{ id: 0x00, rows: [moduleRow(strings.at[0])] }]) },
			{ name: "#Strings", bytes: strings.bytes },
			{ name: "#GUID", bytes: GUID_BYTES },
		]);

		const report = text(root, { flags: 0x00010009, entry: 0x06000001, runtime: [2, 5] });

		expect(report).toContain("  flags: IL only, strong-name signed, native entry point");
		expect(report).toContain("  entry point: 0x6000001");
	});

	test("assembly names are escaped to one line", () => {
		const strings = stringsOf("Test.dll", "Evil\nName");
		const root = metadataRoot("v4.0.30319", [
			{
				name: "#~",
				bytes: tablesStream([
					{ id: 0x00, rows: [moduleRow(strings.at[0])] },
					{ id: 0x20, rows: [assemblyRow(strings.at[1])] },
				]),
			},
			{ name: "#Strings", bytes: strings.bytes },
			{ name: "#GUID", bytes: GUID_BYTES },
		]);

		expect(text(root)).toContain("  assembly: Evil\\x0aName, version 1.2.3.4");
	});

	test("references are listed up to 20 and the rest are counted", () => {
		const strings = stringsOf(...Array.from({ length: 25 }, (_, i) => `R${i}`));
		const root = metadataRoot("v4.0.30319", [
			{
				name: "#~",
				bytes: tablesStream([{ id: 0x23, rows: strings.at.map((at) => assemblyRefRow(at)) }]),
			},
			{ name: "#Strings", bytes: strings.bytes },
		]);

		const report = text(root);

		expect(report).toContain("  assembly references (25):");
		expect(report).toContain("    R19, version 4.0.0.0");
		expect(report).not.toContain("R20,");
		expect(report).toContain("    ... and 5 more");
	});

	test("the table stream may be the uncompressed #- form", () => {
		const strings = stringsOf("Test.dll");
		const root = metadataRoot("v4.0.30319", [
			{ name: "#-", bytes: tablesStream([{ id: 0x00, rows: [moduleRow(strings.at[0])] }]) },
			{ name: "#Strings", bytes: strings.bytes },
			{ name: "#GUID", bytes: GUID_BYTES },
		]);

		expect(text(root)).toContain(`  module: Test.dll (MVID ${GUID_TEXT})`);
	});
});

// ---------------------------------------------------------------------------
// managed method bodies
// ---------------------------------------------------------------------------

describe("managed code", () => {
	test("types, bodies, tokens, strings and the entry point resolve from the tables", () => {
		const strings = stringsOf(
			"Test.dll",
			"Ns",
			"Widget",
			"Field",
			"Run",
			"Helper",
			"Other",
			"Target",
			"System",
			"Console",
			"WriteLine",
			"OtherField",
		);
		const users = userStringsOf("hello");
		const buildRoot = (runRva: number, helperRva: number): Buffer =>
			metadataRoot("v4.0.30319", [
				{
					name: "#~",
					bytes: tablesStream([
						{ id: 0x01, rows: [typeRefRow(0, strings.at[9], strings.at[8])] },
						{
							id: 0x02,
							rows: [typeDefRow(strings.at[2], strings.at[1], 1, 1), typeDefRow(strings.at[6], strings.at[1], 2, 3)],
						},
						{ id: 0x04, rows: [fieldRow(strings.at[3]), fieldRow(strings.at[11])] },
						{
							id: 0x06,
							rows: [
								methodDefRow(runRva, strings.at[4]),
								methodDefRow(helperRva, strings.at[5]),
								methodDefRow(0, strings.at[7]),
							],
						},
						{
							id: 0x0a,
							rows: [memberRefRow(2 << 3, strings.at[7]), memberRefRow((1 << 3) | 1, strings.at[10])],
						},
					]),
				},
				{ name: "#Strings", bytes: strings.bytes },
				{ name: "#US", bytes: users.bytes },
				{ name: "#Blob", bytes: Buffer.from([0]) },
			]);
		const probe = buildRoot(0, 0);
		const runRva = codeRva(probe);
		const runBody = tinyBody(
			cat(
				ilNop,
				ilNewobj(0x0a000001),
				ilLdstr(0x70000000 | users.at[0]),
				ilStfld(0x04000001),
				ilLdfld(0x04000001),
				ilLdsfld(0x04000002),
				ilRet,
			),
		);
		const helperBody = fatBody(
			cat(ilCall(0x0a000002), ilCallvirt(0x0a000001), ilLdftn(0x06000001), ilLdvirtftn(0x06000002), ilRet),
		);
		const root = buildRoot(runRva, runRva + runBody.length);
		const report = text(root, { code: cat(runBody, helperBody), entry: 0x06000001 });

		expect(report).toContain("  managed code:");
		expect(report).toContain("    types (2):");
		expect(report).toContain("      Ns.Widget (2 methods, 1 field)");
		expect(report).toContain("      Ns.Other (1 method, 1 field)");
		expect(report).toContain("    methods: 3 (2 with a body, 1 without, 0 undecodable)");
		expect(report).toContain("    method bodies read: 2 (50 bytes of IL; cap 2000 methods / 8 MiB)");
		expect(report).toContain("    entry point method: Ns.Widget.Run");
		expect(report).toContain('    user strings (1): "hello"');
		expect(report).toContain("    calls (5 distinct, 5 occurrences):");
		expect(report).toContain("      Ns.Widget.Helper -> Ns.Other.Target 1");
		expect(report).toContain("      Ns.Widget.Helper -> Ns.Widget.Helper 1");
		expect(report).toContain("      Ns.Widget.Helper -> Ns.Widget.Run 1");
		expect(report).toContain("      Ns.Widget.Helper -> System.Console.WriteLine 1");
		expect(report).toContain("      Ns.Widget.Run -> Ns.Other.Target 1");
		expect(report).toContain("    field accesses (2 distinct, 3 occurrences):");
		expect(report).toContain("      Ns.Widget.Run -> Ns.Widget.Field 2");
		expect(report).toContain("      Ns.Widget.Run -> Ns.Other.OtherField 1");
	});

	test("a reserved opcode makes one body undecodable; the next body is still read", () => {
		const strings = stringsOf("M");
		const buildRoot = (badRva: number, goodRva: number): Buffer =>
			metadataRoot("v4.0.30319", [
				{
					name: "#~",
					bytes: tablesStream([
						{
							id: 0x06,
							rows: [methodDefRow(badRva, strings.at[0]), methodDefRow(goodRva, strings.at[0])],
						},
					]),
				},
				{ name: "#Strings", bytes: strings.bytes },
			]);
		const probe = buildRoot(0, 0);
		const badRva = codeRva(probe);
		const badBody = tinyBody(Buffer.from([0x24]));
		const goodBody = fatBody(ilRet, { headerSize: 16 });
		const root = buildRoot(badRva, badRva + badBody.length);
		const report = text(root, { code: cat(badBody, goodBody) });

		expect(report).toContain("    types: none");
		expect(report).toContain("    methods: 2 (1 with a body, 0 without, 1 undecodable)");
		expect(report).toContain("    method bodies read: 1 (1 byte of IL");
		expect(report).toContain("    calls: none");
		expect(report).toContain("    field accesses: none");
	});

	test("user strings are escaped and a bad ldstr token is counted", () => {
		const strings = stringsOf("M");
		const users = userStringsOf('a\n"\\b');
		const buildRoot = (rva: number): Buffer =>
			metadataRoot("v4.0.30319", [
				{
					name: "#~",
					bytes: tablesStream([{ id: 0x06, rows: [methodDefRow(rva, strings.at[0])] }]),
				},
				{ name: "#Strings", bytes: strings.bytes },
				{ name: "#US", bytes: users.bytes },
			]);
		const probe = buildRoot(0);
		const body = tinyBody(cat(ilLdstr(0x70000000 | users.at[0]), ilLdstr(0x7000ffff), ilRet));
		const report = text(buildRoot(codeRva(probe)), { code: body });

		expect(report).toContain('    user strings (1): "a\\u000a\\"\\\\b"');
		expect(report).toContain("    1 ldstr token(s) did not resolve to a readable #US string");
	});

	test("the method-body cap stops the read and says how many were left", () => {
		const strings = stringsOf("M");
		const buildRoot = (rva: number): Buffer =>
			metadataRoot("v4.0.30319", [
				{
					name: "#~",
					bytes: tablesStream([
						{ id: 0x06, rows: Array.from({ length: 2001 }, () => methodDefRow(rva, strings.at[0])) },
					]),
				},
				{ name: "#Strings", bytes: strings.bytes },
			]);
		const probe = buildRoot(0);
		const report = text(buildRoot(codeRva(probe)), { code: tinyBody(ilRet) });

		expect(report).toContain("    methods: 2001 (2000 with a body, 0 without, 0 undecodable, 1 not read)");
		expect(report).toContain("    method bodies read: 2000 (2000 bytes of IL; cap 2000 methods / 8 MiB)");
		expect(report).toContain("    1 method(s) were not read after the 2000-body cap");
	});

	test("a body past the IL budget is counted but not walked", () => {
		const strings = stringsOf("M");
		const il = Buffer.alloc(8 * 1024 * 1024 + 1);
		const buildRoot = (rva: number): Buffer =>
			metadataRoot("v4.0.30319", [
				{
					name: "#~",
					bytes: tablesStream([{ id: 0x06, rows: [methodDefRow(rva, strings.at[0])] }]),
				},
				{ name: "#Strings", bytes: strings.bytes },
			]);
		const probe = buildRoot(0);
		const report = text(buildRoot(codeRva(probe)), { code: fatBody(il) });

		expect(report).toContain("    methods: 1 (0 with a body, 0 without, 0 undecodable, 1 not read)");
		expect(report).toContain("    method bodies read: 0 (0 bytes of IL");
		expect(report).toContain("    1 method(s) were not read because the next body would pass the 8 MiB IL cap");
	});
});

// ---------------------------------------------------------------------------
// target framework
// ---------------------------------------------------------------------------

describe("target framework attribute", () => {
	test("resolved through a MemberRef to a TypeRef", () => {
		const strings = stringsOf("TargetFrameworkAttribute", "System.Runtime.Versioning", ".ctor");
		const blobs = blobsOf(cat(Buffer.from([0x01, 0x00, 24]), ascii(".NETCoreApp,Version=v8.0")));
		const root = metadataRoot("v4.0.30319", [
			{
				name: "#~",
				bytes: tablesStream([
					{ id: 0x01, rows: [cat(u16le(0), u16le(strings.at[0]), u16le(strings.at[1]))] },
					{ id: 0x0a, rows: [cat(u16le(9), u16le(strings.at[2]), u16le(0))] },
					{ id: 0x0c, rows: [cat(u16le(46), u16le(11), u16le(blobs.at[0]))] },
					{ id: 0x20, rows: [assemblyRow(strings.at[0])] },
				]),
			},
			{ name: "#Strings", bytes: strings.bytes },
			{ name: "#Blob", bytes: blobs.bytes },
		]);

		const report = text(root);

		expect(report).toContain("  target framework: .NETCoreApp,Version=v8.0");
		expect(report).toContain("  assembly: TargetFrameworkAttribute, version 1.2.3.4");
	});

	test("resolved through a MethodDef to the type that owns it", () => {
		// The attribute's constructor is defined in this assembly, so the
		// MemberRef path cannot apply — the type is found through TypeDef's
		// method range, not through the method's own name (".ctor").
		const strings = stringsOf("TargetFrameworkAttribute", ".ctor");
		const blobs = blobsOf(cat(Buffer.from([0x01, 0x00, 24]), ascii(".NETCoreApp,Version=v9.0")));
		const root = metadataRoot("v4.0.30319", [
			{
				name: "#~",
				bytes: tablesStream([
					{
						id: 0x02,
						rows: [cat(u32le(0), u16le(strings.at[0]), u16le(0), u16le(0), u16le(1), u16le(1))],
					},
					{
						id: 0x06,
						rows: [cat(u32le(0), u16le(0), u16le(0), u16le(strings.at[1]), u16le(0), u16le(1))],
					},
					{ id: 0x0c, rows: [cat(u16le(46), u16le(10), u16le(blobs.at[0]))] },
					{ id: 0x20, rows: [assemblyRow(strings.at[0])] },
				]),
			},
			{ name: "#Strings", bytes: strings.bytes },
			{ name: "#Blob", bytes: blobs.bytes },
		]);

		expect(text(root)).toContain("  target framework: .NETCoreApp,Version=v9.0");
	});

	test("a same-shaped attribute with another name is not the target framework", () => {
		const strings = stringsOf("SomethingElseAttribute", ".ctor");
		const blobs = blobsOf(cat(Buffer.from([0x01, 0x00, 5]), ascii("no" + "pe!")));
		const root = metadataRoot("v4.0.30319", [
			{
				name: "#~",
				bytes: tablesStream([
					{
						id: 0x02,
						rows: [cat(u32le(0), u16le(strings.at[0]), u16le(0), u16le(0), u16le(1), u16le(1))],
					},
					{
						id: 0x06,
						rows: [cat(u32le(0), u16le(0), u16le(0), u16le(strings.at[1]), u16le(0), u16le(1))],
					},
					{ id: 0x0c, rows: [cat(u16le(46), u16le(10), u16le(blobs.at[0]))] },
					{ id: 0x20, rows: [assemblyRow(strings.at[0])] },
				]),
			},
			{ name: "#Strings", bytes: strings.bytes },
			{ name: "#Blob", bytes: blobs.bytes },
		]);

		expect(text(root)).not.toContain("target framework");
	});
});

// ---------------------------------------------------------------------------
// ReadyToRun
// ---------------------------------------------------------------------------

describe("ReadyToRun", () => {
	const rooted = (): Buffer => {
		const strings = stringsOf("Test.dll");
		return metadataRoot("v4.0.30319", [
			{ name: "#~", bytes: tablesStream([{ id: 0x00, rows: [moduleRow(strings.at[0])] }]) },
			{ name: "#Strings", bytes: strings.bytes },
		]);
	};

	test("a native header with the RTR0 signature is reported with its version", () => {
		const native = cat(Buffer.from("RTR\0", "latin1"), u16le(9), u16le(1), u32le(0x4b));
		const report = text(rooted(), { nativeHeader: native });

		expect(report).toContain("  ReadyToRun: version 9.1, flags 0x4b");
	});

	test("a native header with another signature says so instead of guessing", () => {
		const report = text(rooted(), { nativeHeader: ascii("XXXX") });

		expect(report).toContain('not the ReadyToRun "RTR\\0"');
	});
});

// ---------------------------------------------------------------------------
// silence and damage
// ---------------------------------------------------------------------------

describe("silence and damage", () => {
	test("a native PE and a non-PE say nothing", () => {
		const native = peWith(ascii("this is just some data"));
		expect(dotnetManagedLines(native)).toEqual([]);
		expect(dotnetManagedLines(ascii("not a binary at all"))).toEqual([]);
	});

	test("a CLI header RVA outside every section is named, alone", () => {
		const strings = stringsOf("Test.dll");
		const root = metadataRoot("v4.0.30319", [
			{ name: "#~", bytes: tablesStream([{ id: 0x00, rows: [moduleRow(strings.at[0])] }]) },
			{ name: "#Strings", bytes: strings.bytes },
		]);
		const lines = dotnetManagedLines(managedImage(root, { cliRva: 0x9000 }));

		expect(lines).toEqual(["managed metadata: the CLI header's RVA 0x9000 does not land in any section"]);
	});

	test("a file cut inside the CLI header is named as such", () => {
		const strings = stringsOf("Test.dll");
		const root = metadataRoot("v4.0.30319", [
			{ name: "#~", bytes: tablesStream([{ id: 0x00, rows: [moduleRow(strings.at[0])] }]) },
			{ name: "#Strings", bytes: strings.bytes },
		]);
		const cut = managedImage(root).subarray(0, 0x200 + 2);

		expect(dotnetManagedLines(cut)).toEqual(["managed metadata: the file ends inside the CLI header at 0x200"]);
	});

	test("a CLI header shorter than the format's 72 bytes is named as such", () => {
		const lines = dotnetManagedLines(managedImage(zeros(32), { cliSize: 40 }));

		expect(lines).toEqual([
			"managed metadata: CLI header 40 bytes at 0x200",
			"  the header declares 40 bytes, short of the 72 the format needs",
		]);
	});

	test("a metadata root without the BSJB magic stops there", () => {
		const report = text(zeros(64));

		expect(report).toContain("managed metadata: CLI header 72 bytes at 0x200");
		expect(report).toContain("  the metadata root's magic at 0x248 is 0x0, not BSJB");
	});

	test("a metadata root with no table stream says the tables could not be read", () => {
		const strings = stringsOf("Test.dll");
		const root = metadataRoot("v4.0.30319", [{ name: "#Strings", bytes: strings.bytes }]);

		const report = text(root);

		expect(report).toContain("  streams (1):");
		expect(report).toContain("  no #~ or #- table stream: the tables could not be read");
		expect(report).not.toContain("  tables (");
	});

	test("an unknown table bit is reported and stops the walk", () => {
		const root = metadataRoot("v4.0.30319", [{ name: "#~", bytes: tablesStream([{ id: 0x3f, rows: [zeros(4)] }]) }]);

		const report = text(root);

		expect(report).toContain("    table 0x3f: 1 row");
		expect(report).toContain("  the table walk stops at table 0x3f: no row width is known for it");
		expect(report).not.toContain("  module:");
	});

	test("tables whose rows run past the stream say so, and no identity follows", () => {
		const strings = stringsOf("Test.dll");
		const bytes = tablesStream([{ id: 0x00, rows: [moduleRow(strings.at[0])] }]);
		// The row counts fit in 28 bytes; the one row does not fit in the 30
		// the stream claims.
		const root = metadataRoot("v4.0.30319", [
			{ name: "#~", bytes, sizeOverride: 30 },
			{ name: "#Strings", bytes: strings.bytes },
		]);

		const report = text(root);

		expect(report).toContain("  the table rows run past the end of the #~ stream");
		expect(report).not.toContain("  module:");
	});
});

// ---------------------------------------------------------------------------
// through the tool, and against the machine's own mscorlib when there is one
// ---------------------------------------------------------------------------

const ctx = (cwd: string) => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd,
	sandbox: "workspace-write" as const,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
});

describe("through InspectBinary", () => {
	test("a managed PE grows a managed metadata block; a native one does not", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-dotnet-"));
		roots.push(dir);
		const strings = stringsOf("Test.dll", "Test");
		const root = metadataRoot("v4.0.30319", [
			{
				name: "#~",
				bytes: tablesStream([
					{ id: 0x00, rows: [moduleRow(strings.at[0])] },
					{ id: 0x20, rows: [assemblyRow(strings.at[1])] },
				]),
			},
			{ name: "#Strings", bytes: strings.bytes },
			{ name: "#GUID", bytes: GUID_BYTES },
		]);
		writeFileSync(join(dir, "managed.dll"), managedImage(root));
		writeFileSync(join(dir, "native.exe"), peWith(ascii("plain")));

		const managed = await createInspectBinaryTool(dir).call({ path: "managed.dll" }, ctx(dir));
		const managedText = (managed.content[0] as { text: string }).text;
		const native = await createInspectBinaryTool(dir).call({ path: "native.exe" }, ctx(dir));
		const nativeText = (native.content[0] as { text: string }).text;

		expect(managedText).toContain("format: PE (PE signature at 0x40)");
		expect(managedText).toContain("managed metadata: CLI header 72 bytes at 0x200");
		expect(managedText).toContain("  assembly: Test, version 1.2.3.4");
		expect(nativeText).toContain("format: PE (PE signature at 0x40)");
		expect(nativeText).not.toContain("managed metadata");
	});

	const mscorlib = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/mscorlib.dll";
	test.skipIf(process.platform !== "win32" || !existsSync(mscorlib))(
		"the machine's own mscorlib.dll reads as the .NET Framework runtime library",
		() => {
			const report = dotnetManagedLines(readFileSync(mscorlib)).join("\n");

			expect(report).toContain('  metadata version: "v4.0.30319"');
			expect(report).toContain("  flags: IL only, strong-name signed");
			expect(report).toContain("  module: CommonLanguageRuntimeLibrary (MVID ");
			expect(report).toContain("  assembly: mscorlib, version 4.0.0.0");
			expect(report).toContain("    hash algorithm: SHA-1");
			expect(report).toContain("    Module: 1 row");
		},
	);
});
