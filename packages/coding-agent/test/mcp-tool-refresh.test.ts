/**
 * The host's half of `tools/list_changed`: a session's tool registry has to
 * move when a server does.
 *
 * The wiring was closure-private inside `interactive.ts` and nothing held it —
 * which is how the subagent table and the band ended up reading a startup
 * snapshot while the main session followed the servers. The handler now lives
 * in `mcp-tool-refresh.ts`, so these tests can race it the way the client does:
 * the connection's `tools` array is REPLACED (`packages/mcp/src/client.ts` does
 * exactly that on a refresh), and the rebuilt session list is asserted against
 * the arrays as they are at the call — not against what they held when the
 * handler was built.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSession, AnyTool } from "@labunbun/agent";
import type { McpConnection } from "@labunbun/mcp";
import { createMcpToolRefreshHandler } from "../src/mcp-tool-refresh.ts";

/** Only the name matters: the handler filters and concatenates by name. */
function stubTool(name: string): AnyTool {
	return { name } as AnyTool;
}

/**
 * A session that records every `setTools` the way the app's real one carries
 * them out, without a provider, a store or a run. `as unknown` because the
 * handler only touches `tools` and `setTools`; a full AgentSession would add
 * nothing to what is under test here.
 */
function fakeSession(toolNames: string[]) {
	const calls: string[][] = [];
	const session = {
		tools: toolNames.map(stubTool),
		setTools(tools: AnyTool[]) {
			calls.push(tools.map((tool) => tool.name));
			this.tools = tools;
		},
	};
	return {
		session: session as unknown as AgentSession,
		calls,
		names: () => session.tools.map((tool) => tool.name),
	};
}

/** A connected server as the client hands it over; `client` is unused here. */
function connection(serverName: string, toolNames: string[]): McpConnection {
	return {
		serverName,
		client: null as never,
		tools: toolNames.map(stubTool),
		prompts: [],
		resources: [],
	};
}

describe("the MCP tool-refresh handler", () => {
	test("rebuilds the MCP half from the connections' current arrays, keeping the rest", () => {
		const { session, calls, names } = fakeSession(["Read", "Edit", "mcp__alpha__old"]);
		const alpha = connection("alpha", ["mcp__alpha__old"]);
		const notes: string[] = [];
		const onToolsChanged = createMcpToolRefreshHandler({
			getSession: () => session,
			connections: [alpha],
			noteCacheChange: (cause) => notes.push(cause),
		});

		// The server announced a change and the client replaced the array, the
		// way `tools/list_changed` writes it (client.ts replaces `connection.tools`
		// wholesale; it never mutates in place).
		alpha.tools = ["mcp__alpha__old", "mcp__alpha__new"].map(stubTool);

		onToolsChanged();

		expect(calls).toHaveLength(1);
		// Non-MCP tools kept, in order; the MCP half is the connection's list as
		// of the call — the added tool included, the session's own stale entry
		// gone.
		expect(names()).toEqual(["Read", "Edit", "mcp__alpha__old", "mcp__alpha__new"]);
		// The tool block sits above the system prompt and transcript, so the
		// rewrite has to be declared or `/cache` would name it a bug.
		expect(notes).toEqual(["mcp tools changed"]);
	});

	test("a non-MCP tool the session gained mid-run survives the rebuild", () => {
		// BandMessage is appended to the main session when a band starts (and
		// removed when it ends). It is not in the startup list this handler could
		// have captured, and the session's own array is the only place it lives.
		const { session, names } = fakeSession(["Read", "BandMessage", "mcp__alpha__a"]);
		const alpha = connection("alpha", ["mcp__alpha__a", "mcp__alpha__b"]);
		createMcpToolRefreshHandler({
			getSession: () => session,
			connections: [alpha],
			noteCacheChange: () => {},
		})();

		expect(names()).toEqual(["Read", "BandMessage", "mcp__alpha__a", "mcp__alpha__b"]);
	});

	test("a connection added after the handler was built counts at the call", () => {
		// `/mcp approve` pushes into the same array the app handed over; a change
		// on that server has to land like any other.
		const { session, calls, names } = fakeSession(["Read", "mcp__alpha__a"]);
		const connections: McpConnection[] = [connection("alpha", ["mcp__alpha__a"])];
		const onToolsChanged = createMcpToolRefreshHandler({
			getSession: () => session,
			connections,
			noteCacheChange: () => {},
		});

		// First refresh, with the startup fleet alone: alpha drops its tool.
		connections[0].tools = [];
		onToolsChanged();
		expect(names()).toEqual(["Read"]);

		// Then the user approves a server, and the same server gains tools back
		// while a second connection is on stage: both arrays are read at the call.
		connections.push(connection("beta", ["mcp__beta__b"]));
		connections[0].tools = ["mcp__alpha__c"].map(stubTool);
		onToolsChanged();

		expect(calls).toHaveLength(2);
		expect(names()).toEqual(["Read", "mcp__alpha__c", "mcp__beta__b"]);
	});

	test("no live session is a no-op: no throw, no note", () => {
		const notes: string[] = [];
		const onToolsChanged = createMcpToolRefreshHandler({
			getSession: () => null,
			connections: [connection("alpha", ["mcp__alpha__a"])],
			noteCacheChange: (cause) => notes.push(cause),
		});

		expect(() => onToolsChanged()).not.toThrow();
		expect(notes).toEqual([]);
	});

	test("reads the session through the getter at the call, not the one bound at build time", () => {
		// `/resume` swaps the holder; the rebuilt list belongs on the session that
		// is live when the notification arrives.
		const first = fakeSession(["mcp__alpha__a"]);
		const second = fakeSession(["Read"]);
		let live = first.session;
		const onToolsChanged = createMcpToolRefreshHandler({
			getSession: () => live,
			connections: [connection("alpha", ["mcp__alpha__a", "mcp__alpha__b"])],
			noteCacheChange: () => {},
		});

		live = second.session;
		onToolsChanged();

		expect(first.calls).toHaveLength(0);
		expect(second.names()).toEqual(["Read", "mcp__alpha__a", "mcp__alpha__b"]);
	});
});
