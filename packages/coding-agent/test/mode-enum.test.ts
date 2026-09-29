/**
 * The two enums have exactly one source, and this file is what holds them to it.
 *
 * `packages/agent/src/types.ts` says so in its own comment: the zod schema, the
 * CLI validator and the picker all read `PERMISSION_MODES` and `SANDBOX_MODES`
 * rather than re-spelling them. That sentence was there before the rewrite and
 * was false — `settings.ts` carried a hand-written `z.enum` of the same names,
 * so a mode added to the list was a mode everywhere except in the one place a
 * user could set it. A comment cannot catch that, and neither can a test that
 * names three modes: it would pass on all three and say nothing about a fourth.
 *
 * So the walk below is over the *arrays*, and the four consumers are checked
 * against whatever those arrays currently contain. Adding a value to either list
 * is what makes this file do more work; removing one makes a case that asserted
 * a value now go and find its own. A consumer that drifted back to its own copy
 * passes every existing case and fails the moment a fifth mode arrives, which is
 * the only moment the difference is visible.
 *
 * `/mode` is deliberately not walked here. It is not a second reader of the
 * enum — it resolves through `MODE_CHOICES`, which is the picker's table rather
 * than either list — and `mode-command.test.ts` walks those rows end to end
 * through the command. Two files walking two different tables is the arrangement
 * that keeps one file's list honest.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MODE_CHOICES, PERMISSION_MODES, SANDBOX_MODES } from "@labunbun/agent";
import { validateModeFlags } from "../src/main.ts";
import { PermissionModeSchema, SandboxModeSchema } from "../src/settings.ts";

/** The whole cross product, as `[mode, sandbox]` pairs. */
const PAIRS = PERMISSION_MODES.flatMap((mode) => SANDBOX_MODES.map((sandbox) => [mode, sandbox] as const));

/**
 * `main.ts` with its comments removed.
 *
 * Comments have to come out: the file explains *why* the validation is where it
 * is, and a scan that matched the explanation instead of the code would pass on
 * a file that had been moved back to the wrong place.
 */
const mainSource = (() => {
	const path = fileURLToPath(new URL("../src/main.ts", import.meta.url));
	return readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
})();

describe("every value reaches every consumer", () => {
	test.each([...PERMISSION_MODES])("the mode %s passes the settings schema", (mode) => {
		expect(PermissionModeSchema.safeParse(mode).success).toBe(true);
	});

	test.each([...SANDBOX_MODES])("the sandbox %s passes the settings schema", (sandbox) => {
		expect(SandboxModeSchema.safeParse(sandbox).success).toBe(true);
	});

	test.each(PAIRS)("--permission-mode %s --sandbox %s passes CLI validation", (mode, sandbox) => {
		expect(validateModeFlags({ permissionMode: mode, sandbox })).toEqual({ mode, sandbox });
	});

	/**
	 * Absent is not the same as empty, and the CLI is the one place the two are
	 * easy to confuse: a flag that was not typed has to come back `undefined` so
	 * the settings file decides, and a flag that was typed as `""` has to be
	 * treated the same way rather than read as a mode named the empty string.
	 */
	test("an untyped flag stays undecided instead of picking a value", () => {
		expect(validateModeFlags({ permissionMode: null, sandbox: null })).toEqual({
			mode: undefined,
			sandbox: undefined,
		});
	});

	/**
	 * *Where* the CLI calls the validator, not just what the validator says.
	 *
	 * Every case above passes whether the check runs on both startup paths or one.
	 * It used to run on one: `--permission-mode` was read only inside the
	 * `-p` branch, and the interactive path passed the string straight through an
	 * `as never` — so a mistyped flag in an ordinary terminal session was accepted
	 * and silently became the default. Nothing observable comes back from
	 * `runCli` that distinguishes the two, and spawning the real binary needs a
	 * TTY, so the claim is checked against the source instead.
	 *
	 * This is a structural assertion and it is deliberately narrow: it asks that
	 * the call precede the `-p` branch, and says nothing about the rest of the
	 * function. A test that grew to pin the whole shape would break on every
	 * unrelated edit and would be ignored the first time it did.
	 */
	test("both startup paths go through the validator, not just -p", () => {
		const call = mainSource.indexOf("validateModeFlags(args)");
		expect(call).toBeGreaterThan(-1);
		const printBranch = mainSource.indexOf("args.print !== null");
		expect(printBranch).toBeGreaterThan(-1);
		expect(call).toBeLessThan(printBranch);
	});

	/**
	 * And the flags reach both consumers rather than being validated and dropped.
	 * A call that runs early but whose result is only read in one place would
	 * satisfy the ordering above and still let the other path through unchecked.
	 */
	test("the validated pair is handed to both the headless and the interactive run", () => {
		expect(mainSource).toContain("permissionMode: flags.mode");
		expect(mainSource).toContain("sandbox: flags.sandbox");
	});
});

describe("every picker row is a pair the enums actually have", () => {
	/**
	 * `MODE_CHOICES` is a hand-written table, so it is the one place a mode can be
	 * spelled that neither list contains — and a row built from a mode the engine
	 * does not have is a row that sets nothing. The check runs against the arrays
	 * rather than against literals for the same reason as everything above.
	 *
	 * A `for` loop rather than `test.each`, and the reason is the type checker:
	 * `MODE_CHOICES` is a readonly array of objects, which is not a row table in
	 * any of the three shapes Bun's overloads accept, so the call does not
	 * typecheck at all. A loop also gives each row its own name in the output,
	 * which is what tells you *which* row went bad rather than that one did.
	 */
	for (const choice of MODE_CHOICES) {
		test(`${choice.id} names a mode and a sandbox this build has`, () => {
			expect(PERMISSION_MODES).toContain(choice.mode);
			expect(SANDBOX_MODES).toContain(choice.sandbox);
		});

		/**
		 * A row with nothing written next to it is a choice the user has to look
		 * up somewhere else, and the picker is the only place the four differ.
		 */
		test(`${choice.id} says what it is for`, () => {
			expect(choice.hint.length).toBeGreaterThan(0);
		});
	}
});

