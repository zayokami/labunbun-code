/**
 * The `gamepad` block: what the settings file may say, and what the app makes of
 * it.
 *
 * The one bargain worth pinning here is that `bindings` is *not* validated by the
 * schema. A typo in a button name costs the user that one button and turns up as
 * a line in `/doctor` and `/gamepad`; rejecting the document instead would be a
 * whole settings file lost to a misspelled "cros". So the tests below check both
 * halves: the schema takes anything, and `padConfigFrom` is where a name that
 * means nothing becomes a sentence.
 */

import { describe, expect, test } from "bun:test";
import { bindingText, DEFAULT_BINDINGS, describePadDevice, PAD_ACTION_KINDS, resolveBindings } from "@labunbun/gamepad";
import { isDefaultBinding, padConfigFrom, padStartupNotice } from "../src/gamepad-runtime.ts";
import { type Settings, SettingsSchema } from "../src/settings.ts";

/** Settings as the app hands them over: parsed, so the schema's defaults are in. */
function settings(input: Record<string, unknown>): Settings {
	return SettingsSchema.parse(input);
}

describe("the gamepad settings block", () => {
	test("is absent unless asked for, so nothing reads a controller by accident", () => {
		expect(SettingsSchema.parse({}).gamepad).toBeUndefined();
	});

	test("takes the documented keys", () => {
		const parsed = settings({
			gamepad: {
				enabled: true,
				allowApprove: true,
				device: "wireless",
				deadzone: 0.3,
				bindings: { cross: "confirm", r2: "command:/status" },
				phrases: ["run the tests"],
			},
		});
		expect(parsed.gamepad?.enabled).toBe(true);
		expect(parsed.gamepad?.bindings?.cross).toBe("confirm");
		expect(parsed.gamepad?.phrases).toEqual(["run the tests"]);
	});

	test("rejects a deadzone outside the stick, where it can only mean a bug", () => {
		// 0 is a stick that reports a direction from its own noise; 1.1 is a stick
		// nothing can ever move. Both are typos, not preferences.
		expect(SettingsSchema.safeParse({ gamepad: { deadzone: -0.1 } }).success).toBe(false);
		expect(SettingsSchema.safeParse({ gamepad: { deadzone: 1.1 } }).success).toBe(false);
		expect(SettingsSchema.safeParse({ gamepad: { deadzone: 0 } }).success).toBe(true);
	});

	test("takes a binding it cannot recognize, and does not lose the rest of the file", () => {
		// Deliberate: the alternative is rejecting the whole document over one line.
		const parsed = settings({
			model: "deepseek/deepseek-chat",
			gamepad: { bindings: { cros: "confirm", cross: "fly-to-the-moon" } },
		});
		expect(parsed.model).toBe("deepseek/deepseek-chat");
		expect(parsed.gamepad?.bindings).toEqual({ cros: "confirm", cross: "fly-to-the-moon" });
	});
});

