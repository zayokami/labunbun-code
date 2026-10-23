/**
 * .NET managed metadata — the CLI header a managed PE carries in the fifteenth
 * data directory, and the metadata root behind it.
 *
 * A .NET assembly is an ordinary PE file plus that one directory: the CLI
 * header, which names the runtime version, the flags the loader acts on, the
 * entry point, and the directory that matters here — the metadata root. The
 * root holds a version string and a small set of named streams; the table
 * stream (#~, or the uncompressed #-) declares how many rows each of the
 * format's tables holds, and the heaps hold the strings, GUIDs and blobs
 * those rows index into.
 *
 * This reads the identity: the module name and its MVID, the assembly's own
 * name and version, the assemblies it references, the target framework
 * attribute when one is present, and the ReadyToRun header when the image was
 * precompiled. It also walks managed method bodies to their operand lengths
 * and resolves the tokens in calls, field accesses and `ldstr` instructions.
 * That is a scan, not a disassembly: no instruction is executed and no
 * signature or generic argument is decoded. A reader that guesses at
 * structures it does not fully parse is worse than one that names what it
 * read and stops.
 *
 * Row widths are load-bearing: the tables sit back to back with no offsets
 * of their own, so reaching any table means summing rows × column widths
 * across every table before it. An unknown table — a bit this file has no
 * width for — stops the walk with a line saying so, because every read past
 * that point would be misaligned by construction.
 *
 * The output is silent for anything that is not a managed PE: an empty
 * directory 14 means the file is not a .NET assembly, and most PEs on a
 * machine are not.
 */

// ---------------------------------------------------------------------------
// Bounds-checked reads
// ---------------------------------------------------------------------------

function u8(data: Buffer, offset: number): number | null {
	return offset >= 0 && offset + 1 <= data.length ? data[offset] : null;
}

function u16(data: Buffer, offset: number): number | null {
	return offset >= 0 && offset + 2 <= data.length ? data.readUInt16LE(offset) : null;
}

function u32(data: Buffer, offset: number): number | null {
	return offset >= 0 && offset + 4 <= data.length ? data.readUInt32LE(offset) : null;
}

function u64(data: Buffer, offset: number): bigint | null {
	return offset >= 0 && offset + 8 <= data.length ? data.readBigUInt64LE(offset) : null;
}

/** A NUL-terminated latin1 name within `max` bytes, or null past the end. */
function cstring(data: Buffer, offset: number, max: number): string | null {
	if (offset < 0 || offset >= data.length) return null;
	const slice = data.subarray(offset, Math.min(offset + max, data.length));
	const nul = slice.indexOf(0);
	return slice.subarray(0, nul === -1 ? slice.length : nul).toString("latin1");
}

/** A compressed unsigned integer (ECMA-335's one- or two- or four-byte form). */
function readCompressed(data: Buffer, offset: number): { value: number; next: number } | null {
	const first = u8(data, offset);
	if (first === null) return null;
	if ((first & 0x80) === 0) return { value: first, next: offset + 1 };
	if ((first & 0xc0) === 0x80) {
		const second = u8(data, offset + 1);
		return second === null ? null : { value: ((first & 0x3f) << 8) | second, next: offset + 2 };
	}
	if ((first & 0xe0) === 0xc0) {
		const tail = u32(data, offset + 1);
		if (tail === null) return null;
		return { value: (((first & 0x1f) << 24) | (tail & 0x00ffffff)) >>> 0, next: offset + 5 };
	}
	return null;
}

function hex(value: number | bigint): string {
	return `0x${value.toString(16)}`;
}

function count(n: number, singular: string, plural: string): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

function align4(value: number): number {
	return (value + 3) & ~3;
}

// ---------------------------------------------------------------------------
// The PE directory that points at everything
// ---------------------------------------------------------------------------

interface PeSectionLite {
	readonly virtualAddress: number;
	readonly rawSize: number;
	readonly rawOffset: number;
}

interface PeLayout {
	readonly sections: readonly PeSectionLite[];
	readonly cliRva: number;
}

/**
 * The little of the PE header this reader needs: the CLI data directory (the
 * fifteenth) and the section table, for turning RVAs into file offsets. Null
 * when the file is no PE, no linked image, or names no CLI directory.
 */
function readPeLayout(data: Buffer): PeLayout | null {
	if (u8(data, 0) !== 0x4d || u8(data, 1) !== 0x5a) return null;
	const lfanew = u32(data, 0x3c);
	if (lfanew === null || u32(data, lfanew) !== 0x00004550) return null;
	const coff = lfanew + 4;
	const declared = u16(data, coff + 2);
	const optionalSize = u16(data, coff + 16);
	if (declared === null || optionalSize === null) return null;
	const optional = coff + 20;
	const magic = u16(data, optional);
	if (magic !== 0x10b && magic !== 0x20b) return null;
	const directoriesAt = magic === 0x10b ? 96 : 112;
	// The optional header must actually be long enough to carry directory 14;
	// a shorter header that happens to sit next to section bytes is not a
	// claim of managed metadata.
	if (optionalSize < directoriesAt + 15 * 8) return null;
	const cliRva = u32(data, optional + directoriesAt + 14 * 8);
	if (cliRva === null || cliRva === 0) return null;

	const sections: PeSectionLite[] = [];
	const sectionTable = optional + optionalSize;
	for (let i = 0; i < declared; i++) {
		const entry = sectionTable + i * 40;
		const virtualAddress = u32(data, entry + 12);
		const rawSize = u32(data, entry + 16);
		const rawOffset = u32(data, entry + 20);
		if (virtualAddress === null || rawSize === null || rawOffset === null) break;
		sections.push({ virtualAddress, rawSize, rawOffset });
	}
	return { sections, cliRva };
}

/** The file offset an RVA maps to through the section table, or null. */
function rvaToOffset(layout: PeLayout, data: Buffer, rva: number): number | null {
	for (const section of layout.sections) {
		if (rva < section.virtualAddress) continue;
		const delta = rva - section.virtualAddress;
		if (delta >= section.rawSize) continue;
		const offset = section.rawOffset + delta;
		return offset < data.length ? offset : null;
	}
	return null;
}

// ---------------------------------------------------------------------------
// The CLI header
// ---------------------------------------------------------------------------

/** The CLI header's flag word, as the loader reads it. */
const CLI_FLAGS: readonly (readonly [number, string])[] = [
	[0x00000001, "IL only"],
	[0x00000002, "32-bit required"],
	[0x00000004, "IL library"],
	[0x00000008, "strong-name signed"],
	[0x00010000, "native entry point"],
	[0x00020000, "track debug data"],
];

/** Assembly flags, the ones with loader meaning. */
const ASSEMBLY_FLAGS: readonly (readonly [number, string])[] = [
	[0x0001, "public key"],
	[0x0100, "retargetable"],
	[0x8000, "windows runtime"],
];

/** The hash algorithms the Assembly table's HashAlgId column names, by CALG value. */
const HASH_ALGORITHMS: readonly (readonly [number, string])[] = [
	[0x8003, "MD5"],
	[0x8004, "SHA-1"],
	[0x800c, "SHA-256"],
	[0x800d, "SHA-384"],
	[0x800e, "SHA-512"],
];

/** "RTR\0": the ReadyToRun header's own signature, read little-endian. */
const READYTORUN_SIGNATURE = 0x00525452;

/** Bytes of the metadata version string shown before the rest is counted. */
const MAX_VERSION_BYTES = 255;

/** Streams listed; a real root has four or five, not dozens. */
const MAX_LISTED_STREAMS = 16;

/** Assembly references listed; past this the count stands in for the names. */
const MAX_LISTED_ASSEMBLY_REFS = 20;

/** Custom attribute rows walked looking for the target framework, before giving up. */
const MAX_SCANNED_ATTRIBUTES = 200_000;

/** Bytes of one metadata name decoded for display before the rest is counted. */
const MAX_NAME_BYTES = 1024;

