import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AgentDeps, type AnyTool, runToolPipeline, sanitizeCwd } from "@labunbun/agent";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	approveMcpServer,
	connectAllMcpServers,
	connectMcpServer,
	disconnectAllMcpServers,
	getPrompt,
	listPrompts,
	listResources,
	loadApprovedMcpServers,
	loadApprovedMcpServersWithStatus,
	loadMcpConfig,
	loadProjectMcpServerNames,
	type McpConnection,
	McpServerConfigSchema,
	readResource,
	sanitizeMcpError,
} from "../src/client.ts";

const TEST_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FIXTURE_SERVER = join(TEST_DIR, "fixture-server.ts");
const STALLING_SERVER = join(TEST_DIR, "fixture-stalling-server.ts");
const PAGINATED_SERVER = join(TEST_DIR, "fixture-paginated-server.ts");

function callCtx(overrides: { signal?: AbortSignal; onUpdate?: (update: any) => void } = {}) {
	return {
		callId: "t1",
		signal: overrides.signal ?? new AbortController().signal,
		cwd: process.cwd(),
		sandbox: "workspace-write" as const,
		network: { access: "enabled" as const, domains: [] },
		onUpdate: overrides.onUpdate ?? (() => {}),
	};
}

// The pipeline never reaches streamFn in these tests; a throwing placeholder
// proves it (the same minimal deps the agent's own pipeline tests use).
const NO_STREAM: AgentDeps = {
	streamFn: () => {
		throw new Error("streamFn must not be called by the pipeline");
	},
};

function pipelineCall(tool: AnyTool, rawInput: unknown) {
	return runToolPipeline({
		callId: "t1",
		tool,
		rawInput,
		deps: NO_STREAM,
		ctx: callCtx(),
		permissionContext: {
			mode: "ask" as const,
			sandbox: "workspace-write" as const,
			toolName: tool.name,
			input: rawInput,
			cwd: process.cwd(),
		},
		onUpdate: () => {},
	});
}

function resultText(message: { content: any[] }): string {
	return message.content.map((block) => (block.type === "text" ? String(block.text ?? "") : "")).join("");
}

