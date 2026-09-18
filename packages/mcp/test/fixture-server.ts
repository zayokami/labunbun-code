/**
 * Minimal MCP stdio fixture server for tests: exposes `echo` and a deliberately
 * slow `sleep` tool (the slow one is what cancellation tests abort against).
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
		{
			name: "sleep",
			description: "Waits the requested number of milliseconds before answering",
			inputSchema: {
				type: "object",
				properties: { ms: { type: "number" } },
				required: ["ms"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name === "echo") {
		const text = String((request.params.arguments as { text?: string })?.text ?? "");
		return { content: [{ type: "text", text: `echo: ${text}` }] };
	}
	if (request.params.name === "sleep") {
		const ms = Number((request.params.arguments as { ms?: number })?.ms ?? 0);
		await new Promise((resolve) => setTimeout(resolve, ms));
		return { content: [{ type: "text", text: `slept ${ms}ms` }] };
	}
	return { content: [{ type: "text", text: `unknown tool ${request.params.name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
