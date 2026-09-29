/**
 * Cursor's `approvalMode` → this build's two mode axes, checked against the
 * value space the real CLI actually has.
 *
 * **The bug this file exists for.** `CURSOR_APPROVAL_MODES` used to be keyed
 * `ask` / `auto` / `yolo` — a table that looks load-bearing, has three rows of
 * comments above it explaining three different promises, and cannot fire: the
 * bundled CLI declares `allowlist` / `unrestricted` / `auto-review` and writes
 * nothing else. Every real value fell through to the "no equivalent here" skip,
 * so the migration reported a skip for a perfectly ordinary Cursor config and
 * no test failed. Nothing in the behavioural tests can catch that, because the
 * behaviour they assert ("an unknown value is a skip") is the behaviour a
 * *dead* table also has.
 *
 * So the guard here is against the bundle, not against the code: the declared
 * list is read out of `G:\Bunttta\cursor-cli-lab\index.js` and compared to the
 * table's keys in both directions. A row the CLI cannot produce and a value the
 * CLI can produce that has no row are different bugs and both are checked.
 *
 * **The gate is on the file, never on the parse.** `test.skipIf` keys off
 * `existsSync` alone: a checkout without the reference tree skips (it is not a
 * fixture, and a test that only passes with a second tree on the machine fails
 * CI for a reason that has nothing to do with Cursor), while a checkout that
 * *has* the tree and whose extraction misses gets a failing assertion rather
 * than a skip. That distinction is the whole reason the extractors below return
 * `null` instead of quietly yielding an empty list.
 *
 * Nothing is executed out of the bundle — it is a minified build, and running it
 * would be both slow and a different claim from reading it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODE_CHOICES, PERMISSION_MODES, SANDBOX_MODES } from "@labunbun/agent";
import { CURSOR_APPROVAL_MODE_NOTES, CURSOR_APPROVAL_MODES } from "../src/cursor-plan.ts";
import { type MigrationPlan, planMigration, readSources } from "../src/migrate.ts";
import { borrowSourceEnv } from "./source-env.ts";

// ---------------------------------------------------------------------------
// A fake home holding one cursor file
// ---------------------------------------------------------------------------

/**
 * Run `body` against a throwaway home seeded with `tree`, project included.
 *
 * The same harness as `migrate-cursor.test.ts`, copied rather than shared: that
 * file's copy is local to it, and a shared helper for one source's tests would
 * be a module the two files have to agree about for no gain. `borrowSourceEnv`
 * *is* shared, because the variables it clears are a property of `readSources`
 * rather than of Cursor — see that file for what happens without it.
 */
function withHome(tree: Record<string, string>, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-cursor-modes-"));
	const releaseSourceEnv = borrowSourceEnv();
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		for (const [path, content] of Object.entries(tree)) {
			const full = join(home, path);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, content);
		}
		body(home);
	} finally {
		releaseSourceEnv();
		rmSync(home, { recursive: true, force: true });
	}
}

/** The plan for a `cli-config.json` holding `config`, and nothing else. */
function planConfig(config: Record<string, unknown>): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome({ ".cursor/cli-config.json": JSON.stringify(config) }, (home) => {
		planned = planMigration(readSources(home, home), {}, { only: ["cursor"] });
	});
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/** The settings document the plan would write, parsed. */
function settingsJson(planned: MigrationPlan): Record<string, unknown> {
	const write = planned.writes.find((entry) => entry.path.replace(/\\/g, "/").endsWith("/.labunbun/settings.json"));
	return JSON.parse(write?.content ?? "{}") as Record<string, unknown>;
}

/** Every report line whose source label contains `needle`. */
function lines(planned: MigrationPlan, needle: string) {
	return planned.items.filter((item) => item.from.includes(needle));
}

/**
 * The one report line for `needle` that writes to `to`; more than one is a
 * mistake worth failing on.
 *
 * `to` is required rather than defaulted because a mode pair deliberately
 * produces *two* lines under one `from` label — that is the point of it — so
 * "the line for `approvalMode (…)`" is not a well-posed question on its own.
 */
function row(planned: MigrationPlan, needle: string, to: string) {
	const found = planned.items.filter((item) => item.from.includes(needle) && item.to.includes(to));
	expect(found.length).toBe(1);
	return found[0];
}

/** The report line for `needle`, for the skip rows that all write to `—`. */
function line(planned: MigrationPlan, needle: string) {
	return row(planned, needle, "—");
}

// ---------------------------------------------------------------------------
// What the bundled CLI declares
// ---------------------------------------------------------------------------

