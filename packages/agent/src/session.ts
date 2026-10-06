/**
 * AgentSession — the stateful conversation runner.
 *
 * Loop shape (per plan): context prep → drain steering → stream → finalize →
 * branch on stopReason → tool execution → feed results back. The presence of
 * toolCall blocks is THE loop-continue signal; stopReason alone is never
 * trusted (OpenAI-family finish_reason is unreliable).
 *
 * Recovery features ported from the reference architecture:
 * - orphaned tool_use synthesis on abnormal termination (wire pairing)
 * - max_output_tokens ladder (escalate once, then ≤3 continue-retries)
 * - steering queue (inject before next model call) and followUp queue
 *   (restart after natural termination)
 */
import type {
	AgentMessage,
	AssistantMessage,
	Context,
	Model,
	StreamOptions,
	ToolCall,
	ToolResultMessage,
} from "@labunbun/ai";
import { isContextOverflowError, textContent, toolResultMessage, userMessage } from "@labunbun/ai";
import { LENGTH_RECOVERY_MESSAGE } from "./compaction.ts";
import { DEFAULT_MAX_CONCURRENCY, partitionToolCalls, Semaphore } from "./concurrency.ts";
import { capRoundResults } from "./output-limits.ts";
import { runToolPipeline } from "./pipeline.ts";
import type {
	AgentDeps,
	AgentEndReason,
	AgentEvent,
	AgentEventHandler,
	AnyTool,
	NetworkAxis,
	PermissionMode,
	ResolvedToolCall,
	SandboxMode,
} from "./types.ts";
import { DEFAULT_MODE_CHOICE, DEFAULT_SANDBOX_FOR_MODE, toWireTools } from "./types.ts";

export interface AgentSessionOptions {
	model: Model;
	systemPrompt?: string;
	tools?: AnyTool[];
	deps: AgentDeps;
	store?: import("./session-store.ts").SessionStore;
	cwd?: string;
	maxTurns?: number;
	permissionMode?: PermissionMode;
	sandbox?: SandboxMode;
	/** The network axis. Defaults to `enabled` with no table — today's behaviour. */
	network?: NetworkAxis;
}

const MAX_OUTPUT_TOKENS_CAP = 64_000;
const LENGTH_CONTINUE_RETRIES = 3;
/**
 * How long a cancelled run keeps waiting for in-flight tools before it settles
 * them as interrupted and ends: long enough for a tool that respects its signal
 * to return a real result, short enough that a tool ignoring the signal cannot
 * hold the run hostage. The host can shorten it via the agent deps.
 */
const DEFAULT_ABORT_SETTLE_GRACE_MS = 500;

export class AgentSession {
	readonly cwd: string;
	messages: AgentMessage[] = [];

	#model: Model;
	#systemPrompt: string;
	#tools: AnyTool[];
	#wireTools: Context["tools"];
	#deps: AgentDeps;
	#store?: import("./session-store.ts").SessionStore;
	#maxTurns: number;
	#permissionMode: PermissionMode;
	#sandbox: SandboxMode;
	#network: NetworkAxis;

	#handlers = new Set<AgentEventHandler>();
	#steering: string[] = [];
	#followUp: string[] = [];
	#abortController: AbortController | null = null;
	#interruptRequested = false;
	#running = false;
	#contextOverflowed = false;
	/**
	 * Whether this run has already answered one refusal for size by making room
	 * and sending again. Once per run: a second refusal of the same request is
	 * the provider's answer, and a run that kept retrying would be a loop that
	 * pays for a summarization on every pass.
	 */
	#overflowRetried = false;

	constructor(options: AgentSessionOptions) {
		this.#model = options.model;
		this.#systemPrompt = options.systemPrompt ?? "";
		this.#tools = [...(options.tools ?? [])];
		this.#deps = options.deps;
		this.#store = options.store;
		this.cwd = options.cwd ?? process.cwd();
		this.#maxTurns = options.maxTurns ?? Number.POSITIVE_INFINITY;
		this.#permissionMode = options.permissionMode ?? DEFAULT_MODE_CHOICE.mode;
		this.#sandbox = options.sandbox ?? DEFAULT_SANDBOX_FOR_MODE[this.#permissionMode];
		this.#network = options.network ?? { access: "enabled", domains: [] };
		// Freeze wire-tool order at construction for prompt-cache stability.
		this.#wireTools = toWireTools(this.#tools);
	}

	// -- configuration --------------------------------------------------------

