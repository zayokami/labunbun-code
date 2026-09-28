/**
 * The hermetic-test list, checked against the sources it is supposed to cover.
 *
 * `source-env.ts` says its list is "derived from the sources themselves" and is
 * not: it is hand-maintained, and nothing checked it. That is not a nitpick.
 * The failure it prevents is spelled out in that file's own header — a test that
 * points `HOME` at a temp directory has not thereby insulated itself, because
 * any variable a source reads by name is still pointing at the developer's real
 * install. When it bit for `APPDATA` it took thirteen test files to find, all on
 * one machine, because the machine that *has* the variable is the only machine
 * where the tests fail.
 *
 * So the list is now checked, by reading the source rather than by trusting the
 * list. `CURSOR_DATA_DIR` is the one that motivated it: it was read by
 * `cursor-home.ts` and absent from the list, and the leak was silent everywhere
 * except on a machine that exports it.
 *
 * The scan is deliberately dumb — a regexp over the source text — because the
 * alternative is an AST walk for a question that is really "does this file say
 * `process.env.` at all". What it cannot do is miss a variable read through a
 * helper, and the two spellings that matter are both covered:
 * `process.env.NAME` and the destructuring form `const { NAME } = process.env`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_ENV_VARS, MIGRATION_ENV_VARS_EXEMPT } from "./source-env.ts";

const SRC = join(import.meta.dir, "..", "src");

/** Every source file that could plausibly read a variable by name. */
function sourceFiles(): string[] {
	return readdirSync(SRC)
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => join(SRC, name));
}

/**
 * The variable names one file reads, or an empty list.
 *
 * Three spellings, because the three all appear in this repository:
 * `process.env.NAME`, `process.env["NAME"]`, and the destructuring form. The
 * first is a plain text match, which also picks up a name mentioned in a
 * comment — that is the safe direction to fail in, since a comment saying
 * `CURSOR_CONFIG_DIR` means somebody is thinking about the variable and wants
 * the test to be hermetic against it.
 */
function envNamesIn(text: string): string[] {
	const names = new Set<string>();
	// `match[1]` is `string | undefined` to the type checker because a capture group
	// might not have participated, so each is guarded rather than asserted. The
	// guard is free here — the patterns all require the group — and it says so.
	for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
		if (match[1]) names.add(match[1]);
	}
	for (const match of text.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g)) {
		if (match[1]) names.add(match[1]);
	}
	for (const match of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*process\.env/g)) {
		for (const part of (match[1] ?? "").split(",")) {
			// The **key** is the variable, not the value: `{ CODEX_HOME }` has no
			// colon and `{ CODEX_HOME: codexHome }` has one, and taking the last
			// segment gets the second backwards — it would return the local name,
			// which is lower-case and fails the test below, so the destructuring form
			// would silently report nothing.
			const name = part.split(":")[0]?.trim();
			if (name && /^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
		}
	}
	return [...names].sort();
}

describe("the hermetic-test environment list", () => {
	// One test rather than one per file, so a failure names every gap at once.
	// A per-file `test.each` has a structural blind spot the emacs work already
	// documented: deleting the row deletes the test.
	test("every environment variable a source reads by name is in the list", () => {
		const known = new Set(MIGRATION_ENV_VARS);
		const exempt = new Set(Object.keys(MIGRATION_ENV_VARS_EXEMPT));
		const gaps: string[] = [];
		for (const file of sourceFiles()) {
			for (const name of envNamesIn(readFileSync(file, "utf8"))) {
				if (known.has(name) || exempt.has(name)) continue;
				gaps.push(`${name} (${join("src", file.slice(SRC.length + 1))})`);
			}
		}
		expect(gaps).toEqual([]);
	});

	test("an exemption carries a reason, so it is a decision and not an omission", () => {
		// The two entries that are deliberately not covered. Without this a
		// `MIGRATION_ENV_VARS_EXEMPT: string[]` would work just as well and the
		// reason would live only in a comment somebody eventually deletes.
		expect(Object.keys(MIGRATION_ENV_VARS_EXEMPT).sort()).toEqual(["HOME", "USERPROFILE"]);
		for (const [name, reason] of Object.entries(MIGRATION_ENV_VARS_EXEMPT)) {
			expect(reason.length).toBeGreaterThan(20);
			expect(reason).toContain(name === "HOME" ? "fake home" : "Windows");
		}
	});

	test("the list still has entries, so the test above cannot pass vacuously", () => {
		// The mechanical twin of the empty-`test.each` blind spot: if someone
		// empties the list, the coverage test above goes green and hermeticity is
		// gone. This is the floor under it.
		expect(MIGRATION_ENV_VARS.length).toBeGreaterThan(10);
	});

	test("every name in the list is uppercase, and there are no duplicates", () => {
		// A typo here fails silently in the other direction: `CURSOR_CONFIG_DIR`
		// twice still deletes it twice, but `Cursor_Config_Dir` is deleted by
		// neither.
		for (const name of MIGRATION_ENV_VARS) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
		expect(new Set(MIGRATION_ENV_VARS).size).toBe(MIGRATION_ENV_VARS.length);
	});

	test("the scan can actually see a variable, or the coverage test proves nothing", () => {
		// The same shape the differential drivers use: a mutation that changes a
		// line nobody reads must move the needle. Here the "somebody" is the
		// scanner, so the probe is a file that reads a known variable.
		expect(envNamesIn('const root = process.env.CURSOR_DATA_DIR ?? "/x";')).toEqual(["CURSOR_DATA_DIR"]);
		expect(envNamesIn("const { CODEX_HOME: codexHome } = process.env;")).toEqual(["CODEX_HOME"]);
		expect(envNamesIn('process.env["GROK_HOME"];')).toEqual(["GROK_HOME"]);
	});
});
