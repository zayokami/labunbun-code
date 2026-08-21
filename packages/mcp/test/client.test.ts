import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { connectMcpServer, loadMcpConfig, McpServerConfigSchema } from "../src/client.ts";

const FIXTURE_SERVER = join(
	dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
	"fixture-server.ts",
);

describe("McpServerConfigSchema", () => {
	test("stdio and http variants", () => {
		expect(McpServerConfigSchema.safeParse({ command: "bun", args: ["x.ts"] }).success).toBe(true);
		expect(McpServerConfigSchema.safeParse({ url: "https://example.com/mcp" }).success).toBe(true);
		expect(McpServerConfigSchema.safeParse({ url: "not a url" }).success).toBe(false);
	});
});

describe("connectMcpServer (fixture stdio server)", () => {
	test("lists tools and calls one through the full pipeline", async () => {
		const connection = await connectMcpServer("fixture", {
			command: process.execPath,
			args: [FIXTURE_SERVER],
		});

		if (connection.error) {
			// Environment without bun runtime spawn permissions — surface clearly.
			throw new Error(`fixture failed: ${connection.error}`);
		}

		expect(connection.tools).toHaveLength(1);
		const tool = connection.tools[0];
		expect(tool.name).toBe("mcp__fixture__echo");

		const result = await tool.call(
			{ text: "hello mcp" },
			{
				callId: "t1",
				signal: new AbortController().signal,
				cwd: process.cwd(),
				onUpdate: () => {},
			},
		);
		expect(result.isError).toBeFalsy();
		expect((result.content[0] as any).text).toContain("hello mcp");
	}, 20_000);

	test("invalid config yields error connection, not a throw", async () => {
		const connection = await connectMcpServer("bad", { command: "" } as never);
		expect(connection.error).toBeDefined();
	});
});

describe("loadMcpConfig", () => {
	test("returns empty object when no config files exist", () => {
		const configs = loadMcpConfig("/nonexistent-path-xyz");
		expect(Object.keys(configs)).toHaveLength(0);
	});
});