	get model(): Model {
		return this.#model;
	}

	setModel(model: Model): void {
		this.#model = model;
	}

	get tools(): readonly AnyTool[] {
		return this.#tools;
	}

	setTools(tools: AnyTool[]): void {
		this.#tools = [...tools];
		this.#wireTools = toWireTools(this.#tools);
	}

	setSystemPrompt(prompt: string): void {
		this.#systemPrompt = prompt;
	}

	/**
	 * Move one or both axes.
	 *
	 * `sandbox` is optional so that the plan-mode tools, which only change what
	 * asks, do not have to restate — and so cannot accidentally rewrite — the
	 * axis they never meant to touch.
	 */
	setMode(mode: PermissionMode, sandbox?: SandboxMode): void {
		this.#permissionMode = mode;
		if (sandbox !== undefined) this.#sandbox = sandbox;
	}

	get permissionMode(): PermissionMode {
		return this.#permissionMode;
	}

	get sandbox(): SandboxMode {
		return this.#sandbox;
	}

	/**
	 * The network axis as it stands. Read per call for the same reason
	 * `sandbox` is: `/mode` can change the session and a tool holding the value
	 * it was built with would keep applying the old one.
	 */
	get network(): NetworkAxis {
		return this.#network;
	}

	/**
	 * Change the network axis mid-session.
	 *
	 * Takes the whole `NetworkAxis` rather than two arguments for the reason the
	 * field is one: a mode with no table and a table with no mode are both
	 * configurations nobody means, and a two-argument setter makes producing one
	 * a two-step affair.
	 *
	 * Note what this does **not** do: it does not stop a proxy that is already
	 * listening under the old rules. `ChildProcessExecOperations` keeps one
	 * proxy for the session, so the new rules take effect for the next command
	 * only if the caller rebuilt the operations — which is why the honest
	 * statement in `/permissions` is about what the next command is subject to,
	 * not about the session having changed.
	 */
	setNetwork(network: NetworkAxis): void {
		this.#network = network;
	}

	get isRunning(): boolean {
		return this.#running;
	}

	/** True while an interrupt has been requested and not yet superseded by a
	 *  new run. Latched so a cancellation that lands between the loop's finally
	 *  (which clears the controller) and a pending approval callback is still
	 *  observable. */
	get isInterrupted(): boolean {
		return this.#interruptRequested || (this.#abortController?.signal.aborted ?? false);
	}

	// -- events ---------------------------------------------------------------

