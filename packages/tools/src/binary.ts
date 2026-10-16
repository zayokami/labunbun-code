/**
 * InspectBinary — what an executable or object file is, read from its own
 * headers rather than from its name.
 *
 * The format comes from the bytes and never from the extension: a `.bin` that
 * is really a Mach-O, a shared library named `foo.so.1.2`, a file with no
 * suffix at all — the first four bytes answer the question, and the extension
 * only answers what somebody once intended. Each container is then reported
 * from its own structures: PE's COFF and optional headers, section table and
 * resource types; ELF's header and section headers; Mach-O's load commands,
 * including fat binaries, whose slices are reported one by one; WASM's
 * section directory. A file whose first bytes match nothing gets those bytes
 * back as hex, which is an answer too.
 *
 * Two metadata blocks are searched by name, because they are the two things
 * that tell a reader *how* a binary was built: Go's build info (the toolchain
 * version and the module list) and cargo-auditable's zlib-compressed
 * `.dep-v0` dependency JSON. The buildinfo blob has two layouts — the linker
 * has written the strings inline since Go 1.18, and behind two pointers
 * before that — and both are decoded here. The blob is located the way the Go
 * toolchain's own reader locates it: by section name where the platform gives
 * it one (`.go.buildinfo`, `__go_buildinfo`), and otherwise by scanning the
 * first writable data section. That fallback is load-bearing on Windows,
 * where the linker leaves the blob inside `.data` and no name matching will
 * ever find it. A binary without either metadata block is still a fully
 * reported binary; "no Go build info found" is a finding, not a failure.
 *
 * The whole file is read into one buffer, capped at 256 MiB, rather than
 * seeked into piecemeal: every structure this reports is an offset from an
 * arbitrary other offset, and a second read path for "far" data would be a
 * second place for a bounds check to go missing. There is one such place
 * instead — `Bytes`, whose accessors return null past the end of the file.
 * A damaged or truncated input gets the part that exists plus a line naming
 * what is missing; nothing in here throws over one.
 *
 * What this is not: a disassembler, a decompiler, or a security scanner. It
 * reads headers and two metadata sections; it never executes, loads or
 * interprets the file's code.
 */
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { type AnyTool, buildTool, formatCutMarker } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "./containment.ts";

/** Whole-report cap; past it the tail is cut with an explicit marker. */
const MAX_REPORT_CHARS = 20_000;

/** Past this the file is refused before it is read: the report needs it in memory as one buffer. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** One line of a metadata block (the module text, mainly) before it is cut, with the count kept. */
const MAX_TEXT_LINE_CHARS = 500;

/** Dep lines of a Go module text the report lists before it counts the rest. */
const MAX_DEP_ROWS = 30;

/** Packages of a cargo-auditable section the report lists before it counts the rest. */
const MAX_PACKAGE_ROWS = 30;

/** Top-level PE resource types the report lists before it counts the rest. */
const MAX_RESOURCE_ROWS = 24;

/**
 * Lines any per-entry listing may add before it stops and says so. The
 * counters that shape a report elsewhere are 16-bit fields with natural tops;
 * the ones here (a thin Mach-O's command count, a fat header's slice count, a
 * WASM section walk that may advance two bytes per line) are 32-bit or
 * unbounded, so a crafted 256 MiB file could ask for millions of lines — and
 * the report string cap only runs after they are all built. This is the one
 * place that bounds them. It sits well under what the report cap displays
 * (20,000 characters is a few hundred lines), so a listing stopped here can
 * still print the line that says it was stopped, and no report that could
 * have displayed every line ever meets this bound.
 */
const MAX_LISTED_LINES = 400;

/** A `.dep-v0` section larger than this is not inflated at all. */
const MAX_DEP_SECTION_BYTES = 16 * 1024 * 1024;

/** Inflated `.dep-v0` data is capped: a small section must not decompress into gigabytes. */
const MAX_DEP_INFLATED_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The Go buildinfo blob
// ---------------------------------------------------------------------------

/** What the linker writes at the start of the blob — 14 bytes, 0xff first. */
const BUILDINFO_MAGIC = Buffer.from("\xff Go buildinf:", "latin1");

/** The header is a fixed 32 bytes; inline string contents follow it. */
const BUILDINFO_HEADER_SIZE = 32;

/** The linker aligns the blob to 16 bytes in its address space; the reader searches aligned copies only. */
const BUILDINFO_ALIGN = 16;

/** Header byte 15, bit 0: the pointer form's endianness (0 = little, 1 = big). */
const BUILDINFO_FLAG_BIG_ENDIAN = 0x1;

/** Header byte 15, bit 1: strings inline after the header (the layout since Go 1.18). */
const BUILDINFO_FLAG_INLINE = 0x2;

