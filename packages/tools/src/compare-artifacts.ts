/**
 * CompareArtifacts — do two packages hold the same files, byte for byte?
 *
 * The question is membership and content, not names and timestamps: a path
 * that exists on both sides is compared by its SHA-256, a path that exists on
 * one side is reported as added or removed, and a path whose content could
 * not be read is reported as unknown rather than guessed equal. Directories
 * are structure, not payload, so they are not compared; a symlink is compared
 * by its target and is never followed.
 *
 * Each side can be a plain file, a directory, a zip-family archive, or an
 * ASAR. Archive entries are decompressed in memory only to hash them: nothing
 * is extracted, no path inside an archive is joined to a path on disk, and
 * the source files are opened read-only.
 *
 * The comparison is bounded in every dimension that could grow without bound
 * — entries per side, bytes per entry, bytes read, bytes hashed, directory
 * depth, listed changes, report characters — and a bound that is reached
 * becomes a limitation in the report. A partial answer that says it is
 * partial is the only useful answer here; silence about a skipped entry would
 * read as "unchanged".
 */

import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { open, readdir, readlink, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type AnyTool, buildTool, formatCutMarker } from "@labunbun/agent";
import { z } from "zod";
import {
	type ArchiveFile,
	type AsarNode,
	identify,
	message,
	PROBE_BYTES_READ,
	printable,
	readAsarEntry,
	readAsarHeader,
	readRange,
	readZipDirectory,
	readZipEntry,
	walkAsar,
} from "./archive.ts";
import { guardPathContainment } from "./containment.ts";
import { describeFsFailure } from "./path-errors.ts";

/** Files compared per side before the rest are counted as outside the comparison. */
const MAX_ENTRIES_PER_SIDE = 20_000;

/** Bytes of one file or archive entry that may be hashed. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Bytes hashed across both sides. */
const MAX_TOTAL_HASH_BYTES = 256 * 1024 * 1024;

/** Bytes read across both sides, counting compressed archive payloads. */
const MAX_TOTAL_READ_BYTES = 512 * 1024 * 1024;

/** Directory levels walked before the walk stops and says so. */
const MAX_DIRECTORY_DEPTH = 64;

/** Changes listed before the rest are counted. */
const MAX_LISTED_CHANGES = 200;

/** Whole-report cap; past it the tail is cut with an explicit marker. */
const MAX_REPORT_CHARS = 20_000;

/** Hex characters of a SHA-256 shown beside one changed path. */
const DISPLAY_HASH_CHARS = 12;

type EntryKind = "file" | "link";

/** What one side holds about one logical path. */
interface ComparedEntry {
	kind: EntryKind;
	size: number;
	/** SHA-256 of the file's bytes, or of a link's target string. */
	digest: string | null;
	/** Why the digest is null, when it is. */
	note: string | null;
}

/** One side of the comparison, after its container has been read. */
interface SideInventory {
	display: string;
	format: "file" | "directory" | "zip" | "asar";
	entries: Map<string, ComparedEntry>;
	complete: boolean;
	limitations: string[];
	contentDigest: string | null;
}

/** What the comparison may still read and hash, shared by both sides. */
interface Budget {
	read: number;
	hash: number;
}