/** Method bodies whose IL is walked per assembly. */
const MAX_METHOD_BODIES = 2_000;

/** IL bytes walked per assembly, across every method body. */
const MAX_IL_BYTES = 8 * 1024 * 1024;

/** Instructions walked in one method body before its listing stops. */
const MAX_BODY_INSTRUCTIONS = 20_000;

/** TypeDef rows whose names are listed. */
const MAX_LISTED_TYPES = 40;

/** Distinct user strings listed before the rest are counted. */
const MAX_LISTED_USER_STRINGS = 20;

/** Code-points of one user string shown before the rest is counted. */
const MAX_USER_STRING_CHARS = 120;

/** Distinct call or field edges retained per assembly. */
const MAX_DISTINCT_EDGES = 4_000;

/** Edges listed under a call or field heading. */
const MAX_LISTED_EDGES = 20;

export function dotnetManagedLines(data: Buffer): string[] {
	const layout = readPeLayout(data);
	if (layout === null) return [];
	const cliAt = rvaToOffset(layout, data, layout.cliRva);
	if (cliAt === null) {
		return [`managed metadata: the CLI header's RVA ${hex(layout.cliRva)} does not land in any section`];
	}
	const size = u32(data, cliAt);
	if (size === null) return [`managed metadata: the file ends inside the CLI header at ${hex(cliAt)}`];
	const lines = [`managed metadata: CLI header ${count(size, "byte", "bytes")} at ${hex(cliAt)}`];
	if (size < 72) {
		lines.push(`  the header declares ${count(size, "byte", "bytes")}, short of the 72 the format needs`);
		return lines;
	}

	const major = u16(data, cliAt + 4) ?? 0;
	const minor = u16(data, cliAt + 6) ?? 0;
	lines.push(`  runtime version: ${major}.${minor}`);
	lines.push(`  flags: ${flagList(u32(data, cliAt + 16) ?? 0, CLI_FLAGS)}`);
	const entryPoint = u32(data, cliAt + 20) ?? 0;
	if (entryPoint !== 0) lines.push(`  entry point: ${hex(entryPoint)}`);

	const rootRva = u32(data, cliAt + 8) ?? 0;
	if (rootRva === 0) {
		lines.push("  the header names no metadata directory");
		return lines;
	}
	const rootAt = rvaToOffset(layout, data, rootRva);
	if (rootAt === null) {
		lines.push(`  the metadata directory's RVA ${hex(rootRva)} does not land in any section`);
		return lines;
	}

	lines.push(...metadataLines(data, rootAt, layout, entryPoint));
	lines.push(...readyToRunLines(data, layout, cliAt));
	return lines;
}

// ---------------------------------------------------------------------------
// The metadata root and its streams
// ---------------------------------------------------------------------------

interface MetadataStream {
	readonly name: string;
	readonly offset: number;
	readonly size: number;
}

function metadataLines(data: Buffer, rootAt: number, layout: PeLayout, entryPoint: number): string[] {
	const lines: string[] = [];
	const magic = u32(data, rootAt);
	if (magic !== 0x424a5342) {
		lines.push(
			magic === null
				? `  the file ends before the metadata root's magic at ${hex(rootAt)}`
				: `  the metadata root's magic at ${hex(rootAt)} is ${hex(magic)}, not BSJB`,
		);
		return lines;
	}

	const versionLength = u32(data, rootAt + 12);
	if (versionLength === null) {
		lines.push("  the file ends inside the metadata root's header");
		return lines;
	}
	const shown = Math.min(versionLength, MAX_VERSION_BYTES);
	const version = cstring(data, rootAt + 16, shown) ?? "";
	const versionCut = versionLength - shown;
	lines.push(`  metadata version: "${version}${versionCut > 0 ? `… [${versionCut} more byte(s)]` : ""}"`);

	// The version string is padded to a 4-byte boundary, counted from the
	// root's own start — not from the file's.
	let at = rootAt + align4(16 + versionLength);
	const total = u16(data, at + 2) ?? 0;
	at += 4;
	const streams: MetadataStream[] = [];
	for (let i = 0; i < total && i < MAX_LISTED_STREAMS; i++) {
		const offset = u32(data, at);
		const size = u32(data, at + 4);
		const name = cstring(data, at + 8, 32);
		if (offset === null || size === null || name === null || name === "") break;
		streams.push({ name, offset, size });
		at += 8 + align4(name.length + 1);
	}
	lines.push(`  streams (${total}):`);
	for (const stream of streams) lines.push(`    ${stream.name} ${count(stream.size, "byte", "bytes")}`);
	if (streams.length < total) {
		lines.push(
			streams.length < Math.min(total, MAX_LISTED_STREAMS)
				? `    (the stream headers are cut off: ${streams.length} of ${total} readable)`
				: `    ... and ${total - streams.length} more`,
		);
	}

	const tableStream = streams.find((stream) => stream.name === "#~") ?? streams.find((stream) => stream.name === "#-");
	if (tableStream === undefined) {
		lines.push("  no #~ or #- table stream: the tables could not be read");
		return lines;
	}
	lines.push(...tablesLines(data, rootAt, streams, tableStream, layout, entryPoint));
	return lines;
}

// ---------------------------------------------------------------------------
// The table stream
// ---------------------------------------------------------------------------

/** The format's tables by id; the unnamed ids are not part of the portable form. */
const TABLE_NAMES: readonly (readonly [number, string])[] = [
	[0x00, "Module"],
	[0x01, "TypeRef"],
	[0x02, "TypeDef"],
	[0x04, "Field"],
	[0x06, "MethodDef"],
	[0x08, "Param"],
	[0x09, "InterfaceImpl"],
	[0x0a, "MemberRef"],
	[0x0b, "Constant"],
	[0x0c, "CustomAttribute"],
	[0x0d, "FieldMarshal"],
	[0x0e, "DeclSecurity"],
	[0x0f, "ClassLayout"],
	[0x10, "FieldLayout"],
	[0x11, "StandAloneSig"],
	[0x12, "EventMap"],
	[0x14, "Event"],
	[0x15, "PropertyMap"],
	[0x17, "Property"],
	[0x18, "MethodSemantics"],
	[0x19, "MethodImpl"],
	[0x1a, "ModuleRef"],
	[0x1b, "TypeSpec"],
	[0x1c, "ImplMap"],
	[0x1d, "FieldRVA"],
	[0x20, "Assembly"],
	[0x21, "AssemblyProcessor"],
	[0x22, "AssemblyOS"],
	[0x23, "AssemblyRef"],
	[0x24, "AssemblyRefProcessor"],
	[0x25, "AssemblyRefOS"],
	[0x26, "File"],
	[0x27, "ExportedType"],
	[0x28, "ManifestResource"],
	[0x29, "NestedClass"],
	[0x2a, "GenericParam"],
	[0x2b, "MethodSpec"],
	[0x2c, "GenericParamConstraint"],
	[0x30, "Document"],
	[0x31, "MethodDebugInformation"],
	[0x32, "LocalScope"],
	[0x33, "LocalVariable"],
	[0x34, "LocalConstant"],
	[0x35, "ImportScope"],
	[0x36, "StateMachineMethod"],
	[0x37, "CustomDebugInformation"],
];

/** A coded index's tag width and the tables its tag values select. */
interface CodedIndex {
	readonly bits: number;
	readonly tables: readonly number[];
}

