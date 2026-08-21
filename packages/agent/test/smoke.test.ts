import { describe, expect, test } from "bun:test";
import { AGENT_PACKAGE_VERSION } from "../src/index.ts";

describe("@labunbun/agent smoke", () => {
	test("exports a version", () => {
		expect(AGENT_PACKAGE_VERSION).toBe("0.1.0");
	});
});
