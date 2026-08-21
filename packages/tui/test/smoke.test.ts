import { describe, expect, test } from "bun:test";
import { TUI_PACKAGE_VERSION } from "../src/index.ts";

describe("@labunbun/tui smoke", () => {
	test("exports a version", () => {
		expect(TUI_PACKAGE_VERSION).toBe("0.1.0");
	});
});
