/**
 * The wiring that puts the sandbox's extra writable roots in front of a user.
 *
 * Two halves, and neither of them is a unit test of a function:
 *
 *   1. `permissions.additionalDirectories` is **handed to the Bash tool** by both
 *      entry points. The setting had a schema entry, a trust policy and a
 *      migration path for its whole life and no reader, so it is exactly the kind
 *      of thing that can be present, valid, denied to the project tier — and
 *      inert. A source-level guard is the only thing that catches it being handed
 *      to one entry point and forgotten in the other.
 *
 *   2. `/permissions` **prints the resolved list.** A setting nobody can see is a
 *      setting nobody has, and `permissions.additionalDirectories` in particular
 *      is a list of paths a user cannot otherwise find out about: not the mode
 *      line, not the sandbox sentence (which is handed a mode and a backend,
 *      never a policy), and not `/doctor` (which has no filesystem-sandbox row).
 *
 * The assertions read source rather than driving the REPL for the same reason
 * `doctor.test.ts:377-395` does: these are facts about *what is wired where*,
 * and a harness that renders the whole `/permissions` screen would make them
 * true only in the one configuration the harness happens to build. The control
 * test is what keeps that honest — it asserts the anchor is present at all, so a
 * renamed one fails loudly instead of making the negative assertions vacuous.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWritableRoots } from "@labunbun/tools";
import { PROJECT_TIER_PERMISSION_KEY_POLICY, SettingsSchema } from "../src/settings.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** `length` characters from `anchor`, or a throw — never an empty window. */
function callSite(file: string, anchor: string, length = 700): string {
	const source = readFileSync(file, "utf8");
	const at = source.indexOf(anchor);
	if (at < 0) throw new Error(`anchor not found in ${file}: ${anchor}`);
	return source.slice(at, at + length);
}

/**
 * The whole body of one `case "…": { … }`, from its anchor to the next `case`.
 *
 * A character count would have been the other option and it is the brittle one:
 * the `/permissions` block carries four explanatory comment paragraphs, so any
 * window that covers the whole case is a number that has to be re-tuned every
 * time a sentence of prose is edited, and a window tuned too small makes the
 * assertions below silently vacuous.
 */
function caseBlock(file: string, name: string): string {
	const source = readFileSync(file, "utf8");
	const anchor = `case "${name}": {`;
	const at = source.indexOf(anchor);
	if (at < 0) throw new Error(`anchor not found in ${file}: ${anchor}`);
	const next = source.indexOf("\n\t\tcase ", at + anchor.length);
	return source.slice(at, next < 0 ? source.length : next);
}

describe("the Bash tool is given a home and a configured directory list", () => {
	test.each([
		["the REPL", join(SRC, "interactive.ts"), "const tools = createAllTools(cwd, {"],
		["the headless run", join(SRC, "headless.ts"), "const tools = createAllTools(cwd, {"],
	])("%s hands both to createAllTools", (_label, file, anchor) => {
		const window = callSite(file, anchor);
		expect(window).toContain("home,");
		expect(window).toContain("writableRoots: settings.permissions.additionalDirectories");
	});

	test("createAllTools passes them on to the one tool that takes them", () => {
		// The middle of the chain. A `home` that stops at `createAllTools` produces
		// exactly the measured defect this batch fixes — a temp directory and no
		// package caches — with every other layer looking correct.
		const window = callSite(
			join(SRC, "..", "..", "tools", "src", "index.ts"),
			"createBashTool(cwd, ops, background, {",
		);
		expect(window).toContain("home: options.home");
		expect(window).toContain("writableRoots: options.writableRoots");
	});

	test("neither entry point resolves a home of its own", () => {
		// `home` is already a parameter on both, and resolving one again here would
		// be the `os.homedir()` defect this repository already has one of: the answer
		// comes from the Win32 environment block, so a test that handed the process a
		// fixture home is answered with the developer's real one and CI reads a real
		// config. These two files already import it as a default for `options.home`,
		// which is the app's to choose and not a place to re-derive it from.
		for (const file of [join(SRC, "interactive.ts"), join(SRC, "headless.ts")]) {
			const window = callSite(file, "const tools = createAllTools(cwd, {");
			expect(window).not.toContain("homedir()");
			expect(window).not.toContain("os.homedir");
		}
	});
});