/**
 * A condition that has to become true from the server's own asynchrony — a
 * notification arriving over stdio — rather than from anything the test can
 * await directly. Polled rather than slept for: a fixed sleep is either slower
 * than it needs to be or the flake.
 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

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

		expect(connection.tools.map((t) => t.name).sort()).toEqual([
			"mcp__fixture__add-prompt",
			"mcp__fixture__add-resource",
			"mcp__fixture__add-tool",
			"mcp__fixture__big",
			"mcp__fixture__echo",
			"mcp__fixture__shape",
			"mcp__fixture__sleep",
		]);
		const tool = connection.tools.find((t) => t.name === "mcp__fixture__echo");
		if (!tool) throw new Error("fixture echo tool missing");

		const result = await tool.call(
			{ text: "hello mcp" },
			{
				callId: "t1",
				signal: new AbortController().signal,
				cwd: process.cwd(),
				sandbox: "workspace-write" as const,
				network: { access: "enabled" as const, domains: [] },
				onUpdate: () => {},
			},
		);
		expect(result.isError).toBeFalsy();
		expect((result.content[0] as any).text).toContain("hello mcp");
	}, 20_000);

	test("an in-flight call is cancelled by the run's abort signal", async () => {
		// Without forwarding ctx.signal an Esc leaves the request in flight until
		// the server answers, so the parent's tool batch (and the "Running tools…"
		// spinner) stays blocked for as long as the server takes.
		const connection = await connectMcpServer("fixture", {
			command: process.execPath,
			args: [FIXTURE_SERVER],
		});
		if (connection.error) {
			throw new Error(`fixture failed: ${connection.error}`);
		}
		const sleepTool = connection.tools.find((t) => t.name === "mcp__fixture__sleep");
		if (!sleepTool) throw new Error("fixture sleep tool missing");

		const controller = new AbortController();
		const started = Date.now();
		const pending = sleepTool.call(
			{ ms: 5_000 },
			{
				callId: "t1",
				signal: controller.signal,
				cwd: process.cwd(),
				network: { access: "enabled" as const, domains: [] },
				sandbox: "workspace-write",
				onUpdate: () => {},
			},
		);
		setTimeout(() => controller.abort(), 150);
		const result = await pending;

		expect(Date.now() - started).toBeLessThan(3_000);
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toBe("Tool execution aborted");

		// The connection survives the cancel — later calls still go through.
		const after = await sleepTool.call(
			{ ms: 1 },
			{
				callId: "t2",
				signal: new AbortController().signal,
				cwd: process.cwd(),
				sandbox: "workspace-write",
				network: { access: "enabled" as const, domains: [] },
				onUpdate: () => {},
			},
		);
		expect(after.isError).toBeFalsy();
		expect((after.content[0] as any).text).toBe("slept 1ms");
	}, 20_000);

	test("invalid config yields error connection, not a throw", async () => {
		const connection = await connectMcpServer("bad", { command: "" } as never);
		expect(connection.error).toBeDefined();
	});
});

describe("connect timeout", () => {
	test("a server that accepts the connection but never answers is bounded, not a hang", async () => {
		const started = Date.now();
		const connection = await connectMcpServer(
			"stalling",
			{ command: process.execPath, args: [STALLING_SERVER] },
			{ timeoutMs: 750 },
		);
		const elapsed = Date.now() - started;

		expect(connection.error).toBeDefined();
		expect(connection.error).toContain("timed out");
		expect(connection.tools).toHaveLength(0);
		// Bounded by the budget rather than running to the default 30s.
		expect(elapsed).toBeLessThan(15_000);
	}, 30_000);

	test("a stalling server does not block other servers in the same batch", async () => {
		const connections = await connectAllMcpServers(
			{
				stalling: { command: process.execPath, args: [STALLING_SERVER] },
				working: { command: process.execPath, args: [FIXTURE_SERVER] },
			},
			undefined,
			{ timeoutMs: 5_000 },
		);
		const stalling = connections.find((c) => c.serverName === "stalling");
		const working = connections.find((c) => c.serverName === "working");
		expect(stalling?.error).toContain("timed out");
		expect(working?.error).toBeUndefined();
		expect(working?.tools.length).toBeGreaterThan(0);
	}, 30_000);
});

describe("a connect that fails after connecting", () => {
	// The connection completes and the first discovery request is refused — the
	// server is up and speaking, it just will not serve its list. The client
	// object is already live at that point, and the error connection that comes
	// back from this path carries `client: null`, so `disconnectAllMcpServers`
	// cannot close it later: the close has to happen on the way out or the stdio
	// child outlives the session with nothing left holding it.
	test("a refused tools/list returns an error connection and closes what it opened", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcp-orphan-"));
		const marker = join(dir, "stdin-closed.txt");
		const connection = await connectMcpServer(
			"refuser",
			{ command: process.execPath, args: [FIXTURE_SERVER, "reject-tools", "exit-marker", marker] },
			{ timeoutMs: 10_000 },
		);

		// The failure lands on the connection, not as a throw...
		expect(connection.client).toBeFalsy();
		expect(connection.error).toBeDefined();
		expect(connection.error).toContain("tools/list rejected");
		expect(connection.tools).toHaveLength(0);

		// ...and the server process was let go: the marker is the server's own
		// account of its stdin reaching EOF, which only a close can produce.
		// Without the close on this path the file never appears — nothing else
		// closes the client, and the test's wait is what notices.
		await waitFor(() => existsSync(marker));
		// The skip in disconnectAllMcpServers is why the close had to happen up
		// here: the error connection is inert by the time a caller sees it.
		await expect(disconnectAllMcpServers([connection])).resolves.toBeUndefined();
	}, 20_000);
});

describe("list pagination", () => {
	// The fixture serves five tools and three prompts, two per page. One page is
	// exactly what a client that ignores `nextCursor` collects, and it looks
	// like a complete answer: nothing in a tool list says how long it should be.
	test("every page of tools and prompts is collected, not just the first", async () => {
		const connection = await connectMcpServer("paginated", {
			command: process.execPath,
			args: [PAGINATED_SERVER],
		});
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);

		expect(connection.tools.map((t) => t.name).sort()).toEqual([
			"mcp__paginated__bump",
			"mcp__paginated__five",
			"mcp__paginated__four",
			"mcp__paginated__one",
			"mcp__paginated__three",
			"mcp__paginated__two",
		]);
		expect(connection.prompts.map((p) => p.name).sort()).toEqual(["alpha", "beta", "gamma"]);
	}, 20_000);

	// A cursor that never advances turns the loop into a busy wait against a
	// server that is answering, so the connect budget is not the backstop it is
	// for a server that says nothing: the loop has to notice on its own.
	test("a cursor the server repeats ends the walk instead of looping forever", async () => {
		// A budget far past the test's own timeout: if the walk does not end by
		// itself, this test hangs and fails rather than passing on a timeout.
		const connection = await connectMcpServer(
			"stuck",
			{ command: process.execPath, args: [PAGINATED_SERVER, "repeat"] },
			{ timeoutMs: 120_000 },
		);
		// Both distinct pages arrived...
		expect(connection.tools.map((t) => t.name).sort()).toEqual([
			"mcp__stuck__four",
			"mcp__stuck__one",
			"mcp__stuck__three",
			"mcp__stuck__two",
		]);
		// ...and the connection is usable rather than abandoned on a timeout.
		expect(connection.error).toBeUndefined();
	}, 20_000);
});

describe("list_changed notifications", () => {
	// The server announces the change itself; nothing polls it. Without a handler
	// the SDK drops the notification without a trace and the session serves the
	// connect-time list forever — the tests below are the ones that can tell the
	// two worlds apart.
	test("tools/list_changed rebuilds the connection's tools and calls onToolsChanged", async () => {
		const connection = await connectMcpServer("fixture", { command: process.execPath, args: [FIXTURE_SERVER] });
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		expect(connection.tools.map((tool) => tool.name)).not.toContain("mcp__fixture__late-1");

		let changes = 0;
		connection.onToolsChanged = () => {
			changes += 1;
		};
		const addTool = connection.tools.find((tool) => tool.name === "mcp__fixture__add-tool");
		if (!addTool) throw new Error("fixture add-tool missing");

		const result = await addTool.call({}, callCtx());
		expect(result.isError).toBeFalsy();

		await waitFor(() => connection.tools.some((tool) => tool.name === "mcp__fixture__late-1"));
		await waitFor(() => changes === 1);
		// The rebuilt tool is wired to the same live client, not a description of
		// one: it can be called without a reconnect.
		const late = connection.tools.find((tool) => tool.name === "mcp__fixture__late-1");
		if (!late) throw new Error("refreshed tool missing");
		const called = await late.call({}, callCtx());
		expect(called.isError).toBeFalsy();
		expect(resultText(called)).toContain("late-1 answered");
	}, 20_000);

	// The refresh walks every page, which is the only thing that can be true: the
	// paginated fixture serves four pages after the bump, and a refresh that read
	// one page would look exactly this green with two tools in the list.
	test("a refresh collects every page, not just the first", async () => {
		const connection = await connectMcpServer("paginated", {
			command: process.execPath,
			args: [PAGINATED_SERVER],
		});
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);

		let changed = false;
		connection.onToolsChanged = () => {
			changed = true;
		};
		const bump = connection.tools.find((tool) => tool.name === "mcp__paginated__bump");
		if (!bump) throw new Error("fixture bump tool missing");
		await bump.call({}, callCtx());

		await waitFor(() => changed);
		expect(connection.tools.map((tool) => tool.name).sort()).toEqual([
			"mcp__paginated__bump",
			"mcp__paginated__five",
			"mcp__paginated__four",
			"mcp__paginated__one",
			"mcp__paginated__seven-0",
			"mcp__paginated__six-0",
			"mcp__paginated__three",
			"mcp__paginated__two",
		]);
	}, 20_000);

	test("prompts/list_changed refreshes the prompt snapshot", async () => {
		const connection = await connectMcpServer("fixture", { command: process.execPath, args: [FIXTURE_SERVER] });
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		expect(connection.prompts.map((prompt) => prompt.name)).toEqual(["greet"]);

		const addPrompt = connection.tools.find((tool) => tool.name === "mcp__fixture__add-prompt");
		if (!addPrompt) throw new Error("fixture add-prompt missing");
		await addPrompt.call({}, callCtx());

		await waitFor(() => connection.prompts.some((prompt) => prompt.name === "late-prompt-1"));
	}, 20_000);

	test("resources/list_changed refreshes the resource snapshot", async () => {
		const connection = await connectMcpServer("fixture", { command: process.execPath, args: [FIXTURE_SERVER] });
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		expect(connection.resources).toHaveLength(0);

		const addResource = connection.tools.find((tool) => tool.name === "mcp__fixture__add-resource");
		if (!addResource) throw new Error("fixture add-resource missing");
		await addResource.call({}, callCtx());

		await waitFor(() => connection.resources.some((resource) => resource.uri === "file:///fixture/late-resource-1"));
	}, 20_000);

	// The failure half: a server that stops answering its list must not take the
	// working snapshot down with it, and the failure must land where /mcp (and
	// stderr) can say it — silently keeping the old tools is indistinguishable
	// from a server that changed nothing.
	test("a failed refresh keeps the last snapshot and names the failure", async () => {
		const connection = await connectMcpServer("fixture", {
			command: process.execPath,
			args: [FIXTURE_SERVER, "fail-refresh"],
		});
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		const before = connection.tools.map((tool) => tool.name);
		let changes = 0;
		connection.onToolsChanged = () => {
			changes += 1;
		};

		const warnings: string[] = [];
		const original = console.error;
		console.error = (message: unknown) => warnings.push(String(message));
		try {
			const addTool = connection.tools.find((tool) => tool.name === "mcp__fixture__add-tool");
			if (!addTool) throw new Error("fixture add-tool missing");
			await addTool.call({}, callCtx());
			await waitFor(() => connection.error !== undefined);
		} finally {
			console.error = original;
		}

		expect(connection.error).toContain("tools refresh failed");
		expect(warnings.join("\n")).toContain("MCP server fixture");
		// The snapshot is the one from connect: the change was announced but could
		// not be read back, and an empty or partial list would be a guess.
		expect(connection.tools.map((tool) => tool.name)).toEqual(before);
		expect(changes).toBe(0);
	}, 20_000);
});

describe("a connection whose server goes away", () => {
	// The failure this closes: the server process died and the connection kept
	// serving a tool list from a server that was gone. Every call through one of
	// those tools failed at the wire with nothing on the screen saying why — the
	// host rebuilds its registry from `connections.flatMap(c => c.tools)`, and
	// nothing ever took the tools out of that array.
	test("killing the server process marks the connection closed, drops its snapshots, and tells the host", async () => {
		const connection = await connectMcpServer("fixture", { command: process.execPath, args: [FIXTURE_SERVER] });
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		expect(connection.state).toBe("connected");
		expect(connection.tools.length).toBeGreaterThan(0);

		let changes = 0;
		connection.onToolsChanged = () => {
			changes += 1;
		};

		// The transport's own handle on the child: the same process the server
		// runs in, killed the way a crash would end it.
		const transport = connection.client.transport as StdioClientTransport;
		const pid = transport.pid;
		if (!pid) throw new Error("fixture transport has no process");
		process.kill(pid, "SIGTERM");

		await waitFor(() => connection.state === "closed");
		// The close took the snapshots with it, and the host was told through the
		// same bell a tools/list_changed rings — once.
		expect(connection.tools).toHaveLength(0);
		expect(connection.prompts).toHaveLength(0);
		expect(connection.resources).toHaveLength(0);
		expect(changes).toBe(1);
	}, 20_000);
});

describe("prompt and resource reads (the /mcp consumer surface)", () => {
	test("listPrompts and getPrompt round-trip through the server", async () => {
		const connection = await connectMcpServer("fixture", { command: process.execPath, args: [FIXTURE_SERVER] });
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);

		const prompts = await listPrompts(connection.client);
		expect(prompts.map((prompt) => prompt.name)).toEqual(["greet"]);
		expect(prompts[0]?.description).toBe("Greets someone by name");

		const rendered = await getPrompt(connection.client, "greet", { name: "Ada" });
		expect(rendered.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(rendered.messages[0]?.content[0]).toEqual({ type: "text", text: "greet name=Ada" });
	}, 20_000);

	test("listResources and readResource carry text and blob contents", async () => {
		const connection = await connectMcpServer("fixture", { command: process.execPath, args: [FIXTURE_SERVER] });
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);

		const resources = await listResources(connection.client);
		expect(resources).toEqual([
			{ uri: "file:///fixture/note.txt", name: "note.txt", mimeType: "text/plain" },
			{ uri: "file:///fixture/blob.bin", name: "blob.bin", mimeType: "application/octet-stream" },
		]);

		const text = await readResource(connection.client, "file:///fixture/note.txt");
		expect(text).toEqual([{ uri: "file:///fixture/note.txt", mimeType: "text/plain", text: "the note body" }]);

		const blob = await readResource(connection.client, "file:///fixture/blob.bin");
		expect(blob[0]?.mimeType).toBe("application/octet-stream");
		expect(Buffer.from(blob[0]?.blob ?? "", "base64").toString("utf8")).toBe("blob bytes");
	}, 20_000);

	// The bound `tools/call` already had, on every other request: a server that
	// accepts and never answers must not leave the /mcp screen waiting forever.
	// The fixture answers everything except the read, which it holds open — the
	// timeout has to come from the client side, and the message has to name the
	// request, since nothing about it will arrive from the server.
	test("a request the server never answers is bounded, and says so", async () => {
		const connection = await connectMcpServer("fixture", {
			command: process.execPath,
			args: [FIXTURE_SERVER, "stall-read"],
		});
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);

		const started = Date.now();
		await expect(readResource(connection.client, "file:///fixture/note.txt", { timeoutMs: 300 })).rejects.toThrow(
			"resources/read file:///fixture/note.txt timed out after 300ms",
		);
		expect(Date.now() - started).toBeLessThan(3_000);
	}, 20_000);
});

describe("call timeout", () => {
	test("a call the server never answers is bounded, naming the server and tool", async () => {
		const connection = await connectMcpServer(
			"fixture",
			{ command: process.execPath, args: [FIXTURE_SERVER] },
			{ callTimeoutMs: 300 },
		);
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		const sleepTool = connection.tools.find((t) => t.name === "mcp__fixture__sleep");
		if (!sleepTool) throw new Error("fixture sleep tool missing");

		const updates: Array<Record<string, unknown>> = [];
		const started = Date.now();
		const result = await sleepTool.call(
			{ ms: 5_000 },
			callCtx({ onUpdate: (update: Record<string, unknown>) => updates.push(update) }),
		);

		expect(Date.now() - started).toBeLessThan(3_000);
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toBe("MCP call failed: fixture/sleep timed out after 300ms");
		expect(String(updates[0]?.mcpError)).toContain("timed out");

		// The connection survives the timeout — later calls still go through.
		const after = await sleepTool.call({ ms: 1 }, callCtx());
		expect(after.isError).toBeFalsy();
		expect((after.content[0] as any).text).toBe("slept 1ms");
	}, 20_000);

	test("a run cancelled before the call starts never reaches the server", async () => {
		const connection = await connectMcpServer(
			"fixture",
			{ command: process.execPath, args: [FIXTURE_SERVER] },
			{ callTimeoutMs: 5_000 },
		);
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		const sleepTool = connection.tools.find((t) => t.name === "mcp__fixture__sleep");
		if (!sleepTool) throw new Error("fixture sleep tool missing");

		const controller = new AbortController();
		controller.abort();
		const started = Date.now();
		const result = await sleepTool.call({ ms: 4_000 }, callCtx({ signal: controller.signal }));

		// Immediate: the request never goes out, so nothing sits through the sleep.
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toBe("Tool execution aborted");
	}, 20_000);
});

describe("MCP results share the agent budget pipeline", () => {
	test("an oversized result comes back cut with the standard marker", async () => {
		const connection = await connectMcpServer("fixture", { command: process.execPath, args: [FIXTURE_SERVER] });
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		const big = connection.tools.find((t) => t.name === "mcp__fixture__big");
		if (!big) throw new Error("fixture big tool missing");

		const result = await pipelineCall(big, {});

		expect(result.isError).toBeFalsy();
		// The tool declares no budget of its own, so the pipeline default applies
		// (30k chars) and the standard marker says what is gone: the fixture
		// returned 45,000 characters, so 15,000 are missing.
		expect(resultText(result)).toContain("... [truncated 15000 chars of output]");
		expect(resultText(result).length).toBeLessThan(31_000);
	}, 20_000);

	test("undeclared arguments survive validation (passthrough, not strip)", async () => {
		const connection = await connectMcpServer("fixture", { command: process.execPath, args: [FIXTURE_SERVER] });
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		const shapeTool = connection.tools.find((t) => t.name === "mcp__fixture__shape");
		if (!shapeTool) throw new Error("fixture shape tool missing");

		// The server echoes its arguments: a schema that stripped undeclared
		// keys would hand the server a different call than the one requested.
		const result = await pipelineCall(shapeTool, { mode: "fast", extra: "kept" });
		expect(result.isError).toBeFalsy();
		expect(resultText(result)).toContain('"extra":"kept"');
	}, 20_000);

	test("the wire schema validates like the mapping promises", async () => {
		const connection = await connectMcpServer("fixture", { command: process.execPath, args: [FIXTURE_SERVER] });
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		const shapeTool = connection.tools.find((t) => t.name === "mcp__fixture__shape");
		if (!shapeTool) throw new Error("fixture shape tool missing");

		const accepts = (input: unknown) => shapeTool.inputSchema.safeParse(input).success;
		expect(accepts({ mode: "fast" })).toBe(true);
		expect(accepts({})).toBe(false);
		expect(accepts({ mode: "turbo" })).toBe(false);
		expect(accepts({ mode: "slow", level: null, tag: 3, note: false, nums: [1, 2], pair: ["a", 1] })).toBe(true);
		expect(accepts({ mode: "slow", level: "high" })).toBe(false);
		expect(accepts({ mode: "slow", nums: ["a"] })).toBe(false);
		expect(accepts({ mode: "slow", pair: [1, "a"] })).toBe(false);
	}, 20_000);
});

describe("sanitizeMcpError", () => {
	const stdioConfig = {
		type: "stdio" as const,
		command: "node",
		args: [],
		env: { API_KEY: "sk-secret-value-12345", EMPTY: "" },
	};
	const httpConfig = {
		type: "http" as const,
		url: "https://example.test/mcp",
		headers: { Authorization: "Bearer tok-abcdef-9876" },
	};

	test("redacts stdio env values", () => {
		const out = sanitizeMcpError("spawn failed with env API_KEY=sk-secret-value-12345", stdioConfig);
		expect(out).not.toContain("sk-secret-value-12345");
		expect(out).toContain("[redacted]");
	});

	test("redacts HTTP header values", () => {
		const out = sanitizeMcpError("401 sent Authorization: Bearer tok-abcdef-9876", httpConfig);
		expect(out).not.toContain("tok-abcdef-9876");
		expect(out).toContain("[redacted]");
	});

	test("keeps key names so the message stays diagnosable", () => {
		expect(sanitizeMcpError("missing API_KEY in environment", stdioConfig)).toContain("API_KEY");
	});

	test("an empty env value does not blank out the whole message", () => {
		expect(sanitizeMcpError("connection refused", stdioConfig)).toBe("connection refused");
	});

	test("redacts every occurrence, not just the first", () => {
		const out = sanitizeMcpError("sk-secret-value-12345 then sk-secret-value-12345 again", stdioConfig);
		expect(out).not.toContain("sk-secret-value-12345");
	});

	test("a value containing another is redacted whole", () => {
		const nested = {
			type: "stdio" as const,
			command: "node",
			args: [],
			env: { SHORT: "abc123", LONG: "abc123-extended-secret" },
		};
		const out = sanitizeMcpError("token abc123-extended-secret leaked", nested);
		expect(out).toBe("token [redacted] leaked");
	});

	test("a config with no env or headers passes the message through untouched", () => {
		expect(sanitizeMcpError("plain failure", { command: "node" } as never)).toBe("plain failure");
	});

	test("invalid-config errors do not echo the rejected secret value", async () => {
		const connection = await connectMcpServer("bad", {
			// `url` is required for the http variant; omitting it makes zod quote
			// the object it rejected, which would otherwise include the token.
			type: "http",
			headers: { Authorization: "Bearer tok-must-not-leak" },
		} as never);
		expect(connection.error).toBeDefined();
		expect(connection.error).not.toContain("tok-must-not-leak");
	});
});

describe("loadMcpConfig", () => {
	test("returns no servers and no errors when neither file exists", () => {
		// The home is passed rather than read from the environment: this test used
		// to point USERPROFILE/HOME somewhere empty and put them back, because the
		// old reader fell back to the process environment and would pick up the
		// developer's real `~/.labunbun/.mcp.json`. An injectable home makes the
		// premise hold by construction.
		const loaded = loadMcpConfig(
			join(tmpdir(), "lbb-mcp-empty-cwd-does-not-exist"),
			join(tmpdir(), "lbb-mcp-empty-home-does-not-exist"),
		);
		expect(Object.keys(loaded.servers)).toHaveLength(0);
		expect(loaded.errors).toHaveLength(0);
	});

	test("reads the project and home scopes from the home it was handed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "lbb-mcp-merge-"));
		const home = mkdtempSync(join(tmpdir(), "lbb-mcp-merge-home-"));
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { alpha: { command: "alpha-bin" } } }));
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(
			join(home, ".labunbun", ".mcp.json"),
			JSON.stringify({ mcpServers: { beta: { url: "https://example.com/mcp" } } }),
		);
		const loaded = loadMcpConfig(cwd, home);
		expect(Object.keys(loaded.servers).sort()).toEqual(["alpha", "beta"]);
		expect(loaded.errors).toHaveLength(0);
	});

	// The failure this channel exists for: a typo in `.mcp.json` used to read as
	// "no servers configured" — the file vanished in silence. And the message
	// must not quote the file: `env`/`headers` values in it are where tokens
	// live, and a `JSON.parse` error echoes the text around the mistake.
	test("an unreadable file is reported, and its text does not ride out in the error", () => {
		const cwd = mkdtempSync(join(tmpdir(), "lbb-mcp-bad-json-"));
		writeFileSync(
			join(cwd, ".mcp.json"),
			'{ "mcpServers": { "a": { "url": "https://user:tok-secret@example.com" } }, oops',
		);
		const loaded = loadMcpConfig(cwd, join(tmpdir(), "lbb-mcp-unused-home"));
		expect(Object.keys(loaded.servers)).toHaveLength(0);
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0].path).toBe(join(cwd, ".mcp.json"));
		expect(loaded.errors[0].message).toBe("invalid JSON");
		expect(loaded.errors[0].message).not.toContain("tok-secret");
	});
});

describe("loadProjectMcpServerNames", () => {
	test("reads server names from <cwd>/.mcp.json only", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcp-project-"));
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({ mcpServers: { alpha: { command: "bun" }, beta: { url: "https://example.com" } } }),
		);
		const names = loadProjectMcpServerNames(dir);
		expect(names.has("alpha")).toBe(true);
		expect(names.has("beta")).toBe(true);
		expect(names.size).toBe(2);
	});

	test("empty set when no project .mcp.json exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcp-noproject-"));
		expect(loadProjectMcpServerNames(dir).size).toBe(0);
	});

	test("malformed .mcp.json degrades to empty set rather than throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcp-bad-"));
		writeFileSync(join(dir, ".mcp.json"), "{ not valid json");
		expect(loadProjectMcpServerNames(dir).size).toBe(0);
	});
});

describe("loadApprovedMcpServers / approveMcpServer", () => {
	// Every case passes an explicit throwaway home: the store is deliberately
	// outside the working tree, so a default-homedir call here would write real
	// files under the developer's own ~/.labunbun.
	function dirs(prefix: string): { cwd: string; home: string } {
		return { cwd: mkdtempSync(join(tmpdir(), prefix)), home: mkdtempSync(join(tmpdir(), `${prefix}home-`)) };
	}

	test("empty set before any approval", () => {
		const { cwd, home } = dirs("lbb-mcp-approve-");
		expect(loadApprovedMcpServers(cwd, home).size).toBe(0);
	});

	test("approveMcpServer persists under the home directory and is readable back", () => {
		const { cwd, home } = dirs("lbb-mcp-approve2-");
		approveMcpServer(cwd, "alpha", home);
		const approved = loadApprovedMcpServers(cwd, home);
		expect(approved.has("alpha")).toBe(true);

		const storePath = join(home, ".labunbun", "projects", sanitizeCwd(cwd), "mcp-approved.json");
		expect(existsSync(storePath)).toBe(true);
		const raw = JSON.parse(readFileSync(storePath, "utf8"));
		expect(raw.approvedMcpServers).toContain("alpha");
	});

	test("nothing is written inside the working tree", () => {
		const { cwd, home } = dirs("lbb-mcp-approve-tree-");
		approveMcpServer(cwd, "alpha", home);
		// A repo that gets a stray settings.local.json committed would hand the
		// next clone a pre-approved server; the store must stay out of the tree.
		expect(existsSync(join(cwd, ".labunbun"))).toBe(false);
	});

	test("a repo-supplied settings.local.json cannot pre-approve a server", () => {
		const { cwd, home } = dirs("lbb-mcp-approve-legacy-");
		mkdirSync(join(cwd, ".labunbun"), { recursive: true });
		writeFileSync(join(cwd, ".labunbun", "settings.local.json"), JSON.stringify({ approvedMcpServers: ["evil"] }));
		expect(loadApprovedMcpServers(cwd, home).has("evil")).toBe(false);
	});

	test("approvals are per-project: another cwd does not inherit them", () => {
		const { cwd, home } = dirs("lbb-mcp-approve-scope-");
		const other = mkdtempSync(join(tmpdir(), "lbb-mcp-approve-other-"));
		approveMcpServer(cwd, "alpha", home);
		expect(loadApprovedMcpServers(other, home).has("alpha")).toBe(false);
	});

	test("approving a second server preserves the first and dedupes repeats", () => {
		const { cwd, home } = dirs("lbb-mcp-approve3-");
		approveMcpServer(cwd, "alpha", home);
		approveMcpServer(cwd, "beta", home);
		approveMcpServer(cwd, "alpha", home);
		const approved = loadApprovedMcpServers(cwd, home);
		expect(approved.size).toBe(2);
		expect(approved.has("alpha")).toBe(true);
		expect(approved.has("beta")).toBe(true);
	});

	test("an unreadable store degrades to empty rather than throwing", () => {
		const { cwd, home } = dirs("lbb-mcp-approve5-");
		const storePath = join(home, ".labunbun", "projects", sanitizeCwd(cwd), "mcp-approved.json");
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(storePath, "{ not json");
		expect(loadApprovedMcpServers(cwd, home).size).toBe(0);
	});

	test("a damaged store says why the set is empty, and leaves the file where it is", () => {
		// "No servers approved" and "the approvals could not be read" are the same
		// set and different situations: the first is a fresh project, the second
		// is a project whose servers are about to be re-asked for. The status
		// variant carries the difference. Reading must not move the file — every
		// startup reads, and a transient failure would become permanent damage.
		const { cwd, home } = dirs("lbb-mcp-approve-status-");
		const storePath = join(home, ".labunbun", "projects", sanitizeCwd(cwd), "mcp-approved.json");
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(storePath, "{ not json");

		const status = loadApprovedMcpServersWithStatus(cwd, home);

		expect(status.approved.size).toBe(0);
		expect(status.warning).toContain(storePath);
		expect(status.warning).toContain("damaged");
		expect(status.warning).toContain("earlier approvals are not in effect");
		expect(readFileSync(storePath, "utf8")).toBe("{ not json");
	});

	test("an absent store is the ordinary empty answer, not a warning", () => {
		const { cwd, home } = dirs("lbb-mcp-approve-absent-");
		expect(loadApprovedMcpServersWithStatus(cwd, home)).toEqual({ approved: new Set() });
	});

	// Approval is a read-modify-write over the whole store, so a corrupt store
	// used to be the loss of every earlier approval: the parse failure became
	// `{}`, and the write then persisted only the new name. The corrupt file
	// must survive the write somewhere findable, and the warning must say where.
	test("approving over a corrupt store moves it aside instead of silently dropping earlier approvals", () => {
		const { cwd, home } = dirs("lbb-mcp-approve6-");
		const storePath = join(home, ".labunbun", "projects", sanitizeCwd(cwd), "mcp-approved.json");
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(storePath, "{ not json");

		const warnings: string[] = [];
		const original = console.error;
		console.error = (message: unknown) => warnings.push(String(message));
		try {
			approveMcpServer(cwd, "alpha", home);
		} finally {
			console.error = original;
		}

		// The new approval landed...
		expect(loadApprovedMcpServers(cwd, home).has("alpha")).toBe(true);
		// ...the corrupt file is beside it, byte for byte...
		const backups = readdirSync(dirname(storePath)).filter((name) => name.startsWith("mcp-approved.json.corrupt-"));
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(dirname(storePath), backups[0]), "utf8")).toBe("{ not json");
		// ...and the warning says what happened and where the file went.
		expect(warnings.join("\n")).toContain("moved to");
		expect(warnings.join("\n")).toContain("re-approved");
	});
});

describe("disconnectAllMcpServers", () => {
	test("asks every opened connection to close, swallows a failed close, skips the ones that never opened", async () => {
		const closed: string[] = [];
		const fake = (name: string, client: unknown): McpConnection =>
			({ serverName: name, client, tools: [], prompts: [], resources: [] }) as McpConnection;
		const opened = fake("opened", {
			close: async () => {
				closed.push("opened");
			},
		});
		const broken = fake("broken", {
			close: async () => {
				throw new Error("the pipe was already gone");
			},
		});
		const never = fake("never", null);

		await expect(disconnectAllMcpServers([opened, broken, never])).resolves.toBeUndefined();
		expect(closed).toEqual(["opened"]);
	});
});

describe("connectAllMcpServers approval gating", () => {
	test("servers omitted from approvedServers are skipped with an error, not connected", async () => {
		const connections = await connectAllMcpServers(
			{
				allowed: { command: process.execPath, args: [FIXTURE_SERVER] },
				blocked: { command: process.execPath, args: [FIXTURE_SERVER] },
			},
			new Set(["allowed"]),
		);
		const blocked = connections.find((c) => c.serverName === "blocked");
		const allowed = connections.find((c) => c.serverName === "allowed");
		expect(blocked?.error).toBe("not approved");
		expect(blocked?.tools).toHaveLength(0);
		expect(allowed?.error).toBeUndefined();
		expect(allowed?.tools.length).toBeGreaterThan(0);
	}, 20_000);

	test("no approvedServers argument connects everything (user-scope config trusted by default)", async () => {
		const connections = await connectAllMcpServers({
			fixture: { command: process.execPath, args: [FIXTURE_SERVER] },
		});
		expect(connections[0].error).toBeUndefined();
	}, 20_000);

	test("the confiner rides the options through to every stdio spawn", async () => {
		const seen: string[] = [];
		const connections = await connectAllMcpServers(
			{ fixture: { command: process.execPath, args: [FIXTURE_SERVER] } },
			undefined,
			{
				confine: async (spawn) => {
					seen.push(spawn.command);
					return spawn;
				},
			},
		);
		expect(connections[0].error).toBeUndefined();
		expect(seen).toEqual([process.execPath]);
	}, 20_000);
});

/**
 * The host's confiner over the stdio spawn.
 *
 * The REPL and headless hosts wrap every stdio server in the session's sandbox
 * (`spawn-confinement.ts`), but the wiring is a callback crossing a package
 * boundary, which is the kind of seam that reads right and is never called.
 * These tests pin the three facts the seam consists of: the confiner sees the
 * configured spawn, its answer is what opens, and its refusal is this server's
 * failure — fail-closed, not a spawn that quietly proceeds unwrapped. The HTTP
 * branch is the negative control: there is no process, so it must never ask.
 */
