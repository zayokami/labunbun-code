/**
 * Session titles.
 *
 * A title is a label the user typed, and it ends up in two places that take
 * text seriously: a picker row, and the terminal's OSC-0 title sequence. The
 * normalizer is the single choke point for both, so what is pinned here is
 * that nothing invisible survives it, and that a title the program cannot read
 * back is "untitled" rather than an error — a resume must never fail over a
 * label.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { listSessions } from "../src/session-resume.ts";
import {
	normalizeSessionTitle,
	readSessionTitle,
	SESSION_TITLE_MAX_CHARS,
	sessionTitlePath,
	writeSessionTitle,
} from "../src/session-title.ts";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lbb-title-"));
}

describe("normalizeSessionTitle", () => {
	test("whitespace collapses and the ends are trimmed", () => {
		expect(normalizeSessionTitle("  my \n\t title  ")).toBe("my title");
	});

	test("ANSI escapes go whole, not just their introducer", () => {
		expect(normalizeSessionTitle(`${ESC}[31mred${ESC}[0m title`)).toBe("red title");
	});

	test("control characters become spaces rather than gluing words together", () => {
		expect(normalizeSessionTitle(`a${BEL}b`)).toBe("a b");
	});

	test("one matching pair of quotes is dropped", () => {
		expect(normalizeSessionTitle('"my title"')).toBe("my title");
		expect(normalizeSessionTitle("'my title'")).toBe("my title");
		// Mismatched quotes are text the user typed; keep them.
		expect(normalizeSessionTitle("\"my title'")).toBe("\"my title'");
	});

	test("an overlong title is cut by code point, not UTF-16 unit", () => {
		expect(Array.from(normalizeSessionTitle("x".repeat(500)))).toHaveLength(SESSION_TITLE_MAX_CHARS);
		// A surrogate pair cut in half would render as a replacement glyph.
		expect(normalizeSessionTitle("😀".repeat(100))).toBe("😀".repeat(SESSION_TITLE_MAX_CHARS));
	});

	test("nothing visible left means 'clear it'", () => {
		expect(normalizeSessionTitle("   ")).toBe("");
		expect(normalizeSessionTitle(`${ESC}[31m`)).toBe("");
		expect(normalizeSessionTitle('""')).toBe("");
	});
});

describe("writeSessionTitle / readSessionTitle", () => {
	test("a title round-trips through the sidecar", () => {
		const dir = tempDir();
		try {
			const session = join(dir, "s.jsonl");
			writeSessionTitle(session, "  My  Title  ");
			expect(readSessionTitle(session)).toBe("My Title");
			expect(sessionTitlePath(session)).toBe(`${session}.title.json`);
			const payload = JSON.parse(readFileSync(sessionTitlePath(session), "utf8"));
			expect(payload.version).toBe(1);
			expect(payload.title).toBe("My Title");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("writing twice replaces the title and leaves no temporary files", () => {
		const dir = tempDir();
		try {
			const session = join(dir, "s.jsonl");
			writeSessionTitle(session, "first");
			writeSessionTitle(session, "second");
			expect(readSessionTitle(session)).toBe("second");
			expect(readdirSync(dir)).toEqual(["s.jsonl.title.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an empty or cleared title deletes the sidecar", () => {
		const dir = tempDir();
		try {
			const session = join(dir, "s.jsonl");
			writeSessionTitle(session, "temporary");
			writeSessionTitle(session, undefined);
			expect(existsSync(sessionTitlePath(session))).toBe(false);
			expect(readSessionTitle(session)).toBeUndefined();

			writeSessionTitle(session, "temporary");
			writeSessionTitle(session, "   ");
			expect(existsSync(sessionTitlePath(session))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing sidecar is untitled, not an error", () => {
		const dir = tempDir();
		try {
			expect(readSessionTitle(join(dir, "nothing.jsonl"))).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a damaged or future-shaped sidecar is ignored", () => {
		const dir = tempDir();
		try {
			const session = join(dir, "s.jsonl");
			const path = sessionTitlePath(session);
			for (const payload of [
				"{ not json",
				JSON.stringify({ version: 2, title: "future" }),
				JSON.stringify({ version: 1, title: 42 }),
				JSON.stringify({ version: 1, title: "   " }),
				JSON.stringify({ title: "no version" }),
				"null",
			]) {
				writeFileSync(path, payload);
				expect(readSessionTitle(session), payload).toBeUndefined();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("listSessions", () => {
	test("attaches the sidecar title and never lists the sidecar as a session", () => {
		const home = tempDir();
		try {
			const store = SessionStore.startNew(home, home);
			writeSessionTitle(store.path, "Release notes");
			const sessions = listSessions(home, home);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.path).toBe(store.path);
			expect(sessions[0]?.title).toBe("Release notes");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a session without a sidecar stays untitled", () => {
		const home = tempDir();
		try {
			SessionStore.startNew(home, home);
			const sessions = listSessions(home, home);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.title).toBeUndefined();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
