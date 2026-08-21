import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	approveMcpServer,
	connectAllMcpServers,
	connectMcpServer,
	loadApprovedMcpServers,
	loadMcpConfig,
	loadProjectMcpServerNames,
	McpServerConfigSchema,
} from "../src/client.ts";

const FIXTURE_SERVER = join(
	dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
	"fixture-server.ts",
);

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

		expect(connection.tools).toHaveLength(1);
		const tool = connection.tools[0];
		expect(tool.name).toBe("mcp__fixture__echo");

		const result = await tool.call(
			{ text: "hello mcp" },
			{
				callId: "t1",
				signal: new AbortController().signal,
				cwd: process.cwd(),
				onUpdate: () => {},
			},
		);
		expect(result.isError).toBeFalsy();
		expect((result.content[0] as any).text).toContain("hello mcp");
	}, 20_000);

	test("invalid config yields error connection, not a throw", async () => {
		const connection = await connectMcpServer("bad", { command: "" } as never);
		expect(connection.error).toBeDefined();
	});
});

describe("loadMcpConfig", () => {
	test("returns empty object when no config files exist", () => {
		const configs = loadMcpConfig("/nonexistent-path-xyz");
		expect(Object.keys(configs)).toHaveLength(0);
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
	test("empty set before any approval", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcp-approve-"));
		expect(loadApprovedMcpServers(dir).size).toBe(0);
	});

	test("approveMcpServer persists to .labunbun/settings.local.json and is readable back", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcp-approve2-"));
		approveMcpServer(dir, "alpha");
		const approved = loadApprovedMcpServers(dir);
		expect(approved.has("alpha")).toBe(true);

		const settingsPath = join(dir, ".labunbun", "settings.local.json");
		expect(existsSync(settingsPath)).toBe(true);
		const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(raw.approvedMcpServers).toContain("alpha");
	});

	test("approving a second server preserves the first and dedupes repeats", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcp-approve3-"));
		approveMcpServer(dir, "alpha");
		approveMcpServer(dir, "beta");
		approveMcpServer(dir, "alpha");
		const approved = loadApprovedMcpServers(dir);
		expect(approved.size).toBe(2);
		expect(approved.has("alpha")).toBe(true);
		expect(approved.has("beta")).toBe(true);
	});

	test("preserves unrelated keys already in settings.local.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-mcp-approve4-"));
		mkdirSync(join(dir, ".labunbun"), { recursive: true });
		writeFileSync(join(dir, ".labunbun", "settings.local.json"), JSON.stringify({ someOtherKey: "keep-me" }));
		approveMcpServer(dir, "alpha");
		const raw = JSON.parse(readFileSync(join(dir, ".labunbun", "settings.local.json"), "utf8"));
		expect(raw.someOtherKey).toBe("keep-me");
		expect(raw.approvedMcpServers).toContain("alpha");
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
});
