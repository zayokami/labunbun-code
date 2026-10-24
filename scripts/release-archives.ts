/**
 * Archive writers for the release pipeline.
 *
 * The release is packaged on whatever host runs the build, so these writers
 * emit tar, ar, zip, RPM, and SquashFS containers directly instead of relying
 * on dpkg-deb, zip, tar, rpmbuild, or mksquashfs being installed. They cover
 * exactly what the release needs: short ustar paths, gzip-compressed Debian
 * members, stored or deflated zip entries with Unix permission bits, a
 * header-plus-cpio RPM, and a fragment-free SquashFS 4 image for AppImage.
 */
import { createHash } from "node:crypto";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";

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

export type RpmFile = {
	path: string;
	mode: number;
	data: Buffer;
};

export type RpmOptions = {
	packageName: string;
	version: string;
	release: string;
	architecture: string;
	summary: string;
	description: string[];
	license: string;
	maintainer: string;
	homepage: string;
	mtime: number;
	files: RpmFile[];
};

type RpmValue =
	| { kind: "int16"; values: number[] }
	| { kind: "int32"; values: number[] }
	| { kind: "string"; value: string }
	| { kind: "bin"; data: Buffer }
	| { kind: "strings"; values: string[] }
	| { kind: "i18n"; values: string[] };

const RPM_TYPE = { int16: 3, int32: 4, string: 6, bin: 7, strings: 8, i18n: 9 } as const;

function rpmValueCount(value: RpmValue): number {
	switch (value.kind) {
		case "int16":
		case "int32":
		case "strings":
		case "i18n":
			return value.values.length;
		case "string":
			return 1;
		case "bin":
			return value.data.length;
	}
}

function rpmValueData(value: RpmValue): Buffer {
	switch (value.kind) {
		case "int16": {
			const data = Buffer.alloc(value.values.length * 2);
			value.values.forEach((item, index) => {
				data.writeUInt16BE(item, index * 2);
			});
			return data;
		}
		case "int32": {
			const data = Buffer.alloc(value.values.length * 4);
			value.values.forEach((item, index) => {
				data.writeUInt32BE(item, index * 4);
			});
			return data;
		}
		case "string":
			return Buffer.from(`${value.value}\0`, "utf8");
		case "bin":
			return value.data;
		case "strings":
		case "i18n":
			return Buffer.concat(value.values.map((item) => Buffer.from(`${item}\0`, "utf8")));
	}
}

function rpmHeader(entries: Array<{ tag: number; value: RpmValue }>): Buffer {
	const sorted = [...entries].sort((left, right) => left.tag - right.tag);
	const chunks: Buffer[] = [];
	const indexes: Buffer[] = [];
	let offset = 0;
	for (const entry of sorted) {
		const alignment = entry.value.kind === "int32" ? 4 : entry.value.kind === "int16" ? 2 : 1;
		const padding = (alignment - (offset % alignment)) % alignment;
		if (padding > 0) {
			chunks.push(Buffer.alloc(padding));
			offset += padding;
		}
		const data = rpmValueData(entry.value);
		const index = Buffer.alloc(16);
		index.writeUInt32BE(entry.tag, 0);
		index.writeUInt32BE(RPM_TYPE[entry.value.kind], 4);
		index.writeUInt32BE(offset, 8);
		index.writeUInt32BE(rpmValueCount(entry.value), 12);
		indexes.push(index);
		chunks.push(data);
		offset += data.length;
	}
	const store = Buffer.concat(chunks);
	const header = Buffer.alloc(16);
	header.writeUInt8(0x8e, 0);
	header.writeUInt8(0xad, 1);
	header.writeUInt8(0xe8, 2);
	header.writeUInt8(1, 3);
	header.writeUInt32BE(sorted.length, 8);
	header.writeUInt32BE(store.length, 12);
	return Buffer.concat([header, ...indexes, store]);
}

function rpmLead(name: string, architecture: string): Buffer {
	const lead = Buffer.alloc(96);
	lead.writeUInt32BE(0xedabeedb, 0);
	lead.writeUInt8(3, 4);
	lead.writeUInt8(0, 5);
	lead.writeUInt16BE(0, 6);
	lead.writeUInt16BE(architecture === "aarch64" ? 19 : 1, 8);
	lead.write(name, 10, 65, "ascii");
	lead.writeUInt16BE(1, 76);
	lead.writeUInt16BE(5, 78);
	return lead;
}