/** Structure of one side of a comparison. */
export function createCompareArtifactsTool(cwd: string): AnyTool {
	return buildTool({
		name: "CompareArtifacts",
		description:
			"Compares two files, directories, zip-family archives, or ASAR archives by logical path and content. " +
			"Files are hashed with SHA-256; archive entries are decompressed in memory to hash them and are never " +
			"extracted; symlinks are compared by target and not followed. The report gives unchanged, added, " +
			"removed, changed and unknown counts, an aggregate content digest per side when the comparison is " +
			"complete, and every limitation that made it partial. Use it to answer whether two packages are the " +
			"same build, and which files differ.",
		inputSchema: z.object({
			left: z.string().describe("Left path: a file, a directory, a zip-family archive, or an ASAR"),
			right: z.string().describe("Right path: a file, a directory, a zip-family archive, or an ASAR"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			const resolved: { left?: string; right?: string } = {};
			for (const side of ["left", "right"] as const) {
				try {
					resolved[side] = guardPathContainment(input[side], cwd, "CompareArtifacts");
				} catch (error) {
					return failure(message(error));
				}
			}
			const left = resolved.left as string;
			const right = resolved.right as string;
			for (const [side, path] of [
				["left", left],
				["right", right],
			] as const) {
				let info: Awaited<ReturnType<typeof stat>>;
				try {
					info = await stat(path);
				} catch (error) {
					return failure(
						`CompareArtifacts: ${side} ${input[side]}: ${describeFsFailure(error, input[side], "inspect")}`,
					);
				}
				if (!info.isFile() && !info.isDirectory()) {
					return failure(`CompareArtifacts: ${side} ${input[side]} is neither a regular file nor a directory.`);
				}
			}

			const budget: Budget = { read: MAX_TOTAL_READ_BYTES, hash: MAX_TOTAL_HASH_BYTES };
			let leftSide: SideInventory;
			let rightSide: SideInventory;
			try {
				leftSide = await inventory(left, input.left, budget);
				rightSide = await inventory(right, input.right, budget);
			} catch (error) {
				return failure(`CompareArtifacts: ${message(error)}`);
			}
			return ok(capReport(report(leftSide, rightSide)));
		},
	});
}

/** Read one side into logical paths and content digests. */
async function inventory(source: string, display: string, budget: Budget): Promise<SideInventory> {
	const info = await stat(source);
	if (info.isDirectory()) return directoryInventory(source, display, budget);
	const head = await readRange(Bun.file(source), 0, Math.min(PROBE_BYTES_READ, info.size));
	const kind = identify(head, info.size);
	if (kind === "zip") return zipInventory(Bun.file(source), info.size, display, budget);
	if (kind === "asar") return asarInventory(Bun.file(source), info.size, display, budget);
	return plainFileInventory(source, info.size, display, budget);
}

/** A single file, whose logical name is its base name. */
async function plainFileInventory(
	source: string,
	size: number,
	display: string,
	budget: Budget,
): Promise<SideInventory> {
	const entries = new Map<string, ComparedEntry>();
	const limitations: string[] = [];
	let complete = true;
	const name = basename(source);
	if (size > MAX_ENTRY_BYTES) {
		entries.set(name, { kind: "file", size, digest: null, note: `larger than the ${MAX_ENTRY_BYTES}-byte entry cap` });
		complete = false;
		limitations.push(
			`the file is ${size} bytes, past the ${MAX_ENTRY_BYTES}-byte entry cap; its content was not hashed`,
		);
	} else if (budget.read < size || budget.hash < size) {
		entries.set(name, {
			kind: "file",
			size,
			digest: null,
			note: "the comparison's read or hashing budget is exhausted",
		});
		complete = false;
		limitations.push("the comparison's read or hashing budget was exhausted before this file");
	} else {
		try {
			const digest = await hashRegularFile(source, budget);
			entries.set(name, { kind: "file", size, digest, note: null });
		} catch (error) {
			entries.set(name, { kind: "file", size, digest: null, note: message(error) });
			complete = false;
			limitations.push(`the file could not be read: ${message(error)}`);
		}
	}
	return {
		display,
		format: "file",
		entries,
		complete,
		limitations,
		contentDigest: aggregateDigest(entries, complete),
	};
}

/** A directory tree: directories are structure, links are targets, files are bytes. */
async function directoryInventory(source: string, display: string, budget: Budget): Promise<SideInventory> {
	const entries = new Map<string, ComparedEntry>();
	const limitations: string[] = [];
	let complete = true;
	let stopped = false;

	const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
		if (stopped) return;
		if (depth > MAX_DIRECTORY_DEPTH) {
			complete = false;
			limitations.push(
				`the directory tree goes deeper than ${MAX_DIRECTORY_DEPTH} levels; deeper entries were not read`,
			);
			stopped = true;
			return;
		}
		let children: Dirent[];
		try {
			children = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			complete = false;
			limitations.push(
				`a directory could not be listed (${printable(prefix === "" ? "." : prefix)}): ${message(error)}`,
			);
			return;
		}
		children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const child of children) {
			if (stopped) return;
			if (entries.size >= MAX_ENTRIES_PER_SIDE) {
				complete = false;
				limitations.push(`the comparison stops at ${MAX_ENTRIES_PER_SIDE} files per side`);
				stopped = true;
				return;
			}
			const logical = prefix === "" ? child.name : `${prefix}/${child.name}`;
			const full = join(dir, child.name);
			if (child.isDirectory()) {
				await walk(full, logical, depth + 1);
				continue;
			}
			if (child.isSymbolicLink()) {
				try {
					const target = await readlink(full);
					entries.set(logical, {
						kind: "link",
						size: Buffer.byteLength(target),
						digest: sha256Hex(new TextEncoder().encode(target)),
						note: null,
					});
				} catch (error) {
					entries.set(logical, { kind: "link", size: 0, digest: null, note: message(error) });
					complete = false;
					limitations.push(`a link could not be read (${printable(logical)}): ${message(error)}`);
				}
				continue;
			}
			if (!child.isFile()) {
				complete = false;
				limitations.push(`a non-file entry was skipped (${printable(logical)})`);
				continue;
			}
			let size: number;
			try {
				size = (await stat(full)).size;
			} catch (error) {
				entries.set(logical, { kind: "file", size: 0, digest: null, note: message(error) });
				complete = false;
				limitations.push(`a file could not be inspected (${printable(logical)}): ${message(error)}`);
				continue;
			}
			if (size > MAX_ENTRY_BYTES) {
				entries.set(logical, {
					kind: "file",
					size,
					digest: null,
					note: `larger than the ${MAX_ENTRY_BYTES}-byte entry cap`,
				});
				complete = false;
				limitations.push(`a file is past the ${MAX_ENTRY_BYTES}-byte entry cap (${printable(logical)})`);
				continue;
			}
			if (budget.read < size || budget.hash < size) {
				entries.set(logical, {
					kind: "file",
					size,
					digest: null,
					note: "the comparison's read or hashing budget is exhausted",
				});
				complete = false;
				limitations.push("the comparison's read or hashing budget was exhausted before the tree was finished");
				stopped = true;
				return;
			}
			try {
				const digest = await hashRegularFile(full, budget);
				entries.set(logical, { kind: "file", size, digest, note: null });
			} catch (error) {
				entries.set(logical, { kind: "file", size, digest: null, note: message(error) });
				complete = false;
				limitations.push(`a file could not be read (${printable(logical)}): ${message(error)}`);
			}
		}
	};

	await walk(source, "", 1);
	return {
		display,
		format: "directory",
		entries,
		complete,
		limitations,
		contentDigest: aggregateDigest(entries, complete),
	};
}

