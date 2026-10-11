export const MCP_PACKAGE_VERSION = "0.1.0";

export {
	approveMcpServer,
	connectAllMcpServers,
	connectMcpServer,
	disconnectAllMcpServers,
	loadApprovedMcpServers,
	loadMcpConfig,
	loadProjectMcpServerNames,
	type McpConfigError,
	type McpConfigLoad,
	type McpConnection,
	type McpServerConfig,
	McpServerConfigSchema,
	parseMcpServersRecord,
} from "./client.ts";
