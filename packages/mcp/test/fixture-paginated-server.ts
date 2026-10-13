/**
 * An MCP stdio fixture that hands its lists out one page at a time.
 *
 * The other fixture answers `tools/list` in one result, which is the shape a
 * small server has and the shape a client that ignores `nextCursor` looks
 * correct against. This one is only ever correct seen whole: it serves five
 * tools and three prompts two per page, so a client that reads the first page
 * and stops has half the tools and no way to notice.
 *
 * `repeat` mode is the other failure a cursor loop has to survive: a server
 * that never says the list ended. Every answer points at the second page, so
 * the cursor the client is handed back is one it has already used. The pages
 * stay distinct so the test can count what was collected, and the cursor
 * terminates nothing — a client that trusts it loops until something else
 * stops it.
 *
 * Run directly — it speaks JSON-RPC over stdio via the MCP SDK.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListPromptsRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAMES = ["one", "two", "three", "four", "five"];
const PROMPT_NAMES = ["alpha", "beta", "gamma"];
const PAGE_SIZE = 2;

const repeatsCursor = process.argv.includes("repeat");

/** The cursor `repeat` mode hands back forever: the one that names the second page. */
const REPEATED_CURSOR = "1";

const server = new Server(
	{ name: "paginated-fixture", version: "0.1.0" },
	{ capabilities: { tools: {}, prompts: {} } },
);

/** `count` is how many of `all` this page holds; `page` is the cursor it came from. */
function slice<T>(all: readonly T[], page: number): T[] {
	return all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
	const page = Number(request.params?.cursor ?? 0);
	const tools = slice(TOOL_NAMES, page).map((name) => ({
		name,
		description: `tool ${name}`,
		inputSchema: { type: "object", properties: {} },
	}));
	const next = page + 1;
	if (repeatsCursor) return { tools, nextCursor: REPEATED_CURSOR };
	return next * PAGE_SIZE < TOOL_NAMES.length ? { tools, nextCursor: String(next) } : { tools };
});

server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
	const page = Number(request.params?.cursor ?? 0);
	const prompts = slice(PROMPT_NAMES, page).map((name) => ({ name, description: `prompt ${name}` }));
	const next = page + 1;
	if (repeatsCursor) return { prompts, nextCursor: REPEATED_CURSOR };
	return next * PAGE_SIZE < PROMPT_NAMES.length ? { prompts, nextCursor: String(next) } : { prompts };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
	content: [{ type: "text", text: `called ${request.params.name}` }],
}));

await server.connect(new StdioServerTransport());
