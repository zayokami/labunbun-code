/**
 * Tool annotations are the server's declaration of how a tool behaves.
 * `adaptTools` mirrors `annotations.readOnlyHint` into both `isReadOnly` and
 * `isConcurrencySafe`; absent or false keeps the fail-closed default, and
 * `destructiveHint`/`idempotentHint` do not loosen either answer.
 *
 * The fixture server is this file itself. Spawned with `--annotations-fixture`
 * it lists five tools covering the matrix and answers calls; `bun test` never
 * takes that branch. This exercises the whole path — `tools/list` through the
 * SDK's parse into `adaptTools` — rather than a hand-built definitions array,
 * so an annotation dropped on the wire would fail here.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { connectMcpServer, disconnectAllMcpServers } from "../src/client.ts";

const FIXTURE_FLAG = "--annotations-fixture";

if (process.argv.includes(FIXTURE_FLAG)) {
	const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
	const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
	const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

	const emptySchema = { type: "object", properties: {} };
	const server = new Server({ name: "annotations-fixture", version: "0.1.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{ name: "plain", description: "No annotations at all", inputSchema: emptySchema },
			{
				name: "reader",
				description: "Declares readOnlyHint true",
				inputSchema: emptySchema,
				annotations: { readOnlyHint: true },
			},
			{
				name: "writer",
				description: "Declares readOnlyHint false",
				inputSchema: emptySchema,
				annotations: { readOnlyHint: false },
			},
			{
				name: "destroyer",
				description: "Declares destructiveHint true, readOnlyHint absent",
				inputSchema: emptySchema,
				annotations: { destructiveHint: true },
			},
			{
				name: "repeatable",
				description: "Declares idempotentHint true, readOnlyHint absent",
				inputSchema: emptySchema,
				annotations: { idempotentHint: true },
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => ({
		content: [{ type: "text", text: `${request.params.name} answered` }],
	}));

	await server.connect(new StdioServerTransport());
} else {
	const FIXTURE_SERVER = join(import.meta.dir, "tool-annotations.test.ts");

	describe("MCP tool annotations", () => {
		test("readOnlyHint is mirrored; absent, false, destructive and idempotent stay fail-closed", async () => {
			const connection = await connectMcpServer("annotated", {
				command: process.execPath,
				args: [FIXTURE_SERVER, FIXTURE_FLAG],
			});

			try {
				if (connection.error) throw new Error(`fixture failed: ${connection.error}`);

				const tools = new Map(connection.tools.map((tool) => [tool.name, tool]));
				expect([...tools.keys()].sort()).toEqual([
					"mcp__annotated__destroyer",
					"mcp__annotated__plain",
					"mcp__annotated__reader",
					"mcp__annotated__repeatable",
					"mcp__annotated__writer",
				]);

				const answers = (name: string) => {
					const tool = tools.get(`mcp__annotated__${name}`);
					if (!tool) throw new Error(`tool ${name} missing from the adapted list`);
					return { isReadOnly: tool.isReadOnly?.({}), isConcurrencySafe: tool.isConcurrencySafe?.({}) };
				};

				expect(answers("plain")).toEqual({ isReadOnly: false, isConcurrencySafe: false });
				expect(answers("reader")).toEqual({ isReadOnly: true, isConcurrencySafe: true });
				expect(answers("writer")).toEqual({ isReadOnly: false, isConcurrencySafe: false });
				expect(answers("destroyer")).toEqual({ isReadOnly: false, isConcurrencySafe: false });
				expect(answers("repeatable")).toEqual({ isReadOnly: false, isConcurrencySafe: false });
			} finally {
				await disconnectAllMcpServers([connection]);
			}
		});
	});
}
