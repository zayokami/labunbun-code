import { describe, expect, test } from "bun:test";
import { TOOLS_PACKAGE_VERSION } from "../src/index.ts";

describe("@labunbun/tools smoke", () => {
	test("exports a version", () => {
		expect(TOOLS_PACKAGE_VERSION).toBe("0.1.0");
	});
});