/** A zip-family archive read through its central directory. */
async function zipInventory(file: ArchiveFile, size: number, display: string, budget: Budget): Promise<SideInventory> {
	const parsed = await readZipDirectory(file, size, MAX_ENTRIES_PER_SIDE);
	const entries = new Map<string, ComparedEntry>();
	const limitations = [...parsed.notes];
	let complete = true;
	if (parsed.truncated) complete = false;
	if (parsed.count > MAX_ENTRIES_PER_SIDE) {
		complete = false;
		limitations.push(`the archive holds ${parsed.count} entries; the comparison stops at ${MAX_ENTRIES_PER_SIDE}`);
	}
	if (parsed.duplicateNames.length > 0) {
		limitations.push(
			`${parsed.duplicateNames.length} name(s) appear more than once in the archive; those paths are unknown rather than merged`,
		);
	}
	const duplicates = new Set(parsed.duplicateNames);
	const seen = new Set<string>();
	for (const entry of parsed.entries) {
		const logical = entry.name.split("\\").join("/");
		if (logical.endsWith("/")) continue;
		if (seen.has(logical) || duplicates.has(entry.name)) {
			entries.set(logical, {
				kind: "file",
				size: entry.uncompressed,
				digest: null,
				note: seen.has(logical)
					? "two archive entries normalize to this path"
					: "the archive holds this name more than once",
			});
			continue;
		}
		seen.add(logical);
		if ((entry.flags & 1) !== 0) {
			entries.set(logical, { kind: "file", size: entry.uncompressed, digest: null, note: "the entry is encrypted" });
			continue;
		}
		if (entry.method !== 0 && entry.method !== 8) {
			entries.set(logical, {
				kind: "file",
				size: entry.uncompressed,
				digest: null,
				note: `compression method ${entry.method} is not supported`,
			});
			continue;
		}
		if (entry.uncompressed > MAX_ENTRY_BYTES || entry.compressed > MAX_ENTRY_BYTES) {
			entries.set(logical, {
				kind: "file",
				size: entry.uncompressed,
				digest: null,
				note: `larger than the ${MAX_ENTRY_BYTES}-byte entry cap`,
			});
			continue;
		}
		if (budget.read < entry.compressed || budget.hash < entry.uncompressed) {
			entries.set(logical, {
				kind: "file",
				size: entry.uncompressed,
				digest: null,
				note: "the comparison's read or hashing budget is exhausted",
			});
			complete = false;
			limitations.push("the comparison's read or hashing budget was exhausted before the archive was finished");
			break;
		}
		budget.read -= entry.compressed;
		try {
			const data = await readZipEntry(file, size, entry, MAX_ENTRY_BYTES);
			budget.hash -= data.length;
			entries.set(logical, { kind: "file", size: data.length, digest: sha256Hex(data), note: null });
		} catch (error) {
			entries.set(logical, { kind: "file", size: entry.uncompressed, digest: null, note: message(error) });
		}
	}
	const unreadable = [...entries.values()].filter((entry) => entry.digest === null).length;
	if (unreadable > 0) {
		limitations.push(
			`${unreadable} archive entr${unreadable === 1 ? "y" : "ies"} could not be hashed; they are reported as unknown`,
		);
	}
	return {
		display,
		format: "zip",
		entries,
		complete,
		limitations,
		contentDigest: aggregateDigest(entries, complete),
	};
}