describe("/permissions shows the writable roots", () => {
	test("the command renders them", () => {
		// The whole case, not a window: the mode line, the backend sentence and the
		// network sentence all sit between the anchor and this call, and they are the
		// lines that must survive for it to be worth printing.
		const window = caseBlock(join(SRC, "interactive.ts"), "/permissions");
		expect(window).toContain("describeWritableRoots({");
		// Read off the context rather than off `homedir()`, for the same reason the
		// tools take it as a parameter: a session pointed at a fixture home must
		// print that home's roots, or the line names paths the policy does not have.
		expect(window).toContain("home: ctx.home");
		expect(window).toContain("configured: ctx.settings.permissions.additionalDirectories");
		// The control for the two above: a `caseBlock` that silently found nothing
		// would make all three vacuous.
		expect(window).toContain("describeSandboxBackend(ctx.sandboxBackend");
	});

	test("and it renders them from the same function the policy is built from", () => {
		// The alternative is a second list, described separately, which is the kind
		// of duplication that goes stale silently and is then believed. Both names
		// below come from `@labunbun/tools`, which is where `resolveWritableRoots`
		// and `describeWritableRoots` both live.
		const window = callSite(join(SRC, "..", "..", "tools", "src", "bash.ts"), "writableRoots: resolveWritableRoots({");
		// **`options?.home`, not `options.home`.** The parameter is optional, so
		// reading it unguarded is a type error — the first version of this row asked
		// for the unguarded spelling and the compiler was right. What the row is
		// actually for is that the value comes from the caller's option rather than
		// from a constant, and `?.` says that as well as `.` does.
		expect(window).toContain("home: options?.home");
		expect(window).toContain("configured: options?.writableRoots");
	});

	test("the control: the sentence builder is imported, so the call above cannot be a free variable", () => {
		const source = readFileSync(join(SRC, "interactive.ts"), "utf8");
		expect(source).toContain("\tdescribeWritableRoots,\n");
	});
});

describe("the value the app hands over is not an opt-out", () => {
	test("a machine with no settings file still gets the default roots", () => {
		// The end of the chain, and the one that would have shipped a no-op.
		//
		// `additionalDirectories` is declared with `.default([])`, so the merged
		// settings carry an empty list for **every** user who has never touched the
		// key — and `migrate.ts` writes `"additionalDirectories": []` into the file it
		// produces, so a migrated machine is in the same position. `resolveWritableRoots`
		// therefore reads an empty list as "use the defaults", and this asserts the
		// half that only this package can: that what it hands over really is empty.
		// The other half — that empty falls back to the defaults rather than to
		// nothing — is asserted in `packages/tools/test/sandbox-writable-roots.test.ts`.
		const unconfigured = SettingsSchema.parse({}).permissions.additionalDirectories;
		expect(unconfigured).toEqual([]);
		expect(resolveWritableRoots({ home: "/h/user", tempDir: "/tmp/lbb-tmp", configured: unconfigured })).toEqual(
			resolveWritableRoots({ home: "/h/user", tempDir: "/tmp/lbb-tmp" }),
		);
	});

	test("and a list the user did write replaces them", () => {
		const configured = SettingsSchema.parse({ permissions: { additionalDirectories: ["/srv/build"] } }).permissions
			.additionalDirectories;
		expect(resolveWritableRoots({ home: "/h/user", tempDir: "/tmp/lbb-tmp", configured })).toEqual([
			{ path: "/srv/build", kind: "project" },
		]);
	});

	test("a repository still cannot hand itself one", () => {
		// The trust tier, restated where the reader is. `PROJECT_TIER_KEY_POLICY`
		// denies `permissions.additionalDirectories` from the project and local
		// files; without that, a cloned repo could widen its own sandbox by three
		// lines of JSON.
		expect(PROJECT_TIER_PERMISSION_KEY_POLICY.additionalDirectories).toBe("denied");
	});
});