/** The module text is wrapped in 16-byte sentinels whose trailing counterpart starts with a newline. */
const BUILDINFO_SENTINEL_SIZE = 16;

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** Format classification and structure report for one executable or object file. */
export function createInspectBinaryTool(cwd: string): AnyTool {
	return buildTool({
		name: "InspectBinary",
		description:
			"Reports what an executable or object file is, read from its magic bytes rather than its name: the " +
			"container format (PE, ELF, Mach-O including fat binaries, WebAssembly, or unrecognized) and that " +
			"format's own structure — machine/CPU type, entry point, sections or segments, and for PE its " +
			"subsystem and resource types. Two known metadata blocks are extracted when present: Go build info " +
			"(toolchain version and module list) and cargo-auditable `.dep-v0` dependency data. It does not " +
			"disassemble or decompile code. Use it to identify a binary and see how it was built.",
		inputSchema: z.object({
			path: z.string().describe("Path to the executable or object file to inspect"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			let source: string;
			try {
				source = guardPathContainment(input.path, cwd, "InspectBinary");
			} catch (error) {
				return { content: [{ type: "text", text: message(error) }], isError: true };
			}
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await stat(source);
			} catch {
				return { content: [{ type: "text", text: `Path not found: ${input.path}` }], isError: true };
			}
			if (info.isDirectory()) {
				return {
					content: [{ type: "text", text: `${input.path} is a directory, not a binary file.` }],
					isError: true,
				};
			}
			if (!info.isFile()) {
				return { content: [{ type: "text", text: `${input.path} is not a regular file.` }], isError: true };
			}
			// Refused before the read, not after an out-of-memory: the report
			// holds the file in one buffer, and a 2 GiB object file would take
			// the whole process down to answer a question about its headers.
			if (info.size > MAX_FILE_BYTES) {
				return {
					content: [
						{
							type: "text",
							text:
								`InspectBinary: ${input.path}: the file is ${info.size} bytes, past the ` +
								`${MAX_FILE_BYTES} this inspection reads into memory.`,
						},
					],
					isError: true,
				};
			}
			let data: Buffer;
			try {
				data = readFileSync(source);
			} catch (error) {
				return {
					content: [{ type: "text", text: `InspectBinary: ${input.path}: could not be read (${message(error)})` }],
					isError: true,
				};
			}
			let report: string;
			try {
				report = buildReport(input.path, data);
			} catch (error) {
				return {
					content: [{ type: "text", text: `InspectBinary: ${input.path}: could not be inspected (${message(error)})` }],
					isError: true,
				};
			}
			return { content: [{ type: "text", text: capReport(report) }] };
		},
	});
}

/** The report up to `MAX_REPORT_CHARS`, with the usual marker naming what was cut. */
function capReport(report: string): string {
	if (report.length <= MAX_REPORT_CHARS) return report;
	return `${report.slice(0, MAX_REPORT_CHARS)}\n${formatCutMarker(report.length - MAX_REPORT_CHARS)}`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Bounds-checked reading
// ---------------------------------------------------------------------------

type Order = "le" | "be";

/**
 * Order-aware reads over one byte range, where every accessor answers null
 * instead of reading past the end.
 *
 * The alternative — exceptions from `readUInt32LE` and a try/catch per
 * structure — makes truncation an event whose handling can be forgotten one
 * level down. Here a truncated file produces nulls, and the format code
 * decides, once per structure, what to say about them.
 */
class Bytes {
	readonly data: Buffer;
	readonly order: Order;

	constructor(data: Buffer, order: Order = "le") {
		this.data = data;
		this.order = order;
	}

	has(offset: number, length: number): boolean {
		return offset >= 0 && length >= 0 && offset + length <= this.data.length;
	}

	u8(offset: number): number | null {
		return this.has(offset, 1) ? this.data[offset] : null;
	}

	u16(offset: number): number | null {
		if (!this.has(offset, 2)) return null;
		return this.order === "le" ? this.data.readUInt16LE(offset) : this.data.readUInt16BE(offset);
	}

	u32(offset: number): number | null {
		if (!this.has(offset, 4)) return null;
		return this.order === "le" ? this.data.readUInt32LE(offset) : this.data.readUInt32BE(offset);
	}

	u64(offset: number): bigint | null {
		if (!this.has(offset, 8)) return null;
		return this.order === "le" ? this.data.readBigUInt64LE(offset) : this.data.readBigUInt64BE(offset);
	}

	/** A 64-bit value a JS number can hold exactly, or null when it cannot. */
	u64Number(offset: number): number | null {
		const value = this.u64(offset);
		if (value === null || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
		return Number(value);
	}

	/** `length` bytes as latin1 text (names, basically), or null past the end. */
	text(offset: number, length: number): string | null {
		if (!this.has(offset, length)) return null;
		return this.data.subarray(offset, offset + length).toString("latin1");
	}

	/** A NUL-terminated name within `max` bytes; null when the first byte is already missing. */
	cstring(offset: number, max: number): string | null {
		if (!this.has(offset, 1)) return null;
		const slice = this.data.subarray(offset, Math.min(offset + max, this.data.length));
		const nul = slice.indexOf(0);
		return slice.subarray(0, nul === -1 ? slice.length : nul).toString("latin1");
	}
}

/** The u32 at the start of a file in big-endian order — how every container magic is compared. */
function magicOf(data: Buffer): number | null {
	return data.length >= 4 ? data.readUInt32BE(0) : null;
}

function matchesAt(data: Buffer, offset: number, magic: Buffer): boolean {
	return (
		offset >= 0 && offset + magic.length <= data.length && data.subarray(offset, offset + magic.length).equals(magic)
	);
}

/** A file range clamped to what the file actually holds; null when nothing of it exists. */
function clampRange(data: Buffer, fileOffset: number, size: number): { fileOffset: number; size: number } | null {
	if (fileOffset < 0 || fileOffset >= data.length) return null;
	const clamped = Math.min(size, data.length - fileOffset);
	return clamped <= 0 ? null : { fileOffset, size: clamped };
}

function hex(value: number | bigint): string {
	return `0x${value.toString(16)}`;
}

function count(n: number, singular: string, plural: string): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/** Where a Go buildinfo blob may sit, and what to call that place in the report. */
interface DataRange {
	readonly label: string;
	readonly fileOffset: number;
	readonly size: number;
	/** The range's address; the blob is aligned to 16 bytes of address, not of file offset. */
	readonly address: number;
}

/** One address-space range of the file: virtual address to file offset. */
interface Mapping {
	readonly address: number;
	readonly size: number;
	readonly fileOffset: number;
}

interface DepSection {
	readonly label: string;
	readonly bytes: Buffer;
}

/** What one container's inspection produced: its display lines plus where the metadata lives. */
interface Inspection {
	readonly format: string;
	readonly lines: string[];
	readonly goCandidates: DataRange[];
	readonly depSections: DepSection[];
	readonly mappings: Mapping[];
	/** False when this container is not one the Go and cargo-auditable blocks are embedded in. */
	readonly searched: boolean;
	/** True when the go and cargo lines are already part of `lines` (fat Mach-O slices). */
	readonly metadataIncluded: boolean;
}

function inspection(init: Partial<Inspection> & { format: string }): Inspection {
	return {
		lines: [],
		goCandidates: [],
		depSections: [],
		mappings: [],
		searched: true,
		metadataIncluded: false,
		...init,
	};
}

function buildReport(displayPath: string, data: Buffer): string {
	const view = new Bytes(data);
	const kind = classify(data);
	const found =
		kind === "PE"
			? inspectPe(view)
			: kind === "ELF"
				? inspectElf(view)
				: kind === "MachO"
					? inspectMachO(view)
					: kind === "WASM"
						? inspectWasm(view)
						: inspectUnknown(data);
	const lines = [
		`InspectBinary report for ${displayPath}`,
		`size: ${data.length} byte(s)`,
		`format: ${found.format}`,
		...found.lines,
	];
	if (!found.metadataIncluded) {
		lines.push(...goBuildInfoLines(view, found), ...cargoAuditableLines(found));
	}
	return lines.join("\n");
}

type Container = "PE" | "ELF" | "MachO" | "WASM" | "unrecognized";

/**
 * The container, from the first bytes. PE asks for two magics that agree: a
 * DOS header whose `e_lfanew` points at a real `PE\0\0` signature — a stray
 * `MZ` alone is a claim, the pair is the format.
 */
function classify(data: Buffer): Container {
	if (data.length >= 4 && data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) return "ELF";
	if (data.length >= 0x40 && data[0] === 0x4d && data[1] === 0x5a) {
		const lfanew = data.readUInt32LE(0x3c);
		if (matchesAt(data, lfanew, Buffer.from("PE\0\0", "latin1"))) return "PE";
	}
	const magic = magicOf(data);
	if (magic !== null && (MACHO_THIN_MAGICS.has(magic) || MACHO_FAT_MAGICS.has(magic))) return "MachO";
	if (matchesAt(data, 0, Buffer.from("\0asm", "latin1"))) return "WASM";
	return "unrecognized";
}

/** The unrecognized case: the first bytes itself, which is the whole finding. */
function inspectUnknown(data: Buffer): Inspection {
	if (data.length === 0) return inspection({ format: "unrecognized", lines: ["the file is empty"], searched: false });
	const head = data.subarray(0, 16);
	const hexes = [...head].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
	return inspection({
		format: "unrecognized",
		lines: [`first ${count(head.length, "byte", "bytes")}: ${hexes}`],
		searched: false,
	});
}

// ---------------------------------------------------------------------------
// PE
// ---------------------------------------------------------------------------

interface PeSection {
	name: string;
	virtualSize: number;
	virtualAddress: number;
	rawSize: number;
	rawOffset: number;
	characteristics: number;
}

const PE_MACHINES: readonly (readonly [number, string])[] = [
	[0x014c, "x86 (0x14c)"],
	[0x8664, "x86-64 (0x8664)"],
	[0x01c0, "ARM (0x1c0)"],
	[0x01c4, "ARM Thumb (0x1c4)"],
	[0xaa64, "ARM64 (0xaa64)"],
	[0x0200, "IA-64 (0x200)"],
];

const PE_CHARACTERISTICS: readonly (readonly [number, string])[] = [
	[0x0001, "relocations stripped"],
	[0x0002, "executable image"],
	[0x0020, "large address aware"],
	[0x0200, "debug info stripped"],
	[0x1000, "system file"],
	[0x2000, "dll"],
];

const PE_DLL_CHARACTERISTICS: readonly (readonly [number, string])[] = [
	[0x0020, "high entropy va"],
	[0x0040, "dynamic base"],
	[0x0080, "force integrity"],
	[0x0100, "nx compat"],
	[0x0200, "no isolation"],
	[0x0400, "no seh"],
	[0x0800, "no bind"],
	[0x1000, "appcontainer"],
	[0x2000, "wdm driver"],
	[0x4000, "guard cf"],
	[0x8000, "terminal server aware"],
];

const PE_SUBSYSTEMS: readonly (readonly [number, string])[] = [
	[0, "unknown"],
	[1, "native"],
	[2, "windows gui"],
	[3, "windows console"],
	[5, "os/2 console"],
	[7, "posix console"],
	[9, "windows ce gui"],
	[10, "efi application"],
	[11, "efi boot service driver"],
	[12, "efi runtime driver"],
	[13, "efi rom"],
	[14, "xbox"],
	[16, "windows boot application"],
];

const PE_SECTION_FLAGS: readonly (readonly [number, string])[] = [
	[0x00000020, "code"],
	[0x00000040, "initialized data"],
	[0x00000080, "uninitialized data"],
	[0x02000000, "discardable"],
	[0x04000000, "not cached"],
	[0x08000000, "not paged"],
	[0x10000000, "shared"],
	[0x20000000, "execute"],
	[0x40000000, "read"],
	[0x80000000, "write"],
];

/** The section-alignment bits the writable-data test masks away, as the Go reader does. */
const PE_SECTION_ALIGN_MASK = 0x600000;

const PE_RESOURCE_TYPES: readonly (readonly [number, string])[] = [
	[1, "RT_CURSOR"],
	[2, "RT_BITMAP"],
	[3, "RT_ICON"],
	[4, "RT_MENU"],
	[5, "RT_DIALOG"],
	[6, "RT_STRING"],
	[7, "RT_FONTDIR"],
	[8, "RT_FONT"],
	[9, "RT_ACCELERATOR"],
	[10, "RT_RCDATA"],
	[11, "RT_MESSAGETABLE"],
	[12, "RT_GROUP_CURSOR"],
	[14, "RT_GROUP_ICON"],
	[16, "RT_VERSION"],
	[17, "RT_DLGINCLUDE"],
	[19, "RT_PLUGPLAY"],
	[20, "RT_VXD"],
	[21, "RT_ANICURSOR"],
	[22, "RT_ANIICON"],
	[23, "RT_HTML"],
	[24, "RT_MANIFEST"],
];

/** The named entry of a table, or `fallback` when the value is not in it. */
function nameOf(table: readonly (readonly [number, string])[], value: number, fallback: string): string {
	return table.find(([code]) => code === value)?.[1] ?? fallback;
}

/** Every named bit set in `value`, plus any bits no name covers, so nothing hides. */
function flagList(value: number, table: readonly (readonly [number, string])[]): string {
	const names: string[] = [];
	let covered = 0;
	for (const [bit, name] of table) {
		if ((value & bit) !== 0) {
			names.push(name);
			covered |= bit;
		}
	}
	const unknown = (value & ~covered) >>> 0;
	if (unknown !== 0) names.push(`0x${unknown.toString(16)}`);
	return names.length === 0 ? "none" : names.join(", ");
}

function inspectPe(view: Bytes): Inspection {
	const lines: string[] = [];
	const lfanew = view.u32(0x3c) ?? 0;
	const format = `PE (PE signature at ${hex(lfanew)})`;
	const coff = lfanew + 4;
	if (!view.has(coff, 20)) {
		return inspection({ format, lines: ["COFF header: the file ends inside the 20-byte header (truncated)"] });
	}
	const machine = view.u16(coff) ?? 0;
	const declared = view.u16(coff + 2) ?? 0;
	const timeStamp = view.u32(coff + 4) ?? 0;
	const symbolTable = view.u32(coff + 8) ?? 0;
	const symbolCount = view.u32(coff + 12) ?? 0;
	const optionalSize = view.u16(coff + 16) ?? 0;
	const characteristics = view.u16(coff + 18) ?? 0;

	const optional = coff + 20;
	const optionalMagic = view.u16(optional);
	// Subsystem and DllCharacteristics sit at the same optional-header offsets in
	// both PE32 and PE32+: the two layouts diverge only before them (ImageBase
	// widens) and after them (the data directories), so one pair of offsets
	// serves both and no magic test is needed to read them.
	const subsystem = optionalSize >= 70 ? (view.u16(optional + 68) ?? null) : null;
	const dllCharacteristics = optionalSize >= 72 ? (view.u16(optional + 70) ?? null) : null;
	const imageBase =
		optionalSize >= 32 && optionalMagic === 0x10b
			? (view.u32(optional + 28) ?? 0)
			: optionalSize >= 32 && optionalMagic === 0x20b
				? (view.u64Number(optional + 24) ?? 0)
				: 0;

	const sections: PeSection[] = [];
	let cutOffAt: number | null = null;
	const sectionTable = optional + optionalSize;
	const stringTable = coffStringTable(view, symbolTable, symbolCount);
	for (let i = 0; i < declared; i++) {
		const entry = sectionTable + i * 40;
		if (!view.has(entry, 40)) {
			cutOffAt = i;
			break;
		}
		sections.push({
			name: resolvePeName(view, view.cstring(entry, 8) ?? "", stringTable),
			virtualSize: view.u32(entry + 8) ?? 0,
			virtualAddress: view.u32(entry + 12) ?? 0,
			rawSize: view.u32(entry + 16) ?? 0,
			rawOffset: view.u32(entry + 20) ?? 0,
			characteristics: view.u32(entry + 36) ?? 0,
		});
	}

	lines.push(
		`COFF header: machine ${nameOf(PE_MACHINES, machine, hex(machine))}, ` +
			`${count(declared, "section", "sections")}, timestamp ${renderTimestamp(timeStamp)}`,
	);
	lines.push(`  characteristics: ${flagList(characteristics, PE_CHARACTERISTICS)}`);
	if (optionalSize === 0) {
		lines.push("optional header: none (a COFF object file, not a linked image)");
	} else if (optionalMagic === 0x10b || optionalMagic === 0x20b) {
		const kind = optionalMagic === 0x10b ? "PE32" : "PE32+";
		const subsystemText =
			subsystem === null ? "" : `, subsystem ${nameOf(PE_SUBSYSTEMS, subsystem, "unknown")} (${subsystem})`;
		lines.push(`optional header: ${kind} (magic ${hex(optionalMagic)})${subsystemText}`);
		if (dllCharacteristics !== null) {
			lines.push(`  dll characteristics: ${flagList(dllCharacteristics, PE_DLL_CHARACTERISTICS)}`);
		}
	} else {
		lines.push(`optional header: magic ${hex(optionalMagic ?? 0)} is neither PE32 nor PE32+; it was not read further`);
	}

	if (declared === 0) lines.push("sections: none");
	else {
		lines.push(`sections (${declared}):`);
		for (const section of sections) {
			lines.push(
				`  ${section.name || "(unnamed)"}  virtual ${section.virtualSize} bytes, raw ${section.rawSize} bytes  ` +
					`[${flagList(section.characteristics, PE_SECTION_FLAGS)}]`,
			);
		}
		if (cutOffAt !== null) {
			lines.push(`  (the file ends inside the section table: ${declared} declared, ${sections.length} readable)`);
		}
	}

	lines.push(...peResourceLines(view, sections, optionalMagic, optional, optionalSize));

	// Go's buildinfo: a section of its own if a toolchain ever writes one (the
	// task here started from that belief), and otherwise the blob inside the
	// first writable data section — which is where the Go linker actually puts
	// it on Windows, verified against the toolchain's own reader.
	const goCandidates: DataRange[] = [];
	for (const section of sections) {
		if (section.name !== ".go.buildinfo") continue;
		const range = clampRange(view.data, section.rawOffset, section.rawSize);
		if (range !== null) {
			goCandidates.push({ label: "section .go.buildinfo", ...range, address: imageBase + section.virtualAddress });
		}
	}
	const writable = sections.find(
		(section) =>
			section.virtualAddress !== 0 &&
			section.virtualSize !== 0 &&
			(section.characteristics & ~PE_SECTION_ALIGN_MASK) === (0x40 | 0x40000000 | 0x80000000),
	);
	if (writable !== undefined) {
		const range = clampRange(view.data, writable.rawOffset, writable.rawSize);
		if (range !== null && !goCandidates.some((candidate) => candidate.fileOffset === range.fileOffset)) {
			goCandidates.push({
				label: `section ${writable.name || "(unnamed)"} (the first writable data section)`,
				...range,
				address: imageBase + writable.virtualAddress,
			});
		}
	}

	const depSections: DepSection[] = [];
	for (const section of sections) {
		if (section.name !== DEP_SECTION_NAME) continue;
		const range = clampRange(view.data, section.rawOffset, section.rawSize);
		if (range !== null) {
			depSections.push({
				label: `section ${section.name}`,
				bytes: view.data.subarray(range.fileOffset, range.fileOffset + range.size),
			});
		}
	}

	const mappings: Mapping[] = [];
	for (const section of sections) {
		if (section.virtualAddress === 0) continue;
		const range = clampRange(view.data, section.rawOffset, section.rawSize);
		if (range !== null) {
			mappings.push({ address: imageBase + section.virtualAddress, size: range.size, fileOffset: range.fileOffset });
		}
	}

	return inspection({ format, lines, goCandidates, depSections, mappings });
}

/**
 * The COFF string table, where section names longer than 8 bytes live.
 *
 * The section header can hold 8 name bytes, so long names are written there
 * as `/N` — an offset into the string table that follows the symbol table.
 * Without resolving it, every long-named section of a Go binary (`.debug_*`
 * on real PE files, `.go.buildinfo` if it ever moves to a name) would be
 * reported as `/4`.
 */
function coffStringTable(
	view: Bytes,
	symbolTable: number,
	symbolCount: number,
): { offset: number; size: number } | null {
	if (symbolTable === 0) return null;
	const offset = symbolTable + symbolCount * 18;
	const size = view.u32(offset);
	if (size === null || size < 4) return null;
	return { offset, size: Math.min(size, view.data.length - offset) };
}

function resolvePeName(view: Bytes, raw: string, stringTable: { offset: number; size: number } | null): string {
	const match = /^\/(\d+)$/.exec(raw);
	if (match === null || stringTable === null) return raw;
	const within = Number(match[1]);
	if (within < 4 || within >= stringTable.size) return raw;
	return view.cstring(stringTable.offset + within, stringTable.size - within) ?? raw;
}

function renderTimestamp(timeStamp: number): string {
	if (timeStamp === 0) return "0 (not set; reproducible builds usually stamp zero)";
	const date = new Date(timeStamp * 1000);
	return Number.isNaN(date.getTime()) ? String(timeStamp) : `${timeStamp} (${date.toISOString()})`;
}

/** PE resources, shallowly: the top-level type entries and how many children each has. */
function peResourceLines(
	view: Bytes,
	sections: readonly PeSection[],
	optionalMagic: number | null,
	optional: number,
	optionalSize: number,
): string[] {
	const dataDirectory = optionalMagic === 0x10b ? optional + 96 : optional + 112;
	const countOffset = optionalMagic === 0x10b ? optional + 92 : optional + 108;
	if (optionalMagic !== 0x10b && optionalMagic !== 0x20b) return [];
	if (optionalSize < (optionalMagic === 0x10b ? 96 : 112)) {
		return ["pe resources: the optional header is too small to hold a data directory table"];
	}
	const tableCount = view.u32(countOffset) ?? 0;
	if (tableCount < 3) return ["pe resources: the optional header declares no resource data directory entry"];
	const rva = view.u32(dataDirectory + 16) ?? 0;
	if (rva === 0) return ["pe resources: no resource directory (the resource data directory entry is empty)"];
	const section = sections.find(
		(candidate) => rva >= candidate.virtualAddress && rva - candidate.virtualAddress < candidate.rawSize,
	);
	if (section === undefined) {
		return [`pe resources: the resource directory RVA ${hex(rva)} is not inside any section's raw data`];
	}
	// Offsets inside the directory are relative to the directory's own start,
	// which the data directory points at by RVA.
	const base = section.rawOffset + (rva - section.virtualAddress);
	if (!view.has(base, 16)) return [`pe resources: the resource directory at ${hex(rva)} runs past the end of the file`];
	const named = view.u16(base + 12) ?? 0;
	const ids = view.u16(base + 14) ?? 0;
	const total = named + ids;
	const lines = [
		`pe resources: resource directory at RVA ${hex(rva)} (section ${section.name}), ${count(total, "top-level type", "top-level types")}`,
	];
	if (total === 0) lines.push("  (no resource types)");
	for (let i = 0; i < Math.min(total, MAX_RESOURCE_ROWS); i++) {
		const entry = base + 16 + i * 8;
		if (!view.has(entry, 8)) {
			lines.push(`  (the entry table is cut off: ${total} declared, ${i} readable)`);
			break;
		}
		const nameValue = view.u32(entry) ?? 0;
		const offsetValue = view.u32(entry + 4) ?? 0;
		// The high bit of either field says "this is not the thing you think":
		// for the name, a string sits at the offset half; for the offset, the
		// child is another directory rather than a leaf data entry.
		const knownType = PE_RESOURCE_TYPES.find(([code]) => code === nameValue)?.[1];
		const label =
			(nameValue & 0x80000000) !== 0
				? `"${resourceName(view, base + (nameValue & 0x7fffffff))}"`
				: knownType === undefined
					? `id ${nameValue}`
					: `${knownType} (${nameValue})`;
		let children = "a data entry";
		if ((offsetValue & 0x80000000) !== 0) {
			const child = base + (offsetValue & 0x7fffffff);
			const childNamed = view.u16(child + 12);
			const childIds = view.u16(child + 14);
			children =
				childNamed === null || childIds === null
					? "a subdirectory past the end of the file"
					: count(childNamed + childIds, "entry", "entries");
		}
		lines.push(`  type ${label}: ${children}`);
	}
	if (total > MAX_RESOURCE_ROWS) lines.push(`  ... and ${total - MAX_RESOURCE_ROWS} more type(s)`);
	return lines;
}

/** A resource directory's name string: UTF-16 code units, count first. */
function resourceName(view: Bytes, offset: number): string {
	const length = view.u16(offset);
	if (length === null || !view.has(offset + 2, length * 2)) return "<name past the end of the file>";
	let out = "";
	for (let i = 0; i < length; i++) out += String.fromCharCode(view.u16(offset + 2 + i * 2) ?? 0);
	return out;
}

// ---------------------------------------------------------------------------
// ELF
// ---------------------------------------------------------------------------

interface ElfSection {
	name: string | null;
	nameIndex: number;
	type: number;
	flags: number;
	address: number;
	offset: number;
	size: number;
}

const ELF_MACHINES: readonly (readonly [number, string])[] = [
	[0x02, "SPARC (0x2)"],
	[0x03, "x86 (0x3)"],
	[0x08, "MIPS (0x8)"],
	[0x14, "PowerPC (0x14)"],
	[0x15, "PowerPC64 (0x15)"],
	[0x16, "s390 (0x16)"],
	[0x28, "ARM (0x28)"],
	[0x32, "IA-64 (0x32)"],
	[0x3e, "x86-64 (0x3e)"],
	[0xb7, "AArch64 (0xb7)"],
	[0xf3, "RISC-V (0xf3)"],
];

const ELF_TYPES: readonly (readonly [number, string])[] = [
	[0, "ET_NONE"],
	[1, "ET_REL (relocatable)"],
	[2, "ET_EXEC (executable)"],
	[3, "ET_DYN (shared object or PIE)"],
	[4, "ET_CORE (core dump)"],
];

const ELF_SECTION_TYPES: readonly (readonly [number, string])[] = [
	[0, "NULL"],
	[1, "PROGBITS"],
	[2, "SYMTAB"],
	[3, "STRTAB"],
	[4, "RELA"],
	[5, "HASH"],
	[6, "DYNAMIC"],
	[7, "NOTE"],
	[8, "NOBITS"],
	[9, "REL"],
	[10, "SHLIB"],
	[11, "DYNSYM"],
	[14, "INIT_ARRAY"],
	[15, "FINI_ARRAY"],
	[16, "PREINIT_ARRAY"],
	[17, "GROUP"],
	[18, "SYMTAB_SHNDX"],
	[0x6ffffff6, "GNU_HASH"],
	[0x6ffffffd, "VERDEF"],
	[0x6ffffffe, "VERNEED"],
	[0x6fffffff, "VERSYM"],
];

const ELF_SHF_WRITE = 0x1;
const ELF_SHT_NOBITS = 8;
const ELF_SHT_PROGBITS = 1;

function inspectElf(view: Bytes): Inspection {
	const elfClass = view.u8(4);
	const elfData = view.u8(5);
	if (elfClass !== 1 && elfClass !== 2) {
		return inspection({
			format: "ELF",
			lines: [`ELF header: the class byte is ${elfClass ?? "missing"}, neither 32-bit (1) nor 64-bit (2)`],
		});
	}
	if (elfData !== 1 && elfData !== 2) {
		return inspection({
			format: "ELF",
			lines: [`ELF header: the data byte is ${elfData ?? "missing"}, neither little- (1) nor big-endian (2)`],
		});
	}
	const bits = elfClass === 1 ? 32 : 64;
	const order: Order = elfData === 1 ? "le" : "be";
	const elf = new Bytes(view.data, order);
	const format = `ELF (${bits}-bit, ${order === "le" ? "little" : "big"}-endian)`;
	const headerSize = bits === 64 ? 64 : 52;
	if (!elf.has(0, headerSize)) {
		return inspection({ format, lines: [`ELF header: the file is shorter than the ${headerSize}-byte header`] });
	}
	const type = elf.u16(16) ?? 0;
	const machine = elf.u16(18) ?? 0;
	const entry = bits === 64 ? elf.u64(24) : ((value) => (value === null ? null : BigInt(value)))(elf.u32(24));
	const shoff = bits === 64 ? elf.u64Number(40) : elf.u32(32);
	const shentsize = elf.u16(bits === 64 ? 58 : 46) ?? 0;
	const shnum = elf.u16(bits === 64 ? 60 : 48) ?? 0;
	const shstrndx = elf.u16(bits === 64 ? 62 : 50) ?? 0;

	const lines = [
		`ELF header: type ${nameOf(ELF_TYPES, type, hex(type))}, machine ${nameOf(ELF_MACHINES, machine, hex(machine))}, ` +
			`entry ${entry === null ? "(unreadable)" : hex(entry)}`,
	];

	const sections: ElfSection[] = [];
	const entrySize = bits === 64 ? 64 : 40;
	let tableNote: string | null = null;
	if (shnum === 0) {
		tableNote = "none";
	} else if (shoff === null) {
		tableNote = "the section header table offset does not fit in this file";
	} else if (shoff >= view.data.length) {
		tableNote = `the section header table at ${hex(shoff)} is past the end of the file (${view.data.length} bytes)`;
	} else if (shentsize < entrySize) {
		tableNote = `section header entries are ${shentsize} bytes, smaller than the format's ${entrySize}`;
	} else {
		for (let i = 0; i < shnum; i++) {
			const at = shoff + i * shentsize;
			if (!elf.has(at, entrySize)) {
				tableNote = `the section header table is cut off: ${shnum} declared, ${i} readable`;
				break;
			}
			sections.push({
				name: null,
				nameIndex: elf.u32(at) ?? 0,
				type: elf.u32(at + 4) ?? 0,
				flags: bits === 64 ? (elf.u64Number(at + 8) ?? 0) : (elf.u32(at + 8) ?? 0),
				address: bits === 64 ? (elf.u64Number(at + 16) ?? 0) : (elf.u32(at + 12) ?? 0),
				offset: bits === 64 ? (elf.u64Number(at + 24) ?? 0) : (elf.u32(at + 16) ?? 0),
				size: bits === 64 ? (elf.u64Number(at + 32) ?? 0) : (elf.u32(at + 20) ?? 0),
			});
		}
		// Names come from the string table section the header names, and only
		// once the whole table is readable — a half-name (`__go_buil`) would be
		// worse than no name, because lookups compare complete strings.
		const nameTable = shstrndx > 0 && shstrndx < sections.length ? sections[shstrndx] : null;
		if (nameTable !== null && nameTable.type !== ELF_SHT_NOBITS && view.has(nameTable.offset, nameTable.size)) {
			const table = new Bytes(view.data.subarray(nameTable.offset, nameTable.offset + nameTable.size));
			for (const section of sections) {
				section.name = table.cstring(section.nameIndex, table.data.length - section.nameIndex);
			}
		}
	}
	// One line for the table, whether it was read or not: the note replaces the
	// count when the count would be a lie (nothing readable behind it).
	lines.push(`section headers: ${tableNote ?? sections.length}`);
	for (const [index, section] of sections.entries()) {
		// `name === null` is "the string table could not be read"; an empty
		// string is a resolved name that happens to be empty — the section 0
		// every ELF has, whose name index points at the table's leading NUL.
		const name =
			section.name === null ? `(name index ${section.nameIndex}, no string table)` : section.name || "(unnamed)";
		lines.push(
			`  [${index}] ${name}  ${nameOf(ELF_SECTION_TYPES, section.type, hex(section.type))}  size ${section.size} bytes`,
		);
	}

	const goCandidates: DataRange[] = [];
	for (const section of sections) {
		if (section.name !== ".go.buildinfo") continue;
		const range = clampRange(view.data, section.offset, section.size);
		if (range !== null) goCandidates.push({ label: "section .go.buildinfo", ...range, address: section.address });
	}
	// The fallback mirrors the Go reader's: when the blob has no section of its
	// own, it sits in the first writable data it can be found in, which for ELF
	// is the first SHF_WRITE PROGBITS section.
	const writable = sections.find(
		(section) => section.type === ELF_SHT_PROGBITS && (section.flags & ELF_SHF_WRITE) !== 0 && section.size > 0,
	);
	if (writable !== undefined) {
		const range = clampRange(view.data, writable.offset, writable.size);
		if (range !== null && !goCandidates.some((candidate) => candidate.fileOffset === range.fileOffset)) {
			goCandidates.push({
				label: `section ${writable.name || "(unnamed)"} (a writable data section)`,
				...range,
				address: writable.address,
			});
		}
	}

	const depSections: DepSection[] = [];
	for (const section of sections) {
		if (section.name !== DEP_SECTION_NAME) continue;
		const range = clampRange(view.data, section.offset, section.size);
		if (range !== null) {
			depSections.push({
				label: `section ${section.name}`,
				bytes: view.data.subarray(range.fileOffset, range.fileOffset + range.size),
			});
		}
	}

	const mappings: Mapping[] = [];
	for (const section of sections) {
		if (section.type === ELF_SHT_NOBITS || section.address === 0 || section.size === 0) continue;
		const range = clampRange(view.data, section.offset, section.size);
		if (range !== null) mappings.push({ address: section.address, size: range.size, fileOffset: range.fileOffset });
	}

	return inspection({ format, lines, goCandidates, depSections, mappings });
}

// ---------------------------------------------------------------------------
// Mach-O (thin and fat)
// ---------------------------------------------------------------------------

const MACHO_THIN_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe]);
const MACHO_FAT_MAGICS = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

const MACHO_CPUS: readonly (readonly [number, string])[] = [
	[7, "x86 (0x7)"],
	[12, "ARM (0xc)"],
	[18, "PowerPC (0x12)"],
	[0x01000007, "x86-64 (0x1000007)"],
	[0x0100000c, "ARM64 (0x100000c)"],
	[0x0200000c, "ARM64_32 (0x200000c)"],
	[0x01000012, "PowerPC64 (0x1000012)"],
];

const MACHO_FILETYPES: readonly (readonly [number, string])[] = [
	[1, "MH_OBJECT"],
	[2, "MH_EXECUTE"],
	[3, "MH_FVMLIB"],
	[4, "MH_CORE"],
	[5, "MH_PRELOAD"],
	[6, "MH_DYLIB"],
	[7, "MH_DYLINKER"],
	[8, "MH_BUNDLE"],
	[9, "MH_DYLIB_STUB"],
	[10, "MH_DSYM"],
	[11, "MH_KEXT_BUNDLE"],
	[12, "MH_FILESET"],
];

const MACHO_HEADER_FLAGS: readonly (readonly [number, string])[] = [
	[0x0000001, "noundefs"],
	[0x0000004, "dyldlink"],
	[0x0000008, "bindatload"],
	[0x0000080, "twolevel"],
	[0x0020000, "no fix prebinding"],
	[0x0200000, "pie"],
];

const MACHO_COMMANDS: readonly (readonly [number, string])[] = [
	[0x1, "LC_SEGMENT"],
	[0x2, "LC_SYMTAB"],
	[0x3, "LC_SYMSEG"],
	[0x4, "LC_THREAD"],
	[0x5, "LC_UNIXTHREAD"],
	[0xb, "LC_DYSYMTAB"],
	[0xc, "LC_LOAD_DYLIB"],
	[0xd, "LC_ID_DYLIB"],
	[0xe, "LC_LOAD_DYLINKER"],
	[0xf, "LC_ID_DYLINKER"],
	[0x19, "LC_SEGMENT_64"],
	[0x1a, "LC_ROUTINES_64"],
	[0x1b, "LC_UUID"],
	[0x1d, "LC_CODE_SIGNATURE"],
	[0x1e, "LC_SEGMENT_SPLIT_INFO"],
	[0x21, "LC_ENCRYPTION_INFO"],
	[0x22, "LC_DYLD_INFO"],
	[0x24, "LC_VERSION_MIN_MACOSX"],
	[0x25, "LC_VERSION_MIN_IPHONEOS"],
	[0x26, "LC_FUNCTION_STARTS"],
	[0x28, "LC_MAIN"],
	[0x29, "LC_DATA_IN_CODE"],
	[0x2a, "LC_SOURCE_VERSION"],
	[0x2b, "LC_DYLIB_CODE_SIGN_DRS"],
	[0x2c, "LC_ENCRYPTION_INFO_64"],
	[0x2d, "LC_LINKER_OPTION"],
	[0x32, "LC_BUILD_VERSION"],
	[0x80000018, "LC_LOAD_WEAK_DYLIB"],
	[0x80000022, "LC_DYLD_INFO_ONLY"],
	[0x80000028, "LC_MAIN"],
	[0x80000033, "LC_DYLD_EXPORTS_TRIE"],
	[0x80000034, "LC_DYLD_CHAINED_FIXUPS"],
];

const MACHO_SECTION_ZEROFILL = 0x1;
const MACHO_SEGMENT_READ_WRITE = 3;

function inspectMachO(view: Bytes): Inspection {
	const magic = magicOf(view.data) ?? 0;
	return MACHO_FAT_MAGICS.has(magic) ? inspectMachOFat(view, magic) : inspectMachOThin(view, magic);
}

function inspectMachOThin(view: Bytes, magic: number): Inspection {
	const bits = magic === 0xfeedfacf || magic === 0xcffaedfe ? 64 : 32;
	const order: Order = magic === 0xfeedface || magic === 0xfeedfacf ? "be" : "le";
	const macho = new Bytes(view.data, order);
	const format = `Mach-O (thin, ${bits}-bit, ${order === "le" ? "little" : "big"}-endian)`;
	const headerSize = bits === 64 ? 32 : 28;
	if (!macho.has(0, headerSize)) {
		return inspection({ format, lines: ["Mach-O header: the file ends inside the header"] });
	}
	const cpuType = macho.u32(4) ?? 0;
	const fileType = macho.u32(12) ?? 0;
	const commandCount = macho.u32(16) ?? 0;
	const commandBytes = macho.u32(20) ?? 0;
	const flags = macho.u32(24) ?? 0;

	const lines = [
		`Mach-O header: cputype ${nameOf(MACHO_CPUS, cpuType, hex(cpuType))}, ` +
			`filetype ${nameOf(MACHO_FILETYPES, fileType, hex(fileType))}, flags ${flagList(flags, MACHO_HEADER_FLAGS)}`,
		`load commands: ${commandCount} declared (${commandBytes} bytes)`,
	];
	const goCandidates: DataRange[] = [];
	const depSections: DepSection[] = [];
	const mappings: Mapping[] = [];
	let writableSegment: DataRange | null = null;

	let at = headerSize;
	for (let i = 0; i < commandCount; i++) {
		if (lines.length >= MAX_LISTED_LINES) {
			lines.push(`  (the load command listing is stopped at ${MAX_LISTED_LINES} lines)`);
			break;
		}
		if (!macho.has(at, 8)) {
			lines.push(`  (the load commands are cut off: ${commandCount} declared, ${i} readable)`);
			break;
		}
		const command = macho.u32(at) ?? 0;
		const size = macho.u32(at + 4) ?? 0;
		if (size < 8) {
			lines.push(`  (load command ${i} declares size ${size}, smaller than 8: the list was not read further)`);
			break;
		}
		const isSegment = command === 0x1 || command === 0x19;
		if (!isSegment) {
			lines.push(`  ${nameOf(MACHO_COMMANDS, command, hex(command))}, ${size} bytes`);
			at += size;
			continue;
		}
		const wide = command === 0x19;
		// The command's fixed fields are read as a block before anything is
		// said about them: a truncated segment command would otherwise report
		// zeroth values for fields that were simply not in the file.
		const fixedSize = wide ? 72 : 56;
		if (!macho.has(at, fixedSize)) {
			lines.push(`  (the file ends inside the LC_SEGMENT${wide ? "_64" : ""} command at ${hex(at)})`);
			break;
		}
		const segmentName = macho.cstring(at + 8, 16) ?? "";
		const vmaddr = wide ? (macho.u64Number(at + 24) ?? 0) : (macho.u32(at + 24) ?? 0);
		const fileOffset = wide ? (macho.u64Number(at + 40) ?? 0) : (macho.u32(at + 32) ?? 0);
		const fileSize = wide ? (macho.u64Number(at + 48) ?? 0) : (macho.u32(at + 36) ?? 0);
		// The two protection fields follow the size fields in both layouts; the
		// 64-bit layout's wider vmaddr/filesize push them 16 bytes further along
		// (32-bit: maxprot at 40, initprot at 44 — 64-bit: 56 and 60). Reading the
		// 32-bit offsets as if they were the 64-bit ones lands on the fields after
		// them, so the writable-segment test below would compare nsects, not
		// protection, and silently never fire on a real 32-bit image.
		const maxprot = macho.u32(at + (wide ? 56 : 40)) ?? 0;
		const initprot = macho.u32(at + (wide ? 60 : 44)) ?? 0;
		const sectionCount = macho.u32(at + (wide ? 64 : 48)) ?? 0;
		lines.push(
			`  LC_SEGMENT${wide ? "_64" : ""} ${segmentName}: vmaddr ${hex(vmaddr)}, file size ${fileSize} bytes, ` +
				count(sectionCount, "section", "sections"),
		);
		// The Go reader falls back to the first segment that is readable and
		// writable and not __PAGEZERO, so that is the same rule kept here.
		if (
			writableSegment === null &&
			segmentName !== "__PAGEZERO" &&
			vmaddr !== 0 &&
			fileSize !== 0 &&
			initprot === MACHO_SEGMENT_READ_WRITE &&
			maxprot === MACHO_SEGMENT_READ_WRITE
		) {
			const range = clampRange(macho.data, fileOffset, fileSize);
			if (range !== null) {
				writableSegment = {
					label: `segment ${segmentName} (the first writable segment)`,
					...range,
					address: vmaddr,
				};
			}
		}

		const sectionSize = wide ? 80 : 68;
		let sectionAt = at + (wide ? 72 : 56);
		for (let j = 0; j < sectionCount; j++) {
			if (lines.length >= MAX_LISTED_LINES) {
				lines.push(`    (the section listing is stopped at ${MAX_LISTED_LINES} lines)`);
				break;
			}
			if (!macho.has(sectionAt, sectionSize)) {
				lines.push(`    (the segment's sections are cut off: ${sectionCount} declared, ${j} readable)`);
				break;
			}
			const sectionName = macho.cstring(sectionAt, 16) ?? "";
			const sectionAddress = wide ? (macho.u64Number(sectionAt + 32) ?? 0) : (macho.u32(sectionAt + 32) ?? 0);
			const sectionBytes = wide ? (macho.u64Number(sectionAt + 40) ?? 0) : (macho.u32(sectionAt + 36) ?? 0);
			const sectionFileOffset = wide ? (macho.u32(sectionAt + 48) ?? 0) : (macho.u32(sectionAt + 40) ?? 0);
			const sectionFlags = macho.u32(sectionAt + (wide ? 64 : 56)) ?? 0;
			lines.push(`    ${sectionName || "(unnamed)"}: at ${hex(sectionAddress)}, ${sectionBytes} bytes`);
			if (sectionName === "__go_buildinfo") {
				const range = clampRange(macho.data, sectionFileOffset, sectionBytes);
				if (range !== null) {
					goCandidates.push({
						label: `section __go_buildinfo (segment ${segmentName || "(unnamed)"})`,
						...range,
						address: sectionAddress,
					});
				}
			}
			if (sectionName === DEP_SECTION_NAME) {
				const range = clampRange(macho.data, sectionFileOffset, sectionBytes);
				if (range !== null) {
					depSections.push({
						label: `section ${sectionName} (segment ${segmentName || "(unnamed)"})`,
						bytes: macho.data.subarray(range.fileOffset, range.fileOffset + range.size),
					});
				}
			}
			// Zero-fill sections own no file bytes, so an address that lands in
			// one must not be mapped to whatever happens to sit at offset 0.
			if ((sectionFlags & MACHO_SECTION_ZEROFILL) === 0 && sectionBytes > 0) {
				const range = clampRange(macho.data, sectionFileOffset, sectionBytes);
				if (range !== null) {
					mappings.push({ address: sectionAddress, size: range.size, fileOffset: range.fileOffset });
				}
			}
			sectionAt += sectionSize;
		}
		at += size;
	}

	if (goCandidates.length === 0 && writableSegment !== null) goCandidates.push(writableSegment);

	return inspection({ format, lines, goCandidates, depSections, mappings });
}

function inspectMachOFat(view: Bytes, magic: number): Inspection {
	// The fat header's own magic decides the byte order of its table, and the
	// entry width: 64-bit fat headers exist because a slice can be large
	// enough to need the room.
	const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
	const order: Order = magic === 0xcafebabe || magic === 0xcafebabf ? "be" : "le";
	const fat = new Bytes(view.data, order);
	const format = `Mach-O (fat${wide ? ", 64-bit entries" : ""})`;
	const declared = fat.u32(4) ?? 0;
	const lines = [`fat header: ${count(declared, "slice", "slices")}`];
	if (!fat.has(8, 8)) {
		lines.push("(the file ends inside the fat header)");
		return inspection({ format, lines, searched: false, metadataIncluded: true });
	}
	const entrySize = wide ? 32 : 20;
	for (let i = 0; i < declared; i++) {
		if (lines.length >= MAX_LISTED_LINES) {
			lines.push(`  (the slice listing is stopped at ${MAX_LISTED_LINES} lines)`);
			break;
		}
		const entry = 8 + i * entrySize;
		if (!fat.has(entry, entrySize)) {
			lines.push(`  (the slice table is cut off: ${declared} declared, ${i} readable)`);
			break;
		}
		const cpuType = fat.u32(entry) ?? 0;
		const sliceOffset = wide ? fat.u64Number(entry + 8) : fat.u32(entry + 8);
		const sliceSize = wide ? fat.u64Number(entry + 16) : fat.u32(entry + 12);
		if (sliceOffset === null || sliceSize === null) {
			lines.push(`  slice ${i}: its offset or size does not fit in this file`);
			continue;
		}
		lines.push(`  slice ${i}: ${nameOf(MACHO_CPUS, cpuType, hex(cpuType))} at ${hex(sliceOffset)}, ${sliceSize} bytes`);
		const range = clampRange(view.data, sliceOffset, sliceSize);
		if (range === null) {
			lines.push("    (the slice has no bytes in this file)");
			continue;
		}
		const slice = new Bytes(view.data.subarray(range.fileOffset, range.fileOffset + range.size));
		const sliceMagic = magicOf(slice.data) ?? 0;
		if (!MACHO_THIN_MAGICS.has(sliceMagic)) {
			lines.push(
				MACHO_FAT_MAGICS.has(sliceMagic)
					? "    (this slice is itself a fat Mach-O; not descended into)"
					: "    (this slice does not begin with a thin Mach-O magic)",
			);
			continue;
		}
		const inner = inspectMachOThin(slice, sliceMagic);
		lines.push(`    format: ${inner.format}`);
		for (const line of inner.lines) lines.push(`    ${line}`);
		// Each slice is its own Mach-O and its own metadata carrier: the Go
		// linker and cargo-auditable write into whichever slice they compiled
		// into, so the search runs per slice rather than only on slice 0.
		for (const line of [...goBuildInfoLines(slice, inner), ...cargoAuditableLines(inner)]) {
			lines.push(`    ${line}`);
		}
	}
	return inspection({ format, lines, searched: false, metadataIncluded: true });
}

// ---------------------------------------------------------------------------
// WASM
// ---------------------------------------------------------------------------

const WASM_SECTIONS: readonly (readonly [number, string])[] = [
	[0, "custom"],
	[1, "type"],
	[2, "import"],
	[3, "function"],
	[4, "table"],
	[5, "memory"],
	[6, "global"],
	[7, "export"],
	[8, "start"],
	[9, "element"],
	[10, "code"],
	[11, "data"],
	[12, "datacount"],
];

function inspectWasm(view: Bytes): Inspection {
	const version = view.u32(4);
	if (version === null) {
		return inspection({
			format: "WASM",
			lines: ["WASM header: the file ends inside the 8-byte header"],
			searched: false,
		});
	}
	const lines = [`WASM header: version ${version}`];
	const entries: string[] = [];
	let note: string | null = null;
	let at = 8;
	for (;;) {
		if (entries.length >= MAX_LISTED_LINES) {
			note = `the section listing is stopped at ${MAX_LISTED_LINES} lines`;
			break;
		}
		if (at >= view.data.length) break;
		const id = view.u8(at);
		if (id === null) break;
		if (id > 12) {
			note = `section id ${id} at ${hex(at)} is not one of the 13 defined section ids`;
			break;
		}
		const size = readLeb(view.data, at + 1);
		if (size === null) {
			note = `the section size at ${hex(at + 1)} is not a readable LEB128 value`;
			break;
		}
		const payload = size.next;
		if (payload + size.value > view.data.length) {
			note = `section ${id} at ${hex(at)} claims ${size.value} bytes, past the end of the file`;
			break;
		}
		entries.push(`  section ${id} (${nameOf(WASM_SECTIONS, id, "unknown")}) at ${hex(payload)}, ${size.value} bytes`);
		at = payload + size.value;
	}
	lines.push(`sections: ${entries.length}`, ...entries);
	if (note !== null) lines.push(`  (${note})`);
	return inspection({ format: "WASM", lines, searched: false });
}

/** An unsigned LEB128 value — how WASM writes every section size. */
function readLeb(data: Buffer, offset: number): { value: number; next: number } | null {
	let value = 0;
	let shift = 0;
	for (let at = offset; ; at++) {
		if (at >= data.length) return null;
		const byte = data[at];
		value += (byte & 0x7f) * 2 ** shift;
		if (byte < 0x80) return { value, next: at + 1 };
		shift += 7;
		if (shift > 28) return null;
	}
}

// ---------------------------------------------------------------------------
// Go build info
// ---------------------------------------------------------------------------

function goBuildInfoLines(view: Bytes, found: Inspection): string[] {
	if (found.goCandidates.length === 0) {
		return [
			"go build info: no Go build info found" +
				(found.searched ? "" : " (only ELF, PE and Mach-O containers are searched)"),
		];
	}
	for (const range of found.goCandidates) {
		const blob = findBuildInfoBlob(view.data, range);
		if (blob === null) continue;
		// The strings live inside the range the blob was found in, and are read
		// only up to its end: past it sit unrelated bytes (the section table of
		// a file whose strings are garbage would "read" them as a version).
		const limit = Math.min(range.fileOffset + range.size, view.data.length);
		const parsed = parseBuildInfoBlob(view.data, blob, limit, found.mappings);
		if ("reason" in parsed) {
			return [
				`go build info: a buildinfo magic sits at ${hex(blob)} in ${range.label}, but the blob is not readable (${parsed.reason})`,
			];
		}
		return [
			`go build info: buildinfo magic at ${hex(blob)} in ${range.label}`,
			`  go version: ${parsed.version.toString("utf8")}`,
			...moduleInfoLines(parsed.module),
		];
	}
	const labels = found.goCandidates.map((candidate) => candidate.label).join(", ");
	return [`go build info: no Go build info found (looked in ${labels})`];
}

/**
 * The blob's offset within a candidate range, or null.
 *
 * The magic is searched at 16-byte-aligned *addresses*, stepping by the
 * alignment — the alignment the Go linker promises, and the one the Go reader
 * insists on when several copies of the magic are around (the string
 * `\xff Go buildinf:` itself can appear inside data); an unaligned copy is
 * not the blob.
 */
function findBuildInfoBlob(data: Buffer, range: DataRange): number | null {
	const start = range.fileOffset;
	const end = Math.min(start + range.size, data.length);
	if (end - start < BUILDINFO_HEADER_SIZE) return null;
	const skip = (BUILDINFO_ALIGN - (range.address % BUILDINFO_ALIGN)) % BUILDINFO_ALIGN;
	for (let at = start + skip; at + BUILDINFO_HEADER_SIZE <= end; at += BUILDINFO_ALIGN) {
		if (matchesAt(data, at, BUILDINFO_MAGIC)) return at;
	}
	return null;
}

interface BuildInfo {
	version: Buffer;
	module: Buffer;
}

/** An address-to-bytes reader over the container's mappings, for the pointer form's strings. */
type AddressReader = (address: number, length: number) => Buffer | null;

function makeAddressReader(data: Buffer, mappings: readonly Mapping[]): AddressReader {
	return (address, length) => {
		for (const mapping of mappings) {
			if (address < mapping.address || address + length > mapping.address + mapping.size) continue;
			const at = mapping.fileOffset + (address - mapping.address);
			if (at + length <= data.length) return data.subarray(at, at + length);
		}
		return null;
	};
}

/**
 * Both layouts of the buildinfo blob.
 *
 * Since Go 1.18 the two strings follow the 32-byte header inline, each
 * length-prefixed with an unsigned LEB128 count. Before that, the header
 * carries two pointers to Go string *headers* — `{data, length}` pairs, in
 * the target's endianness — which is why the pointer form needs the whole
 * container's address map and cannot be read from the section alone.
 */
function parseBuildInfoBlob(
	data: Buffer,
	blobOffset: number,
	limit: number,
	mappings: readonly Mapping[],
): BuildInfo | { reason: string } {
	const header = new Bytes(data.subarray(blobOffset, blobOffset + BUILDINFO_HEADER_SIZE));
	const flags = header.u8(15) ?? 0;
	const ptrSize = header.u8(14) ?? 0;

	if ((flags & BUILDINFO_FLAG_INLINE) !== 0) {
		const version = readInlineString(data, blobOffset + BUILDINFO_HEADER_SIZE, limit);
		if (version === null) return { reason: "its version string is not a readable varint-prefixed string" };
		if (version.bytes.length === 0) return { reason: "its version string is empty" };
		const module = readInlineString(data, version.next, limit);
		return { version: version.bytes, module: module === null ? Buffer.alloc(0) : module.bytes };
	}

	if (ptrSize !== 4 && ptrSize !== 8) return { reason: `its pointer-size byte is ${ptrSize}, not 4 or 8` };
	const order: Order = (flags & BUILDINFO_FLAG_BIG_ENDIAN) !== 0 ? "be" : "le";
	const pointers = new Bytes(data.subarray(blobOffset + 16, blobOffset + 16 + 2 * ptrSize), order);
	const versionPointer = readPointer(pointers, 0, ptrSize);
	const modulePointer = readPointer(pointers, ptrSize, ptrSize);
	if (versionPointer === null || modulePointer === null)
		return { reason: "its string pointers do not fit in the file" };
	const reader = makeAddressReader(data, mappings);
	const version = readGoString(reader, versionPointer, ptrSize, order);
	if (version === null || version.length === 0) {
		return { reason: `its version string at ${hex(versionPointer)} is not readable` };
	}
	const module = readGoString(reader, modulePointer, ptrSize, order);
	return { version, module: module ?? Buffer.alloc(0) };
}

function readPointer(view: Bytes, offset: number, ptrSize: number): number | null {
	return ptrSize === 4 ? view.u32(offset) : view.u64Number(offset);
}

/** A varint length followed by that many bytes — the inline form's string encoding. */
function readInlineString(data: Buffer, offset: number, limit: number): { bytes: Buffer; next: number } | null {
	const length = readLeb(data, offset);
	if (length === null) return null;
	const at = length.next;
	if (at + length.value > limit) return null;
	return { bytes: data.subarray(at, at + length.value), next: at + length.value };
}

/** The string behind a Go string header — `{data pointer, length}`, itself at `address`. */
function readGoString(reader: AddressReader, address: number, ptrSize: number, order: Order): Buffer | null {
	const header = reader(address, 2 * ptrSize);
	if (header === null) return null;
	const view = new Bytes(header, order);
	const dataAddress = readPointer(view, 0, ptrSize);
	const dataLength = readPointer(view, ptrSize, ptrSize);
	if (dataAddress === null || dataLength === null) return null;
	return reader(dataAddress, dataLength);
}

/** The module text, line by line, with the sentinel framing removed when it is there. */
function moduleInfoLines(module: Buffer): string[] {
	if (module.length === 0) return ["  module info: (none recorded)"];
	// The linker wraps the module text in 16-byte sentinels whose second one
	// starts with a newline — the same test the Go reader makes before it
	// trusts the text as module info at all. Byte positions, not string
	// positions: a multi-byte character in a dep path would shift one but not
	// the other, and the framing is a property of the bytes.
	const framed =
		module.length >= 2 * BUILDINFO_SENTINEL_SIZE + 1 && module[module.length - BUILDINFO_SENTINEL_SIZE - 1] === 0x0a;
	const text = (
		framed ? module.subarray(BUILDINFO_SENTINEL_SIZE, module.length - BUILDINFO_SENTINEL_SIZE) : module
	).toString("utf8");
	const lines = framed ? ["  module info:"] : ["  module info (not framed as module text by the linker; shown as-is):"];
	let depLines = 0;
	let dropping = false;
	for (const line of text.split("\n")) {
		if (line === "") continue;
		if (line.startsWith("dep\t")) {
			depLines++;
			dropping = depLines > MAX_DEP_ROWS;
			if (dropping) continue;
		} else if (dropping && line.startsWith("=>")) {
			// A replacement targets the dep line just before it; showing it
			// without that line reads as a replacement of nothing.
			continue;
		} else {
			dropping = false;
		}
		lines.push(`    ${capTextLine(line)}`);
	}
	if (depLines > MAX_DEP_ROWS) lines.push(`    ... and ${depLines - MAX_DEP_ROWS} more dep line(s)`);
	return lines;
}

/** One text line, cut with the count of what is missing — build lines can be enormous. */
function capTextLine(line: string): string {
	if (line.length <= MAX_TEXT_LINE_CHARS) return line;
	return `${line.slice(0, MAX_TEXT_LINE_CHARS)} … [${line.length - MAX_TEXT_LINE_CHARS} more chars]`;
}

// ---------------------------------------------------------------------------
// cargo-auditable
// ---------------------------------------------------------------------------

/** The section cargo-auditable embeds itself in, on every container it supports. */
const DEP_SECTION_NAME = ".dep-v0";

function cargoAuditableLines(found: Inspection): string[] {
	if (found.depSections.length === 0) {
		return [
			"cargo-auditable: no .dep-v0 section" +
				(found.searched ? "" : " (only ELF, PE and Mach-O containers are searched)"),
		];
	}
	return found.depSections.flatMap((section) => depSectionLines(section));
}

function depSectionLines(section: DepSection): string[] {
	if (section.bytes.length > MAX_DEP_SECTION_BYTES) {
		return [
			`cargo-auditable: ${section.label} is ${section.bytes.length} bytes, past the ` +
				`${MAX_DEP_SECTION_BYTES} this report will inflate`,
		];
	}
	let inflated: Buffer;
	try {
		// The cap is what stands between this report and a decompression bomb:
		// a few hundred compressed bytes can name gigabytes otherwise.
		inflated = inflateSync(section.bytes, { maxOutputLength: MAX_DEP_INFLATED_BYTES });
	} catch (error) {
		return [
			`cargo-auditable: ${section.label} does not inflate as zlib within ${MAX_DEP_INFLATED_BYTES} bytes (${message(error)})`,
		];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(inflated.toString("utf8"));
	} catch (error) {
		return [`cargo-auditable: ${section.label} inflates, but is not JSON (${message(error)})`];
	}
	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { packages?: unknown }).packages)) {
		return [`cargo-auditable: ${section.label} holds JSON without a packages array`];
	}
	const packages = (parsed as { packages: unknown[] }).packages;
	const lines = [`cargo-auditable: ${section.label} holds ${count(packages.length, "package", "packages")}`];
	for (const entry of packages.slice(0, MAX_PACKAGE_ROWS)) lines.push(`  ${renderPackage(entry)}`);
	if (packages.length > MAX_PACKAGE_ROWS) lines.push(`  ... and ${packages.length - MAX_PACKAGE_ROWS} more package(s)`);
	return lines;
}

/** One `name@version (kind)` row; a malformed entry is named as such, not skipped. */
function renderPackage(entry: unknown): string {
	if (typeof entry !== "object" || entry === null) return "(a package entry that is not an object)";
	const pkg = entry as { name?: unknown; version?: unknown; kind?: unknown };
	const name = typeof pkg.name === "string" ? pkg.name : "(unnamed)";
	const version = typeof pkg.version === "string" && pkg.version !== "" ? `@${pkg.version}` : "";
	const kind = typeof pkg.kind === "string" && pkg.kind !== "" ? ` (${pkg.kind})` : "";
	return `${name}${version}${kind}`;
}
