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
import { guardPathContainment } from "./containment.ts";

/** Entries a report lists before it counts the rest. */
const MAX_LISTED_ENTRIES = 200;

/** How much of one name or path a listing shows before it is cut. */
const MAX_CELL_CHARS = 80;

/** Whole-report cap; past it the tail is cut with an explicit marker. */
const MAX_REPORT_CHARS = 20_000;

/** How many leading bytes the container probe reads. */
const PROBE_BYTES = 16;

/** An EOCD record is 22 bytes; its comment may add 64 KiB after it. */
const EOCD_BYTES = 22;
const MAX_EOCD_COMMENT = 0xffff;

/** The ZIP64 EOCD record is 56 bytes, 44 of them past its size field. */
const ZIP64_RECORD_BYTES = 56;
const ZIP64_RECORD_MIN_FIELDS = 44;

/** An ASAR header past this size is refused rather than read. */
const MAX_ASAR_HEADER_BYTES = 32 * 1024 * 1024;

/** How much of a zip central directory is read; past it the report says so. */
const MAX_CENTRAL_DIR_BYTES = 16 * 1024 * 1024;

/** Depth the ASAR directory walk descends before it stops and says so. */
const MAX_TREE_DEPTH = 64;

// The signatures the reader tests at each position; the trailing comment
// spells out the four bytes a hex dump would otherwise have to be matched
// against by eye.
const SIG_LOCAL_HEADER = 0x04034b50; // PK\x03\x04
const SIG_CENTRAL_ENTRY = 0x02014b50; // PK\x01\x02
const SIG_CENTRAL_SIGNATURE = 0x05054b50; // the directory's optional trailing signature record
const SIG_EOCD = 0x06054b50; // PK\x05\x06
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

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

