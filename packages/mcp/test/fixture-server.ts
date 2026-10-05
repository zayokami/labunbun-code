/**
 * Minimal MCP stdio fixture server for tests: exposes `echo`, a deliberately
 * slow `sleep` (what cancellation and timeout tests race against), `big` (a
 * result far past the pipeline's per-result budget) and `shape` (one input
 * schema per JSON Schema construct the client's mapping supports). Run
 * directly — it speaks JSON-RPC over stdio via the MCP SDK.
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
		{
			name: "big",
			description: "Returns 45,000 characters, far past the per-result budget",
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "shape",
			description: "Echoes its arguments back as JSON; exercises the schema mapping",
			inputSchema: {
				type: "object",
				properties: {
					mode: { type: "string", enum: ["fast", "slow"] },
					level: { type: ["integer", "null"] },
					tag: { oneOf: [{ type: "string" }, { type: "number" }] },
					note: { anyOf: [{ type: "string" }, { type: "boolean" }] },
					nums: { type: "array", items: { type: "number" } },
					pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
				},
				required: ["mode"],
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
	if (request.params.name === "big") {
		return { content: [{ type: "text", text: "b".repeat(45_000) }] };
	}
	if (request.params.name === "shape") {
		return { content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }] };
	}
	return { content: [{ type: "text", text: `unknown tool ${request.params.name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
