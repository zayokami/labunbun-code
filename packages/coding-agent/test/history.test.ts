/**
 * Prompt history: the file behind ↑ recall.
 *
 * Every test passes an explicit home. The default is the user's real
 * ~/.labunbun/history.jsonl, so a test that omits it appends its fixtures to the
 * operator's own prompt history and never cleans up.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, type HistoryEntry, historyFilePath, loadHistory } from "../src/history.ts";

function tmpHome(): string {
	return mkdtempSync(join(tmpdir(), "lbb-history-"));
}

describe("historyFilePath", () => {
	test("sits under the config directory of the given home", () => {
		expect(historyFilePath("/home/someone")).toBe(join("/home/someone", ".labunbun", "history.jsonl"));
	});
});

describe("appendHistory", () => {
	test("writes one JSON object per line, tagged with cwd and a timestamp", () => {
		const home = tmpHome();
		appendHistory("hello", "/project", home);
		const lines = readFileSync(historyFilePath(home), "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as HistoryEntry;
		expect(entry.text).toBe("hello");
		expect(entry.cwd).toBe("/project");
		expect(typeof entry.timestamp).toBe("number");
	});

	test("creates the config directory when it does not exist yet", () => {
		const home = tmpHome();
		expect(() => appendHistory("first ever", "/p", home)).not.toThrow();
		expect(loadHistory("/p", 100, home)).toEqual(["first ever"]);
	});

	test("trims surrounding whitespace before storing", () => {
		const home = tmpHome();
		appendHistory("  padded  ", "/p", home);
		expect(loadHistory("/p", 100, home)).toEqual(["padded"]);
	});

	// Slash commands are the REPL's own vocabulary, not prompts worth recalling.
	test("ignores slash commands and blank input", () => {
		const home = tmpHome();
		appendHistory("/theme dark", "/p", home);
		appendHistory("", "/p", home);
		appendHistory("   \n  ", "/p", home);
		expect(loadHistory("/p", 100, home)).toEqual([]);
	});

	test("keeps appending rather than overwriting", () => {
		const home = tmpHome();
		appendHistory("one", "/p", home);
		appendHistory("two", "/p", home);
		expect(readFileSync(historyFilePath(home), "utf8").trim().split("\n")).toHaveLength(2);
	});
});

describe("loadHistory", () => {
	test("a missing file is empty history, not an error", () => {
		expect(loadHistory("/p", 100, tmpHome())).toEqual([]);
	});

	test("returns oldest to newest, since recall walks backwards from the end", () => {
		const home = tmpHome();
		appendHistory("first", "/p", home);
		appendHistory("second", "/p", home);
		appendHistory("third", "/p", home);
		expect(loadHistory("/p", 100, home)).toEqual(["first", "second", "third"]);
	});

	test("filters to one project, leaving other projects' prompts out", () => {
		const home = tmpHome();
		appendHistory("mine", "/a", home);
		appendHistory("theirs", "/b", home);
		expect(loadHistory("/a", 100, home)).toEqual(["mine"]);
		expect(loadHistory("/b", 100, home)).toEqual(["theirs"]);
	});

	test("with no cwd, returns every project's prompts", () => {
		const home = tmpHome();
		appendHistory("from a", "/a", home);
		appendHistory("from b", "/b", home);
		expect(loadHistory(undefined, 100, home)).toEqual(["from a", "from b"]);
	});

	// A prompt sent twice should occupy one slot, at its most recent position.
	test("deduplicates repeats, keeping the newest position", () => {
		const home = tmpHome();
		appendHistory("repeat", "/p", home);
		appendHistory("other", "/p", home);
		appendHistory("repeat", "/p", home);
		expect(loadHistory("/p", 100, home)).toEqual(["other", "repeat"]);
	});

	test("the limit counts from the newest end", () => {
		const home = tmpHome();
		for (const text of ["a", "b", "c", "d"]) appendHistory(text, "/p", home);
		expect(loadHistory("/p", 2, home)).toEqual(["c", "d"]);
		expect(loadHistory("/p", 1, home)).toEqual(["d"]);
	});

	test("a limit of zero returns nothing", () => {
		const home = tmpHome();
		appendHistory("a", "/p", home);
		expect(loadHistory("/p", 0, home)).toEqual([]);
	});

	// A half-written line from a killed process must not cost the user the rest
	// of their history.
	test("skips unparseable lines and keeps the good ones", () => {
		const home = tmpHome();
		appendHistory("good one", "/p", home);
		const path = historyFilePath(home);
		writeFileSync(path, `${readFileSync(path, "utf8")}{ truncated\n`, "utf8");
		appendHistory("good two", "/p", home);
		expect(loadHistory("/p", 100, home)).toEqual(["good one", "good two"]);
	});

	test("tolerates blank lines", () => {
		const home = tmpHome();
		appendHistory("kept", "/p", home);
		const path = historyFilePath(home);
		writeFileSync(path, `\n${readFileSync(path, "utf8")}\n\n`, "utf8");
		expect(loadHistory("/p", 100, home)).toEqual(["kept"]);
	});

	test("a file of nothing but garbage reads as empty", () => {
		const home = tmpHome();
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(historyFilePath(home), "not json\nnor this\n", "utf8");
		expect(loadHistory("/p", 100, home)).toEqual([]);
	});
});