const CODED = {
	typeDefOrRef: { bits: 2, tables: [0x02, 0x01, 0x1b] },
	hasConstant: { bits: 2, tables: [0x04, 0x08, 0x17] },
	hasCustomAttribute: {
		bits: 5,
		tables: [
			0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28,
			0x2a, 0x2c, 0x2b,
		],
	},
	hasFieldMarshal: { bits: 1, tables: [0x04, 0x08] },
	hasDeclSecurity: { bits: 2, tables: [0x02, 0x06, 0x20] },
	memberRefParent: { bits: 3, tables: [0x02, 0x01, 0x1a, 0x06, 0x1b] },
	hasSemantics: { bits: 1, tables: [0x14, 0x17] },
	methodDefOrRef: { bits: 1, tables: [0x06, 0x0a] },
	memberForwarded: { bits: 1, tables: [0x04, 0x06] },
	implementation: { bits: 2, tables: [0x26, 0x23, 0x27] },
	customAttributeType: { bits: 3, tables: [0x06, 0x0a] },
	resolutionScope: { bits: 2, tables: [0x00, 0x1a, 0x23, 0x01] },
	typeOrMethodDef: { bits: 1, tables: [0x02, 0x06] },
	hasCustomDebugInformation: {
		bits: 5,
		tables: [
			0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28,
			0x2a, 0x2c, 0x2b, 0x30, 0x32, 0x33, 0x34, 0x35,
		],
	},
} as const satisfies Record<string, CodedIndex>;

/** The row counts and heap index widths one table stream declares. */
interface Census {
	readonly rows: ReadonlyMap<number, number>;
	readonly stringWidth: number;
	readonly guidWidth: number;
	readonly blobWidth: number;
	rowCount(id: number): number;
}

function censusOf(rows: Map<number, number>, heapSizes: number): Census {
	return {
		rows,
		stringWidth: (heapSizes & 0x01) !== 0 ? 4 : 2,
		guidWidth: (heapSizes & 0x02) !== 0 ? 4 : 2,
		blobWidth: (heapSizes & 0x04) !== 0 ? 4 : 2,
		rowCount(id: number) {
			return rows.get(id) ?? 0;
		},
	};
}

/** A simple index into table `id`: two bytes until the table outgrows them. */
function tableIndex(t: Census, id: number): number {
	return t.rowCount(id) >= 65536 ? 4 : 2;
}

/** A coded index's width: its tag bits leave room for `2^(16-bits)` row numbers. */
function codedIndex(t: Census, coded: CodedIndex): number {
	const max = Math.max(...coded.tables.map((id) => t.rowCount(id)));
	return max >= 1 << (16 - coded.bits) ? 4 : 2;
}

/**
 * Every table's row width in bytes, as the sums of its columns. All of them
 * are needed even though only a few are read: the tables have no offsets,
 * so the position of any row is the sum of every row before it.
 */
const ROW_WIDTHS = new Map<number, (t: Census) => number>([
	[0x00, (t) => 2 + t.stringWidth + 3 * t.guidWidth],
	[0x01, (t) => codedIndex(t, CODED.resolutionScope) + 2 * t.stringWidth],
	[0x02, (t) => 4 + 2 * t.stringWidth + codedIndex(t, CODED.typeDefOrRef) + tableIndex(t, 0x04) + tableIndex(t, 0x06)],
	[0x04, (t) => 2 + t.stringWidth + t.blobWidth],
	[0x06, (t) => 8 + t.stringWidth + t.blobWidth + tableIndex(t, 0x08)],
	[0x08, (t) => 4 + t.stringWidth],
	[0x09, (t) => tableIndex(t, 0x02) + codedIndex(t, CODED.typeDefOrRef)],
	[0x0a, (t) => codedIndex(t, CODED.memberRefParent) + t.stringWidth + t.blobWidth],
	[0x0b, (t) => 2 + codedIndex(t, CODED.hasConstant) + t.blobWidth],
	[0x0c, (t) => codedIndex(t, CODED.hasCustomAttribute) + codedIndex(t, CODED.customAttributeType) + t.blobWidth],
	[0x0d, (t) => codedIndex(t, CODED.hasFieldMarshal) + t.blobWidth],
	[0x0e, (t) => 2 + codedIndex(t, CODED.hasDeclSecurity) + t.blobWidth],
	[0x0f, (t) => 6 + tableIndex(t, 0x02)],
	[0x10, (t) => 4 + tableIndex(t, 0x04)],
	[0x11, (t) => t.blobWidth],
	[0x12, (t) => tableIndex(t, 0x02) + tableIndex(t, 0x14)],
	[0x14, (t) => 2 + t.stringWidth + codedIndex(t, CODED.typeDefOrRef)],
	[0x15, (t) => tableIndex(t, 0x02) + tableIndex(t, 0x17)],
	[0x17, (t) => 2 + t.stringWidth + t.blobWidth],
	[0x18, (t) => 2 + tableIndex(t, 0x06) + codedIndex(t, CODED.hasSemantics)],
	[0x19, (t) => tableIndex(t, 0x02) + 2 * codedIndex(t, CODED.methodDefOrRef)],
	[0x1a, (t) => t.stringWidth],
	[0x1b, (t) => t.blobWidth],
	[0x1c, (t) => 2 + codedIndex(t, CODED.memberForwarded) + t.stringWidth + tableIndex(t, 0x1a)],
	[0x1d, (t) => 4 + tableIndex(t, 0x04)],
	[0x20, (t) => 16 + t.blobWidth + 2 * t.stringWidth],
	[0x21, () => 4],
	[0x22, () => 12],
	[0x23, (t) => 12 + 2 * t.blobWidth + 2 * t.stringWidth],
	[0x24, (t) => 4 + tableIndex(t, 0x23)],
	[0x25, (t) => 12 + tableIndex(t, 0x23)],
	[0x26, (t) => 4 + t.stringWidth + t.blobWidth],
	[0x27, (t) => 8 + 2 * t.stringWidth + codedIndex(t, CODED.implementation)],
	[0x28, (t) => 8 + t.stringWidth + codedIndex(t, CODED.implementation)],
	[0x29, (t) => 2 * tableIndex(t, 0x02)],
	[0x2a, (t) => 4 + codedIndex(t, CODED.typeOrMethodDef) + t.stringWidth],
	[0x2b, (t) => codedIndex(t, CODED.methodDefOrRef) + t.blobWidth],
	[0x2c, (t) => tableIndex(t, 0x2a) + codedIndex(t, CODED.typeDefOrRef)],
	[0x30, (t) => 2 * t.blobWidth + 2 * t.guidWidth],
	[0x31, (t) => tableIndex(t, 0x30) + t.blobWidth],
	[0x32, (t) => tableIndex(t, 0x06) + tableIndex(t, 0x35) + tableIndex(t, 0x33) + tableIndex(t, 0x34) + 8],
	[0x33, (t) => 4 + t.stringWidth],
	[0x34, (t) => t.stringWidth + t.blobWidth],
	[0x35, (t) => tableIndex(t, 0x35) + t.blobWidth],
	[0x36, (t) => 2 * tableIndex(t, 0x06)],
	[0x37, (t) => codedIndex(t, CODED.hasCustomDebugInformation) + t.guidWidth + t.blobWidth],
]);

/** Where one table's rows start, and how wide each one is. */
interface TablePlacement {
	readonly start: number;
	readonly width: number;
}

interface Walk {
	readonly census: Census;
	readonly placements: ReadonlyMap<number, TablePlacement>;
	/** Where the heaps live, indexed by the widths the census declares. */
	readonly heaps: ReadonlyMap<string, { base: number; size: number }>;
}

