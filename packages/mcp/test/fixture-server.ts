/**
 * Minimal MCP stdio fixture server for tests: exposes `echo`, a deliberately
 * slow `sleep` (what cancellation and timeout tests race against), `big` (a
 * result far past the pipeline's per-result budget), `shape` (one input
 * schema per JSON Schema construct the client's mapping supports) and the
 * three `add-*` tools, which change one of this server's lists and announce it
 * with the matching `list_changed` notification — what the client's refresh
 * handlers are tested against. It also serves a prompt and two resources (one
 * text, one blob) for the `/mcp` read paths. Run directly — it speaks JSON-RPC
 * over stdio via the MCP SDK.
 *
 * The `fail-refresh` argument makes every list request after an `add-*` call
 * fail: the first walk succeeds and the refresh does not, which is the shape a
 * test needs to see the last good snapshot survive a broken re-list. The
 * `stall-read` argument answers everything except `resources/read`, which it
 * holds open forever — the shape of a server that accepts a request and never
 * answers it, which only a request-level timeout can end. The `reject-tools`
 * argument fails `tools/list` from the very first call, so the connection is
 * accepted and the first list refused — the connect-succeeds, discovery-fails
 * shape. `exit-marker <path>` writes that path when this server's stdin
 * reaches EOF: the server's own account of the client having let it go, which
 * is the only closure it can observe from outside. `stderr-noise <bytes>`
 * writes that many bytes of log lines to stderr at start-up and again on every
 * `echo` — a server that logs where a terminal would be listening.
 */
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const failAfterChange = process.argv.includes("fail-refresh");
const stallRead = process.argv.includes("stall-read");
/** Refuse every `tools/list`, the first one included: connect succeeds, discovery does not. */
const rejectTools = process.argv.includes("reject-tools");

// `exit-marker <path>`: the client letting this process go arrives as stdin
// reaching EOF (a kill arrives as a signal, with no chance to write), so that
// is the moment the file is written. `exit` is the backstop for an exit path
// that skips the stream event.
const markerIndex = process.argv.indexOf("exit-marker");
const exitMarker = markerIndex === -1 ? undefined : process.argv[markerIndex + 1];
if (exitMarker) {
	const markReleased = () => {
		try {
			writeFileSync(exitMarker, "stdin closed");
		} catch {}
	};
	process.stdin.on("end", markReleased);
	process.on("exit", markReleased);
}

const noiseIndex = process.argv.indexOf("stderr-noise");
const noiseBytes = noiseIndex === -1 ? 0 : Number(process.argv[noiseIndex + 1]);
const NOISE_LINE = "fixture log line that nobody asked for\n";
/** A burst of log lines on stderr, if the run asked for one. */
function makeNoise(): void {
	if (noiseBytes > 0) process.stderr.write(NOISE_LINE.repeat(Math.ceil(noiseBytes / NOISE_LINE.length)));
}
makeNoise();

const BASE_TOOLS = [
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
	{
		name: "add-tool",
		description: "Adds a tool and announces it with notifications/tools/list_changed",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "add-prompt",
		description: "Adds a prompt and announces it with notifications/prompts/list_changed",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "add-resource",
		description: "Adds a resource and announces it with notifications/resources/list_changed",
		inputSchema: { type: "object", properties: {} },
	},
];

/** Tools `add-tool` appends; they are callable like any other. */
const addedTools: Array<{ name: string; description: string; inputSchema: { type: string; properties: object } }> = [];
/** Prompts `add-prompt` appends. */
const addedPrompts: Array<{ name: string; description: string }> = [];
/** Resources `add-resource` appends. */
const addedResources: Array<{ uri: string; name: string; mimeType: string }> = [];
/** Set by any `add-*` call under `fail-refresh`: every later list refuses. */
let listsBroken = false;

const server = new Server(
	{ name: "fixture", version: "0.1.0" },
	{ capabilities: { tools: {}, prompts: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
	if (rejectTools) throw new Error("tools/list rejected by the server");
	if (listsBroken) throw new Error("tools/list is refusing after the change");
	return { tools: [...BASE_TOOLS, ...addedTools] };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
	if (listsBroken) throw new Error("prompts/list is refusing after the change");
	return {
		prompts: [
			{
				name: "greet",
				description: "Greets someone by name",
				arguments: [{ name: "name", description: "Who to greet", required: true }],
			},
			...addedPrompts,
		],
	};
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
	if (request.params.name !== "greet") return { messages: [] };
	// Everything the caller passed, echoed back: a test asserting on the reply
	// is really asserting on what went over the wire.
	const args = Object.entries((request.params.arguments ?? {}) as Record<string, string>)
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");
	return {
		description: "Greets someone by name",
		messages: [
			{ role: "user" as const, content: { type: "text" as const, text: `greet ${args}`.trimEnd() } },
			{ role: "assistant" as const, content: { type: "text" as const, text: "hello" } },
		],
	};
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
	if (listsBroken) throw new Error("resources/list is refusing after the change");
	return {
		resources: [
			{ uri: "file:///fixture/note.txt", name: "note.txt", mimeType: "text/plain" },
			{ uri: "file:///fixture/blob.bin", name: "blob.bin", mimeType: "application/octet-stream" },
			...addedResources,
		],
	};
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	if (stallRead) await new Promise(() => {});
	const { uri } = request.params;
	if (uri === "file:///fixture/note.txt") {
		return { contents: [{ uri, mimeType: "text/plain", text: "the note body" }] };
	}
	if (uri === "file:///fixture/blob.bin") {
		return {
			contents: [{ uri, mimeType: "application/octet-stream", blob: Buffer.from("blob bytes").toString("base64") }],
		};
	}
	throw new Error(`unknown resource ${uri}`);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name === "echo") {
		const text = String((request.params.arguments as { text?: string })?.text ?? "");
		makeNoise();
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
	if (request.params.name === "add-tool") {
		const name = `late-${addedTools.length + 1}`;
		addedTools.push({
			name,
			description: "Added after connect",
			inputSchema: { type: "object", properties: {} },
		});
		if (failAfterChange) listsBroken = true;
		await server.sendToolListChanged();
		return { content: [{ type: "text", text: `added ${name}` }] };
	}
	if (request.params.name === "add-prompt") {
		const name = `late-prompt-${addedPrompts.length + 1}`;
		addedPrompts.push({ name, description: "Added after connect" });
		if (failAfterChange) listsBroken = true;
		await server.sendPromptListChanged();
		return { content: [{ type: "text", text: `added ${name}` }] };
	}
	if (request.params.name === "add-resource") {
		const name = `late-resource-${addedResources.length + 1}`;
		addedResources.push({ uri: `file:///fixture/${name}`, name, mimeType: "text/plain" });
		if (failAfterChange) listsBroken = true;
		await server.sendResourceListChanged();
		return { content: [{ type: "text", text: `added ${name}` }] };
	}
	if (request.params.name.startsWith("late-")) {
		return { content: [{ type: "text", text: `${request.params.name} answered` }] };
	}
	return { content: [{ type: "text", text: `unknown tool ${request.params.name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
