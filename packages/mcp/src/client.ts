/**
 * MCP client: connects servers over stdio or StreamableHTTP and adapts their
 * tools into the agent Tool registry under `mcp__<server>__<tool>` names.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AnyTool, buildTool, type ToolResult } from "@labunbun/agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

export const McpServerConfigSchema = z.union([
	z.object({
		type: z.literal("stdio").default("stdio"),
		command: z.string(),
		args: z.array(z.string()).default([]),
		env: z.record(z.string(), z.string()).optional(),
		cwd: z.string().optional(),
	}),
	z.object({
		type: z.literal("http").default("http"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
]);

export type McpServerConfig = z.input<typeof McpServerConfigSchema>;

export interface McpConnection {
	serverName: string;
	client: Client;
	tools: AnyTool[];
	prompts: Array<{ name: string; description?: string }>;
	error?: string;
}

/** Convert a JSON Schema object to a zod schema for tool input validation. */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
	// MCP tools declare JSON Schema; we validate structurally with a passthrough
	// object schema so unknown-but-valid shapes still flow through.
	if (schema.type === "object") {
		const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
		const required = new Set((schema.required as string[] | undefined) ?? []);
		const shape: Record<string, z.ZodType> = {};
		for (const [key, prop] of Object.entries(properties)) {
			shape[key] = jsonSchemaToZod(prop).optional();
			if (required.has(key)) {
				shape[key] = jsonSchemaToZod(prop);
			}
		}
		return z.object(shape).passthrough();
	}
	if (schema.type === "string") return z.string();
	if (schema.type === "number" || schema.type === "integer") return z.number();
	if (schema.type === "boolean") return z.boolean();
	if (schema.type === "array") return z.array(z.unknown());
	return z.unknown();
}

/** Connect to one MCP server and adapt its tools. Never throws. */
export async function connectMcpServer(serverName: string, config: McpServerConfig): Promise<McpConnection> {
	const parsed = McpServerConfigSchema.safeParse(config);
	if (!parsed.success) {
		return {
			serverName,
			client: null as never,
			tools: [],
			prompts: [],
			error: `invalid config: ${parsed.error.message}`,
		};
	}

	try {
		const transport =
			"type" in parsed.data && parsed.data.type === "http"
				? new StreamableHTTPClientTransport(new URL(parsed.data.url), {
						requestInit: { headers: parsed.data.headers },
					})
				: new StdioClientTransport({
						command: (parsed.data as { command: string }).command,
						args: (parsed.data as { args: string[] }).args,
						env: (parsed.data as { env?: Record<string, string> }).env,
						cwd: (parsed.data as { cwd?: string }).cwd,
					});

		const client = new Client({ name: "labunbun", version: "0.1.0" });
		await client.connect(transport);

		const toolList = await client.listTools();
		const promptList = await client.listPrompts().catch(() => ({ prompts: [] }));

		const tools: AnyTool[] = (toolList.tools ?? []).map((mcpTool) =>
			buildTool({
				name: `mcp__${serverName}__${mcpTool.name}`,
				description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${serverName}`,
				inputSchema: jsonSchemaToZod(
					(mcpTool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
				) as z.ZodType,
				isReadOnly: () => false,
				isConcurrencySafe: () => true,
				call: async (input, ctx): Promise<ToolResult> => {
					try {
						const result = await client.callTool({
							name: mcpTool.name,
							arguments: input as Record<string, unknown>,
						});
						const content = Array.isArray(result.content)
							? result.content.map((block) =>
									(block as { type: string; text?: string }).type === "text"
										? { type: "text" as const, text: String((block as { text?: string }).text ?? "") }
										: { type: "text" as const, text: JSON.stringify(block) },
								)
							: [{ type: "text" as const, text: JSON.stringify(result) }];
						return { content, isError: Boolean(result.isError) };
					} catch (error) {
						ctx.onUpdate({ mcpError: String(error) });
						return {
							content: [{ type: "text", text: `MCP call failed: ${error instanceof Error ? error.message : error}` }],
							isError: true,
						};
					}
				},
			}),
		);

		return {
			serverName,
			client,
			tools,
			prompts: (promptList.prompts ?? []).map((p) => ({ name: p.name, description: p.description })),
		};
	} catch (error) {
		return {
			serverName,
			client: null as never,
			tools: [],
			prompts: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Load .mcp.json from a project root (and user scope). */
export function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	for (const path of [join(cwd, ".mcp.json"), join(home, ".labunbun", ".mcp.json")]) {
		try {
			if (!existsSync(path)) continue;
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
			Object.assign(out, parsed.mcpServers ?? {});
		} catch {}
	}
	return out;
}

/**
 * Server names sourced specifically from the project-level `<cwd>/.mcp.json`
 * — as opposed to user scope (`~/.labunbun/.mcp.json`). When `cwd` is a
 * cloned repo the user doesn't control, this file ships with the repo and is
 * attacker-controlled, unlike the home-directory config the user wrote themselves.
 */
export function loadProjectMcpServerNames(cwd: string): Set<string> {
	const path = join(cwd, ".mcp.json");
	try {
		if (!existsSync(path)) return new Set();
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
		return new Set(Object.keys(parsed.mcpServers ?? {}));
	} catch {
		return new Set();
	}
}

function localSettingsPath(cwd: string): string {
	return join(cwd, ".labunbun", "settings.local.json");
}

/**
 * Project-scoped MCP servers explicitly approved by the user, read from
 * `.labunbun/settings.local.json` — gitignored and machine-local, so unlike
 * `.labunbun/settings.json` it can't be pre-populated by a cloned repo to
 * self-approve its own servers.
 */
export function loadApprovedMcpServers(cwd: string): Set<string> {
	const path = localSettingsPath(cwd);
	try {
		if (!existsSync(path)) return new Set();
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { approvedMcpServers?: string[] };
		return new Set(parsed.approvedMcpServers ?? []);
	} catch {
		return new Set();
	}
}

/** Persist one more approved server name into local settings (creates the file/dir as needed). */
export function approveMcpServer(cwd: string, serverName: string): void {
	const path = localSettingsPath(cwd);
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(path)) existing = JSON.parse(readFileSync(path, "utf8"));
	} catch {}
	const approved = new Set<string>(Array.isArray(existing.approvedMcpServers) ? existing.approvedMcpServers : []);
	approved.add(serverName);
	existing.approvedMcpServers = [...approved];
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

/** Connect all configured servers in parallel. */
export async function connectAllMcpServers(
	configs: Record<string, McpServerConfig>,
	approvedServers?: Set<string>,
): Promise<McpConnection[]> {
	return Promise.all(
		Object.entries(configs).map(async ([name, config]) => {
			if (approvedServers && !approvedServers.has(name)) {
				return { serverName: name, client: null as never, tools: [], prompts: [], error: "not approved" };
			}
			return connectMcpServer(name, config);
		}),
	);
}
