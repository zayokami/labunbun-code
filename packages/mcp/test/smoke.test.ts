import { describe, expect, test } from "bun:test";
import { MCP_PACKAGE_VERSION } from "../src/index.ts";

describe("@labunbun/mcp smoke", () => {
	test("exports a version", () => {
		expect(MCP_PACKAGE_VERSION).toBe("0.1.0");
	});
});