/** An ASAR read through its JSON header. */
async function asarInventory(file: ArchiveFile, size: number, display: string, budget: Budget): Promise<SideInventory> {
	const header = await readAsarHeader(file, size);
	const nodes: AsarNode[] = [];
	let capped = false;
	const walk = walkAsar(header.files, (node) => {
		if (node.kind === "directory") return;
		if (nodes.length >= MAX_ENTRIES_PER_SIDE) {
			capped = true;
			return;
		}
		nodes.push(
			node.kind === "link"
				? { path: node.path, size: null, offset: null, unpacked: false, link: node.link }
				: { path: node.path, size: node.size, offset: node.offset, unpacked: node.unpacked, link: null },
		);
	});
	const limitations: string[] = [];
	let complete = true;
	if (walk.depthCapped) {
		complete = false;
		limitations.push("the ASAR tree goes deeper than the header walk follows; deeper entries were not read");
	}
	if (walk.malformed > 0) {
		complete = false;
		limitations.push(
			`${walk.malformed} ASAR header node(s) are neither a file, a directory, nor a link; they are not compared`,
		);
	}
	if (capped || walk.fileCount > MAX_ENTRIES_PER_SIDE) {
		complete = false;
		limitations.push(`the ASAR holds ${walk.fileCount} file entries; the comparison stops at ${MAX_ENTRIES_PER_SIDE}`);
	}
	const entries = new Map<string, ComparedEntry>();
	for (const node of nodes) {
		if (node.link !== null) {
			entries.set(node.path, {
				kind: "link",
				size: Buffer.byteLength(node.link),
				digest: sha256Hex(new TextEncoder().encode(node.link)),
				note: null,
			});
			continue;
		}
		if (node.unpacked) {
			entries.set(node.path, {
				kind: "file",
				size: node.size ?? 0,
				digest: null,
				note: "the entry is unpacked outside the archive",
			});
			continue;
		}
		if (node.size === null) {
			entries.set(node.path, { kind: "file", size: 0, digest: null, note: "the header does not state the size" });
			continue;
		}
		if (node.size > MAX_ENTRY_BYTES) {
			entries.set(node.path, {
				kind: "file",
				size: node.size,
				digest: null,
				note: `larger than the ${MAX_ENTRY_BYTES}-byte entry cap`,
			});
			continue;
		}
		if (budget.read < node.size || budget.hash < node.size) {
			entries.set(node.path, {
				kind: "file",
				size: node.size,
				digest: null,
				note: "the comparison's read or hashing budget is exhausted",
			});
			complete = false;
			limitations.push("the comparison's read or hashing budget was exhausted before the archive was finished");
			break;
		}
		budget.read -= node.size;
		try {
			const data = await readAsarEntry(file, header.headerEnd, node, MAX_ENTRY_BYTES);
			budget.hash -= data.length;
			entries.set(node.path, { kind: "file", size: data.length, digest: sha256Hex(data), note: null });
		} catch (error) {
			entries.set(node.path, { kind: "file", size: node.size, digest: null, note: message(error) });
		}
	}
	const unreadable = [...entries.values()].filter((entry) => entry.digest === null).length;
	if (unreadable > 0) {
		limitations.push(
			`${unreadable} ASAR entr${unreadable === 1 ? "y" : "ies"} could not be hashed; they are reported as unknown`,
		);
	}
	return {
		display,
		format: "asar",
		entries,
		complete,
		limitations,
		contentDigest: aggregateDigest(entries, complete),
	};
}