function tablesLines(
	data: Buffer,
	rootAt: number,
	streams: MetadataStream[],
	stream: MetadataStream,
	layout: PeLayout,
	entryPoint: number,
): string[] {
	const lines: string[] = [];
	const at = rootAt + stream.offset;
	const end = Math.min(at + stream.size, data.length);
	const heapSizes = u8(data, at + 6) ?? 0;
	const valid = u64(data, at + 8);
	if (valid === null) {
		lines.push(`  the ${stream.name} stream is cut off inside its header`);
		return lines;
	}

	const ids: number[] = [];
	for (let i = 0; i < 64; i++) {
		if (((valid >> BigInt(i)) & 1n) !== 0n) ids.push(i);
	}
	const rows = new Map<number, number>();
	let rowsAt = at + 24;
	let cutOff = false;
	for (const id of ids) {
		const rowCount = u32(data, rowsAt);
		if (rowCount === null || rowsAt + 4 > end) {
			cutOff = true;
			break;
		}
		rows.set(id, rowCount);
		rowsAt += 4;
	}
	lines.push(`  tables (${ids.length}):`);
	for (const id of ids) {
		const rowCount = rows.get(id);
		const name = nameOfTable(id);
		lines.push(`    ${name}: ${rowCount === undefined ? "(count not readable)" : count(rowCount, "row", "rows")}`);
	}
	if (cutOff) {
		lines.push(`  the row counts are cut off after ${rows.size} of ${count(ids.length, "table", "tables")}`);
		return lines;
	}

	const census = censusOf(rows, heapSizes);
	if ((heapSizes & 0x20) !== 0) {
		lines.push(`  the ${stream.name} stream carries extra data this report does not read`);
		return lines;
	}
	let rowAt = rowsAt;
	const placements = new Map<number, TablePlacement>();
	let walkProblem: string | null = null;
	for (const id of ids) {
		const width = ROW_WIDTHS.get(id);
		if (width === undefined) {
			walkProblem = `  the table walk stops at ${nameOfTable(id)}: no row width is known for it`;
			break;
		}
		placements.set(id, { start: rowAt, width: width(census) });
		rowAt += census.rowCount(id) * width(census);
	}
	if (walkProblem === null && rowAt > end) {
		walkProblem = `  the table rows run past the end of the ${stream.name} stream`;
	}
	if (walkProblem !== null) {
		lines.push(walkProblem);
		return lines;
	}

	const heaps = new Map<string, { base: number; size: number }>();
	for (const heap of streams) {
		const base = rootAt + heap.offset;
		heaps.set(heap.name, { base, size: Math.max(0, Math.min(heap.size, data.length - base)) });
	}
	const walk: Walk = { census, placements, heaps };
	lines.push(...identityLines(data, walk));
	lines.push(...managedCodeLines(data, walk, layout, entryPoint));
	return lines;
}

function nameOfTable(id: number): string {
	const name = TABLE_NAMES.find(([table]) => table === id)?.[1];
	return name === undefined ? `table ${hex(id)}` : name;
}

// ---------------------------------------------------------------------------
// The identity: module, assembly, references, target framework
// ---------------------------------------------------------------------------

/** One table's row, as a base offset; null when the row lies past the file. */
function rowBase(walk: Walk, id: number, row: number): number | null {
	const placement = walk.placements.get(id);
	if (placement === undefined || row < 1 || row > walk.census.rowCount(id)) return null;
	return placement.start + (row - 1) * placement.width;
}

function indexAt(data: Buffer, offset: number, width: number): number | null {
	return width === 2 ? u16(data, offset) : u32(data, offset);
}

/** The string heap entry at `index`, escaped to one line, capped for display. */
function stringAt(data: Buffer, walk: Walk, index: number): string | null {
	if (index === 0) return "";
	const heap = walk.heaps.get("#Strings");
	if (heap === undefined || index >= heap.size) return null;
	const from = heap.base + index;
	const end = heap.base + heap.size;
	const nul = data.subarray(from, end).indexOf(0);
	return printable(data.subarray(from, nul === -1 ? end : from + nul));
}

/** The GUID heap entry at `index`, in the registry's 8-4-4-4-12 spelling. */
function guidAt(data: Buffer, walk: Walk, index: number): string | null {
	if (index === 0) return null;
	const heap = walk.heaps.get("#GUID");
	if (heap === undefined) return null;
	const from = heap.base + (index - 1) * 16;
	if (from + 16 > heap.base + heap.size || from + 16 > data.length) return null;
	const bytes = data.subarray(from, from + 16);
	const head = bytes.readUInt32LE(0).toString(16).padStart(8, "0");
	const parts = [bytes.readUInt16LE(4), bytes.readUInt16LE(6)].map((part) => part.toString(16).padStart(4, "0"));
	return `${head}-${parts[0]}-${parts[1]}-${bytes.subarray(8, 10).toString("hex")}-${bytes
		.subarray(10)
		.toString("hex")}`;
}

/**
 * The blob heap entry at `index`: a compressed length, then that many bytes.
 * Blob indexes are byte offsets, like the string heap's — index 0 is the
 * reserved empty blob, whose reserved offset holds a zero length anyway.
 */
function blobAt(data: Buffer, walk: Walk, index: number): Buffer | null {
	if (index === 0) return data.subarray(0, 0);
	const heap = walk.heaps.get("#Blob");
	if (heap === undefined || index >= heap.size) return null;
	const length = readCompressed(data, heap.base + index);
	if (
		length === null ||
		length.next + length.value > heap.base + heap.size ||
		length.next + length.value > data.length
	) {
		return null;
	}
	return data.subarray(length.next, length.next + length.value);
}

function identityLines(data: Buffer, walk: Walk): string[] {
	const lines: string[] = [];
	lines.push(...moduleLine(data, walk), ...assemblyLines(data, walk), ...referenceLines(data, walk));
	const framework = targetFrameworkLine(data, walk);
	if (framework !== null) lines.push(framework);
	return lines;
}

function moduleLine(data: Buffer, walk: Walk): string[] {
	const base = rowBase(walk, 0x00, 1);
	if (base === null) return [];
	const nameIndex = indexAt(data, base + 2, walk.census.stringWidth);
	const mvidIndex = indexAt(data, base + 2 + walk.census.stringWidth, walk.census.guidWidth);
	if (nameIndex === null || mvidIndex === null) return ["  module: (the table row is not readable)"];
	const name = stringAt(data, walk, nameIndex);
	const mvid = guidAt(data, walk, mvidIndex);
	return [`  module: ${name ?? "(the name is not readable)"}${mvid === null ? "" : ` (MVID ${mvid})`}`];
}

function assemblyLines(data: Buffer, walk: Walk): string[] {
	const base = rowBase(walk, 0x20, 1);
	if (base === null) return [];
	const hashAlgorithm = u32(data, base);
	const nameIndex = indexAt(data, base + 16 + walk.census.blobWidth, walk.census.stringWidth);
	const cultureIndex = indexAt(
		data,
		base + 16 + walk.census.blobWidth + walk.census.stringWidth,
		walk.census.stringWidth,
	);
	if (hashAlgorithm === null || nameIndex === null || cultureIndex === null) {
		return ["  assembly: (the table row is not readable)"];
	}
	const version = [4, 6, 8, 10].map((offset) => u16(data, base + offset) ?? 0).join(".");
	const name = stringAt(data, walk, nameIndex);
	const culture = stringAt(data, walk, cultureIndex);
	const lines = [`  assembly: ${name ?? "(the name is not readable)"}, version ${version}`];
	lines.push(`    culture: ${culture === null ? "(not readable)" : culture === "" ? "neutral" : culture}`);
	lines.push(`    hash algorithm: ${nameOf(HASH_ALGORITHMS, hashAlgorithm, hex(hashAlgorithm))}`);
	const flags = u32(data, base + 12) ?? 0;
	if (flags !== 0) lines.push(`    flags: ${flagList(flags, ASSEMBLY_FLAGS)}`);
	return lines;
}

function referenceLines(data: Buffer, walk: Walk): string[] {
	const total = walk.census.rowCount(0x23);
	if (total === 0) return [];
	const lines = [`  assembly references (${total}):`];
	const listed = Math.min(total, MAX_LISTED_ASSEMBLY_REFS);
	for (let row = 1; row <= listed; row++) {
		const base = rowBase(walk, 0x23, row);
		if (base === null) {
			lines.push("    (the references run past the end of the file)");
			break;
		}
		const nameIndex = indexAt(data, base + 12 + walk.census.blobWidth, walk.census.stringWidth);
		const version = [0, 2, 4, 6].map((offset) => u16(data, base + offset) ?? 0).join(".");
		const name = nameIndex === null ? null : stringAt(data, walk, nameIndex);
		lines.push(`    ${name ?? "(the name is not readable)"}, version ${version}`);
	}
	if (total > listed) lines.push(`    ... and ${total - listed} more`);
	return lines;
}

