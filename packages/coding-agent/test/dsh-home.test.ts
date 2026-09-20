/**
 * Where `$DSH_HOME` points, as one rule both readers share.
 *
 * The harness resolves its root through `expandHomePath` and `resolve`, so a
 * value it accepts is a value this importer has to accept too — and it has to
 * accept it *identically* in the plan, which reads the settings and the skills
 * and the patches, and in the history importer, which reads the sessions. These
 * tests pin the rule itself rather than either call site: a second copy that
 * grows up without the expansion is exactly what this file is here to make fail.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DSH_DEFAULT_DIR, dshRoot } from "../src/dsh-home.ts";

/** Temp homes, swept with the test that made them. */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Environment variables a test borrowed, restored after it. */
const borrowed = new Map<string, string | undefined>();
afterEach(() => {
	for (const [name, value] of borrowed) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	borrowed.clear();
});

/** Borrow one environment variable for the rest of the test. */
function setEnv(name: string, value: string | undefined): void {
	if (!borrowed.has(name)) borrowed.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** A throwaway home to resolve against. */
function freshHome(): string {
	const home = mkdtempSync(join(tmpdir(), "lbb-dsh-home-"));
	roots.push(home);
	return home;
}

describe("the DeepSeek Harness root", () => {
	test("an unset variable means ~/.dsh", () => {
		const home = freshHome();
		setEnv("DSH_HOME", undefined);
		expect(dshRoot(home)).toBe(join(home, DSH_DEFAULT_DIR));
		expect(dshRoot(home)).toBe(join(home, ".dsh"));
	});

	test("a blank variable is not a path, it is an unset one", () => {
		const home = freshHome();
		for (const blank of ["", "   ", "\t", "\n"]) {
			setEnv("DSH_HOME", blank);
			expect(dshRoot(home)).toBe(join(home, ".dsh"));
		}
	});

	test("an absolute variable is the root, taken as it stands", () => {
		const home = freshHome();
		const elsewhere = join(home, "somewhere", "else");
		setEnv("DSH_HOME", elsewhere);
		expect(dshRoot(home)).toBe(resolve(elsewhere));
	});

	test("a leading ~ means home, in both spellings", () => {
		const home = freshHome();
		setEnv("DSH_HOME", "~");
		expect(dshRoot(home)).toBe(home);
		setEnv("DSH_HOME", "~/dsh-alt");
		expect(dshRoot(home)).toBe(join(home, "dsh-alt"));
		setEnv("DSH_HOME", "~\\dsh-alt");
		expect(dshRoot(home)).toBe(join(home, "dsh-alt"));
		// A `~` that is not the whole leading segment is an ordinary character.
		setEnv("DSH_HOME", join(home, "~odd"));
		expect(dshRoot(home)).toBe(join(home, "~odd"));
	});

	test("a relative variable resolves against the working directory", () => {
		const home = freshHome();
		setEnv("DSH_HOME", "rel/dsh");
		expect(dshRoot(home)).toBe(resolve("rel/dsh"));
		expect(dshRoot(home)).toBe(join(process.cwd(), "rel", "dsh"));
	});

	test("a padded value is used verbatim, as the harness uses it", () => {
		// The harness tests the raw value for blankness and then uses it exactly as
		// it stands, so a padded `$DSH_HOME` names a padded directory. Trimming
		// would read a tree the harness never writes to — and only for the users
		// who padded, which is the sort of divergence nobody reports.
		const home = freshHome();
		const padded = `  ${join(home, "padded")}  `;
		setEnv("DSH_HOME", padded);
		expect(dshRoot(home)).toBe(resolve(padded));
		expect(dshRoot(home)).not.toBe(join(home, "padded"));
	});
});
