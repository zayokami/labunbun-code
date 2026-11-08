/**
 * The watcher behind the repository map's prompt section.
 *
 * Every assertion here needs a real filesystem event, so each test runs against
 * a throwaway directory. A platform that refuses a recursive watch is a
 * supported shape, not a failure: the handle says `watching: false` and the
 * tests skip, the same way the map keeps working without the watcher.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchRepoMap } from "../src/repomap-watch.ts";

const roots: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-repomap-watch-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Whether this machine's filesystem satisfies the one assumption below. */
const RECURSIVE_WATCH = (() => {
	const dir = tempRoot();
	const handle = watchRepoMap({ root: dir, onChange: () => {} });
	const supported = handle.watching;
	handle.close();
	return supported;
})();

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) await wait(20);
}

describe("watchRepoMap", () => {
	test.skipIf(!RECURSIVE_WATCH)("reports a code file saved below the root", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "src"));
		const batches: string[][] = [];
		const handle = watchRepoMap({ root, debounceMs: 40, onChange: (paths) => batches.push(paths) });
		try {
			writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
			await waitFor(() => batches.some((paths) => paths.includes(join(root, "src", "a.ts"))));
			expect(batches.some((paths) => paths.includes(join(root, "src", "a.ts")))).toBe(true);
		} finally {
			handle.close();
		}
	});

	test.skipIf(!RECURSIVE_WATCH)("ignores files the map would not read", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
		const batches: string[][] = [];
		const handle = watchRepoMap({ root, debounceMs: 40, onChange: (paths) => batches.push(paths) });
		try {
			writeFileSync(join(root, "node_modules", "pkg", "index.ts"), "export const hidden = 1;\n");
			writeFileSync(join(root, "notes.md"), "# not a map file\n");
			// Longer than the debounce window, so a report of either path would
			// already have arrived.
			await wait(200);
			expect(batches).toEqual([]);

			// A code file the map does read proves the filter let it through rather
			// than the watch itself being dead.
			writeFileSync(join(root, "kept.ts"), "export const kept = 1;\n");
			await waitFor(() => batches.some((paths) => paths.includes(join(root, "kept.ts"))));
			expect(batches.flat()).toContain(join(root, "kept.ts"));
		} finally {
			handle.close();
		}
	});

	test.skipIf(!RECURSIVE_WATCH)("reports a directory move, whose name no code glob can match", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
		const batches: string[][] = [];
		const handle = watchRepoMap({ root, debounceMs: 40, onChange: (paths) => batches.push(paths) });
		try {
			// A save proves the watch is armed before the move is made: a rename
			// issued in the instant after `watch()` returns races the OS watcher
			// that is still being set up, and the event can be lost.
			writeFileSync(join(root, "probe.ts"), "export const probe = 1;\n");
			await waitFor(() => batches.some((paths) => paths.includes(join(root, "probe.ts"))));
			const before = batches.length;
			// `fs.watch` reports this as the directory `src` (or `lib`), never as the
			// file that moved with it; the section would otherwise keep naming
			// `src/a.ts` until some code file was saved.
			renameSync(join(root, "src"), join(root, "lib"));
			await waitFor(() => batches.length > before);
			expect(batches.length).toBeGreaterThan(before);
		} finally {
			handle.close();
		}
	});

	test.skipIf(!RECURSIVE_WATCH)("coalesces a burst into one report", async () => {
		const root = tempRoot();
		const batches: string[][] = [];
		// Generous enough that all three synchronous writes land inside one window
		// even on a loaded runner; the property under test is the coalescing, not
		// how quickly the platform delivers an event.
		const handle = watchRepoMap({ root, debounceMs: 120, onChange: (paths) => batches.push(paths) });
		try {
			const files = ["a.ts", "b.ts", "c.ts"].map((name) => join(root, name));
			for (const file of files) writeFileSync(file, "export const n = 1;\n");
			await waitFor(() => batches.some((paths) => files.every((file) => paths.includes(file))));
			const batch = batches.find((paths) => files.every((file) => paths.includes(file)));
			expect(batch).toBeDefined();
			expect(batches).toHaveLength(1);
		} finally {
			handle.close();
		}
	});

	test.skipIf(!RECURSIVE_WATCH)("a closed watch stops reporting", async () => {
		const root = tempRoot();
		const batches: string[][] = [];
		const handle = watchRepoMap({ root, debounceMs: 40, onChange: (paths) => batches.push(paths) });
		handle.close();
		writeFileSync(join(root, "after.ts"), "export const after = 1;\n");
		await wait(200);
		expect(batches).toEqual([]);
	});

	test.skipIf(RECURSIVE_WATCH)("an unsupported platform reports nothing and does not throw", () => {
		const handle = watchRepoMap({ root: tempRoot(), onChange: () => {} });
		expect(handle.watching).toBe(false);
		handle.close();
	});
});