/**
 * The name of the type owning a MethodDef row. Methods are grouped by type:
 * each TypeDef row names the first method of its range, and the ranges are
 * ascending and contiguous, so the owner is the last type whose first method
 * number is at or below this one. The method's own name is never the answer
 * here — a constructor is named `.ctor` wherever it lives.
 */
function methodOwnerTypeName(data: Buffer, walk: Walk, methodRow: number): string | null {
	const types = walk.placements.get(0x02);
	if (types === undefined) return null;
	// The MethodList column is the TypeDef row's last column.
	const methodIndexWidth = tableIndex(walk.census, 0x06);
	const methodListAt = types.width - methodIndexWidth;
	let owner: number | null = null;
	for (let row = 1; row <= walk.census.rowCount(0x02); row++) {
		const base = types.start + (row - 1) * types.width;
		const firstMethod = indexAt(data, base + methodListAt, methodIndexWidth);
		if (firstMethod === null) return null;
		if (firstMethod <= methodRow) owner = base;
		else break;
	}
	if (owner === null) return null;
	const nameIndex = indexAt(data, owner + 4, walk.census.stringWidth);
	return nameIndex === null ? null : stringAt(data, walk, nameIndex);
}

/**
 * The target framework, when the assembly carries the standard attribute for
 * it: a custom attribute whose parent is the assembly row itself and whose
 * type resolves, through MemberRef or MethodDef, to a name of
 * `TargetFrameworkAttribute`. The value blob is a prolog of 0x0001 and one
 * SerString — the format fixes the shape of this one attribute, so decoding
 * exactly this much is reading, not guessing.
 */
function targetFrameworkLine(data: Buffer, walk: Walk): string | null {
	const placement = walk.placements.get(0x0c);
	if (placement === undefined) return null;
	const parentWidth = codedIndex(walk.census, CODED.hasCustomAttribute);
	const typeWidth = codedIndex(walk.census, CODED.customAttributeType);
	const memberRefParentWidth = codedIndex(walk.census, CODED.memberRefParent);
	const resolutionScopeWidth = codedIndex(walk.census, CODED.resolutionScope);
	const scanned = Math.min(walk.census.rowCount(0x0c), MAX_SCANNED_ATTRIBUTES);
	for (let row = 1; row <= scanned; row++) {
		const base = rowBase(walk, 0x0c, row);
		if (base === null) return null;
		const parent = indexAt(data, base, parentWidth);
		if (parent === null) return null;
		// The assembly row is tag 14 in the HasCustomAttribute list; row 1 is
		// the assembly itself (there is exactly one).
		if ((parent & 31) !== 14 || parent >> 5 !== 1) continue;

		const type = indexAt(data, base + parentWidth, typeWidth);
		if (type === null) return null;
		const tag = type & 7;
		const typeRow = type >> 3;
		if (tag !== 2 && tag !== 3) continue;
		let name: string | null;
		if (tag === 2) {
			name = methodOwnerTypeName(data, walk, typeRow);
		} else {
			const memberRefBase = rowBase(walk, 0x0a, typeRow);
			if (memberRefBase === null) continue;
			const attributeClass = indexAt(data, memberRefBase, memberRefParentWidth);
			if (attributeClass === null || (attributeClass & 7) !== 1) continue;
			const typeRefBase = rowBase(walk, 0x01, attributeClass >> 3);
			if (typeRefBase === null) continue;
			// TypeRef columns: ResolutionScope first, then TypeName.
			const nameIndex = indexAt(data, typeRefBase + resolutionScopeWidth, walk.census.stringWidth);
			name = nameIndex === null ? null : stringAt(data, walk, nameIndex);
		}
		if (name !== "TargetFrameworkAttribute") continue;

		const valueIndex = indexAt(data, base + parentWidth + typeWidth, walk.census.blobWidth);
		const blob = valueIndex === null ? null : blobAt(data, walk, valueIndex);
		if (blob === null) return "  target framework: (the attribute's value is not readable)";
		const prolog = u16(blob, 0);
		if (prolog !== 0x0001) return "  target framework: (the attribute's value has no attribute prolog)";
		const length = readCompressed(blob, 2);
		if (length === null || length.next + length.value > blob.length) {
			return "  target framework: (the attribute's value string is cut off)";
		}
		return `  target framework: ${printable(blob.subarray(length.next, length.next + length.value))}`;
	}
	const total = walk.census.rowCount(0x0c);
	if (total > scanned) return `  (the attribute scan stopped after ${scanned} of ${total} rows)`;
	return null;
}

// ---------------------------------------------------------------------------
// Managed code: method headers, IL operands, and resolved tokens
// ---------------------------------------------------------------------------

/**
 * Operand lengths for the one-byte opcodes. The sentinel values are not
 * lengths: `SWITCH` reads a count and then that many branch targets, and
 * `PREFIX` means the real opcode is the next byte. A `-1` is an opcode this
 * format does not define (or a reserved one), and a body that reaches one is
 * undecodable rather than silently skipped: guessing an operand length would
 * misalign every instruction after it.
 */
const OP_SWITCH = 254;
const OP_PREFIX = 253;
const OPERAND_SIZES = new Int16Array(256).fill(-1);

function operands(from: number, through: number, size: number): void {
	for (let op = from; op <= through; op++) OPERAND_SIZES[op] = size;
}

// None, one, two, four and eight byte operands, by the ranges in ECMA-335
// Partition III. Token operands are four bytes and are resolved separately.
operands(0x00, 0x0d, 0);
operands(0x0e, 0x13, 1);
operands(0x14, 0x1e, 0);
operands(0x1f, 0x1f, 1);
operands(0x20, 0x20, 4);
operands(0x21, 0x21, 8);
operands(0x22, 0x22, 4);
operands(0x23, 0x23, 8);
operands(0x25, 0x26, 0);
operands(0x27, 0x29, 4);
operands(0x2a, 0x2a, 0);
operands(0x2b, 0x37, 1);
operands(0x38, 0x44, 4);
OPERAND_SIZES[0x45] = OP_SWITCH;
operands(0x46, 0x6e, 0);
operands(0x6f, 0x75, 4);
operands(0x76, 0x76, 0);
OPERAND_SIZES[0x79] = 4;
OPERAND_SIZES[0x7a] = 0;
operands(0x7b, 0x81, 4);
operands(0x82, 0x8b, 0);
OPERAND_SIZES[0x8c] = 4;
OPERAND_SIZES[0x8d] = 4;
OPERAND_SIZES[0x8e] = 0;
OPERAND_SIZES[0x8f] = 4;
operands(0x90, 0xa2, 0);
operands(0xa3, 0xa5, 4);
OPERAND_SIZES[0xc2] = 4;
OPERAND_SIZES[0xc3] = 0;
OPERAND_SIZES[0xc6] = 4;
OPERAND_SIZES[0xd0] = 4;
operands(0xd1, 0xdc, 0);
OPERAND_SIZES[0xdd] = 4;
OPERAND_SIZES[0xde] = 1;
OPERAND_SIZES[0xdf] = 0;
OPERAND_SIZES[0xe0] = 0;
OPERAND_SIZES[0xfe] = OP_PREFIX;

/** Operand lengths for the two-byte opcodes behind the 0xFE prefix. */
const FE_OPERAND_SIZES = new Int16Array(256).fill(-1);
feOperands(0x00, 0x05, 0);
feOperands(0x06, 0x07, 4);
feOperands(0x09, 0x0e, 2);
feOperands(0x0f, 0x0f, 0);
feOperands(0x11, 0x11, 0);
feOperands(0x12, 0x12, 1);
feOperands(0x13, 0x14, 0);
feOperands(0x15, 0x16, 4);
feOperands(0x17, 0x18, 0);
feOperands(0x19, 0x19, 1);
feOperands(0x1a, 0x1a, 0);
feOperands(0x1c, 0x1c, 4);
feOperands(0x1d, 0x1e, 0);

