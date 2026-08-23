import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { loadApprovedMcpServers, loadProjectMcpServerNames } from "@labunbun/mcp";
import { createStore, DARK_THEME } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

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
		sessionRef: session,
		getSession: () => session,
		handle: { store } as never,
		settings: {} as never,
		cwd: overrides.cwd ?? process.cwd(),
		costTracker: { state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} } } as never,
		baseRules: [],
		sessionRules: [],
		commands: [],
		compaction: () => ({}) as never,
		mcpConnections: [],
		mcpConfig: {},
		pendingMcpApprovals: [],
		sessionStore: () => undefined,
		theme: { theme: DARK_THEME, available: [DARK_THEME.name], problems: [] },
		hotSwapSession: async () => {},
		switchModel: () => false,
		...overrides,
	};
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

	test("approve on an unknown/non-pending server reports no pending approval", () => {
		const ctx = makeCtx({ pendingMcpApprovals: [] });
		handleAppCommand("/mcp approve alpha", ctx);
		expect(infoTexts(ctx).join("\n")).toContain("No pending approval");
	});

	test("approve connects the server, persists approval, and merges tools into the session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcpcmd-"));
		writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "x" } } }));

		const ctx = makeCtx({
			cwd: dir,
			pendingMcpApprovals: ["fixture"],
			mcpConfig: { fixture: { command: process.execPath, args: [FIXTURE_SERVER] } },
		});

		handleAppCommand("/mcp approve fixture", ctx);
		// Connection is async (fire-and-forget inside handleAppCommand); wait for it.
		await new Promise((r) => setTimeout(r, 3000));

		expect(loadApprovedMcpServers(dir).has("fixture")).toBe(true);
		expect(ctx.pendingMcpApprovals).not.toContain("fixture");
		expect(ctx.mcpConnections.some((c) => c.serverName === "fixture")).toBe(true);
		const session = ctx.getSession();
		if (!session) throw new Error("session missing from context");
		expect(session.tools.some((t: { name: string }) => t.name === "mcp__fixture__echo")).toBe(true);
		expect(infoTexts(ctx).join("\n")).toContain("connected with");
	}, 20_000);
});

describe("end-to-end project-server approval gate (loadProjectMcpServerNames + loadApprovedMcpServers)", () => {
	test("a fresh clone's project server starts unapproved", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcpgate-"));
		writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "whoami" } } }));

		const projectNames = loadProjectMcpServerNames(dir);
		const approved = loadApprovedMcpServers(dir);
		expect(projectNames.has("evil")).toBe(true);
		expect(approved.has("evil")).toBe(false);
	});
});