function cpioEntry(path: string, mode: number, data: Buffer, mtime: number, inode: number, nlink: number): Buffer {
	const name = Buffer.from(`${path}\0`, "utf8");
	const hex = (value: number): string => value.toString(16).padStart(8, "0");
	const header = Buffer.from(
		`070701${hex(inode)}${hex(mode)}${hex(0)}${hex(0)}${hex(nlink)}${hex(mtime)}${hex(data.length)}${hex(0)}${hex(0)}${hex(0)}${hex(0)}${hex(name.length)}${hex(0)}`,
		"ascii",
	);
	const parts: Buffer[] = [header, name];
	const namePadding = (4 - ((header.length + name.length) % 4)) % 4;
	if (namePadding > 0) parts.push(Buffer.alloc(namePadding));
	if (data.length > 0) {
		parts.push(data);
		const dataPadding = (4 - (data.length % 4)) % 4;
		if (dataPadding > 0) parts.push(Buffer.alloc(dataPadding));
	}
	return Buffer.concat(parts);
}

function buildCpio(files: RpmFile[], mtime: number): Buffer {
	const directories = new Set<string>();
	for (const file of files) {
		const segments = file.path.split("/");
		for (let index = 1; index < segments.length; index += 1) {
			directories.add(segments.slice(0, index).join("/"));
		}
	}
	const entries: Array<{ path: string; mode: number; data: Buffer; nlink: number }> = [];
	for (const directory of [...directories].sort()) {
		entries.push({ path: `./${directory}`, mode: 0o040755, data: Buffer.alloc(0), nlink: 2 });
	}
	for (const file of files) {
		entries.push({ path: `./${file.path}`, mode: 0o100000 | file.mode, data: file.data, nlink: 1 });
	}
	const parts: Buffer[] = [];
	entries.forEach((entry, index) => {
		parts.push(cpioEntry(entry.path, entry.mode, entry.data, mtime, index + 1, entry.nlink));
	});
	parts.push(cpioEntry("TRAILER!!!", 0, Buffer.alloc(0), 0, 0, 1));
	return Buffer.concat(parts);
}

