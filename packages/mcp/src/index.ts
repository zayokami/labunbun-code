export const MCP_PACKAGE_VERSION = "0.1.0";

export {
	connectAllMcpServers,
	connectMcpServer,
	loadMcpConfig,
	type McpConnection,
	type McpServerConfig,
	McpServerConfigSchema,
} from "./client.ts";
