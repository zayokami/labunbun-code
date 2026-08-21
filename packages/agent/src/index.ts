export const AGENT_PACKAGE_VERSION = "0.1.0";

// Compaction
export {
	type CompactionConfig,
	CompactionManager,
	type CompactionManagerDeps,
	compactionThreshold,
	estimateContextTokens,
	extractRecentFiles,
	hardContextLimit,
	microcompact,
	SUMMARY_PROMPT,
	stripAnalysis,
} from "./compaction.ts";
export { partitionToolCalls, type ToolBatch } from "./concurrency.ts";
// Permission rule engine
export {
	evaluatePermissions,
	formatRule,
	inputMatchesSpecifier,
	normalizePathSpec,
	type PermissionEngineConfig,
	type PermissionRule,
	parseRuleList,
	parseRuleText,
	RULE_SOURCE_ORDER,
	type RuleSource,
	specifierToRegExp,
} from "./permissions.ts";
// Pipeline / concurrency
export { type PipelineRunOptions, runToolPipeline } from "./pipeline.ts";
// Session loop
export { AgentSession, type AgentSessionOptions } from "./session.ts";
// Session persistence
export {
	newEntryId,
	type SessionEntry,
	SessionStore,
	sanitizeCwd,
	sessionFilePath,
	sessionsRoot,
} from "./session-store.ts";
// Core types
export type {
	AgentDeps,
	AgentEndReason,
	AgentEvent,
	AgentEventHandler,
	AnyTool,
	BeforeToolCallDecision,
	LoopHooks,
	PermissionContext,
	PermissionMode,
	PermissionResult,
	ResolvedToolCall,
	Tool,
	ToolCallContext,
	ToolResult,
} from "./types.ts";
export { allow, ask, buildTool, deny, toWireTools } from "./types.ts";