export function buildRpm(options: RpmOptions): Buffer {
	const files = [...options.files].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
	const directories = [...new Set(files.map((file) => file.path.slice(0, file.path.lastIndexOf("/") + 1)))].sort();
	const cpio = buildCpio(files, options.mtime);
	const payload = gzipSync(cpio, { level: 9 });
	const installedSize = files.reduce((total, file) => total + file.data.length, 0);
	const digest = (data: Buffer, algorithm: "md5" | "sha256"): string =>
		createHash(algorithm).update(data).digest("hex");

	const mainHeader = rpmHeader([
		{ tag: 100, value: { kind: "strings", values: ["C"] } },
		{ tag: 1000, value: { kind: "string", value: options.packageName } },
		{ tag: 1001, value: { kind: "string", value: options.version } },
		{ tag: 1002, value: { kind: "string", value: options.release } },
		{ tag: 1004, value: { kind: "i18n", values: [options.summary] } },
		{ tag: 1005, value: { kind: "i18n", values: [options.description.join("\n")] } },
		{ tag: 1006, value: { kind: "int32", values: [options.mtime] } },
		{ tag: 1007, value: { kind: "string", value: "labunbun" } },
		{ tag: 1009, value: { kind: "int32", values: [installedSize] } },
		{ tag: 1014, value: { kind: "string", value: options.license } },
		{ tag: 1015, value: { kind: "string", value: options.maintainer } },
		{ tag: 1016, value: { kind: "i18n", values: ["Development/Tools"] } },
		{ tag: 1020, value: { kind: "string", value: options.homepage } },
		{ tag: 1021, value: { kind: "string", value: "linux" } },
		{ tag: 1022, value: { kind: "string", value: options.architecture } },
		{ tag: 1028, value: { kind: "int32", values: files.map((file) => file.data.length) } },
		{ tag: 1030, value: { kind: "int16", values: files.map((file) => (0o100000 | file.mode) & 0xffff) } },
		{ tag: 1033, value: { kind: "int16", values: files.map(() => 0) } },
		{ tag: 1034, value: { kind: "int32", values: files.map(() => options.mtime) } },
		{ tag: 1035, value: { kind: "strings", values: files.map((file) => digest(file.data, "sha256")) } },
		{ tag: 1036, value: { kind: "strings", values: files.map(() => "") } },
		{ tag: 1037, value: { kind: "int32", values: files.map(() => 0) } },
		{ tag: 1039, value: { kind: "strings", values: files.map(() => "root") } },
		{ tag: 1040, value: { kind: "strings", values: files.map(() => "root") } },
		{ tag: 1047, value: { kind: "strings", values: [options.packageName] } },
		{ tag: 1048, value: { kind: "int32", values: [0x0c] } },
		{ tag: 1049, value: { kind: "strings", values: ["glibc"] } },
		{ tag: 1050, value: { kind: "strings", values: ["2.17"] } },
		{ tag: 1095, value: { kind: "int32", values: files.map(() => 1) } },
		{ tag: 1096, value: { kind: "int32", values: files.map((_, index) => index + 1) } },
		{ tag: 1097, value: { kind: "strings", values: files.map(() => "") } },
		{ tag: 1112, value: { kind: "int32", values: [0x08] } },
		{ tag: 1113, value: { kind: "strings", values: [`${options.version}-${options.release}`] } },
		{
			tag: 1116,
			value: {
				kind: "int32",
				values: files.map((file) => directories.indexOf(file.path.slice(0, file.path.lastIndexOf("/") + 1))),
			},
		},
		{
			tag: 1117,
			value: { kind: "strings", values: files.map((file) => file.path.slice(file.path.lastIndexOf("/") + 1)) },
		},
		{ tag: 1118, value: { kind: "strings", values: directories.map((directory) => `/${directory}`) } },
		{ tag: 1124, value: { kind: "string", value: "cpio" } },
		{ tag: 1125, value: { kind: "string", value: "gzip" } },
		{ tag: 1126, value: { kind: "string", value: "9" } },
		{ tag: 1132, value: { kind: "string", value: `${options.architecture}-linux` } },
		{ tag: 5011, value: { kind: "int32", values: [8] } },
		{ tag: 5062, value: { kind: "string", value: "utf-8" } },
		{ tag: 5092, value: { kind: "strings", values: [digest(payload, "sha256")] } },
		{ tag: 5093, value: { kind: "int32", values: [8] } },
	]);

	const signedRegion = Buffer.concat([mainHeader, payload]);
	const sizes = { header: mainHeader.length, payload: payload.length };
	const signature = rpmHeader([
		{ tag: 273, value: { kind: "string", value: digest(mainHeader, "sha256") } },
		{ tag: 1000, value: { kind: "int32", values: [sizes.header + sizes.payload] } },
		{ tag: 1004, value: { kind: "bin", data: createHash("md5").update(signedRegion).digest() } },
		{ tag: 1007, value: { kind: "int32", values: [cpio.length] } },
	]);
	const signaturePadding = (8 - (signature.length % 8)) % 8;
	return Buffer.concat([
		rpmLead(
			`${options.packageName}-${options.version}-${options.release}.${options.architecture}`,
			options.architecture,
		),
		signature,
		Buffer.alloc(signaturePadding),
		signedRegion,
	]);
}

export type SquashfsEntry = {
	path: string;
	mode: number;
	data?: Buffer;
	symlink?: string;
};

type SquashfsNode = {
	path: string;
	name: string;
	parent: string;
	mode: number;
	data: Buffer;
	symlink?: string;
	inode: number;
	directory: boolean;
};

const SQUASHFS_BLOCK_SIZE = 131_072;
const SQUASHFS_BLOCK_LOG = 17;
const SQUASHFS_INVALID_BLOCK = 0xffffffffffffffffn;

