import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeCwd } from "@labunbun/agent";
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

		expect(connection.tools.map((t) => t.name).sort()).toEqual(["mcp__fixture__echo", "mcp__fixture__sleep"]);
		const tool = connection.tools.find((t) => t.name === "mcp__fixture__echo");
		if (!tool) throw new Error("fixture echo tool missing");

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
			{ callId: "t1", signal: controller.signal, cwd: process.cwd(), onUpdate: () => {} },
		);
		setTimeout(() => controller.abort(), 150);
		const result = await pending;

		expect(Date.now() - started).toBeLessThan(3_000);
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toBe("Tool execution aborted");

		// The connection survives the cancel — later calls still go through.
		const after = await sleepTool.call(
			{ ms: 1 },
			{ callId: "t2", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} },
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