	on(handler: AgentEventHandler): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	async #emit(event: AgentEvent): Promise<void> {
		for (const handler of this.#handlers) {
			try {
				await handler(event);
			} catch (handlerError) {
				// A subscriber's bug (a UI reducer, a hook, a logger) must never
				// abort the agent loop or reject prompt() — that turns a rendering
				// bug into a fatal unhandled rejection at every fire-and-forget
				// `void session.prompt(...)` call site.
				console.error(
					`AgentSession: event handler threw on "${event.type}": ${handlerError instanceof Error ? handlerError.message : handlerError}`,
				);
			}
		}
	}

	// -- queues ---------------------------------------------------------------

	/** Inject a message into the CURRENT run, before the next model call. */
	steer(text: string): void {
		this.#steering.push(text);
	}

	/**
	 * Queue a message that restarts the loop after natural termination.
	 *
	 * A run that ends abnormally never reaches the in-loop drain, so the queue
	 * is also drained at the top of the next `prompt()` — ahead of the text
	 * that call carries. That is what keeps the queue from dangling: a
	 * completion notice queued during a failed run is delivered by the next
	 * prompt rather than waiting for a prompt that may never come.
	 */
	followUp(text: string): void {
		if (this.#running) {
			this.#followUp.push(text);
		} else {
			void this.prompt(text);
		}
	}

	/**
	 * The text a user message is stored with.
	 *
	 * One place, so a prompt, a steered message and a queued follow-up cannot
	 * disagree about how a hook's contribution is attached — and so the composed
	 * text is the only version that ever exists, which is what keeps a request
	 * later in the same conversation byte-identical to the one before it. See
	 * `LoopHooks.composeUserMessage` for why that timing is the point.
	 */
	async #userText(text: string): Promise<string> {
		const compose = this.#deps.hooks?.composeUserMessage;
		return compose ? await compose(text) : text;
	}

	abort(): void {
		// Dropping queued follow-ups on explicit abort is the least surprising
		// behavior — stale queued prompts should not fire after an interrupt.
		this.#followUp = [];
		// Steering is the same promise: it says "deliver before the next model
		// call", and there will not be one. Left in place it would be drained at
		// the top of a *later* run's first turn, landing a message the user typed
		// for an interrupted turn after whatever they typed instead.
		this.#steering = [];
		this.#interruptRequested = true;
		this.#abortController?.abort();
	}

	// -- the loop -------------------------------------------------------------

	/**
	 * The context as it would be sent right now, hooks aside.
	 *
	 * `/compact` measures this and summarizes it: the numbers it reports and the
	 * record it writes must be about the whole request — system prompt and tool
	 * schemas included — rather than about the transcript alone, which is what
	 * they were when callers had to hand-build a context and had nothing to put
	 * in those fields.
	 */
	currentContext(): Context {
		return { systemPrompt: this.#systemPrompt, messages: this.messages, tools: this.#wireTools };
	}

	/**
	 * Adopt a context that has been made smaller: the live history becomes what
	 * the pass returned, and — for a summary — the store has already recorded the
	 * boundary it starts from. Used by the auto path, by `/compact`, and by the
	 * cheap rung, whose previews exist only here until the session reloads them.
	 */
	applyCompaction(context: Context): void {
		this.messages = context.messages;
		// Room was made, so the next request is not known to be too large: the
		// estimate gets to decide again.
		this.#contextOverflowed = false;
	}

	/** True when the provider refused the last request for being too large. */
	get contextOverflowed(): boolean {
		return this.#contextOverflowed;
	}

	async prompt(text: string): Promise<AgentEndReason> {
		if (this.#running) throw new Error("AgentSession is already running");
		this.#running = true;
		this.#interruptRequested = false;
		this.#overflowRetried = false;
		this.#abortController = new AbortController();

		// Deliver anything queued while a previous run was alive, ahead of the
		// text this call carries. The in-loop drain only fires when a run
		// terminates naturally, so a follow-up queued during a failed run
		// (error, refusal, abort, an exhausted length ladder) would otherwise
		// sit in the queue until the user happens to type something — forever,
		// in an unattended run. Entry is the one point every ending passes
		// through; the in-loop drain stays because it is what lets a healthy
		// run answer a follow-up without waiting for one.
		while (this.#followUp.length > 0) {
			const queued = this.#followUp.shift();
			if (queued === undefined) break;
			const queuedMsg = userMessage(await this.#userText(queued));
			this.messages.push(queuedMsg);
			this.#store?.appendMessage(queuedMsg);
		}

		const userMsg = userMessage(await this.#userText(text));
		this.messages.push(userMsg);
		this.#store?.appendMessage(userMsg);

		let reason: AgentEndReason = "completed";
		let errorMessage: string | undefined;
		let escalatedOnce = false;
		let continueRetries = 0;
		let turns = 0;
		// Streaming-tool state for the turn in flight. Declared outside the try so
		// the catch can still settle the turn that died; reassigned per iteration
		// because every streamed turn starts its own tools. `earlySettled` records
		// which calls already have a final result — the write-once set that keeps
		// a late straggler from overwriting its interrupted settlement.
		let earlyResults = new Map<string, ToolResultMessage>();
		let earlyPromises = new Map<string, Promise<void>>();
		let earlySettled = new Set<string>();

		await this.#emit({ type: "agent_start" });

		try {
			while (true) {
				// Checked before context preparation and the steering drain, and
				// `turns` counts only turns that reached a `turn_end`: a check
				// that ran after the drain would persist steered messages this
				// run never answers, and counting attempts charged the budget
				// for the length ladder's retries too — the run then stopped
				// having completed fewer turns than the limit allows.
				if (turns >= this.#maxTurns) {
					reason = "max_turns";
					break;
				}
				// ---- context preparation ----
				let context: Context = {
					systemPrompt: this.#systemPrompt,
					messages: this.messages,
					tools: this.#wireTools,
				};
				if (this.#deps.hooks?.transformContext) {
					context = await this.#deps.hooks.transformContext(context);
				}
				if (this.#deps.checkCompaction) {
					// After a refusal for size, the estimate is known to be wrong about
					// this session, so the next turn does not get to consult it.
					const decision = await this.#deps.checkCompaction(context, { force: this.#contextOverflowed });
					if (decision?.action === "blocked") {
						// Nothing was sent. Ending the run here is the whole point: the
						// alternative is a provider 400 with no explanation, repeated on
						// every later turn because the history that caused it is still
						// the history.
						errorMessage = decision.message;
						reason = "error";
						break;
					}
					if (decision?.action === "compact" || decision?.action === "reduced") {
						this.applyCompaction(decision.context);
						context = decision.context;
					}
				}

				// Drain steering queue ahead of the model call.
				while (this.#steering.length > 0) {
					const text = this.#steering.shift();
					if (text === undefined) break;
					const steerMsg = userMessage(await this.#userText(text));
					this.messages.push(steerMsg);
					this.#store?.appendMessage(steerMsg);
				}

				await this.#emit({ type: "turn_start" });

				// ---- stream the assistant turn ----
				const streamOptions: StreamOptions = {
					signal: this.#abortController.signal,
					maxOutputTokens: escalatedOnce ? Math.min(this.#model.maxOutputTokens * 2, MAX_OUTPUT_TOKENS_CAP) : undefined,
					// Read per request, not captured at construction: the host's reader can
					// answer differently after a mid-session change, and the next call is
					// meant to see the new answer.
					thinkingLevel: this.#deps.thinkingLevel?.(),
					// The wrapper awaits this before it sleeps, so the announcement lands
					// ahead of the wait it describes. Subscribers get it as an event like
					// anything else the loop reports; nothing in the loop reacts to it.
					onRetry: (retry) =>
						this.#emit({ type: "retry", attempt: retry.attempt, delayMs: retry.delayMs, message: retry.message }),
				};

				let assistant: AssistantMessage | null = null;
				let lastPartial: AssistantMessage | null = null;
				// Streaming tool execution: concurrency-safe tools start the moment
				// their toolCall block completes, while the model keeps streaming.
				// Fresh per turn: results and settlements from earlier turns are
				// already in the transcript.
				earlyResults = new Map<string, ToolResultMessage>();
				earlyPromises = new Map<string, Promise<void>>();
				earlySettled = new Set<string>();
				const toolSemaphore = new Semaphore(DEFAULT_MAX_CONCURRENCY);
				// A cancel that lands while the stream is in flight must end the turn as
				// aborted. Transports surface a cancel differently: some throw (handled
				// below), others merely stop the stream — the OpenAI SDK ends an aborted
				// SSE response without an error, which would otherwise be recorded as a
				// completed turn and dispatch that turn's tool calls after the user
				// pressed Esc.
				let abortedWhileStreaming = false;
				const onAbort = () => {
					abortedWhileStreaming = true;
				};
				streamOptions.signal?.addEventListener("abort", onAbort, { once: true });
				try {
					for await (const event of this.#deps.streamFn(this.#model, context, streamOptions)) {
						if (event.type === "done" || event.type === "error") {
							assistant = event.message;
						} else {
							lastPartial = event.partial;
							await this.#emit({
								type: "message_update",
								message: event.partial,
								assistantMessageEvent: event,
							});
							if (event.type === "toolcall_end") {
								this.#maybeStartEarlyTool(event.toolCall, earlyResults, earlyPromises, earlySettled, toolSemaphore);
							}
						}
					}
				} catch (streamError) {
					// Retry wrapper converts pre-content failures to error events;
					// mid-stream throws land here. Keep the last partial so any
					// already-streamed toolCall blocks still get paired results.
					if (this.#abortController.signal.aborted) {
						assistant = lastPartial
							? { ...lastPartial, stopReason: "aborted" }
							: interruptedAssistant(this.#model, "aborted");
					} else {
						// A mid-stream throw is this turn's terminal event, not the
						// run's. Sealing the partial as an errored turn — instead of
						// rethrowing — is what keeps the three views of the turn from
						// disagreeing: the text the user has already read stays in the
						// transcript, any early-started tool blocks below stay paired,
						// and the error flows through the same branch that handles a
						// provider-delivered error, overflow classification included.
						const message = streamError instanceof Error ? streamError.message : String(streamError);
						assistant = lastPartial
							? {
									...lastPartial,
									stopReason: "error",
									errorMessage: message,
									...(isContextOverflowError(streamError) ? { errorKind: "context_overflow" as const } : {}),
								}
							: interruptedAssistant(this.#model, "error", message);
					}
				} finally {
					streamOptions.signal?.removeEventListener("abort", onAbort);
				}

				if (assistant && abortedWhileStreaming && assistant.stopReason !== "aborted") {
					assistant = { ...assistant, stopReason: "aborted" };
				}

				if (!assistant) {
					assistant = interruptedAssistant(this.#model, "error", "Provider stream produced no terminal event");
				}

				// ---- length recovery ladder ----
				if (assistant.stopReason === "length") {
					// The retries discard the truncated partial, and any early-started
					// tool of a discarded partial keeps running with nowhere to report:
					// the decision to retry comes one event later than the tool start,
					// the pipeline has no preemptive stop, and cancelling a tool that
					// may already have edited a file is worse than dropping its
					// unreportable result. Exhaustion below is different — there the
					// partial is kept, so its tools get settled with it.
					if (!escalatedOnce && this.#model.maxOutputTokens < MAX_OUTPUT_TOKENS_CAP) {
						// Discard the truncated partial and retry with more room.
						escalatedOnce = true;
						continue;
					}
					if (continueRetries < LENGTH_CONTINUE_RETRIES) {
						continueRetries++;
						const resume = userMessage(LENGTH_RECOVERY_MESSAGE);
						this.messages.push(resume);
						this.#store?.appendMessage(resume);
						continue;
					}
					// Ladder exhausted: the partial is kept, so it takes its tools —
					// real results that finished mid-stream, interrupted settlements
					// for the rest.
					this.messages.push(assistant);
					this.#store?.appendMessage(assistant);
					await this.#settleToolCalls(assistant, earlyPromises, earlyResults, earlySettled);
					errorMessage = "Response repeatedly exceeded the output token limit";
					reason = "error";
					break;
				}

				// A turn the provider finished with nothing in it is not a
				// completed turn: the transcript would gain a message with no
				// answer and the run would report `completed` for a reply that
				// never arrived. Sealed as an error, it flows through the error
				// branch below and the run ends saying what happened.
				if (assistant.stopReason === "stop" && !hasVisibleContent(assistant)) {
					assistant = { ...assistant, stopReason: "error", errorMessage: "The model returned an empty response" };
				}

				// ---- persist the finalized assistant message ----
				this.messages.push(assistant);
				this.#store?.appendMessage(assistant);

				// ---- abnormal termination ----
				if (assistant.stopReason === "aborted") {
					await this.#settleToolCalls(assistant, earlyPromises, earlyResults, earlySettled);
					reason = "aborted";
					break;
				}
				if (assistant.stopReason === "refusal") {
					// The model declined and said so. There is no tool call to run and
					// no partial answer to keep, so the turn would otherwise end here
					// looking exactly like a finished one that produced nothing — and
					// the run would carry on to the next prompt as if nothing had
					// happened. Asking again is not a remedy either: the same
					// conversation tends to get the same answer, so the run ends with
					// the explanation in front of the user.
					await this.#settleToolCalls(assistant, earlyPromises, earlyResults, earlySettled);
					errorMessage = assistant.errorMessage ?? "The model declined this request";
					reason = "error";
					break;
				}
				if (assistant.stopReason === "error") {
					await this.#settleToolCalls(assistant, earlyPromises, earlyResults, earlySettled);
					// The provider is the ground truth on what fits. When it refuses for
					// size, the estimate was wrong — so the next turn compacts without
					// consulting it, and says so if it cannot.
					let overflowNote = "";
					if (assistant.errorKind === "context_overflow") {
						this.#contextOverflowed = true;
						// And the turn that was refused gets to be the next turn. Ending
						// the run here meant the user had to type something before the
						// session would make room — which an unattended `-p` run cannot
						// do at all. The next iteration asks a forced check, which either
						// compacts and sends, or blocks and ends the run with the reason:
						// both are answers, and neither is this prompt being sent again
						// unchanged.
						if (this.#deps.checkCompaction && !this.#overflowRetried) {
							this.#overflowRetried = true;
							continue;
						}
						// Without a compactor there is no retry to take — this same
						// request would be refused again — so the run ends here, and
						// the message names the missing remedy instead of reading like
						// a make-room attempt that failed.
						if (!this.#deps.checkCompaction) {
							overflowNote = " Automatic compaction is not configured for this session.";
						}
					}
					errorMessage = (assistant.errorMessage ?? "Unknown provider error") + overflowNote;
					reason = "error";
					break;
				}

				// ---- tool-call dispatch (THE loop-continue signal) ----
				const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
				if (toolCalls.length === 0) {
					await this.#emit({ type: "turn_end", message: assistant, toolResults: [] });
					turns++;
					const followUpText = this.#followUp.shift();
					if (followUpText !== undefined) {
						const followUpMsg = userMessage(await this.#userText(followUpText));
						this.messages.push(followUpMsg);
						this.#store?.appendMessage(followUpMsg);
						continue;
					}
					break;
				}

				const results = capRoundResults(
					await this.#executeToolCalls(toolCalls, earlyPromises, earlyResults, earlySettled, toolSemaphore),
					this.#deps.spillOutput,
				);
				for (const result of results) {
					this.messages.push(result);
					this.#store?.appendMessage(result);
				}
				await this.#emit({ type: "turn_end", message: assistant, toolResults: results });
				turns++;

				// An abort during tool execution must end the run — otherwise the
				// loop streams another turn as if the interrupt never happened.
				// All dispatched calls are settled (results above include the
				// interrupted settlements), so pairing stays intact.
				if (this.#abortController?.signal.aborted) {
					reason = "aborted";
					break;
				}
			}
		} catch (loopError) {
			reason = "error";
			errorMessage = loopError instanceof Error ? loopError.message : String(loopError);
			// Settle the dying turn's tools — real results first — then pair any
			// dangling tool_use left on the last assistant message.
			const lastAssistant = [...this.messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
			await this.#settleToolCalls(lastAssistant ?? null, earlyPromises, earlyResults, earlySettled);
		} finally {
			this.#running = false;
			this.#abortController = null;
			await this.#emit({ type: "agent_end", reason, messages: this.messages, errorMessage });
		}

		return reason;
	}

	// -- tool execution -------------------------------------------------------

	async #executeToolCalls(
		toolCalls: ToolCall[],
		earlyPromises: Map<string, Promise<void>>,
		earlyResults: Map<string, ToolResultMessage>,
		earlySettled: Set<string>,
		semaphore: Semaphore,
	): Promise<ToolResultMessage[]> {
		const resolved: ResolvedToolCall[] = [];
		const unknownResults: ToolResultMessage[] = [];

		for (const call of toolCalls) {
			if (earlyPromises.has(call.id)) continue; // already executing from the stream
			const tool = this.#tools.find((t) => t.name === call.name);
			if (!tool?.isEnabled?.()) {
				unknownResults.push(toolResultMessage(call.id, call.name, [textContent(`Unknown tool: ${call.name}`)], true));
				continue;
			}
			resolved.push({ callId: call.id, tool, input: parseArguments(call.arguments) });
		}

		const resultsByCallId = new Map<string, ToolResultMessage>();
		for (const r of unknownResults) resultsByCallId.set(r.toolCallId, r);

		const batches = partitionToolCalls(resolved);
		for (const batch of batches) {
			if (this.#abortController?.signal.aborted) {
				// Cancelled while earlier batches ran: the sweep at the bottom
				// settles every remaining call as a paired interrupted result
				// instead of starting new tools.
				continue;
			}
			if (batch.parallel) {
				// Bounded wait: an abort stops the wait after the grace window, and
				// the sweep below settles whatever the window abandoned.
				await this.#awaitTools(
					batch.calls.map((call) => this.#runWithSemaphore(call, resultsByCallId, earlySettled, semaphore)),
				);
			} else {
				// Serial calls wait one at a time; a call the grace window abandoned
				// is settled by the sweep below, and every call after it is settled
				// by the pipeline's own abort gates before its tool can run.
				for (const call of batch.calls) {
					await this.#awaitTools([this.#runOne(call, resultsByCallId, earlySettled)]);
				}
			}
		}

		// Wait for tools that started mid-stream and merge their buffered results.
		await this.#awaitTools([...earlyPromises.values()]);
		for (const [callId, result] of earlyResults) {
			resultsByCallId.set(callId, result);
		}

		// Every call must leave with a paired result: the waits above give up on
		// stragglers (abort plus grace expired), and the assembly below silently
		// drops calls it cannot map — so the missing ones are settled as
		// interrupted here. First settlement wins, which makes this a no-op for
		// everything that already returned.
		for (const call of toolCalls) {
			if (resultsByCallId.has(call.id) || earlySettled.has(call.id)) continue;
			this.#recordToolResult(call.id, interruptedToolResult(call.id, call.name), resultsByCallId, earlySettled);
		}

		// Assemble strictly in assistant source order.
		return toolCalls.map((call) => resultsByCallId.get(call.id)).filter((r) => r !== undefined);
	}

	/**
	 * Acquire a shared permit before running a parallel-batch call, so the
	 * post-stream path draws from the same budget the early-start path already
	 * spent from instead of stacking a second, independent cap on top of it.
	 */
	async #runWithSemaphore(
		call: ResolvedToolCall,
		out: Map<string, ToolResultMessage>,
		settled: Set<string>,
		semaphore: Semaphore,
	): Promise<void> {
		await semaphore.acquire();
		try {
			// The wait above can outlast an abort — settle instead of running.
			// First settlement wins: if the run's sweep already settled this call,
			// this is a no-op.
			if (this.#abortController?.signal.aborted) {
				this.#recordToolResult(call.callId, interruptedToolResult(call.callId, call.tool.name), out, settled);
				return;
			}
			await this.#runOne(call, out, settled);
		} finally {
			semaphore.release();
		}
	}

	/**
	 * Start a concurrency-safe tool while the model is still streaming. Unsafe
	 * tools wait for the normal post-message path so they never overlap. Early
	 * starts draw permits from the same `semaphore` the post-stream batch path
	 * uses (see `#runWithSemaphore`), so the two paths share one combined cap
	 * instead of each enforcing an independent one — once the shared budget is
	 * exhausted, later calls are left for the post-stream path, which blocks on
	 * the same semaphore until a permit frees up.
	 */
	#maybeStartEarlyTool(
		toolCall: ToolCall,
		earlyResults: Map<string, ToolResultMessage>,
		earlyPromises: Map<string, Promise<void>>,
		earlySettled: Set<string>,
		semaphore: Semaphore,
	): void {
		if (this.#abortController?.signal.aborted) return;
		const tool = this.#tools.find((t) => t.name === toolCall.name);
		if (!tool?.isEnabled?.()) return;
		const input = parseArguments(toolCall.arguments);
		if (!tool.isConcurrencySafe?.(input)) return;
		if (!semaphore.tryAcquire()) return; // no shared budget left; post-stream path will run it

		const resolved: ResolvedToolCall = { callId: toolCall.id, tool, input };
		const promise = this.#runOne(resolved, earlyResults, earlySettled)
			.catch(() => {
				// #runOne never throws by contract; belt-and-braces for event handler
				// rejections — orphan synthesis covers any missing result.
			})
			.finally(() => semaphore.release());
		earlyPromises.set(toolCall.id, promise);
	}

	async #runOne(call: ResolvedToolCall, out: Map<string, ToolResultMessage>, settled: Set<string>): Promise<void> {
		const signal = this.#abortController?.signal ?? new AbortController().signal;
		await this.#emit({
			type: "tool_execution_start",
			callId: call.callId,
			toolName: call.tool.name,
			input: call.input,
		});

		const result = await runToolPipeline({
			callId: call.callId,
			tool: call.tool,
			rawInput: call.input,
			deps: this.#deps,
			ctx: { callId: call.callId, signal, cwd: this.cwd, sandbox: this.sandbox, network: this.#network },
			permissionContext: {
				mode: this.#permissionMode,
				sandbox: this.#sandbox,
				toolName: call.tool.name,
				input: call.input,
				cwd: this.cwd,
				signal,
			},
			onUpdate: (partial) => {
				void this.#emit({
					type: "tool_execution_update",
					callId: call.callId,
					toolName: call.tool.name,
					partial,
				});
			},
		});

		// Already settled? The run gave up on this call (abort grace expired) and
		// ended it with an interrupted result. The late arrival must neither
		// overwrite that pairing nor replay its end event after agent_end.
		if (!this.#recordToolResult(call.callId, result, out, settled)) return;
		await this.#emit({
			type: "tool_execution_end",
			callId: call.callId,
			toolName: call.tool.name,
			result,
		});
	}

	/**
	 * Record a tool call's result exactly once. First settlement wins: a tool
	 * that outlived an abort must not overwrite the interrupted result the run
	 * settled it with, and must not replay `tool_execution_end` after
	 * `agent_end` announced the run was over. Returns false when the call was
	 * already settled — nothing was recorded and nothing should be announced.
	 */
	#recordToolResult(
		callId: string,
		result: ToolResultMessage,
		out: Map<string, ToolResultMessage>,
		settled: Set<string>,
	): boolean {
		if (settled.has(callId)) return false;
		settled.add(callId);
		out.set(result.toolCallId, result);
		return true;
	}

	/**
	 * Await in-flight tool promises — but not past an abort plus a grace period.
	 *
	 * Without an abort this is a plain await: a running tool is a running tool.
	 * Once the run is cancelled, the grace timer gives a tool that respects its
	 * signal a window to return a real result, and expires for one that does
	 * not. Returning with work still pending is the caller's cue to settle it
	 * as interrupted; the abandoned promise is muted by the settled set when it
	 * eventually lands.
	 */
	async #awaitTools(promises: Promise<void>[]): Promise<void> {
		if (promises.length === 0) return;
		const signal = this.#abortController?.signal;
		if (!signal) {
			await Promise.all(promises);
			return;
		}
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let fireGrace: (() => void) | null = null;
		const abortedThenGrace = new Promise<void>((resolve) => {
			fireGrace = resolve;
		});
		const startGrace = () => {
			graceTimer = setTimeout(() => fireGrace?.(), this.#deps.abortSettleGraceMs ?? DEFAULT_ABORT_SETTLE_GRACE_MS);
		};
		if (signal.aborted) startGrace();
		else signal.addEventListener("abort", startGrace, { once: true });
		try {
			await Promise.race([Promise.all(promises).then(() => undefined), abortedThenGrace]);
		} finally {
			signal.removeEventListener("abort", startGrace);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
		}
	}

	/**
	 * Bring a dying run's tool state into the transcript, then pair what is left.
	 *
	 * Tools that started mid-stream may have finished without the transcript
	 * hearing about it. Their results are real — the tool ran, its
	 * `tool_execution_end` was announced — so they are recorded as-is (after the
	 * same round cap every result gets) instead of being overwritten by the
	 * interrupted synthesis. What is left gets settled as interrupted, so the
	 * run can end without dangling tool_use blocks on the wire.
	 */
	async #settleToolCalls(
		assistant: AssistantMessage | null,
		earlyPromises: Map<string, Promise<void>>,
		earlyResults: Map<string, ToolResultMessage>,
		earlySettled: Set<string>,
	): Promise<void> {
		await this.#awaitTools([...earlyPromises.values()]);
		if (!assistant) return;
		const real: ToolResultMessage[] = [];
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			const result = earlyResults.get(block.id);
			if (result) {
				real.push(result);
			} else {
				// No result: the tool is still in flight (the grace abandoned it)
				// or never started. The synthesis below owns this block; marking
				// it settled first mutes the straggler if it lands later.
				earlySettled.add(block.id);
			}
		}
		for (const result of capRoundResults(real, this.#deps.spillOutput)) {
			this.messages.push(result);
			this.#store?.appendMessage(result);
		}
		this.#synthesizeOrphanResults(assistant);
	}

	/**
	 * Synthesize isError tool_results for every tool_use block that never got a
	 * paired result — both wire APIs require strict pairing on the next request,
	 * so resuming without this corrupts the conversation.
	 */
	#synthesizeOrphanResults(assistant: AssistantMessage): void {
		const existing = new Set(
			this.messages.filter((m): m is ToolResultMessage => m.role === "toolResult").map((m) => m.toolCallId),
		);
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || existing.has(block.id)) continue;
			const orphan = toolResultMessage(
				block.id,
				block.name,
				[textContent("Tool execution was interrupted before completion.")],
				true,
			);
			this.messages.push(orphan);
			this.#store?.appendMessage(orphan);
		}
	}
}

