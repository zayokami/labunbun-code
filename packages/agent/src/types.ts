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
import type { SpillWriter } from "./output-limits.ts";

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
	/**
	 * The run's abort signal. A resolver that shows a dialog should give up when
	 * this fires: the tool it is asking about is already being settled as
	 * interrupted, and the batch awaiting the answer would otherwise wait on a
	 * question nobody is looking at any more.
	 */
	signal?: AbortSignal;
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
	/**
	 * What happens to the text past {@link maxResultSizeChars}.
	 *
	 * `"truncate"` (the default) keeps the head and drops the rest, which is
	 * right for output the model can ask for again — a smaller file range, a
	 * narrower query. `"spill"` writes the full text to the app's tool-output
	 * directory and leaves a path in its place, for output that exists only once
	 * and would otherwise be gone: a command's stdout, a search over a tree.
	 *
	 * Either way the result says what is missing; the difference is whether
	 * anything can be done about it.
	 */
	overflow?: "truncate" | "spill";
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
		overflow: "truncate",
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
	 * Consulted before every model call: `null` sends the context as it is, a
	 * `compact` or `reduced` action sends its context instead, and `blocked` ends
	 * the run with a message the user can act on — the request does not fit and
	 * nothing could free space.
	 *
	 * `force` says the estimate has been proven wrong about this session: the
	 * provider refused the last request for size, so the threshold does not get
	 * to decide again.
	 */
	checkCompaction?: (context: Context, options?: { force?: boolean }) => Promise<CompactionCheck | null>;
	/**
	 * Where a tool result too large for the context is kept in full, supplied by
	 * the app layer because the agent has no filesystem of its own. Returns the
	 * path to show the model, or null if it could not be written.
	 */
	spillOutput?: SpillWriter;
}

/** What the cheap rung removed, in the units a person reads. */
export interface TrimmedToolResults {
	/** How many tool results were replaced by a preview of themselves. */
	results: number;
	/** How many characters those previews gave up. */
	chars: number;
}

/**
 * The answer to "can this context be sent?". `null` never appears here — it is
 * the absence of an answer — so callers that got one always have a decision.
 *
 * `reduced` is not a lesser `compact`: it made no model call and wrote no
 * summary, so a caller that treats the two alike will report one that did not
 * happen. Both are a context to send instead of the one that was offered.
 */
export type CompactionCheck =
	| { action: "compact"; context: Context }
	| { action: "reduced"; context: Context; cleared: TrimmedToolResults }
	| { action: "blocked"; message: string };

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