/**
 * This checkout's read-only copy of the Cursor CLI bundle.
 *
 * Both the approval-mode enum and the sandbox-mode enum are declared in the one
 * entry chunk; the picker presets that *write* them live in a separate chunk,
 * which is why this file cites only this one and does not claim the presets.
 */
const CURSOR_BUNDLE = "G:/Bunttta/cursor-cli-lab/index.js";
const bundlePresent = existsSync(CURSOR_BUNDLE);

/** An enum as the bundle declares it: the values, and the default it writes. */
interface DeclaredEnum {
	values: string[];
	fallback: string;
}

/**
 * The approval modes, read out of the config schema rather than transcribed.
 *
 * The line is
 * `approvalMode:s.k5(["allowlist","unrestricted","auto-review"]).default("allowlist").optional(),`
 * — `s.k5` being the bundle's string-enum helper, hoisted out of a schema
 * builder. Matching `.default("…")` as well as the array is deliberate: it
 * proves the match landed on the *declaration* and not on some other `k5` call
 * nearby, and it is what gives the default half its value.
 *
 * The same list is referenced a second time in this file — `o.k5(Q)` in the
 * session-state schema, against `Q=["allowlist","unrestricted","auto-review"]`
 * — so a miss here means the declaration moved, not that Cursor lost approval
 * modes. A test that treated a miss as "there are none" would report the table
 * as empty and pass, which is the vacuous outcome this whole file is against.
 */
function declaredApprovalModes(source: string): DeclaredEnum | null {
	const hit = /approvalMode:[$\w.]*k5\(\[([^\]]*)\]\)\.default\("([^"]*)"\)/.exec(source);
	if (!hit) return null;
	return { values: splitQuoted(hit[1]), fallback: hit[2] };
}

/**
 * The sandbox modes, found by following the config schema to the object it
 * points at rather than by matching the values themselves.
 *
 * `index.js` declares `sandbox:I.optional()` next to `approvalMode`, and `I` is
 * built a little earlier in the same schema as
 * `I=s.Ik({mode:s.k5(["disabled","enabled"]).default("disabled"),networkAccess:…})`.
 * Matching `"disabled"` or `mode:` on their own would be matching a string in a
 * 400 kB bundle, so this reads the variable name out of the `sandbox:` key and
 * then looks for *that* variable's definition. `I` is a minified name and the
 * intermediate regex allows a short run of text before `{mode:` precisely
 * because the builder's own spelling (`Ik`) is not something to depend on.
 */
function declaredSandboxModes(source: string): DeclaredEnum | null {
	const ref = /sandbox:([$\w.]+)\.optional\(\)/.exec(source);
	if (!ref) return null;
	const name = ref[1].replace(/^.*\./, "");
	const hit = new RegExp(
		`\\b${name}\\s*=\\s*[^;]{0,60}?\\{mode:[$\\w.]*k5\\(\\[([^\\]]*)\\]\\)\\.default\\("([^"]*)"\\)`,
	).exec(source);
	if (!hit) return null;
	return { values: splitQuoted(hit[1]), fallback: hit[2] };
}

/** `"a","b"` → `["a", "b"]`. */
function splitQuoted(list: string): string[] {
	return list.split(",").map((value) => value.trim().replace(/^"|"$/g, ""));
}

function readBundle(): string {
	return readFileSync(CURSOR_BUNDLE, "utf8");
}

// ---------------------------------------------------------------------------
// The table against the bundle
// ---------------------------------------------------------------------------

