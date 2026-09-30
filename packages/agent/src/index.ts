export const AGENT_PACKAGE_VERSION = "0.1.0";

// Activity heatmap and streaks, aggregated from the session files on disk
export {
	type ActivityDay,
	type ActivityRange,
	type ActivityReport,
	type ActivityTotals,
	activityLevel,
	civilDayNumber,
	collectActivity,
	type IntensityThresholds,
	intensityThresholds,
	localDayKey,
	type Streaks,
	startOfLocalDay,
	windowStartFor,
} from "./activity.ts";
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
// Dangerous-command classification
export {
	classifyDangerousCommand,
	type DangerousCommandMatch,
	type DangerousCommandPlatform,
	MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH,
} from "./dangerous-command.ts";
// Which hosts a confined command may reach. Also data only — the proxy that
// enforces it is in @labunbun/tools, which depends on this package.
export {
	decideNetworkRequest,
	describeNetworkPolicy,
	domainMatches,
	matchDomainRule,
	NETWORK_DOMAIN_PERMISSIONS,
	type NetworkDecision,
	type NetworkDenialReason,
	type NetworkDomainPermission,
	type NetworkDomainRule,
	needsNetworkProxy,
	normalizeHost,
} from "./network-policy.ts";
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
	PLAN_MODE_READ_ONLY_TOOLS,
	parseRuleList,
	parseRuleText,
	RULE_SOURCE_ORDER,
	type RuleSource,
	specifierToRegExp,
} from "./permissions.ts";
// Pipeline / concurrency
export { type PipelineRunOptions, runToolPipeline } from "./pipeline.ts";
// The sandbox policy: data only. The backends that turn it into something
// executable live in @labunbun/tools, which depends on this package.
export {
	type BuildSandboxPolicyOptions,
	buildSandboxPolicy,
	canRead,
	canWrite,
	type FileSystemAccessMode,
	type FileSystemSandboxEntry,
	type FileSystemSandboxKind,
	type FileSystemSandboxPolicy,
	isWritePermitted,
	NETWORK_SANDBOX_POLICIES,
	type NetworkSandboxPolicy,
	type SandboxPolicy,
} from "./sandbox-policy.ts";
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
// Shell tokenizing, shared with the classifier
export { COMMAND_SEPARATOR_RE, splitShellCommands, tokenizeShell } from "./shell-tokens.ts";
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
	ModeChoice,
	NetworkAxis,
	PermissionContext,
	PermissionMode,
	PermissionResult,
	ResolvedToolCall,
	SandboxMode,
	Tool,
	ToolCallContext,
	ToolResult,
	TrimmedToolResults,
} from "./types.ts";
export {
	allow,
	ask,
	buildTool,
	DEFAULT_MODE_CHOICE,
	DEFAULT_SANDBOX_FOR_MODE,
	deny,
	findModeChoice,
	formatRetryNotice,
	MODE_CHOICES,
	PERMISSION_MODES,
	SANDBOX_MODES,
	toWireTools,
} from "./types.ts";
