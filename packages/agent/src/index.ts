export const AGENT_PACKAGE_VERSION = "0.1.0";

// Compaction
export {
	COMPACTION_DISABLED_NOTICE,
	type CompactionConfig,
	CompactionManager,
	type CompactionManagerDeps,
	type CompactionPhase,
	type ContextBreakdown,
	compactionBoundary,
	compactionThreshold,
	contextBreakdown,
	dropOldestRound,
	estimateContextTokens,
	estimateContextUsage,
	extractRecentFiles,
	hardContextLimit,
	keepSuffix,
	microcompact,
	SUMMARY_PROMPT,
	stripAnalysis,
} from "./compaction.ts";
export { partitionToolCalls, type ToolBatch } from "./concurrency.ts";
// Bounding what tool output may enter the conversation
export {
	capRoundResults,
	cutText,
	MAX_ROUND_RESULT_CHARS,
	MIN_ROUND_RESULT_CHARS,
	type SpillRequest,
	type SpillWriter,
} from "./output-limits.ts";
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
	type CompactionRecord,
	type CompactionTrigger,
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
	CompactionCheck,
	LoopHooks,
	PermissionContext,
	PermissionMode,
	PermissionResult,
	ResolvedToolCall,
	Tool,
	ToolCallContext,
	ToolResult,
	TrimmedToolResults,
} from "./types.ts";
export { allow, ask, buildTool, deny, formatRetryNotice, PERMISSION_MODES, toWireTools } from "./types.ts";
