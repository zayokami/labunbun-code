/**
 * The structural reader shared by the artifact tools.
 *
 * A zip keeps its table of contents in an end-of-central-directory record and
 * a central directory; an ASAR keeps its table of contents in a length-prefixed
 * JSON header. Both answer "what is inside" without touching the payload, and
 * both are read here once so that the report tool and the comparison tool
 * cannot disagree about what an archive holds.
 *
 * Reading an entry's bytes is a separate, explicit step. Nothing in this module
 * extracts a file: `readZipEntry` and `readAsarEntry` return bytes to a caller
 * that asked for them, and the artifact report never calls either. The
 * comparison and capture tools do, because a content hash is the only honest
 * way to say two packages hold the same bytes.
 */
import { inflateRawSync } from "node:zlib";

/** How many leading bytes the container probe reads. */
const PROBE_BYTES = 16;

/** An EOCD record is 22 bytes; its comment may add 64 KiB after it. */
const EOCD_BYTES = 22;
const MAX_EOCD_COMMENT = 0xffff;

/** The ZIP64 EOCD record is 56 bytes, 44 of them past its size field. */
const ZIP64_RECORD_BYTES = 56;
const ZIP64_RECORD_MIN_FIELDS = 44;

/** An ASAR header past this size is refused rather than read. */
export const MAX_ASAR_HEADER_BYTES = 32 * 1024 * 1024;

/** How much of a zip central directory is read; past it the caller is told. */
export const MAX_CENTRAL_DIR_BYTES = 16 * 1024 * 1024;

/** Depth the ASAR directory walk descends before it stops and says so. */
export const MAX_TREE_DEPTH = 64;

/** How much of one name or path a report shows before it is cut. */
export const MAX_CELL_CHARS = 80;

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

/** A file open for ranged reads; its size is known from the stat that got us here. */
export type ArchiveFile = ReturnType<typeof Bun.file>;

/** One central-directory entry, after the ZIP64 extra field has had its say. */
export interface ZipEntry {
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
	/** General-purpose bit flags as the central directory states them. */
	flags: number;
	/** Where the entry's local file header starts, after ZIP64 resolution. */
	localOffset: number;
}

/** What one pass over the central directory yielded. */
export interface ZipDirectory {
	/** Entries the caller asked to keep, in directory order. */
	entries: ZipEntry[];
	count: number;
	compressed: number;
	uncompressed: number;
	/** Whether a trailing digital-signature record ended the directory. */
	signed: boolean;
	/** Names that appear more than once, case-sensitively. */
	duplicateNames: string[];
	/** Whether the read window ended before the directory did. */
	truncated: boolean;
	/** Where the ZIP64 EOCD record sits, or null when the archive is not ZIP64. */
	zip64At: number | null;
	eocdComment: number;
	directorySize: number;
	directoryOffset: number;
	/** Facts worth reporting that are not errors: spanned archive, count mismatch, and so on. */
	notes: string[];
	/** The EOCD record's declared count, which the entries are checked against. */
	declaredCount: number;
}

