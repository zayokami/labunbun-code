/**
 * The host's half of `tools/list_changed`: a server announced that its tool
 * list moved, the client refreshed its own connection snapshot and replaced
 * `connection.tools`, and the live session's registry has to move with it.
 *
 * Extracted from `interactive.ts` so the rewiring can be tested against a
 * session and connections that are fakes rather than a REPL — the wiring used
 * to be closure-private, and nothing held it.
 */

import type { AgentSession } from "@labunbun/agent";
import type { McpConnection } from "@labunbun/mcp";

export interface McpToolRefreshDeps {
	/**
	 * The live session, read at the call, never captured: `/resume` swaps it,
	 * and a connection outlives the swap — a rebuilt list has to land on the
	 * conversation that is live when the notification arrives. The host passes
	 * an arrow over its own holder (`() => sessionRef`), which is what lets the
	 * holder be declared after this factory runs — the arrow defers evaluation
	 * to the call. `null` — before the session exists, or after a shutdown — is
	 * a no-op, not a throw.
	 */
	getSession: () => AgentSession | null;
	/**
	 * The connections whose `tools` arrays the client replaces in place, read at
	 * the call so a connection added later counts too: `/mcp approve` pushes
	 * into the same array the host handed here, and a change on that server has
	 * to land like any other.
	 */
	connections: McpConnection[];
	/**
	 * Declare the rewrite on the cache tracker. The tool block sits above the
	 * system prompt and transcript, and a provider keys its cache on it: one
	 * changed tool discards every tier below. The server asked for the change
	 * and this wiring is what declares it — unregistered, `/cache` would name
	 * the next request a rewind bug.
	 */
	noteCacheChange: (cause: string) => void;
}

/**
 * A server that changed its tool list mid-session, wired to the live session.
 *
 * The tools sit in the session's registry, so a change the client can see is
 * only real once the session's list moves — the same rewrite `/mcp approve`
 * makes when it appends a newly approved server's tools. Non-MCP tools are
 * kept by name filter rather than rebuilt from the full tool list: the
 * session's array is the one place a mid-run addition lives, and rebuilding
 * from a startup snapshot would drop it.
 *
 * The MCP half is rebuilt from the connections' current arrays, not from what
 * they held when this factory ran — that is the whole point of the handler.
 */
export function createMcpToolRefreshHandler(deps: McpToolRefreshDeps): () => void {
	return () => {
		const target = deps.getSession();
		if (!target) return;
		target.setTools([
			...target.tools.filter((tool) => !tool.name.startsWith("mcp__")),
			...deps.connections.flatMap((c) => c.tools),
		]);
		deps.noteCacheChange("mcp tools changed");
	};
}
