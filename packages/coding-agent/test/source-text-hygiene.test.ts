/**
 * The source tree must stay text.
 *
 * Three files in this repo were carrying a literal NUL byte, all of them written
 * by the same mistake: reaching for `\u0000` as a value no real input could
 * collide with. `cmd /c`'s segment scan appended one to a word list to make the
 * last segment get looked at; two tests joined arrays with one to build a key
 * and a containment check. The reasoning is sound in a language where NUL is
 * just a char. In a *file* it is not: a NUL makes the file binary, and then
 *
 *   - `file` reports `data` instead of source,
 *   - `grep` stops printing lines and prints `Binary file … matches`, so every
 *     later search of that file silently returns nothing,
 *   - and any tool that decides how to read a file by sniffing its first bytes
 *     can decline to read it as text at all.
 *
 * That last one is the expensive part and it is not hypothetical here. The file
 * that held the dangerous-command classifier — the security-critical one — became
 * the one file in its package that `grep` would not report. An audit of that
 * classifier ran a search over it and got no output back, which reads exactly
 * like "no findings". `file` was the only thing that said otherwise, and nothing
 * in the pipeline runs `file`.
 *
 * So this is a test rather than a note. The check is cheap, it needs no
 * knowledge of the tree, and the failure mode it prevents is invisible: nothing
 * in `bun test`, `tsc`, or `biome` reported these, because all three read
 * source happily and a NUL inside a string literal is a legal character.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");

/** Extensions worth checking: the ones that end up as source, not artifacts. */
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".toml"]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".next", "build"]);

function textFilesUnder(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			textFilesUnder(full, out);
			continue;
		}
		if (TEXT_EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) out.push(full);
	}
	return out;
}

/** Repo-relative, forward slashes — the form the assertions below read. */
function repoPath(full: string): string {
	return relative(REPO, full).replace(/\\/g, "/");
}

/** Tab, newline, carriage return: the only control bytes a source file may hold. */
const ALLOWED_CONTROLS = new Set([9, 10, 13]);

/**
 * A floor on how much the walk has to have covered, and a named file it has to
 * have reached.
 *
 * This is here because of what the first version of this test got wrong, which
 * the mutation driver found the day it was written: gutting the walk — skip
 * `packages/`, or accept every file extension — left the test **green**. There
 * was nothing wrong with the repository, so "no file had a control byte" was
 * true of whatever subset the walk happened to read, and a test that only
 * asserts a property of the tree stays green when it stops looking at the tree.
 *
 * That is the failure mode this file's own header is about, one level up: a
 * guard that measures nothing looks identical to a guard that finds nothing. So
 * the scan reports what it read, and the coverage is asserted rather than
 * assumed. `MIN_FILES` is deliberately far below the real count (451 when this
 * was written) so that adding source does not break it, while gutting the walk —
 * which drops it to single digits — does.
 */
const MIN_FILES = 200;

/** The file that actually carried a NUL, and the one a reviewer would grep. */
const MUST_REACH = "packages/agent/src/dangerous-command.ts";

/**
 * The index of the first C0 control byte that is not one of the three, or `-1`.
 *
 * A scan rather than a regex, because a character class of control characters is
 * itself something the linter refuses: biome's `noControlCharactersInRegex`
 * rejects the escape sequences, correctly, since the whole point of this file is
 * to keep such sequences out of source. A guard that cannot be written without
 * tripping the linter is a guard that gets `biome-ignore`d, and an ignored guard
 * is not a guard.
 *
 * Scope is the C0 range, deliberately. `0x7F` (DEL) is a control character in
 * the abstract but is ordinary valid UTF-8, does not make a file binary, and
 * does not stop `grep` — flagging it would be claiming more than the failure
 * this exists to prevent.
 *
 * **Carriage return is allowed because it is a line ending, not a defect**, and
 * this guard is about bytes that have no business in source at all. It used to
 * say otherwise for a reason that has since stopped being true — the repo
 * checked out with `core.autocrlf = true` and CRLF files were the norm, so the
 * tolerance was load-bearing. `.gitattributes` now pins `eol=lf` in every
 * checkout, and that sentence would have been a claim about a state that no
 * longer exists. The tolerance stays anyway, and not out of deference to the old
 * comment: line endings are the one entry on this list whose correct value is
 * somebody else's tooling decision, and a hygiene guard that fails on them is a
 * guard that gets deleted the first time it cries wolf.
 */
function firstDisallowedControl(text: string): number {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 32 || ALLOWED_CONTROLS.has(code)) continue;
		return i;
	}
	return -1;
}

describe("source text hygiene", () => {
	test("no source file carries a control byte that is not tab or a line ending", () => {
		const files = textFilesUnder(REPO);
		const offenders: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			const at = firstDisallowedControl(text);
			if (at === -1) continue;
			const code = text.charCodeAt(at).toString(16).padStart(4, "0").toUpperCase();
			offenders.push(`${repoPath(file)} has U+${code} at index ${at}`);
		}
		expect(offenders).toEqual([]);
		// Coverage, asserted. Without this the two lines above are a statement
		// about whatever files the walk found, and finding none of them is
		// indistinguishable from there being none to find.
		expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);
		expect(files.map(repoPath)).toContain(MUST_REACH);
	});

	test("the scan finds a NUL, and passes everything a source file legitimately holds", () => {
		// The control for the test above, in both directions. A scan written with
		// the comparison the wrong way round either never fires or fires on every
		// file, and both of those produce exactly the same green run above.
		expect(firstDisallowedControl("const a = 1;\n")).toBe(-1);
		expect(firstDisallowedControl("// tab\there\r\nand a line ending")).toBe(-1);
		// Non-ASCII is not a control character, and neither is DEL.
		expect(firstDisallowedControl("// 注释 — ünïcode ✓")).toBe(-1);
		expect(firstDisallowedControl(`const d = String.fromCharCode(${127});`)).toBe(-1);
		// And it does fire, on the exact byte this file exists for.
		const nuls = String.fromCharCode(0);
		expect(firstDisallowedControl(`const s = "${nuls}";`)).toBe(`const s = "`.length);
		// The *first* one, which is the property the caller depends on: the message
		// names one offset, so an offset that moved would name the wrong place.
		expect(firstDisallowedControl(`${nuls}${nuls}`)).toBe(0);
		expect(firstDisallowedControl(`ok${nuls}at${nuls}11`)).toBe(2);
	});
});
