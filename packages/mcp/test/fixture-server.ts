/**
 * Minimal MCP stdio fixture server for tests: exposes one `echo` tool.
 * Run directly — it speaks JSON-RPC over stdio via the MCP SDK.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Echoes its text input back",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name === "echo") {
		const text = String((request.params.arguments as { text?: string })?.text ?? "");
		return { content: [{ type: "text", text: `echo: ${text}` }] };
	}
	return { content: [{ type: "text", text: `unknown tool ${request.params.name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