/**
 * Whether a finalized turn holds anything a transcript can carry: a tool call
 * to answer, a thought, or text that is not only whitespace. An empty content
 * array is invisible by the same measure — there is nothing in it to see.
 */
function hasVisibleContent(message: AssistantMessage): boolean {
	return message.content.some((block) => {
		if (block.type === "toolCall") return true;
		if (block.type === "thinking") return block.thinking.trim().length > 0;
		return block.text.trim().length > 0;
	});
}

/**
 * Paired isError result for a tool call that was cancelled before it could
 * run — same wording as the orphan synthesis below, so interrupted calls read
 * consistently in the transcript regardless of where cancellation landed.
 * Takes the pieces, not the ResolvedToolCall: the call-site sweep that settles
 * abandoned calls may only have a wire ToolCall block to hand.
 */
function interruptedToolResult(callId: string, toolName: string): ToolResultMessage {
	return toolResultMessage(callId, toolName, [textContent("Tool execution was interrupted before completion.")], true);
}

function interruptedAssistant(model: Model, stopReason: "error" | "aborted", message?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason,
		errorMessage: message ?? (stopReason === "aborted" ? "Interrupted by user" : "Unknown error"),
		timestamp: Date.now(),
	};
}

function parseArguments(raw: string): unknown {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		// Let the pipeline's zod validation produce the proper error result.
		return { __malformedArguments: raw };
	}
}