function byName(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function squashfsMetadataBlock(data: Buffer): Buffer {
	const compressed = deflateSync(data, { level: 9 });
	const header = Buffer.alloc(2);
	if (compressed.length < data.length) {
		header.writeUInt16LE(compressed.length, 0);
		return Buffer.concat([header, compressed]);
	}
	header.writeUInt16LE(0x8000 | data.length, 0);
	return Buffer.concat([header, data]);
}

function squashfsDataBlock(data: Buffer): { stored: Buffer; entry: number } {
	const compressed = deflateSync(data, { level: 9 });
	if (compressed.length < data.length) return { stored: compressed, entry: compressed.length };
	return { stored: data, entry: 0x01000000 | data.length };
}

export function buildSquashfs(entries: SquashfsEntry[], mtime: number): Buffer {
	const nodes = new Map<string, SquashfsNode>();
	nodes.set("", { path: "", name: "", parent: "", mode: 0o755, data: Buffer.alloc(0), inode: 0, directory: true });
	for (const entry of entries) {
		const path = entry.path.replace(/^\/+|\/+$/g, "");
		const segments = path.split("/");
		if (path.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
			throw new Error(`invalid squashfs path: ${entry.path}`);
		}
		let prefix = "";
		for (let index = 0; index < segments.length - 1; index += 1) {
			prefix = prefix.length === 0 ? segments[index] : `${prefix}/${segments[index]}`;
			const parent = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
			const existing = nodes.get(prefix);
			if (existing && !existing.directory) throw new Error(`squashfs entry is both a file and a directory: ${prefix}`);
			if (!existing) {
				nodes.set(prefix, {
					path: prefix,
					name: segments[index],
					parent,
					mode: 0o755,
					data: Buffer.alloc(0),
					inode: 0,
					directory: true,
				});
			}
		}
		const existing = nodes.get(path);
		if (existing?.directory) throw new Error(`squashfs entry collides with a directory: ${path}`);
		nodes.set(path, {
			path,
			name: segments[segments.length - 1],
			parent: segments.slice(0, -1).join("/"),
			mode: entry.mode,
			data: entry.data ?? Buffer.alloc(0),
			symlink: entry.symlink,
			inode: 0,
			directory: false,
		});
	}

	const ordered = [...nodes.values()]
		.filter((node) => node.path.length > 0)
		.sort((left, right) => byName(left.path, right.path));
	ordered.forEach((node, index) => {
		node.inode = index + 1;
	});
	const root = nodes.get("") as SquashfsNode;
	root.inode = ordered.length + 1;
	const inodeOrder = [...nodes.values()].sort((left, right) => left.inode - right.inode);

	const children = new Map<string, SquashfsNode[]>();
	for (const node of nodes.values()) {
		if (node.path.length === 0) continue;
		const list = children.get(node.parent) ?? [];
		list.push(node);
		children.set(node.parent, list);
	}
	for (const list of children.values()) list.sort((left, right) => byName(left.name, right.name));

	const inodeSize = (node: SquashfsNode): number => {
		if (node.directory) return 32;
		if (node.symlink !== undefined) return 24 + Buffer.byteLength(node.symlink);
		return 32 + 4 * Math.ceil(node.data.length / SQUASHFS_BLOCK_SIZE);
	};
	const inodeOffsets = new Map<string, number>();
	let inodeLength = 0;
	for (const node of inodeOrder) {
		inodeOffsets.set(node.path, inodeLength);
		inodeLength += inodeSize(node);
	}
	if (inodeLength > 8192) throw new Error("squashfs inode table does not fit one metadata block");

	const dataParts: Buffer[] = [];
	let dataLength = 96;
	const fileLayout = new Map<string, { start: number; blocks: number[] }>();
	for (const node of inodeOrder) {
		if (node.directory || node.symlink !== undefined) continue;
		const start = dataLength;
		const blocks: number[] = [];
		for (let offset = 0; offset < node.data.length; offset += SQUASHFS_BLOCK_SIZE) {
			const encoded = squashfsDataBlock(node.data.subarray(offset, offset + SQUASHFS_BLOCK_SIZE));
			blocks.push(encoded.entry);
			dataParts.push(encoded.stored);
			dataLength += encoded.stored.length;
		}
		fileLayout.set(node.path, { start, blocks });
	}

	const directoryPaths = [...nodes.values()]
		.filter((node) => node.directory)
		.map((node) => node.path)
		.sort(byName);
	const directoryParts: Buffer[] = [];
	let directoryLength = 0;
	const directoryLayout = new Map<string, { offset: number; size: number }>();
	for (const path of directoryPaths) {
		const kids = children.get(path) ?? [];
		const offset = directoryLength;
		if (kids.length === 0) {
			directoryLayout.set(path, { offset, size: 0 });
			continue;
		}
		const base = Math.min(...kids.map((node) => node.inode));
		const header = Buffer.alloc(12);
		header.writeUInt32LE(kids.length - 1, 0);
		header.writeUInt32LE(0, 4);
		header.writeUInt32LE(base, 8);
		const parts = [header];
		let size = 12;
		for (const kid of kids) {
			const name = Buffer.from(kid.name, "utf8");
			const entry = Buffer.alloc(8);
			const delta = kid.inode - base;
			if (delta > 32767) throw new Error("squashfs directory inode delta does not fit 16 bits");
			entry.writeUInt16LE(inodeOffsets.get(kid.path) as number, 0);
			entry.writeUInt16LE(delta, 2);
			entry.writeUInt16LE(kid.directory ? 1 : kid.symlink !== undefined ? 3 : 2, 4);
			entry.writeUInt16LE(name.length - 1, 6);
			parts.push(entry, name);
			size += 8 + name.length;
		}
		directoryParts.push(Buffer.concat(parts));
		directoryLength += size;
		directoryLayout.set(path, { offset, size });
	}
	if (directoryLength > 8192) throw new Error("squashfs directory table does not fit one metadata block");

	const inodeParts: Buffer[] = [];
	for (const node of inodeOrder) {
		const base = Buffer.alloc(16);
		base.writeUInt16LE(node.directory ? 1 : node.symlink !== undefined ? 3 : 2, 0);
		base.writeUInt16LE(node.mode & 0o7777, 2);
		base.writeUInt16LE(0, 4);
		base.writeUInt16LE(0, 6);
		base.writeUInt32LE(mtime, 8);
		base.writeUInt32LE(node.inode, 12);
		inodeParts.push(base);
		if (node.directory) {
			const layout = directoryLayout.get(node.path) as { offset: number; size: number };
			const body = Buffer.alloc(16);
			body.writeUInt32LE(0, 0);
			body.writeUInt32LE(2 + (children.get(node.path) ?? []).filter((kid) => kid.directory).length, 4);
			body.writeUInt16LE(layout.size + 3, 8);
			body.writeUInt16LE(layout.offset, 10);
			body.writeUInt32LE(node.path.length === 0 ? root.inode + 1 : (nodes.get(node.parent) as SquashfsNode).inode, 12);
			inodeParts.push(body);
		} else if (node.symlink !== undefined) {
			const target = Buffer.from(node.symlink, "utf8");
			const body = Buffer.alloc(8);
			body.writeUInt32LE(1, 0);
			body.writeUInt32LE(target.length, 4);
			inodeParts.push(body, target);
		} else {
			const layout = fileLayout.get(node.path) as { start: number; blocks: number[] };
			const body = Buffer.alloc(16);
			body.writeUInt32LE(layout.start, 0);
			body.writeUInt32LE(0xffffffff, 4);
			body.writeUInt32LE(0, 8);
			body.writeUInt32LE(node.data.length, 12);
			const blocks = Buffer.alloc(4 * layout.blocks.length);
			layout.blocks.forEach((entry, index) => {
				blocks.writeUInt32LE(entry, index * 4);
			});
			inodeParts.push(body, blocks);
		}
	}
	const inodeData = Buffer.concat(inodeParts);
	if (inodeData.length !== inodeLength) throw new Error("squashfs inode layout drifted");

	const inodeBlock = squashfsMetadataBlock(inodeData);
	const directoryBlock = squashfsMetadataBlock(Buffer.concat(directoryParts));
	const inodeTableStart = dataLength;
	const directoryTableStart = inodeTableStart + inodeBlock.length;
	const fragmentTableStart = directoryTableStart + directoryBlock.length;
	const idBlock = squashfsMetadataBlock(Buffer.alloc(4));
	const idLookupStart = fragmentTableStart + idBlock.length;
	const bytesUsed = idLookupStart + 8;

	const superblock = Buffer.alloc(96);
	superblock.write("hsqs", 0, 4, "ascii");
	superblock.writeUInt32LE(nodes.size, 4);
	superblock.writeUInt32LE(mtime, 8);
	superblock.writeUInt32LE(SQUASHFS_BLOCK_SIZE, 12);
	superblock.writeUInt32LE(0, 16);
	superblock.writeUInt16LE(1, 20);
	superblock.writeUInt16LE(SQUASHFS_BLOCK_LOG, 22);
	superblock.writeUInt16LE(0x0210, 24);
	superblock.writeUInt16LE(1, 26);
	superblock.writeUInt16LE(4, 28);
	superblock.writeUInt16LE(0, 30);
	superblock.writeBigUInt64LE(BigInt(inodeOffsets.get("") as number), 32);
	superblock.writeBigUInt64LE(BigInt(bytesUsed), 40);
	superblock.writeBigUInt64LE(BigInt(idLookupStart), 48);
	superblock.writeBigUInt64LE(SQUASHFS_INVALID_BLOCK, 56);
	superblock.writeBigUInt64LE(BigInt(inodeTableStart), 64);
	superblock.writeBigUInt64LE(BigInt(directoryTableStart), 72);
	superblock.writeBigUInt64LE(BigInt(fragmentTableStart), 80);
	superblock.writeBigUInt64LE(SQUASHFS_INVALID_BLOCK, 88);

	const idLookup = Buffer.alloc(8);
	idLookup.writeBigUInt64LE(BigInt(fragmentTableStart), 0);
	return Buffer.concat([superblock, ...dataParts, inodeBlock, directoryBlock, idBlock, idLookup]);
}

export function buildAppImage(runtime: Buffer, entries: SquashfsEntry[], mtime: number): Buffer {
	return Buffer.concat([runtime, buildSquashfs(entries, mtime)]);
}