describe("the confine hook over the stdio spawn", () => {
	test("sees the configured command and environment, and connects unchanged", async () => {
		const seen: { command: string; args: string[] | undefined; env: Record<string, string> | undefined }[] = [];
		const connection = await connectMcpServer(
			"fixture",
			{ command: process.execPath, args: [FIXTURE_SERVER], env: { FIXTURE_FLAG: "1" } },
			{
				confine: async (spawn) => {
					seen.push({ command: spawn.command, args: spawn.args, env: spawn.env });
					return spawn;
				},
			},
		);
		if (connection.error) throw new Error(`fixture failed: ${connection.error}`);
		// Exactly once, with the config's own values — not a default environment
		// or a re-derived command line.
		expect(seen).toHaveLength(1);
		expect(seen[0].command).toBe(process.execPath);
		expect(seen[0].args).toEqual([FIXTURE_SERVER]);
		expect(seen[0].env).toEqual({ FIXTURE_FLAG: "1" });
		expect(connection.tools.length).toBeGreaterThan(0);
		await disconnectAllMcpServers([connection]);
	}, 20_000);

	test("the returned spawn is what opens: a rewritten command is the one that runs", async () => {
		// The rewrite points the spawn at nothing. If the transport still opened
		// the configured fixture, the connect would succeed and this would fail —
		// which is the direction that matters: the hook consulted and *ignored*
		// must not read as the hook never being asked.
		const connection = await connectMcpServer(
			"fixture",
			{ command: process.execPath, args: [FIXTURE_SERVER] },
			{ confine: async () => ({ command: "labunbun-no-such-program-xyz", args: [] }) },
		);
		expect(connection.error).toBeTruthy();
		expect(connection.tools).toHaveLength(0);
	}, 20_000);

	test("a rejection fails this server's connect, with the message", async () => {
		const connection = await connectMcpServer(
			"fixture",
			{ command: process.execPath, args: [FIXTURE_SERVER] },
			{
				confine: async () => {
					throw new Error("refused by the session policy");
				},
			},
		);
		expect(connection.error).toContain("refused by the session policy");
		expect(connection.tools).toHaveLength(0);
	}, 20_000);

	test("an http server never consults the confiner", async () => {
		let asked = 0;
		const connection = await connectMcpServer(
			"remote",
			{ url: "http://127.0.0.1:1/mcp" },
			{
				confine: async () => {
					asked += 1;
					throw new Error("must not be asked");
				},
			},
		);
		// The connect fails on the unreachable port, and with `asked` at zero the
		// failure is the transport's rather than the hook's — a confiner consulted
		// here would have thrown its own message into the error instead.
		expect(connection.error).toBeTruthy();
		expect(connection.error).not.toContain("must not be asked");
		expect(asked).toBe(0);
	}, 20_000);
});
