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
	sanitizeMcpError,
} from "../src/client.ts";

const TEST_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FIXTURE_SERVER = join(TEST_DIR, "fixture-server.ts");
const STALLING_SERVER = join(TEST_DIR, "fixture-stalling-server.ts");

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