function feOperands(from: number, through: number, size: number): void {
	for (let op = from; op <= through; op++) FE_OPERAND_SIZES[op] = size;
}

/** A table row or heap entry read for token resolution; null means it was not readable. */
interface CodeIndex {
	readonly typeCount: number;
	readonly methodCount: number;
	readonly fieldCount: number;
	readonly typeNames: readonly string[];
	readonly typeFirstFields: readonly (number | null)[];
	readonly typeFirstMethods: readonly (number | null)[];
	readonly methodNames: readonly string[];
	readonly fieldNames: readonly string[];
	readonly fieldOwners: readonly (string | null)[];
	readonly typeRefs: readonly string[];
	readonly moduleRefs: readonly string[];
}

function fullTypeName(name: string | null, namespace: string | null): string {
	const shown = name === null ? "(name not readable)" : name === "" ? "(empty name)" : name;
	return namespace === null || namespace === "" ? shown : `${namespace}.${shown}`;
}

/** A method or field range width: the next type's first row, minus this one's. */
function rangeCount(first: number | null, next: number | null, total: number): number {
	if (first === null || first < 1 || first > total) return 0;
	const end = next === null ? total + 1 : next;
	return end > first ? Math.min(end, total + 1) - first : 0;
}

/**
 * Names, owners and ranges for the four tables token resolution needs.
 * Rows are one-based in the format and zero-based in these arrays.
 */
function buildCodeIndex(data: Buffer, walk: Walk): CodeIndex {
	const census = walk.census;
	const stringWidth = census.stringWidth;
	const typeCount = census.rowCount(0x02);
	const methodCount = census.rowCount(0x06);
	const fieldCount = census.rowCount(0x04);
	const typeNames = new Array<string>(typeCount).fill("(type not readable)");
	const typeFirstFields = new Array<number | null>(typeCount).fill(null);
	const typeFirstMethods = new Array<number | null>(typeCount).fill(null);
	const methodNames = new Array<string>(methodCount).fill("(method not readable)");
	const fieldNames = new Array<string>(fieldCount).fill("(field not readable)");
	const fieldOwners = new Array<string | null>(fieldCount).fill(null);
	const methodOwners = new Array<string | null>(methodCount).fill(null);

	const typePlacement = walk.placements.get(0x02);
	if (typePlacement !== undefined) {
		const fieldWidth = tableIndex(census, 0x04);
		const methodWidth = tableIndex(census, 0x06);
		const methodListAt = typePlacement.width - methodWidth;
		const fieldListAt = methodListAt - fieldWidth;
		for (let row = 1; row <= typeCount; row++) {
			const base = rowBase(walk, 0x02, row);
			if (base === null) continue;
			const nameIndex = indexAt(data, base + 4, stringWidth);
			const namespaceIndex = indexAt(data, base + 4 + stringWidth, stringWidth);
			const name = nameIndex === null ? null : stringAt(data, walk, nameIndex);
			const namespace = namespaceIndex === null ? null : stringAt(data, walk, namespaceIndex);
			typeNames[row - 1] = fullTypeName(name, namespace);
			typeFirstFields[row - 1] = indexAt(data, base + fieldListAt, fieldWidth);
			typeFirstMethods[row - 1] = indexAt(data, base + methodListAt, methodWidth);
		}
	}

	// A type's method range starts at its MethodList and ends at the next
	// type's. The same rule gives each field its owner.
	for (let row = 0; row < typeCount; row++) {
		const first = typeFirstMethods[row];
		const next = row + 1 < typeCount ? typeFirstMethods[row + 1] : null;
		if (first === null || first < 1 || first > methodCount) continue;
		const end = next === null ? methodCount + 1 : next;
		if (end <= first) continue;
		const last = Math.min(end - 1, methodCount);
		for (let method = first; method <= last; method++) {
			if (methodOwners[method - 1] === null) methodOwners[method - 1] = typeNames[row];
		}
	}
	for (let row = 0; row < typeCount; row++) {
		const first = typeFirstFields[row];
		const next = row + 1 < typeCount ? typeFirstFields[row + 1] : null;
		if (first === null || first < 1 || first > fieldCount) continue;
		const end = next === null ? fieldCount + 1 : next;
		if (end <= first) continue;
		const last = Math.min(end - 1, fieldCount);
		for (let field = first; field <= last; field++) {
			if (fieldOwners[field - 1] === null) fieldOwners[field - 1] = typeNames[row];
		}
	}

	for (let row = 1; row <= methodCount; row++) {
		const base = rowBase(walk, 0x06, row);
		if (base === null) continue;
		// MethodDef columns: RVA (4), ImplFlags (2), Flags (2), Name.
		const nameIndex = indexAt(data, base + 8, stringWidth);
		const name = nameIndex === null ? null : stringAt(data, walk, nameIndex);
		const owner = methodOwners[row - 1];
		const shown = name === null ? "(name not readable)" : name === "" ? "(empty name)" : name;
		methodNames[row - 1] = owner === null ? shown : `${owner}.${shown}`;
	}
	for (let row = 1; row <= fieldCount; row++) {
		const base = rowBase(walk, 0x04, row);
		if (base === null) continue;
		// Field columns: Flags (2), Name.
		const nameIndex = indexAt(data, base + 2, stringWidth);
		const name = nameIndex === null ? null : stringAt(data, walk, nameIndex);
		fieldNames[row - 1] = name === null ? "(name not readable)" : name === "" ? "(empty name)" : name;
	}

	const typeRefs = new Array<string>(census.rowCount(0x01)).fill("(type not readable)");
	const resolutionScopeWidth = codedIndex(census, CODED.resolutionScope);
	for (let row = 1; row <= typeRefs.length; row++) {
		const base = rowBase(walk, 0x01, row);
		if (base === null) continue;
		const nameIndex = indexAt(data, base + resolutionScopeWidth, stringWidth);
		const namespaceIndex = indexAt(data, base + resolutionScopeWidth + stringWidth, stringWidth);
		const name = nameIndex === null ? null : stringAt(data, walk, nameIndex);
		const namespace = namespaceIndex === null ? null : stringAt(data, walk, namespaceIndex);
		typeRefs[row - 1] = fullTypeName(name, namespace);
	}

	const moduleRefs = new Array<string>(census.rowCount(0x1a)).fill("(module not readable)");
	for (let row = 1; row <= moduleRefs.length; row++) {
		const base = rowBase(walk, 0x1a, row);
		if (base === null) continue;
		const nameIndex = indexAt(data, base, stringWidth);
		const name = nameIndex === null ? null : stringAt(data, walk, nameIndex);
		moduleRefs[row - 1] = name === null ? "(module not readable)" : name === "" ? "(empty name)" : name;
	}

	return {
		typeCount,
		methodCount,
		fieldCount,
		typeNames,
		typeFirstFields,
		typeFirstMethods,
		methodNames,
		fieldNames,
		fieldOwners,
		typeRefs,
		moduleRefs,
	};
}

/** The type name a MemberRef's parent coded index names, or null when it names none. */
function memberRefParentName(index: CodeIndex, parent: number): string | null {
	const bits = CODED.memberRefParent.bits;
	const tag = parent & ((1 << bits) - 1);
	const row = parent >>> bits;
	if (tag === 0) return index.typeNames[row - 1] ?? null;
	if (tag === 1) return index.typeRefs[row - 1] ?? null;
	if (tag === 2) return index.moduleRefs[row - 1] ?? null;
	if (tag === 3) return index.methodNames[row - 1] ?? null;
	if (tag === 4) return `TypeSpec(${row})`;
	return null;
}

/** A MemberRef target: its parent's name and the member's own name, dot-joined. */
function memberRefTarget(data: Buffer, walk: Walk, index: CodeIndex, row: number): string | null {
	const base = rowBase(walk, 0x0a, row);
	if (base === null) return null;
	const parentWidth = codedIndex(walk.census, CODED.memberRefParent);
	const parent = indexAt(data, base, parentWidth);
	const nameIndex = indexAt(data, base + parentWidth, walk.census.stringWidth);
	if (parent === null || nameIndex === null) return null;
	const memberName = stringAt(data, walk, nameIndex);
	const member = memberName === null ? "(member name not readable)" : memberName === "" ? "(empty name)" : memberName;
	const parentName = memberRefParentName(index, parent);
	return parentName === null ? `MemberRef(${row}).${member}` : `${parentName}.${member}`;
}

