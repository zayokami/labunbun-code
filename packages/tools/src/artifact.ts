/**
 * InspectArtifact — what a zip-family or ASAR archive holds, read from its
 * directory, never by unpacking it.
 *
 * Both formats put their table of contents somewhere a reader can reach
 * without touching the payload: a zip ends with an end-of-central-directory
 * record that points at the central directory, which lists every entry's
 * name, method, sizes, CRC-32 and time, and an ASAR begins with a
 * length-prefixed JSON tree that names every file and where its bytes sit.
 * Reading those two structures answers what an archive contains while writing
 * nothing anywhere, which is the difference between inspecting a package and
 * running its contents — an archive that arrived from somewhere else is only
 * data about itself while nothing inside it has run or landed on disk.
 *
 * The structures themselves live in `archive.ts`, because CompareArtifacts and
 * InspectWebCapture read the same tables. This file only decides what the
 * report says and which parts of the tables it shows.
 *
 * Two properties of the formats drive the shape of the reader rather than
 * taste. The zip side must find its EOCD record by scanning backwards, since
 * up to 64 KiB of comment may follow it, and must honor ZIP64 where the
 * 32-bit fields have stopped being the truth: the all-ones sentinel values in
 * the EOCD record, the locator and record they point at, and the 0x0001 extra
 * field per entry. The ASAR side must treat its header as a claim about layout
 * rather than a guarantee, so the walk is depth-capped, and a node that is
 * neither a file, a directory nor a link is counted and reported instead of
 * trusted.
 *
 * The report is bounded the way every other tool's is — the entry list stops
 * at 200 and the whole report at 20,000 characters, each cut saying so — and
 * it states what was *not* done, because that is the fact the caller relies
 * on: for a zip only the EOCD record and the central directory were read, for
 * an ASAR only the header, and in both cases no entry was decompressed or
 * extracted and no payload byte was read at all.
 */
import { stat } from "node:fs/promises";
import { type AnyTool, buildTool, formatCutMarker } from "@labunbun/agent";
import { z } from "zod";
import {
	type ArchiveFile,
	type AsarNode,
	type AsarVisit,
	hex,
	hex32,
	identify,
	MAX_TREE_DEPTH,
	message,
	PROBE_BYTES_READ,
	printable,
	readAsarHeader,
	readRange,
	readZipDirectory,
	walkAsar,
	type ZipEntry,
} from "./archive.ts";
import { guardPathContainment } from "./containment.ts";
import { describeFsFailure } from "./path-errors.ts";

/** Entries a report lists before it counts the rest. */
const MAX_LISTED_ENTRIES = 200;

/** Whole-report cap; past it the tail is cut with an explicit marker. */
const MAX_REPORT_CHARS = 20_000;

/** Compression methods under their APPNOTE names; anything else keeps its number. */
const COMPRESSION_METHODS = new Map<number, string>([
	[0, "store"],
	[1, "shrink"],
	[6, "implode"],
	[8, "deflate"],
	[9, "deflate64"],
	[12, "bzip2"],
	[14, "lzma"],
	[93, "zstd"],
	[95, "xz"],
	[98, "ppmd"],
	[99, "aes"],
]);