describe("padConfigFrom", () => {
	test("every button is bound, and every default is the default", () => {
		const config = padConfigFrom(settings({ gamepad: { enabled: true } }));
		expect(config.enabled).toBe(true);
		// Off unless the file says otherwise, and the two are separate decisions:
		// reading a controller is not the same as letting it answer a prompt.
		expect(config.allowApprove).toBe(false);
		expect(config.problems).toEqual([]);
		expect(Object.keys(config.bindings).sort()).toEqual(Object.keys(DEFAULT_BINDINGS).sort());
		expect(Object.entries(config.bindings).every(([button, b]) => isDefaultBinding(button, b))).toBe(true);
	});

	test("a control it has no default for is not a default, and asking is not a crash", () => {
		// The table is keyed by strings, and a name that is not in it has no default
		// to compare against — an answer, and one `/gamepad status` has to survive:
		// the row it is comparing is whatever the caller's map holds, and a map built
		// in code (a test, an embedder) is not proof that a name is a control.
		expect(isDefaultBinding("nonesuch", { kind: "confirm" })).toBe(false);
		// And the surface's gestures are in that table with the buttons, so a gesture
		// nobody touched reads as the default it is.
		expect(isDefaultBinding("touch-tap", { kind: "confirm" })).toBe(true);
	});

	test("reads enabled strictly, so a settings object built in code cannot turn it on", () => {
		// The schema rejects a string, but a test or an embedder can still hand this
		// function an object it did not come from zod, and "enabled: \"no\"" reading
		// as on is a controller claimed by a file that said not to.
		const handmade = { gamepad: { enabled: "yes" } } as unknown as Settings;
		expect(padConfigFrom(handmade).enabled).toBe(false);
	});

	test("an unreadable override costs that button and nothing else", () => {
		const config = padConfigFrom(settings({ gamepad: { bindings: { cros: "confirm", cross: "fly" } } }));
		expect(config.problems).toHaveLength(2);
		expect(config.problems.join("\n")).toContain("cros");
		expect(config.problems.join("\n")).toContain("fly");
		// The defaults are intact — including for the two buttons the user tried to
		// change, because a typo must not leave them unbound.
		expect(bindingText(config.bindings.cross)).toBe("confirm");
		expect(Object.entries(config.bindings).every(([button, b]) => isDefaultBinding(button, b))).toBe(true);
	});

	test("a command binding is checked against the commands this session has", () => {
		const bindings = { r2: "command:/nope" };
		expect(padConfigFrom(settings({ gamepad: { bindings } }), ["/help", "/status"]).problems).toHaveLength(1);
		expect(padConfigFrom(settings({ gamepad: { bindings } }), ["/help", "/nope"]).problems).toEqual([]);
		// Without a list there is nothing to check against, and a command nobody can
		// dispatch today may be a skill that is not installed today.
		expect(padConfigFrom(settings({ gamepad: { bindings } })).problems).toEqual([]);
	});

	test("phrases default to none rather than to undefined", () => {
		expect(padConfigFrom(settings({ gamepad: {} })).phrases).toEqual([]);
	});

	test("the motors and the light are on unless the file says otherwise", () => {
		// Both default to on, which is the opposite of `enabled` and `allowApprove`
		// above — so the read is `!== false`, and the test is written the way the user
		// meets it: say nothing and the pad is as loud as it has always been, say
		// false and it goes quiet.
		const untouched = padConfigFrom(settings({ gamepad: { enabled: true } }));
		expect(untouched.rumble).toBe(true);
		expect(untouched.lightbar).toBe(true);
		const quiet = padConfigFrom(settings({ gamepad: { rumble: false, lightbar: false } }));
		expect(quiet.rumble).toBe(false);
		expect(quiet.lightbar).toBe(false);
		// Each switch its own decision: a pad whose bar you can live with and whose
		// motors you cannot is the common case, not a contradiction.
		const half = padConfigFrom(settings({ gamepad: { rumble: false } }));
		expect(half.rumble).toBe(false);
		expect(half.lightbar).toBe(true);
	});

	test("a switch written as something other than a boolean leaves the pad on", () => {
		// The mirror of the strict read above, and for the same reason: an object that
		// did not come from zod is not proof of anything, and a value nobody can read
		// must not be the thing that silences a controller — the documentation says on.
		const handmade = { gamepad: { rumble: "off", lightbar: 0 } } as unknown as Settings;
		expect(padConfigFrom(handmade).rumble).toBe(true);
		expect(padConfigFrom(handmade).lightbar).toBe(true);
	});

	test("the device filter and deadzone are passed through as written", () => {
		const config = padConfigFrom(settings({ gamepad: { device: "  wireless  ", deadzone: 0.4 } }));
		expect(config.device).toBe("  wireless  ");
		expect(config.deadzone).toBe(0.4);
	});

	test("every action kind is writable in the file and reads back as written", () => {
		// The round trip a user performs: copy a name out of `/gamepad` into
		// settings.json and have the same name come back. A kind that resolved but
		// printed differently would make the table a lie.
		for (const kind of PAD_ACTION_KINDS) {
			const { bindings, problems } = resolveBindings({ cross: kind });
			expect(problems, `${kind} should resolve`).toEqual([]);
			expect(bindingText(bindings.cross)).toBe(kind);
		}
		const { bindings, problems } = resolveBindings({ touchpad: "command:/cost" });
		expect(problems).toEqual([]);
		expect(bindingText(bindings.touchpad)).toBe("command:/cost");
	});
});

describe("what the user is told when the pad does not come up", () => {
	test("a missing optional dependency is named, and not dressed as a search", () => {
		const notice = padStartupNotice({ phase: "off", detail: "node-hid is not installed — run `pnpm add …`" });
		expect(notice).toContain("node-hid is not installed");
		expect(notice).not.toContain("looking again");
	});

	test("a controller that is not attached is a search, and says so", () => {
		const notice = padStartupNotice({ phase: "searching", detail: "no DualShock 4 attached" });
		expect(notice).toContain("no DualShock 4 attached");
		expect(notice).toContain("looking again every few seconds");
	});

	test("a connected pad is not news, so there is nothing to say", () => {
		expect(padStartupNotice({ phase: "connected" })).toBeUndefined();
	});
});

describe("describePadDevice, as /gamepad list prints it", () => {
	test("names the model and which interface it is", () => {
		const text = describePadDevice({ vendorId: 0x054c, productId: 0x09cc, path: "hid#vid_054c", interface: 3 });
		expect(text).toContain("DualShock");
		expect(text).toContain("interface 3");
	});

	test("a device another program holds is named as that, not as missing", () => {
		const text = describePadDevice({ vendorId: 0x054c, productId: 0x09cc });
		expect(text).toContain("held by another program");
	});
});