/** The MethodDef or MemberRef a call token names. Unresolved tokens keep their spelling. */
function methodTarget(data: Buffer, walk: Walk, index: CodeIndex, token: number): string {
	const table = token >>> 24;
	const row = token & 0x00ffffff;
	if (table === 0x06) return index.methodNames[row - 1] ?? `MethodDef(${hex(token)})`;
	if (table === 0x0a) return memberRefTarget(data, walk, index, row) ?? `MemberRef(${hex(token)})`;
	return `token ${hex(token)}`;
}

/** The Field or MemberRef a field instruction's token names. */
function fieldTarget(data: Buffer, walk: Walk, index: CodeIndex, token: number): string {
	const table = token >>> 24;
	const row = token & 0x00ffffff;
	if (table === 0x04) {
		const name = index.fieldNames[row - 1];
		if (name === undefined) return `Field(${hex(token)})`;
		const owner = index.fieldOwners[row - 1];
		return owner === null ? name : `${owner}.${name}`;
	}
	if (table === 0x0a) return memberRefTarget(data, walk, index, row) ?? `MemberRef(${hex(token)})`;
	return `token ${hex(token)}`;
}

/**
 * The string behind an `ldstr` token. The #US heap stores a compressed byte
 * length that includes one trailing flag byte, then UTF-16LE code units; the
 * flag is not part of the string.
 */
function userStringAt(data: Buffer, walk: Walk, token: number): string | null {
	if (token >>> 24 !== 0x70) return null;
	const index = token & 0x00ffffff;
	const heap = walk.heaps.get("#US");
	if (heap === undefined || index >= heap.size) return null;
	const length = readCompressed(data, heap.base + index);
	if (length === null) return null;
	if (length.value === 0) return "";
	if (length.next + length.value > heap.base + heap.size || length.next + length.value > data.length) return null;
	const payload = data.subarray(length.next, length.next + length.value);
	if (payload.length === 0) return "";
	const text = payload.subarray(0, payload.length - 1);
	if (text.length % 2 !== 0) return null;
	return text.toString("utf16le");
}

/** A user string with quotes, backslashes and controls escaped, then capped for display. */
function displayUserString(text: string): string {
	const characters = Array.from(text);
	let out = "";
	let used = 0;
	let cut = 0;
	for (let i = 0; i < characters.length; i++) {
		const character = characters[i];
		const code = character.codePointAt(0) ?? 0;
		const piece =
			character === "\\"
				? "\\\\"
				: character === '"'
					? '\\"'
					: code < 0x20 || code === 0x7f
						? `\\u${code.toString(16).padStart(4, "0")}`
						: character;
		if (used + piece.length > MAX_USER_STRING_CHARS) {
			cut = characters.length - i;
			break;
		}
		out += piece;
		used += piece.length;
	}
	return cut > 0 ? `${out}… [${cut} more char(s)]` : out;
}

/** The method an entry point token names, or a line saying why it does not. */
function entryPointLine(index: CodeIndex, token: number): string | null {
	if (token === 0) return null;
	if (token >>> 24 === 0x06) {
		const name = index.methodNames[(token & 0x00ffffff) - 1];
		if (name !== undefined) return `    entry point method: ${name}`;
	}
	return `    entry point method: (token ${hex(token)} does not name a readable MethodDef)`;
}

/** A method body's code range, after its header's sizes have been checked against the file. */
interface BodyHeader {
	readonly codeAt: number;
	readonly codeSize: number;
}

function readBodyHeader(data: Buffer, layout: PeLayout, rva: number): BodyHeader | null {
	const at = rvaToOffset(layout, data, rva);
	if (at === null) return null;
	const first = u8(data, at);
	if (first === null) return null;
	if ((first & 3) === 2) {
		const codeSize = first >>> 2;
		const codeAt = at + 1;
		return codeAt + codeSize <= data.length ? { codeAt, codeSize } : null;
	}
	if ((first & 3) !== 3) return null;
	const flags = u16(data, at);
	if (flags === null) return null;
	const headerSize = (flags >>> 12) * 4;
	if (headerSize < 12 || at + headerSize > data.length) return null;
	const codeSize = u32(data, at + 4);
	if (codeSize === null) return null;
	const codeAt = at + headerSize;
	return codeAt + codeSize <= data.length ? { codeAt, codeSize } : null;
}

interface DecodedBody {
	readonly ok: boolean;
	readonly capped: boolean;
	readonly calls: Map<string, number>;
	readonly fields: Map<string, number>;
	readonly strings: Set<string>;
	readonly badStrings: number;
}

/**
 * Walk one body's IL by operand length. Calls, field accesses and `ldstr`
 * strings are collected only from a body walked to its end; an undefined
 * opcode or an operand past the body makes the whole body undecodable.
 */
function decodeBody(data: Buffer, walk: Walk, index: CodeIndex, body: BodyHeader): DecodedBody {
	const calls = new Map<string, number>();
	const fields = new Map<string, number>();
	const strings = new Set<string>();
	const result = (ok: boolean, capped: boolean, badStrings: number): DecodedBody => ({
		ok,
		capped,
		calls,
		fields,
		strings,
		badStrings,
	});
	const add = (tally: Map<string, number>, key: string): void => {
		tally.set(key, (tally.get(key) ?? 0) + 1);
	};
	const end = body.codeAt + body.codeSize;
	let at = body.codeAt;
	let instructions = 0;
	let badStrings = 0;
	while (at < end) {
		if (instructions >= MAX_BODY_INSTRUCTIONS) return result(true, true, badStrings);
		const op = data[at];
		at += 1;
		let operand = OPERAND_SIZES[op];
		let twoByte = -1;
		if (operand === OP_PREFIX) {
			if (at >= end) return result(false, false, badStrings);
			twoByte = data[at];
			at += 1;
			operand = FE_OPERAND_SIZES[twoByte];
		}
		if (operand < 0) return result(false, false, badStrings);
		if (operand === OP_SWITCH) {
			if (at + 4 > end) return result(false, false, badStrings);
			const targets = data.readUInt32LE(at);
			at += 4;
			if (targets > (end - at) / 4) return result(false, false, badStrings);
			at += targets * 4;
			instructions++;
			continue;
		}
		if (at + operand > end) return result(false, false, badStrings);
		if (op === 0x28 || op === 0x6f || op === 0x73 || (op === 0xfe && (twoByte === 0x06 || twoByte === 0x07))) {
			add(calls, methodTarget(data, walk, index, data.readUInt32LE(at)));
		} else if (op >= 0x7b && op <= 0x80) {
			add(fields, fieldTarget(data, walk, index, data.readUInt32LE(at)));
		} else if (op === 0x72) {
			const text = userStringAt(data, walk, data.readUInt32LE(at));
			if (text === null) badStrings++;
			else strings.add(text);
		}
		at += operand;
		instructions++;
	}
	return result(true, false, badStrings);
}

interface EdgeTally {
	readonly counts: Map<string, number>;
	occurrences: number;
	dropped: number;
}

function newEdgeTally(): EdgeTally {
	return { counts: new Map(), occurrences: 0, dropped: 0 };
}

function addEdge(tally: EdgeTally, key: string): void {
	tally.occurrences++;
	const current = tally.counts.get(key);
	if (current !== undefined) {
		tally.counts.set(key, current + 1);
		return;
	}
	if (tally.counts.size < MAX_DISTINCT_EDGES) {
		tally.counts.set(key, 1);
		return;
	}
	tally.dropped++;
}

