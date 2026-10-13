import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentSession, buildTool } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { loadApprovedMcpServers, loadProjectMcpServerNames, type McpConnection } from "@labunbun/mcp";
import { createStore, DARK_THEME } from "@labunbun/tui";
import { z } from "zod";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { createMcpToolRefreshHandler } from "../src/mcp-tool-refresh.ts";

const FIXTURE_SERVER = join(
	dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
	"..",
	"..",
	"mcp",
	"test",
	"fixture-server.ts",
);

function makeCtx(overrides: Partial<AppCommandContext> = {}): AppCommandContext {
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<{ entries: Array<{ kind: string; text: string }> }>({ entries: [] });
	return {
		getSession: () => session,
		handle: { store } as never,
		// /ps and /stop are not exercised here; the stubs keep the context total.
		backgroundShells: { list: () => [], output: () => "", kill: () => false },
		refreshBackgroundShells: () => {},
		settings: {} as never,
		cwd: overrides.cwd ?? process.cwd(),
		costTracker: { state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} } } as never,
		baseRules: [],
		sessionRules: [],
		commands: [],
		compaction: () => ({}) as never,
		mcpConnections: [],
		mcpConfig: {},
		mcpLoadErrors: [],
		pendingMcpApprovals: [],
		sessionStore: () => undefined,
		theme: { theme: DARK_THEME, available: [DARK_THEME.name], problems: [] },
		hotSwapSession: async () => {},
		switchModel: () => false,
		...overrides,
	} as AppCommandContext;
}

function infoTexts(ctx: AppCommandContext): string[] {
	if (!ctx.handle) return [];
	return (ctx.handle.store.get() as { entries: Array<{ kind: string; text: string }> }).entries
		.filter((e) => e.kind === "info")
		.map((e) => e.text);
}

describe("/mcp command", () => {
	test("reports no servers when config and pending are both empty", () => {
		const ctx = makeCtx();
		expect(handleAppCommand("/mcp", ctx)).toBe(true);
		expect(infoTexts(ctx).join("\n")).toContain("No MCP servers configured");
	});

	test("lists pending approvals with an approve hint", () => {
		const ctx = makeCtx({ pendingMcpApprovals: ["alpha"] });
		handleAppCommand("/mcp", ctx);
		const text = infoTexts(ctx).join("\n");
		expect(text).toContain("alpha");
		expect(text).toContain("pending approval");
		expect(text).toContain("/mcp approve alpha");
	});

	// A server's prompts were discovered, stored on the connection, and read by
	// nothing: the list reported the tools and dropped the half of the answer
	// that says what else the server offers.
	test("a connected server's row counts its prompts as well as its tools", () => {
		const ctx = makeCtx({
			mcpConnections: [
				{
					serverName: "alpha",
					client: null,
					tools: [{ name: "mcp__alpha__a" }],
					prompts: [{ name: "p1" }, { name: "p2" }],
				},
			] as never,
		});
		handleAppCommand("/mcp", ctx);
		expect(infoTexts(ctx).join("\n")).toContain("alpha: ✓ 1 tools, 2 prompts");
	});

	test("approve on an unknown/non-pending server reports no pending approval", () => {
		const ctx = makeCtx({ pendingMcpApprovals: [] });
		handleAppCommand("/mcp approve alpha", ctx);
		expect(infoTexts(ctx).join("\n")).toContain("No pending approval");
	});

	test("approve connects the server, persists approval, and merges tools into the session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcpcmd-"));
		const home = mkdtempSync(join(tmpdir(), "lbb-mcpcmd-home-"));
		writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "x" } } }));

		const cacheCauses: string[] = [];
		const ctx = makeCtx({
			cwd: dir,
			home,
			pendingMcpApprovals: ["fixture"],
			mcpConfig: { fixture: { command: process.execPath, args: [FIXTURE_SERVER] } },
			cache: { report: () => "", statusLine: () => "", note: (cause) => cacheCauses.push(cause) },
		});
		// The REPL's refresh handler, wired the way `interactive.ts` wires it.
		// A connection that appears after startup has to carry it too, or this
		// server's later tool-list changes would reach the main session never —
		// while the subagent table and the band, which read the connections
		// live, would move ahead of it.
		const refreshNotes: string[] = [];
		ctx.onMcpToolsChanged = createMcpToolRefreshHandler({
			getSession: ctx.getSession,
			connections: ctx.mcpConnections,
			noteCacheChange: (cause) => refreshNotes.push(cause),
		});

		handleAppCommand("/mcp approve fixture", ctx);
		// Connection is async (fire-and-forget inside handleAppCommand); wait for it.
		await new Promise((r) => setTimeout(r, 3000));

		expect(loadApprovedMcpServers(dir, home).has("fixture")).toBe(true);
		expect(ctx.pendingMcpApprovals).not.toContain("fixture");
		expect(ctx.mcpConnections.some((c) => c.serverName === "fixture")).toBe(true);
		const session = ctx.getSession();
		if (!session) throw new Error("session missing from context");
		expect(session.tools.some((t: { name: string }) => t.name === "mcp__fixture__echo")).toBe(true);
		expect(infoTexts(ctx).join("\n")).toContain("connected with");
		// Tools sit above the system prompt and the transcript, so appending one
		// discards the whole prefix below it. The user asked for this and only the
		// app knows it: registered, `/cache` names the rewrite; unregistered, the
		// next request reads as a bug.
		expect(cacheCauses).toEqual(["mcp tools added"]);

		// The command wired the handler onto the connection it opened, and a
		// later change on that server now reaches the session: replace the array
		// the way the client does on `tools/list_changed` and fire the hook.
		const approved = ctx.mcpConnections.find((c) => c.serverName === "fixture");
		if (!approved) throw new Error("approved connection missing from context");
		expect(approved.onToolsChanged).toBe(ctx.onMcpToolsChanged);
		// A real tool: the session builds each one's wire schema in setTools, so
		// a name-only stub would fail for a reason that is not this test's.
		approved.tools = [
			...approved.tools,
			buildTool({
				name: "mcp__fixture__late",
				description: "late",
				inputSchema: z.object({}),
				call: async () => ({ content: [{ type: "text", text: "ok" }] }),
			}),
		];
		approved.onToolsChanged?.();
		expect(session.tools.map((t: { name: string }) => t.name)).toContain("mcp__fixture__late");
		expect(refreshNotes).toEqual(["mcp tools changed"]);
	}, 20_000);
});

