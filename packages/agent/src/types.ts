/**
 * Core agent types: the Tool contract, AgentEvent stream, permission shapes,
 * and loop dependency-injection surface.
 *
 * The Tool interface deliberately lives here (below the app layer) so that
 * @labunbun/tools, @labunbun/mcp and @labunbun/tui can depend on it without
 * dragging in the CLI application.
 */

import type {
	AgentMessage,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	JsonSchemaObject,
	StreamFn,
	ToolResultContent,
	ToolResultMessage,
	WireTool,
} from "@labunbun/ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionMode = "default" | "plan" | "acceptEdits" | "dontAsk" | "bypassPermissions";

export type PermissionResult =
	| { behavior: "allow"; updatedInput?: unknown }
	| { behavior: "deny"; message: string }
	| { behavior: "ask"; message?: string };

export interface PermissionContext {
	mode: PermissionMode;
	toolName: string;
	input: unknown;
	cwd: string;
}

export function allow(updatedInput?: unknown): PermissionResult {
	return { behavior: "allow", updatedInput };
}

export function deny(message: string): PermissionResult {
	return { behavior: "deny", message };
}

export function ask(message?: string): PermissionResult {
	return { behavior: "ask", message };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolCallContext {
	/** Unique id of the originating tool_use block. */
	callId: string;
	signal: AbortSignal;
	cwd: string;
	/** Stream partial results (live bash output, progress lines...). */
	onUpdate: (partial: unknown) => void;
}

export interface ToolResult {
	content: ToolResultContent[];
	isError?: boolean;
	/** Structured extra data for UI renderers / subagent plumbing. */
	details?: unknown;
}

/**
 * A tool. `inputSchema` is the single source of truth: zod validates model
 * input and `z.toJSONSchema` produces the wire schema at registry build time.
 *
 * All optionals fail closed via `buildTool`:
 * isConcurrencySafe=false, isReadOnly=false, checkPermissions=allow.
 */
export interface Tool<TInput extends z.ZodType = z.ZodType> {
	name: string;
	description: string;
	inputSchema: TInput;
	/** Contribution to the system prompt describing when/how to use this tool. */
	prompt?: string;
	isEnabled?: () => boolean;
	isReadOnly?: (input: z.infer<TInput>) => boolean;
	isConcurrencySafe?: (input: z.infer<TInput>) => boolean;
	checkPermissions?: (input: z.infer<TInput>, ctx: PermissionContext) => Promise<PermissionResult>;
	/** Semantic validation after schema parsing, before permissions. */
	validateInput?: (input: z.infer<TInput>) => Promise<string | null>;
	call: (input: z.infer<TInput>, ctx: ToolCallContext) => Promise<ToolResult>;
	/** Results longer than this are truncated by the pipeline. */
	maxResultSizeChars?: number;
}

export type AnyTool = Tool<z.ZodType>;

/** Fill fail-closed defaults for optional Tool members. */
export function buildTool<TInput extends z.ZodType>(def: Tool<TInput>): Tool<TInput> {
	return {
		isEnabled: () => true,
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		checkPermissions: async () => allow(),
		maxResultSizeChars: 30_000,
		...def,
	};
}

/** A tool paired with its parsed input, ready for execution. */
export interface ResolvedToolCall {
	callId: string;
	tool: AnyTool;
	input: unknown;
}

// ---------------------------------------------------------------------------
// Loop hooks (config-level extension points — how permission gates, plan mode
// and custom compaction attach without touching core)
// ---------------------------------------------------------------------------

export interface BeforeToolCallDecision {
	block?: boolean;
	reason?: string;
	updatedInput?: unknown;
}

export interface LoopHooks {
	beforeToolCall?: (
		toolName: string,
		input: unknown,
		ctx: PermissionContext,
	) => Promise<BeforeToolCallDecision | undefined>;
	afterToolCall?: (
		toolName: string,
		input: unknown,
		result: ToolResultMessage,
	) => Promise<ToolResultMessage | undefined>;
	transformContext?: (context: Context) => Context | Promise<Context>;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface AgentDeps {
	/** Provider boundary — the loop never imports adapters directly. */
	streamFn: StreamFn;
	/**
	 * Permission resolver supplied by the app layer (rule engine + UI dialog).
	 * Absent → everything allowed (headless tests).
	 */
	canUseTool?: (toolName: string, input: unknown, ctx: PermissionContext) => Promise<PermissionResult>;
	hooks?: LoopHooks;
	/**
	 * Called each turn with the current context size estimate; returns a
	 * compacted replacement when the threshold is crossed. (Full impl: Phase 5.)
	 */
	checkCompaction?: (context: Context) => Promise<Context | null>;
}

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

export type AgentEndReason = "completed" | "aborted" | "error" | "max_turns";

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; reason: AgentEndReason; messages: AgentMessage[]; errorMessage?: string }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "message_update"; message: AssistantMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "tool_execution_start"; callId: string; toolName: string; input: unknown }
	| { type: "tool_execution_update"; callId: string; toolName: string; partial: unknown }
	| { type: "tool_execution_end"; callId: string; toolName: string; result: ToolResultMessage };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Wire conversion
// ---------------------------------------------------------------------------

/** Build the wire tool list for the model from a Tool registry. */
export function toWireTools(tools: AnyTool[]): WireTool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: z.toJSONSchema(tool.inputSchema) as JsonSchemaObject,
	}));
}
