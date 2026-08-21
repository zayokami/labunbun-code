import { describe, expect, test } from "bun:test";
import { AI_PACKAGE_VERSION } from "../src/index.ts";

describe("@labunbun/ai smoke", () => {
	test("exports a version", () => {
		expect(AI_PACKAGE_VERSION).toBe("0.1.0");
	});
});