describe("cursor approvalMode: the table is keyed to what the CLI declares", () => {
	test.skipIf(!bundlePresent)("every key of the table is a value the bundle declares", () => {
		const declared = declaredApprovalModes(readBundle());
		// A `null` here is a miss, not an empty source. Falling through to an
		// empty list would make the `for` below vacuously pass — which is the
		// exact shape of the bug this file was written for.
		expect(declared).not.toBeNull();
		const declaredValues = new Set((declared as DeclaredEnum).values);
		const invented = Object.keys(CURSOR_APPROVAL_MODES).filter((key) => !declaredValues.has(key));
		expect(invented).toEqual([]);
	});

	test.skipIf(!bundlePresent)("every value the bundle declares has a row, so none is silently skipped", () => {
		const declared = declaredApprovalModes(readBundle()) as DeclaredEnum | null;
		expect(declared).not.toBeNull();
		const unhandled = (declared as DeclaredEnum).values.filter((value) => !(value in CURSOR_APPROVAL_MODES));
		// The other direction from the test above, and the one that keeps a
		// *new* cursor mode from landing as a quiet skip: a value declared by
		// cursor with no row here reaches the user as "no equivalent", which is
		// true and useless.
		expect(unhandled).toEqual([]);
	});

	test.skipIf(!bundlePresent)(
		"the default the bundle writes is a row, and it is the default config's own value",
		() => {
			const declared = declaredApprovalModes(readBundle()) as DeclaredEnum;
			expect(declared.values).toContain(declared.fallback);
			expect(CURSOR_APPROVAL_MODES[declared.fallback]).toBeDefined();
			// The same file separately spells the value out in the object cursor
			// writes for a fresh install (`…approvalMode:"allowlist",…`), so the
			// declared default is corroborated by a second site rather than only by
			// the schema's own `.default()`.
			const written = /permissions:\{[^}]*\},approvalMode:"([^"]*)"/.exec(readBundle());
			expect(written?.[1]).toBe(declared.fallback);
		},
	);

	test("the three names the table used to be keyed by are not keys of it", () => {
		// `ask` / `auto` / `yolo` are the pre-rewrite keys. `ask` is a real mode
		// *here*, which is what made the mistake easy to miss: the table looked
		// like it was naming this build's own vocabulary. Cursor has never
		// declared any of the three.
		expect(Object.keys(CURSOR_APPROVAL_MODES)).not.toContain("ask");
		expect(Object.keys(CURSOR_APPROVAL_MODES)).not.toContain("auto");
		expect(Object.keys(CURSOR_APPROVAL_MODES)).not.toContain("yolo");
	});

	test("every note is about a row that exists", () => {
		// A note keyed to a mode that is not in the table is a sentence about a
		// translation that cannot happen. The two are exported side by side
		// precisely so this is checkable.
		expect(Object.keys(CURSOR_APPROVAL_MODE_NOTES).filter((key) => !(key in CURSOR_APPROVAL_MODES))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Every row, both halves
// ---------------------------------------------------------------------------

describe("cursor approvalMode: what each declared value becomes", () => {
	// The expectations are written out here rather than read off
	// `CURSOR_APPROVAL_MODES`, which is the whole point: the table is the thing
	// under test, so copying it into the assertion would compare it to itself.
	// A row added to the table without a line here fails here.
	const rows = [
		{ value: "allowlist", mode: "ask", sandbox: "workspace-write" },
		{ value: "auto-review", mode: "ask", sandbox: "workspace-write" },
		{ value: "unrestricted", mode: "agent", sandbox: "danger-full-access" },
	] as const;

	// A `for` loop rather than `test.each`: none of Bun's `test.each` overloads
	// takes a readonly array of *objects* (it hands the callback `unknown`), and
	// the workaround — typing the table as `any[]` — would throw away the one
	// thing the table is for. A loop also names each row in the output, so a
	// failure says which approval mode broke rather than which of three
	// identically-shaped cases did.
	for (const { value, mode, sandbox } of rows) {
		test(`\`${value}\` writes both halves of the pair`, () => {
			const planned = planConfig({ approvalMode: value });
			const settings = settingsJson(planned);

			// Both halves, because a foreign tool's mode is one value doing both
			// jobs and this build splits them. Asserting only `permissionMode` is how
			// an unconfined cursor config ends up imported as a confined one.
			expect(settings.permissionMode).toBe(mode);
			expect(settings.sandbox).toBe(sandbox);

			// And both halves are *reported*, with the same source label — one
			// decision, two keys, and a user reading one line should be able to find
			// the other.
			const reported = lines(planned, `approvalMode ("${value}")`);
			expect(reported.map((item) => item.to)).toEqual(["settings.json → permissionMode", "settings.json → sandbox"]);
			for (const item of reported) expect(item.action).toBe("map");
		});
	}

	for (const { value, mode, sandbox } of rows) {
		test(`\`${value}\` produces a pair the picker can express`, () => {
			// Both axes are already type-checked against `PERMISSION_MODES` and
			// `SANDBOX_MODES`, so this is not re-checking the types — it is checking
			// the *pair*. Nothing in the type system stops a planner writing a
			// combination `/mode` has no row for, and a user told to "set it back"
			// would be given a value they cannot type.
			const expressible = MODE_CHOICES.some((choice) => choice.mode === mode && choice.sandbox === sandbox);
			expect(expressible).toBe(true);
			expect(PERMISSION_MODES).toContain(mode);
			expect(SANDBOX_MODES).toContain(sandbox);
		});
	}

	test("the row the table holds is the row the plan writes", () => {
		// The table and the report are produced by different statements of the
		// mapping — one is the lookup, the other is what the user is told. They
		// can disagree, and nothing else would notice.
		for (const { value, mode, sandbox } of rows) {
			const planned = planConfig({ approvalMode: value });
			const reported = row(planned, `approvalMode ("${value}")`, "settings.json → permissionMode");
			expect(reported.detail).toContain(`read as "${mode}"`);
			expect(settingsJson(planned)).toEqual({ permissionMode: CURSOR_APPROVAL_MODES[value].mode, sandbox });
		}
	});

	test("auto-review is the one that is narrower, and the report says so", () => {
		// `ask` is the opposite of what a classifier does — a classifier approves
		// the calls it judges safe and never asks. Reporting it as a plain `read
		// as "ask"` would present three exact translations when one of them is a
		// different answer entirely.
		const planned = planConfig({ approvalMode: "auto-review" });
		const reported = row(planned, 'approvalMode ("auto-review")', "settings.json → permissionMode");
		expect(reported.detail).toContain(CURSOR_APPROVAL_MODE_NOTES["auto-review"]);
		expect(reported.detail).toContain("narrower than what the config asked for");
		// The other two are exact, and must not borrow the hedge.
		for (const value of ["allowlist", "unrestricted"]) {
			const exact = row(
				planConfig({ approvalMode: value }),
				`approvalMode ("${value}")`,
				"settings.json → permissionMode",
			);
			expect(exact.detail).not.toContain("narrower than what the config asked for");
		}
	});

	test("a value the CLI cannot declare is a skip that names it and writes nothing", () => {
		const planned = planConfig({ approvalMode: "yolo-ish" });
		const skipped = line(planned, 'approvalMode ("yolo-ish")');
		expect(skipped.action).toBe("skip");
		// Named, so the report can be read back against the user's own file.
		expect(skipped.from).toContain('"yolo-ish"');
		expect(skipped.detail).toContain("no permission mode here corresponds");
		// And no half-written pair: the skip has to leave the session in the mode
		// it would otherwise have started in, which is only true if neither key
		// was written.
		expect(settingsJson(planned)).toEqual({});
	});

	test("the value is read the way the file spells it — trimmed, and case-folded", () => {
		// Cursor's own schema is an exact string enum, so a config holding
		// `" Allowlist "` is not one its parser accepts. Reading it leniently is
		// still the right call here: a user who typed the value by hand is far
		// more likely to have added a space or a capital than to have meant
		// something this build does not have a mode for, and the alternative is
		// a skip for a mode the user plainly chose.
		for (const [written, mode] of [
			["  allowlist  ", "ask"],
			["ALLOWLIST", "ask"],
			["Unrestricted", "agent"],
		] as const) {
			const planned = planConfig({ approvalMode: written });
			expect(settingsJson(planned).permissionMode).toBe(mode);
		}
	});
});

// ---------------------------------------------------------------------------
// The sandbox half of the pair
// ---------------------------------------------------------------------------

describe("cursor sandbox: the second axis", () => {
	test.skipIf(!bundlePresent)("every sandbox value the bundle declares reaches one of the two arms", () => {
		// The importer decides from `sandbox.mode` with one test — "is it
		// `disabled`?" — so any value it does not recognise falls into the
		// confined arm. That is safe for the two values cursor declares, and it
		// is worth knowing that it is safe *because* there are two.
		const declared = declaredSandboxModes(readBundle()) as DeclaredEnum | null;
		expect(declared).not.toBeNull();
		expect([...(declared as DeclaredEnum).values].sort()).toEqual(["disabled", "enabled"]);
		expect((declared as DeclaredEnum).values).toContain((declared as DeclaredEnum).fallback);

		for (const value of (declared as DeclaredEnum).values) {
			const skipped = line(planConfig({ sandbox: { mode: value } }), `sandbox.mode ("${value}")`);
			expect(skipped.action).toBe("skip");
		}
		// One arm per direction, and each says which arm it took — the point of
		// the sentence is that the user can see the decision, not that a key was
		// mentioned.
		expect(line(planConfig({ sandbox: { mode: "disabled" } }), 'sandbox.mode ("disabled")').detail).toContain(
			"runs unconfined",
		);
		expect(line(planConfig({ sandbox: { mode: "enabled" } }), 'sandbox.mode ("enabled")').detail).toContain(
			"runs confined",
		);
	});

	test.skipIf(!bundlePresent)("the sandbox value cursor writes for itself is one of the two arms", () => {
		// The bundle's own fresh-install config spells it out:
		// `sandbox:{mode:"disabled",networkAccess:"user_config_with_defaults"}`.
		const written = /sandbox:\{mode:"([^"]*)"/.exec(readBundle());
		expect(written?.[1]).toBe((declaredSandboxModes(readBundle()) as DeclaredEnum).fallback);
	});
});