describe("a value this build does not have is refused", () => {
	/**
	 * The negative is the half that matters. A validator that accepts everything
	 * passes every case above, and one that accepts nothing fails every case
	 * above; only this one tells the two apart, and it is why the error text
	 * matters as much as the verdict.
	 */
	test("the settings schema refuses a name that is not a mode", () => {
		const result = PermissionModeSchema.safeParse("definitely-not-a-mode");
		expect(result.success).toBe(false);
		expect(result.error?.issues[0].message).toContain("not a permission mode");
	});

	test("the settings schema refuses a sandbox it does not have", () => {
		const result = SandboxModeSchema.safeParse("seatbelt");
		expect(result.success).toBe(false);
		expect(result.error?.issues[0].message).toContain("not a sandbox mode");
	});

	test.each([
		["a mode that is not one", "nope", "danger-full-access"],
		["a sandbox that is not one", "agent", "seatbelt"],
	])("the CLI refuses %s", (_label, permissionMode, sandbox) => {
		const result = validateModeFlags({ permissionMode, sandbox });
		expect(result.mode).toBeUndefined();
		expect(result.sandbox).toBeUndefined();
		expect(result.error).toBeDefined();
	});
});

describe("a retired value is refused with a sentence to act on", () => {
	/**
	 * The values this rewrite removed are the ones a real config file still
	 * contains, so "invalid" is the worst possible answer to one: it leaves the
	 * user with a key they cannot delete and no way to find out what to type.
	 * Each case below is a name somebody's settings file is still carrying, and
	 * the assertion is that the message names the replacement.
	 *
	 * `bypassPermissions` is the one that has to be careful. It is the old name
	 * for the posture this build calls "Agent 无沙箱", so the suggestion has to
	 * carry *both* halves — a message that named only the mode would walk a
	 * scripted user into the sandboxed pairing, which is the one change here
	 * that could quietly narrow a run rather than widen it.
	 */
	test.each([
		["default", 'permissionMode "ask"'],
		["manual", 'permissionMode "ask"'],
		["acceptEdits", 'permissionMode "ask"'],
		["dontAsk", 'permissionMode "ask"'],
		["bypassPermissions", 'permissionMode "agent" together with sandbox "danger-full-access"'],
	])("%s names the value to write instead", (retired, expected) => {
		const result = PermissionModeSchema.safeParse(retired);
		expect(result.success).toBe(false);
		const message = result.error?.issues[0].message ?? "";
		expect(message).toContain(`"${retired}" is no longer a permission mode`);
		expect(message).toContain(expected);
	});

	test("the whole sentence for bypassPermissions carries both halves, not one", () => {
		const message = PermissionModeSchema.safeParse("bypassPermissions").error?.issues[0].message ?? "";
		expect(message).toContain('permissionMode "agent"');
		expect(message).toContain('sandbox "danger-full-access"');
	});

	/**
	 * A retired *mode* name is not a retired *sandbox* name, and the sandbox
	 * schema has no suggestions to offer — it was never a thing users wrote
	 * alone. It still has to refuse rather than pass it through, because a
	 * `sandbox` key that held `bypassPermissions` is a config that means
	 * something and this build does not know what.
	 */
	test.each(["bypassPermissions", "acceptEdits", "default"])(
		"the sandbox schema refuses the retired name %s",
		(retired) => {
			const result = SandboxModeSchema.safeParse(retired);
			expect(result.success).toBe(false);
			expect(result.error?.issues[0].message).toContain("not a sandbox mode");
		},
	);
});

describe("the schema checks the shape, not just the name", () => {
	/**
	 * A JSON settings file can hold anything in a string key, and the value that
	 * arrives is not always a string. The type annotation on the schema says
	 * `PermissionMode`, which is what makes this worth pinning: without the
	 * runtime check, `true` would sail through a validator that only compares
	 * against a list of names.
	 */
	test.each([
		["a number", 7],
		["a boolean", true],
		["null", null],
		["an object", { mode: "ask" }],
		["an array", ["ask"]],
	])("permissionMode refuses %s", (_label, value) => {
		const result = PermissionModeSchema.safeParse(value);
		expect(result.success).toBe(false);
	});

	test("the refusal says what it got, because the report has to name the shape", () => {
		const result = PermissionModeSchema.safeParse(7);
		expect(result.error?.issues[0].message).toContain("got number");
	});
});

describe("the lists are the ones the rest of the build is written against", () => {
	/**
	 * A last sanity check on the tables themselves rather than on the consumers.
	 * If either array lost an entry, every walk above would quietly shrink and
	 * still pass — so the counts are pinned, with the reason next to them.
	 */
	test("the mode list is the three the picker is built around", () => {
		expect([...PERMISSION_MODES]).toEqual(["ask", "plan", "agent"]);
	});

	test("the sandbox list has a confined value and an unconfined one", () => {
		expect([...SANDBOX_MODES]).toEqual(["workspace-write", "danger-full-access"]);
	});

	test("every combination of the two axes is one the engine can be asked for", () => {
		expect(PAIRS).toHaveLength(PERMISSION_MODES.length * SANDBOX_MODES.length);
	});
});
