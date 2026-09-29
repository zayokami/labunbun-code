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

/**
 * Two axes, not one list.
 *
 * A permission mode decides *which calls ask*. A sandbox mode decides *what the
 * process may touch at all*. They are different questions — a mode that never
 * asks still runs something, and that something can delete files or open a
 * socket whether or not a human was consulted — so they are two enumerations
 * here and the pair is what a user actually picks. Codex composes them the same
 * way (`AskForApproval` × `SandboxMode` in `codex-rs/protocol/src/protocol.rs:986`
 * and `config_types.rs:104`), and Claude Code made the same split when it
 * replaced `danger-full-access` with a nested `sandbox` object.
 *
 * Each type is derived from its list, and every consumer — the zod schema in
 * `settings.ts`, the CLI validator, the picker — reads these two arrays rather
 * than re-spelling them. That claim is worth making because it was made before
 * and was false: `settings.ts` carried a hand-written `z.enum` of the same five
 * names, so a mode added here was a mode everywhere except in the one place a
 * user could set it.
 */
export const PERMISSION_MODES = ["ask", "plan", "agent"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const SANDBOX_MODES = ["workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/**
 * What the picker shows: the two axes composed, in the order they escalate.
 *
 * `id` is what the user typed and what `/mode <id>` takes, so it is not the same
 * string as either axis value — `agentNoSandbox` names a pairing, not a mode.
 * Order is load-bearing twice over: it is the picker's row order and the
 * default's row, so the first entry is the default (`mode-command.test.ts`
 * pins the marker on row 0 rather than trusting this comment).
 */
export interface ModeChoice {
	id: string;
	mode: PermissionMode;
	sandbox: SandboxMode;
	label: string;
	hint: string;
}

export const MODE_CHOICES: readonly ModeChoice[] = [
	{
		id: "ask",
		mode: "ask",
		sandbox: "workspace-write",
		label: "Ask",
		hint: "read and research freely; ask before every write and command",
	},
	{
		id: "plan",
		mode: "plan",
		sandbox: "workspace-write",
		label: "Plan",
		hint: "ask mode with no mutations at all — research and design, then ExitPlanMode for approval",
	},
	{
		id: "agent",
		mode: "agent",
		sandbox: "workspace-write",
		label: "Agent",
		hint: "every call runs without asking; a dangerous command is refused outright",
	},
	{
		id: "agentNoSandbox",
		mode: "agent",
		sandbox: "danger-full-access",
		label: "Agent 无沙箱",
		hint: "the same, with the sandbox axis set to no confinement",
	},
];

/** The choice a session starts in, and the one `resolveMode` falls back to. */
export const DEFAULT_MODE_CHOICE: ModeChoice = MODE_CHOICES[0];

/** Look a choice up by the id a user typed. */
export function findModeChoice(id: string): ModeChoice | undefined {
	return MODE_CHOICES.find((choice) => choice.id === id);
}

/**
 * The pairing a mode implies when the other axis was not set.
 *
 * Only used to fill in an axis someone left out — a user who wrote
 * `permissionMode: "agent"` and no `sandbox` gets the sandboxed pairing, because
 * the escalation is in the id, not the other way round.
 */
export const DEFAULT_SANDBOX_FOR_MODE: Record<PermissionMode, SandboxMode> = {
	ask: "workspace-write",
	plan: "workspace-write",
	agent: "workspace-write",
};

export type PermissionResult =
	| { behavior: "allow"; updatedInput?: unknown }
	| { behavior: "deny"; message: string }
	| { behavior: "ask"; message?: string };

export interface PermissionContext {
	mode: PermissionMode;
	/**
	 * The other axis. Carried alongside `mode` because the two are decided
	 * together and a resolver that only saw the mode would be reasoning about
	 * half the question — `agent` with a sandbox and `agent` without one are the
	 * same approval policy and a materially different blast radius.
	 */
	sandbox: SandboxMode;
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
	/**
	 * The sandbox axis as it stands for *this* call.
	 *
	 * Read per call rather than captured when the tool was built, because `/mode`
	 * can change it mid-session and a tool holding the value it was constructed
	 * with would keep running the old one — the same staleness `plan-mode.ts` had
	 * with `previousModes` recording one axis of a pair. The session is the single
	 * source for it, so there is no second copy here to fall out of step.
	 *
	 * Required rather than optional so that forgetting it is a type error at every
	 * construction site, instead of an unsandboxed command that runs because
	 * nobody supplied the field.
	 */
	sandbox: SandboxMode;
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
 * isConcurrencySafe=false, isReadOnly=false.
 *
 * There is deliberately no per-tool permission hook. A tool that decided its own
 * permission would be a second source of truth beside `evaluatePermissions`,
 * which is the only thing that sees the mode, the sandbox, the rules and the
 * workspace roots at once. One used to be declared here (`checkPermissions`,
 * implemented by Edit and Write as "edits inside the workspace → allow,
 * otherwise ask") and nothing ever called it. The engine already answered the
 * same question, and wiring the tool's answer in would have allowed a write
 * outside the workspace that the engine asks about, because the tool never
 * learned where the workspace was. `tool-contract.test.ts` holds the line.
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
	/**
	 * Compose the text of a user message, once, at the moment it is stored.
	 *
	 * Called for every user message the session appends — a prompt, a steered
	 * message, a queued follow-up — before that message exists anywhere. What it
	 * returns is what the transcript holds and therefore what every later request
	 * sends, byte for byte, for the rest of the conversation.
	 *
	 * That timing is the whole reason this hook exists rather than a rewrite in
	 * {@link transformContext}: context attached after the fact appears in one
	 * request and not the next, and a provider caches a prefix — so the request
	 * that carries the extra text writes an entry nothing will ever read again,
	 * and every request after it is charged for the whole tail at full price.
	 * Whatever belongs to a message has to be part of it from the start.
	 *
	 * Implementations should not throw: this runs before the user's own text is
	 * anywhere, and a throw here loses the prompt.
	 */
	composeUserMessage?: (text: string) => string | Promise<string>;
	/**
	 * Rewrite the context one request is about to be sent with.
	 *
	 * Kept for embedders that need a view — a filtered transcript, an injected
	 * instruction — because it is the only seam that can change a request without
	 * changing the session. It is the wrong place to attach anything that varies
	 * per turn: any change to the middle of the prefix invalidates the cache from
	 * that point on, which is why the app layer uses `composeUserMessage` above
	 * and registers the rewrites it does mean to make.
	 */
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
	| { type: "tool_execution_end"; callId: string; toolName: string; result: ToolResultMessage }
	/**
	 * A failed attempt is about to be retried after `delayMs`.
	 *
	 * The ladder can run for minutes and says nothing on its own, so the wait is
	 * announced rather than merely suffered. Not a turn boundary: the turn that
	 * raised this is still in flight.
	 */
	| { type: "retry"; attempt: number; delayMs: number; message: string };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

/**
 * One line for a retry event: what failed, and how long the wait is.
 *
 * Shared so the REPL and headless mode describe the same wait the same way —
 * the retry itself is silent otherwise, and a user watching two different
 * phrasings of it would be reading two different products.
 */
export function formatRetryNotice(retry: { attempt: number; delayMs: number; message: string }): string {
	const wait = retry.delayMs < 1000 ? `${retry.delayMs}ms` : `${Math.round(retry.delayMs / 1000)}s`;
	return `Retrying in ${wait} (attempt ${retry.attempt} failed): ${retry.message}`;
}

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
