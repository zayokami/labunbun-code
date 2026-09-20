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

/**
 * The argument list of every call to `name`, as text.
 *
 * A regex per function (`foo\([^,)]+\)`) cannot tell `foo(a)` from `foo(nested(x), home)`:
 * it stops at the first `)` it meets, whether or not that closes the call. These
 * guards are the reason a test would not write to the operator's home, so they
 * are worth scanning properly rather than approximately.
 */
function callArguments(source: string, name: string): string[] {
	const pattern = new RegExp(`${name.replace(".", "\\.")}\\(`, "g");
	const calls: string[] = [];
	for (const match of source.matchAll(pattern)) {
		const start = (match.index ?? 0) + match[0].length;
		let depth = 1;
		for (let i = start; i < source.length; i++) {
			const char = source[i];
			if (char === "(") depth++;
			else if (char === ")") {
				depth--;
				if (depth === 0) {
					calls.push(source.slice(start, i));
					break;
				}
			}
		}
	}
	return calls;
}

/** Whether the argument list holds at least `count` arguments at its own depth. */
function argumentCount(args: string): number {
	let depth = 0;
	let commas = 0;
	for (const char of args) {
		if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") depth--;
		else if (char === "," && depth === 0) commas++;
	}
	return args.trim() === "" ? 0 : commas + 1;
}

/** How many calls to `name` pass fewer than `min` arguments. */
function callersWithTooFewArguments(source: string, name: string, min: number): number {
	return callArguments(code(source), name).filter((args) => argumentCount(args) < min).length;
}

describe("test suite isolation", () => {
	test("finds the test files it is scanning", () => {
		// A broken glob would make every assertion below vacuous.
		expect(FILES.length).toBeGreaterThan(30);
	});

	test("the scan can see past a nested call", () => {
		// Guards the guards: `startNew(pick(cwd), home)` has two arguments, and
		// `startNew(pick(cwd))` has one that a paren-blind regex reads as two.
		// The samples are assembled rather than written out, because a sample that
		// reads as a call site is one this file's own scan would find.
		const name = "SessionStore.startNew";
		expect(callArguments(`x = ${name}(pick(a, b), home)`, name)).toEqual(["pick(a, b), home"]);
		expect(callArguments(`x = ${name}(pick(a, b))`, name)).toHaveLength(1);
		expect(argumentCount("pick(a, b), home")).toBe(2);
		expect(argumentCount("pick(a, b)")).toBe(1);
		// The predicate the guards below are built on, on both sides of the line.
		expect(callersWithTooFewArguments(`${name}(cwd)`, name, 2)).toBe(1);
		expect(callersWithTooFewArguments(`${name}(pick(cwd))`, name, 2)).toBe(1);
		expect(callersWithTooFewArguments(`${name}(pick(cwd), home)`, name, 2)).toBe(0);
	});

	// `SessionStore.startNew(cwd)` writes to ~/.labunbun/projects/<cwd>/. The
	// second argument is the home override.
	test("no test starts a session store without a home override", () => {
		const offenders = FILES.filter(
			({ source }) => callersWithTooFewArguments(source, "SessionStore.startNew", 2) > 0,
		).map((f) => f.name);
		expect(offenders, "pass a temp home as the second argument to SessionStore.startNew").toEqual([]);
	});

	// `appendHistory(text, cwd)` appends to the real ~/.labunbun/history.jsonl.
	test("no test appends prompt history without a home override", () => {
		const offenders = FILES.filter(({ source }) => callersWithTooFewArguments(source, "appendHistory", 3) > 0).map(
			(f) => f.name,
		);
		expect(offenders, "pass a temp home as the third argument to appendHistory").toEqual([]);
	});

	// Spilled tool output lands in ~/.labunbun/projects/<cwd>/tool-output/.
	test("no test spills tool output without a home override", () => {
		const offenders = FILES.filter(({ source }) => {
			const body = code(source);
			return (
				(callArguments(body, "writeToolOutput").length > 0 || callArguments(body, "pruneToolOutput").length > 0) &&
				!body.includes("home")
			);
		}).map((f) => f.name);
		expect(offenders, "pass a temp home in the options of writeToolOutput/pruneToolOutput").toEqual([]);
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
