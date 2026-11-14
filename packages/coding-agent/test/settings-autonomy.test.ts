/**
 * The autonomy key is one enum in three places: the settings schema, the
 * command's table, and the prompt. The prompt and command suites read the same
 * list; this file pins the schema and the tier policy, which is where a value
 * could be accepted by the app but never be settable.
 */
import { describe, expect, test } from "bun:test";
import {
	AUTONOMY_CHOICES,
	AUTONOMY_LEVELS,
	DEFAULT_AUTONOMY_LEVEL,
	describeAutonomyLevel,
	findAutonomyChoice,
	isAutonomyLevel,
} from "@labunbun/agent";
import { PROJECT_TIER_KEY_POLICY, SettingsSchema } from "../src/settings.ts";

describe("the autonomy setting", () => {
	test.each([...AUTONOMY_LEVELS])("accepts the level %s", (level) => {
		expect(SettingsSchema.parse({ autonomy: level }).autonomy).toBe(level);
	});

	test("unset is a state of its own, so the default is the prompt's to choose", () => {
		// The schema does not bake the default in: a later change to
		// DEFAULT_AUTONOMY_LEVEL must reach every session that never set the key,
		// and a zod default would freeze today's value in the parser.
		expect(SettingsSchema.parse({}).autonomy).toBeUndefined();
	});

	test("rejects a value that is not a level", () => {
		for (const value of ["turbo", "auto", "yolo", "", 1, true]) {
			expect(SettingsSchema.safeParse({ autonomy: value }).success).toBe(false);
		}
	});

	test("a project may not choose the user's decision posture", () => {
		// A cloned repository that could raise this would be quieting the
		// questions its own code provokes; lowering it would spend the user's
		// judgment on the checkout's work. It belongs to the user and policy
		// tiers, like permissionMode and language.
		expect(PROJECT_TIER_KEY_POLICY.autonomy).toBe("denied");
	});
});

describe("the level list and its labels", () => {
	test("the choices cover every level exactly once", () => {
		// A choice missing from the table is an id `/autonomy` would accept and
		// then print without a label; a duplicate is two rows for one state.
		expect(AUTONOMY_CHOICES.map((choice) => choice.id).sort()).toEqual([...AUTONOMY_LEVELS].sort());
		expect(new Set(AUTONOMY_CHOICES.map((choice) => choice.id)).size).toBe(AUTONOMY_LEVELS.length);
	});

	test("every choice has a label and a hint worth printing", () => {
		for (const choice of AUTONOMY_CHOICES) {
			expect(choice.label.length).toBeGreaterThan(0);
			expect(choice.hint.length).toBeGreaterThan(20);
		}
	});

	test("the default is one of the levels and is the autonomous one", () => {
		expect(AUTONOMY_LEVELS).toContain(DEFAULT_AUTONOMY_LEVEL);
		expect(DEFAULT_AUTONOMY_LEVEL).toBe("autonomous");
	});

	test("the lookups behave at the edges", () => {
		expect(findAutonomyChoice("guided")?.id).toBe("guided");
		expect(findAutonomyChoice("turbo")).toBeUndefined();
		expect(describeAutonomyLevel("balanced")).toBe("Balanced");
		expect(isAutonomyLevel("autonomous")).toBe(true);
		expect(isAutonomyLevel("auto")).toBe(false);
		expect(isAutonomyLevel(undefined)).toBe(false);
	});
});
