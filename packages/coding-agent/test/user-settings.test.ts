/**
 * Writing to the user's own settings file from inside a session.
 *
 * Every writer here is a read-merge-write, and the two merge depths are the
 * whole subject: `writeUserSettingsPatch` replaces a top-level key, which is
 * right for `theme` and `model` (there is nothing inside a string to preserve)
 * and destructive for `gamepad`, where the sub-keys are the settings a user
 * typed by hand. `/gamepad off` deleting someone's `bindings` on its way past is
 * the bug the nested writer exists to prevent, so it is the one thing tested
 * hardest here — against a throwaway home, never the real one.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeUserSettingsNestedPatch, writeUserSettingsPatch } from "../src/user-settings.ts";

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "lbb-settings-"));
}

function settingsPath(home: string): string {
	return join(home, ".labunbun", "settings.json");
}

/** Put a settings file (or something pretending to be one) in place. */
function seed(home: string, contents: string): void {
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(settingsPath(home), contents, "utf8");
}

function saved(home: string): Record<string, unknown> {
	return JSON.parse(readFileSync(settingsPath(home), "utf8"));
}

describe("writeUserSettingsNestedPatch", () => {
	test("keeps the sub-keys the patch does not mention", () => {
		const home = tempHome();
		seed(
			home,
			JSON.stringify({
				gamepad: { enabled: true, bindings: { cross: "command:/status" }, phrases: ["run the tests"] },
			}),
		);

		writeUserSettingsNestedPatch("gamepad", { enabled: false }, home);

		expect(saved(home)).toEqual({
			gamepad: { enabled: false, bindings: { cross: "command:/status" }, phrases: ["run the tests"] },
		});
	});

	test("keeps a sub-key this version of labunbun knows nothing about", () => {
		// A field another tool wrote, or a field a later version added and this one
		// would not recognize: it is the user's file, and not ours to prune.
		const home = tempHome();
		seed(home, JSON.stringify({ gamepad: { rumbleScale: 0.4 } }));

		writeUserSettingsNestedPatch("gamepad", { enabled: true }, home);

		expect(saved(home)).toEqual({ gamepad: { rumbleScale: 0.4, enabled: true } });
	});

	test("keeps every other top-level key", () => {
		const home = tempHome();
		seed(home, JSON.stringify({ theme: "nord", model: "kimi/kimi-k2", gamepad: { enabled: true } }));

		writeUserSettingsNestedPatch("gamepad", { allowApprove: true }, home);

		expect(saved(home).theme).toBe("nord");
		expect(saved(home).model).toBe("kimi/kimi-k2");
		expect(saved(home).gamepad).toEqual({ enabled: true, allowApprove: true });
	});

	test("an explicit undefined removes a sub-key, which is how a caller un-sets one", () => {
		// JSON has no `undefined`, so the key is simply absent afterwards.
		const home = tempHome();
		seed(home, JSON.stringify({ gamepad: { enabled: true, device: "wireless" } }));

		writeUserSettingsNestedPatch("gamepad", { device: undefined }, home);

		expect(saved(home)).toEqual({ gamepad: { enabled: true } });
		expect("device" in (saved(home).gamepad as object)).toBe(false);
	});

	test("replaces, rather than merges into, a key that is not an object", () => {
		// A hand-written `"gamepad": true` has nothing to merge into. Spreading it
		// would throw; pretending it was empty and keeping it around would leave the
		// file with two contradictory answers.
		const home = tempHome();
		seed(home, JSON.stringify({ gamepad: true }));

		writeUserSettingsNestedPatch("gamepad", { enabled: true }, home);

		expect(saved(home)).toEqual({ gamepad: { enabled: true } });
	});

	test("writes the block into a home with no settings file at all", () => {
		const home = tempHome();
		writeUserSettingsNestedPatch("gamepad", { enabled: true }, home);
		expect(saved(home)).toEqual({ gamepad: { enabled: true } });
	});

	test("reads a file saved by an editor that wrote a BOM", () => {
		const home = tempHome();
		seed(home, `﻿${JSON.stringify({ theme: "nord" })}`);

		writeUserSettingsNestedPatch("gamepad", { enabled: true }, home);

		expect(saved(home)).toEqual({ theme: "nord", gamepad: { enabled: true } });
	});

	test("refuses to write over a file it cannot parse", () => {
		// Merging into a file nobody could read is how a broken settings file
		// becomes an emptied one: the user's own recovery is to fix the JSON, so the
		// bytes have to still be there to fix.
		const home = tempHome();
		seed(home, '{ "theme": "nord", }');

		expect(() => writeUserSettingsNestedPatch("gamepad", { enabled: true }, home)).toThrow(/not valid JSON/);
		expect(readFileSync(settingsPath(home), "utf8")).toBe('{ "theme": "nord", }');
	});
});

describe("writeUserSettingsPatch", () => {
	test("replaces a top-level key wholesale — the reason the nested writer exists", () => {
		const home = tempHome();
		seed(home, JSON.stringify({ gamepad: { bindings: { cross: "none" } } }));

		writeUserSettingsPatch({ gamepad: { enabled: true } }, home);

		expect(saved(home)).toEqual({ gamepad: { enabled: true } });
	});

	test("a patch left out of the call leaves that key alone", () => {
		const home = tempHome();
		seed(home, JSON.stringify({ theme: "nord", vimMode: true }));

		writeUserSettingsPatch({ model: "kimi/kimi-k2" }, home);

		expect(saved(home)).toEqual({ theme: "nord", vimMode: true, model: "kimi/kimi-k2" });
	});
});
