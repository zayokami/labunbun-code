/**
 * Test isolation: no test may write to the real user home.
 *
 * Every module that persists state resolves its path from a home directory that
 * defaults to `homedir()`. A test that constructs one without passing a temp home
 * writes into the operator's own `~/.labunbun` — appending to their prompt history
 * or leaving a project directory behind on every run. That is invisible in a
 * passing suite, which is why it is asserted here rather than left to review.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIRS = [
	join(import.meta.dir, "..", "..", "agent", "test"),
	join(import.meta.dir, "..", "..", "ai", "test"),
	join(import.meta.dir, "..", "..", "mcp", "test"),
	join(import.meta.dir, "..", "..", "tools", "test"),
	join(import.meta.dir, "..", "..", "tui", "test"),
	import.meta.dir,
];

/** Every test file in the repo, as `{ path, source }`. */
function testFiles(): Array<{ name: string; source: string }> {
	const out: Array<{ name: string; source: string }> = [];
	for (const dir of TEST_DIRS) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) continue;
			out.push({ name: `${dir.split(/[/\\]/).at(-2)}/${entry}`, source: readFileSync(join(dir, entry), "utf8") });
		}
	}
	return out;
}

const FILES = testFiles();

/** Strip comments so a call named in prose does not read as a call site. */
function code(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("test suite isolation", () => {
	test("finds the test files it is scanning", () => {
		// A broken glob would make every assertion below vacuous.
		expect(FILES.length).toBeGreaterThan(30);
	});

	// `SessionStore.startNew(cwd)` writes to ~/.labunbun/projects/<cwd>/. The
	// second argument is the home override.
	test("no test starts a session store without a home override", () => {
		const offenders = FILES.filter(({ source }) => /SessionStore\.startNew\(\s*[^,)]+\s*\)/.test(code(source))).map(
			(f) => f.name,
		);
		expect(offenders, "pass a temp home as the second argument to SessionStore.startNew").toEqual([]);
	});

	// `appendHistory(text, cwd)` appends to the real ~/.labunbun/history.jsonl.
	test("no test appends prompt history without a home override", () => {
		const offenders = FILES.filter(({ source }) => /appendHistory\(\s*[^,)]+,\s*[^,)]+\s*\)/.test(code(source))).map(
			(f) => f.name,
		);
		expect(offenders, "pass a temp home as the third argument to appendHistory").toEqual([]);
	});

	// `new CostTracker(cwd)` resolves homedir() in its constructor, so it needs
	// the env override rather than an argument.
	test("every test constructing a cost tracker with a cwd also overrides HOME", () => {
		const offenders = FILES.filter(({ source }) => {
			const body = code(source);
			return /new CostTracker\(\s*[^)\s]/.test(body) && !body.includes("process.env.HOME");
		}).map((f) => f.name);
		expect(offenders, "set process.env.HOME to a temp dir around CostTracker(cwd)").toEqual([]);
	});
});
