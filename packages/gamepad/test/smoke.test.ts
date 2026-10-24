import { describe, expect, test } from "bun:test";
import { GAMEPAD_PACKAGE_VERSION, PAD_ACTION_KINDS, PAD_DIRECTIONS } from "../src/index.ts";

describe("@labunbun/gamepad smoke", () => {
	test("exports a version", () => {
		expect(GAMEPAD_PACKAGE_VERSION).toBe("0.1.0.1");
	});

	test("the navigation slots are the directional actions, through the barrel", () => {
		// The bindings comment says the four slots are deliberately the four
		// directional actions. A consumer can only observe that through the
		// barrel, so that is where this reads it from.
		expect(PAD_DIRECTIONS).toEqual(["up", "down", "left", "right"]);
		for (const direction of PAD_DIRECTIONS) expect(PAD_ACTION_KINDS).toContain(direction);
	});
});
