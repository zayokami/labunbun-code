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
	ThinkingLevel,
	ToolResultContent,
	ToolResultMessage,
	WireTool,
} from "@labunbun/ai";
import { z } from "zod";
import type { NetworkDomainRule } from "./network-policy.ts";
import type { SpillWriter } from "./output-limits.ts";
import type { NetworkSandboxPolicy } from "./sandbox-policy.ts";

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
 * here and the pair is what a user actually picks.
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
 * The pairing a session is in, named for a human.
 *
 * Prefers the choice's own label, so the answer is "Agent 无沙箱" rather than
 * "agent · danger-full-access" — the second is a fact and the first is what the
 * user asked for, and naming a combination the picker has no row for would
 * suggest a fifth mode exists. Falls back to the raw pair for a combination the
 * picker does not have, which is a real state (`settings.json` can set either
 * axis alone) and is better shown accurately than rounded to a neighbour.
 */
export function describeModeChoice(mode: PermissionMode, sandbox: SandboxMode): string {
	const named = MODE_CHOICES.find((c) => c.mode === mode && c.sandbox === sandbox);
	return named ? named.label : `${mode} · ${sandbox}`;
}

/**
 * The next row after the one a session is in, wrapping at the end.
 *
 * Forward means *up* the escalation, and it means the same thing in both
 * directions of the wrap: the last row is the widest grant on offer, so the
 * step off the end lands on `Ask` rather than stopping. A cycle that dead-ended
 * on its most permissive row would leave one more press of the key doing
 * nothing exactly where being wrong costs the most, and a key that means nothing
 * is the failure this package's own key lists are written against.
 *
 * **The anchor when the session is in a pair with no row.** `settings.json` can
 * set the two axes to a combination the picker never offered — `plan` with
 * `danger-full-access` is reachable that way, and `mode-enum.test.ts` walks the
 * whole cross product, so the case is real rather than theoretical. Anchoring on
 * the exact pair would then have no index to advance from, and the two ways to
 * paper over that are both bad: picking row 0 would throw away a mode the user
 * configured on purpose, and refusing to cycle would make the key dead in
 * exactly the configuration that needed it explained. So the anchor is the
 * **last row carrying the same mode**, which keeps the mode the user chose and
 * lets the sandbox axis land wherever the table puts it. The label the caller
 * then shows is `describeModeChoice`'s, so the combination the user ends up in is
 * always named — nothing about the move is silent.
 */
export function cycleModeChoice(current: { mode: PermissionMode; sandbox: SandboxMode }): ModeChoice {
	const exact = MODE_CHOICES.findIndex((c) => c.mode === current.mode && c.sandbox === current.sandbox);
	const index = exact >= 0 ? exact : lastRowWithMode(current.mode);
	return MODE_CHOICES[(index + 1) % MODE_CHOICES.length];
}

/**
 * Where a mode's rows end, or row 0 when the mode has none.
 *
 * `lastRowWithMode` is only ever reached with a mode that has no exact row, and
 * every `PermissionMode` has at least one row, so the `-1` is unreachable from
 * the type system — but the function is total anyway, because a caller that gets
 * `MODE_CHOICES[-1 + 1]` is `MODE_CHOICES[0]`, which is the safe default anyway,
 * and a `NaN` index would be neither.
 */
function lastRowWithMode(mode: PermissionMode): number {
	for (let i = MODE_CHOICES.length - 1; i >= 0; i--) {
		if (MODE_CHOICES[i]?.mode === mode) return i;
	}
	return 0;
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

/**
 * The network axis, as one value: a mode and the domain table it is judged
 * against. `SandboxPolicy` carries the same pair for the same reason.
 */
export interface NetworkAxis {
	/** `enabled` reaches what the host can; `restricted` reaches only an allowed domain. */
	access: NetworkSandboxPolicy;
	/** The table. Empty is meaningful: under `restricted` it reaches nothing. */
	domains: NetworkDomainRule[];
}

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
	/**
	 * The network axis as it stands for *this* call: the mode, and the domain
	 * table it is judged against.
	 *
	 * One field rather than two for the same reason the policy carries
	 * `networkRules` beside `network`: a mode without its table is not a
	 * configuration anybody can write, and two fields are two things a caller
	 * can update one of.
	 *
	 * Required rather than optional, like `sandbox`: a tool that forgot this
	 * would build a policy that confines nothing, and it would do so silently,
	 * which is the failure mode this whole axis exists to prevent.
	 */
	network: NetworkAxis;
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
	 * How hard the model should think, read per request so a change made
	 * mid-session lands on the next model call rather than the next session.
	 *
	 * A reader rather than a value because the choice belongs to the host: the
	 * settings layer that holds it lives in the app package, and this one takes
	 * the answer as a closure instead of importing that layer. Returning
	 * `undefined` means the settings key is unset, which leaves the default to
	 * the adapter — it is the one that knows what each model row declares.
	 */
	thinkingLevel?: () => ThinkingLevel | undefined;
	/**
	 * Where a tool result too large for the context is kept in full, supplied by
	 * the app layer because the agent has no filesystem of its own. Returns the
	 * path to show the model, or null if it could not be written.
	 */
	spillOutput?: SpillWriter;
	/**
	 * How long a cancelled run keeps waiting for in-flight tools before it
	 * settles them as interrupted and ends. The default (500 ms) gives a tool
	 * that respects its signal time to return a real result without letting a
	 * tool that ignores the signal hold the run hostage. Tests shorten it.
	 */
	abortSettleGraceMs?: number;
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