/**
 * SHA-256 of one regular file, streamed with a no-follow open where the
 * platform offers one.
 *
 * Both budgets are spent as the bytes arrive, not from the size a stat
 * reported earlier: a file that grows while it is read must not spend more
 * than the comparison allows, and the cap is enforced on what was actually
 * read.
 */
async function hashRegularFile(path: string, budget: Budget): Promise<string> {
	const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("not a regular file");
		if (info.size > MAX_ENTRY_BYTES) throw new Error(`larger than the ${MAX_ENTRY_BYTES}-byte entry cap`);
		const hasher = new Bun.CryptoHasher("sha256");
		let read = 0;
		for await (const chunk of handle.createReadStream({ autoClose: false })) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			read += bytes.length;
			if (read > MAX_ENTRY_BYTES) throw new Error(`grew past the ${MAX_ENTRY_BYTES}-byte entry cap while being read`);
			if (budget.read < bytes.length || budget.hash < bytes.length) {
				throw new Error("the comparison's read or hashing budget is exhausted");
			}
			budget.read -= bytes.length;
			budget.hash -= bytes.length;
			hasher.update(bytes);
		}
		return hasher.digest("hex");
	} finally {
		await handle.close();
	}
}

/** SHA-256 over sorted logical paths and their content identities. */
function aggregateDigest(entries: Map<string, ComparedEntry>, complete: boolean): string | null {
	if (!complete) return null;
	const hasher = new Bun.CryptoHasher("sha256");
	const paths = [...entries.keys()].sort();
	for (const path of paths) {
		const entry = entries.get(path) as ComparedEntry;
		if (entry.digest === null) return null;
		// Length-prefixed fields make the stream unambiguous without a control
		// byte: a path that contains a newline cannot impersonate a second record.
		hasher.update(`${path.length}:${path}\n${entry.kind}\n${entry.digest}\n`);
	}
	return hasher.digest("hex");
}