/** Where the EOCD record was found, and what its comment field said. */
interface EocdLocation {
	at: number;
	comment: number;
	note: string | null;
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
export function identify(head: Uint8Array, size: number): "zip" | "asar" | null {
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

/**
 * Read the zip directory, keeping at most `maxEntries` entries.
 *
 * The counts and totals cover every entry the directory holds, whether or not
 * the caller asked to keep it: a caller that lists 200 entries still reports
 * the true count, and a caller that hashes 20,000 knows when it stopped early.
 */
export async function readZipDirectory(
	file: ArchiveFile,
	size: number,
	maxEntries = Number.MAX_SAFE_INTEGER,
): Promise<ZipDirectory> {
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
	const truncated = directorySize > MAX_CENTRAL_DIR_BYTES;
	const directory = await readRange(
		file,
		directoryOffset,
		directoryOffset + (truncated ? MAX_CENTRAL_DIR_BYTES : directorySize),
	);
	const parsed = parseCentralDirectory(directory, directoryOffset, truncated, maxEntries);
	if (parsed.signed) notes.push("the central directory ends with a digital-signature record");
	if (truncated) {
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

	return {
		entries: parsed.entries,
		count: parsed.count,
		compressed: parsed.compressed,
		uncompressed: parsed.uncompressed,
		signed: parsed.signed,
		duplicateNames: parsed.duplicateNames,
		truncated,
		zip64At,
		eocdComment: eocd.comment,
		directorySize,
		directoryOffset,
		notes,
		declaredCount: entryCount,
	};
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
 * Every entry of the central directory, with totals over all of them and at
 * most `maxEntries` kept for the caller.
 *
 * `windowTruncated` is the caller saying the read window ended before the
 * directory did: the entry it cuts through is then left off the totals as
 * well, so the sums and the count describe the same set of bytes.
 */
function parseCentralDirectory(
	directory: Uint8Array,
	directoryOffset: number,
	windowTruncated: boolean,
	maxEntries: number,
): {
	entries: ZipEntry[];
	count: number;
	compressed: number;
	uncompressed: number;
	signed: boolean;
	duplicateNames: string[];
} {
	const entries: ZipEntry[] = [];
	const seen = new Set<string>();
	const duplicateNames: string[] = [];
	let count = 0;
	let compressed = 0;
	let uncompressed = 0;
	let at = 0;
	while (at + 46 <= directory.length) {
		const signature = u32(directory, at);
		if (signature === SIG_CENTRAL_SIGNATURE) {
			return { entries, count, compressed, uncompressed, signed: true, duplicateNames };
		}
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
		const flags = u16(directory, at + 8);
		let entryCompressed = u32(directory, at + 20);
		let entryUncompressed = u32(directory, at + 24);
		let localOffset = u32(directory, at + 42);
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
				cursor += 8;
				zip64 = true;
			}
			if (localOffset === ZIP64_SENTINEL_32) {
				if (cursor + 8 > data.length) {
					throw new Error(
						`entry "${printable(name)}": the local-header offset is the ZIP64 sentinel but the extra field does not carry it`,
					);
				}
				localOffset = u64(data, cursor);
				cursor += 8;
				zip64 = true;
			}
		}
		if (!zip64 && (entryUncompressed === ZIP64_SENTINEL_32 || entryCompressed === ZIP64_SENTINEL_32)) {
			throw new Error(
				`entry "${printable(name)}": a size is the ZIP64 sentinel value and no ZIP64 extra field is present`,
			);
		}
		if (localOffset === ZIP64_SENTINEL_32) {
			throw new Error(
				`entry "${printable(name)}": the local-header offset is the ZIP64 sentinel value and no ZIP64 extra field is present`,
			);
		}
		compressed += entryCompressed;
		uncompressed += entryUncompressed;
		if (seen.has(name)) {
			if (!duplicateNames.includes(name)) duplicateNames.push(name);
		} else {
			seen.add(name);
		}
		if (entries.length < maxEntries) {
			entries.push({
				name,
				method: u16(directory, at + 10),
				compressed: entryCompressed,
				uncompressed: entryUncompressed,
				crc: u32(directory, at + 16),
				date: u16(directory, at + 14),
				time: u16(directory, at + 12),
				zip64,
				flags,
				localOffset,
			});
		}
		count += 1;
		at = end;
	}
	return { entries, count, compressed, uncompressed, signed: false, duplicateNames };
}

/**
 * The bytes of one stored or deflated zip entry, verified against the central
 * directory's declared size and CRC-32.
 *
 * A mismatch throws rather than returning the bytes: a caller that hashes a
 * truncated or corrupt payload would report a difference that is not there,
 * or an equality that never existed. The caller decides whether one bad entry
 * is an unknown dimension or a failed call.
 */
export async function readZipEntry(
	file: ArchiveFile,
	size: number,
	entry: ZipEntry,
	maxBytes: number,
): Promise<Uint8Array> {
	if ((entry.flags & 1) !== 0) throw new Error(`entry "${printable(entry.name)}" is encrypted`);
	if (entry.localOffset + 30 > size) {
		throw new Error(`entry "${printable(entry.name)}": its local header starts past the end of the file`);
	}
	const header = await readRange(file, entry.localOffset, entry.localOffset + 30);
	if (u32(header, 0) !== SIG_LOCAL_HEADER) {
		throw new Error(
			`entry "${printable(entry.name)}": its local header does not start with the local-header signature`,
		);
	}
	const localFlags = u16(header, 6);
	const localMethod = u16(header, 8);
	if ((localFlags & 1) !== 0) throw new Error(`entry "${printable(entry.name)}" is encrypted`);
	if (localMethod !== entry.method) {
		throw new Error(
			`entry "${printable(entry.name)}": the local header's method ${localMethod} disagrees with the central directory's ${entry.method}`,
		);
	}
	const nameLength = u16(header, 26);
	const extraLength = u16(header, 28);
	const dataAt = entry.localOffset + 30 + nameLength + extraLength;
	if (dataAt + entry.compressed > size) {
		throw new Error(`entry "${printable(entry.name)}": its compressed bytes run past the end of the file`);
	}
	const payload = await readRange(file, dataAt, dataAt + entry.compressed);
	if (payload.length !== entry.compressed) {
		throw new Error(`entry "${printable(entry.name)}": its compressed bytes are cut off`);
	}
	let data: Uint8Array;
	if (entry.method === 0) {
		data = payload;
	} else if (entry.method === 8) {
		if (entry.uncompressed > maxBytes) {
			throw new Error(
				`entry "${printable(entry.name)}": ${entry.uncompressed} bytes is past the ${maxBytes}-byte entry cap`,
			);
		}
		data = new Uint8Array(inflateRawSync(payload, { maxOutputLength: maxBytes }));
	} else {
		throw new Error(
			`entry "${printable(entry.name)}": compression method ${entry.method} is not supported for reading`,
		);
	}
	if (data.length !== entry.uncompressed) {
		throw new Error(
			`entry "${printable(entry.name)}": the payload holds ${data.length} bytes where the directory declares ${entry.uncompressed}`,
		);
	}
	const crc = Bun.hash.crc32(data) >>> 0;
	if (crc !== entry.crc) {
		throw new Error(
			`entry "${printable(entry.name)}": CRC-32 0x${hex32(crc)} does not match the directory's 0x${hex32(entry.crc)}`,
		);
	}
	return data;
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

/** A zip name's bytes as text; the flag that would distinguish a legacy codepage is not read. */
export function decodeName(bytes: Uint8Array): string {
	return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------------
// ASAR
// ---------------------------------------------------------------------------

/** One node of the ASAR header tree. */
export interface AsarNode {
	path: string;
	/** Bytes the header states, or null when it states none. */
	size: number | null;
	/** Where the bytes live inside the archive, or null when the header does not say. */
	offset: number | null;
	unpacked: boolean;
	/** The target of a symlink entry; a node is a link or a file, never both. */
	link: string | null;
}

/** What a visit to one header node carries. */
export type AsarVisit =
	| { kind: "directory"; path: string; depth: number; childCount: number }
	| { kind: "link"; path: string; depth: number; link: string }
	| { kind: "file"; path: string; depth: number; size: number | null; offset: number | null; unpacked: boolean };

/** What the header's directory tree yielded. */
export interface AsarWalk {
	fileCount: number;
	directoryCount: number;
	unpackedCount: number;
	malformed: number;
	depthCapped: boolean;
}

/** The parsed ASAR header and where its payload begins. */
export interface AsarHeader {
	headerLength: number;
	headerEnd: number;
	files: Record<string, unknown>;
}

/** Read and parse the length-prefixed JSON header of an ASAR. */
export async function readAsarHeader(file: ArchiveFile, size: number): Promise<AsarHeader> {
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
	if (!isRecord(parsed)) throw new Error("the JSON header is not an object");
	const files = parsed.files;
	if (!isRecord(files)) throw new Error('the JSON header has no "files" map');
	return { headerLength, headerEnd: 8 + headerLength, files };
}

/** The header's `files` map walked depth-first, one visit per node in directory order. */
export function walkAsar(files: Record<string, unknown>, visit: (node: AsarVisit) => void): AsarWalk {
	const walk: AsarWalk = {
		fileCount: 0,
		directoryCount: 0,
		unpackedCount: 0,
		malformed: 0,
		depthCapped: false,
	};
	walkAsarDirectory(files, "", 1, walk, visit);
	return walk;
}

function walkAsarDirectory(
	files: Record<string, unknown>,
	prefix: string,
	depth: number,
	walk: AsarWalk,
	visit: (node: AsarVisit) => void,
): void {
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
			visit({ kind: "directory", path, depth, childCount: Object.keys(children).length });
			walkAsarDirectory(children, path, depth + 1, walk, visit);
			continue;
		}
		const link = typeof value.link === "string" ? value.link : null;
		if (link !== null) {
			walk.fileCount += 1;
			visit({ kind: "link", path, depth, link });
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
		visit({ kind: "file", path, depth, size, offset: numberField(value.offset), unpacked });
	}
}

/**
 * The bytes of one ASAR member, bounded by `maxBytes`.
 *
 * An unpacked member's bytes are not in the archive — they sit in the
 * `.unpacked` directory beside it — so asking for them here is a caller error,
 * not an empty file.
 */
export async function readAsarEntry(
	file: ArchiveFile,
	headerEnd: number,
	node: AsarNode,
	maxBytes: number,
): Promise<Uint8Array> {
	if (node.unpacked) throw new Error(`ASAR entry "${printable(node.path)}" is unpacked`);
	if (node.size === null || node.offset === null) {
		throw new Error(`ASAR entry "${printable(node.path)}" does not state both its size and its offset`);
	}
	if (node.size > maxBytes) {
		throw new Error(`ASAR entry "${printable(node.path)}" is ${node.size} bytes, past the ${maxBytes}-byte entry cap`);
	}
	const start = headerEnd + node.offset;
	const data = await readRange(file, start, start + node.size);
	if (data.length !== node.size) {
		throw new Error(
			`ASAR entry "${printable(node.path)}" is cut off: ${data.length} of ${node.size} bytes are present`,
		);
	}
	return data;
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/** The bytes of `[start, end)` — one range read, never the whole file. */
export async function readRange(file: ArchiveFile, start: number, end: number): Promise<Uint8Array> {
	return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** How many leading bytes the container probe reads. */
export const PROBE_BYTES_READ = PROBE_BYTES;

export function u16(bytes: Uint8Array, at: number): number {
	return bytes[at] | (bytes[at + 1] << 8);
}

export function u32(bytes: Uint8Array, at: number): number {
	return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** A 64-bit little-endian integer as a number; the formats' sizes stay far from 2^53. */
export function u64(bytes: Uint8Array, at: number): number {
	return u32(bytes, at) + u32(bytes, at + 4) * 0x1_0000_0000;
}

/**
 * A name or path as one safe line: control characters escaped, long values
 * cut. A name is bytes inside somebody else's file, and a newline in one must
 * not be allowed to break the line it is printed on — or to spell a line of
 * the report that the report did not write.
 */
export function printable(text: string): string {
	const parts: string[] = [];
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		parts.push(code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : character);
	}
	const escaped = parts.join("");
	return escaped.length > MAX_CELL_CHARS ? `${escaped.slice(0, MAX_CELL_CHARS)}…` : escaped;
}

/** A number as the fixed-width hex the format prints its CRC-32 in. */
export function hex32(value: number): string {
	return value.toString(16).padStart(8, "0").toUpperCase();
}

/** Bytes as a space-separated hex dump, for a file whose signature was not recognized. */
export function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A size or offset the header states as a number or a decimal string, as ASAR writers use both. */
export function numberField(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
	return null;
}

export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