function edgeLines(label: string, tally: EdgeTally): string[] {
	if (tally.counts.size === 0) return [`    ${label}: none`];
	const rows = [...tally.counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const lines = [
		`    ${label} (${tally.counts.size} distinct${
			tally.dropped > 0 ? " listed" : ""
		}, ${tally.occurrences} ${tally.occurrences === 1 ? "occurrence" : "occurrences"}):`,
	];
	for (const [key, occurrences] of rows.slice(0, MAX_LISTED_EDGES)) {
		lines.push(`      ${key} ${occurrences}`);
	}
	if (rows.length > MAX_LISTED_EDGES) lines.push(`      ... and ${rows.length - MAX_LISTED_EDGES} more`);
	if (tally.dropped > 0) {
		lines.push(
			`      ${tally.dropped} occurrence(s) beyond the ${MAX_DISTINCT_EDGES}-edge cap were counted but not listed`,
		);
	}
	return lines;
}

/**
 * The managed-code block: type names with their method and field counts,
 * method-body statistics, the resolved entry point, distinct user strings,
 * and the call/field edges read from the IL. Every listing has a cap and
 * says how much it did not show.
 */
function managedCodeLines(data: Buffer, walk: Walk, layout: PeLayout, entryPoint: number): string[] {
	const typeCount = walk.census.rowCount(0x02);
	const methodCount = walk.census.rowCount(0x06);
	if (typeCount === 0 && methodCount === 0) return [];
	const index = buildCodeIndex(data, walk);
	const lines = ["  managed code:"];

	if (typeCount === 0) {
		lines.push("    types: none");
	} else {
		lines.push(`    types (${typeCount}):`);
		const listed = Math.min(typeCount, MAX_LISTED_TYPES);
		for (let row = 1; row <= listed; row++) {
			const methodEnd = row < typeCount ? index.typeFirstMethods[row] : null;
			const fieldEnd = row < typeCount ? index.typeFirstFields[row] : null;
			const methods = rangeCount(index.typeFirstMethods[row - 1], methodEnd, methodCount);
			const fields = rangeCount(index.typeFirstFields[row - 1], fieldEnd, index.fieldCount);
			lines.push(
				`      ${index.typeNames[row - 1]} (${count(methods, "method", "methods")}, ${count(fields, "field", "fields")})`,
			);
		}
		if (typeCount > listed) lines.push(`      ... and ${typeCount - listed} more`);
	}

	let noBody = 0;
	let withBody = 0;
	let undecodable = 0;
	let unreadMethods = 0;
	let unreadIl = 0;
	let attempted = 0;
	let ilBytes = 0;
	let cappedBodies = 0;
	let badStrings = 0;
	const calls = newEdgeTally();
	const fields = newEdgeTally();
	const strings = new Set<string>();

	for (let row = 1; row <= methodCount; row++) {
		const base = rowBase(walk, 0x06, row);
		const rva = base === null ? null : u32(data, base);
		if (rva === null) {
			undecodable++;
			continue;
		}
		if (rva === 0) {
			noBody++;
			continue;
		}
		if (attempted >= MAX_METHOD_BODIES) {
			unreadMethods++;
			continue;
		}
		attempted++;
		const header = readBodyHeader(data, layout, rva);
		if (header === null) {
			undecodable++;
			continue;
		}
		if (ilBytes + header.codeSize > MAX_IL_BYTES) {
			unreadIl++;
			continue;
		}
		const decoded = decodeBody(data, walk, index, header);
		if (!decoded.ok) {
			undecodable++;
			continue;
		}
		ilBytes += header.codeSize;
		withBody++;
		if (decoded.capped) cappedBodies++;
		badStrings += decoded.badStrings;
		for (const text of decoded.strings) strings.add(text);
		const source = index.methodNames[row - 1];
		for (const [target, occurrences] of decoded.calls) {
			for (let i = 0; i < occurrences; i++) addEdge(calls, `${source} -> ${target}`);
		}
		for (const [target, occurrences] of decoded.fields) {
			for (let i = 0; i < occurrences; i++) addEdge(fields, `${source} -> ${target}`);
		}
	}

	const unread = unreadMethods + unreadIl;
	const summary = [
		`${withBody} with a body`,
		`${noBody} without`,
		`${undecodable} undecodable`,
		...(unread > 0 ? [`${unread} not read`] : []),
	];
	lines.push(methodCount === 0 ? "    methods: 0" : `    methods: ${methodCount} (${summary.join(", ")})`);
	lines.push(
		`    method bodies read: ${withBody} (${count(ilBytes, "byte", "bytes")} of IL; cap ${MAX_METHOD_BODIES} methods / ${
			MAX_IL_BYTES / (1024 * 1024)
		} MiB)`,
	);
	const entry = entryPointLine(index, entryPoint);
	if (entry !== null) lines.push(entry);

	if (strings.size === 0) {
		lines.push("    user strings: none");
	} else {
		const all = [...strings];
		const shown = all
			.slice(0, MAX_LISTED_USER_STRINGS)
			.map((text) => `"${displayUserString(text)}"`)
			.join(", ");
		lines.push(`    user strings (${all.length}): ${shown}`);
		if (all.length > MAX_LISTED_USER_STRINGS) {
			lines.push(`      ... and ${all.length - MAX_LISTED_USER_STRINGS} more`);
		}
	}
	lines.push(...edgeLines("calls", calls), ...edgeLines("field accesses", fields));

	if (cappedBodies > 0) {
		lines.push(
			`    ${cappedBodies} body(ies) stopped at the ${MAX_BODY_INSTRUCTIONS}-instruction cap; their remaining instructions were not read`,
		);
	}
	if (badStrings > 0) lines.push(`    ${badStrings} ldstr token(s) did not resolve to a readable #US string`);
	if (unreadMethods > 0) {
		lines.push(`    ${unreadMethods} method(s) were not read after the ${MAX_METHOD_BODIES}-body cap`);
	}
	if (unreadIl > 0) {
		lines.push(
			`    ${unreadIl} method(s) were not read because the next body would pass the ${
				MAX_IL_BYTES / (1024 * 1024)
			} MiB IL cap`,
		);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// ReadyToRun
// ---------------------------------------------------------------------------

function readyToRunLines(data: Buffer, layout: PeLayout, cliAt: number): string[] {
	const nativeRva = u32(data, cliAt + 64) ?? 0;
	if (nativeRva === 0) return [];
	const nativeAt = rvaToOffset(layout, data, nativeRva);
	if (nativeAt === null) return [`  native header: its RVA ${hex(nativeRva)} does not land in any section`];
	const signature = u32(data, nativeAt);
	if (signature === READYTORUN_SIGNATURE) {
		const major = u16(data, nativeAt + 4) ?? 0;
		const minor = u16(data, nativeAt + 6) ?? 0;
		const flags = u32(data, nativeAt + 8) ?? 0;
		return [`  ReadyToRun: version ${major}.${minor}, flags ${hex(flags)}`];
	}
	if (signature === null) return [`  native header: the file ends before the signature at ${hex(nativeAt)}`];
	return [`  native header: the signature at ${hex(nativeAt)} is ${hex(signature)}, not the ReadyToRun "RTR\\0"`];
}

// ---------------------------------------------------------------------------
// Small shared forms
// ---------------------------------------------------------------------------

/** UTF-8 name text with control characters escaped, capped for display. */
function printable(bytes: Buffer): string {
	const shown = bytes.subarray(0, MAX_NAME_BYTES);
	let out = shown.toString("utf8");
	if (bytes.length > shown.length) out += `… [${bytes.length - shown.length} more byte(s)]`;
	let escaped = "";
	for (const character of out) {
		const code = character.codePointAt(0) ?? 0;
		escaped += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : character;
	}
	return escaped;
}

function nameOf(table: readonly (readonly [number, string])[], value: number, fallback: string): string {
	return table.find(([key]) => key === value)?.[1] ?? fallback;
}

function flagList(value: number, table: readonly (readonly [number, string])[]): string {
	const names = table.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name);
	return names.length === 0 ? "none" : names.join(", ");
}