function report(left: SideInventory, right: SideInventory): string {
	const paths = [...new Set([...left.entries.keys(), ...right.entries.keys()])].sort();
	const counts = { unchanged: 0, added: 0, removed: 0, changed: 0, unknown: 0 };
	const changes: string[] = [];
	let listed = 0;
	const addChange = (line: string): void => {
		if (listed < MAX_LISTED_CHANGES) changes.push(line);
		listed += 1;
	};
	let comparable = 0;
	for (const path of paths) {
		const a = left.entries.get(path);
		const b = right.entries.get(path);
		if (a === undefined) {
			counts.added += 1;
			addChange(oneSided("+", path, b as ComparedEntry));
			continue;
		}
		if (b === undefined) {
			counts.removed += 1;
			addChange(oneSided("-", path, a));
			continue;
		}
		if (a.digest === null || b.digest === null) {
			counts.unknown += 1;
			const notes = [a.note, b.note].filter((note): note is string => note !== null);
			addChange(`? ${printable(path)}: ${notes.length === 0 ? "content could not be read" : notes.join("; ")}`);
			continue;
		}
		comparable += 1;
		const parts: string[] = [];
		if (a.kind !== b.kind) parts.push(`kind ${a.kind} -> ${b.kind}`);
		if (a.size !== b.size) parts.push(`size ${a.size} -> ${b.size}`);
		if (a.digest !== b.digest) parts.push(`${shortDigest(a.digest)} -> ${shortDigest(b.digest)}`);
		if (parts.length === 0) {
			counts.unchanged += 1;
			continue;
		}
		counts.changed += 1;
		addChange(`~ ${printable(path)}: ${parts.join("; ")}`);
	}

	const differences = counts.changed + counts.added + counts.removed;
	let status: "unchanged" | "changed" | "partial" | "unknown";
	if (left.complete && right.complete && counts.unknown === 0) {
		status = differences > 0 ? "changed" : "unchanged";
	} else if (comparable === 0) {
		status = "unknown";
	} else {
		status = "partial";
	}

	const lines = [
		`CompareArtifacts report for ${printable(left.display)} vs ${printable(right.display)}`,
		`left: ${printable(left.display)} (${left.format}, ${left.entries.size} file(s), ${digestText(left.contentDigest)})`,
		`right: ${printable(right.display)} (${right.format}, ${right.entries.size} file(s), ${digestText(right.contentDigest)})`,
		`compared paths: ${paths.length}`,
		`unchanged: ${counts.unchanged}`,
		`added: ${counts.added}`,
		`removed: ${counts.removed}`,
		`changed: ${counts.changed}`,
		`unknown: ${counts.unknown}`,
		`status: ${status}`,
	];
	if (listed === 0) {
		lines.push("changes: none");
	} else {
		lines.push("changes:");
		for (const change of changes) lines.push(`  ${change}`);
		if (listed > changes.length) {
			lines.push(
				`  ... ${listed - changes.length} more change(s) not listed (the list stops at ${MAX_LISTED_CHANGES})`,
			);
		}
	}
	lines.push(
		"read scope: both sides were opened read-only; archive entries were decompressed in memory to hash them; nothing was extracted or written; per-path hashes are 12-hex SHA-256 prefixes",
	);
	const limitations = [
		...left.limitations.map((note) => `left: ${note}`),
		...right.limitations.map((note) => `right: ${note}`),
	];
	for (const limitation of [...new Set(limitations)]) lines.push(`limitation: ${limitation}`);
	return lines.join("\n");
}

function oneSided(marker: "+" | "-", path: string, entry: ComparedEntry): string {
	if (entry.digest === null) return `${marker} ${printable(path)} (content unknown: ${entry.note ?? "not readable"})`;
	return `${marker} ${printable(path)} (${entry.size} B, ${shortDigest(entry.digest)})`;
}

function shortDigest(digest: string): string {
	return `sha256:${digest.slice(0, DISPLAY_HASH_CHARS)}`;
}

function digestText(digest: string | null): string {
	return digest === null ? "content digest not computed" : `content digest sha256:${digest}`;
}

function sha256Hex(data: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(data);
	return hasher.digest("hex");
}

/** The report up to `MAX_REPORT_CHARS`, with the usual marker naming what was cut. */
function capReport(text: string): string {
	if (text.length <= MAX_REPORT_CHARS) return text;
	return `${text.slice(0, MAX_REPORT_CHARS)}\n${formatCutMarker(text.length - MAX_REPORT_CHARS)}`;
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function failure(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true as const };
}
