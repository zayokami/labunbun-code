import { describe, expect, test } from "bun:test";
import { CLI_NAME, CODING_AGENT_VERSION } from "../src/index.ts";
import { main } from "../src/main.ts";

describe("@labunbun/coding-agent smoke", () => {
	test("reports its version", () => {
		expect(CODING_AGENT_VERSION).toBe("0.1.0");
		expect(CLI_NAME).toBe("labunbun");
	});

	test("--version exits cleanly", async () => {
		const exitCode = await main(["--version"]);
		expect(exitCode).toBe(0);
	});
});
