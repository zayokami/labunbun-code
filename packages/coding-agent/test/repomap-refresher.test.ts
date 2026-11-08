/**
 * The prompt-section refresher the REPL and ACP share.
 *
 * A real filesystem event is what marks the section stale, so each test runs
 * against a throwaway tree. The rebuild itself is the service's own scan; what
 * is under test here is the policy around it — only a change to the text is
 * applied, a host that read the tree itself can forget a report, and a closed
 * refresher stops following the tree.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeFileSystemOperations, RepoMapService, watchRepoMap } from "@labunbun/tools";
import { repoMapWatchFailureNotice, watchRepoMapPromptSection } from "../src/repomap-wiring.ts";

const ops = new NodeFileSystemOperations();
const roots: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-repomap-refresh-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, text: string): void {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

const RECURSIVE_WATCH = (() => {
	const dir = tempRoot();
	const handle = watchRepoMap({ root: dir, onChange: () => {} });
	const supported = handle.watching;
	handle.close();
	return supported;
})();

/**
 * Call the refresher until `check` holds. Every call is after a pause long
 * enough for the watcher's own window to close, so the loop is about event
 * delivery rather than about guessing the debounce.
 */
async function settle(refresh: () => Promise<void>, check: () => boolean, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 80));
		await refresh();
	}
}

describe("watchRepoMapPromptSection", () => {
	test.skipIf(!RECURSIVE_WATCH)("applies a section only when a save changed its text", async () => {
		const root = tempRoot();
		write(root, "src/a.ts", "export function alpha() {\n\treturn 1;\n}\n");
		const service = new RepoMapService({ root, ops });
		let current = (await service.promptSection())?.text;
		expect(current).toContain("alpha");
		const applied: Array<string | undefined> = [];
		const refresher = watchRepoMapPromptSection({
			root,
			service,
			current: () => current,
			apply: (text) => {
				applied.push(text);
				current = text;
			},
		});
		try {
			write(root, "src/b.ts", "export function beta() {\n\treturn 2;\n}\n");
			await settle(
				() => refresher.refreshIfStale(),
				() => applied.length > 0,
			);
			expect(applied).toHaveLength(1);
			expect(applied[0]).toContain("beta");
			expect(current).toContain("beta");

			// The cache and the tree agree now; another call must not churn the
			// prompt for a save that changed nothing the map shows.
			await refresher.refreshIfStale();
			expect(applied).toHaveLength(1);
		} finally {
			refresher.close();
		}
	});

	test.skipIf(!RECURSIVE_WATCH)("reset forgets a report the host already answered", async () => {
		const root = tempRoot();
		write(root, "src/a.ts", "export function alpha() {\n\treturn 1;\n}\n");
		const service = new RepoMapService({ root, ops });
		let current = (await service.promptSection())?.text;
		const applied: Array<string | undefined> = [];
		const refresher = watchRepoMapPromptSection({
			root,
			service,
			current: () => current,
			apply: (text) => {
				applied.push(text);
				current = text;
			},
		});
		try {
			write(root, "src/b.ts", "export function beta() {\n\treturn 2;\n}\n");
			// Longer than the watcher's window, so the report has landed by now.
			await settle(
				() => Promise.resolve(),
				() => false,
				700,
			);
			// The tree was read by the host itself (`/map-refresh`) after the save.
			refresher.reset();
			await refresher.refreshIfStale();
			expect(applied).toEqual([]);
		} finally {
			refresher.close();
		}
	});

	test.skipIf(!RECURSIVE_WATCH)("a closed refresher stops following the tree", async () => {
		const root = tempRoot();
		write(root, "src/a.ts", "export function alpha() {\n\treturn 1;\n}\n");
		const service = new RepoMapService({ root, ops });
		let current = (await service.promptSection())?.text;
		const applied: Array<string | undefined> = [];
		const refresher = watchRepoMapPromptSection({
			root,
			service,
			current: () => current,
			apply: (text) => {
				applied.push(text);
				current = text;
			},
		});
		refresher.close();
		write(root, "src/b.ts", "export function beta() {\n\treturn 2;\n}\n");
		await settle(
			() => refresher.refreshIfStale(),
			() => applied.length > 0,
			800,
		);
		expect(applied).toEqual([]);
	});
});

describe("repoMapWatchFailureNotice", () => {
	test("names the reason in one line", () => {
		const error = new Error("EMFILE: inotify watch limit reached\nat watch (node:fs)");
		const notice = repoMapWatchFailureNotice(error);
		expect(notice).toBe("Repository map: watching for changes stopped (EMFILE: inotify watch limit reached).");
		expect(notice).not.toContain("\n");
	});

	test("stringifies a non-Error", () => {
		expect(repoMapWatchFailureNotice("share unmounted")).toBe(
			"Repository map: watching for changes stopped (share unmounted).",
		);
	});
});
