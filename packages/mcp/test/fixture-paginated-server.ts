/**
 * An MCP stdio fixture that hands its lists out one page at a time.
 *
 * The other fixture answers `tools/list` in one result, which is the shape a
 * small server has and the shape a client that ignores `nextCursor` looks
 * correct against. This one is only ever correct seen whole: it serves six
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
 * Calling `bump` adds two more tools and announces them with
 * `notifications/tools/list_changed`: after that there are four pages, so a
 * refresh that trusts one page sees a quarter of the list — the reason the
 * client's refresh walks every page rather than calling `tools/list` once.
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

const TOOL_NAMES = ["one", "two", "three", "four", "five", "bump"];
const PROMPT_NAMES = ["alpha", "beta", "gamma"];
const PAGE_SIZE = 2;

const repeatsCursor = process.argv.includes("repeat");

/** The cursor `repeat` mode hands back forever: the one that names the second page. */
const REPEATED_CURSOR = "1";

/** Tools `bump` appends, one page's worth each side of the announcement. */
const extraToolNames: string[] = [];

const server = new Server(
	{ name: "paginated-fixture", version: "0.1.0" },
	{ capabilities: { tools: {}, prompts: {} } },
);

/** `count` is how many of `all` this page holds; `page` is the cursor it came from. */
function slice<T>(all: readonly T[], page: number): T[] {
	return all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
	const all = [...TOOL_NAMES, ...extraToolNames];
	const page = Number(request.params?.cursor ?? 0);
	const tools = slice(all, page).map((name) => ({
		name,
		description: `tool ${name}`,
		inputSchema: { type: "object", properties: {} },
	}));
	const next = page + 1;
	if (repeatsCursor) return { tools, nextCursor: REPEATED_CURSOR };
	return next * PAGE_SIZE < all.length ? { tools, nextCursor: String(next) } : { tools };
});

server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
	const page = Number(request.params?.cursor ?? 0);
	const prompts = slice(PROMPT_NAMES, page).map((name) => ({ name, description: `prompt ${name}` }));
	const next = page + 1;
	if (repeatsCursor) return { prompts, nextCursor: REPEATED_CURSOR };
	return next * PAGE_SIZE < PROMPT_NAMES.length ? { prompts, nextCursor: String(next) } : { prompts };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name === "bump") {
		// Two names, so the change spans page boundaries: page three alone would
		// miss everything past it.
		const first = extraToolNames.length;
		extraToolNames.push(`six-${first}`, `seven-${first}`);
		await server.sendToolListChanged();
		return { content: [{ type: "text", text: "bumped" }] };
	}
	return { content: [{ type: "text", text: `called ${request.params.name}` }] };
});

await server.connect(new StdioServerTransport());
