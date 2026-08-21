export const MCP_PACKAGE_VERSION = "0.1.0";

export {
	approveMcpServer,
	connectAllMcpServers,
	connectMcpServer,
	loadApprovedMcpServers,
	loadMcpConfig,
	loadProjectMcpServerNames,
	type McpConnection,
	type McpServerConfig,
	McpServerConfigSchema,
} from "./client.ts";
