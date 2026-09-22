/**
 * What a repository may set for itself, held against the settings schema.
 *
 * The list of keys a project or local file may not set is a list of names, and a
 * list of names drifts: the keys are added to `SettingsSchema` at a different
 * moment, by a different change, than they are classified here — and the
 * unclassified case fails open, because the filter only removes what it was told
 * about. `pricing` is the shape of it: a repo that could declare its own model
 * costs nothing looks like a settings bug and bills like a real one.
 *
 * The type (`Record<keyof Settings, …>`) already makes an omission a compile
 * error. These tests are the same statement at runtime, where it also covers the
 * other direction — a row for a key the schema no longer has, which is how a
 * list keeps looking maintained after it stopped being true.
 */
import { describe, expect, test } from "bun:test";
import { PROJECT_TIER_KEY_POLICY, PROJECT_TIER_PERMISSION_KEY_POLICY, SettingsSchema } from "../src/settings.ts";

const SCHEMA_KEYS = Object.keys(SettingsSchema.shape);

describe("the project tier's key policy", () => {
	test("classifies every key the settings schema has", () => {
		const classified = new Set(Object.keys(PROJECT_TIER_KEY_POLICY));
		const unclassified = SCHEMA_KEYS.filter((key) => !classified.has(key));
		expect(unclassified, "decide whether a repository may set these, in PROJECT_TIER_KEY_POLICY").toEqual([]);
	});

	test("classifies nothing the schema does not have", () => {
		const schemaKeys = new Set(SCHEMA_KEYS);
		const dead = Object.keys(PROJECT_TIER_KEY_POLICY).filter((key) => !schemaKeys.has(key));
		expect(dead, "these rows name keys no settings file can hold").toEqual([]);
	});

	test("the classification is a decision, not a default", () => {
		// Pinned so that moving one of them is an edit here as well, in front of
		// whoever moves it: these are the keys a cloned repository must not set.
		for (const key of [
			"model",
			"fallbackModels",
			"permissionMode",
			"env",
			"providers",
			"hooks",
			"mcpServers",
			"pricing",
			"cache",
			"trimOldToolResults",
			"modelDiscovery",
			"gamepad",
			"allowManagedPermissionRulesOnly",
			"disableBypassPermissionsMode",
		]) {
			expect(PROJECT_TIER_KEY_POLICY, key).toMatchObject({ [key]: "denied" });
		}
		// And the two that are nobody's business but the terminal's.
		expect(PROJECT_TIER_KEY_POLICY.theme).toBe("repo");
		expect(PROJECT_TIER_KEY_POLICY.vimMode).toBe("repo");
	});

	test("permissions is classified sub-key by sub-key", () => {
		// Read off a parsed default rather than the schema's internals: the keys a
		// settings file can hold are the keys the parse produces.
		const subKeys = Object.keys(SettingsSchema.parse({}).permissions);
		expect([...subKeys].sort()).toEqual(["additionalDirectories", "allow", "deny"]);
		expect(Object.keys(PROJECT_TIER_PERMISSION_KEY_POLICY).sort()).toEqual([...subKeys].sort());
		// Tightening is always safe; both widening keys are not.
		expect(PROJECT_TIER_PERMISSION_KEY_POLICY.deny).toBe("repo");
		expect(PROJECT_TIER_PERMISSION_KEY_POLICY.allow).toBe("denied");
		expect(PROJECT_TIER_PERMISSION_KEY_POLICY.additionalDirectories).toBe("denied");
	});
});
