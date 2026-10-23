/**
 * Byte-level zip and ASAR builders, shared by the artifact tests.
 *
 * A fixture that a test assembles field by field says which byte sits where;
 * a checked-in binary says nothing and cannot be regenerated. These builders
 * cover the fields the readers under test care about, including the ZIP64
 * sentinels and extra-field slots, so a test can put a value in the exact
 * slot the reader is supposed to consult.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

export const encoder = new TextEncoder();

export function byteArray(values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

export const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];

export const le32 = (value: number): number[] => [
	value & 0xff,
	(value >>> 8) & 0xff,
	(value >>> 16) & 0xff,
	(value >>> 24) & 0xff,
];

export const le64 = (value: number): number[] =>
	le32(value % 0x1_0000_0000).concat(le32(Math.floor(value / 0x1_0000_0000)));

export const u32At = (source: Uint8Array, at: number): number =>
	(source[at] | (source[at + 1] << 8) | (source[at + 2] << 16) | (source[at + 3] << 24)) >>> 0;

export const crc32 = (data: Uint8Array): number => Bun.hash.crc32(data) >>> 0;

export const hex32 = (value: number): string => value.toString(16).padStart(8, "0").toUpperCase();

/** The DOS words for 2024-01-02 03:04:06, the time the zip fixtures carry unless they opt out. */
export const DOS_DATE = (44 << 9) | (1 << 5) | 2;
export const DOS_TIME = (3 << 11) | (4 << 5) | 3;

export interface FixtureEntry {
	name: string;
	data: Uint8Array;
	/** 0 = store, 8 = deflate through node:zlib; another number keeps the bytes as written. */
	method?: number;
	/** Write both sizes as ZIP64 sentinels in the central record, with the real values in a 0x0001 extra field. */
	zip64Sizes?: boolean;
	/** Write the local-header offset as the ZIP64 sentinel, with the real value in a 0x0001 extra field. */
	zip64LocalOffset?: boolean;
	/** General-purpose bit flags carried by both the local header and the central record. */
	flags?: number;
	/** DOS date/time words; 0/0 renders as "no mtime". */
	date?: number;
	time?: number;
}

export interface ZipFixture {
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
export function buildZip(options: { entries: FixtureEntry[]; comment?: string; zip64?: boolean }): ZipFixture {
	const chunks: Uint8Array[] = [];
	const central: number[] = [];
	let localOffset = 0;
	for (const entry of options.entries) {
		const name = encoder.encode(entry.name);
		const method = entry.method ?? 0;
		const flags = entry.flags ?? 0;
		const stored = method === 8 ? deflateRawSync(entry.data) : entry.data;
		const crc = crc32(entry.data);
		const date = entry.date ?? DOS_DATE;
		const time = entry.time ?? DOS_TIME;
		const local = [
			...le32(0x04034b50),
			...le16(20),
			...le16(flags),
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
		const zip64Data: number[] = [];
		if (entry.zip64Sizes) zip64Data.push(...le64(entry.data.length), ...le64(stored.length));
		if (entry.zip64LocalOffset) zip64Data.push(...le64(localOffset));
		const zip64Extra = zip64Data.length === 0 ? [] : [...le16(0x0001), ...le16(zip64Data.length), ...zip64Data];
		central.push(
			...le32(0x02014b50),
			...le16(20),
			...le16(20),
			...le16(flags),
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
			...le32(entry.zip64LocalOffset ? 0xffffffff : localOffset),
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
export function asarHeaderSize(files: Record<string, unknown>): number {
	const json = encoder.encode(JSON.stringify({ files }));
	return (json.length + 3) & ~3;
}

/** An ASAR: the 8-byte pickle (payload size 4, then the JSON's length), the padded JSON, then payload bytes. */
export function buildAsar(files: Record<string, unknown>, payload = new Uint8Array(16)): Uint8Array {
	const json = encoder.encode(JSON.stringify({ files }));
	const size = (json.length + 3) & ~3;
	const header = new Uint8Array(size);
	header.set(json);
	return concat([byteArray([...le32(4), ...le32(size)]), header, payload]);
}

export function writeFixture(dir: string, name: string, bytes: Uint8Array): string {
	writeFileSync(join(dir, name), bytes);
	return name;
}
