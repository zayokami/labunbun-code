/**
 * File list for the prompt's @-mention completion.
 *
 * The walk is cached for a few seconds because it fires per keystroke; a
 * project of any size cannot be re-walked that often. The cache is busted when
 * an agent turn ends — that is exactly when files may have been created or
 * deleted by tool calls, and the next user turn deserves a fresh view.
 */

import * as fs from "node:fs/promises";
import { relative } from "node:path";
import { type FileWalkerOps, walkProjectFiles } from "@labunbun/tools";

export interface FileCompleter {
	(query: string): Promise<string[]>;
	/** Drop the cached listing so the next call re-walks. */
	bust(): void;
}

export function createFileCompleter(cwd: string, opts: { ttlMs?: number; max?: number } = {}): FileCompleter {
	const ttlMs = opts.ttlMs ?? 5_000;
	const max = opts.max ?? 2_000;
	let cache: { at: number; files: string[] } | null = null;
	let inflight: Promise<string[]> | null = null;

	async function list(): Promise<string[]> {
		if (cache && Date.now() - cache.at < ttlMs) return cache.files;
		if (!inflight) {
			inflight = walkProjectFiles(cwd, fsOps, {}).then((files) => {
				// The walker returns absolute paths; relative forward-slash ones read
				// better in a prompt, and the Read tool accepts them from cwd anyway.
				cache = {
					at: Date.now(),
					files: files.slice(0, max).map((f) => relative(cwd, f).split("\\").join("/")),
				};
				inflight = null;
				return cache.files;
			});
		}
		return inflight;
	}

	const completer: FileCompleter = Object.assign(async () => list(), {
		bust: () => {
			cache = null;
		},
	});

	return completer;
}

/**
 * The walker only needs readdir/stat. Structural typing lets these plain fs
 * wrappers stand in for full Operations without dragging shell resolution in.
 */
const fsOps: FileWalkerOps = {
	readdir: async (path) =>
		(await fs.readdir(path, { withFileTypes: true })).map((d) => ({
			name: d.name,
			isDirectory: d.isDirectory(),
		})),
	stat: async (path) => await fs.stat(path),
};