/** Structure of one zip-family or ASAR archive file. */
export function createInspectArtifactTool(cwd: string): AnyTool {
	return buildTool({
		name: "InspectArtifact",
		description:
			"Reports the structure of a zip-family archive (.zip, .jar, .whl, .apk, .epub) or an Electron ASAR: " +
			"for a zip, the entry count, compressed and uncompressed totals, the end-of-central-directory record " +
			"(its comment, and the ZIP64 records at that size) and each entry's name, compression method, sizes, " +
			"CRC-32 and DOS time as the central directory states them; for an ASAR, the JSON header's size, the " +
			"file and directory counts, the top level and the file list. Only the directory or the header is read — " +
			"no entry is decompressed and nothing is extracted to disk. Use it to answer what a package contains " +
			"without unpacking it.",
		inputSchema: z.object({
			path: z.string().describe("Path to the archive file (.zip/.jar/.whl/.apk/.asar, any name)"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			let source: string;
			try {
				source = guardPathContainment(input.path, cwd, "InspectArtifact");
			} catch (error) {
				return failure(message(error));
			}
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await stat(source);
			} catch (error) {
				// A refusal is not a missing file: the caller's next move differs.
				return failure(describeFsFailure(error, input.path, "inspect"));
			}
			if (info.isDirectory()) {
				return failure(`${input.path} is a directory, not an archive file.`);
			}
			if (!info.isFile()) {
				return failure(`${input.path} is not a regular file.`);
			}

			const file = Bun.file(source);
			try {
				const head = await readRange(file, 0, Math.min(PROBE_BYTES_READ, info.size));
				const kind = identify(head, info.size);
				if (kind === "zip") return ok(capReport(await inspectZip(file, info.size, input.path)));
				if (kind === "asar") return ok(capReport(await inspectAsar(file, info.size, input.path)));
				throw new Error(
					`unrecognized container — first ${head.length} byte(s): ${head.length === 0 ? "(empty file)" : hex(head)}. ` +
						"A zip starts with PK\\x03\\x04, or is an empty archive starting with its EOCD record (PK\\x05\\x06); " +
						"an ASAR starts with an 8-byte size-prefixed JSON header whose JSON opens with `{`.",
				);
			} catch (error) {
				return failure(`InspectArtifact: ${input.path}: ${message(error)}`);
			}
		},
	});
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

/** The zip report: the EOCD record's own fields, then the central directory's entries. */
async function inspectZip(file: ArchiveFile, size: number, displayPath: string): Promise<string> {
	const parsed = await readZipDirectory(file, size, MAX_LISTED_ENTRIES);
	const lines = [
		`InspectArtifact report for ${displayPath}`,
		"container: zip",
		`file bytes: ${size}`,
		`entries: ${parsed.declaredCount}`,
		`compressed total: ${parsed.compressed} bytes`,
		`uncompressed total: ${parsed.uncompressed} bytes`,
		parsed.zip64At === null
			? "ZIP64: no (no ZIP64 end-of-central-directory record)"
			: `ZIP64: yes (end-of-central-directory record at offset ${parsed.zip64At})`,
		`EOCD comment: ${parsed.eocdComment === 0 ? "none" : `present (${parsed.eocdComment} bytes)`}`,
		`central directory: ${parsed.directorySize} bytes at offset ${parsed.directoryOffset}`,
		"read scope: the end-of-central-directory record and the central directory; no entry data was read, decompressed, or written",
	];
	for (const note of parsed.notes) lines.push(`note: ${note}`);
	lines.push("entry list:");
	if (parsed.count === 0) lines.push("  (no entries)");
	for (const [index, entry] of parsed.entries.entries()) lines.push(`  ${index + 1}. ${zipEntryLine(entry)}`);
	if (parsed.declaredCount > parsed.entries.length) {
		const rest = parsed.declaredCount - parsed.entries.length;
		lines.push(
			`  ... ${rest} more entr${rest === 1 ? "y" : "ies"} not listed (the list stops at ${MAX_LISTED_ENTRIES})`,
		);
	}
	return lines.join("\n");
}

/** One entry as one line: name, method, the two sizes, CRC and time. */
function zipEntryLine(entry: ZipEntry): string {
	const method = COMPRESSION_METHODS.get(entry.method) ?? `method ${entry.method}`;
	const zip64 = entry.zip64 ? " [zip64 extra]" : "";
	const mtime = entry.date === 0 && entry.time === 0 ? "no mtime" : `mtime ${dosTime(entry.date, entry.time)}`;
	return `${printable(entry.name)} (${method}) ${entry.compressed} -> ${entry.uncompressed} bytes${zip64}, crc32 0x${hex32(entry.crc)}, ${mtime}`;
}

/**
 * A DOS date/time pair as `YYYY-MM-DDTHH:MM:SS`.
 *
 * No zone is appended and no Date is built: the two words are local-time
 * components with no zone in the format, so rendering them through a UTC
 * instant would invent one — and would move the printed time on any machine
 * whose zone is not zero.
 */
function dosTime(date: number, time: number): string {
	const year = 1980 + ((date >> 9) & 0x7f);
	const month = (date >> 5) & 0x0f;
	const day = date & 0x1f;
	const hour = (time >> 11) & 0x1f;
	const minute = (time >> 5) & 0x3f;
	const second = (time & 0x1f) * 2;
	const pad = (value: number, width: number) => value.toString().padStart(width, "0");
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
}

// ---------------------------------------------------------------------------
// ASAR
// ---------------------------------------------------------------------------

/** The ASAR report: the header's own size, the tree's shape, then the entries. */
async function inspectAsar(file: ArchiveFile, size: number, displayPath: string): Promise<string> {
	const header = await readAsarHeader(file, size);
	const listed: AsarNode[] = [];
	const topLevel: string[] = [];
	let topLevelCount = 0;
	const walk = walkAsar(header.files, (node: AsarVisit) => {
		if (node.kind === "directory") {
			if (node.depth === 1) {
				topLevelCount += 1;
				if (topLevel.length < MAX_LISTED_ENTRIES) {
					const plural = node.childCount === 1 ? "y" : "ies";
					topLevel.push(`  ${printable(node.path)}/ (directory, ${node.childCount} entr${plural})`);
				}
			}
			return;
		}
		const entry: AsarNode =
			node.kind === "link"
				? { path: node.path, size: null, offset: null, unpacked: false, link: node.link }
				: { path: node.path, size: node.size, offset: node.offset, unpacked: node.unpacked, link: null };
		if (listed.length < MAX_LISTED_ENTRIES) listed.push(entry);
		if (node.depth !== 1) return;
		topLevelCount += 1;
		if (topLevel.length >= MAX_LISTED_ENTRIES) return;
		if (node.kind === "link") {
			topLevel.push(`  ${printable(node.path)} -> ${printable(node.link)} (link)`);
			return;
		}
		const stated = node.size === null ? "size not stated" : `${node.size} bytes`;
		topLevel.push(`  ${printable(node.path)} (${stated}${node.unpacked ? ", unpacked" : ""})`);
	});

	const lines = [
		`InspectArtifact report for ${displayPath}`,
		"container: asar (Electron archive)",
		`file bytes: ${size}`,
		`JSON header: ${header.headerLength} bytes (file data begins at byte ${header.headerEnd})`,
		`files: ${walk.fileCount}, directories: ${walk.directoryCount}`,
		`unpacked files: ${walk.unpackedCount}`,
		"read scope: the JSON header; no file data was read, decompressed, or written",
	];
	if (walk.malformed > 0) {
		lines.push(
			`note: ${walk.malformed} node(s) in the header tree are neither a file, a directory, nor a link; not listed`,
		);
	}
	if (walk.depthCapped) {
		lines.push(
			`note: the directory tree goes deeper than ${MAX_TREE_DEPTH} levels; the deeper entries were not walked`,
		);
	}
	lines.push("top level:");
	if (topLevel.length === 0) lines.push("  (nothing at the top level)");
	else lines.push(...topLevel);
	if (topLevelCount > topLevel.length) {
		const rest = topLevelCount - topLevel.length;
		lines.push(
			`  ... ${rest} more top-level entr${rest === 1 ? "y" : "ies"} not listed (the list stops at ${MAX_LISTED_ENTRIES})`,
		);
	}
	lines.push("entry list:");
	if (walk.fileCount === 0) lines.push("  (no files)");
	for (const [index, node] of listed.entries()) lines.push(`  ${index + 1}. ${asarEntryLine(node)}`);
	if (walk.fileCount > listed.length) {
		const rest = walk.fileCount - listed.length;
		lines.push(
			`  ... ${rest} more entr${rest === 1 ? "y" : "ies"} not listed (the list stops at ${MAX_LISTED_ENTRIES})`,
		);
	}
	return lines.join("\n");
}

/** One ASAR entry as one line. */
function asarEntryLine(node: AsarNode): string {
	const name = printable(node.path);
	if (node.link !== null) return `${name} -> ${printable(node.link)} (link)`;
	const size = node.size === null ? "size not stated" : `${node.size} bytes`;
	if (node.unpacked) return `${name} ${size}, unpacked (its bytes sit in the .unpacked directory beside the archive)`;
	if (node.offset !== null) return `${name} ${size} at offset ${node.offset}`;
	return `${name} ${size}`;
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/** The report up to `MAX_REPORT_CHARS`, with the usual marker naming what was cut. */
function capReport(report: string): string {
	if (report.length <= MAX_REPORT_CHARS) return report;
	return `${report.slice(0, MAX_REPORT_CHARS)}\n${formatCutMarker(report.length - MAX_REPORT_CHARS)}`;
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function failure(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true as const };
}