/** A file open for ranged reads; its size is known from the stat that got us here. */
type ArchiveFile = ReturnType<typeof Bun.file>;

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
			} catch {
				return failure(`Path not found: ${input.path}`);
			}
			if (info.isDirectory()) {
				return failure(`${input.path} is a directory, not an archive file.`);
			}
			if (!info.isFile()) {
				return failure(`${input.path} is not a regular file.`);
			}

			const file = Bun.file(source);
			try {
				const head = await readRange(file, 0, Math.min(PROBE_BYTES, info.size));
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

/**
 * What the leading bytes say the file is, or null when they say nothing.
 *
 * The order matters and is the reverse of the usual guess: an ASAR carries no
 * `PK` anywhere near its start — its first bytes are the pickle's own size
 * fields — so the two zip signatures are tested first, and the ASAR shape is
 * tested as a shape (the payload size of 4, a header length that fits the
 * file, and the `{` the length points at) rather than as a magic string,
 * because there is no magic string to test.
 */
function identify(head: Uint8Array, size: number): "zip" | "asar" | null {
	if (size >= 4) {
		const signature = u32(head, 0);
		// The directory-first signature joins the two the format is usually
		// recognized by: it opens the same archive read through the same EOCD
		// scan, and refusing it as unrecognized would be refusing a zip.
		if (signature === SIG_LOCAL_HEADER || signature === SIG_EOCD || signature === SIG_CENTRAL_ENTRY) return "zip";
	}
	if (head.length >= 9 && u32(head, 0) === 4) {
		const headerSize = u32(head, 4);
		if (headerSize > 0 && headerSize <= MAX_ASAR_HEADER_BYTES && 8 + headerSize <= size && head[8] === 0x7b) {
			return "asar";
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

/** One central-directory entry, after the ZIP64 extra field has had its say. */
interface ZipEntry {
	name: string;
	method: number;
	compressed: number;
	uncompressed: number;
	crc: number;
	/** The DOS date/time words as stored; converted for display, not decoded here. */
	date: number;
	time: number;
	/** Whether a ZIP64 extra field supplied a value the 32-bit slot could not hold. */
	zip64: boolean;
}

/** What the central directory yielded: every entry parsed, the first few kept. */
interface CentralDirectory {
	listed: ZipEntry[];
	count: number;
	compressed: number;
	uncompressed: number;
	/** Whether a trailing digital-signature record ended the directory. */
	signed: boolean;
}

/** Where the EOCD record was found, and what its comment field said. */
interface EocdLocation {
	at: number;
	comment: number;
	note: string | null;
}

/** The zip report: the EOCD record's own fields, then the central directory's entries. */
async function inspectZip(file: ArchiveFile, size: number, displayPath: string): Promise<string> {
	if (size < EOCD_BYTES) {
		throw new Error(`too small to be a zip: ${size} byte(s), where the shortest zip (an empty one) is ${EOCD_BYTES}`);
	}
	// Only the tail can hold the record, and the comment bounds how far back it
	// can start — 22 bytes of record plus up to 64 KiB of comment.
	const windowStart = Math.max(0, size - (MAX_EOCD_COMMENT + EOCD_BYTES));
	const tail = await readRange(file, windowStart, size);
	const eocd = findEocd(tail, windowStart, size);
	const notes: string[] = [];
	if (eocd.note !== null) notes.push(eocd.note);

	const field = eocd.at - windowStart;
	const diskNumber = u16(tail, field + 4);
	const directoryDisk = u16(tail, field + 6);
	const entriesOnDisk = u16(tail, field + 8);
	let entryCount = u16(tail, field + 10);
	let directorySize = u32(tail, field + 12);
	let directoryOffset = u32(tail, field + 16);
	if (entriesOnDisk !== entryCount) {
		notes.push(
			`the EOCD record's two entry counts disagree (${entriesOnDisk} on this disk, ${entryCount} total); the total was used`,
		);
	}
	let spanned = diskNumber !== 0 || directoryDisk !== 0;

	let zip64At: number | null = null;
	if (eocd.at >= 20) {
		const locator = await readRange(file, eocd.at - 20, eocd.at);
		if (u32(locator, 0) === SIG_ZIP64_LOCATOR) {
			const recordAt = u64(locator, 8);
			if (u32(locator, 16) > 1) spanned = true;
			if (recordAt + ZIP64_RECORD_BYTES > size) {
				throw new Error(`the ZIP64 locator points at offset ${recordAt}, past the end of the ${size}-byte file`);
			}
			const record = await readRange(file, recordAt, recordAt + ZIP64_RECORD_BYTES);
			if (u32(record, 0) !== SIG_ZIP64_EOCD) {
				throw new Error(`the ZIP64 locator points at offset ${recordAt}, where no ZIP64 EOCD record sits`);
			}
			const declared = u64(record, 4);
			if (declared < ZIP64_RECORD_MIN_FIELDS) {
				throw new Error(
					`the ZIP64 EOCD record declares ${declared} byte(s) of fields, fewer than the ${ZIP64_RECORD_MIN_FIELDS} a record carries`,
				);
			}
			entryCount = u64(record, 32);
			directorySize = u64(record, 40);
			directoryOffset = u64(record, 48);
			zip64At = recordAt;
			if (u32(record, 16) !== 0 || u32(record, 20) !== 0) spanned = true;
		}
	}
	if (zip64At === null) {
		if (directoryOffset === ZIP64_SENTINEL_32 || directorySize === ZIP64_SENTINEL_32) {
			throw new Error(
				"the EOCD record's central-directory fields hold the ZIP64 sentinel value, but no ZIP64 EOCD locator follows the record",
			);
		}
		if (entryCount === ZIP64_SENTINEL_16) {
			notes.push(
				"the entry count is 0xFFFF — the ZIP64 sentinel — with no ZIP64 record to read a real count from; read as a literal 65535",
			);
		}
	}
	if (spanned) {
		notes.push(
			"the archive declares itself part of a spanned (multi-disk) set; the offsets were read as single-file offsets",
		);
	}
	if (directoryOffset + directorySize > size) {
		throw new Error(
			`the central directory (offset ${directoryOffset}, size ${directorySize}) runs past the end of the ${size}-byte file — the archive is truncated or the EOCD record is wrong`,
		);
	}
	const directoryTruncated = directorySize > MAX_CENTRAL_DIR_BYTES;
	const directory = await readRange(
		file,
		directoryOffset,
		directoryOffset + (directoryTruncated ? MAX_CENTRAL_DIR_BYTES : directorySize),
	);
	const parsed = parseCentralDirectory(directory, directoryOffset, directoryTruncated);
	if (parsed.signed) notes.push("the central directory ends with a digital-signature record");
	if (directoryTruncated) {
		notes.push(
			`the central directory is ${directorySize} bytes, past the ${MAX_CENTRAL_DIR_BYTES}-byte window this reads; the entries and totals above cover only the ${parsed.count} parsed here`,
		);
	} else if (parsed.count < entryCount) {
		const plural = parsed.count === 1 ? "y" : "ies";
		throw new Error(
			`the central directory holds ${parsed.count} entr${plural} where the EOCD record declares ${entryCount} — the directory is truncated or corrupt`,
		);
	} else if (parsed.count > entryCount) {
		notes.push(`the central directory holds ${parsed.count} entries where the EOCD record declares ${entryCount}`);
	}

	const lines = [
		`InspectArtifact report for ${displayPath}`,
		"container: zip",
		`file bytes: ${size}`,
		`entries: ${entryCount}`,
		`compressed total: ${parsed.compressed} bytes`,
		`uncompressed total: ${parsed.uncompressed} bytes`,
		zip64At === null
			? "ZIP64: no (no ZIP64 end-of-central-directory record)"
			: `ZIP64: yes (end-of-central-directory record at offset ${zip64At})`,
		`EOCD comment: ${eocd.comment === 0 ? "none" : `present (${eocd.comment} bytes)`}`,
		`central directory: ${directorySize} bytes at offset ${directoryOffset}`,
		"read scope: the end-of-central-directory record and the central directory; no entry data was read, decompressed, or written",
	];
	for (const note of notes) lines.push(`note: ${note}`);
	lines.push("entry list:");
	if (parsed.count === 0) lines.push("  (no entries)");
	for (const [index, entry] of parsed.listed.entries()) lines.push(`  ${index + 1}. ${zipEntryLine(entry)}`);
	if (entryCount > parsed.listed.length) {
		const rest = entryCount - parsed.listed.length;
		lines.push(
			`  ... ${rest} more entr${rest === 1 ? "y" : "ies"} not listed (the list stops at ${MAX_LISTED_ENTRIES})`,
		);
	}
	return lines.join("\n");
}

/**
 * The EOCD record, found the way the format requires: from the end, since a
 * comment may sit after it.
 *
 * The identity that separates the record from a signature-looking byte run —
 * inside a comment, say — is that its own comment-length field must account
 * for every byte after it, since the record is the last structure in the
 * file. Only when no candidate satisfies that is the last candidate read
 * anyway, with a note, because a file whose comment length no longer matches
 * is broken in a way a reader can still describe.
 */
function findEocd(tail: Uint8Array, windowStart: number, size: number): EocdLocation {
	let fallback: EocdLocation | null = null;
	for (let at = tail.length - EOCD_BYTES; at >= 0; at--) {
		if (u32(tail, at) !== SIG_EOCD) continue;
		const absolute = windowStart + at;
		const comment = u16(tail, at + 20);
		if (absolute + EOCD_BYTES + comment === size) return { at: absolute, comment, note: null };
		fallback ??= {
			at: absolute,
			comment,
			note: "the EOCD record's comment length does not reach the end of the file; the record was read anyway",
		};
	}
	if (fallback !== null) return fallback;
	throw new Error(
		`no end-of-central-directory record in the last ${tail.length} byte(s) of the ${size}-byte file — the archive is truncated or not a zip`,
	);
}

/**
 * Every entry of the central directory, with totals over all of them and the
 * first `MAX_LISTED_ENTRIES` kept for the list.
 *
 * `windowTruncated` is the caller saying the read window ended before the
 * directory did: the entry it cuts through is then left off the totals as
 * well, so the sums and the count describe the same set of bytes.
 */
function parseCentralDirectory(
	directory: Uint8Array,
	directoryOffset: number,
	windowTruncated: boolean,
): CentralDirectory {
	const listed: ZipEntry[] = [];
	let count = 0;
	let compressed = 0;
	let uncompressed = 0;
	let at = 0;
	while (at + 46 <= directory.length) {
		const signature = u32(directory, at);
		if (signature === SIG_CENTRAL_SIGNATURE) return { listed, count, compressed, uncompressed, signed: true };
		if (signature !== SIG_CENTRAL_ENTRY) {
			throw new Error(
				`central directory entry ${count + 1} at offset ${directoryOffset + at} does not start with the entry signature (found 0x${hex32(signature)}); the directory is corrupt`,
			);
		}
		const nameLength = u16(directory, at + 28);
		const extraLength = u16(directory, at + 30);
		const commentLength = u16(directory, at + 32);
		const end = at + 46 + nameLength + extraLength + commentLength;
		if (end > directory.length) {
			if (windowTruncated) break;
			throw new Error(`central directory entry ${count + 1} runs past the end of the directory`);
		}
		const name = decodeName(directory.subarray(at + 46, at + 46 + nameLength));
		const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
		let entryCompressed = u32(directory, at + 20);
		let entryUncompressed = u32(directory, at + 24);
		let zip64 = false;
		for (const extraField of extraFields(extra)) {
			if (extraField.id !== ZIP64_EXTRA_ID) continue;
			const data = extraField.data;
			let cursor = 0;
			// The ZIP64 extra field carries a slot only for the values whose
			// 32-bit homes are the all-ones sentinel, in the order original size,
			// compressed size, offset, disk — so a slot's presence is read from
			// the record, not assumed.
			if (entryUncompressed === ZIP64_SENTINEL_32) {
				if (cursor + 8 > data.length) {
					throw new Error(
						`entry "${printable(name)}": the uncompressed size is the ZIP64 sentinel but the extra field does not carry it`,
					);
				}
				entryUncompressed = u64(data, cursor);
				cursor += 8;
				zip64 = true;
			}
			if (entryCompressed === ZIP64_SENTINEL_32) {
				if (cursor + 8 > data.length) {
					throw new Error(
						`entry "${printable(name)}": the compressed size is the ZIP64 sentinel but the extra field does not carry it`,
					);
				}
				entryCompressed = u64(data, cursor);
				zip64 = true;
			}
		}
		if (!zip64 && (entryUncompressed === ZIP64_SENTINEL_32 || entryCompressed === ZIP64_SENTINEL_32)) {
			throw new Error(
				`entry "${printable(name)}": a size is the ZIP64 sentinel value and no ZIP64 extra field is present`,
			);
		}
		compressed += entryCompressed;
		uncompressed += entryUncompressed;
		if (listed.length < MAX_LISTED_ENTRIES) {
			listed.push({
				name,
				method: u16(directory, at + 10),
				compressed: entryCompressed,
				uncompressed: entryUncompressed,
				crc: u32(directory, at + 16),
				date: u16(directory, at + 14),
				time: u16(directory, at + 12),
				zip64,
			});
		}
		count += 1;
		at = end;
	}
	return { listed, count, compressed, uncompressed, signed: false };
}

/** The `(id, data)` pairs of an extra block, stopping at the first field that would run past its end. */
function* extraFields(extra: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
	let at = 0;
	while (at + 4 <= extra.length) {
		const id = u16(extra, at);
		const length = u16(extra, at + 2);
		if (at + 4 + length > extra.length) return;
		yield { id, data: extra.subarray(at + 4, at + 4 + length) };
		at += 4 + length;
	}
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

/** A zip name's bytes as text; the flag that would distinguish a legacy codepage is not read. */
function decodeName(bytes: Uint8Array): string {
	return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------------
// ASAR
// ---------------------------------------------------------------------------

/** One node of the ASAR header tree, as the listing shows it. */
interface AsarNode {
	path: string;
	/** Bytes the header states, or null when it states none. */
	size: number | null;
	/** Where the bytes live inside the archive, or null when the header does not say. */
	offset: number | null;
	unpacked: boolean;
	/** The target of a symlink entry; a node is a link or a file, never both. */
	link: string | null;
}

/** What the header's directory tree yielded. */
interface AsarWalk {
	listed: AsarNode[];
	topLevel: string[];
	topLevelCount: number;
	fileCount: number;
	directoryCount: number;
	unpackedCount: number;
	malformed: number;
	depthCapped: boolean;
}

/** The ASAR report: the header's own size, the tree's shape, then the entries. */
async function inspectAsar(file: ArchiveFile, size: number, displayPath: string): Promise<string> {
	const headerLength = u32(await readRange(file, 4, 8), 0);
	if (headerLength > MAX_ASAR_HEADER_BYTES) {
		throw new Error(`the JSON header is ${headerLength} bytes, past the ${MAX_ASAR_HEADER_BYTES}-byte read cap`);
	}
	if (8 + headerLength > size) {
		throw new Error(`the JSON header claims ${headerLength} bytes where only ${size - 8} follow the 8-byte header`);
	}
	const raw = await readRange(file, 8, 8 + headerLength);
	// The header string is padded to a 4-byte boundary, and the padding is NUL
	// bytes, which JSON.parse refuses; trailing whitespace is tolerated by the
	// parser itself, so only the NULs are stripped here.
	const text = new TextDecoder("utf-8").decode(raw).replace(/[\0\s]+$/g, "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`the JSON header did not parse (${message(error)})`);
	}
	if (!isRecord(parsed)) {
		throw new Error("the JSON header is not an object");
	}
	const files = parsed.files;
	if (!isRecord(files)) {
		throw new Error('the JSON header has no "files" map');
	}
	const walk = walkAsar(files);

	const lines = [
		`InspectArtifact report for ${displayPath}`,
		"container: asar (Electron archive)",
		`file bytes: ${size}`,
		`JSON header: ${headerLength} bytes (file data begins at byte ${8 + headerLength})`,
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
	if (walk.topLevel.length === 0) lines.push("  (nothing at the top level)");
	else lines.push(...walk.topLevel);
	if (walk.topLevelCount > walk.topLevel.length) {
		const rest = walk.topLevelCount - walk.topLevel.length;
		lines.push(
			`  ... ${rest} more top-level entr${rest === 1 ? "y" : "ies"} not listed (the list stops at ${MAX_LISTED_ENTRIES})`,
		);
	}
	lines.push("entry list:");
	if (walk.fileCount === 0) lines.push("  (no files)");
	for (const [index, node] of walk.listed.entries()) lines.push(`  ${index + 1}. ${asarEntryLine(node)}`);
	if (walk.fileCount > walk.listed.length) {
		const rest = walk.fileCount - walk.listed.length;
		lines.push(
			`  ... ${rest} more entr${rest === 1 ? "y" : "ies"} not listed (the list stops at ${MAX_LISTED_ENTRIES})`,
		);
	}
	return lines.join("\n");
}

/** The header's `files` map walked depth-first, with the top level rendered as it goes. */
function walkAsar(files: Record<string, unknown>): AsarWalk {
	const walk: AsarWalk = {
		listed: [],
		topLevel: [],
		topLevelCount: 0,
		fileCount: 0,
		directoryCount: 0,
		unpackedCount: 0,
		malformed: 0,
		depthCapped: false,
	};
	walkAsarDirectory(files, "", 1, walk);
	return walk;
}

function walkAsarDirectory(files: Record<string, unknown>, prefix: string, depth: number, walk: AsarWalk): void {
	if (depth > MAX_TREE_DEPTH) {
		walk.depthCapped = true;
		return;
	}
	for (const [name, value] of Object.entries(files)) {
		const path = prefix === "" ? name : `${prefix}/${name}`;
		if (!isRecord(value)) {
			walk.malformed += 1;
			continue;
		}
		const children = value.files;
		if (isRecord(children)) {
			walk.directoryCount += 1;
			const count = Object.keys(children).length;
			if (depth === 1) {
				pushTopLevel(walk, `  ${printable(path)}/ (directory, ${count} entr${count === 1 ? "y" : "ies"})`);
			}
			walkAsarDirectory(children, path, depth + 1, walk);
			continue;
		}
		const link = typeof value.link === "string" ? value.link : null;
		if (link !== null) {
			walk.fileCount += 1;
			if (walk.listed.length < MAX_LISTED_ENTRIES)
				walk.listed.push({ path, size: null, offset: null, unpacked: false, link });
			if (depth === 1) pushTopLevel(walk, `  ${printable(path)} -> ${printable(link)} (link)`);
			continue;
		}
		const size = numberField(value.size);
		const unpacked = value.unpacked === true;
		// A node with neither a size nor the unpacked flag is not a file the
		// report can describe; it is counted as malformed rather than guessed at.
		if (size === null && !unpacked) {
			walk.malformed += 1;
			continue;
		}
		walk.fileCount += 1;
		if (unpacked) walk.unpackedCount += 1;
		if (walk.listed.length < MAX_LISTED_ENTRIES) {
			walk.listed.push({ path, size, offset: numberField(value.offset), unpacked, link: null });
		}
		if (depth === 1) {
			const stated = size === null ? "size not stated" : `${size} bytes`;
			pushTopLevel(walk, `  ${printable(path)} (${stated}${unpacked ? ", unpacked" : ""})`);
		}
	}
}

/** One top-level line, counted whether or not the listing still has room for it. */
function pushTopLevel(walk: AsarWalk, line: string): void {
	walk.topLevelCount += 1;
	if (walk.topLevel.length < MAX_LISTED_ENTRIES) walk.topLevel.push(line);
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

/** The bytes of `[start, end)` — one range read, never the whole file. */
async function readRange(file: ArchiveFile, start: number, end: number): Promise<Uint8Array> {
	return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function u16(bytes: Uint8Array, at: number): number {
	return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
	return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** A 64-bit little-endian integer as a number; the formats' sizes stay far from 2^53. */
function u64(bytes: Uint8Array, at: number): number {
	return u32(bytes, at) + u32(bytes, at + 4) * 0x1_0000_0000;
}

/**
 * A name or path as one safe line: control characters escaped, long values
 * cut. A name is bytes inside somebody else's file, and a newline in one must
 * not be allowed to break the line it is printed on — or to spell a line of
 * the report that the report did not write.
 */
function printable(text: string): string {
	const parts: string[] = [];
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		parts.push(code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : character);
	}
	const escaped = parts.join("");
	return escaped.length > MAX_CELL_CHARS ? `${escaped.slice(0, MAX_CELL_CHARS)}…` : escaped;
}

/** A number as the fixed-width hex the format prints its CRC-32 in. */
function hex32(value: number): string {
	return value.toString(16).padStart(8, "0").toUpperCase();
}

/** Bytes as a space-separated hex dump, for a file whose signature was not recognized. */
function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A size or offset the header states as a number or a decimal string, as ASAR writers use both. */
function numberField(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
	return null;
}

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

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