describe("end-to-end project-server approval gate (loadProjectMcpServerNames + loadApprovedMcpServers)", () => {
	test("a fresh clone's project server starts unapproved", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcpgate-"));
		const home = mkdtempSync(join(tmpdir(), "lbb-mcpgate-home-"));
		writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "whoami" } } }));

		const projectNames = loadProjectMcpServerNames(dir);
		const approved = loadApprovedMcpServers(dir, home);
		expect(projectNames.has("evil")).toBe(true);
		expect(approved.has("evil")).toBe(false);
	});

	test("a repo cannot ship its own approval ledger", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcpgate-ledger-"));
		const home = mkdtempSync(join(tmpdir(), "lbb-mcpgate-ledger-home-"));
		writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "whoami" } } }));
		// The old ledger location: a file in the repo, next to .mcp.json, is
		// attacker-controlled and must not be read as evidence of approval.
		mkdirSync(join(dir, ".labunbun"), { recursive: true });
		writeFileSync(join(dir, ".labunbun", "settings.local.json"), JSON.stringify({ approvedMcpServers: ["evil"] }));

		expect(loadApprovedMcpServers(dir, home).has("evil")).toBe(false);
	});
});

describe("/mcp read subcommands (prompts and resources)", () => {
	/**
	 * A connection whose client answers the way a real server would, without a
	 * process behind it: the reads are what these tests drive, and a stub keeps
	 * them deterministic. The shapes are the wire's — `listPrompts` answers
	 * `{ prompts }`, `getPrompt` echoes its arguments back, `readResource`
	 * answers `{ contents }` with a blob entry as base64.
	 */
	function connected(clientOverrides: Record<string, unknown> = {}): McpConnection {
		return {
			serverName: "fixture",
			client: {
				listPrompts: async () => ({ prompts: [{ name: "greet", description: "Greets someone by name" }] }),
				getPrompt: async (request: { arguments?: Record<string, string> }) => {
					const args = Object.entries(request.arguments ?? {})
						.map(([key, value]) => `${key}=${value}`)
						.join(" ");
					return {
						description: "Greets someone by name",
						messages: [
							{ role: "user", content: { type: "text", text: `greet ${args}`.trimEnd() } },
							{ role: "assistant", content: { type: "text", text: "hello" } },
						],
					};
				},
				listResources: async () => ({
					resources: [{ uri: "file:///fixture/note.txt", name: "note.txt", mimeType: "text/plain" }],
				}),
				readResource: async ({ uri }: { uri: string }) => ({
					contents:
						uri === "file:///fixture/blob.bin"
							? [{ uri, mimeType: "application/octet-stream", blob: Buffer.from("blob bytes").toString("base64") }]
							: [{ uri, mimeType: "text/plain", text: "the note body" }],
				}),
				...clientOverrides,
			} as never,
			tools: [],
			prompts: [{ name: "greet" }],
			resources: [],
		};
	}

	/** The reads are dispatched fire-and-forget; their entries land a microtask later. */
	async function settle(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	test("prompts renders each name with its description", async () => {
		const ctx = makeCtx({ mcpConnections: [connected()] });
		handleAppCommand("/mcp prompts fixture", ctx);
		await settle();
		const text = infoTexts(ctx).join("\n");
		expect(text).toContain('Prompts on MCP server "fixture"');
		expect(text).toContain("greet — Greets someone by name");
	});

	test("a missing or unknown server answers with the usage", () => {
		const ctx = makeCtx({ mcpConnections: [connected()] });
		handleAppCommand("/mcp prompts", ctx);
		expect(infoTexts(ctx).join("\n")).toContain("Usage: /mcp prompts <server>");

		handleAppCommand("/mcp prompts nope", ctx);
		const text = infoTexts(ctx).join("\n");
		expect(text).toContain("Usage: /mcp prompts <server>");
		expect(text).toContain('Unknown or unconnected MCP server: "nope"');
	});

	test("prompt renders each message by role, with the arguments the user passed", async () => {
		const ctx = makeCtx({ mcpConnections: [connected()] });
		handleAppCommand("/mcp prompt fixture greet name=Ada", ctx);
		await settle();
		const text = infoTexts(ctx).join("\n");
		expect(text).toContain('Prompt "greet" on MCP server "fixture"');
		// The server echoed the argument; the line shows it as the message a
		// prompt would hand the model, not a summary of one.
		expect(text).toContain("  user: greet name=Ada");
		expect(text).toContain("  assistant: hello");
	});

	test("a block a terminal cannot show is named, and its bytes stay out of the entry", async () => {
		const ctx = makeCtx({
			mcpConnections: [
				connected({
					getPrompt: async () => ({
						messages: [{ role: "user", content: { type: "image", mimeType: "image/png", data: "AAAB" } }],
					}),
				}),
			],
		});
		handleAppCommand("/mcp prompt fixture pic", ctx);
		await settle();
		const text = infoTexts(ctx).join("\n");
		expect(text).toContain("  user: [image image/png]");
		expect(text).not.toContain("AAAB");
	});

	test("a bare argument gets the key=value shape instead of being passed along", () => {
		const ctx = makeCtx({ mcpConnections: [connected()] });
		handleAppCommand("/mcp prompt fixture greet nope", ctx);
		const text = infoTexts(ctx).join("\n");
		expect(text).toContain("Usage: /mcp prompt <server> <name> [key=value ...]");
		expect(text).toContain('got "nope"');
	});

	test("prompt and resource without their subject answer with the usage", () => {
		const ctx = makeCtx({ mcpConnections: [connected()] });
		handleAppCommand("/mcp prompt fixture", ctx);
		expect(infoTexts(ctx).join("\n")).toContain("Usage: /mcp prompt <server> <name> [key=value ...]");
		handleAppCommand("/mcp resource fixture", ctx);
		expect(infoTexts(ctx).join("\n")).toContain("Usage: /mcp resource <server> <uri>");
	});

	test("resources renders each uri with its name and type", async () => {
		const ctx = makeCtx({ mcpConnections: [connected()] });
		handleAppCommand("/mcp resources fixture", ctx);
		await settle();
		const text = infoTexts(ctx).join("\n");
		expect(text).toContain('Resources on MCP server "fixture"');
		expect(text).toContain("file:///fixture/note.txt — note.txt (text/plain)");
	});

	test("resource shows text directly and names a blob by size", async () => {
		const ctx = makeCtx({ mcpConnections: [connected()] });
		handleAppCommand("/mcp resource fixture file:///fixture/note.txt", ctx);
		await settle();
		expect(infoTexts(ctx).join("\n")).toContain("the note body");

		handleAppCommand("/mcp resource fixture file:///fixture/blob.bin", ctx);
		await settle();
		// "blob bytes" decoded is 10 bytes; the base64 itself never shows.
		const text = infoTexts(ctx).join("\n");
		expect(text).toContain("[binary application/octet-stream, 10 bytes]");
		expect(text).not.toContain("YmxvYiBieXRlcw==");
	});

	test("a failed read says so rather than leaving a blank screen", async () => {
		const ctx = makeCtx({
			mcpConnections: [
				connected({
					listPrompts: async () => {
						throw new Error("the server went away");
					},
				}),
			],
		});
		handleAppCommand("/mcp prompts fixture", ctx);
		await settle();
		expect(infoTexts(ctx).join("\n")).toContain('MCP prompts/list on "fixture" failed: the server went away');
	});

	test("the server list names the read commands", () => {
		const ctx = makeCtx({ mcpConnections: [connected()] });
		handleAppCommand("/mcp", ctx);
		expect(infoTexts(ctx).join("\n")).toContain("Read one's prompts or resources");
	});
});
