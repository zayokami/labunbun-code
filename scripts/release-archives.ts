/**
 * Archive writers for the release pipeline.
 *
 * The release is packaged on whatever host runs the build, so these writers
 * emit tar, ar, and zip containers directly instead of relying on dpkg-deb,
 * zip, or tar being installed. They cover exactly what the release needs:
 * short ustar paths, gzip-compressed Debian members, and stored or deflated
 * zip entries with Unix permission bits.
 */
import { createHash } from "node:crypto";
import { deflateRawSync, gzipSync } from "node:zlib";

export type TarEntry = {
	name: string;
	mode: number;
	data: Buffer;
	directory?: boolean;
};

export type DebFile = {
	path: string;
	mode: number;
	data: Buffer;
};

export type DebOptions = {
	packageName: string;
	version: string;
	architecture: string;
	maintainer: string;
	homepage: string;
	description: string[];
	files: DebFile[];
	mtime: number;
};

export type ZipEntry = {
	name: string;
	mode: number;
	data: Buffer;
	directory?: boolean;
};

const BLOCK = 512;

function octal(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(entry: TarEntry, mtime: number): Buffer {
	const name = Buffer.byteLength(entry.name);
	if (name > 100) throw new Error(`tar path is too long: ${entry.name}`);
	const header = Buffer.alloc(BLOCK, 0);
	header.write(entry.name, 0, 100, "utf8");
	header.write(octal(entry.mode, 8), 100, 8, "ascii");
	header.write(octal(0, 8), 108, 8, "ascii");
	header.write(octal(0, 8), 116, 8, "ascii");
	header.write(octal(entry.directory ? 0 : entry.data.length, 12), 124, 12, "ascii");
	header.write(octal(mtime, 12), 136, 12, "ascii");
	header.fill(0x20, 148, 156);
	header.write(entry.directory ? "5" : "0", 156, 1, "ascii");
	header.write("ustar\0" + "00", 257, 8, "ascii");
	header.write("root", 265, 32, "ascii");
	header.write("root", 297, 32, "ascii");
	header.write(octal(0, 8), 329, 8, "ascii");
	header.write(octal(0, 8), 337, 8, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return header;
}

export function buildTar(entries: TarEntry[], mtime: number): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		parts.push(tarHeader(entry, mtime));
		if (entry.directory) continue;
		parts.push(entry.data);
		const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
		if (padding > 0) parts.push(Buffer.alloc(padding, 0));
	}
	parts.push(Buffer.alloc(BLOCK * 2, 0));
	return Buffer.concat(parts);
}

function arMember(name: string, data: Buffer, mtime: number): Buffer {
	const header = Buffer.alloc(60, 0x20);
	header.write(`${name}/`, 0, 16, "ascii");
	header.write(String(mtime), 16, 12, "ascii");
	header.write("0", 28, 6, "ascii");
	header.write("0", 34, 6, "ascii");
	header.write("100644", 40, 8, "ascii");
	header.write(String(data.length), 48, 10, "ascii");
	header.write("`\n", 58, 2, "ascii");
	const padding = data.length % 2 === 1 ? Buffer.from("\n") : Buffer.alloc(0);
	return Buffer.concat([header, data, padding]);
}

function buildAr(members: Array<{ name: string; data: Buffer }>, mtime: number): Buffer {
	return Buffer.concat([
		Buffer.from("!<arch>\n", "ascii"),
		...members.map((member) => arMember(member.name, member.data, mtime)),
	]);
}

function parentDirectories(files: DebFile[]): string[] {
	const directories = new Set<string>(["./"]);
	for (const file of files) {
		const segments = file.path.split("/");
		for (let index = 1; index < segments.length; index += 1) {
			directories.add(`./${segments.slice(0, index).join("/")}/`);
		}
	}
	return [...directories].sort();
}

function md5(data: Buffer): string {
	return createHash("md5").update(data).digest("hex");
}

export function buildDeb(options: DebOptions): Buffer {
	const sorted = [...options.files].sort((left, right) => left.path.localeCompare(right.path));
	const installedSize = Math.ceil(sorted.reduce((total, file) => total + file.data.length, 0) / 1024);
	const md5sums = sorted.map((file) => `${md5(file.data)}  ${file.path}\n`).join("");
	const control = [
		`Package: ${options.packageName}`,
		`Version: ${options.version}`,
		`Section: devel`,
		`Priority: optional`,
		`Architecture: ${options.architecture}`,
		`Maintainer: ${options.maintainer}`,
		`Installed-Size: ${installedSize}`,
		`Depends: libc6 (>= 2.17)`,
		`Homepage: ${options.homepage}`,
		`Description: ${options.description[0]}`,
		...options.description.slice(1).map((line) => ` ${line}`),
		"",
	].join("\n");

	const dataEntries: TarEntry[] = parentDirectories(sorted).map((name) => ({
		name,
		mode: 0o755,
		data: Buffer.alloc(0),
		directory: true,
	}));
	for (const file of sorted) {
		dataEntries.push({ name: `./${file.path}`, mode: file.mode, data: file.data });
	}

	const controlTar = gzipSync(
		buildTar(
			[
				{ name: "./control", mode: 0o644, data: Buffer.from(control, "utf8") },
				{ name: "./md5sums", mode: 0o644, data: Buffer.from(md5sums, "utf8") },
			],
			options.mtime,
		),
		{ level: 9 },
	);
	const dataTar = gzipSync(buildTar(dataEntries, options.mtime), { level: 9 });

	return buildAr(
		[
			{ name: "debian-binary", data: Buffer.from("2.0\n", "ascii") },
			{ name: "control.tar.gz", data: controlTar },
			{ name: "data.tar.gz", data: dataTar },
		],
		options.mtime,
	);
}

function dosTimestamp(date: Date): { time: number; day: number } {
	const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
	const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
	return { time, day };
}

export function buildZip(entries: ZipEntry[], modified: Date): Buffer {
	const { time, day } = dosTimestamp(modified);
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = entry.directory ? Buffer.alloc(0) : entry.data;
		const compressed = entry.directory ? Buffer.alloc(0) : deflateRawSync(data, { level: 9 });
		const crc = entry.directory ? 0 : Bun.hash.crc32(data);
		const method = entry.directory ? 0 : 8;

		const local = Buffer.alloc(30, 0);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(day, 12);
		local.writeUInt32LE(crc >>> 0, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, compressed);

		const header = Buffer.alloc(46, 0);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE((3 << 8) | 30, 4);
		header.writeUInt16LE(20, 6);
		header.writeUInt16LE(0, 8);
		header.writeUInt16LE(method, 10);
		header.writeUInt16LE(time, 12);
		header.writeUInt16LE(day, 14);
		header.writeUInt32LE(crc >>> 0, 16);
		header.writeUInt32LE(compressed.length, 20);
		header.writeUInt32LE(data.length, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt16LE(0, 30);
		header.writeUInt16LE(0, 32);
		header.writeUInt16LE(0, 34);
		header.writeUInt16LE(0, 36);
		header.writeUInt32LE(entry.directory ? ((0o040755 << 16) | 0x10) >>> 0 : ((0o100000 | entry.mode) << 16) >>> 0, 38);
		header.writeUInt32LE(offset, 42);
		central.push(header, name);

		offset += local.length + name.length + compressed.length;
	}

	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22, 0);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([...locals, directory, end]);
}
